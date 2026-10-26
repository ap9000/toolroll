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
import { closeSync, fstatSync, lstatSync, openSync, constants as fsConstants, readSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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
  let fd: number;
  try { fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)); } catch { return []; }
  try {
    const held = fstatSync(fd);
    if (!held.isFile()) return [];
    const buffer = Buffer.alloc(Math.min(held.size, 64 * 1024));
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).toString("utf8").split(/\r?\n/)
      .map(line => /^\s*Path\s*=\s*(.+?)\s*$/i.exec(line)?.[1] ?? null)
      .filter((path): path is string => path !== null && isAbsolute(path));
  } catch { return []; }
  finally { closeSync(fd); }
}

const unwalkedSaid = new Set<string>();

/**
 * Every protected path one launch denies: each root by name and by real path, every link inside a present root that
 * leads outward (where it leads, by real path and as spelled), and the overrides. Resolved at each launch, never kept.
 * A link macOS makes in a sandboxed app's container to the same place under the home folder (its Desktop, Downloads,
 * Fonts…) is the system's own mirror of the person's folders, not the app's data, and isn't followed (systemMirror).
 */
export function protectedStorageDenies(home: string = homedir(), env: Readonly<Record<string, string | undefined>> = process.env, platform: NodeJS.Platform = process.platform,
  say: (line: string) => void = line => process.stderr.write(`${line}\n`)): string[] {
  const base = real(home);
  const out = new Set<string>();
  const add = (path: string) => { if (!tooWide(path, base)) out.add(path); };
  for (const name of protectedStorageNames(base, env, platform)) {
    add(name);
    let present = false;
    try { lstatSync(name); present = true; } catch { /* denied by name only */ }
    if (!present) continue;
    const root = real(name);
    add(root);
    for (const target of outwardLinks(name, root, base, say)) add(target);
  }
  return [...out].sort();
}

/** Where the links inside a present root lead, when outside it: a walk that never follows a link, bounded. */
function outwardLinks(name: string, root: string, home: string, say: (line: string) => void): string[] {
  const found: string[] = [];
  let seen = 0;
  const queue: { path: string; depth: number }[] = [{ path: root, depth: 0 }];
  while (queue.length > 0) {
    const { path, depth } = queue.shift()!;
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(path, { withFileTypes: true }); } catch { continue; }
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
