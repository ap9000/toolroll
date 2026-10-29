import type { ActivityFamily, ProjectOutcomes } from '../../project-outcomes.js';

const age = (ms: number | null) => ms === null ? 'Unknown' : ms < 3600000 ? `${Math.floor(ms / 60000)}m` : ms < 86400000 ? `${(ms / 3600000).toFixed(1)}h` : `${(ms / 86400000).toFixed(1)}d`;
const money = (usd: number | null) => usd === null ? 'Unknown' : `$${usd.toFixed(2)}`;
const actors = { human: 'Human', lead: 'Lead', landed: 'Automatically landed', 'machine-or-unknown': 'Machine or unknown' };
function Tasks({ rows }: { rows: ActivityFamily[] }) {
  return rows.length === 0 ? <p className="py-2 text-muted-foreground">No tasks in this group.</p> : <ul className="divide-y divide-border">
    {rows.map(row => <li key={row.root} className="min-w-0 py-2">
      <a href={row.href} className="inline-flex min-h-11 items-center break-words text-foreground underline underline-offset-4 [overflow-wrap:anywhere]">{row.title}</a>
      <p className="text-xs text-muted-foreground">{row.actor === null ? row.state === 'ready' ? 'Ready' : 'History unavailable' : actors[row.actor]} · {row.kind} · Checks: {row.checks}</p>
      {row.state === 'completed' && <p className="text-xs text-muted-foreground">{age(row.elapsedMs)} finished to decision · {row.revisions} revisions · {money(row.recordedUsd)} recorded{row.totalUsd === null ? ' · Total unknown' : ''}</p>}
    </li>)}
  </ul>;
}
function Metric({ label, value, detail, rows }: { label: string; value: string; detail: string; rows: ActivityFamily[] }) {
  return <details className="min-w-0 border-t border-border py-1">
    <summary className="min-h-11 cursor-pointer py-3 text-sm"><span className="font-medium">{label}</span><span className="ml-2">{value}</span></summary>
    <p className="pb-2 text-xs text-muted-foreground">{detail}</p><Tasks rows={rows} />
  </details>;
}
export function ProjectActivity({ project, report }: { project: string; report: ProjectOutcomes | null }) {
  const ready = report?.families.filter(one => one.state === 'ready') ?? [];
  const complete = report?.families.filter(one => one.state === 'completed') ?? [];
  return <details className="min-w-0 rounded-lg border border-border bg-card px-4" data-project-activity>
    <summary className="min-h-11 cursor-pointer py-3 font-semibold">Activity <span className="ml-2 break-words font-normal text-muted-foreground [overflow-wrap:anywhere]">{project}</span></summary>
    {report === null ? <p role="alert" className="pb-4 text-sm">Activity is unavailable. Reload to try again.</p> : <div className="pb-3 text-sm">
      <p className="pb-3 text-xs text-muted-foreground">Current Ready backlog; completions in the last {report.days} days. Completion does not mean checks passed or work deployed.</p>
      {report.truncated && <p role="status" className="pb-3">Partial report: only the {report.limit} most recently updated eligible families are included. Counts and coverage below describe this sample.</p>}
      <Metric label="Ready" value={`${report.ready.count} · Oldest ${age(report.ready.oldestFinishedAgeMs)}`} detail={`Age is measured from the latest result finishing, a proxy for Ready entry. ${report.ready.dated}/${report.ready.count} have usable timestamps.`} rows={ready} />
      <Metric label="Finished to decision" value={`${age(report.finishedToDecision.meanMs)} average`} detail={`${report.finishedToDecision.samples}/${report.completed.count} completed families have usable timestamps. Elapsed time to the saved completion decision, not human work time.`} rows={complete} />
      <Metric label="Explicit revisions" value={report.revisions.perCompletedFamily === null ? 'No completed families' : `${report.revisions.perCompletedFamily.toFixed(1)} per completed family`} detail={`${report.revisions.count} revisions across ${report.revisions.samples} completed families. Retries are attempts, not revisions.`} rows={complete} />
      <Metric label="Recorded spend" value={`${money(report.cost.recordedPerCompletedFamilyUsd)} per completed family`} detail={`${money(report.cost.recordedUsd)} recorded across ${report.cost.families} completed families. Costs known for ${report.cost.knownRuns}/${report.cost.runs} attempts; ${report.cost.fullyCostedFamilies}/${report.cost.families} families fully costed. Missing costs are unknown. All family attempts count once, including planning and retries.`} rows={complete} />
      <details className="border-t border-border py-1"><summary className="min-h-11 cursor-pointer py-3">Completed families · {report.completed.count}</summary>
        <p className="pb-2 text-xs text-muted-foreground">{Object.entries(report.completed.actors).map(([key, count]) => `${actors[key as keyof typeof actors]}: ${count}`).join(' · ')}. Scouts: {report.completed.scouts}. Failed checks: {report.completed.failedChecks}.</p><Tasks rows={complete} />
      </details>
      {report.incompleteHistory > 0 && <details className="border-t border-border"><summary className="min-h-11 cursor-pointer py-3">Incomplete history · {report.incompleteHistory}</summary><p className="pb-2 text-xs text-muted-foreground">Excluded from completion averages; their family relationships cannot be established.</p><Tasks rows={report.families.filter(one => one.state === 'history-unavailable')} /></details>}
    </div>}
  </details>;
}
