# Lessons from durable-actors

TerseAI/durable-actors runs stateful actors in regional sandbox hosts behind a control plane that owns placement,
leases and durable state. Toolroll is a much smaller thing: one machine, one SQLite plane, an `up` with a console and a
worker. Three of its ideas fit Toolroll's real failures (the 2026-10-29 deploy that stuck at "stopping" behind a stale
heartbeat for three minutes). This note says what we took, what we didn't, and sketches one idea we deferred.

## What we took

### 1. Explicit lifecycle, short heartbeat, capped leases

durable-actors' hosts report `started`, a `heartbeat` every 10 s, `draining` before shutdown and `stopped` after it
(docs/reference/configuration.md, "Host lifecycle reports"); a late heartbeat can't undo a drain, and a late drain
can't undo a stop. Host leases are capped at `MAX_HOST_LEASE_DURATION_MS` = 60 s (src/host_leases.rs).

Toolroll before this: a worker was alive while its last heartbeat was under three minutes old, and a restart could
only wait that window out (or, since ca5091e6, prove every recorded process gone). There was no word for "stopping".

Now (schema v137, `service_lifecycle`):

- A worker's registration reports `started`, bound to that registration (`registered_at`), so an older holder's report
  never describes its successor. `up`'s stop reports `draining` through the runner's own credential, with the bound
  its forced stop already enforces (`--stop-grace` + 20 s). Retiring reports `stopped` and lapses its watch leases.
- The register door: a live, non-draining holder is refused as before. A draining one is refused at once with
  "Toolroll is restarting (draining)" and when its drain ends; past that, or once stopped, the successor signs it off
  and recovers it in the same transaction. `up` waits for that end under the same name. The port is still reserved
  before registering, so two live `up`s stay impossible.
- Every claim road refuses new work for a draining runner (`claim.ts` acquire, reason `draining`).
- Heartbeats every 15 s (runner, watch leases, build/plan/scout pulses); liveness 60 s; watch leases are clamped to
  60 s in the store whatever a caller asks. Deploy health waits follow (two minutes).
- The console reports its own lifecycle (`console:<port>`). While draining, `/healthz` answers 503 `draining` at once,
  pages carry "Toolroll is restarting", and a start that finds the port held by a draining console says so.

Why: the next start should wait for a known end, not a guessed window; a caller should hear "restarting" instead of
hanging; and a crashed worker should free its projects in a minute.

### 2. Latency timelines

durable-actors records, per completed operation, ordered milestones with monotonic offsets from that operation's start
(CONTEXT.md, "Latency timeline"): not a distributed trace, just where the time went.

Toolroll keeps the same shape in `latency_timeline` (bounded: 40 milestones, 200 per kind, 14 days) for console
requests over a second (route id only: route matched, signed in, chrome and worker reads, handler done, answered),
release checks (each part's start from the sealed report and end from the check's own `took:` line, so no report
contract changes) and deploys (each journal phase and each health wait with its reason). The task page shows them
under Details as "Where the time went"; slow console requests are on `/health` for an instance operator. A check's and
a deploy's offsets are wall-clock differences (their steps run in other processes); a console request's are monotonic.

### 3. Continuous, verified copies of the state

durable-actors treats durable state as the thing that must survive any host. Toolroll's state is one SQLite file, and
until now it was copied hourly at best (and by each deploy). The worker now copies it every 5 minutes (configurable),
on a worker thread: online backup, `PRAGMA integrity_check`, sha256, atomic rename, latest verified copy recorded
(`live_backup`). Retention: newest 24 plus one a day for a week. The folder is checked before every use (plain,
private, ours, no links, outside every build-writable place). A deploy reuses the latest copy only when it provably
equals the paused database (liveness rows aside); otherwise it copies as before. Restore stays manual.

## What we didn't take

- **Regional sandbox hosts and placement.** Toolroll runs on the owner's machine (or one team server); its agents
  already run in per-run sandboxes. A placement layer would add a fleet to manage for no current need.
- **PostgreSQL, Redis, ClickHouse, GCS.** durable-actors spreads ownership, routing hints, analytics and state across
  them because it has many control-plane replicas. Toolroll has one writer process tree and one SQLite file; adding a
  server database would cost every install a service to run and back up. The lifecycle rows, timelines and copies live
  in the same SQLite file, bounded.
- **Per-session report sequences and ownership epochs in every report.** Binding a lifecycle row to the registration
  (`registered_at`) and moving it only through the credentialed doors gives the same "a late report can't undo a
  newer state" property for one machine.
- **Best-effort one-second report timeouts.** Reports are local SQLite writes in the same transaction as the decision
  they inform, so they are exact rather than best effort.

## Deferred: one writer per task or conversation

durable-actors guarantees one active host per actor: whoever holds the ownership lease is the only writer, and a
holder that loses it fences itself. Toolroll has the pieces (claims with lease generations and incarnations, run
fences, the chat queue's admission) but they are per mechanism, not one rule. Some writes to a task or a conversation
can still come from several places at once: the worker's build, a console action, the lead, a chat turn, a deploy.

Design sketch, to plan with Codex before building:

- **The actor.** A task (by task ref) and a conversation (by thread) each have at most one owner at a time: a row
  `actor_owner(actor, owner, epoch, expires_at)` taken through one door, renewed on the 15 s heartbeat, capped at 60 s.
- **The writer.** Every mutation of the actor's own state (status, run start/finish, plan revision, chat message
  append) goes through a function that takes `(actor, owner, epoch)` and refuses in the same transaction when the
  epoch is stale, as the watch lease doors do today. Console and lead actions don't take ownership; they enqueue an
  intent that the owner applies, or take a short ownership themselves when no one holds it.
- **Fencing.** A holder whose renewal fails stops writing at once (as `leaseLost` does in the watch loop), and anything
  it started is recovered by the next owner from the epoch it superseded.
- **Questions for the plan.** Which writes today bypass any owner (an inventory from the store's mutation sites)?
  Is the claim itself the task's ownership, so a task without a claim has none? How do the lead and a person's
  console action interleave without a queue for every click? What does the console show when an action waits for an
  owner, and how long may it wait (never a hang: the same "restarting" answer as above)?

Out of scope until that plan is reviewed.
