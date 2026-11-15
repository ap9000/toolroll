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
import { passwordlessSetting } from "./passwordless.js";
import type { Store } from "./store.js";

export type InstallMode = "solo" | "team";
/** Why an install is team, each one a fact read now. `existing-install`: no solo declaration was ever recorded. */
export type TeamFact =
  | "existing-install" | "outdated-declaration" | "unreadable"
  | "invite-open" | "invite-added"
  | "second-person" | "person-added"
  | "token-for-someone-else" | "token-added"
  | "chat-person" | "chat-person-added"
  | "chat-group" | "chat-group-added";
/** The facts that stand now and block "It's just me"; the rest are history it may set aside. */
const LIVE_FACTS: ReadonlySet<TeamFact> = new Set(["unreadable", "invite-open", "second-person", "token-for-someone-else", "chat-person", "chat-group"]);

export type InstallModeRead = {
  mode: InstallMode;
  /** Every fact that makes it team (empty when solo). */
  facts: TeamFact[];
  /** The solo declaration in force: who made it and when (null when there is none). */
  declared: { by: string; at: string; why: DeclaredWhy } | null;
};

/** Why solo was declared: a new install's first account, the owner's "It's just me", or an upgrade of a laptop install
 * whose whole history is one person (declareSoloOnUpgrade). */
export type DeclaredWhy = "new-install" | "just-me" | "upgrade";
const WHYS: ReadonlySet<unknown> = new Set(["new-install", "just-me", "upgrade"]);
/** The ledger entry a solo declaration is: one action, `source` access, naming no project, task or run. */
export const INSTALL_MODE_ACTION = "install mode";
/** What a declaration counts (rows are revoked, never deleted, so each only grows). v2: chat identities by their fully
 * scoped key, and invitations. A v1 declaration (chat members by app and member only, no invitations) is outdated: its
 * counts can't be compared, so it no longer stands, and the owner says "It's just me" again. */
type Counts = { v: 2; people: number; tokens: number; chat: number; groups: number; invites: number };
const COUNT_KEYS = ["people", "tokens", "chat", "groups", "invites"] as const;
/**
 * One chat identity, fully scoped: the app, its installation (the bot, the workspace app), the workspace or tenant
 * (`team`: Slack's team id, Teams' tenant) and the member's id there. A member id alone is not an identity: the same id
 * in two Slack workspaces is two people. Wider than any one app needs, so it can only count more identities, never fewer.
 */
const CHAT_IDENTITIES = "SELECT DISTINCT provider, installation, team, member FROM chat_binding";

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
    v: 2,
    people: count(store, "SELECT count(*) AS n FROM approver"),
    tokens: count(store, "SELECT count(*) AS n FROM credential WHERE access = 'act' AND account <> created_by"),
    // Chat-app identities beyond the first, ever, across every chat app (identities on two apps can't be told to be the
    // same person, so a second one is a second person).
    chat: count(store, `SELECT max(0, (SELECT count(*) FROM (${CHAT_IDENTITIES})) - 1) AS n`),
    groups: count(store, "SELECT count(*) AS n FROM chat_room WHERE kind = 'group'"),
    invites: count(store, "SELECT count(*) AS n FROM invite"),
  };
}

/** The facts that say team now, whatever was declared. */
function liveFacts(store: Pick<Store, "handle">): TeamFact[] {
  const facts: TeamFact[] = [];
  // An invitation still open is a second person on the way: team from the moment it is made.
  if (Number(store.handle.prepare("SELECT count(*) AS n FROM invite WHERE consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?").get(new Date().toISOString())?.["n"] ?? 1) > 0) facts.push("invite-open");
  if (count(store, "SELECT count(*) AS n FROM approver WHERE revoked_at IS NULL") > 1) facts.push("second-person");
  if (count(store, `SELECT count(*) AS n FROM credential WHERE revoked_at IS NULL AND ${TOKEN_FOR_OTHER}`) > 0) facts.push("token-for-someone-else");
  if (count(store, `SELECT count(*) AS n FROM (${CHAT_IDENTITIES} WHERE revoked IS NULL)`) > 1
    || count(store, `SELECT count(*) AS n FROM chat_binding WHERE revoked IS NULL AND approver NOT IN (${ACTIVE_PEOPLE})`) > 0) facts.push("chat-person");
  if (count(store, "SELECT count(*) AS n FROM chat_room WHERE revoked IS NULL AND kind = 'group'") > 0) facts.push("chat-group");
  return facts;
}

/** A declaration's counts, exactly the store's own shape: "outdated" for a well-formed v1 one, null for anything else. */
function countsOf(detail: unknown): Counts | "outdated" | null {
  if (typeof detail !== "string") return null;
  let parsed: unknown;
  try { parsed = JSON.parse(detail); } catch { return null; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const counted = record["v"] === 2 ? COUNT_KEYS : record["v"] === 1 ? COUNT_KEYS.filter(key => key !== "invites") : null;
  if (counted === null) return null;
  const keys = ["v", ...counted, "why"];
  if (Object.keys(record).length !== keys.length || !keys.every(key => Object.hasOwn(record, key)) || !WHYS.has(record["why"])) return null;
  for (const key of counted) {
    const value = record[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  }
  if (record["v"] === 1) return "outdated";
  return { v: 2, people: record["people"] as number, tokens: record["tokens"] as number, chat: record["chat"] as number, groups: record["groups"] as number, invites: record["invites"] as number };
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
    if (kept === "outdated") return { mode: "team", facts: ["outdated-declaration", ...facts], declared: null };
    const now = countsNow(store);
    if (now.invites > kept.invites) facts.push("invite-added");
    if (now.people > kept.people) facts.push("person-added");
    if (now.tokens > kept.tokens) facts.push("token-added");
    if (now.chat > kept.chat) facts.push("chat-person-added");
    if (now.groups > kept.groups) facts.push("chat-group-added");
    const why = (JSON.parse(String(row!["detail"])) as { why: DeclaredWhy }).why;
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
 * at a step-up: Passwordless is on, or the install is solo and its owner never turned Passwordless off (the newest
 * Passwordless entry wins: off means a password, solo or not). Credential acts never ask this (scope.ts
 * proveCredential). Read at the act, inside its transaction.
 */
export function sessionStandsIn(store: Store): boolean {
  const setting = passwordlessSetting(store);
  if (setting.on) return true;
  if (setting.at !== null) return false;
  return soloNow(store);
}

/** The chain a new task starts with by default: solo files straight to code; team plans first. */
export const defaultChainOf = (mode: InstallMode): "just-code" | "plan-first" => mode === "solo" ? "just-code" : "plan-first";

function declare(store: Store, by: string, why: DeclaredWhy, now: Date): void {
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
  "outdated-declaration": "This install was marked solo by an earlier version. Say it's just you again.",
  "invite-open": "An invitation is open. Cancel it first.",
  "invite-added": "Someone was invited since this install became solo.",
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

/** What the ledger says when an upgrade declared solo by itself. */
export const SOLO_ON_UPGRADE_WORDS = "declared solo on upgrade: one person, nothing else ever";

/**
 * An upgrade of a laptop install (local mode on) that is provably one person: declared solo once, by itself, recorded as
 * an automatic act. Only from durable history (rows are revoked, never deleted), inside one transaction, and only when
 * no mode was ever recorded. Every one of these must hold, or it stays team:
 * - exactly one account has ever existed, the local-mode owner, active;
 * - no token was ever made by or for anyone else (any kind, any access, revoked ones included);
 * - no chat-app identity other than one, nobody else's pairing code, and never a chat group;
 * - never an invitation, nobody else's identity-provider sign-in, and no access entry in the ledger by anyone else or
 *   saying someone joined.
 * Anything unreadable stays team. Returns whether it declared.
 */
export function declareSoloOnUpgrade(store: Store, now: Date): boolean {
  try {
    return store.transact((): boolean => {
      if (store.handle.prepare("SELECT 1 AS hit FROM action_ledger WHERE action = ? LIMIT 1").get(INSTALL_MODE_ACTION) !== undefined) return false;
      const mode = store.handle.prepare("SELECT owner, enabled FROM local_mode WHERE id = 1").get();
      if (mode === undefined || Number(mode["enabled"]) !== 1) return false;
      const owner = String(mode["owner"]);
      const people = store.handle.prepare("SELECT name, revoked_at, role FROM approver").all();
      if (people.length !== 1 || people[0]!["name"] !== owner || people[0]!["revoked_at"] !== null || people[0]!["role"] !== "approver") return false;
      const none = (sql: string, ...args: string[]): boolean => {
        const n = Number(store.handle.prepare(sql).get(...args)?.["n"]);
        if (!Number.isSafeInteger(n) || n < 0) throw new Error("install mode: an unreadable count");
        return n === 0;
      };
      const clean = none("SELECT count(*) AS n FROM credential WHERE account <> ? OR created_by <> ?", owner, owner)
        && none("SELECT count(*) AS n FROM chat_binding WHERE approver <> ?", owner)
        && count(store, `SELECT count(*) AS n FROM (${CHAT_IDENTITIES})`) <= 1
        && none("SELECT count(*) AS n FROM chat_pair WHERE approver <> ?", owner)
        && none("SELECT count(*) AS n FROM chat_room WHERE kind = 'group'")
        && none("SELECT count(*) AS n FROM invite")
        && none("SELECT count(*) AS n FROM sso_identity WHERE account <> ?", owner)
        && none("SELECT count(*) AS n FROM action_ledger WHERE source = 'access' AND (actor NOT IN (?, ?, 'system') OR action IN ('joined', 'invitation created'))", owner, `operator:${owner}`)
        && liveFacts(store).length === 0;
      if (!clean) return false;
      declare(store, "system", "upgrade", now);
      store.recordAction({ at: now.toISOString(), actor: "system", repo: null, taskId: null, runId: null, action: "install mode (automatic)", outcome: "solo", source: "access", detail: SOLO_ON_UPGRADE_WORDS });
      return true;
    });
  } catch {
    return false;
  }
}

/**
 * Chat on a solo install (owner decision: chat apps notify and can approve for the owner's own paired account in solo).
 * A chat act stands in solo only from the one chat identity there is, paired by the owner through the credentialed
 * pairing: that exact binding (the app's own id for it), live, speaking for the one active person, and the only live
 * identity (fully scoped). Read inside the act's own transaction, with the mode. On a team install this says nothing:
 * the team rules decide, as before. Null when the act may go on; otherwise why not.
 */
export function soloChatSeatRefusal(store: Pick<Store, "handle">, seat: { provider: string; binding: number | undefined; approver: string }): string | null {
  const refusal = "On this install, chat acts come only from the chat account its owner paired. Nothing was done.";
  try {
    if (!soloNow(store)) return null;
    if (seat.binding === undefined) return refusal;
    const people = store.handle.prepare("SELECT name FROM approver WHERE revoked_at IS NULL").all();
    const live = store.handle.prepare("SELECT provider, id, approver FROM chat_binding WHERE revoked IS NULL").all();
    const mine = live.find(row => row["provider"] === seat.provider && Number(row["id"]) === seat.binding);
    if (people.length !== 1 || people[0]!["name"] !== seat.approver || mine === undefined || mine["approver"] !== seat.approver) return refusal;
    return count(store, `SELECT count(*) AS n FROM (${CHAT_IDENTITIES} WHERE revoked IS NULL)`) === 1 ? null : refusal;
  } catch {
    return refusal;
  }
}
