/**
 * The leak sweep for people's Claude sign-ins for threads (the thread sign-in plan v2 §6 item 9): no fragment of A's or
 * B's value (any 8 characters of its secret part in a row) appears anywhere Toolroll writes or says, after a save with
 * the live check, a refused save (wrong password, an API key), a check whose stand-in echoes the token in its body and
 * headers, relay calls whose stand-in echoes it (an answer, an error, a sign-in refusal), removal, an export, a backup
 * and a restore: the database and its WAL bytes, the CLI's output, the relay's log lines, the ledger and every other
 * table (outbound included), the export's files and the backup file. After the restore, no sign-in is active and the
 * upkeep leaves no secret behind. Stand-ins only: a scripted upstream on loopback, made-up tokens, the files store.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { addApprover } from "./scope.js";
import { setFlexibleSetting } from "./flexible-available.js";
import { flexibleDigestOf, flexibleTermsJson, type FlexibleTerms } from "./flexible.js";
import { admitFlexibleTurn, beginFlexibleTurn } from "./flexible-turns.js";
import { prepareFlexibleThread } from "./flexible-thread.js";
import { startFlexibleRelay, type FlexibleRelayServer } from "./flexible-relay.js";
import { flexibleSignInStatus, tidyFlexibleSignIns } from "./flexible-sign-in.js";
import { runOperate } from "./operate.js";
import { buildExport } from "./export.js";
import { onlineCopy, restoreDatabase } from "./backup.js";
import { openStore } from "./store.js";
import { threadWorld, type ThreadWorld } from "../test/flexible-thread-world.js";
import { fakePid } from "../test/fake-pid.js";
import { standInToken } from "../test/flexible-sign-in-kit.js";

const scripted = vi.hoisted(() => ({ origin: "http://127.0.0.1:9" }));
vi.mock("./flexible-relay-upstreams.js", async importOriginal => {
  const real = await importOriginal<typeof import("./flexible-relay-upstreams.js")>();
  return { FLEXIBLE_RELAY_UPSTREAMS: { claude: { ...real.FLEXIBLE_RELAY_UPSTREAMS.claude, get origin() { return scripted.origin; } } } };
});

const NOW = new Date();
let world: ThreadWorld, upstream: Server, script: (request: IncomingMessage, response: ServerResponse) => void;
const relays: FlexibleRelayServer[] = [];

/** Every 8 characters in a row of a token's secret part (after its public `sk-ant-oatNN-` prefix). */
const fragments = (token: string): string[] => { const body = token.replace(/^sk-ant-[a-z]{2,8}\d{0,3}-/, ""); return Array.from({ length: body.length - 7 }, (_, at) => body.slice(at, at + 8)); };
const leaked = (text: string, tokens: readonly string[]): string[] => tokens.flatMap(token => fragments(token).filter(piece => text.includes(piece)));
/** The echo: whatever authorization the call carried, back in the body and a header. */
const echo = (status: number, body: (auth: string) => unknown) => {
  script = (request, response) => { const auth = String(request.headers.authorization ?? ""); response.writeHead(status, { "content-type": "application/json", "x-echo": auth }).end(JSON.stringify(body(auth))); };
};

beforeEach(async () => {
  upstream = createServer((request, response) => { request.resume(); request.on("end", () => script(request, response)); });
  await new Promise<void>(done => upstream.listen(0, "127.0.0.1", () => done()));
  scripted.origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  world = threadWorld();
});
afterEach(async () => {
  for (const relay of relays.splice(0)) await relay.close();
  upstream.closeAllConnections();
  await new Promise(done => upstream.close(done));
  try { world.store.close(); } catch { /* closed for the restore */ }
  rmSync(world.dir, { recursive: true, force: true });
});

test("no fragment of anyone's sign-in in the database, WAL, CLI output, relay log, ledger, export, backup or restore", async () => {
  const alex = addApprover(world.store, "alex", NOW);
  if (!alex.ok) throw new Error("alex");
  const bob = addApprover(world.store, "bob", NOW, { name: "alex", token: alex.token });
  if (!bob.ok) throw new Error("bob");
  setFlexibleSetting(world.store, true, "alex", NOW);
  const A = standInToken(), B = standInToken(), rejected = ["sk", "ant", "api03", randomBytes(24).toString("hex")].join("-");
  const tokens = [A, B, rejected];
  const out: string[] = [];
  const cli = async (args: string[], paste: string) => runOperate("config", [...args, "--json"], line => out.push(line), { databaseFile: world.databaseFile, easySeams: { askHidden: async () => paste } });

  // Saves through the product door; the check's stand-in echoes the token in its body and a header.
  echo(200, auth => ({ input_tokens: 2, echoed: auth }));
  await cli(["set", "flexible-sign-in", "--as", "alex", "--token", alex.token], A);
  echo(401, auth => ({ type: "error", error: { type: "authentication_error", message: `bad ${auth}` } }));
  await cli(["set", "flexible-sign-in", "--as", "bob", "--token", "not-bobs-password"], B); // refused: wrong password
  await cli(["set", "flexible-sign-in", "--as", "bob", "--token", bob.token], rejected); // refused: an API key
  await cli(["set", "flexible-sign-in", "--as", "bob", "--token", bob.token], B); // refused by the check (401 echo)
  echo(200, auth => ({ input_tokens: 2, echoed: auth }));
  await cli(["set", "flexible-sign-in", "--as", "bob", "--token", bob.token], B);
  expect(flexibleSignInStatus(world.store, "alex").state).toBe("active");
  expect(flexibleSignInStatus(world.store, "bob").state).toBe("active");

  // Relay calls on alex's sign-in whose stand-in echoes it: an answer, an ordinary error, and a sign-in refusal.
  const terms: FlexibleTerms = { version: 1, repo: world.project, signer: "alex", signerGeneration: world.store.accountOf("alex")!.generation, starters: "approvers-with-access", passwordFreeUpTo: "full", max: "full", default: "full",
    network: "confined", caps: { liveThreads: 3, turnsPerDayProject: 300, turnsPerDayPerson: 150, measuredMicrousdPerDay: null } };
  const digest = flexibleDigestOf(terms);
  world.store.handle.prepare(`INSERT INTO flexible_terms (repo, terms_json, digest, signed_terms_json, signed_digest, signed_by, signed_at, proof, changed_by, changed_at)
    VALUES (?, ?, ?, ?, ?, 'alex', ?, 'password-now', 'alex', ?)`).run(world.project, flexibleTermsJson(terms), digest, flexibleTermsJson(terms), digest, NOW.toISOString(), NOW.toISOString());
  const made = await prepareFlexibleThread(world.store, { repo: world.project, base: "HEAD", by: "alex", now: NOW });
  if (!made.ok) throw new Error(made.message);
  const lines: string[] = [];
  const started = await startFlexibleRelay(world.store, { thread: made.thread.id, log: line => lines.push(line) });
  if ("ok" in started) throw new Error(started.message);
  relays.push(started);
  const admitted = admitFlexibleTurn(world.store, { thread: made.thread.id, starter: { name: "alex", generation: world.store.accountOf("alex")!.generation }, digest, level: "full", freshProof: false,
    provider: "claude", model: "claude-sonnet-4-5", billing: "subscription", requestKey: "m-leak", holder: "h1", clock: () => NOW });
  if (!admitted.ok) throw new Error(admitted.message);
  if (!beginFlexibleTurn(world.store, { turn: admitted.turn, holder: "h1", clock: () => NOW }).ok) throw new Error("begin");
  const launch = randomBytes(16).toString("hex");
  world.store.handle.prepare(`INSERT INTO flexible_thread_launch (id, thread, provider, level, fence_digest, holder, host, marker, leader_pid, leader_start, state, started_at)
    VALUES (?, ?, 'claude', 'full', ?, 'h1', 'here', ?, ?, 't1', 'live', ?)`).run(launch, made.thread.id, "f".repeat(32), "9".repeat(32), fakePid(1), NOW.toISOString());
  const token = started.issue({ thread: made.thread.id, turn: admitted.turn, launch }).token;
  const answers: string[] = [];
  const call = async () => {
    const answer = await fetch(`${started.url}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 5, messages: [{ role: "user", content: "hi" }] }) });
    answers.push(JSON.stringify([...answer.headers.entries()]), await answer.text());
  };
  echo(200, auth => ({ type: "message", content: [{ type: "text", text: `key ${auth}` }], usage: { input_tokens: 1, output_tokens: 1 } }));
  await call();
  echo(500, auth => ({ type: "error", error: { type: "api_error", message: `oops ${auth}` } }));
  await call();
  echo(401, auth => ({ type: "error", error: { type: "authentication_error", message: `bad ${auth}` } }));
  await call();
  expect(flexibleSignInStatus(world.store, "alex").state).toBe("refused");

  // Removal, an export, a backup, a restore of that backup, then the upkeep.
  await cli(["clear", "flexible-sign-in", "--as", "alex", "--token", alex.token], "");
  const exported = buildExport(world.store, { who: "alex", now: NOW, evidenceRoot: join(world.dir, "evidence"), configDir: null });
  const backup = join(world.dir, "backup.db");
  await onlineCopy(world.databaseFile, backup);
  for (const relay of relays.splice(0)) await relay.close();
  world.store.close();
  expect(await restoreDatabase({ databaseFile: world.databaseFile, file: backup, dryRun: false, now: NOW })).toMatchObject({ ok: true });
  const restored = openStore(world.databaseFile);
  try {
    expect(restored.handle.prepare("SELECT COUNT(*) AS n FROM flexible_sign_in WHERE state <> 'retiring'").get()!["n"]).toBe(0);
    await tidyFlexibleSignIns(restored, world.state, { now: NOW });
    const folder = join(world.state, "tool-secrets", "flexible-sign-in");
    expect(existsSync(folder) ? readdirSync(folder) : []).toEqual([]);
    const tables = JSON.stringify(restored.handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => String(row["name"]))
      .filter(name => !name.startsWith("sqlite_")).map(name => restored.handle.prepare(`SELECT * FROM "${name}"`).all()));
    expect(leaked(tables, tokens), "a table").toEqual([]);
  } finally { restored.close(); }

  // Everywhere, as bytes and as text.
  const bytes = (path: string) => existsSync(path) ? readFileSync(path).toString("latin1") : "";
  const places: Record<string, string> = {
    "the database": bytes(world.databaseFile), "its WAL": bytes(`${world.databaseFile}-wal`), "the backup": bytes(backup),
    "the CLI's output": out.join("\n"), "the relay's log": lines.join("\n"), "the relay's answers": answers.join("\n"),
    "the export": exported.files.map(file => file.data.toString("utf8")).join("\n"),
  };
  for (const [where, text] of Object.entries(places)) expect(leaked(text, tokens), where).toEqual([]);
  // The sweep really looked: the CLI said what happened, the relay answered and logged, the export holds the ledger.
  expect(out.join("\n")).toContain("\"check\": \"accepted\"");
  expect(answers.join("\n")).toContain("Toolroll couldn't use your Claude sign-in");
  expect(lines.length).toBeGreaterThanOrEqual(3);
  expect(places["the export"]).toContain("claude sign-in for threads");
});
