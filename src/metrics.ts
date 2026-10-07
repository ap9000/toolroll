/**
 * `/metrics` (v104): Toolroll in the Prometheus text format, for the
 * dashboards and alerts a company already runs. Labels are small, fixed
 * sets (state, role, outcome, provider, project, destination), never a task
 * id, a person or a path, so a scrape stays cheap and says nothing private.
 */
import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { Store } from "./store.js";
import { LATENCY_BUCKETS, QUEUE_BUCKETS, STREAM_FAMILIES, type ServerTelemetry, type TimingHistogram } from "./server-telemetry.js";

type Sample = { labels?: Record<string, string>; value: number };
type Metric = { name: string; help: string; type: "gauge" | "counter"; samples: Sample[] };

const label = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
const line = (name: string, sample: Sample) => {
  const labels = Object.entries(sample.labels ?? {});
  return `${name}${labels.length === 0 ? "" : `{${labels.map(([key, value]) => `${key}="${label(value)}"`).join(",")}}`} ${Number.isFinite(sample.value) ? sample.value : 0}`;
};

/** `repos`: the projects this console serves (null: all); task, run and worker figures count only theirs. */
export function prometheusMetrics(store: Store, now: Date, repos: readonly string[] | null = null, destinations?: ReadonlyMap<string, string>): string {
  const db = store.handle;
  const inProjects = (column: string) => repos === null ? "1 = 1" : repos.length === 0 ? "1 = 0" : `${column} IN (${repos.map(() => "?").join(",")})`;
  const scoped = repos ?? [];
  const rows = (sql: string, ...args: unknown[]) => db.prepare(sql).all(...args);
  const metrics: Metric[] = [];
  const add = (name: string, help: string, type: Metric["type"], samples: Sample[]) => metrics.push({ name, help, type, samples });
  // A project's label is its folder name, told apart by a short digest when two share one.
  const names = new Map<string, number>();
  for (const repo of rows(`SELECT DISTINCT repo FROM watch_lease WHERE ${inProjects("repo")}`, ...scoped).map(row => String(row["repo"]))) names.set(basename(repo), (names.get(basename(repo)) ?? 0) + 1);
  const project = (repo: string) => (names.get(basename(repo)) ?? 0) > 1 ? `${basename(repo)}-${createHash("sha256").update(repo).digest("hex").slice(0, 6)}` : basename(repo);

  add("toolroll_tasks", "Tasks by state.", "gauge",
    rows(`SELECT t.state, COUNT(*) AS n FROM task t JOIN task_ref r ON r.external_id = t.id AND r.backend = 'built-in' WHERE ${inProjects("r.repo")} GROUP BY t.state`, ...scoped)
      .map(row => ({ labels: { state: String(row["state"]) }, value: Number(row["n"]) })));
  const runs = rows(`SELECT run.role, COALESCE(run.outcome, 'running') AS outcome, run.provider, COUNT(*) AS n,
      SUM(CASE WHEN run.finished_at IS NULL THEN 0 ELSE (julianday(run.finished_at) - julianday(run.started_at)) * 86400 END) AS seconds,
      SUM(COALESCE(run.cost_usd, 0)) AS cost
    FROM run JOIN task_ref r ON r.id = run.task_ref WHERE ${inProjects("r.repo")} GROUP BY run.role, COALESCE(run.outcome, 'running'), run.provider`, ...scoped);
  const byRun = (pick: (row: Record<string, unknown>) => number) => runs.map(row => ({ labels: { role: String(row["role"]), outcome: String(row["outcome"]), provider: String(row["provider"]) }, value: pick(row) }));
  add("toolroll_runs_total", "Agent runs, by role, outcome and provider.", "counter", byRun(row => Number(row["n"])));
  add("toolroll_run_seconds_total", "Time agent runs took, in seconds.", "counter", byRun(row => Math.round(Number(row["seconds"] ?? 0))));
  add("toolroll_spend_usd_total", "What agent runs cost, in US dollars (as providers report it).", "counter", byRun(row => Number(row["cost"] ?? 0)));
  add("toolroll_tokens_total", "Tokens agent runs used.", "counter", rows(`SELECT run.role, run.provider, SUM(COALESCE(run.tokens_in, 0)) AS tokens_in, SUM(COALESCE(run.tokens_out, 0)) AS tokens_out
      FROM run JOIN task_ref r ON r.id = run.task_ref WHERE ${inProjects("r.repo")} GROUP BY run.role, run.provider`, ...scoped).flatMap(row => [
    { labels: { role: String(row["role"]), provider: String(row["provider"]), direction: "in" }, value: Number(row["tokens_in"] ?? 0) },
    { labels: { role: String(row["role"]), provider: String(row["provider"]), direction: "out" }, value: Number(row["tokens_out"] ?? 0) },
  ]));
  add("toolroll_decisions_waiting", "Questions from agents waiting on a person.", "gauge",
    [{ value: repos === null ? store.countUnansweredScoped(null) : repos.reduce((sum, repo) => sum + store.countUnansweredScoped(repo), 0) }]);

  const chain = store.ledgerChain();
  add("toolroll_ledger_entries", "Entries in the action ledger's chain.", "gauge", [{ value: chain.entries }]);
  add("toolroll_ledger_chain_ok", "1 when the action ledger's chain verifies, 0 when it's broken.", "gauge", [{ value: chain.ok ? 1 : 0 }]);
  add("toolroll_ledger_checked_timestamp_seconds", "When the whole chain was last walked.", "gauge", chain.checkedAt === null ? [] : [{ value: Math.floor(Date.parse(chain.checkedAt) / 1000) }]);

  const head = store.ledgerHeadId();
  // Only destinations set up now, each for its current address (`destinations`: sink → target; all when not given).
  const status = store.monitoringStatus().filter(one => destinations === undefined || destinations.get(one.sink) === one.target);
  add("toolroll_monitoring_lag_entries", "Ledger entries a monitoring destination hasn't been sent yet.", "gauge", status.map(one => ({ labels: { destination: one.sink }, value: Math.max(0, head - one.through) })));
  add("toolroll_monitoring_failures", "Failed deliveries in a row, by destination.", "gauge", status.map(one => ({ labels: { destination: one.sink }, value: one.failures })));
  add("toolroll_monitoring_last_ok_timestamp_seconds", "When a destination last took a delivery.", "gauge",
    status.filter(one => one.lastOkAt !== null).map(one => ({ labels: { destination: one.sink }, value: Math.floor(Date.parse(one.lastOkAt!) / 1000) })));

  add("toolroll_worker_heartbeat_age_seconds", "Seconds since each project's worker last checked in.", "gauge",
    rows(`SELECT repo, MAX(heartbeat_at) AS at FROM watch_lease WHERE ${inProjects("repo")} GROUP BY repo`, ...scoped).map(row => ({ labels: { project: project(String(row["repo"])) }, value: Math.max(0, Math.round((now.getTime() - Date.parse(String(row["at"]))) / 1000)) })));
  add("toolroll_checkouts", "Build checkouts on disk, by state.", "gauge",
    rows(`SELECT CASE WHEN runner IS NOT NULL AND released_at IS NULL THEN 'leased' ELSE 'released' END AS state, COUNT(*) AS n FROM worktree WHERE ${inProjects("repo")} GROUP BY 1`, ...scoped).map(row => ({ labels: { state: String(row["state"]) }, value: Number(row["n"]) })));

  return `${metrics.map(metric => [`# HELP ${metric.name} ${metric.help}`, `# TYPE ${metric.name} ${metric.type}`, ...metric.samples.map(sample => line(metric.name, sample))].join("\n")).join("\n")}\n${performanceMetrics(store.telemetry)}`;
}

/** Performance labels are fixed vocabularies only, independent of the store's project labels. */
export function performanceMetrics(telemetry: ServerTelemetry): string {
  const out: string[] = [];
  const header = (name: string, help: string, type: string) => out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
  const histogram = (name: string, value: TimingHistogram, labels: Record<string, string> = {}) => {
    let cumulative = 0;
    for (const [i, n] of value.total.bins.entries()) {
      cumulative += n;
      out.push(line(`${name}_bucket`, { labels: { ...labels, le: String(LATENCY_BUCKETS[i] ?? '+Inf') }, value: cumulative }));
    }
    out.push(line(`${name}_sum`, { labels, value: value.total.sum }), line(`${name}_count`, { labels, value: value.total.count }));
  };
  header('toolroll_http_request_duration_seconds', 'Request duration; SSE measures opening headers, not stream lifetime.', 'histogram');
  for (const [route, value] of telemetry.routes) histogram('toolroll_http_request_duration_seconds', value, { route });
  for (const [name, help, value] of [
    ['toolroll_sqlite_write_wait_seconds', 'Elapsed acquisition of an explicit write lock, including failed waits and all retry slices.', telemetry.writeWait],
    ['toolroll_sqlite_write_hold_seconds', 'Time holding an explicit write transaction, through commit or rollback.', telemetry.writeHold],
    ['toolroll_sqlite_write_statement_seconds', 'Standalone write duration, including native busy waits that SQLite cannot separate.', telemetry.writeStatement],
  ] as const) { header(name, help, 'histogram'); histogram(name, value); }
  const snapshot = telemetry.snapshot();
  header('toolroll_event_loop_delay_seconds', 'Approximate event-loop delay over the last five minutes; 20 ms sampling interval.', 'gauge');
  for (const [quantile, value] of [['0.5', snapshot.eventLoop.p50Ms], ['0.99', snapshot.eventLoop.p99Ms]] as const) {
    if (value !== null) out.push(line('toolroll_event_loop_delay_seconds', { labels: { quantile }, value: value / 1000 }));
  }
  header('toolroll_event_loop_delay_samples', 'Event-loop samples in the recent window; zero means no measurement yet.', 'gauge');
  out.push(line('toolroll_event_loop_delay_samples', { value: snapshot.eventLoop.count }));
  header('toolroll_sse_connections', 'Currently open live streams.', 'gauge');
  for (const route of STREAM_FAMILIES) out.push(line('toolroll_sse_connections', { labels: { route }, value: telemetry.streamQueues(route).length }));
  header('toolroll_sse_queue_bytes', 'Bytes currently waiting to send across open streams.', 'gauge');
  header('toolroll_sse_queue_max_bytes', 'Largest current per-stream send queue.', 'gauge');
  header('toolroll_sse_queue_bytes_bucket', 'Current per-stream queue depth distribution, not a lifetime histogram; each stream contributes once.', 'gauge');
  for (const route of STREAM_FAMILIES) {
    const queues = telemetry.streamQueues(route);
    out.push(line('toolroll_sse_queue_bytes', { labels: { route }, value: queues.reduce((sum, n) => sum + n, 0) }));
    out.push(line('toolroll_sse_queue_max_bytes', { labels: { route }, value: queues.reduce((max, n) => Math.max(max, n), 0) }));
    for (const bound of [...QUEUE_BUCKETS, Infinity]) out.push(line('toolroll_sse_queue_bytes_bucket', { labels: { route, le: Number.isFinite(bound) ? String(bound) : '+Inf' }, value: queues.filter(n => n <= bound).length }));
  }
  header('toolroll_request_budget_refusals_total', 'Requests refused by the shared CLI and MCP request budget, including unavailable budget checks.', 'counter');
  for (const route of ['api', 'mcp']) for (const reason of ['read-per-minute', 'act-per-minute', 'per-day', 'unavailable']) {
    out.push(line('toolroll_request_budget_refusals_total', { labels: { route, reason }, value: telemetry.refusals.get(`${route}:${reason}`) ?? 0 }));
  }
  return `${out.join('\n')}\n`;
}
