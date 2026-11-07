/**
 * One check of a project's recorded remote main, and the build of a new map when it moved (docs/plans/code-map.md §1-2).
 * Toolroll's own code, in the worker: raw blobs from a private depth-1 folder, a static parse in a bounded child, no
 * agent, no model and nothing from the repository run. The remote identity is captured first and carried unchanged to
 * publication. Every write after the lease is fenced; a worker that lost its lease drops its result.
 */
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { boundedRun, cleanupLeftover, type BoundedRunner } from "./bounded-spawn.js";
import { buildCodeMap, EXTRACTOR_TAG, externalPackage, isParsedLanguage, LIMITS, manifestEntries, unsafeName, vendoredRoot, type CodeMap, type FileFacts, type MapSymbol, type MapWarning, type TreeEntry } from "./code-map-shape.js";
import { clearOldSpawn, clearRequest, CODE_MAP_ACT, codeMapOn, currentVersion, digestOfUrl, encodeMap, extendLease, publishVersion, readRefresh, recordCheck, recordFailure, recordFolder, recordPeek, recordSpawn, releaseLease, takeLease, tidyVersions, type Lease } from "./code-map-store.js";
import { scanForSecrets } from "./evidence.js";
import { run } from "./exec.js";
import { pinDestination, lookupAll, type Lookup, type Pin } from "./remote-destination.js";
import { initPrivateDir, mapGitArgs, mapGitEnv, peekMain, readShallowMain, remoteUrlProblem } from "./remote-main.js";
import { trustedRemoteIdentity, type Store } from "./store.js";

export const REFRESH_EVERY_MS = 30 * 60_000;

export type MapDeps = {
  /** The folder private fetches go under: inside Toolroll's state, denied to builds. */
  scratch: string;
  bounded?: BoundedRunner;
  lookup?: Lookup;
  /** Whether this git's libcurl honours the pin; refused when it doesn't. */
  pinWorks?: () => Promise<boolean>;
  env?: Readonly<Record<string, string | undefined>>;
  owner?: string;
  helper?: string;
  clock?: () => Date;
  /** Tests: stops inside the build, to race it. */
  atStage?: (stage: "before-fetch" | "after-fetch" | "before-publish") => void | Promise<void>;
};

let extractorName: string | null = null;
/** Pinned by the parser's own package: a parser bump rebuilds every map. */
export function currentExtractor(): string {
  if (extractorName !== null) return extractorName;
  const require = createRequire(import.meta.url);
  const { version } = JSON.parse(readFileSync(require.resolve("typescript-parser/package.json"), "utf8")) as { version: string };
  return extractorName = `typescript-parser@${version}/${EXTRACTOR_TAG}`;
}

let pinProven: boolean | null = null;
/** Connect a pinned name that can't resolve to a local listener: only a libcurl that honours the pin reaches it. */
export async function curlPinWorks(): Promise<boolean> {
  if (pinProven !== null) return pinProven;
  let hits = 0;
  const server = createServer((_request, response) => { hits++; response.writeHead(404); response.end(); });
  const port = await new Promise<number | null>(done => {
    server.once("error", () => done(null));
    server.listen(0, "127.0.0.1", () => { const held = server.address(); done(typeof held === "object" && held !== null ? held.port : null); });
  });
  if (port === null) return false;
  try {
    const host = "toolroll-pin-check.invalid";
    await run("git", ["-c", "protocol.allow=always", "-c", `http.curloptResolve=${host}:${port}:127.0.0.1`, "ls-remote", "--", `http://${host}:${port}/x.git`],
      { cwd: "/", envAllowlist: ["PATH", "HOME"], env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" }, timeoutMs: 10_000 });
  } finally { server.closeAllConnections(); server.close(); }
  return pinProven = hits > 0;
}

// ---- reading the tree --------------------------------------------------------------------------------------------

const utf8 = new TextDecoder("utf-8", { fatal: true });
const textOf = (bytes: Uint8Array): string | null => { try { return bytes.includes(0) ? null : utf8.decode(bytes); } catch { return null; } };

type RawEntry = { path: string | null; mode: string; kind: string; oid: string; bytes: number };
export function parseTree(output: Buffer): RawEntry[] {
  const entries: RawEntry[] = [];
  let at = 0;
  while (at < output.length) {
    let end = output.indexOf(0, at);
    if (end < 0) end = output.length;
    const tab = output.indexOf(0x09, at);
    if (tab > at && tab < end) {
      const head = /^(\d{6}) (\w+) ([0-9a-f]{40,64}) +(\d+|-)$/.exec(output.subarray(at, tab).toString("latin1"));
      if (head !== null) {
        let path: string | null = null;
        try { path = utf8.decode(output.subarray(tab + 1, end)); } catch { path = null; }
        entries.push({ path, mode: head[1]!, kind: head[2]!, oid: head[3]!, bytes: head[4] === "-" ? 0 : Number(head[4]) });
      }
    }
    at = end + 1;
  }
  return entries;
}

const pathRefused = (path: string | null): boolean => {
  if (path === null || unsafeName(path) || Buffer.byteLength(path) > LIMITS.pathBytes) return true;
  const parts = path.split("/");
  return parts.length - 1 > LIMITS.pathDepth || parts.some(part => part === "" || part === "." || part === ".." || part.toLowerCase() === ".git");
};

/** Which of `names` a secret scan flags, by one scan over all of them. */
function flagged(names: readonly string[]): Set<number> {
  return new Set(scanForSecrets(names.join("\n")).map(hit => hit.line - 1));
}

async function readBlobs(dir: string, pin: Pin, bounded: BoundedRunner, wanted: readonly { path: string; oid: string; bytes: number }[]): Promise<Map<string, Buffer>> {
  const found = new Map<string, Buffer>();
  const batches: (typeof wanted[number])[][] = [];
  let batch: (typeof wanted[number])[] = [], size = 0;
  for (const one of wanted) {
    if (batch.length > 0 && (batch.length >= 500 || size + one.bytes > 8 * 1024 * 1024)) { batches.push(batch); batch = []; size = 0; }
    batch.push(one); size += one.bytes;
  }
  if (batch.length > 0) batches.push(batch);
  for (const group of batches) {
    const ran = await bounded("git", mapGitArgs(dir, pin, ["cat-file", "--batch"]), { cwd: dir, env: mapGitEnv(pin), stdin: Buffer.from(`${group.map(one => one.oid).join("\n")}\n`),
      timeoutMs: 60_000, maxStdout: 8 * 1024 * 1024 + LIMITS.fileBytes + group.length * 128 + 4096, maxStderr: 4096, label: "code-map-blobs" });
    if (ran.code !== 0) throw new MapRefused("couldn't read main: its files couldn't be read", "failed");
    let at = 0;
    for (const one of group) {
      const end = ran.stdout.indexOf(0x0a, at);
      if (end < 0) throw new MapRefused("couldn't read main: its files couldn't be read", "failed");
      const head = /^([0-9a-f]{40,64}) (\w+) (\d+)$/.exec(ran.stdout.subarray(at, end).toString("latin1"));
      if (head === null) { at = end + 1; continue; }
      const bytes = Number(head[3]);
      if (head[1] === one.oid && head[2] === "blob" && bytes <= LIMITS.fileBytes) found.set(one.path, ran.stdout.subarray(end + 1, end + 1 + bytes));
      at = end + 1 + bytes + 1;
    }
  }
  return found;
}

/** A failed build's reason, in the words the page shows, and the state it reads as. */
export class MapRefused extends Error {
  constructor(message: string, readonly state: "failed" | "too-large") { super(message); }
}

/** The parser process's entry, from the installed release (the sources under a test). */
export function parserEntry(): { file: string; args: string[] } {
  const source = import.meta.url.endsWith(".ts");
  const entry = fileURLToPath(new URL(source ? "./code-map-main.ts" : "./code-map-main.js", import.meta.url));
  return { file: process.execPath, args: [`--max-old-space-size=${LIMITS.parserHeapMb}`, ...(source ? ["--import", import.meta.resolve("tsx")] : []), entry] };
}

type ParsedFile = { path: string; parseFailed: boolean; exports: { name: string; kind: string; line: number }[]; specifiers: { specifier: string; kind: "imports" | "re-exports" | "dynamic-import"; line: number; to: string | null }[] };
type Parsed = { version: string; tsconfig: "extends" | "unreadable" | null; facts: ParsedFile[] };

async function parseBlobs(dir: string, bounded: BoundedRunner, files: { path: string; text: string }[], paths: string[], tsconfig: string | null, entry: { file: string; args: string[] }): Promise<Parsed> {
  const ran = await bounded(entry.file, entry.args, { cwd: dir, env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: dir }, stdin: Buffer.from(JSON.stringify({ files, paths, tsconfig })),
    timeoutMs: LIMITS.parserMs, maxStdout: LIMITS.parserOutput, maxStderr: 4096, memoryBytes: 1024 ** 3, label: "code-map-parse" });
  if (ran.code !== 0 || ran.killed !== null) throw new MapRefused("couldn't finish reading", "failed");
  try { return JSON.parse(ran.stdout.toString("utf8")) as Parsed; }
  catch { throw new MapRefused("couldn't finish reading", "failed"); }
}

export type BuildContext = { repo: string; commit: string; urlDigest: string; record: number; builtAt: string; extractor: string };
/** Everything between a clean private folder and a map. Throws MapRefused when no new version can come of it. */
export async function buildFromFolder(dir: string, pin: Pin, bounded: BoundedRunner, context: BuildContext, entry = parserEntry()): Promise<CodeMap> {
  const listed = await bounded("git", mapGitArgs(dir, pin, ["ls-tree", "-r", "-l", "-z", context.commit]), { cwd: dir, env: mapGitEnv(pin), timeoutMs: 60_000, maxStdout: 16 * 1024 * 1024, maxStderr: 4096, label: "code-map-tree" });
  if (listed.killed === "output") throw new MapRefused(`too large: more than ${LIMITS.treeEntries.toLocaleString("en-US")} files`, "too-large");
  if (listed.code !== 0) throw new MapRefused("couldn't read main: its file list couldn't be read", "failed");
  const raw = parseTree(listed.stdout);
  if (raw.length > LIMITS.treeEntries) throw new MapRefused(`too large: ${raw.length.toLocaleString("en-US")} files (the limit is ${LIMITS.treeEntries.toLocaleString("en-US")})`, "too-large");
  let withheld = 0;
  const named = raw.filter((entryRow): entryRow is RawEntry & { path: string } => { if (pathRefused(entryRow.path)) { withheld++; return false; } return true; });
  const secret = flagged(named.map(one => one.path));
  const safe = named.filter((_one, index) => { if (secret.has(index)) { withheld++; return false; } return true; });
  const entries: TreeEntry[] = safe.map(one => ({ path: one.path, mode: one.mode, bytes: one.bytes }));

  const warnings = new Set<MapWarning>();
  const unread = new Map<string, "too-large" | "path-only">();
  const toRead: { path: string; oid: string; bytes: number }[] = [];
  const manifestsWanted: { path: string; oid: string; bytes: number }[] = [];
  let tsconfigEntry: { path: string; oid: string; bytes: number } | null = null;
  let filesRead = 0, bytesRead = 0;
  for (const one of safe) {
    if (one.kind !== "blob" || (one.mode !== "100644" && one.mode !== "100755") || vendoredRoot(one.path) !== null) continue;
    const blob = { path: one.path, oid: one.oid, bytes: one.bytes };
    if (one.path === "tsconfig.json" && one.bytes <= LIMITS.manifestBytes) tsconfigEntry = blob;
    if (one.path.endsWith("package.json") && (one.path === "package.json" || one.path.endsWith("/package.json")) && one.bytes <= LIMITS.manifestBytes) manifestsWanted.push(blob);
    if (!isParsedLanguage(one.path)) continue;
    if (one.bytes > LIMITS.fileBytes) { unread.set(one.path, "too-large"); continue; }
    if (filesRead >= LIMITS.filesRead || bytesRead + one.bytes > LIMITS.bytesRead) { unread.set(one.path, "path-only"); warnings.add("read-limit"); continue; }
    toRead.push(blob); filesRead++; bytesRead += one.bytes;
  }
  const blobs = await readBlobs(dir, pin, bounded, [...toRead, ...manifestsWanted, ...(tsconfigEntry === null ? [] : [tsconfigEntry])]);
  const files: { path: string; text: string }[] = [];
  for (const one of toRead) {
    const bytes = blobs.get(one.path);
    const text = bytes === undefined ? null : textOf(bytes);
    if (text === null) unread.set(one.path, "path-only"); // not text
    else files.push({ path: one.path, text });
  }
  const tsconfigBytes = tsconfigEntry === null ? undefined : blobs.get(tsconfigEntry.path);
  const tsconfig = tsconfigBytes === undefined ? null : textOf(tsconfigBytes);
  const parsed = await parseBlobs(dir, bounded, files, entries.filter(one => vendoredRoot(one.path) === null).map(one => one.path), tsconfig, entry);
  if (parsed.tsconfig === "extends") warnings.add("tsconfig-extends");
  if (parsed.tsconfig === "unreadable") warnings.add("tsconfig-unreadable");

  // The names the parser found: control characters and secrets are withheld here, on the parent's side.
  const allNames: string[] = [];
  for (const file of parsed.facts) {
    for (const one of file.exports) allNames.push(one.name);
    for (const one of file.specifiers) allNames.push(one.specifier);
  }
  const safeNames = allNames.map(name => name.replace(/[\r\n]/g, " "));
  const secrets = flagged(safeNames);
  let index = 0;
  const facts = new Map<string, FileFacts>();
  for (const file of parsed.facts) {
    const exports: MapSymbol[] = [], imports: FileFacts["imports"] = [], external = new Set<string>();
    for (const one of file.exports) {
      const bad = secrets.has(index++) || unsafeName(one.name);
      if (bad) { withheld++; continue; }
      if (one.name.length > LIMITS.symbolChars) warnings.add("symbols-truncated");
      exports.push({ name: one.name.slice(0, LIMITS.symbolChars), kind: one.kind, line: one.line });
    }
    for (const one of file.specifiers) {
      const bad = secrets.has(index++) || unsafeName(one.specifier);
      if (bad) { withheld++; continue; }
      if (one.to !== null) { imports.push({ to: one.to, kind: one.kind, line: one.line }); continue; }
      const name = externalPackage(one.specifier);
      if (name !== null) external.add(name);
    }
    facts.set(file.path, { exports, imports, external: [...external], parseFailed: file.parseFailed });
  }
  const manifests = new Map<string, { name: string | null; entries: string[] }>();
  for (const one of manifestsWanted) {
    const bytes = blobs.get(one.path);
    const text = bytes === undefined ? null : textOf(bytes);
    const read = text === null ? null : manifestEntries(text);
    if (read === null) continue;
    const named2 = read.name !== null && !unsafeName(read.name) && flagged([read.name]).size === 0 ? read.name : null;
    if (read.name !== null && named2 === null) withheld++;
    manifests.set(one.path, { name: named2, entries: read.entries.filter(entryName => !unsafeName(entryName)) });
  }
  return buildCodeMap({ repo: context.repo, commit: context.commit, remote: { urlDigest: context.urlDigest, record: context.record }, builtAt: context.builtAt, extractor: context.extractor,
    entries, entryCount: raw.length, withheld, facts, unread, manifests, warnings: [...warnings] });
}

// ---- one check ---------------------------------------------------------------------------------------------------

export type CheckOutcome = "unavailable" | "held" | "waits" | "fresh" | "published" | "stored" | "no-main" | "empty" | "failed" | "too-large" | "lease-lost";

/** Claim the instance's one build, in the transaction that records the folder for crash cleanup. */
function claimBuild(store: Store, lease: Lease, folder: string, now: Date): boolean {
  return store.transact(() => {
    const other = store.handle.prepare("SELECT 1 FROM code_map_refresh WHERE repo <> ? AND spawn_folder IS NOT NULL AND lease_owner IS NOT NULL AND lease_until > ? LIMIT 1").get(lease.repo, now.toISOString());
    return other === undefined && recordFolder(store, lease, folder);
  });
}

/** Check one project; build and publish when main moved. Never throws for a remote's sake. */
export async function checkCodeMap(store: Store, repo: string, deps: MapDeps): Promise<CheckOutcome> {
  const clock = deps.clock ?? (() => new Date());
  const bounded = deps.bounded ?? boundedRun;
  const owner = deps.owner ?? `worker-${process.pid}`;
  // Identity first: everything after this is judged against what is captured here.
  const identity = trustedRemoteIdentity(store, repo);
  if (identity === null || remoteUrlProblem(identity.url) !== null || !codeMapOn(store, repo)) return "unavailable";
  const urlDigest = digestOfUrl(identity.url);
  const lease = takeLease(store, repo, owner, clock());
  if (lease === null) return "held";
  mkdirSync(deps.scratch, { recursive: true });
  // What a crashed build left, before anything else.
  cleanupLeftover(lease.previous, realpathSync(deps.scratch));
  if (lease.previous.pid !== null || lease.previous.folder !== null) clearOldSpawn(store, lease);
  const started = currentVersion(store, repo);
  const extractor = currentExtractor();
  const folder = mkdtempSync(join(realpathSync(deps.scratch), ".code-map-"));
  const ledger = (outcome: string, detail: string | null): void => { store.recordAction({ at: clock().toISOString(), actor: "toolroll", repo, taskId: null, runId: null, action: CODE_MAP_ACT, outcome, source: "work", detail }); };
  const finishCheck = (state: string, commit: string | null, extra: { enforced?: string; proxy?: string | null } = {}): boolean => {
    if (!recordCheck(store, lease, { digest: urlDigest, record: identity.record, commit, extractor, state, ...extra }, clock())) return false;
    clearRequest(store, lease);
    ledger(commit ?? "unread", state);
    return true;
  };
  const fail = (why: string, state: "failed" | "too-large"): CheckOutcome => {
    if (!recordFailure(store, lease, why, state, clock())) return "lease-lost";
    clearRequest(store, lease);
    ledger("unread", why.slice(0, 300));
    return state;
  };
  try {
    const pinned = await pinDestination(identity.url, deps.env ?? process.env, deps.lookup ?? lookupAll);
    if (!pinned.ok) return fail(`couldn't read main: ${pinned.why}`, "failed");
    const pin = pinned.pin;
    if (pin.env["GIT_SSH_COMMAND"] === undefined && !(await (deps.pinWorks ?? curlPinWorks)())) return fail("couldn't read main: this git can't pin its connection", "failed");
    await initPrivateDir(folder, bounded);
    const peek = await peekMain(identity.url, folder, pin, bounded, deps.helper);
    if (!peek.ok) return fail(peek.reason === "moved" ? peek.why : `couldn't read main: ${peek.why}`, "failed");
    if (peek.commit === null) return finishCheck("no-main", null) ? "no-main" : "lease-lost";
    if (!recordPeek(store, lease, peek.commit)) return "lease-lost";
    if (started !== null && started.remoteDigest === urlDigest && started.remoteRecord === identity.record && started.commit === peek.commit && started.extractor === extractor) {
      return finishCheck("current", peek.commit, { proxy: pin.proxy }) ? "fresh" : "lease-lost";
    }
    if (!claimBuild(store, lease, folder, clock())) {
      if (readRefresh(store, repo)?.leaseToken !== lease.token) return "lease-lost";
      return "waits";
    }
    await deps.atStage?.("before-fetch");
    const fetched = await readShallowMain(identity.url, folder, pin, bounded, spawn => { recordSpawn(store, lease, spawn); }, deps.helper);
    if (!fetched.ok) return fail(fetched.reason === "moved" ? fetched.why : `couldn't read main: ${fetched.why}`, "failed");
    await deps.atStage?.("after-fetch");
    if (!extendLease(store, lease, clock())) return "lease-lost";
    const builtAt = clock().toISOString();
    let map: CodeMap;
    try { map = await buildFromFolder(folder, pin, bounded, { repo, commit: fetched.commit, urlDigest, record: identity.record, builtAt, extractor }); }
    catch (error) {
      if (error instanceof MapRefused) return fail(error.message, error.state);
      return fail("couldn't finish reading", "failed");
    }
    if (!extendLease(store, lease, clock())) return "lease-lost";
    const encoded = encodeMap(map);
    if (encoded.bytes > LIMITS.storedBytes) return fail("too large to store", "too-large");
    await deps.atStage?.("before-publish");
    const report = JSON.stringify({ enforced: fetched.enforced, proxy: pin.proxy });
    const published = publishVersion(store, lease, { map, encoded, identity, startedFrom: started?.id ?? null, report }, clock());
    if (published === null) return "lease-lost";
    const state = map.counts.entries === 0 ? "empty" : published.current ? "current" : published.why;
    if (!finishCheck(state, fetched.commit, { enforced: fetched.enforced, proxy: pin.proxy })) return "lease-lost";
    if (published.current) tidyVersions(store, repo);
    return published.current ? (map.counts.entries === 0 ? "empty" : "published") : "stored";
  } finally {
    try { rmSync(folder, { recursive: true, force: true }); } catch { /* a later takeover removes it */ }
    releaseLease(store, lease);
  }
}

/** Projects due a check: the map on, a remote recorded, past any back-off, and a request queued or 30 minutes since the
 * last completed check. */
export function dueProjects(store: Store, now: Date): string[] {
  const rows = store.handle.prepare(`SELECT p.path, r.requested_at, r.retry_after, r.last_checked_at FROM project p LEFT JOIN code_map_refresh r ON r.repo = p.path
    WHERE p.code_map = 1 AND p.remote_url IS NOT NULL AND p.remote_url <> '' ORDER BY p.path`).all();
  return rows.filter(row => {
    const retry = row["retry_after"];
    if (typeof retry === "string" && Date.parse(retry) > now.getTime()) return false;
    const last = row["last_checked_at"];
    return row["requested_at"] !== null && row["requested_at"] !== undefined || typeof last !== "string" || now.getTime() - Date.parse(last) >= REFRESH_EVERY_MS;
  }).map(row => String(row["path"]));
}

/** The watch loop's step: every due project in turn, one build at a time. */
export async function refreshCodeMaps(store: Store, deps: MapDeps): Promise<number> {
  const clock = deps.clock ?? (() => new Date());
  let checked = 0;
  for (const repo of dueProjects(store, clock())) {
    try { await checkCodeMap(store, repo, deps); checked++; } catch { /* the next pass tries again */ }
  }
  return checked;
}
