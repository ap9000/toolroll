/**
 * Flexible threads' agent launches as Toolroll records them (slice F2c; schema v165, flexible-launch-schema.ts), and the
 * custody steps over them: what a launch's durable identity is, how the holder records what it sees while the agent
 * runs, and how an unsettled launch is settled (its proxy and relay closed, every process found and stopped, the exit
 * proved) before anything replaces it.
 *
 * The rules this module keeps:
 * - A launch is on the record before its process exists (`spawning`, flexible-thread.ts writes it under the thread's
 *   lock), so a crash at any point leaves a row. Its agent can't run until the row is `live`: the start gate.
 * - `exited` is written only on a verified exit of the whole tree (flexible-custody.ts), or for a launch whose start gate
 *   never opened (nothing of the agent ran). `live_pid` on the thread is cleared in that same transaction, never before.
 * - Settling closes the launch's network first (its run proxy and its relay token: Codex round 2 item 10), so a process
 *   custody can't end has no network from that moment, then stops what it finds. A launch it can't prove exited is
 *   `unresolved`: nothing replaces it, the thread can't be removed, and its turn keeps running on the record until a
 *   later settle proves the exit; only then are the turns interrupted (flexible-turns.ts interruptFlexibleThreadTurns:
 *   this is the proof it needs).
 */
import { createHash, randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { currentBootId } from "./boot-identity.js";
import { observeCustody, realCustodyIO, stopCustody, custodySettled, type CustodyBlocker, type CustodyIO, type CustodyOutcome, type LaunchCustody, type ProcessWitness } from "./flexible-custody.js";
import type { FlexibleLevel } from "./flexible.js";
import { interruptFlexibleThreadTurns, type FlexibleClock } from "./flexible-turns.js";
import { currentMachineId } from "./machine-identity.js";
import type { Store } from "./store.js";

export const FLEXIBLE_AGENT_PROVIDERS = ["claude", "codex", "gemini", "openrouter"] as const;
export type FlexibleAgentProvider = (typeof FLEXIBLE_AGENT_PROVIDERS)[number];
export type FlexibleLaunchState = "spawning" | "live" | "stopping" | "exited" | "unresolved";
export type FlexibleLaunchRow = {
  id: string; thread: string; turn: string | null; provider: FlexibleAgentProvider; level: FlexibleLevel; fenceDigest: string; holder: string;
  host: string; machineId: string | null; bootId: string | null; marker: string; leaderPid: number | null; leaderStart: string | null;
  namespaces: string[]; witnesses: ProcessWitness[]; state: FlexibleLaunchState; startedAt: string; stopReason: string | null; endedAt: string | null; endDetail: string | null;
};

const LAUNCH_ID = /^[0-9a-f]{32}$/;
const text = (value: unknown): string | null => value === null || value === undefined ? null : String(value);
function list<T>(json: unknown, valid: (one: unknown) => one is T): T[] {
  try { const parsed = JSON.parse(String(json)) as unknown; return Array.isArray(parsed) ? parsed.filter(valid) : []; } catch { return []; }
}
const isNamespace = (one: unknown): one is string => typeof one === "string" && /^pid:\[\d{1,20}\]$/.test(one);
const isWitness = (one: unknown): one is ProcessWitness => typeof one === "object" && one !== null && Number.isSafeInteger((one as ProcessWitness).pid) && (one as ProcessWitness).pid > 1
  && typeof (one as ProcessWitness).start === "string" && /^[ts]\d{1,20}$/.test((one as ProcessWitness).start);

function readLaunch(row: Record<string, unknown> | undefined): FlexibleLaunchRow | null {
  if (row === undefined) return null;
  return { id: String(row["id"]), thread: String(row["thread"]), turn: text(row["turn"]), provider: String(row["provider"]) as FlexibleAgentProvider, level: String(row["level"]) as FlexibleLevel,
    fenceDigest: String(row["fence_digest"]), holder: String(row["holder"]), host: String(row["host"]), machineId: text(row["machine_id"]), bootId: text(row["boot_id"]), marker: String(row["marker"]),
    leaderPid: row["leader_pid"] === null || row["leader_pid"] === undefined ? null : Number(row["leader_pid"]), leaderStart: text(row["leader_start"]),
    namespaces: list(row["namespaces"], isNamespace), witnesses: list(row["witnesses"], isWitness), state: String(row["state"]) as FlexibleLaunchState,
    startedAt: String(row["started_at"]), stopReason: text(row["stop_reason"]), endedAt: text(row["ended_at"]), endDetail: text(row["end_detail"]) };
}

/** A launch's record, or null. */
export function flexibleLaunch(store: Store, id: string): FlexibleLaunchRow | null {
  if (!LAUNCH_ID.test(id)) return null;
  return readLaunch(store.handle.prepare("SELECT * FROM flexible_thread_launch WHERE id = ?").get(id) as Record<string, unknown> | undefined);
}
/** The thread's launch that isn't settled (spawning, live, stopping or unresolved), or null: at most one. */
export function unsettledLaunch(store: Store, thread: string): FlexibleLaunchRow | null {
  return readLaunch(store.handle.prepare("SELECT * FROM flexible_thread_launch WHERE thread = ? AND state <> 'exited'").get(thread) as Record<string, unknown> | undefined);
}

/** What custody knows about a launch, from its record (never from the thread's folder or the caller). */
export function custodyOf(launch: FlexibleLaunchRow, folder: string): LaunchCustody {
  return { host: launch.host, machineId: launch.machineId, bootId: launch.bootId, folder, namespaces: launch.namespaces, witnesses: launch.witnesses,
    leader: launch.leaderPid === null || launch.leaderStart === null ? null : { pid: launch.leaderPid, start: launch.leaderStart } };
}

/** The OS custody reads, with this boot's identity. */
export const defaultCustodyIO = (): CustodyIO => realCustodyIO(currentBootId);

// ---- writing a launch (flexible-thread.ts calls these under the thread's lock) ------------------------------------------

export type FlexibleLaunchMeta = { provider: FlexibleAgentProvider; level: FlexibleLevel; turn: string | null; holder: string };

/** Record a launch about to be spawned (`spawning`): its id and custody token, this host and boot. */
export function recordSpawning(store: Store, input: { thread: string; meta: FlexibleLaunchMeta; fenceDigest: string; bootId: string | null; clock?: FlexibleClock }): { id: string; marker: string } {
  const id = randomBytes(16).toString("hex"), marker = randomBytes(16).toString("hex");
  store.transact(() => {
    const at = (input.clock ?? (() => new Date()))().toISOString();
    store.handle.prepare(`INSERT INTO flexible_thread_launch (id, thread, turn, provider, level, fence_digest, holder, host, machine_id, boot_id, marker, state, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'spawning', ?)`).run(id, input.thread, input.meta.turn, input.meta.provider, input.meta.level, input.fenceDigest, input.meta.holder,
      hostname(), currentMachineId(), input.bootId, marker, at);
  });
  return { id, marker };
}

/** The spawned leader registered: the launch goes live and the thread names its group, in one transaction. False when
 * either record moved (the caller then stops what it started). */
export function recordLive(store: Store, input: { launch: string; thread: string; pid: number; start: string; clock?: FlexibleClock }): boolean {
  return store.transact(() => {
    const at = (input.clock ?? (() => new Date()))().toISOString();
    const live = store.handle.prepare("UPDATE flexible_thread_launch SET state = 'live', leader_pid = ?, leader_start = ? WHERE id = ? AND state = 'spawning'").run(input.pid, input.start, input.launch);
    if (Number(live.changes) !== 1) throw new Error("the launch's record moved");
    const thread = store.handle.prepare("UPDATE flexible_thread SET live_pid = ?, live_since = ? WHERE id = ? AND state = 'ready'").run(input.pid, at, input.thread);
    if (Number(thread.changes) !== 1) throw new Error("the thread's record moved");
    return true;
  });
}

/** A launch registered live whose start gate was then kept shut (a re-check before opening it refused): nothing of its
 * agent ran. Its record ends and the thread's live_pid (exactly this leader's) is cleared, in one transaction. */
export function recordGateShut(store: Store, input: { launch: string; thread: string; pid: number; detail: string; clock?: FlexibleClock }): void {
  store.transact(() => {
    const at = (input.clock ?? (() => new Date()))().toISOString();
    store.handle.prepare("UPDATE flexible_thread_launch SET state = 'exited', ended_at = ?, end_detail = ? WHERE id = ? AND state = 'live' AND leader_pid = ?").run(at, input.detail.slice(0, 2000), input.launch, input.pid);
    store.handle.prepare("UPDATE flexible_thread SET live_pid = NULL, live_since = NULL WHERE id = ? AND live_pid = ?").run(input.thread, input.pid);
  });
}

/** A launch whose start gate never opened ended: nothing of its agent ran. */
export function recordNeverStarted(store: Store, launch: string, detail: string, clock: FlexibleClock = () => new Date()): void {
  store.transact(() => {
    store.handle.prepare("UPDATE flexible_thread_launch SET state = 'exited', ended_at = ?, end_detail = ? WHERE id = ? AND state = 'spawning'").run(clock().toISOString(), detail.slice(0, 2000), launch);
  });
}

/** Record what the holder saw of a live launch (new descendants and namespaces); only grows. */
function recordSeen(store: Store, launch: FlexibleLaunchRow, seen: { namespaces: readonly string[]; witnesses: readonly ProcessWitness[] }): void {
  if (seen.namespaces.length === 0 && seen.witnesses.length === 0) return;
  store.transact(() => {
    const now = flexibleLaunch(store, launch.id);
    if (now === null || now.state === "exited") return;
    const namespaces = [...new Set([...now.namespaces, ...seen.namespaces])];
    const known = new Set(now.witnesses.map(one => `${one.pid}:${one.start}`));
    // Bounded: a launch that forks without end keeps its first thousand and is found by its group, namespace or folder.
    const witnesses = [...now.witnesses, ...seen.witnesses.filter(one => !known.has(`${one.pid}:${one.start}`))].slice(0, Math.max(1000, now.witnesses.length));
    store.handle.prepare("UPDATE flexible_thread_launch SET namespaces = ?, witnesses = ? WHERE id = ? AND state <> 'exited'").run(JSON.stringify(namespaces), JSON.stringify(witnesses), launch.id);
  });
}

/**
 * Watch a live launch from the holder: every half second its leader's descendants are read and any new one (pid and
 * start identity, and on Linux its pid namespace) is recorded, so a descendant that later leaves the group is still
 * known. Stops by itself when the launch settles. Returns the stop.
 */
export function watchLaunch(store: Store, launchId: string, folder: string, io: CustodyIO = defaultCustodyIO(), everyMs = 500): () => void {
  const tick = () => {
    try {
      const launch = flexibleLaunch(store, launchId);
      // Stopped from anywhere (another Toolroll process included): this holder's own proxy and relay handles close now,
      // and any that failed to close are tried again on every tick until they do.
      if (launch === null || launch.state !== "live") {
        void revokeLaunch(launchId).then(left => { if (left === 0 && (launch === null || launch.state === "exited")) clearInterval(timer); });
        return;
      }
      recordSeen(store, launch, observeCustody(custodyOf(launch, folder), io));
    } catch { /* the next tick tries again; settling never depends on this having run */ }
  };
  const timer = setInterval(tick, everyMs);
  timer.unref();
  tick();
  return () => clearInterval(timer);
}

// ---- network capabilities that end at once ----------------------------------------------------------------------------

/**
 * A launch's network ends two ways, both at once when it is stopped. Durably: its relay grants are revoked in the
 * database (flexible_relay_grant), which the relay checks on every call, so a stop from any Toolroll process ends the
 * relay's service to it. In the holder: its run proxy and its relay handle are closed here, or by the holder's watcher
 * (watchLaunch) the moment it sees the launch no longer live. A crash closes them with the process. A handle that fails
 * to close is kept and tried again until it does.
 */
const revokers = new Map<string, (() => void | Promise<void>)[]>();
export function onLaunchStopped(launchId: string, revoke: () => void | Promise<void>): void {
  revokers.set(launchId, [...revokers.get(launchId) ?? [], revoke]);
}
/** Close this holder's handles for a launch; returns how many failed (kept for the next try). */
export async function revokeLaunch(launchId: string): Promise<number> {
  const all = revokers.get(launchId) ?? [];
  const failed: (() => void | Promise<void>)[] = [];
  for (const revoke of all) { try { await revoke(); } catch { failed.push(revoke); } }
  // Handles registered while these ran are kept too.
  const added = (revokers.get(launchId) ?? []).filter(one => !all.includes(one));
  if (failed.length + added.length === 0) revokers.delete(launchId); else revokers.set(launchId, [...failed, ...added]);
  return failed.length + added.length;
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
/** Record a relay grant for a thread's turn (the token itself is never stored, only its digest). */
export function issueRelayGrant(store: Store, input: { thread: string; turn: string; clock?: FlexibleClock }): string {
  const token = `tr-relay-${randomBytes(24).toString("hex")}`;
  store.transact(() => {
    store.handle.prepare("INSERT INTO flexible_relay_grant (token_digest, thread, turn, issued_at) VALUES (?, ?, ?, ?)")
      .run(sha256(token), input.thread, input.turn, (input.clock ?? (() => new Date()))().toISOString());
  });
  return token;
}
/** Whether a relay token is a live grant: issued, never revoked, for a thread whose launch is live. The relay checks this
 * on every call, from the database, so a revocation by any process counts at once. */
export function relayGrantLive(store: Store, token: string): boolean {
  if (typeof token !== "string" || !/^tr-relay-[0-9a-f]{48}$/.test(token)) return false;
  const row = store.handle.prepare(`SELECT 1 AS ok FROM flexible_relay_grant g WHERE g.token_digest = ? AND g.revoked_at IS NULL
    AND EXISTS (SELECT 1 FROM flexible_thread_launch l WHERE l.thread = g.thread AND l.state IN ('spawning', 'live'))`).get(sha256(token));
  return row !== undefined;
}
/** Revoke every relay grant of a thread, durably. */
export function revokeRelayGrants(store: Store, thread: string, clock: FlexibleClock = () => new Date()): number {
  return store.transact(() => Number(store.handle.prepare("UPDATE flexible_relay_grant SET revoked_at = ? WHERE thread = ? AND revoked_at IS NULL").run(clock().toISOString(), thread).changes));
}

// ---- settling a launch ---------------------------------------------------------------------------------------------------

export type SettleResult =
  | { ok: true; launch: string | null; how: "nothing-running" | "never-started" | "boot-changed" | "none-left"; interrupted: number }
  | { ok: false; launch: string; survivors: number[]; blockers: CustodyBlocker[]; why: string };

/**
 * Settle the thread's unsettled launch (the caller holds the thread's lock): its network closed, then — with `stop` —
 * every process of it found and stopped, or — without — only checked; the exit verified; the record moved to `exited`
 * (live_pid cleared, the thread's running turns interrupted) or to `unresolved` (nothing replaces it). A launch still
 * `spawning` with no leader never opened its start gate: its wrapper exits by itself when the gate's pipe closes.
 */
export async function settleLaunch(store: Store, input: { thread: string; folder: string; reason: string; stop: boolean; clock?: FlexibleClock; io?: CustodyIO;
  /** A turn the caller is about to start on a fresh launch: left as it is when the old launch's turns end. */
  keepTurn?: string }): Promise<SettleResult> {
  const clock = input.clock ?? (() => new Date());
  const launch = unsettledLaunch(store, input.thread);
  if (launch === null) return { ok: true, launch: null, how: "nothing-running", interrupted: 0 };
  const io = input.io ?? defaultCustodyIO();
  if (launch.state === "spawning" && launch.leaderPid === null) {
    // Only another holder's launch can be here mid-spawn; this process's own spawns finish under the lock it holds.
    recordNeverStarted(store, launch.id, "its start gate never opened, so its agent never ran", clock);
    return { ok: true, launch: launch.id, how: "never-started", interrupted: 0 };
  }
  // Its network first: durably (the relay checks every call), then this holder's own handles.
  revokeRelayGrants(store, launch.thread, clock);
  await revokeLaunch(launch.id);
  if (input.stop) {
    store.transact(() => {
      store.handle.prepare("UPDATE flexible_thread_launch SET state = 'stopping', stop_reason = COALESCE(stop_reason, ?) WHERE id = ? AND state IN ('live', 'unresolved', 'stopping')").run(input.reason.slice(0, 200), launch.id);
    });
  }
  const custody = custodyOf(launch, input.folder);
  const outcome: CustodyOutcome = input.stop ? await stopCustody(custody, io) : custodySettled(custody, io);
  return store.transact((): SettleResult => {
    // One time for the whole record, read once the write lock is held.
    const now = clock();
    const at = now.toISOString();
    recordSeenInside(store, launch.id, outcome);
    if (!outcome.verified) {
      store.handle.prepare("UPDATE flexible_thread_launch SET state = 'unresolved', end_detail = ? WHERE id = ? AND state <> 'exited'").run(outcome.why.slice(0, 2000), launch.id);
      store.recordAction({ at, actor: "toolroll", repo: null, taskId: null, runId: null, source: "policy", action: "flexible agent custody unresolved", outcome: "unresolved",
        detail: `thread ${launch.thread} · launch ${launch.id} · ${outcome.why}` });
      return { ok: false, launch: launch.id, survivors: outcome.survivors, blockers: outcome.blockers, why: outcome.why };
    }
    const detail = outcome.how === "boot-changed" ? "the computer restarted since it was launched" : "every process of it was found stopped";
    store.handle.prepare("UPDATE flexible_thread_launch SET state = 'exited', ended_at = ?, end_detail = ? WHERE id = ? AND state <> 'exited'").run(at, detail, launch.id);
    store.handle.prepare("UPDATE flexible_thread SET live_pid = NULL, live_since = NULL WHERE id = ? AND live_pid IS ?").run(launch.thread, launch.leaderPid);
    const turns = interruptFlexibleThreadTurns(store, { thread: launch.thread, detail: `the thread's agent was stopped (${input.reason})`, clock: () => now, ...(input.keepTurn === undefined ? {} : { except: input.keepTurn }) });
    const ended = turns.ok ? turns.interrupted : 0;
    store.recordAction({ at, actor: "toolroll", repo: null, taskId: null, runId: null, source: "policy", action: "flexible agent stopped", outcome: "exited",
      detail: `thread ${launch.thread} · launch ${launch.id} · ${input.reason} · ${detail}` });
    return { ok: true, launch: launch.id, how: outcome.how, interrupted: ended };
  });
}

function recordSeenInside(store: Store, launchId: string, seen: { namespaces: readonly string[]; witnesses: readonly ProcessWitness[] }): void {
  const launch = flexibleLaunch(store, launchId);
  if (launch !== null) recordSeen(store, launch, seen);
}
