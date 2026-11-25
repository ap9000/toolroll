import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { checkEngineResponse, ENGINE_API_VERSION, type DirectChatDetail, type DirectChatMutated, type DirectChatsList, type DirectChatStarted, type EngineResponseName } from "../contracts/engine-api.js";
import {
  DirectChatHost,
  directChatPostureOf,
  importLegacyDirectChatJson,
  isDirectChatProvider,
  type DirectChatHostSeams,
  type DirectChatProvider,
  type DirectChatThreadRow,
} from "../direct-chat.js";
import { soloNow } from "../install-mode.js";
import { compareInstalled, laptopServiceDefinition } from "../laptop-service.js";
import type { LiveBus } from "../live-bus.js";
import { localOwnerStandsNow, type LocalOwnerAct } from "../local-owner.js";
import { projectName, rowVisible } from "../project.js";
import type { HandlerContext } from "./handler-context.js";
import { handlersOf } from "./handler-registry.js";
import { respond } from "./http.js";
import { rereadBrowser } from "./live.js";
import type { ServerRuntime } from "./runtime.js";
import type { Who } from "./session.js";

const THREAD_PATH = /^\/engine\/direct-chats\/([a-f0-9]{32})(?:\/(messages|stop|model|delete))?$/;
const HEX32 = /^[0-9a-f]{32}$/;

type CookieWho = Extract<Who, { via: "cookie" }>;

export type DirectChatServerDeps = {
  bus: LiveBus;
  seams?: Partial<DirectChatHostSeams>;
  disableLegacyImport?: boolean;
};

export function createDirectChatHandlers(runtime: ServerRuntime, deps: DirectChatServerDeps) {
  const { store, liveCeiling, managedRepos } = runtime;
  const dbFile = store.databaseFile();
  const stateRoot = deps.seams?.stateRoot ?? (dbFile && dbFile !== ":memory:" ? dirname(dbFile) : join(tmpdir(), "toolroll-direct-chat"));

  const host = new DirectChatHost(store, {
    stateRoot,
    ...deps.seams,
    onNotify: note => {
      deps.seams?.onNotify?.(note);
      deps.bus.publish({ revision: `dc:${note.threadId}:${Date.now()}` });
    },
  });
  if (!deps.disableLegacyImport && !store.isDemo() && dbFile && dbFile !== ":memory:" && soloNow(store)) {
    try {
      const owners = store.handle
        .prepare("SELECT name, generation FROM approver WHERE revoked_at IS NULL")
        .all() as Array<{ name: string; generation: number }>;
      if (owners.length === 1 && owners[0]) {
        importLegacyDirectChatJson({ store, owner: owners[0].name, accountGeneration: owners[0].generation });
      }
    } catch {
      // Legacy Mac JSON import is best-effort and never blocks server startup.
    }
  }
  host.startPolling();

  const json = (ctx: HandlerContext, status: number, value: unknown): void =>
    respond(ctx.response, status, "application/json", JSON.stringify(value));
  const checked = (ctx: HandlerContext, status: number, name: EngineResponseName, value: unknown): void =>
    json(ctx, status, checkEngineResponse(name, value));

  function admit(ctx: HandlerContext, act: LocalOwnerAct | null): { ok: true; who: CookieWho } | { ok: false; status: number; error: string } {
    if (store.isDemo()) return { ok: false, status: 403, error: "Direct chat is unavailable in demo mode." };
    if (ctx.who.via !== "cookie") return { ok: false, status: 403, error: "Direct chat requires a local browser or desktop session." };
    if (!runtime.fromThisComputer(ctx.request)) {
      return { ok: false, status: 403, error: "Direct chat is only available from this computer over loopback." };
    }
    if (!soloNow(store)) {
      return { ok: false, status: 403, error: "Direct chat is only available on solo local installs." };
    }
    const current = rereadBrowser(runtime, ctx.request, ctx.who);
    if (current === null || current.role !== "approver") {
      return { ok: false, status: 403, error: "Your sign-in changed. Sign in again." };
    }
    if (current.authority === "local-owner" && act !== null) {
      const hash = runtime.sessions.hashOf(current.session);
      if (
        current.session.localGeneration === null
        || hash === null
        || !localOwnerStandsNow(store, {
          account: current.name,
          localGeneration: current.session.localGeneration,
          accountGeneration: current.session.generation,
          transport: "browser",
          act,
          sessionHash: hash,
          request: null,
        })
      ) {
        return { ok: false, status: 403, error: "Local session no longer stands." };
      }
    }
    return { ok: true, who: current };
  }

  function resolveAdmittedRepo(owner: string, projectOrPath: string): string | null {
    const trimmed = projectOrPath.trim();
    if (trimmed === "") return null;
    const repos = managedRepos();
    const ceiling = liveCeiling();
    for (const repo of repos) {
      if (!rowVisible(ceiling, repo) || !store.accountCanAccess(owner, repo)) continue;
      if (repo === trimmed || projectName(repo).toLowerCase() === trimmed.toLowerCase()) {
        return repo;
      }
    }
    return null;
  }

  function canReachThread(owner: string, thread: DirectChatThreadRow): boolean {
    if (thread.owner !== owner) return false;
    const ceiling = liveCeiling();
    return rowVisible(ceiling, thread.repo) && store.accountCanAccess(owner, thread.repo);
  }

  function isBackgroundOn(): boolean {
    if (!dbFile || dbFile === ":memory:") return false;
    try {
      const unit = laptopServiceDefinition({
        platform: process.platform,
        home: process.env["HOME"] ?? "",
        node: process.execPath,
        dist: dirname(new URL(import.meta.url).pathname),
        db: dbFile,
        port: 4180,
      });
      if ("error" in unit) return false;
      const existing = existsSync(unit.path) ? readFileSync(unit.path, "utf8") : null;
      return compareInstalled(existing, unit) === "same";
    } catch {
      return false;
    }
  }

  function toSummary(row: DirectChatThreadRow & { running: boolean; lastStatus: DirectChatsList["threads"][number]["lastStatus"]; changedFilesCount: number }) {
    return {
      id: row.id,
      title: row.title,
      project: row.project,
      branch: row.branch,
      provider: row.provider,
      modelId: row.modelId,
      posture: directChatPostureOf(row.provider),
      running: row.running,
      lastStatus: row.lastStatus,
      changedFilesCount: row.changedFilesCount,
      mainDirtyFiles: row.mainDirtyFiles,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async function list(ctx: HandlerContext): Promise<void> {
    const gate = admit(ctx, null);
    if (!gate.ok) {
      return checked(ctx, gate.status, "directChatsList", {
        version: ENGINE_API_VERSION,
        available: false,
        problem: gate.error,
        backgroundOn: false,
        threads: [],
      } satisfies DirectChatsList);
    }
    const projectFilter = ctx.url.searchParams.get("project");
    const visibleThreads = host
      .listThreads(gate.who.name, projectFilter)
      .filter(t => canReachThread(gate.who.name, t))
      .map(toSummary);

    return checked(ctx, 200, "directChatsList", {
      version: ENGINE_API_VERSION,
      available: true,
      problem: null,
      backgroundOn: isBackgroundOn(),
      threads: visibleThreads,
    } satisfies DirectChatsList);
  }

  async function detail(ctx: HandlerContext): Promise<void> {
    const gate = admit(ctx, null);
    if (!gate.ok) return checked(ctx, gate.status, "refusal", { error: gate.error });
    const match = THREAD_PATH.exec(ctx.url.pathname);
    const threadId = match?.[1] ?? "";
    const found = host.getThread(gate.who.name, threadId);
    if (found === null || !canReachThread(gate.who.name, found.thread)) {
      return checked(ctx, 404, "refusal", { error: "Chat thread not found." });
    }
    if (admit(ctx, null).ok === false) {
      return checked(ctx, 403, "refusal", { error: "Your sign-in changed. Sign in again." });
    }
    const lastStatus = found.turns.at(-1)?.status ?? null;
    return checked(ctx, 200, "directChatDetail", {
      version: ENGINE_API_VERSION,
      room: `direct-chat:${found.thread.id}`,
      thread: toSummary({
        ...found.thread,
        running: found.running,
        lastStatus,
        changedFilesCount: found.diff.changedFiles.length,
      }),
      turns: found.turns.map(turn => ({
        id: turn.id,
        seq: turn.seq,
        userPrompt: turn.userPrompt,
        switchedFromProvider: turn.switchedFromProvider,
        status: turn.status,
        assistantText: turn.assistantText,
        errorText: turn.errorText,
        createdAt: turn.createdAt,
        finishedAt: turn.finishedAt,
        tools: turn.tools,
      })),
      diff: found.diff,
    } satisfies DirectChatDetail);
  }

  async function start(ctx: HandlerContext): Promise<void> {
    const gate = admit(ctx, "direct-chat-start");
    if (!gate.ok) return checked(ctx, gate.status, "directChatStarted", { ok: false, error: gate.error } satisfies DirectChatStarted);

    const project = ctx.posted.get("project") ?? "";
    const prompt = ctx.posted.get("prompt") ?? "";
    const providerRaw = ctx.posted.get("provider") ?? "claude";
    const modelId = ctx.posted.get("model") ?? "";
    const requestId = ctx.posted.get("request") ?? "";

    if (!isDirectChatProvider(providerRaw)) {
      return checked(ctx, 400, "directChatStarted", { ok: false, error: "Choose Claude, Codex, or Gemini." } satisfies DirectChatStarted);
    }
    if (!HEX32.test(requestId)) {
      return checked(ctx, 400, "directChatStarted", { ok: false, error: "Missing 32-hex request id." } satisfies DirectChatStarted);
    }
    const repo = resolveAdmittedRepo(gate.who.name, project);
    if (repo === null) {
      return checked(ctx, 404, "directChatStarted", { ok: false, error: "Choose a connected project first." } satisfies DirectChatStarted);
    }

    const res = host.createThread({
      owner: gate.who.name,
      localGeneration: gate.who.authority === "local-owner" ? gate.who.session.localGeneration : null,
      accountGeneration: gate.who.session.generation,
      requestId,
      repo,
      provider: providerRaw as DirectChatProvider,
      modelId,
      prompt,
    });
    if (!res.ok) {
      return checked(ctx, res.status, "directChatStarted", { ok: false, error: res.error } satisfies DirectChatStarted);
    }
    return checked(ctx, 200, "directChatStarted", {
      ok: true,
      threadId: res.thread.id,
      turnId: res.turn.id,
      room: `direct-chat:${res.thread.id}`,
    } satisfies DirectChatStarted);
  }

  async function send(ctx: HandlerContext): Promise<void> {
    const gate = admit(ctx, "direct-chat-send");
    if (!gate.ok) return checked(ctx, gate.status, "directChatStarted", { ok: false, error: gate.error } satisfies DirectChatStarted);
    const match = THREAD_PATH.exec(ctx.url.pathname);
    const threadId = match?.[1] ?? "";
    const found = host.getThread(gate.who.name, threadId);
    if (found === null || !canReachThread(gate.who.name, found.thread)) {
      return checked(ctx, 404, "directChatStarted", { ok: false, error: "Chat thread not found." } satisfies DirectChatStarted);
    }
    const prompt = ctx.posted.get("prompt") ?? "";
    const requestId = ctx.posted.get("request") ?? "";
    const res = host.sendMessage({
      owner: gate.who.name,
      threadId,
      requestId,
      prompt,
    });
    if (!res.ok) {
      return checked(ctx, res.status, "directChatStarted", { ok: false, error: res.error } satisfies DirectChatStarted);
    }
    return checked(ctx, 200, "directChatStarted", {
      ok: true,
      threadId,
      turnId: res.turn.id,
      room: `direct-chat:${threadId}`,
    } satisfies DirectChatStarted);
  }

  async function stop(ctx: HandlerContext): Promise<void> {
    const gate = admit(ctx, "direct-chat-stop");
    if (!gate.ok) return checked(ctx, gate.status, "directChatMutated", { ok: false, error: gate.error } satisfies DirectChatMutated);
    const match = THREAD_PATH.exec(ctx.url.pathname);
    const threadId = match?.[1] ?? "";
    const found = host.getThread(gate.who.name, threadId);
    if (found === null || !canReachThread(gate.who.name, found.thread)) {
      return checked(ctx, 404, "directChatMutated", { ok: false, error: "Chat thread not found." } satisfies DirectChatMutated);
    }
    const res = host.stopThread(gate.who.name, threadId);
    if (!res.ok) return checked(ctx, res.status, "directChatMutated", { ok: false, error: res.error } satisfies DirectChatMutated);
    return checked(ctx, 200, "directChatMutated", { ok: true, said: res.stopped ? "Stopped." : "Nothing was running." } satisfies DirectChatMutated);
  }

  async function switchModel(ctx: HandlerContext): Promise<void> {
    const gate = admit(ctx, "direct-chat-manage");
    if (!gate.ok) return checked(ctx, gate.status, "directChatMutated", { ok: false, error: gate.error } satisfies DirectChatMutated);
    const match = THREAD_PATH.exec(ctx.url.pathname);
    const threadId = match?.[1] ?? "";
    const found = host.getThread(gate.who.name, threadId);
    if (found === null || !canReachThread(gate.who.name, found.thread)) {
      return checked(ctx, 404, "directChatMutated", { ok: false, error: "Chat thread not found." } satisfies DirectChatMutated);
    }
    const providerRaw = ctx.posted.get("provider") ?? "";
    const modelId = ctx.posted.get("model") ?? "";
    if (!isDirectChatProvider(providerRaw)) {
      return checked(ctx, 400, "directChatMutated", { ok: false, error: "Choose Claude, Codex, or Gemini." } satisfies DirectChatMutated);
    }
    const res = host.switchModel({ owner: gate.who.name, threadId, provider: providerRaw, modelId });
    if (!res.ok) return checked(ctx, res.status, "directChatMutated", { ok: false, error: res.error } satisfies DirectChatMutated);
    return checked(ctx, 200, "directChatMutated", { ok: true, said: "Model updated." } satisfies DirectChatMutated);
  }

  async function remove(ctx: HandlerContext): Promise<void> {
    const gate = admit(ctx, "direct-chat-manage");
    if (!gate.ok) return checked(ctx, gate.status, "directChatMutated", { ok: false, error: gate.error } satisfies DirectChatMutated);
    const match = THREAD_PATH.exec(ctx.url.pathname);
    const threadId = match?.[1] ?? "";
    const found = host.getThread(gate.who.name, threadId);
    if (found === null || !canReachThread(gate.who.name, found.thread)) {
      return checked(ctx, 404, "directChatMutated", { ok: false, error: "Chat thread not found." } satisfies DirectChatMutated);
    }
    const discardChanges = ctx.posted.get("discard") === "1" || ctx.posted.get("discard") === "true";
    const keepClone = ctx.posted.get("keepBranch") === "1" || ctx.posted.get("keepBranch") === "true";
    const res = host.deleteThread({ owner: gate.who.name, threadId, discardChanges, keepClone });
    if (!res.ok) {
      return checked(ctx, res.status, "directChatMutated", {
        ok: false,
        error: res.error,
        ...(res.code ? { code: res.code } : {}),
      } satisfies DirectChatMutated);
    }
    return checked(ctx, 200, "directChatMutated", { ok: true, said: "Chat removed." } satisfies DirectChatMutated);
  }

  return {
    host,
    registrations: handlersOf("tasks", {
      "direct-chat.list": list,
      "direct-chat.detail": detail,
      "direct-chat.start": start,
      "direct-chat.send": send,
      "direct-chat.stop": stop,
      "direct-chat.model": switchModel,
      "direct-chat.delete": remove,
    }),
    close(): void {
      host.close();
    },
  };
}
