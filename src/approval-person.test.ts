/**
 * Only a person approves (docs/plans/approval-policy.md, phase 1). A lead token or a remote API token proves a
 * credential, not a person at a ceremony: it can't approve a scope, merge by hand, be the second person on protected
 * work, or stand behind a release or a deployment. Every case goes through the road a caller really takes — the CLI
 * with a minted lead token, the remote seam, the store's own belts — and the legacy rows a lead token sealed as
 * `password` before the fix are read for what they were.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { APPROVAL_PROOF, addApprover, approvalOf, approvalProofDetail, machineActing, personApprovalOf, personProof, proofDetailOf, propose, quarantinedAuthor } from "./scope.js";
import { scopeApprovedForDispatch } from "./dispatch.js";
import { runOperate, runOperateAs, EXIT, type Principal } from "./operate.js";
import { withActor } from "./actor.js";
import { withRemote, type RemoteRun } from "./remote-run.js";
import { mergeAsPerson, MERGE_NEEDS_PERSON } from "./pull-request-flow.js";
import { gateStateOf } from "./release-adapters.js";
import { ownerApproval } from "./release.js";
import { decideFlowCard } from "./flow-engine.js";
import { approvedSinceBuild } from "./flow-pull-request.js";
import { modeDigestOf, modeTermsJson, presetTerms } from "./modes.js";
import { mintApiToken } from "./api-tokens.js";
import { storeEvidence } from "./evidence.js";
import { sealVerificationReceipt } from "./verification-evidence.js";
import { recordRunCheckLevel } from "./check-levels.js";
import { assignmentOf } from "./assignment.js";
import { protectedPublicationHold } from "./result-completion.js";
import type { FlowDefinition } from "./flows.js";
import { SUBAGENT_TEMPLATES } from "./subagents.js";
import { createScheduledFlow, fileStandingOrder, standingApproval, standingDigestOf, type StandingOrder } from "./flow-schedule.js";
import { parseAcceptanceCriteria } from "./scope.js";
// @ts-expect-error plain ESM script without declarations
import { deploymentCandidate } from "../scripts/deploy-candidate.mjs";

const NOW = new Date("2026-10-24T12:00:00.000Z");
const REPO = "/repo/approval-person";
let dir = "", db = "", store: Store, lines: string[] = [];
const passwords: Record<string, string> = {};

const run = (argv: string[], now: Date = NOW) => {
  const [command = "", ...rest] = argv;
  lines = [];
  return runOperate(command, rest, line => lines.push(line), { databaseFile: db, now });
};
const payload = () => JSON.parse(lines.join("\n")) as Record<string, unknown>;
/** A lead token for alex, minted through the real command. */
const leadToken = async (): Promise<string> => {
  expect(await run(["lead", "token", "--as", "alex", "--token", passwords["alex"]!, "--json"])).toBe(EXIT.ok);
  return payload()["token"] as string;
};
/** A task in REPO with a resolved scope, nothing approved. */
const filed = (id: string, touches: string[] = ["src/a.ts"]): string => {
  store.createTask({ id, title: id }, NOW);
  store.placeTask(store.refFor("built-in", id).id, REPO, {}, NOW);
  const scope = propose(store, { taskId: id, goal: `Do ${id}`, touches, acceptance: [{ id: "c1", statement: "it works", how: null, evidence: ["check"] }], now: NOW });
  expect(scope.profileState).toBe("resolved");
  return scope.digest;
};
const filedAt = (id: string) => filed(id);
/** A legacy row: sealed through the person's road (basis `password`) with the proof the act really left. */
const legacySeal = (id: string, proof: string | null): void => {
  expect(store.sealScopeApproval(id, "alex", NOW)).toBe(true);
  if (proof !== null) store.recordAction({ at: NOW.toISOString(), actor: "alex", repo: REPO, taskId: id, runId: null, action: APPROVAL_PROOF, outcome: proof, source: "work",
    detail: approvalProofDetail(NOW.getTime(), 1, store.getScope(id)!.digest) });
};
const remote = (account: string): RemoteRun => ({ account, scope: "act", tokenName: "laptop", source: "api", secret: "s", allows: () => true, lens: null, noteTask: () => {}, files: {} });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "so-approval-person-"));
  db = join(dir, "orders.db");
  store = openStore(db);
  const alex = addApprover(store, "alex", NOW);
  if (!alex.ok) throw new Error("alex");
  passwords["alex"] = alex.token;
  const sam = addApprover(store, "sam", NOW, { name: "alex", token: alex.token });
  if (!sam.ok) throw new Error("sam");
  passwords["sam"] = sam.token;
  for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", NOW);
});
afterEach(() => {
  vi.unstubAllEnvs();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("whose proof it is", () => {
  test("every credential method is classified; the chat tap and a passkey are a person; anything else is not", () => {
    for (const method of ["password-now", "sso-now", "fresh-password", "fresh-sso", "session", "cli-login", "chat", "passkey"]) expect(personProof(method), method).toBe(true);
    for (const method of ["lead-token", "remote-token", "", "Password-now", "toString", "__proto__", "constructor", "bogus"]) expect(personProof(method), method).toBe(false);
    expect(personProof(null)).toBe(false);
    expect(personProof(undefined)).toBe(false);
  });

  test("a proof row reads in its legacy text or its versioned record, and nothing else", () => {
    expect(proofDetailOf(approvalProofDetail(NOW.getTime(), 3, "d1"))).toEqual({ at: NOW.toISOString(), digest: "d1" });
    expect(proofDetailOf(JSON.stringify({ v: 1, at: NOW.toISOString(), digest: "d2", credential: "pk-1" }))).toEqual({ at: NOW.toISOString(), digest: "d2" });
    for (const bad of [JSON.stringify({ v: 2, at: NOW.toISOString(), digest: "d" }), JSON.stringify({ v: 1, at: "soon", digest: "d" }), "{oops", `${NOW.toISOString()} · digest d`,
      `${NOW.toISOString()} · generation x · digest d`, `nope · generation 1 · digest d`, null, 7]) expect(proofDetailOf(bad), String(bad)).toBeNull();
  });

  test("only another machine's text is quarantined; the lead's own CLI text is not", () => {
    for (const via of ["mate", "coordinator", "scout"]) expect(quarantinedAuthor(via)).toBe(true);
    for (const via of ["lead", null, undefined, "other"]) expect(quarantinedAuthor(via)).toBe(false);
  });
});

describe("the lead's token through the real CLI", () => {
  test("task approve with a lead token is refused: nothing sealed, no vote, no proof row", async () => {
    const lead = await leadToken();
    const digest = filed("t-lead");
    vi.stubEnv("TOOLROLL_LEAD_TOKEN", lead);
    expect(await run(["task", "approve", "t-lead", "--yes", "--digest", digest, "--json"])).toBe(EXIT.refused);
    expect(payload()).toMatchObject({ ok: false, reason: "machine-proof", message: expect.stringContaining("only a person can approve this") });
    // --token names the same credential.
    vi.unstubAllEnvs();
    expect(await run(["task", "approve", "t-lead", "--yes", "--digest", digest, "--token", lead, "--json"])).toBe(EXIT.refused);
    expect(payload()).toMatchObject({ reason: "machine-proof" });
    expect(store.getScope("t-lead")!.approvedAt).toBeNull();
    expect(store.approvalVotes("t-lead")).toEqual([]);
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM action_ledger WHERE task_id = 't-lead' AND action = ?").get(APPROVAL_PROOF)!["n"]).toBe(0);
    // The person's own password still approves it.
    expect(await run(["task", "approve", "t-lead", "--yes", "--digest", digest, "--as", "alex", "--token", passwords["alex"]!, "--json"])).toBe(EXIT.ok);
    expect(personApprovalOf(store, "t-lead")).toMatchObject({ ok: true, by: "alex", method: "password-now" });
  });

  test("task merge with a lead token is refused before anything is read, --anyway included", async () => {
    const lead = await leadToken();
    vi.stubEnv("TOOLROLL_LEAD_TOKEN", lead);
    for (const extra of [[], ["--anyway"]]) {
      expect(await run(["task", "merge", "no-such-task", ...extra, "--json"])).toBe(EXIT.refused);
      expect(payload()).toMatchObject({ ok: false, reason: "person-required", message: MERGE_NEEDS_PERSON });
    }
  });

  test("the shared manual-merge boundary refuses a lead token and a remote token by their proof", async () => {
    const lead = await leadToken();
    const asLead = await withActor({ account: "alex", lead: true }, () => mergeAsPerson(store, { runId: 1, name: "alex", password: lead, anyway: true }));
    expect(asLead).toMatchObject({ ok: false, reason: "person-required" });
    const asRemote = await withRemote(remote("alex"), () => mergeAsPerson(store, { runId: 1, name: "alex", password: "s" }));
    expect(asRemote).toMatchObject({ ok: false, reason: "person-required" });
  });

  test("a lead refile keeps another machine's mark; a person's refile clears it; the lead's own filing is marked lead", async () => {
    const lead = await leadToken();
    filed("t-scout");
    store.saveScope({ ...store.getScope("t-scout")! }, {}, { proposedVia: "scout" });
    expect(store.getScope("t-scout")!.proposedVia).toBe("scout");
    vi.stubEnv("TOOLROLL_LEAD_TOKEN", lead);
    expect(await run(["task", "scope", "t-scout", "--goal", "Rewritten by the lead", "--acceptance", "c1: it works | check", "--json"])).toBe(EXIT.ok);
    expect(store.getScope("t-scout")).toMatchObject({ goal: "Rewritten by the lead", proposedVia: "scout" });
    expect(await run(["task", "add", "Lead files this", "--id", "t-own", "--repo", REPO, "--json"])).toBe(EXIT.ok);
    expect(await run(["task", "scope", "t-own", "--goal", "The lead's own words", "--acceptance", "c1: it works | check", "--json"])).toBe(EXIT.ok);
    expect(store.getScope("t-own")!.proposedVia).toBe("lead");
    vi.unstubAllEnvs();
    expect(await run(["task", "scope", "t-scout", "--goal", "Alex's own words", "--acceptance", "c1: it works | check", "--as", "alex", "--token", passwords["alex"]!, "--json"])).toBe(EXIT.ok);
    expect(store.getScope("t-scout")!.proposedVia).toBeNull();
  });

  test("a mode still covers the lead's own CLI filing, and its planned filing is still pre-authorized", async () => {
    const terms = { ...presetTerms("standard", new Date(NOW.getTime() + 86_400_000).toISOString()), autoApproveFiling: true, planAuto: true };
    store.signMode({ repo: REPO, name: terms.name, termsJson: modeTermsJson(terms), digest: modeDigestOf(terms), signedBy: "alex", absoluteExpiry: terms.absoluteExpiry, publication: terms.publication }, NOW);
    const lead = await leadToken();
    vi.stubEnv("TOOLROLL_LEAD_TOKEN", lead);
    expect(await run(["task", "add", "Covered", "--id", "t-covered", "--repo", REPO, "--json"])).toBe(EXIT.ok);
    expect(await run(["task", "scope", "t-covered", "--goal", "Change one line", "--touches", "src/a.ts", "--acceptance", "c1: it works | check", "--json"])).toBe(EXIT.ok);
    expect(store.getScope("t-covered")).toMatchObject({ proposedVia: "lead", approvalBasis: "mode" });
    expect(approvalOf(store.getScope("t-covered")).approved).toBe(true);
    expect(await run(["task", "add", "Planned", "--id", "t-planned", "--repo", REPO, "--json"])).toBe(EXIT.ok);
    // A placeholder rubric asks the planner under a mode that plans automatically (operate.ts, the CLI planning branch).
    expect(await run(["task", "scope", "t-planned", "--goal", "Plan this", "--touches", "src/b.ts", "--acceptance", "plan", "--json"])).toBe(EXIT.ok);
    expect(store.lookupRef("t-planned")!.plan).toBe("requested");
    expect(store.getScope("t-planned")!.proposedVia).toBe("lead");
    expect(store.handle.prepare("SELECT basis, signed_by FROM plan_authorization WHERE task_id = 't-planned'").get()).toMatchObject({ basis: "mode", signed_by: "alex" });
  });
});

describe("the seal primitive", () => {
  test("a seal with no basis is a person's, so the lead or a remote run never mints one", () => {
    filed("t-belt");
    expect(withActor({ account: "alex", lead: true }, () => store.sealScopeApproval("t-belt", "alex", NOW))).toBe(false);
    expect(withRemote(remote("alex"), () => machineActing())).toBe(true);
    expect(withRemote(remote("alex"), () => store.sealScopeApproval("t-belt", "alex", NOW))).toBe(false);
    expect(store.getScope("t-belt")!.approvedAt).toBeNull();
    expect(store.sealScopeApproval("t-belt", "alex", NOW)).toBe(true);
  });
});

describe("which authorities stand", () => {
  test("one table over approvalOf, the claim/build belt, dispatch and the person check", () => {
    const terms = { ...presetTerms("standard", new Date(NOW.getTime() + 86_400_000).toISOString()), autoApproveFiling: true };
    store.signMode({ repo: REPO, name: terms.name, termsJson: modeTermsJson(terms), digest: modeDigestOf(terms), signedBy: "alex", absoluteExpiry: terms.absoluteExpiry, publication: terms.publication }, NOW);
    const raw = (id: string, basis: string | null, digest: string | null = null) => {
      expect(store.sealScopeApproval(id, "alex", NOW)).toBe(true);
      store.handle.prepare("UPDATE task_scope SET approval_basis = ?, mode_digest = ? WHERE task_id = ?").run(basis, digest, id);
    };
    type Want = { approved: boolean; stands: boolean; person: boolean };
    const rows: [string, string, () => void, Want][] = [
      ["person with a proof", "r-person", () => legacySeal("r-person", "password-now"), { approved: true, stands: true, person: true }],
      ["chat with its proof", "r-chat", () => { legacySeal("r-chat", "chat"); store.handle.prepare("UPDATE task_scope SET approval_basis = 'chat' WHERE task_id = 'r-chat'").run(); }, { approved: true, stands: true, person: true }],
      ["legacy password, no proof row", "r-old", () => legacySeal("r-old", null), { approved: true, stands: true, person: false }],
      ["legacy lead token as password", "r-lead-proof", () => legacySeal("r-lead-proof", "lead-token"), { approved: false, stands: false, person: false }],
      ["legacy remote token as password", "r-remote", () => legacySeal("r-remote", "remote-token"), { approved: false, stands: false, person: false }],
      ["legacy lead task act", "r-lead-act", () => { legacySeal("r-lead-act", null); store.handle.prepare("INSERT INTO task_act (task_ref, act, account, lead, at) VALUES (?, 'approved', 'alex', 1, ?)").run(store.refFor("built-in", "r-lead-act").id, NOW.toISOString()); }, { approved: false, stands: false, person: false }],
      ["a person re-approved after a lead-token seal", "r-again", () => {
        legacySeal("r-again", "lead-token");
        const later = new Date(NOW.getTime() + 60_000);
        expect(store.sealScopeApproval("r-again", "alex", later)).toBe(true);
        store.recordAction({ at: later.toISOString(), actor: "alex", repo: REPO, taskId: "r-again", runId: null, action: APPROVAL_PROOF, outcome: "password-now", source: "work", detail: approvalProofDetail(later.getTime(), 1, store.getScope("r-again")!.digest) });
      }, { approved: true, stands: true, person: true }],
      ["an older person proof, then the lead's act at the seal", "r-older", () => {
        filedAt("r-older");
        store.recordAction({ at: new Date(NOW.getTime() - 60_000).toISOString(), actor: "alex", repo: REPO, taskId: "r-older", runId: null, action: APPROVAL_PROOF, outcome: "password-now", source: "work", detail: approvalProofDetail(NOW.getTime() - 60_000, 1, store.getScope("r-older")!.digest) });
        expect(store.sealScopeApproval("r-older", "alex", NOW)).toBe(true);
        withActor({ account: "alex", lead: true }, () => store.noteTaskAct(store.refFor("built-in", "r-older").id, "approved", NOW));
      }, { approved: false, stands: false, person: false }],
      ["a structured remote-token proof with whitespace", "r-json", () => {
        legacySeal("r-json", null);
        store.recordAction({ at: NOW.toISOString(), actor: "alex", repo: REPO, taskId: "r-json", runId: null, action: APPROVAL_PROOF, outcome: "password-now", source: "work", detail: approvalProofDetail(NOW.getTime(), 1, store.getScope("r-json")!.digest) });
        store.recordAction({ at: NOW.toISOString(), actor: "alex", repo: REPO, taskId: "r-json", runId: null, action: APPROVAL_PROOF, outcome: "remote-token", source: "work", detail: JSON.stringify({ v: 1, at: NOW.toISOString(), generation: 1, digest: store.getScope("r-json")!.digest }, null, 2) });
      }, { approved: false, stands: false, person: false }],
      ["an unparseable machine proof at the seal", "r-garbled", () => { legacySeal("r-garbled", null); store.recordAction({ at: NOW.toISOString(), actor: "alex", repo: REPO, taskId: "r-garbled", runId: null, action: APPROVAL_PROOF, outcome: "lead-token", source: "work", detail: "{not json" }); }, { approved: false, stands: false, person: false }],
      ["live mode", "r-mode", () => { expect(store.sealScopeApproval("r-mode", "alex", NOW, {}, { kind: "mode", modeDigest: modeDigestOf(terms) })).toBe(true); }, { approved: true, stands: true, person: false }],
      ["dead mode", "r-dead-mode", () => raw("r-dead-mode", "mode", "not-the-live-one"), { approved: true, stands: false, person: false }],
      ["schedule, approver standing", "r-sched", () => { expect(store.sealScopeApproval("r-sched", "alex", NOW, {}, { kind: "schedule", modeDigest: "order" }, "automation")).toBe(true); }, { approved: true, stands: true, person: false }],
      ["lead", "r-lead", () => raw("r-lead", "lead", "lt-1"), { approved: false, stands: false, person: false }],
      ["null", "r-null", () => raw("r-null", null), { approved: false, stands: false, person: false }],
      ["bogus", "r-bogus", () => raw("r-bogus", "bogus"), { approved: false, stands: false, person: false }],
    ];
    for (const [name, id, make, want] of rows) {
      if (id !== "r-older") filed(id);
      make();
      const ref = store.refFor("built-in", id).id;
      expect(approvalOf(store.getScope(id)).approved, `${name}: approvalOf`).toBe(want.approved);
      expect(store.modeApprovalLive(ref, NOW), `${name}: claim/build belt`).toBe(want.stands);
      expect(scopeApprovedForDispatch(store, ref, NOW), `${name}: dispatch`).toBe(want.approved && want.stands);
      expect(personApprovalOf(store, id).ok, `${name}: person`).toBe(want.person);
    }
    expect(store.getScope("r-bogus")!.approvalBasis).toBe("unknown");
  });

  test("an unsealed scope claims no authority, so a planner or a check can still be admitted", () => {
    filed("t-unsealed");
    const ref = store.refFor("built-in", "t-unsealed").id;
    expect(store.modeApprovalLive(ref, NOW)).toBe(true);
    expect(scopeApprovedForDispatch(store, ref, NOW)).toBe(false);
  });

  test("a standing order's seal stands only while its approver can still approve in the project", () => {
    filed("t-order");
    expect(store.sealScopeApproval("t-order", "sam", NOW, {}, { kind: "schedule", modeDigest: "order" }, "automation")).toBe(true);
    const ref = store.refFor("built-in", "t-order").id;
    expect(store.modeApprovalLive(ref, NOW)).toBe(true);
    expect(store.setAccountProjects("sam", ["/elsewhere"], "alex", NOW)).toEqual({ ok: true });
    expect(store.modeApprovalLive(ref, NOW)).toBe(false);
    expect(personApprovalOf(store, "t-order")).toMatchObject({ ok: false, why: "approved by schedule, not by a person" });
  });
});

describe("standing orders and old seals", () => {
  test("a firing whose checks reach beyond the sandbox files its task, waiting for a person, instead of being dropped", () => {
    store.setProjectCheckAccess(REPO, "unsandboxed", "alex", NOW, { may: "widen" });
    filed("t-shape");
    const shape = store.getScope("t-shape")!;
    expect(shape.profile?.checkAccess).toBe("unsandboxed");
    const order: StandingOrder = { stem: "deps", goal: "Refresh the lockfile", outOfScope: null, touches: ["package.json"], requirements: [],
      acceptance: [{ id: "c1", statement: "It still installs.", evidence: ["check"] }], budgetPerRunMicrousd: null, costCeilingUsd: null, singleFlight: true, filedBy: "alex", routine: null, approval: null };
    const acceptance = parseAcceptanceCriteria(order.acceptance).criteria;
    const routeJson = shape.proposedRouteJson!;
    const approved = { ...order, approval: { digest: standingDigestOf(REPO, "every:60", order, acceptance, shape.profile!, JSON.parse(routeJson)), by: "alex", at: NOW.toISOString(), profileJson: shape.profileJson!, routeJson } };
    expect(standingApproval(approved, REPO, "every:60")).toMatchObject({ live: true });
    const fired = store.transact(() => fileStandingOrder(store, { flowId: 1, repo: REPO, trigger: 1, schedule: "every:60", order: approved, title: "Deps", slot: NOW.toISOString() }, NOW));
    expect(fired).toMatchObject({ made: "filed", approved: false, note: expect.stringContaining("waits for approval") });
    if (fired.made !== "filed") throw new Error("filed");
    expect(store.getScope(fired.taskId)).toMatchObject({ approvedAt: null, approvedBy: null });
  });

  test("an old standing-order seal stored as password stands only while its approver can approve here, and is never a person's", () => {
    const made = createScheduledFlow(store, { repo: REPO, name: "Nightly", stem: "nightly", schedule: "daily:03:30", by: "alex",
      terms: { goal: "refresh", outOfScope: null, touches: [], requirements: [], acceptance: [{ id: "c1", statement: "Refreshed.", how: null, evidence: ["check"] }], budgetPerRunMicrousd: null, costCeilingUsd: null } }, NOW);
    if (!made.ok) throw new Error(made.message);
    filed("t-old-order");
    // Before the fix a firing sealed as `password` under its approver's name, with no proof row.
    expect(store.sealScopeApproval("t-old-order", "sam", NOW)).toBe(true);
    store.handle.prepare("INSERT INTO flow_trigger_event (trigger, key, at, task) VALUES (?, 'slot-1', ?, 't-old-order')").run(made.trigger, NOW.toISOString());
    const ref = store.refFor("built-in", "t-old-order").id;
    expect(store.getScope("t-old-order")!.approvalBasis).toBe("schedule");
    expect(personApprovalOf(store, "t-old-order").ok).toBe(false);
    expect(store.modeApprovalLive(ref, NOW)).toBe(true);
    expect(store.setAccountProjects("sam", ["/elsewhere"], "alex", NOW)).toEqual({ ok: true });
    expect(store.modeApprovalLive(ref, NOW)).toBe(false);
    expect(scopeApprovedForDispatch(store, ref, NOW)).toBe(false);
  });

  test("an old lead-made seal shows as not approved, so the person sees Approve, and their yes stands", async () => {
    filed("t-page"); legacySeal("t-page", "lead-token");
    expect(store.getScope("t-page")!.approvalBasis).toBe("lead");
    expect(approvalOf(store.getScope("t-page")).approved).toBe(false);
    expect(await run(["task", "approve", "t-page", "--yes", "--digest", store.getScope("t-page")!.digest, "--as", "alex", "--token", passwords["alex"]!, "--json"], new Date(NOW.getTime() + 60_000))).toBe(EXIT.ok);
    expect(approvalOf(store.getScope("t-page")).approved).toBe(true);
    expect(personApprovalOf(store, "t-page")).toMatchObject({ ok: true });
    expect(scopeApprovedForDispatch(store, store.refFor("built-in", "t-page").id, NOW)).toBe(true);
  });
});

describe("protected work counts only people", () => {
  test("a vote a lead token left, or one with no proof, is history only; a later person's yes is the first", async () => {
    store.setApprovalRules(REPO, { notRequester: false, protectProject: true, protectedPaths: [] }, "alex", NOW);
    for (const [id, proof] of [["v-lead", "lead-token"], ["v-none", null]] as const) {
      const digest = filed(id);
      // Before the fix: alex's lead token voted, through the person's road.
      store.handle.prepare("INSERT INTO scope_approval_vote (task_id, digest, approver, at) VALUES (?, ?, 'alex', ?)").run(id, digest, NOW.toISOString());
      if (proof !== null) store.recordAction({ at: NOW.toISOString(), actor: "alex", repo: REPO, taskId: id, runId: null, action: APPROVAL_PROOF, outcome: proof, source: "work", detail: approvalProofDetail(NOW.getTime(), 1, digest) });
      expect(await run(["task", "approve", id, "--yes", "--digest", digest, "--as", "sam", "--token", passwords["sam"]!, "--json"])).toBe(EXIT.refused);
      expect(payload()).toMatchObject({ reason: "second-approver" });
      expect(store.getScope(id)!.approvedAt).toBeNull();
      // alex's own password yes replaces the machine's row and makes the second person.
      expect(await run(["task", "approve", id, "--yes", "--digest", digest, "--as", "alex", "--token", passwords["alex"]!, "--json"])).toBe(EXIT.ok);
      expect(store.handle.prepare("SELECT proof FROM scope_approval_vote WHERE task_id = ? AND approver = 'alex'").get(id)).toEqual({ proof: "password-now" });
    }
    // A vote recorded with its proof counts: alex then sam, both by password, seals.
    const digest = filed("v-people");
    expect(await run(["task", "approve", "v-people", "--yes", "--digest", digest, "--as", "alex", "--token", passwords["alex"]!, "--json"])).toBe(EXIT.refused);
    expect(store.handle.prepare("SELECT proof FROM scope_approval_vote WHERE task_id = 'v-people'").get()).toEqual({ proof: "password-now" });
    expect(await run(["task", "approve", "v-people", "--yes", "--digest", digest, "--as", "sam", "--token", passwords["sam"]!, "--json"])).toBe(EXIT.ok);
  });
});

describe("two distinct people on protected work", () => {
  test("sam's vote, then a seal alex's lead token made: sam completing is not a second person; someone else is", () => {
    store.setApprovalRules(REPO, { notRequester: false, protectProject: true, protectedPaths: [] }, "alex", NOW);
    const bob = addApprover(store, "bob", NOW, { name: "alex", token: passwords["alex"]! });
    if (!bob.ok) throw new Error("bob");
    const digest = filed("p-mixed");
    store.handle.prepare("INSERT INTO scope_approval_vote (task_id, digest, approver, at, proof) VALUES ('p-mixed', ?, 'sam', ?, 'password-now')").run(digest, NOW.toISOString());
    store.handle.prepare("UPDATE task_scope SET approved_at = ?, approved_by = 'alex', approved_digest = digest, approval_basis = 'password' WHERE task_id = 'p-mixed'").run(NOW.toISOString());
    store.recordAction({ at: NOW.toISOString(), actor: "alex", repo: REPO, taskId: "p-mixed", runId: null, action: APPROVAL_PROOF, outcome: "lead-token", source: "work", detail: approvalProofDetail(NOW.getTime(), 1, digest) });
    expect(store.protectedResultProblem("p-mixed", ["src/a.ts"], "sam")).toContain("Someone else has to mark it complete.");
    expect(store.protectedResultProblem("p-mixed", ["src/a.ts"], "bob")).toBeNull();
    // A person-made seal is the first person: the other one completes.
    const second = filed("p-person");
    store.handle.prepare("UPDATE task_scope SET approved_at = ?, approved_by = 'alex', approved_digest = digest, approval_basis = 'password' WHERE task_id = 'p-person'").run(NOW.toISOString());
    store.recordAction({ at: NOW.toISOString(), actor: "alex", repo: REPO, taskId: "p-person", runId: null, action: APPROVAL_PROOF, outcome: "password-now", source: "work", detail: approvalProofDetail(NOW.getTime(), 1, second) });
    expect(store.protectedResultProblem("p-person", ["src/a.ts"], "alex")).toContain("Someone else");
    expect(store.protectedResultProblem("p-person", ["src/a.ts"], "sam")).toBeNull();
  });
});

describe("release and deploy need a person's approval", () => {
  const gateOf = (id: string) => {
    const scope = store.getScope(id)!;
    return gateStateOf({ ok: true, scope, personApproval: personApprovalOf(store, id) }, store.listApprovers().map(one => ({ name: one.name, role: "approver", revokedAt: null })));
  };

  test("the release gate reads the plane's proof: a lead-sealed `password` row is refused, a person's passes", () => {
    filed("g-lead"); legacySeal("g-lead", "lead-token");
    filed("g-old"); legacySeal("g-old", null);
    filed("g-person"); legacySeal("g-person", "password-now");
    expect(ownerApproval(gateOf("g-lead"), store.getScope("g-lead")!.digest)).toMatchObject({ ok: false, why: "approved by the lead, not by a person" });
    expect(ownerApproval(gateOf("g-old"), store.getScope("g-old")!.digest)).toMatchObject({ ok: false, why: expect.stringContaining("approve it again") });
    expect(ownerApproval(gateOf("g-person"), store.getScope("g-person")!.digest)).toMatchObject({ ok: true, by: "alex" });
    // A malformed answer is no person.
    expect(gateStateOf({ ok: true, scope: store.getScope("g-person"), personApproval: { ok: true } }).approval?.person).toMatchObject({ ok: false });
  });

  test("deploymentCandidate refuses a lead-sealed candidate through the real store", () => {
    filed("d-lead"); legacySeal("d-lead", "lead-token");
    const ref = store.refFor("built-in", "d-lead").id;
    const authority = store.routeAuthorityFor(ref, "builder");
    if (!authority?.ok) throw new Error("route");
    const runId = store.startRun({ taskRef: ref, leaseId: "l-d", runner: "r", branch: "b", worktree: "/w", route: authority.stamp, now: NOW });
    store.stampRun(runId, { scopeDigest: store.getScope("d-lead")!.digest, baseRevision: "1".repeat(40) });
    store.recordOutcomeFacts(runId, { headRevision: "a".repeat(40), handoff: "done" });
    store.finishRun(runId, { outcome: "built", committed: true, now: NOW });
    for (const installedScope of [{ personApprovalOf }, undefined]) {
      expect(() => deploymentCandidate(store, { runId, head: "a".repeat(40), evidenceRoot: join(dir, "evidence"), now: NOW }, {
        assignmentOf: () => null, verificationEvidence: () => ({ ok: false }), installedScope,
      }), String(installedScope)).toThrow("A person has to approve this candidate's scope: approved by the lead, not by a person.");
    }
  });
});

describe("a flow merges only on a person's recorded decision", () => {
  const definition = (subagent: string | null): FlowDefinition => ({ version: 1, start: "build", stages: [
    { id: "build", title: "Build", kind: "task", zone: {}, instructions: "Make the change.", next: "decide", onFail: null },
    { id: "decide", title: "Decide", kind: "approval", zone: {}, next: "pr", onFail: "build", ...(subagent === null ? {} : { subagent }) },
    { id: "pr", title: "Pull request", kind: "pull-request", zone: {}, next: null, onFail: "build", merge: "squash" },
  ] } as unknown as FlowDefinition);
  const cardAtDecision = (def: FlowDefinition): number => {
    const flow = store.createFlow({ repo: REPO, name: `Flow ${Math.random()}`, by: "alex", definitionJson: JSON.stringify(def) }, NOW);
    const card = store.addFlowCard({ flow, title: "A change", description: null, stage: "build", by: "alex", byKind: "person" }, NOW);
    expect(store.moveFlowCard(card, { to: "decide", outcome: "ok", actor: "flow" }, NOW)).toBe(true);
    return card;
  };

  test("a person's approval qualifies; a remote token's, a lead's and a legacy event's never do", () => {
    const def = definition(null);
    const byPerson = cardAtDecision(def);
    expect(decideFlowCard(store, { card: byPerson, decision: "approve", note: null, actor: "alex", repos: [REPO] }, NOW)).toMatchObject({ ok: true });
    expect(approvedSinceBuild(store, def, store.getFlowCard(byPerson)!)).toBe("alex");
    const byRemote = cardAtDecision(def);
    expect(withRemote(remote("alex"), () => decideFlowCard(store, { card: byRemote, decision: "approve", note: null, actor: "alex", repos: [REPO] }, NOW))).toMatchObject({ ok: true });
    expect(store.flowEvents(byRemote).at(-1)).toMatchObject({ outcome: "approved", authority: "remote" });
    expect(approvedSinceBuild(store, def, store.getFlowCard(byRemote)!)).toBeNull();
    const byLead = cardAtDecision(def);
    expect(withActor({ account: "alex", lead: true }, () => decideFlowCard(store, { card: byLead, decision: "approve", note: null, actor: "alex", repos: [REPO] }, NOW))).toMatchObject({ ok: true });
    expect(approvedSinceBuild(store, def, store.getFlowCard(byLead)!)).toBeNull();
    // A decision from before decisions said who made them.
    const legacy = cardAtDecision(def);
    expect(store.moveFlowCard(legacy, { to: "pr", outcome: "approved", actor: "alex" }, NOW)).toBe(true);
    expect(approvedSinceBuild(store, def, store.getFlowCard(legacy)!)).toBeNull();
  });

  test("a subagent staffing the decision never lets the zone merge", () => {
    store.createSubagent({ repo: REPO, handle: "maya", soul: SUBAGENT_TEMPLATES[0]!.soul, model: null, manager: "alex", by: "alex" }, NOW);
    const def = definition("maya");
    const card = cardAtDecision(def);
    expect(decideFlowCard(store, { card, decision: "approve", note: null, actor: "Maya (AI)", repos: [REPO], subagent: "maya" }, NOW)).toMatchObject({ ok: true });
    expect(store.flowEvents(card).at(-1)).toMatchObject({ outcome: "approved", authority: "subagent" });
    expect(approvedSinceBuild(store, def, store.getFlowCard(card)!)).toBeNull();
  });

  test("the most recent decision governs, even after the flow is edited, and it must follow the build being merged", () => {
    const def = definition(null);
    const card = cardAtDecision(def);
    expect(decideFlowCard(store, { card, decision: "approve", note: null, actor: "alex", repos: [REPO] }, NOW)).toMatchObject({ ok: true });
    expect(approvedSinceBuild(store, def, store.getFlowCard(card)!)).toBe("alex");
    // Bound to the build: a decision made before the build being merged finished doesn't count for it.
    expect(approvedSinceBuild(store, def, store.getFlowCard(card)!, new Date(NOW.getTime() + 1).toISOString())).toBeNull();
    // Back for another round; the lead decides this time.
    expect(store.moveFlowCard(card, { to: "build", outcome: "moved", actor: "alex" }, NOW)).toBe(true);
    expect(store.moveFlowCard(card, { to: "decide", outcome: "ok", actor: "flow" }, NOW)).toBe(true);
    expect(withActor({ account: "alex", lead: true }, () => decideFlowCard(store, { card, decision: "approve", note: null, actor: "alex", repos: [REPO] }, NOW))).toMatchObject({ ok: true });
    expect(approvedSinceBuild(store, def, store.getFlowCard(card)!)).toBeNull();
    // The flow is edited so the build zone is no longer a task: the older person decision still doesn't govern.
    const edited = { ...def, stages: def.stages.map(stage => stage.id === "build" ? { ...stage, kind: "draft" } : stage) } as unknown as FlowDefinition;
    expect(approvedSinceBuild(store, edited, store.getFlowCard(card)!)).toBeNull();
  });
});

describe("completion as the second person", () => {
  const HEAD = "c".repeat(40);
  /** A finished, checked build of a protected change one person approved: ready to mark complete. */
  const builtProtected = (id: string): number => {
    store.setVerifyCommand({ repo: REPO, command: "true", timeoutMs: 60_000, approvedBy: "alex" }, NOW);
    store.setApprovalRules(REPO, { notRequester: false, protectProject: false, protectedPaths: ["infra/**"] }, "alex", NOW);
    filed(id, ["src/a.ts"]);
    legacySeal(id, "password-now");
    const ref = store.refFor("built-in", id).id;
    const authority = store.routeAuthorityFor(ref, "builder");
    if (!authority?.ok) throw new Error("route");
    const runId = store.startRun({ taskRef: ref, leaseId: `l-${id}`, runner: "r", branch: `b-${id}`, worktree: `/pool/${id}`, route: authority.stamp, now: NOW });
    store.stampRun(runId, { scopeDigest: store.getScope(id)!.digest, baseRevision: "1".repeat(40) });
    store.recordOutcomeFacts(runId, { headRevision: HEAD, handoff: "Done." });
    store.finishRun(runId, { outcome: "built", committed: true, now: NOW });
    store.setTaskState(id, "done", NOW);
    const root = join(dir, "evidence");
    recordRunCheckLevel(store, { id: runId, taskId: id, repo: REPO }, "full", "project", NOW);
    store.saveProofVerdict(runId, "verified", [], NOW, [{ id: "c1", statement: "it works", requiredEvidence: ["check"], state: "pass", detail: [], answered: [{ kind: "check", ref: "true" }], review: null }] as never, "verified");
    storeEvidence(store, root, runId, "terminal-diff", "diff.patch", Buffer.from("diff --git a/infra/main.tf b/infra/main.tf\n--- a/infra/main.tf\n+++ b/infra/main.tf\n@@ -1 +1 @@\n-a\n+b\n"), "git diff (exit 0)", NOW, { captureStatus: "ok" });
    storeEvidence(store, root, runId, "diff-stat", "diff-stat.json", Buffer.from(JSON.stringify({ schema: 1, head: HEAD, base: "1".repeat(40), filesTruncated: false, fileCount: 1, files: [{ path: "infra/main.tf" }] })), "git diff --numstat", NOW, { captureStatus: "ok" });
    storeEvidence(store, root, runId, "check-log", "checks.txt", Buffer.from("1 passed\n"), "true", NOW, { captureStatus: "ok" });
    sealVerificationReceipt(store, root, runId, HEAD, store.liveVerifyCommand(REPO)!, { configured: true, ran: true, exitCode: 0 }, NOW);
    store.recordRunCheck(runId, { status: "passed", exitCode: 0, suites: [] }, NOW);
    return runId;
  };
  const complete = (id: string, extra: string[]) => run(["task", "complete", id, "--digest", assignmentOf(store, id, NOW, { principal: "operator", repos: [REPO] }, join(dir, "evidence"))!.receipt!.digest, ...extra, "--json"]);

  test("sam's lead token or API token is never the second person; sam's own completion is, and publication follows it", async () => {
    const runId = builtProtected("c-prot");
    const root = join(dir, "evidence");
    expect(assignmentOf(store, "c-prot", NOW, { principal: "operator", repos: [REPO] }, root)?.state).toBe("ready-to-check");
    // sam's lead token.
    expect(await run(["lead", "token", "--as", "sam", "--token", passwords["sam"]!, "--json"])).toBe(EXIT.ok);
    vi.stubEnv("TOOLROLL_LEAD_TOKEN", payload()["token"] as string);
    expect(await complete("c-prot", [])).toBe(EXIT.refused);
    expect(lines.join("\n")).toContain("a person other than its approver marks it complete");
    vi.unstubAllEnvs();
    // sam's API token, through the remote seam.
    const minted = mintApiToken();
    store.createApiToken({ id: minted.id, account: "sam", name: "laptop", secretHash: minted.hash, access: "act", expiresAt: "2027-01-01T00:00:00.000Z", by: "sam" }, NOW);
    const sam: Principal = { kind: "person", account: "sam", generation: store.accountOf("sam")!.generation, scope: "act", tokenId: minted.id, projects: null };
    const out: string[] = [];
    const digest = assignmentOf(store, "c-prot", NOW, { principal: "operator", repos: [REPO] }, root)!.receipt!.digest;
    expect(await runOperateAs(["task", "complete", "c-prot", "--digest", digest, "--json"], { principal: sam, store, write: line => out.push(line), options: { now: NOW } })).toBe(EXIT.refused);
    expect(out.join("\n")).toContain("a person other than its approver marks it complete");
    expect(assignmentOf(store, "c-prot", NOW, { principal: "operator", repos: [REPO] }, root)?.state).toBe("ready-to-check");
    // sam, as a person.
    expect(await complete("c-prot", ["--as", "sam", "--token", passwords["sam"]!])).toBe(EXIT.ok);
    expect(store.handle.prepare("SELECT actor, detail FROM action_ledger WHERE run_id = ? AND action = 'assignment handoff checked'").all(runId).map(row => ({ ...row }))).toEqual([{ actor: "operator:sam", detail: "proof person" }]);
    expect(protectedPublicationHold(store, runId, root)).toBeNull();
  });

  test("the lead still completes ordinary work, marked as a machine's", async () => {
    const runId = builtProtected("c-plain");
    store.setApprovalRules(REPO, { notRequester: false, protectProject: false, protectedPaths: [] }, "alex", NOW);
    vi.stubEnv("TOOLROLL_LEAD_TOKEN", await leadToken());
    expect(await complete("c-plain", [])).toBe(EXIT.ok);
    expect(store.handle.prepare("SELECT detail FROM action_ledger WHERE run_id = ? AND action = 'assignment handoff checked'").get(runId)).toEqual({ detail: "proof machine" });
  });
});
