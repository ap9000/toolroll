/** A launch's project skills as Toolroll wrote them (project-skills.ts materializeProjectSkills), and the check right
 * before a fence grants them. Kept apart from project-skills.ts so the launch roads import only this. */
import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative } from "node:path";

/**
 * What Toolroll wrote for one launch's skills, kept in memory by the plane (never read back from disk to decide a
 * grant): each file by its canonical path and the SHA-256 of the bytes written, and the folders on the way to them. A
 * launch grants exactly these files, read-only, after rechecking them (checkSkillsManifest); never a folder.
 */
export type SkillsManifest = { directory: string; files: { path: string; sha256: string }[]; folders: string[] };
export const sha256Of = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
export const within = (child: string, parent: string): boolean => {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};
/**
 * At launch, right before the grant: every folder is still the real folder it was, and every file the regular file
 * it was (by its canonical path, never through a link) with the bytes it was written with. Returns the exact files to
 * grant, or what changed in plain words.
 */
export function checkSkillsManifest(manifest: SkillsManifest): { ok: true; files: string[] } | { ok: false; problem: string } {
  const changed = (what: string) => ({ ok: false as const, problem: `${what} changed after Toolroll prepared it` });
  try {
    for (const folder of manifest.folders) {
      if (folder !== manifest.directory && !within(folder, manifest.directory)) return changed("A skill folder");
      const held = lstatSync(folder);
      if (!held.isDirectory() || held.isSymbolicLink() || realpathSync(folder) !== folder) return changed("A skill folder");
    }
    for (const file of manifest.files) {
      if (!within(file.path, manifest.directory) || !manifest.folders.includes(dirname(file.path))) return changed("A skill file");
      const there = lstatSync(file.path);
      if (!there.isFile() || there.isSymbolicLink()) return changed("A skill file");
      let fd: number | null = null;
      try {
        fd = openSync(file.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
        const held = fstatSync(fd);
        if (!held.isFile() || realpathSync(file.path) !== file.path || sha256Of(readFileSync(fd)) !== file.sha256) return changed("A skill file");
      } finally { if (fd !== null) closeSync(fd); }
    }
  } catch {
    return { ok: false, problem: "A skill file or folder is missing or can't be read where Toolroll left it" };
  }
  return { ok: true, files: manifest.files.map(file => file.path) };
}

