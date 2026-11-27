/**
 * Whether this console offers phone access, and the running service when it does.
 *
 * Off by default. An approver turns it on in Settings → Phone (a password step-up); the choice is kept in the
 * workspace's database so it survives a restart, and a restore leaves it as the backup had it (the paired phones
 * themselves are wiped on restore: restore-retirement.ts). The relay is this computer's built-in one unless the
 * environment names another (`TOOLROLL_RELAY_URL`, a `wss://` address) — an operator's deployment choice, not a
 * setting a browser can change.
 */

import { hostname } from "node:os";
import type { Store } from "../store.js";
import type { CompanionReadHandlers } from "./daemon.js";
import { CompanionService, relayAddressesOf, type CompanionRelayChoice } from "./service.js";

/** The built-in relay's loopback port unless the environment says otherwise (`TOOLROLL_PHONE_RELAY_PORT`). */
export const DEFAULT_BUILT_IN_RELAY_PORT = 4190;

type Db = Store["handle"];

function ensureAccessTable(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS companion_access (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    changed_by TEXT NOT NULL,
    changed_at TEXT NOT NULL
  )`);
}

export function phoneAccessEnabled(db: Db): boolean {
  ensureAccessTable(db);
  const row = db.prepare("SELECT enabled FROM companion_access WHERE singleton = 1").get();
  return row !== undefined && Number(row["enabled"]) === 1;
}

function savePhoneAccess(db: Db, enabled: boolean, by: string, now: Date): void {
  ensureAccessTable(db);
  db.prepare(`INSERT INTO companion_access (singleton, enabled, changed_by, changed_at) VALUES (1, ?, ?, ?)
    ON CONFLICT(singleton) DO UPDATE SET enabled = excluded.enabled, changed_by = excluded.changed_by, changed_at = excluded.changed_at`)
    .run(enabled ? 1 : 0, by, now.toISOString());
}

/** The relay this console would use, from its environment; a bad value is reported, never guessed around. */
export function relayChoiceOf(env: NodeJS.ProcessEnv): { ok: true; choice: CompanionRelayChoice } | { ok: false; problem: string } {
  const url = env["TOOLROLL_RELAY_URL"]?.trim();
  if (url !== undefined && url.length > 0) {
    try {
      relayAddressesOf(url);
      return { ok: true, choice: { kind: "external", url } };
    } catch (error) {
      return { ok: false, problem: `TOOLROLL_RELAY_URL: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  const rawPort = env["TOOLROLL_PHONE_RELAY_PORT"]?.trim();
  const port = rawPort === undefined || rawPort.length === 0 ? DEFAULT_BUILT_IN_RELAY_PORT : Number(rawPort);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) return { ok: false, problem: "TOOLROLL_PHONE_RELAY_PORT must be a port from 1024 to 65535." };
  return { ok: true, choice: { kind: "built-in", port } };
}

export interface PhoneAccess {
  /** The running service, or null while phone access is off (or failed to start). */
  service(): CompanionService | null;
  enabled(): boolean;
  /** Why it isn't running although on (a bad relay setting, a port in use), if so. */
  problem(): string | null;
  relayKind(): "built-in" | "external" | null;
  turn(on: boolean, by: string, now: Date): Promise<void>;
  /** Start it when the saved choice says so (the console's start). */
  resume(): Promise<void>;
  stop(): Promise<void>;
}

export function createPhoneAccess(opts: { store: Store; reads: CompanionReadHandlers; env?: NodeJS.ProcessEnv; log?: (line: string) => void }): PhoneAccess {
  const env = opts.env ?? process.env;
  let running: CompanionService | null = null;
  let problem: string | null = null;
  let kind: "built-in" | "external" | null = null;
  let changing: Promise<void> = Promise.resolve();

  const start = async (): Promise<void> => {
    if (running !== null) return;
    const chosen = relayChoiceOf(env);
    if (!chosen.ok) { problem = chosen.problem; kind = null; return; }
    kind = chosen.choice.kind;
    const service = new CompanionService({ store: opts.store, reads: opts.reads, relay: chosen.choice, ...(opts.log === undefined ? {} : { log: opts.log }) });
    try {
      await service.start();
      running = service;
      problem = null;
    } catch (error) {
      await service.stop().catch(() => {});
      problem = chosen.choice.kind === "built-in" && (error as { code?: unknown }).code === "EADDRINUSE"
        ? `Port ${chosen.choice.port} on this computer is in use. Set TOOLROLL_PHONE_RELAY_PORT to another port and restart Toolroll.`
        : `Phone access couldn't start: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  const stop = async (): Promise<void> => {
    const service = running;
    running = null;
    if (service !== null) await service.stop();
  };
  const serially = (work: () => Promise<void>): Promise<void> => {
    changing = changing.then(work, work);
    return changing;
  };

  return {
    service: () => running,
    enabled: () => phoneAccessEnabled(opts.store.handle),
    problem: () => problem,
    relayKind: () => kind,
    turn: (on, by, now) => serially(async () => {
      savePhoneAccess(opts.store.handle, on, by, now);
      if (on) await start(); else { await stop(); problem = null; kind = null; }
    }),
    resume: () => serially(async () => { if (phoneAccessEnabled(opts.store.handle)) await start(); }),
    stop: () => serially(stop),
  };
}

/** This Mac's name for the phone's header ("Alex's MacBook Pro" style hostnames read plainly). */
export function workspaceLabelOf(): string {
  const name = hostname().replace(/\.local$/i, "").replace(/-/g, " ").trim();
  return name.length === 0 ? "Your Mac" : name.slice(0, 64);
}
