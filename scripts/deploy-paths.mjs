// Where deploy-browser finds the installation, under the product's current
// name or an older one (src/names.ts). Nothing here moves a folder.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** The candidate's own names module (dist/names.js). */
export const loadNames = dist => import(pathToFileURL(join(dist, "names.js")).href);

/** The state folder under ~/.config (or $XDG_CONFIG_HOME): the one holding
 * orders.db, else the first that exists — the plane's own namedFolder. */
export function deployStateDir(names, env, home) {
  return names.namedFolder(names.configBase(env, home));
}

/** The package folder inside a staged runtime: the candidate's own name, or
 * an older one when the stage was made before the rename; a fresh stage
 * uses the candidate's name. */
export function stagedPackageName(stageDir, packageName, names) {
  return [packageName, ...names.NAMES].find(name => existsSync(join(stageDir, "runtime", "node_modules", name, "package.json"))) ?? packageName;
}

/** Where a staged runtime holds the candidate: the runtime folder, the package
 * inside it (under stagedPackageName) and that package's dist. */
export function stagedRuntimePaths(stageDir, packageName, names) {
  const name = stagedPackageName(stageDir, packageName, names), runtime = join(stageDir, "runtime"), self = join(runtime, "node_modules", name);
  return { name, runtime, self, dist: join(self, "dist") };
}
