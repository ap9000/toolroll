/**
 * Home ("/", UI revamp wave B): one sentence that answers "what needs me?", four counts read from the same work index
 * the Tasks list filters (so a count and the list it opens always agree), what waits on this person grouped by what it
 * asks, what is running, and the lead's message box. Reads only: every act keeps its own route and rules (an agent's
 * question is answered through POST /d/<id>/answer, the same one-click act as its own page).
 */
import type { BrowserHomeRow, BrowserHomeView } from "../browser-workspace.js";
import { browserWorkActionHref } from "../browser-crew.js";
import { ASK_LABEL, type Ask } from "../needs-you.js";
import { projectName } from "../project.js";
import type { Store } from "../store.js";
import { workIndexPage, type WorkIndexItem, type WorkIndexPage } from "../work-index.js";
import type { WorkSummaryAccess } from "../work-summary.js";
import type { StatusTone } from "../workspace-ui.js";
import { relativeAge } from "./chrome.js";
import { taskHref } from "./http.js";

type Tone = BrowserHomeRow["chip"]["tone"];
const TONE: Readonly<Record<StatusTone, Tone>> = { attention: "needs", ready: "needs", live: "live", done: "done", problem: "failed", muted: "", neutral: "" };
const ASKS: readonly Ask[] = ["decide", "review", "unblock"];
const ASK_WORD: Readonly<Record<Ask, string>> = { decide: "Decision", review: "Result", unblock: "Blocked" };
/** How many waiting rows Home lists; the rest open in Tasks. */
export const HOME_NEEDS_SHOWN = 30;
const HOME_RUNNING_SHOWN = 8;

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

function rowOf(store: Store, item: WorkIndexItem, now: Date, multi: boolean, canAnswer: boolean): BrowserHomeRow {
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
  return {
    id: item.rootId, title: item.title, href: taskHref(item.rootId),
    project: multi || item.repo === null ? (item.repo === null ? "Unplaced" : projectName(item.repo)) : null,
    age: relativeAge(item.updatedAt, now), chip: { word, tone }, line,
    action: href === null || action === null ? null : { label: action.label, href }, question,
  };
}

/** Home's view for one person and scope, from two reads of the work index (what waits, what runs). */
export function homeView(facts: HomeFacts): BrowserHomeView {
  const { store, now, access, project } = facts;
  const read = (view: "needs-you" | "running", limit: number): WorkIndexPage =>
    workIndexPage(store, now, access, { view, limit, project, ...(facts.evidenceRoot === undefined ? {} : { root: facts.evidenceRoot }) });
  const needs = read("needs-you", HOME_NEEDS_SHOWN);
  const running = read("running", HOME_RUNNING_SHOWN);
  const totals = needs.totals;
  // Queued: the Tasks list's own Queued count (the same predicate its view=queued filter lists).
  const queued = totals.queued;
  const scopeQuery = project === null ? "" : `project=${encodeURIComponent(project)}&`;
  const counts: BrowserHomeView["counts"] = [
    { key: "needs", label: "Needs you", value: totals["needs-you"], href: `/work?${scopeQuery}view=needs-you` },
    { key: "running", label: "Running", value: totals.running, href: `/work?${scopeQuery}view=running` },
    { key: "queued", label: "Queued", value: queued, href: `/work?${scopeQuery}view=queued` },
    { key: "finished", label: "Finished", value: totals.completed, href: `/work?${scopeQuery}view=completed` },
  ];
  const multi = project === null && new Set([...needs.items, ...running.items].map(one => one.repo ?? "")).size > 1;
  const groups: BrowserHomeView["groups"] = [];
  for (const ask of ASKS) {
    const rows = needs.items.filter(one => one.ask === ask).map(one => rowOf(store, one, now, multi, facts.canAnswer));
    if (rows.length > 0) groups.push({ key: ask, label: ASK_LABEL[ask], rows });
  }
  // A waiting row whose ask the index couldn't name still waits on this person: it goes under Decide, never lost.
  const unnamed = needs.items.filter(one => one.ask === null).map(one => rowOf(store, one, now, multi, facts.canAnswer));
  if (unnamed.length > 0) {
    const decide = groups.find(one => one.key === "decide");
    if (decide) decide.rows.push(...unnamed); else groups.unshift({ key: "decide", label: ASK_LABEL.decide, rows: unnamed });
  }
  const live = running.items.filter(one => !one.status.views.includes("needs-you")).map(one => rowOf(store, one, now, multi, facts.canAnswer));
  if (live.length > 0) groups.push({ key: "running", label: "Running", rows: live });
  const perProject = needs.projects.map(one => ({ name: one.repo === null ? "Unplaced" : projectName(one.repo), needs: one.totals["needs-you"] }));
  const any = totals.all > 0 || totals.completed > 0 || (totals.archived ?? 0) > 0;
  const shown = groups.filter(one => one.key !== "running").reduce((sum, one) => sum + one.rows.length, 0);
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
