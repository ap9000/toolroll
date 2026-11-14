#!/usr/bin/env node
/**
 * The wire budgets' report (test/perf/wire.wire.test.ts, docs/TESTING.md "Wire budgets").
 *
 *   node scripts/wire-report.mjs <wire-budgets.json> [<main's wire-budgets.json>]
 *
 * Prints a markdown table of every row (scenario, metric, observed, ceiling, result). With main's report it adds the
 * rows that changed against main, and names every ceiling this report raises over main's. Reads files only; never
 * fails on a budget (the test does that), only on a file it cannot read.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const formatBytes = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
const formatValue = (row, value) => value === null || value === undefined ? "none" : row.unit === "bytes" ? formatBytes(value) : row.unit === "ms" ? `${value} ms` : String(value);
const cell = text => String(text).replace(/\|/g, "\\|");

/** Gated rows over their ceiling, or with no ceiling at all (a new row needs one on purpose). */
export function violationsOf(report) {
  return report.rows.filter(row => row.gated && (typeof row.ceiling !== "number" || row.observed > row.ceiling))
    .map(row => typeof row.ceiling !== "number" ? `${row.id}: ${row.observed} has no ceiling in test/perf/wire-ceilings.json` : `${row.id}: ${row.observed} is over its ceiling ${row.ceiling}`);
}

export function formatReport(report, base) {
  const lines = ["## Wire budgets", ""];
  const failed = violationsOf(report);
  lines.push(failed.length === 0 ? "Every gated row is within its ceiling." : `**${failed.length} gated row${failed.length === 1 ? "" : "s"} over budget.**`, "");
  lines.push("Bytes are pre-compression. Gated: bytes, rows, SQL statements and projection calls (deterministic on the seeded world). Server time and memory are reported only.", "");
  if (base) {
    const before = new Map(base.rows.map(row => [row.id, row]));
    const changed = report.rows.filter(row => row.gated && before.has(row.id) && before.get(row.id).observed !== row.observed);
    const added = report.rows.filter(row => row.gated && !before.has(row.id));
    const raised = report.rows.filter(row => row.gated && before.has(row.id) && typeof row.ceiling === "number" && typeof before.get(row.id).ceiling === "number" && row.ceiling > before.get(row.id).ceiling);
    lines.push(`Compared with main${base.sha ? ` (${String(base.sha).slice(0, 7)})` : ""}: ${changed.length} changed, ${added.length} new, ${raised.length} ceiling${raised.length === 1 ? "" : "s"} raised.`, "");
    if (raised.length > 0) {
      lines.push("### Ceilings this pull request raises", "", "| Scenario | Metric | Main's ceiling | New ceiling |", "| --- | --- | ---: | ---: |");
      for (const row of raised) lines.push(`| ${cell(row.scenario)} | ${cell(row.metric)} | ${formatValue(row, before.get(row.id).ceiling)} | ${formatValue(row, row.ceiling)} |`);
      lines.push("");
    }
    if (changed.length + added.length > 0) {
      lines.push("### Changed against main", "", "| Scenario | Metric | Main | This PR | Change |", "| --- | --- | ---: | ---: | ---: |");
      for (const row of [...changed, ...added]) {
        const was = before.get(row.id)?.observed;
        const delta = was === undefined ? "new" : `${row.observed > was ? "+" : ""}${row.unit === "bytes" ? formatBytes(Math.abs(row.observed - was)).replace(/^/, row.observed < was ? "-" : "") : row.observed - was}`;
        lines.push(`| ${cell(row.scenario)} | ${cell(row.metric)} | ${was === undefined ? "none" : formatValue(row, was)} | ${formatValue(row, row.observed)} | ${delta} |`);
      }
      lines.push("");
    }
  }
  lines.push("### Every row", "", "| Scenario | Metric | Observed | Ceiling | Result |", "| --- | --- | ---: | ---: | --- |");
  for (const row of report.rows) {
    const result = !row.gated ? "INFO" : typeof row.ceiling !== "number" ? "FAIL (no ceiling)" : row.observed <= row.ceiling ? "PASS" : "FAIL";
    lines.push(`| ${cell(row.scenario)} | ${cell(row.metric)} | ${formatValue(row, row.observed)} | ${row.gated ? formatValue(row, row.ceiling) : "none"} | ${result} |`);
  }
  return `${lines.join("\n")}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [current, base] = process.argv.slice(2);
  if (!current) { console.error("usage: node scripts/wire-report.mjs <wire-budgets.json> [<main's wire-budgets.json>]"); process.exit(2); }
  const read = file => JSON.parse(readFileSync(file, "utf8"));
  let baseReport = null;
  if (base) { try { baseReport = read(base); } catch { baseReport = null; } }
  process.stdout.write(formatReport(read(current), baseReport));
}
