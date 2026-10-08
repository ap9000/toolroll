/**
 * Full export (v105): everything Toolroll knows, for an instance
 * operator to take away — every table of the database as JSON Lines, grouped
 * by what it's about (projects, tasks, runs, the ledger, chats, flows,
 * teammates, people, settings), an evidence pack per task, the settings kept
 * in files beside the database, a README explaining the layout, and a
 * manifest with each file's SHA-256. One folder, or the same files in a .zip.
 *
 * Secrets never leave: tables that are nothing but secrets (sessions,
 * pairing codes, nonces) are skipped, columns that hold one (password and
 * token hashes, button tokens, push keys, webhook secrets) are dropped, a
 * column whose name looks like a secret and that nobody has reviewed is
 * dropped too, and any value shaped like a key or token is replaced by
 * "[redacted]". Provider keys and file-kept secrets are never read.
 *
 * Not included: artifact bodies (logs, diffs, screenshots), which stay in
 * the evidence folder; their records (size, SHA-256) are in runs/artifact.
 */
import { createHash } from "node:crypto";
import { closeSync, constants, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import type { Store } from "./store.js";
import { SCHEMA_VERSION } from "./store.js";
import { evidencePack } from "./evidence-pack.js";
import { SECRET_PATTERNS } from "./evidence.js";
import { origin, readMonitoring } from "./monitoring-settings.js";
import { readSsoSettings } from "./sso-settings.js";
import { readEmailSettings } from "./email-settings.js";
import { SUBSCRIPTION_CAPABLE, readAuthMode } from "./keys.js";
import type { ProviderId } from "./provider.js";

export const EXPORT_FORMAT = "standing-orders/export/v1";

export type ExportFile = { path: string; data: Buffer };
export type ManifestEntry = { path: string; sha256: string; bytes: number; rows?: number };
export type ExportManifest = {
  format: typeof EXPORT_FORMAT;
  generatedAt: string;
  generatedBy: string;
  schemaVersion: number;
  files: ManifestEntry[];
  /** What was left out on purpose, so a reader knows it wasn't lost. */
  excluded: { tables: string[]; columns: string[] };
};
export type FullExport = { root: string; files: ExportFile[]; manifest: ExportManifest; tables: number; packs: number };

/** Tables that hold nothing but secrets or short-lived sign-in material, and derived search indexes. */
const SECRET_TABLES = new Set(["web_session", "ceremony_nonce", "chat_pair", "oauth_code", "oauth_refresh"]);
const DERIVED_TABLE = /^(sqlite_|memory_search)/;

/** Columns that hold a secret (or what stands in for one): never exported. */
const SECRET_COLUMNS = new Set([
  "api_token.secret_hash", "lead_credential.secret_hash", "approver.credential_hash", "coordinator_credential.credential_hash", "runner.credential_hash", "invite.token_hash",
  "flow_trigger.hook_hash", "held_session.cookie", "push_subscription.endpoint", "push_subscription.p256dh", "push_subscription.auth",
  "chat_turn.credential_key", "mate_session.credential_key", "mate_turn.credential_key", "chat_runtime.push_url", "workflow_preview.token",
  "quota.credential_fp", "oauth_grant.renew_hash", "oauth_client.source_hash",
]);

/** A column named like this holds a secret unless it is reviewed below; an unreviewed one is dropped. */
const SECRET_NAME = /hash|secret|token|passw|cookie|csrf|credential|p256dh|^auth$|key|nonce|endpoint|url/i;
/** Reviewed: named like a secret, but it isn't one (a seal, a digest, a lookup name, an address with no key). */
const REVIEWED_COLUMNS = new Set([
  "artifact.key", "budget.scope_key", "mate_thread.scope_key", "diff_comment.source_key", "chat_meta.key",
  "flow_trigger_event.key", "installation_fact.key", "mcp_idempotency.key", "memory_gap.key", "mutation.idempotency_key", "notification.dedupe_key",
  "service_cursor.key", "ledger_checkpoint.hash", "ledger_seal.hash", "merge_intent.grant_terms_hash", "plan_revision.parent_hash",
  "publication.body_hash", "publication.pr_url", "team_message.payload_hash", "team_request.payload_hash", "backend_grant.credential_scope",
]);
/** Token counts are usage, not tokens. */
const USAGE_COLUMN = /(^|_)tokens(_|$)|output_tokens/;

/** Where a table's file goes: by what it's about. Anything new lands in "other", never nowhere. */
export function categoryOf(table: string): string {
  const rules: [RegExp, string][] = [
    [/^(action_ledger|ledger_seal|ledger_checkpoint|sync_ledger)$/, "ledger"],
    [/^teammate/, "teammates"],
    [/^(flow|routine|workflow_)/, "flows"],
    [/^(chat_|mate_|team_|notification|push_)/, "chats"],
    [/^(approver|api_token|lead_credential|invite|sso_identity|coordinator_|oauth_)/, "people"],
    [/^(run|artifact|claim|worktree$|execution_slot|contest|tournament_terms|fallback_cycle|fallback_transition|held_session|session_turn|attended_authorization|criterion_review|diff_comment|proof_|review_request|repair_chain|incident|publication$|merge_|side_spend|knowledge_snapshot|learning_snapshot|skill_snapshot)/, "runs"],
    [/^(task|hold$|plan_|scope_|tool_seal|decision|external_|skill_test)/, "tasks"],
    [/^(project|approval_policy|capability|verify_command|worktree_setup|backend_grant|intake_grant|publication_grant|operating_mode|knowledge_|learning_|memory_|skill_)/, "projects"],
    [/(_config|_default|_defaults)$|^(budget|model_|provider_|installation_fact|runtime_check|monitoring_status|integration_check|quota|mode_rail|schema_version)/, "settings"],
  ];
  return rules.find(([pattern]) => pattern.test(table))?.[1] ?? "other";
}

/** Extra shapes beside the evidence scanner's: this installation's own tokens and password hashes, and bearer headers. */
const EXTRA_SHAPES: RegExp[] = [
  /\bso_[a-f0-9]{12}_[A-Za-z0-9_-]{43}/g,
  /\bsor_[a-f0-9]{12}_[A-Za-z0-9_-]{43}/g,
  /\blt_[a-f0-9]{12}_[A-Za-z0-9_-]{43}/g,
  /\bscrypt\$[^\s"',;]+/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bxapp-[A-Za-z0-9-]{10,}/g,
  /\blin_(?:api|wh)_[A-Za-z0-9]{20,}/g,
];
/** A whole private key, header to footer (or to the end of the text): it goes first, before the scanner's header-only
 * shape can take the header and leave the key's body behind. */
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const SHAPES: RegExp[] = [PRIVATE_KEY_BLOCK, ...SECRET_PATTERNS.map(({ pattern }) => new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`)), ...EXTRA_SHAPES];

/** Every key- or token-shaped run in `text` replaced by "[redacted]". */
export function redactKeyShapes(text: string): string {
  let out = text;
  for (const shape of SHAPES) out = out.replace(shape, "[redacted]");
  return out;
}

function cleanValue(value: unknown): unknown {
  if (typeof value === "string") return redactKeyShapes(value);
  if (value instanceof Uint8Array) return { base64: Buffer.from(value).toString("base64") };
  if (typeof value === "bigint") return value.toString();
  return value;
}

const fileName = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, 120) || "_";
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** The whole export, in memory: the files, the manifest and README among them. */
export function buildExport(store: Store, options: { who: string; now: Date; evidenceRoot: string; configDir: string | null }): FullExport {
  const db = store.handle;
  const stamp = options.now.toISOString().replace(/[:.]/g, "-");
  const root = `standing-orders-export-${stamp}`;
  const files: ExportFile[] = [];
  const entries: ManifestEntry[] = [];
  const add = (path: string, data: Buffer, rows?: number) => { files.push({ path, data }); entries.push({ path, sha256: sha256(data), bytes: data.length, ...(rows === undefined ? {} : { rows }) }); };
  const excludedTables: string[] = [], excludedColumns: string[] = [];

  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(one => one.name);
  let written = 0;
  for (const table of tables) {
    if (DERIVED_TABLE.test(table)) continue;
    if (SECRET_TABLES.has(table)) { excludedTables.push(table); continue; }
    const columns = (db.prepare(`PRAGMA table_info("${table.replace(/"/g, '""')}")`).all() as { name: string }[]).map(one => one.name);
    const kept = columns.filter(column => {
      const name = `${table}.${column}`;
      const secret = SECRET_COLUMNS.has(name) || (SECRET_NAME.test(column) && !USAGE_COLUMN.test(column) && !REVIEWED_COLUMNS.has(name));
      if (secret) excludedColumns.push(name);
      return !secret;
    });
    if (kept.length === 0) { excludedTables.push(table); continue; }
    const lines: string[] = [];
    const select = `SELECT ${kept.map(column => `"${column.replace(/"/g, '""')}"`).join(", ")} FROM "${table.replace(/"/g, '""')}" ORDER BY rowid`;
    let rows: Record<string, unknown>[];
    // A table without rowids keeps its own order.
    try { rows = db.prepare(select).all() as Record<string, unknown>[]; }
    catch { rows = db.prepare(select.replace(/ ORDER BY rowid$/, "")).all() as Record<string, unknown>[]; }
    for (const row of rows) {
      const clean: Record<string, unknown> = {};
      for (const column of kept) clean[column] = cleanValue(row[column]);
      lines.push(JSON.stringify(clean));
    }
    add(`${categoryOf(table)}/${table}.jsonl`, Buffer.from(lines.length === 0 ? "" : `${lines.join("\n")}\n`, "utf8"), lines.length);
    written++;
  }

  // An evidence pack per task: the task and each revision of it, their terms, approvals, runs, cost and ledger entries.
  const chain = store.ledgerChain({ full: true });
  const access = { principal: "operator" as const, repos: null, includeUnplaced: true };
  const packed = new Set<string>(), roots = new Set<string>(), names = new Set<string>();
  let packs = 0;
  for (const { id } of db.prepare("SELECT id FROM task ORDER BY created_at, id").all() as { id: string }[]) {
    if (packed.has(id)) continue;
    packed.add(id);
    const family = store.taskFamilyOf(id, null, true);
    if (family === null || roots.has(family.root.id)) continue;
    roots.add(family.root.id);
    for (const version of family.versions) packed.add(version.id);
    const pack = evidencePack(store, family.root.id, access, options.who, options.now, options.evidenceRoot, chain);
    if (pack === null) continue;
    let name = fileName(family.root.id);
    for (let n = 2; names.has(name); n++) name = `${fileName(family.root.id)}-${n}`;
    names.add(name);
    add(`evidence-packs/${name}.json`, Buffer.from(`${redactKeyShapes(JSON.stringify(pack, null, 2))}\n`, "utf8"));
    packs++;
  }

  // Settings kept in files beside the database: what they are set to, never their secrets.
  add("settings/files.json", Buffer.from(`${JSON.stringify(fileSettings(options.configDir), null, 2)}\n`, "utf8"));
  add("README.md", Buffer.from(readme(options.now, options.who), "utf8"));

  const manifest: ExportManifest = {
    format: EXPORT_FORMAT, generatedAt: options.now.toISOString(), generatedBy: options.who, schemaVersion: SCHEMA_VERSION,
    files: entries, excluded: { tables: excludedTables, columns: excludedColumns },
  };
  files.push({ path: "manifest.json", data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8") });
  return { root, files, manifest, tables: written, packs };
}

/** The settings kept in files (monitoring, sign-in, email, how each provider bills), secrets left out. */
function fileSettings(dir: string | null): Record<string, unknown> {
  const monitoring = readMonitoring(dir);
  const sso = readSsoSettings(dir);
  const email = readEmailSettings(dir);
  const billing: Record<string, string> = {};
  for (const provider of Object.keys(SUBSCRIPTION_CAPABLE)) billing[provider] = readAuthMode(provider as ProviderId);
  return {
    monitoring: {
      // A webhook or collector address may carry a key in its path or query: only where it points.
      webhook: monitoring.webhook === null ? null : { origin: origin(monitoring.webhook.url) },
      folder: monitoring.folder,
      traces: monitoring.traces === null ? null : { origin: origin(monitoring.traces.endpoint), header: monitoring.traces.header?.name ?? null },
    },
    signIn: sso === null ? null : { issuer: sso.issuer, clientId: sso.clientId, label: sso.label, scopes: sso.scopes, groupsClaim: sso.groupsClaim, rules: sso.rules, passwords: sso.passwords },
    email: email === null ? null : { host: email.host, port: email.port, secure: email.secure, user: email.user, from: email.from, imap: email.imap },
    providerBilling: billing,
  };
}

function readme(now: Date, who: string): string {
  return `# Toolroll export

Everything this installation knew on ${now.toISOString().slice(0, 16).replace("T", " ")} UTC, exported by ${who}.

## Layout

- \`manifest.json\`: every other file, with its size and SHA-256. Check a file with \`shasum -a 256 <file>\`.
- \`projects/\`: projects, their approval rules, checks, grants, knowledge, lessons and skills.
- \`tasks/\`: tasks and their versions (\`task_ref.revision_of\`), scopes and approvals (\`task_scope\`, \`scope_approval_vote\`), plans, holds and decisions.
- \`runs/\`: agent runs with usage and cost (\`run\`, \`run_spend\`), their records of artifacts, proofs, reviews and publications.
- \`ledger/\`: the action ledger (\`action_ledger\`), each entry's seal (\`ledger_seal\`) and the checkpoints (\`ledger_checkpoint\`).
- \`evidence-packs/\`: one JSON file per task: who asked, the exact terms and who approved them, runs and cost, checks, completion and its ledger entries.
- \`chats/\`: conversations with the lead and teammates, and Telegram, Slack, Discord and Teams messages and notifications.
- \`flows/\`: flows, their cards, scripts and triggers, routines and saved recipes.
- \`teammates/\`: teammates, their versions, memory, tools and turns.
- \`people/\`: accounts, API token names and invitations (no passwords or tokens).
- \`settings/\`: models, budgets, spend and permission defaults, provider readings; \`files.json\` holds the settings kept in files.
- \`other/\`: everything else the database keeps (workers, leases, queues).

Each \`.jsonl\` file is one database table: one JSON object per line, one row each. A binary value is \`{"base64": "..."}\`.

## What is left out

No password, password hash, API key, token or webhook secret is included. \`manifest.json\` lists the tables and columns
left out for that reason. Any value shaped like a key or token is replaced by \`[redacted]\`; a ledger entry changed that
way no longer matches its seal. Artifact contents (logs, diffs, screenshots) stay in the evidence folder; their records,
with sizes and SHA-256, are in \`runs/artifact.jsonl\`.
`;
}

/** Write the export as a new folder at `out` (its parent must exist; it must not). Files are readable by their owner only. */
export function writeExportFolder(out: string, exported: FullExport): void {
  mkdirSync(out, { mode: 0o700 });
  for (const file of exported.files) {
    const target = join(out, file.path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const handle = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeSync(handle, file.data); fsyncSync(handle); } finally { closeSync(handle); }
  }
}

/** The same files as one .zip (deflated, inside a folder named for the export). */
export function exportZip(exported: FullExport): Buffer {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  const at = new Date(exported.manifest.generatedAt);
  const time = (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2);
  const date = ((Math.max(1980, at.getUTCFullYear()) - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate();
  if (exported.files.length > 0xffff) throw new Error("Too many files for one .zip; export to a folder instead.");
  for (const file of exported.files) {
    const name = Buffer.from(`${exported.root}/${file.path}`, "utf8");
    const packed = deflateRawSync(file.data);
    const crc = crc32(file.data);
    if (offset + packed.length + 30 + name.length > 0xffffffff || file.data.length > 0xffffffff) throw new Error("The export is too large for one .zip; export to a folder instead.");
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(8, 8);
    head.writeUInt16LE(time, 10); head.writeUInt16LE(date, 12); head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(file.data.length, 22); head.writeUInt16LE(name.length, 26); head.writeUInt16LE(0, 28);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(0x031e, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x0800, 8); entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(time, 12); entry.writeUInt16LE(date, 14); entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20); entry.writeUInt32LE(file.data.length, 24); entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE((0o100600 << 16) >>> 0, 38); entry.writeUInt32LE(offset, 42);
    local.push(head, name, packed);
    central.push(entry, name);
    offset += head.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(exported.files.length, 8); end.writeUInt16LE(exported.files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

/** One line for the ledger and the person who asked. */
export function exportSummary(exported: FullExport): string {
  return `${exported.files.length} files · ${exported.tables} tables · ${exported.packs} evidence packs`;
}
