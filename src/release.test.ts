import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  checksVerdict, gateTaskId, journalFile, ownerApproval, readJournal, writeJournal, REQUIRED_PR_CHECKS, RELEASE_TAG_CHECKS, runRelease,
  type CheckRun, type GateState, type HomebrewState, type ReleaseAdapters, type ReleaseJournal,
} from "./release.js";

const SHA = "a".repeat(40), MERGE = "b".repeat(40), TREE = "c".repeat(40), OTHER = "d".repeat(40);
const OLD = "/state/staged-upgrades/browser-old/runtime/node_modules/toolroll/dist";
const NEW = "/state/staged-upgrades/browser-new/runtime/node_modules/toolroll/dist";
const DIGEST = "scope-digest-1", RECEIPT = "receipt-1";
const T0 = Date.parse("2026-10-08T09:00:00.000Z");
const passing = (names: readonly string[]): CheckRun[] => names.map(name => ({ name, status: "completed", conclusion: "success" }));
const MUTATIONS = ["fileGate", "complete", "deploy", "merge", "deleteBranch", "createTag", "propose", "brewMerge"] as const;
type Mutation = typeof MUTATIONS[number];

/** A scripted world: GitHub, npm, the tap and the installed Toolroll, with every change it was asked to make. */
function world(options: { crashAfter?: Mutation } = {}) {
  let crash = options.crashAfter;
  const s = {
    now: T0,
    branchHead: SHA as string | null,
    main: "e".repeat(40),
    /** main gained a commit the branch doesn't have. */
    mainMoved: false,
    pr: { number: 170, state: "open" as "open" | "closed" | "merged", head: SHA, base: "main", mergeCommit: null as string | null },
    trees: new Map<string, string>([[SHA, TREE]]),
    files: new Map<string, string>([["package.json", JSON.stringify({ name: "toolroll", version: "0.9.52" })], ["CHANGELOG.md", "# Changelog\n\n## 0.9.52 — 2026-10-08\n\n- One-command release.\n"]]),
    gate: { exists: false, candidate: null, scopeDigest: null, approval: null, result: null, failed: null, completion: null } as GateState,
    /** The one release task this world holds. */
    gateId: null as string | null,
    /** What a person or the worker does while the release waits: applied on each sleep. */
    onSleep: [] as ((state: typeof s) => void)[],
    checks: new Map<string, CheckRun[]>([[SHA, passing(REQUIRED_PR_CHECKS)], [`brew:${OTHER}`, passing(["brew test"])]]),
    installed: { services: [OLD], clis: [{ name: "toolroll", runtime: OLD as string | null }, { name: "standing-orders", runtime: OLD as string | null }] },
    /** Where each CLI name's link points, and whether moving them fails its check. */
    links: new Map<string, string | null>([["/usr/local/bin/toolroll", `${OLD}/bin.js`], ["/usr/local/bin/standing-orders", `${OLD}/bin.js`]]),
    linkFails: false,
    commits: new Map([[OLD, OTHER], [NEW, SHA]]),
    running: 0,
    tags: new Map<string, string>(),
    published: false,
    released: false,
    brew: { kind: "missing" } as HomebrewState,
    calls: [] as string[],
    said: [] as string[],
  };
  /** A change lands, and then (once, when asked) the process dies before hearing back. */
  const landed = (name: Mutation) => {
    s.calls.push(name);
    if (crash === name) { crash = undefined; throw new Error(`lost the answer to ${name}`); }
  };
  const person = (state: typeof s) => {
    if (state.gate.exists && state.gate.approval === null) state.gate.approval = { by: "alex", at: new Date(state.now).toISOString(), digest: DIGEST, basis: "password", role: "approver", active: true };
    else if (state.gate.approval !== null && state.gate.result === null) state.gate.result = { run: 2757, head: state.gate.candidate, check: "passed", level: "full", receipt: RECEIPT, worktree: "/worktrees/release" };
  };
  s.onSleep.push(person);
  const adapters: ReleaseAdapters = {
    now: () => new Date(s.now),
    sleep: async ms => { s.now += ms; for (const step of s.onSleep) step(s); },
    say: line => { s.said.push(line); },
    repo: {
      github: async () => "ap9000/toolroll",
      sync: async () => {},
      remoteHead: async () => s.branchHead,
      deleteBranch: async (_branch, head) => {
        if (s.branchHead === null) return;
        if (s.branchHead !== head) throw new Error("branch moved; not deleted");
        s.branchHead = null;
        landed("deleteBranch");
      },
      tree: async sha => { const tree = s.trees.get(sha); if (tree === undefined) throw new Error(`no ${sha}`); return tree; },
      fileAt: async (_sha, path) => s.files.get(path) ?? null,
      mainHead: async () => s.main,
      contains: async (_sha, ancestor) => ancestor === s.main && !s.mainMoved,
    },
    toolroll: {
      installed: async () => structuredClone(s.installed),
      runtimeCommit: async runtime => s.commits.get(runtime) ?? null,
      gate: async id => (id === s.gateId ? structuredClone(s.gate) : { exists: false, candidate: null, scopeDigest: null, approval: null, result: null, failed: null, completion: null }),
      fileGate: async input => {
        s.gateId = input.taskId;
        s.gate = { exists: true, candidate: input.candidate, scopeDigest: DIGEST, approval: null, result: null, failed: null, completion: null };
        landed("fileGate");
        return { scopeDigest: DIGEST };
      },
      complete: async (_task, receipt) => { s.gate.completion = { actor: "lead:alex", at: new Date(s.now).toISOString(), digest: receipt }; landed("complete"); return { ok: true }; },
      busy: async () => ({ running: s.running, tasks: [] }),
      recoverDeploy: async () => ({ ok: true }),
      deploy: async () => {
        s.commits.set(NEW, s.gate.candidate!);
        // The deployer swaps the service; the CLI names are the release's link step.
        s.installed = { ...s.installed, services: [NEW] };
        landed("deploy");
        return { ok: true, runtime: NEW };
      },
      cliLinks: async () => [...s.links].map(([path, before]) => ({ name: path.split("/").at(-1)!, path, before })),
      switchLinks: async (links, bin) => {
        s.calls.push("switchLinks");
        for (const link of links) s.links.set(link.path, bin);
        if (s.linkFails) { for (const link of links) s.links.set(link.path, link.before); throw new Error("standing-orders does not answer as the released build"); }
        s.installed = { ...s.installed, clis: s.installed.clis.map(one => ({ ...one, runtime: bin.replace(/\/bin\.js$/, "") })) };
      },
    },
    github: {
      authenticated: async () => true,
      pullRequest: async () => ({ ...s.pr }),
      checks: async (repo, sha) => structuredClone(s.checks.get(`${repo === "ap9000/homebrew-toolroll" ? "brew:" : ""}${sha}`) ?? []),
      merge: async (_repo, _pr, head) => {
        if (head !== s.pr.head) throw new Error("Head branch was modified");
        s.pr = { ...s.pr, state: "merged", mergeCommit: MERGE };
        s.trees.set(MERGE, s.trees.get(MERGE) ?? TREE);
        landed("merge");
        return MERGE;
      },
      tag: async (_repo, tag) => s.tags.get(tag) ?? null,
      createTag: async (_repo, tag, sha) => {
        s.tags.set(tag, sha);
        s.published = true; s.released = true;
        s.checks.set(sha, passing(RELEASE_TAG_CHECKS));
        landed("createTag");
      },
      release: async () => s.released,
    },
    registry: { published: async () => s.published },
    homebrew: {
      repo: "ap9000/homebrew-toolroll",
      state: async () => structuredClone(s.brew),
      propose: async () => { s.brew = { kind: "proposed", pr: 12, head: OTHER }; landed("propose"); return { pr: 12, head: OTHER }; },
      merge: async () => { s.brew = { kind: "current" }; landed("brewMerge"); },
    },
  };
  return { s, adapters };
}

const stateDir = () => mkdtempSync(join(tmpdir(), "so-release-"));
const options = (dir: string, extra: Partial<Parameters<typeof runRelease>[0]> = {}) => ({ branch: "toolroll/simplify-release", checkout: "/rv", stateDir: dir, pollMs: 15_000, ...extra });

describe("toolroll release", () => {
  test("runs from the gated commit to Homebrew, each change once, in order, in a private journal", async () => {
    const dir = stateDir();
    const { s, adapters } = world();
    const outcome = await runRelease(options(dir), adapters);
    expect(outcome).toMatchObject({ ok: true });
    expect(s.calls).toEqual(["fileGate", "complete", "deploy", "switchLinks", "merge", "deleteBranch", "createTag", "propose", "brewMerge"]);
    expect([...s.links.values()]).toEqual([`${NEW}/bin.js`, `${NEW}/bin.js`]);
    const file = journalFile(dir, "toolroll/simplify-release");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readJournal(file)).toMatchObject({
      step: "done", candidate: { sha: SHA, tree: TREE }, packageVersion: "0.9.52", tag: "v0.9.52", pr: 170,
      task: { id: gateTaskId("0.9.52", SHA), scopeDigest: DIGEST }, approval: { by: "alex" }, check: { run: 2757, receipt: RECEIPT },
      deploy: { runtime: NEW }, merge: { sha: MERGE, tree: TREE }, tagged: { sha: MERGE }, homebrew: { pr: 12, merged: true }, stopped: null,
    });
    expect(s.tags.get("v0.9.52")).toBe(MERGE);
    // Nothing but the journal itself is left in the folder.
    expect(readdirSync(join(dir, "releases"))).toEqual(["toolroll_simplify-release.json"]);
    // Finished is finished: running it again changes nothing.
    expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: true });
    expect(s.calls).toHaveLength(9);
  });

  test.each(MUTATIONS)("a crash right after %s landed resumes without doing it twice", async mutation => {
    const dir = stateDir();
    const { s, adapters } = world({ crashAfter: mutation });
    const first = await runRelease(options(dir), adapters);
    expect(first).toMatchObject({ ok: false, reason: "error", resume: "toolroll release toolroll/simplify-release --repo /rv" });
    expect(readJournal(journalFile(dir, "toolroll/simplify-release"))?.stopped).toMatchObject({ reason: "error", message: `lost the answer to ${mutation}` });
    expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: true });
    for (const name of MUTATIONS) expect(s.calls.filter(one => one === name), name).toHaveLength(1);
  });

  test.each(["merge", "tag", "publish"] as const)("resumes %s from only the durable intent after a hard crash", async step => {
    const dir = stateDir(), file = journalFile(dir, "toolroll/simplify-release");
    const { s, adapters } = world();
    let snapshot: ReleaseJournal | null = null;
    const crash = () => {
      const saved = readJournal(file);
      if (snapshot !== null || saved?.step !== step) return;
      snapshot = saved;
      expect(snapshot.intents[step]).toBeDefined();
      throw new Error("process died before journal save");
    };
    if (step === "merge") {
      const merge = adapters.github.merge;
      adapters.github.merge = async (...args) => { const result = await merge(...args); crash(); return result; };
    } else if (step === "tag") {
      const tag = adapters.github.createTag;
      adapters.github.createTag = async (...args) => { await tag(...args); crash(); };
    } else {
      const published = adapters.registry.published;
      adapters.registry.published = async (...args) => { const result = await published(...args); crash(); return result; };
    }
    expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: false, step, reason: "error" });
    // A hard kill cannot save the catch block's stop; restore exactly the last durable bytes.
    expect(snapshot).not.toBeNull();
    writeJournal(file, snapshot!);
    expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: true });
    for (const mutation of MUTATIONS) expect(s.calls.filter(one => one === mutation), mutation).toHaveLength(1);
    expect(s.branchHead).toBeNull();
  });

  describe("the approval is the owner's", () => {
    const gate = (approval: GateState["approval"]): GateState => ({ exists: true, candidate: SHA, scopeDigest: DIGEST, approval, result: null, failed: null, completion: null });
    const at = "2026-10-08T09:00:00.000Z";

    test("a person's yes to these exact bytes, by password or chat, and nothing else", () => {
      expect(ownerApproval(gate({ by: "alex", at, digest: DIGEST, basis: "password", role: "approver", active: true }), DIGEST)).toEqual({ ok: true, by: "alex", at });
      expect(ownerApproval(gate({ by: "alex", at, digest: DIGEST, basis: "chat", role: "approver", active: true }), DIGEST)).toMatchObject({ ok: true });
      expect(ownerApproval(gate(null), DIGEST)).toMatchObject({ ok: false, why: "not approved yet" });
      expect(ownerApproval(gate({ by: "alex", at, digest: "older", basis: "password", role: "approver", active: true }), DIGEST)).toMatchObject({ ok: false });
      expect(ownerApproval(gate({ by: "alex", at, digest: DIGEST, basis: "mode", role: "approver", active: true }), DIGEST)).toMatchObject({ ok: false, why: "approved by mode, not by a person" });
      for (const by of ["Maya (AI)", "mode overnight", "lead:alex", "routine"]) expect(ownerApproval(gate({ by, at, digest: DIGEST, basis: "password", role: "approver", active: true }), DIGEST), by).toMatchObject({ ok: false });
    });

    test("a mode's approval stops the release before any check counts", async () => {
      const dir = stateDir();
      const { s, adapters } = world();
      s.onSleep = [state => { state.gate.approval = { by: "alex", at, digest: DIGEST, basis: "mode", role: "approver", active: true }; }];
      expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: false, step: "approval", reason: "approval" });
      expect(s.calls).toEqual(["fileGate"]);
    });

    test("waiting for the approval has a time limit, and a rerun keeps waiting where it stopped", async () => {
      const dir = stateDir();
      const { s, adapters } = world();
      const person = s.onSleep[0]!;
      s.onSleep = [];
      expect(await runRelease(options(dir, { limits: { approval: 30 } }), adapters)).toMatchObject({ ok: false, step: "approval", reason: "timeout", message: expect.stringContaining("after 30 minutes") });
      expect(s.now - T0).toBeGreaterThanOrEqual(30 * 60_000);
      s.onSleep = [person];
      expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: true });
      expect(s.calls.filter(one => one === "fileGate")).toHaveLength(1);
    });
  });

  test("a failed check stops the release, stays as it is, and is never rerun or completed", async () => {
    const dir = stateDir();
    const { s, adapters } = world();
    s.onSleep = [state => {
      if (state.gate.approval === null) state.gate.approval = { by: "alex", at: "2026-10-08T09:00:00.000Z", digest: DIGEST, basis: "password", role: "approver", active: true };
      else state.gate.result = { run: 2757, head: SHA, check: "failed", level: "full", receipt: RECEIPT, worktree: "/w" };
    }];
    for (let i = 0; i < 2; i += 1) expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: false, step: "check", reason: "check-failed" });
    expect(s.calls).toEqual(["fileGate"]);
  });

  test.each([["quick", "passed"], ["off", "not-run"], [null, "passed"]])("refuses a %s check even with status %s", async (level, check) => {
    const { s, adapters } = world();
    s.onSleep.push(state => { if (state.gate.result) Object.assign(state.gate.result, { level, check }); });
    expect(await runRelease(options(stateDir()), adapters)).toMatchObject({ ok: false, step: "check", reason: "check-level", message: expect.stringContaining("Full check is required") });
    expect(s.calls).toEqual(["fileGate"]);
  });

  test.each([{ role: "viewer", active: true }, { role: "approver", active: false }, { role: null, active: false }])("refuses an approval without current approver standing: %j", async standing => {
    const { s, adapters } = world();
    s.onSleep.push(state => { if (state.gate.approval) Object.assign(state.gate.approval, standing); });
    expect(await runRelease(options(stateDir()), adapters)).toMatchObject({ ok: false, step: "approval", reason: "approval", message: expect.stringContaining("not an active approver") });
    expect(s.calls).toEqual(["fileGate"]);
  });

  test("revoking the approver while the check runs stops completion", async () => {
    const { s, adapters } = world();
    s.onSleep.push(state => { if (state.gate.result && state.gate.approval) state.gate.approval.active = false; });
    expect(await runRelease(options(stateDir()), adapters)).toMatchObject({ ok: false, step: "check", reason: "approval" });
    expect(s.calls).toEqual(["fileGate"]);
  });

  test("a branch that moves after gating stops the release before it deploys or merges", async () => {
    const dir = stateDir();
    const { s, adapters } = world();
    s.onSleep.push(state => { if (state.gate.result !== null) state.branchHead = OTHER; });
    expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: false, step: "deploy", reason: "drift", message: expect.stringContaining("--new") });
    expect(s.calls).toEqual(["fileGate", "complete"]);
    // After the deployment, a moved pull request still stops it before merging.
    const later = world();
    later.s.checks.set(SHA, []);
    later.s.onSleep.push(state => { if (state.installed.services[0] === NEW) state.pr.head = OTHER; });
    expect(await runRelease(options(stateDir()), later.adapters)).toMatchObject({ ok: false, step: "ci", reason: "drift" });
    expect(later.s.calls).not.toContain("merge");
  });

  test("--new sets an unfinished release aside before merging began, and is refused after", async () => {
    const dir = stateDir();
    const { s, adapters } = world();
    s.checks.set(SHA, []);
    expect(await runRelease(options(dir, { limits: { ci: 1 } }), adapters)).toMatchObject({ ok: false, step: "ci", reason: "timeout" });
    s.branchHead = OTHER; s.pr.head = OTHER; s.trees.set(OTHER, TREE);
    expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: false, reason: "drift" });
    const fresh = await runRelease(options(dir, { fresh: true, limits: { ci: 1 } }), adapters);
    expect(fresh).toMatchObject({ ok: false, step: "ci", reason: "timeout" });
    expect(fresh.journal?.task.id).toBe(gateTaskId("0.9.52", OTHER));
    expect(fresh.journal?.candidate.sha).toBe(OTHER);
    // Both candidates have the same package version; the second must still deploy its different commit.
    expect(s.calls.filter(one => one === "deploy")).toHaveLength(2);
    expect(s.commits.get(NEW)).toBe(OTHER);
    expect(readdirSync(join(dir, "releases")).filter(name => name.includes("superseded"))).toHaveLength(1);

    const merged = world({ crashAfter: "merge" });
    const other = stateDir();
    await runRelease(options(other), merged.adapters);
    expect(await runRelease(options(other, { fresh: true }), merged.adapters)).toMatchObject({ ok: false, reason: "merging" });
  });

  describe("pull-request checks", () => {
    const repeat = "Windows Job Object containment · c2 × 20";
    const blocked = [
      { status: "queued", conclusion: null, reason: "timeout" },
      { status: "in_progress", conclusion: null, reason: "timeout" },
      ...["failure", "cancelled", "skipped", "timed_out", "neutral", "action_required", "stale", null]
        .map(conclusion => ({ status: "completed", conclusion, reason: "ci-failed" })),
    ];

    test("every required check passed on the gated commit, its newest attempt counting", () => {
      expect(checksVerdict(passing(REQUIRED_PR_CHECKS), REQUIRED_PR_CHECKS)).toEqual({ state: "passed" });
      const rerun = [{ name: REQUIRED_PR_CHECKS[0], status: "completed", conclusion: "failure" }, ...passing(REQUIRED_PR_CHECKS)];
      expect(checksVerdict(rerun, REQUIRED_PR_CHECKS)).toEqual({ state: "passed" });
      expect(checksVerdict(passing(REQUIRED_PR_CHECKS.slice(1)), REQUIRED_PR_CHECKS)).toEqual({ state: "pending", waiting: [`${REQUIRED_PR_CHECKS[0]} (not started)`] });
      expect(checksVerdict([...passing(REQUIRED_PR_CHECKS.slice(1)), { name: REQUIRED_PR_CHECKS[0], status: "in_progress", conclusion: null }], REQUIRED_PR_CHECKS)).toMatchObject({ state: "pending" });
      // An absent job that GitHub reports as skipped (or a cancelled one) is not a pass.
      for (const conclusion of ["skipped", "cancelled", "timed_out", "neutral", "failure"]) {
        expect(checksVerdict([...passing(REQUIRED_PR_CHECKS.slice(1)), { name: REQUIRED_PR_CHECKS[0], status: "completed", conclusion }], REQUIRED_PR_CHECKS), conclusion).toMatchObject({ state: "failed" });
      }
    });

    test("pending checks wait out their limit and never merge; a failed one stops at once", async () => {
      const pending = world();
      pending.s.checks.set(SHA, passing(REQUIRED_PR_CHECKS.slice(0, 3)));
      expect(await runRelease(options(stateDir(), { limits: { ci: 5 } }), pending.adapters)).toMatchObject({ ok: false, step: "ci", reason: "timeout" });
      expect(pending.s.calls).not.toContain("merge");

      const failed = world();
      failed.s.checks.set(SHA, [...passing(REQUIRED_PR_CHECKS.slice(1)), { name: REQUIRED_PR_CHECKS[0], status: "completed", conclusion: "failure" }]);
      expect(await runRelease(options(stateDir()), failed.adapters)).toMatchObject({ ok: false, step: "ci", reason: "ci-failed", message: expect.stringContaining("Nothing was merged") });
      expect(failed.s.calls).toEqual(["fileGate", "complete", "deploy", "switchLinks"]);
    });

    test("the newest attempt counts for extra checks too, while every required name must still be present", () => {
      expect(REQUIRED_PR_CHECKS).not.toContain(repeat);
      const failure = { name: repeat, status: "completed", conclusion: "failure" };
      const success = passing([repeat]);
      expect(checksVerdict([...passing(REQUIRED_PR_CHECKS), failure, ...success], REQUIRED_PR_CHECKS)).toEqual({ state: "passed" });
      expect(checksVerdict([...passing(REQUIRED_PR_CHECKS), ...success, failure], REQUIRED_PR_CHECKS))
        .toEqual({ state: "failed", failed: [`${repeat} (failure)`] });
      expect(checksVerdict([...passing(REQUIRED_PR_CHECKS.slice(1)), ...success], REQUIRED_PR_CHECKS))
        .toEqual({ state: "pending", waiting: [`${REQUIRED_PR_CHECKS[0]} (not started)`] });
    });

    test.each(blocked)("an extra Windows repeat check blocks CI at $status/$conclusion and resumes after success", async ({ status, conclusion, reason }) => {
      const dir = stateDir();
      const { s, adapters } = world();
      s.checks.set(SHA, [...passing(REQUIRED_PR_CHECKS), { name: repeat, status, conclusion }]);
      const result = await runRelease(options(dir, { limits: { ci: 1 } }), adapters);
      expect(result).toMatchObject({ ok: false, step: "ci", reason });
      expect(s.calls).toEqual(["fileGate", "complete", "deploy", "switchLinks"]);
      if (reason === "ci-failed") expect(result).toMatchObject({ message: expect.stringContaining(repeat) });
      s.checks.get(SHA)!.push(...passing([repeat]));
      expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: true });
      for (const mutation of MUTATIONS) expect(s.calls.filter(one => one === mutation), mutation).toHaveLength(1);
    });

    test.each(blocked)("re-fetches all checks before merge and blocks an extra check now at $status/$conclusion", async ({ status, conclusion }) => {
      const { s, adapters } = world();
      const checks = adapters.github.checks;
      let reads = 0;
      adapters.github.checks = async (repo, sha) => {
        if (sha !== SHA) return checks(repo, sha);
        reads += 1;
        return [...passing(REQUIRED_PR_CHECKS), ...(reads === 1 ? passing([repeat]) : [{ name: repeat, status, conclusion }])];
      };
      expect(await runRelease(options(stateDir()), adapters)).toMatchObject({ ok: false, step: "merge", reason: "ci-failed" });
      expect(reads).toBe(2);
      expect(s.calls).toEqual(["fileGate", "complete", "deploy", "switchLinks"]);
      expect(s.pr.state).toBe("open");
    });
  });

  test("main moving past the branch's base stops the release before it merges", async () => {
    const { s, adapters } = world();
    s.mainMoved = true;
    expect(await runRelease(options(stateDir()), adapters)).toMatchObject({ ok: false, step: "merge", reason: "base-moved", message: expect.stringContaining("Nothing was merged") });
    expect(s.calls).not.toContain("merge");
  });

  test("a merge commit whose tree is not the gated tree is never tagged", async () => {
    const dir = stateDir();
    const { s, adapters } = world();
    s.trees.set(MERGE, OTHER);
    expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: false, step: "tree", reason: "tree-mismatch" });
    expect(s.calls).not.toContain("createTag");
    expect(s.tags.size).toBe(0);
  });

  test("a version tag already on another commit is a conflict, not a reason to move it", async () => {
    const { s, adapters } = world();
    s.onSleep.push(state => { if (state.gate.result !== null) state.tags.set("v0.9.52", OTHER); });
    expect(await runRelease(options(stateDir()), adapters)).toMatchObject({ ok: false, step: "tag", reason: "conflict" });
    expect(s.calls).not.toContain("createTag");
  });

  test("a recovered merge refuses a different head and never deletes a reused branch", async () => {
    for (const changePr of [false, true]) {
      const dir = stateDir();
      const { s, adapters } = world({ crashAfter: "merge" });
      await runRelease(options(dir), adapters);
      if (changePr) s.pr.head = OTHER;
      else s.branchHead = OTHER;
      expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: false, step: "merge" });
      expect(s.calls).not.toContain("deleteBranch");
      expect(s.calls).not.toContain("createTag");
    }
  });

  test.each(RELEASE_TAG_CHECKS)("a failed tag check (%s) refuses publication completion and Homebrew", async name => {
    const { s, adapters } = world();
    const tag = adapters.github.createTag;
    adapters.github.createTag = async (...args) => {
      await tag(...args);
      s.checks.set(MERGE, [...passing(RELEASE_TAG_CHECKS.filter(one => one !== name)), { name, status: "completed", conclusion: "failure" }]);
    };
    const result = await runRelease(options(stateDir()), adapters);
    expect(result).toMatchObject({ ok: false, step: "publish", reason: "publish-failed" });
    expect(result.journal?.published).toBeNull();
    expect(s.calls).not.toContain("propose");
  });

  test("publication resume refuses a moved tag", async () => {
    const dir = stateDir();
    const { s, adapters } = world();
    adapters.github.release = async () => false;
    expect(await runRelease(options(dir, { limits: { publish: 1 } }), adapters)).toMatchObject({ ok: false, step: "publish", reason: "timeout" });
    s.tags.set("v0.9.52", OTHER);
    expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: false, step: "publish", reason: "conflict" });
    expect(s.calls).not.toContain("propose");
  });

  test("Homebrew waits for checks to register and for every check to pass", async () => {
    const { s, adapters } = world();
    s.checks.set(`brew:${OTHER}`, []);
    let waits = 0;
    s.onSleep.push(state => {
      if (state.brew.kind !== "proposed") return;
      expect(state.calls).not.toContain("brewMerge");
      waits += 1;
      state.checks.set(`brew:${OTHER}`, waits === 1
        ? [...passing(["lint"]), { name: "brew test", status: "in_progress", conclusion: null }]
        : passing(["lint", "brew test"]));
    });
    expect(await runRelease(options(stateDir()), adapters)).toMatchObject({ ok: true });
    expect(waits).toBe(2);
  });

  test("Homebrew with no registered checks times out without merging", async () => {
    const { s, adapters } = world();
    s.checks.set(`brew:${OTHER}`, []);
    expect(await runRelease(options(stateDir(), { limits: { homebrew: 1 } }), adapters)).toMatchObject({ ok: false, step: "homebrew", reason: "timeout" });
    expect(s.calls).not.toContain("brewMerge");
  });

  test.each(["failure", "skipped", "cancelled", "timed_out"])("Homebrew refuses a %s check", async conclusion => {
    const { s, adapters } = world();
    s.checks.set(`brew:${OTHER}`, [...passing(["lint"]), { name: "brew test", status: "completed", conclusion }]);
    expect(await runRelease(options(stateDir()), adapters)).toMatchObject({ ok: false, step: "homebrew", reason: "homebrew-failed" });
    expect(s.calls).not.toContain("brewMerge");
  });

  test("a deployment that doesn't leave the service on the new build stops before relinking or merging", async () => {
    const { s, adapters } = world();
    adapters.toolroll.deploy = async () => ({ ok: true, runtime: NEW });
    expect(await runRelease(options(stateDir(), { limits: { deploy: 1 } }), adapters)).toMatchObject({ ok: false, step: "deploy", reason: "timeout" });
    expect(s.calls).not.toContain("switchLinks");
    expect(s.calls).not.toContain("merge");
    const refused = world();
    refused.adapters.toolroll.deploy = async () => ({ ok: false, message: "Current work must finish first." });
    expect(await runRelease(options(stateDir()), refused.adapters)).toMatchObject({ ok: false, step: "deploy", reason: "deploy", message: expect.stringContaining("Current work must finish first") });
    // The runtime comes from the deployer's JSON and must be a dist folder.
    const odd = world();
    odd.adapters.toolroll.deploy = async () => ({ ok: true, runtime: "/state/staged-upgrades/browser-new/runtime" });
    expect(await runRelease(options(stateDir()), odd.adapters)).toMatchObject({ ok: false, step: "deploy", reason: "deploy", message: expect.stringContaining("not a dist folder") });
  });

  test("relinks both CLI names to the deployer's runtime/bin.js, and a failed relink puts them back and resumes without redeploying", async () => {
    const dir = stateDir();
    const { s, adapters } = world();
    s.linkFails = true;
    const first = await runRelease(options(dir), adapters);
    expect(first).toMatchObject({ ok: false, step: "link", reason: "link", message: expect.stringContaining("point where they did") });
    expect([...s.links.values()]).toEqual([`${OLD}/bin.js`, `${OLD}/bin.js`]);
    // Where they pointed is saved before anything moves, with the runtime the deployer named.
    expect(readJournal(journalFile(dir, "toolroll/simplify-release"))).toMatchObject({
      deploy: { runtime: NEW }, links: [{ name: "toolroll", before: `${OLD}/bin.js` }, { name: "standing-orders", before: `${OLD}/bin.js` }],
    });
    expect(s.calls).not.toContain("merge");
    s.linkFails = false;
    expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: true });
    expect(s.calls.filter(one => one === "deploy")).toHaveLength(1);
    expect(s.calls.filter(one => one === "switchLinks")).toHaveLength(2);
    expect([...s.links.values()]).toEqual([`${NEW}/bin.js`, `${NEW}/bin.js`]);
  });

  test("a relink that leaves one CLI name on another build stops before merging", async () => {
    const { s, adapters } = world();
    adapters.toolroll.switchLinks = async () => { s.installed = { ...s.installed, clis: [{ name: "toolroll", runtime: NEW }, { name: "standing-orders", runtime: OLD }] }; };
    expect(await runRelease(options(stateDir()), adapters)).toMatchObject({ ok: false, step: "link", reason: "mixed-runtime" });
    expect(s.calls).not.toContain("merge");
  });

  test("a deployment that stopped before its swap with new work paused names the guided gate release", async () => {
    const dir = stateDir();
    const { s, adapters } = world();
    const id = "0f1e2d3c-4b5a-4968-8776-655443322110";
    const deploy = adapters.toolroll.deploy;
    adapters.toolroll.deploy = async () => ({ ok: false, message: "killed", gate: { id, phase: "preparing" } });
    const stopped = await runRelease(options(dir), adapters);
    expect(stopped).toMatchObject({ ok: false, step: "deploy", reason: "gate-held", message: expect.stringContaining(`toolroll release --release-gate ${id}`) });
    // Recovery that still finds the pause says the same, and nothing deploys again until it is lifted.
    adapters.toolroll.recoverDeploy = async () => ({ ok: false, message: "exit 1", gate: { id, phase: "preparing" } });
    expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: false, step: "deploy", reason: "gate-held" });
    expect(s.calls).toEqual(["fileGate", "complete"]);
    // Once `toolroll release --release-gate` lifted it, recovery finds nothing held and the release deploys.
    adapters.toolroll.recoverDeploy = async () => ({ ok: true });
    adapters.toolroll.deploy = deploy;
    expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: true });
    expect(s.calls.filter(one => one === "deploy")).toHaveLength(1);
  });

  test("an interrupted deployment recovers its saved stage before retrying, even when the new runtime is linked", async () => {
    const dir = stateDir();
    const { s, adapters } = world();
    const stages: string[] = [], actions: string[] = [];
    const deploy = adapters.toolroll.deploy;
    adapters.toolroll.deploy = async input => {
      expect(readJournal(journalFile(dir, "toolroll/simplify-release"))?.deployAttempt?.stage).toBe(input.stage);
      stages.push(input.stage); actions.push("deploy");
      await deploy(input);
      return stages.length === 1 ? { ok: false, message: "exit 124" } : { ok: true, runtime: NEW };
    };
    adapters.toolroll.recoverDeploy = async input => {
      actions.push("recover");
      expect(input).toMatchObject({ stage: stages[0], run: 2757, worktree: "/worktrees/release" });
      s.installed = { services: [OLD], clis: [{ name: "toolroll", runtime: OLD }, { name: "standing-orders", runtime: OLD }] };
      return { ok: true };
    };
    expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: false, step: "deploy", reason: "deploy" });
    expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: true });
    expect(actions).toEqual(["deploy", "recover", "deploy"]);
    expect(stages[1]).not.toBe(stages[0]);
  });

  test.each([false, true])("failed deployment recovery blocks another attempt, including --new=%s", async fresh => {
    const dir = stateDir();
    const { s, adapters } = world({ crashAfter: "deploy" });
    await runRelease(options(dir), adapters);
    adapters.toolroll.recoverDeploy = async () => ({ ok: false, message: "previous service is not confirmed running" });
    expect(await runRelease(options(dir, { fresh }), adapters)).toMatchObject({ ok: false, reason: "deploy-recovery" });
    expect(s.calls.filter(one => one === "deploy")).toHaveLength(1);
    expect(s.calls).not.toContain("merge");
  });

  test("waits until nothing builds before deploying", async () => {
    const { s, adapters } = world();
    s.running = 2;
    s.onSleep.push(state => { if (state.gate.completion !== null) state.running = 0; });
    expect(await runRelease(options(stateDir()), adapters)).toMatchObject({ ok: true });
    expect(s.said).toContain("  waiting for running work to finish (up to 60 min)");
  });

  describe("before anything changes", () => {
    const refusedWith = async (change: (s: ReturnType<typeof world>["s"]) => void, reason: string) => {
      const dir = stateDir();
      const { s, adapters } = world();
      change(s);
      expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: false, step: "preflight", reason, journal: null });
      expect(s.calls).toEqual([]);
      expect(readJournal(journalFile(dir, "toolroll/simplify-release"))).toBeNull();
    };
    test("the console, worker and both CLI names run one build", () => refusedWith(s => { s.installed.clis[1]!.runtime = NEW; }, "mixed-runtime"));
    test("the lead wrote the version's CHANGELOG entry", () => refusedWith(s => { s.files.set("CHANGELOG.md", "## 0.9.51\n"); }, "changelog"));
    test("the version is new", () => refusedWith(s => { s.tags.set("v0.9.52", OTHER); }, "version"));
    test("the branch has an open pull request at its head", () => refusedWith(s => { s.pr.head = OTHER; }, "drift"));
  });
});
