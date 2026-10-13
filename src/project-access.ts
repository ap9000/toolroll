import { AsyncLocalStorage } from "node:async_hooks";
import { isAbsolute, resolve } from "node:path";
import { canonicalProject } from "./project.js";

/** null explicitly means instance access; [] grants no project access. */
export type ProjectAccess = readonly string[] | null;

export function normalizeProjectAccess(value: unknown): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > 100 || value.some(path =>
    typeof path !== "string" || !isAbsolute(path) || path.length > 4096 || /[\x00-\x1f\x7f]/.test(path))) {
    throw new Error("Project access must name at most 100 absolute project paths.");
  }
  return [...new Set((value as string[]).map(path => canonicalProject(path) ?? resolve(path)))].sort();
}

/** Corrupt or missing authority never falls back to instance access. */
export function readProjectAccess(value: unknown): ProjectAccess {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(String(value));
    if (!Array.isArray(parsed) || parsed.length > 100 || parsed.some(path =>
      typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path || path.length > 4096 || /[\x00-\x1f\x7f]/.test(path))) return [];
    // Preserve the granted identity. Re-canonicalizing stored grants after
    // a symlink changes would transfer access to its new target.
    return parsed as string[];
  } catch { return []; }
}

export function projectAccessAllows(access: ProjectAccess, repo: string | null): boolean {
  return access === null || (repo !== null && access.includes(canonicalProject(repo) ?? resolve(repo)));
}

/** SQL: projectAccessAllows for an `approver` row (`alias`) and a project path expression, for the dispatch belts. A
 * null list reaches every project; an unreadable one reaches none. */
export const accountReachesSql = (alias: string, repo: string) =>
  `(${alias}.projects_json IS NULL OR (json_valid(${alias}.projects_json) AND EXISTS (SELECT 1 FROM json_each(${alias}.projects_json) WHERE json_each.value = ${repo})))`;

/** A server-proved resource, never an unchecked header or submitted path.
 * CLI ceremonies must pass their resource explicitly; global ceremonies
 * without a project refuse project-scoped credentials. */
export const projectAuthority = new AsyncLocalStorage<{ actor: string; repo: string | null }>();
