// What a page asks the app to run in place of a page script string. Kept apart from browser-workspace.ts, which the
// server builds pages with: the browser bundle reads these values and must pull in nothing else.
/**
 * One behaviour the app runs for the page on screen instead of a page script string (docs/plans/task-page-in-app.md).
 * `answer`: a question's inline answer (render-tasks.ts decisionAnswerScript). `region`: a server-drawn region kept
 * current from a build's own fragment (chrome.ts regionScript), `/r/<run>?fragment=check|peek`. No code, selector or
 * address travels here: the app runs only the kinds it knows.
 */
export type PageWork = { kind: "answer" } | { kind: "region"; region: "check-progress" | "run-peek"; run: number };
/** The work the app and the server agree on. A workspace read says it with `x-toolroll-work`; a reader that does not
 * (an older tab) gets the page as a document with its script string, as before. A hint, never authority. */
export const PAGE_WORK_VERSION = 1;
export const PAGE_WORK_HEADER = "x-toolroll-work";
