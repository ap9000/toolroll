/**
 * The one address of a task and of its result (one-workspace plan S1, "The canonical-link resolver"). Every surface
 * that links to a task, a result or a record builds the link here: Home, Tasks rows, Chat cards, notifications, chat
 * apps, the task page itself, and the old addresses that now redirect (`/review?result=`, a finished `/r/:id`).
 *
 * A result is the task page's Result section at the exact run (`/t/T?tab=result&run=N`), never "the latest": the run,
 * the version, the section, the place on the page and the feedback a form came back with are carried verbatim, so a
 * saved link keeps meaning the result it named. The page it lands on admits the person and decides what they may see
 * and do (a stale run is refused there, an older result shows no acts on the current one); this module decides
 * nothing, it only spells addresses. Pure: no store, no clock.
 */

export type TaskLinkSection = "summary" | "changes" | "checks";

/** What a form came back with: `noted` (a note was saved), `refused` (a refusal's code, said on the page). */
export type TaskLinkFeedback = { noted?: boolean; refused?: string | null };

export type TaskLink = {
  /** The task, or one of its versions (its page shows that version). */
  task: string;
  /** The exact result: a run of that task. */
  run?: number | null;
  /** A version to show, when `task` is its family's root. */
  revision?: string | null;
  /** The result's section; Summary is the default and never spelled. */
  section?: TaskLinkSection | null;
  /** A place on the page, without its `#`. */
  anchor?: string | null;
  feedback?: TaskLinkFeedback | null;
  /** The record: a run's raw record (`/r/N?record=1`), or with no run the task's Record section. */
  record?: boolean;
  /** Open the Result section even without naming a run (the version's own result). */
  result?: boolean;
};

const SECTIONS: readonly TaskLinkSection[] = ["summary", "changes", "checks"];
const ANCHOR = /^[A-Za-z0-9_-][A-Za-z0-9_.:-]{0,159}$/;
const REFUSAL = /^[a-z][a-z-]{0,31}$/;
const ID = /^[A-Za-z0-9._~%-]{1,200}$/;

const validRun = (run: number | null | undefined): run is number => typeof run === "number" && Number.isSafeInteger(run) && run > 0;
const hashOf = (anchor: string | null | undefined): string => anchor != null && ANCHOR.test(anchor) ? `#${anchor}` : "";

/** The address. Anything malformed (a run that is no run, an unknown section, an anchor with odd characters) is left
 * out rather than spelled: the page then shows less, never something else. */
export function taskLinkOf(link: TaskLink): string {
  const path = `/t/${encodeURIComponent(link.task)}`;
  const hash = hashOf(link.anchor);
  if (link.record === true) {
    if (validRun(link.run)) return `/r/${link.run}?record=1${hash}`;
    const query = new URLSearchParams();
    if (link.revision != null && link.revision !== "") query.set("version", link.revision);
    query.set("tab", "record");
    return `${path}?${query.toString()}${hash === "" ? "#record" : hash}`;
  }
  const query: string[] = [];
  if (link.revision != null && link.revision !== "") query.push(`version=${encodeURIComponent(link.revision)}`);
  const section = link.section != null && SECTIONS.includes(link.section) ? link.section : null;
  const result = validRun(link.run) || section !== null || link.result === true;
  if (result) {
    query.push("tab=result");
    if (validRun(link.run)) query.push(`run=${link.run}`);
    if (section !== null && section !== "summary") query.push(`section=${section}`);
  }
  if (link.feedback?.noted === true) query.push("noted=1");
  if (link.feedback?.refused != null && REFUSAL.test(link.feedback.refused)) query.push(`refused=${link.feedback.refused}`);
  return `${path}${query.length === 0 ? "" : `?${query.join("&")}`}${hash}`;
}

/** The address an old result link now lives at, or null when `href` is not one: the retired result page
 * (`/review?result=T&run=N&tab=S`, with its `noted`/`refused` feedback) and the chat's result detail
 * (`/chat?task=T&result=N&tab=S`). `/review?result=T&run=N&tab=changes` → `/t/T?tab=result&run=N&section=changes`. */
export function taskLinkFromLegacy(href: string): string | null {
  let url: URL;
  try { url = new URL(href, "http://toolroll.local"); } catch { return null; }
  if (url.origin !== "http://toolroll.local" || !href.startsWith("/")) return null;
  const anchor = url.hash === "" ? null : decodeURIComponent(url.hash.slice(1));
  const section = (raw: string | null): TaskLinkSection | null => raw !== null && (SECTIONS as readonly string[]).includes(raw) ? raw as TaskLinkSection : null;
  const runOf = (raw: string | null): number | null => raw !== null && /^[1-9][0-9]{0,14}$/.test(raw) ? Number(raw) : null;
  if (url.pathname === "/review") {
    const task = url.searchParams.get("result");
    if (task === null || !ID.test(encodeURIComponent(task))) return null;
    return taskLinkOf({ task, run: runOf(url.searchParams.get("run")), section: section(url.searchParams.get("tab")), anchor, result: true,
      feedback: { noted: url.searchParams.get("noted") !== null, refused: url.searchParams.get("refused") } });
  }
  if (url.pathname === "/chat") {
    const task = url.searchParams.get("task"), run = runOf(url.searchParams.get("result"));
    if (task === null || run === null || !ID.test(encodeURIComponent(task))) return null;
    return taskLinkOf({ task, run, section: section(url.searchParams.get("tab")), anchor });
  }
  return null;
}
