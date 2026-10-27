/** The Live grid's room (agents-live-room.ts; docs/plans/agents-view.md §3): files looked at on the poll only, once per
 * run however many viewers or signals; each look proved from the run's current row; read as the keyed account. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { acquire } from "../claim.js";
import { createLiveBus, type LiveConnection } from "../live-bus.js";
import { liveDir } from "../live.js";
import { register } from "../runner.js";
import { addApprover } from "../scope.js";
import { openStore, type Store } from "../store.js";
import { requestContext } from "./request-context.js";

const opened: string[] = [];
let onOpen: (name: string) => void = () => {};
vi.mock("../live-open.js", async original => {
  const real = await original<typeof import("../live-open.js")>();
  return { ...real, openLiveTrusted: (root: string, name: string) => { opened.push(name); onOpen(name); return real.openLiveTrusted(root, name); } };
});
const { createAgentsLiveRooms } = await import("./agents-live-room.js");

const REPO = "/repo/live-room";
let store: Store, root: string;
beforeEach(() => {
  opened.length = 0;
  onOpen = () => {};
  store = openStore(":memory:");
  if (!addApprover(store, "alex", new Date()).ok) throw new Error("alex");
  register(store, { name: "mac", host: "test", capacity: 9, repos: [REPO], now: new Date(), newToken: () => "tok-mac" });
  root = mkdtempSync(join(tmpdir(), "so-live-room-"));
  mkdirSync(liveDir(root), { mode: 0o700 });
});
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

function running(id: string): number {
  store.createTask({ id, title: id }, new Date());
  const ref = store.refFor("built-in", id).id;
  store.placeTask(ref, REPO);
  const took = acquire(store, ref, "mac", { now: new Date(), token: "tok-mac", newLeaseId: () => `lease-${id}`, ttlMs: 3_600_000 });
  if (!took.ok) throw new Error(took.reason);
  const run = store.startRun({ taskRef: ref, leaseId: `lease-${id}`, runner: "mac", branch: id, worktree: `/w/${id}`, route: { routeDigest: "legacy", phase: "build", provider: "claude", model: "m", chosen: "legacy" }, now: new Date() });
  writeFileSync(join(liveDir(root), `${run}.jsonl`), "{}\n", { mode: 0o600 });
  return run;
}
const viewer = (name: string, sent: string[], valid = () => true) => ({
  name, room: "agents-live", valid,
  connection: { open: true, rooms: 1, send: (_room: string, event: string, data: Record<string, unknown> = {}) => { sent.push(`${event}:${String(data["at"] ?? "")}`); },
    onClose: () => () => {}, onKeepAlive: () => () => {}, refuse: (leave: () => void) => leave(), close: () => {} } as unknown as LiveConnection,
});

test("a burst of signals and several rooms look at each file once per poll", () => {
  const run = running("t-1");
  const bus = createLiveBus();
  const room = createAgentsLiveRooms({ store, bus, evidenceRoot: root, localRunner: "mac", clock: () => new Date(), visible: () => true });
  const a: string[] = [], b: string[] = [];
  // Two viewers' rooms (another page with another scope key): one shared look.
  room.rooms.join(room.keyOf("alex", "all"), viewer("alex", a));
  room.rooms.join(room.keyOf("alex", "other"), viewer("alex", b));
  for (let n = 0; n < 100; n += 1) bus.publish({ revision: String(n) });
  expect(opened.filter(name => name.startsWith(`${run}.`))).toEqual([`${run}.jsonl`, `${run}.sub.jsonl`]);
  room.rooms.close();
});

test("each look is proved from the run's row: a run moved away between its two files stops there", () => {
  const run = running("t-2");
  let away = false;
  const bus = createLiveBus();
  const room = createAgentsLiveRooms({ store, bus, evidenceRoot: root, localRunner: "mac", clock: () => new Date(), visible: repo => !(away && repo === REPO) });
  // The first file's look moves the run out of the console's view.
  onOpen = name => { if (name === `${run}.jsonl`) away = true; };
  room.rooms.join(room.keyOf("alex", "all"), viewer("alex", []));
  expect(opened).toEqual([`${run}.jsonl`]);
  room.rooms.close();
});

test("the fingerprint is read as the keyed account, whoever's write woke the bus", () => {
  running("t-3");
  const bus = createLiveBus();
  const visible = () => requestContext.getStore()?.actor === "alex";
  const room = createAgentsLiveRooms({ store, bus, evidenceRoot: root, localRunner: "mac", clock: () => new Date(), visible });
  const sent: string[] = [];
  requestContext.run({ actor: "alex", csrf: "", returnTo: "/" }, () => room.rooms.join(room.keyOf("alex", "all"), viewer("alex", sent)));
  requestContext.run({ actor: "robin", csrf: "", returnTo: "/" }, () => bus.publish({ revision: "x" }));
  expect(sent).toHaveLength(1); // only the join's own change: robin's signal moved nothing for alex
  room.rooms.close();
});
