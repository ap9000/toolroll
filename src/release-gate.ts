/**
 * `toolroll release --release-gate <id>`: lift one update pause that a browser deployment (scripts/deploy-browser.mjs)
 * left behind when it stopped before the swap and its own exit recovery never ran. The typical case is a deployment
 * killed outright (SIGKILL, a crash or power loss) while paused: nothing lifted the pause, and new work stays paused.
 *
 * The id alone proves nothing, and neither does the journal's phase. The pause is lifted only when every piece of
 * evidence agrees that the service was never swapped:
 *
 *   - the live database's update pause is owned by exactly this id
 *   - exactly one intact deployment journal names this id and this database, at a phase before the swap, with
 *     nothing recorded that only the swap writes (stopping, migration, the new service), and no new service definition
 *     staged
 *   - the live database is still at the schema that journal recorded
 *   - the service definition still names the runtime the journal started from (and is the one it saved), never the
 *     staged one
 *   - that runtime's service is running, nothing runs from the staged runtime, and no deployment is still running
 *
 * Anything missing, damaged or contradicting refuses and leaves the pause as it is. Without --yes it only shows the
 * proof; with --yes it lifts that one pause (the owner is checked again inside the same write) and journals it.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { durableJson } from "./desktop-update.js";
import { removeUpdateGate, updateGateOwned } from "./desktop-update-gate.js";
import type { Database } from "./store.js";

/** The journal phases a deployment passes before it stops the old service (deploy-phases.mjs). */
export const BEFORE_SWAP = Object.freeze(["preparing", "admission-paused", "frozen", "backup-verified", "rehearsed"]);
/** Journal fields that only the swap and later phases write. */
const SWAP_FIELDS = ["stoppingService", "codingBackupBeforeSwap", "migration", "newService", "deployedAt"] as const;
const GATE_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export type GateReleaseWorld = {
  /** The live database file. */
  database: string;
  /** The installation's state folder: deployments stage under staged-upgrades/ there. */
  stateDir: string;
  /** The live database, opened without migrating it. */
  open(): Database;
  /** The installed browser service definitions (LaunchAgents), path and text. */
  servicePlists(): { path: string; text: string }[];
  /** Every process on this machine: pid and full command line. */
  processes(): { pid: number; command: string }[];
  now(): Date;
};

type Journal = Record<string, unknown> & { id: string; phase: string; database: string; schema: number; priorRuntime: string; nextRuntime: string };
export type GateProof = { ok: true; id: string; stage: string; journal: Journal; proof: string[] } | { ok: false; reason: string; message: string };

const refuse = (reason: string, message: string): GateProof => ({ ok: false, reason, message: `${message} The update pause was left as it is.` });

/** The owner id written into the live pause's triggers, when there is one pause and it names one id. */
export function gateOwner(db: Database): string | null {
  const rows = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name GLOB 'so_desktop_update_*'").all();
  const ids = new Set(rows.map(row => /\[([a-f0-9-]{36})\]'\)/.exec(String(row["sql"]))?.[1] ?? "?"));
  return ids.size === 1 ? [...ids][0]! : null;
}

/** Every deployment journal under staged-upgrades/: the stage it is in and what it holds, or why it can't be read. */
function journals(stateDir: string): { stage: string; journal: Record<string, unknown> | null }[] {
  const root = join(stateDir, "staged-upgrades");
  let stages: string[] = [];
  try { stages = readdirSync(root, { withFileTypes: true }).filter(one => one.isDirectory()).map(one => join(root, one.name)); } catch { return []; }
  return stages.filter(stage => existsSync(join(stage, "deployment.json"))).map(stage => {
    try {
      const parsed = JSON.parse(readFileSync(join(stage, "deployment.json"), "utf8")) as unknown;
      return { stage, journal: parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null };
    } catch { return { stage, journal: null }; }
  });
}

/** Whether the pause owned by `id` was left by a deployment that never began its swap, and the evidence that says so. */
export function proveBeforeSwap(id: string, world: GateReleaseWorld): GateProof {
  if (!GATE_ID.test(id)) return refuse("usage", `${id} is not an update id.`);
  const proof: string[] = [];

  let owner: string | null, owned: boolean, schema: number;
  const db = world.open();
  try {
    owner = gateOwner(db);
    owned = updateGateOwned(db, id);
    schema = Number(db.prepare("SELECT version FROM schema_version").get()?.["version"]);
  } finally { db.close(); }
  if (owner === null) return refuse("not-paused", "No single update pause is held on the live database.");
  if (owner !== id || !owned) return refuse("not-owner", `The live update pause belongs to ${owner}, not ${id}.`);
  proof.push(`The live database's update pause belongs to ${id}.`);

  const all = journals(world.stateDir);
  const mine = all.filter(one => one.journal?.["id"] === id);
  if (mine.length > 1) return refuse("conflict", `${mine.length} deployment journals name ${id}: ${mine.map(one => one.stage).join(", ")}.`);
  if (mine.length === 0) {
    const damaged = all.filter(one => one.journal === null);
    return refuse(damaged.length > 0 ? "damaged" : "no-journal", damaged.length > 0
      ? `No readable deployment journal names ${id}, and ${damaged.map(one => join(one.stage, "deployment.json")).join(", ")} can't be read; it may be that deployment's.`
      : `No deployment journal under ${join(world.stateDir, "staged-upgrades")} names ${id}; this pause was not left by a browser deployment.`);
  }
  const { stage, journal: raw } = mine[0]!;
  const r = raw as Journal;
  if (typeof r.phase !== "string" || typeof r.priorRuntime !== "string" || typeof r.nextRuntime !== "string" || typeof r.schema !== "number" || typeof r.database !== "string") {
    return refuse("damaged", `${join(stage, "deployment.json")} is missing its phase, runtimes, schema or database.`);
  }
  if (r.database !== world.database) return refuse("conflict", `That deployment ran on ${r.database}, not ${world.database}.`);
  if (!BEFORE_SWAP.includes(r.phase)) return refuse("after-swap", `That deployment is at ${r.phase}, past the point where it stops the service. Recover it with \`node scripts/deploy-browser.mjs --stage ${stage} --phase recover\` from its checkout.`);
  const swapped = SWAP_FIELDS.filter(field => r[field] !== undefined && r[field] !== null);
  if (swapped.length > 0) return refuse("conflict", `The journal says ${r.phase} but records ${swapped.join(", ")}, which only the swap writes.`);
  if (existsSync(join(stage, "browser.next.plist"))) return refuse("conflict", `The journal says ${r.phase} but a new service definition was staged (${join(stage, "browser.next.plist")}).`);
  proof.push(`Deployment journal ${join(stage, "deployment.json")} stopped at ${r.phase}, before the swap, and records nothing the swap writes.`);

  if (!Number.isInteger(schema) || schema !== r.schema) return refuse("conflict", `The live database is at schema ${schema}; the deployment started at ${r.schema}.`);
  proof.push(`The live database is still at schema ${schema}.`);

  const plists = world.servicePlists();
  if (plists.length !== 1) return refuse("conflict", plists.length === 0 ? "No browser service definition is installed." : `More than one browser service definition is installed: ${plists.map(one => one.path).join(", ")}.`);
  const plist = plists[0]!;
  if (!plist.text.includes(`<string>${r.priorRuntime}/cli.js</string>`) || plist.text.includes(r.nextRuntime)) return refuse("conflict", `${plist.path} does not name the runtime the deployment started from (${r.priorRuntime}).`);
  const saved = join(stage, "browser.saved.plist");
  if (existsSync(saved) && readFileSync(saved, "utf8") !== plist.text) return refuse("conflict", `${plist.path} differs from the definition the deployment saved (${saved}).`);
  proof.push(`${plist.path} still names ${r.priorRuntime}${existsSync(saved) ? " and matches the saved copy" : ""}.`);

  const processes = world.processes();
  const deploying = processes.filter(one => one.command.includes("deploy-browser.mjs"));
  if (deploying.length > 0) return refuse("deploying", `A deployment is still running (process ${deploying.map(one => one.pid).join(", ")}); let it finish or recover.`);
  const staged = processes.filter(one => one.command.includes(r.nextRuntime));
  if (staged.length > 0) return refuse("after-swap", `Process ${staged.map(one => one.pid).join(", ")} runs from the staged runtime ${r.nextRuntime}.`);
  const supervisor = processes.find(one => one.command.includes(`${r.priorRuntime}/controller-service.js`));
  const worker = processes.find(one => one.command.includes(`${r.priorRuntime}/cli.js up --db ${world.database}`));
  if (supervisor === undefined || worker === undefined) return refuse("conflict", `The service is not running from ${r.priorRuntime}, so it can't be shown that the swap never began.`);
  proof.push(`The service runs from ${r.priorRuntime} (process ${supervisor.pid}); nothing runs from the staged runtime, and no deployment is running.`);
  return { ok: true, id, stage, journal: r, proof };
}

export type GateReleaseOutcome = { ok: true; released: boolean; id: string; stage: string; proof: string[] } | { ok: false; reason: string; message: string };

/** Prove, then (with `yes`) lift exactly that pause and journal the release in the deployment's own journal. */
export function releaseGate(id: string, world: GateReleaseWorld, yes: boolean): GateReleaseOutcome {
  const proved = proveBeforeSwap(id, world);
  if (!proved.ok) return proved;
  if (!yes) return { ok: true, released: false, id, stage: proved.stage, proof: proved.proof };
  const db = world.open();
  // removeUpdateGate checks the owner again inside its own write: a pause that changed hands is not touched.
  try { removeUpdateGate(db, id); } finally { db.close(); }
  durableJson(join(proved.stage, "deployment.json"), {
    ...proved.journal, phase: "released", updatedAt: world.now().toISOString(),
    releasedBeforeSwap: { at: world.now().toISOString(), by: "toolroll release --release-gate", from: proved.journal.phase, proof: proved.proof },
  });
  return { ok: true, released: true, id, stage: proved.stage, proof: proved.proof };
}
