/** Repository context is unchanged by the code-extract.ts split: the same index, byte for byte, for a fixture with
 * JSONC tsconfig, non-string options, aliases, every relationship kind and a syntax error. */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { repositoryContext } from "./repository-context.js";

let root: string, repo: string;
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe", encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
const FILES: Record<string, string> = {
  "tsconfig.json": `// JSONC
{ "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["src/lib/*"] }, "strict": true, "target": "ES2022", /* a comment */ "module": "NodeNext", "moduleResolution": "NodeNext", "allowJs": true, "noEmit": 1, }, "extends": "./base.json" }`,
  "src/lib/util.ts": "export function util(): number { return 1; }\nexport const value = 2;\nclass Hidden { method() { const inner = 1; return inner; } }\nexport default Hidden;\n",
  "src/lib/types.ts": "export interface Shape { a: string }\nexport type Alias = Shape;\nexport enum Kind { One }\n",
  "src/index.ts": "import { util } from './lib/util.js';\nimport '@lib/types.js';\nexport { value } from './lib/util.js';\nconst later = () => import('./lib/types.js');\nconst plain = require('./lib/util.js');\nimport missing from 'left-pad';\nexport { later, plain, util, missing };\n",
  "src/view.tsx": "import { util } from './lib/util.js';\nexport const View = () => <div>{util()}</div>;\n",
  "src/broken.ts": "export function broken( {\n",
  "notes.md": "words\n",
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "so-extract-")));
  repo = join(root, "repo");
  mkdirSync(repo);
  git("init", "-q", "-b", "main");
  for (const [file, text] of Object.entries(FILES)) { mkdirSync(dirname(join(repo, file)), { recursive: true }); writeFileSync(join(repo, file), text); }
  git("add", "-A"); git("commit", "-qm", "seed");
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

test("the index is the one the unsplit code wrote", async () => {
  const cacheRoot = join(root, "cache");
  await repositoryContext({ repo, query: "", refresh: true, cacheRoot });
  const [name] = readdirSync(cacheRoot);
  const { index } = JSON.parse(readFileSync(join(cacheRoot, name!), "utf8")) as { index: { extractor: string; nodes: unknown; relationships: unknown; warnings: unknown } };
  const got = { extractor: index.extractor, nodes: index.nodes, relationships: index.relationships, warnings: index.warnings };
  expect(got).toEqual(GOLDEN);
});

const GOLDEN = {"extractor": "typescript-parser@6.0.3/imports-v1", "nodes": [{"file": "src/broken.ts", "name": "broken", "line": 1, "endLine": 1}, {"file": "src/index.ts", "name": "later", "line": 4, "endLine": 4}, {"file": "src/index.ts", "name": "plain", "line": 5, "endLine": 5}, {"file": "src/lib/types.ts", "name": "Shape", "line": 1, "endLine": 1}, {"file": "src/lib/types.ts", "name": "Alias", "line": 2, "endLine": 2}, {"file": "src/lib/types.ts", "name": "Kind", "line": 3, "endLine": 3}, {"file": "src/lib/util.ts", "name": "util", "line": 1, "endLine": 1}, {"file": "src/lib/util.ts", "name": "value", "line": 2, "endLine": 2}, {"file": "src/lib/util.ts", "name": "Hidden", "line": 3, "endLine": 3}, {"file": "src/lib/util.ts", "name": "method", "line": 3, "endLine": 3}, {"file": "src/lib/util.ts", "name": "inner", "line": 3, "endLine": 3}, {"file": "src/view.tsx", "name": "View", "line": 2, "endLine": 2}], "relationships": [{"from": "src/index.ts", "to": "src/lib/util.ts", "kind": "imports", "file": "src/index.ts", "line": 1, "provenance": "explicit"}, {"from": "src/index.ts", "to": "src/lib/types.ts", "kind": "imports", "file": "src/index.ts", "line": 2, "provenance": "explicit"}, {"from": "src/index.ts", "to": "src/lib/util.ts", "kind": "re-exports", "file": "src/index.ts", "line": 3, "provenance": "explicit"}, {"from": "src/index.ts", "to": "src/lib/types.ts", "kind": "dynamic-import", "file": "src/index.ts", "line": 4, "provenance": "explicit"}, {"from": "src/view.tsx", "to": "src/lib/util.ts", "kind": "imports", "file": "src/view.tsx", "line": 1, "provenance": "explicit"}], "warnings": ["Inherited tsconfig settings are not indexed; unresolved aliases remain omitted.", "1 external or unresolved imports were omitted.", "1 files had syntax errors; extracted relationships may be incomplete."]};
