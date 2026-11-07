/**
 * What a provider said when an attempt failed, saved for a person (docs/plans/fleet-follow-through.md, part 5).
 *
 * Fallback between agents was removed in v115, and exhaustion.ts recognises only a dead sign-in. Telling a used-up
 * subscription from any other failure needs a REAL response, so this saves them as they happen and nothing else. Nothing
 * reads this table to route work: `hint` is a sort key for a person, never a recogniser, and a person's label decides
 * nothing either. The text is the provider's, so it is data, scrubbed of secrets and bounded.
 */
import { readingFleet } from "./fleet-schema.js";
import { cleanFindingText } from "./findings.js";
import type { Store } from "./store.js";

export const CAPTURE_TEXT_LIMIT = 4_000;
/** Kept per provider, newest first. A labelled capture is never pruned: it is the evidence a person kept. */
const CAPTURES_KEPT = 40;
/** Words worth a person's look. Only ever a sort key. */
const LIMIT_WORDS = /\b(usage limit|rate limit|quota|credit|billing|exhaust|limit reached|too many requests|429|payment)/i;

export type ProviderCapture = {
  id: number; run: number; repo: string | null; provider: string; model: string | null; authMode: string | null; exitCode: number | null;
  code: string | null; text: string; hint: boolean; label: "exhausted" | "not-exhausted" | null; labelledBy: string | null; at: string;
};

/** Save one failed attempt's last words. Bookkeeping: it never costs the run anything. */
export function captureProviderFailure(store: Store, input: { run: number; provider: string; model: string | null; authMode: string | null; exitCode: number | null; code: string | null; texts: readonly (string | null | undefined)[] }, now: Date): void {
  try {
    const text = cleanFindingText(input.texts.filter((one): one is string => typeof one === "string" && one.trim() !== "").join(" | "), CAPTURE_TEXT_LIMIT);
    if (text === "" && input.code === null) return;
    const run = store.getRun(input.run);
    const repo = run === null ? null : store.refById(run.taskRef)?.repo ?? null;
    store.handle.prepare(`INSERT INTO provider_capture (run, repo, provider, model, auth_mode, exit_code, code, text, hint, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (run) DO NOTHING`)
      .run(input.run, repo, input.provider, input.model, input.authMode, input.exitCode, input.code === null ? null : cleanFindingText(input.code, 120), text, LIMIT_WORDS.test(`${input.code ?? ""} ${text}`) ? 1 : 0, now.toISOString());
    store.handle.prepare(`DELETE FROM provider_capture WHERE provider = ? AND label IS NULL AND id NOT IN (SELECT id FROM provider_capture WHERE provider = ? ORDER BY id DESC LIMIT ?)`).run(input.provider, input.provider, CAPTURES_KEPT);
  } catch { /* a capture is never worth a run */ }
}

const captureOf = (row: Record<string, unknown>): ProviderCapture => ({
  id: Number(row["id"]), run: Number(row["run"]), repo: row["repo"] === null ? null : String(row["repo"]), provider: String(row["provider"]), model: row["model"] === null ? null : String(row["model"]),
  authMode: row["auth_mode"] === null ? null : String(row["auth_mode"]), exitCode: row["exit_code"] === null ? null : Number(row["exit_code"]), code: row["code"] === null ? null : String(row["code"]),
  text: String(row["text"]), hint: Number(row["hint"]) === 1, label: row["label"] === null ? null : String(row["label"]) as ProviderCapture["label"], labelledBy: row["labelled_by"] === null ? null : String(row["labelled_by"]), at: String(row["at"]),
});

/** Newest first, the ones mentioning limits at the top. */
export function providerCaptures(store: Store, repos: readonly string[] | null, limit = 50): ProviderCapture[] {
  return readingFleet(() => store.handle.prepare("SELECT * FROM provider_capture ORDER BY hint DESC, id DESC LIMIT 500").all().map(captureOf)
    .filter(one => repos === null || (one.repo !== null && repos.includes(one.repo))).slice(0, limit), []);
}

export function providerCapture(store: Store, id: number): ProviderCapture | null {
  return readingFleet(() => {
    const row = store.handle.prepare("SELECT * FROM provider_capture WHERE id = ?").get(id);
    return row === undefined ? null : captureOf(row);
  }, null);
}

/** A person's reading of one capture. It marks it for keeping, and nothing routes on it. */
export function labelProviderCapture(store: Store, id: number, label: "exhausted" | "not-exhausted", by: string): boolean {
  return Number(store.handle.prepare("UPDATE provider_capture SET label = ?, labelled_by = ? WHERE id = ?").run(label, by, id).changes) === 1;
}

/** What goes in a fixture file: the provider's response and which version of what produced it. */
export function captureFixture(capture: ProviderCapture): Record<string, unknown> {
  return { version: 1, provider: capture.provider, model: capture.model, authMode: capture.authMode, exitCode: capture.exitCode, code: capture.code, text: capture.text, label: capture.label, labelledBy: capture.labelledBy, capturedAt: capture.at };
}
