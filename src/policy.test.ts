/**
 * Organisation policy (sprint 8): allowed providers, models and project tools,
 * and a permission ceiling, saved behind a step-up with its history in the
 * ledger, and obeyed wherever work is admitted: scope approval, the tick and
 * build() before a run starts, race lanes, chats,
 * subagents and flow steps.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { htmlString } from "./html.js";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover, approve, propose, type ExecutionProfile } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { EXIT, runOperate } from "./operate.js";
import { register } from "./runner.js";
import { run as exec } from "./exec.js";
import type { Runner } from "./builder.js";
import { agentRefusal, checkPolicy, levelOfProfile, modelMatches, OPEN_POLICY, parseList, policyProvider, toolRefusal, underCeiling, type OrgPolicy } from "./policy.js";
import { subagentReady } from "./subagent-work.js";
import { makeCall, offeredTools } from "./subagent-tools.js";
import { toolLaunchFor, validateToolSpec } from "./project-tools.js";
import { runFlowSteps, type StepIo } from "./flow-steps.js";
import { flowFromSteps } from "./flows.js";
import { setAuthMode } from "./keys.js";
import { policyHtml } from "./policy-ui.js";

const T0 = new Date("2026-09-28T09:00:00.000Z");
const REPO = "/repos/shop";
const claude = (permissionArgv: "auto" | "acceptEdits" | "bypassPermissions", model = "claude-sonnet-5"): ExecutionProfile =>
  ({ provider: "claude", model, permissionArgv, maxTurns: 1000, repairMaxTurns: 4, timeoutSeconds: 1200, timeoutKind: "idle", repairTimeoutSeconds: 300, repairModel: "inherit" });
const codex = (sandboxMode: "workspace-write" | "danger-full-access"): ExecutionProfile =>
  ({ provider: "codex", model: "gpt-6-astra", sandboxMode, maxTurns: "unsupported", repairMaxTurns: "unsupported", timeoutSeconds: 1200, timeoutKind: "idle", repairTimeoutSeconds: 300, repairModel: "gpt-6-astra" });
const gemini = (approvalArgv: "auto_edit" | "yolo"): ExecutionProfile =>
  ({ provider: "gemini", model: "gemini-3-pro", approvalArgv, maxTurns: "unsupported", repairMaxTurns: "unsupported", timeoutSeconds: 1200, timeoutKind: "idle", repairTimeoutSeconds: 300, repairModel: "gemini-3-pro" });
const policy = (over: Partial<OrgPolicy>): OrgPolicy => ({ ...OPEN_POLICY, ...over });

// How each provider bills comes from its auth-mode file under HOME: every test gets its own.
let home: string | undefined, homeDir: string;
beforeEach(() => {
  home = process.env["HOME"];
  homeDir = realpathSync(mkdtempSync(join(tmpdir(), "so-policy-home-")));
  process.env["HOME"] = homeDir;
  for (const provider of ["claude", "codex", "gemini", "openrouter"] as const) setAuthMode(provider, provider === "claude" || provider === "codex" ? "subscription" : "api-key");
});
afterEach(() => { process.env["HOME"] = home; rmSync(homeDir, { recursive: true, force: true }); });

describe("the rules", () => {
  test("providers and models: chat and key variants count as their provider; a model list matches ids or families; a default model can't be checked", () => {
    expect(policyProvider("anthropic-api")).toBe("claude");
    expect(policyProvider("codex-subscription")).toBe("codex");
    expect(policyProvider("openrouter-api")).toBe("openrouter");
    expect(agentRefusal(OPEN_POLICY, "gemini", null)).toBeNull();
    expect(agentRefusal(policy({ providers: ["claude"] }), "codex", "gpt-6-astra")).toBe("The organisation policy doesn't allow Codex. An instance operator can change it in Settings → Policy.");
    expect(agentRefusal(policy({ providers: ["claude"] }), "anthropic-api", "claude-sonnet-5")).toBeNull();
    const models = policy({ models: ["claude-sonnet-*", "gpt-6-astra"] });
    expect(modelMatches("claude-sonnet-*", "Claude-Sonnet-5-5")).toBe(true);
    expect(agentRefusal(models, "claude", "claude-sonnet-5")).toBeNull();
    expect(agentRefusal(models, "claude", "claude-opus-5-5")).toBe("The organisation policy doesn't allow the model claude-opus-5-5. An instance operator can change it in Settings → Policy.");
    expect(agentRefusal(models, "claude", "default")).toMatch(/allows only listed models, and this uses Claude's default model/);
    expect(toolRefusal(policy({ tools: ["github"] }), "stripe")).toBe("The organisation policy doesn't allow the tool stripe. An instance operator can change it in Settings → Policy.");
    expect(toolRefusal(policy({ tools: ["github"] }), "github")).toBeNull();
  });

  test("the ceiling keeps what's within it, lowers what it can and refuses what its provider can't run that low, saying which", () => {
    expect([claude("acceptEdits"), claude("auto"), claude("bypassPermissions"), codex("workspace-write"), codex("danger-full-access"), gemini("auto_edit"), gemini("yolo")].map(levelOfProfile))
      .toEqual(["safe", "standard", "escalated", "standard", "escalated", "safe", "escalated"]);
    expect(underCeiling(policy({ ceiling: "escalated" }), claude("bypassPermissions"))).toMatchObject({ ok: true, lowered: null });
    expect(underCeiling(policy({ ceiling: "standard" }), claude("bypassPermissions"))).toEqual({ ok: true, profile: claude("auto"),
      lowered: "The organisation policy's permission ceiling is Standard, so this runs with auto instead of full access." });
    expect(underCeiling(policy({ ceiling: "standard" }), codex("danger-full-access"))).toMatchObject({ ok: true, profile: codex("workspace-write") });
    expect(underCeiling(policy({ ceiling: "safe" }), claude("bypassPermissions"))).toMatchObject({ ok: true, profile: claude("acceptEdits") });
    expect(underCeiling(policy({ ceiling: "safe" }), gemini("yolo"))).toMatchObject({ ok: true, profile: gemini("auto_edit") });
    expect(underCeiling(policy({ ceiling: "safe" }), codex("workspace-write"))).toEqual({ ok: false,
      message: "The organisation policy's permission ceiling is Safe, and Codex can't run that low. An instance operator can change it in Settings → Policy." });
  });

  test("a policy is checked before it's saved", () => {
    expect(parseList(" a, b\nb ,, ")).toEqual(["a", "b"]);
    expect(parseList("  ")).toBeNull();
    expect(checkPolicy({ providers: ["Claude", "codex-subscription"], models: null, tools: null, ceiling: "standard" })).toEqual({ ok: true, policy: { providers: ["claude", "codex"], models: null, tools: null, ceiling: "standard" } });
    expect(checkPolicy({ providers: ["mistral"], models: null, tools: null, ceiling: "safe" })).toMatchObject({ ok: false, problem: expect.stringContaining("mistral isn't a provider here") });
    expect(checkPolicy({ providers: [], models: null, tools: null, ceiling: "safe" })).toMatchObject({ ok: false, problem: "Allow at least one provider, or allow any." });
    expect(checkPolicy({ providers: null, models: ["bad model!"], tools: null, ceiling: "safe" })).toMatchObject({ ok: false });
    expect(checkPolicy({ providers: null, models: null, tools: null, ceiling: "root" })).toMatchObject({ ok: false, problem: "Choose a permission ceiling: safe, standard or escalated." });
  });
});

describe("in the store", () => {
  let store: Store;
  let token: string;
  beforeEach(() => {
    store = openStore(":memory:");
    for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "claude-sonnet-5", "alex", T0);
    const alex = addApprover(store, "alex", T0);
    if (!alex.ok) throw new Error("approver");
    token = alex.token;
  });
  afterEach(() => store.close());
  const file = (id: string, repo = REPO) => {
    store.createTask({ id, title: id }, T0);
    store.placeTask(store.refFor("built-in", id).id, repo);
    propose(store, { taskId: id, goal: `do ${id}`, now: T0 });
    return store.getScope(id)!;
  };

  test("planners, scouts and native coding sessions have no profile to lower: under a Safe ceiling Codex can't run them, Claude can", () => {
    store.setOrgPolicy(policy({ ceiling: "safe" }), "alex", T0);
    expect(store.sessionPolicyRefusal("codex", null, "planning")).toMatch(/ceiling is Safe, and Codex planning can't run that low/);
    expect(store.sessionPolicyRefusal("codex", null, "coding sessions")).toMatch(/Codex coding sessions can't run that low/);
    expect(store.sessionPolicyRefusal("claude", "claude-sonnet-5", "planning")).toBeNull();
    store.setOrgPolicy(policy({ ceiling: "standard" }), "alex", T0);
    expect(store.sessionPolicyRefusal("codex", null, "coding sessions")).toBeNull();
    // A provider the policy doesn't allow is stopped whatever the ceiling.
    store.setOrgPolicy(policy({ providers: ["claude"] }), "alex", T0);
    expect(store.sessionPolicyRefusal("codex", null, "coding sessions")).not.toBeNull();
  });

  test("saving keeps each changed rule in the ledger, before → after, and nothing when nothing changed", () => {
    expect(store.orgPolicy()).toMatchObject({ ...OPEN_POLICY, updatedBy: null });
    store.setOrgPolicy(policy({ providers: ["claude", "codex"], ceiling: "standard" }), "alex", T0);
    store.setOrgPolicy(policy({ providers: ["claude", "codex"], ceiling: "standard" }), "alex", T0);
    store.setOrgPolicy(policy({ providers: ["claude"], models: ["claude-sonnet-*"], tools: ["github"], ceiling: "standard" }), "sam", new Date(T0.getTime() + 60_000));
    expect(store.orgPolicy()).toMatchObject({ providers: ["claude"], models: ["claude-sonnet-*"], tools: ["github"], ceiling: "standard", updatedBy: "sam" });
    expect(store.policyHistory().map(one => [one.actor, one.action, one.detail])).toEqual([
      ["sam", "organisation policy: allowed tools", "any → github"],
      ["sam", "organisation policy: allowed models", "any → claude-sonnet-*"],
      ["sam", "organisation policy: allowed providers", "Claude, Codex → Claude"],
      ["alex", "organisation policy: permission ceiling", "Escalated → Standard"],
      ["alex", "organisation policy: allowed providers", "any → Claude, Codex"],
    ]);
    // The same entries are the action ledger's, sealed with everything else.
    expect(store.actionLedger({ repos: null, instance: true, source: "policy", limit: 20 }).filter(one => one.action.startsWith("organisation policy"))).toHaveLength(5);
  });

  test("scope approval refuses a disallowed provider or model, in words naming the policy, and records no vote", () => {
    const scope = file("t-1");
    store.setOrgPolicy(policy({ providers: ["codex"] }), "alex", T0);
    expect(approve(store, "t-1", "alex", T0, scope.digest, token)).toEqual({ ok: false, reason: "policy", message: "The organisation policy doesn't allow Claude. An instance operator can change it in Settings → Policy." });
    store.setOrgPolicy(policy({ models: ["claude-opus-*"] }), "alex", T0);
    expect(approve(store, "t-1", "alex", T0, scope.digest, token)).toMatchObject({ ok: false, reason: "policy", message: expect.stringContaining("doesn't allow the model claude-sonnet-5") });
    expect(store.approvalVotes("t-1")).toEqual([]);
    // The seal itself refuses too, on every road: an operating mode's included.
    expect(store.sealScopeApproval("t-1", "alex", T0)).toBe(false);
    store.setOrgPolicy(OPEN_POLICY, "alex", T0);
    expect(approve(store, "t-1", "alex", T0, scope.digest, token).ok).toBe(true);
  });

  test("an approved task stopped by a later policy is refused before it runs; one above the ceiling runs lowered", () => {
    store.setPermissionDefault("bypassPermissions", "alex", T0);
    const scope = file("t-2");
    expect(scope.profile).toMatchObject({ permissionArgv: "bypassPermissions" });
    expect(approve(store, "t-2", "alex", T0, scope.digest, token).ok).toBe(true);
    const sealed = store.getScope("t-2")!.approvedProfile!;
    store.setOrgPolicy(policy({ ceiling: "standard" }), "alex", T0);
    expect(store.runPolicy(sealed)).toMatchObject({ ok: true, profile: { permissionArgv: "auto" }, lowered: expect.stringContaining("runs with auto instead of full access") });
    store.setOrgPolicy(policy({ providers: ["gemini"] }), "alex", T0);
    expect(store.runPolicy(sealed)).toEqual({ ok: false, message: "The organisation policy doesn't allow Claude. An instance operator can change it in Settings → Policy." });
  });

  test("a new filing is lowered to the ceiling (the installation default, a mode's escalated posture), and approval refuses what can't be", () => {
    store.setPermissionDefault("bypassPermissions", "alex", T0);
    store.setOrgPolicy(policy({ ceiling: "standard" }), "alex", T0);
    const lowered = file("t-3");
    expect(lowered.profile).toMatchObject({ permissionArgv: "auto" });
    expect(approve(store, "t-3", "alex", T0, lowered.digest, token).ok).toBe(true);
    // A hands-off mode files escalated; under the ceiling it files within it.
    store.createTask({ id: "t-4", title: "t-4" }, T0);
    store.placeTask(store.refFor("built-in", "t-4").id, REPO);
    store.saveScope({ taskId: "t-4", goal: "under a mode", outOfScope: null, touches: [], budgetMicrousd: null, acceptance: [], proposedAt: T0.toISOString(), digest: "", approvedAt: null, approvedBy: null, approvedDigest: null }, {}, { posture: "escalated" });
    expect(store.getScope("t-4")!.profile).toMatchObject({ permissionArgv: "auto" });
    // At Safe, Claude files accepting edits; Codex has nothing that low, and approval says so.
    store.setOrgPolicy(policy({ ceiling: "safe" }), "alex", T0);
    expect(file("t-5").profile).toMatchObject({ permissionArgv: "acceptEdits" });
    store.setPhaseConfig("installation", "build", "codex", "gpt-6-astra", "alex", T0);
    store.setPhaseConfig(REPO, "build", "codex", "gpt-6-astra", "alex", T0);
    const onCodex = file("t-6");
    expect(onCodex.profile).toMatchObject({ provider: "codex", sandboxMode: "workspace-write" });
    expect(approve(store, "t-6", "alex", T0, onCodex.digest, token)).toMatchObject({ ok: false, reason: "policy", message: expect.stringContaining("Codex can't run that low") });
  });

  test("subagents: a disallowed model or provider stops their turns; a disallowed tool isn't offered and its calls are refused", async () => {
    store.createSubagent({ repo: REPO, handle: "maya", soul: "---\nname: Maya\nrole: Support\n---\n## Who you are\nHelpful.\n", model: "claude-sonnet-5", manager: "alex", by: "alex" }, T0);
    const mate = store.subagents([REPO])[0]!;
    expect(subagentReady(store, mate, T0)).toEqual({ ok: true });
    store.setOrgPolicy(policy({ models: ["claude-opus-*"] }), "alex", T0);
    expect(subagentReady(store, mate, T0)).toEqual({ ok: false, why: "The organisation policy doesn't allow the model claude-sonnet-5. An instance operator can change it in Settings → Policy." });
    store.setOrgPolicy(policy({ providers: ["codex"] }), "alex", T0);
    expect(subagentReady(store, mate, T0)).toMatchObject({ ok: false, why: expect.stringContaining("doesn't allow Claude") });

    store.setOrgPolicy(OPEN_POLICY, "alex", T0);
    store.addProjectTool({ repo: REPO, name: "shop", specJson: JSON.stringify(validateToolSpec({ name: "shop", command: "node", args: ["shop.js"], secrets: [], about: "The shop" })), digest: "d", source: "test", by: "alex" }, T0);
    store.saveSubagentGrant({ subagent: mate.id, tool: "shop", actions: [{ name: "lookup_order", about: "Look up", input: null, readOnly: true }], rules: { lookup_order: { use: "free" } } }, "alex", T0);
    expect(offeredTools(store, mate).map(one => one.name)).toHaveLength(1);
    store.setOrgPolicy(policy({ tools: ["github"] }), "alex", T0);
    expect(offeredTools(store, mate)).toEqual([]);
    const flow = store.createFlow({ repo: REPO, name: "Desk", definitionJson: "{}", by: "alex" }, T0);
    const card = store.addFlowCard({ flow, title: "Where is order 1044?", description: null, stage: "maya", by: "alex" }, T0);
    const id = store.addSubagentCall({ subagent: mate.id, card, entry: 1, tool: "shop", action: "lookup_order", input: { order: "1044" }, rule: "free", why: "to answer", state: "approved" }, T0);
    const made = await makeCall(store, store.subagentCall(id)!, REPO, { callTool: async () => { throw new Error("a disallowed tool is never called"); } }, T0);
    expect(made).toMatchObject({ state: "refused", result: "The organisation policy doesn't allow the tool shop. An instance operator can change it in Settings → Policy." });
  });

  test("a build launches without a tool the policy doesn't allow, and its run says why", () => {
    store.addProjectTool({ repo: REPO, name: "shop", specJson: JSON.stringify(validateToolSpec({ name: "shop", command: "node", args: ["shop.js"], secrets: [], about: "The shop" })), digest: "d", source: "test", by: "alex" }, T0);
    store.createTask({ id: "t-9", title: "t-9" }, T0);
    const ref = store.refFor("built-in", "t-9").id;
    store.placeTask(ref, REPO);
    const run = store.startRun({ taskRef: ref, leaseId: "l-9", runner: "b1", branch: "b9", worktree: "/w9", route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" }, now: T0 });
    expect(toolLaunchFor(store, run).tools.map(one => one.spec.name)).toEqual(["shop"]);
    store.setOrgPolicy(policy({ tools: ["github"] }), "alex", T0);
    expect(toolLaunchFor(store, run)).toEqual({ tools: [], skipped: [{ name: "shop", reason: "The organisation policy doesn't allow the tool shop. An instance operator can change it in Settings → Policy." }] });
  });
});

describe("flow steps", () => {
  let dir: string, store: Store;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "so-policy-flow-")));
    store = openStore(join(dir, "orders.db"));
    if (!addApprover(store, "alex", T0).ok) throw new Error("approver");
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const io = (): StepIo => ({ gh: async () => { throw new Error("no gh"); }, git: exec, shell: exec, fetch: (async () => { throw new Error("nothing is sent"); }) as unknown as typeof fetch,
    dir, scratch: join(dir, "scratch"), base: "main", evidenceRoot: dir, openRouterKey: () => "sk-or-fixture", draft: async () => { throw new Error("no draft runs"); } });

  test("a sort, a draft or a tool step the policy doesn't allow waits and says which rule", async () => {
    const flow = store.createFlow({ repo: REPO, name: "Inbox", by: "alex", definitionJson: JSON.stringify(flowFromSteps([
      { title: "Inbox", kind: "inbox" }, { title: "Reply", kind: "draft", instructions: "Write a short reply." },
    ], null)) }, T0);
    const card = store.addFlowCard({ flow, title: "A refund question", description: null, stage: "reply", by: "alex" }, T0);
    store.setOrgPolicy(policy({ providers: ["codex"] }), "alex", T0);
    expect(await runFlowSteps(store, REPO, T0, io())).toMatchObject({ ran: 0 });
    expect(store.getFlowCard(card)!.waiting).toBe("The organisation policy doesn't allow Claude. An instance operator can change it in Settings → Policy.");
    // Sorting runs Jev through OpenRouter.
    const sorting = store.createFlow({ repo: REPO, name: "Triage", by: "alex", definitionJson: JSON.stringify(flowFromSteps([
      { title: "Inbox", kind: "inbox" }, { title: "Sort", kind: "sort", question: "Is it urgent?", answers: [{ answer: "Urgent", means: "needs a reply today", goesTo: "Inbox" }, { answer: "Later", means: "can wait", goesTo: "Inbox" }] },
    ], null)) }, T0);
    const sorted = store.addFlowCard({ flow: sorting, title: "Site is down", description: null, stage: "sort", by: "alex" }, T0);
    await runFlowSteps(store, REPO, T0, io());
    expect(store.getFlowCard(sorted)!.waiting).toBe("The organisation policy doesn't allow OpenRouter. An instance operator can change it in Settings → Policy.");
    // A tool step calls one of the project's tools.
    store.addProjectTool({ repo: REPO, name: "shop", specJson: JSON.stringify(validateToolSpec({ name: "shop", command: "node", args: ["shop.js"], secrets: [], about: "The shop" })), digest: "d", source: "test", by: "alex" }, T0);
    const calling = store.createFlow({ repo: REPO, name: "Refunds", by: "alex", definitionJson: JSON.stringify(flowFromSteps([
      { title: "Inbox", kind: "inbox" }, { title: "Look up", kind: "tool", server: "shop", tool: "lookup_order", args: { order: "{{card.title}}" } },
    ], null)) }, T0);
    const called = store.addFlowCard({ flow: calling, title: "1044", description: null, stage: "look-up", by: "alex" }, T0);
    store.setOrgPolicy(policy({ tools: ["github"] }), "alex", T0);
    await runFlowSteps(store, REPO, T0, { ...io(), callTool: async () => { throw new Error("a disallowed tool is never called"); } });
    expect(store.getFlowCard(called)!.waiting).toBe("The organisation policy doesn't allow the tool shop. An instance operator can change it in Settings → Policy.");
  });
});

describe("the page and the command line", () => {
  let dir: string, file: string, store: Store;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "so-policy-")));
    file = join(dir, "orders.db");
    store = openStore(file);
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  test("Settings → Policy saves behind the password step-up, shows its history, and is read-only to others", async () => {
    const alex = addApprover(store, "alex", T0);
    if (!alex.ok) throw new Error("alex");
    const sam = addApprover(store, "sam", T0, { name: "alex", token: alex.token });
    if (!sam.ok) throw new Error("sam");
    // Someone with one project isn't an instance operator.
    expect(store.setAccountProjects("sam", [REPO], "alex", T0)).toEqual({ ok: true });
    const server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repo: REPO });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address !== "object") throw new Error("listen");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const signIn = async (name: string, token: string) => (await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name, token }), redirect: "manual" }))
        .headers.getSetCookie().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
      const cookie = await signIn("alex", alex.token);
      const page = await (await fetch(`${base}/settings/policy`, { headers: { cookie } })).text();
      expect(page).toContain("<h1>Policy</h1>");
      expect(page).toContain('name="ceiling" value="escalated" checked');
      const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(page)![1]!;
      const post = (fields: [string, string][], who = cookie) => fetch(`${base}/settings/policy`, { method: "POST", headers: { cookie: who, origin: base }, body: new URLSearchParams([["csrf", csrf], ...fields]), redirect: "manual" });
      const wanted: [string, string][] = [["provider", "claude"], ["provider", "codex"], ["models", "claude-sonnet-*\ngpt-6-astra"], ["tools", ""], ["ceiling", "standard"]];
      const wrong = await post([...wanted, ["password", "wrong"]]);
      expect(decodeURIComponent(wrong.headers.get("location") ?? "")).toContain("problem=That password didn't match. Nothing changed.");
      expect(store.orgPolicy().ceiling).toBe("escalated");
      const saved = await post([...wanted, ["password", alex.token]]);
      expect(decodeURIComponent(saved.headers.get("location") ?? "")).toContain("said=Policy saved.");
      expect(store.orgPolicy()).toMatchObject({ providers: ["claude", "codex"], models: ["claude-sonnet-*", "gpt-6-astra"], tools: null, ceiling: "standard", updatedBy: "alex" });
      const after = await (await fetch(`${base}/settings/policy`, { headers: { cookie } })).text();
      expect(after).toContain("History (3)");
      expect(after).toContain("Permission ceiling: Escalated → <strong>Standard</strong>");
      expect(after).toContain("Allowed providers: any → <strong>Claude, Codex</strong>");
      // All four providers ticked is "any"; an unknown ceiling changes nothing.
      expect(decodeURIComponent((await post([["provider", "claude"], ["ceiling", "root"], ["password", alex.token]])).headers.get("location") ?? "")).toContain("problem=Choose a permission ceiling");
      // Someone who works within their projects doesn't open it, nor change it.
      const samCookie = await signIn("sam", sam.token);
      expect((await fetch(`${base}/settings/policy`, { headers: { cookie: samCookie }, redirect: "manual" })).status).toBe(403);
      expect((await post([...wanted, ["ceiling", "escalated"], ["password", sam.token]], samCookie)).status).toBe(403);
      expect(store.orgPolicy().ceiling).toBe("standard");
      // Read-only, it says what's in force and who sets it, with no form.
      const readOnly = htmlString(policyHtml({ policy: store.orgPolicy(), history: store.policyHistory(), canChange: false, toolNames: [] }, {}));
      expect(readOnly).toContain("<dt>Ceiling</dt><dd>Standard</dd>");
      expect(readOnly).toContain("An instance operator sets the policy.");
      expect(readOnly).not.toContain("<form");
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  test("policy show and policy set; set takes an instance operator's credentials", async () => {
    const alex = addApprover(store, "alex", T0);
    if (!alex.ok) throw new Error("alex");
    store.close();
    let lines: string[] = [];
    const run = async (argv: string[]) => { lines = []; const code = await runOperate("policy", argv, line => { lines.push(line); }, { databaseFile: file, now: T0 }); return { code, out: lines.join("\n") }; };
    try {
      expect((await run(["show"])).out).toContain("Ceiling:   Escalated");
      expect((await run(["set", "--ceiling", "standard", "--json"])).code).toBe(EXIT.refused);
      expect((await run(["set", "--ceiling", "standard", "--as", "alex", "--token", "wrong", "--json"])).code).toBe(EXIT.refused);
      const set = await run(["set", "--providers", "claude,codex", "--ceiling", "standard", "--as", "alex", "--token", alex.token]);
      expect(set.out).toContain("Policy saved.");
      expect(set.code).toBe(EXIT.ok);
      expect(set.out).toContain("Providers: Claude, Codex");
      expect((await run(["set", "--models", "claude-sonnet-*", "--as", "alex", "--token", alex.token])).code).toBe(EXIT.ok);
      expect((await run(["set", "--providers", "any", "--as", "alex", "--token", alex.token])).code).toBe(EXIT.ok);
      expect((await run(["set", "--ceiling", "root", "--as", "alex", "--token", alex.token])).code).toBe(EXIT.usage);
      const shown = JSON.parse((await run(["show", "--history", "--json"])).out);
      expect(shown).toMatchObject({ ok: true, policy: { providers: null, models: ["claude-sonnet-*"], tools: null, ceiling: "standard", updatedBy: "alex" } });
      expect(shown.history.map((one: { detail: string }) => one.detail)).toEqual(["Claude, Codex → any", "any → claude-sonnet-*", "Escalated → Standard", "any → Claude, Codex"]);
    } finally {
      store = openStore(file);
    }
  });
});

describe("the tick, against real git", () => {
  let base: string, repo: string, db: string, pool: string;
  let lines: string[] = [];
  const argvs: string[][] = [];
  const payload = () => JSON.parse(lines.join("\n"));
  const agent: Runner = async (_file, args) => { argvs.push([...args]); return { code: 0, stdout: JSON.stringify({ result: "done" }), stderr: "", timedOut: false, notFound: false }; };
  const run = (argv: string[], now: Date = T0) => {
    const [command = "", ...rest] = argv;
    lines = [];
    return runOperate(command, rest, line => lines.push(line), { databaseFile: db, now, agentRunner: agent });
  };
  beforeEach(async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "so-policy-tick-")));
    repo = join(base, "repo");
    db = join(base, "queue.db");
    pool = join(base, "pool");
    await mkdir(repo, { recursive: true });
    const git = (args: string[]) => exec("git", args, { cwd: repo });
    await git(["init", "-q", "-b", "main"]);
    await git(["config", "user.email", "test@example.com"]);
    await git(["config", "user.name", "Test"]);
    await writeFile(join(repo, "README.md"), "hello\n");
    await git(["add", "."]);
    await git(["commit", "-qm", "first"]);
    argvs.length = 0;
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  test("a provider the policy stops never starts; full access above the ceiling runs lowered, and the ledger says so", async () => {
    {
      const store = openStore(db);
      register(store, { name: "builder-1", host: "test", capacity: 9, repos: [repo], now: T0, newToken: () => "tok-builder-1" });
      for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", T0);
      store.setPermissionDefault("bypassPermissions", "test", T0);
      store.close();
    }
    await run(["approver", "add", "alex", "--json"]);
    const token = payload().token as string;
    await run(["task", "add", "dedupe listings", "--id", "dedupe", "--repo", repo, "--json"]);
    await run(["task", "scope", "dedupe", "--goal", "Dedupe the listings", "--acceptance", "Duplicate listings no longer appear.|manual-review", "--json"]);
    let store = openStore(db);
    const digest = store.getScope("dedupe")!.digest;
    expect(store.getScope("dedupe")!.profile).toMatchObject({ permissionArgv: "bypassPermissions" });
    store.close();
    await run(["task", "approve", "dedupe", "--as", "alex", "--token", token, "--digest", digest, "--yes", "--json"]);
    expect(payload().ok).toBe(true);

    await run(["policy", "set", "--providers", "codex", "--as", "alex", "--token", token]);
    const tick = (now: Date) => run(["tick", "--runner", "builder-1", "--token", "tok-builder-1", "--repo", repo, "--pool", pool, "--json"], now);
    await tick(new Date(T0.getTime() + 60_000));
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "dedupe", outcome: "skipped", reason: "policy", detail: "The organisation policy doesn't allow Claude. An instance operator can change it in Settings → Policy." }));
    store = openStore(db);
    expect(store.runsFor(store.refFor("built-in", "dedupe").id)).toHaveLength(0);
    store.close();
    expect(argvs).toEqual([]);

    await run(["policy", "set", "--providers", "any", "--ceiling", "standard", "--as", "alex", "--token", token]);
    await tick(new Date(T0.getTime() + 120_000));
    const build = argvs.find(args => args.includes("-p"));
    expect(build).toBeDefined();
    expect(build).not.toContain("--dangerously-skip-permissions");
    expect(build![build!.indexOf("--permission-mode") + 1]).toBe("auto");
    store = openStore(db);
    expect(store.actionLedger({ repos: null, instance: true, limit: 50 }).find(one => one.action === "permission lowered by policy"))
      .toMatchObject({ taskId: "dedupe", outcome: "lowered", detail: "The organisation policy's permission ceiling is Standard, so this runs with auto instead of full access." });
    store.close();
  });
});
