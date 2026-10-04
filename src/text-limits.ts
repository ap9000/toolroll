/**
 * Text limits, in one place, and the one way a limit is met: a model is told the exact limit before it writes, an
 * answer still over it is asked once to shorten (one repair turn), and an answer still over after that is kept whole
 * in the record and linked, never chopped. Chat platforms' own message limits are met by splitting across messages.
 *
 * Limits apply when text is written. Reading never re-validates length, so a runtime with lower limits (0.9.23 to
 * 0.9.26) still opens a store holding longer text (scripts/upgrade-path.mjs, the rollback leg).
 */

/** UTF-16 code units, the JavaScript and HTML maxlength measure, unless a name says bytes. */
export const TEXT_LIMITS = {
  /** A task's goal and its out-of-scope text. */
  goal: 8_000,
  goalBytes: 32_000,
  /** Revise feedback, steering and decision notes. */
  note: 4_000,
  noteBytes: 16_000,
  /** A flow work zone's instructions; nothing is held back for the card's details (they are attached when long). */
  flowInstructions: 8_000,
  /** A research report's summary, in UTF-8 bytes. */
  reportSummary: 2_500,
  /** What one flow step passes on to the steps after it. */
  stageOutput: 12_000,
} as const;

/** One chat message on each platform. Longer text is split across messages, never cut. */
export const PLATFORM_LIMITS = { telegram: 4_096, discord: 2_000, slack: 4_000 } as const;
export type Platform = keyof typeof PLATFORM_LIMITS;

const count = (n: number) => n.toLocaleString("en-US");

/** The line a model reads before it writes a field with a limit. */
export function limitRule(what: string, limit: number, unit: "characters" | "bytes" = "characters"): string {
  return `${what}: at most ${count(limit)} ${unit}. Put the most important part first. Longer text is not cut: you will be asked to shorten it.`;
}

/** One field over its limit: what it is, its limit, and how long it came back. */
export type Overrun = { field: string; limit: number; length: number; unit?: "characters" | "bytes" };

/** How long a text is in a limit's unit. */
export const lengthIn = (text: string, unit: "characters" | "bytes" = "characters") => unit === "bytes" ? Buffer.byteLength(text, "utf8") : text.length;

/** The fields of `values` over their limits. */
export function overruns(values: Record<string, string>, limits: Record<string, number>, unit: "characters" | "bytes" = "characters"): Overrun[] {
  return Object.entries(limits).flatMap(([field, limit]) => {
    const value = values[field];
    if (value === undefined) return [];
    const length = lengthIn(value, unit);
    return length > limit ? [{ field, limit, length, ...(unit === "bytes" ? { unit } : {}) }] : [];
  });
}

/** The repair turn's ask: each field over its limit, by how much, and the same answer again within it. */
export function shortenAsk(over: readonly Overrun[]): string {
  return [
    "Your answer is over a limit:",
    ...over.map(one => `- ${one.field} is ${count(one.length)} ${one.unit ?? "characters"}; the limit is ${count(one.limit)}.`),
    "Answer again with the same decision and meaning, each field within its limit. Shorten by dropping repetition and detail, not facts that matter.",
  ].join("\n");
}

/**
 * Ask, check, and ask once more to shorten. `write` gets null the first time and the shorten ask the second.
 * The second answer is returned whatever its length: the caller keeps it whole (and links it when it must).
 */
export async function writeWithin<T>(write: (shorten: string | null) => Promise<T>, check: (answer: T) => Overrun[]): Promise<{ answer: T; over: Overrun[]; repaired: boolean }> {
  const first = await write(null);
  const over = check(first);
  if (over.length === 0) return { answer: first, over, repaired: false };
  const second = await write(shortenAsk(over));
  return { answer: second, over: check(second), repaired: true };
}

/**
 * Text passed on under a limit: whole when it fits; otherwise kept whole in the record named by `where` and passed on
 * as a pointer to it. Never a cut.
 */
export function passOn(text: string, limit: number, where: { label: string; href: string | null }): { text: string; kept: boolean } {
  if (text.length <= limit) return { text, kept: false };
  const at = where.href === null ? where.label : `${where.label}: ${where.href}`;
  return { text: `This is ${count(text.length)} characters, more than the ${count(limit)} a step passes on, so it is kept whole on ${at}.`, kept: true };
}
