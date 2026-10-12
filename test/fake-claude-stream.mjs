// A stand-in for `claude -p --input-format stream-json --output-format stream-json`
// (Claude Code 2.1.290's live input, as Toolroll uses it). Test fixture only.
//
// - A stdin user frame that arrives while nothing runs starts a turn. A turn
//   is FAKE_STEPS assistant messages (default 1), each with its own id; each
//   step works for FAKE_TURN_MS, then runs its "tool" (one line appended to
//   FAKE_TOOLS). Then the turn ends with one result carrying its own usage
//   and num_turns (per message, as Claude reports them; total_cost_usd is
//   the session's running total). One process, a result per turn.
// - A user frame that arrives mid-turn is folded into the running turn, as
//   real Claude does: it is read when the current step's tool finishes, and
//   the turn takes one more step to answer it. It adds no result.
// - An interrupt control request ends the running turn at once with an
//   error result and a control_response; the process keeps waiting, and the
//   next user frame starts a new turn. Frames folded into the interrupted
//   turn and not yet read start the next turn instead.
// - stdin's end lets the running and queued turns finish, then the process
//   exits with the code of the last result (0 for success).
// - A brief naming STANDING-ORDERS-DONE-<hex>.json gets that handoff written
//   when a step's tool runs after FAKE_DONE_AFTER notes have been acted on
//   (default 1; 0 means the brief's first step).
// - A note frame naming "also saved as <folder>/<NNN>.json" is acted on (one
//   line appended to FAKE_WORK) and its file moved into handled/ (how an
//   agent acknowledges it), unless FAKE_IGNORE_NOTES. A reminder naming
//   "still unread: <folder>/<NNN>.json" carries no note text: it is acted on
//   only when that note has not been yet, and its file moved the same way.
// - Every frame received is appended to FAKE_FRAMES as one JSON line.
// - FAKE_HUGE_RESULTS (comma-separated 1-based result numbers) makes those
//   results larger than the transport's 512 KiB line cap, their words first
//   and their cost and usage after, as Claude orders them. FAKE_HUGE_AFTER
//   also pads after the cost, so neither end of the line carries it.
import { appendFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const stepMs = Number(process.env.FAKE_TURN_MS ?? "100");
const steps = Math.max(1, Number(process.env.FAKE_STEPS ?? "1"));
const doneAfter = Number(process.env.FAKE_DONE_AFTER ?? "1");
const framesLog = process.env.FAKE_FRAMES ?? null;
const toolsLog = process.env.FAKE_TOOLS ?? null;
const workLog = process.env.FAKE_WORK ?? null;
const ignoreNotes = process.env.FAKE_IGNORE_NOTES === "1";
const session = process.env.FAKE_SESSION ?? "fake-session";
const hugeResults = new Set(String(process.env.FAKE_HUGE_RESULTS ?? "").split(",").filter(one => one !== "").map(Number));
const hugeAfter = process.env.FAKE_HUGE_AFTER === "1";
const HUGE = "x".repeat(600 * 1024);
let resultCount = 0;

const say = event => process.stdout.write(`${JSON.stringify(event)}\n`);
let doneFile = null;
const acted = new Set();
let queue = [];
let running = null;
let ended = false;
let lastCode = 0;
let turnCount = 0;
let messageCount = 0;
let cost = 0;
let started = false;

/** Read one user frame: act on a note or a reminder, and remember the handoff a brief names. */
function take(frame) {
  const text = String(frame.message?.content ?? "");
  const named = /STANDING-ORDERS-DONE-[0-9a-f]{16}\.json/.exec(text);
  if (named !== null) doneFile = named[0];
  const note = /also saved as (\S+)\/(\d+\.json)/.exec(text);
  const reminder = note === null ? /still unread: (\S+)\/(\d+\.json)/.exec(text) : null;
  const found = note ?? reminder;
  if (found === null) return;
  const [, folder, file] = found;
  // A full note is acted on every time it arrives (an agent cannot tell it already did); a reminder only when unread.
  if (note !== null || !acted.has(file)) {
    acted.add(file);
    if (workLog !== null) appendFileSync(workLog, `${JSON.stringify({ note: file, via: note !== null ? "note" : "reminder" })}\n`);
  }
  if (ignoreNotes) return;
  try {
    mkdirSync(join(process.cwd(), folder, "handled"), { recursive: true });
    renameSync(join(process.cwd(), folder, file), join(process.cwd(), folder, "handled", file));
  } catch { /* the file was not there */ }
}

function result(turn, subtype) {
  cost += 0.01;
  resultCount += 1;
  const huge = hugeResults.has(resultCount);
  say({
    type: "result", subtype, is_error: subtype !== "success", session_id: session,
    ...(subtype === "success" ? { result: `turn ${turn.id} done${huge ? HUGE : ""}` } : huge ? { errors: [HUGE] } : {}),
    num_turns: turn.taken, total_cost_usd: Math.round(cost * 100) / 100,
    usage: { input_tokens: 10 * turn.taken, output_tokens: turn.taken, cache_read_input_tokens: 100 * turn.taken },
    ...(huge && hugeAfter ? { permission_denials: [{ tool_name: "Write", tool_input: { content: HUGE } }] } : {}),
  });
}

function step(turn) {
  messageCount += 1;
  turn.taken += 1;
  say({ type: "assistant", message: { id: `msg-${messageCount}`, role: "assistant", content: [{ type: "text", text: `turn ${turn.id}` }] }, parent_tool_use_id: null, session_id: session });
  turn.timer = setTimeout(() => {
    if (running !== turn) return;
    if (toolsLog !== null) appendFileSync(toolsLog, `${JSON.stringify({ turn: turn.id, message: messageCount })}\n`);
    if (doneFile !== null && acted.size >= doneAfter && !existsSync(join(process.cwd(), doneFile))) {
      writeFileSync(join(process.cwd(), doneFile), JSON.stringify({ version: 1, status: "completed", conclusion: "Added the guard and a test for it." }));
    }
    turn.left -= 1;
    // Frames that arrived during this step are read now, inside the same turn, and answered with one more step.
    if (turn.folded.length > 0) {
      for (const frame of turn.folded.splice(0)) take(frame);
      turn.left += 1;
    }
    if (turn.left > 0) return step(turn);
    running = null;
    lastCode = 0;
    result(turn, "success");
    startNext();
  }, stepMs);
}

function startNext() {
  if (running !== null) return;
  const frame = queue.shift();
  if (frame === undefined) {
    // After stdout drains: a large result must reach the reader whole.
    if (ended) process.stdout.write("", () => process.exit(lastCode));
    return;
  }
  if (!started) {
    started = true;
    say({ type: "system", subtype: "init", session_id: session, model: "claude-test" });
  }
  turnCount += 1;
  const turn = { id: turnCount, left: steps, taken: 0, folded: [], timer: null };
  running = turn;
  take(frame);
  step(turn);
}

const lines = createInterface({ input: process.stdin });
lines.on("line", line => {
  if (line.trim() === "") return;
  const frame = JSON.parse(line);
  if (framesLog !== null) appendFileSync(framesLog, `${JSON.stringify(frame)}\n`);
  if (frame.type === "user") {
    if (running !== null) running.folded.push(frame);
    else {
      queue.push(frame);
      startNext();
    }
  } else if (frame.type === "control_request" && frame.request?.subtype === "interrupt") {
    const turn = running;
    say({ type: "control_response", response: { subtype: "success", request_id: frame.request_id } });
    if (turn !== null) {
      clearTimeout(turn.timer);
      running = null;
      lastCode = 1;
      queue.unshift(...turn.folded.splice(0));
      result(turn, "error_during_execution");
      startNext();
    }
  }
});
lines.on("close", () => {
  ended = true;
  if (running === null) startNext();
});
