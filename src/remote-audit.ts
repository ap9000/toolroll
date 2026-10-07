/**
 * Remote activity (phase 3, docs/plans/remote-team.md): what people did on this server with their API tokens, read
 * from the action history runOperateAs already writes — one `requested` line when a command starts, and a final line
 * (`done`, `refused`, `usage`, `failed`) when it ends or is refused. The history is append-only and sealed, so old
 * words are never rewritten: this projection maps them to `ok`, `refused` and `error` as it reads, and leaves out the
 * `requested` lines. It never shows a line's raw detail; the token's name, an MCP tool and a refusal reason are
 * recovered from it by exact match.
 *
 * Who sees what is decided inside the query, before a page is cut: the machine's owner (a local run) sees everyone;
 * an approver sees everyone within their project ceiling and all of their own lines; a viewer sees only their own.
 * Another person the reader may not see answers exactly like a person who doesn't exist.
 */
import { IN_RANGE } from "./ledger-chain.js";
import type { ApiTokenRow, Store } from "./store.js";

export const AUDIT_SOURCES = ["api", "mcp"] as const;
export type AuditSource = typeof AUDIT_SOURCES[number];
export type AuditOutcome = "ok" | "refused" | "error";
export const AUDIT_LIMIT = { default: 20, max: 100 } as const;
const SINCE_MAX_DAYS = 3650;

export type AuditFilters = { person: string | null; token: string | null; source: AuditSource | null; since: string | null };

/** One remote action. `kind` says whether a person's CLI ran a command or their agent called a tool over MCP. */
export type AuditAction = {
  id: number;
  at: string;
  person: string;
  token: string | null;
  source: AuditSource;
  kind: "command" | "tool";
  /** The command row (`task show`), or for a tool call the tool's name when the line recorded it. */
  name: string;
  command: string;
  tool: string | null;
  repo: string | null;
  taskId: string | null;
  outcome: AuditOutcome;
  /** A refusal's stable reason (`read-only`, `not-found`, ...), never free text. */
  reason: string | null;
};

/**
 * Who is reading. `self` null: the machine's own owner, reading the database here. Otherwise a person:
 * `everyone` when they approve; `repos` their project ceiling (null: every project); `unplaced` whether lines in no
 * project (refused before a project was known) are theirs to see for other people.
 */
export type AuditReader = { self: string | null; everyone: boolean; repos: readonly string[] | null; unplaced: boolean };

export const OWNER_READER: AuditReader = Object.freeze({ self: null, everyone: true, repos: null, unplaced: true });

export type AuditPage = { ok: true; actions: AuditAction[]; nextCursor: string | null; limit: number } | { ok: false; reason: "not-found"; message: string };

/** The old final words, in the vocabulary people read. Anything unrecognized reads as an error, never as ok. */
export function auditOutcome(outcome: string): AuditOutcome | null {
  if (outcome === "requested") return null;
  if (outcome === "done") return "ok";
  if (outcome === "refused" || outcome === "usage") return "refused";
  return "error";
}

/** `7d` → the instant that many days before `now`; null for anything else (no zero, sign, fraction or other unit). */
export function sinceOf(value: string, now: Date): string | null {
  const match = /^([1-9][0-9]{0,3})d$/.exec(value);
  if (match === null || Number(match[1]) > SINCE_MAX_DAYS) return null;
  return new Date(now.getTime() - Number(match[1]) * 86_400_000).toISOString();
}

export const cursorOf = (value: string): number | null => /^[1-9][0-9]{0,15}$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;

const REASON = /^[a-z][a-z0-9-]{0,40}$/;
const TOOL = /^[a-z][a-z0-9_]{0,40}$/;
const COMMAND = "remote command: ";

/**
 * A line's token, tool and reason. The detail is `token <name>` then ` · `-separated parts: the token name is the
 * longest of this person's token names (or ids, for a line written before the token was proved) that matches up to a
 * separator, since a name may itself contain ` · `. Unmatched text is never echoed.
 */
export function readDetail(detail: string | null, tokens: readonly Pick<ApiTokenRow, "id" | "name">[]): { token: string | null; tool: string | null; reason: string | null } {
  const none = { token: null, tool: null, reason: null };
  if (detail === null || !detail.startsWith("token ")) return none;
  const body = detail.slice("token ".length);
  let token: string | null = null, rest = "", matched = -1;
  for (const one of tokens) {
    for (const label of [one.name, one.id]) {
      if ((body === label || body.startsWith(`${label} · `)) && label.length > matched) {
        token = one.name;
        rest = body.slice(label.length);
        matched = label.length;
      }
    }
  }
  if (token === null) return none;
  let tool: string | null = null, reason: string | null = null;
  for (const part of rest.split(" · ").slice(1)) {
    if (part.startsWith("tool ") && TOOL.test(part.slice(5))) tool = part.slice(5);
    else if (REASON.test(part)) reason ??= part;
  }
  return { token, tool, reason };
}

/**
 * One page of remote actions, newest first, keyed by entry id so new lines never shift an older page. The reader's
 * visibility and every filter are applied before the page is cut; the token filter is an exact name match.
 */
export function remoteAudit(store: Store, reader: AuditReader, filters: AuditFilters, page: { limit?: number; before?: number | null } = {}): AuditPage {
  const notFound = { ok: false as const, reason: "not-found" as const, message: "Not found." };
  const limit = Math.max(1, Math.min(AUDIT_LIMIT.max, Math.trunc(page.limit ?? AUDIT_LIMIT.default)));
  if (filters.person !== null) {
    if (store.accountOf(filters.person) === null) return notFound;
    if (reader.self !== null && !reader.everyone && filters.person !== reader.self) return notFound;
  }
  const clauses = ["source IN ('api','mcp')", "outcome <> 'requested'", `action LIKE '${COMMAND}%'`];
  const args: (string | number)[] = [];
  if (reader.self !== null) {
    if (!reader.everyone) { clauses.push("actor = ?"); args.push(reader.self); }
    else if (reader.repos !== null || !reader.unplaced) {
      const placed = reader.repos === null ? "repo IS NOT NULL" : reader.repos.length === 0 ? "0" : `repo IN (${reader.repos.map(() => "?").join(",")})`;
      clauses.push(`(actor = ? OR ${placed}${reader.unplaced ? " OR repo IS NULL" : ""})`);
      args.push(reader.self, ...(reader.repos ?? []));
    }
  }
  if (filters.person !== null) { clauses.push("actor = ?"); args.push(filters.person); }
  if (filters.source !== null) { clauses.push("source = ?"); args.push(filters.source); }
  if (filters.since !== null) { clauses.push("at >= ?"); args.push(filters.since); }
  const tokens = new Map<string, ApiTokenRow[]>();
  for (const one of store.apiTokens(null)) tokens.set(one.account, [...(tokens.get(one.account) ?? []), one]);
  if (filters.token !== null) {
    // Narrow by every label a line for this name could start with; the exact owner of the line is decided below.
    const labels = [...new Set([...tokens.values()].flat().filter(one => one.name === filters.token).flatMap(one => [one.name, one.id]))];
    if (labels.length === 0) return { ok: true, actions: [], nextCursor: null, limit };
    clauses.push(`(${labels.map(() => "(detail = ? OR substr(detail, 1, ?) = ?)").join(" OR ")})`);
    for (const label of labels) args.push(`token ${label}`, `token ${label} · `.length, `token ${label} · `);
  }
  const statement = store.handle.prepare(`SELECT id, at, actor, repo, task_id, action, outcome, source, detail FROM action_ledger
    WHERE id ${IN_RANGE} AND id < ? AND ${clauses.join(" AND ")} ORDER BY id DESC LIMIT ?`);
  const actions: AuditAction[] = [];
  let before = page.before ?? Number.MAX_SAFE_INTEGER, more = false;
  const batch = limit + 1;
  while (actions.length <= limit) {
    const rows = statement.all(before, ...args, batch);
    for (const row of rows) {
      before = Number(row["id"]);
      const action = actionOf(row, tokens.get(String(row["actor"])) ?? []);
      if (action === null || filters.token !== null && action.token !== filters.token) continue;
      if (actions.length === limit) { more = true; break; }
      actions.push(action);
    }
    if (more || rows.length < batch) break;
  }
  return { ok: true, actions, nextCursor: more ? String(actions.at(-1)!.id) : null, limit };
}

function actionOf(row: Record<string, unknown>, tokens: readonly ApiTokenRow[]): AuditAction | null {
  const outcome = auditOutcome(String(row["outcome"]));
  const source = String(row["source"]);
  if (outcome === null || (source !== "api" && source !== "mcp")) return null;
  const command = String(row["action"]).slice(COMMAND.length);
  const read = readDetail(row["detail"] == null ? null : String(row["detail"]), tokens);
  const tool = source === "mcp" ? read.tool : null;
  return {
    id: Number(row["id"]), at: String(row["at"]), person: String(row["actor"]), token: read.token, source,
    kind: source === "mcp" ? "tool" : "command", name: tool ?? command, command, tool,
    repo: row["repo"] == null ? null : String(row["repo"]), taskId: row["task_id"] == null ? null : String(row["task_id"]),
    outcome, reason: outcome === "ok" ? null : read.reason ?? (String(row["outcome"]) === "usage" ? "usage" : null),
  };
}

/** A token's standing, for People. */
export function tokenStatus(token: Pick<ApiTokenRow, "revokedAt" | "expiresAt">, now: Date): "active" | "expired" | "revoked" {
  return token.revokedAt !== null ? "revoked" : Date.parse(token.expiresAt) <= now.getTime() ? "expired" : "active";
}
