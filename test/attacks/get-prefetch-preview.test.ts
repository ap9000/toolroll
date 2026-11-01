/**
 * Attack: a GET that acts (quiet GETs, docs/plans/get-side-effects.md). Anything that makes a signed-in browser fetch a
 * console address (a link prefetch, a chat app's link preview, an <img src>, a restored tab) used to be able to ask the
 * provider CLIs and lift a sign-in pause (resuming work and notifying operators), turn the lead on, settle a lead turn's
 * spend, close an operating mode and withdraw what it approved, check models and queue notices, list GitHub repositories,
 * or run du, gh and codex. Now a GET only reads, and each of those runs only from the background pass or a POST that
 * carries the person's form token. Positive control: that POST does it.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const effects = vi.hoisted(() => ({ list: [] as string[], on: false }));
const note = (what: string) => { if (effects.on) effects.list.push(what); };
vi.mock("node:child_process", async original => {
  const real = await original<typeof import("node:child_process")>();
  const wrap = <F extends (...args: never[]) => unknown>(name: string, fn: F): F => ((...args: Parameters<F>) => {
    if (effects.on) effects.list.push(`spawn ${name} ${String(args[0])}`);
    return fn(...args);
  }) as F;
  const spied = { spawn: wrap("spawn", real.spawn), spawnSync: wrap("spawnSync", real.spawnSync), execFile: wrap("execFile", real.execFile),
    execFileSync: wrap("execFileSync", real.execFileSync), exec: wrap("exec", real.exec), execSync: wrap("execSync", real.execSync), fork: wrap("fork", real.fork) };
  return { ...real, ...spied, default: { ...real, ...spied } };
});

import { inReadOnlyRequest } from "../../src/read-only-request.js";
import { openQuietWorld, type QuietWorld } from "../quiet-world.js";

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

describe("attack: a prefetch or link preview makes the console act", () => {
  test("prefetches, previews, image loads and navigations of every page that used to act change nothing; the form-token POSTs do", async () => {
    const { cookie, csrf } = await world.signIn();
    world.signExpiredMode();
    await new Promise(done => setTimeout(done, 200));
    world.setSignedIn(true);
    const sweep = world.store.sweepStaleLeadTurns.bind(world.store);
    vi.spyOn(world.store, "sweepStaleLeadTurns").mockImplementation(now => inReadOnlyRequest() ? sweep(now) : 0);
    const project = encodeURIComponent(world.repo);
    const targets = ["/lead/status", "/inbox", "/chat", "/chat/mate/status", "/settings/lead", "/settings", "/settings?check-connection=claude",
      "/control", "/control?check-connection=1", "/control/connection", "/control?provider=openrouter&refresh-models=1", "/settings/models",
      "/settings/integrations", "/settings/updates", "/settings/updates?check=now", "/settings/storage", `/settings/pull-requests?repo=${project}`,
      "/settings/tools", "/settings/project", "/settings/skills", "/settings/knowledge", "/settings/learning", "/projects/github", "/push/key",
      "/mode", "/t/one", "/work", "/workbench?t=one",
      // POST-only doors, fetched.
      "/lead/check", "/settings/connection/check", "/settings/updates/check", "/settings/storage/check", "/projects/github"];
    const shapes: Record<string, Record<string, string>> = {
      prefetch: { cookie, purpose: "prefetch", "sec-purpose": "prefetch", "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" },
      preview: { cookie, "user-agent": "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)" },
      image: { cookie, accept: "image/avif,image/webp,*/*", "sec-fetch-dest": "image", "sec-fetch-mode": "no-cors", "sec-fetch-site": "cross-site", referer: "https://evil.example/" },
      navigation: { cookie, "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "none" },
      anonymous: { "user-agent": "facebookexternalhit/1.1" },
    };
    const before = world.snapshot();
    const notified = world.notifications();
    effects.on = true;
    for (const [shape, headers] of Object.entries(shapes)) {
      for (const target of targets) {
        for (const method of ["GET", "HEAD"]) {
          const answer = await world.send(target, method, headers);
          expect(answer.status, `${shape} ${method} ${target}`).not.toBe(500);
        }
      }
    }
    await new Promise(done => setTimeout(done, 50));
    effects.on = false;
    expect(effects.list).toEqual([]);
    expect(world.changed(before, world.snapshot())).toEqual([]);
    expect(world.notifications()).toBe(notified);
    expect(world.store.getChatConfig()).toBeNull();
    expect(world.pauseOpen()).toBe(true);
    expect(world.openModes()).toBe(1);
    expect(world.store.getLeadTurn(world.turnId)?.state).toBe("running");

    // A cross-site POST, and one without the form token, are refused before anything is asked.
    effects.on = true;
    const forged = await world.send("/lead/check", "POST", { cookie, origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, new URLSearchParams({ csrf }).toString());
    expect(forged.status).toBeGreaterThanOrEqual(400);
    expect((await world.post("/lead/check", cookie, {}, "application/json")).status).toBe(403);
    effects.on = false;
    expect(effects.list).toEqual([]);
    expect(world.store.getChatConfig()).toBeNull();

    // Positive control: the page's own check asks this computer, lifts the pause (its notice queued) and turns the lead
    // on by default.
    const checked = await world.post("/lead/check", cookie, { csrf }, "application/json");
    expect(JSON.parse(checked.body)).toMatchObject({ lead: "on", agent: true });
    expect(world.store.getChatConfig()?.provider).toBe("claude-subscription");
    expect(world.pauseOpen()).toBe(false);
    expect(world.notifications()).toBeGreaterThan(notified);
  });
});
