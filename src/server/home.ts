/**
 * Home ("/", docs/plans/live-pages-and-home.md B1, home-other-asks.md): what needs this person, grouped by what is asked
 * (Approve a release, Approve a plan, Answer a question, Flow decisions, Something went wrong, Review results, Finish
 * setting up, and Needs you for the rest), each group with its exact count; one quiet line for what runs and waits; with nothing waiting, what runs and what finished today. The figures
 * are read from the same work index the Tasks list filters, so a count and the list it opens always agree. Reads
 * only: every act keeps its own route and rules (an agent's question is answered through POST /d/<id>/answer, the
 * same one-click act as its own page).
 */
import type { BrowserHomeAsk, BrowserHomeRow, BrowserHomeView } from "../browser-workspace.js";
import { browserWorkActionHref } from "../browser-crew.js";
import { NO_REASON_RECORDED } from "../needs-you.js";
import { projectName } from "../project.js";
import type { Store } from "../store.js";
import { workIndexPage, type WorkIndexItem, type WorkIndexPage } from "../work-index.js";
import type { WorkSummaryAccess } from "../work-summary.js";
import { oneLineOf, relativeAge } from "./chrome.js";
import { taskHref } from "./http.js";
import { NO_HOME_ASKS, releaseSheetHref, type HomeAskRow, type HomeAsks } from "./home-asks.js";

/** How many waiting rows Home lists; each group says how many more open in Tasks. */
export const HOME_NEEDS_SHOWN = 30;
const HOME_RUNNING_SHOWN = 8;
/** How many rows finished today Home lists; its figure counts them all. */
export const HOME_DONE_SHOWN = 8;
/** About one line of the lead's last message. */
const LEAD_LINE_LIMIT = 160;

/** Each group's heading, in the order Home shows them. */
export const HOME_ASK_LABEL: Readonly<Record<BrowserHomeAsk, string>> = {
  release: "Approve a release", approve: "Approve a plan", answer: "Answer a question", flow: "Flow decisions", wrong: "Something went wrong",
  review: "Review results", setup: "Finish setting up", other: "Needs you",
};
/** The groups in Home's one order. */
export const HOME_ASK_ORDER: readonly BrowserHomeAsk[] = ["release", "approve", "answer", "flow", "wrong", "review", "setup", "other"];

export type HomeFacts = {
  store: Store; now: Date; access: WorkSummaryAccess; evidenceRoot?: string;
  /** The project in view (already admitted), or null for every project. */
  project: string | null;
  /** Every admitted project, for the project filter. */
  projects: readonly { name: string; path: string }[];
  /** Chat is allowed for this person here (the lead's message box). */
  chat: boolean;
  /** This person can answer an agent's question (an approver in a browser session). */
  canAnswer: boolean;
  /** An approver in a browser session (default: `canAnswer`): a release is then read in Approve a release, never
   * approved here; for anyone else it stays an ordinary task row. */
  approver?: boolean;
  /** What else waits on this person (home-asks.ts), already read through each page's own admission. */
  asks?: HomeAsks;
  /** Why this task's plan can't take a yes right now (render-tasks.ts consentDoorOf), or null when it can. */
  closedDoor: (taskId: string) => { title: string; why: string; road: "scope" | "agents" } | null;
  /** The lead's last message in this person's main thread, already read through the chat's own access check
   * (pages.ts leadLastMessage); null when there is none or this person may not read that thread. */
  leadMessage?: { text: string; at: string } | null;
};

/** "19 tasks need you", "3 tasks and 2 other things need you", "2 things need you": the heading, said once. Tasks
 * are the same total as the rail's count; `others` are the rows that aren't tasks (a held publication, a flow card, a
 * setup step). */
export function homeSentence(needs: number, any: boolean, others = 0): string {
  const tasks = needs === 1 ? "1 task" : `${needs} tasks`;
  if (others === 0) return !any ? "No tasks yet" : needs === 0 ? "Nothing needs you" : `${tasks} ${needs === 1 ? "needs" : "need"} you`;
  if (needs === 0) return others === 1 ? "1 thing needs you" : `${others} things need you`;
  return `${tasks} and ${others} other ${others === 1 ? "thing" : "things"} need you`;
}

/** The lead's words as one plain line: no markdown marks, no line breaks, cut to about one line. */
export function leadLineOf(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/(\*\*|__|~~)(.*?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?:;]|$)/g, "$1$2");
  return oneLineOf(plain, LEAD_LINE_LIMIT);
}

/** Midnight today on this computer's clock: "finished today" starts here. */
export function startOfToday(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function rowOf(store: Store, item: WorkIndexItem, now: Date, multi: boolean, canAnswer: boolean, closedDoor: HomeFacts["closedDoor"], state: BrowserHomeRow["state"],
  release: ((taskId: string) => string | null) | null): BrowserHomeRow {
  // A release (approvers): read on its own sheet, never approved here. Its line is its version, or why the sheet can't
  // take a yes now; its one link opens the sheet.
  if (state === "needs" && item.askGroup === "release" && release !== null) {
    const href = releaseSheetHref(item.activeTaskId);
    return { id: item.rootId, title: item.title, href, state, ask: "release", reason: null,
      project: multi || item.repo === null ? (item.repo === null ? "Unplaced" : projectName(item.repo)) : null,
      age: relativeAge(item.updatedAt, now), line: release(item.activeTaskId), action: { label: "Review the release", href }, question: null };
  }
  const action = item.primaryAction;
  const href = action?.code === "open-result" && action.target.runId != null
    ? `/review?result=${encodeURIComponent(action.target.taskId)}&run=${action.target.runId}` : browserWorkActionHref(item);
  const decisionId = action?.target.decisionId ?? null;
  const decision = decisionId === null ? null : store.getDecision(decisionId);
  const open = decision !== null && decision.state === "open" && decision.supersededReason === null;
  // An irreversible option is armed behind a confirmation on its own page; Home answers only what one click may.
  const question = state === "needs" && open && canAnswer && decision.options.every(option => option.reversible) ? {
    id: decision.id, text: decision.question, recap: decision.recap,
    options: decision.options.map(option => ({ id: option.id, label: option.label, consequence: option.consequence, recommended: option.id === decision.recommendation })),
  } : null;
  // Anyone else reads a release as the plan it is.
  const ask = state === "needs" ? (item.askGroup === "release" ? "approve" : item.askGroup ?? "other") : null;
  const said = item.status.detail !== item.status.label ? item.status.detail : null;
  const line = state === "needs" && open ? decision.question : (item as { progress?: string }).progress ?? said;
  // Only a row where something went wrong says why, in one short line.
  // With no reason on record, the row says what happened (its status) instead of a sentence about the missing reason.
  const reason = ask === "wrong" ? oneLineOf((said !== null && said !== NO_REASON_RECORDED ? said : item.status.label).replace(/[.\s]+$/, ""), 120) : null;
  // A plan that can't take a yes never offers one: the reason, and the one act that opens it, as the task page says.
  const door = state === "needs" && action?.code === "approve-scope" ? closedDoor(action.target.taskId) : null;
  return {
    id: item.rootId, title: item.title, href: taskHref(item.rootId), state, ask, reason,
    project: multi || item.repo === null ? (item.repo === null ? "Unplaced" : projectName(item.repo)) : null,
    age: relativeAge(item.updatedAt, now), line: door === null ? line : door.title,
    action: door !== null ? { label: door.road === "agents" ? "Change the agents" : "Edit the plan", href: `${taskHref(action!.target.taskId)}#${door.road === "agents" ? "agents" : "scope"}` }
      : href === null || action === null ? null : { label: action.label, href }, question,
  };
}

/** Home's view for one person and scope, from four reads of the work index: what waits on you (with exact per-ask
 * totals), what runs, what waits its turn, and what was completed today (filtered before its limit). */
export function homeView(facts: HomeFacts): BrowserHomeView {
  const { store, now, access, project } = facts;
  const read = (view: "needs-you" | "running" | "queued" | "completed", limit: number, completedSince?: string): WorkIndexPage =>
    workIndexPage(store, now, access, { view, limit, project, ...(completedSince === undefined ? {} : { completedSince }),
      ...(facts.evidenceRoot === undefined ? {} : { root: facts.evidenceRoot }) });
  const needs = read("needs-you", HOME_NEEDS_SHOWN);
  const running = read("running", HOME_RUNNING_SHOWN);
  // Queued: what waits its turn, or what Toolroll or another task moves on, with no person asked.
  const waiting = read("queued", HOME_RUNNING_SHOWN);
  // Done today: the Completed list from midnight on, filtered in the read itself, so the figure and the rows are
  // what finished today however many there are.
  const today = read("completed", HOME_DONE_SHOWN, startOfToday(now).toISOString());
  const totals = needs.totals;
  // Every project is said by name (scope=all): /tasks alone would narrow to the session's open project.
  const scopeQuery = project === null ? "scope=all&" : `project=${encodeURIComponent(project)}&`;
  // Each figure keeps the list it opens.
  const counts: BrowserHomeView["counts"] = [
    { key: "needs", label: "Needs you", value: totals["needs-you"], href: `/tasks?${scopeQuery}view=needs-you` },
    { key: "running", label: "Running", value: totals.running, href: `/tasks?${scopeQuery}view=running` },
    { key: "queued", label: "Queued", value: totals.queued, href: `/tasks?${scopeQuery}view=queued` },
    { key: "finished", label: "Finished", value: totals.completed, href: `/tasks?${scopeQuery}view=completed` },
  ];
  // One row per family, in the first list that claims it.
  const seen = new Set<string>();
  const take = (items: readonly WorkIndexItem[], view: "needs-you" | "running" | "queued" | "completed") => items.filter(one => {
    if (!one.status.views.includes(view) || seen.has(one.rootId)) return false;
    seen.add(one.rootId);
    return true;
  });
  const yours = take(needs.items, "needs-you");
  const live = take(running.items, "running");
  const queued = take(waiting.items, "queued");
  const done = take(today.items, "completed");
  const approver = facts.approver ?? facts.canAnswer;
  const asks = facts.asks ?? NO_HOME_ASKS;
  // A held publication, a flow card and a setup step are an approver's alone (home-asks.ts reads them only for one).
  const held = approver ? asks.held : [], flows = approver ? asks.flows : [];
  // The builder step waits behind a task row that already asks for a builder: that row says it.
  const setup = approver ? asks.setup.filter(one => one.key !== "builder" || needs.builderWaits === 0) : [];
  const extra = [...held, ...flows, ...setup];
  const multi = project === null && new Set([...yours, ...live, ...queued, ...done].map(one => one.repo ?? "").concat(extra.flatMap(one => one.repo === null ? [] : [one.repo]))).size > 1;
  const row = (item: WorkIndexItem, state: BrowserHomeRow["state"]) => rowOf(store, item, now, multi, facts.canAnswer, facts.closedDoor, state, approver ? asks.release : null);
  const rows = yours.map(one => row(one, "needs"));
  const askRow = (one: HomeAskRow, ask: BrowserHomeAsk): BrowserHomeRow => ({ id: one.id, title: one.title, href: one.href, state: "needs", ask, reason: null,
    project: multi && one.repo !== null ? projectName(one.repo) : null, age: one.at === null ? "" : relativeAge(one.at, now), line: one.line, action: one.action, question: null });
  // Each group's count is exact over every row in view, not only those listed: the work index's total for a task ask
  // (a release counted once, in its own group for an approver and as a plan for anyone else), and every other row.
  const askTotals: Record<BrowserHomeAsk, number> = {
    release: (approver ? needs.asks.release : 0) + held.length, approve: needs.asks.approve + (approver ? 0 : needs.asks.release), answer: needs.asks.answer,
    flow: flows.length, wrong: needs.asks.wrong, review: needs.asks.review, setup: setup.length, other: needs.asks.other,
  };
  const listedOf: Record<BrowserHomeAsk, BrowserHomeRow[]> = {
    release: [...rows.filter(one => one.ask === "release"), ...held.map(one => askRow(one, "release"))], approve: rows.filter(one => one.ask === "approve"),
    answer: rows.filter(one => one.ask === "answer"), flow: flows.map(one => askRow(one, "flow")), wrong: rows.filter(one => one.ask === "wrong"),
    review: rows.filter(one => one.ask === "review"), setup: setup.map(one => askRow(one, "setup")), other: rows.filter(one => one.ask === "other"),
  };
  const groups: BrowserHomeView["groups"] = HOME_ASK_ORDER.flatMap(key => {
    const count = askTotals[key], listed = listedOf[key];
    return count === 0 && listed.length === 0 ? [] : [{ key, label: HOME_ASK_LABEL[key], count: Math.max(count, listed.length), rows: listed }];
  });
  const others = extra.length;
  const any = totals.all > 0 || totals.completed > 0 || (totals.archived ?? 0) > 0;
  const lead = facts.chat ? facts.leadMessage ?? null : null;
  const leadText = lead === null ? "" : leadLineOf(lead.text);
  return {
    kind: "home",
    say: homeSentence(totals["needs-you"], any, others),
    project,
    scopes: facts.projects.length < 2 ? null : [
      { key: "", label: "All projects", href: "/", active: project === null },
      ...facts.projects.map(one => ({ key: one.path, label: one.name, href: `/?project=${encodeURIComponent(one.path)}`, active: one.path === project })),
    ],
    counts, groups,
    working: [...live.map(one => row(one, "running")), ...queued.map(one => row(one, "queued"))],
    finishedToday: { count: Math.max(today.completedSince, done.length), rows: done.map(one => row(one, "done")), href: counts[3]!.href },
    newTask: "/tasks/new",
    ask: facts.chat ? { project, placeholder: "Ask Toolroll" } : null,
    lastLead: lead === null || leadText === "" ? null : { text: leadText, age: relativeAge(lead.at, now), href: "/chat" },
    empty: any || others > 0 ? null : { title: "No tasks yet", text: "Describe a change in a sentence; an agent writes a plan for you to approve." },
  };
}
