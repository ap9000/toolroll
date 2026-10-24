/**
 * A project's sandbox settings (docs/plans/sandbox-parity.md C9), an approver's, each sealed into new scopes:
 *
 * - `readDeny`: what its builds and checks may not read (Anthropic's sandbox runtime `denyRead`). Under fence policy v2
 *   the home folder is readable as in the sandbox runtime; this is how a project hides `~/.ssh` and the like again.
 *   Narrowing only: it applies to running launches' next start too (flows, coding sessions read it live).
 * - `machLookup`: macOS services its builds may also reach (the sandbox runtime `allowMachLookup`), for toolchains the
 *   deny-default baseline breaks (Go's TLS, Playwright). Widening: sealed, and only a person's password yes seals it.
 * - `writeUnlock`: exact protected files (agent-fence.ts PROTECTED_FILES / PROTECTED_DIRS) its builds may still write,
 *   relative to the checkout. Widening, likewise.
 */
import { isAbsolute, normalize } from "node:path";
import { validUnlock } from "./agent-fence.js";

export type ProjectSandbox = { readDeny: string[]; machLookup: string[]; writeUnlock: string[] };
export const PROJECT_SANDBOX_DEFAULT: ProjectSandbox = { readDeny: [], machLookup: [], writeUnlock: [] };
export const MAX_READ_DENY = 100;
export const MAX_MACH_LOOKUP = 30;

/** A read-deny entry: `~/…` (the home folder of whoever runs the build) or an absolute path; normalized, no `..`, no
 * pattern; `~` or `/` alone never (that would deny everything a build needs). */
export function validReadDeny(one: string): boolean {
  if (one.length === 0 || one.length > 400 || one.includes("\0") || /[*?[\]{}]/.test(one)) return false;
  const path = one.startsWith("~/") ? one.slice(2) : isAbsolute(one) ? one.slice(1) : null;
  if (path === null || path === "" || path.endsWith("/")) return false;
  return path.split("/").every(part => part !== "" && part !== "." && part !== "..") && normalize(`/${path}`) === `/${path}`;
}

/** Services no project can add, whatever it asks: the keychain and security services, the pasteboard, Launch Services
 * and Apple Events (what a build would open or script another application with), the privacy database, the window
 * server. Each name or prefix here matches the service and everything beneath it. */
export const MACH_NEVER: readonly string[] = ["com.apple.security", "com.apple.SecurityServer", "com.apple.securityd", "com.apple.pasteboard",
  "com.apple.coreservices.launchservicesd", "com.apple.lsd", "com.apple.coreservices.appleevents", "com.apple.tccd", "com.apple.windowserver",
  "com.apple.CoreServices.coreservicesd"];

/** A mach service a project may add: an exact reverse-DNS name, or a prefix ending `.*` after at least three labels
 * (`com.example.tool.*`); never one of MACH_NEVER, nor a prefix that would reach one. */
export function validMachLookup(one: string): boolean {
  if (one.length > 200) return false;
  const prefix = one.endsWith(".*");
  const name = prefix ? one.slice(0, -2) : one;
  const labels = name.split(".");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*(\.[A-Za-z0-9_@-]+)+$/.test(name) || labels.length < (prefix ? 3 : 2)) return false;
  const lower = name.toLowerCase();
  return !MACH_NEVER.some(never => { const blocked = never.toLowerCase(); return lower === blocked || lower.startsWith(blocked) || (prefix && blocked.startsWith(`${lower}.`)); });
}

/** Entries as a setting keeps them: trimmed, distinct, sorted; refused whole when any is invalid or there are too many. */
export function parseSandboxList(lines: readonly string[], valid: (one: string) => boolean, max: number): { ok: true; list: string[] } | { ok: false; problem: string } {
  const list = [...new Set(lines.map(one => one.trim()).filter(one => one !== ""))].sort();
  const bad = list.find(one => !valid(one));
  if (bad !== undefined) return { ok: false, problem: `“${bad.slice(0, 80)}” isn't a valid entry` };
  if (list.length > max) return { ok: false, problem: `at most ${max} entries` };
  return { ok: true, list };
}

export const parseReadDeny = (lines: readonly string[]) => parseSandboxList(lines, validReadDeny, MAX_READ_DENY);
export const parseMachLookup = (lines: readonly string[]) => parseSandboxList(lines, validMachLookup, MAX_MACH_LOOKUP);
export const parseWriteUnlock = (lines: readonly string[]) => parseSandboxList(lines, validUnlock, 50);

/** A stored or sealed setting, read strictly: anything unreadable reads as the narrowest (no unlock, no extra services)
 * but keeps whatever read-denies are valid (never fewer than were asked for). */
export function sandboxOf(raw: { readDeny?: unknown; machLookup?: unknown; writeUnlock?: unknown }): ProjectSandbox {
  const strings = (value: unknown) => Array.isArray(value) ? value.filter((one): one is string => typeof one === "string") : [];
  const readDeny = parseReadDeny(strings(raw.readDeny));
  const mach = parseMachLookup(strings(raw.machLookup));
  const unlock = parseWriteUnlock(strings(raw.writeUnlock));
  return {
    readDeny: readDeny.ok ? readDeny.list : strings(raw.readDeny).filter(validReadDeny),
    machLookup: mach.ok ? mach.list : [],
    writeUnlock: unlock.ok ? unlock.list : [],
  };
}

/** A read-deny entry as the path it names for a launch whose home folder is `home`. */
export const readDenyPath = (one: string, home: string): string => one.startsWith("~/") ? `${home}/${one.slice(2)}` : one;

/** What an approval's sandbox terms say, one line each, for every surface that asks for a yes (scope.ts describeScope,
 * the console's scope view): the fence policy and its read denies always, the macOS services and unlocked protected
 * files when there are any. */
export function sandboxTermsWords(profile: { fencePolicy?: 2; readDeny?: readonly string[]; machLookup?: readonly string[]; writeUnlock?: readonly string[] }): { reads: string; mach: string | null; unlock: string | null } {
  const reads = profile.fencePolicy === 2
    ? `your home folder, as in Anthropic's sandbox runtime${(profile.readDeny ?? []).length === 0 ? "" : `, except ${(profile.readDeny ?? []).join(", ")}`}; never Toolroll's own folders or other tasks' work`
    : "not your home folder's credentials and agent settings (approved before home reads opened)";
  return {
    reads,
    mach: (profile.machLookup ?? []).length === 0 ? null : `also reaches these macOS services: ${(profile.machLookup ?? []).join(", ")}`,
    unlock: (profile.writeUnlock ?? []).length === 0 ? null : `protected files it may still write: ${(profile.writeUnlock ?? []).join(", ")}`,
  };
}

/** The setting in a sentence, for the CLI and the settings page. */
export function readDenyWords(list: readonly string[]): string {
  return list.length === 0 ? "Builds and checks can read your home folder, as in Anthropic's sandbox runtime; Toolroll's own folders and other tasks' work stay out of reach."
    : `Builds and checks can read your home folder except ${list.length === 1 ? list[0] : `${list.length} paths (${list.slice(0, 3).join(", ")}${list.length > 3 ? ", …" : ""})`}.`;
}
