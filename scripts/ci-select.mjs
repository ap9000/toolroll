#!/usr/bin/env node
/**
 * Diff-reachable tests for a pull request (docs/plans/ci-speed-2.md, item 2): which unit-suite files a change can reach,
 * so a pull request's Linux shards can run those plus everything that must always run, instead of every file.
 *
 *   node scripts/ci-select.mjs plan --event <event> --head-ref <branch> --base <sha> --head <sha> --root <checkout>
 *     [--lane macos] [--out <plan.json>] [--list <files.txt>] [--summary <file.md>]
 *
 * prints `mode=full|selected` and `files=<n>`; --out writes the whole plan as JSON (the mode, why, the changed paths, the
 * selected test files and why each is in), --list the files a selected lane runs (empty when the plan is full), and
 * --summary appends a few Markdown lines. Deterministic: the same tree and diff give the same plan.
 *
 * What a change reaches is a graph over the checkout's source files (src/, test/, scripts/): an edge for every import,
 * re-export, dynamic import, require and vi.mock of a relative path, and an edge for every string literal that names a
 * repository file (`"scripts/ci-scope.mjs"`, `join(root, "test", "fixtures")`, `"console.css"`): a test reaches what it
 * imports and what it reads by name. A test that names `dist` reaches the whole build (every non-test file under src/).
 * A test file is selected when it reaches a changed path, or is one, or must always run.
 *
 * Fail closed. The whole suite runs (mode `full`) when:
 *   - the run isn't an ordinary pull request (a push, the nightly, a call, a release-* branch: coverage runs everything);
 *   - the diff can't be read whole, is empty, or deletes, renames, copies or changes the type of a source file;
 *   - a changed path is one of FULL_TRIGGERS (package and lock files, compiler and Vitest configuration, test setup and
 *     shared test helpers, workflows, scripts, generated files and contracts, the Rust contract);
 *   - a changed path outside INERT has nothing in the graph that reaches it: a file only read by a computed path or a
 *     folder walk can't be matched to its readers, so its change runs everything.
 * What runs on every pull request whatever it changed: the attack suite, the gate tests, every test that walks the
 * repository's folders (a walk reads files no literal names), and ALWAYS_FILES.
 *
 * Trust: like the shard verifier, CI runs the trusted base revision's copy of this file, over the candidate's tree. It
 * reads files and runs git with no config, hooks or external diff; it runs nothing of the candidate's.
 */
import { appendFileSync, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { diffEntries } from "./ci-scope.mjs";
import { inventory, laneFiles } from "./ci-shards.mjs";

/** The folders the graph reads, and the source files in them it parses for edges. Data files are nodes, not parsed. */
export const GRAPH_ROOTS = ["src", "test", "scripts"];
const CODE = /\.(?:ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;
/** A literal names a file when it has one of these extensions (or a slash and resolves to a file or folder). */
const NAMED_EXT = /\.(?:ts|tsx|mts|cts|mjs|cjs|js|jsx|json|css|html|md|ps1|py|sh|toml|ya?ml|txt|sql|svg|png|wasm|swift|rs|lock)$/;
const TEST = /\.test\.tsx?$/;

/** Paths whose change runs everything, each with the reason the plan gives. */
export const FULL_TRIGGERS = [
  [/^package(?:-lock)?\.json$/, "the package or its lock file"],
  [/^tsconfig[^/]*\.json$/, "the compiler configuration"],
  [/^vitest\.config\.[cm]?[jt]s$|(?:^|\/)vitest\.config\.[cm]?[jt]s$/, "the Vitest configuration"],
  // test/attacks is the attack suite (always run); everything else under test/ is setup, shared helpers or fixtures.
  [/^test\/(?!attacks\/)/, "test setup, a shared test helper or a fixture"],
  [/^test\/attacks\/(?!.*\.test\.ts$)/, "a shared attack-suite helper"],
  [/^\.github\//, "a workflow"],
  [/^scripts\//, "a script tests or the build use"],
  [/^src\/contracts\//, "a contract"],
  [/^src\/design\//, "a generated design file"],
  [/(?:^|\/)(?:Cargo\.lock|rust-toolchain\.toml)$/, "the Rust toolchain or lock file"],
  [/^THIRD_PARTY_NOTICES\.md$/, "the build's notices"],
];

/** Paths no unit test can reach except through the graph's literal edges (docs, the Rust workbench, the design
 * project): a change here needs no reader to be found, but a test that names one still runs. */
export const INERT = [/^docs\//, /^[^/]+\.md$/, /^tui\//, /^design\//, /^\.gitignore$/, /^LICENSE$/];

/** The gate tests: CI's own contract, password freshness, public hygiene, route, adapter and destination inventories,
 * and the contracts. Always run. */
export const GATES = [
  /^src\/ci-[^/]*\.test\.ts$/, /^src\/(?:server\/)?password-[^/]*\.test\.ts$/, /^src\/public-hygiene[^/]*\.test\.ts$/,
  /^src\/server\/(?:route-policy|handler-registry|destinations|get-quiet)[^/]*\.test\.ts$/, /^src\/serve\.(?:routes|retired)\.test\.ts$/,
  /^src\/[^/]*adapter[^/]*\.test\.ts$/, /^src\/contracts\/[^/]*\.test\.ts$/,
];
/** Files that always run by name, each with why: a failure in CI on a change the graph says it can't reach (the
 * backtest's zero-miss rule, docs/plans/ci-speed-2.md). Add one only from such a failure, with the run that showed it. */
export const ALWAYS_FILES = {
  // #427 (run 43752708686): it reserves a free port and binds it later, and lost it to another process (EADDRINUSE) on
  // a change to src/acp-gateway.slow.test.ts alone. A race no import or path reaches.
  "src/up.slow.test.ts": "failed on a change it can't reach (a port race, #427)",
};
/** The attack suite: always run. */
export const ATTACKS = /^test\/attacks\//;
/**
 * Whether a file walks the repository: it lists a folder (readdir, opendir, glob, or a helper of its own that lists one)
 * by a path from its own location (import.meta, __dirname or process.cwd(), or a name assigned from one, two steps deep:
 * `const REPO = join(import.meta.dirname, "..")`, `const src = join(REPO, "src")`) or from one of the checkout's
 * top-level folders by name (`walk("src")`). Listing a temp folder isn't walking the repository.
 */
const LISTS = /\b(?:readdirSync|readdir|opendirSync|opendir|globSync|glob)\s*\(/;
const ANCHORED = /import\.meta\.(?:dirname|url|filename)|__dirname|process\.cwd\(\)/;
const TOP_FOLDER = /["'`](?:\.\.\/)*(?:src|scripts|test|docs|\.github|tui|design|evals|dist|assets|desktop)(?:\/[^"'`]*)?["'`]/;
const ASSIGNED = /\b(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*([^;\n]*)/g;
const HELPER = /\b(?:function\s+(\w+)\s*\(|(?:const|let)\s+(\w+)\s*=\s*(?:\([^)]*\)|\w+)(?:\s*:\s*[\w[\]<>, ]+)?\s*=>)/g;

export function walksRepository(text) {
  if (!LISTS.test(text)) return false;
  const names = new Set();
  const named = value => ANCHORED.test(value) || TOP_FOLDER.test(value) || [...names].some(name => new RegExp(`\\b${name}\\b`).test(value));
  for (let round = 0; round < 2; round++) for (const match of text.matchAll(ASSIGNED)) if (ANCHORED.test(match[2]) || [...names].some(name => new RegExp(`\\b${name}\\b`).test(match[2]))) names.add(match[1]);
  // The file's own listing helpers: a function whose first lines list a folder.
  const listers = ["readdirSync", "readdir", "opendirSync", "opendir", "globSync", "glob"];
  for (const match of text.matchAll(HELPER)) if (LISTS.test(text.slice(match.index, match.index + 400))) listers.push(match[1] ?? match[2]);
  const call = new RegExp(`\\b(?:${[...new Set(listers)].join("|")})\\s*\\(([^\\n]{0,240})`, "g");
  for (const match of text.matchAll(call)) if (named(match[1])) return true;
  return false;
}

const SPECIFIER = [
  /\bfrom\s*["']([^"'\n]+)["']/g,
  /\bimport\s*["']([^"'\n]+)["']/g,
  // A dynamic import, but not one in a type (`: import("./x.js").Room`, `typeof import("./x.js")`), which is erased.
  /(?<!typeof\s+)\bimport\(\s*["']([^"'\n]+)["']\s*\)(?!\s*\.\s*[A-Z])/g,
  /\brequire\(\s*["']([^"'\n]+)["']\s*\)/g,
  /\bvi\.(?:mock|doMock|unmock|importActual|importMock)\(\s*["']([^"'\n]+)["']/g,
  /\bnew URL\(\s*["']([^"'\n]+)["']\s*,\s*import\.meta\.url/g,
];
const LITERAL = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`([^`$\\]*)`/g;
/** `join(a, "test", "fixtures")` and `resolve(…)`: consecutive literal arguments are one path. */
const JOINED = /\b(?:join|resolve)\(([^()]*)\)/g;

/** `import type …` and `export type … from …`: erased when the code runs (verbatimModuleSyntax), so a test can't reach
 * anything through one. `import { type A } from` stays: it is kept as `import {} from`, and loads its module. */
const TYPE_ONLY = /^[ \t]*(?:import|export)\s+type\s+[^;]*?\bfrom\s*["'][^"'\n]+["'];?/gm;

/** The relative import specifiers that load code when it runs, and the path-like string literals, in a file's text. */
export function references(text) {
  const imports = new Set(), literals = new Set();
  const code = text.replace(TYPE_ONLY, "");
  for (const re of SPECIFIER) for (const match of code.matchAll(re)) if (match[1].startsWith(".")) imports.add(match[1]);
  for (const match of text.matchAll(LITERAL)) {
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    if (value.length > 1 && value.length < 300 && !/\s/.test(value) && (value.includes("/") || NAMED_EXT.test(value))) literals.add(value);
  }
  for (const match of text.matchAll(JOINED)) {
    const parts = [...match[1].matchAll(/["'`]([^"'`\s$]+)["'`]/g)].map(one => one[1]);
    if (parts.length >= 2) literals.add(parts.join("/"));
  }
  return { imports: [...imports].sort(), literals: [...literals].sort() };
}

/** `spec` from `from`, as a file the tree has: TypeScript's `.js` → `.ts`/`.tsx`, `.mjs` → `.mts`, an extension added,
 * or a folder's index. Null when none exists. */
export function resolveImport(from, spec, has) {
  const base = posix.normalize(posix.join(posix.dirname(from), spec));
  if (base.startsWith("../")) return null;
  const tries = [base];
  if (/\.js$/.test(base)) tries.push(base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx"));
  if (/\.jsx$/.test(base)) tries.push(base.replace(/\.jsx$/, ".tsx"));
  if (/\.mjs$/.test(base)) tries.push(base.replace(/\.mjs$/, ".mts"));
  for (const ext of [".ts", ".tsx", ".mjs", ".js", ".json"]) tries.push(base + ext);
  for (const ext of ["ts", "tsx", "js", "mjs"]) tries.push(`${base}/index.${ext}`);
  return tries.find(one => has(one)) ?? null;
}

/**
 * The graph over a tree: `tree.list()` names every file (repository-relative, `/`-separated), `tree.read(path)` gives a
 * file's text or null. Returns, for each file, the files it reaches directly (`edges`), which source files walk folders,
 * and which name the build (`dist`).
 */
export function buildGraph(tree) {
  const files = [...new Set(tree.list())].sort();
  const set = new Set(files);
  const has = path => set.has(path);
  const byName = new Map(), folders = new Map();
  for (const file of files) {
    const name = posix.basename(file);
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(file);
    const parts = file.split("/");
    for (let at = 1; at < parts.length; at++) {
      const folder = parts.slice(0, at).join("/");
      if (!folders.has(folder)) folders.set(folder, []);
      folders.get(folder).push(file);
    }
  }
  /** What a literal names: a file or folder by its path's suffix (`fixtures/engine-api`), or a file by its name. */
  const suffixIndex = new Map();
  const named = literal => {
    let value = literal.replace(/^(?:\.\.?\/)+/, "").replace(/^\/+/, "").replace(/\/+$/, "");
    if (value === "" || value.includes("*")) return [];
    if (!value.includes("/")) return NAMED_EXT.test(value) ? (byName.get(value) ?? []) : [];
    if (suffixIndex.has(value)) return suffixIndex.get(value);
    const found = [];
    for (const file of files) if (file === value || file.endsWith(`/${value}`)) found.push(file);
    for (const [folder, inside] of folders) if (folder === value || folder.endsWith(`/${value}`)) found.push(...inside);
    const unique = [...new Set(found)].sort();
    suffixIndex.set(value, unique);
    return unique;
  };
  const edges = new Map(), walkers = new Set(), dist = new Set(), unresolved = new Map();
  for (const file of files) {
    if (!CODE.test(file) || !GRAPH_ROOTS.includes(file.split("/")[0])) continue;
    const text = tree.read(file);
    if (typeof text !== "string") continue;
    const out = new Set();
    const { imports, literals } = references(text);
    // A test, a test helper or a script reaches whatever its literals name: tests start scripts and the CLI by path and
    // read fixtures and documents by name. Product code that lists a file's name (a report naming test/ensure-build.ts,
    // a lock file list) doesn't run or read this checkout's copy of it.
    const runsByName = TEST.test(file) || file.startsWith("test/") || file.startsWith("scripts/");
    for (const spec of imports) {
      const to = resolveImport(file, spec, has);
      if (to !== null) { out.add(to); continue; }
      // A folder by URL (`new URL("../evals/", import.meta.url)`, `new URL("..", …)` for the checkout): what is in it. As
      // with literals, product code reaches only its data (it anchors there to read files, never to run code), a test or
      // a script everything.
      const folder = posix.normalize(posix.join(posix.dirname(file), spec)).replace(/\/+$/, "");
      const inside = folder === "." ? files : folder.startsWith("../") ? undefined : folders.get(folder);
      if (inside !== undefined) { for (const one of inside) if (one !== file && (runsByName || !CODE.test(one))) out.add(one); continue; }
      if (!unresolved.has(file)) unresolved.set(file, []);
      unresolved.get(file).push(spec);
    }
    // Product code's literals reach only its own package's data under src/ (console.css beside the server): a name like
    // "AGENTS.md" or "package.json" there means a file of the project it works on, not of this checkout.
    for (const literal of literals) for (const to of named(literal)) if (to !== file && (runsByName || (!CODE.test(to) && to.startsWith("src/")))) out.add(to);
    if (runsByName && /["'`/]dist["'`/]/.test(text)) dist.add(file);
    if (walksRepository(text)) walkers.add(file);
    edges.set(file, [...out].sort());
  }
  return { files, edges, walkers, dist, unresolved };
}

/** Every file `start` reaches (itself included), following edges; a file that names the build reaches every non-test
 * file under src/. */
function closureOf(start, graph, memo) {
  if (memo.has(start)) return memo.get(start);
  const seen = new Set([start]), stack = [start];
  let build = false;
  while (stack.length > 0) {
    const at = stack.pop();
    if (graph.dist.has(at)) build = true;
    for (const to of graph.edges.get(at) ?? []) if (!seen.has(to)) { seen.add(to); stack.push(to); }
  }
  const result = { seen, build };
  memo.set(start, result);
  return result;
}

/** Why a path's change runs everything, or null. */
export function fullTrigger(path) {
  for (const [re, why] of FULL_TRIGGERS) if (re.test(path)) return `${path}: ${why}`;
  return null;
}

/** Why a test file always runs, or null. `walks`: the test lists a folder of the repository itself (its helpers under
 * test/ are FULL_TRIGGERS, so a folder they walk can't change without a full run). */
export function alwaysReason(file, walks) {
  if (ATTACKS.test(file)) return "the attack suite";
  if (GATES.some(re => re.test(file))) return "a gate test";
  if (Object.hasOwn(ALWAYS_FILES, file)) return ALWAYS_FILES[file];
  if (walks) return "walks the repository's folders";
  return null;
}

const SOURCE_STATUS = new Set(["A", "M"]);

/**
 * The plan for one run: `{ mode: "full", why }` or `{ mode: "selected", files, reasons }`. `entries` is ci-scope.mjs's
 * parseNameStatus answer for the diff (null: unreadable), `tests` the include policy's files in the tree.
 */
export function plan({ event, headRef, entries, tree, tests }) {
  const full = why => ({ mode: "full", why, files: [...tests].sort(), reasons: {} });
  if (event !== "pull_request") return full(`a ${String(event)} run tests everything`);
  if (typeof headRef !== "string" || headRef === "" || headRef.startsWith("release-")) return full("a release candidate's branch runs everything");
  if (!Array.isArray(entries)) return full("the diff couldn't be read whole");
  if (entries.length === 0) return full("the diff is empty");
  const changed = [];
  for (const entry of entries) {
    const path = entry.paths.at(-1);
    const inert = entry.paths.every(one => INERT.some(re => re.test(one)));
    if (!SOURCE_STATUS.has(entry.status) && !inert) return full(`${entry.paths.join(" → ")} was ${{ D: "deleted", R: "renamed", C: "copied", T: "changed in type" }[entry.status] ?? "changed"}`);
    for (const one of entry.paths) { const why = fullTrigger(one); if (why !== null) return full(why); }
    changed.push(path);
  }
  const graph = buildGraph(tree);
  // Fail closed: every changed path outside INERT must be a test file or something the graph reaches.
  const reached = new Set();
  for (const targets of graph.edges.values()) for (const to of targets) reached.add(to);
  for (const path of changed) {
    if (INERT.some(re => re.test(path)) || TEST.test(path) || reached.has(path)) continue;
    // Under src/, the build carries it to every test that runs the CLI; anything else nobody names runs everything.
    if (!/^src\/.+\.tsx?$/.test(path) || graph.dist.size === 0) return full(`${path}: nothing in the graph reads it`);
  }
  const changedSet = new Set(changed);
  const srcChanged = changed.some(path => path.startsWith("src/") && !TEST.test(path));
  const memo = new Map();
  const reasons = {};
  for (const test of [...tests].sort()) {
    const { seen, build } = closureOf(test, graph, memo);
    const always = alwaysReason(test, graph.walkers.has(test));
    if (always !== null) { reasons[test] = always; continue; }
    if (changedSet.has(test)) { reasons[test] = "changed"; continue; }
    const hit = [...changedSet].find(path => seen.has(path));
    if (hit !== undefined) { reasons[test] = `reaches ${hit}`; continue; }
    if (build && srcChanged) reasons[test] = "runs the build, and src/ changed";
  }
  const files = Object.keys(reasons).sort();
  // A lane can hold none of the selection: then it runs whole (a shard with no files would prove nothing).
  if (files.length === 0) return full("the selection holds none of these files");
  return { mode: "selected", why: `${changed.length} changed path${changed.length === 1 ? "" : "s"}`, changed: [...changed].sort(), files, reasons };
}

/** A checkout on disk as a tree: every file (never in node_modules, .git, dist or a Rust target), symlinks not followed.
 * Only GRAPH_ROOTS' code is parsed; every other file is a node a test can name (README.md, install.sh, docs/*.json). */
export function diskTree(root) {
  const listed = [];
  const walk = folder => {
    let entries;
    try { entries = readdirSync(join(root, folder), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = `${folder}/${entry.name}`;
      if (entry.isDirectory()) { if (!["node_modules", ".git", "dist", "target"].includes(entry.name)) walk(path); }
      else if (entry.isFile()) listed.push(path);
    }
  };
  let top = [];
  try { top = readdirSync(root, { withFileTypes: true }); } catch { top = []; }
  for (const entry of top) {
    if (entry.isDirectory()) { if (![".git", "node_modules", "dist", ".trusted-base"].includes(entry.name)) walk(entry.name); }
    else if (entry.isFile()) listed.push(entry.name);
  }
  return {
    list: () => listed,
    read: path => { try { return lstatSync(join(root, path)).isFile() ? readFileSync(join(root, path), "utf8") : null; } catch { return null; } },
  };
}

/** The plan in a few Markdown lines for a job's summary: mode, why, how many files, and why each kind is in. */
export function summary(result, inventoryCount) {
  const lines = [`**Test selection** (advisory until ci.yml's TEST_SELECTION is \`enforce\`): ${result.mode}, ${result.files.length} of ${inventoryCount} test files: ${result.why}`];
  if (result.mode === "selected") {
    const kinds = new Map();
    for (const why of Object.values(result.reasons)) { const kind = why.startsWith("reaches ") ? "reaches a changed file" : why; kinds.set(kind, (kinds.get(kind) ?? 0) + 1); }
    for (const [kind, count] of [...kinds].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) lines.push(`- ${count}: ${kind}`);
  }
  return `${lines.join("\n")}\n`;
}

const flag = (args, name) => { const at = args.indexOf(`--${name}`); return at === -1 ? undefined : args[at + 1]; };

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "plan") { console.error("usage: ci-select.mjs plan --event <event> --head-ref <branch> --base <sha> --head <sha> --root <checkout> [--lane macos] [--out <plan.json>] [--list <files.txt>] [--summary <file.md>]"); process.exit(2); }
  const root = flag(args, "root") ?? ".", event = flag(args, "event"), lane = flag(args, "lane");
  const entries = event === "pull_request" ? diffEntries(root, flag(args, "base"), flag(args, "head")) : null;
  const tests = lane === undefined || lane === "all" ? inventory(root) : laneFiles(root, lane);
  const result = plan({ event, headRef: flag(args, "head-ref") ?? "", entries, tree: diskTree(root), tests });
  const out = flag(args, "out"), list = flag(args, "list"), notes = flag(args, "summary");
  if (out !== undefined) writeFileSync(out, `${JSON.stringify({ ...result, lane: lane ?? "all", inventory: tests.length }, null, 1)}\n`);
  // The list a selected lane runs: the plan's files, or nothing (the whole suite) when the plan is full.
  if (list !== undefined) writeFileSync(list, result.mode === "selected" ? `${result.files.join("\n")}\n` : "");
  if (notes !== undefined) appendFileSync(notes, summary(result, tests.length));
  console.error(`test selection${lane === undefined ? "" : ` (${lane} lane)`}: ${result.mode}, ${result.files.length} of ${tests.length} files: ${result.why}`);
  console.log(`mode=${result.mode}`);
  console.log(`files=${result.files.length}`);
}
