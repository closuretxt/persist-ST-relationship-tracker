// Persist floating side panel: the tracked-characters drawer as a movable,
// resizable window docked to the right side of the screen. Opened/closed via
// the "Tracked Characters" button in the extension settings; the open state
// persists across reloads.

import { getAllCharacters, adjustStatsForManualChange } from "../tracker/state.js";
import { renderCharacterCard } from "../tracker/injection.js";
import { extension_settings } from "../../../../extensions.js";
import { saveSettingsDebounced } from "../../../../../../script.js";

const PANEL_KEY = "Persist";
const isOpenSaved = () => extension_settings[PANEL_KEY]?.sidePanelOpen === true;
const setIsOpenSaved = (value) => {
    if (!extension_settings[PANEL_KEY]) extension_settings[PANEL_KEY] = {};
    extension_settings[PANEL_KEY].sidePanelOpen = value;
    saveSettingsDebounced();
};

export class PersistSidePanel {
    constructor() {
        this.$panel = null;
        this.isOpen = false;
        this.pos = { width: 380, height: 560, top: null, left: null };
    }

    init() {
        if (this.$panel) return;

        $("body").append(`
            <div id="persist_side_panel" style="display:none;">
                <div id="persist_side_panel_header">
                    <i class="fa-solid fa-users"></i>
                    <span>Tracked Characters</span>
                    <button id="persist_side_panel_close" title="Close"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div id="persist_side_panel_content">
                    <div class="persist-empty">Loading...</div>
                </div>
                <div id="persist_side_panel_resize"></div>
            </div>
        `);

        this.$panel = $("#persist_side_panel");

        $("#persist_side_panel_close").on("click", () => this.close());

        this.initDrag();
        this.initResize();
        this.initHandlers();
        this.refreshContent();

        // Restore last session state: reopen if the user left it open.
        if (isOpenSaved()) {
            this.open();
        }
    }

    toggle() {
        this.isOpen ? this.close() : this.open();
    }

    open() {
        this.init();
        if (this.isOpen) return;
        this.applyPosition();
        this.refreshContent();
        this.$panel.fadeIn(150);
        this.isOpen = true;
        setIsOpenSaved(true);
    }

    close() {
        this.$panel.fadeOut(150);
        this.isOpen = false;
        setIsOpenSaved(false);
    }

    refreshContent(html) {
        const $content = $("#persist_side_panel_content");
        if ($content.length === 0) return;

        if (typeof html === "string") {
            $content.html(html);
            return;
        }

        const entries = Object.entries(getAllCharacters());
        $content.html(entries.length === 0
            ? '<div class="persist-empty">No tracked characters yet.</div>'
            : entries.map(([id, ch]) => renderCharacterCard(id, ch)).join(""));
    }

    applyPosition() {
        const w = this.pos.width;
        const h = this.pos.height;
        let { top, left } = this.pos;

        if (top == null || left == null) {
            // Right-docked, vertically centered (default).
            top = Math.max(8, (window.innerHeight - h) / 2);
            left = window.innerWidth - w - 12;
        }
        this.$panel.css({ width: w, height: h, top, left });
    }

    // --- dragging (header) ---------------------------------------------------

    initDrag() {
        const header = $("#persist_side_panel_header");
        let drag = null;

        header.on("mousedown", (e) => {
            if ($(e.target).closest("#persist_side_panel_close").length) return;
            const rect = this.$panel[0].getBoundingClientRect();
            drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
            e.preventDefault();
        });

        $(document).on("mousemove.persistSidePanel", (e) => {
            if (!drag) return;
            const left = Math.min(Math.max(0, e.clientX - drag.dx), window.innerWidth - 100);
            const top = Math.min(Math.max(0, e.clientY - drag.dy), window.innerHeight - 40);
            this.pos.left = left;
            this.pos.top = top;
            this.$panel.css({ left, top });
        });

        $(document).on("mouseup.persistSidePanel", () => { drag = null; });
    }

    // --- resizing (corner handle) ---------------------------------------------

    initResize() {
        const handle = $("#persist_side_panel_resize");
        let resize = null;

        handle.on("mousedown", (e) => {
            const rect = this.$panel[0].getBoundingClientRect();
            resize = { startX: e.clientX, startY: e.clientY, startW: rect.width, startH: rect.height };
            e.preventDefault();
            e.stopPropagation();
        });

        $(document).on("mousemove.persistSidePanelResize", (e) => {
            if (!resize) return;
            const w = Math.max(280, resize.startW + (e.clientX - resize.startX));
            const h = Math.max(200, resize.startH + (e.clientY - resize.startY));
            this.pos.width = w;
            this.pos.height = h;
            this.$panel.css({ width: w, height: h });
        });

        $(document).on("mouseup.persistSidePanelResize", () => { resize = null; });
    }

    // --- status actions (same behavior as the settings drawer) ---------------

    initHandlers() {
        const $content = $("#persist_side_panel_content");

        $content.on("click", ".persist-status-toggle", function () {
            const charId = String($(this).data("char"));
            const index = Number($(this).data("index"));
            const ch = getAllCharacters()[charId];
            const status = ch?.statuses[index];
            if (!status) return;
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
            refreshSidePanel();
        });

        $content.on("click", ".persist-status-remove", function () {
            const charId = String($(this).data("char"));
            const index = Number($(this).data("index"));
            const ch = getAllCharacters()[charId];
            if (!ch) return;
            adjustStatsForManualChange(ch, () => {
                ch.statuses.splice(index, 1);
            });
            refreshSidePanel();
        });
    }
}

export function refreshSidePanel(html) {
    persistSidePanel.refreshContent(html);
}

export function toggleSidePanel() {
    persistSidePanel.init();
    persistSidePanel.toggle();
}

export function initSidePanel() {
    persistSidePanel.init();
}

export const persistSidePanel = new PersistSidePanel();
