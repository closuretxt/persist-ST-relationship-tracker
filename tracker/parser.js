// Tolerant regex-based parser for tracker LLM output.

import { getAllCharacters } from "./state.js";

// Matches <Anything_relationship_update> ... </Same>
const UPDATE_BLOCK_RE = /<([A-Za-z0-9_]+)_relationship_update>([\s\S]*?)<\/\s*\1_relationship_update>/g;
const NEW_STATUS_RE = /<new_status>([\s\S]*?)<\/\s*new_status>/gi;
const EDIT_STATUS_RE = /<edit_status>([\s\S]*?)<\/\s*edit_status>/gi;
const DISABLE_STATUS_RE = /<disable_status>([\s\S]*?)<\/\s*disable_status>/gi;
const REMOVE_STATUS_RE = /<remove_status>([\s\S]*?)<\/\s*remove_status>/gi;

// Parses "Key: Value" lines inside a status/update body.
function parseFields(body) {
    const fields = {};
    const lines = String(body || "").split(/\r?\n/);
    for (const line of lines) {
        const m = line.match(/^\s*([A-Za-z ]+?)\s*:\s*(.*)$/);
        if (!m) continue;
        const key = m[1].trim();
        const value = m[2].trim();
        if (key && !(key in fields && fields[key])) {
            fields[key] = value;
        }
    }
    return fields;
}

// Strips bracketed stat-delta tokens like [Friendship+2] or [Saturation -1]
// from free-text fields; deltas belong only in the "Stats:" field.
const DELTA_TOKEN_RE = /\s*\[[A-Za-z ]+\s*[+\-]\s*\d+\]\s*/g;

function cleanTextField(value) {
    return String(value || "").replace(DELTA_TOKEN_RE, " ").replace(/\s{2,}/g, " ").trim();
}

function extractStatusBodies(text, regex) {
    const results = [];
    let m;
    regex.lastIndex = 0;
    while ((m = regex.exec(text)) !== null) {
        const fields = parseFields(m[1]);
        if (fields.Description) fields.Description = cleanTextField(fields.Description);
        if (fields.Effect) fields.Effect = cleanTextField(fields.Effect);
        results.push({ fields, raw: m[1].trim() });
    }
    return results;
}

// Parses "Label 75, Friendship 80" into { Romantic: 75, Friendship: 80 }.
// Used by the one-time InitStats line for newly tracked characters.
function parseInitStats(value) {
    const result = {};
    for (const part of String(value || "").split(/[,;]/)) {
        const m = part.trim().match(/^([A-Za-z ]+?)\s*[:=]?\s*(\d{1,3})$/);
        if (m) result[m[1].trim()] = parseInt(m[2], 10);
    }
    return Object.keys(result).length ? result : null;
}

function resolveCharId(tagName) {
    let id = tagName;
    if (/^charname$/i.test(id)) {
        // The model used the literal template tag; fall back to the main character's name.
        try {
            const ctxName = window.SillyTavern?.getContext?.()?.name2 || "charname";
            id = ctxName;
        } catch {
            id = "charname";
        }
    }
    // Keep the ID stable across turns: reuse an existing entry that differs only by case.
    const characters = getAllCharacters();
    const lower = String(id).toLowerCase();
    const existingKey = Object.keys(characters).find(k => k.toLowerCase() === lower);
    return existingKey || id;
}

// Returns an array of parsed update objects:
// { charId, displayName, mind, relationship, newStatuses, editStatuses, disableStatuses, removeStatuses }
export function parseTrackerResponse(responseText, promptText = "") {
    const updates = [];
    let match;
    UPDATE_BLOCK_RE.lastIndex = 0;

    while ((match = UPDATE_BLOCK_RE.exec(String(responseText || ""))) !== null) {
        const tagName = match[1];
        const body = match[2];

        // Compute Mind/Relationship from lines OUTSIDE the status blocks so
        // inner "Name:"/"Effect:" lines don't pollute them.
        const outerBody = body
            .replace(NEW_STATUS_RE, "")
            .replace(EDIT_STATUS_RE, "")
            .replace(DISABLE_STATUS_RE, "")
            .replace(REMOVE_STATUS_RE, "");
        const outerFields = parseFields(outerBody);

        const charId = resolveCharId(tagName);

        updates.push({
            charId,
            displayName: charId,
            mind: outerFields.Mind || "",
            relationship: outerFields.Relationship || "",
            initStats: outerFields.InitStats ? parseInitStats(outerFields.InitStats) : null,
            newStatuses: extractStatusBodies(body, NEW_STATUS_RE),
            editStatuses: extractStatusBodies(body, EDIT_STATUS_RE),
            disableStatuses: extractStatusBodies(body, DISABLE_STATUS_RE),
            removeStatuses: extractStatusBodies(body, REMOVE_STATUS_RE),
        });
    }

    return updates;
}