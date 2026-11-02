/** Records shaped as Toolroll writes them, for tidy's tests (docs/plans/task-tidy.md): flows with a schedule or a
 * GitHub checks trigger, their firings, the cards they made and the tasks the flow engine filed. Isolated stores only. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "../src/store.js";

export const REPO = "/repo/shop";

/** A flow and its one trigger. */
export function seedFlow(store: Store, name: string, config: Record<string, unknown>, at: Date, repo = REPO): { flow: number; trigger: number } {
  const stamp = at.toISOString();
  const flow = Number(store.handle.prepare(`INSERT INTO flow (repo, name, definition_json, state, created_by, created_at, updated_by, updated_at)
    VALUES (?, ?, '{}', 'active', 'alex', ?, 'alex', ?)`).run(repo, name, stamp, stamp).lastInsertRowid);
  const kind = config["kind"] === "plane-review" ? "schedule" : String(config["kind"]);
  const trigger = Number(store.handle.prepare(`INSERT INTO flow_trigger (flow, kind, config_json, state, created_by, created_at, updated_at)
    VALUES (?, ?, ?, 'active', 'alex', ?, ?)`).run(flow, kind, JSON.stringify(config), stamp, stamp).lastInsertRowid);
  return { flow, trigger };
}

export type Firing = { key: string; task: string; title?: string; at: Date; onTime?: boolean; cardKind?: "person" | "automation" | null; filedBy?: { name: string; kind: "person" | "automation" };
  filedVia?: string | null; state?: "accepted" | "skipped"; eventTask?: boolean; repo?: string };

/** One firing of a trigger: the task the engine filed, its card and the event, as flow-triggers.ts and flow-engine.ts write them. */
export function fire(store: Store, at: { flow: number; trigger: number }, firing: Firing): void {
  const stamp = firing.at.toISOString();
  const cardKind = firing.cardKind === undefined ? "automation" : firing.cardKind;
  const createdBy = cardKind === "person" ? "alex" : "Schedule";
  store.createTask({ id: firing.task, title: firing.title ?? firing.task, filedBy: firing.filedBy ?? { name: createdBy, kind: cardKind === "person" ? "person" : "automation" } }, firing.at);
  const ref = store.refFor("built-in", firing.task, "ours").id;
  store.placeTask(ref, firing.repo ?? REPO);
  if (firing.filedVia !== null) store.stampFiledVia(ref, firing.filedVia ?? `flow:${at.flow}`);
  const card = Number(store.handle.prepare(`INSERT INTO flow_card (flow, title, stage, state, task, primary_task, created_by, created_at, updated_at, created_kind)
    VALUES (?, ?, 'work', 'active', ?, ?, ?, ?, ?, ?)`).run(at.flow, firing.title ?? firing.task, firing.task, firing.task, createdBy, stamp, stamp, cardKind).lastInsertRowid);
  store.handle.prepare(`INSERT INTO flow_trigger_event (trigger, key, card, at, task, on_time, state, accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(at.trigger, firing.key, card, stamp, firing.eventTask === true ? firing.task : null, firing.onTime === false ? 0 : 1, firing.state ?? "accepted", stamp);
}

/** A task a person filed by hand, placed in the project. */
export function personTask(store: Store, id: string, at: Date, repo = REPO): number {
  store.createTask({ id, title: id, filedBy: { name: "alex", kind: "person" } }, at);
  const ref = store.refFor("built-in", id, "ours").id;
  store.placeTask(ref, repo);
  store.stampFiledVia(ref, "console");
  return ref;
}

/** A release journal file, as release.ts writes it. */
export function writeJournal(stateDir: string, name: string, journal: { version: string; task: string; sha: string; step: string; published?: boolean; stopped?: boolean; github?: string }): void {
  mkdirSync(join(stateDir, "releases"), { recursive: true });
  writeFileSync(join(stateDir, "releases", name), JSON.stringify({
    version: 1, id: name, github: journal.github ?? "acme/shop", checkout: "/repo/shop", branch: `release-${journal.version}`, candidate: { sha: journal.sha, tree: "t".repeat(40) },
    packageName: "shop", packageVersion: journal.version, tag: `v${journal.version}`, pr: 1, step: journal.step, task: { id: journal.task, scopeDigest: null },
    published: journal.published === true ? { at: "2026-10-01T00:00:00.000Z" } : null, stopped: journal.stopped === true ? { step: journal.step, reason: "x", message: "x", at: "2026-10-01T00:00:00.000Z" } : null,
    intents: {}, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
  }));
}

/** The gate task id release.ts files for a version and commit. */
export const releaseTaskId = (version: string, sha: string, suffix?: number) => `release-${version}-${sha.slice(0, 7)}${suffix === undefined ? "" : `-${suffix}`}`;
