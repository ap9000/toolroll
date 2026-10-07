# Server performance

Run `toolroll health` after connecting to the server with `toolroll connect`.
An instance operator can use `--profile <name>` to select a saved connection,
or `--json` for the same measurements in a command envelope. The command reads
the running server's `/health` endpoint; it never opens the local database.
Browser operators can also open `/health` for the plain text report.

Telemetry is always collected in memory. It needs no database migration,
exporter configuration, or extra service. Recent measurements cover up to
five minutes, in ten-second slices, and start empty after a restart.
Percentiles are histogram estimates; an empty window says "no samples yet."
Long-lived SSE requests measure time to opening headers. Other requests
measure time through response completion or disconnect. Server timings start
when Node delivers the request, so a load test also measures latency at the client.

The existing authenticated, operator-only `/metrics` exporter includes:

| Metric | Meaning |
| --- | --- |
| `toolroll_http_request_duration_seconds` | Lifetime histogram, with a fixed `route` family label. |
| `toolroll_event_loop_delay_seconds` | Recent p50 and p99 delay, with `quantile="0.5"` and `"0.99"`. |
| `toolroll_event_loop_delay_samples` | Recent sample count; zero means no measurement yet. |
| `toolroll_sqlite_write_wait_seconds` | Histogram of explicit write-lock acquisition, including every retry slice and failed attempts. |
| `toolroll_sqlite_write_hold_seconds` | Histogram from acquiring an IMMEDIATE/EXCLUSIVE transaction through commit or rollback. |
| `toolroll_sqlite_write_statement_seconds` | Standalone write duration, including any native busy wait. |
| `toolroll_sse_connections` | Currently open streams by fixed stream family. |
| `toolroll_sse_queue_bytes` / `toolroll_sse_queue_max_bytes` | Total queued send bytes and the largest current per-stream queue. |
| `toolroll_sse_queue_bytes_bucket` | Gauge distribution of current per-stream queue depths, labeled by family and byte bound `le`. Each open stream contributes once. |
| `toolroll_request_budget_refusals_total` | Refusals on `api` or `mcp`, by fixed budget reason, including unavailable budget checks. |

Histograms have the usual `_bucket`, `_count`, and `_sum` series, in seconds.
For example, `histogram_quantile(0.99, sum by (route, le)
(rate(toolroll_http_request_duration_seconds_bucket[5m])))` estimates request
p99 by family. The SSE queue buckets are current gauges: do not apply `rate()`.
They measure Node's pending send buffer (`writableLength`), not events already
received by a client or a snapshot waiting for the chat coalescing timer.
Connection IDs, URLs, query strings, SQL, account names and tokens never become
performance labels.

Event-loop delay comes from `perf_hooks.monitorEventLoopDelay` with a 20 ms
sampling interval. That interval is included in the reported delay; an idle
server is near 20 ms, not zero. Native samples are folded into bounded buckets
once a second and on a health read. Sampling stops when the server closes.

SQLite measurements belong to the server's Store connection. They include
runtime calls made through its exposed native handle, but exclude startup
migrations and writes in other processes. Reentrant transactions count once.
SQLite does not expose the busy-handler portion of a standalone statement,
so its full duration has a separate metric instead of being mislabeled as lock
wait or hold time. Deferred transactions and outer savepoints also use these
statement timings; only explicit IMMEDIATE/EXCLUSIVE transactions report hold
time. No timeout, retry, commit, rollback, or authorization behavior changes.

# Synthetic team benchmark

Build the candidate, then run:

```sh
npm run build
node scripts/bench-team.mjs --engineers 5 --agents 10 > evidence/bench-team-5-10.json
node scripts/bench-team.mjs --engineers 20 --agents 50 > evidence/bench-team-20-50.json
```

The script creates a fresh, nonce-guarded scratch database for each stage under
`evidence/`, binds the actual server to loopback on an ephemeral port, waits for
all owned children to exit, then deletes the scratch database. It ignores the
caller's database and configuration selectors, forwards no provider credentials,
and accepts no database path or server URL. No model is invoked. Reports and
other journey output belong in the ignored `evidence/` folder. The script is
not part of the release check; its tiny smoke test is part of focused tests.

Each engineer has a separate read token, a draining SSE live view on a shared
conversation containing the seeded work, and paced
remote `task list` calls through the same `/api/cli` dispatcher as the CLI.
Agents simulate saved check progress through independent SQLite connections
(at most four worker threads, each hosting several logical agents). This
includes the real `run_check` upsert, but not provider work or notification
delivery. Default request budgets remain active.

| Stage | Calls per engineer per second | Writes per agent per second |
| --- | ---: | ---: |
| steady | 1 | 1 |
| busy | 4 | 10 |
| stress | 12 | 50 |

Each stage lasts 15 seconds by default and seeds 1,000 tasks plus one active
run per agent. Use `--seconds`, `--tasks`, or `--stages steady,busy,stress` to
adjust the experiment. A one-second smoke run uses `--engineers 1 --agents 1
--seconds 1 --tasks 10 --stages steady`.

The report includes client p50/p99, server event-loop delay, write waits and
holds, streams, refusals, throughput counts, and the first stage with a symptom.
Symptoms use explicit diagnostic thresholds: request p99 over 250 ms,
event-loop p99 over 100 ms, lock-wait p99 over 50 ms, failed or refused requests,
dropped offered work, or late progress writers. These thresholds are benchmark
signals, not a production capacity guarantee. The stress stage can encounter
the default 120 reads per minute per token before exhausting CPU or storage.

Client latency includes delay from the scheduled send time. At most four calls
per engineer can be outstanding; dropped work and writer scheduling misses
remain visible. Worker write timings are reported separately because server
metrics do not aggregate processes. Results describe this machine and this
synthetic workload, not WAN latency, browser rendering, provider capacity, or
the installed UI and worker build.

# Candidate measurements, 7 October 2026

Measured headlessly on macOS arm64, Node 22.22.0, 24 logical CPUs, with the
uncommitted candidate based on `b85b149fe225bc42dd95a6cf19232bdfa7bff541`.
Each stage offered load for 15 seconds; outstanding calls were then drained.
Both runs used 1,000 tasks and one shared conversation. Client latency includes
scheduling delay. Event-loop percentiles below are the server's bucket estimates.

| Engineers / agents | Stage | Client p50 (ms) | Client p99 (ms) | Event-loop p99 (ms) | Dropped calls |
| --- | --- | ---: | ---: | ---: | ---: |
| 5 / 10 | steady | 57.59 | 83.88 | 100.00 | 0 |
| 5 / 10 | busy | 283.19 | 1,001.57 | 524.03 | 0 |
| 5 / 10 | stress | 929.25 | 8,104.12 | 1,180.70 | 616 / 900 |
| 20 / 50 | steady | 422.50 | 1,381.33 | 1,082.13 | 0 |
| 20 / 50 | busy | 1,025.65 | 17,487.75 | 1,413.48 | 867 / 1,200 |
| 20 / 50 | stress | 1,059.62 | 18,826.42 | 1,383.07 | 3,286 / 3,600 |

The first observed degradation was the busy stage for 5/10 and the steady
stage for 20/50. At those points, server write-lock p99 was respectively
0.026 and 0.033 ms; independent writer lock p99 was 27.06 and 9.59 ms.
This points toward synchronous request processing and event-loop saturation
before write-lock contention or stream buffering; these timings alone do not
identify the expensive function. The heavier 20/50 stress stage also raised
server write-lock p99 to 53.41 ms.

All completed calls returned HTTP 200 with successful command results. No
transport failures or request-budget refusals occurred: the server slowed
enough that clients dropped offered work before reaching per-token limits.
The five or twenty live views remained open with zero queued send bytes at
the final snapshot in every stage. Progress writers had no database failures;
missed write schedules were 0/1/168 for 5/10 and 0/49/6,328 for 20/50 across
steady/busy/stress. These misses and dropped calls are saturation signals,
not successful work.

Full reports are saved under `evidence/bench-team-5-10.json` and
`evidence/bench-team-20-50.json`; they are ignored by Git. Scratch databases
and all owned server and writer processes were cleaned up. These are single
synthetic runs on a shared machine, not production capacity guarantees.

# Off-loop reads, 7 October 2026

A CPU profile of the busy 20/50 stage (`node --cpu-prof scripts/bench-team.mjs
--engineers 20 --agents 50 --stages busy`; forked server children inherit the
flag) put 88% of the server's main-thread CPU in remote `task list` →
`workIndexPage`: 71% executing its one large query and 17% preparing it again
on every call. Page and stream building, team snapshots (`tasksFor`, under 5%)
and write waits were minor. Server write-lock wait p99 was 3.4 ms.

The server now runs that read on worker threads (`src/read-executor.ts`). Each
worker opens the server's database file with `openStoreReadOnly` (same schema
check) and sets `PRAGMA query_only=1`. It runs the unchanged `workIndexPage`
and returns the page, or the same error class (an invalid cursor is still a
usage refusal). Token proof, project lens, history records and output
formatting stay on the main thread in `runOperateAs`; the worker receives only
the already-admitted access. `createDecisionServer` attaches the executor to
its own Store and terminates the workers on `close`. Queued and running reads
then fail once, and over 1,000 queued reads fail at once instead of growing.
A crashed worker fails only the read it held. Local CLI commands, in-memory
stores, the demo, and tests (unless `readWorkers` is given) read in-process
exactly as before; a file-backed server never silently falls back. The pool is
half the logical CPUs, at most eight, started on first use. The page statement
is also compiled once per connection and view.

Write waits were left alone, as the profile did not implicate them:
`CONCURRENT_WRITER_WAIT_MS`, transaction bodies and commit boundaries are
unchanged.

Commands, on the uncommitted candidate (base `1891248ae7992d274444b3f316d183cd7bd282e9`
plus the `toolroll/server-telemetry` diff), same machine as above:

```sh
npm run build
node scripts/bench-team.mjs --engineers 20 --agents 50 --stages busy      # before, then after
node scripts/bench-team.mjs --engineers 5 --agents 10 > evidence/after-bench-team-5-10.json
node scripts/bench-team.mjs --engineers 20 --agents 50 > evidence/after-bench-team-20-50.json
```

The "before" columns are the telemetry measurements above, except busy 20/50,
which was re-run on this base immediately before the change.

| Engineers / agents | Stage | Client p99 before → after (ms) | Event-loop p99 before → after (ms) | Dropped before → after |
| --- | --- | ---: | ---: | ---: |
| 5 / 10 | steady | 83.88 → 79.57 | 100 → 25 | 0 → 0 |
| 5 / 10 | busy | 1,001.57 → 207.08 | 524.03 → 50 | 0 → 0 |
| 5 / 10 | stress | 8,104.12 → 223.83 | 1,180.70 → 50 | 616 → 0 / 900 |
| 20 / 50 | steady | 1,381.33 → 54.79 | 1,082.13 → 50 | 0 → 0 |
| 20 / 50 | busy (re-run) | 17,468.94 → 403.80 | 1,167.07 → 100 | 854 → 0 / 1,200 |
| 20 / 50 | stress | 18,826.42 → 1,692.52 | 1,383.07 → 250 | 3,286 → 2,504 / 3,600 |

A separate busy 20/50 run after the change measured p50/p99 50.31/218.76 ms,
with none dropped. The 5/10 stress stage now reaches the default per-token
request budget (301 refusals) instead of saturating first. 20/50 stress still
saturates: it offers about 12 cores of list queries to eight workers. Server
write-lock p99 stayed under 45 ms in every stage. Independent progress writers
still missed some schedules under busy and stress load (10/187 for 5/10;
22/6,046 for 20/50); their lock-wait p99 was 9–27 ms.

Event-loop figures are bucket estimates (bounds 25/50/100/250 ms) that include the
20 ms sampling interval. Profiles and reports are under `evidence/` (ignored).
The ledger/audit, spend, evidence-pack and export routes are not moved: none
appeared in this workload's profile, which does not exercise them. Moving
them needs a profile of a workload that does.
