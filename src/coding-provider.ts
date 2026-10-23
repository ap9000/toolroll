import { spawn, type ChildProcess } from "node:child_process";
import { TextDecoder } from "node:util";
import { hostname } from "node:os";
import { currentBootId } from "./boot-identity.js";
import { createContainer, currentContainment, type Container } from "./containment.js";
import { processMayBeAlive } from "./process-liveness.js";
import { observeProcessTree, sampleProcessTree, stopProcessTree, type ProcessObservationFailure } from "./process-tree.js";
import { isOwnEnv } from "./names.js";
import { sleep } from "./sleep.js";

/** Read-only recovery witnesses, never authority to signal historical PIDs.
 * macOS ancestry is observational; a missed/failed observation stays fenced.
 */
export type CodingCustody = {
  pid: number | null;
  group: boolean;
  descendants: { pid: number; group: boolean }[];
  observationUnknown: boolean;
  observationFailures?: ProcessObservationFailure[];
  host: string;
  bootId: string | null;
  container?: { backend: string; id: string; identity?: string };
};

export type CodingProviderEvent =
  | { kind: "notification"; method: string; params: Record<string, unknown> }
  | { kind: "request"; id: string | number; method: string; params: Record<string, unknown> }
  | { kind: "custody"; custody: CodingCustody }
  | { kind: "exit"; message: string };

export interface CodingProvider {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  respond(id: string | number, result: unknown): void;
  reject(id: string | number, code: number, message: string): void;
  subscribe(listener: (event: CodingProviderEvent) => void): () => void;
  /** Retain this witness after disconnect. It is not permission to signal a saved PID. */
  processId(): number | null;
  custody(): CodingCustody;
  /** Resolves only after exit is verified; a rejection must keep session custody fenced. */
  close(): Promise<void>;
}

/** A response from the server, distinct from an ambiguous transport failure. */
export class CodingProviderRequestError extends Error {
  readonly outcomeUnknown = false;
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
    this.name = "CodingProviderRequestError";
  }
}

export class CodingProviderDisconnectedError extends Error {
  readonly outcomeUnknown = true;
  constructor(message = "Codex disconnected. The last request may have run; inspect the saved session before continuing.") {
    super(message);
    this.name = "CodingProviderDisconnectedError";
  }
}

export class CodingProviderShutdownError extends Error {
  constructor() {
    super("Codex process cleanup could not be verified. Keep this session paused until its processes are confirmed stopped.");
    this.name = "CodingProviderShutdownError";
  }
}

// A corrupt/noisy child must never grow an unbounded transcript or write queue.
// Fail the connection explicitly; never truncate a valid protocol message.
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_REQUESTS = 128;
const EXIT_GRACE_MS = 1_000;
const own = (object: Record<string, unknown>, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const requestId = (value: unknown): value is number | string => typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));

export function codingEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const invokingSession = new Set([
    "CODEX_INTERNAL_ORIGINATOR_OVERRIDE", "CODEX_SESSION_ID", "CODEX_THREAD_ID",
    "CODEX_SHELL", "CODEX_CI", "CODEX_VERSION", "CODEX_SAGE_BACKFILL_TRACKER_TAB_REUSE",
  ]);
  for (const key of Object.keys(env)) {
    // Preserve native Codex auth, HOME, PATH, CODEX_HOME and project config.
    // A parent desktop session's control pipe and identity do not belong to
    // this independent native client. Keep install/runtime paths such as
    // CODEX_MCP_NODE_PATH. Service credentials stay with the web service.
    if (isOwnEnv(key) || /^(TELEGRAM|SLACK|DISCORD)_.*(TOKEN|SECRET|KEY)$/i.test(key) || /^CODEX_APP_TOOLS_/.test(key) || invokingSession.has(key) || key === "NODE_OPTIONS" || key === "NODE_PATH") delete env[key];
  }
  return env;
}

/** Native app-server JSONL transport. It keeps Codex's normal config, tools and
 * approval rules. There are no request/turn deadlines or automatic retries.
 * Protocol: https://learn.chatgpt.com/docs/app-server (installed CLI schema).
 */
export function createCodexCodingProvider(options: { cwd?: string; command?: string; args?: string[] } = {}): CodingProvider {
  let child: ChildProcess | null = null;
  let container: Container | null = null;
  let initialization: Promise<void> | null = null;
  let shutdown: Promise<void> | null = null;
  let disconnected: CodingProviderDisconnectedError | null = null;
  let closing = false;
  let exited = false;
  let resolveExit: (() => void) | null = null;
  const didExit = new Promise<void>(resolve => { resolveExit = resolve; });
  const listeners = new Set<(event: CodingProviderEvent) => void>();
  const pending = new Map<number | string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const incoming = new Set<number | string>();
  const descendants = new Map<string, { pid: number; group: boolean }>();
  let ancestryUnknown = false;
  const observationFailures: ProcessObservationFailure[] = [];
  const host = hostname();
  // Bind the boot at creation, not when an old snapshot is requested later.
  const bootId = currentBootId();
  let nextId = 0;
  let frameParts: Buffer[] = [];
  let frameBytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });

  function custody(): CodingCustody {
    const pid = child?.pid ?? null;
    return {
      pid, group: pid !== null && process.platform !== "win32",
      descendants: [...descendants.values()].map(one => ({ ...one })),
      observationUnknown: ancestryUnknown, host, bootId,
      ...(observationFailures.length === 0 ? {} : { observationFailures: observationFailures.map(one => ({ ...one })) }),
      ...(container === null ? {} : { container: { backend: container.backend, id: container.id, ...(container.identity === undefined ? {} : { identity: container.identity }) } }),
    };
  }

  function custodyChanged(): void { emit({ kind: "custody", custody: custody() }); }

  function emit(event: CodingProviderEvent): void {
    for (const listener of [...listeners]) {
      try { listener(event); }
      catch {
        // A failed persistence/event consumer cannot silently drop an approval
        // or part of the transcript while the agent continues to mutate files.
        if (event.kind !== "exit") fail("Codex updates could not be recorded. The session was disconnected; inspect its saved result.");
      }
    }
  }

  function disconnect(message: string): void {
    if (disconnected !== null) return;
    disconnected = new CodingProviderDisconnectedError(message);
    for (const one of pending.values()) one.reject(disconnected);
    pending.clear();
    incoming.clear();
    frameParts = [];
    frameBytes = 0;
    emit({ kind: "exit", message });
  }

  function fail(message: string): void {
    disconnect(message);
    // Keep the rejected cleanup promise for close() to expose to the owner.
    // The local catch only prevents an unhandled rejection in an event handler.
    void close().catch(() => {});
  }

  function write(message: Record<string, unknown>): void {
    if (disconnected !== null) throw disconnected;
    if (closing || child?.stdin === null || child === null || child.stdin.destroyed) throw new CodingProviderDisconnectedError();
    let line: string;
    try { line = `${JSON.stringify(message)}\n`; }
    catch { throw new CodingProviderRequestError(-32602, "Codex request must contain JSON-serializable values."); }
    if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new CodingProviderRequestError(-32602, "Codex request exceeds the 16 MiB message limit.");
    if (child.stdin.writableLength + Buffer.byteLength(line) > MAX_FRAME_BYTES * 2) {
      throw new CodingProviderRequestError(-32001, "Codex is still receiving earlier requests. Wait before sending more.");
    }
    try {
      child.stdin.write(line, error => { if (error !== null && error !== undefined) fail("Codex could not receive a request. Its outcome is unknown; inspect the saved session."); });
    } catch {
      fail("Codex could not receive a request. Its outcome is unknown; inspect the saved session.");
      throw disconnected!;
    }
  }

  function send(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (pending.size >= MAX_PENDING_REQUESTS) return Promise.reject(new CodingProviderRequestError(-32001, "Too many pending Codex requests. Wait for a response."));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try { write({ id, method, params }); }
      catch (error) { pending.delete(id); reject(error); }
    });
  }

  function receive(frame: Buffer): void {
    let message: unknown;
    try { message = JSON.parse(decoder.decode(frame)); }
    catch { fail("Codex sent an invalid protocol message. The session was disconnected; inspect its saved result."); return; }
    if (!object(message)) { fail("Codex sent an invalid protocol message."); return; }
    if (own(message, "method")) {
      if (typeof message.method !== "string" || message.method.length === 0 || own(message, "result") || own(message, "error") || (own(message, "params") && !object(message.params))) {
        fail("Codex sent an invalid request or update."); return;
      }
      const params = (message.params ?? {}) as Record<string, unknown>;
      if (!own(message, "id")) {
        if (message.method === "serverRequest/resolved" && requestId(params.requestId)) incoming.delete(params.requestId);
        emit({ kind: "notification", method: message.method, params }); return;
      }
      if (!requestId(message.id) || incoming.has(message.id)) { fail("Codex sent an invalid or duplicate request identifier."); return; }
      if (incoming.size >= MAX_PENDING_REQUESTS) { fail("Codex sent too many unanswered requests. Inspect the saved session before continuing."); return; }
      if (listeners.size === 0) {
        // An absent UI/consumer must never imply consent or leave a tool waiting
        // indefinitely for an approval nobody can see.
        write({ id: message.id, error: { code: -32601, message: "No client is available to handle this request." } });
        return;
      }
      incoming.add(message.id);
      emit({ kind: "request", id: message.id, method: message.method, params });
      return;
    }
    if (!requestId(message.id) || own(message, "result") === own(message, "error") || own(message, "params")) {
      fail("Codex sent an invalid response."); return;
    }
    const request = pending.get(message.id);
    if (request === undefined) { fail("Codex sent a response for an unknown request."); return; }
    if (own(message, "error")) {
      if (!object(message.error) || !Number.isSafeInteger(message.error.code) || typeof message.error.message !== "string") {
        fail("Codex sent an invalid error response."); return;
      }
      pending.delete(message.id);
      request.reject(new CodingProviderRequestError(message.error.code as number, message.error.message, message.error.data));
    } else {
      pending.delete(message.id);
      request.resolve(message.result);
    }
  }

  function read(chunk: Buffer): void {
    if (disconnected !== null) return;
    let start = 0;
    while (start < chunk.length && disconnected === null) {
      const newline = chunk.indexOf(10, start);
      const end = newline === -1 ? chunk.length : newline;
      const part = chunk.subarray(start, end);
      if (frameBytes + part.length > MAX_FRAME_BYTES) { fail("Codex sent a message exceeding the 16 MiB limit. The session was disconnected; no message was truncated."); return; }
      if (part.length) { frameParts.push(part); frameBytes += part.length; }
      if (newline === -1) return;
      const frame = Buffer.concat(frameParts, frameBytes);
      frameParts = []; frameBytes = 0;
      if (frame.length) {
        try { receive(frame); }
        catch { fail("Codex protocol handling failed. Inspect the saved session before continuing."); }
      }
      start = newline + 1;
    }
  }

  async function start(): Promise<void> {
    if (closing || disconnected !== null) throw disconnected ?? new CodingProviderDisconnectedError("This Codex connection is closed.");
    const made = createContainer(currentContainment(), "coding-session");
    if ("refused" in made) throw new CodingProviderRequestError(-32000, made.refused);
    container = made.container;
    const command = options.command ?? "codex";
    const args = options.args ?? ["app-server", "--listen", "stdio://"];
    let launch: ReturnType<Container["launch"]> | undefined;
    try {
      launch = container?.launch(command, args);
      child = spawn(launch?.file ?? command, launch?.args ?? args, {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        env: codingEnvironment(),
        shell: false, windowsHide: true, detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe", ...(launch?.extraStdio ?? [])],
      });
    } catch {
      container?.release();
      container = null;
      throw new CodingProviderRequestError(-32000, "Codex could not start. Check that the Codex CLI is installed and the project directory exists.");
    }
    if (container === null) {
      // The existing observer has no Windows ancestry backend. A plain root
      // PID there cannot establish tool-process exit without a native job.
      if (process.platform === "win32") ancestryUnknown = true;
      observeProcessTree(child, {
        onDescendant: (pid, group) => { descendants.set(`${pid}:${group}`, { pid, group }); custodyChanged(); },
        onDescendantExit: (pid, group) => { descendants.delete(`${pid}:${group}`); custodyChanged(); },
        onObservationFailure: failure => { observationFailures.push({ ...failure }); custodyChanged(); },
        onUnknown: () => { if (!ancestryUnknown) { ancestryUnknown = true; custodyChanged(); } },
      });
    }
    child.stdout!.on("data", read);
    child.stdout!.once("end", () => {
      if (disconnected === null && !closing) fail(frameBytes ? "Codex disconnected with an incomplete protocol message. The request outcome is unknown." : "Codex closed its connection. Inspect the saved session before continuing.");
    });
    // Drain diagnostics without retaining or forwarding paths, prompts or credentials.
    child.stderr!.resume();
    child.stdin!.on("error", () => fail("Codex input disconnected. The last request may have run; inspect the saved session."));
    child.stdout!.on("error", () => fail("Codex updates disconnected. Inspect the saved session before continuing."));
    child.stderr!.on("error", () => {});
    child.once("error", () => fail("Codex could not start or its process failed. Check the installed CLI and project directory."));
    child.once("exit", () => {
      exited = true; resolveExit!();
      if (!closing) fail("Codex exited. The last request may have run; inspect the saved session before continuing.");
    });
    // Failed spawn emits close without exit.
    child.once("close", () => { exited = true; resolveExit!(); });
    // Publish the owned handle before initialization can start a native task.
    // Even a failed initialize must leave its process/container witness behind.
    custodyChanged();
    if (launch !== undefined && child.pid !== undefined) {
      const attached = await launch.attach(child);
      if (!attached.ok) throw new CodingProviderRequestError(-32000, "Codex could not enter the required process container.");
    }
    await send("initialize", {
      clientInfo: { name: "toolroll", title: "Toolroll", version: "0.4.3" },
      capabilities: { experimentalApi: true },
    });
    write({ method: "initialized", params: {} });
  }

  async function waitForExit(milliseconds: number): Promise<boolean> {
    if (exited) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([didExit, new Promise<void>(resolve => { timer = setTimeout(resolve, milliseconds); })]);
    if (timer !== undefined) clearTimeout(timer);
    return exited;
  }

  async function stop(): Promise<void> {
    closing = true;
    disconnect("Codex connection closed. Pending request outcomes must be checked in the saved session.");
    const owned = child;
    if (owned === null) return;
    sampleProcessTree(owned);
    owned.stdin?.end();
    if (!await waitForExit(EXIT_GRACE_MS)) {
      sampleProcessTree(owned);
      owned.kill("SIGTERM");
      if (!await waitForExit(EXIT_GRACE_MS)) {
        if (container !== null) await container.kill();
        else if (!stopProcessTree(owned)) owned.kill("SIGKILL");
        await waitForExit(EXIT_GRACE_MS);
      }
    }
    let clean = exited;
    if (container !== null) {
      clean = await container.kill() && clean;
      if (clean) container.release();
    } else {
      // Root exit cannot prove escaped tool-process exit. Do not signal saved
      // descendants after ancestry is lost or silently release session custody.
      const absent = (): boolean => (owned.pid === undefined || !processMayBeAlive(owned.pid, process.platform !== "win32")) && [...descendants.values()].every(({ pid, group }) => !processMayBeAlive(pid, group));
      const until = Date.now() + EXIT_GRACE_MS;
      while (!ancestryUnknown && !absent() && Date.now() < until) await sleep(25);
      clean = clean && !ancestryUnknown && absent();
    }
    if (!clean) throw new CodingProviderShutdownError();
    owned.stdout?.destroy();
    owned.stderr?.destroy();
  }

  function close(): Promise<void> {
    if (shutdown === null) {
      closing = true;
      // Assign before invoking callbacks: an exit listener may also call close.
      shutdown = Promise.resolve().then(stop);
    }
    return shutdown;
  }

  return {
    async request(method, params) {
      if (typeof method !== "string" || method.length === 0 || method === "initialize" || method === "initialized" || !object(params)) throw new CodingProviderRequestError(-32602, "Choose a valid Codex request method and parameters.");
      if (closing || disconnected !== null) throw disconnected ?? new CodingProviderDisconnectedError("This Codex connection is closed.");
      initialization ??= start().catch(error => { fail("Codex initialization failed. Check the installed CLI before opening another connection."); throw error; });
      await initialization;
      return send(method, params);
    },
    respond(id, result) {
      if (!incoming.has(id)) throw new CodingProviderRequestError(-32600, "This Codex request is no longer waiting for a response.");
      if (result === undefined) throw new CodingProviderRequestError(-32602, "A Codex response must contain a result.");
      write({ id, result });
      incoming.delete(id);
    },
    reject(id, code, message) {
      if (!incoming.has(id)) throw new CodingProviderRequestError(-32600, "This Codex request is no longer waiting for a response.");
      if (!Number.isSafeInteger(code) || !message.trim()) throw new CodingProviderRequestError(-32602, "A Codex rejection must contain an error code and message.");
      write({ id, error: { code, message } });
      incoming.delete(id);
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    processId() { return child?.pid ?? null; },
    custody,
    close,
  };
}
