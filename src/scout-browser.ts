/**
 * The scout's browser preflight: before a scout starts researching, its own browser is started once, exactly as
 * the scout will get it (the same command and arguments, its proxy, the agent fence), opens a blank page and takes
 * a screenshot. A browser that can't is reported in one line, and the scout researches without one instead of
 * finding out page after page (run 2356: Chrome's own sandbox can't start inside the fence, so every page crashed).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linuxFenceAvailable, linuxFenced, macosFenceAvailable, macosFenced } from "./agent-fence.js";

export type BrowserLaunch = { command: string; args: readonly string[] };
export type PreflightResult = { ok: true } | { ok: false; reason: string };
export type BrowserPreflight = (launch: BrowserLaunch, options: PreflightOptions) => Promise<PreflightResult>;
export type PreflightOptions = {
  /** The scout's own environment: its MCP servers inherit it, proxy settings included. */
  env: Record<string, string | undefined>;
  /** The agent fence the scout runs inside; empty runs the check unfenced, as the scout would be. */
  fence: readonly string[];
  cwd: string;
  timeoutMs?: number;
};

/** First runs download the pinned tool, so this is generous; a browser that starts answers in seconds. */
const PREFLIGHT_TIMEOUT_MS = 120_000;
const CLOSE_GRACE_MS = 5_000;

/** The check a scout runs, or null to skip it: a test's stub agent never starts a real browser. */
export function preflightFor(agentInjected: boolean): BrowserPreflight | null {
  return agentInjected ? null : preflightBrowser;
}

/** Start the browser, open about:blank and screenshot it into a throwaway folder. */
export async function preflightBrowser(launch: BrowserLaunch, options: PreflightOptions): Promise<PreflightResult> {
  const scratch = mkdtempSync(join(tmpdir(), "toolroll-scout-preflight-"));
  const session = openBrowserSession({ command: launch.command, args: withOutputDir(launch.args, scratch) }, options);
  try {
    const started = await session.start();
    if (!started.ok) return started;
    for (const [tool, input] of [["browser_navigate", { url: "about:blank" }], ["browser_take_screenshot", {}]] as const) {
      const done = await session.call(tool, input);
      if (!done.ok) return done;
    }
    return readdirSync(scratch).some(name => /\.(png|jpe?g)$/i.test(name)) ? { ok: true } : { ok: false, reason: "the browser took no screenshot" };
  } finally {
    await session.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}

export type BrowserSession = {
  start: () => Promise<PreflightResult>;
  call: (tool: string, input: Record<string, unknown>) => Promise<PreflightResult>;
  close: () => Promise<void>;
};

/** The browser tool as a scout's MCP client sees it: spawned inside the fence, spoken to over stdio. Every step
 * answers within the time limit, or with why the tool stopped. */
export function openBrowserSession(launch: BrowserLaunch, options: PreflightOptions): BrowserSession {
  let file = launch.command;
  let argv = [...launch.args];
  if (options.fence.length > 0 && macosFenceAvailable()) ({ file, args: argv } = macosFenced(file, argv, options.fence));
  else if (options.fence.length > 0 && linuxFenceAvailable()) ({ file, args: argv } = linuxFenced(file, argv, options.fence));

  const child = spawn(file, argv, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
  let stderr = "";
  let buffer = "";
  const waiting = new Map<number, (message: Record<string, unknown>) => void>();
  let stopped: string | null = null;
  const watchers = new Set<(reason: string) => void>();
  const stop = (reason: string): void => {
    stopped ??= reason;
    for (const watcher of watchers) watcher(stopped);
  };
  child.on("error", error => stop(`the browser tool could not run (${error.message})`));
  child.on("exit", (code, signal) => stop(`the browser tool stopped (${signal ?? `exit ${code}`})${lastLine(stderr) === "" ? "" : `: ${lastLine(stderr)}`}`));
  child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-4_000); });
  child.stdin.on("error", () => undefined);
  child.stdout.on("data", chunk => {
    buffer += String(chunk);
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      try {
        const message = JSON.parse(line) as Record<string, unknown>;
        if (typeof message["id"] === "number") waiting.get(message["id"])?.(message);
      } catch {
        // Not a protocol line.
      }
    }
  });
  const timeoutMs = options.timeoutMs ?? PREFLIGHT_TIMEOUT_MS;
  let next = 0;
  const request = (method: string, params: unknown): Promise<{ ok: true; message: Record<string, unknown> } | { ok: false; reason: string }> => {
    if (stopped !== null) return Promise.resolve({ ok: false, reason: stopped });
    const id = ++next;
    return new Promise(done => {
      const finish = (value: { ok: true; message: Record<string, unknown> } | { ok: false; reason: string }): void => {
        clearTimeout(timer);
        waiting.delete(id);
        watchers.delete(onStop);
        done(value);
      };
      const onStop = (reason: string): void => finish({ ok: false, reason });
      const timer = setTimeout(() => finish({ ok: false, reason: `the browser did not answer within ${Math.round(timeoutMs / 1000)} seconds` }), timeoutMs);
      watchers.add(onStop);
      waiting.set(id, message => finish({ ok: true, message }));
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  };
  return {
    start: async () => {
      const hello = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "toolroll-scout-preflight", version: "1" } });
      if (!hello.ok) return hello;
      if (hello.message["error"] !== undefined) return { ok: false, reason: `the browser tool refused to start: ${errorText(hello.message)}` };
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      return { ok: true };
    },
    call: async (tool, input) => {
      const answer = await request("tools/call", { name: tool, arguments: input });
      if (!answer.ok) return answer;
      const failed = toolFailure(answer.message);
      return failed === null ? { ok: true } : { ok: false, reason: failed };
    },
    close: async () => {
      watchers.clear();
      stopped ??= "closed";
      // Ending its input lets the tool close its browser and remove its profile; then the whole tree goes.
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>(done => child.once("exit", () => done()));
        child.stdin.end();
        await Promise.race([exited, new Promise<void>(done => setTimeout(done, CLOSE_GRACE_MS).unref())]);
      }
      try { if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    },
  };
}

/** The launch with its output folder swapped for the preflight's own, so nothing lands in the scout's. */
function withOutputDir(args: readonly string[], folder: string): string[] {
  const at = args.indexOf("--output-dir");
  return at < 0 ? [...args, "--output-dir", folder] : args.map((arg, index) => (index === at + 1 ? folder : arg));
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
