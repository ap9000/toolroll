/**
 * The eval set (docs/plans/evals-nightly.md, part C1): versioned cases run by the installed plane, each attempt in a
 * throwaway world of its own, graded by a trusted oracle outside the fence, every provider dispatch reserved against a
 * monthly ceiling.
 *
 * - **Cases** live in `evals/` (shipped in the package): `manifest.json` lists them; each `cases/<id>/` holds
 *   `case.json`, `fixture/` (the project the agent starts from, plain files), `oracle.mjs` + `probe.mjs` (the hidden
 *   check) and `source.md` (where it came from). A case's version is the sha256 of its folder; a link or anything but a
 *   regular file in it refuses the whole set. A case is a draft until a person validates its expected outcome
 *   (`validatedBy` in case.json, changed only in a release a person approves: `evals/` is a policy path).
 * - **Campaigns**: canonical (no flags) seals every case, its version, its pin, k = 3 and the installed build; it is
 *   refused while any case is a draft or any pin isn't an exact model id. Anything else is diagnostic. Admission is one
 *   transaction with a person's proof: no release operation reserved, no deploy draining, the month's ceiling holds the
 *   campaign's worst case, and one campaign of a kind runs at a time.
 * - **Attempts** run as `toolroll evals attempt …`, a child process of the installed binary in its own process group,
 *   with its own world (database, repository, worktrees, dispatch gate). The runner waits for the whole process tree to
 *   be gone, reads the world's database (read only), extracts the built files from verified Git objects, and only then
 *   asks the oracle (eval-oracle.ts).
 * - **Money**: the campaign reserves its worst case against the month (`eval_spend_month`, shared with reviewer
 *   campaigns). Each attempt carves its own worst case (dispatch limit × cap) from the campaign's reservation, never
 *   from the month again; after it, each dispatch settles at its reported API cost (unknown: its full cap) and the
 *   rest of the carve is released. When the campaign ends, what is left of its reservation is released.
 *
 * Result-writing authority is this module's alone: a world never gets a handle on the plane's database.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, realpathSync, rmSync, writeSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
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
import { chatTurnAccounting, runAccounting, Store } from "./store.js";

// Loaded on first use, like the store: a static import prints Node's SQLite warning and can't be bundled.
const sqlite = (): typeof import("node:sqlite") => createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export const EVALS_ROOT = fileURLToPath(new URL("../evals/", import.meta.url));
/** Decision 8: $200 of API dollars a month, reservation-backed (admits one eval campaign at a time). */
export const EVAL_MONTH_CEILING_MICROUSD = 200_000_000;
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
  capMicrousd: number;
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
  const capUsd = typeof raw["capUsd"] === "number" && raw["capUsd"] > 0 && raw["capUsd"] <= 5 ? raw["capUsd"] : null;
  const maxDispatches = whole(raw["maxDispatches"], 1, 10), timeoutMinutes = whole(raw["timeoutMinutes"], 1, 60);
  const validatedBy = raw["validatedBy"] === null ? null : text(raw["validatedBy"], 80);
  if (kind === null || title === null || goal === null || touches === null || capUsd === null || maxDispatches === null || timeoutMinutes === null) return bad("case.json is missing a field or has one out of range");
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
  return { ok: true, value: { id, version: digestOf(files), dir, kind, title, goal, touches, pin: { provider: "claude", model: pin.model }, capMicrousd: Math.round(capUsd * 1_000_000),
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

/** One attempt's worst case: its dispatch limit × its cap. */
export const attemptWorstMicrousd = (one: Pick<EvalCase, "maxDispatches" | "capMicrousd">): number => one.maxDispatches * one.capMicrousd;
/** A campaign's worst case: every attempt, plus its replacements at the dearest case's worst. */
export function campaignWorstMicrousd(plan: CampaignPlan): number {
  const each = plan.cases.map(attemptWorstMicrousd);
  return each.reduce((sum, one) => sum + one * plan.k, 0) + EVAL_MAX_REPLACEMENTS * Math.max(0, ...each);
}

export const monthOf = (now: Date): string => now.toISOString().slice(0, 7);
const usd = (micro: number): string => `$${(micro / 1_000_000).toFixed(2)}`;

export type Admission = { ok: true; id: string } | { ok: false; reason: "person-only" | "release-busy" | "over-ceiling" | "already-running"; message: string };

/**
 * Admit a campaign (eval or reviewer): a person proved now, nothing releasing or deploying, and the month's ceiling
 * holding its worst case on top of everything already reserved and settled. One transaction: the proof, the checks and
 * the reservation, so two campaigns admitted at once can't both pass a ceiling only one fits.
 */
export function admitEvalCampaign(store: Store, input: {
  kind: "eval" | "reviewer"; canonical: boolean; manifestDigest: string; buildDigest: string; version: string; k: number;
  sealed: unknown; reservedMicrousd: number; as: string; token: string; now: Date; id?: string; ceilingMicrousd?: number;
}): Admission {
  if (!Number.isSafeInteger(input.reservedMicrousd) || input.reservedMicrousd < 0) throw new Error("a campaign reserves a whole, non-negative amount");
  const id = input.id ?? `ev-${input.now.toISOString().slice(0, 10).replace(/-/g, "")}-${randomBytes(4).toString("hex")}`;
  const month = monthOf(input.now);
  try {
    return store.transact((): Admission => {
      const proved = authenticateApprover(store, input.as, input.token, null);
      if (!proved.ok || !personProof(proved.method)) return { ok: false, reason: "person-only", message: "Only an approver, proved as a person with their password, starts an eval campaign: it spends money." };
      const busy = store.handle.prepare("SELECT COUNT(*) AS n FROM release_operation WHERE state IN ('reserved','running')").get();
      if (Number(busy?.["n"] ?? 0) > 0 || updateAdmissionPaused(store.handle)) return { ok: false, reason: "release-busy", message: "A release is deploying or merging, so no eval campaign starts now. Try again once it's done." };
      store.handle.prepare("INSERT OR IGNORE INTO eval_spend_month (month, ceiling_microusd) VALUES (?, ?)").run(month, input.ceilingMicrousd ?? EVAL_MONTH_CEILING_MICROUSD);
      const ledger = store.handle.prepare("SELECT ceiling_microusd, reserved_microusd, settled_microusd FROM eval_spend_month WHERE month = ?").get(month)!;
      const ceiling = Number(ledger["ceiling_microusd"]), reserved = Number(ledger["reserved_microusd"]), settled = Number(ledger["settled_microusd"]);
      if (settled + reserved + input.reservedMicrousd > ceiling) {
        return { ok: false, reason: "over-ceiling", message: `This campaign reserves up to ${usd(input.reservedMicrousd)}, and this month's eval spending (${usd(settled)} spent, ${usd(reserved)} reserved) would pass its ${usd(ceiling)} ceiling. Nothing started.` };
      }
      const running = store.handle.prepare("SELECT id FROM eval_campaign WHERE kind = ? AND state = 'running'").get(input.kind);
      if (running !== undefined) return { ok: false, reason: "already-running", message: `Campaign ${String(running["id"])} is still running; one runs at a time.` };
      store.handle.prepare(`INSERT INTO eval_campaign (id, kind, canonical, manifest_digest, build_digest, version, baseline_campaign, k, sealed_json, started_by, started_proof,
          admitted_at, state, month, reserved_microusd) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'running', ?, ?)`)
        .run(id, input.kind, input.canonical ? 1 : 0, input.manifestDigest, input.buildDigest, input.version, input.k, JSON.stringify(input.sealed), input.as, proved.method, input.now.toISOString(), month, input.reservedMicrousd);
      store.handle.prepare("UPDATE eval_spend_month SET reserved_microusd = reserved_microusd + ? WHERE month = ?").run(input.reservedMicrousd, month);
      store.recordAction({ at: input.now.toISOString(), actor: input.as, repo: null, taskId: null, runId: null, action: "eval campaign started", outcome: input.canonical ? "canonical" : "diagnostic", source: "request",
        detail: `${input.kind} campaign ${id}: reserves ${usd(input.reservedMicrousd)} of ${month}'s eval ceiling` });
      return { ok: true, id };
    });
  } catch (error) {
    // The unique running index is the last word on "one at a time" when two admissions race.
    if (/UNIQUE constraint failed: eval_campaign/.test(String((error as Error).message))) return { ok: false, reason: "already-running", message: "Another campaign started at the same moment; one runs at a time." };
    throw error;
  }
}

/** Carve one attempt's worst case from its campaign's reservation (never from the month again) and record the attempt.
 * Refused when the campaign isn't running or its reservation can't hold it. */
export function carveEvalAttempt(store: Store, input: { campaign: string; caseId: string; caseVersion: string; n: number; replaces: number; carveMicrousd: number; modelPinned: string; now: Date }):
  { ok: true; attempt: number } | { ok: false; why: string } {
  return store.transact(() => {
    const campaign = store.handle.prepare("SELECT state, reserved_microusd, carved_microusd FROM eval_campaign WHERE id = ?").get(input.campaign);
    if (campaign === undefined || campaign["state"] !== "running") return { ok: false as const, why: "the campaign isn't running" };
    if (Number(campaign["carved_microusd"]) + input.carveMicrousd > Number(campaign["reserved_microusd"])) return { ok: false as const, why: "the campaign's reservation is used up" };
    store.handle.prepare("UPDATE eval_campaign SET carved_microusd = carved_microusd + ? WHERE id = ?").run(input.carveMicrousd, input.campaign);
    const made = store.handle.prepare("INSERT INTO eval_attempt (campaign, case_id, case_version, n, replaces, model_pinned, carved_microusd, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(input.campaign, input.caseId, input.caseVersion, input.n, input.replaces, input.modelPinned, input.carveMicrousd, input.now.toISOString());
    return { ok: true as const, attempt: Number(made.lastInsertRowid) };
  });
}

export type EvalOutcome = "pass" | "fail" | "error" | "unevaluated";
export type InvocationSettlement = { kind: string; worldRef: string; reservedMicrousd: number; settledMicrousd: number; unknown: boolean };
export type AttemptResult = {
  outcome: EvalOutcome; why: string | null; modelReported: string | null;
  apiMicrousd: number | null; subscriptionMicrousd: number | null; usageUnknown: boolean;
  turns: number | null; tokensIn: number | null; cacheRead: number | null; cacheWrite: number | null; tokensOut: number | null; toolCalls: number | null;
  wallMs: number; invocations: InvocationSettlement[];
};

/** Settle a finished attempt, once: its dispatches against the campaign's reservation (each at its reported API cost,
 * unknown at its full cap), the month's settled dollars, and the release of the rest of its carve. */
export function settleEvalAttempt(store: Store, attempt: number, result: AttemptResult, now: Date): void {
  store.transact(() => {
    const row = store.handle.prepare("SELECT a.campaign, a.carved_microusd, a.outcome, c.month FROM eval_attempt a JOIN eval_campaign c ON c.id = a.campaign WHERE a.id = ?").get(attempt);
    if (row === undefined) throw new Error(`no eval attempt ${attempt}`);
    if (row["outcome"] !== null) return;
    const settled = result.invocations.reduce((sum, one) => sum + one.settledMicrousd, 0);
    for (const one of result.invocations) {
      store.handle.prepare("INSERT INTO eval_invocation (attempt, kind, world_ref, reserved_microusd, settled_microusd, unknown) VALUES (?, ?, ?, ?, ?, ?)")
        .run(attempt, one.kind.slice(0, 40), one.worldRef.slice(0, 80), one.reservedMicrousd, one.settledMicrousd, one.unknown ? 1 : 0);
    }
    store.handle.prepare(`UPDATE eval_attempt SET outcome = ?, error_why = ?, model_reported = ?, api_microusd = ?, subscription_microusd = ?, usage_unknown = ?, turns = ?, tokens_in = ?,
        cache_read = ?, cache_write = ?, tokens_out = ?, tool_calls = ?, wall_ms = ?, finished_at = ? WHERE id = ?`)
      .run(result.outcome, result.why === null ? null : result.why.slice(0, 500), result.modelReported, result.apiMicrousd, result.subscriptionMicrousd, result.usageUnknown ? 1 : 0, result.turns,
        result.tokensIn, result.cacheRead, result.cacheWrite, result.tokensOut, result.toolCalls, result.wallMs, now.toISOString(), attempt);
    store.handle.prepare("UPDATE eval_campaign SET settled_microusd = settled_microusd + ? WHERE id = ?").run(settled, row["campaign"] as string);
    // The carve leaves the month's reservation as its dispatches settle into the month's spending.
    store.handle.prepare("UPDATE eval_spend_month SET reserved_microusd = MAX(0, reserved_microusd - ?), settled_microusd = settled_microusd + ? WHERE month = ?")
      .run(Number(row["carved_microusd"]), settled, row["month"] as string);
  });
}

/** End a campaign, once: complete or incomplete, and what is left of its reservation released from the month. */
export function finishEvalCampaign(store: Store, id: string, state: "complete" | "incomplete", why: string | null, now: Date): void {
  store.transact(() => {
    const row = store.handle.prepare("SELECT state, month, reserved_microusd, carved_microusd, released FROM eval_campaign WHERE id = ?").get(id);
    if (row === undefined || row["state"] !== "running") return;
    const left = Number(row["reserved_microusd"]) - Number(row["carved_microusd"]);
    store.handle.prepare("UPDATE eval_campaign SET state = ?, why = ?, finished_at = ?, released = 1 WHERE id = ?").run(state, why, now.toISOString(), id);
    if (Number(row["released"]) === 0) store.handle.prepare("UPDATE eval_spend_month SET reserved_microusd = MAX(0, reserved_microusd - ?) WHERE month = ?").run(left, row["month"] as string);
  });
}

// ------------------------------------------------------------------ collecting a world

export type WorldDispatches = { invocations: InvocationSettlement[]; modelReported: string | null; overLimit: boolean; ungated: boolean;
  apiMicrousd: number | null; subscriptionMicrousd: number | null; usageUnknown: boolean;
  turns: number | null; tokensIn: number | null; cacheRead: number | null; cacheWrite: number | null; tokensOut: number | null };

const noDispatches = (): WorldDispatches => ({ invocations: [], modelReported: null, overLimit: false, ungated: false, apiMicrousd: 0, subscriptionMicrousd: 0, usageUnknown: false,
  turns: null, tokensIn: null, cacheRead: null, cacheWrite: null, tokensOut: null });
const sum = (values: (number | null)[]): number | null => values.some(one => one === null) ? null : values.reduce<number>((total, one) => total + (one as number), 0);

/** Every provider dispatch a world made, from its own database (opened read only) and its gate's slots: each settled
 * at its reported API cost, subscription usage kept apart (0 API dollars), unknown at the full cap. A dispatch the
 * database shows with no slot (the gate was bypassed: `ungated`) and a slot no record accounts for (a lead request that
 * left no row) both settle at the cap. */
export function collectWorld(world: Store, gateDir: string, one: Pick<EvalCase, "maxDispatches" | "capMicrousd">): WorldDispatches {
  const cap = one.capMicrousd;
  const slots = evalGateSlots(gateDir);
  const runs = world.handle.prepare("SELECT id, role FROM run WHERE provider_started_at IS NOT NULL ORDER BY id").all().map(row => ({ id: Number(row["id"]), role: String(row["role"]) }));
  const turns = world.handle.prepare("SELECT id FROM chat_turn WHERE state IN ('running','answered','failed') ORDER BY id").all().map(row => Number(row["id"]));
  const invocations: InvocationSettlement[] = [];
  const models: (string | null)[] = [];
  const api: (number | null)[] = [], subscription: (number | null)[] = [], providerTurns: (number | null)[] = [];
  const tokensIn: (number | null)[] = [], cacheRead: (number | null)[] = [], cacheWrite: (number | null)[] = [], tokensOut: (number | null)[] = [];
  let usageUnknown = slots === null;
  const settle = (kind: string, worldRef: string, amount: ReportedAmount) => {
    if (amount.kind === "unknown") usageUnknown = true;
    api.push(amount.kind === "api" ? amount.microusd : amount.kind === "subscription" ? 0 : null);
    subscription.push(amount.kind === "subscription" ? (amount.reportedUsd === null ? null : Math.round(amount.reportedUsd * 1_000_000)) : amount.kind === "api" ? 0 : null);
    invocations.push({ kind, worldRef, reservedMicrousd: cap, settledMicrousd: amount.kind === "api" ? amount.microusd : amount.kind === "unknown" ? cap : 0, unknown: amount.kind === "unknown" });
  };
  for (const run of runs) {
    const read = runAccounting(world, run.id);
    settle(run.role, `run:${run.id}`, read?.amount ?? { kind: "unknown" });
    models.push(read?.modelReported ?? null);
    providerTurns.push(read?.agentTurns ?? null); tokensIn.push(read?.usage.in ?? null); cacheRead.push(read?.usage.cacheRead ?? null); cacheWrite.push(read?.usage.cacheWrite ?? null); tokensOut.push(read?.usage.out ?? null);
  }
  for (const id of turns) {
    const read = chatTurnAccounting(world, id);
    settle("lead", `chat_turn:${id}`, read?.amount ?? { kind: "unknown" });
    models.push(read?.modelReported ?? null);
    providerTurns.push(read?.providerTurns ?? null); tokensIn.push(read?.tokensIn ?? null); cacheRead.push(read?.cacheReadTokens ?? null); cacheWrite.push(read?.cacheWriteTokens ?? null); tokensOut.push(read?.tokensOut ?? null);
  }
  const runSlots = new Set((slots ?? []).filter(slot => slot.kind.startsWith("run:")).map(slot => slot.kind));
  const chatSlots = (slots ?? []).filter(slot => !slot.kind.startsWith("run:"));
  // Unreadable slots: every recorded dispatch counts as ungated.
  const ungated = slots === null ? runs.length + turns.length > 0 : runs.some(run => !runSlots.has(`run:${run.id}`)) || turns.length > chatSlots.length;
  // A run slot whose run never reached its provider spent nothing; a run slot with no run at all, or a chat slot past
  // the recorded chat requests, may have been sent: the cap.
  for (const slot of slots ?? []) {
    if (slot.kind.startsWith("run:")) {
      const id = Number(slot.kind.slice(4));
      if (Number.isSafeInteger(id) && world.handle.prepare("SELECT 1 FROM run WHERE id = ?").get(id) !== undefined) continue;
      settle("unrecorded", `slot:${slot.n}`, { kind: "unknown" });
    }
  }
  for (const slot of chatSlots.slice(turns.length)) settle("unrecorded", `slot:${slot.n}`, { kind: "unknown" });
  const dispatches = Math.max(invocations.length, slots?.length ?? 0);
  let modelReported: string | null = null;
  for (const [index, model] of models.entries()) modelReported = index === 0 ? model : combineReportedModels(modelReported, model);
  return { invocations, modelReported: models.length === 0 ? null : modelReported, overLimit: dispatches > one.maxDispatches || evalGateOverLimit(gateDir), ungated,
    apiMicrousd: usageUnknown ? null : sum(api), subscriptionMicrousd: sum(subscription), usageUnknown,
    turns: sum(providerTurns), tokensIn: sum(tokensIn), cacheRead: sum(cacheRead), cacheWrite: sum(cacheWrite), tokensOut: sum(tokensOut) };
}

// ------------------------------------------------------------------ one attempt

/** The installed build's identity: its version and a digest of every file of the code that is running (dist when
 * installed, the sources in a checkout). A change between attempts stops the campaign as incomplete. */
export function installedBuildDigest(version: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const files = folderFilesDeep(here);
  return sha256(`${version}\0${files}`);
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

/** Run the child and wait for its whole process tree: the child's exit, its process group gone, and every descendant
 * the process-tree observer saw gone. A tree that won't end is stopped and reported, never graded. */
async function runWorldProcess(spec: { file: string; args: string[]; env: Record<string, string> }, cwd: string, timeoutMs: number, settleMs: number):
  Promise<{ timedOut: boolean; report: ChildReport; lingering: boolean; code: number | null }> {
  const child: ChildProcess = spawn(spec.file, spec.args, { cwd, env: spec.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const seen = new Map<number, boolean>();
  observeProcessTree(child, { onDescendant: (pid, group) => { seen.set(pid, group); }, onDescendantExit: pid => { seen.delete(pid); } });
  let stdout = "";
  child.stdout?.on("data", (chunk: Buffer) => { if (stdout.length < 64 * 1024) stdout += chunk.toString("utf8"); });
  child.stderr?.on("data", () => undefined);
  const pgid = child.pid ?? -1;
  let timedOut = false;
  const code = await new Promise<number | null>(done => {
    const timer = setTimeout(() => {
      timedOut = true;
      stopProcessTree(child);
      try { process.kill(-pgid, "SIGKILL"); } catch { /* gone */ }
    }, timeoutMs);
    child.once("error", () => { clearTimeout(timer); done(null); });
    child.once("close", exit => { clearTimeout(timer); done(exit); });
  });
  const gone = (): boolean => pgid > 0 && !processMayBeAlive(pgid, true) && [...seen.keys()].every(pid => !processMayBeAlive(pid, false));
  const until = Date.now() + settleMs;
  while (!gone() && Date.now() < until) await new Promise(done => setTimeout(done, 50));
  let lingering = false;
  if (!gone()) {
    lingering = true;
    // Its own world's processes only: the child's group and the descendants observed under it.
    try { process.kill(-pgid, "SIGKILL"); } catch { /* gone */ }
    for (const pid of seen.keys()) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    const last = Date.now() + 5_000;
    while (!gone() && Date.now() < last) await new Promise(done => setTimeout(done, 50));
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
  return { timedOut, report, lingering, code };
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

/**
 * One attempt: carve, make the world, run its child to the end of its whole process tree, read what it did, grade it,
 * settle. Outcomes (plan, "Grading"): an error only where the plane itself recorded one (the world failed before the
 * agent started, the provider refused or was down, the oracle failed, the world's processes wouldn't end); the agent
 * timing out, crashing or going past its dispatch limit is a fail; a reported model other than the pin is unevaluated.
 */
export async function runEvalAttempt(store: Store, input: { campaign: string; one: EvalCase; n: number; replaces: number }, deps: AttemptDeps): Promise<{ attempt: number; result: AttemptResult } | { attempt: null; why: string }> {
  const now = deps.now ?? (() => new Date());
  const { one } = input;
  const carved = carveEvalAttempt(store, { campaign: input.campaign, caseId: one.id, caseVersion: one.version, n: input.n, replaces: input.replaces, carveMicrousd: attemptWorstMicrousd(one), modelPinned: one.pin.model, now: now() });
  if (!carved.ok) return { attempt: null, why: carved.why };
  const started = Date.now();
  mkdirSync(deps.workRoot, { recursive: true, mode: 0o700 });
  const worldDir = realpathSync(mkdtempSync(join(deps.workRoot, `${one.id}-${input.n}-`)));
  // The world's state folder is named as Toolroll's own, so every agent fence in the world denies it whole: the
  // database, the worker's token and the dispatch gate (agent-fence.ts agentFence, a dedicated state folder).
  const stateDir = join(worldDir, "toolroll"), gateDir = join(stateDir, "eval-gate");
  mkdirSync(stateDir, { mode: 0o700 });
  mkdirSync(gateDir, { mode: 0o700 });
  openEvalGate(gateDir, { v: 1, max: one.maxDispatches, capMicrousd: one.capMicrousd });
  const databaseFile = join(stateDir, "orders.db");
  const empty = (outcome: EvalOutcome, why: string | null, collected?: WorldDispatches): AttemptResult => ({
    outcome, why, modelReported: collected?.modelReported ?? null,
    // No world to read: nothing was dispatched. A world's unknown stays unknown (null), never 0.
    apiMicrousd: collected === undefined ? 0 : collected.apiMicrousd, subscriptionMicrousd: collected === undefined ? 0 : collected.subscriptionMicrousd, usageUnknown: collected?.usageUnknown ?? false,
    turns: collected?.turns ?? null, tokensIn: collected?.tokensIn ?? null, cacheRead: collected?.cacheRead ?? null, cacheWrite: collected?.cacheWrite ?? null, tokensOut: collected?.tokensOut ?? null,
    toolCalls: null, wallMs: Date.now() - started, invocations: collected?.invocations ?? [] });
  let result: AttemptResult;
  try {
    const spec = deps.command({ campaign: input.campaign, caseId: one.id, n: input.n, worldDir, databaseFile, gateDir });
    const ran = await runWorldProcess({ ...spec, env: { ...spec.env, [EVAL_GATE_ENV]: gateDir } }, worldDir, one.timeoutMinutes * 60_000, deps.settleMs ?? 30_000);
    deps.onTreeGone?.();
    if (ran.lingering) {
      result = empty("error", "the world's processes didn't end after its attempt, so it wasn't graded");
    } else {
      // The world's own records, read only. No database: the world never started.
      let world: Store | null = null;
      try { world = new Store(new (sqlite().DatabaseSync)(databaseFile, { readOnly: true })); } catch { world = null; }
      try {
        // No database to read: whatever took a slot is settled at its cap all the same.
        const slots = world === null ? evalGateSlots(gateDir) : null;
        const collected = world === null
          ? (slots === null || slots.length > 0 ? { ...noDispatches(), usageUnknown: true, apiMicrousd: null, subscriptionMicrousd: null,
            invocations: (slots ?? [{ n: 0, kind: "unreadable" }]).map(slot => ({ kind: "unrecorded", worldRef: `slot:${slot.n}`, reservedMicrousd: one.capMicrousd, settledMicrousd: one.capMicrousd, unknown: true })) } : null)
          : collectWorld(world, gateDir, one);
        const started_ = world === null ? 0 : Number(world.handle.prepare("SELECT COUNT(*) AS n FROM run WHERE provider_started_at IS NOT NULL").get()?.["n"] ?? 0);
        const refused = world === null ? 0 : Number(world.handle.prepare("SELECT COUNT(*) AS n FROM run WHERE outcome = 'refused' AND provider_started_at IS NULL").get()?.["n"] ?? 0);
        const chats = collected === null ? 0 : collected.invocations.filter(inv => !inv.worldRef.startsWith("run:")).length;
        if (world === null) {
          // The world's own records were never made or can't be read: the world failed, not the agent.
          result = empty("error", ran.report?.stage === "world-start" ? `the world failed before the agent started: ${ran.report.why ?? "no reason given"}` : "the world's records can't be read", collected ?? undefined);
        } else if (collected === null || (started_ === 0 && chats === 0)) {
          // Nothing reached a provider: the world failed before the agent started (its child said so), or the provider
          // refused (a plane-side record); anything else is the agent's (a fail).
          const why = ran.report?.stage === "world-start" ? `the world failed before the agent started: ${ran.report.why ?? "no reason given"}`
            : refused > 0 ? "the provider refused or was unavailable before the agent started" : null;
          result = why !== null ? empty("error", why, collected ?? undefined) : empty("fail", ran.timedOut ? "timed out before the agent started" : "the agent never started", collected ?? undefined);
        } else if (collected.ungated) {
          result = empty("error", "a provider dispatch ran without the eval gate; its cost is counted at the cap", collected);
        } else if (collected.overLimit) {
          result = empty("fail", `it went past its limit of ${one.maxDispatches} provider dispatches`, collected);
        } else if (ran.timedOut) {
          result = empty("fail", `it ran past its ${one.timeoutMinutes}-minute limit`, collected);
        } else if (collected.modelReported !== one.pin.model) {
          result = empty("unevaluated", `the provider reported ${collected.modelReported ?? "no model"}, not the pinned ${one.pin.model}`, collected);
        } else {
          const planeState = store.databaseFile();
          const graded = await grade(world!, worldDir, one, deps, planeState === null ? [] : [dirname(planeState)]);
          result = empty(graded.outcome, graded.why, collected);
        }
      } finally { world?.close(); }
    }
  } catch (error) {
    result = empty("error", `the eval runner failed: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
  } finally {
    if (deps.keepWorlds !== true) rmSync(worldDir, { recursive: true, force: true });
  }
  settleEvalAttempt(store, carved.attempt, result, now());
  return { attempt: carved.attempt, result };
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
  /** The installed build's digest now (installedBuildDigest): a change stops the campaign as incomplete. */
  buildDigest: () => string;
  /** The installed eval set now (loadEvalSet): a change stops the campaign as incomplete too. */
  evalSet?: () => EvalSet;
  concurrency?: number;
};

/** Run an admitted campaign to its end: every sealed attempt (EVAL_CONCURRENCY at once), one replacement for an
 * attempt the plane recorded an error for (at most EVAL_MAX_REPLACEMENTS a campaign), then complete — or incomplete
 * when the installed build changed or an attempt couldn't be carved. */
export async function runEvalCampaign(store: Store, campaign: string, cases: readonly EvalCase[], deps: CampaignDeps): Promise<{ state: "complete" | "incomplete"; why: string | null }> {
  const now = deps.now ?? (() => new Date());
  const row = store.handle.prepare("SELECT k, build_digest, manifest_digest, state FROM eval_campaign WHERE id = ?").get(campaign);
  if (row === undefined || row["state"] !== "running") throw new Error(`campaign ${campaign} isn't running`);
  const k = Number(row["k"]), sealedBuild = String(row["build_digest"]), sealedSet = String(row["manifest_digest"]);
  const setNow = (): string | null => { const set = (deps.evalSet ?? loadEvalSet)(); return set.ok ? set.manifestDigest : null; };
  let stop: string | null = null;
  let replacements = 0;
  const gate = limiter(deps.concurrency ?? EVAL_CONCURRENCY);
  const attempt = async (one: EvalCase, n: number, replaces: number): Promise<void> => {
    if (stop !== null) return;
    if (deps.buildDigest() !== sealedBuild) { stop = "the installed build changed during the campaign"; return; }
    if (setNow() !== sealedSet) { stop = "the installed eval set changed during the campaign"; return; }
    const ran = await runEvalAttempt(store, { campaign, one, n, replaces }, deps);
    if (ran.attempt === null) { stop ??= ran.why; return; }
    if (ran.result.outcome === "error" && replacements < EVAL_MAX_REPLACEMENTS && replaces === 0) {
      replacements++;
      await attempt(one, n, ran.attempt);
    }
  };
  await Promise.all(cases.flatMap(one => Array.from({ length: k }, (_, index) => gate(() => attempt(one, index + 1, 0)))));
  const state = stop === null ? "complete" as const : "incomplete" as const;
  finishEvalCampaign(store, campaign, state, stop, now());
  return { state, why: stop };
}

/** A random hex id, for the world's throwaway approver password. */
export const worldSecret = (): string => randomBytes(24).toString("hex");
