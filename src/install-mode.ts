/**
 * Solo or team (docs/plans/solo-workbench.md, principle 2 "Solo visible, team silent"; Week 1 "Mode derivation").
 *
 * The mode is a fact the server derives, never a choice a request, a header or a client makes: `installModeNow` reads
 * it from the store, inside whatever transaction the caller holds, the way `localOwnerStandsNow` is read. Nothing here
 * takes input from a request.
 *
 * - **Solo**: one person on their own install. Their own tokens, their lead and their coordinators keep it solo (a
 *   token never approves), and so does the same account on a phone (a session, a push subscription, a passkey).
 * - **Team**: a second person (an invite accepted, a person added, an identity-provider sign-in that made an account),
 *   an acting token for someone else, a second chat-app user with authority, or a chat group.
 *
 * Solo stands only on a recorded declaration (`install mode` · `solo` in the action ledger): written by the door that
 * makes a new install's first account, or by the owner's own "It's just me" (a credential act). An install with no
 * declaration (every install from before this, a restored old backup) is team: nothing about an existing install widens
 * by itself. The declaration keeps a count of the people, tokens for others, chat users and chat groups there were when
 * it was made; rows are revoked, never deleted, so any count that grew since is a second person who joined after it, and
 * the install is team from that row on, even once that person is removed. It never drops back to solo silently: only
 * a new "It's just me", which refuses while any live fact says team.
 *
 * Fail closed: anything unreadable is team.
 */
import { passwordlessOn } from "./passwordless.js";
import type { Store } from "./store.js";

export type InstallMode = "solo" | "team";
/** Why an install is team, each one a fact read now. `existing-install`: no solo declaration was ever recorded. */
export type TeamFact =
  | "existing-install" | "unreadable"
  | "second-person" | "person-added"
  | "token-for-someone-else" | "token-added"
  | "chat-person" | "chat-person-added"
  | "chat-group" | "chat-group-added";
/** The facts that stand now and block "It's just me"; the rest are history it may set aside. */
const LIVE_FACTS: ReadonlySet<TeamFact> = new Set(["unreadable", "second-person", "token-for-someone-else", "chat-person", "chat-group"]);

export type InstallModeRead = {
  mode: InstallMode;
  /** Every fact that makes it team (empty when solo). */
  facts: TeamFact[];
  /** The solo declaration in force: who made it and when (null when there is none). */
  declared: { by: string; at: string; why: "new-install" | "just-me" } | null;
};

/** The ledger entry a solo declaration is: one action, `source` access, naming no project, task or run. */
export const INSTALL_MODE_ACTION = "install mode";
/** What a declaration counts (rows are revoked, never deleted, so each only grows). */
type Counts = { v: 1; people: number; tokens: number; chat: number; groups: number };

const ACTIVE_PEOPLE = "SELECT name FROM approver WHERE revoked_at IS NULL";
/** A token that acts for someone else: minted by one account for another, or one whose account is no active person. */
const TOKEN_FOR_OTHER = `access = 'act' AND (account <> created_by OR account NOT IN (${ACTIVE_PEOPLE}))`;

function count(store: Pick<Store, "handle">, sql: string): number {
  const n = Number(store.handle.prepare(sql).get()?.["n"]);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("install mode: an unreadable count");
  return n;
}

/** The counts a declaration keeps, read now. */
function countsNow(store: Pick<Store, "handle">): Counts {
  return {
    v: 1,
    people: count(store, "SELECT count(*) AS n FROM approver"),
    tokens: count(store, "SELECT count(*) AS n FROM credential WHERE access = 'act' AND account <> created_by"),
    // Chat-app users beyond one per app, ever: a second member on the same app is a second person.
    chat: count(store, "SELECT (SELECT count(*) FROM (SELECT DISTINCT provider, member FROM chat_binding)) - (SELECT count(DISTINCT provider) FROM chat_binding) AS n"),
    groups: count(store, "SELECT count(*) AS n FROM chat_room WHERE kind = 'group'"),
  };
}

/** The facts that say team now, whatever was declared. */
function liveFacts(store: Pick<Store, "handle">): TeamFact[] {
  const facts: TeamFact[] = [];
  if (count(store, "SELECT count(*) AS n FROM approver WHERE revoked_at IS NULL") > 1) facts.push("second-person");
  if (count(store, `SELECT count(*) AS n FROM credential WHERE revoked_at IS NULL AND ${TOKEN_FOR_OTHER}`) > 0) facts.push("token-for-someone-else");
  if (count(store, `SELECT count(*) AS n FROM (SELECT provider FROM chat_binding WHERE revoked IS NULL GROUP BY provider HAVING count(DISTINCT member) > 1)`) > 0
    || count(store, `SELECT count(*) AS n FROM chat_binding WHERE revoked IS NULL AND approver NOT IN (${ACTIVE_PEOPLE})`) > 0) facts.push("chat-person");
  if (count(store, "SELECT count(*) AS n FROM chat_room WHERE revoked IS NULL AND kind = 'group'") > 0) facts.push("chat-group");
  return facts;
}

function countsOf(detail: unknown): Counts | null {
  if (typeof detail !== "string") return null;
  let parsed: unknown;
  try { parsed = JSON.parse(detail); } catch { return null; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const keys = ["v", "people", "tokens", "chat", "groups", "why"];
  if (Object.keys(record).length !== keys.length || !keys.every(key => Object.hasOwn(record, key))) return null;
  if (record["v"] !== 1 || (record["why"] !== "new-install" && record["why"] !== "just-me")) return null;
  for (const key of ["people", "tokens", "chat", "groups"]) {
    const value = record[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  }
  return { v: 1, people: record["people"] as number, tokens: record["tokens"] as number, chat: record["chat"] as number, groups: record["groups"] as number };
}

/**
 * The install's mode, derived now from the store alone. Call it inside the act's own transaction: a second person added
 * a moment ago (in this transaction or the last) is already team here.
 */
export function installModeNow(store: Pick<Store, "handle">): InstallModeRead {
  try {
    const facts = liveFacts(store);
    const row = store.handle.prepare(`SELECT actor, at, outcome, detail FROM action_ledger
      WHERE action = ? AND source = 'access' AND repo IS NULL AND task_id IS NULL AND run_id IS NULL ORDER BY id DESC LIMIT 1`).get(INSTALL_MODE_ACTION);
    const kept = row === undefined || row["outcome"] !== "solo" ? null : countsOf(row["detail"]);
    if (kept === null) return { mode: "team", facts: ["existing-install", ...facts], declared: null };
    const now = countsNow(store);
    if (now.people > kept.people) facts.push("person-added");
    if (now.tokens > kept.tokens) facts.push("token-added");
    if (now.chat > kept.chat) facts.push("chat-person-added");
    if (now.groups > kept.groups) facts.push("chat-group-added");
    const why = (JSON.parse(String(row!["detail"])) as { why: "new-install" | "just-me" }).why;
    return { mode: facts.length === 0 ? "solo" : "team", facts, declared: { by: String(row!["actor"]), at: String(row!["at"]), why } };
  } catch {
    return { mode: "team", facts: ["unreadable"], declared: null };
  }
}

/** Whether the install is solo now (fail closed: anything unreadable is team). */
export function soloNow(store: Pick<Store, "handle">): boolean {
  return installModeNow(store).mode === "solo";
}

/**
 * Whether a person's own signed-in session (or, at this computer's CLI, its remembered login) stands in for a password
 * at a step-up: Passwordless is on, or the install is solo. Credential acts never ask this (scope.ts proveCredential).
 * Read at the act, inside its transaction.
 */
export function sessionStandsIn(store: Store): boolean {
  return passwordlessOn(store) || soloNow(store);
}

/** The chain a new task starts with by default: solo files straight to code; team plans first. */
export const defaultChainOf = (mode: InstallMode): "just-code" | "plan-first" => mode === "solo" ? "just-code" : "plan-first";

function declare(store: Store, by: string, why: "new-install" | "just-me", now: Date): void {
  const counts = countsNow(store);
  store.recordAction({ at: now.toISOString(), actor: by, repo: null, taskId: null, runId: null, action: INSTALL_MODE_ACTION, outcome: "solo", source: "access",
    detail: JSON.stringify({ ...counts, why }) });
}

/**
 * A new install's first account (store.ts bootstrapApproverIfNone, initLocalMode): solo, recorded, inside the door's own
 * transaction. Only when this one person is all there is: anything else stays team.
 */
export function declareNewInstallSolo(store: Store, owner: string, now: Date): void {
  if (count(store, "SELECT count(*) AS n FROM approver") !== 1 || store.accountOf(owner) === null) return;
  if (liveFacts(store).length > 0) return;
  declare(store, owner, "new-install", now);
}

export type JustMeResult = { ok: true } | { ok: false; reason: "already-solo" | "not-owner" | "team"; facts: TeamFact[] };

/**
 * "It's just me": the owner says this install is one person again (an existing install, or one a second person has
 * since left). The caller has proved a credential act (a password typed now) inside the same transaction; this re-reads
 * every fact there and refuses while any says team. Recorded with who and when.
 */
export function declareJustMe(store: Store, by: string, now: Date): JustMeResult {
  return store.transact((): JustMeResult => {
    const read = installModeNow(store);
    if (read.mode === "solo") return { ok: false, reason: "already-solo", facts: [] };
    const blocking = read.facts.filter(fact => LIVE_FACTS.has(fact));
    if (blocking.length > 0) return { ok: false, reason: "team", facts: blocking };
    const account = store.accountOf(by);
    if (account === null || account.revokedAt !== null || account.role !== "approver" || !store.isInstanceOperator(by)) return { ok: false, reason: "not-owner", facts: [] };
    declare(store, by, "just-me", now);
    return { ok: true };
  });
}

/** Whether "It's just me" could be offered now: team, with no live fact saying so (history alone). */
export function justMeAllowed(read: InstallModeRead): boolean {
  return read.mode === "team" && read.facts.every(fact => !LIVE_FACTS.has(fact));
}

/** Each fact in words a person can act on. */
export const TEAM_FACT_WORDS: Readonly<Record<TeamFact, string>> = Object.freeze({
  "existing-install": "This install was set up before solo mode.",
  unreadable: "Toolroll couldn't read who uses this install.",
  "second-person": "Another person has an account here. Remove them first.",
  "person-added": "Another person joined since this install became solo.",
  "token-for-someone-else": "A token acts for someone else. Revoke it first.",
  "token-added": "A token for someone else was made since this install became solo.",
  "chat-person": "Someone else can act through a chat app. Unpair them first.",
  "chat-person-added": "Someone else paired a chat app since this install became solo.",
  "chat-group": "A chat group follows this install. Remove it first.",
  "chat-group-added": "A chat group was added since this install became solo.",
});

/** The one line Settings → General shows. */
export function installModeLine(mode: InstallMode): { label: "Solo" | "Team"; words: string } {
  return mode === "solo"
    ? { label: "Solo", words: "Just you. Approvals need no password; sign-in, tokens and connections still do." }
    : { label: "Team", words: "More than one person can use this install." };
}
