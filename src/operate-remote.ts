/**
 * Running a command on a central server for a person who signed in with their own API token
 * (`runOperateAs` in operate.ts). The machine contract is the allowlist: every row states `remote`
 * (src/surface.ts), and only "yes" rows run. This module holds what that boundary decides before any
 * command code runs — which row an argv is, whether the person and token still stand, and which
 * project the command touches — and the per-run state the credential paths in operate.ts consult so
 * a remote run is always the person and never this machine's owner.
 */
import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import type { Store } from "./store.js";
import type { LedgerSource } from "./action-ledger.js";
import { COMMAND_GUIDE, type CommandRow } from "./surface.js";

/** Who a remote call is, as the transport proved it from an `so_` token. */
export type Principal = {
  kind: "person";
  account: string;
  /** The account's credential generation when the token was checked. */
  generation: number;
  scope: "read" | "act";
  tokenId: string;
  /** The projects the person may use (null: all of them). */
  projects: string[] | null;
};

export type RemoteSource = Extract<LedgerSource, "api" | "mcp">;

export { activeRemote, withRemote, type RemoteRun } from "./remote-run.js";

/** Thrown where a remote run reaches something only this machine's owner may use; the command ends refused. */
export class RemoteRefusal extends Error {
  constructor(readonly reason: string, message: string) {
    super(message);
  }
}

export const REMOTE_MESSAGES = {
  "step-up": "Approvals, people and policy changes aren't taken from a token: approve in the console or chat.",
  no: "That command only runs on the server's own machine, not for a remote caller.",
  unknown: "That isn't a command a remote caller can run.",
  read: "Your token reads only. Use an act token for this command.",
  stale: "Your sign-in changed since this token was checked. Sign in again.",
  credential: "Remote commands run as your token's person: leave out --as, --token, --db and other credential or file flags.",
  project: "Name a project you have access to with --repo (its path on the server).",
  task: "No task by that id in your projects.",
  installation: "This command covers every project; it needs access to all projects.",
  files: "Send that file with the request; the server reads no paths of its own for you.",
} as const;

/**
 * How a "yes" command finds the project it touches, before it runs. Any --repo given is checked too.
 *  installation — reads or acts across every project: only for someone with access to all of them.
 *  repo — needs --repo, naming a project the server knows and the person may use.
 *  task — positional[at] is a task id; its stored project must be one the person may use.
 *  self — the command already narrows to the person's own projects (their access is passed in).
 *  global — touches no project's data.
 */
export type RemoteScope = { kind: "installation" } | { kind: "repo" } | { kind: "task"; at: number } | { kind: "self" } | { kind: "global" };

const installation: RemoteScope = { kind: "installation" }, repo: RemoteScope = { kind: "repo" }, self: RemoteScope = { kind: "self" }, global: RemoteScope = { kind: "global" };
const task = (at: number): RemoteScope => ({ kind: "task", at });

/** Every "yes" row's scope. The remote test holds this to the guide's "yes" rows exactly. */
export const REMOTE_SCOPES: ReadonlyMap<string, RemoteScope> = new Map<string, RemoteScope>([
  ["status", installation], ["integrations", installation], ["ready", installation], ["grants", installation], ["sync", installation],
  ["gaps", repo], ["task add", repo],
  ...["ask", "checks", "add-tests", "show", "wait", "complete", "revise", "state", "block", "unblock", "next", "steer", "assign", "scope", "plan", "hold",
    "unhold", "require", "requeue", "regate", "review", "repair", "route", "reopen", "stop", "resume"].map(action => [`task ${action}`, task(1)] as [string, RemoteScope]),
  ["check-progress", task(0)],
  ["task list", installation],
  ["runner list", installation], ["coordinator list", installation], ["outbox list", installation], ["incident list", installation], ["incident resolve", installation],
  ["cap list", repo], ["cap add", repo],
  ...["list", "show", "add", "refresh", "pause", "resume", "run-now"].map(action => [`routine ${action}`, installation] as [string, RemoteScope]),
  ["config show", installation], ["verify show", repo], ["intake show", installation], ["intake run", installation], ["intake preview", installation],
  ["intake pr-comments", installation], ["template list", installation], ["template show", installation], ["contest show", installation],
  ["contest exclude", installation], ["webhook status", installation], ["webhook test", installation], ["review show", installation],
  ["chat-approval show", self], ["chat-approval off", self],
  ["knowledge search", repo], ["knowledge impact", repo], ["knowledge refresh", repo],
  ...["search", "decisions", "show", "decide", "retire", "propose", "review", "status"].map(action => [`memory ${action}`, self] as [string, RemoteScope]),
  ...["list", "show", "export", "create", "edit", "trigger add", "trigger pause", "trigger resume", "trigger remove", "card add", "archive"]
    .map(action => [`flows ${action}`, self] as [string, RemoteScope]),
  ["models status", global], ["models list", global],
]);

/** Flags a remote caller never passes: who they are comes from the token, and the server reads and writes no paths for them. */
export const REMOTE_REFUSED_FLAGS: ReadonlySet<string> = new Set([
  "db", "as", "token", "token-file", "token-env", "password", "key-file", "credentials", "containment", "out", "project-root", "bin", "port", "host",
]);

/**
 * The guide row an argv is: the longest invocation its command and leading positionals spell. A command with no
 * row of its own runs nowhere remotely (backup, restore, storage, ledger, policy and the rest).
 */
export function remoteRowOf(command: string, positional: readonly string[]): CommandRow | null {
  for (let words = Math.min(positional.length, 2); words >= 0; words -= 1) {
    const invocation = [command, ...positional.slice(0, words)].join(" ");
    const row = COMMAND_GUIDE.find(one => one.invocation === invocation && one.invocation !== "");
    if (row !== undefined) return row;
  }
  return null;
}

/**
 * Re-prove the principal now, against the store: the account still stands at the same generation, the token is
 * the person's, unrevoked and unexpired, and the scope is no wider than the token's or the person's role.
 */
export function reproveRemote(store: Store, principal: Principal, now: Date): { ok: true; scope: "read" | "act"; tokenName: string } | { ok: false } {
  if (principal === null || typeof principal !== "object" || principal.kind !== "person" || typeof principal.account !== "string" || typeof principal.tokenId !== "string") return { ok: false };
  const account = store.accountOf(principal.account);
  if (account === null || account.revokedAt !== null || account.generation !== principal.generation) return { ok: false };
  const token = store.apiTokenSecret(principal.tokenId)?.row ?? null;
  if (token === null || token.account !== principal.account || token.revokedAt !== null || Date.parse(token.expiresAt) <= now.getTime()) return { ok: false };
  const scope = principal.scope === "act" && token.access === "act" && account.role === "approver" ? "act" : "read";
  return { ok: true, scope, tokenName: token.name };
}

/** Whether the person may use `repo`: inside their token's projects and their account's current access. Null is "every project". */
export function remoteAllows(store: Store, principal: Principal, repo: string | null): boolean {
  if (principal.projects !== null && (repo === null || !principal.projects.includes(repo))) return false;
  return store.accountCanAccess(principal.account, repo);
}

/** The project a command touches, or why it may not run: --repo must be a project the server knows, by its exact path. */
export function remoteProjectOf(
  store: Store,
  run: { allows: (repo: string | null) => boolean },
  scope: RemoteScope,
  positional: readonly string[],
  repos: readonly string[],
): { ok: true; repo: string | null; taskId: string | null } | { ok: false; reason: string; message: string } {
  const known = store.knownRepos();
  for (const given of repos) {
    if (!isAbsolute(given) || !known.includes(given) || !run.allows(given)) return { ok: false, reason: "unknown-project", message: REMOTE_MESSAGES.project };
  }
  const named = repos[0] ?? null;
  switch (scope.kind) {
    case "global":
    case "self":
      return { ok: true, repo: named, taskId: null };
    case "installation":
      return run.allows(null) ? { ok: true, repo: named, taskId: null } : { ok: false, reason: "all-projects", message: REMOTE_MESSAGES.installation };
    case "repo":
      return named === null ? { ok: false, reason: "unknown-project", message: REMOTE_MESSAGES.project } : { ok: true, repo: named, taskId: null };
    case "task": {
      const id = positional[scope.at];
      const ref = id === undefined ? null : store.lookupRef(id);
      if (id === undefined || ref === null || !run.allows(ref.repo ?? null)) return { ok: false, reason: "unknown-task", message: REMOTE_MESSAGES.task };
      if (named !== null && named !== ref.repo) return { ok: false, reason: "unknown-task", message: REMOTE_MESSAGES.task };
      return { ok: true, repo: ref.repo ?? null, taskId: id };
    }
  }
}

export function remoteSecret(): string {
  return `remote:${randomBytes(24).toString("base64url")}`;
}
