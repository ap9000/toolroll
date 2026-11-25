import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkEngineResponse,
  ENGINE_API_VERSION,
  type DirectChatAttached,
  type DirectChatDetail,
  type DirectChatMutated,
  type DirectChatShipped,
  type DirectChatShipPreviewRead,
  type DirectChatsList,
  type DirectChatStarted,
  type EngineResponseName,
} from "../contracts/engine-api.js";
import {
  DirectChatHost,
  directChatPostureOf,
  importLegacyDirectChatJson,
  isDirectChatProvider,
  type DirectChatHostSeams,
  type DirectChatProvider,
  type DirectChatThreadRow,
} from "../direct-chat.js";
import { listDirectChatSubscriptionModels } from "../direct-chat-catalog.js";
import { imageContentHeaders, type DirectChatArtifactRow } from "../direct-chat-artifacts.js";
import {
  cancelDirectChatShip,
  executeDirectChatShip,
  listDirectChatShips,
  previewDirectChatShip,
  type DirectChatShipMode,
  type DirectChatShipRow,
} from "../direct-chat-ship.js";
import { soloNow } from "../install-mode.js";
import { backgroundInstalled } from "../laptop-background.js";
import type { LiveBus } from "../live-bus.js";
import { localOwnerStandsNow, type LocalOwnerAct } from "../local-owner.js";
import { projectName, rowVisible } from "../project.js";
import type { HandlerContext } from "./handler-context.js";
import { handlersOf } from "./handler-registry.js";
import { redirect, respond } from "./http.js";
import { html, postForm } from "../html.js";
import { screen } from "./chrome.js";
import { btn } from "./kit.js";
import { rereadBrowser } from "./live.js";
import type { ServerRuntime } from "./runtime.js";
import type { Who } from "./session.js";

const THREAD_PATH = /^\/engine\/direct-chats\/([a-f0-9]{32})(?:\/(messages|stop|model|delete|attachments|apply-main-edits|repair|ship-preview|ship|ship-cancel))?$/;
const ARTIFACT_PATH = /^\/engine\/direct-chats\/([a-f0-9]{32})\/artifacts\/([a-f0-9]{32})$/;
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
      return backgroundInstalled();
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
      effort: row.effort,
      posture: directChatPostureOf(row.provider),
      running: row.running,
      lastStatus: row.lastStatus,
      changedFilesCount: row.changedFilesCount,
      mainDirtyFiles: row.mainDirtyFiles,
      usage: row.usage,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  function toArtifactView(row: DirectChatArtifactRow) {
    return {
      id: row.id,
      kind: row.kind,
      filename: row.filename,
      mimeType: row.mimeType,
      byteSize: row.byteSize,
      url: `/engine/direct-chats/${row.threadId}/artifacts/${row.id}`,
      sourcePath: row.sourcePath,
      createdAt: row.createdAt,
    };
  }

  function toShipSummary(row: DirectChatShipRow) {
    return {
      id: row.id,
      seq: row.seq,
      mode: row.mode,
      branch: row.branch,
      candidateSha: row.candidateSha,
      state: row.state,
      taskId: row.taskId,
      prUrl: row.prUrl,
      detail: row.detail,
      createdAt: row.createdAt,
      stateAt: row.stateAt,
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
        models: [],
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
      models: listDirectChatSubscriptionModels(store),
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
    const ships = listDirectChatShips(store, found.thread.id).map(toShipSummary);
    const diffScope = ctx.url.searchParams.get("scope");
    const turnParam = ctx.url.searchParams.get("turn");
    const responseDiff = (diffScope === "turn" || (turnParam !== null && HEX32.test(turnParam)))
      ? (host.readTurnDiff(gate.who.name, found.thread.id, turnParam) ?? { changedFiles: [], diffText: "", dirty: false })
      : found.diff;
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
        usage: turn.usage,
        tools: turn.tools,
        artifacts: turn.artifacts.map(toArtifactView),
      })),
      attachments: found.attachments.map(toArtifactView),
      ships,
      diff: responseDiff,
    } satisfies DirectChatDetail);
  }

  async function start(ctx: HandlerContext): Promise<void> {
    const gate = admit(ctx, "direct-chat-start");
    if (!gate.ok) return checked(ctx, gate.status, "directChatStarted", { ok: false, error: gate.error } satisfies DirectChatStarted);

    const project = ctx.posted.get("project") ?? "";
    const prompt = ctx.posted.get("prompt") ?? "";
    const providerRaw = ctx.posted.get("provider") ?? "claude";
    const modelId = ctx.posted.get("model") ?? "";
    const effort = ctx.posted.get("effort") ?? "";
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

    const res = await host.createThread({
      owner: gate.who.name,
      localGeneration: gate.who.authority === "local-owner" ? gate.who.session.localGeneration : null,
      accountGeneration: gate.who.session.generation,
      requestId,
      repo,
      provider: providerRaw as DirectChatProvider,
      modelId,
      ...(effort !== "" ? { effort } : {}),
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
    const thread = host.getThreadRecord(gate.who.name, threadId);
    if (thread === null || !canReachThread(gate.who.name, thread)) {
      return checked(ctx, 404, "directChatStarted", { ok: false, error: "Chat thread not found." } satisfies DirectChatStarted);
    }
    const prompt = ctx.posted.get("prompt") ?? "";
    const requestId = ctx.posted.get("request") ?? "";
    const res = await host.sendMessage({
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
    const thread = host.getThreadRecord(gate.who.name, threadId);
    if (thread === null || !canReachThread(gate.who.name, thread)) {
      return checked(ctx, 404, "directChatMutated", { ok: false, error: "Chat thread not found." } satisfies DirectChatMutated);
    }
    const res = host.stopThread(gate.who.name, threadId);
    if (!res.ok) return checked(ctx, res.status, "directChatMutated", { ok: false, error: res.error } satisfies DirectChatMutated);
    const said = res.stopped ? "Stopped." : res.stopping ? "Stopping…" : "Nothing was running.";
    return checked(ctx, 200, "directChatMutated", { ok: true, said } satisfies DirectChatMutated);
  }

  async function switchModel(ctx: HandlerContext): Promise<void> {
    const gate = admit(ctx, "direct-chat-manage");
    if (!gate.ok) return checked(ctx, gate.status, "directChatMutated", { ok: false, error: gate.error } satisfies DirectChatMutated);
    const match = THREAD_PATH.exec(ctx.url.pathname);
    const threadId = match?.[1] ?? "";
    const thread = host.getThreadRecord(gate.who.name, threadId);
    if (thread === null || !canReachThread(gate.who.name, thread)) {
      return checked(ctx, 404, "directChatMutated", { ok: false, error: "Chat thread not found." } satisfies DirectChatMutated);
    }
    const providerRaw = ctx.posted.get("provider") ?? "";
    const modelId = ctx.posted.get("model") ?? "";
    const effortParam = ctx.posted.has("effort") ? (ctx.posted.get("effort") ?? "") : undefined;
    if (!isDirectChatProvider(providerRaw)) {
      return checked(ctx, 400, "directChatMutated", { ok: false, error: "Choose Claude, Codex, or Gemini." } satisfies DirectChatMutated);
    }
    const res = host.switchModel({
      owner: gate.who.name,
      threadId,
      provider: providerRaw,
      modelId,
      ...(effortParam !== undefined ? { effort: effortParam } : {}),
    });
    if (!res.ok) return checked(ctx, res.status, "directChatMutated", { ok: false, error: res.error } satisfies DirectChatMutated);
    return checked(ctx, 200, "directChatMutated", { ok: true, said: "Model updated." } satisfies DirectChatMutated);
  }

  async function remove(ctx: HandlerContext): Promise<void> {
    const gate = admit(ctx, "direct-chat-manage");
    if (!gate.ok) return checked(ctx, gate.status, "directChatMutated", { ok: false, error: gate.error } satisfies DirectChatMutated);
    const match = THREAD_PATH.exec(ctx.url.pathname);
    const threadId = match?.[1] ?? "";
    const thread = host.getThreadRecord(gate.who.name, threadId);
    if (thread === null || !canReachThread(gate.who.name, thread)) {
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

  async function artifact(ctx: HandlerContext): Promise<void> {
    const gate = admit(ctx, null);
    if (!gate.ok) return checked(ctx, gate.status, "refusal", { error: gate.error });
    const match = ARTIFACT_PATH.exec(ctx.url.pathname);
    const threadId = match?.[1] ?? "";
    const artifactId = match?.[2] ?? "";
    const thread = host.getThreadRecord(gate.who.name, threadId);
    if (thread === null || !canReachThread(gate.who.name, thread)) {
      return checked(ctx, 404, "refusal", { error: "Artifact not found." });
    }
    const loaded = host.getArtifact(gate.who.name, threadId, artifactId);
    if (loaded === null) {
      return checked(ctx, 404, "refusal", { error: "Artifact not found." });
    }
    ctx.response.writeHead(200, {
      ...imageContentHeaders(loaded.row),
      "content-length": String(loaded.bytes.length),
    });
    ctx.response.end(loaded.bytes);
  }

  async function attach(ctx: HandlerContext): Promise<void> {
    const gate = admit(ctx, "direct-chat-send");
    if (!gate.ok) return checked(ctx, gate.status, "directChatAttached", { ok: false, error: gate.error } satisfies DirectChatAttached);
    const match = THREAD_PATH.exec(ctx.url.pathname);
    const threadId = match?.[1] ?? "";
    const thread = host.getThreadRecord(gate.who.name, threadId);
    if (thread === null || !canReachThread(gate.who.name, thread)) {
      return checked(ctx, 404, "directChatAttached", { ok: false, error: "Chat thread not found." } satisfies DirectChatAttached);
    }
    const filename = ctx.posted.get("filename") ?? "attachment";
    const mimeType = ctx.posted.get("mimeType") ?? undefined;
    const dataBase64 = ctx.posted.get("dataBase64") ?? "";
    if (dataBase64.trim() === "") {
      return checked(ctx, 400, "directChatAttached", { ok: false, error: "Missing attachment payload." } satisfies DirectChatAttached);
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(dataBase64, "base64");
    } catch {
      return checked(ctx, 400, "directChatAttached", { ok: false, error: "Invalid base64 attachment payload." } satisfies DirectChatAttached);
    }
    const saved = host.attachFile({
      owner: gate.who.name,
      threadId,
      filename,
      mimeType,
      bytes,
    });
    if (!saved.ok) {
      return checked(ctx, saved.status, "directChatAttached", { ok: false, error: saved.error } satisfies DirectChatAttached);
    }
    return checked(ctx, 200, "directChatAttached", {
      ok: true,
      artifact: toArtifactView(saved.artifact),
      cloneRelativePath: saved.cloneRelativePath,
    } satisfies DirectChatAttached);
  }

  async function applyMain(ctx: HandlerContext): Promise<void> {
    const gate = admit(ctx, "direct-chat-manage");
    if (!gate.ok) return checked(ctx, gate.status, "directChatMutated", { ok: false, error: gate.error } satisfies DirectChatMutated);
    const match = THREAD_PATH.exec(ctx.url.pathname);
    const threadId = match?.[1] ?? "";
    const thread = host.getThreadRecord(gate.who.name, threadId);
    if (thread === null || !canReachThread(gate.who.name, thread)) {
      return checked(ctx, 404, "directChatMutated", { ok: false, error: "Chat thread not found." } satisfies DirectChatMutated);
    }
    const res = host.applyMainEdits(gate.who.name, threadId);
    if (!res.ok) {
      return checked(ctx, res.status, "directChatMutated", { ok: false, error: res.error } satisfies DirectChatMutated);
    }
    return checked(ctx, 200, "directChatMutated", { ok: true, said: res.said } satisfies DirectChatMutated);
  }

  async function repair(ctx: HandlerContext): Promise<void> {
    const gate = admit(ctx, "direct-chat-manage");
    if (!gate.ok) return checked(ctx, gate.status, "directChatMutated", { ok: false, error: gate.error } satisfies DirectChatMutated);
    const match = THREAD_PATH.exec(ctx.url.pathname);
    const threadId = match?.[1] ?? "";
    const thread = host.getThreadRecord(gate.who.name, threadId);
    if (thread === null || !canReachThread(gate.who.name, thread)) {
      return checked(ctx, 404, "directChatMutated", { ok: false, error: "Chat thread not found." } satisfies DirectChatMutated);
    }
    const res = host.repairCloneGit(gate.who.name, threadId);
    if (!res.ok) {
      return checked(ctx, res.status, "directChatMutated", { ok: false, error: res.error } satisfies DirectChatMutated);
    }
    return checked(ctx, 200, "directChatMutated", { ok: true, said: res.said } satisfies DirectChatMutated);
  }

  async function shipPreview(ctx: HandlerContext): Promise<void> {
    const gate = admit(ctx, "read");
    if (!gate.ok) return checked(ctx, gate.status, "refusal", { error: gate.error });
    const match = THREAD_PATH.exec(ctx.url.pathname);
    const threadId = match?.[1] ?? "";
    const thread = host.getThreadRecord(gate.who.name, threadId);
    if (thread === null || !canReachThread(gate.who.name, thread)) {
      return checked(ctx, 404, "refusal", { error: "Chat thread not found." });
    }
    const modeParam = ctx.posted.get("mode") ?? ctx.url.searchParams.get("mode");
    const mode: DirectChatShipMode | undefined = modeParam === "ship" || modeParam === "keep-branch" ? modeParam : undefined;
    const title = ctx.posted.get("title") ?? ctx.url.searchParams.get("title") ?? undefined;
    const goal = ctx.posted.get("goal") ?? ctx.url.searchParams.get("goal") ?? undefined;
    const res = previewDirectChatShip(store, { stateRoot: host.stateRoot, owner: gate.who.name, threadId, mode, title, goal });
    if (!res.ok) return checked(ctx, res.status, "refusal", { error: res.error });
    const { preview } = res;
    return checked(ctx, 200, "directChatShipPreview", {
      version: ENGINE_API_VERSION,
      threadId: preview.threadId,
      mode: preview.mode,
      canAutoMerge: preview.canAutoMerge,
      autoMergeReason: preview.autoMergeReason,
      termsDigest: preview.termsDigest,
      title: preview.title,
      goal: preview.goal,
      baseSha: preview.baseSha,
      branch: preview.branch,
      changedFiles: preview.changedFiles,
      checkCommand: preview.checkCommand,
      githubRepo: preview.githubRepo,
      githubBase: preview.githubBase,
      mergeSummary: preview.mergeSummary,
    } satisfies DirectChatShipPreviewRead);
  }

  async function ship(ctx: HandlerContext): Promise<void> {
    const gate = admit(ctx, "direct-chat-ship");
    if (!gate.ok) return checked(ctx, gate.status, "directChatShipped", { ok: false, error: gate.error } satisfies DirectChatShipped);
    const match = THREAD_PATH.exec(ctx.url.pathname);
    const threadId = match?.[1] ?? "";
    const thread = host.getThreadRecord(gate.who.name, threadId);
    if (thread === null || !canReachThread(gate.who.name, thread)) {
      return checked(ctx, 404, "directChatShipped", { ok: false, error: "Chat thread not found." } satisfies DirectChatShipped);
    }
    const modeRaw = ctx.posted.get("mode") ?? "keep-branch";
    if (modeRaw !== "ship" && modeRaw !== "keep-branch") {
      return checked(ctx, 400, "directChatShipped", { ok: false, error: "Choose ship or keep-branch." } satisfies DirectChatShipped);
    }
    const termsDigest = ctx.posted.get("termsDigest") ?? "";
    if (!HEX32.test(termsDigest)) {
      return checked(ctx, 400, "directChatShipped", { ok: false, error: "Missing Ship terms digest." } satisfies DirectChatShipped);
    }
    const title = ctx.posted.get("title") ?? undefined;
    const goal = ctx.posted.get("goal") ?? undefined;
    const password = ctx.posted.get("password") ?? undefined;
    const localOwner = gate.who.authority === "local-owner" && gate.who.session.localGeneration !== null
      ? { localGeneration: gate.who.session.localGeneration }
      : null;

    const res = executeDirectChatShip(store, {
      stateRoot: host.stateRoot,
      owner: gate.who.name,
      threadId,
      mode: modeRaw,
      termsDigest,
      title,
      goal,
      password,
      localOwner,
    });
    if (!res.ok) {
      return checked(ctx, res.status, "directChatShipped", {
        ok: false,
        error: res.error,
        ...(res.code ? { code: res.code } : {}),
      } satisfies DirectChatShipped);
    }
    host.refreshDiffCache(thread);
    deps.bus.publish({ revision: `dc:${threadId}:ship:${Date.now()}` });
    const said = res.ship.mode === "keep-branch"
      ? `Saved branch ${res.ship.branch} (${res.ship.candidateSha.slice(0, 8)}).`
      : `Shipped snapshot ${res.ship.candidateSha.slice(0, 8)} — verifying checks before auto-merge.`;
    return checked(ctx, 200, "directChatShipped", {
      ok: true,
      ship: toShipSummary(res.ship),
      said,
    } satisfies DirectChatShipped);
  }

  async function shipCancel(ctx: HandlerContext): Promise<void> {
    const gate = admit(ctx, "direct-chat-manage");
    if (!gate.ok) return checked(ctx, gate.status, "directChatMutated", { ok: false, error: gate.error } satisfies DirectChatMutated);
    const match = THREAD_PATH.exec(ctx.url.pathname);
    const threadId = match?.[1] ?? "";
    const thread = host.getThreadRecord(gate.who.name, threadId);
    if (thread === null || !canReachThread(gate.who.name, thread)) {
      return checked(ctx, 404, "directChatMutated", { ok: false, error: "Chat thread not found." } satisfies DirectChatMutated);
    }
    const shipId = ctx.posted.get("shipId") ?? "";
    const res = cancelDirectChatShip(store, { owner: gate.who.name, threadId, shipId });
    if (!res.ok) return checked(ctx, res.status, "directChatMutated", { ok: false, error: res.error } satisfies DirectChatMutated);
    deps.bus.publish({ revision: `dc:${threadId}:ship-cancel:${Date.now()}` });
    return checked(ctx, 200, "directChatMutated", { ok: true, said: "Auto-merge cancelled." } satisfies DirectChatMutated);
  }

  // ---- the pages (everyday-8 #6): the same saved chats the engine API reads, for a browser with no app --------------

  const PAGE_PATH = /^\/direct-chats\/([a-f0-9]{32})(?:\/(ship-review|ship))?$/;
  const STATUS_WORDS: Record<string, string> = { completed: "Finished", failed: "Failed", interrupted: "Stopped", running: "Working", queued: "Waiting" };
  const DIFF_SHOWN = 200_000;
  function pageRefusal(ctx: HandlerContext, status: number, words: string): void {
    runtime.sendScreen(ctx.response, status, screen("Direct Chats", html`<h1>Direct Chats</h1><p class="problem" role="alert">${words}</p><p><a class="k-link" href="/direct-chats">All Direct Chats</a></p>`, { chrome: runtime.chromeFor(null, "tasks") }));
  }

  async function pageList(ctx: HandlerContext): Promise<void> {
    const gate = admit(ctx, null);
    if (!gate.ok) return pageRefusal(ctx, gate.status, gate.error);
    const threads = host.listThreads(gate.who.name, null).filter(t => canReachThread(gate.who.name, t));
    const rows = threads.map(t => html`<li class="k-row" data-direct-chat="${t.id}"><a class="k-link" href="/direct-chats/${t.id}"><b>${t.title || "Direct Chat"}</b></a> <span class="k-note">${t.project} · ${t.provider}${t.running ? " · Working" : t.lastStatus === null ? "" : ` · ${STATUS_WORDS[t.lastStatus] ?? t.lastStatus}`}${t.changedFilesCount > 0 ? ` · ${t.changedFilesCount} ${t.changedFilesCount === 1 ? "file" : "files"} changed` : ""}</span></li>`);
    const body = threads.length === 0
      ? html`<h1>Direct Chats</h1><p>No Direct Chats yet. Ask the lead in Chat to start one in a project.</p>`
      : html`<h1>Direct Chats</h1><ul class="k-list" data-direct-chats>${rows}</ul>`;
    return runtime.sendScreen(ctx.response, 200, screen("Direct Chats", body, { chrome: runtime.chromeFor(null, "tasks") }));
  }

  async function pageDetail(ctx: HandlerContext): Promise<void> {
    const gate = admit(ctx, null);
    if (!gate.ok) return pageRefusal(ctx, gate.status, gate.error);
    const threadId = PAGE_PATH.exec(ctx.url.pathname)?.[1] ?? "";
    const found = host.getThread(gate.who.name, threadId);
    if (found === null || !canReachThread(gate.who.name, found.thread)) return pageRefusal(ctx, 404, "That Direct Chat isn't here.");
    const { thread, turns, diff, running } = found;
    const turnHtml = turns.map(turn => html`<section class="card" data-turn="${turn.id}"><p><b>You</b> · <span class="k-note">${STATUS_WORDS[turn.status] ?? turn.status}</span></p><p class="pre-wrap">${turn.userPrompt}</p>${
      turn.assistantText.trim() === "" ? "" : html`<p><b>${thread.provider === "claude" ? "Claude" : thread.provider === "codex" ? "Codex" : "Gemini"}</b></p><p class="pre-wrap">${turn.assistantText}</p>`}${
      turn.errorText === null ? "" : html`<p class="problem">${turn.errorText}</p>`}</section>`);
    const shownDiff = diff.diffText.length > DIFF_SHOWN ? `${diff.diffText.slice(0, DIFF_SHOWN)}\n… (shortened)` : diff.diffText;
    // The saved diff is the clone as of its last turn, said so: never presented as the files right now.
    const changes = diff.changedFiles.length === 0 ? html`<p class="k-note">No changes in its copy of the project.</p>`
      : html`<p class="k-note">${diff.changedFiles.length} ${diff.changedFiles.length === 1 ? "file" : "files"} changed in its own copy of the project, as of its last turn${running ? " (it's still working)" : ""}.</p><ul>${diff.changedFiles.map(file => html`<li class="k-mono">${file}</li>`)}</ul>${shownDiff === "" ? "" : html`<details><summary>The changes</summary><pre class="k-mono" data-direct-chat-diff>${shownDiff}</pre></details>`}`;
    const ships = listDirectChatShips(store, thread.id);
    const shipped = ships.length === 0 ? "" : html`<ul>${ships.map(one => html`<li>${one.mode === "keep-branch" ? "Saved as branch" : "Shipped"} <span class="k-mono">${one.branch}</span> · ${one.state}${one.taskId === null ? "" : html` · <a class="k-link" href="/t/${encodeURIComponent(one.taskId)}">Open task</a>`}</li>`)}</ul>`;
    const shipAct = running || diff.changedFiles.length === 0 ? "" : postForm(`/direct-chats/${thread.id}/ship-review`, btn("Review Ship", { variant: "primary", type: "submit" }));
    const body = html`<h1>${thread.title || "Direct Chat"}</h1><p class="k-note">${thread.project} · ${thread.provider}${thread.modelId ? ` · ${thread.modelId}` : ""}${running ? " · Working" : ""}</p>${turnHtml}<h2>Changes</h2>${changes}<h2>Ship</h2>${shipped}${shipAct === "" && ships.length === 0 ? html`<p class="k-note">${running ? "Ship opens when it finishes." : "Nothing to ship yet."}</p>` : shipAct}<p><a class="k-link" href="/direct-chats">All Direct Chats</a></p>`;
    return runtime.sendScreen(ctx.response, 200, screen(thread.title || "Direct Chat", body, { chrome: runtime.chromeFor(thread.repo, "tasks") }));
  }

  /** Ship, reviewed first: its exact terms read now (git in the chat's own clone, so a POST), then one yes. */
  async function pageShipReview(ctx: HandlerContext): Promise<void> {
    const gate = admit(ctx, "read");
    if (!gate.ok) return pageRefusal(ctx, gate.status, gate.error);
    const threadId = PAGE_PATH.exec(ctx.url.pathname)?.[1] ?? "";
    const thread = host.getThreadRecord(gate.who.name, threadId);
    if (thread === null || !canReachThread(gate.who.name, thread)) return pageRefusal(ctx, 404, "That Direct Chat isn't here.");
    const res = previewDirectChatShip(store, { stateRoot: host.stateRoot, owner: gate.who.name, threadId, mode: undefined, title: undefined, goal: undefined });
    if (!res.ok) return pageRefusal(ctx, res.status, res.error);
    const preview = res.preview;
    const local = gate.who.authority === "local-owner";
    const facts = html`<ul><li>${preview.mode === "keep-branch" ? "Saved as branch" : "Shipped from branch"} <span class="k-mono">${preview.branch}</span></li><li>${preview.changedFiles.length} ${preview.changedFiles.length === 1 ? "file" : "files"}: ${preview.changedFiles.slice(0, 20).join(", ")}${preview.changedFiles.length > 20 ? "…" : ""}</li><li>${preview.checkCommand === null ? "No check command" : html`Check: <span class="k-mono">${preview.checkCommand}</span>`}</li><li>${preview.mergeSummary}</li>${preview.autoMergeReason === null ? "" : html`<li>${preview.autoMergeReason}</li>`}</ul>`;
    const form = postForm(`/direct-chats/${threadId}/ship`, html`${local ? "" : html`<label>Password<input type="password" name="password" autocomplete="current-password" required></label>`}${btn(preview.mode === "keep-branch" ? "Save the branch" : "Ship it", { variant: "primary", type: "submit" })} ${btn("Cancel", { variant: "ghost", href: `/direct-chats/${threadId}` })}`,
      { hidden: { mode: preview.mode, termsDigest: preview.termsDigest, title: preview.title, goal: preview.goal } });
    return runtime.sendScreen(ctx.response, 200, screen("Ship", html`<h1>Ship ${preview.title}</h1>${facts}${form}`, { chrome: runtime.chromeFor(thread.repo, "tasks") }));
  }

  async function pageShip(ctx: HandlerContext): Promise<void> {
    const gate = admit(ctx, "direct-chat-ship");
    if (!gate.ok) return pageRefusal(ctx, gate.status, gate.error);
    const threadId = PAGE_PATH.exec(ctx.url.pathname)?.[1] ?? "";
    const thread = host.getThreadRecord(gate.who.name, threadId);
    if (thread === null || !canReachThread(gate.who.name, thread)) return pageRefusal(ctx, 404, "That Direct Chat isn't here.");
    const mode = ctx.posted.get("mode") ?? "";
    const termsDigest = ctx.posted.get("termsDigest") ?? "";
    if ((mode !== "ship" && mode !== "keep-branch") || !HEX32.test(termsDigest)) return pageRefusal(ctx, 400, "That Ship isn't the one on screen. Review it again.");
    const password = ctx.posted.get("password") ?? undefined;
    const localOwner = gate.who.authority === "local-owner" && gate.who.session.localGeneration !== null ? { localGeneration: gate.who.session.localGeneration } : null;
    const res = executeDirectChatShip(store, { stateRoot: host.stateRoot, owner: gate.who.name, threadId, mode, termsDigest,
      title: ctx.posted.get("title") ?? undefined, goal: ctx.posted.get("goal") ?? undefined, password, localOwner });
    if (!res.ok) return pageRefusal(ctx, res.status, res.error);
    host.refreshDiffCache(thread);
    deps.bus.publish({ revision: `dc:${threadId}:ship:${Date.now()}` });
    return redirect(ctx.response, `/direct-chats/${threadId}`);
  }

  return {
    host,
    registrations: handlersOf("tasks", {
      "direct-chat.page-list": pageList,
      "direct-chat.page": pageDetail,
      "direct-chat.page-ship-review": pageShipReview,
      "direct-chat.page-ship": pageShip,
      "direct-chat.list": list,
      "direct-chat.detail": detail,
      "direct-chat.start": start,
      "direct-chat.send": send,
      "direct-chat.stop": stop,
      "direct-chat.model": switchModel,
      "direct-chat.delete": remove,
      "direct-chat.artifact": artifact,
      "direct-chat.attach": attach,
      "direct-chat.apply-main": applyMain,
      "direct-chat.repair": repair,
      "direct-chat.ship-preview": shipPreview,
      "direct-chat.ship": ship,
      "direct-chat.ship-cancel": shipCancel,
    }),
    close(): void {
      host.close();
    },
  };
}
