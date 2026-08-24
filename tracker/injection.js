// Injection: registers the {{relationship_persistent}} macro which renders
// every tracked character's state as <charname_relationship> blocks.
// Also renders the Persist character-state viewer panel.

import { macros as macroSystem } from "../../../../macros/macro-system.js";
import { extension_settings } from "../../../../extensions.js";
import { getAllCharacters, STAT_KEYS, STAT_LABELS, saveState } from "./state.js";

export const extensionName = "Persist";

const MACRO_KEY = "relationship_persistent";

function formatStatLine(key, value) {
    const label = key === "romantic" ? "Romance" : STAT_LABELS[key];
    return `${label}:${value}/100`;
}

// Builds the full injected text for all tracked characters.
export function buildInjectionText() {
    const settings = extension_settings[extensionName] || {};
    const characters = getAllCharacters();
    const blocks = [];

    for (const [charId, ch] of Object.entries(characters)) {
        const statLines = STAT_KEYS.map(k => formatStatLine(k, ch.stats[k]));
        const lines = [];
        lines.push(`<${charId}_relationship>`);
        lines.push(...statLines);
        if (ch.mind) lines.push(`Mind:${ch.mind}`);
        if (ch.relationship) lines.push(`Relationship:${ch.relationship}`);

        const activeStatuses = (ch.statuses || []).filter(s => !s.disabled);
        if (settings.injectStatuses !== false && activeStatuses.length > 0) {
            lines.push("<statuses>");
            for (const s of activeStatuses) {
                const detail = s.effect || s.description || "";
                lines.push(detail ? `${s.name} (${detail})` : s.name);
            }
            lines.push("</statuses>");
        }

        lines.push(`</${charId}_relationship>`);
        blocks.push(lines.join("\n")); 
    }

    return blocks.join("\n");
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

function renderCharacterCard(charId, ch) {
    const statBars = STAT_KEYS.map(key => {
        const value = ch.stats[key] ?? 1;
        return `
            <div class="persist-stat-row">
                <span class="persist-stat-label">${STAT_LABELS[key]}</span>
                <div class="persist-stat-bar"><div class="persist-stat-fill persist-stat-${key}" style="width:${value}%"></div></div>
                <span class="persist-stat-value">${value}</span>
            </div>`;
    }).join("");

    const statusItems = (ch.statuses || []).map((s, index) => `
        <div class="persist-status-item ${s.disabled ? "persist-status-disabled" : ""}">
            <div class="persist-status-header">
                <span class="persist-status-name">${escapeHtml(s.name)}</span>
                <span class="persist-status-type persist-type-${escapeHtml(String(s.type).toLowerCase())}">${escapeHtml(s.type)}</span>
            </div>
            ${s.effect ? `<div class="persist-status-effect">${escapeHtml(s.effect)}</div>` : ""}
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
        </div>`).join("");

    return `
        <div class="persist-character-card" data-char="${escapeHtml(charId)}">
            <div class="persist-character-name">${escapeHtml(ch.name || charId)}</div>
            ${ch.relationship ? `<div class="persist-relationship">Relationship: <b>${escapeHtml(ch.relationship)}</b></div>` : ""}
            ${ch.mind ? `<div class="persist-mind">"${escapeHtml(ch.mind)}"</div>` : ""}
            ${statBars}
            <div class="persist-statuses-header">Statuses</div>
            ${statusItems || '<div class="persist-no-statuses">No statuses.</div>'}
        </div>`;
}

export function refreshPersistPanel() {
    const container = $("#persist_character_panel");
    if (container.length === 0) return;

    const characters = getAllCharacters();
    const entries = Object.entries(characters);

    if (entries.length === 0) {
        container.html('<div class="persist-empty">No tracked characters yet. Talk to a character or run the tracker manually.</div>');
        return;
    }

    container.html(entries.map(([id, ch]) => renderCharacterCard(id, ch)).join(""));
}

export function initPanelHandlers() {
    $("#persist_character_panel").on("click", ".persist-status-toggle", function () {
        const charId = $(this).data("char");
        const index = $(this).data("index");
        const ch = getAllCharacters()[charId];
        const status = ch?.statuses[index];
        if (!status) return;
        if (!status.disabled) {
            const turn = Math.floor(Math.max(0, (window.SillyTavern?.getContext?.()?.chat?.length ?? 1) - 1) / 2);
            status.disabled = true;
            status.disabledSinceTurn = turn;
        } else {
            status.disabled = false;
            status.disabledSinceTurn = null;
        }
        saveState();
        refreshPersistPanel();
    });

    $("#persist_character_panel").on("click", ".persist-status-remove", function () {
        const charId = $(this).data("char");
        const index = $(this).data("index");
        const ch = getAllCharacters()[charId];
        if (!ch) return;
        ch.statuses.splice(index, 1);
        saveState();
        refreshPersistPanel();
    });
}