/**
 * Live multiplayer presence, task ownership, and out-of-band approval pings.
 *
 * - `GET /api/presence`: observational read of who is viewing each visible task,
 *   who currently holds keyboard control of any live terminal on that task, and
 *   each visible task's latest human owner from `task_act`. Strictly scoped to
 *   projects the authenticated caller can access (browser cookie OR pinned
 *   remote terminal bearer token).
 * - `POST /api/handoff/task/:task/approval-ping`: remote terminal step-up ping.
 *   Enqueues a personal `decision` notification to the calling approver's own
 *   paired push/chat channels (Web Push / Telegram / Slack / etc.) with the
 *   privacy-safe `/n/<ref>` link so they can approve in one tap on their phone
 *   or browser without relaxing browser-only approval authority.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { TERMINAL_PROGRAMS, type TerminalHost } from "./live-terminal.js";
import { remoteAllows, reproveRemote, type Principal } from "./operate-remote.js";
import { projectName, rowVisible, type ProjectCeiling } from "./project.js";
import type { Admission } from "./request-budget.js";
import type { Who } from "./server/session.js";
import type { Store, TaskFamily } from "./store.js";
import type { TaskRooms } from "./task-live.js";
import { admitRemoteTerminalRequest, isRemoteTerminalRequest } from "./terminal-connection.js";

export type TaskPresenceEntry = {
  viewers: string[];
  terminalController: string | null;
  terminalProgram: string | null;
  terminalViewers: number;
};

export type PresenceResponse = {
  ok: true;
  me: string;
  tasks: Record<string, TaskPresenceEntry>;
  owners: Record<string, string | null>;
  accounts: string[];
};

export type ApprovalPingResponse = {
  ok: true;
  taskId: string;
  enqueued: boolean;
  channels: string[];
  path: string;
  url: string | null;
};

export type PresenceHandlerOptions = {
  store: Store;
  clock: () => Date;
  liveCeiling: () => ProjectCeiling;
  taskRooms: TaskRooms;
  terminalHost: () => TerminalHost | null;
  identify: (request: IncomingMessage, touch?: boolean, limited?: boolean) => Who | null;
  authenticateBearer: (request: IncomingMessage) => Principal | null;
  admitBearer: (principal: Principal) => Admission;
};

export type ApprovalPingHandlerOptions = {
  store: Store;
  clock: () => Date;
  liveCeiling: () => ProjectCeiling;
  consoleOrigin: (host: string | undefined) => string | null;
  authenticateBearer: (request: IncomingMessage) => Principal | null;
  admitBearer: (principal: Principal) => Admission;
};

const APPROVAL_PING_PATH = /^\/api\/handoff\/task\/([^/]+)\/approval-ping$/;
const PING_DEDUPE_WINDOW_MS = 60_000;

function sendJson(response: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": String(Buffer.byteLength(payload)),
    ...extraHeaders,
  });
  response.end(payload);
}

/** Latest human owner for each task from `task_act` (asked -> handed person, filed/approved -> actor account). */
function taskOwnersFromStore(store: Store, canSeeRepo: (repo: string) => boolean): Record<string, string | null> {
  const rows = store.handle.prepare(`
    SELECT r.external_id AS task_id, r.repo AS repo, a.act AS act, a.account AS account, a.person AS person
    FROM task_act a
    JOIN task_ref r ON r.id = a.task_ref
    WHERE a.id IN (
      SELECT MAX(id) FROM task_act WHERE act IN ('filed', 'approved', 'asked') GROUP BY task_ref
    ) AND r.repo IS NOT NULL
  `).all() as Array<Record<string, unknown>>;
  const owners: Record<string, string | null> = {};
  for (const row of rows) {
    const repo = typeof row["repo"] === "string" ? row["repo"] : null;
    if (repo === null || !canSeeRepo(repo)) continue;
    const taskId = String(row["task_id"]);
    const act = String(row["act"]);
    const owner = act === "asked"
      ? (typeof row["person"] === "string" && row["person"] !== "" ? row["person"] : null)
      : (typeof row["account"] === "string" && row["account"] !== "" ? row["account"] : null);
    owners[taskId] = owner;
  }
  return owners;
}

/** Active paired delivery channels for one approver (Web Push + direct chat bindings). */
function pairedChannelsFor(store: Store, account: string): string[] {
  const channels: string[] = [];
  const pushRow = store.handle.prepare(
    "SELECT COUNT(*) AS n FROM push_subscription WHERE approver = ? AND retired_at IS NULL",
  ).get(account) as Record<string, unknown> | undefined;
  if (Number(pushRow?.["n"] ?? 0) > 0) channels.push("web-push");
  try {
    const bindings = store.handle.prepare(
      "SELECT DISTINCT provider FROM chat_binding WHERE approver = ? AND revoked IS NULL ORDER BY provider",
    ).all(account) as Array<Record<string, unknown>>;
    for (const row of bindings) {
      const provider = typeof row["provider"] === "string" ? row["provider"] : "";
      if (provider !== "" && !channels.includes(provider)) channels.push(provider);
    }
  } catch {
    // Minimal DBs without chat_binding simply report web-push only.
  }
  return channels;
}

/** Whether a task family is currently waiting on a human approval or decision. */
function isWaitingOnApproval(store: Store, family: TaskFamily): boolean {
  const ref = store.lookupRef(family.current.id);
  if (ref?.plan === "drafted") return true;
  if (family.current.state === "queued") {
    const scope = store.getScope(family.current.id);
    if (scope !== null && (scope.approvedAt === null || scope.approvedDigest !== scope.digest)) return true;
  }
  const refIds = family.versions.map(v => v.refId);
  if (refIds.length === 0) return false;
  const placeholders = refIds.map(() => "?").join(", ");
  const pending = store.handle.prepare(`
    SELECT 1 AS hit FROM decision d
    JOIN run r ON r.id = d.run
    WHERE r.task_ref IN (${placeholders}) AND d.state = 'pending'
    LIMIT 1
  `).get(...refIds);
  return pending !== undefined;
}

function admitRemoteToken(
  request: IncomingMessage,
  response: ServerResponse,
  store: Store,
  clock: () => Date,
  authenticateBearer: (request: IncomingMessage) => Principal | null,
  admitBearer: (principal: Principal) => Admission,
): { principal: Principal; scope: "read" | "act" } | null {
  const principal = authenticateBearer(request);
  const admitted = admitRemoteTerminalRequest(request, store, principal ?? undefined, clock);
  if (!admitted.ok) {
    sendJson(response, admitted.status, { ok: false, error: admitted.error, message: `Remote terminal rejected (${admitted.error}).` });
    return null;
  }
  const budget = admitBearer(principal!);
  if (!budget.ok) {
    const headers: Record<string, string> = {};
    if (budget.status !== 503) headers["retry-after"] = String(budget.retryAfter);
    sendJson(response, budget.status === 503 ? 503 : 429, { ok: false, error: "rate-limited", message: "Too many requests. Try again shortly." }, headers);
    return null;
  }
  return { principal: principal!, scope: admitted.scope };
}

export function handlePresenceHttp(
  request: IncomingMessage,
  response: ServerResponse,
  options: PresenceHandlerOptions,
): void {
  if (request.method !== "GET") {
    return sendJson(response, 405, { ok: false, error: "method_not_allowed" }, { allow: "GET" });
  }
  const { store, clock, liveCeiling, taskRooms, terminalHost, identify, authenticateBearer, admitBearer } = options;

  let me: string;
  let bearerPrincipal: Principal | null = null;
  if (isRemoteTerminalRequest(request)) {
    const auth = admitRemoteToken(request, response, store, clock, authenticateBearer, admitBearer);
    if (auth === null) return;
    me = auth.principal.account;
    bearerPrincipal = auth.principal;
  } else {
    const who = identify(request, false);
    if (who === null || who.via !== "cookie") {
      return sendJson(response, 401, { ok: false, error: "unauthenticated", message: "Sign in to view presence." });
    }
    const account = store.accountOf(who.name);
    if (account === null || account.revokedAt !== null || account.generation !== who.session.generation) {
      return sendJson(response, 401, { ok: false, error: "unauthenticated", message: "Your session has ended." });
    }
    me = who.name;
  }

  const ceiling = liveCeiling();
  const canSeeRepo = (repo: string): boolean => {
    if (!rowVisible(ceiling, repo)) return false;
    if (!store.accountCanAccess(me, repo)) return false;
    if (bearerPrincipal !== null && !remoteAllows(store, bearerPrincipal, repo)) return false;
    return true;
  };

  const tasks: Record<string, TaskPresenceEntry> = {};
  const ensure = (taskId: string): TaskPresenceEntry => {
    let entry = tasks[taskId];
    if (entry === undefined) {
      entry = { viewers: [], terminalController: null, terminalProgram: null, terminalViewers: 0 };
      tasks[taskId] = entry;
    }
    return entry;
  };

  // 1. Live task room viewers (memory-only, filtered strictly by caller's visible repos).
  for (const [rootId, viewers] of taskRooms.snapshot()) {
    const family = store.taskFamilyOf(rootId, null, false);
    const repo = family?.root.repo ?? family?.current.repo ?? null;
    if (family === null || family.problem !== null || repo === null || !canSeeRepo(repo)) continue;
    const others = viewers.filter(name => name !== me);
    if (others.length === 0) continue;
    for (const id of new Set([family.root.id, family.current.id])) {
      const entry = ensure(id);
      entry.viewers = [...new Set([...entry.viewers, ...others])].sort((a, b) => a.localeCompare(b));
    }
  }

  // 2. Live terminal sessions (single-controller lease + observer count per task).
  const host = terminalHost();
  if (host !== null) {
    for (const session of host.activePresence()) {
      if (session.taskId === null || !canSeeRepo(session.repo)) continue;
      const family = store.taskFamilyOf(session.taskId, null, false);
      const ids = family === null || family.problem !== null
        ? [session.taskId]
        : [...new Set([session.taskId, family.root.id, family.current.id])];
      for (const id of ids) {
        const entry = ensure(id);
        if (entry.terminalController === null && (session.controller !== null || entry.terminalProgram === null)) {
          entry.terminalController = session.controller;
          entry.terminalProgram = session.program;
          entry.terminalViewers = session.viewers.length;
        }
      }
    }
  }

  // 3. Human owners from `task_act` (for Assigned to me / Waiting on team / Unassigned filters).
  const owners = taskOwnersFromStore(store, canSeeRepo);

  // 4. Active non-revoked accounts on the workspace.
  const accounts = (store.handle.prepare(
    "SELECT name FROM approver WHERE revoked_at IS NULL ORDER BY name",
  ).all() as Array<Record<string, unknown>>).map(row => String(row["name"]));

  // Re-prove bearer standing before returning data.
  if (bearerPrincipal !== null && !reproveRemote(store, bearerPrincipal, clock()).ok) {
    return sendJson(response, 401, { ok: false, error: "unauthenticated", message: "Your access changed." });
  }

  const body: PresenceResponse = { ok: true, me, tasks, owners, accounts };
  return sendJson(response, 200, body);
}

export function handleApprovalPingHttp(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  options: ApprovalPingHandlerOptions,
): void {
  if (request.method !== "POST") {
    return sendJson(response, 405, { ok: false, error: "method_not_allowed" }, { allow: "POST" });
  }
  const match = APPROVAL_PING_PATH.exec(url.pathname);
  if (match === null) {
    return sendJson(response, 404, { ok: false, error: "not_found", message: "Unknown approval ping route." });
  }
  let taskId: string;
  try { taskId = decodeURIComponent(match[1]!); } catch {
    return sendJson(response, 400, { ok: false, error: "bad_task", message: "Malformed task identifier." });
  }

  const { store, clock, liveCeiling, consoleOrigin, authenticateBearer, admitBearer } = options;
  const auth = admitRemoteToken(request, response, store, clock, authenticateBearer, admitBearer);
  if (auth === null) return;

  if (auth.scope !== "act") {
    return sendJson(response, 403, { ok: false, error: "read_only_token", message: "This token is read-only and cannot trigger approval pings." });
  }
  const account = store.accountOf(auth.principal.account);
  if (account === null || account.revokedAt !== null || account.role !== "approver") {
    return sendJson(response, 403, { ok: false, error: "approver_required", message: "Only an approver can request an approval ping." });
  }

  const allowedRepos = auth.principal.projects === null
    ? null
    : auth.principal.projects.filter(repo => store.accountCanAccess(auth.principal.account, repo));
  const family = store.taskFamilyOf(taskId, allowedRepos, false);
  const repo = family?.root.repo ?? family?.current.repo ?? null;
  if (family === null || family.problem !== null || repo === null || !rowVisible(liveCeiling(), repo) || !remoteAllows(store, auth.principal, repo)) {
    return sendJson(response, 404, { ok: false, error: "not_found", message: "Task not found or outside your access." });
  }
  if (!isWaitingOnApproval(store, family)) {
    return sendJson(response, 409, { ok: false, error: "not_waiting", message: "This task is not waiting on approval right now." });
  }

  const now = clock();
  if (!reproveRemote(store, auth.principal, now).ok) {
    return sendJson(response, 401, { ok: false, error: "unauthenticated", message: "Your access changed." });
  }

  const bucket = Math.floor(now.getTime() / PING_DEDUPE_WINDOW_MS);
  const enqueued = store.enqueueNotification({
    dedupeKey: `approval-ping:${family.current.refId}:${auth.principal.account}:${bucket}`,
    kind: "approval-ping",
    pushClass: "decision",
    recipient: auth.principal.account,
    subject: `Approval requested from remote terminal: ${family.current.title.slice(0, 80)}`,
    body: "Open this task in Toolroll to review and approve.",
    link: `/n/${family.current.refId}`,
    source: { taskRef: family.current.refId },
  }, now);

  const channels = pairedChannelsFor(store, auth.principal.account);
  store.recordAction({
    at: now.toISOString(),
    actor: auth.principal.account,
    repo,
    taskId: family.current.id,
    runId: null,
    action: "approval.ping",
    outcome: "recorded",
    source: "api",
    detail: channels.length > 0 ? `channels=${channels.join(",")}` : "no paired push/chat channels",
  });

  const path = `/t/${encodeURIComponent(family.current.id)}`;
  const origin = consoleOrigin(request.headers.host);
  const payload: ApprovalPingResponse = {
    ok: true,
    taskId: family.current.id,
    enqueued,
    channels,
    path,
    url: origin === null ? null : `${origin}${path}`,
  };
  return sendJson(response, 200, payload);
}

/**
 * `GET /api/handoff/terminals` — list attachable non-sensitive live central terminals
 * for a pinned `terminal-remote` act-scoped approver token, strictly scoped to the
 * caller's visible projects (same `TermState` shape as `GET /term/state`).
 */
export function handleRemoteTerminalsHttp(
  request: IncomingMessage,
  response: ServerResponse,
  options: Omit<PresenceHandlerOptions, "taskRooms" | "identify">,
): void {
  if (request.method !== "GET") {
    return sendJson(response, 405, { ok: false, error: "method_not_allowed" }, { allow: "GET" });
  }
  const { store, clock, liveCeiling, terminalHost, authenticateBearer, admitBearer } = options;
  const auth = admitRemoteToken(request, response, store, clock, authenticateBearer, admitBearer);
  if (auth === null) return;
  if (auth.scope !== "act") {
    return sendJson(response, 403, { ok: false, error: "read_only_token", message: "Attaching to a remote terminal requires an act API token." });
  }
  const account = store.accountOf(auth.principal.account);
  if (account === null || account.revokedAt !== null || account.role !== "approver" || store.isDemo()) {
    return sendJson(response, 403, { ok: false, error: "approver_required", message: "Only an approver can attach to remote terminals." });
  }
  const ceiling = liveCeiling();
  const canSeeRepo = (repo: string): boolean =>
    rowVisible(ceiling, repo) && store.accountCanAccess(auth.principal.account, repo) && remoteAllows(store, auth.principal, repo);
  const host = terminalHost();
  const sessions = host === null
    ? []
    : host.listAll()
        .filter(one => one.agent === null && one.localGeneration === null && canSeeRepo(one.repo))
        .map(one => ({
          id: one.id,
          repo: one.repo,
          project: projectName(one.repo),
          program: one.program,
          branch: one.branch,
          startedAt: one.startedAt,
          endedAt: one.endedAt,
          exit: one.exit,
          cleanup: one.cleanup,
          task: one.task,
          run: one.run,
        }));
  if (!reproveRemote(store, auth.principal, clock()).ok) {
    return sendJson(response, 401, { ok: false, error: "unauthenticated", message: "Your access changed." });
  }
  return sendJson(response, 200, {
    available: host !== null,
    problem: host === null ? "Terminals aren't available on this server." : null,
    programs: [...TERMINAL_PROGRAMS],
    projects: [],
    sessions,
  });
}
