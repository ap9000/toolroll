/**
 * Home's three groups (docs/plans/one-step-chat.md H1): what waits on you, what is working, what is done. One rule for
 * every surface that groups work this way (Home in the browser, the terminal UI), so they never disagree. Pure: no
 * server, store or rendering imports, so the terminal UI's source can use it too.
 */

export type HomeGroup = "you" | "working" | "done";

/** The groups in the order every surface shows them. */
export const HOME_GROUPS: readonly HomeGroup[] = ["you", "working", "done"];

/** Each group's heading. */
export const HOME_GROUP_LABEL: Readonly<Record<HomeGroup, string>> = { you: "Waiting on you", working: "Working", done: "Done" };

/** What the rule reads of a work index item (work-index.ts WorkIndexItem): the views that list it and its headline. */
export type HomeGroupFacts = { readonly status: { readonly views: readonly string[]; readonly label: string } };

/**
 * Which group a work index item belongs to, in this order: it waits on you when the Needs you view lists it; it is
 * working when it runs, or when it is queued and waits on Toolroll or another task ("Waiting", nobody is asked); it is
 * done when it is complete. Null for anything else: cancelled, replaced, put away, or queued under another headline.
 */
export function homeGroupOf(item: HomeGroupFacts): HomeGroup | null {
  const views = item.status.views;
  if (views.includes("needs-you")) return "you";
  if (views.includes("running")) return "working";
  if (views.includes("queued") && item.status.label === "Waiting") return "working";
  if (views.includes("completed")) return "done";
  return null;
}

/** The work index totals Home's figures show, each the count of the Tasks list its figure opens. */
export type HomeFigures = { readonly waitingOnYou: number; readonly running: number; readonly queued: number; readonly done: number };

/** Home's figures from work index totals (work-index.ts WorkIndexCounts): Done is the whole Completed list. */
export function homeFiguresOf(totals: { readonly "needs-you": number; readonly running: number; readonly queued: number; readonly completed: number }): HomeFigures {
  return { waitingOnYou: totals["needs-you"], running: totals.running, queued: totals.queued, done: totals.completed };
}

/** "Waiting on you 2 · Running 1 · Queued 0 · Done 14": the opening line of `toolroll status` and chat /status. */
export function homeFiguresLine(figures: HomeFigures): string {
  return `Waiting on you ${figures.waitingOnYou} · Running ${figures.running} · Queued ${figures.queued} · Done ${figures.done}`;
}
