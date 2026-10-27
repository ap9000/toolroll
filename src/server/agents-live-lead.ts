/**
 * Lead tiles on the Live grid (docs/plans/agents-view.md slice 8): the viewer's OWN lead chat turns, and only through
 * the chat room's own admission — an approver with a lead standing, the thread theirs, open, the newest for its scope,
 * never a team conversation, under the ceiling it opened with, and its project or task still theirs to see. Team
 * threads wait for their own admission. The words go through one stateful redactor per turn (one key state carried
 * across every step and every line of the turn's current snapshot), then controls out, then a cap. Memory only: the
 * tile is the live turn's, and leaves with it (60 s after the turn ends).
 */
import type { LeadLiveStep, LeadLiveTool } from "../lead-progress.js";
import { capLive, cleanLiveText, HIDDEN_KEY_BLOCK, HIDDEN_LINE, liveLine, redactLiveLines, type KeyState } from "../live-records.js";
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

/** One step's words, redacted, with only what is settled: the last word of the step's text waits for the space after
 * it, whether the turn is running or has ended. A snapshot that would have completed a credential is never stored
 * (lead.ts drops it), so the one kept can end part-way through one, and ending the turn or starting the next step
 * confirms nothing. The whole line is checked for secrets first; the unfinished word is found in the line as shown
 * (invisible characters removed), so no hidden character can stand in for the space. */
function stepLines(text: string, keys: KeyState): string[] {
  const raw = text.split(/\r?\n/);
  const out = redactLiveLines(raw, keys);
  const last = out.length - 1;
  const shown = out[last] ?? "";
  if (shown !== HIDDEN_LINE && shown !== HIDDEN_KEY_BLOCK) out[last] = (/\s$/.test(cleanLiveText(raw[last] ?? "")) ? shown : shown.replace(/\S+$/, "")).trimEnd();
  while (out.length > 0 && out[out.length - 1]!.trim() === "") out.pop();
  return out;
}

/** One turn's lines, redacted as one stream: every step's tools and words in order through ONE key state (a key block
 * opened in one step stays hidden into the next), each line cleaned and cut, then the newest kept within the caps. */
export function leadLines(steps: readonly LeadLiveStep[]): { lines: string[]; earlier: boolean } {
  const keys: KeyState = { inKey: false };
  const all: string[] = [];
  for (const step of steps) {
    // Tools are not the conversation's text: they never open or close a key block, and inside one they are not shown.
    for (const tool of step.toolCalls) if (!keys.inKey) all.push(toolLine(tool));
    if (step.text !== "") all.push(...stepLines(step.text, keys));
  }
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

type Admitted = Pick<LeadTile, "scope" | "title" | "project" | "chatHref" | "taskHref">;

/** One thread admitted for this viewer now, as the chat room admits (server/live.ts, room "chat"); null when refused. */
function admitLead(deps: LeadDeps, who: Who, id: number): Admitted | null {
  const { store, leadPrincipal, familyOf, visible, managedRepos } = deps;
  if (who.via !== "cookie" || who.role !== "approver") return null;
  const principal = leadPrincipal(who);
  if (principal === null) return null;
  const thread = store.getLeadThread(id);
  if (thread === null || thread.approver !== who.name || thread.closedAt !== null) return null;
  // The owner's current thread for its scope (never a team conversation's), under the ceiling it opened with.
  if (store.liveLeadThreadFor(who.name, thread.scope)?.id !== id || thread.ceilingDigest !== principal.ceilingDigest) return null;
  if (thread.scope.kind === "project") {
    const repo = thread.scope.key;
    if (!visible(repo) || !managedRepos().includes(repo) || !store.accountCanAccess(who.name, repo)) return null;
    return { scope: "project", title: "Project chat", project: repo, chatHref: projectChatHref(repo), taskHref: null };
  }
  if (thread.scope.kind === "task") {
    const family = familyOf(thread.scope.key);
    const repo = family?.root.repo ?? null;
    if (family === null || family.problem !== null || family.root.id !== thread.scope.key || repo === null || !visible(repo) || !store.accountCanAccess(who.name, repo)) return null;
    return { scope: "task", title: family.root.title, project: repo, chatHref: taskChatHref(family.root.id), taskHref: `/t/${encodeURIComponent(family.root.id)}` };
  }
  return { scope: "lead", title: "Lead chat", project: null, chatHref: "/chat", taskHref: null };
}

/** The viewer's own live lead turns, admitted as the chat room admits them, proved now. */
export function leadTilesFor(deps: LeadDeps, who: Who): LeadTile[] {
  const tiles: LeadTile[] = [];
  for (const [id, turn] of deps.liveTurns) {
    const admitted = admitLead(deps, who, id);
    if (admitted === null) continue;
    const { lines, earlier } = leadLines(turn.steps);
    tiles.push({
      thread: id, turn: turn.turn ?? null, ...admitted,
      state: !turn.done ? "working" : turn.ok ? "done" : "failed",
      startedAt: new Date(turn.startedAt ?? Date.now()).toISOString(),
      endedAt: turn.endedAt === undefined ? null : new Date(turn.endedAt).toISOString(),
      stepAt: (turn.stepAt ?? []).map(at => new Date(at).toISOString()),
      doing: doingOf(turn), lines, earlier,
    });
  }
  return tiles.sort((a, b) => a.thread - b.thread);
}

/** The tiles projected earlier that are still this viewer's right now (the whole admission proved again, with the
 * session as it is saved now): what is delivered is never more than what is admitted at the moment of delivery. */
export function leadsStillAdmitted(deps: LeadDeps, who: Who, tiles: readonly LeadTile[]): LeadTile[] {
  return tiles.filter(tile => deps.liveTurns.has(tile.thread) && admitLead(deps, who, tile.thread) !== null);
}
