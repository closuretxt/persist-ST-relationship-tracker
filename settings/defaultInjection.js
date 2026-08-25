// Persist default injection wrapper.
// Wraps the per-character relationship blocks produced by the macro in a
// <user_relationships> tag together with a short explanation for the LLM.
/*
export const DEFAULT_INJECTION_INTRO = `The following is persistent relationship data between {{user}} and the characters, tracked across the entire chat.

- Stats range from 1 to 100 and are the AUTHORITATIVE ground truth for how each character feels. Treat these numbers as fact: they always override whatever is said or implied in the scene. If a character's words or narration contradict their stats, the stats win — portray the disconnect instead of following the claim (e.g. a character claiming to love {{user}} with low Romantic is lying, in denial, or mistaken).
- The lower the pursuit value, the less interested the character is overall. The higher the Saturation, more tired the character is from the user antics. Acquiescence is how available the character is to perform intimate acts, under 50 a character will not even CONSIDER engaging.
- Statuses are lasting effects from past events that continue to influence each character until they are removed or disabled.
- Keep your writing consistent with this data: characters must behave according to their current stats, mind state, relationship and active statuses, even when the scene suggests otherwise.
- Do not repeat or quote this data verbatim in your reply.`;

*/

export const DEFAULT_INJECTION_INTRO = `The following is persistent relationship data between {{user}} and the characters, tracked across the entire chat.

- Stats range from 1 to 100 and are the AUTHORITATIVE ground truth for how each character feels. Treat these numbers as fact: they always override whatever is said or implied in the scene. If a character's words or narration contradict their stats, the stats win — portray the disconnect instead of following the claim (e.g. a character claiming to love {{user}} with low Romantic is lying, in denial, or mistaken).
- The lower the pursuit value, the less interested the character is overall. The higher the Saturation, more tired the character is from the user antics.
- Acquiescence is the willingness to engage in erotic acts. Below 50 is a hard floor: the character will not consider it, no matter how the scene is framed. At or above 50 the character is merely open to it, not compliant by default. Higher value means more actions are available.
- Statuses are lasting effects from past events that continue to influence each character until they are removed or disabled.
- Keep your writing consistent with this data: characters must behave according to their current stats, mind state, relationship and active statuses, even when the scene suggests otherwise.
- Statuses are just suggestions and previous events, stats take the authority over them.
- Do not repeat or quote this data verbatim in your reply. When scene momentum pulls toward something the stats don't support, follow the stats and show the friction, not the momentum.`;

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