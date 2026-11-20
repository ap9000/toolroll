/**
 * Local code handoff (central-workspace Sprint 3):
 *   - GET  /api/handoff/task/:task             export a task's bounded diff & base commit for isolated local checkout
 *   - POST /api/handoff/task/:task/candidate   upload a verified, bounded patch candidate back to the central task
 *
 * Security invariants:
 *   - Person `so_` API token only (`purpose === "api"`), re-proved before and after reads/writes via `reproveRemote`.
 *   - Project scope strictly intersected (`remoteAllows(store, principal, repo)`).
 *   - Uploaded patches are scanned for secrets, checked against path traversal / `.git` / symlink attacks, dry-run
 *     applied in an isolated temporary worktree on the server, and recorded with explicit `unverified` provenance
 *     (never replacing an accepted result or forging check status).
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Store } from "./store.js";
import { remoteAllows, reproveRemote, type Principal } from "./operate-remote.js";
import { adapterPolicy } from "./server/route-policy.js";
import { resultRunsOf, takeOverRevisionOf } from "./engine-reads.js";
import { terminalDiffView } from "./result-evidence-readers.js";
import { scanForSecrets } from "./evidence.js";
import { teardownGit } from "./teardown-git.js";
import { verifyApproverStanding } from "./principal.js";
import type { Admission } from "./request-budget.js";

export const HANDOFF_PROTOCOL = 1 as const;
export const MAX_HANDOFF_PATCH_BYTES = 4 * 1024 * 1024;
export const MAX_HANDOFF_BODY_BYTES = MAX_HANDOFF_PATCH_BYTES + 64 * 1024;
export const MAX_HANDOFF_NOTE_CHARS = 2_000;

const SHA_PATTERN = /^[0-9a-f]{40,64}$/;

export type LocalHandoffOptions = {
  store: Store;
  evidenceRoot: string;
  clock: () => Date;
  authenticate: (request: IncomingMessage) => Principal | null;
  admit?: (principal: Principal) => Admission;
};

export type PatchCheckResult = { ok: true; files: string[] } | { ok: false; error: string };

/**
 * Validate a unified git patch before touching any worktree:
 * rejects empty/oversized patches, NUL bytes, secret matches, symlink modes (`120000`),
 * and any file header touching `.git`, absolute paths, or `..` traversal.
 */
export function validateHandoffPatch(patch: string): PatchCheckResult {
  if (typeof patch !== "string" || patch.trim() === "") {
    return { ok: false, error: "Patch must be a non-empty unified diff." };
  }
  if (Buffer.byteLength(patch, "utf8") > MAX_HANDOFF_PATCH_BYTES) {
    return { ok: false, error: `Patch exceeds the ${MAX_HANDOFF_PATCH_BYTES / (1024 * 1024)} MiB handoff limit.` };
  }
  if (patch.includes("\u0000")) {
    return { ok: false, error: "Patch contains NUL bytes and cannot be accepted." };
  }
  if (scanForSecrets(patch).length > 0) {
    return { ok: false, error: "Patch looks like it contains a secret or credential and was refused." };
  }
  const files: string[] = [];
  for (const line of patch.split("\n")) {
    if (/^(?:new|old) file mode 120000\b/.test(line)) {
      return { ok: false, error: "Symlink additions or modifications are refused in local handoff patches." };
    }
    const header = /^(?:diff --git a\/(.+?) b\/(.+)|(?:\+\+\+|---) [ab]\/(.+))$/.exec(line);
    if (header === null) continue;
    const candidates = [header[1], header[2], header[3]].filter((one): one is string => typeof one === "string");
    for (const raw of candidates) {
      const cleaned = raw.replace(/^"(.*)"$/, "$1").trim();
      if (cleaned === "" || cleaned === "/dev/null") continue;
      if (cleaned.startsWith("/") || cleaned.startsWith("\\") || /^[A-Za-z]:/.test(cleaned)) {
        return { ok: false, error: `Unsafe absolute path in patch: ${cleaned}` };
      }
      const segments = cleaned.split(/[\\/]+/);
      if (segments.some(seg => seg === ".." || seg === "." || seg.toLowerCase() === ".git")) {
        return { ok: false, error: `Unsafe path segment in patch: ${cleaned}` };
      }
      if (!files.includes(cleaned)) files.push(cleaned);
    }
  }
  if (files.length === 0) {
    return { ok: false, error: "Patch contains no valid file headers." };
  }
  return { ok: true, files };
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "pragma": "no-cache",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

function readJsonBody(request: IncomingMessage, cap: number): Promise<Record<string, unknown> | null> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (value: Record<string, unknown> | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > cap) { request.resume(); finish(null); return; }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        finish(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null);
      } catch { finish(null); }
    });
    request.on("error", () => finish(null));
  });
}

function taskIdFromPath(url: URL, suffix: string): string | null {
  const prefix = "/api/handoff/task/";
  if (!url.pathname.startsWith(prefix) || !url.pathname.endsWith(suffix)) return null;
  const raw = url.pathname.slice(prefix.length, suffix === "" ? undefined : -suffix.length);
  if (raw === "" || raw.includes("/")) return null;
  try {
    const decoded = decodeURIComponent(raw);
    return /^[A-Za-z0-9_.-]{1,128}$/.test(decoded) ? decoded : null;
  } catch { return null; }
}

function authenticateHandoff(
  request: IncomingMessage,
  response: ServerResponse,
  options: LocalHandoffOptions,
  needScope: "read" | "act",
): { principal: Principal; scope: "read" | "act"; identity: ReturnType<Store["workspaceIdentity"]> } | null {
  const names = request.rawHeaders.filter((_v, idx) => idx % 2 === 0).map(n => n.toLowerCase());
  if (names.includes("cookie") || names.includes("origin") || names.includes("referer")
    || names.some(n => n.startsWith("sec-fetch-"))
    || names.filter(n => n === "authorization").length !== 1) {
    request.resume();
    sendJson(response, 400, { protocol: HANDOFF_PROTOCOL, ok: false, error: "request", message: "Invalid handoff request headers." });
    return null;
  }
  if (!/^Bearer so_[a-f0-9]{12}_[A-Za-z0-9_-]{43}$/.test(request.headers.authorization ?? "")) {
    request.resume();
    sendJson(response, 401, { protocol: HANDOFF_PROTOCOL, ok: false, error: "unauthenticated", message: "Authenticate with a person API token." });
    return null;
  }
  const principal = options.authenticate(request);
  if (principal === null) {
    request.resume();
    sendJson(response, 401, { protocol: HANDOFF_PROTOCOL, ok: false, error: "unauthenticated", message: "Your API token is invalid or expired." });
    return null;
  }
  const live = reproveRemote(options.store, principal, options.clock());
  if (!live.ok) {
    request.resume();
    sendJson(response, 401, { protocol: HANDOFF_PROTOCOL, ok: false, error: "unauthenticated", message: "Your sign-in changed. Reconnect." });
    return null;
  }
  const cred = options.store.apiTokenSecret(principal.tokenId)?.row;
  if (cred?.purpose !== "api") {
    request.resume();
    sendJson(response, 403, { protocol: HANDOFF_PROTOCOL, ok: false, error: "credential-purpose", message: "Use an ordinary API token for code handoff." });
    return null;
  }
  if (!adapterPolicy({ caller: "bearer", capability: live.scope, token: true }, needScope).ok || (needScope === "act" && live.scope !== "act")) {
    request.resume();
    sendJson(response, 403, { protocol: HANDOFF_PROTOCOL, ok: false, error: "forbidden", message: "Uploading a local candidate requires an act API token." });
    return null;
  }
  const budget = options.admit?.(principal);
  if (budget !== undefined && !budget.ok) {
    if (budget.status !== 503) response.setHeader("retry-after", String(budget.retryAfter));
    request.resume();
    sendJson(response, budget.status === 503 ? 503 : 429, { protocol: HANDOFF_PROTOCOL, ok: false, error: "rate-limited", message: "Too many requests. Try again shortly." });
    return null;
  }
  let identity: ReturnType<Store["workspaceIdentity"]>;
  try { identity = options.store.workspaceIdentity(); } catch {
    request.resume();
    sendJson(response, 503, { protocol: HANDOFF_PROTOCOL, ok: false, error: "workspace-unavailable", message: "Workspace identity unavailable." });
    return null;
  }
  const pinnedWorkspace = request.headers["x-toolroll-workspace"];
  const pinnedRecovery = request.headers["x-toolroll-recovery"];
  if (pinnedWorkspace !== undefined && pinnedWorkspace !== identity.id) {
    request.resume();
    sendJson(response, 409, { protocol: HANDOFF_PROTOCOL, ok: false, error: "workspace-mismatch", message: "This central server does not match your saved workspace identity." });
    return null;
  }
  if (pinnedRecovery !== undefined && pinnedRecovery !== identity.recoveryGeneration) {
    request.resume();
    sendJson(response, 409, { protocol: HANDOFF_PROTOCOL, ok: false, error: "recovery-changed", message: "This workspace was restored or rotated. Reconnect before pushing." });
    return null;
  }
  return { principal, scope: live.scope, identity };
}

/** GET /api/handoff/task/:task — export bounded diff and commit identity for isolated local worktree checkout. */
export async function handleHandoffPull(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  options: LocalHandoffOptions,
): Promise<void> {
  const auth = authenticateHandoff(request, response, options, "read");
  if (auth === null) return;
  const taskId = taskIdFromPath(url, "");
  if (taskId === null) return sendJson(response, 400, { protocol: HANDOFF_PROTOCOL, ok: false, error: "request", message: "Invalid task id." });
  const { store, evidenceRoot } = options;
  const allowedRepos = auth.principal.projects === null
    ? null
    : auth.principal.projects.filter(repo => store.accountCanAccess(auth.principal.account, repo));
  const family = store.taskFamilyOf(taskId, allowedRepos, false);
  if (family === null || family.problem !== null || family.root.repo === null || !remoteAllows(store, auth.principal, family.root.repo)) {
    return sendJson(response, 404, { protocol: HANDOFF_PROTOCOL, ok: false, error: "not-found", message: "No such task in your projects." });
  }
  const repo = family.root.repo;
  const results = resultRunsOf(store, family);
  const latest = results[0] ?? null;
  let patch = "";
  let patchTruncated = false;
  if (latest !== null) {
    const view = terminalDiffView(store.artifactsFor(latest.id), evidenceRoot);
    if (view?.patch !== null && view?.patch !== undefined && !("problem" in view.patch)) {
      patch = view.patch.text;
      patchTruncated = view.patch.truncated;
    }
  }
  let baseCommit: string | null = latest?.baseRevision ?? null;
  if (baseCommit === null && existsSync(join(repo, ".git"))) {
    const git = teardownGit();
    const head = await git(repo, ["rev-parse", "HEAD"]).catch(() => null);
    if (head !== null && head.code === 0 && SHA_PATTERN.test(head.stdout.trim())) {
      baseCommit = head.stdout.trim();
    }
  }
  const headCommit = latest === null ? null : takeOverRevisionOf(latest);
  // Re-prove standing & project visibility before emitting any data.
  const after = reproveRemote(store, auth.principal, options.clock());
  if (!after.ok || !remoteAllows(store, auth.principal, repo)) {
    return sendJson(response, 401, { protocol: HANDOFF_PROTOCOL, ok: false, error: "unauthenticated", message: "Your access changed." });
  }
  return sendJson(response, 200, {
    protocol: HANDOFF_PROTOCOL,
    ok: true,
    workspaceId: auth.identity.id,
    recoveryGeneration: auth.identity.recoveryGeneration,
    taskId: family.current.id,
    rootId: family.root.id,
    title: family.current.title,
    projectName: basename(repo),
    runId: latest?.id ?? null,
    baseCommit,
    headCommit,
    branch: latest?.branch ?? null,
    patch,
    patchTruncated,
  });
}

/** POST /api/handoff/task/:task/candidate — validate and stage an unverified local code candidate on a central task. */
export async function handleHandoffPush(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  options: LocalHandoffOptions,
): Promise<void> {
  const auth = authenticateHandoff(request, response, options, "act");
  if (auth === null) return;
  const taskId = taskIdFromPath(url, "/candidate");
  if (taskId === null) return sendJson(response, 400, { protocol: HANDOFF_PROTOCOL, ok: false, error: "request", message: "Invalid task id." });
  const body = await readJsonBody(request, MAX_HANDOFF_BODY_BYTES);
  if (body === null) {
    return sendJson(response, 400, { protocol: HANDOFF_PROTOCOL, ok: false, error: "request", message: "Expected a bounded JSON object { patch, baseCommit?, note? }." });
  }
  const patch = typeof body["patch"] === "string" ? body["patch"] : "";
  const baseCommit = typeof body["baseCommit"] === "string" && SHA_PATTERN.test(body["baseCommit"]) ? body["baseCommit"] : null;
  const note = typeof body["note"] === "string" ? body["note"].trim() : "";
  if (note.length > MAX_HANDOFF_NOTE_CHARS) {
    return sendJson(response, 400, { protocol: HANDOFF_PROTOCOL, ok: false, error: "request", message: `Note exceeds ${MAX_HANDOFF_NOTE_CHARS} characters.` });
  }
  if (note !== "" && scanForSecrets(note).length > 0) {
    return sendJson(response, 400, { protocol: HANDOFF_PROTOCOL, ok: false, error: "secret-refused", message: "Note looks like it contains a secret and was refused." });
  }
  const checked = validateHandoffPatch(patch);
  if (!checked.ok) {
    return sendJson(response, 400, { protocol: HANDOFF_PROTOCOL, ok: false, error: "invalid-patch", message: checked.error });
  }
  const { store, evidenceRoot } = options;
  const allowedRepos = auth.principal.projects === null
    ? null
    : auth.principal.projects.filter(repo => store.accountCanAccess(auth.principal.account, repo));
  const family = store.taskFamilyOf(taskId, allowedRepos, false);
  if (family === null || family.problem !== null || family.root.repo === null || !remoteAllows(store, auth.principal, family.root.repo)) {
    return sendJson(response, 404, { protocol: HANDOFF_PROTOCOL, ok: false, error: "not-found", message: "No such task in your projects." });
  }
  const repo = family.root.repo;
  // Dry-run patch application in an isolated temporary worktree on the central repo when it is a real Git checkout.
  if (existsSync(join(repo, ".git"))) {
    const git = teardownGit();
    const scratch = mkdtempSync(join(tmpdir(), "so-handoff-verify-"));
    const worktree = join(scratch, "wt");
    const patchFile = join(scratch, "candidate.patch");
    try {
      writeFileSync(patchFile, patch, { mode: 0o600 });
      const target = baseCommit ?? "HEAD";
      const added = await git(repo, ["worktree", "add", "--detach", "--", worktree, target]);
      if (added.code !== 0) {
        return sendJson(response, 409, { protocol: HANDOFF_PROTOCOL, ok: false, error: "base-mismatch", message: `Could not check out base commit ${target} on the central repository.` });
      }
      const applied = await git(worktree, ["apply", "--check", "--", patchFile]);
      if (applied.code !== 0) {
        return sendJson(response, 409, { protocol: HANDOFF_PROTOCOL, ok: false, error: "patch-conflict", message: "Patch does not apply cleanly to the central base commit. Rebase locally and try again." });
      }
    } finally {
      await git(repo, ["worktree", "remove", "--force", "--", worktree]).catch(() => {});
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  // Re-prove standing before persisting candidate.
  const now = options.clock();
  const after = reproveRemote(store, auth.principal, now);
  if (!after.ok || after.scope !== "act" || !remoteAllows(store, auth.principal, repo)) {
    return sendJson(response, 401, { protocol: HANDOFF_PROTOCOL, ok: false, error: "unauthenticated", message: "Your access changed before upload finalized." });
  }
  const sha256 = createHash("sha256").update(patch, "utf8").digest("hex");
  const candidateId = `cand-${randomBytes(8).toString("hex")}`;
  const outDir = join(evidenceRoot, "handoff-candidates", family.root.id);
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(outDir, `${candidateId}.patch`), patch, { mode: 0o600 });
  const provenance = `Local code handoff candidate ${candidateId} uploaded by ${auth.principal.account} (${checked.files.length} file${checked.files.length === 1 ? "" : "s"}, sha256:${sha256.slice(0, 12)}, unverified — requires central checks/review).${note ? ` Note: ${note}` : ""}`;
  store.recordAction({
    at: now.toISOString(),
    actor: auth.principal.account,
    repo,
    taskId: family.current.id,
    runId: null,
    action: "handoff.candidate",
    source: "api",
    outcome: "accepted",
    detail: provenance,
  });
  const standing = verifyApproverStanding(store, auth.principal.account, auth.principal.generation, [repo]);
  if (standing.ok) {
    store.fileSteerNote(family.current.id, standing.who.name as unknown as Parameters<Store["fileSteerNote"]>[1], provenance, now);
  }
  return sendJson(response, 201, {
    protocol: HANDOFF_PROTOCOL,
    ok: true,
    candidateId,
    taskId: family.current.id,
    sha256,
    files: checked.files,
    trust: "unverified",
    message: provenance,
  });
}
