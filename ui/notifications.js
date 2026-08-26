// Persist toast notifications, styled after the PipelineBar aesthetic.
// A small stack of cards pinned to the BOTTOM LEFT corner of the screen,
// summarizing what the tracker just changed per character.
//
// Levels (settings.notificationLevel):
//   "all"     -> every stat delta, plus new/edited/disabled/removed statuses
//   "reduced" -> one short flavor line per character ("Aria liked that.")
//   "none"    -> no popups at all

import { extension_settings } from "../../../../extensions.js";
import { extensionName } from "../index.js";

const STAT_META = {
    romantic: { label: "Romantic", icon: "fa-heart", cls: "romantic" },
    friendship: { label: "Friendship", icon: "fa-user-group", cls: "friendship" },
    hate: { label: "Hate", icon: "fa-heart-crack", cls: "hate" },
    saturation: { label: "Saturation", icon: "fa-battery-three-quarters", cls: "saturation" },
    pursuit: { label: "Pursuit", icon: "fa-bolt", cls: "pursuit" },
};

export class PersistNotifications {
    constructor() {
        this.container = null;
    }

    init() {
        if (!this.container) {
            this.container = $('<div id="persist_notifications"></div>');
            $("body").append(this.container);
        }
    }

    getLevel() {
        return extension_settings[extensionName]?.notificationLevel || "reduced";
    }

    show({ name, title, detail = "", lines = [], icon = "fa-comment-dots", cls = "", duration = 7000 }) {
        this.init();
        const $card = $(`
            <div class="persist-notification ${cls}">
                <div class="persist-notification-header">
                    <i class="fa-solid ${icon} persist-notification-icon"></i>
                    <span class="persist-notification-name">${escapeHtml(name)}</span>
                    <span class="persist-notification-title">${escapeHtml(title)}</span>
                </div>
                ${detail ? `<div class="persist-notification-detail">${escapeHtml(detail)}</div>` : ""}
                ${lines.length ? `<div class="persist-notification-lines">${lines.map(l =>
                    `<div class="persist-notification-line ${l.cls || ""}"><i class="fa-solid ${l.icon || "fa-circle"}"></i><span>${escapeHtml(l.text)}</span></div>`
                ).join("")}</div>` : ""}
            </div>
        `);

        this.container.append($card);
        while (this.container.children().length > 6) {
            this.container.children().first().remove();
        }

        // Entrance is handled by the CSS animation; exit via a transition class.
        setTimeout(() => {
            $card.addClass("out");
            setTimeout(() => $card.remove(), 400);
        }, duration);
    }

    // Stats noisy enough (or mechanical enough) to never be notified on their own.
    static NOTIFY_EXCLUDED_STATS = new Set(["saturation", "pursuit"]);

    notifyStats(event) {
        return Object.entries(event.stats || {}).filter(([key]) => !PersistNotifications.NOTIFY_EXCLUDED_STATS.has(key));
    }

    /**
     * event: {
     *   name, stats: {key: delta}, newStatuses: [names], editedStatuses: [names],
     *   disabledStatuses: [names], removedStatuses: [names],
     *   mindChanged: bool, relationshipChanged: bool
     * }
     */
    pushTrackerEvent(event) {
        const level = this.getLevel();
        if (level === "none") return;

        if (level === "reduced") {
            // Skip pure saturation/pursuit churn: only notify when something
            // meaningful (romantic/friendship/hate or a status) happened.
            const meaningful = this.notifyStats(event).some(([, delta]) => delta !== 0)
                || (event.newStatuses || []).length > 0;
            if (!meaningful) return;

            this.show({
                name: event.name,
                title: reducedLine(event, { skipStatusPart: true }),
                lines: (event.newStatuses || []).map(s => ({ text: s, icon: "fa-tag", cls: "status-new" })),
                icon: reducedIcon(event),
                cls: reducedCls(event),
                duration: 9000,
            });
            return;
        }

        // "all": full breakdown card.
        const lines = [];
        for (const [key, delta] of this.notifyStats(event)) {
            if (!delta) continue;
            const meta = STAT_META[key] || { label: key, icon: "fa-circle", cls: "neutral" };
            const sign = delta > 0 ? "+" : "";
            lines.push({ text: `${sign}${delta} ${meta.label}`, icon: meta.icon, cls: delta > 0 ? `up ${meta.cls}` : `down ${meta.cls}` });
        }
        for (const s of event.newStatuses || []) lines.push({ text: `New status: ${s}`, icon: "fa-plus", cls: "status-new" });
        for (const s of event.editedStatuses || []) lines.push({ text: `Edited status: ${s}`, icon: "fa-pen", cls: "status-edit" });
        for (const s of event.disabledStatuses || []) lines.push({ text: `Status faded: ${s}`, icon: "fa-moon", cls: "status-disabled" });
        for (const s of event.removedStatuses || []) lines.push({ text: `Status removed: ${s}`, icon: "fa-trash-can", cls: "status-removed" });
        if (event.mindChanged) lines.push({ text: "Mind updated", icon: "fa-brain", cls: "mind" });
        if (event.relationshipChanged) lines.push({ text: "Relationship updated", icon: "fa-link", cls: "mind" });

        if (!lines.length) return; // nothing notable happened

        this.show({
            name: event.name,
            title: "",
            lines,
            icon: "fa-comments-heart",
            cls: "full",
            duration: 10000,
        });
    }
}

// ---- "Reduced" flavor lines -------------------------------------------------

function dominantStat(event) {
    let bestKey = null;
    let bestVal = 0;
    for (const [key, delta] of Object.entries(event.stats || {})) {
        if (key === "saturation" || key === "pursuit") continue; // never drive the flavor line
        if (Math.abs(delta) > Math.abs(bestVal)) {
            bestVal = delta;
            bestKey = key;
        }
    }
    return { key: bestKey, delta: bestVal };
}

function reducedLine(event, { skipStatusPart = false } = {}) {
    const { key, delta } = dominantStat(event);

    let line;
    switch (key) {
        case "romantic":   line = delta > 0 ? "liked that." : "felt a distance grow."; break;
        case "friendship": line = delta > 0 ? "enjoyed that." : "felt let down."; break;
        case "hate":       line = delta > 0 ? "really didn't like that." : "cooled off a little."; break;
        default:
            line = delta === 0 && (event.newStatuses || []).length
                ? "revealed a new side of themselves."
                : "will remember that.";
    }

    if (skipStatusPart) return line || "will remember that.";

    // New statuses are mentioned by name in Reduced mode.
    const statusPart = (event.newStatuses || []).length
        ? ` gained "${event.newStatuses.join('", "')}"` 
        : "";

    return `${line}${statusPart}`.trim() || "will remember that.";
}

function reducedIcon(event) {
    const { key, delta } = dominantStat(event);
    switch (key) {
        case "romantic": return delta > 0 ? "fa-heart" : "fa-heart-crack";
        case "friendship": return "fa-user-group";
        case "hate": return "fa-heart-crack";
        default: return "fa-comment-dots";
    }
}

function reducedCls(event) {
    const { key, delta } = dominantStat(event);
    if (delta === 0 && !(event.newStatuses || []).length) return "";
    if (key === "hate") return delta > 0 ? "down" : "up";
    return delta >= 0 ? "up" : "down";
}

export const persistNotifications = new PersistNotifications();

function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
