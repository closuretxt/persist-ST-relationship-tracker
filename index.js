// IMPORTS
import { extension_settings, getContext } from "../../../extensions.js";
// Settings
import { loadSettings, saveSettings, defaultSettings, initSettingsListeners } from "./settings/settingsManager.js";
export { loadSettings, saveSettings, defaultSettings };

// Tracker
import { runTracker, resetTrackerGuard, cancelTracker } from "./tracker/tracker.js";
import { registerInjectionMacro, refreshPersistPanel, initPanelHandlers } from "./tracker/injection.js";
// UI
import { pipelineBar } from "./ui/pipelineBar.js";

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

    const st = getContext();

    if (st.eventSource && st.event_types) {
        // Run the tracker after each AI message finishes.
        st.eventSource.on(st.event_types.MESSAGE_RECEIVED, async (messageId) => {
            if (!extension_settings[extensionName]?.enabled) return;
            if (!extension_settings[extensionName]?.autorun) return;
            const msg = st.chat?.[messageId];
            if (!msg || msg.is_user) return;
            // Ghost/system messages are not tracked.
            if (msg.is_system === true || msg.is_system === "true") return;
            await runTracker(messageId);
        });

        // Also cover renders triggered by swipes/regenerations.
        st.eventSource.on(st.event_types.CHARACTER_MESSAGE_RENDERED, async (messageId) => {
            if (!extension_settings[extensionName]?.enabled) return;
            if (!extension_settings[extensionName]?.autorun) return;
            await runTracker(messageId);
        });

        // Reload per-chat state and reset guards when the chat changes.
        st.eventSource.on(st.event_types.CHAT_CHANGED, () => {
            resetTrackerGuard();
            refreshPersistPanel();
        });
    }

    console.log("[Persist] Extension loaded.");
});