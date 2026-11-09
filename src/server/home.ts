/**
 * Home ("/", UI revamp wave B): one sentence that answers "what needs me?", four counts read from the same work index
 * the Tasks list filters (so a count and the list it opens always agree), the work in three groups (Waiting on you,
 * Working, Done; home-groups.ts), and the lead's message box. Reads only: every act keeps its own route and rules (an agent's
 * question is answered through POST /d/<id>/answer, the same one-click act as its own page).
 */
import type { BrowserHomeRow, BrowserHomeView } from "../browser-workspace.js";
import { browserWorkActionHref } from "../browser-crew.js";
import { HOME_GROUP_LABEL, homeGroupOf, type HomeGroup } from "../home-groups.js";
import type { Ask } from "../needs-you.js";
import { projectName } from "../project.js";
import type { Store } from "../store.js";
import { workIndexPage, type WorkIndexItem, type WorkIndexPage } from "../work-index.js";
import type { WorkSummaryAccess } from "../work-summary.js";
import type { StatusTone } from "../workspace-ui.js";
import { relativeAge } from "./chrome.js";
import { taskHref } from "./http.js";

type Tone = BrowserHomeRow["chip"]["tone"];
const TONE: Readonly<Record<StatusTone, Tone>> = { attention: "needs", ready: "needs", live: "live", done: "done", problem: "failed", muted: "", neutral: "" };
const ASK_WORD: Readonly<Record<Ask, string>> = { decide: "Decision", review: "Result", unblock: "Blocked" };
/** How many waiting rows Home lists; the rest open in Tasks. */
export const HOME_NEEDS_SHOWN = 30;
const HOME_RUNNING_SHOWN = 8;
/** How many rows finished in the last 7 days Home lists; the rest open in Tasks. */
const HOME_DONE_SHOWN = 8;

export type HomeFacts = {
  store: Store; now: Date; access: WorkSummaryAccess; evidenceRoot?: string;
  /** The project in view (already admitted), or null for every project. */
  project: string | null;
  /** Every admitted project, for the scope links. */
  projects: readonly { name: string; path: string }[];
  /** Chat is allowed for this person here (the lead's message box). */
  chat: boolean;
  /** This person can answer an agent's question (an approver in a browser session). */
  canAnswer: boolean;
  /** Why this task's plan can't take a yes right now (render-tasks.ts consentDoorOf), or null when it can. */
  closedDoor: (taskId: string) => { title: string; why: string; road: "scope" | "agents" } | null;
};

/** "7 need you across 2 projects." — the sentence and the figures read the same totals. */
export function homeSentence(needs: number, perProject: readonly { name: string; needs: number }[], scope: string | null, any: boolean): string {
  if (!any) return "No tasks yet.";
  if (needs === 0) return scope === null ? "Nothing needs you." : `Nothing needs you in ${scope}.`;
  const verb = needs === 1 ? "needs" : "need";
  if (scope !== null) return `${needs} ${verb} you in ${scope}.`;
  const waiting = perProject.filter(one => one.needs > 0);
  return waiting.length === 1 ? `${needs} ${verb} you in ${waiting[0]!.name}.` : `${needs} ${verb} you across ${waiting.length} projects.`;
}

function rowOf(store: Store, item: WorkIndexItem, now: Date, multi: boolean, canAnswer: boolean, closedDoor: HomeFacts["closedDoor"]): BrowserHomeRow {
  const action = item.primaryAction;
  const href = action?.code === "open-result" && action.target.runId != null
    ? `/review?result=${encodeURIComponent(action.target.taskId)}&run=${action.target.runId}` : browserWorkActionHref(item);
  const decisionId = action?.target.decisionId ?? null;
  const decision = decisionId === null ? null : store.getDecision(decisionId);
  const open = decision !== null && decision.state === "open" && decision.supersededReason === null;
  // An irreversible option is armed behind a confirmation on its own page; Home answers only what one click may.
  const question = open && canAnswer && decision.options.every(option => option.reversible) ? {
    id: decision.id, text: decision.question, recap: decision.recap,
    options: decision.options.map(option => ({ id: option.id, label: option.label, consequence: option.consequence, recommended: option.id === decision.recommendation })),
  } : null;
  const waits = item.status.views.includes("needs-you");
  // The specific ask, never the group's own words again: "Needs you" under Unblock reads "Blocked".
  const word = waits ? (open ? "Question" : item.chip ?? (item.status.label === "Needs you" && item.ask !== null ? ASK_WORD[item.ask] : item.status.label)) : item.status.label;
  const tone: Tone = waits ? "ask" : TONE[item.status.tone];
  const line = waits
    ? (open ? decision.question : item.status.detail !== item.status.label ? item.status.detail : null)
    : (item as { progress?: string }).progress ?? (item.status.detail !== item.status.label ? item.status.detail : null);
  // A plan that can't take a yes never offers one: the reason, and the one act that opens it, as the task page says.
  const door = action?.code === "approve-scope" ? closedDoor(action.target.taskId) : null;
  return {
    id: item.rootId, title: item.title, href: taskHref(item.rootId),
    project: multi || item.repo === null ? (item.repo === null ? "Unplaced" : projectName(item.repo)) : null,
    age: relativeAge(item.updatedAt, now), chip: { word, tone }, line: door === null ? line : door.title,
    action: door !== null ? { label: door.road === "agents" ? "Change the agents" : "Edit the plan", href: `${taskHref(action!.target.taskId)}#${door.road === "agents" ? "agents" : "scope"}` }
      : href === null || action === null ? null : { label: action.label, href }, question,
  };
}

/** Home's view for one person and scope, from four reads of the work index (what waits on you, what runs, what waits on
 * Toolroll, what was done), grouped by the one rule every surface shares (home-groups.ts). */
export function homeView(facts: HomeFacts): BrowserHomeView {
  const { store, now, access, project } = facts;
  const read = (view: "needs-you" | "running" | "queued" | "completed", limit: number): WorkIndexPage =>
    workIndexPage(store, now, access, { view, limit, project, ...(facts.evidenceRoot === undefined ? {} : { root: facts.evidenceRoot }) });
  const needs = read("needs-you", HOME_NEEDS_SHOWN);
  const running = read("running", HOME_RUNNING_SHOWN);
  // Waiting (docs/plans/plain-toolroll.md P1.4): what Toolroll or another task moves on, with no person asked.
  const waiting = read("queued", HOME_RUNNING_SHOWN);
  // Done: the Completed list is ordered by completion time, newest first, so its first rows are the newest finished;
  // only those finished in the last 7 days are listed, and that filter runs before the cap.
  const completed = read("completed", HOME_DONE_SHOWN);
  const totals = needs.totals;
  // Queued: the Tasks list's own Queued count (the same predicate its view=queued filter lists).
  const queued = totals.queued;
  // Every project is said by name (scope=all): /tasks alone would narrow to the session's open project.
  const scopeQuery = project === null ? "scope=all&" : `project=${encodeURIComponent(project)}&`;
  // Each figure keeps the name of the list it opens; Done is the whole Completed list, not just this week.
  const counts: BrowserHomeView["counts"] = [
    { key: "needs", label: HOME_GROUP_LABEL.you, value: totals["needs-you"], href: `/tasks?${scopeQuery}view=needs-you` },
    { key: "running", label: "Running", value: totals.running, href: `/tasks?${scopeQuery}view=running` },
    { key: "queued", label: "Queued", value: queued, href: `/tasks?${scopeQuery}view=queued` },
    { key: "finished", label: HOME_GROUP_LABEL.done, value: totals.completed, href: `/tasks?${scopeQuery}view=completed` },
  ];
  // One row per family, in the first group that claims it.
  const seen = new Set<string>();
  const take = (items: readonly WorkIndexItem[], group: HomeGroup) => items.filter(one => {
    if (homeGroupOf(one) !== group || seen.has(one.rootId)) return false;
    seen.add(one.rootId);
    return true;
  });
  // Waiting on you, in today's order of what it asks: decide (with any row whose ask the index couldn't name, which
  // still waits on this person and is never lost), then review, then unblock. Each row's chip names its ask.
  const yours = take((["decide", null, "review", "unblock"] as const).flatMap(ask => needs.items.filter(one => one.ask === ask)), "you");
  // Working: what runs, then what waits on Toolroll, each read with its own bound.
  const working = [...take(running.items, "working"), ...take(waiting.items, "working")];
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const done = take(completed.items.filter(one => (one.completion?.at ?? one.updatedAt) >= weekAgo), "done").slice(0, HOME_DONE_SHOWN);
  const multi = project === null && new Set([...yours, ...working, ...done].map(one => one.repo ?? "")).size > 1;
  const groups: BrowserHomeView["groups"] = [];
  for (const [key, items] of [["you", yours], ["working", working], ["done", done]] as const) {
    if (items.length > 0) groups.push({ key, label: HOME_GROUP_LABEL[key], rows: items.map(one => rowOf(store, one, now, multi, facts.canAnswer, facts.closedDoor)) });
  }
  const perProject = needs.projects.map(one => ({ name: one.repo === null ? "Unplaced" : projectName(one.repo), needs: one.totals["needs-you"] }));
  const any = totals.all > 0 || totals.completed > 0 || (totals.archived ?? 0) > 0;
  const shown = yours.length;
  return {
    kind: "home",
    say: homeSentence(totals["needs-you"], perProject, project === null ? null : projectName(project), any),
    project,
    scopes: facts.projects.length < 2 ? null : [
      { key: "", label: "All projects", href: "/", active: project === null },
      ...facts.projects.map(one => ({ key: one.path, label: one.name, href: `/?project=${encodeURIComponent(one.path)}`, active: one.path === project })),
    ],
    counts, groups,
    more: totals["needs-you"] > shown ? { count: totals["needs-you"] - shown, href: counts[0]!.href } : null,
    newTask: "/tasks/new",
    ask: facts.chat ? { project, placeholder: project === null ? "Ask the lead about your projects…" : `Ask the lead about ${projectName(project)}…` } : null,
    empty: any ? null : { title: "No tasks yet.", text: "Describe a change in a sentence; an agent writes a plan for you to approve." },
  };
}
