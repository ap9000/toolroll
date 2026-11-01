/**
 * Attack: widening or forging "filed by your lead" on Agents → Live (docs/plans/lead-dispatched-tiles.md). A run the
 * viewer's own lead filed nests under that lead; the grouping is proved from the store per request, only for the
 * thread's owner, and only for tiles the viewer already gets. Tried here, through the real console:
 *   - another viewer who can see the same run (robin) gets no link to alex's lead, and no tile it couldn't see;
 *   - a forged link: a confirmed task card whose outcome names a task alex never filed through the lead, or a card the
 *     model drafted that was never confirmed, or one in someone else's thread;
 *   - a stale link: the thread now belongs to a team conversation, or the card was confirmed by someone else;
 *   - a token caller (lead credential, runner, remote API token) is refused and reads no link.
 * Positive control: alex's own confirmed card links alex's run, and the cookie answer says so.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { acquire } from "../../src/claim.js";
import { register } from "../../src/runner.js";
import { addApprover } from "../../src/scope.js";
import { createDecisionServer } from "../../src/serve.js";
import { openStore, type Store } from "../../src/store.js";
import { presented, T0 } from "../serve-kit.js";

let store: Store, server: Server, base: string, evidenceRoot: string, repoA: string, repoB: string;
let alexToken: string, robinToken: string;

beforeEach(async () => {
  store = openStore(":memory:");
  for (const phase of ["plan", "build", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", T0);
  evidenceRoot = mkdtempSync(join(tmpdir(), "so-filed-ev-"));
  repoA = realpathSync(mkdtempSync(join(tmpdir(), "so-filed-a-")));
  repoB = realpathSync(mkdtempSync(join(tmpdir(), "so-filed-b-")));
  const alex = addApprover(store, "alex", T0);
  if (!alex.ok) throw new Error("bootstrap failed");
  alexToken = alex.token;
  const robin = addApprover(store, "robin", T0, { name: "alex", token: alexToken });
  if (!robin.ok) throw new Error("robin");
  robinToken = robin.token;
  // Robin sees project B only; alex sees both.
  expect(store.setAccountProjects("robin", [repoB], "alex", T0)).toEqual({ ok: true });
  register(store, { name: "builder-1", host: "here", capacity: 8, repos: [repoA, repoB], now: new Date(), newToken: () => "tok-builder-1" });
  server = createDecisionServer({ store, evidenceRoot, repos: [repoA, repoB], clock: () => new Date(), localRunner: "builder-1" });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("no address");
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  server.closeAllConnections?.();
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  for (const dir of [evidenceRoot, repoA, repoB]) rmSync(dir, { recursive: true, force: true });
});

const sql = (text: string, ...args: (string | number | null)[]) => store.handle.prepare(text).run(...args);
async function login(name: string, token: string): Promise<string> {
  const response = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name, token }), redirect: "manual" });
  expect(response.status).toBe(303);
  return (response.headers.get("set-cookie") ?? "").split(";")[0]!;
}
/** A task filed through the lead by `by`, running now. */
function running(id: string, repo: string, by = "alex"): number {
  store.createTask({ id, title: `Fix ${id}`, filedBy: { name: by, kind: "person" } }, T0);
  const ref = store.refFor("built-in", id, "ours").id;
  sql("UPDATE task_ref SET filed_via = 'mate' WHERE id = ?", ref);
  store.placeTask(ref, repo);
  const taken = acquire(store, ref, "builder-1", { token: "tok-builder-1", now: new Date(), ttlMs: 3_600_000 });
  if (!taken.ok) throw new Error("claim failed");
  return store.startRun({ taskRef: ref, leaseId: taken.claim.leaseId, runner: "builder-1", branch: `b-${id}`, worktree: join(evidenceRoot, id), now: new Date(), ...presented(store, ref, "builder") });
}
let turn = 0;
function card(thread: number, taskId: string, repo: string, options: { state?: string; by?: string } = {}) {
  sql(`INSERT INTO lead_proposal (thread, turn, kind, payload_json, ceiling_digest, state, created_at, resolved_at, resolved_by, outcome_json) VALUES (?, ?, 'task', ?, 'D', ?, ?, ?, ?, ?)`,
    thread, ++turn, JSON.stringify({ repo, title: taskId, goal: "g" }), options.state ?? "confirmed", T0.toISOString(), T0.toISOString(), options.by ?? "alex",
    options.state === "pending" ? null : JSON.stringify({ ok: true, kind: "task", said: "filed", taskId, via: "web" }));
}
type Tile = { runId: number; filedBy: { thread: number; chat: string } | null };
const tilesOf = async (cookie: string): Promise<Tile[]> => {
  const response = await fetch(`${base}/agents/live`, { headers: { cookie } });
  expect(response.status).toBe(200);
  return ((await response.json()) as { tiles: Tile[] }).tiles;
};
const linkOf = (tiles: Tile[], run: number) => tiles.find(tile => tile.runId === run)?.filedBy;

describe("attack: widening or forging the lead a run nests under", () => {
  test("only the owner's own lead links; another viewer of the same run gets none, and nothing it couldn't see", async () => {
    const thread = store.openLeadThread("alex", "D", T0).thread.id;
    const shared = running("shared", repoB), hidden = running("hidden", repoA);
    card(thread, "shared", repoB);
    card(thread, "hidden", repoA);
    const alex = await tilesOf(await login("alex", alexToken));
    expect(linkOf(alex, shared)).toEqual({ thread, chat: "lead" });
    expect(linkOf(alex, hidden)).toEqual({ thread, chat: "lead" });
    // Grouping never changes which runs are delivered: without any link, alex gets exactly the same runs.
    sql("DELETE FROM lead_proposal");
    expect((await tilesOf(await login("alex", alexToken))).map(tile => tile.runId).sort()).toEqual(alex.map(tile => tile.runId).sort());
    card(thread, "shared", repoB);
    const robin = await tilesOf(await login("robin", robinToken));
    expect(robin.map(tile => tile.runId)).toEqual([shared]); // never the run in project A
    expect(linkOf(robin, shared)).toBeNull();
    // Robin's own thread holding a card that names alex's task links nothing either: the task is not robin's.
    card(store.openLeadThread("robin", "D", T0).thread.id, "shared", repoB, { by: "robin" });
    expect(linkOf(await tilesOf(await login("robin", robinToken)), shared)).toBeNull();
  });

  test("forged links: a card for a task alex never filed through the lead, a draft never confirmed, a card in another's thread", async () => {
    const thread = store.openLeadThread("alex", "D", T0).thread.id;
    const robins = running("robins", repoB, "robin"); // filed by robin: alex's card can't claim it
    const viaConsole = running("console", repoB);
    sql("UPDATE task_ref SET filed_via = 'console' WHERE external_id = 'console'");
    const drafted = running("drafted", repoB);
    const elsewhere = running("elsewhere", repoB);
    card(thread, "robins", repoB);
    card(thread, "console", repoB);
    card(thread, "drafted", repoB, { state: "pending" });
    card(store.openLeadThread("robin", "D", T0).thread.id, "elsewhere", repoB);
    const alex = await tilesOf(await login("alex", alexToken));
    for (const run of [robins, viaConsole, drafted, elsewhere]) expect(linkOf(alex, run), `run ${run}`).toBeNull();
    // The forged links only fall back: every run is still a tile, once.
    expect(alex.map(tile => tile.runId).sort()).toEqual([robins, viaConsole, drafted, elsewhere].sort());
  });

  test("stale links: a thread now a team conversation's, a card someone else confirmed", async () => {
    const thread = store.openLeadThread("alex", "D", T0).thread.id;
    const team = running("team", repoB), confirmedByOther = running("other", repoB);
    card(thread, "team", repoB);
    const cookie = await login("alex", alexToken);
    expect(linkOf(await tilesOf(cookie), team)).toEqual({ thread, chat: "lead" });
    store.handle.exec("PRAGMA foreign_keys = OFF");
    sql("INSERT INTO team_conversation (id, lead, title, visibility, projects_json, thread, created_by, created_at) VALUES ('c1', 'l1', 't', 'private', '[]', ?, 'alex', ?)", thread, T0.toISOString());
    store.handle.exec("PRAGMA foreign_keys = ON");
    const second = store.openLeadThread("alex", "D", T0, { kind: "project", key: repoB }).thread.id;
    card(second, "other", repoB, { by: "robin" });
    const now = await tilesOf(cookie);
    expect(linkOf(now, team)).toBeNull();
    expect(linkOf(now, confirmedByOther)).toBeNull();
  });

  test("a token caller is refused and reads no link; the cookie session is the positive control", async () => {
    const thread = store.openLeadThread("alex", "D", T0).thread.id;
    const run = running("tokened", repoB);
    card(thread, "tokened", repoB);
    const { mintApiToken } = await import("../../src/api-tokens.js");
    const remote = mintApiToken();
    store.createApiToken({ id: remote.id, account: "alex", name: "laptop", secretHash: remote.hash, access: "act", projects: null,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(), by: "alex" }, new Date());
    const lead = store.mintLeadCredential("alex", "alex", new Date()).token;
    for (const bearer of [lead, "tok-builder-1", remote.token, alexToken]) {
      const response = await fetch(`${base}/agents/live`, { headers: { authorization: `Bearer ${bearer}` }, redirect: "manual" });
      expect([303, 401, 403], bearer.slice(0, 3)).toContain(response.status);
      expect(await response.text()).not.toContain("filedBy");
    }
    expect(linkOf(await tilesOf(await login("alex", alexToken)), run)).toEqual({ thread, chat: "lead" });
  });
});
