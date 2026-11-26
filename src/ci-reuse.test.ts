/**
 * Tests for Part B of release-from-main (`scripts/ci-reuse.mjs`):
 * - Strict version-only equality parity with `src/check-report.ts` (`versionOnlyChange`) and `scripts/release-check.mjs` (`versionOnly`).
 * - Hash-verified Git diff eligibility via `deploy-git.mjs` (docs-only, version-only, docs+version, and every attack/rejection case).
 * - Precise per-check GitHub API proof (`proveBaseChecks` via `release-proof.mjs` PR proof OR `main-push.yml` fallback, fail-closed on skipped/failed/unproven/race).
 * - CLI `decide` (fail-closed exit 0 with `reuse=false`, no dynamic workflow commands) and `verify` (exit 0 only when proven, exit 1 otherwise).
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { versionOnlyChange } from "./check-report.js";
import { versionOnly as releaseCheckVersionOnly } from "../scripts/release-check.mjs";
import {
  CI_REUSE_CHECKS,
  CI_WORKFLOW,
  MAIN_PUSH_JOB_PREFIX,
  MAIN_PUSH_WORKFLOW,
  diffTreesEligibility,
  evaluateReuse,
  proveBaseChecks,
  proveMainPush,
  verifiedDiffEligible,
  versionOnly,
} from "../scripts/ci-reuse.mjs";

const REPO = "ap9000/toolroll";
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const PR_HEAD = "c".repeat(40);
const TREE = "d".repeat(40);
const PARENT = "e".repeat(40);

function pkgJson(version: string, extra: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({ name: "toolroll", version, private: true, ...extra }, null, 2) + "\n");
}

function lockJson(version: string, rootVersion = version, extra: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({
    name: "toolroll",
    version,
    lockfileVersion: 3,
    packages: { "": { name: "toolroll", version: rootVersion }, ...extra },
  }, null, 2) + "\n");
}

describe("ci-reuse: versionOnly matches check-report.ts and release-check.mjs", () => {
  const cases: [string, string, Buffer, Buffer, boolean][] = [
    ["package.json version bump", "package.json", pkgJson("0.9.120"), pkgJson("0.9.121"), true],
    ["package-lock.json version bump", "package-lock.json", lockJson("0.9.120"), lockJson("0.9.121"), true],
    ["package.json script added", "package.json", pkgJson("0.9.120"), pkgJson("0.9.121", { scripts: { postinstall: "evil" } }), false],
    ["package-lock.json extra dependency", "package-lock.json", lockJson("0.9.120"), lockJson("0.9.121", "0.9.121", { "node_modules/evil": { version: "1.0.0" } }), false],
    ["package.json duplicate key attack", "package.json", pkgJson("0.9.120"), Buffer.from('{"name":"toolroll","version":"0.9.121","version":"0.9.121","private":true}\n'), false],
    ["package.json key reordered", "package.json", pkgJson("0.9.120"), Buffer.from('{"private":true,"name":"toolroll","version":"0.9.121"}\n'), false],
    ["package.json non-string version", "package.json", pkgJson("0.9.120"), Buffer.from('{"name":"toolroll","version":121,"private":true}\n'), false],
    ["non-versioned file", "tsconfig.json", pkgJson("0.9.120"), pkgJson("0.9.121"), false],
    ["invalid UTF-8 bytes", "package.json", pkgJson("0.9.120"), Buffer.from([0xff, 0xfe]), false],
  ];

  test.each(cases)("%s -> %s", (_label, file, before, after, expected) => {
    expect(versionOnly(file, before, after)).toBe(expected);
    expect(versionOnlyChange(file, before, after)).toBe(expected);
    if (!before.includes(0xff) && !after.includes(0xff)) {
      expect(releaseCheckVersionOnly(file, before.toString("utf8"), after.toString("utf8"))).toBe(expected);
    }
  });
});

describe("ci-reuse: hash-verified git diff eligibility (real git)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-reuse-git-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const env = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (...args: string[]) => {
    const ran = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd: dir, encoding: "utf8", env });
    if (ran.status !== 0) throw new Error(ran.stderr);
    return ran.stdout.trim();
  };

  git("init", "-q");
  mkdirSync(join(dir, "docs", "plans"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "# Toolroll\n");
  writeFileSync(join(dir, "CHANGELOG.md"), "## 0.9.120\n");
  writeFileSync(join(dir, "docs/plans/a.md"), "plan\n");
  writeFileSync(join(dir, "package.json"), pkgJson("0.9.120"));
  writeFileSync(join(dir, "package-lock.json"), lockJson("0.9.120"));
  writeFileSync(join(dir, "src/index.ts"), "export const ok = true;\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");

  const commitFromBase = (mutate: () => void, message = "change"): string => {
    git("checkout", "-qf", base);
    mutate();
    git("add", "-A");
    git("commit", "-qm", message);
    return git("rev-parse", "HEAD");
  };

  test("pure docs-only add/edit qualifies", () => {
    const head = commitFromBase(() => {
      writeFileSync(join(dir, "README.md"), "# Toolroll updated\n");
      writeFileSync(join(dir, "docs/plans/new.md"), "new doc\n");
    });
    const res = verifiedDiffEligible(dir, base, head, env);
    expect(res).toMatchObject({ ok: true, kind: "docs-only" });
    if (res.ok) expect(res.changed.map((c: { path: string }) => c.path).sort()).toEqual(["README.md", "docs/plans/new.md"]);
  });

  test("release prepare shape (version-only package.json + package-lock.json + CHANGELOG.md) qualifies", () => {
    const head = commitFromBase(() => {
      writeFileSync(join(dir, "package.json"), pkgJson("0.9.121"));
      writeFileSync(join(dir, "package-lock.json"), lockJson("0.9.121"));
      writeFileSync(join(dir, "CHANGELOG.md"), "## 0.9.121\n- release\n\n## 0.9.120\n");
    });
    expect(verifiedDiffEligible(dir, base, head, env)).toMatchObject({ ok: true, kind: "docs-and-version" });
  });

  test("pure version-only bump (no changelog) qualifies", () => {
    const head = commitFromBase(() => {
      writeFileSync(join(dir, "package.json"), pkgJson("0.9.121"));
    });
    expect(verifiedDiffEligible(dir, base, head, env)).toMatchObject({ ok: true, kind: "version-only" });
  });

  test("refuses code edits, non-version package edits, deletions, renames, symlinks, executable modes, empty diffs, and diverged bases", () => {
    // Source edit alongside docs
    const code = commitFromBase(() => {
      writeFileSync(join(dir, "README.md"), "updated\n");
      writeFileSync(join(dir, "src/index.ts"), "export const ok = false;\n");
    });
    expect(verifiedDiffEligible(dir, base, code, env)).toMatchObject({ ok: false, why: expect.stringContaining("src/index.ts") });

    // Dependency/script edit in package.json
    const pkgScript = commitFromBase(() => {
      writeFileSync(join(dir, "package.json"), pkgJson("0.9.121", { scripts: { test: "echo pwned" } }));
    });
    expect(verifiedDiffEligible(dir, base, pkgScript, env)).toMatchObject({ ok: false, why: expect.stringContaining("changed more than its version") });

    // Deleted doc
    const deleted = commitFromBase(() => {
      git("rm", "-q", "docs/plans/a.md");
    });
    expect(verifiedDiffEligible(dir, base, deleted, env)).toMatchObject({ ok: false, why: expect.stringContaining("was deleted") });

    // Renamed doc
    const renamed = commitFromBase(() => {
      git("mv", "docs/plans/a.md", "docs/plans/b.md");
    });
    expect(verifiedDiffEligible(dir, base, renamed, env)).toMatchObject({ ok: false, why: expect.stringContaining("was deleted") });

    // Symlink added under docs/
    const link = commitFromBase(() => {
      symlinkSync("../src/index.ts", join(dir, "docs/plans/link.md"));
    });
    expect(verifiedDiffEligible(dir, base, link, env)).toMatchObject({ ok: false, why: expect.stringContaining("120000") });

    // Executable bit added to README.md (100644 -> 100755)
    const execMode = commitFromBase(() => {
      writeFileSync(join(dir, "README.md"), "updated\n");
      chmodSync(join(dir, "README.md"), 0o755);
    });
    expect(verifiedDiffEligible(dir, base, execMode, env)).toMatchObject({ ok: false, why: expect.stringContaining("changed mode or type") });

    // Non-docs markdown (AGENTS.md)
    const agents = commitFromBase(() => {
      writeFileSync(join(dir, "AGENTS.md"), "rules\n");
    });
    expect(verifiedDiffEligible(dir, base, agents, env)).toMatchObject({ ok: false, why: expect.stringContaining("AGENTS.md") });

    // Empty diff (same commit) and empty commit on top of base
    expect(verifiedDiffEligible(dir, base, base, env)).toMatchObject({ ok: false, why: expect.stringContaining("same commit") });
    git("checkout", "-qf", base);
    git("commit", "--allow-empty", "-qm", "empty");
    const emptyHead = git("rev-parse", "HEAD");
    expect(verifiedDiffEligible(dir, base, emptyHead, env)).toMatchObject({ ok: false, why: expect.stringContaining("no tree entries changed") });

    // Diverged branch (base moved ahead on main, head branched from earlier base)
    const newerBase = commitFromBase(() => {
      writeFileSync(join(dir, "src/index.ts"), "export const v = 2;\n");
    }, "main moved");
    const staleHead = commitFromBase(() => {
      writeFileSync(join(dir, "README.md"), "stale branch doc edit\n");
    }, "stale pr");
    expect(verifiedDiffEligible(dir, newerBase, staleHead, env)).toMatchObject({ ok: false, why: expect.stringContaining("merge base differs from base") });

    // git replace cannot disguise a code commit as docs-only
    const fakeDoc = commitFromBase(() => {
      writeFileSync(join(dir, "README.md"), "harmless\n");
    }, "fake");
    git("replace", code, fakeDoc);
    expect(verifiedDiffEligible(dir, base, code, env)).toMatchObject({ ok: false, why: expect.stringContaining("src/index.ts") });
  });

  test("diffTreesEligibility rejects missing/non-blob verified objects", () => {
    const baseEntries = [{ mode: "100644", type: "blob", id: "1".repeat(40), path: "README.md" }];
    const headEntries = [{ mode: "100644", type: "blob", id: "2".repeat(40), path: "README.md" }];
    expect(diffTreesEligibility(baseEntries, headEntries, () => new Map())).toMatchObject({ ok: false, why: expect.stringContaining("isn't a verified blob") });
  });
});

describe("ci-reuse: precise per-check proof on base (GitHub API)", () => {
  type ApiHandler = (path: string) => unknown;

  function mockPrApi(overrides: {
    checkConclusion?: Record<string, string>;
    baseRefChanged?: boolean;
    mainPushJobs?: Array<{ id: number; name: string; head_sha: string; run_id: number; status: string; conclusion: string }>;
    mainPushStatus?: string;
    prExists?: boolean;
  } = {}): ApiHandler {
    const conclusions = overrides.checkConclusion ?? {};
    const prExists = overrides.prExists ?? true;
    const checks = Object.keys(CI_REUSE_CHECKS);
    const prJobs = checks.map((name, i) => ({
      id: 1000 + i,
      name,
      run_id: 500,
      head_sha: PR_HEAD,
      status: "completed",
      conclusion: conclusions[name] ?? "success",
      completed_at: "2026-11-25T10:00:00Z",
    }));

    return (path: string) => {
      if (path === `repos/${REPO}/git/commits/${BASE}`) return { sha: BASE, tree: { sha: TREE }, parents: [{ sha: PARENT }] };
      if (path === `repos/${REPO}/git/commits/${PR_HEAD}`) return { sha: PR_HEAD, tree: { sha: TREE } };
      if (path.startsWith(`repos/${REPO}/commits/${BASE}/pulls`)) {
        return prExists ? [{
          number: 501,
          merged_at: "2026-11-25T10:05:00Z",
          merge_commit_sha: BASE,
          base: { ref: "main", repo: { full_name: REPO } },
          head: { sha: PR_HEAD, ref: "feat/something", repo: { full_name: REPO } },
        }] : [];
      }
      if (path === `repos/${REPO}/compare/${PR_HEAD}...${BASE}`) {
        return { base_commit: { sha: PR_HEAD }, ahead_by: 1, merge_base_commit: { sha: PARENT }, commits: [{ sha: BASE }] };
      }
      if (path.startsWith(`repos/${REPO}/pulls?state=all`)) {
        return [{ number: 501, base: { ref: "main", repo: { full_name: REPO } }, head: { ref: "feat/something", repo: { full_name: REPO } } }];
      }
      if (path.startsWith(`repos/${REPO}/actions/runs?head_sha=${PR_HEAD}`)) {
        return {
          total_count: 1,
          workflow_runs: [{
            id: 500,
            path: CI_WORKFLOW,
            head_sha: PR_HEAD,
            head_branch: "feat/something",
            event: "pull_request",
            status: "completed",
            run_attempt: 1,
            repository: { full_name: REPO },
            head_repository: { full_name: REPO },
            pull_requests: [{
              number: 501,
              base: { ref: "main", repo: { url: `https://api.github.com/repos/${REPO}` } },
              head: { sha: PR_HEAD, ref: "feat/something", repo: { url: `https://api.github.com/repos/${REPO}` } },
            }],
          }],
        };
      }
      if (path.startsWith(`repos/${REPO}/actions/runs/500/attempts/1/jobs`)) {
        return { total_count: prJobs.length, jobs: prJobs };
      }
      if (path.startsWith(`repos/${REPO}/issues/501/timeline`)) {
        return overrides.baseRefChanged ? [{ event: "base_ref_changed" }] : [{ event: "committed" }];
      }
      if (path.startsWith(`repos/${REPO}/actions/runs?head_sha=${BASE}`)) {
        if (!overrides.mainPushJobs) return { total_count: 0, workflow_runs: [] };
        return {
          total_count: 1,
          workflow_runs: [{
            id: 700,
            path: MAIN_PUSH_WORKFLOW,
            head_sha: BASE,
            head_branch: "main",
            event: "push",
            status: overrides.mainPushStatus ?? "completed",
            run_attempt: 1,
            repository: { full_name: REPO },
            head_repository: { full_name: REPO },
          }],
        };
      }
      if (path.startsWith(`repos/${REPO}/actions/runs/700/attempts/1/jobs`)) {
        const jobs = overrides.mainPushJobs ?? [];
        return { total_count: jobs.length, jobs };
      }
      throw new Error(`unexpected path: ${path}`);
    };
  }

  test("proves all CI_REUSE_CHECKS when base passed them on its squash-merged PR", async () => {
    const res = await proveBaseChecks({ repo: REPO, base: BASE, required: CI_REUSE_CHECKS }, async p => mockPrApi()(p));
    expect(res).toEqual({ ok: true, source: "pull_request", pr: 501, head: PR_HEAD });
  });

  test("refuses when ANY single check concluded skipped on base's PR (skipped is never proven)", async () => {
    const api = mockPrApi({ checkConclusion: { "Windows Job Object containment": "skipped" } });
    // Whole-set check fails:
    const allRes = await proveBaseChecks({ repo: REPO, base: BASE, required: CI_REUSE_CHECKS }, async p => api(p));
    expect(allRes.ok).toBe(false);
    // Exact check fails:
    const winRes = await proveBaseChecks({ repo: REPO, base: BASE, required: { "Windows Job Object containment": CI_WORKFLOW } }, async p => api(p));
    expect(winRes.ok).toBe(false);
    // Another check that DID succeed is still individually provable:
    const linuxRes = await proveBaseChecks({ repo: REPO, base: BASE, required: { "node 24 · ubuntu-latest": CI_WORKFLOW } }, async p => api(p));
    expect(linuxRes).toMatchObject({ ok: true, source: "pull_request" });
  });

  test("refuses when a PR retargeted its base", async () => {
    const api = mockPrApi({ baseRefChanged: true });
    const res = await proveBaseChecks({ repo: REPO, base: BASE, required: CI_REUSE_CHECKS }, async p => api(p));
    expect(res.ok).toBe(false);
  });

  test("falls back to main-push.yml full CI proof when base has no PR proof (e.g. direct push or pre-Part-B docs merge)", async () => {
    const mainPushJobs = Object.keys(CI_REUSE_CHECKS).map((name, i) => ({
      id: 2000 + i,
      name: `${MAIN_PUSH_JOB_PREFIX}${name}`,
      head_sha: BASE,
      run_id: 700,
      status: "completed",
      conclusion: "success",
    }));
    const api = mockPrApi({ prExists: false, mainPushJobs });
    const res = await proveBaseChecks({ repo: REPO, base: BASE, required: CI_REUSE_CHECKS }, async p => api(p));
    expect(res).toEqual({ ok: true, source: "main_push", run: 700 });
  });

  test("main-push.yml fallback refuses skipped, failed, incomplete, or non-ci.yml checks", async () => {
    const skippedJobs = Object.keys(CI_REUSE_CHECKS).map((name, i) => ({
      id: 2000 + i,
      name: `${MAIN_PUSH_JOB_PREFIX}${name}`,
      head_sha: BASE,
      run_id: 700,
      status: "completed",
      conclusion: name === "git 2.41 · debian trixie" ? "skipped" : "success",
    }));
    const resSkipped = await proveMainPush({ repo: REPO, sha: BASE, required: CI_REUSE_CHECKS }, async p => mockPrApi({ prExists: false, mainPushJobs: skippedJobs })(p));
    expect(resSkipped.ok).toBe(false);

    const resInProgress = await proveMainPush({ repo: REPO, sha: BASE, required: CI_REUSE_CHECKS }, async p => mockPrApi({ prExists: false, mainPushJobs: skippedJobs, mainPushStatus: "in_progress" })(p));
    expect(resInProgress.ok).toBe(false);

    const resRc = await proveMainPush({ repo: REPO, sha: BASE, required: { "node 22 · ubuntu-latest": ".github/workflows/release-candidate.yml" } }, async p => mockPrApi({ prExists: false, mainPushJobs: skippedJobs })(p));
    expect(resRc.ok).toBe(false);
  });

  test("evaluateReuse refuses non-pull_request events and non-main base refs before touching git or GitHub", async () => {
    let called = false;
    const api = async () => { called = true; return {}; };
    expect(await evaluateReuse({ event: "push", baseRef: "main", base: BASE, head: HEAD, repo: REPO, root: "/nonexistent", required: CI_REUSE_CHECKS }, api)).toMatchObject({ ok: false });
    expect(await evaluateReuse({ event: "schedule", baseRef: "main", base: BASE, head: HEAD, repo: REPO, root: "/nonexistent", required: CI_REUSE_CHECKS }, api)).toMatchObject({ ok: false });
    expect(await evaluateReuse({ event: "pull_request", baseRef: "other-branch", base: BASE, head: HEAD, repo: REPO, root: "/nonexistent", required: CI_REUSE_CHECKS }, api)).toMatchObject({ ok: false });
    expect(called).toBe(false);
  });
});

describe("ci-reuse: CLI fail-closed behaviour", () => {
  const script = join(import.meta.dirname, "..", "scripts", "ci-reuse.mjs");

  test("decide prints literal reuse=false and exits 0 for non-pull_request or missing token", () => {
    const ran = spawnSync(process.execPath, [script, "decide", "--event", "push", "--base-ref", "main", "--base", BASE, "--head", HEAD, "--repo", REPO, "--root", ".", "--checks", JSON.stringify(CI_REUSE_CHECKS)], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" } });
    expect(ran.status).toBe(0);
    expect(ran.stdout.trim()).toBe("reuse=false");
    expect(ran.stderr).toContain("::stop-commands::");
  });

  test("verify exits 1 (fail closed) on unproven or non-pull_request input", () => {
    const ran = spawnSync(process.execPath, [script, "verify", "--event", "push", "--base-ref", "main", "--base", BASE, "--head", HEAD, "--repo", REPO, "--root", ".", "--check", "node 24 · ubuntu-latest", "--workflow", CI_WORKFLOW], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" } });
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain("::stop-commands::");
  });
});
