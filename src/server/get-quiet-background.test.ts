/**
 * What pages no longer do still happens (docs/plans/get-side-effects.md): at the background pass, at the lead's follow
 * pass, or at the person's Check now (a POST with the form token).
 */
import { afterEach, expect, test, vi } from "vitest";
import { openQuietWorld, type QuietWorld } from "../../test/quiet-world.js";

let world: QuietWorld | null = null;
const seen: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await world?.close(); world = null; seen.length = 0; });
const until = async (ok: () => boolean, ms = 10_000) => { await vi.waitFor(() => { if (!ok()) throw new Error("not yet"); }, { timeout: ms, interval: 25 }); };

test("the background pass asks this computer, lifts the sign-in pause, turns the lead on by default, closes the expired mode and measures storage", async () => {
  let later = 0;
  world = await openQuietWorld(what => seen.push(what), { backgroundChecks: true, backgroundChecksMs: 100, clock: () => new Date(Date.now() + later) });
  const { cookie } = await world.signIn();
  world.signExpiredMode();
  const notified = world.notifications();
  // The agent signs in; past the sign-in check's 30-second cache, the next pass sees it.
  world.setSignedIn(true);
  later = 60_000;
  const w = world;
  await until(() => !w.pauseOpen() && w.store.getChatConfig() !== null && w.openModes() === 0);
  expect(world.store.getChatConfig()).toMatchObject({ provider: "claude-subscription", updatedBy: "toolroll" });
  expect(world.notifications()).toBeGreaterThan(notified);
  // The pages show what the pass found.
  expect(JSON.parse((await world.send("/lead/status", "GET", { cookie })).body)).toMatchObject({ lead: "on", agent: true, checkedAt: expect.any(String) });
  await vi.waitFor(async () => expect((await world!.send("/settings/storage", "GET", { cookie })).body).toContain("Checkouts use"), { timeout: 10_000 });
});

test("the lead's follow pass settles a turn past its deadline, which no page visit does", async () => {
  world = await openQuietWorld(what => seen.push(what));
  const { cookie } = await world.signIn();
  // The page shows it as it is, and settles nothing.
  expect((await world.send("/chat/mate/status", "GET", { cookie })).status).toBe(200);
  const w = world;
  await until(() => w.store.getLeadTurn(w.turnId)?.state === "failed", 15_000);
  expect(world.store.getLeadTurn(world.turnId)).toMatchObject({ state: "failed", failureReason: "crashed" });
}, 30_000);

test("Check now posts: models, the newest release, storage, the GitHub list and a sign-in each run on the POST and land on the page", async () => {
  let asked = 0;
  world = await openQuietWorld(what => seen.push(what), { updates: { latest: async () => { asked++; return { version: "99.0.0" }; } } });
  const { cookie, csrf } = await world.signIn();
  seen.length = 0;
  expect((await world.post("/settings/models/check", cookie, { csrf })).status).toBe(303);
  expect(seen.some(one => one.startsWith("fetch https://openrouter.ai"))).toBe(true);
  expect((await world.send("/settings/updates", "GET", { cookie })).body).not.toContain("99.0.0");
  expect((await world.post("/settings/updates/check", cookie, { csrf })).headers["location"]).toBe("/settings/updates");
  expect(asked).toBe(1);
  expect((await world.send("/settings/updates", "GET", { cookie })).body).toContain("99.0.0");
  expect((await world.post("/settings/storage/check", cookie, { csrf })).headers["location"]).toBe("/settings/storage");
  expect((await world.send("/settings/storage", "GET", { cookie })).body).toContain("Checkouts use");
  seen.length = 0;
  expect((await world.post("/projects/github", cookie, { csrf })).headers["location"]).toBe("/projects/github");
  expect(seen).toContain("gh list");
  expect((await world.send("/projects/github", "GET", { cookie })).body).toContain("gh is not installed");
  world.setSignedIn(true);
  seen.length = 0;
  expect((await world.post("/settings/connection/check", cookie, { csrf, provider: "claude", return: "/control?provider=claude" })).headers["location"]).toBe("/control?provider=claude");
  expect(seen.some(one => one.startsWith("probe claude"))).toBe(true);
  expect(world.pauseOpen()).toBe(false);
  expect((await world.send("/control?provider=claude", "GET", { cookie })).body).toContain("Connected");
});

test("the follow pass settles a turn past its deadline even while an update drains (the update waits on it)", async () => {
  world = await openQuietWorld(what => seen.push(what));
  const { installUpdateGate, removeUpdateGate } = await import("../desktop-update-gate.js");
  const { runLeadFollowPass } = await import("../lead-follow.js");
  installUpdateGate(world.store.raw(), "00000000-0000-4000-8000-000000000001");
  try {
    await runLeadFollowPass({ store: world.store, repos: () => [world!.repo], evidenceRoot: world.root, provider: () => null });
    expect(world.store.getLeadTurn(world.turnId)).toMatchObject({ state: "failed", failureReason: "crashed" });
  } finally { removeUpdateGate(world.store.raw(), "00000000-0000-4000-8000-000000000001"); }
});
