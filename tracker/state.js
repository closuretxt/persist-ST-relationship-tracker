// Per-chat persistent state store + deterministic applier.
// State lives in chat_metadata.persist so it is saved/restored with the chat itself.

import { getContext, extension_settings } from "../../../../extensions.js";
import { STAT_DEFINITIONS, STAT_KEYS, STAT_LABELS, trackFlagFor } from "../settings/statDefinitions.js";

export { STAT_KEYS, STAT_LABELS };

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
    migrateCharacters(st.chatMetadata[STATE_KEY].characters);
    return st.chatMetadata[STATE_KEY];
}

// Fill in any stat keys a character is missing (e.g. characters created
// before a new stat was added to statDefinitions.js). Without this, old
// characters would produce NaN as soon as the new stat is touched.
function migrateCharacters(characters) {
    const defaults = defaultStats();
    for (const ch of Object.values(characters)) {
        if (!ch || typeof ch !== "object") continue;
        ch.stats = ch.stats || {};
        for (const key of STAT_KEYS) {
            if (!Number.isFinite(ch.stats[key])) {
                ch.stats[key] = defaults[key];
            }
        }
    }
}

// Stat keys currently enabled by the "Tracker" settings drawer. Disabled
// options are ignored everywhere: parsing, applier, injection and UI.
export function enabledStatKeys() {
    const s = getExtensionSettings();
    return STAT_KEYS.filter(key => s[trackFlagFor(key)] !== false);
}

function defaultStats() {
    return Object.fromEntries(STAT_DEFINITIONS.map(s => [s.key, s.defaultValue]));
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
        // Ignore deltas for stats that are not being tracked.
        if (!enabledStatKeys().includes(key)) continue;
        const value = parseInt(m[2].replace(/\s+/g, ""), 10);
        if (Number.isFinite(value)) {
            deltas[key] = (deltas[key] || 0) + value;
        }
    }
    return deltas;
}

// ---------------------------------------------------------------------------
// Snapshots (for swipe / message-delete recovery)
// ---------------------------------------------------------------------------

// Deep copy of the current state root, stored on the tracked message itself.
export function createSnapshot() {
    const root = getStateRoot();
    return {
        version: 1,
        lastProcessedTurn: root?.lastProcessedTurn ?? -1,
        characters: structuredClone(root?.characters ?? {}),
    };
}

// Replace the live state with a snapshot (or reset to empty when null).
export function restoreSnapshot(snapshot) {
    const st = getContext();
    if (!st?.chatMetadata) return false;
    const snap = snapshot && snapshot.characters
        ? { version: 1, lastProcessedTurn: snapshot.lastProcessedTurn ?? -1, characters: structuredClone(snapshot.characters) }
        : { version: 1, lastProcessedTurn: -1, characters: {} };
    st.chatMetadata[STATE_KEY] = snap;
    saveState();
    return true;
}

// ---------------------------------------------------------------------------
// Applier
// ---------------------------------------------------------------------------

function capDelta(delta, settings) {
    const cap = Math.abs(settings.maxStatChangePerTurn ?? 15);
    return clamp(delta, -cap, cap);
}

// Normalized name for fuzzy matching: lowercase, alphanumeric only.
function normalizeName(name) {
    return String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Token-overlap similarity between two normalized names (0..1).
function nameSimilarity(a, b) {
    const tokensA = new Set((a.match(/[a-z0-9]+/g) || []));
    const tokensB = new Set((b.match(/[a-z0-9]+/g) || []));
    if (tokensA.size === 0 || tokensB.size === 0) return 0;
    let overlap = 0;
    for (const t of tokensA) if (tokensB.has(t)) overlap++;
    return overlap / Math.min(tokensA.size, tokensB.size);
}

// Finds an existing status that is the same or a near-duplicate of the given
// name. Exact normalized match, containment, or >=60% token overlap.
function findSimilarStatus(ch, name) {
    const target = normalizeName(name);
    if (!target) return null;
    for (const s of ch.statuses) {
        const existing = normalizeName(s.name);
        if (!existing) continue;
        if (existing === target) return s;
        if (existing.length >= 6 && (existing.includes(target) || target.includes(existing))) return s;
        if (nameSimilarity(existing, target) >= 0.6) return s;
    }
    return null;
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
    // Disabled tracking options are never written.
    if (update.mind && settings.trackMind !== false) ch.mind = update.mind;
    if (update.relationship && settings.trackRelationship !== false) ch.relationship = update.relationship;

    // 1) Status lifecycle first.
    for (const op of update.newStatuses || []) {
        // Duplicate guard: if a status with the same or a near-identical name
        // already exists, treat the <new_status> as an EDIT of that status
        // instead of piling up near-copies.
        const similar = findSimilarStatus(ch, op.fields.Name);
        if (similar) {
            applyStatusFields(similar, { ...op.fields, Name: similar.name });
            continue;
        }
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

    // 2) Deterministic stat changes ONLY from statuses (never bare LLM deltas),
    // applied to enabled stats only. Statuses are persistent passives: their
    // deltas are applied ONCE (on creation) and afterwards only the DIFFERENCE
    // when the status is edited - never the full sum every turn.
    const deltas = computePendingDeltas(ch);
    const enabledKeys = enabledStatKeys();
    for (const key of enabledKeys) {
        ch.stats[key] = clamp(ch.stats[key] + deltas[key], 1, 100);
    }

    saveState();
}

// Single source of truth for how a character's statuses translate into stat
// deltas this turn. Used both by applyUpdate() and by the UI's "Net effect"
// row so the displayed sum always matches what is actually applied.
function emptyDeltas() {
    return Object.fromEntries(STAT_KEYS.map(k => [k, 0]));
}

export function computeDeltas(ch) {
    const settings = getExtensionSettings();
    const deltas = emptyDeltas();

    // Disabled statuses keep affecting future trackers at half weight,
    // but never the injected context (handled by injection.js).
    const enabled = new Set(enabledStatKeys());
    for (const status of ch.statuses) {
        const weight = status.disabled ? 0.5 : 1;
        for (const [key, value] of Object.entries(status.statEffects || {})) {
            if (!enabled.has(key)) continue; // untracked stat
            deltas[key] += value * weight;
        }
    }

    for (const key of STAT_KEYS) {
        deltas[key] = Math.round(capDelta(deltas[key], settings));
    }

    applySaturationRules(deltas, ch, settings);
    return deltas;
}

// The deltas that applyUpdate() should actually apply THIS turn: only the
// not-yet-applied portion of each active status (new statuses apply fully;
// edits apply just the change; disabled statuses apply nothing). Per-turn
// deterministic Saturation coupling/decay is added on top.
function computePendingDeltas(ch) {
    const settings = getExtensionSettings();
    const deltas = emptyDeltas();
    const enabled = new Set(enabledStatKeys());

    for (const status of ch.statuses) {
        if (status.disabled) {
            status.appliedEffects = {}; // nothing applied while disabled
            continue;
        }
        const applied = status.appliedEffects || {};
        for (const key of enabled) {
            const declared = status.statEffects?.[key] || 0;
            const diff = declared - (applied[key] || 0);
            if (diff) deltas[key] += diff;
        }
        // Mark the declared effects as applied so they don't repeat next turn.
        status.appliedEffects = { ...status.statEffects };
    }

    for (const key of STAT_KEYS) {
        deltas[key] = Math.round(capDelta(deltas[key], settings));
    }

    applySaturationRules(deltas, ch, settings);
    return deltas;
}

// Deterministic per-turn Saturation rules, shared by computeDeltas() (UI net
// effect) and computePendingDeltas() (actual application).
function applySaturationRules(deltas, ch, settings) {
    if (settings.trackSaturation !== false) {
        // Saturation rises when other stats rise (cooldown meter fills).
        const positiveOthers = ["romantic", "friendship", "hate"]
            .reduce((sum, k) => sum + Math.max(0, deltas[k]), 0);
        deltas.saturation += Math.ceil(positiveOthers / 2);

        // Saturation decays over time and faster with high Pursuit.
        const pursuitBonus = settings.trackPursuit === false ? 0 : Math.floor(ch.stats.pursuit / 25);
        const decay = (settings.saturationDecayPerTurn ?? 2) + pursuitBonus;
        deltas.saturation -= decay;
    } else {
        // Saturation disabled: never change it.
        deltas.saturation = 0;
    }
}

// Status-only portion of the deltas (no Saturation coupling/decay), used when
// the user manually toggles/removes statuses so bars update instantly without
// double-applying time effects.
function statusOnlyDeltas(ch) {
    const settings = getExtensionSettings();
    const deltas = emptyDeltas();
    const enabled = new Set(enabledStatKeys());
    for (const status of ch.statuses) {
        const weight = status.disabled ? 0.5 : 1;
        for (const [key, value] of Object.entries(status.statEffects || {})) {
            if (!enabled.has(key)) continue; // untracked stat
            deltas[key] += value * weight;
        }
    }
    for (const key of STAT_KEYS) {
        deltas[key] = Math.round(capDelta(deltas[key], settings));
    }
    return deltas;
}

// Runs a manual status mutation (toggle/remove) and immediately re-applies the
// difference to the stored stats so the bars update without waiting for the
// next tracker run.
export function adjustStatsForManualChange(ch, mutateFn) {
    if (!ch) return;
    const before = statusOnlyDeltas(ch);
    mutateFn();
    const after = statusOnlyDeltas(ch);
    for (const key of STAT_KEYS) {
        ch.stats[key] = clamp(ch.stats[key] + (after[key] - before[key]), 1, 100);
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
        const saturationTracked = settings.trackSaturation !== false;
        for (const ch of Object.values(root.characters)) {
            if (!saturationTracked) continue;
            const pursuitBonus = settings.trackPursuit === false ? 0 : Math.floor(ch.stats.pursuit / 25);
            const decay = ((settings.saturationDecayPerTurn ?? 2) * elapsed) + pursuitBonus;
            ch.stats.saturation = clamp(ch.stats.saturation - decay, 1, 100);
        }
        saveState();
    }
    return true;
}