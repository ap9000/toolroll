/**
 * The test selection (scripts/ci-select.mjs, docs/plans/ci-speed-2.md): which unit-suite files a pull request's diff can
 * reach. It must never leave out a test the change can reach, so each way a reach could be missed is a row here, and each
 * case that must run everything is one too.
 */
import { describe, expect, test } from "vitest";
import { inventory } from "../scripts/ci-shards.mjs";
import { ALWAYS_FILES, diskTree, FULL_TRIGGERS, fullTrigger, plan, references, resolveImport, walksRepository } from "../scripts/ci-select.mjs";

type Tree = Record<string, string>;
const treeOf = (files: Tree) => ({ list: () => Object.keys(files), read: (path: string) => files[path] ?? null });
const TEST = /^src\/.*\.test\.ts$|^test\/attacks\/.*\.test\.ts$/;
const testsOf = (files: Tree) => Object.keys(files).filter(path => TEST.test(path)).sort();
const modified = (...paths: string[]) => paths.map(path => ({ status: "M", paths: [path] }));
type Plan = { mode: string; why: string; files: string[]; reasons: Record<string, string> };
const planFor = (files: Tree, entries: unknown, extra: { event?: string; headRef?: string } = {}) =>
  plan({ event: extra.event ?? "pull_request", headRef: extra.headRef ?? "some-change", entries, tree: treeOf(files), tests: testsOf(files) }) as Plan;

/** A small checkout: a chain a → b ← b.test, an unrelated c, data read by name, the build, the always-run kinds. */
const world: Tree = {
  "src/a.ts": "export const a = 1;\n",
  "src/b.ts": 'import { a } from "./a.js";\nexport const b = a;\n',
  "src/b.test.ts": 'import { b } from "./b.js";\ntest("b", () => {});\n',
  "src/c.ts": "export const c = 3;\n",
  "src/c.test.ts": 'import { c } from "./c.js";\ntest("c", () => {});\n',
  "src/server/console.css": "body {}\n",
  "src/server/pages.ts": 'import { readFileSync } from "node:fs";\nexport const css = () => readFileSync(new URL("console.css", import.meta.url), "utf8");\n',
  "src/server/pages.test.ts": 'import { css } from "./pages.js";\ntest("p", () => {});\n',
  "src/report.ts": 'export const NAMES = ["src/c.ts", "test/attacks/x.test.ts"];\n',
  "src/report.test.ts": 'import { NAMES } from "./report.js";\ntest("r", () => {});\n',
  "src/cli-run.test.ts": 'import { join } from "node:path";\nconst bin = join(import.meta.dirname, "..", "dist", "bin.js");\ntest("cli", () => {});\n',
  "src/ci-workflow.test.ts": 'test("gate", () => {});\n',
  "src/walks.test.ts": 'import { readdirSync } from "node:fs";\nconst all = readdirSync(import.meta.dirname);\ntest("w", () => {});\n',
  "test/attacks/x.test.ts": 'test("attack", () => {});\n',
  "docs/plans/p.md": "# plan\n",
};

describe("what must run everything", () => {
  test("anything but an ordinary pull request: a push, the nightly, a call, a release-* branch", () => {
    for (const event of ["push", "schedule", "workflow_call", "workflow_dispatch"]) expect(planFor(world, modified("docs/plans/p.md"), { event }).mode, event).toBe("full");
    expect(planFor(world, modified("docs/plans/p.md"), { headRef: "release-0.9.200" }).mode).toBe("full");
    expect(planFor(world, modified("docs/plans/p.md"), { headRef: "" }).mode).toBe("full");
  });

  test("a diff that can't be read, an empty one, and a deleted, renamed, copied or retyped source file", () => {
    expect(planFor(world, null).why).toMatch(/couldn't be read/);
    expect(planFor(world, []).why).toMatch(/empty/);
    for (const status of ["D", "T"]) expect(planFor(world, [{ status, paths: ["src/c.ts"] }]).mode, status).toBe("full");
    for (const status of ["R", "C"]) expect(planFor(world, [{ status, paths: ["src/c.ts", "src/d.ts"] }]).mode, status).toBe("full");
    // Documentation can go or move without a full run.
    expect(planFor(world, [{ status: "D", paths: ["docs/plans/old.md"] }]).mode).toBe("selected");
    expect(planFor(world, [{ status: "R", paths: ["docs/a.md", "docs/b.md"] }]).mode).toBe("selected");
  });

  test.each([
    ["package.json"], ["package-lock.json"], ["tsconfig.json"], ["tsconfig.build.json"], ["vitest.config.ts"], ["test/attacks/vitest.config.ts"],
    ["test/setup-state.ts"], ["test/fresh-store.ts"], ["test/fixtures/cli/envelopes.txt"], ["test/timings.json"], ["test/attacks/harness.ts"],
    [".github/workflows/ci.yml"], ["scripts/isolated-env.mjs"], ["scripts/fixtures/scripted-provider.mjs"], ["src/contracts/engine-api.ts"],
    ["src/design/tokens.css"], ["tui/Cargo.lock"], ["tui/rust-toolchain.toml"], ["THIRD_PARTY_NOTICES.md"],
  ])("a change to %s runs everything", path => {
    expect(fullTrigger(path)).not.toBeNull();
    expect(planFor({ ...world, [path]: "x\n" }, modified(path)).mode).toBe("full");
  });

  test("a file outside the inert folders that nothing in the graph reaches: its readers can't be found, so everything runs", () => {
    const files = { ...world, "src/data/rules.json": "{}\n", "assets/logo.svg": "<svg/>\n" };
    expect(planFor(files, modified("src/data/rules.json")).why).toMatch(/src\/data\/rules\.json: nothing in the graph reads it/);
    expect(planFor(files, modified("assets/logo.svg")).mode).toBe("full");
    // Source nobody imports still reaches every test that runs the build; with no such test, it runs everything.
    expect(planFor({ ...world, "src/orphan.ts": "export {};\n" }, modified("src/orphan.ts")).mode).toBe("selected");
    const noBuild = Object.fromEntries(Object.entries(world).filter(([path]) => path !== "src/cli-run.test.ts"));
    expect(planFor({ ...noBuild, "src/orphan.ts": "export {};\n" }, modified("src/orphan.ts")).mode).toBe("full");
  });

  test("every trigger is anchored, so it names what it means and nothing else", () => {
    for (const [pattern] of FULL_TRIGGERS) expect(String(pattern)).toMatch(/^\/(?:\^|\(\?:\^)/);
    expect(fullTrigger("src/scripts/x.ts")).toBeNull();
    expect(fullTrigger("docs/package.json.md")).toBeNull();
  });
});

describe("what a selected plan holds", () => {
  const always = ["src/ci-workflow.test.ts", "src/walks.test.ts", "test/attacks/x.test.ts"];

  test("a documentation change: only what always runs (the attack suite, the gates, the tests that walk folders)", () => {
    const result = planFor(world, modified("docs/plans/p.md"));
    expect(result.mode).toBe("selected");
    expect(result.files).toEqual(always);
    expect(result.reasons).toEqual({ "src/ci-workflow.test.ts": "a gate test", "src/walks.test.ts": "walks the repository's folders", "test/attacks/x.test.ts": "the attack suite" });
  });

  test("a change reaches every test that imports it, however far, and every test that runs the build; not the others", () => {
    const result = planFor(world, modified("src/a.ts"));
    expect(result.files).toEqual([...always, "src/b.test.ts", "src/cli-run.test.ts"].sort());
    expect(result.reasons["src/b.test.ts"]).toBe("reaches src/a.ts");
    expect(result.reasons["src/cli-run.test.ts"]).toBe("runs the build, and src/ changed");
  });

  test("data a module reads by name reaches its importers' tests", () => {
    expect(planFor(world, modified("src/server/console.css")).files).toContain("src/server/pages.test.ts");
  });

  test("a changed test runs; product code that merely names a file doesn't make it reach that file", () => {
    expect(planFor(world, modified("src/c.test.ts")).files).toEqual([...always, "src/c.test.ts"].sort());
    // src/report.ts lists "src/c.ts" as text: src/report.test.ts doesn't reach it.
    expect(planFor(world, modified("src/c.ts")).files).not.toContain("src/report.test.ts");
  });

  test("a test or script that names code by path reaches it (and what it imports): tests start scripts and the CLI that way", () => {
    const files = { ...world, "src/spawns.test.ts": 'import { join } from "node:path";\nconst cli = join(root, "src", "b.ts");\ntest("s", () => {});\n' };
    expect(planFor(files, modified("src/a.ts")).files).toContain("src/spawns.test.ts");
  });

  test("found in this checkout's history: what product code names or anchors on is data, never code or this checkout's documents", () => {
    // src/release-carry.ts reads new URL(".", import.meta.url): its folder's code isn't reached through it. src/graph.ts
    // names "AGENTS.md" of the project it reads: this checkout's AGENTS.md isn't reached through it.
    const files = { ...world, "AGENTS.md": "# rules\n", "src/carry.ts": 'const here = new URL(".", import.meta.url);\nconst rules = "AGENTS.md";\n', "src/carry.test.ts": 'import "./carry.js";\ntest("c", () => {});\n' };
    expect(planFor(files, modified("src/c.ts")).files).not.toContain("src/carry.test.ts");
    expect(planFor(files, modified("AGENTS.md")).files).not.toContain("src/carry.test.ts");
    // A test anchored on the checkout itself may read anything under it: it runs for any change.
    const anchored = { ...files, "src/root.test.ts": 'const root = new URL("..", import.meta.url);\ntest("r", () => {});\n' };
    expect(planFor(anchored, modified("AGENTS.md")).files).toContain("src/root.test.ts");
    expect(planFor(anchored, modified("docs/plans/p.md")).files).toContain("src/root.test.ts");
  });

  test("a lane plans its share of the selection; a lane that holds none of it runs whole", () => {
    const lane = ["src/b.test.ts", "src/c.test.ts", "test/attacks/x.test.ts"];
    const laneOnly = (entries: unknown) => plan({ event: "pull_request", headRef: "x", entries, tree: treeOf(world), tests: lane }) as Plan;
    expect(laneOnly(modified("src/a.ts")).files).toEqual(["src/b.test.ts", "test/attacks/x.test.ts"]);
    const none = plan({ event: "pull_request", headRef: "x", entries: modified("src/a.ts"), tree: treeOf(world), tests: ["src/c.test.ts"] }) as Plan;
    expect(none.mode).toBe("full");
    expect(none.files).toEqual(["src/c.test.ts"]);
  });

  test("the same inputs give the same plan, sorted", () => {
    const one = planFor(world, modified("src/a.ts", "docs/plans/p.md"));
    const two = planFor(Object.fromEntries(Object.entries(world).reverse()), modified("docs/plans/p.md", "src/a.ts"));
    expect(two).toEqual(one);
    expect(one.files).toEqual([...one.files].sort());
  });
});

describe("how the graph reads source", () => {
  test("imports, re-exports, side-effect and dynamic imports, require, vi.mock and URL assets; only relative ones", () => {
    const text = [
      'import { x } from "./x.js";', 'export * from "../y.js";', 'import "./side.js";', 'const z = await import("./z.js");',
      'const r = require("./r.cjs");', 'vi.mock("./m.js", () => ({}));', 'new URL("./worker.js", import.meta.url);', 'import { p } from "node:path";',
    ].join("\n");
    expect(references(text).imports).toEqual(["../y.js", "./m.js", "./r.cjs", "./side.js", "./worker.js", "./x.js", "./z.js"]);
    expect(references('join(root, "test", "fixtures", "cli")').literals).toContain("test/fixtures/cli");
    // Erased when the code runs: import type, export type … from, and import("…") in a type. `import { type A }` stays:
    // verbatimModuleSyntax keeps it as `import {} from`, which loads its module (dist/store.js has two).
    const types = [
      'import type { A } from "./a.js";', 'import type {\n  B,\n  C,\n} from "./b.js";', 'export type { D } from "./d.js";',
      'function room(): import("./rooms.js").RoomBackend { return x; }', 'let s: typeof import("./sqlite.js");',
      'import { type E } from "./e.js";', 'const f = await import("./f.js");', 'import("./g.js").then(run);',
    ].join("\n");
    expect(references(types).imports).toEqual(["./e.js", "./f.js", "./g.js"]);
  });

  test("a walk of the repository is one from its own location or a top-level folder; listing a temp folder isn't", () => {
    expect(walksRepository('const all = readdirSync(import.meta.dirname);')).toBe(true);
    expect(walksRepository('const REPO = join(import.meta.dirname, "..");\nconst src = join(REPO, "src");\nfor (const f of readdirSync(src)) {}')).toBe(true);
    expect(walksRepository('const files = (dir: string): string[] => readdirSync(dir).flatMap(one => [one]);\nconst all = files(join(root, "src"));')).toBe(true);
    expect(walksRepository('const walk = (dir: string) => readdirSync(dir);\nwalk("scripts");')).toBe(true);
    // Found in this checkout: src/up.slow.test.ts lists its run folder and uses process.cwd() only as a spawn's cwd.
    expect(walksRepository('const previous = process.cwd();\nexpect(readdirSync(instanceRunDir(db))).toEqual([]);')).toBe(false);
    expect(walksRepository('const dir = mkdtempSync(join(tmpdir(), "x"));\nexpect(readdirSync(dir)).toEqual([]);')).toBe(false);
  });

  test("TypeScript's .js specifiers resolve to .ts and .tsx, a folder to its index, and nothing outside the tree", () => {
    const has = (path: string) => ["src/a.ts", "src/b.tsx", "src/kit/index.ts", "scripts/s.mjs"].includes(path);
    expect(resolveImport("src/x.ts", "./a.js", has)).toBe("src/a.ts");
    expect(resolveImport("src/x.ts", "./b.js", has)).toBe("src/b.tsx");
    expect(resolveImport("src/x.ts", "./kit", has)).toBe("src/kit/index.ts");
    expect(resolveImport("src/x.ts", "../scripts/s.mjs", has)).toBe("scripts/s.mjs");
    expect(resolveImport("src/x.ts", "../../outside.js", has)).toBeNull();
  });
});

describe("in this checkout", () => {
  const root = `${import.meta.dirname}/..`;
  const tree = diskTree(root);
  const tests = inventory(root);

  test("a documentation change still runs the whole attack suite and the gates", () => {
    const result = plan({ event: "pull_request", headRef: "x", entries: modified("docs/plans/ci-speed-2.md"), tree, tests }) as Plan;
    expect(result.mode).toBe("selected");
    for (const file of tests.filter(one => one.startsWith("test/attacks/"))) expect(result.files, file).toContain(file);
    for (const file of ["src/ci-workflow.test.ts", "src/ci-shards.test.ts", "src/ci-select.test.ts", "src/password-freshness.test.ts", "src/public-hygiene.test.ts"]) expect(result.files).toContain(file);
  });

  test("every file named to always run exists and says why", () => {
    for (const [file, why] of Object.entries(ALWAYS_FILES)) { expect(tests, file).toContain(file); expect(why.length).toBeGreaterThan(10); }
    const result = plan({ event: "pull_request", headRef: "x", entries: modified("docs/plans/ci-speed-2.md"), tree, tests }) as Plan;
    for (const file of Object.keys(ALWAYS_FILES)) expect(result.files).toContain(file);
  });

  test("a change to the store reaches its own tests and the CLI's", () => {
    const result = plan({ event: "pull_request", headRef: "x", entries: modified("src/store.ts"), tree, tests }) as Plan;
    for (const file of ["src/store.test.ts", "src/cli.test.ts"]) expect(result.files).toContain(file);
  });

  test("a test that reads a root file by URL runs when that file changes, inert or not (README.md, install.sh)", () => {
    for (const [file, reader] of [["README.md", "src/cli.test.ts"], ["install.sh", "src/install-sh.test.ts"]]) {
      const result = plan({ event: "pull_request", headRef: "x", entries: modified(file), tree, tests }) as Plan;
      expect(result.mode, file).toBe("selected");
      expect(result.files, file).toContain(reader);
    }
  });
});
