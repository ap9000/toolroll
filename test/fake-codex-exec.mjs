// A stand-in for `codex exec [resume <id>] --json … <prompt>` as codex-cli
// 0.156.1 behaved in the C0 spike (agents-cockpit plan). Test fixture only.
//
// - stdout carries thread.started, turn.started, item.started/item.completed
//   for each "command", and on a natural end an agent_message then
//   turn.completed with usage. Exit 0.
// - The rollout goes to $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<local time>-
//   <thread>.jsonl as Codex writes it: session_meta first, then per turn a
//   task_started, token_count running totals, and task_complete — or, on
//   SIGINT, turn_aborted (reason interrupted). A resume appends to the same
//   file and keeps the thread id.
// - A turn is FAKE_CODEX_STEPS commands (FAKE_CODEX_RESUME_STEPS on a
//   resume; defaults 2 and 1), each a real child process alive for
//   FAKE_CODEX_STEP_MS, with FAKE_CODEX_THINK_MS between them when no
//   command runs. Each finished command appends one line to FAKE_CODEX_TOOLS.
// - SIGINT kills the running command, writes turn_aborted and exits 1 with
//   no stdout terminal event. SIGTERM exits 0 with no record (as observed).
//   FAKE_CODEX_IGNORE_INT=1 ignores SIGINT. FAKE_CODEX_ORPHAN=1 starts each
//   command in its own process group and leaves it running on SIGINT.
//   FAKE_CODEX_ROLLOUT=none writes no rollout at all.
// - The handoff a brief names (STANDING-ORDERS-DONE-<hex>.json) is written
//   when a turn ends naturally, a resumed turn included (the name is found
//   in the rollout's first prompt).
// - Every invocation appends {thread, resumed, prompt} to FAKE_CODEX_LOG.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
if (argv[0] !== "exec") process.exit(2);
const resumed = argv[1] === "resume" ? argv[2] : null;
const prompt = argv.at(-1) ?? "";
const env = process.env;
const steps = Number((resumed === null ? env.FAKE_CODEX_STEPS : env.FAKE_CODEX_RESUME_STEPS) ?? (resumed === null ? "2" : "1"));
const stepMs = Number(env.FAKE_CODEX_STEP_MS ?? "200");
const thinkMs = Number(env.FAKE_CODEX_THINK_MS ?? "50");
const writeRollout = env.FAKE_CODEX_ROLLOUT !== "none";
const thread = resumed ?? env.FAKE_CODEX_THREAD ?? randomUUID();
const turnId = randomUUID();
const sessions = join(env.CODEX_HOME ?? join(env.HOME ?? ".", ".codex"), "sessions");
const pad = n => String(n).padStart(2, "0");

const say = event => process.stdout.write(`${JSON.stringify(event)}\n`);
if (env.FAKE_CODEX_LOG) appendFileSync(env.FAKE_CODEX_LOG, `${JSON.stringify({ thread, resumed: resumed !== null, prompt })}\n`);

function findRollout(dir) {
  if (!existsSync(dir)) return null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { const found = findRollout(path); if (found !== null) return found; }
    else if (entry.name.endsWith(`-${thread}.jsonl`)) return path;
  }
  return null;
}
let rollout = resumed === null ? null : findRollout(sessions);
const record = (type, payload) => {
  if (!writeRollout) return;
  if (rollout === null) {
    const now = new Date();
    const dir = join(sessions, String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()));
    mkdirSync(dir, { recursive: true });
    rollout = join(dir, `rollout-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}-${thread}.jsonl`);
    writeFileSync(rollout, `${JSON.stringify({ timestamp: now.toISOString(), type: "session_meta", payload: { id: thread, session_id: thread, cwd: process.cwd() } })}\n`);
  }
  appendFileSync(rollout, `${JSON.stringify({ timestamp: new Date().toISOString(), type, payload })}\n`);
};

// The running totals carry over a resume, as Codex's do.
let totals = { input_tokens: 0, output_tokens: 0 };
if (rollout !== null) {
  for (const line of readFileSync(rollout, "utf8").split("\n")) {
    if (line === "") continue;
    const row = JSON.parse(line);
    if (row.payload?.type === "token_count") totals = { ...row.payload.info.total_token_usage };
  }
}
const firstPrompt = () => {
  if (rollout === null) return prompt;
  for (const line of readFileSync(rollout, "utf8").split("\n")) {
    if (line === "") continue;
    const row = JSON.parse(line);
    if (row.type === "response_item" && row.payload?.role === "user") return String(row.payload.content?.[0]?.text ?? "");
  }
  return prompt;
};

say({ type: "thread.started", thread_id: thread });
record("event_msg", { type: "task_started", turn_id: turnId });
record("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] });
say({ type: "turn.started" });

let tool = null;
let ended = false;
const spend = (input, output) => {
  totals = { input_tokens: totals.input_tokens + input, output_tokens: totals.output_tokens + output };
  record("event_msg", { type: "token_count", info: { total_token_usage: totals, last_token_usage: { input_tokens: input, output_tokens: output } } });
};
let turnIn = 0, turnOut = 0;

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => {
  if (env.FAKE_CODEX_IGNORE_INT === "1" || ended) return;
  ended = true;
  if (tool !== null && env.FAKE_CODEX_ORPHAN !== "1") tool.kill("SIGKILL");
  record("event_msg", { type: "turn_aborted", turn_id: turnId, reason: "interrupted" });
  process.exit(1);
});

async function main() {
  for (let n = 1; n <= steps; n += 1) {
    await new Promise(resolve => setTimeout(resolve, thinkMs));
    if (ended) return;
    spend(100, 5); turnIn += 100; turnOut += 5;
    const id = `item_${n}`;
    const command = `step ${n}`;
    say({ type: "item.started", item: { id, type: "command_execution", command, status: "in_progress" } });
    tool = spawn(process.execPath, ["-e", `setTimeout(() => {}, ${stepMs})`], { stdio: "ignore", detached: env.FAKE_CODEX_ORPHAN === "1" });
    if (env.FAKE_CODEX_TOOL_PIDS) appendFileSync(env.FAKE_CODEX_TOOL_PIDS, `${tool.pid}\n`);
    const code = await new Promise(resolve => tool.on("exit", resolve));
    tool = null;
    if (ended) return;
    if (env.FAKE_CODEX_TOOLS) appendFileSync(env.FAKE_CODEX_TOOLS, `${JSON.stringify({ thread, resumed: resumed !== null, step: n })}\n`);
    say({ type: "item.completed", item: { id, type: "command_execution", command, status: "completed", exit_code: code ?? 0 } });
  }
  if (ended) return;
  const named = /STANDING-ORDERS-DONE-[0-9a-f]{16}\.json/.exec(firstPrompt()) ?? /STANDING-ORDERS-DONE-[0-9a-f]{16}\.json/.exec(prompt);
  if (named !== null && !existsSync(join(process.cwd(), named[0]))) {
    writeFileSync(join(process.cwd(), named[0]), JSON.stringify({ version: 1, status: "completed", conclusion: "Added the guard and a test for it." }));
  }
  ended = true;
  say({ type: "item.completed", item: { id: "item_msg", type: "agent_message", text: "DONE" } });
  record("event_msg", { type: "task_complete", turn_id: turnId, last_agent_message: "DONE" });
  say({ type: "turn.completed", usage: { input_tokens: turnIn, cached_input_tokens: 0, output_tokens: turnOut } });
  process.stdout.write("", () => process.exit(0));
}
main();
