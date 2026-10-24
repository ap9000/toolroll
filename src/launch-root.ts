/**
 * Where launches make their private folders (`so-tools-`, `so-codex-`, `so-net-`, `so-cmd-`: agent-fence.ts
 * RUN_FOLDER_PREFIXES). On a Mac, the system temp folder (Seatbelt denies the other launches' folders by name pattern,
 * present or not). On Linux bubblewrap can only mask a path that exists when it sets up, and another launch's folder
 * comes and goes at any moment; so every launch folder lives in a folder of this user's that is always there
 * (`so-runs-<uid>` in the temp folder, owner-only), and each Linux fence masks that folder whole and gives back only its
 * own (agent-fence.ts linuxFenced). A folder there made later is masked too; none can vanish from under a mask.
 *
 * The name is predictable, so anyone could make it first: one that isn't a real folder of this user's is never used.
 * This process then makes a private one of its own (`so-runs-<uid>-XXXXXX`, remembered while it runs, never removed),
 * and every Linux fence masks each of this user's roots it finds, so another Toolroll process's launches stay out of
 * reach too. ($XDG_RUNTIME_DIR isn't used: Linux fences mask `/run/user/<uid>` whole, as the host's own sockets.)
 */
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The prefix of a Linux launch-folder root's name (never one of the launch folders' own prefixes). */
export const LAUNCH_ROOT_PREFIX = "so-runs-";

const chosen = new Map<string, string>();

/** A real folder of this user's alone (never a link), tightened to owner-only if it was looser. */
function ours(path: string, uid: number | undefined): boolean {
  let held;
  try { held = lstatSync(path); } catch { return false; }
  if (held.isSymbolicLink() || !held.isDirectory() || (uid !== undefined && held.uid !== uid)) return false;
  if ((held.mode & 0o077) !== 0) { try { chmodSync(path, 0o700); } catch { return false; } }
  return true;
}

/** The folder launch folders are made in. On Linux: the fixed root, made owner-only if missing; if it isn't a real
 * folder of this user's, a private one this process makes (and keeps using). */
export function launchRoot(platform: NodeJS.Platform = process.platform, base: string = tmpdir()): string {
  if (platform !== "linux") return base;
  const known = chosen.get(base);
  if (known !== undefined && ours(known, process.getuid?.())) return known;
  const uid = process.getuid?.();
  const fixed = join(base, `${LAUNCH_ROOT_PREFIX}${uid ?? "user"}`);
  try { mkdirSync(fixed, { mode: 0o700 }); } catch { /* there already: checked below */ }
  const root = ours(fixed, uid) ? fixed : mkdtempSync(join(base, `${LAUNCH_ROOT_PREFIX}${uid ?? "user"}-`));
  chmodSync(root, 0o700);
  chosen.set(base, root);
  return root;
}

/** Every launch-folder root of this user's in `base` (the fixed one and any private one a process made), each a real
 * folder of this user's: a Linux fence masks them all. */
export function launchRoots(base: string = tmpdir()): string[] {
  const uid = process.getuid?.();
  const name = `${LAUNCH_ROOT_PREFIX}${uid ?? "user"}`;
  let entries: string[] = [];
  try { entries = readdirSync(base); } catch { entries = []; }
  return entries.filter(entry => entry === name || entry.startsWith(`${name}-`)).map(entry => join(base, entry)).filter(path => ours(path, uid)).sort();
}
