/**
 * What else waits on a person at Home (docs/plans/home-other-asks.md): a release's line and a held publication, a flow
 * card waiting on them, and the first-run steps left to do. Reads only, each through the same admission as the page it
 * links to; nothing here acts: every row's one link opens its own page, whose own checks decide what this person may do
 * there. `homeView` (home.ts) assembles these with the work index's rows.
 */
import { flowCardHref, flowDefinitionOf } from "../flow-engine.js";
import { browserViewOf } from "../flow-browser.js";
import type { FirstRunStep } from "../first-run.js";
import { flowCardWaitsOn } from "../flows-ui.js";
import { releaseAskOf, releaseTaskOf } from "../release-approval.js";
import { autoPublishHeld, PUBLISH_ALLOWED_ACTION, PUBLISH_HELD_ACTION } from "../release-auto.js";
import type { Store } from "../store.js";
import { taskArchived } from "../task-archive.js";
import { workStateRows } from "../work-index.js";
import type { WorkSummaryAccess } from "../work-summary.js";

/** One row Home lists that isn't a task's own row. `id` is namespaced so it never meets a task's id; `at` (when it
 * started waiting) gives its age, or null for a setup step; `repo` its project. */
export type HomeAskRow = { id: string; title: string; href: string; repo: string | null; at: string | null; line: string | null; action: { label: string; href: string } };

export type HomeAsks = {
  /** A release's line for an approver (its version, or why the sheet can't take a yes now); null when it isn't one. */
  release: (taskId: string) => string | null;
  /** Releases whose publication waits for a person, one per family, only where that family isn't already a row. */
  held: HomeAskRow[];
  /** Flow cards waiting on this person. */
  flows: HomeAskRow[];
  /** First-run steps still to do, keyed by step. */
  setup: (HomeAskRow & { key: FirstRunStep["key"] })[];
};

export const NO_HOME_ASKS: HomeAsks = { release: () => null, held: [], flows: [], setup: [] };

/** The release sheet: where a release is read and approved, never Home. */
export const releaseSheetHref = (taskId: string): string => `/t/${encodeURIComponent(taskId)}/release`;
const REVIEW_RELEASE = "Review the release";

/** A release's line (its version, or the sheet's refusal) and every held publication in view. Approvers only: the sheet
 * mints its approval only for them; anyone else reads a release as an ordinary task row. */
export function releaseAsks(store: Store, now: Date, access: WorkSummaryAccess, project: string | null, approver: boolean): Pick<HomeAsks, "release" | "held"> {
  if (!approver) return { release: () => null, held: [] };
  const release = (taskId: string): string | null => {
    const ask = releaseAskOf(store, taskId);
    return ask === null ? null : ask.refusal ?? `Version ${ask.version} waits for your approval.`;
  };
  const shown = (repo: string) => (access.repos === null || access.repos.includes(repo)) && (project === null || repo === project);
  // Only what is still held: the newest held-or-allowed act per task is the held one (release-auto.ts autoPublishHeld's
  // own rule, read in one statement). Each is then a release this person may see in this scope, before anything heavier.
  const marked = store.handle.prepare(`SELECT a.task_id, a.at, a.detail FROM action_ledger a WHERE a.action = $held AND a.task_id IS NOT NULL
    AND a.id = (SELECT MAX(b.id) FROM action_ledger b WHERE b.task_id = a.task_id AND b.action IN ($held, $allowed)) ORDER BY a.at DESC, a.id DESC`)
    .all({ $held: PUBLISH_HELD_ACTION, $allowed: PUBLISH_ALLOWED_ACTION });
  const candidates = marked.flatMap(row => {
    const taskId = String(row["task_id"]);
    const found = releaseTaskOf(store, taskId);
    return found === null || !shown(found.ref.repo) || taskArchived(store, taskId) ? []
      : [{ taskId, ref: found.ref.id, repo: found.ref.repo, at: String(row["at"]), why: autoPublishHeld(store, taskId) ?? String(row["detail"] ?? "") }];
  });
  if (candidates.length === 0) return { release, held: [] };
  // Every family in this person's view, read once (the Tasks list's own projection): a held release's family that is
  // already a row that needs them (in any group) is not listed twice, and one the view doesn't admit is not listed.
  const familyOf = new Map<number, { rootId: string; needs: boolean }>();
  for (const family of workStateRows(store, now, access)) for (const member of family.members) familyOf.set(member, { rootId: family.rootId, needs: family.needs });
  const families = new Set<string>();
  const held: HomeAskRow[] = [];
  for (const one of candidates) {
    const family = familyOf.get(one.ref);
    if (family === undefined || family.needs || families.has(family.rootId)) continue;
    families.add(family.rootId);
    held.push({ id: `release:${family.rootId}`, title: store.getTask(one.taskId)?.title ?? one.taskId, href: releaseSheetHref(one.taskId), repo: one.repo, at: one.at,
      line: one.why, action: { label: REVIEW_RELEASE, href: releaseSheetHref(one.taskId) } });
  }
  return { release, held };
}

/** Every active card, in a flow of a project this person may see, that waits on them (flows-ui.ts flowCardWaitsOn, the
 * flow page's own rule). Newest wait first. */
export function flowAsks(store: Store, repos: readonly string[], viewer: { name: string; approver: boolean }, project: string | null): HomeAskRow[] {
  if (!viewer.approver) return [];
  const rows: HomeAskRow[] = [];
  for (const flow of store.listFlows(repos)) {
    if (flow.state !== "active" || (project !== null && flow.repo !== project) || !store.accountCanAccess(viewer.name, flow.repo)) continue;
    const stages = flowDefinitionOf(flow)?.stages ?? [];
    // The flow's browser standing, read once and only when a card waits in a zone that starts a browser.
    let browser: ReturnType<typeof browserViewOf> | undefined;
    for (const card of store.flowCards(flow.id, false)) {
      if (card.state !== "active") continue;
      // A card whose zone was removed still has its subagent's open question (the flow page still takes the answer).
      const stage = stages.find(one => one.id === card.stage);
      if (stage?.kind === "check" && stage.browser === true && browser === undefined) browser = browserViewOf(store, flow);
      const waits = flowCardWaitsOn(store, flow, card, viewer, { stage, ...(browser === undefined ? {} : { browser }) });
      if (!waits.decide && !waits.choose && !waits.answer && !waits.browser && !waits.reply) continue;
      const asked = waits.answer ? store.openSubagentQuestionOn(card.id, card.entry)?.question ?? null : null;
      // The card's own waiting words (a browser wait without the command the page offers as a button).
      const waiting = card.waiting?.replace(/ Approve it with: toolroll flows browser \d+ on$/, "") ?? null;
      const said = waiting ?? asked ?? (waits.choose ? "Waits for your choice." : "Waits for your decision.");
      const href = flowCardHref(flow.id, card.id);
      rows.push({ id: `flow:${card.id}`, title: card.title, href, repo: flow.repo, at: store.flowCardEnteredAt(card.id) ?? card.updatedAt,
        line: `${flow.name}: ${said}`, action: { label: "Open the card", href } });
    }
  }
  return rows.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
}

const SETUP_TITLES: Readonly<Record<FirstRunStep["key"], string>> = {
  agent: "Sign in to a coding agent", project: "Add a project", builder: "Start taking work", task: "File your first task",
};

/** The first-run steps (first-run.ts, with the builder step) still to do, for an approver. A step that is done, or only
 * being checked (no answer yet, so no action), is not a row. Null steps (a restricted console, the demo, after the first
 * success) are none. */
export function setupAsks(steps: readonly FirstRunStep[] | null, approver: boolean): HomeAsks["setup"] {
  if (steps === null || !approver) return [];
  return steps.flatMap(step => {
    if (step.done || step.checking === true || step.action === null) return [];
    const action = step.action.kind === "link" ? { label: step.action.label, href: step.action.href } : { label: "Open setup", href: "/welcome" };
    return [{ key: step.key, id: `setup:${step.key}`, title: SETUP_TITLES[step.key], href: action.href, repo: null, at: null,
      line: step.action.kind === "command" ? `Run ${step.action.command} in a terminal.` : null, action }];
  });
}
