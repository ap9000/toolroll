/**
 * A redirect isn't followed on any read of a remote main, its target is never shown or stored, and the renamed-repository
 * recovery works (docs/plans/code-map.md §1). A real HTTP server stands in for the remote through the runner's seam:
 * production refuses plain http, so only the fixture opts in.
 */
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, expect, test } from "vitest";
import { changeRemote, mapWorld, URL_A, URL_B, type MapWorld } from "../test/code-map-world.js";
import { boundedRun, type BoundedRunner } from "./bounded-spawn.js";
import { checkCodeMap } from "./code-map-build.js";
import { readRefresh } from "./code-map-store.js";
import { run } from "./exec.js";
import { remoteLandedProof } from "./landed-cleanup.js";
import { RemoteMains, REMOTE_MOVED } from "./remote-main.js";
import { forgetTrustedMain } from "./store.js";

const TARGET = "http://127.0.0.1:1/somewhere-else-entirely.git";
let world: MapWorld, server: Server, port: number, requests: string[];
const moved = () => `http://127.0.0.1:${port}/shop.git`;
const allowHttp = (arg: string) => arg === URL_A ? moved() : arg === "protocol.allow=never" ? "protocol.allow=always" : arg;

beforeEach(async () => {
  world = mapWorld();
  requests = [];
  server = createServer((request, response) => { requests.push(String(request.url)); response.writeHead(301, { Location: TARGET }); response.end("moved"); });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  port = (server.address() as { port: number }).port;
});
afterEach(async () => { world.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); });

const remotes = () => new RemoteMains(world.store, (file, args, options) => run(file, args.map(allowHttp), options), `${world.dir}/remote`);

test("attack: a trusted read shows the fixed reason, for landed cleanup and the nightly, without the target", async () => {
  const reader = remotes();
  const read = await reader.read(world.repo);
  reader.close();
  expect(read).toEqual({ ok: false, why: REMOTE_MOVED, reason: "moved" });
  expect(requests).toHaveLength(1);
  const proof = await remoteLandedProof(async () => read, world.repo, "a".repeat(40));
  expect(proof).toEqual({ landed: false, why: REMOTE_MOVED });
  forgetTrustedMain(world.store, world.repo, read.ok ? "" : read.why, world.now.at);
  expect(JSON.stringify(world.store.actionLedger({ repos: null }))).not.toContain("somewhere-else");
});

test("attack: the map shows it too, and after the recorded remote is updated the map is rebuilt for the new identity", async () => {
  const seam: BoundedRunner = (file, args, options) => boundedRun(file, args.map(allowHttp), options);
  expect(await checkCodeMap(world.store, world.repo, world.deps({ bounded: seam }))).toBe("failed");
  const held = readRefresh(world.store, world.repo)!;
  expect(held.lastError).toBe(REMOTE_MOVED);
  expect(JSON.stringify(held)).not.toContain("somewhere-else");
  changeRemote(world, URL_B);
  expect(readRefresh(world.store, world.repo)).toMatchObject({ failures: 0, retryAfter: null });
  expect(await checkCodeMap(world.store, world.repo, world.deps())).toBe("published");
});
