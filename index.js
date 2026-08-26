// IMPORTS
import { extension_settings, getContext } from "../../../extensions.js";
// Settings
import { loadSettings, saveSettings, defaultSettings, initSettingsListeners } from "./settings/settingsManager.js";
export { loadSettings, saveSettings, defaultSettings };

// Tracker
import { runTracker, resetTrackerGuard, cancelTracker, clearMessageSnapshot, restoreStateUpTo } from "./tracker/tracker.js";
import { registerInjectionMacro, refreshPersistPanel, initPanelHandlers } from "./tracker/injection.js";
// UI
import { pipelineBar } from "./ui/pipelineBar.js";
import { initSidePanel } from "./ui/sidePanel.js";

// Setup
export const extensionName = "Persist";
const extensionFolderPath = `scripts/extensions/third-party/persist-st-relationship-tracker`;
const extensionSettings = extension_settings[extensionName];

// Startup
jQuery(async () => {
    const settingsHtml = await $.get(`${extensionFolderPath}/index.html`);
    const tempDiv = $("<div>").html(settingsHtml);

    // The progress bar lives at <body> level so it can float over the whole app.
    $("body").append(tempDiv.find("#persist_progress_bar"));
    $("#extensions_settings").append(tempDiv.children());

    loadSettings();
    initSettingsListeners();
    registerInjectionMacro();
    initPanelHandlers();
    refreshPersistPanel();
    pipelineBar.init(() => cancelTracker());
    initSidePanel();

    const st = getContext();

    if (st.eventSource && st.event_types) {
        // Shared gating for ALL automatic tracker runs: master switches,
        // ghost/user/system filtering, and the "auto run every X turns"
        // schedule. Turn = message id / 2 (one user+AI exchange); the tracker
        // only fires when the current turn is a multiple of the interval.
        // Without this gate BOTH listeners would race past it: the render
        // event follows MESSAGE_RECEIVED for the same message and would make
        // the tracker run every single turn regardless of the interval.
        const shouldAutoRun = (messageId) => {
            const settings = extension_settings[extensionName];
            if (!settings?.enabled || !settings.autorun) return false;
            const msg = st.chat?.[messageId];
            if (!msg || msg.is_user) return false;
            if (msg.is_system === true || msg.is_system === "true") return false;
            const interval = Math.max(1, parseInt(settings.autoRunInterval, 10) || 1);
            return interval <= 1 || Math.floor(messageId / 2) % interval === 0;
        };

        // Run the tracker after each AI message finishes.
        st.eventSource.on(st.event_types.MESSAGE_RECEIVED, async (messageId) => {
            if (!shouldAutoRun(messageId)) return;
            await runTracker(messageId);
        });

        // Also cover renders triggered by swipes/regenerations.
        st.eventSource.on(st.event_types.CHARACTER_MESSAGE_RENDERED, async (messageId) => {
            if (!shouldAutoRun(messageId)) return;
            await runTracker(messageId);
        });

        // Reload per-chat state and reset guards when the chat changes.
        st.eventSource.on(st.event_types.CHAT_CHANGED, () => {
            resetTrackerGuard();
            refreshPersistPanel();
        });

        // Swipe: roll state back to before this message, drop its stale
        // snapshot, and let the tracker re-run on the new swipe generation.
        st.eventSource.on(st.event_types.MESSAGE_SWIPED, async (messageId) => {
            const id = messageId ?? (st.chat?.length ?? 1) - 1;
            clearMessageSnapshot(id);
            restoreStateUpTo(id - 1);
            resetTrackerGuard();
            refreshPersistPanel();
        });

        // Delete: restore the state of whatever message is now last.
        st.eventSource.on(st.event_types.MESSAGE_DELETED, async () => {
            const lastId = (st.chat?.length ?? 1) - 1;
            restoreStateUpTo(lastId);
            resetTrackerGuard();
            refreshPersistPanel();
        });
    }

    console.log("[Persist] Extension loaded.");
});