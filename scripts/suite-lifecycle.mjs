#!/usr/bin/env node
/**
 * Suites clean up after themselves, whatever way they end: passed, failed, timed out or interrupted.
 *
 * Each suite (the unit tests, a journey group, a release check part) runs in a process group of its own with a temp
 * root of its own as TMPDIR. When it ends, its whole group is stopped (SIGTERM, then SIGKILL after the grace) and
 * awaited, and its temp root removed. A timeout ends it the same way. SIGINT, SIGTERM or SIGHUP to the runner stops
 * every suite it runs and removes every root before it exits; an exit by any other road (process.exit, a throw) kills
 * what this process started and removes the roots synchronously. `--keep` (or `keep: true`) keeps a root on purpose.
 *
 * A temp root holds `.metadata_never_index` (Spotlight leaves it alone) and `.toolroll-temp-owner` (who made it: the
 * plane may stop an orphan running from it once that owner is gone, and sweeps a root nothing touched for a day).
 *
 *   node scripts/suite-lifecycle.mjs [--timeout <seconds>] [--grace <seconds>] [--keep] [--prefix <name>] -- <command> [args…]
 *
 * runs one suite that way, its output passed through; exits with the suite's code (124 when it timed out, 128 + n
 * for a signal).
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const OWNER_FILE = ".toolroll-temp-owner";
export const NEVER_INDEX = ".metadata_never_index";
/** How long a suite's group has after SIGTERM before SIGKILL. */
export const GRACE_MS = 5_000;
const SIGNAL_CODES = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

const sleep = ms => new Promise(done => setTimeout(done, ms));
/** Roots to remove when this process ends (path → keep). */
const roots = new Map();
/** Process groups this process leads suites in, and each one's grace. */
const groups = new Map();

/** A temp root of this process's own, marked; removed when the process ends unless `keep`. */
export function makeTempRoot(prefix, { keep = false, parent = tmpdir() } = {}) {
  const root = mkdtempSync(join(parent, prefix));
  try { writeFileSync(join(root, NEVER_INDEX), ""); } catch { /* only Spotlight minds */ }
  try { writeFileSync(join(root, OWNER_FILE), `${JSON.stringify({ pid: process.pid, startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString() })}\n`); } catch { /* the day-old sweep still finds it */ }
  roots.set(root, keep);
  installHandlers();
  return root;
}

/**
 * Remove a root now (unless kept), and forget it. Whatever still runs from inside it (its working folder is there:
 * a helper a test forgot to stop, a server started in a fixture repo) is killed first: nothing else runs from a root
 * this process made.
 */
export function removeRoot(root) {
  const keep = roots.get(root) === true;
  roots.delete(root);
  if (keep) return;
  for (const pid of runningInside(root)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

/** Pids whose working folder is `root` or inside it (never this process or its ancestors): /proc on Linux, lsof on macOS. */
export function runningInside(root) {
  if (process.platform === "win32") return [];
  const bases = new Set([root]);
  try { bases.add(realpathSync(root)); } catch { return []; }
  const inside = cwd => [...bases].some(base => cwd === base || cwd.startsWith(`${base}/`));
  const found = [];
  if (process.platform === "linux") {
    let names = [];
    try { names = readdirSync("/proc").filter(name => /^\d+$/.test(name)); } catch { return []; }
    for (const name of names) { try { if (inside(readlinkSync(`/proc/${name}/cwd`))) found.push(Number(name)); } catch { /* gone, or not ours */ } }
  } else {
    let text = "";
    try { text = execFileSync("lsof", ["-nP", "-d", "cwd", "-Fpn"], { encoding: "utf8", timeout: 20_000, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }); }
    catch (error) { text = String(error.stdout ?? ""); }
    let pid = 0;
    for (const line of text.split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      else if (line.startsWith("n") && pid > 0 && inside(line.slice(1))) found.push(pid);
    }
  }
  const mine = new Set([process.pid, process.ppid]);
  return [...new Set(found)].filter(pid => !mine.has(pid));
}

/** Remove `root` when this process ends, however it ends (unless `keep`): for a temp root made some other way. */
export function removeOnExit(root, { keep = false } = {}) {
  roots.set(root, keep);
  installHandlers();
}

export function groupAlive(group) {
  try { process.kill(-group, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

function signalGroup(group, signal) {
  try { process.kill(-group, signal); } catch { /* already gone */ }
}

/** Stop a process group: SIGTERM, SIGKILL after the grace, then wait (a few seconds more) until it is gone. True when gone. */
export async function stopGroup(group, { graceMs = GRACE_MS } = {}) {
  if (!groupAlive(group)) return true;
  signalGroup(group, "SIGTERM");
  for (const [next, ms] of [["SIGKILL", graceMs], [null, 5_000]]) {
    const deadline = Date.now() + ms;
    while (groupAlive(group) && Date.now() < deadline) await sleep(50);
    if (next !== null && groupAlive(group)) signalGroup(group, next);
  }
  return !groupAlive(group);
}

/** Every process descending from `root` now (by parent pid; `ps` reads ids only, never arguments). */
export function descendants(root = process.pid) {
  let text = "";
  try { text = execFileSync("/bin/ps", ["-axo", "pid=,ppid="], { encoding: "utf8", timeout: 5_000 }); } catch { return []; }
  const children = new Map();
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match === null) continue;
    const [pid, ppid] = [Number(match[1]), Number(match[2])];
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const found = [];
  const pending = [...(children.get(root) ?? [])];
  while (pending.length > 0 && found.length < 10_000) {
    const pid = pending.pop();
    if (pid === process.pid || found.includes(pid)) continue;
    found.push(pid);
    pending.push(...(children.get(pid) ?? []));
  }
  return found;
}

/** At exit, synchronously: kill every suite group and everything this process started, remove every root. */
function cleanupSync() {
  for (const group of groups.keys()) signalGroup(group, "SIGKILL");
  if (process.platform !== "win32") for (const pid of descendants()) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  for (const root of [...roots.keys()]) { try { removeRoot(root); } catch { /* a later sweep takes it */ } }
}

let installed = false;
let stopping = false;
function installHandlers() {
  if (installed) return;
  installed = true;
  process.on("exit", cleanupSync);
  for (const [signal, code] of Object.entries(SIGNAL_CODES)) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      // Each suite gets its grace to stop what it started; then whatever is left goes with the exit.
      Promise.allSettled([...groups].map(([group, graceMs]) => stopGroup(group, { graceMs }))).finally(() => process.exit(code));
    });
  }
}

/**
 * Run one suite in its own process group with its own temp root as TMPDIR. Resolves when the suite and everything
 * left in its group have ended and its root is gone: { code, signal, timedOut, ms, root, output } (output: what it
 * printed, unless `stdio` is "inherit"). `onData` sees each chunk as it comes.
 */
export function runSuite({ command, args = [], cwd, env = {}, timeoutMs = null, prefix = "so-suite-", keep = false, graceMs = GRACE_MS, stdio = "pipe", onData = null, beforeRemove = null, tempRoot = true }) {
  // `tempRoot: false`: a suite that keeps its own short temp root (the unit tests: test/temp-root.ts) runs without one
  // more folder level, which would push the socket paths its tests make past the OS limit (103 bytes on macOS).
  const root = tempRoot ? makeTempRoot(prefix, { keep }) : null;
  const at = Date.now();
  return new Promise(done => {
    const child = spawn(command, args, {
      cwd, detached: process.platform !== "win32",
      stdio: stdio === "inherit" ? ["inherit", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env, ...(root === null ? {} : { TMPDIR: root, TMP: root, TEMP: root }) },
    });
    const chunks = [];
    for (const stream of [child.stdout, child.stderr]) stream?.on("data", chunk => { chunks.push(chunk); onData?.(chunk); });
    if (child.pid !== undefined) groups.set(child.pid, graceMs);
    let timedOut = false;
    const timer = timeoutMs === null ? null : setTimeout(() => { timedOut = true; void stopGroup(child.pid, { graceMs }); }, timeoutMs);
    let ended = false;
    const end = async (code, signal) => {
      if (ended) return;
      ended = true;
      if (timer !== null) clearTimeout(timer);
      // The suite's own process is gone; what it left in its group goes too, before its root does.
      if (child.pid !== undefined) { await stopGroup(child.pid, { graceMs }); groups.delete(child.pid); }
      // `beforeRemove`: the runner's own last word (stopping groups the suite listed as its own) while the root is there.
      try { await beforeRemove?.(); } catch { /* the root goes regardless */ }
      if (root !== null) { try { removeRoot(root); } catch { /* the plane's sweep takes it */ } }
      done({ code: timedOut ? 124 : code ?? (signal === null ? 1 : 128 + (SIGNAL_NUMBERS[signal] ?? 0)), signal, timedOut, ms: Date.now() - at, root, output: Buffer.concat(chunks) });
    };
    child.on("error", () => void end(127, null));
    child.on("exit", (code, signal) => void end(code, signal));
  });
}

const SIGNAL_NUMBERS = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };

if (process.argv[1] && import.meta.url === new URL(`file://${realpathSync(process.argv[1])}`).href) {
  const argv = process.argv.slice(2);
  const split = argv.indexOf("--");
  const own = split === -1 ? [] : argv.slice(0, split);
  const [command, ...args] = split === -1 ? argv : argv.slice(split + 1);
  const option = name => { const at = own.indexOf(name); return at === -1 ? null : own[at + 1]; };
  if (command === undefined) { console.error("Usage: node scripts/suite-lifecycle.mjs [--timeout <seconds>] [--grace <seconds>] [--keep] [--prefix <name>] -- <command> [args…]"); process.exit(2); }
  const seconds = option("--timeout") === null ? null : Number(option("--timeout"));
  const grace = option("--grace") === null ? null : Number(option("--grace"));
  const result = await runSuite({ command, args, stdio: "inherit", keep: own.includes("--keep"), prefix: option("--prefix") ?? "so-suite-", timeoutMs: seconds === null ? null : seconds * 1000, ...(grace === null ? {} : { graceMs: grace * 1000 }) });
  if (result.timedOut) console.error(`suite timed out after ${seconds} s; its processes were stopped`);
  process.exitCode = result.code;
}
