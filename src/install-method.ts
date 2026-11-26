/**
 * How this Toolroll was installed, read from where its bin really lives, and
 * the one command that updates it that way. Only the path is read: nothing is
 * run and nothing leaves the computer.
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

export type InstallKind = "npm" | "pnpm" | "bun" | "yarn" | "homebrew" | "npx" | "source" | "managed" | "desktop";
export type InstallMethod = { kind: InstallKind; updateCommand: string };

export const UPDATE_COMMANDS: Record<InstallKind, string> = {
  npm: "npm install -g toolroll@latest",
  pnpm: "pnpm add -g toolroll@latest",
  bun: "bun add -g toolroll@latest",
  yarn: "yarn global add toolroll@latest",
  homebrew: "brew upgrade ap9000/toolroll/toolroll",
  npx: "npx toolroll@latest",
  source: "git pull && npm install && npm run build",
  // A runtime `toolroll update` installed (staged-upgrades/release-* or rollback-*): it updates itself.
  managed: "toolroll update",
  // The Toolroll app carries its own runtime and updates as a whole app, never through a package manager.
  desktop: "Update from the Toolroll app",
};

export type InstallProbe = { realpath?: (path: string) => string; exists?: (path: string) => boolean };

/** The install method of the bin at `bin` (the running one by default). Unknown shapes read as npm, the common case. */
export function installMethod(bin: string | undefined = process.argv[1], probe: InstallProbe = {}): InstallMethod {
  const kind = installKind(bin, probe);
  return { kind, updateCommand: UPDATE_COMMANDS[kind] };
}

function installKind(bin: string | undefined, probe: InstallProbe): InstallKind {
  if (bin === undefined || bin === "") return "npm";
  let real = bin;
  try {
    real = (probe.realpath ?? realpathSync)(bin);
  } catch {
    // A bin that cannot be resolved is judged by the path it was run by.
  }
  const path = real.replace(/\\/g, "/");
  if (/\.app\/Contents\/Resources\//.test(path)) return "desktop";
  // A runtime in the plane's own runtimes folder updates itself: one `toolroll update` installed
  // (staged-upgrades/release-* or rollback-*), and one a release deployed from a checkout (staged-upgrades/browser-*,
  // scripts/deploy-browser.mjs). Its launchd service and links name that runtime, which is all the updater switches, so
  // a released version reaches it from npm like any other install (never a downgrade without --allow-downgrade).
  if (/\/staged-upgrades\/(release|rollback|browser)-/.test(path)) return "managed";
  if (/\/Cellar\/toolroll\//i.test(path)) return "homebrew";
  if (path.includes("/_npx/")) return "npx";
  if (/\/\.bun\/install\/global\//.test(path)) return "bun";
  if (/\/pnpm\/global\//i.test(path)) return "pnpm";
  if (/\/(?:\.config\/yarn|yarn\/data)\/global\//i.test(path)) return "yarn";
  if (path.includes("/node_modules/")) return "npm";
  // Not inside node_modules: a checkout, when the package's own folder is a git working copy.
  const exists = probe.exists ?? existsSync;
  let folder = dirname(real);
  for (let depth = 0; depth < 4; depth++) {
    if (exists(join(folder, "package.json")) && exists(join(folder, ".git"))) return "source";
    const parent = dirname(folder);
    if (parent === folder) break;
    folder = parent;
  }
  return "npm";
}
