import { extension_settings } from "../../../../extensions.js";
import { saveSettingsDebounced } from "../../../../../script.js";
import { extensionName } from "../index.js";

export const defaultSettings = {
    enabled: true, // Master switch for the whole extension
    autorun: true, // Run the tracker automatically after AI messages
    trackerEnabled: true, // Whether the tracker LLM pass runs at all (injection can still work)
    contextDepth: 10, // How many past messages are sent to the tracker FOR CONTEXT ONLY
    injectStatuses: true, // Include the <statuses> section inside {{relationship_persistent}}
    maxStatChangePerTurn: 15, // Hard cap applied in JS to any single stat delta per tracker run
    statusDisableTurns: 3, // A status must be disabled for N turns before <remove_status> is honored
    saturationDecayPerTurn: 2, // Deterministic JS-side Saturation decay per turn
    debug_mode: true,
    legacy_api: false, // Swaps connection profiles via slash command before the request
    trackerProfile: "", // Connection Manager profile id used for the tracker LLM ("" = same as current)
};

export function initSettingsListeners() {
    $("#persist_enabled, #persist_autorun, #persist_tracker_enabled, #persist_inject_statuses, #persist_debug_mode, #persist_legacy_api").on("change", saveSettings);
    $("#persist_context_depth, #persist_max_stat_change, #persist_status_disable_turns, #persist_saturation_decay").on("input change", saveSettings);
    $("#persist_tracker_profile").on("change", saveSettings);

    $("#persist_run_tracker").on("click", async () => {
        const { runTrackerManual } = await import("../tracker/tracker.js");
        runTrackerManual();
    });
}

export function getSettings() {
    return extension_settings[extensionName];
}

export async function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    if (Object.keys(extension_settings[extensionName]).length === 0) {
        Object.assign(extension_settings[extensionName], structuredClone(defaultSettings));
    }

    const s = extension_settings[extensionName];
    $("#persist_enabled").prop("checked", s.enabled);
    $("#persist_autorun").prop("checked", s.autorun);
    $("#persist_tracker_enabled").prop("checked", s.trackerEnabled);
    $("#persist_inject_statuses").prop("checked", s.injectStatuses);
    $("#persist_debug_mode").prop("checked", s.debug_mode);
    $("#persist_legacy_api").prop("checked", s.legacy_api);
    $("#persist_context_depth").val(s.contextDepth ?? 10);
    $("#persist_max_stat_change").val(s.maxStatChangePerTurn ?? 15);
    $("#persist_status_disable_turns").val(s.statusDisableTurns ?? 3);
    $("#persist_saturation_decay").val(s.saturationDecayPerTurn ?? 2);

    populateConnectionDropdown($("#persist_tracker_profile"), s.trackerProfile);
}

export function saveSettings() {
    const s = extension_settings[extensionName];
    if (!s) return;

    s.enabled = $("#persist_enabled").prop("checked");
    s.autorun = $("#persist_autorun").prop("checked");
    s.trackerEnabled = $("#persist_tracker_enabled").prop("checked");
    s.injectStatuses = $("#persist_inject_statuses").prop("checked");
    s.debug_mode = $("#persist_debug_mode").prop("checked");
    s.legacy_api = $("#persist_legacy_api").prop("checked");
    s.contextDepth = parseInt($("#persist_context_depth").val(), 10) || 10;
    s.maxStatChangePerTurn = parseInt($("#persist_max_stat_change").val(), 10) || 15;
    s.statusDisableTurns = parseInt($("#persist_status_disable_turns").val(), 10) || 3;
    s.saturationDecayPerTurn = parseInt($("#persist_saturation_decay").val(), 10) || 0;
    s.trackerProfile = String($("#persist_tracker_profile").val() || "");

    saveSettingsDebounced();
}

// CONNECTION MANAGER STUFF (dropdown population)
export function populateConnectionDropdown(selectElement, currentValue) {
    const ctx = window.SillyTavern?.getContext?.() ?? null;
    selectElement.empty();
    selectElement.append($("<option></option>").val("").text("Same as Current"));

    let profiles = [];
    try {
        const cmActive = !ctx?.extensionSettings?.disabledExtensions?.includes("connection-manager")
            && !!ctx?.extensionSettings?.connectionManager;
        if (cmActive) {
            profiles = ctx.extensionSettings.connectionManager.profiles || [];
        }
    } catch {
        profiles = [];
    }

    for (const p of profiles) {
        selectElement.append($("<option></option>").val(p.id).text(p.name));
    }

    selectElement.val(currentValue || "");
}
