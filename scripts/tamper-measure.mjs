#!/usr/bin/env node
/**
 * How often the tamper scan (src/tamper-scan.ts) flags honest work, over the last releases (trusted-release-reports.md,
 * H4). Every release here was reviewed and shipped, so each one it flags is a false positive by construction: that rate
 * says whether the scan could ever be more than a note. Needs `npm run build`. Reads Git only; changes nothing.
 *
 *   node scripts/tamper-measure.mjs [--releases <n>] [--json]
 */
import { execFileSync } from "node:child_process";
import { tamperFindings } from "../dist/tamper-scan.js";

const args = process.argv.slice(2);
const count = args.includes("--releases") ? Number(args[args.indexOf("--releases") + 1]) : 30;
const git = (...argv) => execFileSync("git", argv, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
const show = (tag, path) => { try { return git("show", `${tag}:${path}`); } catch { return null; } };
const CODE = /\.(?:[cm]?[jt]sx?)$/;

const tags = git("tag", "--list", "v*", "--sort=-v:refname").split("\n").filter(Boolean).slice(0, count + 1).reverse();
const rows = [];
for (let at = 1; at < tags.length; at++) {
  const [from, to] = [tags[at - 1], tags[at]];
  const changed = git("diff", "--name-only", "--diff-filter=AM", from, to).split("\n").filter(path => CODE.test(path));
  const flagged = [];
  for (const path of changed) {
    const now = show(to, path);
    if (now === null) continue;
    const findings = tamperFindings(path, show(from, path), now);
    if (findings.length > 0) flagged.push({ path, test: /\.test\./.test(path), findings });
  }
  rows.push({ release: to, changed: changed.length, flaggedFiles: flagged.length, findings: flagged.reduce((n, one) => n + one.findings.length, 0), inTests: flagged.filter(one => one.test).length, flagged });
}
const touched = rows.filter(one => one.flaggedFiles > 0).length;
const product = rows.filter(one => one.flagged.some(file => !file.test)).length;
const tests = rows.filter(one => one.flagged.some(file => file.test)).length;
const summary = { releases: rows.length, flagged: touched, flaggedInProductCode: product, flaggedInTests: tests, changedFiles: rows.reduce((n, one) => n + one.changed, 0), flaggedFiles: rows.reduce((n, one) => n + one.flaggedFiles, 0), findings: rows.reduce((n, one) => n + one.findings, 0) };
if (args.includes("--json")) console.log(JSON.stringify({ summary, rows }, null, 2));
else {
  for (const one of rows) console.log(`${one.release.padEnd(9)} ${String(one.changed).padStart(4)} files, ${String(one.flaggedFiles).padStart(3)} flagged (${one.inTests} tests), ${one.findings} findings`);
  console.log(`${summary.flagged} of ${summary.releases} releases flagged (${summary.flaggedInProductCode} in product code, ${summary.flaggedInTests} in tests); ${summary.flaggedFiles} of ${summary.changedFiles} changed files; ${summary.findings} findings. Every one of these releases was reviewed and shipped.`);
}
