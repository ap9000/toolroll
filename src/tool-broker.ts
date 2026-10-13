/**
 * The tool broker: where a build's project tools keep their secrets.
 *
 * Anything a fenced agent can read, its shell can read too, so no tool secret
 * may sit in its MCP config, its environment, an inherited descriptor or a
 * process it can inspect. The broker runs in Toolroll's own process, outside
 * the fence, for one launch: it holds each tool's resolved values in memory,
 * starts a local server itself (with the values as that server's environment,
 * inside the run's fence when it has one) or relays to a web server (adding
 * the sign-in headers), and serves each tool as streamable HTTP on a loopback
 * port. The agent's config names only that address and a token minted for
 * this launch: valid for exactly its opted-in tools (a research step's only
 * for their read-only actions), and revoked when the launch ends. A resumed
 * build is a new launch with its own broker and token.
 *
 * What it relays is plain JSON-RPC: a request gets its answer as JSON, a
 * notification is accepted, and a server's own requests (sampling, roots) are
 * answered "not supported" — a build has nobody to ask.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ToolSpec } from "./contracts/integration-metadata.js";

/** One tool a launch may use: its values (never leaving this process) and, for research, the only actions it offers. */
export type BrokeredTool = { spec: ToolSpec; values: Record<string, string>; actions?: readonly string[] };

export type BrokerOptions = {
  /** Where a local server's environment comes from (the launch's): only SERVER_ENV's names are taken from it. */
  env?: NodeJS.ProcessEnv;
  omitEnv?: readonly string[];
  /** Toolroll's own settings for a local server (the run's isolated database), passed as they are. */
  pass?: Readonly<Record<string, string>>;
  cwd?: string;
  /** How a local server is started inside its run's fence, read when it starts (the fence is fixed after the tools). */
  wrap?: () => ((file: string, args: readonly string[]) => { file: string; args: string[] }) | null;
};

export type ToolBroker = {
  /** The launch's token: the agent's only key to its tools. */
  token: string;
  url: (name: string) => string;
  /** The local servers running now (the fence tests read them). */
  pids: () => number[];
  /** Revoke the token, stop every server, close the port. */
  close: () => void;
};

type Message = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
type Answer = { status: number; type: string; body: string; session?: string | null };

const BODY_LIMIT = 4 * 1024 * 1024;
const ANSWER_LIMIT = 32 * 1024 * 1024;
const STOP_GRACE_MS = 2_000;

const rpcError = (id: unknown, message: string, code = -32000) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const isRequest = (message: Message) => typeof message.method === "string" && message.id !== undefined && message.id !== null;

/** A research step's server lists and calls only its read-only actions. */
function limitList(message: Message, actions: readonly string[] | undefined): Message {
  if (actions === undefined || message === null || typeof message !== "object" || message.result === null || typeof message.result !== "object") return message;
  const result = message.result as Record<string, unknown>;
  return { ...message, result: { ...result,
    ...(Array.isArray(result["tools"]) ? { tools: result["tools"].filter(one => one !== null && typeof one === "object" && actions.includes(String((one as { name?: unknown }).name))) } : {}),
    // The research grant names tool actions only; it grants no resources or prompts.
    ...Object.fromEntries(["resources", "resourceTemplates", "prompts"].filter(key => Array.isArray(result[key])).map(key => [key, []])),
  } };
}

const RESEARCH_METHODS = new Set(["initialize", "ping", "notifications/initialized", "notifications/cancelled", "tools/list", "resources/list", "resources/templates/list", "prompts/list"]);
function refused(message: Message, actions: readonly string[] | undefined): Message | null {
  if (actions === undefined || RESEARCH_METHODS.has(String(message.method))) return null;
  const name = (message.params as { name?: unknown } | undefined)?.name;
  if (message.method === "tools/call" && typeof name === "string" && actions.includes(name)) return null;
  return rpcError(message.id, "This step may only read: that action is not available.", -32601);
}

/** What a local server inherits from the launch: enough to run and find its tools, and nothing that could be
 * another tool's or a provider's secret. Its own configured values are added after. */
export const SERVER_ENV: readonly string[] = ["PATH", "HOME", "USER", "LANG", "TMPDIR", "SHELL", "TERM", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  ...["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY"].flatMap(name => [name, name.toLowerCase()])];

/** A local server's environment: the allowlisted names from `base` (and its LC_* locale), less `omit`, then `pass`,
 * then the tool's own values. */
export function serverEnv(base: NodeJS.ProcessEnv, omit: readonly string[], pass: Readonly<Record<string, string>>, values: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) if (value !== undefined && (SERVER_ENV.includes(name) || name.startsWith("LC_"))) env[name] = value;
  for (const name of omit) delete env[name];
  return Object.assign(env, pass, values);
}

/** A local server, started on first use and spoken to over its stdin and stdout. */
class LocalServer {
  private child: ChildProcess | null = null;
  private initialized = false;
  private buffer = "";
  private next = 1;
  private readonly pending = new Map<number, { id: unknown; done: (message: Message) => void }>();

  constructor(private readonly tool: BrokeredTool, private readonly options: BrokerOptions) {}

  pid(): number | null { return this.child?.pid ?? null; }

  private start(): ChildProcess {
    const env = serverEnv(this.options.env ?? process.env, this.options.omitEnv ?? [], this.options.pass ?? {}, this.tool.values);
    const wrap = this.options.wrap?.() ?? null;
    const { file, args } = wrap === null ? { file: this.tool.spec.command!, args: [...this.tool.spec.args] } : wrap(this.tool.spec.command!, this.tool.spec.args);
    const child = spawn(file, args, { env, ...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }), stdio: ["pipe", "pipe", "ignore"], detached: process.platform !== "win32" });
    this.child = child;
    this.initialized = false;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.read(chunk));
    const gone = (why: string) => {
      if (this.child !== child) return;
      this.child = null;
      for (const [, waiting] of this.pending) waiting.done(rpcError(waiting.id, why));
      this.pending.clear();
    };
    child.on("error", error => gone(`The tool could not start: ${error.message}.`));
    child.on("exit", code => gone(`The tool stopped (exit ${code ?? "signal"}).`));
    child.stdin?.on("error", () => undefined);
    return child;
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    for (let end = this.buffer.indexOf("\n"); end >= 0; end = this.buffer.indexOf("\n")) {
      const line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      let message: Message;
      try { message = JSON.parse(line) as Message; } catch { continue; }
      if (message === null || typeof message !== "object") continue;
      if (isRequest(message)) { this.write(rpcError(message.id, "Not supported in an unattended build.", -32601)); continue; }
      const waiting = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
      if (waiting === undefined) continue;
      this.pending.delete(message.id as number);
      waiting.done({ ...message, id: waiting.id });
    }
  }

  private write(message: unknown): void {
    try { this.child?.stdin?.write(`${JSON.stringify(message)}\n`); } catch { /* its exit answers whoever waits */ }
  }

  /** One message from the agent: a request's answer, or null for a notification. */
  send(message: Message): Promise<Message | null> {
    // A new session (a reconnect) starts a fresh server: a server answers initialize once.
    if (message.method === "initialize" && this.initialized) this.stop();
    if (this.child === null) this.start();
    if (message.method === "initialize") this.initialized = true;
    if (!isRequest(message)) {
      if (typeof message.method === "string") this.write(message);
      return Promise.resolve(null);
    }
    const id = this.next++;
    return new Promise(resolve => {
      this.pending.set(id, { id: message.id, done: resolve });
      this.write({ ...message, id });
    });
  }

  stop(): void {
    const child = this.child;
    if (child === null) return;
    this.child = null;
    for (const [, waiting] of this.pending) waiting.done(rpcError(waiting.id, "The tool was stopped."));
    this.pending.clear();
    const signal = (name: NodeJS.Signals) => {
      try { if (child.pid !== undefined && process.platform !== "win32") process.kill(-child.pid, name); else child.kill(name); } catch { /* gone */ }
    };
    signal("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) setTimeout(() => signal("SIGKILL"), STOP_GRACE_MS).unref();
  }
}

/** A web server, relayed with its sign-in headers added here and nowhere else. */
async function relayWeb(tool: BrokeredTool, request: IncomingMessage, body: string): Promise<Answer> {
  const spec = tool.spec;
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  for (const name of ["mcp-session-id", "mcp-protocol-version", "last-event-id"]) {
    const value = request.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  if (spec.bearer !== null && tool.values[spec.bearer]) headers["authorization"] = `Bearer ${tool.values[spec.bearer]}`;
  for (const [header, secret] of Object.entries(spec.headerSecrets)) if (tool.values[secret]) headers[header] = tool.values[secret]!;
  try {
    // Never followed: a redirect would carry the sign-in headers to wherever it points.
    const response = await fetch(spec.url!, { method: request.method ?? "POST", headers, redirect: "error", ...(request.method === "POST" ? { body } : {}) });
    const text = (await response.text()).slice(0, ANSWER_LIMIT);
    return { status: response.status, type: response.headers.get("content-type") ?? "application/json", body: text, session: response.headers.get("mcp-session-id") };
  } catch {
    let id: unknown = null;
    try { id = (JSON.parse(body) as Message).id ?? null; } catch { id = null; }
    return { status: 200, type: "application/json", body: JSON.stringify(rpcError(id, "The tool's server could not be reached.")) };
  }
}

/** A relayed answer with a research step's list limited, JSON or event stream alike. */
function limitAnswer(answer: Answer, actions: readonly string[] | undefined): Answer {
  if (actions === undefined) return answer;
  const limit = (text: string) => {
    try {
      const parsed = JSON.parse(text) as Message | Message[];
      return JSON.stringify(Array.isArray(parsed) ? parsed.map(one => limitList(one, actions)) : limitList(parsed, actions));
    } catch { return JSON.stringify(rpcError(null, "The tool returned an invalid response.")); }
  };
  const body = answer.type.includes("text/event-stream")
    ? answer.body.split(/\r?\n\r?\n/).map(event => {
      const lines = event.split(/\r?\n/);
      const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, ""));
      if (data.length === 0) return event;
      return [...lines.filter(line => !line.startsWith("data:")), `data: ${limit(data.join("\n"))}`].join("\n");
    }).join("\n\n")
    : limit(answer.body);
  return { ...answer, body };
}

function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise(resolve => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) { resolve(null); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", () => resolve(null));
  });
}

/** Start one launch's broker on a loopback port. */
export async function startToolBroker(tools: readonly BrokeredTool[], options: BrokerOptions = {}): Promise<ToolBroker> {
  const token = randomBytes(32).toString("base64url");
  const expected = Buffer.from(`Bearer ${token}`);
  let revoked = false;
  const byName = new Map(tools.map(tool => [tool.spec.name, tool]));
  const local = new Map(tools.filter(tool => tool.spec.transport !== "http").map(tool => [tool.spec.name, new LocalServer(tool, options)]));
  const authorized = (request: IncomingMessage) => {
    const given = Buffer.from(String(request.headers["authorization"] ?? ""));
    return !revoked && given.length === expected.length && timingSafeEqual(given, expected);
  };
  const reply = (response: ServerResponse, answer: Answer) => {
    response.writeHead(answer.status, { "content-type": answer.type, ...(answer.session == null ? {} : { "mcp-session-id": answer.session }) });
    response.end(answer.body);
  };
  const json = (status: number, value: unknown): Answer => ({ status, type: "application/json", body: JSON.stringify(value) });

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const name = /^\/mcp\/([a-z0-9][a-z0-9_-]*)$/.exec(request.url ?? "")?.[1];
    const tool = name === undefined ? undefined : byName.get(name);
    if (!authorized(request)) return reply(response, json(401, { error: "This launch's tools are closed to that key." }));
    if (tool === undefined) return reply(response, json(404, { error: "No such tool in this launch." }));
    if (request.method === "GET") return reply(response, { status: 405, type: "text/plain", body: "" });
    const server = local.get(tool.spec.name);
    if (request.method === "DELETE") {
      if (server !== undefined) { server.stop(); return reply(response, { status: 200, type: "text/plain", body: "" }); }
      return reply(response, await relayWeb(tool, request, ""));
    }
    if (request.method !== "POST") return reply(response, { status: 405, type: "text/plain", body: "" });
    const body = await readBody(request);
    if (body === null) return reply(response, json(413, rpcError(null, "The message is too large.")));
    let parsed: Message | Message[];
    try { parsed = JSON.parse(body) as Message | Message[]; } catch { return reply(response, json(400, rpcError(null, "Parse error", -32700))); }
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    if (messages.length === 0 || messages.some(one => one === null || typeof one !== "object" || Array.isArray(one) || typeof one.method !== "string")) return reply(response, json(400, rpcError(null, "Invalid request", -32600)));
    // A refused action is answered here and never reaches the tool.
    const refusals = messages.map(one => refused(one, tool.actions));
    const deniedAnswers = refusals.filter((one, index): one is Message => one !== null && isRequest(messages[index]!));
    if (refusals.every(one => one !== null)) return reply(response, deniedAnswers.length === 0
      ? { status: 202, type: "text/plain", body: "" }
      : json(200, Array.isArray(parsed) ? deniedAnswers : deniedAnswers[0]));
    if (server === undefined) {
      const allowed = messages.filter((_, index) => refusals[index] === null);
      // Relay exactly what was parsed and authorized, never ambiguous raw JSON.
      let answer = limitAnswer(await relayWeb(tool, request, JSON.stringify(Array.isArray(parsed) ? allowed : allowed[0])), tool.actions);
      if (deniedAnswers.length > 0) {
        if (answer.type.includes("text/event-stream")) {
          answer = { ...answer, body: answer.body + deniedAnswers.map(one => `\nevent: message\ndata: ${JSON.stringify(one)}\n\n`).join("") };
        } else if (answer.status >= 200 && answer.status < 300) {
          const upstream = answer.body.trim() === "" ? [] : JSON.parse(answer.body) as Message | Message[];
          answer = { ...answer, status: 200, type: "application/json", body: JSON.stringify([...(Array.isArray(upstream) ? upstream : [upstream]), ...deniedAnswers]) };
        }
      }
      return reply(response, answer);
    }
    const answers: Message[] = [];
    for (const [index, message] of messages.entries()) {
      const answer = refusals[index] ?? await server.send(message);
      if (answer !== null && isRequest(message)) answers.push(limitList(answer, tool.actions));
    }
    if (answers.length === 0) return reply(response, { status: 202, type: "text/plain", body: "" });
    return reply(response, json(200, Array.isArray(parsed) ? answers : answers[0]));
  };

  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) reply(response, json(500, rpcError(null, "The tool broker failed.")));
      else response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const port = (server.address() as AddressInfo).port;
  return {
    token,
    url: name => `http://127.0.0.1:${port}/mcp/${name}`,
    pids: () => [...local.values()].map(one => one.pid()).filter((pid): pid is number => pid !== null),
    close: () => {
      revoked = true;
      for (const one of local.values()) one.stop();
      server.close();
      server.closeAllConnections();
    },
  };
}
