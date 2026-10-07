/**
 * The live task page (live tasks): a task open in several browsers stays the
 * same in all of them, and each shows who else has it open. The same design
 * as the live canvas (flow-live.ts):
 *
 * - A change nudge. While anyone has a task open, one indexed read a second,
 *   keyed by the task family's root, takes the family's fingerprint (its
 *   versions' states, runs, decisions, progress checkpoints, what the agent
 *   did last, and whether each live run's worker still answers); when it
 *   changes, every open page hears "change" and reads the task again the
 *   usual way. The nudge carries no task data.
 * - Who's here. Everyone else with the task open, by name, one line per
 *   person however many pages they have. Memory only; it goes when the page
 *   closes or hides.
 *
 * Streams are refresh hints only: nothing here writes, and a page that can't
 * keep one open reads itself on its usual beat.
 */
import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";
import { DEFAULT_LIVENESS_MS } from "./runner.js";
import { BUILT_IN, type Store } from "./store.js";

export type TaskViewer = { name: string; response: ServerResponse; valid: () => boolean };

const TICK_MS = 1_000;
const CHECK_EVERY = 15;
const HEARTBEAT_EVERY = 15;
const PRESENCE_SETTLE_MS = 150;

/** What changes when anything on the task page changes: one read over the family, kept short and opaque. */
export function taskFingerprint(store: Store, root: string, now: Date, livenessMs = DEFAULT_LIVENESS_MS): string | null {
  const row = store.handle.prepare(`WITH RECURSIVE family(ref, ext, depth) AS (
      SELECT id, external_id, 0 FROM task_ref WHERE backend = ?3 AND external_id = ?1
      UNION
      SELECT child.id, child.external_id, family.depth + 1 FROM family
        JOIN task_ref child ON child.backend = ?3 AND child.revision_of = family.ext WHERE family.depth < 63
    )
    SELECT (SELECT count(*) || ':' || group_concat(t.state || '@' || t.updated_at, ',') FROM family JOIN task t ON t.id = family.ext) AS tasks,
      (SELECT count(*) || ':' || coalesce(max(r.id), 0) || ':' || coalesce(sum(r.outcome IS NULL), 0) || ':' || coalesce(max(coalesce(r.finished_at, r.started_at)), '') || ':' || coalesce(group_concat(r.phase), '')
         FROM run r WHERE r.task_ref IN (SELECT ref FROM family)) AS runs,
      (SELECT count(*) || ':' || coalesce(max(d.id), 0) || ':' || coalesce(sum(d.state = 'answered'), 0) FROM decision d JOIN run r ON r.id = d.run WHERE r.task_ref IN (SELECT ref FROM family)) AS decisions,
      (SELECT coalesce(max(c.id), 0) FROM run_checkpoint c WHERE c.task_ref IN (SELECT ref FROM family)) AS progress,
      (SELECT coalesce(max(a.at), '') FROM run_activity a JOIN run r ON r.id = a.run WHERE r.task_ref IN (SELECT ref FROM family) AND r.outcome IS NULL) AS activity,
      (SELECT coalesce(group_concat(w.heartbeat_at > ?2), '') FROM run r JOIN runner w ON w.name = r.runner WHERE r.task_ref IN (SELECT ref FROM family) AND r.outcome IS NULL) AS workers
    WHERE EXISTS (SELECT 1 FROM family)`).get(root, new Date(now.getTime() - livenessMs).toISOString(), BUILT_IN) as Record<string, unknown> | undefined;
  return row === undefined ? null : createHash("sha256").update(Object.values(row).map(String).join("|")).digest("hex").slice(0, 16);
}

type Room = { viewers: Set<TaskViewer>; last: string | null; timer: NodeJS.Timeout | null; ticks: number; settling: NodeJS.Timeout | null };

export type TaskRooms = {
  /** Keep this page's stream on the task family until it closes; the first events say where it stands and who's here. */
  join: (root: string, viewer: TaskViewer) => void;
  /** Every stream, ended (the server is closing). */
  close: () => void;
  size: () => number;
};

export function createTaskRooms(fingerprint: (root: string) => string | null, tickMs = TICK_MS): TaskRooms {
  const rooms = new Map<string, Room>();
  const write = (viewer: TaskViewer, event: string, data: unknown): void => {
    if (viewer.response.writableEnded || viewer.response.destroyed) return;
    viewer.response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  /** Everyone on the task but you, once each, by name. */
  const others = (room: Room, me: string): string[] =>
    [...new Set([...room.viewers].map(one => one.name).filter(name => name !== me))].sort((a, b) => a.localeCompare(b));
  const announce = (room: Room): void => {
    if (room.settling !== null) clearTimeout(room.settling);
    room.settling = setTimeout(() => {
      room.settling = null;
      for (const viewer of room.viewers) write(viewer, "here", { people: others(room, viewer.name) });
    }, PRESENCE_SETTLE_MS);
    room.settling.unref();
  };
  const leave = (root: string, viewer: TaskViewer): void => {
    const room = rooms.get(root);
    if (room === undefined || !room.viewers.delete(viewer)) return;
    if (!viewer.response.writableEnded) viewer.response.end();
    if (room.viewers.size > 0) { announce(room); return; }
    if (room.timer !== null) clearInterval(room.timer);
    if (room.settling !== null) clearTimeout(room.settling);
    rooms.delete(root);
  };
  const tick = (root: string, room: Room): void => {
    room.ticks += 1;
    if (room.ticks % CHECK_EVERY === 0) {
      // A signed-out or narrowed account stops hearing about the task.
      for (const viewer of [...room.viewers]) if (!viewer.valid()) { write(viewer, "gone", {}); leave(root, viewer); }
      if (!rooms.has(root)) return;
    }
    let now: string | null;
    try { now = fingerprint(root); } catch { return; /* a busy database: the next tick reads again */ }
    if (now === null) { for (const viewer of [...room.viewers]) { write(viewer, "gone", {}); leave(root, viewer); } return; }
    if (now !== room.last) {
      room.last = now;
      for (const viewer of room.viewers) write(viewer, "change", { at: now });
    } else if (room.ticks % HEARTBEAT_EVERY === 0) {
      for (const viewer of room.viewers) if (!viewer.response.writableEnded) viewer.response.write(": keep-alive\n\n");
    }
  };
  return {
    join(root, viewer) {
      let room = rooms.get(root);
      if (room === undefined) {
        let last: string | null = null;
        try { last = fingerprint(root); } catch { /* the first tick reads it */ }
        room = { viewers: new Set(), last, timer: null, ticks: 0, settling: null };
        const created = room;
        room.timer = setInterval(() => tick(root, created), tickMs);
        room.timer.unref();
        rooms.set(root, room);
      }
      room.viewers.add(viewer);
      write(viewer, "change", { at: room.last });
      write(viewer, "here", { people: others(room, viewer.name) });
      announce(room);
      viewer.response.once("close", () => leave(root, viewer));
    },
    close() {
      for (const [root, room] of [...rooms]) for (const viewer of [...room.viewers]) leave(root, viewer);
    },
    size: () => [...rooms.values()].reduce((sum, room) => sum + room.viewers.size, 0),
  };
}
