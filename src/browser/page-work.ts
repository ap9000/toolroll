/**
 * The page's own behaviour, run by the app (docs/plans/task-page-in-app.md §3). A page that used to ship a page script
 * string names its behaviour as data instead (`workspace.work`), and the app runs its own version of each: nothing is
 * evaluated, and only the kinds below exist. Each behaviour takes an AbortSignal and leaves nothing behind once it is
 * aborted, which is what lets such a page change in place.
 *
 * One controller per page shown. A re-read of the same page reconciles by key: an entry that is new starts; a region
 * whose entry left stops; `answer` and `result` are never restarted and stay until the page is replaced.
 */
import { useEffect, useRef } from "react";
import type { PageWork } from "../page-work-contract.js";
import { answerWork } from "./work/answer.js";
import { regionWork } from "./work/region.js";
import { resultWork } from "./work/result.js";

const REGIONS: ReadonlySet<string> = new Set(["check-progress", "run-peek"]);
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function knownEntry(entry: unknown): entry is PageWork {
  if (!record(entry)) return false;
  if (entry["kind"] === "answer" || entry["kind"] === "result") return true;
  return entry["kind"] === "region" && typeof entry["region"] === "string" && REGIONS.has(entry["region"])
    && typeof entry["run"] === "number" && Number.isSafeInteger(entry["run"]) && entry["run"] > 0;
}
/** Work this app can run, all of it (absent is none). Anything else and the page is loaded as a document instead. */
export function knownWork(work: unknown): work is readonly PageWork[] | undefined {
  return work === undefined || (Array.isArray(work) && work.every(knownEntry));
}
export const workKey = (entry: PageWork): string => entry.kind === "region" ? `region:${entry.region}:${entry.run}` : entry.kind;

export type WorkStarter = (entry: PageWork, signal: AbortSignal) => void;
const start: WorkStarter = (entry, signal) => {
  if (entry.kind === "answer") answerWork(signal);
  else if (entry.kind === "result") resultWork(signal);
  else regionWork(entry, signal);
};

export class PageWorkController {
  private readonly running = new Map<string, AbortController>();
  private stopped = false;
  constructor(private readonly starter: WorkStarter = start) {}

  reconcile(entries: readonly PageWork[]): void {
    if (this.stopped) return;
    const wanted = new Map(entries.map(entry => [workKey(entry), entry] as const));
    for (const [key, running] of [...this.running]) {
      if (!key.startsWith("region:") || wanted.has(key)) continue;
      running.abort();
      this.running.delete(key);
    }
    for (const [key, entry] of wanted) {
      if (this.running.has(key)) continue;
      const running = new AbortController();
      this.running.set(key, running);
      // A behaviour that cannot start leaves the page as the server drew it; the others still run.
      try { this.starter(entry, running.signal); } catch { /* the page stays as drawn */ }
    }
  }

  /** The page may not run work any more (it turned into a password page on its own re-read): everything ends. */
  clear(): void {
    for (const running of this.running.values()) running.abort();
    this.running.clear();
  }

  /** The page was replaced (or the app is going): everything this page started ends, and nothing starts again. */
  stop(): void {
    this.stopped = true;
    this.clear();
  }
}

/**
 * Run the page's work for as long as that page is shown. `epoch` names the page (it moves with every in-place change);
 * `may` is asked when the page's work would start or change: false on a sensitive page, in a document that ran a page
 * script string, and on a page shown ahead of its own read (its confirmation is a new epoch, and starts then).
 */
export function usePageWork(epoch: number, work: unknown, may: () => boolean, starter?: WorkStarter): void {
  const controller = useRef<PageWorkController | null>(null);
  const allowed = useRef(may);
  allowed.current = may;
  const wanted = knownWork(work) ? JSON.stringify(work ?? []) : null;
  useEffect(() => {
    const mine = new PageWorkController(starter);
    controller.current = mine;
    return () => { mine.stop(); if (controller.current === mine) controller.current = null; };
  }, [epoch, starter]);
  useEffect(() => {
    if (!allowed.current()) { controller.current?.clear(); return; }
    // Work this app does not know (a newer server): nothing new starts; what runs keeps running.
    if (wanted === null) return;
    controller.current?.reconcile(JSON.parse(wanted) as PageWork[]);
  }, [epoch, wanted, starter]);
}
