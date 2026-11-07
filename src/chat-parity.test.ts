/**
 * Chat and console parity (docs/plans/toolroll-cards.md): every new action, against a real store. A model can only draft
 * one; a person's yes through the confirm door runs the console's own write; and a project-limited person gets what the
 * console gives them.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquire, finalize } from "./claim.js";
import { withActor } from "./actor.js";
import { APPROVAL_ACTIONS, mintSharedActionReview, prepareSharedAction, type ChatAction } from "./chat-actions.js";
import { setChatApproval } from "./chat-approval.js";
import { chatTaskStamp } from "./chat-task-actions.js";
import { storeEvidence } from "./evidence.js";
import { addFlowTriggerTo } from "./flow-triggers.js";
import { activeUnattendedGrant, sealUnattended } from "./flow-unattended.js";
import { leadIdentityOf } from "./lead-identity.js";
import { LEAD_TOOL_SCHEMAS } from "./lead-tools.js";
import { listProposals, memorySurface } from "./memory-pass.js";
import { authPauseOf, pauseForAuth } from "./provider-auth.js";
import { requestTaskStop } from "./task-control.js";
import { flowFromSteps } from "./flows.js";
import { confirmLeadProposal } from "./lead-doors.js";
import { CHAT_ACTION_LOCAL_ACTS } from "./local-owner.js";
import { modeDigestOf, modeTermsJson, presetTerms } from "./modes.js";
import { verifyApproverStanding, type VerifiedApprover } from "./principal.js";
import { fileTaskProposal } from "./proposal.js";
import { register } from "./runner.js";
import { addApprover, approve, propose } from "./scope.js";
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
    const turn = store.openLeadTurn({ approver: who.name, session, thread, credentialKey: "parity", reservedMicrousd: 0, dailyTurns: 100, weeklyCeilingMicrousd: 10_000_000, deadlineMs: 60_000 }, now);
    if (!turn.ok) throw Error(turn.reason);
    const started = store.startLeadTurn(turn.id, now);
    if (!started.ok) throw Error("start");
    const id = store.draftLeadProposal({ thread, turn: turn.id, kind: "action", payload: { ...action }, ceilingDigest: who.ceilingDigest }, now)!;
    store.finalizeLeadTurn(turn.id, started.generation, { state: "answered", settledMicrousd: 0, tokensIn: 0, tokensOut: 0, message: { text: "Here it is.", activity: "" } }, now);
    return id;
  }
  const yes = (id: number, via: "slack" | "discord" | "telegram" = "slack") => confirmLeadProposal(store, who, id, now, { authority: "full", via, confirm: true, evidenceRoot: root });

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

  /** A real attempt on `t-1` that a person stopped: its run, its ref and what the stop left. */
  function stopped(id = "t-1") {
    const filed = store.getScope(id) ?? propose(store, { taskId: id, goal: "Tidy the footer.", now });
    if (filed === null) throw Error("scope");
    expect(approve(store, id, who.name, now, store.getScope(id)!.digest, token).ok).toBe(true);
    register(store, { name: "worker", host: "test", capacity: 1, repos: [repo], now, newToken: () => "worker-token" });
    const ref = store.lookupRef(id)!, claim = acquire(store, ref.id, "worker", { token: "worker-token", now, newLeaseId: () => "lease-1" });
    if (!claim.ok) throw Error(claim.reason);
    const route = store.routeAuthorityFor(ref.id, "builder");
    if (!route?.ok) throw Error("route");
    const run = store.startRun({ taskRef: ref.id, leaseId: claim.claim.leaseId, runner: "worker", branch: "fixture", worktree: repo, route: route.stamp, now });
    expect(requestTaskStop(store, { taskId: id, runId: run, by: who.name, via: "web" }, now).ok).toBe(true);
    finalize(store, claim.claim.leaseId, { kind: "interrupted", runId: run, taskId: id, stopRun: run, now });
    return { run, ref };
  }

  function scheduled(): number {
    const flow = store.createFlow({ repo, name: "Upkeep", by: "operator", definitionJson: JSON.stringify(flowFromSteps([{ title: "Update", kind: "task" }], null)) }, now);
    const made = addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "schedule", schedule: "daily 09:00", title: "Upkeep", description: null, zone: null }, "operator", now, null);
    if (!made.ok) throw Error(made.message);
    return flow;
  }

  function memoryProposal(): number {
    execFileSync("git", ["init", "-q", repo]);
    const surface = memorySurface(store, repo, "operator").version;
    return Number(store.handle.prepare("INSERT INTO memory_proposal(repo,kind,fingerprint,title,rationale,before_text,after_text,evidence,sessions,status,created_at,surface) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(repo, "decision-add", "gap:one", "Keep the footer small", "Two sessions asked.", null, "Keep the footer small.", "[]", 2, "pending", now.toISOString(), surface).lastInsertRowid);
  }

  function blockedRevision(): { id: number; ref: number } {
    const { run, ref } = stopped();
    const artifact = storeEvidence(store, root, run, "plan", "plan.json", Buffer.from("Revised plan: one step."), "plan", now, { captureStatus: "ok" });
    const id = store.insertPlanRevision({ taskRef: ref.id, revision: 2, artifact, parentHash: null, reason: "The first plan missed a step.", evidenceLink: null, author: `builder:${run}`, originRun: run,
      kind: "builder-proposal", authorityKind: "plan-only", authorityDigest: "digest", changedFields: [], status: "blocked" }, now);
    return { id, ref: ref.id };
  }

  function latched(): void {
    expect(store.establishMirror({ localTaskId: "t-1", backend: "github", remoteRepo: "owner/name", remoteId: "7", provenance: "local-create", establishedBy: "operator", syncGeneration: 1 }, now)).toEqual({ ok: true });
    store.latchMirror("t-1", "closed", 2, now);
    store.observeMirrorOpen("t-1", 3);
  }

  /** Each new act: what it asks for, and how to read whether it has happened. */
  const ACTS: [ChatAction, () => { input: Record<string, unknown>; done: () => boolean }][] = [
    ["provider_resume", () => { const { run, ref } = stopped(); pauseForAuth(store, { provider: "claude", authMode: null, runId: run, taskRef: ref.id, now }); return { input: { provider: "claude" }, done: () => authPauseOf(store, "claude") === null }; }],
    ["incident_resolve", () => { const { run } = stopped(); const incident = store.createIncident({ run, kind: "malformed-decision" }, now); return { input: { incident }, done: () => store.openIncidents().every(one => one.id !== incident) }; }],
    ["memory_decide", () => { const proposal = memoryProposal(); return { input: { repo, proposal, decision: "accept" }, done: () => listProposals(store, repo).length === 0 && listProposals(store, repo, "all")[0]?.status === "accepted" }; }],
    ["flow_unattended", () => { const flow = scheduled(); return { input: { flow, days: 3 }, done: () => activeUnattendedGrant(store, flow, now) !== null }; }],
    ["flow_unattended_off", () => { const flow = scheduled(); expect(sealUnattended(store, { flow, signer: "operator", ask: { days: 2, budgetMicrousd: null, dailyRunCap: null } }, now).ok).toBe(true); return { input: { flow }, done: () => activeUnattendedGrant(store, flow, now) === null }; }],
    ["task_reopen", () => { latched(); return { input: { task: "t-1" }, done: () => store.mirrorByTask("t-1")?.dispatchOk === true }; }],
    ["revision_accept", () => { const { id } = blockedRevision(); return { input: { task: "t-1" }, done: () => store.getPlanRevision(id)?.status === "applied" }; }],
    ["revision_reject", () => { const { id } = blockedRevision(); return { input: { task: "t-1", revision: id }, done: () => store.getPlanRevision(id)?.status === "rejected" }; }],
    ["mode_revoke", () => { signMode(); return { input: { repo }, done: () => store.activeMode(repo, now) === null }; }],
    ["task_archive", () => ({ input: { task: "t-1" }, done: () => refArchived(store, store.lookupRef("t-1")!.id) })],
    ["flow_archive", () => { const flow = scheduled(); return { input: { flow }, done: () => store.getFlow(flow)?.state !== "active" }; }],
    ["lead_identity", () => ({ input: { name: "Maya", persona: "Plain and brief." }, done: () => leadIdentityOf(store, "operator").name === "Maya" })],
    ["worker_note", () => { register(store, { name: "worker-2", host: "test", capacity: 1, repos: [repo], now, newToken: () => "tok-2" }); return { input: { runner: "worker-2", note: "Back on Monday" }, done: () => store.listRunners().find(one => one.name === "worker-2")?.queueNote === "Back on Monday" }; }],
  ];

  test.each(ACTS)("%s: drafting does nothing, no token runs it, and a person's yes does", (operation, arrange) => {
    const { input, done } = arrange();
    const id = draft(operation, input);
    expect(done()).toBe(false);
    // What a model holds: no tool confirms, and a token on the web door or the lead's own road is not a person.
    expect(LEAD_TOOL_SCHEMAS.some(one => /confirm/.test(one.name))).toBe(false);
    if (APPROVAL_ACTIONS.has(operation)) {
      expect(confirmLeadProposal(store, who, id, now, { authority: "full", via: "web", confirm: true, evidenceRoot: root })).toMatchObject({ ok: false });
      expect(confirmLeadProposal(store, who, id, now, { authority: "full", via: "cli", confirm: true, evidenceRoot: root })).toMatchObject({ ok: false });
      expect(withActor({ account: "operator", lead: true }, () => confirmLeadProposal(store, who, id, now, { authority: "full", via: "slack", confirm: true, evidenceRoot: root }))).toMatchObject({ ok: false });
      expect(done()).toBe(false);
      expect(store.getLeadProposal(id)!.state).toBe("pending");
    }
    expect(yes(id)).toMatchObject({ ok: true });
    expect(done()).toBe(true);
    expect(yes(id)).toMatchObject({ ok: false, reason: "not-pending" });
  });

  test.each(["task_reopen", "revision_accept", "flow_unattended"] as const)("%s: a person's own off holds", operation => {
    const { input, done } = ACTS.find(one => one[0] === operation)![1]();
    const id = draft(operation, input);
    expect(setChatApproval(store, { approver: "operator", scope: repo, enabled: false, via: "test" }, now).ok).toBe(true);
    expect(yes(id)).toMatchObject({ ok: false });
    expect(done()).toBe(false);
  });

  test("flow_unattended: a schedule added after the card was made refuses it, and saved limits hold", () => {
    const flow = scheduled();
    const id = draft("flow_unattended", { flow, days: 3 });
    expect(addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "schedule", schedule: "every 1 hour", title: "More", description: null, zone: null }, "operator", now, null).ok).toBe(true);
    expect(yes(id)).toMatchObject({ ok: false, reason: "stale" });
    expect(activeUnattendedGrant(store, flow, now)).toBeNull();
    const fresh = draft("flow_unattended", { flow, days: 3 });
    expect(setChatApproval(store, { approver: "operator", scope: repo, enabled: true, limits: { fullAccess: true, capMicrousd: 1_000_000 }, via: "test" }, now).ok).toBe(true);
    expect(yes(fresh)).toMatchObject({ ok: false });
    expect(activeUnattendedGrant(store, flow, now)).toBeNull();
  });

  test("flow_unattended: the ledger says which road and which chat, naming the grant", () => {
    const line = (flow: number) => store.actionLedger({ repos: [repo] }).filter(one => one.action === "flow runs on its own: signed" && String(one.detail).includes(`flow #${flow}`));
    const slack = scheduled();
    const tapped = draft("flow_unattended", { flow: slack, days: 3 });
    expect(confirmLeadProposal(store, who, tapped, now, { authority: "full", via: "slack", binding: 7, confirm: true, evidenceRoot: root })).toMatchObject({ ok: true });
    const grant = activeUnattendedGrant(store, slack, now)!;
    expect(line(slack)).toHaveLength(1);
    expect(line(slack)[0]!.detail).toContain(`grant #${grant.id} · via slack · chat binding #7`);
    const web = scheduled();
    const clicked = draft("flow_unattended", { flow: web, days: 3 });
    const review = mintSharedActionReview(store, who, clicked, root, now);
    expect(confirmLeadProposal(store, who, clicked, now, { authority: "full", via: "web", person: true, confirm: true, evidenceRoot: root, actionReview: { nonce: review.nonce, password: "" } })).toMatchObject({ ok: true });
    expect(line(web)[0]!.detail).toContain(`grant #${activeUnattendedGrant(store, web, now)!.id} · via web`);
    expect(line(web)[0]!.detail).not.toContain("chat binding");
  });

  test("a project-limited person can't sign a flow to run on its own, as the console refuses them", () => {
    const flow = scheduled();
    const sam = addApprover(store, "sam", now, { name: "operator", token });
    if (!sam.ok) throw Error("sam");
    expect(store.setAccountProjects("sam", [repo], "operator", now)).toEqual({ ok: true });
    const verified = verifyApproverStanding(store, "sam", store.accountOf("sam")!.generation, [repo]);
    if (!verified.ok) throw Error("identity");
    expect(() => prepareSharedAction(store, verified.who, "flow_unattended", { flow, days: 3 }, root, now)).toThrow("access to every project");
  });

  describe("the resume task action", () => {
    function resumeCard(run: number): number {
      const turn = store.openLeadTurn({ approver: who.name, session, thread, credentialKey: "parity", reservedMicrousd: 0, dailyTurns: 100, weeklyCeilingMicrousd: 10_000_000, deadlineMs: 60_000 }, now);
      if (!turn.ok) throw Error(turn.reason);
      const started = store.startLeadTurn(turn.id, now);
      if (!started.ok) throw Error("start");
      const id = store.draftLeadProposal({ thread, turn: turn.id, kind: "task_action", payload: { task: "t-1", taskTitle: "Tidy the footer", operation: "resume", run, stamp: chatTaskStamp(store, who, "t-1") }, ceilingDigest: who.ceilingDigest }, now)!;
      store.finalizeLeadTurn(turn.id, started.generation, { state: "answered", settledMicrousd: 0, tokensIn: 0, tokensOut: 0, message: { text: "Here it is.", activity: "" } }, now);
      return id;
    }

    test("a person's own off refuses it, in their chat and in web chat", () => {
      const { run } = stopped();
      expect(setChatApproval(store, { approver: "operator", scope: repo, enabled: false, via: "test" }, now).ok).toBe(true);
      expect(yes(resumeCard(run))).toMatchObject({ ok: false });
      expect(store.stopOf(run)?.resumedAt ?? null).toBeNull();
      expect(confirmLeadProposal(store, who, resumeCard(run), now, { authority: "full", via: "web", person: true, evidenceRoot: root })).toMatchObject({ ok: false });
      expect(store.stopOf(run)?.resumedAt ?? null).toBeNull();
    });

    test("a token on the web door only asks: nothing resumes", () => {
      const { run } = stopped();
      expect(confirmLeadProposal(store, who, resumeCard(run), now, { authority: "full", via: "web", evidenceRoot: root })).toMatchObject({ ok: true, said: expect.stringContaining("Resume requested") });
      expect(store.stopOf(run)?.resumedAt ?? null).toBeNull();
    });

    test.each(["slack", "discord", "telegram"] as const)("a tap in %s lifts the stop and is recorded as %s", via => {
      const { run } = stopped();
      expect(yes(resumeCard(run), via)).toMatchObject({ ok: true, said: expect.stringContaining("Stop released") });
      expect(store.stopOf(run)).toMatchObject({ resumedVia: via, resumedBy: expect.stringContaining("operator") });
    });

    test.each(["slack", "discord"] as const)("task_resume from %s records its own road", via => {
      const { run } = stopped();
      expect(yes(draft("task_resume", { task: "t-1", run }), via)).toMatchObject({ ok: true });
      expect(store.stopOf(run)?.resumedVia).toBe(via);
    });
  });
});
