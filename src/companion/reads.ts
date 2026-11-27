/**
 * The paired phone's reads (Gate 1): the same data the console's Engine API sends, read in this process for one
 * paired device's account — never through a loopback HTTP request, never as this computer's local owner.
 *
 * Each read is admitted explicitly, not by the console's dispatcher (which a phone never passes through):
 *  - the device still stands (not revoked, this recovery generation) and its account is active, before AND after the
 *    read, before a byte leaves (`stands`);
 *  - the read runs under the account as the request actor (`requestContext`), so every shared guard — the console's
 *    project ceiling, the account's projects — answers for that person (guards.ts visible / admissionList / familyOf);
 *  - the task's or run's own project is proved visible to the account again by name (`visible(repo)`), not left to the
 *    list filter alone;
 *  - a task or run the account can't see and one that doesn't exist get the same answer (`not_found`).
 * Nothing here mints an approval nonce or reads a browser session; spend and provider limits are never sent.
 */

import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { WorkRows } from "../contracts/engine-api.js";
import { checkEngineResponse, ENGINE_API_VERSION } from "../contracts/engine-api.js";
import { resultDiffFileOf, resultDiffOf, resultRunsOf, stepCardsOf } from "../engine-reads.js";
import { readMainWindow } from "../live-main-read.js";
import { runLiveCommands, type Store, type TaskFamily } from "../store.js";
import type { HandlerContext } from "../server/handler-context.js";
import { requestContext } from "../server/request-context.js";
import { ROUTES } from "../server/route-table.js";
import type { ServerRuntime } from "../server/runtime.js";
import { deviceAccountStands, getPairedDevice } from "./store.js";
import type { CompanionReadHandlers, PairedDevicePrincipal } from "./daemon.js";

/** A refusal the phone sees as an RPC error code (daemon.ts sends `{code, message}`). */
export class CompanionReadError extends Error {
  constructor(readonly code: "not_found" | "invalid_params" | "invalid_cursor" | "standing_revoked" | "unavailable", message: string) {
    super(message);
  }
}

export type CompanionReadRuntime = Pick<ServerRuntime, "store" | "clock" | "evidenceRoot" | "visible" | "familyOf" | "runVisible" | "taskRepoOf" | "workAccess" | "options" | "liveCeiling">;

export interface CompanionReadDeps {
  runtime: CompanionReadRuntime;
  /** pages.ts readWorkRows: Work's own view and rows for a context. */
  readWorkRows: (ctx: HandlerContext) => Promise<WorkRows | null>;
  /** The workspace's live bus (live-bus.ts): a wake-up when anything changes; the watch re-reads on it. */
  subscribeBus?: (listener: () => void) => () => void;
  /** A label for this Mac in the phone's header. */
  workspaceLabel: () => string;
  toolrollVersion: string;
  /** How often a watch re-reads a run with no bus wake-up (ms). */
  watchPollMs?: number;
}

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const RUN_ID = /^[1-9][0-9]{0,14}$/;
/** The phone's view names: the web's own (workspace-ui.ts parseWorkView), and "done" as the web's Finished link says it. */
const WORK_VIEWS = new Map([["all", "all"], ["needs-you", "needs-you"], ["running", "running"], ["queued", "queued"], ["ready", "ready"], ["completed", "completed"], ["done", "completed"]]);
const MAX_CURSOR = 4_096;
const WORK_ROUTE = ROUTES.find(route => route.id === "work.rows");

const stringParam = (params: Record<string, unknown>, key: string): string | null => {
  const value = params[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new CompanionReadError("invalid_params", `${key} must be a string`);
  return value;
};

export function createCompanionReads(deps: CompanionReadDeps): CompanionReadHandlers {
  const { runtime } = deps;
  const store: Store = runtime.store;
  /** A random key for this console's live-window cursors (a restart makes old cursors start over, as the web's do). */
  const cursorKey = (globalThis.crypto as Crypto).getRandomValues(new Uint8Array(32));
  const cursorKeyBuf = Buffer.from(cursorKey);

  /** The device and its account still stand: the same facts the engine checks before dispatch, read again. */
  function stands(principal: PairedDevicePrincipal): boolean {
    const device = getPairedDevice(store.handle, principal.deviceId);
    const identity = store.workspaceIdentity();
    if (device === null || device.revokedAt !== null || device.activatedAt === null || device.recoveryGeneration !== identity.recoveryGeneration
      || device.accountName !== principal.accountName || identity.recoveryGeneration !== principal.recoveryGeneration) return false;
    return deviceAccountStands(device, store.accountOf(principal.accountName));
  }

  /** What the account may see right now (daemon.ts sends queued data only while this is unchanged): the device's
   * standing, the account's credential generation and projects, and the console's project ceiling. */
  function accessSignature(principal: PairedDevicePrincipal): string {
    const account = store.accountOf(principal.accountName);
    const ceiling = runtime.liveCeiling();
    return JSON.stringify([stands(principal), account?.generation ?? null, account?.revokedAt ?? null, account?.projects ?? null,
      [...ceiling.repos].sort(), [...ceiling.roots].sort()]);
  }

  /** Runs `work` as the device's account (the shared guards read this actor), refusing before and after. */
  async function asDevice<T>(principal: PairedDevicePrincipal, work: () => T | Promise<T>): Promise<T> {
    if (!stands(principal)) throw new CompanionReadError("standing_revoked", "This iPhone is no longer paired.");
    const result = await requestContext.run({ csrf: "", returnTo: "/", actor: principal.accountName }, work);
    if (!stands(principal)) throw new CompanionReadError("standing_revoked", "This iPhone is no longer paired.");
    return result;
  }

  /** The task's family, in view for the current actor, with its project proved again by name. */
  function familyInView(params: Record<string, unknown>): TaskFamily {
    const task = stringParam(params, "task");
    if (task === null || !TASK_ID.test(task)) throw new CompanionReadError("invalid_params", "task is required");
    const family = runtime.familyOf(task);
    if (family === null || family.problem !== null || !runtime.visible(family.current.repo) || !runtime.visible(family.root.repo)) {
      throw new CompanionReadError("not_found", "No such task.");
    }
    return family;
  }

  /** The run named, if the actor can see it on its project (the Live grid's admission, without a browser session). */
  function runInView(runParam: string | null) {
    if (runParam === null || !RUN_ID.test(runParam)) throw new CompanionReadError("invalid_params", "run is required");
    const run = store.getRun(Number(runParam));
    const repo = run === null ? null : runtime.taskRepoOf(run.taskRef);
    const actor = requestContext.getStore()?.actor;
    if (run === null || repo === null || actor === undefined || !runtime.runVisible(run) || !runtime.visible(repo) || !store.accountCanAccess(actor, repo)) {
      throw new CompanionReadError("not_found", "No such run.");
    }
    return run;
  }

  function liveWindowOf(runParam: string | null, cursor: string | null) {
    const run = runInView(runParam);
    const local = runtime.options.localRunner !== undefined && run.runner === runtime.options.localRunner;
    const window = local ? readMainWindow(runtime.evidenceRoot, run.id, cursor, { key: cursorKeyBuf, commands: runLiveCommands(store, run.id) }) : null;
    // Re-proved after the read (a narrowed account or a run gone from view gets nothing it read).
    runInView(runParam);
    return { run, window };
  }

  return {
    accessSignature,
    deviceHello: principal => asDevice(principal, () => ({
      version: ENGINE_API_VERSION,
      workspaceId: principal.workspaceId,
      workspaceLabel: deps.workspaceLabel(),
      account: principal.accountName,
      deviceId: principal.deviceId,
      toolroll: deps.toolrollVersion,
    })),

    workRows: (principal, params) => asDevice(principal, async () => {
      if (WORK_ROUTE === undefined) throw new CompanionReadError("unavailable", "Work isn't available.");
      const view = WORK_VIEWS.get(stringParam(params, "view") ?? "all");
      const cursor = stringParam(params, "cursor");
      if (view === undefined) throw new CompanionReadError("invalid_params", "Unknown view.");
      if (cursor !== null && (cursor.length === 0 || cursor.length > MAX_CURSOR)) throw new CompanionReadError("invalid_cursor", "Open the first page.");
      if (params["project"] !== undefined) throw new CompanionReadError("invalid_params", "Project filters aren't available on the phone yet.");
      const url = new URL("http://companion.invalid/work/rows");
      if (view !== "all") url.searchParams.set("view", view);
      if (cursor !== null) url.searchParams.set("cursor", cursor);
      const account = store.accountOf(principal.accountName)!;
      // A detached exchange: nothing is sent anywhere; a refusal Work writes is read back as its status only.
      const request = new IncomingMessage(new Socket());
      request.method = "GET";
      request.url = url.pathname + url.search;
      const response = new ServerResponse(request);
      const ctx: HandlerContext = {
        url, request, response, route: WORK_ROUTE, now: runtime.clock(), project: null, chosenProject: null, posted: new URLSearchParams(),
        // The least authority a Who can carry: a viewer by API token without a token principal — no browser session,
        // no local owner, no remote-terminal path, no instance-operator spend.
        who: { name: principal.accountName, via: "bearer", role: "viewer", generation: account.generation },
      };
      const rows = await deps.readWorkRows(ctx);
      if (rows === null) {
        if (cursor !== null) throw new CompanionReadError("invalid_cursor", "This page has expired. Open the first page.");
        throw new CompanionReadError("invalid_params", "Work refused that view.");
      }
      // The web's `next` is a link to the next page; the phone gets that page's cursor itself.
      const nextCursor = rows.next === null ? null : new URL(rows.next, "http://companion.invalid").searchParams.get("cursor");
      return { ...rows, next: nextCursor, spend: null, limits: null };
    }),

    taskSteps: (principal, params) => asDevice(principal, () => {
      const family = familyInView(params);
      const cards = stepCardsOf({ store, family, now: runtime.clock(), access: runtime.workAccess(), evidenceRoot: runtime.evidenceRoot, viewer: principal.accountName, withChoices: false });
      familyInView(params);
      return checkEngineResponse("stepCards", cards);
    }),

    taskDiff: (principal, params) => asDevice(principal, () => {
      const runParam = stringParam(params, "run");
      const fileRaw = params["file"];
      if (runParam !== null && !RUN_ID.test(runParam)) throw new CompanionReadError("invalid_params", "run must be a run id");
      if (fileRaw !== undefined && (typeof fileRaw !== "number" || !Number.isInteger(fileRaw) || fileRaw < 0 || fileRaw > 999_999)) {
        throw new CompanionReadError("invalid_params", "file must be a file index");
      }
      if (fileRaw !== undefined && runParam === null) throw new CompanionReadError("invalid_params", "file needs run");
      const family = familyInView(params);
      const results = resultRunsOf(store, family).filter(run => runtime.runVisible(run));
      const run = runParam === null ? results[0] ?? null : results.find(one => one.id === Number(runParam)) ?? null;
      if (runParam !== null && run === null) throw new CompanionReadError("not_found", "No such run.");
      if (fileRaw === undefined) {
        const list = resultDiffOf(store, runtime.evidenceRoot, family.root.id, run);
        familyInView(params);
        return checkEngineResponse("resultDiff", list);
      }
      const one = resultDiffFileOf(store, runtime.evidenceRoot, family.root.id, run!, fileRaw as number);
      familyInView(params);
      if (one === null) throw new CompanionReadError("not_found", "No such file.");
      return checkEngineResponse("resultDiffFile", one);
    }),

    // Gate 1: the phone reads approval terms from its step cards (stepCardsOf, the web's own source). This route stays
    // on the allowlist for a later gate and answers that there is nothing to take here.
    taskApprovalRead: (principal, params) => asDevice(principal, () => {
      const family = familyInView(params);
      return { version: ENGINE_API_VERSION, task: family.current.id, key: null, digest: null, nonce: null, terms: [], problem: "Approve on your Mac." };
    }),

    runWindowRead: (principal, params) => asDevice(principal, () => {
      const cursor = stringParam(params, "cursor");
      if (cursor !== null && cursor.length > MAX_CURSOR) throw new CompanionReadError("invalid_cursor", "Start again.");
      const { run, window } = liveWindowOf(stringParam(params, "run"), cursor);
      return checkEngineResponse("liveSessionWindow", {
        version: ENGINE_API_VERSION,
        session: { kind: "run", id: run.id, task: null },
        room: `run:${run.id}`,
        live: run.finishedAt === null,
        file: "main",
        window: window === null ? { ok: false, reason: "off" } : window.ok
          ? { ok: true, records: window.records, cursor: window.cursor, restarted: window.restarted, earlier: window.earlier,
            quarantined: window.quarantined, skipped: window.skipped, more: window.more }
          : { ok: false, reason: window.reason },
      });
    }),

    runWatchSubscribe: (principal, params, emit, end) => {
      // Admitted once now; every tick re-proves the device, the account and the run before anything is emitted.
      let cursor: string | null;
      let runParam: string | null;
      try {
        runParam = stringParam(params, "run");
        cursor = stringParam(params, "cursor");
        if (!stands(principal)) return { ok: false, code: "standing_revoked", message: "This iPhone is no longer paired." };
        requestContext.run({ csrf: "", returnTo: "/", actor: principal.accountName }, () => runInView(runParam));
      } catch (error) {
        const code = error instanceof CompanionReadError ? error.code : "invalid_params";
        return { ok: false, code, message: error instanceof Error ? error.message : "Can't watch that run." };
      }
      let closed = false, reading = false, again = false;
      const tick = (): void => {
        if (closed) return;
        if (reading) { again = true; return; }
        reading = true;
        try {
          // Lost standing or sight of the run: the watch ends as refused, and nothing it queued is sent.
          if (!stands(principal)) { stop(); end?.("denied"); return; }
          const read = requestContext.run({ csrf: "", returnTo: "/", actor: principal.accountName }, () => {
            try { return liveWindowOf(runParam, cursor); } catch { return null; }
          });
          if (read === null) { stop(); end?.("denied"); return; }
          const window = read.window;
          if (window !== null && window.ok) {
            cursor = window.cursor;
            for (const record of window.records) {
              if (closed) return;
              if (!stands(principal)) { stop(); end?.("denied"); return; }
              emit(Buffer.from(JSON.stringify(record), "utf8"));
            }
          }
          // The run is over and everything it wrote has been sent: END, then stop.
          if (read.run.finishedAt !== null && (window === null || !window.ok || !window.more)) { stop(); end?.(); }
        } finally {
          reading = false;
          if (again && !closed) { again = false; queueMicrotask(tick); }
        }
      };
      const timer = setInterval(tick, deps.watchPollMs ?? 2_000);
      timer.unref?.();
      const unsubscribeBus = deps.subscribeBus?.(() => tick()) ?? (() => {});
      function stop(): void {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        unsubscribeBus();
      }
      queueMicrotask(tick);
      return { ok: true, unsubscribe: stop };
    },
  };
}
