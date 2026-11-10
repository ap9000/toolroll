#!/usr/bin/env node
// Real-launchd canary for the stop of a new service that never started completely
// (docs/plans/recovery-stops-silent-service.md §12). Run only by a person, only after the owner said yes to that run:
//
//   node scripts/deploy-stop-canary.mjs --owner-approved
//
// It never runs in CI, never on its own, never with the real service label, and never touches port 4180,
// ~/.config/standing-orders, ~/Library/LaunchAgents or a login item. Everything lives in a fresh temp folder: a
// throwaway label (com.toolroll.canary.<random>), its definition, a fake runtime whose supervisor only idles and never
// starts an `up`, and an empty database file. It runs the same readers the deployment uses (deploy-launchd.mjs,
// deploy-stop.mjs), the one act (`launchctl bootout` of that label) and the absence proof, each call bounded, then
// cleans up: bootout of that label only, `print` must answer 113, and the temp folder is removed. It reports any cleanup
// it could not prove.
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BOOTOUT_MS, boundedRunner, parseLaunchdPrint, programArguments, recordedLeft, treeOf, uncertain } from "./deploy-launchd.mjs";
import { commandKind, listProcesses } from "./deploy-stop.mjs";

/** Labels the canary may use: only its own throwaway form, so never the real service's. */
export const CANARY_LABEL = /^com\.toolroll\.canary\.[0-9a-f]{16}$/;

/** Why the canary must not run, or null. Checked before any subprocess. */
export function canaryRefusal({ argv, env, platform }) {
  if (env.CI !== undefined && env.CI !== "") return "The stop canary never runs in CI.";
  if (!argv.includes("--owner-approved")) return "The stop canary runs only with the owner's yes for this run: pass --owner-approved.";
  if (platform !== "darwin") return "The stop canary exercises macOS launchd.";
  const at = argv.indexOf("--label");
  if (at >= 0 && !CANARY_LABEL.test(String(argv[at + 1] ?? ""))) return "The stop canary uses only its own throwaway label (com.toolroll.canary.<16 hex>), never a real service's.";
  return null;
}

const xml = text => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Runs the canary. `launchctl` is the binary to call (tests pass a fake that only records); the command line always
 * uses /bin/launchctl. Returns the report; throws the refusal before calling anything. */
export async function runCanary({ argv, env, platform, launchctl = "/bin/launchctl", uid = process.getuid?.() ?? -1, waitMs = 10_000, say = message => console.error(message) }) {
  const refusal = canaryRefusal({ argv, env, platform });
  if (refusal !== null) throw Error(refusal);
  const at = argv.indexOf("--label");
  const label = at >= 0 ? argv[at + 1] : `com.toolroll.canary.${randomBytes(8).toString("hex")}`;
  if (!CANARY_LABEL.test(label)) throw Error("The stop canary uses only its own throwaway label.");
  const target = `gui/${uid}/${label}`;
  const run = boundedRunner(spawnSync);
  const sleep = ms => new Promise(done => setTimeout(done, ms));
  const print = () => run(launchctl, ["print", target]);
  const report = { label, steps: [], cleanup: [], ok: false };
  const step = (name, detail) => { report.steps.push({ name, ...(detail === undefined ? {} : { detail }) }); say(`• ${name}${detail === undefined ? "" : `: ${detail}`}`); };

  const first = print();
  if (uncertain(first) || first.status !== 113) throw Error(`The label ${label} is already loaded or launchd's answer could not be read; nothing was done.`);
  // A state-like folder named as Toolroll's own, and the fake runtime X inside it.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "toolroll-stop-canary-")));
  const dist = join(root, "staged-upgrades", "canary", "runtime", "dist"), database = join(root, "orders.db"), plist = join(root, `${label}.plist`);
  let bootstrapped = false;
  try {
    mkdirSync(dist, { recursive: true });
    // The supervisor only idles: it never starts an `up`, so the service never starts completely.
    writeFileSync(join(dist, "controller-service.js"), "setInterval(() => {}, 1 << 30);\n");
    writeFileSync(join(dist, "cli.js"), "throw new Error('the canary never runs this');\n");
    writeFileSync(database, "");
    const args = [process.execPath, join(dist, "controller-service.js"), process.execPath, join(dist, "cli.js"), "up", "--db", database];
    const definition = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n\t<key>Label</key>\n\t<string>${xml(label)}</string>\n\t<key>ProgramArguments</key>\n\t<array>\n${args.map(arg => `\t\t<string>${xml(arg)}</string>`).join("\n")}\n\t</array>\n\t<key>KeepAlive</key>\n\t<true/>\n\t<key>RunAtLoad</key>\n\t<true/>\n</dict>\n</plist>\n`;
    writeFileSync(plist, definition, { mode: 0o600 });
    const defined = programArguments(definition);
    if (JSON.stringify(defined) !== JSON.stringify(args)) throw Error("The canary's own definition did not read back.");
    const booted = run(launchctl, ["bootstrap", `gui/${uid}`, plist]);
    if (uncertain(booted) || booted.status !== 0) throw Error(`launchctl bootstrap of ${label} failed (exit ${booted.status}).`);
    bootstrapped = true;
    step("bootstrapped", label);

    // The facts: loaded from this definition, one running process with the supervisor's command line, parent 1.
    let seen = null;
    for (const until = Date.now() + waitMs; Date.now() < until; await sleep(500)) {
      const out = print();
      if (uncertain(out) || out.status !== 0) continue;
      seen = parseLaunchdPrint(String(out.stdout), target);
      if (seen?.state === "running" && seen.pid !== null) break;
    }
    if (seen === null || seen.state !== "running" || seen.pid === null) throw Error("launchd's answer did not parse, or showed no running process.");
    step("parsed launchctl print", `pid ${seen.pid}`);
    if (seen.path !== plist || JSON.stringify(seen.arguments) !== JSON.stringify(args)) throw Error("launchd's loaded path or arguments differ from the definition.");
    const list = () => listProcesses((command, argv2, options) => spawnSync(command, argv2, { ...options, timeout: 10_000 }));
    const rows = list();
    const top = rows?.find(row => row.pid === seen.pid);
    if (top === undefined || top.ppid !== 1 || commandKind(top.command, { dist, database }) !== "supervisor") throw Error("The loaded process does not have the canary supervisor's command line with parent 1.");
    const tree = treeOf(rows, seen.pid);
    if (tree === null) throw Error("The canary's process tree could not be listed whole.");
    if (rows.some(row => row.ppid === seen.pid && commandKind(row.command, { dist, database }) === "up")) throw Error("The canary's supervisor started an up; it never should.");
    step("facts hold", `${tree.length} process(es) recorded`);

    // The act, bounded, and its outcome.
    const out = run(launchctl, ["bootout", target], BOOTOUT_MS);
    if (uncertain(out)) throw Error("launchctl bootout did not finish.");
    step("bootout", `exit ${out.status}`);
    if (out.status !== 0) throw Error(`launchctl bootout returned exit ${out.status}.`);
    bootstrapped = false;
    // Absence, observed.
    let left = ["not checked"];
    for (const until = Date.now() + 75_000; Date.now() < until; await sleep(1000)) {
      const now = print(), after = list();
      left = [...(uncertain(now) || now.status !== 113 ? ["launchd still has it or did not answer"] : []), ...recordedLeft(after, tree)];
      if (left.length === 0) break;
    }
    if (left.length > 0) throw Error(`Absence was not proved: ${left.join("; ")}.`);
    step("absence proved");
    report.ok = true;
  } finally {
    // Cleanup: this label only.
    const now = print();
    if (bootstrapped || uncertain(now) || now.status !== 113) {
      const out = run(launchctl, ["bootout", target], BOOTOUT_MS);
      report.cleanup.push(`bootout ${label}: ${uncertain(out) ? "did not finish" : `exit ${out.status}`}`);
    }
    const last = print();
    if (uncertain(last) || last.status !== 113) report.cleanup.push(`not proved: ${label} may still be loaded; check with launchctl print ${target}`);
    try { rmSync(root, { recursive: true, force: true }); } catch { report.cleanup.push(`not removed: ${root}`); }
    for (const note of report.cleanup) say(`  cleanup: ${note}`);
  }
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  try {
    const report = await runCanary({ argv: process.argv.slice(2), env: process.env, platform: process.platform });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ok && report.cleanup.every(one => !one.startsWith("not ")) ? 0 : 1;
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exitCode = 1;
  }
}
