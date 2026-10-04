/**
 * Steps that reach outside (v87): a web request to a real local server, an
 * email through a real local mail server (nodemailer, no fakes on the wire),
 * and a real MCP server started over stdio — through the real step pass.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createServer as createHttp, type IncomingMessage } from "node:http";
import { createServer as createTcp, type Server } from "node:net";
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { run as exec } from "./exec.js";
import { flowFromSteps, flowTerms, validateFlowDefinition, FLOW_TEMPLATES } from "./flows.js";
import { runFlowSteps, type StepIo } from "./flow-steps.js";
import { readEmailSettings, saveEmailSettings, setFlowSecret, flowSecretNames } from "./flow-actions.js";
import { addToolTo, validateToolSpec } from "./project-tools.js";

const T0 = new Date("2026-09-25T09:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
let dir: string, repo: string, store: Store;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-flow-actions-")));
  repo = join(dir, "shop");
  store = openStore(join(dir, "orders.db"));
  if (!addApprover(store, "alex", T0).ok) throw new Error("bootstrap");
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const io = (extra: Partial<StepIo> = {}): StepIo => ({ gh: exec, git: exec, shell: exec, fetch, dir, scratch: join(dir, "scratch"), base: "main", toolHome: dir, ...extra });
const flowOf = (steps: Parameters<typeof flowFromSteps>[0]) => store.createFlow({ repo, name: "Outreach", definitionJson: JSON.stringify(flowFromSteps(steps, null)), by: "alex" }, T0);
const cardIn = (flow: number, stage: string, description = "Please get back to me at priya@example.com. Order 42.") =>
  store.addFlowCard({ flow, title: "Refund for order 42?", description, stage, by: "alex" }, T0);

describe("the drawing", () => {
  test("a request's host is written out; an email says who, what and about what; a tool's arguments are a JSON object", () => {
    const base = { version: 1, start: "a", stages: [{ id: "a", title: "Call", kind: "request", zone: {}, request: { method: "POST", url: "https://api.example.com/items", headers: {}, body: "{}" }, next: "done" }, { id: "done", title: "Done", kind: "done", zone: {} }] };
    const withRequest = (request: Record<string, unknown>) => ({ ...base, stages: [{ ...base.stages[0], request: { ...base.stages[0]!.request, ...request } }, base.stages[1]] });
    expect(() => validateFlowDefinition(withRequest({ url: "https://{{card.title}}/x" }))).toThrow("Zone Call: write the address's host out in full; fill-ins go after it.");
    expect(() => validateFlowDefinition(withRequest({ url: "ftp://example.com" }))).toThrow("Zone Call: the address must start with https:// or http://.");
    expect(() => validateFlowDefinition(withRequest({ url: "https://user@evil.example/x" }))).toThrow("write the address's host out in full");
    expect(() => validateFlowDefinition(withRequest({ headers: { "Bad Header": "x" } }))).toThrow("“Bad Header” isn't a header name.");
    expect(validateFlowDefinition(withRequest({ method: "GET" })).stages[0]!.request).toMatchObject({ method: "GET", body: null });
    const flow = flowFromSteps([
      { title: "Tell the CRM", kind: "request", url: "https://crm.example.com/leads?from={{card.email}}", headers: { Authorization: "Bearer {{secret.CRM_TOKEN}}" }, body: '{"name": "{{card.title}}"}' },
      { title: "Email them", kind: "email", body: "Thanks!" },
      { title: "Tell Slack", kind: "tool", server: "slack", tool: "post_message", args: { channel: "#leads", text: "{{card.title}}" } },
    ], null);
    expect(flow.stages.map(one => [one.kind, one.request ?? one.email ?? one.tool ?? null])).toEqual([
      ["request", { method: "POST", url: "https://crm.example.com/leads?from={{card.email}}", headers: { Authorization: "Bearer {{secret.CRM_TOKEN}}" }, body: '{"name": "{{card.title}}"}' }],
      ["email", { to: "{{card.email}}", subject: "Re: {{card.title}}", body: "Thanks!" }],
      ["tool", { server: "slack", name: "post_message", args: '{"channel":"#leads","text":"{{card.title}}"}' }],
      ["done", null],
    ]);
    const terms = flowTerms(flow, null);
    expect(terms[0]).toContain("Calls POST https://crm.example.com/leads?from=[the card's email address] with the Authorization header, sending: {\"name\": \"[card title]\"}");
    expect(terms[1]).toContain("Emails [the card's email address]: “Re: [card title]”");
    expect(terms[2]).toContain("Uses slack → post_message with {\"channel\":\"#leads\",\"text\":\"[card title]\"}");
    expect(terms).toContain("Web request, email and tool steps send what they're given outside this computer, with no one checking unless a decision comes before them.");
    expect(() => flowFromSteps([{ title: "Tool", kind: "tool", server: "x", tool: "y", args: "[1,2]" }], null)).toThrow("the arguments are a JSON object");
    for (const one of FLOW_TEMPLATES) expect(() => validateFlowDefinition(one.definition)).not.toThrow();
  });
});

describe("a web request", () => {
  let server: ReturnType<typeof createHttp>, base: string;
  const seen: { method: string; url: string; headers: IncomingMessage["headers"]; body: string }[] = [];
  let reply = { status: 200, body: '{"id": 7}' };
  beforeEach(async () => {
    seen.length = 0;
    reply = { status: 200, body: '{"id": 7}' };
    server = createHttp((request, response) => {
      let body = "";
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => { seen.push({ method: request.method!, url: request.url!, headers: request.headers, body }); response.writeHead(reply.status, { "content-type": "application/json" }); response.end(reply.body.replace("ECHO", String(request.headers["authorization"] ?? ""))); });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(() => new Promise<void>(resolve => server.close(() => resolve())));

  test("it sends the card's details with the secret in its header, keeps the answer, and an echoed secret is blanked", async () => {
    expect(setFlowSecret(dir, repo, "CRM_TOKEN", "tok-live-9f8e7d6c")).toEqual({ ok: true, said: "Saved CRM_TOKEN. Only this project's web requests and scripts that name it get it." });
    expect(flowSecretNames(dir, repo)).toEqual(["CRM_TOKEN"]);
    expect(statSync(join(dir, "flow-secrets")).mode & 0o777).toBe(0o700);
    const flow = flowOf([{ id: "call", title: "Tell the CRM", kind: "request", url: `${base}/leads/{{card.title}}?who={{card.email}}`, headers: { Authorization: "Bearer {{secret.CRM_TOKEN}}" }, body: '{"name": "{{card.title}}", "note": "{{card.description}}"}' }]);
    const card = cardIn(flow, "call");
    reply = { status: 201, body: '{"id": 7, "auth": "ECHO"}' };
    expect(await runFlowSteps(store, repo, at(1), io())).toEqual({ ran: 1, problems: [] });
    // The card's words are encoded in the path: they can't change where it goes.
    expect(seen[0]).toMatchObject({ method: "POST", url: "/leads/Refund%20for%20order%2042%3F?who=priya%40example.com", body: '{"name":"Refund for order 42?","note":"Please get back to me at priya@example.com. Order 42."}' });
    expect(seen[0]!.headers).toMatchObject({ authorization: "Bearer tok-live-9f8e7d6c", "content-type": "application/json" });
    expect(store.getFlowCard(card)).toMatchObject({ stage: "done", outputs: { call: '{"id": 7, "auth": "Bearer [secret]"}' } });
    const run = store.flowStepRun(card, 1)!;
    expect(run).toMatchObject({ kind: "request", state: "passed", result: `127.0.0.1:${base.split(":")[2]}/leads/Refund%20for%20order%2042%3F answered 201.` });
    expect(run.log).toContain(`POST ${base}/leads/Refund%20for%20order%2042%3F?…\n→ 201`);
    expect(JSON.stringify(run)).not.toContain("tok-live-9f8e7d6c");
  });

  test("an answer is passed on whole up to 12,000 characters; longer is attached whole to the card and linked, never cut", async () => {
    const flow = flowOf([{ id: "call", title: "Look it up", kind: "request", method: "GET", url: `${base}/x` }]);
    const fits = cardIn(flow, "call");
    reply = { status: 200, body: "a".repeat(12_000) };
    await runFlowSteps(store, repo, at(1), io());
    expect(store.getFlowCard(fits)!.outputs["call"]).toBe("a".repeat(12_000));
    expect(store.flowComments(fits)).toEqual([]);
    const long = cardIn(flow, "call");
    const answer = `START ${"b".repeat(20_000)} END`;
    reply = { status: 200, body: answer };
    await runFlowSteps(store, repo, at(2), io());
    expect(store.getFlowCard(long)!.outputs["call"]).toBe(`This is 20,010 characters, more than the 12,000 a step passes on, so it is kept whole on the card's discussion: /flows/${flow}?card=${long}.`);
    expect(store.flowComments(long).map(one => one.body)).toEqual([`What Look it up produced, in full (20,010 characters):\n\n${answer}`]);
  });

  test("a refusal takes the failure path; a server error is tried again; a missing secret says so", async () => {
    const flow = flowOf([{ title: "Inbox", kind: "inbox" }, { id: "call", title: "Call", kind: "request", method: "GET", url: `${base}/x`, headers: { "X-Key": "{{secret.NOPE}}" }, ifFails: "Inbox" }]);
    const missing = cardIn(flow, "call");
    await runFlowSteps(store, repo, at(1), io());
    expect(store.getFlowCard(missing)).toMatchObject({ stage: "inbox", note: "Set the secret NOPE on the step first." });
    const plain = flowOf([{ title: "Inbox", kind: "inbox" }, { id: "call", title: "Call", kind: "request", method: "GET", url: `${base}/x`, ifFails: "Inbox" }]);
    const refused = cardIn(plain, "call");
    reply = { status: 404, body: "not here" };
    await runFlowSteps(store, repo, at(2), io());
    expect(store.getFlowCard(refused)).toMatchObject({ stage: "inbox", note: `127.0.0.1:${base.split(":")[2]}/x refused it (404): not here.` });
    const busy = cardIn(plain, "call");
    reply = { status: 503, body: "busy" };
    await runFlowSteps(store, repo, at(3), io());
    expect(store.getFlowCard(busy)).toMatchObject({ stage: "call", waiting: `127.0.0.1:${base.split(":")[2]}/x answered 503: busy. Trying again in 5 minutes.` });
  });
});

describe("an email", () => {
  /** A mail server on this computer that takes anything, speaking just enough SMTP for nodemailer. */
  function mailServer(): Promise<{ server: Server; port: number; received: { from: string; to: string[]; data: string }[] }> {
    const received: { from: string; to: string[]; data: string }[] = [];
    const server = createTcp(socket => {
      let buffer = "", reading = false, current = { from: "", to: [] as string[], data: "" };
      socket.write("220 test ESMTP\r\n");
      socket.on("data", chunk => {
        buffer += chunk.toString("utf8");
        for (;;) {
          if (reading) {
            const end = buffer.indexOf("\r\n.\r\n");
            if (end < 0) return;
            current.data = buffer.slice(0, end);
            buffer = buffer.slice(end + 5);
            reading = false;
            received.push(current);
            current = { from: "", to: [], data: "" };
            socket.write("250 queued\r\n");
            continue;
          }
          const newline = buffer.indexOf("\r\n");
          if (newline < 0) return;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 2);
          if (/^EHLO/i.test(line)) socket.write("250-test\r\n250 SIZE 10000000\r\n");
          else if (/^MAIL FROM:/i.test(line)) { current.from = line.slice(10); socket.write("250 ok\r\n"); }
          else if (/^RCPT TO:/i.test(line)) { current.to.push(line.slice(8)); socket.write(line.includes("nobody@") ? "550 no such user\r\n" : "250 ok\r\n"); }
          else if (/^DATA/i.test(line)) { reading = true; socket.write("354 go\r\n"); }
          else if (/^QUIT/i.test(line)) { socket.write("221 bye\r\n"); socket.end(); }
          else socket.write("250 ok\r\n");
        }
      });
    });
    return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port, received })));
  }

  test("it waits until email is set up, then sends through the real mail server to the card's address", async () => {
    const flow = flowOf([{ id: "draft", title: "Draft", kind: "inbox" }, { id: "send", title: "Email it", kind: "email", to: "{{card.email}}", subject: "Re: {{card.title}}\nBcc: x@evil.example", body: "{{stage.draft}}", ifFails: "Draft" }]);
    const card = cardIn(flow, "send");
    store.updateFlowCard(card, { outputs: { draft: "Hi Priya, refunded today." } }, T0);
    await runFlowSteps(store, repo, at(1), io());
    expect(store.getFlowCard(card)).toMatchObject({ stage: "send", waiting: "Email isn't set up yet. Add your mail server or a Google account in Settings → Email." });
    const mail = await mailServer();
    try {
      expect(saveEmailSettings(dir, { host: "127.0.0.1", port: String(mail.port), secure: undefined, user: "", from: "team@shop.example", password: "" })).toEqual({ ok: true, said: "Email is set up: it comes from team@shop.example." });
      expect(statSync(join(dir, "email.json")).mode & 0o777).toBe(0o600);
      expect(readEmailSettings(dir)).toMatchObject({ host: "127.0.0.1", port: mail.port, secure: false, from: "team@shop.example" });
      await runFlowSteps(store, repo, at(2), io());
      expect(store.getFlowCard(card)).toMatchObject({ stage: "done", outputs: { send: "Sent to priya@example.com: “Re: Refund for order 42? Bcc: x@evil.example”" } });
      expect(mail.received).toHaveLength(1);
      expect(mail.received[0]!.to).toEqual(["<priya@example.com>"]);
      // The subject's line break is gone: nothing smuggles a header in.
      expect(mail.received[0]!.data).toMatch(/^Subject: Re: Refund for order 42\? Bcc: x@evil\.example$/m);
      expect(mail.received[0]!.data).not.toMatch(/^Bcc:/m);
      expect(mail.received[0]!.data).toContain("Hi Priya, refunded today.");
      // No address on the card, or one the server refuses: the failure path, with why.
      const none = cardIn(flow, "send", "No address here.");
      const refused = cardIn(flow, "send", "Write to nobody@example.com");
      store.updateFlowCard(refused, { outputs: { draft: "Hello." } }, T0);
      await runFlowSteps(store, repo, at(3), io());
      expect(store.getFlowCard(none)).toMatchObject({ stage: "draft", note: "There's no one to send it to: the card has no email address." });
      expect(store.getFlowCard(refused)).toMatchObject({ stage: "draft", note: "The mail server refused it (550)." });
    } finally { await new Promise<void>(resolve => mail.server.close(() => resolve())); }
  });
});

describe("a project tool", () => {
  test("it starts the project's own MCP server, calls the tool with the card's details, and a tool's own failure takes the failure path", async () => {
    const script = join(dir, "echo-server.mjs");
    writeFileSync(script, `import { createInterface } from "node:readline";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") reply(message.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "echo", version: "1" } });
  else if (message.method === "tools/list") reply(message.id, { tools: [{ name: "echo", inputSchema: { type: "object" } }, { name: "fail", inputSchema: { type: "object" } }] });
  else if (message.method === "tools/call" && message.params.name === "fail") reply(message.id, { content: [{ type: "text", text: "Channel not found" }], isError: true });
  else if (message.method === "tools/call") reply(message.id, { content: [{ type: "text", text: "posted " + JSON.stringify(message.params.arguments) + " with " + process.env.ECHO_TOKEN }] });
});
`);
    const flow = flowOf([{ title: "Inbox", kind: "inbox" }, { id: "post", title: "Post it", kind: "tool", server: "echo", tool: "echo", args: { channel: "#support", text: "New: {{card.title}}" }, ifFails: "Inbox" }]);
    const card = cardIn(flow, "post");
    await runFlowSteps(store, repo, at(1), io());
    expect(store.getFlowCard(card)).toMatchObject({ stage: "post", waiting: "There's no tool called echo in this project. Add it on the Tools page." });
    expect(addToolTo(store, repo, validateToolSpec({ name: "echo", command: process.execPath, args: [script], secrets: [{ name: "ECHO_TOKEN", optional: false }], about: "Echoes" }), "test", "alex", T0, { values: { ECHO_TOKEN: "echo-secret-123" }, home: dir })).toMatchObject({ ok: true });
    await runFlowSteps(store, repo, at(2), io());
    expect(store.getFlowCard(card)).toMatchObject({ stage: "done", outputs: { post: 'posted {"channel":"#support","text":"New: Refund for order 42?"} with [secret]' } });
    expect(store.flowStepRun(card, 1)).toMatchObject({ kind: "tool", state: "passed", result: "echo → echo done." });
    const failing = flowOf([{ title: "Inbox", kind: "inbox" }, { id: "post", title: "Post it", kind: "tool", server: "echo", tool: "fail", args: {}, ifFails: "Inbox" }]);
    const other = cardIn(failing, "post");
    await runFlowSteps(store, repo, at(3), io());
    expect(store.getFlowCard(other)).toMatchObject({ stage: "inbox", note: "echo → fail said it failed: Channel not found." });
  });
});
