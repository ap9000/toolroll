import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { journalFile, readJournal, REQUIRED_PR_CHECKS, REQUIRED_PR_CHECKS_WORKFLOW, RELEASE_TAG_CHECKS, runRelease, type CheckRun, type GateState, type HomebrewState, type MainProof, type ReleaseAdapters } from "./release.js";
import { DatabaseSync } from "node:sqlite";
import { purposeCheckMode, readReleaseCheckPurpose } from "./contracts/release-terms.js";
import { liveSchemaProblem } from "./release-cli.js";
import { githubJson, mainReads, type Exec } from "./release-adapters.js";
import { openStore, SCHEMA_VERSION } from "./store.js";
import { bumpVersion, changelogWith, firstParentAfter, harnessChanges, mainJournalFile, sameRelease } from "./release-main.js";

const M = "a".repeat(40), TREE = "c".repeat(40), HEAD = "d".repeat(40), LATER = "e".repeat(40), PARENT = "f".repeat(40), OTHER = "9".repeat(40);
const OLD = "/state/runtime-old/dist", NEW = "/state/runtime-new/dist";
const T0 = Date.parse("2026-11-25T09:00:00.000Z");
const PROOF: MainProof = { sha: M, tree: TREE, pr: 520, head: HEAD, branch: "release-0.9.119" };
const passing = (names: readonly string[], workflow?: string): CheckRun[] => names.map((name, i) => ({ name, status: "completed", conclusion: "success", id: i + 1, app: "github-actions", suite: 1,
  workflowPath: workflow ?? (REQUIRED_PR_CHECKS_WORKFLOW as Record<string, string>)[name] ?? ".github/workflows/ci.yml" }));
const NOT_FILED: GateState = { exists: false, candidate: null, scopeDigest: null, approval: null, result: null, failed: null, completion: null };

/** A scripted world for a release from main: GitHub's proof, main's history, the plane and the installed Toolroll. */
function world() {
  const s = {
    now: T0,
    pull: { kind: "merged", pr: 520, sha: M } as Awaited<ReturnType<NonNullable<ReleaseAdapters["github"]["main"]>["pull"]>>,
    /** What each proof answers, in order (the last repeats). */
    proofs: [{ ok: true as const, ...PROOF }] as ({ ok: true } & MainProof | { ok: false; why: string })[],
    proofCalls: 0,
    firstParent: [{ ok: true as const, after: [] as string[] }] as ({ ok: true; after: string[] } | { ok: false; why: string })[],
    fpCalls: 0,
    headChecks: passing([...REQUIRED_PR_CHECKS, "node 26 · SQLite"]) as CheckRun[],
    files: new Map([["package.json", JSON.stringify({ name: "toolroll", version: "0.9.119" })], ["CHANGELOG.md", "# Changelog\n\n## 0.9.119 — 2026-11-25\n\n- From main.\n"]]),
    gate: NOT_FILED, gateId: null as string | null,
    coverage: "deploy" as string | null,
    installed: { services: [OLD], clis: [{ name: "toolroll", runtime: OLD as string | null }, { name: "standing-orders", runtime: OLD as string | null }] },
    commits: new Map([[OLD, OTHER]]),
    tags: new Map<string, string>(), published: false,
    brew: { kind: "missing" } as HomebrewState,
    proved: [] as string[],
    filed: [] as unknown[],
    calls: [] as string[], said: [] as string[],
  };
  const adapters: ReleaseAdapters = {
    now: () => new Date(s.now),
    sleep: async ms => {
      s.now += ms;
      // A person approves; then the plane's deploy check passes on the release commit.
      if (s.gate.exists && s.gate.approval === null) s.gate.approval = { by: "alex", at: new Date(s.now).toISOString(), digest: "scope-1", basis: "password", role: "approver", active: true, person: { ok: true, method: "password-now" } };
      else if (s.gate.approval !== null && s.gate.result === null) s.gate.result = { run: 3300, head: M, check: "passed", level: "full", receipt: "receipt-1", worktree: "/worktrees/release", coverage: s.coverage };
    },
    say: line => { s.said.push(line); },
    release: {
      authority: async () => null, live: async () => ({ applies: false, ok: true, why: null }),
      lease: async () => ({ ok: false, why: "unused" }), renew: async () => false, carry: async () => ({ ok: false, message: "unused" }),
      reserve: async () => ({ ok: false, why: "unused" }), start: async () => false, finish: async () => false, needsApproval: async () => false, operations: async () => [],
      proved: async input => { s.proved.push(`${input.taskId}@${s.calls.length}`); },
    },
    repo: {
      github: async () => "ap9000/toolroll", sync: async () => {}, remoteHead: async () => null, deleteBranch: async () => { s.calls.push("deleteBranch"); },
      tree: async sha => { if (sha !== M) throw new Error(`no ${sha}`); return TREE; },
      fileAt: async (_sha, path) => s.files.get(path) ?? null,
    },
    toolroll: {
      installed: async () => structuredClone(s.installed),
      runtimeCommit: async runtime => s.commits.get(runtime) ?? null,
      gate: async id => (id === s.gateId ? structuredClone(s.gate) : NOT_FILED),
      fileGate: async input => { s.gateId = input.taskId; s.filed.push(input); s.gate = { ...NOT_FILED, exists: true, candidate: input.candidate, scopeDigest: "scope-1" }; s.calls.push("fileGate"); return { scopeDigest: "scope-1" }; },
      complete: async (_task, receipt) => { s.gate.completion = { actor: "alex", at: new Date(s.now).toISOString(), digest: receipt }; s.calls.push("complete"); return { ok: true }; },
      busy: async () => ({ running: 0, tasks: [] }),
      recoverDeploy: async () => ({ ok: true }), deploymentIdle: async () => true,
      deploy: async () => { s.commits.set(NEW, M); s.installed = { ...s.installed, services: [NEW] }; s.calls.push("deploy"); return { ok: true, runtime: NEW }; },
      cliLinks: async () => [{ name: "toolroll", path: "/usr/local/bin/toolroll", before: `${OLD}/bin.js` }, { name: "standing-orders", path: "/usr/local/bin/standing-orders", before: `${OLD}/bin.js` }],
      switchLinks: async () => { s.calls.push("switchLinks"); s.installed = { ...s.installed, clis: s.installed.clis.map(one => ({ ...one, runtime: NEW })) }; },
    },
    github: {
      authenticated: async () => true,
      pullRequest: async () => { throw new Error("a release from main never reads a branch's pull request"); },
      checks: async (_repo, sha, options) => sha === HEAD ? structuredClone(s.headChecks).map(run => ({ ...run, head: sha }))
        : options?.tag !== undefined ? passing(RELEASE_TAG_CHECKS, ".github/workflows/publish.yml").map(run => ({ ...run, head: sha })) : [],
      merge: async () => { throw new Error("a release from main never merges"); },
      mainHead: async () => LATER, contains: async () => true,
      upToDateRequired: async () => ({ effective: true, missing: [], notYetRequired: [] }),
      tag: async (_repo, tag) => s.tags.get(tag) ?? null,
      createTag: async (_repo, tag, sha) => { s.tags.set(tag, sha); s.published = true; s.calls.push("createTag"); },
      release: async () => s.published,
      main: {
        pull: async () => structuredClone(s.pull),
        prove: async () => { s.calls.push("prove"); return structuredClone(s.proofs[Math.min(s.proofCalls++, s.proofs.length - 1)]!); },
        firstParent: async () => structuredClone(s.firstParent[Math.min(s.fpCalls++, s.firstParent.length - 1)]!),
        changedSince: async () => [".github/workflows/ci.yml", "src/serve.ts", "package.json"],
      },
    },
    registry: { published: async () => s.published },
    homebrew: {
      repo: "ap9000/homebrew-toolroll", checked: async () => false, statuses: async () => [], state: async () => structuredClone(s.brew),
      propose: async () => { s.brew = { kind: "proposed", pr: 12, head: OTHER }; s.calls.push("propose"); return { pr: 12, head: OTHER }; },
      verified: async () => ({ ok: true }), merge: async () => { s.brew = { kind: "current" }; s.calls.push("brewMerge"); },
    },
  };
  return { s, adapters };
}

const options = (dir: string, extra: Partial<Parameters<typeof runRelease>[0]> = {}) => ({ branch: "release-0.9.119", version: "0.9.119", checkout: "/rv", stateDir: dir, pollMs: 15_000, ...extra });
const stateDir = () => mkdtempSync(join(tmpdir(), "so-release-main-"));

describe("toolroll release <version>: a release from main", () => {
  test("proves before filing, before the deploy and before the tag; never merges; tags the release commit", async () => {
    const dir = stateDir();
    const { s, adapters } = world();
    const outcome = await runRelease(options(dir), adapters);
    expect(outcome).toMatchObject({ ok: true });
    expect(s.calls).toEqual(["prove", "fileGate", "complete", "prove", "deploy", "switchLinks", "prove", "createTag", "propose"]);
    expect(s.tags.get("v0.9.119")).toBe(M);
    // The plane keeps each proof for the task (its deploy gates require one after the approval).
    expect(s.proved.length).toBe(3);
    expect(s.filed[0]).toMatchObject({ candidate: M, release: { version: "0.9.119", pr: 520, branch: "release-0.9.119", noCarry: true, main: { full: false } } });
    expect(readJournal(mainJournalFile(dir, "0.9.119"))).toMatchObject({ mode: "main", step: "homebrew", published: expect.anything(), candidate: { sha: M, tree: TREE }, merge: { sha: M }, tagged: { sha: M }, ci: null });
    // The harness changed since 0.9.118: said, never forced.
    expect(s.said.join("\n")).toMatch(/\.github\/workflows\/ci\.yml.*--full --new/);
  });

  test("commits appended to main after the release commit change nothing: they go in the next release", async () => {
    const { s, adapters } = world();
    s.firstParent = [{ ok: true, after: [] }, { ok: true, after: [LATER] }];
    expect(await runRelease(options(stateDir()), adapters)).toMatchObject({ ok: true });
    expect(s.tags.get("v0.9.119")).toBe(M);
    expect(s.said.join("\n")).toMatch(/1 later commit on main goes in the next release/);
  });

  test("a release commit rewritten off main or removed stops before the deploy; nothing is deployed or tagged", async () => {
    const { s, adapters } = world();
    s.firstParent = [{ ok: true, after: [] }, { ok: false, why: `${M.slice(0, 7)} isn't on main's first-parent history` }];
    const outcome = await runRelease(options(stateDir()), adapters);
    expect(outcome).toMatchObject({ ok: false, reason: "drift", step: "deploy" });
    expect(s.calls).not.toContain("deploy");
    expect(s.tags.size).toBe(0);
  });

  test("a proof that fails files nothing and says the one way on", async () => {
    const { s, adapters } = world();
    s.proofs = [{ ok: false, why: "node 22 · macos-latest: failure in .github/workflows/release-candidate.yml run 7" }];
    const outcome = await runRelease(options(stateDir()), adapters);
    expect(outcome).toMatchObject({ ok: false, reason: "proof" });
    expect(s.calls).toEqual(["prove"]);
    expect(outcome.ok === false && outcome.message).toBe("0.9.119 can't be released from aaaaaaa: node 22 · macos-latest: failure in .github/workflows/release-candidate.yml run 7. Nothing was checked, deployed, tagged or published. Merge a release pull request for 0.9.119 (`toolroll release prepare 0.9.119`), then run `toolroll release 0.9.119`.");
  });

  test("a newer attempt failing while the approval waited stops the deploy (the proof is complete again right before it)", async () => {
    const { s, adapters } = world();
    s.proofs = [{ ok: true, ...PROOF }, { ok: false, why: "node 24 · macos-latest: failure in .github/workflows/ci.yml run 9" }];
    const outcome = await runRelease(options(stateDir()), adapters);
    expect(outcome).toMatchObject({ ok: false, reason: "proof", step: "deploy" });
    expect(outcome.ok === false && outcome.message).toMatch(/Nothing was deployed, tagged or published/);
    expect(s.calls).not.toContain("deploy");
  });

  test("a resume binds to the same commit, tree, pull request and head: a different proof stops it", async () => {
    const { s, adapters } = world();
    s.proofs = [{ ok: true, ...PROOF }, { ok: true, ...PROOF, head: OTHER }];
    const outcome = await runRelease(options(stateDir()), adapters);
    expect(outcome).toMatchObject({ ok: false, reason: "drift", step: "deploy" });
    expect(s.calls).not.toContain("deploy");
  });

  test("another reported check failing on the tested head (not a required one) stops the release", async () => {
    const { s, adapters } = world();
    s.headChecks = passing([...REQUIRED_PR_CHECKS, "node 26 · SQLite"]).map(run => run.name === "node 26 · SQLite" ? { ...run, conclusion: "failure" } : run);
    const outcome = await runRelease(options(stateDir()), adapters);
    expect(outcome).toMatchObject({ ok: false, reason: "ci-failed" });
    expect(s.calls).toEqual(["prove"]);
  });

  test("a release pull request still open is merged like any other first; one from another branch never stands in", async () => {
    const open = world();
    open.s.pull = { kind: "open", pr: 520, head: HEAD };
    expect(await runRelease(options(stateDir()), open.adapters)).toMatchObject({ ok: false, reason: "not-merged", message: "Releases now go from main. Merge #520 like any pull request once its checks pass, then run `toolroll release 0.9.119`." });
    const elsewhere = world();
    elsewhere.s.proofs = [{ ok: true, ...PROOF, branch: "feature/x" }];
    expect(await runRelease(options(stateDir()), elsewhere.adapters)).toMatchObject({ ok: false, reason: "proof" });
    expect(elsewhere.s.calls).toEqual(["prove"]);
  });

  test("deploys only on the deploy check (or the full one); a check that doesn't say what it covered stops before the deploy", async () => {
    const unnamed = world();
    unnamed.s.coverage = null;
    expect(await runRelease(options(stateDir()), unnamed.adapters)).toMatchObject({ ok: false, reason: "check-level", step: "check" });
    expect(unnamed.s.calls).not.toContain("deploy");
    // --full: a deploy check's result is not the full check it was approved for.
    const full = world();
    expect(await runRelease(options(stateDir(), { full: true }), full.adapters)).toMatchObject({ ok: false, reason: "check-level", step: "check" });
    expect(full.s.filed[0]).toMatchObject({ release: { main: { full: true } } });
  });

  test("a failed deploy check says what didn't happen and the one way on", async () => {
    const { s, adapters } = world();
    adapters.sleep = async ms => {
      s.now += ms;
      if (s.gate.exists && s.gate.approval === null) s.gate.approval = { by: "alex", at: new Date(s.now).toISOString(), digest: "scope-1", basis: "password", role: "approver", active: true, person: { ok: true, method: "password-now" } };
      else if (s.gate.approval !== null && s.gate.result === null) s.gate.result = { run: 3300, head: M, check: "failed", level: "full", receipt: "receipt-1", worktree: "/w", coverage: "deploy" };
    };
    const outcome = await runRelease(options(stateDir()), adapters);
    expect(outcome).toMatchObject({ ok: false, reason: "check-failed" });
    expect(outcome.ok === false && outcome.message).toBe("The deploy check of aaaaaaa failed (run 3300): its check reads failed. Nothing was deployed, tagged or published; Toolroll here is unchanged. Fix it on main, merge a release pull request for 0.9.119 again, then run `toolroll release 0.9.119 --new`.");
  });

  test("a branch journal and a version journal never stand in for each other", async () => {
    const dir = stateDir();
    const { adapters } = world();
    expect(mainJournalFile(dir, "0.9.119")).not.toBe(journalFile(dir, "release-0.9.119"));
    expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: true });
    // The branch command never reads the version's journal: it starts its own (and stops on its own rules).
    expect(readJournal(journalFile(dir, "release-0.9.119"))).toBeNull();
  });
});

describe("release-main helpers", () => {
  test("bumpVersion changes exactly the version spans", () => {
    const manifest = `{\n  "name": "toolroll",\n  "version": "0.9.118",\n  "scripts": { "x": "version 0.9.118" }\n}\n`;
    expect(bumpVersion("package.json", manifest, "0.9.118", "0.9.119")).toBe(manifest.replace(`"version": "0.9.118"`, `"version": "0.9.119"`));
    const lock = `{\n  "name": "toolroll",\n  "version": "0.9.118",\n  "lockfileVersion": 3,\n  "packages": {\n    "": {\n      "name": "toolroll",\n      "version": "0.9.118"\n    },\n    "node_modules/x": { "version": "0.9.118" }\n  }\n}\n`;
    const bumped = bumpVersion("package-lock.json", lock, "0.9.118", "0.9.119")!;
    expect(bumped.match(/0\.9\.119/g)).toHaveLength(2);
    expect(bumped).toContain(`"node_modules/x": { "version": "0.9.118" }`);
    for (const [file, text] of [
      ["package.json", `{ "version": "0.9.118", "version": "0.9.118" }`],
      ["package.json", `{ "dependencies": { "version": "0.9.118" }, "version": "0.9.118" }`],
      ["package.json", `{ "version": "0.9.117" }`],
      ["package-lock.json", `{ "version": "0.9.118", "packages": { "": { "version": "0.9.117" } } }`],
    ] as const) expect(bumpVersion(file, text, "0.9.118", "0.9.119")).toBeNull();
    expect(bumpVersion("package.json", `{ "version": "0.9.118" }`, "0.9.118", "0.9.119\"$(id)")).toBeNull();
  });

  test("firstParentAfter walks main's first parents only", () => {
    const parents = new Map<string, string[]>([[LATER, [M, OTHER]], [M, [PARENT]], [PARENT, []], [OTHER, [M]]]);
    expect(firstParentAfter(LATER, M, parents)).toEqual([LATER]);
    expect(firstParentAfter(M, M, parents)).toEqual([]);
    // Reached only through a second parent: not on main's first-parent history.
    expect(firstParentAfter(LATER, OTHER, parents)).toBeNull();
    expect(firstParentAfter(LATER, HEAD, parents)).toBeNull();
  });

  test("sameRelease names every way a proof differs", () => {
    expect(sameRelease(PROOF, PROOF)).toBeNull();
    for (const changed of [{ sha: OTHER }, { tree: OTHER }, { pr: 521 }, { head: OTHER }, { branch: "release-x" }]) expect(sameRelease(PROOF, { ...PROOF, ...changed })).not.toBeNull();
  });

  test("changelogWith puts the entry before the newest release; harnessChanges names CI's rules and the harness", () => {
    expect(changelogWith("# Changelog\n\n## 0.9.118 — x\n", "0.9.119", "- A.", "2026-11-25")).toBe("# Changelog\n\n## 0.9.119 — 2026-11-25\n\n- A.\n\n## 0.9.118 — x\n");
    expect(harnessChanges(["src/serve.ts", ".github/workflows/ci.yml", "scripts/release-check.mjs", "vitest.config.ts", "docs/x.md", "scripts/browser-build.mjs"]))
      .toEqual([".github/workflows/ci.yml", "scripts/release-check.mjs", "vitest.config.ts", "scripts/browser-build.mjs"]);
  });
});

describe("a release from main's sealed purpose", () => {
  const base = { version: 1, repo: "/rv", packageVersion: "0.9.119", branch: "release-0.9.119", pr: 520, base: "main", approvedSha: M, approvedTree: TREE, grant: { id: 1, digest: "g" }, access: "unsandboxed" } as const;
  test("names its check, and only a main release does", () => {
    expect(readReleaseCheckPurpose({ ...base, purpose: "main-release", check: "deploy" }).ok).toBe(true);
    expect(readReleaseCheckPurpose({ ...base, purpose: "main-release" }).ok).toBe(false);
    expect(readReleaseCheckPurpose({ ...base, purpose: "release-check", check: "deploy" }).ok).toBe(false);
    expect(purposeCheckMode({ ...base, purpose: "main-release", check: "deploy" })).toBe("deploy");
    expect(purposeCheckMode({ ...base, purpose: "main-release", check: "full" })).toBe("full");
    expect(purposeCheckMode({ ...base, purpose: "release-check" })).toBe("full");
    expect(purposeCheckMode(null)).toBeNull();
  });
});

describe("the coordinator's own build", () => {
  test("refuses a database another build's schema wrote: a candidate's checkout never migrates the live one", () => {
    const dir = stateDir();
    expect(liveSchemaProblem(join(dir, "none.db"))).toBeNull();
    const file = join(dir, "orders.db");
    openStore(file).close();
    expect(liveSchemaProblem(file)).toBeNull();
    const db = new DatabaseSync(file);
    db.exec(`UPDATE schema_version SET version = ${SCHEMA_VERSION - 8}`);
    db.close();
    expect(liveSchemaProblem(file)).toMatch(/upgrade the live database under the running services\. Nothing was changed/);
  });
});

describe("GitHub as a release from main reads it (release-adapters.ts mainReads)", () => {
  const REPO = "ap9000/toolroll";
  /** gh api answers by path; anything else fails, as a missing read would. */
  const ghWith = (answers: Record<string, unknown>, calls: string[] = []): Exec => async (_gh, args) => {
    if (args.includes("--jq")) {
      const path = args.find(one => one.startsWith("repos/"))!;
      calls.push(path);
      if (path.endsWith("git/ref/heads/main")) return { code: 0, stdout: `commit ${LATER}\n`, stderr: "" };
      return { code: 1, stdout: "", stderr: "HTTP 404" };
    }
    const path = args.at(-1)!;
    calls.push(path);
    return path in answers ? { code: 0, stdout: JSON.stringify(answers[path]), stderr: "" } : { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
  };
  const pr = (number: number, fields: Record<string, unknown>, own = true) => ({ number, state: "closed", merged_at: null, merge_commit_sha: null,
    base: { ref: "main", repo: { full_name: REPO } }, head: { ref: "release-0.9.119", sha: HEAD, repo: { full_name: own ? REPO : "someone/toolroll" } }, ...fields });

  test("the release pull request: this repository's own branch into main, the newest merged one; a fork's never counts", async () => {
    const pulls = `repos/${REPO}/pulls?state=all&head=${encodeURIComponent("ap9000:release-0.9.119")}&per_page=100`;
    const reads = mainReads(ghWith({ [pulls]: [pr(9, { merged_at: "2026-11-25T10:00:00Z", merge_commit_sha: OTHER }, false), pr(520, { merged_at: "2026-11-25T09:00:00Z", merge_commit_sha: M })] }), "/usr/bin/gh");
    expect(await reads.pull(REPO, "0.9.119")).toEqual({ kind: "merged", pr: 520, sha: M });
    const open = mainReads(ghWith({ [pulls]: [pr(521, { state: "open" })] }), "/usr/bin/gh");
    expect(await open.pull(REPO, "0.9.119")).toEqual({ kind: "open", pr: 521, head: HEAD });
    expect(await mainReads(ghWith({ [pulls]: [] }), "/usr/bin/gh").pull(REPO, "0.9.119")).toEqual({ kind: "none" });
  });

  test("first-parent membership from main's head as GitHub has it; a commit only a second parent reaches, or none, isn't on main", async () => {
    const list = `repos/${REPO}/commits?sha=${LATER}&per_page=100&page=1`;
    const commits = [{ sha: LATER, parents: [{ sha: M }, { sha: OTHER }] }, { sha: OTHER, parents: [{ sha: PARENT }] }, { sha: M, parents: [{ sha: PARENT }] }, { sha: PARENT, parents: [] }];
    const reads = mainReads(ghWith({ [list]: commits }), "/usr/bin/gh");
    expect(await reads.firstParent(REPO, M)).toEqual({ ok: true, after: [LATER] });
    expect(await reads.firstParent(REPO, OTHER)).toMatchObject({ ok: false });
  });

  test("the proof is publish.yml's own function, with every required check and its workflow", async () => {
    const asked: unknown[] = [];
    const reads = mainReads(ghWith({}), "/usr/bin/gh", async () => ({ proveRelease: async input => { asked.push(input); return { ok: true, pr: 520, head: HEAD, branch: "release-0.9.119", tree: TREE }; } }));
    expect(await reads.prove(REPO, M)).toEqual({ ok: true, sha: M, tree: TREE, pr: 520, head: HEAD, branch: "release-0.9.119" });
    expect(asked).toEqual([{ repo: REPO, sha: M, required: { ...REQUIRED_PR_CHECKS_WORKFLOW } }]);
  });

  test("its GitHub reader reads only repos/<owner>/<name>/… paths", async () => {
    const read = githubJson(ghWith({}), "/usr/bin/gh");
    await expect(read("user/repos")).rejects.toThrow(/not a GitHub read/);
    await expect(read(`repos/${REPO}/../x`)).rejects.toThrow(/not a GitHub read/);
  });
});
