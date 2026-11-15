/**
 * Redeeming a one-time sign-in link: the ONE admission both roads use — the browser's GET /login/once/<code>
 * (people-tokens.ts signInLink) and a terminal client's POST /login/once (engine-api.ts redeemLink) — so the two can
 * never drift. In order:
 *
 * 1. spendLink: the code is looked up by its hash and spent at once, whatever happens next, by either road.
 * 2. admitLink: from this computer only (no forwarding of any kind), the link unexpired, its account an active approver
 *    allowed a password sign-in (an identity-provider-only account is refused), and a terminal client only a local
 *    owner's link.
 * 3. saveLinkSession: in the same transaction as the session is saved, the link's credential is read again — a local
 *    owner's: local mode still on for the same owner at the link's local and account generations; a full one's: the
 *    account still an active approver with a password at the link's generation — and the session carries the key fields
 *    the caller issued (bound to this console start's epoch).
 *
 * The roads differ only in what they add around it: the terminal road refuses anything browser-shaped first, and always
 * issues its session a key (mutation-key.ts issueForClient); each answers in its own format.
 */
import type { IncomingMessage } from "node:http";
import { localOwnerBinding } from "../store.js";
import type { ServerRuntime } from "./runtime.js";
import { FULL_SESSION, type Session, type SignInLink } from "./session.js";

export type LinkRoad = "browser" | "terminal";
type Runtime = Pick<ServerRuntime, "signInLinks" | "linkKey" | "fromThisComputer" | "store" | "passwordAllowed" | "sessions" | "recordSignIn" | "arrival" | "defaultProject">;
/** Why a link was refused, and the status each road answers with. */
export type LinkRefusal = { status: 403 | 410; why: "elsewhere" | "used" | "local-owner" | "account" | "provider" };
const CODE = /^[A-Za-z0-9_-]{43}$/;

/** The link this code names, spent now (or undefined: no such link, or a code of the wrong shape). */
export function spendLink(runtime: Pick<Runtime, "signInLinks" | "linkKey">, code: string | null): SignInLink | undefined {
  if (code === null || !CODE.test(code)) return undefined;
  const key = runtime.linkKey(code);
  const held = runtime.signInLinks.get(key);
  if (held !== undefined) runtime.signInLinks.delete(key);
  return held;
}

/** Whether this spent link may become a session for this request, by this road. A refused presentation from another
 * device is noted (the account it named, never the link). */
export function admitLink(runtime: Runtime, request: IncomingMessage, held: SignInLink | undefined, road: LinkRoad): { ok: true; held: SignInLink } | { ok: false; refusal: LinkRefusal } {
  const refuse = (status: 403 | 410, why: LinkRefusal["why"]) => ({ ok: false as const, refusal: { status, why } });
  if (!runtime.fromThisComputer(request)) {
    runtime.recordSignIn(held?.account ?? "unknown account", "sign-in refused", road === "terminal" ? "one-time link (terminal)" : "one-time link", "opened from another device");
    return refuse(403, "elsewhere");
  }
  if (held === undefined || held.expires < Date.now()) return refuse(410, "used");
  if (road === "terminal" && held.kind !== "local-owner") return refuse(403, "local-owner");
  const account = runtime.store.accountOf(held.account);
  if (account === null || account.role !== "approver" || account.revokedAt !== null) return refuse(403, "account");
  if (!runtime.passwordAllowed(held.account)) return refuse(403, "provider");
  return { ok: true, held };
}

/**
 * The session for an admitted link, saved in one transaction with the link's credential read again there; false when it
 * no longer stands (local mode moved, a password changed, the account changed). The sign-in is noted on success.
 */
export function saveLinkSession(runtime: Runtime, request: IncomingMessage, held: SignInLink, road: LinkRoad,
  made: { id: string; csrf: string; keys: Pick<Session, "keyEpoch" | "keyHash"> }): boolean {
  const { store, sessions } = runtime;
  const at = Date.now();
  const base = { ...runtime.arrival(request), name: held.account, csrf: made.csrf, role: "approver" as const, createdAt: at, lastSeen: at, sawBoardAt: null,
    project: runtime.defaultProject, projectRevision: 1 };
  const saved = store.transact(() => {
    if (held.kind === "local-owner") {
      // A local owner's link becomes only a local-owner session, and only while local mode is on at the link's
      // generation for the same owner, whose account generation hasn't moved (a password set since ended this road).
      const now = localOwnerBinding(store);
      if (now === null || now.account !== held.account || now.localGeneration !== held.localGeneration || now.accountGeneration !== held.accountGeneration) return false;
      sessions.set(made.id, { ...base, generation: now.accountGeneration, authority: "local-owner", localGeneration: now.localGeneration, ...made.keys });
      return true;
    }
    // A full link stands only on the credential it was minted under (a password changed or reset since, a removal, a
    // role or access change, ends it).
    const now = store.accountOf(held.account);
    if (now === null || now.role !== "approver" || now.revokedAt !== null || !now.passwordSet || now.generation !== held.accountGeneration) return false;
    sessions.set(made.id, { ...base, generation: held.accountGeneration, ...FULL_SESSION, ...made.keys });
    return true;
  });
  if (saved) runtime.recordSignIn(held.account, "signed in", road === "terminal" ? "local link (terminal)" : held.kind === "local-owner" ? "local link" : "one-time link");
  return saved;
}
