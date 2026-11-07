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
 * The chat and vault variables (SLACK_*, TELEGRAM_*, DISCORD_*, TEAMS_*, OP_*, BW_*, BITWARDENCLI_*) are kept out of
 * every launch's environment (`withoutProtectedEnv`, exec.ts).
 */
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, lstatSync, openSync, constants as fsConstants, readSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { configBase, namedFolder } from "./names.js";

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

/** The absolute `Path=` entries of a profiles.ini in `root`, read only as the plain file it is, bounded. */
function profilesElsewhere(root: string): string[] {
  const file = join(root, "profiles.ini");
  try { lstatSync(file); } catch { return []; }
  // On a Mac the open itself can wait for a person, so a child does it, killed at its limit: only the child waits.
  const text = process.platform === "darwin" ? profilesIniOffThread(file) : profilesIniHere(file);
  return (text ?? "").split(/\r?\n/)
    .map(line => /^\s*Path\s*=\s*(.+?)\s*$/i.exec(line)?.[1] ?? null)
    .filter((path): path is string => path !== null && isAbsolute(path));
}

function profilesIniHere(file: string): string | null {
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

const PROFILES_READ = `const fs=require("fs");const fd=fs.openSync(process.argv[1],fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
if(!fs.fstatSync(fd).isFile())process.exit(1);const b=Buffer.alloc(65536);process.stdout.write(b.subarray(0,fs.readSync(fd,b,0,b.length,0)));`;

function profilesIniOffThread(file: string): string | null {
  const read = spawnSync(process.execPath, ["-e", PROFILES_READ, file], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: CONTAINER_LOOK_MS, killSignal: "SIGKILL", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
  return read.error === undefined && read.status === 0 ? read.stdout : null;
}

const unwalkedSaid = new Set<string>();

/**
 * Every protected path one launch denies: each root by name and by real path, every link inside a present root that
 * leads outward (where it leads, by real path and as spelled), and the overrides. Resolved at each launch, never kept.
 * A link macOS makes in a sandboxed app's container to the same place under the home folder (its Desktop, Downloads,
 * Fonts…) is the system's own mirror of the person's folders, not the app's data, and isn't followed (systemMirror).
 *
 * On a Mac, listing inside a protected root (another app's container, and any other this look finds) can wait for the
 * person to answer macOS's "access data from other apps"
 * prompt when the process asking has no answer yet (a plane run by launchd: every launch, and the console with it, hung
 * there in release check 3249). So every root is walked only after a time-limited look in a child process
 * (`containers`, containersListable) shows they can be listed without waiting. A look that fails any other way refuses
 * the launch (it throws). When macOS is waiting on the person, the roots stay denied by name and real path, and the
 * outward links a recent complete walk of each found (kept by root in the plane's own state folder, linkCacheFile) stay
 * denied too. A record counts only while it is recent (LINK_CACHE_FRESH_MS) and the root itself is unchanged; it can't
 * see a link moved deeper inside since. With no such record, one longer look (SLOW_LOOK_MS) tells a slow Mac from one
 * waiting on the person, and a root still waiting refuses the launch in words that say how to allow it: its outward
 * links are unknown, and launching anyway would leave moved session data readable.
 */
export function protectedStorageDenies(home: string = homedir(), env: Readonly<Record<string, string | undefined>> = process.env, platform: NodeJS.Platform = process.platform,
  say: (line: string) => void = line => process.stderr.write(`${line}\n`), containers: (roots: readonly string[]) => boolean = roots => containersListable(roots),
  list: (path: string) => import("node:fs").Dirent[] = path => readdirSync(path, { withFileTypes: true }),
  others: (roots: readonly string[]) => ReadonlySet<string> = roots => rootsAnswering(roots),
  late: (roots: readonly string[]) => ReadonlySet<string> = roots => rootsAnsweringLate(roots), now: () => number = Date.now): string[] {
  const base = real(home);
  const out = new Set<string>();
  const add = (path: string) => { if (!tooWide(path, base)) out.add(path); };
  const present: { name: string; root: string }[] = [];
  for (const name of protectedStorageNames(base, env, platform)) {
    add(name);
    try { lstatSync(name); } catch { continue; /* denied by name only */ }
    const root = real(name);
    add(root);
    present.push({ name, root });
  }
  const held = platform === "darwin" ? present.filter(one => inAppContainer(one.root, base)).map(one => one.root) : [];
  // Throws when the look itself failed: the launch is refused, never fenced with less.
  const listable = held.length === 0 || containers(held);
  // Any other root can stop an open() until a person answers too (the 0.9.94 deploy froze on the console's own thread),
  // so on a Mac each is looked at the same way. Only a root that answered is walked here; the rest stay denied.
  const plain = platform === "darwin" ? [...new Set(present.map(one => one.root))].filter(root => !held.includes(root)) : [];
  const answering = plain.length === 0 ? new Set<string>() : others(plain);
  const cache = held.length + plain.length === 0 ? null : linkCacheFile(base, env);
  const kept = cache === null ? null : readLinkCacheRoots(cache, base);
  // A root that wasn't looked inside: its outward links are known only from a recent complete walk of it, unchanged since.
  const provenByRecord = (root: string): boolean => { const one = kept?.get(root); return one !== undefined && now() - Date.parse(one.at) <= LINK_CACHE_FRESH_MS && one.stamp === rootStamp(root); };
  const unwalked = [...(listable ? [] : held), ...plain.filter(root => !answering.has(root))];
  // Neither a missing nor a stale record is proof. One longer look tells a slow Mac from one waiting on the person (only a
  // child waits); a root still waiting after it refuses the launch, which would otherwise leave its moved data readable.
  const unverified = unwalked.filter(root => !provenByRecord(root));
  const answeredLate = unverified.length === 0 ? new Set<string>() : late(unverified);
  const blocked = unverified.filter(root => !answeredLate.has(root));
  if (blocked.length > 0) throw new Error(storageBlockedWords(blocked, base));
  const skipped = unwalked.filter(root => !answeredLate.has(root));
  for (const root of skipped) for (const target of kept?.get(root)?.targets ?? []) add(target);
  if (skipped.length > 0 && !unwalkedSaid.has(CONTAINERS_UNLISTED)) {
    unwalkedSaid.add(CONTAINERS_UNLISTED);
    say("toolroll: fence: macOS didn't let Toolroll look inside some apps' data without asking you; they stay denied, with the links found inside them on a recent look (allow Toolroll in Privacy & Security to stop this)");
  }
  const looked = new Map<string, string[]>();
  for (const { name, root } of present) {
    if (skipped.includes(root)) continue;
    const walked = { complete: true };
    const found = outwardLinks(name, root, base, say, list, walked);
    for (const target of found) add(target);
    // Only a walk of a Mac root that met no error but "not there" or "not allowed" is kept for later.
    if (platform === "darwin" && walked.complete) looked.set(root, [...(looked.get(root) ?? []), ...found]);
  }
  if (cache !== null && looked.size > 0) writeLinkCacheRoots(cache, base, looked, kept, now());
  return [...out].sort();
}

/** How long a root's kept links stand in for a look inside it, while the root itself is unchanged. */
export const LINK_CACHE_FRESH_MS = 24 * 60 * 60_000;
/** A root's own identity and last change, read without opening it: a moved or replaced root is another root. */
function rootStamp(root: string): string | null {
  try { const held = lstatSync(root); return `${held.dev}:${held.ino}:${held.mtimeMs}`; } catch { return null; }
}

/** The apps behind these roots, by name, for the words a person reads. */
function appsOf(roots: readonly string[], home: string): string[] {
  const names = roots.map(root => PROTECTED_STORAGE.find(row => row.darwin.some(one => real(join(home, one)) === root))?.app ?? basename(root));
  return [...new Set(names)];
}

/** Why nothing was launched, and what the person does about it. */
export function storageBlockedWords(roots: readonly string[], home: string): string {
  const apps = appsOf(roots, home);
  const named = apps.length === 1 ? apps[0]! : `${apps.slice(0, -1).join(", ")} and ${apps.at(-1)!}`;
  return `Nothing was started: macOS is asking whether Toolroll may look inside ${named}'s data, and until it can, Toolroll can't tell what to keep out of a build. Answer the prompt, or allow Toolroll in System Settings → Privacy & Security (App Management or Full Disk Access), then try again.`;
}

/** How long the longer look may take, after the first look ran out (a slow Mac answers in time; one asking the person doesn't). */
export const SLOW_LOOK_MS = 10_000;
/** A launch refused for waiting roots stays refused this long without looking again, so a run of launches doesn't each wait. */
const REFUSED_FOR_MS = 60_000;
const refusedLooks = new Map<string, number>();

/** The longer look at roots the first look didn't finish: those that answer now, remembered as answering. */
export function rootsAnsweringLate(roots: readonly string[], look: (roots: readonly string[]) => RootsLook = roots => lookAtRoots(roots, SLOW_LOOK_MS), now: () => number = Date.now): ReadonlySet<string> {
  const key = [...roots].sort().join("\0");
  const refused = refusedLooks.get(key);
  if (refused !== undefined && now() - refused < REFUSED_FOR_MS) return new Set();
  const seen = look(roots);
  if (seen.outcome === "failed") throw new Error("Toolroll couldn't look inside other apps' data to fence it (the look failed), so nothing was launched.");
  for (const root of seen.finished) rootLooks.set(root, { listable: true, at: now() });
  if (seen.finished.length < roots.length) refusedLooks.set(key, now()); else refusedLooks.delete(key);
  return new Set(seen.finished);
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

/** The key `unwalkedSaid` keeps for "the containers couldn't be listed" (said once per process). */
const CONTAINERS_UNLISTED = "\0containers";

/** A root directly in the home folder's Library/Containers or Library/Group Containers: another app's container. */
function inAppContainer(root: string, home: string): boolean {
  return dirname(root) === real(join(home, CONTAINERS)) || dirname(root) === real(join(home, GROUPS));
}

/** How long the look at other apps' containers may take before Toolroll takes it that macOS is waiting on the person. */
export const CONTAINER_LOOK_MS = 3_000;
/** How long a "can't list them" answer stands before the next launch looks again (the person may have allowed it since). */
const CONTAINER_RELOOK_MS = 10 * 60_000;
/** Each set of container roots' last answer: listable, or not and when that was seen. */
const containerLooks = new Map<string, { listable: boolean; at: number }>();

/** The look itself, in a child process: the same bounded walk `outwardLinks` makes, never following a link. */
const CONTAINER_LOOK = `const fs=require("fs"),path=require("path");const [depth,limit,...roots]=process.argv.slice(1);
for(const root of roots){let seen=0;const queue=[{p:root,d:0}];while(queue.length>0){const {p,d}=queue.shift();let entries;
try{entries=fs.readdirSync(p,{withFileTypes:true});}catch{continue;}for(const e of entries){if(++seen>Number(limit)){queue.length=0;break;}
if(!e.isSymbolicLink()&&e.isDirectory()&&d+1<Number(depth))queue.push({p:path.join(p,e.name),d:d+1});}}}`;

/** What a look at the containers found: listable without waiting, macOS waiting on the person (the look timed out), or
 * the look itself failing (it couldn't start, crashed or was killed by anything but its own limit). */
export type ContainerLook = "listable" | "waiting" | "failed";

/**
 * Whether this process can list inside these app containers without macOS stopping to ask the person: the walk run
 * first in a child process that is killed at CONTAINER_LOOK_MS. Finishing in time (listed, or refused outright) means
 * the walk can run here too; only running into that limit means macOS is waiting on the person (only the child waited).
 * A look that fails any other way is tried once more, then throws: the launch is refused rather than fenced with less.
 * A yes is kept (macOS keeps the person's answer); a no is looked at again after CONTAINER_RELOOK_MS.
 */
export function containersListable(roots: readonly string[], look: (roots: readonly string[]) => ContainerLook = lookInContainers, now: () => number = Date.now): boolean {
  const key = [...roots].sort().join("\0");
  const last = containerLooks.get(key);
  if (last !== undefined && (last.listable || now() - last.at < CONTAINER_RELOOK_MS)) return last.listable;
  let answer = look(roots);
  if (answer === "failed") answer = look(roots);
  if (answer === "failed") throw new Error("Toolroll couldn't look inside other apps' containers to fence them (the look failed twice), so nothing was launched.");
  const listable = answer === "listable";
  containerLooks.set(key, { listable, at: now() });
  return listable;
}

/** Each root's last answer outside the containers: a yes stands (macOS keeps it), a no is looked at again after CONTAINER_RELOOK_MS. */
const rootLooks = new Map<string, { listable: boolean; at: number }>();

/** What a look at several roots saw: those it finished, and how it ended. */
export type RootsLook = { finished: readonly string[]; outcome: ContainerLook };

/**
 * Which of these roots can be walked without macOS stopping to ask the person. The look walks them in order and names each
 * as it finishes, so one that waits costs only itself: it is set aside and the look goes on with the rest. A look that
 * fails any other way refuses the launch, as containersListable does. At most two limits' wait in all: what is left then
 * counts as waiting, stays denied by name and real path, and is looked at again later.
 */
export function rootsAnswering(roots: readonly string[], look: (roots: readonly string[]) => RootsLook = lookAtRoots, now: () => number = Date.now): ReadonlySet<string> {
  const answering = new Set<string>();
  let pending = roots.filter(root => {
    const last = rootLooks.get(root);
    if (last?.listable === true) answering.add(root);
    return last === undefined || (!last.listable && now() - last.at >= CONTAINER_RELOOK_MS);
  });
  for (let waits = 0; pending.length > 0;) {
    const seen = look(pending);
    if (seen.outcome === "failed") throw new Error("Toolroll couldn't look inside other apps' data to fence it (the look failed), so nothing was launched.");
    for (const root of seen.finished) { answering.add(root); rootLooks.set(root, { listable: true, at: now() }); }
    pending = pending.filter(root => !seen.finished.includes(root));
    if (seen.outcome === "listable" || pending.length === 0) break;
    // The first root it didn't finish is the one it was held at.
    rootLooks.set(pending[0]!, { listable: false, at: now() });
    pending = pending.slice(1);
    if (++waits >= 2) { for (const root of pending) rootLooks.set(root, { listable: false, at: now() }); break; }
  }
  return answering;
}

/** The look at several roots, in a child: the same walk, writing each root's place when it finishes. */
const ROOTS_LOOK = `${"const fs=require(\"fs\"),path=require(\"path\");const [depth,limit,...roots]=process.argv.slice(1);"}
roots.forEach((root,at)=>{let seen=0;const queue=[{p:root,d:0}];while(queue.length>0){const {p,d}=queue.shift();let entries;
try{entries=fs.readdirSync(p,{withFileTypes:true});}catch{continue;}for(const e of entries){if(++seen>Number(limit)){queue.length=0;break;}
if(!e.isSymbolicLink()&&e.isDirectory()&&d+1<Number(depth))queue.push({p:path.join(p,e.name),d:d+1});}}fs.writeSync(1,at+"\\n");});`;

function lookAtRoots(roots: readonly string[], limit: number = CONTAINER_LOOK_MS): RootsLook {
  const result = spawnSync(process.execPath, ["-e", ROOTS_LOOK, String(PROTECTED_WALK.depth), String(PROTECTED_WALK.entries), ...roots],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: limit, killSignal: "SIGKILL", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
  const finished = String(result.stdout ?? "").split("\n").filter(line => /^[0-9]+$/.test(line)).map(line => roots[Number(line)]).filter((root): root is string => root !== undefined);
  return { finished, outcome: lookOutcome(result) };
}

/** The child-process look (containersListable): node (or Electron as node) walks the roots, killed at its limit. */
function lookInContainers(roots: readonly string[]): ContainerLook {
  const result = spawnSync(process.execPath, ["-e", CONTAINER_LOOK, String(PROTECTED_WALK.depth), String(PROTECTED_WALK.entries), ...roots],
    { stdio: "ignore", timeout: CONTAINER_LOOK_MS, killSignal: "SIGKILL", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
  return lookOutcome(result);
}

/** A look's outcome from its child's result: only its own limit (ETIMEDOUT) is macOS waiting; any other error, signal
 * or exit code is a failed look. */
export function lookOutcome(result: { error?: Error; signal: NodeJS.Signals | null; status: number | null }): ContainerLook {
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") return "waiting";
  return result.error === undefined && result.signal === null && result.status === 0 ? "listable" : "failed";
}

/** The answers a container walk takes as complete: the folder isn't there, or macOS refused it outright. */
const ANSWERED: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR", "EPERM", "EACCES"]);
/** At most this much is ever read back from the link cache. */
const LINK_CACHE_MAX = 256 * 1024;

/** Where the outward links the last complete container walk found are kept: the plane's own state folder (fenced from
 * every build), one file per user. */
export function linkCacheFile(home: string, env: Readonly<Record<string, string | undefined>> = process.env): string {
  return join(namedFolder(configBase({ ...env }, home)), "protected-links.json");
}

type KeptRoot = { at: string; stamp: string | null; targets: string[] };

/** The kept links for this home, by root: only a plain file of this user's (no link), at most LINK_CACHE_MAX, of exactly
 * the kept shape; anything else (an older shape included) is no cache at all. */
export function readLinkCacheRoots(file: string, home: string): Map<string, KeptRoot> | null {
  let fd: number;
  try {
    const held = lstatSync(file);
    if (!held.isFile() || held.size > LINK_CACHE_MAX || (process.getuid !== undefined && held.uid !== process.getuid())) return null;
    fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
  } catch { return null; }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > LINK_CACHE_MAX || (process.getuid !== undefined && opened.uid !== process.getuid())) return null;
    const buffer = Buffer.alloc(opened.size);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const value = JSON.parse(buffer.subarray(0, read).toString("utf8")) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const { version, home: kept, roots } = value as Record<string, unknown>;
    if (version !== 2 || kept !== home || roots === null || typeof roots !== "object" || Array.isArray(roots)) return null;
    const out = new Map<string, KeptRoot>();
    for (const [root, one] of Object.entries(roots as Record<string, unknown>)) {
      const entry = one as Record<string, unknown> | null;
      if (!isAbsolute(root) || entry === null || typeof entry !== "object" || typeof entry["at"] !== "string" || Number.isNaN(Date.parse(entry["at"])) || !(entry["stamp"] === null || typeof entry["stamp"] === "string")
        || !Array.isArray(entry["targets"]) || entry["targets"].some(target => typeof target !== "string" || !isAbsolute(target))) return null;
      out.set(root, { at: entry["at"], stamp: entry["stamp"] as string | null, targets: entry["targets"] as string[] });
    }
    return out;
  } catch { return null; }
  finally { closeSync(fd); }
}

/** Every kept link for this home, whichever root it was found in. */
export function readLinkCache(file: string, home: string): string[] | null {
  const roots = readLinkCacheRoots(file, home);
  return roots === null ? null : [...new Set([...roots.values()].flatMap(one => one.targets))].sort();
}

/** Keep these roots' complete walks beside the others kept: written aside (owner-only) and renamed into place, only into a
 * state folder that is already there. A failed write keeps whatever was kept before. */
export function writeLinkCacheRoots(file: string, home: string, walked: ReadonlyMap<string, readonly string[]>, kept: ReadonlyMap<string, KeptRoot> | null, at: number): void {
  if (!existsSync(dirname(file))) return;
  const roots: Record<string, KeptRoot> = Object.fromEntries(kept ?? []);
  for (const [root, targets] of walked) roots[root] = { at: new Date(at).toISOString(), stamp: rootStamp(root), targets: [...new Set(targets)].sort() };
  const aside = `${file}.${process.pid}.part`;
  try {
    writeFileSync(aside, JSON.stringify({ version: 2, home, roots }), { mode: 0o600, flag: "wx" });
    renameSync(aside, file);
  } catch { rmSync(aside, { force: true }); }
}
