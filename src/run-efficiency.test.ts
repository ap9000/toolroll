/** How a run went (run-efficiency.ts, docs/plans/run-efficiency.md): only what was recorded, unknown never zero, step
 * detail bounded and never quoted, derived once and kept, never a verdict. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { deriveRunEfficiency, runEfficiencyOf, stepsOf, usageOf } from "./run-efficiency.js";
import { serializeLiveRecord, type LiveRecord } from "./live-records.js";
import { openStore, type Store } from "./store.js";

const T0 = new Date("2026-10-21T09:00:00.000Z");
const at = (s: number) => new Date(T0.getTime() + s * 1000).toISOString();

test("usage is read per provider: Claude's input leaves its cache out, Codex's includes it; unreported is null, never 0", () => {
  const claude = usageOf({ provider: "claude", model: "sonnet", tokensIn: 100, tokensOut: 50, usageJson: JSON.stringify({ input_tokens: 100, cache_read_input_tokens: 800, cache_creation_input_tokens: 100, output_tokens: 50 }) });
  expect(claude).toMatchObject({ in: 1000, cacheRead: 800, cacheWrite: 100, out: 50, cacheShare: 0.8 });
  const codex = usageOf({ provider: "codex", model: null, tokensIn: 1000, tokensOut: 40, usageJson: JSON.stringify({ input_tokens: 1000, cached_input_tokens: 600, output_tokens: 40 }) });
  expect(codex).toMatchObject({ in: 1000, cacheRead: 600, cacheWrite: null, cacheShare: 0.6 });
  expect(usageOf({ provider: "claude", model: null, tokensIn: null, tokensOut: null, usageJson: null })).toMatchObject({ in: null, out: null, cacheRead: null, cacheShare: null });
  // An unreadable report: Claude's own tokens-in leaves its cache out, so it isn't a total either — unknown.
  expect(usageOf({ provider: "claude", model: null, tokensIn: 7, tokensOut: 3, usageJson: "{not json" })).toMatchObject({ in: null, out: 3, cacheShare: null });
  expect(usageOf({ provider: "opencode", model: null, tokensIn: 9, tokensOut: 2, usageJson: "{}" })).toMatchObject({ in: 9, cacheRead: null, cacheShare: null });
  // A Claude report missing one of the three parts claims no total and no share (never "89% cached" by a zero).
  expect(usageOf({ provider: "claude", model: null, tokensIn: 100, tokensOut: 5, usageJson: JSON.stringify({ input_tokens: 100, cache_read_input_tokens: 800 }) })).toMatchObject({ in: null, cacheRead: 800, cacheWrite: null, cacheShare: null });
  // Codex cached past its own input is a report that can't be right: no share.
  expect(usageOf({ provider: "codex", model: null, tokensIn: 10, tokensOut: 1, usageJson: JSON.stringify({ input_tokens: 10, cached_input_tokens: 80 }) })).toMatchObject({ cacheShare: null });
});

const steps = (detail: "base" | "commands", extra: LiveRecord[]): LiveRecord[] => [{ k: "open", at: at(0), detail }, { k: "start", at: at(0) }, ...extra];

test("steps: counts by kind, failures, observed times only; made-up or unclosed steps have no measured time", () => {
  const records = steps("base", [
    { k: "step", at: at(1), id: "a", kind: "read" }, { k: "done", at: at(3), id: "a", ok: true },
    { k: "step", at: at(4), id: "b", kind: "command" }, { k: "done", at: at(64), id: "b", ok: false },
    // The recorder made this one's start and end together: no measured time.
    { k: "step", at: at(70), id: "c", kind: "command", once: true }, { k: "done", at: at(70), id: "c", ok: true },
    { k: "step", at: at(80), id: "d", kind: "edit" },
    { k: "step", at: at(81), id: "m", kind: "message" },
    // Closed by the recorder when the run ended (outcome unknown), and one with no time between: neither is measured.
    { k: "step", at: at(90), id: "e", kind: "command" }, { k: "done", at: at(150), id: "e", ok: null },
    { k: "step", at: at(160), id: "f", kind: "edit" }, { k: "done", at: at(160), id: "f", ok: true },
  ]);
  const got = stepsOf(records, null);
  expect(got).toMatchObject({ state: "complete", total: 6, failed: 1, unknownDuration: 4, byKind: { read: 1, command: 3, edit: 2 } });
  expect(got.longest).toEqual([{ kind: "command", ms: 60_000 }, { kind: "read", ms: 2_000 }]);
  // Base detail records no inputs: repeats can't be told apart, and the page says so.
  expect(got.repeats).toBeNull();
  expect(got.repeatsReason).toMatch(/doesn't record step details/);
  // A provider whose step times the recorder can't see as they happen (Codex, ACP): no duration is claimed at all.
  expect(stepsOf(records, null, false)).toMatchObject({ longest: [], unknownDuration: 6, total: 6 });
});

test("repeated activity counts only steps recorded whole, and never stores their words", () => {
  const same = (id: string, s: number, target: string): LiveRecord[] => [{ k: "step", at: at(s), id, kind: "command", target }, { k: "done", at: at(s + 1), id, ok: true }];
  const records = steps("commands", [...same("1", 1, "npm test"), ...same("2", 3, "npm test"), ...same("3", 5, "npm test"), ...same("4", 7, "npm run build"),
    // Shortened by the recorder: not comparable, left out and said.
    ...same("5", 9, "node -e …"), ...same("6", 11, "node -e …"), ...same("7", 13, "node -e …")]);
  const edits: LiveRecord[] = [1, 2, 3].flatMap(n => [{ k: "step", at: at(20 + n), id: `e${n}`, kind: "edit", target: "src/app.ts" } as LiveRecord, { k: "done", at: at(21 + n), id: `e${n}`, ok: true } as LiveRecord]);
  const got = stepsOf([...records, ...edits], null);
  // Three edits to one file are three different edits as far as the record knows: only commands are compared.
  expect(got.repeats).toEqual([{ kind: "command", count: 3 }]);
  expect(got.repeatsReason).toMatch(/some were shortened or hidden/);
  expect(JSON.stringify(got)).not.toContain("npm test");
});

let root: string, store: Store;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "so-eff-")); store = openStore(":memory:"); });
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

function finishedRun(finishedAt: Date): number {
  store.createTask({ id: "t-eff", title: "Measure it" }, T0);
  const taskRef = store.refFor("built-in", "t-eff").id;
  const authority = store.routeAuthorityFor(taskRef, "builder") ?? store.routeAuthorityFor(taskRef, "builder", { provider: "claude", model: null });
  const run = store.startRun({ taskRef, leaseId: "l-eff", runner: "runner-a", branch: "b/eff", worktree: "/w/eff", now: T0, ...(authority?.ok ? { route: authority.stamp } : {}) });
  store.recordUsage(run, { tokensIn: 100, tokensOut: 20, usageJson: JSON.stringify({ input_tokens: 100, cache_read_input_tokens: 300, cache_creation_input_tokens: 0, output_tokens: 20 }), agentTurns: 6 });
  store.finishRun(run, { outcome: "built", committed: true, now: finishedAt });
  return run;
}

test("derived once and kept: a later view reads the saved row; an expired live file says so, a missing recent one says none was kept", () => {
  const run = finishedRun(new Date(T0.getTime() + 60_000));
  mkdirSync(join(root, "live"), { recursive: true });
  writeFileSync(join(root, "live", `${run}.jsonl`), steps("base", [{ k: "step", at: at(1), id: "s1", kind: "read" }, { k: "done", at: at(2), id: "s1", ok: true }]).map(one => `${serializeLiveRecord(one)}\n`).join(""));
  const first = runEfficiencyOf(store, root, run, new Date(T0.getTime() + 120_000))!;
  expect(first).toMatchObject({ turns: 6, usage: { in: 400, cacheShare: 0.75 }, steps: { state: "complete", total: 1 } });
  expect(store.handle.prepare("SELECT steps FROM run_efficiency WHERE run = ?").get(run)).toEqual({ steps: "complete" });
  // The live file goes (it is kept a day); the saved row still answers, unchanged.
  rmSync(join(root, "live", `${run}.jsonl`));
  expect(runEfficiencyOf(store, root, run, new Date(T0.getTime() + 3 * 86_400_000))).toEqual(first);
  // Derived fresh with no file: a day later it has expired; soon after the run, none was kept.
  const row = store.getRun(run)!;
  expect(deriveRunEfficiency({ ...row, usageJson: null }, root, new Date(T0.getTime() + 2 * 86_400_000)).steps).toMatchObject({ state: "expired", total: null });
  expect(deriveRunEfficiency({ ...row, usageJson: null }, root, new Date(T0.getTime() + 120_000)).steps).toMatchObject({ state: "absent", total: null });
});

test("budgets: a file past its record budget is counted up to it and says it was truncated", () => {
  const run = finishedRun(new Date(T0.getTime() + 60_000));
  mkdirSync(join(root, "live"), { recursive: true });
  const many: LiveRecord[] = [];
  for (let i = 1; i <= 20_500; i++) many.push({ k: "step", at: at(1), id: `s${i}`, kind: "read" });
  writeFileSync(join(root, "live", `${run}.jsonl`), steps("base", many).map(one => `${serializeLiveRecord(one)}\n`).join(""));
  const got = deriveRunEfficiency({ ...store.getRun(run)!, usageJson: null }, root, new Date(T0.getTime() + 120_000));
  expect(got.steps.state).toBe("truncated");
  expect(got.steps.reason).toMatch(/first 20,000 records/);
});

const writeLive = (run: number, body: string | Buffer, name = `${run}.jsonl`) => { mkdirSync(join(root, "live"), { recursive: true }); writeFileSync(join(root, "live", name), body); };

test("the reader says what it couldn't read: too large, an older text format, nothing parseable, a cut line", () => {
  const run = finishedRun(new Date(T0.getTime() + 60_000));
  const derive = () => deriveRunEfficiency({ ...store.getRun(run)!, usageJson: null }, root, new Date(T0.getTime() + 120_000)).steps;
  writeLive(run, Buffer.alloc(4 * 1024 * 1024 + 1, 0x61));
  expect(derive()).toMatchObject({ state: "truncated", total: null, reason: expect.stringMatching(/larger than they can be read/) });
  rmSync(join(root, "live", `${run}.jsonl`));
  writeLive(run, "the agent said things\n", `${run}.log`);
  expect(derive()).toMatchObject({ state: "truncated", total: null, reason: expect.stringMatching(/older format/) });
  rmSync(join(root, "live", `${run}.log`));
  writeLive(run, "not json\n{also not}\n");
  expect(derive()).toMatchObject({ state: "truncated", total: null, reason: expect.stringMatching(/couldn't be read/) });
  writeLive(run, [{ k: "open", at: at(0), detail: "base" }, { k: "cut", at: "" }, { k: "step", at: at(1), id: "s1", kind: "read" }].map(one => `${serializeLiveRecord(one as LiveRecord)}\n`).join(""));
  expect(derive()).toMatchObject({ state: "truncated", total: 1, reason: expect.stringMatching(/too long to keep/) });
});

test("a store that can't save the row still shows what was derived", () => {
  const run = finishedRun(new Date(T0.getTime() + 60_000));
  store.handle.exec("DROP TABLE run_efficiency");
  expect(runEfficiencyOf(store, root, run, new Date(T0.getTime() + 120_000))).toMatchObject({ turns: 6 });
});
