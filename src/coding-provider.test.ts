import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodingProviderDisconnectedError, CodingProviderRequestError, CodingProviderShutdownError, createCodexCodingProvider, type CodingCustody, type CodingProvider, type CodingProviderEvent } from "./coding-provider.js";
import { effectiveContainment, overrideContainerFactoryForTests, pinContainment, resetContainmentForTests } from "./containment.js";
import * as processTree from "./process-tree.js";
import { fakePid } from "../test/fake-pid.js";

const roots: string[] = [];
const providers: CodingProvider[] = [];

/** Real pipe/process behavior, with no Codex login or model calls. */
function fixture(body = "reply(message.id, { method: message.method, params: message.params });", setup = "", initialize = "reply(message.id, { userAgent: 'fixture' });") {
  const cwd = mkdtempSync(join(tmpdir(), "so-coding-provider-"));
  roots.push(cwd);
  const log = join(cwd, "messages.jsonl");
  const marker = join(cwd, "started");
  const script = `
    import { appendFileSync, writeFileSync } from 'node:fs';
    import readline from 'node:readline';
    import { spawn } from 'node:child_process';
    writeFileSync(${JSON.stringify(marker)}, String(process.pid));
    const log = message => appendFileSync(${JSON.stringify(log)}, JSON.stringify(message) + '\\n');
    const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
    const reply = (id, result) => emit({ id, result });
    let initialized = false;
    let started = false;
    ${setup}
    const input = readline.createInterface({ input: process.stdin });
    input.on('line', line => {
      const message = JSON.parse(line); log(message);
      if (message.method === 'initialize') {
        if (started) throw Error('duplicate initialize');
        started = true;
        ${initialize}
        return;
      }
      if (message.method === 'initialized') { initialized = true; return; }
      if (!initialized) throw Error('request before handshake');
      ${body}
    });
  `;
  const provider = createCodexCodingProvider({ cwd, command: process.execPath, args: ["--input-type=module", "-e", script] });
  providers.push(provider);
  return { provider, cwd, marker, messages: (): Record<string, unknown>[] => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [] };
}

afterEach(async () => {
  await Promise.all(providers.splice(0).map(provider => provider.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  overrideContainerFactoryForTests(null);
  resetContainmentForTests();
});

describe("native coding transport", () => {
  it("publishes custody before initialize and retains it after initialization fails", async () => {
    const test = fixture("", "", "emit({ id: message.id, error: { code: -32000, message: 'Fixture initialization rejected' } });");
    const snapshots: CodingCustody[] = [];
    expect(test.provider.custody()).toMatchObject({ pid: null, group: false, descendants: [], observationUnknown: false });
    test.provider.subscribe(event => {
      if (event.kind === "custody") {
        if (snapshots.length === 0) expect(test.messages()).toEqual([]);
        snapshots.push(event.custody);
      }
    });
    await expect(test.provider.request("thread/start", {})).rejects.toMatchObject({ code: -32000, outcomeUnknown: false });
    await test.provider.close();
    const witness = test.provider.custody();
    expect(witness.pid).toBeGreaterThan(0);
    expect(witness.group).toBe(process.platform !== "win32");
    expect(witness.host).toBeTruthy();
    expect(witness).toHaveProperty("bootId");
    expect(snapshots[0]).toEqual(witness);
    expect(test.messages().map(message => message.method)).toEqual(["initialize"]);
    expect(() => process.kill(witness.pid!, 0)).toThrow();
  });

  it("keeps independent PID and process-group witnesses and returns detached custody snapshots", async () => {
    let observer: processTree.ProcessTreeObserver | undefined;
    vi.spyOn(processTree, "observeProcessTree").mockImplementation((_child, hooks) => { observer = hooks; });
    const test = fixture();
    const snapshots: CodingCustody[] = [];
    test.provider.subscribe(event => { if (event.kind === "custody") snapshots.push(event.custody); });
    await test.provider.request("read", {});
    const hooks = observer!;
    const tool = fakePid(1);
    // A tool can call setsid after it is first observed as a plain child.
    hooks.onDescendant!(tool, false);
    hooks.onDescendant!(tool, true);
    hooks.onDescendantExit!(tool, false);
    expect(test.provider.custody().descendants).toEqual([{ pid: tool, group: true }]);
    expect(snapshots[2]!.descendants).toEqual([{ pid: tool, group: false }, { pid: tool, group: true }]);
    const copy = test.provider.custody(); copy.descendants[0]!.pid = 1;
    expect(test.provider.custody().descendants[0]!.pid).toBe(tool);
    hooks.onDescendantExit!(tool, true);
    expect(test.provider.custody().descendants).toEqual([]);
    expect(snapshots.at(-1)!.descendants).toEqual([]);
    await test.provider.close();
  });

  it("emits custody changes when a real detached tool is discovered and exits", async () => {
    const test = fixture(`
      if (message.method === 'tool') {
        tool = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { detached: true, stdio: 'ignore' });
        tool.once('spawn', () => reply(message.id, { pid: tool.pid }));
      } else { tool.kill('SIGTERM'); reply(message.id, {}); }
    `, "let tool;");
    const snapshots: CodingCustody[] = [];
    test.provider.subscribe(event => { if (event.kind === "custody") snapshots.push(event.custody); });
    const { pid } = await test.provider.request("tool", {}) as { pid: number };
    try {
      await vi.waitFor(() => expect(test.provider.custody().descendants).toContainEqual({ pid, group: true }));
      const discovered = snapshots.find(one => one.descendants.some(child => child.pid === pid));
      expect(discovered).toBeDefined();
      await test.provider.request("end-tool", {});
      await vi.waitFor(() => expect(test.provider.custody().descendants).toEqual([]));
      expect(snapshots.at(-1)!.descendants).toEqual([]);
      expect(discovered!.descendants).toContainEqual({ pid, group: true });
    } finally {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  });

  it("retains a final exit diagnostic without fabricating unknown child identity", async () => {
    let observer: processTree.ProcessTreeObserver | undefined;
    vi.spyOn(processTree, "observeProcessTree").mockImplementation((_child, hooks) => { observer = hooks; });
    const test = fixture();
    const snapshots: CodingCustody[] = [];
    test.provider.subscribe(event => { if (event.kind === "custody") snapshots.push(event.custody); });
    await test.provider.request("read", {});
    const failure = { phase: "final-exit" as const, operation: "snapshot" as const, code: "EPERM", rootPid: test.provider.processId(), at: new Date().toISOString(), identityUnknown: false };
    observer!.onObservationFailure!(failure);
    expect(snapshots.at(-1)!.observationFailures).toEqual([failure]);
    const copy = test.provider.custody(); copy.observationFailures![0]!.code = "mutated";
    expect(test.provider.custody().observationFailures![0]!.code).toBe("EPERM");
    expect(test.provider.custody().observationUnknown).toBe(false);
    await test.provider.close();
  });

  it("publishes an observation failure and cannot clear that uncertainty with root exit", async () => {
    let observer: processTree.ProcessTreeObserver | undefined;
    vi.spyOn(processTree, "observeProcessTree").mockImplementation((_child, hooks) => { observer = hooks; });
    const test = fixture();
    const snapshots: CodingCustody[] = [];
    test.provider.subscribe(event => { if (event.kind === "custody") snapshots.push(event.custody); });
    await test.provider.request("read", {});
    observer!.onUnknown!();
    observer!.onUnknown!();
    expect(snapshots.filter(one => one.observationUnknown)).toHaveLength(1);
    await expect(test.provider.close()).rejects.toBeInstanceOf(CodingProviderShutdownError);
    expect(test.provider.custody().observationUnknown).toBe(true);
    expect(() => process.kill(test.provider.processId()!, 0)).toThrow();
    providers.splice(providers.indexOf(test.provider), 1);
  });

  it("retains native container provenance for read-only recovery", async () => {
    pinContainment(effectiveContainment("required", { platform: "linux", available: true, backend: "cgroup2", detail: "Injected protocol fixture" }));
    const release = vi.fn();
    overrideContainerFactoryForTests(() => ({
      backend: "cgroup2", id: "/fixture/coding-container", identity: "fixture-container-provenance",
      launch: (file, args) => ({ file, args: [...args], extraStdio: [], attach: async () => ({ ok: true }) }),
      kill: async () => true, populated: () => false, waitEmpty: async () => true, release,
    }));
    const test = fixture();
    const snapshots: CodingCustody[] = [];
    test.provider.subscribe(event => { if (event.kind === "custody") snapshots.push(event.custody); });
    await test.provider.request("read", {});
    const witness = { backend: "cgroup2", id: "/fixture/coding-container", identity: "fixture-container-provenance" };
    expect(snapshots[0]!.container).toEqual(witness);
    const copy = test.provider.custody(); copy.container!.id = "mutated-copy";
    expect(test.provider.custody().container).toEqual(witness);
    await test.provider.close();
    expect(release).toHaveBeenCalledOnce();
    expect(test.provider.custody().container).toEqual(witness);
  });

  it("starts lazily, initializes once, and routes concurrent responses by id", async () => {
    const test = fixture(`setTimeout(() => reply(message.id, { name: message.method }), message.method === 'slow' ? 30 : 0);`);
    expect(test.provider.processId()).toBeNull();
    const unsubscribe = test.provider.subscribe(() => {});
    expect(existsSync(test.marker)).toBe(false);
    expect(await Promise.all([test.provider.request("slow", {}), test.provider.request("fast", {})])).toEqual([{ name: "slow" }, { name: "fast" }]);
    const messages = test.messages();
    expect(messages.map(one => one.method)).toEqual(["initialize", "initialized", "slow", "fast"]);
    expect(messages[0]).toMatchObject({ params: { clientInfo: { name: "toolroll" }, capabilities: { experimentalApi: true } } });
    expect(test.provider.processId()).toBeGreaterThan(0);
    unsubscribe();
    const pid = test.provider.processId();
    await test.provider.close();
    expect(test.provider.processId()).toBe(pid);
    expect(() => process.kill(pid!, 0)).toThrow();
  });

  it("preserves native configuration while omitting service credentials and preload flags", async () => {
    vi.stubEnv("STANDING_ORDERS_TELEGRAM_TOKEN", "service-secret");
    vi.stubEnv("STANDING_ORDERS_COORDINATOR_TOKEN", "service-secret");
    vi.stubEnv("SLACK_BOT_TOKEN", "service-secret");
    vi.stubEnv("DISCORD_BOT_TOKEN", "service-secret");
    vi.stubEnv("NODE_OPTIONS", "--require=must-not-load");
    vi.stubEnv("CODEX_HOME", "/native/config");
    vi.stubEnv("OPENAI_API_KEY", "fixture-provider-credential");
    vi.stubEnv("ANTHROPIC_API_KEY", "fixture-custom-provider-credential");
    const { provider } = fixture(`reply(message.id, { keys: Object.keys(process.env), home: process.env.HOME, codexHome: process.env.CODEX_HOME, provider: process.env.OPENAI_API_KEY });`);
    const result = await provider.request("environment", {}) as { keys: string[]; home: string; codexHome: string; provider: string };
    expect(result.keys.some(key => key.startsWith("STANDING_ORDERS_"))).toBe(false);
    expect(result.keys).not.toContain("SLACK_BOT_TOKEN");
    expect(result.keys).not.toContain("DISCORD_BOT_TOKEN");
    expect(result.keys).not.toContain("NODE_OPTIONS");
    expect(result.keys).toContain("ANTHROPIC_API_KEY");
    expect(result.home).toBe(process.env.HOME);
    expect(result.codexHome).toBe("/native/config");
    expect(result.provider).toBe("fixture-provider-credential");
  });

  it("does not inherit an invoking desktop session's transport or identity", async () => {
    const omitted = ['CODEX_APP_TOOLS_PIPE_PATH', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_SHELL', 'CODEX_CI', 'CODEX_VERSION', 'CODEX_SAGE_BACKFILL_TRACKER_TAB_REUSE'];
    for (const key of omitted) vi.stubEnv(key, 'parent-session-fixture');
    vi.stubEnv('CODEX_HOME', '/fixture/native-home');
    vi.stubEnv('CODEX_SQLITE_HOME', '/fixture/native-state');
    vi.stubEnv('CODEX_MCP_NODE_PATH', '/fixture/native-node');
    const { provider } = fixture(`reply(message.id, { keys: Object.keys(process.env), home: process.env.CODEX_HOME, sqlite: process.env.CODEX_SQLITE_HOME, mcpNode: process.env.CODEX_MCP_NODE_PATH });`);
    const result = await provider.request('environment', {}) as { keys: string[]; home: string; sqlite: string; mcpNode: string };
    for (const key of omitted) expect(result.keys).not.toContain(key);
    expect(result).toMatchObject({ home: '/fixture/native-home', sqlite: '/fixture/native-state', mcpNode: '/fixture/native-node' });
  });

  it("delivers approvals and stream notifications without implicit consent", async () => {
    const test = fixture(`
      if (message.method === 'turn/start') {
        emit({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { command: 'git status', threadId: 't1' } });
        reply(message.id, { turn: { id: 'turn1' } });
      } else if (message.id === 'approval-1') {
        emit({ method: 'approval/received', params: message.result });
      }
    `);
    const events: CodingProviderEvent[] = [];
    test.provider.subscribe(event => events.push(event));
    await test.provider.request("turn/start", { threadId: "t1", clientUserMessageId: "message-1" });
    expect(events.find(event => event.kind === "request")).toEqual({ kind: "request", id: "approval-1", method: "item/commandExecution/requestApproval", params: { command: "git status", threadId: "t1" } });
    expect(test.messages().some(message => message.id === "approval-1")).toBe(false);
    test.provider.respond("approval-1", { decision: "decline" });
    await vi.waitFor(() => expect(events).toContainEqual({ kind: "notification", method: "approval/received", params: { decision: "decline" } }));
    expect(() => test.provider.respond("approval-1", { decision: "accept" })).toThrow("no longer waiting");
    expect(test.messages().filter(message => message.id === "approval-1")).toEqual([{ id: "approval-1", result: { decision: "decline" } }]);
  });

  it("rejects a server request when there is no client to handle it", async () => {
    const test = fixture(`
      if (message.method === 'ask') { emit({ id: 91, method: 'unknown/approval', params: {} }); reply(message.id, {}); }
    `);
    await test.provider.request("ask", {});
    await vi.waitFor(() => expect(test.messages().some(message => message.id === 91)).toBe(true));
    expect(test.messages().find(message => message.id === 91)).toMatchObject({ error: { code: -32601 } });
  });

  it("rejects an unsupported interaction with a protocol error and withdraws resolved approvals", async () => {
    const test = fixture(`
      if (message.method === 'ask') { emit({ id: 'unsupported', method: 'unknown/interaction', params: {} }); reply(message.id, {}); }
      if (message.method === 'resolve') {
        emit({ id: 'stale', method: 'item/fileChange/requestApproval', params: { threadId: 't1' } });
        emit({ method: 'serverRequest/resolved', params: { threadId: 't1', requestId: 'stale' } });
        reply(message.id, {});
      }
    `);
    test.provider.subscribe(() => {});
    await test.provider.request("ask", {});
    test.provider.reject("unsupported", -32601, "This interaction is not supported.");
    await test.provider.request("resolve", {});
    expect(test.messages().find(message => message.id === "unsupported")).toEqual({ id: "unsupported", error: { code: -32601, message: "This interaction is not supported." } });
    expect(() => test.provider.respond("stale", { decision: "accept" })).toThrow("no longer waiting");
    expect(() => test.provider.reject("stale", -32601, "Unavailable")).toThrow("no longer waiting");
    expect(test.messages().some(message => message.id === "stale")).toBe(false);
  });

  it("bounds unanswered requests without granting approvals", async () => {
    const test = fixture(`
      for (let i = 0; i < 129; i++) emit({ id: 'approval-' + i, method: 'item/fileChange/requestApproval', params: { threadId: 't1' } });
    `);
    test.provider.subscribe(() => {});
    await expect(test.provider.request("ask", {})).rejects.toThrow("too many unanswered requests");
    await test.provider.close();
    expect(test.messages().some(message => typeof message.id === "string")).toBe(false);
  });

  it("preserves explicit server errors and permits the next independent request", async () => {
    const { provider } = fixture(`
      if (message.method === 'bad') emit({ id: message.id, error: { code: -32602, message: 'Unknown thread', data: { threadId: 'missing' } } });
      else reply(message.id, { ok: true });
    `);
    const error = await provider.request("bad", {}).catch(error => error);
    expect(error).toBeInstanceOf(CodingProviderRequestError);
    expect(error).toMatchObject({ code: -32602, message: "Unknown thread", data: { threadId: "missing" }, outcomeUnknown: false });
    expect(await provider.request("next", {})).toEqual({ ok: true });
  });

  it("rejects all pending requests as uncertain on disconnect and never retries a mutation", async () => {
    const test = fixture(`setTimeout(() => process.exit(3), 25);`);
    const events: CodingProviderEvent[] = [];
    test.provider.subscribe(event => events.push(event));
    const results = await Promise.allSettled([test.provider.request("turn/start", {}), test.provider.request("thread/read", {})]);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason).toMatchObject({ outcomeUnknown: true });
    }
    await expect(test.provider.request("turn/start", {})).rejects.toBeInstanceOf(CodingProviderDisconnectedError);
    await test.provider.close();
    expect(test.messages().filter(message => message.method === "turn/start")).toHaveLength(1);
    expect(events.filter(event => event.kind === "exit")).toHaveLength(1);
  });

  it("joins split UTF-8 frames and handles multiple messages in one frame buffer", async () => {
    const { provider } = fixture(`
      const buffer = Buffer.from(JSON.stringify({ id: message.id, result: { text: 'café 🏡' } }) + '\\n');
      const split = buffer.indexOf(Buffer.from('🏡')) + 2;
      process.stdout.write(buffer.subarray(0, split));
      setTimeout(() => process.stdout.write(Buffer.concat([buffer.subarray(split), Buffer.from(JSON.stringify({ method: 'done', params: {} }) + '\\n')])), 10);
    `);
    const events: CodingProviderEvent[] = [];
    provider.subscribe(event => events.push(event));
    expect(await provider.request("read", {})).toEqual({ text: "café 🏡" });
    expect(events).toContainEqual({ kind: "notification", method: "done", params: {} });
  });

  it.each([
    ["invalid JSON", "process.stdout.write('{invalid\\n');"],
    ["invalid UTF-8", "process.stdout.write(Buffer.from([123, 255, 125, 10]));"],
    ["response with both result and error", "emit({ id: message.id, result: {}, error: { code: 1, message: 'bad' } });"],
    ["unmatched response", "reply('unknown', {});"],
    ["invalid parameters", "emit({ method: 'event', params: [] });"],
    ["truncated frame", "process.stdout.write('{\\\"id\\\":'); process.stdout.end();"],
    ["oversized unfinished frame", "process.stdout.write('x'.repeat(16 * 1024 * 1024 + 1));"],
  ])("fails loudly for %s without exposing protocol content", async (_label, body) => {
    const { provider } = fixture(body);
    const error = await provider.request("turn/start", {}).catch(error => error);
    expect(error).toBeInstanceOf(CodingProviderDisconnectedError);
    expect(error.message).not.toContain("{invalid");
    await provider.close();
  });

  it("does not leak stderr into lifecycle errors", async () => {
    const { provider } = fixture("process.stderr.write('PRIVATE_BOT_TOKEN=secret'); process.exit(2);");
    await expect(provider.request("read", {})).rejects.not.toThrow("PRIVATE_BOT_TOKEN");
  });

  it("disconnects on consumer failure instead of silently dropping an approval", async () => {
    const { provider } = fixture("emit({ id: 'a1', method: 'approval', params: {} });");
    provider.subscribe(event => { if (event.kind === "request") throw Error("storage unavailable"); });
    await expect(provider.request("turn/start", {})).rejects.toThrow("could not be recorded");
    await provider.close();
  });

  it("never spawns after closing a lazy provider", async () => {
    const test = fixture();
    await test.provider.close();
    await expect(test.provider.request("read", {})).rejects.toBeInstanceOf(CodingProviderDisconnectedError);
    expect(existsSync(test.marker)).toBe(false);
  });

  it("reports missing executable and waits for its spawn handle to close", async () => {
    const provider = createCodexCodingProvider({ command: "/does-not-exist/codex" });
    providers.push(provider);
    await expect(provider.request("read", {})).rejects.toThrow("could not start");
    await provider.close();
    expect(provider.processId()).toBeNull();
  });

  it("closes stdin, escalates only at shutdown, and verifies process exit", async () => {
    const test = fixture("reply(message.id, {});", "setInterval(() => {}, 1000); process.on('SIGTERM', () => {});");
    await test.provider.request("read", {});
    const pid = test.provider.processId()!;
    const first = test.provider.close();
    expect(test.provider.close()).toBe(first);
    await first;
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("stops a still-owned process tree including a tool in its own process group", async () => {
    const test = fixture(`
      const tool = spawn(process.execPath, ['-e', "setInterval(() => {}, 1000); process.on('SIGTERM', () => {});"], { detached: true, stdio: 'ignore' });
      tool.once('spawn', () => reply(message.id, { toolPid: tool.pid }));
    `, "setInterval(() => {}, 1000); process.on('SIGTERM', () => {});");
    const { toolPid } = await test.provider.request("tool", {}) as { toolPid: number };
    try {
      await test.provider.close();
      expect(() => process.kill(toolPid, 0)).toThrow();
    } finally {
      try { process.kill(toolPid, "SIGKILL"); } catch {}
    }
  });

  it("keeps custody fenced when an observed tool outlives a gracefully exited root", async () => {
    const test = fixture(`
      const tool = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { detached: true, stdio: 'ignore' });
      tool.unref();
      tool.once('spawn', () => reply(message.id, { toolPid: tool.pid }));
    `);
    const { toolPid } = await test.provider.request("tool", {}) as { toolPid: number };
    try {
      await expect(test.provider.close()).rejects.toBeInstanceOf(CodingProviderShutdownError);
      expect(() => process.kill(test.provider.processId()!, 0)).toThrow();
      expect(() => process.kill(toolPid, 0)).not.toThrow();
    } finally {
      // Test-owned fixture cleanup; production cannot signal historical PIDs.
      try { process.kill(toolPid, "SIGKILL"); } catch {}
      providers.splice(providers.indexOf(test.provider), 1);
      await vi.waitFor(() => expect(() => process.kill(toolPid, 0)).toThrow());
    }
  });

  it("honors a required containment refusal before spawning", async () => {
    pinContainment(effectiveContainment("required", { platform: "darwin", available: false, backend: null, detail: "fixture unavailable" }));
    const test = fixture();
    await expect(test.provider.request("read", {})).rejects.toThrow("native process containment is required");
    expect(existsSync(test.marker)).toBe(false);
  });
});
