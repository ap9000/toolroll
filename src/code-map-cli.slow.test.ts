/** `toolroll map` against a fixture remote: overview and --json, a new commit, a failed check's back-off. */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mapWorld, type MapWorld } from "../test/code-map-world.js";
import { checkCodeMap } from "./code-map-build.js";
import { runOperate } from "./operate.js";

let world: MapWorld;
beforeEach(() => { world = mapWorld({ "src/a/one.ts": "export const one = 1;\nimport './two.js';\n", "src/a/two.ts": "export function two() {}\n", "src/b/three.ts": "import '../a/one.js';\n" }); });
afterEach(() => { world.close(); });
const map = async (...args: string[]) => {
  const out: string[] = [];
  const code = await runOperate("map", [...args], line => out.push(line), { databaseFile: `${world.dir}/orders.db`, clock: () => world.now.at });
  return { code, text: out.join("\n") };
};
const json = async (...args: string[]) => JSON.parse((await map(...args, "--json")).text) as Record<string, any>;

test("overview, --json, views, and a new commit makes a new version", async () => {
  expect((await map("--repo", world.repo)).text).toContain("Making the first map.");
  await checkCodeMap(world.store, world.repo, world.deps());
  const read = await map("--repo", world.repo);
  expect(read.code).toBe(0);
  expect(read.text).toContain("Code map · main at");
  expect(read.text).toContain("untrusted data");
  expect(read.text).toContain("src/b · 1 files · ts · uses src/a");
  const overview = await json("--repo", world.repo);
  expect(overview).toMatchObject({ ok: true, command: "map", state: "current", map: { v: 1, ok: true, view: "overview" } });
  expect((await json("area", "src/a", "--repo", world.repo)).map.items).toHaveLength(2);
  expect((await json("file", "src/a/two.ts", "--repo", world.repo)).map.items).toContainEqual({ importedBy: "src/a/one.ts", kind: "imports", line: 2 });
  expect((await json("search", "two", "--repo", world.repo)).map.items).toContainEqual({ kind: "name", path: "src/a/two.ts", name: "two", line: 1 });
  world.commit({ "src/a/four.ts": "export const four = 4;\n" });
  await checkCodeMap(world.store, world.repo, world.deps());
  expect((await json("--repo", world.repo)).map.version).toBeGreaterThan(overview.map.version);
});

test("a failed check shows the reason and the next try, with the last map", async () => {
  await checkCodeMap(world.store, world.repo, world.deps());
  world.commit({ "src/a/four.ts": "export const four = 4;\n" });
  world.now.at = new Date(world.now.at.getTime() + 31 * 60_000);
  await checkCodeMap(world.store, world.repo, world.deps({ lookup: async () => { throw new Error("down"); } }));
  const read = await map("--repo", world.repo);
  expect(read.text).toContain("Couldn't check main: its host name couldn't be resolved.");
  expect(read.text).toContain("Next try at");
});

test("names print safely, and an unknown area or a bad verb is a usage answer", async () => {
  await checkCodeMap(world.store, world.repo, world.deps());
  expect((await map("area", "nope", "--repo", world.repo)).code).toBe(1);
  expect((await map("frobnicate", "--repo", world.repo)).code).toBe(2);
  expect((await map("search", "--repo", world.repo)).code).toBe(2);
});
