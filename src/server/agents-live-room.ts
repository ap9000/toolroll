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
}) {
  const { store, evidenceRoot, localRunner, clock, visible } = input;
  const keyOf = (account: string, scope: string) => JSON.stringify([account, scope]);
  const rooms = createLiveRooms<string, V>(key => {
    const [account] = JSON.parse(key) as [string, string];
    const tiles = agentsLiveOf(store, clock(), {
      canSee: run => run.repo !== null && visible(run.repo) && store.accountCanAccess(account, run.repo),
      localRunner,
    });
    const marks = tiles.filter(tile => tile.local).slice(0, LIVE_WATCHED_RUNS)
      .map(tile => [tile.runId, fileMark(evidenceRoot, `${tile.runId}.jsonl`), fileMark(evidenceRoot, `${tile.runId}.sub.jsonl`)]);
    const seen = tiles.map(tile => [tile.runId, tile.state, tile.why, tile.endedAt]);
    return createHash("sha256").update(JSON.stringify([seen, marks])).digest("base64url");
  }, null, { bus: input.bus, safetyNetMs: LIVE_POLL_MS });
  return { rooms, keyOf };
}
