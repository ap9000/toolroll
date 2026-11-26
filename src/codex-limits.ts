/** Codex's plan limits and account, read from its app server (v105): kept apart from provider-limits.ts so the run
 * pipeline that notes Claude's readings never loads Codex's transport. */
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { codingEnvironment } from "./coding-provider.js";
import { codexLimitsOf, record, type LimitReading } from "./provider-limits.js";
import { refreshSubscriptions, type SubscriptionReaders } from "./subscription-usage.js";
import { directChatRunning, onPlanLimitsViewed, planLimitsWanted, type ProcessAlive } from "./plan-limits-demand.js";
import { billingOf, type Billing } from "./spend.js";
import type { Store } from "./store.js";
import { envValue } from "./names.js";

/** How Codex says its account bills (`account/read`'s account): a ChatGPT sign-in is its plan unless the plan itself is
 * billed by use; a key or Amazon Bedrock is a key. */
function accountBilling(account: Record<string, unknown> | null): Billing | undefined {
  const type = account?.["type"];
  if (typeof type !== "string") return undefined;
  if (type.toLowerCase() === "chatgpt") return typeof account!["planType"] === "string" && /usage.?based/i.test(account!["planType"]) ? "api-key" : "subscription";
  return /api.?key|bedrock/i.test(type) ? "api-key" : undefined;
}

/** End the app server and everything it started: its process group, then a kill after a grace period. */
function end(child: ChildProcess, graceMs: number): Promise<void> {
  return new Promise(done => {
    const signal = (name: NodeJS.Signals) => {
      try { if (child.pid !== undefined && process.platform !== "win32") process.kill(-child.pid, name); else child.kill(name); } catch { /* gone */ }
    };
    // The leader may be gone while something it started lives on: the group hears it either way.
    if (child.exitCode !== null || child.signalCode !== null) { signal("SIGKILL"); return done(); }
    const hard = setTimeout(() => { signal("SIGKILL"); setTimeout(done, 1_000).unref?.(); }, graceMs);
    hard.unref?.();
    child.once("exit", () => { clearTimeout(hard); done(); });
    signal("SIGTERM");
  });
}

/** Ask Codex for its limits: its app server over stdio, in its own process group and a scratch folder, one read,
 * then gone (killed if it lingers). Resolves once the process has ended; null when Codex isn't installed or doesn't
 * answer in time. A key account has no windows but says so (`billing`). */
export function readCodexLimits(options: { command?: string; timeoutMs?: number; graceMs?: number } = {}): Promise<LimitReading | null> {
  return new Promise(resolve => {
    const env = codingEnvironment();
    // Its plan's limits: a key in the environment would make it an API account.
    for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY"]) delete env[key];
    let child: ChildProcess;
    try {
      child = spawn(options.command ?? "codex", ["app-server", "--listen", "stdio://"], {
        cwd: tmpdir(), env, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    let buffered = "";
    let billing: Billing | undefined;
    let limits: LimitReading | null | undefined;
    let accountRead = false;
    const finish = (reading: LimitReading | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const answer = reading ?? (billing === undefined ? null : { provider: "codex" as const, plan: null, windows: [], partial: true, billing });
      void end(child, options.graceMs ?? 3_000).then(() => resolve(answer === null || billing === undefined ? answer : { ...answer, billing }));
    };
    const timer = setTimeout(() => finish(limits ?? null), options.timeoutMs ?? 15_000);
    child.once("error", () => finish(null));
    child.once("exit", () => finish(null));
    child.stdin?.on("error", () => finish(null));
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffered += chunk;
      if (buffered.length > 256 * 1024) return finish(null);
      let newline: number;
      while ((newline = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        let message: Record<string, unknown> | null = null;
        try { message = record(JSON.parse(line)); } catch { continue; }
        if (message?.["id"] === 1) {
          child.stdin?.write([{ jsonrpc: "2.0", method: "initialized" }, { jsonrpc: "2.0", id: 2, method: "account/rateLimits/read" },
            { jsonrpc: "2.0", id: 3, method: "account/read", params: {} }].map(one => `${JSON.stringify(one)}\n`).join(""));
        } else if (message?.["id"] === 2) {
          limits = message["error"] === undefined ? codexLimitsOf(message["result"]) : null;
        } else if (message?.["id"] === 3) {
          accountRead = true;
          billing = accountBilling(record(record(message["result"])?.["account"]));
        }
        if (limits !== undefined && accountRead) finish(limits);
      }
    });
    child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "toolroll", version: "1" } } })}\n`);
  });
}

/** The loop beside the console: plan limits (Codex's from its app server, then Claude's and Antigravity's when stale)
 * every five minutes, but only while they are wanted (plan-limits-demand.ts): an agent actually running, or a person
 * opened a page that shows them in the last ten minutes. An idle Toolroll asks no provider anything (everyday 9, B3:
 * Claude's read is a real model turn). Never in tests, the demo, or the end-to-end harness (which runs with the person's
 * own sign-in), and never while a Codex build is running (both would refresh the same sign-in). One read at a time: the
 * next waits for the last process to end. */
export function startCodexLimits(store: Store, signedIn: () => Promise<boolean>, everyMs = 5 * 60_000): () => void {
  if (process.env["VITEST"] !== undefined || envValue(process.env, "NO_PLAN_PROBE") !== undefined || store.isDemo()) return () => {};
  return scheduleLimitsLoop(store, { signedIn }, everyMs);
}

/**
 * One pass of the limits loop: Codex's app server is started only for a Codex signed in to its ChatGPT plan (eight
 * stranger 2: a signed-out Codex was started every five minutes). `signedIn` is the cached sign-in check (its status
 * command, at most every few minutes while signed out: provider-connection.ts), asked only once nothing else stands in
 * the way. A Codex run started in the last few hours and not finished keeps the sign-in to itself.
 */
export async function codexLimitsPass(store: Store, seams: { signedIn: () => Promise<boolean>; stopped?: () => boolean; read?: () => Promise<LimitReading | null>;
  /** Asked again right before the read (the sign-in check awaits): false (the work ended meanwhile) starts nothing. */
  stillWanted?: () => boolean }): Promise<"read" | "skipped"> {
  if (billingOf("codex") !== "subscription") return "skipped";
  const recent = new Date(Date.now() - 6 * 3_600_000).toISOString();
  if (store.handle.prepare("SELECT 1 AS live FROM run WHERE provider = 'codex' AND outcome IS NULL AND started_at > ? LIMIT 1").get(recent) !== undefined) return "skipped";
  if (directChatRunning(store, "codex", new Date())) return "skipped";
  if (!(await seams.signedIn())) return "skipped";
  if (seams.stillWanted?.() === false) return "skipped";
  const reading = await (seams.read ?? (() => readCodexLimits()))();
  if (reading !== null && seams.stopped?.() !== true) store.recordProviderLimits(reading, new Date());
  return "read";
}

/**
 * Whether Codex is signed in to its plan right now, for the moment before its app server starts: the cached answer
 * first (so a signed-out Codex keeps its back-off and nothing is asked), then, only when that says signed in, a fresh
 * status check awaited here (a sign-out since the cached answer is seen before anything starts).
 */
export async function codexSignedInNow(check: (provider: "codex", fresh?: boolean) => Promise<{ state: string }>): Promise<boolean> {
  if ((await check("codex")).state !== "connected") return false;
  return (await check("codex", true)).state === "connected";
}

/** A page open starts a read at once, but at most once a minute (a person paging through Spend asks once). */
const VIEWED_PASS_GAP_MS = 60_000;

/** The limits loop itself, without startCodexLimits' guards: the seams replace each provider read (tests). */
export function scheduleLimitsLoop(store: Store, seams: { signedIn: () => Promise<boolean>; readCodex?: () => Promise<LimitReading | null>; readers?: SubscriptionReaders; clock?: () => Date;
  /** The process check demand reads (tests); otherwise this computer's process table. */
  alive?: ProcessAlive }, everyMs = 5 * 60_000): () => void {
  const clock = seams.clock ?? (() => new Date());
  let stopped = false, busy = false, lastPass = -Infinity;
  const pass = async (viewed: boolean) => {
    if (stopped || busy) return;
    const now = clock();
    if (!planLimitsWanted(store, now, seams.alive)) return;
    if (viewed && now.getTime() - lastPass < VIEWED_PASS_GAP_MS) return;
    busy = true;
    lastPass = now.getTime();
    try {
      // Demand is read again after every await and right before each provider starts (B3 round 1, finding 5): work that
      // ended while Codex's sign-in or limits were read starts no Claude probe.
      const stillWanted = () => !stopped && planLimitsWanted(store, clock(), seams.alive);
      await codexLimitsPass(store, { signedIn: seams.signedIn, stopped: () => stopped, stillWanted, ...(seams.readCodex === undefined ? {} : { read: seams.readCodex }) });
      if (stillWanted()) {
        await refreshSubscriptions(store, store.databaseFile(), { skipCodex: true, now: clock(), stillWanted, ...(seams.readers === undefined ? {} : { readers: seams.readers }) });
      }
    } catch {
      // The next pass tries again.
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void pass(false), everyMs);
  timer.unref?.();
  const first = setTimeout(() => void pass(false), 10_000);
  first.unref?.();
  const stopListening = onPlanLimitsViewed(store, () => void pass(true));
  return () => { stopped = true; clearInterval(timer); clearTimeout(first); stopListening(); };
}
