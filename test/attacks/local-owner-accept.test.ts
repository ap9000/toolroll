/**
 * Local-owner slice 1 (docs/plans/local-owner-acts.md §3, v2 item 4): the laptop's local owner accepts a result from
 * the terminal with no password. `task complete --run --digest [--checked] [--reason]`, run as the terminal UI runs it
 * (runAsLocalOwner), takes its own road: never a password check, so the sign-in guard never moves; exactly the result
 * read (a newer one refuses, writing nothing); the person's own check only with an explicit yes; an exception only with
 * a reason that says something; slice 0's limits (release, protected, coordinator) still refuse; the same request again
 * is recognised and writes nothing; a refused completion keeps no acceptance; and nothing a machine runs (the lead's
 * token, a remote API token, a coordinator) can ever make a person's check.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { join } from "node:path";
import { openLocalWorld, type LocalWorld } from "../local-owner-world.js";
import { RESULT_T0, resultFixtures, type Kind } from "../local-owner-results.js";
import { runOperate } from "../../src/operate.js";
import { asLocalOwner, runAsLocalOwner, type LocalOwnerAct, type LocalPrincipal } from "../../src/local-owner.js";
import { ACCEPT_ACTION, LOCAL_ACCEPT_ACTION, MACHINE_CANT_CHECK, acceptAndCompleteAsOperator, completeAsLocalOwner } from "../../src/assignment.js";
import { verifyApproverStanding, type VerifiedApprover } from "../../src/principal.js";
import { withActor } from "../../src/actor.js";
import { withRemote, type RemoteRun } from "../../src/remote-run.js";
import { PasswordGuard } from "../../src/sign-in-guard.js";
import { setLocalModeOff } from "../../src/store.js";
import { mintCoordinator } from "../../src/coordinator.js";
import { createTuiSource } from "../../src/tui-source.js";

const T0 = RESULT_T0;
type Fixtures = ReturnType<typeof resultFixtures>;
let world: LocalWorld, fx: Fixtures, file: string, evidence: string;

beforeEach(async () => {
  world = await openLocalWorld();
  file = join(world.configDir, "state.db");
  // A terminal command reads evidence beside its database: the results are saved there.
  evidence = join(world.configDir, "evidence");
  fx = resultFixtures(world, evidence);
  fx.prepare();
});
afterEach(async () => { vi.restoreAllMocks(); await world.close(); });

/** `task complete` exactly as the terminal UI sends it: as the local owner, with --json, on the laptop's database. */
async function terminal(id: string, args: string[], extra: string[] = []): Promise<{ code: number; envelope: Record<string, unknown> }> {
  let out = "";
  const code = await runAsLocalOwner(() => runOperate("task", ["complete", id, ...args, ...extra, "--json", "--db", file], text => { out += text; }, { now: T0 }));
  return { code, envelope: JSON.parse(out.trim() || "{}") as Record<string, unknown> };
}
const pins = (result: { runId: number; digest: string }) => ["--run", String(result.runId), "--digest", result.digest];
const rows = (sql: string, ...values: (string | number)[]) => world.store.handle.prepare(sql).all(...values);
const acceptance = (runId: number) => rows("SELECT approver, note FROM proof_acceptance WHERE run = ?", runId);
const ledger = (action: string, runId: number | null = null) => runId === null
  ? rows("SELECT actor, outcome FROM action_ledger WHERE action = ?", action)
  : rows("SELECT actor, outcome, detail FROM action_ledger WHERE action = ? AND run_id = ?", action, runId);
/** The local owner as the terminal's command binds it, in one act. */
const owner = (act: LocalOwnerAct = "complete-task"): LocalPrincipal =>
  ({ account: "alex", localGeneration: 1, accountGeneration: world.store.accountOf("alex")!.generation, transport: "terminal", act, sessionHash: null, request: null });
function person(): VerifiedApprover {
  const standing = verifyApproverStanding(world.store, "alex", world.store.accountOf("alex")!.generation, [world.repo]);
  if (!standing.ok) throw Error("standing");
  return standing.who;
}

describe("accepting in the terminal, as the local owner", () => {
  test("a result owing the person's own check is accepted with --checked: the acceptance and the completion, the owner's, from the terminal", async () => {
    const result = fx.ready("ordinary", { owed: "person-check" });
    const answer = await terminal(result.id, [...pins(result), "--checked"]);
    expect(answer.envelope, JSON.stringify(answer.envelope)).toMatchObject({ ok: true, replayed: false, accepted: "person-check" });
    expect(answer.code).toBe(0);
    expect(acceptance(result.runId)).toEqual([{ approver: "alex", note: null }]);
    expect(fx.completed(result.runId)).toBe(1);
    const bound = ledger(LOCAL_ACCEPT_ACTION, result.runId);
    expect(bound).toHaveLength(1);
    expect(bound[0]).toMatchObject({ actor: "operator:alex", outcome: "person-check" });
    expect(JSON.parse(String(bound[0]!["detail"]))).toMatchObject({ v: 1, digest: result.digest, checked: true, via: "terminal" });
  });

  test("nothing owed: a plain completion; an exception: accepted with its reason, trimmed", async () => {
    const plain = fx.ready("ordinary");
    expect((await terminal(plain.id, pins(plain))).envelope).toMatchObject({ ok: true, accepted: null });
    expect(fx.completed(plain.runId)).toBe(1);
    expect(acceptance(plain.runId)).toEqual([]);
    const exception = fx.ready("ordinary", { owed: "exception" });
    expect((await terminal(exception.id, [...pins(exception), "--reason", "  The phone layout is unchanged by this fix.  "])).envelope).toMatchObject({ ok: true, accepted: "exception" });
    expect(acceptance(exception.runId)).toEqual([{ approver: "alex", note: "The phone layout is unchanged by this fix." }]);
    expect(fx.completed(exception.runId)).toBe(1);
  });

  test("a person's check without the explicit yes, and an exception without a reason (none, empty, only spaces), are refused and write nothing", async () => {
    const check = fx.ready("ordinary", { owed: "person-check" });
    const before = fx.stateOf(check.id, check.runId);
    expect((await terminal(check.id, pins(check))).envelope).toMatchObject({ ok: false, reason: "needs-check" });
    expect(fx.stateOf(check.id, check.runId)).toBe(before);
    const exception = fx.ready("ordinary", { owed: "exception" });
    const was = fx.stateOf(exception.id, exception.runId);
    expect((await terminal(exception.id, pins(exception))).envelope).toMatchObject({ ok: false, reason: "needs-reason" });
    expect((await terminal(exception.id, pins(exception), ["--checked"])).envelope).toMatchObject({ ok: false, reason: "needs-reason" });
    for (const empty of ["", "   ", "\t \t"]) {
      const answer = await terminal(exception.id, [...pins(exception), "--reason", empty]);
      expect(answer.envelope, JSON.stringify(empty)).toMatchObject({ ok: false, reason: "usage" });
      expect(answer.code).toBe(2);
    }
    expect(fx.stateOf(exception.id, exception.runId)).toBe(was);
    expect(ledger(LOCAL_ACCEPT_ACTION)).toEqual([]);
  });

  test("the pins are required and exact; no pull request; nothing written for any of them", async () => {
    const result = fx.ready("ordinary", { owed: "person-check" });
    const before = fx.stateOf(result.id, result.runId);
    for (const args of [["--digest", result.digest, "--checked"], ["--run", String(result.runId), "--checked"], ["--run", "0", "--digest", result.digest], ["--run", String(result.runId), "--digest", "abc"]]) {
      expect((await terminal(result.id, args)).envelope, args.join(" ")).toMatchObject({ ok: false, reason: "usage" });
    }
    expect((await terminal(result.id, ["--run", String(result.runId + 1), "--digest", result.digest, "--checked"])).envelope).toMatchObject({ ok: false, reason: "stale" });
    expect((await terminal(result.id, ["--run", String(result.runId), "--digest", "f".repeat(64), "--checked"])).envelope).toMatchObject({ ok: false, reason: "stale" });
    const pr = await terminal(result.id, [...pins(result), "--checked", "--pull-request"]);
    expect(pr.envelope).toMatchObject({ ok: false, reason: "local-owner" });
    expect(String(pr.envelope["message"])).toContain("Opening a pull request needs your password.");
    expect(fx.stateOf(result.id, result.runId)).toBe(before);
    expect(world.store.pendingPublications()).toEqual([]);
  });

  test("a result replaced while the screen was open (a newer build landed) is refused, and nothing is written", async () => {
    const read = fx.ready("ordinary", { owed: "person-check" });
    const newer = fx.rebuild(read.id);
    const before = [fx.stateOf(read.id, read.runId), fx.stateOf(read.id, newer.runId)];
    const answer = await terminal(read.id, [...pins(read), "--checked"]);
    expect(answer.envelope).toMatchObject({ ok: false, reason: "stale" });
    expect(String(answer.envelope["message"])).toMatch(/changed/);
    expect([fx.stateOf(read.id, read.runId), fx.stateOf(read.id, newer.runId)]).toEqual(before);
    expect(ledger(LOCAL_ACCEPT_ACTION)).toEqual([]);
    // The new one, read and pinned in its turn, is accepted.
    expect((await terminal(read.id, pins(newer))).envelope).toMatchObject({ ok: true });
  });

  test("authority gone between reading and answering: local mode off, or the owner's account revoked, refuses and writes nothing", async () => {
    const result = fx.ready("ordinary", { owed: "person-check" });
    const before = fx.stateOf(result.id, result.runId);
    expect(world.store.revokeAccount("alex", "robin", T0)).toMatchObject({ ok: true });
    expect((await terminal(result.id, [...pins(result), "--checked"])).envelope).toMatchObject({ ok: false });
    expect(fx.stateOf(result.id, result.runId)).toBe(before);
    const other = fx.ready("ordinary", { owed: "person-check" });
    const was = fx.stateOf(other.id, other.runId);
    expect(setLocalModeOff(world.store, { name: "robin", authority: "full" }, T0)).toMatchObject({ ok: true });
    expect((await terminal(other.id, [...pins(other), "--checked"])).envelope).toMatchObject({ ok: false, reason: "refused" });
    expect(fx.stateOf(other.id, other.runId)).toBe(was);
    expect(acceptance(result.runId)).toEqual([]);
    expect(acceptance(other.runId)).toEqual([]);
  });

  test("inside the write, a bound owner that no longer stands, the wrong act, or a request that ended is refused; it never falls through to another road", () => {
    const result = fx.ready("ordinary", { owed: "person-check" });
    const before = fx.stateOf(result.id, result.runId);
    const ask = () => completeAsLocalOwner(world.store, result.id, { runId: result.runId, receiptDigest: result.digest, checked: true, reason: null }, T0, evidence);
    // No local owner in flight: this road refuses (it is never full authority).
    expect(ask()).toMatchObject({ ok: false, reason: "local-owner" });
    for (const principal of [{ ...owner(), accountGeneration: owner().accountGeneration + 1 }, { ...owner(), localGeneration: 2 }, owner("file-task"), owner("approve-plan"),
      { ...owner(), request: { ended: true } }, { ...owner(), account: "robin" }]) {
      expect(asLocalOwner(principal, ask), JSON.stringify(principal)).toMatchObject({ ok: false });
    }
    // A lead's token or a remote API run in the chain is never the local owner.
    expect(asLocalOwner(owner(), () => withActor({ account: "alex", lead: true }, ask))).toMatchObject({ ok: false, reason: "local-owner" });
    expect(asLocalOwner(owner(), () => withRemote(remoteRun(), ask))).toMatchObject({ ok: false, reason: "local-owner" });
    expect(fx.stateOf(result.id, result.runId)).toBe(before);
    expect(asLocalOwner(owner(), ask)).toMatchObject({ ok: true });
  });

  test("the same request twice: one acceptance, one completion, the second recognised as already done; a different one refuses", async () => {
    const result = fx.ready("ordinary", { owed: "person-check" });
    const [first, second] = await Promise.all([terminal(result.id, [...pins(result), "--checked"]), terminal(result.id, [...pins(result), "--checked"])]);
    expect([first.envelope["ok"], second.envelope["ok"]]).toEqual([true, true]);
    expect([first.envelope["replayed"], second.envelope["replayed"]].sort()).toEqual([false, true]);
    const third = await terminal(result.id, [...pins(result), "--checked"]);
    expect(third.envelope).toMatchObject({ ok: true, replayed: true, accepted: "person-check" });
    expect(acceptance(result.runId)).toHaveLength(1);
    expect(fx.completed(result.runId)).toBe(1);
    expect(ledger(ACCEPT_ACTION)).toHaveLength(1);
    expect(ledger(LOCAL_ACCEPT_ACTION, result.runId)).toHaveLength(1);
    const after = fx.stateOf(result.id, result.runId);
    // The receipt the acceptance produced, or any other: not this request; refused and nothing written.
    const done = String((third.envelope["result"] as { receipt: { digest: string } }).receipt.digest);
    expect((await terminal(result.id, ["--run", String(result.runId), "--digest", done, "--checked"])).envelope).toMatchObject({ ok: false, reason: "already-complete" });
    expect((await terminal(result.id, ["--run", String(result.runId), "--digest", "0".repeat(64), "--checked"])).envelope).toMatchObject({ ok: false, reason: "stale" });
    expect(fx.stateOf(result.id, result.runId)).toBe(after);
    // The same request again once the owner no longer stands: re-proved first, so refused.
    expect(setLocalModeOff(world.store, { name: "alex", authority: "full" }, T0)).toMatchObject({ ok: true });
    expect((await terminal(result.id, [...pins(result), "--checked"])).envelope).toMatchObject({ ok: false });
  });

  test("a refused completion keeps no acceptance: a person's check on a result whose check failed, from the terminal", async () => {
    const result = fx.ready("ordinary", { owed: "person-check", check: "failed" });
    const before = fx.stateOf(result.id, result.runId);
    const answer = await terminal(result.id, [...pins(result), "--checked"]);
    expect(answer.envelope).toMatchObject({ ok: false, reason: "not-ready" });
    expect(String(answer.envelope["message"])).toMatch(/Checks failed/);
    expect(fx.stateOf(result.id, result.runId)).toBe(before);
    expect(ledger(ACCEPT_ACTION)).toEqual([]);
    expect(ledger(LOCAL_ACCEPT_ACTION)).toEqual([]);
  });

  test("release, protected and coordinator results are still refused from the terminal (slice 0), with a person's check and without", async () => {
    for (const kind of ["release", "release-record", "declared-protected", "changed-protected", "coordinator"] as const satisfies readonly Kind[]) {
      for (const owed of ["nothing", "person-check"] as const) {
        const result = fx.ready(kind, { owed });
        const before = fx.stateOf(result.id, result.runId);
        const answer = await terminal(result.id, [...pins(result), "--checked"]);
        expect(answer.envelope, `${kind} ${owed}`).toMatchObject({ ok: false, reason: "local-owner" });
        expect(String(answer.envelope["message"])).toMatch(/password/);
        expect(fx.stateOf(result.id, result.runId)).toBe(before);
      }
    }
    expect(ledger(LOCAL_ACCEPT_ACTION)).toEqual([]);
  });

  test("refused or accepted, the terminal's accept never checks a password: the sign-in guard doesn't move", async () => {
    const failed = vi.spyOn(PasswordGuard.prototype, "failed");
    const preflight = vi.spyOn(PasswordGuard.prototype, "preflight");
    const owed = fx.ready("ordinary", { owed: "person-check" });
    const release = fx.ready("release");
    for (let press = 0; press < 5; press += 1) {
      expect((await terminal(owed.id, pins(owed))).envelope).toMatchObject({ ok: false });
      expect((await terminal(release.id, [...pins(release), "--checked"])).envelope).toMatchObject({ ok: false });
    }
    expect((await terminal(owed.id, [...pins(owed), "--checked"])).envelope).toMatchObject({ ok: true });
    expect(failed).not.toHaveBeenCalled();
    expect(preflight).not.toHaveBeenCalled();
  });

  test("outside the terminal's local owner nothing changed: the flags are not the password road's, which asks for a sign-in as before", async () => {
    const result = fx.ready("ordinary", { owed: "person-check" });
    let out = "";
    await runOperate("task", ["complete", result.id, ...pins(result), "--checked", "--json", "--db", file], text => { out += text; }, { now: T0 });
    expect(JSON.parse(out)).toMatchObject({ ok: false, reason: "usage" });
    out = "";
    await runOperate("task", ["complete", result.id, "--digest", result.digest, "--json", "--db", file], text => { out += text; }, { now: T0 });
    expect(JSON.parse(out)).toMatchObject({ ok: false, reason: "unauthenticated" });
    expect(acceptance(result.runId)).toEqual([]);
    expect(fx.completed(result.runId)).toBe(0);
  });
});

function remoteRun(): RemoteRun {
  return { account: "alex", scope: "act", tokenName: "laptop", source: "api", secret: "s".repeat(32), allows: () => true, lens: null, noteTask: () => undefined, files: {} };
}

describe("a machine can never make a person's check", () => {
  test("the lead's token and a remote API token: Accept and finish on a result owing a person's check is refused, and no acceptance is written", () => {
    const who = person();
    for (const [name, run] of [["lead", <T,>(body: () => T) => withActor({ account: "alex", lead: true }, body)], ["remote API token", <T,>(body: () => T) => withRemote(remoteRun(), body)]] as const) {
      const result = fx.ready("ordinary", { owed: "person-check" });
      const before = fx.stateOf(result.id, result.runId);
      expect(run(() => acceptAndCompleteAsOperator(world.store, result.id, { runId: result.runId, receiptDigest: result.digest, note: null }, who, T0, evidence)), name)
        .toEqual({ ok: false, reason: "person-required", message: MACHINE_CANT_CHECK });
      expect(fx.stateOf(result.id, result.runId)).toBe(before);
      expect(acceptance(result.runId)).toEqual([]);
    }
    // A person (no machine in the chain) still accepts it, as today.
    const result = fx.ready("ordinary", { owed: "person-check" });
    expect(acceptAndCompleteAsOperator(world.store, result.id, { runId: result.runId, receiptDigest: result.digest, note: null }, who, T0, evidence)).toMatchObject({ ok: true });
    expect(acceptance(result.runId)).toEqual([{ approver: "alex", note: null }]);
  });

  test("a coordinator's credential completing from the CLI never records a person's check", async () => {
    const minted = mintCoordinator(world.store, { name: "helper", repos: [world.repo], by: "alex", now: T0 });
    if (!minted.ok) throw Error(minted.reason);
    const result = fx.ready("ordinary", { owed: "person-check" });
    let out = "";
    process.env["SO_TEST_COORDINATOR"] = minted.token;
    try {
      await runOperate("task", ["complete", result.id, "--digest", result.digest, "--token-env", "SO_TEST_COORDINATOR", "--json", "--db", file], text => { out += text; }, { now: T0 });
    } finally { delete process.env["SO_TEST_COORDINATOR"]; }
    expect(out).not.toBe("");
    expect(acceptance(result.runId)).toEqual([]);
  });
});

describe("a refused completion takes its acceptance back, even inside a caller's own transaction", () => {
  test("Accept and finish nested in an outer transaction (the terminal's road, a chat tap): the refused finish leaves no acceptance", () => {
    const who = person();
    const result = fx.ready("ordinary", { owed: "person-check" });
    const before = fx.stateOf(result.id, result.runId);
    const answer = world.store.transact(() => acceptAndCompleteAsOperator(world.store, result.id, { runId: result.runId, receiptDigest: result.digest, note: null }, who, T0, evidence,
      () => ({ ok: false, reason: "not-ready", message: "Refused after the acceptance." })));
    expect(answer).toEqual({ ok: false, reason: "not-ready", message: "Refused after the acceptance." });
    expect(fx.stateOf(result.id, result.runId)).toBe(before);
    expect(acceptance(result.runId)).toEqual([]);
    expect(ledger(ACCEPT_ACTION)).toEqual([]);
  });
});

describe("the terminal UI's Accept, on the laptop's database", () => {
  test("the screen's read pins the result and shows what it is; its answer sends exactly those pins; a newer result is refused as changed", async () => {
    const source = createTuiSource({ databaseFile: file, operate: { now: T0 }, clock: () => T0 });
    try {
      const result = fx.ready("ordinary", { owed: "person-check" });
      const read = await source.result(result.id);
      expect(read).toMatchObject({ id: result.id, runId: result.runId, digest: result.digest, ready: true, owed: "person-check",
        summary: ["Totals now include tax."], files: { names: ["src/total.ts"], more: 0 } });
      expect(read!.requirements).toEqual([{ word: "Met", statement: "Totals add up." }, { word: "You check", statement: "The receipt reads well on a phone." }]);
      expect(read!.checks.length).toBeGreaterThan(0);
      // Cancelling sends nothing: nothing is written.
      expect(acceptance(result.runId)).toEqual([]);
      // A newer build lands while the screen is open: the pinned answer is refused as changed, and nothing is written.
      const newer = fx.rebuild(result.id);
      const before = fx.stateOf(result.id, newer.runId);
      expect(await source.act({ kind: "complete", id: read!.id, runId: read!.runId, digest: read!.digest, checked: true, reason: null }))
        .toMatchObject({ ok: false, changed: true, needsPassword: false });
      expect(fx.stateOf(result.id, newer.runId)).toBe(before);
      // The new one, read again and pinned, is accepted; the same answer again is already done.
      const again = await source.result(result.id);
      expect(again).toMatchObject({ runId: newer.runId, digest: newer.digest, owed: null });
      const answer = { kind: "complete" as const, id: again!.id, runId: again!.runId, digest: again!.digest, checked: false, reason: null };
      expect(await source.act(answer)).toEqual({ ok: true, message: "Accepted. The task is done." });
      expect(await source.act(answer)).toEqual({ ok: true, message: "Already accepted. The task is done." });
      expect(fx.completed(newer.runId)).toBe(1);
      // A release result: refused, and it leads to a password.
      const release = fx.ready("release");
      const shown = await source.result(release.id);
      expect(await source.act({ kind: "complete", id: shown!.id, runId: shown!.runId, digest: shown!.digest, checked: false, reason: null })).toMatchObject({ ok: false, needsPassword: true });
    } finally { source.close(); }
  });
});
