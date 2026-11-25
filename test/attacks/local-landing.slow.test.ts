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
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { git, useScratch, write } from "./harness.js";
import { openStore, type Store } from "../../src/store.js";
import { addApprover, approve, propose } from "../../src/scope.js";
import { storeEvidence } from "../../src/evidence.js";
import { sealVerificationReceipt } from "../../src/verification-evidence.js";
import { recordRunCheckLevel } from "../../src/check-levels.js";
import { acceptAndCompleteAsOperator, assignmentOf } from "../../src/assignment.js";
import { verifyApproverByPassword, type VerifiedApprover } from "../../src/principal.js";
import { land, landableBranch, landingOf, LAND_INTENT, LAND_SETTLED, readLanding, type LandAuthority } from "../../src/local-landing.js";
import { recordActionWhole } from "../../src/action-ledger.js";
import { run as execRun } from "../../src/exec.js";
import type { Runner } from "../../src/backend.js";
import { EXIT, runOperate } from "../../src/operate.js";
import { savePublishing } from "../../src/pull-request-flow.js";

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

  test("not accepted yet: nothing lands", async () => {
    built("t5", { "a.txt": "two\n" }, { complete: false });
    expect(await readLanding(store, "t5", access(), NOW, options())).toMatchObject({ ok: false, reason: "not-complete" });
  });
});

describe("attack: a destination that isn't a free, real branch", () => {
  const refusals: Record<string, { setup: () => void; reason: string; says?: (head: string) => string }> = {
    "main checked out in the person's own folder": { setup: () => git(repo, "checkout", "-q", "main"), reason: "occupied", says: head => `merge --squash ${head}` },
    "main checked out in another folder": { setup: () => git(repo, "worktree", "add", "-q", join(scratch(), "other"), "main"), reason: "occupied" },
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
    expect(!read.ok && read.message).toContain("revert --no-edit");
    expect(at()).toBe(landedAt);
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
    expect(await cli(["land", "t", "--into", "main", "--yes", "--as", "alex", "--token", password])).toBe(EXIT.usage);
    expect(await cli(["land", "t", "--into", "main", "--yes", "--key", key!, "--as", "alex", "--token", password]), lines.join("\n")).toBe(EXIT.ok);
    expect(git(repo, "rev-parse", "main^{tree}")).toBe(git(repo, "rev-parse", `${head}^{tree}`));
    store = openStore(join(scratch(), "orders.db"));
  });
});
