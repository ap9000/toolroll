/** What one console request knows about itself, readable anywhere below its handler. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { ServerResponse } from "node:http";
import { provideAdvancedShown } from "../advanced-view.js";
import { provideFormToken, providePasswordless, type Html } from "../html.js";
import type { workCountsByProject, WorkIndexPage } from "../work-index.js";

export type RequestFacts = {
  appOrigins?: readonly (string | null)[];
  sso?: { label: string; fresh: boolean } | undefined;
  refusal?: (response: ServerResponse, status: number, body: Html) => void;
  theme?: "light" | "dark" | null;
  accent?: string | null;
  updateSeen?: string | null;
  /** The signed-in browser session's form token ("" for an API token): every POST form carries it (postForm). */
  csrf: string;
  returnTo: string;
  actor?: string;
  createdTask?: string;
  /** This request's latency timeline (latency-timeline.ts): kept when the answer was slow. */
  timeline?: import("../latency-timeline.js").Timeline;
  browser?: boolean;
  workspaceRead?: boolean;
  /** Why a `?format=workspace` GET was made (`x-toolroll-read`, readPurpose below): bookkeeping only, never authority. */
  readPurpose?: ReadPurpose;
  /** A workspace read from an app that runs page work itself (`x-toolroll-work`, task-page-in-app.md §2): it picks
   * which of two forms of the same page is sent, never what may be read. */
  appWork?: boolean;
  /** The route table row that matched this request (route-table.ts ids), for the in-place allowlists (serve.ts). */
  routeId?: string;
  /** Receipt reconciliation, task and result reads (`request`, `task`, `result`): work is read afresh, never cached. */
  freshWork?: boolean;
  /** A workspace re-read's If-None-Match: the content validator it holds from its last read. */
  workspaceIfNoneMatch?: string;
  workspaceRequest?: string | null;
  workCounts?: ReturnType<typeof workCountsByProject>;
  workCrew?: { project: string | null; page: WorkIndexPage };
  /** The chrome this request already read (console-chrome.ts keys): one snapshot per request, however often it asks. */
  chromeReads?: Map<string, unknown>;
  lens?: string | null;
  workspaceValidator?: { key: string; revision: string; expiresAt: number; etag: string };
  /** Passwordless is on and this is a signed-in browser: ceremony password fields render as nothing (html.ts reauth). */
  passwordless?: boolean;
  /** Settings → Advanced: false when the signed-in person's pages leave out advanced entry points (advanced.ts). Absent:
   * shown. It only hides links; it never decides what may be read or done. */
  advanced?: boolean;
  /** The browser session's open project (display only: the sidebar's picker names it). */
  openProject?: string | null;
  /** Easy start: a local owner with no password yet: every step-up field is the Set a password link instead (this href). */
  localStepUp?: string;
  /** Easy-start C2: the browser mutation key is required here, so every page that posts carries the key fill script. */
  keyFill?: boolean;
  /** Easy-start C2: this session's key is from an earlier console start (or it has none): how to reconnect. */
  reconnect?: import("./mutation-key.js").Reconnect | null;
};

/**
 * The request's own session facts, readable from anywhere below the
 * dispatcher without threading them through forty call sites: the csrf
 * token every POST form carries, and the path a switch returns
 * to. AsyncLocalStorage follows the request's own async chain, so two
 * interleaved requests never read each other's token.
 */
export const requestContext = new AsyncLocalStorage<RequestFacts>();
provideFormToken(() => requestContext.getStore()?.csrf);
providePasswordless(() => requestContext.getStore()?.passwordless === true);
provideAdvancedShown(() => requestContext.getStore()?.advanced !== false);

/** Run a render outside a live request (a test, a background render) as if a browser session with this token asked. */
export function withFormToken<T>(csrf: string, render: () => T): T {
  const facts = requestContext.getStore();
  return requestContext.run({ ...(facts ?? { returnTo: "/" }), csrf }, render);
}

/**
 * What a workspace read is for (docs/plans/live-pages-and-home.md A1.4), from its `x-toolroll-read` header. It is a hint
 * about bookkeeping (does the read extend the session, does it mint an approval nonce), never proof that a person
 * clicked, and no authorisation decision reads it. Absent, `poll` or anything unknown is today's re-read: `poll`.
 */
export type ReadPurpose = "poll" | "navigate" | "prefetch";
export function readPurpose(header: string | string[] | undefined): ReadPurpose {
  return header === "navigate" || header === "prefetch" ? header : "poll";
}
