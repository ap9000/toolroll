/**
 * A plain GET only reads (docs/plans/get-side-effects.md). For every GET and HEAD row in the route table, signed in and
 * signed out, against a world where each action a page visit used to take would fire (test/quiet-world.ts): no table
 * changes outside the allowed bookkeeping, no child process starts, nothing reaches the network, and no notification is
 * queued.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const effects = vi.hoisted(() => ({ list: [] as string[], on: false }));
const note = (what: string) => { if (effects.on) effects.list.push(what); };
vi.mock("node:child_process", async original => {
  const real = await original<typeof import("node:child_process")>();
  const wrap = <F extends (...args: never[]) => unknown>(name: string, fn: F): F => ((...args: Parameters<F>) => {
    if (effects.on) effects.list.push(`spawn ${name} ${String(args[0])} ${Array.isArray(args[1]) ? (args[1] as string[]).join(" ") : ""}`.trim());
    return fn(...args);
  }) as F;
  const spied = { spawn: wrap("spawn", real.spawn), spawnSync: wrap("spawnSync", real.spawnSync), execFile: wrap("execFile", real.execFile),
    execFileSync: wrap("execFileSync", real.execFileSync), exec: wrap("exec", real.exec), execSync: wrap("execSync", real.execSync), fork: wrap("fork", real.fork) };
  return { ...real, ...spied, default: { ...real, ...spied } };
});
vi.mock("node:https", async original => {
  const real = await original<typeof import("node:https")>();
  const request = ((...args: Parameters<typeof real.request>) => { if (effects.on) effects.list.push(`https ${String(args[0])}`); return real.request(...args); }) as typeof real.request;
  const get = ((...args: Parameters<typeof real.get>) => { if (effects.on) effects.list.push(`https ${String(args[0])}`); return real.get(...args); }) as typeof real.get;
  return { ...real, request, get, default: { ...real, request, get } };
});

import { ROUTES } from "./route-table.js";
import { inReadOnlyRequest } from "../read-only-request.js";
import { openQuietWorld, type QuietWorld } from "../../test/quiet-world.js";

let world: QuietWorld;
beforeEach(async () => {
  effects.list.length = 0; effects.on = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => { note(`fetch ${String(input instanceof Request ? input.url : input)}`); throw new Error("no network in this test"); });
  world = await openQuietWorld(note);
});
afterEach(async () => {
  effects.on = false;
  vi.restoreAllMocks();
  await world.close();
});

test("every GET and HEAD row only reads: no writes beyond bookkeeping, no process, no network, no notification", async () => {
  const { cookie } = await world.signIn();
  world.signExpiredMode();
  // The world is as seeded: the mode still open, the turn still running, the pause still open.
  expect(world.openModes()).toBe(1);
  expect(world.store.getLeadTurn(world.turnId)?.state).toBe("running");
  expect(world.pauseOpen()).toBe(true);
  const notified = world.notifications();
  // Let the start-up look finish (it is not a page visit), then the agent signs in: a probe from here on would see it.
  await new Promise(done => setTimeout(done, 200));
  world.setSignedIn(true);
  // The lead's follow pass (every 5 s) settles that turn on its own: it is not a page visit, so while the routes are
  // walked it waits, and only a page could settle the turn (which this would then see).
  const sweep = world.store.sweepStaleLeadTurns.bind(world.store);
  vi.spyOn(world.store, "sweepStaleLeadTurns").mockImplementation(now => inReadOnlyRequest() ? sweep(now) : 0);
  const rows = ROUTES.filter(row => row.method !== "POST");
  expect(rows.length).toBeGreaterThan(100);
  const found: string[] = [];
  for (const row of rows) {
    for (const method of row.method === "GET,HEAD" ? ["GET", "HEAD"] : ["GET"]) {
      for (const who of [{ cookie }, {}]) {
        const before = world.snapshot();
        effects.list.length = 0; effects.on = true;
        const answer = await world.send(row.sample, method, who);
        // Anything a page set off in the background has a moment to land.
        await new Promise(done => setTimeout(done, 20));
        effects.on = false;
        const writes = world.changed(before, world.snapshot());
        const label = `${method} ${row.sample} (${row.id}${"cookie" in who ? "" : ", signed out"}) ${answer.status}`;
        if (writes.length > 0) found.push(`${label}: writes ${writes.join(", ")}`);
        if (effects.list.length > 0) found.push(`${label}: ${[...new Set(effects.list)].join("; ")}`);
      }
    }
  }
  expect(found).toEqual([]);
  expect(world.store.getChatConfig()).toBeNull();
  expect(world.openModes()).toBe(1);
  expect(world.pauseOpen()).toBe(true);
  expect(world.notifications()).toBe(notified);
});
