/**
 * The ref audit for Flexible threads (the Flexible plan v2 §1): the project's refs as Toolroll reads them at a thread's
 * start and at each import, so an import can say when a ref outside refs/toolroll/ changed while the thread ran.
 * Detection only: it decides nothing, and a person's own commits are expected (said as "changed by someone else", never
 * blamed on the thread). Used by the thread engine (flexible-thread.ts) and the import (flexible-import.ts) only, which
 * read the refs with the shared hardened runner and pass them here.
 */
import { createHash } from "node:crypto";
import type { Store } from "./store.js";

export type ProjectRefs = Readonly<Record<string, string>>;
type Git = (cwd: string, args: readonly string[]) => Promise<{ code: number; stdout: string }>;

/** Bounds on what one read keeps: a repository with more refs than this is read as unreadable (no snapshot). */
const MAX_REFS = 100_000;

/** The project's refs, name → object id, read with `git` (the caller's hardened runner, bound to the project); null when
 * they can't be read exactly. */
export async function readProjectRefs(git: Git, project: string): Promise<ProjectRefs | null> {
  const listed = await git(project, ["for-each-ref", "--format=%(refname)%00%(objectname)"]);
  if (listed.code !== 0) return null;
  const refs: Record<string, string> = {};
  const lines = listed.stdout.split("\n").filter(line => line !== "");
  if (lines.length > MAX_REFS) return null;
  for (const line of lines) {
    const [name, sha, extra] = line.split("\0");
    if (name === undefined || sha === undefined || extra !== undefined || !/^refs\/[^\0\n]{1,1000}$/.test(name) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) return null;
    refs[name] = sha;
  }
  return refs;
}

const refsJson = (refs: ProjectRefs): string => JSON.stringify(Object.fromEntries(Object.entries(refs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));

/** Keep `refs` as the thread's latest snapshot (one row per thread, replaced). */
export function saveRefSnapshot(store: Store, thread: string, refs: ProjectRefs, at: Date): void {
  const json = refsJson(refs);
  store.handle.prepare(`INSERT INTO flexible_ref_snapshot (thread, taken_at, refs_json, digest) VALUES (?, ?, ?, ?)
    ON CONFLICT (thread) DO UPDATE SET taken_at = excluded.taken_at, refs_json = excluded.refs_json, digest = excluded.digest`)
    .run(thread, at.toISOString(), json, createHash("sha256").update(json, "utf8").digest("hex"));
}

/** The thread's latest snapshot, or null when there is none or it can't be read exactly. */
export function refSnapshotOf(store: Store, thread: string): ProjectRefs | null {
  const row = store.handle.prepare("SELECT refs_json, digest FROM flexible_ref_snapshot WHERE thread = ?").get(thread);
  if (row === undefined) return null;
  const json = String(row["refs_json"]);
  if (createHash("sha256").update(json, "utf8").digest("hex") !== row["digest"]) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const refs = parsed as Record<string, unknown>;
    return Object.values(refs).every(value => typeof value === "string") ? refs as ProjectRefs : null;
  } catch { return null; }
}

/** The refs outside refs/toolroll/ that were added, removed or moved between two reads, sorted. */
export function refsChangedOutside(before: ProjectRefs, after: ProjectRefs): string[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].filter(name => !name.startsWith("refs/toolroll/") && before[name] !== after[name]).sort();
}
