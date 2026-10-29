/** Read-only Activity. A completion is a saved decision, never a claim of
 * passing checks, deployment, review labor, or improved productivity. */
import { chatResultHref } from './chat-controls.js';
import type { Store } from './store.js';
import type { WorkSummaryAccess } from './work-summary.js';
import { workOutcomeRows } from './work-index.js';
import { COMPLETION_BY_PERSON, LANDED_ACTOR } from './result-completion.js';

export const ACTIVITY_DAYS = 60;
export const ACTIVITY_LIMIT = 500;
export type CompletionActor = 'human' | 'lead' | 'landed' | 'machine-or-unknown';
export type ActivityFamily = {
  root: string; task: string; title: string; run: number | null; href: string;
  state: 'ready' | 'completed' | 'history-unavailable';
  kind: string; finishedAt: string | null; completedAt: string | null;
  actor: CompletionActor | null; checks: string; revisions: number | null;
  elapsedMs: number | null; runs: number; knownCostRuns: number;
  recordedUsd: number | null; totalUsd: number | null;
};
export type ProjectOutcomes = {
  asOf: string; since: string; days: number; limit: number; truncated: boolean;
  ready: { count: number; oldestFinishedAgeMs: number | null; dated: number };
  completed: { count: number; actors: Record<CompletionActor, number>; scouts: number; failedChecks: number };
  finishedToDecision: { meanMs: number | null; samples: number };
  revisions: { count: number; perCompletedFamily: number | null; samples: number };
  cost: { recordedUsd: number | null; recordedPerCompletedFamilyUsd: number | null; runs: number; knownRuns: number; fullyCostedFamilies: number; families: number };
  incompleteHistory: number; families: ActivityFamily[];
};
const text = (value: unknown) => value == null ? null : String(value);
const duration = (from: string | null, to: string): number | null => {
  const delta = from === null ? NaN : Date.parse(to) - Date.parse(from);
  return Number.isFinite(delta) && delta >= 0 ? delta : null;
};
const actorOf = (actor: string | null, detail: string | null, byLead: boolean): CompletionActor => actor === LANDED_ACTOR ? 'landed'
  : byLead || actor?.startsWith('lead:') ? 'lead'
  : actor?.startsWith('operator:') && detail === COMPLETION_BY_PERSON ? 'human' : 'machine-or-unknown';

/** Callers supply their current authenticated ceiling. A path alone grants no access. */
export function projectOutcomes(store: Store, project: string, now: Date, access: WorkSummaryAccess): ProjectOutcomes {
  if (access.repos !== null && !access.repos.includes(project)) throw new Error('Project activity is outside your access.');
  const asOf = now.toISOString(), since = new Date(now.getTime() - ACTIVITY_DAYS * 86400000).toISOString();
  const rows = workOutcomeRows(store, now, access, project, since, ACTIVITY_LIMIT);
  const families: ActivityFamily[] = rows.slice(0, ACTIVITY_LIMIT).map(row => {
    const state = row['code'] === 'complete' ? 'completed' : row['code'] === 'ready-to-check' ? 'ready' : 'history-unavailable';
    const finishedAt = text(row['finished_at']), completedAt = text(row['checked_at']);
    const runs = Number(row['runs']), knownCostRuns = Number(row['known_runs']);
    const recordedUsd = knownCostRuns > 0 && Number.isFinite(Number(row['recorded_usd'])) ? Number(row['recorded_usd']) : null;
    const task = String(row['task_id']);
    return { root: String(row['root_id']), task, title: String(row['title']), run: row['result_id'] == null ? null : Number(row['result_id']),
      href: row['result_id'] == null ? `/t/${encodeURIComponent(task)}` : chatResultHref(task, Number(row['result_id'])), state, kind: text(row['result_role']) ?? 'unknown',
      finishedAt, completedAt, actor: state === 'completed' ? actorOf(text(row['checked_actor']), text(row['checked_detail']), Number(row['completed_by_lead']) === 1) : null,
      checks: text(row['check_status']) ?? 'not-recorded', revisions: state === 'history-unavailable' ? null : Number(row['version_count']) - 1,
      elapsedMs: duration(finishedAt, completedAt ?? asOf), runs, knownCostRuns, recordedUsd,
      totalUsd: runs > 0 && runs === knownCostRuns ? recordedUsd : null };
  });
  const ready = families.filter(one => one.state === 'ready'), completed = families.filter(one => one.state === 'completed');
  const times = completed.flatMap(one => one.elapsedMs === null ? [] : [one.elapsedMs]);
  const ages = ready.flatMap(one => one.elapsedMs === null ? [] : [one.elapsedMs]);
  const actors: Record<CompletionActor, number> = { human: 0, lead: 0, landed: 0, 'machine-or-unknown': 0 };
  for (const one of completed) actors[one.actor!]++;
  const knownRuns = completed.reduce((sum, one) => sum + one.knownCostRuns, 0);
  const recordedUsd = knownRuns === 0 ? null : completed.reduce((sum, one) => sum + (one.recordedUsd ?? 0), 0);
  const revisions = completed.reduce((sum, one) => sum + (one.revisions ?? 0), 0);
  return { asOf, since, days: ACTIVITY_DAYS, limit: ACTIVITY_LIMIT, truncated: rows.length > ACTIVITY_LIMIT,
    ready: { count: ready.length, oldestFinishedAgeMs: ages.length ? Math.max(...ages) : null, dated: ages.length },
    completed: { count: completed.length, actors, scouts: completed.filter(one => one.kind === 'scout').length, failedChecks: completed.filter(one => one.checks === 'failed').length },
    finishedToDecision: { meanMs: times.length ? times.reduce((a, b) => a + b, 0) / times.length : null, samples: times.length },
    revisions: { count: revisions, perCompletedFamily: completed.length ? revisions / completed.length : null, samples: completed.length },
    cost: { recordedUsd, recordedPerCompletedFamilyUsd: completed.length && recordedUsd !== null ? recordedUsd / completed.length : null,
      runs: completed.reduce((sum, one) => sum + one.runs, 0), knownRuns, fullyCostedFamilies: completed.filter(one => one.totalUsd !== null).length, families: completed.length },
    incompleteHistory: families.filter(one => one.state === 'history-unavailable').length, families };
}
