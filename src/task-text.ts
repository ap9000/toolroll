/** New task text only. Historical signed terms are read by sealRevision,
 * never re-authored through this validator. Character counts deliberately
 * retain the existing JavaScript/HTML UTF-16 policy (TEXT_LIMITS.goal code units).
 * UTF-8 byte limits remain explicit storage bounds beside that policy. Reading
 * a stored goal never re-validates it, so a longer goal stays readable by a
 * runtime with lower limits. */
import { hasForbiddenControls, hasDisguisedText } from "./decision.js";
import { TEXT_LIMITS } from "./text-limits.js";

export const TASK_TEXT_LIMITS = { title: TEXT_LIMITS.taskTitle, text: TEXT_LIMITS.goal, textBytes: TEXT_LIMITS.goalBytes } as const;
const n = (value: number) => value.toLocaleString("en-US");

export type TaskTextRefusal = { ok: false; reason: "bad-title" | "bad-goal"; message: string };
const dishonest = (text: string) => hasForbiddenControls(text) || hasDisguisedText(text);
const overBytes = (text: string, cap: number) => Buffer.byteLength(text, "utf8") > cap;
const BYTE_CAPS = { title: 800, text: TASK_TEXT_LIMITS.textBytes, path: 800 };
const refuse = (reason: TaskTextRefusal["reason"], message: string): TaskTextRefusal => ({ ok: false, reason, message });

export function validateScopeText(fields: { goal?: string; outOfScope?: string | null; touches?: readonly string[] }):
  { ok: false; reason: "bad-goal" | "bad-out-of-scope" | "bad-touches"; message: string } | null {
  for (const [value, label, reason, required] of [
    [fields.goal, "Goal", "bad-goal", true],
    [fields.outOfScope, "Exclusions", "bad-out-of-scope", false],
  ] as const) {
    if (value == null) continue;
    if (required && value.trim() === "") return { ok: false, reason, message: `${label} cannot be empty.` };
    if (value.length > TASK_TEXT_LIMITS.text) return { ok: false, reason, message: `${label} is ${n(value.length)} characters; the limit is ${n(TASK_TEXT_LIMITS.text)}. Shorten it.` };
    if (overBytes(value, BYTE_CAPS.text)) return { ok: false, reason, message: `${label} is ${n(Buffer.byteLength(value, "utf8"))} UTF-8 bytes; the limit is ${n(TASK_TEXT_LIMITS.textBytes)}. Shorten it.` };
    if (dishonest(value)) return { ok: false, reason, message: `${label} cannot contain control or hidden characters.` };
  }
  const touches = fields.touches ?? [];
  if (touches.length > 50 || touches.some(one => one.trim() === "" || one.length > 200 || overBytes(one, BYTE_CAPS.path) || dishonest(one))) {
    return { ok: false, reason: "bad-touches", message: "Use at most 50 paths, each non-empty, at most 200 characters, with no control or hidden characters." };
  }
  return null;
}

export function validateTaskText(fields: { title: string; goal?: string; outOfScope?: string | null; touches?: readonly string[] }): TaskTextRefusal | null {
  if (fields.title.trim() === "" || fields.title.length > 200 || overBytes(fields.title, BYTE_CAPS.title) || dishonest(fields.title)) {
    return refuse("bad-title", "a title is required, at most 200 characters, with no control or disguised text");
  }
  const bad = validateScopeText(fields);
  return bad === null ? null : refuse("bad-goal", bad.message);
}

/**
 * A title that fits: words longer than the title limit are cut at the last whole word that fits, with an ellipsis,
 * never mid-word (one unbroken word longer than half the limit is the only thing cut inside a word). Whitespace runs
 * read as one space. Text within the limit is returned as it is.
 */
export function titleWithin(text: string, max: number = TASK_TEXT_LIMITS.title): string {
  if (text.length <= max) return text;
  const words = text.replace(/\s+/g, " ").trim();
  if (words.length <= max) return words;
  const room = words.slice(0, max - 1);
  // The room ends at a whole word when the next character is a space; else back to the last space in it.
  const space = words[max - 1] === " " ? room.length : room.lastIndexOf(" ");
  const cut = (space >= Math.floor(max / 2) ? room.slice(0, space) : room).replace(/[\s,;:.\-–—]+$/u, "");
  return `${cut}…`;
}
