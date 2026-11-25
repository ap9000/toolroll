/**
 * The product's internal name, and every older one it still answers to.
 *
 * Toolroll was Standing Orders, which was nightorders. A rename must never
 * orphan an installation: new things use the new name, while a folder,
 * variable, branch, launchd job or skill that already exists under an older
 * name keeps being found. Nothing is moved; the old one is used until one
 * exists under the new name. Strings that feed a hash, a digest or a stored
 * format id are not names in this sense and stay byte-identical.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

export const NAME = "toolroll";
/** Older names, newest first. */
export const LEGACY_NAMES = ["standing-orders", "nightorders"] as const;
export const NAMES: readonly string[] = [NAME, ...LEGACY_NAMES];

function hasActiveConsoleMarker(dir: string): boolean {
  return existsSync(join(dir, "up-console.json")) || existsSync(join(dir, ".toolroll-run"));
}

/**
 * A file inside the product's folder under `base` (~/.config, ~/.cache, or a
 * home dotfolder when `dot` is set). The first name that already holds the
 * file wins (preferring a folder with an active console marker when multiple
 * legacy databases coexist); otherwise the file goes into the folder that
 * holds the database, else the first folder that exists, else a new-name
 * folder — so one install keeps one folder, and a fresh one gets ~/.config/toolroll.
 */
export function namedPath(base: string, rest: readonly string[], options: { dot?: boolean; names?: readonly string[] } = {}): string {
  const names = options.names ?? NAMES;
  const folder = (name: string) => join(base, options.dot ? `.${name}` : name);
  const matches = names.filter(name => existsSync(join(folder(name), ...rest)));
  if (matches.length > 0) {
    if (matches.length > 1 && rest.length === 1 && rest[0] === "orders.db") {
      const active = matches.find(name => hasActiveConsoleMarker(folder(name)));
      if (active !== undefined) return join(folder(active), ...rest);
    }
    return join(folder(matches[0]!), ...rest);
  }
  return join(namedFolder(base, options), ...rest);
}

/** The product's folder under `base`: see namedPath. */
export function namedFolder(base: string, options: { dot?: boolean; names?: readonly string[] } = {}): string {
  const names = options.names ?? NAMES;
  const folder = (name: string) => join(base, options.dot ? `.${name}` : name);
  const dbMatches = names.filter(name => existsSync(join(folder(name), "orders.db")));
  const chosen =
    (dbMatches.length > 1 ? dbMatches.find(name => hasActiveConsoleMarker(folder(name))) : undefined) ??
    dbMatches[0] ??
    names.find(name => existsSync(folder(name))) ??
    names[0]!;
  return folder(chosen);
}

/** Every folder under `base` that any name has made, for fencing and cleanup. */
export function existingFolders(base: string, options: { dot?: boolean } = {}): string[] {
  return NAMES.map(name => join(base, options.dot ? `.${name}` : name)).filter(path => existsSync(path));
}

/** ~/.config (or $XDG_CONFIG_HOME). */
export function configBase(env: Record<string, string | undefined>, home: string): string {
  const xdg = env["XDG_CONFIG_HOME"];
  return xdg !== undefined && xdg !== "" ? xdg : join(home, ".config");
}

export const ENV_PREFIX = "TOOLROLL_";
export const LEGACY_ENV_PREFIX = "STANDING_ORDERS_";

/**
 * An environment setting by its suffix ("DB" → TOOLROLL_DB). The new name
 * wins whenever it is set; the old STANDING_ORDERS_ one is the fallback.
 */
export function envValue(env: Record<string, string | undefined>, suffix: string): string | undefined {
  // Empty counts as unset: a blank TOOLROLL_DB must not hide an isolating STANDING_ORDERS_DB.
  const current = env[ENV_PREFIX + suffix];
  return current !== undefined && current !== "" ? current : env[LEGACY_ENV_PREFIX + suffix];
}

/** The Telegram bot token's variable, and the name it had before the rename: agents never see either.
 * Kept here, in a module with no imports of its own, so builder.ts can read it at load time. */
export const TELEGRAM_TOKEN_ENV = `${ENV_PREFIX}TELEGRAM_TOKEN`;
export const TELEGRAM_TOKEN_ENVS: readonly string[] = [TELEGRAM_TOKEN_ENV, `${LEGACY_ENV_PREFIX}TELEGRAM_TOKEN`];

/** Both names of a setting, for a child the plane starts: older tools read the old one. */
export function envTwins(suffix: string, value: string): Record<string, string> {
  return { [ENV_PREFIX + suffix]: value, [LEGACY_ENV_PREFIX + suffix]: value };
}

/** True for a variable of either name ("TOOLROLL_DB", "STANDING_ORDERS_DB"). */
export function isOwnEnv(key: string): boolean {
  return /^(TOOLROLL|STANDING_ORDERS)_/i.test(key);
}

/** New task branches are toolroll/<id>; the plane's older ones stay its own. */
export const BRANCH_PREFIX = `${NAME}/`;
export const BRANCH_PREFIXES: readonly string[] = [BRANCH_PREFIX, "standing-orders/"];

export function taskBranch(id: string): string {
  return `${BRANCH_PREFIX}${id}`;
}

/** A branch the plane made, under either name. */
export function isOwnBranch(branch: string): boolean {
  return BRANCH_PREFIXES.some(prefix => branch.startsWith(prefix));
}

/**
 * Whether a head branch is inside a publication grant's prefix. A grant made
 * for the plane's own branches under one name covers the same branches under
 * the other: a standing-orders/ grant still publishes toolroll/<id> work.
 */
export function headWithin(head: string, prefix: string): boolean {
  if (head.startsWith(prefix)) return true;
  const own = BRANCH_PREFIXES.find(one => prefix.startsWith(one));
  return own !== undefined && BRANCH_PREFIXES.some(one => head.startsWith(one + prefix.slice(own.length)));
}

/** Every name a task's own branch may have, newest first. */
export function taskBranches(id: string): string[] {
  return BRANCH_PREFIXES.map(prefix => `${prefix}${id}`);
}

/** The first candidate branch that already exists (a retry reuses its branch), else the first — the new name. */
export async function existingOrFirst(candidates: readonly string[], exists: (branch: string) => Promise<boolean>): Promise<string> {
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  return candidates[0]!;
}
