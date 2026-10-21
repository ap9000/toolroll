/**
 * How a run went (docs/plans/run-efficiency.md): derived from the run's own records, display only. It never changes a
 * completion, an approval, a charge or a check verdict, and it claims nothing its sources don't hold — an unreported
 * number is unknown (null, shown as a dash), never zero.
 *
 * Sources, and what each can say: the run row (wall times, tokens, the provider's raw usage with its cache counts, the
 * agent's turns where reported) is kept with the run; the live records (`<evidence>/live/<run>.jsonl`, display-only,
 * kept 24 hours) are read once, bounded, through the descriptor-safe live reader, for step counts and observed step
 * times. No command text is ever stored here: repeats are counted, never quoted.
 */
import type { Run, Store } from "./store.js";
import { LIVE_RETAIN_MS, liveWindowRecords, readLiveWindow } from "./live.js";
import { HIDDEN_TARGET, type LiveActivityKind, type LiveRecord } from "./live-records.js";

export const RUN_EFFICIENCY_VERSION = 1;
/** Budgets for one derivation: never more than the live file's own cap, a bounded record count and repeat groups. */
export const EFFICIENCY_READ_BYTES = 4 * 1024 * 1024;
export const EFFICIENCY_RECORDS = 20_000;
export const EFFICIENCY_REPEAT_GROUPS = 200;
const LONGEST = 5;
/** Repeated activity starts at this many of the same step. */
const REPEAT_AT = 3;

export type StepsState = "complete" | "truncated" | "expired" | "absent";
export type RunEfficiency = {
  version: number;
  /** Waiting to start (claimed → provider started) and the agent (provider started → finished); null when unrecorded. */
  time: { waitMs: number | null; agentMs: number | null };
  turns: number | null;
  /** Tokens in counts everything the model read (cached included); `cacheShare` is read-from-cache ÷ that, 0–1. */
  usage: { in: number | null; out: number | null; cacheRead: number | null; cacheWrite: number | null; cacheShare: number | null; provider: string; model: string | null };
  steps: {
    state: StepsState; reason: string | null;
    total: number | null; failed: number | null; unknownDuration: number | null;
    byKind: Partial<Record<LiveActivityKind, number>>;
    longest: { kind: LiveActivityKind; ms: number }[];
    /** Repeated activity: the same step (kind and its full recorded input) at least three times. Null when the inputs
     * can't be compared (command detail off, or a target hidden or shortened) — said, never guessed. */
    repeats: { kind: LiveActivityKind; count: number }[] | null;
    repeatsReason: string | null;
  };
};

const num = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const msBetween = (from: string | null, to: string | null): number | null => {
  if (from === null || to === null) return null;
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
};

/** Tokens and cache from the provider's own usage report, read per provider (their counts mean different things). */
export function usageOf(run: Pick<Run, "provider" | "model" | "tokensIn" | "tokensOut"> & { usageJson?: string | null }): RunEfficiency["usage"] {
  let raw: Record<string, unknown> = {};
  try { const parsed: unknown = run.usageJson == null ? null : JSON.parse(run.usageJson); if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>; } catch { raw = {}; }
  const base = { provider: run.provider, model: run.model ?? null, out: num(raw["output_tokens"]) ?? run.tokensOut ?? null };
  if (run.provider === "claude") {
    // Claude's input_tokens leave out what was read from or written to the cache: the three add up to what it read.
    const input = num(raw["input_tokens"]), read = num(raw["cache_read_input_tokens"]), write = num(raw["cache_creation_input_tokens"]);
    const total = input === null ? run.tokensIn ?? null : input + (read ?? 0) + (write ?? 0);
    return { ...base, in: total, cacheRead: read, cacheWrite: write, cacheShare: read === null || total === null || total === 0 ? null : read / total };
  }
  if (run.provider === "codex") {
    // Codex's input_tokens already include what came from its cache.
    const input = num(raw["input_tokens"]) ?? run.tokensIn ?? null, read = num(raw["cached_input_tokens"]);
    return { ...base, in: input, cacheRead: read, cacheWrite: null, cacheShare: read === null || input === null || input === 0 ? null : Math.min(1, read / input) };
  }
  return { ...base, in: run.tokensIn ?? null, cacheRead: null, cacheWrite: null, cacheShare: null };
}

/** The live records' steps, bounded: counts by kind, failures, observed times and repeats (never their words). */
export function stepsOf(records: Iterable<LiveRecord>, truncated: string | null): RunEfficiency["steps"] {
  let detail: "base" | "commands" = "base";
  const open = new Map<string, { kind: LiveActivityKind; at: string; target: string | null; once: boolean }>();
  const byKind: Partial<Record<LiveActivityKind, number>> = {};
  const longest: { kind: LiveActivityKind; ms: number }[] = [];
  const groups = new Map<string, { kind: LiveActivityKind; count: number }>();
  let total = 0, failed = 0, unknown = 0, comparable = true, groupsFull = false;
  for (const record of records) {
    if (record.k === "open") detail = record.detail;
    else if (record.k === "step") {
      if (record.kind === "session" || record.kind === "message") continue;
      total++;
      byKind[record.kind] = (byKind[record.kind] ?? 0) + 1;
      const target = record.target ?? null;
      open.set(record.id, { kind: record.kind, at: record.at, target, once: record.once === true });
      // A step's input is comparable only when it is recorded whole: the target neither hidden nor shortened by the
      // recorder (its caps end a cut target with an ellipsis). Only those are grouped; the rest are said to be left out.
      if (target === null) continue;
      if (target === HIDDEN_TARGET || target.endsWith("…")) comparable = false;
      else {
        const key = `${record.kind}\u0000${target}`;
        const group = groups.get(key);
        if (group !== undefined) group.count++;
        else if (groups.size < EFFICIENCY_REPEAT_GROUPS) groups.set(key, { kind: record.kind, count: 1 });
        else groupsFull = true;
      }
    } else if (record.k === "done") {
      const started = open.get(record.id);
      if (started === undefined) continue;
      open.delete(record.id);
      if (record.ok === false) failed++;
      // A start and end the recorder made up together (`once`) is not a measured time.
      const ms = started.once ? null : msBetween(started.at || null, record.at || null);
      if (ms === null) { unknown++; continue; }
      longest.push({ kind: started.kind, ms });
      longest.sort((a, b) => b.ms - a.ms);
      if (longest.length > LONGEST) longest.pop();
    }
  }
  // Steps that never closed (the run ended, or the file was cut) have no measured time.
  unknown += open.size;
  const repeatsReason = detail !== "commands" ? "Repeats can't be told apart: this project doesn't record step details."
    : !comparable ? "Some steps were recorded without their full input; they aren't counted as repeats."
    : groupsFull ? `Repeats were counted over the first ${EFFICIENCY_REPEAT_GROUPS} distinct steps only.` : null;
  const repeats = detail !== "commands" ? null
    : [...groups.values()].filter(one => one.count >= REPEAT_AT).sort((a, b) => b.count - a.count).slice(0, 10);
  return { state: truncated === null ? "complete" : "truncated", reason: truncated, total, failed, unknownDuration: unknown, byKind, longest, repeats, repeatsReason };
}

const noSteps = (state: "expired" | "absent", reason: string): RunEfficiency["steps"] =>
  ({ state, reason, total: null, failed: null, unknownDuration: null, byKind: {}, longest: [], repeats: null, repeatsReason: null });

/** Read the run's live records once, within the budgets; null when the file isn't there. */
function readRecords(evidenceRoot: string, runId: number): { records: LiveRecord[]; truncated: string | null } | null {
  const records: LiveRecord[] = [];
  const keys = { inKey: false };
  let from = 0, truncated: string | null = null;
  for (;;) {
    const read = readLiveWindow(evidenceRoot, runId, from, true);
    if (!read.ok) return from === 0 ? null : { records, truncated: "the step records changed while they were read" };
    for (const record of liveWindowRecords(read, keys)) {
      if (records.length >= EFFICIENCY_RECORDS) { truncated = `only the first ${EFFICIENCY_RECORDS.toLocaleString("en-US")} records were read`; break; }
      records.push(record);
    }
    if (records.some(one => one.k === "cap")) truncated ??= "the step records reached their size limit while the agent ran";
    if (truncated !== null || read.eof || read.nextOffset === from) break;
    from = read.nextOffset;
    if (from >= EFFICIENCY_READ_BYTES) { truncated = "only the first 4 MB of step records were read"; break; }
  }
  return { records, truncated };
}

/** Derive a finished run's How it ran from its records. */
export function deriveRunEfficiency(run: Run & { usageJson?: string | null }, evidenceRoot: string, now: Date): RunEfficiency {
  const finished = run.finishedAt;
  const read = readRecords(evidenceRoot, run.id);
  const steps = read !== null ? stepsOf(read.records, read.truncated)
    : finished !== null && now.getTime() - Date.parse(finished) > LIVE_RETAIN_MS ? noSteps("expired", "Step details are kept for a day after a run; this one's have expired.")
    : noSteps("absent", "No step records were kept for this run.");
  return {
    version: RUN_EFFICIENCY_VERSION,
    time: { waitMs: msBetween(run.startedAt, run.providerStartedAt), agentMs: msBetween(run.providerStartedAt, finished) },
    turns: run.agentTurns ?? null,
    usage: usageOf(run),
    steps,
  };
}

/**
 * A finished run's How it ran: the saved one when it was derived by this version, else derived now and saved (once:
 * a row whose steps were complete or have expired is final). An unfinished run is derived but never saved.
 */
export function runEfficiencyOf(store: Store, evidenceRoot: string, runId: number, now: Date): RunEfficiency | null {
  const run = store.getRun(runId);
  if (run === null) return null;
  const usageJson = store.handle.prepare("SELECT usage_json FROM run WHERE id = ?").get(runId)?.["usage_json"];
  const full = { ...run, usageJson: typeof usageJson === "string" ? usageJson : null };
  if (run.finishedAt === null) return deriveRunEfficiency(full, evidenceRoot, now);
  const saved = store.handle.prepare("SELECT parser_version, payload_json FROM run_efficiency WHERE run = ?").get(runId);
  if (saved !== undefined && Number(saved["parser_version"]) === RUN_EFFICIENCY_VERSION) {
    try { return JSON.parse(String(saved["payload_json"])) as RunEfficiency; } catch { /* derived again below */ }
  }
  const derived = deriveRunEfficiency(full, evidenceRoot, now);
  const payload = JSON.stringify(derived);
  // A row too large for its column (it can't be: the counts are bounded) is shown, never saved.
  if (payload.length <= 16_384) {
    store.handle.prepare(`INSERT INTO run_efficiency (run, parser_version, steps, steps_reason, payload_json, derived_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(run) DO UPDATE SET parser_version = excluded.parser_version, steps = excluded.steps, steps_reason = excluded.steps_reason,
        payload_json = excluded.payload_json, derived_at = excluded.derived_at`)
      .run(runId, RUN_EFFICIENCY_VERSION, derived.steps.state, derived.steps.reason, payload, now.toISOString());
  }
  return derived;
}
