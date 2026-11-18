/**
 * The sign-in relay's dispatch binding (flexible-relay.ts with flexible-sign-in.ts): every call is sent with the sign-in
 * of the person who started the thread, of one generation, re-checked inside the call's reservation, and recorded with
 * it; Claude refusing that sign-in refuses exactly that generation, answers the agent with Toolroll's own 403 and ends
 * the turn. Against the real relay and a scripted stand-in for the model service (flexible-relay-upstreams.ts replaced
 * by vi.mock, as in flexible-relay.test.ts). Made-up tokens in the test's own files store; no model is called.
 *
 * "R1" rows are Codex's first final requirement (the dispatch invariant), one named test each.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { rmSync } from "node:fs";
import { flexibleDigestOf, flexibleTermsJson, type FlexibleTerms } from "./flexible.js";
import { admitFlexibleTurn, beginFlexibleTurn, flexibleTurn } from "./flexible-turns.js";
import { prepareFlexibleThread } from "./flexible-thread.js";
import { startFlexibleRelay, type FlexibleRelayServer } from "./flexible-relay.js";
import { flexibleSignInBilling, flexibleSignInStatus, signInStandsAt } from "./flexible-sign-in.js";
import { hashPassword } from "./scope.js";
import { threadWorld, type ThreadWorld } from "../test/flexible-thread-world.js";
import { fakePid } from "../test/fake-pid.js";
import { removeStandInSignIn, standInSignIn } from "../test/flexible-sign-in-kit.js";

vi.mock("./flexible-available.js", async original => ({ ...await original<typeof import("./flexible-available.js")>(), flexibleAvailable: () => true }));
const scripted = vi.hoisted(() => ({ origin: "http://127.0.0.1:9" }));
vi.mock("./flexible-relay-upstreams.js", async importOriginal => {
  const real = await importOriginal<typeof import("./flexible-relay-upstreams.js")>();
  return { FLEXIBLE_RELAY_UPSTREAMS: { claude: { ...real.FLEXIBLE_RELAY_UPSTREAMS.claude, get origin() { return scripted.origin; } } } };
});

const NOW = new Date();
const MESSAGE = JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: "hello" }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 2 } });
const BODY = { model: "claude-sonnet-4-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] };
type Seen = { url: string; headers: IncomingHttpHeaders };
let world: ThreadWorld, digest: string, upstream: Server, seen: Seen[], script: (request: IncomingMessage, response: ServerResponse) => void;
const relays: FlexibleRelayServer[] = [];

/** A ready thread of `by`'s, its relay, a running turn of `owner`'s (its starter, unless a test says otherwise), and a
 * live launch's relay token. */
async function thread(by = "alex", owner = by): Promise<{ id: string; relay: FlexibleRelayServer; turn: string; token: string }> {
  const made = await prepareFlexibleThread(world.store, { repo: world.project, base: "HEAD", by, now: NOW });
  if (!made.ok) throw new Error(made.message);
  const id = made.thread.id;
  const started = await startFlexibleRelay(world.store, { thread: id });
  if ("ok" in started) throw new Error(started.message);
  relays.push(started);
  const turn = admitAndBegin(id, by);
  if (owner !== by) {
    // A record tampered with (its written-once guard taken away first): the turn's owner isn't the thread's starter.
    world.store.handle.exec("DROP TRIGGER thread_turn_written_once");
    world.store.handle.prepare("UPDATE thread_turn SET owner = ?, owner_generation = ? WHERE id = ?").run(owner, world.store.accountOf(owner)!.generation, turn);
  }
  const launch = randomBytes(16).toString("hex");
  world.store.handle.prepare(`INSERT INTO flexible_thread_launch (id, thread, provider, level, fence_digest, holder, host, marker, leader_pid, leader_start, state, started_at)
    VALUES (?, ?, 'claude', 'full', ?, 'h1', 'here', ?, ?, 't1', 'live', ?)`).run(launch, id, "f".repeat(32), "9".repeat(32), fakePid(relays.length), NOW.toISOString());
  return { id, relay: started, turn, token: started.issue({ thread: id, turn, launch }).token };
}
function admitAndBegin(id: string, by: string): string {
  const made = admitFlexibleTurn(world.store, { thread: id, starter: { name: by, generation: world.store.accountOf(by)!.generation }, digest, level: "full", freshProof: false,
    provider: "claude", model: "claude-sonnet-4-5", billing: "subscription", requestKey: `m-${randomBytes(4).toString("hex")}`, holder: "h1", clock: () => NOW });
  if (!made.ok) throw new Error(`${made.reason}: ${made.message}`);
  const begun = beginFlexibleTurn(world.store, { turn: made.turn, holder: "h1", clock: () => NOW });
  if (!begun.ok) throw new Error(begun.message);
  return made.turn;
}
const call = (one: { relay: FlexibleRelayServer; token: string }) => fetch(`${one.relay.url}/v1/messages`, { method: "POST",
  headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", authorization: `Bearer ${one.token}` }, body: JSON.stringify(BODY) });
const records = () => world.store.handle.prepare("SELECT thread, status, reason, http_status, sign_in_person, sign_in_generation, sign_in_refused FROM thread_relay_call ORDER BY id").all().map(row => ({ ...row }));

beforeEach(async () => {
  world = threadWorld();
  world.store.saveApprover("alex", hashPassword("alex-password-1"), NOW);
  world.store.saveApprover("bob", hashPassword("bob-password-22"), NOW);
  const terms: FlexibleTerms = { version: 1, repo: world.project, signer: "alex", signerGeneration: world.store.accountOf("alex")!.generation, starters: "approvers-with-access", passwordFreeUpTo: "full", max: "full", default: "full",
    network: "confined", caps: { liveThreads: 5, turnsPerDayProject: 300, turnsPerDayPerson: 150, measuredMicrousdPerDay: null } };
  digest = flexibleDigestOf(terms);
  world.store.handle.prepare(`INSERT INTO flexible_terms (repo, terms_json, digest, signed_terms_json, signed_digest, signed_by, signed_at, proof, changed_by, changed_at)
    VALUES (?, ?, ?, ?, ?, 'alex', ?, 'password-now', 'alex', ?)`).run(world.project, flexibleTermsJson(terms), digest, flexibleTermsJson(terms), digest, NOW.toISOString(), NOW.toISOString());
  seen = [];
  script = (_request, response) => { response.writeHead(200, { "content-type": "application/json" }).end(MESSAGE); };
  upstream = createServer((request, response) => {
    request.resume();
    request.on("end", () => { seen.push({ url: request.url ?? "", headers: request.headers }); script(request, response); });
  });
  await new Promise<void>(done => upstream.listen(0, "127.0.0.1", () => done()));
  const address = upstream.address();
  scripted.origin = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
});
afterEach(async () => {
  for (const relay of relays.splice(0)) await relay.close();
  upstream.closeAllConnections();
  await new Promise(done => upstream.close(done));
  world.store.close();
  rmSync(world.dir, { recursive: true, force: true });
});

describe("R1: the dispatch invariant", () => {
  test("R1 each call goes with the thread's starter's own sign-in, of one generation, recorded on the call; never another person's", async () => {
    const alex = standInSignIn(world.store, world.state, "alex");
    const bob = standInSignIn(world.store, world.state, "bob");
    const mine = await thread("alex");
    expect((await call(mine)).status).toBe(200);
    expect(seen.map(one => one.headers.authorization)).toEqual([`Bearer ${alex.value}`]);
    expect(records()).toEqual([expect.objectContaining({ status: "completed", sign_in_person: "alex", sign_in_generation: alex.generation, sign_in_refused: null })]);
    // A thread whose starter has no sign-in never uses anyone else's: bob's own thread, after his is removed.
    const his = await thread("bob");
    removeStandInSignIn(world.store, "bob");
    expect((await call(his)).status).toBe(403);
    expect(seen).toHaveLength(1);
    expect(records().at(-1)).toMatchObject({ status: "refused", reason: "no-sign-in", sign_in_person: null });
    // A turn whose owner isn't the thread's starter (a record tampered with): refused, never sent with either sign-in.
    standInSignIn(world.store, world.state, "bob");
    const crossed = await thread("alex", "bob");
    expect((await call(crossed)).status).toBe(409);
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen)).not.toContain(bob.value);
  });

  test("R1 an old running turn after its owner's account rotation is refused, and still after a new sign-in is saved; nothing is sent", async () => {
    standInSignIn(world.store, world.state, "alex");
    const one = await thread("alex");
    expect((await call(one)).status).toBe(200);
    // A password reset moves the account's generation: the turn (and the sign-in) were made at the old one.
    world.store.saveApprover("alex", hashPassword("alex-password-2"), NOW);
    expect((await call(one)).status).toBe(403);
    expect(records().at(-1)).toMatchObject({ status: "refused", reason: "no-sign-in" });
    // A new sign-in at the new generation doesn't revive the old turn: it was admitted at the old one.
    standInSignIn(world.store, world.state, "alex");
    expect((await call(one)).status).toBe(403);
    expect(seen).toHaveLength(1);
    expect(flexibleTurn(world.store, one.turn)!.status).toBe("running");
  });

  test("R1 an old running turn after a new sign-in save uses the new generation from its next call, never the old one", async () => {
    const first = standInSignIn(world.store, world.state, "alex");
    const one = await thread("alex");
    expect((await call(one)).status).toBe(200);
    const second = standInSignIn(world.store, world.state, "alex");
    expect((await call(one)).status).toBe(200);
    expect(seen.map(row => row.headers.authorization)).toEqual([`Bearer ${first.value}`, `Bearer ${second.value}`]);
    expect(records().map(row => row["sign_in_generation"])).toEqual([first.generation, second.generation]);
  });

  test("R1 the reservation checks it again: a removal, a replacement, an account rotation or a refusal between the read and the reservation refuses, and nothing is sent", async () => {
    for (const change of ["removed", "replaced", "rotated", "refused"] as const) {
      const signIn = standInSignIn(world.store, world.state, "alex");
      const one = await thread("alex");
      const db = world.store.handle;
      const prepare = db.prepare.bind(db);
      let reads = 0;
      // The second read of the running turn is the one inside the reservation transaction: the sign-in changes just then.
      db.prepare = ((sql: string) => {
        if (sql === "SELECT id FROM thread_turn WHERE thread = ? AND status = 'running'" && ++reads === 2) {
          if (change === "removed") removeStandInSignIn(world.store, "alex");
          else if (change === "replaced") standInSignIn(world.store, world.state, "alex");
          else if (change === "rotated") world.store.handle.prepare("UPDATE approver SET generation = generation + 1 WHERE name = 'alex'").run();
          else world.store.handle.prepare(`INSERT INTO thread_relay_call (thread, turn, launch, upstream, at, ended_at, route, streamed, status, http_status, cost_basis, sign_in_person, sign_in_generation, sign_in_refused)
            VALUES (?, ?, ?, 'claude', 't', 't', 'messages', 0, 'upstream-error', 401, 'estimated', 'alex', ?, 1)`).run(one.id, one.turn, "0".repeat(32), signIn.generation);
        }
        return prepare(sql);
      }) as typeof db.prepare;
      try { expect((await call(one)).status, change).toBe(403); } finally { db.prepare = prepare as typeof db.prepare; }
      expect(records().at(-1), change).toMatchObject({ status: "refused", reason: change === "refused" ? "sign-in-refused" : "no-sign-in" });
      expect(seen, change).toHaveLength(0);
      if (change === "rotated") world.store.handle.prepare("UPDATE approver SET generation = generation - 1 WHERE name = 'alex'").run();
    }
  });

  test("R1 the invariant read alone (inside the reservation) refuses a crossed thread, owner or person", async () => {
    const alex = standInSignIn(world.store, world.state, "alex");
    const bob = standInSignIn(world.store, world.state, "bob");
    const one = await thread("alex");
    expect(signInStandsAt(world.store, { thread: one.id, turn: one.turn, person: "alex", generation: alex.generation })).toBeNull();
    // Another person's sign-in for alex's turn: never.
    expect(signInStandsAt(world.store, { thread: one.id, turn: one.turn, person: "bob", generation: bob.generation })).toBe("no-sign-in");
    // A turn whose owner isn't the thread's starter, even with the owner's own sign-in.
    const crossed = await thread("alex", "bob");
    expect(signInStandsAt(world.store, { thread: crossed.id, turn: crossed.turn, person: "bob", generation: bob.generation })).toBe("no-sign-in");
    // Another thread's turn named with this thread.
    expect(signInStandsAt(world.store, { thread: crossed.id, turn: one.turn, person: "alex", generation: alex.generation })).toBe("no-sign-in");
  });

  test("R1 another thread trying a refused generation is refused; nothing is sent; a new save clears it", async () => {
    const refused = standInSignIn(world.store, world.state, "alex");
    const first = await thread("alex");
    const second = await thread("alex");
    script = (_request, response) => { response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: `bad ${refused.value}` } })); };
    expect((await call(first)).status).toBe(403);
    expect(seen).toHaveLength(1);
    script = (_request, response) => { response.writeHead(200, { "content-type": "application/json" }).end(MESSAGE); };
    expect((await call(second)).status).toBe(403);
    expect(seen).toHaveLength(1);
    expect(records().at(-1)).toMatchObject({ thread: second.id, status: "refused", reason: "sign-in-refused" });
    expect(flexibleSignInBilling(world.store, { name: "alex", generation: world.store.accountOf("alex")!.generation })).toEqual({ ok: false, reason: "sign-in-refused" });
    // Only saving a new one clears it.
    standInSignIn(world.store, world.state, "alex");
    expect((await call(second)).status).toBe(200);
  });
});

describe("first use: Claude refusing the sign-in", () => {
  test("401 and 403 authentication_error refuse that generation, answer the agent with Toolroll's 403 (never Claude's body), and end the turn with those words; a plan 403 passes through and refuses nothing", async () => {
    const signIn = standInSignIn(world.store, world.state, "alex");
    const plain = await thread("alex");
    script = (_request, response) => { response.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "permission_error", message: "Your plan doesn't include this model." } })); };
    const permission = await call(plain);
    expect(permission.status).toBe(403);
    expect(JSON.parse(await permission.text())).toEqual({ type: "error", error: { type: "permission_error", message: "Your plan doesn't include this model." } });
    expect(flexibleSignInStatus(world.store, "alex")).toMatchObject({ state: "active" });
    expect(flexibleTurn(world.store, plain.turn)!.status).toBe("running");

    for (const [status, type] of [[401, "authentication_error"], [403, "authentication_error"]] as const) {
      const fresh = status === 401 ? plain : await thread("alex");
      if (status === 403) standInSignIn(world.store, world.state, "alex");
      script = (_request, response) => { response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type, message: `invalid ${signIn.value}` } })); };
      const answer = await call(fresh);
      expect(answer.status, `${status}`).toBe(403);
      const words = `Toolroll couldn't use your Claude sign-in for threads: Claude answered ${status}. Replace it in Settings → General, or with \`toolroll config set flexible-sign-in\`.`;
      expect(JSON.parse(await answer.text())).toEqual({ type: "error", error: { type: "permission_error", message: words } });
      expect(records().at(-1)).toMatchObject({ status: "upstream-error", http_status: status, sign_in_refused: 1, sign_in_person: "alex" });
      expect(flexibleTurn(world.store, fresh.turn)).toMatchObject({ status: "interrupted" });
      expect(world.store.handle.prepare("SELECT end_detail FROM thread_turn WHERE id = ?").get(fresh.turn)!["end_detail"]).toBe(words);
      expect(flexibleSignInStatus(world.store, "alex")).toMatchObject({ state: "refused" });
    }
    expect(JSON.stringify(records())).not.toContain(signIn.value.slice(14, 30));
  });

  test("an old 401 for the generation before a replacement marks only that one; the new one stays usable", async () => {
    const old = standInSignIn(world.store, world.state, "alex");
    const one = await thread("alex");
    let release: () => void = () => {};
    const gate = new Promise<void>(done => { release = done; });
    script = (_request, response) => { void gate.then(() => response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "no" } }))); };
    const pending = call(one);
    for (let i = 0; i < 100 && seen.length === 0; i++) await new Promise(done => setTimeout(done, 20));
    expect(seen).toHaveLength(1);
    const fresh = standInSignIn(world.store, world.state, "alex");
    release();
    expect((await pending).status).toBe(403);
    expect(records().at(-1)).toMatchObject({ sign_in_generation: old.generation, sign_in_refused: 1 });
    expect(flexibleSignInStatus(world.store, "alex")).toMatchObject({ state: "active", generation: fresh.generation });
    script = (_request, response) => { response.writeHead(200, { "content-type": "application/json" }).end(MESSAGE); };
    const next = await thread("alex");
    expect((await call(next)).status).toBe(200);
    expect(seen.at(-1)!.headers.authorization).toBe(`Bearer ${fresh.value}`);
  });

  test("when the call's record can't be written, nothing is marked and the turn isn't ended; the next refused call marks it", async () => {
    standInSignIn(world.store, world.state, "alex");
    const one = await thread("alex");
    script = (_request, response) => { response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "no" } })); };
    const db = world.store.handle;
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => { if (sql.includes("INSERT INTO thread_relay_call")) throw new Error("disk I/O error"); return prepare(sql); }) as typeof db.prepare;
    try {
      expect((await call(one)).status).toBe(403);
      expect(flexibleSignInStatus(world.store, "alex")).toMatchObject({ state: "active" });
      expect(flexibleTurn(world.store, one.turn)!.status).toBe("running");
    } finally { db.prepare = prepare as typeof db.prepare; }
    // Writable again: its record is written by the relay's retry (marking it then) or reconciled; either way the next
    // call is refused and nothing more is sent with that generation.
    for (let i = 0; i < 100 && Number(prepare("SELECT COUNT(*) AS n FROM thread_relay_pending").get()!["n"]) > 0; i++) await new Promise(done => setTimeout(done, 20));
    const next = await thread("alex");
    expect((await call(next)).status).toBe(403);
    expect(flexibleSignInStatus(world.store, "alex")).toMatchObject({ state: "refused" });
  });
});
