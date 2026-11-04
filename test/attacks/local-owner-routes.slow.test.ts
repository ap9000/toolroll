/**
 * Easy-start C1, the rule table: every console row of the route table, requested with a laptop local owner's own
 * cookie and form token, with Passwordless off and on. A row marked `deny` is refused by the central admission before
 * its handler (the local-owner refusal, leading to setting a password); a row marked `allow` never is.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { ROUTES } from "../../src/server/route-table.js";
import { setPasswordless } from "../../src/passwordless.js";
import { openLocalWorld, LOCAL_T0, type LocalWorld } from "../local-owner-world.js";

let world: LocalWorld;
beforeEach(async () => { world = await openLocalWorld(); });
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
        expect(answer.body, row.id).toContain('href="/password/set"');
      }
    }
    expect(wrong).toEqual([]);
    // The session still stands after walking every row (no row ended it as a side effect of a refusal).
    expect(world.store.webSessions("alex").filter(one => one.authority === "local-owner")).toHaveLength(1);
  }, 60_000);
}

