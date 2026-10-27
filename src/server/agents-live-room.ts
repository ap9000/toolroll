/**
 * The Live grid's room (docs/plans/agents-view.md §3): one room per viewer and scope, never shared, so one viewer's
 * view is never cached for another. Every LIVE_POLL_MS it re-proves each viewer (before any read and before any send,
 * keep-alives included — createLiveRooms' own boundary), then takes the viewer's fingerprint: the tiles they may see
 * and, for this computer's runs, each live file's identity and size through the checked opener. The page hears only
 * that something it can see moved; the fingerprint is an opaque digest, never sizes or file identities. Expiry needs
 * no database write (the tiles are derived from the clock), and the room goes with its last viewer.
 */
import { createHash } from "node:crypto";
import { closeSync } from "node:fs";
import { agentsLiveOf } from "../agents-live.js";
import { createLiveRooms, type LiveBus, type LiveViewer } from "../live-bus.js";
import { openLiveTrusted } from "../live-open.js";
import type { Store } from "../store.js";
import { requestContext } from "./request-context.js";

/** How often a viewer's runs and files are looked at again. */
export const LIVE_POLL_MS = 2_000;
/** At most this many of a viewer's runs have their files looked at (the grid streams at most this many). */
export const LIVE_WATCHED_RUNS = 24;

/** One file as the room sees it: its identity and size, or that it is missing or unavailable. Never its contents. */
function fileMark(root: string, name: string): string {
  const opened = openLiveTrusted(root, name);
  if (typeof opened === "string") return opened;
  try { return `${opened.gen}/${opened.size}`; } finally { closeSync(opened.fd); }
}

export function createAgentsLiveRooms<V extends LiveViewer>(input: {
  store: Store;
  bus: LiveBus;
  evidenceRoot: string;
  localRunner: string | undefined;
  clock: () => Date;
  /** Whether the console shows this project at all (its ceiling). */
  visible: (repo: string | null) => boolean;
  /** The keyed viewer's own lead tiles as they stand now (agents-live-lead.ts), proved from their saved session. */
  leads?: (key: string) => unknown;
}) {
  const { store, evidenceRoot, localRunner, clock, visible } = input;
  const keyOf = (account: string, scope: string, page = "") => JSON.stringify([account, scope, page]);
  /** One look at a run's two files, shared by every viewer's room: at most once per LIVE_POLL_MS per run, however
   * many viewers or bus signals there are (a burst of writes re-proves at once, but never opens files more often). */
  const looked = new Map<number, { at: number; marks: [string, string] | null }>();
  const marksOf = (runId: number, stillSees: () => boolean): [string, string] | null => {
    // A run's files are this viewer's to look at (or have looked at) only while the run is still theirs and this
    // computer's, proved from its row now — a look another viewer's room took included.
    if (!stillSees()) return null;
    const now = Date.now();
    const kept = looked.get(runId);
    // One attempt per run per poll, whether it looked or stopped part-way: nothing makes files opened more often.
    if (kept !== undefined && now - kept.at < LIVE_POLL_MS) return kept.marks;
    looked.set(runId, { at: now, marks: null });
    const main = fileMark(evidenceRoot, `${runId}.jsonl`);
    if (!stillSees()) return null;
    const sub = fileMark(evidenceRoot, `${runId}.sub.jsonl`);
    if (!stillSees()) return null;
    const marks: [string, string] = [main, sub];
    looked.set(runId, { at: now, marks });
    return marks;
  };
  const rooms = createLiveRooms<string, V>(key => {
    const [account] = JSON.parse(key) as [string, string];
    // Read as the keyed account (its own request context), never as whoever's write woke the bus.
    return requestContext.run({ actor: account, csrf: "", returnTo: "/agents" }, () => {
      const sees = (runId: number) => () => {
        const run = store.getRun(runId);
        const repo = run === null ? null : store.refForId(run.taskRef)?.repo ?? null;
        return run !== null && repo !== null && visible(repo) && store.accountCanAccess(account, repo) && localRunner !== undefined && run.runner === localRunner;
      };
      const tiles = agentsLiveOf(store, clock(), {
        canSee: run => run.repo !== null && visible(run.repo) && store.accountCanAccess(account, run.repo),
        localRunner,
      });
      const marks = tiles.filter(tile => tile.local).slice(0, LIVE_WATCHED_RUNS).map(tile => [tile.runId, marksOf(tile.runId, sees(tile.runId))]);
      for (const [runId] of [...looked]) if (Date.now() - looked.get(runId)!.at > 10 * LIVE_POLL_MS) looked.delete(runId);
      // The digest's every run proved again from its current row after the looks: one that left view isn't in it.
      const still = (runId: number) => {
        const run = store.getRun(runId);
        const repo = run === null ? null : store.refForId(run.taskRef)?.repo ?? null;
        return repo !== null && visible(repo) && store.accountCanAccess(account, repo);
      };
      const kept = new Set(tiles.filter(tile => still(tile.runId)).map(tile => tile.runId));
      const seen = tiles.filter(tile => kept.has(tile.runId)).map(tile => [tile.runId, tile.state, tile.why, tile.endedAt]);
      const shownMarks = marks.filter(([runId]) => kept.has(runId as number) && (!tiles.find(tile => tile.runId === runId)?.local || sees(runId as number)()));
      return createHash("sha256").update(JSON.stringify([seen, shownMarks, input.leads?.(key) ?? null])).digest("base64url");
    });
  }, null, { bus: input.bus, safetyNetMs: LIVE_POLL_MS });
  return { rooms, keyOf, looked: () => looked.size };
}
