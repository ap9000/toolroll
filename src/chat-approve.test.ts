/**
 * Approving from chat (docs/plans/toolroll-cards.md): a person with the authority approves from their own chat, with no
 * password. Each case here tries a way around what makes that safe. Real store, the real confirm door.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withActor } from "./actor.js";
import { CHAT_ACTIONS, prepareSharedAction, sharedActionAllowsChallenge, sharedActionPayload, APPROVAL_ACTIONS } from "./chat-actions.js";
import { ALL_PROJECTS, setChatApproval } from "./chat-approval.js";
import { confirmLeadProposal } from "./lead-doors.js";
import { executeLeadTool, LEAD_TOOL_SCHEMAS } from "./lead-tools.js";
import { verifyApproverStanding, type VerifiedApprover } from "./principal.js";
import { fileTaskProposal } from "./proposal.js";
import { addApprover, approve, approvalProofOf, propose } from "./scope.js";
import { openStore, type Store } from "./store.js";

const now = new Date("2026-11-07T09:00:00Z");

describe("approving from chat", () => {
  let root: string, repo: string, store: Store, who: VerifiedApprover, thread: number, session: number;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "chat-approve-")));
    repo = join(root, "shop");
    mkdirSync(repo);
    store = openStore(join(root, "orders.db"));
    if (!addApprover(store, "operator", now).ok) throw Error("account");
    for (const phase of ["plan", "build", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "fixture", now);
    const verified = verifyApproverStanding(store, "operator", store.accountOf("operator")!.generation, [repo]);
    if (!verified.ok) throw Error("identity");
    who = verified.who;
    session = store.mintLeadSession({ approver: who.name, approverGeneration: who.generation, credentialKey: "approve", ceilingMicrousd: 10_000_000, ceilingDigest: who.ceilingDigest, termsDigest: "fixture" }, now);
    thread = store.openLeadThread(who.name, who.ceilingDigest, now).thread.id;
    const filed = fileTaskProposal(store, { id: "fix-1", title: "Fix the login page", repo, filedVia: "cli" }, now);
    if (!filed.ok) throw Error(filed.message);
    propose(store, { taskId: "fix-1", goal: "Fix the login page.", touches: ["src/login.ts"], acceptance: [{ id: "c1", statement: "Login works.", how: null, evidence: ["check"] }], now });
  });
  afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

  /** The lead drafts the card, as a model would: this is all a model can do. */
  function draft(): number {
    const turn = store.openLeadTurn({ approver: who.name, session, thread, credentialKey: "approve", reservedMicrousd: 0, dailyTurns: 100, weeklyCeilingMicrousd: 10_000_000, deadlineMs: 60_000 }, now);
    if (!turn.ok) throw Error(turn.reason);
    const started = store.startLeadTurn(turn.id, now);
    if (!started.ok) throw Error("start");
    const action = prepareSharedAction(store, who, "scope_approve", { task: "fix-1" }, root, now);
    const id = store.draftLeadProposal({ thread, turn: turn.id, kind: "action", payload: { ...action }, ceilingDigest: who.ceilingDigest }, now)!;
    store.finalizeLeadTurn(turn.id, started.generation, { state: "answered", settledMicrousd: 0, tokensIn: 0, tokensOut: 0, message: { text: "Here it is.", activity: "" } }, now);
    return id;
  }
  const tap = (id: number, yes = true) => confirmLeadProposal(store, who, id, now, { authority: "full", via: "slack", confirm: yes, evidenceRoot: root });
  const sealed = () => store.getScope("fix-1")?.approvedDigest ?? null;

  test("every approval says it needs no password, and each is protected: never a one-tap act", () => {
    for (const operation of APPROVAL_ACTIONS) expect(CHAT_ACTIONS[operation]).toMatchObject({ protected: true, password: false });
    expect(sharedActionAllowsChallenge(sharedActionPayload(store.getLeadProposal(draft())!.payload)!)).toBe(true);
  });

  test("a person's own second tap approves, recorded as that person, bound to these exact terms", () => {
    const id = draft();
    expect(tap(id, false)).toMatchObject({ ok: false, reason: "needs-confirm" });
    expect(sealed()).toBeNull();
    expect(tap(id)).toMatchObject({ ok: true });
    const scope = store.getScope("fix-1")!;
    expect(scope).toMatchObject({ approvedBy: "operator", approvalBasis: "chat", approvedDigest: scope.digest });
    expect(approvalProofOf(store, "fix-1", "operator", scope.digest)?.method).toBe("chat");
  });

  test("a card is one use: a replayed tap changes nothing", () => {
    const id = draft();
    expect(tap(id)).toMatchObject({ ok: true });
    expect(tap(id)).toMatchObject({ ok: false, reason: "not-pending" });
  });

  test("changed terms refuse: a card can't approve what it didn't show", () => {
    const id = draft();
    propose(store, { taskId: "fix-1", goal: "Delete the login page.", touches: ["src/login.ts"], acceptance: [{ id: "c1", statement: "Gone.", how: null, evidence: ["check"] }], now });
    expect(tap(id)).toMatchObject({ ok: false, reason: "stale" });
    expect(sealed()).toBeNull();
  });

  test("a model has no road: no tool confirms, drafting approves nothing, and a token on the web door is refused", () => {
    expect(LEAD_TOOL_SCHEMAS.map(one => one.name).filter(name => /confirm|approve$/.test(name))).toEqual([]);
    const id = draft();
    expect(sealed()).toBeNull();
    expect(executeLeadTool({ store, who, now, step: 1, readDecisions: new Map(), draft: () => null }, "offer_approval", { task: "fix-1" })).toMatchObject({ ok: true });
    expect(sealed()).toBeNull();
    expect(confirmLeadProposal(store, who, id, now, { authority: "full", via: "web", confirm: true, evidenceRoot: root })).toMatchObject({ ok: false, reason: "needs-confirm" });
    expect(confirmLeadProposal(store, who, id, now, { authority: "full", via: "web", person: false, confirm: true, evidenceRoot: root, actionReview: { nonce: "x", password: "" } })).toMatchObject({ ok: false, reason: "needs-confirm" });
    expect(confirmLeadProposal(store, who, id, now, { authority: "full", via: "cli", confirm: true, evidenceRoot: root })).toMatchObject({ ok: false, reason: "needs-confirm" });
    expect(sealed()).toBeNull();
  });

  test("a machine acting can't use the chat road, whatever it holds", () => {
    const scope = store.getScope("fix-1")!;
    const result = withActor({ account: "operator", lead: true }, () => approve(store, "fix-1", "operator", now, scope.digest, "", {}, undefined, { modeDigest: "x", shown: true }));
    expect(result).toMatchObject({ ok: false, reason: "machine-proof" });
    expect(sealed()).toBeNull();
  });

  test("the chat road proves the person's role and reach itself", () => {
    const scope = store.getScope("fix-1")!;
    expect(approve(store, "fix-1", "stranger", now, scope.digest, "", {}, undefined, { modeDigest: "x", shown: true })).toMatchObject({ ok: false, reason: "not-an-approver" });
    expect(sealed()).toBeNull();
  });

  test("a person's own off holds in their chat", () => {
    const id = draft();
    expect(setChatApproval(store, { approver: "operator", scope: ALL_PROJECTS, enabled: false, via: "test" }, now).ok).toBe(true);
    expect(tap(id)).toMatchObject({ ok: false });
    expect(sealed()).toBeNull();
  });

  test("terms a machine wrote seal only on a chat yes naming every word shown; nothing automatic gets through", () => {
    store.handle.prepare("UPDATE task_scope SET proposed_via = 'mate' WHERE task_id = 'fix-1'").run();
    const digest = store.getScope("fix-1")!.digest;
    for (const basis of [{ kind: "chat" as const, modeDigest: "x" }, { kind: "chat" as const, modeDigest: "x", card: "terms" as const, cardDigest: "0".repeat(64) }, { kind: "mode" as const, modeDigest: "x" }])
      expect(store.sealScopeApproval("fix-1", "operator", now, {}, basis, "person")).toBe(false);
    expect(sealed()).toBeNull();
    expect(approve(store, "fix-1", "operator", now, digest, "", {}, undefined, { modeDigest: "x", shown: true })).toMatchObject({ ok: true });
  });
});
