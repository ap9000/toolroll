/**
 * Attack and decision: how a Flexible thread's agent reaches its sign-in relay from inside the real thread fence
 * (flexible-relay.ts; the F2 breakdown's F2b "Reachability from inside the fence"), on Seatbelt on a Mac and bubblewrap
 * on Linux (needs(ctx, osFence())).
 *
 * The fence is proxy-only, so there were two roads: the run proxy forwarding a fixed pseudo-host to loopback, or the
 * sandbox runtime's second relay port (the slot a build's tool broker rides; a thread has no broker). Decided: the second
 * relay port. It needs no change to the run proxy (which stays a public-hosts-only allowlist that never reaches this
 * computer) and opens no other loopback port. Rows, each a real launch made by flexibleThreadSpawn:
 * - with the relay's port as the thread's second relay, the agent reaches the relay (at 127.0.0.1:<port> on a Mac,
 *   127.0.0.1:1080 inside the launch's own network on Linux), its call is forwarded (to a scripted stand-in for the model
 *   service, never a real one) and charged to the turn; the scripted service's own port and another local service stay
 *   unreachable, and the run proxy refuses a pseudo-host (it forwards nothing to loopback);
 * - without it, the relay is unreachable from the same fence: nothing else opens it.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { flexibleDigestOf, flexibleTermsJson, type FlexibleTerms } from "../../src/flexible.js";
import { admitFlexibleTurn, beginFlexibleTurn, flexibleTurn } from "../../src/flexible-turns.js";
import { flexibleThreadSpawn, prepareFlexibleThread, stopFlexibleThreadAgent } from "../../src/flexible-thread.js";
import { relayUrlInside, startFlexibleRelay, type FlexibleRelayServer } from "../../src/flexible-relay.js";
import { proxyEnv, startEgressProxy, type EgressProxy } from "../../src/egress.js";
import { standInSignIn } from "../flexible-sign-in-kit.js";
import { threadWorld, type ThreadWorld } from "../flexible-thread-world.js";
import { needs, osFence } from "./harness.js";

vi.mock("../../src/flexible-available.js", async original => ({ ...await original<typeof import("../../src/flexible-available.js")>(), flexibleAvailable: () => true }));
const scripted = vi.hoisted(() => ({ origin: "http://127.0.0.1:9" }));
vi.mock("../../src/flexible-relay-upstreams.js", async importOriginal => {
  const real = await importOriginal<typeof import("../../src/flexible-relay-upstreams.js")>();
  return { FLEXIBLE_RELAY_UPSTREAMS: { claude: { ...real.FLEXIBLE_RELAY_UPSTREAMS.claude, get origin() { return scripted.origin; } } } };
});

const NOW = new Date();
const STORAGE = { names: [], denies: [] };
const SETUP_TOKEN = ["sk", "ant", "oat01", randomBytes(24).toString("hex")].join("-");
let world: ThreadWorld, relay: FlexibleRelayServer | null, egress: EgressProxy | null, path: string | undefined;
const servers: Server[] = [];
// The launches get only the system's own folders on PATH: no real agent program (claude, codex, gemini) can be found.
beforeEach(() => { world = threadWorld(); relay = null; egress = null; path = process.env["PATH"]; process.env["PATH"] = "/usr/bin:/bin"; });
afterEach(async () => {
  process.env["PATH"] = path;
  await relay?.close();
  await egress?.close();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
  world.store.close();
  rmSync(world.dir, { recursive: true, force: true });
});
async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", () => done()));
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : 0;
}

/** What the agent does inside the fence: one call to the relay, a direct connection to each port, and a pseudo-host
 * through the run proxy; one line each. */
const PROBE = `
const http = require("http"), net = require("net");
const say = (name, value) => console.log(name + " " + value);
const post = (url, headers, body) => new Promise(done => {
  const target = new URL(url);
  const call = http.request({ host: target.hostname, port: target.port, path: target.pathname + target.search, method: "POST", headers }, answer => {
    let text = ""; answer.on("data", chunk => { text += chunk; }); answer.on("end", () => done(answer.statusCode + " " + text.slice(0, 300)));
  });
  call.on("error", error => done("error " + error.code));
  call.setTimeout(5000, () => call.destroy(Object.assign(new Error("timeout"), { code: "TIMEOUT" })));
  call.end(body);
});
const reach = port => new Promise(done => {
  const socket = net.connect(port, "127.0.0.1");
  socket.on("connect", () => { socket.destroy(); done("connected"); });
  socket.on("error", error => done("refused " + error.code));
  setTimeout(() => { socket.destroy(); done("no answer"); }, 4000);
});
(async () => {
  // No real agent program is reachable in this launch: nothing here can call a model.
  const fs = require("fs"), path = require("path");
  const found = ["claude", "codex", "gemini"].filter(name => (process.env.PATH || "").split(":").some(dir => { try { fs.accessSync(path.join(dir, name), fs.constants.X_OK); return true; } catch { return false; } }));
  say("agents", found.length === 0 ? "none" : found.join(","));
  say("relay", await post(process.env.RELAY_URL + "/v1/messages?beta=true", { authorization: "Bearer " + process.env.RELAY_TOKEN, "content-type": "application/json", "anthropic-version": "2023-06-01" },
    JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 5, messages: [{ role: "user", content: "hi" }] })));
  for (const port of JSON.parse(process.env.DIRECT_PORTS)) say("direct-" + port, await reach(port));
  const proxy = new URL(process.env.HTTP_PROXY || "http://127.0.0.1:1");
  const auth = "Basic " + Buffer.from(decodeURIComponent(proxy.username) + ":" + decodeURIComponent(proxy.password)).toString("base64");
  say("via-proxy", await new Promise(done => {
    const call = http.request({ host: proxy.hostname, port: proxy.port, method: "POST", path: "http://relay.toolroll.internal/v1/messages", headers: { host: "relay.toolroll.internal", "proxy-authorization": auth, "content-type": "application/json" } },
      answer => { answer.resume(); done(String(answer.statusCode)); });
    call.on("error", error => done("error " + error.code));
    call.setTimeout(5000, () => call.destroy());
    call.end("{}");
  }));
})();
`;

describe("attack: reaching the sign-in relay from inside the thread fence", () => {
  test("native: the relay rides the fence's second relay port and is reached there; nothing else on this computer opens, and the run proxy forwards no pseudo-host", async ctx => {
    needs(ctx, osFence());
    world.store.saveApprover("alex", "hash-a", NOW);
    const terms: FlexibleTerms = { version: 1, repo: world.project, signer: "alex", signerGeneration: world.store.accountOf("alex")!.generation, starters: "approvers-with-access",
      passwordFreeUpTo: "full", max: "full", default: "full", network: "confined", caps: { liveThreads: 3, turnsPerDayProject: 300, turnsPerDayPerson: 150, measuredMicrousdPerDay: null } };
    const digest = flexibleDigestOf(terms);
    world.store.handle.prepare(`INSERT INTO flexible_terms (repo, terms_json, digest, signed_terms_json, signed_digest, signed_by, signed_at, proof, changed_by, changed_at)
      VALUES (?, ?, ?, ?, ?, 'alex', ?, 'password-now', 'alex', ?)`).run(world.project, flexibleTermsJson(terms), digest, flexibleTermsJson(terms), digest, NOW.toISOString(), NOW.toISOString());
    const made = await prepareFlexibleThread(world.store, { repo: world.project, base: "HEAD", by: "alex", now: NOW });
    if (!made.ok) throw new Error(made.message);
    const id = made.thread.id;

    // The scripted model service and another local service, both on this computer's loopback.
    const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
    const upstream = await listen(createServer((request, response) => {
      seen.push({ url: request.url ?? "", headers: request.headers });
      request.resume();
      request.on("end", () => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ type: "message", role: "assistant", content: [], usage: { input_tokens: 4, output_tokens: 2 } })));
    }));
    scripted.origin = `http://127.0.0.1:${upstream}`;
    const other = await listen(createServer((_request, response) => response.end("other")));
    standInSignIn(world.store, world.state, "alex", SETUP_TOKEN);
    const started = await startFlexibleRelay(world.store, { thread: id });
    if ("ok" in started) throw new Error(started.message);
    relay = started;
    egress = await startEgressProxy({ hosts: [] });

    const launchOnce = async (relayPort: number | undefined, url: string): Promise<{ out: string; turn: string }> => {
      const admitted = admitFlexibleTurn(world.store, { thread: id, starter: { name: "alex", generation: world.store.accountOf("alex")!.generation }, digest, level: "full", freshProof: false,
        provider: "claude", model: "claude-sonnet-4-5", billing: "subscription", requestKey: `m-${randomBytes(4).toString("hex")}`, holder: "h1" });
      if (!admitted.ok) throw new Error(admitted.message);
      const begun = beginFlexibleTurn(world.store, { turn: admitted.turn, holder: "h1" });
      if (!begun.ok) throw new Error(begun.message);
      const launch = await flexibleThreadSpawn(world.store, {
        id, network: { proxyPort: egress!.port, token: egress!.secret, ...(relayPort === undefined ? {} : { relayPort }) }, storage: STORAGE,
        proxyEnv: proxyEnv(egress!, "proxy-only"), launch: { provider: "claude", level: "full", turn: admitted.turn, holder: "h1" },
        agentEnvFor: launchId => ({ RELAY_URL: url, RELAY_TOKEN: relay!.issue({ thread: id, turn: admitted.turn, launch: launchId }).token, DIRECT_PORTS: JSON.stringify([upstream, other]) }),
        beforeOpen: () => null,
      }, process.execPath, ["-e", PROBE]);
      if (!launch.ok) throw new Error(launch.message);
      launch.child.stdin!.end();
      const out = await new Promise<string>(done => {
        let text = "";
        launch.child.stdout!.on("data", chunk => { text += chunk; });
        launch.child.stderr!.on("data", chunk => { text += chunk; });
        launch.child.on("close", () => done(text));
      });
      expect(await stopFlexibleThreadAgent(world.store, { id, reason: "probe ended" })).toMatchObject({ ok: true });
      return { out, turn: admitted.turn };
    };
    const line = (out: string, name: string) => out.split("\n").find(one => one.startsWith(`${name} `))?.slice(name.length + 1) ?? `(no ${name} line in: ${out.slice(0, 600)})`;

    // The decided road: the relay's port is the thread's second relay.
    const inside = relayUrlInside(relay.port);
    expect(inside).toBe(process.platform === "linux" ? "http://127.0.0.1:1080" : `http://127.0.0.1:${relay.port}`);
    const opened = await launchOnce(relay.port, inside);
    expect(line(opened.out, "agents")).toBe("none");
    expect(line(opened.out, "relay"), opened.out).toMatch(/^200 \{"type":"message"/);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("/v1/messages?beta=true");
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${SETUP_TOKEN}`);
    expect(world.store.handle.prepare("SELECT turn, status, tokens_in, tokens_out FROM thread_relay_call").all().map(row => ({ ...row }))).toEqual([{ turn: opened.turn, status: "completed", tokens_in: 4, tokens_out: 2 }]);
    expect(flexibleTurn(world.store, opened.turn)).toMatchObject({ relayCalls: 1, tokensIn: 4, tokensOut: 2 });
    // Nothing else of this computer's loopback: the scripted service's own port and another service stay shut.
    expect(line(opened.out, `direct-${upstream}`)).not.toBe("connected");
    expect(line(opened.out, `direct-${other}`)).not.toBe("connected");
    // The run proxy forwards no pseudo-host to loopback: it is a public-hosts-only allowlist.
    expect(line(opened.out, "via-proxy"), opened.out).toBe("403");

    // Without the second relay port, the same fence can't reach the relay at its own address.
    const shut = await launchOnce(undefined, `http://127.0.0.1:${relay.port}`);
    expect(line(shut.out, "relay"), shut.out).toMatch(/^error /);
    expect(seen).toHaveLength(1);
  }, 120_000);
});
