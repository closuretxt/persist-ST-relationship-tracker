// Injection: registers the {{relationship_persistent}} macro which renders
// every tracked character's state as <charname_relationship> blocks.
// Also renders the Persist character-state viewer panel.

import { macros as macroSystem } from "../../../../macros/macro-system.js";
import { extension_settings } from "../../../../extensions.js";
import { getAllCharacters, STAT_LABELS, saveState, computeDeltas, adjustStatsForManualChange, enabledStatKeys, getCurrentTurn } from "./state.js";
import { getInjectionPrompt } from "../settings/defaultInjection.js";

export const extensionName = "Persist";

const MACRO_KEY = "relationship_persistent";

function formatStatLine(key, value) {
    const label = key === "romantic" ? "Romance" : STAT_LABELS[key];
    return `${label}:${value}/100`;
}

// Builds the full injected text for all tracked characters.
// Characters are injected while they are "relevant": active within the last
// `characterInjectionWindow` turns. 0 = always inject everyone.
function isCharacterRelevant(ch, currentTurn, window) {
    if (!window || window <= 0) return true; // 0 = inject everyone
    const lastSeen = ch.turn ?? 0;
    if (lastSeen <= 0) return true; // never updated: keep until first update
    return (currentTurn - lastSeen) <= window;
}

export function buildInjectionText() {
    const settings = extension_settings[extensionName] || {};
    const characters = getAllCharacters();
    const currentTurn = getCurrentTurn();
    const window = parseInt(settings.characterInjectionWindow, 10) || 0;
    const blocks = [];

    for (const [charId, ch] of Object.entries(characters)) {
        // Characters still awaiting their one-time initialization only carry
        // placeholder default stats - never leak them into story prompts.
        if (ch.initialized === false) continue;
        if (!isCharacterRelevant(ch, currentTurn, window)) continue;
        const statLines = enabledStatKeys().map(k => formatStatLine(k, ch.stats[k]));
        const lines = [];
        lines.push(`<${charId}_relationship>`);
        lines.push(...statLines);
        if (settings.trackMind !== false && ch.mind) lines.push(`Mind:${ch.mind}`);
        if (settings.trackRelationship !== false && ch.relationship) lines.push(`Relationship:${ch.relationship}`);

        const activeStatuses = (ch.statuses || []).filter(s => !s.disabled);
        const format = ["full", "simple", "name", "none"].includes(settings.statusInjectFormat)
            ? settings.statusInjectFormat
            : (settings.injectStatuses === false ? "none" : "full"); // migrate legacy checkbox
        if (format !== "none" && activeStatuses.length > 0) {
            lines.push("<statuses>");
            for (const s of activeStatuses) {
                if (format === "name") {
                    lines.push(s.name);
                    continue;
                }
                const parts = [];
                if (format === "full" && s.description) parts.push(s.description.replace(/\.$/, ""));
                if ((format === "full" || format === "simple") && s.effect) parts.push(s.effect.replace(/\.$/, ""));
                lines.push(parts.length > 0 ? `${s.name} (${parts.join("; ")})` : s.name);
            }
            lines.push("</statuses>");
        }

        lines.push(`</${charId}_relationship>`);
        blocks.push(lines.join("\n"));
    }

    const body = blocks.join("\n");

    // "prompt" wraps the blocks in <user_relationships> with the default
    // explanation; "raw" injects only the bare character blocks.
    if (settings.injectionMode === "raw") {
        return body;
    }
    return getInjectionPrompt(body);
}

export function registerInjectionMacro() {
    try {
        macroSystem.registry.registerMacro(MACRO_KEY, {
            category: macroSystem.category?.MISC ?? "misc",
            description: "Persistent per-character relationship stats, mind, relationship name and statuses tracked by Persist.",
            handler: () => buildInjectionText(),
        });
    } catch (e) {
        // Already registered (e.g. hot reload); re-register to refresh the handler.
        try {
            macroSystem.registry.unregisterMacro(MACRO_KEY);
            macroSystem.registry.registerMacro(MACRO_KEY, {
                category: macroSystem.category?.MISC ?? "misc",
                description: "Persistent per-character relationship data tracked by Persist.",
                handler: () => buildInjectionText(),
            });
        } catch (e2) {
            console.warn("[Persist] Failed to register {{relationship_persistent}} macro.", e2);
        }
    }
}

export function unregisterInjectionMacro() {
    try {
        macroSystem.registry.unregisterMacro(MACRO_KEY);
    } catch {
        // Not registered; fine.
    }
}

// ---------------------------------------------------------------------------
// Character state viewer panel
// ---------------------------------------------------------------------------

function escapeHtml(text) {
    return String(text ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}

// Formats one status's raw stat deltas as "+N / -N" chip labels.
// Weight is applied for display purposes only (disabled statuses count half).
function formatStatChips(statEffects, weight = 1) {
    const chips = [];
    for (const key of enabledStatKeys()) {
        const value = statEffects?.[key];
        if (!value) continue;
        const weighted = Math.round(value * weight);
        if (weighted === 0) continue;
        const sign = weighted > 0 ? "+" : "";
        chips.push(`<span class="persist-chip persist-chip-${weighted > 0 ? "up" : "down"}">${STAT_LABELS[key]} ${sign}${weighted}</span>`);
    }
    return chips.join("");
}

// Builds the character's net stat modifier exactly the way the applier does
// (via computeDeltas), so the displayed sum always matches reality.
// With no statuses this is ZERO for every stat except the deterministic
// Saturation decay, which is time-based rather than status-based.
function computeNetEffect(ch) {
    return computeDeltas(ch);
}

function renderNetEffect(net) {
    const chips = formatStatChips(net, 1);
    if (!chips) {
        return '<div class="persist-net"><span class="persist-net-label">Modifiers</span><span class="persist-chip persist-chip-zero">ZERO</span></div>';
    }
    return `<div class="persist-net"><span class="persist-net-label">Modifiers</span>${chips}</div>`;
}

export function renderCharacterCard(charId, ch) {
    const settings = extension_settings[extensionName] || {};
    const awaitingInit = ch.initialized === false;
    const statBars = enabledStatKeys().map(key => {
        const value = ch.stats[key] ?? 1;
        return `
            <div class="persist-stat-row">
                <span class="persist-stat-label">${STAT_LABELS[key]}</span>
                <div class="persist-stat-bar"><div class="persist-stat-fill persist-stat-${key}" style="width:${value}%"></div></div>
                <span class="persist-stat-value">${value}</span>
            </div>`;
    }).join("");

    const statusItems = (ch.statuses || []).map((s, index) => {
        const weight = s.disabled ? 0.5 : 1;
        const statChips = formatStatChips(s.statEffects, weight);
        const settledChips = formatStatChips(s.settledEffects, 1);
        const settledFlag = settledChips ? " · ½ settled" : "";
        return `
        <div class="persist-status-item ${s.disabled ? "persist-status-disabled" : ""}${settledChips ? " persist-status-settled" : ""}">
            <div class="persist-status-header">
                <span class="persist-status-name">${escapeHtml(s.name)}</span>
                <span class="persist-status-type persist-type-${escapeHtml(String(s.type).toLowerCase())}">${escapeHtml(s.type)}${s.disabled ? " · disabled" : ""}${settledFlag}</span>
            </div>
            ${s.description ? `<div class="persist-status-description">${escapeHtml(s.description)}</div>` : ""}
            ${s.effect ? `<div class="persist-status-effect">${escapeHtml(s.effect)}</div>` : ""}
            ${statChips
                ? `<div class="persist-status-stats">${statChips}${s.disabled ? '<span class="persist-chip-hint">×½ (disabled)</span>' : ""}</div>`
                : '<div class="persist-status-stats"><span class="persist-chip persist-chip-zero">No stat effects</span></div>'}
            ${settledChips ? `<div class="persist-status-stats persist-settled-row">${settledChips}<span class="persist-chip-hint">baked permanently</span></div>` : ""}
            <div class="persist-status-actions">
                <button class="menu_button menu_button_icon persist-status-toggle" data-char="${escapeHtml(charId)}" data-index="${index}"
                    title="${s.disabled ? "Re-enable this status" : "Disable this status"}">
                    <i class="fa-solid ${s.disabled ? "fa-toggle-off" : "fa-toggle-on"}"></i>
                </button>
                <button class="menu_button menu_button_icon persist-status-remove" data-char="${escapeHtml(charId)}" data-index="${index}"
                    title="Remove this status permanently">
                    <i class="fa-solid fa-trash-can"></i>
                </button>
            </div>
        </div>`;
    }).join("");

    return `
        <div class="persist-character-card ${awaitingInit ? "persist-awaiting-init" : ""}" data-char="${escapeHtml(charId)}">
            <div class="persist-character-header">
                <span class="persist-character-name">${escapeHtml(ch.name || charId)}</span>
                ${awaitingInit ? `<span class="persist-init-badge" title="Detected but not initialized yet: these values are placeholders. The next tracker run sets realistic absolute starting values."><i class="fa-solid fa-hourglass-half"></i> Awaiting Init</span>` : ""}
                ${settings.trackRelationship !== false && ch.relationship ? `<span class="persist-relationship-tag">${escapeHtml(ch.relationship)}</span>` : ""}
            </div>
            ${settings.trackMind !== false && ch.mind ? `<div class="persist-mind">"${escapeHtml(ch.mind)}"</div>` : ""}
            <div class="persist-stat-bars">${statBars}</div>
            ${renderNetEffect(computeNetEffect(ch))}
            <div class="persist-statuses-header">Statuses</div>
            ${statusItems || '<div class="persist-no-statuses">No statuses.</div>'}
        </div>`;
}

export function refreshPersistPanel() {
    const container = $("#persist_character_panel");
    const characters = getAllCharacters();
    const entries = Object.entries(characters);
    const emptyHtml = '<div class="persist-empty">No tracked characters yet. Talk to a character or run the tracker manually.</div>';
    const html = entries.length === 0
        ? emptyHtml
        : entries.map(([id, ch]) => renderCharacterCard(id, ch)).join("");

    if (container.length > 0) {
        container.html(html);
    }

    // Keep the floating side panel in sync (dynamic import avoids a cycle).
    import("../ui/sidePanel.js").then(({ refreshSidePanel }) => refreshSidePanel(html)).catch(() => {});
}

export function initPanelHandlers() {
    $("#persist_character_panel").on("click", ".persist-status-toggle", function () {
        const charId = $(this).data("char");
        const index = $(this).data("index");
        const ch = getAllCharacters()[charId];
        const status = ch?.statuses[index];
        if (!status) return;
        // Re-apply the stat difference immediately so the bars update now.
        adjustStatsForManualChange(ch, () => {
            if (!status.disabled) {
                const turn = Math.floor(Math.max(0, (window.SillyTavern?.getContext?.()?.chat?.length ?? 1) - 1) / 2);
                status.disabled = true;
                status.disabledSinceTurn = turn;
            } else {
                status.disabled = false;
                status.disabledSinceTurn = null;
            }
        });
        refreshPersistPanel();
    });

    $("#persist_character_panel").on("click", ".persist-status-remove", function () {
        const charId = $(this).data("char");
        const index = $(this).data("index");
        const ch = getAllCharacters()[charId];
        if (!ch) return;
        adjustStatsForManualChange(ch, () => {
            ch.statuses.splice(index, 1);
        });
        refreshPersistPanel();
    });
}