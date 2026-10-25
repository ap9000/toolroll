/**
 * Attack: a project tool's server started outside a build — discovery and its Test button, a flow's "Use a tool"
 * step, a subagent's call — reading Toolroll's state (docs/plans/sandbox-parity.md C2). Those spawns went straight to
 * child_process with no fence. Now each starts inside the server fence (project-tools.ts toolServerFor), required;
 * where nothing can confine it, it doesn't start. And a Codex launch file naming a local program is refused by the
 * launcher, which Codex starts outside its own sandbox: local servers run only in the broker.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { useTool } from "../../src/flow-actions.js";
import { flowFromSteps } from "../../src/flows.js";
import { addToolTo, testToolOf, validateToolSpec } from "../../src/project-tools.js";
import { addApprover } from "../../src/scope.js";
import { openStore, type Store } from "../../src/store.js";
import { marker, needs, osFence, useScratch, write } from "./harness.js";

const T0 = new Date("2026-10-24T09:00:00.000Z");
const scratch = useScratch("tool-server");

/** An MCP server whose tool list says whether it could read the file in PROBE_FILE: `read` or `denied`. */
const PROBE_SERVER = `import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
const peek = () => { try { readFileSync(process.argv[2]); return "read"; } catch { return "denied"; } };
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") reply(message.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "probe", version: "1" } });
  else if (message.method === "tools/list") reply(message.id, { tools: [{ name: peek(), inputSchema: { type: "object" } }] });
  else if (message.method === "tools/call") reply(message.id, { content: [{ type: "text", text: peek() }] });
});
`;

let root: string, repo: string, home: string, store: Store, canary: string;
beforeEach(() => {
  root = scratch();
  repo = join(root, "shop");
  home = join(root, "home");
  mkdirSync(repo, { recursive: true });
  mkdirSync(home, { recursive: true });
  // Toolroll's own state folder, fenced whole, with the approver's remembered login in it.
  store = openStore(join(root, "toolroll", "orders.db"));
  canary = write(join(root, "toolroll", "up-login.txt"), marker("tool-server"));
  if (!addApprover(store, "alex", T0).ok) throw new Error("bootstrap");
  const server = write(join(root, "servers", "probe.mjs"), PROBE_SERVER);
  const added = addToolTo(store, repo, validateToolSpec({ name: "probe", command: process.execPath, args: [server, canary], secrets: [], about: "Probes" }), "test", "alex", T0, { home });
  if (!added.ok) throw new Error(added.message);
});

describe("attack: a tool server outside a build reading Toolroll's state", () => {
  test("discovery (the Test button) starts it in the server fence: the state is unreadable to it, readable without it", async ctx => {
    needs(ctx, osFence());
    const fenced = await testToolOf(store, repo, "probe", T0, { home });
    expect(fenced).toMatchObject({ ok: true, tools: ["denied"] });
    // Positive control: the same server, where an operator allowed unconfined agents and nothing can fence, reads it.
    store.setUnfencedAgentsAllowed(true, "alex", T0);
    expect(await testToolOf(store, repo, "probe", T0, { home, available: () => false })).toMatchObject({ ok: true, tools: ["read"] });
  });

  test("a flow's tool step is fenced the same way, and refused where nothing can confine it", async ctx => {
    const flow = store.createFlow({ repo, name: "Post", by: "alex", definitionJson: JSON.stringify(flowFromSteps([{ title: "Inbox", kind: "inbox" }, { id: "use", title: "Use", kind: "tool", server: "probe", tool: "peek", args: {} }], null)) }, T0);
    const stage = JSON.parse(store.getFlow(flow)!.definitionJson).stages.find((one: { id: string }) => one.id === "use");
    const card = store.getFlowCard(store.addFlowCard({ flow, title: "Probe", description: null, stage: "use", by: "alex", byKind: "person" }, T0))!;
    const refused = await useTool(store, stage, card, repo, { toolHome: home, fenceAvailable: () => false });
    expect(refused).toMatchObject({ state: "retry" });
    expect(refused.said).toMatch(/can't confine the tool's server/);
    needs(ctx, osFence());
    expect(await useTool(store, stage, card, repo, { toolHome: home })).toMatchObject({ state: "passed", output: "denied" });
  });

  test("where nothing can confine it and an operator allowed unconfined agents (as inside the plane's check), the tool step and discovery start it", async () => {
    const flow = store.createFlow({ repo, name: "Post", by: "alex", definitionJson: JSON.stringify(flowFromSteps([{ title: "Inbox", kind: "inbox" }, { id: "use", title: "Use", kind: "tool", server: "probe", tool: "peek", args: {} }], null)) }, T0);
    const stage = JSON.parse(store.getFlow(flow)!.definitionJson).stages.find((one: { id: string }) => one.id === "use");
    const card = store.getFlowCard(store.addFlowCard({ flow, title: "Probe", description: null, stage: "use", by: "alex", byKind: "person" }, T0))!;
    // Refused until someone allows it; then it runs, with nothing confining it (it reads the state).
    expect((await useTool(store, stage, card, repo, { toolHome: home, fenceAvailable: () => false })).said).toMatch(/can't confine the tool's server/);
    store.setUnfencedAgentsAllowed(true, "alex", T0);
    expect(await useTool(store, stage, card, repo, { toolHome: home, fenceAvailable: () => false })).toMatchObject({ state: "passed", output: "read" });
    expect(await testToolOf(store, repo, "probe", T0, { home, available: () => false })).toMatchObject({ ok: true, tools: ["read"] });
  });

  test("a Codex launch file naming a local program is refused by the launcher; nothing starts", () => {
    const ran = write(join(root, "ran.txt"), "");
    const file = write(join(root, "launch.json"), JSON.stringify({ spec: { name: "local", transport: "stdio", command: "/bin/sh", args: ["-c", `echo started > ${JSON.stringify(ran)}`], url: null, secrets: [], bearer: null, headerSecrets: {}, about: "" }, values: {} }));
    const launcher = resolve(import.meta.dirname, "../../src/tool-launcher.ts");
    const result = spawnSync(resolve(import.meta.dirname, "../../node_modules/.bin/tsx"), [launcher, file], { encoding: "utf8", timeout: 30_000 });
    expect(result.status).toBe(126);
    expect(result.stderr).toMatch(/only Toolroll's tool broker may start/);
    expect(spawnSync("cat", [ran], { encoding: "utf8" }).stdout).toBe("");
  });
});
