/** What one console request knows about itself, readable anywhere below its handler. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { ServerResponse } from "node:http";
import { provideFormToken, type Html } from "../html.js";
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
  browser?: boolean;
  workspaceRead?: boolean;
  workspaceRequest?: string | null;
  workCounts?: ReturnType<typeof workCountsByProject>;
  workCrew?: { project: string | null; page: WorkIndexPage };
  lens?: string | null;
  workspaceValidator?: { key: string; revision: string; expiresAt: number; etag: string };
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

/** Run a render outside a live request (a test, a background render) as if a browser session with this token asked. */
export function withFormToken<T>(csrf: string, render: () => T): T {
  const facts = requestContext.getStore();
  return requestContext.run({ ...(facts ?? { returnTo: "/" }), csrf }, render);
}
