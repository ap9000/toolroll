#!/usr/bin/env node
/**
 * A scripted stand-in for the `claude` and `codex` CLIs, for the browser journeys. A journey that tests Toolroll's
 * own behaviour (approvals, results, flows moving cards, chat buttons, storage) runs against the real CLI, console,
 * worker, git and browser; only the model is scripted. Toolroll finds the stand-in on the world's PATH and talks to it
 * exactly as it talks to the real CLIs (src/provider.ts, src/invoke.ts, src/exec.ts, src/subscription-chat.ts,
 * src/teammates.ts, src/flow-draft.ts, src/task-sizing.ts):
 *
 *   claude  -p … --output-format json | stream-json [--json-schema …] [--resume <id>]
 *   codex   exec [resume <id>] --json … [--output-schema <file>] <brief | ->
 *
 * It answers at once from the world's script: rules a journey adds (`add`) before it acts, each matching a kind of
 * turn and the words in it, then the defaults below for the turns every world makes in the background (task sizing,
 * the automatic reviewer, a plan for a filed task, a build with nothing to change). A turn nothing answers fails
 * loudly, named in the journal and on stderr: the stand-in never makes a model call or makes an answer up.
 *
 * Roles, and what an answer is:
 *   lead      { steps: [{ text, calls: [{ name, arguments }] }, …] } — one step per process; a step's calls are the
 *             lead's tool calls (Toolroll runs them and starts the next step with their results); the last step's
 *             calls are []. `when` matches the operator's last message.
 *   teammate  the TURN_SCHEMA answer ({ action, answer, text, note, question, options, reason, tool, input, remember });
 *             unset fields are "" ([] for options), and an object `input` is written as JSON.
 *   draft     { text }                       sizing { size, risky, reason }      reviewer { findings }
 *   memory    { positive, negative, gaps }   scout  { report } or { decision }
 *   planner   { plan: { goal, acceptance, … } } (any field left out comes from the task's title) or { question }:
 *             written to the nonce-bound PLAN or PARK file the brief names, and nothing else changes.
 *   builder   { files: { path: text }, status, conclusion } or { park: { question, options, … } }: the files are
 *             written in the worktree, uncommitted, then the nonce-bound handoff (or park) file the brief names.
 *   any role  { delayMs } waits first; { mcp: [{ server, tool, arguments }] } calls tools of the MCP servers the run
 *             was given (--mcp-config); { fail: "why" } fails the turn the way the CLI does.
 *
 * A rule: { role, when: [regex source…], unless: [regex source…], provider, resume: true|false, times, answer }.
 * Rules are tried in order and the first that matches answers; one with `times` answers that many turns, claimed
 * atomically, so concurrent turns never take the same answer twice.
 *
 * The same file counts real turns: `countingProvider` puts shims on the PATH that write each call to a journal and
 * then run the real CLI, unchanged. Both journals are one JSON line per call: { at, provider, role, turn, mode, … }.
 */
import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { randomUUID } from "node:crypto";
import { accessSync, appendFileSync, chmodSync, constants, existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PROVIDERS = ["claude", "codex"];
const SELF = fileURLToPath(import.meta.url);
const SCRIPTED_ENV = "TOOLROLL_SCRIPTED_PROVIDER", COUNT_ENV = "TOOLROLL_COUNTED_PROVIDER", REAL_ENV = "TOOLROLL_REAL_PROVIDER";
const JOURNAL = "journal.jsonl", RULES = "rules.json", USED = "used";

// ------------------------------------------------------------------ for the journeys

const shellWord = text => `'${String(text).replace(/'/g, "'\\''")}'`;
/** A `claude` or `codex` on the PATH that runs this file with the given settings baked in: nothing depends on the
 * environment a caller passes on (a fresh install's own PATH and home, the agents' fence). */
function shim(bin, provider, settings) {
  const file = join(bin, provider);
  const env = Object.entries(settings).map(([name, value]) => `${name}=${shellWord(value)}`).join(" ");
  writeFileSync(file, `#!/bin/sh\n${env} exec ${shellWord(process.execPath)} ${shellWord(SELF)} ${provider} "$@"\n`);
  chmodSync(file, 0o755);
  return file;
}

/** Where `name` is on `path`, skipping the folders in `skip`; null when it isn't. */
export function which(name, path = process.env.PATH ?? "", skip = []) {
  for (const folder of path.split(delimiter)) {
    if (folder === "" || skip.includes(resolve(folder))) continue;
    try { accessSync(join(folder, name), constants.X_OK); return join(folder, name); } catch { /* not here */ }
  }
  return null;
}

/** The world's scripted provider, in `dir`: `bin` goes first on the PATH; `add` scripts answers for a journey. */
export function scriptedProvider(dir) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true }); mkdirSync(join(dir, USED), { recursive: true });
  const rules = [];
  const save = () => { writeFileSync(join(dir, `${RULES}.part`), JSON.stringify({ rules }, null, 2)); renameSync(join(dir, `${RULES}.part`), join(dir, RULES)); };
  save();
  const shims = Object.fromEntries(PROVIDERS.map(provider => [provider, shim(bin, provider, { [SCRIPTED_ENV]: dir })]));
  return {
    mode: "scripted", dir, bin, shims,
    /** Script answers for `journey`; each rule's regexes may be RegExp objects. Returns the rules' ids. */
    add(journey, ...more) {
      const ids = [];
      for (const rule of more.flat()) {
        if (!ROLES.includes(rule.role)) throw new Error(`a scripted answer needs a role (${ROLES.join(", ")}): ${JSON.stringify(rule).slice(0, 200)}`);
        const id = `r${rules.length + 1}`;
        rules.push({ ...rule, id, journey, when: [rule.when ?? []].flat().map(source), unless: [rule.unless ?? []].flat().map(source) });
        ids.push(id);
      }
      save();
      return ids;
    },
    journal: () => readJournal(dir),
  };
}

/** Shims that write every call to the journal in `dir` and run the real CLI, unchanged. Providers that aren't
 * installed get no shim, so they stay missing. */
export function countingProvider(dir, path = process.env.PATH ?? "") {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const shims = {};
  for (const provider of PROVIDERS) {
    const real = which(provider, path, [resolve(bin)]);
    if (real !== null) shims[provider] = shim(bin, provider, { [COUNT_ENV]: dir, [REAL_ENV]: real });
  }
  return { mode: "real", dir, bin, shims, add: () => [], journal: () => readJournal(dir) };
}

const source = one => one instanceof RegExp ? { source: one.source, flags: one.flags } : { source: String(one), flags: "" };

export function readJournal(dir) {
  try { return readFileSync(join(dir, JOURNAL), "utf8").split("\n").filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); } catch { return []; }
}

/** What a journal says: model turns (a CLI asked to answer), how many were scripted, real and unanswered. */
export function turnsOf(entries) {
  const turns = entries.filter(one => one.turn);
  return { turns: turns.length, scripted: turns.filter(one => one.mode === "scripted" && one.ok).length, real: turns.filter(one => one.mode === "real").length, unscripted: turns.filter(one => one.mode === "scripted" && !one.ok && one.rule === null).length };
}

// ------------------------------------------------------------------ the stand-in

export const ROLES = ["lead", "teammate", "draft", "sizing", "reviewer", "memory", "scout", "planner", "builder"];
const DONE_FILE = /write ONE file named exactly (STANDING-ORDERS-DONE-[0-9a-f]{16}\.json)/;
const PLAN_FILE = /`(STANDING-ORDERS-PLAN-[0-9a-f]{16}\.json)`/;
const PARK_FILE = /(STANDING-ORDERS-PARK-[0-9a-f]{16}\.json)/;

/** What every world answers when no journey scripted the turn: the turns a world makes in the background. */
export const DEFAULTS = {
  sizing: { size: "small", risky: false, reason: "A small change to one file." },
  reviewer: { findings: [] },
  memory: { positive: [], negative: [], gaps: [] },
  scout: { report: { title: "Report", summary: "Nothing stood out.", report: "Read the project; nothing stood out." } },
  planner: { plan: {} },
  builder: { status: "no-change", conclusion: "Nothing to change: the project already does this." },
};

/** The parts of a CLI call that decide what it is and how it answers. */
export function readCall(provider, argv) {
  const value = flag => { const at = argv.lastIndexOf(flag); return at === -1 ? null : argv[at + 1] ?? null; };
  const all = flag => argv.flatMap((one, at) => one === flag && at + 1 < argv.length ? [argv[at + 1]] : []);
  const json = text => { try { return JSON.parse(text); } catch { return null; } };
  if (provider === "claude") {
    const at = argv.indexOf("-p");
    const inline = at !== -1 && at + 1 < argv.length && !argv[at + 1].startsWith("-") ? argv[at + 1] : null;
    const format = value("--output-format") ?? "text";
    return {
      provider, prompt: inline, format,
      schema: json(value("--json-schema") ?? "null"), resume: value("--resume"), session: value("--session-id"),
      mcp: all("--mcp-config"), tools: value("--tools"), permission: value("--permission-mode"),
    };
  }
  const resumeAt = argv[0] === "exec" && argv[1] === "resume" ? 2 : -1;
  const last = argv.at(-1);
  const schemaFile = value("--output-schema");
  return {
    provider, prompt: last === "-" || last === undefined || last.startsWith("-") ? null : last, format: "codex",
    schema: schemaFile === null ? null : json(readFileSync(schemaFile, "utf8")), resume: resumeAt === -1 ? null : argv[resumeAt], session: null,
    mcp: [], tools: null, permission: null,
  };
}

/** Which kind of turn this is, from its schema and its words. */
export function roleOf(call, prompt) {
  const props = call.schema?.properties ?? {};
  if (props.action && props.remember) return "teammate";
  if (props.size && props.risky) return "sizing";
  if (props.findings) return "reviewer";
  if (props.calls && props.text) return /You are auditing one past session/.test(prompt) ? "memory" : "lead";
  if (props.kind) return "scout";
  if (/You are a PLANNER/.test(prompt) || PLAN_FILE.test(prompt)) return "planner";
  if (DONE_FILE.test(prompt)) return "builder";
  if (/You are the automatic REVIEWER/.test(prompt)) return "reviewer";
  if (call.provider === "claude" && call.schema === null && call.format === "json" && call.tools === "") return "draft";
  return "unknown";
}

/** The words a rule's `when` reads: the operator's last message for the lead; the whole prompt for every other turn. */
export function leadTurn(prompt) {
  const at = prompt.lastIndexOf("CONVERSATION:\n");
  let history = [];
  try { history = at === -1 ? [] : JSON.parse(prompt.slice(at + "CONVERSATION:\n".length)); } catch { history = []; }
  const lastOperator = history.map(one => one.role).lastIndexOf("operator");
  const lastAssistant = history.map(one => one.role).lastIndexOf("assistant");
  return { said: lastOperator === -1 ? "" : String(history[lastOperator].text ?? ""), step: history.slice(lastOperator + 1).filter(one => one.role === "assistant").length,
    // What the tools it asked for last answered, for the journal.
    results: lastAssistant <= lastOperator ? [] : history.slice(lastAssistant + 1).filter(one => one.role === "tool").map(one => `${one.name}: ${String(one.result ?? "").slice(0, 300)}`) };
}

const test = (one, text) => new RegExp(one.source, one.flags).test(text);
function matches(rule, { role, provider, text, call }) {
  return (rule.role === role)
    && (rule.provider === undefined || rule.provider === provider)
    && (rule.resume === undefined || rule.resume === (call.resume !== null))
    && rule.when.every(one => test(one, text))
    && !rule.unless.some(one => test(one, text));
}
/** Claim one of a rule's `times` answers: an exclusive create, so two turns at once can't both take the last one. */
function claim(dir, rule) {
  if (rule.times === undefined || rule.times === null) return true;
  for (let n = 0; n < rule.times; n += 1) {
    try { closeSync(openSync(join(dir, USED, `${rule.id}-${n}`), "wx")); return true; } catch { /* taken */ }
  }
  return false;
}
/** The rule that answers this turn, or null. A lead step after the first takes the rule its first step took. */
export function pickRule(dir, rules, turn) {
  for (const rule of rules) {
    if (!matches(rule, turn)) continue;
    if (turn.role === "lead" && turn.step > 0) return rule;
    if (claim(dir, rule)) return rule;
  }
  return null;
}

const titleOf = brief => (/quoted as data[^\n]*\n(?:[^\n]*\n)?\| (.*)/.exec(brief)?.[1] ?? /^\| (.*)$/m.exec(brief)?.[1] ?? "the task").trim();

/** A plan the planner protocol accepts (src/plan.ts parsePlan): anything the answer leaves out comes from the title. */
export function planFor(brief, given = {}) {
  const title = titleOf(brief);
  const acceptance = given.acceptance ?? [{ id: "c1", statement: `${title.replace(/[.!]+$/, "")}, and the project's checks pass`, evidence: ["check"], how: null }];
  const plan = given.plan ?? [
    "## Approach", `Make the smallest change that does this: ${title}`,
    "## Milestones", "1. Make the change, with a test.",
    "## Dependencies", "- None found.",
    "## Risks", "- None found.",
    "## Proof", ...acceptance.map(one => `- ${one.id} — the project's checks`),
  ].join("\n");
  return { goal: given.goal ?? title, outOfScope: given.outOfScope ?? null, touches: given.touches ?? [], acceptance, plan,
    amendment: given.amendment === undefined ? "Turned the filed request into a goal and criteria the project's checks answer." : given.amendment };
}
const DECISION = { urgency: "blocking", recap: "A choice the plan leaves open.", question: "Which way?", options: [{ id: "a", label: "The first way", consequence: "Builds it the first way.", reversible: true }, { id: "b", label: "The second way", consequence: "Builds it the second way.", reversible: true }], recommendation: "a" };
const decision = given => ({ ...DECISION, ...given });

function writeWhole(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.part`, text);
  renameSync(`${file}.part`, file);
}

/** One MCP tool call on a server the run was given: stdio (newline-delimited JSON-RPC) or http (a JSON reply). */
export async function callMcp(configs, { server, tool, arguments: args = {} }, timeoutMs = 20_000) {
  const servers = Object.assign({}, ...configs.map(one => { try { return (one.trim().startsWith("{") ? JSON.parse(one) : JSON.parse(readFileSync(one, "utf8"))).mcpServers ?? {}; } catch { return {}; } }));
  const spec = servers[server];
  if (spec === undefined) return { ok: false, error: `no MCP server named ${server} (the run has ${Object.keys(servers).join(", ") || "none"})` };
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "scripted-provider", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } },
  ];
  const text = result => (result?.content ?? []).filter(one => one.type === "text").map(one => one.text).join("\n");
  if (spec.url !== undefined) {
    let session = null;
    for (const request of requests) {
      const answer = await fetch(spec.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(spec.headers ?? {}), ...(session === null ? {} : { "mcp-session-id": session }) }, body: JSON.stringify(request), signal: AbortSignal.timeout(timeoutMs) });
      session = answer.headers.get("mcp-session-id") ?? session;
      const body = await answer.text();
      if (request.id === 2) {
        const reply = JSON.parse(body.split("\n").find(line => line.startsWith("{") || line.startsWith("data: {"))?.replace(/^data: /, "") ?? "null");
        return reply?.error ? { ok: false, error: reply.error.message } : { ok: !reply?.result?.isError, text: text(reply?.result) };
      }
    }
  }
  return new Promise(done => {
    const child = spawn(spec.command, spec.args ?? [], { env: { ...process.env, ...(spec.env ?? {}) }, stdio: ["pipe", "pipe", "ignore"] });
    const timer = setTimeout(() => { child.kill("SIGKILL"); done({ ok: false, error: `${server} didn't answer in ${timeoutMs / 1000} s` }); }, timeoutMs);
    const end = result => { clearTimeout(timer); child.stdin.end(); child.kill(); done(result); };
    child.on("error", error => end({ ok: false, error: error.message }));
    createInterface({ input: child.stdout }).on("line", line => {
      let reply;
      try { reply = JSON.parse(line); } catch { return; }
      if (reply.id === 1) { child.stdin.write(`${JSON.stringify(requests[1])}\n${JSON.stringify(requests[2])}\n`); return; }
      if (reply.id === 2) end(reply.error ? { ok: false, error: reply.error.message } : { ok: !reply.result?.isError, text: text(reply.result) });
    });
    child.stdin.write(`${JSON.stringify(requests[0])}\n`);
  });
}

/**
 * Carry the answer out for its role: the structured value a JSON turn returns, the files a planner or builder writes,
 * and the final message. Throws (a failed turn) when the answer can't be carried out.
 */
async function perform(role, answer, { prompt, call, cwd, step }) {
  if (answer.delayMs) await new Promise(done => setTimeout(done, answer.delayMs));
  if (answer.fail !== undefined) throw new Error(String(answer.fail));
  const mcp = [];
  for (const one of answer.mcp ?? []) mcp.push({ ...one, ...(await callMcp(call.mcp, one)) });
  switch (role) {
    case "lead": {
      const steps = answer.steps ?? [{ text: answer.text ?? "", calls: answer.calls ?? [] }];
      const one = steps[Math.min(step, steps.length - 1)];
      const calls = step >= steps.length ? [] : (one.calls ?? []).map((each, at) => ({ id: `call-${step + 1}-${at + 1}`, name: each.name, argumentsJson: JSON.stringify(each.arguments ?? {}) }));
      return { value: { text: one.text ?? "", calls }, mcp };
    }
    case "teammate": {
      const value = { action: "route", answer: "", text: "", note: "", question: "", options: [], reason: "Scripted for this journey.", tool: "", input: "", remember: "", ...answer };
      for (const key of ["delayMs", "fail", "mcp"]) delete value[key];
      if (typeof value.input !== "string") value.input = JSON.stringify(value.input);
      return { value, mcp };
    }
    case "draft": return { text: String(answer.text ?? ""), mcp };
    case "sizing": return { value: { size: answer.size ?? "small", risky: answer.risky ?? false, reason: answer.reason ?? "Scripted." }, mcp };
    case "reviewer": return { value: { version: 1, findings: answer.findings ?? [] }, mcp };
    case "memory": return { value: { text: JSON.stringify({ positive: answer.positive ?? [], negative: answer.negative ?? [], gaps: answer.gaps ?? [] }), calls: [] }, mcp };
    case "scout": return { value: answer.decision ? { kind: "question", decision: decision(answer.decision) } : { kind: "report", report: answer.report ?? DEFAULTS.scout.report }, mcp };
    case "planner": {
      const park = /`(STANDING-ORDERS-PARK-[0-9a-f]{16}\.json)`/.exec(prompt)?.[1], plan = PLAN_FILE.exec(prompt)?.[1];
      if (answer.question !== undefined) {
        if (park === undefined) throw new Error("the planner's brief names no question file");
        writeWhole(join(cwd, park), JSON.stringify(decision(answer.question), null, 2));
        return { text: "I asked the operator.", mcp };
      }
      if (plan === undefined) throw new Error("the planner's brief names no plan file");
      writeWhole(join(cwd, plan), JSON.stringify(planFor(prompt, answer.plan ?? {}), null, 2));
      return { text: "The plan is written.", mcp };
    }
    case "builder": {
      const done = DONE_FILE.exec(prompt)?.[1];
      if (answer.park !== undefined) {
        const park = PARK_FILE.exec(prompt.replace(DONE_FILE, ""))?.[1];
        if (park === undefined) throw new Error("the builder's brief names no park file");
        writeWhole(join(cwd, park), JSON.stringify(decision(answer.park), null, 2));
        return { text: "I asked the operator.", mcp };
      }
      if (done === undefined) throw new Error("the builder's brief names no handoff file");
      for (const [path, text] of Object.entries(answer.files ?? {})) writeWhole(resolve(cwd, path), text);
      const status = answer.status ?? (Object.keys(answer.files ?? {}).length > 0 ? "completed" : "no-change");
      writeWhole(join(cwd, done), JSON.stringify({ version: 2, status, conclusion: answer.conclusion ?? "Made the change, with a test." }));
      return { text: "Done; the handoff is written.", mcp };
    }
    default: throw new Error(`no scripted answer for a ${role} turn`);
  }
}

/** One turn: pick its answer, carry it out, and say what happened in the journal. */
async function turn(dir, call, prompt, cwd) {
  const role = roleOf(call, prompt);
  const lead = role === "lead" ? leadTurn(prompt) : { said: prompt, step: 0, results: [] };
  const rules = (() => { try { return JSON.parse(readFileSync(join(dir, RULES), "utf8")).rules; } catch { return []; } })();
  const rule = pickRule(dir, rules, { role, provider: call.provider, text: lead.said, call, step: lead.step });
  const answer = rule?.answer ?? DEFAULTS[role] ?? null;
  // Every prompt, whole, beside the journal (the world keeps it with --keep): what a rule's regexes read.
  const kept = join(dir, "prompts", `${Date.now()}-${process.pid}-${role}.txt`);
  try { mkdirSync(dirname(kept), { recursive: true }); writeFileSync(kept, prompt); } catch { /* only for reading later */ }
  const entry = { at: new Date().toISOString(), provider: call.provider, role, turn: true, mode: "scripted", rule: rule?.id ?? (answer === null ? null : "default"), journey: rule?.journey ?? null, step: lead.step, resume: call.resume, prompt: lead.said.slice(0, 160), ...(lead.results.length === 0 ? {} : { toolResults: lead.results }) };
  if (answer === null) {
    const error = `nothing scripted answers this ${role} turn: ${lead.said.replace(/\s+/g, " ").slice(0, 200)}`;
    appendFileSync(join(dir, JOURNAL), `${JSON.stringify({ ...entry, ok: false, error })}\n`);
    return { ok: false, error };
  }
  try {
    const done = await perform(role, answer, { prompt, call, cwd, step: lead.step });
    appendFileSync(join(dir, JOURNAL), `${JSON.stringify({ ...entry, ok: true, ...(done.mcp.length === 0 ? {} : { mcp: done.mcp }) })}\n`);
    return { ok: true, ...done };
  } catch (error) {
    appendFileSync(join(dir, JOURNAL), `${JSON.stringify({ ...entry, ok: false, error: error.message, ...(answer.fail === undefined ? {} : { intended: true }) })}\n`);
    return { ok: false, error: error.message };
  }
}

const usage = { input_tokens: 120, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const say = line => process.stdout.write(`${JSON.stringify(line)}\n`);
/** The final message: the structured answer as JSON, or the words. */
const messageOf = done => done.value !== undefined ? JSON.stringify(done.value) : done.text ?? "";
function claudeResult(done, session, cost) {
  return done.ok
    ? { type: "result", subtype: "success", is_error: false, duration_ms: 5, duration_api_ms: 0, num_turns: 1, result: messageOf(done), session_id: session, total_cost_usd: cost, usage, ...(done.value === undefined ? {} : { structured_output: done.value }) }
    : { type: "result", subtype: "error_during_execution", is_error: true, duration_ms: 5, num_turns: 1, result: done.error, session_id: session, total_cost_usd: cost, usage };
}
const init = (session, cwd) => ({ type: "system", subtype: "init", session_id: session, cwd, model: "claude-scripted", tools: [], mcp_servers: [], permissionMode: "default" });
const assistant = (session, text) => ({ type: "assistant", parent_tool_use_id: null, session_id: session, message: { role: "assistant", content: [{ type: "text", text }] } });

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** The calls that aren't turns: versions, sign-in status, MCP lists, codex's app server. True when one answered. */
async function plain(provider, argv) {
  if (argv[0] === "--version" || argv[0] === "-v") { console.log(provider === "claude" ? "2.1.99 (Claude Code)" : "codex-cli 0.99.0"); return true; }
  if (argv[0] === "--help") { console.log(`Usage: ${provider} [options] (scripted stand-in)\n  --max-budget-usd <amount>`); return true; }
  if (provider === "claude" && argv[0] === "auth") { console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "journeys@example.invalid", subscriptionType: "max" })); return true; }
  if (provider === "codex" && argv[0] === "login") { console.log("Logged in using ChatGPT"); return true; }
  if (argv[0] === "mcp") { console.log("[]"); return true; }
  if (provider === "codex" && argv[0] === "app-server") {
    for await (const line of createInterface({ input: process.stdin })) {
      let message; try { message = JSON.parse(line); } catch { continue; }
      if (message.id === undefined) continue;
      const result = message.method === "account/rateLimits/read" ? { rateLimits: { primary: null, secondary: null } }
        : message.method === "account/read" ? { account: { type: "chatgpt", planType: "plus" } } : {};
      say({ jsonrpc: "2.0", id: message.id, result });
    }
    return true;
  }
  return false;
}

/** The real CLI, unchanged, after one line in the journal. */
function passThrough(dir, provider, argv) {
  const call = readCall(provider, argv);
  const isTurn = provider === "claude" ? argv.includes("-p") || argv.includes("--print") : argv[0] === "exec";
  appendFileSync(join(dir, JOURNAL), `${JSON.stringify({ at: new Date().toISOString(), provider, role: isTurn ? (call.schema?.properties?.calls ? "lead" : "turn") : argv[0] ?? "", turn: isTurn, mode: "real", ok: true })}\n`);
  const env = { ...process.env };
  const real = env[REAL_ENV];
  delete env[COUNT_ENV]; delete env[REAL_ENV];
  const child = spawn(real, argv, { stdio: "inherit", env });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => child.kill(signal));
  child.on("error", error => { process.stderr.write(`${provider}: ${error.message}\n`); process.exit(127); });
  child.on("exit", (code, signal) => { process.exitCode = code ?? 128 + (osConstants.signals[signal] ?? 0); });
}

async function main([provider, ...argv]) {
  if (!PROVIDERS.includes(provider)) { process.stderr.write(`usage: scripted-provider.mjs <${PROVIDERS.join("|")}> …\n`); process.exit(2); }
  if (process.env[COUNT_ENV] !== undefined) return passThrough(process.env[COUNT_ENV], provider, argv);
  const dir = process.env[SCRIPTED_ENV];
  if (dir === undefined) { process.stderr.write(`${provider}: the scripted stand-in needs ${SCRIPTED_ENV}\n`); process.exit(2); }
  if (await plain(provider, argv)) return;
  const call = readCall(provider, argv);
  const cwd = process.cwd();
  const session = call.resume ?? call.session ?? randomUUID();
  const prompt = call.prompt ?? await readStdin();
  const done = await turn(dir, call, prompt, cwd);
  if (!done.ok) process.stderr.write(`scripted ${provider}: ${done.error}\n`);
  if (call.format === "codex") {
    say({ type: "thread.started", thread_id: session });
    say({ type: "turn.started" });
    if (done.ok) {
      say({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: messageOf(done) } });
      say({ type: "turn.completed", usage: { input_tokens: usage.input_tokens, cached_input_tokens: 0, output_tokens: usage.output_tokens } });
    } else say({ type: "turn.failed", error: { message: done.error } });
  } else if (call.format === "json") say(claudeResult(done, session, 0.001));
  else if (call.format === "stream-json") { say(init(session, cwd)); if (done.ok) say(assistant(session, messageOf(done))); say(claudeResult(done, session, 0.001)); }
  else process.stdout.write(done.ok ? `${messageOf(done)}\n` : "");
  process.exitCode = done.ok ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SELF) await main(process.argv.slice(2));
