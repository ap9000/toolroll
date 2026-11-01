/**
 * The eval set (docs/plans/evals-nightly.md, part C1): versioned cases run by the installed plane, each attempt in a
 * throwaway world of its own, graded by a trusted oracle outside the fence, every provider dispatch through a gate
 * and every dispatch's spending recorded as it was reported.
 *
 * - **Cases** live in `evals/` (shipped in the package): `manifest.json` lists them; each `cases/<id>/` holds
 *   `case.json`, `fixture/` (the project the agent starts from, plain files), `oracle.mjs` + `probe.mjs` (the hidden
 *   check) and `source.md` (where it came from). A case's version is the sha256 of its folder; a link or anything but a
 *   regular file in it refuses the whole set. A case is a draft until a person validates its expected outcome
 *   (`validatedBy` in case.json, changed only in a release a person approves: `evals/` is a policy path).
 * - **Campaigns**: canonical (no flags) seals every case, its version, its pin, k = 3 and the installed build; it is
 *   refused while any case is a draft or any pin isn't an exact model id. Anything else is diagnostic. Admission is one
 *   transaction with a person's proof: no release operation reserved, no deploy draining, one canonical campaign at a
 *   time (settlement order). The runner that owns a campaign is recorded, so an interrupted one can be recovered.
 * - **Attempts** run as `toolroll evals attempt …`, a child process of the installed binary in its own process group,
 *   with its own world (database, repository, worktrees, dispatch gate). The runner waits for the whole process tree to
 *   be gone, reads the world's database (read only), extracts the built files from verified Git objects, and only then
 *   asks the oracle (eval-oracle.ts).
 * - **Money**: no limit (the owner, 2026-10-30). What every dispatch spent is recorded on every exit path: API dollars,
 *   subscription usage and unknown kept apart and never added together; a dispatch the world's records don't account
 *   for, or one that went around the gate, makes the attempt an error with unknown spending.
 *
 * Result-writing authority is this module's alone: a world never gets a handle on the plane's database.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, realpathSync, rmSync, writeSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { homedir, hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { readVerifiedCommit, verifiedBlobs } from "./commit-extract.js";
import { updateAdmissionPaused } from "./desktop-update-gate.js";
import { EVAL_GATE_ENV, evalGateOverLimit, evalGateSlots, limiter, openEvalGate, readNoFollow } from "./eval-gate.js";
import { runOracle, type OracleVerdict } from "./eval-oracle.js";
import { personProof } from "./person-proof.js";
import { observeProcessTree, stopProcessTree } from "./process-tree.js";
import { processMayBeAlive } from "./process-liveness.js";
import { combineReportedModels, type ReportedAmount } from "./reported-usage.js";
import { authenticateApprover } from "./scope.js";
import { deriveRunEfficiency } from "./run-efficiency.js";
import { chatTurnAccounting, runAccounting, Store } from "./store.js";

// Loaded on first use, like the store: a static import prints Node's SQLite warning and can't be bundled.
const sqlite = (): typeof import("node:sqlite") => createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export const EVALS_ROOT = fileURLToPath(new URL("../evals/", import.meta.url));
export const EVAL_K = 3;
/** An errored attempt gets one replacement when the plane confirms the error; at most this many a campaign. */
export const EVAL_MAX_REPLACEMENTS = 3;
/** Attempts at once within one campaign. */
export const EVAL_CONCURRENCY = 2;
const CASE_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const FIXTURE_PATH = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}(\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}){0,3}$/;
/** Names that pick a model for you: never a pin. */
const MODEL_ALIASES = new Set(["sonnet", "opus", "haiku", "default", "best", "opusplan", "sonnet[1m]", "opus[1m]"]);
const MAX_CASE_FILES = 64;
const MAX_CASE_FILE_BYTES = 256 * 1024;

export type EvalCaseKind = "build" | "ask";
export type EvalCase = {
  id: string;
  version: string;
  dir: string;
  kind: EvalCaseKind;
  title: string;
  /** What the task asks, as the agent's brief gets it. */
  goal: string;
  touches: string[];
  pin: { provider: "claude"; model: string };
  maxDispatches: number;
  timeoutMinutes: number;
  /** build: the files the oracle copies from the built commit. ask: the options the question must offer (patterns). */
  grade: { files: string[] } | { options: string[] };
  /** The person who validated the expected outcome, or null: a draft, counted in no canonical campaign. */
  validatedBy: string | null;
  fixture: Record<string, string>;
};

export type EvalSet = { ok: true; root: string; manifestDigest: string; cases: EvalCase[] } | { ok: false; problem: string };

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

/** Every regular file under `dir` (relative path → bytes), never through a link; null with why when anything else is
 * there or a limit is passed. */
function folderFiles(dir: string, limit = MAX_CASE_FILES): { ok: true; files: Map<string, Buffer> } | { ok: false; problem: string } {
  const files = new Map<string, Buffer>();
  const walk = (at: string, depth: number): string | null => {
    if (depth > 4) return `${relative(dir, at)} is nested too deep`;
    let names: string[];
    try { names = readdirSync(at).sort(); } catch { return `${relative(dir, at) || "the case folder"} can't be read`; }
    for (const name of names) {
      const path = join(at, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) { const problem = walk(path, depth + 1); if (problem !== null) return problem; continue; }
      if (!stat.isFile()) return `${relative(dir, path)} is a link or not a regular file`;
      const bytes = readNoFollow(path, MAX_CASE_FILE_BYTES);
      if (bytes === null) return `${relative(dir, path)} can't be read or is over ${MAX_CASE_FILE_BYTES} bytes`;
      files.set(relative(dir, path).split(sep).join("/"), bytes);
      if (files.size > limit) return `the folder holds more than ${limit} files`;
    }
    return null;
  };
  const problem = walk(dir, 0);
  return problem === null ? { ok: true, files } : { ok: false, problem };
}

/** A folder's digest: every file's path and bytes, in path order. */
function digestOf(files: Map<string, Buffer>): string {
  const hash = createHash("sha256");
  for (const [path, bytes] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) hash.update(path).update("\0").update(sha256(bytes)).update("\0");
  return hash.digest("hex");
}

/** Why a pin isn't an exact model id, or null. An alias, an empty or odd value, or a non-Claude provider is no pin. */
export function exactModelProblem(pin: { provider?: unknown; model?: unknown } | null | undefined): string | null {
  if (pin === null || pin === undefined || pin.provider !== "claude") return "its pin names no provider an eval can cap and read the exact model of (claude)";
  const model = pin.model;
  if (typeof model !== "string" || !/^claude-[a-z0-9][a-z0-9.-]{2,80}$/.test(model) || !/[0-9]/.test(model) || MODEL_ALIASES.has(model)) {
    return `its pin ${typeof model === "string" ? `"${model.slice(0, 60)}"` : ""} isn't an exact model id`;
  }
  return null;
}

const text = (value: unknown, max: number): string | null => typeof value === "string" && value.trim() !== "" && value.length <= max ? value : null;
const whole = (value: unknown, low: number, high: number): number | null => Number.isInteger(value) && (value as number) >= low && (value as number) <= high ? value as number : null;

function caseOf(id: string, dir: string, files: Map<string, Buffer>): { ok: true; value: EvalCase } | { ok: false; problem: string } {
  const bad = (why: string) => ({ ok: false as const, problem: `case ${id}: ${why}` });
  for (const needed of ["case.json", "source.md"]) if (!files.has(needed)) return bad(`${needed} is missing`);
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(files.get("case.json")!.toString("utf8")) as Record<string, unknown>; } catch { return bad("case.json isn't JSON"); }
  if (raw["id"] !== id) return bad("case.json names another id");
  const kind = raw["kind"] === "build" || raw["kind"] === "ask" ? raw["kind"] : null;
  const title = text(raw["title"], 200), goal = text(raw["goal"], 4000);
  const touches = Array.isArray(raw["touches"]) && raw["touches"].every(one => typeof one === "string" && FIXTURE_PATH.test(one)) ? raw["touches"] as string[] : null;
  const pin = raw["pin"] as { provider?: unknown; model?: unknown } | undefined;
  const maxDispatches = whole(raw["maxDispatches"], 1, 10), timeoutMinutes = whole(raw["timeoutMinutes"], 1, 60);
  const validatedBy = raw["validatedBy"] === null ? null : text(raw["validatedBy"], 80);
  if (kind === null || title === null || goal === null || touches === null || maxDispatches === null || timeoutMinutes === null) return bad("case.json is missing a field or has one out of range");
  if (raw["validatedBy"] !== null && validatedBy === null) return bad("validatedBy is a person's name, or null while the case is a draft");
  if (typeof pin?.provider !== "string" || typeof pin.model !== "string") return bad("its pin names no provider and model");
  const grade = raw["grade"] as Record<string, unknown> | undefined;
  let graded: EvalCase["grade"];
  if (kind === "build") {
    const graded_files = grade?.["files"];
    if (!Array.isArray(graded_files) || graded_files.length === 0 || graded_files.length > 8 || !graded_files.every(one => typeof one === "string" && FIXTURE_PATH.test(one) && one !== "probe.mjs")) return bad("a build case grades 1 to 8 plain files (never probe.mjs)");
    if (!files.has("oracle.mjs") || !files.has("probe.mjs")) return bad("a build case has oracle.mjs and probe.mjs");
    graded = { files: graded_files as string[] };
  } else {
    const options = grade?.["options"];
    if (!Array.isArray(options) || options.length < 2 || !options.every(one => typeof one === "string" && one.length <= 100 && (() => { try { new RegExp(one, "i"); return true; } catch { return false; } })())) return bad("an ask case names at least two option patterns");
    graded = { options: options as string[] };
  }
  const fixture: Record<string, string> = {};
  for (const [path, bytes] of files) if (path.startsWith("fixture/")) fixture[path.slice("fixture/".length)] = bytes.toString("utf8");
  if (Object.keys(fixture).length === 0) return bad("its fixture is empty");
  if (!Object.keys(fixture).every(path => FIXTURE_PATH.test(path) && !path.split("/").includes(".git"))) return bad("a fixture path isn't a plain path");
  return { ok: true, value: { id, version: digestOf(files), dir, kind, title, goal, touches, pin: { provider: "claude", model: pin.model },
    maxDispatches, timeoutMinutes, grade: graded, validatedBy, fixture } };
}

/** The installed eval set: the manifest's cases, each read whole and versioned. Any case that can't be read, and any
 * folder the manifest doesn't list, refuses the whole set. */
export function loadEvalSet(root: string = EVALS_ROOT): EvalSet {
  const manifestBytes = readNoFollow(join(root, "manifest.json"), 64 * 1024);
  if (manifestBytes === null) return { ok: false, problem: "evals/manifest.json can't be read" };
  let manifest: Record<string, unknown>;
  try { manifest = JSON.parse(manifestBytes.toString("utf8")) as Record<string, unknown>; } catch { return { ok: false, problem: "evals/manifest.json isn't JSON" }; }
  const ids = manifest["cases"];
  if (manifest["v"] !== 1 || !Array.isArray(ids) || !ids.every(one => typeof one === "string" && CASE_ID.test(one)) || new Set(ids).size !== ids.length) return { ok: false, problem: "evals/manifest.json lists no valid case ids" };
  let present: string[];
  try { present = readdirSync(join(root, "cases")).sort(); } catch { return { ok: false, problem: "evals/cases can't be read" }; }
  const unlisted = present.filter(one => !ids.includes(one));
  if (unlisted.length > 0) return { ok: false, problem: `evals/cases holds ${unlisted.join(", ")}, which the manifest doesn't list` };
  const cases: EvalCase[] = [];
  for (const id of ids as string[]) {
    const dir = join(root, "cases", id);
    try { if (!lstatSync(dir).isDirectory()) return { ok: false, problem: `case ${id} isn't a folder` }; } catch { return { ok: false, problem: `case ${id} is missing` }; }
    const files = folderFiles(dir);
    if (!files.ok) return { ok: false, problem: `case ${id}: ${files.problem}` };
    const one = caseOf(id, dir, files.files);
    if (!one.ok) return one;
    cases.push(one.value);
  }
  return { ok: true, root, manifestDigest: sha256(JSON.stringify({ manifest: sha256(manifestBytes), cases: cases.map(one => [one.id, one.version]) })), cases };
}

export type CampaignAsk = { cases?: string[]; k?: number; diagnostic?: boolean };
export type CampaignPlan = { canonical: boolean; k: number; cases: EvalCase[] };

/** What a campaign runs. Canonical (nothing asked): every case, k = 3, refused while any case is a draft. Diagnostic
 * (anything asked): a report only. Either way every case runs under an exact model pin. */
export function planCampaign(set: Extract<EvalSet, { ok: true }>, ask: CampaignAsk): { ok: true; plan: CampaignPlan } | { ok: false; problem: string } {
  const canonical = ask.cases === undefined && ask.k === undefined && ask.diagnostic !== true;
  const k = ask.k ?? EVAL_K;
  if (!Number.isInteger(k) || k < 1 || k > 5) return { ok: false, problem: "--k is a whole number from 1 to 5" };
  const unknown = (ask.cases ?? []).filter(id => !set.cases.some(one => one.id === id));
  if (unknown.length > 0) return { ok: false, problem: `no case is named ${unknown.join(", ")}` };
  const cases = ask.cases === undefined ? set.cases : set.cases.filter(one => ask.cases!.includes(one.id));
  if (cases.length === 0) return { ok: false, problem: "no case to run" };
  for (const one of cases) {
    const problem = exactModelProblem(one.pin);
    if (problem !== null) return { ok: false, problem: `case ${one.id}: ${problem}` };
  }
  if (canonical) {
    const drafts = cases.filter(one => one.validatedBy === null).map(one => one.id);
    if (drafts.length > 0) return { ok: false, problem: `a canonical campaign counts only cases a person validated, and ${drafts.length === cases.length ? "every case is" : `${drafts.join(", ")} ${drafts.length === 1 ? "is" : "are"}`} still a draft. Run a diagnostic campaign (--diagnostic) meanwhile` };
  }
  return { ok: true, plan: { canonical, k, cases } };
}

export type Admission = { ok: true; id: string } | { ok: false; reason: "person-only" | "release-busy" | "already-running"; message: string };

/**
 * Admit a campaign (eval or reviewer): a person proved now, nothing releasing or deploying, and no other canonical
 * campaign running (canonical campaigns settle in the order they were admitted). One transaction: the proof, the checks
 * and the row, with the runner that owns it (this process, on this computer) for recovery.
 */
export function admitEvalCampaign(store: Store, input: {
  kind: "eval" | "reviewer"; canonical: boolean; manifestDigest: string; buildDigest: string; version: string; k: number;
  sealed: unknown; as: string; token: string; now: Date; id?: string; runner?: { host: string; pid: number; started?: string | null };
}): Admission {
  const id = input.id ?? `ev-${input.now.toISOString().slice(0, 10).replace(/-/g, "")}-${randomBytes(4).toString("hex")}`;
  // The runner's process start time too: recovery never takes a later process that reuses its pid for the runner.
  const runner = input.runner ?? { host: hostname(), pid: process.pid, started: processStartOf(process.pid) };
  try {
    return store.transact((): Admission => {
      const proved = authenticateApprover(store, input.as, input.token, null);
      if (!proved.ok || !personProof(proved.method)) return { ok: false, reason: "person-only", message: "Only an approver, proved as a person with their password, starts an eval campaign: it calls models." };
      const busy = store.handle.prepare("SELECT COUNT(*) AS n FROM release_operation WHERE state IN ('reserved','running')").get();
      if (Number(busy?.["n"] ?? 0) > 0 || updateAdmissionPaused(store.handle)) return { ok: false, reason: "release-busy", message: "A release is deploying or merging, so no eval campaign starts now. Try again once it's done." };
      if (input.canonical) {
        const running = store.handle.prepare("SELECT id FROM eval_campaign WHERE canonical = 1 AND state = 'running'").get();
        if (running !== undefined) return { ok: false, reason: "already-running", message: `Canonical campaign ${String(running["id"])} is still running; canonical campaigns run one at a time.` };
      }
      store.handle.prepare(`INSERT INTO eval_campaign (id, kind, canonical, manifest_digest, build_digest, version, baseline_campaign, k, sealed_json, started_by, started_proof,
          runner_host, runner_pid, runner_started, admitted_at, state) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'running')`)
        .run(id, input.kind, input.canonical ? 1 : 0, input.manifestDigest, input.buildDigest, input.version, input.k, JSON.stringify(input.sealed), input.as, proved.method,
          runner.host, runner.pid, runner.started ?? null, input.now.toISOString());
      store.recordAction({ at: input.now.toISOString(), actor: input.as, repo: null, taskId: null, runId: null, action: "eval campaign started", outcome: input.canonical ? "canonical" : "diagnostic", source: "request",
        detail: `${input.kind} campaign ${id}` });
      return { ok: true, id };
    });
  } catch (error) {
    // The unique running index is the last word on "one canonical at a time" when two admissions race.
    if (/UNIQUE constraint failed: eval_campaign/.test(String((error as Error).message))) return { ok: false, reason: "already-running", message: "Another canonical campaign started at the same moment; they run one at a time." };
    throw error;
  }
}

/** Record one attempt's start (its identity is unique). Refused when the campaign isn't running. */
export function startEvalAttempt(store: Store, input: { campaign: string; caseId: string; caseVersion: string; n: number; replaces: number; modelPinned: string; now: Date }):
  { ok: true; attempt: number } | { ok: false; why: string } {
  return store.transact(() => {
    const campaign = store.handle.prepare("SELECT state FROM eval_campaign WHERE id = ?").get(input.campaign);
    if (campaign === undefined || campaign["state"] !== "running") return { ok: false as const, why: "the campaign isn't running" };
    const made = store.handle.prepare("INSERT INTO eval_attempt (campaign, case_id, case_version, n, replaces, model_pinned, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(input.campaign, input.caseId, input.caseVersion, input.n, input.replaces, input.modelPinned, input.now.toISOString());
    return { ok: true as const, attempt: Number(made.lastInsertRowid) };
  });
}

/** Where an attempt's world is, and its process group once spawned: what recovery reads if the runner stops. */
function markAttemptWorld(store: Store, attempt: number, worldDir: string, pgid: number | null): void {
  store.handle.prepare("UPDATE eval_attempt SET world_dir = ?, world_pgid = COALESCE(?, world_pgid) WHERE id = ? AND outcome IS NULL").run(worldDir, pgid, attempt);
}

type WorldProcesses = { state: "not-started" | "starting" | "watching" | "unknown" | "stopped"; witnesses: [number, boolean][] };

/** Saved outside the world: recovery must check detached groups as well as the world's original group. */
function recordWorldProcesses(store: Store, attempt: number, processes: WorldProcesses): void {
  store.handle.prepare("UPDATE eval_attempt SET world_processes_json = ? WHERE id = ? AND outcome IS NULL").run(JSON.stringify(processes), attempt);
}

export type EvalOutcome = "pass" | "fail" | "error" | "unevaluated";
/** One provider dispatch an attempt's world made: its record (`run:<id>`, `chat_turn:<id>`) or the gate slot no record
 * accounts for (`slot:<n>`), what it was billed as, and the model it reported. */
export type EvalDispatchRecord = { kind: string; worldRef: string; recorded: boolean; amount: ReportedAmount; modelReported: string | null };
export type AttemptResult = {
  outcome: EvalOutcome; why: string | null; modelReported: string | null; dispatches: number | null;
  apiMicrousd: number | null; subscriptionMicrousd: number | null; usageUnknown: boolean;
  turns: number | null; tokensIn: number | null; cacheRead: number | null; cacheWrite: number | null; tokensOut: number | null; toolCalls: number | null;
  wallMs: number; invocations: EvalDispatchRecord[];
};

/** Record a finished attempt, once: its outcome, each dispatch as it was billed, and its totals. */
export function recordEvalAttempt(store: Store, attempt: number, result: AttemptResult, now: Date): void {
  store.transact(() => {
    const row = store.handle.prepare("SELECT outcome FROM eval_attempt WHERE id = ?").get(attempt);
    if (row === undefined) throw new Error(`no eval attempt ${attempt}`);
    if (row["outcome"] !== null) return;
    for (const one of result.invocations) {
      const api = one.amount.kind === "api" ? one.amount.microusd : null;
      const subscription = one.amount.kind === "subscription" && one.amount.reportedUsd !== null ? Math.round(one.amount.reportedUsd * 1_000_000) : null;
      store.handle.prepare(`INSERT INTO eval_invocation (attempt, kind, world_ref, recorded, amount, api_microusd, subscription_microusd, model_reported) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (attempt, world_ref) DO NOTHING`)
        .run(attempt, one.kind.slice(0, 40), one.worldRef.slice(0, 80), one.recorded ? 1 : 0, one.amount.kind, api, subscription, one.modelReported);
    }
    store.handle.prepare(`UPDATE eval_attempt SET outcome = ?, error_why = ?, model_reported = ?, dispatches = ?, api_microusd = ?, subscription_microusd = ?, usage_unknown = ?,
        turns = ?, tokens_in = ?, cache_read = ?, cache_write = ?, tokens_out = ?, tool_calls = ?, wall_ms = ?, finished_at = ? WHERE id = ?`)
      .run(result.outcome, result.why === null ? null : result.why.slice(0, 500), result.modelReported, result.dispatches, result.apiMicrousd, result.subscriptionMicrousd,
        result.usageUnknown ? 1 : 0, result.turns, result.tokensIn, result.cacheRead, result.cacheWrite, result.tokensOut, result.toolCalls, result.wallMs, now.toISOString(), attempt);
  });
}

/** End a campaign, once: complete or incomplete. */
export function finishEvalCampaign(store: Store, id: string, state: "complete" | "incomplete", why: string | null, now: Date): void {
  store.handle.prepare("UPDATE eval_campaign SET state = ?, why = ?, finished_at = ? WHERE id = ? AND state = 'running'").run(state, why, now.toISOString(), id);
}

/** What a campaign spent, from its attempts as recorded: API dollars (null when any dispatch's money is unknown),
 * subscription usage (null when any is unknown or unreported), and how many attempts had unknown spending. Never one
 * total of the three. */
export function campaignSpending(store: Store, id: string): { apiMicrousd: number | null; subscriptionMicrousd: number | null; unknownAttempts: number; attempts: number } {
  const rows = store.handle.prepare("SELECT api_microusd, subscription_microusd, usage_unknown FROM eval_attempt WHERE campaign = ? AND outcome IS NOT NULL").all(id);
  // An abandoned campaign's spending is unknown whatever its finished attempts recorded: its runner may have gone on.
  const abandoned = Number(store.handle.prepare("SELECT spending_unknown FROM eval_campaign WHERE id = ?").get(id)?.["spending_unknown"] ?? 0) !== 0;
  const total = (column: string): number | null => abandoned || rows.some(row => row[column] === null) ? null : rows.reduce((sum, row) => sum + Number(row[column]), 0);
  return { apiMicrousd: total("api_microusd"), subscriptionMicrousd: total("subscription_microusd"), unknownAttempts: rows.filter(row => Number(row["usage_unknown"]) === 1).length, attempts: rows.length };
}

// ------------------------------------------------------------------ collecting a world

export type WorldDispatches = {
  invocations: EvalDispatchRecord[]; modelReported: string | null; dispatches: number | null;
  /** Asked past the case's limit (the gate refused it), or more dispatches than the limit recorded. */
  overLimit: boolean;
  /** A dispatch the gate and the records don't agree on: a record with no slot (it went around the gate), a slot with no
   * record, or slots that can't be read. Its spending is unknown and the attempt is an error. */
  unaccounted: boolean;
  apiMicrousd: number | null; subscriptionMicrousd: number | null; usageUnknown: boolean;
  turns: number | null; tokensIn: number | null; cacheRead: number | null; cacheWrite: number | null; tokensOut: number | null; toolCalls: number | null;
};

const sum = (values: (number | null)[]): number | null => values.some(one => one === null) ? null : values.reduce<number>((total, one) => total + (one as number), 0);
const UNKNOWN: ReportedAmount = { kind: "unknown" };

/** Every provider dispatch a world made, from its own records (its database, opened read only; null when there is none
 * or it can't be read) and its gate's slots: each with what it was billed as and the model it reported. A slot no
 * record accounts for, and a record no slot does, is a dispatch with unknown money and an unknown model. */
export function collectWorld(world: Store | null, gateDir: string, maxDispatches: number, evidenceRoot: string, now: Date): WorldDispatches {
  const slots = evalGateSlots(gateDir);
  const invocations: EvalDispatchRecord[] = [];
  const turns: (number | null)[] = [], tokensIn: (number | null)[] = [], cacheRead: (number | null)[] = [], cacheWrite: (number | null)[] = [], tokensOut: (number | null)[] = [];
  const toolCalls: (number | null)[] = [];
  const unrecorded = (slot: { n: number; kind: string }): void => {
    invocations.push({ kind: "unrecorded", worldRef: `slot:${slot.n}`, recorded: false, amount: UNKNOWN, modelReported: null });
    for (const list of [turns, tokensIn, cacheRead, cacheWrite, tokensOut, toolCalls]) list.push(null);
  };
  let unaccounted = slots === null;
  if (world === null) {
    for (const slot of slots !== null && slots.length > 0 ? slots : [{ n: 0, kind: "unreadable" }]) unrecorded(slot);
    unaccounted = true;
  } else {
    try {
      const runs = world.handle.prepare("SELECT id, role FROM run WHERE provider_started_at IS NOT NULL ORDER BY id").all().map(row => ({ id: Number(row["id"]), role: String(row["role"]) }));
      const runSlots = new Set((slots ?? []).filter(slot => slot.kind.startsWith("run:")).map(slot => slot.kind));
      const chatSlots = (slots ?? []).filter(slot => !slot.kind.startsWith("run:"));
      for (const run of runs) {
        const read = runAccounting(world, run.id);
        if (!runSlots.has(`run:${run.id}`)) unaccounted = true;
        invocations.push({ kind: run.role, worldRef: `run:${run.id}`, recorded: true, amount: read?.amount ?? UNKNOWN, modelReported: read?.modelReported ?? null });
        turns.push(read?.agentTurns ?? null); tokensIn.push(read?.usage.in ?? null); cacheRead.push(read?.usage.cacheRead ?? null); cacheWrite.push(read?.usage.cacheWrite ?? null); tokensOut.push(read?.usage.out ?? null);
        toolCalls.push(toolCallsOf(world, run.id, evidenceRoot, now));
      }
      const chats = world.handle.prepare("SELECT id FROM chat_turn WHERE state IN ('running','answered','failed') ORDER BY id").all().map(row => Number(row["id"]));
      for (const id of chats) {
        const read = chatTurnAccounting(world, id);
        invocations.push({ kind: "lead", worldRef: `chat_turn:${id}`, recorded: true, amount: read?.amount ?? UNKNOWN, modelReported: read?.modelReported ?? null });
        turns.push(read?.providerTurns ?? null); tokensIn.push(read?.tokensIn ?? null); cacheRead.push(read?.cacheReadTokens ?? null); cacheWrite.push(read?.cacheWriteTokens ?? null); tokensOut.push(read?.tokensOut ?? null);
        // A chat request's own tool calls aren't step-recorded: unknown.
        toolCalls.push(null);
      }
      if (chats.length > chatSlots.length) unaccounted = true;
      // A run slot whose run never reached its provider spent nothing; a run slot with no run at all, or a chat slot past
      // the recorded chat requests, may have been sent.
      for (const slot of slots ?? []) {
        if (!slot.kind.startsWith("run:")) continue;
        const id = Number(slot.kind.slice(4));
        if (Number.isSafeInteger(id) && world.handle.prepare("SELECT 1 FROM run WHERE id = ?").get(id) !== undefined) continue;
        unrecorded(slot);
        unaccounted = true;
      }
      for (const slot of chatSlots.slice(chats.length)) { unrecorded(slot); unaccounted = true; }
    } catch {
      // Keep every charge already read. A damaged or older world must not prevent settlement or turn missing
      // dispatches into zero spending. The synthetic slot is explicitly unknown, never a measured call.
      unrecorded({ n: 0, kind: "unreadable" });
      unaccounted = true;
    }
  }
  if (slots === null && !invocations.some(one => one.worldRef === "slot:0")) unrecorded({ n: 0, kind: "unreadable" });
  const moneyUnknown = invocations.some(one => one.amount.kind === "unknown");
  const usageUnknown = moneyUnknown || invocations.some(one => one.amount.kind === "subscription" && one.amount.reportedUsd === null);
  let modelReported: string | null = null;
  for (const [index, one] of invocations.entries()) modelReported = index === 0 ? one.modelReported : combineReportedModels(modelReported, one.modelReported);
  const count = slots === null || world === null ? null : Math.max(invocations.length, slots.length);
  return {
    invocations, modelReported: unaccounted || invocations.length === 0 ? null : modelReported, dispatches: count,
    overLimit: (count ?? 0) > maxDispatches || evalGateOverLimit(gateDir), unaccounted,
    apiMicrousd: moneyUnknown ? null : sum(invocations.map(one => one.amount.kind === "api" ? one.amount.microusd : 0)),
    subscriptionMicrousd: moneyUnknown ? null : sum(invocations.map(one => one.amount.kind === "subscription" ? (one.amount.reportedUsd === null ? null : Math.round(one.amount.reportedUsd * 1_000_000)) : 0)),
    usageUnknown, turns: unaccounted ? null : sum(turns), tokensIn: unaccounted ? null : sum(tokensIn), cacheRead: unaccounted ? null : sum(cacheRead), cacheWrite: unaccounted ? null : sum(cacheWrite), tokensOut: unaccounted ? null : sum(tokensOut), toolCalls: unaccounted ? null : sum(toolCalls),
  };
}

/** A run's tool calls from its step records (run-efficiency.ts stepsOf), read before the world is removed; null when
 * the records are absent, expired or incomplete. */
function toolCallsOf(world: Store, runId: number, evidenceRoot: string, now: Date): number | null {
  const run = world.getRun(runId);
  if (run === null) return null;
  const usageJson = world.handle.prepare("SELECT usage_json FROM run WHERE id = ?").get(runId)?.["usage_json"];
  try {
    const steps = deriveRunEfficiency({ ...run, usageJson: typeof usageJson === "string" ? usageJson : null }, evidenceRoot, now).steps;
    return steps.state === "complete" ? steps.total : null;
  } catch { return null; }
}

/** A world's records, read only; null when there is no database or it can't be read. */
function openWorld(databaseFile: string): Store | null {
  try { lstatSync(databaseFile); } catch { return null; }
  try { return new Store(new (sqlite().DatabaseSync)(databaseFile, { readOnly: true })); } catch { return null; }
}

// ------------------------------------------------------------------ one attempt

/** The installed build's identity: its version, a digest of every file of the code that is running (dist when
 * installed, the sources in a checkout), and the service definitions that say which runtime the plane runs (a deploy
 * rewrites them to another runtime's folder). A change between attempts, or before the end, stops the campaign as
 * incomplete. */
export function installedBuildDigest(version: string, home: string = homedir()): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const units: string[] = [];
  for (const folder of [join(home, "Library", "LaunchAgents"), join(home, ".config", "systemd", "user")]) {
    let names: string[] = [];
    try { names = readdirSync(folder).sort(); } catch { continue; }
    for (const name of names) if (/toolroll|standing-orders/i.test(name)) units.push(`${name}\0${sha256(readNoFollow(join(folder, name), 1024 * 1024) ?? Buffer.from("unreadable"))}`);
  }
  return sha256(`${version}\0${folderFilesDeep(here)}\0${units.join("\0")}`);
}

function folderFilesDeep(dir: string): string {
  const hash = createHash("sha256");
  const walk = (at: string): void => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile() && /\.(js|ts|mjs|json)$/.test(name) && !/\.test\.ts$/.test(name)) hash.update(relative(dir, path)).update("\0").update(sha256(readNoFollow(path, 64 * 1024 * 1024) ?? Buffer.from("unreadable"))).update("\0");
      else if (stat.isSymbolicLink()) hash.update(relative(dir, path)).update("\0link\0");
    }
  };
  walk(dir);
  return hash.digest("hex");
}

/** How an attempt's world is started: the child command (the installed binary's `evals attempt`, or a test's world). */
export type AttemptCommand = (input: { campaign: string; caseId: string; n: number; worldDir: string; databaseFile: string; gateDir: string }) => { file: string; args: string[]; env: Record<string, string> };

export type AttemptDeps = {
  command: AttemptCommand;
  /** The oracle (eval-oracle.ts runOracle by default: a separate process from the installed release). */
  oracle?: (input: { caseDir: string; inputDir: string; timeoutMs: number; deny?: readonly string[] }) => Promise<OracleVerdict>;
  /** Where worlds are made (a folder the plane owns). */
  workRoot: string;
  /** How long the world's processes get to end after its child does, before the attempt is an error. */
  settleMs?: number;
  /** Called the moment the whole process tree is proven gone, before anything is read or graded (tests). */
  onTreeGone?: () => void;
  keepWorlds?: boolean;
  now?: () => Date;
};

type ChildReport = { stage: "world-start" | "agent" | "done"; why: string | null } | null;

/** Whether every process witness is gone: the child's own group, and each descendant the observer saw, checked as what
 * it was seen as (a process, or a group whose leader it was). */
function treeGone(pgid: number, seen: ReadonlyMap<number, boolean>): boolean {
  return pgid > 0 && !processMayBeAlive(pgid, true) && [...seen].every(([pid, group]) => !processMayBeAlive(pid, group));
}

/** Stop what is left of a world: the child's group, and each witness as what it was seen as. Its own processes only. */
function stopWorld(pgid: number, seen: ReadonlyMap<number, boolean>): void {
  if (pgid > 0) { try { process.kill(-pgid, "SIGKILL"); } catch { /* gone */ } }
  for (const [pid, group] of seen) { try { process.kill(group ? -pid : pid, "SIGKILL"); } catch { /* gone */ } }
}

/** Run the child and wait for its whole process tree: the child's exit, its process group gone, and every descendant
 * (and every group one led) the process-tree observer saw gone. A tree that won't end, or one whose ancestry couldn't
 * be observed, is stopped and reported (`lingering`), never graded. */
async function runWorldProcess(spec: { file: string; args: string[]; env: Record<string, string> }, cwd: string, timeoutMs: number, settleMs: number,
  onSpawn: (pgid: number) => void, persist: (processes: WorldProcesses) => void):
  Promise<{ timedOut: boolean; report: ChildReport; lingering: boolean; stopped: boolean; why: string | null; code: number | null }> {
  persist({ state: "starting", witnesses: [] });
  const child: ChildProcess = spawn(spec.file, spec.args, { cwd, env: spec.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const seen = new Map<number, boolean>();
  let unknownAncestry = false;
  const pgid = child.pid ?? -1;
  const save = (): void => persist({ state: unknownAncestry ? "unknown" : "watching", witnesses: [...(pgid > 0 ? [[pgid, true] as [number, boolean]] : []), ...seen] });
  // A persistence failure after spawn must still stop the owned child and await its exit.
  try { if (pgid > 0) onSpawn(pgid); save(); } catch { unknownAncestry = true; child.kill("SIGKILL"); }
  observeProcessTree(child, {
    onDescendant: (pid, group) => { seen.set(pid, seen.get(pid) === true || group); save(); },
    onDescendantExit: (pid, group) => { if (seen.get(pid) === group) { seen.delete(pid); save(); } },
    onUnknown: () => { unknownAncestry = true; save(); },
  });
  let stdout = "";
  child.stdout?.on("data", (chunk: Buffer) => { if (stdout.length < 64 * 1024) stdout += chunk.toString("utf8"); });
  child.stderr?.on("data", () => undefined);
  let timedOut = false;
  const code = await new Promise<number | null>(done => {
    const timer = setTimeout(() => {
      timedOut = true;
      stopProcessTree(child);
      if (pgid > 0) { try { process.kill(-pgid, "SIGKILL"); } catch { /* gone */ } }
    }, timeoutMs);
    child.once("error", () => { clearTimeout(timer); done(null); });
    child.once("close", exit => { clearTimeout(timer); done(exit); });
  });
  if (timedOut) stopWorld(pgid, seen);
  const until = Date.now() + settleMs;
  while (pgid > 0 && !treeGone(pgid, seen) && Date.now() < until) await new Promise(done => setTimeout(done, 50));
  let lingering = false, why: string | null = null;
  if ((pgid > 0 && !treeGone(pgid, seen)) || unknownAncestry) {
    lingering = true;
    why = unknownAncestry ? "its world's process tree couldn't be observed whole, so it wasn't graded" : "the world's processes didn't end after its attempt, so it wasn't graded";
    stopWorld(pgid, seen);
    const last = Date.now() + 5_000;
    while (pgid > 0 && !treeGone(pgid, seen) && Date.now() < last) await new Promise(done => setTimeout(done, 50));
  }
  // Its report: the whole output as one JSON document (the CLI's envelope), or its last line. None: the agent's stage.
  let report: ChildReport = null;
  for (const candidate of [stdout.trim(), stdout.trim().split("\n").pop() ?? ""]) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const stage = parsed["evalStage"];
      if (stage === "world-start" || stage === "agent" || stage === "done") { report = { stage, why: typeof parsed["why"] === "string" ? parsed["why"].slice(0, 300) : null }; break; }
    } catch { /* not this one */ }
  }
  const stopped = pgid < 0 || (!unknownAncestry && treeGone(pgid, seen));
  persist({ state: stopped ? "stopped" : "unknown", witnesses: [...(pgid > 0 ? [[pgid, true] as [number, boolean]] : []), ...seen] });
  return { timedOut, report, lingering, stopped, why, code };
}

/** Write each graded file of the built commit, from verified Git objects (never the checkout, never a link), into a
 * fresh folder for the oracle. */
function extractGraded(repo: string, head: string, files: readonly string[], into: string): { ok: true } | { ok: false; why: string } {
  let gitDir: string;
  try { gitDir = realpathSync(join(repo, ".git")); if (!lstatSync(join(repo, ".git")).isDirectory()) return { ok: false, why: "the world's repository has no Git directory" }; } catch { return { ok: false, why: "the world's repository can't be read" }; }
  const commit = readVerifiedCommit(gitDir, head);
  if (!commit.ok) return { ok: false, why: "the built commit can't be read" };
  const blobs = verifiedBlobs(gitDir, commit.value.tree, files);
  if (!blobs.ok) return { ok: false, why: `the built files can't be read: ${blobs.message}` };
  for (const file of files) {
    const blob = blobs.value.get(file);
    if (blob === undefined) continue; // missing: the oracle fails it
    mkdirSync(dirname(join(into, file)), { recursive: true });
    const fd = openSync(join(into, file), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeSync(fd, blob.bytes); } finally { closeSync(fd); }
  }
  return { ok: true };
}

/** An attempt's result from what its world recorded, with the outcome and why. */
const resultOf = (outcome: EvalOutcome, why: string | null, collected: WorldDispatches, wallMs: number): AttemptResult => ({
  outcome, why, modelReported: collected.modelReported, dispatches: collected.dispatches,
  apiMicrousd: collected.apiMicrousd, subscriptionMicrousd: collected.subscriptionMicrousd, usageUnknown: collected.usageUnknown,
  turns: collected.turns, tokensIn: collected.tokensIn, cacheRead: collected.cacheRead, cacheWrite: collected.cacheWrite, tokensOut: collected.tokensOut, toolCalls: collected.toolCalls,
  wallMs, invocations: collected.invocations });

/**
 * One attempt: record its start, make the world, run its child to the end of its whole process tree, read what it
 * did, grade it, record it. What the world dispatched is collected and recorded on every road out, the runner's own
 * failure included, before the world is removed. Outcomes (plan, "Grading"): an error only where the plane itself
 * recorded one (the world failed before the agent started, the provider refused or was down, the oracle failed, the
 * world's processes wouldn't end, a dispatch the gate and the records don't agree on); the agent timing out, crashing
 * or going past its dispatch limit is a fail; a reported model other than the pin is unevaluated.
 */
export async function runEvalAttempt(store: Store, input: { campaign: string; one: EvalCase; n: number; replaces: number }, deps: AttemptDeps):
  Promise<{ attempt: number; result: AttemptResult; stopCampaign: string | null } | { attempt: null; why: string }> {
  const now = deps.now ?? (() => new Date());
  const { one } = input;
  const started = startEvalAttempt(store, { campaign: input.campaign, caseId: one.id, caseVersion: one.version, n: input.n, replaces: input.replaces, modelPinned: one.pin.model, now: now() });
  if (!started.ok) return { attempt: null, why: started.why };
  const attempt = started.attempt;
  const begun = Date.now();
  let worldDir: string | null = null;
  let ran: Awaited<ReturnType<typeof runWorldProcess>> | null = null;
  let failure: string | null = null;
  let spawned = false;
  // The world's state folder is named as Toolroll's own, so every agent fence in the world denies it whole: the
  // database, the worker's token and the dispatch gate (agent-fence.ts agentFence, a dedicated state folder).
  const paths = (dir: string) => ({ stateDir: join(dir, "toolroll"), gateDir: join(dir, "toolroll", "eval-gate"), databaseFile: join(dir, "toolroll", "orders.db") });
  try {
    mkdirSync(deps.workRoot, { recursive: true, mode: 0o700 });
    worldDir = realpathSync(mkdtempSync(join(deps.workRoot, `${one.id}-${input.n}-`)));
    markAttemptWorld(store, attempt, worldDir, null);
    recordWorldProcesses(store, attempt, { state: "not-started", witnesses: [] });
    const { stateDir, gateDir, databaseFile } = paths(worldDir);
    mkdirSync(stateDir, { mode: 0o700 });
    mkdirSync(gateDir, { mode: 0o700 });
    openEvalGate(gateDir, { v: 2, max: one.maxDispatches });
    const spec = deps.command({ campaign: input.campaign, caseId: one.id, n: input.n, worldDir, databaseFile, gateDir });
    ran = await runWorldProcess({ ...spec, env: { ...spec.env, [EVAL_GATE_ENV]: gateDir } }, worldDir, one.timeoutMinutes * 60_000, deps.settleMs ?? 30_000,
      pgid => { spawned = true; markAttemptWorld(store, attempt, worldDir!, pgid); }, processes => recordWorldProcesses(store, attempt, processes));
    if (ran.stopped) deps.onTreeGone?.();
  } catch (error) {
    failure = `the eval runner failed: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`;
  }
  // Whatever happened, what the world recorded is read before anything is decided or removed.
  const where = worldDir === null ? null : paths(worldDir);
  // A lingering tree has been stopped by now: its records are read all the same, so known spending is kept.
  const world = where === null ? null : openWorld(where.databaseFile);
  let result: AttemptResult;
  const collected = where === null
    ? collectWorld(null, join(deps.workRoot, "no-world"), one.maxDispatches, "", now())
    : collectWorld(world, where.gateDir, one.maxDispatches, join(where.stateDir, "evidence"), now());
  try {
    const wall = () => Date.now() - begun;
    if (failure !== null) result = resultOf("error", failure, collected, wall());
    else if (ran === null) result = resultOf("error", "the eval runner failed", collected, wall());
    else if (ran.lingering) result = resultOf("error", ran.why, collected, wall());
    else if (world === null) {
      result = resultOf("error", ran.report?.stage === "world-start" ? `the world failed before the agent started: ${ran.report.why ?? "no reason given"}` : "the world's records can't be read", collected, wall());
    } else if (collected.unaccounted) {
      result = resultOf("error", "a provider dispatch and the world's records don't agree (one went around the gate, or left no record), so its spending is unknown", collected, wall());
    } else {
      const startedRuns = Number(world.handle.prepare("SELECT COUNT(*) AS n FROM run WHERE provider_started_at IS NOT NULL").get()?.["n"] ?? 0);
      const refused = Number(world.handle.prepare("SELECT COUNT(*) AS n FROM run WHERE outcome = 'refused' AND provider_started_at IS NULL").get()?.["n"] ?? 0);
      if (collected.invocations.length === 0 && startedRuns === 0) {
        // Nothing reached a provider: the world failed before the agent started (its child said so), or the provider
        // refused (a plane-side record); anything else is the agent's (a fail).
        const why = ran.report?.stage === "world-start" ? `the world failed before the agent started: ${ran.report.why ?? "no reason given"}`
          : refused > 0 ? "the provider refused or was unavailable before the agent started" : null;
        result = why !== null ? resultOf("error", why, collected, wall()) : resultOf("fail", ran.timedOut ? "timed out before the agent started" : "the agent never started", collected, wall());
      } else if (collected.overLimit) {
        result = resultOf("fail", `it asked for more than its limit of ${one.maxDispatches} provider dispatches`, collected, wall());
      } else if (ran.timedOut) {
        result = resultOf("fail", `it ran past its ${one.timeoutMinutes}-minute limit`, collected, wall());
      } else if (ran.code !== 0) {
        result = resultOf("fail", "the world's process crashed", collected, wall());
      } else if (collected.modelReported !== one.pin.model) {
        result = resultOf("unevaluated", `the provider reported ${collected.modelReported ?? "no model"}, not the pinned ${one.pin.model}`, collected, wall());
      } else {
        const planeState = store.databaseFile();
        try {
          const graded = await grade(world, worldDir!, one, deps, planeState === null ? [] : [dirname(planeState)]);
          result = resultOf(graded.outcome, graded.why, collected, wall());
        } catch (error) {
          result = resultOf("error", `the grading failed: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`, collected, wall());
        }
      }
    }
  } catch (error) {
    result = resultOf("error", `the world's records couldn't be processed: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`, collected, Date.now() - begun);
  } finally { world?.close(); }
  // PR #263 review: a world whose process tree isn't proven stopped (its ancestry unknown, a process that outlived
  // SIGKILL, or a runner failure after the spawn) may still be dispatching. What it spent is unknown, never the part
  // its records show, and the campaign ends incomplete.
  let stopCampaign: string | null = null;
  if ((ran !== null && !ran.stopped) || (ran === null && spawned)) {
    result = { ...result, apiMicrousd: null, subscriptionMicrousd: null, usageUnknown: true,
      invocations: [...result.invocations, { kind: "unrecorded", worldRef: "tree:unstopped", recorded: false, amount: UNKNOWN, modelReported: null }] };
    stopCampaign = `${one.id} #${input.n}'s world couldn't be proven stopped, so what it spent is unknown`;
  }
  recordEvalAttempt(store, attempt, result, now());
  // Only once it is recorded is the world removed.
  if (worldDir !== null && ran?.stopped === true && deps.keepWorlds !== true) rmSync(worldDir, { recursive: true, force: true });
  return { attempt, result, stopCampaign };
}

/** Grade from what the world's installed code recorded: the built commit's files through the oracle (build), or the
 * question a run parked with (ask). The agent's own words are never read as a verdict. */
async function grade(world: Store, worldDir: string, one: EvalCase, deps: AttemptDeps, deny: readonly string[]): Promise<{ outcome: EvalOutcome; why: string | null }> {
  if ("options" in one.grade) {
    const asked = world.handle.prepare("SELECT d.options FROM decision d JOIN run r ON r.id = d.run WHERE r.role = 'builder' ORDER BY d.id LIMIT 1").get();
    if (asked === undefined) return { outcome: "fail", why: "the build didn't stop to ask" };
    const built = world.handle.prepare("SELECT COUNT(*) AS n FROM run WHERE role = 'builder' AND outcome = 'built' AND id < (SELECT MIN(run) FROM decision)").get();
    if (Number(built?.["n"] ?? 0) > 0) return { outcome: "fail", why: "it built before asking" };
    const options = String(asked["options"]);
    const missing = one.grade.options.filter(pattern => !new RegExp(pattern, "i").test(options));
    return missing.length === 0 ? { outcome: "pass", why: null } : { outcome: "fail", why: "its question didn't offer the choices the case needs" };
  }
  const built = world.handle.prepare("SELECT head_revision FROM run WHERE role IN ('builder','repair') AND outcome = 'built' AND head_revision IS NOT NULL ORDER BY id DESC LIMIT 1").get();
  if (built === undefined) return { outcome: "fail", why: "no build finished" };
  const inputDir = realpathSync(mkdtempSync(join(worldDir, "graded-")));
  const extracted = extractGraded(join(worldDir, "repo"), String(built["head_revision"]), one.grade.files, inputDir);
  if (!extracted.ok) return { outcome: "fail", why: extracted.why };
  const verdict = await (deps.oracle ?? runOracle)({ caseDir: one.dir, inputDir, timeoutMs: 60_000, deny });
  return { outcome: verdict.outcome, why: verdict.why };
}

// ------------------------------------------------------------------ a campaign

export type CampaignDeps = AttemptDeps & {
  /** The installed build's identity now (installedBuildDigest): a change stops the campaign as incomplete. */
  buildDigest: () => string;
  /** The installed eval set now (loadEvalSet): a change stops the campaign as incomplete too. */
  evalSet?: () => EvalSet;
  concurrency?: number;
};

/** Run an admitted campaign to its end: every sealed attempt (EVAL_CONCURRENCY at once), one replacement for an
 * attempt the plane recorded an error for (at most EVAL_MAX_REPLACEMENTS a campaign), then complete — or incomplete
 * when the installed build or eval set changed (checked before every attempt and again at the end), a deploy is
 * draining, or the runner itself failed. */
export async function runEvalCampaign(store: Store, campaign: string, cases: readonly EvalCase[], deps: CampaignDeps): Promise<{ state: "complete" | "incomplete"; why: string | null }> {
  const now = deps.now ?? (() => new Date());
  const row = store.handle.prepare("SELECT k, build_digest, manifest_digest, state FROM eval_campaign WHERE id = ?").get(campaign);
  if (row === undefined || row["state"] !== "running") throw new Error(`campaign ${campaign} isn't running`);
  const k = Number(row["k"]), sealedBuild = String(row["build_digest"]), sealedSet = String(row["manifest_digest"]);
  const setNow = (): string | null => { const set = (deps.evalSet ?? loadEvalSet)(); return set.ok ? set.manifestDigest : null; };
  const changed = (): string | null => deps.buildDigest() !== sealedBuild ? "the installed build changed during the campaign"
    : setNow() !== sealedSet ? "the installed eval set changed during the campaign"
    : updateAdmissionPaused(store.handle) ? "a deploy began draining during the campaign" : null;
  let stop: string | null = null;
  let replacements = 0;
  const gate = limiter(deps.concurrency ?? EVAL_CONCURRENCY);
  const attempt = async (one: EvalCase, n: number, replaces: number): Promise<void> => {
    if (stop !== null) return;
    const moved = changed();
    if (moved !== null) { stop = moved; return; }
    const ran = await runEvalAttempt(store, { campaign, one, n, replaces }, deps);
    if (ran.attempt === null) { stop ??= ran.why; return; }
    if (ran.stopCampaign !== null) { stop ??= ran.stopCampaign; return; }
    if (ran.result.outcome === "error" && replacements < EVAL_MAX_REPLACEMENTS && replaces === 0) {
      replacements++;
      await attempt(one, n, ran.attempt);
    }
  };
  try {
    await Promise.all(cases.flatMap(one => Array.from({ length: k }, (_, index) => gate(async () => {
      try { await attempt(one, index + 1, 0); }
      catch (error) { stop ??= `the eval runner failed: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`; }
    }))));
    // The identity again at the end: a change during the last attempts leaves the campaign incomplete too.
    stop ??= changed();
  } catch (error) {
    stop ??= `the eval runner failed: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`;
  }
  const state = stop === null ? "complete" as const : "incomplete" as const;
  finishEvalCampaign(store, campaign, state, stop, now());
  return { state, why: stop };
}

/**
 * Recover campaigns whose runner stopped (Codex round 1 #12): a running campaign whose runner was this computer's and
 * whose process is gone. Each unfinished attempt is recorded as an error with whatever its world recorded (its spending
 * unknown where the records can't say), once its world's process group is proven gone; then the campaign ends
 * incomplete. A campaign whose runner is alive, ran on another computer, or still has a world running stays as it is.
 */
export function recoverEvalCampaigns(store: Store, now: Date, options: { host?: string; alive?: (pid: number, started: string | null) => boolean } = {}):
  { id: string; recovered: boolean; why: string }[] {
  const host = options.host ?? hostname();
  const alive = options.alive ?? runnerMayBeAlive;
  const out: { id: string; recovered: boolean; why: string }[] = [];
  for (const campaign of store.handle.prepare("SELECT id, runner_host, runner_pid, runner_started FROM eval_campaign WHERE state = 'running' ORDER BY admitted_at").all()) {
    const id = String(campaign["id"]);
    if (String(campaign["runner_host"]) !== host) { out.push({ id, recovered: false, why: `its runner is on ${String(campaign["runner_host"])}` }); continue; }
    if (alive(Number(campaign["runner_pid"]), typeof campaign["runner_started"] === "string" ? campaign["runner_started"] : null)) {
      out.push({ id, recovered: false, why: "its runner is still running" }); continue;
    }
    const open = store.handle.prepare("SELECT id, world_dir, world_pgid, world_processes_json, case_id FROM eval_attempt WHERE campaign = ? AND outcome IS NULL").all(id);
    const busy = open.find(one => one["world_pgid"] !== null && processMayBeAlive(Number(one["world_pgid"]), true));
    if (busy !== undefined) { out.push({ id, recovered: false, why: `attempt ${String(busy["id"])}'s world (process group ${String(busy["world_pgid"])}) is still running` }); continue; }
    const unproven = open.find(one => {
      if (one["world_dir"] === null) return false; // No world was ever made.
      try {
        const saved = JSON.parse(String(one["world_processes_json"])) as WorldProcesses | null;
        if (saved === null || !Array.isArray(saved.witnesses)) return true;
        if (saved.state === "not-started" || saved.state === "stopped") return false;
        if (saved.state !== "watching" || saved.witnesses.length === 0) return true;
        return saved.witnesses.some(witness => !Array.isArray(witness) || witness.length !== 2
          || !Number.isSafeInteger(witness[0]) || witness[0] <= 0 || typeof witness[1] !== "boolean"
          || processMayBeAlive(witness[0], witness[1]));
      } catch { return true; }
    });
    if (unproven !== undefined) { out.push({ id, recovered: false, why: `attempt ${String(unproven["id"])}'s process tree isn't proven stopped` }); continue; }
    for (const one of open) {
      const dir = one["world_dir"] === null ? null : String(one["world_dir"]);
      const world = dir === null ? null : openWorld(join(dir, "toolroll", "orders.db"));
      try {
        // No world folder recorded: the attempt never got as far as making one (its gate reads as unreadable: unknown).
        const collected = collectWorld(world, dir === null ? "" : join(dir, "toolroll", "eval-gate"), Number.MAX_SAFE_INTEGER, dir === null ? "" : join(dir, "toolroll", "evidence"), now);
        recordEvalAttempt(store, Number(one["id"]), resultOf("error", "interrupted: its runner stopped before the attempt finished", collected, 0), now);
      } finally { world?.close(); }
    }
    finishEvalCampaign(store, id, "incomplete", "its runner stopped before the campaign finished", now);
    out.push({ id, recovered: true, why: `${open.length} unfinished attempt${open.length === 1 ? "" : "s"} recorded as interrupted` });
  }
  return out;
}

/** A process's start time as the system reports it (`ps -o lstart`, whole seconds, in UTC and the C locale), or null
 * when it can't be read: the identity a saved pid is compared by, so a later process that reuses the number is never
 * taken for the one recorded. */
export function processStartOf(pid: number): string | null {
  if (process.platform === "win32" || !Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const raw = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8", env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" }, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1024, timeout: 2_000, killSignal: "SIGKILL",
    }).trim().replace(/ +/g, " ");
    return /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(raw) ? raw : null;
  } catch { return null; }
}

/** Whether a campaign's runner may still be running (PR #263 review): its pid is held, and by the same process — its
 * start time, where one was recorded, matches. A pid now held by a process that started at another time is someone
 * else's. A start that can't be read now counts as alive (a person ends such a campaign: `evals recover --abandon`). */
export function runnerMayBeAlive(pid: number, started: string | null): boolean {
  if (!processMayBeAlive(pid, false)) return false;
  const was = started === null ? null : startMs(started);
  const now = processStartOf(pid);
  const is = now === null ? null : startMs(now);
  // Within two seconds is the same process: a system that derives the start from its boot time can shift it by a
  // second, and a pid can't be reused while the process holding it lives.
  return was === null || is === null || Math.abs(is - was) <= 2_000;
}

/** A `ps -o lstart` reading (UTC, C locale) as epoch milliseconds, or null when it isn't one exactly. */
function startMs(raw: string): number | null {
  const match = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}) (\d{2}:\d{2}:\d{2}) (\d{4})$/.exec(raw);
  if (match === null) return null;
  const utc = `${match[1]}, ${match[3]!.padStart(2, "0")} ${match[2]} ${match[5]} ${match[4]} GMT`;
  const ms = Date.parse(utc);
  return Number.isFinite(ms) && new Date(ms).toUTCString() === utc ? ms : null;
}

/**
 * End a stuck campaign by a person's word (PR #263 review): a campaign recovery can't settle (its runner can't be
 * proven gone, or a world's processes can't). A person proved now with their password (a lead token or remembered
 * login is no proof); in one transaction every unfinished attempt is recorded as an error with unknown spending, the
 * campaign's spending is marked unknown, and it ends incomplete. No process is signalled and no world is read or
 * removed: whatever is still running is left to the person.
 */
export function abandonEvalCampaign(store: Store, input: { id: string; as: string; token: string; now: Date }):
  { ok: true; attempts: number } | { ok: false; reason: "person-only" | "not-running"; message: string } {
  return store.transact(() => {
    const proved = authenticateApprover(store, input.as, input.token, null);
    if (!proved.ok || !personProof(proved.method)) return { ok: false as const, reason: "person-only" as const, message: "Only an approver, proved as a person with their password, abandons an eval campaign." };
    const campaign = store.handle.prepare("SELECT state FROM eval_campaign WHERE id = ?").get(input.id);
    if (campaign === undefined || campaign["state"] !== "running") return { ok: false as const, reason: "not-running" as const, message: `No running campaign is named ${input.id}.` };
    const open = store.handle.prepare("SELECT id FROM eval_attempt WHERE campaign = ? AND outcome IS NULL ORDER BY id").all(input.id).map(row => Number(row["id"]));
    for (const attempt of open) {
      recordEvalAttempt(store, attempt, { outcome: "error", why: `abandoned by ${input.as} before it finished`, modelReported: null, dispatches: null,
        apiMicrousd: null, subscriptionMicrousd: null, usageUnknown: true, turns: null, tokensIn: null, cacheRead: null, cacheWrite: null, tokensOut: null, toolCalls: null, wallMs: 0,
        invocations: [{ kind: "unrecorded", worldRef: "abandoned", recorded: false, amount: UNKNOWN, modelReported: null }] }, input.now);
    }
    store.handle.prepare("UPDATE eval_campaign SET spending_unknown = 1 WHERE id = ?").run(input.id);
    finishEvalCampaign(store, input.id, "incomplete", `abandoned by ${input.as}; what it spent is unknown`, input.now);
    store.recordAction({ at: input.now.toISOString(), actor: input.as, repo: null, taskId: null, runId: null, action: "eval campaign abandoned", outcome: "incomplete", source: "request",
      detail: `campaign ${input.id}, ${open.length} unfinished attempt${open.length === 1 ? "" : "s"}` });
    return { ok: true as const, attempts: open.length };
  });
}

/** A random hex id, for the world's throwaway approver password. */
export const worldSecret = (): string => randomBytes(24).toString("hex");
