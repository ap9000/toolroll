/**
 * Threads for everyday use, slice S6 (the owner's D2), over HTTP from the workbench's `w` link: a local owner's browser
 * session finishes the threads setup with a password typed into the form, and nothing else. Turning threads on and
 * saving their own Claude sign-in each take the account's real password typed now (an empty one is refused, never the
 * act standing in); a wrong one is refused like any sign-in's; the session stays a local owner's afterwards (no
 * remembered password, no upgrade), so a credential act off the list still refuses it; and turning threads off and
 * removing the sign-in only narrow. With no password set yet it says how to set one. A stand-in for the model service's
 * address (nothing listens there): the sign-in's live check reaches no network.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { openLocalWorld, LOCAL_WORLD_SETUP_MS, type LocalWorld } from "../local-owner-world.js";
import { enrollOwnerPassword, localModeOf } from "../../src/store.js";
import { hashPassword } from "../../src/scope.js";
import { flexibleAvailable } from "../../src/flexible-available.js";
import { flexibleSignInStatus } from "../../src/flexible-sign-in.js";
import { standInToken } from "../flexible-sign-in-kit.js";

vi.mock("../../src/flexible-relay-upstreams.js", async importOriginal => {
  const real = await importOriginal<typeof import("../../src/flexible-relay-upstreams.js")>();
  return { FLEXIBLE_RELAY_UPSTREAMS: { claude: { ...real.FLEXIBLE_RELAY_UPSTREAMS.claude, origin: "http://127.0.0.1:9" } } };
});

const PASSWORD = "correct horse battery";
let world: LocalWorld;
beforeAll(async () => { world = await openLocalWorld(); }, LOCAL_WORLD_SETUP_MS);
afterAll(async () => { await world.close(); });

const problemOf = (answer: { headers: Record<string, unknown> }) => {
  const location = String(answer.headers["location"] ?? "");
  return new URL(location, "http://x").searchParams.get("problem");
};

describe("the threads setup from a local owner's session", () => {
  test("with no password set yet, saving says how to set one; nothing is saved", async () => {
    const { cookie, csrf } = await world.localSession();
    const saved = await world.post("/settings/flexible-sign-in", cookie, { csrf, token: standInToken(), password: "" });
    expect(saved.status).toBe(303);
    expect(problemOf(saved)).toMatch(/^Set a password first|needs your Toolroll password|Set a password to do this/);
    expect(flexibleSignInStatus(world.store, "alex")).toEqual({ state: "none" });
  });

  test("a password typed now turns threads on and saves the sign-in; empty or wrong never does; the session stays a local owner's", async () => {
    expect(enrollOwnerPassword(world.store, "alex", hashPassword(PASSWORD), localModeOf(world.store)!.generation, new Date()).ok).toBe(true);
    const { cookie, csrf } = await world.localSession();
    // Threads on: empty and wrong refused, right accepted.
    for (const password of ["", "not the password"]) {
      const refused = await world.post("/settings/flexible", cookie, { csrf, enabled: "on", password });
      expect(problemOf(refused)).toBe("Turning interactive agent threads on needs your Toolroll password, typed now.");
      expect(flexibleAvailable(world.store)).toBe(false);
    }
    const on = await world.post("/settings/flexible", cookie, { csrf, enabled: "on", password: PASSWORD });
    expect(problemOf(on)).toBeNull();
    expect(flexibleAvailable(world.store)).toBe(true);
    // The sign-in: empty refused, right saved (its live check reaches nothing here).
    expect(problemOf(await world.post("/settings/flexible-sign-in", cookie, { csrf, token: standInToken(), password: "" }))).not.toBeNull();
    expect(flexibleSignInStatus(world.store, "alex")).toEqual({ state: "none" });
    const saved = await world.post("/settings/flexible-sign-in", cookie, { csrf, token: standInToken(), password: PASSWORD });
    expect(problemOf(saved)).toBeNull();
    expect(flexibleSignInStatus(world.store, "alex").state).toBe("active");
    // Nothing carried over: the session is still a local owner's, with no remembered password.
    const row = world.store.handle.prepare("SELECT authority FROM web_session WHERE account = 'alex' ORDER BY created_at DESC LIMIT 1").get();
    expect(row?.["authority"]).toBe("local-owner");
    // A credential act off the list (saying it's just you) still refuses this session, the password typed or not.
    const justMe = await world.post("/settings/install-mode/solo", cookie, { csrf, password: PASSWORD });
    expect(justMe.status).toBe(403);
    expect(justMe.body).toContain("Sign in with your password to do this.");
    // Narrowing needs no password: removing the sign-in, then turning threads off.
    expect(problemOf(await world.post("/settings/flexible-sign-in-clear", cookie, { csrf, password: "" }))).toBeNull();
    expect(flexibleSignInStatus(world.store, "alex").state).not.toBe("active");
    expect(problemOf(await world.post("/settings/flexible", cookie, { csrf, enabled: "off", password: "" }))).toBeNull();
    expect(flexibleAvailable(world.store)).toBe(false);
  });
});
