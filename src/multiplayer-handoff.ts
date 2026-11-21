/**
 * Human task handoff (`Hand to teammate`) and local code candidate inspection/promotion.
 *
 * - `POST /api/handoff/task/:task/assign-person`: hand a task to a project-authorized
 *   teammate via `store.askPerson(...)`, recording `task_act` (`act = 'asked'`) and
 *   dispatching a personal `task-ask` notification.
 * - `GET /api/handoff/task/:task/candidates`: list local code candidates uploaded via
 *   `toolroll handoff push` for a visible task.
 * - `POST /api/handoff/task/:task/candidate/:id/promote`: verify candidate patch SHA-256
 *   integrity and queue it for central worker build & check verification (never claiming
 *   central checks already passed).
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { withActor } from "./actor.js";
import { materializePromotedCandidate } from "./candidate-materialize.js";
import { resultRunsOf } from "./engine-reads.js";
import { followUpChecksOf } from "./result-follow-ups.js";
import { remoteAllows, reproveRemote, type Principal } from "./operate-remote.js";
import { verifyApproverStanding } from "./principal.js";
import { rowVisible, type ProjectCeiling } from "./project.js";
import type { Admission } from "./request-budget.js";
import type { BrowserKeys } from "./server/mutation-key.js";
import type { Who } from "./server/session.js";
import type { Store, TaskFamily } from "./store.js";
import { teardownGit } from "./teardown-git.js";
import { admitRemoteTerminalRequest, isRemoteTerminalRequest } from "./terminal-connection.js";

const ASSIGN_PATH = /^\/api\/handoff\/task\/([^/]+)\/assign-person$/;
const CANDIDATES_PATH = /^\/api\/handoff\/task\/([^/]+)\/candidates$/;
const PROMOTE_PATH = /^\/api\/handoff\/task\/([^/]+)\/candidate\/(cand-[a-f0-9]{16})\/promote$/;
const CANDIDATE_ID = /^cand-[a-f0-9]{16}$/;
const SHA_PATTERN = /^[0-9a-f]{40,64}$/;
const MAX_SMALL_BODY = 8 * 1024;

export type HandoffCandidateMeta = {
  id: string;
  taskId: string;
  rootId: string;
  author: string;
  createdAt: string;
  baseCommit: string | null;
  files: string[];
  note: string;
  patchSha256: string;
  trust: "unverified";
  promotedAt: string | null;
  promotedBy: string | null;
  runId?: number | null;
  branch?: string | null;
  headCommit?: string | null;
  checkStatus?: "queued" | "not-configured" | "refused" | null;
  checkRequestId?: number | null;
};

export type MultiplayerHandoffOptions = {
  store: Store;
  evidenceRoot: string;
  clock: () => Date;
  liveCeiling: () => ProjectCeiling;
  allowedHost: (host: string | undefined) => boolean;
  browserKeys: BrowserKeys;
  identify: (request: IncomingMessage, touch?: boolean, limited?: boolean) => Who | null;
  authenticateBearer: (request: IncomingMessage) => Principal | null;
  admitBearer: (principal: Principal) => Admission;
};

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

function readJsonBody(request: IncomingMessage, maxBytes = MAX_SMALL_BODY): Promise<Record<string, unknown> | null> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) { over = true; chunks.length = 0; return; }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (over) return resolve(null);
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (raw === "") return resolve({});
      try {
        const parsed = JSON.parse(raw) as unknown;
        resolve(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null);
      } catch { resolve(null); }
    });
    request.on("error", () => resolve(null));
  });
}

type CallerAuth = {
  account: string;
  generation: number;
  role: "approver" | "viewer";
  principal: Principal | null;
};

function authenticateCaller(
  request: IncomingMessage,
  response: ServerResponse,
  options: MultiplayerHandoffOptions,
  needMutation: boolean,
): CallerAuth | null {
  const { store, clock, allowedHost, browserKeys, identify, authenticateBearer, admitBearer } = options;
  if (isRemoteTerminalRequest(request)) {
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
      sendJson(response, budget.status === 503 ? 503 : 429, { ok: false, error: "rate-limited", message: "Too many requests." }, headers);
      return null;
    }
    const acct = store.accountOf(principal!.account);
    if (acct === null || acct.revokedAt !== null) {
      sendJson(response, 401, { ok: false, error: "unauthenticated", message: "Your account is unavailable." });
      return null;
    }
    if (needMutation && (admitted.scope !== "act" || acct.role !== "approver")) {
      sendJson(response, 403, { ok: false, error: "forbidden", message: "This action requires an approver act API token." });
      return null;
    }
    return { account: principal!.account, generation: principal!.generation, role: acct.role, principal: principal! };
  }

  const who = identify(request, needMutation);
  if (who === null || who.via !== "cookie") {
    sendJson(response, 401, { ok: false, error: "unauthenticated", message: "Sign in to continue." });
    return null;
  }
  const acct = store.accountOf(who.name);
  if (acct === null || acct.revokedAt !== null || acct.generation !== who.session.generation) {
    sendJson(response, 401, { ok: false, error: "unauthenticated", message: "Your session has ended." });
    return null;
  }
  if (needMutation) {
    if (acct.role !== "approver") {
      sendJson(response, 403, { ok: false, error: "approver_required", message: "Only an approver can perform this action." });
      return null;
    }
    const origin = request.headers.origin;
    const referer = request.headers.referer;
    const named = typeof origin === "string" && origin !== "null" ? origin : typeof referer === "string" ? referer : null;
    if (named === null || !allowedHost(named.replace(/^https?:\/\//, "").split("/")[0])) {
      sendJson(response, 403, { ok: false, error: "origin", message: "Same-origin request required." });
      return null;
    }
    if (request.headers["x-csrf-token"] !== who.session.csrf) {
      sendJson(response, 403, { ok: false, error: "csrf", message: "Invalid form token." });
      return null;
    }
    const keyErr = browserKeys.check(who, request, null);
    if (keyErr !== null) {
      sendJson(response, keyErr.status, { ok: false, error: "key", message: keyErr.message });
      return null;
    }
  }
  return { account: who.name, generation: acct.generation, role: acct.role, principal: null };
}

function visibleTaskFamily(store: Store, ceiling: ProjectCeiling, caller: CallerAuth, taskId: string) {
  const allowedRepos = caller.principal === null || caller.principal.projects === null
    ? null
    : caller.principal.projects.filter(repo => store.accountCanAccess(caller.account, repo));
  const family = store.taskFamilyOf(taskId, allowedRepos, false);
  const repo = family?.root.repo ?? family?.current.repo ?? null;
  if (family === null || family.problem !== null || repo === null) return null;
  if (!rowVisible(ceiling, repo) || !store.accountCanAccess(caller.account, repo)) return null;
  if (caller.principal !== null && !remoteAllows(store, caller.principal, repo)) return null;
  return { family, repo };
}

function currentTaskBaseCommitReadOnly(store: Store, family: TaskFamily): string | null {
  const latest = resultRunsOf(store, family)[0] ?? null;
  if (latest?.headRevision && SHA_PATTERN.test(latest.headRevision)) return latest.headRevision;
  if (latest?.baseRevision && SHA_PATTERN.test(latest.baseRevision)) return latest.baseRevision;
  return null;
}

async function currentTaskBaseCommit(store: Store, family: TaskFamily, repo: string): Promise<string | null> {
  const fromStore = currentTaskBaseCommitReadOnly(store, family);
  if (fromStore !== null) return fromStore;
  if (existsSync(join(repo, ".git"))) {
    const git = teardownGit();
    const head = await git(repo, ["rev-parse", "HEAD"]).catch(() => null);
    if (head !== null && head.code === 0 && SHA_PATTERN.test(head.stdout.trim())) return head.stdout.trim();
  }
  return null;
}

function taskNeedsApproval(store: Store, family: TaskFamily): boolean {
  const scope = store.getScope(family.current.id);
  if (scope === null) return family.current.state === "queued";
  return scope.approvedAt === null || scope.approvedDigest === null || scope.approvedDigest !== scope.digest;
}

/** POST /api/handoff/task/:task/assign-person — hand a task to a teammate (`store.askPerson`). */
export async function handleAssignTaskPersonHttp(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  options: MultiplayerHandoffOptions,
): Promise<void> {
  if (request.method !== "POST") return sendJson(response, 405, { ok: false, error: "method_not_allowed" }, { allow: "POST" });
  const match = ASSIGN_PATH.exec(url.pathname);
  if (match === null) return sendJson(response, 404, { ok: false, error: "not_found" });
  let taskId: string;
  try { taskId = decodeURIComponent(match[1]!); } catch { return sendJson(response, 400, { ok: false, error: "bad_task" }); }

  const caller = authenticateCaller(request, response, options, true);
  if (caller === null) return;
  const body = await readJsonBody(request);
  if (body === null || typeof body["person"] !== "string" || body["person"].trim() === "") {
    return sendJson(response, 400, { ok: false, error: "bad_request", message: "Choose a teammate to hand this task to." });
  }
  const person = body["person"].trim();
  const whyRaw = typeof body["why"] === "string" ? body["why"].trim() : "";
  const why = whyRaw === "" ? `Handed to you by ${caller.account}.` : whyRaw.slice(0, 400);

  const found = visibleTaskFamily(options.store, options.liveCeiling(), caller, taskId);
  if (found === null) return sendJson(response, 404, { ok: false, error: "not_found", message: "Task not found or outside your projects." });

  const now = options.clock();
  if (caller.principal !== null && !reproveRemote(options.store, caller.principal, now).ok) {
    return sendJson(response, 401, { ok: false, error: "unauthenticated", message: "Your access changed." });
  }

  const handed = withActor({ account: caller.account, lead: false }, () =>
    options.store.askPerson(found.family.current.id, person, why, now),
  );
  if (!handed.ok) {
    const status = handed.reason === "unknown-person" ? 400 : 404;
    const message = handed.reason === "unknown-person"
      ? `${person} does not have access to this project.`
      : "Task could not be handed off.";
    return sendJson(response, status, { ok: false, error: handed.reason, message });
  }

  options.store.recordAction({
    at: now.toISOString(),
    actor: caller.account,
    repo: found.repo,
    taskId: found.family.current.id,
    runId: null,
    action: "task.handoff",
    outcome: "recorded",
    source: caller.principal !== null ? "api" : "work",
    detail: `handed to ${person}: ${why}`,
  });
  options.store.bumpWake();

  const recipient = options.store.accountOf(person);
  const warning = recipient?.role === "viewer" && taskNeedsApproval(options.store, found.family)
    ? `${person} is a Viewer and cannot approve this Task — an Approver will still need to approve it.`
    : null;

  return sendJson(response, 200, {
    ok: true,
    taskId: found.family.current.id,
    person,
    why,
    ...(warning === null ? {} : { warning }),
  });
}

/** GET /api/handoff/task/:task/candidates — list uploaded Local Checkout Candidates for a visible Task. */
export async function handleListCandidatesHttp(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  options: MultiplayerHandoffOptions,
): Promise<void> {
  if (request.method !== "GET") return sendJson(response, 405, { ok: false, error: "method_not_allowed" }, { allow: "GET" });
  const match = CANDIDATES_PATH.exec(url.pathname);
  if (match === null) return sendJson(response, 404, { ok: false, error: "not_found" });
  let taskId: string;
  try { taskId = decodeURIComponent(match[1]!); } catch { return sendJson(response, 400, { ok: false, error: "bad_task" }); }

  const caller = authenticateCaller(request, response, options, false);
  if (caller === null) return;
  const found = visibleTaskFamily(options.store, options.liveCeiling(), caller, taskId);
  if (found === null) return sendJson(response, 404, { ok: false, error: "not_found", message: "Task not found or outside your projects." });

  // GET stays strictly read-only on SQLite + evidenceRoot (never touches repo folder or spawns git).
  const now = options.clock();
  const currentBaseCommit = currentTaskBaseCommitReadOnly(options.store, found.family);
  const dir = join(options.evidenceRoot, "handoff-candidates", found.family.root.id);
  const candidates: Array<HandoffCandidateMeta & { stale: boolean; liveCheckState: "waiting" | "running" | "passed" | "failed" | "not-run" | null }> = [];
  if (existsSync(dir)) {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      const id = file.slice(0, -5);
      if (!CANDIDATE_ID.test(id)) continue;
      if (!existsSync(join(dir, `${id}.patch`))) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(dir, file), "utf8")) as HandoffCandidateMeta;
        if (parsed && parsed.id === id && typeof parsed.patchSha256 === "string") {
          const stale = parsed.promotedAt === null && parsed.baseCommit !== null && currentBaseCommit !== null && parsed.baseCommit !== currentBaseCommit;
          let liveCheckState: "waiting" | "running" | "passed" | "failed" | "not-run" | null = null;
          if (typeof parsed.runId === "number") {
            const followUps = followUpChecksOf(options.store, parsed.runId, now, options.evidenceRoot);
            const latestCheck = followUps.at(-1) ?? null;
            if (latestCheck !== null) {
              liveCheckState = latestCheck.state;
            } else {
              const rc = options.store.runCheckFor(parsed.runId);
              if (rc !== null && (rc.status === "passed" || rc.status === "failed" || rc.status === "not-run")) {
                liveCheckState = rc.status;
              }
            }
          }
          candidates.push({ ...parsed, stale, liveCheckState });
        }
      } catch { /* skip malformed */ }
    }
  }
  candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  if (caller.principal !== null && !reproveRemote(options.store, caller.principal, options.clock()).ok) {
    return sendJson(response, 401, { ok: false, error: "unauthenticated", message: "Your access changed." });
  }
  return sendJson(response, 200, { ok: true, taskId: found.family.current.id, currentBaseCommit, candidates });
}

/** POST /api/handoff/task/:task/candidate/:id/promote — verify SHA-256 and queue candidate for central checks. */
export async function handlePromoteCandidateHttp(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  options: MultiplayerHandoffOptions,
): Promise<void> {
  if (request.method !== "POST") return sendJson(response, 405, { ok: false, error: "method_not_allowed" }, { allow: "POST" });
  const match = PROMOTE_PATH.exec(url.pathname);
  if (match === null) return sendJson(response, 404, { ok: false, error: "not_found" });
  let taskId: string;
  try { taskId = decodeURIComponent(match[1]!); } catch { return sendJson(response, 400, { ok: false, error: "bad_task" }); }
  const candidateId = match[2]!;

  const caller = authenticateCaller(request, response, options, true);
  if (caller === null) return;
  const found = visibleTaskFamily(options.store, options.liveCeiling(), caller, taskId);
  if (found === null) return sendJson(response, 404, { ok: false, error: "not_found", message: "Task not found or outside your projects." });

  const dir = join(options.evidenceRoot, "handoff-candidates", found.family.root.id);
  const metaPath = join(dir, `${candidateId}.json`);
  const patchPath = join(dir, `${candidateId}.patch`);
  if (!existsSync(metaPath) || !existsSync(patchPath)) {
    return sendJson(response, 404, { ok: false, error: "candidate_not_found", message: "Candidate not found for this task." });
  }
  let meta: HandoffCandidateMeta;
  let patch: string;
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf8")) as HandoffCandidateMeta;
    patch = readFileSync(patchPath, "utf8");
  } catch {
    return sendJson(response, 500, { ok: false, error: "candidate_unreadable", message: "Could not read saved candidate." });
  }
  const actualSha = createHash("sha256").update(patch, "utf8").digest("hex");
  if (actualSha !== meta.patchSha256) {
    return sendJson(response, 409, { ok: false, error: "digest_mismatch", message: "Saved candidate patch digest did not match its metadata." });
  }
  const currentBaseCommit = await currentTaskBaseCommit(options.store, found.family, found.repo);
  if (meta.baseCommit !== null && currentBaseCommit !== null && meta.baseCommit !== currentBaseCommit) {
    return sendJson(response, 409, {
      ok: false,
      error: "stale_candidate",
      baseCommit: meta.baseCommit,
      currentBaseCommit,
      message: `Task head moved from ${meta.baseCommit.slice(0, 8)} to ${currentBaseCommit.slice(0, 8)}. Re-pull your Local Checkout and rebase before promoting.`,
    });
  }

  const now = options.clock();
  if (caller.principal !== null && !reproveRemote(options.store, caller.principal, now).ok) {
    return sendJson(response, 401, { ok: false, error: "unauthenticated", message: "Your access changed." });
  }

  const effectiveBase = meta.baseCommit ?? currentBaseCommit;
  let runId: number | null = meta.runId ?? null;
  let branch: string | null = meta.branch ?? null;
  let headCommit: string | null = meta.headCommit ?? null;
  let checks:
    | { status: "queued"; requestId: number; level: "quick" | "full" }
    | { status: "not-configured" | "refused"; reason: string; message: string }
    | null = null;

  if (runId === null && effectiveBase !== null && existsSync(join(found.repo, ".git"))) {
    const materialized = await materializePromotedCandidate({
      store: options.store,
      evidenceRoot: options.evidenceRoot,
      repo: found.repo,
      taskRef: found.family.current.refId,
      taskId: found.family.current.id,
      candidateId,
      author: meta.author,
      promoter: caller.account,
      baseCommit: effectiveBase,
      patch,
      patchSha256: actualSha,
      note: meta.note,
      now,
    });
    if (!materialized.ok) {
      return sendJson(response, 409, { ok: false, error: materialized.error, message: materialized.message });
    }
    runId = materialized.runId;
    branch = materialized.branch;
    headCommit = materialized.headCommit;
    checks = materialized.checks;
  }

  const updated: HandoffCandidateMeta = {
    ...meta,
    promotedAt: meta.promotedAt ?? now.toISOString(),
    promotedBy: meta.promotedBy ?? caller.account,
    runId,
    branch,
    headCommit,
    checkStatus: checks?.status ?? meta.checkStatus ?? null,
    checkRequestId: checks?.status === "queued" ? checks.requestId : (meta.checkRequestId ?? null),
  };
  const tmp = `${metaPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(updated, null, 2), { mode: 0o600 });
  renameSync(tmp, metaPath);

  const runWords = runId === null ? "" : ` into central Run #${runId} (${branch ?? "candidate"}, ${headCommit?.slice(0, 8) ?? ""})`;
  const checkWords = checks?.status === "queued"
    ? ` and queued ${checks.level} central checks (request #${checks.requestId})`
    : checks?.status === "not-configured"
      ? " (no project check command configured yet)"
      : "";
  const detail = `Promoted Candidate ${candidateId} (sha256:${actualSha.slice(0, 12)}, ${meta.files.length} file${meta.files.length === 1 ? "" : "s"}, by ${meta.author})${runWords}${checkWords}.`;
  options.store.recordAction({
    at: now.toISOString(),
    actor: caller.account,
    repo: found.repo,
    taskId: found.family.current.id,
    runId,
    action: "handoff.promote",
    outcome: "recorded",
    source: caller.principal !== null ? "api" : "work",
    detail,
  });
  const standing = verifyApproverStanding(options.store, caller.account, caller.generation, [found.repo]);
  if (standing.ok) {
    options.store.fileSteerNote(found.family.current.id, standing.who.name as unknown as Parameters<Store["fileSteerNote"]>[1], detail, now);
  }
  options.store.bumpWake();

  return sendJson(response, 200, {
    ok: true,
    taskId: found.family.current.id,
    candidateId,
    sha256: actualSha,
    promotedAt: updated.promotedAt,
    promotedBy: updated.promotedBy,
    runId,
    branch,
    headCommit,
    checks,
  });
}
