/**
 * Attack: make Land on main (everyday-8 #1, src/local-landing.ts) change something a person didn't say yes to, or run
 * something of the repository's. The ways in: a destination some checkout has checked out (the person's own folder
 * included), or a symbolic one naming another branch; a branch that moved, before the look or between the look and the
 * write; a branch switched mid-landing; check bindings changed during the git reads; a stale or replayed yes; a
 * project-restricted person triggering another project's recovery; a checkout whose git config, hooks or attributes
 * name a program; a `.git` that is a link; hostile branch names; a crash between git and the record; an undo over
 * later work; a project that publishes through pull requests. Guard: only an unoccupied, non-symbolic branch moves,
 * never a checkout's files; hardened git bound to the project's record; `update-ref --no-deref` with the expected old
 * commit after a last in-transaction check of authority, policy, receipt and check bindings; a key pinning everything
 * the person saw; recovery that only records, for people who may land there.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { git, useScratch, write } from "./harness.js";
import { openStore, type Store } from "../../src/store.js";
import { addApprover, approve, propose } from "../../src/scope.js";
import { storeEvidence } from "../../src/evidence.js";
import { sealVerificationReceipt } from "../../src/verification-evidence.js";
import { recordRunCheckLevel } from "../../src/check-levels.js";
import { acceptAndCompleteAsOperator, assignmentOf } from "../../src/assignment.js";
import { verifyApproverByPassword, type VerifiedApprover } from "../../src/principal.js";
import { broughtInOnBranch, handoffsOf, handoffWords, land, landableBranch, landingOf, landingWords, LAND_INTENT, LAND_SETTLED, readLanding, recognisedOnBranch, shownName, type LandAuthority } from "../../src/local-landing.js";
import { readGit } from "../../src/task-base.js";
import { recordActionWhole } from "../../src/action-ledger.js";
import { run as execRun } from "../../src/exec.js";
import type { Runner } from "../../src/backend.js";
import { EXIT, runOperate } from "../../src/operate.js";
import { savePublishing } from "../../src/pull-request-flow.js";
import { requestFollowUpChecks, runFollowUpCheck } from "../../src/result-follow-ups.js";

const NOW = new Date("2026-11-25T12:00:00.000Z");
const scratch = useScratch("land");
let store: Store, repo = "", root = "", who: VerifiedApprover, person: LandAuthority, markers = "";
const access = () => ({ repos: [repo] });
// The project folder stands on its own `work` branch (built() leaves it there), so main is unoccupied; the first landing
// names main as its destination.
const options = (extra: { git?: Runner; into?: string } = {}) => ({ root, scratch: scratch(), into: "main", ...extra });
const at = (ref = "main") => git(repo, "rev-parse", ref);

/** A finished, checked build of `id` on branch toolroll/<id>, its commit changing `files`; completed by alex unless `complete` is false. */
function built(id: string, files: Record<string, string>, opts: { complete?: boolean; checked?: boolean } = {}): { head: string; base: string } {
  const base = at();
  const branch = `toolroll/${id}`;
  git(repo, "checkout", "-q", "-b", branch);
  for (const [file, text] of Object.entries(files)) write(join(repo, file), text);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", `work for ${id}`);
  const head = at("HEAD");
  git(repo, "checkout", "-q", "-B", "work", "main");
  store.createTask({ id, title: id }, NOW);
  const ref = store.refFor("built-in", id).id;
  store.placeTask(ref, repo, {}, NOW);
  const proposed = propose(store, { taskId: id, goal: `Do ${id}`, touches: ["a.txt"], acceptance: [{ id: "c1", statement: "it works", how: null, evidence: ["check"] }], now: NOW });
  if (!approve(store, id, "alex", NOW, proposed.digest, password).ok) throw new Error("approve");
  const authority = store.routeAuthorityFor(ref, "builder");
  if (!authority?.ok) throw new Error("route");
  const runId = store.startRun({ taskRef: ref, leaseId: `l-${id}`, runner: "r", branch, worktree: `/pool/${id}`, route: authority.stamp, now: NOW });
  store.stampRun(runId, { scopeDigest: store.getScope(id)!.digest, baseRevision: base });
  store.recordOutcomeFacts(runId, { headRevision: head, handoff: "Done." });
  store.finishRun(runId, { outcome: "built", committed: true, now: NOW });
  store.setTaskState(id, "done", NOW);
  recordRunCheckLevel(store, { id: runId, taskId: id, repo }, "full", "project", NOW);
  const verdict = opts.checked === false ? "attested" as const : "verified" as const;
  store.saveProofVerdict(runId, verdict, [], NOW, [{ id: "c1", statement: "it works", requiredEvidence: ["check"], state: "pass", detail: [], answered: [{ kind: "check", ref: "true" }], review: null }] as never, verdict);
  storeEvidence(store, root, runId, "terminal-diff", "diff.patch", Buffer.from("diff --git a/a.txt b/a.txt\n"), "git diff (exit 0)", NOW, { captureStatus: "ok" });
  if (opts.checked !== false) {
    storeEvidence(store, root, runId, "check-log", "checks.txt", Buffer.from("1 passed\n"), "true", NOW, { captureStatus: "ok" });
    sealVerificationReceipt(store, root, runId, head, store.liveVerifyCommand(repo)!, { configured: true, ran: true, exitCode: 0 }, NOW);
    store.recordRunCheck(runId, { status: "passed", exitCode: 0, suites: [] }, NOW);
  }
  if (opts.complete !== false) {
    const read = assignmentOf(store, id, NOW, { principal: "operator", repos: [repo] }, root)!.receipt!.digest;
    const done = acceptAndCompleteAsOperator(store, id, { runId, receiptDigest: read, note: opts.checked === false ? "Read it myself" : null }, who, NOW, root);
    if (!done.ok) throw new Error(done.message);
  }
  return { head, base };
}
let password = "";

beforeEach(() => {
  const dir = scratch();
  markers = join(dir, "markers");
  mkdirSync(markers);
  root = join(dir, "evidence");
  repo = join(dir, "project");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  write(join(repo, "a.txt"), "one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "initial");
  store = openStore(join(dir, "orders.db"));
  const alex = addApprover(store, "alex", NOW);
  if (!alex.ok) throw new Error("alex");
  password = alex.token;
  for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", NOW);
  store.setVerifyCommand({ repo, command: "true", timeoutMs: 60_000, approvedBy: "alex" }, NOW);
  const proved = verifyApproverByPassword(store, "alex", password, [repo]);
  if (!proved.ok) throw new Error("alex password");
  who = proved.who;
  person = { kind: "person", who };
});
afterEach(() => store.close());

/** Read the plan and land exactly it. */
async function landNow(id: string, extra: { git?: Runner; undo?: boolean; authority?: LandAuthority } = {}) {
  const read = await readLanding(store, id, access(), NOW, { ...options(extra), ...(extra.undo ? { undo: true } : {}) });
  if (!read.ok || !("plan" in read)) return { read, landed: null };
  const landed = await land(store, id, { key: read.plan.key, into: "main", ...(extra.undo ? { undo: true } : {}) }, extra.authority ?? person, access(), NOW, options(extra));
  return { read, landed };
}
const plain = (path: string) => readFileSync(path, "utf8");
const settles = () => Number(store.handle.prepare("SELECT count(*) AS n FROM action_ledger WHERE action = ?").get(LAND_SETTLED)!["n"]);
/** A runner that does `before` once, right before the `nth` git call naming `verb`. */
const racing = (verb: string, before: () => void, nth = 1): Runner => {
  let seen = 0;
  return (file, args, opts) => {
    if (args.includes(verb) && ++seen === nth) before();
    return execRun(file, args, opts);
  };
};

describe("land on main: the legitimate path", () => {
  test("an unoccupied main moves; no folder's files are touched; the destination is recorded; the same yes again writes nothing", async () => {
    const { head } = built("t1", { "a.txt": "two\n", "b.txt": "new\n" });
    writeFileSync(join(repo, "notes.txt"), "my own work\n");
    const before = at();
    const read = await readLanding(store, "t1", access(), NOW, options());
    expect(read.ok && "plan" in read && read.plan).toMatchObject({ mode: "ref", checks: "passed", ref: "refs/heads/main", recorded: false, candidate: head,
      squash: { policy: "squash", message: "t1 (Toolroll task t1)", fileCount: 2, added: 2, removed: 1 } });
    const { landed } = await landNow("t1");
    expect(landed).toMatchObject({ ok: true, replayed: false, mode: "ref" });
    // One new commit: the candidate's exact tree on main's commit.
    expect(at()).toBe(landed?.ok && landed.commit);
    expect(git(repo, "rev-parse", "main^{tree}")).toBe(git(repo, "rev-parse", `${head}^{tree}`));
    expect(git(repo, "rev-list", "--parents", "-n", "1", "main")).toBe(`${at()} ${before}`);
    // The person's folder (on its own branch, with its own change) is exactly as it was.
    expect(plain(join(repo, "a.txt"))).toBe("one\n");
    expect(plain(join(repo, "notes.txt"))).toBe("my own work\n");
    expect(landingOf(store, "t1")?.intent).toMatchObject({ commit: at(), candidate: head });
    if (!read.ok || !("plan" in read)) throw new Error("plan");
    expect(await land(store, "t1", { key: read.plan.key, into: "main" }, person, access(), NOW, options())).toMatchObject({ ok: true, replayed: true });
    expect(await readLanding(store, "t1", access(), NOW, options())).toMatchObject({ ok: true, landed: { commit: at() } });
  });

  test("a project with no check command lands, saying no check ran; one whose checks changed since doesn't", async () => {
    store.clearVerifyCommand(repo, "alex", NOW);
    built("t3", { "a.txt": "two\n" }, { checked: false });
    const read = await readLanding(store, "t3", access(), NOW, options());
    expect(read.ok && "plan" in read && read.plan.checks).toBe("none");
    store.setVerifyCommand({ repo, command: "true", timeoutMs: 60_000, approvedBy: "alex" }, new Date(NOW.getTime() + 1000));
    const later = new Date(NOW.getTime() + 2000);
    expect(assignmentOf(store, "t3", later, { principal: "operator", repos: [repo] }, root)?.state).toBe("complete");
    expect(await readLanding(store, "t3", access(), later, options())).toMatchObject({ ok: false, reason: "checks" });
  });

  test("checks run again after Accept (everyday-9 A2): it stays Complete; a pass lands, a failure blocks Land with the reason", async () => {
    const heads = { "t-pass": built("t-pass", { "a.txt": "t-pass\n" }).head, "t-fail": built("t-fail", { "a.txt": "t-fail\n" }).head };
    let tick = 0;
    for (const [id, command, passes] of [["t-pass", "true && true", true], ["t-fail", "false", false]] as const) {
      const later = new Date(NOW.getTime() + ++tick * 1000), after = new Date(NOW.getTime() + ++tick * 1000);
      store.setVerifyCommand({ repo, command, timeoutMs: 60_000, approvedBy: "alex" }, later);
      const runId = store.runsFor(store.lookupRef(id)!.id)[0]!.id;
      const asked = requestFollowUpChecks(store, { runId, level: "full", actor: "operator:alex", why: "person" }, after);
      if (!asked.ok) throw new Error(JSON.stringify(asked));
      expect(await runFollowUpCheck(store, root, asked.request, { now: () => after }), command).toMatchObject({ state: passes ? "passed" : "failed", head: heads[id] });
      expect(assignmentOf(store, id, after, { principal: "operator", repos: [repo] }, root)?.state, command).toBe("complete");
      const read = await readLanding(store, id, access(), after, options());
      if (passes) {
        expect(read.ok && "plan" in read && read.plan.checks, command).toBe("passed");
        if (!read.ok || !("plan" in read)) throw new Error("plan");
        expect(await land(store, id, { key: read.plan.key, into: "main" }, person, access(), after, options()), command).toMatchObject({ ok: true });
        expect(git(repo, "show", "main:a.txt")).toBe(id);
      } else {
        expect(read, command).toMatchObject({ ok: false, reason: "checks" });
        expect(!read.ok && read.message, command).toContain("stays Complete");
      }
    }
  });

  test("not accepted yet: nothing lands", async () => {
    built("t5", { "a.txt": "two\n" }, { complete: false });
    expect(await readLanding(store, "t5", access(), NOW, options())).toMatchObject({ ok: false, reason: "not-complete" });
  });
});

describe("attack: a destination that isn't a free, real branch", () => {
  const refusals: Record<string, { setup: () => void; reason: string; says?: (head: string) => string }> = {
    "main is a symbolic ref to another branch": { setup: () => { git(repo, "branch", "other", "main"); git(repo, "symbolic-ref", "refs/heads/main", "refs/heads/other"); }, reason: "destination" },
    "main moved on since the work started": { setup: () => { git(repo, "checkout", "-q", "main"); write(join(repo, "c.txt"), "later\n"); git(repo, "add", "-A"); git(repo, "commit", "-qm", "later"); git(repo, "checkout", "-q", "work"); }, reason: "moved", says: () => "bring this task up to date first" },
    "a .git that is a link": { setup: () => { renameSync(join(repo, ".git"), join(scratch(), "real-git")); symlinkSync(join(scratch(), "real-git"), join(repo, ".git")); }, reason: "destination" },
  };
  for (const [name, row] of Object.entries(refusals)) {
    test(`${name}: refused, nothing changed`, async () => {
      const { head } = built("t", { "a.txt": "two\n" });
      row.setup();
      const before = git(repo, "rev-parse", "refs/heads/main");
      const read = await readLanding(store, "t", access(), NOW, options());
      expect(read, name).toMatchObject({ ok: false, reason: row.reason });
      if (row.says !== undefined) expect(!read.ok && read.message, name).toContain(row.says(head));
      expect(git(repo, "rev-parse", "refs/heads/main"), name).toBe(before);
    });
  }

  test("a symbolic destination is refused before the lock too, with a key read earlier; the branch it names never moves", async () => {
    built("t", { "a.txt": "two\n" });
    const read = await readLanding(store, "t", access(), NOW, options());
    if (!read.ok || !("plan" in read)) throw new Error("plan");
    git(repo, "branch", "other", "main");
    const other = at("other");
    git(repo, "symbolic-ref", "refs/heads/main", "refs/heads/other");
    expect(await land(store, "t", { key: read.plan.key, into: "main" }, person, access(), NOW, options())).toMatchObject({ ok: false, reason: "destination" });
    expect(at("other")).toBe(other);
  });

  test("hostile branch names never become a destination", () => {
    for (const name of ["-x", "a..b", "toolroll/t1", ".hidden", "a/.b", "x.lock", "HEAD", "a b", "a\nb", "a~1", "a^", "a:b", "", "x".repeat(101)]) expect(landableBranch(name), JSON.stringify(name)).toBe(false);
    for (const name of ["main", "release/1.2", "feature_x"]) expect(landableBranch(name), name).toBe(true);
  });
});

describe("attack: the repository's own config, hooks and attributes", () => {
  const program = (name: string) => {
    const path = join(scratch(), `${name}.sh`);
    writeFileSync(path, `#!/bin/sh\necho ran > '${join(markers, name)}'\ncat\n`);
    chmodSync(path, 0o755);
    return path;
  };
  test("hooks never run: a reference-transaction hook stays silent while main moves", async () => {
    const { head } = built("t", { "a.txt": "two\n" });
    for (const hook of ["reference-transaction", "post-checkout", "post-merge", "post-commit", "pre-commit", "commit-msg"]) {
      writeFileSync(join(repo, ".git", "hooks", hook), `#!/bin/sh\necho ran > '${join(markers, hook)}'\n`);
      chmodSync(join(repo, ".git", "hooks", hook), 0o755);
    }
    expect((await landNow("t")).landed).toMatchObject({ ok: true });
    expect(git(repo, "rev-parse", "main^{tree}")).toBe(git(repo, "rev-parse", `${head}^{tree}`));
    for (const hook of ["reference-transaction", "post-checkout", "post-merge", "post-commit", "pre-commit", "commit-msg"]) expect(existsSync(join(markers, hook)), hook).toBe(false);
  });

  const configs: Record<string, (path: string) => void> = {
    "a smudge filter": path => { git(repo, "config", "filter.evil.smudge", path); writeFileSync(join(repo, ".git", "info", "attributes"), "* filter=evil\n"); },
    "an fsmonitor": path => git(repo, "config", "core.fsmonitor", path),
    "an include": path => { writeFileSync(join(scratch(), "inc"), `[core]\n\tfsmonitor = ${path}\n`); git(repo, "config", "include.path", join(scratch(), "inc")); },
    "a hooks path": path => { mkdirSync(join(scratch(), "hooks")); writeFileSync(join(scratch(), "hooks", "reference-transaction"), `#!/bin/sh\n${path}\n`); chmodSync(join(scratch(), "hooks", "reference-transaction"), 0o755); git(repo, "config", "core.hooksPath", join(scratch(), "hooks")); },
  };
  for (const [name, plant] of Object.entries(configs)) {
    test(`${name} in the project's config never runs`, async () => {
      built("t", { "a.txt": "two\n" });
      mkdirSync(join(repo, ".git", "info"), { recursive: true });
      plant(program("planted"));
      await landNow("t");
      expect(existsSync(join(markers, "planted")), name).toBe(false);
    });
  }

  test("a file name with a terminal escape, a newline and a bidi override can't spoof the yes; the key binds the raw name", async () => {
    const hostile = "a\u001b[2J\nb\u202ec.txt";
    built("t", { [hostile]: "x\n" });
    const read = await readLanding(store, "t", access(), NOW, options());
    if (!read.ok || !("plan" in read)) throw new Error("plan");
    expect(read.plan.squash?.files).toEqual([hostile]);
    const shown = landingWords(read.plan).join("\n");
    expect(shown).not.toMatch(/[\u001b\u202e]/);
    expect(shown.split("\n")[0]).toContain("a\\u{1b}[2J\\u{a}b\\u{202e}c.txt");
    // A task title with ESC, U+202E, U+200B and U+FEFF: neither the yes nor the commit message (git log) carries them.
    store.handle.prepare("UPDATE task SET title = ? WHERE id = 't'").run("fix\u001b[31m it\u202e\u200b\ufeffnow");
    const again = await readLanding(store, "t", access(), NOW, options());
    if (!again.ok || !("plan" in again)) throw new Error("plan");
    expect(again.plan.squash?.message).toBe("fix [31m it now (Toolroll task t)");
    expect(landingWords(again.plan).join("\n")).not.toMatch(/[\u001b\u202e\u200b\ufeff]/);
    expect((await land(store, "t", { key: again.plan.key, into: "main" }, person, access(), NOW, options())).ok).toBe(true);
    expect(git(repo, "log", "-1", "--format=%B", "main")).toBe("fix [31m it now (Toolroll task t)");
    // Two names that would show alike never share a key: the key is over the raw names.
    expect(shownName("a\\u{1b}")).not.toBe(shownName("a\u001b"));
  });

  test("a tree that needs a Git filter (LFS) or holds a submodule is refused", async () => {
    built("t", { ".gitattributes": "*.bin filter=lfs diff=lfs merge=lfs -text\n", "x.bin": "pointer\n" });
    expect(await readLanding(store, "t", access(), NOW, options())).toMatchObject({ ok: false, reason: "unsupported" });
  });
});

describe("attack: races, replays, access and crashes", () => {
  test("the branch moves right before the write: the swap refuses, the other commit stays", async () => {
    built("t", { "a.txt": "two\n" });
    const read = await readLanding(store, "t", access(), NOW, options());
    if (!read.ok || !("plan" in read)) throw new Error("plan");
    let other = "";
    const result = await land(store, "t", { key: read.plan.key, into: "main" }, person, access(), NOW, options({ git: racing("update-ref", () => {
      other = git(repo, "commit-tree", `${at()}^{tree}`, "-p", at(), "-m", "someone else");
      git(repo, "update-ref", "refs/heads/main", other);
    }) }));
    expect(result).toMatchObject({ ok: false, reason: "moved" });
    expect(at()).toBe(other);
  });

  test("main made a symbolic ref right before the write: the write never follows it; the branch it names stays put", async () => {
    built("t", { "a.txt": "two\n" });
    const read = await readLanding(store, "t", access(), NOW, options());
    if (!read.ok || !("plan" in read)) throw new Error("plan");
    let other = "";
    await land(store, "t", { key: read.plan.key, into: "main" }, person, access(), NOW, options({ git: racing("update-ref", () => {
      git(repo, "branch", "other", "main");
      other = at("other");
      git(repo, "symbolic-ref", "refs/heads/main", "refs/heads/other");
    }) }));
    expect(at("other")).toBe(other);
  });

  test("a branch switch right before the write: no checkout's index or files are touched", async () => {
    built("t", { "a.txt": "two\n" });
    const read = await readLanding(store, "t", access(), NOW, options());
    if (!read.ok || !("plan" in read)) throw new Error("plan");
    git(repo, "checkout", "-q", "-b", "side", "main");
    await land(store, "t", { key: read.plan.key, into: "main" }, person, access(), NOW, options({ git: racing("update-ref", () => git(repo, "checkout", "-q", "main")) }));
    // The folder's files stay as they were (git would show its branch moved; nothing rewrote the files under it).
    expect(plain(join(repo, "a.txt"))).toBe("one\n");
  });

  test("the check command changes during the git reads: the last check refuses; main unchanged", async () => {
    built("t", { "a.txt": "two\n" });
    const before = at();
    const read = await readLanding(store, "t", access(), NOW, options());
    if (!read.ok || !("plan" in read)) throw new Error("plan");
    // The second checkout listing inside the yes is the final check's, after the intent: the binding changes there.
    const result = await land(store, "t", { key: read.plan.key, into: "main" }, person, access(), NOW, options({ git: racing("list", () =>
      store.setVerifyCommand({ repo, command: "npm test", timeoutMs: 60_000, approvedBy: "alex" }, NOW), 2) }));
    expect(result).toMatchObject({ ok: false, reason: "stale" });
    expect(at()).toBe(before);
  });

  test("a stale yes refuses; nothing changed", async () => {
    built("t", { "a.txt": "two\n" });
    const read = await readLanding(store, "t", access(), NOW, options());
    if (!read.ok || !("plan" in read)) throw new Error("plan");
    store.setVerifyCommand({ repo: `quick:${repo}`, command: "npm run quick", timeoutMs: 60_000, approvedBy: "alex" }, NOW);
    const stale = await land(store, "t", { key: read.plan.key, into: "main" }, person, access(), NOW, options());
    expect(stale, JSON.stringify(stale)).toMatchObject({ ok: false, reason: "stale" });
    expect(await land(store, "t", { key: "f".repeat(16), into: "main" }, person, access(), NOW, options())).toMatchObject({ ok: false, reason: "stale" });
  });

  test("the local owner's act isn't in flight: refused at the moment of use", async () => {
    built("t", { "a.txt": "two\n" });
    const before = at();
    expect((await landNow("t", { authority: { kind: "local" } })).landed).toMatchObject({ ok: false, reason: "authority" });
    expect(at()).toBe(before);
  });

  const pending = (base: string, head: string, mode: "ref" | "files" = "ref") => {
    const runId = store.runsFor(store.lookupRef("t")!.id)[0]!.id;
    recordActionWhole(store.handle, { at: NOW.toISOString(), actor: "operator:alex", repo, taskId: "t", runId, action: LAND_INTENT, outcome: "pending", source: "request" },
      { v: 1, kind: "land", key: "0".repeat(16), ref: "refs/heads/main", old: base, commit: head, mode });
  };

  test("a person without this project never triggers its pending recovery", async () => {
    const { head, base } = built("t", { "a.txt": "two\n" });
    pending(base, head);
    const sam = addApprover(store, "sam", NOW, { name: "alex", token: password });
    if (!sam.ok) throw new Error("sam");
    const elsewhere = join(scratch(), "elsewhere");
    expect(store.setAccountProjects("sam", [elsewhere], "alex", NOW)).toEqual({ ok: true });
    const proved = verifyApproverByPassword(store, "sam", sam.token, [elsewhere]);
    if (!proved.ok) throw new Error("sam password");
    expect(await land(store, "t", { key: "0".repeat(16), into: "main" }, { kind: "person", who: proved.who }, { repos: [elsewhere] }, NOW, options())).toMatchObject({ ok: false });
    expect(await land(store, "t", { key: "0".repeat(16), into: "main" }, { kind: "person", who: proved.who }, { repos: null }, NOW, options())).toMatchObject({ ok: false, reason: "authority" });
    expect(settles()).toBe(0);
  });

  test("a crash after the write: the next landing records it; files are never touched by recovery", async () => {
    const { head, base } = built("t", { "a.txt": "two\n" });
    git(repo, "update-ref", "refs/heads/main", head, base);
    pending(base, head);
    await land(store, "t", { key: "f".repeat(16), into: "main" }, person, access(), NOW, options());
    expect(landingOf(store, "t")?.intent.commit).toBe(head);
    expect(plain(join(repo, "a.txt"))).toBe("one\n");
  });

  test("an earlier version's files-mode intent, or a branch now symbolic: left to the person, nothing read-tree'd", async () => {
    const { head, base } = built("t", { "a.txt": "two\n" });
    git(repo, "checkout", "-q", "main");
    git(repo, "update-ref", "refs/heads/main", head, base);
    pending(base, head, "files");
    await land(store, "t", { key: "f".repeat(16), into: "main" }, person, access(), NOW, options());
    expect(landingOf(store, "t")).toBeNull();
    // The folder's files stay at the old commit: recovery never moves them.
    expect(plain(join(repo, "a.txt"))).toBe("one\n");
  });

  test("a crash before the write: settled as abandoned, and the next landing goes ahead", async () => {
    const { head, base } = built("t", { "a.txt": "two\n" });
    pending(base, head);
    expect((await landNow("t")).landed).toMatchObject({ ok: true });
    expect(git(repo, "rev-parse", "main^{tree}")).toBe(git(repo, "rev-parse", `${head}^{tree}`));
  });
});

describe("undo: a new commit that reverts exactly what landed", () => {
  test("undo after later work keeps the later work", async () => {
    const { base } = built("t", { "a.txt": "two\n" });
    await landNow("t");
    git(repo, "worktree", "add", "-q", join(scratch(), "later"), "main");
    write(join(scratch(), "later", "c.txt"), "later\n");
    git(join(scratch(), "later"), "add", "-A");
    git(join(scratch(), "later"), "commit", "-qm", "later");
    git(repo, "worktree", "remove", join(scratch(), "later"));
    const later = at();
    const { landed } = await landNow("t", { undo: true });
    expect(landed).toMatchObject({ ok: true, kind: "undo", mode: "ref" });
    expect(git(repo, "rev-parse", "main^")).toBe(later);
    expect(git(repo, "show", "main:a.txt")).toBe("one");
    expect(git(repo, "show", "main:c.txt")).toBe("later");
    expect(git(repo, "rev-list", "--count", `${base}..main`)).toBe("3");
    expect(landingOf(store, "t")?.undone).toBe(true);
    expect(await readLanding(store, "t", access(), NOW, { ...options(), undo: true })).toMatchObject({ ok: false, reason: "nothing" });
  });

  test("undo while main is checked out in the folder refuses with the git revert command; main unchanged", async () => {
    built("t", { "a.txt": "two\n" });
    await landNow("t");
    git(repo, "checkout", "-q", "main");
    const landedAt = at();
    const read = await readLanding(store, "t", access(), NOW, { ...options(), undo: true });
    expect(read).toMatchObject({ ok: false, reason: "occupied" });
    expect(!read.ok && read.message).toContain(`git -C '${repo}' revert --no-edit`);
    expect(at()).toBe(landedAt);
  });
});

describe("checked-out main (everyday-9 A1): never touched; a kept commit and the exact command instead", () => {
  const planOf = async () => {
    const read = await readLanding(store, "t", access(), NOW, options());
    if (!read.ok || !("plan" in read)) throw new Error(JSON.stringify(read));
    return read.plan;
  };
  /** Every file and the index of the project folder, to show none changed. */
  const folderState = () => ({ status: git(repo, "status", "--porcelain=v1", "--untracked-files=all"), head: at("HEAD"), index: git(repo, "ls-files", "-s"),
    a: plain(join(repo, "a.txt")) });

  const folders: Record<string, () => void> = {
    "a clean folder on main": () => undefined,
    "a changed tracked file": () => writeFileSync(join(repo, "a.txt"), "my edit\n"),
    "a staged change": () => { writeFileSync(join(repo, "c.txt"), "staged\n"); git(repo, "add", "c.txt"); },
    "an untracked file": () => writeFileSync(join(repo, "notes.txt"), "mine\n"),
    "a merge in progress": () => writeFileSync(join(repo, ".git", "MERGE_HEAD"), `${at()}\n`),
  };
  for (const [name, make] of Object.entries(folders)) {
    test(`${name}: main and the folder stay exactly as they were; the commit is kept and the exact ff-only command is shown`, async () => {
      const { head } = built("t", { "a.txt": "two\n" });
      git(repo, "checkout", "-q", "main");
      make();
      const before = at(), was = folderState();
      const plan = await planOf();
      expect(plan.mode, name).toBe("handoff");
      const { landed } = await landNow("t");
      if (landed?.ok !== true || landed.handoff === null) throw new Error(JSON.stringify(landed));
      expect(at(), name).toBe(before);
      expect(folderState(), name).toEqual(was);
      expect(landed.commit).toBe(plan.squash?.commit);
      expect(git(repo, "rev-parse", landed.handoff.ref)).toBe(landed.commit);
      expect(landed.handoff.command).toBe(`git -C '${repo}' merge --ff-only ${landed.commit}`);
      expect(git(repo, "rev-parse", `${landed.commit}^{tree}`)).toBe(git(repo, "rev-parse", `${head}^{tree}`));
      expect(git(repo, "rev-parse", `${landed.commit}^`)).toBe(before);
      // The same yes again names the same commit, writing nothing new.
      expect(await land(store, "t", { key: plan.key, into: "main" }, person, access(), NOW, options())).toMatchObject({ ok: true, replayed: true, commit: landed.commit });
    });
  }

  test("main checked out in another folder (an agent's checkout, say): refused with no command to run there; nothing touched", async () => {
    built("t", { "a.txt": "two\n" });
    const other = join(scratch(), "other");
    git(repo, "worktree", "add", "-q", other, "main");
    const before = at();
    const read = await readLanding(store, "t", access(), NOW, options());
    expect(read).toMatchObject({ ok: false, reason: "occupied" });
    expect(!read.ok && read.message).not.toContain("git ");
    expect(!read.ok && read.message).not.toContain(other);
    expect(at()).toBe(before);
    expect(plain(join(other, "a.txt"))).toBe("one\n");
  });

  /** The command as the shell reads it: printf stands in for git and prints each argument as it arrives. */
  const asTheShellReadsIt = (command: string): string[] =>
    execFileSync("/bin/sh", ["-c", command.replace(/^git /, "printf '%s\\0' ")], { cwd: markers, encoding: "utf8" }).split("\0").slice(0, -1);
  /** Move the project to a folder named `name` (Toolroll's records follow), with a fresh password proof for it. */
  const moveProjectTo = (name: string) => {
    const moved = join(scratch(), name);
    renameSync(repo, moved);
    repo = moved;
    store.setVerifyCommand({ repo, command: "true", timeoutMs: 60_000, approvedBy: "alex" }, NOW);
    const proved = verifyApproverByPassword(store, "alex", password, [repo]);
    if (!proved.ok) throw new Error("alex password");
    who = proved.who;
    person = { kind: "person", who };
  };

  test("a project folder named with a space, $(…), a quote and a backslash: the copied command's folder is exactly the recorded one", async () => {
    moveProjectTo("my proj $(touch PWNED) it's \\ x");
    built("t", { "a.txt": "two\n" });
    git(repo, "checkout", "-q", "main");
    const { landed } = await landNow("t");
    if (landed?.ok !== true || landed.handoff?.command == null) throw new Error(JSON.stringify(landed));
    expect(asTheShellReadsIt(landed.handoff.command)).toEqual(["-C", repo, "merge", "--ff-only", landed.commit]);
    expect(existsSync(join(markers, "PWNED"))).toBe(false);
  });

  test("a project folder whose name holds a newline: no command at all, only what to run in the project folder", async () => {
    moveProjectTo("proj\nx");
    built("t", { "a.txt": "two\n" });
    git(repo, "checkout", "-q", "main");
    const { landed } = await landNow("t");
    if (landed?.ok !== true || landed.handoff === null) throw new Error(JSON.stringify(landed));
    expect(landed.handoff.command).toBeNull();
    expect(handoffWords(landed.handoff, landed.commit)).toBe(`Toolroll can't write a safe command for this folder's name; run git merge --ff-only ${landed.commit} in your project folder.`);
  });

  test("HEAD elsewhere (detached at main's commit): only the branch moves; the folder stays where it was", async () => {
    built("t", { "a.txt": "two\n" });
    git(repo, "checkout", "-q", "--detach", "main");
    const was = at("HEAD");
    expect((await planOf()).mode).toBe("ref");
    expect((await landNow("t")).landed).toMatchObject({ ok: true, mode: "ref" });
    expect(at("HEAD")).toBe(was);
    expect(plain(join(repo, "a.txt"))).toBe("one\n");
  });

  test("main checked out between the look and the yes: refused, nothing moved, the folder untouched", async () => {
    built("t", { "a.txt": "two\n" });
    const plan = await planOf();
    expect(plan.mode).toBe("ref");
    const before = at();
    git(repo, "checkout", "-q", "main");
    expect(await land(store, "t", { key: plan.key, into: "main" }, person, access(), NOW, options())).toMatchObject({ ok: false });
    expect(at()).toBe(before);
    expect(plain(join(repo, "a.txt"))).toBe("one\n");
  });

  test("the handoff's ref can't be created: nothing is reported kept; the same yes again keeps it and settles", async () => {
    built("t", { "a.txt": "two\n" });
    git(repo, "checkout", "-q", "main");
    const plan = await planOf();
    let refused = false;
    const failing: Runner = (file, args, opts) => {
      if (!refused && args.includes("update-ref") && args.some(arg => arg.startsWith("refs/toolroll/land/"))) { refused = true; return Promise.resolve({ code: 1, stdout: "", stderr: "refused", timedOut: false } as never); }
      return execRun(file, args, opts);
    };
    expect(await land(store, "t", { key: plan.key, into: "main" }, person, access(), NOW, options({ git: failing }))).toMatchObject({ ok: false, reason: "git" });
    expect(handoffsOf(store, repo, "t")).toEqual([]);
    const again = await land(store, "t", { key: plan.key, into: "main" }, person, access(), NOW, options());
    expect(again).toMatchObject({ ok: true, mode: "handoff", commit: plan.squash?.commit });
    expect(handoffsOf(store, repo, "t").map(one => one.commit)).toEqual([plan.squash?.commit]);
  });

  test("a recorded handoff whose kept ref went missing: the same yes re-proves it, keeps it again, never reports it kept untrue", async () => {
    built("t", { "a.txt": "two\n" });
    git(repo, "checkout", "-q", "main");
    const plan = await planOf();
    const { landed } = await landNow("t");
    if (landed?.ok !== true || landed.handoff === null) throw new Error(JSON.stringify(landed));
    git(repo, "update-ref", "-d", landed.handoff.ref);
    expect(await land(store, "t", { key: plan.key, into: "main" }, person, access(), NOW, options())).toMatchObject({ ok: true, replayed: true, commit: landed.commit });
    expect(git(repo, "rev-parse", landed.handoff.ref)).toBe(landed.commit);
  });

  test("handed off, brought in by the person, then Undo: recorded as landed (granting nothing) and that exact commit reverted", async () => {
    built("t", { "a.txt": "two\n" });
    git(repo, "checkout", "-q", "main");
    const before = at();
    const { landed } = await landNow("t");
    if (landed?.ok !== true || landed.handoff === null) throw new Error(JSON.stringify(landed));
    git(repo, "merge", "-q", "--ff-only", landed.commit);
    expect(recognisedOnBranch(store, repo, "t", git(repo, "rev-parse", "toolroll/t"), readGit)).toBe("On main");
    expect(broughtInOnBranch(store, repo, "t", readGit)).toBe(true);
    // With main still checked out, Undo says the exact revert to run there.
    const there = await readLanding(store, "t", access(), NOW, { ...options(), undo: true });
    expect(!there.ok && there.message).toContain(`revert --no-edit ${before}..${landed.commit}`);
    git(repo, "checkout", "-q", "work");
    const undone = await landNow("t", { undo: true });
    expect(undone.landed).toMatchObject({ ok: true, kind: "undo" });
    expect(git(repo, "rev-parse", "main^")).toBe(landed.commit);
    expect(git(repo, "rev-parse", "main^{tree}")).toBe(git(repo, "rev-parse", `${before}^{tree}`));
    expect(landingOf(store, "t")).toMatchObject({ undone: true, intent: { commit: landed.commit, fromHandoff: expect.any(Number) } });
  });
});

describe("the landed commit is exactly what was read and checked (everyday-9 A1)", () => {
  test("its id is in the yes before anything is written, made from the completion's own time: the same inputs give the same commit", async () => {
    built("t", { "a.txt": "two\n" });
    const first = await readLanding(store, "t", access(), NOW, options());
    const second = await readLanding(store, "t", access(), new Date(NOW.getTime() + 60_000), options());
    if (!first.ok || !("plan" in first) || !second.ok || !("plan" in second)) throw new Error("plan");
    expect(second.plan.squash?.commit).toBe(first.plan.squash?.commit);
    expect(second.plan.key).toBe(first.plan.key);
    expect(() => git(repo, "cat-file", "-e", first.plan.squash!.commit)).toThrow();
    expect(landingWords(first.plan).join("\n")).toContain("Checks ran on these exact files");
    const { landed } = await landNow("t");
    expect(landed).toMatchObject({ ok: true, commit: first.plan.squash?.commit });
    expect(git(repo, "rev-parse", "refs/toolroll/land/t")).toBe(first.plan.squash?.commit);
  });

  test("a different squash after the yes (another parent, or other words) is refused: nothing lands", async () => {
    built("t", { "a.txt": "two\n" });
    const read = await readLanding(store, "t", access(), NOW, options());
    if (!read.ok || !("plan" in read)) throw new Error("plan");
    store.handle.prepare("UPDATE task SET title = ? WHERE id = 't'").run("Different words");
    const before = at();
    expect(await land(store, "t", { key: read.plan.key, into: "main" }, person, access(), NOW, options())).toMatchObject({ ok: false, reason: "stale" });
    expect(at()).toBe(before);
  });

  test("the commit written isn't the one read (a git that answers another id): refused before anything moves", async () => {
    built("t", { "a.txt": "two\n" });
    const read = await readLanding(store, "t", access(), NOW, options());
    if (!read.ok || !("plan" in read)) throw new Error("plan");
    const lying: Runner = async (file, args, opts) => {
      const ran = await execRun(file, args, opts);
      return args.includes("hash-object") ? { ...ran, stdout: `${"e".repeat(40)}\n` } : ran;
    };
    const before = at();
    expect(await land(store, "t", { key: read.plan.key, into: "main" }, person, access(), NOW, options({ git: lying }))).toMatchObject({ ok: false, reason: "stale" });
    expect(at()).toBe(before);
  });
});

describe("already on main (everyday-9 A3): recognised for display, never granting anything", () => {
  test("merged by hand: the page says On main, Land offers nothing; Toolroll records no landing", async () => {
    const { head } = built("t", { "a.txt": "two\n" });
    git(repo, "update-ref", "refs/heads/main", head);
    expect(recognisedOnBranch(store, repo, "t", head, readGit)).toBeNull(); // nothing recorded and the folder is on work
    git(repo, "checkout", "-q", "main");
    expect(recognisedOnBranch(store, repo, "t", head, readGit)).toBe("On main");
    expect(await readLanding(store, "t", access(), NOW, options())).toMatchObject({ ok: false, reason: "nothing" });
    expect(landingOf(store, "t")).toBeNull();
  });

  test("a handed-off landing commit brought in by the person: recognised once main contains it", async () => {
    built("t", { "a.txt": "two\n" });
    git(repo, "checkout", "-q", "main");
    writeFileSync(join(repo, "notes.txt"), "mine\n");
    const { landed } = await landNow("t");
    if (landed?.ok !== true || landed.handoff === null) throw new Error(JSON.stringify(landed));
    const head = assignmentOf(store, "t", NOW, { principal: "operator", repos: [repo] }, root)!.receipt!.head;
    expect(recognisedOnBranch(store, repo, "t", head, readGit)).toBeNull();
    git(repo, "merge", "-q", "--ff-only", landed.commit);
    expect(recognisedOnBranch(store, repo, "t", head, readGit)).toBe("On main");
    expect(await readLanding(store, "t", access(), NOW, options())).toMatchObject({ ok: false, reason: "nothing" });
  });

  test("recognition never grants acceptance: work not accepted stays not accepted, and Land still refuses it", async () => {
    const { head } = built("t", { "a.txt": "two\n" }, { complete: false });
    git(repo, "update-ref", "refs/heads/main", head);
    git(repo, "checkout", "-q", "main");
    const before = assignmentOf(store, "t", NOW, { principal: "operator", repos: [repo] }, root)?.state;
    expect(before).not.toBe("complete");
    // A build-writable branch containing the commit changes nothing about the task.
    recognisedOnBranch(store, repo, "t", head, readGit);
    expect(assignmentOf(store, "t", NOW, { principal: "operator", repos: [repo] }, root)?.state).toBe(before);
    expect(await readLanding(store, "t", access(), NOW, options())).toMatchObject({ ok: false, reason: "not-complete" });
    expect(await land(store, "t", { key: "0".repeat(16), into: "main" }, person, access(), NOW, options())).toMatchObject({ ok: false });
    expect(landingOf(store, "t")).toBeNull();
  });
});

describe("attack: land around a project's pull requests", () => {
  const publishOn = () => savePublishing(store, { repo, githubRepo: "alex/shop", remote: "origin", base: "main", account: "alex" }, "alex", {}, NOW);

  test("pull requests on: the look, a yes read before they were set up, and an undo all refuse; main unchanged", async () => {
    built("t", { "a.txt": "two\n" });
    const before = at();
    const read = await readLanding(store, "t", access(), NOW, options());
    if (!read.ok || !("plan" in read)) throw new Error("plan");
    publishOn();
    expect(await readLanding(store, "t", access(), NOW, options())).toMatchObject({ ok: false, reason: "pull-requests" });
    expect(await land(store, "t", { key: read.plan.key, into: "main" }, person, access(), NOW, options())).toMatchObject({ ok: false, reason: "pull-requests" });
    expect(await land(store, "t", { key: "0".repeat(16), undo: true }, person, access(), NOW, options())).toMatchObject({ ok: false, reason: "pull-requests" });
    expect(at()).toBe(before);
  });

  test("pull requests set up while it lands: the last check refuses before anything moves", async () => {
    built("t", { "a.txt": "two\n" });
    const before = at();
    const read = await readLanding(store, "t", access(), NOW, options());
    if (!read.ok || !("plan" in read)) throw new Error("plan");
    expect(await land(store, "t", { key: read.plan.key, into: "main" }, person, access(), NOW, options({ git: racing("list", publishOn, 2) }))).toMatchObject({ ok: false, reason: "pull-requests" });
    expect(at()).toBe(before);
  });
});

describe("squash: exactly the reviewed change lands, as one commit (everyday-9 A1)", () => {
  /** A candidate carrying two rejected attempts' commits before its last one. */
  function stacked(id: string): { head: string; rejected: string[] } {
    const start = at();
    git(repo, "checkout", "-q", "-b", `rejected-${id}`, "main");
    const rejected: string[] = [];
    for (const [n, text] of [["1", "first try\n"], ["2", "second try\n"]] as const) {
      write(join(repo, "a.txt"), text);
      git(repo, "commit", "-qam", `rejected attempt ${n}`);
      rejected.push(at("HEAD"));
    }
    // The accepted build starts on the rejected head (a revision), its own commit on top.
    git(repo, "update-ref", "refs/heads/main", rejected[1]!);
    const { head } = built(id, { "a.txt": "accepted\n", "b.txt": "new\n" });
    git(repo, "update-ref", "refs/heads/main", start);
    return { head, rejected };
  }

  test("rejected attempts' commits never reach main; the intent binds candidate, base, tree, policy and checks", async () => {
    const { head, rejected } = stacked("t");
    const before = at();
    const { landed } = await landNow("t");
    expect(landed).toMatchObject({ ok: true });
    expect(git(repo, "rev-list", "--count", `${before}..main`)).toBe("1");
    for (const one of rejected) expect(() => git(repo, "merge-base", "--is-ancestor", one, "main"), one).toThrow();
    expect(git(repo, "show", "main:a.txt")).toBe("accepted");
    expect(git(repo, "log", "-1", "--format=%s", "main")).toBe("t (Toolroll task t)");
    const intent = store.handle.prepare("SELECT detail FROM action_ledger WHERE action = ?").get(LAND_INTENT)!;
    expect(JSON.parse(String(intent["detail"]))).toMatchObject({ policy: "squash", candidate: head, old: before, commit: at(), tree: git(repo, "rev-parse", `${head}^{tree}`), checks: "passed" });
  });

  test("undo reverts that one commit: main's files are as before the landing", async () => {
    stacked("t");
    const before = at();
    const { landed } = await landNow("t");
    const squash = landed?.ok === true ? landed.commit : "";
    const undone = await landNow("t", { undo: true });
    expect(undone.landed).toMatchObject({ ok: true, kind: "undo" });
    expect(git(repo, "rev-parse", "main^")).toBe(squash);
    expect(git(repo, "rev-parse", "main^{tree}")).toBe(git(repo, "rev-parse", `${before}^{tree}`));
  });

  /** What a landing that died after making its commit leaves: that commit, and an unsettled intent naming it. */
  const diedAfterCommit = (head: string): string => {
    const before = at();
    const squash = git(repo, "commit-tree", `${head}^{tree}`, "-p", before, "-m", "t (Toolroll task t)");
    const runId = store.runsFor(store.lookupRef("t")!.id)[0]!.id;
    recordActionWhole(store.handle, { at: NOW.toISOString(), actor: "operator:alex", repo, taskId: "t", runId, action: LAND_INTENT, outcome: "pending", source: "request" },
      { v: 1, kind: "land", key: "0".repeat(16), ref: "refs/heads/main", old: before, commit: squash, mode: "ref", policy: "squash", candidate: head, tree: git(repo, "rev-parse", `${head}^{tree}`), checks: "passed" });
    return squash;
  };

  test("a crash between making the commit and moving main: the next landing settles it as abandoned and lands once", async () => {
    const { head } = stacked("t");
    const before = at();
    diedAfterCommit(head);
    expect((await landNow("t")).landed).toMatchObject({ ok: true });
    expect(git(repo, "rev-list", "--count", `${before}..main`)).toBe("1");
    const outcomes = store.handle.prepare("SELECT outcome FROM action_ledger WHERE action = ? ORDER BY id").all(LAND_SETTLED).map(row => String(row["outcome"]).replace(/^\d+:/, ""));
    expect(outcomes).toEqual(["abandoned", "landed"]);
  });

  test("a crash right after main moved: recovery records it landed, and the same task offers nothing more to land", async () => {
    const { head } = stacked("t");
    const squash = diedAfterCommit(head);
    git(repo, "update-ref", "refs/heads/main", squash, at());
    await land(store, "t", { key: "f".repeat(16), into: "main" }, person, access(), NOW, options());
    expect(landingOf(store, "t")?.intent).toMatchObject({ commit: squash, candidate: head });
    expect(await readLanding(store, "t", access(), NOW, options())).toMatchObject({ ok: true, landed: { commit: squash } });
    expect(at()).toBe(squash);
  });

  test("a stale yes: main moved after the look (even forward), so the yes refuses and nothing lands", async () => {
    stacked("t");
    const read = await readLanding(store, "t", access(), NOW, options());
    if (!read.ok || !("plan" in read)) throw new Error("plan");
    const other = git(repo, "commit-tree", `${at()}^{tree}`, "-p", at(), "-m", "someone else");
    git(repo, "update-ref", "refs/heads/main", other);
    expect(await land(store, "t", { key: read.plan.key, into: "main" }, person, access(), NOW, options())).toMatchObject({ ok: false });
    expect(at()).toBe(other);
  });

  test("the first yes replayed after an undo writes nothing", async () => {
    stacked("t");
    const read = await readLanding(store, "t", access(), NOW, options());
    if (!read.ok || !("plan" in read)) throw new Error("plan");
    expect(await land(store, "t", { key: read.plan.key, into: "main" }, person, access(), NOW, options())).toMatchObject({ ok: true, replayed: false });
    await landNow("t", { undo: true });
    const undone = at();
    expect(await land(store, "t", { key: read.plan.key, into: "main" }, person, access(), NOW, options())).toMatchObject({ ok: true, replayed: true });
    expect(at()).toBe(undone);
  });
});

describe("the command", () => {
  test("bare shows what lands and its key; --yes --key lands it with a password; a missing key refuses", async () => {
    const { head } = built("t", { "a.txt": "two\n" });
    const lines: string[] = [];
    const cli = (argv: string[]) => { lines.length = 0; return runOperate("task", argv, line => lines.push(line), { databaseFile: join(scratch(), "orders.db"), now: NOW }); };
    store.close();
    expect(await cli(["land", "t", "--into", "main"]), lines.join("\n")).toBe(EXIT.ok);
    const key = /--key ([0-9a-f]{16})/.exec(lines.join("\n"))?.[1];
    expect(lines.join("\n")).toContain("Lands 1 commit on main: a.txt (+1 −1).");
    // Said up front: from a plain shell, the yes asks for a name and password.
    expect(lines.join("\n")).toContain("--as <you>");
    expect(lines.join("\n")).toContain("That asks for your Toolroll password.");
    expect(await cli(["land", "t", "--into", "main", "--yes", "--as", "alex", "--token", password])).toBe(EXIT.usage);
    expect(await cli(["land", "t", "--into", "main", "--yes", "--key", key!, "--as", "alex", "--token", password]), lines.join("\n")).toBe(EXIT.ok);
    expect(git(repo, "rev-parse", "main^{tree}")).toBe(git(repo, "rev-parse", `${head}^{tree}`));
    store = openStore(join(scratch(), "orders.db"));
  });
});
