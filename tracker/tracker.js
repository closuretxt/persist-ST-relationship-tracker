// Persist tracker: builds the prompt, runs it through a SillyTavern Connection
// profile via ConnectionManagerRequestService, parses the result, applies it.

import { substituteParams } from "../../../../../script.js";
import { power_user } from "../../../../power-user.js";
import { getWorldInfoPrompt } from "../../../../world-info.js";
import { extension_settings } from "../../../../extensions.js";
import {
    logDebug,
    getST,
    resolveConnectionProfile,
    getProfileNameById,
    parse_reasoning,
    shouldRetryRequest,
    showErrorToast,
} from "../util/connectionProfiles.js";
import { swapProfile } from "../util/profileSwapper.js";
import { getTrackerPrompt, INIT_RULES } from "../settings/defaultPrompt.js";
import { getCurrentTurn, tickState, applyUpdate, createSnapshot, restoreSnapshot, getAllCharacters, enabledStatKeys, STAT_LABELS } from "./state.js";
import { parseTrackerResponse } from "./parser.js";
import { pipelineBar } from "../ui/pipelineBar.js";

export const extensionName = "Persist";

let isRunning = false;
let isCancelled = false;
let lastRunMessageId = -1; // Swipe/re-entry guard

// Called by the pipeline bar's stop button.
export function cancelTracker() {
    isCancelled = true;
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

// Ghost/system messages (hidden narrator notes, injected system text, etc.)
// must never reach the tracker prompt.
function isGhostMessage(m) {
    if (!m) return true;
    if (m.is_system === true || m.is_system === "true") return true;
    if (m.is_hidden === true || m.is_hidden === "true") return true;
    if (!String(m.mes ?? "").trim()) return true;
    return false;
}

// Characters whose name appears in the imminent messages, even if they
// haven't been updated recently. Lets the tracker pick a character back up
// the moment they are named again in the scene.
function getMentionedCharacterIds() {
    const st = getST();
    const interval = getAutoRunInterval();
    const visibleChat = st.chat.filter(m => !isGhostMessage(m));
    const targetCount = Math.min(visibleChat.length, interval * 2);
    const target = visibleChat.slice(-targetCount);
    const text = target.map(m => String(m.mes ?? "")).join("\n").toLowerCase();

    const mentioned = new Set();
    for (const [charId, ch] of Object.entries(getAllCharacters())) {
        const name = String(ch.name || charId).toLowerCase().trim();
        // Ignore very short names to avoid false positives.
        if (name.length >= 3 && text.includes(name)) {
            mentioned.add(charId);
        }
    }
    return mentioned;
}

function buildCurrentStateBlock() {
    const settings = extension_settings[extensionName] || {};
    const characters = getAllCharacters();
    const currentTurn = getCurrentTurn();
    const window = parseInt(settings.characterInjectionWindow, 10) || 0;
    const mentionedIds = getMentionedCharacterIds();

    const entries = Object.entries(characters).filter(([charId, ch]) => {
        if (!window || window <= 0) return true; // 0 = always include everyone
        if (mentionedIds.has(charId)) return true; // name trigger
        const lastSeen = ch.turn ?? 0;
        if (lastSeen <= 0) return true; // never updated: keep until first update
        return (currentTurn - lastSeen) <= window; // activity trigger
    });
    if (entries.length === 0) return "";

    const statKeys = enabledStatKeys();
    const blocks = [];

    for (const [charId, ch] of entries) {
        const lines = [`<character_state name="${charId}"${ch.initialized === false ? ' status="new"' : ""}>`];
        lines.push("Stats:" + statKeys.map(k => `${STAT_LABELS[k]} ${ch.stats?.[k] ?? "?"}/100`).join(", "));
        if (settings.trackMind !== false && ch.mind) lines.push(`Mind:${ch.mind}`);
        if (settings.trackRelationship !== false && ch.relationship) lines.push(`Relationship:${ch.relationship}`);

        const statuses = ch.statuses || [];
        if (statuses.length > 0) {
            lines.push("Existing statuses (you MUST reference these by exact name to edit/disable/remove them):");
            for (const s of statuses) {
                const deltas = Object.entries(s.statEffects || {})
                    .filter(([k]) => statKeys.includes(k))
                    .map(([k, v]) => `[${STAT_LABELS[k] ?? k}${v >= 0 ? "+" : ""}${v}]`)
                    .join("");
                lines.push(`- ${s.name} | ${s.type || "Neutral"}${s.disabled ? " | DISABLED" : ""} | ${s.description || s.effect || ""}${deltas ? ` | ${deltas}` : ""}`);
            }
        } else {
            lines.push("Existing statuses: none.");
        }
        lines.push("</character_state>");
        blocks.push(lines.join("\n"));
    }

    return `<current_state>\n${blocks.join("\n")}\n</current_state>`;
}

// How many turns (user+AI exchanges) the tracker should analyze per run.
function getAutoRunInterval() {
    const settings = extension_settings[extensionName] || {};
    return Math.max(1, parseInt(settings.autoRunInterval, 10) || 1);
}

function buildContextBlock() {
    const st = getST();
    const settings = extension_settings[extensionName] || {};
    const depth = Math.max(0, settings.contextDepth ?? 10);
    const interval = getAutoRunInterval();

    // Only real dialogue is eligible; drop ghosts/system/empty messages first.
    const visibleChat = st.chat.filter(m => !isGhostMessage(m));

    // The action target: the last `interval` turns (a turn = user+AI pair).
    // With interval=1 only the latest exchange is analyzed; with 2, the two.
    const targetCount = Math.min(visibleChat.length, interval * 2);
    const target = visibleChat.slice(-targetCount);
    const history = visibleChat.slice(0, visibleChat.length - targetCount).slice(-depth);

    const historyLines = history.map(m => `${m.name || (m.is_user ? "User" : "Assistant")}: ${m.mes}`).join("\n");

    let block = "";
    if (historyLines.trim()) {
        block += `<conversation_context>\n${historyLines}\n</conversation_context>\n\n`;
    }

    const targetLines = target.map(m => `${m.name || (m.is_user ? "User" : "Assistant")}: ${m.mes}`).join("\n\n");
    const targetLabel = interval === 1 ? "the latest exchange" : `the latest ${interval} exchanges`;

    block += `<exchanges_to_analyze>\nAnalyze ${targetLabel}:\n\n${targetLines || "(no messages)"}\n</exchanges_to_analyze>`;
    return block;
}

// History context as distinct role messages (Send Context as Roles mode).
// Mirrors the Recast pattern: user messages -> "user", character messages ->
// "assistant", system/ghost leftovers -> "system".
function buildContextRoleMessages() {
    const st = getST();
    const settings = extension_settings[extensionName] || {};
    const depth = Math.max(0, settings.contextDepth ?? 10);
    const interval = getAutoRunInterval();

    const visibleChat = st.chat.filter(m => !isGhostMessage(m));
    const targetCount = Math.min(visibleChat.length, interval * 2);
    const history = visibleChat.slice(0, visibleChat.length - targetCount).slice(-depth);

    const roleMessages = [];
    for (const msg of history) {
        const isUser = msg.is_user === true || msg.is_user === "true";
        const isSystem = msg.is_system === true || msg.is_system === "true";
        let role = "assistant";
        if (isUser) role = "user";
        if (isSystem) role = "system";
        roleMessages.push({
            role,
            content: msg.name ? `${msg.name}: ${msg.mes}` : msg.mes,
        });
    }
    return roleMessages;
}

// The imminent exchange(s) block, always sent as the final user message.
function buildTargetBlock() {
    const st = getST();
    const interval = getAutoRunInterval();

    const visibleChat = st.chat.filter(m => !isGhostMessage(m));
    const targetCount = Math.min(visibleChat.length, interval * 2);
    const target = visibleChat.slice(-targetCount);

    const targetLines = target.map(m => `${m.name || (m.is_user ? "User" : "Assistant")}: ${m.mes}`).join("\n\n");
    const targetLabel = interval === 1 ? "the latest exchange" : `the latest ${interval} exchanges`;

    return `<exchanges_to_analyze>\nAnalyze ${targetLabel}:\n\n${targetLines || "(no messages)"}\n</exchanges_to_analyze>`;
}

// Character card info: name, description and personality.
function buildCharacterCardBlock() {
    const st = getST();
    const char = st.characters?.[st.characterId];
    if (!char) return "";
    const lines = [
        char.name ? `Name: ${char.name}` : "",
        char.description ? `Description: ${char.description}` : "",
        char.personality ? `Personality: ${char.personality}` : "",
    ].filter(Boolean);
    if (lines.length === 0) return "";
    return `<character>\n${lines.join("\n")}\n</character>`;
}

// The scenario of the chat, if set.
function buildScenarioBlock() {
    const st = getST();
    const char = st.characters?.[st.characterId];
    const scenario = String(char?.scenario ?? "").trim();
    if (!scenario) return "";
    return `<scenario>\n${scenario}\n</scenario>`;
}

// The {{user}} persona description, if the user has one set.
// Lives in power_user.persona_descriptions[<default persona avatar>].description.
function buildUserPersonaBlock() {
    const st = getST();
    const avatarId = power_user.default_persona || power_user.user_avatar;
    const description = String(power_user?.persona_descriptions?.[avatarId]?.description ?? "").trim();
    if (!description) return "";
    const name = st.name1 || "{{user}}";
    return `<user_persona>\nName: ${name}\n${description}\n</user_persona>`;
}

// Appends World Info (and/or WI outlets) to the user prompt, following the
// Recast pattern: <world_info> block plus auto-appended <outlet> blocks.
async function buildWorldInfoBlock() {
    const settings = extension_settings[extensionName] || {};
    const injectWI = settings.injectWorldInfo === true;
    const injectOutlets = settings.injectWIOutlets === true;
    if ((!injectWI && !injectOutlets) || typeof getWorldInfoPrompt !== "function") {
        return "";
    }

    try {
        const st = getST();
        const chatStrings = st.chat.slice().reverse().map(msg => msg.mes);
        const wiResult = await getWorldInfoPrompt(chatStrings, 100000, true);
        if (typeof wiResult !== "object" || wiResult === null) return "";

        let block = "";

        if (injectWI) {
            const wiBefore = wiResult.worldInfoBefore || "";
            const wiAfter = wiResult.worldInfoAfter || "";
            const wiText = (wiBefore + "\n" + wiAfter).trim();
            if (wiText) {
                block += `<world_info>\n${wiText}\n</world_info>\n\n`;
            }
        }

        if (injectOutlets) {
            const outletEntries = wiResult.outletEntries || {};
            for (const [outletName, contents] of Object.entries(outletEntries)) {
                const outletText = Array.isArray(contents) ? contents.join("\n") : String(contents);
                block += `<outlet name="${outletName}">\n${outletText}\n</outlet>\n\n`;
            }
        }

        return block;
    } catch (e) {
        console.error("[Persist] Error fetching World Info for tracker:", e);
        return "";
    }
}

// One-time initialization rules, appended to the system prompt only while
// there is at least one character that has never been tracked (or the chat
// has no tracked characters at all). Lets the LLM set realistic absolute
// starting values for pre-existing relationships (spouse, friend, enemy...).
function hasUninitializedCharacters() {
    const characters = getAllCharacters();
    const entries = Object.values(characters);
    // Inject when an actual new character (status="new") exists, OR when
    // nothing is tracked yet (first run: every character the LLM reports
    // will be new and needs absolute starting values).
    return entries.length === 0 || entries.some(ch => ch.initialized === false);
}

export async function buildTrackerMessages() {
    const settings = extension_settings[extensionName] || {};
    const wiBlock = await buildWorldInfoBlock();

    // Preamble: everything that is NOT the conversation history. Always sent
    // in the system role: tracker rules -> init rules -> character card ->
    // persona -> world info -> scenario -> tracked state.
    const preamble = substituteParams(
        [
            getTrackerPrompt() + (hasUninitializedCharacters() ? `\n\n${INIT_RULES}` : ""),
            buildCharacterCardBlock(),
            buildUserPersonaBlock(),
            wiBlock?.trimEnd(),
            buildScenarioBlock(),
            buildCurrentStateBlock(),
        ].filter(Boolean).join("\n\n")
    );

    const messages = [{ role: "system", content: preamble }];

    if (settings.sendContextAsRoles === true) {
        // History as separate role messages, then the imminent exchange.
        messages.push(...buildContextRoleMessages());
        messages.push({ role: "user", content: substituteParams(buildTargetBlock()) });
    } else {
        // Everything in one user message: context block + imminent exchange.
        messages.push({ role: "user", content: substituteParams(
            [buildContextBlock(), buildTargetBlock()].filter(Boolean).join("\n\n")
        ) });
    }

    return messages;
}

// ---------------------------------------------------------------------------
// Request execution (Connection profile aware)
// ---------------------------------------------------------------------------

async function requestTracker(messages, connectionProfileId) {
    const st = getST();
    const settings = extension_settings[extensionName];
    const TargetProfileName = getProfileNameById(st, connectionProfileId);
    const OriginalProfileName = st.extensionSettings?.connectionManager?.selectedProfileName
        || getProfileNameById(st, resolveConnectionProfile(st, ""));

    if (!st.ConnectionManagerRequestService?.sendRequest) {
        throw new Error("ConnectionManagerRequestService.sendRequest is unavailable. Is the Connection Manager extension enabled?");
    }

    let swappedProfile = false;

    async function doRequest(profileId) {
        if (settings.legacy_api && TargetProfileName && TargetProfileName !== OriginalProfileName) {
            const swapSuccess = await swapProfile(TargetProfileName, OriginalProfileName);
            if (swapSuccess) swappedProfile = true;
        }
        logDebug(`Tracker request: profile='${profileId || "<same-as-current>"}'`);
        const createGenerator = await st.ConnectionManagerRequestService.sendRequest(
            profileId,
            messages,
            undefined,
            { stream: false }
        );

        if (typeof createGenerator === "function") {
            const generator = createGenerator();
            let streamResult = "";
            for await (const chunk of generator) {
                if (chunk && chunk.text !== undefined) streamResult = chunk.text;
            }
            return streamResult;
        }

        if (createGenerator && typeof createGenerator === "object") {
            return createGenerator.content || createGenerator.text || String(createGenerator);
        }
        return "";
    }

    try {
        return await doRequest(connectionProfileId);
    } catch (firstError) {
        const fallbackProfile = resolveConnectionProfile(st, "");
        if (shouldRetryRequest(firstError) && fallbackProfile !== connectionProfileId) {
            logDebug("Tracker first request failed; retrying with fallback profile.");
            return await doRequest(fallbackProfile);
        }
        throw firstError;
    } finally {
        if (swappedProfile && OriginalProfileName) {
            try {
                await swapProfile(OriginalProfileName, TargetProfileName);
            } catch (e) {
                console.warn("[Persist] Failed to restore original connection profile:", e);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Main entry points
// ---------------------------------------------------------------------------

export async function runTracker(messageId = null) {
    const settings = extension_settings[extensionName];
    if (!settings?.enabled || !settings.trackerEnabled) {
        return { skipped: true, reason: "disabled" };
    }
    if (isRunning) {
        logDebug("Tracker already running; skipping.");
        return { skipped: true, reason: "busy" };
    }

    const st = getST();
    const startId = messageId ?? st.chat.length - 1;
    if (startId <= 0) {
        return { skipped: true, reason: "no_exchange" };
    }

    // Walk backwards from the requested message to find the most recent
    // VALID target: an AI message that is not a ghost/system message.
    // Ghost messages (and user messages) are ignored, not fatal.
    let effectiveMessageId = -1;
    for (let i = startId; i > 0; i--) {
        const msg = st.chat[i];
        if (!msg || msg.is_user) continue;
        if (msg.is_system === true || msg.is_system === "true") continue;
        effectiveMessageId = i;
        break;
    }
    if (effectiveMessageId < 0) {
        return { skipped: true, reason: "not_ai_message" };
    }
    if (effectiveMessageId !== startId) {
        logDebug(`Message ${startId} is not a valid tracker target; falling back to message ${effectiveMessageId}.`);
    }
    if (effectiveMessageId === lastRunMessageId) {
        logDebug(`Message ${effectiveMessageId} already tracked (re-entry guard).`);
        return { skipped: true, reason: "already_tracked" };
    }

    // Skip short messages: nothing meaningful to track yet.
    const minLen = settings.minMessageLength ?? 50;
    const msgLength = String(st.chat[effectiveMessageId]?.mes ?? "").trim().length;
    if (msgLength < minLen) {
        logDebug(`Message ${effectiveMessageId} too short (${msgLength} < ${minLen} chars); skipping.`);
        return { skipped: true, reason: "too_short" };
    }

    isRunning = true;
    lastRunMessageId = effectiveMessageId;
    isCancelled = false;

    pipelineBar.start("Preparing tracker context...");

    try {
        const turn = getCurrentTurn(effectiveMessageId);
        if (isCancelled) return { skipped: true, reason: "cancelled" };

        // Deterministic time-based effects for turns that passed without tracking.
        tickState(turn);

        pipelineBar.setProgress(0.15, "Building tracker prompt...");
        const messages = await buildTrackerMessages();
        const profileId = resolveConnectionProfile(st, settings.trackerProfile || "");
        if (isCancelled) return { skipped: true, reason: "cancelled" };

        pipelineBar.setProgress(0.25, "Tracker LLM is thinking...");
        const raw = await requestTracker(messages, profileId);
        if (isCancelled) return { skipped: true, reason: "cancelled" };

        pipelineBar.setProgress(0.75, "Parsing tracker response...");
        const cleaned = parse_reasoning(raw, profileId);
        logDebug("Tracker raw response:", cleaned);

        const updates = parseTrackerResponse(cleaned);
        if (!updates.length) {
            logDebug("No relationship update blocks found in tracker response.");
            pipelineBar.complete("Nothing to update.");
            return { skipped: true, reason: "no_updates" };
        }

        pipelineBar.setProgress(0.9, `Applying updates for ${updates.length} character(s)...`);
        for (const update of updates) {
            applyUpdate(update, turn);
        }

        const { refreshPersistPanel } = await import("./injection.js");
        refreshPersistPanel();

        pipelineBar.complete();
        saveSnapshotToMessage(effectiveMessageId);
        return { skipped: false, updates };
    } catch (error) {
        console.error("[Persist] Tracker error:", error);
        showErrorToast("Relationship Tracker", error);
        pipelineBar.hide();
        lastRunMessageId = -1; // Allow retry on failure
        return { skipped: true, reason: "error", error };
    } finally {
        isRunning = false;
        isCancelled = false;
    }
}

export function runTrackerManual() {
    const st = getST();
    const settings = extension_settings[extensionName] || {};

    // Context sanity check: the tracker needs at least one full exchange
    // (user + AI message) to analyze.
    const visibleChat = st.chat.filter(m => !isGhostMessage(m));
    const interval = Math.max(1, parseInt(settings.autoRunInterval, 10) || 1);
    const requiredMessages = interval * 2;

    if (visibleChat.length < 2) {
        if (typeof toastr !== "undefined") {
            toastr.warning(
                "Not enough context to run the tracker: there is no complete exchange (a user message and an AI message) in this chat yet.",
                "Persist",
                { timeOut: 8000 }
            );
        }
        logDebug("Manual run aborted: no complete exchange available.");
        return;
    }

    // Warn (but still run) when there is history, yet less than the full
    // auto-run window is available.
    if (visibleChat.length < requiredMessages) {
        if (typeof toastr !== "undefined") {
            toastr.warning(
                `Only ${visibleChat.length} message(s) available but the tracker is set to analyze ${interval} turn(s) (${requiredMessages} messages). Running with what exists.`,
                "Persist",
                { timeOut: 8000 }
            );
        }
    }

    // If the latest message was already tracked (it carries a snapshot),
    // imitate swipe behavior: roll the persistent memory back one turn,
    // drop the stale snapshot and reset the guard so the run isn't a dupe.
    const lastId = st.chat.length - 1;
    const lastMsg = st.chat[lastId];
    if (lastMsg && !lastMsg.is_user && lastMsg.extra?.persist_snapshot) {
        clearMessageSnapshot(lastId);
        restoreStateUpTo(lastId - 1);
        resetTrackerGuard();
        logDebug(`Manual run: rolled back state before message ${lastId}.`);
    }

    if (typeof toastr !== "undefined") {
        toastr.info("Running relationship tracker...", "Persist");
    }
    runTracker().then(result => {
        if (!result.skipped && typeof toastr !== "undefined") {
            toastr.success(`Tracked ${result.updates.length} character(s).`, "Persist");
        }
    });
}

export function resetTrackerGuard() {
    lastRunMessageId = -1;
}

// ---------------------------------------------------------------------------
// Per-message snapshots (swipe / delete recovery)
// ---------------------------------------------------------------------------

// Attach the current Persist state to a message so the chat itself carries
// the full history of relationship states.
export function saveSnapshotToMessage(messageId) {
    const st = getST();
    const msg = st.chat?.[messageId];
    if (!msg) return;
    msg.extra = msg.extra || {};
    msg.extra.persist_snapshot = createSnapshot();
    if (typeof st.saveChat === "function") st.saveChat();
}

// Remove a message's own snapshot (e.g. before re-tracking after a swipe).
export function clearMessageSnapshot(messageId) {
    const st = getST();
    const msg = st.chat?.[messageId];
    if (msg?.extra?.persist_snapshot) {
        delete msg.extra.persist_snapshot;
        if (typeof st.saveChat === "function") st.saveChat();
    }
}

// Restore the state as it was after the most recent snapshot at or before
// messageId. Falls back to a clean state when no snapshot exists.
export function restoreStateUpTo(messageId) {
    const st = getST();
    for (let i = messageId; i >= 0; i--) {
        const snap = st.chat?.[i]?.extra?.persist_snapshot;
        if (snap) {
            restoreSnapshot(snap);
            return true;
        }
    }
    restoreSnapshot(null);
    return false;
}