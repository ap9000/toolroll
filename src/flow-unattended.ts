/**
 * "Runs on its own": a per-flow, password-signed, expiring grant that lets the
 * cards a flow's OWN SCHEDULE adds file work that is approved without a person
 * reading each one. The flow's owner signs it (the mode ceremony and expiry
 * rules: at most MODE_MAX_DAYS); any approver revokes it with one click.
 *
 * What it covers is deliberately narrow: the build and research tasks those
 * cards file, sealed with safe permissions, the flow's fixed acceptance
 * criteria and the signed budget and daily run cap; their plans approve only
 * when unchanged (plan-auto.ts). Everything outward stays a person's: Person
 * decides zones, pull request merges, publish and deploy scripts, and sends.
 * Protected projects and paths are never covered. The grant names the very
 * schedules it covers (each one's settings digested into the signature), and
 * only their on-time firings count: Run now, a card a person moved, a schedule
 * added, changed, paused or removed, editing the flow, changing its owner, the
 * owner losing access and protecting the project all end or fall outside it. A script schedule also pins the script's
 * code (its version and content digest), the bytes of any project file it runs and, for a Node file, of every project
 * file it statically imports (the module graph Node resolves from it; an import that doesn't resolve can't be signed).
 * Imports computed at run time aren't knowable and are outside the claim. Saving the script ends the grant, and a file
 * that changed or can't be read ends it after asynchronous refresh, when the next card is sealed or its work is authorized. Each on-time firing
 * pins the code just before and just after it runs and records what it ran: its cards are covered only when that was
 * the code signed, so swapping a file for one run and restoring it before filing leaves the cards to a person.
 *
 * This module owns the terms, digest, words and transactions; the flow engine
 * asks for coverage inside its filing transaction, and plan-auto.ts seals.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type ts from "typescript-parser";
import { isProtectedWork } from "./approval-policy.js";
import type { AcceptanceCriterion } from "./contracts/scope.js";
import { dollarWords as dollars, scheduleWords, UNATTENDED_RULE_WORDS, unattendedCoverWords, unattendedEndWords, unattendedHeadWords, unattendedLimitWords, untilWords } from "./flow-unattended-words.js";
import { MODE_MAX_DAYS } from "./modes.js";
import { accountReachesSql } from "./project-access.js";
import type { FlowRow, FlowTriggerRow, Store } from "./store.js";

/** Grant history, run reservations and the last prepared script snapshots shared by UI/worker processes. Additive only. */
export const FLOW_UNATTENDED_SCHEMA = `
CREATE TABLE IF NOT EXISTS flow_script_provenance (
  repo TEXT NOT NULL, name TEXT NOT NULL, snapshot TEXT, PRIMARY KEY (repo, name)
);
CREATE TABLE IF NOT EXISTS flow_unattended_grant (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  flow            INTEGER NOT NULL,
  repo            TEXT NOT NULL,
  flow_revision   INTEGER NOT NULL,
  terms_json      TEXT NOT NULL,
  digest          TEXT NOT NULL,
  signed_by       TEXT NOT NULL,
  signed_at       TEXT NOT NULL,
  absolute_expiry TEXT NOT NULL,
  revoked_at      TEXT,
  revoked_by      TEXT,
  revoke_reason   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS flow_unattended_live ON flow_unattended_grant (flow) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS flow_unattended_digest ON flow_unattended_grant (digest);
CREATE TABLE IF NOT EXISTS flow_unattended_run (
  grant_id INTEGER NOT NULL,
  day      TEXT NOT NULL,
  task_id  TEXT NOT NULL,
  at       TEXT NOT NULL,
  PRIMARY KEY (grant_id, task_id)
);
CREATE INDEX IF NOT EXISTS flow_unattended_run_day ON flow_unattended_run (grant_id, day);
`;

/** The fixed acceptance criteria a flow's work zones file with: the same for every card, so a grant can freeze them. */
export const FLOW_ACCEPTANCE: { report: AcceptanceCriterion[]; task: AcceptanceCriterion[] } = {
  report: [{ id: "c1", statement: "The report answers the request, citing where in the repository each point comes from", how: null, evidence: ["manual-review"] }],
  task: [{ id: "c1", statement: "The requested change is made and the project's existing checks still pass", how: null, evidence: ["manual-review"] }],
};

/** The most runs a day a grant may allow. */
export const UNATTENDED_MAX_RUNS = 50;
/** The largest per-attempt budget a grant may name: $100. */
export const UNATTENDED_MAX_BUDGET_MICROUSD = 100_000_000;

/** The code a script schedule runs, as signed: the script's version and content digest, and for one that runs a project
 * file, that file's path and, sorted by path, the digest of its bytes and of every project file it statically imports. */
export type SignedScript = { provenance: 2; name: string; version: number; digest: string; file: string | null; files: { path: string; digest: string }[] };

/** One schedule a grant covers: which trigger, what sort, the digest of its settings when signed, and its name in words.
 * `script` is there exactly when the kind is "script". */
export type CoveredTrigger = { id: number; kind: "schedule" | "script" | "plane-review"; digest: string; words: string; script?: SignedScript };

export type UnattendedTerms = {
  flow: number;
  /** Saving the flow moves its revision: what was signed was this drawing. */
  flowRevision: number;
  repo: string;
  /** The signer, who must stay the flow's owner. */
  owner: string;
  /** The schedules signed for, frozen: any other trigger, or one of these changed, is not covered. */
  triggers: CoveredTrigger[];
  /** Always safe: an escalated posture is never covered. */
  permissions: "safe";
  acceptance: { report: AcceptanceCriterion[]; task: AcceptanceCriterion[] };
  perAttemptBudgetMicrousd: number | null;
  /** Filings per UTC day, reserved at filing. */
  dailyRunCap: number | null;
  absoluteExpiry: string;
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export const unattendedTermsJson = (terms: UnattendedTerms): string => canonicalJson(terms);

/** sha256 over a domain-separated canonical encoding, 32 hex like the mode digest. */
export function unattendedDigestOf(terms: UnattendedTerms): string {
  return createHash("sha256").update(`standing-orders:flow-unattended:${unattendedTermsJson(terms)}`, "utf8").digest("hex").slice(0, 32);
}

function criteria(value: unknown): AcceptanceCriterion[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: AcceptanceCriterion[] = [];
  for (const one of value) {
    if (one === null || typeof one !== "object") return null;
    const c = one as Record<string, unknown>;
    if (typeof c["id"] !== "string" || typeof c["statement"] !== "string" || c["statement"].trim() === "" || !(c["how"] === null || typeof c["how"] === "string") ||
      !Array.isArray(c["evidence"]) || !c["evidence"].every(e => typeof e === "string")) return null;
    out.push({ id: c["id"], statement: c["statement"], how: c["how"] as string | null, evidence: [...(c["evidence"] as string[])] } as AcceptanceCriterion);
  }
  return out;
}

const hex32 = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{32}$/.test(v);

/** Earlier script shapes become inactive at upgrade: the owner must sign the stricter provenance terms again. */
function signedScript(value: unknown): SignedScript | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const s = value as Record<string, unknown>, file = s["file"];
  if (s["provenance"] !== 2 || typeof s["name"] !== "string" || s["name"] === "" || !(typeof s["version"] === "number" && Number.isSafeInteger(s["version"]) && s["version"] > 0) || !hex32(s["digest"])) return null;
  if (!(file === null || (typeof file === "string" && file !== "")) || !Array.isArray(s["files"])) return null;
  const files: { path: string; digest: string }[] = [];
  for (const one of s["files"] as unknown[]) {
    if (one === null || typeof one !== "object" || Array.isArray(one)) return null;
    const f = one as Record<string, unknown>;
    if (typeof f["path"] !== "string" || f["path"] === "" || !hex32(f["digest"]) || (files.length > 0 && files.at(-1)!.path >= f["path"])) return null;
    files.push({ path: f["path"], digest: f["digest"] });
  }
  if (file === null ? files.length > 0 : !files.some(one => one.path === file)) return null;
  return { provenance: 2, name: s["name"], version: s["version"], digest: s["digest"], file, files };
}

function coveredTriggers(value: unknown): CoveredTrigger[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: CoveredTrigger[] = [];
  for (const one of value) {
    if (one === null || typeof one !== "object") return null;
    const t = one as Record<string, unknown>;
    if (!(typeof t["id"] === "number" && Number.isSafeInteger(t["id"]) && t["id"] > 0) || !(t["kind"] === "schedule" || t["kind"] === "script" || t["kind"] === "plane-review") ||
      !hex32(t["digest"]) || typeof t["words"] !== "string") return null;
    // A script schedule signed without its code (or anything else carrying one) is unreadable, never a guess.
    if (t["kind"] !== "script") { if (t["script"] !== undefined) return null; out.push({ id: t["id"], kind: t["kind"], digest: t["digest"], words: t["words"] }); continue; }
    const script = signedScript(t["script"]);
    if (script === null) return null;
    out.push({ id: t["id"], kind: "script", digest: t["digest"], words: t["words"], script });
  }
  return out;
}

/** Strict rehydration: anything unexpected is null, never a guess. */
export function unattendedTermsFromJson(json: string | null): UnattendedTerms | null {
  if (json === null) return null;
  let t: Record<string, unknown>;
  try { const parsed: unknown = JSON.parse(json); if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null; t = parsed as Record<string, unknown>; } catch { return null; }
  const int = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
  const acceptance = t["acceptance"] as Record<string, unknown> | null | undefined;
  const report = acceptance != null && typeof acceptance === "object" ? criteria(acceptance["report"]) : null;
  const task = acceptance != null && typeof acceptance === "object" ? criteria(acceptance["task"]) : null;
  const budget = t["perAttemptBudgetMicrousd"], cap = t["dailyRunCap"];
  const triggers = coveredTriggers(t["triggers"]);
  if (!int(t["flow"]) || !(typeof t["flowRevision"] === "number" && Number.isSafeInteger(t["flowRevision"])) || typeof t["repo"] !== "string" || typeof t["owner"] !== "string" ||
    triggers === null || t["permissions"] !== "safe" || report === null || task === null || !(budget === null || int(budget)) || !(cap === null || int(cap)) ||
    typeof t["absoluteExpiry"] !== "string" || Number.isNaN(Date.parse(t["absoluteExpiry"]))) return null;
  return { flow: t["flow"] as number, flowRevision: t["flowRevision"] as number, repo: t["repo"], owner: t["owner"], triggers, permissions: "safe", acceptance: { report, task },
    perAttemptBudgetMicrousd: budget as number | null, dailyRunCap: cap as number | null, absoluteExpiry: t["absoluteExpiry"] };
}

export { untilWords };

/** Every term in words: what the ceremony shows and the password signs. */
export function unattendedWords(terms: UnattendedTerms): string[] {
  return [...unattendedHeadWords(terms.owner, terms.acceptance), unattendedCoverWords(terms.triggers), ...unattendedLimitWords(terms.perAttemptBudgetMicrousd, terms.dailyRunCap), ...UNATTENDED_RULE_WORDS, unattendedEndWords(terms.absoluteExpiry)];
}

export type UnattendedGrant = { id: number; flow: number; repo: string; terms: UnattendedTerms; digest: string; signedBy: string; signedAt: string; absoluteExpiry: string };

/** SQL: whether neither project's approval rules protect anything (flow work names no paths, so any protected path
 * could be reached). An unreadable path list counts as protected. */
const unprotectedSql = (repos: string) =>
  `NOT EXISTS (SELECT 1 FROM approval_policy ug_rules WHERE ug_rules.repo IN (${repos})
                 AND (ug_rules.protect_project = 1 OR NOT json_valid(ug_rules.protected_paths) OR json_array_length(ug_rules.protected_paths) > 0))`;

/** SQL: whether the grant whose digest is `digest` still stands at `now` for work in `repo` — live, unexpired, its
 * signer an active approver who can still reach the flow's project and this one, still the owner of the very flow
 * revision signed, and neither project protected. Shared by every dispatch belt. */
export const grantStandsSql = (digest: string, now: string, repo: string) =>
  `EXISTS (SELECT 1 FROM flow_unattended_grant ug
            JOIN approver ug_signer ON ug_signer.name = ug.signed_by
            JOIN flow ug_flow ON ug_flow.id = ug.flow
           WHERE ug.digest = ${digest} AND ug.revoked_at IS NULL AND ug.absolute_expiry > ${now}
             AND ug_signer.revoked_at IS NULL AND ug_signer.role = 'approver'
             AND ${accountReachesSql("ug_signer", "ug.repo")} AND ${accountReachesSql("ug_signer", repo)}
             AND ug_flow.state = 'active' AND ug_flow.revision = ug.flow_revision AND COALESCE(ug_flow.owner, ug_flow.created_by) = ug.signed_by
             AND ${unprotectedSql(`ug.repo, ${repo}`)})`;

function readGrant(row: Record<string, unknown>): UnattendedGrant | null {
  const terms = unattendedTermsFromJson(String(row["terms_json"]));
  if (terms === null || unattendedDigestOf(terms) !== String(row["digest"])) return null;
  return { id: Number(row["id"]), flow: Number(row["flow"]), repo: String(row["repo"]), terms, digest: String(row["digest"]), signedBy: String(row["signed_by"]), signedAt: String(row["signed_at"]), absoluteExpiry: String(row["absolute_expiry"]) };
}

/** Why a grant ended, as its row and ledger line say it. A renewal's ledger line is the new signature's. */
export type UnattendedEnd = "expired" | "revoked" | "renewed" | "schedule changed" | "script changed" | "project protected" | "access changed";

/** Close a grant: the row, its ledger line, and the undispatched work it sealed or pre-authorized falls back to a person. */
function closeGrant(store: Store, row: Record<string, unknown>, by: string, reason: UnattendedEnd, now: Date): void {
  store.handle.prepare("UPDATE flow_unattended_grant SET revoked_at = ?, revoked_by = ?, revoke_reason = ? WHERE id = ? AND revoked_at IS NULL").run(now.toISOString(), by, reason, Number(row["id"]));
  if (reason !== "renewed") {
    store.recordAction({ at: now.toISOString(), actor: by, repo: String(row["repo"]), taskId: null, runId: null, source: "policy",
      action: `flow stopped running on its own: ${reason}`, outcome: reason === "expired" || reason === "revoked" ? reason : "ended", detail: `flow #${Number(row["flow"])}` });
  }
  store.withdrawGrantApprovals(String(row["digest"]), now);
}

/**
 * The one road for what ends grants from outside this module (store.ts calls it): a flow's schedule added, paused,
 * resumed or removed; a project's approval rules protecting work; an account's access or standing changing. Every live
 * grant the filter names ends now, durably, with its ledger line, and its queued approvals are withdrawn. Call inside
 * the mutation's transaction. Returns how many ended.
 */
export function endUnattendedGrants(store: Store, filter: { flow: number } | { repo: string } | { signer: string } | { script: { repo: string; name: string } }, by: string, reason: Exclude<UnattendedEnd, "expired" | "revoked" | "renewed">, now: Date): number {
  const rows = "flow" in filter ? store.handle.prepare("SELECT * FROM flow_unattended_grant WHERE flow = ? AND revoked_at IS NULL").all(filter.flow)
    : "signer" in filter ? store.handle.prepare("SELECT * FROM flow_unattended_grant WHERE signed_by = ? AND revoked_at IS NULL").all(filter.signer)
    // A script saved or removed: the grants in its project that signed a schedule running it (an unreadable one too, to be safe).
    : "script" in filter ? store.handle.prepare("SELECT * FROM flow_unattended_grant WHERE repo = ? AND revoked_at IS NULL").all(filter.script.repo).filter(row => {
        const terms = unattendedTermsFromJson(String(row["terms_json"]));
        return terms === null || terms.triggers.some(one => one.script?.name === filter.script.name);
      })
    // A project's rules reach the flows in it and the flows whose build zones work in it.
    : store.handle.prepare(`SELECT ug.* FROM flow_unattended_grant ug JOIN flow f ON f.id = ug.flow WHERE ug.revoked_at IS NULL
        AND (ug.repo = ? OR (json_valid(f.definition_json) AND EXISTS (SELECT 1 FROM json_each(f.definition_json, '$.stages') s WHERE json_extract(s.value, '$.repo') = ?)))`).all(filter.repo, filter.repo);
  for (const row of rows) closeGrant(store, row, by, reason, now);
  return rows.length;
}

/** The live grant for a flow, or null. One past its expiry is closed here, durably (like activeMode). A grant whose
 * signer is no longer an active approver, or whose flow moved on, covers nothing. */
export function activeUnattendedGrant(store: Store, flowId: number, now: Date): UnattendedGrant | null {
  const row = store.handle.prepare("SELECT * FROM flow_unattended_grant WHERE flow = ? AND revoked_at IS NULL").get(flowId);
  if (row === undefined) return null;
  if (Date.parse(String(row["absolute_expiry"])) <= now.getTime()) {
    store.transact(() => closeGrant(store, row, "the-clock", "expired", now));
    return null;
  }
  return readGrant(row);
}

/** Why the grant can't cover this flow right now (the same checks signing makes), or null. */
function coverageProblem(store: Store, flow: FlowRow, owner: string, workRepos: readonly string[]): string | null {
  if (flow.state !== "active") return "This flow is archived.";
  if (flow.owner !== owner) return `Only ${flow.owner}, who owns this flow, can let it run on its own.`;
  const account = store.accountOf(owner);
  if (account === null || account.revokedAt !== null || account.role !== "approver") return `${owner} isn't an active approver.`;
  for (const repo of new Set([flow.repo, ...workRepos])) {
    if (!store.accountCanAccess(owner, repo)) return `${owner} can't approve work in ${repo}.`;
    const rules = store.approvalRules(repo);
    // Flow work declares no paths, so any protected path could be reached: protected work is always a person's.
    if (isProtectedWork(rules, [])) return rules.protectProject ? "This project is protected: a person approves its work." : "This project protects some paths, and flow work could reach them: a person approves it.";
  }
  return null;
}

/** The projects a flow's work zones file in (a build zone may name another). */
function workReposOf(flow: FlowRow): string[] {
  try {
    const drawn = JSON.parse(flow.definitionJson) as { stages?: { kind?: unknown; repo?: unknown }[] };
    return (drawn.stages ?? []).filter(one => one.kind === "task" && typeof one.repo === "string").map(one => one.repo as string);
  } catch { return []; }
}

/** sha256 over a trigger's identity and canonical settings: what a grant freezes for each schedule it covers. */
export function triggerDigestOf(trigger: Pick<FlowTriggerRow, "id" | "flow" | "kind" | "configJson">): string | null {
  let config: unknown;
  try { config = JSON.parse(trigger.configJson); } catch { return null; }
  return createHash("sha256").update(`standing-orders:flow-unattended-trigger:${trigger.id}:${trigger.flow}:${trigger.kind}:${canonicalJson(config)}`, "utf8").digest("hex").slice(0, 32);
}

const bytesDigest = (bytes: Buffer) => createHash("sha256").update("standing-orders:flow-unattended-file:").update(bytes).digest("hex").slice(0, 32);

/** The most project files one script's code may span; a bigger module graph can't be signed. */
const MAX_SCRIPT_FILES = 500;
/** Files whose static imports are read: JavaScript and TypeScript sources. Others (JSON, addons) are pinned as bytes. */
const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

let compiler: typeof ts | null = null;
const typescript = (): typeof ts => compiler ??= createRequire(import.meta.url)("typescript-parser") as typeof ts;

/** Resolves [specifier, importing file] pairs as the Node that runs scripts does, without loading either: as `import`
 * and as `require` (a .js file's mode can depend on its syntax). Each answer is a path, "builtin", or null. */
const NODE_RESOLVER = `import { createRequire, isBuiltin } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const tried = f => { try { return f(); } catch { return null; } };
const named = to => isBuiltin(to) ? "builtin" : to.startsWith("file:") ? fileURLToPath(to) : to.startsWith("/") ? to : null;
process.stdout.write(JSON.stringify(JSON.parse(readFileSync(0, "utf8")).map(([spec, from]) => ({
  esm: tried(() => named(import.meta.resolve(spec, pathToFileURL(from).href))),
  cjs: tried(() => named(createRequire(from).resolve(spec))) }))));`;

async function resolveAsNode(pairs: readonly [string, string][]): Promise<{ esm: string | null; cjs: string | null }[] | null> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ["--preserve-symlinks", "--experimental-import-meta-resolve", "--no-warnings", "--input-type=module", "-e", NODE_RESOLVER], { stdio: ["pipe", "pipe", "ignore"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (part: string) => { output += part; if (output.length > 16 * 1024 * 1024) child.kill(); });
    child.on("error", () => resolve(null));
    child.stdin.on("error", () => {});
    child.on("close", code => {
      if (code !== 0) return resolve(null);
      try { const parsed: unknown = JSON.parse(output); resolve(Array.isArray(parsed) && parsed.length === pairs.length ? parsed : null); } catch { resolve(null); }
    });
    child.stdin.end(JSON.stringify(pairs));
  });
}

// Cache bounded graphs and parsed nodes by identity, mtimes and sizes, including resolution directories
// and package manifests. Fire-time snapshots bypass the cache and always hash bytes.
type GraphFile = { path: string; digest: string };
const graphCache = new Map<string, { files: GraphFile[]; watched: Map<string, string> }>();
const fileIdentity = (value: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }) =>
  [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(":");
async function pathIdentity(path: string): Promise<string> {
  try { return fileIdentity(await lstat(path, { bigint: true })); } catch { return "missing"; }
}
const graphNodes = new Map<string, { identity: string; digest: string; imports: string[] }>();
function lastScript(store: Store, repo: string, name: string): SignedScript | null {
  const row = store.flowScript(repo, name);
  if (row === null || row.held !== null) return null;
  if (row.file === null) return { provenance: 2, name, version: row.version, digest: row.digest, file: null, files: [] };
  const raw = store.handle.prepare("SELECT snapshot FROM flow_script_provenance WHERE repo = ? AND name = ?").get(repo, name)?.["snapshot"];
  try {
    const saved = typeof raw === "string" ? signedScript(JSON.parse(raw)) : null;
    return saved?.version === row.version && saved.digest === row.digest ? saved : null;
  } catch { return null; }
}

const inside = (base: string, full: string) => { const path = relative(base, full); return path !== "" && path !== ".." && !path.startsWith("../") && !isAbsolute(path) ? path : null; };

/** Resolve only literal dependencies, without evaluating the script. Computed imports remain outside the claim. */
async function nodeModuleGraphOf(base: string, entry: string, fresh: boolean): Promise<{ path: string; digest: string }[] | null> {
  const cached = graphCache.get(entry);
  if (!fresh && cached && (await Promise.all([...cached.watched].map(async ([path, identity]) => await pathIdentity(path) === identity))).every(Boolean)) return cached.files;
  const watched = new Map<string, string>();
  const watch = async (path: string) => { if (!watched.has(path)) watched.set(path, await pathIdentity(path)); };
  const watchResolution = async (file: string) => {
    await watch(file);
    for (let folder = dirname(file); folder === base || inside(base, folder) !== null; folder = dirname(folder)) {
      await watch(folder);
      await watch(join(folder, "package.json"));
      await watch(join(folder, "node_modules"));
    }
  };
  const pinned = new Map<string, string>();
  for (let layer = [entry]; layer.length > 0;) {
    const pairs: [string, string][] = [];
    for (const file of layer) {
      await watchResolution(file);
      const metadata = await stat(file, { bigint: true });
      const identity = fileIdentity(metadata);
      let node = graphNodes.get(file);
      if (fresh || node?.identity !== identity) {
        const bytes = await readFile(file);
        const imports = SOURCE_FILE.test(file) ? typescript().preProcessFile(bytes.toString("utf8"), true, true).importedFiles.map(one => one.fileName) : [];
        if (SOURCE_FILE.test(file)) {
          const source = typescript().createSourceFile(file, bytes.toString("utf8"), typescript().ScriptTarget.Latest, true);
          const visit = (child: ts.Node): void => {
            if (typescript().isCallExpression(child) && typescript().isCallExpression(child.expression) &&
                /(?:^|\.)createRequire$/.test(child.expression.expression.getText(source))) {
              const arg = child.arguments[0];
              if (arg && typescript().isStringLiteralLike(arg)) imports.push(arg.text);
            }
            typescript().forEachChild(child, visit);
          };
          visit(source);
        }
        node = { identity, digest: bytesDigest(bytes), imports };
        graphNodes.delete(file); graphNodes.set(file, node);
        if (graphNodes.size > MAX_SCRIPT_FILES) graphNodes.delete(graphNodes.keys().next().value!);
      }
      pinned.set(file, node.digest);
      for (const spec of node.imports) pairs.push([spec, file]);
    }
    if (pinned.size > MAX_SCRIPT_FILES) return null;
    const answers = pairs.length === 0 ? [] : await resolveAsNode(pairs);
    if (answers === null) return null;
    const next = new Set<string>();
    for (const [index, { esm, cjs }] of answers.entries()) {
      const [spec, from] = pairs[index]!;
      // Node may have already canonicalized a relative symlink. Check its lexical target too.
      if (spec.startsWith(".")) {
        const lexical = resolve(dirname(from), spec);
        await watchResolution(lexical);
        try { if (inside(base, lexical) !== null && inside(base, await realpath(lexical)) === null) return null; } catch { /* resolver below decides */ }
      }
      let found = false;
      for (const one of new Set([esm, cjs])) {
        if (one === "builtin") { found = true; continue; }
        if (one === null) continue;
        await watchResolution(one);
        let full: string;
        try { if (!(await stat(one)).isFile()) continue; full = await realpath(one); } catch { continue; }
        found = true;
        // A project dependency that escapes through a symlink is unsafe, never silently omitted.
        if (inside(base, full) === null) { if (inside(base, one) !== null) return null; continue; }
        if (!pinned.has(full)) next.add(full);
      }
      if (!found) return null;
    }
    layer = [...next];
  }
  const files = [...pinned].map(([full, digest]) => ({ path: inside(base, full)!, digest })).sort((a, b) => a.path < b.path ? -1 : 1);
  if (!(await Promise.all([...watched].map(async ([path, identity]) => await pathIdentity(path) === identity))).every(Boolean)) return null;
  graphCache.delete(entry); graphCache.set(entry, { files, watched });
  if (graphCache.size > 32) graphCache.delete(graphCache.keys().next().value!);
  return files;
}

/** Asynchronous preparation, never called from filing transactions or page rendering. */
export async function scriptProvenanceOf(store: Store, repo: string, name: string, fresh = true): Promise<SignedScript | null> {
  const script = store.flowScript(repo, name);
  let result: SignedScript | null = null;
  try {
    if (script !== null && script.held === null) {
      if (script.file === null) result = { provenance: 2, name, version: script.version, digest: script.digest, file: null, files: [] };
      else if (!isAbsolute(script.file) && !script.file.split(/[\\/]/).includes("..")) {
        const base = await realpath(repo), lexical = join(base, script.file), full = await realpath(lexical);
        if (!(await lstat(lexical)).isSymbolicLink() && full === lexical && inside(base, full) !== null && (await stat(full)).isFile()) {
          const files = script.language === "node" ? await nodeModuleGraphOf(base, full, fresh) : [{ path: script.file, digest: bytesDigest(await readFile(full)) }];
          if (files !== null) result = { provenance: 2, name, version: script.version, digest: script.digest, file: script.file, files };
        }
      }
    }
  } catch { result = null; }
  store.handle.prepare("INSERT INTO flow_script_provenance (repo, name, snapshot) VALUES (?, ?, ?) ON CONFLICT(repo, name) DO UPDATE SET snapshot = excluded.snapshot").run(repo, name, result === null ? null : JSON.stringify(result));
  return result;
}

export async function prepareUnattendedCandidates(store: Store, flowId: number): Promise<void> {
  const flow = store.getFlow(flowId);
  if (flow === null) return;
  for (const trigger of store.flowTriggers(flowId)) {
    if (trigger.kind !== "schedule" || trigger.state !== "active") continue;
    try { const config = JSON.parse(trigger.configJson); if (typeof config.script === "string") await scriptProvenanceOf(store, flow.repo, config.script, false); } catch { /* invalid schedule isn't offered */ }
  }
}

/** What an on-time script firing ran, as its firing records it: a digest of the code pinned just before and just after
 * the run, when both were the same and were the script row that ran; else null (it can't have run the code signed). */
export function scriptRanDigestOf(before: SignedScript | null, after: SignedScript | null, ran: { version: number; digest: string }): string | null {
  if (before === null || after === null || canonicalJson(before) !== canonicalJson(after) || before.version !== ran.version || before.digest !== ran.digest) return null;
  return ranDigestOf(before);
}
const ranDigestOf = (script: SignedScript) => createHash("sha256").update(`standing-orders:flow-unattended-script-ran:${canonicalJson(script)}`, "utf8").digest("hex").slice(0, 32);

/** Whether `flowId`'s live grant signed `triggerId`'s script: only then does a firing pin the code it runs. */
export function grantSignsScriptOf(store: Store, flowId: number, triggerId: number, now: Date): boolean {
  const trigger = store.getFlowTrigger(triggerId), flow = store.getFlow(flowId);
  const grant = activeUnattendedGrant(store, flowId, now);
  return trigger !== null && trigger.state === "active" && flow !== null && grant !== null &&
    flow.revision === grant.terms.flowRevision && coverageProblem(store, flow, grant.signedBy, [flow.repo]) === null &&
    grant.terms.triggers.some(one => one.id === triggerId && one.kind === "script" && one.digest === triggerDigestOf(trigger));
}

/** Whether each script schedule the grant signed would still run the very code signed. */
function scriptsUnchanged(store: Store, terms: UnattendedTerms): boolean {
  return terms.triggers.every(one => one.kind !== "script" ||
    (one.script !== undefined && canonicalJson(lastScript(store, terms.repo, one.script.name)) === canonicalJson(one.script)));
}

/** A grant whose script or project file drifted ends now, durably, and its queued approvals are withdrawn. True when it did. */
function endIfScriptsChanged(store: Store, grant: UnattendedGrant, now: Date): boolean {
  if (scriptsUnchanged(store, grant.terms)) return false;
  store.transact(() => {
    const row = store.handle.prepare("SELECT * FROM flow_unattended_grant WHERE id = ? AND revoked_at IS NULL").get(grant.id);
    if (row !== undefined) closeGrant(store, row, "flow", "script changed", now);
  });
  return true;
}

/** A schedule a grant could cover, and whether it is covered only when the owner picks it (`optional`, with why). */
export type UnattendedCandidate = CoveredTrigger & { optional: string | null };

/**
 * The flow's active schedules a grant could cover. A plain schedule makes its own card from its own words, so it is
 * covered by default. A script's items and a plane review's problems are outside content (issues, mail, what a run
 * saw), so they are covered only when the owner picks them. A standing order files under its own signed terms, and a
 * paused or unreadable schedule, or a script whose code can't be read safely, is never offered.
 */
export function unattendedCandidates(store: Store, flowId: number): UnattendedCandidate[] {
  const out: UnattendedCandidate[] = [];
  const flowRepo = store.getFlow(flowId)?.repo;
  if (flowRepo === undefined) return out;
  for (const trigger of store.flowTriggers(flowId)) {
    if (trigger.kind !== "schedule" || trigger.state !== "active") continue;
    const digest = triggerDigestOf(trigger);
    let config: Record<string, unknown>;
    try { config = JSON.parse(trigger.configJson) as Record<string, unknown>; } catch { continue; }
    if (digest === null || config === null || typeof config !== "object" || typeof config["schedule"] !== "string" || config["order"] !== undefined) continue;
    const when = scheduleWords(config["schedule"]);
    if (config["kind"] === "plane-review") out.push({ id: trigger.id, kind: "plane-review", digest, words: `Plane review, ${when}`, optional: "Its cards come from what the plane saw." });
    else if (config["kind"] !== "schedule") continue;
    else if (typeof config["script"] === "string") {
      // Its code is signed with it; one whose code can't be read safely is never offered.
      const script = lastScript(store, flowRepo, config["script"]);
      if (script !== null) out.push({ id: trigger.id, kind: "script", digest, words: `the ${config["script"]} script, ${when}`, script, optional: "Its cards come from what the script prints, which can be outside text, and wait for you unless it ran the code you signed. Files it loads by a computed name aren't checked." });
    }
    else if (typeof config["title"] === "string") out.push({ id: trigger.id, kind: "schedule", digest, words: `“${config["title"]}”, ${when}`, optional: null });
  }
  return out;
}

/** The flow's active script schedules not offered because their code can't be read safely. */
function unreadableScriptSchedules(store: Store, flowId: number): number[] {
  const offered = new Set(unattendedCandidates(store, flowId).map(one => one.id));
  return store.flowTriggers(flowId).filter(one => {
    if (one.kind !== "schedule" || one.state !== "active" || offered.has(one.id)) return false;
    try { return typeof (JSON.parse(one.configJson) as Record<string, unknown>)["script"] === "string"; } catch { return false; }
  }).map(one => one.id);
}

const UNREADABLE_SCRIPT = "can't be read safely (it's missing, waiting for approval, or a project file it runs or imports can't be read)";

/** A digest of the schedules the page offered, so a signature never covers one the person didn't read. */
export const candidatesDigestOf = (candidates: readonly UnattendedCandidate[]) =>
  createHash("sha256").update(`standing-orders:flow-unattended-candidates:${canonicalJson(candidates)}`, "utf8").digest("hex").slice(0, 32);

/** Why `signer` can't let this flow run on its own, or null: what the flow page shows instead of the form. */
export function unattendedSignProblem(store: Store, flow: FlowRow, signer: string): string | null {
  if (unattendedCandidates(store, flow.id).length === 0) return unreadableScriptSchedules(store, flow.id).length > 0
    ? `This flow's script ${UNREADABLE_SCRIPT}, so nothing would run on its own.` : "This flow has no schedule, so nothing would run on its own.";
  return coverageProblem(store, flow, signer, workReposOf(flow));
}

/** `include`: the schedules (trigger ids) the owner picked beyond the plain ones covered by default. */
export type UnattendedAsk = { days: number; budgetMicrousd: number | null; dailyRunCap: number | null; include?: number[] };

/** Read what a person typed: whole days 1–MODE_MAX_DAYS, an optional dollar budget, an optional runs-a-day cap. */
export function parseUnattendedAsk(input: { days: unknown; budget?: unknown; runs?: unknown; include?: unknown }): { ok: true; ask: UnattendedAsk } | { ok: false; message: string } {
  const text = (v: unknown) => typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
  const days = Number(text(input.days));
  if (!Number.isInteger(days) || days < 1 || days > MODE_MAX_DAYS) return { ok: false, message: `Choose 1 to ${MODE_MAX_DAYS} days: it always ends.` };
  const budgetText = text(input.budget).replace(/^\$/, "");
  let budgetMicrousd: number | null = null;
  if (budgetText !== "") {
    const value = Number(budgetText);
    if (!/^\d+(\.\d{1,2})?$/.test(budgetText) || value <= 0 || Math.round(value * 1_000_000) > UNATTENDED_MAX_BUDGET_MICROUSD) return { ok: false, message: `Give the budget in dollars, up to ${dollars(UNATTENDED_MAX_BUDGET_MICROUSD)}, or leave it empty.` };
    budgetMicrousd = Math.round(value * 1_000_000);
  }
  const runsText = text(input.runs);
  let dailyRunCap: number | null = null;
  if (runsText !== "") {
    const value = Number(runsText);
    if (!Number.isInteger(value) || value < 1 || value > UNATTENDED_MAX_RUNS) return { ok: false, message: `Give runs a day as 1 to ${UNATTENDED_MAX_RUNS}, or leave it empty.` };
    dailyRunCap = value;
  }
  const includeText = Array.isArray(input.include) ? input.include.map(text).join(",") : text(input.include);
  const include = includeText === "" ? [] : includeText.split(/[\s,]+/).filter(one => one !== "").map(Number);
  if (include.some(id => !Number.isSafeInteger(id) || id < 1)) return { ok: false, message: "Name the schedules to include by their trigger ids, like 12,14." };
  return { ok: true, ask: { days, budgetMicrousd, dailyRunCap, ...(include.length === 0 ? {} : { include: [...new Set(include)] }) } };
}

/** The exact terms a signature would cover now, for these schedules. */
export function unattendedTermsFor(flow: FlowRow, owner: string, ask: UnattendedAsk, triggers: readonly CoveredTrigger[], now: Date): UnattendedTerms {
  return { flow: flow.id, flowRevision: flow.revision, repo: flow.repo, owner, triggers: triggers.map(({ id, kind, digest, words, script }) => ({ id, kind, digest, words, ...(kind === "script" && script !== undefined ? { script: structuredClone(script) } : {}) })), permissions: "safe",
    acceptance: structuredClone(FLOW_ACCEPTANCE), perAttemptBudgetMicrousd: ask.budgetMicrousd, dailyRunCap: ask.dailyRunCap,
    absoluteExpiry: new Date(now.getTime() + ask.days * 24 * 60 * 60_000).toISOString() };
}

/** Sign (or renew) the grant. The caller has already checked the signer's password; every predicate is proved again
 * here against the flow as it now stands: files asynchronously first, then database facts inside the transaction. `sawRevision` and `sawSchedules` (candidatesDigestOf),
 * when given, are the flow and the schedules the person read. Renewing ends the old grant and withdraws what it sealed. */
export async function signUnattended(store: Store, input: { flow: number; signer: string; ask: UnattendedAsk; sawRevision?: number; sawSchedules?: string }, now: Date): Promise<{ ok: true; grant: UnattendedGrant } | { ok: false; message: string }> {
  const revision = store.getFlow(input.flow)?.revision;
  const schedules = canonicalJson(store.flowTriggers(input.flow));
  await prepareUnattendedCandidates(store, input.flow);
  const prepared = candidatesDigestOf(unattendedCandidates(store, input.flow));
  return store.transact(() => {
    const flow = store.getFlow(input.flow);
    if (flow === null) return { ok: false as const, message: "No such flow." };
    if (revision !== flow.revision || schedules !== canonicalJson(store.flowTriggers(input.flow)) || prepared !== candidatesDigestOf(unattendedCandidates(store, input.flow))) return { ok: false as const, message: "This flow changed while preparing its scripts. Read the terms again." };
    if (input.sawRevision !== undefined && input.sawRevision !== flow.revision) return { ok: false as const, message: "This flow changed while you were reading. Read the terms again." };
    const problem = unattendedSignProblem(store, flow, input.signer);
    if (problem !== null) return { ok: false as const, message: problem };
    const candidates = unattendedCandidates(store, flow.id);
    if (input.sawSchedules !== undefined && input.sawSchedules !== candidatesDigestOf(candidates)) return { ok: false as const, message: "This flow's schedules changed while you were reading. Read the terms again." };
    const include = input.ask.include ?? [];
    const unknown = include.find(id => !candidates.some(one => one.id === id));
    if (unknown !== undefined) return { ok: false as const, message: unreadableScriptSchedules(store, flow.id).includes(unknown)
      ? `Trigger ${unknown} runs a script that ${UNREADABLE_SCRIPT}, so it can't be covered.` : `Trigger ${unknown} isn't one of this flow's active schedules.` };
    const covered = candidates.filter(one => one.optional === null || include.includes(one.id));
    if (covered.length === 0) return { ok: false as const, message: "Choose a schedule to include: this flow's schedules bring in outside content, so none is covered unless you pick it." };
    const terms = unattendedTermsFor(flow, input.signer, input.ask, covered, now);
    const digest = unattendedDigestOf(terms);
    const previous = store.handle.prepare("SELECT * FROM flow_unattended_grant WHERE flow = ? AND revoked_at IS NULL").get(flow.id);
    if (previous !== undefined) closeGrant(store, previous, input.signer, "renewed", now);
    const id = Number(store.handle.prepare(`INSERT INTO flow_unattended_grant (flow, repo, flow_revision, terms_json, digest, signed_by, signed_at, absolute_expiry)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(flow.id, flow.repo, flow.revision, unattendedTermsJson(terms), digest, input.signer, now.toISOString(), terms.absoluteExpiry).lastInsertRowid);
    store.recordAction({ at: now.toISOString(), actor: input.signer, repo: flow.repo, taskId: null, runId: null, source: "policy",
      action: `flow runs on its own: ${previous === undefined ? "signed" : "renewed"}`, outcome: previous === undefined ? "signed" : "renewed",
      detail: `${flow.name} (flow #${flow.id}) · until ${terms.absoluteExpiry.slice(0, 16).replace("T", " ")} UTC${terms.perAttemptBudgetMicrousd === null ? "" : ` · ${dollars(terms.perAttemptBudgetMicrousd)} per attempt`}${terms.dailyRunCap === null ? "" : ` · ${terms.dailyRunCap} runs a day`}` });
    return { ok: true as const, grant: { id, flow: flow.id, repo: flow.repo, terms, digest, signedBy: input.signer, signedAt: now.toISOString(), absoluteExpiry: terms.absoluteExpiry } };
  });
}

/** One click for any approver on the project: lowering authority needs no password. False when there was none. */
export function revokeUnattended(store: Store, flowId: number, by: string, now: Date): boolean {
  return store.transact(() => {
    const row = store.handle.prepare("SELECT * FROM flow_unattended_grant WHERE flow = ? AND revoked_at IS NULL").get(flowId);
    if (row === undefined) return false;
    const expired = Date.parse(String(row["absolute_expiry"])) <= now.getTime();
    closeGrant(store, row, expired ? "the-clock" : by, expired ? "expired" : "revoked", now);
    return !expired;
  });
}

/**
 * Whether a card came from one of the schedules this grant signed for, fired on time after it was signed: the firing
 * names the card and was the clock's (never Run now), its trigger is still active with the very settings signed, and no
 * person has moved the card or sent it back since. Anything else is a person's card, or one the grant never read.
 * A script schedule's firing must have run the very code signed (scriptRanDigestOf), and it must still be that code;
 * when it isn't, the grant ends here (unattendedCoverageFor).
 */
export function cardFromSignedSchedule(store: Store, grant: UnattendedGrant, cardId: number, requireScript = true): boolean {
  const fired = store.handle.prepare(`SELECT t.id, t.flow, t.kind, t.state, t.config_json, e.at, e.ran_script FROM flow_trigger_event e JOIN flow_trigger t ON t.id = e.trigger
    WHERE e.card = ? AND t.flow = ? AND e.on_time = 1`).all(cardId, grant.flow);
  const signed = fired.some(row => String(row["at"]) >= grant.signedAt && String(row["state"]) === "active" && grant.terms.triggers.some(one => one.id === Number(row["id"]) &&
    one.digest === triggerDigestOf({ id: Number(row["id"]), flow: Number(row["flow"]), kind: String(row["kind"]), configJson: String(row["config_json"]) }) &&
    (!requireScript || one.kind !== "script" || (one.script !== undefined && row["ran_script"] === ranDigestOf(one.script)))));
  if (!signed) return false;
  return store.handle.prepare(`SELECT 1 AS hit FROM flow_event WHERE card = ? AND ((outcome = 'moved' AND actor <> 'flow') OR outcome = 'sent-back') LIMIT 1`).get(cardId) === undefined;
}

const utcDay = (now: Date) => now.toISOString().slice(0, 10);

/** How many runs a grant has filed on `now`'s UTC day. */
export function unattendedRunsToday(store: Store, grantId: number, now: Date): number {
  return Number(store.handle.prepare("SELECT COUNT(*) AS n FROM flow_unattended_run WHERE grant_id = ? AND day = ?").get(grantId, utcDay(now))?.["n"] ?? 0);
}

/** Whether the grant covers this card's next filing (in `repo`) now; call inside the filing transaction. */
export function unattendedCoverageFor(store: Store, flow: FlowRow, card: { id: number }, repo: string, now: Date): UnattendedGrant | null {
  const grant = activeUnattendedGrant(store, flow.id, now);
  if (grant === null || grant.terms.flow !== flow.id || grant.terms.flowRevision !== flow.revision || grant.terms.repo !== flow.repo || grant.terms.owner !== grant.signedBy) return null;
  if (coverageProblem(store, flow, grant.signedBy, [repo]) !== null) return null;
  // A script that drifted ends the grant whichever card is filing; one restored since a firing leaves just that card out.
  if (!cardFromSignedSchedule(store, grant, card.id, false)) return null;
  if (endIfScriptsChanged(store, grant, now)) return null;
  if (!cardFromSignedSchedule(store, grant, card.id)) return null;
  if (grant.terms.dailyRunCap !== null && unattendedRunsToday(store, grant.id, now) >= grant.terms.dailyRunCap) return null;
  return grant;
}

/** Count one run against the grant's day, in one statement that admits it only under the cap (so two filings racing
 * on two connections can't both take the last run). False when the day is full; then nothing is sealed. */
export function reserveUnattendedRun(store: Store, grant: UnattendedGrant, taskId: string, now: Date): boolean {
  const { changes } = store.handle.prepare(`INSERT OR IGNORE INTO flow_unattended_run (grant_id, day, task_id, at)
    SELECT ?, ?, ?, ? WHERE ? IS NULL OR (SELECT COUNT(*) FROM flow_unattended_run WHERE grant_id = ? AND day = ?) < ?`)
    .run(grant.id, utcDay(now), taskId, now.toISOString(), grant.terms.dailyRunCap, grant.id, utcDay(now), grant.terms.dailyRunCap);
  return Number(changes) === 1;
}

/** Give back a run reserved for a filing that then couldn't be sealed. */
export function releaseUnattendedRun(store: Store, grant: UnattendedGrant, taskId: string): void {
  store.handle.prepare("DELETE FROM flow_unattended_run WHERE grant_id = ? AND task_id = ?").run(grant.id, taskId);
}

/** The grant that sealed (or pre-authorized) a task still stands for it: the same live digest, the flow unchanged and
 * still owned by the signer, the signer able to approve in the task's project, its scripts' code unchanged (else it
 * ends here), and the work not protected. */
export function unattendedGrantStands(store: Store, digest: string, signer: string, taskRepo: string | null, touches: readonly string[], now: Date): boolean {
  const row = store.handle.prepare("SELECT * FROM flow_unattended_grant WHERE digest = ? AND revoked_at IS NULL").get(digest);
  if (row === undefined || taskRepo === null) return false;
  const grant = activeUnattendedGrant(store, Number(row["flow"]), now);
  const flow = grant === null ? null : store.getFlow(grant.flow);
  if (grant === null || flow === null || grant.digest !== digest || grant.signedBy !== signer || grant.terms.flowRevision !== flow.revision) return false;
  if (coverageProblem(store, flow, signer, [taskRepo]) !== null) return false;
  if (endIfScriptsChanged(store, grant, now)) return false;
  return !isProtectedWork(store.approvalRules(taskRepo), [...touches]);
}

/** The flow page's and CLI's view of the grant: the live state, and whether (and why not) this viewer can sign. */
export type UnattendedView = {
  active: { until: string; untilWords: string; signedBy: string; budgetMicrousd: number | null; dailyRunCap: number | null; runsToday: number; words: string[]; covers: string[] } | null;
  canSign: boolean;
  problem: string | null;
  maxDays: number;
  /** Whether the flow has a schedule, the only thing a grant covers. */
  scheduled: boolean;
  /** What a signature covers besides the limits and schedules the form chooses (unattendedLimitWords, unattendedCoverWords,
   * unattendedEndAfterWords). */
  terms: { head: string[]; rules: string[] };
  /** The schedules it could cover (optional ones only when picked), and their digest, which the form sends back. */
  schedules: { id: number; words: string; optional: string | null }[];
  schedulesDigest: string;
};

export function unattendedViewOf(store: Store, flow: FlowRow, viewer: { name: string; approver: boolean }, now: Date): UnattendedView {
  const grant = activeUnattendedGrant(store, flow.id, now);
  // A grant whose flow moved on covers nothing: say so by not showing it as running.
  const live = grant !== null && grant.terms.flowRevision === flow.revision && grant.signedBy === flow.owner ? grant : null;
  const problem = viewer.approver ? unattendedSignProblem(store, flow, viewer.name) : "Only an approver can change this.";
  const candidates = unattendedCandidates(store, flow.id);
  return {
    active: live === null ? null : { until: live.absoluteExpiry, untilWords: untilWords(live.absoluteExpiry), signedBy: live.signedBy, budgetMicrousd: live.terms.perAttemptBudgetMicrousd,
      dailyRunCap: live.terms.dailyRunCap, runsToday: unattendedRunsToday(store, live.id, now), words: unattendedWords(live.terms), covers: live.terms.triggers.map(one => one.words) },
    canSign: problem === null,
    problem,
    maxDays: MODE_MAX_DAYS,
    scheduled: candidates.length > 0,
    terms: { head: unattendedHeadWords(viewer.name, FLOW_ACCEPTANCE), rules: [...UNATTENDED_RULE_WORDS] },
    schedules: candidates.map(one => ({ id: one.id, words: one.words, optional: one.optional })),
    schedulesDigest: candidatesDigestOf(candidates),
  };
}
