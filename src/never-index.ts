/**
 * Spotlight leaves Toolroll's churn alone: a `.metadata_never_index` file in a folder tells macOS not to index it or
 * what is inside. Toolroll puts one in the folders it fills and empties all day — the checkouts folder and each
 * project's folder in it (never inside a checkout, where a build's `git add -A` would commit it), shared dependency
 * installs, staged runtimes and test temp roots. Measured Oct 4: fseventsd at 15 GB with 107k test temp folders.
 *
 * A marker that can't be written is only noted: it never decides whether anything is removed.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const NEVER_INDEX = ".metadata_never_index";

/** Put the marker in `dir` (an existing folder). False when it couldn't be written. */
export function markNeverIndex(dir: string): boolean {
  try {
    writeFileSync(join(dir, NEVER_INDEX), "", { flag: "a" });
    return true;
  } catch {
    return false;
  }
}
