import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { copyFileSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { mintCoordinator, fileCoordinatorProposal, revokeCoordinator } from "./coordinator.js";
import { serveMcp, MODERN, LEGACY, type McpIo } from "./mcp.js";
import { runAssignmentCommand } from "./assignment-adapters.js";
import { register } from "./runner.js";
import { acquire } from "./claim.js";
import { PACKAGE_VERSION } from "./version.js";

/** A task with no scope presents the bare word `legacy` for the exact pair
 * it spends as (atomic authority closure): nothing opens unstamped. */
const bareLegacy = (phase: "build" | "plan" | "repair" | "review", provider: string = "claude", model: string | null = null) => ({
  route: { routeDigest: "legacy", phase, provider, model, chosen: "legacy" as const },
});

const T0 = new Date("2026-08-30T12:00:00.000Z");
const REPO = "/repo/mcp-server";

/** A wired loopback: push lines in, collect protocol lines out. */
function harness(store: Store, token: string): {
  send: (message: unknown) => void;
  sendRaw: (line: string) => void;
  out: () => Record<string, unknown>[];
  last: () => Record<string, unknown>;
  /** The raw protocol line, byte-for-byte as the server wrote it. */
  lastRaw: () => string;
  exitCode: () => number | null;
  outcome: ReturnType<typeof serveMcp>;
} {
  const lines: string[] = [];
  let lineHandler: (line: string) => void = () => {};
  let exited: number | null = null;
  const io: McpIo = {
    onLine: handler => { lineHandler = handler; },
    onEof: () => {},
    write: line => lines.push(line),
    log: () => {},
    exit: code => { exited = code; },
  };
  // The registry fail-closed rule means tests declare enrollment: every
  // repo a fixture files into is enrolled here.
  const outcome = serveMcp(store, token, io, () => T0, [REPO, "/repo/other"]);
  return {
    send: message => lineHandler(JSON.stringify(message)),
    sendRaw: line => lineHandler(line),
    out: () => lines.map(one => JSON.parse(one) as Record<string, unknown>),
    last: () => JSON.parse(lines[lines.length - 1] ?? "{}") as Record<string, unknown>,
    lastRaw: () => lines[lines.length - 1] ?? "",
    exitCode: () => exited,
    outcome,
  };
}

const modernMeta = { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientCapabilities": {} };

describe("the MCP stdio server", () => {
  let store: Store;
  let token: string;

  beforeEach(() => {
    store = openStore(":memory:");
    const made = mintCoordinator(store, { name: "planner-bot", repos: [REPO], by: "alex", now: T0 });
    if (!made.ok) throw new Error("mint failed");
    token = made.token;
  });
  afterEach(() => store.close());

  test("startup dies on an unknown or revoked credential — never a read-only fallback", () => {
    const bad = harness(store, "not-a-token");
    expect(bad.outcome).toMatchObject({ ok: false, reason: "unauthenticated" });
  });

  test("legacy era: initialize negotiates ITSELF (never the modern era), initialized is silent, ping answers", () => {
    const h = harness(store, token);
    h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2019-01-01" } });
    const init = h.last();
    expect((init["result"] as Record<string, unknown>)["protocolVersion"]).toBe(LEGACY);
    expect((init["result"] as Record<string, unknown>)["resultType"]).toBeUndefined();
    h.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(h.out()).toHaveLength(1); // a notification gets NO reply
    h.send({ jsonrpc: "2.0", id: 2, method: "ping" });
    expect(h.last()["id"]).toBe(2);
  });

  test("modern era: discover and tools/list are schema-complete, metadata is namespaced, versions negotiate by the book", () => {
    const h = harness(store, token);
    // A modern request carries BOTH namespaced keys — a bare discover is
    // not a modern request (round-2 finding 1).
    h.send({ jsonrpc: "2.0", id: 0, method: "server/discover", params: {} });
    expect(h.last()["error"]).toMatchObject({ code: -32600 });
    h.send({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: modernMeta } });
    const discover = h.last()["result"] as Record<string, unknown>;
    expect(discover["protocolVersion"]).toBe(MODERN);
    expect(discover["supportedVersions"]).toEqual([MODERN, LEGACY]);
    expect(discover["resultType"]).toBe("complete");
    expect(discover["ttlMs"]).toBe(0);
    expect(discover["cacheScope"]).toBe("private");
    expect((discover["_meta"] as Record<string, unknown>)["io.modelcontextprotocol/serverInfo"]).toMatchObject({ name: "toolroll" });
    h.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: modernMeta } });
    const listed = h.last()["result"] as Record<string, unknown>;
    expect(listed["resultType"]).toBe("complete");
    expect((listed["tools"] as { outputSchema?: unknown }[]).length).toBe(25);
    // No outputSchema: it describes structuredContent, which these tools
    // do not return (round-2 finding 1).
    expect((listed["tools"] as { outputSchema?: unknown }[])[0]?.outputSchema).toBeUndefined();
    // The revision's OWN refusal shape for an unsupported version…
    h.send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2030-01-01" } } });
    expect(h.last()["error"]).toMatchObject({ code: -32022, data: { supported: [MODERN, LEGACY], requested: "2030-01-01" } });
    // …and ping left the protocol in 2026-07-28.
    h.send({ jsonrpc: "2.0", id: 4, method: "ping", params: { _meta: modernMeta } });
    expect(h.last()["error"]).toMatchObject({ code: -32601 });
  });

  test("stdio pins ONE era per connection: after a modern call, handshake-era traffic refuses — and the other way round", () => {
    const modern = harness(store, token);
    modern.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: modernMeta } });
    expect((modern.last()["result"] as Record<string, unknown>)["resultType"]).toBe("complete");
    modern.send({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: LEGACY } });
    expect(modern.last()["error"]).toMatchObject({ code: -32600 });

    const legacy = harness(store, token);
    legacy.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: LEGACY } });
    legacy.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    legacy.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect((legacy.last()["result"] as Record<string, unknown>)["tools"]).toBeDefined();
    legacy.send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: { _meta: modernMeta } });
    expect(legacy.last()["error"]).toMatchObject({ code: -32600 });
  });

  test("the pin covers EVERY era-classified method: a refused modern ping pins, and unknown methods cannot cross the pin", () => {
    // Round-3 finding 1: a first modern ping used to leave the connection
    // unpinned, letting legacy initialize follow; unknown cross-era methods
    // slipped past the pin check entirely.
    const h = harness(store, token);
    h.send({ jsonrpc: "2.0", id: 1, method: "ping", params: { _meta: modernMeta } });
    expect(h.last()["error"]).toMatchObject({ code: -32601 }); // ping left the modern revision…
    h.send({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: LEGACY } });
    expect(h.last()["error"]).toMatchObject({ code: -32600 }); // …but it PINNED the era.
    h.send({ jsonrpc: "2.0", id: 3, method: "no/such", params: {} });
    expect(String((h.last()["error"] as Record<string, unknown>)["message"])).toContain("pinned");

    const legacy = harness(store, token);
    legacy.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: LEGACY } });
    legacy.send({ jsonrpc: "2.0", id: 2, method: "no/such", params: { _meta: modernMeta } });
    expect(String((legacy.last()["error"] as Record<string, unknown>)["message"])).toContain("pinned");
  });

  test("explicit `arguments: null` refuses — only an ABSENT arguments defaults to empty", () => {
    // Round-3 finding 2: `?? {}` used to bless null into an empty object.
    const h = harness(store, token);
    h.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { _meta: modernMeta, name: "list_repos", arguments: null } });
    expect(h.last()["error"]).toMatchObject({ code: -32602 });
    h.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { _meta: modernMeta, name: "list_repos" } });
    expect(h.last()["result"]).toBeDefined();
  });

  test("a notification is the message with NO id — the method prefix never decides", () => {
    // Round-3 finding 3: notifications/initialized carrying an id used to
    // bypass id validation and complete the handshake silently.
    const h = harness(store, token);
    h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: LEGACY } });
    h.send({ jsonrpc: "2.0", id: 2, method: "notifications/initialized" });
    expect(String((h.last()["error"] as Record<string, unknown>)["message"])).toContain("notification carries no id");
    h.send({ jsonrpc: "2.0", id: 1.5, method: "notifications/initialized" });
    expect(h.last()["error"]).toMatchObject({ code: -32600 }); // a float id is no id shape at all
    h.send({ jsonrpc: "2.0", id: null, method: "tools/list", params: {} });
    expect(h.last()["error"]).toMatchObject({ code: -32600 }); // null id: neither request nor notification
    // The mis-idented notifications above completed NOTHING: tools still
    // refuse until a true no-id initialized arrives.
    h.send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
    expect(h.last()["error"]).toMatchObject({ code: -32002 });
    h.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    h.send({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} });
    expect(h.last()["result"]).toBeDefined();
  });

  test("an unsupported version on server/discover answers -32022 with {supported, requested} — never -32600", () => {
    // Round-3 finding 4: the discover branch used to answer its own -32600
    // before the unsupported-version refusal could speak.
    const h = harness(store, token);
    h.send({
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2030-01-01", "io.modelcontextprotocol/clientCapabilities": {} } },
    });
    expect(h.last()["error"]).toMatchObject({ code: -32022, data: { supported: [MODERN, LEGACY], requested: "2030-01-01" } });
  });

  test("clientCapabilities must be an OBJECT shape — an array refuses on every modern method", () => {
    // Round-3 finding 5: `typeof [] === "object"` used to pass the check.
    const arrayMeta = { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientCapabilities": [] };
    const h = harness(store, token);
    h.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: arrayMeta } });
    expect(h.last()["error"]).toMatchObject({ code: -32600 });
    h.send({ jsonrpc: "2.0", id: 2, method: "server/discover", params: { _meta: arrayMeta } });
    expect(h.last()["error"]).toMatchObject({ code: -32600 });
  });

  test("initialized without initialize completes nothing, and a bare arguments root refuses", () => {
    const h = harness(store, token);
    h.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    h.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(h.last()["error"]).toMatchObject({ code: -32002 });
    // A fresh connection: the refused legacy call above already PINNED
    // that connection's era, which is itself the contract.
    const h2 = harness(store, token);
    h2.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { _meta: modernMeta, name: "list_repos", arguments: 42 } });
    expect(h2.last()["error"]).toMatchObject({ code: -32602 });
  });

  test("the engine validates: bad jsonrpc, bad id shapes, unknown arguments, and unknown notifications", () => {
    const h = harness(store, token);
    h.send({ jsonrpc: "1.0", id: 1, method: "ping" });
    expect(h.last()["error"]).toMatchObject({ code: -32600 });
    h.send({ jsonrpc: "2.0", id: { object: true }, method: "ping" });
    expect(h.last()["error"]).toMatchObject({ code: -32600 });
    h.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { _meta: modernMeta, name: "list_repos", arguments: { bogus: 1 } } });
    expect(h.last()["error"]).toMatchObject({ code: -32602 });
    const before = h.out().length;
    h.send({ jsonrpc: "2.0", method: "notifications/whatever" });
    expect(h.out().length).toBe(before); // silence, never an error
  });

  test("the handshake era refuses tools before its lifecycle completes", () => {
    const h = harness(store, token);
    h.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(h.last()["error"]).toMatchObject({ code: -32002 });
    h.send({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: LEGACY } });
    h.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    h.send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
    expect((h.last()["result"] as Record<string, unknown>)["tools"]).toBeDefined();
  });

  test("malformed input answers in-protocol and never crashes: parse error, batch, depth, oversize, unknown method", () => {
    const h = harness(store, token);
    h.sendRaw("{not json");
    expect(h.last()["error"]).toMatchObject({ code: -32700 });
    h.send([{ jsonrpc: "2.0", id: 1, method: "ping" }]);
    expect(String((h.last()["error"] as Record<string, unknown>)["message"])).toContain("batching");
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) deep = { inner: deep };
    h.send({ jsonrpc: "2.0", id: 2, method: "ping", params: deep });
    expect(h.last()["error"]).toMatchObject({ code: -32600 });
    h.sendRaw(`{"jsonrpc":"2.0","id":3,"method":"ping","params":{"pad":"${"x".repeat(300 * 1024)}"}}`);
    expect(String((h.last()["error"] as Record<string, unknown>)["message"])).toContain("256");
    h.send({ jsonrpc: "2.0", id: 4, method: "no/such" });
    expect(h.last()["error"]).toMatchObject({ code: -32601 });
  });

  test("cancellation touches in-flight work only: no ack ever, and a pre-cancelled future id is NOT suppressed", () => {
    const h = harness(store, token);
    h.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 9 } });
    expect(h.out()).toHaveLength(0); // a notification gets no reply
    // The id was never in flight — cancelling it must not blacklist the
    // future (review finding 2: one peer must not suppress another's ids).
    h.send({ jsonrpc: "2.0", id: 9, method: "tools/list", params: { _meta: modernMeta } });
    expect(h.out()).toHaveLength(1);
  });

  test("a wide request below the byte limit cannot exhaust the depth checker's argument stack", () => {
    const h = harness(store, token);
    const line = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "no/such", params: { pad: Array(125_000).fill(0) } });
    expect(Buffer.byteLength(line, "utf8")).toBeLessThan(256 * 1024);
    expect(() => h.sendRaw(line)).not.toThrow();
    expect(h.last()["error"]).toMatchObject({ code: -32601 });
    h.send({ jsonrpc: "2.0", id: 2, method: "ping" });
    expect(h.last()).toMatchObject({ id: 2, result: {} });
    expect(h.exitCode()).toBeNull();
  });

  test("file_proposal files through the door; the task is quarantined; a tool refusal is isError, not a protocol error", () => {
    const h = harness(store, token);
    h.send({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { _meta: modernMeta, name: "file_proposal", arguments: { repo: REPO, title: "Fix the flaky test", idempotency_key: "key-mcp-0001" } },
    });
    const result = h.last()["result"] as Record<string, unknown>;
    expect(result["isError"]).toBeUndefined();
    const body = JSON.parse(String((result["content"] as { text: string }[])[0]?.text)) as Record<string, unknown>;
    expect(body["replayed"]).toBe(false);
    expect(store.refFor("built-in", String(body["ref"])).coordinatorCid).not.toBeNull();

    // Outside the allowlist: a refusal in words, still a RESULT.
    h.send({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { _meta: modernMeta, name: "file_proposal", arguments: { repo: "/foreign", title: "nope", idempotency_key: "key-mcp-0002" } },
    });
    const refused = h.last()["result"] as Record<string, unknown>;
    expect(refused["isError"]).toBe(true);
    expect(h.last()["error"]).toBeUndefined();
  });

  test("file_proposal with deliverable 'report' files a scout task; get_task says so (v34)", () => {
    const h = harness(store, token);
    h.send({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { _meta: modernMeta, name: "file_proposal", arguments: { repo: REPO, title: "Why is login flaky?", intent: "Find out", idempotency_key: "key-scout-0001", deliverable: "report" } },
    });
    const body = JSON.parse(String(((h.last()["result"] as Record<string, unknown>)["content"] as { text: string }[])[0]?.text)) as Record<string, unknown>;
    expect(store.refFor("built-in", String(body["ref"])).deliverable).toBe("report");
    h.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { _meta: modernMeta, name: "get_task", arguments: { ref: String(body["ref"]) } } });
    const detail = JSON.parse(String(((h.last()["result"] as Record<string, unknown>)["content"] as { text: string }[])[0]?.text)) as Record<string, unknown>;
    expect(detail["deliverable"]).toBe("report");
    expect(detail["report"]).toBeNull();
    expect(detail["work"]).toMatchObject({ taskId: body["ref"], primaryAction: { code: "select-agent", access: "operator-handoff", retry: "refresh-before-acting" } });
    // An unknown deliverable is a protocol error (the schema is the parser).
    h.send({
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { _meta: modernMeta, name: "file_proposal", arguments: { repo: REPO, title: "x", idempotency_key: "key-scout-0002", deliverable: "essay" } },
    });
    expect(h.last()["error"]).toBeDefined();
  });

  test("reads are allowlist-scoped: a foreign task answers not-found; status counts only this credential's repos", () => {
    // A task in a repo OUTSIDE the allowlist, via a second coordinator.
    const other = mintCoordinator(store, { name: "other-bot", repos: ["/repo/other"], by: "alex", now: T0 });
    if (!other.ok) throw new Error("mint failed");
    const foreign = fileCoordinatorProposal(store, other.token, { repo: "/repo/other", title: "foreign", idempotencyKey: "key-for-0001" }, T0);
    if (!foreign.ok) throw new Error("filing failed");

    const h = harness(store, token);
    h.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { _meta: modernMeta, name: "get_task", arguments: { ref: foreign.id } } });
    const answer = h.last()["result"] as Record<string, unknown>;
    expect(answer["isError"]).toBe(true);
    expect(String((answer["content"] as { text: string }[])[0]?.text)).toContain("not-found");

    h.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { _meta: modernMeta, name: "status", arguments: {} } });
    const status = JSON.parse(String(((h.last()["result"] as Record<string, unknown>)["content"] as { text: string }[])[0]?.text)) as Record<string, unknown>;
    expect((status["repos"] as unknown[]).length).toBe(0); // nothing filed in OUR repo yet
  });

  test("repository context checks project scope before source access and missing indexing does not block", () => {
    const h = harness(store, token);
    const call = (repo: string) => h.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { _meta: modernMeta, name: "get_project_context", arguments: { repo, query: "export" } } });
    call("/repo/private");
    const denied = h.last()["result"] as { isError?: boolean; content: { text: string }[] };
    expect(denied.isError).toBe(true);
    expect(denied.content[0]?.text).toContain("outside your access");
    call(REPO);
    const allowed = h.last()["result"] as { isError?: boolean; content: { text: string }[] };
    expect(allowed.isError).toBeUndefined();
    expect(JSON.parse(allowed.content[0]!.text)).toMatchObject({ index: { status: "unavailable" }, excerpts: [] });
  });

  test("revocation mid-session: the next call refuses and the server exits — tools/list visibility was never authorization", () => {
    const h = harness(store, token);
    h.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { _meta: modernMeta, name: "list_repos", arguments: {} } });
    expect((h.last()["result"] as Record<string, unknown>)["isError"]).toBeUndefined();
    const rows = store.handle.prepare("SELECT cid FROM coordinator_credential").all();
    revokeCoordinator(store, String(rows[0]?.["cid"]), "alex", T0);
    h.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { _meta: modernMeta, name: "list_repos", arguments: {} } });
    expect(h.last()["error"]).toMatchObject({ code: -32000 });
    expect(h.exitCode()).toBe(0);
  });

  test("e2e: file through the gateway, seal with the password, dispatch ordinarily, status reflects", () => {
    const h = harness(store, token);
    h.send({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { _meta: modernMeta, name: "file_proposal", arguments: { repo: REPO, title: "e2e work", idempotency_key: "key-e2e-0001" } },
    });
    const body = JSON.parse(String(((h.last()["result"] as Record<string, unknown>)["content"] as { text: string }[])[0]?.text)) as Record<string, unknown>;
    const taskId = String(body["ref"]);
    const taskRef = store.refFor("built-in", taskId).id;
    register(store, { name: "b-1", host: "test", capacity: 9, repos: [REPO], now: T0, newToken: () => "tok-b-1" });

    // Quarantined until the password seal — then ordinary.
    expect(acquire(store, taskRef, "b-1", { now: T0, token: "tok-b-1" })).toMatchObject({ ok: false, reason: "coordinator-filed" });
    // v47: a routed scope seals only when every phase names an exact agent.
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T0);
    store.saveScope({
      taskId, goal: "e2e work", outOfScope: null, touches: [], acceptance: [],
      proposedAt: T0.toISOString(), digest: `dg-${taskId}`,
      approvedAt: null, approvedBy: null, approvedDigest: null,
    });
    expect(store.sealScopeApproval(taskId, "alex", T0)).toBe(true);
    expect(acquire(store, taskRef, "b-1", { now: T0, token: "tok-b-1" })).toMatchObject({ ok: true });

    // The gateway's own view reflects it: the task is visible in OUR
    // repo, sealed and claimed (the raw claim primitive leaves the state
    // transition to its callers, so no state filter here).
    h.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { _meta: modernMeta, name: "list_tasks", arguments: {} } });
    const listed = JSON.parse(String(((h.last()["result"] as Record<string, unknown>)["content"] as { text: string }[])[0]?.text)) as Record<string, unknown>;
    expect((listed["tasks"] as { ref: string }[]).map(one => one.ref)).toEqual([taskId]);
    h.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { _meta: modernMeta, name: "get_task", arguments: { ref: taskId } } });
    const detail = JSON.parse(String(((h.last()["result"] as Record<string, unknown>)["content"] as { text: string }[])[0]?.text)) as Record<string, unknown>;
    expect((detail["scope"] as Record<string, unknown>)["sealed"]).toBe(true);
  });

  test("two concurrent servers on one store never cross credentials: each session's filing stamps ITS OWN cid", () => {
    // The review found a global-variable bug here once: one process, two
    // serveMcp instances, and the second server's token clobbered the
    // first's. The fix threads the token per-server — prove it holds by
    // interleaving filings across two live sessions.
    const other = mintCoordinator(store, { name: "other-bot", repos: ["/repo/isolated"], by: "alex", now: T0 });
    if (!other.ok) throw new Error("mint failed");
    const mine = store.handle.prepare("SELECT cid FROM coordinator_credential WHERE name = 'planner-bot'").get();
    const myCid = String(mine?.["cid"]);

    const h1 = harness(store, token);
    const h2 = harness(store, other.token); // the SECOND server starts before the first files
    const fileVia = (h: ReturnType<typeof harness>, repo: string, key: string): string => {
      h.send({
        jsonrpc: "2.0", id: key, method: "tools/call",
        params: { _meta: modernMeta, name: "file_proposal", arguments: { repo, title: `work ${key}`, idempotency_key: key } },
      });
      const result = h.last()["result"] as Record<string, unknown>;
      expect(result["isError"]).toBeUndefined();
      return String(JSON.parse(String((result["content"] as { text: string }[])[0]?.text))["ref"]);
    };

    const viaSecond = fileVia(h2, "/repo/isolated", "key-iso-0001");
    const viaFirst = fileVia(h1, REPO, "key-iso-0002"); // filed AFTER h2 exists — the clobber would stamp other-bot's cid
    const viaSecondAgain = fileVia(h2, "/repo/isolated", "key-iso-0003");

    expect(store.refFor("built-in", viaFirst).coordinatorCid).toBe(myCid);
    expect(store.refFor("built-in", viaSecond).coordinatorCid).toBe(other.cid);
    expect(store.refFor("built-in", viaSecondAgain).coordinatorCid).toBe(other.cid);
    expect(myCid).not.toBe(other.cid);

    // And the provenance labels agree with the stamps.
    const via = (id: string) =>
      String(store.handle.prepare("SELECT filed_via FROM task_ref WHERE backend = 'built-in' AND external_id = ?").get(id)?.["filed_via"]);
    expect(via(viaFirst)).toBe("mcp:planner-bot");
    expect(via(viaSecond)).toBe("mcp:other-bot");
  });

  test("pinned byte fixtures: tools/list, initialize, and discover serialize EXACTLY — field spellings are frozen", () => {
    // These are the wire bytes clients parse. A renamed field, a reordered
    // key, or a drifted description is a silent protocol break — so the
    // whole line is pinned, byte-for-byte, against JSON.stringify of the
    // expected object. Each inputSchema is derived from its Zod contract
    // (src/contracts/gateway-tools.ts) and accepts exactly what the
    // hand-written one did; the derived form spells a nullable as anyOf, leaves out
    // an empty required list and bounds integers to the safe range.
    const tools = [
      {
        name: 'get_project_context', description: 'Read bounded source excerpts or advisory static import impact in an admitted project. Falls back to text search without an index.',
        inputSchema: { type: 'object', properties: { repo: { type: 'string', minLength: 1, maxLength: 4096 }, query: { type: 'string', minLength: 1, maxLength: 1000 }, mode: { type: 'string', enum: ['search', 'impact'] } }, required: ['repo', 'query'], additionalProperties: false },
      },
      {
        name: "get_assignment", description: "Read one assignment's root, current execution, owner, exact result and handoff receipt. Approval, proof and deployment remain separate facts.",
        inputSchema: { type: "object", properties: { ref: { type: "string", minLength: 1, maxLength: 64 } }, required: ["ref"], additionalProperties: false },
      },
      {
        name: "list_assignment_updates", description: "Read durable assignment updates in your projects after a cursor. Save nextCursor after processing; repeated reads do not acknowledge or deliver anything.",
        inputSchema: { type: "object", properties: { after: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, limit: { type: "integer", minimum: 1, maximum: 100 } }, additionalProperties: false },
      },
      {
        name: "claim_assignment", description: "Record yourself as this assignment's lead. Repeating your claim is safe; another active owner cannot be replaced. This grants no approval or execution authority.",
        inputSchema: { type: "object", properties: { ref: { type: "string", minLength: 1, maxLength: 64 } }, required: ["ref"], additionalProperties: false },
      },
      {
        name: "acknowledge_assignment", description: "Acknowledge the exact ready-to-check receipt as its lead, using the current receipt digest. This does not accept failed proof, answer decisions, approve work, publish or deploy.",
        inputSchema: { type: "object", properties: { ref: { type: "string", minLength: 1, maxLength: 64 }, digest: { type: "string", minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" } }, required: ["ref", "digest"], additionalProperties: false },
      },
      {
        name: "get_assignment_brief", description: "Catch up from the local database: current work, decisions, saved results and project knowledge. Bounded read only; no model call or task mutation.",
        inputSchema: { type: "object", properties: { repo: { type: "string", minLength: 1, maxLength: 4096 }, limit: { type: "integer", minimum: 1, maximum: 25 } }, additionalProperties: false },
      },
      {
        name: "get_assignment_inbox", description: "Receive a durable batch of your assignments' status changes. Use a stable consumer name. Until acknowledged, the same batch survives reconnects and restarts. Receiving never completes or reruns work.",
        inputSchema: { type: "object", properties: { consumer: { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-z0-9][a-z0-9-]{0,63}$" }, limit: { type: "integer", minimum: 1, maximum: 100 } }, required: ["consumer"], additionalProperties: false },
      },
      {
        name: "acknowledge_assignment_delivery", description: "Acknowledge receipt of an inbox batch after handling its updates. This advances only your delivery cursor; it never marks work complete, answers a decision or starts a revision.",
        inputSchema: { type: "object", properties: { consumer: { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-z0-9][a-z0-9-]{0,63}$" }, batchId: { type: "string", minLength: 32, maxLength: 32, pattern: "^[a-f0-9]{32}$" } }, required: ["consumer", "batchId"], additionalProperties: false },
      },
      {
        name: "status",
        description: "The plane's liveness facts over your repo allowlist: what waits on the operator, what runs, what finished in the last 24h.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "list_tasks",
        description: "Tasks in your repo allowlist. Filter by state and repo; cursor-paginated, stable order.",
        inputSchema: {
          type: "object",
          properties: {
            state: { type: "string", enum: ["queued", "running", "done", "failed", "cancelled"] },
            repo: { type: "string", maxLength: 800 },
            cursor: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
            limit: { type: "integer", minimum: 1, maximum: 50 },
          },
          additionalProperties: false,
        },
      },
      {
        name: "get_task",
        description: "One task's deliverable (branch or report), scope standing, filer provenance, attempt ledger, and — for a finished scout — the report's title, summary, and follow-ups. A ref outside your allowlist answers not-found.",
        inputSchema: {
          type: "object",
          properties: { ref: { type: "string", minLength: 1, maxLength: 64 } },
          required: ["ref"],
          additionalProperties: false,
        },
      },
      {
        name: "list_repos",
        description: "The repositories your credential may see and file into, with their operating-mode standing.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "recap",
        description: "How things stand per repository in your allowlist, counts and ids: what waits on the operator (decisions, incidents, scopes awaiting approval), what runs, what is queued, finished, failed. Pass `since` (an ISO timestamp) to count only decisions, incidents, and attempts newer than it, to the hour; queued work and scopes awaiting approval always count.",
        inputSchema: { type: "object", properties: { since: { type: "string", maxLength: 30 } }, additionalProperties: false },
      },
      {
        name: "list_decisions",
        description: "Open decisions in your allowlist: id, task, question, options (id, label, reversible), age in hours. Never consequences or recommendations; the operator answers them.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "queue",
        description: "One repository's queue by column — the shared column, then each worker's reserved column — each in dispatch order.",
        inputSchema: { type: "object", properties: { repo: { type: "string", minLength: 1, maxLength: 800 } }, required: ["repo"], additionalProperties: false },
      },
      {
        name: "get_decision",
        description: "One open decision in your allowlist in full: question, options with id, label, reversible, and consequence. Never the builder's recommendation.",
        inputSchema: { type: "object", properties: { decision: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER } }, required: ["decision"], additionalProperties: false },
      },
      {
        name: "propose_next",
        description: "Propose moving a queued task to the front of its column. An approver confirms; a queue that moved meanwhile refuses.",
        inputSchema: { type: "object", properties: { ref: { type: "string", minLength: 1, maxLength: 64 } }, required: ["ref"], additionalProperties: false },
      },
      {
        name: "propose_reserve",
        description: "Propose reserving a queued task for one worker, or releasing it to the shared queue with worker null.",
        inputSchema: { type: "object", properties: { ref: { type: "string", minLength: 1, maxLength: 64 }, worker: { anyOf: [{ type: "string", maxLength: 60 }, { type: "null" }] } }, required: ["ref", "worker"], additionalProperties: false },
      },
      {
        name: "propose_hold",
        description: "Propose holding a task's next attempt, with a reason. A running attempt is never interrupted.",
        inputSchema: { type: "object", properties: { ref: { type: "string", minLength: 1, maxLength: 64 }, reason: { type: "string", maxLength: 200 } }, required: ["ref", "reason"], additionalProperties: false },
      },
      {
        name: "propose_unhold",
        description: "Propose lifting the operator's own hold on a task.",
        inputSchema: { type: "object", properties: { ref: { type: "string", minLength: 1, maxLength: 64 } }, required: ["ref"], additionalProperties: false },
      },
      {
        name: "propose_scope",
        description: "Propose rewriting a task's scope. An approver confirms the rewrite, then approves it with a password — a scope you wrote never seals under a mode.",
        inputSchema: { type: "object", properties: { ref: { type: "string", minLength: 1, maxLength: 64 }, goal: { type: "string", maxLength: 8000, description: "At most 8,000 characters (UTF-16 code units) and 32,000 UTF-8 bytes; no control or disguised text. Longer text is refused with its length, not cut: shorten it and call again." }, not: { type: "string", maxLength: 8000, description: "At most 8,000 characters (UTF-16 code units) and 32,000 UTF-8 bytes; no control or disguised text. Longer text is refused with its length, not cut: shorten it and call again." }, touches: { maxItems: 50, type: "array", items: { type: "string", maxLength: 200 } } }, required: ["ref", "goal"], additionalProperties: false },
      },
      {
        name: "propose_cancel",
        description: "Propose cancelling a task, with a reason. The approver arms and confirms it on the task itself.",
        inputSchema: { type: "object", properties: { ref: { type: "string", minLength: 1, maxLength: 64 }, reason: { type: "string", maxLength: 200 } }, required: ["ref", "reason"], additionalProperties: false },
      },
      {
        name: "propose_answer",
        description: "Propose an answer to an open decision you read with get_decision, with a rationale. The approver confirms where every consequence and the builder's recommendation are shown; an irreversible option needs their explicit confirmation.",
        inputSchema: { type: "object", properties: { decision: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, option: { type: "string", minLength: 1, maxLength: 64 }, rationale: { type: "string", maxLength: 400 } }, required: ["decision", "option", "rationale"], additionalProperties: false },
      },
      {
        name: "get_contract",
        description: "This surface's contract: what a coordinator may do, the proposal lifecycle, and the admission promise.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "file_proposal",
        description: "File a task proposal into one of your repositories. It stays quarantined until the operator signs its scope.",
        inputSchema: {
          type: "object",
          properties: {
            repo: { type: "string", minLength: 1, maxLength: 800 },
            title: { type: "string", minLength: 1, maxLength: 200 },
            intent: { type: "string", maxLength: 8000, description: "At most 8,000 characters (UTF-16 code units) and 32,000 UTF-8 bytes; no control or disguised text. Longer text is refused with its length, not cut: shorten it and call again." },
            idempotency_key: { type: "string", minLength: 8, maxLength: 64 },
            deliverable: { type: "string", enum: ["branch", "report"] },
          },
          required: ["repo", "title", "idempotency_key"],
          additionalProperties: false,
        },
      },
    ];

    // Eras are connection-pinned, so each fixture speaks on its own wire.
    const h = harness(store, token);
    const modern = harness(store, token);

    // Legacy initialize: the exact handshake-era result — no resultType,
    // no ttlMs, a bare serverInfo (never the namespaced _meta key).
    h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: LEGACY } });
    expect(h.lastRaw()).toBe(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: LEGACY,
          capabilities: { tools: {} },
          serverInfo: { name: "toolroll", version: PACKAGE_VERSION },
        },
      }),
    );

    // Modern tools/list: resultType/ttlMs/cacheScope spelled exactly, the
    // narrowest cacheScope "private", and every descriptor byte-for-byte.
    modern.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: modernMeta } });
    expect(modern.lastRaw()).toBe(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: { tools, resultType: "complete", ttlMs: 0, cacheScope: "private" },
      }),
    );

    // server/discover: supportedVersions and the NAMESPACED _meta serverInfo
    // key — the modern era's spellings, frozen.
    modern.send({ jsonrpc: "2.0", id: 3, method: "server/discover", params: { _meta: modernMeta } });
    expect(modern.lastRaw()).toBe(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        result: {
          protocolVersion: MODERN,
          supportedVersions: [MODERN, LEGACY],
          capabilities: { tools: {} },
          _meta: { "io.modelcontextprotocol/serverInfo": { name: "toolroll", version: PACKAGE_VERSION } },
          tools,
          resultType: "complete",
          ttlMs: 0,
          cacheScope: "private",
        },
      }),
    );
  });

  test("ARCH: no raw row spread leaves this module", () => {
    // The typed-projection rule (spec v6): reading the source proves no
    // `...row` reaches a tool result.
    const source = require("node:fs").readFileSync(new URL("./mcp.ts", import.meta.url), "utf8") as string;
    expect(source.includes("...row")).toBe(false);
  });

  test("the read tools the mate shares (mate arc, slice 4): recap, list_decisions, queue — the coordinator's view keeps paths, never consequences", () => {
    const filed = fileCoordinatorProposal(store, token, { repo: REPO, title: "first", idempotencyKey: "key-00000001" }, T0);
    const second = fileCoordinatorProposal(store, token, { repo: REPO, title: "second", idempotencyKey: "key-00000002" }, T0);
    if (!filed.ok || !second.ok) throw new Error("filing failed");
    const run = store.startRun({ taskRef: store.refFor("built-in", filed.id).id, leaseId: "l-1", runner: "runner-1", branch: "b", worktree: "/w", ...bareLegacy("build", "claude", null), now: T0 });
    store.saveDecision(
      {
        run,
        urgency: "blocking",
        recap: "RECAP-CANARY",
        question: "Which way?",
        options: [{ id: "a", label: "A", consequence: "CONSEQUENCE-CANARY", reversible: true }],
        recommendation: "a",
      },
      T0,
    );
    const h = harness(store, token);
    h.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { _meta: modernMeta, name: "recap", arguments: {} } });
    const recap = JSON.parse(String(((h.last()["result"] as Record<string, unknown>)["content"] as { text: string }[])[0]?.text)) as Record<string, unknown>;
    expect(recap).toMatchObject({ repos: [{ repo: REPO, queued: 2, waitsOnYou: { decisions: 1, scopesAwaitingApproval: 2 } }], waitsOnYou: { decisions: [{ repo: REPO, decision: 1, task: filed.id }] } });
    h.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { _meta: modernMeta, name: "recap", arguments: { since: "yesterday" } } });
    expect((h.last()["result"] as Record<string, unknown>)["isError"]).toBe(true);
    h.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { _meta: modernMeta, name: "list_decisions", arguments: {} } });
    const decisionsText = String(((h.last()["result"] as Record<string, unknown>)["content"] as { text: string }[])[0]?.text);
    expect(JSON.parse(decisionsText)).toMatchObject({ decisions: [{ repo: REPO, decision: 1, task: filed.id, question: "Which way?", options: [{ id: "a", label: "A", reversible: true }], ageHours: 0 }] });
    expect(decisionsText).not.toContain("CANARY");
    h.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { _meta: modernMeta, name: "queue", arguments: { repo: REPO } } });
    expect(JSON.parse(String(((h.last()["result"] as Record<string, unknown>)["content"] as { text: string }[])[0]?.text))).toMatchObject({
      repo: REPO,
      columns: [{ column: "shared", tasks: [{ position: 1, task: filed.id, approved: false }, { position: 2, task: second.id }] }],
    });
    h.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { _meta: modernMeta, name: "queue", arguments: { repo: "/repo/not-mine" } } });
    expect((h.last()["result"] as Record<string, unknown>)["isError"]).toBe(true);
  });

  test("propose_* over the gateway (mate arc v3): rows, not acts — allowlist, rate, pending cap, and an approver's confirm", () => {
    const filed = fileCoordinatorProposal(store, token, { repo: REPO, title: "first", idempotencyKey: "key-00000001" }, T0);
    const second = fileCoordinatorProposal(store, token, { repo: REPO, title: "second", idempotencyKey: "key-00000002" }, T0);
    if (!filed.ok || !second.ok) throw new Error("filing failed");
    const h = harness(store, token);
    const call = (id: number, name: string, args: Record<string, unknown>) => {
      h.send({ jsonrpc: "2.0", id, method: "tools/call", params: { _meta: modernMeta, name, arguments: args } });
      const last = h.last();
      const result = last["result"] as Record<string, unknown> | undefined;
      if (result === undefined) return { isError: true, body: JSON.stringify(last["error"] ?? last) };
      return { isError: result["isError"] === true, body: String((result["content"] as { text: string }[])[0]?.text ?? "") };
    };
    const moved = call(1, "propose_next", { ref: second.id });
    expect(moved.isError).toBe(false);
    expect(JSON.parse(moved.body)).toMatchObject({ proposal: 1, kind: "next", awaiting: "the operator's confirmation" });
    expect(store.queuePosition(second.id)?.position).toBe(2);
    expect(call(2, "propose_next", { ref: "no-such" }).body).toContain("not-found");
    expect(call(3, "propose_hold", { ref: filed.id, reason: "AKIAABCDEFGHIJKLMNOP" }).body).toContain("plain text");
    expect(call(4, "propose_hold", { ref: filed.id, reason: "later" }).isError).toBe(false);
    // Compound argument shapes are validated at the protocol layer (v3 review, finding 8).
    // The InvalidParams message names each path, read by the schema tools/list advertised.
    h.send({ jsonrpc: "2.0", id: 40, method: "tools/call", params: { _meta: modernMeta, name: "propose_reserve", arguments: { ref: filed.id, worker: 7 } } });
    expect(h.last()["error"]).toMatchObject({ code: -32602, message: "worker: must be a string (got a number)" });
    h.send({ jsonrpc: "2.0", id: 41, method: "tools/call", params: { _meta: modernMeta, name: "propose_scope", arguments: { ref: filed.id, goal: "g", touches: { a: 1 } } } });
    expect(h.last()["error"]).toMatchObject({ code: -32602, message: "touches: must be an array (got an object)" });
    h.send({ jsonrpc: "2.0", id: 42, method: "tools/call", params: { _meta: modernMeta, name: "propose_scope", arguments: { ref: filed.id, goal: "g", touches: ["src/a.ts", 3] } } });
    expect(h.last()["error"]).toMatchObject({ code: -32602, message: "touches[1]: must be a string (got a number)" });
    h.send({ jsonrpc: "2.0", id: 43, method: "tools/call", params: { _meta: modernMeta, name: "propose_hold", arguments: { ref: filed.id, resaon: "x" } } });
    expect(h.last()["error"]).toMatchObject({ code: -32602, message: "reason: required; payload: unknown key 'resaon' (did you mean reason?)" });
    // An answer needs get_decision on THIS connection first.
    const run = store.startRun({ taskRef: store.refFor("built-in", filed.id).id, leaseId: "l-2", runner: "runner-1", branch: "b", worktree: "/w", ...bareLegacy("build", "claude", null), now: T0 });
    store.saveDecision({ run, urgency: "blocking", recap: "RECAP", question: "Q?", options: [{ id: "a", label: "A", consequence: "ca", reversible: true }], recommendation: "a" }, T0);
    expect(call(43, "propose_answer", { decision: 1, option: "a", rationale: "fine" }).body).toContain("get_decision");
    expect(call(44, "get_decision", { decision: 1 }).body).toContain("ca");
    expect(JSON.parse(call(45, "propose_answer", { decision: 1, option: "a", rationale: "fine" }).body)).toMatchObject({ kind: "answer" });
    // The row is a coordinator proposal, admitted to an approver whose ceiling holds the repo.
    const rows = store.listCoordinatorProposals({ repos: [REPO] });
    expect(rows.map(one => one.kind)).toEqual(["answer", "hold", "next"]);
    expect(rows[2]).toMatchObject({ name: "planner-bot", repo: REPO, payload: { task: second.id, position: 2, of: 2 } });
    expect(store.listCoordinatorProposals({ repos: ["/repo/other"] })).toEqual([]);
    // Revoking the credential expires its pending rows.
    revokeCoordinator(store, rows[0]!.cid, "alex", T0);
    expect(store.listCoordinatorProposals({ repos: [REPO] })).toEqual([]);
    expect(store.getCoordinatorProposal(1)?.state).toBe("expired");
    expect(call(5, "propose_next", { ref: second.id }).body).toContain("no longer stands");
  });
});

describe("assignment arguments: the CLI and the gateway read them with one schema", () => {
  test("the same malformed call is the same path-named lines — a usage failure in the CLI, InvalidParams on the gateway", () => {
    const store = openStore(":memory:");
    try {
      const made = mintCoordinator(store, { name: "planner-bot", repos: [REPO], by: "alex", now: T0 });
      if (!made.ok) throw new Error("mint failed");
      const cli = (positional: string[], flags: [string, string][]) => {
        const lines: string[] = [];
        const code = runAssignmentCommand(positional, new Map(flags), { store, write: line => lines.push(line), json: false, now: T0 });
        return { code, text: lines.join("\n") };
      };
      const h = harness(store, made.token);
      const gateway = (name: string, args: Record<string, unknown>) => {
        h.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { _meta: modernMeta, name, arguments: args } });
        return h.last()["error"] as { code: number; message: string };
      };
      const digest = "must be the exact 64-character receipt digest from assignment show";
      expect(cli(["check", "t-1"], [["digest", "abc"]])).toEqual({ code: 2, text: `digest: at least 64; digest: ${digest}` });
      expect(gateway("acknowledge_assignment", { ref: "t-1", digest: "abc" })).toEqual({ code: -32602, message: `digest: at least 64; digest: ${digest}` });
      expect(cli(["updates"], [["limit", "500"]])).toEqual({ code: 2, text: "limit: at most 100" });
      expect(gateway("list_assignment_updates", { limit: 500 })).toEqual({ code: -32602, message: "limit: at most 100" });
      expect(cli(["inbox"], [["consumer", "Planner Bot"]]).text).toBe("consumer: must be a stable consumer name: lowercase letters, digits and hyphens");
      expect(gateway("get_assignment_inbox", { consumer: "Planner Bot" }).message).toBe("consumer: must be a stable consumer name: lowercase letters, digits and hyphens");
      // What JSON Schema can't say is checked after parsing, by path, on both roads.
      expect(cli(["show", "t\u0007"], []).text).toBe("ref: must not contain control characters");
    } finally { store.close(); }
  });
});

describe("the MCP server and a restored database", () => {
  test("a database replaced at its path (a restore or rollback) is never answered from: the server refuses and exits", () => {
    const dir = mkdtempSync(join(tmpdir(), "toolroll-mcp-restore-"));
    const file = join(dir, "orders.db");
    const store = openStore(file);
    try {
      const made = mintCoordinator(store, { name: "planner-bot", repos: [REPO], by: "alex", now: T0 });
      if (!made.ok) throw new Error("mint failed");
      const h = harness(store, made.token);
      const call = (id: number) => h.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "status", arguments: {}, _meta: modernMeta } });
      call(1);
      expect(h.last()["result"]).toBeDefined();
      expect(h.exitCode()).toBeNull();
      // As restoreFile does: a copy renamed over the live path.
      store.raw().exec("PRAGMA wal_checkpoint(TRUNCATE)");
      copyFileSync(file, `${file}.restore`); renameSync(`${file}.restore`, file);
      call(2);
      expect(h.last()["error"]).toMatchObject({ message: expect.stringContaining("the database was replaced underneath this server") });
      expect(h.exitCode()).toBe(0);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
