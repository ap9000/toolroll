/**
 * Live views push on write. Nothing here polls once a second.
 *
 * - The bus. The database's own revision triggers (workspace-revision.ts)
 *   move one counter on every meaningful write. After each in-process
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
 *   missed signal heals, and sends a keep-alive between.
 * - Back-pressure. Each page's stream is bounded: a page that falls behind
 *   gets nothing more until it drains, then one `reload`.
 *
 * Transport seam: a future WebSocket (live cursors) subscribes to the same
 * LiveBus beside these SSE rooms; nothing in the Store or the triggers changes.
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

/** One page's stream, bounded. Behind its limit it sends nothing more until it drains, then one `reload`. */
export class LiveStream {
  private behind = false;
  constructor(readonly response: ServerResponse, private readonly limit = STREAM_LIMIT_BYTES, private readonly recovered: () => void = () => {}) {}

  get open(): boolean { return !this.response.writableEnded && !this.response.destroyed; }

  private ready(): boolean {
    if (!this.open) return false;
    if (this.behind) return false;
    if ((this.response.writableLength ?? 0) <= this.limit) return true;
    this.behind = true;
    this.response.once("drain", () => {
      this.behind = false;
      if (!this.open) return;
      this.response.write("event: reload\ndata: {}\n\n");
      this.recovered();
    });
    return false;
  }

  send(event: string, data: unknown): void {
    if (this.ready()) this.response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  keepAlive(): void {
    if (this.ready()) this.response.write(": keep-alive\n\n");
  }
}

export type LiveViewer = { name: string; response: ServerResponse; valid: () => boolean };

export type LiveRooms<K, V extends LiveViewer> = {
  /** Keep this page's stream on the room until it closes; the first events say where it stands and who's here. */
  join: (key: K, viewer: V) => void;
  /** Every stream, ended (the server is closing). */
  close: () => void;
  size: () => number;
};

export type LiveRoomOptions = { bus?: LiveBus | null; safetyNetMs?: number; keepAliveMs?: number; limitBytes?: number };

const PRESENCE_SETTLE_MS = 150;

type Room<V> = { viewers: Map<V, LiveStream>; last: string | null; timer: NodeJS.Timeout; ticks: number; settling: NodeJS.Timeout | null; retry: NodeJS.Timeout | null };

/** Rooms of open pages that hear the bus. `presence` says who else is here, as each page should see it. */
export function createLiveRooms<K, V extends LiveViewer>(fingerprint: (key: K) => string | null,
  presence: (viewers: readonly V[], me: string) => unknown, options: LiveRoomOptions = {}): LiveRooms<K, V> {
  const bus = options.bus ?? null;
  const keepAliveMs = options.keepAliveMs ?? KEEP_ALIVE_MS;
  const checkEvery = Math.max(1, Math.round((options.safetyNetMs ?? SAFETY_NET_MS) / keepAliveMs));
  const rooms = new Map<K, Room<V>>();
  let unsubscribe: (() => void) | null = null;

  const here = (room: Room<V>, viewer: V): unknown => presence([...room.viewers.keys()], viewer.name);
  const announce = (room: Room<V>): void => {
    // A page that moves from one card to the next leaves and joins at once: say it once, after it settles.
    if (room.settling !== null) clearTimeout(room.settling);
    room.settling = setTimeout(() => {
      room.settling = null;
      for (const [viewer, stream] of room.viewers) stream.send("here", { people: here(room, viewer) });
    }, PRESENCE_SETTLE_MS);
    room.settling.unref();
  };
  const leave = (key: K, viewer: V): void => {
    const room = rooms.get(key);
    if (room === undefined || !room.viewers.delete(viewer)) return;
    if (!viewer.response.writableEnded) viewer.response.end();
    if (room.viewers.size > 0) { announce(room); return; }
    clearInterval(room.timer);
    if (room.settling !== null) clearTimeout(room.settling);
    if (room.retry !== null) clearTimeout(room.retry);
    rooms.delete(key);
    if (rooms.size === 0 && unsubscribe !== null) { unsubscribe(); unsubscribe = null; }
  };
  const drop = (key: K, viewer: V): void => {
    rooms.get(key)?.viewers.get(viewer)?.send("gone", {});
    leave(key, viewer);
  };
  /** Recheck who may still see the room, then whether what it shows moved. */
  const refresh = (key: K, room: Room<V>, revision: string | null): void => {
    // A signed-out or narrowed account stops hearing about it, at the first write after.
    for (const viewer of [...room.viewers.keys()]) {
      let ok = false;
      try { ok = viewer.valid(); } catch { ok = false; }
      if (!ok) drop(key, viewer);
    }
    if (rooms.get(key) !== room) return;
    let now: string | null;
    try { now = fingerprint(key); } catch {
      // A busy database: read again shortly rather than wait for the safety net.
      if (room.retry === null) { room.retry = setTimeout(() => { room.retry = null; if (rooms.get(key) === room) refresh(key, room, revision); }, 1_000); room.retry.unref(); }
      return;
    }
    if (now === null) { for (const viewer of [...room.viewers.keys()]) drop(key, viewer); return; }
    if (now === room.last) return;
    room.last = now;
    for (const stream of room.viewers.values()) stream.send("change", { at: now, revision: revision ?? bus?.revision() ?? null });
  };
  const tick = (key: K, room: Room<V>): void => {
    room.ticks += 1;
    if (room.ticks % checkEvery === 0) {
      const before = room.last;
      refresh(key, room, null);
      if (rooms.get(key) === room && room.last !== before) return;
    }
    for (const stream of room.viewers.values()) stream.keepAlive();
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
        const created: Room<V> = { viewers: new Map(), last, timer: setInterval(() => tick(key, created), keepAliveMs), ticks: 0, settling: null, retry: null };
        created.timer.unref();
        room = created;
        rooms.set(key, room);
        if (bus !== null && unsubscribe === null) unsubscribe = bus.subscribe(heard);
      }
      const joined = room;
      const stream = new LiveStream(viewer.response, options.limitBytes, () => {
        // Caught up after falling behind: the reload re-reads the page; say who's here again.
        if (joined.viewers.has(viewer)) stream.send("here", { people: here(joined, viewer) });
      });
      room.viewers.set(viewer, stream);
      stream.send("change", { at: room.last, revision: bus?.revision() ?? null });
      stream.send("here", { people: here(room, viewer) });
      announce(room);
      viewer.response.once("close", () => leave(key, viewer));
    },
    close() {
      for (const [key, room] of [...rooms]) for (const viewer of [...room.viewers.keys()]) leave(key, viewer);
    },
    size: () => [...rooms.values()].reduce((sum, room) => sum + room.viewers.size, 0),
  };
}
