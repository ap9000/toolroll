/**
 * The plane's own record of the machine a release check ran on (docs/plans/heavy-jobs.md, layer 1b). The check sizes
 * its budget from the load it finds (scripts/release-check.mjs checkBudget), so on a busy machine it runs on one or two
 * lanes — and ran out of its approved hour twice in one evening (runs 3311 and 3315), which read as an unexplained
 * failure a person had to re-approve.
 *
 * Two plane-side answers, never the check's own words:
 *   - the limit: a release check that starts with its budget cut to half its normal size or less gets more time, in
 *     proportion to the budget it lost, never more than twice the approved limit nor past a hard ceiling (two hours);
 *   - the evidence: the load the plane measured itself (when the check started and every 15 s while it ran), the limit
 *     it gave and why, and how long the check ran, sealed beside its receipt (CHECK_LOAD_CAPTURE). check-failure.ts reads
 *     only this record — never the check's output or report — to call a timeout under a cut budget the machine's own
 *     fault. Nothing the candidate writes can make a failure infrastructure.
 *
 * The budget arithmetic is the plane's copy of the check's (src/check-load.test.ts holds them equal), so the budget the
 * plane judges is the one the check gives itself from the same load.
 */
import { availableParallelism, loadavg } from "node:os";
import { z } from "zod";

export const CHECK_LOAD_CAPTURE = "release check load v1";

/** One reading of the machine: its cores and one-minute load (NaN where it isn't measured: Windows reports 0). */
export type MachineSample = { cores: number; load: number };
export const machineSample = (platform: NodeJS.Platform = process.platform, read: () => number[] = loadavg, cores: () => number = availableParallelism): MachineSample =>
  ({ cores: cores(), load: platform === "win32" ? Number.NaN : read()[0] ?? Number.NaN });

/** The check's budget on a quiet machine: three quarters of the cores, at least 2 (release-check.mjs checkBudget). */
export const normalFree = (cores: number): number => Math.max(2, Math.floor(cores * 0.75));
/** The check's budget under `load` (release-check.mjs checkBudget's `free`). Unmeasured load budgets from the cores. */
export const freeAt = (cores: number, load: number): number => Math.max(2, normalFree(cores) - (Number.isFinite(load) && load > 0 ? Math.floor(load) : 0));
/** Cut: the budget is at most half its normal size. Unmeasured load is never cut. */
export const budgetCut = (cores: number, load: number): boolean => Number.isFinite(load) && freeAt(cores, load) * 2 <= normalFree(cores);

/** A release check's limit never goes past this, however busy the machine. */
export const CHECK_LIMIT_CEILING_MS = 120 * 60_000;
/** …nor past this many times the approved limit. */
export const CHECK_LIMIT_MAX_FACTOR = 2;

const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`;

/**
 * The limit a release check runs under: the approved one, unless the machine's load at its start cuts the check's
 * budget to half or less — then the approved limit times normal/granted, at most twice it and never past the ceiling
 * (an approved limit already at or past the ceiling is never extended). `why` says which, in words.
 */
export function checkLimitFor(grantMs: number, sample: MachineSample): { limitMs: number; why: string } {
  const normal = normalFree(sample.cores), free = freeAt(sample.cores, sample.load);
  if (!budgetCut(sample.cores, sample.load)) {
    return { limitMs: grantMs, why: `the approved ${minutes(grantMs)}: ${Number.isFinite(sample.load) ? `load ${sample.load.toFixed(1)} on ${sample.cores} cores left the check ${free} of its normal ${normal}` : "load isn't measured here"}` };
  }
  const ceiling = Math.max(grantMs, Math.min(grantMs * CHECK_LIMIT_MAX_FACTOR, CHECK_LIMIT_CEILING_MS));
  const limitMs = Math.min(ceiling, Math.round(grantMs * normal / free));
  return { limitMs, why: `the approved ${minutes(grantMs)}${limitMs > grantMs ? `, extended to ${minutes(limitMs)}` : ", not extended (it is at the ceiling)"}: load ${sample.load.toFixed(1)} on ${sample.cores} cores left the check ${free} of its normal ${normal}, so it gets time in proportion, at most ${minutes(ceiling)}` };
}

/** When a check ends itself before its limit (release-check.mjs checkDeadline, from its start): src/check-load.test.ts
 * holds the two equal. A check that ran at least this long ran into its own limit. */
export const selfStopAfter = (limitMs: number): number => limitMs - Math.min(Math.max(3 * 60_000, Math.round(limitMs / 10)), Math.round(limitMs / 2));

/** The samples read for the budget the check started with: the check waits up to ten minutes for the load to drop
 * (release-check.mjs), so the least load in its first eleven — before its own load counts — is what it budgeted from at
 * best. The least, so a check that found a quieter moment is never called cut. */
export const CUT_WINDOW_MS = 11 * 60_000;
const SAMPLE_EVERY_MS = 15_000;
const MAX_SAMPLES = 1000;

const recordSchema = z.strictObject({
  version: z.literal(1),
  cores: z.int().min(1).max(4096),
  grantMs: z.int().min(1),
  limitMs: z.int().min(1),
  why: z.string().max(1000),
  startedAt: z.string().max(40),
  /** How long the check's last attempt ran, by the plane's clock (null: it never started). */
  elapsedMs: z.int().min(0).nullable(),
  /** Each reading, `atMs` after the check started; null where load isn't measured. */
  samples: z.array(z.strictObject({ atMs: z.int().min(0), load: z.number().min(0).nullable() })).max(MAX_SAMPLES),
});
export type CheckLoadRecord = z.infer<typeof recordSchema>;

/** A sealed record read back, or null when it isn't one (an older run has none: then nothing is excused). */
export function readCheckLoad(value: unknown): CheckLoadRecord | null {
  const read = recordSchema.safeParse(value);
  if (!read.success) return null;
  const record = read.data;
  // A limit the plane could never have given is no record at all.
  const ceiling = Math.max(record.grantMs, Math.min(record.grantMs * CHECK_LIMIT_MAX_FACTOR, CHECK_LIMIT_CEILING_MS));
  return record.limitMs < record.grantMs || record.limitMs > ceiling ? null : record;
}

/**
 * Why a release check that ran out of time did so because the machine was busy — or null. Every fact is the plane's:
 * its load readings in the first eleven minutes (the least of them) cut the check's budget to half or less, and the
 * check's last attempt ran into its own limit (at least `selfStopAfter(limitMs)`), or the plane stopped it at the limit
 * (`stoppedAtLimit`). A check with its normal budget that times out is never excused here: a real hang stays a failure.
 */
export function busyMachineTimeout(record: CheckLoadRecord | null, grantMs: number, stoppedAtLimit: boolean): string | null {
  if (record === null || record.grantMs !== grantMs) return null;
  const early = record.samples.filter(one => one.atMs <= CUT_WINDOW_MS && one.load !== null).map(one => one.load!);
  if (early.length === 0) return null;
  const least = Math.min(...early);
  if (!budgetCut(record.cores, least)) return null;
  if (!stoppedAtLimit && (record.elapsedMs === null || record.elapsedMs < selfStopAfter(record.limitMs))) return null;
  return `the machine was busy: its load stayed at ${least.toFixed(1)} or more on ${record.cores} cores as the check started, cutting its budget to ${freeAt(record.cores, least)} of its normal ${normalFree(record.cores)} cores, and it ran out of its ${minutes(record.limitMs)}`;
}

/**
 * Watches one release check: the limit at its start, the load every 15 s while it runs, and how long its last attempt
 * took. Advisory to the check itself (the limit is a plane value the check is told), and the only source of the record.
 */
export class CheckLoadWatch {
  private readonly started: number;
  private readonly samples: CheckLoadRecord["samples"] = [];
  private readonly timer: ReturnType<typeof setInterval> | null;
  private readonly cores: number;
  private attemptStart: number | null = null;
  private elapsed: number | null = null;
  readonly limitMs: number;
  readonly why: string;

  constructor(private readonly grantMs: number, private readonly options: { sample?: () => MachineSample; clock?: () => number; everyMs?: number } = {}) {
    const sample = options.sample ?? (() => machineSample());
    const clock = options.clock ?? Date.now;
    this.started = clock();
    const first = sample();
    this.cores = first.cores;
    ({ limitMs: this.limitMs, why: this.why } = checkLimitFor(grantMs, first));
    this.push(0, first.load);
    const every = options.everyMs ?? SAMPLE_EVERY_MS;
    this.timer = every > 0 ? setInterval(() => { try { this.push(clock() - this.started, sample().load); } catch { /* a missed reading */ } }, every) : null;
    this.timer?.unref?.();
  }

  private push(atMs: number, load: number): void {
    if (this.samples.length >= MAX_SAMPLES) { if (this.timer !== null) clearInterval(this.timer); return; }
    this.samples.push({ atMs: Math.max(0, Math.round(atMs)), load: Number.isFinite(load) && load >= 0 ? Math.round(load * 100) / 100 : null });
  }

  /** Around each attempt of the command: the last one's time is the record's. */
  attemptStarted(): void { this.attemptStart = (this.options.clock ?? Date.now)(); }
  attemptEnded(): void { if (this.attemptStart !== null) this.elapsed = Math.max(0, Math.round((this.options.clock ?? Date.now)() - this.attemptStart)); }

  /** Stops the readings and gives the record to seal. */
  finish(): CheckLoadRecord {
    if (this.timer !== null) clearInterval(this.timer);
    return { version: 1, cores: this.cores, grantMs: this.grantMs, limitMs: this.limitMs, why: this.why, startedAt: new Date(this.started).toISOString(), elapsedMs: this.elapsed, samples: [...this.samples] };
  }
}
