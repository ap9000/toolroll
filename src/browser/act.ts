/**
 * Acts in place (docs/plans/live-pages-and-home.md B2): approving a plan without leaving the page.
 *
 * Two requests, in order, from one press:
 *  1. `mintRead`: a header-less read of the task page as data, as the task page's own load does. It is the only read
 *     that mints an approval nonce, so a nonce is minted once per press, for exactly the plan on screen.
 *  2. `postInPlace`: one POST to the approve route with `x-toolroll-act: in-place`, carrying the form token, that nonce,
 *     the digest of the plan on screen, the rebuild it names (if any) and `return=next`. Never a password.
 *
 * The server's proofs are the route's own and unchanged; the header only asks for the answer as a named outcome.
 * Anything that is not that exact answer is "elsewhere" (the task page loads as a document), and no answer at all is
 * "lost": the approval may have been written before the answer was lost, so the caller reads the task again.
 */
import type { BrowserTaskView, BrowserWorkspace } from "../browser-workspace.js";
import { approvalAsk, termsOf, type ApprovalFacts, type ApprovalKind } from "../design/kit.js";
import { keyed } from "./mutation-key.js";
import { isWorkspace, localUrl, readPage } from "./workspace-client.js";

/** How long a press waits for each request before it counts as no answer. */
export const ACT_TIMEOUT_MS = 15_000;
/** After a plan is drawn or redrawn, the Approve button takes no press for this long. */
export const REDRAW_HOLD_MS = 600;

/** The one approval Home shows: everything the press needs and everything the person read, from one read. */
export type ApprovalSnapshot = {
  taskId: string; action: string; digest: string; rebuild: string | null;
  heading: string; text: string; termsWords: string; planHtml: string | null;
  kind: ApprovalKind; facts: ApprovalFacts;
};

export type ApprovalOutcome = "approved" | "vote" | "approved-not-rebuilt" | "refused";
export type InPlaceAnswer = { kind: "answer"; outcome: ApprovalOutcome; words: string } | { kind: "elsewhere" } | { kind: "lost" };

/** A form control in server HTML: Home renders none (B2.1), so a plan carrying one is not shown there. */
const FORM_CONTROL = /<\s*(input|form|button|select|textarea)\b/i;
export const holdsFormControl = (html: string): boolean => FORM_CONTROL.test(html);

const DIGEST = /^[0-9a-f]{32,64}$/;
const NONCE = /^[0-9a-f]{32}$/;
const RUN = /^[0-9]{1,15}$/;

/** The task view a workspace read answered, or null when it is not one. */
export function taskViewOf(workspace: BrowserWorkspace | null): BrowserTaskView | null {
  const view = workspace?.view;
  return view != null && view.kind === "task" && typeof (view as BrowserTaskView).id === "string" ? view as BrowserTaskView : null;
}

/**
 * The snapshot a task read holds, or null when it holds no approval this page can show. The action must be exactly
 * this task's approve route and the digest a plan digest: a read never chooses where a press posts.
 */
export function snapshotOf(workspace: BrowserWorkspace | null): ApprovalSnapshot | null {
  const view = taskViewOf(workspace);
  const approve = view?.approve ?? null;
  if (view === null || approve === null) return null;
  const digest = approve.fields["digest"] ?? "";
  const rebuild = approve.fields["rebuild"] ?? null;
  if (!DIGEST.test(digest) || (rebuild !== null && !RUN.test(rebuild))) return null;
  if (approve.action !== `/t/${encodeURIComponent(view.id)}/approve`) return null;
  const until = approve.rememberedUntil === null ? null : new Date(approve.rememberedUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const facts: ApprovalFacts = { ...approve.facts, rememberedUntil: until };
  // Only the plan sheet, never the task page's editor; a sheet that holds a form control is not shown at all.
  const sheet = typeof approve.sheetHtml === "string" ? approve.sheetHtml : null;
  return {
    taskId: view.id, action: approve.action, digest, rebuild,
    heading: approve.heading, text: approve.text, termsWords: approve.termsWords ?? termsOf(approve.kind, facts),
    planHtml: sheet !== null && !holdsFormControl(sheet) ? sheet : null,
    kind: approve.kind, facts,
  };
}

/** Whether Home may offer its one-click Approve for this snapshot (B2.1): the rules ask for no password, the page is
 * not a password page, and the plan it shows passed the form-control check. Anything else is "Review the plan". */
export function offersApprove(snapshot: ApprovalSnapshot | null, sensitive: boolean): boolean {
  if (snapshot === null || sensitive || snapshot.planHtml === null) return false;
  const ask = approvalAsk(snapshot.kind, snapshot.facts);
  return ask === "click" || ask === "automatic";
}

/** A selection read: the task page as data, never minted and never extending the session (`prefetch`). Null for
 * anything else (a 204 for a session that is not a browser's, a redirect, an error, a timeout). */
export function selectionRead(href: string, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<BrowserWorkspace | null> {
  return readPage(href, "prefetch", fetcher, signal);
}

/** Step 1 of a press: the header-less, minting read of the task page as data. Null for anything that is not exactly a
 * workspace (nothing is posted then). */
export async function mintRead(href: string, fetcher: typeof fetch = fetch): Promise<BrowserWorkspace | null> {
  let url: URL;
  try { url = new URL(localUrl(href), window.location.origin); } catch { return null; }
  if (url.origin !== window.location.origin) return null;
  url.hash = "";
  url.searchParams.set("format", "workspace");
  url.searchParams.delete("request");
  try {
    const response = await fetcher(url.pathname + url.search, { credentials: "same-origin", cache: "no-store", redirect: "manual",
      headers: { accept: "application/json" }, signal: AbortSignal.timeout(ACT_TIMEOUT_MS) });
    if (response.status !== 200 || response.redirected || response.type === "opaqueredirect") return null;
    if (!(response.headers.get("content-type") ?? "").includes("application/json")) return null;
    const data: unknown = await response.json();
    return isWorkspace(data) ? data : null;
  } catch { return null; }
}

/** The nonce a minting read carries for its approval, or null (none, "unminted", malformed). */
export function mintedNonce(workspace: BrowserWorkspace | null): string | null {
  const nonce = taskViewOf(workspace)?.approve?.fields["nonce"] ?? "";
  return NONCE.test(nonce) ? nonce : null;
}

const OUTCOMES: readonly ApprovalOutcome[] = ["approved", "vote", "approved-not-rebuilt", "refused"];

/**
 * Step 2 of a press: one POST to the snapshot's approve route, asking for the answer in place. The body is exactly the
 * form token, the nonce step 1 minted, the snapshot's digest and rebuild, and `return=next`: there is no password field.
 */
export async function postInPlace(snapshot: Pick<ApprovalSnapshot, "action" | "digest" | "rebuild">, csrf: string, nonce: string,
  fetcher: typeof fetch = fetch): Promise<InPlaceAnswer> {
  const body = new URLSearchParams({ csrf, nonce, digest: snapshot.digest });
  if (snapshot.rebuild !== null) body.set("rebuild", snapshot.rebuild);
  body.set("return", "next");
  let response: Response;
  try {
    response = await fetcher(snapshot.action, { method: "POST", credentials: "same-origin", redirect: "manual", body,
      headers: keyed({ "x-toolroll-act": "in-place", accept: "application/json" }), signal: AbortSignal.timeout(ACT_TIMEOUT_MS) });
  } catch { return { kind: "lost" }; }
  // Anything the dispatcher answers before the act (signed out, a password needed, a refused key) is a page or a
  // redirect: the task page itself says what it is.
  if (response.type === "opaqueredirect" || response.redirected || !(response.headers.get("content-type") ?? "").includes("application/json")) return { kind: "elsewhere" };
  let data: unknown;
  try { data = await response.json(); } catch { return { kind: "lost" }; }
  if (data === null || typeof data !== "object") return { kind: "elsewhere" };
  const { outcome, words } = data as { outcome?: unknown; words?: unknown };
  if (typeof outcome !== "string" || !(OUTCOMES as readonly string[]).includes(outcome) || typeof words !== "string") return { kind: "elsewhere" };
  // A yes kept is only ever a 200; a refusal keeps today's status.
  if (outcome !== "refused" && response.status !== 200) return { kind: "elsewhere" };
  return { kind: "answer", outcome: outcome as ApprovalOutcome, words };
}

/** A server's words as one sentence: a capital first, a full stop last. */
export function sentence(words: string): string {
  const trimmed = words.trim();
  if (trimmed === "") return "";
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}
