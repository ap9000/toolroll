/**
 * Send back as the local owner (the eight plan, F-lite): the terminal UI's `b` on a password-free laptop. `task revise
 * <id> --run <build> --feedback "…"`, run as the terminal UI runs it (runAsLocalOwner), takes its own road (task-outcome-cli.ts
 * runLocalRevision), as Accept does (runLocalCompletion): never a password check, so the sign-in guard never moves; the
 * build the screen read is pinned (a newer one current refuses, writing nothing); slice 0's limits (release, protected,
 * coordinator) refuse; the revision is the person's (origin person, actor the owner). Nothing a machine runs (a lead's
 * token, a remote API run) and no credential on the command line reaches this road, and outside the local owner's chain
 * `task revise` is the password road exactly as before.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { join } from "node:path";
import { openLocalWorld, type LocalWorld, LOCAL_WORLD_SETUP_MS } from "../local-owner-world.js";
import { RESULT_T0, resultFixtures } from "../local-owner-results.js";
import { runOperate } from "../../src/operate.js";
import { asLocalOwner, runAsLocalOwner, type LocalOwnerAct, type LocalPrincipal } from "../../src/local-owner.js";
import { withActor } from "../../src/actor.js";
import { withRemote, type RemoteRun } from "../../src/remote-run.js";
import { PasswordGuard } from "../../src/sign-in-guard.js";
import { setLocalModeOff } from "../../src/store.js";
import { createTuiSource } from "../../src/tui-source.js";
import { reviseAsLocalOwner } from "../../src/task-outcome-cli.js";

const T0 = RESULT_T0;
type Fixtures = ReturnType<typeof resultFixtures>;
let world: LocalWorld, fx: Fixtures, file: string, evidence: string;

beforeEach(async () => {
  world = await openLocalWorld();
  file = join(world.configDir, "state.db");
  evidence = join(world.configDir, "evidence");
  fx = resultFixtures(world, evidence);
  fx.prepare();
}, LOCAL_WORLD_SETUP_MS);
afterEach(async () => { vi.restoreAllMocks(); await world.close(); });

/** `task revise` exactly as the terminal UI sends it: as the local owner, with --json, on the laptop's database. */
async function terminal(id: string, args: string[]): Promise<{ code: number; envelope: Record<string, unknown> }> {
  let out = "";
  const code = await runAsLocalOwner(() => runOperate("task", ["revise", id, ...args, "--json", "--db", file], text => { out += text; }, { now: T0 }));
  return { code, envelope: JSON.parse(out.trim() || "{}") as Record<string, unknown> };
}
/** Every revision filed from a build: its id, who it came from, and who asked. */
const revisions = (runId: number) => world.store.handle.prepare(
  "SELECT DISTINCT r.external_id AS id, r.revision_origin AS origin FROM diff_comment c JOIN task_ref r ON r.backend = 'built-in' AND r.external_id = c.consumed_by WHERE c.run = ? ORDER BY r.id").all(runId);
const notes = (runId: number) => world.store.handle.prepare("SELECT author, note, consumed_by FROM diff_comment WHERE run = ? ORDER BY id").all(runId);
const owner = (act: LocalOwnerAct = "request-revision"): LocalPrincipal =>
  ({ account: "alex", localGeneration: 1, accountGeneration: world.store.accountOf("alex")!.generation, transport: "terminal", act, sessionHash: null, request: null });
function remoteRun(): RemoteRun {
  return { account: "alex", scope: "act", tokenName: "laptop", source: "api", secret: "s".repeat(32), allows: () => true, lens: null, noteTask: () => undefined, files: {} };
}

describe("the terminal UI's Send back, on the laptop's database (T0)", () => {
  test("b with a note sends the build back: a revision from the person, the owner's note, and no password attempt counted", async () => {
    const failed = vi.spyOn(PasswordGuard.prototype, "failed");
    const preflight = vi.spyOn(PasswordGuard.prototype, "preflight");
    const source = createTuiSource({ databaseFile: file, operate: { now: T0 }, clock: () => T0 });
    try {
      const result = fx.ready("ordinary");
      const read = await source.result(result.id);
      expect(read).toMatchObject({ runId: result.runId });
      const answer = await source.act({ kind: "revise", id: result.id, text: "Round the tax to cents.", runId: read!.runId });
      // Today's bug (eight F1 §1.1): the empty password went to the sign-in guard, counted against the owner.
      expect(failed).not.toHaveBeenCalled();
      expect(preflight).not.toHaveBeenCalled();
      expect(answer, JSON.stringify(answer)).toEqual({ ok: true, message: "Sent back with your note." });
      const made = revisions(result.runId);
      expect(made).toHaveLength(1);
      expect(made[0]).toMatchObject({ origin: "person" });
      expect(notes(result.runId)).toEqual([{ author: "alex", note: "Round the tax to cents.", consumed_by: made[0]!["id"] }]);
    } finally { source.close(); }
  });
});

describe("send back as the local owner, from the terminal", () => {
  test("T1: an older build pinned while a newer one is current is refused as stale, and nothing is written", async () => {
    const read = fx.ready("ordinary");
    const newer = fx.rebuild(read.id);
    const answer = await terminal(read.id, ["--run", String(read.runId), "--feedback", "Round it."]);
    expect(answer.envelope).toMatchObject({ ok: false, reason: "stale-result" });
    expect(answer.code).toBe(3);
    expect(revisions(read.runId)).toEqual([]);
    expect(revisions(newer.runId)).toEqual([]);
    expect(notes(read.runId)).toEqual([]);
    // The newer one, pinned, goes back.
    expect((await terminal(read.id, ["--run", String(newer.runId), "--feedback", "Round it."])).envelope).toMatchObject({ ok: true });
    expect(revisions(newer.runId)).toHaveLength(1);
  });

  test("T1: the TUI's pinned answer, when a newer build landed while the note was typed, is refused and leads nowhere near a password", async () => {
    const source = createTuiSource({ databaseFile: file, operate: { now: T0 }, clock: () => T0 });
    try {
      const result = fx.ready("ordinary");
      const read = await source.result(result.id);
      fx.rebuild(result.id);
      expect(await source.act({ kind: "revise", id: result.id, text: "Round it.", runId: read!.runId })).toMatchObject({ ok: false, needsPassword: false });
      expect(revisions(result.runId)).toEqual([]);
    } finally { source.close(); }
  });

  test("T2: the pin and the note are required and exact; no credential, source or key flag; nothing written for any of them", async () => {
    const result = fx.ready("ordinary");
    const run = String(result.runId);
    for (const args of [["--feedback", "Round it."], ["--run", run], ["--run", run, "--feedback", "   "], ["--run", "0", "--feedback", "x"], ["--run", "1e3", "--feedback", "x"],
      ["--run", run, "--feedback", "x", "--source", "none"], ["--run", run, "--feedback", "x", "--key", "a".repeat(32)], ["--run", run, "--feedback", "x", "--digest", "a".repeat(64)]]) {
      const answer = await terminal(result.id, args);
      expect(answer.envelope, args.join(" ")).toMatchObject({ ok: false, reason: "usage" });
      expect(answer.code).toBe(2);
    }
    // Credentials on the command line never reach the road: runOperate refuses them for the local owner first.
    for (const args of [["--token-env", "X"], ["--token", "so_x"], ["--as", "alex"], ["--token-file", join(world.root, "t")]]) {
      const answer = await terminal(result.id, ["--run", run, "--feedback", "x", ...args]);
      expect(answer.envelope, args.join(" ")).toMatchObject({ ok: false });
    }
    // A build of another task is not this task's result.
    const other = fx.ready("ordinary");
    expect((await terminal(result.id, ["--run", String(other.runId), "--feedback", "x"])).envelope).toMatchObject({ ok: false, reason: "not-found" });
    expect(revisions(result.runId)).toEqual([]);
    expect(revisions(other.runId)).toEqual([]);
  });

  test("the same note twice is one revision; replayed, it is recognised", async () => {
    const result = fx.ready("ordinary");
    const args = ["--run", String(result.runId), "--feedback", "Round it."];
    const first = await terminal(result.id, args);
    const second = await terminal(result.id, args);
    expect(first.envelope).toMatchObject({ ok: true });
    expect(second.envelope).toMatchObject({ ok: true });
    expect((second.envelope["result"] as { id: string }).id).toBe((first.envelope["result"] as { id: string }).id);
    expect(revisions(result.runId)).toHaveLength(1);
  });

  test("release, protected and coordinator work is refused, as Accept refuses it, and nothing is written", async () => {
    for (const kind of ["release", "release-record", "declared-protected", "changed-protected", "coordinator"] as const) {
      const result = fx.ready(kind);
      const answer = await terminal(result.id, ["--run", String(result.runId), "--feedback", "Round it."]);
      expect(answer.envelope, kind).toMatchObject({ ok: false, reason: "local-owner" });
      expect(String(answer.envelope["message"]), kind).toMatch(/password/);
      expect(revisions(result.runId), kind).toEqual([]);
      expect(notes(result.runId), kind).toEqual([]);
    }
  });

  test("authority gone between reading and answering: the owner's account revoked, or local mode off, refuses and writes nothing", async () => {
    const result = fx.ready("ordinary");
    expect(world.store.revokeAccount("alex", "robin", T0)).toMatchObject({ ok: true });
    expect((await terminal(result.id, ["--run", String(result.runId), "--feedback", "x"])).envelope).toMatchObject({ ok: false });
    const fresh = await openLocalWorld();
    try {
      const other = resultFixtures(fresh, join(fresh.configDir, "evidence"));
      other.prepare();
      const made = other.ready("ordinary");
      expect(setLocalModeOff(fresh.store, { name: "robin", authority: "full" }, T0)).toMatchObject({ ok: true });
      let out = "";
      await runAsLocalOwner(() => runOperate("task", ["revise", made.id, "--run", String(made.runId), "--feedback", "x", "--json", "--db", join(fresh.configDir, "state.db")], text => { out += text; }, { now: T0 }));
      expect(JSON.parse(out)).toMatchObject({ ok: false, reason: "refused" });
    } finally { await fresh.close(); }
    expect(revisions(result.runId)).toEqual([]);
  });

  test("inside the write: no owner in flight, the wrong act, a request that ended, a lead's token or a remote run in the chain is refused; never another road", () => {
    const result = fx.ready("ordinary");
    const ask = () => reviseAsLocalOwner(world.store, result.id, { runId: result.runId, feedback: "Round it." }, T0, evidence);
    expect(ask()).toMatchObject({ ok: false, reason: "local-owner" });
    for (const principal of [{ ...owner(), accountGeneration: owner().accountGeneration + 1 }, { ...owner(), localGeneration: 2 }, owner("complete-task"), owner("file-task"),
      { ...owner(), request: { ended: true } }, { ...owner(), account: "robin" }]) {
      expect(asLocalOwner(principal, ask), JSON.stringify(principal)).toMatchObject({ ok: false });
    }
    expect(asLocalOwner(owner(), () => withActor({ account: "alex", lead: true }, ask))).toMatchObject({ ok: false, reason: "local-owner" });
    expect(asLocalOwner(owner(), () => withRemote(remoteRun(), ask))).toMatchObject({ ok: false, reason: "local-owner" });
    expect(revisions(result.runId)).toEqual([]);
    expect(asLocalOwner(owner(), ask)).toMatchObject({ ok: true });
    expect(revisions(result.runId)).toHaveLength(1);
  });

  test("refused or sent, it never checks a password: the sign-in guard doesn't move", async () => {
    const failed = vi.spyOn(PasswordGuard.prototype, "failed");
    const preflight = vi.spyOn(PasswordGuard.prototype, "preflight");
    const ordinary = fx.ready("ordinary");
    const release = fx.ready("release");
    for (let press = 0; press < 5; press += 1) {
      expect((await terminal(release.id, ["--run", String(release.runId), "--feedback", "x"])).envelope).toMatchObject({ ok: false });
      expect((await terminal(ordinary.id, ["--run", String(ordinary.runId)])).envelope).toMatchObject({ ok: false });
    }
    expect((await terminal(ordinary.id, ["--run", String(ordinary.runId), "--feedback", "Round it."])).envelope).toMatchObject({ ok: true });
    expect(failed).not.toHaveBeenCalled();
    expect(preflight).not.toHaveBeenCalled();
  });

  test("outside the local owner's chain nothing changed: `task revise` is the password road, which needs a sign-in, and --json or a pipe can't use the new road", async () => {
    const result = fx.ready("ordinary");
    let out = "";
    const code = await runOperate("task", ["revise", result.id, "--run", String(result.runId), "--feedback", "Round it.", "--json", "--db", file], text => { out += text; }, { now: T0 });
    expect(code).toBe(3);
    expect(JSON.parse(out)).toMatchObject({ ok: false, reason: "unauthenticated" });
    // A lead's token in the environment, without the local owner's chain: the lead's road (refused here: not a valid token).
    out = "";
    process.env["SO_TEST_LEAD"] = "so_not_a_token";
    try {
      await runOperate("task", ["revise", result.id, "--feedback", "Round it.", "--token-env", "SO_TEST_LEAD", "--json", "--db", file], text => { out += text; }, { now: T0 });
    } finally { delete process.env["SO_TEST_LEAD"]; }
    expect(JSON.parse(out)).toMatchObject({ ok: false });
    expect(revisions(result.runId)).toEqual([]);
  });
});
