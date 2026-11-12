/**
 * Easy-start C5: a laptop's local owner approves its everyday plans without a password, and that approval is a
 * person's only while local mode stands. Through the chat confirm door with Passwordless off, as the browser's local
 * owner: the seal records `local-owner` with its local generation, and the task claims through dispatch's own belts.
 * Every way around it is refused: the wrong act, a credential act, another person, ineligible work (unsandboxed checks),
 * local mode turned off (its seals stop dispatching), and widening launch confinement while local mode is on.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initLocalMode, openStore, setLocalModeOff, type Store } from "../../src/store.js";
import { approve, localApprovalEligible, proveAccountNow, proveCredential, propose } from "../../src/scope.js";
import { verifyApproverStanding, type VerifiedApprover } from "../../src/principal.js";
import { fileTaskProposal } from "../../src/proposal.js";
import { mintSharedActionReview, prepareSharedAction, type ChatAction } from "../../src/chat-actions.js";
import { confirmCoordinatorProposal, confirmLeadProposal } from "../../src/lead-doors.js";
import { asLocalOwner, LOCAL_MODE_CONFINES, LOCAL_OWNER_LAPSED, type LocalOwnerAct, type LocalPrincipal } from "../../src/local-owner.js";
import { register } from "../../src/runner.js";
import { acquire } from "../../src/claim.js";
import { fencedCommands } from "../../src/invoke.js";
import { run as runCommand } from "../../src/exec.js";
import { checkAccessRunsAs } from "../../src/check-access.js";
import { withActor } from "../../src/actor.js";
import { authorizePlanUnderMode } from "../../src/plan-auto.js";
import { modeDigestOf, modeTermsJson, presetTerms } from "../../src/modes.js";

const now = new Date("2026-11-03T12:00:00Z");
let root: string, repo: string, store: Store, who: VerifiedApprover, thread: number, session: number, serial = 0;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "so-local-approve-")));
  repo = join(root, "repo"); mkdirSync(repo);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  execFileSync("git", ["init", "-q", repo], { env });
  writeFileSync(join(repo, "README.md"), "Local approvals\n");
  execFileSync("git", ["-C", repo, "add", "."], { env });
  execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "seed"], { env });
  store = openStore(join(root, "state.db"), { createdBy: "laptop" });
  const init = initLocalMode(store, { owner: "alex", fenceAvailable: true, now });
  if (!init.ok) throw Error(init.reason);
  for (const phase of ["plan", "build", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "fixture", now);
  const verified = verifyApproverStanding(store, "alex", store.accountOf("alex")!.generation, [repo]);
  if (!verified.ok) throw Error("identity");
  who = verified.who;
  session = store.mintLeadSession({ approver: who.name, approverGeneration: who.generation, credentialKey: "local-fixture", ceilingMicrousd: 10_000_000,
    ceilingDigest: who.ceilingDigest, termsDigest: "fixture" }, now);
  thread = store.openLeadThread(who.name, who.ceilingDigest, now).thread.id;
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

/** The browser's local owner as the console's admission binds it, in one act. */
const owner = (act: LocalOwnerAct, transport: LocalPrincipal["transport"] = "browser"): LocalPrincipal =>
  ({ account: "alex", localGeneration: 1, accountGeneration: store.accountOf("alex")!.generation, transport, act, sessionHash: null, request: null });

function task(goal = "Make the footer link work.") {
  const id = `local-${++serial}`;
  const made = fileTaskProposal(store, { id, title: "Fix the footer", repo, filedVia: "cli", planning: "skip" }, now);
  if (!made.ok) throw Error(made.message);
  propose(store, { now, taskId: id, goal });
  return id;
}
function proposal(operation: ChatAction, input: Record<string, unknown>) {
  const payload = prepareSharedAction(store, who, operation, input, root, now);
  const turn = store.openLeadTurn({ approver: who.name, session, thread, credentialKey: "local-fixture", reservedMicrousd: 0, dailyTurns: 100, weeklyCeilingMicrousd: 10_000_000, deadlineMs: 60_000 }, now);
  if (!turn.ok) throw Error(turn.reason);
  const started = store.startLeadTurn(turn.id, now);
  if (!started.ok) throw Error("start");
  const id = store.draftLeadProposal({ thread, turn: turn.id, kind: "action", payload: { ...payload }, ceilingDigest: who.ceilingDigest }, now);
  store.finalizeLeadTurn(turn.id, started.generation, { state: "answered", settledMicrousd: 0, tokensIn: 0, tokensOut: 0, message: { text: "Review it.", activity: "" } }, now);
  return id;
}
/** The chat review's secure confirm, as the browser's local owner on the confirm row (Passwordless off: nothing typed). */
function confirmAsLocalOwner(id: number) {
  const review = mintSharedActionReview(store, who, id, root, now);
  return asLocalOwner(owner("lead-send"), () => confirmLeadProposal(store, who, id, now,
    { authority: "local-owner", via: "web", evidenceRoot: root, confirm: true, actionReview: { nonce: review.nonce, password: "" } }));
}
function claimable(id: string): boolean {
  const ref = store.lookupRef(id)!;
  register(store, { name: `worker-${id}`, host: "test", capacity: 1, repos: [repo], now, newToken: () => `token-${id}` });
  return acquire(store, ref.id, `worker-${id}`, { token: `token-${id}`, now, newLeaseId: () => `lease-${id}` }).ok;
}

describe("a local owner's approval", () => {
  test("through chat with Passwordless off: sealed as local-owner at its generation, then claimed through dispatch", () => {
    const id = task();
    const action = proposal("scope_approve", { task: id });
    expect(localApprovalEligible(store, "alex", id)).toEqual({ ok: true });
    expect(confirmAsLocalOwner(action)).toMatchObject({ ok: true });
    const scope = store.getScope(id)!;
    expect(scope.approvedDigest).toBe(scope.digest);
    const proof = store.handle.prepare("SELECT outcome, detail FROM action_ledger WHERE task_id = ? AND action = 'approval proved'").get(id)!;
    expect(proof["outcome"]).toBe("local-owner");
    expect(String(proof["detail"])).toMatch(/ · local 1 browser · digest [0-9a-f]+$/);
    // Dispatch's own belts read it as a person's seal that stands.
    expect(store.modeApprovalLive(store.lookupRef(id)!.id, now)).toBe(true);
    expect(claimable(id)).toBe(true);
  });

  test("the same empty field from anyone but the local owner's chain approves nothing", () => {
    const id = task();
    const action = proposal("scope_approve", { task: id });
    const review = mintSharedActionReview(store, who, action, root, now);
    // A full door (no local owner in the chain) with an empty password: nothing stands in for one.
    expect(confirmLeadProposal(store, who, action, now, { authority: "full", via: "web", evidenceRoot: root, confirm: true, actionReview: { nonce: review.nonce, password: "" } }))
      .toMatchObject({ ok: false, reason: "needs-confirm" });
    // Naming the local owner without being one (no chain) changes nothing either.
    const again = mintSharedActionReview(store, who, action, root, now);
    expect(confirmLeadProposal(store, who, action, now, { authority: "local-owner", via: "web", evidenceRoot: root, confirm: true, actionReview: { nonce: again.nonce, password: "" } }))
      .toMatchObject({ ok: false });
    expect(store.getScope(id)!.approvedDigest).toBeNull();
  });

  test("the prover: only the local owner's own allowlisted act; never a read, a credential act, another person, or a moved generation", () => {
    expect(asLocalOwner(owner("approve-plan"), () => proveAccountNow(store, "alex", ""))).toMatchObject({ ok: true, method: "local-owner" });
    expect(asLocalOwner(owner("stop-run"), () => proveAccountNow(store, "alex", "anything typed"))).toMatchObject({ ok: true, method: "local-owner" });
    expect(asLocalOwner(owner("read"), () => proveAccountNow(store, "alex", ""))).toEqual({ ok: false, reason: "not-an-approver" });
    expect(asLocalOwner(owner("approve-plan"), () => proveAccountNow(store, "alex", "", { credential: true }))).toEqual({ ok: false, reason: "not-an-approver" });
    expect(asLocalOwner(owner("approve-plan"), () => proveCredential(store, "alex", ""))).toEqual({ ok: false, reason: "not-an-approver" });
    expect(asLocalOwner(owner("approve-plan"), () => proveAccountNow(store, "robin", ""))).toEqual({ ok: false, reason: "not-an-approver" });
    expect(asLocalOwner({ ...owner("approve-plan"), localGeneration: 2 }, () => proveAccountNow(store, "alex", ""))).toEqual({ ok: false, reason: "not-an-approver" });
    expect(asLocalOwner({ ...owner("approve-plan"), accountGeneration: 99 }, () => proveAccountNow(store, "alex", ""))).toEqual({ ok: false, reason: "not-an-approver" });
    // A lead acting in that chain is the lead (a machine's proof), never the local owner.
    expect(withActor({ account: "alex", lead: true }, () => asLocalOwner(owner("approve-plan"), () => proveAccountNow(store, "alex", "")))).toMatchObject({ ok: false });
    // Work that outlived its request (a timer, a turn started in its chain) proves nothing as the local owner.
    expect(asLocalOwner({ ...owner("approve-plan"), request: { ended: true } }, () => proveAccountNow(store, "alex", ""))).toEqual({ ok: false, reason: "not-an-approver" });
    expect(asLocalOwner({ ...owner("approve-plan"), request: { ended: false } }, () => proveAccountNow(store, "alex", ""))).toMatchObject({ ok: true, method: "local-owner" });
    // A session the console no longer holds proves nothing.
    expect(asLocalOwner({ ...owner("approve-plan"), sessionHash: "f".repeat(64) }, () => proveAccountNow(store, "alex", ""))).toEqual({ ok: false, reason: "not-an-approver" });
  });

  test("approving is the approve-plan act only: another allowed act approves nothing", () => {
    const id = task();
    const digest = store.getScope(id)!.digest;
    expect(asLocalOwner(owner("file-task"), () => approve(store, id, "alex", now, digest, ""))).toMatchObject({ ok: false, reason: "policy" });
    expect(asLocalOwner(owner("approve-plan", "terminal"), () => approve(store, id, "alex", now, digest, ""))).toMatchObject({ ok: true });
    expect(String(store.handle.prepare("SELECT detail FROM action_ledger WHERE task_id = ? AND action = 'approval proved'").get(id)!["detail"])).toContain(" · local 1 terminal · ");
  });

  test("unsandboxed check access: the seal is refused, and a task already sealed stops dispatching", () => {
    const sealed = task("Sealed before the change.");
    expect(asLocalOwner(owner("approve-plan"), () => approve(store, sealed, "alex", now, store.getScope(sealed)!.digest, ""))).toMatchObject({ ok: true });
    expect(store.modeApprovalLive(store.lookupRef(sealed)!.id, now)).toBe(true);
    // Saved as unsandboxed (an older build, or the file edited): never through the setter while local mode is on.
    expect(store.setProjectCheckAccess(repo, "unsandboxed", "alex", now, { may: "widen" })).toBeNull();
    store.handle.prepare("INSERT INTO project_check_access (repo, level, updated_at, updated_by) VALUES (?, 'unsandboxed', ?, 'alex')").run(repo, now.toISOString());
    const fresh = task("Filed after the change.");
    expect(localApprovalEligible(store, "alex", fresh)).toMatchObject({ ok: false, reason: "unsandboxed" });
    expect(confirmAsLocalOwner(proposal("scope_approve", { task: fresh }))).toMatchObject({ ok: false });
    expect(store.getScope(fresh)!.approvedDigest).toBeNull();
    expect(store.modeApprovalLive(store.lookupRef(sealed)!.id, now)).toBe(false);
    expect(claimable(sealed)).toBe(false);
  });

  test("turning local mode off: every local seal stops dispatching, and the local owner's chain writes nothing more", () => {
    const id = task();
    expect(confirmAsLocalOwner(proposal("scope_approve", { task: id }))).toMatchObject({ ok: true });
    expect(store.modeApprovalLive(store.lookupRef(id)!.id, now)).toBe(true);
    // Only full authority turns it off; a local owner can't.
    expect(setLocalModeOff(store, { name: "alex", authority: "local-owner" }, now)).toEqual({ ok: false, reason: "not-allowed" });
    expect(setLocalModeOff(store, { name: "alex", authority: "full" }, now)).toMatchObject({ ok: true });
    expect(store.modeApprovalLive(store.lookupRef(id)!.id, now)).toBe(false);
    expect(claimable(id)).toBe(false);
    // The write-time re-check: any transaction the old chain opens is refused.
    expect(() => asLocalOwner(owner("file-task"), () => store.transact(() => 1))).toThrow(LOCAL_OWNER_LAPSED);
  });

  test("ineligible work keeps its password: escalated terms and a coordinator's filing", () => {
    const wide = task();
    propose(store, { now, taskId: wide, goal: "Make the footer link work, with wider permissions.", posture: "escalated" });
    expect(localApprovalEligible(store, "alex", wide)).toMatchObject({ ok: false, reason: "escalated" });
    const id = task();
    store.handle.exec("PRAGMA foreign_keys = OFF");
    store.handle.prepare("UPDATE task_ref SET coordinator_cid = 'c-1' WHERE external_id = ?").run(id);
    store.handle.exec("PRAGMA foreign_keys = ON");
    expect(localApprovalEligible(store, "alex", id)).toMatchObject({ ok: false, reason: "coordinator" });
    expect(asLocalOwner(owner("approve-plan"), () => approve(store, id, "alex", now, store.getScope(id)!.digest, ""))).toMatchObject({ ok: false, reason: "policy" });
    expect(localApprovalEligible(store, "robin", id)).toMatchObject({ ok: false, reason: "not-owner" });
  });
});

describe("plan pre-authorization under a mode (local-owner slice 0, Codex finding d)", () => {
  test("a local owner's chain never pre-authorizes a plan, whatever its act; outside it the mode's signer still does", () => {
    // A mode alex signed earlier (with a password) that approves filings and their unchanged plans by itself.
    const terms = { ...presetTerms("standard", new Date(now.getTime() + 86_400_000).toISOString()), autoApproveFiling: true, planAuto: true };
    store.signMode({ repo, name: terms.name, signedBy: "alex", digest: modeDigestOf(terms), termsJson: modeTermsJson(terms), publication: terms.publication, absoluteExpiry: terms.absoluteExpiry }, now);
    const id = task();
    propose(store, { now, taskId: id, goal: "Make the footer link work.", touches: ["src/footer.ts"], acceptance: [{ id: "c1", statement: "The link works.", how: null, evidence: ["check"] }] });
    expect(store.requestPlan(store.lookupRef(id)!.id, now).ok).toBe(true);
    const armed = () => store.handle.prepare("SELECT COUNT(*) AS n FROM plan_authorization WHERE task_id = ?").get(id)?.["n"];
    // Every act a local owner's request or terminal command can carry: filing (the road a browser filing takes), the
    // plan's own approval, and a read.
    for (const act of ["file-task", "approve-plan", "build-now", "read"] as const) {
      for (const transport of ["browser", "terminal"] as const) {
        expect(asLocalOwner(owner(act, transport), () => authorizePlanUnderMode(store, id, "alex", now)), `${act} ${transport}`).toBe(false);
      }
    }
    expect(armed()).toBe(0);
    // The same call from the mode's signer outside any local owner's chain (a password session): armed.
    expect(authorizePlanUnderMode(store, id, "alex", now)).toBe(true);
    expect(armed()).toBe(1);
  });
});

describe("the confirm door, as a local owner", () => {
  test("an operation that isn't one of its acts is refused before the CAS (the card stays pending); one that is runs", () => {
    const id = task();
    const action = proposal("task_cancel", { task: id });
    const skill = proposal("lead_about_you", { line: "Prefers short replies." });
    expect(asLocalOwner(owner("lead-send"), () => confirmLeadProposal(store, who, skill, now, { authority: "local-owner", via: "web", evidenceRoot: root, confirm: true })))
      .toMatchObject({ ok: false, reason: "refused", said: "Set a password to do this." });
    expect(store.getLeadProposal(skill)!.state).toBe("pending");
    // One of its acts (cancelling a task is stopping it) runs, through the same secure review.
    expect(confirmAsLocalOwner(action)).toMatchObject({ ok: true });
    expect(store.getLeadProposal(action)!.state).toBe("confirmed");
  });

  test("a coordinator's proposal is never a local owner's to confirm", () => {
    expect(asLocalOwner(owner("lead-send"), () => confirmCoordinatorProposal(store, who, 1, now, { authority: "local-owner", via: "web" })))
      .toMatchObject({ ok: false, reason: "refused" });
    expect(confirmCoordinatorProposal(store, who, 1, now, { authority: "local-owner", via: "cli" })).toMatchObject({ ok: false, reason: "refused" });
  });
});

describe("launch confinement while local mode is on", () => {
  test("allowing unconfined agents is refused, a stored allow reads as refused, and a launch with no fence runs nothing", async () => {
    expect(() => store.setUnfencedAgentsAllowed(true, "alex", now)).toThrow(LOCAL_MODE_CONFINES);
    store.handle.prepare("UPDATE confinement_setting SET unfenced_allowed = 1 WHERE id = 1").run();
    expect(store.unfencedAgentsAllowed()).toBe(false);
    const ran = await fencedCommands(store, 1, "workspace", runCommand, () => false)("/bin/echo", ["unconfined"], {});
    expect(ran.code).toBe(1);
    expect(ran.stdout).toBe("");
    // How checks would run here: never unsandboxed while local mode is on, whatever is saved or allowed.
    expect(checkAccessRunsAs("unsandboxed", { platform: "darwin", fenced: false, unconfinedAllowed: true, localMode: true })).toBe("sign-ins");
    expect(checkAccessRunsAs("unsandboxed", { platform: "darwin", fenced: true, unconfinedAllowed: false, localMode: true })).toBe("sign-ins");
    // Off, the operator's choice holds again.
    expect(setLocalModeOff(store, { name: "alex", authority: "full" }, now)).toMatchObject({ ok: true });
    expect(store.unfencedAgentsAllowed()).toBe(true);
  });
});
