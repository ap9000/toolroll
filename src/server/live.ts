/**
 * GET /live: one stream per page, joined to every room the page shows.
 *
 *   room=workspace              the reader's workspace may have changed (any meaningful write, or a lapse)
 *   room=task:<id>              the task family changed; who else has it open
 *   room=flow:<id>?card=&editing=  the flow changed; who else is on it, and on which card
 *   room=chat[?task=|?project=] the reader's own lead reply, as it runs (the only room that carries content)
 *   room=team[?conversation=]   the team conversation's cursor moved
 *
 * Every room is validated before anything is looked up, and admitted with
 * the same checks and answers as the page it belongs to, before the stream
 * opens; each is re-proved on every signal and its safety-net check, and a
 * viewer who no longer passes hears `gone`. Events name their room. A page
 * that falls behind gets one `reload` and the stream ends, so its
 * EventSource reconnects (live-bus.ts).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createLiveRooms, LiveConnection, type LiveBus, type LiveViewer } from "../live-bus.js";
import { reproveRemote } from "../operate-remote.js";
import { rowVisible } from "../project.js";
import type { MateThreadScope } from "../store.js";
import { TEAM_PASSWORD_REVERIFY_MS } from "../team-http.js";
import type { TeamActor, TeamResponse } from "../team-contract.js";
import type { WorkspaceRevision } from "../workspace-revision.js";
import type { EdgeContext } from "./handler-context.js";
import { handlersOf } from "./handler-registry.js";
import { respond } from "./http.js";
import { adapterPolicy } from "./route-policy.js";
import { requestContext } from "./request-context.js";
import type { ServerRuntime } from "./runtime.js";
import type { Who } from "./session.js";

/** A page asks for a few rooms at once: its workspace, what it shows, its conversation. */
export const LIVE_ROOMS_PER_PAGE = 5;
const ROOM_NAME = /^(workspace|task|flow|chat|team)(?::([^?]{1,400}))?(?:\?([^#]{0,600}))?$/;
/** At most one workspace nudge a second: a burst of writes is one re-read, the first heard at once. */
const WORKSPACE_SETTLE_MS = 1_000;
/** A running reply's preview: at most one snapshot every 80 ms; the last one always goes out. */
const TURN_SETTLE_MS = 80;

export type LiveRoom =
  | { kind: "workspace" }
  | { kind: "task"; task: string }
  | { kind: "flow"; flow: number; card: number | null; editing: boolean }
  | { kind: "chat"; task: string | null; project: string | null }
  | { kind: "team"; conversation: string | null };

/** A room's name, read strictly: anything else is not a room. */
export function parseLiveRoom(name: string): LiveRoom | null {
  const match = ROOM_NAME.exec(name);
  if (match === null) return null;
  const [, kind, id, query] = match;
  let key: string | null = null;
  try { key = id === undefined ? null : decodeURIComponent(id); } catch { return null; }
  const params = new URLSearchParams(query ?? "");
  const only = (...allowed: string[]): boolean => [...params.keys()].every(one => allowed.includes(one)) && allowed.every(one => params.getAll(one).length <= 1);
  switch (kind) {
    case "workspace": return key === null && query === undefined ? { kind } : null;
    case "task": return key !== null && key !== "" && query === undefined ? { kind, task: key } : null;
    case "flow": {
      const flow = Number(key), card = params.get("card");
      if (key === null || !/^[1-9][0-9]{0,9}$/.test(key) || !only("card", "editing") || (card !== null && !/^[1-9][0-9]{0,9}$/.test(card))) return null;
      return { kind, flow, card: card === null ? null : Number(card), editing: params.get("editing") === "1" };
    }
    case "chat":
      if (key !== null || !only("task", "project") || (params.has("task") && params.has("project"))) return null;
      return { kind, task: params.get("task") || null, project: params.get("project") || null };
    case "team":
      if (key !== null || !only("conversation")) return null;
      return { kind, conversation: params.get("conversation") || null };
  }
  return null;
}

type Viewer = LiveViewer;
type FlowRoomViewer = LiveViewer & { card: number | null; editing: boolean };
type ChatViewer = LiveViewer & { scope: MateThreadScope; valid: (thread?: number) => boolean; detach: (() => void) | null; leave: () => void };

const json = (response: ServerResponse, status: number, value: unknown): void => respond(response, status, "application/json", JSON.stringify(value));

export function createLiveHandlers(runtime: ServerRuntime, live: { bus: LiveBus; workspaceRevision: WorkspaceRevision; chatProjectOf: (projects: string[]) => string | null | undefined }) {
  const { store, identify, liveCeiling, familyOf, taskRooms, flowRooms, clock, matePrincipal, taskChatFocus, chatScopeOf, liveTurns, team, visible } = runtime;

  // The reader's workspace: one room for everyone, nudged by any meaningful write or a clock-bound lapse.
  const workspaceRooms = createLiveRooms<"workspace", Viewer>(() => `${live.workspaceRevision.current()}:${live.workspaceRevision.expiresAt(clock())}`, null,
    { bus: live.bus, minIntervalMs: WORKSPACE_SETTLE_MS });
  // A team audience is per actor (and per token): its key carries who reads, the room keeps how to read as them.
  const teamActors = new Map<string, TeamActor>();
  const teamRooms = createLiveRooms<string, Viewer>(key => {
    const actor = teamActors.get(key);
    const cursor = actor === undefined ? null : team.cursor(actor, (JSON.parse(key) as [string, number, string, string])[3] || undefined);
    return cursor === null ? null : String(cursor);
  }, null, { bus: live.bus });
  const chatViewers = new Set<ChatViewer>();

  /** The same session, still signed in, from the cookie and the account (never this request's context). */
  const readBrowser = (request: IncomingMessage, who: Who & { via: "cookie" }) => {
    const again = identify(request, false);
    if (again?.via !== "cookie" || again.name !== who.name || again.session.generation !== who.session.generation) return null;
    // The in-memory session may still exist after another process ends the saved session.
    const hash = runtime.sessions.hashOf(again.session);
    const saved = hash === null ? null : store.webSession(hash), account = store.accountOf(again.name);
    if (saved === null || account === null || account.revokedAt !== null || account.generation !== again.session.generation
      || saved.generation !== account.generation || saved.role !== account.role || again.role !== account.role) return null;
    return again;
  };
  const sameBrowser = (request: IncomingMessage, who: Who & { via: "cookie" }) => () => readBrowser(request, who) !== null;

  function admitted(viewer: ChatViewer, thread?: number): boolean {
    let valid = false;
    try { valid = viewer.valid(thread); } catch { /* Failed proof stops this room. */ }
    if (!valid) { viewer.connection.send(viewer.room, "gone"); viewer.leave(); }
    return valid;
  }

  /** A running reply for one viewer's thread: snapshots while it runs, then the last one. */
  function follow(viewer: ChatViewer, thread: number): void {
    if (!admitted(viewer, thread)) return;
    const turn = liveTurns.get(thread);
    if (turn === undefined || turn.done || viewer.detach !== null) return;
    let queued: NodeJS.Timeout | null = null;
    const snapshot = () => {
      if (admitted(viewer, thread)) viewer.connection.send(viewer.room, "turn", { steps: turn.steps, done: turn.done, ok: turn.ok });
    };
    const flush = (): void => {
      queued = null;
      snapshot();
      if (turn.done) stop();
    };
    const listener = (): void => {
      if (turn.done) { if (queued !== null) clearTimeout(queued); flush(); return; }
      if (queued === null) queued = setTimeout(flush, TURN_SETTLE_MS);
    };
    const stop = (): void => { if (queued !== null) clearTimeout(queued); turn.listeners.delete(listener); viewer.detach = null; };
    turn.listeners.add(listener);
    viewer.detach = stop;
    snapshot();
  }

  /** A reply starts on a thread: whoever has that conversation open follows it. */
  function turnStarted(thread: number): void {
    for (const viewer of chatViewers) {
      if (admitted(viewer) && store.liveMateThreadFor(viewer.name, viewer.scope)?.id === thread) follow(viewer, thread);
    }
  }

  /** The actor a team stream reads as, and how it is proved again while open. */
  function teamActorOf(request: IncomingMessage, who: Who): { actor: TeamActor; key: string; valid: () => boolean } | null {
    const account = store.accountOf(who.name);
    if (account === null || account.revokedAt !== null) return null;
    if (who.via === "cookie") {
      const actor = { name: who.name, generation: who.session.generation };
      return { actor, key: "", valid: sameBrowser(request, who) };
    }
    const principal = who.principal;
    if (principal !== undefined) {
      // An API token is re-proved against the store every time: unrevoked, unexpired, inside its project limit.
      const actor: TeamActor = { name: principal.account, generation: principal.generation, principal };
      return { actor, key: principal.tokenId, valid: () => {
        const again = reproveRemote(store, principal, clock());
        if (!again.ok) return false;
        actor.principal = { ...principal, scope: again.scope };
        return true;
      } };
    }
    // A password bearer is proved again once TEAM_PASSWORD_REVERIFY_MS has passed since it last was.
    const actor = { name: who.name, generation: who.generation };
    let provedAt = clock().getTime();
    return { actor, key: "password", valid: () => {
      const current = store.accountOf(actor.name);
      if (!current || current.revokedAt !== null || current.generation !== actor.generation) return false;
      const now = clock().getTime();
      if (now - provedAt < TEAM_PASSWORD_REVERIFY_MS) return true;
      const again = identify(request, false);
      if (again?.via !== "bearer" || again.name !== actor.name || again.generation !== actor.generation) return false;
      provedAt = now;
      return true;
    } };
  }

  async function liveStream(ctx: EdgeContext): Promise<void> {
    const { url, who, request, response } = ctx;
    const now = clock();
    if (who === null) return json(response, 401, { error: "session" });
    if (!adapterPolicy({ caller: who.via, capability: who.via === "bearer" && who.principal !== undefined ? who.principal.scope : who.role === "approver" ? "act" : "read" }).ok) return json(response, 403, { error: "session" });
    const names = url.searchParams.getAll("room");
    if ([...url.searchParams.keys()].some(key => key !== "room") || names.length === 0 || names.length > LIVE_ROOMS_PER_PAGE || new Set(names).size !== names.length) return json(response, 400, { error: "room" });
    const rooms = names.map(name => ({ name, room: parseLiveRoom(name) }));
    if (rooms.some(one => one.room === null) || rooms.filter(one => one.room?.kind === "workspace").length > 1 || rooms.filter(one => one.room?.kind === "chat").length > 1 || rooms.filter(one => one.room?.kind === "team").length > 1) return json(response, 400, { error: "room" });

    // Admit every room before the stream opens, with the answers each page's own stream gave.
    const joins: Array<(connection: LiveConnection) => void> = [];
    for (const { name, room } of rooms as Array<{ name: string; room: LiveRoom }>) {
      if (room.kind !== "team" && who.via !== "cookie") return json(response, 403, { error: "session" });
      if (room.kind === "workspace") {
        const browser = who as Who & { via: "cookie" };
        joins.push(connection => workspaceRooms.join("workspace", { name: who.name, room: name, connection, valid: sameBrowser(request, browser) }));
      } else if (room.kind === "task") {
        const browser = who as Who & { via: "cookie" };
        const family = familyOf(room.task);
        if (family === null || family.problem !== null) return json(response, 404, { error: "task" });
        const repo = family.root.repo, root = family.root.id, signedIn = sameBrowser(request, browser);
        joins.push(connection => taskRooms.join(root, { name: who.name, room: name, connection,
          // A sign-out or a narrowed account stops it.
          valid: () => signedIn() && rowVisible(liveCeiling(), repo) && store.accountCanAccess(who.name, repo) }));
      } else if (room.kind === "flow") {
        const browser = who as Who & { via: "cookie" };
        const flow = store.getFlow(room.flow);
        if (flow === null || flow.state !== "active" || !visible(flow.repo)) return json(response, 404, { error: "flow" });
        const repo = flow.repo, signedIn = sameBrowser(request, browser);
        joins.push(connection => flowRooms.join(flow.id, { name: who.name, room: name, connection, card: room.card, editing: room.editing,
          valid: () => signedIn() && rowVisible(liveCeiling(), repo) && store.accountCanAccess(who.name, repo) } satisfies FlowRoomViewer));
      } else if (room.kind === "chat") {
        const browser = who as Who & { via: "cookie" };
        if (who.role !== "approver") return json(response, 403, { error: "session" });
        if (matePrincipal(browser) === null) return json(response, 403, { error: "standing" });
        const focusTask = room.task === null ? null : taskChatFocus(room.task, now, who, { mintNonce: false });
        if (room.task !== null && focusTask === null) return json(response, 404, { error: "task" });
        const chatProject = focusTask !== null ? null : live.chatProjectOf(room.project === null ? [] : [room.project]);
        if (chatProject === undefined) return json(response, 404, { error: "project" });
        const scope = chatScopeOf(focusTask, chatProject);
        const valid = (expectedThread?: number) => requestContext.run({ actor: who.name, csrf: "", returnTo: "/chat" }, () => {
          const again = readBrowser(request, browser);
          if (again === null || again.role !== "approver") return false;
          const principal = matePrincipal(again);
          if (principal === null) return false;
          const thread = store.liveMateThreadFor(again.name, scope);
          // Even the default lead room is bound to the projects admitted when its thread opened.
          if (thread !== null && thread.ceilingDigest !== principal.ceilingDigest) return false;
          if (expectedThread !== undefined && thread?.id !== expectedThread) return false;
          if (scope.kind === "task") {
            const focus = taskChatFocus(room.task, clock(), again, { mintNonce: false });
            return focus !== null && focus.id === scope.key;
          }
          return scope.kind !== "project" || live.chatProjectOf([scope.key]) === scope.key;
        });
        joins.push(connection => {
          const viewer: ChatViewer = { name: who.name, room: name, connection, scope, valid, detach: null, leave: () => {
            viewer.detach?.(); chatViewers.delete(viewer); unregister(); unprove();
            if (connection.rooms === 0) connection.close();
          } };
          chatViewers.add(viewer);
          const unregister = connection.onClose(() => { viewer.detach?.(); chatViewers.delete(viewer); });
          const unprove = connection.onKeepAlive(() => { admitted(viewer); });
          const thread = store.liveMateThreadFor(who.name, scope);
          if (thread !== null) follow(viewer, thread.id);
        });
      } else {
        const proved = teamActorOf(request, who);
        if (proved === null) return json(response, 401, { version: 1, ok: false, code: "unauthenticated", message: "Sign in to continue." } satisfies TeamResponse);
        let initial: TeamResponse;
        try { initial = await team.execute(proved.actor, { operation: room.conversation ? "show" : "list", args: room.conversation ? { conversationId: room.conversation } : {} }); }
        catch { return json(response, 503, { version: 1, ok: false, code: "unavailable", message: "Conversation updates are unavailable." } satisfies TeamResponse); }
        if (!initial.ok || !initial.snapshot) return json(response, 403, initial);
        const key = JSON.stringify([proved.actor.name, proved.actor.generation, proved.key, room.conversation ?? ""]);
        teamActors.set(key, proved.actor);
        // The token or session proves itself again, then reads the room as it now stands: a narrowed project limit or a
        // lost membership is a lost room. The room's cursor reads as the latest proof.
        const valid = () => {
          if (!proved.valid()) return false;
          teamActors.set(key, proved.actor);
          return team.cursor(proved.actor, room.conversation ?? undefined) !== null;
        };
        joins.push(connection => teamRooms.join(key, { name: who.name, room: name, connection, valid }));
      }
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-accel-buffering": "no" });
    response.flushHeaders();
    const connection = new LiveConnection(response);
    // Each join below adds its room before the next speaks; a chat room alone keeps the stream open too.
    for (const join of joins) if (connection.open) join(connection);
    request.once("close", () => connection.close());
  }

  const detachChat = live.bus.subscribe(() => {
    for (const viewer of [...chatViewers]) admitted(viewer);
  });
  return {
    registrations: handlersOf("live", {}, { live: liveStream }),
    turnStarted,
    close(): void {
      detachChat();
      workspaceRooms.close();
      teamRooms.close();
      for (const viewer of [...chatViewers]) viewer.connection.close();
    },
  };
}
