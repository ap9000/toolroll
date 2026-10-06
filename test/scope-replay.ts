/**
 * Saved scopes, standing orders and sealed routes, replayed read-only: every digest re-derived from a row's own
 * stored terms, every stored route read back and re-encoded. test/fixtures/scopes/rows.json holds the rows (from the
 * authentic v47 fixture and from stores this code's releases wrote; synthetic names and paths only), and
 * baseline.json what the hand-written readers before the Zod contracts made of them — recorded before those readers
 * were replaced. scripts/scope-replay.ts runs the same replay over a real database, opened read-only.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalRouteJson, routeDigestOf, routeFromJson } from "../src/phase-routing.js";
import { routineDigestOf } from "../src/routine.js";
import { canonicalAcceptance, chainFromJson, digestOf, parseAcceptanceCriteria, profileFromJson } from "../src/scope.js";
import { scopeTermsProblem } from "../src/store.js";

export type SavedRow = Record<string, string | number | null>;
export type SavedRows = { task_scope: SavedRow[]; routine: SavedRow[] };

/** One stored route: what it reads as, its re-encoded bytes (and whether they are the stored bytes), its digest. */
export type RouteReplay = { read: string | null; canonical: string | null; sameBytes: boolean; digest: string | null };

/** One row: the digests it stores, the digests its terms re-derive to, and how each term reads back. */
export type RowReplay = {
  key: string;
  stored: { digest: string | null; approvedDigest: string | null };
  digest: string | null;
  approvedDigest: string | null;
  acceptance: string;
  canonicalAcceptance: string;
  termsProblem: string | null;
  route: RouteReplay | null;
  approvedRoute: RouteReplay | null;
};

export type Replay = { task_scope: RowReplay[]; routine: RowReplay[] };

const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

function list(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value)) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** The rubric as the store reads it back (store.ts `readAcceptance`). */
function acceptanceOf(value: unknown) {
  if (value === null || value === undefined) return [];
  try {
    return parseAcceptanceCriteria(JSON.parse(String(value))).criteria;
  } catch {
    return [];
  }
}

function routeReplay(json: string | null): RouteReplay | null {
  if (json === null) return null;
  const route = routeFromJson(json);
  const canonical = route === null ? null : canonicalRouteJson(route);
  return { read: route === null ? null : JSON.stringify(route), canonical, sameBytes: canonical === json, digest: route === null ? null : routeDigestOf(route) };
}

/** A scope row, re-derived the way the store binds it: a fields-only digest for a legacy (version 1) or unresolved
 * row, the fallback chain (without the prepared commit) or the profile otherwise, and the route once the row is routed. */
export function replayScopeRow(row: SavedRow): RowReplay {
  const acceptance = acceptanceOf(row["acceptance_json"]);
  const fields = {
    goal: String(row["goal"]),
    outOfScope: text(row["out_of_scope"]),
    touches: list(row["touches"]),
    budgetMicrousd: row["budget_microusd"] === null || row["budget_microusd"] === undefined ? null : Number(row["budget_microusd"]),
    acceptance,
    qualityMode: row["quality_mode"] === "strict" ? ("strict" as const) : ("default" as const),
    candidate: typeof row["candidate"] === "string" && row["candidate"] !== "" ? row["candidate"] : null,
  };
  const routed = row["route_era"] !== null && row["route_era"] !== undefined;
  const derive = (profileJson: string | null, chainJson: string | null, routeJson: string | null): string | null => {
    // A routed row that could compute no route at all keeps its fields-only draft digest.
    const route = routed && routeJson !== null ? routeFromJson(routeJson) : null;
    if (routeJson !== null && routed && route === null) return null;
    if (row["digest_version"] !== 2) return digestOf(fields, null, route);
    if (chainJson !== null) {
      const chain = chainFromJson(chainJson);
      const { candidate: _candidate, ...chainFields } = fields;
      return chain === null ? null : digestOf(chainFields, { chain }, route);
    }
    return digestOf(fields, profileFromJson(profileJson), route);
  };
  const approved = text(row["approved_digest"]) !== null;
  return {
    key: String(row["task_id"]),
    stored: { digest: text(row["digest"]), approvedDigest: text(row["approved_digest"]) },
    digest: derive(row["profile_state"] === "unresolved" ? null : text(row["profile_json"]), text(row["proposed_chain_json"]), text(row["proposed_route_json"])),
    approvedDigest: approved ? derive(text(row["approved_profile_json"]), text(row["approved_chain_json"]), text(row["approved_route_json"])) : null,
    acceptance: JSON.stringify(acceptance),
    canonicalAcceptance: JSON.stringify(canonicalAcceptance(acceptance)),
    termsProblem: scopeTermsProblem(row),
    route: routeReplay(text(row["proposed_route_json"])),
    approvedRoute: routeReplay(text(row["approved_route_json"])),
  };
}

/** A standing order's row, re-derived the way routine.ts binds it. */
export function replayRoutineRow(row: SavedRow): RowReplay {
  const acceptance = acceptanceOf(row["acceptance_json"]);
  const terms = {
    repo: String(row["repo"]),
    goal: String(row["goal"]),
    outOfScope: text(row["out_of_scope"]),
    touches: list(row["touches"]),
    acceptance,
    requirements: list(row["requirements"]),
    schedule: String(row["schedule"]),
    singleFlight: Number(row["single_flight"]) === 1,
    costCeilingUsd: row["cost_ceiling_usd"] === null ? null : Number(row["cost_ceiling_usd"]),
    budgetPerRunMicrousd: row["budget_per_run_microusd"] === null || row["budget_per_run_microusd"] === undefined ? null : Number(row["budget_per_run_microusd"]),
  };
  const derive = (profileJson: string | null, routeJson: string | null, storedDigest: string | null): string | null => {
    const route = routeJson === null ? null : routeFromJson(routeJson);
    if (routeJson !== null && route === null) return null;
    // updateRoutineTerms can restate a v1 routine with a profile without bumping digest_version. Migration also
    // pinned profiles beside unchanged fields-only approvals. For an unrouted v1 side, accept that older encoding
    // only when it re-derives the stored digest; otherwise include the profile, as routine.ts does. Never use this
    // fallback for routed or v2 rows, and never return the stored digest itself: real disagreements stay visible.
    if (row["digest_version"] === 1 && route === null) {
      const legacy = routineDigestOf(terms);
      if (legacy === storedDigest) return legacy;
    }
    return routineDigestOf(terms, profileFromJson(profileJson), route);
  };
  return {
    key: String(row["id"]),
    stored: { digest: text(row["digest"]), approvedDigest: text(row["approved_digest"]) },
    digest: derive(text(row["profile_json"]), text(row["route_json"]), text(row["digest"])),
    approvedDigest: text(row["approved_digest"]) === null ? null : derive(text(row["approved_profile_json"]), text(row["approved_route_json"]) ?? text(row["route_json"]), text(row["approved_digest"])),
    acceptance: JSON.stringify(acceptance),
    canonicalAcceptance: JSON.stringify(canonicalAcceptance(acceptance)),
    termsProblem: null,
    route: routeReplay(text(row["route_json"])),
    approvedRoute: routeReplay(text(row["approved_route_json"])),
  };
}

export function replayRows(rows: SavedRows): Replay {
  return { task_scope: rows.task_scope.map(replayScopeRow), routine: rows.routine.map(replayRoutineRow) };
}

/** Every saved scope and standing order in a database file, read through a read-only connection. */
export function readSavedRows(file: string): SavedRows {
  const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  const db = new sqlite.DatabaseSync(file, { readOnly: true });
  try {
    const all = (table: string, order: string): SavedRow[] => {
      const known = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
      return known ? (db.prepare(`SELECT * FROM "${table}" ORDER BY ${order}`).all() as SavedRow[]).map(row => ({ ...row })) : [];
    };
    return { task_scope: all("task_scope", "task_id"), routine: all("routine", "id") };
  } finally {
    db.close();
  }
}

export const SCOPE_FIXTURES = fileURLToPath(new URL("./fixtures/scopes/", import.meta.url));

/** The recorded rows, and what the readers before the contracts made of them. */
export function scopeFixtures(): { rows: SavedRows; baseline: Replay } {
  const read = (name: string) => JSON.parse(readFileSync(join(SCOPE_FIXTURES, name), "utf8")) as unknown;
  return { rows: read("rows.json") as SavedRows, baseline: read("baseline.json") as Replay };
}
