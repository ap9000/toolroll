/**
 * The console's shared chrome (the sidebar's project states, the Tasks count, the crew list): computed at most once
 * per workspace revision for one reader's exact access, and readable on a read worker (read-executor.ts) as well as on
 * the request thread. Cache metadata only: nothing here grants access. Every entry's key carries every authorization
 * input its computation reads (the reader, their admitted projects, whether they see unplaced work, the projects their
 * sidebar may list), so a value read for one scope is never served to another.
 */
import { createHash } from "node:crypto";
import { NO_COUNTS, projectStates, STATE_WORDS, type ProjectState } from "./agent-state.js";
import { boundProjectSummary, type BrowserAsk, type BrowserProjectState, type BrowserRailTask } from "./browser-workspace.js";
import type { Store } from "./store.js";
import { WORK_INDEX_MAX_LIMIT, workIndexPage, type WorkIndexOptions } from "./work-index.js";
import type { WorkSummaryAccess } from "./work-summary.js";
import type { WorkspaceRevision } from "./workspace-revision.js";

/** Tasks the rail lists under a project; the rest are a count that links to the project's tasks. */
const RAIL_TASKS = 6;
/** Asks a project names for the chime (its count is complete beyond them). */
const ASKS_PER_PROJECT = 100;

export type SidebarProject = { path: string; name: string };

/** The sidebar's projects with their states (agent-state.ts) for one reader: the page's first read and the summary
 * room's snapshots are this one function, so the two never disagree. Never marks anything seen. Work with no project
 * yet is its own entry when this reader may see it and something counts there. */
export function projectSummaryOf(store: Store, now: Date, access: WorkSummaryAccess, actor: string, projects: readonly SidebarProject[], evidenceRoot: string | undefined): BrowserProjectState[] {
  const states = new Map(projectStates(store, access, actor, now, evidenceRoot, projects.map(one => one.path)).map(one => [one.repo, one]));
  // A row that needs a person or failed says what the Tasks list says it needs (its own next step); a row at work says
  // what its agent did last; a finished one says Done.
  const asking = [...states.values()].flatMap(one => one.families.slice(0, RAIL_TASKS)).filter(one => one.state === "needs-you" || one.state === "failed").map(one => one.rootId);
  const needWords = new Map<string, string>();
  if (asking.length > 0) {
    try {
      // Every row the rail may list, in pages the index allows.
      for (let at = 0; at < asking.length; at += WORK_INDEX_MAX_LIMIT)
        for (const item of workIndexPage(store, now, access, { roots: asking.slice(at, at + WORK_INDEX_MAX_LIMIT), limit: WORK_INDEX_MAX_LIMIT, ...(evidenceRoot === undefined ? {} : { root: evidenceRoot }) }).items)
          needWords.set(item.rootId, item.status.detail !== "" ? item.status.detail : item.status.label);
    } catch { /* the rows keep their state's words */ }
  }
  // The chime's subjects: an opaque key per obligation and version, scoped to this reader (no words, no ids in it).
  const keyOf = (...parts: (string | number)[]) => createHash("sha256").update([actor, ...parts].join("\u0000")).digest("base64url").slice(0, 22);
  // Newest first, so a new ask always has a key however many older ones wait (those were heard when they were new).
  const asksOf = (state: ProjectState | undefined): BrowserAsk[] => [
    ...(state?.families ?? []).flatMap(one => one.ask === undefined ? [] : [{ at: one.ask.at, ask: { key: keyOf("task", one.rootId, one.ask.version), task: one.rootId, run: one.ask.run, at: one.ask.at } }]),
    ...(state?.flowAsks ?? []).map(one => ({ at: one.at, ask: { key: keyOf("flow", one.card, one.stage, one.entry), task: null, run: null, at: one.at } })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, ASKS_PER_PROJECT).map(one => one.ask);
  const railOf = (state: ProjectState | undefined) => {
    const families = state?.families ?? [];
    const tasks = families.slice(0, RAIL_TASKS).flatMap((one): BrowserRailTask[] => {
      const task = store.getTask(one.rootId);
      const line = one.state === "needs-you" || one.state === "failed" ? needWords.get(one.rootId) ?? null : one.line;
      return task === null ? [] : [{ id: one.rootId, title: task.title, href: `/t/${encodeURIComponent(one.rootId)}`, state: one.state, line: line ?? STATE_WORDS[one.state] }];
    });
    return { tasks, more: Math.max(0, families.length - RAIL_TASKS), asks: asksOf(state) };
  };
  const rows: BrowserProjectState[] = projects.map(one => {
    const state = states.get(one.path);
    return { path: one.path, name: one.name, href: `/work?project=${encodeURIComponent(one.path)}`, state: state?.state ?? "idle", counts: state?.counts ?? { ...NO_COUNTS }, ...railOf(state) };
  });
  const unplaced = states.get(null);
  if (unplaced !== undefined && unplaced.state !== "idle") rows.push({ path: null, name: "No project", href: "/work", state: unplaced.state, counts: unplaced.counts, ...railOf(unplaced) });
  return boundProjectSummary(rows);
}

/** One access, canonically and in full (every field it has, so a field added later keys too): the same reader and
 * scope always spell the same key, whatever order its projects came in. */
export function accessKey(access: WorkSummaryAccess): string {
  const record = access as unknown as Record<string, unknown>;
  return JSON.stringify(Object.keys(record).sort().map(name => {
    const value = record[name];
    return [name, Array.isArray(value) ? [...new Set(value.map(String))].sort() : value === undefined ? null : value];
  }));
}

type Entry = { revision: string; expiresAt: number; value: unknown };

/**
 * Values read from the database, each kept while the workspace revision (workspace-revision.ts: every meaningful
 * commit, from any process, moves it) is the one it was read at, and never past the revision's own clock boundary
 * (a lease or liveness window ending) or `maxAgeMs`, whichever is first — time alone (an agent going quiet) shows
 * within that bound. A value is stored under the revision read before it was computed, so a commit that lands while it
 * is computed only makes it miss sooner. Callers must not change a value they were handed.
 */
export class RevisionCache {
  readonly #entries = new Map<string, Entry>();
  readonly #revision: WorkspaceRevision;
  readonly #clock: () => Date;
  readonly #maxEntries: number;
  readonly #maxAgeMs: number;

  constructor(revision: WorkspaceRevision, clock: () => Date, options: { maxEntries?: number; maxAgeMs?: number } = {}) {
    this.#revision = revision;
    this.#clock = clock;
    this.#maxEntries = options.maxEntries ?? 128;
    this.#maxAgeMs = options.maxAgeMs ?? 30_000;
  }

  /** The value for `key` at the current revision, or undefined. */
  peek<T>(key: string): T | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    let revision: string;
    try { revision = this.#revision.current(); } catch { return undefined; }
    if (entry.revision !== revision || this.#clock().getTime() >= entry.expiresAt) { this.#entries.delete(key); return undefined; }
    return entry.value as T;
  }

  /** The cached value, or `compute()` now (stored for the next reader). Errors are never cached. */
  read<T>(key: string, compute: () => T): T {
    const hit = this.peek<T>(key);
    if (hit !== undefined) return hit;
    const started = this.#started();
    const value = compute();
    if (started !== null) this.#store(key, started, value);
    return value;
  }

  /** The cached value, or one read asynchronously (a read worker) and stored. A failure answers undefined and leaves
   * the key empty, so the request thread computes it as before. */
  async fill<T>(key: string, compute: () => Promise<T>): Promise<T | undefined> {
    const hit = this.peek<T>(key);
    if (hit !== undefined) return hit;
    const started = this.#started();
    if (started === null) return undefined;
    let value: T;
    try { value = await compute(); } catch { return undefined; }
    this.#store(key, started, value);
    return value;
  }

  #started(): { revision: string; expiresAt: number } | null {
    try {
      const now = this.#clock();
      return { revision: this.#revision.current(), expiresAt: Math.min(this.#revision.expiresAt(now), now.getTime() + this.#maxAgeMs) };
    } catch { return null; }
  }

  #store(key: string, started: { revision: string; expiresAt: number }, value: unknown): void {
    this.#entries.delete(key);
    if (this.#entries.size >= this.#maxEntries) this.#entries.delete(this.#entries.keys().next().value!);
    this.#entries.set(key, { ...started, value });
  }
}

/** The keys the console's chrome reads are kept under (serve.ts and its read-worker prefetch spell them the same). */
export const countsKey = (access: WorkSummaryAccess): string => `counts\u0000${accessKey(access)}`;
export const summaryKey = (actor: string, access: WorkSummaryAccess, projects: readonly SidebarProject[]): string =>
  `summary\u0000${actor}\u0000${accessKey(access)}\u0000${JSON.stringify(projects.map(one => [one.path, one.name]))}`;
export const indexKey = (access: WorkSummaryAccess, options: WorkIndexOptions): string => {
  const record = options as Record<string, unknown>;
  return `index\u0000${accessKey(access)}\u0000${JSON.stringify(Object.keys(record).sort().map(name => [name, record[name] ?? null]))}`;
};
