/**
 * The live canvas (v88): a flow open in several browsers stays the same in
 * all of them, and each shows who else has it open.
 *
 * - A change nudge. When the live bus says the workspace was written
 *   (live-bus.ts), one small read checks the flow's fingerprint (its revision, cards, moves, comments,
 *   watchers, step runs, linked task progress and triggers); when it changed, every open page
 *   hears "change" and reads the flow again the usual way. The nudge
 *   carries no card data: what a page shows is always what its own read
 *   returned, under its own checks.
 * - Who's here. Each open page says which card it has open and whether it
 *   is changing the flow; everyone else on the flow hears the list, by
 *   name. It lives in memory only and goes when the page closes or hides.
 *
 * Streams are refresh hints only: nothing here writes, and a page that
 * can't keep one open falls back to reading every few seconds. With nothing
 * written, an open flow costs no reads; a 30-second check heals a miss.
 */
import { createHash } from "node:crypto";
import { createLiveRooms, type LiveRoomOptions, type LiveRooms, type LiveViewer } from "./live-bus.js";
import type { Statement, Store } from "./store.js";

export type FlowPresence = { name: string; cards: number[]; editing: boolean };
export type FlowViewer = LiveViewer & { card: number | null; editing: boolean };


// Statements belong to their database, without keeping closed Stores alive.
const fingerprintStatements = new WeakMap<Store["handle"], Statement>();

function fingerprintStatement(store: Store): Statement {
  const cached = fingerprintStatements.get(store.handle);
  if (cached !== undefined) return cached;
  // Match Store.taskFamilyOf/taskFamilyProjection: built-in tasks, same-repo
  // edges, a revision brief bound to the parent's run, and at most 63 edges.
  // Walk up only from active cards, then down from their proven roots. A
  // missing/invalid/cyclic/over-depth ancestry leaves the linked task alone.
  const statement = store.handle.prepare(`WITH RECURSIVE linked AS MATERIALIZED (
      SELECT DISTINCT tr.id AS ref_id, tr.external_id AS id, tr.repo, tr.revision_of, tr.revision_brief_artifact
      FROM flow_card c JOIN task_ref tr ON tr.external_id = c.task AND tr.backend = 'built-in'
      JOIN task t ON t.id = tr.external_id
      WHERE c.flow = $flow AND c.state = 'active' AND tr.repo IS NOT NULL
    ), ancestors(linked_ref, ref_id, id, repo, revision_of, revision_brief_artifact, depth) AS (
      SELECT ref_id, ref_id, id, repo, revision_of, revision_brief_artifact, 0 FROM linked
      UNION ALL
      SELECT child.linked_ref, parent.id, parent.external_id, parent.repo, parent.revision_of, parent.revision_brief_artifact, child.depth + 1
      FROM ancestors child
      JOIN task_ref parent ON parent.backend = 'built-in' AND parent.external_id = child.revision_of AND parent.repo IS child.repo
      JOIN task t ON t.id = parent.external_id
      JOIN artifact brief ON brief.id = child.revision_brief_artifact AND brief.kind = 'revision-brief'
      JOIN run source_run ON source_run.id = brief.run AND source_run.task_ref = parent.id
      WHERE child.depth < 63
    ), roots AS MATERIALIZED (
      SELECT DISTINCT ref_id, id, repo FROM ancestors WHERE revision_of IS NULL
    ), descendants(ref_id, id, repo, depth) AS (
      SELECT ref_id, id, repo, 0 FROM roots
      UNION ALL
      SELECT child.id, child.external_id, child.repo, parent.depth + 1 FROM descendants parent
      JOIN task_ref child ON child.backend = 'built-in' AND child.revision_of = parent.id AND child.repo IS parent.repo
      JOIN task t ON t.id = child.external_id
      JOIN artifact brief ON brief.id = child.revision_brief_artifact AND brief.kind = 'revision-brief'
      JOIN run source_run ON source_run.id = brief.run AND source_run.task_ref = parent.ref_id
      WHERE parent.depth < 63
    ), members AS (
      SELECT ref_id FROM descendants
      UNION
      SELECT ref_id FROM linked WHERE NOT EXISTS (
        SELECT 1 FROM ancestors WHERE linked_ref = linked.ref_id AND revision_of IS NULL
      )
    ) SELECT f.state || '|' || f.revision || '|' || f.updated_at || '|' || coalesce(f.owner, '') AS head,
    (SELECT count(*) || ':' || coalesce(max(updated_at), '') FROM flow_card WHERE flow = f.id) AS cards,
    (SELECT coalesce(max(e.id), 0) FROM flow_event e JOIN flow_card c ON c.id = e.card WHERE c.flow = f.id) AS moves,
    (SELECT coalesce(max(m.id), 0) FROM flow_comment m JOIN flow_card c ON c.id = m.card WHERE c.flow = f.id) AS comments,
    (SELECT count(*) || ':' || coalesce(max(w.added_at), '') FROM flow_card_watcher w JOIN flow_card c ON c.id = w.card WHERE c.flow = f.id) AS watchers,
    (SELECT count(*) || ':' || coalesce(sum(r.attempts), 0) || ':' || coalesce(max(coalesce(r.finished_at, r.started_at)), '') || ':' || coalesce(sum(r.state = 'running'), 0)
       FROM flow_step_run r JOIN flow_card c ON c.id = r.card WHERE c.flow = f.id) AS runs,
    (SELECT count(*) || ':' || coalesce(max(updated_at), '') || ':' || coalesce(max(last_at), '') || ':' || coalesce(sum(failures), 0) FROM flow_trigger WHERE flow = f.id) AS triggers,
    (SELECT json_group_array(json_array(tr.id, t.id, t.state, t.updated_at, tr.plan,
       s.digest, s.approved_digest, s.approved_at,
       (SELECT max(p.id) FROM run_checkpoint p WHERE p.task_ref = tr.id),
       (SELECT q.lease_id FROM claim q WHERE q.task_ref = tr.id AND q.released_at IS NULL AND q.expires_at > $now ORDER BY q.lease_generation DESC LIMIT 1),
       (SELECT json_group_array(json_array(r.id, r.outcome, r.finished_at, r.reason,
          (SELECT json_array(k.status, k.exit_code, k.updated_at) FROM run_check k WHERE k.run = r.id)) ORDER BY r.id) FROM run r WHERE r.task_ref = tr.id),
       (SELECT json_group_array(json_array(d.id, d.state, d.question, d.answered_at) ORDER BY d.id) FROM decision d JOIN run r ON r.id = d.run WHERE r.task_ref = tr.id),
       (SELECT json_group_array(json_array(h.id, h.reason) ORDER BY h.id) FROM hold h WHERE h.task_ref = tr.id AND (h.until IS NULL OR h.until > $now)),
       (SELECT max(a.id) FROM action_ledger a WHERE a.task_id = t.id)) ORDER BY tr.id)
     FROM task_ref tr JOIN task t ON t.id = tr.external_id
     LEFT JOIN task_scope s ON s.task_id = t.id
     WHERE tr.id IN (SELECT ref_id FROM members)) AS tasks
    FROM flow f WHERE f.id = $flow`);
  fingerprintStatements.set(store.handle, statement);
  return statement;
}

/** What changes when anything on the canvas changes: metadata only, kept short and opaque. */
export function flowFingerprint(store: Store, flow: number, now = new Date()): string | null {
  // A revision can progress while its card still links to the original task,
  // including a build in another project. The page read admits the viewer;
  // this stream only carries a hash. No evidence files or logs are read.
  const row = fingerprintStatement(store).get({ $flow: flow, $now: now.toISOString() });
  return row === undefined ? null : createHash("sha256").update(Object.values(row).map(String).join("|")).digest("hex").slice(0, 16);
}

export type FlowRooms = LiveRooms<number, FlowViewer>;

/** Rooms keyed by flow. With a bus, a write reaches every open page at once; without one, only the safety net. */
export function createFlowRooms(fingerprint: (flow: number) => string | null, options: LiveRoomOptions = {}): FlowRooms {
  /** Everyone on the flow but you, one line per person however many pages they have open. */
  const others = (viewers: readonly FlowViewer[], me: string): FlowPresence[] => {
    const people = new Map<string, FlowPresence>();
    for (const one of viewers) {
      if (one.name === me) continue;
      const seen = people.get(one.name) ?? { name: one.name, cards: [], editing: false };
      if (one.card !== null && !seen.cards.includes(one.card)) seen.cards.push(one.card);
      seen.editing ||= one.editing;
      people.set(one.name, seen);
    }
    return [...people.values()].sort((a, b) => a.name.localeCompare(b.name));
  };
  return createLiveRooms<number, FlowViewer>(fingerprint, others, options);
}
