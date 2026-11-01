/** Shared presentation for browser and no-script Activity; facts come only
 * from projectOutcomes. No alternate counting or status interpretation. */
import type { ActivityFamily, ProjectOutcomes } from './project-outcomes.js';
export const activityAge = (ms: number | null) => ms === null ? 'Unknown' : ms < 3600000 ? `${Math.floor(ms / 60000)}m` : ms < 86400000 ? `${(ms / 3600000).toFixed(1)}h` : `${(ms / 86400000).toFixed(1)}d`;
export const activityMoney = (usd: number | null) => usd === null ? 'Unknown' : `$${usd.toFixed(2)}`;
export const ACTIVITY_ACTORS = { human: 'Human', lead: 'Lead', landed: 'Automatically landed', 'machine-or-unknown': 'Machine or unknown' };
export type ActivityMetric = { label: string; value: string; detail: string; rows: ActivityFamily[] };
export const activityScope = (report: ProjectOutcomes) => `Current Ready backlog; completions in the last ${report.days} days. Completion does not mean checks passed or work deployed.`;
export const activityLimit = (report: ProjectOutcomes) => `Partial report: only the ${report.limit} most recently updated eligible families are included. Counts and coverage below describe this sample.`;
export function activityMetrics(report: ProjectOutcomes): ActivityMetric[] {
  const ready = report.families.filter(one => one.state === 'ready');
  const complete = report.families.filter(one => one.state === 'completed');
  const metrics: ActivityMetric[] = [
    { label: 'Ready', value: report.ready.count === 0 ? '0' : `${report.ready.count} · Oldest ${activityAge(report.ready.oldestFinishedAgeMs)}`,
      detail: `Age is measured from the latest result finishing, a proxy for Ready entry. ${report.ready.dated}/${report.ready.count} have usable timestamps.`, rows: ready },
    { label: 'Finished to decision', value: report.completed.count === 0 ? 'No completed families' : `${activityAge(report.finishedToDecision.meanMs)} average`,
      detail: `${report.finishedToDecision.samples}/${report.completed.count} completed families have usable timestamps. Elapsed time to the saved completion decision, not human work time.`, rows: complete },
    { label: 'Explicit revisions', value: report.revisions.perCompletedFamily === null ? 'No completed families' : `${report.revisions.perCompletedFamily.toFixed(1)} per completed family`,
      detail: `${report.revisions.count} revisions across ${report.revisions.samples} completed families. Retries are attempts, not revisions.`, rows: complete },
    { label: 'Recorded spend', value: report.completed.count === 0 ? 'No completed families' : `${activityMoney(report.cost.recordedPerCompletedFamilyUsd)} per completed family · ${report.cost.knownRuns}/${report.cost.runs} costs known`,
      detail: `${activityMoney(report.cost.recordedUsd)} in API charges across ${report.cost.families} completed families; ${report.cost.fullyCostedFamilies}/${report.cost.families} fully costed.${report.cost.subscriptionRuns > 0 ? ` ${report.cost.subscriptionRuns} subscription runs are plan usage, not charges${report.cost.subscriptionReportedUsd === null ? '' : ` (${activityMoney(report.cost.subscriptionReportedUsd)} reported)`}.` : ''} Missing or unreported costs are unknown. All family attempts count once, including planning and retries.`, rows: complete },
    { label: 'Completed families', value: String(report.completed.count),
      detail: `${Object.entries(report.completed.actors).map(([key, count]) => `${ACTIVITY_ACTORS[key as keyof typeof ACTIVITY_ACTORS]}: ${count}`).join(' · ')}. Scouts: ${report.completed.scouts}. Failed checks: ${report.completed.failedChecks}.`, rows: complete },
    ...(report.incompleteHistory > 0 ? [{ label: 'Incomplete history', value: String(report.incompleteHistory), detail: 'Excluded from completion averages; their family relationships cannot be established.', rows: report.families.filter(one => one.state === 'history-unavailable') }] : []),
  ];
  return report.completed.count === 0 ? metrics.filter(one => one.label === 'Ready' || one.label === 'Completed families' || one.label === 'Incomplete history') : metrics;
}
