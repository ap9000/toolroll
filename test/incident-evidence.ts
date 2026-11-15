import { closeSync, constants, fstatSync, mkdirSync, openSync, readdirSync, readSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Evidence of a git incident for a failed CI run. A test worker's HOME (test/setup-state.ts) and every home a test makes
 * under this run's temp root are thrown away when they finish, and with them `.toolroll/git-incidents.jsonl`, the one
 * record of why a Flexible git check refused (the rare race in F2a's `usableRepository` read). On CI, before they go,
 * each record found is copied, its last 256 KiB, into one folder the workflow uploads when a run fails.
 *
 * What a record holds (src/git-incident.ts GitIncident): a time, the checkout's and repository's paths, the folders
 * found swapped and where each led, the cause and what the plane was doing. Paths of a test's throwaway repositories,
 * no secret.
 *
 * Bounded: at most MAX_FILES copies, MAX_BYTES each; the walk never follows a link and stops after MAX_ENTRIES entries.
 * It never fails a run: a record that can't be read or copied is left out.
 */
export const INCIDENTS_ENV = "TOOLROLL_TEST_INCIDENTS";
export const INCIDENTS_FOLDER = "toolroll-git-incidents";
const MAX_BYTES = 256 * 1024;
const MAX_FILES = 100;
const MAX_DEPTH = 8;
const MAX_ENTRIES = 50_000;
const SKIP = new Set([".git", "node_modules"]);

/** The folder this run keeps records in: the one the environment names (absolute), else on CI one in the temp folder
 * this run started with; none off CI. */
export function incidentEvidenceFolder(env: NodeJS.ProcessEnv = process.env, parent: string = tmpdir()): string | null {
  const given = env[INCIDENTS_ENV];
  if (given !== undefined && given !== "") return isAbsolute(given) ? given : null;
  const ci = env["CI"];
  if (ci === undefined || ci === "" || ci === "false" || ci === "0") return null;
  return join(parent, INCIDENTS_FOLDER);
}

/** Copy one record (a plain file, never through a link) into `folder`, named after `label`. Whether it was kept. */
export function keepIncidentRecord(file: string, folder: string, label: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size === 0) return false;
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    if (readdirSync(folder).length >= MAX_FILES) return false;
    const length = Math.min(stat.size, MAX_BYTES);
    const tail = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const got = readSync(fd, tail, read, length - read, stat.size - length + read);
      if (got === 0) break;
      read += got;
    }
    const name = `${label.replace(/[^\w.-]+/g, "_").slice(0, 80)}-${process.pid}-${randomBytes(4).toString("hex")}.jsonl`;
    writeFileSync(join(folder, name), tail.subarray(0, read), { mode: 0o600, flag: "wx" });
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** Every `.toolroll/git-incidents.jsonl` under `root` (links never followed, bounded), copied into `folder`. */
export function keepIncidentRecordsUnder(root: string, folder: string, label: string): number {
  let kept = 0;
  let entries = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || entries > MAX_ENTRIES) return;
    let listed;
    try { listed = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of listed) {
      if (++entries > MAX_ENTRIES) return;
      if (!entry.isDirectory() || SKIP.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.name === ".toolroll") {
        if (keepIncidentRecord(join(path, "git-incidents.jsonl"), folder, `${label}-${basename(dir)}`)) kept++;
        continue;
      }
      walk(path, depth + 1);
    }
  };
  walk(root, 0);
  return kept;
}
