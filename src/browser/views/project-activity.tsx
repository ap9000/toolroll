import type { ActivityFamily, ProjectOutcomes } from '../../project-outcomes.js';

import { activityAge as age, activityMoney as money, ACTIVITY_ACTORS as actors, activityMetrics, activityScope, activityLimit } from '../../project-activity.js';

function Tasks({ rows }: { rows: ActivityFamily[] }) {
  return rows.length === 0 ? <p className="py-2 text-muted-foreground">No tasks in this group.</p> : <ul className="divide-y divide-border">
    {rows.map(row => <li key={row.root} className="min-w-0 py-2">
      <a href={row.href} className="inline-flex min-h-11 items-center break-words text-foreground underline underline-offset-4 [overflow-wrap:anywhere]">{row.title}</a>
      <p className="text-xs text-muted-foreground">{row.actor === null ? row.state === 'ready' ? 'Ready' : 'History unavailable' : actors[row.actor]} · {row.kind} · Recorded checks: {row.checks}</p>
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
  return <details className="min-w-0 rounded-lg border border-border bg-card px-4" data-project-activity>
    <summary className="min-h-11 cursor-pointer py-3 font-semibold">Activity <span className="ml-2 break-words font-normal text-muted-foreground [overflow-wrap:anywhere]">{project}</span></summary>
    {report === null ? <div className="pb-3 text-sm"><p role="alert">Activity is unavailable.</p><a href="/projects" className="inline-flex min-h-11 items-center underline underline-offset-4">Reload</a></div> : <div className="pb-3 text-sm">
      <p className="pb-3 text-xs text-muted-foreground">{activityScope(report)}</p>
      {report.truncated && <p role="status" className="pb-3">{activityLimit(report)}</p>}
      {activityMetrics(report).map(metric => <Metric key={metric.label} {...metric} />)}
    </div>}
  </details>;
}
