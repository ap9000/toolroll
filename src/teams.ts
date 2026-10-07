/** Microsoft Teams: the leased delivery loop hosted by the ordinary worker,
 * and the HTTPS receiver the console mounts for the Bot Framework. Teams
 * has no client-initiated socket, so inbound activities arrive over HTTPS
 * and everything else runs from the database like the other channels. */
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ChatState } from "./chat-delivery-state.js";
import { chatObject as object } from "./chat-delivery.js";
import { loadTeamsCredentials, teamsAccessToken, teamsApi, verifyTeamsToken, TeamsError } from "./teams-api.js";
import { deliverTeamsPart, planTeamsNotifications, planTeamsRooms, processTeamsEvent, receiveTeams, type TeamsChatOptions } from "./teams-chat.js";
import type { Store } from "./store.js";
import { limitWords, type Admission } from "./request-budget.js";

export const TEAMS_ACTIVITY_BYTES = 64 * 1024;
export const TEAMS_MESSAGES_PATH = "/teams/messages";

/** The receiver: prove the Bot Framework token for this app, save the activity, acknowledge. Nothing runs here. */
export async function handleTeamsHttp(request: IncomingMessage, response: ServerResponse, options: { store: Store; dir: string; fetcher?: typeof fetch; clock?: () => Date; admitSource: (request: IncomingMessage) => Admission; admitTenant: (tenant: string) => Admission }): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://standing-orders.local");
  if (url.pathname !== TEAMS_MESSAGES_PATH) return false;
  const reply = (status: number, body = "{}") => { response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); response.end(body); request.resume(); return true; };
  if (request.method !== "POST") return reply(405);
  const refuseAdmission = (admitted: Admission): boolean => {
    if (admitted.ok) return false;
    if (admitted.status === 429) response.setHeader("retry-after", String(admitted.retryAfter));
    return reply(admitted.status, JSON.stringify({ error: admitted.status === 429 ? "rate-limited" : "limits-unavailable",
      message: admitted.status === 429 ? limitWords(admitted.limit, admitted.retryAfter) : "Request limits could not be checked; nothing was saved." }));
  };
  // Source admission precedes JWT verification (including key fetches). Only proved app credentials consume
  // the configured tenant's allowance; an untrusted activity cannot select or evade that allowance.
  if (refuseAdmission(options.admitSource(request))) return true;
  const credentials = loadTeamsCredentials(options.dir);
  if (credentials === null) return reply(404);
  const claims = await verifyTeamsToken(request.headers.authorization, credentials.app, options.fetcher ?? fetch);
  if (claims === null) return reply(401);
  if (refuseAdmission(options.admitTenant(credentials.tenant))) return true;
  if (Number(request.headers["content-length"] ?? 0) > TEAMS_ACTIVITY_BYTES) return reply(413);
  let raw = "";
  try {
    await new Promise<void>((resolve, reject) => {
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { raw += chunk; if (raw.length > TEAMS_ACTIVITY_BYTES) reject(new Error("too-large")); });
      request.on("end", resolve);
      request.on("error", reject);
    });
  } catch (error) { return reply(error instanceof Error && error.message === "too-large" ? 413 : 400); }
  let activity: unknown;
  try { activity = JSON.parse(raw); } catch { return reply(400); }
  const state = new ChatState(options.store, "teams");
  try {
    receiveTeams(state, credentials, activity, claims.serviceUrl, options.clock?.() ?? new Date());
  } catch {
    return reply(500, JSON.stringify({ error: "not saved" }));
  }
  // Teams expects 200 for a handled activity; an unhandled shape is also 200,
  // so that a stranger learns nothing from the answer.
  return reply(200);
}

/** The worker-side loop: a lease per installation, one pass a second. */
export async function followTeams(
  options: Omit<TeamsChatOptions, "identity" | "api" | "owner" | "current"> & { dir: string; signal: AbortSignal; notifications: () => boolean; fetcher?: typeof fetch },
): Promise<void> {
  const owner = randomBytes(16).toString("hex"), state = new ChatState(options.store, "teams");
  const pause = async (ms: number) => { try { await sleep(ms, undefined, { signal: options.signal }); } catch { /* shutdown */ } };
  while (!options.signal.aborted) {
    const credentials = loadTeamsCredentials(options.dir);
    if (!credentials || !state.lease(credentials.installation, owner, new Date())) { await pause(2000); continue; }
    let alive = true;
    const same = () => {
      const current = loadTeamsCredentials(options.dir);
      return alive && !options.signal.aborted && current?.installation === credentials.installation && current.secret === credentials.secret && state.owns(credentials.installation, owner);
    };
    const problem = (message: string) => state.prepare("UPDATE chat_runtime SET problem=? WHERE installation=? AND owner=?").run(message, credentials.installation, owner);
    const stop = () => { alive = false; };
    options.signal.addEventListener("abort", stop, { once: true });
    const heartbeat = setInterval(() => { if (!same() || !state.lease(credentials.installation, owner, new Date())) stop(); }, 10_000);
    const chat: TeamsChatOptions = { ...options, identity: credentials, owner, api: teamsApi(credentials, options.fetcher), canNotify: options.notifications, current: same };
    try {
      // Connected means the app can sign in; inbound reachability is the operator's endpoint to verify.
      try {
        await teamsAccessToken(credentials, options.fetcher);
        state.prepare("UPDATE chat_runtime SET connected=?,problem=NULL WHERE installation=? AND owner=?").run(new Date().toISOString(), credentials.installation, owner);
      } catch (error) {
        problem(error instanceof TeamsError ? error.message : "Microsoft sign-in failed. Check the Teams app credentials.");
        await pause(30_000);
        continue;
      }
      while (same()) {
        const retry = state.prepare("SELECT retry_at FROM chat_runtime WHERE installation=?").get(credentials.installation)?.retry_at;
        if (typeof retry === "string" && retry > new Date().toISOString()) { await pause(1000); continue; }
        await processTeamsEvent(chat);
        if (same()) await planTeamsRooms(chat);
        if (same()) await deliverTeamsPart(chat);
        if (same() && options.notifications()) await planTeamsNotifications(chat);
        await pause(1000);
      }
    } catch {
      if (alive) problem("Teams delivery is unavailable. Retrying shortly.");
    } finally {
      clearInterval(heartbeat);
      alive = false;
      options.signal.removeEventListener("abort", stop);
      state.prepare("UPDATE chat_runtime SET owner=NULL,lease_until=NULL,connected=NULL WHERE installation=? AND owner=?").run(credentials.installation, owner);
    }
    await pause(5000);
  }
}
export { object };
