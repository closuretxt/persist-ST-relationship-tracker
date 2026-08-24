// Persist tracker: builds the prompt, runs it through a SillyTavern Connection
// profile via ConnectionManagerRequestService, parses the result, applies it.

import { substituteParams } from "../../../../../script.js";
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
import { getCurrentTurn, tickState, applyUpdate } from "./state.js";
import { parseTrackerResponse } from "./parser.js";

export const extensionName = "Persist";

let isRunning = false;
let lastRunMessageId = -1; // Swipe/re-entry guard

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

export function buildTrackerMessages() {
    const systemPrompt = substituteParams(getTrackerPrompt());
    const userPrompt = substituteParams(buildContextBlock());
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
    const effectiveMessageId = messageId ?? st.chat.length - 1;
    if (effectiveMessageId <= 0) {
        return { skipped: true, reason: "no_exchange" };
    }
    if (effectiveMessageId === lastRunMessageId) {
        logDebug(`Message ${effectiveMessageId} already tracked (re-entry guard).`);
        return { skipped: true, reason: "already_tracked" };
    }
    const lastMsg = st.chat[effectiveMessageId];
    if (!lastMsg || lastMsg.is_user) {
        return { skipped: true, reason: "not_ai_message" };
    }
    if (lastMsg.is_system === true || lastMsg.is_system === "true") {
        return { skipped: true, reason: "ghost_message" };
    }

    isRunning = true;
    lastRunMessageId = effectiveMessageId;

    try {
        const turn = getCurrentTurn(effectiveMessageId);

        // Deterministic time-based effects for turns that passed without tracking.
        tickState(turn);

        const messages = buildTrackerMessages();
        const profileId = resolveConnectionProfile(st, settings.trackerProfile || "");
        const raw = await requestTracker(messages, profileId);
        const cleaned = parse_reasoning(raw, profileId);
        logDebug("Tracker raw response:", cleaned);

        const updates = parseTrackerResponse(cleaned);
        if (!updates.length) {
            logDebug("No relationship update blocks found in tracker response.");
            return { skipped: true, reason: "no_updates" };
        }

        for (const update of updates) {
            applyUpdate(update, turn);
        }

        const { refreshPersistPanel } = await import("./injection.js");
        refreshPersistPanel();

        return { skipped: false, updates };
    } catch (error) {
        console.error("[Persist] Tracker error:", error);
        showErrorToast("Relationship Tracker", error);
        lastRunMessageId = -1; // Allow retry on failure
        return { skipped: true, reason: "error", error };
    } finally {
        isRunning = false;
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