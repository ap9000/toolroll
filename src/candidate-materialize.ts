/**
 * Materialize a verified Local Checkout Candidate into an authoritative central
 * Git commit, Run record, sealed diff artifact, and central verification check
 * request (ADR-0002 / Promotion boundary).
 *
 * Security invariants:
 * - Always re-validates patch safety/secrets/paths via `validateHandoffPatch`.
 * - Runs `hardenedGit` in an isolated scratch worktree detached at `baseCommit`
 *   with `--no-verify` (never executing untrusted repository hooks).
 * - Never touches the Project's default branch; writes an isolated candidate
 *   branch `toolroll/candidate/<candidateId>` and records `run_check = "not-run"`
 *   so an unverified Candidate can never claim passing checks.
 * - Immediately queues central verification via `requestFollowUpChecks` when
 *   the Project has an approved check command configured.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as execRun } from "./exec.js";
import { storeEvidence } from "./evidence.js";
import { validateHandoffPatch } from "./local-handoff.js";
import { requestFollowUpChecks } from "./result-follow-ups.js";
import type { Store } from "./store.js";
import { teardownGit } from "./teardown-git.js";

const COMMIT_SHA = /^[0-9a-f]{40}$/;

export type MaterializeCandidateInput = {
  store: Store;
  evidenceRoot: string;
  repo: string;
  taskRef: number;
  taskId: string;
  candidateId: string;
  author: string;
  promoter: string;
  baseCommit: string;
  patch: string;
  patchSha256: string;
  note: string;
  now: Date;
};

export type MaterializeCandidateResult =
  | {
      ok: true;
      runId: number;
      branch: string;
      baseCommit: string;
      headCommit: string;
      checks:
        | { status: "queued"; requestId: number; level: "quick" | "full" }
        | { status: "not-configured" | "refused"; reason: string; message: string };
    }
  | {
      ok: false;
      error: "invalid_patch" | "invalid_base" | "worktree_failed" | "apply_failed" | "commit_failed";
      message: string;
    };

export async function materializePromotedCandidate(
  input: MaterializeCandidateInput,
): Promise<MaterializeCandidateResult> {
  const { store, evidenceRoot, repo, taskRef, taskId, candidateId, author, promoter, baseCommit, patch, patchSha256, note, now } = input;
  if (!COMMIT_SHA.test(baseCommit)) {
    return { ok: false, error: "invalid_base", message: "Candidate base commit is missing or not a valid Git commit SHA." };
  }
  const checked = validateHandoffPatch(patch);
  if (!checked.ok) {
    return { ok: false, error: "invalid_patch", message: checked.error };
  }

  const git = teardownGit(execRun);
  const scratch = mkdtempSync(join(tmpdir(), "so-promote-"));
  const worktree = join(scratch, "wt");
  const patchFile = join(scratch, "candidate.patch");
  const branch = `toolroll/candidate/${candidateId}`;
  let worktreeAdded = false;

  try {
    writeFileSync(patchFile, patch, { encoding: "utf8", mode: 0o600 });

    const added = await git(repo, ["worktree", "add", "--detach", worktree, baseCommit]);
    if (added.code !== 0) {
      return {
        ok: false,
        error: "worktree_failed",
        message: `Could not create central verification worktree at ${baseCommit.slice(0, 8)}: ${(added.stderr || added.stdout).trim().slice(0, 200)}`,
      };
    }
    worktreeAdded = true;

    const applied = await git(worktree, ["apply", "--index", "--", patchFile]);
    if (applied.code !== 0) {
      return {
        ok: false,
        error: "apply_failed",
        message: `Candidate patch did not apply cleanly at ${baseCommit.slice(0, 8)}: ${(applied.stderr || applied.stdout).trim().slice(0, 200)}`,
      };
    }

    const summary = note.trim() === ""
      ? `Promote candidate ${candidateId} for ${taskId}`
      : `Promote candidate ${candidateId} for ${taskId}: ${note.trim().slice(0, 120)}`;
    const body = [
      summary,
      "",
      `Task: ${taskId}`,
      `Candidate: ${candidateId}`,
      `Author: ${author}`,
      `Promoted-by: ${promoter}`,
      `Patch-SHA256: ${patchSha256}`,
    ].join("\n");

    const committed = await git(worktree, [
      "-c", "user.name=Toolroll Candidate Promotion",
      "-c", "user.email=toolroll@local",
      "commit", "--no-verify", "--no-gpg-sign", "-m", body,
    ]);
    if (committed.code !== 0) {
      return {
        ok: false,
        error: "commit_failed",
        message: `Could not commit candidate in central worktree: ${(committed.stderr || committed.stdout).trim().slice(0, 200)}`,
      };
    }

    const headRes = await git(worktree, ["rev-parse", "HEAD"]);
    const headCommit = headRes.stdout.trim();
    if (headRes.code !== 0 || !COMMIT_SHA.test(headCommit)) {
      return { ok: false, error: "commit_failed", message: "Could not read materialized commit SHA." };
    }

    const branched = await git(repo, ["branch", "-f", branch, headCommit]);
    if (branched.code !== 0) {
      return { ok: false, error: "commit_failed", message: `Could not publish central candidate branch ${branch}.` };
    }

    const diffRes = await git(repo, ["diff", `${baseCommit}..${headCommit}`]);
    const canonicalDiff = diffRes.code === 0 && diffRes.stdout.trim() !== "" ? diffRes.stdout : patch;

    const stamp = now.toISOString();
    const runId = store.transact(() => {
      const inserted = store.handle.prepare(
        `INSERT INTO run (
           task_ref, lease_id, runner, role, provider,
           base_revision, head_revision, branch, worktree, phase,
           outcome, reason, committed, started_at, finished_at
         ) VALUES (?, ?, ?, 'builder', 'claude', ?, ?, ?, ?, 'build', 'built', ?, 1, ?, ?)`,
      ).run(
        taskRef,
        `promote:${candidateId}`,
        "candidate-promotion",
        baseCommit,
        headCommit,
        branch,
        repo,
        `Promoted local candidate ${candidateId} by ${promoter} (author: ${author})`,
        stamp,
        stamp,
      );
      const id = Number(inserted.lastInsertRowid);
      store.recordRunCheck(id, { status: "not-run", exitCode: null, suites: [] }, now);
      return id;
    });

    storeEvidence(
      store,
      evidenceRoot,
      runId,
      "diff",
      "diff.patch",
      Buffer.from(canonicalDiff, "utf8"),
      `git diff ${baseCommit.slice(0, 12)}..${headCommit.slice(0, 12)} (candidate ${candidateId})`,
      now,
    );

    // Queue central verification checks against the materialized commit if configured.
    const requested = requestFollowUpChecks(store, { runId, level: "full", actor: promoter, why: "person" }, now);
    const checks: Extract<MaterializeCandidateResult, { ok: true }>["checks"] = requested.ok
      ? { status: "queued", requestId: requested.request, level: requested.level }
      : {
          status: requested.reason === "no-check" ? "not-configured" : "refused",
          reason: requested.reason,
          message: requested.message,
        };

    return { ok: true, runId, branch, baseCommit, headCommit, checks };
  } finally {
    if (worktreeAdded) {
      await git(repo, ["worktree", "remove", "--force", worktree]).catch(() => undefined);
    }
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
