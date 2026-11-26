/**
 * What to do when a program Toolroll won't start fails its trust check (trusted-path.ts): which canonical paths fail and
 * why (owned by another user, writable by the group, writable by everyone, an extended ACL), and the exact commands
 * that repair them. The trust checks themselves never change: this module only reads, names and prints.
 *
 * - Every failing path is the canonical one (symlinks resolved): the program's real file and each real folder above it.
 * - Toolroll's own installed package (its folder, its dependencies inside it) gets one recursive command; chmod -R
 *   never follows a symlink it meets inside. Nothing else ever does: a shared prefix, a home folder or another
 *   program's install (an agent's) gets one command per failing path.
 * - Ownership is never changed (no chown, even as root): a path someone else owned may hold what they put there, so it
 *   is reinstalled instead. A system program (bwrap, socat, …) is never repaired here at all (sandbox-tools.ts).
 * - Paths are single-quoted; a path with a control, separator or invisible format character gets no command (reinstall
 *   instead), and every path shown is escaped (shown-text.ts): a name can't forge a line of the repair.
 * - Removing write access doesn't prove nothing was changed while others could write: the repair says to reinstall
 *   when anyone else uses the computer, and how to keep new installs protected (umask 022). Each caller says how to
 *   check again (`toolroll doctor`, `toolroll agents`, or the start itself).
 *
 * Also: protectTree, the explicit mode fix Toolroll applies to an install it makes itself (a staged runtime), whatever
 * the umask it ran under.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { hasUnsafeText, shownText } from "./shown-text.js";
import { aclVerdictOf } from "./trusted-path.js";

export type TrustFaultKind = "owner" | "group-write" | "world-write" | "acl";
export type TrustFault = { path: string; kind: TrustFaultKind; owner?: number };
export type TrustRepair = { faults: TrustFault[]; commands: string[]; notes: string[] };

export type TrustRepairOptions = {
  /** Who may own each path (uids). */
  owners: readonly number[];
  /** A sticky shared folder above the file is fine (the user-owned rule, trusted-path.ts trustedFolders). */
  stickyAbove?: boolean;
  /** The canonical folder of an install Toolroll owns (its own package): one recursive command covers it. */
  ownTree?: string | null;
  /** Whether a path carries an extended ACL ("acl"), none ("none"), or that can't be told ("unknown"). */
  acl?: (path: string) => "acl" | "none" | "unknown";
  /** The effective uid running the commands (sudo is added for a root-owned path when this isn't root). */
  euid?: number;
  platform?: NodeJS.Platform;
};

const quote = (path: string): string => `'${path.replace(/'/g, `'\\''`)}'`;
const inside = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

/** Whether `path` carries an extended ACL: macOS's `ls -lde` entries, Linux's `ls -ld` "+" after the mode. */
export function platformAclMark(platform: NodeJS.Platform = process.platform): (path: string) => "acl" | "none" | "unknown" {
  return path => {
    if (/[\u0000-\u001f\u007f]/.test(path)) return "unknown";
    const ran = spawnSync("/bin/ls", platform === "darwin" ? ["-lde", "--", path] : ["-ld", "--", path], { encoding: "utf8", timeout: 2_000, env: { LC_ALL: "C", PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "ignore"] });
    if (ran.status !== 0 || typeof ran.stdout !== "string" || ran.stdout === "") return "unknown";
    if (platform === "darwin") return aclVerdictOf(ran.stdout).ok ? "none" : "acl";
    const mode = /^[-dlbcpsw][-rwxsStT]{9}([+.@]?) /.exec(ran.stdout);
    return mode === null ? "unknown" : mode[1] === "+" ? "acl" : "none";
  };
}

/** The canonical failing paths of `path`'s real file and every real folder above it, by kind. Null when the path
 * can't be read (missing, unreadable): nothing to repair from here. */
export function trustFaults(path: string, options: TrustRepairOptions): TrustFault[] | null {
  let real: string;
  try { real = realpathSync(path); } catch { return null; }
  const acl = options.acl ?? platformAclMark(options.platform);
  const faults: TrustFault[] = [];
  try {
    // A folder checked by itself is its own first folder; a file's is the folder holding it.
    const base = lstatSync(real).isDirectory() ? real : dirname(real);
    for (let at = real; ; at = dirname(at)) {
      const info = lstatSync(at);
      if (!options.owners.includes(info.uid)) faults.push({ path: at, kind: "owner", owner: info.uid });
      // Above the file's own folder, a sticky shared folder (/tmp) passes the user-owned rule; never the file or its folder.
      const sticky = info.isDirectory() && (info.mode & 0o1000) !== 0;
      const stickyPass = options.stickyAbove === true && sticky && at !== real && at !== base;
      if (stickyPass) { if (dirname(at) === at) break; continue; }
      const groupWrite = (info.mode & 0o020) !== 0;
      if ((info.mode & 0o002) !== 0) faults.push({ path: at, kind: "world-write" });
      else if (groupWrite) faults.push({ path: at, kind: "group-write" });
      // macOS: an ACL entry that allows a change (ls -le). Linux: an ACL's write shows in the group bits (its mask), so
      // an ACL counts only where those bits allow writing: then the named users and groups may write too.
      const darwin = (options.platform ?? process.platform) === "darwin";
      if ((darwin || groupWrite) && acl(at) === "acl") faults.push({ path: at, kind: "acl" });
      if (dirname(at) === at) break;
    }
  } catch { return null; }
  return faults;
}

/** The repair for `paths` (see the header): its faults, the commands, and what to know. Null when nothing fails. */
export function trustRepair(paths: string | readonly string[], options: TrustRepairOptions): TrustRepair | null {
  const seen = new Set<string>();
  const faults: TrustFault[] = [];
  for (const path of typeof paths === "string" ? [paths] : paths) {
    for (const fault of trustFaults(path, options) ?? []) {
      if (seen.has(`${fault.kind}\0${fault.path}`)) continue;
      seen.add(`${fault.kind}\0${fault.path}`);
      faults.push(fault);
    }
  }
  if (faults.length === 0) return null;
  const platform = options.platform ?? process.platform;
  const euid = options.euid ?? process.geteuid?.() ?? -1;
  const own = options.ownTree ?? null;
  const commands: string[] = [];
  const notes: string[] = [];
  const ownerOf = (path: string): number | null => { try { return lstatSync(path).uid; } catch { return null; } };
  const sudo = (path: string): string => ownerOf(path) === 0 && euid !== 0 ? "sudo " : "";
  const unsafe = faults.filter(one => hasUnsafeText(one.path));
  if (unsafe.length > 0) {
    notes.push("A path has a control or invisible character in its name, so no command is printed for it: reinstall that program into a plain folder you own.");
  }
  const fixable = faults.filter(one => !unsafe.includes(one));
  // Each command with the path it is for, so all run outermost first. Paths are absolute, so none reads as an option.
  const planned: { at: string; command: string }[] = [];
  // Toolroll's own install: one recursive command for its whole tree (its dependencies included).
  const inOwn = own === null ? [] : fixable.filter(one => inside(one.path, own) && one.kind !== "owner");
  if (own !== null && inOwn.some(one => one.kind === "acl")) planned.push({ at: own, command: platform === "darwin" ? `${sudo(own)}chmod -R -N ${quote(own)}` : `${sudo(own)}setfacl -R -b ${quote(own)}` });
  if (own !== null && inOwn.length > 0) planned.push({ at: own, command: `${sudo(own)}chmod -R go-w ${quote(own)}` });
  // Everything else: one command per failing path.
  const rest = fixable.filter(one => !inOwn.includes(one));
  for (const at of new Set(rest.map(one => one.path))) {
    const kinds = new Set(rest.filter(one => one.path === at).map(one => one.kind));
    if (kinds.has("owner")) {
      const owner = rest.find(one => one.path === at && one.kind === "owner")?.owner;
      // Never a chown, even as root: handing a path someone else owned to root would make whatever they put there look
      // trusted. Only a reinstall from a trusted source fixes it.
      notes.push(`${shownText(at)} belongs to another user (uid ${owner ?? "unknown"}), so what is in it can't be trusted: reinstall into a folder that you or root own.`);
    }
    if (kinds.has("acl")) planned.push({ at, command: platform === "darwin" ? `${sudo(at)}chmod -N ${quote(at)}` : `${sudo(at)}setfacl -b ${quote(at)}` });
    if (kinds.has("group-write") || kinds.has("world-write") || (kinds.has("acl") && platform !== "darwin")) planned.push({ at, command: `${sudo(at)}chmod go-w ${quote(at)}` });
  }
  const depth = (path: string): number => path.split(sep).length;
  // A stable sort: a path's own commands keep their order (an ACL's removal before the mode's).
  commands.push(...planned.map((one, index) => ({ ...one, index })).sort((a, b) => depth(a.at) - depth(b.at) || a.index - b.index).map(one => one.command));
  if (faults.some(one => one.kind !== "owner")) {
    notes.push("Others could change these files until now. If anyone else uses this computer, reinstall from a trusted source too.");
    const mask = currentUmask();
    if (mask !== null && (mask & 0o022) !== 0o022) notes.push(`New files here are made writable by others (umask ${mask.toString(8).padStart(4, "0")}): run \`umask 022\` before installing, or add it to your shell profile.`);
  }
  return { faults, commands, notes };
}

/** This process's umask, or null where it can't be read. */
function currentUmask(): number | null {
  try { return process.umask(); } catch { return null; }
}

/** The fault, in words. */
export function trustFaultWords(fault: TrustFault): string {
  const path = shownText(fault.path);
  return fault.kind === "owner" ? `${path} belongs to another user`
    : fault.kind === "world-write" ? `everyone can change ${path}`
    : fault.kind === "group-write" ? `its group can change ${path}`
    : `${path} has an extended ACL`;
}

/** The repair as lines: the commands (each names its path, so the faults aren't listed again), else what fails (a few),
 * then the notes. */
export function trustRepairLines(repair: TrustRepair): string[] {
  const listed = repair.faults.filter(fault => fault.kind !== "owner").slice(0, 5);
  return [
    ...(repair.commands.length > 0 ? ["Fix it with:", ...repair.commands.map(one => `  ${one}`)] : listed.map(fault => `  ${trustFaultWords(fault)}`)),
    ...repair.notes,
  ].map(shownText);
}

/** Toolroll's own installed package folder (the nearest real folder above this module holding a package.json, when that
 * package is Toolroll's), or null. */
export function toolrollPackageRoot(from: string = fileURLToPath(import.meta.url)): string | null {
  let at: string;
  try { at = realpathSync(dirname(from)); } catch { return null; }
  for (;;) {
    try {
      if (lstatSync(join(at, "package.json")).isFile()) {
        const name = (JSON.parse(readFileSync(join(at, "package.json"), "utf8")) as { name?: unknown }).name;
        return name === "toolroll" || name === "standing-orders" ? at : null;
      }
    } catch { /* keep looking */ }
    const up = dirname(at);
    if (up === at) return null;
    at = up;
  }
}

/**
 * An install Toolroll made itself: every file and folder under `root` (and `root`) loses group and world write,
 * whatever umask it was made under. A symlink is never followed or changed. Throws when a path can't be changed.
 */
export function protectTree(root: string): void {
  const walk = (at: string): void => {
    const info = lstatSync(at);
    if (info.isSymbolicLink()) return;
    if ((info.mode & 0o022) !== 0) chmodSync(at, info.mode & 0o7755);
    if (info.isDirectory()) for (const name of readdirSync(at)) walk(join(at, name));
  };
  walk(root);
}

/** Two repairs as one: faults, commands and notes each once, in order. */
export function mergeRepairs(a: TrustRepair | null, b: TrustRepair | null): TrustRepair | null {
  if (a === null || b === null) return a ?? b;
  const once = <T>(list: T[], key: (one: T) => string): T[] => { const seen = new Set<string>(); return list.filter(one => { const k = key(one); if (seen.has(k)) return false; seen.add(k); return true; }); };
  return {
    faults: once([...a.faults, ...b.faults], one => `${one.kind}\0${one.path}`),
    commands: once([...a.commands, ...b.commands], one => one),
    notes: once([...a.notes, ...b.notes], one => one),
  };
}
