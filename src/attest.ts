/**
 * Tier-2 attestation (Parity II Phase 3, spec v1 D6 + v2 A2 + v3 B3 + v4 C3):
 * a provider outside tier 1 runs ONLY at versions its conformance fixtures
 * were proven against. The check is enforced at the one spawning gateway —
 * this module only states ranges and probes binaries; it spawns no agent.
 *
 * Guarantee, stated exactly (v4 C3): attestation proves the version of the
 * binary OBSERVED AT SPAWN TIME — probe and spawn share one resolved
 * absolute path, revalidated by a fresh stat immediately before use. A
 * concurrent atomic replacement between that stat and the kernel exec is
 * acknowledged as unprovable without content-addressed snapshots, and
 * nothing here claims otherwise.
 *
 * Re-attestation is a release act: run the conformance suite against the
 * new CLI, move `ceiling` in a reviewed commit. Removal criterion (ruling
 * 13's N, fixed): three consecutive minor releases failing conformance
 * without a fixable adapter change retire the adapter, typed.
 */

import { ACP_AGENTS, isAcpProvider } from "./acp-agents.js";
import { execFile } from "node:child_process";
import { realpathSync, statSync, accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { ALL_CREDENTIAL_ENV, type ProviderId } from "./provider.js";

export type AttestationRange = {
  /** Lowest plain release the fixtures cover, inclusive. */
  floor: string;
  /** First release the fixtures do NOT cover, exclusive. */
  ceiling: string;
  /** The exact version the current fixture set was recorded against. */
  fixturesAt: string;
};

/** Tier-1 providers deliberately have NO entry: no probe, no new refusal —
 * their spawn road stays byte-identical (spec A2). */
export const ATTESTATIONS: Partial<Record<ProviderId, AttestationRange>> = {
  gemini: { floor: "0.57.0", ceiling: "0.58.0", fixturesAt: "0.57.0" },
};

export function attestationOf(provider: ProviderId): AttestationRange | null {
  return ATTESTATIONS[provider] ?? null;
}

export type AttestOutcome =
  | { ok: true; executable: string; version: string }
  | { ok: false; problem: string; version: string | null };

export type VersionProbe = (
  file: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<{ code: number; stdout: string }>;

const PROBE_TIMEOUT_MS = 5_000;

/** Only a PLAIN release attests (v2 A2): prerelease, nightly, malformed,
 * or empty version strings are out of range BY RULE, not by comparison. */
const PLAIN_SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function parsePlain(version: string): [number, number, number] | null {
  const match = PLAIN_SEMVER.exec(version.trim());
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeast(a: [number, number, number], b: [number, number, number]): boolean {
  if (a[0] !== b[0]) return a[0] > b[0];
  if (a[1] !== b[1]) return a[1] > b[1];
  return a[2] >= b[2];
}

export function versionInRange(version: string, range: AttestationRange): boolean {
  const v = parsePlain(version);
  const floor = parsePlain(range.floor);
  const ceiling = parsePlain(range.ceiling);
  if (v === null || floor === null || ceiling === null) return false;
  return atLeast(v, floor) && !atLeast(v, ceiling);
}

/** PATH resolution to ONE absolute realpath — the path the probe runs and
 * the path the gateway spawns (v3 B3: no second resolution). */
export function resolveExecutable(binary: string): string | null {
  const candidates: string[] = [];
  if (binary.includes("/") || isAbsolute(binary)) {
    candidates.push(binary);
  } else {
    for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
      if (dir !== "") candidates.push(join(dir, binary));
    }
  }
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      continue;
    }
  }
  return null;
}

type CacheEntry = {
  realpath: string;
  dev: number;
  ino: number;
  ctimeMs: number;
  size: number;
  version: string;
};

const cache = new Map<string, CacheEntry>();

/** Tests only. */
export function resetAttestationCache(): void {
  cache.clear();
}

const defaultProbe: VersionProbe = (file, args, timeoutMs) =>
  new Promise(resolve => {
    // A version probe needs NO credential (Codex gemini verify, finding
    // 2): strip every provider key from the child so an authoritative
    // attestation spawn cannot leak one.
    const env: Record<string, string | undefined> = { ...process.env };
    for (const name of ALL_CREDENTIAL_ENV) delete env[name];
    execFile(file, [...args], { timeout: timeoutMs, encoding: "utf8", env }, (error, stdout) => {
      resolve({ code: error === null ? 0 : 1, stdout: String(stdout ?? "") });
    });
  });

/**
 * The pre-spawn check (v2 A2): resolve, revalidate, probe if anything
 * moved, compare. Every failure is a typed refusal with words — never a
 * throw, never a silent pass. Returns null for tier-1 providers.
 */
export async function attestProvider(
  provider: ProviderId,
  binary: string,
  probe: VersionProbe = defaultProbe,
): Promise<AttestOutcome | null> {
  // An ACP agent runs only on a passed conformance check of the exact binary here (docs/plans/acp-adapter.md
  // § Admission). Absence is denial: there is no "tier 1, allow" for it. The check itself arrives with layer E;
  // until then no ACP agent runs.
  if (isAcpProvider(provider)) {
    return { ok: false, problem: `${ACP_AGENTS[provider].name} isn't checked on this computer — run \`toolroll agents check ${provider}\``, version: null };
  }
  const range = attestationOf(provider);
  if (range === null) return null;

  const resolved = resolveExecutable(binary);
  if (resolved === null) {
    return { ok: false, problem: `${binary} is not installed on this runner's PATH`, version: null };
  }
  let stat: { dev: number; ino: number; ctimeMs: number; size: number };
  try {
    const s = statSync(resolved);
    stat = { dev: s.dev, ino: s.ino, ctimeMs: s.ctimeMs, size: s.size };
  } catch {
    return { ok: false, problem: `${resolved} vanished while being checked`, version: null };
  }

  const cached = cache.get(provider);
  let version: string;
  if (
    cached !== undefined &&
    cached.realpath === resolved &&
    cached.dev === stat.dev &&
    cached.ino === stat.ino &&
    cached.ctimeMs === stat.ctimeMs &&
    cached.size === stat.size
  ) {
    version = cached.version;
  } else {
    const answer = await probe(resolved, ["--version"], PROBE_TIMEOUT_MS);
    const raw = answer.stdout.trim().slice(0, 100);
    if (answer.code !== 0 || raw === "") {
      cache.delete(provider);
      return { ok: false, problem: `${resolved} did not answer --version`, version: null };
    }
    if (parsePlain(raw) === null) {
      cache.delete(provider);
      return {
        ok: false,
        problem: `${binary} reports version \`${raw}\` — only plain releases attest, and this is not one`,
        version: raw,
      };
    }
    version = raw;
    cache.set(provider, { realpath: resolved, ...stat, version });
  }

  if (!versionInRange(version, range)) {
    return {
      ok: false,
      problem: `${binary} ${version} is installed; ${range.floor} up to (not including) ${range.ceiling} is the attested range — re-attestation is a release act, not a retry`,
      version,
    };
  }
  return { ok: true, executable: resolved, version };
}
