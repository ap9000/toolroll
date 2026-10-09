/** Browser sessions and the signed-in caller of a request. */
import { type ChatDraft } from "../converse.js";
import { type Principal } from "../operate-remote.js";
import { type Store } from "../store.js";
import { createHash } from "node:crypto";
import { type Server } from "node:http";

/** A user agent, reduced to safe display words — never echoed raw. */
export function oneLineUa(raw: string | string[] | undefined): string {
  const text = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
  if (/iphone|ipad/i.test(text)) return "an iPhone or iPad";
  if (/android/i.test(text)) return "an Android device";
  if (/mac os/i.test(text)) return "a Mac";
  if (/windows/i.test(text)) return "a Windows machine";
  return "a device";
}

export const SESSION_COOKIE = "standing-orders_session";
/** Stands in for "no project" in a ceiling: no folder resolves to it, so it admits nothing. */
export const NO_PROJECT = "/\0no-project";
/** Where `up`'s one-time sign-in link points, and how long it works. */
export const SIGN_IN_LINK_PATH = "/login/once/";
export const SIGN_IN_LINK_MS = 10 * 60_000;
/** A cookie idles out after half a day and dies outright after a week. */
export const SESSION_IDLE_MS = 12 * 60 * 60_000;
export const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60_000;
/** An approval nonce is a rendered form, not a standing right — it ages out fast. */
export const NONCE_TTL_MS = 15 * 60_000;
export const NONCE_CAP = 500;

/** Read-only fragment polls that must never refresh session activity (arc 1). */
export const NO_TOUCH_FRAGMENTS: ReadonlySet<string> = new Set(["1", "facts", "peek", "rail", "transcript"]);


export type Session = {
  name: string;
  csrf: string;
  /** v29: the account's standing at login — the central gate reads it;
   * the revocation cascade kills the session outright. */
  role: "approver" | "viewer";
  /** The approver generation at login: credential rotation kills the cookie. */
  generation: number;
  createdAt: number;
  lastSeen: number;
  /** The open project — a VIEW FILTER chosen inside the ceiling, never authorization. */
  project: string | null;
  /** Bumped on every open: stale tabs carry the revision they were rendered under. */
  projectRevision: number;
  /** v100: signed in with the identity provider, and when it last checked them (a step-up within 10 minutes needs no password). */
  sso?: { at: number };
  /** v101: the browser and address it signed in from, for the person to recognise it. */
  agent?: string | null;
  address?: string | null;
  /** Onboarding preview records (arc: repo onboarding, finding 14) —
   * session-held, swept at mint, at most 3, consumed exactly once. */
  onboard?: Map<string, { nameWithOwner: string; rootIndex: number; target: string; diskUsageKib: number | null; large: boolean; mintedAt: number }>;
  /** When this session last READ the board — the anchor for "since you
   * last looked". Full page loads move it; fragment polls never do. */
  sawBoardAt: number | null;
  /** Fleet chat (v13): drafts and the last reply live HERE and nowhere
   * durable — restart or logout loses them by design (v2 finding 12). */
  chat?: SessionChat;
  /** Editor links (arc 6): the SESSION's half of the activation — "this
   * browser runs on the machine that holds the worktrees" is a statement
   * only the person at the browser can make. Dies with the session. */
  editorLinks?: boolean;
};

export type ChatCandidate = {
  key: string;
  draft: ChatDraft;
  /** Resolved server-side at parse time from the opaque repoId. */
  repoPath: string;
  provider: string;
  approver: string;
  /** Digest of the frozen explicit repo list at turn time — filing
   * re-proves it (v2 new finding 5). */
  ceilingDigest: string;
  createdAt: number;
  state: "pending" | "filing";
};

export type SessionChat = {
  candidates: Map<string, ChatCandidate>;
  lastTurn: { id: number; reply: string | null; staticError: string | null; proposalsDiscarded: boolean } | null;
};

/** One rendered approval form: who saw which digest of which task, once. */
export type ApprovalNonce = {
  name: string;
  taskId: string;
  digest: string;
  expiresAt: number;
};

export type Who = { name: string; via: "cookie"; session: Session; role: "approver" | "viewer" } | { name: string; via: "bearer"; role: "approver" | "viewer"; /** v101: the API token it came with. */ token?: string;
  /** The complete proved API-token authority, retained across body reads. */ principal?: Principal; generation: number };

/** The browser session of a caller its route admits only through a browser sign-in (the row's callers or role). */
export function browserCaller(who: Who): Extract<Who, { via: "cookie" }> {
  if (who.via !== "cookie") throw new Error("A browser-only route reached its handler without a browser session.");
  return who;
}

/**
 * v101: browser sessions in memory and in the database (by a hash of the
 * cookie, never the cookie), so a restart signs no one out and a person can
 * see and end their sessions. The in-memory map is the working set; a cookie
 * it hasn't seen is looked up by its hash.
 */
export class PersistentSessions extends Map<string, Session> {
  private readonly ids = new WeakMap<Session, string>();
  private readonly savedAt = new WeakMap<Session, number>();
  constructor(private readonly db: Store) { super(); }
  static hash(id: string): string { return createHash("sha256").update(id, "utf8").digest("hex"); }
  override set(id: string, session: Session): this {
    super.set(id, session);
    this.ids.set(session, id);
    this.persist(session);
    return this;
  }
  override delete(id: string): boolean {
    this.db.dropWebSession(PersistentSessions.hash(id));
    return super.delete(id);
  }
  /** Keep a changed session (its project, its provider check); `seen` only once a minute. */
  persist(session: Session, seen = false): void {
    const id = this.ids.get(session);
    if (id === undefined || (seen && Date.now() - (this.savedAt.get(session) ?? 0) < 60_000)) return;
    this.savedAt.set(session, Date.now());
    this.db.saveWebSession({ idHash: PersistentSessions.hash(id), account: session.name, csrf: session.csrf, role: session.role, generation: session.generation, createdAt: session.createdAt,
      lastSeen: session.lastSeen, project: session.project, projectRevision: session.projectRevision, ssoAt: session.sso?.at ?? null, agent: session.agent ?? null, address: session.address ?? null });
  }
  /** A cookie from before a restart, if its session is still kept. */
  load(id: string): Session | null {
    const row = this.db.webSession(PersistentSessions.hash(id));
    if (row === null) return null;
    const session: Session = { name: row.account, csrf: row.csrf, role: row.role, generation: row.generation, createdAt: row.createdAt, lastSeen: row.lastSeen, sawBoardAt: null,
      project: row.project, projectRevision: row.projectRevision, agent: row.agent, address: row.address, ...(row.ssoAt === null ? {} : { sso: { at: row.ssoAt } }) };
    super.set(id, session);
    this.ids.set(session, id);
    this.savedAt.set(session, Date.now());
    return session;
  }
  /** End one session by its kept hash (from the Sessions page). */
  endByHash(idHash: string): void {
    for (const id of [...this.keys()]) if (PersistentSessions.hash(id) === idHash) super.delete(id);
    this.db.dropWebSession(idHash);
  }
  hashOf(session: Session): string | null { const id = this.ids.get(session); return id === undefined ? null : PersistentSessions.hash(id); }
}

/** The console's server, and the one-time sign-in link `up` opens: a path on this server, or null for no such approver.
 * closeCoding starts the coding shutdown on its own, ahead of the rest of a stop; close() awaits the same promise. */
export type DecisionServer = Server & { mintSignInLink(account: string): string | null; closeCoding(): Promise<void> };
  // v100: sign-in with the identity provider. A visit waits for the provider (15 minutes); a hand-off
  // carries the proved person from the callback (reached from the provider's site, so without the
  // Strict session cookie) to /login/sso/finish on this site (a minute).
  export type SsoIntent = "sign-in" | "reauth" | "link";
