/**
 * Test infrastructure, found structurally (docs/plans/auto-approve-green.md): every non-test source file that the tests
 * or the test runner's own setup import, directly or through other files, and that the product's entry points never
 * reach. Changing one changes how tests check things — an automatic release approval leaves that to a person.
 *
 * Imports are read with the TypeScript compiler (typescript-parser, a runtime dependency): `preProcessFile` for static,
 * dynamic and `require` specifiers (comments never count), and the syntax tree for dynamic imports or requires whose
 * specifier isn't a plain string. Specifiers resolve as the build resolves them: relative paths (`./x.js` → `./x.ts`),
 * the project's tsconfig `paths`, and package.json `imports`. Fail closed: a specifier reached from the tests that
 * resolves to no file and to no known package is "unresolved", with what it might name, and the caller refuses when the
 * change touches anything it might name.
 */
import { createRequire } from "node:module";
import { builtinModules } from "node:module";
import type ts from "typescript-parser";

let compiler: typeof ts | undefined;
const typescript = (): typeof ts => compiler ??= createRequire(import.meta.url)("typescript-parser") as typeof ts;

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const TEST = /\.test\.[cm]?[jt]sx?$/;
const VITEST_CONFIG = /(^|\/)vitest\.config\.[cm]?[jt]s$/;
const EXTENSIONS = ["ts", "tsx", "mts", "cts", "js", "mjs", "cjs", "jsx"];

/** The product's entry points: the CLI binary, the processes it starts by file name, and the browser bundles. */
export const PRODUCT_ENTRIES: readonly string[] = Object.freeze([
  "src/bin.ts", "src/cli.ts", "src/controller-service.ts", "src/up-role-child.ts", "src/desktop-host.ts", "src/sandbox-launch.ts", "src/tool-launcher.ts",
  "src/browser/app.tsx", "src/browser/terminal-app.tsx",
]);

/** A specifier reached from the tests that names no repository file and no known package: `prefix` is the repository
 * path it might name (a folder or file stem), or null when it might name anything. */
export type Unresolved = { from: string; specifier: string | null; prefix: string | null };
export type TestInfrastructure = { infra: Set<string>; unresolved: Unresolved[];
  /** What the product's entry points reach (trusted product code, by Alex's decision). */
  product: Set<string> };

const join = (dir: string, spec: string): string | null => {
  const parts = dir === "" ? [] : dir.split("/");
  for (const part of spec.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") { if (parts.length === 0) return null; parts.pop(); } else parts.push(part);
  }
  return parts.join("/");
};
const dirOf = (path: string): string => path.split("/").slice(0, -1).join("/");

/** A repository path, tried as the build tries it (with or without its extension, or as a folder's index). */
function fileAt(target: string, files: ReadonlySet<string>): string | null {
  const stem = target.replace(/\.(?:[cm]?js|jsx)$/, "");
  const tries = [target, ...EXTENSIONS.map(ext => `${stem}.${ext}`), ...EXTENSIONS.map(ext => `${target}/index.${ext}`)];
  return tries.find(one => files.has(one)) ?? null;
}

type Resolver = (from: string, spec: string) => { file: string } | { external: true } | { unresolved: string | null };

/** The project's resolution rules, read from its own tsconfig.json and package.json (as text in the same tree). */
function resolverFor(files: ReadonlyMap<string, string>, names: ReadonlySet<string>, allPaths: ReadonlySet<string>, aliases: readonly { find: string; replacement: string }[]): Resolver {
  const tsc = typescript();
  let paths: Record<string, string[]> = {}, baseUrl = "";
  const config = files.get("tsconfig.json");
  if (config !== undefined) {
    const parsed = tsc.parseConfigFileTextToJson("tsconfig.json", config).config as { compilerOptions?: { paths?: Record<string, string[]>; baseUrl?: string } } | undefined;
    paths = parsed?.compilerOptions?.paths ?? {};
    baseUrl = join("", parsed?.compilerOptions?.baseUrl ?? ".") ?? "";
  }
  let pkg: { name?: unknown; imports?: Record<string, unknown>; dependencies?: object; devDependencies?: object; peerDependencies?: object; optionalDependencies?: object } = {};
  try { pkg = JSON.parse(files.get("package.json") ?? "{}") as typeof pkg; } catch { pkg = {}; }
  const packages = new Set([pkg.dependencies, pkg.devDependencies, pkg.peerDependencies, pkg.optionalDependencies].flatMap(one => Object.keys(one ?? {})));
  // The package's own name resolves to itself: never "some installed package".
  const own = typeof pkg.name === "string" ? pkg.name : null;
  const builtins = new Set(builtinModules);
  const pattern = (key: string, spec: string): string | null => {
    if (!key.includes("*")) return key === spec ? "" : null;
    const [head, tail] = key.split("*") as [string, string];
    return spec.startsWith(head) && spec.endsWith(tail) && spec.length >= head.length + tail.length ? spec.slice(head.length, spec.length - tail.length) : null;
  };
  return (from, spec) => {
    // vitest's own aliases come first, as vitest applies them.
    for (const alias of aliases) {
      if (spec !== alias.find && !spec.startsWith(`${alias.find}/`)) continue;
      const target = join(alias.replacement, spec.slice(alias.find.length).replace(/^\//, ""));
      const file = target === null ? null : fileAt(target, names);
      return file !== null ? { file } : { unresolved: target };
    }
    if (spec.startsWith("./") || spec.startsWith("../")) {
      const target = join(dirOf(from), spec);
      const file = target === null ? null : fileAt(target, names);
      if (file !== null) return { file };
      // A file that isn't source (a stylesheet, JSON, an asset) is a leaf: it imports nothing.
      if (target !== null && allPaths.has(target)) return { external: true };
      return { unresolved: target };
    }
    for (const [key, targets] of Object.entries(paths)) {
      const star = pattern(key, spec);
      if (star === null) continue;
      for (const one of targets) { const target = join(baseUrl, one.replace("*", star)); const file = target === null ? null : fileAt(target, names); if (file !== null) return { file }; }
      return { unresolved: join(baseUrl, (targets[0] ?? "").replace("*", star)) };
    }
    if (spec.startsWith("#")) {
      for (const [key, value] of Object.entries(pkg.imports ?? {})) {
        const star = pattern(key, spec);
        if (star === null) continue;
        const target = typeof value === "string" ? value : typeof (value as { default?: unknown })?.default === "string" ? (value as { default: string }).default : null;
        if (target === null) return { unresolved: null };
        const path = join("", target.replace("*", star));
        const file = path === null ? null : fileAt(path, names) ?? fileAt(path.replace(/^dist\//, "src/"), names);
        return file !== null ? { file } : { unresolved: path };
      }
      return { unresolved: null };
    }
    const bare = spec.startsWith("node:") ? spec.slice(5) : spec;
    const name = bare.startsWith("@") ? bare.split("/").slice(0, 2).join("/") : bare.split("/")[0]!;
    if (name === own) return { unresolved: null };
    if (spec.startsWith("node:") || builtins.has(name) || packages.has(name)) return { external: true };
    // A package the manifest doesn't declare: what it names can't be known here.
    return { unresolved: null };
  };
}

/** The module-loading helpers vitest offers: each takes a specifier first. */
const VI_LOADERS = new Set(["mock", "doMock", "unmock", "doUnmock", "importActual", "importMock"]);

/**
 * Every specifier a file names: string ones (preProcessFile: static, dynamic, `require`; comments don't count); every
 * call that loads a module from its first argument — `require`, `import()`, `createRequire(…)(…)` and any name bound to
 * `createRequire(…)`, `vi.*`/`vitest.*` mock and import helpers — whose argument isn't a plain string is computed (`null`,
 * or the template's literal head); and `soft`: every other relative string literal, an edge when it names a repo file.
 */
function specifiersOf(path: string, text: string): { literal: string[]; computed: (string | null)[]; soft: string[] } {
  const tsc = typescript();
  const literal = tsc.preProcessFile(text, true, true).importedFiles.map(one => one.fileName);
  const computed: (string | null)[] = [], soft: string[] = [];
  const source = tsc.createSourceFile(path, text, tsc.ScriptTarget.Latest, false, /x$/.test(path) ? tsc.ScriptKind.TSX : tsc.ScriptKind.TS);
  // Names bound to createRequire(…) anywhere in the file (a loader by another name).
  const requires = new Set<string>(["require"]);
  const isCreateRequire = (node: ts.Node): boolean => tsc.isCallExpression(node) && ((tsc.isIdentifier(node.expression) && node.expression.text === "createRequire")
    || (tsc.isPropertyAccessExpression(node.expression) && node.expression.name.text === "createRequire"));
  const bind = (node: ts.Node): void => {
    if (tsc.isVariableDeclaration(node) && tsc.isIdentifier(node.name) && node.initializer !== undefined && isCreateRequire(node.initializer)) requires.add(node.name.text);
    if (tsc.isBinaryExpression(node) && node.operatorToken.kind === tsc.SyntaxKind.EqualsToken && tsc.isIdentifier(node.left) && isCreateRequire(node.right)) requires.add(node.left.text);
    tsc.forEachChild(node, bind);
  };
  bind(source);
  const loader = (callee: ts.Expression): boolean =>
    callee.kind === tsc.SyntaxKind.ImportKeyword
    || (tsc.isIdentifier(callee) && requires.has(callee.text))
    || isCreateRequire(callee)
    || (tsc.isPropertyAccessExpression(callee) && tsc.isIdentifier(callee.expression) && (callee.expression.text === "vi" || callee.expression.text === "vitest") && VI_LOADERS.has(callee.name.text))
    || (tsc.isPropertyAccessExpression(callee) && callee.name.text === "require");
  const visit = (node: ts.Node): void => {
    if (tsc.isCallExpression(node)) {
      const first = node.arguments[0];
      if (loader(node.expression) && first !== undefined) {
        if (tsc.isStringLiteral(first) || tsc.isNoSubstitutionTemplateLiteral(first)) literal.push(first.text);
        else computed.push(tsc.isTemplateExpression(first) && (first.head.text.startsWith("./") || first.head.text.startsWith("../")) ? first.head.text : null);
      }
    }
    if ((tsc.isStringLiteral(node) || tsc.isNoSubstitutionTemplateLiteral(node)) && (node.text.startsWith("./") || node.text.startsWith("../"))) soft.push(node.text);
    tsc.forEachChild(node, visit);
  };
  visit(source);
  return { literal, computed, soft };
}

/**
 * The vitest configs' `resolve.alias` and `test.alias` (string keys to string paths, as an object or a list of
 * `{ find, replacement }`), and whether any alias couldn't be read statically.
 */
function vitestAliases(files: ReadonlyMap<string, string>): { aliases: { find: string; replacement: string }[]; unreadable: string[] } {
  const tsc = typescript(), aliases: { find: string; replacement: string }[] = [], unreadable: string[] = [];
  for (const [path, text] of files) {
    if (!VITEST_CONFIG.test(path)) continue;
    const source = tsc.createSourceFile(path, text, tsc.ScriptTarget.Latest, false, tsc.ScriptKind.TS);
    const text_ = (node: ts.Node | undefined): string | null => node !== undefined && (tsc.isStringLiteral(node) || tsc.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
    const visit = (node: ts.Node): void => {
      if (tsc.isPropertyAssignment(node) && (tsc.isIdentifier(node.name) || tsc.isStringLiteral(node.name)) && node.name.text === "alias") {
        const value = node.initializer;
        const add = (find: string | null, replacement: string | null) => {
          if (find === null || replacement === null || !(replacement.startsWith("./") || replacement.startsWith("../"))) { unreadable.push(path); return; }
          const target = join(dirOf(path), replacement);
          if (target === null) unreadable.push(path); else aliases.push({ find, replacement: target });
        };
        if (tsc.isObjectLiteralExpression(value)) {
          for (const property of value.properties) {
            if (!tsc.isPropertyAssignment(property)) { unreadable.push(path); continue; }
            add(tsc.isIdentifier(property.name) || tsc.isStringLiteral(property.name) ? property.name.text : null, text_(property.initializer));
          }
        } else if (tsc.isArrayLiteralExpression(value)) {
          for (const element of value.elements) {
            if (!tsc.isObjectLiteralExpression(element)) { unreadable.push(path); continue; }
            const field = (name: string) => element.properties.find((one): one is ts.PropertyAssignment => tsc.isPropertyAssignment(one) && (tsc.isIdentifier(one.name) || tsc.isStringLiteral(one.name)) && one.name.text === name)?.initializer;
            add(text_(field("find")), text_(field("replacement")));
          }
        } else unreadable.push(path);
      }
      tsc.forEachChild(node, visit);
    };
    visit(source);
  }
  return { aliases, unreadable };
}

/** The vitest configs' setupFiles and globalSetup entries (string literals), as repository paths. */
function setupRoots(files: ReadonlyMap<string, string>, names: ReadonlySet<string>): { roots: string[]; unresolved: Unresolved[] } {
  const tsc = typescript(), roots: string[] = [], unresolved: Unresolved[] = [];
  for (const [path, text] of files) {
    if (!VITEST_CONFIG.test(path)) continue;
    const source = tsc.createSourceFile(path, text, tsc.ScriptTarget.Latest, false, tsc.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (tsc.isPropertyAssignment(node) && (tsc.isIdentifier(node.name) || tsc.isStringLiteral(node.name)) && (node.name.text === "setupFiles" || node.name.text === "globalSetup")) {
        const values = tsc.isArrayLiteralExpression(node.initializer) ? [...node.initializer.elements] : [node.initializer];
        for (const value of values) {
          if (!tsc.isStringLiteral(value)) { unresolved.push({ from: path, specifier: null, prefix: null }); continue; }
          // vitest resolves them from its root: the config's own folder, or the repository root a config names.
          const found = [dirOf(path), ""].map(dir => { const target = join(dir, value.text); return target === null ? null : fileAt(target, names); }).find(one => one !== null) ?? null;
          if (found !== null) roots.push(found); else unresolved.push({ from: path, specifier: value.text, prefix: join("", value.text) });
        }
      }
      tsc.forEachChild(node, visit);
    };
    visit(source);
  }
  return { roots, unresolved };
}

/**
 * The infrastructure among `files` (path → text: the tree's sources, and its tsconfig.json and package.json): reachable
 * from a test root — every test file, every file under `test/`, every vitest config and its setup files — not itself a
 * test, and not reachable from PRODUCT_ENTRIES; plus every specifier reached from a test root that couldn't be resolved.
 */
export function testInfrastructure(files: ReadonlyMap<string, string>, allPaths: ReadonlySet<string> = new Set(files.keys())): TestInfrastructure {
  const names = new Set([...files.keys()].filter(path => SOURCE.test(path)));
  const vitest = vitestAliases(files);
  const resolve = resolverFor(files, names, allPaths, vitest.aliases);
  const edges = new Map<string, string[]>(), loose = new Map<string, Unresolved[]>();
  for (const path of names) {
    const { literal, computed, soft } = specifiersOf(path, files.get(path)!);
    const targets = new Set<string>(), open: Unresolved[] = [];
    for (const spec of literal) {
      const found = resolve(path, spec);
      if ("file" in found) targets.add(found.file);
      else if ("unresolved" in found) open.push({ from: path, specifier: spec, prefix: found.unresolved });
    }
    for (const head of computed) open.push({ from: path, specifier: head, prefix: head === null ? null : join(dirOf(path), head) });
    // Any other relative string that names a repository source file is an edge (a path handed to a loader by any name).
    for (const spec of soft) { const found = resolve(path, spec); if ("file" in found) targets.add(found.file); }
    edges.set(path, [...targets]);
    loose.set(path, open);
  }
  const setup = setupRoots(files, names);
  const testRoots = [...[...names].filter(path => TEST.test(path) || path.startsWith("test/") || VITEST_CONFIG.test(path)), ...setup.roots];
  const reach = (roots: Iterable<string>): Set<string> => {
    const seen = new Set<string>(), todo = [...roots];
    while (todo.length > 0) { const at = todo.pop()!; if (seen.has(at)) continue; seen.add(at); for (const next of edges.get(at) ?? []) if (!seen.has(next)) todo.push(next); }
    return seen;
  };
  const product = reach(PRODUCT_ENTRIES.filter(path => names.has(path)));
  const tested = reach(testRoots);
  const infra = new Set([...tested].filter(path => !TEST.test(path) && !product.has(path)));
  const unresolved = [...setup.unresolved, ...vitest.unreadable.map(from => ({ from, specifier: null, prefix: null })), ...[...tested].flatMap(path => loose.get(path) ?? [])];
  return { infra, unresolved, product };
}

/**
 * Whether a changed path is something an unresolved specifier might name. A computed one (no prefix) might name anything
 * the other rules don't already trust: any source file that is neither a test nor product code.
 */
export function mightName(open: Unresolved, path: string, found: TestInfrastructure): boolean {
  if (open.prefix === null) return SOURCE.test(path) && !TEST.test(path) && !found.product.has(path);
  const prefix = open.prefix.replace(/\/$/, "");
  const stem = path.replace(/\.[^/.]+$/, "");
  return path === prefix || stem === prefix.replace(/\.(?:[cm]?js|jsx)$/, "") || path.startsWith(`${prefix}/`) || (open.specifier !== null && open.specifier.endsWith("/") === false && path.startsWith(prefix));
}
