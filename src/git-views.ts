/**
 * Where the plane makes its private views of a repository for git (teardown-git.ts gitView): a folder of its own under
 * the home folder's `~/.toolroll`, which every fence denies to builds, read and write (agent-fence.ts agentFence names
 * this folder by name, made first so no build can be the one to create it). A view in the system temp folder could be
 * rewritten by a build that writes anywhere and outlived its turn (Codex review of e48e9d8d).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { sqliteRuntime } from "./sqlite-runtime.js";

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

/**
 * One plane git command at a time on a checkout (Codex review of a0fa135d): each command's private GIT_DIR has its own
 * HEAD, so two at once would each take their own HEAD lock and the later carry-back would undo the earlier. The lock
 * is the operating system's own: an exclusive (RESERVED) SQLite lock on a small file in the fenced views folder, named
 * by the checkout's SHA-256, held by one open connection until the release. The OS drops it the moment the holding
 * process dies, so there is no stale lock to recover: no owner pid to read (or to be reused), no empty file left by a
 * crash between create and write, no takeover two waiters could both make, and a release can only ever let go of its
 * own connection's lock (Codex round 2 on F2a, finding D). Separate connections in one process exclude each other too
 * (SQLite tracks its locks per file across them). Waits up to `timeoutMs`, a poll every 25 ms that never blocks this
 * thread; returns the release.
 */
export async function lockCheckout(home: string, checkout: string, timeoutMs = 10 * 60_000): Promise<() => void> {
  const folder = join(ensureGitViewsRoot(home), "locks");
  try { mkdirSync(folder, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const held = lstatSync(folder);
  if (!held.isDirectory() || held.isSymbolicLink()) throw new Error(`${folder} isn't a folder of this user's own`);
  const path = join(folder, `${createHash("sha256").update(checkout).digest("hex")}.lockdb`);
  // Only a plain file of its own may hold the lock: a link planted there is never opened (the folder is fenced anyway).
  try { if (!lstatSync(path).isFile()) throw new Error(`${path} isn't a lock file`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const { DatabaseSync } = sqliteRuntime();
  const db = new DatabaseSync(path);
  const deadline = Date.now() + timeoutMs;
  try {
    db.exec("PRAGMA busy_timeout = 0");
    for (;;) {
      try { db.exec("BEGIN IMMEDIATE"); break; }
      catch (error) { if (!/locked|busy/i.test(error instanceof Error ? error.message : String(error))) throw error; }
      if (Date.now() > deadline) throw new Error("another of Toolroll's git commands on this checkout is still running");
      await new Promise(done => setTimeout(done, 25));
    }
  } catch (error) { db.close(); throw error; }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { db.exec("ROLLBACK"); } finally { db.close(); }
  };
}

/** The checkouts the current async call chain already holds (lockCheckout through withCheckoutLock). */
const heldHere = new AsyncLocalStorage<ReadonlySet<string>>();

/**
 * Run `work` holding the checkout's lock (lockCheckout). Re-entrant along one call chain: a hardened git nested in
 * another on the same checkout (teardown's git run through the builder's hardened runner, a view within a view) runs
 * under the lock its caller already holds instead of waiting on itself.
 */
export async function withCheckoutLock<T>(home: string, checkout: string, work: () => Promise<T>, timeoutMs?: number): Promise<T> {
  const held = heldHere.getStore() ?? new Set<string>();
  if (held.has(checkout)) return work();
  const release = await lockCheckout(home, checkout, timeoutMs);
  try { return await heldHere.run(new Set([...held, checkout]), work); } finally { release(); }
}
