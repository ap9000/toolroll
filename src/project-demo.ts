/**
 * A project's own demo or dev server (review 827): the one address a scout
 * may reach that is not on the public internet, so it can take screenshots
 * of the project's UI. An approver sets it with
 * `toolroll project demo --repo <p> <url>|off`; it is kept in a small file
 * beside the database, like a project's builds-at-once number, and recorded
 * in the ledger as before → after. A project without one has none.
 */
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

export const projectDemoPath = (databaseFile: string): string => join(dirname(databaseFile), "project-demo.json");

/** A demo URL as typed: an http(s) address with no sign-in details, at most 500 characters, or null. */
export function parseDemoUrl(value: string): string | null {
  const typed = value.trim();
  if (typed === "" || typed.length > 500) return null;
  try {
    const url = new URL(typed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username !== "" || url.password !== "") return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Every saved demo URL, by canonical project path. An unreadable file reads as none saved. */
export function savedProjectDemos(databaseFile: string): Map<string, string> {
  const saved = new Map<string, string>();
  const file = projectDemoPath(databaseFile);
  try {
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (stat === undefined || !stat.isFile() || stat.size > 262_144) return saved;
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    const projects = value !== null && typeof value === "object" ? (value as { projects?: unknown }).projects : undefined;
    if (projects === null || typeof projects !== "object") return saved;
    for (const [repo, url] of Object.entries(projects as Record<string, unknown>)) {
      const parsed = typeof url === "string" ? parseDemoUrl(url) : null;
      if (parsed !== null) saved.set(repo, parsed);
    }
  } catch {
    // A damaged file never stops a scout: it simply has no demo to open.
  }
  return saved;
}

/** The project's demo URL, or null when it has none. */
export function projectDemoUrl(databaseFile: string, repo: string): string | null {
  return savedProjectDemos(databaseFile).get(repo) ?? null;
}

/** Save (or, with null, clear) one project's demo URL atomically; returns it before and after. */
export function saveProjectDemo(databaseFile: string, repo: string, url: string | null): { before: string | null; after: string | null } {
  const saved = savedProjectDemos(databaseFile);
  const before = saved.get(repo) ?? null;
  if (url === null) saved.delete(repo);
  else saved.set(repo, url);
  const file = projectDemoPath(databaseFile);
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(temp, `${JSON.stringify({ version: 1, projects: Object.fromEntries([...saved].sort(([a], [b]) => a.localeCompare(b))) }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temp, file);
  return { before, after: url };
}
