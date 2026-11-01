/**
 * Latency timelines (docs/plans/actors-lessons.md, from durable-actors' latency timeline): for one operation, a short
 * list of milestones, each an offset from its start, kept in the plane (latency_timeline, bounded and pruned) for:
 *
 * - console requests slower than SLOW_REQUEST_MS: route matched, signed in, chrome and worker reads, handler, render;
 * - release checks: each part's start and end, from the sealed report's start times and the check's own `took:` line;
 * - deploys: each phase, and each health wait with its reason (scripts/deploy-phases.mjs writes those).
 *
 * Milestones carry route ids, part and phase names and fixed reason words only: never a URL, a query, a body or a
 * secret. A console request's offsets are monotonic (performance.now within one process); a check's and a deploy's
 * are wall-clock offsets, since their parts run in other processes.
 */
import { performance } from "node:perf_hooks";
import type { CheckReport } from "./contracts/release-check.js";
import { latencyTimelines, MAX_MILESTONES, recordLatencyTimeline, type LatencyTimeline, type Milestone, type Store } from "./store.js";

/** A console request slower than this keeps its timeline. */
export const SLOW_REQUEST_MS = 1_000;

/** One operation's milestones as they happen, bounded (the store bounds them again when kept). */
export class Timeline {
  readonly startedAt = new Date();
  private readonly t0 = performance.now();
  readonly marks: Milestone[] = [];
  mark(name: string, detail?: string): void {
    if (this.marks.length >= MAX_MILESTONES * 2) return;
    this.marks.push({ name, ms: performance.now() - this.t0, ...(detail === undefined ? {} : { detail }) });
  }
  elapsed(): number { return performance.now() - this.t0; }
}

/** Keep a finished console request's timeline when it was slow. Best effort: a failed write never touches the answer. */
export function keepSlowRequest(store: Store, timeline: Timeline, route: string, status: number, now: Date): void {
  const total = timeline.elapsed();
  if (total < SLOW_REQUEST_MS) return;
  try {
    recordLatencyTimeline(store, { kind: "console", subject: route, startedAt: timeline.startedAt, totalMs: total,
      milestones: [...timeline.marks, { name: "answered", ms: total, detail: `status ${status}` }] }, now);
  } catch { /* display only */ }
}

const TOOK = /^(\d+(?:\.\d+)?) (s|min)$/;
/** The check's own `took:` line (scripts/release-check.mjs): each part's duration, in ms, by label. */
export function partDurations(stdout: string): Map<string, number> {
  const line = stdout.split("\n").reverse().find(one => one.startsWith("took: "));
  const durations = new Map<string, number>();
  if (line === undefined) return durations;
  for (const one of line.slice("took: ".length).split(";")[0]!.split(", ")) {
    const at = one.lastIndexOf(" ", one.lastIndexOf(" ") - 1);
    if (at < 1) continue;
    const label = one.slice(0, at), took = TOOK.exec(one.slice(at + 1));
    if (took !== null) durations.set(label, Number(took[1]) * (took[2] === "min" ? 60_000 : 1_000));
  }
  return durations;
}

/** A release check's parts as milestones: each part that started, and its end where its duration is known. */
export function checkMilestones(report: CheckReport, stdout: string): { startedAt: Date; totalMs: number; milestones: Milestone[] } | null {
  const took = partDurations(stdout);
  const started = report.parts.flatMap(part => {
    const at = part.startedAt == null ? NaN : Date.parse(part.startedAt);
    return Number.isFinite(at) ? [{ part: part.part, at, ms: took.get(part.part) ?? null }] : [];
  });
  if (started.length === 0) return null;
  const first = Math.min(...started.map(one => one.at));
  const milestones: Milestone[] = started.flatMap(one => [
    { name: `${one.part} started`, ms: one.at - first },
    ...(one.ms === null ? [] : [{ name: `${one.part} ended`, ms: one.at - first + one.ms }]),
  ]).sort((a, b) => a.ms - b.ms);
  return { startedAt: new Date(first), totalMs: Math.max(...milestones.map(one => one.ms)), milestones };
}

/** Keep a release check's timeline beside its run. Best effort: the check's outcome never depends on it. */
export function keepCheckTimeline(store: Store, args: { runId: number; taskId: string; report: CheckReport | null; stdout: string; now: Date }): void {
  if (args.report === null) return;
  try {
    const timeline = checkMilestones(args.report, args.stdout);
    if (timeline === null) return;
    recordLatencyTimeline(store, { kind: "release-check", subject: `check ${args.report.mode}`, runId: args.runId, taskId: args.taskId, ...timeline }, args.now);
  } catch { /* display only */ }
}

/** "Where the time went" on the task and run page: the run's check and the task's deploys, newest first. */
export type TimingView = { title: string; total: string; rows: { label: string; at: string; detail: string | null }[] }[];

/** 65 s → "1:05"; 3 723 s → "1:02:03". */
export function clockWords(ms: number): string {
  const seconds = Math.round(ms / 1000), h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function viewOf(one: LatencyTimeline): TimingView[number] {
  const title = one.kind === "deploy" ? `Deploy ${one.subject}` : one.kind === "release-check" ? "Release check" : `Request ${one.subject}`;
  const started = new Map<string, number>();
  return { title, total: clockWords(one.totalMs), rows: one.milestones.map(mark => {
    const part = / (started|ended)$/.exec(mark.name);
    if (part?.[1] === "started") started.set(mark.name.slice(0, -" started".length), mark.ms);
    const began = part?.[1] === "ended" ? started.get(mark.name.slice(0, -" ended".length)) : undefined;
    return { label: mark.name, at: `+${clockWords(mark.ms)}`, detail: began === undefined ? mark.detail ?? null : `took ${clockWords(mark.ms - began)}` };
  }) };
}

/** A run's check timelines and its task's deploy timelines, for the page (null: none kept). */
export function timingFor(store: Store, runId: number | null, taskId: string): TimingView | null {
  try {
    const kept = runId === null ? latencyTimelines(store, { taskId, limit: 5 }) : latencyTimelines(store, { runId, taskId, limit: 5 });
    const shown = kept.filter(one => one.kind === "deploy" || one.runId === runId);
    return shown.length === 0 ? null : shown.map(viewOf);
  } catch { return null; }
}

/** The approver's debug view beside /healthz (/health): the slowest recent console requests, one line each. */
export function slowRequestLines(store: Store, limit = 20): string[] {
  try {
    return latencyTimelines(store, { kind: "console", limit }).map(one =>
      `${one.startedAt} ${one.subject} ${Math.round(one.totalMs)} ms: ${one.milestones.map(mark => `${mark.name} +${Math.round(mark.ms)}${mark.detail === undefined ? "" : ` (${mark.detail})`}`).join(", ")}`);
  } catch { return []; }
}
