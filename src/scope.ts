// The rubric's vocabulary loads before anything that reaches the plan contract (see contracts/acceptance-terms.ts).
export { ACCEPTANCE_LIMITS, EVIDENCE_KINDS, type EvidenceKind } from "./contracts/acceptance-terms.js";
import { currentPasswordSource, passwordGuardOf, provenPasswordAccount } from "./sign-in-guard.js";
import { validateScopeText } from "./task-text.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { projectAuthority } from "./project-access.js";
import { activeRemote } from "./remote-run.js";
import { claimActor, currentActor, parseLeadToken } from "./actor.js";
/**
 * What a task is allowed to become, agreed before anything builds it.
 *
 * The gap this closes is the one an operator notices immediately and a
 * scheduler never does: a task called "fix the payouts flow" is a sentence, and
 * an agent handed it at 3am will decide for itself what that means. It might
 * mean a two-line guard. It might mean rewriting the billing model. Nobody
 * agreed to the second one, and by morning it is a diff.
 *
 * So a scope is written down, and a human opts in to it, and the builder will
 * not run on a task where that has not happened. Not a code review after the
 * fact — an agreement about the goal, before the work.
 *
 * **Approval binds to the words that were approved.** The record keeps a digest
 * of the scope text, and approval stores the digest it saw. Rewriting the scope
 * afterwards does not carry the approval with it; the digests stop matching and
 * the task is unapproved again. Without that, "approved" would mean "was
 * approved once, in some form" — which is exactly the loophole an agent editing
 * its own brief would walk through.
 *
 * The scope is deliberately three plain fields rather than a template. What is
 * the goal, what is explicitly not in it, and which paths it expects to touch.
 * An operator reading that at a glance can tell whether they agree, and that
 * glance is the whole safety property.
 */

import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { type EvidenceKind } from "./contracts/acceptance-terms.js";
import { parseContract } from "./contracts/contract.js";
import { readAcceptance, readScopeTerms, storedRubricSchema, type AcceptanceCriterion, type AcceptanceProblem, type ScopeTerms } from "./contracts/scope.js";
import type { Store, Mutation } from "./store.js";
import type { QualityMode } from "./quality.js";
import type { AuthMode } from "./keys.js";
import type { ProviderId } from "./provider.js";
import {
  NO_READINESS,
  exactModelId,
  legOf,
  projectRoute,
  routeDigestOf,
  routeFromJson,
  routeJsonProblem,
  routeWords,
  type PhaseRoute,
  type ReadinessLookup,
  type RiskLevel,
} from "./phase-routing.js";

/** Same shape as a runner's credential, for the same reasons. */
function mintToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * A person's chosen password gets a real KDF. Bare sha256 is fine for the
 * minted 256-bit tokens — nothing brute-forces that space — but a password a
 * human picked lives in a much smaller one, so it is salted and stretched
 * (scrypt), and the stored string names its own scheme so both generations
 * of credential verify side by side.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

/** Verify a presented secret against a stored hash of either scheme. */
export function verifyCredential(stored: string, presented: string): boolean {
  // v100: an account that signs in only with the identity provider has no password to match.
  if (stored.startsWith("sso-only$")) return false;
  if (stored.startsWith("scrypt$")) {
    const [, salt, hex] = stored.split("$");
    if (salt === undefined || hex === undefined) return false;
    const known = Buffer.from(hex, "hex");
    const candidate = scryptSync(presented, salt, 32);
    return known.length === candidate.length && timingSafeEqual(known, candidate);
  }
  return sameDigest(stored, hashToken(presented));
}

function sameDigest(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The execution profile (Parity II foundations, findings 1/2/13/14/22):
 * WHAT RUNS, bound into what the operator signs. A discriminated union —
 * each variant asserts only what its provider actually supports, with the
 * EFFECTIVE constants the argv will carry, never aspirations. The model
 * is always an exact string and always emitted on the argv: nothing in an
 * approved profile is left for later resolution to decide (ruling 10).
 * providerVersion and resolvedFrom are PROVENANCE and live outside these
 * shapes (finding 20) — they never enter a digest.
 */
export const CLAUDE_LIMITS = {
  // The activity watchdog is the real safety rail. Keep a very high turn
  // breaker only for a pathological loop; ordinary long-horizon work should
  // finish, checkpoint, or park long before it can reach this number.
  maxTurns: 1_000,
  repairMaxTurns: 4,
  timeoutSeconds: 1_200,
  repairTimeoutSeconds: 300,
} as const;
export const CODEX_SHAPED_LIMITS = {
  timeoutSeconds: 1200,
  repairTimeoutSeconds: 300,
} as const;
export const GEMINI_LIMITS = {
  timeoutSeconds: 1200,
  repairTimeoutSeconds: 300,
} as const;

export type ClaudeProfile = {
  provider: "claude";
  /** The exact model string the argv carries. Never empty, never "default". */
  model: string;
  /** Claude's real argv semantic. `auto` is the safe unattended posture:
   * Claude's classifier allows routine project work and stops risky acts.
   * `acceptEdits` remains readable for approvals created before auto mode;
   * bypass is still a separate, explicitly signed escalation. */
  permissionArgv: "auto" | "acceptEdits" | "bypassPermissions";
  maxTurns: number;
  repairMaxTurns: number;
  timeoutSeconds: number;
  /** Absent on legacy approvals, where timeoutSeconds remains an absolute
   * wall clock. New approvals bind an activity watchdog instead. */
  timeoutKind?: "idle";
  repairTimeoutSeconds: number;
  /** Exact model for repairs, or the stable literal "inherit" (= the
   * build model, which is itself exact). */
  repairModel: string;
};

export type CodexShapedProfile = {
  provider: "codex" | "openrouter";
  model: string;
  /** Codex's real constraint surface. Full access is rendered with the
   * CLI's combined --dangerously-bypass-approvals-and-sandbox switch; the
   * value here records the resulting sandbox posture in the signed profile. */
  sandboxMode: "workspace-write" | "danger-full-access";
  /** The tool has no argv turn limit. New approvals use an inactivity
   * watchdog; legacy approvals retain their signed wall-clock bound. */
  maxTurns: "unsupported";
  repairMaxTurns: "unsupported";
  timeoutSeconds: number;
  timeoutKind?: "idle";
  repairTimeoutSeconds: number;
  repairModel: string;
};

export type GeminiProfile = {
  provider: "gemini";
  model: string;
  /** Gemini's real dial (`--approval-mode`): auto_edit auto-approves edit
   * tools only (the acceptEdits parallel); yolo auto-approves everything
   * and files only where claude files bypassPermissions. `default` and
   * `plan` are not profile values — headless `default` just fails tools,
   * and `plan` is read-only while the protocol requires workspace writes. */
  approvalArgv: "auto_edit" | "yolo";
  /** No argv turn bound exists (v0.57.0 audit); new approvals use an
   * inactivity watchdog, while legacy approvals keep their signed clock. */
  maxTurns: "unsupported";
  repairMaxTurns: "unsupported";
  timeoutSeconds: number;
  timeoutKind?: "idle";
  repairTimeoutSeconds: number;
  repairModel: string;
};

export type ExecutionProfile = ClaudeProfile | CodexShapedProfile | GeminiProfile;

/** The durable unattended permission choices exposed by the console. The
 * provider-specific argv is still what gets sealed into an approval; this
 * small cross-provider type is only the operator-facing policy. */
export type UnattendedPermissionMode = "auto" | "bypassPermissions";

export const PROFILE_DIGEST_VERSION = 2;

/** Deterministic JSON: object keys sorted recursively, arrays in order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The stored snapshot bytes: version embedded IN the snapshot (finding 17). */
export function canonicalProfileJson(profile: ExecutionProfile): string {
  return canonicalJson({ digestVersion: PROFILE_DIGEST_VERSION, profile });
}

/** sha256 over a domain-separated canonical encoding, truncated to the
 * same 128 bits every other safety digest here uses (finding 21). */
export function profileDigestOf(profile: ExecutionProfile): string {
  return createHash("sha256")
    .update(`standing-orders:profile:${canonicalProfileJson(profile)}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

// ---- fallback chains (v30-v114; removed in v115) --------------------------
// History only: an approval sealed over a fallback chain still decodes and
// its digest still re-derives, so old tasks verify and render. Nothing
// files, seals, or dispatches a chain any more.
export const CHAIN_DIGEST_VERSION = 1;

/** One entry of an approved fallback chain: the WHOLE execution profile
 * (so a claude->codex switch cannot inherit one provider's repair config)
 * and the auth mode it runs under. Order is authority. */
export type ChainEntry = {
  profile: ExecutionProfile;
  authMode: "subscription" | "api-key";
};

/** The stored snapshot bytes for a chain: the version rides IN the
 * snapshot, exactly like a single profile's. */
export function canonicalChainJson(entries: readonly ChainEntry[]): string {
  return canonicalJson({ digestVersion: CHAIN_DIGEST_VERSION, chain: entries });
}

/** sha256 over a domain-separated canonical chain encoding — a DIFFERENT
 * domain from a single profile ("standing-orders:chain:" vs
 * ":profile:"), so a chain digest can never collide with a profile
 * digest, truncated to the same 128 bits. */
export function chainDigestOf(entries: readonly ChainEntry[]): string {
  return createHash("sha256")
    .update(`standing-orders:chain:v${CHAIN_DIGEST_VERSION}:${canonicalChainJson(entries)}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

/** Strict re-hydration of a stored chain — every entry proved through the
 * single-profile rehydrator; anything unexpected is null. */
export function chainFromJson(json: string | null): ChainEntry[] | null {
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const wrapper = parsed as { digestVersion?: unknown; chain?: unknown };
  if (wrapper.digestVersion !== CHAIN_DIGEST_VERSION) return null;
  // Exact keys on the wrapper and on every entry (v48 integrity): a
  // snapshot carrying anything this code never writes is not one it wrote.
  if (!exactKeys(wrapper, ["digestVersion", "chain"], [])) return null;
  if (!Array.isArray(wrapper.chain) || wrapper.chain.length === 0 || wrapper.chain.length > 4) return null;
  const entries: ChainEntry[] = [];
  const seen = new Set<string>();
  for (const raw of wrapper.chain) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const e = raw as { profile?: unknown; authMode?: unknown };
    if (!exactKeys(e, ["profile", "authMode"], [])) return null;
    // A malformed auth mode is a malformed entry — never a default.
    if (e.authMode !== "subscription" && e.authMode !== "api-key") return null;
    if (e.profile === null || typeof e.profile !== "object" || Array.isArray(e.profile)) return null;
    // The profile rehydrates through the SAME strict path, wrapped as its
    // own canonical snapshot so profileFromJson can prove it — and the
    // canonical bytes must be the stored bytes' own keys (canonicalJson
    // drops nothing, so an extra key survives into the strict parse).
    const profile = profileFromJson(canonicalProfileJson(e.profile as ExecutionProfile));
    if (profile === null) return null;
    // Duplicate exact entries are rejected (open q i): the key is the
    // profile digest + auth mode.
    const key = `${profileDigestOf(profile)}:${e.authMode}`;
    if (seen.has(key)) return null;
    seen.add(key);
    entries.push({ profile, authMode: e.authMode });
  }
  return entries;
}

/**
 * THE STRICT RAW TERMS READ (raw authority repair): the stored columns of
 * a scope or a standing order, proved EXACTLY — a JSON list is a list of
 * strings and nothing else, a rubric is a list of whole criteria carrying
 * exactly the keys this code writes and parsing with zero problems, a
 * budget is a safe integer or null. Nothing is filtered, defaulted, or
 * coerced on the way to an authority: the words say what is wrong, and
 * the caller refuses.
 */
export function exactStringList(value: unknown, what: string): { ok: true; list: string[] } | { ok: false; problem: string } {
  if (typeof value !== "string") return { ok: false, problem: `${what} is not stored as text` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { ok: false, problem: `${what} is not valid JSON` };
  }
  if (!Array.isArray(parsed)) return { ok: false, problem: `${what} is not a JSON list` };
  if (!parsed.every(one => typeof one === "string")) return { ok: false, problem: `${what} carries an entry that is not a string` };
  return { ok: true, list: parsed as string[] };
}

export function exactAcceptance(value: unknown): { ok: true; criteria: AcceptanceCriterion[] } | { ok: false; problem: string } {
  if (value === null || value === undefined) return { ok: true, criteria: [] };
  if (typeof value !== "string") return { ok: false, problem: "the rubric is not stored as text" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { ok: false, problem: "the rubric is not valid JSON" };
  }
  if (!Array.isArray(parsed)) return { ok: false, problem: "the rubric is not a JSON list" };
  // Stored, a criterion carries exactly the keys this code writes: the saved rubric schema is strict about them.
  const strict = parseContract(z.object({ acceptance: storedRubricSchema }), { acceptance: parsed });
  for (const issue of strict.ok ? [] : strict.issues) {
    const entry = /^acceptance\[(\d+)\]$/.exec(issue.path);
    if (entry === null) continue;
    if (issue.kind === "wrong-type" || issue.kind === "required") return { ok: false, problem: `rubric entry ${Number(entry[1]) + 1} is not an object` };
    if (issue.kind === "unknown-key") return { ok: false, problem: `rubric entry ${Number(entry[1]) + 1} carries a key this code never writes` };
  }
  const read = readAcceptance(parsed);
  if (read.problems.length > 0) return { ok: false, problem: `the rubric does not parse: ${read.problems.map(one => one.message).join("; ")}` };
  return { ok: true, criteria: read.criteria };
}

export function exactSafeIntegerOrNull(value: unknown, what: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return `${what} is not a safe integer`;
  return null;
}

/**
 * The longest clock a snapshot may bind, in seconds: a JavaScript timer
 * holds at most 2^31 − 1 milliseconds, and a bound past that fires at
 * once instead of never — a "timeout" that is not one. Every stored
 * clock is proved against this before it is believed (v48 integrity).
 */
export const MAX_TIMER_SECONDS = Math.floor(2_147_483_647 / 1000);

/** A positive integer the platform can represent exactly. */
export function safePositiveInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

/** A positive whole number of seconds a timer can actually wait. */
export function timerSafeSeconds(v: unknown): v is number {
  return safePositiveInteger(v) && v <= MAX_TIMER_SECONDS;
}

/**
 * Whether an object carries exactly the named keys: every required key
 * present, only optional keys otherwise, nothing unknown. Stored snapshots
 * are proved this way so a key this code never writes is a refusal, never
 * an ignorable extra.
 */
export function exactKeys(value: object, required: readonly string[], optional: readonly string[]): boolean {
  const keys = Object.keys(value);
  if (required.some(key => !keys.includes(key))) return false;
  return keys.every(key => required.includes(key) || optional.includes(key));
}

/** Strict re-hydration of a stored snapshot — every field type-proved;
 * anything unexpected is null, never a guess. */
export function profileFromJson(json: string | null): ExecutionProfile | null {
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const wrapper = parsed as { digestVersion?: unknown; profile?: unknown };
  if (wrapper.digestVersion !== PROFILE_DIGEST_VERSION) return null;
  // EXACT KEYS (v48 integrity): the wrapper carries the version and the
  // profile and nothing else, and the profile carries exactly its
  // provider's fields — a snapshot with a key this code never writes was
  // not written by this code and rehydrates as nothing, never as "the
  // known part of it".
  if (!exactKeys(wrapper, ["digestVersion", "profile"], [])) return null;
  const p = wrapper.profile as Record<string, unknown> | null | undefined;
  if (p === null || p === undefined || typeof p !== "object" || Array.isArray(p)) return null;
  // STRICT fields (v48 authority repair): a model is an exact id (the same shape every
  // provider argv accepts), a repair model is `inherit` or an exact id, a
  // turn bound is a positive SAFE integer, and a clock is a positive whole
  // number of seconds a timer can actually hold — a snapshot carrying
  // anything else (a negative turn count, a fractional second, a model
  // that is not an id, a clock past what setTimeout can wait) was not
  // written by this code and rehydrates as nothing.
  const str = (v: unknown): v is string => exactModelId(v);
  const repairRef = (v: unknown): v is string => v === "inherit" || exactModelId(v);
  const num = (v: unknown): v is number => safePositiveInteger(v);
  const clock = (v: unknown): v is number => timerSafeSeconds(v);
  const PROVIDER_KEYS = ["provider", "model", "maxTurns", "repairMaxTurns", "timeoutSeconds", "repairTimeoutSeconds", "repairModel"] as const;
  if (p["provider"] === "claude") {
    if (
      exactKeys(p, [...PROVIDER_KEYS, "permissionArgv"], ["timeoutKind"]) &&
      str(p["model"]) &&
      (p["permissionArgv"] === "auto" || p["permissionArgv"] === "acceptEdits" || p["permissionArgv"] === "bypassPermissions") &&
      num(p["maxTurns"]) && num(p["repairMaxTurns"]) &&
      clock(p["timeoutSeconds"]) && (p["timeoutKind"] === undefined || p["timeoutKind"] === "idle") && clock(p["repairTimeoutSeconds"]) &&
      repairRef(p["repairModel"])
    ) {
      return {
        provider: "claude",
        model: p["model"],
        permissionArgv: p["permissionArgv"],
        maxTurns: p["maxTurns"],
        repairMaxTurns: p["repairMaxTurns"],
        timeoutSeconds: p["timeoutSeconds"],
        ...(p["timeoutKind"] === "idle" ? { timeoutKind: "idle" as const } : {}),
        repairTimeoutSeconds: p["repairTimeoutSeconds"],
        repairModel: p["repairModel"],
      };
    }
    return null;
  }
  if (p["provider"] === "codex" || p["provider"] === "openrouter") {
    if (
      exactKeys(p, [...PROVIDER_KEYS, "sandboxMode"], ["timeoutKind"]) &&
      str(p["model"]) &&
      (p["sandboxMode"] === "workspace-write" || p["sandboxMode"] === "danger-full-access") &&
      p["maxTurns"] === "unsupported" && p["repairMaxTurns"] === "unsupported" &&
      clock(p["timeoutSeconds"]) && (p["timeoutKind"] === undefined || p["timeoutKind"] === "idle") && clock(p["repairTimeoutSeconds"]) &&
      repairRef(p["repairModel"])
    ) {
      return {
        provider: p["provider"],
        model: p["model"],
        sandboxMode: p["sandboxMode"],
        maxTurns: "unsupported",
        repairMaxTurns: "unsupported",
        timeoutSeconds: p["timeoutSeconds"],
        ...(p["timeoutKind"] === "idle" ? { timeoutKind: "idle" as const } : {}),
        repairTimeoutSeconds: p["repairTimeoutSeconds"],
        repairModel: p["repairModel"],
      };
    }
    return null;
  }
  if (p["provider"] === "gemini") {
    if (
      exactKeys(p, [...PROVIDER_KEYS, "approvalArgv"], ["timeoutKind"]) &&
      str(p["model"]) &&
      (p["approvalArgv"] === "auto_edit" || p["approvalArgv"] === "yolo") &&
      p["maxTurns"] === "unsupported" && p["repairMaxTurns"] === "unsupported" &&
      clock(p["timeoutSeconds"]) && (p["timeoutKind"] === undefined || p["timeoutKind"] === "idle") && clock(p["repairTimeoutSeconds"]) &&
      repairRef(p["repairModel"])
    ) {
      return {
        provider: "gemini",
        model: p["model"],
        approvalArgv: p["approvalArgv"],
        maxTurns: "unsupported",
        repairMaxTurns: "unsupported",
        timeoutSeconds: p["timeoutSeconds"],
        ...(p["timeoutKind"] === "idle" ? { timeoutKind: "idle" as const } : {}),
        repairTimeoutSeconds: p["repairTimeoutSeconds"],
        repairModel: p["repairModel"],
      };
    }
    return null;
  }
  return null;
}

// ---- acceptance rubric (v39, Acceptance Contract v2) -----------------------
//
// The rubric an operator signs alongside the goal: what a finished build has
// to answer, by exact id, with typed references to evidence the plane itself
// captured. Every prior digest-bound field (budgetMicrousd, profile, chain)
// is additive and digests identically when absent — the rubric follows the
// same rule, so grandfathering an approval sealed before this migration is
// structural, not a special case. What makes the rubric MANDATORY is not the
// digest (which stays permissive, exactly like every field before it) — it is
// every authoring road refusing to save an empty one going forward
// (`proposeGuarded` and its siblings in templates, schedules, the demo, mate
// proposals, and the planner). `propose` itself, the primitive every one of
// those calls, stays permissive so a scope already on file — approved or not,
// written before this code existed — is never retroactively invalidated.
export type { AcceptanceCriterion, AcceptanceProblem };

/**
 * Parse a rubric from already-JSON-parsed input (the planner's handoff, a
 * console form, a template or a schedule's terms): fail closed, every
 * problem reported at once, each naming its path — the acceptance contract
 * (contracts/scope.ts) reads it. An absent or empty `value` parses to `[]`
 * with no problems: whether that is ALLOWED is a question for the caller
 * (`propose` says yes; every authoring road says no), never for this parser.
 */
export function parseAcceptanceCriteria(value: unknown): { criteria: AcceptanceCriterion[]; problems: AcceptanceProblem[] } {
  const read = readAcceptance(value);
  // Keep the prose shape plan.ts's existing acceptanceLine consumes. Validation stays in the contract; only this
  // compatibility boundary formats messages. That mapping takes a field followed by a space, not a colon, and
  // evidence-array indices belong in the detail because it recognizes only the criterion's index.
  return {
    ...read,
    problems: read.problems.map(problem => ({
      ...problem,
      message: problem.message
        .replace(/^(acceptance\[\d+\]\.evidence)\[(\d+)\]: /, (_, path: string, index: string) => `${path} entry ${Number(index) + 1}: `)
        .replace(/^(acceptance(?:\[\d+\])?(?:\.[A-Za-z]+)?): /, "$1 "),
    })),
  };
}

/** The exact bytes a rubric's SIGNED terms reduce to for the digest: sorted
 * by id, `how` dropped (advisory, never signed), evidence kinds sorted so
 * two equivalent lists never digest differently. */
/**
 * The plain-text rubric encoding shared by every non-JSON authoring
 * surface — the console's rubric textarea (one line each) and the CLI's
 * `--acceptance` flag (one line per `;`-separated entry): one criterion
 * per line, shaped
 *
 *   [id:] statement | evidence,kinds [| how]
 *
 * `id` is optional — auto-numbered `c1`, `c2`, ... in encounter order when
 * every line omits it, so a person can write the rubric without inventing
 * ids by hand. This function never validates; it only turns text into the
 * same plain-object shape `parseAcceptanceCriteria` already validates, so
 * both entry points can never drift on what counts as a valid criterion.
 */
/** The one criterion a filing may carry when nobody has written the rubric
 * yet: the console's scout follow-ups file with it, and `--acceptance plan`
 * on the command line expands to it. A mode with planAuto sends such a
 * filing to the planner instead of building against it. */
export const PLACEHOLDER_RUBRIC_STATEMENT = "The operator has reviewed this follow-up and written a real rubric before approving it.";
export const PLACEHOLDER_RUBRIC: AcceptanceCriterion[] = [{ id: "c1", statement: PLACEHOLDER_RUBRIC_STATEMENT, how: null, evidence: ["manual-review"] }];
export function rubricIsPlaceholder(acceptance: readonly { statement: string; evidence: readonly string[] }[]): boolean {
  return acceptance.length === 1 && acceptance[0]!.statement === PLACEHOLDER_RUBRIC_STATEMENT &&
    acceptance[0]!.evidence.length === 1 && acceptance[0]!.evidence[0] === "manual-review";
}

/** Split a `--acceptance` rubric into criteria. Criteria are `;`-separated,
 * but a `;` inside a statement must not split it: every criterion ends with
 * its `|<evidence kinds>` part, so a segment with no `|` is the front of the
 * next one and is glued back on. The single word `plan` means the placeholder. */
export function splitAcceptanceRubric(text: string): string[] {
  if (text.trim().toLowerCase() === "plan") return [`${PLACEHOLDER_RUBRIC_STATEMENT}|manual-review`];
  const out: string[] = [];
  let pending = "";
  for (const segment of text.split(";")) {
    const joined = pending === "" ? segment : `${pending};${segment}`;
    if (joined.includes("|")) { out.push(joined); pending = ""; }
    else pending = joined;
  }
  if (pending.trim() !== "") out.push(pending);
  return out;
}

export const isCommitSha = (value: string): boolean => /^[0-9a-f]{40}$/.test(value);

export function acceptanceLinesToInput(lines: readonly string[]): unknown[] {
  const out: unknown[] = [];
  let auto = 1;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") continue;
    const idMatch = /^([A-Za-z0-9_-]{1,40}):\s*(.*)$/.exec(line);
    const id = idMatch?.[1];
    const rest = idMatch ? (idMatch[2] ?? "") : line;
    const parts = rest.split("|").map(p => p.trim());
    const statement = parts[0] ?? "";
    const evidence = (parts[1] ?? "").split(",").map(k => k.trim()).filter(k => k !== "");
    const how = parts[2] !== undefined && parts[2] !== "" ? parts[2] : null;
    out.push({ id: id ?? `c${auto++}`, statement, evidence, how });
  }
  return out;
}

/** The inverse of `acceptanceLinesToInput`, for pre-filling an editor from
 * a stored rubric — round-trips through `parseAcceptanceCriteria` exactly. */
export function acceptanceToLines(criteria: readonly AcceptanceCriterion[]): string[] {
  return criteria.map(c => `${c.id}: ${c.statement} | ${c.evidence.join(",")}${c.how === null ? "" : ` | ${c.how}`}`);
}

export function canonicalAcceptance(criteria: readonly AcceptanceCriterion[]): { id: string; statement: string; evidence: EvidenceKind[] }[] {
  return [...criteria]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(c => ({ id: c.id, statement: c.statement.trim(), evidence: [...c.evidence].sort() }));
}

/**
 * A scope's terms, from the scope contract (contracts/scope.ts): what
 * success looks like in the operator's words (`goal`), what the task is
 * explicitly not allowed to turn into (`outOfScope`), the paths it expects
 * to touch (advisory, and worth stating), and the signed acceptance rubric
 * — `[]` on every scope proposed before v39 and on any legacy road that
 * still calls `propose` directly: a scope-producing ROAD enforces
 * non-emptiness, never this type, never `propose`, never the digest.
 */
export type SavedScopeTerms = { [K in keyof ScopeTerms]-?: Exclude<ScopeTerms[K], undefined> };

export type Scope = SavedScopeTerms & {
  taskId: string;
  /** v41: evidence policy, signed with the scope. Default is omitted from
   * the digest so every pre-v41 approval remains byte-for-byte valid. */
  qualityMode?: QualityMode;
  /** The dollar cap per build attempt, integer micro-dollars (v15) —
   * approved spend, restated at the yes, enforced by the provider's own
   * stop. NULL = no per-attempt cap was asked for. */
  budgetMicrousd: number | null;
  proposedAt: string;
  /** Of the scope as written. Approval is bound to this exact value. */
  digest: string;
  approvedAt: string | null;
  approvedBy: string | null;
  /** The digest that was actually agreed to, which may now be stale. */
  approvedDigest: string | null;
  /** How the approval happened (v29): 'password' = the ceremony;
   * 'mode' = sealed by the signer's live mode (modeDigest names it);
   * 'chat' = the owner's own two taps in their paired chat, under their chat-approval setting or a signed term
   * (modeDigest names that authority; the yes is the person's and doesn't lapse with it). */
  approvalBasis?: "password" | "mode" | "chat" | null;
  modeDigest?: string | null;
  /** v24 (optional so hand-built scopes in tests stay valid): the working
   * execution profile, its resolution state, and the immutable snapshot
   * the approval act sealed. */
  profile?: ExecutionProfile | null;
  profileState?: "resolved" | "unresolved";
  unresolvedReason?: string | null;
  approvedProfile?: ExecutionProfile | null;
  /** The raw snapshot bytes the row carries (v48 integrity): what the
   * strict stored-scope projection proves, exactly, before any seal or
   * consent surface believes the rehydrated `profile`. */
  profileJson?: string | null;
  approvedProfileJson?: string | null;
  digestVersion?: number;
  /** v30-v114 fallback chains (history): the working and sealed chain
   * snapshots and which kind the approval sealed. Never written since v115
   * (a re-approval writes `profile` and clears the sealed chain); an old
   * chain approval still decodes and verifies. */
  proposedChainJson?: string | null;
  approvedChainJson?: string | null;
  approvalKind?: "profile" | "chain";
  /** v47 phase routing: the signed risk level, the WORKING canonical route
   * the digest bound, and the immutable snapshot the seal COPIED from it.
   * `routeEra` is the durable marker: null on a row PROVEN to predate v47
   * (legacy — its sealed profile alone governs), the route version on every
   * row filed since — for those, a missing or unreadable route is corrupt
   * and fails closed everywhere. */
  riskLevel?: RiskLevel;
  /** A prepared commit the machine checks out instead of running an agent
   * (v69). Signed into the digest; must descend from the task's base. */
  candidate?: string | null;
  proposedRouteJson?: string | null;
  approvedRouteJson?: string | null;
  routeEra?: number | null;
  /** THE RAW TERMS VERDICT (raw authority repair): null when every stored
   * term and metadata column read back EXACTLY — touches a JSON list of
   * strings, the rubric a list of whole criteria with no unknown key, the
   * budget a safe integer or null, the quality mode, risk level, approval
   * kind, profile state, digest version, and route era each one of the
   * words this code writes — and the words when one did not. The lenient
   * fields above (`touches`, `acceptance`, …) are the console's reading;
   * every authority — consent, seal, chain, dispatch — refuses on a
   * non-null verdict, so filtering, defaulting, or coercion can never
   * turn a corrupt row into authority. Undefined on a hand-built scope. */
  termsProblem?: string | null;
  /** Who wrote the text (mate arc, ruling 2): a confirmed mate proposal,
   * the coordinator, a scout, or a person (null). Read raw and proved by
   * `termsProblem` — a word outside these is a stated problem, never a
   * value that slips past the mate quarantine at a mode seal. */
  proposedVia?: "mate" | "coordinator" | "scout" | null;
};

export type Approval =
  | { approved: true; at: string; by: string }
  | { approved: false; reason: "none" | "changed" | "never-proposed" };

export type ScopeInput = {
  taskId: string;
  /** v102: the person writing these words (a web edit, a chat confirmation, a coding hand-off); the requester rule refuses them. */
  author?: string;
  goal: string;
  outOfScope?: string | null;
  touches?: readonly string[];
  /** v24: an EXPLICIT profile skips resolution in the store (a schedule's
   * approved firings and the demo's illustrative scopes use this road). */
  profile?: ExecutionProfile;
  /** A task-level permission choice. When absent, the task's stored choice
   * (if any), then the installation default, decides the concrete profile. */
  permissionMode?: UnattendedPermissionMode;
  /** Concrete task quality choice. When absent, the task override and then
   * the installation default are resolved by the store. */
  qualityMode?: QualityMode;
  /** v69: a prepared commit to install as this attempt — no agent runs. */
  candidate?: string | null;
  /** Integer micro-dollars per build attempt; digest-bound when present. */
  budgetMicrousd?: number | null;
  /** The mode road's escalated filing default (C7): the resolved profile
   * seals claude bypassPermissions / gemini yolo; codex-shaped unchanged. */
  posture?: "escalated";
  /** Who wrote this text (mate arc, ruling 2): `mate` for a confirmed mate
   * proposal — mode coverage then never seals it; a human rewrite clears it. */
  proposedVia?: "mate" | "coordinator" | null;
  /** v39: the signed acceptance rubric. Absent digests exactly like `[]` —
   * see `Scope.acceptance`. `propose` itself never requires this to be
   * non-empty; the roads that call it do. */
  acceptance?: readonly AcceptanceCriterion[];
  now: Date;
  mutation?: Mutation;
};

/**
 * The exact bytes an operator agreed to.
 *
 * Every field that constrains the work goes in. If a change to a field would
 * change what an operator would have said, it has to move the digest, or the
 * approval it invalidates would be an approval of something else.
 */
export function digestOf(
  scope: Pick<Scope, "goal" | "outOfScope" | "touches"> & {
    budgetMicrousd?: number | null;
    /** v39: the rubric, folded in ONLY when non-empty — the same absent/`[]`
     * equivalence budgetMicrousd has always used, so a scope proposed before
     * this migration, or by a road that never sends one, digests to exactly
     * what it digested to before this field existed. `how` never enters
     * here (advisory, never signed); evidence kinds do. */
    acceptance?: readonly AcceptanceCriterion[];
    qualityMode?: QualityMode;
    /** v69: a prepared commit, folded in only when present so every earlier
     * digest is untouched. */
    candidate?: string | null;
  },
  // The execution target: a single profile (legacy v24), OR an explicit
  // fallback chain (v30). BOTH fold through the SAME outer `profileDigest`
  // key — the discriminator lives INSIDE the digest value (a chain digest
  // is domain-separated from a profile digest), NEVER as an outer field
  // (an outer field would change the legacy bytes; C1). A chain-of-one is
  // still an EXPLICIT chain and uses the chain digest, distinct from the
  // single-profile digest by design.
  target?: ExecutionProfile | null | { chain: readonly ChainEntry[] },
  // v47: the phase route. EVERY route filed since v47 folds in — routine
  // shaped ones included — so the approval binds exactly which agent runs
  // each phase. Absent (null) only for a row proven to predate v47, whose
  // digest bytes are therefore untouched.
  route?: PhaseRoute | null,
): string {
  const innerDigest =
    target == null
      ? null
      : "chain" in target
        ? chainDigestOf(target.chain)
        : profileDigestOf(target);
  return createHash("sha256")
    .update(
      JSON.stringify({
        goal: scope.goal.trim(),
        outOfScope: scope.outOfScope?.trim() ?? null,
        touches: [...scope.touches].sort(),
        // Absent and null digest identically, so every pre-v15 approval
        // stays exactly as approved.
        ...(scope.budgetMicrousd == null ? {} : { budget: scope.budgetMicrousd }),
        // Same absent/[] equivalence as budget, one key up: a rubric-less
        // scope (every scope before v39, and any road that sends none)
        // digests identically to today.
        ...(scope.acceptance === undefined || scope.acceptance.length === 0
          ? {}
          : { acceptance: canonicalAcceptance(scope.acceptance) }),
        // Default is the historical behavior and therefore hashes exactly
        // like an absent v41 field. Strict is an explicit signed promise.
        ...(scope.qualityMode === "strict" ? { qualityMode: "strict" } : {}),
        ...(scope.candidate ? { candidate: scope.candidate } : {}),
        // The single outer key, whichever target produced its inner value:
        // absent => the golden and every profileless approval are untouched;
        // a legacy profile => its exact profileDigestOf; an explicit chain
        // => its chainDigestOf. Same key, discriminated value.
        ...(innerDigest == null ? {} : { profileDigest: innerDigest }),
        // The route's own domain-separated digest, under its own key —
        // absent only for a pre-v47 row.
        ...(route == null ? {} : { route: routeDigestOf(route) }),
      }),
      "utf8",
    )
    .digest("hex")
    // 128 bits. This is a safety token binding an approval to exact content,
    // so it has to be well past the reach of a deliberate collision search —
    // 64 bits is not, and the only cost of the longer one is a longer thing to
    // paste back.
    .slice(0, 32);
}

export function propose(store: Store, input: ScopeInput): Scope {
  const { taskId, goal, outOfScope = null, touches = [], budgetMicrousd = null, acceptance = [], qualityMode = "default", now, mutation = {}, profile, permissionMode, posture, proposedVia = null } = input;

  const draft = { goal, outOfScope, touches: [...touches], budgetMicrousd, acceptance: [...acceptance], qualityMode, candidate: input.candidate ?? null };
  const previous = store.getScope(taskId);

  const scope: Scope = {
    taskId,
    ...draft,
    proposedAt: now.toISOString(),
    digest: digestOf(draft),
    // The previous approval is kept rather than cleared, and is invalidated by
    // the digest no longer matching. Same safety — `approvalOf` requires them
    // equal — but it preserves the fact that somebody once agreed to
    // something, so the refusal can say "this was approved and then rewritten"
    // instead of the much less useful "this was never approved".
    approvedAt: previous?.approvedAt ?? null,
    approvedBy: previous?.approvedBy ?? null,
    approvedDigest: previous?.approvedDigest ?? null,
  };

  store.saveScope(scope, mutation, {
    ...(profile === undefined ? {} : { profile }),
    ...(permissionMode === undefined ? {} : { permissionMode }),
    ...(input.qualityMode === undefined ? {} : { qualityMode: input.qualityMode }),
    ...(posture === undefined ? {} : { posture }),
    proposedVia,
  });
  // The store may have RECOMPUTED the digest to bind the resolved profile
  // (v24 filing invariant) — what callers display must be what is stored.
  const saved = store.getScope(taskId) ?? scope;
  if (input.author !== undefined && input.author !== "") store.recordScopeAuthor(taskId, saved.digest, input.author, now);
  return saved;
}

export type GuardedProposeResult =
  | { ok: true; scope: Scope }
  | {
      ok: false;
      reason: "changed" | "claimed" | "bad-goal" | "bad-out-of-scope" | "bad-touches" | "bad-acceptance" | "acceptance-required";
      message?: string;
    };

/**
 * A scope edit from a surface where the editor might be stale — two browser
 * tabs, a form submitted after the world moved. `sawDigest` names the version
 * the editor was looking at (null: they saw no scope at all); a mismatch is a
 * refusal, never a silent overwrite of somebody else's words. Edits are also
 * refused while a live claim holds the task: the running build read its scope
 * at start, and rewording the agreement under it would make the digest lie
 * about what the work was agreed to. Field caps and control-character rules
 * live here because every one of these strings will later be rendered.
 *
 * v39: this is a scope-producing ROAD, not the `propose` primitive, so it is
 * where the rubric becomes mandatory — every edit through here (a fresh
 * proposal or a rewrite of an already-approved one) must carry at least one
 * criterion, or it is refused with a clear `acceptance-required` reason
 * rather than silently filing without one. A scope that already carries a
 * live, unrewritten approval from before this code existed never reaches
 * this function again unless somebody edits it — which is exactly when the
 * requirement should start applying.
 */
export function proposeGuarded(
  store: Store,
  input: Omit<ScopeInput, "acceptance"> & { sawDigest: string | null; taskRef: number | null; acceptance?: unknown },
): GuardedProposeResult {
  const touches = [...(input.touches ?? [])].map(one => one.trim()).filter(one => one !== "");
  // Plain words first for what a person typed (lengths, bytes, hidden text), then the scope contract.
  const badText = validateScopeText({ goal: input.goal, outOfScope: input.outOfScope ?? null, touches });
  if (badText !== null) return badText;
  const goal = input.goal.trim();
  const outOfScope = input.outOfScope?.trim() || null;
  const terms = readScopeTerms({ goal, outOfScope, touches, acceptance: input.acceptance });
  if (!terms.ok) {
    const reason = terms.field === "acceptance" ? "bad-acceptance" : terms.field === "touches" ? "bad-touches" : terms.field === "outOfScope" ? "bad-out-of-scope" : "bad-goal";
    return { ok: false, reason, message: terms.problems.map(one => one.message).join("; ") };
  }
  const acceptanceParse = { criteria: terms.terms.acceptance };
  if (acceptanceParse.criteria.length === 0) {
    return { ok: false, reason: "acceptance-required" };
  }

  return store.transact(() => {
    if (input.taskRef !== null && store.hasLiveClaim(input.taskRef, input.now)) {
      return { ok: false as const, reason: "claimed" as const };
    }
    const previous = store.getScope(input.taskId);
    if ((previous?.digest ?? null) !== input.sawDigest) {
      return { ok: false as const, reason: "changed" as const };
    }
    const scope = propose(store, { ...input, goal, outOfScope, touches, acceptance: acceptanceParse.criteria });
    return { ok: true as const, scope };
  });
}

/**
 * A person says yes.
 *
 * Takes the digest they were shown, so agreeing to a scope that changed while
 * they were reading it fails rather than silently approving the new one.
 */
/**
 * Register somebody who is allowed to agree to scopes.
 *
 * The token is shown once and stored only as a hash, exactly like a runner's.
 * It exists because an approval nobody has to authenticate is not a gate: an
 * agent that can run these commands can read a scope's digest out of `task
 * show` and approve its own brief with it. Requiring a credential the agent
 * was never given is what keeps "a person agreed to this" true.
 */
export type AddApproverResult =
  | { ok: true; name: string; token: string; bootstrap: boolean; chosen: boolean }
  | { ok: false; reason: "not-an-approver" | "weak-password" };

export function addApprover(
  store: Store,
  name: string,
  now: Date,
  by?: { name: string; token: string },
  newToken: () => string = mintToken,
  mutation: Mutation = {},
  /** A password the person chose. Absent, a token is minted and shown once. */
  password?: string,
): AddApproverResult {
  if (password !== undefined && password.length < 8) {
    return { ok: false, reason: "weak-password" };
  }
  // The first one bootstraps, because somebody has to be able to create the
  // first one and there is nobody to ask yet. Every one after it has to be
  // vouched for by an existing approver.
  //
  // Without that second rule the credential is worth nothing: an agent that
  // can run these commands would simply mint an approver for itself and
  // approve its own scope with it. The bootstrap window is real and is why
  // this is the first thing an operator should do, before anything else can
  // reach the queue.
  // ONE transaction around detection, vouching, and the write (Codex
  // people round 2, finding 1): a voucher revoked between the check and
  // the save must lose — BEGIN IMMEDIATE serializes against the
  // revocation cascade, so there is no between.
  return store.transact(() => {
  const existing = store.listApprovers();
  const bootstrap = existing.length === 0;

  if (!bootstrap) {
    // ACTIVE approver standing, not a bare hash match (Codex people round
    // 1, finding 1): a viewer's or a revoked person's credential is real
    // and still vouches for nothing — the CLI is a ceremony site like any
    // other, and this was the one road that forgot.
    const vouching = by === undefined ? { ok: false as const } : authenticateApprover(store, by.name, by.token);
    if (!vouching.ok) {
      return { ok: false, reason: "not-an-approver" };
    }
  }

  if (password !== undefined) {
    store.saveApprover(name, hashPassword(password), now, mutation);
    return { ok: true, name, token: password, bootstrap, chosen: true };
  }
  const token = newToken();
  store.saveApprover(name, hashToken(token), now, mutation);
  return { ok: true, name, token, bootstrap, chosen: false };
  });
}

export type ApproveResult =
  | { ok: true; scope: Scope }
  | { ok: false; reason: "no-scope" | "changed" | "no-approvers" | "not-an-approver" | "profile-unresolved" | "unrouted" }
  /** v102: the project's approval rules stopped it — the requester can't approve, protected work needs a person —
   * or recorded this person's yes and needs a second one (`second-approver`). */
  | { ok: false; reason: "requester" | "person-required" }
  | { ok: false; reason: "second-approver"; have: number; need: number; already: boolean }
  /** Sprint 8: the organisation policy stops these terms (a provider, a model, the permission ceiling); `message` says which. */
  | { ok: false; reason: "policy"; message: string };

/**
 * Whether this name-and-token pair is a person the store knows. Shared by
 * every act that requires a human's authority — approving a scope, answering
 * a decision — because "who said yes" must never be a string the caller
 * typed. Fails closed: with no approver registered there is nobody who can
 * agree to anything, and treating that as "authority is not required here"
 * would make the gate optional — which is the same as not having one.
 */
/**
 * IDENTITY, split from authority (modes chain, D2/E2): who this credential
 * belongs to and what standing they hold. Viewers authenticate here and
 * read; every consequential act goes through authenticateApprover below,
 * which additionally demands ACTIVE approver standing — so the forty
 * ceremony sites enforce the role without one of them changing.
 */
export function authenticateAccount(
  store: Store,
  by: string,
  secret: string,
): { ok: true; role: "approver" | "viewer"; generation: number } | { ok: false; reason: "no-approvers" | "unknown" | "revoked" | "locked"; retryAfterMs?: number } {
  if (store.listApprovers().length === 0) return { ok: false, reason: "no-approvers" };
  // A remote run (runOperateAs) is its token's person: only that run's own credential names them, no password is
  // checked or counted, and a read token stands as a viewer.
  const remote = activeRemote();
  if (remote !== null) {
    const account = by === remote.account && secret === remote.secret ? store.accountOf(by) : null;
    if (account === null || account.revokedAt !== null) return { ok: false, reason: "unknown" };
    return { ok: true, role: remote.scope === "act" ? account.role : "viewer", generation: account.generation };
  }
  // A lead token signs in as its owner, only inside a command the lead runs with it (never a console sign-in).
  const acting = currentActor();
  if (acting?.lead === true && parseLeadToken(secret) !== null) {
    const lead = store.leadFor(secret), account = store.accountOf(by);
    if (lead === null || lead.owner !== by || acting.account !== by || account === null) return { ok: false, reason: "unknown" };
    return { ok: true, role: account.role, generation: account.generation };
  }
  // v99: wrong passwords in a row lock the name for a while from where they came, whatever road they came by. A
  // locked or held-back source is refused before the password is checked.
  const guard = passwordGuardOf(store), now = Date.now(), source = currentPasswordSource();
  const account = store.accountOf(by), proof = provenPasswordAccount.getStore();
  const proven = proof?.name === by && account !== null && account.revokedAt === null && proof.generation === account.generation;
  const wait = guard.preflight(by, now, source, proven);
  if (wait > 0) return { ok: false, reason: "locked", retryAfterMs: wait };
  // Unknown names and legacy minted-token/SSO accounts do the same one KDF as a password account. Throttled
  // attempts above do none, for either name class; never disclose account existence through password work.
  const dummy = `scrypt$${"0".repeat(32)}$${"0".repeat(64)}`;
  const hash = account?.credentialHash ?? dummy;
  if (!hash.startsWith("scrypt$")) verifyCredential(dummy, secret);
  const matches = verifyCredential(hash, secret);
  if (account === null || !matches) {
    guard.failed(by, now, source, account !== null);
    return { ok: false, reason: "unknown" };
  }
  guard.succeeded(by, source);
  if (account.revokedAt !== null) return { ok: false, reason: "revoked" };
  // Inside a command, the person who signed in is who acted (their own acts never ping them).
  claimActor(by);
  return { ok: true, role: account.role, generation: account.generation };
}

/**
 * v100: someone who signed in with the identity provider moments ago has no
 * password to type again. The console marks such a request with this, for
 * that person only, and an EMPTY password then stands for the fresh sign-in
 * at every step-up that reaches `authenticateApprover` (scope
 * approval, chat-action review, the console's own ceremonies). A typed
 * password is always checked, and nothing else stands in.
 */
export const freshIdentitySignIn = new AsyncLocalStorage<{ actor: string | null }>();
export const hasFreshIdentitySignIn = (by: string): boolean => freshIdentitySignIn.getStore()?.actor === by;

export function authenticateApprover(
  store: Store,
  by: string,
  token: string,
  repo?: string | null,
): { ok: true } | { ok: false; reason: "no-approvers" | "not-an-approver" } {
  // An empty password is never checked as a password (and never counts toward a lockout).
  if (token === "") return hasFreshIdentitySignIn(by) ? approverStanding(store, by, repo) : { ok: false, reason: "not-an-approver" };
  const account = authenticateAccount(store, by, token);
  if (!account.ok) {
    return { ok: false, reason: account.reason === "no-approvers" ? "no-approvers" : "not-an-approver" };
  }
  return approverStanding(store, by, repo);
}

/**
 * What an approval needs besides the password (v100: an identity-provider
 * sign-in moments ago stands in for the password; nothing stands in for
 * this): an active account in the approver role, with access to the project.
 */
export function approverStanding(store: Store, by: string, repo?: string | null): { ok: true } | { ok: false; reason: "no-approvers" | "not-an-approver" } {
  const account = store.accountOf(by);
  // A viewer's credential is real and still cannot agree to anything —
  // the words every refused ceremony shows are the viewer words.
  if (account === null || account.revokedAt !== null || account.role !== "approver") return { ok: false, reason: "not-an-approver" };
  const context = projectAuthority.getStore();
  const resource = repo === undefined ? (context?.actor === by ? context.repo : null) : repo;
  if (!store.accountCanAccess(by, resource)) return { ok: false, reason: "not-an-approver" };
  return { ok: true };
}

/**
 * C1's atomic road: file the scope AND seal its approval in ONE
 * transaction, under a mode the SAME transaction re-proves. The caller
 * has already authenticated the actor and matched channel rules; this
 * function owns the predicate's transactional half — mode active, actor
 * IS the signer, repo matches, and the sealed digest is the filed one
 * (trivially true here: they are the same transaction). Never
 * sealScopeApproval after a filing — that was the TOCTOU.
 */
/**
 * C1's coverage question, answerable from ANY filing road: does a live
 * mode make THIS actor's credentialed filing auto-approve here, and with
 * which defaults? Callers re-ask INSIDE their filing transaction — an
 * answer carried across transactions would be the TOCTOU again.
 */
export function modeFilingCoverage(
  store: Store,
  repo: string | null,
  actor: string,
  now: Date,
): { digest: string; escalated: boolean; defaultBudgetMicrousd: number | null } | null {
  const mode = repo === null ? null : store.activeMode(repo, now);
  if (mode === null || mode.signedBy !== actor) return null;
  try {
    const terms = JSON.parse(mode.termsJson) as {
      autoApproveFiling?: unknown;
      permissionDefault?: unknown;
      perAttemptBudgetMicrousd?: unknown;
    };
    if (terms.autoApproveFiling !== true) return null;
    return {
      digest: mode.digest,
      escalated: terms.permissionDefault === "escalated",
      defaultBudgetMicrousd:
        typeof terms.perAttemptBudgetMicrousd === "number" ? terms.perAttemptBudgetMicrousd : null,
    };
  } catch {
    return null;
  }
}

export function fileAndSealUnderMode(
  store: Store,
  input: ScopeInput & { repo: string | null; actor: string },
): { ok: true; scope: Scope; basis: "mode" } | { ok: false; reason: "no-mode" | "not-signer" | "not-covered" | "coordinator-filed" | "acceptance-required" | "profile-unresolved"; detail?: string } {
  return store.transact(() => {
    const mode = input.repo === null ? null : store.activeMode(input.repo, input.now);
    if (mode === null) return { ok: false as const, reason: "no-mode" as const };
    if (mode.signedBy !== input.actor) return { ok: false as const, reason: "not-signer" as const };
    let autoApprove = false;
    let defaultBudget: number | null = null;
    let escalated = false;
    try {
      const terms = JSON.parse(mode.termsJson) as { autoApproveFiling?: unknown; perAttemptBudgetMicrousd?: unknown; permissionDefault?: unknown };
      autoApprove = terms.autoApproveFiling === true;
      defaultBudget = typeof terms.perAttemptBudgetMicrousd === "number" ? terms.perAttemptBudgetMicrousd : null;
      escalated = terms.permissionDefault === "escalated";
    } catch {
      autoApprove = false;
    }
    if (!autoApprove) return { ok: false as const, reason: "not-covered" as const };
    // v39: a mode auto-approves a filing with NOBODY reading it at that
    // instant — of every road, this one can least afford to seal a scope
    // with no rubric to answer.
    if (parseAcceptanceCriteria(input.acceptance).criteria.length === 0) {
      return { ok: false as const, reason: "acceptance-required" as const };
    }
    const scope = propose(store, {
      ...input,
      ...(input.budgetMicrousd == null && defaultBudget !== null ? { budgetMicrousd: defaultBudget } : {}),
      ...(escalated ? { posture: "escalated" as const } : {}),
    });
    // A scope that cannot say exactly which agents run (v47: every phase
    // exact, the route readable) is never auto-sealed — the words say why.
    if (scope.profileState === "unresolved") {
      return { ok: false as const, reason: "profile-unresolved" as const, ...(scope.unresolvedReason == null ? {} : { detail: scope.unresolvedReason }) };
    }
    const sealed = store.sealScopeApproval(input.taskId, input.actor, input.now, input.mutation ?? {}, { kind: "mode", modeDigest: mode.digest });
    // The quarantine speaks through every caller (review finding 7): a
    // coordinator-filed task is never mode-admitted, and pretending the
    // seal landed would hide exactly the refusal the operator must see.
    if (!sealed) return { ok: false as const, reason: "coordinator-filed" as const };
    return { ok: true as const, scope: store.getScope(input.taskId) as Scope, basis: "mode" as const };
  });
}

export function approve(
  store: Store,
  taskId: string,
  by: string,
  now: Date,
  sawDigest: string,
  token: string,
  mutation: Mutation = {},
): ApproveResult {
  // Read and write in one transaction, re-reading inside it — the credential
  // check included, so a token rotated between authentication and the write
  // cannot leave an approval signed by an authority that no longer exists.
  // Apart, a scope rewritten between the read and the write is overwritten by
  // this approval — which would resurrect the old wording *and* mark it
  // agreed, the precise opposite of what the digest is for.
  return store.transact(() => {
    const authenticated = authenticateApprover(store, by, token, store.lookupRef(taskId)?.repo ?? null);
    if (!authenticated.ok) return authenticated;

    const scope = store.getScope(taskId);
    if (scope === null) return { ok: false as const, reason: "no-scope" as const };

    // The digest is required, not optional. An operator reads a scope, somebody
    // rewrites it, and an approval that did not name what it saw would agree to
    // the new one in silence — which is the whole failure this guards.
    if (sawDigest !== scope.digest) return { ok: false as const, reason: "changed" as const };

    // An unresolved scope cannot say exactly what would run, so nobody can
    // agree to it (foundations finding 16) — restatement is the road.
    if (scope.profileState === "unresolved") {
      return { ok: false as const, reason: "profile-unresolved" as const };
    }
    // A row that predates agent routing cannot take a NEW yes (v48): an
    // approval now names exactly which agent plans, builds, repairs, and
    // reviews, and this row names none — re-filing routes it.
    if (scope.routeEra == null) {
      return { ok: false as const, reason: "unrouted" as const };
    }

    // SEPARATION OF DUTIES (v102): the project's rules, asked first so the
    // answer is words, not a silent refusal from the seal. Protected work
    // keeps each person's yes to these exact bytes and seals on the second.
    // Sprint 8: the organisation policy, before any vote is kept: a disallowed provider or model, or terms above the
    // permission ceiling, are refused in words that name the rule.
    const policy = store.scopePolicyRefusal(taskId);
    if (policy !== null) return { ok: false as const, reason: "policy" as const, message: policy };
    const gate = store.approvalGate(taskId, by, "person");
    if (gate.verdict === "refuse") return { ok: false as const, reason: gate.reason };
    if (gate.verdict === "vote") {
      store.recordApprovalVote(taskId, scope.digest, by, now);
      return { ok: false as const, reason: "second-approver" as const, have: gate.have, need: gate.need, already: gate.already };
    }
    if (gate.protectedWork) store.recordApprovalVote(taskId, scope.digest, by, now);

    // SEAL, never re-resolve: the approval snapshots the stored working
    // profile — the exact bytes the digest the approver signed was bound
    // to. Routing saveScope here would re-run resolution and could sign a
    // profile nobody saw.
    const sealed = store.sealScopeApproval(taskId, by, now, mutation);
    if (!sealed) return { ok: false as const, reason: "changed" as const };
    const approved = store.getScope(taskId);
    if (approved === null) return { ok: false as const, reason: "no-scope" as const };
    return { ok: true as const, scope: approved };
  });
}

/**
 * Whether this task may be built.
 *
 * `changed` is the interesting answer and the reason the digest exists: the
 * scope was approved, and then somebody — possibly an agent, possibly the
 * operator, possibly a different session — rewrote it. The old yes does not
 * transfer.
 */
export function approvalOf(scope: Scope | null): Approval {
  if (scope === null) return { approved: false, reason: "never-proposed" };
  if (scope.approvedAt === null || scope.approvedBy === null) {
    return { approved: false, reason: "none" };
  }
  if (scope.approvedDigest !== scope.digest) return { approved: false, reason: "changed" };
  return { approved: true, at: scope.approvedAt, by: scope.approvedBy };
}

/**
 * THE STRICT STORED-SCOPE PROJECTION (v48 integrity): the ONE reading of
 * a filed scope that a seal and every consent surface believe. Nothing
 * lenient stands in for it — the working profile and route are
 * re-parsed from their raw bytes with exact keys, safe integers, and
 * timer-safe clocks; the route's build and repair legs ARE the profile's
 * exact pairs; and the row's digest re-derives, complete, from these very values. A legacy row (no
 * route era) has no authority a person can newly agree to. One
 * disagreement is the words, and nothing — no nonce, no password field,
 * no approve action, no seal — is exposed on it.
 */
export type ScopeAuthority =
  | { ok: true; profile: ExecutionProfile; route: PhaseRoute; digest: string; authMode: AuthMode | null }
  | { ok: false; reason: "terms" | "unrouted" | "unresolved" | "profile" | "chain" | "route" | "parity" | "digest" | "auth-mode"; problem: string };

/** What the strict projection reads OUTSIDE the row (atomic authority
 * closure): the operator's stored auth mode for a provider, strictly — a
 * present file that says neither word is a stated problem, never the
 * default a lenient read would coerce it to. Filing, consent, the seal,
 * and the spawn all hand in the same reader, so one broken file closes
 * every door in the same words. */
export type ScopeAuthorityEnv = {
  authMode?: (provider: ProviderId) => { ok: true; mode: AuthMode } | { ok: false; problem: string };
};

/**
 * THE PARITY every projection proves between a route and the profile and
 * terms it was filed beside (atomic authority closure): the build and
 * repair legs ARE the profile's exact pairs, and the route's signed risk
 * and quality ARE the row's — a row whose risk says high over a route
 * recommended for routine was not filed by this code, and neither the
 * seal, the consent door, nor the dispatch proof believes it. One
 * function, so the working side, the sealed side, and the last-mile
 * dispatch proof cannot drift. Null when everything agrees.
 */
export function routeParityProblem(
  route: PhaseRoute,
  profile: ExecutionProfile,
  terms: { riskLevel: RiskLevel; qualityMode: QualityMode },
): string | null {
  const buildLeg = legOf(route, "build");
  const repairLeg = legOf(route, "repair");
  const repairModel = profile.repairModel === "inherit" ? profile.model : profile.repairModel;
  if (buildLeg.provider !== profile.provider || buildLeg.model !== profile.model || repairLeg.provider !== profile.provider || repairLeg.model !== repairModel) {
    return `the route builds on ${buildLeg.provider} · ${buildLeg.model} (repair ${repairLeg.provider} · ${repairLeg.model}) but the agent profile says ${profile.provider} · ${profile.model} (repair ${profile.provider} · ${repairModel})`;
  }
  if (route.risk !== terms.riskLevel) {
    return `the route was recommended for ${route.risk} risk but the scope's risk level is ${terms.riskLevel}`;
  }
  if (route.qualityMode !== terms.qualityMode) {
    return `the route was recommended for ${route.qualityMode} quality but the scope's quality mode is ${terms.qualityMode}`;
  }
  return null;
}

// Recovery reuses this exact raw-terms check before considering saved evidence.
// Decoding authority does not renew approval or authorize a process-custody write.
export function scopeAuthorityOf(scope: Scope, env: ScopeAuthorityEnv = {}): ScopeAuthority {
  // THE RAW TERMS FIRST (raw authority repair): a row whose stored terms
  // or metadata do not read back exactly is no authority at all — not
  // the filtered, defaulted, or coerced reading of it.
  if (scope.termsProblem != null) {
    return { ok: false, reason: "terms", problem: `the scope's stored terms cannot be read exactly (${scope.termsProblem})` };
  }
  if (scope.routeEra == null) {
    return { ok: false, reason: "unrouted", problem: "this scope predates agent routing — its terms name no agent for any role; re-file it to route it under today's agents" };
  }
  if (scope.profileState === "unresolved") {
    return { ok: false, reason: "unresolved", problem: scope.unresolvedReason ?? "the scope cannot say exactly what would run" };
  }
  const profileJson = scope.profileJson === undefined ? (scope.profile == null ? null : canonicalProfileJson(scope.profile)) : scope.profileJson;
  const profile = profileFromJson(profileJson);
  if (profile === null) {
    return { ok: false, reason: "profile", problem: profileJson === null ? "the scope carries no agent profile" : "the scope's agent profile cannot be read exactly (unknown keys, an unsafe number, or a clock no timer can hold)" };
  }
  // A scope filed with fallback agents (v30-v114) holds no authority now
  // that fallback chains are gone: saving it again chooses its agents.
  if (scope.proposedChainJson != null) {
    return { ok: false, reason: "chain", problem: "this scope named fallback agents, which Toolroll no longer uses — save the scope again to choose its agents" };
  }
  const routeJson = scope.proposedRouteJson ?? null;
  const route = routeFromJson(routeJson);
  if (route === null) {
    return { ok: false, reason: "route", problem: routeJson === null ? "the scope was filed under agent routing but carries no route" : `the scope's agent route cannot be read exactly (${routeJsonProblem(routeJson)})` };
  }
  const parity = routeParityProblem(route, profile, { riskLevel: scope.riskLevel ?? "routine", qualityMode: scope.qualityMode ?? "default" });
  if (parity !== null) return { ok: false, reason: "parity", problem: parity };
  const digest = digestOf(
    { goal: scope.goal, outOfScope: scope.outOfScope, touches: scope.touches, budgetMicrousd: scope.budgetMicrousd, acceptance: scope.acceptance, candidate: scope.candidate ?? null, qualityMode: scope.qualityMode ?? "default" },
    profile,
    route,
  );
  if (digest !== scope.digest) {
    return { ok: false, reason: "digest", problem: "the scope's reference does not re-derive from its own terms, agents, and route — file it again" };
  }
  // THE AUTH MODE, strictly (atomic authority closure): the credential the
  // profile's provider would spend under is read through the caller's
  // strict reader — a present mode file that says neither word closes
  // the door in its words, never the default a lenient read would coerce
  // it to (the spawn reads the same way, so nothing sealed here spends
  // on a credential the operator never named).
  let authMode: AuthMode | null = null;
  if (env.authMode !== undefined) {
    const read = env.authMode(profile.provider);
    if (!read.ok) return { ok: false, reason: "auth-mode", problem: read.problem };
    authMode = read.mode;
  }
  return { ok: true, profile, route, digest, authMode };
}

/** The rubric's approval-card lines (v39): one per criterion, the id in
 * front (the exact string a proof must answer by) and its required
 * evidence kinds after it — `how` is deliberately absent here, the same way
 * it is absent from the digest: it is guidance, never a signed term. */
export function acceptanceWords(criteria: readonly AcceptanceCriterion[]): string[] {
  if (criteria.length === 0) return [];
  return [
    `  acceptance   ${criteria[0]!.id}: ${criteria[0]!.statement} [requires: ${criteria[0]!.evidence.join(", ")}]`,
    ...criteria.slice(1).map(c => `               ${c.id}: ${c.statement} [requires: ${c.evidence.join(", ")}]`),
  ];
}

/** The route's approval-card lines (v47): the WORKING route the digest
 * bound, projected with whatever readiness the caller can see — the same
 * bytes the task page and chat render. Empty on a scope with no route. */
export function scopeRouteWords(scope: Pick<Scope, "proposedRouteJson">, readiness: ReadinessLookup = NO_READINESS): string[] {
  const route = routeFromJson(scope.proposedRouteJson ?? null);
  return route === null ? [] : routeWords(projectRoute(route, readiness));
}

/** The scope, in the words an operator has to be able to agree or disagree with. */
export function describeScope(scope: Scope, readiness: ReadinessLookup = NO_READINESS): string[] {
  const approval = approvalOf(scope);
  return [
    `  goal         ${scope.goal}`,
    ...(scope.outOfScope === null ? [] : [`  not this     ${scope.outOfScope}`]),
    ...(scope.candidate ? [`  candidate    ${scope.candidate} — checked out by the machine, no agent runs`] : []),
    ...(scope.touches.length === 0 ? [] : [`  touches      ${scope.touches.join(", ")}`]),
    ...acceptanceWords(scope.acceptance),
    ...(scope.budgetMicrousd === null
      ? []
      : [`  budget       $${(scope.budgetMicrousd / 1_000_000).toFixed(2)} per build attempt — the agent is stopped at this figure`]),
    // The ROUTE, in the words the yes agrees to (v47): posture and every
    // leg with its reason and readiness — before anyone signs.
    ...scopeRouteWords(scope, readiness),
    `  reference    ${scope.digest}`,
    `  approved     ${describeApproval(approval)}`,
  ];
}

function describeApproval(approval: Approval): string {
  if (approval.approved) return `yes, by ${approval.by} at ${approval.at}`;
  if (approval.reason === "changed") {
    return "no — it was approved, then the scope was rewritten; approve it again";
  }
  return "no — nothing will build this until somebody agrees to it";
}
