// Persist default injection wrapper.
// Wraps the per-character relationship blocks produced by the macro in a
// <user_relationships> tag together with a short explanation for the LLM.

export const DEFAULT_INJECTION_INTRO = `The following is persistent relationship data between {{user}} and the characters, tracked across the entire chat. Stats range from 1 to 100. Statuses are lasting effects from past events that continue to influence each character. Keep this data consistent when writing: characters should behave according to their current stats, mind state, relationship and active statuses. Do not repeat this data verbatim in your reply.`;

export const DEFAULT_INJECTION_OPEN_TAG = "<user_relationships>";
export const DEFAULT_INJECTION_CLOSE_TAG = "</user_relationships>";

// Builds the full injected prompt around the raw character blocks.
// body: the raw per-character blocks (already joined with newlines).
export function getInjectionPrompt(body, intro = DEFAULT_INJECTION_INTRO) {
    const lines = [DEFAULT_INJECTION_OPEN_TAG];
    if (intro) lines.push(intro.trim());
    if (body && String(body).trim()) {
        lines.push("", body);
    }
    lines.push(DEFAULT_INJECTION_CLOSE_TAG);
    return lines.join("\n");
}