/**
 * Attack (docs/plans/code-map.md §5): a laptop's local owner may turn the map on and off, and nothing else. `personProof
 * ("local-owner")` is true, so the holdout write refuses that basis by name; refresh has no act at all, on any surface.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openLocalWorld, type LocalWorld } from "../local-owner-world.js";
import { codeMapOn, readRefresh } from "../../src/code-map-store.js";
import { runAsLocalOwner } from "../../src/local-owner.js";
import { runOperate } from "../../src/operate.js";
import { join } from "node:path";

let world: LocalWorld;
beforeEach(async () => {
  world = await openLocalWorld();
  world.store.upsertProject(world.repo, "repo", new Date(), { remoteUrl: "https://git.example/repo.git" });
  world.store.handle.prepare("UPDATE project SET code_map_enroll_until = '2099-01-01T00:00:00.000Z'").run();
});
afterEach(async () => { await world.close(); });
const until = () => world.store.handle.prepare("SELECT code_map_enroll_until AS u FROM project WHERE path = ?").get(world.repo)!["u"];

describe("in the browser", () => {
  test("on and off work", async () => {
    const { cookie, csrf } = await world.localSession();
    expect((await world.post("/settings/project/code-map", cookie, { csrf, repo: world.repo, on: "0" })).status).toBe(303);
    expect(codeMapOn(world.store, world.repo)).toBe(false);
  });
  test("attack: refresh and the holdout are refused", async () => {
    const { cookie, csrf } = await world.localSession();
    expect((await world.post("/projects/repo/map/refresh", cookie, { csrf, repo: world.repo })).status).not.toBe(303);
    expect(readRefresh(world.store, world.repo)?.requestedAt ?? null).toBeNull();
    expect((await world.post("/settings/project/code-map/holdout", cookie, { csrf, repo: world.repo })).status).not.toBe(303);
    expect(until()).toBe("2099-01-01T00:00:00.000Z");
  });
});

describe("on the command line", () => {
  const run = async (...args: string[]) => {
    const out: string[] = [];
    const code = await runAsLocalOwner(() => runOperate("map", [...args, "--repo", world.repo, "--db", join(world.configDir, "state.db")], line => out.push(line), { now: new Date() }));
    return { code, text: out.join("\n") };
  };
  test("off works and reads still read", async () => {
    expect((await run("off")).code).toBe(0);
    expect(codeMapOn(world.store, world.repo)).toBe(false);
    expect((await run()).text).toContain("The code map is off");
  });
  test("attack: refresh and the holdout are refused before any command code", async () => {
    expect((await run("refresh")).code).not.toBe(0);
    expect((await run("holdout", "end")).code).not.toBe(0);
    expect(readRefresh(world.store, world.repo)?.requestedAt ?? null).toBeNull();
    expect(until()).toBe("2099-01-01T00:00:00.000Z");
  });
});
