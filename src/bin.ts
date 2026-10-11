#!/usr/bin/env node
/**
 * The package bin (install review). Nothing here touches the store: this
 * file exists so the runtime is checked BEFORE `node:sqlite` is imported,
 * and the answer to "why did it die" is one sentence instead of a resolver
 * stack. Bun's runtime has no node:sqlite; `bunx toolroll …`
 * (without --bun) hands the shebang to Node and works.
 */
const versions = process.versions as { bun?: string; node: string };
const [major = 0, minor = 0] = versions.node.split(".").map(Number);
if (versions.bun !== undefined) {
  process.stderr.write(
    "Toolroll runs on Node 22.13 or newer — Bun's runtime has no node:sqlite.\n" +
      "Run it with Node: `bunx toolroll up` (no --bun) or `npx toolroll up`.\n",
  );
  process.exit(2);
}
if (major < 22 || (major === 22 && minor < 13)) {
  process.stderr.write(`Toolroll needs Node 22.13 or newer (this is ${versions.node}) — it uses node:sqlite.\n`);
  process.exit(2);
}
// --version and the top-level usage answer here, before the CLI and its command families load.
const argv = process.argv.slice(2);
const { quickAnswer } = await import("./cli-fast.js");
const quick = quickAnswer(argv);
if (quick !== null) {
  console.log(quick);
} else {
  const { runCliProcess } = await import("./cli.js");
  await runCliProcess(argv);
}
