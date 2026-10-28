/**
 * Where the plane makes its private views of a repository for git (teardown-git.ts gitView): a folder of its own under
 * the home folder's `~/.toolroll`, which every fence denies to builds, read and write (agent-fence.ts agentFence names
 * this folder by name, made first so no build can be the one to create it). A view in the system temp folder could be
 * rewritten by a build that writes anywhere and outlived its turn (Codex review of e48e9d8d).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
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

/**
 * One plane git command at a time on a checkout (Codex review of a0fa135d): each command's private GIT_DIR has its own
 * HEAD, so two at once would each take their own HEAD lock and the later carry-back would undo the earlier. The lock
 * is a file the plane makes exclusively in the fenced views folder, named by the checkout's real path, holding this
 * process's id; one whose process is gone is taken over. Waits up to `timeoutMs`; returns the release.
 */
export async function lockCheckout(home: string, checkout: string, timeoutMs = 10 * 60_000): Promise<() => void> {
  const folder = join(ensureGitViewsRoot(home), "locks");
  try { mkdirSync(folder, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const held = lstatSync(folder);
  if (!held.isDirectory() || held.isSymbolicLink()) throw new Error(`${folder} isn't a folder of this user's own`);
  const path = join(folder, `${createHash("sha256").update(checkout).digest("hex")}.lock`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
      try { writeSync(fd, `${process.pid}\n`); } finally { closeSync(fd); }
      let released = false;
      return () => { if (!released) { released = true; rmSync(path, { force: true }); } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    // Held: by a live process, wait; by one that is gone, take it over.
    let owner = NaN;
    try { owner = Number(readFileSync(path, "utf8").trim()); } catch { owner = NaN; }
    if (Number.isSafeInteger(owner) && owner > 0 && owner !== process.pid && !alive(owner)) { rmSync(path, { force: true }); continue; }
    if (Date.now() > deadline) throw new Error("another of Toolroll's git commands on this checkout is still running");
    await new Promise(done => setTimeout(done, 25));
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** The checkouts the current async call chain already holds (lockCheckout through withCheckoutLock). */
const heldHere = new AsyncLocalStorage<ReadonlySet<string>>();

/**
 * Run `work` holding the checkout's lock (lockCheckout). Re-entrant along one call chain: a hardened git nested in
 * another on the same checkout (teardown's git run through the builder's hardened runner, a view within a view) runs
 * under the lock its caller already holds instead of waiting on itself.
 */
export async function withCheckoutLock<T>(home: string, checkout: string, work: () => Promise<T>): Promise<T> {
  const held = heldHere.getStore() ?? new Set<string>();
  if (held.has(checkout)) return work();
  const release = await lockCheckout(home, checkout);
  try { return await heldHere.run(new Set([...held, checkout]), work); } finally { release(); }
}
