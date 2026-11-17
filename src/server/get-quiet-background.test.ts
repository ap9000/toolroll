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
  await vi.waitFor(async () => expect((await world!.send("/settings/storage", "GET", { cookie })).body).toContain("Task folders use"), { timeout: 10_000 });
});

test("eight stranger 2: a signed-out Codex is never started for its servers; once signed in, the background pass lists them", async () => {
  let later = 0, codexIn = false, listed = 0, passes = 0;
  const probe = async (file: string, args: readonly string[]) => {
    seen.push(`probe ${file} ${args.join(" ")}`);
    if (file === "codex") return codexIn ? { code: 0, stdout: "Logged in using ChatGPT\n", stderr: "", timedOut: false, notFound: false } : { code: 1, stdout: "Not logged in\n", stderr: "", timedOut: false, notFound: false };
    return { code: 1, stdout: JSON.stringify({ loggedIn: false }), stderr: "", timedOut: false, notFound: false };
  };
  world = await openQuietWorld(what => seen.push(what), { backgroundChecks: true, backgroundChecksMs: 50, clock: () => new Date(Date.now() + later),
    connectionProbe: probe as never, codexToolList: async () => { listed += 1; return "[]"; }, onBackgroundPass: () => { passes += 1; } });
  await until(() => seen.filter(one => one === "probe codex login status").length >= 1);
  // Several passes while it is signed out, each started after the pass that heard it (passes run one at a time): never
  // asked for its servers.
  const heard = passes;
  await until(() => passes >= heard + 3);
  expect(listed).toBe(0);
  codexIn = true;
  later = 60 * 60_000;
  await until(() => listed > 0);
});

test("eight stranger 2, review: signed in when last asked, signed out since: the fresh check before listing its servers sees it", async () => {
  let codexAsked = 0, listed = 0, passes = 0;
  const probe = async (file: string, args: readonly string[]) => {
    seen.push(`probe ${file} ${args.join(" ")}`);
    if (file === "codex") { codexAsked += 1; return codexAsked === 1 ? { code: 0, stdout: "Logged in using ChatGPT\n", stderr: "", timedOut: false, notFound: false } : { code: 1, stdout: "Not logged in\n", stderr: "", timedOut: false, notFound: false }; }
    return { code: 1, stdout: JSON.stringify({ loggedIn: false }), stderr: "", timedOut: false, notFound: false };
  };
  world = await openQuietWorld(what => seen.push(what), { backgroundChecks: true, backgroundChecksMs: 50, connectionProbe: probe as never, codexToolList: async () => { listed += 1; return "[]"; },
    onBackgroundPass: () => { passes += 1; } });
  // The first pass saw it signed in; the next asks again, fresh, before listing, and hears signed out. That pass
  // finished (a listing would have been part of it), and one more after it.
  await until(() => codexAsked >= 2);
  const asked = passes;
  await until(() => passes >= asked + 2);
  expect(listed).toBe(0);
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
  expect((await world.send("/settings/storage", "GET", { cookie })).body).toContain("Task folders use");
  seen.length = 0;
  expect((await world.post("/projects/github", cookie, { csrf })).headers["location"]).toBe("/projects/github");
  expect(seen).toContain("gh list");
  expect((await world.send("/projects/github", "GET", { cookie })).body).toContain("The GitHub CLI isn’t installed on this computer.");
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

test("the update status reads its lock without making or changing the file", async () => {
  const { lockHeld, sqliteLock } = await import("../desktop-update.js");
  const { mkdtempSync, existsSync, writeFileSync, symlinkSync, statSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "so-lockheld-"));
  try {
    const file = join(dir, "worker.sqlite");
    expect(lockHeld(file)).toBe(false);
    expect(existsSync(file)).toBe(false);
    const held = sqliteLock(file)!;
    const before = statSync(file);
    expect(lockHeld(file)).toBe(true);
    held.close();
    expect(lockHeld(file)).toBe(false);
    expect(statSync(file).mode).toBe(before.mode);
    // A link where the lock should be is never followed: it counts as held.
    writeFileSync(join(dir, "elsewhere"), "");
    symlinkSync(join(dir, "elsewhere"), join(dir, "linked.sqlite"));
    expect(lockHeld(join(dir, "linked.sqlite"))).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
