/**
 * Chat and console parity (docs/plans/toolroll-cards.md): every new action, against a real store. A model can only draft
 * one; a person's yes through the confirm door runs the console's own write; and a project-limited person gets what the
 * console gives them.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareSharedAction, sharedActionNeedsReview, type ChatAction } from "./chat-actions.js";
import { flowFromSteps } from "./flows.js";
import { confirmLeadProposal } from "./lead-doors.js";
import { CHAT_ACTION_LOCAL_ACTS } from "./local-owner.js";
import { modeDigestOf, modeTermsJson, presetTerms } from "./modes.js";
import { verifyApproverStanding, type VerifiedApprover } from "./principal.js";
import { fileTaskProposal } from "./proposal.js";
import { register } from "./runner.js";
import { addApprover } from "./scope.js";
import { openStore, refArchived, type Store } from "./store.js";

const now = new Date("2026-11-07T09:00:00Z");

describe("the new chat actions", () => {
  let root: string, repo: string, store: Store, who: VerifiedApprover, token: string, thread: number, session: number;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "chat-parity-")));
    repo = join(root, "shop");
    mkdirSync(repo);
    store = openStore(join(root, "orders.db"));
    const account = addApprover(store, "operator", now);
    if (!account.ok) throw Error("account");
    token = account.token;
    for (const phase of ["plan", "build", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "fixture", now);
    const verified = verifyApproverStanding(store, "operator", store.accountOf("operator")!.generation, [repo]);
    if (!verified.ok) throw Error("identity");
    who = verified.who;
    session = store.mintLeadSession({ approver: who.name, approverGeneration: who.generation, credentialKey: "parity", ceilingMicrousd: 10_000_000, ceilingDigest: who.ceilingDigest, termsDigest: "fixture" }, now);
    thread = store.openLeadThread(who.name, who.ceilingDigest, now).thread.id;
    if (!fileTaskProposal(store, { id: "t-1", title: "Tidy the footer", repo, filedVia: "cli" }, now).ok) throw Error("task");
  });
  afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

  /** What a model can do: prepare and draft, nothing more. */
  function draft(operation: ChatAction, input: Record<string, unknown>): number {
    const action = prepareSharedAction(store, who, operation, input, root, now);
    expect(sharedActionNeedsReview(action)).toBe(false);
    const turn = store.openLeadTurn({ approver: who.name, session, thread, credentialKey: "parity", reservedMicrousd: 0, dailyTurns: 100, weeklyCeilingMicrousd: 10_000_000, deadlineMs: 60_000 }, now);
    if (!turn.ok) throw Error(turn.reason);
    const started = store.startLeadTurn(turn.id, now);
    if (!started.ok) throw Error("start");
    const id = store.draftLeadProposal({ thread, turn: turn.id, kind: "action", payload: { ...action }, ceilingDigest: who.ceilingDigest }, now)!;
    store.finalizeLeadTurn(turn.id, started.generation, { state: "answered", settledMicrousd: 0, tokensIn: 0, tokensOut: 0, message: { text: "Here it is.", activity: "" } }, now);
    return id;
  }
  const yes = (id: number) => confirmLeadProposal(store, who, id, now, { authority: "full", via: "slack", evidenceRoot: root });

  function signMode(): void {
    const terms = presetTerms("standard", new Date(now.getTime() + 86_400_000).toISOString());
    store.signMode({ repo, name: terms.name, termsJson: modeTermsJson(terms), digest: modeDigestOf(terms), signedBy: "operator", absoluteExpiry: terms.absoluteExpiry, publication: terms.publication } as never, now);
  }

  test("none is a local owner's act", () => {
    for (const operation of ["mode_revoke", "flow_unattended_off", "flow_archive", "provider_resume", "worker_note", "lead_identity", "task_archive", "task_restore", "incident_resolve", "memory_decide"] as const)
      expect(CHAT_ACTION_LOCAL_ACTS[operation], operation).toBeNull();
  });

  test("put away and restore: only a person's yes moves the task", () => {
    const ref = store.lookupRef("t-1")!.id;
    const put = draft("task_archive", { task: "t-1" });
    expect(refArchived(store, ref)).toBe(false);
    expect(yes(put)).toMatchObject({ ok: true });
    expect(refArchived(store, ref)).toBe(true);
    const back = draft("task_restore", { task: "t-1" });
    expect(refArchived(store, ref)).toBe(true);
    expect(yes(back)).toMatchObject({ ok: true });
    expect(refArchived(store, ref)).toBe(false);
  });

  test("a flow archived from chat, once, by a person", () => {
    const flow = store.createFlow({ repo, name: "Nightly", by: "operator", definitionJson: JSON.stringify(flowFromSteps([{ title: "Inbox", kind: "inbox" }], null)) }, now);
    const id = draft("flow_archive", { flow });
    expect(store.getFlow(flow)!.state).toBe("active");
    expect(yes(id)).toMatchObject({ ok: true });
    expect(store.getFlow(flow)!.state).not.toBe("active");
    expect(yes(id)).toMatchObject({ ok: false, reason: "not-pending" });
  });

  test("a worker's note and the lead's name are the person's own to change", () => {
    register(store, { name: "worker-1", host: "test", capacity: 1, repos: [repo], now, newToken: () => "tok" });
    const note = draft("worker_note", { runner: "worker-1", note: "Back on Monday" });
    expect(store.listRunners().find(one => one.name === "worker-1")?.queueNote ?? null).toBeNull();
    expect(yes(note)).toMatchObject({ ok: true });
    expect(store.listRunners().find(one => one.name === "worker-1")?.queueNote).toBe("Back on Monday");
    expect(() => draft("worker_note", { runner: "nobody", note: "x" })).toThrow("No such worker.");
    const name = draft("lead_identity", { name: "Maya", persona: "Plain and brief." });
    expect(yes(name)).toMatchObject({ ok: true, said: "Your lead is called Maya now." });
  });

  test("ending a mode lowers authority: one person's yes, and a changed mode refuses the old card", () => {
    expect(() => draft("mode_revoke", { repo })).toThrow("No automatic approvals are on");
    signMode();
    const id = draft("mode_revoke", { repo });
    expect(store.activeMode(repo, now)).not.toBeNull();
    expect(yes(id)).toMatchObject({ ok: true });
    expect(store.activeMode(repo, now)).toBeNull();
  });

  test("resuming a paused agent needs a pause, and nothing else widens", () => {
    expect(() => draft("provider_resume", { provider: "claude" })).toThrow("That agent isn't paused.");
    expect(() => draft("provider_resume", { provider: "not-a-provider" })).toThrow("Choose an agent provider.");
  });

  test("a project-limited person gets what the console gives them, nothing more", () => {
    const sam = addApprover(store, "sam", now, { name: "operator", token });
    if (!sam.ok) throw Error("sam");
    expect(store.setAccountProjects("sam", [repo], "operator", now)).toEqual({ ok: true });
    const verified = verifyApproverStanding(store, "sam", store.accountOf("sam")!.generation, [repo]);
    if (!verified.ok) throw Error("identity");
    const limited = verified.who;
    for (const [operation, input] of [["mode_revoke", { repo }], ["provider_resume", { provider: "claude" }], ["worker_note", { runner: "w", note: "x" }], ["lead_identity", { name: "A", persona: "B" }], ["memory_decide", { repo, proposal: 1, decision: "accept" }], ["incident_resolve", { incident: 1 }]] as const)
      expect(() => prepareSharedAction(store, limited, operation, input as Record<string, unknown>, root, now), operation).toThrow("access to every project");
    // The console lets them put away a task in their own project.
    expect(prepareSharedAction(store, limited, "task_archive", { task: "t-1" }, root, now).repo).toBe(repo);
  });
});
