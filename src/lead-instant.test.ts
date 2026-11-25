import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openStore, type Store } from "./store.js";
import { fileTaskProposal } from "./proposal.js";
import { prepareSharedAction } from "./chat-actions.js";
import { verifyApproverStanding, type VerifiedApprover } from "./principal.js";
import { executeLeadTool, findLeadTools, type LeadToolContext } from "./lead-tools.js";
import { executeLocalInstantProposal, isSafeInstantLocalProposal } from "./lead-doors.js";
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
});
