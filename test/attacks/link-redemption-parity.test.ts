/**
 * The two link roads can't drift (link-redemption.ts): the same matrix of accounts and states run through the browser's
 * GET /login/once/<code> and a terminal client's POST /login/once must admit and refuse alike — a revoked account, a
 * watcher, an identity-provider-only account, another device, a used link, local mode moved — with one intended
 * difference: the terminal road takes only a local owner's link.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openLocalWorld, LOCAL_WORLD_SETUP_MS, type LocalWorld } from "../local-owner-world.js";
import { setLocalModeOff } from "../../src/store.js";

let world: LocalWorld;
beforeEach(async () => { world = await openLocalWorld({ browserKey: true }); }, LOCAL_WORLD_SETUP_MS);
afterEach(async () => { await world.close(); });

type Road = "browser" | "terminal";
const TERMINAL = { "content-type": "application/json", "x-toolroll-client": "terminal" };
/** One presentation of `link` by a road: "admit", or the refusal's status. */
async function present(road: Road, link: string, extra: Record<string, string> = {}): Promise<"admit" | number> {
  const answer = road === "browser"
    ? await world.send(link, "GET", extra)
    : await world.send("/login/once", "POST", { ...TERMINAL, ...extra }, JSON.stringify({ code: link.slice("/login/once/".length) }));
  // The browser road answers a sign-in with the key's delivery page (200); the terminal road with its JSON (200).
  return answer.status === 200 || answer.status === 303 ? "admit" : answer.status;
}
const sessions = () => world.store.webSessions("alex").length;

/** Each case: how to set it up (returning the link to present and any headers), and what both roads must answer. */
const CASES: [string, () => { link: string; headers?: Record<string, string> }, "admit" | number][] = [
  ["a local owner's link", () => ({ link: world.server.mintLocalLink()! }), "admit"],
  ["from another device (forwarded)", () => ({ link: world.server.mintLocalLink()!, headers: { "x-forwarded-for": "100.64.0.7" } }), 403],
  ["the account removed", () => { const link = world.server.mintLocalLink()!; world.store.handle.prepare("UPDATE approver SET revoked_at = ? WHERE name = 'alex'").run(new Date().toISOString()); return { link }; }, 403],
  ["the account now a watcher", () => { const link = world.server.mintLocalLink()!; world.store.handle.prepare("UPDATE approver SET role = 'viewer' WHERE name = 'alex'").run(); return { link }; }, 403],
  ["an identity-provider-only account", () => {
    const link = world.server.mintLocalLink()!;
    // Passwords for operators only, and this account is limited to one project (no longer an installation operator).
    writeFileSync(join(world.configDir, "sign-in.json"), JSON.stringify({ issuer: "https://id.example", clientId: "toolroll", rules: [], passwords: "operators" }));
    world.store.handle.prepare("UPDATE approver SET projects_json = ? WHERE name = 'alex'").run(JSON.stringify([world.repo]));
    return { link };
  }, 403],
  ["local mode turned off after the link was minted", () => { const link = world.server.mintLocalLink()!; expect(setLocalModeOff(world.store, { name: "alex", authority: "full" }, new Date()).ok).toBe(true); return { link }; }, 410],
  ["no such link", () => ({ link: `/login/once/${"Q".repeat(43)}` }), 410],
];

test.each(CASES)("%s: both roads answer the same", async (_name, setUp, expected) => {
  const answers: Record<Road, "admit" | number> = { browser: 0, terminal: 0 };
  for (const road of ["browser", "terminal"] as const) {
    // Each road from the same starting state, with a link of its own.
    await world.close();
    world = await openLocalWorld({ browserKey: true });
    const { link, headers } = setUp();
    answers[road] = await present(road, link, headers);
    expect(sessions(), road).toBe(answers[road] === "admit" ? 1 : 0);
  }
  expect(answers).toEqual({ browser: expected, terminal: expected });
}, LOCAL_WORLD_SETUP_MS * 2);

test("a link is spent by its first presentation on either road, so the other road finds it used", async () => {
  for (const [first, second] of [["browser", "terminal"], ["terminal", "browser"]] as const) {
    const link = world.server.mintLocalLink()!;
    expect(await present(first, link)).toBe("admit");
    expect(await present(second, link)).toBe(410);
    expect(await present(first, link)).toBe(410);
  }
});

test("the one intended difference: a full account's link signs a browser in, never a terminal client", async () => {
  world.store.handle.prepare("UPDATE approver SET password_set = 1 WHERE name = 'alex'").run();
  expect(await present("browser", world.server.mintSignInLink("alex")!)).toBe("admit");
  expect(await present("terminal", world.server.mintSignInLink("alex")!)).toBe(403);
});
