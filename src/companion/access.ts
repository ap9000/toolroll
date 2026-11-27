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
 * it). The hosted path is its own choice, saved beside the switch as the exact relay address that was approved:
 * turning phone access on asks for it explicitly, and if the configured relay later changes, the new one isn't used
 * until someone approves it — an approval never carries over to a different destination.
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
  if (!columns.includes("hosted_relay")) db.exec("ALTER TABLE companion_access ADD COLUMN hosted_relay TEXT");
}

/** The saved switch and the hosted relay address it approved (its connect URL), if any. */
function savedAccess(db: Db): { enabled: boolean; hostedRelay: string | null } {
  ensureAccessTable(db);
  const row = db.prepare("SELECT enabled, hosted_relay FROM companion_access WHERE singleton = 1").get();
  const relay = row?.["hosted_relay"];
  return { enabled: row !== undefined && Number(row["enabled"]) === 1, hostedRelay: typeof relay === "string" && relay.length > 0 ? relay : null };
}

/** A relay's identity for approval: its WebSocket connect URL (scheme, host and port). */
const relayIdentityOf = (url: string): string => relayAddressesOf(url).ws;

export function phoneAccessEnabled(db: Db): boolean {
  return savedAccess(db).enabled;
}

function savePhoneAccess(db: Db, enabled: boolean, hostedRelay: string | null, by: string, now: Date): void {
  ensureAccessTable(db);
  db.prepare(`INSERT INTO companion_access (singleton, enabled, hosted_relay, changed_by, changed_at) VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(singleton) DO UPDATE SET enabled = excluded.enabled, hosted_relay = excluded.hosted_relay, changed_by = excluded.changed_by, changed_at = excluded.changed_at`)
    .run(enabled ? 1 : 0, hostedRelay, by, now.toISOString());
}

/** A change to phone access: on (with or without the hosted relay), off, or only the hosted relay while on. */
export type PhoneAccessChange = { act: "on"; hosted: boolean } | { act: "off" } | { act: "hosted-on" } | { act: "hosted-off" };

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
  /** Whether the saved choice approves the hosted relay this console is configured with now. */
  hostedEnabled(): boolean;
  /** The saved approval names a different relay than the one configured now (it isn't used until approved again). */
  hostedApprovalStale(): boolean;
  /** The hosted relay this console would use (its URL), or that there is none / a bad setting. */
  hostedChoice(): HostedChoice;
  /** Configuration problems that stop a path (a bad port or relay setting), if any. */
  problems(): string[];
  /** Applied in order with every other change; `allowed` is re-proved at the moment it applies (the switch's
   * authority). A hosted-only change while access is off is refused ("not_on"), never a way to turn it on. */
  change(change: PhoneAccessChange, by: string, now: Date, allowed?: () => boolean): Promise<"ok" | "not_allowed" | "not_on">;
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
    const approved = savedAccess(opts.store.handle).hostedRelay;
    const wantHosted = hosted.ok && approved !== null && approved === relayIdentityOf(hosted.url);
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
    hostedEnabled: () => {
      const hosted = hostedRelayOf(env), approved = savedAccess(opts.store.handle).hostedRelay;
      return hosted.ok && approved !== null && approved === relayIdentityOf(hosted.url);
    },
    hostedApprovalStale: () => {
      const hosted = hostedRelayOf(env), approved = savedAccess(opts.store.handle).hostedRelay;
      return approved !== null && (!hosted.ok || approved !== relayIdentityOf(hosted.url));
    },
    hostedChoice: () => hostedRelayOf(env),
    problems,
    change: (change, by, now, allowed) => {
      let outcome: "ok" | "not_allowed" | "not_on" = "ok";
      return serially(async () => {
        if (allowed !== undefined && !allowed()) { outcome = "not_allowed"; return; }
        const saved = savedAccess(opts.store.handle), hosted = hostedRelayOf(env);
        const current = hosted.ok ? relayIdentityOf(hosted.url) : null;
        let enabled: boolean, approved: string | null;
        if (change.act === "on") { enabled = true; approved = change.hosted ? current : null; }
        else if (change.act === "off") { enabled = false; approved = null; }
        else {
          // Read inside the queue: a hosted-only form posted before someone turned access off can't turn it back on.
          if (!saved.enabled) { outcome = "not_on"; return; }
          enabled = true; approved = change.act === "hosted-on" ? current : null;
        }
        savePhoneAccess(opts.store.handle, enabled, approved, by, now);
        // A change of paths restarts the service: sessions reconnect on their own.
        await stop();
        if (enabled) {
          await start();
          // Give the relay a moment, so the page the person returns to usually says Connected, not Starting.
          const deadline = Date.now() + 3_000;
          while (running !== null && running.status().hosted.state === "starting" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
        }
      }).then(() => outcome);
    },
    resume: () => serially(async () => { if (phoneAccessEnabled(opts.store.handle)) await start(); }),
    stop: () => serially(stop),
  };
}

/** This Mac's name for the phone's header: a "Studio-Mac.local" hostname reads as "Studio Mac". */
export function workspaceLabelOf(): string {
  const name = hostname().replace(/\.local$/i, "").replace(/-/g, " ").trim();
  return name.length === 0 ? "Your Mac" : name.slice(0, 64);
}
