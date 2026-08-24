// Persist tracker pipeline bar, adapted from the Recast reference.
// The tracker is a single LLM pass, so progress is phase-based instead of
// pass-based: context build -> LLM response -> applying updates.

export class PipelineBar {
    constructor() {
        this.progressBar = null;
        this.progressText = null;
        this.progressFill = null;
        this.formShield = null;
        this.isActive = false;
    }

    init(stopCallback) {
        this.progressBar = $("#persist_progress_bar");
        this.progressText = $("#persist_progress_text");
        this.progressFill = $("#persist_progress_fill");
        this.formShield = $("#form_sheld");

        this.progressBar.find("#persist_stop_tracker").on("click", () => {
            this.hide();
            if (stopCallback) stopCallback();
        });
    }

    start(initialText = "Starting tracker...") {
        this.isActive = true;

        this.progressBar.fadeIn(200);
        this.progressText.text(initialText);
        this.progressFill.css("width", "5%");
        this.formShield.addClass("persist-input-active");
    }

    // phase: 0..1 completion of the whole tracker run
    setProgress(ratio, text) {
        if (!this.isActive) return;
        const percent = Math.max(5, Math.min(100, Math.round(ratio * 100)));
        this.progressFill.css("width", `${percent}%`);
        if (text) this.progressText.text(text);
    }

    complete(text = "Tracker complete!") {
        if (!this.isActive) return;
        this.progressFill.css("width", "100%");
        this.progressText.text(text);
        setTimeout(() => this.hide(), 1500);
    }

    hide() {
        this.isActive = false;
        this.progressBar.fadeOut(300);
        this.formShield.removeClass("persist-input-active");
    }
}

export const pipelineBar = new PipelineBar();