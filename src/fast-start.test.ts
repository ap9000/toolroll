/**
 * P2.4 must-refuse rules, against the real store, a real git repository and approve()'s own proofs: only a person's
 * surfaces reach Build; every plan that wouldn't be small and password-free takes the ordinary road; a changed proposal
 * refuses; a first dispatch past the window refuses; and completion, publication and merge all read one verified measure.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover, approve, approvalOf, propose } from "./scope.js";
import { withActor } from "./actor.js";
import { register } from "./runner.js";
import { scopeApprovedForDispatch } from "./dispatch.js";
import { installFilingSizer, type Sizer } from "./task-sizing.js";
import { chatStartPreview, consumeChatStartPreview, expireFastStarts, fastAcceptance, fastChangeProblem, fastCompletionProblem, fastPublishProblem, fastStartBuild, fastStartOn, fastStartRules, fastStarted, FAST_MAX_LINES, FAST_START_RULE, FAST_WINDOW_MS, GREW_WORDS, keepGrownChange, prepareChatStart, prepareFastStart, setFastStart, verifiedChange, type FastApprove, type FastVia, type PasswordFacts } from "./fast-start.js";
import { cardTermsDigest, scopeTermsText } from "./chat-terms.js";
import { fileTaskProposal } from "./proposal.js";
import { withRemote, type RemoteRun } from "./remote-run.js";
import { RELEASE_CI_HELD_ACTION } from "./release-ci-hold.js";
import type { ChatApprovalLimits } from "./chat-approval.js";
import { storeEvidence } from "./evidence.js";
import { COMPLETION_ACTION, COMPLETION_BY_PERSON } from "./result-completion.js";

const NOW = new Date("2026-11-06T12:00:00.000Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);
const SMALL: Sizer = async () => ({ size: "small", risky: false, reason: "one word" });
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();

let dir: string, REPO: string, BASE: string, root: string, password: string;
let store: Store;
let dropSizer: () => void;
const FACTS: PasswordFacts = { passwordless: true, localOwner: false, freshAt: null, returnTo: "/" };

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-fast-")));
  REPO = join(dir, "shop");
  mkdirSync(REPO);
  git(REPO, "init", "-q", "-b", "main");
  writeFileSync(join(REPO, "footer.txt"), "hello\n");
  git(REPO, "add", ".");
  git(REPO, "commit", "-q", "-m", "first");
  BASE = git(REPO, "rev-parse", "HEAD");
  root = join(dir, "evidence");
  store = openStore(join(dir, "orders.db"));
  const owner = addApprover(store, "owner", NOW);
  if (!owner.ok) throw new Error("no owner");
  password = owner.token;
  for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "owner", NOW);
  store.upsertProject(REPO, "shop", NOW);
  register(store, { name: "worker", host: "fixture", capacity: 4, repos: [REPO], now: NOW, newToken: () => "tok" });
  dropSizer = installFilingSizer(SMALL);
});
afterEach(() => { dropSizer(); store.close(); rmSync(dir, { recursive: true, force: true }); });

const prepare = (title = "Fix the typo in the footer", extra: Partial<Parameters<typeof prepareFastStart>[1]> = {}, via: FastVia = "console") =>
  prepareFastStart(store, { actor: "owner", repo: REPO, title, via, password: FACTS, ...extra }, NOW);
const press = (preview: string, digest: string, at = NOW, via: FastVia = "console") => fastStartBuild(store, { preview, digest, actor: "owner", via, password: FACTS,
  approveNow: (taskId, saw, fast) => approve(store, taskId, "owner", at, saw, password, {}, fast) }, at);
async function started(title?: string): Promise<{ taskId: string; ref: number }> {
  const shown = await prepare(title);
  if (!shown.eligible) throw new Error(shown.reason);
  const built = press(shown.preview, shown.digest);
  if (!built.ok) throw new Error(built.message);
  return { taskId: built.taskId, ref: store.lookupRef(built.taskId)!.id };
}

describe("Build is a person's approval of exactly the terms shown", () => {
  test("files and approves in one step, on the ordinary person basis, with its marker", async () => {
    const { taskId, ref } = await started();
    const scope = store.getScope(taskId)!;
    expect(scope.approvalBasis).toBe("password");
    expect(approvalOf(scope).approved).toBe(true);
    expect(scopeApprovedForDispatch(store, ref, NOW)).toBe(true);
    const proof = store.handle.prepare("SELECT outcome, detail FROM action_ledger WHERE task_id = ? AND action = 'approval proved'").get(taskId);
    expect(JSON.parse(String(proof?.["detail"]))).toMatchObject({ v: 1, digest: scope.digest, fastStart: { rule: "small-v1", at: NOW.toISOString() } });
    expect(fastStarted(store, taskId)).toBe(true);
  });

  test("a preview writes no task", async () => {
    await prepare();
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM task").get()?.["n"]).toBe(0);
  });

  test("a form is used once, by the person it was shown to", async () => {
    const shown = await prepare();
    if (!shown.eligible) throw new Error(shown.reason);
    expect(fastStartBuild(store, { preview: shown.preview, digest: shown.digest, actor: "someone", via: "console", password: FACTS, approveNow: () => { throw new Error("never"); } }, NOW)).toMatchObject({ ok: false, reason: "gone" });
    expect(press(shown.preview, shown.digest).ok).toBe(true);
    expect(press(shown.preview, shown.digest)).toMatchObject({ ok: false, reason: "gone" });
  });

  test("terms: a digest that differs at the seal refuses, and nothing is left behind", async () => {
    const shown = await prepare();
    if (!shown.eligible) throw new Error(shown.reason);
    expect(press(shown.preview, "0".repeat(64))).toMatchObject({ ok: false, reason: "changed" });
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM task").get()?.["n"]).toBe(0);
    // The agents configured changed between the render and the press: the proposal changed, so the same digest refuses.
    store.setPhaseConfig("installation", "build", "claude", "opus", "owner", NOW);
    expect(press(shown.preview, shown.digest)).toMatchObject({ ok: false, reason: "changed" });
  });
});

describe("callers", () => {
  test("the lead's token and a remote run are refused in the writer and the preview", async () => {
    const shown = await prepare();
    if (!shown.eligible) throw new Error(shown.reason);
    await withActor({ account: "owner", lead: true }, async () => {
      expect(press(shown.preview, shown.digest)).toMatchObject({ ok: false, reason: "machine" });
      expect(await prepare()).toEqual({ eligible: false, reason: "machine" });
    });
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM task").get()?.["n"]).toBe(0);
  });

  test("a form shown on one surface can't be pressed from another", async () => {
    const shown = await prepare();
    if (!shown.eligible) throw new Error(shown.reason);
    expect(press(shown.preview, shown.digest, NOW, "cli")).toMatchObject({ ok: false, reason: "gone" });
  });

  test("a viewer isn't an approver", async () => {
    store.handle.prepare("INSERT INTO approver (name, credential_hash, added_at, generation, role) VALUES ('watcher', 'x', ?, 1, 'viewer')").run(NOW.toISOString());
    expect(await prepare("Fix it", { actor: "watcher" })).toMatchObject({ eligible: false });
  });
});

describe("plans that take the ordinary road", () => {
  const refused = async (reason: string, title?: string, extra: Partial<Parameters<typeof prepareFastStart>[1]> = {}) => expect(await prepare(title, extra)).toEqual({ eligible: false, reason });

  test("heuristic medium: a long description, or structural work", async () => {
    await refused("size", "Refactor the checkout");
    await refused("size", `Fix ${"the footer ".repeat(40)}`);
  });
  test("the classifier: silent, risky or medium", async () => {
    dropSizer();
    await refused("classifier");
    dropSizer = installFilingSizer(async () => null);
    await refused("classifier");
    dropSizer();
    dropSizer = installFilingSizer(async () => ({ size: "small", risky: true, reason: "sign-in" }));
    await refused("size");
    dropSizer();
    dropSizer = installFilingSizer(async () => ({ size: "medium", risky: false, reason: "a few files" }));
    await refused("size");
  });
  test("the setting off", async () => {
    expect(setFastStart(store, REPO, false, "owner", NOW)).toBe(true);
    await refused("setting");
    expect(store.handle.prepare("SELECT outcome FROM action_ledger WHERE action = 'small tasks start right away'").get()?.["outcome"]).toBe("off");
  });
  test("the default: on for one approver, off once there are more, a project's choice over both", () => {
    expect(fastStartOn(store, REPO)).toBe(true);
    store.handle.prepare("INSERT INTO approver (name, credential_hash, added_at, generation, role) VALUES ('sam', 'x', ?, 1, 'approver')").run(NOW.toISOString());
    expect(fastStartOn(store, REPO)).toBe(false);
    setFastStart(store, REPO, true, "owner", NOW);
    expect(fastStartOn(store, REPO)).toBe(true);
  });
  test("a requester rule, a two-person project, protected paths with none declared", async () => {
    store.setApprovalRules(REPO, { notRequester: true, protectProject: false, protectedPaths: [] }, "owner", NOW);
    await refused("rules");
    store.setApprovalRules(REPO, { notRequester: false, protectProject: true, protectedPaths: [] }, "owner", NOW);
    await refused("protected");
    store.setApprovalRules(REPO, { notRequester: false, protectProject: false, protectedPaths: ["secrets/"] }, "owner", NOW);
    await refused("protected");
  });
  test("anything that needs a typed password: an escalated plan, wider check access, no standing proof", async () => {
    await refused("password", undefined, { permissionMode: "bypassPermissions" });
    await refused("password", undefined, { password: { ...FACTS, passwordless: false } });
    store.setProjectCheckAccess(REPO, "unsandboxed", "owner", NOW, { may: "widen" });
    await refused("password");
  });
  test("the monthly limit reached", async () => {
    const held = vi.spyOn(store, "budgetGate").mockReturnValue((() => ({ over: { scope: "installation" } })) as never);
    await refused("monthly");
    held.mockRestore();
  });
  test("a mode that auto-approves filings comes first", async () => {
    store.handle.prepare("INSERT INTO operating_mode (repo, name, terms_json, digest, signed_by, signed_at, absolute_expiry) VALUES (?, 'hands-off', ?, 'd', 'owner', ?, ?)").run(REPO, JSON.stringify({ autoApproveFiling: true }), NOW.toISOString(), later(86_400_000).toISOString());
    await refused("mode");
  });
});

describe("the start window", () => {
  test("a first dispatch after 30 minutes refuses, and the sweep clears the seal in a logged transaction", async () => {
    const { taskId, ref } = await started();
    expect(scopeApprovedForDispatch(store, ref, later(FAST_WINDOW_MS - 1))).toBe(true);
    expect(scopeApprovedForDispatch(store, ref, later(FAST_WINDOW_MS))).toBe(false);
    expect(expireFastStarts(store, later(FAST_WINDOW_MS + 1))).toBe(1);
    expect(approvalOf(store.getScope(taskId)).approved).toBe(false);
    expect(store.handle.prepare("SELECT outcome FROM action_ledger WHERE task_id = ? AND action = 'fast start expired'").get(taskId)?.["outcome"]).toBe("seal cleared");
    expect(expireFastStarts(store, later(FAST_WINDOW_MS + 2))).toBe(0);
  });

  test("the ordinary Approve plan then stands on its own, and the marker's backstop stays", async () => {
    const { taskId, ref } = await started();
    expireFastStarts(store, later(FAST_WINDOW_MS + 1));
    const approved = approve(store, taskId, "owner", later(FAST_WINDOW_MS + 2), store.getScope(taskId)!.digest, password);
    expect(approved.ok).toBe(true);
    expect(scopeApprovedForDispatch(store, ref, later(FAST_WINDOW_MS + 3))).toBe(true);
    expect(fastStarted(store, taskId)).toBe(true);
  });

  test("a person's Retry is a new person act; a machine's isn't", async () => {
    const { taskId, ref } = await started();
    store.setTaskState(taskId, "failed", later(1));
    const retried = later(FAST_WINDOW_MS + 60_000);
    await withActor({ account: "owner", lead: true }, async () => { expect(store.requeueTask(taskId, "owner", retried).ok).toBe(true); });
    expect(scopeApprovedForDispatch(store, ref, retried)).toBe(false);
    store.setTaskState(taskId, "failed", retried);
    expect(store.requeueTask(taskId, "owner", retried).ok).toBe(true);
    expect(scopeApprovedForDispatch(store, ref, retried)).toBe(true);
  });

  test("a seal the marker can't vouch for doesn't dispatch: a `chat` basis written without a chat fast-start proof", async () => {
    const { taskId, ref } = await started();
    store.handle.prepare("UPDATE task_scope SET approval_basis = 'chat' WHERE task_id = ?").run(taskId);
    expect(scopeApprovedForDispatch(store, ref, later(1))).toBe(false);
  });
});

describe("the Accept backstop", () => {
  /** A finished build of the task: the change is committed to a branch, and Toolroll's records name base and head. */
  function built(taskId: string, ref: number, change: () => void, options: { diff?: boolean; staged?: () => void } = {}): number {
    git(REPO, "checkout", "-q", "-B", taskId, BASE);
    change();
    git(REPO, "add", "-A");
    options.staged?.();
    git(REPO, "commit", "-q", "-m", "work", "--allow-empty");
    const head = git(REPO, "rev-parse", "HEAD");
    git(REPO, "checkout", "-q", "main");
    const authority = store.routeAuthorityFor(ref, "builder");
    if (!authority?.ok) throw new Error("route");
    const run = store.startRun({ taskRef: ref, leaseId: `l-${taskId}`, runner: "worker", branch: taskId, worktree: REPO, route: authority.stamp, now: NOW });
    store.stampRun(run, { scopeDigest: store.getScope(taskId)!.digest, baseRevision: BASE });
    store.recordOutcomeFacts(run, { headRevision: head, handoff: "Done." });
    store.finishRun(run, { outcome: "built", committed: true, now: NOW });
    if (options.diff !== false) storeEvidence(store, root, run, "diff-stat", "diff-stat.json", Buffer.from("{}"), "git diff", NOW, { captureStatus: "ok" });
    store.setTaskState(taskId, "done", NOW);
    return run;
  }
  const lines = (count: number) => Array.from({ length: count }, (_, one) => `line ${one}\n`).join("");
  const accepted = (run: number, taskId: string) => store.recordAction({ at: NOW.toISOString(), actor: "operator:owner", repo: REPO, taskId, runId: run, action: COMPLETION_ACTION, outcome: "d", source: "work", detail: COMPLETION_BY_PERSON });

  test("a small change: counted from Toolroll's records, and a person may accept it", async () => {
    const { taskId, ref } = await started();
    const run = built(taskId, ref, () => writeFileSync(join(REPO, "footer.txt"), "hullo\n"));
    expect(verifiedChange(store, taskId, run)).toMatchObject({ ok: true, base: BASE, lines: 2, files: [{ path: "footer.txt", added: 1, removed: 1 }] });
    expect(fastCompletionProblem(store, taskId, run, "owner")).toBeNull();
  });

  test("a machine completion refuses, whatever the change", async () => {
    const { taskId, ref } = await started();
    const run = built(taskId, ref, () => writeFileSync(join(REPO, "footer.txt"), "hullo\n"));
    expect(fastCompletionProblem(store, taskId, run, null)).toBe("A person accepts this one.");
  });

  test("publication and merge wait for a person's Accept of this exact build", async () => {
    const { taskId, ref } = await started();
    const run = built(taskId, ref, () => writeFileSync(join(REPO, "footer.txt"), "hullo\n"));
    expect(fastPublishProblem(store, taskId, run)).toBe("It waits for a person to accept it.");
    accepted(run, taskId);
    expect(fastPublishProblem(store, taskId, run)).toBeNull();
  });

  const over: [string, () => void][] = [
    ["too many lines", () => writeFileSync(join(REPO, "big.txt"), lines(FAST_MAX_LINES + 1))],
    ["too many files", () => { for (const one of ["a", "b", "c", "d"]) writeFileSync(join(REPO, `${one}.txt`), "x\n"); }],
    ["a lockfile", () => writeFileSync(join(REPO, "package-lock.json"), "{}\n")],
    ["a dependency file", () => writeFileSync(join(REPO, "package.json"), "{}\n")],
    ["a migration", () => { mkdirSync(join(REPO, "db", "migrate"), { recursive: true }); writeFileSync(join(REPO, "db", "migrate", "1.sql"), "x\n"); }],
    ["a schema file", () => writeFileSync(join(REPO, "schema.prisma"), "x\n")],
    ["a binary", () => writeFileSync(join(REPO, "logo.png"), Buffer.from([0, 1, 2, 0, 255]))],
    ["a symlink", () => execFileSync("ln", ["-s", "footer.txt", join(REPO, "link")])],
  ];
  test.each(over)("%s refuses through completion, publication and merge alike", async (_name, change) => {
    const { taskId, ref } = await started();
    const run = built(taskId, ref, change);
    accepted(run, taskId);
    expect(fastCompletionProblem(store, taskId, run, "owner")).toBe(GREW_WORDS);
    expect(fastPublishProblem(store, taskId, run)).toBe(GREW_WORDS);
  });

  test("a submodule can't hide from the count", async () => {
    const { taskId, ref } = await started();
    const run = built(taskId, ref, () => {}, { staged: () => { git(REPO, "update-index", "--add", "--cacheinfo", `160000,${BASE},vendored`); } });
    expect(verifiedChange(store, taskId, run)).toMatchObject({ ok: false });
    expect(fastChangeProblem(store, taskId, run)).toBe(GREW_WORDS);
  });

  test("a protected path refuses, though the plan declared none", async () => {
    const { taskId, ref } = await started();
    const run = built(taskId, ref, () => writeFileSync(join(REPO, "footer.txt"), "hullo\n"));
    store.setApprovalRules(REPO, { notRequester: false, protectProject: false, protectedPaths: ["footer.txt"] }, "owner", NOW);
    expect(fastChangeProblem(store, taskId, run)).toBe(GREW_WORDS);
  });

  test("an ancestry problem, a missing diff or an unreadable base refuses", async () => {
    const { taskId, ref } = await started();
    const run = built(taskId, ref, () => writeFileSync(join(REPO, "footer.txt"), "hullo\n"), { diff: false });
    expect(verifiedChange(store, taskId, run)).toEqual({ ok: false, problem: `Build #${run} has no saved diff.` });
    expect(fastChangeProblem(store, taskId, run)).toBe(GREW_WORDS);
    store.handle.prepare("UPDATE run SET base_revision = NULL").run();
    expect(verifiedChange(store, taskId, run)).toMatchObject({ ok: false });
  });

  test("the base is the one on record, never the checkout's", async () => {
    const { taskId, ref } = await started();
    const run = built(taskId, ref, () => writeFileSync(join(REPO, "big.txt"), lines(FAST_MAX_LINES + 1)));
    // Moving the checkout's main up to the build's head changes nothing about what the build changed.
    git(REPO, "merge", "-q", "--ff-only", taskId);
    expect(fastChangeProblem(store, taskId, run)).toBe(GREW_WORDS);
  });

  test("approving the expanded commit keeps it; a commit other than the approved one doesn't", async () => {
    const { taskId, ref } = await started();
    const run = built(taskId, ref, () => writeFileSync(join(REPO, "big.txt"), lines(FAST_MAX_LINES + 1)));
    const kept = keepGrownChange(store, taskId, later(1));
    expect(kept.ok).toBe(true);
    if (!kept.ok) return;
    expect(store.getScope(taskId)?.candidate).toBe(store.getRun(run)?.headRevision);
    // Not yet approved, and the run was made under the earlier plan: it still refuses.
    expect(fastChangeProblem(store, taskId, run)).toBe(GREW_WORDS);
    expect(approve(store, taskId, "owner", later(2), kept.digest, password).ok).toBe(true);
    // The machine's own attempt on that exact commit, under the approved plan, is the result that goes on.
    const authority = store.routeAuthorityFor(ref, "builder");
    if (!authority?.ok) throw new Error("route");
    store.setTaskState(taskId, "running", later(3));
    const check = store.startRun({ taskRef: ref, leaseId: `l2-${taskId}`, runner: "worker", branch: taskId, worktree: REPO, route: authority.stamp, now: later(3) });
    store.stampRun(check, { scopeDigest: store.getScope(taskId)!.digest, baseRevision: BASE });
    store.recordOutcomeFacts(check, { headRevision: store.getRun(run)!.headRevision!, handoff: "Checked." });
    store.finishRun(check, { outcome: "built", committed: true, now: later(3) });
    expect(fastChangeProblem(store, taskId, check)).toBeNull();
    // A stale approval: the head moved past the commit it named.
    store.handle.prepare("UPDATE run SET head_revision = ? WHERE id = ?").run("9".repeat(40), check);
    expect(fastChangeProblem(store, taskId, check)).toBe(GREW_WORDS);
  });

  test("a change that stayed small has nothing to keep", async () => {
    const { taskId, ref } = await started();
    built(taskId, ref, () => writeFileSync(join(REPO, "footer.txt"), "hullo\n"));
    expect(keepGrownChange(store, taskId, later(1))).toMatchObject({ ok: false });
  });
});

describe("exclusions", () => {
  test("no automatic release seal and no release terms ever land on a fast start", async () => {
    const { taskId } = await started();
    store.handle.prepare("UPDATE task_scope SET approved_at = NULL, approved_digest = NULL WHERE task_id = ?").run(taskId);
    expect(store.sealScopeApproval(taskId, "owner", NOW, {}, { kind: "auto-check", modeDigest: "1" })).toBe(false);
    expect(store.sealScopeApproval(taskId, "owner", NOW, {}, { kind: "auto-green", modeDigest: "1" })).toBe(false);
  });

  test("an ordinary filing is never marked: `task add`'s road doesn't come here", () => {
    store.createTask({ id: "plain", title: "plain" }, NOW);
    store.placeTask(store.refFor("built-in", "plain").id, REPO, {}, NOW);
    const scope = propose(store, { taskId: "plain", goal: "plain", touches: [], acceptance: [{ id: "c1", statement: "ok", how: null, evidence: ["manual-review"] }], now: NOW });
    expect(approve(store, "plain", "owner", NOW, scope.digest, password).ok).toBe(true);
    expect(fastStarted(store, "plain")).toBe(false);
    expect(fastCompletionProblem(store, "plain", 1, null)).toBeNull();
  });
});

// ---- one-step start from chat (docs/plans/one-step-chat.md C1) --------------------------------------------------------

const TURN = 7;
const OPEN: ChatApprovalLimits = { fullAccess: true, capMicrousd: null };
const remote = (account: string): RemoteRun => ({ account, scope: "act", tokenName: "laptop", source: "api", secret: "s", allows: () => true, lens: null, noteTask: () => {}, files: {} });
const chatPrepare = (title = "Fix the typo in the footer", turn = TURN) => prepareChatStart(store, { actor: "owner", repo: REPO, title, turn }, NOW);
/** The chat road's own approve: the person's yes from chat, with the card's whole terms and their digest. */
const chatApprove = (at: Date): FastApprove => (taskId, saw, fast) => {
  const terms = scopeTermsText(store.getScope(taskId)!);
  return approve(store, taskId, "owner", at, saw, "", {}, fast, { modeDigest: "chat-setting", shown: { expect: cardTermsDigest(terms), terms } });
};
const chatPress = (preview: string, digest: string, options: { at?: Date; turn?: number; limits?: ChatApprovalLimits; via?: FastVia } = {}) =>
  fastStartBuild(store, { preview, digest, actor: "owner", via: options.via ?? "chat", turn: options.turn ?? TURN, proof: { chat: options.limits ?? OPEN }, approveNow: chatApprove(options.at ?? NOW) }, options.at ?? NOW);
async function chatStarted(): Promise<{ taskId: string; ref: number }> {
  const shown = await chatPrepare();
  if (!shown.eligible) throw new Error(shown.reason);
  const built = chatPress(shown.preview, shown.digest);
  if (!built.ok) throw new Error(built.message);
  return { taskId: built.taskId, ref: store.lookupRef(built.taskId)!.id };
}
const count = (table: string) => Number(store.handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.["n"]);

describe("a chat start", () => {
  test("files the lead's words as the lead's, approves on the chat basis with its marker, and dispatches only inside the window", async () => {
    const { taskId, ref } = await chatStarted();
    const scope = store.getScope(taskId)!;
    expect(scope.approvalBasis).toBe("chat");
    expect(store.handle.prepare("SELECT proposed_via FROM task_scope WHERE task_id = ?").get(taskId)?.["proposed_via"]).toBe("mate");
    expect(store.handle.prepare("SELECT filed_via FROM task_ref WHERE external_id = ?").get(taskId)?.["filed_via"]).toBe("chat");
    const proof = store.handle.prepare("SELECT outcome, detail FROM action_ledger WHERE task_id = ? AND action = 'approval proved'").get(taskId);
    expect(proof?.["outcome"]).toBe("chat");
    expect(JSON.parse(String(proof?.["detail"]))).toMatchObject({ v: 1, digest: scope.digest, at: NOW.toISOString(), fastStart: { rule: FAST_START_RULE, at: NOW.toISOString() } });
    expect(scopeApprovedForDispatch(store, ref, later(FAST_WINDOW_MS - 1))).toBe(true);
    expect(scopeApprovedForDispatch(store, ref, later(FAST_WINDOW_MS))).toBe(false);
  });

  test("a password-basis fast start still dispatches as today", async () => {
    const { ref } = await started();
    expect(scopeApprovedForDispatch(store, ref, later(1))).toBe(true);
  });

  test("a preview is bound to its surface and its turn: chat can't be built as console, console can't be built as chat", async () => {
    const chat = await chatPrepare();
    const form = await prepare();
    if (!chat.eligible || !form.eligible) throw new Error("not eligible");
    expect(press(chat.preview, chat.digest)).toMatchObject({ ok: false, reason: "gone" });
    expect(chatPress(form.preview, form.digest)).toMatchObject({ ok: false, reason: "gone" });
    // The chat proof is a chat start's alone.
    expect(chatPress(form.preview, form.digest, { via: "console" })).toMatchObject({ ok: false, reason: "rules" });
    // Another turn's card, or no turn at all, is nobody's card.
    expect(chatPress(chat.preview, chat.digest, { turn: TURN + 1 })).toMatchObject({ ok: false, reason: "gone" });
    expect(fastStartBuild(store, { preview: chat.preview, digest: chat.digest, actor: "owner", via: "chat", proof: { chat: OPEN }, approveNow: chatApprove(NOW) }, NOW)).toMatchObject({ ok: false, reason: "gone" });
    store.handle.prepare("UPDATE fast_preview SET turn = NULL WHERE id = ?").run(chat.preview);
    expect(chatPress(chat.preview, chat.digest)).toMatchObject({ ok: false, reason: "gone" });
    expect(count("task")).toBe(0);
    // prepareFastStart is never the chat road.
    expect(await prepareFastStart(store, { actor: "owner", repo: REPO, title: "Fix it", via: "chat" as "console", password: FACTS }, NOW)).toEqual({ eligible: false, reason: "rules" });
  });

  test("the lead and a remote run may prepare a preview (it grants nothing) but are refused at Build", async () => {
    const asLead = await withActor({ account: "owner", lead: true }, () => chatPrepare());
    if (!asLead.eligible) throw new Error(asLead.reason);
    await withActor({ account: "owner", lead: true }, async () => { expect(chatPress(asLead.preview, asLead.digest)).toMatchObject({ ok: false, reason: "machine" }); });
    expect(withRemote(remote("owner"), () => chatPress(asLead.preview, asLead.digest))).toMatchObject({ ok: false, reason: "machine" });
    expect(count("task")).toBe(0);
    expect(store.handle.prepare("SELECT consumed_at FROM fast_preview WHERE id = ?").get(asLead.preview)?.["consumed_at"]).toBeNull();
  });

  test("the person's own chat limit refuses, and nothing is left behind", async () => {
    const shown = await chatPrepare();
    if (!shown.eligible) throw new Error(shown.reason);
    // The default plan has no attempt limit: a chat cap of $1 refuses it.
    expect(chatPress(shown.preview, shown.digest, { limits: { fullAccess: true, capMicrousd: 1_000_000 } })).toMatchObject({ ok: false, reason: "limit" });
    expect(count("task")).toBe(0);
    expect(chatPress(shown.preview, shown.digest).ok).toBe(true);
  });

  test("a refused build called inside an open transaction leaves no task, no scope and an unused preview", async () => {
    const shown = await chatPrepare();
    if (!shown.eligible) throw new Error(shown.reason);
    const inside = store.transact(() => chatPress(shown.preview, "0".repeat(64)));
    expect(inside).toMatchObject({ ok: false, reason: "changed" });
    expect(count("task")).toBe(0);
    expect(count("task_scope")).toBe(0);
    expect(store.handle.prepare("SELECT consumed_at FROM fast_preview WHERE id = ?").get(shown.preview)?.["consumed_at"]).toBeNull();
    // The form's road too.
    const form = await prepare();
    if (!form.eligible) throw new Error(form.reason);
    expect(store.transact(() => press(form.preview, "0".repeat(64)))).toMatchObject({ ok: false, reason: "changed" });
    expect(count("task")).toBe(0);
  });

  test("a preview is used once; a consumed one (a dismissed card) can't be used", async () => {
    const shown = await chatPrepare();
    if (!shown.eligible) throw new Error(shown.reason);
    expect(chatStartPreview(store, shown.preview, "owner", TURN, NOW)).not.toBeNull();
    expect(chatStartPreview(store, shown.preview, "someone", TURN, NOW)).toBeNull();
    expect(chatStartPreview(store, shown.preview, "owner", TURN + 1, NOW)).toBeNull();
    consumeChatStartPreview(store, shown.preview, NOW);
    expect(chatStartPreview(store, shown.preview, "owner", TURN, NOW)).toBeNull();
    expect(chatPress(shown.preview, shown.digest)).toMatchObject({ ok: false, reason: "gone" });
  });

  test("a chat preview without a turn is unusable", async () => {
    expect(await prepareChatStart(store, { actor: "owner", repo: REPO, title: "Fix it", turn: 0 }, NOW)).toEqual({ eligible: false, reason: "rules" });
  });
});

describe("the chat arm of the dispatch guard", () => {
  /** A seal moved to a fresh instant, standing on exactly the proof rows given (the ledger is insert-only). */
  function forge(taskId: string, rows: { actor?: string; at?: string; outcome?: string; detail: string }[]): string {
    const at = later(5_000).toISOString();
    store.handle.prepare("UPDATE task_scope SET approved_at = ? WHERE task_id = ?").run(at, taskId);
    for (const row of rows) store.recordAction({ at: row.at ?? at, actor: row.actor ?? "owner", repo: REPO, taskId, runId: null, action: "approval proved", outcome: row.outcome ?? "chat", source: "work", detail: row.detail });
    return at;
  }
  const at = later(5_000).toISOString();
  const proof = (digest: string, extra: Record<string, unknown> = {}) => JSON.stringify({ v: 1, at, generation: 1, digest, fastStart: { rule: FAST_START_RULE, at }, ...extra });
  /** A person's proof the person-seal rule accepts, with no fast marker. */
  const plain = (digest: string) => JSON.stringify({ v: 1, at, generation: 1, digest });

  test("one complete row stands (the harness works)", async () => {
    const { taskId, ref } = await chatStarted();
    const digest = store.getScope(taskId)!.digest;
    forge(taskId, [{ detail: proof(digest) }]);
    expect(scopeApprovedForDispatch(store, ref, later(6_000))).toBe(true);
  });

  const variants: [string, (digest: string) => { actor?: string; at?: string; outcome?: string; detail: string }[]][] = [
    ["another digest", digest => [{ detail: plain(digest) }, { detail: proof("f".repeat(64)) }]],
    ["another actor", digest => [{ detail: plain(digest) }, { actor: "sam", detail: proof(digest) }]],
    ["another instant (the row)", digest => [{ detail: plain(digest) }, { at: later(4_000).toISOString(), detail: proof(digest) }]],
    ["another instant (the detail)", digest => [{ detail: plain(digest) }, { detail: proof(digest, { at: later(4_000).toISOString() }) }]],
    ["another rule", digest => [{ detail: plain(digest) }, { detail: proof(digest, { fastStart: { rule: "small-v0", at } }) }]],
    ["the facts split across two rows", digest => [{ detail: plain(digest) }, { detail: JSON.stringify({ v: 1, at, generation: 1, fastStart: { rule: FAST_START_RULE, at } }) }]],
    ["a detail that isn't JSON", digest => [{ detail: `${at} · generation 1 · fastStart small-v1 · digest ${digest}` }]],
    ["a proof that isn't a chat tap", digest => [{ outcome: "password-now", detail: proof(digest) }]],
  ];
  test.each(variants)("refuses %s", async (_name, rows) => {
    const { taskId, ref } = await chatStarted();
    const digest = store.getScope(taskId)!.digest;
    forge(taskId, rows(digest));
    expect(scopeApprovedForDispatch(store, ref, later(6_000))).toBe(false);
  });
});

describe("plan refusals on the chat form", () => {
  const refusedOnChat = async (reason: string, title?: string) => expect(await chatPrepare(title)).toEqual({ eligible: false, reason });
  /** A task filed exactly as a chat start files it, read by the rules with the chat proof. */
  function filedForRules(change: (taskId: string) => void): ReturnType<typeof fastStartRules> {
    // Read in a savepoint that always rolls back, as a preview is: nothing stays filed.
    let answer: ReturnType<typeof fastStartRules> | null = null;
    const undo = new Error("undo");
    try { store.transact(() => store.savepoint(() => { answer = readRules(change); throw undo; })); } catch (error) { if (error !== undo) throw error; }
    return answer!;
  }
  function readRules(change: (taskId: string) => void): ReturnType<typeof fastStartRules> {
    const title = "Fix the typo in the footer";
    const sizing = { size: "small" as const, risky: false, source: "classifier" as const, reason: "one word" };
    const filed = fileTaskProposal(store, { id: "task-rules", title, repo: REPO, goal: title, acceptance: fastAcceptance(title), planning: "skip", sizing, filedVia: "chat", filedBy: { name: "owner", kind: "person" }, proposedVia: "mate" }, NOW);
    if (!filed.ok) throw new Error(filed.message);
    expect(fastStartRules(store, { actor: "owner", repo: REPO, title, taskId: "task-rules", sizing, proof: { chat: OPEN } }, NOW)).toMatchObject({ ok: true });
    change("task-rules");
    return fastStartRules(store, { actor: "owner", repo: REPO, title, taskId: "task-rules", sizing, proof: { chat: OPEN } }, NOW);
  }

  const table: [string, () => Promise<void>][] = [
    ["protected", async () => { store.setApprovalRules(REPO, { notRequester: false, protectProject: true, protectedPaths: [] }, "owner", NOW); await refusedOnChat("protected"); }],
    ["release", async () => {
      expect(filedForRules(taskId => store.recordAction({ at: NOW.toISOString(), actor: "system", repo: REPO, taskId, runId: null, action: RELEASE_CI_HELD_ACTION, outcome: "held", source: "work", detail: "a".repeat(40) }))).toEqual({ ok: false, reason: "release" });
    }],
    ["trial", async () => {
      expect(filedForRules(taskId => {
        const route = JSON.parse(String(store.getScope(taskId)!.proposedRouteJson)) as { version: number; legs: { phase: string; selection?: unknown }[] };
        route.version = 3;
        for (const leg of route.legs) if (leg.phase === "build") leg.selection = { kind: "trial", rule: 1, reservation: 1 };
        store.handle.prepare("UPDATE task_scope SET proposed_route_json = ? WHERE task_id = ?").run(JSON.stringify(route), taskId);
      })).toEqual({ ok: false, reason: "trial" });
    }],
    ["chain", async () => {
      expect(filedForRules(taskId => store.handle.prepare("UPDATE task_scope SET proposed_chain_json = '[]' WHERE task_id = ?").run(taskId))).toEqual({ ok: false, reason: "chain" });
    }],
    ["monthly", async () => {
      const held = vi.spyOn(store, "budgetGate").mockReturnValue((() => ({ over: { scope: "installation" } })) as never);
      await refusedOnChat("monthly");
      held.mockRestore();
    }],
    ["classifier silent", async () => { dropSizer(); dropSizer = installFilingSizer(async () => null); await refusedOnChat("classifier"); }],
    ["medium", async () => { dropSizer(); dropSizer = installFilingSizer(async () => ({ size: "medium", risky: false, reason: "a few files" })); await refusedOnChat("size"); await refusedOnChat("size", "Refactor the checkout"); }],
    ["auto-approve mode", async () => {
      store.handle.prepare("INSERT INTO operating_mode (repo, name, terms_json, digest, signed_by, signed_at, absolute_expiry) VALUES (?, 'hands-off', ?, 'd', 'owner', ?, ?)").run(REPO, JSON.stringify({ autoApproveFiling: true }), NOW.toISOString(), later(86_400_000).toISOString());
      await refusedOnChat("mode");
    }],
    ["escalated access", async () => { store.setProjectCheckAccess(REPO, "unsandboxed", "owner", NOW, { may: "widen" }); await refusedOnChat("password"); }],
  ];
  test.each(table)("%s takes the ordinary road", async (_name, check) => {
    await check();
    expect(count("task")).toBe(0);
  });
});
