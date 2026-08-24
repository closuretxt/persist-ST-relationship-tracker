import { extension_settings } from "../../../../extensions.js";
import { saveSettingsDebounced } from "../../../../../script.js";
import { extensionName } from "../index.js";
import { STAT_DEFINITIONS, trackFlagFor } from "./statDefinitions.js";

export const defaultSettings = {
    enabled: true, // Master switch for the whole extension
    autorun: true, // Run the tracker automatically after AI messages
    trackerEnabled: true, // Whether the tracker LLM pass runs at all (injection can still work)
    contextDepth: 10, // How many past messages are sent to the tracker FOR CONTEXT ONLY
    injectStatuses: true, // Legacy: kept for migration; superseded by statusInjectFormat
    statusInjectFormat: "full", // "full" = name+desc+effect; "simple" = name+effect; "name" = name only; "none" = no statuses injected
    injectionMode: "prompt", // "prompt" = wrapped in <user_relationships> with explanation; "raw" = bare list only
    maxStatChangePerTurn: 15, // Hard cap applied in JS to any single stat delta per tracker run
    statusDisableTurns: 3, // A status must be disabled for N turns before <remove_status> is honored
    saturationDecayPerTurn: 2, // Deterministic JS-side Saturation decay per turn
    debug_mode: false,
    legacy_api: false, // Swaps connection profiles via slash command before the request
    trackerProfile: "", // Connection Manager profile id used for the tracker LLM ("" = same as current)
    injectWorldInfo: false, // Append the <world_info> block to the tracker context
    injectWIOutlets: false, // Append WI outlet entries as separate <outlet> blocks
    // Tracking options: turning one off removes it completely from the tracker
    // prompt, parsing, state applier, injected macro and the panel UI.
    // One flag per defined stat (generated) plus Mind/Relationship.
    ...Object.fromEntries(STAT_DEFINITIONS.map(def => [trackFlagFor(def.key), true])),
    trackMind: false,
    trackRelationship: true,
};

// All trackable options (stats + non-stat fields), for dynamic UI and saving.
const TRACK_OPTIONS = [
    ...STAT_DEFINITIONS.map(def => ({
        id: `persist_track_${def.key}`,
        flag: trackFlagFor(def.key),
        label: def.label,
        title: `Track the ${def.label} stat`,
    })),
    { id: "persist_track_mind", flag: "trackMind", label: "Mind Line", title: "Track the Mind line (what the character thinks of the relationship)" },
    { id: "persist_track_relationship", flag: "trackRelationship", label: "Relationship", title: "Track the Relationship name label" },
];

export function initSettingsListeners() {
    $("#persist_enabled, #persist_autorun, #persist_tracker_enabled, #persist_debug_mode, #persist_legacy_api, #persist_inject_world_info, #persist_inject_wi_outlets").on("change", saveSettings);
    $("#persist_injection_mode, #persist_status_inject_format").on("change", saveSettings);
    // Tracking toggles are rendered dynamically; use delegation so any stat
    // added to statDefinitions.js works without touching this file.
    $("#persist_tracker_options").on("change", "input[type='checkbox']", saveSettings);
    $("#persist_context_depth, #persist_max_stat_change, #persist_status_disable_turns, #persist_saturation_decay").on("input change", saveSettings);
    $("#persist_tracker_profile").on("change", saveSettings);

    $("#persist_run_tracker").on("click", async () => {
        const { runTrackerManual } = await import("../tracker/tracker.js");
        runTrackerManual();
    });

    $("#persist_reset_chat").on("click", async () => {
        if (!window.confirm("Reset ALL tracked relationship data for this chat?\n\nEvery character's stats, mind, relationship and statuses will be deleted. This cannot be undone.")) return;
        const state = await import("../tracker/state.js");
        state.resetChatState();
        const { refreshPersistPanel } = await import("../tracker/injection.js");
        refreshPersistPanel();
        if (typeof toastr !== "undefined") {
            toastr.success("Chat tracking data reset.", "Persist");
        }
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
    $("#persist_status_inject_format").val(["full", "simple", "name", "none"].includes(s.statusInjectFormat) ? s.statusInjectFormat
        : (s.injectStatuses === false ? "none" : "full")); // migrate legacy checkbox
    $("#persist_injection_mode").val(s.injectionMode === "raw" ? "raw" : "prompt");
    $("#persist_debug_mode").prop("checked", s.debug_mode);
    $("#persist_legacy_api").prop("checked", s.legacy_api);
    $("#persist_inject_world_info").prop("checked", s.injectWorldInfo === true);
    $("#persist_inject_wi_outlets").prop("checked", s.injectWIOutlets === true);
    $("#persist_context_depth").val(s.contextDepth ?? 10);
    $("#persist_max_stat_change").val(s.maxStatChangePerTurn ?? 15);
    $("#persist_status_disable_turns").val(s.statusDisableTurns ?? 3);
    $("#persist_saturation_decay").val(s.saturationDecayPerTurn ?? 2);

    populateConnectionDropdown($("#persist_tracker_profile"), s.trackerProfile);

    // Render the tracking toggles from the current stat definitions.
    const $options = $("#persist_tracker_options");
    $options.empty();
    for (const opt of TRACK_OPTIONS) {
        $options.append(
            $("<label></label>").attr("title", opt.title).append(
                $("<input type='checkbox'>").attr("id", opt.id).prop("checked", s[opt.flag] !== false),
                $("<span></span>").text(opt.label),
            )
        );
    }
}

export function saveSettings() {
    const s = extension_settings[extensionName];
    if (!s) return;

    s.enabled = $("#persist_enabled").prop("checked");
    s.autorun = $("#persist_autorun").prop("checked");
    s.trackerEnabled = $("#persist_tracker_enabled").prop("checked");
    s.injectStatuses = $("#persist_status_inject_format").val() !== "none"; // legacy mirror
    s.statusInjectFormat = ["full", "simple", "name", "none"].includes($("#persist_status_inject_format").val())
        ? $("#persist_status_inject_format").val() : "full";
    s.injectionMode = $("#persist_injection_mode").val() === "raw" ? "raw" : "prompt";
    s.debug_mode = $("#persist_debug_mode").prop("checked");
    s.legacy_api = $("#persist_legacy_api").prop("checked");
    s.injectWorldInfo = $("#persist_inject_world_info").prop("checked");
    s.injectWIOutlets = $("#persist_inject_wi_outlets").prop("checked");
    s.contextDepth = parseInt($("#persist_context_depth").val(), 10) || 10;
    s.maxStatChangePerTurn = parseInt($("#persist_max_stat_change").val(), 10) || 15;
    s.statusDisableTurns = parseInt($("#persist_status_disable_turns").val(), 10) || 3;
    s.saturationDecayPerTurn = parseInt($("#persist_saturation_decay").val(), 10) || 0;
    s.trackerProfile = String($("#persist_tracker_profile").val() || "");
    for (const opt of TRACK_OPTIONS) {
        s[opt.flag] = $(`#${opt.id}`).prop("checked");
    }

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
