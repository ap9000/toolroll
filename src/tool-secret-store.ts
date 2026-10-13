/**
 * Where the secrets Toolroll holds rest — project tools' keys and sign-ins,
 * and the credentials it keeps for integrations (Linear, Google mail, flow
 * webhooks): the operating system's keychain where this computer has one,
 * otherwise owner-only files.
 *
 * - macOS: the Keychain, through `/usr/bin/security -i`. Every command, the
 *   value included, is written to its stdin, so no secret is ever in a
 *   process's arguments. A line there holds about 4 KB, so a value is split
 *   into chunks: a head item names the chunks' generation and checksum, and is
 *   written last, so a reader sees the old value or the new one, never half.
 * - Linux: the Secret Service, through `secret-tool` (found in the system's
 *   own folders, never on a PATH), which reads the value from stdin. One that
 *   is installed but doesn't answer (no session bus) means files, said so.
 * - Anywhere else (or with TOOLROLL_SECRET_STORE=files): owner-only files, as
 *   before. Settings and `toolroll integrations` say so plainly.
 *
 * A keychain that is present but fails (locked, refused) is an error, never a
 * quiet fall back to files: what can't be read leaves the tool out of a run.
 *
 * Everything here lives in Toolroll's own folder for secrets: `tool-secrets`
 * beside the database, made when Toolroll starts (before any build can run),
 * never found by looking for a folder that happens to exist. A build is the
 * same user and can reach the keychain too (the fence can't deny it), so what
 * Toolroll keeps there is sealed (AES-256-GCM) with a key in that folder,
 * which every build's fence denies, and bound to its item's address. The
 * database records which key Toolroll made: a folder, key, link or lock that
 * something else put there first is refused, never used.
 */
import { spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeSync, type Stats } from "node:fs";
import { dirname, join } from "node:path";
import { envValue } from "./names.js";

export type SecretStoreKind = "macos-keychain" | "secret-service" | "files";
/** One item's address: what the store lists, never a secret (a folder's or project's hash, a tool's name). */
export type SecretItem = { service: string; account: string };
export type SecretBackend = {
  kind: Exclude<SecretStoreKind, "files">;
  /** Values are [A-Za-z0-9._-] only, at most `limit` characters. */
  limit: number;
  get(item: SecretItem): string | null;
  /** `create`: only when no item is there yet ("exists" when one is). */
  set(item: SecretItem, value: string, options?: { create?: boolean }): "ok" | "exists";
  remove(item: SecretItem): void;
};

export class SecretStoreError extends Error {}

/** The words Settings and `toolroll integrations` use for where secrets rest. */
export const STORE_WORDS: Readonly<Record<SecretStoreKind, string>> = {
  "macos-keychain": "Secrets are kept in the macOS Keychain.",
  "secret-service": "Secrets are kept in this computer's keyring (Secret Service).",
  files: "Secrets are protected by owner-only files on this computer.",
};
/** Said instead when a keyring is installed but doesn't answer, so files are all there is. */
export const UNANSWERED_WORDS = "Secrets are protected by owner-only files on this computer: its keyring isn't answering.";

const SAFE = /^[A-Za-z0-9._-]+$/;
const LABEL = "Toolroll tool secret";
/** What the store's own program gets: enough to find the user's keychain or session bus, nothing else. */
const STORE_ENV = ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"];
const storeEnv = (): NodeJS.ProcessEnv => Object.fromEntries(STORE_ENV.flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
const checked = (item: SecretItem) => {
  if (!SAFE.test(item.service) || !SAFE.test(item.account)) throw new SecretStoreError("A secret's address can't be used.");
};

/** The macOS Keychain, through `security -i` (`keychain`: a keychain file instead of the user's own, for tests). */
export function macosKeychain(options: { keychain?: string; binary?: string } = {}): SecretBackend {
  const binary = options.binary ?? "/usr/bin/security";
  if (options.keychain !== undefined && !/^\/[A-Za-z0-9._/-]+$/.test(options.keychain)) throw new SecretStoreError("That keychain path can't be used.");
  const where = options.keychain === undefined ? "" : ` ${options.keychain}`;
  /** One command on stdin; `security -i` exits with that command's status. */
  const run = (command: string) => {
    const done = spawnSync(binary, ["-i"], { input: `${command}\n`, encoding: "utf8", timeout: 20_000, env: storeEnv(), stdio: ["pipe", "pipe", "pipe"] });
    if (done.error !== undefined) throw new SecretStoreError("The macOS Keychain couldn't be reached.");
    return { code: done.status, stdout: done.stdout };
  };
  const named = (item: SecretItem) => { checked(item); return `-a ${item.account} -s ${item.service}`; };
  return {
    kind: "macos-keychain",
    limit: 3_000,
    get(item) {
      const done = run(`find-generic-password ${named(item)} -w${where}`);
      if (done.code === 44) return null;
      if (done.code !== 0) throw new SecretStoreError("The macOS Keychain refused to read a tool's secrets. Unlock it and try again.");
      return done.stdout.replace(/\n$/, "");
    },
    set(item, value, setOptions = {}) {
      if (!SAFE.test(value) || value.length > this.limit) throw new SecretStoreError("A secret's stored form can't be used.");
      const done = run(`add-generic-password ${setOptions.create === true ? "" : "-U "}${named(item)} -l "${LABEL}" -w ${value}${where}`);
      if (done.code === 45 && setOptions.create === true) return "exists";
      if (done.code !== 0) throw new SecretStoreError("The macOS Keychain refused to save a tool's secrets. Unlock it and try again.");
      return "ok";
    },
    remove(item) {
      const done = run(`delete-generic-password ${named(item)}${where}`);
      if (done.code !== 0 && done.code !== 44) throw new SecretStoreError("The macOS Keychain refused to remove a tool's secrets.");
    },
  };
}

/** The Secret Service (GNOME Keyring, KWallet), through `secret-tool` at `binary`, an absolute path; the value goes on its stdin. */
export function secretService(options: { binary: string }): SecretBackend {
  const binary = options.binary;
  if (!binary.startsWith("/")) throw new SecretStoreError("The keyring's program must be named by its full path.");
  const run = (args: string[], input?: string) => {
    const done = spawnSync(binary, args, { input: input ?? "", encoding: "utf8", timeout: 20_000, env: storeEnv(), stdio: ["pipe", "pipe", "pipe"] });
    if (done.error !== undefined) throw new SecretStoreError("This computer's keyring couldn't be reached.");
    return { code: done.status, stdout: done.stdout, stderr: done.stderr };
  };
  const named = (item: SecretItem) => { checked(item); return ["service", item.service, "account", item.account]; };
  const backend: SecretBackend = {
    kind: "secret-service",
    limit: 1_000_000,
    get(item) {
      const done = run(["lookup", ...named(item)]);
      if (done.code === 0) return done.stdout.replace(/\n$/, "");
      if (done.code === 1 && done.stdout === "" && done.stderr.trim() === "") return null;
      throw new SecretStoreError("This computer's keyring refused to read a tool's secrets. Unlock it and try again.");
    },
    set(item, value, setOptions = {}) {
      if (!SAFE.test(value)) throw new SecretStoreError("A secret's stored form can't be used.");
      if (setOptions.create === true && backend.get(item) !== null) return "exists";
      if (run(["store", `--label=${LABEL}`, ...named(item)], value).code !== 0) throw new SecretStoreError("This computer's keyring refused to save a tool's secrets. Unlock it and try again.");
      return "ok";
    },
    remove(item) {
      const done = run(["clear", ...named(item)]);
      if (done.code !== 0 && !(done.code === 1 && done.stderr.trim() === "")) throw new SecretStoreError("This computer's keyring refused to remove a tool's secrets.");
    },
  };
  return backend;
}

const myUid = (): number | null => process.getuid?.() ?? null;
/** Writable by someone other than its owner, and not a shared sticky folder like /tmp. */
const othersWrite = (info: Stats) => (info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0;

/**
 * `path` when it is a program only the system (or, for a test's stand-in, one of `owners`) can have put there: a real
 * executable file nobody else can change, in folders nobody else can either. Null otherwise.
 */
export function trustedProgram(path: string, owners: readonly number[] = [0]): string | null {
  try {
    const real = realpathSync(path);
    const info = statSync(real);
    if (!info.isFile() || (info.mode & 0o111) === 0 || (info.mode & 0o022) !== 0 || !owners.includes(info.uid)) return null;
    for (let folder = dirname(real); ; folder = dirname(folder)) {
      const one = lstatSync(folder);
      if ((one.uid !== 0 && !owners.includes(one.uid)) || othersWrite(one)) return null;
      if (folder === dirname(folder)) break;
    }
    return real;
  } catch { return null; }
}

/** Where `secret-tool` may be: the system's own folders, never the PATH a process was given. */
export const SECRET_TOOL_PATHS: readonly string[] = ["/usr/bin/secret-tool", "/bin/secret-tool", "/usr/local/bin/secret-tool"];

/** This computer's store as found: a backend, or none, and when none, whether one is installed but not answering. */
export type DetectedStore = { backend: SecretBackend | null; unanswered: boolean };

/**
 * Find this computer's store: the macOS Keychain where the system's `security` is; a Secret Service where the system's
 * `secret-tool` is and answers; else none (files). A `secret-tool` that is there but can't reach a keyring (no session
 * bus) is none too, and says so.
 */
export function detectSecretStore(options: { platform?: NodeJS.Platform; secretTools?: readonly string[]; owners?: readonly number[] } = {}): DetectedStore {
  const platform = options.platform ?? process.platform, owners = options.owners ?? [0];
  if (platform === "darwin") {
    const security = trustedProgram("/usr/bin/security", owners);
    return { backend: security === null ? null : macosKeychain({ binary: security }), unanswered: false };
  }
  if (platform !== "linux") return { backend: null, unanswered: false };
  const tool = (options.secretTools ?? SECRET_TOOL_PATHS).map(path => trustedProgram(path, owners)).find((one): one is string => one !== null);
  if (tool === undefined) return { backend: null, unanswered: false };
  // Answering: a lookup of nothing says "not found" quietly; no session bus says why on stderr, or hangs.
  const probe = spawnSync(tool, ["lookup", "service", "toolroll-probe", "account", "probe"], { encoding: "utf8", timeout: 5_000, env: storeEnv(), stdio: ["ignore", "pipe", "pipe"] });
  const answers = probe.error === undefined && (probe.status === 0 || (probe.status === 1 && probe.stderr.trim() === ""));
  return answers ? { backend: secretService({ binary: tool }), unanswered: false } : { backend: null, unanswered: true };
}

let detected: DetectedStore | undefined;
let chosen: SecretBackend | "files" | DetectedStore | null = null;
/** Tests choose the store (a keychain file of their own, files, or what detection found); null goes back to this computer's. */
export function chooseSecretStore(store: SecretBackend | "files" | DetectedStore | null): void { chosen = store; }

function currentStore(env: NodeJS.ProcessEnv): DetectedStore {
  if (chosen === "files") return { backend: null, unanswered: false };
  if (chosen !== null) return "kind" in chosen ? { backend: chosen, unanswered: false } : chosen;
  if (envValue(env, "SECRET_STORE") === "files") return { backend: null, unanswered: false };
  detected ??= detectSecretStore();
  return detected;
}

/** This computer's store (found once), or null for owner-only files. */
export function secretBackend(env: NodeJS.ProcessEnv = process.env): SecretBackend | null {
  return currentStore(env).backend;
}

export const secretStoreKind = (): SecretStoreKind => secretBackend()?.kind ?? "files";

/** Where secrets rest, in the words Settings and `toolroll integrations` share; `problem` when Toolroll's folder can't be used. */
export function secretStorage(): { kind: SecretStoreKind; words: string; filesOnly: boolean; problem?: string } {
  const found = currentStore(process.env);
  const kind = found.backend?.kind ?? "files";
  const problem = standing === null ? standingProblem : refusedRoots.get(standing) ?? null;
  return { kind, words: found.unanswered ? UNANSWERED_WORDS : STORE_WORDS[kind], filesOnly: kind === "files", ...(problem === null ? {} : { problem }) };
}

// ---- a value, in chunks the store can hold ------------------------------------------------------------------------

const HEAD = /^v1\.([0-9a-f]{8})\.([1-9][0-9]?)\.([0-9a-f]{16})\.([A-Za-z0-9_-]*)$/;
const digestOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
const chunkItem = (item: SecretItem, generation: string, index: number): SecretItem => ({ service: item.service, account: `${item.account}.${generation}.${index}` });

function readHead(backend: SecretBackend, item: SecretItem): { generation: string; count: number; digest: string; first: string } | null {
  const head = backend.get(item);
  if (head === null) return null;
  const parts = HEAD.exec(head);
  if (parts === null) throw new SecretStoreError("A tool's stored secrets are damaged.");
  return { generation: parts[1]!, count: Number(parts[2]), digest: parts[3]!, first: parts[4]! };
}

/** The text stored at `item`, or null when nothing is. A head read while a writer replaces it is read again. */
export function readValue(backend: SecretBackend, item: SecretItem): string | null {
  for (let attempt = 0; ; attempt++) {
    const head = readHead(backend, item);
    if (head === null) return null;
    const chunks = [head.first];
    // Each chunk starts "c." so none begins with "-" and reads as an option.
    for (let index = 1; index < head.count; index++) chunks.push(/^c\.([A-Za-z0-9_-]+)$/.exec(backend.get(chunkItem(item, head.generation, index)) ?? "")?.[1] ?? "\u0000");
    const text = chunks.join("");
    if (!text.includes("\u0000") && digestOf(text) === head.digest) return Buffer.from(text, "base64url").toString("utf8");
    if (attempt >= 2) throw new SecretStoreError("A tool's stored secrets are damaged.");
  }
}

/**
 * Store `text` at `item`: the chunks of a new generation first, then the head that names them, then the old
 * generation's chunks are removed. `create`: only when nothing is stored there yet.
 */
export function writeValue(backend: SecretBackend, item: SecretItem, text: string, options: { create?: boolean } = {}): "ok" | "exists" {
  const encoded = Buffer.from(text, "utf8").toString("base64url");
  const generation = randomBytes(4).toString("hex");
  const firstRoom = backend.limit - 40;
  const chunks = [encoded.slice(0, firstRoom), ...(encoded.slice(firstRoom).match(new RegExp(`.{1,${backend.limit - 2}}`, "g")) ?? [])];
  if (chunks.length > 99) throw new SecretStoreError("A tool's secrets are too large to store.");
  const before = options.create === true ? null : readHead(backend, item);
  for (let index = 1; index < chunks.length; index++) backend.set(chunkItem(item, generation, index), `c.${chunks[index]!}`, { create: true });
  const placed = backend.set(item, `v1.${generation}.${chunks.length}.${digestOf(encoded)}.${chunks[0]}`, options);
  const stale = placed === "exists" ? { generation, count: chunks.length } : before;
  if (stale !== null) for (let index = 1; index < stale.count; index++) backend.remove(chunkItem(item, stale.generation, index));
  return placed;
}

/** Remove what is stored at `item`, every chunk with it. */
export function removeValue(backend: SecretBackend, item: SecretItem): void {
  let head: ReturnType<typeof readHead> = null;
  try { head = readHead(backend, item); } catch { head = null; }
  backend.remove(item);
  if (head !== null) for (let index = 1; index < head.count; index++) backend.remove(chunkItem(item, head.generation, index));
}

// ---- Toolroll's own folder for secrets ----------------------------------------------------------------------------

/** The folder's name, beside the database. */
export const SECRET_FOLDER = "tool-secrets";
const KEY_FILE = ".keychain-key";

/** Where Toolroll records which sealing key it made: the database, which no build can write. */
export type KeyAnchor = { read(): string | null; swap(expected: string | null, next: string): boolean };
/** An anchor kept in this process alone: a test's own folder. */
export function memoryAnchor(): KeyAnchor {
  let held: string | null = null;
  return { read: () => held, swap: (expected, next) => { if (held !== expected) return false; held = next; return true; } };
}

/** Toolroll's folder for secrets, checked: its key in hand, and where the files kept before it are (`legacy`). */
export type SecretFolder = { readonly root: string; readonly dir: string; readonly legacy: string | null; dev: number; ino: number; key: Buffer; digest: string; anchor: KeyAnchor };

const folders = new Map<string, SecretFolder>();
/** Roots whose folder was refused when Toolroll started: never prepared again in this process. */
const refusedRoots = new Map<string, string>();
let standing: string | null = null;
let standingProblem: string | null = null;
const NOT_READY = "Toolroll's folder for secrets isn't ready. Restart Toolroll and try again.";

const keyDigest = (key: Buffer) => createHash("sha256").update("toolroll:sealing-key:v1\u0000").update(key).digest("hex");
const mine = (info: Stats) => { const uid = myUid(); return uid === null || info.uid === uid; };
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const codeOf = (error: unknown) => (error as NodeJS.ErrnoException).code;
const refuse = (path: string, why: string, fix = "Remove it and restart Toolroll."): never => { throw new SecretStoreError(`Secrets are switched off: ${path} ${why}. ${fix}`); };

/** Every folder from `root` up: real folders, this user's or the system's, that nobody else can write. */
function checkAncestors(root: string): void {
  for (let folder = root; ; folder = dirname(folder)) {
    const info = lstatSync(folder);
    if (!info.isDirectory()) refuse(folder, "isn't a folder");
    if (!(mine(info) || info.uid === 0) || othersWrite(info)) refuse(folder, "can be changed by other users");
    if (folder === dirname(folder)) return;
  }
}

/** A folder of Toolroll's own: a real folder (never a link), this user's, owner-only. */
function checkOwnFolder(path: string, info: Stats): void {
  if (info.isSymbolicLink() || !info.isDirectory()) refuse(path, "isn't a folder Toolroll made");
  if (!mine(info) || (info.mode & 0o077) !== 0) refuse(path, "isn't owner-only");
}

/** `path` opened without following a link, as a plain owner-only file with one name; null when there is none. */
function openOwnFile(path: string, flags: number): { fd: number; info: Stats } | null {
  let fd: number;
  try { fd = openSync(path, flags | constants.O_NOFOLLOW); } catch (error) {
    if (codeOf(error) === "ENOENT") return null;
    if (codeOf(error) === "ELOOP") refuse(path, "is a link");
    throw new SecretStoreError("A file of Toolroll's secrets can't be read.");
  }
  const info = fstatSync(fd);
  const problem = !info.isFile() ? "isn't a plain file" : !mine(info) ? "isn't this user's"
    : (info.mode & 0o077) !== 0 ? "is readable by other users" : info.nlink !== 1 ? "has another name (a hard link)" : null;
  if (problem !== null) { closeSync(fd); refuse(path, problem, problem === "is readable by other users" ? "Make it owner-only (chmod 600) and restart Toolroll." : undefined); }
  return { fd, info };
}

/** The key in `file`: 32 bytes, read through openOwnFile; null when there is none. */
function readKey(file: string): Buffer | null {
  const opened = openOwnFile(file, constants.O_RDONLY);
  if (opened === null) return null;
  try {
    const key = Buffer.alloc(33);
    if (readSync(opened.fd, key, 0, 33, 0) !== 32) refuse(file, "is damaged");
    return key.subarray(0, 32);
  } finally { closeSync(opened.fd); }
}

/** One preparer at a time, across processes: a lock file beside the folder, taken over when a dead one left it. */
function withRootLock<T>(root: string, work: () => T): T {
  const lock = join(root, `.${SECRET_FOLDER}.lock`);
  for (let tries = 0; ; tries++) {
    try { closeSync(openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)); break; } catch (error) {
      if (codeOf(error) !== "EEXIST") refuse(lock, "can't be made");
      try { const info = lstatSync(lock); if (Date.now() - info.mtimeMs > 30_000) { unlinkSync(lock); continue; } } catch { continue; }
      if (tries > 400) throw new SecretStoreError("Toolroll's folder for secrets is being prepared elsewhere. Try again in a moment.");
      pause(25);
    }
  }
  try { return work(); } finally { rmSync(lock, { force: true }); }
}

function openFolder(stateDir: string, anchor: KeyAnchor, create: boolean, legacy: string | null): SecretFolder {
  let root: string;
  try { root = realpathSync(stateDir); } catch { throw new SecretStoreError("Toolroll's own folder can't be found, so the secrets it holds can't be used."); }
  checkAncestors(root);
  const dir = join(root, SECRET_FOLDER), keyFile = join(dir, KEY_FILE);
  const known = folders.get(root);
  return withRootLock(root, () => {
    let info: Stats | null = null;
    try { info = lstatSync(dir); } catch (error) { if (codeOf(error) !== "ENOENT") refuse(dir, "can't be read"); }
    const recorded = anchor.read();
    if (info === null) {
      if (!create) throw new SecretStoreError(NOT_READY);
      mkdirSync(dir, { mode: 0o700 });
      info = lstatSync(dir);
    } else if (recorded === null && known === undefined && readdirSync(dir).length > 0) {
      // Toolroll never made a key here, yet the folder holds something: put there by something else.
      refuse(dir, "wasn't made by Toolroll");
    }
    checkOwnFolder(dir, info);
    let key = readKey(keyFile);
    if (key !== null) {
      const digest = keyDigest(key);
      // This process made it (a test's own folder, then Toolroll's start): recorded now.
      if (recorded === null && known?.digest === digest) anchor.swap(null, digest);
      else if (digest !== recorded) refuse(keyFile, "isn't the key Toolroll made");
    } else {
      if (!create) throw new SecretStoreError(NOT_READY);
      // A new key: recorded first, then put in place whole (a crash in between leaves no key, and the next start makes one).
      key = randomBytes(32);
      if (!anchor.swap(recorded, keyDigest(key))) throw new SecretStoreError("Toolroll's folder for secrets is being prepared elsewhere. Try again in a moment.");
      const staged = join(dir, `${KEY_FILE}.${process.pid}.${randomBytes(4).toString("hex")}`);
      const fd = openSync(staged, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { writeSync(fd, key); fsyncSync(fd); } finally { closeSync(fd); }
      try { linkSync(staged, keyFile); } catch { rmSync(staged, { force: true }); refuse(keyFile, "appeared while Toolroll was making it"); }
      rmSync(staged, { force: true });
    }
    return { root, dir, legacy, dev: info.dev, ino: info.ino, key, digest: keyDigest(key), anchor };
  });
}

/**
 * Prepare Toolroll's folder for secrets beside `stateDir` (the folder holding the database), checked against what
 * `anchor` recorded: made with its sealing key when it isn't there yet (`create`), refused when something else put a
 * folder, key or link there. `standing`: the folder this process uses by default (Toolroll's own start).
 */
export function prepareSecretFolder(stateDir: string, anchor: KeyAnchor, options: { create?: boolean; legacy?: string | null; standing?: boolean } = {}): { ok: true; dir: string } | { ok: false; problem: string } {
  let root: string | null = null;
  try {
    root = realpathSync(stateDir);
    const folder = openFolder(root, anchor, options.create ?? true, options.legacy ?? null);
    folders.set(folder.root, folder);
    refusedRoots.delete(folder.root);
    if (options.standing === true) { standing = folder.root; standingProblem = null; }
    return { ok: true, dir: folder.dir };
  } catch (error) {
    const problem = error instanceof SecretStoreError ? error.message : "Toolroll's folder for secrets couldn't be prepared.";
    if (root !== null) { folders.delete(root); refusedRoots.set(root, problem); }
    if (options.standing === true) { standing = root; standingProblem = problem; }
    return { ok: false, problem };
  }
}

/** What a folder beside a database will be checked against, before it is first used (registerSecretFolder). */
const pending = new Map<string, { anchor: KeyAnchor; legacy: string | null }>();

/**
 * Name Toolroll's folder for secrets (beside `stateDir`, the database's folder) and the record to check it against,
 * without touching it yet: it is prepared the first time a secret is used. `standing`: this process's default.
 */
export function registerSecretFolder(stateDir: string, anchor: KeyAnchor, options: { legacy?: string | null } = {}): void {
  let root: string;
  try { root = realpathSync(stateDir); } catch { standing = null; standingProblem = "Toolroll's own folder can't be found, so the secrets it holds can't be used."; return; }
  pending.set(root, { anchor, legacy: options.legacy ?? null });
  standing = root;
  standingProblem = null;
}

/** Still the folder that was checked: the same folder, still owner-only, its key unchanged. */
function unchanged(folder: SecretFolder): boolean {
  try {
    const info = lstatSync(folder.dir);
    if (info.isSymbolicLink() || !info.isDirectory() || info.dev !== folder.dev || info.ino !== folder.ino || !mine(info) || (info.mode & 0o077) !== 0) return false;
    const key = readKey(join(folder.dir, KEY_FILE));
    return key !== null && keyDigest(key) === folder.digest;
  } catch { return false; }
}

/**
 * Toolroll's folder for secrets, checked again now: the one prepared at start when `state` is absent, else the one
 * beside `state` (a test's own folder is prepared the first time it is used, against an anchor in this process).
 */
export function secretFolder(state?: string): SecretFolder {
  let root: string;
  if (state === undefined) {
    if (standing === null) throw new SecretStoreError(standingProblem ?? NOT_READY);
    root = standing;
  } else {
    try { root = realpathSync(state); } catch { throw new SecretStoreError("Toolroll's own folder can't be found, so the secrets it holds can't be used."); }
  }
  const problem = refusedRoots.get(root);
  if (problem !== undefined) throw new SecretStoreError(problem);
  const known = folders.get(root);
  if (known !== undefined && unchanged(known)) return known;
  // Changed since it was checked (or never seen): checked against the same record (the database's, for Toolroll's
  // own folder; this process's, for a test's), and refused if it doesn't match.
  const named = pending.get(root);
  const again = prepareSecretFolder(root, known?.anchor ?? named?.anchor ?? memoryAnchor(), { create: true, legacy: known?.legacy ?? named?.legacy ?? null, standing: root === standing });
  if (!again.ok) throw new SecretStoreError(again.problem);
  return folders.get(root)!;
}

/** Forget every prepared folder (tests). */
export function forgetSecretFolders(): void { folders.clear(); refusedRoots.clear(); pending.clear(); standing = null; standingProblem = null; }

/** The keychain service for everything kept for this folder's Toolroll: its folder, hashed. Never a secret. */
export const serviceOf = (folder: SecretFolder): string => `toolroll-tool-secrets.${createHash("sha256").update(folder.root).digest("hex").slice(0, 12)}`;

// ---- files inside it ---------------------------------------------------------------------------------------------

/**
 * A path inside `base` (the folder, or Toolroll's own folder above it), each folder on the way checked: a real folder
 * of this user's that nobody else can write, never a link. Made owner-only when `make` (else a missing one ends the
 * walk: nothing is there).
 */
export function pathIn(base: string, parts: readonly string[], options: { make?: boolean } = {}): string {
  for (const part of parts) if (!SAFE.test(part) || part === "." || part === "..") throw new SecretStoreError("A secret's address can't be used.");
  let at = base;
  for (const part of parts.slice(0, -1)) {
    at = join(at, part);
    let info: Stats | null = null;
    try { info = lstatSync(at); } catch (error) { if (codeOf(error) !== "ENOENT") refuse(at, "can't be read"); }
    if (info === null) {
      if (options.make !== true) return join(base, ...parts);
      try { mkdirSync(at, { mode: 0o700 }); } catch (error) { if (codeOf(error) !== "EEXIST") throw error; }
      info = lstatSync(at);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) refuse(at, "isn't a folder Toolroll made");
    if (!mine(info) || (info.mode & 0o022) !== 0) refuse(at, "can be changed by other users");
  }
  return join(base, ...parts);
}

/** A file's text, read without following a link; null when there is none. Anything not plainly Toolroll's is refused. */
export function readOwnFile(path: string): string | null {
  const opened = openOwnFile(path, constants.O_RDONLY);
  if (opened === null) return null;
  try {
    const bytes = Buffer.alloc(opened.info.size);
    let read = 0;
    while (read < bytes.length) { const got = readSync(opened.fd, bytes, read, bytes.length - read, read); if (got === 0) break; read += got; }
    return bytes.subarray(0, read).toString("utf8");
  } finally { closeSync(opened.fd); }
}

/** Write a file whole and owner-only: a new file beside it, then renamed over it, so a link or second name planted there is replaced, never written through. */
export function writeOwnFile(path: string, text: string): void {
  const staged = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.new`;
  const fd = openSync(staged, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(staged, path);
}

/** A file's bytes overwritten, then the file removed (a link is only removed, never followed). */
export function destroyOwnFile(path: string): void {
  try {
    const opened = openOwnFile(path, constants.O_WRONLY);
    if (opened !== null) try { writeSync(opened.fd, Buffer.alloc(opened.info.size)); fsyncSync(opened.fd); } finally { closeSync(opened.fd); }
  } catch { /* removed below either way */ }
  rmSync(path, { force: true });
  try { lstatSync(path); throw new SecretStoreError("A secrets file couldn't be removed after its move to the keychain."); } catch (error) { if (error instanceof SecretStoreError) throw error; }
}

const lockFile = (folder: SecretFolder, name: string) => pathIn(folder.dir, [".locks", `${name}.lock`], { make: true });
const takeLock = (lock: string, staleMs: number): boolean => {
  try { closeSync(openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)); return true; } catch (error) {
    if (codeOf(error) !== "EEXIST") throw new SecretStoreError("A lock for Toolroll's secrets can't be made.");
    // A lock left by a process that died is old: taken over.
    try { if (Date.now() - lstatSync(lock).mtimeMs > staleMs) unlinkSync(lock); } catch { /* gone already */ }
    return false;
  }
};

const held = new Map<string, number>();
/** One change at a time to what `name` keeps, across Toolroll's processes (a lock file in the folder), re-entrant within one. */
export function withSecretLock<T>(folder: SecretFolder, name: string, work: () => T): T {
  const lock = lockFile(folder, name);
  if ((held.get(lock) ?? 0) > 0) { held.set(lock, held.get(lock)! + 1); try { return work(); } finally { held.set(lock, held.get(lock)! - 1); } }
  for (let tries = 0; !takeLock(lock, 30_000); tries++) {
    if (tries > 400) throw new SecretStoreError("A tool's secrets are being changed elsewhere. Try again in a moment.");
    pause(25);
  }
  held.set(lock, 1);
  try { return work(); } finally { held.delete(lock); rmSync(lock, { force: true }); }
}

/** The same, for work that waits on the network (renewing a sign-in): other processes wait for it, up to `waitMs`. */
export async function withSecretLockAsync<T>(folder: SecretFolder, name: string, work: () => Promise<T>, options: { staleMs?: number; waitMs?: number } = {}): Promise<T> {
  const lock = lockFile(folder, name), started = Date.now();
  while (!takeLock(lock, options.staleMs ?? 120_000)) {
    if (Date.now() - started > (options.waitMs ?? 120_000)) throw new SecretStoreError("A sign-in is being renewed elsewhere. Try again in a moment.");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  try { return await work(); } finally { rmSync(lock, { force: true }); }
}

// ---- sealed with the folder's key ----------------------------------------------------------------------------------

const SEALED = /^w1\.([A-Za-z0-9_-]+)$/;
const aad = (item: SecretItem) => Buffer.from(`toolroll:tool-secret:v1:${item.service}/${item.account}`);

/** `text` sealed for `item` with the folder's key. */
export function seal(text: string, item: SecretItem, folder: SecretFolder): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", folder.key, iv).setAAD(aad(item));
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return `w1.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url")}`;
}

/** What `seal` sealed for `item`; refused when it was sealed for another item, with another key, or changed. */
export function unseal(sealed: string, item: SecretItem, folder: SecretFolder): string {
  const raw = SEALED.exec(sealed)?.[1];
  if (raw === undefined) throw new SecretStoreError("A tool's stored secrets can't be opened; set them again on the Tools page.");
  const bytes = Buffer.from(raw, "base64url");
  try {
    const decipher = createDecipheriv("aes-256-gcm", folder.key, bytes.subarray(0, 12)).setAAD(aad(item));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretStoreError("A tool's stored secrets can't be opened; set them again on the Tools page.");
  }
}

/** The sealed text kept at `item`, opened; null when nothing is. */
export function readSealed(backend: SecretBackend, folder: SecretFolder, item: SecretItem): string | null {
  const text = readValue(backend, item);
  return text === null ? null : unseal(text, item, folder);
}

/** Keep `text` at `item`, sealed. */
export function writeSealed(backend: SecretBackend, folder: SecretFolder, item: SecretItem, text: string, options: { create?: boolean } = {}): "ok" | "exists" {
  return writeValue(backend, item, seal(text, item, folder), options);
}

// ---- what Toolroll holds for integrations -------------------------------------------------------------------------

const HELD_NAME = /^[a-z][a-z0-9-]{0,40}(\.[0-9]{1,12})?$/;
const heldItem = (folder: SecretFolder, name: string): SecretItem => {
  if (!HELD_NAME.test(name)) throw new SecretStoreError("A secret's address can't be used.");
  return { service: serviceOf(folder), account: `held.${name}` };
};

/**
 * A secret's file, as it was kept before the keychain, moved in: stored, read back and compared, and only then is the
 * file destroyed. What the keychain already holds (an earlier move, or a change since) wins over the file. A failure
 * leaves the file as it was, and says so.
 */
function moveHeldIn(backend: SecretBackend, folder: SecretFolder, name: string, file: string): void {
  // A link, or a file not plainly Toolroll's, put where the old file was: kept as it is, and never used.
  let before: string | null;
  try { before = readOwnFile(file); } catch { before = null; }
  if (before === null) return;
  const item = heldItem(folder, name);
  if (writeSealed(backend, folder, item, before, { create: true }) === "ok") {
    let back: string | null = null;
    try { back = readSealed(backend, folder, item); } catch { back = null; }
    if (back !== before) {
      try { removeValue(backend, item); } catch { /* the file stays the copy that counts */ }
      throw new SecretStoreError("A secret couldn't be moved to the keychain; it stays in its file until it can.");
    }
  }
  destroyOwnFile(file);
}

/**
 * A secret Toolroll holds for an integration, by `name` ("linear-key", "google-mail", "flow-hook.12"), for the
 * Toolroll whose folder is `state`. `file` (inside `state`) is where it was kept before, and still is where there's no
 * keychain. The first read or write with a keychain moves the file in.
 */
export function readHeldSecret(state: string, name: string, file: readonly string[]): string | null {
  const folder = secretFolder(state);
  const path = pathIn(folder.root, file);
  const backend = secretBackend();
  if (backend === null) return readOwnFile(path);
  return withSecretLock(folder, `held.${name}`, () => {
    moveHeldIn(backend, folder, name, path);
    return readSealed(backend, folder, heldItem(folder, name));
  });
}

/** Keep (or, with null, remove) a held secret: see readHeldSecret. */
export function writeHeldSecret(state: string, name: string, file: readonly string[], value: string | null): void {
  const folder = secretFolder(state);
  const path = pathIn(folder.root, file, { make: true });
  const backend = secretBackend();
  if (backend === null) {
    if (value === null) destroyOwnFile(path);
    else writeOwnFile(path, value);
    return;
  }
  withSecretLock(folder, `held.${name}`, () => {
    moveHeldIn(backend, folder, name, path);
    const item = heldItem(folder, name);
    if (value === null) removeValue(backend, item);
    else writeSealed(backend, folder, item, value);
  });
}

/** Whether a held secret has a value, without reading it where that can be helped. */
export function heldSecretSet(state: string, name: string, file: readonly string[]): boolean {
  try { return readHeldSecret(state, name, file) !== null; } catch { return false; }
}
