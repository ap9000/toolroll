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
import { lstatSync } from "node:fs";
import { LIVE_RETAIN_MS, legacyLiveLogPath, liveLogPath, liveWindowRecords, readLiveWindow } from "./live.js";
import { HIDDEN_TARGET, type LiveActivityKind, type LiveRecord } from "./live-records.js";

export const RUN_EFFICIENCY_VERSION = 2;
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
    // Claude's input_tokens leave out what was read from or written to the cache: the three add up to what it read, so
    // all three must be reported before a total or a share is claimed (a missing one is unknown, never zero).
    const input = num(raw["input_tokens"]), read = num(raw["cache_read_input_tokens"]), write = num(raw["cache_creation_input_tokens"]);
    const total = input === null || read === null || write === null ? null : input + read + write;
    return { ...base, in: total, cacheRead: read, cacheWrite: write, cacheShare: total === null || total === 0 ? null : read! / total };
  }
  if (run.provider === "codex") {
    // Codex's input_tokens already include what came from its cache: both reported, or no share.
    const input = num(raw["input_tokens"]), read = num(raw["cached_input_tokens"]);
    return { ...base, in: input ?? run.tokensIn ?? null, cacheRead: read, cacheWrite: null,
      cacheShare: read === null || input === null || input === 0 || read > input ? null : read / input };
  }
  return { ...base, in: run.tokensIn ?? null, cacheRead: null, cacheWrite: null, cacheShare: null };
}

/** The live records' steps, bounded: counts by kind, failures, observed times and repeats (never their words). */
/** `measured`: the recorder saw this provider's steps start and end as they happened (Claude's stream does); for the
 * others their times are partly made up (Codex reports a step when it completes, ACP agents may report late), so no
 * duration is claimed for them. */
export function stepsOf(records: Iterable<LiveRecord>, truncated: string | null, measured = true): RunEfficiency["steps"] {
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
      // Only a command's input is recorded whole (with command detail on, and not shortened: the recorder's caps end a
      // cut one with an ellipsis); every other kind keeps only a label (a file name, a host), which can't show that two
      // steps did the same thing. So repeats are counted over commands alone.
      if (record.kind !== "command") continue;
      if (target === null || target === HIDDEN_TARGET || target.endsWith("…")) comparable = false;
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
      // Not a measured time: a provider whose times the recorder can't see as they happen, a start and end made up
      // together (`once`), a step the recorder closed itself when the run ended (outcome unknown), or no time between.
      const ms = !measured || started.once || record.ok === null ? null : msBetween(started.at || null, record.at || null);
      if (ms === null || ms === 0) { unknown++; continue; }
      longest.push({ kind: started.kind, ms });
      longest.sort((a, b) => b.ms - a.ms);
      if (longest.length > LONGEST) longest.pop();
    }
  }
  // Steps that never closed (the run ended, or the file was cut) have no measured time.
  unknown += open.size;
  const repeatsReason = detail !== "commands" ? "Repeats can't be told apart: this project doesn't record step details."
    : !comparable ? "Only commands recorded in full are compared; some were shortened or hidden and aren't counted."
    : groupsFull ? `Repeats were counted over the first ${EFFICIENCY_REPEAT_GROUPS} distinct commands only.` : null;
  const repeats = detail !== "commands" ? null
    : [...groups.values()].filter(one => one.count >= REPEAT_AT).sort((a, b) => b.count - a.count).slice(0, 10);
  return { state: truncated === null ? "complete" : "truncated", reason: truncated, total, failed, unknownDuration: unknown, byKind, longest, repeats, repeatsReason };
}

const noSteps = (state: "expired" | "absent" | "truncated", reason: string): RunEfficiency["steps"] =>
  ({ state, reason, total: null, failed: null, unknownDuration: null, byKind: {}, longest: [], repeats: null, repeatsReason: null });

/** Read the run's live records once, within the budgets; null when there is no records file. The file's size is read
 * first and one larger than the budget is not read at all (the live reader's own scan past an over-long line stops at
 * the file's end, so a file within the budget bounds every read); a cut line, a size cap, a legacy text file or a file
 * with no record that reads all say the steps are incomplete. */
function readRecords(evidenceRoot: string, runId: number): { records: LiveRecord[]; truncated: string | null } | { unreadable: string } | null {
  let size: number;
  try {
    const stat = lstatSync(liveLogPath(evidenceRoot, runId));
    if (!stat.isFile()) return { unreadable: "The step records aren't a plain file, so they weren't read." };
    size = stat.size;
  } catch {
    // No records file: an older run's plain text file has no step detail; with neither, there is nothing.
    try { lstatSync(legacyLiveLogPath(evidenceRoot, runId)); return { unreadable: "This run's steps were recorded in an older format that has no step detail." }; }
    catch { return null; }
  }
  if (size > EFFICIENCY_READ_BYTES) return { unreadable: "The step records are larger than they can be read here." };
  const records: LiveRecord[] = [];
  const keys = { inKey: false };
  let from = 0, truncated: string | null = null;
  for (;;) {
    const read = readLiveWindow(evidenceRoot, runId, from, true);
    if (!read.ok) return from === 0 ? { unreadable: "The step records couldn't be read." } : { records, truncated: "the step records changed while they were read" };
    if (read.format !== "records") return { unreadable: "This run's steps were recorded in an older format that has no step detail." };
    for (const record of liveWindowRecords(read, keys)) {
      if (records.length >= EFFICIENCY_RECORDS) { truncated = `only the first ${EFFICIENCY_RECORDS.toLocaleString("en-US")} records were read`; break; }
      records.push(record);
    }
    if (records.some(one => one.k === "cap")) truncated ??= "the step records reached their size limit while the agent ran";
    if (records.some(one => one.k === "cut")) truncated ??= "a step record was too long to keep";
    if (truncated !== null || read.eof || read.nextOffset === from) break;
    if (read.nextOffset > size || read.nextOffset >= EFFICIENCY_READ_BYTES) { truncated = "the step records grew while they were read"; break; }
    from = read.nextOffset;
  }
  if (records.length === 0 && size > 0) return { unreadable: "The step records couldn't be read." };
  return { records, truncated };
}

/** Derive a finished run's How it ran from its records. */
export function deriveRunEfficiency(run: Run & { usageJson?: string | null }, evidenceRoot: string, now: Date): RunEfficiency {
  const finished = run.finishedAt;
  const read = readRecords(evidenceRoot, run.id);
  const steps = read !== null && "unreadable" in read ? noSteps("truncated", read.unreadable)
    : read !== null ? stepsOf(read.records, read.truncated, run.provider === "claude")
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
  let saved: Record<string, unknown> | undefined;
  try { saved = store.handle.prepare("SELECT parser_version, payload_json FROM run_efficiency WHERE run = ?").get(runId); } catch { saved = undefined; }
  if (saved !== undefined && Number(saved["parser_version"]) === RUN_EFFICIENCY_VERSION) {
    try { return JSON.parse(String(saved["payload_json"])) as RunEfficiency; } catch { /* derived again below */ }
  }
  const derived = deriveRunEfficiency(full, evidenceRoot, now);
  const payload = JSON.stringify(derived);
  // A row too large for its column (it can't be: the counts are bounded) is shown, never saved.
  // Saving is a convenience: a store that can't take the row (read-only, busy) still shows what was derived.
  if (payload.length <= 16_384) {
    try {
      store.handle.prepare(`INSERT INTO run_efficiency (run, parser_version, steps, steps_reason, payload_json, derived_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(run) DO UPDATE SET parser_version = excluded.parser_version, steps = excluded.steps, steps_reason = excluded.steps_reason,
          payload_json = excluded.payload_json, derived_at = excluded.derived_at`)
        .run(runId, RUN_EFFICIENCY_VERSION, derived.steps.state, derived.steps.reason, payload, now.toISOString());
    } catch { /* shown, not saved: derived again next time */ }
  }
  return derived;
}
