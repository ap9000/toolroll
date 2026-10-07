/**
 * The live task page (live tasks): a task open in several browsers stays the
 * same in all of them, and each shows who else has it open. The same design
 * as the live canvas (flow-live.ts):
 *
 * - A change nudge. When the live bus says the workspace was written
 *   (live-bus.ts), one indexed read keyed by the task family's root takes
 *   the family's fingerprint (its versions' states, runs, decisions,
 *   progress checkpoints, what the agent did last, and whether each live
 *   run's worker still answers); when it changed, every open page hears
 *   "change" and reads the task again the usual way. The nudge carries no
 *   task data. With nothing written, an open page costs no reads; a
 *   30-second check heals a missed signal (and notices a lapsed worker).
 * - Who's here. Everyone else with the task open, by name, one line per
 *   person however many pages they have. Memory only; it goes when the page
 *   closes or hides.
 *
 * Streams are refresh hints only: nothing here writes, and a page that can't
 * keep one open reads itself on its usual beat.
 */
import { createHash } from "node:crypto";
import { createLiveRooms, type LiveRoomOptions, type LiveRooms, type LiveViewer } from "./live-bus.js";
import { DEFAULT_LIVENESS_MS } from "./runner.js";
import { BUILT_IN, type Store } from "./store.js";

export type TaskViewer = LiveViewer;

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

export type TaskRooms = LiveRooms<string, TaskViewer>;

/** Rooms keyed by the task family's root. With a bus, a write reaches every open page at once; without one, only the safety net. */
export function createTaskRooms(fingerprint: (root: string) => string | null, options: LiveRoomOptions = {}): TaskRooms {
  // Everyone on the task but you, once each, by name.
  return createLiveRooms<string, TaskViewer>(fingerprint,
    (viewers, me) => [...new Set(viewers.map(one => one.name).filter(name => name !== me))].sort((a, b) => a.localeCompare(b)), options);
}
