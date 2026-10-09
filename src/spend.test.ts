/**
 * Cost guardrails (v105): subscription work at $0 (its plan's windows are
 * what bind it, shown on Tasks); API work priced (reported, or tokens at the
 * catalogue price, or the provider's highest listed price, or honestly
 * unpriced), spend attributed to projects, people and subagents, monthly
 * budgets that alert at 50/80/100 % and stop API work at 100 %, and a Spend
 * page with CSV.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { billingOf, claudeBillingFrom, priceFor, spendItems, monthOf } from "./spend.js";
import { budgetAlertPass } from "./budget-alerts.js";
import { subagentReady } from "./subagent-work.js";
import { runOperate } from "./operate.js";
import { setAuthMode } from "./keys.js";
import { claudeLimitsOf, codexLimitsOf, noteLimits, pushLimitSink } from "./provider-limits.js";
import { limitsView } from "./limits-ui.js";
import { runClaudeStreamJsonl } from "./exec.js";

let dir: string, file: string, store: Store, home: string | undefined;
const NOW = new Date("2026-09-20T12:00:00.000Z");
const REPO = "/repo/shop";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "so-spend-"));
  file = join(dir, "orders.db");
  // How each provider bills comes from its auth-mode file: these tests bill Claude and Codex to keys unless they say.
  home = process.env["HOME"];
  process.env["HOME"] = dir;
  setAuthMode("claude", "api-key");
  setAuthMode("codex", "api-key");
  store = openStore(file);
  const seen = store.handle.prepare(`INSERT INTO model_seen (source, id, name, input_usd, output_usd, context, tools, released_at, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?, ?)`);
  const at = "2026-09-01T00:00:00.000Z";
  seen.run("codex", "gpt-6-astra", "GPT-6 Astra", 10, 50, "2026-08-01T00:00:00.000Z", at, at);
  seen.run("claude", "claude-sonnet-5", "Claude Sonnet 5", 3, 15, "2026-05-01T00:00:00.000Z", at, at);
  seen.run("claude", "claude-sonnet-5-5", "Claude Sonnet 5.5", 2, 10, "2026-08-01T00:00:00.000Z", at, at);
});
let dropSink = () => {};
afterEach(() => { dropSink(); store.close(); process.env["HOME"] = home; rmSync(dir, { recursive: true, force: true }); });

const legacy = { routeDigest: "legacy", phase: "build" as const, provider: "claude", model: null, chosen: "legacy" as const };
let serial = 0;
/** A task filed by `filer`, and one finished run of it. */
function work(filer: { name: string | null; kind: "person" | "coordinator" | "subagent" | "automation" }, usage: { provider?: string; model?: string | null; costUsd?: number; tokensIn?: number; tokensOut?: number }, at = NOW): { id: string; run: number } {
  const id = `t-${++serial}`;
  store.createTask({ id, title: id, filedBy: filer }, at);
  const ref = store.refFor("built-in", id).id;
  store.placeTask(ref, REPO);
  const run = store.startRun({ taskRef: ref, leaseId: `l-${serial}`, runner: "b1", branch: `standing-orders/${id}`, worktree: `/w/${id}`, route: { ...legacy, provider: usage.provider ?? "claude", model: usage.model ?? null }, now: at });
  if (usage.provider !== undefined || usage.model !== undefined) store.handle.prepare("UPDATE run SET provider = ?, model = ? WHERE id = ?").run(usage.provider ?? "claude", usage.model ?? null, run);
  store.recordUsage(run, { ...(usage.tokensIn === undefined ? {} : { tokensIn: usage.tokensIn }), ...(usage.tokensOut === undefined ? {} : { tokensOut: usage.tokensOut }), ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }) });
  store.finishRun(run, { outcome: "built", now: at });
  return { id, run };
}
const spendOf = (run: number) => store.handle.prepare("SELECT microusd, source, price_model FROM run_spend WHERE run = ?").get(run);

test("API work is priced: what the provider reported, or its tokens at the catalogue price, or the provider's highest listed price, or honestly unpriced", () => {
  const reported = work({ name: "alex", kind: "person" }, { costUsd: 1.25, tokensIn: 1, tokensOut: 1 });
  expect(spendOf(reported.run)).toMatchObject({ microusd: 1_250_000, source: "reported" });
  // Codex reports no cost: 100k tokens in at $10/M and 10k out at $50/M is $1.50.
  const estimated = work({ name: "alex", kind: "person" }, { provider: "codex", model: "gpt-6-astra", tokensIn: 100_000, tokensOut: 10_000 });
  expect(spendOf(estimated.run)).toMatchObject({ microusd: 1_500_000, source: "estimated", price_model: "gpt-6-astra" });
  // A Claude short name is priced as the newest of its family.
  expect(priceFor(store.handle, "claude", "sonnet")).toMatchObject({ model: "claude-sonnet-5-5", inputUsd: 2 });
  // A model the catalogue doesn't list (or the CLI's default) is never free under a budget: the provider's highest price.
  const unlisted = work({ name: "alex", kind: "person" }, { provider: "codex", model: "gpt-unlisted", tokensIn: 5, tokensOut: 5 });
  expect(spendOf(unlisted.run)).toMatchObject({ microusd: 300, source: "estimated", price_model: "highest listed price" });
  const defaulted = work({ name: "alex", kind: "person" }, { provider: "codex", model: null, tokensIn: 1_000, tokensOut: 0 });
  expect(spendOf(defaulted.run)).toMatchObject({ microusd: 10_000, source: "estimated" });
  // A provider with no catalogue at all is said to be unpriced.
  const unknown = work({ name: "alex", kind: "person" }, { provider: "gemini", model: "gemini-x", tokensIn: 5, tokensOut: 5 });
  expect(spendOf(unknown.run)).toMatchObject({ microusd: null, source: "unpriced" });
  // A price is frozen when the work is settled: a later price change doesn't rewrite last month's spend.
  store.handle.prepare("UPDATE model_seen SET input_usd = 100 WHERE id = 'gpt-6-astra'").run();
  expect(spendOf(estimated.run)).toMatchObject({ microusd: 1_500_000 });
});

test("subscription work is $0 and never waits on a budget; how a run was billed is fixed when it's first priced", () => {
  setAuthMode("claude", "subscription");
  const plan = work({ name: "alex", kind: "person" }, { costUsd: 5, tokensIn: 1_000_000, tokensOut: 1_000_000 });
  expect(store.handle.prepare("SELECT microusd, source, billing FROM run_spend WHERE run = ?").get(plan.run)).toEqual({ microusd: 0, source: "subscription", billing: "subscription" });
  const keyed = work({ name: "alex", kind: "person" }, { provider: "codex", model: "gpt-6-astra", tokensIn: 1_000_000, tokensOut: 0 });
  expect(spendOf(keyed.run)).toMatchObject({ microusd: 10_000_000, source: "estimated" });
  store.setBudget({ scope: "installation", key: "*", limitMicrousd: 5_000_000, hardStop: true }, "alex", NOW);
  const subject = store.budgetSubject(store.lookupRef(plan.id)!.id);
  const gate = store.budgetGate(NOW);
  expect(gate({ ...subject, agents: store.agentsFor(["claude"]) }).over).toBeNull();
  expect(gate({ ...subject, agents: store.agentsFor(["codex"]) })).toMatchObject({ why: "used-up", over: { scope: "installation", percent: 200 } });
  expect(gate({ ...subject, agents: store.agentsFor(["claude", "codex"]) }).over).not.toBeNull();
  // A fallback pinned to a key is a key, whatever the setting says.
  expect(gate({ ...subject, agents: [{ provider: "claude", billing: "api-key" }] })).toMatchObject({ why: "used-up" });
  // A chat on the plan starts; one on a key waits.
  const chat = (provider: "claude-subscription" | "openrouter-api") =>
    store.openChatTurn({ approver: "alex", credentialKey: provider, provider, model: "m", reservedMicrousd: 1, dailyTurns: 99, weeklyCeilingMicrousd: 99_000_000, deadlineMs: 1000 }, NOW);
  expect(chat("openrouter-api")).toEqual({ ok: false, reason: "monthly-budget" });
  expect(chat("claude-subscription")).toMatchObject({ ok: true });
  // Switching Claude to a key later doesn't reprice what already ran on the plan.
  setAuthMode("claude", "api-key");
  store.recordUsage(plan.run, { costUsd: 6 });
  expect(spendOf(plan.run)).toMatchObject({ microusd: 0, source: "subscription" });
});

test("billing follows what the CLI did: a key source, a cloud model or Codex's key account is a key; key work that can't be priced waits", () => {
  setAuthMode("claude", "subscription");
  setAuthMode("codex", "subscription");
  expect(claudeBillingFrom({ keySource: "none", model: "claude-sonnet-5", planWindows: true })).toBe("subscription");
  expect(claudeBillingFrom({ keySource: "ANTHROPIC_API_KEY", model: null, planWindows: false })).toBe("api-key");
  expect(claudeBillingFrom({ keySource: "apiKeyHelper", model: null, planWindows: true })).toBe("api-key");
  expect(claudeBillingFrom({ keySource: "none", model: "us.anthropic.claude-sonnet-5-v1:0", planWindows: false })).toBe("api-key");
  expect(claudeBillingFrom({ keySource: "none", model: "claude-sonnet-5@20260101", planWindows: false })).toBe("api-key");
  expect(claudeBillingFrom({ keySource: null, model: null, planWindows: false })).toBeNull();
  // "none" is a sign-in, a gateway's bearer token or a cloud provider: only the plan's windows prove the plan.
  expect(claudeBillingFrom({ keySource: "none", model: "claude-sonnet-5", planWindows: false })).toBe("api-key");
  // A run's own evidence is fixed before its usage is priced, and wins over the mode stamped after it.
  const keyed = work({ name: "alex", kind: "person" }, {});
  store.fixRunBilling(keyed.run, "api-key", NOW);
  store.recordUsage(keyed.run, { costUsd: 3 });
  store.stampTerminalClass(keyed.run, "subscription", "unknown");
  expect(store.handle.prepare("SELECT microusd, source, billing FROM run_spend WHERE run = ?").get(keyed.run)).toEqual({ microusd: 3_000_000, source: "reported", billing: "api-key" });
  // Codex seen on a key account bills its key, though Toolroll is set to its plan.
  expect(billingOf("codex", store.handle)).toBe("subscription");
  store.recordProviderLimits({ provider: "codex", plan: null, windows: [], partial: true, billing: "api-key" }, NOW);
  expect(billingOf("codex", store.handle)).toBe("api-key");
  expect(billingOf("codex")).toBe("subscription");
  // Gemini on a key with no catalogue prices can't be priced: a covering budget holds it rather than count it free.
  store.setBudget({ scope: "person", key: "alex", limitMicrousd: 100_000_000, hardStop: true }, "alex", NOW);
  const subject = { project: REPO, person: "alex", subagent: null };
  expect(store.budgetGate(NOW)({ ...subject, agents: [{ provider: "gemini", billing: "api-key" }] })).toMatchObject({ why: "unpriced", unpricedProvider: "gemini" });
  expect(store.budgetGate(NOW)({ ...subject, agents: [{ provider: "claude", billing: "api-key" }] }).over).toBeNull();
  expect(store.budgetGate(NOW)({ ...subject, agents: [{ provider: "gemini", billing: "subscription" }] }).over).toBeNull();
  expect(store.budgetGate(NOW)({ project: "/elsewhere", person: "sam", subagent: null, agents: [{ provider: "gemini", billing: "api-key" }] }).over).toBeNull();
});

test("spend counts toward the project, the person who filed it (or the person behind a coordinator), and a subagent that filed it", () => {
  store.createSubagent({ repo: REPO, handle: "maya", soul: "---\nname: Maya\nrole: Support\n---\n## Who you are\nHelpful.\n", model: null, manager: "alex", by: "alex" }, NOW);
  const mate = Number(store.handle.prepare("SELECT id FROM subagent WHERE handle = 'maya'").get()!["id"]);
  work({ name: "alex", kind: "person" }, { costUsd: 1 });
  work({ name: "sam", kind: "coordinator" }, { costUsd: 2 });
  // A subagent files as its name ("Maya (AI)"), not its handle.
  const filed = work({ name: "Maya (AI)", kind: "subagent" }, { costUsd: 4 });
  expect(store.budgetSubject(store.lookupRef(filed.id)!.id)).toEqual({ project: REPO, person: null, subagent: mate });
  work({ name: null, kind: "automation" }, { costUsd: 8 });
  // Its own turns run on this computer's Claude sign-in: $0 whatever the CLI estimates.
  store.addSubagentTurn({ subagent: mate, card: null, model: "sonnet", ok: true, ms: 10, costUsd: 0.5 }, NOW);
  store.handle.prepare(`INSERT INTO chat_turn (approver, credential_key, provider, model, state, created_at, deadline_at, reserved_microusd, settled_microusd) VALUES ('alex', 'k', 'openrouter-api', 'x', 'answered', ?, ?, 300000, 250000)`)
    .run(NOW.toISOString(), NOW.toISOString());
  const month = monthOf(NOW);
  const items = spendItems(store.handle, month.from, month.to);
  const sum = (pick: (item: (typeof items)[number]) => boolean) => items.filter(pick).reduce((total, item) => total + (item.microusd ?? 0), 0);
  expect(sum(item => item.project === REPO)).toBe(15_000_000);
  expect(sum(item => item.person === "alex")).toBe(1_250_000);
  expect(sum(item => item.person === "sam")).toBe(2_000_000);
  expect(sum(item => item.subagent === mate)).toBe(4_000_000);
  expect(sum(() => true)).toBe(15_250_000);
  // Last month's work isn't this month's.
  work({ name: "alex", kind: "person" }, { costUsd: 99 }, new Date("2026-08-31T23:59:59.000Z"));
  expect(spendItems(store.handle, month.from, month.to).reduce((total, item) => total + (item.microusd ?? 0), 0)).toBe(15_250_000);
});

test("an automatic repair counts as its source's filer; a task's chat as the task's project; a Sort zone's OpenRouter cost as its flow's project", () => {
  const source = work({ name: "alex", kind: "person" }, { costUsd: 1 });
  const repair = work({ name: null, kind: "automation" }, { costUsd: 2 });
  store.handle.prepare("UPDATE task_ref SET revision_of = ? WHERE external_id = ?").run(source.id, repair.id);
  expect(store.budgetSubject(store.lookupRef(repair.id)!.id)).toEqual({ project: REPO, person: "alex", subagent: null });
  const session = Number(store.handle.prepare(`INSERT INTO lead_session (approver, approver_generation, credential_key, ceiling_microusd, ceiling_digest, terms_digest, minted_at) VALUES ('sam', 1, 'k', 1000000, 'c', 't', ?)`)
    .run(NOW.toISOString()).lastInsertRowid);
  const thread = Number(store.handle.prepare(`INSERT INTO lead_thread (approver, ceiling_digest, opened_at, scope_kind, scope_key) VALUES ('sam', 'c', ?, 'task', ?)`).run(NOW.toISOString(), source.id).lastInsertRowid);
  store.handle.prepare(`INSERT INTO mate_turn (approver, session, thread, credential_key, state, created_at, deadline_at, reserved_microusd, settled_microusd) VALUES ('sam', ?, ?, 'k', 'answered', ?, ?, 1, 700000)`)
    .run(session, thread, NOW.toISOString(), NOW.toISOString());
  const flow = store.createFlow({ repo: "/repo/desk", name: "Inbox", definitionJson: "{}", by: "alex" }, NOW);
  const card = store.addFlowCard({ flow, title: "A note", description: null, stage: "sort", by: "alex" }, NOW);
  store.handle.prepare(`INSERT INTO flow_step_run (card, entry, stage, kind, state, started_at, decision_json) VALUES (?, 1, 'sort', 'sort', 'passed', ?, ?)`)
    .run(card, NOW.toISOString(), JSON.stringify({ model: "jev", cost: 0.0042 }));
  const month = monthOf(NOW);
  const items = spendItems(store.handle, month.from, month.to);
  expect(items.filter(item => item.person === "alex").reduce((total, item) => total + (item.microusd ?? 0), 0)).toBe(3_000_000);
  expect(items.find(item => item.kind === "chat")).toMatchObject({ project: REPO, person: "sam", microusd: 700_000 });
  expect(items.find(item => item.kind === "sort")).toMatchObject({ project: "/repo/desk", microusd: 4_200, source: "reported" });
});

test("a hard-stop budget used up holds new work (tasks, subagents, chats); an alerts-only one never does; the ledger keeps every change", () => {
  const alexTask = work({ name: "alex", kind: "person" }, { costUsd: 6 });
  store.setBudget({ scope: "project", key: REPO, limitMicrousd: 10_000_000, hardStop: true }, "alex", NOW);
  const subject = store.budgetSubject(store.lookupRef(alexTask.id)!.id);
  expect(subject).toEqual({ project: REPO, person: "alex", subagent: null });
  expect(store.budgetGate(NOW)(subject)).toMatchObject({ over: null, remainingMicrousd: 4_000_000 });
  work({ name: "sam", kind: "person" }, { costUsd: 5 });
  expect(store.budgetGate(NOW)(subject).over).toMatchObject({ scope: "project", percent: 110 });
  // A subagent's own turns cost nothing extra (its sign-in), so a budget never stops them.
  store.createSubagent({ repo: REPO, handle: "maya", soul: "---\nname: Maya\nrole: Support\n---\n## Who you are\nHelpful.\n", model: null, manager: "alex", by: "alex" }, NOW);
  const mate = store.subagents([REPO])[0]!;
  expect(subagentReady(store, mate, NOW)).toEqual({ ok: true });
  // Unless this computer's Claude bills a key (a Console login, a key helper, a gateway): then its turns and drafts
  // cost what they cost, count, and wait like any key work.
  store.recordProviderBilling("claude", "api-key", NOW);
  expect(subagentReady(store, mate, NOW)).toEqual({ ok: false, why: "a monthly budget its work counts toward is used up" });
  store.addSubagentTurn({ subagent: mate.id, card: null, model: "sonnet", ok: true, ms: 10, costUsd: 0.25 }, NOW);
  store.recordDraftSpend({ repo: REPO, model: null, costUsd: 0.5 }, NOW);
  const month = monthOf(NOW);
  const extra = spendItems(store.handle, month.from, month.to).filter(item => item.kind === "subagent" || item.kind === "draft");
  expect(extra.map(item => [item.kind, item.microusd, item.project])).toEqual([["subagent", 250_000, REPO], ["draft", 500_000, REPO]]);
  store.recordProviderBilling("claude", "subscription", NOW);
  // Alerts only: work carries on.
  store.setBudget({ scope: "project", key: REPO, limitMicrousd: 10_000_000, hardStop: false }, "alex", NOW);
  expect(store.budgetGate(NOW)(subject).over).toBeNull();
  // A person's budget binds their own chats.
  store.setBudget({ scope: "person", key: "alex", limitMicrousd: 1_000_000, hardStop: true }, "alex", NOW);
  expect(store.openChatTurn({ approver: "alex", credentialKey: "k", provider: "openrouter", model: "m", reservedMicrousd: 1, dailyTurns: 99, weeklyCeilingMicrousd: 99_000_000, deadlineMs: 1000 }, NOW))
    .toEqual({ ok: false, reason: "monthly-budget" });
  const changes = store.actionLedger({ repos: null, instance: true, limit: 20 }).filter(one => one.action.startsWith("budget set")).map(one => one.detail);
  expect(changes).toEqual(expect.arrayContaining(["none → $10 a month, stops API work", "$10 a month, stops API work → $10 a month, alerts only"]));
  expect(store.removeBudget(store.budgets().find(one => one.scope === "person")!.id, "alex", NOW)).toBe(true);
  expect(store.budgets().map(one => one.scope)).toEqual(["project"]);
});

test("alerts go out at 50, 80 and 100 %, once each a month, only the highest mark newly reached; a person's to that person", () => {
  store.setBudget({ scope: "person", key: "alex", limitMicrousd: 10_000_000, hardStop: true }, "alex", NOW);
  work({ name: "alex", kind: "person" }, { costUsd: 4 });
  expect(budgetAlertPass(store, NOW).sent).toEqual([]);
  work({ name: "alex", kind: "person" }, { costUsd: 2 });
  expect(budgetAlertPass(store, NOW).sent.map(one => one.mark)).toEqual([50]);
  expect(budgetAlertPass(store, NOW).sent).toEqual([]);
  // A jump past both remaining marks says so once.
  work({ name: "alex", kind: "person" }, { costUsd: 5 });
  expect(budgetAlertPass(store, NOW).sent.map(one => one.mark)).toEqual([100]);
  expect(budgetAlertPass(store, NOW).sent).toEqual([]);
  const sent = store.handle.prepare("SELECT subject, recipient, push_class FROM notification WHERE kind = 'budget-alert' ORDER BY id").all();
  expect(sent).toEqual([
    { subject: "alex's budget: 50% used", recipient: "alex", push_class: "attention" },
    { subject: "alex's budget: 100% used", recipient: "alex", push_class: "attention" },
  ]);
  expect(store.actionLedger({ repos: null, instance: true, limit: 20 }).find(one => one.action === "budget 100% used: alex")).toMatchObject({ outcome: "stopped", detail: "$11 of $10 in 2026-09" });
  // Raised, the budget alerts afresh at its new marks.
  store.setBudget({ scope: "person", key: "alex", limitMicrousd: 20_000_000, hardStop: true }, "alex", NOW);
  expect(budgetAlertPass(store, NOW).sent.map(one => one.mark)).toEqual([50]);
});

test("the Spend page, its CSV and budgets are an instance operator's; the task page says when a budget holds a task", async () => {
  const alex = addApprover(store, "alex", NOW);
  if (!alex.ok) throw new Error("alex");
  const sam = addApprover(store, "sam", NOW, { name: "alex", token: alex.token });
  if (!sam.ok) throw new Error("sam");
  expect(store.setAccountProjects("sam", [REPO], "alex", NOW)).toEqual({ ok: true });
  work({ name: "alex", kind: "person" }, { costUsd: 3 }, new Date());
  const server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repo: REPO });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("listen");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const signIn = async (name: string, token: string) => (await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name, token }), redirect: "manual" }))
      .headers.getSetCookie().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
    const cookie = await signIn("alex", alex.token);
    const page = await (await fetch(`${base}/spend`, { headers: { cookie } })).text();
    expect(page).toContain("<h1>Spend</h1>");
    expect(page).toContain('data-spend-total="3000000"');
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(page)![1]!;
    const post = (fields: Record<string, string>) => fetch(`${base}/spend/budget`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, ...fields }), redirect: "manual" });
    expect((await post({ target: `project:${REPO}`, usd: "2", stop: "1", action: "save", password: "wrong" })).headers.get("location")).toContain("problem=");
    expect(store.budgets()).toEqual([]);
    expect((await post({ target: `project:${REPO}`, usd: "2", stop: "1", action: "save", password: alex.token })).headers.get("location")).toContain("said=");
    expect(store.budgets()).toMatchObject([{ scope: "project", key: REPO, limitMicrousd: 2_000_000, hardStop: true }]);
    expect((await post({ target: "project:/somewhere/else", usd: "2", action: "save", password: alex.token })).headers.get("location")).toContain("problem=");
    const csv = await fetch(`${base}/spend?format=csv`, { headers: { cookie } });
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(await csv.text()).toContain("time_utc,kind,project,person");
    // A queued task under the used-up budget says why it waits.
    store.createTask({ id: "waiting", title: "waiting", filedBy: { name: "alex", kind: "person" } }, new Date());
    store.placeTask(store.refFor("built-in", "waiting").id, REPO);
    expect(await (await fetch(`${base}/t/waiting`, { headers: { cookie } })).text()).toContain("monthly budget is used up");
    const samCookie = await signIn("sam", sam.token);
    expect((await fetch(`${base}/spend`, { headers: { cookie: samCookie }, redirect: "manual" })).status).toBe(403);
    // Tasks shows the plan's windows and the budgets to whoever runs the installation, and to no one else.
    store.recordProviderLimits({ provider: "claude", plan: null, windows: [{ window: "five_hour", usedPercent: 48, windowMinutes: 300, resetsAt: new Date(Date.now() + 3_600_000).toISOString(), reached: false }] }, new Date());
    const tasks = await (await fetch(`${base}/work`, { headers: { cookie } })).text();
    expect(tasks).toContain('data-limit="claude:five_hour"');
    expect(tasks).toContain(`data-limit="budget:${store.budgets()[0]!.id}"`);
    expect(await (await fetch(`${base}/work`, { headers: { cookie: samCookie } })).text()).not.toContain("data-limit=");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("the command line shows the month and sets budgets for an instance operator", async () => {
  const alex = addApprover(store, "alex", NOW);
  if (!alex.ok) throw new Error("alex");
  work({ name: "alex", kind: "person" }, { costUsd: 2 }, new Date());
  store.close();
  let lines: string[] = [];
  const run = async (command: string, argv: string[]) => { lines = []; const code = await runOperate(command, argv, line => { lines.push(line); }, { databaseFile: file }); return { code, out: lines.join("\n") }; };
  try {
    expect(JSON.parse((await run("spend", ["--json"])).out)).toMatchObject({ ok: true, totalMicrousd: 2_000_000 });
    expect((await run("budget", ["set", "--person", "alex", "--usd", "50", "--json"])).code).toBe(3);
    expect((await run("budget", ["set", "--person", "alex", "--usd", "50", "--as", "alex", "--token", alex.token])).out).toContain("alex: $50 a month, API work stops at 100%.");
    expect((await run("budget", ["list"])).out).toContain("alex: $2.00 of $50 this month (4%)");
    expect((await run("spend", ["--csv"])).out.split(/\r?\n/)[0]).toBe("time_utc,kind,project,person,subagent,task,run,provider,model,tokens_in,tokens_out,cost_usd,priced_by,billing");
  } finally {
    store = openStore(file);
  }
});

test("a plan's windows: Claude says them each turn, Codex when asked; the latest reading is kept and shown as tiles", async () => {
  // As Claude Code 2.1 writes it (captured 2026-09-28).
  const event = { type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1790655000, rateLimitType: "five_hour", overageStatus: "rejected", isUsingOverage: false,
    unifiedWindows: { five_hour: { utilization: 0.48, resetsAt: 1790655000 }, seven_day: { utilization: 0.4, resetsAt: 1791010800 } } } };
  expect(claudeLimitsOf(event)).toEqual({ provider: "claude", plan: null, windows: [
    { window: "five_hour", usedPercent: 48, windowMinutes: 300, resetsAt: "2026-09-29T04:10:00.000Z", reached: false },
    { window: "seven_day", usedPercent: 40, windowMinutes: 10080, resetsAt: "2026-10-03T07:00:00.000Z", reached: false },
  ], billing: "subscription" });
  expect(claudeLimitsOf({ type: "assistant" })).toBeNull();
  expect(claudeLimitsOf({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: 1790655000 } })?.windows[0]).toMatchObject({ usedPercent: 100, reached: true });
  // As Codex 0.156's app server answers `account/rateLimits/read`.
  expect(codexLimitsOf({ rateLimits: { primary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1791129619 }, secondary: null, planType: "pro", rateLimitReachedType: null } }))
    .toEqual({ provider: "codex", plan: "pro", windows: [{ window: "seven_day", usedPercent: 12, windowMinutes: 10080, resetsAt: "2026-10-04T16:00:19.000Z", reached: false }] });

  // A real Claude stream reaches the store through the sink the command line sets.
  const read = new Date("2026-09-28T23:00:00.000Z");
  dropSink = pushLimitSink(reading => store.recordProviderLimits(reading, read));
  const line = JSON.stringify(event);
  await runClaudeStreamJsonl(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(line)} + "\\n" + JSON.stringify({ type: "result", subtype: "success", result: "ok", session_id: "s" }) + "\\n")`], { timeoutMs: 15_000 });
  noteLimits(codexLimitsOf({ rateLimits: { primary: { usedPercent: 85, windowDurationMins: 10080, resetsAt: 1791129619 }, planType: "pro" } }));
  expect(store.providerLimits().map(one => `${one.provider}:${one.window}:${one.usedPercent}`)).toEqual(["claude:five_hour:48", "claude:seven_day:40", "codex:seven_day:85"]);
  // A window no longer reported is dropped.
  store.recordProviderLimits({ provider: "claude", plan: null, windows: [{ window: "five_hour", usedPercent: 50, windowMinutes: 300, resetsAt: "2026-09-29T02:50:00.000Z", reached: false }] }, read);
  expect(store.providerLimits().filter(one => one.provider === "claude").map(one => one.window)).toEqual(["five_hour"]);

  store.setBudget({ scope: "project", key: REPO, limitMicrousd: 10_000_000, hardStop: true }, "alex", NOW);
  work({ name: "alex", kind: "person" }, { costUsd: 9 });
  const at = new Date("2026-09-28T23:40:00.000Z");
  const view = limitsView(store.providerLimits(), store.monthSpend(NOW).budgets, { project: repo => repo.split("/").pop()!, subagent: String }, at)!;
  expect(view.tiles.map(tile => [tile.name, tile.window, tile.value, tile.unit, tile.tone, tile.detail])).toEqual([
    ["Claude", "5-hour", "50", "%", "neutral", "Resets in 3 h 10 min · read 40m ago"],
    ["Codex Pro", "Weekly", "85", "%", "warning", expect.stringMatching(/^Resets \w{3} \d+ (AM|PM) · read 40m ago$/)],
    ["shop", "Budget", "$9.00", "of $10", "warning", "Stops API work at 100%"],
  ]);
  // A window that has turned over since the reading starts again.
  const later = limitsView(store.providerLimits(), [], { project: String, subagent: String }, new Date("2026-09-29T03:00:00.000Z"))!;
  expect(later.tiles[0]).toMatchObject({ value: "0", detail: "New window" });
  expect(limitsView([], [], { project: String, subagent: String }, NOW)).toBeNull();

  // Odd lines: a window named like an object's own property still reads; a bare "rejected" names one window and
  // leaves the others; Codex's reached reason marks its fullest window; an internal plan name isn't shown.
  expect(claudeLimitsOf({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: { constructor: { utilization: 0.1 } } } })?.windows[0]).toMatchObject({ window: "constructor", windowMinutes: null });
  store.recordProviderLimits(claudeLimitsOf({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.2 }, seven_day: { utilization: 0.3 } } } })!, read);
  store.recordProviderLimits(claudeLimitsOf({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour" } })!, read);
  expect(store.providerLimits().filter(one => one.provider === "claude").map(one => `${one.window}:${one.usedPercent}`)).toEqual(["five_hour:100", "seven_day:30"]);
  const codex = codexLimitsOf({ rateLimits: { primary: { usedPercent: 99, windowDurationMins: 300 }, secondary: { usedPercent: 40, windowDurationMins: 10080 }, rateLimitReachedType: "rate_limit_reached", planType: "self_serve_business_usage_based" } })!;
  expect(codex.windows.map(one => one.reached)).toEqual([true, false]);
  expect(limitsView(codex.windows.map(one => ({ ...one, provider: "codex", plan: codex.plan, observedAt: NOW.toISOString() })), [], { project: String, subagent: String }, NOW)!.tiles[0]!.name).toBe("Codex");
  // A command that ends inside a longer one leaves the longer one's sink in place.
  const seen: string[] = [];
  const outer = pushLimitSink(reading => seen.push(`outer:${reading.provider}`));
  const inner = pushLimitSink(reading => seen.push(`inner:${reading.provider}`));
  noteLimits(codex);
  inner();
  noteLimits(codex);
  outer();
  noteLimits(codex);
  expect(seen).toEqual(["inner:codex", "outer:codex"]);
});
