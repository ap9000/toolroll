/** Unreachable copied-stage experiment. This is neither a restore API nor proof of recovery readiness. */
import * as fs from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { openStore, type Store } from "./store.js";
import { revokeCoordinator } from "./coordinator.js";

// Exact fresh v177 schema, compiled from this reviewed source (708 non-internal objects).
// Variants/unknown schemas remain unsupported; no caller can supply or widen this inventory.
// This unreachable scaffold supports backups up to128MiB; larger files require a reviewed streaming design.
// This is an input byte bound, never an agent/model runtime deadline.
export const MAX_STAGE_BYTES = 128 * 1024 * 1024;
const SUPPORTED_SCHEMA = 177;
const SCHEMA_DIGEST = "d9aa15ce2b9571f9453f981272c5322b6714d123667e49ed5251dc7eeb23baa1";
const INVENTORY = [
  ["person-credentials", "store.ts:revokeApiToken", "credential", true],
  ["lead-credentials", "store.ts:revokeLeadCredentials", "credential", true],
  ["coordinator-credentials", "coordinator.ts:revokeCoordinator", "credential/coordinator_proposal", true],
  ["inbound-oauth", "mcp-oauth.ts/store.ts", "oauth_code/oauth_grant/oauth_refresh", true],
  ["publication-grant-verifier", "store.ts:revokePublicationGrant/publish.ts:permitsPublication", "publication_grant", true],
  ["durable-browser-sessions", "server/guards.ts/session.ts", "web_session", true],
  ["local-owner-and-memory", "local-owner.ts/server/guards.ts", "local_mode/in-memory nonces and links", false],
  ["password-and-saved-login", "scope.ts/login-secrets.ts", "approver/protected login files", false],
  ["sso-membership", "sso-settings.ts/store.ts", "sso_identity/protected sign-in settings", false],
  ["derived-chat-invites-push", "store.ts/chat-approval.ts", "paired chat/confirmations/invites/push", false],
  ["flexible-authority", "flexible-sign-in.ts", "flexible sign-ins/threads/protected secrets", false],
  ["runner-and-native-custody", "runner.ts/runner-process.ts", "claims/leases/attempts/protected process records", false],
  ["execution-and-publication", "approval-authority.ts/approval-policy.ts", "approvals/modes/releases/schedules/repair", false],
  ["public-hooks-and-triggers", "server/remote-hooks.ts/flow-triggers.ts", "intake/trigger/delivery standing", false],
  ["provider-and-outbound-oauth", "keys.ts/tool-secret-store.ts", "external secrets/tool and task references", false],
  ["central-device-and-transfer", "future central protocol", "enrollment/lease/transfer/settlement", false],
] as const;
export type RecoveryStageReport = {
  manifestVersion: 1; manifestDigest: string; schema: number | null; schemaSupported: boolean; complete: false; recoveryReady: false;
  outcome: "retired-partial" | "unsupported-schema" | "failed"; repeated: boolean;
  entries: readonly { id: string; owner: string; storage: string; status: "retired" | "unsupported"; affected: number | null; remaining: number | null }[];
};
declare const handleBrand: unique symbol;
/** Path is evidence only. Mutation authority is the module-private identity, never this field or a supplied Store. */
export type RecoveryStageHandle = Readonly<{ copyPath: string; [handleBrand]: true }>;
type Stamp = { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number };
type Kept = { source: string; sourceStamp: Stamp; sourceDigest: string; copy: string; copyStamp: Stamp; copyDigest: string;
  directory: string; directoryStamp: Stamp; supported: boolean; schema: number | null; store?: Store; report?: RecoveryStageReport };
const stages = new WeakMap<object, Kept>();
const stamp = (s: fs.Stats): Stamp => ({ dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs });
const same = (a: Stamp, b: Stamp): boolean => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
function canonical(path: string, directory = false): fs.Stats {
  if (typeof path !== "string" || resolve(path) !== path || fs.realpathSync(path) !== path) throw Error("Stage path must be canonical and contain no symlink");
  const s = fs.lstatSync(path);
  if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile())) throw Error("Stage path is not a plain file or directory");
  return s;
}
function noSidecars(path: string): void {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try { fs.lstatSync(path + suffix); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    throw Error("Cold backup has a journal or WAL sidecar");
  }
}
function regularBounded(fd: number): fs.Stats {
  const info = fs.fstatSync(fd);
  if (!info.isFile()) throw Error("Opened backup is not a regular file");
  if (!Number.isSafeInteger(info.size) || info.size < 0 || info.size > MAX_STAGE_BYTES) throw Error("Backup exceeds128MiB stage byte limit");
  return info;
}
function readBounded(fd: number): Buffer {
  const initial = regularBounded(fd); // Validate size before allocation, including oversized sparse files.
  const bytes = Buffer.allocUnsafe(initial.size); let offset = 0;
  while (offset < bytes.length) {
    if (!same(stamp(initial), stamp(regularBounded(fd)))) throw Error("File changed while being read");
    const size = fs.readSync(fd, bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
    if (size === 0) throw Error("File changed while being read");
    offset += size;
  }
  // A growing file cannot extend the read/allocation indefinitely or hide bytes past its initial size.
  if (!same(stamp(initial), stamp(regularBounded(fd)))) throw Error("File changed while being read");
  const extra = Buffer.allocUnsafe(1);
  if (fs.readSync(fd, extra, 0, 1, offset) !== 0) throw Error("File changed while being read");
  if (!same(stamp(initial), stamp(regularBounded(fd)))) throw Error("File changed while being read");
  return bytes;
}
function readStable(path: string): { mark: Stamp; hash: string; header: Buffer } {
  noSidecars(path); const before = stamp(canonical(path));
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (!same(before, stamp(regularBounded(fd)))) throw Error("File identity changed");
    const bytes = readBounded(fd), hash = digest(bytes);
    if (!same(before, stamp(regularBounded(fd))) || !same(before, stamp(canonical(path)))) throw Error("File changed while being read");
    noSidecars(path); return { mark: before, hash, header: Buffer.from(bytes.subarray(0, 100)) };
  } finally { fs.closeSync(fd); }
}
function schemaOf(path: string): { schema: number | null; supported: boolean } {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (db.prepare("PRAGMA quick_check").get()?.["quick_check"] !== "ok") throw Error("Copied backup integrity check failed");
    const rows = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    const version = db.prepare("SELECT version FROM schema_version").all();
    const schema = version.length === 1 && typeof version[0]?.["version"] === "number" ? version[0]["version"] : null;
    return { schema, supported: schema === SUPPORTED_SCHEMA && createHash("sha256").update(JSON.stringify(rows)).digest("hex") === SCHEMA_DIGEST };
  } finally { db.close(); }
}
/** Explicit cold backup only; no default path, existing Store, live service or caller-supplied isolation proof. */
export function copyCentralRecoveryStage(source: string, privateParent: string): RecoveryStageHandle {
  const parent = canonical(privateParent, true);
  if (parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0) throw Error("Stage parent must be owner-private");
  const initial = readStable(source);
  const header = initial.header;
  if (header.toString("ascii", 0, 16) !== "SQLite format 3\0" || header[18] !== 1 || header[19] !== 1) throw Error("Cold backup must be a standalone rollback-journal database, not WAL mode");
  const directory = fs.mkdtempSync(join(privateParent, "central-recovery-")); fs.chmodSync(directory, 0o700);
  const copy = join(directory, "stage.db");
  let stageStore: Store | undefined;
  try {
    const fd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      if (!same(initial.mark, stamp(regularBounded(fd)))) throw Error("Source changed before copy");
      const bytes = readBounded(fd);
      if (digest(bytes) !== initial.hash || !same(initial.mark, stamp(regularBounded(fd)))) throw Error("Source changed during copy");
      const output = fs.openSync(copy, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.writeFileSync(output, bytes); fs.fsyncSync(output); } finally { fs.closeSync(output); }
    } finally { fs.closeSync(fd); }
    const after = readStable(source), copied = readStable(copy);
    if (!same(initial.mark, after.mark) || initial.hash !== after.hash || copied.hash !== initial.hash
      || (copied.mark.dev === initial.mark.dev && copied.mark.ino === initial.mark.ino)) throw Error("Source/copy identity disagrees");
    const shape = schemaOf(copy), validated = readStable(copy);
    if (validated.hash !== copied.hash || !same(validated.mark, copied.mark)) throw Error("Stage changed during validation");
    // Open only while the newly random private location is still undisclosed. Never reopen a handle-supplied path.
    if (shape.supported) {
      stageStore = openStore(copy);
      stageStore.handle.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE");
    }
    const final = readStable(copy);
    if (final.mark.dev !== copied.mark.dev || final.mark.ino !== copied.mark.ino) throw Error("Copied stage identity replaced");
    const handle = Object.freeze({ copyPath: copy }) as RecoveryStageHandle;
    stages.set(handle, { source, sourceStamp: initial.mark, sourceDigest: initial.hash, copy, copyStamp: final.mark, copyDigest: final.hash,
      directory, directoryStamp: stamp(canonical(directory, true)), ...(stageStore === undefined ? {} : { store: stageStore }), ...shape });
    return handle;
  } catch (error) { stageStore?.close(); fs.rmSync(directory, { recursive: true, force: true }); throw error; }
}
function admitted(handle: RecoveryStageHandle): Kept {
  const kept = typeof handle === "object" && handle !== null ? stages.get(handle) : undefined;
  if (kept === undefined) throw Error("Not an internally constructed recovery stage");
  const dir = stamp(canonical(kept.directory, true));
  if (dir.dev !== kept.directoryStamp.dev || dir.ino !== kept.directoryStamp.ino) throw Error("Private stage directory replaced");
  const source = readStable(kept.source), copy = readStable(kept.copy);
  if (!same(source.mark, kept.sourceStamp) || source.hash !== kept.sourceDigest || !same(copy.mark, kept.copyStamp)
    || copy.hash !== kept.copyDigest || (copy.mark.dev === source.mark.dev && copy.mark.ino === source.mark.ino)) throw Error("Recovery stage/source changed");
  return kept;
}
function report(kept: Kept, outcome: RecoveryStageReport["outcome"], counts: ReadonlyMap<string, number> = new Map()): RecoveryStageReport {
  return { manifestVersion: 1, manifestDigest: createHash("sha256").update(JSON.stringify({ schema: SUPPORTED_SCHEMA, shape: SCHEMA_DIGEST, inventory: INVENTORY })).digest("hex"), schema: kept.schema, schemaSupported: kept.supported, complete: false, recoveryReady: false, outcome, repeated: false,
    entries: INVENTORY.map(([id, owner, storage, implemented]) => ({ id, owner, storage,
      status: outcome === "retired-partial" && implemented ? "retired" : "unsupported",
      affected: outcome === "retired-partial" && implemented ? counts.get(id) ?? 0 : null,
      remaining: outcome === "retired-partial" && implemented ? 0 : null })) };
}
const count = (store: Store, sql: string): number => Number(store.handle.prepare(sql).get()?.["n"]);
/** Retires only the bounded implemented classes on this private copy. Always incomplete; never publishes it. */
export function retireCentralRecoveryStage(handle: RecoveryStageHandle): RecoveryStageReport {
  const kept = admitted(handle);
  if (kept.report !== undefined) return structuredClone({ ...kept.report, repeated: true });
  if (!kept.supported) return report(kept, "unsupported-schema");
  let store: Store | undefined, result: RecoveryStageReport;
  try {
    store = kept.store; if (store === undefined) throw Error("Stage is closed");
    const stage = store, now = new Date(), by = "central-recovery-stage";
    result = stage.transact(() => {
      const counts = new Map<string, number>();
      counts.set("person-credentials", count(stage, "SELECT count(*) AS n FROM credential WHERE kind='person' AND revoked_at IS NULL"));
      for (const token of stage.apiTokens(null)) if (token.revokedAt === null) stage.revokeApiToken(token.id, by, now, "isolated recovery stage");
      counts.set("lead-credentials", count(stage, "SELECT count(*) AS n FROM credential WHERE kind='lead' AND revoked_at IS NULL"));
      for (const row of stage.handle.prepare("SELECT DISTINCT account FROM credential WHERE kind='lead' AND revoked_at IS NULL").all()) stage.revokeLeadCredentials(String(row["account"]), by, now);
      counts.set("coordinator-credentials", count(stage, "SELECT count(*) AS n FROM credential WHERE kind='coordinator' AND revoked_at IS NULL"));
      for (const row of stage.handle.prepare("SELECT id FROM credential WHERE kind='coordinator' AND revoked_at IS NULL").all()) {
        if (!revokeCoordinator(stage, String(row["id"]), by, now).ok) throw Error("Coordinator retirement failed");
      }
      // Already-revoked credentials can still carry restored pending proposals; retire those too.
      for (const row of stage.handle.prepare("SELECT id FROM credential WHERE kind='coordinator'").all()) stage.sweepCoordinatorProposals(now, String(row["id"]));
      counts.set("inbound-oauth", count(stage, "SELECT (SELECT count(*) FROM oauth_code)+(SELECT count(*) FROM oauth_grant)+(SELECT count(*) FROM oauth_refresh) AS n"));
      stage.handle.exec("DELETE FROM oauth_code; DELETE FROM oauth_refresh; DELETE FROM oauth_grant");
      counts.set("publication-grant-verifier", count(stage, "SELECT count(*) AS n FROM publication_grant WHERE revoked_at IS NULL"));
      for (const row of stage.handle.prepare("SELECT DISTINCT repo FROM publication_grant WHERE revoked_at IS NULL").all()) {
        if (!stage.revokePublicationGrant(String(row["repo"]), by, now)) throw Error("Publication grant retirement failed");
      }
      const sessions = stage.webSessions(null); counts.set("durable-browser-sessions", sessions.length);
      for (const session of sessions) stage.dropWebSession(session.idHash);
      if (count(stage, "SELECT count(*) AS n FROM publication_grant WHERE revoked_at IS NULL") !== 0
        || count(stage, "SELECT count(*) AS n FROM coordinator_proposal WHERE state IN ('pending','confirming')") !== 0
        || count(stage, "SELECT count(*) AS n FROM credential WHERE revoked_at IS NULL") !== 0
        || count(stage, "SELECT (SELECT count(*) FROM oauth_code)+(SELECT count(*) FROM oauth_grant)+(SELECT count(*) FROM oauth_refresh)+(SELECT count(*) FROM web_session) AS n") !== 0) throw Error("Retirement postcondition failed");
      return report(kept, "retired-partial", counts);
    });
  } catch { result = report(kept, "failed"); }
  finally { store?.close(); delete kept.store; }
  const copy = readStable(kept.copy);
  if (copy.mark.dev !== kept.copyStamp.dev || copy.mark.ino !== kept.copyStamp.ino) throw Error("Retired stage identity replaced");
  kept.copyStamp = copy.mark; kept.copyDigest = copy.hash;
  // Re-prove original and private-copy identity after retirement; failure never makes this a valid stage.
  admitted(handle);
  kept.report = structuredClone(result);
  return result;
}

/** Release an unused private connection; retain copied evidence and never remove or publish database files. */
export function closeCentralRecoveryStage(handle: RecoveryStageHandle): void {
  const kept = stages.get(handle); if (kept === undefined) throw Error("Not an internally constructed recovery stage");
  kept.store?.close(); delete kept.store;
}
