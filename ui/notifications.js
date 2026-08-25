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

    show({ name, title, lines = [], icon = "fa-comment-dots", cls = "", duration = 5000 }) {
        this.init();
        const $card = $(`
            <div class="persist-notification ${cls}">
                <div class="persist-notification-header">
                    <i class="fa-solid ${icon} persist-notification-icon"></i>
                    <span class="persist-notification-name">${escapeHtml(name)}</span>
                    <span class="persist-notification-title">${escapeHtml(title)}</span>
                </div>
                ${lines.length ? `<div class="persist-notification-lines">${lines.map(l =>
                    `<div class="persist-notification-line ${l.cls || ""}"><i class="fa-solid ${l.icon || "fa-circle"}"></i><span>${escapeHtml(l.text)}</span></div>`
                ).join("")}</div>` : ""}
            </div>
        `);

        this.container.append($card);
        while (this.container.children().length > 6) {
            this.container.children().first().remove();
        }
        $card.hide().fadeIn(200);

        setTimeout(() => {
            $card.fadeOut(300, () => $card.remove());
        }, duration);
    }
}

/**
 * event: {
 *   name, stats: {key: delta}, newStatuses: [names], editedStatuses: [names],
 *   disabledStatuses: [names], removedStatuses: [names],
 *   mindChanged: bool, relationshipChanged: bool
 * }
 */
pushTrackerEvent(event); {
    const level = this.getLevel();
    if (level === "none") return;

    if (level === "reduced") {
        this.show({
            name: event.name,
            title: reducedLine(event),
            icon: reducedIcon(event),
            cls: reducedCls(event),
            duration: 4000,
        });
        return;
    }

    // "all": full breakdown card.
    const lines = [];
    for (const [key, delta] of Object.entries(event.stats || {})) {
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
        title: "Relationship updated",
        lines,
        icon: "fa-comments-heart",
        cls: "full",
        duration: 6000,
    });
}

// ---- "Reduced" flavor lines -------------------------------------------------

function dominantStat(event) {
    let bestKey = null;
    let bestVal = 0;
    for (const [key, delta] of Object.entries(event.stats || {})) {
        if (Math.abs(delta) > Math.abs(bestVal)) {
            bestVal = delta;
            bestKey = key;
        }
    }
    return { key: bestKey, delta: bestVal };
}

function reducedLine(event) {
    const hasStatus = (event.newStatuses || []).length > 0;
    const { key, delta } = dominantStat(event);

    if (hasStatus && !key) return "will remember that.";
    if (hasStatus && Math.abs(delta) < 3) return `gained "${event.newStatuses[0]}".`;

    switch (key) {
        case "romantic":  return delta > 0 ? "liked that." : "felt a distance grow.";
        case "friendship":return delta > 0 ? "enjoyed that." : "felt let down.";
        case "hate":      return delta > 0 ? "really didn't like that." : "cooled off a little.";
        case "saturation":return delta > 0 ? "needs some space." : "feels refreshed.";
        case "pursuit":   return delta > 0 ? "wants more." : "is backing off.";
        default:          return "hardly reacted.";
    }
}

function reducedIcon(event) {
    const { key } = dominantStat(event);
    if ((event.newStatuses || []).length) return "fa-star";
    switch (key) {
        case "romantic": return "fa-heart";
        case "friendship": return "fa-face-smile";
        case "hate": return "fa-heart-crack";
        case "saturation": return "fa-battery-half";
        case "pursuit": return "fa-bolt";
        default: return "fa-comment-dots";
    }
}

function reducedCls(event) {
    const { key, delta } = dominantStat(event);
    if ((event.newStatuses || []).length && Math.abs(delta) < 3) return "status-new";
    if (delta === 0) return "";
    if (key === "hate") return delta > 0 ? "down" : "up";
    return delta > 0 ? "up" : "down";
}

export const persistNotifications = new PersistNotifications();

function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
