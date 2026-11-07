/**
 * The code map's records (docs/plans/code-map.md §3): immutable versions, the pointer to the current one, and the
 * per-project refresh record whose lease fences every later write. Delivery and measurement rows sit here too. The
 * rows are Toolroll's own; nothing goes in a repository.
 */
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { trustedRemoteIdentity, type Store } from "./store.js";
import type { CodeMap, CodeMapGraph, CodeMapManifest } from "./code-map-shape.js";
import { LIMITS } from "./code-map-shape.js";
import type { SpawnRecord } from "./bounded-spawn.js";

export const V152_SCHEMA = `
CREATE TABLE IF NOT EXISTS code_map_version (
  id INTEGER PRIMARY KEY, repo TEXT NOT NULL, remote_digest TEXT NOT NULL, remote_record INTEGER NOT NULL, commit_sha TEXT NOT NULL,
  extractor TEXT NOT NULL, built_at TEXT NOT NULL, manifest BLOB NOT NULL, manifest_sha TEXT NOT NULL, graph BLOB NOT NULL, graph_sha TEXT NOT NULL, report TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS code_map_version_repo ON code_map_version (repo, id);
CREATE TABLE IF NOT EXISTS code_map_current (repo TEXT PRIMARY KEY, version INTEGER NOT NULL REFERENCES code_map_version(id));
CREATE TABLE IF NOT EXISTS code_map_refresh (
  repo TEXT PRIMARY KEY, lease_token INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, lease_until TEXT,
  request_id INTEGER NOT NULL DEFAULT 0, requested_at TEXT, requested_by TEXT,
  failures INTEGER NOT NULL DEFAULT 0, retry_after TEXT, last_error TEXT, last_checked_at TEXT,
  seen_digest TEXT, seen_record INTEGER, seen_commit TEXT, seen_extractor TEXT, seen_state TEXT,
  spawn_pid INTEGER, spawn_pgid INTEGER, spawn_started TEXT, spawn_folder TEXT, enforced TEXT, proxy TEXT
);
CREATE TABLE IF NOT EXISTS code_map_family (
  root_task TEXT PRIMARY KEY, repo TEXT NOT NULL, arm TEXT NOT NULL CHECK (arm IN ('map','holdout')), enrolled_at TEXT NOT NULL, observe_until TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS code_map_family_repo ON code_map_family (repo);
CREATE TABLE IF NOT EXISTS code_map_snapshot (
  run INTEGER PRIMARY KEY, state TEXT NOT NULL CHECK (state IN ('map','off','none','remote-changed','holdout','unavailable')),
  version INTEGER, excerpt TEXT NOT NULL, excerpt_sha TEXT NOT NULL, file_selected INTEGER NOT NULL CHECK (file_selected IN (0,1))
);
CREATE INDEX IF NOT EXISTS code_map_snapshot_version ON code_map_snapshot (version);
CREATE TABLE IF NOT EXISTS code_map_delivery (
  id INTEGER PRIMARY KEY, run INTEGER NOT NULL, attempt INTEGER NOT NULL, at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('delivered','not-delivered')),
  reason TEXT CHECK (reason IS NULL OR reason IN ('no-confinement','write-failed','sha-mismatch','version-pruned','not-selected')), path_sha TEXT,
  UNIQUE (run, attempt)
);
CREATE TABLE IF NOT EXISTS code_map_meta (id INTEGER PRIMARY KEY CHECK (id = 1), run_watermark INTEGER NOT NULL);
CREATE TRIGGER IF NOT EXISTS code_map_version_no_update BEFORE UPDATE ON code_map_version BEGIN SELECT RAISE(ABORT,'a code map version is immutable'); END;
CREATE TRIGGER IF NOT EXISTS code_map_version_guarded_delete BEFORE DELETE ON code_map_version
WHEN EXISTS (SELECT 1 FROM code_map_current WHERE version = OLD.id)
  OR EXISTS (SELECT 1 FROM code_map_snapshot s JOIN run r ON r.id = s.run WHERE s.version = OLD.id AND r.outcome IS NULL)
BEGIN SELECT RAISE(ABORT,'a code map version in use stays'); END;
CREATE TRIGGER IF NOT EXISTS code_map_family_no_update BEFORE UPDATE ON code_map_family BEGIN SELECT RAISE(ABORT,'a family arm is frozen'); END;
CREATE TRIGGER IF NOT EXISTS code_map_family_no_delete BEFORE DELETE ON code_map_family BEGIN SELECT RAISE(ABORT,'a family arm is frozen'); END;
CREATE TRIGGER IF NOT EXISTS code_map_snapshot_no_update BEFORE UPDATE ON code_map_snapshot BEGIN SELECT RAISE(ABORT,'a code map snapshot is immutable'); END;
CREATE TRIGGER IF NOT EXISTS code_map_snapshot_no_delete BEFORE DELETE ON code_map_snapshot BEGIN SELECT RAISE(ABORT,'a code map snapshot is immutable'); END;
CREATE TRIGGER IF NOT EXISTS code_map_delivery_no_update BEFORE UPDATE ON code_map_delivery BEGIN SELECT RAISE(ABORT,'a code map delivery is immutable'); END;
CREATE TRIGGER IF NOT EXISTS code_map_delivery_no_delete BEFORE DELETE ON code_map_delivery BEGIN SELECT RAISE(ABORT,'a code map delivery is immutable'); END;
CREATE TRIGGER IF NOT EXISTS code_map_meta_no_update BEFORE UPDATE ON code_map_meta BEGIN SELECT RAISE(ABORT,'the watermark is set once'); END;
CREATE TRIGGER IF NOT EXISTS code_map_meta_no_delete BEFORE DELETE ON code_map_meta BEGIN SELECT RAISE(ABORT,'the watermark is set once'); END;
`;

/** The tables and triggers V152_SCHEMA makes, for the startup check and the tests. */
export const V152_TABLES = Object.freeze(["code_map_version", "code_map_current", "code_map_refresh", "code_map_family", "code_map_snapshot", "code_map_delivery", "code_map_meta"] as const);
export const V152_TRIGGERS = Object.freeze(["code_map_version_no_update", "code_map_version_guarded_delete", "code_map_family_no_update", "code_map_family_no_delete", "code_map_snapshot_no_update",
  "code_map_snapshot_no_delete", "code_map_delivery_no_update", "code_map_delivery_no_delete", "code_map_meta_no_update", "code_map_meta_no_delete"] as const);
/** v152: a saved project reads the map on, with no enrollment yet. */
export const V152_ADDED_COLUMNS: Readonly<Record<string, Readonly<Record<string, { definition: string; saved: string }>>>> = Object.freeze({
  project: {
    code_map: { definition: "INTEGER NOT NULL DEFAULT 1 CHECK (code_map IN (0,1))", saved: "1" },
    code_map_enroll_until: { definition: "TEXT", saved: "NULL" },
  },
});

const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
export const digestOfUrl = (url: string): string => sha(url);
export const CODE_MAP_ACT = "code map check";

export type Identity = { url: string; record: number };
const sameIdentity = (a: Identity | null, b: Identity | null): boolean => a !== null && b !== null && a.url === b.url && a.record === b.record;

export function codeMapOn(store: Store, repo: string): boolean {
  const row = store.handle.prepare("SELECT code_map FROM project WHERE path = ?").get(repo);
  return row !== undefined && Number(row["code_map"]) === 1;
}

// ---- the refresh record: lease and fenced writes -----------------------------------------------------------------

export type Refresh = {
  repo: string; leaseToken: number; leaseOwner: string | null; leaseUntil: string | null; requestId: number; requestedAt: string | null; requestedBy: string | null;
  failures: number; retryAfter: string | null; lastError: string | null; lastCheckedAt: string | null;
  seen: { digest: string | null; record: number | null; commit: string | null; extractor: string | null; state: string | null };
  spawn: SpawnRecord; enforced: string | null; proxy: string | null;
};
const textOf = (value: unknown): string | null => (typeof value === "string" ? value : null);
const intOf = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
function refreshOf(row: Record<string, unknown>): Refresh {
  return {
    repo: String(row["repo"]), leaseToken: Number(row["lease_token"]), leaseOwner: textOf(row["lease_owner"]), leaseUntil: textOf(row["lease_until"]), requestId: Number(row["request_id"]),
    requestedAt: textOf(row["requested_at"]), requestedBy: textOf(row["requested_by"]), failures: Number(row["failures"]), retryAfter: textOf(row["retry_after"]), lastError: textOf(row["last_error"]),
    lastCheckedAt: textOf(row["last_checked_at"]), seen: { digest: textOf(row["seen_digest"]), record: intOf(row["seen_record"]), commit: textOf(row["seen_commit"]), extractor: textOf(row["seen_extractor"]), state: textOf(row["seen_state"]) },
    spawn: { pid: intOf(row["spawn_pid"]), pgid: intOf(row["spawn_pgid"]), startedAt: textOf(row["spawn_started"]), folder: textOf(row["spawn_folder"]) }, enforced: textOf(row["enforced"]), proxy: textOf(row["proxy"]),
  };
}
export function readRefresh(store: Store, repo: string): Refresh | null {
  const row = store.handle.prepare("SELECT * FROM code_map_refresh WHERE repo = ?").get(repo);
  return row === undefined ? null : refreshOf(row);
}
const ensureRefresh = (store: Store, repo: string): void => { store.handle.prepare("INSERT OR IGNORE INTO code_map_refresh (repo) VALUES (?)").run(repo); };

export const LEASE_MS = 10 * 60_000;
export type Lease = { repo: string; token: number; owner: string; requestId: number; previous: SpawnRecord };

/** Take the lease in one statement. A takeover always gets a higher token; null when it is held. */
export function takeLease(store: Store, repo: string, owner: string, now: Date): Lease | null {
  ensureRefresh(store, repo);
  const before = readRefresh(store, repo)!;
  const taken = store.handle.prepare(`UPDATE code_map_refresh SET lease_token = lease_token + 1, lease_owner = ?, lease_until = ?
    WHERE repo = ? AND (lease_owner IS NULL OR lease_until < ?)`).run(owner, new Date(now.getTime() + LEASE_MS).toISOString(), repo, now.toISOString());
  if (Number(taken.changes) !== 1) return null;
  const after = readRefresh(store, repo)!;
  return { repo, token: after.leaseToken, owner, requestId: after.requestId, previous: before.spawn };
}

/** A fenced write: changes rows only while this lease stands. Zero rows means the lease was lost. */
function fenced(store: Store, lease: Lease, set: string, values: readonly (string | number | null)[], extra = "", extraValues: readonly (string | number | null)[] = []): boolean {
  const ran = store.handle.prepare(`UPDATE code_map_refresh SET ${set} WHERE repo = ? AND lease_token = ? AND lease_owner = ?${extra}`).run(...values, lease.repo, lease.token, lease.owner, ...extraValues);
  return Number(ran.changes) === 1;
}
export const extendLease = (store: Store, lease: Lease, now: Date): boolean => fenced(store, lease, "lease_until = ?", [new Date(now.getTime() + LEASE_MS).toISOString()]);
export const releaseLease = (store: Store, lease: Lease): boolean => fenced(store, lease, "lease_owner = NULL, lease_until = NULL, spawn_pid = NULL, spawn_pgid = NULL, spawn_started = NULL, spawn_folder = NULL", []);
export const clearOldSpawn = (store: Store, lease: Lease): boolean => fenced(store, lease, "spawn_pid = NULL, spawn_pgid = NULL, spawn_started = NULL, spawn_folder = NULL", []);
export const recordFolder = (store: Store, lease: Lease, folder: string): boolean => fenced(store, lease, "spawn_folder = ?", [folder]);
export const recordSpawn = (store: Store, lease: Lease, spawn: { pid: number; pgid: number; startedAt: string | null }): boolean =>
  fenced(store, lease, "spawn_pid = ?, spawn_pgid = ?, spawn_started = ?", [spawn.pid, spawn.pgid, spawn.startedAt]);
/** Clear the request this lease saw, and only that one: a request made during the build stays queued. */
export const clearRequest = (store: Store, lease: Lease): boolean =>
  fenced(store, lease, "requested_at = NULL, requested_by = NULL", [], " AND request_id = ?", [lease.requestId]);

export type CheckFacts = { digest: string | null; record: number | null; commit: string | null; extractor: string | null; state: string; enforced?: string | null; proxy?: string | null };
/** A finished check that found nothing wrong: failures reset. */
export const recordCheck = (store: Store, lease: Lease, facts: CheckFacts, now: Date): boolean =>
  fenced(store, lease, "failures = 0, retry_after = NULL, last_error = NULL, last_checked_at = ?, seen_digest = ?, seen_record = ?, seen_commit = ?, seen_extractor = ?, seen_state = ?, enforced = COALESCE(?, enforced), proxy = ?",
    [now.toISOString(), facts.digest, facts.record, facts.commit, facts.extractor, facts.state, facts.enforced ?? null, facts.proxy ?? null]);
/** What the peek saw, kept even if the build then fails: the page's "Main has moved to …". */
export const recordPeek = (store: Store, lease: Lease, commit: string): boolean => fenced(store, lease, "seen_commit = ?", [commit]);
export const BACKOFF_MS = [30 * 60_000, 2 * 3_600_000, 6 * 3_600_000] as const;
/** A failed check: 30 minutes, then 2 hours, then 6 hours. */
export function recordFailure(store: Store, lease: Lease, why: string, state: string, now: Date): boolean {
  const failures = readRefresh(store, lease.repo)?.failures ?? 0;
  const wait = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)]!;
  return fenced(store, lease, "failures = failures + 1, retry_after = ?, last_error = ?, last_checked_at = ?, seen_state = ?", [new Date(now.getTime() + wait).toISOString(), why.slice(0, 300), now.toISOString(), state]);
}

export const REQUEST_GAP_MS = 10 * 60_000;
/** Queue a manual check: at most one per project per 10 minutes. It never bypasses back-off. */
export function requestRefresh(store: Store, repo: string, by: string, now: Date): "queued" | "already-queued" {
  return store.transact(() => {
    ensureRefresh(store, repo);
    const held = readRefresh(store, repo)!;
    if (held.requestedAt !== null) return "already-queued";
    const last = store.handle.prepare("SELECT at FROM action_ledger WHERE repo = ? AND action = 'code map refresh asked' ORDER BY id DESC LIMIT 1").get(repo);
    if (last !== undefined && now.getTime() - Date.parse(String(last["at"])) < REQUEST_GAP_MS) return "already-queued";
    store.handle.prepare("UPDATE code_map_refresh SET request_id = request_id + 1, requested_at = ?, requested_by = ? WHERE repo = ?").run(now.toISOString(), by, repo);
    store.recordAction({ at: now.toISOString(), actor: by, repo, taskId: null, runId: null, action: "code map refresh asked", outcome: "queued", source: "request", detail: null });
    return "queued";
  });
}

/** The remote-change transaction's part: the pointer clears and a build still running for the old remote is fenced out.
 * Called from store.recordProjectRemote, inside the transaction that records the new remote. */
export function codeMapRemoteChanged(store: Store, repo: string): void {
  store.handle.prepare("DELETE FROM code_map_current WHERE repo = ?").run(repo);
  store.handle.prepare("UPDATE code_map_refresh SET lease_token = lease_token + 1, lease_owner = NULL, lease_until = NULL, seen_commit = NULL, seen_digest = NULL, seen_record = NULL, failures = 0, retry_after = NULL WHERE repo = ?").run(repo);
}

// ---- versions -----------------------------------------------------------------------------------------------------

export type VersionRow = { id: number; repo: string; remoteDigest: string; remoteRecord: number; commit: string; extractor: string; builtAt: string; report: string };
const versionOf = (row: Record<string, unknown>): VersionRow => ({ id: Number(row["id"]), repo: String(row["repo"]), remoteDigest: String(row["remote_digest"]), remoteRecord: Number(row["remote_record"]),
  commit: String(row["commit_sha"]), extractor: String(row["extractor"]), builtAt: String(row["built_at"]), report: String(row["report"]) });
const VERSION_COLUMNS = "id, repo, remote_digest, remote_record, commit_sha, extractor, built_at, report";
export function currentVersion(store: Store, repo: string): VersionRow | null {
  const row = store.handle.prepare(`SELECT ${VERSION_COLUMNS} FROM code_map_version WHERE id = (SELECT version FROM code_map_current WHERE repo = ?)`).get(repo);
  return row === undefined ? null : versionOf(row);
}
export function versionRow(store: Store, id: number): VersionRow | null {
  const row = store.handle.prepare(`SELECT ${VERSION_COLUMNS} FROM code_map_version WHERE id = ?`).get(id);
  return row === undefined ? null : versionOf(row);
}
/** The stored bytes, checked against their digests before they are parsed; null when they don't verify. */
export function readVersionMap(store: Store, id: number): CodeMap | null {
  const row = store.handle.prepare("SELECT manifest, manifest_sha, graph, graph_sha FROM code_map_version WHERE id = ?").get(id);
  if (row === undefined) return null;
  try {
    const manifest = gunzipSync(row["manifest"] as Uint8Array, { maxOutputLength: LIMITS.storedBytes * 2 });
    const graph = gunzipSync(row["graph"] as Uint8Array, { maxOutputLength: LIMITS.storedBytes * 2 });
    if (sha(manifest) !== row["manifest_sha"] || sha(graph) !== row["graph_sha"]) return null;
    return { ...(JSON.parse(manifest.toString("utf8")) as CodeMapManifest), ...(JSON.parse(graph.toString("utf8")) as CodeMapGraph) };
  } catch { return null; }
}

export type Encoded = { manifest: Buffer; manifestSha: string; graph: Buffer; graphSha: string; bytes: number };
export function encodeMap(map: CodeMap): Encoded {
  const { edges, ...rest } = map;
  const manifest = Buffer.from(JSON.stringify(rest));
  const graph = Buffer.from(JSON.stringify({ edges }));
  return { manifest: gzipSync(manifest), manifestSha: sha(manifest), graph: gzipSync(graph), graphSha: sha(graph), bytes: manifest.length + graph.length };
}

export type PublishOutcome = { version: number; current: boolean; why: "published" | "remote-changed" | "off" | "lease-lost" | "pointer-moved" };
/**
 * Store a built version and, in the same transaction, make it current only if the identity captured before the fetch
 * still stands, the map is still on, the build still holds its lease, and the pointer is where it found it. A build that
 * lost its lease stores nothing at all.
 */
export function publishVersion(store: Store, lease: Lease, input: { map: CodeMap; encoded: Encoded; identity: Identity; startedFrom: number | null; report: string }, now: Date): PublishOutcome | null {
  return store.transact(() => {
    const held = readRefresh(store, lease.repo);
    if (held === null || held.leaseToken !== lease.token || held.leaseOwner !== lease.owner) return null;
    const { map, encoded } = input;
    const stored = store.handle.prepare(`INSERT INTO code_map_version (repo, remote_digest, remote_record, commit_sha, extractor, built_at, manifest, manifest_sha, graph, graph_sha, report)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(lease.repo, map.remote.urlDigest, map.remote.record, map.commit, map.extractor, now.toISOString(), encoded.manifest, encoded.manifestSha, encoded.graph, encoded.graphSha, input.report);
    const version = Number(stored.lastInsertRowid);
    const pointer = store.handle.prepare("SELECT version FROM code_map_current WHERE repo = ?").get(lease.repo);
    const at = pointer === undefined ? null : Number(pointer["version"]);
    if (!sameIdentity(input.identity, trustedRemoteIdentity(store, lease.repo))) return { version, current: false, why: "remote-changed" };
    if (!codeMapOn(store, lease.repo)) return { version, current: false, why: "off" };
    if (at !== input.startedFrom) return { version, current: false, why: "pointer-moved" };
    store.handle.prepare("INSERT INTO code_map_current (repo, version) VALUES (?, ?) ON CONFLICT (repo) DO UPDATE SET version = excluded.version").run(lease.repo, version);
    return { version, current: true, why: "published" };
  });
}

/** Keep the current version, the 10 before it and any named by an unfinished run. */
export function tidyVersions(store: Store, repo: string): number {
  return store.transact(() => {
    const current = store.handle.prepare("SELECT version FROM code_map_current WHERE repo = ?").get(repo);
    if (current === undefined) return 0;
    const ran = store.handle.prepare(`DELETE FROM code_map_version WHERE repo = ? AND id < ? AND id NOT IN (
        SELECT id FROM code_map_version WHERE repo = ? AND id < ? ORDER BY id DESC LIMIT 10)
      AND id NOT IN (SELECT s.version FROM code_map_snapshot s JOIN run r ON r.id = s.run WHERE s.version IS NOT NULL AND r.outcome IS NULL)`).run(repo, Number(current["version"]), repo, Number(current["version"]));
    return Number(ran.changes);
  });
}

/** A project removed from the lists: its map rows go with it, except what stays with its runs (snapshots, deliveries,
 * family arms) and any version an unfinished run still names. */
export function forgetCodeMap(store: Store, repo: string): void {
  store.handle.prepare("DELETE FROM code_map_current WHERE repo = ?").run(repo);
  store.handle.prepare("DELETE FROM code_map_refresh WHERE repo = ?").run(repo);
  store.handle.prepare(`DELETE FROM code_map_version WHERE repo = ? AND id NOT IN (SELECT s.version FROM code_map_snapshot s JOIN run r ON r.id = s.run WHERE s.version IS NOT NULL AND r.outcome IS NULL)`).run(repo);
}

/** The startup check: a store at this version holds every table and trigger, or its map can't be trusted. */
export function codeMapShapeProblem(db: { prepare(sql: string): { get(...args: string[]): unknown } }): string | null {
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?");
  for (const table of V152_TABLES) if (has.get("table", table) === undefined) return `the code map table ${table} is missing`;
  for (const trigger of V152_TRIGGERS) if (has.get("trigger", trigger) === undefined) return `the code map trigger ${trigger} is missing`;
  return null;
}
