/** The lead checks before it speaks: reply rules, a memory search before a proposal on a project with decisions,
 * integration status, questions with options, and refusal copy in plain words. */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { LEAD_FOLLOW_MESSAGE, LEAD_ASK_TTL_MS, openStore, type Store } from "./store.js";
import { sweepRetention } from "./retention.js";
import { fileTaskProposal } from "./proposal.js";
import { verifyApproverStanding, type VerifiedApprover } from "./principal.js";
import { executeLeadTool, type LeadToolContext } from "./lead-tools.js";
import { recordDecision } from "./project-memory.js";
import { LEAD_CONTRACT } from "./lead-contract.js";
import { LEAD_REFUSAL_COPY } from "./lead.js";
import { CHAT_CONTROLS } from "./chat-controls.js";
import type { Integration } from "./integrations.js";

const T0 = new Date("2026-10-02T12:00:00.000Z");
const TASK_ARGS = { title: "Add a refund page", goal: "People can ask for a refund.", acceptance: [{ id: "c1", statement: "A refund can be requested.", evidence: ["manual-review"] }] };

describe("the lead checks before it speaks", () => {
  let store: Store;
  let who: VerifiedApprover;
  let drafted: number;
  let dir: string, SETTLED: string, OPEN: string;
  const ctx = (step: number, extra: Partial<LeadToolContext> = {}): LeadToolContext => ({ store, who, now: T0, step, readDecisions: new Map(), draft: () => ++drafted, ...extra });

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "so-lead-checks-")));
    SETTLED = join(dir, "settled"); OPEN = join(dir, "open");
    for (const repo of [SETTLED, OPEN]) { mkdirSync(repo); execFileSync("git", ["init", "-q", repo]); }
    store = openStore(":memory:");
    store.saveApprover("alex", "h".repeat(64), T0);
    const verified = verifyApproverStanding(store, "alex", store.accountOf("alex")!.generation, [SETTLED, OPEN]);
    if (!verified.ok) throw new Error(verified.reason);
    who = verified.who;
    drafted = 0;
    for (const [id, repo] of [["s1", SETTLED], ["o1", OPEN]] as const) {
      const filed = fileTaskProposal(store, { id, title: `task ${id}`, repo, filedVia: "cli" }, T0);
      if (!filed.ok) throw new Error(filed.reason);
    }
    recordDecision(store, { repo: SETTLED, actor: "alex", draft: { claim: "Refunds go through Stripe only", why: "One ledger." } }, T0);
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  test("c1: a proposal on a project with recorded decisions needs a memory search in an earlier step of the turn", () => {
    const searched = new Map<string, number>();
    // No search: refused, in plain words, before anything is drafted.
    const refused = executeLeadTool(ctx(1, { searchedMemory: searched }), "propose_task", { repo: "r1", ...TASK_ARGS });
    expect(refused).toMatchObject({ ok: false, message: expect.stringContaining("search_project_memory first") });
    expect(drafted).toBe(0);
    // The same for a proposal named by its task, not its project.
    expect(executeLeadTool(ctx(1, { searchedMemory: searched }), "propose_steer", { task: "s1", note: "Start with the form." })).toMatchObject({ ok: false });
    // A search in the same step does not count: its results were not read yet.
    expect(executeLeadTool(ctx(2, { searchedMemory: searched }), "search_project_memory", { query: "refunds", repo: "r1" })).toMatchObject({ ok: true });
    expect(executeLeadTool(ctx(2, { searchedMemory: searched }), "propose_task", { repo: "r1", ...TASK_ARGS })).toMatchObject({ ok: false });
    // In a later step it does.
    expect(executeLeadTool(ctx(3, { searchedMemory: searched }), "propose_task", { repo: "r1", ...TASK_ARGS })).toMatchObject({ ok: true });
    expect(executeLeadTool(ctx(3, { searchedMemory: searched }), "propose_steer", { task: "s1", note: "Start with the form." })).toMatchObject({ ok: true });
  });

  test("c1: propose_steer on a task resolves its project from the task: one search of that project is enough", () => {
    recordDecision(store, { repo: OPEN, actor: "alex", draft: { claim: "Sign-up stays email only", why: "Fewer accounts to recover." } }, T0);
    const searched = new Map<string, number>();
    executeLeadTool(ctx(1, { searchedMemory: searched }), "search_project_memory", { query: "refunds", repo: "r1" });
    expect(executeLeadTool(ctx(2, { searchedMemory: searched }), "propose_steer", { task: "s1", note: "Start with the form." })).toMatchObject({ ok: true });
    // The other project's task still needs its own project searched.
    expect(executeLeadTool(ctx(2, { searchedMemory: searched }), "propose_steer", { task: "o1", note: "Start with the form." })).toMatchObject({ ok: false, message: expect.stringContaining("This project has recorded decisions") });
  });

  test("c1: a search over another project does not count; a search over every project does; a project without decisions needs none", () => {
    const searched = new Map<string, number>();
    executeLeadTool(ctx(1, { searchedMemory: searched }), "search_project_memory", { query: "refunds", repo: "r2" });
    expect(executeLeadTool(ctx(2, { searchedMemory: searched }), "propose_task", { repo: "r1", ...TASK_ARGS })).toMatchObject({ ok: false });
    // The project without recorded decisions is unaffected, searched or not.
    expect(executeLeadTool(ctx(2), "propose_task", { repo: "r2", ...TASK_ARGS })).toMatchObject({ ok: true });
    executeLeadTool(ctx(3, { searchedMemory: searched }), "search_project_memory", { query: "refunds" });
    expect(executeLeadTool(ctx(4, { searchedMemory: searched }), "propose_task", { repo: "r1", ...TASK_ARGS })).toMatchObject({ ok: true });
  });

  test("c1: a proposal that names no project it can be traced to needs a search of each project with decisions", () => {
    recordDecision(store, { repo: OPEN, actor: "alex", draft: { claim: "Keep the signup form short", why: "Fewer drop-offs." } }, T0);
    const searched = new Map<string, number>();
    const unnamed = (step: number) => executeLeadTool(ctx(step, { searchedMemory: searched }), "propose_steer", { task: "no-such-task", note: "Start with the form." });
    expect(unnamed(1)).toMatchObject({ ok: false, message: expect.stringContaining("Your projects have recorded decisions") });
    // One project searched is not enough: the proposal could be about the other.
    executeLeadTool(ctx(1, { searchedMemory: searched }), "search_project_memory", { query: "refunds", repo: "r1" });
    expect(unnamed(2)).toMatchObject({ ok: false, message: expect.stringContaining("search_project_memory") });
    executeLeadTool(ctx(2, { searchedMemory: searched }), "search_project_memory", { query: "signup", repo: "r2" });
    // Both searched: the memory check passes and the tool answers for itself.
    const passed = unnamed(3);
    expect(passed.ok === false && passed.message).not.toContain("search_project_memory");
    // A search over every project covers them all.
    const everywhere = new Map<string, number>();
    executeLeadTool(ctx(1, { searchedMemory: everywhere }), "search_project_memory", { query: "plans" });
    const covered = executeLeadTool(ctx(2, { searchedMemory: everywhere }), "propose_steer", { task: "no-such-task", note: "Start with the form." });
    expect(covered.ok === false && covered.message).not.toContain("search_project_memory");
  });

  test("c2: the lead reads integration status, and Settings → Integrations is a fixed control", () => {
    const list: Integration[] = [
      { key: "telegram", group: "chat", name: "Telegram", state: "connected", account: "@toolroll_bot", detail: null, checked: true, checkedAt: null, lastSuccessAt: "2026-10-02T11:00:00.000Z", lastError: null, lastErrorAt: null, usedBy: ["Chat"], action: { kind: "test", label: "Send test" } },
      { key: "slack", group: "chat", name: "Slack", state: "not-set-up", account: null, detail: null, checked: true, checkedAt: null, lastSuccessAt: null, lastError: null, lastErrorAt: null, usedBy: [], action: { kind: "setup", label: "Set up", href: "/settings/slack", command: null } },
      { key: "email", group: "mail", name: "Email", state: "broken", account: null, detail: null, checked: true, checkedAt: null, lastSuccessAt: null, lastError: "Sign-in refused", lastErrorAt: null, usedBy: ["Flows"], action: { kind: "fix", label: "Fix", words: "Sign in to the mailbox again.", href: "/settings/email", command: null } },
    ];
    const read = executeLeadTool(ctx(1, { integrations: () => list }), "get_integrations", {});
    expect(read).toMatchObject({ ok: true, body: { integrations: [
      { name: "Telegram", state: "Connected", account: "@toolroll_bot", next: null },
      { name: "Slack", state: "Not set up", next: expect.stringContaining("Settings → Integrations") },
      { name: "Email", state: "Broken", next: "Fix: Sign in to the mailbox again.", lastError: "Sign-in refused" },
    ] } });
    // Without a surface's list it reads the same saved state: nothing set up in a fresh database.
    const fresh = executeLeadTool(ctx(1), "get_integrations", {});
    expect(fresh.ok && (fresh.body as { integrations: { name: string; state: string }[] }).integrations.find(one => one.name === "Slack")?.state).toBe("Not set up");
    expect(CHAT_CONTROLS.integrations).toEqual({ label: "Set up integrations", href: "/settings/integrations" });
    expect(executeLeadTool(ctx(1), "show_control", { control: "integrations" })).toMatchObject({ ok: true, body: { label: "Set up integrations" } });
  });

  test("c2: ask_owner takes one question with 2-4 short distinct options, adds Something else, and asks once per reply", () => {
    const asked: { question: string; options: readonly string[] }[] = [];
    const ask = (question: string, options: readonly string[]) => asked.length === 0 && asked.push({ question, options }) === 1;
    const call = (args: Record<string, unknown>) => executeLeadTool(ctx(1, { ask }), "ask_owner", args);
    expect(call({ question: "Which page first?", options: ["Login"] })).toMatchObject({ ok: false });
    expect(call({ question: "Which page first?", options: ["A", "B", "C", "D", "E"] })).toMatchObject({ ok: false });
    expect(call({ question: "Which page first?", options: ["Login", "login"] })).toMatchObject({ ok: false });
    expect(call({ question: "Which page first?", options: ["Login", "Something else"] })).toMatchObject({ ok: false });
    expect(call({ question: "Which page first?", options: ["Login", "x".repeat(41)] })).toMatchObject({ ok: false });
    expect(call({ question: "Which page first?", options: ["Login", "Signup"] })).toMatchObject({ ok: true, body: { options: ["Login", "Signup", "Something else"] } });
    expect(asked).toEqual([{ question: "Which page first?", options: ["Login", "Signup"] }]);
    expect(call({ question: "And then?", options: ["Yes", "No"] })).toMatchObject({ ok: false, message: expect.stringContaining("one at a time") });
    // A surface that cannot draw buttons says so instead of pretending.
    expect(executeLeadTool(ctx(1), "ask_owner", { question: "Which page first?", options: ["Login", "Signup"] })).toMatchObject({ ok: false });
  });

  test("c2: a question belongs to its answered turn, closes once the owner writes again, and a failed turn keeps none", () => {
    const thread = store.openLeadThread("alex", who.ceilingDigest, T0).thread;
    store.mintLeadSession({ approver: "alex", approverGeneration: who.generation, credentialKey: "k", ceilingMicrousd: 5_000_000, ceilingDigest: who.ceilingDigest, termsDigest: "t".repeat(64) }, T0);
    const session = store.activeLeadSession("alex")!;
    const turn = (answered: boolean): number => {
      const opened = store.openLeadTurn({ approver: "alex", session: session.id, thread: thread.id, credentialKey: "k", reservedMicrousd: 10, dailyTurns: 50, weeklyCeilingMicrousd: 25_000_000, deadlineMs: 60_000 }, T0);
      if (!opened.ok) throw new Error(opened.reason);
      const started = store.startLeadTurn(opened.id, T0);
      if (!started.ok) throw new Error("start");
      store.appendLeadMessage({ thread: thread.id, turn: opened.id, role: "operator", text: "Plan the refunds" }, T0);
      expect(store.recordLeadAsk({ turn: opened.id, thread: thread.id, question: "Which first?", options: ["Login", "Signup"] }, T0)).toBe(true);
      expect(store.recordLeadAsk({ turn: opened.id, thread: thread.id, question: "Again?", options: ["Yes", "No"] }, T0)).toBe(false);
      // Not shown while the turn runs.
      expect(store.leadAsk(opened.id)).toBeNull();
      if (answered) store.finalizeLeadTurn(opened.id, started.generation, { state: "answered", settledMicrousd: 1, tokensIn: 1, tokensOut: 1, message: { text: "One choice first.", activity: "" } }, T0);
      else { store.finalizeLeadTurn(opened.id, started.generation, { state: "failed", settledMicrousd: 0, unknownSpend: false, tokensIn: 0, tokensOut: 0, failureReason: "provider-error" }, T0); store.dropLeadAsk(opened.id); }
      return opened.id;
    };
    const first = turn(true);
    expect(store.leadAskOpen(first, T0)).toMatchObject({ question: "Which first?", options: ["Login", "Signup"] });
    store.appendLeadMessage({ thread: thread.id, turn: null, role: "operator", text: "Login" }, T0);
    expect(store.leadAskOpen(first, T0)).toBeNull();
    expect(store.leadAskState(first, T0).state).toBe("answered");
    expect(store.leadAsk(first)).not.toBeNull();
    const failed = turn(false);
    expect(store.leadAsk(failed)).toBeNull();
    // A turn the lead started itself (automatic crew updates) is no answer; only the owner's own reply is.
    const asked = turn(true);
    const at = new Date(T0.getTime() + 60_000);
    const opened = store.openLeadTurn({ approver: "alex", session: session.id, thread: thread.id, credentialKey: "k", reservedMicrousd: 10, dailyTurns: 50, weeklyCeilingMicrousd: 25_000_000, deadlineMs: 60_000 }, at);
    if (!opened.ok) throw new Error(opened.reason);
    store.appendLeadMessage({ thread: thread.id, turn: opened.id, role: "operator", text: LEAD_FOLLOW_MESSAGE }, at);
    expect(store.leadAskState(asked, at).state).toBe("open");
    const answer = store.appendLeadMessage({ thread: thread.id, turn: null, role: "operator", text: "Signup" }, at);
    expect(store.leadAskState(asked, at).state).toBe("answered");
    // Once retention removed the reply that asked and the answer, the question reads expired, never open again.
    const asking = Number(store.handle.prepare("SELECT MAX(id) AS id FROM lead_message WHERE turn = ? AND role = 'assistant'").get(asked)!["id"]);
    store.handle.prepare("DELETE FROM lead_message WHERE id IN (?, ?)").run(asking, answer);
    expect(store.leadAskState(asked, at).state).toBe("expired");
  });

  test("c2: a question is open, then answered or expired; its rows never block a purge of the turn or the reply", () => {
    const thread = store.openLeadThread("alex", who.ceilingDigest, T0).thread;
    store.mintLeadSession({ approver: "alex", approverGeneration: who.generation, credentialKey: "k", ceilingMicrousd: 5_000_000, ceilingDigest: who.ceilingDigest, termsDigest: "t".repeat(64) }, T0);
    const session = store.activeLeadSession("alex")!;
    const asked = (at: Date): number => {
      const opened = store.openLeadTurn({ approver: "alex", session: session.id, thread: thread.id, credentialKey: "k", reservedMicrousd: 10, dailyTurns: 50, weeklyCeilingMicrousd: 25_000_000, deadlineMs: 60_000 }, at);
      if (!opened.ok) throw new Error(opened.reason);
      const started = store.startLeadTurn(opened.id, at);
      if (!started.ok) throw new Error("start");
      store.appendLeadMessage({ thread: thread.id, turn: opened.id, role: "operator", text: "Plan the refunds" }, at);
      store.recordLeadAsk({ turn: opened.id, thread: thread.id, question: "Which first?", options: ["Login", "Signup"] }, at);
      store.finalizeLeadTurn(opened.id, started.generation, { state: "answered", settledMicrousd: 1, tokensIn: 1, tokensOut: 1, message: { text: "One choice first.", activity: "" } }, at);
      return opened.id;
    };
    // Too old: expired, not answered.
    const old = asked(T0);
    expect(store.leadAskState(old, T0).state).toBe("open");
    expect(store.leadAskState(old, new Date(T0.getTime() + LEAD_ASK_TTL_MS)).state).toBe("expired");
    expect(store.leadAskOpen(old, new Date(T0.getTime() + LEAD_ASK_TTL_MS))).toBeNull();
    // A retention purge of the chat takes the question with the reply that asked it; a tap then finds it expired.
    store.setRetentionPeriod("chat", 30, "alex", T0);
    const later = new Date(T0.getTime() + 40 * 86_400_000);
    const recent = asked(later);
    const swept = sweepRetention(store, join(dir, "evidence"), later);
    expect(swept.counts.find(one => one.kind === "chat")?.count).toBe(2);
    expect(store.handle.prepare("SELECT turn FROM lead_ask ORDER BY turn").all().map(row => Number(row["turn"]))).toEqual([recent]);
    expect(store.leadAskState(old, later).state).toBe("expired");
    expect(store.leadAskState(recent, later).state).toBe("open");
    // Deleting the turn itself is never blocked by its question.
    store.handle.prepare("DELETE FROM lead_message WHERE turn = ?").run(recent);
    store.handle.prepare("DELETE FROM mate_turn WHERE id = ?").run(recent);
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM lead_ask").get()!["n"]).toBe(0);
  });

  test("c3: the contract carries the reply rules, the memory, integration and asking rules", () => {
    for (const rule of [
      "lead with the answer",
      "a status or a yes/no is 1-3 sentences",
      "Plain text, no headers",
      "Say what you checked this turn",
      "I checked the run log:",
      "Mark anything you did not check this turn as a guess",
      "I haven't checked",
      "say 'I don't know', then check with a tool",
      "never make up an answer, and never present a guess as something you remember",
      "call search_project_memory for it this turn",
      "call get_capabilities this turn",
      "open its link with show_control",
      "use ask_owner: one question, 2-4 short options",
      "only when the answer changes the work",
    ]) expect(LEAD_CONTRACT).toContain(rule);
  });

  test("c3: refusal copy is plain words — what happened, then one next step — with no internal terms", () => {
    for (const [reason, copy] of Object.entries(LEAD_REFUSAL_COPY)) {
      expect(copy, reason).not.toMatch(/\b(mint|minted|latch|latched|credential|ceiling|session|admitted|turn cap|pinned)\b/i);
      expect(copy, reason).toMatch(/^[A-Z]/);
      expect(copy, reason).toMatch(/\.$/);
      // At least two sentences: what happened and what it means, then the step to take.
      expect(copy.split(/(?<=\.)\s+/).length, reason).toBeGreaterThanOrEqual(2);
    }
    expect(LEAD_REFUSAL_COPY["ceiling-changed"]).toBe("Your projects changed since this chat started, so it can't go on. Start a new chat.");
    expect(LEAD_REFUSAL_COPY.latched).toBe("An earlier reply stopped before its cost was known, so chat is paused. Acknowledge that reply on the Chat page, then send again.");
  });
});
