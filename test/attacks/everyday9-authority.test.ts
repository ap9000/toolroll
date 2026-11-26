/**
 * Everyday 9, A6: both browser sessions do what their authority allows, and nothing more.
 *
 * - Build again right away (Send back with its box ticked) for a signed-in approver whose own session stands in for a
 *   password (a solo install): the revision is approved in the same act through the ordinary approve() (the exact
 *   digest, the current-result guard, the revision's transaction). Where the session doesn't stand in (Passwordless off),
 *   for a viewer, outside the approver's projects, after the session ends, on protected work (a first vote is taken back
 *   whole), on a stale form or a duplicate send, it approves nothing more than before.
 * - Run checks from the local owner's session on a solo install: the already-approved command only, for work the owner
 *   could approve again now; protected work, a project whose checks run without a sandbox, a team install and an ended
 *   session are refused with nothing asked; asking twice is one request; the worker runs it only while the install still
 *   allows it.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { join } from "node:path";
import { openLocalWorld, LOCAL_T0, LOCAL_WORLD_SETUP_MS, type LocalWorld } from "../local-owner-world.js";
import { resultFixtures } from "../local-owner-results.js";
import { hashPassword } from "../../src/scope.js";
import { enrollOwnerPassword, setLocalModeOff } from "../../src/store.js";
import { register } from "../../src/runner.js";
import { savePublishing } from "../../src/pull-request-flow.js";
import { soloNow } from "../../src/install-mode.js";
import { runFollowUpCheck } from "../../src/result-follow-ups.js";
import { PASSWORDLESS_ACTION } from "../../src/passwordless.js";

const PASSWORD = "correct horse battery staple";
let world: LocalWorld;
const evidence = () => join(world.root, "evidence");
let fixtures: ReturnType<typeof resultFixtures>;

beforeEach(async () => {
  world = await openLocalWorld();
  // The fixtures' own preparation, less its second approver: this install stays solo.
  world.store.setVerifyCommand({ repo: world.repo, command: "npm test", timeoutMs: 300_000, approvedBy: "alex" }, LOCAL_T0);
  register(world.store, { name: "worker-1", host: "test", capacity: 4, repos: [world.repo], now: LOCAL_T0, newToken: () => "tok-worker-1" });
  savePublishing(world.store, { repo: world.repo, githubRepo: "alex/shop", remote: "origin", base: "main", account: "alex" }, "alex", {}, LOCAL_T0);
  fixtures = resultFixtures(world, evidence());
  expect(soloNow(world.store)).toBe(true);
}, LOCAL_WORLD_SETUP_MS);
afterEach(async () => { await world.close(); });

/** A second person on the install: team from now on. */
const secondPerson = () => world.store.handle.prepare("INSERT INTO approver (name, credential_hash, added_at) VALUES ('robin', 'x', ?)").run(LOCAL_T0.toISOString());

/** alex with a password, signed in with it: a full browser session. */
async function fullSession(): Promise<{ cookie: string; csrf: string }> {
  expect(enrollOwnerPassword(world.store, "alex", hashPassword(PASSWORD), 1, LOCAL_T0)).toMatchObject({ ok: true });
  const answer = await world.send("/login", "POST", { "content-type": "application/x-www-form-urlencoded", origin: world.origin }, new URLSearchParams({ name: "alex", token: PASSWORD }).toString());
  const cookie = [answer.headers["set-cookie"] ?? []].flat().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session=") && one !== "standing-orders_session=");
  if (cookie === undefined) throw new Error(`alex didn't sign in: ${answer.status}`);
  const csrf = (JSON.parse((await world.send("/chat?format=workspace", "GET", { cookie })).body) as { csrf: string }).csrf;
  if ((await world.post("/projects/select", cookie, { csrf, path: world.repo })).status !== 303) throw new Error("open project");
  return { cookie, csrf };
}

const scopeOf = (id: string) => world.store.getScope(id)!;
const revisions = (runId: number) => world.store.handle.prepare(
  "SELECT DISTINCT r.external_id AS id FROM diff_comment c JOIN task_ref r ON r.backend = 'built-in' AND r.external_id = c.consumed_by WHERE c.run = ? ORDER BY r.id").all(runId).map(row => String(row["id"]));
const sendBack = (session: { cookie: string; csrf: string }, result: { id: string; runId: number }, form: Record<string, string>) =>
  world.post(`/r/${result.runId}/comment`, session.cookie, { csrf: session.csrf, intent: "revise", note: "Round the tax to cents.", batch: "", source: scopeOf(result.id).digest, ...form });
const approvedNow = (child: string) => scopeOf(child).approvedDigest === scopeOf(child).digest;
const votes = (child: string) => world.store.handle.prepare("SELECT count(*) AS n FROM scope_approval_vote WHERE task_id = ?").get(child)?.["n"];

describe("Build again right away, for a signed-in approver", () => {
  test("solo: the session stands in, so the ticked send approves the revision in the same act; the same send again is the same revision", async () => {
    const session = await fullSession();
    const result = fixtures.ready("ordinary");
    expect((await sendBack(session, result, { approve: "1", request: "a".repeat(32) })).status).toBe(303);
    const made = revisions(result.runId);
    expect(made).toHaveLength(1);
    expect(approvedNow(made[0]!)).toBe(true);
    expect(world.store.lookupRef(made[0]!)?.plan ?? null).toBeNull();
    const proof = world.store.handle.prepare("SELECT outcome FROM action_ledger WHERE task_id = ? AND action = 'approval proved'").all(made[0]!).map(row => row["outcome"]);
    expect(proof).toEqual(["session"]);
    expect((await sendBack(session, result, { approve: "1", request: "a".repeat(32) })).status).toBe(303);
    expect(revisions(result.runId)).toHaveLength(1);
  });

  test("Passwordless off and no password remembered (Forget): the box approves nothing; the revision is planned and waits for its approval", async () => {
    const session = await fullSession();
    world.store.recordAction({ at: LOCAL_T0.toISOString(), actor: "alex", repo: null, taskId: null, runId: null, action: PASSWORDLESS_ACTION, outcome: "off", source: "policy", detail: "test" });
    expect((await world.post("/session/forget-password", session.cookie, { csrf: session.csrf, return: "/tasks" })).status).toBe(303);
    const result = fixtures.ready("ordinary");
    expect((await sendBack(session, result, { approve: "1", request: "b".repeat(32) })).status).toBe(303);
    const [child] = revisions(result.runId);
    expect(approvedNow(child!)).toBe(false);
    expect(world.store.lookupRef(child!)?.plan).not.toBeNull();
  });

  test("protected work: a session's first yes would only be a vote; it is taken back whole and the revision replans", async () => {
    const session = await fullSession();
    const result = fixtures.ready("declared-protected");
    await sendBack(session, result, { approve: "1", request: "c".repeat(32) });
    const [child] = revisions(result.runId);
    expect(approvedNow(child!)).toBe(false);
    expect(votes(child!)).toBe(0);
    expect(world.store.lookupRef(child!)?.plan).not.toBeNull();
  });

  test("a stale form (a newer build came in) seals and approves nothing", async () => {
    const session = await fullSession();
    const result = fixtures.ready("ordinary");
    fixtures.rebuild(result.id);
    expect((await sendBack(session, result, { approve: "1", request: "d".repeat(32) })).status).toBe(409);
    expect(revisions(result.runId)).toEqual([]);
  });

  test("a viewer, an approver outside this project and an ended session get nothing approved", async () => {
    const session = await fullSession();
    const result = fixtures.ready("ordinary");
    // Outside alex's projects now (scoped membership): the result isn't visible, nothing is filed.
    world.store.handle.prepare("UPDATE approver SET projects_json = ? WHERE name = 'alex'").run(JSON.stringify(["/elsewhere"]));
    const outside = await sendBack(session, result, { approve: "1", request: "e".repeat(32) });
    expect(outside.status).not.toBe(303);
    world.store.handle.prepare("UPDATE approver SET projects_json = NULL WHERE name = 'alex'").run();
    // A viewer's send never approves.
    world.store.handle.prepare("UPDATE approver SET role = 'viewer' WHERE name = 'alex'").run();
    await sendBack(session, result, { approve: "1", request: "f".repeat(32) });
    for (const child of revisions(result.runId)) expect(approvedNow(child)).toBe(false);
    world.store.handle.prepare("UPDATE approver SET role = 'approver' WHERE name = 'alex'").run();
    // The session ended (revoked): refused before anything is filed.
    const before = revisions(result.runId).length;
    world.store.handle.prepare("DELETE FROM web_session WHERE account = 'alex'").run();
    expect((await sendBack(session, result, { approve: "1", request: "9".repeat(32) })).status).not.toBe(303);
    expect(revisions(result.runId)).toHaveLength(before);
  });
});

// Codex round 1, finding 3: the ordinary approval's own proofs decide, on a team install too.
describe("Build again right away on a team install: the Approve button's empty-field proofs, no more", () => {
  test("a password typed at sign-in on this computer (within its window) approves the revision, recorded as fresh-password", async () => {
    secondPerson();
    expect(soloNow(world.store)).toBe(false);
    const session = await fullSession();
    const result = fixtures.ready("ordinary");
    expect((await sendBack(session, result, { approve: "1", request: "1".repeat(32) })).status).toBe(303);
    const [child] = revisions(result.runId);
    expect(approvedNow(child!)).toBe(true);
    expect(world.store.handle.prepare("SELECT outcome FROM action_ledger WHERE task_id = ? AND action = 'approval proved'").all(child!).map(row => row["outcome"])).toEqual(["fresh-password"]);
  });

  test("the window expired, or Forget: nothing approved, the revision replans", async () => {
    secondPerson();
    const session = await fullSession();
    const later = fixtures.ready("ordinary");
    const sixteen = Date.now() + 16 * 60_000;
    vi.spyOn(Date, "now").mockReturnValue(sixteen);
    try {
      await sendBack(session, later, { approve: "1", request: "2".repeat(32) });
    } finally { vi.restoreAllMocks(); }
    for (const child of revisions(later.runId)) {
      expect(approvedNow(child)).toBe(false);
      expect(world.store.lookupRef(child)?.plan).not.toBeNull();
    }
    expect((await world.post("/session/forget-password", session.cookie, { csrf: session.csrf, return: "/tasks" })).status).toBe(303);
    const forgotten = fixtures.ready("ordinary");
    expect((await sendBack(session, forgotten, { approve: "1", request: "3".repeat(32) })).status).toBe(303);
    const [child] = revisions(forgotten.runId);
    expect(approvedNow(child!)).toBe(false);
    expect(world.store.lookupRef(child!)?.plan).not.toBeNull();
  });
});

describe("Run checks from the local owner's session", () => {
  const ask = (session: { cookie: string; csrf: string }, runId: number) => world.post(`/r/${runId}/checks`, session.cookie, { csrf: session.csrf, level: "full" });
  const requests = (runId: number) => world.store.handle.prepare("SELECT actor, detail FROM action_ledger WHERE action = 'checks requested' AND run_id = ?").all(runId).map(row => ({ ...row }));

  test("solo: the approved command is asked for once, as the local owner's request; asking again is the same request", async () => {
    const session = await world.localSession();
    const result = fixtures.ready("ordinary");
    expect((await ask(session, result.runId)).status).toBe(303);
    expect((await ask(session, result.runId)).status).toBe(303);
    const asked = requests(result.runId);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ actor: "alex" });
    expect(String(asked[0]!["detail"])).toContain(" · local-owner · ");
  });

  test("protected work, a project whose checks run without a sandbox, a team install and an ended session ask for nothing", async () => {
    const session = await world.localSession();
    const protectedWork = fixtures.ready("declared-protected");
    expect((await ask(session, protectedWork.runId)).status).toBe(409);
    expect(requests(protectedWork.runId)).toEqual([]);
    const unsandboxed = fixtures.ready("ordinary");
    world.store.handle.prepare("INSERT OR REPLACE INTO project_check_access (repo, level, updated_by, updated_at) VALUES (?, 'unsandboxed', 'alex', ?)").run(world.repo, LOCAL_T0.toISOString());
    expect((await ask(session, unsandboxed.runId)).status).toBe(409);
    expect(requests(unsandboxed.runId)).toEqual([]);
    world.store.handle.prepare("DELETE FROM project_check_access WHERE repo = ?").run(world.repo);
    const ordinary = fixtures.ready("ordinary");
    secondPerson();
    expect((await ask(session, ordinary.runId)).status).not.toBe(303);
    expect(requests(ordinary.runId)).toEqual([]);
    world.store.handle.prepare("DELETE FROM approver WHERE name = 'robin'").run();
    world.store.handle.prepare("DELETE FROM web_session WHERE account = 'alex'").run();
    expect((await ask(session, ordinary.runId)).status).not.toBe(303);
    expect(requests(ordinary.runId)).toEqual([]);
  });

  test("the install became a team one after it was asked for: the worker runs none of it", async () => {
    const session = await world.localSession();
    const result = fixtures.ready("ordinary");
    expect((await ask(session, result.runId)).status).toBe(303);
    const request = Number(world.store.handle.prepare("SELECT id FROM action_ledger WHERE action = 'checks requested' AND run_id = ?").get(result.runId)!["id"]);
    secondPerson();
    let ran = 0;
    const check = await runFollowUpCheck(world.store, evidence(), request, { runner: async () => { ran += 1; return { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false }; },
      git: async () => { ran += 1; return { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false }; }, now: () => LOCAL_T0 });
    expect(ran).toBe(0);
    expect(check).toMatchObject({ state: "not-run" });
  });

  // Round 1, finding 1: the standing is read again right before every command the worker starts, not once.
  const ok = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
  async function asked(): Promise<{ request: number; runId: number }> {
    const session = await world.localSession();
    const result = fixtures.ready("ordinary");
    expect((await ask(session, result.runId)).status).toBe(303);
    return { request: Number(world.store.handle.prepare("SELECT id FROM action_ledger WHERE action = 'checks requested' AND run_id = ?").get(result.runId)!["id"]), runId: result.runId };
  }
  const commandsRun = (calls: string[][]) => calls.filter(args => args.join(" ").includes("npm test"));

  test.each([
    ["local mode turned off", () => { expect(setLocalModeOff(world.store, { name: "alex", authority: "full" }, LOCAL_T0)).toMatchObject({ ok: true }); }],
    ["a second person (team)", () => { secondPerson(); }],
    ["the project saved as unsandboxed (read before any local-mode clamp)", () => {
      world.store.handle.prepare("INSERT OR REPLACE INTO project_check_access (repo, level, updated_by, updated_at) VALUES (?, 'unsandboxed', 'alex', ?)").run(world.repo, LOCAL_T0.toISOString()); }],
  ])("changed during checkout (%s): nothing more runs", async (_name, change) => {
    const { request } = await asked();
    const calls: string[][] = [];
    let flipped = false;
    const check = await runFollowUpCheck(world.store, evidence(), request, {
      runner: async (_file, args) => { calls.push([...args]); return ok; },
      git: async (_file, args) => { if (!flipped && args.includes("add")) { flipped = true; change(); } return ok; }, now: () => LOCAL_T0 });
    expect(flipped).toBe(true);
    expect(calls).toEqual([]);
    expect(check).toMatchObject({ state: "not-run" });
  });

  test("changed during the project's setup (a second person): the check command never starts", async () => {
    world.store.setWorktreeSetup({ repo: world.repo, command: "echo prepared", timeoutMs: 60_000, approvedBy: "alex" }, LOCAL_T0);
    const { request } = await asked();
    const calls: string[][] = [];
    let setupRan = false;
    const check = await runFollowUpCheck(world.store, evidence(), request, {
      runner: async (_file, args) => {
        calls.push([...args]);
        if (!setupRan && args.join(" ").includes("echo prepared")) { setupRan = true; secondPerson(); }
        return ok;
      },
      git: async () => ok, now: () => LOCAL_T0 });
    expect(setupRan).toBe(true);
    expect(commandsRun(calls)).toEqual([]);
    expect(check).toMatchObject({ state: "not-run" });
  });
});


// Everyday-9 E2: the workbench's Run checks again is the task page's own post (POST /r/<build>/checks), sent over the
// terminal's own session as an in-place act. The console decides exactly as for the page: the live person or local
// owner, the project they can see, the exact build named, one request however often it is asked.
describe("Run checks again from the workbench: the page's own act, over the terminal's session", () => {
  const terminalAsk = (session: { cookie: string; csrf: string }, result: { id: string; runId: number }, level = "full") =>
    world.send(`/r/${result.runId}/checks`, "POST", { cookie: session.cookie, origin: world.origin, "content-type": "application/x-www-form-urlencoded", accept: "application/json",
      "x-toolroll-act": "in-place", "x-toolroll-client": "terminal" }, new URLSearchParams({ csrf: session.csrf, level, return: `/t/${result.id}` }).toString());
  const requests = (runId: number) => world.store.handle.prepare("SELECT actor, detail FROM action_ledger WHERE action = 'checks requested' AND run_id = ?").all(runId).map(row => ({ ...row }));
  const steps = async (session: { cookie: string }, id: string) => JSON.parse((await world.send(`/t/${id}/steps`, "GET", { cookie: session.cookie, accept: "application/json" })).body) as { check?: string; runChecks?: { run: number; level: string } };
  /** The project's check command approved again after the result was built: its saved check is out of date. */
  const commandChanged = (command = "npm test -- --ci", later = 60_000) => world.store.setVerifyCommand({ repo: world.repo, command, timeoutMs: 300_000, approvedBy: "alex" }, new Date(Date.now() + later));

  test("the local owner: the step cards offer it on an out-of-date check, and the post asks once, as the local owner's request", async () => {
    const session = await world.localSession();
    const result = fixtures.ready("ordinary");
    expect((await steps(session, result.id)).runChecks).toBeUndefined();
    commandChanged();
    const offered = await steps(session, result.id);
    expect(offered).toMatchObject({ check: "stale", runChecks: { run: result.runId, level: "full" } });
    expect((await terminalAsk(session, result)).status).toBe(303);
    // Asked again (a second press, a replayed post): the same one request.
    expect((await terminalAsk(session, result)).status).toBe(303);
    const asked = requests(result.runId);
    expect(asked).toHaveLength(1);
    expect(String(asked[0]!["detail"])).toContain(" · local-owner · ");
  });

  test("accepted, then its check command changed: Work's row says out of date (never failed), and it stays Complete", async () => {
    const session = await world.localSession();
    const result = fixtures.ready("ordinary");
    // The build's own check result, as the builder records it.
    world.store.recordRunCheck(result.runId, { status: "passed", exitCode: 0, suites: [] }, LOCAL_T0);
    expect((await world.post(`/t/${result.id}/complete`, session.cookie, { csrf: session.csrf, run: String(result.runId), receipt: result.digest })).status).toBe(303);
    const row = async () => (JSON.parse((await world.send("/work/rows", "GET", { cookie: session.cookie, accept: "application/json" })).body) as { rows: { id: string; status: { label: string }; check?: string }[] }).rows.find(one => one.id === result.id);
    expect(await row()).toMatchObject({ status: { label: "Complete" } });
    expect((await row())?.check).toBeUndefined();
    commandChanged();
    expect(await row()).toMatchObject({ status: { label: "Complete" }, check: "stale" });
    expect(await steps(session, result.id)).toMatchObject({ check: "stale", runChecks: { run: result.runId } });
    // Run again under the command as it stands, and passed: current again.
    expect((await terminalAsk(session, result)).status).toBe(303);
    const asked = Number(world.store.handle.prepare("SELECT id FROM action_ledger WHERE action = 'checks requested' AND run_id = ?").get(result.runId)!["id"]);
    world.store.recordAction({ at: new Date().toISOString(), actor: "system", repo: world.repo, taskId: result.id, runId: result.runId, action: "checks finished", outcome: `${asked}:passed`, source: "work", detail: "" });
    expect((await row())?.check).toBeUndefined();
    // The command changed once more: that recheck ran under the earlier command, so it is out of date again (review round 1).
    commandChanged("npm test -- --ci --strict", 120_000);
    expect(await row()).toMatchObject({ status: { label: "Complete" }, check: "stale" });
  });

  test("a signed-in approver asks as themselves; a viewer, someone outside the project and an ended session ask for nothing", async () => {
    const session = await fullSession();
    const result = fixtures.ready("ordinary");
    commandChanged();
    // Outside the project (scoped membership): the build isn't there for them.
    world.store.handle.prepare("UPDATE approver SET projects_json = ? WHERE name = 'alex'").run(JSON.stringify(["/elsewhere"]));
    expect((await terminalAsk(session, result)).status).toBe(404);
    world.store.handle.prepare("UPDATE approver SET projects_json = NULL WHERE name = 'alex'").run();
    // Made a viewer: refused in place (the session's standing is read again at the post).
    world.store.handle.prepare("UPDATE approver SET role = 'viewer' WHERE name = 'alex'").run();
    const viewer = await terminalAsk(session, result);
    expect(viewer.status).toBe(403);
    expect(JSON.parse(viewer.body)).toMatchObject({ outcome: "refused" });
    world.store.handle.prepare("UPDATE approver SET role = 'approver' WHERE name = 'alex'").run();
    expect(requests(result.runId)).toEqual([]);
    // The approver: one request, theirs (a person's, not the local owner's standing).
    expect((await terminalAsk(session, result)).status).toBe(303);
    expect(requests(result.runId)).toHaveLength(1);
    expect(requests(result.runId)[0]).toMatchObject({ actor: "alex" });
    expect(String(requests(result.runId)[0]!["detail"])).toContain(" · person · ");
    // The session ended (revoked): nothing more is asked.
    const other = fixtures.ready("ordinary");
    world.store.handle.prepare("DELETE FROM web_session WHERE account = 'alex'").run();
    expect((await terminalAsk(session, other)).status).not.toBe(303);
    expect(requests(other.runId)).toEqual([]);
  });

  test("a card read before a newer build: the post names its own build, and only that build's commit is checked", async () => {
    const session = await world.localSession();
    const result = fixtures.ready("ordinary");
    commandChanged();
    const offered = (await steps(session, result.id)).runChecks!;
    const newer = fixtures.rebuild(result.id);
    expect((await terminalAsk(session, { id: result.id, runId: offered.run })).status).toBe(303);
    expect(requests(offered.run)).toHaveLength(1);
    expect(requests(newer.runId)).toEqual([]);
  });

  test("protected work and a team install: the local owner's post asks for nothing, as on the page", async () => {
    const session = await world.localSession();
    const protectedWork = fixtures.ready("declared-protected");
    commandChanged();
    expect((await terminalAsk(session, protectedWork)).status).toBe(409);
    expect(requests(protectedWork.runId)).toEqual([]);
    const ordinary = fixtures.ready("ordinary");
    secondPerson();
    expect((await terminalAsk(session, ordinary)).status).not.toBe(303);
    expect(requests(ordinary.runId)).toEqual([]);
  });
});
