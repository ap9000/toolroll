/**
 * Attack: a Flexible thread's agent leaving processes behind (enable gate 1, full process custody; slice F2c), against
 * the real thread fence: Seatbelt on a Mac, bubblewrap on Linux (where these rows run in CI on the native lane,
 * TOOLROLL_REQUIRE_NATIVE=linux). Every row needs the OS fence (needs(ctx, osFence())).
 *
 * Rows: a setsid + double-forked survivor of the agent keeps the thread from relaunching until custody settles, and is
 * then found and stopped (Linux: the launch's pid namespace ends it with the agent; macOS: found working in the thread's
 * folder); one that leaves the group, the folder and every open file after the holder saw it is found as a witness; a
 * turn started through startFlexibleTurn runs its agent (a stand-in `claude` on PATH, never the real one) at Full
 * access, signed in only through its thread's sign-in relay, which it reaches from inside the fence (and which, holding
 * no Claude sign-in here, sends nothing); lowering the thread mid-turn stops it at once, closes its proxy and its relay
 * token, and interrupts its turn; replies after finished turns, twice in a row, each start a fresh agent on their own
 * proxy, and the replaced agent's own exit never stops the newer launch (stranger test round 11). No model is called.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { flexibleThread, flexibleThreadSpawn, prepareFlexibleThread, stopFlexibleThreadAgent, type FlexibleThreadPaths } from "../../src/flexible-thread.js";
import { flexibleLaunch, relayGrantLive, unsettledLaunch, watchLaunch } from "../../src/flexible-launch.js";
import { lowerFlexibleThreadLevel, startFlexibleTurn } from "../../src/flexible-agents.js";
import { relayUrlInside, startFlexibleRelay, type FlexibleRelayServer } from "../../src/flexible-relay.js";
import { admitFlexibleTurn, flexibleTurn } from "../../src/flexible-turns.js";
import { beginFlexibleThreadTurn, closeFlexibleSessions, continueFlexibleThread, flexibleStopPending, openFlexibleSessions, settleFlexibleStops } from "../../src/flexible-session.js";
import { requireFlexibleStop } from "../../src/flexible-authority-end.js";
import type { FlexibleLauncher } from "../../src/flexible-launcher.js";
import { standInSignIn } from "../flexible-sign-in-kit.js";
import { randomBytes } from "node:crypto";
import { flexibleDigestOf, flexibleTermsJson, type FlexibleTerms } from "../../src/flexible.js";
import { threadWorld, type ThreadWorld } from "../flexible-thread-world.js";
import { needs, osFence, q } from "./harness.js";

// The switch as the test sets it (on unless a test turns it off), read where the product reads it.
const switched = vi.hoisted(() => ({ on: true }));
vi.mock("../../src/flexible-available.js", async original => ({ ...await original<typeof import("../../src/flexible-available.js")>(), flexibleAvailable: () => switched.on }));

const NOW = new Date();
const STORAGE = { names: [], denies: [] };
const LAUNCH = { provider: "claude", level: "full", turn: null, holder: "attack" } as const;
let world: ThreadWorld;
beforeEach(() => { world = threadWorld(); switched.on = true; });
afterEach(() => { world.store.close(); rmSync(world.dir, { recursive: true, force: true }); });

async function thread(): Promise<{ id: string; paths: FlexibleThreadPaths }> {
  const made = await prepareFlexibleThread(world.store, { repo: world.project, base: "HEAD", by: "alex", now: NOW });
  if (!made.ok) throw new Error(made.message);
  return { id: made.thread.id, paths: made.paths };
}
async function until(test: () => boolean, why?: () => string): Promise<void> {
  for (let waited = 0; waited < 150 && !test(); waited++) await new Promise(done => setTimeout(done, 100));
  expect(test(), why?.()).toBe(true);
}
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
/** Whether a heartbeat file is still being written (its size grows within a second). */
async function beating(file: string): Promise<boolean> {
  const size = () => { try { return statSync(file).size; } catch { return -1; } };
  const before = size();
  await sleep(1_000);
  return size() > before;
}
/** A survivor: setsid + double fork, then a heartbeat into the thread's temp folder every tenth of a second. `leave`:
 * after a second and a half as the agent's descendant, it leaves its group, the thread's folder and every open file. */
const survivor = (beat: string, leave: boolean): string => leave
  ? `perl -MPOSIX -e 'exit if fork; sleep 1.5; POSIX::setsid(); chdir "/"; POSIX::close($_) for 0..255; for (1..300) { open(my $f, ">>", $ARGV[0]); print $f "."; close $f; select(undef, undef, undef, 0.1) }' ${q(beat)}`
  : `perl -MPOSIX -e 'exit if fork; POSIX::setsid(); exit if fork; open(my $p, ">", "${beat}.pid"); print $p $$; close $p; for (1..300) { open(my $f, ">>", "${beat}"); print $f "."; close $f; select(undef, undef, undef, 0.1) }'`;

describe("attack: a Flexible thread's agent leaving processes behind", () => {
  test("native: a setsid + double-forked survivor keeps the thread from relaunching until custody settles, and is then stopped", async ctx => {
    needs(ctx, osFence());
    const { id, paths } = await thread();
    const beat = join(paths.tmp, "beat");
    const launch = await flexibleThreadSpawn(world.store, { id, network: { proxyPort: 1, token: "run-token" }, storage: STORAGE, proxyEnv: {}, launch: LAUNCH, beforeOpen: () => null },
      "/bin/sh", ["-c", `${survivor(beat, false)}; sleep 1`]);
    if (!launch.ok) throw new Error(launch.message);
    launch.child.stdin!.end();
    await new Promise(done => launch.child.once("exit", done)); // the agent's own process is gone (its output may stay open in the survivor)
    expect(existsSync(beat)).toBe(true);
    // The launch is unsettled: no replacement, whatever is or isn't left.
    const again = await flexibleThreadSpawn(world.store, { id, network: { proxyPort: 1, token: "run-token" }, storage: STORAGE, proxyEnv: {}, launch: LAUNCH, beforeOpen: () => null }, "/bin/sh", ["-c", "echo ran"]);
    expect(again).toMatchObject({ ok: false, reason: "thread-running" });
    if (process.platform === "darwin") {
      // Seatbelt has no pid namespace: it lives on. Found only by working in the thread's folder, it isn't proven the
      // agent's (it could be a person's program), so it is never signalled: custody stays unresolved and names it.
      expect(await beating(beat)).toBe(true);
      const pid = Number(readFileSync(`${beat}.pid`, "utf8"));
      expect(await stopFlexibleThreadAgent(world.store, { id, reason: "attack" })).toMatchObject({ ok: false, blockers: [{ pid, why: "in-folder" }] });
      expect(await beating(beat)).toBe(true);
      expect(await flexibleThreadSpawn(world.store, { id, network: { proxyPort: 1, token: "run-token" }, storage: STORAGE, proxyEnv: {}, launch: LAUNCH, beforeOpen: () => null }, "/bin/sh", ["-c", "echo ran"])).toMatchObject({ ok: false, reason: "thread-running" });
      process.kill(pid, "SIGKILL");
    }
    const settled = await stopFlexibleThreadAgent(world.store, { id, reason: "attack" });
    expect(settled).toMatchObject({ ok: true, how: "none-left" });
    expect(await beating(beat)).toBe(false);
    expect(flexibleLaunch(world.store, launch.launchId)).toMatchObject({ state: "exited" });
    expect(flexibleThread(world.store, id)!.livePid).toBeNull();
    // Settled, the thread launches again.
    const next = await flexibleThreadSpawn(world.store, { id, network: { proxyPort: 1, token: "run-token" }, storage: STORAGE, proxyEnv: {}, launch: LAUNCH, beforeOpen: () => null }, "/bin/sh", ["-c", "echo ran"]);
    expect(next).toMatchObject({ ok: true });
    if (next.ok) { next.child.stdin!.end(); await new Promise(done => next.child.once("close", done)); }
    expect(await stopFlexibleThreadAgent(world.store, { id, reason: "attack" })).toMatchObject({ ok: true });
  }, 90_000);

  test("native: one that leaves its group, the thread's folder and every open file after the holder saw it is still found and stopped", async ctx => {
    needs(ctx, osFence());
    const { id, paths } = await thread();
    const beat = join(paths.tmp, "far-beat");
    const launch = await flexibleThreadSpawn(world.store, { id, network: { proxyPort: 1, token: "run-token" }, storage: STORAGE, proxyEnv: {}, launch: LAUNCH, beforeOpen: () => null },
      "/bin/sh", ["-c", `${survivor(beat, true)}; sleep 3`]);
    if (!launch.ok) throw new Error(launch.message);
    launch.child.stdin!.end();
    const stopWatching = watchLaunch(world.store, launch.launchId, paths.folder, undefined, 100);
    try { await new Promise(done => launch.child.once("close", done)); } finally { stopWatching(); }
    if (process.platform === "darwin") {
      expect(await beating(beat)).toBe(true);
      expect(flexibleLaunch(world.store, launch.launchId)!.witnesses.length).toBeGreaterThan(0);
    }
    expect(await stopFlexibleThreadAgent(world.store, { id, reason: "attack" })).toMatchObject({ ok: true });
    expect(await beating(beat)).toBe(false);
    expect(unsettledLaunch(world.store, id)).toBeNull();
  }, 90_000);

  test.runIf(process.platform === "linux")("native (Linux): one that double-forks at once, leaves the folder and closes every file, never seen by the holder, still dies with the launch's pid namespace", async ctx => {
    needs(ctx, osFence());
    const { id, paths } = await thread();
    const beat = join(paths.tmp, "unseen-beat");
    const launch = await flexibleThreadSpawn(world.store, { id, network: { proxyPort: 1, token: "run-token" }, storage: STORAGE, proxyEnv: {}, launch: LAUNCH, beforeOpen: () => null },
      "/bin/sh", ["-c", `perl -MPOSIX -e 'exit if fork; POSIX::setsid(); exit if fork; chdir "/"; POSIX::close($_) for 0..255; for (1..300) { open(my $f, ">>", $ARGV[0]); print $f "."; close $f; select(undef, undef, undef, 0.1) }' ${q(beat)}; sleep 1`]);
    if (!launch.ok) throw new Error(launch.message);
    launch.child.stdin!.end();
    await new Promise(done => launch.child.once("exit", done));
    expect(await stopFlexibleThreadAgent(world.store, { id, reason: "attack" })).toMatchObject({ ok: true });
    expect(await beating(beat)).toBe(false);
  }, 90_000);

  test("native: a start whose re-check fails at the last moment (the thread was lowered) keeps its gate shut: nothing of the agent runs", async ctx => {
    needs(ctx, osFence());
    const { id, paths } = await thread();
    const ran = join(paths.tmp, "gate-ran");
    let pid = 0;
    const refused = await flexibleThreadSpawn(world.store, { id, network: { proxyPort: 1, token: "run-token" }, storage: STORAGE, proxyEnv: {}, launch: LAUNCH,
      beforeOpen: () => "the thread was lowered to Supervised" }, "/bin/sh", ["-c", `echo ran > ${q(ran)}; sleep 30`], process.platform, { afterSpawn: spawned => { pid = spawned; } });
    expect(refused).toMatchObject({ ok: false, message: expect.stringContaining("the thread was lowered to Supervised") });
    // The whole launch is gone, its group included (on Linux the helper's network relays share it).
    expect(pid).toBeGreaterThan(1);
    await until(() => { try { process.kill(-pid, 0); return false; } catch { return true; } });
    await sleep(1_000);
    expect(existsSync(ran)).toBe(false);
    expect(world.store.handle.prepare("SELECT state, end_detail FROM flexible_thread_launch").all().map(row => ({ ...row }))).toEqual([{ state: "exited", end_detail: "stopped before it ran: the thread was lowered to Supervised" }]);
    expect(flexibleThread(world.store, id)!.livePid).toBeNull();
  }, 60_000);

  test("native: interactive agent threads turned off after the launch was admitted keep its gate shut: the reservation reads the switch, nothing runs", async ctx => {
    needs(ctx, osFence());
    const { id, paths } = await thread();
    const ran = join(paths.tmp, "gate-ran");
    let pid = 0;
    // Admitted and spawned behind its shut gate; the switch goes off before the reservation; the caller's own re-check passes.
    const refused = await flexibleThreadSpawn(world.store, { id, network: { proxyPort: 1, token: "run-token" }, storage: STORAGE, proxyEnv: {}, launch: LAUNCH,
      beforeOpen: () => null }, "/bin/sh", ["-c", `echo ran > ${q(ran)}; sleep 30`], process.platform, { afterSpawn: spawned => { pid = spawned; switched.on = false; } });
    expect(refused).toMatchObject({ ok: false, message: expect.stringContaining("interactive agent threads were turned off") });
    expect(pid).toBeGreaterThan(1);
    await until(() => { try { process.kill(-pid, 0); return false; } catch { return true; } });
    await sleep(1_000); // guard: bound a gate that opened would have written the file by now; the fact checked is its absence
    expect(existsSync(ran)).toBe(false);
    expect(world.store.handle.prepare("SELECT state, end_detail FROM flexible_thread_launch").all().map(row => ({ ...row }))).toEqual([{ state: "exited", end_detail: "stopped before it ran: interactive agent threads were turned off" }]);
    expect(world.store.handle.prepare("SELECT COUNT(*) AS n FROM action_ledger WHERE action = 'flexible agent launched'").get()!["n"]).toBe(0);
  }, 60_000);

  describe("a turn's agent at Full access, signed in through its thread's relay, lowered mid-turn", () => {
    let relay: FlexibleRelayServer | null = null, path: string | undefined;
    beforeEach(() => { path = process.env["PATH"]; });
    afterEach(async () => { process.env["PATH"] = path; await relay?.close(); relay = null; });

    test("native: the agent gets Full access inside the fence and only the relay's sign-in; lowering stops it, closes its network and interrupts its turn", async ctx => {
      needs(ctx, osFence());
      world.store.saveApprover("alex", "hash-a", NOW);
      const terms: FlexibleTerms = { version: 1, repo: world.project, signer: "alex", signerGeneration: world.store.accountOf("alex")!.generation, starters: "approvers-with-access",
        passwordFreeUpTo: "full", max: "full", default: "full", network: "confined", caps: { liveThreads: 3, turnsPerDayProject: 300, turnsPerDayPerson: 150, measuredMicrousdPerDay: null } };
      const digest = flexibleDigestOf(terms);
      world.store.handle.prepare(`INSERT INTO flexible_terms (repo, terms_json, digest, signed_terms_json, signed_digest, signed_by, signed_at, proof, changed_by, changed_at)
        VALUES (?, ?, ?, ?, ?, 'alex', ?, 'password-now', 'alex', ?)`).run(world.project, flexibleTermsJson(terms), digest, flexibleTermsJson(terms), digest, NOW.toISOString(), NOW.toISOString());
      // A stand-in `claude` (never the real one): says what it was given, tries the relay, then works until stopped.
      const bin = join(world.dir, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "claude"), [
        "#!/bin/sh",
        'echo "args: $*"',
        'echo "base: $ANTHROPIC_BASE_URL"',
        'echo "token: $ANTHROPIC_AUTH_TOKEN"',
        'echo "config: $CLAUDE_CONFIG_DIR"',
        '[ -n "$ANTHROPIC_API_KEY$CLAUDE_CODE_OAUTH_TOKEN$OPENAI_API_KEY" ] && echo LEAKED-KEY',
        'for c in codex gemini; do command -v $c >/dev/null 2>&1 && echo "REAL-CLI $c"; done',
        '(curl -s -m 5 -o /dev/null -w "relay-status %{http_code}\\n" -X POST "$ANTHROPIC_BASE_URL/v1/messages" -H "authorization: Bearer $ANTHROPIC_AUTH_TOKEN" -H "content-type: application/json" -d \'{"model":"claude-sonnet-4-5","max_tokens":1,"messages":[]}\' 2>/dev/null) || echo relay-unreachable',
        "echo ready",
        "sleep 60",
      ].join("\n"));
      chmodSync(join(bin, "claude"), 0o755);
      // Only the stand-in and the system's own folders: no real agent program can be found.
      process.env["PATH"] = `${bin}:/usr/bin:/bin`;
      const { id, paths } = await thread();
      const made = await startFlexibleRelay(world.store, { thread: id });
      if ("ok" in made) throw new Error(made.message);
      relay = made;
      const admitted = admitFlexibleTurn(world.store, { thread: id, starter: { name: "alex", generation: world.store.accountOf("alex")!.generation }, digest, level: "full", freshProof: false,
        provider: "claude", model: "claude-sonnet-4-5", billing: "subscription", requestKey: "m-1", holder: "attack" });
      if (!admitted.ok) throw new Error(admitted.message);
      let proxyClosed = 0;
      const started = await startFlexibleTurn(world.store, { turn: admitted.turn, holder: "attack", relay, storage: STORAGE,
        network: { proxyPort: 1, token: "run-token", proxyEnv: {}, close: () => { proxyClosed++; } } });
      if (!started.ok || started.launched !== "started") throw new Error(JSON.stringify(started));
      let out = "";
      started.child.stdout!.on("data", chunk => { out += chunk; });
      const closed = new Promise(done => started.child.once("close", done));
      await until(() => out.includes("ready"), () => out);
      expect(out).toContain("--permission-mode bypassPermissions");
      expect(out).toContain(`base: ${relayUrlInside(relay.port)}\n`);
      const token = /token: (tr-relay-[0-9a-f]{48})/.exec(out)?.[1] ?? "";
      expect(relayGrantLive(world.store, token)).toBe(true);
      expect(out).toContain(`config: ${join(paths.cache, "provider", admitted.turn)}\n`);
      expect(out).not.toContain("LEAKED-KEY");
      expect(out).not.toContain("REAL-CLI");
      // The fence lets it reach its proxy (here a dead port) and its relay, at the relay's second-relay address: the call
      // is authorized and bound to the turn, and refused only because its starter has no Claude sign-in for threads here
      // (Toolroll's own turn-ending 403; nothing was sent).
      expect(out).toContain("relay-status 403");
      expect(world.store.handle.prepare("SELECT status, reason, turn FROM thread_relay_call").all().map(row => ({ ...row }))).toEqual([{ status: "refused", reason: "no-sign-in", turn: admitted.turn }]);
      // That refusal ends the turn in the relay's own words and requires the agent to stop (threads-everyday S1); the
      // lowering below is still what stops it here, and every stop still verifies the whole tree's exit.
      expect(flexibleTurn(world.store, admitted.turn)!.status).toBe("interrupted");
      expect(world.store.handle.prepare("SELECT COUNT(*) AS n FROM flexible_stop_request WHERE thread = ? AND settled_at IS NULL").get(id)?.["n"]).toBe(1);
      const lowered = await lowerFlexibleThreadLevel(world.store, { thread: id, by: { name: "alex", generation: world.store.accountOf("alex")!.generation }, level: "supervised" });
      expect(lowered).toMatchObject({ ok: true, stopped: "stopped", message: "Lowered to Supervised; the current step was stopped." });
      await closed;
      expect(relayGrantLive(world.store, token)).toBe(false);
      expect(proxyClosed).toBe(1);
      expect(flexibleTurn(world.store, admitted.turn)!.status).toBe("interrupted");
      expect(unsettledLaunch(world.store, id)).toBeNull();
      expect(readFileSync(join(world.project, "README.md"), "utf8")).toBe("shop\n");
    }, 90_000);

    /** A thread whose agent is a stand-in `claude` that answers every message with a finished result and keeps running,
     * as the stream-json agent does, with this host's sessions and a launcher that makes each launch its own proxy. */
    async function replyWorld() {
      world.store.saveApprover("alex", "hash-a", NOW);
      const alex = () => ({ name: "alex", generation: world.store.accountOf("alex")!.generation });
      const terms: FlexibleTerms = { version: 1, repo: world.project, signer: "alex", signerGeneration: alex().generation, starters: "approvers-with-access",
        passwordFreeUpTo: "full", max: "full", default: "full", network: "confined", caps: { liveThreads: 3, turnsPerDayProject: 300, turnsPerDayPerson: 150, measuredMicrousdPerDay: null } };
      const digest = flexibleDigestOf(terms);
      world.store.handle.prepare(`INSERT INTO flexible_terms (repo, terms_json, digest, signed_terms_json, signed_digest, signed_by, signed_at, proof, changed_by, changed_at)
        VALUES (?, ?, ?, ?, ?, 'alex', ?, 'password-now', 'alex', ?)`).run(world.project, flexibleTermsJson(terms), digest, flexibleTermsJson(terms), digest, NOW.toISOString(), NOW.toISOString());
      standInSignIn(world.store, world.state, "alex");
      // A stand-in `claude` (never the real one) that behaves as the stream-json agent does: it answers each message
      // with a finished result and stays running, reading its input, until it is stopped.
      const bin = join(world.dir, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "claude"), ["#!/bin/sh", 'while IFS= read -r line; do echo \'{"type":"result","subtype":"success","is_error":false}\'; done'].join("\n"));
      chmodSync(join(bin, "claude"), 0o755);
      process.env["PATH"] = `${bin}:/usr/bin:/bin`;
      const { id } = await thread();
      const opened = openFlexibleSessions(world.store);
      if (!opened.ok) throw new Error(opened.message);
      const sessions = opened.sessions;
      // Each launch gets its own proxy, as the console's launcher makes one per turn: another port, another credential.
      let port = 41_100;
      const proxies: { port: number; token: string; closed: number }[] = [];
      const launcher: FlexibleLauncher = { open: () => proxies.filter(one => one.closed === 0).length, close: async () => {},
        prepare: async () => {
          const proxy = { port: ++port, token: randomBytes(16).toString("hex"), closed: 0 };
          proxies.push(proxy);
          return { ok: true, storage: STORAGE, network: { proxyPort: proxy.port, token: proxy.token, proxyEnv: {}, close: () => { proxy.closed++; } } };
        } };
      // Told when the stop a launch's own exit set off has answered: the fact the checks below wait on.
      const exitSettled = new Map<string, unknown>();
      const seams = { exitSettled: (launch: string, settled: unknown) => { exitSettled.set(launch, settled); } };
      const launchOf = (turn: string) => String(world.store.handle.prepare("SELECT id FROM flexible_thread_launch WHERE turn = ?").get(turn)?.["id"]);
      const live = (launch: string) => flexibleLaunch(world.store, launch)?.state === "live";
      const startFirst = async () => {
        const first = admitFlexibleTurn(world.store, { thread: id, starter: alex(), digest, level: "full", freshProof: false, provider: "claude", model: "claude-sonnet-4-5",
          billing: "subscription", requestKey: "start:first", holder: sessions.holder });
        if (!first.ok) throw new Error(first.message);
        expect(await beginFlexibleThreadTurn(world.store, sessions, { turn: first.turn, message: "Make the README friendlier", launcher, seams })).toMatchObject({ ok: true, launched: "started" });
        await until(() => flexibleTurn(world.store, first.turn)?.status === "finished", () => JSON.stringify(flexibleTurn(world.store, first.turn)));
        return first.turn;
      };
      const reply = (message: string) => continueFlexibleThread(world.store, sessions, { thread: id, by: alex(), message, key: randomBytes(16).toString("hex"), freshProof: false, held: () => true, launcher, seams });
      return { id, sessions, proxies, exitSettled, launchOf, live, startFirst, reply };
    }

    test("native: replies after finished turns, twice in a row, each start a fresh agent on its own proxy; the earlier agent's exit never stops the newer launch", async ctx => {
      needs(ctx, osFence());
      const { id, sessions, proxies, exitSettled, launchOf, live, startFirst, reply } = await replyWorld();
      try {
        const first = await startFirst();
        let previous = { turn: first, launch: launchOf(first) };
        for (const [n, message] of [[2, "Now add a short install section"], [3, "And a line about tests"]] as const) {
          const sent = await reply(message);
          expect(sent, JSON.stringify(sent)).toMatchObject({ ok: true, seq: n, fresh: true });
          if (!sent.ok) return;
          const launch = launchOf(sent.turn);
          expect(launch).not.toBe(previous.launch);
          // The earlier agent was replaced (that launch exactly), its proxy closed; its own exit's stop has answered and
          // left the newer launch alone.
          expect(flexibleLaunch(world.store, previous.launch)).toMatchObject({ state: "exited", stopReason: "its agent was replaced" });
          await until(() => exitSettled.has(previous.launch));
          expect(exitSettled.get(previous.launch)).toMatchObject({ ok: true, launch: null });
          await until(() => flexibleTurn(world.store, sent.turn)?.status === "finished", () => JSON.stringify(flexibleTurn(world.store, sent.turn)));
          expect(live(launch)).toBe(true);
          expect(flexibleTurn(world.store, previous.turn)!.status).toBe("finished");
          expect(world.store.handle.prepare("SELECT COUNT(*) AS n FROM action_ledger WHERE action = 'flexible agent stopped' AND detail LIKE ?").get(`%launch ${launch}%`)?.["n"]).toBe(0);
          previous = { turn: sent.turn, launch };
        }
        // One proxy per launch, each launch's closed with it; the live one's still open.
        expect(proxies.map(one => one.closed)).toEqual([1, 1, 0]);
        expect(new Set(proxies.map(one => one.token)).size).toBe(3);
      } finally {
        await closeFlexibleSessions(world.store, sessions);
      }
      expect(unsettledLaunch(world.store, id)).toBeNull();
    }, 120_000);

    test("native: a stop required of the replaced agent never touches its replacement: the reply's new agent keeps running and the requirement settles", async ctx => {
      needs(ctx, osFence());
      const { id, sessions, launchOf, live, startFirst, reply } = await replyWorld();
      try {
        const first = await startFirst();
        const a = launchOf(first);
        // The first agent must stop (as an interrupted turn or a sign-in removed requires), and the upkeep hasn't acted yet.
        world.store.transact(() => { requireFlexibleStop(world.store, { launch: a, thread: id, reason: "its turn was interrupted", at: new Date().toISOString() }); });
        expect(flexibleStopPending(world.store, id)).toBe(true);
        // The reply takes the thread's lock as it is called (synchronously) and replaces A with B under it; the upkeep's
        // stop of A, started meanwhile, waits for that lock and then finds A already replaced.
        const replying = reply("Now add a short install section");
        const upkeep = settleFlexibleStops(world.store, sessions);
        const [sent, settled] = await Promise.all([replying, upkeep]);
        expect(sent, JSON.stringify(sent)).toMatchObject({ ok: true, seq: 2, fresh: true });
        if (!sent.ok) return;
        const b = launchOf(sent.turn);
        expect(settled).toMatchObject({ ok: true, pending: 0 });
        expect(flexibleLaunch(world.store, a)).toMatchObject({ state: "exited", stopReason: "its agent was replaced" });
        expect(flexibleStopPending(world.store, id)).toBe(false);
        // B runs on, with its session's agent link and the thread's relay kept, and its turn finishes.
        expect(live(b)).toBe(true);
        expect(sessions.threads.get(id)?.agent?.launch).toBe(b);
        expect(sessions.threads.get(id)?.relay).not.toBeNull();
        await until(() => flexibleTurn(world.store, sent.turn)?.status === "finished", () => JSON.stringify(flexibleTurn(world.store, sent.turn)));
        expect(live(b)).toBe(true);
        expect(world.store.handle.prepare("SELECT COUNT(*) AS n FROM action_ledger WHERE action = 'flexible agent stopped' AND detail LIKE ?").get(`%launch ${b}%`)?.["n"]).toBe(0);
      } finally {
        await closeFlexibleSessions(world.store, sessions);
      }
      expect(unsettledLaunch(world.store, id)).toBeNull();
    }, 120_000);
  });
});
