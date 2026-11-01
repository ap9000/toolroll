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
import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { delimiter, isAbsolute, resolve, sep } from "node:path";
import type { ToolSpec } from "./contracts/integration-metadata.js";

/** One tool a launch may use: its values (never leaving this process) and, for research, the only actions it offers. */
export type BrokeredTool = { spec: ToolSpec; values: Record<string, string>; actions?: readonly string[] };

export type BrokerOptions = {
  /** Where a local server's environment comes from (the launch's): only SERVER_ENV's names are taken from it. */
  env?: NodeJS.ProcessEnv;
  omitEnv?: readonly string[];
  /** Toolroll's own settings for a local server (the run's isolated database), passed as they are. */
  pass?: Readonly<Record<string, string>>;
  /** Where a local server starts: a folder the build can't write (never its checkout). */
  cwd?: string;
  /** Folders the build writes (its checkout, its caches): a server whose command, or a path it's given, resolves inside
   * one is never started, since it would run the build's own bytes outside the build's limits. */
  untrusted?: readonly string[];
  /** Why a local server may not start unwrapped (no fence for it here), read when it would; null when it may. */
  unwrapped?: () => string | null;
  /** How a local server is started inside its run's fence, read when it starts (the fence is fixed after the tools). */
  wrap?: () => ((file: string, args: readonly string[], cwd?: string) => { file: string; args: string[]; env?: Record<string, string> }) | null;
};

export type ToolBroker = {
  /** The launch's token: the agent's only key to its tools. */
  token: string;
  url: (name: string) => string;
  /** Its loopback port: the one a confined network leaves reachable for its agent (agent-fence.ts NetworkFence). */
  port: number;
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

/**
 * The first of a server's command and path-like arguments that resolves inside an untrusted folder (a build's checkout
 * or caches), or null. The command is resolved as spawn would: a path against `cwd`, a bare name through PATH; an
 * argument counts when it names an existing path (relative to `cwd`) or is written as one (`./x`, `../x`, `/x`).
 */
export function workspaceBytes(command: string, args: readonly string[], cwd: string | undefined, path: string | undefined, untrusted: readonly string[]): string | null {
  if (untrusted.length === 0) return null;
  const base = cwd ?? process.cwd();
  // Canonical on-disk names, folded where the filesystem ignores case (macOS, Windows), so `/Users/a/CHECKOUT` is the checkout.
  const fold = process.platform === "darwin" || process.platform === "win32" ? (one: string) => one.toLowerCase() : (one: string) => one;
  const real = (one: string): string => { try { return fold(realpathSync.native(one)); } catch { return fold(resolve(one)); } };
  const roots = untrusted.map(real);
  const within = (one: string): boolean => { const at = real(one); return roots.some(root => at === root || at.startsWith(`${root}${sep}`)); };
  // A root's name anywhere in an argument (inline code, a list of paths) counts, however it's spelled.
  const mentions = (arg: string): boolean => { const text = fold(arg); return roots.some(root => text.includes(root)) || untrusted.some(root => text.includes(fold(root))); };
  const located = command.includes("/") || command.includes(sep) ? resolve(base, command)
    : (path ?? "").split(delimiter).filter(Boolean).map(dir => resolve(base, dir, command)).find(one => { try { accessSync(one, constants.X_OK); return true; } catch { return false; } }) ?? null;
  if (located !== null && within(located)) return located;
  // A relative path once meant "in the checkout" (servers started there): it is refused rather than read elsewhere.
  if (!isAbsolute(command) && (command.includes("/") || command.includes(sep))) return `${command} (a relative path)`;
  for (const arg of args) {
    if (mentions(arg)) return `${arg} (names what this build writes)`;
    // A flag's value (`--config=x`, `-c=x`) is checked as its own argument.
    for (const piece of [arg, ...(arg.startsWith("-") && arg.includes("=") ? [arg.slice(arg.indexOf("=") + 1)] : [])]) {
      if (piece.startsWith("./") || piece.startsWith("../")) return `${piece} (a relative path)`;
      const candidate = resolve(base, piece);
      if ((isAbsolute(piece) || existsSync(candidate)) && within(candidate)) return candidate;
    }
  }
  return null;
}

/** A local server, started on first use and spoken to over its stdin and stdout. */
class LocalServer {
  private child: ChildProcess | null = null;
  private initialized = false;
  private buffer = "";
  private next = 1;
  private readonly pending = new Map<number, { id: unknown; done: (message: Message) => void }>();
  private refusal: string | null = null;

  constructor(private readonly tool: BrokeredTool, private readonly options: BrokerOptions) {}

  pid(): number | null { return this.child?.pid ?? null; }

  private start(): ChildProcess | null {
    const env = serverEnv(this.options.env ?? process.env, this.options.omitEnv ?? [], this.options.pass ?? {}, this.tool.values);
    const planted = workspaceBytes(this.tool.spec.command!, this.tool.spec.args, this.options.cwd, env["PATH"], this.options.untrusted ?? []);
    if (planted !== null) { this.refusal = `The tool's server would run ${planted}, inside what this build can write, so it was not started.`; return null; }
    const wrap = this.options.wrap?.() ?? null;
    if (wrap === null) {
      const why = this.options.unwrapped?.() ?? null;
      if (why !== null) { this.refusal = why; return null; }
    }
    const { file, args, env: sandboxEnv } = wrap === null ? { file: this.tool.spec.command!, args: [...this.tool.spec.args], env: undefined } : wrap(this.tool.spec.command!, this.tool.spec.args, this.options.cwd);
    const child = spawn(file, args, { env: { ...env, ...(sandboxEnv ?? {}) }, ...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }), stdio: ["pipe", "pipe", "ignore"], detached: process.platform !== "win32" });
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
    if (this.child === null && this.start() === null) {
      return Promise.resolve(isRequest(message) ? rpcError(message.id, this.refusal ?? "The tool could not start.") : null);
    }
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

/** A relayed answer with a research step's list limited, JSON or event stream alike. An answer that isn't JSON (an
 * accepted notification's empty 202) carries no list and passes as it is. */
function limitAnswer(answer: Answer, actions: readonly string[] | undefined): Answer {
  if (actions === undefined) return answer;
  if (!answer.type.includes("text/event-stream") && jsonOf(answer.body) === undefined) return answer;
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

/** A body's JSON, or undefined when it is empty or not JSON. */
function jsonOf(body: string): Message | Message[] | undefined {
  if (body.trim() === "") return undefined;
  try { return JSON.parse(body) as Message | Message[]; } catch { return undefined; }
}

/**
 * A research batch's relayed answer with the broker's refusals added: always something the agent can read. An event
 * stream gets them as further events; anything else becomes one JSON 200 holding the server's answers, when it gave
 * some as JSON, and the refusals. An empty or non-JSON answer (an accepted notification's 202) is never passed on
 * alone, which would drop the refusals; a request the server left unanswered gets an error instead.
 */
function withRefusals(answer: Answer, allowed: readonly Message[], refusals: readonly Message[]): Answer {
  if (answer.type.includes("text/event-stream")) {
    return { ...answer, body: answer.body + refusals.map(one => `\nevent: message\ndata: ${JSON.stringify(one)}\n\n`).join("") };
  }
  const parsed = answer.status >= 200 && answer.status < 300 ? jsonOf(answer.body) : undefined;
  const upstream = parsed === undefined ? [] : Array.isArray(parsed) ? parsed : [parsed];
  const why = answer.status >= 200 && answer.status < 300 ? "The tool returned an invalid response." : `The tool's server answered HTTP ${answer.status}.`;
  const unanswered = allowed.filter(one => isRequest(one) && !upstream.some(reply => reply !== null && typeof reply === "object" && reply.id === one.id)).map(one => rpcError(one.id, why));
  return { ...answer, status: 200, type: "application/json", body: JSON.stringify([...upstream, ...unanswered, ...refusals]) };
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
      const answer = limitAnswer(await relayWeb(tool, request, JSON.stringify(Array.isArray(parsed) ? allowed : allowed[0])), tool.actions);
      return reply(response, deniedAnswers.length === 0 ? answer : withRefusals(answer, allowed, deniedAnswers));
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
    port,
    pids: () => [...local.values()].map(one => one.pid()).filter((pid): pid is number => pid !== null),
    close: () => {
      revoked = true;
      for (const one of local.values()) one.stop();
      server.close();
      server.closeAllConnections();
    },
  };
}
