#!/usr/bin/env node
/**
 * The lead-answer eval (docs/plans/responsive-chat.md §8): the gate on turning quick answers on by default.
 *
 *   npm run build && node scripts/lead-answer-eval.mjs            # scripted: no provider call (what CI runs, as a test)
 *   npm run build && node scripts/lead-answer-eval.mjs --real     # real: every turn goes to this computer's signed-in Claude
 *   ... [--k 3] [--out <file.json>]
 *
 * Real mode spends Claude membership usage (about 186 turns at k = 3) and runs in a throwaway in-memory world: it never
 * opens your Toolroll database. Exits 0 when the eval passes, 1 when it fails, 2 on a usage error.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const flag = name => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : undefined; };
const known = new Set(["--real", "--k", "--out"]);
for (const [index, one] of args.entries()) {
  if (one.startsWith("--") && !known.has(one)) { process.stderr.write(`unknown flag ${one}\n`); process.exit(2); }
  if (!one.startsWith("--") && !["--k", "--out"].includes(args[index - 1] ?? "")) { process.stderr.write(`unexpected ${one}\n`); process.exit(2); }
}
const k = flag("k") === undefined ? 3 : Number(flag("k"));
if (!Number.isInteger(k) || k < 1 || k > 10) { process.stderr.write("--k is a whole number from 1 to 10\n"); process.exit(2); }
const mode = args.includes("--real") ? "real" : "scripted";
const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const { runLeadAnswerEval } = await import(pathToFileURL(join(dist, "lead-answer-eval.js")).href);
const report = await runLeadAnswerEval({ mode, k, onRun: line => process.stderr.write(`${line}\n`) });
const out = flag("out");
if (out !== undefined) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
const { read, act } = report;
process.stdout.write([
  `lead-answer eval (${mode}, k=${k}, quick model ${report.quickModel})`,
  `  read questions named in all ${k} runs: main ${read.main.passK}/${read.questions}, quick ${read.quick.passK}/${read.questions}`,
  `  false claims: main ${read.main.falseClaims}, quick ${read.quick.falseClaims}`,
  `  median turn: main ${read.main.medianMs} ms, quick ${read.quick.medianMs} ms (${Math.round(report.speedup * 100)}% faster)`,
  `  act questions on the main model or escalated: ${act.kept}/${act.total}`,
  report.pass ? (mode === "real" ? "PASS: quick answers may ship on." : "PASS (scripted: proves the harness only; the gate is --real).") : `FAIL: ${report.reasons.join("; ")}`,
  "",
].join("\n"));
process.exit(report.pass ? 0 : 1);
