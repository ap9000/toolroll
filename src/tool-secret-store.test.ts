/**
 * Secrets at rest: the macOS Keychain (driven over `security -i`'s stdin),
 * the Secret Service (`secret-tool`, value on stdin), or owner-only files
 * where there is neither, all in Toolroll's own folder beside its database.
 * A canary secret is looked for in every program's arguments (recorded by
 * the program itself, and in `ps` lines sampled while each one waits), in the
 * files left behind, and — through Settings over HTTP — in the database (its
 * ledger included) and the logs. Files kept before move in on first use and
 * leave no plaintext. A build that plants a folder, key, link or lock first
 * gets a refusal, never a secret.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, linkSync, lutimesSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Server } from "node:http";
import { addToolTo, clearToolSecrets, credentialModeOf, prepareRunTools, readToolSecrets, secretsSetFor, setToolSecret, setToolSecrets, startToolSecrets, toolSecretStorage, toolSecretsDir, type ToolSpec } from "./project-tools.js";
import {
  SECRET_TOOL_PATHS, SecretStoreError, UNANSWERED_WORDS, chooseSecretStore, detectSecretStore, forgetSecretFolders, macosKeychain, memoryAnchor, prepareSecretFolder,
  readValue, registerSecretFolder, secretService, trustedProgram, writeHeldSecret, writeValue, type SecretBackend,
} from "./tool-secret-store.js";
import { readLinearKey, readHookSecret, saveLinearKey } from "./flow-triggers.js";
import { readGoogleMail } from "./google-mail.js";
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
const REPO_HASH = createHash("sha256").update(REPO).digest("hex").slice(0, 16);
const spec: ToolSpec = { name: "sentry", transport: "stdio", command: process.execPath, args: ["-e", "process.exit(3)"], url: null, secrets: [{ name: "SENTRY_ACCESS_TOKEN", optional: false }, { name: "SENTRY_HOST", optional: true }], bearer: null, headerSecrets: {}, about: "Sentry." };
const uid = process.getuid?.() ?? 0;

/** `dir`: this test's own; `state`: Toolroll's folder (where its database is); `home`: the person's home. */
let dir: string, state: string, home: string, legacy: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-secret-store-")));
  state = join(dir, "toolroll");
  home = join(dir, "home");
  legacy = join(home, ".toolroll", "tool-secrets");
  mkdirSync(state, { mode: 0o700 });
  mkdirSync(home);
});
afterEach(() => {
  chooseSecretStore(null);
  // Back to this test file's own default folder (test/setup-state.ts), whatever a test started.
  forgetSecretFolders();
  registerSecretFolder(dirname(process.env.TOOLROLL_DB!), memoryAnchor());
  rmSync(dir, { recursive: true, force: true });
});

/** Toolroll's start: its folder made beside `state`, checked against `anchor`, with the home folder's old files to move in. */
const started = (anchor = memoryAnchor()) => {
  const made = prepareSecretFolder(state, anchor, { legacy: existsSync(legacy) ? legacy : null });
  expect(made).toMatchObject({ ok: true });
  return anchor;
};

/** Every file under `root`, read whole. */
const filesUnder = (root: string): { path: string; text: string }[] => !existsSync(root) ? [] : readdirSync(root, { recursive: true, withFileTypes: true })
  .filter(one => one.isFile()).map(one => { const path = join(one.parentPath, one.name); return { path, text: readFileSync(path, "utf8") }; });

/** A keychain kept in memory, with a fault to inject. */
function memoryKeychain(fault: { read?: (value: string) => string; fail?: boolean } = {}): SecretBackend & { items: Map<string, string> } {
  const items = new Map<string, string>();
  const key = (item: { service: string; account: string }) => `${item.service}/${item.account}`;
  return {
    kind: "macos-keychain", limit: 3_000, items,
    get: item => { if (fault.fail) throw new SecretStoreError("The macOS Keychain refused to read a tool's secrets. Unlock it and try again."); const value = items.get(key(item)); return value === undefined ? null : fault.read?.(value) ?? value; },
    set: (item, value, options = {}) => { if (fault.fail) throw new SecretStoreError("The macOS Keychain refused to save a tool's secrets. Unlock it and try again."); if (options.create && items.has(key(item))) return "exists"; items.set(key(item), value); return "ok"; },
    remove: item => { items.delete(key(item)); },
  };
}

// ---- stand-ins for the store's programs, which record their own arguments and can wait to be seen ------------------

/** Where a stand-in program writes: its arguments (as it got them), the pids it ran as, and which of those `ps` has seen. */
function standIn(name: string) {
  const root = join(dir, name);
  const paths = { binary: join(root, "bin", name), items: join(root, "items"), argv: join(root, "argv.log"), pids: join(root, "pids"), seen: join(root, "seen"), listing: join(root, "ps.log") };
  for (const folder of [dirname(paths.binary), paths.items, paths.pids, paths.seen]) mkdirSync(folder, { recursive: true });
  return paths;
}
/** The prelude every stand-in runs: record its own arguments, then (when `block`) wait, up to 5 seconds, until the sampler has seen it. */
const prelude = (paths: ReturnType<typeof standIn>, block: boolean) => `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
fs.appendFileSync(${JSON.stringify(paths.argv)}, process.argv.slice(2).join(" ") + "\\n");
if (${block}) {
  fs.writeFileSync(path.join(${JSON.stringify(paths.pids)}, String(process.pid)), "");
  const until = Date.now() + 5000;
  while (!fs.existsSync(path.join(${JSON.stringify(paths.seen)}, String(process.pid))) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
const input = fs.readFileSync(0, "utf8");
`;

/** `security -i` on any computer: its commands come on stdin, items are files. */
function fakeSecurity(options: { block?: boolean } = {}) {
  const paths = standIn("security");
  writeFileSync(paths.binary, `${prelude(paths, options.block === true)}
const words = (input.split("\\n")[0].match(/"[^"]*"|\\S+/g) || []);
const opt = name => { const at = words.indexOf(name); return at < 0 ? null : words[at + 1]; };
const file = () => path.join(${JSON.stringify(paths.items)}, Buffer.from(opt("-s") + "\\u0000" + opt("-a")).toString("hex"));
if (words[0] === "find-generic-password") { if (!fs.existsSync(file())) process.exit(44); process.stdout.write(fs.readFileSync(file(), "utf8") + "\\n"); process.exit(0); }
if (words[0] === "add-generic-password") { if (!words.includes("-U") && fs.existsSync(file())) process.exit(45); fs.writeFileSync(file(), opt("-w")); process.exit(0); }
if (words[0] === "delete-generic-password") { if (!fs.existsSync(file())) process.exit(44); fs.rmSync(file()); process.exit(0); }
process.exit(2);
`, { mode: 0o755 });
  return paths;
}

/** `secret-tool` on any computer: the value comes on stdin; `answers: false` is one with no session bus. */
function fakeSecretTool(options: { block?: boolean; answers?: boolean } = {}) {
  const paths = standIn("secret-tool");
  writeFileSync(paths.binary, `${prelude(paths, options.block === true)}
if (${options.answers === false}) { process.stderr.write("Cannot autolaunch D-Bus without X11 $DISPLAY\\n"); process.exit(1); }
const [command, ...rest] = process.argv.slice(2);
const attrs = rest.filter(one => !one.startsWith("--"));
const file = path.join(${JSON.stringify(paths.items)}, Buffer.from(attrs.join("\\u0000")).toString("hex"));
if (command === "store") { fs.writeFileSync(file, input); process.exit(0); }
if (command === "lookup") { if (!fs.existsSync(file)) process.exit(1); process.stdout.write(fs.readFileSync(file)); process.exit(0); }
if (command === "clear") { fs.rmSync(file, { force: true }); process.exit(0); }
process.exit(2);
`, { mode: 0o755 });
  return paths;
}

const lines = (file: string) => existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
/** A line safe to print in a failure: the canary and anything long and secret-shaped hidden. */
const redact = (line: string) => line.split(CANARY).join("[canary]").replace(/[A-Za-z0-9_-]{24,}/g, "[hidden]");

/**
 * `ps` lines for each stand-in process, taken while it waits to be seen: the sampler asks `ps` about those pids only
 * (`-p`), so no other program's arguments are ever read, kept or printed.
 */
const SAMPLER = `while :; do
  for f in "$PIDS"/*; do
    [ -e "$f" ] || continue
    p=\${f##*/}
    [ -e "$SEEN/$p" ] && continue
    line=$(ps -ww -o pid=,args= -p "$p" 2>/dev/null)
    if [ -n "$line" ]; then printf '%s\\n' "$line" >> "$LISTING"; : > "$SEEN/$p"; fi
  done
  sleep 0.01
done`;
const PS_WORKS = spawnSync("ps", ["-o", "pid=", "-p", String(process.pid)], { encoding: "utf8" }).status === 0;

async function sampled(paths: ReturnType<typeof standIn>, work: () => void): Promise<{ invoked: number; listing: string[] }> {
  const sampler = spawn("/bin/sh", ["-c", SAMPLER], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PIDS: paths.pids, SEEN: paths.seen, LISTING: paths.listing }, stdio: "ignore" });
  await new Promise(resolve => setTimeout(resolve, 20));
  try { work(); } finally { sampler.kill("SIGKILL"); }
  return { invoked: readdirSync(paths.pids).length, listing: lines(paths.listing) };
}

describe("no secret is ever in a store program's arguments", () => {
  test("security -i and secret-tool get every value on stdin: each program's own record of its arguments holds none", () => {
    started();
    const security = fakeSecurity();
    chooseSecretStore(macosKeychain({ binary: security.binary }));
    setToolSecrets(REPO, "sentry", { SENTRY_ACCESS_TOKEN: CANARY }, state);
    expect(readToolSecrets(REPO, "sentry", state).SENTRY_ACCESS_TOKEN === CANARY).toBe(true);
    writeHeldSecret(state, "linear-key", ["linear-key"], `lin_api_${CANARY}`);
    expect(lines(security.argv).length).toBeGreaterThan(4);
    expect(lines(security.argv).every(line => line === "-i")).toBe(true);
    const tool = fakeSecretTool();
    chooseSecretStore(secretService({ binary: tool.binary }));
    setToolSecrets(REPO, "linear", { LINEAR_TOKEN: CANARY }, state);
    expect(readToolSecrets(REPO, "linear", state).LINEAR_TOKEN === CANARY).toBe(true);
    expect(lines(tool.argv).some(line => line.startsWith("store --label=Toolroll tool secret service toolroll-tool-secrets."))).toBe(true);
    expect(lines(tool.argv).filter(line => line.includes("canary")).map(redact)).toEqual([]);
  });

  // `ps` can't read other processes inside a build's own fence; where it can, every program is seen while it waits.
  test.skipIf(!PS_WORKS)("ps, sampled while each store program waits to be seen, never shows a secret: macOS Keychain and Secret Service", async () => {
    started();
    for (const [paths, backend] of [(() => { const one = fakeSecurity({ block: true }); return [one, macosKeychain({ binary: one.binary })] as const; })(), (() => { const one = fakeSecretTool({ block: true }); return [one, secretService({ binary: one.binary })] as const; })()]) {
      chooseSecretStore(backend);
      const seen = await sampled(paths, () => {
        setToolSecrets(REPO, "sentry", { SENTRY_ACCESS_TOKEN: CANARY }, state);
        expect(readToolSecrets(REPO, "sentry", state).SENTRY_ACCESS_TOKEN === CANARY).toBe(true);
        clearToolSecrets(REPO, "sentry", state);
      });
      // Every run of the program was caught by ps, so the check below is real: none was missed, none slipped by.
      expect(seen.invoked).toBeGreaterThan(4);
      expect(seen.listing).toHaveLength(seen.invoked);
      expect(seen.listing.every(line => line.includes(paths.binary))).toBe(true);
      expect(seen.listing.filter(line => line.includes("canary")).map(redact)).toEqual([]);
    }
  });
});

describe.skipIf(!MAC)("the macOS Keychain, through security -i", () => {
  let keychain: string;
  beforeEach(() => {
    keychain = join(dir, "test.keychain-db");
    expect(spawnSync("/usr/bin/security", ["create-keychain", "-p", "test-password", keychain]).status).toBe(0);
    expect(spawnSync("/usr/bin/security", ["unlock-keychain", "-p", "test-password", keychain]).status).toBe(0);
    started();
    chooseSecretStore(macosKeychain({ keychain }));
  });
  afterEach(() => { spawnSync("/usr/bin/security", ["delete-keychain", keychain]); });

  test("a secret is stored and read back whole; what rests in Toolroll's folder is the names alone", () => {
    setToolSecrets(REPO, "sentry", { SENTRY_ACCESS_TOKEN: CANARY, SENTRY_HOST: "sentry.example.com" }, state);
    const read = readToolSecrets(REPO, "sentry", state);
    expect(read.SENTRY_ACCESS_TOKEN === CANARY && read.SENTRY_HOST === "sentry.example.com" && Object.keys(read).length === 2).toBe(true);
    for (const one of filesUnder(state)) expect(one.text).not.toContain("canary");
    expect(secretsSetFor(REPO, spec, state)).toEqual(["SENTRY_ACCESS_TOKEN", "SENTRY_HOST"]);
    // The item is in the keychain, under an address that names no secret.
    const dump = spawnSync("/usr/bin/security", ["dump-keychain", keychain], { encoding: "utf8" }).stdout;
    expect(dump).toContain("toolroll-tool-secrets.");
    expect(dump).toContain('"Toolroll tool secret"');
    expect(dump).not.toContain("canary");
  });

  test("bypass: a fenced build can reach the keychain, but every item it reads is sealed, and the key is behind the fence", () => {
    setToolSecrets(REPO, "sentry", { SENTRY_ACCESS_TOKEN: CANARY }, state);
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
    // The key that opens them is in Toolroll's own folder beside its database, which every build's fence denies.
    const key = join(toolSecretsDir(state), ".keychain-key");
    expect(statSync(key).mode & 0o777).toBe(0o600);
    expect(agentFence({ databaseFile: join(state, "orders.db"), worktree: null, home }).some(path => key.startsWith(`${path}/`))).toBe(true);
  });

  test.skipIf(!macosFenceAvailable())("bypass, in the real sandbox: a fenced shell reads an item's ciphertext but not the key that opens it", () => {
    setToolSecrets(REPO, "sentry", { SENTRY_ACCESS_TOKEN: CANARY }, state);
    const key = join(toolSecretsDir(state), ".keychain-key");
    const dump = spawnSync("/usr/bin/security", ["dump-keychain", keychain], { encoding: "utf8" }).stdout;
    const head = [...dump.matchAll(/"acct"<blob>="([^"]+)"/g)].map(match => match[1]!).find(account => /^[0-9a-f]{16}\.sentry$/.test(account))!;
    const service = /"svce"<blob>="([^"]+)"/.exec(dump)![1]!;
    const profile = macosFenceProfile(agentFence({ databaseFile: join(state, "orders.db"), worktree: null, home }));
    const fenced = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/sh", "-c",
      `/usr/bin/security find-generic-password -a '${head}' -s '${service}' -w '${keychain}'; echo "key: $(head -c 32 '${key}' 2>/dev/null | od -An -tx1 | tr -d ' \n' || true)"`], { encoding: "utf8" });
    expect(fenced.stdout).toMatch(/^v1\./);
    expect(fenced.stdout).not.toContain("canary");
    expect(fenced.stdout).toContain("key: \n");
  });

  test("a change replaces the value whole, and clearing removes every item it used", () => {
    setToolSecrets(REPO, "sentry", { SENTRY_ACCESS_TOKEN: CANARY }, state);
    setToolSecret(REPO, "sentry", "SENTRY_ACCESS_TOKEN", "short-token", state);
    expect(readToolSecrets(REPO, "sentry", state)).toEqual({ SENTRY_ACCESS_TOKEN: "short-token" });
    const items = () => (spawnSync("/usr/bin/security", ["dump-keychain", keychain], { encoding: "utf8" }).stdout.match(/"acct"<blob>=/g) ?? []).length;
    // The long value's chunks went with it: one item for the tool.
    expect(items()).toBe(1);
    clearToolSecrets(REPO, "sentry", state);
    expect(items()).toBe(0);
    expect(readToolSecrets(REPO, "sentry", state)).toEqual({});
    expect(secretsSetFor(REPO, spec, state)).toEqual([]);
  });
});

describe("Toolroll's folder for secrets: beside its database, made at start, and never one a build put there", () => {
  test("bypass: a folder and key planted beside the database before Toolroll's first start are refused, never used", () => {
    const database = join(state, "orders.db");
    const store = openStore(database);
    try {
      // The build, before Toolroll ever made its folder: a folder and a key of its own, a copy kept.
      mkdirSync(join(state, "tool-secrets"), { mode: 0o700 });
      writeFileSync(join(state, "tool-secrets", ".keychain-key"), randomBytes(32), { mode: 0o600 });
      const keychain = memoryKeychain();
      chooseSecretStore(keychain);
      startToolSecrets(store, database, () => T0, { eager: true });
      expect(toolSecretStorage().problem).toBe(`Secrets are switched off: ${join(state, "tool-secrets")} wasn't made by Toolroll. Remove it and restart Toolroll.`);
      expect(() => setToolSecrets(REPO, "sentry", { SENTRY_ACCESS_TOKEN: CANARY })).toThrow("wasn't made by Toolroll");
      expect(() => setToolSecrets(REPO, "sentry", { SENTRY_ACCESS_TOKEN: CANARY }, state)).toThrow("wasn't made by Toolroll");
      expect(() => saveLinearKey(state, `lin_api_${"x".repeat(30)}`)).not.toThrow();
      expect(saveLinearKey(state, `lin_api_${"x".repeat(30)}`)).toMatchObject({ ok: false });
      // Nothing was sealed with the planted key, nothing recorded as Toolroll's.
      expect(keychain.items.size).toBe(0);
      expect(store.toolSecretKeyDigest()).toBeNull();
    } finally { store.close(); }
  });

  test("Toolroll makes its folder at start and records its key; the next start accepts it, and a key swapped in between is refused", () => {
    const database = join(state, "orders.db");
    const store = openStore(database);
    try {
      chooseSecretStore(memoryKeychain());
      startToolSecrets(store, database, () => T0, { eager: true });
      const key = join(state, "tool-secrets", ".keychain-key");
      expect(statSync(join(state, "tool-secrets")).mode & 0o777).toBe(0o700);
      expect(statSync(key).mode & 0o777).toBe(0o600);
      expect(store.toolSecretKeyDigest()).toBe(createHash("sha256").update("toolroll:sealing-key:v1\u0000").update(readFileSync(key)).digest("hex"));
      setToolSecrets(REPO, "sentry", { SENTRY_ACCESS_TOKEN: "sentry-token" });
      // Another process of Toolroll's starts: the same folder and key, accepted.
      forgetSecretFolders();
      startToolSecrets(store, database, () => T0, { eager: true });
      expect(toolSecretStorage().problem).toBeUndefined();
      expect(readToolSecrets(REPO, "sentry")).toEqual({ SENTRY_ACCESS_TOKEN: "sentry-token" });
      // A key put in its place (by anything but Toolroll) is refused at its next use, in this process and the next.
      rmSync(key);
      writeFileSync(key, randomBytes(32), { mode: 0o600 });
      expect(() => readToolSecrets(REPO, "sentry")).toThrow("isn't the key Toolroll made");
      forgetSecretFolders();
      startToolSecrets(store, database, () => T0, { eager: true });
      expect(toolSecretStorage().problem).toContain("isn't the key Toolroll made");
    } finally { store.close(); }
  });

  test("bypass: a key planted in an old-named home folder (~/.nightorders) is never used: secrets are sealed with Toolroll's own", () => {
    const planted = randomBytes(32);
    mkdirSync(join(home, ".nightorders", "tool-secrets"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, ".nightorders", "tool-secrets", ".keychain-key"), planted, { mode: 0o600 });
    const keychain = memoryKeychain();
    chooseSecretStore(keychain);
    started();
    setToolSecrets(REPO, "sentry", { SENTRY_ACCESS_TOKEN: "sentry-token" }, state);
    expect(toolSecretsDir(state)).toBe(join(state, "tool-secrets"));
    // The build's copy of its key opens nothing Toolroll keeps.
    const sealed = readValue(keychain, { service: [...keychain.items.keys()][0]!.split("/")[0]!, account: `${REPO_HASH}.sentry` })!;
    const bytes = Buffer.from(sealed.slice(3), "base64url");
    expect(() => { const decipher = createDecipheriv("aes-256-gcm", planted, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28)); decipher.update(bytes.subarray(28)); decipher.final(); }).toThrow();
    expect(readdirSync(join(home, ".nightorders", "tool-secrets"))).toEqual([".keychain-key"]);
  });

  test("bypass: a folder that is a link (to somewhere a build can read) is refused, and no secret is written through it", () => {
    const elsewhere = join(dir, "elsewhere");
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, join(state, "tool-secrets"));
    chooseSecretStore("files");
    expect(prepareSecretFolder(state, memoryAnchor())).toEqual({ ok: false, problem: `Secrets are switched off: ${join(state, "tool-secrets")} isn't a folder Toolroll made. Remove it and restart Toolroll.` });
    expect(() => setToolSecrets(REPO, "sentry", { SENTRY_ACCESS_TOKEN: CANARY }, state)).toThrow("isn't a folder Toolroll made");
    expect(filesUnder(elsewhere)).toEqual([]);
  });

  test("bypass, with no keychain: a project folder planted as a link is refused; a second name planted for a secrets file is replaced, never written through", () => {
    chooseSecretStore("files");
    started();
    const outside = join(dir, "outside");
    mkdirSync(outside, { mode: 0o700 });
    symlinkSync(outside, join(state, "tool-secrets", REPO_HASH));
    expect(() => setToolSecrets(REPO, "sentry", { SENTRY_ACCESS_TOKEN: CANARY }, state)).toThrow("isn't a folder Toolroll made");
    expect(filesUnder(outside)).toEqual([]);
    rmSync(join(state, "tool-secrets", REPO_HASH));
    // A hard link: the same file under a name the build can still read once the folder is fenced.
    mkdirSync(join(state, "tool-secrets", REPO_HASH), { mode: 0o700 });
    writeFileSync(join(outside, "copy.json"), "{}", { mode: 0o600 });
    linkSync(join(outside, "copy.json"), join(state, "tool-secrets", REPO_HASH, "sentry.json"));
    expect(() => readToolSecrets(REPO, "sentry", state)).toThrow("has another name (a hard link)");
    rmSync(join(state, "tool-secrets", REPO_HASH, "sentry.json"));
    setToolSecrets(REPO, "sentry", { SENTRY_ACCESS_TOKEN: CANARY }, state);
    expect(readFileSync(join(outside, "copy.json"), "utf8")).toBe("{}");
    expect(statSync(join(state, "tool-secrets", REPO_HASH, "sentry.json")).mode & 0o777).toBe(0o600);
  });

  test("bypass: a lock planted as a link is taken over once stale and never followed; a key readable by others is refused", () => {
    chooseSecretStore(memoryKeychain());
    started();
    const target = join(dir, "planted-target");
    mkdirSync(join(state, "tool-secrets", ".locks"), { recursive: true, mode: 0o700 });
    const lock = join(state, "tool-secrets", ".locks", `${REPO_HASH}.sentry.lock`);
    symlinkSync(target, lock);
    lutimesSync(lock, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    setToolSecrets(REPO, "sentry", { SENTRY_ACCESS_TOKEN: "sentry-token" }, state);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(lock)).toBe(false);
    chmodSync(join(state, "tool-secrets", ".keychain-key"), 0o644);
    expect(() => readToolSecrets(REPO, "sentry", state)).toThrow(`Secrets are switched off: ${join(state, "tool-secrets", ".keychain-key")} is readable by other users. Make it owner-only (chmod 600) and restart Toolroll.`);
  });
});

describe("the keyring on Linux: the system's own secret-tool, and plainly files when it doesn't answer", () => {
  test("a secret-tool that can't reach a keyring (no session bus) means files, said plainly in Settings and toolroll integrations", () => {
    const tool = fakeSecretTool({ answers: false });
    const found = detectSecretStore({ platform: "linux", secretTools: [tool.binary], owners: [uid] });
    expect(found).toEqual({ backend: null, unanswered: true });
    chooseSecretStore(found);
    expect(toolSecretStorage()).toEqual({ kind: "files", words: UNANSWERED_WORDS, filesOnly: true });
    expect(UNANSWERED_WORDS).toBe("Secrets are protected by owner-only files on this computer: its keyring isn't answering.");
    // One that answers is used, by its full path.
    const answering = fakeSecretTool();
    const used = detectSecretStore({ platform: "linux", secretTools: [answering.binary], owners: [uid] });
    expect(used.backend?.kind).toBe("secret-service");
    started();
    chooseSecretStore(used);
    setToolSecrets(REPO, "sentry", { SENTRY_ACCESS_TOKEN: "sentry-token" }, state);
    expect(lines(answering.argv).some(line => line.startsWith("store "))).toBe(true);
  });

  test("bypass: a secret-tool put on PATH, or one others can change, is never run", () => {
    const planted = fakeSecretTool();
    const was = process.env.PATH;
    process.env.PATH = `${dirname(planted.binary)}:${was ?? ""}`;
    try {
      detectSecretStore({ platform: "linux" });
      expect(SECRET_TOOL_PATHS.every(path => path.startsWith("/usr/") || path.startsWith("/bin/"))).toBe(true);
      expect(lines(planted.argv)).toEqual([]);
    } finally { process.env.PATH = was; }
    // Owned by this user, it is no system program; writable by others, it is nobody's.
    expect(trustedProgram(planted.binary)).toBeNull();
    expect(trustedProgram(planted.binary, [uid])).toBe(planted.binary);
    chmodSync(planted.binary, 0o777);
    expect(trustedProgram(planted.binary, [uid])).toBeNull();
    expect(() => secretService({ binary: "secret-tool" })).toThrow("full path");
  });
});

describe("what was kept in files moves in on first use, verified, and no plaintext copy is left", () => {
  test("bypass: an old-named folder a build makes after the database's first start is never migrated in; one there at the first start is", () => {
    vi.stubEnv("HOME", home);
    const database = join(state, "orders.db");
    const store = openStore(database);
    try {
      const keychain = memoryKeychain();
      chooseSecretStore(keychain);
      // A fresh install: no old folder at the first start, and that is recorded.
      startToolSecrets(store, database, () => T0, { eager: true });
      expect(store.toolSecretLegacyDir(() => { throw new Error("probed again"); }, T0, { record: true })).toBeNull();
      // A build then makes one under an old name with values of its choosing for a tool's declared secrets.
      const planted = join(home, ".standing-orders", "tool-secrets", REPO_HASH);
      mkdirSync(planted, { recursive: true, mode: 0o700 });
      writeFileSync(join(planted, "sentry.json"), JSON.stringify({ SENTRY_ACCESS_TOKEN: CANARY, SENTRY_HOST: "attacker.example" }), { mode: 0o600 });
      forgetSecretFolders();
      startToolSecrets(store, database, () => T0, { eager: true });
      expect(readToolSecrets(REPO, "sentry") ?? {}).toEqual({});
      setToolSecrets(REPO, "sentry", { SENTRY_ACCESS_TOKEN: "owner-token" });
      expect(readToolSecrets(REPO, "sentry")).toEqual({ SENTRY_ACCESS_TOKEN: "owner-token" });
      expect(existsSync(join(planted, "sentry.json"))).toBe(true);
    } finally { store.close(); vi.unstubAllEnvs(); }
    // Legitimate: an upgrade whose old folder is there at the database's first start moves it in.
    const upgraded = join(dir, "upgraded");
    mkdirSync(upgraded, { mode: 0o700 });
    mkdirSync(join(legacy, REPO_HASH), { recursive: true, mode: 0o700 });
    writeFileSync(join(legacy, REPO_HASH, "sentry.json"), JSON.stringify({ SENTRY_ACCESS_TOKEN: "old-token" }), { mode: 0o600 });
    vi.stubEnv("HOME", home);
    const again = openStore(join(upgraded, "orders.db"));
    try {
      chooseSecretStore(memoryKeychain());
      forgetSecretFolders();
      startToolSecrets(again, join(upgraded, "orders.db"), () => T0, { eager: true });
      expect(again.toolSecretLegacyDir(() => null, T0, { record: true })).toBe(legacy);
      expect(readToolSecrets(REPO, "sentry")).toEqual({ SENTRY_ACCESS_TOKEN: "old-token" });
    } finally { again.close(); vi.unstubAllEnvs(); }
  });

  test("every credential family: a project tool's (old home folder), the Linear key, Google mail's client secret and refresh token, a flow's signing secret", () => {
    const linear = `lin_api_${"L".repeat(32)}`, refresh = `1//refresh-${"g".repeat(40)}`, clientSecret = `GOCSPX-${"s".repeat(28)}`, signing = `whsec_${"h".repeat(40)}`;
    mkdirSync(join(legacy, REPO_HASH), { recursive: true, mode: 0o700 });
    writeFileSync(join(legacy, REPO_HASH, "sentry.json"), JSON.stringify({ SENTRY_ACCESS_TOKEN: CANARY }), { mode: 0o600 });
    writeFileSync(join(state, "linear-key"), `${linear}\n`, { mode: 0o600 });
    writeFileSync(join(state, "google-mail.json"), JSON.stringify({ clientId: "123456-abcdefgh.apps.googleusercontent.com", clientSecret, refreshToken: refresh, address: "ops@example.com" }), { mode: 0o600 });
    mkdirSync(join(state, "flow-hooks"), { mode: 0o700 });
    writeFileSync(join(state, "flow-hooks", "12.json"), `${JSON.stringify({ secret: signing })}\n`, { mode: 0o600 });
    const keychain = memoryKeychain();
    chooseSecretStore(keychain);
    started();
    expect(readToolSecrets(REPO, "sentry", state)).toEqual({ SENTRY_ACCESS_TOKEN: CANARY });
    expect(readLinearKey(state)).toBe(linear);
    expect(readGoogleMail(state)).toEqual({ clientId: "123456-abcdefgh.apps.googleusercontent.com", clientSecret, refreshToken: refresh, address: "ops@example.com" });
    expect(readHookSecret(state, 12)).toBe(signing);
    for (const file of [join(legacy, REPO_HASH, "sentry.json"), join(state, "linear-key"), join(state, "google-mail.json"), join(state, "flow-hooks", "12.json")]) expect(existsSync(file)).toBe(false);
    for (const one of [...filesUnder(state), ...filesUnder(home)]) for (const secret of ["canary", linear, refresh, clientSecret, signing]) expect(one.text.includes(secret), one.path).toBe(false);
    // In the keychain, sealed: no value there in the clear either.
    for (const value of keychain.items.values()) for (const secret of ["canary", linear, refresh, clientSecret, signing]) expect(value.includes(secret)).toBe(false);
    // Read again: the keychain's alone.
    expect(readLinearKey(state)).toBe(linear);
    expect(readHookSecret(state, 12)).toBe(signing);
  });

  test("a move that doesn't read back the same keeps the file, removes the bad copy and says so; nothing is lost", () => {
    chooseSecretStore("files");
    started();
    setToolSecrets(REPO, "sentry", { SENTRY_ACCESS_TOKEN: CANARY }, state);
    const file = filesUnder(state).find(one => one.text.includes("canary"))!.path;
    const broken = memoryKeychain({ read: value => value.replace(/[a-f0-9]{16}\./, "0000000000000000.") });
    chooseSecretStore(broken);
    expect(() => readToolSecrets(REPO, "sentry", state)).toThrow("couldn't be moved to the keychain; they stay in their file");
    expect(readFileSync(file, "utf8")).toContain(CANARY);
    expect(broken.items.size).toBe(0);
    // The keychain works again: the move completes.
    chooseSecretStore(memoryKeychain());
    expect(readToolSecrets(REPO, "sentry", state)).toEqual({ SENTRY_ACCESS_TOKEN: CANARY });
    expect(existsSync(file)).toBe(false);
  });

  test("secrets already in the keychain win over a stale file: an old value is never brought back", () => {
    const keychain = memoryKeychain();
    chooseSecretStore(keychain);
    started();
    setToolSecrets(REPO, "sentry", { SENTRY_ACCESS_TOKEN: "newer-token" }, state);
    // A file from before, as a crash between the move and its removal would leave one.
    chooseSecretStore("files");
    setToolSecrets(REPO, "sentry", { SENTRY_ACCESS_TOKEN: "older-token" }, state);
    chooseSecretStore(keychain);
    expect(readToolSecrets(REPO, "sentry", state)).toEqual({ SENTRY_ACCESS_TOKEN: "newer-token" });
    expect(filesUnder(state).some(one => one.text.includes("older-token"))).toBe(false);
  });

  test("bypass: a link planted where an old secrets file was is never followed, moved in or erased through, and never hides what the keychain holds", () => {
    const bait = join(dir, "bait");
    writeFileSync(bait, `lin_api_${"b".repeat(30)}\n`, { mode: 0o600 });
    mkdirSync(join(legacy, REPO_HASH), { recursive: true, mode: 0o700 });
    symlinkSync(bait, join(legacy, REPO_HASH, "sentry.json"));
    chooseSecretStore(memoryKeychain());
    started();
    expect(saveLinearKey(state, `lin_api_${"a".repeat(30)}`)).toEqual({ ok: true });
    symlinkSync(bait, join(state, "linear-key"));
    expect(readLinearKey(state)).toBe(`lin_api_${"a".repeat(30)}`);
    expect(readToolSecrets(REPO, "sentry", state)).toEqual({});
    expect(readFileSync(bait, "utf8")).toBe(`lin_api_${"b".repeat(30)}\n`);
  });

  test("with no keychain, the Linear key stays in its owner-only file, as before", () => {
    chooseSecretStore("files");
    expect(saveLinearKey(state, `lin_api_${"x".repeat(30)}`)).toEqual({ ok: true });
    expect(statSync(join(state, "linear-key")).mode & 0o777).toBe(0o600);
    expect(readLinearKey(state)).toBe(`lin_api_${"x".repeat(30)}`);
  });
});

test("a keychain that refuses is never quietly replaced by files: a run leaves the tool out, and no file is written", async () => {
  started();
  chooseSecretStore(memoryKeychain({ fail: true }));
  expect(() => setToolSecret(REPO, "sentry", "SENTRY_ACCESS_TOKEN", CANARY, state)).toThrow(SecretStoreError);
  expect(filesUnder(state).some(one => one.text.includes("canary"))).toBe(false);
  const store = openStore(join(dir, "orders.db"));
  try {
    expect(addApprover(store, "alex", T0).ok).toBe(true);
    chooseSecretStore(memoryKeychain());
    expect(addToolTo(store, REPO, spec, "custom", "alex", T0, { home: state })).toMatchObject({ ok: true });
    chooseSecretStore(memoryKeychain({ fail: true }));
    const runs = { projectTools: (one: string) => store.projectTools(one), orgPolicy: () => store.orgPolicy(), getRun: () => ({ taskRef: 1 }), refById: () => ({ repo: REPO, externalId: "t" }), getScope: () => null, toolSealFor: () => null, recordRunTools: () => undefined } as unknown as Parameters<typeof prepareRunTools>[0];
    await expect(prepareRunTools(runs, 1, "claude", { home: state, now: T0, containment: { platform: "darwin", fence: "macos-sandbox" } })).rejects.toThrow(SecretStoreError);
  } finally { store.close(); }
});

test("a tool that needs no secret launches without the secret store: a resumed run in a process that never started it keeps its tools", async () => {
  const store = openStore(join(dir, "orders.db"));
  try {
    expect(addApprover(store, "alex", T0).ok).toBe(true);
    const notes: ToolSpec = { name: "notes", transport: "stdio", command: process.execPath, args: ["-e", "process.exit(0)"], url: null, secrets: [], bearer: null, headerSecrets: {}, about: "Notes." };
    expect(addToolTo(store, REPO, notes, "custom", "alex", T0)).toMatchObject({ ok: true });
    // A process that calls invokeAgent without Toolroll's start (an embedding, the provider canary's resumed turn):
    // no folder for secrets, so every read of the store is refused.
    forgetSecretFolders();
    expect(() => readToolSecrets(REPO, "notes")).toThrow(SecretStoreError);
    let recorded = "";
    const runs = { projectTools: (one: string) => store.projectTools(one), orgPolicy: () => store.orgPolicy(), getRun: () => ({ taskRef: 1 }), refById: () => ({ repo: REPO, externalId: "t" }), getScope: () => null, toolSealFor: () => null, recordRunTools: (_run: number, json: string) => { recorded = json; } } as unknown as Parameters<typeof prepareRunTools>[0];
    const launched = await prepareRunTools(runs, 1, "claude", { now: T0, containment: { platform: "darwin", fence: "macos-sandbox" } });
    try {
      expect(JSON.parse(recorded)).toMatchObject({ provider: "claude", tools: [{ name: "notes" }], skipped: [] });
    } finally { launched.cleanup(); }
  } finally { store.close(); }
});

test("bypass: an item copied onto another tool's address is refused, never read as the other tool's", () => {
  const keychain = memoryKeychain();
  chooseSecretStore(keychain);
  started();
  setToolSecrets(REPO, "sentry", { SENTRY_ACCESS_TOKEN: "sentry-token" }, state);
  setToolSecrets(REPO, "linear", { LINEAR_TOKEN: "linear-token" }, state);
  // A build that can write the keychain moves Sentry's sealed item onto Linear's address.
  const [sentry] = [...keychain.items.keys()].filter(key => key.endsWith(".sentry"));
  const [linear] = [...keychain.items.keys()].filter(key => key.endsWith(".linear"));
  keychain.items.set(linear!, keychain.items.get(sentry!)!);
  expect(() => readToolSecrets(REPO, "linear", state)).toThrow("can't be opened");
  expect(readToolSecrets(REPO, "sentry", state)).toEqual({ SENTRY_ACCESS_TOKEN: "sentry-token" });
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
    store = openStore(join(state, "orders.db"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap");
    token = added.token;
    server = createDecisionServer({ store, evidenceRoot: home, clock: () => new Date(), repos: [REPO], toolHome: state, codexToolList: async () => null } as Parameters<typeof createDecisionServer>[0]);
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
    started();
    expect(addToolTo(store, REPO, spec, "custom", "alex", T0, { home: state })).toMatchObject({ ok: true });
    const cookie = (await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token }), redirect: "manual" })).headers.get("set-cookie")!.split(";")[0]!;
    const before = await (await fetch(`${base}/settings/tools?repo=${encodeURIComponent(REPO)}`, { headers: { cookie } })).text();
    const csrf = /<input type="hidden" name="csrf" value="([^"]+)">/.exec(before)![1]!;
    const saved = await fetch(`${base}/settings/tools/change`, { method: "POST", headers: { cookie, origin: base }, redirect: "manual",
      body: new URLSearchParams({ csrf, repo: REPO, shown: REPO, action: "secret", name: "sentry", secret: "SENTRY_ACCESS_TOKEN", value: CANARY, password: token }) });
    expect(saved.status).toBe(303);
    expect(decodeURIComponent(saved.headers.get("location") ?? "")).toContain("Saved SENTRY_ACCESS_TOKEN for sentry");
    expect(readToolSecrets(REPO, "sentry", state)["SENTRY_ACCESS_TOKEN"] === CANARY).toBe(true);
    // A failed test of the tool, recorded on it: its words never carry the key.
    await fetch(`${base}/settings/tools/change`, { method: "POST", headers: { cookie, origin: base }, redirect: "manual", body: new URLSearchParams({ csrf, repo: REPO, shown: REPO, action: "test", name: "sentry", password: token }) }).catch(() => undefined);
    const shown = await (await fetch(`${base}/settings/tools?repo=${encodeURIComponent(REPO)}`, { headers: { cookie } })).text();
    expect(shown).toContain("Key held by Toolroll");
    expect(shown).not.toContain("canary");
    expect(output.join("\n")).not.toContain("canary");
    // A tool connected by signing in takes no pasted token, refresh token least of all: the post is refused.
    expect(addToolTo(store, REPO, connectedSpec("linear")!, "Linear, connected by signing in", "alex", T0, { home: state })).toMatchObject({ ok: true });
    const pasted = await fetch(`${base}/settings/tools/change`, { method: "POST", headers: { cookie, origin: base }, redirect: "manual",
      body: new URLSearchParams({ csrf, repo: REPO, shown: REPO, action: "secret", name: "linear", secret: "OAUTH_REFRESH_TOKEN", value: CANARY, password: token }) });
    expect(decodeURIComponent(pasted.headers.get("location") ?? "")).toContain("linear is connected by signing in. Sign in again from Connect to renew it.");
    expect(readToolSecrets(REPO, "linear", state)).toEqual({});
    // The database, its ledger included, and every file Toolroll keeps: no value anywhere.
    expect(JSON.stringify(store.handle.prepare("SELECT * FROM action_ledger").all())).not.toContain("canary");
    store.handle.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    for (const file of ["orders.db", "orders.db-wal"].map(one => join(state, one)).filter(existsSync)) expect(readFileSync(file).includes("canary")).toBe(false);
    for (const one of filesUnder(state)) expect(one.text).not.toContain("canary");
  });
});
