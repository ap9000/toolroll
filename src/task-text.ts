/** New task text only. Historical signed terms are read by sealRevision,
 * never re-authored through this validator. Character counts deliberately
 * retain the existing JavaScript/HTML UTF-16 policy (TEXT_LIMITS.goal code units).
 * UTF-8 byte limits remain explicit storage bounds beside that policy. Reading
 * a stored goal never re-validates it, so a longer goal stays readable by a
 * runtime with lower limits. */
import { hasForbiddenControls, hasDisguisedText } from "./decision.js";
import { TEXT_LIMITS } from "./text-limits.js";

export const TASK_TEXT_LIMITS = { title: 200, text: TEXT_LIMITS.goal, textBytes: TEXT_LIMITS.goalBytes } as const;
const n = (value: number) => value.toLocaleString("en-US");
export const TASK_SCOPE_TEXT_SCHEMA = { type: "string", maxLength: TASK_TEXT_LIMITS.text,
  description: `At most ${n(TASK_TEXT_LIMITS.text)} characters (UTF-16 code units) and ${n(TASK_TEXT_LIMITS.textBytes)} UTF-8 bytes; no control or disguised text. Longer text is refused with its length, not cut: shorten it and call again.` } as const;

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
