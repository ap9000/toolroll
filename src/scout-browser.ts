/**
 * The scout's browser (run 2356, review 828). Chrome's own sandbox can't start inside the agent fence (nested
 * Seatbelt: every page crashed, even example.com), and switching that sandbox off is not an option. So the browser
 * tool runs beside the agent instead of under it: the worker starts the pinned Playwright MCP itself, outside the
 * fence with Chrome's sandbox on, serving its HTTP transport on a random loopback port, and the fenced agent gets
 * only that URL. Every page still goes through the scout's public-web-only proxy, and screenshots land in the run's
 * image folder. Before research begins the browser is checked once, through that proxy, on a public page, with one
 * time limit for the whole check; a browser that can't start is said in one line and the scout researches
 * without it.
 *
 * Playwright MCP 0.0.82 has no per-client token for its HTTP transport; it answers only on 127.0.0.1, only for
 * that host name (its own host check), and only while this run's scout does.
 */
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { connect, createServer } from "node:net";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export type BrowserLaunch = { command: string; args: readonly string[] };
export type ScoutBrowserServer = { url: string; close: () => Promise<void> };
export type BrowserStart = { ok: true; server: ScoutBrowserServer } | { ok: false; reason: string };
export type BrowserStarter = (launch: BrowserLaunch, options: BrowserOptions) => Promise<BrowserStart>;
export type BrowserOptions = {
  /** The browser tool's environment: the scout's own, its proxy settings included. */
  env: Record<string, string | undefined>;
  /** Where it saves screenshots (its `--output-dir`), also its working folder. */
  folder: string;
  /** The whole start and check, from spawn to screenshot (review 828: at most 60 seconds). */
  timeoutMs?: number;
};

/** The public page the check opens through the scout's proxy. */
export const PREFLIGHT_PAGE = "https://example.com/";
const PREFLIGHT_TIMEOUT_MS = 60_000;
const CLOSE_GRACE_MS = 5_000;
const IMAGE = /\.(png|jpe?g)$/i;

/** How a scout gets its browser: started for real, or, for a test's stub agent, a placeholder that starts nothing. */
export function starterFor(agentInjected: boolean): BrowserStarter {
  return agentInjected ? unstarted : startScoutBrowser;
}

const unstarted: BrowserStarter = async () => ({ ok: true, server: { url: "http://127.0.0.1:9/mcp", close: async () => undefined } });

/** Start the browser tool outside the fence and check it opens a public page and saves a screenshot. */
export async function startScoutBrowser(launch: BrowserLaunch, options: BrowserOptions): Promise<BrowserStart> {
  const timeoutMs = options.timeoutMs ?? PREFLIGHT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const late = `the browser did not start within ${Math.round(timeoutMs / 1000)} seconds`;
  const served = await serveBrowser(launch, options, deadline, late);
  if (!served.ok) return served;
  const before = new Set(entries(options.folder));
  const session = openSession(served.server.url, deadline, late);
  try {
    let checked = await preflight(session);
    if (checked.ok && !entries(options.folder).some(name => !before.has(name) && IMAGE.test(name))) checked = { ok: false, reason: "the browser saved no screenshot" };
    if (!checked.ok) {
      await served.server.close();
      return checked;
    }
    return served;
  } finally {
    await session.close();
    // The check's own screenshot and page notes are not the scout's.
    for (const name of entries(options.folder)) if (!before.has(name)) rmSync(join(options.folder, name), { recursive: true, force: true });
  }
}

async function preflight(session: McpSession): Promise<{ ok: true } | { ok: false; reason: string }> {
  const started = await session.start();
  if (!started.ok) return started;
  for (const [tool, input] of [["browser_navigate", { url: PREFLIGHT_PAGE }], ["browser_take_screenshot", { type: "png" }]] as const) {
    const done = await session.call(tool, input);
    if (!done.ok) return done;
  }
  return { ok: true };
}

/** Spawn the tool with its HTTP transport on a free 127.0.0.1 port and wait until it answers there. */
async function serveBrowser(launch: BrowserLaunch, options: BrowserOptions, deadline: number, late: string): Promise<BrowserStart> {
  const port = await freePort();
  const child = spawn(launch.command, [...launch.args, "--host", "127.0.0.1", "--port", String(port), "--allowed-hosts", `127.0.0.1:${port}`], {
    cwd: options.folder,
    env: options.env,
    stdio: ["ignore", "ignore", "pipe"],
    detached: process.platform !== "win32",
  });
  let stderr = "";
  let stopped: string | null = null;
  child.on("error", error => { stopped ??= `the browser tool could not run (${error.message})`; });
  child.on("exit", (code, sig) => { stopped ??= `the browser tool stopped (${sig ?? `exit ${code}`})${lastLine(stderr) === "" ? "" : `: ${lastLine(stderr)}`}`; });
  child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-4_000); });
  const close = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(done => child.once("exit", () => done()));
      signal(child.pid, "SIGTERM");
      await Promise.race([exited, new Promise<void>(done => setTimeout(done, CLOSE_GRACE_MS).unref())]);
    }
    // Its browser and helpers go with it.
    signal(child.pid, "SIGKILL");
  };
  // First runs download the pinned tool; it listens once it is ready.
  while (stopped === null && Date.now() < deadline && !(await answers(port))) await new Promise(done => setTimeout(done, 250));
  if (stopped !== null || Date.now() >= deadline) {
    const reason = stopped ?? late;
    await close();
    return { ok: false, reason };
  }
  return { ok: true, server: { url: `http://127.0.0.1:${port}/mcp`, close } };
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => (typeof address === "object" && address !== null ? done(address.port) : fail(new Error("no free port"))));
    });
  });
}

function answers(port: number): Promise<boolean> {
  return new Promise(done => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(1_000);
    socket.once("connect", () => { socket.destroy(); done(true); });
    socket.once("error", () => done(false));
    socket.once("timeout", () => { socket.destroy(); done(false); });
  });
}

function signal(pid: number | undefined, name: NodeJS.Signals): void {
  if (pid === undefined) return;
  try { process.kill(process.platform === "win32" ? pid : -pid, name); } catch { /* already gone */ }
}

function entries(folder: string): string[] {
  try { return readdirSync(folder); } catch { return []; }
}

type Answer = { ok: true; message: Record<string, unknown> } | { ok: false; reason: string };
export type McpSession = {
  start: () => Promise<{ ok: true } | { ok: false; reason: string }>;
  call: (tool: string, input: Record<string, unknown>) => Promise<{ ok: true; result: Record<string, unknown> } | { ok: false; reason: string }>;
  close: () => Promise<void>;
};

/** A client of the browser's HTTP transport, as the scout's own is: every step answers by `deadline`, or says why not. */
export function openSession(url: string, deadline: number, late: string): McpSession {
  let session: string | null = null;
  let next = 0;
  const post = (body: Record<string, unknown>, method = "POST"): Promise<{ ok: true; status: number; headers: Record<string, unknown>; text: string } | { ok: false; reason: string }> =>
    new Promise(done => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return done({ ok: false, reason: late });
      const headers: Record<string, string> = { accept: "application/json, text/event-stream", "content-type": "application/json" };
      if (session !== null) headers["mcp-session-id"] = session;
      const sent = httpRequest(url, { method, headers }, answer => {
        let text = "";
        answer.on("data", chunk => { text += String(chunk); });
        answer.on("end", () => { clearTimeout(timer); done({ ok: true, status: answer.statusCode ?? 0, headers: answer.headers, text }); });
        answer.on("error", error => { clearTimeout(timer); done({ ok: false, reason: `the browser stopped answering (${error.message})` }); });
      });
      const timer = setTimeout(() => { sent.destroy(); done({ ok: false, reason: late }); }, remaining);
      sent.on("error", error => { clearTimeout(timer); done({ ok: false, reason: `the browser stopped answering (${error.message})` }); });
      sent.end(method === "POST" ? JSON.stringify(body) : undefined);
    });
  const request = async (method: string, params: unknown): Promise<Answer> => {
    const id = ++next;
    const sent = await post({ jsonrpc: "2.0", id, method, params });
    if (!sent.ok) return sent;
    const message = messages(sent.text).find(one => one["id"] === id);
    if (message === undefined) return { ok: false, reason: `the browser tool answered ${sent.status}${sent.text.trim() === "" ? "" : `: ${oneLine(sent.text)}`}` };
    const header = sent.headers["mcp-session-id"];
    if (typeof header === "string") session = header;
    return { ok: true, message };
  };
  return {
    start: async () => {
      const hello = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "toolroll-scout-preflight", version: "1" } });
      if (!hello.ok) return hello;
      if (hello.message["error"] !== undefined) return { ok: false, reason: `the browser tool refused to start: ${errorText(hello.message)}` };
      const ready = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
      return ready.ok ? { ok: true } : ready;
    },
    call: async (tool, input) => {
      const answer = await request("tools/call", { name: tool, arguments: input });
      if (!answer.ok) return answer;
      const failed = toolFailure(answer.message);
      return failed === null ? { ok: true, result: (answer.message["result"] ?? {}) as Record<string, unknown> } : { ok: false, reason: failed };
    },
    close: async () => {
      // Ending the session closes its browser context.
      if (session !== null) await post({}, "DELETE");
    },
  };
}

/** The JSON-RPC messages in an answer: a plain JSON body, or the data lines of an event stream. */
function messages(text: string): Record<string, unknown>[] {
  const bodies = text.trimStart().startsWith("{") ? [text] : text.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5));
  return bodies.flatMap(body => {
    try {
      const parsed = JSON.parse(body) as unknown;
      return typeof parsed === "object" && parsed !== null ? [parsed as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });
}

/** Why a tool call failed, in one line, or null when it worked. */
function toolFailure(answer: Record<string, unknown>): string | null {
  if (answer["error"] !== undefined) return errorText(answer);
  const result = answer["result"] as { isError?: unknown; content?: { text?: unknown }[] } | undefined;
  if (result?.isError !== true) return null;
  const text = result.content?.map(one => (typeof one.text === "string" ? one.text : "")).join("\n") ?? "";
  const line = text.split("\n").map(one => one.replace(/^#+\s*Error\s*$/i, "").replace(/^Error:\s*/, "").replace(/^browserBackend\.callTool:\s*/, "").trim()).find(one => one !== "");
  return oneLine(line ?? "unknown error");
}

function errorText(answer: Record<string, unknown>): string {
  const error = answer["error"] as { message?: unknown } | undefined;
  return oneLine(typeof error?.message === "string" ? error.message : "unknown error");
}

function lastLine(text: string): string {
  return oneLine(text.trim().split("\n").at(-1) ?? "");
}

function oneLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim().slice(0, 200);
}
