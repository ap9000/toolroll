/**
 * Tool secrets at rest: the macOS Keychain (driven over `security -i`'s
 * stdin), the Secret Service (`secret-tool`, value on stdin), or owner-only
 * files where there is neither. A canary secret is looked for in every
 * program's arguments (recorded by a wrapper, and in a live process listing
 * where this sandbox allows `ps`), in the files left behind, and — through
 * Settings over HTTP — in the database (its ledger included) and the logs.
 * Existing files move into the keychain on first use and leave no plaintext.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { addToolTo, clearToolSecrets, credentialModeOf, prepareRunTools, readToolSecrets, secretsSetFor, setToolSecret, setToolSecrets, toolSecretStorage, toolSecretsDir, type ToolSpec } from "./project-tools.js";
import { SecretStoreError, chooseSecretStore, macosKeychain, readValue, secretService, writeValue, type SecretBackend } from "./tool-secret-store.js";
import { agentFence, macosFenceAvailable, macosFenceProfile } from "./agent-fence.js";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { T0 } from "../test/serve-kit.js";
import { connectedSpec } from "./mcp-connect.js";

const MAC = process.platform === "darwin" && existsSync("/usr/bin/security");
/** A canary long enough to need several keychain chunks, starting with "-" so a chunk could pass for an option. */
const CANARY = `-canary-${"k3y".repeat(2_600)}-end`;
const REPO = "/repo/shop";
const spec: ToolSpec = { name: "sentry", transport: "stdio", command: process.execPath, args: ["-e", "process.exit(3)"], url: null, secrets: [{ name: "SENTRY_ACCESS_TOKEN", optional: false }, { name: "SENTRY_HOST", optional: true }], bearer: null, headerSecrets: {}, about: "Sentry." };

let dir: string, home: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-secret-store-")));
  home = join(dir, "home");
  mkdirSync(home);
});
afterEach(() => {
  chooseSecretStore(null);
  rmSync(dir, { recursive: true, force: true });
});

/** Every file under `root`, read whole. */
const filesUnder = (root: string): { path: string; text: string }[] => !existsSync(root) ? [] : readdirSync(root, { recursive: true, withFileTypes: true })
  .filter(one => one.isFile()).map(one => { const path = join(one.parentPath, one.name); return { path, text: readFileSync(path, "utf8") }; });

/** A wrapper around a store's program that records each call's arguments, never its stdin. */
function recorded(real: string): { binary: string; argv: () => string } {
  const log = join(dir, "argv.log"), binary = join(dir, "store-wrapper");
  writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${real}' "$@"\n`);
  chmodSync(binary, 0o755);
  return { binary, argv: () => existsSync(log) ? readFileSync(log, "utf8") : "" };
}

/** Process listings taken over and over while `work` runs, when this sandbox lets `ps` read them; null when it doesn't. */
async function watchProcesses(work: () => void | Promise<void>): Promise<string | null> {
  if (spawnSync("ps", ["-axww", "-o", "args="], { encoding: "utf8" }).status !== 0) { await work(); return null; }
  const out = join(dir, "ps.log");
  const watcher = spawn("/bin/sh", ["-c", `while :; do ps -axww -o args= >> '${out}'; done`], { stdio: "ignore" });
  await new Promise(resolve => setTimeout(resolve, 50));
  try { await work(); } finally { watcher.kill("SIGKILL"); }
  return readFileSync(out, "utf8");
}

describe.skipIf(!MAC)("the macOS Keychain, through security -i", () => {
  let keychain: string, wrapper: ReturnType<typeof recorded>;
  beforeEach(() => {
    keychain = join(dir, "test.keychain-db");
    expect(spawnSync("/usr/bin/security", ["create-keychain", "-p", "test-password", keychain]).status).toBe(0);
    expect(spawnSync("/usr/bin/security", ["unlock-keychain", "-p", "test-password", keychain]).status).toBe(0);
    wrapper = recorded("/usr/bin/security");
    chooseSecretStore(macosKeychain({ keychain, binary: wrapper.binary }));
  });
  afterEach(() => { spawnSync("/usr/bin/security", ["delete-keychain", keychain]); });

  test("a secret is stored and read over stdin: no program's arguments, process listing or file here ever holds it", async () => {
    let read: Record<string, string> = {};
    const listing = await watchProcesses(() => {
      setToolSecrets(REPO, "sentry", { SENTRY_ACCESS_TOKEN: CANARY, SENTRY_HOST: "sentry.example.com" }, home);
      read = readToolSecrets(REPO, "sentry", home);
    });
    expect(read.SENTRY_ACCESS_TOKEN === CANARY && read.SENTRY_HOST === "sentry.example.com" && Object.keys(read).length === 2).toBe(true);
    expect(wrapper.argv()).toMatch(/^-i$/m);
    expect(wrapper.argv().split("\n").filter(Boolean).every(line => line === "-i")).toBe(true);
    expect(wrapper.argv()).not.toContain("canary");
    if (listing !== null) {
      expect(listing).toContain("security -i");
      expect(listing).not.toContain("canary");
    }
    // What rests in Toolroll's folder is the names alone.
    for (const one of filesUnder(toolSecretsDir(home))) expect(one.text).not.toContain("canary");
    expect(secretsSetFor(REPO, spec, home)).toEqual(["SENTRY_ACCESS_TOKEN", "SENTRY_HOST"]);
    // The item is in the keychain, under an address that names no secret.
    const dump = spawnSync("/usr/bin/security", ["dump-keychain", keychain], { encoding: "utf8" }).stdout;
    expect(dump).toContain("toolroll-tool-secrets.");
    expect(dump).toContain('"Toolroll tool secret"');
    expect(dump).not.toContain("canary");
  });

  test("bypass: a fenced build can reach the keychain, but every item it reads is sealed, and the key is behind the fence", () => {
    setToolSecrets(REPO, "sentry", { SENTRY_ACCESS_TOKEN: CANARY }, home);
    // What any process of this user can do with `security`, the agent's included: read every item Toolroll keeps.
    const dump = spawnSync("/usr/bin/security", ["dump-keychain", keychain], { encoding: "utf8" }).stdout;
    const accounts = [...dump.matchAll(/"acct"<blob>="([^"]+)"/g)].map(match => match[1]!).sort();
    const service = /"svce"<blob>="([^"]+)"/.exec(dump)![1]!;
    expect(accounts.length).toBeGreaterThan(2);
    const items = accounts.map(account => spawnSync("/usr/bin/security", ["find-generic-password", "-a", account, "-s", service, "-w", keychain], { encoding: "utf8" }).stdout.trim());
    const head = items.find(one => one.startsWith("v1."))!;
    const stored = Buffer.from([head.split(".").slice(4).join("."), ...items.filter(one => one.startsWith("c.")).map(one => one.slice(2))].join(""), "base64url").toString("utf8");
    expect(stored).toMatch(/^w1\.[A-Za-z0-9_-]+$/);
    for (const one of [...items, stored]) expect(one).not.toContain("canary");
    // The key that opens them is in Toolroll's own folder, which every build's fence denies.
    const key = join(toolSecretsDir(home), ".keychain-key");
    expect(statSync(key).mode & 0o777).toBe(0o600);
    expect(agentFence({ databaseFile: null, worktree: null, home }).some(path => key.startsWith(`${path}/`))).toBe(true);
  });

  test.skipIf(!macosFenceAvailable())("bypass, in the real sandbox: a fenced shell reads an item's ciphertext but not the key that opens it", () => {
    setToolSecrets(REPO, "sentry", { SENTRY_ACCESS_TOKEN: CANARY }, home);
    const key = join(toolSecretsDir(home), ".keychain-key");
    const dump = spawnSync("/usr/bin/security", ["dump-keychain", keychain], { encoding: "utf8" }).stdout;
    const head = [...dump.matchAll(/"acct"<blob>="([^"]+)"/g)].map(match => match[1]!).find(account => /^[0-9a-f]{16}\.sentry$/.test(account))!;
    const service = /"svce"<blob>="([^"]+)"/.exec(dump)![1]!;
    const profile = macosFenceProfile(agentFence({ databaseFile: null, worktree: null, home }));
    const fenced = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/sh", "-c",
      `/usr/bin/security find-generic-password -a '${head}' -s '${service}' -w '${keychain}'; echo "key: $(head -c 32 '${key}' 2>/dev/null | od -An -tx1 | tr -d ' \n' || true)"`], { encoding: "utf8" });
    expect(fenced.stdout).toMatch(/^v1\./);
    expect(fenced.stdout).not.toContain("canary");
    expect(fenced.stdout).toContain("key: \n");
  });

  test("a change replaces the value whole, and clearing removes every item it used", () => {
    setToolSecrets(REPO, "sentry", { SENTRY_ACCESS_TOKEN: CANARY }, home);
    setToolSecret(REPO, "sentry", "SENTRY_ACCESS_TOKEN", "short-token", home);
    expect(readToolSecrets(REPO, "sentry", home)).toEqual({ SENTRY_ACCESS_TOKEN: "short-token" });
    const items = () => (spawnSync("/usr/bin/security", ["dump-keychain", keychain], { encoding: "utf8" }).stdout.match(/"acct"<blob>=/g) ?? []).length;
    // The long value's chunks went with it: one item for the tool.
    expect(items()).toBe(1);
    clearToolSecrets(REPO, "sentry", home);
    expect(items()).toBe(0);
    expect(readToolSecrets(REPO, "sentry", home)).toEqual({});
    expect(secretsSetFor(REPO, spec, home)).toEqual([]);
  });

  test("an existing secrets file moves into the keychain on first use, verified, and no plaintext copy is left", () => {
    chooseSecretStore("files");
    setToolSecrets(REPO, "sentry", { SENTRY_ACCESS_TOKEN: CANARY }, home);
    const file = filesUnder(toolSecretsDir(home)).find(one => one.text.includes("canary"))!.path;
    expect(statSync(file).mode & 0o777).toBe(0o600);
    chooseSecretStore(macosKeychain({ keychain, binary: wrapper.binary }));
    expect(readToolSecrets(REPO, "sentry", home)).toEqual({ SENTRY_ACCESS_TOKEN: CANARY });
    expect(existsSync(file)).toBe(false);
    for (const one of filesUnder(toolSecretsDir(home))) expect(one.text).not.toContain("canary");
    // Moved once: the next read is the keychain's alone.
    expect(readToolSecrets(REPO, "sentry", home)).toEqual({ SENTRY_ACCESS_TOKEN: CANARY });
    expect(wrapper.argv()).not.toContain("canary");
  });
});

/** A Secret Service on any computer: a stand-in `secret-tool` that keeps items in a folder and records its arguments. */
function fakeSecretTool(): { binary: string; argv: () => string; items: string } {
  const items = join(dir, "keyring"), log = join(dir, "secret-tool.log"), binary = join(dir, "secret-tool");
  mkdirSync(items);
  writeFileSync(binary, `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const [command, ...rest] = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + "\\n");
const attrs = rest.filter(one => !one.startsWith("--"));
const file = path.join(${JSON.stringify(items)}, Buffer.from(attrs.join("\\u0000")).toString("hex"));
if (command === "store") { fs.writeFileSync(file, fs.readFileSync(0)); process.exit(0); }
if (command === "lookup") { if (!fs.existsSync(file)) process.exit(1); process.stdout.write(fs.readFileSync(file)); process.exit(0); }
if (command === "clear") { fs.rmSync(file, { force: true }); process.exit(0); }
process.exit(2);
`);
  chmodSync(binary, 0o755);
  return { binary, argv: () => existsSync(log) ? readFileSync(log, "utf8") : "", items };
}

test("the Secret Service gets the value on stdin: its arguments name only the item, and an old file moves in on first use", () => {
  const tool = fakeSecretTool();
  chooseSecretStore("files");
  setToolSecrets(REPO, "sentry", { SENTRY_HOST: "sentry.example.com" }, home);
  chooseSecretStore(secretService({ binary: tool.binary }));
  setToolSecret(REPO, "sentry", "SENTRY_ACCESS_TOKEN", CANARY, home);
  const read = readToolSecrets(REPO, "sentry", home);
  expect(read.SENTRY_ACCESS_TOKEN === CANARY && read.SENTRY_HOST === "sentry.example.com").toBe(true);
  expect(tool.argv()).toContain("store --label=Toolroll tool secret service toolroll-tool-secrets.");
  expect(tool.argv()).not.toContain("canary");
  for (const one of filesUnder(toolSecretsDir(home))) expect(one.text).not.toContain("canary");
  expect(filesUnder(toolSecretsDir(home)).some(one => one.text.includes("sentry.example.com"))).toBe(false);
});

/** A keychain kept in memory, with a fault to inject. */
function memoryKeychain(fault: { read?: (value: string) => string; fail?: boolean } = {}): SecretBackend & { items: Map<string, string> } {
  const items = new Map<string, string>();
  const key = (item: { service: string; account: string }) => `${item.service}/${item.account}`;
  return {
    kind: "macos-keychain", limit: 3_000, items,
    get: item => { if (fault.fail) throw new SecretStoreError("The macOS Keychain refused to read a tool's secrets. Unlock it and try again."); const value = items.get(key(item)); return value === undefined ? null : fault.read?.(value) ?? value; },
    set: (item, value, options = {}) => { if (options.create && items.has(key(item))) return "exists"; items.set(key(item), value); return "ok"; },
    remove: item => { items.delete(key(item)); },
  };
}

test("a move that doesn't read back the same keeps the file, removes the bad copy and says so; nothing is lost", () => {
  chooseSecretStore("files");
  setToolSecrets(REPO, "sentry", { SENTRY_ACCESS_TOKEN: CANARY }, home);
  const file = filesUnder(toolSecretsDir(home)).find(one => one.text.includes("canary"))!.path;
  const broken = memoryKeychain({ read: value => value.replace(/[a-f0-9]{16}\./, "0000000000000000.") });
  chooseSecretStore(broken);
  expect(() => readToolSecrets(REPO, "sentry", home)).toThrow("couldn't be moved to the keychain; they stay in their file");
  expect(readFileSync(file, "utf8")).toContain(CANARY);
  expect(broken.items.size).toBe(0);
  // The keychain works again: the move completes.
  chooseSecretStore(memoryKeychain());
  expect(readToolSecrets(REPO, "sentry", home)).toEqual({ SENTRY_ACCESS_TOKEN: CANARY });
  expect(existsSync(file)).toBe(false);
});

test("secrets already in the keychain win over a stale file: an old value is never brought back", () => {
  const keychain = memoryKeychain();
  chooseSecretStore(keychain);
  setToolSecrets(REPO, "sentry", { SENTRY_ACCESS_TOKEN: "newer-token" }, home);
  // A file from before, as a crash between the move and its removal would leave one.
  chooseSecretStore("files");
  setToolSecrets(REPO, "sentry", { SENTRY_ACCESS_TOKEN: "older-token" }, home);
  chooseSecretStore(keychain);
  expect(readToolSecrets(REPO, "sentry", home)).toEqual({ SENTRY_ACCESS_TOKEN: "newer-token" });
  expect(filesUnder(toolSecretsDir(home)).some(one => one.text.includes("older-token"))).toBe(false);
});

test("a keychain that refuses is never quietly replaced by files: a run leaves the tool out, and no file is written", async () => {
  chooseSecretStore(memoryKeychain({ fail: true }));
  expect(() => setToolSecret(REPO, "sentry", "SENTRY_ACCESS_TOKEN", CANARY, home)).toThrow(SecretStoreError);
  expect(filesUnder(toolSecretsDir(home)).some(one => one.text.includes("canary"))).toBe(false);
  const store = openStore(join(dir, "orders.db"));
  try {
    expect(addApprover(store, "alex", T0).ok).toBe(true);
    chooseSecretStore(memoryKeychain());
    expect(addToolTo(store, REPO, spec, "custom", "alex", T0, { home })).toMatchObject({ ok: true });
    chooseSecretStore(memoryKeychain({ fail: true }));
    const runs = { projectTools: (one: string) => store.projectTools(one), orgPolicy: () => store.orgPolicy(), getRun: () => ({ taskRef: 1 }), refById: () => ({ repo: REPO, externalId: "t" }), getScope: () => null, toolSealFor: () => null, recordRunTools: () => undefined } as unknown as Parameters<typeof prepareRunTools>[0];
    await expect(prepareRunTools(runs, 1, "claude", { home, now: T0 })).rejects.toThrow(SecretStoreError);
  } finally { store.close(); }
});

test("bypass: an item copied onto another tool's address, a missing key or one readable by others is refused, never read as empty", () => {
  const keychain = memoryKeychain();
  chooseSecretStore(keychain);
  setToolSecrets(REPO, "sentry", { SENTRY_ACCESS_TOKEN: "sentry-token" }, home);
  setToolSecrets(REPO, "linear", { LINEAR_TOKEN: "linear-token" }, home);
  // A build that can write the keychain moves Sentry's sealed item onto Linear's address.
  const [sentry] = [...keychain.items.keys()].filter(key => key.endsWith(".sentry"));
  const [linear] = [...keychain.items.keys()].filter(key => key.endsWith(".linear"));
  keychain.items.set(linear!, keychain.items.get(sentry!)!);
  expect(() => readToolSecrets(REPO, "linear", home)).toThrow("can't be opened");
  expect(readToolSecrets(REPO, "sentry", home)).toEqual({ SENTRY_ACCESS_TOKEN: "sentry-token" });
  const key = join(toolSecretsDir(home), ".keychain-key");
  chmodSync(key, 0o644);
  expect(() => readToolSecrets(REPO, "sentry", home)).toThrow("readable by other users");
  chmodSync(key, 0o600);
  rmSync(key);
  expect(() => readToolSecrets(REPO, "sentry", home)).toThrow("can't be opened");
});

test("a stored value is split into chunks the keychain holds, read back whole, and a damaged one is refused", () => {
  const keychain = memoryKeychain();
  const item = { service: "toolroll-tool-secrets.test", account: "abc.sentry" };
  writeValue(keychain, item, CANARY);
  expect(keychain.items.size).toBeGreaterThan(3);
  expect([...keychain.items.values()].every(value => value.length <= 3_000 && /^[A-Za-z0-9._-]+$/.test(value) && !value.startsWith("-"))).toBe(true);
  expect(readValue(keychain, item)).toBe(CANARY);
  const [chunk] = [...keychain.items.keys()].filter(key => key.endsWith(".1"));
  keychain.items.set(chunk!, "c.AAAA");
  expect(() => readValue(keychain, item)).toThrow("damaged");
});

test("where there is no keychain, Settings and the CLI say plainly that secrets are file-protected only", () => {
  chooseSecretStore("files");
  expect(toolSecretStorage()).toEqual({ kind: "files", words: "Secrets are protected by owner-only files on this computer.", filesOnly: true });
  chooseSecretStore(memoryKeychain());
  expect(toolSecretStorage()).toMatchObject({ kind: "macos-keychain", filesOnly: false });
  expect(credentialModeOf(spec, ["SENTRY_ACCESS_TOKEN"])?.words).toBe("Key held by Toolroll");
});

describe("through Settings, end to end", () => {
  let store: Store, server: Server, base: string, token: string;
  const output: string[] = [];
  beforeEach(async () => {
    output.length = 0;
    for (const stream of [process.stdout, process.stderr]) vi.spyOn(stream, "write").mockImplementation((chunk: string | Uint8Array) => { output.push(String(chunk)); return true; });
    for (const level of ["log", "info", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { output.push(args.map(String).join(" ")); });
    store = openStore(join(dir, "orders.db"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap");
    token = added.token;
    server = createDecisionServer({ store, evidenceRoot: home, clock: () => new Date(), repos: [REPO], toolHome: home, codexToolList: async () => null } as Parameters<typeof createDecisionServer>[0]);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  });

  test("a key saved on the Tools page reaches the keychain alone: never the database, its ledger, a log or the page", async () => {
    const keychain = memoryKeychain();
    chooseSecretStore(keychain);
    expect(addToolTo(store, REPO, spec, "custom", "alex", T0, { home })).toMatchObject({ ok: true });
    const cookie = (await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token }), redirect: "manual" })).headers.get("set-cookie")!.split(";")[0]!;
    const before = await (await fetch(`${base}/settings/tools?repo=${encodeURIComponent(REPO)}`, { headers: { cookie } })).text();
    const csrf = /<input type="hidden" name="csrf" value="([^"]+)">/.exec(before)![1]!;
    const saved = await fetch(`${base}/settings/tools/change`, { method: "POST", headers: { cookie, origin: base }, redirect: "manual",
      body: new URLSearchParams({ csrf, repo: REPO, shown: REPO, action: "secret", name: "sentry", secret: "SENTRY_ACCESS_TOKEN", value: CANARY, password: token }) });
    expect(saved.status).toBe(303);
    expect(decodeURIComponent(saved.headers.get("location") ?? "")).toContain("Saved SENTRY_ACCESS_TOKEN for sentry");
    expect(readToolSecrets(REPO, "sentry", home)["SENTRY_ACCESS_TOKEN"] === CANARY).toBe(true);
    // A failed test of the tool, recorded on it: its words never carry the key.
    await fetch(`${base}/settings/tools/change`, { method: "POST", headers: { cookie, origin: base }, redirect: "manual", body: new URLSearchParams({ csrf, repo: REPO, shown: REPO, action: "test", name: "sentry", password: token }) }).catch(() => undefined);
    const shown = await (await fetch(`${base}/settings/tools?repo=${encodeURIComponent(REPO)}`, { headers: { cookie } })).text();
    expect(shown).toContain("Key held by Toolroll");
    expect(shown).not.toContain("canary");
    expect(output.join("\n")).not.toContain("canary");
    expect(store.handle.prepare("SELECT count(*) AS n FROM action_ledger").get()).toBeDefined();
    // A tool connected by signing in takes no pasted token, refresh token least of all: the post is refused.
    expect(addToolTo(store, REPO, connectedSpec("linear")!, "Linear, connected by signing in", "alex", T0, { home })).toMatchObject({ ok: true });
    const pasted = await fetch(`${base}/settings/tools/change`, { method: "POST", headers: { cookie, origin: base }, redirect: "manual",
      body: new URLSearchParams({ csrf, repo: REPO, shown: REPO, action: "secret", name: "linear", secret: "OAUTH_REFRESH_TOKEN", value: CANARY, password: token }) });
    expect(decodeURIComponent(pasted.headers.get("location") ?? "")).toContain("linear is connected by signing in. Sign in again from Connect to renew it.");
    expect(readToolSecrets(REPO, "linear", home)).toEqual({});
    store.handle.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    for (const file of ["orders.db", "orders.db-wal"].map(one => join(dir, one)).filter(existsSync)) expect(readFileSync(file).includes("canary")).toBe(false);
    for (const one of filesUnder(toolSecretsDir(home))) expect(one.text).not.toContain("canary");
  });
});
