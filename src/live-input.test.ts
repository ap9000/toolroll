import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTINUE_TEXT, LiveInput, interruptFrame, userFrame, type LiveCloseReason } from "./live-input.js";
import { runClaudeStreamJsonl, streamsInput } from "./exec.js";
import { adapterFor } from "./provider.js";
import { liveNoteText, liveReminderText } from "./steer-live.js";

const FAKE = fileURLToPath(new URL("../test/fake-claude-stream.mjs", import.meta.url));

/** A session over a recording stdin. */
function recorded(options: Partial<ConstructorParameters<typeof LiveInput>[0]> = {}) {
  const lines: Record<string, unknown>[] = [];
  const closes: LiveCloseReason[] = [];
  let ended = false, paused = 0, opened = 0;
  const session = new LiveInput({
    maxTurns: 50,
    onOpen: () => { opened += 1; },
    onClose: why => { closes.push(why); },
    onPaused: () => { paused += 1; },
    ...options,
  });
  const io = { write: (line: string) => { lines.push(JSON.parse(line)); }, end: () => { ended = true; } };
  return { session, lines, closes, io, ended: () => ended, paused: () => paused, opened: () => opened };
}
const assistant = (id: string) => ({ type: "assistant", message: { id }, parent_tool_use_id: null });
const result = (subtype = "success") => ({ type: "result", subtype, is_error: subtype !== "success" });

describe("a Claude build's live input", () => {
  test("the brief is the first stdin frame, with its own uuid, written when the process attaches", () => {
    const { session, lines, io, opened } = recorded();
    session.begin("You are building one task", "brief-uuid-1");
    expect(lines).toEqual([]);
    session.attach(io);
    expect(lines).toEqual([{ type: "user", message: { role: "user", content: "You are building one task" }, uuid: "brief-uuid-1" }]);
    expect(opened()).toBe(1);
    expect(session.open).toBe(true);
    expect(() => session.begin("again")).toThrow();
  });

  test("a note written mid-turn is folded into the running turn: that turn's result closes stdin once the handoff is written", () => {
    let finished = false;
    const { session, lines, closes, io, ended } = recorded({ finished: () => finished });
    session.begin("brief");
    session.attach(io);
    session.observe(assistant("m1"));
    expect(session.send("note 1", "note-uuid")).toBe(true);
    // Claude reads it when the tool call ends and answers inside the same turn: no second result is owed.
    session.observe(assistant("m2"));
    finished = true;
    session.observe(result());
    expect(ended()).toBe(true);
    expect(closes).toEqual(["finished"]);
    expect(session.closeReason).toBe("finished");
    expect(lines.map(one => one["uuid"])).toEqual([expect.any(String), "note-uuid"]);
    expect(session.send("too late", "x")).toBe(false);
  });

  test("a turn that ends with nothing owed and no handoff closes stdin, so the process exits as a -p run did", () => {
    const { session, closes, io, ended } = recorded();
    session.begin("brief");
    session.attach(io);
    session.observe(assistant("m1"));
    session.observe(result());
    expect(ended()).toBe(true);
    expect(closes).toEqual(["settled"]);
  });

  test("Pause interrupts the running turn and keeps the session; the next note continues it", () => {
    const { session, lines, io, ended, paused } = recorded();
    session.begin("brief");
    session.attach(io);
    session.observe(assistant("m1"));
    expect(session.interrupt("pause-1")).toBe("sent");
    expect(lines.at(-1)).toEqual(JSON.parse(interruptFrame("pause-1")));
    session.observe({ type: "control_response", response: { subtype: "success", request_id: "pause-1" } });
    session.observe(result("error_during_execution"));
    expect(paused()).toBeGreaterThanOrEqual(1);
    expect(session.paused).toBe(true);
    // Paused, not ended: stdin stays open for the next note.
    expect(ended()).toBe(false);
    expect(session.interrupt("pause-2")).toBe("idle");
    expect(session.send("carry on with the smaller diff", "note-2")).toBe(true);
    expect(session.paused).toBe(false);
    expect(lines.at(-1)).toEqual(JSON.parse(userFrame("carry on with the smaller diff", "note-2")));
    session.observe(assistant("m2"));
    session.observe(result());
    expect(ended()).toBe(true);
  });

  test("Pause and steer: the interrupted turn's result waits for the note's own turn", () => {
    const { session, io, ended } = recorded();
    session.begin("brief");
    session.attach(io);
    session.observe(assistant("m1"));
    session.interrupt("pause-1");
    session.send("switch to the retry path", "note-1");
    session.observe(result("error_during_execution"));
    expect(ended()).toBe(false);
    session.observe(assistant("m2"));
    session.observe(result());
    expect(ended()).toBe(true);
  });

  test("the total turn budget lets the last allowed turn run in full and interrupts only when the next one starts", () => {
    const { session, lines, closes, io, ended } = recorded({ maxTurns: 3 });
    session.begin("brief");
    session.attach(io);
    session.observe(assistant("m1"));
    session.observe(assistant("m1"));
    session.observe(assistant("m2"));
    session.observe(assistant("m3"));
    // Turn 3 is the last allowed: its tools still run.
    expect(session.turns).toBe(3);
    expect(ended()).toBe(false);
    expect(lines.at(-1)?.["type"]).toBe("user");
    session.observe(assistant("m4"));
    expect(lines.at(-1)?.["type"]).toBe("control_request");
    expect(ended()).toBe(true);
    expect(closes).toEqual(["turn-budget"]);
    expect(session.closeReason).toBe("turn-budget");
  });

  test("Resume sends a paused session only a short continue frame; a running one has nothing to resume", () => {
    const { session, lines, io, ended } = recorded();
    session.begin("brief");
    session.attach(io);
    session.observe(assistant("m1"));
    expect(session.resume("resume-0")).toBe("not-paused");
    session.interrupt("pause-1");
    session.observe(result("error_during_execution"));
    expect(session.resume("resume-1")).toBe("sent");
    expect(lines.at(-1)).toEqual({ type: "user", message: { role: "user", content: CONTINUE_TEXT }, uuid: "resume-1" });
    expect(CONTINUE_TEXT).toBe("continue");
    expect(session.paused).toBe(false);
    session.observe(assistant("m2"));
    session.observe(result());
    expect(ended()).toBe(true);
    expect(session.resume("resume-2")).toBe("closed");
  });

  test("at the idle limit a paused session closes stdin and settles; a working one is left to time out", () => {
    const { session, closes, io, ended } = recorded();
    session.begin("brief");
    session.attach(io);
    session.observe(assistant("m1"));
    expect(session.idleLimit()).toBe(false);
    expect(ended()).toBe(false);
    session.interrupt("pause-1");
    session.observe(result("error_during_execution"));
    expect(session.idleLimit()).toBe(true);
    expect(ended()).toBe(true);
    expect(closes).toEqual(["paused-idle"]);
    expect(session.closeReason).toBe("paused-idle");
    // Once closed, the next limit is an ordinary timeout.
    expect(session.idleLimit()).toBe(false);
  });

  test("a subagent's words and a background task's result are not the session's", () => {
    const { session, io, ended } = recorded({ maxTurns: 1 });
    session.begin("brief");
    session.attach(io);
    session.observe({ type: "assistant", message: { id: "sub" }, parent_tool_use_id: "tool-1" });
    session.observe({ type: "result", subtype: "success", origin: { kind: "task-notification" } });
    expect(ended()).toBe(false);
  });

  test("a failed write ends live input instead of throwing", () => {
    const { session, closes } = recorded();
    session.begin("brief");
    session.attach({ write: () => { throw new Error("EPIPE"); }, end: () => {} });
    expect(session.open).toBe(false);
    expect(closes).toEqual(["input-failed"]);
    expect(session.send("x", "y")).toBe(false);
    expect(session.interrupt("p")).toBe("closed");
  });
});

describe("the Claude stream transport with live input (a real child process)", () => {
  let dir = "";
  afterEach(() => { if (dir !== "") rmSync(dir, { recursive: true, force: true }); dir = ""; });

  test("the stream-json transport declares it keeps stdin open; an ordinary runner does not", () => {
    expect(streamsInput(runClaudeStreamJsonl)).toBe(true);
    expect(streamsInput(async () => ({ code: 0, stdout: "", stderr: "", timedOut: false, notFound: false }))).toBe(false);
  });

  test("the brief is the first frame on stdin, a mid-turn note is folded, several results settle once, and usage adds up across them", async () => {
    dir = mkdtempSync(join(tmpdir(), "so-live-"));
    const frames = join(dir, "frames.jsonl"), work = join(dir, "work.jsonl");
    writeFileSync(frames, "");
    let finished = false;
    const closes: LiveCloseReason[] = [];
    const session = new LiveInput({ maxTurns: 20, finished: () => finished, onClose: why => closes.push(why) });
    session.begin("You are building one task, unattended.", "brief-uuid");
    const results: Record<string, unknown>[] = [];
    const result = await runClaudeStreamJsonl(process.execPath, [FAKE], {
      cwd: dir,
      timeoutMs: 20_000,
      env: { FAKE_FRAMES: frames, FAKE_WORK: work, FAKE_TURN_MS: "150", FAKE_STEPS: "2", FAKE_DONE_AFTER: "99" },
      liveInput: session,
      onStreamEvent: event => {
        const id = event["type"] === "assistant" ? (event["message"] as { id: string }).id : null;
        // As the dispatcher would (after the event is seen): Pause the brief's turn, Resume it, then one note mid-turn.
        if (id === "msg-1") setImmediate(() => session.interrupt("pause-1"));
        if (event["type"] === "result") {
          results.push(event);
          if (results.length === 1) setImmediate(() => session.resume("resume-1"));
        }
        if (id === "msg-2") setImmediate(() => session.send("Operator steering note 1, also saved as notes/001.json: keep the API", "note-1"));
        if (id === "msg-4") finished = true;
      },
    });
    const written = readFileSync(frames, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
    expect(written[0]).toEqual({ type: "user", message: { role: "user", content: "You are building one task, unattended." }, uuid: "brief-uuid" });
    expect(written.map(one => one["type"])).toEqual(["user", "control_request", "user", "user"]);
    // The note was read inside the resumed turn (one more step), not as a turn of its own: two results in all.
    expect(readFileSync(work, "utf8").trim().split("\n")).toHaveLength(1);
    expect(results.map(one => one["subtype"])).toEqual(["error_during_execution", "success"]);
    expect(closes).toEqual(["finished"]);
    expect(result.code).toBe(0);
    // The account: the last result's session, words and running cost, with usage and turns added up across both.
    const parsed = adapterFor("claude").parse(result.stdout);
    expect(parsed).toMatchObject({ sessionId: "fake-session", finalMessage: "turn 2 done", costUsd: 0.02, tokensIn: 40, tokensOut: 4, promptConsumed: true, ending: { subtype: "success", turns: 4 } });
    expect(JSON.parse(parsed.usageRaw!)).toMatchObject({ input_tokens: 40, output_tokens: 4, cache_read_input_tokens: 400 });
  });

  test("the turn budget lets the last allowed turn's tool run, then ends the process with Toolroll's reason", async () => {
    dir = mkdtempSync(join(tmpdir(), "so-live-"));
    const tools = join(dir, "tools.jsonl");
    writeFileSync(tools, "");
    const session = new LiveInput({ maxTurns: 2 });
    session.begin("brief", "brief-uuid");
    const result = await runClaudeStreamJsonl(process.execPath, [FAKE], {
      cwd: dir, timeoutMs: 20_000, liveInput: session,
      env: { FAKE_TOOLS: tools, FAKE_TURN_MS: "100", FAKE_STEPS: "5" },
    });
    // Two turns' tools ran; the third turn was interrupted as it started.
    expect(readFileSync(tools, "utf8").trim().split("\n")).toHaveLength(2);
    expect(session.closeReason).toBe("turn-budget");
    expect(result.code).toBe(1);
    expect(adapterFor("claude").parse(result.stdout)).toMatchObject({ ending: { subtype: "error_during_execution", turns: 3 } });
  });

  test("a paused session reaching the idle limit has its stdin closed and exits on its own, not killed as a timeout", async () => {
    dir = mkdtempSync(join(tmpdir(), "so-live-"));
    const session = new LiveInput({ maxTurns: 20 });
    session.begin("brief", "brief-uuid");
    const result = await runClaudeStreamJsonl(process.execPath, [FAKE], {
      cwd: dir, idleTimeoutMs: 400, liveInput: session,
      env: { FAKE_TURN_MS: "5000" },
      onStreamEvent: event => { if (event["type"] === "assistant") session.interrupt("pause-1"); },
    });
    expect(session.closeReason).toBe("paused-idle");
    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(1);
  });

  test("a re-sent reminder names the file without the note, so an agent that already acted on it does not redo the work", async () => {
    dir = mkdtempSync(join(tmpdir(), "so-live-"));
    const work = join(dir, "work.jsonl");
    let finished = false;
    const session = new LiveInput({ maxTurns: 20, finished: () => finished });
    session.begin("brief", "brief-uuid");
    const box = { folder: "notes", key: "k", runId: 1, dir: join(dir, "notes"), waiting: new Map() } as unknown as Parameters<typeof liveReminderText>[0];
    const note = { note: "keep the API" } as unknown as Parameters<typeof liveNoteText>[2];
    await runClaudeStreamJsonl(process.execPath, [FAKE], {
      cwd: dir, timeoutMs: 20_000, liveInput: session,
      // The agent acts on notes but never moves the file: every follow-up the dispatcher may send arrives.
      env: { FAKE_WORK: work, FAKE_TURN_MS: "100", FAKE_IGNORE_NOTES: "1" },
      onStreamEvent: event => {
        const id = event["type"] === "assistant" ? (event["message"] as { id: string }).id : null;
        if (id === "msg-1") setImmediate(() => session.send(liveNoteText(box, 1, note), "note-1"));
        if (id === "msg-2" || id === "msg-3") setImmediate(() => session.send(liveReminderText(box, 1), `reminder-${id}`));
        if (id === "msg-4") finished = true;
      },
    });
    expect(liveReminderText(box, 1)).not.toContain("keep the API");
    expect(liveReminderText(box, 1)).toContain("notes/001.json");
    expect(readFileSync(work, "utf8").trim().split("\n").map(line => JSON.parse(line))).toEqual([{ note: "001.json", via: "note" }]);
  });

  test("an oversized first result closes stdin, so later notes run no turns, and its cost is unknown: nothing inside it is trusted", async () => {
    dir = mkdtempSync(join(tmpdir(), "so-live-"));
    const frames = join(dir, "frames.jsonl");
    writeFileSync(frames, "");
    const sent: boolean[] = [];
    // As the dispatcher would once the first turn ends: two notes, each of which would start a turn of its own.
    const session: LiveInput = new LiveInput({ maxTurns: 20, onClose: () => { sent.push(session.send("note one", "n-1"), session.send("note two", "n-2")); } });
    session.begin("brief", "brief-uuid");
    const result = await runClaudeStreamJsonl(process.execPath, [FAKE], {
      cwd: dir, timeoutMs: 20_000, liveInput: session,
      env: { FAKE_FRAMES: frames, FAKE_TURN_MS: "50", FAKE_HUGE_RESULTS: "1" },
    });
    // Closed on the oversized result itself: the process ended on its own, not at the timeout with stdin still open.
    expect(session.closeReason).toBe("settled");
    expect(result.timedOut).toBe(false);
    expect(sent).toEqual([false, false]);
    expect(readFileSync(frames, "utf8").trim().split("\n").map(line => (JSON.parse(line) as { uuid: string }).uuid)).toEqual(["brief-uuid"]);
    const parsed = adapterFor("claude").parse(result.stdout);
    // The words were too large to keep, so the run fails closed; the agent shapes those bytes, so a cost read from
    // them could be planted. Its cost is unknown and the gateway charges the run's cap.
    expect(parsed.structuralTerminal).toMatchObject({ failed: true, code: "standing-orders-stream-event-overflow" });
    expect(parsed).toMatchObject({ costUsd: null, costUnknown: true });
  });

  test("an oversized first result whose cost is out of reach at both ends is marked cost-unknown, never free", async () => {
    dir = mkdtempSync(join(tmpdir(), "so-live-"));
    const session = new LiveInput({ maxTurns: 20 });
    session.begin("brief", "brief-uuid");
    const result = await runClaudeStreamJsonl(process.execPath, [FAKE], {
      cwd: dir, timeoutMs: 20_000, liveInput: session,
      env: { FAKE_TURN_MS: "50", FAKE_HUGE_RESULTS: "1", FAKE_HUGE_AFTER: "1" },
    });
    expect(session.closeReason).toBe("settled");
    expect(adapterFor("claude").parse(result.stdout)).toMatchObject({ costUsd: null, costUnknown: true });
  });

  test("an oversized last result after Pause and Resume makes the session's cost unknown, never lower", async () => {
    dir = mkdtempSync(join(tmpdir(), "so-live-"));
    const session = new LiveInput({ maxTurns: 20 });
    session.begin("brief", "brief-uuid");
    let results = 0;
    const result = await runClaudeStreamJsonl(process.execPath, [FAKE], {
      cwd: dir, timeoutMs: 20_000, liveInput: session,
      env: { FAKE_TURN_MS: "200", FAKE_HUGE_RESULTS: "2" },
      onStreamEvent: event => {
        if (event["type"] === "assistant" && (event["message"] as { id: string }).id === "msg-1") setImmediate(() => session.interrupt("pause-1"));
        if (event["type"] === "result" && ++results === 1) setImmediate(() => session.resume("resume-1"));
      },
    });
    // The second result (the resumed turn's) was too large: stdin closed on it, and nothing waited for an idle limit.
    expect(results).toBe(1);
    expect(session.closeReason).toBe("settled");
    const parsed = adapterFor("claude").parse(result.stdout);
    expect(parsed.costUnknown).toBe(true);
  });
});
