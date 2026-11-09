/**
 * Chat and console parity (docs/plans/toolroll-cards.md): every new action, against a real store. A model can only draft
 * one; a person's yes through the confirm door runs the console's own write; and a project-limited person gets what the
 * console gives them.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquire, finalize } from "./claim.js";
import { withActor } from "./actor.js";
import { readCardSource } from "./card-sources.js";
import { APPROVAL_ACTIONS, CHAT_ACTIONS, mintSharedActionReview, prepareSharedAction, type ChatAction } from "./chat-actions.js";
import { chatControlHref } from "./chat-controls.js";
import { findingFromWords, findingsInReach, findingSourceWords, findingsOfTask, getFinding, sendFinding } from "./findings.js";
import { setChatApproval } from "./chat-approval.js";
import { chatTaskStamp } from "./chat-task-actions.js";
import { storeEvidence } from "./evidence.js";
import { addFlowTriggerTo } from "./flow-triggers.js";
import { saveScript } from "./flow-scripts.js";
import { activeUnattendedGrant, prepareUnattendedCandidates, sealUnattended, unattendedCandidates } from "./flow-unattended.js";
import { leadIdentityOf } from "./lead-identity.js";
import { executeLeadTool, LEAD_TOOL_SCHEMAS } from "./lead-tools.js";
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

  /** A finding the agent has rejected: one a person may send back. */
  function answered(): number {
    const sent = sendFinding(store, { taskId: "t-1", source: "person", by: "operator", summary: "The total rounds down." }, now);
    if (!sent.ok) throw Error(sent.message);
    store.handle.prepare("UPDATE finding SET state = 'rejected' WHERE id = ?").run(sent.id);
    return sent.id;
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
    ["finding_send", () => ({ input: { task: "t-1", summary: "The total rounds down.", file: "src/total.ts", line: 12 }, done: () => findingsOfTask(store, "t-1").length === 1 })],
    ["finding_resend", () => { const id = answered(); return { input: { finding: id }, done: () => getFinding(store, id)?.state === "open" }; }],
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

  describe("follow-through in chat", () => {
    const termsOf = (id: number) => (store.getLeadProposal(id)!.payload as { terms: string[] }).terms.join("\n");

    test("a finding's card shows every value it will send, and a person's yes records them as the lead's words they confirmed", () => {
      const id = draft("finding_send", { task: "t-1", summary: "The total rounds down.", file: "src/total.ts", line: 12 });
      for (const words of ["Finding: The total rounds down.", "Where: src/total.ts:12", "Asks: ", "Tidy the footer"]) expect(termsOf(id)).toContain(words);
      expect(yes(id)).toMatchObject({ ok: true, said: expect.stringContaining("goes to the next attempt") });
      // The lead drafted the words; the person confirmed them. The record never shows the person as their author.
      const sent = findingsOfTask(store, "t-1")[0]!;
      expect(sent).toMatchObject({ summary: "The total rounds down.", file: "src/total.ts", line: 12, sentBy: "operator", source: "lead", state: "open" });
      expect(findingSourceWords(sent.source)).toBe("the lead, confirmed by a person");
      expect(findingFromWords(sent)).toBe("the lead, confirmed by operator");
    });

    test.each<[string, Record<string, unknown>, string]>([
      ["nothing to send", { task: "t-1" }, "Send one thing"],
      ["two things at once", { task: "t-1", summary: "x", run: 1 }, "Send one thing"],
      ["empty words", { task: "t-1", summary: "   " }, "Check the summary field"],
      ["a pointer into another task", { task: "t-1", pointer: "999:1" }, "isn't on this task"],
      ["a run from another task", { task: "t-1", run: 999 }, "isn't on this task"],
      ["a field the card has no line for", { task: "t-1", summary: "x", action: "Delete everything" }, "can't be read"],
    ])("a finding is refused for %s", (_name, input, words) => {
      expect(() => prepareSharedAction(store, who, "finding_send", input, root, now)).toThrow(words);
    });

    test("a card made before the agent answered again is stale; a closed or waiting finding has no card", () => {
      const id = answered();
      const card = draft("finding_resend", { finding: id });
      expect(termsOf(card)).toContain("round 2 of 2");
      store.handle.prepare("UPDATE finding SET rounds = 2 WHERE id = ?").run(id);
      expect(yes(card)).toMatchObject({ ok: false, reason: "stale" });
      store.handle.prepare("UPDATE finding SET state = 'closed' WHERE id = ?").run(id);
      expect(() => prepareSharedAction(store, who, "finding_resend", { finding: id }, root, now)).toThrow("closed");
      store.handle.prepare("UPDATE finding SET state = 'with-person' WHERE id = ?").run(id);
      expect(() => prepareSharedAction(store, who, "finding_resend", { finding: id }, root, now)).toThrow("needs your decision");
    });

    test("every project a finding touches must be in reach", () => {
      const id = answered();
      store.handle.prepare("UPDATE finding SET repo = ? WHERE id = ?").run(join(root, "bank"), id);
      expect(() => prepareSharedAction(store, who, "finding_resend", { finding: id }, root, now)).toThrow("outside your current access");
      // A task whose family reaches another project: nothing on it is sent from here.
      store.handle.prepare("UPDATE task_ref SET repo = ? WHERE external_id = 't-1'").run(join(root, "bank"));
      expect(() => prepareSharedAction(store, who, "finding_send", { task: "t-1", summary: "x" }, root, now)).toThrow();
      expect(readCardSource({ store, now, who, evidenceRoot: root }, "handover", { repo: null, task: "t-1" })).toEqual({ problem: "No such task in your projects." });
      expect(readCardSource({ store, now, who }, "findings", { repo: null, task: "t-1" })).toEqual({ problem: "No such task in your projects." });
      expect(readCardSource({ store, now, who }, "findings", { repo: null })).toMatchObject({ rows: [] });
    });

    test("findings and the handover note read as cards, marked as the agent's words", () => {
      answered();
      const seen = readCardSource({ store, now, who }, "findings", { repo: null, task: "t-1" });
      // Still marked as the agent's words; the state reads in words (card-sources.ts FINDING_STATE_WORDS).
      expect(seen).toMatchObject({ origin: "report", repos: [repo], rows: [{ state: "Rejected" }] });
      expect(JSON.stringify(seen)).toContain("The total rounds down.");
      expect(readCardSource({ store, now, who }, "handover", { repo: null })).toEqual({ problem: "Name the task: handover needs task." });
      expect(readCardSource({ store, now, who }, "handover", { repo: null, task: "t-1" })).toHaveProperty("problem");
      const note = readCardSource({ store, now, who, evidenceRoot: root }, "handover", { repo: null, task: "t-1" });
      expect(note).toMatchObject({ origin: "report", repos: [repo] });
      expect(JSON.stringify(note)).toContain("Next action");
    });

    test("the lead reads findings by number, and only in reach", () => {
      answered();
      const call = (args: Record<string, unknown>) => executeLeadTool({ store, who, now, step: 1, readDecisions: new Map(), draft: () => null }, "get_findings", args);
      expect(call({ task: "t-1" })).toMatchObject({ ok: true, body: { findings: [{ state: "rejected" }] } });
      expect(call({ task: "not-a-task" })).toMatchObject({ ok: false });
    });

    describe("a project-limited person", () => {
      let sam: VerifiedApprover, bank: string;
      beforeEach(() => {
        bank = join(root, "bank");
        mkdirSync(bank);
        const made = addApprover(store, "sam", now, { name: "operator", token });
        if (!made.ok) throw Error("sam");
        expect(store.setAccountProjects("sam", [repo], "operator", now)).toEqual({ ok: true });
        const verified = verifyApproverStanding(store, "sam", store.accountOf("sam")!.generation, [repo]);
        if (!verified.ok) throw Error("identity");
        sam = verified.who;
      });
      const familyOverBank = () => {
        if (!fileTaskProposal(store, { id: "t-2", title: "Elsewhere", repo: bank, filedVia: "cli" }, now).ok) throw Error("task");
        const family = store.taskFamilyOf("t-1", null, true)!;
        vi.spyOn(store, "taskFamilyOf").mockReturnValue({ ...family, versions: [...family.versions, store.taskFamilyOf("t-2", null, true)!.versions[0]!] });
      };
      const lead = (who: VerifiedApprover, args: Record<string, unknown>) => executeLeadTool({ store, who, now, step: 1, readDecisions: new Map(), draft: () => null }, "get_findings", args);

      test("a family reaching a project they can't: no findings, no handover, no send, on any road", () => {
        const id = answered();
        familyOverBank();
        expect(lead(sam, { task: "t-1" })).toMatchObject({ ok: false });
        expect(readCardSource({ store, now, who: sam }, "findings", { repo: null, task: "t-1" })).toEqual({ problem: "No such task in your projects." });
        expect(readCardSource({ store, now, who: sam, evidenceRoot: root }, "handover", { repo: null, task: "t-1" })).toEqual({ problem: "No such task in your projects." });
        expect(() => prepareSharedAction(store, sam, "finding_send", { task: "t-1", summary: "x" }, root, now)).toThrow("outside your access here");
        expect(() => prepareSharedAction(store, sam, "finding_resend", { finding: id }, root, now)).toThrow("outside your access here");
      });

      test("a chat that names a project their account can't reach gets nothing from it", () => {
        const wide = { ...sam, repos: [repo, bank] } as VerifiedApprover;
        familyOverBank();
        answered();
        expect(findingsInReach(store, wide, { task: "t-1", repos: wide.repos })).toBeNull();
        vi.restoreAllMocks();
        const other = sendFinding(store, { taskId: "t-2", source: "person", by: "operator", summary: "In the other project." }, now);
        if (!other.ok) throw Error(other.message);
        expect(findingsInReach(store, wide, { repos: wide.repos })!.map(one => one.id)).not.toContain(other.id);
        expect(readCardSource({ store, now, who: wide }, "findings", { repo: null })).not.toHaveProperty("problem");
        expect(JSON.stringify(readCardSource({ store, now, who: wide }, "findings", { repo: null }))).not.toContain("In the other project.");
      });

      test("a finding with no project is left out, and their own project's still read", () => {
        const id = answered();
        expect(lead(sam, { task: "t-1" })).toMatchObject({ ok: true, body: { findings: [{ finding: id }] } });
        store.handle.prepare("UPDATE finding SET repo = NULL WHERE id = ?").run(id);
        expect(lead(sam, { task: "t-1" })).toMatchObject({ ok: true, body: { findings: [] } });
        expect(readCardSource({ store, now, who: sam }, "findings", { repo: null, task: "t-1" })).toMatchObject({ rows: [] });
      });
    });

    test("closing a finding and starting a repair stay a person's on the task, and automatic repair has no chat road", () => {
      expect(Object.keys(CHAT_ACTIONS).filter(one => /repair|close|mode_sign|auto/.test(one))).toEqual([]);
      expect(chatControlHref("findings", "t-1")).toBe("/t/t-1#findings");
    });
  });

  describe("what takes effect is on the card, and every project it touches is checked", () => {
    /** This person's chat, reaching `repos`. */
    function reaching(repos: string[]): void {
      const verified = verifyApproverStanding(store, "operator", store.accountOf("operator")!.generation, repos);
      if (!verified.ok) throw Error("identity");
      who = verified.who;
      session = store.mintLeadSession({ approver: who.name, approverGeneration: who.generation, credentialKey: "parity", ceilingMicrousd: 10_000_000, ceilingDigest: who.ceilingDigest, termsDigest: "fixture" }, now);
      thread = store.openLeadThread(who.name, who.ceilingDigest, now).thread.id;
    }
    function crossProject(): { flow: number; elsewhere: string } {
      const elsewhere = join(root, "bank");
      mkdirSync(elsewhere);
      const definition = flowFromSteps([{ title: "Update", kind: "task" }], null);
      definition.stages[0] = { ...definition.stages[0]!, repo: elsewhere } as never;
      const flow = store.createFlow({ repo, name: "Across", by: "operator", definitionJson: JSON.stringify(definition) }, now);
      const made = addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "schedule", schedule: "daily 09:00", title: "Across", description: null, zone: null }, "operator", now, null);
      if (!made.ok) throw Error(made.message);
      return { flow, elsewhere };
    }
    const termsOf = (id: number) => (store.getLeadProposal(id)!.payload as { terms: string[] }).terms.join("\n");

    test("memory_decide takes no claim, shows why, and a lesson note is never accepted from a card", () => {
      const proposal = memoryProposal();
      expect(() => prepareSharedAction(store, who, "memory_decide", { repo, proposal, decision: "accept", claim: "Words the person never saw." }, root, now)).toThrow("can't be read");
      expect(termsOf(draft("memory_decide", { repo, proposal, decision: "accept" }))).toContain("Why: Two sessions asked.");
      const { run } = stopped();
      store.handle.exec("PRAGMA foreign_keys = OFF");
      store.handle.prepare("INSERT INTO lesson_note (proposal, repo, failed_run, passing_run, identities_json, changed_paths_json, test_files_changed_json, facts_digest, created_at) VALUES (?, ?, ?, ?, '[]', '[]', '[]', 'd', ?)").run(proposal, repo, run, run + 1, now.toISOString());
      store.handle.exec("PRAGMA foreign_keys = ON");
      expect(() => prepareSharedAction(store, who, "memory_decide", { repo, proposal, decision: "accept" }, root, now)).toThrow("in your own words");
      expect(prepareSharedAction(store, who, "memory_decide", { repo, proposal, decision: "reject" }, root, now).title).toContain("Reject");
    });

    test("task_archive shows the reason it will save", () => {
      expect(termsOf(draft("task_archive", { task: "t-1", reason: "Done another way" }))).toContain("Reason: Done another way");
      expect(() => prepareSharedAction(store, who, "task_archive", { task: "t-1", reason: "bad\u0007" }, root, now)).toThrow();
    });

    test("provider_resume names the projects with work waiting, and refuses one out of reach", () => {
      const { run, ref } = stopped();
      pauseForAuth(store, { provider: "claude", authMode: null, runId: run, taskRef: ref.id, now });
      store.handle.prepare("UPDATE task_ref SET auth_wait_pause = (SELECT id FROM provider_auth_pause WHERE lifted_at IS NULL) WHERE id = ?").run(ref.id);
      expect(termsOf(draft("provider_resume", { provider: "claude" }))).toContain("Waiting work in: shop");
      store.handle.prepare("UPDATE task_ref SET repo = ? WHERE id = ?").run(join(root, "bank"), ref.id);
      expect(() => prepareSharedAction(store, who, "provider_resume", { provider: "claude" }, root, now)).toThrow("outside your access here");
    });

    test("flow_unattended names every project it files in, and refuses one out of reach", () => {
      const { flow } = crossProject();
      expect(() => prepareSharedAction(store, who, "flow_unattended", { flow, days: 3 }, root, now)).toThrow("outside your access here");
    });

    test("flow_unattended: a person's off or cap in the other project holds too", () => {
      const { flow, elsewhere } = crossProject();
      reaching([repo, elsewhere]);
      const off = draft("flow_unattended", { flow, days: 3 });
      expect(termsOf(off)).toContain("Works in: shop, bank");
      expect(setChatApproval(store, { approver: "operator", scope: elsewhere, enabled: false, via: "test" }, now).ok).toBe(true);
      expect(yes(off)).toMatchObject({ ok: false });
      expect(setChatApproval(store, { approver: "operator", scope: elsewhere, enabled: true, limits: { fullAccess: true, capMicrousd: 1_000_000 }, via: "test" }, now).ok).toBe(true);
      expect(yes(draft("flow_unattended", { flow, days: 3 }))).toMatchObject({ ok: false });
      expect(activeUnattendedGrant(store, flow, now)).toBeNull();
    });

    test("flow_unattended: an included schedule's outside-content warning is on the card", async () => {
      execFileSync("git", ["init", "-q", repo]);
      expect(saveScript(store, repo, { name: "issues", about: "Reads issues", body: "true", timeoutMinutes: 2 }, "operator", now).ok).toBe(true);
      const flow = store.createFlow({ repo, name: "Issues", by: "operator", definitionJson: JSON.stringify(flowFromSteps([{ title: "Update", kind: "task" }], null)) }, now);
      const made = addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "schedule", schedule: "daily 09:00", script: "issues" }, "operator", now, null);
      if (!made.ok) throw Error(made.message);
      await prepareUnattendedCandidates(store, flow);
      const optional = unattendedCandidates(store, flow).find(one => one.id === made.id)!.optional!;
      expect(termsOf(draft("flow_unattended", { flow, days: 3, include: [made.id] }))).toContain(optional);
    });
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
      expect(yes(resumeCard(run), via)).toMatchObject({ ok: true, said: expect.stringContaining("Stop lifted") });
      expect(store.stopOf(run)).toMatchObject({ resumedVia: via, resumedBy: expect.stringContaining("operator") });
    });

    test.each(["slack", "discord"] as const)("task_resume from %s records its own road", via => {
      const { run } = stopped();
      expect(yes(draft("task_resume", { task: "t-1", run }), via)).toMatchObject({ ok: true });
      expect(store.stopOf(run)?.resumedVia).toBe(via);
    });
  });
});
