/**
 * Flexible projects, slice F1 (the Flexible plan v2 §3, with the owner's round-2 decisions and Codex round 2's required
 * changes, which are binding): the terms a person signs to turn a project Flexible, their digest, their words, the
 * writers that turn it on, lower it and turn it off, when signed terms stop counting (lapse), and the check a thread
 * start makes at the moment of use (F2 calls it inside the transaction that starts the thread).
 *
 * The rules this module keeps:
 * - Nothing here works while FLEXIBLE_AVAILABLE is false (flexible-available.ts): every writer and the delegation
 *   check refuse with `not-available`.
 * - Turning it on is a person's password ceremony (a password typed now or a one-use identity-provider re-check), by
 *   any approver who can approve work in the project. The terms are rebuilt from Toolroll's own records inside the
 *   write transaction and must hash to exactly the digest the person was shown; otherwise nothing is written.
 * - Lowering and turning off need no password, only an approver of the project, and serialise with every start (one
 *   write transaction each): lowering writes narrower terms under a new digest and turning off ends them, so any
 *   start or thread holding the old digest is refused from then on.
 * - Signed terms stop counting (lapse) when the signer's account is revoked or its generation moves (password,
 *   role or project access changed), the signer can no longer approve in the project, the project needs two people
 *   to approve, its network posture changes, or the organisation's ceiling drops below the terms' highest level.
 *   Every read checks this; the writers that cause it also end the terms durably (endLapsedFlexible).
 * - Stored terms that can't be read exactly (bad JSON, unknown keys or values, a digest that doesn't match, terms
 *   wider than what was signed) are unavailable: never read as any level.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";
import { FLEXIBLE_AVAILABLE } from "./flexible-available.js";
import type { PermissionLevel } from "./policy.js";
import type { Store } from "./store.js";

export const FLEXIBLE_LEVELS = ["supervised", "auto", "full"] as const;
export type FlexibleLevel = (typeof FLEXIBLE_LEVELS)[number];
export type FlexibleStarters = "signer" | "approvers-with-access";
export type FlexibleNetwork = "confined" | "open";
export type FlexibleCaps = {
  /** Threads running at once in the project. */
  liveThreads: number;
  /** Agent turns a day in the project (UTC), hard: admitted before the provider is asked (F2). */
  turnsPerDayProject: number;
  /** Agent turns a day per person (UTC), hard. */
  turnsPerDayPerson: number;
  /** Soft: no new turns once the day's measured spend reaches it; a running turn may go past it. null: none. */
  measuredMicrousdPerDay: number | null;
};
export type FlexibleTerms = {
  version: 1;
  repo: string;
  signer: string;
  /** The signer's account generation when they signed: any later change (password, role, access, removal) lapses. */
  signerGeneration: number;
  /** Who may start threads under these terms. */
  starters: FlexibleStarters;
  /** The highest level a thread may start at without a fresh proof. */
  passwordFreeUpTo: FlexibleLevel;
  /** The highest level any thread may ever run at. */
  max: FlexibleLevel;
  /** The level new threads start at. */
  default: FlexibleLevel;
  /** The project's network posture when signed: a change lapses the terms. */
  network: FlexibleNetwork;
  caps: FlexibleCaps;
};

export const FLEXIBLE_TERMS_VERSION = 1;
export const FLEXIBLE_DEFAULT_CAPS: Readonly<FlexibleCaps> = Object.freeze({ liveThreads: 3, turnsPerDayProject: 300, turnsPerDayPerson: 150, measuredMicrousdPerDay: null });
const CAP_LIMITS = { liveThreads: 20, turnsPerDayProject: 10_000, turnsPerDayPerson: 10_000, measuredMicrousdPerDay: 100_000 * 1_000_000 } as const;

export const FLEXIBLE_LEVEL_WORDS: Readonly<Record<FlexibleLevel, string>> = Object.freeze({ supervised: "Supervised", auto: "Auto", full: "Full access" });
const rank = (level: FlexibleLevel): number => FLEXIBLE_LEVELS.indexOf(level);
const lowest = (a: FlexibleLevel, b: FlexibleLevel): FlexibleLevel => (rank(a) <= rank(b) ? a : b);
export const isFlexibleLevel = (value: unknown): value is FlexibleLevel => typeof value === "string" && (FLEXIBLE_LEVELS as readonly string[]).includes(value);

/** The highest thread level an organisation ceiling allows (plan v2 §5's table): safe → Supervised, standard → Auto,
 * escalated → Full access. A ceiling this build can't name allows nothing. */
export function flexibleCeilingAllows(ceiling: PermissionLevel, level: FlexibleLevel): boolean {
  const top: FlexibleLevel | null = ceiling === "escalated" ? "full" : ceiling === "standard" ? "auto" : ceiling === "safe" ? "supervised" : null;
  return top !== null && rank(level) <= rank(top);
}

// ---- terms: bytes, digest, strict reading ---------------------------------------------------------------------------

export function flexibleTermsJson(terms: FlexibleTerms): string {
  return canonicalJson(terms);
}

/** sha256 over a domain-separated canonical encoding, 32 hex like every other safety digest here. */
export function flexibleDigestOf(terms: FlexibleTerms): string {
  return createHash("sha256").update(`standing-orders:flexible:${flexibleTermsJson(terms)}`, "utf8").digest("hex").slice(0, 32);
}

const TERMS_KEYS = ["caps", "default", "max", "network", "passwordFreeUpTo", "repo", "signer", "signerGeneration", "starters", "version"];
const CAPS_KEYS = ["liveThreads", "measuredMicrousdPerDay", "turnsPerDayPerson", "turnsPerDayProject"];
const plainObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => { const own = Object.keys(value).sort(); return own.length === keys.length && own.every((key, at) => key === keys[at]); };
const count = (value: unknown, max: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= max;
const safeText = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);

/** Whether a value is exactly a set of terms this build signs: every key, no other, every value one it can name, levels
 * in order (default ≤ password-free ≤ max). */
function validTerms(value: unknown): value is FlexibleTerms {
  if (!plainObject(value) || !exactKeys(value, TERMS_KEYS)) return false;
  const caps = value["caps"];
  if (!plainObject(caps) || !exactKeys(caps, CAPS_KEYS)) return false;
  if (!count(caps["liveThreads"], CAP_LIMITS.liveThreads) || !count(caps["turnsPerDayProject"], CAP_LIMITS.turnsPerDayProject) || !count(caps["turnsPerDayPerson"], CAP_LIMITS.turnsPerDayPerson)) return false;
  if (caps["measuredMicrousdPerDay"] !== null && !count(caps["measuredMicrousdPerDay"], CAP_LIMITS.measuredMicrousdPerDay)) return false;
  const { version, repo, signer, signerGeneration, starters, passwordFreeUpTo, max, network } = value;
  if (version !== FLEXIBLE_TERMS_VERSION || !safeText(repo, 4096) || !repo.startsWith("/") || !safeText(signer, 200)) return false;
  if (!count(signerGeneration, Number.MAX_SAFE_INTEGER)) return false;
  if (starters !== "signer" && starters !== "approvers-with-access") return false;
  if (network !== "confined" && network !== "open") return false;
  if (!isFlexibleLevel(passwordFreeUpTo) || !isFlexibleLevel(max) || !isFlexibleLevel(value["default"])) return false;
  return rank(value["default"]) <= rank(passwordFreeUpTo) && rank(passwordFreeUpTo) <= rank(max);
}

/** Strict rehydration: exactly this build's canonical bytes for exactly valid terms, else null. Never a guess. */
export function flexibleTermsFromJson(json: unknown): FlexibleTerms | null {
  if (typeof json !== "string" || json.length > 16_384) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return null; }
  if (!validTerms(parsed)) return null;
  return canonicalJson(parsed) === json ? parsed : null;
}

/** Whether `next` is the same delegation as `signed` or a narrower one: same project, signer, generation and network,
 * the same or fewer starters, no level higher and no cap wider. */
export function flexibleNarrowerOrEqual(next: FlexibleTerms, signed: FlexibleTerms): boolean {
  if (next.version !== signed.version || next.repo !== signed.repo || next.signer !== signed.signer || next.signerGeneration !== signed.signerGeneration || next.network !== signed.network) return false;
  if (next.starters !== signed.starters && next.starters !== "signer") return false;
  if (rank(next.max) > rank(signed.max) || rank(next.passwordFreeUpTo) > rank(signed.passwordFreeUpTo) || rank(next.default) > rank(signed.default)) return false;
  const a = next.caps, b = signed.caps;
  if (a.liveThreads > b.liveThreads || a.turnsPerDayProject > b.turnsPerDayProject || a.turnsPerDayPerson > b.turnsPerDayPerson) return false;
  return b.measuredMicrousdPerDay === null || (a.measuredMicrousdPerDay !== null && a.measuredMicrousdPerDay <= b.measuredMicrousdPerDay);
}

// ---- the words ------------------------------------------------------------------------------------------------------

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What Full access may and may not do (Codex round 2, required change 3): said in the terms, enforced by the thread
 * engine (F2). */
export const FULL_ACCESS_WORDS = "Full access removes the agent's permission prompts inside the sandbox only. It never lets the agent leave the sandbox, use your keychain or SSH agent, read or change Toolroll's own data, write to your repository directly, or change how agents are started. It covers the agent's own tools, its MCP servers and plugins, and every program they start. Answering an agent's request never runs anything outside the sandbox, and if the sandbox can't hold, the thread doesn't run.";

/** The open-network disclosure (required change 4), shown before consent when the project's network is open. */
export const OPEN_NETWORK_WORDS = [
  "This project's network is open. The agent can send anything it can read to any website: your code, files the sandbox allows it to read, and the conversation.",
  "If it finds a credential Toolroll missed, such as a token in a project file, it can use it, including to push code anywhere that credential reaches. Branch protection and Toolroll's own push limits don't stop a credential the agent finds itself.",
  "Turn on branch protection for your default branch anyway.",
] as const;

/** The terms in full, as the ceremony shows them and the password signs them. */
export function flexibleTermsWords(terms: FlexibleTerms): string[] {
  const who = terms.starters === "signer" ? `Only ${terms.signer} may` : "People who can approve work in this project may";
  const start = `${who} start Flexible threads at ${FLEXIBLE_LEVEL_WORDS[terms.passwordFreeUpTo]} without a password.`;
  const raise = rank(terms.max) > rank(terms.passwordFreeUpTo) ? ` A thread can be raised to ${FLEXIBLE_LEVEL_WORDS[terms.max]} with that person's password.` : "";
  const levels: string[] = [];
  if (rank(terms.max) >= rank("full")) levels.push(FULL_ACCESS_WORDS);
  if (rank(terms.max) >= rank("auto")) levels.push("Auto lets the agent run routine commands inside the sandbox and asks you before anything outside it.");
  levels.push("Supervised asks you before each command and file change.");
  const caps = terms.caps;
  const spend = caps.measuredMicrousdPerDay === null ? "" : ` New turns stop once today's measured spend reaches $${(caps.measuredMicrousdPerDay / 1_000_000).toFixed(2)}; a turn already running may go past it.`;
  return [
    `${start}${raise} New threads start at ${FLEXIBLE_LEVEL_WORDS[terms.default]}.`,
    ...levels,
    "Each thread works in its own copy of the repository, on its own branch, and can read the repository's whole history. Its work reaches your repository only when someone sends it for checks, and nothing merges unless the required check passes on that exact commit.",
    `Limits: ${plural(caps.liveThreads, "thread")} at once, ${plural(caps.turnsPerDayProject, "agent turn")} a day in this project, ${plural(caps.turnsPerDayPerson, "turn")} a day per person. A limit on turns doesn't limit what one turn costs.${spend}`,
    ...(terms.network === "open" ? OPEN_NETWORK_WORDS : []),
    "This lasts until someone turns it off or lowers it, or until your account or access changes, the project needs two people to approve, its network setting changes, or the organisation's permission ceiling drops. Turning it off or lowering it stops new threads at once.",
  ];
}

// ---- standing: what the stored terms allow right now ----------------------------------------------------------------

export type FlexibleLapse = "signer-revoked" | "signer-changed" | "signer-not-approver" | "signer-lost-access" | "two-person" | "network-changed" | "ceiling-lowered";
export const FLEXIBLE_LAPSE_WORDS: Readonly<Record<FlexibleLapse, string>> = Object.freeze({
  "signer-revoked": "The person who turned it on no longer has an account.",
  "signer-changed": "The account of the person who turned it on changed (password, role or project access).",
  "signer-not-approver": "The person who turned it on can no longer approve work.",
  "signer-lost-access": "The person who turned it on lost access to this project.",
  "two-person": "This project now needs two people to approve work.",
  "network-changed": "This project's network setting changed.",
  "ceiling-lowered": "The organisation's permission ceiling no longer allows these terms.",
});

export type FlexibleRow = { id: number; terms: FlexibleTerms; digest: string; signedDigest: string; signedBy: string; signedAt: string; changedBy: string; changedAt: string };
export type FlexibleStanding =
  | { state: "secure" }
  | ({ state: "on" } & FlexibleRow)
  | ({ state: "lapsed"; reason: FlexibleLapse } & FlexibleRow)
  | { state: "unreadable"; id: number | null };

/** The project's network posture as the terms name it. */
export function flexibleNetworkOf(store: Store, repo: string): FlexibleNetwork {
  return store.projectNetwork(repo).mode === "open" ? "open" : "confined";
}

/** Whether a project's approval rules need two people (or forbid the requester): Flexible would skip the second one. */
export function flexibleTwoPerson(store: Store, repo: string): boolean {
  const rules = store.approvalRules(repo);
  return rules.notRequester || rules.protectProject;
}

/** An account that can approve work in a project now: active, an approver, with access to it. */
function approverHere(store: Store, name: string, repo: string): { generation: number } | null {
  const account = store.accountOf(name);
  if (account === null || account.revokedAt !== null || account.role !== "approver") return null;
  return store.accountCanAccess(name, repo) ? { generation: account.generation } : null;
}

/** Why live terms no longer count, or null while they do. Read from Toolroll's own records only. */
function lapseOf(store: Store, terms: FlexibleTerms): FlexibleLapse | null {
  const account = store.accountOf(terms.signer);
  if (account === null || account.revokedAt !== null) return "signer-revoked";
  if (account.generation !== terms.signerGeneration) return "signer-changed";
  if (account.role !== "approver") return "signer-not-approver";
  if (!store.accountCanAccess(terms.signer, terms.repo)) return "signer-lost-access";
  if (flexibleTwoPerson(store, terms.repo)) return "two-person";
  if (flexibleNetworkOf(store, terms.repo) !== terms.network) return "network-changed";
  if (!flexibleCeilingAllows(store.orgPolicy().ceiling, terms.max)) return "ceiling-lowered";
  return null;
}

/** A live row, read exactly: both term sets canonical and valid, each hashing to its stored digest, the project and
 * signer matching the row, and the terms in force no wider than the signed ones. Anything else is unreadable. */
function readRow(row: Record<string, unknown>, repo: string): FlexibleRow | null {
  const terms = flexibleTermsFromJson(row["terms_json"]);
  const signed = flexibleTermsFromJson(row["signed_terms_json"]);
  if (terms === null || signed === null) return null;
  if (flexibleDigestOf(terms) !== row["digest"] || flexibleDigestOf(signed) !== row["signed_digest"]) return null;
  if (row["repo"] !== repo || terms.repo !== repo || signed.signer !== row["signed_by"] || !flexibleNarrowerOrEqual(terms, signed)) return null;
  return { id: Number(row["id"]), terms, digest: String(row["digest"]), signedDigest: String(row["signed_digest"]), signedBy: String(row["signed_by"]),
    signedAt: String(row["signed_at"]), changedBy: String(row["changed_by"]), changedAt: String(row["changed_at"]) };
}

/** What a project's Flexible terms allow right now: Secure (no live terms), on, lapsed (with why), or unreadable. */
export function flexibleStanding(store: Store, repo: string): FlexibleStanding {
  let row: Record<string, unknown> | undefined;
  try {
    row = store.handle.prepare("SELECT * FROM flexible_terms WHERE repo = ? AND ended_at IS NULL").get(repo) as Record<string, unknown> | undefined;
  } catch {
    return { state: "unreadable", id: null };
  }
  if (row === undefined) return { state: "secure" };
  const read = readRow(row, repo);
  if (read === null) return { state: "unreadable", id: Number(row["id"]) };
  const lapse = lapseOf(store, read.terms);
  return lapse === null ? { state: "on", ...read } : { state: "lapsed", reason: lapse, ...read };
}

// ---- refusals -------------------------------------------------------------------------------------------------------

export type FlexibleRefusalReason =
  | "not-available" | "not-an-approver" | "proof-required" | "two-person" | "above-ceiling" | "invalid-choice" | "terms-changed"
  | "not-flexible" | "terms-lapsed" | "terms-unreadable" | "not-lower" | "stale-generation" | "not-a-starter" | "above-max";
export type FlexibleRefusal = { ok: false; reason: FlexibleRefusalReason; message: string };

export const FLEXIBLE_UNAVAILABLE = "Flexible projects aren't available in this version. Nothing changed.";
const WORDS: Readonly<Record<Exclude<FlexibleRefusalReason, "terms-lapsed">, string>> = Object.freeze({
  "not-available": FLEXIBLE_UNAVAILABLE,
  "not-an-approver": "Only an approver for this project can do that. Nothing changed.",
  "proof-required": "Turning on Flexible needs your password, typed now. Nothing changed.",
  "two-person": "This project needs two people to approve work, so it can't be Flexible. Nothing changed.",
  "above-ceiling": "The organisation's permission ceiling doesn't allow that level. Nothing changed.",
  "invalid-choice": "Choose Supervised, Auto or Full access, with new threads starting no higher than the highest level. Nothing changed.",
  "terms-changed": "The terms changed since they were shown. Read them again before agreeing. Nothing changed.",
  "not-flexible": "This project isn't Flexible.",
  "terms-unreadable": "This project's Flexible terms can't be read, so they allow nothing. Turn Flexible off, then on again.",
  "not-lower": "Lowering can't raise a level. Turn Flexible on again, with your password, to sign higher terms. Nothing changed.",
  "stale-generation": "Your account changed since this started. Sign in again and retry.",
  "not-a-starter": "These terms let only the person who turned Flexible on start threads.",
  "above-max": "That level is above what this project's Flexible terms allow.",
});
const refuse = (reason: Exclude<FlexibleRefusalReason, "terms-lapsed">): FlexibleRefusal => ({ ok: false, reason, message: WORDS[reason] });
const lapsed = (lapse: FlexibleLapse): FlexibleRefusal => ({ ok: false, reason: "terms-lapsed", message: `This project's Flexible terms no longer count. ${FLEXIBLE_LAPSE_WORDS[lapse]} Turn it on again to sign new terms.` });

// ---- the ceremony's terms -------------------------------------------------------------------------------------------

export type FlexibleChoice = { max?: FlexibleLevel; default?: FlexibleLevel };

/** The terms a person would sign now, from Toolroll's own records: their current generation, the project's network
 * posture, and the defaults the owner chose (Full access by default, any approver of the project may start threads,
 * the default limits). The highest level defaults to the highest the organisation ceiling allows. */
export function proposedFlexibleTerms(store: Store, repo: string, signer: string, choice: FlexibleChoice = {}): { ok: true; terms: FlexibleTerms; digest: string } | FlexibleRefusal {
  const standing = approverHere(store, signer, repo);
  if (standing === null) return refuse("not-an-approver");
  if (flexibleTwoPerson(store, repo)) return refuse("two-person");
  const ceiling = store.orgPolicy().ceiling;
  const ceilingTop = ([...FLEXIBLE_LEVELS].reverse() as FlexibleLevel[]).find(level => flexibleCeilingAllows(ceiling, level)) ?? null;
  if (ceilingTop === null) return refuse("above-ceiling");
  const max = choice.max ?? ceilingTop;
  const level = choice.default ?? max;
  if (!isFlexibleLevel(max) || !isFlexibleLevel(level) || rank(level) > rank(max)) return refuse("invalid-choice");
  if (!flexibleCeilingAllows(ceiling, max)) return refuse("above-ceiling");
  const terms: FlexibleTerms = { version: FLEXIBLE_TERMS_VERSION, repo, signer, signerGeneration: standing.generation, starters: "approvers-with-access",
    passwordFreeUpTo: max, max, default: level, network: flexibleNetworkOf(store, repo), caps: { ...FLEXIBLE_DEFAULT_CAPS } };
  if (!validTerms(terms)) return refuse("invalid-choice");
  return { ok: true, terms, digest: flexibleDigestOf(terms) };
}

// ---- writers --------------------------------------------------------------------------------------------------------

const levelsWords = (terms: FlexibleTerms) => `max ${terms.max}, password-free ${terms.passwordFreeUpTo}, default ${terms.default}`;

function endRow(store: Store, id: number, reason: "off" | "lowered" | "replaced" | "lapsed", by: string, detail: string | null, now: Date): boolean {
  const ended = store.handle.prepare("UPDATE flexible_terms SET ended_at = ?, ended_by = ?, end_reason = ?, end_detail = ? WHERE id = ? AND ended_at IS NULL")
    .run(now.toISOString(), by, reason, detail, id);
  return Number(ended.changes) === 1;
}

function insertRow(store: Store, row: { repo: string; terms: FlexibleTerms; signedJson: string; signedDigest: string; signedBy: string; signedAt: string; proof: "password-now" | "sso-now"; changedBy: string; derivedFrom: number | null }, now: Date): number {
  const written = store.handle.prepare(`INSERT INTO flexible_terms (repo, terms_json, digest, signed_terms_json, signed_digest, signed_by, signed_at, proof, changed_by, changed_at, derived_from)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.repo, flexibleTermsJson(row.terms), flexibleDigestOf(row.terms), row.signedJson, row.signedDigest, row.signedBy, row.signedAt, row.proof, row.changedBy, now.toISOString(), row.derivedFrom);
  return Number(written.lastInsertRowid);
}

/**
 * Turn a project Flexible: a person's signature of exactly the terms they were shown. `proof` is the method the
 * caller's credential check returned for `by` (a password typed now or a one-use identity-provider re-check; anything
 * else is refused). Inside ONE write transaction the terms are rebuilt from the store (the signer's current generation
 * and standing, the project's rules, network and ceiling) and must hash to `shownDigest`; any live terms are replaced.
 */
export function enableFlexible(store: Store, input: { repo: string; by: string; proof: string; choice?: FlexibleChoice; shownDigest: string; now: Date }):
  { ok: true; id: number; digest: string; terms: FlexibleTerms; replaced: boolean } | FlexibleRefusal {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  if (input.proof !== "password-now" && input.proof !== "sso-now") return refuse("proof-required");
  const proof = input.proof;
  return store.transact(() => {
    const proposed = proposedFlexibleTerms(store, input.repo, input.by, input.choice ?? {});
    if (!proposed.ok) return proposed;
    if (proposed.digest !== input.shownDigest) return refuse("terms-changed");
    const live = store.handle.prepare("SELECT id FROM flexible_terms WHERE repo = ? AND ended_at IS NULL").get(input.repo);
    const replaced = live !== undefined;
    if (replaced) endRow(store, Number(live["id"]), "replaced", input.by, null, input.now);
    const json = flexibleTermsJson(proposed.terms);
    const id = insertRow(store, { repo: input.repo, terms: proposed.terms, signedJson: json, signedDigest: proposed.digest, signedBy: input.by, signedAt: input.now.toISOString(), proof, changedBy: input.by, derivedFrom: null }, input.now);
    store.recordAction({ at: input.now.toISOString(), actor: input.by, repo: input.repo, taskId: null, runId: null, source: "policy", action: "flexible turned on", outcome: "on",
      detail: `terms ${proposed.digest} · ${levelsWords(proposed.terms)} · network ${proposed.terms.network}${replaced ? " · replaced earlier terms" : ""}` });
    store.bumpWake();
    return { ok: true as const, id, digest: proposed.digest, terms: proposed.terms, replaced };
  });
}

/**
 * Lower a project's Flexible terms: any approver of the project, no password (narrowing only). The highest level
 * drops to `max`, and the password-free and default levels with it. Written as a new row under a new digest in the
 * transaction that ends the old one, so a start or a thread holding the old digest is refused from then on.
 */
export function lowerFlexible(store: Store, input: { repo: string; by: string; max: FlexibleLevel; now: Date }):
  { ok: true; changed: boolean; digest: string; terms: FlexibleTerms } | FlexibleRefusal {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  if (!isFlexibleLevel(input.max)) return refuse("invalid-choice");
  return store.transact(() => {
    if (approverHere(store, input.by, input.repo) === null) return refuse("not-an-approver");
    const standing = flexibleStanding(store, input.repo);
    if (standing.state === "secure") return refuse("not-flexible");
    if (standing.state === "unreadable") return refuse("terms-unreadable");
    if (standing.state === "lapsed") return lapsed(standing.reason);
    const current = standing.terms;
    if (rank(input.max) > rank(current.max)) return refuse("not-lower");
    const next: FlexibleTerms = { ...current, max: input.max, passwordFreeUpTo: lowest(current.passwordFreeUpTo, input.max), default: lowest(current.default, input.max) };
    if (flexibleTermsJson(next) === flexibleTermsJson(current)) return { ok: true as const, changed: false, digest: standing.digest, terms: current };
    const signed = store.handle.prepare("SELECT signed_terms_json, proof FROM flexible_terms WHERE id = ?").get(standing.id)!;
    endRow(store, standing.id, "lowered", input.by, null, input.now);
    insertRow(store, { repo: input.repo, terms: next, signedJson: String(signed["signed_terms_json"]), signedDigest: standing.signedDigest, signedBy: standing.signedBy, signedAt: standing.signedAt,
      proof: signed["proof"] === "sso-now" ? "sso-now" : "password-now", changedBy: input.by, derivedFrom: standing.id }, input.now);
    store.recordAction({ at: input.now.toISOString(), actor: input.by, repo: input.repo, taskId: null, runId: null, source: "policy", action: "flexible lowered", outcome: "lowered",
      detail: `${levelsWords(current)} → ${levelsWords(next)} · terms ${flexibleDigestOf(next)}` });
    store.bumpWake();
    return { ok: true as const, changed: true, digest: flexibleDigestOf(next), terms: next };
  });
}

/** Turn a project's Flexible off: any approver of the project, one step. Ends whatever terms are live, unreadable or
 * lapsed ones included, in one write transaction. */
export function turnFlexibleOff(store: Store, input: { repo: string; by: string; now: Date }): { ok: true; changed: boolean } | FlexibleRefusal {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  return store.transact(() => {
    if (approverHere(store, input.by, input.repo) === null) return refuse("not-an-approver");
    const live = store.handle.prepare("SELECT id FROM flexible_terms WHERE repo = ? AND ended_at IS NULL").get(input.repo);
    if (live === undefined) return { ok: true as const, changed: false };
    endRow(store, Number(live["id"]), "off", input.by, null, input.now);
    store.recordAction({ at: input.now.toISOString(), actor: input.by, repo: input.repo, taskId: null, runId: null, source: "policy", action: "flexible turned off", outcome: "off", detail: null });
    store.bumpWake();
    return { ok: true as const, changed: true };
  });
}

/**
 * End, durably, the live terms that no longer count (a lapse trigger just ran): the terms signed by `signer` after an
 * account change, or the terms of `repo` (or every project) after a rules, network or ceiling change. Called inside
 * the transaction that made the change. Best effort by design: the standing check above refuses lapsed terms on every
 * read anyway, so a failure here never blocks the change that caused it (a savepoint keeps it to itself).
 */
export function endLapsedFlexible(store: Store, which: { signer: string } | { repo: string } | "all", by: string, now: Date): number {
  const db = store.handle;
  db.exec("SAVEPOINT flexible_lapse");
  try {
    const rows = which === "all" ? db.prepare("SELECT repo, signed_by FROM flexible_terms WHERE ended_at IS NULL").all()
      : "repo" in which ? db.prepare("SELECT repo, signed_by FROM flexible_terms WHERE ended_at IS NULL AND repo = ?").all(which.repo)
      : db.prepare("SELECT repo, signed_by FROM flexible_terms WHERE ended_at IS NULL AND signed_by = ?").all(which.signer);
    let ended = 0;
    for (const row of rows) {
      const repo = String(row["repo"]);
      const standing = flexibleStanding(store, repo);
      if (standing.state !== "lapsed") continue;
      if (!endRow(store, standing.id, "lapsed", by, standing.reason, now)) continue;
      store.recordAction({ at: now.toISOString(), actor: by, repo, taskId: null, runId: null, source: "policy", action: "flexible terms lapsed", outcome: "lapsed", detail: FLEXIBLE_LAPSE_WORDS[standing.reason] });
      ended++;
    }
    db.exec("RELEASE flexible_lapse");
    return ended;
  } catch {
    db.exec("ROLLBACK TO flexible_lapse");
    db.exec("RELEASE flexible_lapse");
    return 0;
  }
}

// ---- delegation at the moment of use (F2 calls this) ----------------------------------------------------------------

/**
 * Whether a person may start a Flexible thread now, under exactly the terms they hold (Codex round 2, required change
 * 2). F2 calls it INSIDE the transaction that writes the start, so a lower or an off (each its own write transaction)
 * is either wholly before it (and the held digest is refused) or wholly after it (and the thread's next boundary sees
 * it). Re-checked: the feature is available; the project's terms are live and haven't lapsed (signer standing and
 * generation, two-person rules, network, ceiling); the held digest is the live one; the starter is an active approver
 * of the project at the generation they proved; the terms let them start; the level is within the terms and the
 * ceiling; and a level above the password-free one comes with a fresh proof. `starter` must come from a person's own
 * proof at a person's surface: a machine (the lead, a token, a chat bot) never reaches here as one.
 */
export function flexibleDelegationAtUse(store: Store, input: { repo: string; starter: { name: string; generation: number }; digest: string; level: FlexibleLevel; freshProof: boolean }):
  { ok: true; termsId: number; digest: string; terms: FlexibleTerms } | FlexibleRefusal {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  return store.transact(() => {
    const standing = flexibleStanding(store, input.repo);
    if (standing.state === "secure") return refuse("not-flexible");
    if (standing.state === "unreadable") return refuse("terms-unreadable");
    if (standing.state === "lapsed") return lapsed(standing.reason);
    if (standing.digest !== input.digest) return refuse("terms-changed");
    const account = store.accountOf(input.starter.name);
    if (account === null || account.revokedAt !== null || account.role !== "approver") return refuse("not-an-approver");
    if (account.generation !== input.starter.generation) return refuse("stale-generation");
    if (!store.accountCanAccess(input.starter.name, input.repo)) return refuse("not-an-approver");
    const terms = standing.terms;
    if (terms.starters === "signer" && input.starter.name !== terms.signer) return refuse("not-a-starter");
    if (!isFlexibleLevel(input.level) || rank(input.level) > rank(terms.max)) return refuse("above-max");
    if (!flexibleCeilingAllows(store.orgPolicy().ceiling, input.level)) return refuse("above-ceiling");
    if (rank(input.level) > rank(terms.passwordFreeUpTo) && input.freshProof !== true) return { ok: false as const, reason: "proof-required" as const, message: `Starting at ${FLEXIBLE_LEVEL_WORDS[input.level]} needs your password.` };
    return { ok: true as const, termsId: standing.id, digest: standing.digest, terms };
  });
}

// ---- the settings page's view ---------------------------------------------------------------------------------------

/** Settings → Project → How work starts: the standing, and the terms this person would sign now (or why they can't).
 * Undefined while this build doesn't offer Flexible, so no page draws it. */
export type FlexibleSettingsView = { repo: string; standing: FlexibleStanding; proposal: { terms: FlexibleTerms; digest: string } | { problem: string }; canChange: boolean };
export function flexibleSettingsView(store: Store, repo: string, viewer: { name: string; canChange: boolean }): FlexibleSettingsView | undefined {
  if (!FLEXIBLE_AVAILABLE) return undefined;
  const proposed = viewer.canChange ? proposedFlexibleTerms(store, repo, viewer.name) : refuse("not-an-approver");
  return { repo, standing: flexibleStanding(store, repo), canChange: viewer.canChange,
    proposal: proposed.ok ? { terms: proposed.terms, digest: proposed.digest } : { problem: proposed.message.replace(/ Nothing changed\.$/, "") } };
}
