/**
 * Whether a program on this computer may be started: the trust anchor is where it lives and who can change it, never
 * what it prints or what the environment says. Shared by the terminal workbench's launcher (tui-launch.ts) and the
 * agent sign-in checks (status-probe.ts).
 *
 * Its real path (symlinks resolved) must be a regular file owned by this user or root and not writable by group or
 * others, in folders that are all owned by this user or root and not writable by group or others (an ancestor may be a
 * sticky shared folder such as /tmp: nobody else can rename what is in it), and on macOS none of them may carry an ACL
 * entry that allows anyone a change right (write, append, add_file, add_subdirectory, delete, delete_child, writeattr,
 * writeextattr, writesecurity, chown; deny entries are fine, and an ACL that can't be read refuses). On Linux a POSIX
 * ACL granting write shows up in the group mode bits (its mask), so the mode check covers it. Then nobody but this user
 * (or root) can replace it between the check and the start.
 */
import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

/** macOS ACL rights that let someone change a file or folder (an `allow` entry with any of these refuses). */
const ACL_CHANGE: ReadonlySet<string> = new Set(["write", "append", "add_file", "add_subdirectory", "delete", "delete_child", "writeattr", "writeextattr", "writesecurity", "chown"]);
/** Every right `ls -le` may print; an unknown word refuses (the parser is strict). */
const ACL_RIGHTS: ReadonlySet<string> = new Set([...ACL_CHANGE, "read", "execute", "readattr", "readextattr", "readsecurity", "list", "search", "file_inherit", "directory_inherit", "limit_inherit", "only_inherit"]);
const ACL_READ_MS = 3_000;

export type AclVerdict = { ok: true } | { ok: false; why: string };
export type AclReader = (path: string) => AclVerdict;
type Verdict = { ok: true } | { ok: false; why: string };

/** This platform's ACL reader: macOS's `ls -lde`; none elsewhere (the mode bits carry a POSIX ACL's write). */
export const platformAcl = (): AclReader | null => (process.platform === "darwin" ? macAcl : null);

/**
 * A fresh ACL reader for one resolution, asking each path once and never past `deadline` (epoch ms): each read is capped
 * at the time left, and once none is left every answer refuses ("can't be read in time"). On macOS the read is a
 * synchronous `ls`, so the cap is what keeps a whole check inside its deadline. Never shared between two resolutions.
 */
export function boundedAcl(deadline: number, read: ((path: string, ms: number) => AclVerdict) | null = process.platform === "darwin" ? macAclWithin : null): AclReader | null {
  if (read === null) return null;
  const seen = new Map<string, AclVerdict>();
  return path => {
    let verdict = seen.get(path);
    if (verdict === undefined) {
      const left = deadline - Date.now();
      verdict = left <= 0 ? { ok: false, why: "can't be read in time" } : read(path, Math.min(left, ACL_READ_MS));
      seen.set(path, verdict);
    }
    return verdict;
  };
}

/**
 * `folder` (a real path) and every folder above it: owned by `uid` or root, not group- or world-writable (above the
 * first, a sticky folder may be), and no ACL that lets anyone change it.
 */
export function trustedFolders(folder: string, uid: number, acl: AclReader | null): Verdict {
  const owned = (owner: number) => owner === uid || owner === 0;
  try {
    for (let first = true; ; first = false) {
      const dir = lstatSync(folder);
      if (!dir.isDirectory()) return { ok: false, why: `${folder} isn't a folder` };
      if (!owned(dir.uid)) return { ok: false, why: `${folder} is owned by another user` };
      const sticky = (dir.mode & 0o1000) !== 0;
      if ((dir.mode & 0o022) !== 0 && (first || !sticky)) return { ok: false, why: `others can change ${folder} (group- or world-writable)` };
      const dirAcl = acl?.(folder);
      if (dirAcl !== undefined && !dirAcl.ok) return { ok: false, why: `the ACL of ${folder} ${dirAcl.why}` };
      const up = dirname(folder);
      if (up === folder) return { ok: true };
      folder = up;
    }
  } catch (error) {
    return { ok: false, why: `it can't be checked (${(error as NodeJS.ErrnoException).code ?? "unreadable"})` };
  }
}

/**
 * Whether `path` may be started: its real path is a regular file owned by `uid` or root and not group- or
 * world-writable, and so is every folder above it (an ancestor may instead be a sticky folder). The real path, or why not.
 */
export function trustedBinary(path: string, uid: number | undefined, acl: AclReader | null = platformAcl()): { ok: true; real: string } | { ok: false; why: string } {
  if (!isAbsolute(path)) return { ok: false, why: "it isn't an absolute path" };
  if (uid === undefined) return { ok: false, why: "who owns it can't be checked on this system" };
  let real: string;
  try { real = realpathSync(path); } catch (error) { return { ok: false, why: `it isn't there (${(error as NodeJS.ErrnoException).code ?? "unreadable"})` }; }
  try {
    const file = lstatSync(real);
    if (!file.isFile()) return { ok: false, why: "it isn't a file" };
    if (file.uid !== uid && file.uid !== 0) return { ok: false, why: "it is owned by another user" };
    if ((file.mode & 0o022) !== 0) return { ok: false, why: "others can change it (group- or world-writable)" };
    const fileAcl = acl?.(real);
    if (fileAcl !== undefined && !fileAcl.ok) return { ok: false, why: `its ACL ${fileAcl.why}` };
  } catch (error) {
    return { ok: false, why: `it can't be checked (${(error as NodeJS.ErrnoException).code ?? "unreadable"})` };
  }
  const folders = trustedFolders(dirname(real), uid, acl);
  return folders.ok ? { ok: true, real } : folders;
}

/**
 * Root's own folder: `folder` (made real here) and every folder above it are owned by root and not group- or
 * world-writable (no sticky pass: a sticky /tmp still lets anyone add a name there), with no ACL that lets anyone change
 * one. `owners`: who counts as root, [0] everywhere but a test standing its own uid in for root. The real path, or why not.
 */
export function rootOwnedFolders(folder: string, acl: AclReader | null = platformAcl(), owners: readonly number[] = [0]): { ok: true; real: string } | { ok: false; why: string } {
  let real: string;
  try { real = realpathSync(folder); } catch (error) { return { ok: false, why: `${folder} isn't there (${(error as NodeJS.ErrnoException).code ?? "unreadable"})` }; }
  try {
    for (let at = real; ; at = dirname(at)) {
      const dir = lstatSync(at);
      if (!dir.isDirectory()) return { ok: false, why: `${at} isn't a folder` };
      if (!owners.includes(dir.uid)) return { ok: false, why: `${at} isn't owned by root` };
      if ((dir.mode & 0o022) !== 0) return { ok: false, why: `others can change ${at} (group- or world-writable)` };
      const dirAcl = acl?.(at);
      if (dirAcl !== undefined && !dirAcl.ok) return { ok: false, why: `the ACL of ${at} ${dirAcl.why}` };
      if (dirname(at) === at) return { ok: true, real };
    }
  } catch (error) {
    return { ok: false, why: `it can't be checked (${(error as NodeJS.ErrnoException).code ?? "unreadable"})` };
  }
}

/**
 * Root's own program: `path`'s real path (its canonical target, symlinks resolved) is a regular file owned by root, not
 * group- or world-writable, with no ACL change right, in folders that are all root's own (rootOwnedFolders). Only root
 * can replace it. `owners`: as rootOwnedFolders. The real path, or why not.
 */
export function rootOwnedBinary(path: string, acl: AclReader | null = platformAcl(), owners: readonly number[] = [0]): { ok: true; real: string } | { ok: false; why: string } {
  if (!isAbsolute(path)) return { ok: false, why: "it isn't an absolute path" };
  let real: string;
  try { real = realpathSync(path); } catch (error) { return { ok: false, why: `it isn't there (${(error as NodeJS.ErrnoException).code ?? "unreadable"})` }; }
  try {
    const file = lstatSync(real);
    if (!file.isFile()) return { ok: false, why: "it isn't a file" };
    if (!owners.includes(file.uid)) return { ok: false, why: `${real} isn't owned by root` };
    if ((file.mode & 0o022) !== 0) return { ok: false, why: `others can change ${real} (group- or world-writable)` };
    const fileAcl = acl?.(real);
    if (fileAcl !== undefined && !fileAcl.ok) return { ok: false, why: `its ACL ${fileAcl.why}` };
  } catch (error) {
    return { ok: false, why: `it can't be checked (${(error as NodeJS.ErrnoException).code ?? "unreadable"})` };
  }
  const folders = rootOwnedFolders(dirname(real), acl, owners);
  return folders.ok ? { ok: true, real } : folders;
}

/**
 * A macOS ACL, from `/bin/ls -lde <path>`'s output (strict): the first line is the mode line, every other line one entry
 * ` N: <who> [inherited ]allow|deny <right>[,<right>...]`. Refused: an `allow` entry with any change right, any line that
 * isn't that shape, a right this parser doesn't know, and no output at all. Deny entries pass (every macOS home folder
 * has `group:everyone deny delete`).
 */
export function aclVerdictOf(output: string): AclVerdict {
  const lines = output.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0 || !/^[-dlbcpsw][-rwxsStT]{9}[@+]? /.test(lines[0]!)) return { ok: false, why: "can't be read" };
  for (const line of lines.slice(1)) {
    const entry = /^ \d+: (\S.*?) (?:inherited )?(allow|deny) ([a-z_]+(?:,[a-z_]+)*)$/.exec(line);
    if (entry === null) return { ok: false, why: "can't be read" };
    const rights = entry[3]!.split(",");
    if (rights.some(right => !ACL_RIGHTS.has(right))) return { ok: false, why: "can't be read (an unknown right)" };
    const granted = rights.filter(right => ACL_CHANGE.has(right));
    if (entry[2] === "allow" && granted.length > 0) return { ok: false, why: `allows ${entry[1]} to change it (${granted.join(",")})` };
  }
  return { ok: true };
}

/** The ACL of `path` on macOS: `/bin/ls -lde` by its absolute path (no PATH lookup), C locale; unreadable refuses. */
function macAcl(path: string): AclVerdict {
  return macAclWithin(path, ACL_READ_MS);
}
function macAclWithin(path: string, ms: number): AclVerdict {
  // A name with a control character could forge an entry line: refused before asking.
  if (/[\u0000-\u001f\u007f]/.test(path)) return { ok: false, why: "can't be read (a control character in the path)" };
  const ran = spawnSync("/bin/ls", ["-lde", "--", path], { encoding: "utf8", timeout: Math.max(1, Math.floor(ms)), env: { LC_ALL: "C", PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "ignore"] });
  if (ran.status !== 0 || typeof ran.stdout !== "string") return { ok: false, why: "can't be read" };
  return aclVerdictOf(ran.stdout);
}
