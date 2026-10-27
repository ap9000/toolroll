/**
 * Lead tiles on the Live grid (docs/plans/agents-view.md slice 8): the viewer's OWN lead chat turns, and only through
 * the chat room's own admission — an approver with a lead standing, the thread theirs, open, the newest for its scope,
 * never a team conversation, under the ceiling it opened with, and its project or task still theirs to see. Team
 * threads wait for their own admission. The words go through one stateful redactor per turn (one key state carried
 * across every step and every line of the turn's current snapshot), then controls out, then a cap. Memory only: the
 * tile is the live turn's, and leaves with it (60 s after the turn ends).
 */
import type { LeadLiveStep, LeadLiveTool } from "../lead-progress.js";
import { capLive, liveLine, redactLiveLines, type KeyState } from "../live-records.js";
import { projectChatHref, taskChatHref } from "./http.js";
import type { LiveTurn } from "./render-chat.js";
import type { ServerRuntime } from "./runtime.js";
import type { Who } from "./session.js";

/** A lead tile keeps at most this many lines, and this many bytes of them (the newest). */
export const LEAD_LINES = 200, LEAD_BYTES = 32 * 1024;

export type LeadTile = {
  thread: number;
  /** The turn being answered (lead.ts's turn id), once the turn has said it. */
  turn: number | null;
  scope: "lead" | "project" | "task";
  title: string;
  project: string | null;
  state: "working" | "done" | "failed";
  startedAt: string;
  endedAt: string | null;
  /** When each step began. */
  stepAt: string[];
  /** What it is doing now, in fixed words; null once it ended. */
  doing: string | null;
  lines: string[];
  /** Whether older lines were cut to fit. */
  earlier: boolean;
  chatHref: string;
  taskHref: string | null;
};

/** A tool's line: fixed copy from lead-progress.ts (labels and failure reasons), still cleaned and cut. */
function toolLine(tool: LeadLiveTool): string {
  return liveLine(tool.state === "running" ? `· ${tool.label}…` : tool.state === "failed" ? `· ${tool.reason}` : `· ${tool.label}`);
}

/** Only what is settled: while a step's text is still being written, its last word waits for the space after it, so a
 * credential is never shown half-written (before its whole shape can be recognised). */
function settled(text: string): string {
  const open = text.search(/\S+$/);
  return open === -1 ? text : text.slice(0, open);
}

/** One turn's lines, redacted as one stream: every step's tools and words in order through ONE key state (a key block
 * opened in one step stays hidden into the next), each line cleaned and cut, then the newest kept within the caps. */
export function leadLines(steps: readonly LeadLiveStep[], running: boolean): { lines: string[]; earlier: boolean } {
  const keys: KeyState = { inKey: false };
  const all: string[] = [];
  steps.forEach((step, index) => {
    // Tools are not the conversation's text: they never open or close a key block, and inside one they are not shown.
    for (const tool of step.toolCalls) if (!keys.inKey) all.push(toolLine(tool));
    const text = running && index === steps.length - 1 ? settled(step.text) : step.text;
    if (text.trim() !== "") all.push(...redactLiveLines(text.replace(/\s+$/, "").split(/\r?\n/), keys));
  });
  const kept: string[] = [];
  let bytes = 0;
  for (let index = all.length - 1; index >= 0 && kept.length < LEAD_LINES; index -= 1) {
    const one = capLive(all[index]!, LEAD_BYTES);
    const size = Buffer.byteLength(one, "utf8") + 1;
    if (bytes + size > LEAD_BYTES) break;
    kept.unshift(one);
    bytes += size;
  }
  return { lines: kept, earlier: kept.length < all.length };
}

/** What the turn is doing now, in fixed words only. */
function doingOf(turn: LiveTurn): string | null {
  if (turn.done) return null;
  const step = turn.steps.at(-1);
  const running = step?.toolCalls.filter(tool => tool.state === "running").at(-1);
  if (running !== undefined) return running.label;
  return step !== undefined && step.text.trim() !== "" ? "Writing a reply" : "Thinking";
}

type LeadDeps = Pick<ServerRuntime, "store" | "liveTurns" | "leadPrincipal" | "familyOf" | "visible" | "managedRepos">;

/** The viewer's own live lead turns, admitted as the chat room admits (server/live.ts, room "chat"), proved now. */
export function leadTilesFor(deps: LeadDeps, who: Who): LeadTile[] {
  const { store, liveTurns, leadPrincipal, familyOf, visible, managedRepos } = deps;
  if (who.via !== "cookie" || who.role !== "approver") return [];
  const principal = leadPrincipal(who);
  if (principal === null) return [];
  const tiles: LeadTile[] = [];
  for (const [id, turn] of liveTurns) {
    const thread = store.getLeadThread(id);
    if (thread === null || thread.approver !== who.name || thread.closedAt !== null) continue;
    // The owner's current thread for its scope (never a team conversation's), under the ceiling it opened with.
    if (store.liveLeadThreadFor(who.name, thread.scope)?.id !== id || thread.ceilingDigest !== principal.ceilingDigest) continue;
    let title = "Lead chat", project: string | null = null, chatHref = "/chat", taskHref: string | null = null;
    if (thread.scope.kind === "project") {
      const repo = thread.scope.key;
      if (!visible(repo) || !managedRepos().includes(repo) || !store.accountCanAccess(who.name, repo)) continue;
      title = "Project chat"; project = repo; chatHref = projectChatHref(repo);
    } else if (thread.scope.kind === "task") {
      const family = familyOf(thread.scope.key);
      const repo = family?.root.repo ?? null;
      if (family === null || family.problem !== null || family.root.id !== thread.scope.key || repo === null || !visible(repo) || !store.accountCanAccess(who.name, repo)) continue;
      title = family.root.title; project = repo; chatHref = taskChatHref(family.root.id); taskHref = `/t/${encodeURIComponent(family.root.id)}`;
    }
    const { lines, earlier } = leadLines(turn.steps, !turn.done);
    tiles.push({
      thread: id, turn: turn.turn ?? null, scope: thread.scope.kind, title, project,
      state: !turn.done ? "working" : turn.ok ? "done" : "failed",
      startedAt: new Date(turn.startedAt ?? Date.now()).toISOString(),
      endedAt: turn.endedAt === undefined ? null : new Date(turn.endedAt).toISOString(),
      stepAt: (turn.stepAt ?? []).map(at => new Date(at).toISOString()),
      doing: doingOf(turn), lines, earlier, chatHref, taskHref,
    });
  }
  return tiles.sort((a, b) => a.thread - b.thread);
}
