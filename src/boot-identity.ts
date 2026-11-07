/**
 * OS boot identity for process custody (OS containment and login recovery).
 *
 * A process witness carries the PID it saw, the host that saw it, and —
 * from v53 — the identity of the OS boot it was born under. After a
 * VERIFIED boot change on the same host, no process of the old boot can
 * survive: a pending stop or recovery that would otherwise wait forever
 * on an incomplete old spawn, or on a PID the new boot has since reused,
 * may settle. Every other case keeps the conservative road the witness
 * already took: a witness with no boot id (legacy), a witness from
 * another host, a boot id this host cannot read or cannot parse, or two
 * identical ids (the same boot, where the PID probe still decides).
 *
 * The identity comes from the kernel's own per-boot token, never from
 * wall-clock arithmetic: a boot time compared to `now` proves nothing
 * across suspended clocks, NTP steps and time-zone edits.
 *
 *   linux   /proc/sys/kernel/random/boot_id — a UUID minted at boot
 *   darwin  sysctl kern.bootsessionuuid    — a UUID minted at boot
 *   win32   no unprivileged per-boot UUID this build trusts → unknown
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isThisMachine } from "./machine-identity.js";

/** RFC 4122 shape, any case; the kernel tokens are exactly this. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type BootIdentity =
  | { ok: true; id: string; source: "linux-boot-id" | "darwin-bootsessionuuid" | "injected" }
  | { ok: false; reason: "unsupported-platform" | "unreadable" | "malformed"; detail: string };

export type BootIdentityReaders = {
  platform?: NodeJS.Platform;
  readFile?: (path: string) => string;
  sysctl?: (name: string) => string;
};

/** Normalize a candidate token: exactly one UUID, lower-cased; anything else is malformed. */
// Recovery may compare this normalized token only after its host/kernel origin is
// authenticated; well-formed text alone supplies neither boot identity nor absence.
export function normalizeBootId(raw: string): string | null {
  const trimmed = raw.trim();
  return UUID.test(trimmed) ? trimmed.toLowerCase() : null;
}

/** Read the running kernel's boot token — never cached here, so a test can
 * construct each answer; production reads it once through bootIdentity(). */
export function readBootIdentity(readers: BootIdentityReaders = {}): BootIdentity {
  const platform = readers.platform ?? process.platform;
  const readFile = readers.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const sysctl =
    readers.sysctl ?? ((name: string) => execFileSync("/usr/sbin/sysctl", ["-n", name], { encoding: "utf8", timeout: 2000 }));
  let raw: string;
  let source: "linux-boot-id" | "darwin-bootsessionuuid";
  try {
    if (platform === "linux") {
      source = "linux-boot-id";
      raw = readFile("/proc/sys/kernel/random/boot_id");
    } else if (platform === "darwin") {
      source = "darwin-bootsessionuuid";
      raw = sysctl("kern.bootsessionuuid");
    } else {
      return { ok: false, reason: "unsupported-platform", detail: `${platform} exposes no per-boot identity this build trusts` };
    }
  } catch (error) {
    return { ok: false, reason: "unreadable", detail: `the boot identity could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
  const id = normalizeBootId(raw);
  if (id === null) return { ok: false, reason: "malformed", detail: `the boot identity was not a UUID (${raw.trim().slice(0, 64)})` };
  return { ok: true, id, source };
}

let cached: BootIdentity | null = null;

/** This process's boot identity, read once. `null` when it is unknown —
 * every consumer must then take the conservative road. */
export function bootIdentity(): BootIdentity {
  if (cached === null) cached = readBootIdentity();
  return cached;
}

/** The id to stamp on new custody, or null when the boot is unknown. */
export function currentBootId(): string | null {
  const identity = bootIdentity();
  return identity.ok ? identity.id : null;
}

/** Tests only: pin or clear the cached identity for this process. */
export function injectBootIdentity(identity: BootIdentity | null): void {
  cached = identity;
}

export type BootWitness = { host: string; bootId: string | null; machineId?: string | null };

/**
 * THE ONE RULE (plan §login/reboot recovery): a witnessed process is
 * proven dead by boot change only when the witness names THIS machine (isThisMachine), the
 * witness carries a well-formed boot id, this host's current boot id is
 * well-formed and known, and the two differ. Same boot, a legacy witness
 * without an id, a foreign host, an unknown or malformed current id — each
 * answers false, and the caller keeps its PID probe or its refusal.
 */
export function provenDeadByBootChange(
  witness: BootWitness,
  current: { host?: string; bootId: string | null } = { bootId: currentBootId() },
): boolean {
  // A caller naming the host compares exactly (restart certification, tests); otherwise THIS machine is decided by
  // its stable id, or for a witness without one by this machine's own names (machine-identity.ts), never by the
  // network hostname alone: a boot id from another machine always differs from ours.
  if (current.host !== undefined ? witness.host !== current.host : !isThisMachine(witness)) return false;
  if (witness.bootId === null || current.bootId === null) return false;
  const seen = normalizeBootId(witness.bootId);
  const now = normalizeBootId(current.bootId);
  if (seen === null || now === null) return false;
  return seen !== now;
}
