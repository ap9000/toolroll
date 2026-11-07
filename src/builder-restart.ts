/**
 * Restarting this computer's own builder (docs/plans/plain-toolroll.md P2.3): the record of what a person wants, and the
 * one transaction that admits an automatic restart. The supervisor work is laptop-background.ts restartOwnBuilder.
 *
 * `background on` and `up` record that the builder should run, with the build and database format they ran; `background
 * off` and `stop` record that it should not, before they stop it. Nothing else writes that wish, and only a recorded
 * wish to run is ever acted on.
 */
import { updateAdmissionPaused } from "./desktop-update-gate.js";
import { drainOf } from "./runner.js";
import { readSchemaVersion, type Store } from "./store.js";

/** At most this many automatic restarts in this window (tried, whatever came of them). */
export const RESTART_LIMIT = 3;
export const RESTART_WINDOW_MS = 30 * 60_000;

export type BuilderWish = { desired: "running" | "stopped"; build: string; schema: number; setBy: string; setAt: string };

export function builderWish(store: Store): BuilderWish | null {
  const row = store.handle.prepare("SELECT desired, build, schema_version, set_by, set_at FROM builder_service WHERE id = 1").get();
  return row === undefined ? null : { desired: row["desired"] === "running" ? "running" : "stopped", build: String(row["build"]), schema: Number(row["schema_version"]), setBy: String(row["set_by"]), setAt: String(row["set_at"]) };
}

export function databaseFormat(store: Store): number | null {
  const read = readSchemaVersion(store.handle);
  return read.ok ? read.version : null;
}

/** Record what a person asked for. A `stopped` keeps the last known build. */
export function recordBuilderWish(store: Store, desired: "running" | "stopped", by: string, build: string, now: Date): void {
  store.handle.prepare(`INSERT INTO builder_service (id, desired, build, schema_version, set_by, set_at) VALUES (1, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET desired = excluded.desired, build = excluded.build, schema_version = excluded.schema_version, set_by = excluded.set_by, set_at = excluded.set_at`)
    .run(desired, build, databaseFormat(store) ?? 0, by, now.toISOString());
}

/** An update, a deploy's drain or a stop in progress: this is someone else's restart to make. */
export function restartPaused(store: Store, now: Date): boolean {
  if (updateAdmissionPaused(store.raw())) return true;
  return store.listRunners().some(runner => drainOf(store, runner, now) !== null);
}

export type RestartAdmission = "admitted" | "not-wanted" | "paused" | "attempts";

/** The wish, the pause and the count, read again and the attempt written in one transaction: two callers can't both
 * take the last attempt, and a crash after this still counted. */
export function admitBuilderRestart(store: Store, now: Date): RestartAdmission {
  return store.transact(() => {
    if (builderWish(store)?.desired !== "running") return "not-wanted";
    if (restartPaused(store, now)) return "paused";
    const since = new Date(now.getTime() - RESTART_WINDOW_MS).toISOString();
    const tried = Number(store.handle.prepare("SELECT COUNT(*) AS n FROM builder_restart WHERE at > ?").get(since)?.["n"] ?? 0);
    if (tried >= RESTART_LIMIT) return "attempts";
    store.handle.prepare("INSERT INTO builder_restart (at) VALUES (?)").run(now.toISOString());
    return "admitted";
  });
}
