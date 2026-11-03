/**
 * Knowing, calmly, when a newer Toolroll exists.
 *
 * At most once a day one anonymous GET asks the npm registry for the latest
 * version, and one more reads that version's GitHub release notes (the body
 * only). Nothing identifies this installation: no telemetry, no id, no
 * query string. The answer is cached in a small JSON file beside the
 * database; offline or any other failure is silent and changes nothing.
 * TOOLROLL_NO_UPDATE_CHECK=1 or the switch on Settings → Updates turns the
 * check off entirely.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { envValue } from "./names.js";
import type { Store } from "./store.js";

export const RELEASE_CACHE_FILE = "latest-release.json";
/** Holds "off" while a person has switched the daily check off on Settings → Updates. */
export const UPDATE_SWITCH_FILE = "update-check";
export const RUNNER_VERSIONS_FILE = "runner-versions.json";
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
export const CHECK_TIMEOUT_MS = 5_000;
/** The npm registry `toolroll update` downloads releases from. */
export const REGISTRY = "https://registry.npmjs.org";
export const REGISTRY_URL = `${REGISTRY}/toolroll/latest`;
export const RELEASES_PAGE = "https://github.com/ap9000/toolroll/releases/tag/";
const NOTES_API = "https://api.github.com/repos/ap9000/toolroll/releases/tags/";
const NOTES_MAX = 20_000;
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?$/;

export type Release = { version: string; notes: string; url: string; security: boolean };
type Cache = { checkedAt: string; release: Release | null };
export type ReleaseIo = { fetch?: typeof fetch; now?: () => Date; env?: Record<string, string | undefined> };

/** Off by the environment (it wins) or by the Settings switch. */
export function updateChecksOff(env: Record<string, string | undefined>, dir: string): { off: boolean; byEnv: boolean } {
  const flag = envValue(env, "NO_UPDATE_CHECK");
  if (flag !== undefined && flag !== "" && flag !== "0") return { off: true, byEnv: true };
  try {
    return { off: readFileSync(join(dir, UPDATE_SWITCH_FILE), "utf8").trim() === "off", byEnv: false };
  } catch {
    return { off: false, byEnv: false };
  }
}

export function setUpdateChecks(dir: string, on: boolean): void {
  writeAtomic(join(dir, UPDATE_SWITCH_FILE), on ? "on\n" : "off\n");
}

/** What the last check found, whenever it ran; null when none has succeeded. Never touches the network. */
export function cachedRelease(dir: string): Release | null {
  return readCache(dir)?.release ?? null;
}

/**
 * The latest published release, checked at most once a day. Returns what the
 * cache knows while it is fresh, asks again once it is a day old, and on any
 * failure keeps what it knew before (null when it knew nothing). Never throws.
 */
export async function latestRelease(dir: string, io: ReleaseIo = {}): Promise<Release | null> {
  const env = io.env ?? process.env;
  if (updateChecksOff(env, dir).off) return null;
  const now = (io.now ?? (() => new Date()))();
  const cache = readCache(dir);
  if (cache !== null && now.getTime() - Date.parse(cache.checkedAt) < CHECK_EVERY_MS && Date.parse(cache.checkedAt) <= now.getTime()) return cache.release;
  const request = io.fetch ?? fetch;
  let release: Release | null = cache?.release ?? null;
  try {
    const version = await askVersion(request);
    if (version !== null) {
      const notes = version === cache?.release?.version && cache.release.notes !== "" ? cache.release.notes : await askNotes(request, version);
      release = { version, notes, url: `${RELEASES_PAGE}v${version}`, security: isSecurityRelease(notes) };
    }
  } catch {
    // Offline, slow or refused: nothing to say.
  }
  // The attempt is stamped either way, so a failure does not ask again until tomorrow.
  try {
    writeAtomic(join(dir, RELEASE_CACHE_FILE), `${JSON.stringify({ checkedAt: now.toISOString(), release } satisfies Cache)}\n`);
  } catch {
    // A read-only folder only means asking again next time.
  }
  return release;
}

/** Notes that mention "Security" mark a security release. */
/** A release marks itself as a security release with a line or heading that starts with "Security" (for example
 * "## Security" or "- **Security fix.**"), not by mentioning the word ("no security changes"). */
export function isSecurityRelease(notes: string): boolean {
  return /^\s*(?:#{1,6}\s*|[-*]\s*(?:\*\*)?)?security\b/im.test(notes);
}

/** a > b for dotted versions; a pre-release sorts before its release. */
export function isNewer(a: string, b: string): boolean {
  const parse = (value: string) => {
    const [core = "", pre] = value.replace(/^v/, "").split("-", 2);
    return { parts: core.split(".").map(part => Number.parseInt(part, 10) || 0), pre: pre ?? null };
  };
  const left = parse(a), right = parse(b);
  for (let index = 0; index < 3; index++) {
    const diff = (left.parts[index] ?? 0) - (right.parts[index] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  if (left.pre === right.pre) return false;
  if (left.pre === null) return true;
  if (right.pre === null) return false;
  return left.pre.localeCompare(right.pre, "en", { numeric: true }) > 0;
}

/** The release worth mentioning: newer than `current`, else null. */
export function newerRelease(release: Release | null, current: string): Release | null {
  return release !== null && isNewer(release.version, current) ? release : null;
}

/** The one status line, only when a newer release exists. */
export function updateLine(release: Release | null, current: string, updateCommand: string): string | null {
  const newer = newerRelease(release, current);
  return newer === null ? null : `${newer.version} is available — ${updateCommand} · ${newer.url}`;
}

/**
 * A security release tells each instance operator once per version, through
 * the outbox and addressed to them (like a sign-in pause): only someone at
 * this computer can update it. Returns how many messages were queued.
 */
export function notifySecurityRelease(store: Store, release: Release | null, current: string, updateCommand: string, now: Date): number {
  const newer = newerRelease(release, current);
  if (newer === null || !newer.security) return 0;
  const operators = store.accountFacts().map(one => one.name).filter(name => store.isInstanceOperator(name));
  let queued = 0;
  for (const recipient of operators) {
    const added = store.enqueueNotification({
      dedupeKey: `release:security:${newer.version}:${recipient}`,
      kind: "security-release",
      pushClass: "attention",
      link: "/settings/system#updates",
      subject: `Toolroll ${newer.version} is a security release`,
      body: `This computer runs ${current}. Update with \`${updateCommand}\`. Notes: ${newer.url}`,
      recipient,
      source: { installation: true },
    }, now);
    if (added) queued++;
  }
  return queued;
}

/** Each runner's Toolroll version, as it last said at start. */
export type RunnerVersion = { runner: string; version: string; at: string };

export function recordRunnerVersion(dir: string, runner: string, version: string, now: Date): void {
  const known = runnerVersions(dir).filter(one => one.runner !== runner);
  known.push({ runner, version, at: now.toISOString() });
  try {
    writeAtomic(join(dir, RUNNER_VERSIONS_FILE), `${JSON.stringify(known.sort((a, b) => a.runner.localeCompare(b.runner)))}\n`);
  } catch {
    // The version is a display fact; a failed write only leaves it unknown.
  }
}

export function runnerVersions(dir: string): RunnerVersion[] {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, RUNNER_VERSIONS_FILE), "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((one): one is RunnerVersion => typeof one === "object" && one !== null
      && typeof one.runner === "string" && typeof one.version === "string" && VERSION.test(one.version) && typeof one.at === "string");
  } catch {
    return [];
  }
}

/**
 * The console's background check: at start and then hourly (the daily limit
 * is latestRelease's own), and a security release notifies operators.
 */
export function startUpdateChecks(store: Store, dir: string, current: string, updateCommand: string, io: ReleaseIo & { everyMs?: number } = {}): () => void {
  let stopped = false;
  const pass = async () => {
    const release = await latestRelease(dir, io);
    if (!stopped) {
      try {
        notifySecurityRelease(store, release, current, updateCommand, (io.now ?? (() => new Date()))());
      } catch {
        // A closed store at shutdown: nothing to tell.
      }
    }
  };
  void pass();
  const timer = setInterval(() => void pass(), io.everyMs ?? 60 * 60_000);
  timer.unref?.();
  return () => { stopped = true; clearInterval(timer); };
}

async function askVersion(request: typeof fetch): Promise<string | null> {
  const answer = await request(REGISTRY_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS), credentials: "omit", referrerPolicy: "no-referrer" });
  if (!answer.ok) return null;
  const version = ((await answer.json()) as { version?: unknown }).version;
  return typeof version === "string" && VERSION.test(version) ? version : null;
}

async function askNotes(request: typeof fetch, version: string): Promise<string> {
  try {
    const answer = await request(`${NOTES_API}v${version}`, { headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS), credentials: "omit", referrerPolicy: "no-referrer" });
    if (!answer.ok) return "";
    const body = ((await answer.json()) as { body?: unknown }).body;
    return typeof body === "string" ? body.replace(/\r\n/g, "\n").slice(0, NOTES_MAX) : "";
  } catch {
    return "";
  }
}

function readCache(dir: string): Cache | null {
  const file = join(dir, RELEASE_CACHE_FILE);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Cache>;
    if (typeof parsed.checkedAt !== "string" || Number.isNaN(Date.parse(parsed.checkedAt))) return null;
    const release = parsed.release;
    const valid = release !== null && typeof release === "object" && release !== undefined
      && typeof release.version === "string" && VERSION.test(release.version) && typeof release.notes === "string";
    return { checkedAt: parsed.checkedAt, release: valid ? { version: release.version, notes: release.notes, url: `${RELEASES_PAGE}v${release.version}`, security: isSecurityRelease(release.notes) } : null };
  } catch {
    return null;
  }
}

function writeAtomic(file: string, content: string): void {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, file);
}

/** The latest version, asked of npm now: for an explicit update (the command, Check now), not the once-a-day
 * notice, so neither its cache nor its switch applies. Throws with npm's own reason. */
export async function latestVersionNow(io: { fetch?: typeof fetch } = {}): Promise<{ version: string }> {
  const answer = await (io.fetch ?? fetch)(REGISTRY_URL, { signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
  if (!answer.ok) throw new Error(`npm answered ${answer.status}`);
  const version = (await answer.json() as { version?: unknown }).version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error("npm did not name a version");
  return { version };
}

/** What a release says about itself in one line ("Release 0.9.9: lighter tests, cleaner status"), when its notes
 * have such a line; null otherwise. */
export function releaseSummary(notes: string, version: string): string | null {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const line = new RegExp(`^\\s*(?:#{1,6}\\s*)?(?:Toolroll\\s+)?(?:Release\\s+)?v?${escaped}\\s*[:—–-]\\s*(.+?)\\s*$`, "im").exec(notes);
  const summary = line?.[1]?.replace(/[*_`]/g, "").replace(/\s+/g, " ").replace(/[.\s]+$/, "").trim() ?? "";
  if (summary === "") return null;
  return summary.length <= 80 ? summary : `${summary.slice(0, 79).replace(/[\s,;:]+\S*$/, "")}…`;
}

/**
 * A deploy says one thing in chat: "Toolroll 0.9.9 is live." (with the release's own one-line summary when its
 * notes have one). Once per version, addressed to each instance operator, and only when a worker on this
 * computer last ran an older version: a fresh install is not news. Call before recording this runner's version.
 */
export function notifyVersionLive(store: Store, dir: string, version: string, now: Date): number {
  const before = runnerVersions(dir);
  if (!VERSION.test(version) || !before.some(one => isNewer(version, one.version)) || before.some(one => isNewer(one.version, version))) return 0;
  const cached = cachedRelease(dir);
  const summary = cached?.version === version ? releaseSummary(cached.notes, version) : null;
  const line = summary === null ? `Toolroll ${version} is live.` : `Toolroll ${version} is live: ${summary}.`;
  let queued = 0;
  for (const recipient of store.accountFacts().map(one => one.name).filter(name => store.isInstanceOperator(name))) {
    if (store.enqueueNotification({ dedupeKey: `release:live:${version}:${recipient}`, kind: "version-live", subject: line, body: "",
      recipient, source: { installation: true } }, now)) queued++;
  }
  return queued;
}
