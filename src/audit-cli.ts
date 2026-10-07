/**
 * `toolroll audit`: who did what on this server with their API tokens (remote-audit.ts). On the server's own machine
 * it lists everyone; run remotely it is the caller's own view — an approver sees everyone within their projects, a
 * viewer only themselves. `--token` names a token locally; remotely, where `--token` is always a refused credential
 * flag, the same filter is `--token-name`.
 */
import { basename } from "node:path";
import { checkedEnvelopeJson } from "./contracts/cli.js";
import type { RemoteRun } from "./remote-run.js";
import { AUDIT_LIMIT, AUDIT_SOURCES, cursorOf, OWNER_READER, remoteAudit, sinceOf, type AuditAction, type AuditFilters, type AuditReader, type AuditSource } from "./remote-audit.js";
import type { Store } from "./store.js";

const EXIT = { ok: 0, usage: 2, refused: 3 } as const;
const COMMAND = "audit";
const FLAGS = new Set(["person", "token", "token-name", "source", "since", "limit", "cursor", "json", "db"]);
export const AUDIT_USAGE = "Use audit [--person <name>] [--token <name>] [--source api|mcp] [--since <days>d] [--limit <n>] [--cursor <id>] [--json].";

type AuditContext = { store: Store; write: (s: string) => void; json: boolean; now: Date; principal?: RemoteRun };

/** The reader a run is: the machine's owner locally, else the remote caller with their role and projects. */
export function readerOf(store: Store, remote: RemoteRun | undefined): AuditReader {
  if (remote === undefined) return OWNER_READER;
  const role = store.accountOf(remote.account)?.role ?? "viewer";
  const all = remote.allows(null);
  return { self: remote.account, everyone: role === "approver", repos: all ? null : store.knownRepos().filter(repo => remote.allows(repo)), unplaced: all };
}

export function auditCommand(positional: readonly string[], flags: Map<string, string | true>, context: AuditContext): number {
  const fail = (reason: string, message: string, code: number) => {
    context.write(context.json ? checkedEnvelopeJson({ ok: false, command: COMMAND, reason, message }) : message);
    return code;
  };
  const usage = (message: string) => fail("usage", `${message} ${AUDIT_USAGE}`, EXIT.usage);
  for (const name of flags.keys()) if (!FLAGS.has(name)) return usage(`--${name} is not an audit option.`);
  if (positional.length > 0) return usage("audit takes no arguments.");
  const value = (name: string): string | null | undefined => {
    const one = flags.get(name);
    return one === undefined ? null : typeof one === "string" && one !== "" ? one : undefined;
  };
  const person = value("person"), source = value("source"), since = value("since"), limit = value("limit"), cursor = value("cursor");
  const tokenFlag = value("token"), tokenName = value("token-name");
  for (const [name, one] of [["person", person], ["token", tokenFlag], ["token-name", tokenName], ["source", source], ["since", since], ["limit", limit], ["cursor", cursor]] as const) {
    if (one === undefined) return usage(`--${name} needs a value.`);
  }
  if (tokenFlag !== null && tokenName !== null && tokenFlag !== tokenName) return usage("Name one token.");
  const token = tokenFlag ?? tokenName ?? null;
  if (token !== null && /^so_[a-f0-9]{12}_/.test(token)) return usage("Name the token (as shown in Settings), never its secret.");
  if (source !== null && !(AUDIT_SOURCES as readonly string[]).includes(source!)) return usage("--source is api or mcp.");
  const from = since === null ? null : sinceOf(since!, context.now);
  if (since !== null && from === null) return usage("--since is a number of days, like 7d.");
  const size = limit === null ? AUDIT_LIMIT.default : /^[1-9][0-9]{0,2}$/.test(limit!) && Number(limit) <= AUDIT_LIMIT.max ? Number(limit) : null;
  if (size === null) return usage(`--limit is 1 to ${AUDIT_LIMIT.max}.`);
  const before = cursor === null ? null : cursorOf(cursor!);
  if (cursor !== null && before === null) return usage("--cursor is the nextCursor of an earlier page.");

  const filters: AuditFilters = { person: person ?? null, token, source: (source ?? null) as AuditSource | null, since: from };
  const page = remoteAudit(context.store, readerOf(context.store, context.principal), filters, { limit: size, before });
  if (!page.ok) return fail(page.reason, page.message, EXIT.refused);
  if (context.json) {
    context.write(checkedEnvelopeJson({ ok: true, command: COMMAND, filters, actions: page.actions, limit: page.limit, nextCursor: page.nextCursor }));
    return EXIT.ok;
  }
  const lines = page.actions.length === 0 ? ["No remote actions."] : page.actions.map(auditLine);
  if (page.nextCursor !== null) lines.push(`Older: toolroll audit --cursor ${page.nextCursor}${flagsAgain(flags)}`);
  context.write(lines.join("\n"));
  return EXIT.ok;
}

/** One line per action: outcome first, then who, token, source, what and where. */
export function auditLine(action: AuditAction): string {
  const outcome = action.outcome === "ok" ? "ok" : `${action.outcome}${action.reason === null ? "" : ` (${action.reason})`}`;
  const where = action.repo === null ? "" : `  ${basename(action.repo)}`;
  return `${action.at.slice(0, 16).replace("T", " ")}  ${outcome}  ${action.person}  ${action.token ?? "unknown token"}  ${action.source}  ${action.name}${where}`;
}

/** The filters again for the next page, quoted when they need it. */
function flagsAgain(flags: Map<string, string | true>): string {
  const quote = (one: string) => /^[A-Za-z0-9_./:@-]+$/.test(one) ? one : `'${one.replaceAll("'", "'\\''")}'`;
  return ["person", "token", "token-name", "source", "since", "limit"].flatMap(name => {
    const one = flags.get(name);
    return typeof one === "string" ? [` --${name} ${quote(one)}`] : [];
  }).join("");
}
