/**
 * `toolroll update`: a verified, drained, undoable update of an npm-installed
 * Toolroll. It reuses the desktop update engine's pieces (desktop-update.ts):
 * the SQLite admission gate that lets running work finish, the verified
 * private backup (the coding catalog's inside the same reservation), the
 * durable journal written before every irreversible step, the OS lock that
 * shows whether an updater is alive, and resume after a crash. What differs
 * is what gets swapped: a staged npm runtime instead of an app bundle.
 *
 *   verify → drain → stop and back up → rehearse → switch → restart → health
 *
 * The new release is installed from the npm registry into a Toolroll-managed
 * runtimes folder (`staged-upgrades/`, as deploy-browser stages), never over
 * the running one. npm's own signature and attestation check covers what it
 * installed, the installed bytes must be the ones downloaded and hashed, and
 * the certificate that signed their provenance must name ap9000/toolroll, its
 * publish workflow and GitHub Actions, checked by npm's own Sigstore verifier. The
 * service is stopped, and its processes seen gone, before the final backup,
 * so nothing written before the switch is lost. A failed health check puts
 * back the previous runtime, database and coding catalog on its own, keeping
 * what the new version wrote in a named copy. `--rollback` returns to the
 * previous runtime and its backups. Every update, rollback, refusal and
 * failure is a ledger entry.
 */
import { createHash, randomUUID, verify as signatureValid, X509Certificate } from "node:crypto";
import { spawnSync } from "node:child_process";
import { accessSync, chmodSync, closeSync, constants, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statfsSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { clearWords, durableJson, LINGERING_LIMIT_MS, lingeringRun, lingeringWords, settleLeftoverRecords, sqliteLock, desktopUpdateWaitingOf, stoppedWaitingWords, updateWaitingWords, verifiedDatabaseBackup, type LingeringRun, type UpdateWaiting } from "./desktop-update.js";
import { activeUpdateWork, freezeUpdateGate, installUpdateGate, removeUpdateGate, updateAdmissionPaused, updateGateOwned } from "./desktop-update-gate.js";
import { processMayBeAlive } from "./process-liveness.js";
import { assertCodingUpdateStopped, backupCodingCatalog, codingCatalogExists, releaseStaleCodingOwner, removeCodingUpdateGate, type ReleasedCodingOwner } from "./coding-update.js";
import { installLaunchdService, launchdPlist, stopLaunchdService, writeFileDurably, type SupervisorRunner } from "./daemon.js";
import { NAME } from "./names.js";
import { updateSafeSchema } from "./store.js";
import { isNewer, REGISTRY } from "./releases.js";
import { markNeverIndex } from "./never-index.js";
import { readRuntimeUpdateJournal, RUNTIME_PHASES, RUNTIME_UPDATE_STEPS, stagedStartedAt, updaterStartingOf, type RuntimeUpdateJournalRecord } from "./contracts/update-journal.js";

/** Loaded on first use (as backup.ts and store.ts do), so modules that only import this one (the console,
 * and tests that load it in a browser-like environment) never need `node:sqlite` itself. */
function sqlite(): typeof import("node:sqlite") {
  return createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
}


export const PROVENANCE_REPOSITORY = "https://github.com/ap9000/toolroll";
export const PROVENANCE_WORKFLOW = ".github/workflows/publish.yml";
export const PROVENANCE_ISSUER = "https://token.actions.githubusercontent.com";
/** How long a watch's `toolroll up` may take to exit once launchd stops it (controller-supervisor's shutdown). */
const UP_EXIT_MS = 45_000;
/** The steps a person sees, in order. */
export const UPDATE_STEPS = RUNTIME_UPDATE_STEPS;
export type UpdateStep = typeof UPDATE_STEPS[number];
export type RuntimePhase = typeof RUNTIME_PHASES[number];
export const STEP_WORDS: Record<UpdateStep, string> = {
  verifying: "Verify the package", draining: "Let running work finish", "backing-up": "Stop and back up",
  rehearsing: "Rehearse the migration", switching: "Switch to the new version", restarting: "Restart", health: "Health check",
};
export type When = "now" | "when-idle" | "at";
export type RuntimeRef = { version: string; dist: string };
/** How many release-* runtimes stay on disk: the running one and the one before it. */
export const KEEP_RUNTIMES = 2;
/** The one-off launchd job the console starts the updater as. */
export const UPDATE_JOB_LABEL = "com.toolroll.update";

/** The update's journal (`toolroll-update.json`, `.last.json` and the stage's `update.json`):
 * src/contracts/update-journal.ts. */
export type RuntimeUpdateJournal = RuntimeUpdateJournalRecord;

export type PackageRelease = { version: string; tarball: string; integrity: string; attestations: string | null };
export type UpdateSystem = {
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  release: (version: string) => Promise<PackageRelease>;
  download: (url: string) => Promise<Uint8Array>;
  attestations: (url: string) => Promise<unknown>;
  /** Installs `release` from the registry into `runtimeDir`, has npm verify its
   * registry signature and attestation there, checks the installed bytes are
   * `release.integrity`, and returns the package's dist. */
  install: (runtimeDir: string, release: PackageRelease) => Promise<string>;
  /** Opens `copy` with the runtime at `dist`, which migrates it as that build would. */
  rehearse: (dist: string, copy: string) => Promise<void>;
  /** Every `toolroll` and `standing-orders` command on PATH: each must be a link into `from` to be switched. */
  commands: (from: RuntimeRef) => string[];
  /** The background service's definition, when one runs `from`. */
  serviceUnit: (from: RuntimeRef) => string | null;
  /** Every repo's watch daemon definition that runs `from`. */
  watchUnits: (from: RuntimeRef) => string[];
  /** npm's own Sigstore verifier: the bundle's certificate chains to Sigstore, its signature is in the transparency
   * log, and the certificate names exactly this identity. */
  sigstore: (bundle: unknown, identity: { issuer: string; identity: string }) => Promise<void>;
  /** The processes the service runs now. */
  servicePids: (unit: string) => Promise<number[]>;
  /** Whether launchd has the service loaded now. */
  serviceLoaded: (unit: string) => Promise<boolean>;
  /** Unload the service; resolves once launchd no longer has it. */
  stopService: (unit: string) => Promise<void>;
  /** Load and start the service from its definition on disk. */
  restartService: (unit: string) => Promise<void>;
  processAlive: (pid: number) => boolean;
  healthy: (j: RuntimeUpdateJournal) => Promise<boolean>;
  healthTimeoutMs?: number;
  /** How long stopped service processes may take to exit. */
  exitTimeoutMs?: number;
  /** Bytes free for this user in the folder `dir` is on. */
  freeBytes?: (dir: string) => number;
  /** Fault injection for state-machine tests, never selectable by a flag. `kept-aside`: the live database was just
   * kept aside, before the backup is put back. */
  checkpoint?: (phase: RuntimePhase | "kept-aside") => void;
};

export type UpdateOutcome = { ok: boolean; phase: RuntimeUpdateJournal["phase"]; message: string; journal: RuntimeUpdateJournal | null };

const TERMINAL: readonly RuntimePhase[] = ["complete", "restored", "refused", "cancelled"];
export const runtimeUpdateTerminal = (phase: string) => TERMINAL.some(known => known === phase);
const journalFile = (stateDir: string) => join(stateDir, "toolroll-update.json");
/** The last completed update, kept apart from the journal: what `--rollback` returns from. */
const lastUpdateFile = (stateDir: string) => join(stateDir, "toolroll-update.last.json");
const cancelFile = (j: RuntimeUpdateJournal) => join(j.stageDir, "cancel-request.json");
/** An updater on its way to this update before it holds the lock: the console's job once launched (launchd may not
 * have started it yet), or a resume about to drive it. */
const startingFile = (j: RuntimeUpdateJournal) => join(j.stageDir, "updater-starting.json");
/** How long a launched or resuming updater is expected to take to start and hold the lock. */
export const UPDATER_START_MS = 2 * 60_000;
function markStarting(j: RuntimeUpdateJournal, state: "launched" | "resuming", now: Date): void {
  durableJson(startingFile(j), { id: j.id, state, at: now.toISOString() });
}
function updaterStarting(j: RuntimeUpdateJournal, now: Date): boolean {
  try {
    const mark = updaterStartingOf(JSON.parse(readFileSync(startingFile(j), "utf8")));
    if (mark === null) return false;
    const age = now.getTime() - mark.at;
    return mark.id === j.id && age >= 0 && age < UPDATER_START_MS;
  } catch { return false; }
}
const sha = (bytes: Uint8Array | string, algorithm = "sha256") => createHash(algorithm).update(bytes).digest("hex");
const fileHash = (file: string) => sha(readFileSync(file));
const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';
const codingFile = (databaseFile: string) => `${databaseFile}.coding.sqlite`;
class Refusal extends Error {}

export function readRuntimeUpdate(stateDir: string, file = journalFile(stateDir)): RuntimeUpdateJournal | null {
  if (!existsSync(file)) return null;
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error("The saved update record is not a regular file. Nothing was changed.");
  const read = readRuntimeUpdateJournal(JSON.parse(readFileSync(file, "utf8")));
  if (!read.ok) throw Error(`The saved update record is invalid. Preserve it and its backups; nothing was changed. (${read.issues.map(issue => issue.line).join("; ")})`);
  const j = read.value;
  const real = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
  if (!/^[a-f0-9-]{36}$/.test(j.id) || typeof j.stateDir !== "string" || real(j.stateDir) !== real(stateDir) || !isAbsolute(j.stageDir ?? "") || real(dirname(j.stageDir)) !== real(join(stateDir, "staged-upgrades"))) throw Error("The saved update record is invalid. Preserve it and its backups; nothing was changed.");
  return j;
}

/** The update `--rollback` returns from: the last one that completed, whatever was attempted since. */
export function lastCompletedUpdate(stateDir: string): RuntimeUpdateJournal | null {
  const kept = existsSync(lastUpdateFile(stateDir)) ? readRuntimeUpdate(stateDir, lastUpdateFile(stateDir)) : readRuntimeUpdate(stateDir);
  return kept?.kind === "update" && kept.phase === "complete" ? kept : null;
}

/** Before a new attempt replaces the saved journal: a completed update is kept as what `--rollback` returns from.
 * 0.8.0 and older never wrote `.last.json`, so the update that brought this version would otherwise be lost to the
 * first refused or failed attempt. */
function keepCompletedUpdate(stateDir: string): void {
  const saved = readRuntimeUpdate(stateDir);
  if (saved?.kind !== "update" || saved.phase !== "complete") return;
  const kept = existsSync(lastUpdateFile(stateDir)) ? readRuntimeUpdate(stateDir, lastUpdateFile(stateDir)) : null;
  if (kept && (kept.finishedAt ?? "") >= (saved.finishedAt ?? "")) return;
  durableJson(lastUpdateFile(stateDir), saved);
}

/** A null phase saves progress without changing the saved phase, including one a newer release wrote. */
function save(j: RuntimeUpdateJournal, phase: RuntimePhase | null, detail: string, now: Date): void {
  if (phase !== null) {
    if (j.phase !== phase) j.steps.push({ phase, at: now.toISOString() });
    j.phase = phase;
  }
  j.detail = detail; j.updatedAt = now.toISOString();
  if (runtimeUpdateTerminal(j.phase)) j.finishedAt = now.toISOString();
  durableJson(join(j.stageDir, "update.json"), j);
  durableJson(journalFile(j.stateDir), j);
}

/** Every update, rollback, refusal and failure. Plain SQL any build can run,
 * written after any database restore so the restore cannot erase it. */
function ledger(databaseFile: string, now: Date, actor: string, action: string, outcome: string, detail: string): void {
  // Never an empty database where the live one should be.
  if (!existsSync(databaseFile)) throw Error("The database is not in place.");
  const db = new (sqlite().DatabaseSync)(databaseFile);
  try {
    db.exec("PRAGMA busy_timeout=5000");
    db.prepare("INSERT INTO action_ledger(at,actor,repo,task_id,run_id,action,outcome,source,detail) VALUES (?,?,NULL,NULL,NULL,?,?,'policy',?)")
      .run(now.toISOString(), actor, action, outcome, detail.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 300));
  } finally { db.close(); }
}

/** Running work by name, for a refusal a person can act on. */
export function runningWorkWords(db: DatabaseSync): string | null {
  const active = activeUpdateWork(db);
  if (Object.values(active).every(n => n === 0)) return null;
  const runs = db.prepare("SELECT tr.external_id id, COALESCE(t.title, tr.external_id) title FROM run r JOIN task_ref tr ON tr.id = r.task_ref LEFT JOIN task t ON t.id = tr.external_id WHERE r.outcome IS NULL ORDER BY r.id LIMIT 3").all()
    .map(row => `${String(row["id"])} (${String(row["title"]).slice(0, 60)})`);
  const more = Number(active["runs"] ?? 0) - runs.length;
  const other = Object.entries(active).filter(([key, n]) => key !== "runs" && n > 0).map(([key, n]) => `${n} ${key === "claims" ? "claimed task" : key === "conversations" ? "chat request" : key === "sessions" ? "held session" : key === "stopping" ? "run still stopping" : key === "codingDeliveries" ? "unconfirmed coding message" : "coding session"}${n === 1 ? "" : "s"}`);
  const parts = [...(runs.length ? [`running ${runs.join(", ")}${more > 0 ? ` and ${more} more` : ""}`] : []), ...other];
  return parts.join("; ");
}

/** Sigstore's certificate extensions (Fulcio's OID registry) and subjectAltName. */
const OID = { issuerV1: "1.3.6.1.4.1.57264.1.1", repositoryV1: "1.3.6.1.4.1.57264.1.5", issuer: "1.3.6.1.4.1.57264.1.8", buildSigner: "1.3.6.1.4.1.57264.1.9", sourceRepository: "1.3.6.1.4.1.57264.1.12", subjectAltName: "2.5.29.17" } as const;

/** One DER element at `at`: its tag and where its contents start and end. */
function derAt(der: Buffer, at: number): { tag: number; start: number; end: number } {
  let length = der[at + 1] ?? 0, start = at + 2;
  if (length & 0x80) {
    const bytes = length & 0x7f;
    if (bytes < 1 || bytes > 4) throw Error("unsupported DER length");
    length = 0; for (let i = 0; i < bytes; i++) length = length * 256 + (der[start + i] ?? 0);
    start += bytes;
  }
  if (at >= der.length || start + length > der.length) throw Error("truncated DER");
  return { tag: der[at]!, start, end: start + length };
}
function derChildren(der: Buffer, parent: { start: number; end: number }): { tag: number; start: number; end: number }[] {
  const children = [];
  for (let at = parent.start; at < parent.end;) { const child = derAt(der, at); children.push(child); at = child.end; }
  return children;
}
function oidText(bytes: Buffer): string {
  const parts = [Math.floor(bytes[0]! / 40), bytes[0]! % 40];
  let n = 0;
  for (const byte of bytes.subarray(1)) { n = n * 128 + (byte & 0x7f); if (!(byte & 0x80)) { parts.push(n); n = 0; } }
  return parts.join(".");
}
/** A certificate's extensions by OID: each one's value octets. Node's X509Certificate does not expose them. */
function certificateExtensions(der: Buffer): Map<string, Buffer> {
  const tbs = derChildren(der, derAt(der, 0))[0]!;
  const found = new Map<string, Buffer>();
  const wrapper = derChildren(der, tbs).find(element => element.tag === 0xa3);
  if (!wrapper) return found;
  for (const extension of derChildren(der, derChildren(der, wrapper)[0]!)) {
    const parts = derChildren(der, extension), oid = parts[0]!, value = parts[parts.length - 1]!;
    if (oid.tag !== 0x06 || value.tag !== 0x04) throw Error("malformed extension");
    found.set(oidText(der.subarray(oid.start, oid.end)), der.subarray(value.start, value.end));
  }
  return found;
}
/** The signing certificate's own words: who asked Sigstore for it (issuer), which repository and which workflow. */
function certificateIdentity(der: Buffer): { issuer: string | null; repository: string | null; repositoryV1: string | null; signer: string | null; uris: string[] } {
  const extensions = certificateExtensions(der);
  const utf8 = (oid: string) => { const value = extensions.get(oid); if (!value) return null; const one = derAt(value, 0); if (one.tag !== 0x0c) throw Error("not a UTF8String"); return value.subarray(one.start, one.end).toString("utf8"); };
  const raw = (oid: string) => extensions.get(oid)?.toString("utf8") ?? null;
  const san = extensions.get(OID.subjectAltName);
  const uris = san ? derChildren(san, derAt(san, 0)).filter(name => name.tag === 0x86).map(name => san.subarray(name.start, name.end).toString("ascii")) : [];
  return { issuer: utf8(OID.issuer) ?? raw(OID.issuerV1), repository: utf8(OID.sourceRepository), repositoryV1: raw(OID.repositoryV1), signer: utf8(OID.buildSigner), uris };
}

export type Provenance = { repository: string; workflow: string; issuer: string; identity: string; bundle: unknown };
type AttestationBundle = { verificationMaterial?: { certificate?: { rawBytes?: string }; x509CertificateChain?: { certificates?: { rawBytes?: string }[] } }; dsseEnvelope?: { payload?: string; payloadType?: string; signatures?: { sig?: string }[] } };

/** The npm provenance for exactly these bytes of Toolroll itself must be signed by a certificate that names the
 * Toolroll repository, its publish workflow and GitHub Actions as the issuer. The statement's own claims name
 * nobody: only the certificate, whose key must have signed the statement. Sigstore's chain and transparency log are
 * then checked by npm's own verifier (UpdateSystem.sigstore) for the identity returned here. */
export function checkProvenance(attestations: unknown, version: string, sha512Hex: string): Provenance {
  const list = (attestations as { attestations?: unknown[] } | null)?.attestations;
  if (!Array.isArray(list) || list.length === 0) throw new Refusal(`Toolroll ${version} has no npm provenance, so it cannot be verified. Nothing was changed.`);
  const found = (list as { predicateType?: string; bundle?: AttestationBundle }[]).find(one => String(one?.predicateType ?? "").startsWith("https://slsa.dev/provenance/"));
  if (!found) throw new Refusal(`Toolroll ${version} has no build provenance statement. Nothing was changed.`);
  const bundle = found.bundle ?? {}, envelope = bundle.dsseEnvelope ?? {};
  let statement: { subject?: { name?: string; digest?: { sha512?: string } }[] }, certificate: X509Certificate, who: ReturnType<typeof certificateIdentity>;
  const payload = Buffer.from(String(envelope.payload ?? ""), "base64"), payloadType = String(envelope.payloadType ?? "");
  try {
    const material = bundle.verificationMaterial;
    const der = Buffer.from(String(material?.certificate?.rawBytes ?? material?.x509CertificateChain?.certificates?.[0]?.rawBytes ?? ""), "base64");
    certificate = new X509Certificate(der);
    who = certificateIdentity(der);
    statement = JSON.parse(payload.toString("utf8"));
  } catch { throw new Refusal(`Toolroll ${version}'s provenance could not be read. Nothing was changed.`); }
  // DSSE: the signature covers the pre-authentication encoding of the payload and its type.
  const signed = Buffer.concat([Buffer.from(`DSSEv1 ${Buffer.byteLength(payloadType)} ${payloadType} ${payload.length} `), payload]);
  const signatures = envelope.signatures ?? [];
  let valid = false;
  try { valid = signatures.length === 1 && typeof signatures[0]!.sig === "string" && signatureValid("sha256", signed, certificate.publicKey, Buffer.from(signatures[0]!.sig, "base64")); } catch { valid = false; }
  if (!valid) throw new Refusal(`Toolroll ${version}'s provenance is not signed by the certificate it carries. Nothing was changed.`);
  const subject = statement.subject?.find(s => s.name === `pkg:npm/${NAME}@${version}`);
  if (!subject || subject.digest?.sha512 !== sha512Hex) throw new Refusal(`Toolroll ${version}'s provenance is for different bytes than the package downloaded. Nothing was changed.`);
  const workflow = `${PROVENANCE_REPOSITORY}/${PROVENANCE_WORKFLOW}@`;
  const identity = who.uris.length === 1 ? who.uris[0]! : null;
  const repository = who.repository ?? (who.repositoryV1 === null ? null : `https://github.com/${who.repositoryV1}`);
  const named = who.issuer === PROVENANCE_ISSUER && repository === PROVENANCE_REPOSITORY
    && (who.repositoryV1 === null || `https://github.com/${who.repositoryV1}` === PROVENANCE_REPOSITORY)
    && identity !== null && identity.startsWith(workflow) && (who.signer === null || who.signer.startsWith(workflow));
  if (!named || identity === null || who.issuer === null) {
    const by = identity ?? repository ?? "an unnamed workflow";
    throw new Refusal(`Toolroll ${version} was built by ${by}${who.issuer === PROVENANCE_ISSUER ? "" : ` (signed in by ${who.issuer ?? "no issuer"})`}, not ${PROVENANCE_REPOSITORY.replace("https://github.com/", "")} (${PROVENANCE_WORKFLOW}) on GitHub Actions. Nothing was changed.`);
  }
  return { repository: PROVENANCE_REPOSITORY, workflow: PROVENANCE_WORKFLOW, issuer: who.issuer, identity, bundle };
}

/** Headlines of this version's changelog section: its bold lead phrases. */
export function releaseNotes(changelog: string, version: string): string[] {
  const lines = changelog.split("\n"); const start = lines.findIndex(line => new RegExp(`^## ${version.replaceAll(".", "\\.")}( |$)`).test(line));
  if (start < 0) return [];
  const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  const section = lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
  return [...section.matchAll(/^- \*\*(.+?)\*\*/gm)].map(m => m[1]!.replace(/\.$/, "")).slice(0, 6);
}

// ---- durable files ----------------------------------------------------------

function fsyncPath(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Every rename here: what is renamed is flushed first (a file itself, a link
 * by its directory), and the directory after, so a crash never leaves a torn
 * database, catalog or command. */
export function durableRename(temp: string, target: string): void {
  fsyncPath(lstatSync(temp).isSymbolicLink() ? dirname(temp) : temp);
  renameSync(temp, target);
  if (process.platform !== "win32") fsyncPath(dirname(target));
}

// ---- database: snapshot, rehearse, restore --------------------------------

/** How a rehearsed migration may change each saved table. An unlisted table keeps every column, its row count and
 * its last rowid (a WITHOUT ROWID table, all small, keeps the hash of its rows). `appendOnly`: every row through the
 * last one before hashes the same, in rowid order; new rows may follow. `dropped`: columns the new schema may remove
 * only when every saved value is null, or, with `carried`, when the receiving table gained exactly one receipt under
 * that destination per row holding a value, and as many non-null values per column as the dropped columns held.
 * `receives`: the only rows the table may gain are those receipts. `compacted`: rows may go only into summary rows,
 * whose `sum` grows by exactly as many. `moved`: the table may go only when every row it had (or the ones `rows`
 * counts) arrived in `into`: the rows there that `where` picks grew by exactly that many. */
const LEGACY_DESTINATION = "legacy:single-destination";
type Moved = { into: string; where: string; rows?: string };
type HistoryRule = { appendOnly?: true; dropped?: string[]; carried?: { into: string; destination: string }; receives?: string; compacted?: { into: string; sum: string }; moved?: Moved };
/** v116: every old per-app chat table into the shared chat tables, keyed by provider (chat-migration.ts). Several old
 * tables fan into one shared table; each picks out only its own rows there, so every count is checked on its own. */
const TELEGRAM_MOVES: Record<string, Moved> = {
  telegram_binding: { into: "chat_binding", where: "1" },
  telegram_pairing: { into: "chat_pair", where: "1" },
  telegram_team_chat: { into: "chat_room", where: "1" },
  // An applied update is a receipt; a pushed one still waiting is queued (one already applied was spent with it).
  telegram_update: { into: "chat_event", where: "kind = 'update' AND state = 'done'" },
  telegram_inbox: { into: "chat_event", where: "kind = 'update' AND state = 'queued'", rows: "update_id NOT IN (SELECT update_id FROM telegram_update)" },
  telegram_conversation: { into: "chat_event", where: "kind = 'message'" },
  telegram_conversation_part: { into: "chat_part", where: "1" },
  telegram_proposal_action: { into: "chat_action", where: "proposal IS NOT NULL" },
  telegram_action: { into: "chat_action", where: "decision IS NOT NULL" },
  telegram_flow_action: { into: "chat_flow_action", where: "action IN ('approve','edit','send-back')" },
  telegram_flow_confirm: { into: "chat_flow_action", where: "action IN ('yes','cancel')" },
  telegram_flow_choice: { into: "chat_flow_choice", where: "1" },
  telegram_flow_prompt: { into: "chat_flow_prompt", where: "1" },
  telegram_question_action: { into: "chat_question_action", where: "1" },
  telegram_question_prompt: { into: "chat_question_prompt", where: "1" },
  telegram_decision_message: { into: "chat_message_ref", where: "kind = 'decision'" },
  telegram_task_message: { into: "chat_message_ref", where: "kind = 'task'" },
  telegram_outbound_message: { into: "chat_message_ref", where: "kind = 'notification'" },
  telegram_note_draft: { into: "chat_note_draft", where: "1" },
  // A bot's lease and its rate-limit wait share its one runtime row.
  bridge_lease: { into: "chat_runtime", where: "lease_until IS NOT NULL" },
  telegram_retry: { into: "chat_runtime", where: "retry_at IS NOT NULL" },
  telegram_digest: { into: "chat_digest", where: "1", rows: "id = 1" },
};
const APP_TABLES = ["binding", "pair", "event", "part", "action", "progress", "runtime", "room", "meta",
  "flow_action", "flow_prompt", "flow_choice", "flow_note", "question_action", "question_prompt", "ask_action"];
export const CHAT_MOVES: Record<string, Moved> = {
  ...Object.fromEntries(Object.entries(TELEGRAM_MOVES).map(([table, move]) => [table, { ...move, where: `provider = 'telegram' AND (${move.where})` }])),
  ...Object.fromEntries(["slack", "discord", "teams"].flatMap(app => APP_TABLES.map(suffix => [`${app}_${suffix}`, { into: `chat_${suffix}`, where: `provider = '${app}'` }]))),
};
const HISTORY_RULES: Record<string, HistoryRule> = {
  ...Object.fromEntries(Object.entries(CHAT_MOVES).map(([table, moved]) => [table, { moved }])),
  action_ledger: { appendOnly: true }, ledger_seal: { appendOnly: true }, ledger_checkpoint: { appendOnly: true },
  // v114: a finished run whose process witnesses have all exited keeps one summary row in place of them.
  run_process: { compacted: { into: "run_process_summary", sum: "witnesses" } }, run_process_summary: { appendOnly: true },
  // v114: single-destination delivery columns may be dropped only once their values are legacy receipts.
  notification: { dropped: ["attempts", "last_attempt_at", "last_error", "delivered_at", "receipt", "claim_owner", "claim_expires_at"], carried: { into: "notification_delivery", destination: LEGACY_DESTINATION } },
  notification_delivery: { receives: LEGACY_DESTINATION },
};
export type TableDigest = { name: string; columns: string[]; rowid: boolean; count: number; last: number; hash?: string; summed?: number; nonNull?: Record<string, number>; carry?: number;
  received?: { count: number; nonNull: Record<string, number> }; moved?: { rows: number; found: number } };
const tableColumns = (db: DatabaseSync, name: string) => db.prepare("PRAGMA table_info(" + quote(name) + ")").all().map(r => String(r["name"]));
const plainValue = (_: string, v: unknown) => v instanceof Uint8Array ? Buffer.from(v).toString("hex") : typeof v === "bigint" ? String(v) : v;
/** Rows streamed into a sha256, never held together: through a rowid in rowid order, or a WITHOUT ROWID table whole. */
function rowsHash(db: DatabaseSync, name: string, columns: string[], through?: number): { count: number; hash: string } {
  const select = "SELECT " + (through === undefined ? "" : 'rowid AS "rowid:", ') + columns.map(quote).join(",") + " FROM " + quote(name);
  const key = () => db.prepare("SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk").all(name).map(r => quote(String(r["name"]))).join(",");
  const rows = through === undefined ? db.prepare(select + " ORDER BY " + key()).iterate() : db.prepare(select + " WHERE rowid <= ? ORDER BY rowid").iterate(through);
  const hash = createHash("sha256"); let count = 0;
  for (const row of rows) { hash.update(JSON.stringify(Object.values(row), plainValue) + "\n"); count++; }
  return { count, hash: hash.digest("hex") };
}
/** Rows under one receipt destination, and each column's non-null values among them: counted, never read. */
function receipts(db: DatabaseSync, name: string, destination: string, columns: string[]): { count: number; nonNull: Record<string, number> } {
  const r = db.prepare("SELECT count(*) AS n" + columns.map(column => ",count(" + quote(column) + ") AS " + quote(column)).join("") + " FROM " + quote(name) + " WHERE destination = ?").get(destination)!;
  return { count: Number(r["n"]), nonNull: Object.fromEntries(columns.map(column => [column, Number(r[column])])) };
}
/** The rows a moved table's rule picks out in its destination (none while there is no such table). */
const arrived = (db: DatabaseSync, move: Moved) =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(move.into) ? Number(db.prepare("SELECT count(*) AS n FROM " + quote(move.into) + " WHERE " + move.where).get()!["n"]) : 0;
const summed = (db: DatabaseSync, into: { into: string; sum: string }) =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(into.into) ? Number(db.prepare("SELECT coalesce(sum(" + quote(into.sum) + "),0) AS n FROM " + quote(into.into)).get()!["n"]) : 0;
/** Each saved table's columns, row count and last rowid; the append-only ones hashed (deploy-browser's rehearsal check).
 * Bounded: only the ledger and small tables are read row by row. */
export function historySnapshot(db: DatabaseSync): TableDigest[] {
  return db.prepare("SELECT name, wr FROM pragma_table_list WHERE schema='main' AND type IN ('table','shadow') AND name NOT LIKE 'sqlite_%' AND name <> 'schema_version' ORDER BY name").all()
    .map(row => {
      const name = String(row["name"]), rowid = row["wr"] === 0, columns = tableColumns(db, name), rule = HISTORY_RULES[name];
      if (!rowid) return { name, columns, rowid, last: 0, ...rowsHash(db, name, columns) };
      const r = db.prepare("SELECT count(*) AS n, coalesce(max(rowid),0) AS last FROM " + quote(name)).get()!;
      const t: TableDigest = { name, columns, rowid, count: Number(r["n"]), last: Number(r["last"]) };
      const droppable = columns.filter(column => rule?.dropped?.includes(column));
      if (droppable.length > 0) {
        const occupancy = db.prepare("SELECT " + droppable.map(column => "count(" + quote(column) + ") AS " + quote(column)).join(",") + " FROM " + quote(name)).get()!;
        t.nonNull = Object.fromEntries(droppable.map(column => [column, Number(occupancy[column])]));
        t.carry = Number(db.prepare("SELECT count(*) AS n FROM " + quote(name) + " WHERE " + droppable.map(column => quote(column) + " IS NOT NULL").join(" OR ")).get()!["n"]);
      }
      if (rule?.receives) t.received = receipts(db, name, rule.receives, columns.filter(column => column !== "notification" && column !== "destination"));
      if (rule?.appendOnly) t.hash = rowsHash(db, name, columns, t.last).hash;
      if (rule?.compacted) t.summed = summed(db, rule.compacted);
      if (rule?.moved) t.moved = { found: arrived(db, rule.moved),
        rows: rule.moved.rows === undefined ? t.count : Number(db.prepare("SELECT count(*) AS n FROM " + quote(name) + " WHERE " + rule.moved.rows).get()!["n"]) };
      return t;
    });
}
/** The tables whose saved history the migration changed beyond what HISTORY_RULES declares. */
export function changedHistory(db: DatabaseSync, before: TableDigest[]): string[] {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => String(r["name"])));
  // Receipts each receiving table gained, and the dropped values a carrying table owes it.
  const gained = new Map<string, { count: number; nonNull: Record<string, number> }>(), owed = new Map<string, { count: number; nonNull: Record<string, number> }>();
  for (const t of before) {
    if (t.received && tables.has(t.name)) {
      const after = receipts(db, t.name, HISTORY_RULES[t.name]!.receives!, Object.keys(t.received.nonNull));
      gained.set(t.name, { count: after.count - t.received.count, nonNull: Object.fromEntries(Object.entries(after.nonNull).map(([c, n]) => [c, n - (t.received!.nonNull[c] ?? 0)])) });
    }
    const carried = HISTORY_RULES[t.name]?.carried;
    if (carried && t.carry && tables.has(t.name)) {
      const present = new Set(tableColumns(db, t.name)), lost = t.columns.filter(c => !present.has(c) && HISTORY_RULES[t.name]!.dropped!.includes(c));
      if (lost.length > 0) owed.set(carried.into, { count: t.carry, nonNull: Object.fromEntries(lost.map(c => [c, t.nonNull![c]!])) });
    }
  }
  const accounted = (rule: HistoryRule | undefined, t: TableDigest) => {
    if (!rule?.carried) return false;
    const got = gained.get(rule.carried.into), want = owed.get(rule.carried.into);
    return got !== undefined && want !== undefined && got.count === want.count && Object.entries(want.nonNull).every(([c, n]) => got.nonNull[c] === n) && t.carry === want.count;
  };
  return before.filter(t => {
    if (!tables.has(t.name)) { const move = HISTORY_RULES[t.name]?.moved; return move === undefined || t.moved === undefined || arrived(db, move) - t.moved.found !== t.moved.rows; }
    const rule = HISTORY_RULES[t.name], present = new Set(tableColumns(db, t.name));
    if (t.columns.some(c => !present.has(c) && (!rule?.dropped?.includes(c) || (t.nonNull?.[c] !== 0 && !accounted(rule, t))))) return true;
    const columns = t.columns.filter(c => present.has(c));
    if (!t.rowid) { const after = rowsHash(db, t.name, columns); return after.count !== t.count || after.hash !== t.hash; }
    if (rule?.appendOnly) { const after = rowsHash(db, t.name, columns, t.last); return after.count !== t.count || after.hash !== t.hash; }
    const r = db.prepare("SELECT count(*) AS n, coalesce(max(rowid),0) AS last FROM " + quote(t.name)).get()!, count = Number(r["n"]), last = Number(r["last"]);
    if (rule?.compacted) return count > t.count || last > t.last || t.count - count !== summed(db, rule.compacted) - (t.summed ?? 0);
    if (rule?.receives) { const added = gained.get(t.name)?.count ?? 0; return count - t.count !== added || (added > 0 && added !== owed.get(t.name)?.count) || last < t.last; }
    return count !== t.count || last !== t.last;
  }).map(t => t.name);
}

async function rehearse(j: RuntimeUpdateJournal, system: UpdateSystem, source: string): Promise<{ tables: number; rows: number }> {
  const copy = join(j.stageDir, `rehearsal.${randomUUID()}.db`);
  copyFileSync(source, copy); chmodSync(copy, 0o600);
  try {
    let db = new (sqlite().DatabaseSync)(copy, { readOnly: true });
    // Rows already pointing nowhere before the update are the install's own; only ones the migration makes refuse.
    const orphans = (): Set<string> => new Set([...db.prepare("PRAGMA foreign_key_check").iterate()].map(row => JSON.stringify(row)));
    const before = historySnapshot(db), orphaned = orphans(); db.close();
    await system.rehearse(j.to.dist, copy);
    db = new (sqlite().DatabaseSync)(copy, { readOnly: true });
    try {
      const changed = changedHistory(db, before);
      if (changed.length > 0) throw new Refusal(`Toolroll ${j.to.version} would change saved history in ${changed.slice(0, 4).join(", ")}${changed.length > 4 ? ` and ${changed.length - 4} more` : ""}. Nothing was changed.`);
      if (db.prepare("PRAGMA integrity_check").get()?.["integrity_check"] !== "ok") throw new Refusal(`The rehearsed database failed its integrity check under ${j.to.version}. Nothing was changed.`);
      if ([...orphans()].some(row => !orphaned.has(row))) throw new Refusal(`The rehearsed database has rows pointing at missing rows under ${j.to.version}. Nothing was changed.`);
    } finally { db.close(); }
    return { tables: before.length, rows: before.reduce((n, t) => n + t.count, 0) };
  } finally { for (const suffix of ["", "-wal", "-shm"]) rmSync(copy + suffix, { force: true }); }
}

/** Put a verified backup in place of a live SQLite file. Only once the service's processes are gone. The live file
 * is replaced only by a complete copy: a copy that fails leaves it as it was. */
function restoreFile(live: string, backup: string, hash: string, what: string): void {
  if (fileHash(backup) !== hash) throw Error(`The retained ${what} backup changed. It was not put back.`);
  const temp = `${live}.${randomUUID()}.restore`;
  try {
    copyFileSync(backup, temp); chmodSync(temp, 0o600);
    for (const suffix of ["-wal", "-shm"]) rmSync(live + suffix, { force: true });
    durableRename(temp, live);
  } finally { rmSync(temp, { force: true }); }
}

type Backups = { path: string; hash: string; codingPath?: string; codingHash?: string };

/** Before anything is moved or replaced: every backup is still the one recorded, and there is room for the copy
 * kept aside and for the backups put back. */
function assertRestorable(j: RuntimeUpdateJournal, from: Backups, system: UpdateSystem): void {
  if (fileHash(from.path) !== from.hash) throw Error("The retained database backup changed. Nothing was put back; the live database is as it was.");
  if (from.codingPath && fileHash(from.codingPath) !== from.codingHash) throw Error("The retained coding catalog backup changed. Nothing was put back; the live database is as it was.");
  const size = (file: string) => { try { return statSync(file).size; } catch { return 0; } };
  const live = size(j.databaseFile) + size(`${j.databaseFile}-wal`);
  const needs = new Map<number, { dir: string; bytes: number }>();
  const need = (dir: string, bytes: number) => { const dev = statSync(dir).dev; const at = needs.get(dev) ?? { dir, bytes: 0 }; at.bytes += bytes; needs.set(dev, at); };
  need(j.stageDir, live);
  need(dirname(j.databaseFile), size(from.path) + (from.codingPath ? size(from.codingPath) : 0));
  const free = system.freeBytes ?? freeBytes;
  for (const { dir, bytes } of needs.values()) {
    const available = free(dir);
    if (available < bytes) throw Error(`${dir} has ${megabytes(available)} free and the restore needs ${megabytes(bytes)}. Nothing was put back; the live database is as it was. Free some space, then run toolroll update --resume.`);
  }
}
function freeBytes(dir: string): number {
  const fs = statfsSync(dir);
  return Number(fs.bavail) * Number(fs.bsize);
}
const megabytes = (bytes: number) => `${Math.ceil(bytes / 1_048_576)} MB`;

/** The database and, when one was backed up, the coding catalog, then this run's coding gate lifted. */
function restoreDatabase(j: RuntimeUpdateJournal, from: Backups): void {
  restoreFile(j.databaseFile, from.path, from.hash, "database");
  if (from.codingPath && from.codingHash) restoreFile(codingFile(j.databaseFile), from.codingPath, from.codingHash, "coding catalog");
  ungateCoding(j);
}

/** SQLite's own answer for a file it cannot read as a database: corrupt, or not a database at all. Anything else
 * (busy, a full disk, a permission) is not a reason to move the live database. */
function unreadableDatabase(error: unknown): boolean {
  const code = (error as { errcode?: unknown }).errcode;
  return typeof code === "number" && [11, 26].includes(code & 0xff);
}

/** The kept-aside copies a journal names, oldest first; a journal written by 0.8.1 names only its newest. */
function keptOf(j: RuntimeUpdateJournal): { path: string; unreadable: boolean }[] {
  return j.kept ?? (j.keptAside ? [{ path: j.keptAside, unreadable: j.keptAsideUnreadable === true }] : []);
}
function recordKept(j: RuntimeUpdateJournal, path: string, unreadable: boolean): void {
  j.kept = [...keptOf(j), { path, unreadable }];
  j.keptAside = path;
  if (unreadable) j.keptAsideUnreadable = true; else delete j.keptAsideUnreadable;
}

function forgetKept(j: RuntimeUpdateJournal, path: string): void {
  j.kept = keptOf(j).filter(one => one.path !== path);
  const newest = j.kept[j.kept.length - 1];
  if (newest) { j.keptAside = newest.path; if (newest.unreadable) j.keptAsideUnreadable = true; else delete j.keptAsideUnreadable; }
  else { delete j.keptAside; delete j.keptAsideUnreadable; }
}

/** A private copy of the live database before a restore replaces it: what the new version wrote is kept, and named.
 * Only a database SQLite says is corrupt or not a database is moved aside whole, with its WAL; any other failure
 * stops the restore with the live database where it was. Returns what was moved, so a failed restore moves it back. */
async function keepAside(j: RuntimeUpdateJournal): Promise<{ from: string; to: string }[]> {
  // Nothing at the live path: an earlier attempt moved it aside and stopped before putting the backup back. That
  // copy stays named in `kept`.
  if (!existsSync(j.databaseFile)) return [];
  const id = randomUUID().slice(0, 8), kept = join(j.stageDir, `orders.kept.${id}.db`);
  try {
    const db = new (sqlite().DatabaseSync)(j.databaseFile, { readOnly: true });
    try { await sqlite().backup(db, kept); } finally { db.close(); }
    chmodSync(kept, 0o600); fsyncPath(kept);
    recordKept(j, kept, false);
    return [];
  } catch (error) {
    rmSync(kept, { force: true });
    if (!unreadableDatabase(error)) throw Error(`The live database could not be copied aside before the restore (${(error as Error).message || "no reason given"}). It was left as it was, and nothing was put back.`);
  }
  const unreadable = join(j.stageDir, `orders.unreadable.${id}.db`);
  const moved: { from: string; to: string }[] = [];
  try {
    for (const suffix of ["-wal", "-shm", ""]) {
      if (!existsSync(j.databaseFile + suffix)) continue;
      durableRename(j.databaseFile + suffix, unreadable + suffix);
      moved.push({ from: j.databaseFile + suffix, to: unreadable + suffix });
    }
  } catch (error) {
    moveBack(moved);
    throw Error(`The unreadable live database could not be moved aside (${(error as Error).message}). It was left as it was, and nothing was put back.`);
  }
  recordKept(j, unreadable, true);
  return moved;
}

/** Undo keepAside's moves: the live database goes back where it was, never leaving the path empty. */
function moveBack(moved: readonly { from: string; to: string }[]): void {
  for (const one of [...moved].reverse()) if (!existsSync(one.from) && existsSync(one.to)) durableRename(one.to, one.from);
}

// ---- the service: stop, and see it gone -------------------------------------

/** The service and watch daemons this run stops, switches and restarts: once switched, the ones it switched. */
function unitsOf(j: RuntimeUpdateJournal): { main: string | null; watches: string[] } {
  return { main: j.switched?.unit?.path ?? j.service?.unit ?? null, watches: j.switched?.watches?.map(w => w.path) ?? j.watches?.map(w => w.unit) ?? [] };
}

/** The watch daemons launchd had loaded before the update: the only ones stopped and started again. One a person
 * unloaded stays unloaded (its definition is still switched, so it starts the new version when they load it). */
const loadedWatches = (j: RuntimeUpdateJournal, watches: readonly string[]) => watches.filter(unit => j.watches?.find(w => w.unit === unit)?.loaded !== false);

/** Stop the service and every loaded watch daemon, and wait until every process they ran has exited: only then may
 * a file they write be replaced. */
async function stopServices(j: RuntimeUpdateJournal, system: UpdateSystem, main: string | null, watches: readonly string[]): Promise<void> {
  if (!main && watches.length === 0) return;
  const pidsOf = async (unit: string, earlier: number[]) => [...new Set([...earlier, ...await system.servicePids(unit)])];
  if (main) j.service = { unit: main, pids: await pidsOf(main, j.service?.unit === main ? j.service.pids : []) };
  const watching: { unit: string; pids: number[]; loaded: boolean }[] = [];
  for (const unit of watches) {
    const earlier = j.watches?.find(w => w.unit === unit);
    // Recorded once, before the first stop: a resumed run must not read its own stop as the person's choice.
    const loaded = earlier ? earlier.loaded !== false : await system.serviceLoaded(unit);
    watching.push({ unit, pids: loaded ? await pidsOf(unit, earlier?.pids ?? []) : [], loaded });
  }
  if (watching.length > 0) j.watches = watching;
  save(j, null, j.detail, system.now());
  for (const unit of [main, ...loadedWatches(j, watches)]) if (unit) await system.stopService(unit);
  const pids = [...(main ? j.service!.pids : []), ...watching.flatMap(w => w.pids)];
  const deadline = system.now().getTime() + (system.exitTimeoutMs ?? 60_000);
  for (;;) {
    const alive = pids.filter(pid => system.processAlive(pid));
    if (alive.length === 0) return;
    if (system.now().getTime() >= deadline) throw Error(`The background service is still running (process ${alive.join(", ")}) after it was stopped. Nothing was replaced.`);
    await system.sleep(250);
  }
}

// ---- runtime switch: service definition and commands ----------------------

function pointLink(path: string, target: string): void {
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID().slice(0, 8)}`);
  symlinkSync(target, temp); durableRename(temp, path);
}

/** What runs the current version: its service definition and every command on PATH. */
function switchable(j: RuntimeUpdateJournal, system: UpdateSystem): { unit: string | null; watches: string[]; links: string[] } {
  const unit = system.serviceUnit(j.from), watches = system.watchUnits(j.from), links = system.commands(j.from);
  if (!unit && watches.length === 0 && links.length === 0) throw new Refusal(`No background service or toolroll command runs ${j.from.version} from ${j.from.dist}, so there is nothing to switch. Nothing was changed.`);
  const real = (path: string) => { try { return realpathSync(path); } catch { return null; } };
  const root = real(dirname(j.from.dist)) ?? dirname(j.from.dist);
  for (const link of links) {
    if (!lstatSync(link).isSymbolicLink()) throw new Refusal(`${link} is not a link Toolroll can switch (a shim or a copy), so it would keep running ${j.from.version}. Remove it or reinstall with npm, then update again. Nothing was changed.`);
    const target = real(link);
    if (target === null || !target.startsWith(root + sep)) throw new Refusal(`${link} runs a different Toolroll (${target ?? "a missing file"}), not ${j.from.version}, so it cannot be switched. Remove it, then update again. Nothing was changed.`);
    // A link is replaced by a rename beside it: its folder must take one, or the switch would stop halfway.
    try { accessSync(dirname(link), constants.W_OK); }
    catch { throw new Refusal(`${dirname(link)} cannot be written, so ${link} would keep running ${j.from.version}. Make that folder writable, then update again. Nothing was changed.`); }
  }
  for (const one of [unit, ...watches]) if (one && !readFileSync(one, "utf8").includes(j.from.dist)) throw new Refusal("The service definition does not name the current runtime. Nothing was changed.");
  return { unit, watches, links };
}

/** Every change is recorded before it is made; `revert` undoes exactly those.
 * A rollback puts the earlier database back only once the service is gone. */
async function switchRuntime(j: RuntimeUpdateJournal, system: UpdateSystem): Promise<void> {
  // A resumed switch keeps what it first recorded, so a revert still reaches the original.
  if (!j.switched) {
    const { unit, watches, links } = switchable(j, system);
    j.switched = { links: links.map(path => ({ path, previous: readlinkSync(path) })), unit: null, watches: [] };
    if (unit) { const saved = join(j.stageDir, "service.saved.plist"); writeFileDurably(saved, readFileSync(unit)); j.switched.unit = { path: unit, saved }; }
    for (const [i, path] of watches.entries()) { const saved = join(j.stageDir, `watch.${i}.saved.plist`); writeFileDurably(saved, readFileSync(path)); j.switched.watches!.push({ path, saved }); }
    save(j, "switching", `Pointing ${unit || watches.length > 0 ? "the service and " : ""}the toolroll and standing-orders commands at ${j.to.version}.`, system.now());
  }
  const { main, watches } = unitsOf(j);
  if (j.restoreFrom && !j.switched.databaseRestored) {
    await stopServices(j, system, main, watches);
    refuseWhileWatching(j, system, true);
    assertRestorable(j, j.restoreFrom, system);
    restoreDatabase(j, j.restoreFrom); gate(j);
    j.switched.databaseRestored = true; save(j, "switching", j.detail, system.now());
  }
  for (const one of [j.switched.unit, ...j.switched.watches ?? []]) if (one) writeFileDurably(one.path, readFileSync(one.saved, "utf8").replaceAll(j.from.dist, j.to.dist), 0o644);
  for (const link of j.switched.links) pointLink(link.path, join(j.to.dist, "bin.js"));
}

/** Put back every definition and command it can; one it cannot write is skipped and named, so the restore goes on. */
function revertSwitch(j: RuntimeUpdateJournal): string[] {
  const stuck: string[] = [];
  for (const one of [j.switched?.unit, ...j.switched?.watches ?? []]) {
    if (!one || !existsSync(one.saved)) continue;
    try { writeFileDurably(one.path, readFileSync(one.saved), 0o644); } catch (error) { stuck.push(`${one.path} (${(error as Error).message})`); }
  }
  for (const link of j.switched?.links ?? []) {
    try { pointLink(link.path, link.previous); } catch (error) { stuck.push(`${link.path} (${(error as Error).message})`); }
  }
  return stuck;
}

function gate(j: RuntimeUpdateJournal): void {
  const db = new (sqlite().DatabaseSync)(j.databaseFile);
  try { db.exec("PRAGMA busy_timeout=5000"); installUpdateGate(db, j.id); freezeUpdateGate(db, j.id); } finally { db.close(); }
}
/** Lift this run's admission pause, in the database and the coding catalog. A restored database has no pause of
 * its own (its backup dropped it), so the catalog's is lifted on its own. */
function ungate(j: RuntimeUpdateJournal): void {
  const db = new (sqlite().DatabaseSync)(j.databaseFile);
  try { db.exec("PRAGMA busy_timeout=5000"); if (updateGateOwned(db, j.id)) removeUpdateGate(db, j.id); else removeCodingUpdateGate(db, j.id); } finally { db.close(); }
}
function ungateCoding(j: RuntimeUpdateJournal): void {
  const db = new (sqlite().DatabaseSync)(j.databaseFile);
  try { db.exec("PRAGMA busy_timeout=5000"); removeCodingUpdateGate(db, j.id); } finally { db.close(); }
}

/** A foreground `toolroll up` holds a live watch lease; the runtime or database under it must not be replaced.
 * (A watch daemon releases its lease when it is stopped.) `restoring`: checked right before a backup is put back,
 * where a database that cannot be read has no watch on it to protect. */
function refuseWhileWatching(j: RuntimeUpdateJournal, system: UpdateSystem, restoring = false): void {
  let row: Record<string, unknown> | undefined;
  try {
    const db = new (sqlite().DatabaseSync)(j.databaseFile, { readOnly: true });
    try { row = db.prepare("SELECT runner, repo FROM watch_lease WHERE expires_at > ? LIMIT 1").get(system.now().toISOString()); } finally { db.close(); }
  } catch (error) { if (!restoring) throw error; row = undefined; }
  if (!row) return;
  const what = `toolroll up is running for ${String(row["repo"])} (${String(row["runner"])}).`;
  throw new Refusal(restoring ? `${what} The database was not put back under it; stop it first.` : `${what} Stop it first; ${j.kind === "update" ? "an update replaces the version it runs" : "a rollback replaces the database"}. Nothing was changed.`);
}

// ---- the journaled run ----------------------------------------------------

export type StartOptions = {
  stateDir: string; databaseFile: string; current: RuntimeRef; actor: string;
  version: string; when: When; at?: string | null;
  /** An older version replaces the current one only when asked for by name. */
  allowDowngrade?: boolean;
};

function nextAt(hhmm: string, now: Date): Date {
  const [h, m] = hhmm.split(":").map(Number);
  const at = new Date(now); at.setHours(h!, m!, 0, 0);
  if (at <= now) at.setDate(at.getDate() + 1);
  return at;
}

function newJournal(kind: "update" | "rollback", o: { stateDir: string; databaseFile: string; from: RuntimeRef; to: RuntimeRef; when: When; at: string | null; actor: string }, now: Date): RuntimeUpdateJournal {
  const id = randomUUID(), stageDir = join(resolve(o.stateDir), "staged-upgrades", `${kind === "update" ? "release" : "rollback"}-${o.to.version}-${id.slice(0, 8)}`);
  mkdirSync(stageDir, { recursive: true, mode: 0o700 }); chmodSync(stageDir, 0o700);
  markNeverIndex(dirname(stageDir));
  return { version: 1, id, kind, stateDir: resolve(o.stateDir), databaseFile: o.databaseFile, stageDir, from: o.from, to: o.to, when: o.when, at: o.at, actor: o.actor, phase: "scheduled", detail: "", steps: [], startedAt: now.toISOString(), updatedAt: now.toISOString() };
}

function assertNoneActive(stateDir: string): void {
  const existing = readRuntimeUpdate(stateDir);
  if (existing && !runtimeUpdateTerminal(existing.phase)) throw new Refusal(`An update to ${existing.to.version} is already ${existing.phase === "scheduled" ? "scheduled" : "under way"} (${existing.detail}) Cancel it with toolroll update --cancel, or resume it with toolroll update --resume.`);
}

/** Record an update without running it: the console's job resumes exactly this journal id. */
export function prepareRuntimeUpdate(o: StartOptions, now: Date): RuntimeUpdateJournal | { refused: string } {
  if (!/^\d+\.\d+\.\d+$/.test(o.version)) return { refused: `${o.version} is not a release version (x.y.z).` };
  if (!o.allowDowngrade && !isNewer(o.version, o.current.version)) return { refused: `Toolroll ${o.version} is not newer than ${o.current.version}. To go back to an older release, run toolroll update --version ${o.version} --allow-downgrade.` };
  try { assertNoneActive(o.stateDir); keepCompletedUpdate(o.stateDir); } catch (error) { return { refused: (error as Error).message }; }
  const at = o.when === "at" ? nextAt(o.at ?? "03:00", now).toISOString() : null;
  const j = newJournal("update", { stateDir: o.stateDir, databaseFile: o.databaseFile, from: o.current, to: { version: o.version, dist: "" }, when: o.when, at, actor: o.actor }, now);
  save(j, "scheduled", at ? `Scheduled for ${at}.` : "Starting.", now);
  if (at) ledger(j.databaseFile, now, j.actor, "toolroll update scheduled", "scheduled", `${j.from.version} → ${j.to.version} at ${at}`);
  return j;
}

/** Start an update: stage, verify, then run the journaled steps. */
export async function startRuntimeUpdate(o: StartOptions, system: UpdateSystem): Promise<UpdateOutcome> {
  if (o.version === o.current.version) return { ok: true, phase: "complete", message: `Toolroll ${o.version} is current.`, journal: null };
  const j = prepareRuntimeUpdate(o, system.now());
  if ("refused" in j) return { ok: false, phase: "refused", message: j.refused, journal: null };
  return driveRuntimeUpdate(j, system);
}

/** Return to the runtime and database backup an update replaced. */
export async function startRuntimeRollback(o: { stateDir: string; databaseFile: string; current: RuntimeRef; actor: string; when: When }, system: UpdateSystem): Promise<UpdateOutcome> {
  let last: RuntimeUpdateJournal | null;
  try { assertNoneActive(o.stateDir); keepCompletedUpdate(o.stateDir); last = lastCompletedUpdate(o.stateDir); } catch (error) { return { ok: false, phase: "refused", message: (error as Error).message, journal: null }; }
  if (!last || !last.backupPath || !last.backupHash) return { ok: false, phase: "refused", message: "There is no completed update to roll back.", journal: null };
  if (!existsSync(join(last.from.dist, "bin.js")) || !existsSync(last.backupPath) || (last.codingBackupPath && !existsSync(last.codingBackupPath))) return { ok: false, phase: "refused", message: `The previous runtime (${last.from.version}) or its backup is no longer on this machine. Nothing was changed.`, journal: null };
  const now = system.now();
  const j = newJournal("rollback", { stateDir: o.stateDir, databaseFile: o.databaseFile, from: last.to, to: last.from, when: o.when, at: null, actor: o.actor }, now);
  j.restoreFrom = { path: last.backupPath, hash: last.backupHash, updateId: last.id, ...(last.codingBackupPath && last.codingBackupHash ? { codingPath: last.codingBackupPath, codingHash: last.codingBackupHash } : {}) };
  return driveRuntimeUpdate(j, system);
}

/** Continue a saved update after a crash, where it left off. With `id` (the console's job), only that update:
 * a job never starts a fresh one, and a finished, replaced or rolled-back one is left alone. */
export async function resumeRuntimeUpdate(stateDir: string, system: UpdateSystem, id?: string): Promise<UpdateOutcome> {
  const j = readRuntimeUpdate(stateDir);
  if (id !== undefined && j?.id !== id) return { ok: true, phase: j?.phase ?? "complete", message: "The update this job was started for is no longer the saved one. Nothing was changed.", journal: j };
  if (!j || runtimeUpdateTerminal(j.phase)) return { ok: true, phase: j?.phase ?? "complete", message: "No update is in progress.", journal: j };
  markStarting(j, "resuming", system.now());
  return driveRuntimeUpdate(j, system);
}

/** A prepared update whose job could not start. */
export function abandonRuntimeUpdate(stateDir: string, id: string, why: string, now: Date): void {
  const j = readRuntimeUpdate(stateDir);
  if (j?.id === id && j.phase === "scheduled") save(j, "refused", why, now);
}

const CANCELLABLE: readonly RuntimePhase[] = ["scheduled", "verifying", "draining"];
/** `locked`: a test's seam, called once the updater's lock is held and before the journal is read again. */
export function requestRuntimeUpdateCancel(stateDir: string, now = new Date(), seams: { locked?: () => void } = {}): string {
  const j = readRuntimeUpdate(stateDir);
  if (!j || runtimeUpdateTerminal(j.phase)) return "No update is in progress.";
  const tooLate = (at: RuntimeUpdateJournal) => `The update to ${at.to.version} is past the point it can be cancelled (${at.phase}); it will finish or restore on its own.`;
  if (!CANCELLABLE.some(phase => phase === j.phase)) return tooLate(j);
  // No updater is running to see the request: cancel here, so the admission pause does not outlive it.
  const lock = sqliteLock(join(j.stageDir, "worker.sqlite"));
  if (!lock) {
    durableJson(cancelFile(j), { id: j.id, action: "cancel" });
    return `Cancelling the update to ${j.to.version}. Nothing is switched; new work resumes.`;
  }
  try {
    seams.locked?.();
    // An updater may have moved on, finished or been replaced between the first read and the lock.
    const held = readRuntimeUpdate(stateDir);
    if (!held || runtimeUpdateTerminal(held.phase)) return "No update is in progress.";
    if (held.id !== j.id) return "A different update was saved while cancelling. Nothing was cancelled.";
    if (!CANCELLABLE.some(phase => phase === held.phase)) return tooLate(held);
    durableJson(cancelFile(held), { id: held.id, action: "cancel" });
    try { ungate(held); } catch { /* no pause yet */ }
    if (held.kind === "update") rmSync(join(held.stageDir, "runtime"), { recursive: true, force: true });
    const noun = held.kind === "update" ? "update" : "rollback";
    save(held, "cancelled", `The ${noun} to ${held.to.version} was cancelled. Nothing changed; new work resumed.`, now);
    try { ledger(held.databaseFile, now, held.actor, `toolroll ${noun} cancelled`, "cancelled", `${held.from.version} → ${held.to.version}`); } catch { /* the journal still says what happened */ }
    return `Cancelled the ${noun} to ${held.to.version}. Nothing was switched; new work resumes.`;
  } finally { lock.close(); }
}
const cancelRequested = (j: RuntimeUpdateJournal) => existsSync(cancelFile(j));

async function driveRuntimeUpdate(j: RuntimeUpdateJournal, system: UpdateSystem): Promise<UpdateOutcome> {
  const lock = sqliteLock(join(j.stageDir, "worker.sqlite"), 1000);
  if (!lock) return { ok: false, phase: j.phase, message: `An updater is already working on the update to ${j.to.version}.`, journal: j };
  // What was read before the lock may be out of date: a stalled update released, or a cancel, in between.
  let saved: RuntimeUpdateJournal | null = null;
  try { saved = readRuntimeUpdate(j.stateDir); } catch { saved = null; }
  if (saved?.id === j.id) {
    if (runtimeUpdateTerminal(saved.phase)) { lock.close(); return { ok: saved.phase === "complete" || saved.phase === "cancelled", phase: saved.phase, message: saved.detail, journal: saved }; }
    Object.assign(j, saved);
  }
  // The lock now says an updater is here; the starting mark has done its job.
  rmSync(startingFile(j), { force: true });
  const at = (phase: string) => UPDATE_STEPS.findIndex(step => step === phase);
  const step = (phase: RuntimePhase, detail: string) => { save(j, phase, detail, system.now()); system.checkpoint?.(phase); };
  const noun = j.kind === "update" ? "update" : "rollback";
  const verb = j.kind === "update" ? `${j.from.version} → ${j.to.version}` : `${j.from.version} → ${j.to.version} (back)`;
  const finish = (ok: boolean, phase: RuntimePhase, message: string, action: string, outcome: string, detail: string): UpdateOutcome => {
    save(j, phase, message, system.now());
    try { ledger(j.databaseFile, system.now(), j.actor, action, outcome, detail); } catch { /* the journal still says what happened */ }
    return { ok, phase, message, journal: j };
  };
  try {
    // Scheduled: wait for the time, still cancellable.
    if (j.phase === "scheduled" && j.at) {
      while (system.now() < new Date(j.at)) {
        if (cancelRequested(j)) return finish(true, "cancelled", `The ${noun} to ${j.to.version} was cancelled before it started. Nothing changed.`, `toolroll ${noun} cancelled`, "cancelled", verb);
        await system.sleep(Math.min(60_000, new Date(j.at).getTime() - system.now().getTime()));
      }
    }
    // Resumed past the switch: the only question left is whether the new runtime is healthy.
    const resumedAt = at(j.phase);
    if (j.phase === "rolling-back" || j.phase === "needs-attention") return await restore(j, system, finish, verb, j.error ?? "An earlier attempt stopped.");
    if (resumedAt < at("switching")) {
      if (resumedAt <= at("verifying")) {
        step("verifying", j.kind === "update" ? `Downloading and verifying Toolroll ${j.to.version}.` : `Checking the previous runtime (${j.to.version}) and its backup.`);
        if (j.kind === "update") await verify(j, system);
        else if (fileHash(j.restoreFrom!.path) !== j.restoreFrom!.hash || (j.restoreFrom!.codingPath && fileHash(j.restoreFrom!.codingPath) !== j.restoreFrom!.codingHash)) throw new Refusal("The update's backup changed since it was made. Nothing was changed.");
      }
      const { unit, watches } = switchable(j, system);
      if (!unit && watches.length === 0) refuseWhileWatching(j, system);
      if (resumedAt <= at("draining")) {
        step("draining", j.when === "now" ? "Checking that no work is running, then pausing new work." : "Pausing new work and letting running work finish. Nothing is being cancelled.");
        await drain(j, system);
        if (cancelRequested(j)) { ungate(j); return finish(true, "cancelled", `The ${noun} to ${j.to.version} was cancelled. Nothing changed; new work resumed.`, `toolroll ${noun} cancelled`, "cancelled", verb); }
      }
      // The service stops before the backup, so nothing it writes afterwards can be lost by a restore.
      step("backing-up", unit || watches.length > 0 ? "Stopping the background service, then backing up the database." : "Backing up the database.");
      await stopServices(j, system, unit, watches);
      refuseWhileWatching(j, system);
      const db = new (sqlite().DatabaseSync)(j.databaseFile, { readOnly: true });
      try {
        // An older runtime killed before its close left its owner record behind: released once its processes are proved gone.
        const released = releaseStaleCodingOwner(db, [...j.service?.pids ?? [], ...(j.watches ?? []).flatMap(w => w.pids)], (pid, group) => system.processAlive(pid) || processMayBeAlive(pid, group));
        if (released !== null) {
          j.codingOwnerReleased = released;
          ledger(j.databaseFile, system.now(), j.actor, "toolroll coding owner released", "released", `${j.from.version} stopped without releasing the coding workspace; process ${released.pid}${released.nativePid === null ? "" : ` and agent ${released.nativePid}`} proved gone`);
        }
        assertCodingUpdateStopped(db);
      } finally { db.close(); }
      const backup = join(j.stageDir, existsSync(join(j.stageDir, "orders.backup.db")) ? `orders.backup.${randomUUID()}.db` : "orders.backup.db");
      // A database one or more update-safe migrations behind is backed up as it is: the rehearsal below proves the
      // migration on a copy, and the new runtime runs it. Any other schema needs the separate migration procedure.
      j.backupHash = await verifiedDatabaseBackup(j.databaseFile, backup, j.id, async () => { await codingBackup(j); }, undefined, updateSafeSchema); j.backupPath = backup;
      save(j, "backing-up", "Database and coding catalog backed up.", system.now());
      step("rehearsing", `Rehearsing ${j.to.version} on a copy of the database.`);
      j.rehearsal = await rehearse(j, system, j.restoreFrom?.path ?? j.backupPath);
    }
    if (resumedAt <= at("switching")) {
      step("switching", `Switching to ${j.to.version}.`);
      await switchRuntime(j, system);
    }
    if (resumedAt <= at("restarting")) {
      const { main, watches } = unitsOf(j);
      step("restarting", main || watches.length > 0 ? "Restarting the background service." : "No background service runs here; the commands now start the new version.");
      for (const unit of [main, ...loadedWatches(j, watches)]) if (unit) await system.restartService(unit);
    }
    step("health", `Checking that ${j.to.version} is running and healthy.`);
    const deadline = system.now().getTime() + (system.healthTimeoutMs ?? 90_000);
    let healthy = false;
    do {
      healthy = await system.healthy(j);
      if (!healthy) await system.sleep(1000);
    } while (!healthy && system.now().getTime() < deadline);
    if (!healthy) throw Error(`Toolroll ${j.to.version} did not pass its health check.`);
    ungate(j);
    const done = j.kind === "update"
      ? finish(true, "complete", `Toolroll ${j.to.version} is running. Your previous version (${j.from.version}) and its backup are kept; toolroll update --rollback returns to them.`, "toolroll updated", "complete", verb)
      : finish(true, "complete", `Back on Toolroll ${j.to.version} with the database from before the update. The records made since are kept in ${basename(j.backupPath ?? "")}.`, "toolroll rolled back", "complete", verb);
    // What --rollback returns from, kept apart from the journal a later refused or failed attempt replaces.
    // The update is done: failing to write this must never send it back through the restore below.
    try { if (j.kind === "update") durableJson(lastUpdateFile(j.stateDir), j); else rmSync(lastUpdateFile(j.stateDir), { force: true }); } catch { /* the journal still holds it until the next attempt */ }
    try { pruneRuntimes(j.stateDir, [j.to.dist, j.from.dist]); } catch { /* an old runtime left on disk is harmless */ }
    return done;
  } catch (error) {
    if ((error as { simulatedCrash?: boolean }).simulatedCrash) throw error;
    const message = error instanceof Error ? error.message : String(error);
    j.error = message.slice(0, 1500);
    if (!j.switched) {
      try { ungate(j); } catch { /* no gate yet, or the database is unreadable */ }
      // Nothing uses a refused download; the database backup is kept.
      if (j.kind === "update") rmSync(join(j.stageDir, "runtime"), { recursive: true, force: true });
      // A service and watch daemons stopped for the backup start again, unchanged.
      let restarted = "";
      for (const unit of [j.service?.unit, ...(j.watches ?? []).filter(w => w.loaded !== false).map(w => w.unit)]) {
        if (!unit) continue;
        try { await system.restartService(unit); }
        catch (again) { restarted += ` ${unit === j.service?.unit ? "The background service" : `The watch ${basename(unit, ".plist")}`} did not start again: ${(again as Error).message}`; }
      }
      const refused = error instanceof Refusal;
      return finish(false, "refused", (refused ? message : `The ${noun} stopped before anything was switched: ${message} Nothing changed; new work resumed.`) + restarted, refused ? `toolroll ${noun} refused` : `toolroll ${noun} failed`, refused ? "refused" : "failed", `${verb}: ${message}`);
    }
    return await restore(j, system, finish, verb, message);
  } finally { lock.close(); }
}

/** The coding catalog, backed up inside the database's write reservation (as the desktop update does). */
async function codingBackup(j: RuntimeUpdateJournal): Promise<void> {
  const source = codingFile(j.databaseFile);
  if (!codingCatalogExists(source)) return;
  const target = join(j.stageDir, existsSync(join(j.stageDir, "coding.backup.sqlite")) ? `coding.backup.${randomUUID()}.sqlite` : "coding.backup.sqlite");
  await backupCodingCatalog(source, target, j.id);
  j.codingBackupPath = target; j.codingBackupHash = fileHash(target);
}

type Finish = (ok: boolean, phase: RuntimePhase, message: string, action: string, outcome: string, detail: string) => UpdateOutcome;
/** Put back the previous runtime, then this run's own backups of the database and coding catalog, keeping what
 * was written since in a named copy. */
async function restore(j: RuntimeUpdateJournal, system: UpdateSystem, finish: Finish, verb: string, why: string): Promise<UpdateOutcome> {
  const noun = j.kind === "update" ? "update" : "rollback";
  try {
    save(j, "rolling-back", `${why} Restoring ${j.from.version} and the database backup.`, system.now());
    system.checkpoint?.("rolling-back");
    // The commands go back first, so a stop that fails never leaves them on the failed version.
    const stuck = revertSwitch(j);
    const { main, watches } = unitsOf(j);
    await stopServices(j, system, main, watches);
    if (!j.backupPath || !j.backupHash) throw Error("No verified backup was recorded.");
    if (!j.restoredDatabase) {
      refuseWhileWatching(j, system, true);
      const from = { path: j.backupPath, hash: j.backupHash, ...(j.codingBackupPath && j.codingBackupHash ? { codingPath: j.codingBackupPath, codingHash: j.codingBackupHash } : {}) };
      // Nothing moves until the backups are the ones recorded and there is room to put them back.
      assertRestorable(j, from, system);
      // A fresh copy before EVERY attempt that is about to replace the database, not only the first: a retry
      // after a failure earlier in the restore must not overwrite writes made since without keeping them.
      const moved = await keepAside(j); save(j, "rolling-back", j.detail, system.now());
      try {
        system.checkpoint?.("kept-aside");
        restoreDatabase(j, from);
      } catch (error) {
        // The backup did not go in: the live database comes back to its own path, and is no longer named as kept.
        if (moved.length > 0 && !existsSync(j.databaseFile)) { moveBack(moved); forgetKept(j, j.keptAside!); save(j, "rolling-back", j.detail, system.now()); }
        throw error;
      }
      j.restoredDatabase = true; save(j, "rolling-back", j.detail, system.now());
    }
    for (const unit of [main, ...loadedWatches(j, watches)]) if (unit) await system.restartService(unit);
    const copies = keptOf(j), readable = copies.filter(one => !one.unreadable).map(one => one.path), unreadable = copies.filter(one => one.unreadable).map(one => one.path);
    const kept = (unreadable.length > 0 ? ` The live database could not be read, so it was left as it was at ${unreadable.join(" and ")}.` : "") + (readable.length > 0 ? ` Anything written since the backup is kept in ${readable.join(" and ")}.` : "");
    const restored = `${why} Toolroll ${j.from.version} and its database were restored.${kept}`;
    if (stuck.length > 0) return finish(false, "needs-attention", `${restored} ${stuck.join("; ")} could not be pointed back at ${j.from.version}. Make ${stuck.length === 1 ? "its folder" : "those folders"} writable, then run toolroll update --resume.`, `toolroll ${noun} failed`, "needs attention", `${verb}: ${why} / ${stuck.join("; ")}`.slice(0, 300));
    return finish(false, "restored", restored, `toolroll ${noun} failed`, "restored", `${verb}: ${why}`.slice(0, 300));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return finish(false, "needs-attention", `${why} Restoring the previous version also failed: ${message} Run toolroll update --resume to try again; the backup is kept at ${j.backupPath ?? "(none)"}.`, `toolroll ${noun} failed`, "needs attention", `${verb}: ${why} / ${message}`.slice(0, 300));
  }
}

async function verify(j: RuntimeUpdateJournal, system: UpdateSystem): Promise<void> {
  const release = await system.release(j.to.version);
  if (release.version !== j.to.version) throw new Refusal(`The registry answered with ${release.version}, not ${j.to.version}. Nothing was changed.`);
  if (!release.attestations) throw new Refusal(`Toolroll ${j.to.version} has no npm provenance, so it cannot be verified. Nothing was changed.`);
  if (!onRegistry(release.attestations)) throw new Refusal(`Toolroll ${j.to.version}'s provenance is not served by the npm registry (${release.attestations.slice(0, 120)}). Nothing was changed.`);
  const bytes = await system.download(release.tarball);
  const sha512 = createHash("sha512").update(bytes).digest();
  if (release.integrity !== `sha512-${sha512.toString("base64")}`) throw new Refusal(`The downloaded package does not match the registry's checksum. Nothing was changed.`);
  const provenance = checkProvenance(await system.attestations(release.attestations), j.to.version, sha512.toString("hex"));
  await system.sigstore(provenance.bundle, { issuer: provenance.issuer, identity: provenance.identity });
  const runtime = join(j.stageDir, "runtime");
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  j.to.dist = await system.install(runtime, release);
  if (!j.to.dist.startsWith(runtime + sep) || !existsSync(join(j.to.dist, "bin.js"))) throw new Refusal("The staged runtime has no Toolroll command. Nothing was changed.");
  j.package = { sha512: sha512.toString("hex"), repository: provenance.repository, workflow: provenance.workflow };
  try { j.notes = releaseNotes(readFileSync(join(dirname(j.to.dist), "CHANGELOG.md"), "utf8"), j.to.version); } catch { j.notes = []; }
}

/** Served over HTTPS by the registry itself, as the package is. */
function onRegistry(url: string): boolean {
  try { const at = new URL(url), registry = new URL(REGISTRY); return at.protocol === "https:" && at.host === registry.host && !at.username && !at.password; } catch { return false; }
}

async function drain(j: RuntimeUpdateJournal, system: UpdateSystem): Promise<void> {
  const db = new (sqlite().DatabaseSync)(j.databaseFile);
  try {
    db.exec("PRAGMA busy_timeout=5000");
    if (j.when === "now") {
      const running = runningWorkWords(db);
      if (running) throw new Refusal(`Work is running: ${running}. Nothing was changed. Use When idle to wait for it.`);
      settleLeftoverRecords(db, system.now());
      const lingering = lingeringRun(db);
      if (lingering) { j.waiting = { ...lingering, since: system.now().toISOString() }; throw new Refusal(`${lingering.on}. ${clearWords(lingering)} Nothing was changed.`); }
      if (updateAdmissionPaused(db) && !updateGateOwned(db, j.id)) throw new Refusal("Another update owns the admission pause. Nothing was changed.");
      installUpdateGate(db, j.id);
      if (!freezeUpdateGate(db, j.id)) { removeUpdateGate(db, j.id); throw new Refusal(`Work started just now: ${runningWorkWords(db) ?? "a new run"}. Nothing was changed.`); }
      return;
    }
    installUpdateGate(db, j.id);
    for (;;) {
      if (cancelRequested(j)) return;
      const idle = Object.values(activeUpdateWork(db)).every(n => n === 0);
      // The same settling reconcile the background worker runs, so a leftover record it can prove never holds this up.
      if (idle) settleLeftoverRecords(db, system.now());
      const lingering = idle ? lingeringRun(db) : null;
      if (!lingering && freezeUpdateGate(db, j.id)) { delete j.waiting; return; }
      if (!lingering) delete j.waiting;
      else if (j.waiting?.run !== lingering.run || j.waiting.on !== lingering.on) j.waiting = { ...lingering, since: system.now().toISOString() };
      // Waiting longer on a finished run proves nothing more: stop, let new work resume, and say what clears it.
      if (j.waiting && system.now().getTime() - Date.parse(j.waiting.since) >= LINGERING_LIMIT_MS) throw new Refusal(stoppedWaitingWords(j.waiting));
      save(j, "draining", lingering ? `New work is paused. Waiting for run #${lingering.run}: ${lingeringWords(lingering)}` : `New work is paused. Waiting for ${runningWorkWords(db) ?? "running work"} to finish. Nothing is being cancelled.`, system.now());
      await system.sleep(2000);
    }
  } finally { db.close(); }
}

/** Keep the newest release-* runtimes (and any in `keep`), at most KEEP_RUNTIMES; deploy-browser's browser-* and
 * the rollback-* records are not this updater's to remove. */
export function pruneRuntimes(stateDir: string, keep: readonly string[]): string[] {
  const root = join(stateDir, "staged-upgrades");
  // A partial or older stage file still says when it started; one that is not JSON (or is null) falls back to the mtime.
  const started = (dir: string) => { try { const at = stagedStartedAt(JSON.parse(readFileSync(join(dir, "update.json"), "utf8"))); if (at !== null) return at; } catch { /* below */ } return statSync(dir).mtime.toISOString(); };
  const releases = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name.startsWith("release-"))
    .map(entry => join(root, entry.name)).sort((a, b) => started(b).localeCompare(started(a)));
  const kept = new Set(releases.filter(dir => keep.some(dist => dist !== "" && dist.startsWith(dir + sep))));
  for (const dir of releases) if (kept.size < KEEP_RUNTIMES) kept.add(dir);
  // A database a failed update kept aside is the only copy of what was written then: never pruned.
  const holdsKeptAside = (dir: string) => { try { return readdirSync(dir).some(name => /^orders\.(?:kept|unreadable)\./.test(name)); } catch { return true; } };
  const removed = releases.filter(dir => !kept.has(dir) && !holdsKeptAside(dir));
  for (const dir of removed) rmSync(dir, { recursive: true, force: true });
  return removed;
}

// ---- status for the console -----------------------------------------------

export type RuntimeUpdateStatus = {
  journal: RuntimeUpdateJournal | null;
  running: boolean;
  /** A completed update whose What's new card has not been dismissed. */
  whatsNew: { version: string; notes: string[] } | null;
  /** The last completed update `--rollback` returns from, whatever was attempted since. */
  lastUpdate: { from: string; to: string } | null;
};
export function runtimeUpdateStatus(stateDir: string): RuntimeUpdateStatus {
  let j: RuntimeUpdateJournal | null = null;
  try { j = readRuntimeUpdate(stateDir); } catch { j = null; }
  let running = false;
  if (j && !runtimeUpdateTerminal(j.phase)) { const lock = sqliteLock(join(j.stageDir, "worker.sqlite")); running = lock === null; lock?.close(); }
  const whatsNew = j && j.kind === "update" && j.phase === "complete" && !j.seen ? { version: j.to.version, notes: j.notes ?? [] } : null;
  let last: RuntimeUpdateJournal | null = null;
  try { last = lastCompletedUpdate(stateDir); } catch { last = null; }
  return { journal: j, running, whatsNew, lastUpdate: last ? { from: last.from.version, to: last.to.version } : null };
}
/** An update that is waiting, what on, and the one action that clears it: for `toolroll status` and the console.
 * `inTheWay` asks whether a finished run still holds it up; a stopped update whose run has since cleared says nothing. */
export type { UpdateWaiting };
export function updateWaitingOf(stateDir: string, inTheWay: (run: number) => boolean): UpdateWaiting | null {
  let j: RuntimeUpdateJournal | null;
  try { j = readRuntimeUpdate(stateDir); } catch { return null; }
  if (!j || j.kind !== "update") return null;
  const version = j.to.version;
  if (j.phase === "draining") return updateWaitingWords({ app: false, version, stopped: false, lingering: j.waiting ?? null });
  if (j.phase !== "refused" || !j.waiting || !inTheWay(j.waiting.run)) return null;
  return updateWaitingWords({ app: false, version, stopped: true, lingering: j.waiting });
}
/** An updater that ended while letting work finish (a crash, a kill, the Mac restarting) leaves new work paused with
 * nobody left to lift the pause. With no updater holding the update, the pause is lifted here and the update says it
 * stopped. Nothing was switched before the backup, so nothing else needs putting back. The background worker's
 * reconcile, `toolroll status` and the console run this. Returns what it said, or null. */
export function releaseStalledUpdate(stateDir: string, now: Date): string | null {
  let j: RuntimeUpdateJournal | null;
  try { j = readRuntimeUpdate(stateDir); } catch { return null; }
  if (!j || j.phase !== "draining") return null;
  const lock = sqliteLock(join(j.stageDir, "worker.sqlite"));
  if (!lock) return null;
  try {
    // An updater may have moved on, or a resumed one replaced it, between the first read and the lock.
    const held = readRuntimeUpdate(stateDir);
    if (!held || held.id !== j.id || held.phase !== "draining") return null;
    // A job launched or a resume under way has not taken the lock yet: it continues this update; nothing is lifted under it.
    if (updaterStarting(held, now)) return null;
    try { ungate(held); } catch { /* no pause yet, or the database is unreadable: the journal still says it stopped */ }
    if (held.kind === "update") rmSync(join(held.stageDir, "runtime"), { recursive: true, force: true });
    const noun = held.kind === "update" ? "update" : "rollback";
    const words = `The ${noun} to ${held.to.version} stopped: its updater ended before running work finished. Nothing was changed; new work resumed. Run toolroll ${noun === "update" ? "update" : "update --rollback"} to try again.`;
    save(held, "refused", words, now);
    try { ledger(held.databaseFile, now, held.actor, `toolroll ${noun} stopped`, "refused", `${held.from.version} → ${held.to.version}: the updater ended while draining`); } catch { /* the journal still says what happened */ }
    return words;
  } finally { lock.close(); }
}
/** What `toolroll status` and the console show: a stalled `toolroll update` released first, then this installation's
 * waiting update, `toolroll update`'s or the desktop app's. */
export function waitingUpdate(databaseFile: string, inTheWay: (run: number) => boolean, now: Date, desktopStates?: readonly string[]): UpdateWaiting | null {
  const stateDir = dirname(databaseFile);
  try { releaseStalledUpdate(stateDir, now); } catch { /* an unreadable record is shown as it is */ }
  return updateWaitingOf(stateDir, inTheWay) ?? desktopUpdateWaitingOf(databaseFile, inTheWay, desktopStates);
}
export function markWhatsNewSeen(stateDir: string): void {
  const j = readRuntimeUpdate(stateDir);
  if (!j || j.seen || j.phase !== "complete") return;
  j.seen = true; durableJson(journalFile(stateDir), j); durableJson(join(j.stageDir, "update.json"), j);
}

// ---- the real machine -------------------------------------------------------

type Exec = (command: string, args: string[], options?: { cwd?: string; timeout?: number; input?: string }) => { status: number | null; stdout: string; stderr: string };
const exec: Exec = (command, args, options = {}) =>
  spawnSync(command, args, { encoding: "utf8", timeout: options.timeout ?? 300_000, maxBuffer: 16 * 1024 * 1024, ...(options.cwd ? { cwd: options.cwd } : {}), ...(options.input !== undefined ? { input: options.input } : {}) });
const LABELS = ["com.toolroll.browser", "com.standing-orders.browser"];

export function currentRuntime(version: string): RuntimeRef {
  return { version, dist: dirname(fileURLToPath(import.meta.url)) };
}

async function json(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Refusal(`${url} answered ${response.status}. Nothing was changed.`);
  return response.json();
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Seams for tests: npm, node and ps (`exec`), launchctl (`run`), process liveness, and launchd's waits (`sleep`). */
export type MachineSeams = { exec?: Exec; run?: SupervisorRunner; alive?: (pid: number) => boolean; sleep?: (ms: number) => Promise<void>; execPath?: string };

/** The Sigstore verifier npm itself ships (npm install and npm audit signatures use it): no dependency of Toolroll's.
 * It checks the certificate chain, the transparency log entry and that the certificate names this identity. */
const SIGSTORE_SCRIPT = `const input = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
require(input.verifier).verify(input.bundle, { certificateIssuer: input.issuer, certificateIdentityURI: input.identity })
  .then(() => process.exit(0), error => { process.stderr.write(String(error && error.message || error)); process.exit(1); });`;

export function machineSystem(home = homedir(), env: Record<string, string | undefined> = process.env, seams: MachineSeams = {}): UpdateSystem {
  const sh = seams.exec ?? exec;
  const supervise = seams.run ?? (async (file, args, options) => (await import("./exec.js")).run(file, args, options));
  const unitFor = (from: RuntimeRef) => {
    for (const label of LABELS) {
      const unit = join(home, "Library", "LaunchAgents", `${label}.plist`);
      if (existsSync(unit) && readFileSync(unit, "utf8").includes(from.dist)) return unit;
    }
    return null;
  };
  const labelOf = (unit: string) => basename(unit, ".plist");
  const domain = `gui/${typeof process.getuid === "function" ? process.getuid() : userInfo().uid}`;
  const definition = (unit: string) => {
    const content = readFileSync(unit, "utf8");
    const logPath = content.match(/<key>StandardOutPath<\/key>\s*<string>([^<]+)<\/string>/)?.[1] ?? join(dirname(unit), `${labelOf(unit)}.log`);
    return { platform: "darwin" as const, label: labelOf(unit), unitPath: unit, unitContent: content, logPath, bin: process.execPath, entry: null };
  };
  return {
    now: () => new Date(),
    sleep: ms => new Promise(done => setTimeout(done, ms)),
    release: async version => {
      const body = await json(`${REGISTRY}/${NAME}/${version}`) as { version?: string; dist?: { tarball?: string; integrity?: string; attestations?: { url?: string } } };
      return { version: String(body.version ?? ""), tarball: String(body.dist?.tarball ?? ""), integrity: String(body.dist?.integrity ?? ""), attestations: body.dist?.attestations?.url ?? null };
    },
    download: async url => {
      if (!url.startsWith(`${REGISTRY}/`)) throw new Refusal("The package is not hosted on the npm registry. Nothing was changed.");
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Refusal(`The package download answered ${response.status}. Nothing was changed.`);
      return new Uint8Array(await response.arrayBuffer());
    },
    attestations: url => json(url),
    install: async (runtime, release) => {
      // From the registry by name, so npm's signature and attestation check covers the package itself (a local
      // tarball is not checked), and the lockfile records exactly which bytes were installed.
      writeFileSync(join(runtime, "package.json"), JSON.stringify({ name: `${NAME}-runtime`, private: true, dependencies: { [NAME]: release.version } }, null, 2));
      const registry = `--registry=${REGISTRY}/`;
      const installed = sh("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--no-color", registry], { cwd: runtime });
      if (installed.status !== 0) throw new Refusal(`npm could not install Toolroll ${release.version}: ${(installed.stderr || installed.stdout).trim().slice(-400)} Nothing was changed.`);
      let locked: { integrity?: string; resolved?: string; version?: string } | undefined;
      try { locked = (JSON.parse(readFileSync(join(runtime, "package-lock.json"), "utf8")) as { packages?: Record<string, { integrity?: string; resolved?: string; version?: string }> }).packages?.[`node_modules/${NAME}`]; } catch { locked = undefined; }
      if (locked?.version !== release.version || locked.integrity !== release.integrity || !String(locked.resolved ?? "").startsWith(`${REGISTRY}/`)) throw new Refusal(`npm installed different bytes than the verified Toolroll ${release.version}. Nothing was changed.`);
      const signatures = sh("npm", ["audit", "signatures", "--no-color", registry], { cwd: runtime });
      const output = `${signatures.stdout}\n${signatures.stderr}`;
      if (signatures.status !== 0) throw new Refusal(`npm could not verify the package signatures: ${output.trim().slice(-400)} Nothing was changed.`);
      if (!/\b[1-9]\d* packages? ha(?:s|ve) (?:a )?verified attestations?\b/.test(output)) throw new Refusal(`npm did not verify Toolroll ${release.version}'s provenance attestation. Nothing was changed.`);
      return join(runtime, "node_modules", NAME, "dist");
    },
    rehearse: async (dist, copy) => {
      const script = `import(${JSON.stringify(pathToFileURL(join(dist, "store.js")).href)}).then(m => { m.openStore(${JSON.stringify(copy)}).close(); })`;
      const done = sh(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], { timeout: 600_000 });
      if (done.status !== 0) throw new Refusal(`The new version could not open a copy of the database: ${(done.stderr || "").trim().slice(-400)} Nothing was changed.`);
    },
    commands: () => {
      const found = new Set<string>();
      for (const dir of (env["PATH"] ?? "").split(":").filter(Boolean)) {
        for (const name of [NAME, "standing-orders"]) {
          const path = join(dir, name);
          try { lstatSync(path); found.add(path); } catch { /* not here */ }
        }
      }
      return [...found];
    },
    sigstore: async (bundle, identity) => {
      const verifier = findSigstoreVerifier({
        path: env["PATH"] ?? "", execPath: seams.execPath ?? process.execPath,
        npmRoot: () => { const root = sh("npm", ["root", "--global", "--no-color"], { timeout: 30_000 }); return root.status === 0 ? root.stdout.trim() : null; },
      });
      if (!verifier) throw new Refusal("Toolroll could not find the Sigstore verifier that npm ships (npm 10 or newer), so its provenance cannot be checked. Nothing was changed.");
      const checked = sh(process.execPath, ["--no-warnings", "-e", SIGSTORE_SCRIPT], { input: JSON.stringify({ verifier, bundle, ...identity }), timeout: 120_000 });
      if (checked.status !== 0) throw new Refusal(`Sigstore did not verify Toolroll's provenance for ${identity.identity}: ${(checked.stderr || checked.stdout).trim().slice(-400)} Nothing was changed.`);
    },
    serviceUnit: from => unitFor(from),
    watchUnits: from => {
      const dir = join(home, "Library", "LaunchAgents");
      let names: string[] = [];
      try { names = readdirSync(dir); } catch { return []; }
      return names.filter(name => /^com\.(?:toolroll|standing-orders)\.watch\..+\.plist$/.test(name)).map(name => join(dir, name))
        .filter(unit => { try { return readFileSync(unit, "utf8").includes(from.dist); } catch { return false; } });
    },
    serviceLoaded: async unit => (await supervise("launchctl", ["print", `${domain}/${labelOf(unit)}`])).code === 0,
    servicePids: async unit => {
      const printed = await supervise("launchctl", ["print", `${domain}/${labelOf(unit)}`]);
      const pid = Number(printed.stdout.match(/\n\s*pid = (\d+)/)?.[1]);
      if (printed.code !== 0 || !(pid > 1)) return [];
      // Its `up` child too: the process that owns the coding catalog, so its exit is proved as well.
      const children = await supervise("pgrep", ["-P", String(pid)]);
      return [pid, ...(children.code === 0 ? children.stdout.trim().split(/\s+/).map(Number).filter(one => Number.isSafeInteger(one) && one > 1) : [])];
    },
    stopService: async unit => {
      // As long as a watch's toolroll up takes to exit.
      const stopped = await stopLaunchdService(definition(unit), supervise, { waitMs: UP_EXIT_MS, ...(seams.sleep ? { sleep: seams.sleep } : {}) });
      if (!stopped.ok) {
        // The stop disabled the label: enabled again before anything kickstarts it, or it could never start.
        await supervise("launchctl", ["enable", `${domain}/${labelOf(unit)}`]);
        throw Error(`${stopped.message}. Nothing was replaced.`);
      }
    },
    restartService: async unit => {
      const started = await installLaunchdService(definition(unit), supervise);
      if (!started.ok) throw Error(`launchctl could not start the service: ${started.message}`);
    },
    processAlive: seams.alive ?? processAlive,
    healthy: async j => {
      const version = sh(process.execPath, [join(j.to.dist, "bin.js"), "--version"], { timeout: 30_000 });
      if (version.status !== 0 || version.stdout.trim() !== j.to.version) return false;
      for (const link of j.switched?.links ?? []) { try { if (realpathSync(link.path) !== realpathSync(join(j.to.dist, "bin.js"))) return false; } catch { return false; } }
      const unit = j.switched?.unit?.path;
      if (!unit) return true;
      const printed = await supervise("launchctl", ["print", `${domain}/${labelOf(unit)}`]);
      const pid = Number(printed.stdout.match(/\n\s*pid = (\d+)/)?.[1]);
      if (!(pid > 1) || !printed.stdout.includes("state = running")) return false;
      if (!sh("/bin/ps", ["-p", String(pid), "-o", "command="]).stdout.includes(j.to.dist)) return false;
      const port = readFileSync(unit, "utf8").match(/<string>--port<\/string>\s*<string>(\d+)<\/string>/)?.[1];
      if (!port) return true;
      const answered = await fetch(`http://127.0.0.1:${port}/login`, { redirect: "manual", signal: AbortSignal.timeout(5000) }).catch(() => null);
      return answered !== null && answered.status < 500;
    },
  };
}

/** npm's own Sigstore verifier. Found from npm itself (the `npm` on PATH, then the one beside node), never only from
 * `npm root --global`: with a custom global prefix (npm's advice for permission errors) that folder holds the global
 * packages, not npm. */
export function findSigstoreVerifier(o: { path: string; execPath: string; npmRoot: () => string | null }): string | null {
  const npmPackage = (start: string): string | null => {
    for (let dir = dirname(start); dir !== dirname(dir); dir = dirname(dir)) {
      try { if ((JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string }).name === "npm") return dir; } catch { /* not the package folder yet */ }
    }
    return null;
  };
  const candidates: (() => string | null)[] = [
    ...o.path.split(":").filter(dir => isAbsolute(dir)).map(dir => () => { try { return npmPackage(realpathSync(join(dir, "npm"))); } catch { return null; } }),
    () => join(dirname(o.execPath), "..", "lib", "node_modules", "npm"),
    () => { const root = o.npmRoot(); return root && isAbsolute(root) ? join(root, "npm") : null; },
  ];
  for (const candidate of candidates) {
    const npm = candidate();
    const verifier = npm ? join(npm, "node_modules", "sigstore") : null;
    if (verifier && existsSync(join(verifier, "package.json"))) return resolve(verifier);
  }
  return null;
}

const jobUnit = (home: string) => join(home, "Library", "LaunchAgents", `${UPDATE_JOB_LABEL}.plist`);

/** The console starts the updater for one prepared journal as its own one-off
 * launchd job, so the service it restarts is not its parent. The job resumes
 * that id only; it does not run at login (no RunAtLoad: launchd starts it
 * with a kickstart) and removes its definition when it finishes. Elsewhere it
 * is a detached process. */
/** Where npm puts global commands (`npm prefix --global`/bin), or null when npm does not say. Asked without blocking:
 * the console's request handler starts the job. */
async function npmPrefixBin(run: SupervisorRunner): Promise<string | null> {
  const answered = await run("npm", ["prefix", "--global", "--no-color"], { timeoutMs: 30_000 }).catch(() => null);
  const prefix = answered?.code === 0 ? answered.stdout.trim() : "";
  return isAbsolute(prefix) ? join(prefix, "bin") : null;
}

export async function launchRuntimeUpdate(args: { databaseFile: string; id: string; dist?: string }, seams: { home?: string; run?: SupervisorRunner; platform?: NodeJS.Platform; npmBin?: () => Promise<string | null>; now?: () => Date } = {}): Promise<void> {
  const dist = args.dist ?? dirname(fileURLToPath(import.meta.url));
  const command = [process.execPath, join(dist, "bin.js"), "update", "--resume", "--id", args.id, "--db", args.databaseFile];
  const stateDir = dirname(args.databaseFile);
  // Pending until launchd starts the job and it holds the lock: nothing releases the update meanwhile.
  const saved = readRuntimeUpdate(stateDir);
  if (saved?.id === args.id && !runtimeUpdateTerminal(saved.phase)) markStarting(saved, "launched", (seams.now ?? (() => new Date()))());
  const log = join(stateDir, "toolroll-update.log");
  if ((seams.platform ?? process.platform) === "darwin") {
    const home = seams.home ?? homedir();
    const run = seams.run ?? (await import("./exec.js")).run;
    // Everywhere a toolroll command is usually linked: the job switches every one it finds on this PATH.
    const npmBin = await (seams.npmBin ?? (() => npmPrefixBin(run)))();
    const pathEnv = [...new Set([dirname(process.execPath), ...(npmBin ? [npmBin] : []), join(home, ".local", "bin"), join(home, "bin"), join(home, "Library", "pnpm"), "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":");
    const unit = launchdPlist({ label: UPDATE_JOB_LABEL, command, workingDirectory: stateDir, logPath: log, pathEnv, keepAlive: false, runAtLoad: false });
    const started = await installLaunchdService({ platform: "darwin", label: UPDATE_JOB_LABEL, bin: process.execPath, entry: join(dist, "bin.js"), logPath: log, unitPath: jobUnit(home), unitContent: unit }, run);
    if (!started.ok) throw Error(started.message);
    return;
  }
  const { spawn } = await import("node:child_process");
  const out = openSync(log, "a", 0o600);
  spawn(command[0]!, command.slice(1), { detached: true, stdio: ["ignore", out, out], cwd: stateDir }).unref();
}

/** The job's last act: its definition goes, so nothing can start it again. Only the definition for this id. */
export function retireUpdateJob(id: string, home = homedir()): void {
  const unit = jobUnit(home);
  try { if (readFileSync(unit, "utf8").includes(`<string>${id}</string>`)) rmSync(unit, { force: true }); } catch { /* none */ }
}

export const nextScheduledAt = nextAt;
