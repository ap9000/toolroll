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
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { LIVE_RETAIN_MS, legacyLiveLogPath, liveLogPath, liveWindowRecords } from "./live.js";
import type { LiveActivityKind, LiveRecord } from "./live-records.js";

export const RUN_EFFICIENCY_VERSION = 3;
/** Budgets for one derivation: never more than the live file's own cap, and a bounded record count. */
export const EFFICIENCY_READ_BYTES = 4 * 1024 * 1024;
export const EFFICIENCY_RECORDS = 20_000;
const LONGEST = 5;

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
  const open = new Map<string, { kind: LiveActivityKind; at: string; once: boolean }>();
  const byKind: Partial<Record<LiveActivityKind, number>> = {};
  const longest: { kind: LiveActivityKind; ms: number }[] = [];
  let total = 0, failed = 0, unknown = 0;
  for (const record of records) {
    if (record.k === "open") detail = record.detail;
    else if (record.k === "step") {
      if (record.kind === "session" || record.kind === "message") continue;
      total++;
      byKind[record.kind] = (byKind[record.kind] ?? 0) + 1;
      open.set(record.id, { kind: record.kind, at: record.at, once: record.once === true });
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
  // Repeats are never claimed: the step records keep a display form of each step (a file name, a host, a command with
  // its shell wrapper taken off), so two different steps can read alike. Said, not guessed.
  const repeatsReason = detail === "commands"
    ? "Repeats can't be told apart: the step records keep a short form of each step, not its whole input."
    : "Repeats can't be told apart: this project doesn't record step details.";
  const repeats = null;
  return { state: truncated === null ? "complete" : "truncated", reason: truncated, total, failed, unknownDuration: unknown, byKind, longest, repeats, repeatsReason };
}

const noSteps = (state: "expired" | "absent" | "truncated", reason: string): RunEfficiency["steps"] =>
  ({ state, reason, total: null, failed: null, unknownDuration: null, byKind: {}, longest: [], repeats: null, repeatsReason: null });

/** Read the run's live records once, strictly bounded: its own descriptor (no link followed, in a real live
 * directory), measured once, and never more than the budget read whatever the file does meanwhile; then parsed line by
 * line. A file over the budget, in the older text format, with lines that don't read, or cut or capped while the agent
 * ran, says its steps are incomplete. Null when there is no step file at all. */
function readRecords(evidenceRoot: string, runId: number): { records: LiveRecord[]; truncated: string | null } | { unreadable: string } | null {
  try {
    const dir = lstatSync(join(evidenceRoot, "live"));
    if (!dir.isDirectory() || dir.isSymbolicLink()) return null;
  } catch { return null; }
  let fd: number;
  try { fd = openSync(liveLogPath(evidenceRoot, runId), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { unreadable: "The step records couldn't be read." };
    // No records file: an older run's plain text file has no step detail; with neither, there is nothing.
    try { lstatSync(legacyLiveLogPath(evidenceRoot, runId)); return { unreadable: "This run's steps were recorded in an older format that has no step detail." }; }
    catch { return null; }
  }
  let text: string;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { unreadable: "The step records aren't a plain file, so they weren't read." };
    if (stat.size > EFFICIENCY_READ_BYTES) return { unreadable: "The step records are larger than they can be read here." };
    // At most what it measured, and never past the budget: growth after the measure is not read.
    const buffer = Buffer.alloc(stat.size);
    let at = 0;
    while (at < buffer.length) { const got = readSync(fd, buffer, at, buffer.length - at, at); if (got <= 0) break; at += got; }
    text = buffer.subarray(0, at).toString("utf8");
  } catch { return { unreadable: "The step records couldn't be read." }; }
  finally { closeSync(fd); }
  const lines = text.split("\n");
  // The last line may be unfinished (the agent's final write): it is read when it parses, never counted as a loss.
  const unfinished = lines.at(-1) ?? "";
  const whole = lines.slice(0, -1).filter(line => line.trim() !== "");
  if (whole.length > EFFICIENCY_RECORDS) whole.length = EFFICIENCY_RECORDS;
  const keys = { inKey: false };
  // One record per line: a whole line that doesn't read is a record lost.
  const read = liveWindowRecords({ text: whole.length === 0 ? "" : `${whole.join("\n")}\n`, format: "records" }, keys);
  const lost = whole.length - read.length;
  const records = unfinished.trim() === "" ? read : [...read, ...liveWindowRecords({ text: `${unfinished}\n`, format: "records" }, keys)];
  if (records.length === 0 && text.trim() !== "") return { unreadable: "The step records couldn't be read." };
  const truncated = lines.length - 1 > EFFICIENCY_RECORDS ? `only the first ${EFFICIENCY_RECORDS.toLocaleString("en-US")} records were read`
    : records.some(one => one.k === "cap") ? "the step records reached their size limit while the agent ran"
    : records.some(one => one.k === "cut") ? "a step record was too long to keep"
    : lost > 0 ? `${lost} step record${lost === 1 ? "" : "s"} couldn't be read`
    : null;
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
