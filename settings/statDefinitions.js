// Persist stat definitions — SINGLE SOURCE OF TRUTH for numbered stats.
//
// To add a new stat: append an entry here. It will automatically appear in:
//   - character state (with the given default value)
//   - the tracker prompt ("## Stats" section)
//   - the Tracker settings drawer (on/off toggle)
//   - the injected macro, the panel bars, delta chips and net-effect row
//
// `prompt` is the tracker LLM description bullet for this stat.
// Special behaviors (like Saturation coupling or Pursuit decay) are keyed by
// `key` inside tracker/state.js — new stats without special keys simply
// accumulate from status deltas like any other stat.

export const STAT_DEFINITIONS = [
    {
        key: "romantic",
        label: "Romantic",
        defaultValue: 10,
        prompt: "Romantic: romantic intent and willingness. The best stat and the hardest to gain. Someone can be very close and willing without being romantic.",
    },
    {
        key: "friendship",
        label: "Friendship",
        defaultValue: 10,
        prompt: "Friendship: how much of a friend they are; closely related to trust.",
    },
    {
        key: "hate",
        label: "Hate",
        defaultValue: 1,
        prompt: "Hate: dislike towards {{user}}. It can coexist with any other stat (a wife may hate her husband; a person may hate their crush). It carries long-lasting results of arguments.",
    },
    {
        key: "saturation",
        label: "Saturation",
        defaultValue: 0,
        prompt: "Saturation: a cooldown meter. It RISES when other stats rise, and falls over time or through the character's own Pursuit. High Saturation means the character needs space; gains to other stats are less justified while it is high.",
    },
    {
        key: "pursuit",
        label: "Pursuit",
        defaultValue: 20,
        prompt: "Pursuit: how willing this character is to pursue {{user}}. It DECREASES when they feel pursued, flattered, or pushed. Flattering them too much punishes this stat.",
    },
    {
        key: "acquiescence",
        label: "Acquiescence",
        defaultValue: 0,
        prompt: "Acquiescence: how willing this character is to perform intimate acts. It changes accordingly with relationship and trust. Behaving weird or awkwardly decreases this value.",
    },
];

export const STAT_KEYS = STAT_DEFINITIONS.map(s => s.key);
export const STAT_LABELS = Object.fromEntries(STAT_DEFINITIONS.map(s => [s.key, s.label]));

// "romantic" -> "trackRomantic" (settings flag naming convention)
export function trackFlagFor(key) {
    return `track${key.charAt(0).toUpperCase() + key.slice(1)}`;
}