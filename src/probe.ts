/**
 * Asking an environment whether it has what the work needs.
 *
 * A probe is an operator-authored command line whose exit 0 means "present
 * and alive": `gh auth status`, `test -n "$SUPABASE_KEY"`. It runs through
 * a real shell, deliberately — the design's own examples need expansion and
 * `test` — and that is safe only because of who wrote it: probes are stored
 * by the operator, at `cap add`, with the author recorded. Nothing an agent
 * or a scanned repository writes is ever executed as a probe; the scanner
 * synthesizes probes from a fixed template over validated identifiers or
 * stores none at all.
 *
 * The answer is a claim about one machine at one moment. `verified` carries
 * when and by whom; anything else carries the probe's own words — "exit 1",
 * "timed out", "sh not found" — because collapsing those to a bit discards
 * exactly what tells an operator whether to paste a key or fix a PATH.
 */

import {
  run,
  NOT_FOUND_CODE,
  OVERFLOW_CODE,
  TIMEOUT_CODE,
  type ExecResult,
  type RunOptions,
} from "./exec.js";
import type { Capability, Store } from "./store.js";

export type Runner = (
  file: string,
  args: readonly string[],
  options?: RunOptions,
) => Promise<ExecResult>;

/** Probes are cheap questions; one that hangs is already an answer. */
export const PROBE_TIMEOUT_MS = 10_000;

export type ProbeOutcome = {
  kind: Capability["kind"];
  name: string;
  status: "verified" | "failed" | "unprobed";
  /** The probe's words when it did not say yes. */
  detail?: string;
};

/**
 * Whether a capability is verified *right now*: a stale yes is not a yes.
 * Presence is not enough, and neither is a verification whose expiry passed.
 */
export function isVerified(capability: Capability, now: Date): boolean {
  if (capability.status !== "verified") return false;
  if (capability.expiresAt === null) return true;
  return capability.expiresAt > now.toISOString();
}

/** Run one capability's probe and record what it said. */
export async function probeOne(
  store: Store,
  capability: Capability,
  by: string,
  now: Date,
  runner: Runner = run,
  env?: Record<string, string>,
): Promise<ProbeOutcome> {
  const { kind, name } = capability;

  if (capability.probe === null) {
    // Nothing can vouch for it, and nobody may vouch by hand (§3: presence
    // is not enough — an assertion is even less). It stays a visible gap.
    return { kind, name, status: "unprobed", detail: "no probe — only a probe can verify" };
  }

  const asked = await runner("sh", ["-lc", capability.probe], {
    cwd: capability.repo,
    timeoutMs: PROBE_TIMEOUT_MS,
    ...(env === undefined ? {} : { env }),
  });

  if (asked.code === 0) {
    store.markCapability(capability.repo, kind, name, { status: "verified", by }, now);
    return { kind, name, status: "verified" };
  }

  const detail = describe(asked);
  store.markCapability(capability.repo, kind, name, { status: "failed", by, detail }, now);
  return { kind, name, status: "failed", detail };
}

/**
 * Probe a repo's capabilities — all of them, or the named subset. Statuses
 * land in the store as each probe answers; the returned outcomes are for
 * reporting, not the source of truth.
 */
export async function probeRepo(
  store: Store,
  repo: string,
  by: string,
  now: Date,
  options: { runner?: Runner; only?: ReadonlySet<string>; env?: Record<string, string> } = {},
): Promise<ProbeOutcome[]> {
  const outcomes: ProbeOutcome[] = [];
  for (const capability of store.listCapabilities(repo)) {
    if (options.only !== undefined && !options.only.has(`${capability.kind}:${capability.name}`)) {
      continue;
    }
    outcomes.push(
      await probeOne(store, capability, by, now, options.runner ?? run, options.env),
    );
  }
  return outcomes;
}

function describe(result: ExecResult): string {
  if (result.timedOut || result.code === TIMEOUT_CODE) {
    return `timed out after ${PROBE_TIMEOUT_MS / 1000}s`;
  }
  if (result.notFound || result.code === NOT_FOUND_CODE) return "sh not found";
  if (result.code === OVERFLOW_CODE) return "output too large";
  const stderr = result.stderr.split("\n")[0]?.trim() ?? "";
  return stderr === "" ? `exit ${result.code}` : `exit ${result.code} — ${stderr}`;
}
