import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, verifiedAuthor, type Store } from "./store.js";
import { openSteerMailbox, type SteerMailbox } from "./steer-mailbox.js";
import { LIVE_RESEND_MS, liveNoteText, liveReminderText, tickLiveSteer } from "./steer-live.js";
import { LiveInput } from "./live-input.js";
import { steerFolderName } from "./evidence.js";
import { steerStandingWords } from "./steer-status.js";
import { LIVE_REPO, liveBuild } from "../test/live-steer-fixture.js";
import { presented } from "../test/route-fixture.js";
import { executeLeadTool } from "./lead-tools.js";
import { verifyApproverStanding } from "./principal.js";
import { confirmLeadProposal } from "./lead-doors.js";
import { credentialKeyOf } from "./converse.js";

const T0 = new Date("2026-10-11T12:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
// A pulse is 60 seconds; every delivery below lands well inside the first one.

let store: Store, worktree: string, taskRef: number, runId: number, box: SteerMailbox;
let frames: Record<string, unknown>[], session: LiveInput;

beforeEach(() => {
  store = openStore(":memory:");
  worktree = mkdtempSync(join(tmpdir(), "so-steer-live-"));
  ({ taskRef, runId } = liveBuild(store, T0, { worktree }));
  box = openSteerMailbox(worktree, steerFolderName(), runId, taskRef, ["a1b2", "c3d4", "e5f6", "0718"].join(""))!;
  frames = [];
  session = new LiveInput({ maxTurns: 100 });
  session.begin("brief");
  session.attach({ write: line => { frames.push(JSON.parse(line)); }, end: () => {} });
});
afterEach(() => { store.close(); rmSync(worktree, { recursive: true, force: true }); });

const file = (note: string, when = T0) => {
  const filed = store.fileSteerNote("t-1", verifiedAuthor("alex"), note, when);
  if (!filed.ok) throw new Error(filed.reason);
  return filed.id;
};
const userTexts = () => frames.filter(one => one["type"] === "user").slice(1).map(one => String((one["message"] as { content: string }).content));
const moveToHandled = (name: string) => renameSync(join(box.dir, name), join(box.dir, "handled", name));

describe("live steering's dispatcher", () => {
  test("c1: a note reaches a running Claude build's folder and stdin on the next tick, without the pulse, and sending is not reading", () => {
    const id = file("prefer the smaller diff");
    // One half-second tick after filing, nowhere near the 60-second pulse.
    tickLiveSteer(store, { box, session }, at(500), true);
    expect(existsSync(join(box.dir, "001.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(box.dir, "001.json"), "utf8"))).toMatchObject({ number: 1, key: box.key, note: "| prefer the smaller diff" });
    const note = store.steerNote(id)!;
    expect(userTexts()).toEqual([liveNoteText(box, 1, note)]);
    // The first send carries the note's own identity, minted when it was filed.
    expect(frames.at(-1)?.["uuid"]).toBe(note.liveUuid);
    expect(note).toMatchObject({ mailedRun: runId, liveSends: 1, liveSentAt: at(500).toISOString(), deliveredAt: null, ackedAt: null });
    expect(steerStandingWords(note, true, iso => iso)).toBe("Waiting for the agent to read it");
    // Only the agent moving the file reads it.
    moveToHandled("001.json");
    tickLiveSteer(store, { box, session }, at(1_000), true);
    expect(store.steerNote(id)).toMatchObject({ ackedAt: at(1_000).toISOString(), deliveredAt: at(1_000).toISOString() });
  });

  test("c4: an unread note is sent again every 90 seconds, 3 times, then reads Not picked up; a late move still reads it", () => {
    const id = file("start with the retry path");
    tickLiveSteer(store, { box, session }, at(0), true);
    const sends: number[] = [];
    for (let ms = 0; ms <= 6 * LIVE_RESEND_MS; ms += 1_000) {
      const before = userTexts().length;
      tickLiveSteer(store, { box, session }, at(ms), true);
      if (userTexts().length > before) sends.push(ms);
    }
    // Three re-sends, 90 seconds apart, never a fourth: the note in full once, then a short reminder naming its file, so
    // an agent that already acted on it is not asked to do the work again.
    expect(sends).toEqual([LIVE_RESEND_MS, 2 * LIVE_RESEND_MS, 3 * LIVE_RESEND_MS]);
    const reminder = liveReminderText(box, 1);
    expect(userTexts()).toEqual([liveNoteText(box, 1, store.steerNote(id)!), reminder, reminder, reminder]);
    expect(reminder).not.toContain("start with the retry path");
    const missed = store.steerNote(id)!;
    expect(missed).toMatchObject({ liveSends: 4, liveMissedAt: at(4 * LIVE_RESEND_MS).toISOString(), deliveredAt: null });
    expect(steerStandingWords(missed, true, iso => iso)).toBe("Not picked up");
    // Once the build is gone, the note waits for the next attempt as before.
    expect(steerStandingWords(missed, false, iso => iso)).toBe("Will reach the next attempt");
    moveToHandled("001.json");
    tickLiveSteer(store, { box, session }, at(7 * LIVE_RESEND_MS), true);
    expect(steerStandingWords(store.steerNote(id)!, true, iso => iso)).toBe(`Read by the agent at ${at(7 * LIVE_RESEND_MS).toISOString()}`);
  });

  test("c4: moving the file cancels the re-sends", () => {
    const id = file("keep the public API");
    tickLiveSteer(store, { box, session }, at(0), true);
    moveToHandled("001.json");
    tickLiveSteer(store, { box, session }, at(10_000), true);
    for (let ms = 0; ms <= 5 * LIVE_RESEND_MS; ms += 5_000) tickLiveSteer(store, { box, session }, at(ms), true);
    expect(userTexts()).toHaveLength(1);
    expect(store.steerNote(id)).toMatchObject({ liveSends: 1, liveMissedAt: null, ackedAt: at(10_000).toISOString() });
  });

  test("c6: a Codex build's note is written to its folder on the next tick, with nothing on stdin, and read only when moved", () => {
    const id = file("rename the helper");
    // Codex keeps the mailbox: no live session.
    tickLiveSteer(store, { box, session: null }, at(500), true);
    expect(existsSync(join(box.dir, "001.json"))).toBe(true);
    expect(userTexts()).toEqual([]);
    expect(store.steerNote(id)).toMatchObject({ mailedRun: runId, liveSends: 0, deliveredAt: null });
    moveToHandled("001.json");
    tickLiveSteer(store, { box, session: null }, at(1_000), true);
    expect(store.steerNote(id)).toMatchObject({ ackedAt: at(1_000).toISOString() });
  });

  test("c2: Pause writes one interrupt and keeps the session; old notes wait; the next note continues it", () => {
    const old = file("first note");
    tickLiveSteer(store, { box, session }, at(0), true);
    const paused = store.requestPause({ taskId: "t-1", runId, by: verifiedAuthor("alex"), via: "web", requestId: "pause-request-1" }, at(1_000));
    expect(paused).toMatchObject({ ok: true, note: null, duplicate: false });
    tickLiveSteer(store, { box, session }, at(1_500), true);
    expect(frames.at(-1)).toEqual({ type: "control_request", request_id: "pause-request-1", request: { subtype: "interrupt" } });
    expect(store.pauseStateOf(runId)).toBe("pausing");
    // The interrupted turn's result: paused, not ended.
    session.observe({ type: "result", subtype: "error_during_execution", is_error: true });
    store.markRunPaused(runId, at(1_600));
    expect(store.pauseStateOf(runId)).toBe("paused");
    expect(session.open).toBe(true);
    // A paused session is not re-sent an old note.
    tickLiveSteer(store, { box, session }, at(2 * LIVE_RESEND_MS), true);
    expect(store.steerNote(old)!.liveSends).toBe(1);
    // A new note continues it.
    file("now take the smaller diff", at(2 * LIVE_RESEND_MS));
    tickLiveSteer(store, { box, session }, at(2 * LIVE_RESEND_MS + 500), true);
    expect(userTexts().at(-1)).toContain("now take the smaller diff");
    expect(session.paused).toBe(false);
    expect(store.pauseStateOf(runId)).toBeNull();
    // Pause is never a stop.
    expect(store.stopsForTask(taskRef)).toEqual([]);
  });

  test("Pause and steer writes the interrupt before its note, in one tick", () => {
    const paused = store.requestPause({ taskId: "t-1", runId, by: verifiedAuthor("alex"), via: "cli", requestId: "pause-request-2", note: "switch to the retry path" }, at(0));
    expect(paused).toMatchObject({ ok: true, note: expect.any(Number) });
    tickLiveSteer(store, { box, session }, at(500), true);
    const after = frames.slice(1);
    expect(after.map(one => one["type"])).toEqual(["control_request", "user"]);
    expect(String((after[1]!["message"] as { content: string }).content)).toContain("switch to the retry path");
    expect(store.steerNote(paused.ok ? paused.note! : 0)).toMatchObject({ author: "alex", authorshipState: "verified", liveSends: 1 });
  });

  test("c7: Resume sends a paused build only a short continue frame, files no note, and ends the pause; a repeat is the same request", () => {
    store.requestPause({ taskId: "t-1", runId, by: verifiedAuthor("alex"), via: "web", requestId: "pause-request-r" }, at(0));
    // Only a paused build can be resumed: one still pausing is refused.
    expect(store.requestResume({ taskId: "t-1", runId, by: verifiedAuthor("alex"), via: "web", requestId: "resume-request-0" }, at(100)))
      .toMatchObject({ ok: false, reason: "not-paused" });
    tickLiveSteer(store, { box, session }, at(500), true);
    session.observe({ type: "result", subtype: "error_during_execution", is_error: true });
    store.markRunPaused(runId, at(600));
    const asked = store.requestResume({ taskId: "t-1", runId, by: verifiedAuthor("alex"), via: "web", requestId: "resume-request-1" }, at(1_000));
    expect(asked).toMatchObject({ ok: true, duplicate: false });
    expect(store.requestResume({ taskId: "t-1", runId, by: verifiedAuthor("alex"), via: "cli", requestId: "resume-request-1" }, at(1_100)))
      .toMatchObject({ ok: true, duplicate: true, resume: asked.ok ? asked.resume : -1 });
    expect(store.requestResume({ taskId: "t-1", runId: runId + 1, by: verifiedAuthor("alex"), via: "web", requestId: "resume-request-2" }, at(1_100)))
      .toMatchObject({ ok: false, reason: "stale" });
    tickLiveSteer(store, { box, session }, at(1_500), true);
    tickLiveSteer(store, { box, session }, at(2_000), true);
    expect(userTexts()).toEqual(["continue"]);
    expect(session.paused).toBe(false);
    expect(store.listSteerNotes(taskRef)).toEqual([]);
    expect(store.pauseStateOf(runId)).toBeNull();
    expect(store.resumesForTask(taskRef)).toMatchObject([{ sentAt: at(1_500).toISOString(), endedAt: null }]);
    expect(store.stopsForTask(taskRef)).toEqual([]);
  });

  test("a Resume that a note beat to the paused build sends nothing more", () => {
    store.requestPause({ taskId: "t-1", runId, by: verifiedAuthor("alex"), via: "web", requestId: "pause-request-n" }, at(0));
    tickLiveSteer(store, { box, session }, at(500), true);
    session.observe({ type: "result", subtype: "error_during_execution", is_error: true });
    store.markRunPaused(runId, at(600));
    store.requestResume({ taskId: "t-1", runId, by: verifiedAuthor("alex"), via: "web", requestId: "resume-request-n" }, at(700));
    // The note continued the session first (as a person sending a note at the same moment would).
    session.send("take the smaller diff", "note-uuid");
    tickLiveSteer(store, { box, session }, at(1_000), true);
    expect(userTexts()).toEqual(["take the smaller diff"]);
    expect(store.resumesForTask(taskRef)).toMatchObject([{ sentAt: null, endedAt: at(1_000).toISOString() }]);
  });

  test("a closed session takes nothing more: its pause ends, and notes stay in the folder for the agent or the next attempt", () => {
    store.requestPause({ taskId: "t-1", runId, by: verifiedAuthor("alex"), via: "web", requestId: "pause-request-3" }, at(0));
    session.close("settled");
    const id = file("one more thing");
    tickLiveSteer(store, { box, session }, at(500), true);
    expect(existsSync(join(box.dir, "001.json"))).toBe(true);
    expect(store.steerNote(id)!.liveSends).toBe(0);
    store.markLiveInputClosed(runId, at(600));
    expect(store.pauseStateOf(runId)).toBeNull();
    expect(store.liveInputRun(taskRef, at(700))).toBeNull();
  });
});

describe("pause requests at the store", () => {
  test("bound to the exact live run; a repeated request id is the same request; a stale run or a reused id is refused", () => {
    const first = store.requestPause({ taskId: "t-1", runId, by: verifiedAuthor("alex"), via: "web", requestId: "pause-request-a" }, T0);
    expect(first).toMatchObject({ ok: true, duplicate: false });
    expect(store.requestPause({ taskId: "t-1", runId, by: verifiedAuthor("alex"), via: "web", requestId: "pause-request-a" }, T0))
      .toMatchObject({ ok: true, duplicate: true, pause: first.ok ? first.pause : -1 });
    expect(store.requestPause({ taskId: "t-1", runId: runId + 1, by: verifiedAuthor("alex"), via: "web", requestId: "pause-request-b" }, T0))
      .toMatchObject({ ok: false, reason: "stale" });
    expect(store.requestPause({ taskId: "t-1", runId: runId + 1, by: verifiedAuthor("alex"), via: "web", requestId: "pause-request-a" }, T0))
      .toMatchObject({ ok: false, reason: "duplicate" });
    expect(store.requestPause({ taskId: "t-1", runId, by: verifiedAuthor("alex"), via: "web", requestId: "x" }, T0))
      .toMatchObject({ ok: false, reason: "invalid-request" });
    expect(store.pausesForTask(taskRef)).toHaveLength(1);
  });

  test("a build without live input (Codex, or a closed stdin) takes no pause, and a refused Pause and steer files no note", () => {
    store.markLiveInputClosed(runId, T0);
    expect(store.requestPause({ taskId: "t-1", runId, by: verifiedAuthor("alex"), via: "web", requestId: "pause-request-c", note: "a note" }, T0))
      .toMatchObject({ ok: false, reason: "stale" });
    expect(store.listSteerNotes(taskRef)).toEqual([]);
  });

  test("a note mailed to a later build starts its live delivery over", () => {
    const id = file("carry the guard");
    store.markSteerMailed(id, runId, T0);
    store.recordLiveSend(id, runId, T0);
    store.markLiveMissed(id, runId, T0);
    expect(store.steerNote(id)).toMatchObject({ liveSends: 1, liveMissedAt: T0.toISOString() });
    const later = store.startRun({ taskRef, leaseId: "lease-t-1", runner: "builder-1", branch: "feat/a", worktree, now: T0, ...presented(store, taskRef, "builder") });
    store.markSteerMailed(id, later, T0);
    expect(store.steerNote(id)).toMatchObject({ mailedRun: later, liveSends: 0, liveMissedAt: null });
  });
});

describe("the lead's propose_steer modes", () => {
  const lead = () => {
    // A stored password hash, assembled at run time.
    store.saveApprover("alex", ["ab"].join("").repeat(32), T0);
    const verified = verifyApproverStanding(store, "alex", store.accountOf("alex")!.generation, [LIVE_REPO]);
    if (!verified.ok) throw new Error(verified.reason);
    const drafted: { kind: string; payload: Record<string, unknown> }[] = [];
    const ctx = { store, who: verified.who, now: T0, step: 1, readDecisions: new Map<number, number>(),
      draft: (kind: string, payload: Record<string, unknown>) => { drafted.push({ kind, payload }); return drafted.length; } };
    return { ctx, drafted };
  };

  test("pause and pause-and-steer bind the card to the live build under one request id, and draft nothing else", () => {
    const { ctx, drafted } = lead();
    expect(executeLeadTool(ctx, "propose_steer", { task: "t-1", mode: "pause" })).toMatchObject({ ok: true, body: { kind: "steer", mode: "pause" } });
    expect(executeLeadTool(ctx, "propose_steer", { task: "t-1", mode: "pause-and-steer", note: "Keep the old guard." })).toMatchObject({ ok: true, body: { mode: "pause-and-steer" } });
    expect(drafted[0]!.payload).toMatchObject({ task: "t-1", mode: "pause", sawRun: runId, request: expect.stringMatching(/^lead-/) });
    expect(drafted[0]!.payload).not.toHaveProperty("note");
    expect(drafted[1]!.payload).toMatchObject({ mode: "pause-and-steer", sawRun: runId, note: "Keep the old guard." });
    // Drafting is never acting: nothing is paused or filed until the operator confirms.
    expect(store.pausesForTask(taskRef)).toEqual([]);
    expect(store.listSteerNotes(taskRef)).toEqual([]);
  });

  test("resume drafts only for a paused build, and confirming it sends Resume for the exact run it saw — no note, and a stale card is refused", () => {
    const { ctx, drafted } = lead();
    expect(executeLeadTool(ctx, "propose_steer", { task: "t-1", mode: "resume" })).toMatchObject({ ok: false, message: expect.stringContaining("isn't paused") });
    store.requestPause({ taskId: "t-1", runId, by: verifiedAuthor("alex"), via: "chat", requestId: "lead-pause-request-1" }, T0);
    store.markPauseSent(store.unsentPauses(runId)[0]!.id, T0);
    store.markRunPaused(runId, T0);
    expect(executeLeadTool(ctx, "get_task", { task: "t-1" })).toMatchObject({ ok: true, body: { liveBuild: { build: runId, pause: "paused" } } });
    expect(executeLeadTool(ctx, "propose_steer", { task: "t-1", mode: "resume" })).toMatchObject({ ok: true, body: { kind: "steer", mode: "resume" } });
    expect(drafted).toEqual([{ kind: "steer", payload: expect.objectContaining({ task: "t-1", mode: "resume", sawRun: runId, request: expect.stringMatching(/^lead-/) }) }]);
    expect(drafted[0]!.payload).not.toHaveProperty("note");

    // Confirmed through the lead's door: the same saved action the page and CLI use.
    const pending = (payload: Record<string, unknown>) => {
      const who = ctx.who;
      store.mintLeadSession({ approver: "alex", approverGeneration: who.generation, credentialKey: credentialKeyOf("anthropic-api", ["sk", "test"].join("-")), ceilingMicrousd: 5_000_000, ceilingDigest: who.ceilingDigest, termsDigest: "t".repeat(64) }, T0);
      const thread = store.openLeadThread("alex", who.ceilingDigest, T0).thread;
      const opened = store.openLeadTurn({ approver: "alex", session: store.activeLeadSession("alex")!.id, thread: thread.id, credentialKey: credentialKeyOf("anthropic-api", ["sk", "test"].join("-")), reservedMicrousd: 10, dailyTurns: 50, weeklyCeilingMicrousd: 25_000_000, deadlineMs: 60_000 }, T0);
      if (!opened.ok) throw new Error(opened.reason);
      const started = store.startLeadTurn(opened.id, T0);
      if (!started.ok) throw new Error("start");
      const id = store.draftLeadProposal({ thread: thread.id, turn: opened.id, kind: "steer", payload, ceilingDigest: who.ceilingDigest }, T0);
      store.finalizeLeadTurn(opened.id, started.generation, { state: "answered", settledMicrousd: 1, tokensIn: 1, tokensOut: 1 }, T0);
      return id;
    };
    const card = pending(drafted[0]!.payload);
    expect(confirmLeadProposal(store, ctx.who, card, T0, { via: "web" })).toMatchObject({ ok: true, said: expect.stringContaining("Resuming") });
    expect(store.resumesForTask(taskRef)).toMatchObject([{ run: runId, requestedVia: "chat" }]);
    expect(store.listSteerNotes(taskRef)).toEqual([]);
    // Once the build went on, a second card for the same pause is stale.
    store.markResumeSent(store.unsentResumes(runId)[0]!.id, runId, T0);
    const stale = pending({ ...drafted[0]!.payload, request: "lead-resume-stale-1" });
    expect(confirmLeadProposal(store, ctx.who, stale, T0, { via: "web" })).toMatchObject({ ok: false });
    expect(store.resumesForTask(taskRef)).toHaveLength(1);
  });

  test("with no running Claude build a pause is refused and a plain note still drafts", () => {
    store.markLiveInputClosed(runId, T0);
    const { ctx, drafted } = lead();
    expect(executeLeadTool(ctx, "propose_steer", { task: "t-1", mode: "pause" })).toMatchObject({ ok: false, message: expect.stringContaining("no running Claude build") });
    expect(executeLeadTool(ctx, "propose_steer", { task: "t-1", note: "Keep the old guard." })).toMatchObject({ ok: true, body: { mode: "note" } });
    expect(drafted).toHaveLength(1);
  });
});
