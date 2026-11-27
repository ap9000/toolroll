/**
 * Whether this console offers phone access, how phones may reach it, and the running service when it does.
 *
 * Off by default. An instance operator turns it on in Settings → Phone (the typed password); the choice is kept in the
 * workspace's database so it survives a restart, and a restore leaves it as the backup had it (the paired phones
 * themselves are wiped on restore: restore-retirement.ts).
 *
 * Two paths (service.ts): direct — a listener on this Mac's network for a phone on the same Wi-Fi or tailnet (port
 * 4199 unless `TOOLROLL_PHONE_RELAY_PORT` says otherwise) — and hosted, an end-to-end encrypted relay for a phone
 * anywhere else (wss://relay.toolroll.dev unless `TOOLROLL_RELAY_URL` names another; `TOOLROLL_RELAY_URL=off` removes
 * it). The hosted path is its own choice, saved beside the switch: turning phone access on asks for it explicitly, and
 * a saved choice that predates it reads as off — an earlier approval never widens to a new destination by itself.
 */

import { hostname } from "node:os";
import type { Store } from "../store.js";
import type { CompanionReadHandlers } from "./daemon.js";
import { CompanionService, relayAddressesOf } from "./service.js";

/** The direct listener's port unless the environment says otherwise (`TOOLROLL_PHONE_RELAY_PORT`). Not 4190: that is
 * on the Fetch standard's bad-port list, which web clients refuse outright. */
export const DEFAULT_DIRECT_PORT = 4199;

/** The hosted relay phones use when away from this Mac's network, unless `TOOLROLL_RELAY_URL` names another. */
export const DEFAULT_HOSTED_RELAY = "wss://relay.toolroll.dev";

type Db = Store["handle"];

/** The Fetch standard's bad ports at or above 1024 (https://fetch.spec.whatwg.org/#bad-port): fetch and browsers refuse them. */
const FETCH_BAD_PORTS = new Set([1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);

function ensureAccessTable(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS companion_access (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    changed_by TEXT NOT NULL,
    changed_at TEXT NOT NULL
  )`);
  const columns = db.prepare("PRAGMA table_info(companion_access)").all().map(row => String(row["name"]));
  if (!columns.includes("hosted")) db.exec("ALTER TABLE companion_access ADD COLUMN hosted INTEGER NOT NULL DEFAULT 0 CHECK (hosted IN (0, 1))");
}

function savedAccess(db: Db): { enabled: boolean; hosted: boolean } {
  ensureAccessTable(db);
  const row = db.prepare("SELECT enabled, hosted FROM companion_access WHERE singleton = 1").get();
  return { enabled: row !== undefined && Number(row["enabled"]) === 1, hosted: row !== undefined && Number(row["hosted"]) === 1 };
}

export function phoneAccessEnabled(db: Db): boolean {
  return savedAccess(db).enabled;
}

function savePhoneAccess(db: Db, enabled: boolean, hosted: boolean, by: string, now: Date): void {
  ensureAccessTable(db);
  db.prepare(`INSERT INTO companion_access (singleton, enabled, hosted, changed_by, changed_at) VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(singleton) DO UPDATE SET enabled = excluded.enabled, hosted = excluded.hosted, changed_by = excluded.changed_by, changed_at = excluded.changed_at`)
    .run(enabled ? 1 : 0, hosted ? 1 : 0, by, now.toISOString());
}

export type HostedChoice = { ok: true; url: string } | { ok: false; off: true } | { ok: false; off: false; problem: string };

/** The hosted relay this console would use, from its environment: a URL, deliberately none, or a bad value (reported,
 * never guessed around). */
export function hostedRelayOf(env: NodeJS.ProcessEnv): HostedChoice {
  const raw = env["TOOLROLL_RELAY_URL"]?.trim();
  if (raw === undefined || raw.length === 0) return { ok: true, url: DEFAULT_HOSTED_RELAY };
  if (raw.toLowerCase() === "off") return { ok: false, off: true };
  try {
    relayAddressesOf(raw);
    return { ok: true, url: raw };
  } catch (error) {
    return { ok: false, off: false, problem: `TOOLROLL_RELAY_URL: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** The direct listener's port from the environment, or why it can't be used. */
export function directPortOf(env: NodeJS.ProcessEnv): { ok: true; port: number } | { ok: false; problem: string } {
  const raw = env["TOOLROLL_PHONE_RELAY_PORT"]?.trim();
  const port = raw === undefined || raw.length === 0 ? DEFAULT_DIRECT_PORT : Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) return { ok: false, problem: "TOOLROLL_PHONE_RELAY_PORT must be a port from 1024 to 65535." };
  if (FETCH_BAD_PORTS.has(port)) return { ok: false, problem: `TOOLROLL_PHONE_RELAY_PORT ${port} is a port web clients refuse to connect to; choose another.` };
  return { ok: true, port };
}

export interface PhoneAccess {
  /** The running service, or null while phone access is off. */
  service(): CompanionService | null;
  enabled(): boolean;
  /** Whether the saved choice includes the hosted relay (meaningful while on). */
  hostedEnabled(): boolean;
  /** The hosted relay this console would use (its URL), or that there is none / a bad setting. */
  hostedChoice(): HostedChoice;
  /** Configuration problems that stop a path (a bad port or relay setting), if any. */
  problems(): string[];
  /** `allowed` is re-proved inside the serialized change (the switch's authority, checked at the moment it applies).
   * `hosted` is the hosted relay choice that goes with turning it on (ignored when the environment has none). */
  turn(on: boolean, hosted: boolean, by: string, now: Date, allowed?: () => boolean): Promise<void>;
  /** Start it when the saved choice says so (the console's start). */
  resume(): Promise<void>;
  stop(): Promise<void>;
}

export function createPhoneAccess(opts: { store: Store; reads: CompanionReadHandlers; env?: NodeJS.ProcessEnv; log?: (line: string) => void }): PhoneAccess {
  const env = opts.env ?? process.env;
  let running: CompanionService | null = null;
  let changing: Promise<void> = Promise.resolve();

  const problems = (): string[] => {
    const port = directPortOf(env), hosted = hostedRelayOf(env);
    return [...(port.ok ? [] : [port.problem]), ...(!hosted.ok && !hosted.off ? [hosted.problem] : [])];
  };
  const start = async (): Promise<void> => {
    if (running !== null) return;
    const port = directPortOf(env), hosted = hostedRelayOf(env);
    const wantHosted = savedAccess(opts.store.handle).hosted && hosted.ok;
    const service = new CompanionService({
      store: opts.store, reads: opts.reads,
      direct: port.ok ? { port: port.port } : null,
      hosted: wantHosted ? hosted.url : null,
      ...(opts.log === undefined ? {} : { log: opts.log }),
    });
    await service.start();
    running = service;
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
    hostedEnabled: () => savedAccess(opts.store.handle).hosted,
    hostedChoice: () => hostedRelayOf(env),
    problems,
    turn: (on, hosted, by, now, allowed) => serially(async () => {
      if (allowed !== undefined && !allowed()) return;
      savePhoneAccess(opts.store.handle, on, on && hosted && hostedRelayOf(env).ok, by, now);
      // A change of paths restarts the service: sessions reconnect on their own.
      await stop();
      if (on) {
        await start();
        // Give the relay a moment, so the page the person returns to usually says Connected, not Starting.
        const deadline = Date.now() + 3_000;
        while (running !== null && running.status().hosted.state === "starting" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      }
    }),
    resume: () => serially(async () => { if (phoneAccessEnabled(opts.store.handle)) await start(); }),
    stop: () => serially(stop),
  };
}

/** This Mac's name for the phone's header: a "Studio-Mac.local" hostname reads as "Studio Mac". */
export function workspaceLabelOf(): string {
  const name = hostname().replace(/\.local$/i, "").replace(/-/g, " ").trim();
  return name.length === 0 ? "Your Mac" : name.slice(0, 64);
}
