import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { openStore, type Store } from "./store.js";
import { addApprover, propose } from "./scope.js";
import { verifyApproverStanding, type VerifiedApprover } from "./principal.js";
import { fileTaskProposal } from "./proposal.js";
import {
  executeSharedAction,
  prepareSharedAction,
  mintSharedActionReview,
  sharedActionNeedsReview,
  type ChatAction,
} from "./chat-actions.js";
import { confirmMateProposal } from "./mate-doors.js";
import { projectToolsOf } from "./project-tools.js";
import { skillsView, importSkill, changeSkills } from "./project-skills.js";
import { knowledgeView, changeKnowledge } from "./project-knowledge.js";
import { executeMateTool, MATE_TOOLS } from "./mate-tools.js";
import { flowFromSteps } from "./flows.js";
import { createDecisionServer } from "./serve.js";
import { requestTaskStop } from "./task-control.js";
import { register } from "./runner.js";
import { acquire, finalizeInterruptedFenced } from "./claim.js";
import { approve } from "./scope.js";
import { storeEvidence } from "./evidence.js";
import { assignmentOf } from "./assignment.js";
import { routinesOf } from "./teammate-desk.js";
const bareLegacy = (
  phase: "build",
  provider: string,
  model: string | null,
) => ({
  route: {
    routeDigest: "legacy",
    phase,
    provider,
    model,
    chosen: "legacy" as const,
  },
});

describe("shared chat action lifecycle", () => {
  let root: string,
    repo: string,
    db: string,
    store: Store,
    who: VerifiedApprover,
    password: string,
    thread: number,
    session: number;
  const now = new Date("2026-09-17T12:00:00Z");
  let serial = 0;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "shared-chat-")));
    repo = join(root, "repo");
    db = join(root, "state.db");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "README.md"), "Action tests\n");
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", [
      "-C",
      repo,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@localhost",
      "commit",
      "-qm",
      "seed",
    ]);
    store = openStore(db);
    const account = addApprover(store, "operator", now);
    if (!account.ok) throw Error("account");
    password = account.token;
    for (const phase of ["plan", "build", "review"] as const)
      store.setPhaseConfig(
        "installation",
        phase,
        "claude",
        "sonnet",
        "fixture",
        now,
      );
    const verified = verifyApproverStanding(
      store,
      "operator",
      store.accountOf("operator")!.generation,
      [repo],
    );
    if (!verified.ok) throw Error("identity");
    who = verified.who;
    session = store.mintMateSession(
      {
        approver: who.name,
        approverGeneration: who.generation,
        credentialKey: "shared-fixture",
        ceilingMicrousd: 10000000,
        ceilingDigest: who.ceilingDigest,
        termsDigest: "fixture",
      },
      now,
    );
    thread = store.openMateThread(who.name, who.ceilingDigest, now).thread.id;
  });
  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  function task() {
    const id = `action-${++serial}`;
    const made = fileTaskProposal(
      store,
      {
        id,
        title: "Make acceptance clearer",
        repo,
        filedVia: "cli",
        planning: "skip",
      },
      now,
    );
    if (!made.ok) throw Error(made.message);
    return id;
  }
  function proposal(operation: ChatAction, input: Record<string, unknown>) {
    const payload = prepareSharedAction(
      store,
      who,
      operation,
      input,
      root,
      now,
    );
    const turn = store.openMateTurn(
      {
        approver: who.name,
        session,
        thread,
        credentialKey: "shared-fixture",
        reservedMicrousd: 0,
        dailyTurns: 100,
        weeklyCeilingMicrousd: 10000000,
        deadlineMs: 60000,
      },
      now,
    );
    if (!turn.ok) throw Error(turn.reason);
    const started = store.startMateTurn(turn.id, now);
    if (!started.ok) throw Error("start");
    const id = store.draftMateProposal(
      {
        thread,
        turn: turn.id,
        kind: "action",
        payload: { ...payload },
        ceilingDigest: who.ceilingDigest,
      },
      now,
    );
    store.finalizeMateTurn(
      turn.id,
      started.generation,
      {
        state: "answered",
        settledMicrousd: 0,
        tokensIn: 0,
        tokensOut: 0,
        message: { text: "Review the proposed action.", activity: "" },
      },
      now,
    );
    return id;
  }
  function confirm(id: number, secure = false, credential = password) {
    const review = secure
      ? mintSharedActionReview(store, who, id, root, now)
      : null;
    return confirmMateProposal(store, who, id, now, {
      via: secure ? "web" : "telegram",
      evidenceRoot: root,
      ...(review
        ? {
            confirm: true,
            actionReview: { nonce: review.nonce, password: credential },
          }
        : {}),
    });
  }
  test("the lead proposes a project tool as a card that needs the password screen; removal is an ordinary card", () => {
    const add = proposal("tool_add", { repo, catalog: "github" });
    const saved = store.getMateProposal(add)!.payload as { title: string; terms: string[] };
    expect(saved.title).toBe(`Add github to ${repo.split("/").at(-1)}`);
    expect(saved.terms.join("\n")).toContain("Starts: https://api.githubcopilot.com/mcp/ (signs in with GITHUB_TOKEN)");
    expect(saved.terms.join("\n")).toContain("Needs GITHUB_TOKEN. Set it on the Tools page after adding, never in chat.");
    // A phone or chat tap is not enough: the secure screen and the password are.
    expect(confirm(add)).toMatchObject({ ok: false, reason: "needs-confirm" });
    expect(projectToolsOf(store, repo)).toEqual([]);
    expect(confirm(add, true, "wrong")).toMatchObject({ ok: false });
    const again = proposal("tool_add", { repo, catalog: "github" });
    expect(confirm(again, true)).toMatchObject({ ok: true });
    expect(projectToolsOf(store, repo).map(one => [one.name, one.source])).toEqual([["github", "the common tools list"]]);
    // The lead's own command is checked and rewritten to exactly what was reviewed.
    const custom = prepareSharedAction(store, who, "tool_add", { repo, name: "db", command: "npx", args: ["-y", "some-db-mcp@1.2.3"], secrets: ["DATABASE_URL"] }, root, now);
    expect(custom.request).toMatchObject({ name: "db", command: "npx", args: ["-y", "some-db-mcp@1.2.3"], secrets: ["DATABASE_URL"] });
    expect(() => prepareSharedAction(store, who, "tool_add", { repo, catalog: "nope" }, root, now)).toThrow(/common list/);
    expect(() => prepareSharedAction(store, who, "tool_add", { repo, catalog: "github" }, root, now)).toThrow(/already has a tool called github/);
    const remove = proposal("tool_remove", { repo, name: "github" });
    expect(confirm(remove)).toMatchObject({ ok: true, said: "Tool removed from every build." });
    expect(projectToolsOf(store, repo)).toEqual([]);
  });
  test("a flow card note from chat is taken whole up to 4,000 characters; over it is refused with its length, never cut", () => {
    const flow = store.createFlow({ repo, name: "Support", by: who.name, definitionJson: JSON.stringify(flowFromSteps([
      { title: "Inbox", kind: "inbox" },
      { id: "draft", title: "Write the reply", kind: "draft", instructions: "Reply to {{card.title}}" },
      { id: "check", title: "Check the reply", kind: "approval", decider: "owner", ifFails: "Write the reply" },
    ], null)) }, now);
    const card = store.addFlowCard({ flow, title: "Refund for order 42?", description: null, stage: "check", by: who.name }, now);
    const note = "Mention the 5-day wait. ".repeat(200).slice(0, 4_000);
    expect(prepareSharedAction(store, who, "flow_card_send_back", { card, note }, root, now).request).toMatchObject({ note: note.trim() });
    expect(() => prepareSharedAction(store, who, "flow_card_send_back", { card, note: `${note}!` }, root, now)).toThrow("The note is 4,001 characters; the limit is 4,000. Shorten it and propose again.");
    // The chat tools state the same limit they are held to.
    for (const name of ["propose_action", "propose_flow"]) expect(MATE_TOOLS.find(one => one.name === name)!.inputSchema).toMatchObject({ properties: { note: { maxLength: 4_000, description: expect.stringContaining("At most 4000 characters") } } });
  });

  test("the lead lets a teammate use a tool and sets one action's rule, each as a card; a card drafted before a change is refused (v94)", () => {
    const mate = store.createTeammate({ repo, handle: "maya", soul: "---\nname: Maya\nrole: Support\n---\n## Who you are\nHelpful.\n", model: null, manager: who.name, by: who.name }, now);
    expect(confirm(proposal("tool_add", { repo, catalog: "github" }), true)).toMatchObject({ ok: true });
    expect(() => prepareSharedAction(store, who, "teammate_tools", { teammate: mate, tool: "github", change: "grant" }, root, now)).toThrow("github hasn't said what it can do yet. Test it on the Tools page first.");
    store.recordProjectToolTest(repo, "github", JSON.stringify({ at: now.toISOString(), ok: true, tools: ["list_issues", "create_issue"], problem: null }));
    const grant = proposal("teammate_tools", { teammate: mate, tool: "github", change: "grant" });
    expect(store.getMateProposal(grant)!.payload).toMatchObject({ title: "Let Maya use github", terms: expect.arrayContaining(["list_issues: does it", "create_issue: asks you first"]) });
    const stale = proposal("teammate_tools", { teammate: mate, tool: "github", change: "grant" });
    expect(confirm(grant)).toMatchObject({ ok: true });
    expect(store.teammateGrant(mate, "github")?.rules).toEqual({ list_issues: { use: "free" }, create_issue: { use: "ask" } });
    expect(confirm(stale)).toMatchObject({ ok: false });
    expect(() => prepareSharedAction(store, who, "teammate_tools", { teammate: mate, tool: "github", change: "rule", action: "delete_repo", use: "free" }, root, now)).toThrow("github has no action called delete_repo. Its actions: list_issues, create_issue.");
    const rule = proposal("teammate_tools", { teammate: mate, tool: "github", change: "rule", action: "create_issue", use: "never" });
    expect(store.getMateProposal(rule)!.payload).toMatchObject({ title: "Maya: create_issue — never" });
    expect(confirm(rule)).toMatchObject({ ok: true });
    expect(store.teammateGrant(mate, "github")?.rules["create_issue"]).toEqual({ use: "never" });
    // The lead names the action where the tool goes, or both at once: either is read as github's create_issue.
    const drafted: Record<string, unknown>[] = [];
    const ctx = { store, who, now, step: 1, readDecisions: new Map<number, number>(), evidenceRoot: root, draft: (_kind: unknown, payload: Record<string, unknown>) => { drafted.push(payload); return drafted.length; } };
    for (const named of [{ tool: "create_issue" }, { tool: "github.create_issue" }, { tool: "github", action: "github.create_issue" }]) {
      expect(executeMateTool(ctx, "propose_teammate", { operation: "tool_rule", teammate: mate, ...named, use: "ask" })).toMatchObject({ ok: true });
      expect(drafted.at(-1)).toMatchObject({ title: "Maya: create_issue — a person approves each call first" });
    }
    expect(executeMateTool(ctx, "propose_teammate", { operation: "tool_rule", teammate: mate, tool: "jira", action: "create_issue", use: "ask" })).toMatchObject({ ok: false, message: "Maya doesn't use a tool called jira. Maya uses github (actions: list_issues, create_issue)." });
    expect(confirm(proposal("teammate_tools", { teammate: mate, tool: "github", change: "revoke" }))).toMatchObject({ ok: true });
    expect(store.teammateGrants(mate)).toEqual([]);
  });
  test("the lead tells a teammate something, fixes what it remembers and has it forget, each as a card; a card drafted before a change is refused (v95)", () => {
    const mate = store.createTeammate({ repo, handle: "maya", soul: "---\nname: Maya\nrole: Support\n---\n## Who you are\nHelpful.\n", model: null, manager: who.name, by: who.name }, now);
    expect(confirm(proposal("teammate_note", { teammate: mate, note: "Offer free shipping this week." }))).toMatchObject({ ok: true });
    const [told] = store.teammateMemories(mate);
    expect(told).toMatchObject({ source: "person", text: "Offer free shipping this week.", createdBy: who.name });
    expect(() => prepareSharedAction(store, who, "teammate_note", { teammate: mate, note: "x".repeat(301) }, root, now)).toThrow("Keep a memory to 300 characters");
    const edit = proposal("teammate_memory", { teammate: mate, memory: told!.id, change: "edit", text: "Offer free shipping until Sunday." });
    expect(store.getMateProposal(edit)!.payload).toMatchObject({ title: "Change what Maya remembers", terms: ["Was: Offer free shipping this week.", "Now: Offer free shipping until Sunday."] });
    const forget = proposal("teammate_memory", { teammate: mate, memory: told!.id, change: "forget" });
    expect(confirm(edit)).toMatchObject({ ok: true });
    expect(store.teammateMemory(told!.id)?.text).toBe("Offer free shipping until Sunday.");
    expect(confirm(forget)).toMatchObject({ ok: false });
    expect(confirm(proposal("teammate_memory", { teammate: mate, memory: told!.id, change: "forget" }))).toMatchObject({ ok: true });
    expect(store.teammateMemories(mate)).toEqual([]);
  });
  test("the lead asks to undo a teammate's call only where its action has an undo; the worker makes it (v97)", () => {
    const mate = store.createTeammate({ repo, handle: "maya", soul: "---\nname: Maya\nrole: Support\n---\n## Who you are\nHelpful.\n", model: null, manager: who.name, by: who.name }, now);
    const flow = store.createFlow({ repo, name: "Support", definitionJson: JSON.stringify({ version: 1, start: "inbox", stages: [{ id: "inbox", title: "Inbox", kind: "inbox", zone: {}, next: null, onFail: null }] }), by: who.name }, now);
    const card = store.addFlowCard({ flow, title: "Label it", description: null, stage: "inbox", by: who.name }, now);
    const call = store.addTeammateCall({ teammate: mate, card, entry: 1, tool: "desk", action: "add_label", input: { ticket: "T-1", label: "urgent" }, rule: "free", why: "Urgent.", state: "done", result: "added" }, now);
    expect(() => prepareSharedAction(store, who, "teammate_undo", { teammate: mate, call }, root, now)).toThrow("its action has no undo set");
    store.saveTeammateGrant({ teammate: mate, tool: "desk", actions: [{ name: "add_label", about: "", input: null, readOnly: false }, { name: "remove_label", about: "", input: null, readOnly: false }],
      rules: { add_label: { use: "free", undo: "remove_label" }, remove_label: { use: "never" } } }, who.name, now);
    const undo = proposal("teammate_undo", { teammate: mate, call });
    expect(store.getMateProposal(undo)!.payload).toMatchObject({ title: "Undo Maya's add_label", terms: expect.arrayContaining(["By calling: desk → remove_label · ticket T-1 · label urgent"]) });
    expect(confirm(undo)).toMatchObject({ ok: true });
    expect(store.pendingTeammateUndos().map(one => [one.action, one.undoOf, one.decidedBy])).toEqual([["remove_label", call, who.name]]);
    expect(store.teammateCall(call)?.undoneBy).toBe(who.name);
  });
  test("the lead sets a starter kit up as one card: its teammate, its flow and its buttons; a second card is refused", () => {
    expect(() => prepareSharedAction(store, who, "kit_setup", { repo, kit: "nope" }, root, now)).toThrow("Choose a kit");
    const card = proposal("kit_setup", { repo, kit: "ops-requests" });
    expect(store.getMateProposal(card)!.payload).toMatchObject({ title: `Set up Ops requests in ${repo.split("/").at(-1)}`, terms: expect.arrayContaining([expect.stringContaining("Adds Ada (ops coordinator) and the Ops requests flow with its “Ask for something” button.")]) });
    expect(confirm(card)).toMatchObject({ ok: true, said: expect.stringContaining("Ops requests is ready") });
    expect(store.teammateByHandle(repo, "ada")).not.toBeNull();
    expect(store.listFlows([repo]).map(one => one.name)).toEqual(["Ops requests"]);
    expect(() => prepareSharedAction(store, who, "kit_setup", { repo, kit: "ops-requests" }, root, now)).toThrow("Ops requests is already set up");
  });
  test("the lead gives a teammate a routine and stops it, each as a card (v96)", () => {
    const mate = store.createTeammate({ repo, handle: "maya", soul: "---\nname: Maya\nrole: Support\n---\n## Who you are\nHelpful.\n", model: null, manager: who.name, by: who.name }, now);
    expect(() => prepareSharedAction(store, who, "teammate_routine", { teammate: mate, change: "add", schedule: "now and then", text: "Count refunds" }, root, now)).toThrow("Say the schedule like");
    const add = proposal("teammate_routine", { teammate: mate, change: "add", schedule: "weekdays 09:00 UTC", text: "Count yesterday's refunds" });
    expect(store.getMateProposal(add)!.payload).toMatchObject({ title: "Maya: Count yesterday's refunds", terms: expect.arrayContaining(["When: weekdays at 09:00 UTC", "What: Count yesterday's refunds"]) });
    expect(confirm(add)).toMatchObject({ ok: true });
    const [routine] = routinesOf(store, store.getTeammate(mate)!);
    expect(routine).toMatchObject({ schedule: "weekdays:09:00", text: "Count yesterday's refunds" });
    expect(confirm(proposal("teammate_routine", { teammate: mate, change: "remove", routine: routine!.id }))).toMatchObject({ ok: true });
    expect(routinesOf(store, store.getTeammate(mate)!)).toEqual([]);
  });
  function skill() {
    return importSkill(
      store,
      repo,
      who.name,
      [
        {
          path: "SKILL.md",
          base64: Buffer.from(
            "---\nname: clear-copy\ndescription: Review short interface labels.\n---\nUse plain English.\n",
          ).toString("base64"),
        },
      ],
      "Test fixture",
      now,
    );
  }
  function result(id: string) {
    const run = store.startRun({
      taskRef: store.lookupRef(id)!.id,
      leaseId: "fixture",
      runner: "fixture",
      branch: "fixture",
      worktree: repo,
      ...bareLegacy("build", "claude", null),
      now,
    });
    store.finishRun(run, {
      outcome: "built",
      headRevision: "a".repeat(40),
      now,
    });
    return run;
  }
  test("chat enables and disables the exact library version; a duplicate confirm changes nothing", () => {
    const saved = skill(),
      id = proposal("skill_enable", { repo, version: saved.sha.slice(0, 20) });
    expect(confirm(id)).toMatchObject({ ok: true });
    expect(
      skillsView(store, repo, who.name).selection[saved.name]?.enabled,
    ).toBe(true);
    expect(confirm(id)).toMatchObject({ ok: false, reason: "not-pending" });
    expect(skillsView(store, repo, who.name).revision).toBe(1);
    expect(
      confirm(proposal("skill_disable", { repo, version: saved.sha })),
    ).toMatchObject({ ok: true });
    expect(
      skillsView(store, repo, who.name).selection[saved.name]?.enabled,
    ).toBe(false);
  });
  test("a skills change made in the console invalidates a pending chat action", () => {
    const saved = skill(),
      id = proposal("skill_enable", { repo, version: saved.sha }),
      view = skillsView(store, repo, who.name);
    changeSkills(
      store,
      {
        repo,
        actor: who.name,
        identity: view.identity,
        revision: view.revision,
        action: "enable",
        sha: saved.sha,
      },
      now,
    );
    expect(confirm(id)).toMatchObject({ ok: false, reason: "stale" });
    expect(skillsView(store, repo, who.name).revision).toBe(1);
  });
  test("imports review complete instructions and do not enable them implicitly", () => {
    const id = proposal("skill_import", {
      repo,
      content:
        "---\nname: careful-review\ndescription: Review acceptance evidence.\n---\nCheck every requirement.\n",
    });
    expect(confirm(id)).toMatchObject({ ok: false, reason: "needs-confirm" });
    expect(confirm(id, true)).toMatchObject({ ok: true });
    expect(skillsView(store, repo, who.name).library).toHaveLength(1);
    expect(skillsView(store, repo, who.name).selection).toEqual({});
  });
  test("a skill test creates one real task under the normal approval rules", () => {
    const saved = skill(),
      id = proposal("skill_test", {
        repo,
        version: saved.sha,
        sample: "Review the Save button label.",
        nonce: randomUUID(),
      });
    const outcome = confirm(id);
    expect(outcome).toMatchObject({ ok: true });
    if (!outcome.ok) throw Error("confirm");
    expect(store.getTask(outcome.taskId!)?.title).toBe("Test clear-copy");
    expect(confirm(id).ok).toBe(false);
    expect(
      store.handle.prepare("SELECT COUNT(*) AS n FROM skill_test").get()?.["n"],
    ).toBe(1);
  });
  test("knowledge saved through chat is visible in the existing project view and can be removed", () => {
    expect(
      confirm(
        proposal("knowledge_save", {
          repo,
          title: "Acceptance wording",
          content: "Use short labels and show remaining checks.",
        }),
      ),
    ).toMatchObject({ ok: true });
    const reference = knowledgeView(store, repo, who.name).knowledge
      .references[0]!;
    expect(reference.content).toContain("remaining checks");
    expect(
      confirm(proposal("knowledge_remove", { repo, id: reference.id })),
    ).toMatchObject({ ok: true });
    expect(knowledgeView(store, repo, who.name).knowledge.references).toEqual(
      [],
    );
  });
  test("long knowledge requires full review and cannot be confirmed from a shortened chat card", () => {
    const instructions = "Check alignment and readable labels. ".repeat(60),
      id = proposal("knowledge_instructions", { repo, instructions });
    expect(
      sharedActionNeedsReview(
        prepareSharedAction(
          store,
          who,
          "knowledge_instructions",
          { repo, instructions },
          root,
          now,
        ),
      ),
    ).toBe(true);
    expect(confirm(id)).toMatchObject({ ok: false, reason: "needs-confirm" });
    const review = mintSharedActionReview(store, who, id, root, now);
    expect(review.payload.terms.join("\n")).toContain(instructions);
    expect(
      confirmMateProposal(store, who, id, now, {
        via: "web",
        evidenceRoot: root,
        confirm: true,
        actionReview: { nonce: review.nonce, password: "" },
      }),
    ).toMatchObject({ ok: true });
  });
  test("a knowledge revision prevents overwriting changes made after preview", () => {
    const id = proposal("knowledge_instructions", {
        repo,
        instructions: "First draft",
      }),
      view = knowledgeView(store, repo, who.name);
    changeKnowledge(
      store,
      {
        repo,
        actor: who.name,
        identity: view.identity,
        revision: view.revision,
        action: "instructions",
        draft: { instructions: "Newer saved draft" },
      },
      now,
    );
    expect(confirm(id)).toMatchObject({ ok: false, reason: "stale" });
    expect(knowledgeView(store, repo, who.name).knowledge.instructions).toBe(
      "Newer saved draft",
    );
  });
  test("scope approval requires password and full review, then seals the exact scope", () => {
    const id = task();
    propose(store, {
      now,
      taskId: id,
      goal: "Make result acceptance easier to understand.",
    });
    const action = proposal("scope_approve", { task: id });
    expect(confirm(action)).toMatchObject({
      ok: false,
      reason: "needs-confirm",
    });
    expect(confirm(action, true, "incorrect")).toMatchObject({
      ok: false,
      reason: "needs-confirm",
    });
    expect(store.getScope(id)?.approvedDigest).toBeNull();
    expect(confirm(action, true)).toMatchObject({ ok: true });
    expect(store.getScope(id)?.approvedDigest).toBe(store.getScope(id)?.digest);
  });
  test("editing the scope after review prevents approving a different plan", () => {
    const id = task();
    propose(store, { now, taskId: id, goal: "First scope" });
    const action = proposal("scope_approve", { task: id }),
      review = mintSharedActionReview(store, who, action, root, now);
    propose(store, { now, taskId: id, goal: "Different scope" });
    expect(
      confirmMateProposal(store, who, action, now, {
        via: "web",
        evidenceRoot: root,
        confirm: true,
        actionReview: { nonce: review.nonce, password },
      }),
    ).toMatchObject({ ok: false, reason: "stale" });
    expect(store.getScope(id)?.approvedDigest).toBeNull();
  });
  /** A Ready result: approved scope, a finished builder attempt stamped with
   * that scope and a recorded head, and the task marked done. */
  function ready(id: string) {
    propose(store, { now, taskId: id, goal: "Make acceptance clearer" });
    const scope = store.getScope(id)!;
    const approved = approve(store, id, who.name, now, scope.digest, password);
    if (!approved.ok) throw Error(approved.reason);
    const run = attempt(id, scope.digest);
    store.setTaskState(id, "done", now);
    return run;
  }
  /** One finished builder attempt on an approved task, stamped with its scope and a recorded head. */
  function attempt(id: string, scopeDigest: string) {
    const ref = store.lookupRef(id)!.id;
    const authority = store.routeAuthorityFor(ref, "builder");
    if (!authority?.ok) throw Error("route fixture");
    const run = store.startRun({ taskRef: ref, leaseId: `ready-${id}-${++serial}`, runner: "fixture", branch: "fixture", worktree: repo, route: authority.stamp, now });
    store.stampRun(run, { scopeDigest, baseRevision: "b".repeat(40) });
    store.recordOutcomeFacts(run, { headRevision: "a".repeat(40), handoff: "Done." });
    store.finishRun(run, { outcome: "built", committed: true, now });
    return run;
  }
  const assignment = (id: string) => assignmentOf(store, id, now, { principal: "operator", repos: [repo] }, root);
  test("marking complete from the phone asks once more, records the assignment check for the exact result and never changes the recorded checks", () => {
    const id = task(),
      run = ready(id);
    expect(assignment(id)?.state).toBe("ready-to-check");
    const action = proposal("result_accept", { task: id, run });
    expect(store.getMateProposal(action)?.payload["terms"]).toEqual(expect.arrayContaining([expect.stringContaining("Marks this exact result complete")]));
    expect(confirm(action)).toMatchObject({ ok: false, reason: "needs-confirm" });
    expect(assignment(id)?.state).toBe("ready-to-check");
    const before = store.proofVerdictFor(run);
    expect(confirmMateProposal(store, who, action, now, { via: "telegram", evidenceRoot: root, confirm: true })).toMatchObject({ ok: true, said: "Accepted and finished. The recorded checks are unchanged." });
    expect(assignment(id)).toMatchObject({ state: "complete", completion: { actor: "operator:operator" } });
    expect(store.proofVerdictFor(run)).toEqual(before);
    expect(store.proofAcceptance(run)).toBeNull();
    expect(confirm(action)).toMatchObject({ ok: false, reason: "not-pending" });
  });
  test("the secure console screen still marks a result complete, and a cancel never gets the phone challenge", () => {
    const id = task(),
      run = ready(id),
      action = proposal("result_accept", { task: id, run });
    expect(confirm(action, true)).toMatchObject({ ok: true });
    expect(assignment(id)?.state).toBe("complete");
    expect(() => proposal("result_accept", { task: id, run })).toThrow("already marked complete");
    const other = task(),
      cancel = proposal("task_cancel", { task: other });
    expect(confirmMateProposal(store, who, cancel, now, { via: "telegram", evidenceRoot: root, confirm: true })).toMatchObject({ ok: false, reason: "needs-confirm" });
    expect(store.getTask(other)?.state).not.toBe("cancelled");
  });
  test("a successor result invalidates completion, without completing either run", () => {
    const id = task(),
      run = ready(id),
      action = proposal("result_accept", { task: id, run }),
      review = mintSharedActionReview(store, who, action, root, now),
      next = attempt(id, store.getScope(id)!.digest);
    expect(
      confirmMateProposal(store, who, action, now, {
        via: "web",
        evidenceRoot: root,
        confirm: true,
        actionReview: { nonce: review.nonce, password: "" },
      }),
    ).toMatchObject({ ok: false, reason: "stale" });
    expect(assignment(id)?.state).not.toBe("complete");
    expect(store.proofAcceptance(run)).toBeNull();
    expect(store.proofAcceptance(next)).toBeNull();
    expect(store.getMateProposal(action)?.state).toBe("refused");
  });
  test("cancel requires an exact one-use review and preserves the task record", () => {
    const id = task(),
      action = proposal("task_cancel", { task: id });
    expect(confirm(action)).toMatchObject({
      ok: false,
      reason: "needs-confirm",
    });
    expect(confirm(action, true)).toMatchObject({ ok: true });
    expect(store.getTask(id)?.state).toBe("cancelled");
    expect(confirm(action)).toMatchObject({ ok: false, reason: "not-pending" });
  });
  test("review receipts cannot be reused for another proposal", () => {
    const one = proposal("task_cancel", { task: task() }),
      two = proposal("task_cancel", { task: task() }),
      review = mintSharedActionReview(store, who, one, root, now);
    expect(
      confirmMateProposal(store, who, two, now, {
        via: "web",
        evidenceRoot: root,
        confirm: true,
        actionReview: { nonce: review.nonce, password: "" },
      }),
    ).toMatchObject({ ok: false, reason: "needs-confirm" });
    expect(store.getMateProposal(two)?.state).toBe("pending");
  });
  test("review receipts expire and a recreated process retains pending actions", () => {
    const action = proposal("task_cancel", { task: task() }),
      review = mintSharedActionReview(store, who, action, root, now);
    store.close();
    store = openStore(db);
    expect(
      confirmMateProposal(
        store,
        who,
        action,
        new Date(now.getTime() + 11 * 60_000),
        {
          via: "web",
          evidenceRoot: root,
          confirm: true,
          actionReview: { nonce: review.nonce, password: "" },
        },
      ),
    ).toMatchObject({ ok: false, reason: "needs-confirm" });
    expect(store.getMateProposal(action)?.state).toBe("pending");
  });
  test("forged principals and changed credential generations cannot change projects", () => {
    expect(() =>
      prepareSharedAction(
        store,
        { ...who } as VerifiedApprover,
        "knowledge_instructions",
        { repo, instructions: "forged" },
        root,
        now,
      ),
    ).toThrow(/access/);
    const action = proposal("knowledge_instructions", {
      repo,
      instructions: "pending",
    });
    store.saveApprover(who.name, "new-credential-hash", now);
    expect(confirm(action)).toMatchObject({ ok: false, reason: "standing" });
    expect(knowledgeView(store, repo, who.name).revision).toBe(0);
  });

  test("restoring skills shows the exact selection and preserves the version history", () => {
    const saved = skill();
    expect(
      confirm(proposal("skill_enable", { repo, version: saved.sha })).ok,
    ).toBe(true);
    expect(
      confirm(proposal("skill_disable", { repo, version: saved.sha })).ok,
    ).toBe(true);
    const action = proposal("skill_restore", { repo, restore: 1 });
    expect(JSON.stringify(store.getMateProposal(action)?.payload)).toContain(
      saved.sha,
    );
    expect(confirm(action)).toMatchObject({
      ok: false,
      reason: "needs-confirm",
    });
    expect(confirm(action, true).ok).toBe(true);
    expect(
      skillsView(store, repo, who.name).selection[saved.name]?.enabled,
    ).toBe(true);
    expect(skillsView(store, repo, who.name).revision).toBe(3);
  });
  test("restoring knowledge shows the saved content and uses the existing history", () => {
    expect(
      confirm(
        proposal("knowledge_instructions", {
          repo,
          instructions: "Short titles first.",
        }),
      ).ok,
    ).toBe(true);
    expect(
      confirm(
        proposal("knowledge_instructions", {
          repo,
          instructions: "Second version.",
        }),
      ).ok,
    ).toBe(true);
    const action = proposal("knowledge_restore", { repo, restore: 1 });
    expect(JSON.stringify(store.getMateProposal(action)?.payload)).toContain(
      "Short titles first.",
    );
    expect(confirm(action).ok).toBe(true);
    expect(knowledgeView(store, repo, who.name).knowledge.instructions).toBe(
      "Short titles first.",
    );
  });
  test("a request for review queues once through the normal review service", () => {
    const id = task();
    propose(store, {
      taskId: id,
      goal: "Test the shared review request.",
      now,
    });
    const scope = store.getScope(id)!;
    expect(approve(store, id, who.name, now, scope.digest, password).ok).toBe(
      true,
    );
    const ref = store.lookupRef(id)!,
      route = store.routeAuthorityFor(ref.id, "builder", null);
    if (!route?.ok) throw Error("route");
    const run = store.startRun({
      taskRef: ref.id,
      leaseId: "review-fixture",
      runner: "fixture",
      branch: "fixture",
      worktree: repo,
      route: route.stamp,
      now,
    });
    store.stampRun(run, { scopeDigest: scope.digest });
    store.finishRun(run, {
      outcome: "built",
      headRevision: "b".repeat(40),
      now,
    });
    storeEvidence(
      store,
      root,
      run,
      "terminal-diff",
      "change.patch",
      Buffer.from("diff --git a/README.md b/README.md\n+clear label\n"),
      "synthetic diff",
      now,
      { captureStatus: "ok" },
    );
    expect(() => proposal("result_review" as never, { task: id, run })).toThrow("Choose an available action.");
    expect(
      store.handle
        .prepare("SELECT COUNT(*) AS n FROM review_request WHERE run=?")
        .get(run)?.["n"],
    ).toBe(0);
  });
  test("resume releases only the settled stop and leaves other holds in place", () => {
    const id = task();
    propose(store, { taskId: id, goal: "Resume a preserved draft.", now });
    const scope = store.getScope(id)!;
    expect(approve(store, id, who.name, now, scope.digest, password).ok).toBe(
      true,
    );
    const approvedScope = store.getScope(id);
    register(store, {
      name: "worker",
      host: "test",
      capacity: 1,
      repos: [repo],
      now,
      newToken: () => "test-runner",
    });
    const ref = store.lookupRef(id)!,
      claim = acquire(store, ref.id, "worker", {
        token: "test-runner",
        now,
        newLeaseId: () => "resume-fixture",
      });
    if (!claim.ok) throw Error(claim.reason);
    const route = store.routeAuthorityFor(ref.id, "builder", null);
    if (!route?.ok) throw Error("route");
    const run = store.startRun({
      taskRef: ref.id,
      leaseId: claim.claim.leaseId,
      runner: "worker",
      branch: "fixture",
      worktree: repo,
      route: route.stamp,
      now,
    });
    expect(
      requestTaskStop(
        store,
        { taskId: id, runId: run, by: who.name, via: "web" },
        now,
      ).ok,
    ).toBe(true);
    expect(() => proposal("task_resume", { task: id, run })).toThrow(
      /not ready/,
    );
    finalizeInterruptedFenced(store, {
      leaseId: claim.claim.leaseId,
      runId: run,
      taskId: id,
      stopRun: run,
      now,
    });
    store.hold(ref.id, "Operator is checking the draft.", null, now);
    const action = proposal("task_resume", { task: id, run });
    expect(confirm(action, true)).toMatchObject({
      ok: true,
      said: expect.stringContaining("Other requirements"),
    });
    expect(store.stopOf(run)?.resumedBy).toBe(who.name);
    expect(store.activeHolds(ref.id, now).map((one) => one.ownerKind)).toEqual([
      "operator",
    ]);
    expect(store.getScope(id)).toEqual(approvedScope);
  });
  test("a damaged plan cannot be approved, even after its review was opened", () => {
    const id = task(),
      ref = store.lookupRef(id)!;
    const run = store.startRun({
      taskRef: ref.id,
      leaseId: "plan-fixture",
      runner: "fixture",
      role: "planner",
      branch: "fixture",
      worktree: repo,
      route: {
        routeDigest: "legacy",
        phase: "plan",
        provider: "claude",
        model: null,
        chosen: "legacy",
      },
      now,
    });
    store.finishRun(run, { outcome: "no-change", now });
    propose(store, {
      taskId: id,
      goal: "Review the complete saved plan.",
      now,
    });
    const artifact = storeEvidence(
      store,
      root,
      run,
      "plan",
      "plan.md",
      Buffer.from("Use one clear approval action."),
      "synthetic plan",
      now,
    );
    store.setPlanState(ref.id, "drafted");
    const action = proposal("scope_approve", { task: id }),
      review = mintSharedActionReview(store, who, action, root, now);
    writeFileSync(
      join(root, store.getArtifact(artifact)!.key),
      "Different plan",
    );
    expect(
      confirmMateProposal(store, who, action, now, {
        via: "web",
        evidenceRoot: root,
        confirm: true,
        actionReview: { nonce: review.nonce, password },
      }),
    ).toMatchObject({ ok: false, reason: "stale" });
    expect(store.getScope(id)?.approvedDigest).toBeNull();
  });
  test("the execution primitive refuses unsaved payloads and an ended conversation", () => {
    const input = { repo, instructions: "Use readable labels." },
      payload = prepareSharedAction(
        store,
        who,
        "knowledge_instructions",
        input,
        root,
        now,
      );
    expect(
      executeSharedAction(store, who, 999, payload, now, { via: "telegram" })
        .ok,
    ).toBe(false);
    const id = proposal("knowledge_instructions", input);
    expect(
      executeSharedAction(store, who, id, payload, now, { via: "telegram" }).ok,
    ).toBe(false);
    store.endMateSessionsFor(who.name, who.name, now);
    expect(confirm(id)).toMatchObject({ ok: false, reason: "session-ended" });
    expect(knowledgeView(store, repo, who.name).revision).toBe(0);
  });
  test("an action cannot silently ignore fields that belong to a different operation", () => {
    const saved = skill();
    expect(() =>
      prepareSharedAction(
        store,
        who,
        "skill_enable",
        { repo, version: saved.sha, restore: 1 },
        root,
        now,
      ),
    ).toThrow("This action can't be read — payload: unknown key 'restore'.");
    expect(() =>
      prepareSharedAction(
        store,
        who,
        "task_cancel",
        { task: task(), run: 1 },
        root,
        now,
      ),
    ).toThrow("payload: unknown key 'run'");
  });
  test.each([false, true])("secure HTTP review preserves owner, CSRF and receipt checks (All projects: %s)", async (multiple) => {
    const repos = [repo];
    if (multiple) {
      const second = join(root, "second-project");
      mkdirSync(second);
      repos.push(second);
      const verified = verifyApproverStanding(store, who.name, who.generation, repos);
      if (!verified.ok) throw Error("identity");
      who = verified.who;
      session = store.mintMateSession({ approver: who.name, approverGeneration: who.generation, credentialKey: "shared-fixture", ceilingMicrousd: 10000000, ceilingDigest: who.ceilingDigest, termsDigest: "fixture" }, now);
      thread = store.openMateThread(who.name, who.ceilingDigest, now).thread.id;
    }
    const id = task(),
      action = proposal("task_cancel", { task: id });
    const server = createDecisionServer({
      store,
      evidenceRoot: root,
      repos,
      clock: () => now,
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (typeof address !== "object" || !address) throw Error("server");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const login = await fetch(base + "/login", {
          method: "POST",
          body: new URLSearchParams({ name: who.name, token: password }),
          redirect: "manual",
        }),
        cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      expect(
        (await fetch(base + `/chat/action/${action}`, { redirect: "manual" }))
          .status,
      ).toBe(303);
      const response = await fetch(base + `/chat/action/${action}`, {
          headers: { cookie },
          redirect: "manual",
        }),
        html = await response.text();
      expect(response.status).toBe(200);
      expect((await fetch(base + "/chat/action/999999", { headers: { cookie }, redirect: "manual" })).status).toBe(409);
      expect(html).toContain("I confirm this exact action");
      expect(html).not.toContain('type="password"');
      const nonce = /name="nonce" value="([^"]+)"/.exec(html)![1]!,
        csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
      const post = (fields: Record<string, string>, origin = base) =>
        fetch(base + `/chat/proposal/${action}/confirm`, {
          method: "POST",
          headers: { cookie, origin },
          body: new URLSearchParams(fields),
          redirect: "manual",
        });
      expect((await post({ nonce, confirm: "yes" })).status).toBe(403);
      expect(
        (await post({ csrf, nonce, confirm: "yes" }, "https://wrong.example"))
          .status,
      ).toBe(403);
      expect(store.getTask(id)?.state).not.toBe("cancelled");
      const confirmed = await post({ csrf, nonce, confirm: "yes" });
      expect(confirmed.status).toBe(303);
      expect(confirmed.headers.get("location")).toBe(`/chat/action/${action}`);
      const receipt = await (
        await fetch(base + `/chat/action/${action}`, { headers: { cookie } })
      ).text();
      expect(receipt).toContain("Task cancelled.");
      expect(receipt).not.toContain('name="confirm"');
      expect((await post({ csrf, nonce, confirm: "yes" })).status).toBe(303);
      expect(store.getMateProposal(action)?.outcome).toMatchObject({
        ok: true,
        via: "web",
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  test("a redacted short preview must use full secure review, even with a forged direct callback", () => {
    const instructions =
      "Use the reference at /Users/operator/Documents/checklist.md and compare digest " +
      "a".repeat(64) +
      ".";
    const action = proposal("knowledge_instructions", { repo, instructions });
    expect(
      sharedActionNeedsReview(
        prepareSharedAction(
          store,
          who,
          "knowledge_instructions",
          { repo, instructions },
          root,
          now,
        ),
      ),
    ).toBe(true);
    expect(confirm(action)).toMatchObject({
      ok: false,
      reason: "needs-confirm",
    });
    expect(knowledgeView(store, repo, who.name).revision).toBe(0);
    const review = mintSharedActionReview(store, who, action, root, now);
    expect(review.payload.terms.join("\n")).toContain(instructions);
    expect(
      confirmMateProposal(store, who, action, now, {
        via: "web",
        evidenceRoot: root,
        confirm: true,
        actionReview: { nonce: review.nonce, password: "" },
      }),
    ).toMatchObject({ ok: true });
    expect(knowledgeView(store, repo, who.name).knowledge.instructions).toBe(
      instructions,
    );
  });
  test("tool proposals map an admitted project and expose no password or execution authority", () => {
    const draft: Record<string, unknown>[] = [];
    const ctx = {
      store,
      who,
      now,
      step: 1,
      readDecisions: new Map<number, number>(),
      evidenceRoot: root,
      draft: (_kind: unknown, payload: Record<string, unknown>) => {
        draft.push(payload);
        return 1;
      },
    };
    expect(
      executeMateTool(ctx, "propose_action", {
        operation: "knowledge_instructions",
        repo: "r1",
        instructions: "Use clear labels.",
      }),
    ).toMatchObject({ ok: true, body: { executed: false } });
    expect(draft[0]?.["repo"]).toBe(repo);
    expect(
      executeMateTool(ctx, "propose_action", {
        operation: "knowledge_instructions",
        repo: "r1",
        instructions: "bad",
        password: "bad",
      }).ok,
    ).toBe(false);
    expect(
      executeMateTool(ctx, "propose_action", {
        operation: "knowledge_instructions",
        repo: "r2",
        instructions: "bad",
      }).ok,
    ).toBe(false);
    expect(draft).toHaveLength(1);
  });
});
