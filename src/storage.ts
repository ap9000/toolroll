/**
 * Where Toolroll's disk goes (`toolroll storage`): the folder
 * beside the database, by kind, and what storage retention takes care of.
 * Build checkouts and staged releases are the big ones; the worker removes a
 * finished task's clean checkout as the checkout cleanup setting says
 * (checkout-cleanup.ts), and the daily storage sweep (storage-sweep.ts) takes
 * what slips through: stale test temp folders, leftover processes, extra
 * staged runtimes and dependency installs unused for a week.
 */
import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DEPS_FOLDER, sharedCopies } from "./shared-deps.js";
import type { Store } from "./store.js";

/** Settings → Storage: when a finished task's clean checkout is removed. One row, or none (the default). */
export const CHECKOUT_CLEANUP_SCHEMA = `
CREATE TABLE IF NOT EXISTS checkout_cleanup_setting (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  cleanup    TEXT NOT NULL CHECK (cleanup IN ('finished', '2d', '7d', 'never')),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/** What each storage sweep or clean-up by hand did (storage-sweep.ts): the latest few. */
export const STORAGE_SWEEP_SCHEMA = `
CREATE TABLE IF NOT EXISTS storage_sweep (
  id     INTEGER PRIMARY KEY,
  at     TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('automatic', 'manual')),
  actor  TEXT NOT NULL,
  result TEXT NOT NULL
);
`;

export type CheckoutCleanup = "finished" | "2d" | "7d" | "never";
export const DEFAULT_CLEANUP: CheckoutCleanup = "finished";
export const CLEANUP_CHOICES: readonly { value: CheckoutCleanup; label: string; days: number | null }[] = [
  { value: "finished", label: "When its task is complete or cancelled", days: 0 },
  { value: "2d", label: "2 days after that", days: 2 },
  { value: "7d", label: "A week after that", days: 7 },
  { value: "never", label: "Never (only when you clean up)", days: null },
];

/** `finished` (or complete, cancelled), `2d`, `7d` (or week, 1w), `never` (or off); undefined when it's none of those. */
export function parseCleanup(text: string): CheckoutCleanup | undefined {
  const value = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (["finished", "complete", "completed", "cancelled", "done", "0", "0d"].includes(value)) return "finished";
  if (["2d", "2", "2 days", "2days"].includes(value)) return "2d";
  if (["7d", "7", "7 days", "7days", "week", "a week", "1w"].includes(value)) return "7d";
  if (["never", "off"].includes(value)) return "never";
  return undefined;
}

export function cleanupWords(cleanup: CheckoutCleanup): string {
  return cleanup === "finished" ? "when its task is complete or cancelled"
    : cleanup === "never" ? "never (only when you clean up)"
    : `${cleanup === "2d" ? "2 days" : "a week"} after its task is complete or cancelled`;
}

/** Bytes each path holds on disk: one `du` for them all (fast on a 300 MB checkout), a walk where it can't answer. */
export function diskBytes(paths: readonly string[]): Map<string, number> {
  const sizes = new Map<string, number>();
  if (paths.length === 0) return sizes;
  if (process.platform !== "win32") {
    for (let at = 0; at < paths.length; at += 200) {
      const batch = paths.slice(at, at + 200);
      const du = spawnSync("du", ["-sk", ...batch], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
      for (const line of (du.stdout ?? "").split("\n")) {
        const match = /^(\d+)\t(.+)$/.exec(line);
        if (match !== null && batch.includes(match[2]!)) sizes.set(match[2]!, Number(match[1]) * 1024);
      }
    }
  }
  for (const path of paths) if (!sizes.has(path)) sizes.set(path, treeBytes(path));
  return sizes;
}

export type StorageLine = { what: string; bytes: number; count?: number; note?: string };

/** Bytes a tree holds on disk (allocated blocks; links not followed). */
export function treeBytes(path: string): number {
  let total = 0;
  const pending = [path];
  while (pending.length > 0) {
    const at = pending.pop()!;
    let stat;
    try { stat = lstatSync(at); } catch { continue; }
    total += typeof stat.blocks === "number" ? stat.blocks * 512 : stat.size;
    if (!stat.isDirectory()) continue;
    let names: string[] = [];
    try { names = readdirSync(at); } catch { names = []; }
    for (const name of names) pending.push(join(at, name));
  }
  return total;
}

export function storageReport(store: Store, databaseFile: string, checkoutNote?: string): { folder: string; total: number; lines: StorageLine[] } {
  const folder = dirname(databaseFile);
  const base = basename(databaseFile);
  let names: string[] = [];
  try { names = readdirSync(folder); } catch { names = []; }
  const measured = diskBytes(names.map(name => join(folder, name)));
  const sizes = new Map(names.map(name => [name, measured.get(join(folder, name)) ?? 0]));
  const take = (match: (name: string) => boolean) => {
    let bytes = 0;
    for (const [name, size] of sizes) if (match(name)) { bytes += size; sizes.delete(name); }
    return bytes;
  };
  const checkouts = store.listWorktrees();
  let staged = 0;
  try { staged = readdirSync(join(folder, "staged-upgrades")).length; } catch { staged = 0; }
  const lines: StorageLine[] = [
    { what: "Database", bytes: take(name => name.startsWith(base)) },
    { what: "Build checkouts", bytes: take(name => name === "worktrees"), count: checkouts.length, ...(checkoutNote === undefined ? {} : { note: checkoutNote }) },
    { what: "Shared dependencies", bytes: take(name => name === DEPS_FOLDER), count: sharedCopies(join(folder, DEPS_FOLDER)).length, note: "one install per lockfile, linked into checkouts; one unused for a week goes" },
    { what: "Staged releases", bytes: take(name => name === "staged-upgrades"), count: staged, note: "kept: the one running, the one before it and the newest" },
    { what: "Evidence", bytes: take(name => name === "evidence"), note: "the audit record of every run; kept" },
    { what: "Backups", bytes: take(name => name === "backups") },
  ];
  lines.push({ what: "Everything else", bytes: [...sizes.values()].reduce((sum, one) => sum + one, 0) });
  return { folder, total: lines.reduce((sum, one) => sum + one.bytes, 0), lines };
}

export function bytesWords(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}
