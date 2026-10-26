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
    /** Whether the gate's look (before anything is filed) sees `checks` as set. Off: it sees them all passing, so a test
     * about a later step can start with failing or pending checks. */
    gateSeesChecks: false,
    checks: new Map<string, CheckRun[]>([[SHA, passing(REQUIRED_PR_CHECKS)], [`brew:${OTHER}`, passing(["brew test"]).map(run => ({ ...run, app: "github-actions" }))]]),
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
    brewChecked: true,
    brewStatuses: [] as CheckRun[],
    calls: [] as string[],
    said: [] as string[],
  };
  /** A change lands, and then (once, when asked) the process dies before hearing back. */
  const landed = (name: Mutation) => {
    s.calls.push(name);
    if (crash === name) { crash = undefined; throw new Error(`lost the answer to ${name}`); }
  };
  const person = (state: typeof s) => {
    if (state.gate.exists && state.gate.approval === null) state.gate.approval = { by: "alex", at: new Date(state.now).toISOString(), digest: DIGEST, basis: "password", role: "approver", active: true, person: { ok: true, method: "password-now" } };
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
      deploymentIdle: async () => true,
      deploy: async () => {
        // The deployer stamps the runtime with the commit the passing build recorded (deploy-browser.mjs).
        s.commits.set(NEW, s.gate.result?.head ?? s.gate.candidate!);
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
      checks: async (repo, sha) => !s.gateSeesChecks && repo !== "ap9000/homebrew-toolroll" && !(s.gate.exists && s.gate.candidate === sha) && sha !== MERGE ? passing(REQUIRED_PR_CHECKS)
        : structuredClone(s.checks.get(`${repo === "ap9000/homebrew-toolroll" ? "brew:" : ""}${sha}`) ?? []),
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
      checked: async () => s.brewChecked,
      statuses: async () => structuredClone(s.brewStatuses),
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
      const person = { ok: true as const, method: "password-now" };
      expect(ownerApproval(gate({ by: "alex", at, digest: DIGEST, basis: "password", role: "approver", active: true, person }), DIGEST)).toEqual({ ok: true, by: "alex", at });
      expect(ownerApproval(gate({ by: "alex", at, digest: DIGEST, basis: "chat", role: "approver", active: true, person: { ok: true, method: "chat" } }), DIGEST)).toMatchObject({ ok: true });
      expect(ownerApproval(gate(null), DIGEST)).toMatchObject({ ok: false, why: "not approved yet" });
      expect(ownerApproval(gate({ by: "alex", at, digest: "older", basis: "password", role: "approver", active: true, person }), DIGEST)).toMatchObject({ ok: false });
      expect(ownerApproval(gate({ by: "alex", at, digest: DIGEST, basis: "mode", role: "approver", active: true, person }), DIGEST)).toMatchObject({ ok: false, why: "approved by mode, not by a person" });
      expect(ownerApproval(gate({ by: "alex", at, digest: DIGEST, basis: "lead", role: "approver", active: true, person }), DIGEST)).toMatchObject({ ok: false, why: "approved by the lead, not by a person" });
      for (const by of ["Maya (AI)", "mode overnight", "lead:alex", "routine"]) expect(ownerApproval(gate({ by, at, digest: DIGEST, basis: "password", role: "approver", active: true, person }), DIGEST), by).toMatchObject({ ok: false });
      // Approval policy: the owner's own name on a `password` seal is not enough — the plane's proof decides.
      expect(ownerApproval(gate({ by: "alex", at, digest: DIGEST, basis: "password", role: "approver", active: true }), DIGEST)).toMatchObject({ ok: false, why: expect.stringContaining("update it first") });
      expect(ownerApproval(gate({ by: "alex", at, digest: DIGEST, basis: "password", role: "approver", active: true, person: { ok: false, why: "approved by the lead, not by a person" } }), DIGEST)).toMatchObject({ ok: false, why: "approved by the lead, not by a person" });
      for (const method of ["lead-token", "remote-token", "bogus"]) expect(ownerApproval(gate({ by: "alex", at, digest: DIGEST, basis: "password", role: "approver", active: true, person: { ok: true, method } }), DIGEST), method).toMatchObject({ ok: false });
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
      if (state.gate.approval === null) state.gate.approval = { by: "alex", at: "2026-10-08T09:00:00.000Z", digest: DIGEST, basis: "password", role: "approver", active: true, person: { ok: true, method: "password-now" } };
      else state.gate.result = { run: 2757, head: SHA, check: "failed", level: "full", receipt: RECEIPT, worktree: "/w" };
    }];
    for (let i = 0; i < 2; i += 1) expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: false, step: "check", reason: "check-failed" });
    expect(s.calls).toEqual(["fileGate"]);
  });

  test("a prepared candidate built as a commit of its own with exactly the candidate's files releases, and deploys to that commit", async () => {
    const dir = stateDir();
    const { s, adapters } = world();
    const BUILT = "e".repeat(40);
    s.trees.set(BUILT, TREE);
    s.onSleep.push(state => { if (state.gate.result) state.gate.result.head = BUILT; });
    expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: true });
    expect(s.commits.get(NEW)).toBe(BUILT);
    expect(readJournal(journalFile(dir, "toolroll/simplify-release"))).toMatchObject({ step: "done", check: { head: BUILT }, merge: { tree: TREE } });
  });

  test("a build whose commit holds other files than the candidate's never deploys", async () => {
    const { s, adapters } = world();
    const BUILT = "e".repeat(40);
    s.trees.set(BUILT, OTHER);
    s.onSleep.push(state => { if (state.gate.result) state.gate.result.head = BUILT; });
    expect(await runRelease(options(stateDir()), adapters)).toMatchObject({ ok: false, step: "check", reason: "drift", message: expect.stringContaining("doesn't hold exactly") });
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
      // Failing only after the gate's early look, so it's the ci step that stops.
      failed.s.onSleep.push(state => { if (state.gate.result !== null) state.checks.set(SHA, [...passing(REQUIRED_PR_CHECKS.slice(1)), { name: REQUIRED_PR_CHECKS[0], status: "completed", conclusion: "failure" }]); });
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
      // A failure after the deploy needs a person's fresh approval (Alex, 2026-10-25): green checks alone don't resume.
      if (reason === "ci-failed") {
        expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: false, reason: "ci-failed", message: expect.stringContaining("needs a person's approval again") });
        expect(s.calls).not.toContain("merge");
        return;
      }
      expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: true });
      for (const mutation of MUTATIONS) expect(s.calls.filter(one => one === mutation), mutation).toHaveLength(1);
    });

    // The gate's early look, before anyone is asked to approve: only an already failed required check stops there.
    const NOT_FINISHED = "not finished yet", UNREADABLE = "Couldn't read the pull request checks";
    const failing = (conclusion: string) => [...passing(REQUIRED_PR_CHECKS.slice(1)), { name: REQUIRED_PR_CHECKS[0], status: "completed" as const, conclusion }];
    const early: [string, (w: ReturnType<typeof world>) => void, { stop: string | null; line: string | null }][] = [
      ["a failed required check stops before filing or approval", w => { w.s.checks.set(SHA, failing("failure")); }, { stop: "ci-failed", line: null }],
      ["a cancelled required check stops before filing or approval", w => { w.s.checks.set(SHA, failing("cancelled")); }, { stop: "ci-failed", line: null }],
      ["checks not started are named, waited for, and go on once they pass", w => {
        w.s.checks.set(SHA, passing(REQUIRED_PR_CHECKS.slice(0, 2)));
        w.s.onSleep.push(state => { if (state.checks.get(SHA)!.length < REQUIRED_PR_CHECKS.length) state.checks.set(SHA, passing(REQUIRED_PR_CHECKS)); });
      }, { stop: null, line: `${REQUIRED_PR_CHECKS[2]} (not started)` }],
      ["a check that fails while the gate waits stops it", w => {
        w.s.checks.set(SHA, [...passing(REQUIRED_PR_CHECKS.slice(1)), { name: REQUIRED_PR_CHECKS[0], status: "in_progress", conclusion: null }]);
        w.s.onSleep.push(state => { if (state.gate.result === null && state.calls.length === 0) state.checks.set(SHA, failing("failure")); });
      }, { stop: "ci-failed", line: `${REQUIRED_PR_CHECKS[0]} (in_progress)` }],
      ["checks that never start stop at the gate's limit, named", w => { w.s.checks.set(SHA, passing(REQUIRED_PR_CHECKS.slice(1))); }, { stop: "ci-missing", line: `${REQUIRED_PR_CHECKS[0]} (not started)` }],
      ["unreadable checks are waited out, never taken for a pass", w => {
        const checks = w.adapters.github.checks;
        let first = true;
        w.adapters.github.checks = async (repo, sha) => { if (first) { first = false; throw new Error("HTTP 502"); } return checks(repo, sha); };
      }, { stop: null, line: UNREADABLE }],
      ["passed checks continue", () => {}, { stop: null, line: null }],
    ];
    test.each(early)("at the gate, %s", async (_what, setup, { stop, line }) => {
      const dir = stateDir();
      const w = world();
      w.s.gateSeesChecks = true;
      setup(w);
      const outcome = await runRelease(options(dir, { limits: { gate: 1 } }), w.adapters);
      const said = w.s.said.join("\n");
      if (line !== null) expect(said).toContain(line);
      if (stop !== null) {
        // A red or unfinished pull request never reaches the approval step: nothing filed, nobody asked.
        expect(outcome).toMatchObject({ ok: false, step: "gate", reason: stop, message: expect.stringContaining(REQUIRED_PR_CHECKS[0]) });
        expect(w.s.calls).toEqual([]);
        expect(said).not.toContain("needs your approval");
        // Once the job passes on a rerun, the same command goes on from the gate.
        w.s.checks.set(SHA, passing(REQUIRED_PR_CHECKS));
        expect(await runRelease(options(dir), w.adapters)).toMatchObject({ ok: true });
        expect(w.s.calls.filter(one => one === "fileGate")).toHaveLength(1);
        return;
      }
      expect(outcome).toMatchObject({ ok: true });
      if (line === null) for (const one of [NOT_FINISHED, UNREADABLE]) expect(said).not.toContain(one);
    });

    test("a gate whose filed task lost its answer resumes with that task even after a check failed", async () => {
      const dir = stateDir();
      const { s, adapters } = world({ crashAfter: "fileGate" });
      expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: false, step: "gate" });
      s.checks.set(SHA, [...passing(REQUIRED_PR_CHECKS.slice(1)), { name: REQUIRED_PR_CHECKS[0], status: "completed", conclusion: "failure" }]);
      const outcome = await runRelease(options(dir), adapters);
      expect(outcome).toMatchObject({ ok: false, step: "ci", reason: "ci-failed" });
      expect(outcome.ok === false && outcome.message).not.toContain("Nothing was filed");
      expect(s.calls.filter(one => one === "fileGate")).toHaveLength(1);
    });

    test("a release resumed past the gate doesn't look again before ci", async () => {
      const dir = stateDir();
      const { s, adapters } = world();
      const person = s.onSleep[0]!;
      s.onSleep = [];
      expect(await runRelease(options(dir, { limits: { approval: 1 } }), adapters)).toMatchObject({ ok: false, step: "approval" });
      // Failed now: only the ci step may see it.
      s.checks.set(SHA, [...passing(REQUIRED_PR_CHECKS.slice(1)), { name: REQUIRED_PR_CHECKS[0], status: "completed", conclusion: "failure" }]);
      s.onSleep = [person];
      expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: false, step: "ci", reason: "ci-failed" });
      expect(s.calls).toEqual(["fileGate", "complete", "deploy", "switchLinks"]);
    });

    // Which statuses block is the table above; here one waiting and one failed status prove the re-read before merge.
    test.each([blocked[0]!, blocked[2]!])("re-fetches all checks before merge and blocks an extra check now at $status/$conclusion", async ({ status, conclusion }) => {
      const { s, adapters } = world();
      const checks = adapters.github.checks;
      let reads = 0;
      adapters.github.checks = async (repo, sha) => {
        if (sha !== SHA) return checks(repo, sha);
        reads += 1;
        return [...passing(REQUIRED_PR_CHECKS), ...(reads <= 2 ? passing([repeat]) : [{ name: repeat, status, conclusion }])];
      };
      expect(await runRelease(options(stateDir()), adapters)).toMatchObject({ ok: false, step: "merge", reason: "ci-failed" });
      // The gate's early look, the ci step, and the re-read at merge.
      expect(reads).toBe(3);
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
        ? [...passing(["lint"]), { name: "brew test", status: "in_progress", conclusion: null, app: "github-actions" }]
        : passing(["lint", "brew test"]).map(run => ({ ...run, app: "github-actions" })));
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

  test("a tap that runs no checks is merged without waiting for any", async () => {
    const { s, adapters } = world();
    s.brewChecked = false;
    s.checks.set(`brew:${OTHER}`, []);
    expect(await runRelease(options(stateDir(), { limits: { homebrew: 1 } }), adapters)).toMatchObject({ ok: true });
    expect(s.calls).toContain("brewMerge");
  });

  test("a tap that runs no checks still stops on a failed commit status", async () => {
    const { s, adapters } = world();
    s.brewChecked = false;
    s.checks.set(`brew:${OTHER}`, []);
    s.brewStatuses = [{ name: "status: external", status: "completed", conclusion: "failure" }];
    expect(await runRelease(options(stateDir()), adapters)).toMatchObject({ ok: false, step: "homebrew", reason: "homebrew-failed" });
    expect(s.calls).not.toContain("brewMerge");
  });

  test("a green status doesn't stand in for the checks a tap's workflow owes", async () => {
    const { s, adapters } = world();
    s.checks.set(`brew:${OTHER}`, []);
    s.brewStatuses = [{ name: "status: lint", status: "completed", conclusion: "success" }];
    expect(await runRelease(options(stateDir(), { limits: { homebrew: 1 } }), adapters)).toMatchObject({ ok: false, step: "homebrew", reason: "timeout" });
    expect(s.calls).not.toContain("brewMerge");
  });

  test("another app's green check doesn't stand in for the tap's own workflow", async () => {
    const { s, adapters } = world();
    s.checks.set(`brew:${OTHER}`, [{ name: "Vercel", status: "completed", conclusion: "success", app: "vercel" }]);
    expect(await runRelease(options(stateDir(), { limits: { homebrew: 1 } }), adapters)).toMatchObject({ ok: false, step: "homebrew", reason: "timeout" });
    expect(s.calls).not.toContain("brewMerge");
  });

  test("another app's green check never hides the workflow's failed one of the same name", async () => {
    const { s, adapters } = world();
    s.checks.set(`brew:${OTHER}`, [
      { name: "brew test", status: "completed", conclusion: "failure", app: "github-actions" },
      { name: "brew test", status: "completed", conclusion: "success", app: "vercel" },
    ]);
    expect(await runRelease(options(stateDir()), adapters)).toMatchObject({ ok: false, step: "homebrew", reason: "homebrew-failed" });
    expect(s.calls).not.toContain("brewMerge");
  });

  test("a green status never hides a failed check that shares its name", async () => {
    const { s, adapters } = world();
    s.checks.set(`brew:${OTHER}`, [{ name: "status: external", status: "completed", conclusion: "failure" }]);
    s.brewStatuses = [{ name: "status: external", status: "completed", conclusion: "success" }];
    expect(await runRelease(options(stateDir()), adapters)).toMatchObject({ ok: false, step: "homebrew", reason: "homebrew-failed" });
    expect(s.calls).not.toContain("brewMerge");
  });

  test("a pending status holds the merge even when the checks passed", async () => {
    const { s, adapters } = world();
    s.brewStatuses = [{ name: "status: external", status: "in_progress", conclusion: null }];
    expect(await runRelease(options(stateDir(), { limits: { homebrew: 1 } }), adapters)).toMatchObject({ ok: false, step: "homebrew", reason: "timeout" });
    expect(s.calls).not.toContain("brewMerge");
  });

  test("a tap that runs no checks still stops on a check some app did register and fail", async () => {
    const { s, adapters } = world();
    s.brewChecked = false;
    s.checks.set(`brew:${OTHER}`, [{ name: "external CI", status: "completed", conclusion: "failure" }]);
    expect(await runRelease(options(stateDir()), adapters)).toMatchObject({ ok: false, step: "homebrew", reason: "homebrew-failed" });
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

// ------------------------------------------------------------------ one approval per release (release-once.md)

const NEXT = "f".repeat(40), TREE2 = "9".repeat(40), DIGEST2 = "scope-digest-2";

/** The world with a release authority: a person's yes to the gate opens it, a carry moves its tip to a new task whose
 * scope is sealed `carried`, and the store's deploy and merge reservations, lease and operations are scripted. */
function releaseWorld(options: { carryRefused?: string } = {}) {
  const w = world();
  const { s, adapters } = w;
  const rel = {
    id: 1, generation: 1, state: "open", tipSha: SHA, tipTask: "", tasks: new Set<string>(), landed: [] as { sha: string; files: { path: string; added: number; deleted: number }[] }[],
    epoch: 0, owner: null as string | null, owners: [] as string[], approvalsNeeded: [] as string[],
    ops: new Map<string, { id: string; kind: "deploy" | "merge"; state: "reserved" | "running" | "succeeded" | "failed" | "unknown"; candidate: string; externalRef: string | null; reservedAt: string;
      direct?: boolean; issuerGone?: boolean; stage?: string | null }>(),
    /** What deploymentIdle answers for a direct deploy's recovery. */
    deploymentIdle: true,
    /** Override what the live predicate says. */
    live: null as null | ((taskId: string, action: string) => { applies: boolean; ok: boolean; why: string | null }),
    /** Override what authority() answers. */
    view: null as null | ((taskId: string) => unknown),
    carries: [] as string[], merges: [] as (string | undefined)[], finished: [] as string[],
  };
  const approvedTask = () => s.gate.approval !== null && s.gate.approval.basis === "password";
  adapters.github.merge = async (_repo, _pr, head, message) => {
    if (head !== s.pr.head) throw new Error("Head branch was modified");
    s.pr = { ...s.pr, state: "merged", mergeCommit: MERGE };
    s.trees.set(MERGE, s.trees.get(head)!);
    s.calls.push("merge");
    rel.merges.push(message);
    return MERGE;
  };
  adapters.release = {
    async authority(taskId) {
      if (rel.view !== null) return rel.view(taskId) as never;
      if (!rel.tasks.has(taskId) && !(taskId === s.gateId && approvedTask())) return null;
      if (rel.tipTask === "") { rel.tipTask = taskId; rel.tasks.add(taskId); }
      return { id: rel.id, generation: rel.generation, state: rel.state, tipSha: rel.tipSha, tipTask: rel.tipTask, version: "0.9.52", pr: 170, landed: [...rel.landed] };
    },
    async live(taskId, action) {
      if (rel.live !== null) return rel.live(taskId, action);
      if (!rel.tasks.has(taskId)) return { applies: false, ok: false, why: null };
      const states: Record<string, string[]> = { dispatch: ["open"], complete: ["open"], deploy: ["open", "deploying"], merge: ["deploying", "merge-reserved"] };
      if (rel.state === "revoked") return { applies: true, ok: false, why: "alex stopped carrying commits for this release" };
      if (rel.tipTask !== taskId) return { applies: true, ok: false, why: "this is not the release's current commit" };
      if (!states[action]!.includes(rel.state)) return { applies: true, ok: false, why: `the release is ${rel.state}` };
      return { applies: true, ok: true, why: null };
    },
    async lease(_id, owner) { rel.owners.push(owner); if (rel.owner !== owner) { rel.epoch += 1; rel.owner = owner; } return { ok: true, epoch: rel.epoch }; },
    async renew(_id, owner, epoch) { return rel.owner === owner && rel.epoch === epoch; },
    async carry(_id, to) {
      rel.carries.push(to);
      if (options.carryRefused !== undefined) return { ok: false, message: options.carryRefused };
      const task = gateTaskId("0.9.52", to);
      rel.tasks.add(task); rel.tipTask = task; rel.tipSha = to;
      rel.landed.push({ sha: to, files: [{ path: "src/a.test.ts", added: 3, deleted: 1 }] });
      s.gateId = task;
      s.gate = { exists: true, candidate: to, scopeDigest: DIGEST2, approval: { by: "alex", at: new Date(s.now).toISOString(), digest: DIGEST2, basis: "carried", role: "approver", active: true }, result: null, failed: null, completion: null };
      return { ok: true, taskId: task };
    },
    async reserve(input) {
      if (input.epoch !== rel.epoch) return { ok: false, why: "This coordinator no longer holds the release's lease." };
      if (input.taskId !== rel.tipTask) return { ok: false, why: "not the release's current commit" };
      const next = input.kind === "deploy" ? (rel.state === "open" || rel.state === "deploying" ? "deploying" : null) : (rel.state === "deploying" ? "merge-reserved" : null);
      if (next === null) return { ok: false, why: `The release is ${rel.state}, so it can't ${input.kind}.` };
      rel.state = next;
      const id = `${input.kind}-${rel.ops.size + 1}`;
      rel.ops.set(id, { id, kind: input.kind, state: "reserved", candidate: input.candidate, externalRef: null, reservedAt: new Date(s.now).toISOString() });
      return { ok: true, operation: id };
    },
    async start(id, epoch) { const op = rel.ops.get(id)!; if (op.state !== "reserved" || epoch !== rel.epoch) return false; op.state = "running"; return true; },
    async needsApproval(_id, reason, epoch) { if (epoch !== rel.epoch || rel.state === "merge-reserved") return false; rel.approvalsNeeded.push(reason); rel.state = "revoked"; return true; },
    async finish(id, outcome, facts, epoch) {
      if (epoch !== rel.epoch) return false;
      const op = rel.ops.get(id)!; op.state = outcome; op.externalRef = facts.externalRef ?? op.externalRef; rel.finished.push(`${id}:${outcome}`);
      if (op.kind === "merge" && outcome === "succeeded") rel.state = "merged";
      if (op.kind === "merge" && outcome === "failed") rel.state = "deploying";
      return true;
    },
    async operations() { return [...rel.ops.values()].map(op => ({ direct: false, issuerGone: true, stage: null, ...op })); },
  };
  return { ...w, rel };
}

/** Move the branch and its pull request to `head` (a test-only commit with its own tree and passing checks). */
const moveTo = (s: ReturnType<typeof world>["s"], head: string) => {
  s.branchHead = head;
  s.pr = { ...s.pr, head };
  s.trees.set(head, TREE2);
  s.checks.set(head, passing(REQUIRED_PR_CHECKS));
};

describe("toolroll release: one approval per release", () => {
  test.each(["approval", "check", "complete", "quiet"] as const)("a head move during the %s wait restarts from check for the new tip; nothing from the old step runs afterwards", async during => {
    const dir = stateDir();
    const { s, adapters, rel } = releaseWorld();
    let moved = false;
    const move = () => { if (!moved) { moved = true; moveTo(s, NEXT); } };
    if (during === "approval") {
      // Approved first, then moved before the coordinator saw the yes: the restart files nothing new for a person.
      s.onSleep.unshift(state => { if (state.gate.approval !== null && !moved) move(); });
    } else if (during === "check") s.onSleep.unshift(state => { if (state.gate.approval !== null && state.gate.result === null && rel.tasks.size > 0) move(); });
    else if (during === "complete") {
      const complete = adapters.toolroll.complete;
      adapters.toolroll.complete = async (task, receipt) => { if (!moved) { move(); throw new Error("interrupted before completing"); } return complete(task, receipt); };
    } else {
      s.running = 1;
      s.onSleep.unshift(state => { if (state.gate.completion !== null && !moved) { move(); state.running = 0; } });
    }
    let outcome = await runRelease(options(dir), adapters);
    if (!outcome.ok && outcome.reason === "error") outcome = await runRelease(options(dir), adapters);
    expect(outcome, JSON.stringify(outcome.ok ? null : outcome.message)).toMatchObject({ ok: true });
    const journal = readJournal(journalFile(dir, "toolroll/simplify-release"))!;
    expect(journal.candidate).toEqual({ sha: NEXT, tree: TREE2 });
    expect(journal.merge?.sha).toBe(MERGE);
    expect(s.pr.head).toBe(NEXT);
    // The old candidate never deployed or merged: one deploy, of the new tip.
    expect(s.calls.filter(one => one === "deploy")).toHaveLength(1);
    expect([...rel.ops.values()].map(op => `${op.kind}:${op.candidate.slice(0, 1)}:${op.state}`)).toEqual(["deploy:f:succeeded", "merge:f:succeeded"]);
    // The summary and the merge message list the commit that landed after the approval.
    expect(journal.landed).toEqual([{ sha: NEXT, files: [{ path: "src/a.test.ts", added: 3, deleted: 1 }] }]);
    expect(rel.merges.at(-1)).toContain(`${NEXT.slice(0, 7)}: src/a.test.ts (+3 −1)`);
    expect(s.said.join("\n")).toContain("Landed after the approval (1 commit)");
  });

  test("an old candidate's failed check, with the head already moved: the release restarts for the new tip instead of stopping", async () => {
    const dir = stateDir();
    const { s, adapters } = releaseWorld();
    let failed = false;
    s.onSleep.unshift(state => {
      if (!failed && state.gate.approval?.basis === "password" && state.gate.result === null) {
        failed = true;
        state.gate.result = { run: 2756, head: SHA, check: "failed", level: "full", receipt: "r-old", worktree: "/w" };
        moveTo(state, NEXT);
      }
    });
    expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: true });
    expect(readJournal(journalFile(dir, "toolroll/simplify-release"))?.candidate.sha).toBe(NEXT);
  });

  test("a refused carry files the new head's gate the ordinary way and stops at approval", async () => {
    const dir = stateDir();
    const { s, adapters, rel } = releaseWorld({ carryRefused: "src/serve.ts isn't a test, a doc or the changelog" });
    let moved = false, approvals = 0;
    s.onSleep = [state => {
      if (state.gate.approval === null && state.gate.exists && approvals++ === 0) state.gate.approval = { by: "alex", at: new Date(state.now).toISOString(), digest: DIGEST, basis: "password", role: "approver", active: true, person: { ok: true, method: "password-now" } };
      else if (!moved && rel.tasks.size > 0) { moved = true; moveTo(state, NEXT); }
    }];
    const outcome = await runRelease(options(dir, { limits: { approval: 30 } }), adapters);
    expect(outcome).toMatchObject({ ok: false, step: "approval", reason: "timeout" });
    expect(rel.carries).toEqual([NEXT]);
    expect(readJournal(journalFile(dir, "toolroll/simplify-release"))).toMatchObject({ candidate: { sha: NEXT }, task: { id: gateTaskId("0.9.52", NEXT) }, authority: null });
    expect(s.calls.filter(one => one === "fileGate")).toHaveLength(2);
  });

  test.each(["deploy", "ci"] as const)("a head move during %s (after the deploy reservation) stops the release; the new commit needs a person and A is never merged", async during => {
    const dir = stateDir();
    const { s, adapters, rel } = releaseWorld();
    if (during === "deploy") {
      const deploy = adapters.toolroll.deploy;
      adapters.toolroll.deploy = async input => { const result = await deploy(input); moveTo(s, NEXT); return result; };
    } else s.checks.set(SHA, []);
    if (during === "ci") s.onSleep.push(state => { if (rel.state === "deploying" && state.branchHead === SHA) moveTo(state, NEXT); });
    const outcome = await runRelease(options(dir), adapters);
    expect(outcome).toMatchObject({ ok: false, reason: "drift" });
    expect(s.calls).not.toContain("merge");
    expect(rel.carries).toEqual([]);
  });

  test("a revoke during the CI wait: the merge reservation refuses and nothing merges", async () => {
    const dir = stateDir();
    const { s, adapters, rel } = releaseWorld();
    s.checks.set(SHA, []);
    s.onSleep.push(state => { if (rel.state === "deploying") { rel.state = "revoked"; state.checks.set(SHA, passing(REQUIRED_PR_CHECKS)); } });
    expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: false, step: "merge", reason: "release" });
    expect(s.calls).not.toContain("merge");
  });

  test.each([
    ["retargeted to another base", (s: ReturnType<typeof world>["s"]) => { s.pr = { ...s.pr, base: "release-branch" }; }],
    ["closed and reopened as a new pull request", (s: ReturnType<typeof world>["s"]) => { s.pr = { ...s.pr, number: 171 }; }],
    ["the head branch renamed", (s: ReturnType<typeof world>["s"]) => { s.branchHead = null; s.pr = { ...s.pr, state: "closed" }; }],
  ])("attack 14, PR identity: %s stops the release at the next identity check", async (_name, change) => {
    const dir = stateDir();
    const { s, adapters, rel } = releaseWorld();
    s.onSleep.unshift(state => { if (rel.tasks.size > 0 && state.gate.result === null) change(state); });
    const outcome = await runRelease(options(dir), adapters);
    expect(outcome).toMatchObject({ ok: false, reason: "drift" });
    expect(s.calls).not.toContain("deploy");
  });

  describe("security review: a carried gate stands only on a live release predicate that applies and accepts it", () => {
    test.each([
      ["the authority row is missing", (rel: ReturnType<typeof releaseWorld>["rel"]) => { rel.live = () => ({ applies: false, ok: false, why: null }); }],
      ["it belongs to a different task", (rel: ReturnType<typeof releaseWorld>["rel"]) => { rel.tipTask = "release-0.9.52-0000000"; }],
      ["the generation was revoked", (rel: ReturnType<typeof releaseWorld>["rel"]) => { rel.state = "revoked"; }],
      ["the generation expired", (rel: ReturnType<typeof releaseWorld>["rel"]) => { rel.live = (_task, _action) => ({ applies: true, ok: false, why: "the release approval expired" }); }],
      ["the tip moved", (rel: ReturnType<typeof releaseWorld>["rel"]) => { rel.tipSha = "1".repeat(40); rel.tipTask = gateTaskId("0.9.52", "1".repeat(40)); }],
    ])("%s: the release stops before anything deploys", async (_name, spoil) => {
      const dir = stateDir();
      const { s, adapters, rel } = releaseWorld();
      // Carried to NEXT during the check wait, then the authority is spoiled before the carried result is acted on.
      let moved = false;
      s.onSleep.unshift(state => {
        if (!moved && state.gate.approval !== null && state.gate.result === null && rel.tasks.size > 0) { moved = true; moveTo(state, NEXT); }
        else if (moved && state.gate.approval?.basis === "carried" && state.gate.result === null) spoil(rel);
      });
      const outcome = await runRelease(options(dir), adapters);
      expect(outcome.ok).toBe(false);
      expect(s.calls).not.toContain("deploy");
      expect(s.calls).not.toContain("complete");
    });
  });

  describe("attack 11: every outcome of a deploy or merge is recovered", () => {
    /** A release stopped at `step` with one operation in `state`; resuming reconciles it before anything new. */
    const resumed = async (kind: "deploy" | "merge", state: "reserved" | "running" | "unknown", world: (w: ReturnType<typeof releaseWorld>) => void) => {
      const dir = stateDir();
      const w = releaseWorld();
      // Run to CI, then stop: the authority is held, the deploy done.
      w.s.checks.set(SHA, []);
      const first = await runRelease(options(dir, { limits: { ci: 1 } }), w.adapters);
      expect(first).toMatchObject({ ok: false, step: "ci" });
      w.s.checks.set(SHA, passing(REQUIRED_PR_CHECKS));
      const op = { id: `${kind}-x`, kind, state, candidate: SHA, externalRef: null, reservedAt: new Date(w.s.now - 60 * 60_000).toISOString() };
      w.rel.ops.set(op.id, op);
      if (kind === "merge") w.rel.state = "merge-reserved";
      world(w);
      const second = await runRelease(options(dir), w.adapters);
      return { w, second, op: w.rel.ops.get(op.id)! };
    };
    test("deploy, reserved and never started: failed", async () => {
      const { op } = await resumed("deploy", "reserved", () => {});
      expect(op.state).toBe("failed");
    });
    test("deploy, outcome unknown with the services on the candidate (the answer lost): succeeded", async () => {
      const { op } = await resumed("deploy", "unknown", () => {});
      expect(op.state).toBe("succeeded");
    });
    test("deploy, outcome unknown with the services elsewhere: recovered, failed", async () => {
      const { op } = await resumed("deploy", "running", w => { w.s.installed = { ...w.s.installed, services: [OLD] }; });
      expect(op.state).toBe("failed");
    });
    test("merge, reserved and the PR still open at the same head: failed, back to deploying, then merged once", async () => {
      const { op, second, w } = await resumed("merge", "reserved", () => {});
      expect(op.state).toBe("failed");
      expect(second).toMatchObject({ ok: true });
      expect(w.s.calls.filter(one => one === "merge")).toHaveLength(1);
    });
    test("merge, outcome unknown and the PR merged from the gated head (the answer lost): succeeded, never merged twice", async () => {
      const { op, w } = await resumed("merge", "unknown", w => { w.s.pr = { ...w.s.pr, state: "merged", mergeCommit: MERGE }; w.s.trees.set(MERGE, TREE); });
      expect(op).toMatchObject({ state: "succeeded", externalRef: MERGE });
      expect(w.s.calls).not.toContain("merge");
    });
    test("merge, outcome unknown and the PR closed some other way: the release stops for a person", async () => {
      const { op, second } = await resumed("merge", "unknown", w => { w.s.pr = { ...w.s.pr, state: "closed" }; });
      expect(op.state).toBe("unknown");
      expect(second).toMatchObject({ ok: false, reason: "merge-unknown" });
    });
  });
});

describe("toolroll release: Codex review round 1", () => {
  test("finding 3: two runs of the same journal hold the release under different owners", async () => {
    const dir = stateDir();
    const { s, adapters, rel } = releaseWorld();
    s.checks.set(SHA, []);
    expect(await runRelease(options(dir, { limits: { ci: 1 } }), adapters)).toMatchObject({ ok: false, step: "ci" });
    expect(await runRelease(options(dir, { limits: { ci: 1 } }), adapters)).toMatchObject({ ok: false, step: "ci" });
    expect(new Set(rel.owners).size).toBe(2);
  });

  test("finding 3 (round 2 probe): a merge started 11 minutes ago by a process still alive is never declared failed", async () => {
    const dir = stateDir();
    const w = releaseWorld();
    w.s.checks.set(SHA, []);
    expect(await runRelease(options(dir, { limits: { ci: 1 } }), w.adapters)).toMatchObject({ ok: false, step: "ci" });
    // Invocation A started the merge and paused; B takes over eleven minutes later, with CI now failing.
    w.s.checks.set(SHA, passing(REQUIRED_PR_CHECKS).map((run, i) => i === 0 ? { ...run, conclusion: "failure" } : run));
    w.rel.state = "merge-reserved";
    w.rel.ops.set("merge-y", { id: "merge-y", kind: "merge", state: "running", candidate: SHA, externalRef: null, reservedAt: new Date(w.s.now - 11 * 60_000).toISOString(), issuerGone: false });
    expect(await runRelease(options(dir), w.adapters)).toMatchObject({ ok: false, reason: "operation-in-flight" });
    expect(w.rel.ops.get("merge-y")?.state).toBe("running");
    // Nothing was revoked or reopened under it, and nothing merged.
    expect(w.rel.state).toBe("merge-reserved");
    expect(w.rel.approvalsNeeded).toEqual([]);
    expect(w.s.calls).not.toContain("merge");
  });

  test("finding 3 (round 2): once the merge's process is proven gone and the PR is still open, it is failed and merged once", async () => {
    const dir = stateDir();
    const w = releaseWorld();
    w.s.checks.set(SHA, []);
    expect(await runRelease(options(dir, { limits: { ci: 1 } }), w.adapters)).toMatchObject({ ok: false, step: "ci" });
    w.s.checks.set(SHA, passing(REQUIRED_PR_CHECKS));
    w.rel.state = "merge-reserved";
    w.rel.ops.set("merge-y", { id: "merge-y", kind: "merge", state: "running", candidate: SHA, externalRef: null, reservedAt: new Date(w.s.now).toISOString(), issuerGone: true });
    expect(await runRelease(options(dir), w.adapters)).toMatchObject({ ok: true });
    expect(w.rel.ops.get("merge-y")?.state).toBe("failed");
    expect(w.s.calls.filter(one => one === "merge")).toHaveLength(1);
  });

  test("finding 3 (round 2): a person's direct deploy is settled only when its process, pause and journal say it ended", async () => {
    const dir = stateDir();
    const w = releaseWorld();
    w.s.checks.set(SHA, []);
    expect(await runRelease(options(dir, { limits: { ci: 1 } }), w.adapters)).toMatchObject({ ok: false, step: "ci" });
    w.s.checks.set(SHA, passing(REQUIRED_PR_CHECKS));
    w.s.installed = { ...w.s.installed, services: [OLD] };
    w.rel.ops.set("deploy-d", { id: "deploy-d", kind: "deploy", state: "running", candidate: SHA, externalRef: null, reservedAt: new Date(w.s.now).toISOString(), direct: true, issuerGone: true, stage: "/stage/d" });
    let idle = false;
    const asked: (string | null)[] = [];
    w.adapters.toolroll.deploymentIdle = async stage => { asked.push(stage); return idle; };
    expect(await runRelease(options(dir), w.adapters)).toMatchObject({ ok: false, reason: "deploy-recovery" });
    expect(w.rel.ops.get("deploy-d")?.state).toBe("running");
    expect(asked).toEqual(["/stage/d"]);
    // Its issuer still alive: nothing is asked or settled.
    w.rel.ops.set("deploy-d", { ...w.rel.ops.get("deploy-d")!, issuerGone: false });
    expect(await runRelease(options(dir), w.adapters)).toMatchObject({ ok: false, reason: "operation-in-flight" });
    expect(asked).toHaveLength(1);
    // Gone, and nothing half done: failed.
    w.rel.ops.set("deploy-d", { ...w.rel.ops.get("deploy-d")!, issuerGone: true });
    idle = true;
    await runRelease(options(dir), w.adapters);
    expect(w.rel.ops.get("deploy-d")?.state).toBe("failed");
  });

  test("finding 4: a CI failure after the deploy needs a person's fresh approval, even on the same commit", async () => {
    const dir = stateDir();
    const { s, adapters, rel } = releaseWorld();
    s.checks.set(SHA, passing(REQUIRED_PR_CHECKS).map((run, i) => i === 0 ? { ...run, conclusion: "failure" } : run));
    expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: false, reason: "ci-failed" });
    expect(rel.approvalsNeeded).toHaveLength(1);
    expect(rel.state).toBe("revoked");
    // CI turns green: resuming still doesn't merge under the old approval.
    s.checks.set(SHA, passing(REQUIRED_PR_CHECKS));
    expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: false, reason: "ci-failed" });
    expect(s.calls).not.toContain("merge");
    // --new files the same commit for a person again, as a fresh task.
    const filed: string[] = [];
    const fileGate = adapters.toolroll.fileGate;
    adapters.toolroll.fileGate = async input => { filed.push(input.taskId); return fileGate(input); };
    await runRelease(options(dir, { fresh: true, limits: { approval: 1 } }), adapters);
    expect(filed).toEqual([`${gateTaskId("0.9.52", SHA)}-2`]);
  });

  test("security review: --new after a CI failure files an id that never existed, never a task whose approval stands", async () => {
    const dir = stateDir();
    const { s, adapters, rel } = releaseWorld();
    s.checks.set(SHA, passing(REQUIRED_PR_CHECKS).map((run, i) => i === 0 ? { ...run, conclusion: "failure" } : run));
    expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: false, reason: "ci-failed" });
    s.checks.set(SHA, passing(REQUIRED_PR_CHECKS));
    // `<base>-2` already exists, approved, and its approval still stands under the release.
    const standing = `${gateTaskId("0.9.52", SHA)}-2`;
    const approvedGate = { exists: true, candidate: SHA, scopeDigest: DIGEST, approval: { by: "alex", at: new Date(s.now).toISOString(), digest: DIGEST, basis: "person", role: "approver", active: true }, result: null, failed: null, completion: null };
    const gate = adapters.toolroll.gate;
    adapters.toolroll.gate = async id => (id === standing ? structuredClone(approvedGate) as never : gate(id));
    rel.live = taskId => (taskId === standing ? { applies: true, ok: true, why: null } : { applies: true, ok: false, why: "revoked" });
    const filed: string[] = [];
    const fileGate = adapters.toolroll.fileGate;
    adapters.toolroll.fileGate = async input => { filed.push(input.taskId); return fileGate(input); };
    await runRelease(options(dir, { fresh: true, limits: { approval: 1 } }), adapters);
    expect(filed).toEqual([`${gateTaskId("0.9.52", SHA)}-3`]);
    expect(s.calls).not.toContain("merge");
  });

  test("security review: when the release's approval can't be stopped after a CI failure, the release fails closed", async () => {
    const dir = stateDir();
    const { s, adapters } = releaseWorld();
    s.checks.set(SHA, passing(REQUIRED_PR_CHECKS).map((run, i) => i === 0 ? { ...run, conclusion: "failure" } : run));
    adapters.release!.needsApproval = async () => false;
    expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: false, reason: "lease" });
    expect(s.calls).not.toContain("merge");
    // The journal still says a person must approve again: resuming refuses.
    s.checks.set(SHA, passing(REQUIRED_PR_CHECKS));
    expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: false, reason: "ci-failed" });
    expect(s.calls).not.toContain("merge");
  });
});
