import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { HARDENED_GIT_ARGS } from "./agent-fence.js";
import { assignmentOf } from "./assignment.js";
import { canonicalJson } from "./canonical-json.js";
import { runCheckLevel } from "./check-levels.js";
import { readVerificationView } from "./contracts/verification-view.js";
import { directChatShipSealAllowed } from "./direct-chat-laptop.js";
import { laptopShipProblem } from "./flexible-laptop.js";
export { directChatShipSealAllowed };
import { soloNow } from "./install-mode.js";
import { taskBranch } from "./names.js";
import { verifyApproverStanding } from "./principal.js";
import { fileTaskProposal } from "./proposal.js";
import { completeAndOpenPullRequest, mergePullRequest } from "./pull-request-flow.js";
import type { PublishExec } from "./publish.js";
import { fullCheckGate } from "./result-follow-ups.js";
import { approvalOf, approve, machineActing, proposeGuarded, type AcceptanceCriterion } from "./scope.js";
import type { Store } from "./store.js";
import { verificationEvidence } from "./verification-evidence.js";

export const DIRECT_CHAT_FILED_PREFIX = "direct-chat:";
export const DIRECT_CHAT_SHIP_OUT_OF_SCOPE = "Verify the frozen Direct Chat snapshot commit only. Further changes need a new Ship.";
const DEFAULT_ACCEPTANCE: readonly AcceptanceCriterion[] = Object.freeze([
  { id: "c1", statement: "The project's checks pass on this exact snapshot commit.", how: null, evidence: ["check"] },
]);

export type DirectChatShipMode = "ship" | "keep-branch";
export type DirectChatShipState = "kept" | "imported" | "armed" | "completed" | "merging" | "merged" | "cancelled" | "failed";

export type DirectChatShipDestination = {
  repo: string;
  remote: string;
  base: string;
  method: "squash" | "merge" | "rebase";
  draft: boolean;
};

export type DirectChatShipTerms = {
  kind: "direct-chat-ship";
  version: 1;
  threadId: string;
  repo: string;
  owner: string;
  ownerGeneration: number;
  seq: number;
  mode: DirectChatShipMode;
  baseSha: string;
  worktreeDigest: string;
  branch: string;
  changedFiles: string[];
  title: string;
  goal: string;
  check: { command: string; digest: string } | null;
  github: DirectChatShipDestination | null;
};

export type DirectChatShipRow = {
  id: string;
  threadId: string;
  seq: number;
  repo: string;
  mode: DirectChatShipMode;
  baseSha: string;
  candidateSha: string;
  branch: string;
  terms: DirectChatShipTerms;
  approvedBy: string;
  approvedGeneration: number;
  localGeneration: number | null;
  proof: "password-now" | "solo-session" | "local-owner";
  state: DirectChatShipState;
  taskId: string | null;
  scopeDigest: string | null;
  prUrl: string | null;
  detail: string | null;
  createdAt: string;
  stateAt: string;
};

export type DirectChatShipPreview = {
  threadId: string;
  mode: DirectChatShipMode;
  canAutoMerge: boolean;
  autoMergeReason: string | null;
  termsDigest: string;
  title: string;
  goal: string;
  baseSha: string;
  branch: string;
  changedFiles: string[];
  checkCommand: string | null;
  githubRepo: string | null;
  githubBase: string | null;
  mergeSummary: string;
  terms: DirectChatShipTerms;
};

export function directChatShipTaskId(digest: string): string {
  return `dc-${digest}`;
}

export function directChatShipDigestOf(terms: DirectChatShipTerms): string {
  return createHash("sha256").update(`toolroll:direct-chat-ship:${canonicalJson(terms)}`, "utf8").digest("hex").slice(0, 32);
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env["PATH"] ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    HOME: homedir(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function runGit(args: readonly string[], cwd: string): string {
  return execFileSync(
    "git",
    [...HARDENED_GIT_ARGS, "-c", "protocol.ext.allow=never", "-c", "credential.helper=", ...args],
    {
      cwd,
      encoding: "utf8",
      env: gitEnv(),
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function destinationOf(store: Store, repo: string): DirectChatShipDestination | null {
  const grant = store.publicationGrantFor(repo);
  if (grant === null || !grant.capabilities.includes("push-branch") || !grant.capabilities.includes("open-pr")) {
    return null;
  }
  return {
    repo: grant.githubRepo,
    remote: grant.remote,
    base: grant.base,
    method: grant.mergeMethod ?? "squash",
    draft: grant.draft,
  };
}

function inspectCloneForShip(clonePath: string, baseSha: string): { changedFiles: string[]; worktreeDigest: string; headSha: string; dirty: boolean } {
  const headSha = runGit(["rev-parse", "HEAD"], clonePath).trim();
  const status = runGit(["status", "--porcelain"], clonePath);
  const committed = runGit(["diff", "--name-only", baseSha, "HEAD"], clonePath)
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean);
  const working = runGit(["diff", "--name-only", "HEAD"], clonePath)
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean);
  const untracked = status
    .split("\n")
    .filter(line => line.startsWith("?? "))
    .map(line => line.slice(3).trim())
    .filter(Boolean);
  const changedFiles = [...new Set([...committed, ...working, ...untracked])].sort();
  const diffRaw = runGit(["diff", "--binary", baseSha], clonePath);
  const untrackedHash = createHash("sha256");
  for (const rel of untracked.sort()) {
    untrackedHash.update(`${rel}\0`);
    try {
      const blob = runGit(["hash-object", "--", rel], clonePath).trim();
      untrackedHash.update(`${blob}\n`);
    } catch {
      untrackedHash.update("?\n");
    }
  }
  const worktreeDigest = createHash("sha256")
    .update(`${headSha}\n${status}\n${diffRaw}\n${untrackedHash.digest("hex")}`)
    .digest("hex")
    .slice(0, 32);
  return {
    changedFiles,
    worktreeDigest,
    headSha,
    dirty: status.trim() !== "",
  };
}

function freezeSnapshotCommit(clonePath: string, title: string, baseSha: string): string {
  const status = runGit(["status", "--porcelain"], clonePath).trim();
  if (status !== "") {
    runGit(["add", "-A"], clonePath);
    const msg = `Direct chat snapshot: ${title.slice(0, 72)}`;
    runGit(
      ["-c", "user.name=Toolroll Direct Chat", "-c", "user.email=direct-chat@toolroll.local", "commit", "-m", msg],
      clonePath,
    );
  }
  const sha = runGit(["rev-parse", "HEAD"], clonePath).trim();
  if (sha === baseSha) {
    throw new Error("No changes to ship compared to base commit.");
  }
  return sha;
}

function fetchSnapshotIntoMainRepo(input: { repo: string; clonePath: string; candidateSha: string; targetRef: string }): void {
  runGit(
    ["-c", "protocol.file.allow=always", "fetch", "--no-tags", input.clonePath, `${input.candidateSha}:${input.targetRef}`],
    input.repo,
  );
}

export function previewDirectChatShip(
  store: Store,
  input: {
    owner: string;
    threadId: string;
    mode?: DirectChatShipMode | undefined;
    title?: string | undefined;
    goal?: string | undefined;
  },
): { ok: true; preview: DirectChatShipPreview } | { ok: false; status: number; error: string } {
  if (!/^[0-9a-f]{32}$/.test(input.threadId)) return { ok: false, status: 400, error: "Invalid thread id." };
  const thread = store.handle
    .prepare("SELECT * FROM direct_chat_thread WHERE id = ? AND owner = ? AND archived_at IS NULL")
    .get(input.threadId, input.owner) as Record<string, unknown> | undefined;
  if (!thread) return { ok: false, status: 404, error: "Chat thread not found." };

  const running = store.handle
    .prepare("SELECT 1 FROM direct_chat_turn WHERE thread_id = ? AND status = 'running' LIMIT 1")
    .get(input.threadId);
  if (running !== undefined) {
    return { ok: false, status: 409, error: "Stop the running turn before shipping this chat." };
  }

  const account = store.accountOf(input.owner);
  if (account === null || account.revokedAt !== null || account.role !== "approver") {
    return { ok: false, status: 403, error: "Approver standing is required to ship." };
  }

  const repo = String(thread["repo"]);
  const clonePath = String(thread["clone_path"]);
  const baseSha = String(thread["base_sha"]);
  const branch = String(thread["branch"]);
  if (!existsSync(clonePath)) {
    return { ok: false, status: 404, error: "This chat's isolated clone no longer exists on disk." };
  }

  let inspected;
  try {
    inspected = inspectCloneForShip(clonePath, baseSha);
  } catch (error) {
    return { ok: false, status: 500, error: `Could not inspect chat clone: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (inspected.changedFiles.length === 0) {
    return { ok: false, status: 409, error: "There are no changes to ship in this chat yet." };
  }

  const github = destinationOf(store, repo);
  const check = store.liveVerifyCommand(repo);
  const canAutoMerge = github !== null && check !== null;
  let autoMergeReason: string | null = null;
  if (github === null) {
    autoMergeReason = "This project isn't connected to GitHub pull requests yet — use Keep branch instead.";
  } else if (check === null) {
    autoMergeReason = "Set a project check command in Settings before auto-merging — or use Keep branch.";
  }

  const mode: DirectChatShipMode = input.mode ?? (canAutoMerge ? "ship" : "keep-branch");
  const nextSeq = Number(
    (store.handle.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM direct_chat_ship WHERE thread_id = ?").get(input.threadId) as Record<string, unknown>)["n"],
  );
  const title = (input.title?.trim() || String(thread["title"]) || "Changes from Direct Chat").slice(0, 120);
  const goal = (input.goal?.trim() || `Ship verified changes from Direct Chat (${title}).`).slice(0, 400);

  const terms: DirectChatShipTerms = {
    kind: "direct-chat-ship",
    version: 1,
    threadId: input.threadId,
    repo,
    owner: input.owner,
    ownerGeneration: account.generation,
    seq: nextSeq,
    mode,
    baseSha,
    worktreeDigest: inspected.worktreeDigest,
    branch,
    changedFiles: inspected.changedFiles,
    title,
    goal,
    check: check ? { command: check.command, digest: check.digest } : null,
    github,
  };
  const termsDigest = directChatShipDigestOf(terms);
  const mergeSummary = mode === "ship" && canAutoMerge && github && check
    ? `Freezes a snapshot commit, runs ${check.command}, opens a PR into ${github.repo} (${github.base}), and merges automatically once checks pass on this exact commit.`
    : `Freezes a snapshot commit and saves local branch ${branch} in your main repo without pushing.`;

  return {
    ok: true,
    preview: {
      threadId: input.threadId,
      mode,
      canAutoMerge,
      autoMergeReason,
      termsDigest,
      title,
      goal,
      baseSha,
      branch,
      changedFiles: inspected.changedFiles,
      checkCommand: check?.command ?? null,
      githubRepo: github?.repo ?? null,
      githubBase: github?.base ?? null,
      mergeSummary,
      terms,
    },
  };
}

export function executeDirectChatShip(
  store: Store,
  input: {
    owner: string;
    threadId: string;
    mode: DirectChatShipMode;
    termsDigest: string;
    title?: string | undefined;
    goal?: string | undefined;
    password?: string | undefined;
    localOwner?: { localGeneration: number } | null | undefined;
    now?: Date | undefined;
  },
): { ok: true; ship: DirectChatShipRow } | { ok: false; status: number; error: string; code?: string } {
  if (machineActing()) {
    return { ok: false, status: 403, error: "Only a person can ship a chat's changes." };
  }
  if (!soloNow(store)) {
    return { ok: false, status: 403, error: "Direct chat shipping is only available on solo local installs." };
  }

  const previewRes = previewDirectChatShip(store, {
    owner: input.owner,
    threadId: input.threadId,
    mode: input.mode,
    title: input.title,
    goal: input.goal,
  });
  if (!previewRes.ok) return previewRes;
  const { preview } = previewRes;
  if (preview.termsDigest !== input.termsDigest) {
    return {
      ok: false,
      status: 409,
      code: "terms_changed",
      error: "Changes occurred since this preview was generated. Review the updated Ship preview first.",
    };
  }
  if (input.mode === "ship" && !preview.canAutoMerge) {
    return {
      ok: false,
      status: 409,
      code: "auto_merge_unavailable",
      error: preview.autoMergeReason ?? "Auto-merge isn't available for this project; use Keep branch instead.",
    };
  }

  const thread = store.handle
    .prepare("SELECT * FROM direct_chat_thread WHERE id = ? AND owner = ? AND archived_at IS NULL")
    .get(input.threadId, input.owner) as Record<string, unknown> | undefined;
  if (!thread) return { ok: false, status: 404, error: "Chat thread not found." };

  const repo = String(thread["repo"]);
  const clonePath = String(thread["clone_path"]);
  const baseSha = String(thread["base_sha"]);
  const now = input.now ?? new Date();
  const stamp = now.toISOString();

  let candidateSha: string;
  try {
    candidateSha = freezeSnapshotCommit(clonePath, preview.title, baseSha);
  } catch (error) {
    return { ok: false, status: 409, error: error instanceof Error ? error.message : String(error) };
  }

  const shipId = preview.termsDigest;
  const termsJson = canonicalJson(preview.terms);
  const proof: DirectChatShipRow["proof"] = input.localOwner != null
    ? "local-owner"
    : (input.password && input.password !== "" ? "password-now" : "solo-session");

  if (input.mode === "keep-branch") {
    const targetRef = `refs/heads/${preview.branch}`;
    try {
      fetchSnapshotIntoMainRepo({ repo, clonePath, candidateSha, targetRef });
    } catch (error) {
      return { ok: false, status: 500, error: `Could not import branch into main repo: ${error instanceof Error ? error.message : String(error)}` };
    }
    store.transact(() => {
      store.handle.prepare(`
        INSERT INTO direct_chat_ship (
          id, thread_id, seq, repo, mode, base_sha, candidate_sha, branch, terms_json,
          approved_by, approved_generation, local_generation, proof, state,
          task_id, scope_digest, pr_url, detail, created_at, state_at
        ) VALUES (?, ?, ?, ?, 'keep-branch', ?, ?, ?, ?, ?, ?, ?, ?, 'kept', NULL, NULL, NULL, NULL, ?, ?)
      `).run(
        shipId,
        input.threadId,
        preview.terms.seq,
        repo,
        baseSha,
        candidateSha,
        preview.branch,
        termsJson,
        input.owner,
        preview.terms.ownerGeneration,
        input.localOwner?.localGeneration ?? null,
        proof,
        stamp,
        stamp,
      );
      store.recordAction({
        at: stamp,
        actor: input.owner,
        repo,
        taskId: null,
        runId: null,
        source: "work",
        action: "direct chat keep-branch",
        outcome: candidateSha.slice(0, 12),
        detail: `thread ${input.threadId} · branch ${preview.branch} · commit ${candidateSha}`,
      });
    });
    const row = readShipRow(store.handle.prepare("SELECT * FROM direct_chat_ship WHERE id = ?").get(shipId) as Record<string, unknown>);
    return { ok: true, ship: row! };
  }

  // Auto-merge Ship path: fetch frozen snapshot commit onto the task branch, file verify-only task, seal via approve(), arm merge.
  if (proof === "local-owner") {
    const laptopErr = laptopShipProblem(store, { owner: input.owner, localGeneration: input.localOwner!.localGeneration });
    if (laptopErr !== null) {
      return { ok: false, status: 403, error: `Password-free Ship is unavailable: ${laptopErr}.` };
    }
  }

  const taskId = directChatShipTaskId(shipId);
  if (store.lookupRef(taskId) !== null) {
    return { ok: false, status: 409, error: "This snapshot was already shipped." };
  }
  const branch = taskBranch(taskId);
  try {
    fetchSnapshotIntoMainRepo({ repo, clonePath, candidateSha, targetRef: `refs/heads/${branch}` });
  } catch (error) {
    return { ok: false, status: 500, error: `Could not import snapshot commit into main repo: ${error instanceof Error ? error.message : String(error)}` };
  }

  try {
    const sealedShip = store.transact(() => {
      if (!soloNow(store)) {
        throw new Error("Direct chat shipping requires solo mode.");
      }
      store.handle.prepare(`
        INSERT INTO direct_chat_ship (
          id, thread_id, seq, repo, mode, base_sha, candidate_sha, branch, terms_json,
          approved_by, approved_generation, local_generation, proof, state,
          task_id, scope_digest, pr_url, detail, created_at, state_at
        ) VALUES (?, ?, ?, ?, 'ship', ?, ?, ?, ?, ?, ?, ?, ?, 'imported', NULL, NULL, NULL, NULL, ?, ?)
      `).run(
        shipId,
        input.threadId,
        preview.terms.seq,
        repo,
        baseSha,
        candidateSha,
        branch,
        termsJson,
        input.owner,
        preview.terms.ownerGeneration,
        input.localOwner?.localGeneration ?? null,
        proof,
        stamp,
        stamp,
      );

      const made = fileTaskProposal(
        store,
        {
          id: taskId,
          title: preview.title,
          repo,
          goal: preview.goal,
          outOfScope: DIRECT_CHAT_SHIP_OUT_OF_SCOPE,
          acceptance: [...DEFAULT_ACCEPTANCE],
          filedVia: `${DIRECT_CHAT_FILED_PREFIX}${shipId}`,
          filedBy: { name: input.owner, kind: "person" as const },
          planning: "skip",
          admittedRepos: [repo],
        },
        now,
      );
      if (!made.ok) throw new Error(made.message);
      const ref = store.lookupRef(made.id)!;
      const proposed = proposeGuarded(store, {
        taskId: made.id,
        author: input.owner,
        taskRef: ref.id,
        sawDigest: store.getScope(made.id)!.digest,
        goal: preview.goal,
        outOfScope: DIRECT_CHAT_SHIP_OUT_OF_SCOPE,
        acceptance: [...DEFAULT_ACCEPTANCE],
        candidate: candidateSha,
        now,
      });
      if (!proposed.ok) throw new Error(proposed.message || "Could not propose task scope.");

      const yes = approve(store, made.id, input.owner, now, proposed.scope.digest, input.password ?? "");
      if (!yes.ok) {
        const msg = "message" in yes && typeof yes.message === "string" ? yes.message : yes.reason;
        throw new Error(`Approval refused: ${msg}`);
      }
      const sealed = store.getScope(made.id)!;
      if (!approvalOf(sealed).approved || sealed.candidate !== candidateSha) {
        throw new Error("Task approval seal did not hold for this snapshot commit.");
      }

      store.handle.prepare(`
        UPDATE direct_chat_ship
        SET state = 'armed', task_id = ?, scope_digest = ?, state_at = ?
        WHERE id = ? AND state = 'imported'
      `).run(made.id, sealed.digest, stamp, shipId);
      store.recordAction({
        at: stamp,
        actor: input.owner,
        repo,
        taskId: made.id,
        runId: null,
        source: "work",
        action: "direct chat ship armed",
        outcome: "direct-chat-ship",
        detail: `thread ${input.threadId} · ship ${shipId} · commit ${candidateSha} · scope ${sealed.digest}`,
      });
      return readShipRow(store.handle.prepare("SELECT * FROM direct_chat_ship WHERE id = ?").get(shipId) as Record<string, unknown>)!;
    });
    return { ok: true, ship: sealedShip };
  } catch (error) {
    try {
      runGit(["branch", "-D", branch], repo);
    } catch {
      // Best-effort cleanup of imported branch on rolled-back seal.
    }
    return { ok: false, status: 409, error: error instanceof Error ? error.message : String(error) };
  }
}

export function cancelDirectChatShip(
  store: Store,
  input: { owner: string; threadId: string; shipId: string; now?: Date },
): { ok: true } | { ok: false; status: number; error: string } {
  if (!/^[0-9a-f]{32}$/.test(input.threadId) || !/^[0-9a-f]{32}$/.test(input.shipId)) {
    return { ok: false, status: 400, error: "Invalid thread or ship id." };
  }
  const row = store.handle
    .prepare("SELECT * FROM direct_chat_ship WHERE id = ? AND thread_id = ? AND approved_by = ?")
    .get(input.shipId, input.threadId, input.owner) as Record<string, unknown> | undefined;
  if (!row) return { ok: false, status: 404, error: "Ship record not found." };
  const state = String(row["state"]);
  if (state !== "armed" && state !== "completed") {
    return { ok: false, status: 409, error: `Cannot cancel a ship in state '${state}'.` };
  }
  const stamp = (input.now ?? new Date()).toISOString();
  store.transact(() => {
    store.handle.prepare(`
      UPDATE direct_chat_ship
      SET state = 'cancelled', detail = 'Cancelled by owner.', state_at = ?
      WHERE id = ? AND state IN ('armed', 'completed')
    `).run(stamp, input.shipId);
    store.recordAction({
      at: stamp,
      actor: input.owner,
      repo: String(row["repo"]),
      taskId: typeof row["task_id"] === "string" ? row["task_id"] : null,
      runId: null,
      source: "work",
      action: "direct chat ship cancelled",
      outcome: "cancelled",
      detail: `thread ${input.threadId} · ship ${input.shipId}`,
    });
  });
  return { ok: true };
}

export function listDirectChatShips(store: Store, threadId: string): DirectChatShipRow[] {
  const rows = store.handle
    .prepare("SELECT * FROM direct_chat_ship WHERE thread_id = ? ORDER BY seq DESC")
    .all(threadId) as Record<string, unknown>[];
  return rows.map(readShipRow).filter((one): one is DirectChatShipRow => one !== null);
}

function readShipRow(raw: Record<string, unknown> | undefined): DirectChatShipRow | null {
  if (!raw) return null;
  let terms: DirectChatShipTerms;
  try {
    terms = JSON.parse(String(raw["terms_json"])) as DirectChatShipTerms;
  } catch {
    return null;
  }
  return {
    id: String(raw["id"]),
    threadId: String(raw["thread_id"]),
    seq: Number(raw["seq"]),
    repo: String(raw["repo"]),
    mode: raw["mode"] === "keep-branch" ? "keep-branch" : "ship",
    baseSha: String(raw["base_sha"]),
    candidateSha: String(raw["candidate_sha"]),
    branch: String(raw["branch"]),
    terms,
    approvedBy: String(raw["approved_by"]),
    approvedGeneration: Number(raw["approved_generation"]),
    localGeneration: typeof raw["local_generation"] === "number" ? raw["local_generation"] : null,
    proof: raw["proof"] === "local-owner" ? "local-owner" : raw["proof"] === "password-now" ? "password-now" : "solo-session",
    state: String(raw["state"]) as DirectChatShipState,
    taskId: typeof raw["task_id"] === "string" ? raw["task_id"] : null,
    scopeDigest: typeof raw["scope_digest"] === "string" ? raw["scope_digest"] : null,
    prUrl: typeof raw["pr_url"] === "string" ? raw["pr_url"] : null,
    detail: typeof raw["detail"] === "string" ? raw["detail"] : null,
    createdAt: String(raw["created_at"]),
    stateAt: String(raw["state_at"]),
  };
}

function directChatShipAuthorityProblem(store: Store, ship: DirectChatShipRow): string | null {
  if (!soloNow(store)) return "install is no longer solo";
  const who = verifyApproverStanding(store, ship.approvedBy, ship.approvedGeneration, [ship.repo]);
  if (!who.ok) return "approver standing or account generation changed";
  if (ship.proof === "local-owner") {
    if (ship.localGeneration === null) return "laptop consent missing";
    const err = laptopShipProblem(store, { owner: ship.approvedBy, localGeneration: ship.localGeneration });
    if (err !== null) return err;
  }
  if (ship.taskId === null || ship.scopeDigest === null) return "verify task missing";
  const task = store.getTask(ship.taskId);
  if (task === null || task.state === "cancelled") return "verify task was cancelled";
  const scope = store.getScope(ship.taskId);
  if (scope === null || scope.digest !== ship.scopeDigest || scope.candidate !== ship.candidateSha || !approvalOf(scope).approved) {
    return "sealed task scope changed";
  }
  const dest = destinationOf(store, ship.repo);
  if (dest === null || ship.terms.github === null || canonicalJson(dest) !== canonicalJson(ship.terms.github)) {
    return "GitHub destination changed";
  }
  const check = store.liveVerifyCommand(ship.repo);
  if (check === null || ship.terms.check === null || check.digest !== ship.terms.check.digest) {
    return "project check command changed";
  }
  return null;
}

function cancelArmedRow(store: Store, ship: DirectChatShipRow, why: string, now: Date): void {
  const stamp = now.toISOString();
  store.transact(() => {
    store.handle.prepare(`
      UPDATE direct_chat_ship SET state = 'cancelled', detail = ?, state_at = ?
      WHERE id = ? AND state IN ('armed', 'completed')
    `).run(why.slice(0, 1000), stamp, ship.id);
    store.recordAction({
      at: stamp,
      actor: "toolroll",
      repo: ship.repo,
      taskId: ship.taskId,
      runId: null,
      source: "policy",
      action: "direct chat ship cancelled",
      outcome: "cancelled",
      detail: `ship ${ship.id} · ${why}`.slice(0, 1000),
    });
  });
}

function newestBuilderRun(store: Store, taskId: string) {
  const ref = store.lookupRef(taskId);
  const runs = ref === null ? [] : store.runsFor(ref.id).filter(one => one.role !== "reviewer");
  return runs.reduce<typeof runs[number] | null>((best, one) => (best === null || one.id > best.id ? one : best), null);
}

function passingCheckDigest(store: Store, root: string, runId: number, ship: DirectChatShipRow, now: Date): string | null {
  if (ship.terms.check === null) return null;
  if (runCheckLevel(store, runId) === null || fullCheckGate(store, runId, now).state !== "clear") return null;
  const ev = verificationEvidence(store, root, runId);
  if (!ev.ok || ev.bytes === null) return null;
  const view = readVerificationView(ev.bytes);
  if (!view.ok) return null;
  const result = view.value.result as { exitCode?: unknown };
  return view.value.head === ship.candidateSha && view.value.command.digest === ship.terms.check.digest && result.exitCode === 0
    ? ev.digest
    : null;
}

export type DirectChatArmedReport = {
  ok: true;
  completed: number;
  merged: number;
  cancelled: number;
  waiting: number;
};

/**
 * Watch-loop pass for armed Direct Chat Ships (called alongside `flexibleArmedPass`
 * in `src/operate.ts`). Re-proves authority, check receipt, and exact commit SHA
 * before opening or merging a PR. Never merges on a failed or missing check.
 */
export async function directChatArmedPass(
  store: Store,
  input: { root: string; exec?: PublishExec; clock?: () => Date },
): Promise<DirectChatArmedReport> {
  const clock = input.clock ?? (() => new Date());
  const report: DirectChatArmedReport = { ok: true, completed: 0, merged: 0, cancelled: 0, waiting: 0 };
  const rows = store.handle
    .prepare("SELECT * FROM direct_chat_ship WHERE state IN ('armed', 'completed') ORDER BY created_at ASC")
    .all() as Record<string, unknown>[];

  for (const raw of rows) {
    const ship = readShipRow(raw);
    if (ship === null || ship.taskId === null) continue;
    const problem = directChatShipAuthorityProblem(store, ship);
    if (problem !== null) {
      cancelArmedRow(store, ship, problem, clock());
      report.cancelled += 1;
      continue;
    }

    const newest = newestBuilderRun(store, ship.taskId);
    if (newest === null || newest.headRevision === null || newest.finishedAt == null) {
      report.waiting += 1;
      continue;
    }
    if (newest.headRevision !== ship.candidateSha) {
      cancelArmedRow(store, ship, "Result commit moved away from the shipped snapshot commit.", clock());
      report.cancelled += 1;
      continue;
    }

    const checkReceipt = passingCheckDigest(store, input.root, newest.id, ship, clock());
    if (checkReceipt === null) {
      report.waiting += 1;
      continue;
    }

    if (ship.state === "armed") {
      const receipt = assignmentOf(store, ship.taskId, clock(), { principal: "operator", repos: [ship.repo] }, input.root)?.receipt ?? null;
      if (receipt === null || receipt.runId !== newest.id) {
        report.waiting += 1;
        continue;
      }
      const who = verifyApproverStanding(store, ship.approvedBy, ship.approvedGeneration, [ship.repo]);
      if (!who.ok) {
        cancelArmedRow(store, ship, "Approver standing ended.", clock());
        report.cancelled += 1;
        continue;
      }
      try {
        store.transact(() => {
          const opened = completeAndOpenPullRequest(
            store,
            { taskId: ship.taskId!, digest: receipt.digest, runId: newest.id, who: who.who, root: input.root },
            clock(),
          );
          if (!opened.ok) throw new Error(opened.message);
          const at = clock().toISOString();
          store.handle.prepare(`
            UPDATE direct_chat_ship SET state = 'completed', state_at = ?
            WHERE id = ? AND state = 'armed'
          `).run(at, ship.id);
        });
        report.completed += 1;
      } catch {
        report.waiting += 1;
      }
      continue;
    }

    // State === "completed": merge once PR is open and matches exact shipped commit & destination.
    const pub = store.publicationForRun(newest.id);
    if (pub === null || pub.prNumber === null) {
      report.waiting += 1;
      continue;
    }
    if (pub.headSha !== ship.candidateSha || pub.githubRepo !== ship.terms.github?.repo || pub.base !== ship.terms.github?.base) {
      cancelArmedRow(store, ship, "Pull request head or destination no longer matches shipped terms.", clock());
      report.cancelled += 1;
      continue;
    }
    const merged = await mergePullRequest(store, {
      runId: newest.id,
      by: ship.approvedBy,
      clock,
      ...(input.exec === undefined ? {} : { exec: input.exec }),
      proceed: seen => {
        if (directChatShipAuthorityProblem(store, ship) !== null) {
          cancelArmedRow(store, ship, "Authority changed before merge.", clock());
          return false;
        }
        if (seen.head !== null && seen.head !== ship.candidateSha) {
          cancelArmedRow(store, ship, "PR head changed on GitHub.", clock());
          return false;
        }
        if (seen.base !== null && ship.terms.github !== null && seen.base !== ship.terms.github.base) {
          cancelArmedRow(store, ship, "PR base changed on GitHub.", clock());
          return false;
        }
        return true;
      },
    });
    if (merged.ok) {
      const at = clock().toISOString();
      store.transact(() => {
        store.handle.prepare(`
          UPDATE direct_chat_ship SET state = 'merged', pr_url = ?, state_at = ?
          WHERE id = ? AND state = 'completed'
        `).run(pub.prUrl ?? null, at, ship.id);
        store.recordAction({
          at,
          actor: ship.approvedBy,
          repo: ship.repo,
          taskId: ship.taskId,
          runId: newest.id,
          source: "work",
          action: "direct chat merged",
          outcome: merged.commit ?? "merged",
          detail: `ship ${ship.id} · commit ${ship.candidateSha}`,
        });
      });
      report.merged += 1;
    } else {
      report.waiting += 1;
    }
  }

  return report;
}
