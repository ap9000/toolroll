import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, realpathSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store, type FlowCardRow, type SubagentRow } from "./store.js";
import { addApprover } from "./scope.js";
import { subagentSettings } from "./subagent-admin.js";
import { SUBAGENT_TEMPLATES } from "./subagents.js";
import { subagentAttemptWithBackup } from "./subagent-backup.js";
import type { CommandRunner } from "./claude-print.js";
import type { ExecResult } from "./exec.js";
import { spendRows } from "./spend-report.js";
import { weekOf } from "./subagent-week.js";

const NOW = new Date("2026-11-19T12:00:00Z");
let dir: string, store: Store, mate: SubagentRow, card: FlowCardRow;
const success = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "", timedOut: false, notFound: false });
const quota = (): ExecResult => ({ ...success(JSON.stringify({ type: "result", subtype: "success", is_error: true, api_error_status: 429, api_error: "usage_limit_reached", usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0 })), code: 1 });
const answer = { action: "route", answer: "Done", text: "The order ships tomorrow.", note: "", question: "", options: [], reason: "Tracking says so.", tool: "", input: "", remember: "" };
const codex = () => success([JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(answer) } }), JSON.stringify({ type: "turn.completed", usage: { input_tokens: 12, output_tokens: 8 } })].join("\n"));
const request = { model: "default", prompt: "Synthetic customer card", timeoutMs: 1000 };
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-subagent-backup-"))); store = openStore(join(dir, "orders.db"));
  if (!addApprover(store, "alex", NOW).ok) throw Error("bootstrap");
  const repo = join(dir, "shop");
  const flow = store.createFlow({ repo, name: "Support", by: "alex", definitionJson: JSON.stringify({ version: 1, start: "maya", stages: [{ id: "maya", title: "Maya", kind: "subagent", subagent: "maya", routes: [{ answer: "Done", to: "done" }], next: null, onFail: null }, { id: "done", title: "Done", kind: "done", next: null, onFail: null }] }) }, NOW);
  const id = store.createSubagent({ repo, handle: "maya", soul: SUBAGENT_TEMPLATES[0]!.soul, model: null, manager: "alex", by: "alex" }, NOW);
  mate = store.getSubagent(id)!;
  card = store.getFlowCard(store.addFlowCard({ flow, title: "Shipping question", description: null, stage: "maya", by: "alex", byKind: "person" }, NOW))!;
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
function enable() { expect(subagentSettings(store, mate, { codexBackupModel: "codex-test-model" }, "alex", NOW, { proveBackup: () => true }).ok).toBe(true); mate = store.getSubagent(mate.id)!; }
const fixedClock = () => NOW;

test("backup is off by default; a live password proof and exact model are needed in the settings transaction", async () => {
  expect(mate.codexBackupModel).toBeNull();
  expect(subagentSettings(store, mate, { codexBackupModel: "codex-test-model" }, "alex", NOW).ok).toBe(false);
  expect(subagentSettings(store, mate, { codexBackupModel: "default" }, "alex", NOW, { proveBackup: () => true }).ok).toBe(false);
  let calls = 0; await subagentAttemptWithBackup(store, mate, card, request, async () => { calls++; return codex(); }, fixedClock);
  expect(calls).toBe(0); enable();
  expect(subagentSettings(store, mate, { codexBackupModel: null }, "alex", NOW).ok).toBe(true);
});

test("a confirmed primary quota refusal gets one no-tools Codex plan attempt, with separate truthful rows", async () => {
  enable(); const seen: string[] = [];
  const runner: CommandRunner = async (file, args, options) => {
    seen.push(`${file}:${args[0]}`);
    if (file === "claude") return quota();
    if (args[0] === "login") return success("Logged in using ChatGPT");
    expect(args).toContain("--ignore-user-config"); expect(args).toContain("--ignore-rules"); expect(args).toContain("--ephemeral");
    expect(args).toContain("features.shell_tool=false"); expect(args).toContain("features.unified_exec=false"); expect(args).toContain("features.multi_agent=false");
    expect(args).toContain("codex-test-model"); expect(options?.omitEnv).toContain("OPENAI_API_KEY");
    expect(options?.stdin).not.toContain("append {id, name, argumentsJson}");
    const schema = JSON.parse(readFileSync(args[args.indexOf("--output-schema") + 1]!, "utf8")); expect(schema.properties.action).toBeDefined();
    return codex();
  };
  const result = await subagentAttemptWithBackup(store, mate, card, request, runner, fixedClock);
  expect(result).toMatchObject({ provider: "codex", backup: true, reply: { ok: true, value: answer } });
  expect(seen).toEqual(["claude:-p", "codex:login", "codex:exec"]);
  const rows = store.handle.prepare("SELECT provider, model, billing, ok, pending, backup_of, tokens_in FROM subagent_turn ORDER BY id").all();
  expect(rows).toMatchObject([{ provider: "claude", model: "default", ok: 0, pending: 0 }, { provider: "codex", model: "codex-test-model", billing: "subscription", ok: 1, pending: 0, backup_of: 1, tokens_in: 12 }]);
  expect(store.subagentTurnsSince(mate.id, "2026-11-19T00:00:00Z")).toBe(2);
  expect(spendRows(store.handle, "2026-11-19T00:00:00Z", "2026-11-20T00:00:00Z").filter(one => one.source === "subagent").map(one => one.provider)).toEqual(["claude", "codex"]);
  const retry = store.reserveSubagentAttempt({ subagent: mate.id, card: card.id, cardEntry: card.entry, stage: card.stage, authorityGeneration: mate.authorityGeneration, flowRevision: store.getFlow(card.flow)!.revision, provider: "codex", model: "codex-test-model", billing: "subscription", backupOf: 1 }, NOW);
  expect(retry.ok).toBe(false);
});

test.each(["malformed", "timeout", "auth", "denied", "free-text"])("%s failure never starts another provider", async kind => {
  enable(); const calls: string[] = [];
  const runner: CommandRunner = async file => { calls.push(file); const result = { ...success(), code: 1 };
    if (kind === "timeout") return { ...result, timedOut: true };
    if (kind === "auth") return { ...result, stderr: "Not logged in" };
    if (kind === "free-text") return { ...result, stdout: "usage_limit_reached 429" };
    if (kind === "denied") return { ...result, stdout: JSON.stringify({ type: "result", is_error: true, api_error_status: 403, api_error: "permission_denied" }) };
    return { ...result, stdout: "not JSON" };
  };
  expect((await subagentAttemptWithBackup(store, mate, card, request, runner, fixedClock)).reply.ok).toBe(false); expect(calls).toEqual(["claude"]);
});

test.each(["key", "ambiguous", "failed-status"])("%s login proof refuses the backup before a model call", async kind => {
  enable(); let models = 0;
  const runner: CommandRunner = async (file, args) => { if (file === "claude") return quota(); if (args[0] === "exec") { models++; return codex(); }
    return { ...success(kind === "key" ? "Logged in using an API key" : kind === "ambiguous" ? "Logged in using ChatGPT\nAPI key" : "Logged in using ChatGPT"), code: kind === "failed-status" ? 1 : 0 };
  };
  expect((await subagentAttemptWithBackup(store, mate, card, request, runner, fixedClock)).reply.ok).toBe(false); expect(models).toBe(0);
});

test.each(["consent", "policy", "cap", "moved"])("%s changed during sign-in proof prevents backup admission", async kind => {
  enable(); let models = 0;
  const runner: CommandRunner = async (file, args) => { if (file === "claude") return quota(); if (args[0] === "exec") { models++; return codex(); }
    if (kind === "consent") store.setSubagentCodexBackup(mate.id, null, "alex", NOW);
    if (kind === "policy") store.setOrgPolicy({ providers: ["claude"], models: null, tools: null, ceiling: "escalated" }, "alex", NOW);
    if (kind === "cap") store.updateSubagent(mate.id, { dailyTurns: 1 }, "alex", NOW);
    if (kind === "moved") store.handle.prepare("UPDATE flow_card SET entry = entry + 1 WHERE id = ?").run(card.id);
    return success("Logged in using ChatGPT");
  };
  expect((await subagentAttemptWithBackup(store, mate, card, request, runner, fixedClock)).reply.ok).toBe(false); expect(models).toBe(0);
});

test("pending attempts remain counted after disabling, and are not reported as completed failures", () => {
  enable(); const saved = store.reserveSubagentAttempt({ subagent: mate.id, card: card.id, cardEntry: card.entry, stage: card.stage, authorityGeneration: mate.authorityGeneration, flowRevision: store.getFlow(card.flow)!.revision, provider: "claude", model: "default", billing: "subscription" }, NOW);
  expect(saved.ok).toBe(true); store.setSubagentCodexBackup(mate.id, null, "alex", NOW);
  expect(store.subagentTurnsSince(mate.id, "2026-11-19T00:00:00Z")).toBe(1);
  expect(weekOf(store, store.getSubagent(mate.id)!, NOW)).toMatchObject({ turns: 1, pendingTurns: 1, failedTurns: 0, costUsd: null });
});


test("the backup uses only the original remaining deadline and rejects a response after consent is removed", async () => {
  enable(); let elapsed = 0; const timeouts: number[] = [];
  const runner: CommandRunner = async (file, args, options) => {
    timeouts.push(options?.timeoutMs ?? -1);
    if (file === "claude") { elapsed += 400; return quota(); }
    if (args[0] === "login") { elapsed += 100; return success("Logged in using ChatGPT"); }
    store.setSubagentCodexBackup(mate.id, null, "alex", NOW); return codex();
  };
  const result = await subagentAttemptWithBackup(store, mate, card, request, runner, () => new Date(NOW.getTime() + elapsed), () => elapsed);
  expect(result.reply).toMatchObject({ ok: false, said: expect.any(String) });
  expect(timeouts).toEqual([1000, 600, 500]);
  expect(store.subagentTurnsSince(mate.id, "2026-11-19T00:00:00Z")).toBe(2);
});

test("a successful Claude decision never starts the backup", async () => {
  enable(); const calls: string[] = [];
  const runner: CommandRunner = async file => { calls.push(file); return success(JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: answer })); };
  expect((await subagentAttemptWithBackup(store, mate, card, request, runner, fixedClock)).reply.ok).toBe(true);
  expect(calls).toEqual(["claude"]);
});


test.each(["primary", "backup"])("late %s responses never act, and usage is retained", async phase => {
  enable(); let elapsed = 0;
  const runner: CommandRunner = async (file, args) => {
    if (file === "claude") { if (phase === "primary") { elapsed = 1001; return success(JSON.stringify({ type: "result", subtype: "success", structured_output: answer, usage: { input_tokens: 2, output_tokens: 1 } })); } return quota(); }
    if (args[0] === "login") return success("Logged in using ChatGPT");
    elapsed = 1001; return codex();
  };
  expect((await subagentAttemptWithBackup(store, mate, card, request, runner, () => new Date(NOW.getTime() + elapsed), () => elapsed)).reply).toMatchObject({ ok: false, said: expect.any(String) });
  expect(store.subagentTurns(mate.id, "2026-11-19T00:00:00Z").at(-1)?.tokensIn).toBe(phase === "primary" ? 2 : 12);
});

test.each(["pause-resume", "off-on", "policy-restore"])("%s cannot restore an in-flight primary's authority", async change => {
  enable(); const runner: CommandRunner = async () => {
    if (change === "pause-resume") { store.updateSubagent(mate.id, { state: "paused" }, "alex", NOW); store.updateSubagent(mate.id, { state: "active" }, "alex", NOW); }
    if (change === "off-on") { store.setSubagentCodexBackup(mate.id, null, "alex", NOW); store.setSubagentCodexBackup(mate.id, "codex-test-model", "alex", NOW); }
    if (change === "policy-restore") { store.setOrgPolicy({ providers: ["codex"], models: null, tools: null, ceiling: "escalated" }, "alex", NOW); store.setOrgPolicy({ providers: null, models: null, tools: null, ceiling: "escalated" }, "alex", NOW); }
    return success(JSON.stringify({ type: "result", subtype: "success", structured_output: answer }));
  };
  expect((await subagentAttemptWithBackup(store, mate, card, request, runner, fixedClock)).reply).toMatchObject({ ok: false, said: expect.any(String) });
});


test("an unfinished attempt holds this card, and a primary from another entry cannot admit a backup", () => {
  enable(); const input = { subagent: mate.id, card: card.id, cardEntry: card.entry, stage: card.stage, authorityGeneration: mate.authorityGeneration, flowRevision: store.getFlow(card.flow)!.revision, provider: "claude" as const, model: "default", billing: "subscription" as const };
  const first = store.reserveSubagentAttempt(input, NOW); if (!first.ok) throw Error(first.why);
  expect(store.reserveSubagentAttempt(input, NOW).ok).toBe(false);
  store.settleSubagentAttempt(first.id, { ok: false, ms: 1, failureKind: "usage-limit" });
  store.handle.prepare("UPDATE flow_card SET entry = entry + 1 WHERE id = ?").run(card.id);
  expect(store.reserveSubagentAttempt({ ...input, cardEntry: card.entry + 1, provider: "codex", model: "codex-test-model", backupOf: first.id }, NOW).ok).toBe(false);
});

test("a wall-clock rollback cannot extend the shared turn deadline", async () => {
  enable(); let elapsed = 0, wall = NOW.getTime();
  const runner: CommandRunner = async () => { wall -= 3_600_000; elapsed = 1001; return success(JSON.stringify({ type: "result", subtype: "success", structured_output: answer })); };
  const result = await subagentAttemptWithBackup(store, mate, card, request, runner, () => new Date(wall), () => elapsed);
  expect(result.reply.ok).toBe(false);
  expect(store.subagentTurns(mate.id, "2026-11-19T00:00:00Z")).toHaveLength(1);
});
