import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

/** A project file a script names, if it is one: inside the project, and there. Kept free of the runner's imports so a
 * flow's "runs on its own" grant (flow-unattended.ts) resolves the very file a script would run. */
export function projectFile(root: string, path: string): string | null {
  if (path === "" || isAbsolute(path) || path.split(/[\\/]/).includes("..")) return null;
  try {
    const base = realpathSync(root), full = realpathSync(join(root, path));
    const inside = relative(base, full);
    return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside) && statSync(full).isFile() ? full : null;
  } catch { return null; }
}
