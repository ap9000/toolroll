#!/usr/bin/env node
/**
 * The package bin (install review). Nothing here touches the store: this
 * file exists so the runtime is checked BEFORE `node:sqlite` is imported,
 * and the answer to "why did it die" is one sentence instead of a resolver
 * stack. Bun's runtime has no node:sqlite; `bunx toolroll …`
 * (without --bun) hands the shebang to Node and works.
 *
 * The floor is the first Node 22 the whole store works on: 22.20.0. Node 22.13–22.15
 * bundle SQLite without FTS5, which the store's schema needs, and can't open the
 * database; on 22.16–22.19 node:sqlite fails the store's writes ("column index out of
 * range" starting a run). package.json engines, install.sh and the docs say the same
 * number (src/node-floor.test.ts).
 */
const FLOOR = { major: 22, minor: 20 } as const;
const versions = process.versions as { bun?: string; node: string; sqlite?: string };
const [major = 0, minor = 0] = versions.node.split(".").map(Number);
// How to get one, as install.sh says it: on Linux the distribution's own nodejs is usually too old (Ubuntu 24.04: 18).
const HOW = (process.platform === "linux"
  ? "Install it from https://nodejs.org/en/download (choose nvm: `nvm install 22`), or from NodeSource (https://github.com/nodesource/distributions); `apt install nodejs` is usually too old."
  : "Install it from https://nodejs.org/en/download" + (process.platform === "darwin" ? ", or with `brew install node`." : ".")) + "\n";
if (versions.bun !== undefined) {
  process.stderr.write(
    `Toolroll runs on Node ${FLOOR.major}.${FLOOR.minor} or newer — Bun's runtime has no node:sqlite.\n` +
      "Run it with Node: `bunx toolroll` (no --bun) or `npx toolroll`.\n",
  );
  process.exit(2);
}
if (major < FLOOR.major || (major === FLOOR.major && minor < FLOOR.minor)) {
  process.stderr.write(`Toolroll needs Node ${FLOOR.major}.${FLOOR.minor} or newer (this is ${versions.node}): it uses node:sqlite.\n${HOW}`);
  process.exit(2);
}
/** Whether this Node's SQLite has full-text search (FTS5), which the store's schema needs: a Node built against a
 * SQLite without it passes the version check and then can't open its database. Its experimental notice stays quiet
 * here, as the CLI keeps it quiet (cli.ts hushExperimentalSqlite). */
async function sqliteHasFts5(): Promise<boolean> {
  const original = process.emitWarning;
  process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
    const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
    if (type === "ExperimentalWarning" && String(warning instanceof Error ? warning.message : warning).includes("SQLite")) return;
    (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    try { db.exec("CREATE VIRTUAL TABLE fts5_probe USING fts5(x)"); return true; } finally { db.close(); }
  } catch {
    return false;
  } finally {
    process.emitWarning = original;
  }
}
// --version and the top-level usage answer here, before the CLI and its command families load.
const argv = process.argv.slice(2);
const { quickAnswer } = await import("./cli-fast.js");
const quick = quickAnswer(argv);
if (quick !== null) {
  console.log(quick);
} else {
  // Only on the way into the CLI: --version and help answer above without loading SQLite.
  if (!(await sqliteHasFts5())) {
    process.stderr.write(`Toolroll needs a Node whose SQLite has full-text search (FTS5); this Node (${versions.node}, SQLite ${versions.sqlite ?? "unknown"}) doesn't.\n${HOW}`);
    process.exit(2);
  }
  const { runCliProcess } = await import("./cli.js");
  await runCliProcess(argv);
}
