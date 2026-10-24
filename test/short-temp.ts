import { mkdtempSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** Whether a folder couldn't be made because this process may not write there (the plane's check fence, say). */
const refused = (error: unknown) => ["EPERM", "EACCES", "EROFS"].includes((error as NodeJS.ErrnoException).code ?? "");

/**
 * A short folder for a test whose unix socket paths must stay within the OS limit: in /tmp, or, where this may not
 * write there (a check inside the plane's macOS fence writes only its own temp folder), in this run's temp root. Its
 * real path, as /tmp's is.
 */
export function shortTempDir(prefix: string): string {
  try { return realpathSync(mkdtempSync(join("/tmp", prefix))); } catch (error) {
    if (!refused(error)) throw error;
    return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  }
}

/**
 * A folder outside the temp folder, as homes and checkouts are (a Linux build's /tmp is its own): in the person's home,
 * or, where this may not write there (inside the plane's macOS check fence, where /tmp is shared anyway), in this test
 * file's own home (test/setup-state.ts).
 */
export function outsideTempDir(prefix: string): string {
  const outer = process.env["TOOLROLL_TEST_OUTER_HOME"];
  try { return realpathSync(mkdtempSync(join(outer || homedir(), prefix))); } catch (error) {
    if (!refused(error)) throw error;
    return realpathSync(mkdtempSync(join(homedir(), prefix)));
  }
}
