import { createRequire } from "node:module";
import { closeSync, constants, lstatSync, openSync, realpathSync } from "node:fs";
import { dirname, join, basename } from "node:path";

/** Separate from orders.db: no live writer is reserved while deployment drains or backs up.
 * SQLite owns the OS lock until close/process death, including SIGKILL. Never unlink this file:
 * replacing its inode would let two contenders hold different locks for the same journal. */
export type DeploymentLock = {
  assertHeld(journalFile: string): void;
  release(): void;
};

const canonical = (file: string) => join(realpathSync(dirname(file)), basename(file));

export function acquireDeploymentLock(journalFile: string, waitMs = 5000): DeploymentLock {
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 5000) throw Error("Invalid deployment lock wait.");
  const journal = canonical(journalFile), file = `${journal}.lock.sqlite`;
  // Only create a missing file. On POSIX, closing ANY independently opened descriptor
  // for an existing inode can drop this process's fcntl lock, even another connection's.
  // Let SQLite manage all descriptors for an existing coordination file.
  try {
    const fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    closeSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (!lstatSync(file).isFile()) throw Error(`Unexpected deployment lock: ${file}`);
  // Lazy, as elsewhere in the CLI: merely importing the help must not load SQLite.
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA busy_timeout=${waitMs}; BEGIN EXCLUSIVE`);
  } catch (cause) {
    db.close();
    throw new Error(`Deployment is busy or its lock is unavailable: ${journal}. Let it finish, then retry.`, { cause });
  }
  let held = true;
  return {
    assertHeld(expected) {
      if (!held || canonical(expected) !== journal) throw Error("The deployment journal lock is not held.");
    },
    release() {
      if (!held) return;
      db.close();
      held = false;
    },
  };
}
