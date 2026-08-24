// Per-chat persistent state store + deterministic applier.
// State lives in chat_metadata.persist so it is saved/restored with the chat itself.

import { getContext, extension_settings } from "../../../extensions.js";

export const STAT_KEYS = ["romantic", "friendship", "hate", "saturation", "pursuit"];
export const STAT_LABELS = {
    romantic: "Romantic",
    friendship: "Friendship",
    hate: "Hate",
    saturation: "Saturation",
    pursuit: "Pursuit",
};

const STATE_KEY = "persist";

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

export function getExtensionSettings() {
    return extension_settings["Persist"] || {};
}

export function getStateRoot() {
    const st = getContext();
    if (!st?.chatMetadata) return null;
    if (!st.chatMetadata[STATE_KEY]) {
        st.chatMetadata[STATE_KEY] = { characters: {}, lastProcessedTurn: -1 };
    }
    if (!st.chatMetadata[STATE_KEY].characters) {
        st.chatMetadata[STATE_KEY].characters = {};
    }
    return st.chatMetadata[STATE_KEY];
}

function defaultStats() {
    return { romantic: 10, friendship: 10, hate: 1, saturation: 0, pursuit: 20 };
}

export function getOrCreateCharacter(charId, displayName = null) {
    const root = getStateRoot();
    if (!root) return null;

    // Case-insensitive ID match so "Livia" and "livia" resolve to the same entry.
    const lower = String(charId).toLowerCase();
    const existingKey = Object.keys(root.characters).find(k => k.toLowerCase() === lower);
    const key = existingKey || charId;

    let ch = root.characters[key];
    if (!ch) {
        ch = {
            name: displayName || charId,
            stats: defaultStats(),
            mind: "",
            relationship: "",
            statuses: [],
            turn: 0,
        };
        root.characters[key] = ch;
    }
    if (displayName && (!ch.name || ch.name === key)) {
        ch.name = displayName;
    }
    return ch;
}

export function getAllCharacters() {
    const root = getStateRoot();
    return root ? root.characters : {};
}

export function saveState() {
    const st = getContext();
    if (typeof st?.saveMetadataDebounced === "function") {
        st.saveMetadataDebounced();
    } else if (typeof st?.saveChat === "function") {
        st.saveChat();
    }
}

// Current turn number. Message ID divided by 2, per spec.
export function getCurrentTurn(messageId = null) {
    const st = getContext();
    const id = messageId ?? (st?.chat ? st.chat.length - 1 : 0);
    return Math.floor(Math.max(0, id) / 2);
}

// "[Friendship+5][Hate-2]" -> { friendship: 5, hate: -2 }
export function parseStatDeltas(statsString) {
    const deltas = {};
    const re = /\[\s*([A-Za-z]+)\s*([+\-]?\s*\d+)\s*\]/g;
    let m;
    while ((m = re.exec(String(statsString || ""))) !== null) {
        const key = String(m[1]).trim().toLowerCase();
        if (!STAT_KEYS.includes(key)) continue;
        const value = parseInt(m[2].replace(/\s+/g, ""), 10);
        if (Number.isFinite(value)) {
            deltas[key] = (deltas[key] || 0) + value;
        }
    }
    return deltas;
}

// ---------------------------------------------------------------------------
// Applier
// ---------------------------------------------------------------------------

function capDelta(delta, settings) {
    const cap = Math.abs(settings.maxStatChangePerTurn ?? 15);
    return clamp(delta, -cap, cap);
}

function findStatus(ch, name) {
    const target = String(name || "").trim().toLowerCase();
    return ch.statuses.find(s => s.name.trim().toLowerCase() === target) || null;
}

function applyStatusFields(status, fields) {
    if (fields.Name) status.name = fields.Name;
    if (fields.Type) status.type = fields.Type;
    if (fields.Description) status.description = fields.Description;
    if (fields.Effect) status.effect = fields.Effect;
    if (fields["Removed Only If"]) status.removedOnlyIf = fields["Removed Only If"];
    if (fields.Date) status.date = fields.Date;
    if (fields.Stats) status.statEffects = parseStatDeltas(fields.Stats);
}

// Applies one parsed <charname_relationship_update> block to the store.
export function applyUpdate(update, turn) {
    const settings = getExtensionSettings();
    const ch = getOrCreateCharacter(update.charId, update.displayName);
    if (!ch) return;

    ch.turn = turn;
    if (update.mind) ch.mind = update.mind;
    if (update.relationship) ch.relationship = update.relationship;

    // 1) Status lifecycle first.
    for (const op of update.newStatuses || []) {
        const existing = findStatus(ch, op.fields.Name);
        if (!existing) {
            ch.statuses.push({
                name: op.fields.Name || `Unnamed ${ch.statuses.length}`,
                type: op.fields.Type || "Neutral",
                description: op.fields.Description || "",
                effect: op.fields.Effect || "",
                removedOnlyIf: op.fields["Removed Only If"] || "",
                statEffects: parseStatDeltas(op.fields.Stats),
                date: op.fields.Date || `Turn ${turn}`,
                createdTurn: turn,
                disabled: false,
                disabledSinceTurn: null,
            });
        }
    }

    for (const op of update.editStatuses || []) {
        const existing = findStatus(ch, op.fields?.Name);
        if (existing) applyStatusFields(existing, op.fields);
    }

    for (const op of update.disableStatuses || []) {
        const existing = findStatus(ch, op.fields?.Name);
        if (existing && !existing.disabled) {
            existing.disabled = true;
            existing.disabledSinceTurn = turn;
        }
    }

    for (const op of update.removeStatuses || []) {
        const existing = findStatus(ch, op.fields?.Name);
        const requiredDisabledTurns = Math.max(0, settings.statusDisableTurns ?? 3);
        const eligible = existing
            && existing.disabled
            && ((turn - (existing.disabledSinceTurn ?? turn)) >= requiredDisabledTurns);
        if (eligible) {
            ch.statuses = ch.statuses.filter(s => s !== existing);
        } else if (existing && !existing.disabled) {
            // Removal not allowed yet; at least make sure it is disabled.
            existing.disabled = true;
            existing.disabledSinceTurn = turn;
        }
    }

    // 2) Deterministic stat changes ONLY from statuses (never bare LLM deltas).
    const deltas = { romantic: 0, friendship: 0, hate: 0, saturation: 0, pursuit: 0 };

    // Disabled statuses keep affecting future trackers at half weight,
    // but never the injected context (handled by injection.js).
    for (const status of ch.statuses) {
        const weight = status.disabled ? 0.5 : 1;
        for (const [key, value] of Object.entries(status.statEffects || {})) {
            deltas[key] += value * weight;
        }
    }

    for (const key of STAT_KEYS) {
        deltas[key] = Math.round(capDelta(deltas[key], settings));
    }

    // Saturation rises when other stats rise (cooldown meter fills).
    const positiveOthers = ["romantic", "friendship", "hate"]
        .reduce((sum, k) => sum + Math.max(0, deltas[k]), 0);
    deltas.saturation += Math.ceil(positiveOthers / 2);

    // Saturation decays over time and faster with high Pursuit.
    const decay = (settings.saturationDecayPerTurn ?? 2) + Math.floor(ch.stats.pursuit / 25);
    deltas.saturation -= decay;

    for (const key of STAT_KEYS) {
        ch.stats[key] = clamp(ch.stats[key] + deltas[key], 1, 100);
    }

    saveState();
}

// Advance time-based effects without any LLM output (called on every turn).
export function tickState(turn) {
    const root = getStateRoot();
    if (!root || root.lastProcessedTurn === turn) return false;
    const previousTurn = root.lastProcessedTurn;
    root.lastProcessedTurn = turn;

    const settings = getExtensionSettings();
    const elapsed = previousTurn < 0 ? 0 : Math.max(1, turn - previousTurn);

    if (elapsed > 0) {
        for (const ch of Object.values(root.characters)) {
            const decay = ((settings.saturationDecayPerTurn ?? 2) * elapsed)
                + Math.floor(ch.stats.pursuit / 25);
            ch.stats.saturation = clamp(ch.stats.saturation - decay, 1, 100);
        }
        saveState();
    }
    return true;
}