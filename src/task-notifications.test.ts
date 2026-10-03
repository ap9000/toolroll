/**
 * Task lifecycle updates (Telegram task updates, 2026-09-16): the REAL
 * mutation producers — placement, approval, holds, stop/resume, run
 * admission, phases, endings, reviews, cancellation, requeue — recording
 * project-bound facts beside the change that made them true, then the
 * existing Telegram transport carrying them: two enrolled projects and one
 * excluded, order after a failed send and a restart, a rate limit, revoked
 * pairing, urgent-over-digest, and a pairing that starts from now instead
 * of replaying history. Nothing here enqueues the expected row by hand;
 * the one attention row the digest case needs is labelled as fixture.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLifecycleNotification, LIFECYCLE_KEY_PREFIX, openStore, type Notification, type Store } from "./store.js";
import { addApprover, approve, propose } from "./scope.js";
import { storeEvidence } from "./evidence.js";
import { sealVerificationReceipt } from "./verification-evidence.js";
import { verifyApproverStanding } from "./principal.js";
import { assignmentOf, checkAssignmentAsOperator } from "./assignment.js";
import { register } from "./runner.js";
import { adjudicate } from "./proof.js";
import { telegramProgressCard } from "./telegram-progress.js";
import { acquire } from "./claim.js";
import { presetTerms, modeTermsJson, modeDigestOf } from "./modes.js";
import { bridgePass, hashPairingCode, mintPairingCode, PAIRING_TTL_MS, type TelegramTransport } from "./telegram.js";

const T0 = new Date("2026-09-16T09:00:00.000Z");
const later = (ms: number) => new Date(T0.getTime() + ms);
const BOT = "777000";
const CHAT = 4242;
const USER = 31337;
const ALPHA = "/projects/alpha";
const BETA = "/projects/beta";
const EXCLUDED = "/projects/excluded";
const ORIGIN = "https://console.example";
const RUNNER = "worker-1";
const TOKEN = "tok-worker-1";

/** A task with no scope presents the bare word `legacy` for the pair it spends as. */
const bareLegacy = (phase: "build" | "plan" | "repair" | "review", provider = "claude", model: string | null = null) => ({
  route: { routeDigest: "legacy", phase, provider, model, chosen: "legacy" as const },
});

const RUBRIC = [{ id: "c1", statement: "The guard holds under load.", evidence: ["manual-review"] }];

function scriptedTransport() {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let nextMessageId = 100;
  let failNext: { ok: false; description: string; parameters?: { retry_after: number } } | null = null;
  const transport: TelegramTransport = async (method, params) => {
    calls.push({ method, params });
    if (method === "getUpdates") return { ok: true, result: [] };
    if (method === "sendMessage" || method === "sendDocument" || method === "editMessageText") {
      if (failNext !== null) {
        const answer = failNext;
        failNext = null;
        return answer;
      }
      return { ok: true, result: { message_id: method === "editMessageText" ? params["message_id"] : nextMessageId++ } };
    }
    return { ok: true, result: true };
  };
  const sends = () => calls.filter(call => call.method === "sendMessage");
  const texts = () => sends().map(call => String(call.params["text"]));
  const buttons = (call: { params: Record<string, unknown> }) =>
    ((call.params["reply_markup"] as { inline_keyboard?: { text: string; url?: string; callback_data?: string }[][] } | undefined)?.inline_keyboard ?? []).flat();
  return { transport, calls, sends, texts, buttons, fail: (answer: NonNullable<typeof failNext>) => { failNext = answer; } };
}

describe("lifecycle producers: the shared mutations record each fact once, atomically", () => {
  let store: Store;
  let now: Date;

  const life = (only: "pending" | "all" = "all"): Notification[] => store.listNotifications(only).filter(isLifecycleNotification);
  const keys = (only: "pending" | "all" = "all") => life(only).map(row => row.dedupeKey);
  const placed = (id: string, repo: string, title = id) => {
    store.createTask({ id, title }, now);
    const ref = store.refFor("built-in", id).id;
    store.placeTask(ref, repo, {}, now);
    return ref;
  };

  beforeEach(() => {
    store = openStore(":memory:");
    now = T0;
    expect(addApprover(store, "alex", now).ok).toBe(true);
    register(store, { name: RUNNER, host: "test", capacity: 4, repos: [ALPHA, BETA, EXCLUDED], now, newToken: () => TOKEN });
    for (const phase of ["build", "plan", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", now);
  });
  afterEach(() => {
    // Every fact's link is a machine-minted console control for ITS OWN task
    // (chat-controls.ts): the task lens, its details page, or one exact saved
    // result — so the phone's one button always opens an existing page and
    // never carries free text.
    for (const row of life()) {
      const id = encodeURIComponent(row.taskId ?? "");
      expect(row.link).toMatch(new RegExp(`^(?:/chat\\?task=${id}(?:&result=\\d+(?:&tab=(?:checks|changes))?|#task-chat-action)?|/t/${id}|/review\\?result=${id}&run=\\d+&tab=checks)$`));
    }
    store.close();
  });

  test("filing speaks once the project is known, through every filing door that places", () => {
    store.createTask({ id: "bare", title: "An unplaced idea" }, now);
    expect(life()).toHaveLength(0);
    const bare = store.refFor("built-in", "bare").id;
    expect(store.placeTask(bare, ALPHA, {}, now)).toBe(true);
    expect(life()).toMatchObject([{ kind: "task-filed", scope: "task", project: ALPHA, taskId: "bare", run: null, pushClass: null, link: "/chat?task=bare", subject: "New task: An unplaced idea", body: "Filed and waiting in the queue." }]);
    // The same placement again, and a move, are not another filing.
    store.placeTask(bare, ALPHA, {}, now);
    store.placeTask(bare, BETA, {}, now);
    expect(keys()).toEqual([`${LIFECYCLE_KEY_PREFIX}task-filed:t${bare}:1`]);
    // The console door files, places and scopes in one transaction; the fact
    // rides that transaction with the title scrubbed like every phone string.
    const filed = store.createConsoleTask({ id: "alpha-1", title: "Guard the payout path at /Users/alex/repo/src", repo: ALPHA, goal: "Guard it", acceptance: RUBRIC }, now);
    expect(filed).toMatchObject({ ok: true });
    expect(life().at(-1)).toMatchObject({ kind: "task-filed", project: ALPHA, taskId: "alpha-1", subject: "New task: Guard the payout path at [path]" });
    // A replayed idempotent placement returns the recorded answer and records nothing again.
    store.createTask({ id: "keyed", title: "keyed" }, now);
    const keyed = store.refFor("built-in", "keyed").id;
    store.placeTask(keyed, ALPHA, { idempotencyKey: "place-keyed", at: now });
    store.placeTask(keyed, ALPHA, { idempotencyKey: "place-keyed", at: now });
    expect(keys().filter(key => key.includes(`:t${keyed}:`))).toHaveLength(1);
  });

  test("approval is a new yes on exact bytes; re-sealing the same approval says nothing", () => {
    expect(store.createConsoleTask({ id: "alpha-1", title: "Guard the payout path", repo: ALPHA, goal: "Guard it", acceptance: RUBRIC }, now)).toMatchObject({ ok: true });
    expect(store.sealScopeApproval("alpha-1", "alex", now)).toBe(true);
    expect(life().map(row => row.kind)).toEqual(["task-filed", "scope-approved"]);
    expect(life().at(-1)).toMatchObject({ subject: "Scope approved", body: "Approved by alex. A connected worker can take it next.", link: "/chat?task=alpha-1", project: ALPHA });
    expect(store.sealScopeApproval("alpha-1", "alex", later(1_000))).toBe(true);
    expect(life().map(row => row.kind)).toEqual(["task-filed", "scope-approved"]);
  });

  test("holds and releases: the operator's pause speaks, other owners ride their own pages, and a recurrence under one clock value is a new fact", () => {
    const ref = placed("alpha-1", ALPHA, "Guard the payout path");
    store.hold(ref, "waiting on the vendor sandbox", null, now);
    store.hold(ref, "waiting on the vendor sandbox", null, now);
    expect(keys()).toEqual([`${LIFECYCLE_KEY_PREFIX}task-filed:t${ref}:1`, `${LIFECYCLE_KEY_PREFIX}task-held:t${ref}:1`]);
    expect(life().at(-1)).toMatchObject({ subject: "Paused", body: "The next attempt waits until the hold is released. An attempt already running is not stopped by this.", link: "/t/alpha-1" });
    expect(store.unhold(ref, {}, now)).toBe(true);
    expect(life().at(-1)).toMatchObject({ kind: "task-released", subject: "Hold released", body: "The next attempt can start.", link: "/chat?task=alpha-1" });
    // Held again at the very same instant: a real recurrence, keyed by ordinal, never by clock.
    store.hold(ref, "waiting on the vendor sandbox", later(3_600_000), now);
    expect(keys().slice(-2)).toEqual([`${LIFECYCLE_KEY_PREFIX}task-released:t${ref}:1`, `${LIFECYCLE_KEY_PREFIX}task-held:t${ref}:2`]);
    expect(life().at(-1)?.subject).toBe("Paused until 2026-09-16 10:00 UTC");
    expect(life().every(row => row.createdAt === now.toISOString())).toBe(true);
    // A decision's hold arrives beside its own page (the park producer's), so it says nothing here;
    // lifting the operator's hold while it stands names what still waits.
    store.holdOwned({ taskRef: ref, ownerKind: "decision", ownerId: "7", reason: "decision:7", until: null }, now);
    expect(life().at(-1)?.kind).toBe("task-held");
    expect(store.unhold(ref, {}, now)).toBe(true);
    expect(life().at(-1)).toMatchObject({ kind: "task-released", body: "It still waits on an unanswered question.", link: "/t/alpha-1" });
    expect(store.unhold(ref, {}, now)).toBe(false);
    expect(life().filter(row => row.kind === "task-released")).toHaveLength(2);
  });

  test.each(["hold", "holdOwned"] as const)("%s rolls back its own mutation when recording the fact fails", method => {
    const ref = placed("alpha-1", ALPHA);
    const before = keys();
    store.handle.exec(`CREATE TEMP TRIGGER fail_hold_notification
      BEFORE INSERT ON notification WHEN NEW.kind = 'task-held'
      BEGIN SELECT RAISE(ABORT, 'notification write failed'); END`);
    const pause = () => method === "hold"
      ? store.hold(ref, "waiting", null, now)
      : store.holdOwned({ taskRef: ref, ownerKind: "operator", ownerId: String(ref), reason: "waiting", until: null }, now);
    // Deliberately no outer transaction: callers need not supply atomicity.
    expect(pause).toThrow("notification write failed");
    expect(store.activeHolds(ref, now)).toEqual([]);
    expect(keys()).toEqual(before);
  });

  test("cancellation, requeue and return-to-queue ride their floors; a repeat of the same state and a rolled-back change record nothing", () => {
    const ref = placed("alpha-1", ALPHA);
    expect(store.cancelTask("alpha-1", now, "not needed this sprint")).toMatchObject({ ok: true });
    expect(life().at(-1)).toMatchObject({ kind: "task-cancelled", subject: "Cancelled", body: "Cancelled by an operator: not needed this sprint. Nothing more runs for it.", link: "/chat?task=alpha-1" });
    // The unfiltered state verb rewrites the same state; the floor's audit answer is unchanged and no second fact lands.
    expect(store.applyCancellation("alpha-1", { kind: "operator", text: null }, now, null)).toEqual({ changed: true });
    expect(store.setTaskState("alpha-1", "cancelled", now)).toEqual({ ok: true });
    expect(life().filter(row => row.kind === "task-cancelled")).toHaveLength(1);
    // The machine's cancellation words differ from an operator's.
    placed("beta-1", BETA);
    expect(store.applyCancellation("beta-1", { kind: "machine", code: "mirror-latched" }, now, ["queued"])).toEqual({ changed: true });
    expect(life().at(-1)).toMatchObject({ kind: "task-cancelled", project: BETA, body: "The tracker closed it. Nothing more runs for it." });
    // A reason that already closes its sentence gets no second full stop; a long one ends in its ellipsis.
    placed("beta-2", BETA);
    expect(store.cancelTask("beta-2", now, "Superseded by beta-3.")).toMatchObject({ ok: true });
    expect(life().at(-1)?.body).toBe("Cancelled by an operator: Superseded by beta-3. Nothing more runs for it.");
    placed("beta-3", BETA);
    expect(store.cancelTask("beta-3", now, "w".repeat(130))).toMatchObject({ ok: true });
    expect(life().at(-1)?.body).toBe(`Cancelled by an operator: ${"w".repeat(119)}… Nothing more runs for it.`);
    // Requeue after a stall; a running task released unfinished; a same-state write.
    placed("alpha-2", ALPHA);
    expect(store.setTaskState("alpha-2", "failed", now)).toEqual({ ok: true });
    expect(store.requeueTask("alpha-2", "alex", now)).toMatchObject({ ok: true });
    expect(life().at(-1)).toMatchObject({ kind: "task-requeued", subject: "Requeued", body: "Its failure streak is cleared; a worker can take it again." });
    expect(store.setTaskState("alpha-2", "running", now)).toEqual({ ok: true });
    expect(store.setTaskState("alpha-2", "queued", now)).toEqual({ ok: true });
    expect(life().at(-1)).toMatchObject({ kind: "task-queued", subject: "Back in the queue", body: "Its worker released it without finishing; another attempt can start." });
    expect(store.setTaskState("alpha-2", "queued", now)).toEqual({ ok: true });
    expect(life().filter(row => row.kind === "task-queued")).toHaveLength(1);
    // Rolled back with its change: nothing survives a failed transaction.
    const before = keys();
    expect(() => store.transact(() => { store.hold(ref, "about to fail", null, now); throw new Error("boom"); })).toThrow("boom");
    expect(keys()).toEqual(before);
    expect(store.activeHolds(ref, now)).toHaveLength(0);
  });

  test("run admission, phases and endings: one start per attempt, one fact per phase crossed, one ending per open run; a closed run's phase and a restated reason are history", () => {
    const ref = placed("alpha-1", ALPHA);
    const run = store.startRun({ taskRef: ref, leaseId: "l-1", runner: RUNNER, branch: "so/alpha-1", worktree: "/pool/alpha-1", ...bareLegacy("build"), now });
    expect(life().at(-1)).toMatchObject({ kind: "run-started", run, subject: `Attempt #${run} started`, body: "Building on claude.", link: "/chat?task=alpha-1" });
    store.setRunPhase(run, "agent-running", now);
    store.setRunPhase(run, "agent-running", now);
    store.setRunPhase(run, "validating-handoff", now);
    expect(life().slice(-2).map(row => row.subject)).toEqual([`Attempt #${run}: agent working`, `Attempt #${run}: checking the handoff`]);
    store.finishRun(run, { outcome: "built", committed: true, now });
    expect(life().at(-1)).toMatchObject({ kind: "run-finished", subject: `Attempt #${run} built`, body: "The result is saved locally. It is not yet independently reviewed or published.", link: `/chat?task=alpha-1&result=${run}&tab=changes` });
    // A reason restated on the closed run is the same ending; a leftover phase is history.
    store.finishRun(run, { outcome: "built", reason: "report-delivered (task external-closed)", committed: true, now });
    store.setRunPhase(run, "committing", now);
    expect(life().map(row => row.kind)).toEqual(["task-filed", "run-started", "run-phase", "run-phase", "run-finished"]);
    // Failures, parks, plans and reports keep their own pages: no lifecycle ending repeats them.
    const failing = store.startRun({ taskRef: ref, leaseId: "l-2", runner: RUNNER, branch: "so/alpha-1", worktree: "/pool/alpha-1", ...bareLegacy("build"), now });
    store.finishRun(failing, { outcome: "failed", reason: "agent", now });
    const parked = store.startRun({ taskRef: ref, leaseId: "l-3", runner: RUNNER, branch: "so/alpha-1", worktree: "/pool/alpha-1", ...bareLegacy("build"), now });
    store.finishRun(parked, { outcome: "parked", reason: "decision:1", now });
    const planner = store.startRun({ taskRef: ref, leaseId: "l-4", runner: RUNNER, role: "planner", branch: "so/alpha-1", worktree: "/pool/alpha-1", ...bareLegacy("plan"), now });
    store.finishRun(planner, { outcome: "built", now });
    const noChange = store.startRun({ taskRef: ref, leaseId: "l-5", runner: RUNNER, branch: "so/alpha-1", worktree: "/pool/alpha-1", ...bareLegacy("build"), now });
    store.finishRun(noChange, { outcome: "no-change", reason: "handoff", now });
    expect(life().slice(5).map(row => [row.kind, row.subject])).toEqual([
      ["run-started", `Attempt #${failing} started`],
      ["run-started", `Attempt #${parked} started`],
      ["run-started", `Planning started (run #${planner})`],
      ["run-started", `Attempt #${noChange} started`],
      ["run-finished", `Attempt #${noChange} finished with no changes`],
    ]);
    // An unplaced task's runs say nothing: there is no project to tell.
    store.createTask({ id: "nowhere", title: "nowhere" }, now);
    const nowhere = store.refFor("built-in", "nowhere").id;
    const orphan = store.startRun({ taskRef: nowhere, leaseId: "l-6", runner: RUNNER, branch: "b", worktree: "/w", ...bareLegacy("build"), now });
    store.finishRun(orphan, { outcome: "built", committed: true, now });
    expect(life().some(row => row.taskId === "nowhere")).toBe(false);
  });

  test("a saved result is not a reviewed one: review requested, review started, review finished with its verdict", () => {
    const ref = placed("alpha-1", ALPHA);
    const run = store.startRun({ taskRef: ref, leaseId: "l-1", runner: RUNNER, branch: "so/alpha-1", worktree: "/pool/alpha-1", ...bareLegacy("build"), now });
    store.finishRun(run, { outcome: "built", committed: true, now });
    store.saveArtifact({ run, kind: "terminal-diff", key: `${run}/terminal-diff.patch`, bytesOriginal: 12, bytesStored: 12, truncated: false, sha256: "a".repeat(64), capture: "git diff (exit 0)", captureStatus: "ok" }, now);
    store.saveProofVerdict(run, "attested", ["no check log"], now, [{ id: "c1", state: "pass", how: "manual", evidence: [] }] as never);
    const asked = store.requestReview(run, "alex", now);
    expect(asked).toMatchObject({ ok: true, attempt: 1 });
    expect(life().at(-1)).toMatchObject({ kind: "review-requested", run, subject: "Independent review requested", body: `Requested by alex for attempt #${run}'s saved result. A connected reviewer runs it next.`, link: `/chat?task=alpha-1&result=${run}&tab=checks` });
    if (!asked.ok) return;
    const reviewer = store.startRun({ taskRef: ref, leaseId: "l-r", runner: RUNNER, role: "reviewer", parentRun: run, request: asked.id, ...bareLegacy("review", "claude", "sonnet"), now });
    expect(life().at(-1)).toMatchObject({ kind: "run-started", run: reviewer, subject: "Independent review started (attempt 1)", body: `Reviewing the saved result of attempt #${run}. Running on claude · sonnet.` });
    // The fold lands the verdict before the root reviewer is concluded (ingestReview's order).
    store.saveProofVerdict(run, "verified", [], now, [{ id: "c1", state: "pass", how: "manual", evidence: [] }] as never, "attested");
    store.finishRun(reviewer, { outcome: "no-change", reason: "reviewed — 0 comment(s), 1 judgement(s)", now });
    expect(life().at(-1)).toMatchObject({ kind: "review-finished", run: reviewer, subject: "Independent review finished: checks verified", body: "Every acceptance check was verified against the saved result.", link: `/chat?task=alpha-1&result=${run}&tab=checks` });
    store.finishRun(reviewer, { outcome: "no-change", reason: "reviewed — restated", now });
    expect(life().filter(row => row.kind === "review-finished")).toHaveLength(1);
  });

  test("stopping is not pausing: stop requested, attempt stopped, attempt resumed — each once, on the exact run", () => {
    const ref = placed("alpha-1", ALPHA);
    const claimed = acquire(store, ref, RUNNER, { token: TOKEN, now, newLeaseId: () => "lease-stop" });
    expect(claimed).toMatchObject({ ok: true });
    const run = store.startRun({ taskRef: ref, leaseId: "lease-stop", runner: RUNNER, branch: "so/alpha-1", worktree: "/pool/alpha-1", ...bareLegacy("build"), now });
    expect(store.requestRunStop({ runId: run, taskRef: ref, by: "alex", via: "web" }, now)).toMatchObject({ ok: true, repeated: false });
    expect(store.requestRunStop({ runId: run, taskRef: ref, by: "alex", via: "web" }, now)).toMatchObject({ ok: true, repeated: true });
    expect(life().slice(-1)).toMatchObject([{ kind: "run-stopping", run, subject: `Stopping attempt #${run}`, body: "Its processes are being stopped and its work is preserved. The task stays paused until this attempt is resumed.", link: "/t/alpha-1" }]);
    store.finishRun(run, { outcome: "failed", reason: "interrupted", now, stopSettlement: "interrupted" });
    expect(life().at(-1)).toMatchObject({ kind: "run-stopped", subject: `Attempt #${run} stopped`, body: "Its work is preserved. Resume this attempt from the task page when ready." });
    // The claim ends with the attempt; the resume then lifts exactly this stop's hold.
    store.handle.prepare("UPDATE claim SET released_at = ?, released_by = 'released' WHERE lease_id = 'lease-stop'").run(now.toISOString());
    expect(store.activeHolds(ref, now).map(one => one.ownerKind)).toEqual(["stop"]);
    expect(store.resumeRunStop({ runId: run, taskRef: ref, by: "alex", via: "web" }, later(1_000))).toMatchObject({ ok: true });
    expect(life().at(-1)).toMatchObject({ kind: "run-resumed", subject: `Attempt #${run} resumed`, body: "The next pass takes a fresh claim and continues from the preserved work.", link: "/chat?task=alpha-1" });
    expect(life().map(row => row.kind)).toEqual(["task-filed", "run-started", "run-stopping", "run-stopped", "run-resumed"]);
    expect(life().every(row => row.pushClass === null && row.scope === "task" && row.project === ALPHA)).toBe(true);
  });
});

describe("lifecycle facts through the Telegram transport", () => {
  let dir: string;
  let file: string;
  let store: Store;
  let now: Date;
  let projects: string[];
  let origin: string | null;
  let token = "";

  const pair = (chat = CHAT, updateId = 1) => {
    const code = mintPairingCode();
    store.createTelegramPairing({ codeHash: hashPairingCode(code), approver: "alex", by: "alex", ttlMs: PAIRING_TTL_MS }, now);
    expect(store.consumeTelegramPairing({ codeHash: hashPairingCode(code), botId: BOT, chatId: String(chat), userId: String(USER), updateId }, now).ok).toBe(true);
    return store.liveTelegramBinding(BOT)!;
  };
  const pass = (script: ReturnType<typeof scriptedTransport>) =>
    bridgePass(store, { botId: BOT, transport: script.transport, clock: () => now, readProjects: async () => projects, conversation: { evidenceRoot: dir, phoneOrigin: () => origin } });
  const placed = (id: string, repo: string, title: string) => {
    store.createTask({ id, title }, now);
    const ref = store.refFor("built-in", id).id;
    store.placeTask(ref, repo, {}, now);
    return ref;
  };
  const receipts = () => store.telegramDeliveries(store.liveTelegramBinding(BOT)!).filter(isLifecycleNotification);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "so-task-notifications-"));
    file = join(dir, "orders.db");
    store = openStore(file);
    now = T0;
    projects = [ALPHA, BETA];
    origin = ORIGIN;
    const alex = addApprover(store, "alex", now);
    expect(alex.ok).toBe(true);
    token = alex.ok ? alex.token : "";
    // Every step: these journeys prove the per-step behaviour quiet chat keeps for people who choose it.
    store.setNotificationPreference("alex", { mode: "all" }, "alex", now);
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  /** A built result whose independent review ends with only human review owed: two saved screenshots, one upheld manual-review criterion. */
  const humanReviewResult = () => {
    const ref = placed("alpha-1", ALPHA, "Make status replies clear");
    const run = store.startRun({ taskRef: ref, leaseId: "l-a", runner: RUNNER, branch: "so/alpha-1", worktree: "/pool/alpha-1", ...bareLegacy("build"), now });
    store.finishRun(run, { outcome: "built", committed: true, now });
    store.setTaskState("alpha-1", "done", now);
    mkdirSync(join(dir, String(run)));
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);
    const shots = ["phone.png", "desktop.png"].map(name => {
      writeFileSync(join(dir, String(run), name), png);
      return store.saveArtifact({ run, kind: "screenshot", key: `${run}/${name}`, bytesOriginal: png.length, bytesStored: png.length, truncated: false, sha256: createHash("sha256").update(png).digest("hex"), capture: "saved screenshot" }, now);
    });
    store.saveArtifact({ run, kind: "terminal-diff", key: `${run}/diff.patch`, bytesOriginal: 12, bytesStored: 12, truncated: false, sha256: "a".repeat(64), capture: "git diff (exit 0)", captureStatus: "ok" }, now);
    store.saveProofVerdict(run, "attested", [], now);
    const asked = store.requestReview(run, "alex", now);
    if (!asked.ok) throw new Error(asked.reason);
    const reviewer = store.startRun({ taskRef: ref, leaseId: "l-r", runner: RUNNER, role: "reviewer", parentRun: run, request: asked.id, ...bareLegacy("review"), now });
    const why = 'criterion "c1" requires manual-review evidence — an operator must accept it before this can verify';
    store.saveProofVerdict(run, "short", [why], now, [{ id: "c1", statement: "Inspect phone and desktop", requiredEvidence: ["manual-review"], state: "manual-review", detail: [why], answered: [{ kind: "manual-review", ref: "Saved screenshots" }], review: { judgement: "upholds", note: "The layout matches", author: "reviewer:claude" } }]);
    store.finishRun(reviewer, { outcome: "no-change", reason: "reviewed", now });
    return { run, shots };
  };

  const progressAttempt = () => {
    pair();
    const ref = placed("clear-acceptance", ALPHA, "Make acceptance easier to review");
    store.resolveEpisodes("life", now);
    const run = store.startRun({ taskRef: ref, leaseId: "l-progress", runner: RUNNER, branch: "so/clear-acceptance", worktree: "/pool/clear-acceptance", ...bareLegacy("build"), now });
    return { ref, run };
  };

  test("build and checks update one message without announcing a reviewer; replies still identify the saved builder result after a restart", async () => {
    const { ref, run } = progressAttempt();
    const script = scriptedTransport();
    await pass(script);
    store.setRunPhase(run, "validating-handoff", now);
    await pass(script);
    store.finishRun(run, { outcome: "built", committed: true, now });
    store.saveArtifact({ run, kind: "terminal-diff", key: `${run}/diff.patch`, bytesOriginal: 12, bytesStored: 12, truncated: false, sha256: "a".repeat(64), capture: "git diff (exit 0)", captureStatus: "ok" }, now);
    const matrix = [{ id: "c1", statement: "The result is readable", requiredEvidence: ["check"], state: "pass", detail: [], answered: [], review: null }];
    store.saveProofVerdict(run, "attested", [], now, matrix as never);
    await pass(script);
    store.close(); store = openStore(file);
    store.saveProofVerdict(run, "verified", [], now, matrix as never);
    expect((await pass(script)).ok).toBe(true);
    expect(script.sends()).toHaveLength(1);
    const edits = script.calls.filter(call => call.method === "editMessageText");
    expect(edits.length).toBeGreaterThanOrEqual(2);
    expect(new Set(edits.map(call => call.params["message_id"]))).toEqual(new Set([100]));
    // The card speaks the shared status (task-status.ts): one headline, then quiet rows.
    expect(edits.at(-1)?.params["text"]).toContain("○ Project checks · Didn't run");
    expect(edits.at(-1)?.params["text"]).toContain("○ Pull request · None");
    expect(edits.at(-1)?.params["text"]).not.toMatch(/Review|reviewer/);
    expect(script.buttons(edits.at(-1)!)).toEqual([{ text: "Open result", url: `${ORIGIN}/chat?task=clear-acceptance&result=${run}` }]);
    expect(store.telegramMessageBindings(store.liveTelegramBinding(BOT)!, "100")).toEqual([{ taskId: "clear-acceptance", taskRef: ref, run, project: ALPHA }]);
    expect(receipts().filter(one => one.run !== null).every(one => one.deliveredAt !== null)).toBe(true);
    expect(store.proofAcceptance(run)).toBeNull();
    const before = script.calls.length;
    await pass(script);
    expect(script.calls.slice(before).map(call => call.method)).toEqual(["getUpdates"]);
  });

  test("progress edits recheck enrollment, retain their identity after an uncertain reply and a restart, and accept Telegram's unchanged confirmation", async () => {
    const { run } = progressAttempt();
    const script = scriptedTransport();
    await pass(script);
    store.setRunPhase(run, "capturing-evidence", now);
    projects = [];
    await pass(script);
    expect(script.calls.filter(call => call.method === "editMessageText")).toHaveLength(0);
    projects = [ALPHA]; now = later(2000);
    const baseTransport = script.transport;
    script.transport = async (method, params) => method === "editMessageText" ? { ok: false, uncertain: true, description: "connection lost" } : baseTransport(method, params);
    await pass(script);
    expect(receipts().at(-1)).toMatchObject({ deliveredAt: null, lastError: "connection lost" });
    store.close(); store = openStore(file); now = later(4000);
    script.transport = async (method, params) => method === "editMessageText" ? { ok: false, description: "Bad Request: message is not modified: specified new message content is exactly the same" } : baseTransport(method, params);
    expect(await pass(script)).toMatchObject({ ok: true, report: { sent: 1, problems: [] } });
    expect(script.sends()).toHaveLength(1);
    expect(receipts().at(-1)?.receipt).toBe(`telegram:${BOT}:${CHAT}:100`);
  });

  test("a deleted progress message gets one confirmed replacement; a new attempt and a replacement pairing get their own message", async () => {
    const { ref, run } = progressAttempt();
    const script = scriptedTransport();
    await pass(script);
    store.setRunPhase(run, "capturing-evidence", now);
    script.fail({ ok: false, description: "Bad Request: message to edit not found" });
    expect(await pass(script)).toMatchObject({ ok: true, report: { sent: 1, problems: [] } });
    expect(script.sends()).toHaveLength(2);
    store.setRunPhase(run, "committing", now);
    await pass(script);
    expect(script.calls.filter(call => call.method === "editMessageText").at(-1)?.params["message_id"]).toBe(101);
    store.finishRun(run, { outcome: "failed", now });
    store.startRun({ taskRef: ref, leaseId: "l-new", runner: RUNNER, branch: "so/new", worktree: "/pool/new", ...bareLegacy("build"), now });
    await pass(script);
    expect(script.sends()).toHaveLength(3);
    store.unpairTelegram(BOT, "alex", now);
    pair(CHAT + 1, 2);
    const before = script.calls.length;
    await pass(script);
    expect(script.calls.slice(before).filter(call => call.method === "editMessageText").every(call => call.params["chat_id"] === String(CHAT + 1))).toBe(true);
    expect(script.calls.slice(before).filter(call => call.method === "sendMessage").every(call => call.params["chat_id"] === String(CHAT + 1))).toBe(true);
  });

  test("an edit rate limit survives restart, and revoked pairing during an edit cannot acknowledge its row", async () => {
    const { run } = progressAttempt();
    const script = scriptedTransport();
    await pass(script);
    store.setRunPhase(run, "capturing-evidence", now);
    script.fail({ ok: false, description: "Too Many Requests", parameters: { retry_after: 30 } });
    await pass(script);
    expect(store.telegramRetryAt(BOT)).toBe(later(30000).toISOString());
    store.close(); store = openStore(file); now = later(2000);
    const count = script.calls.length;
    await pass(script);
    expect(script.calls.slice(count).filter(call => call.method === "editMessageText")).toHaveLength(0);
    now = later(31000);
    const base = script.transport;
    const binding = store.liveTelegramBinding(BOT)!;
    script.transport = async (method, params) => {
      const answer = await base(method, params);
      if (method === "editMessageText") store.unpairTelegram(BOT, "alex", now);
      return answer;
    };
    expect(await pass(script)).toMatchObject({ ok: true, report: { sent: 0 } });
    expect(store.telegramDeliveries(binding).at(-1)).toMatchObject({ deliveredAt: null, lastError: "Telegram pairing or actor authorization changed" });
    expect(script.sends()).toHaveLength(1);
  });

  test("a mixed digest is never repainted as a progress card, and a later failure still sends its alert", async () => {
    const { ref, run } = progressAttempt();
    store.setTelegramDigest(1000, "alex", now);
    placed("another", BETA, "Keep the other project visible");
    now = later(2000);
    const script = scriptedTransport();
    await pass(script);
    expect(script.sends()).toHaveLength(1);
    expect(store.telegramProgressMessage(store.liveTelegramBinding(BOT)!, store.getRun(run)!)).toBeNull();
    store.setTelegramDigest(null, "alex", now);
    store.setRunPhase(run, "capturing-evidence", now);
    await pass(script);
    expect(script.sends()).toHaveLength(2);
    store.finishRun(run, { outcome: "failed", reason: "check failed", now });
    store.enqueueNotification({ source: { run }, dedupeKey: `build-failed:${ref}`, kind: "build-failed", pushClass: "attention", subject: "Checks failed", body: "The expected error message did not appear.", link: `/chat?task=clear-acceptance&result=${run}` }, now);
    await pass(script);
    expect(script.sends()).toHaveLength(3);
    expect(script.texts().at(-1)).toContain("The expected error message did not appear.");
    expect(String(script.calls.filter(call => call.method === "editMessageText").at(-1)?.params["text"]).split("\n")[1]).toBe("❌ Failed");
  });

  test("a routine infrastructure retry and operator hold update one formatted card with an exact reply binding", async () => {
    const { ref, run } = progressAttempt();
    const terms = presetTerms("hands-off", later(86_400_000).toISOString());
    store.signMode({ repo: ALPHA, name: "hands-off", termsJson: modeTermsJson(terms), digest: modeDigestOf(terms), signedBy: "alex", absoluteExpiry: terms.absoluteExpiry, publication: terms.publication }, now);
    const script = scriptedTransport();
    await pass(script);
    expect(script.texts()[0]).toContain("⏳ Building");
    expect(script.texts()[0]).not.toContain("Review pending");
    store.recordOutcomeFacts(run, { handoff: "could not re-read the branch in /Users/alex/private/worktree" });
    store.finishRun(run, { outcome: "failed", reason: "retryable-infra", now });
    store.enqueueNotification({ source: { run }, dedupeKey: `run:${run}:failed`, kind: "build-failed", subject: "retryable-infra", body: "/Users/alex/private/worktree" }, now);
    store.holdOwned({ taskRef: ref, ownerKind: "operator", ownerId: String(ref), reason: "Restore folder access", until: null }, now);
    await pass(script);
    expect(script.sends()).toHaveLength(1);
    const edits = script.calls.filter(call => call.method === "editMessageText");
    expect(edits).toHaveLength(2);
    const card = edits.at(-1)!;
    const text = String(card.params["text"]);
    expect(text).toContain("👋 Needs you");
    expect(text).toContain("The worker can't read the project folder. Restore its access, then resume.");
    expect(text).not.toMatch(/retryable-infra|\/Users|Review optional|20\d\d-\d\d-\d\dT/);
    expect(card.params["entities"]).toEqual(telegramProgressCard(store, store.getRun(run)!, "clear-acceptance", ALPHA, now).entities);
    expect(script.buttons(card)[0]?.text).toBe("Open task");
    expect(store.telegramMessageBindings(store.liveTelegramBinding(BOT)!, "100")).toEqual([{ taskId: "clear-acceptance", taskRef: ref, run, project: ALPHA }]);
    store.unhold(ref, {}, now);
    await pass(script);
    expect(script.sends()).toHaveLength(1);
  });

  test("a delayed hold keeps its original attempt even when a newer run has the same timestamp", async () => {
    const { ref, run } = progressAttempt();
    const script = scriptedTransport();
    await pass(script);
    store.holdOwned({ taskRef: ref, ownerKind: "operator", ownerId: String(ref), reason: "Check the saved result", until: null }, now);
    const held = store.listNotifications("all").find(n => n.kind === "task-held")!;
    expect(held.run).toBe(run);
    store.finishRun(run, { outcome: "failed", now });
    const next = store.startRun({ taskRef: ref, leaseId: "l-same-time", runner: RUNNER, branch: "so/new", worktree: "/pool/new", ...bareLegacy("build"), now });
    await pass(script);
    expect(store.telegramProgressRun(held)?.id).toBe(run);
    expect(store.telegramMessageBindings(store.liveTelegramBinding(BOT)!, "100")).toEqual([{ taskId: "clear-acceptance", taskRef: ref, run, project: ALPHA }]);
    expect(store.telegramProgressMessage(store.liveTelegramBinding(BOT)!, store.getRun(next)!)).not.toBe("100");
  });

  test("heading entities use UTF-16 ranges and never interpret user markup", () => {
    const { run } = progressAttempt();
    store.handle.prepare("UPDATE task SET title = ? WHERE id = ?").run("😀 **Ship & test**", "clear-acceptance");
    const card = telegramProgressCard(store, store.getRun(run)!, "clear-acceptance", ALPHA, now);
    expect(card.entities.map(e => card.text.slice(e.offset, e.offset + e.length))).toEqual(["😀 **Ship & test**", "⏳ Building"]);
  });

  test("progress shows a person's acceptance plainly and never turns a record gap into a reviewer stage", () => {
    const { run } = humanReviewResult();
    const view = () => telegramProgressCard(store, store.getRun(run)!, "alpha-1", ALPHA).text;
    expect(view()).toContain("○ Requirements · 0 of 1 met · You check 1");
    expect(view()).not.toMatch(/Review|reviewer/);
    store.acceptProof(run, "alex", "Inspected the saved screenshots.", now);
    expect(view()).toContain("Accepted by a person · Recorded checks unchanged");
    expect(store.proofVerdictFor(run)?.verdict).toBe("short");
    const proof = store.proofVerdictFor(run)!;
    proof.matrix[0]!.coverage = { state: "context", inherited: true, items: [], gaps: ["Missing inherited screenshot"], priorSupport: "none" };
    store.saveProofVerdict(run, proof.verdict, proof.reasons, now, proof.matrix);
    expect(view()).not.toContain("Evidence needs attention");
    expect(view()).toContain("Accepted by a person");
  });

  test("direct assessment shows passed checks and an old review request changes nothing", () => {
    const { run } = progressAttempt();
    store.finishRun(run, { outcome: "built", committed: true, now });
    const proof = adjudicate({ directAssessment: true, proofArtifactPresent: false, proofParse: null, handoffPresent: true,
      terminalDiffPresent: true, terminalDiffCaptureStatus: "ok", diffStat: { captured: true, truncated: false, paths: new Set(["src/save.ts"]) },
      verifyCommand: { configured: true, ran: true, exitCode: 0 }, screenshots: [],
      approvedCriteria: [{ id: "c1", statement: "Saved values survive reload", evidence: ["check"] }] });
    store.saveProofVerdict(run, proof.verdict, proof.reasons, now, proof.matrix, proof.machineVerdict);
    store.saveArtifact({ run, kind: "terminal-diff", key: `${run}/diff.patch`, bytesOriginal: 12, bytesStored: 12, truncated: false, sha256: "a".repeat(64), capture: "git diff (exit 0)", captureStatus: "ok" }, now);
    const card = telegramProgressCard(store, store.getRun(run)!, "clear-acceptance", ALPHA, now);
    // The same words as the console: the evidence passed, and no check is called failed.
    expect(card.text).toContain("✓ Requirements · 1 of 1 met");
    expect(card.text).not.toMatch(/✕|Failed/);
    expect(card.text).not.toContain("failed or missing checks");
    expect(card.text).not.toMatch(/Review|reviewer/);
    expect(store.requestReview(run, "alex", now).ok).toBe(true);
    expect(telegramProgressCard(store, store.getRun(run)!, "clear-acceptance", ALPHA, now).text).toBe(card.text);
  });

  test("strict quality terms and historical reviewer runs never put a review stage on the card", () => {
    const { ref, run } = progressAttempt();
    store.finishRun(run, { outcome: "built", committed: true, now });
    const view = (strict = false) => telegramProgressCard(store, { ...store.getRun(run)!, qualityMode: strict ? "strict" : "default" }, "clear-acceptance", ALPHA).text;
    expect(view()).toContain("⚠ Project checks · Couldn't be read");
    const matrix = [{ id: "c1", statement: "Readable progress", requiredEvidence: ["check"], state: "pass", detail: [], answered: [], review: null }];
    store.saveProofVerdict(run, "verified", [], now, matrix as never);
    expect(view()).toContain("✓ Requirements · 1 of 1 met");
    expect(view(true)).not.toMatch(/Review|reviewer/);
    store.saveArtifact({ run, kind: "terminal-diff", key: `${run}/diff.patch`, bytesOriginal: 12, bytesStored: 12, truncated: false, sha256: "a".repeat(64), capture: "git diff (exit 0)", captureStatus: "ok" }, now);
    const request = store.requestReview(run, "alex", now);
    if (!request.ok) throw Error(request.reason);
    const reviewer = store.startRun({ taskRef: ref, leaseId: "l-review", runner: RUNNER, role: "reviewer", parentRun: run, request: request.id, ...bareLegacy("review"), now });
    store.finishRun(reviewer, { outcome: "no-change", reason: "comments only", now });
    expect(view(true)).not.toMatch(/Review|reviewer/);
    expect(view(true)).toContain("✓ Requirements · 1 of 1 met");
  });

  test("a saved result reads Ready, then Complete once a person marks that exact result", () => {
    for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "alex", now);
    const ref = placed("ready-1", ALPHA, "Keep the guard readable");
    propose(store, { taskId: "ready-1", goal: "Keep the guard readable", touches: ["src/guard.ts"], acceptance: [{ id: "c1", statement: "The guard stays readable.", how: null, evidence: ["check"] }], now });
    expect(approve(store, "ready-1", "alex", now, store.getScope("ready-1")!.digest, token).ok).toBe(true);
    const authority = store.routeAuthorityFor(ref, "builder");
    if (!authority?.ok) throw new Error("route fixture");
    const run = store.startRun({ taskRef: ref, leaseId: "l-ready", runner: RUNNER, branch: "so/ready-1", worktree: "/pool/ready-1", route: authority.stamp, now });
    store.stampRun(run, { scopeDigest: store.getScope("ready-1")!.digest, baseRevision: "b".repeat(40) });
    store.recordOutcomeFacts(run, { headRevision: "a".repeat(40), handoff: "The guard reads well." });
    store.finishRun(run, { outcome: "built", committed: true, now });
    store.setTaskState("ready-1", "done", now);
    store.saveProofVerdict(run, "verified", [], now, [{ id: "c1", statement: "The guard stays readable.", requiredEvidence: ["check"], state: "pass", detail: [], answered: [], review: null }] as never, "verified");
    store.setVerifyCommand({ repo: ALPHA, command: "npm test", timeoutMs: 300_000, approvedBy: "alex" }, now);
    storeEvidence(store, dir, run, "check-log", "checks.txt", Buffer.from("1 test passed"), "npm test", now, { captureStatus: "ok" });
    sealVerificationReceipt(store, dir, run, "a".repeat(40), store.liveVerifyCommand(ALPHA)!, { configured: true, ran: true, exitCode: 0 }, now);
    const view = () => telegramProgressCard(store, store.getRun(run)!, "ready-1", ALPHA, now, dir);
    expect(view().text).toContain("✅ Ready for review\nChecks passed on aaaaaaa. Review the change, then mark it complete.\n\n✓ Project checks · Passed on aaaaaaa");
    expect(view().link).toEqual({ label: "Open result", path: `/chat?task=ready-1&result=${run}` });
    const who = verifyApproverStanding(store, "alex", store.accountOf("alex")!.generation, [ALPHA]);
    if (!who.ok) throw new Error("approver fixture");
    const receipt = assignmentOf(store, "ready-1", now, { principal: "operator", repos: [ALPHA] }, dir)!.receipt!;
    expect(checkAssignmentAsOperator(store, "ready-1", receipt.digest, who.who, now, dir).ok).toBe(true);
    expect(view().text).toContain("✅ Complete\nMarked complete by alex.\n\n✓ Project checks · Passed on aaaaaaa");
    expect(view().text).not.toMatch(/Review|reviewer/);
  });

  test.each(["immediate", "digest"] as const)("%s: human acceptance automatically sends a review summary, separately receipted screenshots and a final secure link; retries preserve ordering", async mode => {
    pair();
    if (mode === "digest") { store.setTelegramDigest(60_000, "alex", now); store.markTelegramDigestSent(now); }
    const { run, shots } = humanReviewResult();
    const script = scriptedTransport();
    let documentAttempts = 0;
    const baseTransport = script.transport;
    script.transport = async (method, params, signal, upload) => {
      if (method === "sendDocument" && ++documentAttempts === 2) return { ok: false, description: "retry", parameters: { retry_after: 1 } };
      return baseTransport(method, params, signal, upload);
    };
    expect((await pass(script)).ok).toBe(true);
    expect(script.texts().join("\n")).toContain("human review needed");
    expect(script.texts().join("\n")).toContain("The layout matches");
    expect(script.texts().join("\n")).toContain("Saved screenshots and the acceptance summary follow.");
    expect(script.texts().join("\n")).not.toContain("required evidence is missing");
    expect(script.calls.filter(one => one.method === "sendDocument")).toHaveLength(1);
    expect(script.calls.flatMap(script.buttons).some(button => button.text === "Inspect result")).toBe(false);
    now = later(2000);
    store.close(); store = openStore(file);
    expect((await pass(script)).ok).toBe(true);
    expect(script.calls.filter(one => one.method === "sendDocument")).toHaveLength(2);
    expect(script.buttons(script.sends().at(-1)!)).toEqual([{ text: "Inspect result", url: `${ORIGIN}/review?result=alpha-1&run=${run}&tab=checks` }]);
    expect(receipts().filter(one => one.kind === "acceptance-evidence").every(one => one.deliveredAt !== null)).toBe(true);
    expect(script.texts().at(-1)).toContain("Project checks: No machine verification receipt available");
    expect(script.texts().at(-1)).toContain("Saved material problem: No readable saved proof is available.");
    expect(script.texts().at(-1)).toContain("Earlier assessment supported this finding: The layout matches");
    expect(store.proofAcceptance(run)).toBeNull();
    expect(shots).toHaveLength(2);
  });

  test("a screenshot already sent with its result is not sent again for acceptance, and one sent for acceptance is not resent with the result", async () => {
    const binding = pair();
    const destination = store.telegramDestination(binding);
    const { run, shots } = humanReviewResult();
    // The first screenshot went out with the result message.
    store.markResultShotsSent(destination, run, [shots[0]!], now);
    const script = scriptedTransport();
    expect((await pass(script)).ok).toBe(true);
    expect(script.calls.filter(one => one.method === "sendDocument")).toHaveLength(1);
    expect(receipts().filter(one => one.kind === "acceptance-evidence").map(one => one.receipt?.startsWith("skipped:") ? one.receipt : "sent")).toEqual(["skipped:screenshot-sent", "sent"]);
    // The one sent for acceptance counts as sent with the result too.
    expect([...store.resultShotsSent(destination, run)].sort()).toEqual([...shots].sort());
  });

  test("acceptance recorded before delivery: no screenshot is uploaded, the skipped rows never read as delivered, and the final message carries no acceptance link", async () => {
    pair();
    const { run } = humanReviewResult();
    store.acceptProof(run, "alex", "Inspected both viewports in the console.", now);
    const script = scriptedTransport();
    const report = await pass(script);
    expect(report).toMatchObject({ ok: true, report: { problems: [] } });
    expect(script.calls.filter(one => one.method === "sendDocument")).toHaveLength(0);
    expect(receipts().filter(one => one.kind === "acceptance-evidence").map(one => [one.receipt, one.deliveredAt, one.attempts])).toEqual([["skipped:already-accepted", null, 1], ["skipped:already-accepted", null, 1]]);
    expect(script.texts().at(-1)).toContain("Acceptance recorded");
    expect(script.calls.flatMap(script.buttons).some(button => button.text === "Inspect result")).toBe(false);
    // Several recorded facts now share one progress message; the report
    // still counts settled outbox rows, excluding skipped screenshots.
    expect(report.ok && report.report.sent).toBe(receipts().filter(one => one.deliveredAt !== null).length);
    expect(script.sends()).toHaveLength(4);
    // Settled rows: a later pass resends nothing.
    const before = script.calls.length;
    expect((await pass(script)).ok).toBe(true);
    expect(script.calls.slice(before).map(one => one.method)).toEqual(["getUpdates"]);
  });

  test("a pairing starts from now: history is settled as skipped, open decisions still page, and the rows that follow arrive in order with one trusted button", async () => {
    // Before anyone pairs: a task filed, built and reviewed is history.
    const old = placed("old-1", ALPHA, "Old work");
    const oldRun = store.startRun({ taskRef: old, leaseId: "l-old", runner: RUNNER, branch: "so/old-1", worktree: "/pool/old-1", ...bareLegacy("build"), now });
    store.finishRun(oldRun, { outcome: "built", committed: true, now });
    // An open decision from before the pairing still wants a person (the park producer's page, as fixture).
    store.enqueueNotification({ source: { run: oldRun }, dedupeKey: "decision:1", kind: "decision", subject: "old-1 parked a decision", body: "fixture", pushClass: "decision", link: "/d/1" }, now);
    expect(store.listNotifications("pending")).toHaveLength(4);
    pair();
    // Skipped history is an explicit receipt, never a delivery: no delivered
    // timestamp, no attempt, and (below) it does not fence what follows.
    expect(receipts().map(row => [row.kind, row.receipt, row.deliveredAt, row.attempts, row.lastError])).toEqual([
      ["task-filed", "skipped:before-pairing", null, 0, null],
      ["run-started", "skipped:before-pairing", null, 0, null],
      ["run-finished", "skipped:before-pairing", null, 0, null],
    ]);
    // What the console and brief count as "pending delivery": the open
    // decision wants a person; skipped history and routine progress do not.
    expect(store.pendingForAttention().map(row => row.dedupeKey)).toEqual(["decision:1"]);
    expect(store.countRoutinePending()).toBe(0);
    now = later(1_000);
    const a1 = placed("alpha-1", ALPHA, "Guard the payout path");
    placed("beta-1", BETA, "Rotate the API keys");
    placed("x-1", EXCLUDED, "Private work");
    const script = scriptedTransport();
    const first = await pass(script);
    expect(first).toMatchObject({ ok: true, report: { sent: 3, problems: ["notification 7: Notification project is not currently authorized and enrolled"] } });
    expect(script.texts()).toEqual([
      "alpha · Old work parked a decision\n\nfixture",
      "alpha · New task: Guard the payout path\n\nFiled and waiting in the queue.",
      "beta · New task: Rotate the API keys\n\nFiled and waiting in the queue.",
    ]);
    // Exactly one url button per lifecycle fact, minted under the trusted origin; the decision keeps its own tap keyboard.
    expect(script.sends().slice(1).map(send => script.buttons(send).map(button => [button.text, button.url]))).toEqual([
      [["Open task", `${ORIGIN}/chat?task=alpha-1`]],
      [["Open task", `${ORIGIN}/chat?task=beta-1`]],
    ]);
    expect(script.texts().join("\n")).not.toMatch(/Private work|excluded|\/projects\//);
    // The excluded project's update is held by policy, not failing on the wire: no delivery trouble to report.
    expect(store.pendingForAttention().filter(isLifecycleNotification)).toEqual([]);

    // A failed send fences that task's later facts until it goes; a restart carries on in order.
    now = later(2_000);
    const run = store.startRun({ taskRef: a1, leaseId: "l-a1", runner: RUNNER, branch: "so/alpha-1", worktree: "/pool/alpha-1", ...bareLegacy("build"), now });
    store.setRunPhase(run, "agent-running", now);
    script.fail({ ok: false, description: "offline" });
    const second = await pass(script);
    expect(second).toMatchObject({ ok: true, report: { sent: 0 } });
    expect(receipts().slice(-2).map(row => [row.kind, row.lastError])).toEqual([
      ["run-started", "offline"],
      ["run-phase", "Earlier task notification is still undelivered"],
    ]);
    // A send the wire refused is delivery trouble the console and brief count
    // (not hidden as quiet progress); the row fenced behind it is not counted twice.
    expect(store.pendingForAttention().filter(isLifecycleNotification).map(row => row.kind)).toEqual(["run-started"]);
    store.close();
    store = openStore(file);
    now = later(4_000);
    // A Telegram rate limit pauses every send bot-wide and survives the restart; the window over, order holds.
    script.fail({ ok: false, description: "Too Many Requests", parameters: { retry_after: 30 } });
    expect(await pass(script)).toMatchObject({ ok: true, report: { sent: 0 } });
    expect(store.telegramRetryAt(BOT)).toBe(later(34_000).toISOString());
    now = later(10_000);
    expect(await pass(script)).toMatchObject({ ok: true, report: { sent: 0 } });
    expect(store.pendingForAttention().filter(isLifecycleNotification).map(row => row.kind)).toEqual(["run-started"]);
    now = later(35_000);
    expect(await pass(script)).toMatchObject({ ok: true, report: { sent: 2 } });
    expect(store.pendingForAttention().filter(isLifecycleNotification)).toEqual([]);
    expect(script.texts().at(-1)!.split("\n").at(-1)).toBe("alpha");
    expect(script.texts().at(-1)).toContain("⏳ Building");
    const edits = script.calls.filter(call => call.method === "editMessageText");
    expect(edits).toHaveLength(1);
    expect(edits[0]?.params["text"]).toBe(script.texts().at(-1));
    expect(script.buttons(script.sends().at(-1)!)).toEqual([{ text: "Open task", url: `${ORIGIN}/chat?task=alpha-1` }]);
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM telegram_outbound_message WHERE task_id = 'alpha-1'").get()?.["n"]).toBe(3);
  });

  test("an earlier shell or webhook receipt cannot hide a failed Telegram delivery", async () => {
    pair();
    placed("alpha-1", ALPHA, "Guard the payout path");
    const notification = store.listNotifications()[0]!;
    store.recordDelivery(notification.id, { ok: true, receipt: "shell:fixture" }, now);
    const script = scriptedTransport();
    script.fail({ ok: false, description: "offline" });
    expect(await pass(script)).toMatchObject({ ok: true, report: { sent: 0 } });
    expect(receipts()[0]).toMatchObject({ deliveredAt: null, lastError: "offline" });
    expect(store.pendingForAttention().map(row => row.id)).toEqual([notification.id]);

    store.close();
    store = openStore(file);
    expect(store.pendingForAttention().map(row => row.id)).toEqual([notification.id]);
    now = later(2_000);
    expect(await pass(script)).toMatchObject({ ok: true, report: { sent: 1, problems: [] } });
    expect(store.pendingForAttention()).toEqual([]);
    // Neither the failure nor its recovery rewrites the other channel's receipt.
    expect(store.listNotifications("all")[0]).toMatchObject({ deliveredAt: T0.toISOString(), receipt: "shell:fixture" });
  });

  test("a hold's button opens the task's details page under the trusted origin, where the release control lives", async () => {
    pair();
    const a1 = placed("alpha-1", ALPHA, "Guard the payout path");
    store.hold(a1, "waiting on the vendor sandbox", null, now);
    const script = scriptedTransport();
    expect(await pass(script)).toMatchObject({ ok: true, report: { sent: 2, problems: [] } });
    expect(script.texts().at(-1)).toBe("alpha / Guard the payout path · Paused\n\nThe next attempt waits until the hold is released. An attempt already running is not stopped by this.");
    expect(script.buttons(script.sends().at(-1)!)).toEqual([{ text: "Open task", url: `${ORIGIN}/t/alpha-1` }]);
  });

  test.each(["single", "digest"] as const)("%s delivery hides sensitive lifecycle text before shortening it", async mode => {
    pair();
    if (mode === "digest") store.setTelegramDigest(60_000, "alex", now);
    // Synthetic, non-functional credential shapes; never a real token.
    const tokenShape = "ghp_" + "Z".repeat(36);
    const botShape = "123456:" + "Y".repeat(32);
    placed("short-secret", ALPHA, `Rotate ${tokenShape}`);
    placed("long-secret", BETA, `${"x".repeat(74)} ${tokenShape}`);
    placed("bot-secret", ALPHA, `Rotate ${botShape}`);
    expect(store.cancelTask("short-secret", now, `Obsolete ${tokenShape}`)).toMatchObject({ ok: true });
    now = later(61_000);
    const script = scriptedTransport();
    expect(await pass(script)).toMatchObject({ ok: true, report: { sent: 4, problems: [] } });
    const text = script.texts().join("\n");
    expect(text).not.toContain(tokenShape);
    expect(text).not.toContain("ghp_");
    expect(text).not.toContain(botShape);
    expect(text).not.toContain("123456:");
    expect(text.match(/\[sensitive text hidden\]/g)!.length).toBeGreaterThanOrEqual(4);
    // A chat names a task by its short title, never its id.
    expect(text).not.toMatch(/short-secret|long-secret|bot-secret/);
    expect(text).toContain("alpha · New task:");
    if (mode === "single") {
      expect(script.buttons(script.sends()[0]!)).toEqual([{ text: "Open task", url: `${ORIGIN}/chat?task=short-secret` }]);
    }
  });

  test("urgent and digest stay intact: routine progress waits for the window, an attention fact pages singly and flushes its task's earlier facts first; no trusted origin means no button", async () => {
    pair();
    origin = null;
    store.setTelegramDigest(60_000, "alex", now);
    const a1 = placed("alpha-1", ALPHA, "Guard the payout path");
    const run = store.startRun({ taskRef: a1, leaseId: "l-a1", runner: RUNNER, branch: "so/alpha-1", worktree: "/pool/alpha-1", ...bareLegacy("build"), now });
    placed("beta-1", BETA, "Rotate the API keys");
    const script = scriptedTransport();
    now = later(1_000);
    expect(await pass(script)).toMatchObject({ ok: true, report: { sent: 0 } });
    expect(script.sends()).toHaveLength(0);
    // An attention-class fact for alpha-1 (fixture row in the existing stall producer's shape).
    store.enqueueNotification({ source: { run }, dedupeKey: `stalled:${a1}`, kind: "attempts-exhausted", pushClass: "attention", link: `/r/${run}`, subject: "alpha-1 stalled after 3 straight failures", body: "fixture" }, now);
    now = later(2_000);
    // The task's earlier routine facts flush first, as one digest, then the attention fact pages singly.
    expect(await pass(script)).toMatchObject({ ok: true, report: { sent: 3, digests: 1 } });
    expect(script.texts()).toHaveLength(2);
    expect(script.texts()[0]).toMatch(/^digest — 2 routine fact\(s\)/);
    expect(script.texts()[0]).toContain("• alpha · New task: Guard the payout path\n    Filed and waiting in the queue.");
    expect(script.texts()[0]).toContain(`• alpha / Guard the payout path · Attempt #${run} started\n    Building on claude.`);
    expect(script.texts()[0]).not.toContain("beta-1");
    expect(script.texts()[1]).toBe("alpha · Guard the payout path stalled after 3 straight failures\n\nfixture");
    expect(script.sends().every(send => send.params["reply_markup"] === undefined)).toBe(true);
    // The window (anchored by the flush above) elapses: the remaining routine fact goes as one digest, plain text.
    now = later(63_000);
    expect(await pass(script)).toMatchObject({ ok: true, report: { sent: 1, digests: 1 } });
    expect(script.texts().at(-1)).toContain("digest — 1 routine fact(s)");
    expect(script.texts().at(-1)).toContain("beta · New task: Rotate the API keys");
  });

  test("revoked project and pairing access retain the facts with their reason; a re-pairing carries what no phone ever received", async () => {
    pair();
    const a1 = placed("alpha-1", ALPHA, "Guard the payout path");
    placed("beta-1", BETA, "Rotate the API keys");
    const script = scriptedTransport();
    now = later(1_000);
    projects = [ALPHA];
    expect(await pass(script)).toMatchObject({ ok: true, report: { sent: 1, problems: ["notification 2: Notification project is not currently authorized and enrolled"] } });
    expect(receipts().map(row => [row.taskId, row.deliveredAt !== null, row.lastError])).toEqual([
      ["alpha-1", true, null],
      ["beta-1", false, "Notification project is not currently authorized and enrolled"],
    ]);
    // The pairing is revoked: a fact recorded now waits, nothing leaks to the
    // old chat, and pending progress alone is not named as a problem.
    expect(store.unpairTelegram(BOT, "alex", later(2_000))).toBe(true);
    now = later(3_000);
    const run = store.startRun({ taskRef: a1, leaseId: "l-a1", runner: RUNNER, branch: "so/alpha-1", worktree: "/pool/alpha-1", ...bareLegacy("build"), now });
    expect(await pass(script)).toMatchObject({ ok: true, report: { sent: 0, problems: [] } });
    expect(script.sends()).toHaveLength(1);
    // The outbox keeps all three (the legacy shell/webhook column is separate from Telegram's receipts).
    expect(store.listNotifications("pending").filter(isLifecycleNotification)).toHaveLength(3);
    // A re-pairing (a new chat) is not a first pairing: what no phone ever
    // received still waits for it, in order, with nothing settled as history.
    now = later(4_000);
    projects = [ALPHA, BETA];
    pair(CHAT + 1, 2);
    expect(receipts()).toHaveLength(0);
    now = later(5_000);
    store.finishRun(run, { outcome: "built", committed: true, now });
    // Every fact reaches the new destination once, in id order — including the one the old chat already had.
    expect(await pass(script)).toMatchObject({ ok: true, report: { sent: 4, problems: [] } });
    expect(script.texts().slice(-3, -1)).toEqual([
      "alpha · New task: Guard the payout path\n\nFiled and waiting in the queue.",
      "beta · New task: Rotate the API keys\n\nFiled and waiting in the queue.",
    ]);
    // The card ends with its project; no task or attempt id.
    expect(script.texts().at(-1)!.split("\n").at(-1)).toBe("alpha");
    expect(script.texts().at(-1)).toContain("○ Project checks · Didn't run");
    expect(script.calls.filter(call => call.method === "editMessageText")).toHaveLength(1);
    expect(script.buttons(script.sends().at(-1)!)).toEqual([{ text: "Open result", url: `${ORIGIN}/chat?task=alpha-1&result=${run}` }]);
    expect(script.calls.filter(call => ["sendMessage", "editMessageText"].includes(call.method)).slice(-4).every(send => String(send.params["chat_id"]) === String(CHAT + 1))).toBe(true);
  });
});
