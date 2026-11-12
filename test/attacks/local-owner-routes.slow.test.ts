/**
 * Easy-start C1, the rule table: every console row of the route table, requested with a laptop local owner's own
 * cookie and form token, with Passwordless off and on. A row marked `deny` is refused by the central admission before
 * its handler (the local-owner refusal, leading to setting a password); a row marked `allow` never is.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { ROUTES } from "../../src/server/route-table.js";
import { setPasswordless } from "../../src/passwordless.js";
import { openLocalWorld, LOCAL_T0, LOCAL_WORLD_SETUP_MS, type LocalWorld } from "../local-owner-world.js";
import { LOCAL_OWNER_ELSEWHERE } from "../../src/local-owner.js";

let world: LocalWorld;
beforeEach(async () => { world = await openLocalWorld(); }, LOCAL_WORLD_SETUP_MS);
afterEach(async () => { await world.close(); });

for (const passwordless of [false, true]) {
  test(`every row: deny rows refused before the handler, allow rows admitted (Passwordless ${passwordless ? "on" : "off"})`, async () => {
    if (passwordless) setPasswordless(world.store, true, "alex", LOCAL_T0);
    const { cookie, csrf } = await world.localSession();
    const rows = ROUTES.filter(row => row.stage === "console");
    expect(rows.length).toBeGreaterThan(150);
    const wrong: string[] = [];
    for (const row of rows) {
      const answer = row.method === "POST"
        ? await world.post(row.sample, cookie, { csrf })
        : await world.send(row.sample, "GET", { cookie });
      const refused = answer.headers["x-toolroll-refused"] === "local-owner";
      if (refused !== (row.local === "deny")) wrong.push(`${row.method} ${row.sample} (${row.id}, ${row.local}) → ${answer.status}${refused ? " refused as local owner" : ""}`);
      if (refused) {
        expect(answer.status, row.id).toBe(403);
        // Before a password exists, the refusal leads to setting one.
        expect(answer.body, row.id).toContain("Set a password to do this.");
        expect(answer.body, row.id).toMatch(/href="\/password\/set(\?next=%2F[^"]*)?"/);
      }
    }
    expect(wrong).toEqual([]);
    // The session still stands after walking every row (no row ended it as a side effect of a refusal).
    expect(world.store.webSessions("alex").filter(one => one.authority === "local-owner")).toHaveLength(1);
  }, 60_000);
}

// Local-owner slice 0: the same walk from anywhere but this computer — through a proxy (a forwarding header) and at a
// tailnet name the console admits. Every row, allow and deny alike, is refused before its policy or handler with the
// one plain refusal, and nothing changes: no task, no ledger line, not even the session's last use.
test("every row, from anywhere but this computer: refused before anything runs, and nothing changes", async () => {
  const TAILNET = "laptop.example.ts.net";
  await world.close();
  world = await openLocalWorld({ allowedHosts: [TAILNET] });
  const { cookie, csrf } = await world.localSession();
  const unchanged = () => JSON.stringify([world.store.handle.prepare("SELECT id, state FROM task ORDER BY id").all(),
    world.store.handle.prepare("SELECT COUNT(*) AS n FROM action_ledger").get(), world.store.webSessions("alex")]);
  const before = unchanged();
  const wrong: string[] = [];
  for (const elsewhere of [{ "x-forwarded-for": "100.64.0.7" }, { forwarded: "for=100.64.0.7" }, { host: TAILNET }] as Record<string, string>[]) {
    const origin = elsewhere["host"] === undefined ? world.origin : `http://${TAILNET}`;
    for (const row of ROUTES.filter(one => one.stage === "console")) {
      const answer = row.method === "POST"
        ? await world.send(row.sample, "POST", { cookie, origin, "content-type": "application/x-www-form-urlencoded", ...elsewhere }, new URLSearchParams({ csrf }).toString())
        : await world.send(row.sample, "GET", { cookie, ...elsewhere });
      if (answer.status !== 403 || answer.headers["x-toolroll-refused"] !== "local-owner-elsewhere" || answer.body !== LOCAL_OWNER_ELSEWHERE) {
        wrong.push(`${JSON.stringify(elsewhere)} ${row.method} ${row.sample} (${row.id}) → ${answer.status}`);
      }
    }
  }
  expect(wrong).toEqual([]);
  expect(unchanged()).toBe(before);
}, 60_000);
