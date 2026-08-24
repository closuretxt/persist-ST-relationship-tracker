// Persist tracker: builds the prompt, runs it through a SillyTavern Connection
// profile via ConnectionManagerRequestService, parses the result, applies it.

import { substituteParams } from "../../../../../script.js";
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
import { getTrackerPrompt } from "../settings/defaultPrompt.js";
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

function buildCurrentStateBlock() {
    const settings = extension_settings[extensionName] || {};
    const characters = getAllCharacters();
    const entries = Object.entries(characters);
    if (entries.length === 0) return "";

    const statKeys = enabledStatKeys();
    const blocks = [];

    for (const [charId, ch] of entries) {
        const lines = [`<character_state name="${charId}">`];
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

function buildContextBlock() {
    const st = getST();
    const settings = extension_settings[extensionName] || {};
    const depth = Math.max(0, settings.contextDepth ?? 10);

    // Only real dialogue is eligible; drop ghosts/system/empty messages first.
    const visibleChat = st.chat.filter(m => !isGhostMessage(m));

    // History FOR CONTEXT ONLY: everything before the latest visible exchange.
    const historyEnd = visibleChat.length - 1;
    const historyStart = Math.max(0, historyEnd - depth);
    const history = visibleChat.slice(historyStart, historyEnd);

    const lines = history.map(m => `${m.name || (m.is_user ? "User" : "Assistant")}: ${m.mes}`).join("\n");

    const lastUser = [...visibleChat].reverse().find(m => m.is_user);
    const lastAssistant = [...visibleChat].reverse().find(m => !m.is_user);

    let block = "";
    if (lines.trim()) {
        block += `<conversation_context>\n${lines}\n</conversation_context>\n\n`;
    }

    const userText = lastUser ? `${lastUser.name || "User"}: ${lastUser.mes}` : "(no user message)";
    const assistantText = lastAssistant ? `${lastAssistant.name || "Character"}: ${lastAssistant.mes}` : "(no assistant message)";

    block += `<latest_exchange>\n${userText}\n\n${assistantText}\n</latest_exchange>`;
    return block;
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

export async function buildTrackerMessages() {
    const settings = extension_settings[extensionName] || {};
    const systemPrompt = substituteParams(getTrackerPrompt());
    const wiBlock = await buildWorldInfoBlock();
    const stateBlock = buildCurrentStateBlock();
    const userPrompt = substituteParams(
        [stateBlock, buildContextBlock(), wiBlock?.trimEnd()].filter(Boolean).join("\n\n")
    );
    return [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
    ];
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