/**
 * Replays every saved scope, standing order and sealed route in a Toolroll database through the current readers,
 * read-only: each row's digest (and approved digest) re-derived from its own stored terms, each stored route read and
 * re-encoded. Prints counts and the keys of rows that do not match — never their text.
 *
 *   npx tsx scripts/scope-replay.ts [database]   (default: ~/.config/standing-orders/orders.db)
 *
 * Exits 1 when any row or route does not match.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readSavedRows, replayRows, type RowReplay } from "../test/scope-replay.js";

const file = process.argv[2] ?? join(homedir(), ".config", "standing-orders", "orders.db");
const replay = replayRows(readSavedRows(file));

let mismatches = 0;
const report = (table: string, rows: readonly RowReplay[]) => {
  const routes = rows.flatMap(row => [row.route, row.approvedRoute]).filter(one => one !== null);
  const bad: string[] = [];
  for (const row of rows) {
    const why = [
      row.digest !== row.stored.digest ? "digest" : null,
      row.stored.approvedDigest !== null && row.approvedDigest !== row.stored.approvedDigest ? "approved digest" : null,
      ...[row.route, row.approvedRoute].map(route => (route === null ? null : route.canonical === null ? "route unreadable" : route.sameBytes ? null : "route bytes")),
    ].filter(one => one !== null);
    if (why.length > 0) bad.push(`  ${table} ${row.key}: ${why.join(", ")}`);
  }
  mismatches += bad.length;
  console.log(`${table}: ${rows.length} rows, ${rows.filter(row => row.stored.approvedDigest !== null).length} approved, ${routes.length} stored routes; ${bad.length} mismatched`);
  for (const line of bad) console.log(line);
};

console.log(`replaying ${file} (read-only)`);
report("task_scope", replay.task_scope);
report("routine", replay.routine);
console.log(mismatches === 0 ? "every digest and route matches" : `${mismatches} rows do not match`);
process.exitCode = mismatches === 0 ? 0 : 1;
