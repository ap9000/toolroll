/**
 * Fixed lanes for the journey runners, and one cap on real Claude/Codex turns for every runner of a check.
 *
 * `limiter(n)` runs at most n bodies at once, the rest in the order they asked.
 *
 * The provider gate: a real-model group or suite starts only while the check's real turns, plus the other claude and
 * codex sessions running on this computer (`pgrep -x`, process names only), stay within one cap: at most 4, or
 * TOOLROLL_CHECK_PROVIDERS. Other sessions never take all of it: the check always gets one turn at a time. Scripted
 * groups answer from a stand-in provider and never touch the gate.
 *
 * Every runner of one check shares the gate through a folder (TOOLROLL_CHECK_GATE, made by the outermost runner): one
 * lease file per running turn, taken under a lock; a lease whose owner has died is dropped; the first opener's cap
 * wins. Every start is recorded there too, for the summary line.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** At most `limit` bodies at once; the others start in the order they asked, as each running one ends. */
export function limiter(limit) {
  let running = 0;
  const queue = [];
  const next = () => { if (running < limit && queue.length > 0) { running += 1; queue.shift()(); } };
  return body => new Promise(start => { queue.push(start); next(); }).then(async () => {
    try { return await body(); } finally { running -= 1; next(); }
  });
}

/** The cap on real provider turns at once: TOOLROLL_CHECK_PROVIDERS, or 4. */
export function providerCap(env = process.env) {
  const set = env.TOOLROLL_CHECK_PROVIDERS;
  if (set !== undefined && set !== "") {
    if (!/^[0-9]+$/.test(set) || Number(set) < 1) throw new Error(`TOOLROLL_CHECK_PROVIDERS takes a whole number, 1 or more (not "${set}").`);
    return { cap: Number(set), from: "TOOLROLL_CHECK_PROVIDERS" };
  }
  return { cap: 4, from: "default" };
}

/** Real provider sessions running on this computer: processes named claude or codex. Null when it can't tell. */
export function providerSessions() {
  let count = 0;
  for (const name of ["claude", "codex"]) {
    try { count += execFileSync("pgrep", ["-x", name], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").filter(Boolean).length; } catch (error) {
      if (error?.status !== 1) return null; // 1: none running
    }
  }
  return count;
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
const pause = ms => new Promise(done => setTimeout(done, ms));
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * The check's provider gate, in `dir` (made when missing, with the cap the first opener chose). `hold(label, body)`
 * runs body once there is a slot, holding a lease until it settles; body gets { waitedMs }.
 */
export function openGate({ dir = process.env.TOOLROLL_CHECK_GATE, env = process.env, sessions = providerSessions, now = () => Date.now(), everyMs = 2_000, sayEveryMs = 60_000, log = () => {}, alive: isAlive = alive, owner = process.pid } = {}) {
  const own = dir === undefined || dir === "";
  const root = own ? mkdtempSync(join(tmpdir(), "toolroll-check-gate-")) : dir;
  mkdirSync(join(root, "leases"), { recursive: true });
  const configFile = join(root, "config.json");
  if (!existsSync(configFile)) {
    writeFileSync(`${configFile}.${owner}`, JSON.stringify(providerCap(env)));
    try { renameSync(`${configFile}.${owner}`, configFile); } catch { /* another opener's is as good */ }
  }
  const { cap, from } = JSON.parse(readFileSync(configFile, "utf8"));
  const lock = join(root, "lock");
  const take = async () => {
    for (;;) {
      try { mkdirSync(lock); writeFileSync(join(lock, "owner"), String(owner)); return; } catch (error) {
        if (error.code !== "EEXIST") throw error;
        let holder = null;
        try { holder = Number(readFileSync(join(lock, "owner"), "utf8")); } catch { /* being written, or gone */ }
        let age = 0;
        try { age = Date.now() - statSync(lock).mtimeMs; } catch { /* gone */ }
        if ((holder !== null && holder > 0 && !isAlive(holder)) || age > 10_000) rmSync(lock, { recursive: true, force: true });
        else await pause(10);
      }
    }
  };
  const drop = () => rmSync(lock, { recursive: true, force: true });
  const leases = () => readdirSync(join(root, "leases")).flatMap(file => {
    try {
      const one = JSON.parse(readFileSync(join(root, "leases", file), "utf8"));
      if (!isAlive(one.owner)) { rmSync(join(root, "leases", file), { force: true }); return []; }
      return [one];
    } catch { return []; }
  });
  const mine = new Set();
  let count = 0;
  const releaseAll = () => { for (const file of mine) rmSync(join(root, "leases", file), { force: true }); mine.clear(); };
  process.on("exit", releaseAll);
  async function acquire(label) {
    const asked = now();
    let said = null, why = null;
    for (;;) {
      await take();
      try {
        const held = leases();
        let running = null;
        try { running = sessions(); } catch { /* unknown */ }
        // Our own turns are among the sessions running; the rest are other sessions.
        const others = Number.isFinite(running) ? Math.max(0, running - held.length) : null;
        if (held.length + 1 <= Math.max(1, cap - (others ?? 0))) {
          const file = `${owner}-${++count}-${Math.random().toString(36).slice(2, 8)}.json`;
          writeFileSync(join(root, "leases", file), JSON.stringify({ owner, label, at: now() }));
          mine.add(file);
          const event = { label, owner, waitedMs: now() - asked, why, all: held.length + 1, mine: held.filter(one => one.owner === owner).length + 1, others };
          appendFileSync(join(root, "events.jsonl"), `${JSON.stringify(event)}\n`);
          return { file, waitedMs: event.waitedMs };
        }
        why = `${plural(held.length, "provider turn")} of ours and ${plural(others ?? 0, "other session")} running, at the cap of ${cap}`;
      } finally { drop(); }
      if (said === null || now() - said >= sayEveryMs) { log(`waiting for room to start ${label}: ${why}`); said = now(); }
      await pause(everyMs);
    }
  }
  const release = file => { rmSync(join(root, "leases", file), { force: true }); mine.delete(file); };
  return {
    dir: root, cap, from,
    async hold(label, body) {
      const { file, waitedMs } = await acquire(label);
      try { return await body({ waitedMs }); } finally { release(file); }
    },
    /** What the gate did: every start recorded (by `owner` alone when given). */
    facts(only = null) {
      let events = [];
      try { events = readFileSync(join(root, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch { /* none yet */ }
      if (only !== null) events = events.filter(one => one.owner === only);
      const waited = events.filter(one => one.why !== null);
      return {
        starts: events.length, cap, from,
        most: Math.max(0, ...events.map(one => only === null ? one.all : one.mine)),
        others: events.some(one => one.others !== null) ? Math.max(...events.map(one => one.others ?? 0)) : null,
        waits: waited.length, waitedMs: waited.reduce((sum, one) => sum + one.waitedMs, 0),
        longest: waited.sort((a, b) => b.waitedMs - a.waitedMs)[0] ?? null,
      };
    },
    close() { releaseAll(); process.off("exit", releaseAll); if (own) rmSync(root, { recursive: true, force: true }); },
  };
}

const span = ms => ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 6000) / 10} min`;

/**
 * What the gate did, in a line: "provider gate: up to 3 real turns at once, 1 other session (cap 4, default); 2 starts
 * waited 1.5 min in all for a slot (longest: app lead)".
 */
export function gateWords(facts) {
  if (facts.starts === 0) return "provider gate: nothing started";
  const others = facts.others === null ? "other sessions unknown" : plural(facts.others, "other session");
  const waits = facts.waits === 0 ? "nothing waited for a slot" : `${plural(facts.waits, "start")} waited ${span(facts.waitedMs)} in all for a slot (longest: ${facts.longest.label})`;
  return `provider gate: up to ${plural(facts.most, "real turn")} at once, ${others} (cap ${facts.cap}, ${facts.from}); ${waits}`;
}
