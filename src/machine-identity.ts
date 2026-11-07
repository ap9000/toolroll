/**
 * Which computer is "this one" for process custody (process witnesses, workspace notes, quarantine journals, a coding
 * agent's custody, runner records, eval campaigns).
 *
 * The network hostname is not an identity: on a Mac with no HostName set, os.hostname() follows the network
 * ("Studio-A.local" on one network, "studio-a.localdomain" on another). A witness recorded under the
 * old name then read as another computer's forever, and a finished build waited on that computer to confirm it
 * stopped (runs 3312 and 3313).
 *
 * So each witness carries this machine's stable id, read from the OS and hashed with a Toolroll-only prefix (the raw
 * id is never stored):
 *
 *   darwin  IOPlatformUUID (ioreg -rd1 -c IOPlatformExpertDevice): fixed per machine
 *   linux   /etc/machine-id (or /var/lib/dbus/machine-id): fixed per installation; a container reads as unknown, since
 *           containers made from one image can share it
 *   win32   HKLM\SOFTWARE\Microsoft\Cryptography MachineGuid
 *
 * THE RULE (isThisMachine): a witness with an id is this machine's exactly when the id equals ours, and never when ours
 * is unknown. A witness without one (written before v150, or by a process that couldn't read its id) is this
 * machine's when its host string is one of this machine's own names: os.hostname() as it reads now, the names macOS
 * configures for it (scutil HostName, LocalHostName + ".local"), and the hostnames recorded beside this machine's own
 * id (machine_host_alias, written only by a process that read that id here, with the hostname it read here at the
 * same moment). No name ever enters the set from a witness, a note, a runner record or anything another computer
 * wrote, so another computer can only match by holding one of this machine's own names: the same coincidence the
 * plain hostname comparison always accepted, and never for a witness that carries a different id.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";

export type MachineIdentity =
  | { ok: true; id: string; source: "darwin-platform-uuid" | "linux-machine-id" | "win32-machine-guid" | "injected" }
  | { ok: false; reason: "unsupported-platform" | "unreadable" | "malformed" | "container"; detail: string };

export type MachineIdentityReaders = {
  platform?: NodeJS.Platform;
  readFile?: (path: string) => string;
  exists?: (path: string) => boolean;
  run?: (file: string, args: string[]) => string;
};

const defaultRun = (file: string, args: string[]) => execFileSync(file, args, { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });

/** The stored form of a raw OS id: hashed under a Toolroll-only prefix, so the record never holds the raw id. */
export function hashMachineId(source: string, raw: string): string {
  return createHash("sha256").update(`toolroll machine identity v1\0${source}\0${raw.trim().toLowerCase()}`).digest("hex").slice(0, 32);
}

/** Read this machine's id from the OS, never cached here (machineIdentity() caches it). */
export function readMachineIdentity(readers: MachineIdentityReaders = {}): MachineIdentity {
  const platform = readers.platform ?? process.platform;
  const readFile = readers.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const exists = readers.exists ?? existsSync;
  const run = readers.run ?? defaultRun;
  try {
    if (platform === "darwin") {
      const raw = /"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{36})"/.exec(run("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]))?.[1];
      if (raw === undefined || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) return { ok: false, reason: "malformed", detail: "ioreg named no IOPlatformUUID" };
      return { ok: true, id: hashMachineId("darwin-platform-uuid", raw), source: "darwin-platform-uuid" };
    }
    if (platform === "linux") {
      // Containers built from one image can carry the same machine-id: there the id proves nothing, and the host
      // name (the container's own) decides, as it always did.
      if (exists("/.dockerenv") || exists("/run/.containerenv")) return { ok: false, reason: "container", detail: "a container's machine-id can be shared with other containers" };
      let raw: string | null = null;
      for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
        try { raw = readFile(path).trim(); break; } catch { /* the next place */ }
      }
      if (raw === null) return { ok: false, reason: "unreadable", detail: "no machine-id could be read" };
      if (!/^[0-9a-f]{32}$/i.test(raw) || /^0+$/.test(raw)) return { ok: false, reason: "malformed", detail: "the machine-id was not 32 hex digits" };
      return { ok: true, id: hashMachineId("linux-machine-id", raw), source: "linux-machine-id" };
    }
    if (platform === "win32") {
      const out = run("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"]);
      const raw = /MachineGuid\s+REG_SZ\s+([0-9A-Fa-f-]{36})/.exec(out)?.[1];
      if (raw === undefined) return { ok: false, reason: "malformed", detail: "the registry named no MachineGuid" };
      return { ok: true, id: hashMachineId("win32-machine-guid", raw), source: "win32-machine-guid" };
    }
    return { ok: false, reason: "unsupported-platform", detail: `${platform} exposes no machine identity this build trusts` };
  } catch (error) {
    return { ok: false, reason: "unreadable", detail: `the machine identity could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** The names macOS configures for this machine (not the network's): HostName when set, and LocalHostName.local
 * (Bonjour keeps it unique on its network). Empty elsewhere or when scutil can't answer. */
export function readConfiguredHostNames(readers: MachineIdentityReaders = {}): string[] {
  if ((readers.platform ?? process.platform) !== "darwin") return [];
  const run = readers.run ?? defaultRun;
  const names: string[] = [];
  const one = (key: string): string | null => {
    try {
      const value = run("/usr/sbin/scutil", ["--get", key]).trim();
      return /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(value) ? value : null;
    } catch { return null; }
  };
  const host = one("HostName");
  if (host !== null) names.push(host);
  const local = one("LocalHostName");
  if (local !== null && !local.includes(".")) names.push(`${local}.local`);
  return names;
}

let cachedIdentity: MachineIdentity | null = null;
let cachedConfigured: string[] | null = null;
/** Hostnames recorded beside this machine's id (machine_host_alias), learned from this process's store. */
const remembered = new Map<string, Set<string>>();

/** This machine's identity, read once per process. */
export function machineIdentity(): MachineIdentity {
  if (cachedIdentity === null) cachedIdentity = readMachineIdentity();
  return cachedIdentity;
}

/** The id to stamp on a new witness, or null when this machine's id is unknown. */
export function currentMachineId(): string | null {
  const identity = machineIdentity();
  return identity.ok ? identity.id : null;
}

/** Tests only: pin (or clear, with null) this process's machine id and configured names, and forget remembered names. */
export function injectMachineIdentity(identity: MachineIdentity | null, configured: string[] | null = identity === null ? null : []): void {
  cachedIdentity = identity;
  cachedConfigured = configured;
  remembered.clear();
}

/** Note hostnames recorded beside `id` in this machine's own records. Names for another id are kept apart and never
 * read as this machine's. */
export function rememberHostAliases(id: string, hosts: Iterable<string>): void {
  let set = remembered.get(id);
  if (set === undefined) remembered.set(id, set = new Set());
  for (const host of hosts) if (host !== "") set.add(host);
}

/** The names this machine is known by right now, from this machine alone: its hostname as it reads now and the
 * names macOS configures for it. What a new witness records beside its id. */
export function liveHostAliases(): string[] {
  if (cachedConfigured === null) cachedConfigured = readConfiguredHostNames();
  return [...new Set([hostname(), ...cachedConfigured])];
}

export type ThisMachine = { id: string | null; hosts: string[] };

/** This machine: its id (null when unknown) and every name it is known by: its live names, plus the names recorded
 * beside its id when the id is known. */
export function thisMachine(extra: Iterable<string> = []): ThisMachine {
  const id = currentMachineId();
  const hosts = new Set(liveHostAliases());
  if (id !== null) {
    for (const host of remembered.get(id) ?? []) hosts.add(host);
    for (const host of extra) hosts.add(host);
  }
  return { id, hosts: [...hosts] };
}

/** THE RULE (module comment): whether a witness names this machine. */
export function isThisMachine(witness: { host: string; machineId?: string | null }, here: ThisMachine = thisMachine()): boolean {
  if (witness.machineId !== null && witness.machineId !== undefined) return here.id !== null && witness.machineId === here.id;
  return here.hosts.includes(witness.host);
}

/** Whether a recorded host is the machine a caller named by `here`: exact, or, when `here` is this machine's hostname
 * as it reads now, any of this machine's names (a caller that passes another host, as a test does, compares exactly). */
export function sameMachineHost(seen: string, here: string = hostname(), machineId?: string | null): boolean {
  if (machineId !== null && machineId !== undefined) return here === hostname() && isThisMachine({ host: seen, machineId });
  if (seen === here) return true;
  return here === hostname() && isThisMachine({ host: seen });
}
