import { retriedInside } from "./check-failure.js";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  checksVerdict, gateTaskId, journalFile, ownerApproval, prChecksVerdict, readJournal, writeJournal, PROTECTION_REPORT_ONLY_CHECKS, REQUIRED_PR_CHECKS, RELEASE_TAG_CHECKS, runRelease, transientNetworkError,
  type CheckRun, type GateState, type HomebrewState, type MainProtection, type ReleaseAdapters, type ReleaseJournal,
} from "./release.js";

const SHA = "a".repeat(40), MERGE = "b".repeat(40), TREE = "c".repeat(40), OTHER = "d".repeat(40);
const OLD = "/state/staged-upgrades/browser-old/runtime/node_modules/toolroll/dist";
const NEW = "/state/staged-upgrades/browser-new/runtime/node_modules/toolroll/dist";
const DIGEST = "scope-digest-1", RECEIPT = "receipt-1";
const T0 = Date.parse("2026-10-08T09:00:00.000Z");
// GitHub's workflow-run path of each job: a required check counts only from ci.yml (codex round 1, inherited CI limitation).
const passing = (names: readonly string[]): CheckRun[] => names.map(name => ({ name, status: "completed", conclusion: "success", workflowPath: ".github/workflows/ci.yml" }));
const MUTATIONS = ["fileGate", "complete", "deploy", "merge", "deleteBranch", "createTag", "propose", "brewMerge"] as const;
type Mutation = typeof MUTATIONS[number];

/** A scripted world: GitHub, npm, the tap and the installed Toolroll, with every change it was asked to make. */
function world(options: { crashAfter?: Mutation } = {}) {
  let crash = options.crashAfter;
  const s = {
    now: T0,
    step: "",
    branchHead: SHA as string | null,
    main: "e".repeat(40),
    mainReads: 0,
    mainAt: null as ((read: number) => string | null) | null,
    upToDate: true as boolean | null,
    /** Main's protection as GitHub answers it; derived from `upToDate` unless a test sets it. */
    protection: undefined as MainProtection | null | undefined,
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
    /** Whether pre-deploy CI reads see `checks` as set. Off: the gate and deploy see green, so tests of failures
     * after deployment keep that timing. Automatic seals always see the stored checks. */
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
    /** Whether GitHub's check history reads whole (fewer than 1000 suites). */
    ciComplete: true,
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
    say: line => { s.said.push(line); if (line.startsWith("• ")) s.step = line.slice(2); },
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
      // main as GitHub's API answers it, and its comparison; a branch behind main once main moved.
      mainHead: async () => { s.mainReads++; return s.mainAt?.(s.mainReads) ?? s.main; },
      contains: async (_repo, _sha, ancestor) => ancestor === s.main && !s.mainMoved,
      upToDateRequired: async () => s.protection !== undefined ? s.protection
        : s.upToDate === null ? null : { effective: s.upToDate, missing: s.upToDate ? [] : ["classic protection: \"Require branches to be up to date before merging\" is off"], notYetRequired: [] },
      complete: async () => s.ciComplete,
      pullRequest: async () => ({ ...s.pr }),
      // As the real adapter answers: every attempt, with its id, app, check suite and commit (a test's own fields win).
      checks: async (repo, sha) => (!s.gateSeesChecks && repo !== "ap9000/homebrew-toolroll" && (s.step === "gate" || (s.step === "deploy" && s.gate.approval?.basis !== "auto-green")) && sha !== MERGE ? passing(REQUIRED_PR_CHECKS)
        : structuredClone(s.checks.get(`${repo === "ap9000/homebrew-toolroll" ? "brew:" : ""}${sha}`) ?? [])).map((run, i) => ({ id: i + 1, app: "github-actions", suite: 1, head: sha, workflowPath: ".github/workflows/ci.yml", ...run })),
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

  // 2026-10-26: three releases stopped on one slow answer from GitHub while they waited (git ls-remote, gh).
  test("a short GitHub network timeout while waiting is asked again, not the release's end; one that lasts runs into the step's limit", async () => {
    const SAID = ["fatal: unable to access 'https://github.com/ap9000/toolroll.git/': Recv failure: Operation timed out",
      'Post "https://api.github.com/graphql": net/http: TLS handshake timeout'];
    const flaky = (times: number, said: string) => { let left = times; return () => { if (left > 0) { left--; throw new Error(`failed (exit 128): ${said}`); } }; };
    const { s, adapters } = world();
    const { remoteHead } = adapters.repo, { checks, tag } = adapters.github;
    // While the pull request checks finish (git ls-remote) and while the release publishes (gh): two misses each.
    const whileCi = flaky(2, SAID[0]!), whilePublishing = flaky(2, SAID[1]!);
    adapters.repo.remoteHead = async branch => { if (s.installed.services[0] === NEW && s.tags.size === 0) whileCi(); return remoteHead(branch); };
    adapters.github.tag = async (repo, name) => { if (s.tags.size > 0) whilePublishing(); return tag(repo, name); };
    expect(await runRelease(options(stateDir()), adapters)).toMatchObject({ ok: true });
    expect(s.said.filter(line => line.includes("GitHub didn't answer in time"))).toEqual(expect.arrayContaining([
      expect.stringContaining("Recv failure: Operation timed out"), expect.stringContaining("TLS handshake timeout")]));

    // GitHub unreachable for the whole step: the step's own limit, saying why.
    const down = world();
    down.adapters.github.checks = async (repo, sha) => { if (down.s.installed.services[0] === NEW) throw new Error(`gh: ${SAID[0]}`); return checks(repo, sha); };
    expect(await runRelease(options(stateDir(), { limits: { ci: 1 } }), down.adapters)).toMatchObject({ ok: false, step: "ci", reason: "timeout", message: expect.stringContaining("Recv failure: Operation timed out") });

    // Anything else still stops the release at once.
    const broken = world();
    broken.adapters.github.checks = async (repo, sha) => { if (broken.s.installed.services[0] === NEW) throw new Error("gh: HTTP 404: Not Found"); return checks(repo, sha); };
    expect(await runRelease(options(stateDir()), broken.adapters)).toMatchObject({ ok: false, step: "ci", reason: "error" });
    for (const [text, transient] of [["Recv failure: Operation timed out", true], ["net/http: TLS handshake timeout", true], ["dial tcp 140.82.112.3:443: i/o timeout", true],
      ["Failed to connect to github.com port 443 after 75003 ms: Couldn't connect to server", true], ["HTTP 404: Not Found", false], ["authentication required", false]] as const)
      expect(transientNetworkError(new Error(text)), text).toBe(transient);
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
      // Checks not started or still running no longer hold the gate (Alex, 2026-10-29): see "a person's release asks
      // during CI" below.
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

    test("a release resumed past the gate checks CI again before deployment", async () => {
      const dir = stateDir();
      const { s, adapters } = world();
      const person = s.onSleep[0]!;
      s.onSleep = [];
      expect(await runRelease(options(dir, { limits: { approval: 1 } }), adapters)).toMatchObject({ ok: false, step: "approval" });
      // Failed now: the pre-deploy read must see it, even on an old journal.
      s.gateSeesChecks = true;
      s.checks.set(SHA, [...passing(REQUIRED_PR_CHECKS.slice(1)), { name: REQUIRED_PR_CHECKS[0], status: "completed", conclusion: "failure" }]);
      s.onSleep = [person];
      expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: false, step: "deploy", reason: "ci-failed" });
      expect(s.calls).toEqual(["fileGate", "complete"]);
    });

    // Which statuses block is the table above; here one waiting and one failed status prove the re-read before merge.
    test.each([blocked[0]!, blocked[2]!])("re-fetches all checks before merge and blocks an extra check now at $status/$conclusion", async ({ status, conclusion }) => {
      const { s, adapters } = world();
      const checks = adapters.github.checks;
      let reads = 0;
      adapters.github.checks = async (repo, sha) => {
        if (sha !== SHA) return checks(repo, sha);
        reads += 1;
        return [...passing(REQUIRED_PR_CHECKS), ...(reads <= 3 ? passing([repeat]) : [{ name: repeat, status, conclusion }])].map((run, i) => ({ id: i + 1, app: "github-actions", suite: 1, head: sha, ...run }));
      };
      expect(await runRelease(options(stateDir()), adapters)).toMatchObject({ ok: false, step: "merge", reason: "ci-failed" });
      // The gate, pre-deploy check, ci step, and re-read at merge.
      expect(reads).toBe(4);
      expect(s.calls).toEqual(["fileGate", "complete", "deploy", "switchLinks"]);
      expect(s.pr.state).toBe("open");
    });
  });

  // CI tests the pull request's head, not GitHub's merge commit: the merged tree is the tested tree only when the branch
  // already holds main's head, so a branch behind main is refused at the gate and again right before the merge.
  test("attack: a branch behind main is refused at the gate, before anything is filed", async () => {
    const { s, adapters } = world();
    s.mainMoved = true;
    expect(await runRelease(options(stateDir()), adapters)).toMatchObject({ ok: false, step: "gate", reason: "base-moved", message: expect.stringMatching(/^The branch is behind main; update it and push\..*Nothing was filed/) });
    expect(s.calls).toEqual([]);
  });

  test("eval review 1 #4: main moving between the comparison and the merge is refused, read from GitHub again", async () => {
    const { s, adapters } = world();
    // GitHub's main moves in the moment after the merge step compared it (the read right before the merge sees it).
    let mergeStep = 0;
    s.mainAt = () => s.calls.includes("deploy") && ++mergeStep >= 2 ? "f".repeat(40) : null;
    expect(await runRelease(options(stateDir()), adapters)).toMatchObject({ ok: false, step: "merge", reason: "base-moved", message: expect.stringContaining("Main moved to fffffff") });
    expect(s.calls).not.toContain("merge");
    expect(s.pr.state).toBe("open");
  });

  test("eval review 1 #4: a person's release also refuses absent or unreadable protection", async () => {
    for (const upToDate of [false, null] as const) {
      const { s, adapters } = world();
      s.upToDate = upToDate;
      expect(await runRelease(options(stateDir()), adapters)).toMatchObject({ ok: false, reason: "base-unprotected" });
      expect(s.calls).not.toContain("fileGate");
      expect(s.calls).not.toContain("merge");
    }
  });

  test("eval review 2 #1: a person's release names exactly what main's protection lacks, and the git lanes it doesn't require yet", async () => {
    const { s, adapters } = world();
    s.protection = { effective: false, missing: ["classic protection: \"Do not allow bypassing the above settings\" is off, so administrators can merge past it"], notYetRequired: [] };
    expect(await runRelease(options(stateDir()), adapters)).toMatchObject({ ok: false, reason: "base-unprotected", message: expect.stringContaining(s.protection.missing[0]!) });
    expect(s.calls).not.toContain("merge");
    const held = world();
    held.s.protection = { effective: true, missing: [], notYetRequired: [...PROTECTION_REPORT_ONLY_CHECKS] };
    expect(await runRelease(options(stateDir()), held.adapters)).toMatchObject({ ok: true });
    expect(held.s.said).toContainEqual(expect.stringContaining("main's protection doesn't require git 2.41 · debian trixie, git 2.47 · debian trixie yet"));
    expect(held.s.said.some(line => line.includes("Warning:"))).toBe(false);
  });

  test("attack: main moving after the gate is refused right before the merge", async () => {
    const { s, adapters } = world();
    // main gains a commit the branch lacks once the gate is filed and approved, while the release waits for its check.
    s.onSleep.push(state => { if (state.gate.approval !== null) state.mainMoved = true; });
    expect(await runRelease(options(stateDir()), adapters)).toMatchObject({ ok: false, step: "merge", reason: "base-moved", message: expect.stringMatching(/^The branch is behind main; update it and push\..*Nothing was merged/) });
    expect(s.calls).toContain("fileGate");
    expect(s.calls).not.toContain("merge");
    expect(s.pr.state).toBe("open");
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

describe("toolroll release: a regated check of the same approved commit (2026-10-27)", () => {
  /** The check's own build commit: exactly the candidate's tree. */
  const BUILT = "7".repeat(40);
  /** A release whose first check (run 3251) failed on a flaky test, stopped at check. */
  const failedOnce = async (withAuthority: boolean) => {
    const dir = stateDir();
    const w = withAuthority ? releaseWorld() : world();
    const { s, adapters } = w;
    s.trees.set(BUILT, TREE);
    let failed = false;
    s.onSleep.unshift(state => {
      if (!failed && state.gate.approval !== null && state.gate.result === null) { failed = true; state.gate.result = { run: 3251, head: BUILT, check: "failed", level: "full", receipt: "r-3251", worktree: "/w/3251" }; }
    });
    expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: false, step: "check", reason: "check-failed" });
    return { dir, s, adapters };
  };
  const passes = (state: ReturnType<typeof world>["s"]) => {
    state.gate.pending = false;
    state.gate.result = { run: 3252, head: BUILT, check: "passed", level: "full", receipt: "r-3252", worktree: "/w/3252" };
  };

  test.each([false, true])("fail, regate, pass: the release resumes on the rerun's result with no new approval (release authority: %s)", async withAuthority => {
    const { dir, s, adapters } = await failedOnce(withAuthority);
    const approvedAt = s.gate.approval!.at;
    // `task regate`: the same candidate, scope and approval; the task is queued again.
    s.gate.pending = true;
    s.onSleep.push(state => { if (state.gate.pending === true) passes(state); });
    expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: true });
    const journal = readJournal(journalFile(dir, "toolroll/simplify-release"))!;
    expect(journal).toMatchObject({ step: "done", candidate: { sha: SHA, tree: TREE }, task: { scopeDigest: DIGEST }, check: { run: 3252, receipt: "r-3252", head: BUILT } });
    expect(s.gate.approval?.at).toBe(approvedAt);
    expect(s.calls.filter(one => one === "fileGate")).toHaveLength(1);
    expect(s.gate.completion?.digest).toBe("r-3252");
    expect(s.commits.get(NEW)).toBe(BUILT);
  });

  test("attack: the failed run's result is never used after a regate; with no rerun on its way it still stops the release", async () => {
    const { dir, s, adapters } = await failedOnce(false);
    // Resumed with nothing queued: the old failure stands.
    expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: false, reason: "check-failed" });
    // Queued again but the rerun never finishes: the release waits out its limit; nothing completes or deploys.
    s.gate.pending = true;
    expect(await runRelease(options(dir, { limits: { check: 5 } }), adapters)).toMatchObject({ ok: false, step: "check", reason: "timeout" });
    expect(s.calls).not.toContain("complete");
    expect(s.calls).not.toContain("deploy");
  });

  test.each([
    ["the candidate was rewritten to the build commit (the 0.9.73 regate)", (state: ReturnType<typeof world>["s"]) => { state.gate.candidate = BUILT; }],
    ["the scope was re-proposed under new words", (state: ReturnType<typeof world>["s"]) => { state.gate.scopeDigest = DIGEST2; }],
  ])("attack: a regate where %s still refuses", async (_name, spoil) => {
    const { dir, s, adapters } = await failedOnce(true);
    spoil(s);
    s.gate.pending = true;
    s.onSleep.push(state => { if (state.gate.pending === true) passes(state); });
    expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: false, reason: "scope-changed" });
    expect(s.calls).not.toContain("deploy");
  });

  test("attack: a passing rerun whose build commit holds other files is not the release", async () => {
    const { dir, s, adapters } = await failedOnce(true);
    s.trees.set(NEXT, TREE2);
    s.gate.pending = true;
    s.onSleep.push(state => { if (state.gate.pending === true) { passes(state); state.gate.result!.head = NEXT; } });
    expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: false, reason: "drift" });
    expect(s.calls).not.toContain("complete");
  });
});

/**
 * Releases that approve themselves when green (docs/plans/auto-approve-green.md), through the state machine: a release
 * world whose plane can seal `auto-check` and `auto-green`. The plane's own proofs are tested on a real store in
 * test/attacks/auto-approve-green.test.ts; here the coordinator's order, stops and words.
 */
function autoWorld(options: { setting?: boolean; authorize?: string; approve?: string } = {}) {
  const w = releaseWorld();
  const { s, adapters, rel } = w;
  const plane = { setting: options.setting ?? true, authorizations: 0, approvals: 0, gaveUp: [] as string[], released: [] as string[], checkFailed: [] as string[], held: null as string | null };
  const at = () => new Date(s.now).toISOString();
  adapters.release!.auto = {
    setting: async () => plane.setting,
    authorizeCheck: async () => {
      plane.authorizations += 1;
      if (!plane.setting) return { ok: false, why: "this project's releases aren't approved automatically" };
      if (options.authorize !== undefined) return { ok: false, why: options.authorize };
      s.gate.approval = { by: "alex", at: at(), digest: DIGEST, basis: "auto-check", role: "approver", active: true, person: { ok: false, why: "approved automatically, not by a person" } };
      return { ok: true };
    },
    checking: async () => plane.setting && s.gate.approval?.basis === "auto-check" ? { ok: true } : { ok: false, why: "approving releases automatically was turned off" },
    approve: async input => {
      plane.approvals += 1;
      const ci = checksVerdict(s.checks.get(input.candidate) ?? [], REQUIRED_PR_CHECKS);
      const why = !plane.setting ? "approving releases automatically was turned off" : options.approve ?? (ci.state !== "passed" ? "CI: a required check didn't pass" : null);
      if (why !== null) { s.gate.approval = null; return { ok: false, why }; }
      s.gate.approval = { by: "alex", at: at(), digest: DIGEST, basis: "auto-green", role: "approver", active: true, person: { ok: false, why: "approved automatically, not by a person" } };
      rel.tasks.add(input.taskId); rel.tipTask = input.taskId;
      s.calls.push("autoGreen");
      return { ok: true, by: "alex", at: at(), ci: REQUIRED_PR_CHECKS.map((name, i) => ({ id: 100 + i, name })) };
    },
    giveUp: async (_task, why) => { plane.gaveUp.push(why); if (s.gate.approval?.basis === "auto-check" || s.gate.approval?.basis === "auto-green") s.gate.approval = null; },
    released: async (_task, tag) => { plane.released.push(tag); },
    holdPublish: async (_task, why) => { plane.held = why; },
    publishHeld: async () => plane.held,
    checkFailed: async (_task, why) => { plane.checkFailed.push(why); },
  };
  // The live predicate also asks the setting for an automatic anchor (scope.ts releaseApprovalOf).
  rel.live = (taskId, action) => {
    if (!rel.tasks.has(taskId)) return { applies: false, ok: false, why: null };
    if (s.gate.approval?.basis === "auto-green" && !plane.setting) return { applies: true, ok: false, why: "the release approval no longer stands: approving releases automatically was turned off" };
    if (rel.state === "revoked") return { applies: true, ok: false, why: "the release was stopped" };
    const states: Record<string, string[]> = { dispatch: ["open"], complete: ["open"], deploy: ["open", "deploying"], merge: ["deploying", "merge-reserved"] };
    return states[action]!.includes(rel.state) ? { applies: true, ok: true, why: null } : { applies: true, ok: false, why: `the release is ${rel.state}` };
  };
  return { ...w, plane };
}

describe("toolroll release: approve automatically when checks pass", () => {
  test("no person approves: auto-check lets the check run, auto-green seals after it passed, and the owner is told", async () => {
    const dir = stateDir();
    const { s, adapters, plane } = autoWorld();
    const outcome = await runRelease(options(dir), adapters);
    expect(outcome).toMatchObject({ ok: true });
    expect(s.calls).toEqual(["fileGate", "autoGreen", "complete", "deploy", "switchLinks", "merge", "deleteBranch", "createTag", "propose", "brewMerge"]);
    expect(s.gate.approval).toMatchObject({ basis: "auto-green" });
    expect(plane).toMatchObject({ authorizations: 1, approvals: 1, gaveUp: [], released: ["v0.9.52"] });
    expect(readJournal(journalFile(dir, "toolroll/simplify-release"))).toMatchObject({ step: "done", auto: { state: "approved", ci: REQUIRED_PR_CHECKS.map((_, i) => 100 + i) }, approval: { by: "alex (automatic)" } });
    expect(s.said).toContain(`  Approved automatically: CI and the release check passed on ${SHA.slice(0, 7)}`);
  });

  test("with the setting off the release waits for a person, as before", async () => {
    const { s, adapters, plane } = autoWorld({ setting: false });
    expect(await runRelease(options(stateDir()), adapters)).toMatchObject({ ok: true });
    expect(s.gate.approval).toMatchObject({ basis: "password" });
    expect(plane).toMatchObject({ authorizations: 0, approvals: 0, released: [] });
  });

  test("a refused auto-check asks a person, tells the owner, and the person's yes releases it", async () => {
    const { s, adapters, plane } = autoWorld({ authorize: "the scope can't be approved automatically" });
    expect(await runRelease(options(stateDir()), adapters)).toMatchObject({ ok: true });
    expect(s.gate.approval).toMatchObject({ basis: "password" });
    expect(plane).toMatchObject({ approvals: 0, gaveUp: ["the scope can't be approved automatically"], released: [] });
    expect(s.calls).not.toContain("autoGreen");
  });

  test.each([
    ["red CI at the seal", (w: ReturnType<typeof autoWorld>) => { w.s.onSleep.push(state => { if (state.gate.result !== null) state.checks.set(SHA, passing(REQUIRED_PR_CHECKS).map((run, i) => i === 0 ? { ...run, conclusion: "failure" } : run)); }); }, "CI: a required check didn't pass"],
    ["a plane refusal (a CI definition changed)", () => {}, ".github/workflows/ci.yml changed (it configures CI or agents)"],
  ])("%s stops at approval for a person; nothing deploys; a person's yes then uses the same passing check", async (_name, spoil, why) => {
    const dir = stateDir();
    const w = autoWorld(why.startsWith(".github") ? { approve: why } : {});
    const { s, adapters, plane } = w;
    const person = s.onSleep[0]!;
    s.onSleep = [state => { if (state.gate.approval !== null && state.gate.result === null) person(state); }];
    spoil(w);
    expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: false, step: "approval", reason: "approval", message: expect.stringContaining(`Not approved automatically: ${why}`) });
    expect(s.calls).toEqual(["fileGate"]);
    expect(plane.gaveUp).toEqual([why]);
    expect(readJournal(journalFile(dir, "toolroll/simplify-release"))).toMatchObject({ step: "approval", auto: { state: "refused", why } });
    // CI green again and the person approves: the journal asks a person, never the plane again, and the check stands.
    s.checks.set(SHA, passing(REQUIRED_PR_CHECKS));
    s.onSleep = [person];
    expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: true });
    expect(s.gate.approval).toMatchObject({ basis: "password" });
    expect(plane).toMatchObject({ authorizations: 1, approvals: 1, released: [] });
  });

  test("failure classes: confirmed infrastructure is checked again under the same approval, and its pass approves itself", async () => {
    const dir = stateDir();
    const { s, adapters, plane } = autoWorld();
    const asked: string[] = [];
    // The plane (check-failure.ts) classifies from its own records: here, Toolroll's own shutdown stopped run 2757.
    adapters.release!.recheck = async task => { asked.push(task); s.gate.pending = true; return { action: "rerun", why: "Toolroll's own shutdown stopped the check before it finished" }; };
    adapters.release!.standing = async () => ({ ok: true, retried: [] });
    s.onSleep = [state => {
      if (state.gate.approval !== null && state.gate.result === null) state.gate.result = { run: 2757, head: SHA, check: "failed", level: "full", receipt: RECEIPT, worktree: "/w" };
      // The rerun the plane queued finishes and passes.
      else if (state.gate.pending === true) { state.gate.pending = false; state.gate.result = { run: 2758, head: SHA, check: "passed", level: "full", receipt: RECEIPT, worktree: "/w" }; }
    }];
    expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: true });
    expect(asked).toEqual([gateTaskId("0.9.52", SHA)]);
    expect(s.said.join("\n")).toContain("Toolroll confirmed it as its own infrastructure, so the check runs again");
    expect(plane).toMatchObject({ approvals: 1, checkFailed: [], released: ["v0.9.52"] });
  });

  test.each([
    ["deterministic", "src/index.test.ts failed", "fix the branch, then release the new commit with `toolroll release"],
    ["unknown", "the check exited 1 with no failing test identified", "a pass then doesn't erase this failure: a person decides"],
    ["agent-behaviour", "app real-model journey group lead failed", "never rerun until they pass, so a person decides"],
  ] as const)("failure classes: a %s failure stops with the truth about what happens next; nothing reruns it", async (kind, why, words) => {
    const dir = stateDir();
    const { s, adapters, plane } = autoWorld();
    adapters.release!.recheck = async () => ({ action: "stop", class: kind, why });
    s.onSleep = [state => { if (state.gate.approval !== null && state.gate.result === null) state.gate.result = { run: 2757, head: SHA, check: "failed", level: "full", receipt: RECEIPT, worktree: "/w" }; }];
    const outcome = await runRelease(options(dir), adapters);
    expect(outcome).toMatchObject({ ok: false, step: "check", reason: "check-failed", message: expect.stringContaining(why) });
    expect(outcome.ok ? "" : outcome.message).toContain(words);
    expect(plane).toMatchObject({ approvals: 0, checkFailed: [expect.stringContaining(why)] });
  });

  test("failure classes: a pass after a failure that wasn't infrastructure doesn't stand (a diagnostic rerun erases nothing)", async () => {
    const dir = stateDir();
    const { s, adapters, plane } = autoWorld({ setting: false });
    adapters.release!.standing = async () => ({ ok: false, why: "an earlier check of this commit (run 2757) failed: src/index.test.ts failed (a failure in the code or its tests: fix the branch). A later pass doesn't erase it, so a person decides", retried: [] });
    expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: false, step: "check", reason: "check-failed", message: expect.stringContaining("A later pass doesn't erase it") });
    expect(s.calls).not.toContain("deploy");
    expect(plane.approvals).toBe(0);
  });

  test("a journey that passed only on its retry is said, never silently part of a person's pass", async () => {
    const { s, adapters } = autoWorld({ setting: false });
    adapters.release!.standing = async () => ({ ok: true, retried: ["app real-model journey group lead"] });
    expect(await runRelease(options(stateDir()), adapters)).toMatchObject({ ok: true });
    expect(s.said.join("\n")).toContain("passed, but only on a retry: app real-model journey group lead");
  });

  test("the setting lowered while the check runs: it doesn't approve, and a person is asked", async () => {
    const { s, adapters, plane } = autoWorld();
    const person = s.onSleep[0]!;
    s.onSleep = [state => { plane.setting = false; person(state); }];
    expect(await runRelease(options(stateDir()), adapters)).toMatchObject({ ok: false, step: "approval", reason: "approval", message: expect.stringContaining("turned off") });
    expect(plane.approvals).toBe(0);
    expect(s.calls).toEqual(["fileGate"]);
  });

  test("the setting lowered after the automatic approval: the release stops before it deploys", async () => {
    const { s, adapters, plane } = autoWorld();
    const complete = adapters.toolroll.complete;
    adapters.toolroll.complete = async (task, receipt) => { plane.setting = false; return complete(task, receipt); };
    s.running = 1;
    s.onSleep.push(state => { state.running = 0; });
    const outcome = await runRelease(options(stateDir()), adapters);
    expect(outcome).toMatchObject({ ok: false, reason: "release", message: expect.stringContaining("turned off") });
    expect(s.calls).not.toContain("deploy");
    expect(s.calls).not.toContain("merge");
  });

  test("a CI failure after the deploy stops, tells the owner, and --new asks a person (never the plane) for the same commit", async () => {
    const dir = stateDir();
    const { s, adapters, rel, plane } = autoWorld();
    const ci = adapters.github.checks;
    adapters.github.checks = async (repo, sha) => s.calls.includes("deploy") && sha === SHA ? passing(REQUIRED_PR_CHECKS).map((run, i) => ({ id: i + 1, app: "github-actions", suite: 1, head: sha, ...run, ...(i === 0 ? { conclusion: "failure" } : {}) })) : ci(repo, sha);
    // Caught before the CLI names move (the re-read at the relink), not only at the ci step.
    expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: false, step: "link", reason: "ci-failed" });
    expect(s.calls).not.toContain("switchLinks");
    expect(rel.approvalsNeeded).toHaveLength(1);
    expect(plane.gaveUp).toEqual([expect.stringContaining("after the deploy")]);
    expect(s.calls).not.toContain("merge");
    await runRelease(options(dir, { fresh: true, limits: { approval: 1 } }), adapters);
    expect(plane.authorizations).toBe(1);
  });

  const red = (sha: string, extra: Partial<CheckRun> = {}) => passing(REQUIRED_PR_CHECKS).map((run, i) => ({ id: i + 1, app: "github-actions", suite: 1, head: sha, ...run, ...(i === 0 ? { conclusion: "failure", ...extra } : {}) }));

  test("codex r1 #5: CI that turns red after the seal stops the release before it deploys, and revokes it", async () => {
    const dir = stateDir();
    const { s, adapters, rel, plane } = autoWorld();
    const ci = adapters.github.checks;
    adapters.github.checks = async (repo, sha) => s.calls.includes("autoGreen") && sha === SHA ? red(sha) : ci(repo, sha);
    expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: false, step: "deploy", reason: "ci-failed", message: expect.stringContaining("Nothing was deployed") });
    expect(s.calls).toEqual(["fileGate", "autoGreen", "complete"]);
    expect(rel.approvalsNeeded).toEqual(["a pull request check failed before the deploy"]);
    expect(plane.gaveUp).toHaveLength(1);
  });

  test("codex r1 #5: a re-run left pending after the seal also stops it before the deploy", async () => {
    const { s, adapters } = autoWorld();
    const ci = adapters.github.checks;
    adapters.github.checks = async (repo, sha) => s.calls.includes("autoGreen") && sha === SHA
      ? [...await ci(repo, sha), { id: 99, app: "github-actions", suite: 1, head: sha, name: REQUIRED_PR_CHECKS[0], status: "in_progress", conclusion: null, workflowPath: ".github/workflows/ci.yml" }] : ci(repo, sha);
    expect(await runRelease(options(stateDir()), adapters)).toMatchObject({ ok: false, step: "deploy", reason: "ci-failed" });
    expect(s.calls).not.toContain("deploy");
  });

  test("codex r1 #4: another app's later same-name success can't hide a GitHub Actions failure, for a person's release too", async () => {
    const { s, adapters } = autoWorld({ setting: false });
    const ci = adapters.github.checks;
    adapters.github.checks = async (repo, sha) => s.calls.includes("deploy") && sha === SHA
      ? [...red(sha), { id: 50, app: "some-other-app", suite: 9, head: sha, name: REQUIRED_PR_CHECKS[0], status: "completed", conclusion: "success" }] : ci(repo, sha);
    expect(await runRelease(options(stateDir()), adapters)).toMatchObject({ ok: false, step: "ci", reason: "ci-failed" });
    expect(s.calls).not.toContain("merge");
  });

  test("codex r1 #4: a check filed under another commit fails the verdict", async () => {
    const { s, adapters } = autoWorld({ setting: false });
    const ci = adapters.github.checks;
    adapters.github.checks = async (repo, sha) => s.calls.includes("deploy") && sha === SHA ? (await ci(repo, sha)).map(run => ({ ...run, head: OTHER })) : ci(repo, sha);
    expect(await runRelease(options(stateDir()), adapters)).toMatchObject({ ok: false, step: "ci", reason: "ci-failed", message: expect.stringContaining("reported for") });
  });

  test("security scan: a build that failed before its check ends the automatic road (never counted as a flake retry)", async () => {
    const { s, adapters, plane } = autoWorld();
    s.onSleep = [state => { if (state.gate.approval !== null) state.gate.failed = "run 2757 ended error"; }];
    expect(await runRelease(options(stateDir()), adapters)).toMatchObject({ ok: false, step: "check", reason: "check-failed" });
    expect(plane.checkFailed).toEqual([]);
    expect(plane.gaveUp).toEqual([expect.stringContaining("release build")]);
  });

  test("prChecksVerdict: jobs by app, suite and name, judged by the latest attempt; failure classes only for an automatic approval", () => {
    const at = (id: number, conclusion: string | null, extra: Partial<CheckRun> = {}): CheckRun => ({ id, name: REQUIRED_PR_CHECKS[0], status: "completed", conclusion, app: "github-actions", suite: 1, head: SHA, workflowPath: ".github/workflows/ci.yml", ...extra });
    const rest = passing(REQUIRED_PR_CHECKS.slice(1)).map((run, i) => ({ ...run, id: 100 + i, app: "github-actions", suite: 1, head: SHA }));
    const flaky = [at(1, "failure"), at(2, "failure"), at(3, "failure"), at(4, "success"), ...rest];
    expect(prChecksVerdict(flaky, SHA, REQUIRED_PR_CHECKS)).toMatchObject({ state: "passed" });
    // An automatic approval: an earlier failure nothing shows as the runner's own is never tolerated, however few.
    expect(prChecksVerdict(flaky, SHA, REQUIRED_PR_CHECKS, { auto: true })).toMatchObject({ state: "failed", failed: [expect.stringContaining("failed 3 times on this commit, and GitHub doesn't show")] });
    expect(prChecksVerdict([at(3, "failure"), at(4, "success"), ...rest], SHA, REQUIRED_PR_CHECKS, { auto: true })).toMatchObject({ state: "failed", failed: [expect.stringContaining("failed once on this commit")] });
    // Confirmed infrastructure (GitHub's job record: no workflow step ran), at most two on the commit.
    const infra = (id: number) => at(id, "failure", { beforeTests: true });
    expect(prChecksVerdict([infra(2), infra(3), at(4, "success"), ...rest], SHA, REQUIRED_PR_CHECKS, { auto: true })).toMatchObject({ state: "passed", failures: [{ id: 2 }, { id: 3 }] });
    expect(prChecksVerdict([infra(1), infra(2), infra(3), at(4, "success"), ...rest], SHA, REQUIRED_PR_CHECKS, { auto: true })).toMatchObject({ state: "failed", failed: [expect.stringContaining("failed 3 times on this commit before the tests ran")] });
    // A candidate-written "infrastructure" label is no record: only the plane's beforeTests reading counts.
    expect(prChecksVerdict([at(3, "failure", { name: `${REQUIRED_PR_CHECKS[0]}`, conclusion: "infrastructure" }), at(4, "success"), ...rest], SHA, REQUIRED_PR_CHECKS, { auto: true })).toMatchObject({ state: "failed" });
    // Two workflow runs of the same job: each must pass on its own latest attempt.
    expect(prChecksVerdict([at(1, "success"), at(2, "failure", { suite: 2 }), ...rest], SHA, REQUIRED_PR_CHECKS)).toMatchObject({ state: "failed" });
    expect(prChecksVerdict([at(1, "success", { app: "other" }), ...rest], SHA, REQUIRED_PR_CHECKS)).toMatchObject({ state: "failed" });
    expect(prChecksVerdict([at(1, "success", { suite: null }), ...rest], SHA, REQUIRED_PR_CHECKS)).toMatchObject({ state: "failed" });
    expect(prChecksVerdict([at(1, "success", { id: null }), ...rest], SHA, REQUIRED_PR_CHECKS)).toMatchObject({ state: "failed" });
    expect(prChecksVerdict(rest, SHA, REQUIRED_PR_CHECKS)).toMatchObject({ state: "pending" });
  });

  test.each([true, false])("eval review 1 #4: a release (automatic=%s) doesn't merge once protection stops holding", async automatic => {
    const { s, adapters } = automatic ? autoWorld() : world();
    s.onSleep.push(state => { if (state.calls.includes("deploy")) state.upToDate = false; });
    s.upToDate = true;
    const at = adapters.github.upToDateRequired;
    adapters.github.upToDateRequired = async repo => s.calls.includes("deploy") ? { effective: false, missing: ["classic protection: \"Do not allow bypassing the above settings\" is off"], notYetRequired: [] } : at(repo);
    expect(await runRelease(options(stateDir()), adapters)).toMatchObject({ ok: false, step: "merge", reason: "base-unprotected" });
    expect(s.calls).not.toContain("merge");
  });

  test("eval review 1 #3: a person's release says when its retry record can't be read, never that nothing was retried", async () => {
    const { s, adapters } = autoWorld({ setting: false });
    adapters.release!.standing = async () => ({ ok: true, retried: null });
    expect(await runRelease(options(stateDir()), adapters)).toMatchObject({ ok: true });
    expect(s.said).toContainEqual(expect.stringContaining("whether anything passed only on a retry is unknown"));
    expect(retriedInside(null)).toBeNull();
  });

  test("eval review 1 #1: a newer workflow run that renames or drops a job never erases its earlier failure", () => {
    const rest = passing(REQUIRED_PR_CHECKS).map((run, i) => ({ ...run, id: 100 + i, app: "github-actions", suite: 1, head: SHA, workflow: 1 }));
    // The Windows containment repeat: a failed "× 20" run, then an on-demand "× 1" dispatch of the same workflow passes.
    const repeat = (id: number, name: string, suite: number, conclusion: string, extra: Partial<CheckRun> = {}): CheckRun =>
      ({ id, name, status: "completed", conclusion, app: "github-actions", suite, head: SHA, workflow: 7, workflowPath: ".github/workflows/ci.yml", ...extra });
    const renamed = [...rest, repeat(200, "repeat × 20", 20, "failure"), repeat(201, "repeat × 1", 21, "success")];
    expect(prChecksVerdict(renamed, SHA, REQUIRED_PR_CHECKS, { auto: true })).toMatchObject({ state: "failed", failed: [expect.stringContaining("repeat × 20 (failed once on this commit")] });
    // Dropped: the newer run of the workflow doesn't have the job at all.
    const dropped = [...rest, repeat(200, "repeat", 20, "failure"), repeat(201, "something else", 21, "success")];
    expect(prChecksVerdict(dropped, SHA, REQUIRED_PR_CHECKS, { auto: true })).toMatchObject({ state: "failed" });
    // A person's release still sees it as a failure the history keeps.
    expect(prChecksVerdict(renamed, SHA, REQUIRED_PR_CHECKS)).toMatchObject({ state: "passed", failures: [{ id: 200, name: "repeat × 20" }] });
    // A vanished job whose failure GitHub shows as the runner's own counts toward the candidate's infrastructure limit.
    const infra = [...rest, repeat(200, "a", 20, "failure", { beforeTests: true }), repeat(201, "b", 21, "failure", { beforeTests: true }), repeat(202, "c", 22, "failure", { beforeTests: true }), repeat(203, "d", 23, "success")];
    expect(prChecksVerdict(infra, SHA, REQUIRED_PR_CHECKS, { auto: true })).toMatchObject({ state: "failed", failed: [expect.stringContaining("failed 3 times on this commit before the tests ran")] });
    expect(prChecksVerdict(infra.filter(one => one.id !== 202), SHA, REQUIRED_PR_CHECKS, { auto: true })).toMatchObject({ state: "passed", failures: [{ id: 200 }, { id: 201 }] });
    // An older run's job still running is waited out by an automatic approval.
    expect(prChecksVerdict([...rest, repeat(200, "old", 20, null as unknown as string, { status: "in_progress" }), repeat(201, "new", 21, "success")], SHA, REQUIRED_PR_CHECKS, { auto: true })).toMatchObject({ state: "pending" });
  });

  test("codex r2 #2: a resumed deploy (saved deploy, runtime rolled back) re-reads CI and doesn't deploy a red candidate", async () => {
    const dir = stateDir();
    const { s, adapters } = autoWorld();
    // The first deploy lands, then the coordinator stops before the services answer (as a crash during health would).
    let served = 0;
    const installed = adapters.toolroll.installed;
    adapters.toolroll.installed = async () => { const now = await installed(); return s.calls.includes("deploy") && served++ < 1000 ? { ...now, services: [OLD] } : now; };
    expect(await runRelease(options(dir, { limits: { deploy: 1 } }), adapters)).toMatchObject({ ok: false, step: "deploy", reason: "timeout" });
    expect(s.calls.filter(one => one === "deploy")).toHaveLength(1);
    // The runtime was put back, CI turned red: the resume issues no second deploy.
    const ci = adapters.github.checks;
    adapters.github.checks = async (repo, sha) => sha === SHA ? red(sha) : ci(repo, sha);
    expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: false, step: "deploy", reason: "ci-failed" });
    expect(s.calls.filter(one => one === "deploy")).toHaveLength(1);
  });

  test("codex r2 #3: CI that stops passing after the merge holds the tag across invocations until a person lets it go on", async () => {
    const dir = stateDir();
    const { s, adapters, plane } = autoWorld();
    const ci = adapters.github.checks;
    let red_ = false;
    adapters.github.checks = async (repo, sha) => red_ && sha === SHA ? red(sha) : ci(repo, sha);
    const merge = adapters.github.merge;
    adapters.github.merge = async (...args) => { const merged = await merge(...args); red_ = true; return merged; };
    expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: false, step: "tag", reason: "ci-failed" });
    expect(plane.held).toContain("stopped passing after the merge");
    // CI green again: the second invocation still tags nothing, publishes nothing, touches no Homebrew.
    red_ = false;
    expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: false, step: "tag", reason: "approval", message: expect.stringContaining("publish-ok") });
    expect(s.calls).not.toContain("createTag");
    // A person lets it go on (release-cli publish-ok): it finishes.
    plane.held = null;
    expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: true });
    expect(s.calls).toContain("createTag");
  });

  test("codex r2 #5: a person's release isn't revoked by an older failed run of a workflow a newer run replaced", async () => {
    const { s, adapters } = autoWorld({ setting: false });
    const ci = adapters.github.checks;
    adapters.github.checks = async (repo, sha) => sha !== SHA ? ci(repo, sha) : [
      // The PR workflow (workflow 1), matrix names and all, green.
      ...(await ci(repo, sha)).map(run => ({ ...run, workflow: 1 })),
      // macos.yml run by hand twice on this commit: the first run failed, the second (a newer suite) passed.
      { id: 500, name: "node 22 · macos-latest", status: "completed", conclusion: "failure", app: "github-actions", suite: 20, head: sha, workflow: 9 },
      { id: 600, name: "node 22 · macos-latest", status: "completed", conclusion: "success", app: "github-actions", suite: 21, head: sha, workflow: 9 },
    ];
    expect(await runRelease(options(stateDir()), adapters)).toMatchObject({ ok: true });
    expect(s.calls).toContain("merge");
  });

  test("codex r2 #5: a required check must be green in its newest run; the classes count the superseded runs' failures", () => {
    const run = (id: number, suite: number, conclusion: string, name: string = REQUIRED_PR_CHECKS[0]): CheckRun => ({ id, name, status: "completed", conclusion, app: "github-actions", suite, head: SHA, workflow: 1, workflowPath: ".github/workflows/ci.yml" });
    const rest = REQUIRED_PR_CHECKS.slice(1).map((name, i) => run(100 + i, 3, "success", name));
    // Newest run red, older green: failed.
    expect(prChecksVerdict([run(1, 2, "success"), run(5, 3, "failure"), ...rest], SHA, REQUIRED_PR_CHECKS)).toMatchObject({ state: "failed" });
    // Older runs red, newest green: passes for a person; with the cap, three failures across runs is too many.
    const history = [run(1, 1, "failure"), run(2, 2, "failure"), run(3, 2, "failure"), run(4, 3, "success"), ...rest];
    expect(prChecksVerdict(history, SHA, REQUIRED_PR_CHECKS)).toMatchObject({ state: "passed" });
    expect(prChecksVerdict(history, SHA, REQUIRED_PR_CHECKS, { auto: true })).toMatchObject({ state: "failed", failed: [expect.stringContaining("failed 3 times")] });
    const infra = history.map(one => one.conclusion === "failure" ? { ...one, beforeTests: true } : one);
    expect(prChecksVerdict(infra, SHA, REQUIRED_PR_CHECKS, { auto: true })).toMatchObject({ state: "failed", failed: [expect.stringContaining("failed 3 times on this commit before the tests ran")] });
    expect(prChecksVerdict(infra.slice(1), SHA, REQUIRED_PR_CHECKS, { auto: true })).toMatchObject({ state: "passed", failures: [{ id: 2 }, { id: 3 }] });
  });

  test("codex r2 #6: history that can't be read whole stops an automatic release, and leaves a person's alone", async () => {
    const auto = autoWorld();
    auto.s.ciComplete = false;
    expect(await runRelease(options(stateDir()), auto.adapters)).toMatchObject({ ok: false, step: "deploy", reason: "ci-failed", message: expect.stringContaining("can't be read whole") });
    expect(auto.s.calls).not.toContain("deploy");
    const person = autoWorld({ setting: false });
    person.s.ciComplete = false;
    expect(await runRelease(options(stateDir()), person.adapters)).toMatchObject({ ok: true });
  });

  // pipeline-speed.md D2 and "Decision: a person's release asks during CI" (Alex, 2026-10-29): the gate files the task
  // while CI runs and the release check runs beside it. A person may approve meanwhile; the plane's automatic approval
  // waits for every check to pass, and nothing deploys, merges, tags or publishes before they do.
  const running = (names: readonly string[]): CheckRun[] => names.map(name => ({ name, status: "in_progress", conclusion: null }));
  const redCi = (): CheckRun[] => [...passing(REQUIRED_PR_CHECKS.slice(1)), { name: REQUIRED_PR_CHECKS[0], status: "completed", conclusion: "failure" }];
  const green = (state: { checks: Map<string, CheckRun[]> }) => checksVerdict(state.checks.get(SHA) ?? [], REQUIRED_PR_CHECKS).state === "passed";
  const ciAheadWorld = (setting: boolean) => {
    const w = autoWorld({ setting });
    w.s.gateSeesChecks = true;
    w.s.checks.set(SHA, running(REQUIRED_PR_CHECKS));
    const seen = { filedWhileRunning: false, checkedWhileRunning: false, sealedWhileRunning: false, irreversibleWhileRunning: [] as string[] };
    // The plane's "CI still running" note: recorded before filing, ended only on the plane's own reading of CI.
    const ciNote = { noted: null as string | null, notedBeforeFiling: false, lifts: [] as boolean[] };
    w.adapters.release!.auto!.ciRunning = async (_task, candidate) => { ciNote.noted = candidate; };
    w.adapters.release!.auto!.ciPassed = async (_task, candidate, ask) => {
      if (checksVerdict(w.s.checks.get(candidate) ?? [], REQUIRED_PR_CHECKS).state !== "passed") return { ok: false, why: "CI hasn't finished" };
      ciNote.noted = null; ciNote.lifts.push(ask);
      return { ok: true };
    };
    const fileGate = w.adapters.toolroll.fileGate;
    w.adapters.toolroll.fileGate = async input => { seen.filedWhileRunning = !green(w.s); ciNote.notedBeforeFiling = ciNote.noted === SHA; return fileGate(input); };
    // The automatic seal and every irreversible step, watched: none may happen while CI isn't green on the commit.
    const approve = w.adapters.release!.auto!.approve;
    w.adapters.release!.auto!.approve = async input => { if (!green(w.s)) seen.sealedWhileRunning = true; return approve(input); };
    const deploy = w.adapters.toolroll.deploy, merge = w.adapters.github.merge, createTag = w.adapters.github.createTag;
    w.adapters.toolroll.deploy = async input => { if (!green(w.s)) seen.irreversibleWhileRunning.push("deploy"); return deploy(input); };
    w.adapters.github.merge = async (...args) => { if (!green(w.s)) seen.irreversibleWhileRunning.push("merge"); return merge(...args); };
    w.adapters.github.createTag = async (...args) => { if (!green(w.s)) seen.irreversibleWhileRunning.push("createTag"); return createTag(...args); };
    return { ...w, seen, ciNote };
  };
  const IRREVERSIBLE = ["deploy", "switchLinks", "merge", "deleteBranch", "createTag", "propose", "brewMerge"];

  test("pipeline-speed D2: the automatic road files and checks while CI runs, and seals only once CI passed", async () => {
    const { s, adapters, plane, seen } = ciAheadWorld(true);
    let after = 0;
    s.onSleep.push(state => {
      if (state.gate.result === null) return;
      if (!green(state)) seen.checkedWhileRunning = true;
      if (++after === 3) state.checks.set(SHA, passing(REQUIRED_PR_CHECKS));
    });
    expect(await runRelease(options(stateDir()), adapters)).toMatchObject({ ok: true });
    expect(seen).toEqual({ filedWhileRunning: true, checkedWhileRunning: true, sealedWhileRunning: false, irreversibleWhileRunning: [] });
    expect(plane).toMatchObject({ approvals: 1, gaveUp: [] });
    expect(s.said).toContain(`  Pull request checks on ${SHA.slice(0, 7)} are still running: the release check runs beside them, and nothing deploys before they pass`);
    expect(s.calls.slice(0, 2)).toEqual(["fileGate", "autoGreen"]);
  });

  test("pipeline-speed D2: CI failing beside the check ends the automatic road, and the person's road refuses it too", async () => {
    const dir = stateDir();
    const { s, adapters, plane, seen } = ciAheadWorld(true);
    s.onSleep.push(state => { if (state.gate.result !== null) state.checks.set(SHA, redCi()); });
    expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: false, reason: "ci-failed", message: expect.stringContaining("Nothing was approved") });
    expect(plane.approvals).toBe(0);
    expect(seen.sealedWhileRunning).toBe(false);
    expect(plane.gaveUp).toEqual([expect.stringContaining("Pull request checks already failed")]);
    expect(readJournal(journalFile(dir, "toolroll/simplify-release"))).toMatchObject({ step: "approval", auto: { state: "refused" }, ciAhead: true });
    // Run again: the person's road stops on the failed check before asking anyone.
    s.gate.approval = null;
    expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: false, step: "approval", reason: "ci-failed", message: expect.stringContaining("Nothing was deployed or merged") });
    expect(s.said.some(line => line.includes("needs your approval"))).toBe(false);
    expect(s.calls).toEqual(["fileGate"]);
  });

  test("the automatic road refusing with CI pending asks a person at once; nothing deploys before CI passes", async () => {
    const { s, adapters, plane, seen, ciNote } = ciAheadWorld(true);
    adapters.release!.auto!.authorizeCheck = async () => ({ ok: false, why: "its checks run unsandboxed" });
    let sleeps = 0, askedWhileRunning = false;
    s.onSleep.unshift(state => {
      if (s.said.some(line => line.includes("needs your approval")) && !green(state)) askedWhileRunning = true;
      if (++sleeps === 6) state.checks.set(SHA, passing(REQUIRED_PR_CHECKS));
    });
    expect(await runRelease(options(stateDir()), adapters)).toMatchObject({ ok: true });
    expect(ciNote.notedBeforeFiling).toBe(true);
    expect(plane).toMatchObject({ gaveUp: ["its checks run unsandboxed"], approvals: 0 });
    expect(askedWhileRunning).toBe(true);
    expect(s.said).toContain("  GitHub's checks are still running; nothing deploys until they pass.");
    expect(seen.irreversibleWhileRunning).toEqual([]);
    expect(ciNote.noted).toBeNull();
  });

  describe("a person's release asks during CI (Alex, 2026-10-29)", () => {
    test("filed and asked while CI runs; the check runs at once; nothing deploys until CI passes, then it proceeds", async () => {
      const dir = stateDir();
      const { s, adapters, seen, ciNote } = ciAheadWorld(false);
      let checkedWhileRunning = false, sleeps = 0, deployWaited = false;
      s.onSleep.push(state => {
        if (state.gate.result !== null && !green(state)) checkedWhileRunning = true;
        // Approved and checked while CI still runs; the release then waits before the deploy.
        if (state.gate.completion !== null && !green(state)) { deployWaited = true; if (++sleeps === 3) state.checks.set(SHA, passing(REQUIRED_PR_CHECKS)); }
      });
      expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: true });
      expect(seen).toMatchObject({ filedWhileRunning: true, irreversibleWhileRunning: [] });
      expect(checkedWhileRunning && deployWaited).toBe(true);
      expect(ciNote).toMatchObject({ notedBeforeFiling: true, noted: null, lifts: [false] });
      expect(s.said).toContain("  GitHub's checks are still running; nothing deploys until they pass.");
      expect(s.said.findIndex(line => line.includes("needs your approval"))).toBeLessThan(s.said.findIndex(line => line.startsWith("• check")));
      expect(s.calls).toEqual(["fileGate", "complete", ...IRREVERSIBLE]);
      expect(readJournal(journalFile(dir, "toolroll/simplify-release"))).toMatchObject({ step: "done", ciAhead: false, ciBeforeDeploy: true });
    });

    test("approved before CI, the check passes, then CI fails: nothing is deployed, merged, tagged or published", async () => {
      const dir = stateDir();
      const { s, adapters } = ciAheadWorld(false);
      s.onSleep.push(state => { if (state.gate.completion !== null) state.checks.set(SHA, redCi()); });
      const outcome = await runRelease(options(dir), adapters);
      expect(outcome).toMatchObject({ ok: false, step: "deploy", reason: "ci-failed" });
      expect(outcome.ok === false && outcome.message).toContain("Nothing was deployed, merged, tagged or published");
      expect(outcome.ok === false && outcome.message).toContain(`The approval covers ${SHA.slice(0, 7)} only`);
      expect(s.calls).toEqual(["fileGate", "complete"]);
      // Rerunning with CI still red stops the same way; nothing irreversible, ever.
      expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: false, step: "deploy", reason: "ci-failed" });
      for (const call of IRREVERSIBLE) expect(s.calls).not.toContain(call);
      expect(s.published).toBe(false);
      // The failed job rerun on GitHub and green: the same approval of the same commit goes on.
      s.checks.set(SHA, [...redCi(), ...passing([REQUIRED_PR_CHECKS[0]])]);
      expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: true });
      expect(s.calls.filter(one => one === "deploy")).toHaveLength(1);
    });

    test.each([false, true])("CI green at the gate still blocks deploy after a failed rerun (resumed: %s)", async resumed => {
      const dir = stateDir();
      const { s, adapters } = world(resumed ? { crashAfter: "fileGate" } : {});
      s.gateSeesChecks = true;
      s.onSleep.push(state => {
        if (state.gate.result !== null) state.checks.set(SHA, [...passing(REQUIRED_PR_CHECKS), { name: REQUIRED_PR_CHECKS[0], status: "completed", conclusion: "failure" }]);
      });
      if (resumed) expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: false, step: "gate" });
      expect(await runRelease(options(dir), adapters)).toMatchObject({ ok: false, step: "deploy", reason: "ci-failed" });
      for (const call of IRREVERSIBLE) expect(s.calls).not.toContain(call);
    });

    test("CI that was green while asking but whose newer attempt fails before the deploy stops the release", async () => {
      const { s, adapters, ciNote } = ciAheadWorld(false);
      // Green by the approval, then a rerun of one job fails while the release check runs.
      s.onSleep.unshift(state => {
        if (state.gate.exists && state.gate.approval === null) state.checks.set(SHA, passing(REQUIRED_PR_CHECKS));
        else if (state.gate.approval !== null) state.checks.set(SHA, [...passing(REQUIRED_PR_CHECKS), { name: REQUIRED_PR_CHECKS[0], status: "completed", conclusion: "failure" }]);
      });
      expect(await runRelease(options(stateDir()), adapters)).toMatchObject({ ok: false, step: "deploy", reason: "ci-failed" });
      expect(ciNote.lifts).toEqual([true]);
      for (const call of IRREVERSIBLE) expect(s.calls).not.toContain(call);
    });

    test("a check that never finishes keeps the deploy waiting until its limit, and nothing deploys", async () => {
      const { s, adapters } = ciAheadWorld(false);
      expect(await runRelease(options(stateDir(), { limits: { ci: 1 } }), adapters)).toMatchObject({ ok: false, step: "deploy", reason: "timeout" });
      expect(s.calls).toEqual(["fileGate", "complete"]);
    });

    test("a check that already failed at the gate still stops there: nothing filed, nobody asked", async () => {
      const { s, adapters } = ciAheadWorld(false);
      s.checks.set(SHA, redCi());
      expect(await runRelease(options(stateDir()), adapters)).toMatchObject({ ok: false, step: "gate", reason: "ci-failed" });
      expect(s.calls).toEqual([]);
    });
  });
});
