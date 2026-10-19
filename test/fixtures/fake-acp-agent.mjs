#!/usr/bin/env node
// A stand-in ACP agent for the gateway's slow tests (src/acp-gateway.slow.test.ts). What it does is FAKE_ACP:
// ok | stall | quiet-exit | wrong-version | refuse-model | descendant | slow (holds the prompt until cancelled or killed)
// | double-answer (a second, conflicting answer with no newline, then exit) | pipe-holder (a stray in its group keeps
// stdout open) | escaped-pipe-holder (the same, in a group of its own) | ignore-term (answers, then ignores EOF and
// SIGTERM) | silent-init (never answers initialize).
// It writes what it was asked into $FAKE_ACP_LOG, and touches $FAKE_ACP_RAN when it starts.
import { appendFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
const mode = process.env.FAKE_ACP ?? "ok";
const log = line => { if (process.env.FAKE_ACP_LOG) appendFileSync(process.env.FAKE_ACP_LOG, `${line}\n`); };
if (process.env.FAKE_ACP_RAN) writeFileSync(process.env.FAKE_ACP_RAN, String(process.pid));
const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const sessionId = "ses_fake_1";
let cwd = process.cwd();
let prompt = null;
let buffer = "";
const update = body => send({ method: "session/update", params: { sessionId, update: body } });
process.stdin.on("data", chunk => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    if (line.trim() === "") continue;
    const message = JSON.parse(line);
    log(message.method ?? `answer:${message.id}`);
    if (message.method === "initialize") {
      if (mode === "silent-init") continue;
      send({ id: message.id, result: { protocolVersion: 1, agentInfo: { name: "FakeCode", version: mode === "wrong-version" ? "9.9.9" : "1.0.0" }, agentCapabilities: { sessionCapabilities: { close: {} } }, authMethods: [] } });
    } else if (message.method === "session/new") {
      cwd = message.params.cwd;
      send({ id: message.id, result: { sessionId, configOptions: [{ id: "model", name: "Model", type: "select", currentValue: "fake/default", options: [{ value: "fake/default", name: "Default" }, { value: "fake/model", name: "Fake" }] }] } });
    } else if (message.method === "session/set_config_option") {
      const current = mode === "refuse-model" ? "fake/default" : message.params.value;
      send({ id: message.id, result: { configOptions: [{ id: "model", name: "Model", type: "select", currentValue: current, options: [{ value: "fake/default", name: "Default" }, { value: "fake/model", name: "Fake" }] }] } });
    } else if (message.method === "session/prompt") {
      prompt = message.id;
      log(`prompt:${message.params.prompt[0].text}`);
      if (mode === "stall") continue;
      if (mode === "quiet-exit") { update({ sessionUpdate: "available_commands_update", availableCommands: [] }); setTimeout(() => process.exit(0), 50); continue; }
      if (mode === "slow") { update({ sessionUpdate: "tool_call", toolCallId: "t-slow", title: "sleep", kind: "execute", status: "in_progress" }); continue; }
      if (mode === "pipe-holder" || mode === "escaped-pipe-holder") {
        const stray = spawn("sleep", ["300"], { stdio: ["ignore", "inherit", "inherit"], detached: mode === "escaped-pipe-holder" });
        writeFileSync(join(cwd, "stray.pid"), String(stray.pid));
      }
      if (mode === "ignore-term") { process.on("SIGTERM", () => {}); process.stdin.removeAllListeners("end"); setInterval(() => {}, 1000); }
      if (mode === "descendant") {
        const child = spawn("sleep", ["300"], { stdio: "ignore" });
        writeFileSync(join(cwd, "descendant.pid"), String(child.pid));
      }
      update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "write done.txt", kind: "edit", status: "pending", locations: [{ path: join(cwd, "done.txt") }] });
      writeFileSync(join(cwd, "done.txt"), "ok\n");
      update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Wrote done.txt." } });
      send({ id: prompt, result: { stopReason: "end_turn" } });
      if (mode === "double-answer") { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: prompt, result: { stopReason: "refusal" } })); setTimeout(() => process.exit(0), 50); }
      if (mode === "pipe-holder" || mode === "escaped-pipe-holder") setTimeout(() => process.exit(0), 50);
    } else if (message.method === "session/cancel") {
      if (prompt !== null) send({ id: prompt, result: { stopReason: "cancelled" } });
    } else if (message.method === "session/close") {
      send({ id: message.id, result: {} });
    } else if (message.id !== undefined && message.method !== undefined) {
      send({ id: message.id, error: { code: -32601, message: "no" } });
    }
  }
});
process.stdin.on("end", () => { log("eof"); if (mode !== "stall" && mode !== "slow") process.exit(0); });
