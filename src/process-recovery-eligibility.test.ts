import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { currentBootId } from "./boot-identity.js";
import { storeEvidence, storeHandoffArtifact, type HandoffArtifact } from "./evidence.js";
import { run } from "./exec.js";
import { witnessedRunner } from "./process-custody.js";
import { preparedCandidateObserverGapEligibility } from "./process-recovery-eligibility.js";
import { addApprover, approve, propose } from "./scope.js";
import { openStore, type Store } from "./store.js";
import { sealVerificationReceipt } from "./verification-evidence.js";

const START = new Date("2026-09-20T10:00:00Z"), SPAWN = new Date("2026-09-20T10:00:01Z");
const SEALED = new Date("2026-09-20T10:00:02Z"), FINISHED = new Date("2026-09-20T10:00:03Z");
const NOW = new Date("2026-09-20T10:00:04Z"), REPO = "/repos/recovery";
const CANDIDATE = "c".repeat(40), BASE = "b".repeat(40), HEAD = "a".repeat(40);

describe("prepared candidate observer-gap eligibility is read-only and not exit authority", () => {
  let store: Store, dir: string, runId: number, unknown: number, token: string, handoff: Omit<HandoffArtifact, "version">;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "so-recovery-eligibility-"));
    store = openStore(join(dir, "orders.db"));
    const enrolled = addApprover(store, "operator", START);
    if (!enrolled.ok) throw Error("approver fixture");
    token = enrolled.token;
    for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "operator", START);
    store.createTask({ id: "prepared", title: "Verify the prepared candidate" }, START);
    const ref = store.lookupRef("prepared")!;
    store.placeTask(ref.id, REPO);
    propose(store, { taskId: "prepared", goal: "Verify the prepared candidate", candidate: CANDIDATE,
      touches: ["welcome.txt"], acceptance: [{ id: "c1", statement: "The prepared checks pass.", how: null, evidence: ["check"] }], now: START });
    expect(approve(store, "prepared", "operator", START, store.getScope("prepared")!.digest, token).ok).toBe(true);
    const authority = store.routeAuthorityFor(ref.id, "builder");
    if (!authority?.ok) throw Error("route fixture");
    runId = store.startRun({ taskRef: ref.id, leaseId: "prepared-lease", runner: "builder", branch: "so/prepared", worktree: join(dir, "worktree"), route: authority.stamp, now: START });
    store.stampRun(runId, { baseRevision: BASE, scopeDigest: store.getScope("prepared")!.digest });
    const conclusion = `Prepared candidate ${CANDIDATE} was checked out by the machine; no agent ran. The sealed diff spans this task's base to that candidate.`;
    store.recordOutcomeFacts(runId, { headRevision: HEAD, handoff: conclusion });
    handoff = { taskId: "prepared", runId, provider: store.getRun(runId)!.provider,
      sessionId: null, branch: "so/prepared", worktree: join(dir, "worktree"), base: BASE, head: HEAD,
      outcome: "built", committed: true, decisionsIncorporated: [], conclusion,
      changes: ["welcome.txt"], verification: [], followUps: [], freshness: { stampedAt: START.toISOString(), currentAsOf: HEAD } };
    storeHandoffArtifact(store, dir, handoff, START);
    // Actual local command and returning witnessed transport, not a mocked
    // approval, gate, exit result or artifact verifier. onUnknown injects just
    // the historical observation gap whose eligibility is under test.
    const command = store.setVerifyCommand({ repo: REPO, command: "printf 'gate passed\\n'", timeoutMs: 10_000, approvedBy: "operator" }, START);
    const execute = witnessedRunner(store, runId, () => SPAWN, async (file, args, options) => {
      options?.onUnknown?.();
      return run(file, args, options);
    });
    const result = await execute("/bin/sh", ["-c", command.command], { processGroup: true, timeoutMs: 10_000 });
    expect(result).toMatchObject({ code: 0, timedOut: false, notFound: false });
    unknown = Number(store.handle.prepare("SELECT id FROM run_process WHERE run = ? AND pid IS NULL AND exited_at IS NULL").get(runId)!.id);
    expect(store.handle.prepare("SELECT 1 FROM run_process WHERE run = ? AND pid IS NOT NULL AND exited_at IS NOT NULL").get(runId)).toBeTruthy();
    storeEvidence(store, dir, runId, "check-log", "check-log.txt", Buffer.from(result.stdout), command.command, SEALED, { captureStatus: "ok" });
    sealVerificationReceipt(store, dir, runId, HEAD, command, { configured: true, ran: true, exitCode: result.code }, SEALED);
    store.saveProofVerdict(runId, "verified", [], SEALED, [], "verified");
    store.finishRun(runId, { outcome: "built", committed: true, now: FINISHED });
    expect(store.handle.prepare("SELECT exited_at FROM run_process WHERE id=?").get(unknown)?.exited_at).toBe(FINISHED.toISOString());
    // Recovery still supports historical gaps left by runtimes without the
    // run-end settlement pass. Eligibility itself must never close them.
    store.handle.prepare("UPDATE run_process SET exited_at=NULL WHERE id=?").run(unknown);
    store.setTaskState("prepared", "done", FINISHED);
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const assess = (over: Partial<Parameters<typeof preparedCandidateObserverGapEligibility>[1]> = {}) => preparedCandidateObserverGapEligibility(store, {
    runId, evidenceRoot: dir, now: NOW, host: hostname(), bootId: currentBootId(), ...over,
  });
  const rows = () => store.handle.prepare("SELECT * FROM run_process ORDER BY id").all();
  function rewriteArtifact(kind: "handoff" | "structured-output", change: (value: any) => unknown) {
    const artifact = store.artifactsFor(runId).find(a => a.kind === kind)!;
    const payload = change(JSON.parse(readFileSync(join(dir, artifact.key), "utf8")));
    store.handle.prepare("DELETE FROM artifact WHERE id = ?").run(artifact.id);
    storeEvidence(store, dir, runId, kind, kind === "handoff" ? "replacement-handoff.json" : "replacement-receipt.json",
      Buffer.from(JSON.stringify(payload)), artifact.capture, SEALED, { captureStatus: "ok" });
  }

  test("a finished prepared check closes its NULL-pid witness at run end, preserving its passing result", () => {
    // The fixture ran the actual witnessed command and asserted closure at
    // FINISHED before restoring an old-runtime gap for the recovery tests.
    const entry = store.actionLedger({ repos: null }).find(one => one.action === "process witness settled");
    expect(entry).toMatchObject({ runId, at: FINISHED.toISOString(), detail: expect.stringContaining(`witness ${unknown}`) });
    const verdict = store.proofVerdictFor(runId), artifacts = store.artifactsFor(runId);
    store.finishRun(runId, { outcome: "built", committed: true, now: FINISHED });
    expect(store.handle.prepare("SELECT exited_at FROM run_process WHERE id=?").get(unknown)?.exited_at).toBe(FINISHED.toISOString());
    expect(store.stopQuiescenceFact(runId)).toBeNull();
    expect(store.proofVerdictFor(runId)).toEqual(verdict);
    expect(store.artifactsFor(runId)).toEqual(artifacts);
  });

  test("binds immutable exact rows without clearing custody or claiming descendants absent", () => {
    const before = rows(), ledger = store.actionLedger({ repos: null });
    const result = assess();
    expect(result).toMatchObject({ ok: true, requires: "separate-authenticated-spawn-provenance-and-complete-os-census",
      binding: { scope: { candidate: CANDIDATE }, run: { head: HEAD }, unknownWitnessIds: [unknown] } });
    expect(rows()).toEqual(before);
    expect(store.actionLedger({ repos: null })).toEqual(ledger);
    if (!result.ok) throw Error(result.reason);
    expect(Object.isFrozen(result.binding.witnesses[0])).toBe(true);
    expect(Object.isFrozen(result.binding.command)).toBe(true);
    expect(assess()).toEqual(result);
    store.handle.prepare("UPDATE run_process SET observed_at = ? WHERE id = ?").run(START.toISOString(), unknown);
    const changed = assess();
    expect(changed.ok && changed.digest).not.toBe(result.digest);
  });
  test.each([
    ["provider launch", "UPDATE run SET provider_started_at = started_at WHERE id = ?", "provider-or-run-identity-unproven"],
    ["provider session", "UPDATE run SET session_id = 'native-session' WHERE id = ?", "provider-or-run-identity-unproven"],
    ["unfinished run", "UPDATE run SET outcome = NULL, finished_at = NULL WHERE id = ?", "not-terminal-prepared-builder"],
    ["known PID without positive exit", "UPDATE run_process SET exited_at = NULL WHERE run = ? AND pid IS NOT NULL", "known-process-exit-unproven"],
    ["unknown native object", "UPDATE run_process SET containment = 'linux-cgroup' WHERE run = ? AND pid IS NULL", "native-containment-outside-scope"],
    ["orphaned container identity", "UPDATE run_process SET container_identity = 'orphan' WHERE run = ? AND pid IS NULL", "native-containment-outside-scope"],
    ["foreign host", "UPDATE run_process SET host = 'another-host' WHERE run = ? AND pid IS NULL", "unknown-witness-not-bound-to-gate"],
    ["missing boot", "UPDATE run_process SET boot_id = NULL WHERE run = ? AND pid IS NULL", "unknown-witness-not-bound-to-gate"],
    ["other boot", "UPDATE run_process SET boot_id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' WHERE run = ? AND pid IS NULL", "unknown-witness-not-bound-to-gate"],
    ["malformed birth", "UPDATE run_process SET observed_at = 'invalid' WHERE run = ? AND pid IS NULL", "malformed-process-witness"],
    ["post-gate gap", "UPDATE run_process SET observed_at = '2026-09-20T10:00:03Z' WHERE run = ? AND pid IS NULL", "unknown-witness-not-bound-to-gate"],
  ])("refuses %s", (_label, sql, reason) => {
    store.handle.prepare(sql).run(runId);
    const before = rows();
    expect(assess()).toEqual({ ok: false, reason });
    expect(rows()).toEqual(before);
  });
  test("refuses unavailable current kernel identity", () => {
    expect(assess({ bootId: null })).toEqual({ ok: false, reason: "current-host-boot-unavailable" });
  });
  test("requires current signed candidate and a current authorized signer", () => {
    store.handle.prepare("UPDATE approver SET revoked_at = ? WHERE name = 'operator'").run(NOW.toISOString());
    expect(assess()).toEqual({ ok: false, reason: "scope-signer-not-current" });
    store.handle.prepare("UPDATE approver SET revoked_at = NULL WHERE name = 'operator'").run();
    propose(store, { taskId: "prepared", goal: "Different work", candidate: "d".repeat(40), now: NOW });
    expect(assess()).toEqual({ ok: false, reason: "prepared-scope-not-current" });
  });
  test("same command text under a new grant cannot replace exact approved gate identity", () => {
    const old = store.liveVerifyCommand(REPO)!;
    store.setVerifyCommand({ repo: REPO, command: old.command, timeoutMs: old.timeoutMs, approvedBy: "operator" }, START);
    expect(assess()).toEqual({ ok: false, reason: "verification-evidence-unavailable" });
  });
  test("live task claim and hold refuse even though the run is terminal", () => {
    const ref = store.lookupRef("prepared")!;
    store.hold(ref.id, "Keep this work paused", null, NOW);
    expect(assess()).toEqual({ ok: false, reason: "task-still-active-or-held" });
    store.unhold(ref.id);
    store.handle.prepare("INSERT INTO claim (lease_id,task_ref,runner,lease_generation,acquired_at,expires_at,heartbeat_at) VALUES ('new-claim',?,'builder',1,?,?,?)")
      .run(ref.id, START.toISOString(), NOW.toISOString(), START.toISOString());
    expect(assess()).toEqual({ ok: false, reason: "task-still-active-or-held" });
  });
  test("unfinished owned run is refused without borrowing root completion", () => {
    store.handle.prepare("INSERT INTO run (task_ref,lease_id,runner,role,provider,parent_run,started_at,branch,worktree) VALUES (?,'prepared-lease','builder','repair','claude',?,?,'so/prepared',?)")
      .run(store.lookupRef("prepared")!.id, runId, START.toISOString(), join(dir, "worktree"));
    expect(assess()).toEqual({ ok: false, reason: "task-still-active-or-held" });
  });
  test("an exact stop remains fenced", () => {
    // No probe or shutdown action should run to make it eligible.
    store.handle.prepare("INSERT INTO run_stop (run,task_ref,requested_at,requested_by,requested_via) VALUES (?,?,?,'operator','cli')")
      .run(runId, store.lookupRef("prepared")!.id, NOW.toISOString());
    expect(assess()).toEqual({ ok: false, reason: "owned-run-not-settled" });
  });
  test("built status and an agent-like handoff cannot stand in for exact prepared candidate", () => {
    rewriteArtifact("handoff", value => ({ ...value, conclusion: value.conclusion.replace(CANDIDATE, "d".repeat(40)) }));
    expect(assess()).toEqual({ ok: false, reason: "machine-prepared-handoff-mismatch" });
  });
  test("current v1 receipt must describe actual passing execution, never reuse or legacy", () => {
    rewriteArtifact("structured-output", value => ({ ...value, version: 2, executedHere: false, reusedFrom: { run: runId - 1, digest: "x" } }));
    expect(assess().ok).toBe(false);
  });
  test("failed receipt and a forged machine pass do not classify as returned passing gate", () => {
    rewriteArtifact("structured-output", value => ({ ...value, result: { configured: true, ran: true, exitCode: 1 } }));
    expect(assess()).toEqual({ ok: false, reason: "verification-evidence-unavailable" });
  });
  test("missing v1 receipt refuses even where the legacy log road could verify", () => {
    store.handle.prepare("DELETE FROM artifact WHERE run = ? AND kind = 'structured-output'").run(runId);
    expect(assess()).toEqual({ ok: false, reason: "actual-v1-gate-required" });
  });
  test("a null-only ledger cannot establish the actual gate's retained direct process identity", () => {
    store.handle.prepare("DELETE FROM run_process WHERE run = ? AND pid IS NOT NULL").run(runId);
    expect(assess()).toEqual({ ok: false, reason: "known-gate-process-witness-missing" });
  });
  test("a later independent review can update decidedAt while preserving the original machine gate", () => {
    store.saveProofVerdict(runId, "short", ["Independent review still needs evidence."], NOW, [], "verified");
    expect(assess()).toMatchObject({ ok: true, binding: { machine: { verdict: "short", machineVerdict: "verified", decidedAt: NOW.toISOString() } } });
    store.handle.prepare("UPDATE artifact SET created_at = ? WHERE run = ? AND capture = 'machine verification receipt v1'").run(NOW.toISOString(), runId);
    expect(assess()).toEqual({ ok: false, reason: "actual-passing-gate-unproven" });
  });
  test("inconsistent passing-result fields refuse instead of erasing a recorded execution failure", () => {
    // The receipt schema refuses a field its result shape does not define, before eligibility reads it.
    rewriteArtifact("structured-output", value => ({ ...value, result: { ...value.result, attemptFailed: true } }));
    expect(assess()).toEqual({ ok: false, reason: "verification-evidence-unavailable" });
  });
  test("artifact byte damage refuses; honestly shortened sealed log remains explicit", () => {
    const oldLog = store.artifactsFor(runId).find(a => a.kind === "check-log")!;
    const receipt = store.artifactsFor(runId).find(a => a.kind === "structured-output")!;
    store.handle.prepare("DELETE FROM artifact WHERE id IN (?, ?)").run(oldLog.id, receipt.id);
    rmSync(join(dir, receipt.key));
    storeEvidence(store, dir, runId, "check-log", "shortened.txt", Buffer.alloc(200_000, 120), "bounded actual output", SEALED, { captureStatus: "ok" });
    sealVerificationReceipt(store, dir, runId, HEAD, store.liveVerifyCommand(REPO)!, { configured: true, ran: true, exitCode: 0 }, SEALED);
    expect(assess()).toMatchObject({ ok: true, binding: { log: { truncated: true } } });
    const log = store.artifactsFor(runId).find(a => a.kind === "check-log")!;
    writeFileSync(join(dir, log.key), "changed bytes");
    expect(assess()).toEqual({ ok: false, reason: "verification-evidence-unavailable" });
  });
});
