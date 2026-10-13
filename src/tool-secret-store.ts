/**
 * Where project tool secrets rest: the operating system's keychain where this
 * computer has one, otherwise owner-only files.
 *
 * - macOS: the Keychain, through `/usr/bin/security -i`. Every command, the
 *   value included, is written to its stdin, so no secret is ever in a
 *   process's arguments. A line there holds about 4 KB, so a value is split
 *   into chunks: a head item names the chunks' generation and checksum, and is
 *   written last, so a reader sees the old value or the new one, never half.
 * - Linux: the Secret Service, through `secret-tool`, which reads the value
 *   from stdin.
 * - Anywhere else (or with TOOLROLL_SECRET_STORE=files): one 0600 file per
 *   tool, as before. Settings and `toolroll integrations` say so plainly.
 *
 * A keychain that is present but fails (locked, refused) is an error, never a
 * quiet fall back to files: what can't be read leaves the tool out of a run.
 *
 * A fenced build can reach the keychain too: the fence can't deny it (the
 * agent's own CLI keeps its sign-in there), and `security` reads any item it
 * made. So what Toolroll keeps there is sealed (AES-256-GCM) with a key in
 * Toolroll's own folder, which the fence does deny, and bound to its item's
 * address: a build that reads an item gets ciphertext, and one that swaps
 * items between tools gets a refusal.
 */
import { spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { accessSync, chmodSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { envValue } from "./names.js";

export type SecretStoreKind = "macos-keychain" | "secret-service" | "files";
/** One item's address: what the store lists, never a secret (a project's hash, a tool's name). */
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

/** The Secret Service (GNOME Keyring, KWallet), through `secret-tool`; the value goes on its stdin. */
export function secretService(options: { binary?: string } = {}): SecretBackend {
  const binary = options.binary ?? "secret-tool";
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

const onPath = (name: string, env: NodeJS.ProcessEnv): boolean => (env["PATH"] ?? "").split(delimiter).some(folder => {
  try { accessSync(join(folder, name), constants.X_OK); return true; } catch { return false; }
});

let detected: SecretBackend | null | undefined;
let chosen: SecretBackend | "files" | null = null;
/** Tests choose the store (a keychain file of their own, or files); null goes back to finding this computer's. */
export function chooseSecretStore(store: SecretBackend | "files" | null): void { chosen = store; }

/**
 * This computer's store, found once: the macOS Keychain where `security` is; a Secret Service that answers where
 * `secret-tool` is; else none (files). Asked for one that is missing, the answer is none, not an error.
 */
export function secretBackend(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): SecretBackend | null {
  if (chosen !== null) return chosen === "files" ? null : chosen;
  if (envValue(env, "SECRET_STORE") === "files") return null;
  if (detected !== undefined) return detected;
  detected = null;
  if (platform === "darwin" && existsSync("/usr/bin/security")) detected = macosKeychain();
  else if (platform === "linux" && onPath("secret-tool", env)) {
    // Present and answering: a lookup of nothing says "not found" quietly; no session bus says why on stderr.
    const probe = spawnSync("secret-tool", ["lookup", "service", "toolroll-probe", "account", "probe"], { encoding: "utf8", timeout: 5_000, env: storeEnv() });
    if (probe.error === undefined && (probe.status === 0 || (probe.status === 1 && probe.stderr.trim() === ""))) detected = secretService();
  }
  return detected;
}

export const secretStoreKind = (): SecretStoreKind => secretBackend()?.kind ?? "files";

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

// ---- sealed with a key the fence denies ---------------------------------------------------------------------------

/** The sealing key in `file` (32 bytes, owner-only), made on first use when `create`; null when there is none yet. */
function sealingKey(file: string, create: boolean): Buffer | null {
  let handle: number;
  try { handle = openSync(file, "r"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new SecretStoreError("The key that opens tool secrets can't be read.");
    if (!create) return null;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    try {
      const made = openSync(file, "wx", 0o600);
      try { writeSync(made, randomBytes(32)); } finally { closeSync(made); }
      chmodSync(file, 0o600);
    } catch (made) { if ((made as NodeJS.ErrnoException).code !== "EEXIST") throw new SecretStoreError("The key that seals tool secrets can't be made."); }
    return sealingKey(file, false);
  }
  try {
    // Readable by anyone else, it seals nothing: refused rather than used.
    if ((fstatSync(handle).mode & 0o077) !== 0) throw new SecretStoreError("The key that opens tool secrets is readable by other users; make it owner-only (chmod 600).");
    const key = Buffer.alloc(33);
    const read = readSync(handle, key, 0, 33, 0);
    if (read !== 32) throw new SecretStoreError("The key that opens tool secrets is damaged.");
    return key.subarray(0, 32);
  } finally { closeSync(handle); }
}

const SEALED = /^w1\.([A-Za-z0-9_-]+)$/;
const aad = (item: SecretItem) => Buffer.from(`toolroll:tool-secret:v1:${item.service}/${item.account}`);

/** `text` sealed for `item` with the key in `keyFile` (made the first time). */
export function seal(text: string, item: SecretItem, keyFile: string): string {
  const key = sealingKey(keyFile, true)!;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv).setAAD(aad(item));
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return `w1.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url")}`;
}

/** What `seal` sealed for `item`; refused when it was sealed for another item, changed, or the key is gone. */
export function unseal(sealed: string, item: SecretItem, keyFile: string): string {
  const raw = SEALED.exec(sealed)?.[1];
  const key = sealingKey(keyFile, false);
  if (raw === undefined || key === null) throw new SecretStoreError("A tool's stored secrets can't be opened; set them again on the Tools page.");
  const bytes = Buffer.from(raw, "base64url");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12)).setAAD(aad(item));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretStoreError("A tool's stored secrets can't be opened; set them again on the Tools page.");
  }
}
