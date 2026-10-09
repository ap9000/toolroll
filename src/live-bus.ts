/**
 * Live views push on write. Nothing here polls once a second.
 *
 * - The bus. Every connection's write wrapper (workspace-revision.ts)
 *   moves one counter per committed meaningful write. After each in-process
 *   transact() COMMIT, and whenever another process (the worker, the CLI)
 *   writes the database's write-ahead log, the revision is read once; when
 *   it moved, every subscriber hears `{ revision }`. A rolled-back or quiet
 *   write moves nothing and says nothing. A page left open with nothing
 *   being written costs no database work at all.
 * - The rooms. Each open task or flow is a room keyed by what it shows.
 *   When the bus speaks, a room rechecks every viewer's access (a signed-out
 *   or narrowed account is dropped), takes its fingerprint once, and only if
 *   that moved tells its pages `change` with the fingerprint and revision —
 *   an invalidation, never content. The page reads itself again under its
 *   own checks, so redaction stays the page's.
 * - The safety net. Every room also checks itself about every 30 s, so a
 *   missed signal heals; the page's connection sends a keep-alive between,
 *   each after every room proves its viewer again.
 * - One connection per page. A page opens one stream (GET /live) and joins
 *   every room it shows; each event names its room.
 * - Back-pressure. Each page's stream is bounded: a page that falls behind
 *   gets one `reload` and ends so its EventSource can reconnect.
 *
 * Transport seam: a future WebSocket (live cursors) subscribes to the same
 * LiveBus beside these SSE rooms; nothing in the Store or its write wrapper changes.
 */
import { watch, type FSWatcher } from "node:fs";
import type { ServerResponse } from "node:http";
import type { Store } from "./store.js";
import { WORKSPACE_REVISION_KEY } from "./workspace-revision.js";

export type LiveChange = { revision: string };

export type LiveBus = {
  subscribe: (listener: (change: LiveChange) => void) => () => void;
  publish: (change: LiveChange) => void;
  /** The last revision heard, if any. */
  revision: () => string | null;
  listeners: () => number;
};

export function createLiveBus(): LiveBus {
  const listeners = new Set<(change: LiveChange) => void>();
  let last: string | null = null;
  return {
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    publish(change) {
      last = change.revision;
      for (const listener of [...listeners]) { try { listener(change); } catch { /* one room never stops another */ } }
    },
    revision: () => last,
    listeners: () => listeners.size,
  };
}

const SIGNAL = "toolroll_live_written";

export type WorkspaceFollower = { close: () => void; /** Read the revision now (tests, and a commit signal). */ check: () => void };

/**
 * Publish the workspace revision when it moves: after this process commits,
 * and when the database's write-ahead log changes under another process.
 * Signals in one turn of the event loop coalesce into one read.
 */
export function followWorkspace(store: Store, current: () => string, bus: LiveBus,
  options: { file?: string | null; watchFile?: (path: string, listener: () => void) => FSWatcher | null } = {}): WorkspaceFollower {
  let last: string | null = null;
  try { last = current(); } catch { /* the first signal reads it */ }
  let scheduled = false, closed = false;
  let timer: NodeJS.Timeout | null = null;
  const check = (): void => {
    scheduled = false;
    timer = null;
    if (closed) return;
    // Never read inside an open transaction: what it wrote isn't committed yet.
    if ((store.handle as { isTransaction?: boolean }).isTransaction === true) { schedule(10); return; }
    let now: string;
    try { now = current(); } catch { schedule(250); return; /* busy: read again shortly */ }
    if (now === last) return;
    last = now;
    bus.publish({ revision: now });
  };
  const schedule = (delay = 0): void => {
    // With no page open, nobody needs the read.
    if (scheduled || closed || bus.listeners() === 0) return;
    scheduled = true;
    timer = setTimeout(check, delay);
    timer.unref?.();
  };
  const unhook = store.onCommit(() => schedule());
  // A write this process makes outside transact() (an autocommit statement)
  // moves the revision too: a connection-local TEMP trigger on the revision
  // row calls back here. Other processes never see it. The read waits for
  // the statement's own commit, and a rollback leaves the revision unmoved.
  let signalled = false;
  const db = store.handle as unknown as { function?: (name: string, options: { deterministic: boolean }, fn: () => null) => void; exec: (sql: string) => void };
  if (typeof db.function === "function") {
    try {
      db.function(SIGNAL, { deterministic: false }, () => { if (!closed) schedule(); return null; });
      db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS ${SIGNAL}_update AFTER UPDATE ON main.service_cursor WHEN NEW.key = '${WORKSPACE_REVISION_KEY}' BEGIN SELECT ${SIGNAL}(); END;
        CREATE TEMP TRIGGER IF NOT EXISTS ${SIGNAL}_insert AFTER INSERT ON main.service_cursor WHEN NEW.key = '${WORKSPACE_REVISION_KEY}' BEGIN SELECT ${SIGNAL}(); END;`);
      signalled = true;
    } catch { /* commits and the safety net still reach the rooms */ }
  }
  const file = options.file ?? null;
  let watcher: FSWatcher | null = null;
  if (file !== null) {
    const start = options.watchFile ?? ((path, listener) => { try { return watch(path, { persistent: false }, listener); } catch { return null; } });
    // The worker and CLI write from their own processes; their commits land in the WAL.
    watcher = start(`${file}-wal`, () => schedule());
    watcher?.on?.("error", () => { watcher?.close(); watcher = null; });
  }
  return {
    check,
    close() {
      closed = true;
      if (timer !== null) clearTimeout(timer);
      unhook(); watcher?.close(); watcher = null;
      if (signalled) { try { db.exec(`DROP TRIGGER IF EXISTS temp.${SIGNAL}_update; DROP TRIGGER IF EXISTS temp.${SIGNAL}_insert;`); } catch { /* the database is closing */ } }
    },
  };
}

/** About every 30 s a room checks itself; a keep-alive goes between. */
export const SAFETY_NET_MS = 30_000;
export const KEEP_ALIVE_MS = 15_000;
/** What a page's stream may hold unsent before it is "behind". */
export const STREAM_LIMIT_BYTES = 32 * 1024;

/** One page's stream, bounded. Overflow is terminal, even below Node's drain threshold. */
export class LiveStream {
  private ended = false;
  constructor(readonly response: ServerResponse, private readonly limit = STREAM_LIMIT_BYTES, private readonly onOverflow: () => void = () => {}) {}

  get open(): boolean { return !this.ended && !this.response.writableEnded && !this.response.destroyed; }

  private overflow(): void {
    if (!this.open) return;
    this.ended = true;
    // end(data) queues at most this final frame; it never waits for a drain
    // that Node may not emit when our limit is below its high-water mark.
    try { this.response.end("event: reload\ndata: {}\n\n"); }
    finally { this.onOverflow(); }
  }

  private write(frame: string): void {
    if (!this.open) return;
    if (this.response.writableLength > this.limit) { this.overflow(); return; }
    this.response.write(frame);
    if (this.response.writableLength > this.limit) this.overflow();
  }

  send(event: string, data: unknown): void {
    this.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  keepAlive(): void {
    this.write(": keep-alive\n\n");
  }
}

/**
 * One page's live connection: its bounded stream, one keep-alive, and every
 * room it joined. Each event names its room, so one EventSource serves the
 * whole page. It ends when the page goes, when it falls behind (one
 * `reload`), or when its last room lets it go. A keep-alive is a delivery
 * too: every room proves its viewer again first, so a page whose session
 * lapsed with nothing written hears its rooms go, never another frame.
 */
export class LiveConnection {
  readonly stream: LiveStream;
  private readonly leaves = new Set<() => void>();
  private readonly proofs = new Set<() => void>();
  private readonly timer: NodeJS.Timeout;
  private closed = false;
  constructor(readonly response: ServerResponse, options: { limitBytes?: number; keepAliveMs?: number } = {}) {
    this.stream = new LiveStream(response, options.limitBytes, () => this.close());
    this.timer = setInterval(() => this.keepAlive(), options.keepAliveMs ?? KEEP_ALIVE_MS);
    this.timer.unref();
    response.once("close", () => this.close());
  }
  private keepAlive(): void {
    for (const prove of [...this.proofs]) { if (!this.open) return; prove(); }
    if (this.open) this.stream.keepAlive();
  }
  /** Run before each keep-alive: a room proves its viewer again (and leaves if it no longer passes). Returns the undo. */
  onKeepAlive(prove: () => void): () => void { this.proofs.add(prove); return () => { this.proofs.delete(prove); }; }
  get open(): boolean { return !this.closed && this.stream.open; }
  /** An event for one room: its data says which. */
  send(room: string, event: string, data: Record<string, unknown> = {}): void { this.stream.send(event, { room, ...data }); }
  /** Run when the connection ends; returns the undo for a room that leaves first. */
  onClose(leave: () => void): () => void { this.leaves.add(leave); return () => { this.leaves.delete(leave); }; }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    for (const leave of [...this.leaves]) leave();
    this.leaves.clear();
    this.proofs.clear();
    if (!this.response.writableEnded) this.response.end();
  }
  /** Rooms joined and not yet left. */
  get rooms(): number { return this.leaves.size; }
}

/** One page in one room: who, the room's name as the page asked for it, the page's connection, and its re-proof. */
export type LiveViewer = { name: string; room: string; connection: LiveConnection; valid: () => boolean };

export type LiveRooms<K, V extends LiveViewer> = {
  /** Keep this page on the room until it leaves; the first events say where the room stands (and who's here). */
  join: (key: K, viewer: V) => void;
  /** Every page leaves (the server is closing). */
  close: () => void;
  size: () => number;
};

/** `minIntervalMs`: a busy room says `change` at most this often — the first at once, the latest after. */
export type LiveRoomOptions = { bus?: LiveBus | null; safetyNetMs?: number; minIntervalMs?: number };

const PRESENCE_SETTLE_MS = 150;

type Room<V> = { viewers: Map<V, () => void>; last: string | null; timer: NodeJS.Timeout; settling: NodeJS.Timeout | null; retry: NodeJS.Timeout | null;
  saidAt: number; holding: NodeJS.Timeout | null; revision: string | null };

/**
 * Rooms of open pages that hear the bus. `presence` says who else is here, as
 * each page should see it (null: the room has no presence). A viewer that no
 * longer passes its re-proof hears `gone` and leaves; a room whose subject is
 * gone (fingerprint null) sends everyone `gone`. A connection with no rooms
 * left ends.
 */
export function createLiveRooms<K, V extends LiveViewer>(fingerprint: (key: K) => string | null,
  presence: ((viewers: readonly V[], me: string) => unknown) | null, options: LiveRoomOptions = {}): LiveRooms<K, V> {
  const bus = options.bus ?? null;
  const safetyNetMs = options.safetyNetMs ?? SAFETY_NET_MS;
  const minIntervalMs = options.minIntervalMs ?? 0;
  const rooms = new Map<K, Room<V>>();
  let unsubscribe: (() => void) | null = null;

  const announce = (key: K, room: Room<V>): void => {
    if (presence === null || rooms.get(key) !== room) return;
    // A page that moves from one card to the next leaves and joins at once: say it once, after it settles.
    if (room.settling !== null) clearTimeout(room.settling);
    room.settling = setTimeout(() => {
      room.settling = null;
      for (const viewer of [...room.viewers.keys()]) deliver(key, room, viewer, "here", { people: presence([...room.viewers.keys()], viewer.name) });
    }, PRESENCE_SETTLE_MS);
    room.settling.unref();
  };
  const leave = (key: K, viewer: V): void => {
    const room = rooms.get(key);
    const forget = room?.viewers.get(viewer);
    if (room === undefined || forget === undefined) return;
    room.viewers.delete(viewer);
    forget();
    // The page's last room: its connection has nothing left to say.
    if (viewer.connection.rooms === 0) viewer.connection.close();
    if (room.viewers.size > 0) { announce(key, room); return; }
    clearInterval(room.timer);
    if (room.settling !== null) clearTimeout(room.settling);
    if (room.retry !== null) clearTimeout(room.retry);
    if (room.holding !== null) clearTimeout(room.holding);
    rooms.delete(key);
    if (rooms.size === 0 && unsubscribe !== null) { unsubscribe(); unsubscribe = null; }
  };
  /** The final delivery boundary, including queued frames and sends that may overflow. */
  const deliver = (key: K, room: Room<V>, viewer: V, event?: "change" | "here" | "gone", data: Record<string, unknown> = {}): boolean => {
    if (rooms.get(key) !== room || !room.viewers.has(viewer)) return false;
    if (!viewer.connection.open) { leave(key, viewer); return false; }
    let valid = false;
    try { valid = viewer.valid(); } catch { /* A failed proof releases only this room. */ }
    if (!valid || event === "gone") {
      // A failed proof may send only the generic departure, never the pending room data.
      try { viewer.connection.send(viewer.room, "gone"); }
      finally { leave(key, viewer); }
      return false;
    }
    if (event !== undefined) viewer.connection.send(viewer.room, event, data);
    return viewer.connection.open && room.viewers.has(viewer);
  };
  /** Recheck who may still see the room, then whether what it shows moved. */
  const refresh = (key: K, room: Room<V>, revision: string | null): void => {
    // A signed-out or narrowed account stops hearing about it, at the first write after.
    for (const viewer of [...room.viewers.keys()]) deliver(key, room, viewer);
    if (rooms.get(key) !== room) return;
    let now: string | null;
    try { now = fingerprint(key); } catch {
      // A busy database: read again shortly rather than wait for the safety net.
      if (room.retry === null) { room.retry = setTimeout(() => { room.retry = null; if (rooms.get(key) === room) refresh(key, room, revision); }, 1_000); room.retry.unref(); }
      return;
    }
    if (now === null) { for (const viewer of [...room.viewers.keys()]) deliver(key, room, viewer, "gone"); return; }
    if (now === room.last) return;
    room.last = now;
    room.revision = revision ?? bus?.revision() ?? null;
    if (room.holding !== null) return;
    const wait = room.saidAt + minIntervalMs - Date.now();
    if (wait > 0) { room.holding = setTimeout(() => { room.holding = null; if (rooms.get(key) === room) say(key, room); }, wait); room.holding.unref(); return; }
    say(key, room);
  };
  const say = (key: K, room: Room<V>): void => {
    room.saidAt = Date.now();
    for (const viewer of [...room.viewers.keys()]) deliver(key, room, viewer, "change", { at: room.last, revision: room.revision });
  };
  const heard = (change: LiveChange): void => {
    for (const [key, room] of [...rooms]) refresh(key, room, change.revision);
  };

  return {
    join(key, viewer) {
      let room = rooms.get(key);
      if (room === undefined) {
        let last: string | null = null;
        try { last = fingerprint(key); } catch { /* the next signal or the safety net reads it */ }
        const created: Room<V> = { viewers: new Map(), last, timer: setInterval(() => refresh(key, created, null), safetyNetMs), settling: null, retry: null, saidAt: 0, holding: null, revision: null };
        created.timer.unref();
        room = created;
        rooms.set(key, room);
        if (bus !== null && unsubscribe === null) unsubscribe = bus.subscribe(heard);
      }
      const joined = room;
      const forget = viewer.connection.onClose(() => leave(key, viewer));
      const unprove = viewer.connection.onKeepAlive(() => { deliver(key, joined, viewer); });
      room.viewers.set(viewer, () => { forget(); unprove(); });
      if (!deliver(key, room, viewer, "change", { at: room.last, revision: bus?.revision() ?? null }) || presence === null) return;
      if (deliver(key, room, viewer, "here", { people: presence([...room.viewers.keys()], viewer.name) })) announce(key, room);
    },
    close() {
      for (const [key, room] of [...rooms]) for (const viewer of [...room.viewers.keys()]) leave(key, viewer);
    },
    size: () => [...rooms.values()].reduce((sum, room) => sum + room.viewers.size, 0),
  };
}
