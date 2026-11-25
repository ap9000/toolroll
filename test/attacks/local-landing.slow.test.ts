/**
 * Attack: make Land on main (everyday-8 #1, src/local-landing.ts) change something a person didn't say yes to, or run
 * something of the repository's. The ways in: a dirty, half-merged, sparse or elsewhere-checked-out project; a branch
 * that moved, before the look or between the look and the swap; an editor writing the folder mid-landing; a stale or
 * replayed yes; a checkout whose git config, hooks or attributes name a program; a `.git` that is a link; hostile
 * branch names; a crash between git and the record; an undo over later work. Guard: hardened git bound to the
 * project's record, a fresh re-read before the compare-and-swap, git's own refusing two-tree fast-forward for files,
 * a rollback by compare-and-swap, a key pinning everything the person saw, and a recovery record for every landing.
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
import { land, landableBranch, landingOf, LAND_INTENT, readLanding, settleUnfinished, type LandAuthority } from "../../src/local-landing.js";
import { recordActionWhole } from "../../src/action-ledger.js";
import { run as execRun } from "../../src/exec.js";
import type { Runner } from "../../src/backend.js";
import { EXIT, runOperate } from "../../src/operate.js";
import { savePublishing } from "../../src/pull-request-flow.js";

const NOW = new Date("2026-11-25T12:00:00.000Z");
const scratch = useScratch("land");
let store: Store, repo = "", root = "", who: VerifiedApprover, person: LandAuthority, markers = "";
const access = () => ({ repos: [repo] });
const options = (extra: { git?: Runner } = {}) => ({ root, scratch: scratch(), ...extra });
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
  git(repo, "checkout", "-q", "main");
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
async function landNow(id: string, extra: { git?: Runner; into?: string; undo?: boolean; authority?: LandAuthority } = {}) {
  const read = await readLanding(store, id, access(), NOW, { ...options(extra), ...(extra.into === undefined ? {} : { into: extra.into }), ...(extra.undo ? { undo: true } : {}) });
  if (!read.ok || !("plan" in read)) return { read, landed: null };
  const landed = await land(store, id, { key: read.plan.key, ...(extra.into === undefined ? {} : { into: extra.into }), ...(extra.undo ? { undo: true } : {}) }, extra.authority ?? person, access(), NOW, options(extra));
  return { read, landed };
}
const plain = (path: string) => readFileSync(path, "utf8");
const status = () => git(repo, "status", "--porcelain", "--untracked-files=all");

describe("land on main: the legitimate path", () => {
  test("a clean folder on main fast-forwards, files and all; the destination is recorded; the same yes again writes nothing", async () => {
    const { head } = built("t1", { "a.txt": "two\n", "b.txt": "new\n" });
    const read = await readLanding(store, "t1", access(), NOW, options());
    expect(read.ok && "plan" in read && read.plan).toMatchObject({ mode: "files", checks: "passed", ref: "refs/heads/main", recorded: false, candidate: head });
    const { landed } = await landNow("t1");
    expect(landed).toMatchObject({ ok: true, replayed: false, commit: head, mode: "files", warning: null });
    expect(at()).toBe(head);
    expect(plain(join(repo, "b.txt"))).toBe("new\n");
    expect(status()).toBe("");
    expect(landingOf(store, "t1")?.intent.commit).toBe(head);
    if (!read.ok || !("plan" in read)) throw new Error("plan");
    const again = await land(store, "t1", { key: read.plan.key }, person, access(), NOW, options());
    expect(again).toMatchObject({ ok: true, replayed: true });
    expect(await readLanding(store, "t1", access(), NOW, options())).toMatchObject({ ok: true, landed: { commit: head } });
  });

  test("no folder has the branch open: only the ref moves, the folder is untouched", async () => {
    const { head } = built("t2", { "a.txt": "two\n" });
    git(repo, "checkout", "-q", "-b", "elsewhere");
    // Nothing recorded yet, so the proposal is the branch the folder stands on: naming main is the person's choice.
    const { landed } = await landNow("t2", { into: "main" });
    expect(landed).toMatchObject({ ok: true, mode: "ref" });
    expect(at("main")).toBe(head);
    expect(plain(join(repo, "a.txt"))).toBe("one\n");
  });

  test("a project with no check command lands, saying no check ran; one whose checks didn't pass doesn't", async () => {
    store.clearVerifyCommand(repo, "alex", NOW);
    built("t3", { "a.txt": "two\n" }, { checked: false });
    const read = await readLanding(store, "t3", access(), NOW, options());
    expect(read.ok && "plan" in read && read.plan.checks).toBe("none");
    // A check command set after it was accepted: still complete (history), but it can't land until checks pass on it.
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

describe("attack: land into a folder or branch that isn't ready", () => {
  const refusals: Record<string, { setup: () => void; reason: string; into?: string }> = {
    "an unstaged change": { setup: () => writeFileSync(join(repo, "a.txt"), "mine\n"), reason: "dirty" },
    "a staged change": { setup: () => { writeFileSync(join(repo, "z.txt"), "mine\n"); git(repo, "add", "z.txt"); }, reason: "dirty" },
    "an untracked file": { setup: () => writeFileSync(join(repo, "notes.txt"), "mine\n"), reason: "dirty" },
    "a merge in progress": { setup: () => writeFileSync(join(repo, ".git", "MERGE_HEAD"), `${at()}\n`), reason: "dirty" },
    "a rebase in progress": { setup: () => mkdirSync(join(repo, ".git", "rebase-merge")), reason: "dirty" },
    "a sparse checkout": { setup: () => { mkdirSync(join(repo, ".git", "info"), { recursive: true }); writeFileSync(join(repo, ".git", "info", "sparse-checkout"), "/*\n"); }, reason: "unsupported" },
    "the branch checked out in another folder": { setup: () => { git(repo, "checkout", "-q", "-b", "elsewhere"); git(repo, "worktree", "add", "-q", join(scratch(), "other"), "main"); }, reason: "occupied", into: "main" },
    "main moved on since the work started": { setup: () => { write(join(repo, "c.txt"), "later\n"); git(repo, "add", "-A"); git(repo, "commit", "-qm", "later"); }, reason: "moved" },
    "a .git that is a link": { setup: () => { renameSync(join(repo, ".git"), join(scratch(), "real-git")); symlinkSync(join(scratch(), "real-git"), join(repo, ".git")); }, reason: "destination" },
  };
  for (const [name, row] of Object.entries(refusals)) {
    test(`${name}: refused, nothing changed`, async () => {
      built("t", { "a.txt": "two\n" });
      row.setup();
      const before = git(repo, "rev-parse", "refs/heads/main");
      const read = await readLanding(store, "t", access(), NOW, { ...options(), ...(row.into === undefined ? {} : { into: row.into }) });
      expect(read, name).toMatchObject({ ok: false, reason: row.reason });
      expect(git(repo, "rev-parse", "refs/heads/main"), name).toBe(before);
    });
  }

  test("main moved: the refusal gives the exact git command instead", async () => {
    const { head } = built("t", { "a.txt": "two\n" });
    write(join(repo, "c.txt"), "later\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "later");
    const read = await readLanding(store, "t", access(), NOW, options());
    expect(!read.ok && read.message).toContain(`merge ${head}`);
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
  test("hooks never run: a post-checkout, post-merge and reference-transaction hook stay silent while it lands", async () => {
    const { head } = built("t", { "a.txt": "two\n" });
    for (const hook of ["post-checkout", "post-merge", "reference-transaction", "pre-commit"]) {
      writeFileSync(join(repo, ".git", "hooks", hook), `#!/bin/sh\necho ran > '${join(markers, hook)}'\n`);
      chmodSync(join(repo, ".git", "hooks", hook), 0o755);
    }
    const { landed } = await landNow("t");
    expect(landed).toMatchObject({ ok: true, commit: head });
    for (const hook of ["post-checkout", "post-merge", "reference-transaction", "pre-commit"]) expect(existsSync(join(markers, hook)), hook).toBe(false);
  });

  const configs: Record<string, (path: string) => void> = {
    "a smudge filter": path => { git(repo, "config", "filter.evil.smudge", path); writeFileSync(join(repo, ".git", "info", "attributes"), "* filter=evil\n"); },
    "an fsmonitor": path => git(repo, "config", "core.fsmonitor", path),
    "an include": path => { writeFileSync(join(scratch(), "inc"), `[core]\n\tfsmonitor = ${path}\n`); git(repo, "config", "include.path", join(scratch(), "inc")); },
    "a hooks path": path => { mkdirSync(join(scratch(), "hooks")); writeFileSync(join(scratch(), "hooks", "post-checkout"), `#!/bin/sh\n${path}\n`); chmodSync(join(scratch(), "hooks", "post-checkout"), 0o755); git(repo, "config", "core.hooksPath", join(scratch(), "hooks")); },
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

  test("a tree that needs a Git filter (LFS) or holds a submodule is refused, never written unfiltered", async () => {
    built("t", { ".gitattributes": "*.bin filter=lfs diff=lfs merge=lfs -text\n", "x.bin": "pointer\n" });
    expect(await readLanding(store, "t", access(), NOW, options())).toMatchObject({ ok: false, reason: "unsupported" });
  });
});

describe("attack: races, replays and crashes", () => {
  /** A runner that does `before` once, right before the first git call naming `verb`. */
  const racing = (verb: string, before: () => void): Runner => {
    let done = false;
    return (file, args, opts) => {
      if (!done && args.includes(verb)) { done = true; before(); }
      return execRun(file, args, opts);
    };
  };

  test("the branch moves between the look and the swap: the swap refuses, the other commit stays", async () => {
    built("t", { "a.txt": "two\n" });
    const read = await readLanding(store, "t", access(), NOW, options());
    if (!read.ok || !("plan" in read)) throw new Error("plan");
    let other = "";
    const result = await land(store, "t", { key: read.plan.key }, person, access(), NOW, options({ git: racing("update-ref", () => {
      write(join(scratch(), "side.txt"), "x");
      other = git(repo, "commit-tree", `${at()}^{tree}`, "-p", at(), "-m", "someone else");
      git(repo, "update-ref", "refs/heads/main", other);
      git(repo, "reset", "-q", "--soft", other);
    }) }));
    expect(result).toMatchObject({ ok: false, reason: "moved" });
    expect(at()).toBe(other);
  });

  test("an editor writes the folder between the swap and the files: the branch is swapped back, the edit kept", async () => {
    built("t", { "a.txt": "two\n" });
    const before = at();
    const read = await readLanding(store, "t", access(), NOW, options());
    if (!read.ok || !("plan" in read)) throw new Error("plan");
    const result = await land(store, "t", { key: read.plan.key }, person, access(), NOW, options({ git: racing("read-tree", () => writeFileSync(join(repo, "a.txt"), "editor\n")) }));
    expect(result).toMatchObject({ ok: false, reason: "git" });
    expect(at()).toBe(before);
    expect(plain(join(repo, "a.txt"))).toBe("editor\n");
  });

  test("a stale yes (the folder changed since the look) refuses; nothing changed", async () => {
    built("t", { "a.txt": "two\n" });
    const read = await readLanding(store, "t", access(), NOW, options());
    if (!read.ok || !("plan" in read)) throw new Error("plan");
    git(repo, "checkout", "-q", "-b", "elsewhere");
    expect(await land(store, "t", { key: read.plan.key }, person, access(), NOW, options())).toMatchObject({ ok: false, reason: "stale" });
    expect(await land(store, "t", { key: "f".repeat(16) }, person, access(), NOW, options())).toMatchObject({ ok: false, reason: "stale" });
  });

  test("the local owner's act isn't in flight: refused at the moment of use", async () => {
    built("t", { "a.txt": "two\n" });
    const before = at();
    const { landed } = await landNow("t", { authority: { kind: "local" } });
    expect(landed).toMatchObject({ ok: false, reason: "authority" });
    expect(at()).toBe(before);
  });

  test("a crash after the swap, before the files: the next landing finishes the files and records it", async () => {
    const { head, base } = built("t", { "a.txt": "two\n" });
    git(repo, "update-ref", "refs/heads/main", head, base);
    const ref = store.lookupRef("t")!;
    const runId = store.runsFor(ref.id)[0]!.id;
    recordActionWhole(store.handle, { at: NOW.toISOString(), actor: "operator:alex", repo, taskId: "t", runId, action: LAND_INTENT, outcome: "pending", source: "request" },
      { v: 1, kind: "land", key: "0".repeat(16), ref: "refs/heads/main", old: base, commit: head, mode: "files" });
    await settleUnfinished(store, repo, NOW, options());
    expect(status()).toBe("");
    expect(plain(join(repo, "a.txt"))).toBe("two\n");
    expect(landingOf(store, "t")?.intent.commit).toBe(head);
  });

  test("a crash before the swap: settled as abandoned, nothing changed, and the next landing goes ahead", async () => {
    const { head, base } = built("t", { "a.txt": "two\n" });
    const runId = store.runsFor(store.lookupRef("t")!.id)[0]!.id;
    recordActionWhole(store.handle, { at: NOW.toISOString(), actor: "operator:alex", repo, taskId: "t", runId, action: LAND_INTENT, outcome: "pending", source: "request" },
      { v: 1, kind: "land", key: "0".repeat(16), ref: "refs/heads/main", old: base, commit: head, mode: "files" });
    const { landed } = await landNow("t");
    expect(landed).toMatchObject({ ok: true, commit: head });
  });
});

describe("undo: a new commit that reverts exactly what landed", () => {
  test("undo after later work keeps the later work", async () => {
    const { base } = built("t", { "a.txt": "two\n" });
    await landNow("t");
    write(join(repo, "c.txt"), "later\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "later");
    const later = at();
    const { landed } = await landNow("t", { undo: true });
    expect(landed).toMatchObject({ ok: true, kind: "undo", mode: "files" });
    expect(git(repo, "rev-parse", "HEAD^")).toBe(later);
    expect(plain(join(repo, "a.txt"))).toBe("one\n");
    expect(plain(join(repo, "c.txt"))).toBe("later\n");
    expect(git(repo, "rev-list", "--count", `${base}..HEAD`)).toBe("3");
    expect(landingOf(store, "t")?.undone).toBe(true);
    expect(await readLanding(store, "t", access(), NOW, { ...options(), undo: true })).toMatchObject({ ok: false, reason: "nothing" });
  });

  test("undo that conflicts with later work refuses with the git command; main unchanged", async () => {
    built("t", { "a.txt": "two\n" });
    await landNow("t");
    write(join(repo, "a.txt"), "three\n");
    git(repo, "commit", "-qam", "later");
    const later = at();
    const { landed } = await landNow("t", { undo: true });
    expect(landed).toMatchObject({ ok: false, reason: "moved" });
    expect(!landed!.ok && landed!.message).toContain("revert");
    expect(at()).toBe(later);
    expect(status()).toBe("");
  });
});

describe("the command", () => {
  test("bare shows what lands and its key; --yes --key lands it with a password; a missing key refuses", async () => {
    const { head } = built("t", { "a.txt": "two\n" });
    const lines: string[] = [];
    const cli = (argv: string[]) => { lines.length = 0; return runOperate("task", argv, line => lines.push(line), { databaseFile: join(scratch(), "orders.db"), now: NOW }); };
    store.close();
    expect(await cli(["land", "t"])).toBe(EXIT.ok);
    const key = /--key ([0-9a-f]{16})/.exec(lines.join("\n"))?.[1];
    expect(lines.join("\n")).toContain(`Land ${head.slice(0, 7)} on main`);
    expect(await cli(["land", "t", "--yes", "--as", "alex", "--token", password])).toBe(EXIT.usage);
    expect(await cli(["land", "t", "--yes", "--key", key!, "--as", "alex", "--token", password]), lines.join("\n")).toBe(EXIT.ok);
    expect(git(repo, "rev-parse", "main")).toBe(head);
    store = openStore(join(scratch(), "orders.db"));
  });
});

describe("attack: land around a project's pull requests", () => {
  const publishOn = () => savePublishing(store, { repo, githubRepo: "alex/shop", remote: "origin", base: "main", account: "alex" }, "alex", {}, NOW);

  test("pull requests on: the look, a yes read before they were set up, and the command all refuse; main unchanged", async () => {
    built("t", { "a.txt": "two\n" });
    const before = at();
    const read = await readLanding(store, "t", access(), NOW, options());
    if (!read.ok || !("plan" in read)) throw new Error("plan");
    publishOn();
    expect(await readLanding(store, "t", access(), NOW, options())).toMatchObject({ ok: false, reason: "pull-requests" });
    expect(await land(store, "t", { key: read.plan.key }, person, access(), NOW, options())).toMatchObject({ ok: false, reason: "pull-requests" });
    expect(at()).toBe(before);
  });

  test("pull requests set up after it landed: undo refuses too; main unchanged", async () => {
    built("t", { "a.txt": "two\n" });
    await landNow("t");
    const landed = at();
    publishOn();
    expect(await readLanding(store, "t", access(), NOW, { ...options(), undo: true })).toMatchObject({ ok: false, reason: "pull-requests" });
    expect(await land(store, "t", { key: "0".repeat(16), undo: true }, person, access(), NOW, options())).toMatchObject({ ok: false, reason: "pull-requests" });
    expect(at()).toBe(landed);
  });

  test("pull requests set up while it lands: refused before anything moves", async () => {
    built("t", { "a.txt": "two\n" });
    const before = at();
    const read = await readLanding(store, "t", access(), NOW, options());
    if (!read.ok || !("plan" in read)) throw new Error("plan");
    let done = false;
    const racing: Runner = (file, args, opts) => { if (!done && args.includes("status")) { done = true; publishOn(); } return execRun(file, args, opts); };
    expect(await land(store, "t", { key: read.plan.key }, person, access(), NOW, options({ git: racing }))).toMatchObject({ ok: false, reason: "pull-requests" });
    expect(at()).toBe(before);
  });
});
