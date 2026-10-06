/**
 * Checks that fit in memory. A browser group (a console, a worker and Chrome) takes about 400 MB, so the journeys
 * run at most as many groups at once as the memory available allows, and never more than 6; a group starts only
 * while there is room for it. The release check records the peak.
 *
 * "Available" is what the OS can hand out without swapping: on macOS free, inactive, speculative and purgeable pages
 * (os.freemem() counts only free pages, a fraction of it); on Linux MemAvailable.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { freemem, tmpdir, totalmem } from "node:os";
import { join } from "node:path";

export const GROUP_BYTES = 400 * 1024 * 1024;
export const MAX_GROUPS = 6;

/** Bytes vm_stat says the OS can hand out: free, inactive, speculative and purgeable pages. */
export function parseVmStat(text) {
  const size = Number(/page size of (\d+) bytes/.exec(text)?.[1] ?? 4096);
  const pages = name => Number(new RegExp(`^Pages ${name}:\\s+(\\d+)`, "m").exec(text)?.[1] ?? 0);
  return (pages("free") + pages("inactive") + pages("speculative") + pages("purgeable")) * size;
}

/** /proc/meminfo's MemAvailable, in bytes; null when it doesn't say. */
export function parseMeminfo(text) {
  const kb = /^MemAvailable:\s+(\d+) kB/m.exec(text)?.[1];
  return kb === undefined ? null : Number(kb) * 1024;
}

export function availableMemory() {
  try {
    if (process.platform === "darwin") return parseVmStat(execFileSync("vm_stat", { encoding: "utf8", timeout: 5_000 }));
    if (process.platform === "linux") return parseMeminfo(readFileSync("/proc/meminfo", "utf8")) ?? freemem();
  } catch { /* the plain count below */ }
  return freemem();
}

/** How many browser groups fit at once: one per 400 MB available, at least 1, at most 6. */
export function browserSlots(available = availableMemory(), max = MAX_GROUPS) {
  return Math.max(1, Math.min(max, Math.floor(available / GROUP_BYTES)));
}

/**
 * A gate for browser groups: `slot(body)` runs body once fewer than `limit` run and, beyond the first, `room()` says
 * there is memory for one more (asked again every `everyMs` until there is).
 */
export function limiter(limit, { room = () => availableMemory() >= GROUP_BYTES, everyMs = 1_000 } = {}) {
  let running = 0;
  const waiters = [];
  const acquire = async () => {
    for (;;) {
      if (running < limit && (running === 0 || room())) { running += 1; return; }
      await new Promise(done => { waiters.push(done); setTimeout(done, everyMs); });
    }
  };
  const release = () => { running -= 1; for (const done of waiters.splice(0)) done(); };
  return async body => { await acquire(); try { return await body(); } finally { release(); } };
}

/** Resident memory of `root` and everything under it, in bytes; null where `ps` can't say. */
export function treeBytes(root = process.pid) {
  let text;
  try { text = execFileSync("ps", ["-axo", "pid=,ppid=,rss="], { encoding: "utf8", timeout: 5_000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; }
  const rows = text.trim().split("\n").map(line => line.trim().split(/\s+/).map(Number)).filter(row => row.length === 3 && row.every(Number.isFinite));
  const inside = new Set([root]);
  let total = 0;
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, ppid] of rows) if (!inside.has(pid) && inside.has(ppid)) { inside.add(pid); grew = true; }
  }
  for (const [pid, , rss] of rows) if (inside.has(pid)) total += rss * 1024;
  return total;
}

/** Sample memory every `everyMs` until stopped: the peak in use on the machine, the lowest available, and the peak
 * the check's own processes held. */
export function watchMemory({ everyMs = 2_000, available = availableMemory, tree = treeBytes, total = totalmem() } = {}) {
  const seen = { total, peakUsed: 0, lowestAvailable: Infinity, peakCheck: null };
  // A reading that fails or says nothing is skipped: the record is only ever short, never the reason a check stops.
  const sample = () => {
    const free = reading(available);
    if (free !== null) {
      seen.peakUsed = Math.max(seen.peakUsed, total - free);
      seen.lowestAvailable = Math.min(seen.lowestAvailable, free);
    }
    const mine = reading(tree);
    if (mine !== null) seen.peakCheck = Math.max(seen.peakCheck ?? 0, mine);
  };
  sample();
  const timer = setInterval(sample, everyMs);
  timer.unref?.();
  return { stop: () => { clearInterval(timer); sample(); return { ...seen }; } };
}

const gb = bytes => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
/** A memory reading in bytes, or null when it throws or says nothing usable. */
const reading = read => { try { const value = read(); return Number.isFinite(value) ? value : null; } catch { return null; } };

/** "peak memory: the check's processes 4.8 GB; the machine 41.2 GB in use of 64.0 GB (lowest available 22.8 GB)" */
export function memoryWords(seen) {
  const machine = Number.isFinite(seen.lowestAvailable) ? `the machine ${gb(seen.peakUsed)} in use of ${gb(seen.total)} (lowest available ${gb(seen.lowestAvailable)})` : "the machine's unknown (couldn't read memory)";
  return `peak memory: ${seen.peakCheck === null ? "" : `the check's processes ${gb(seen.peakCheck)}; `}${machine}`;
}

/*
 * Admission: every suite and group of a check starts only when the machine has room for it, so a busy machine makes
 * the check slower, never wrong.
 *
 * Before each start, a fresh sample: memory available, macOS kernel pressure, swap in use (macOS `sysctl vm.swapusage`,
 * Linux /proc/meminfo) and how many real Claude/Codex sessions are running (`pgrep -x`, process names only, never command
 * lines). A start needs its own memory plus a reserve (1 GB; 4 GB at macOS warn pressure or Linux swap 90% used), less
 * what starts of the last 20 s have yet to take. macOS critical pressure waits; sticky swap usage is only reported.
 * Real provider turns need a slot: ours plus other sessions stay within one cap for every suite (default at most 4,
 * reduced to 1 per 5 GB on smaller machines; TOOLROLL_CHECK_PROVIDERS overrides it). With nothing of the check's running,
 * a start may proceed with low available memory, but never past the provider cap or macOS warn/critical pressure.
 *
 * The gate is shared by every process of one check: a folder (TOOLROLL_CHECK_GATE, made by the outermost runner) with
 * one lease file per running start, taken under a lock. A lease whose owner has died is dropped. Every start is
 * recorded there too, for the summary ("ran up to 4 at a time: lowest 3.1 GB free, swap up to 97% used").
 *
 * TOOLROLL_CHECK_MACHINE names a JSON file of readings ({ platform, available, swapUsed, swapTotal, pressure, providers },
 * memory in bytes, pressure 1/2/4 or null) used in place of the machine's own, read at every sample for rehearsals.
 */
const GB = 1024 ** 3;
export const RESERVE_BYTES = 1 * GB;
export const PRESSED_RESERVE_BYTES = 4 * GB;
export const SWAP_PRESSED = 0.9;
export const SETTLE_MS = 20_000;
/** What a start takes: typecheck and build (tsc, esbuild), the unit tests (vitest on half the cores), the upgrade path,
 * and a browser group: a console, a worker and Chrome (~400 MB) with the real Claude or Codex session it may run. */
export const DEMAND = {
  typecheck: { bytes: 2 * GB, providers: 0 },
  build: { bytes: 2 * GB, providers: 0 },
  unit: { bytes: 4 * GB, providers: 0 },
  upgrade: { bytes: 1.5 * GB, providers: 0 },
  group: { bytes: 1 * GB, providers: 1 },
};

/** `sysctl vm.swapusage`: "vm.swapusage: total = 65536.00M  used = 64000.00M  free = 1536.00M  (encrypted)". */
export function parseSwapUsage(text) {
  const size = name => {
    const hit = new RegExp(`${name} = ([0-9.]+)([KMGT])`).exec(text);
    return hit === null ? null : Number(hit[1]) * 1024 ** (" KMGT".indexOf(hit[2]));
  };
  const total = size("total"), used = size("used");
  return total === null || used === null ? null : { total, used };
}

/** /proc/meminfo's swap: SwapTotal less SwapFree. */
export function parseMeminfoSwap(text) {
  const kb = name => { const hit = new RegExp(`^${name}:\\s+(\\d+) kB`, "m").exec(text); return hit === null ? null : Number(hit[1]) * 1024; };
  const total = kb("SwapTotal"), free = kb("SwapFree");
  return total === null || free === null ? null : { total, used: total - free };
}

export function swapUsage() {
  try {
    if (process.platform === "darwin") return parseSwapUsage(execFileSync("sysctl", ["vm.swapusage"], { encoding: "utf8", timeout: 5_000 }));
    if (process.platform === "linux") return parseMeminfoSwap(readFileSync("/proc/meminfo", "utf8"));
  } catch { /* unknown */ }
  return null;
}

/** macOS kernel pressure: 1 normal, 2 warn, 4 critical; null when unavailable. Swap usage is not a pressure signal. */
export function memoryPressure({ platform = process.platform, read = execFileSync } = {}) {
  if (platform !== "darwin") return null;
  try {
    const level = Number(read("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], { encoding: "utf8", timeout: 5_000 }).trim());
    return [1, 2, 4].includes(level) ? level : null;
  } catch { return null; }
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

/** The machine now: available memory, swap, macOS pressure and provider sessions (null when unknown, including a
 * reading that throws). */
export function sampleMachine({ env = process.env, platform = process.platform, available = availableMemory, swap = swapUsage, pressure = () => memoryPressure({ platform }), providers = providerSessions } = {}) {
  if (env.TOOLROLL_CHECK_MACHINE) {
    // A rehearsal's readings; unreadable, it is a machine with no room.
    try {
      const fake = JSON.parse(readFileSync(env.TOOLROLL_CHECK_MACHINE, "utf8"));
      return { platform: fake.platform ?? platform, available: fake.available ?? 0, swapUsed: fake.swapUsed ?? null, swapTotal: fake.swapTotal ?? null, pressure: fake.pressure ?? null, providers: fake.providers ?? null, ...(fake.total == null ? {} : { total: fake.total }) };
    } catch { return { platform, available: 0, swapUsed: null, swapTotal: null, pressure: null, providers: null }; }
  }
  const known = read => { try { return read() ?? null; } catch { return null; } };
  const used = known(swap);
  return { platform, available: reading(available), swapUsed: used?.used ?? null, swapTotal: used?.total ?? null, pressure: platform === "darwin" ? known(pressure) : null, providers: known(providers) };
}

/** A sample from `read` (gate.sample, sampleMachine), or null when it throws or returns nothing usable. */
export function readSample(read) {
  try {
    const sample = read();
    return sample && typeof sample === "object" ? sample : null;
  } catch { return null; }
}

/** The cap on real provider turns at once: TOOLROLL_CHECK_PROVIDERS, or at most 4, reduced to 1 per 5 GB (at least 1). */
export function providerCap(env = process.env, total = totalmem()) {
  const set = env.TOOLROLL_CHECK_PROVIDERS;
  if (set !== undefined && set !== "") {
    if (!/^[0-9]+$/.test(set) || Number(set) < 1) throw new Error(`TOOLROLL_CHECK_PROVIDERS takes a whole number, 1 or more (not "${set}").`);
    return { cap: Number(set), from: "TOOLROLL_CHECK_PROVIDERS" };
  }
  return { cap: Math.max(1, Math.min(4, Math.floor(total / (5 * GB)))), from: `${gb(total)} memory, default maximum 4` };
}

const swapPct = sample => sample.swapTotal ? Math.round((sample.swapUsed / sample.swapTotal) * 100) : null;
const pressureName = level => ({ 1: "normal", 2: "warn", 4: "critical" })[level] ?? "unknown";

/** App lanes share the existing six-browser budget. Small runners keep their old share; overrides never bypass
 * pressure or memory. Unknown pressure cannot authorize extra work: a sample that is missing, or whose memory, macOS
 * pressure or (elsewhere) swap couldn't be read, gets one lane. Only a bad TOOLROLL_E2E_LANES throws. The gate checks
 * this again at every start. */
export function appLanes(sample, { env = process.env, total = sample?.total ?? totalmem(), baseline = 1, max = MAX_GROUPS } = {}) {
  const set = env.TOOLROLL_E2E_LANES;
  if (set !== undefined && set !== "" && (!/^[0-9]+$/.test(set) || !Number.isSafeInteger(Number(set)) || Number(set) < 1)) {
    throw new Error(`TOOLROLL_E2E_LANES takes a whole number, 1 or more (not "${set}").`);
  }
  const requested = set === undefined || set === "" ? 4 : Number(set);
  const unread = { count: 1, why: "couldn't read memory" };
  if (sample === null || typeof sample !== "object" || !Number.isFinite(sample.available)) return unread;
  if (sample.platform === "darwin" && sample.pressure == null) return unread;
  if (sample.platform === "darwin" && sample.pressure !== 1) return { count: 1, why: `memory pressure ${pressureName(sample.pressure)}` };
  if (sample.platform !== "darwin") {
    if (sample.swapTotal == null || sample.swapUsed == null) return unread;
    if (sample.swapTotal > 0 && sample.swapUsed / sample.swapTotal >= SWAP_PRESSED) return { count: 1, why: "memory pressure warn (swap)" };
  }
  const fits = Math.max(1, Math.floor((sample.available - RESERVE_BYTES) / DEMAND.group.bytes));
  const small = total <= 8 * GB;
  const count = Math.min(requested, max, fits, small ? baseline : Infinity);
  const why = small ? "small runner: keeping current lane cap" : fits < Math.min(requested, max) ? "available memory" : "memory normal";
  return { count, why: `${why}${set === undefined || set === "" ? "" : `; TOOLROLL_E2E_LANES=${set}`}` };
}

export const laneWords = ({ count, why }) => `${count} lane${count === 1 ? "" : "s"}: ${why}`;

/**
 * Whether a start with `demand` ({ bytes, providers }) may go ahead now, given the machine's `sample` and the leases
 * the check holds ({ bytes, providers, at }): { ok, why } where why says what it waits for.
 */
export function admit(demand, sample, held, { cap, now = Date.now() }) {
  const macOS = sample.platform === "darwin";
  if (macOS && sample.pressure === 4) return { ok: false, why: "macOS memory pressure critical; waiting for it to ease" };
  const settling = held.filter(one => now - one.at < SETTLE_MS).reduce((sum, one) => sum + one.bytes, 0);
  const pct = swapPct(sample);
  const pressed = macOS ? sample.pressure === 2 : pct !== null && pct >= SWAP_PRESSED * 100;
  const reserve = pressed ? PRESSED_RESERVE_BYTES : RESERVE_BYTES;
  if (held.length > 0 && !Number.isFinite(sample.available)) return { ok: false, why: "couldn't read memory; waiting for the check's other starts to finish" };
  if ((held.length > 0 || (macOS && pressed)) && sample.available - settling < demand.bytes + reserve) {
    const pressure = macOS ? `, macOS pressure ${pressureName(sample.pressure)}` : pct === null ? "" : `, swap ${pct}% used`;
    return { ok: false, why: `${gb(sample.available)} free${pressure}; it needs ${gb(demand.bytes + reserve + settling)}` };
  }
  if (demand.providers > 0) {
    const ours = held.reduce((sum, one) => sum + one.providers, 0);
    // Our own sessions are among those running; the rest are other sessions.
    const others = sample.providers === null ? 0 : Math.max(0, sample.providers - ours);
    // Other sessions (a person's own Claude Code or Codex, mostly idle) take room from the cap, but never all of it:
    // the check always gets one turn at a time, or a machine with a few AI apps open would wait forever.
    const room = Math.max(1, cap - others);
    if (ours + demand.providers > room) return { ok: false, why: `${ours} provider turn${ours === 1 ? "" : "s"} of ours and ${others} other session${others === 1 ? "" : "s"} running, at the cap of ${cap}` };
  }
  return { ok: true, why: null };
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
const pause = ms => new Promise(done => setTimeout(done, ms));

/**
 * The check's gate, in `dir` (made when missing, with the provider cap the first opener chose). `hold(label, demand,
 * body)` runs body once there is room, holding a lease until it settles; body gets { waitedMs }.
 */
export function openGate({ dir = process.env.TOOLROLL_CHECK_GATE, env = process.env, total = totalmem(), sample = () => sampleMachine({ env }), now = () => Date.now(), everyMs = 2_000, sayEveryMs = 60_000, log = () => {}, alive: isAlive = alive, owner = process.pid } = {}) {
  const own = dir === undefined || dir === "";
  const root = own ? mkdtempSync(join(tmpdir(), "toolroll-check-gate-")) : dir;
  mkdirSync(join(root, "leases"), { recursive: true });
  const configFile = join(root, "config.json");
  if (!existsSync(configFile)) {
    writeFileSync(`${configFile}.${owner}`, JSON.stringify(providerCap(env, total)));
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
        try { age = now() - statSync(lock).mtimeMs; } catch { /* gone */ }
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
      return [{ ...one, file }];
    } catch { return []; }
  });
  const mine = new Set();
  let count = 0;
  const releaseAll = () => { for (const file of mine) rmSync(join(root, "leases", file), { force: true }); mine.clear(); };
  process.on("exit", releaseAll);
  async function acquire(label, demand, ready) {
    const asked = now();
    let said = null, lowest = Infinity, highest = null, highestPressure = null, macOS = false, why = null;
    for (;;) {
      await take();
      let decided, held, seen;
      try {
        held = leases();
        // A sample that can't be read is a machine of unknown memory: no lanes beyond one, nothing alongside a start.
        seen = readSample(sample) ?? { platform: process.platform, available: null, swapUsed: null, swapTotal: null, pressure: null, providers: null };
        // Extra constraints run under the same lock and on the same fresh sample as memory/provider admission.
        const extra = ready?.(seen, held);
        decided = extra && !extra.ok ? extra : admit(demand, seen, held, { cap, now: now() });
        if (Number.isFinite(seen.available)) lowest = Math.min(lowest, seen.available);
        const pct = swapPct(seen);
        if (pct !== null) highest = Math.max(highest ?? 0, pct);
        if (seen.platform === "darwin") {
          macOS = true;
          if ([1, 2, 4].includes(seen.pressure)) highestPressure = Math.max(highestPressure ?? 0, seen.pressure);
        }
        if (decided.ok) {
          const file = `${owner}-${++count}-${Math.random().toString(36).slice(2, 8)}.json`;
          writeFileSync(join(root, "leases", file), JSON.stringify({ owner, label, bytes: demand.bytes, providers: demand.providers, at: now() }));
          mine.add(file);
          const ours = held.reduce((sum, one) => sum + one.providers, 0);
          const event = {
            label, owner, at: now(), waitedMs: now() - asked, why,
            all: held.length + 1, mine: held.filter(one => one.owner === owner).length + 1,
            lowest, highest, highestPressure, macOS, providers: ours + demand.providers, others: seen.providers === null ? null : Math.max(0, seen.providers - ours),
          };
          appendFileSync(join(root, "events.jsonl"), `${JSON.stringify(event)}\n`);
          return { file, waitedMs: event.waitedMs };
        }
      } finally { drop(); }
      why = decided.why;
      if (said === null || now() - said >= sayEveryMs) { log(`waiting for room to start ${label}: ${why}`); said = now(); }
      await pause(everyMs);
    }
  }
  const release = file => { rmSync(join(root, "leases", file), { force: true }); mine.delete(file); };
  return {
    dir: root, cap, from, sample,
    async hold(label, demand, body, ready = null) {
      const { file, waitedMs } = await acquire(label, demand, ready);
      try { return await body({ waitedMs }); } finally { release(file); }
    },
    /** What admission did: every start recorded (by `owner` alone when given). */
    facts(only = null) {
      let events = [];
      try { events = readFileSync(join(root, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch { /* none yet */ }
      if (only !== null) events = events.filter(one => one.owner === only);
      const waited = events.filter(one => one.why !== null);
      return {
        starts: events.length, cap, from,
        most: Math.max(0, ...events.map(one => only === null ? one.all : one.mine)),
        lowest: events.some(one => Number.isFinite(one.lowest)) ? Math.min(...events.filter(one => Number.isFinite(one.lowest)).map(one => one.lowest)) : null,
        highestSwap: events.some(one => one.highest !== null) ? Math.max(...events.map(one => one.highest ?? 0)) : null,
        macOS: events.some(one => one.macOS),
        highestPressure: events.some(one => one.highestPressure != null) ? Math.max(...events.map(one => one.highestPressure ?? 0)) : null,
        providers: Math.max(0, ...events.map(one => one.providers)),
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
 * What admission did, in a line: "admission: ran up to 4 at a time: lowest 3.1 GB free, swap up to 97% used; up to 3
 * provider turns of ours, 1 other session (cap 4, from 64.0 GB memory, default maximum 4); 2 starts waited 1.5 min for room
 * (longest: app lead, 2.0 GB free; it needs 5.0 GB)". `what` names what ran ("groups" for one runner's).
 */
export function admissionWords(facts, what = "") {
  if (facts.starts === 0) return "admission: nothing started";
  const noun = what === "" ? "" : ` ${facts.most === 1 ? what.replace(/s$/, "") : what}`;
  const machine = [
    facts.lowest === null ? null : `lowest ${gb(facts.lowest)} free`,
    facts.macOS ? `macOS pressure ${facts.highestPressure === null ? "unknown" : `up to ${pressureName(facts.highestPressure)}`}` : null,
    facts.highestSwap === null ? null : `swap up to ${facts.highestSwap}% used`,
  ].filter(Boolean).join(", ");
  const others = facts.others === null ? "other sessions unknown" : `${facts.others} other session${facts.others === 1 ? "" : "s"}`;
  const providers = `${facts.providers === 0 ? "no provider turns of ours" : `up to ${facts.providers} provider turn${facts.providers === 1 ? "" : "s"} of ours`}, ${others} (cap ${facts.cap}, from ${facts.from})`;
  const waits = facts.waits === 0 ? "nothing waited for room" : `${facts.waits} start${facts.waits === 1 ? "" : "s"} waited ${span(facts.waitedMs)} in all for room (longest: ${facts.longest.label}, ${facts.longest.why})`;
  return `admission: ran up to ${facts.most}${noun} at a time${machine === "" ? "" : `: ${machine}`}; ${providers}; ${waits}`;
}
