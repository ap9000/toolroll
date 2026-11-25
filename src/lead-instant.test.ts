import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { fileTaskProposal } from "./proposal.js";
import { prepareSharedAction } from "./chat-actions.js";
import { verifyApproverStanding, type VerifiedApprover } from "./principal.js";
import { executeLeadTool, findLeadTools, type LeadToolContext } from "./lead-tools.js";
import { confirmLeadProposal, executeLocalInstantProposal, isSafeInstantLocalProposal } from "./lead-doors.js";
import { composeLeadRequest, parseLeadImagesField } from "./converse.js";
import { REPORT_VERSION } from "./scout-report.js";
import type { ViewRunner } from "./view-tools.js";

const T0 = new Date("2026-11-24T12:00:00.000Z");
const REPO = "/tmp/demo-portfolio";

describe("Lead instant solo actions and Direct Chat tools", () => {
  let store: Store;
  let who: VerifiedApprover;
  const fakeView: ViewRunner = () => ({ ok: true, body: {} });

  beforeEach(() => {
    store = openStore(":memory:");
    store.saveApprover("alex", "h".repeat(64), T0);
    const verified = verifyApproverStanding(store, "alex", store.accountOf("alex")!.generation, [REPO]);
    if (!verified.ok) throw new Error(verified.reason);
    who = verified.who;
  });
  afterEach(() => store.close());

  function draftInTurn(kind: Parameters<Store["draftLeadProposal"]>[0]["kind"], payload: Record<string, unknown>): number {
    const sessionId = store.mintLeadSession({
      approver: who.name,
      approverGeneration: who.generation,
      credentialKey: "sub:claude",
      ceilingMicrousd: 0,
      ceilingDigest: who.ceilingDigest,
      termsDigest: "t".repeat(64),
    }, T0);
    const thread = store.openLeadThread(who.name, who.ceilingDigest, T0).thread;
    const turn = store.openLeadTurn({
      approver: who.name,
      session: sessionId,
      thread: thread.id,
      credentialKey: "sub:claude",
      reservedMicrousd: 0,
      dailyTurns: 100,
      weeklyCeilingMicrousd: 0,
      deadlineMs: 60_000,
      provider: "claude",
    }, T0);
    if (!turn.ok) throw new Error(turn.reason);
    return store.draftLeadProposal({
      thread: thread.id,
      turn: turn.id,
      ceilingDigest: who.ceilingDigest,
      kind,
      payload,
    }, T0);
  }

  test("safe reversible solo actions classify correctly and protected/code-approval actions never auto-apply", () => {
    expect(isSafeInstantLocalProposal("hold", { task: "t-1", reason: "waiting" })).toBe(true);
    expect(isSafeInstantLocalProposal("steer", { task: "t-1", note: "check mobile" })).toBe(true);
    expect(isSafeInstantLocalProposal("review", { task: "t-1", operation: "revise", note: "fix hero" })).toBe(true);
    expect(isSafeInstantLocalProposal("task_action", { task: "t-1", operation: "stop" })).toBe(true);
    expect(isSafeInstantLocalProposal("task_action", { task: "t-1", operation: "resume" })).toBe(false);
    expect(isSafeInstantLocalProposal("task", { repo: REPO, title: "x", goal: "y" })).toBe(false);
    expect(isSafeInstantLocalProposal("cancel", { task: "t-1", reason: "drop" })).toBe(false);
    expect(isSafeInstantLocalProposal("answer", { decision: 1, option: "a" })).toBe(false);
    const aboutAction = prepareSharedAction(store, who, "lead_about_you", { line: "keep copy terse" }, undefined, T0);
    expect(isSafeInstantLocalProposal("action", { ...aboutAction })).toBe(true);
    expect(isSafeInstantLocalProposal("action", { ...aboutAction, operation: "scope_approve", protected: true })).toBe(false);
    expect(isSafeInstantLocalProposal("action", { ...aboutAction, operation: "tool_add", protected: true, password: true })).toBe(false);
  });

  test("executeLocalInstantProposal applies hold immediately and marks the proposal confirmed", () => {
    const filed = fileTaskProposal(store, { id: "t-hero", title: "Polish hero", repo: REPO, filedVia: "cli" }, T0);
    if (!filed.ok) throw new Error(filed.reason);
    const ref = store.lookupRef("t-hero")!;
    const proposalId = draftInTurn("hold", { task: "t-hero", repoId: "r1", reason: "Wait for copy", sawHold: null });

    const outcome = executeLocalInstantProposal(store, who, proposalId, T0, { authority: "full" });
    expect(outcome.ok).toBe(true);
    expect(store.getLeadProposal(proposalId)?.state).toBe("confirmed");
    expect(store.activeHolds(ref.id, T0).some(h => h.reason === "Wait for copy")).toBe(true);
  });

  test("executeLocalInstantProposal refuses protected or non-instant proposals and keeps them drafting", () => {
    const proposalId = draftInTurn("task", { repo: REPO, repoId: "r1", title: "New task", goal: "Do work", planning: "auto", acceptance: [{ id: "c1", statement: "Done", evidence: ["check"] }] });
    const outcome = executeLocalInstantProposal(store, who, proposalId, T0, { authority: "full" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("needs-confirm");
    expect(store.getLeadProposal(proposalId)?.state).toBe("drafting");
  });

  test("list_direct_chats, get_direct_chat, and manage_direct_chat work over admitted Direct Chats", () => {
    store.handle.prepare(
      `INSERT INTO direct_chat_thread (id, owner, account_generation, title, repo, clone_path, branch, base_sha, provider, model_id, effort, usage_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "dc-1", "alex", who.generation, "Portfolio review", REPO, "/tmp/clone-1", "toolroll/chat-1", "abc123",
      "claude", "opus", "high", JSON.stringify({ inputTokens: 1200, outputTokens: 400, contextTokens: 1600, contextWindow: 200000 }),
      T0.toISOString(), T0.toISOString(),
    );
    store.handle.prepare(
      `INSERT INTO direct_chat_turn (id, thread_id, seq, user_prompt, log_path, stderr_path, status, assistant_text, created_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "turn-1", "dc-1", 1, "What is missing on my site?", "/tmp/l.log", "/tmp/e.log",
      "completed", "You need real case studies instead of placeholders.", T0.toISOString(), T0.toISOString(),
    );

    const baseCtx: LeadToolContext = { store, who, now: T0, step: 1, readDecisions: new Map(), draft: () => null };
    const listed = executeLeadTool(baseCtx, "list_direct_chats", {});
    expect(listed.ok).toBe(true);
    const listBody = (listed as { ok: true; body: { chats: { chat: string; title: string; provider: string; model: string; effort: string | null }[]; total: number } }).body;
    expect(listBody.total).toBe(1);
    expect(listBody.chats[0]).toMatchObject({ chat: "dc-1", title: "Portfolio review", provider: "claude", model: "opus", effort: "high" });

    const detail = executeLeadTool(baseCtx, "get_direct_chat", { chat: "dc-1" });
    expect(detail.ok).toBe(true);
    expect((detail as { ok: true; body: { turns: { assistantText: string }[] } }).body.turns[0]!.assistantText).toContain("real case studies");

    // Without local view permission, manage_direct_chat refuses.
    const refused = executeLeadTool(baseCtx, "manage_direct_chat", { chat: "dc-1", operation: "rename", title: "Renamed" });
    expect(refused.ok).toBe(false);

    // With local view permission, rename, set_model, and archive apply immediately.
    const localCtx: LeadToolContext = { ...baseCtx, view: fakeView };
    expect(executeLeadTool(localCtx, "manage_direct_chat", { chat: "dc-1", operation: "rename", title: "Homepage audit" }).ok).toBe(true);
    expect(executeLeadTool(localCtx, "manage_direct_chat", { chat: "dc-1", operation: "set_model", provider: "codex", model: "gpt-6-astra", effort: "xhigh" }).ok).toBe(true);
    expect(executeLeadTool(localCtx, "manage_direct_chat", { chat: "dc-1", operation: "archive" }).ok).toBe(true);

    const after = store.handle.prepare("SELECT title, provider, model_id, effort, archived_at FROM direct_chat_thread WHERE id = ?").get("dc-1") as Record<string, unknown>;
    expect(after["title"]).toBe("Homepage audit");
    expect(after["provider"]).toBe("codex");
    expect(after["model_id"]).toBe("gpt-6-astra");
    expect(after["effort"]).toBe("xhigh");
    expect(after["archived_at"]).not.toBeNull();

    // Unarchive, then add a running turn: archive, set_model, and unwired stop must all refuse without corrupting DB state.
    expect(executeLeadTool(localCtx, "manage_direct_chat", { chat: "dc-1", operation: "unarchive" }).ok).toBe(true);
    store.handle.prepare(
      `INSERT INTO direct_chat_turn (id, thread_id, seq, user_prompt, log_path, stderr_path, status, assistant_text, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("turn-2", "dc-1", 2, "Keep going", "/tmp/l2.log", "/tmp/e2.log", "running", "", T0.toISOString());

    const archRunning = executeLeadTool(localCtx, "manage_direct_chat", { chat: "dc-1", operation: "archive" });
    expect(archRunning.ok).toBe(false);
    const modelRunning = executeLeadTool(localCtx, "manage_direct_chat", { chat: "dc-1", operation: "set_model", provider: "claude", model: "opus" });
    expect(modelRunning.ok).toBe(false);
    const stopUnwired = executeLeadTool(localCtx, "manage_direct_chat", { chat: "dc-1", operation: "stop" });
    expect(stopUnwired.ok).toBe(false);

    // Running turn and unarchived thread must remain untouched when stop is unwired.
    const turnRow = store.handle.prepare("SELECT status FROM direct_chat_turn WHERE id = ?").get("turn-2") as Record<string, unknown>;
    expect(turnRow["status"]).toBe("running");
    const threadRow = store.handle.prepare("SELECT archived_at FROM direct_chat_thread WHERE id = ?").get("dc-1") as Record<string, unknown>;
    expect(threadRow["archived_at"]).toBeNull();
  });

  test("get_usage_limits is discoverable and returns live subscription windows and budgets", () => {
    expect(findLeadTools("how much claude quota remaining").map(one => one.name)).toContain("get_usage_limits");
    const baseCtx: LeadToolContext = { store, who, now: T0, step: 1, readDecisions: new Map(), draft: () => null };
    const res = executeLeadTool(baseCtx, "get_usage_limits", {});
    expect(res.ok).toBe(true);
    if (res.ok) {
      const body = res.body as { summary: string | null; windows: unknown[]; budgets: unknown[] };
      expect(Array.isArray(body.windows)).toBe(true);
      expect(Array.isArray(body.budgets)).toBe(true);
    }
  });

  test("parseLeadImagesField validates PNG magic bytes and composeLeadRequest sends multimodal blocks", () => {
    const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const images = parseLeadImagesField(JSON.stringify([{ filename: "bubble.png", mediaType: "image/png", dataBase64: png1x1 }]));
    expect(images).toHaveLength(1);
    expect(images[0]!.mediaType).toBe("image/png");

    // Spoofed magic bytes (plain text claiming to be PNG) must be rejected.
    expect(parseLeadImagesField(JSON.stringify([{ filename: "fake.png", mediaType: "image/png", dataBase64: Buffer.from("not a png").toString("base64") }]))).toEqual([]);

    // Unsupported MIME type must be rejected.
    expect(parseLeadImagesField(JSON.stringify([{ filename: "x.svg", mediaType: "image/svg+xml", dataBase64: Buffer.from("<svg/>").toString("base64") }]))).toEqual([]);

    const anthropicReq = JSON.parse(composeLeadRequest({
      provider: "anthropic-api",
      model: "claude-sonnet-5",
      key: "sk-test",
      system: "sys",
      dataDocument: "{}",
      history: [{ role: "operator", text: "what color is this?", images }],
      tools: [],
    }).body) as { messages: { content: unknown }[] };
    const anthropicBlocks = anthropicReq.messages[1]!.content as { type: string; source?: { media_type: string; data: string } }[];
    expect(anthropicBlocks[0]).toMatchObject({ type: "image", source: { media_type: "image/png", data: png1x1 } });
    expect(anthropicBlocks[1]).toMatchObject({ type: "text", text: "what color is this?" });

    const orReq = JSON.parse(composeLeadRequest({
      provider: "openrouter-api",
      model: "openai/gpt-5.2",
      key: "sk-test",
      system: "sys",
      dataDocument: "{}",
      history: [{ role: "operator", text: "check screenshot", images }],
      tools: [],
    }).body) as { messages: { content: unknown }[] };
    const orBlocks = orReq.messages[2]!.content as { type: string; image_url?: { url: string } }[];
    expect(orBlocks[0]).toMatchObject({ type: "image_url", image_url: { url: `data:image/png;base64,${png1x1}` } });
  });

  test("get_recent_updates aggregates ready tasks and updated Direct Chats for continuity", () => {
    expect(findLeadTools("catch me up since I was away").map(one => one.name)).toContain("get_recent_updates");
    const filed = fileTaskProposal(store, { id: "t-ready", title: "Review homepage", repo: REPO, filedVia: "cli" }, T0);
    if (!filed.ok) throw new Error(filed.reason);
    const ref = store.lookupRef("t-ready")!;
    store.handle.prepare(
      `INSERT INTO run (task_ref, lease_id, runner, role, provider, model, branch, worktree, started_at, finished_at, outcome)
       VALUES (?, 'lease-1', 'local', 'builder', 'codex', 'gpt-6-sol', 'tr/t-ready', '/tmp/wt-ready', ?, ?, 'built')`,
    ).run(ref.id, T0.toISOString(), T0.toISOString());
    store.handle.prepare(
      `INSERT INTO direct_chat_thread (id, owner, account_generation, title, repo, clone_path, branch, base_sha, provider, model_id, effort, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("dc-away", "alex", who.generation, "Portfolio audit", REPO, "/tmp/clone-2", "toolroll/chat-2", "def456", "claude", "opus", "high", T0.toISOString(), T0.toISOString());
    store.handle.prepare(
      `INSERT INTO direct_chat_turn (id, thread_id, seq, user_prompt, log_path, stderr_path, status, assistant_text, created_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("turn-away", "dc-away", 1, "Audit site", "/tmp/l2.log", "/tmp/e2.log", "completed", "Found 3 missing case studies.", T0.toISOString(), T0.toISOString());

    const baseCtx: LeadToolContext = { store, who, now: new Date(T0.getTime() + 60_000), step: 1, readDecisions: new Map(), draft: () => null };
    const res = executeLeadTool(baseCtx, "get_recent_updates", { hours: 24 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const body = res.body as { headline: string; tasksReady: { task: string }[]; directChatsUpdated: { chat: string; lastReplyPreview: string }[] };
      expect(body.tasksReady.map(t => t.task)).toContain("t-ready");
      expect(body.directChatsUpdated.map(c => c.chat)).toContain("dc-away");
      expect(body.directChatsUpdated[0]!.lastReplyPreview).toContain("3 missing case studies");
      expect(body.headline).toContain("1 ready result");
      expect(body.headline).toContain("1 updated Direct Chat");
    }
  });

  test("propose_direct_chat drafts 1-click confirmation cards (never auto-executed) and promote files a Task", () => {
    expect(findLeadTools("promote direct chat into a task").map(one => one.name)).toContain("propose_direct_chat");
    store.handle.prepare(
      `INSERT INTO direct_chat_thread (id, owner, account_generation, title, repo, clone_path, branch, base_sha, provider, model_id, effort, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("dc-prom", "alex", who.generation, "Fix mobile nav", REPO, "/tmp/clone-3", "toolroll/chat-3", "ghi789", "claude", "opus", "high", T0.toISOString(), T0.toISOString());
    store.handle.prepare(
      `INSERT INTO direct_chat_turn (id, thread_id, seq, user_prompt, log_path, stderr_path, status, assistant_text, created_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("turn-prom", "dc-prom", 1, "Why does the nav clip?", "/tmp/l3.log", "/tmp/e3.log", "completed", "Sticky header overlaps at 375px.", T0.toISOString(), T0.toISOString());

    const drafted: { kind: Parameters<Store["draftLeadProposal"]>[0]["kind"]; payload: Record<string, unknown> }[] = [];
    const ctx: LeadToolContext = {
      store,
      who,
      now: T0,
      step: 1,
      readDecisions: new Map(),
      draft: (kind, payload) => {
        drafted.push({ kind, payload });
        return drafted.length;
      },
    };

    const startRes = executeLeadTool(ctx, "propose_direct_chat", { operation: "start", repo: "r1", prompt: "Inspect hero CSS", provider: "claude" });
    expect(startRes.ok).toBe(true);
    const replyRes = executeLeadTool(ctx, "propose_direct_chat", { operation: "reply", chat: "dc-prom", prompt: "Also check tablet breakpoint" });
    expect(replyRes.ok).toBe(true);
    const promoteRes = executeLeadTool(ctx, "propose_direct_chat", { operation: "promote", chat: "dc-prom", title: "Fix mobile nav clipping" });
    expect(promoteRes.ok).toBe(true);

    // None of the Direct Chat proposals may ever auto-execute without the owner's 1-click confirmation.
    expect(drafted).toHaveLength(3);
    for (const d of drafted) {
      expect(isSafeInstantLocalProposal(d.kind, d.payload)).toBe(false);
    }

    // Confirming the promote card files a real Task.
    const sessionId = store.mintLeadSession({
      approver: who.name,
      approverGeneration: who.generation,
      credentialKey: "sub:claude",
      ceilingMicrousd: 0,
      ceilingDigest: who.ceilingDigest,
      termsDigest: "t".repeat(64),
    }, T0);
    const thread = store.openLeadThread(who.name, who.ceilingDigest, T0).thread;
    const turn = store.openLeadTurn({
      approver: who.name,
      session: sessionId,
      thread: thread.id,
      credentialKey: "sub:claude",
      reservedMicrousd: 0,
      dailyTurns: 100,
      weeklyCeilingMicrousd: 0,
      deadlineMs: 60_000,
      provider: "claude",
    }, T0);
    if (!turn.ok) throw new Error(turn.reason);
    const started = store.startLeadTurn(turn.id, T0);
    if (!started.ok) throw new Error("turn did not start");
    const proposalId = store.draftLeadProposal({
      thread: thread.id,
      turn: turn.id,
      ceilingDigest: who.ceilingDigest,
      kind: drafted[2]!.kind,
      payload: drafted[2]!.payload,
    }, T0);
    expect(store.finalizeLeadTurn(turn.id, started.generation, { state: "answered", settledMicrousd: 0, tokensIn: 10, tokensOut: 10 }, T0)).toBe(true);
    const confirmed = confirmLeadProposal(store, who, proposalId, T0, { authority: "full", via: "web", person: true });
    expect(confirmed.ok).toBe(true);
    if (confirmed.ok) {
      expect(confirmed.taskId).toBeTruthy();
      expect(store.getTask(confirmed.taskId!)?.title).toBe("Fix mobile nav clipping");
    }
  });

  test("propose_report_followups batch-drafts Task confirmation cards from a verified Scout Report", () => {
    expect(findLeadTools("file follow-ups from scout report").map(one => one.name)).toContain("propose_report_followups");
    const root = mkdtempSync(join(tmpdir(), "toolroll-report-test-"));
    try {
      const filed = fileTaskProposal(store, { id: "t-scout", title: "Homepage review", repo: REPO, deliverable: "report", filedVia: "cli" }, T0);
      if (!filed.ok) throw new Error(filed.reason);
      const ref = store.lookupRef("t-scout")!;
      const runId = Number(store.handle.prepare(
        `INSERT INTO run (task_ref, lease_id, runner, role, provider, model, branch, worktree, started_at, finished_at, outcome)
         VALUES (?, 'lease-2', 'local', 'scout', 'codex', 'gpt-6-sol', 'tr/t-scout', '/tmp/wt-scout', ?, ?, 'built')`,
      ).run(ref.id, T0.toISOString(), T0.toISOString()).lastInsertRowid);
      const reportJson = JSON.stringify({
        version: REPORT_VERSION,
        title: "Homepage first-time visitor review",
        summary: "Three clear fixes to improve role clarity and proof of work.",
        report: "## Findings\nVisitors cannot tell what Alex ships.",
        followUps: [
          { title: "Clarify role in hero subhead", goal: "Update the hero copy to state Alex's current engineering role and focus." },
          { title: "Replace placeholder case study", goal: "Swap the Caliper placeholder MDX with one real shipped project." },
          { title: "Add direct contact CTA", goal: "Add a clear email and availability line near the top of the homepage." },
        ],
        items: [],
        images: [],
      });
      const bytes = Buffer.from(reportJson, "utf8");
      const relKey = join(String(runId), "report.json");
      mkdirSync(join(root, String(runId)), { recursive: true });
      writeFileSync(join(root, relKey), bytes, { mode: 0o600 });
      store.saveArtifact({
        run: runId,
        kind: "report",
        key: relKey,
        bytesOriginal: bytes.length,
        bytesStored: bytes.length,
        truncated: false,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        capture: "scout report",
      }, T0);

      const drafted: { kind: string; payload: Record<string, unknown> }[] = [];
      const ctx: LeadToolContext = {
        store,
        who,
        now: T0,
        step: 1,
        evidenceRoot: root,
        readDecisions: new Map(),
        draft: (kind, payload) => {
          drafted.push({ kind, payload });
          return drafted.length;
        },
      };

      const bad = executeLeadTool(ctx, "propose_report_followups", { task: "t-scout", indices: [9] });
      expect(bad.ok).toBe(false);

      const ok = executeLeadTool(ctx, "propose_report_followups", { task: "t-scout", indices: [1, 3] });
      expect(ok.ok).toBe(true);
      expect(drafted).toHaveLength(2);
      expect(drafted[0]!.kind).toBe("task");
      expect(drafted[0]!.payload["title"]).toBe("Clarify role in hero subhead");
      expect(drafted[1]!.payload["title"]).toBe("Add direct contact CTA");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("sweepStaleLeadTurns clears unknown spend only for a turn whose recorded billing proves a subscription", () => {
    let clock = new Date(T0.getTime() + 120_000);
    /** One started lead step on this route, its deadline passed by the next sweep. */
    const startedStep = (credentialKey: string, provider: "codex-subscription" | "claude-subscription" | "anthropic-api", metered: boolean) => {
      const session = store.mintLeadSession({ approver: who.name, approverGeneration: who.generation, credentialKey, ceilingMicrousd: metered ? 5_000_000 : 0, ceilingDigest: who.ceilingDigest, termsDigest: "t".repeat(64) }, clock);
      const thread = store.openLeadThread(who.name, who.ceilingDigest, clock).thread;
      const turnInput = { approver: who.name, session, thread: thread.id, credentialKey, reservedMicrousd: metered ? 500_000 : 0, dailyTurns: 100, weeklyCeilingMicrousd: metered ? 5_000_000 : 0, deadlineMs: 30_000, provider };
      const turn = store.openLeadTurn(turnInput, clock);
      if (!turn.ok) throw new Error(turn.reason);
      const started = store.startLeadTurn(turn.id, clock);
      if (!started.ok) throw new Error("start failed");
      const step = store.openLeadStep({ leadTurn: turn.id, generation: started.generation, approver: who.name, credentialKey, provider, model: metered ? "claude-sonnet-4-6" : "gpt-6-astra", deadlineMs: 30_000 }, clock);
      if (!step.ok) throw new Error(step.reason);
      expect(store.startChatTurn(step.id, clock).ok).toBe(true);
      return { step: step.id, thread: thread.id, again: () => store.openLeadTurn(turnInput, clock) };
    };
    const sweep = () => { clock = new Date(clock.getTime() + 120_000); return store.sweepStaleLeadTurns(clock); };
    const lastWords = (thread: number) => { const said = store.listLeadMessages(thread, 20); return said[said.length - 1]!.text; };

    // 1. A subscription-labelled route whose turn recorded no billing: the CLI may have billed an API key it found
    //    itself, so the crash keeps its unknown spend for a person to acknowledge.
    const unproved = startedStep("sub:codex-subscription", "codex-subscription", false);
    expect(sweep()).toBe(1);
    expect(store.getChatTurn(unproved.step)).toMatchObject({ state: "failed", unknownSpend: true });
    expect(store.latchedChatTurns("sub:codex-subscription")).toHaveLength(1);
    expect(lastWords(unproved.thread)).toContain("cost isn't known");
    expect(unproved.again()).toEqual({ ok: false, reason: "latched" });

    // 2. A turn whose own recorded billing says subscription settles at zero without latching.
    const proved = startedStep("sub:claude-subscription", "claude-subscription", false);
    store.handle.prepare("UPDATE chat_turn SET billing_reported = 'subscription' WHERE id = ?").run(proved.step);
    expect(sweep()).toBe(1);
    expect(store.getChatTurn(proved.step)).toMatchObject({ state: "failed", unknownSpend: false, settledMicrousd: 0 });
    expect(store.latchedChatTurns("sub:claude-subscription")).toHaveLength(0);
    expect(lastWords(proved.thread)).not.toContain("cost isn't known");
    expect(proved.again().ok).toBe(true);

    // 3. A subscription-labelled turn whose recorded billing says an API key latches like a metered one.
    const keyed = startedStep("sub:claude-key", "claude-subscription", false);
    store.handle.prepare("UPDATE chat_turn SET billing_reported = 'api-key' WHERE id = ?").run(keyed.step);
    sweep();
    expect(store.getChatTurn(keyed.step)!.unknownSpend).toBe(true);

    // 4. A metered API turn still latches.
    const api = startedStep("api:anthropic-test", "anthropic-api", true);
    sweep();
    expect(store.getChatTurn(api.step)!.unknownSpend).toBe(true);
    expect(store.latchedChatTurns("api:anthropic-test")).toHaveLength(1);
    expect(api.again()).toEqual({ ok: false, reason: "latched" });
  });
});
