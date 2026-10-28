/**
 * Where the plane makes its private views of a repository for git (teardown-git.ts gitView): a folder of its own under
 * the home folder's `~/.toolroll`, which every fence denies to builds, read and write (agent-fence.ts agentFence names
 * this folder by name, made first so no build can be the one to create it). A view in the system temp folder could be
 * rewritten by a build that writes anywhere and outlived its turn (Codex review of e48e9d8d).
 */
import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** The views folder under `home`. */
export function gitViewsRoot(home: string): string {
  return join(home, ".toolroll", "git-views");
}

/**
 * The views folder under `home`, made if it isn't there (owner-only), and proven to be this user's own real folder all
 * the way from `home`: neither it nor `~/.toolroll` may be a link or anyone else's. Throws otherwise.
 */
export function ensureGitViewsRoot(home: string): string {
  const uid = process.getuid?.();
  const base = join(home, ".toolroll");
  const root = gitViewsRoot(home);
  for (const dir of [base, root]) {
    try { mkdirSync(dir, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const held = lstatSync(dir);
    if (!held.isDirectory() || held.isSymbolicLink() || (uid !== undefined && held.uid !== uid)) throw new Error(`${dir} isn't a folder of this user's own`);
  }
  return root;
}
