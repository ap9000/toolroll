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
  // Each row's own sample, then the addresses that reach deeper into the pages that used to act: a project named,
  // a search typed, the old "check now" query strings, a task's chat.
  const project = encodeURIComponent(world.repo);
  const deeper = [`/settings/pull-requests?repo=${project}`, `/settings/knowledge?repo=${project}&q=refunds`, `/settings/tools?repo=${project}`,
    `/settings/project?repo=${project}`, "/control?provider=openrouter&refresh-models=1", "/control?check-connection=1", "/settings?check-connection=claude",
    "/settings/updates?check=now", "/chat?task=one", "/chat/mate/status?task=one", "/chat/task-status?task=one", "/workbench?t=one", "/t/one"];
  const targets = [...rows.flatMap(row => (row.method === "GET,HEAD" ? ["GET", "HEAD"] : ["GET"]).map(method => ({ method, path: row.sample, id: row.id }))),
    ...deeper.map(path => ({ method: "GET", path, id: "deeper" }))];
  const found: string[] = [];
  const answered = new Map<string, number>();
  for (const { method, path, id } of targets) {
    for (const who of [{ cookie }, {}]) {
      const before = world.snapshot(), files = world.files();
      effects.list.length = 0; effects.on = true;
      const answer = await world.send(path, method, who);
      // Anything a page set off in the background has a moment to land.
      await new Promise(done => setTimeout(done, 20));
      effects.on = false;
      if ("cookie" in who && method === "GET") answered.set(path, answer.status);
      const writes = world.changed(before, world.snapshot());
      const touched = world.changed(files, world.files());
      const label = `${method} ${path} (${id}${"cookie" in who ? "" : ", signed out"}) ${answer.status}`;
      if (writes.length > 0) found.push(`${label}: writes ${writes.join(", ")}`);
      if (touched.length > 0) found.push(`${label}: files ${touched.join(", ")}`);
      // Kept on GET (the plan, "Kept on GET"): Settings → Knowledge's search reads the project with the hardened git
      // only: its config inspected, then git with no network, no attributes, hooks or fsmonitor (and, once per process,
      // whether git has --no-lazy-fetch: teardown-git.ts lazyFetchSupported).
      const kept = (one: string) => path.startsWith("/settings/knowledge?") && (/^spawn spawnSync git (config --file \S+ --no-includes|--no-optional-locks config --list|--no-lazy-fetch version$)/.test(one)
        // The probe asks the very executable a view runs, by its real path (eval-harness review 2, follow-up).
        || /^spawn spawnSync \/\S+\/git --no-lazy-fetch version$/.test(one)
        || /^spawn spawnSync git .*(--no-lazy-fetch )?--attr-source=4b825dc642cb6eb9a060e54bf8d69288fbee4904 -c protocol\.allow=never /.test(one));
      const acted = effects.list.filter(one => !kept(one));
      if (acted.length > 0) found.push(`${label}: ${[...new Set(acted)].join("; ")}`);
    }
  }
  expect(found).toEqual([]);
  // The pages that used to act really rendered (no redirect or refusal hid their handler).
  const rendered = ["/lead/status", "/inbox", "/chat", "/settings", "/settings/lead", "/settings/models", "/settings/integrations", "/settings/updates",
    "/settings/storage", "/settings/skills", "/settings/learning", "/control", "/control/connection", "/projects/github", "/push/key", "/mode", "/t/one",
    ...deeper];
  expect(Object.fromEntries(rendered.map(path => [path, answered.get(path)]))).toEqual(Object.fromEntries(rendered.map(path => [path, 200])));
  // The search really ran (through the hardened git) and found the committed file.
  expect((await world.send(`/settings/knowledge?repo=${project}&q=refunds`, "GET", { cookie })).body).toContain("README.md");
  expect(world.store.getChatConfig()).toBeNull();
  expect(world.openModes()).toBe(1);
  expect(world.pauseOpen()).toBe(true);
  expect(world.notifications()).toBe(notified);
});
