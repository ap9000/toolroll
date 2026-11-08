/**
 * Protected storage (docs/plans/chat-management.md §1.1): where the person's chat apps, browser profiles and password
 * managers keep their sessions, denied to every launch Toolroll fences, read and write, under both fence policies and
 * on every backend. A linked chat account is not proof of a person: whatever holds the Slack desktop's token, Telegram
 * Desktop's `tdata` or a browser's cookies can press the bot's buttons as them. So no build, check, flow or tool server
 * may read those, whatever its project's settings say.
 *
 * The list is outside HOME_CONFIGURATION (agent-fence.ts), which only version-1 fences read: `agentFence` adds these to
 * every fence it makes, as paths no grant can reopen, and `taskBoundary` names them for both policies.
 *
 * Each root is denied by its name, present or not (a build can't make the folder now and swap in a link later), and by
 * its real path (a root that is itself a link to a relocated folder). Inside each present root a bounded walk that
 * never follows a link finds links leading outward and denies where they lead. The overrides Toolroll can know are read
 * from the plane's own environment at each launch, never from a checkout: XDG_CONFIG_HOME and XDG_DATA_HOME (Linux),
 * OP_CONFIG_DIR, BITWARDENCLI_APPDATA_DIR, and the profiles Firefox's (and Zen's) profiles.ini places elsewhere.
 * Storage Toolroll doesn't know about (a browser started with its own --user-data-dir, a portable app) isn't covered.
 *
 * Each launch's check is its own and finishes before the launch (prepareProtectedStorage): on a Mac it runs in a child
 * process, so a privacy prompt never holds the thread that serves the console, and a check that can't finish refuses
 * the launch in words that say which program macOS may need to allow. No earlier walk stands in for it.
 *
 * The chat and vault variables (SLACK_*, TELEGRAM_*, DISCORD_*, TEAMS_*, OP_*, BW_*, BITWARDENCLI_*) are kept out of
 * every launch's environment (`withoutProtectedEnv`, exec.ts).
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, fstatSync, lstatSync, openSync, constants as fsConstants, readSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** One app's storage, relative to the home folder, per platform. */
export type ProtectedApp = { app: string; darwin: readonly string[]; linux: readonly string[] };

const AS = "Library/Application Support";
const CONTAINERS = "Library/Containers";
const GROUPS = "Library/Group Containers";

/**
 * Every listed root. Checked against a real Mac (2026-10-25): existence only, never a file's contents. The 1Password
 * containers and the extra Chrome, Edge and other browsers' folders below were found there and added.
 */
export const PROTECTED_STORAGE: readonly ProtectedApp[] = [
  { app: "Slack", darwin: [`${AS}/Slack`, `${CONTAINERS}/com.tinyspeck.slackmacgap`], linux: [".config/Slack", "snap/slack", ".var/app/com.slack.Slack"] },
  { app: "Telegram", darwin: [`${AS}/Telegram Desktop`, `${CONTAINERS}/org.telegram.desktop`, `${GROUPS}/6N38VWS5BX.ru.keepcoder.Telegram`, `${CONTAINERS}/ru.keepcoder.Telegram`],
    linux: [".local/share/TelegramDesktop", "snap/telegram-desktop", ".var/app/org.telegram.desktop"] },
  { app: "Discord", darwin: [`${AS}/discord`, `${AS}/discordptb`, `${AS}/discordcanary`],
    linux: [".config/discord", ".config/discordptb", ".config/discordcanary", "snap/discord", ".var/app/com.discordapp.Discord"] },
  // New Teams keeps its sign-in in Microsoft's shared sign-in cache (OneAuth) too.
  { app: "Teams", darwin: [`${CONTAINERS}/com.microsoft.teams2`, `${GROUPS}/UBF8T346G9.com.microsoft.teams`, `${AS}/Microsoft/Teams`, `${GROUPS}/UBF8T346G9.com.microsoft.oneauth`],
    linux: [".config/Microsoft/Microsoft Teams", ".config/teams-for-linux"] },
  { app: "WhatsApp", darwin: [`${CONTAINERS}/net.whatsapp.WhatsApp`, `${GROUPS}/group.net.whatsapp.WhatsApp.shared`, `${GROUPS}/group.net.whatsapp.WhatsApp.private`, `${GROUPS}/group.net.whatsapp.family`], linux: [] },
  { app: "1Password",
    darwin: [`${GROUPS}/2BUA8C4S2C.com.1password`, `${GROUPS}/group.2BUA8C4S2C.com.1password`, `${GROUPS}/2BUA8C4S2C.com.agilebits`, `${CONTAINERS}/com.1password.1password`,
      `${CONTAINERS}/com.1password.1password-launcher`, `${CONTAINERS}/com.1password.browser-support`, `${CONTAINERS}/2BUA8C4S2C.com.1password.browser-helper`,
      `${CONTAINERS}/com.1password.1password.autofill-extension`, `${AS}/1Password`, ".config/1Password", ".config/op", ".op"],
    linux: [".config/1Password", "snap/1password", ".var/app/com.onepassword.OnePassword", ".config/op", ".op"] },
  { app: "Bitwarden", darwin: [`${AS}/Bitwarden`, `${CONTAINERS}/com.bitwarden.desktop`, `${GROUPS}/LTZ2PFU5D6.com.bitwarden.desktop`, `${AS}/Bitwarden CLI`],
    linux: [".config/Bitwarden", "snap/bitwarden", ".var/app/com.bitwarden.desktop", ".config/Bitwarden CLI"] },
  // The browser extensions of both password managers live inside the browser profiles below.
  { app: "Chrome", darwin: [`${AS}/Google/Chrome`, `${AS}/Google/Chrome Beta`, `${AS}/Google/Chrome Canary`, `${AS}/Google/Chrome Dev`],
    linux: [".config/google-chrome", ".config/google-chrome-beta", ".config/google-chrome-unstable", ".var/app/com.google.Chrome"] },
  { app: "Chromium", darwin: [`${AS}/Chromium`], linux: [".config/chromium", "snap/chromium", ".var/app/org.chromium.Chromium"] },
  { app: "Brave", darwin: [`${AS}/BraveSoftware`], linux: [".config/BraveSoftware", "snap/brave", ".var/app/com.brave.Browser"] },
  { app: "Edge", darwin: [`${AS}/Microsoft Edge`, `${AS}/Microsoft Edge Beta`, `${AS}/Microsoft Edge Dev`, `${AS}/Microsoft Edge Canary`],
    linux: [".config/microsoft-edge", ".config/microsoft-edge-beta", ".config/microsoft-edge-dev", ".var/app/com.microsoft.Edge"] },
  { app: "Arc", darwin: [`${AS}/Arc`], linux: [] },
  { app: "Firefox", darwin: [`${AS}/Firefox`], linux: [".mozilla/firefox", "snap/firefox", ".var/app/org.mozilla.firefox"] },
  { app: "Zen", darwin: [`${AS}/zen`], linux: [".zen", ".var/app/app.zen_browser.zen"] },
  { app: "Vivaldi", darwin: [`${AS}/Vivaldi`, `${AS}/Vivaldi Snapshot`], linux: [".config/vivaldi", ".config/vivaldi-snapshot"] },
  { app: "Opera", darwin: [`${AS}/com.operasoftware.Opera`], linux: [".config/opera"] },
  { app: "Orion", darwin: [`${AS}/Orion`], linux: [] },
  { app: "Safari", darwin: ["Library/Safari", `${CONTAINERS}/com.apple.Safari`, `${CONTAINERS}/com.apple.Safari.WebApp`, "Library/Cookies", "Library/HTTPStorages", "Library/WebKit"], linux: [] },
];

/** The roots whose profiles.ini may place a profile anywhere (Firefox and its forks). */
const PROFILE_INDEXES: Readonly<Record<"darwin" | "linux", readonly string[]>> = {
  darwin: [`${AS}/Firefox`, `${AS}/zen`],
  linux: [".mozilla/firefox", "snap/firefox/common/.mozilla/firefox", ".var/app/org.mozilla.firefox/.mozilla/firefox", ".zen"],
};

/** The chat and vault variables no launch gets. */
export const PROTECTED_ENV_PREFIXES: readonly string[] = ["SLACK_", "TELEGRAM_", "DISCORD_", "TEAMS_", "OP_", "BW_", "BITWARDENCLI_"];

export function isProtectedEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return PROTECTED_ENV_PREFIXES.some(prefix => upper.startsWith(prefix));
}

/** `env` without a chat or vault variable. */
export function withoutProtectedEnv<T extends Record<string, string | undefined>>(env: T): T {
  const out = { ...env };
  for (const name of Object.keys(out)) if (isProtectedEnvName(name)) delete out[name];
  return out;
}

/** How far the link walk goes in each present root. */
export const PROTECTED_WALK = { depth: 4, entries: 5_000 } as const;

const real = (path: string): string => { try { return realpathSync(path); } catch { return resolve(path); } };
const within = (child: string, parent: string): boolean => { const rel = relative(parent, child); return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel); };
const platformOf = (platform: NodeJS.Platform): "darwin" | "linux" | null => platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : null;

/** A path the fence can't deny without denying the machine: `/`, the home folder or a folder above it. */
function tooWide(path: string, home: string): boolean {
  return !isAbsolute(path) || path === dirname(path) || path === home || within(home, path);
}

/** The roots by name, under the (real) home folder and the overrides the plane's environment names. */
export function protectedStorageNames(home: string = homedir(), env: Readonly<Record<string, string | undefined>> = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const os = platformOf(platform);
  if (os === null) return [];
  const base = real(home);
  const names = new Set<string>();
  const add = (path: string) => { if (!tooWide(path, base)) names.add(path); };
  const relatives = PROTECTED_STORAGE.flatMap(row => row[os]);
  for (const one of relatives) add(join(base, one));
  if (os === "linux") {
    const absolute = (name: string): string | null => { const value = env[name]; return value !== undefined && isAbsolute(value) ? value : null; };
    const config = absolute("XDG_CONFIG_HOME"), data = absolute("XDG_DATA_HOME");
    for (const one of relatives) {
      if (config !== null && one.startsWith(".config/")) add(join(config, one.slice(".config/".length)));
      if (data !== null && one.startsWith(".local/share/")) add(join(data, one.slice(".local/share/".length)));
    }
  }
  for (const name of ["OP_CONFIG_DIR", "BITWARDENCLI_APPDATA_DIR"]) {
    const value = env[name];
    if (value !== undefined && isAbsolute(value)) add(resolve(value));
  }
  for (const index of PROFILE_INDEXES[os]) for (const profile of profilesElsewhere(join(base, index))) add(profile);
  return [...names].sort();
}

/** The absolute `Path=` entries of a profiles.ini in `root`, read only as the plain file it is, bounded. On a Mac this
 * runs only inside the storage check's child process (prepareProtectedStorage), where an open that waits on macOS
 * holds up nothing else. */
function profilesElsewhere(root: string): string[] {
  const text = profilesIniHere(join(root, "profiles.ini"));
  return (text ?? "").split(/\r?\n/)
    .map(line => /^\s*Path\s*=\s*(.+?)\s*$/i.exec(line)?.[1] ?? null)
    .filter((path): path is string => path !== null && isAbsolute(path));
}

function profilesIniHere(file: string): string | null {
  try { lstatSync(file); } catch { return null; }
  let fd: number;
  try { fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)); } catch { return null; }
  try {
    const held = fstatSync(fd);
    if (!held.isFile()) return null;
    const buffer = Buffer.alloc(Math.min(held.size, 64 * 1024));
    return buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString("utf8");
  } catch { return null; }
  finally { closeSync(fd); }
}

const unwalkedSaid = new Set<string>();

/** What one launch keeps out: every root by name (`names`), and every protected path it denies (`denies`). */
export type ProtectedStorage = { names: string[]; denies: string[] };

/**
 * The storage check, run right here: every root by name and by real path, every link inside a present root that leads
 * outward (where it leads, by real path and as spelled), and the overrides. `unfinished` names each present root whose
 * walk met an error other than "not there" or "not allowed": its links aren't all known. A link macOS makes in a
 * sandboxed app's container to the same place under the home folder (its Desktop, Downloads, Fonts…) is the system's
 * own mirror of the person's folders, not the app's data, and isn't followed (systemMirror).
 *
 * On a Mac a listing (or an open) inside another app's data can wait until a person answers a privacy prompt, so there
 * this runs only in the check's own child process (prepareProtectedStorage), never on a thread that serves anything.
 * `at` is told each root before its walk starts, so a check that runs out of time can name the app it was waiting on.
 */
export function protectedStorageHere(home: string = homedir(), env: Readonly<Record<string, string | undefined>> = process.env, platform: NodeJS.Platform = process.platform,
  say: (line: string) => void = () => {}, list: (path: string) => import("node:fs").Dirent[] = path => readdirSync(path, { withFileTypes: true }),
  at: (root: string) => void = () => {}): ProtectedStorage & { unfinished: string[] } {
  const base = real(home);
  const names = protectedStorageNames(base, env, platform);
  const out = new Set<string>();
  const add = (path: string) => { if (!tooWide(path, base)) out.add(path); };
  const unfinished: string[] = [];
  for (const name of names) {
    add(name);
    try { lstatSync(name); } catch { continue; /* denied by name only */ }
    const root = real(name);
    add(root);
    at(root);
    const walked = { complete: true };
    for (const target of outwardLinks(name, root, base, say, list, walked)) add(target);
    if (!walked.complete && !unfinished.includes(root)) unfinished.push(root);
  }
  return { names, denies: [...out].sort(), unfinished };
}

/** Every protected path, checked right here (protectedStorageHere), for a caller that has no prepared check. */
export function protectedStorageDenies(home: string = homedir(), env: Readonly<Record<string, string | undefined>> = process.env, platform: NodeJS.Platform = process.platform,
  say?: (line: string) => void, list?: (path: string) => import("node:fs").Dirent[]): string[] {
  return protectedStorageHere(home, env, platform, say, list).denies;
}

/** Where the links inside a present root lead, when outside it: a walk that never follows a link, bounded. */
function outwardLinks(name: string, root: string, home: string, say: (line: string) => void, list: (path: string) => import("node:fs").Dirent[], walked?: { complete: boolean }): string[] {
  const found: string[] = [];
  let seen = 0;
  const queue: { path: string; depth: number }[] = [{ path: root, depth: 0 }];
  while (queue.length > 0) {
    const { path, depth } = queue.shift()!;
    let entries: import("node:fs").Dirent[];
    try { entries = list(path); } catch (error) {
      if (walked !== undefined && !ANSWERED.has((error as NodeJS.ErrnoException)?.code ?? "")) walked.complete = false;
      continue;
    }
    for (const entry of entries) {
      if (++seen > PROTECTED_WALK.entries) {
        if (!unwalkedSaid.has(root)) { unwalkedSaid.add(root); say(`toolroll: fence: ${name} holds more than ${PROTECTED_WALK.entries.toLocaleString("en-US")} entries; links past that weren't checked (not fully walked)`); }
        return found;
      }
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) {
        let spelled: string;
        try { spelled = resolve(dirname(child), readlinkSync(child)); } catch { continue; }
        if (systemMirror(child, root, spelled, home)) continue;
        const target = real(spelled);
        if (target === root || within(target, root)) continue;
        found.push(target);
        if (spelled !== target) found.push(spelled);
      } else if (entry.isDirectory() && depth + 1 < PROTECTED_WALK.depth) queue.push({ path: child, depth: depth + 1 });
    }
  }
  return found;
}

/** The links macOS makes in every sandboxed app's container (`Data/X` → `~/X`), as found on a real Mac (2026-10-26). */
const CONTAINER_MIRRORS: ReadonlySet<string> = new Set([".CFUserTextEncoding", "Desktop", "Downloads", "Movies", "Music", "Pictures",
  ...["Audio", "Calendars", "ColorPickers", "ColorSync", "Colors", "Components", "Compositions", "Dictionaries", "Favorites", "Filters", "FontCollections", "Fonts",
    "Input Methods", "KeyBindings", "Keyboard Layouts", "Keychains", "Mail", "PDF Services", "QuickLook", "Sounds", "Spelling", "Images/People",
    "Application Support/AddressBook", "Application Support/iCloud", "Application Support/SyncServices",
    "Preferences/com.apple.security.plist", "Preferences/com.apple.security_common.plist"].map(one => `Library/${one}`)]);

/**
 * The system's own redirect in a sandboxed app's container, and nothing else: the root is an app container (its links
 * under `Data/`) or a group container, directly in the home folder's Library, and the link is one macOS makes there
 * (CONTAINER_MIRRORS, or the app's own Application Scripts folder) leading to the same place under the home folder.
 * Any other outward link — in a browser profile, a password manager's folder, or an unknown name in a container — is
 * where that app's data was moved, and is denied.
 */
function systemMirror(link: string, root: string, target: string, home: string): boolean {
  const app = dirname(root) === real(join(home, CONTAINERS)), group = dirname(root) === real(join(home, GROUPS));
  if (!app && !group) return false;
  const rel = relative(root, link).split(sep);
  if (app && rel[0] !== "Data") return false;
  const under = app ? rel.slice(1) : rel;
  const named = under.join("/");
  const known = CONTAINER_MIRRORS.has(named) || named === `Library/Application Scripts/${root.split(sep).at(-1)}`;
  return known && target === join(home, ...under);
}

/** The answers a walk takes as complete: the folder isn't there, or macOS refused it outright. */
const ANSWERED: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR", "EPERM", "EACCES"]);

// ---- the check, off the thread ---------------------------------------------------------------------------------

/** How long the storage check may take before the launch is refused (a slow Mac finishes well inside it). */
export const STORAGE_LOOK_MS = 10_000;
/** At most this much of the check's answer is read. */
const LOOK_OUTPUT_MAX = 8 * 1024 * 1024;
/** The plane's own variables the check reads (protectedStorageNames), handed to its child as they are here. */
const STORAGE_ENV = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "OP_CONFIG_DIR", "BITWARDENCLI_APPDATA_DIR"] as const;

/** What the check asked of its child, and how the child's run ended. */
export type StorageLookRequest = { home: string; env: Record<string, string>; platform: NodeJS.Platform };
export type StorageLookResult =
  | { kind: "done"; storage: ProtectedStorage; unfinished: string[] }
  | { kind: "timed-out"; at: string | null }
  | { kind: "failed"; detail: string };
export type StorageLook = (request: StorageLookRequest) => Promise<StorageLookResult>;

/** Why a launch didn't start: the storage check couldn't finish. Its words survive every catch (storageRefusalOf). */
export class ProtectedStorageRefusal extends Error {
  readonly code = "protected-storage" as const;
  constructor(readonly apps: readonly string[], readonly why: "timed-out" | "unfinished" | "failed", message: string) {
    super(message);
    this.name = "ProtectedStorageRefusal";
  }
}

/** The storage refusal inside a caught error, when it is one. */
export function storageRefusalOf(error: unknown): ProtectedStorageRefusal | null {
  return error instanceof ProtectedStorageRefusal ? error : null;
}

/** The apps behind these roots, by name, for the words a person reads. */
function appsOf(roots: readonly string[], home: string): string[] {
  const names = roots.map(root => PROTECTED_STORAGE.find(row => [...row.darwin, ...row.linux].some(one => real(join(home, one)) === root || join(home, one) === root))?.app ?? basename(root));
  return [...new Set(names)];
}

/** Which program macOS must allow: the one this plane runs as. A launchd service is its program itself; a plane started
 * from a terminal asks as that terminal app. */
export function storageAccessHolder(env: Readonly<Record<string, string | undefined>> = process.env, execPath: string = process.execPath, versions: NodeJS.ProcessVersions = process.versions): string {
  if (versions["electron"] !== undefined) return "the Toolroll app";
  const service = env["XPC_SERVICE_NAME"];
  if (service !== undefined && service !== "" && service !== "0") return `the program that keeps Toolroll running (${execPath})`;
  const terminal = env["TERM_PROGRAM"];
  if (terminal !== undefined && terminal !== "") return `the terminal app Toolroll was started from (${terminal.replace(/\.app$/, "")})`;
  return `the program Toolroll runs as (${execPath})`;
}

/** Why nothing was launched, and what the person does about it. Never says macOS is asking: that isn't known. */
export function storageRefusalWords(apps: readonly string[], why: ProtectedStorageRefusal["why"], holder: string): string {
  const named = apps.length === 0 ? "other apps" : apps.length === 1 ? apps[0]! : `${apps.slice(0, -1).join(", ")} and ${apps.at(-1)!}`;
  const reason = why === "timed-out" ? ` (the check didn't finish within ${STORAGE_LOOK_MS / 1000} seconds)` : why === "unfinished" ? " (some of its folders couldn't be read)" : " (the check stopped with an error)";
  return `Nothing was started: Toolroll couldn't finish checking ${apps.length === 0 ? "other apps'" : `${named}'s`} data for links to keep out of the build${reason}. `
    + `macOS may need to let ${holder} read it: in System Settings → Privacy & Security → Full Disk Access, turn it on for ${holder}, then try again.`;
}

const inFlight = new Map<string, Promise<StorageLookResult>>();

/**
 * The storage check for one launch, awaited: what it denies, from a walk that finished just now. On a Mac the whole check
 * (finding the roots, reading profiles.ini, every walk) runs in a child process, so a listing that waits on a privacy
 * prompt holds up only that child; the thread that asked keeps serving. A check that doesn't finish within
 * STORAGE_LOOK_MS, fails, or leaves a present root's walk unfinished refuses the launch (ProtectedStorageRefusal): no
 * earlier walk stands in for it, since a link can move inside a root at any time. Checks asked for at once share one child.
 */
export async function prepareProtectedStorage(home: string = homedir(), env: Readonly<Record<string, string | undefined>> = process.env, platform: NodeJS.Platform = process.platform,
  look: StorageLook = lookInChild, holder: string = storageAccessHolder(env)): Promise<ProtectedStorage> {
  const base = real(home);
  const request: StorageLookRequest = { home: base, env: Object.fromEntries(STORAGE_ENV.flatMap(name => env[name] === undefined ? [] : [[name, env[name]!]])), platform };
  let answer: StorageLookResult;
  if (platform !== "darwin") {
    // No privacy prompt can hold a listing here: the check runs as it is.
    const here = protectedStorageHere(base, env, platform, line => process.stderr.write(`${line}\n`));
    answer = { kind: "done", storage: { names: here.names, denies: here.denies }, unfinished: here.unfinished };
  } else {
    const key = JSON.stringify(request);
    let pending = inFlight.get(key);
    if (pending === undefined) {
      pending = look(request).finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
    }
    answer = await pending;
  }
  if (answer.kind === "timed-out") {
    const apps = answer.at === null ? [] : appsOf([answer.at], base);
    throw new ProtectedStorageRefusal(apps, "timed-out", storageRefusalWords(apps, "timed-out", holder));
  }
  if (answer.kind === "failed") throw new ProtectedStorageRefusal([], "failed", storageRefusalWords([], "failed", holder));
  if (answer.unfinished.length > 0) {
    const apps = appsOf(answer.unfinished, base);
    throw new ProtectedStorageRefusal(apps, "unfinished", storageRefusalWords(apps, "unfinished", holder));
  }
  return answer.storage;
}

/** Where the check's child script is: beside this module once built, else the built copy (a run from source). */
export function storageLookScript(): string {
  const beside = fileURLToPath(new URL("./protected-storage-look.js", import.meta.url));
  return existsSync(beside) ? beside : fileURLToPath(new URL("../dist/protected-storage-look.js", import.meta.url));
}

/** The default check: node (or Electron as node) runs protected-storage-look.js, killed at STORAGE_LOOK_MS. */
async function lookInChild(request: StorageLookRequest): Promise<StorageLookResult> {
  return readLook(await spawnLook(process.execPath, [storageLookScript(), JSON.stringify(request)], STORAGE_LOOK_MS));
}

/** A finished child's lines as the check's answer: `at\t<root>` before each walk, `done\t<answer>` once at the end. */
export function readLook(ran: SpawnedLook): StorageLookResult {
  const lines = ran.stdout.split("\n");
  const last = [...lines].reverse().find(line => line.startsWith("at\t"));
  const at = last === undefined ? null : (() => { try { const root = JSON.parse(last.slice(3)) as unknown; return typeof root === "string" && isAbsolute(root) ? root : null; } catch { return null; } })();
  if (ran.outcome === "timed-out") return { kind: "timed-out", at };
  if (ran.outcome === "failed") return { kind: "failed", detail: ran.detail };
  const done = lines.find(line => line.startsWith("done\t"));
  if (done === undefined) return { kind: "failed", detail: "the check gave no answer" };
  try {
    const value = JSON.parse(done.slice(5)) as Record<string, unknown>;
    const paths = (one: unknown): string[] | null => Array.isArray(one) && one.every(path => typeof path === "string" && isAbsolute(path)) ? one as string[] : null;
    const names = paths(value["names"]), denies = paths(value["denies"]), unfinished = paths(value["unfinished"]);
    if (names === null || denies === null || unfinished === null) return { kind: "failed", detail: "the check's answer can't be read" };
    return { kind: "done", storage: { names, denies }, unfinished };
  } catch { return { kind: "failed", detail: "the check's answer can't be read" }; }
}

/** How a child ran: everything it wrote, and whether it finished, ran out of time (killed) or failed some other way. */
export type SpawnedLook = { stdout: string; outcome: "done" | "timed-out" | "failed"; detail: string };

/** Run a child without waiting on this thread: its output, bounded, and how it ended. Killed at `limitMs`. */
export function spawnLook(command: string, args: readonly string[], limitMs: number): Promise<SpawnedLook> {
  return new Promise(settle => {
    let stdout = "", over = false, timedOut = false, settled = false;
    const finish = (outcome: SpawnedLook["outcome"], detail: string) => { if (settled) return; settled = true; clearTimeout(timer); settle({ stdout, outcome, detail }); };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args], { stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    } catch (error) { settle({ stdout: "", outcome: "failed", detail: error instanceof Error ? error.message : String(error) }); return; }
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, limitMs);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { if (stdout.length + chunk.length > LOOK_OUTPUT_MAX) { over = true; child.kill("SIGKILL"); } else stdout += chunk; });
    child.on("error", error => finish("failed", error.message));
    child.on("close", (code, signal) => {
      if (timedOut) finish("timed-out", "");
      else if (over) finish("failed", "the check said too much");
      else if (code === 0 && signal === null) finish("done", "");
      else finish("failed", signal === null ? `the check exited with ${code}` : `the check was stopped (${signal})`);
    });
  });
}
