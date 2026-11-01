# Running unattended

The name comes from a captain's night orders — the written standing instructions left for the officer of the watch: *proceed on this course without me, and wake me under exactly these conditions.* That is the product, and it is not about the hour: it is for **long-running work that outlasts your attention** — an afternoon of errands, a weekend, or yes, a night.

Toolroll is a control plane for coding agents, optimized for the stretch where **nobody is watching**. It owns the scheduler, the attention surface — the typed queue of things waiting on a human — and an append-only event log.

It owns a deliberately small local task store, adapts richer trackers when they are already there, and owns no worktree pool, no review gate, and no agents. Those are adapters over [`beads`](https://github.com/gastownhall/beads), [`treehouse`](https://github.com/kunchenguid/treehouse), [`no-mistakes`](https://github.com/kunchenguid/no-mistakes), `claude`, and `codex`.

## Unattended is not auto-accept

Every tool in this category has a mode where the agent stops asking —
usually named something like *auto-accept*, or worse. Here the boundaries
do not loosen when you leave the room:

| An agent here can never | Enforced by |
|---|---|
| touch a default branch | builds land on `toolroll/<task>` in a leased worktree; push + PR happen only under a publication grant naming the exact repo, branch prefix, and base |
| approve its own work | approval nonces are minted only on screens that restate the digest-bound terms, and require your approver token typed again — **no LLM sits in any approval path** — and the [agent fence](security.md#what-an-agent-can-reach) keeps your remembered login, runner tokens and the database out of the agent's reach |
| act on an irreversible option | `reversible` is a schema field; irreversible choices never auto-apply, and answering one from a phone takes a second minted confirmation tap |
| see Toolroll's secrets | the [agent fence](security.md#what-an-agent-can-reach) blocks your login, runner and bot tokens, stored provider keys and project tool secrets at the operating system; other providers' keys are stripped from each agent's environment; tool secrets rest sealed in the OS keychain ([how](security.md#how-build-sessions-are-protected)) and other secrets in 0600 files, never in the database, URLs, or logs |
| spend while idle | **an LLM never polls** — the daemon does every no-judgement chore at zero token cost and wakes an agent only on a real event |
| spend without being counted | every provider spawn is stamped *before* it spends, so cost is measured, never asserted |
| guess at a judgement call | it parks a typed decision — recap, options with reversibility, recommendation, evidence — and the other eleven tasks keep going |

The whole claim is executable: one test,
[`src/unattended.slow.test.ts`](../../src/unattended.slow.test.ts), queues twelve tasks,
walks away, and comes back to pull requests.

## It survives the night, cheaply

**It survives the night, cheaply.** Work dispatches itself from a dependency graph, fails safely, and parks a *typed* decision — recap, options with reversibility, a recommendation, evidence — instead of guessing. Parking never stalls the loop; the blocked task steps aside and eleven others keep going.

And it costs nothing while idle. **An LLM never polls.** The daemon handles everything that needs no judgement — ticks, capability probes, lease reaping, CI polling, notifications — at zero token cost, and wakes an agent only on a real event. The target is a testable invariant: an eight-hour run with twelve tasks shows near-zero token spend across idle windows.

## What breaks overnight, and the answer

| Failure | Mechanism |
|---|---|
| Expired key found at 3am after 40k wasted tokens | capabilities probed *before* dispatch; gaps ranked by tasks unblocked |
| A runner dies holding a worktree | `Claim` with an immutable lease id and a fencing generation; late completions rejected |
| A build fails, then fails the same way again | typed strikes with doubling backoff; three strikes stalls the task for a person, who exits it with `task requeue` |
| You wake to five transcripts | one briefing: what ran, what is blocked, what needs deciding |

## Queueing work, and taking it

The built-in store is the fallback backend, and the commands over it are written for an agent first — because the agent is what runs them ten thousand times while you are away.

```sh
toolroll task add "migrate the payouts schema" --id schema
toolroll task add "wire the payouts API" --id api
toolroll task block api --on schema     # api waits for schema

toolroll ready --json                   # what could be dispatched now
toolroll claim schema --runner builder-1 --key dispatch-schema
toolroll heartbeat <lease>              # still working
toolroll worker release <lease>         # done holding it
```

Four properties make that loop safe to run unattended.

**Every outcome is data.** `--json` returns the same envelope from every command, failures included: `{ ok, command, reason, message }`. `reason` is a stable token — `held`, `fenced`, `unknown-task` — because prose gets reworded and anything branching on it breaks silently. The binary teaches its own surface: `contract --commands` dumps the declared command guide, and `skills get <name>` serves version-matched operating guides straight from the exact build an agent is driving — never a stale snapshot.

**Exit codes separate "no" from "broken".** `0` got it · `1` something broke · `2` bad usage · `3` ran fine, the answer is no. Losing a claim race and finding the ready set empty are correct answers, not errors, and a loop that stops on them is as wrong as one that ignores real breakage.

**Every mutation takes `--key`.** An agent whose command succeeded but whose output was lost *will* retry. With a key that retry returns the first answer instead of queueing a second task or taking a second lease. Mutations that changed nothing are never recorded, so a refusal never becomes a permanent no.

**`fenced` means stop.** A runner whose machine slept, whose lease expired, and whose task was reclaimed will be told exactly that at its next heartbeat — long before it finishes work nobody will accept. Dispatch is a compare-and-swap on `(task, lease_generation)`, enforced by the database rather than by anything the caller remembers to check.

## The unattended pass

`toolroll tick` is the loop above with nobody typing it, once per invocation:

```sh
toolroll tick --runner builder-1 --token <t> --repo ~/code/thing --max 1
```

One pass: take the ready set, skip what nobody approved, claim what is left — re-proving readiness inside the same transaction as the claim, because the world moves between a list and a take — build each task in a leased worktree on `toolroll/<task-id>`, and commit. **Tick itself never pushes** and cannot touch the default branch; pushing and opening the pull request happen only under a publication grant whose exact repository, branch prefix, and base you approved — and merging stays yours, on GitHub.

It is deliberately a pass and not a daemon: point cron at it and the fences make repetition safe — a second pass finds the first's work done and converges to `empty` (exit 3) instead of building anything twice. A broken build marks its task `failed` and the pass exits 1 even if other tasks succeeded, because exit 0 has to mean "nothing needs you". Refusals that are really a person's pending decision — a scope nobody approved, or one that changed after approval — leave the task queued and untouched.

## Advanced: a separate background builder

Normal local use does not require this section: `toolroll up` is the
product command. For a remote or split deployment, the builder loop can manage
itself as an OS service — launchd on macOS, systemd on
Linux, Task Scheduler on Windows, chosen automatically — so "set it
running" is one command, and reboots and crashes are the supervisor's
problem:

```sh
toolroll daemon install --runner builder-1 --token <runner-token> --repo ~/code/thing
toolroll daemon status      # running, as which pid, logs where
toolroll daemon logs        # the file to tail
toolroll daemon uninstall   # take it back off
```

The service restarts after a crash and after an unexpected clean exit alike
(launchd `KeepAlive`, systemd `Restart=always`, a restart loop under Task
Scheduler); `daemon install` is idempotent on a healthy running service and
really reloads a changed definition; `daemon uninstall` unloads and disables
it. `--containment observed|preferred|required` chooses how provider, setup
and check processes are bounded: a delegated cgroup v2 on Linux or a Job
Object on Windows when native, the observational tree scan otherwise —
`required` refuses to spawn rather than silently downgrading (macOS has no
native equivalent; the status says so and names the Linux route). The
contract and boundaries are in
[docs/PROCESS_CONTAINMENT.md](../PROCESS_CONTAINMENT.md).

Under the hood it runs `toolroll watch`: a work-conserving loop that
composes the same passes cron would call — but wakes on events (a decision
answered from your phone dispatches the next build in seconds), recovers
its own predecessor's mid-flight work after a crash, and spends zero tokens
while idle. The runner token lives in a 0600 file beside the database; the
service unit never carries it. Cron remains first-class if you prefer it —
`reconcile && tick ; bridge telegram` on a schedule does the same jobs at
cron's cadence, and a stray cron tick alongside a watch is safe (ordinary
claims settle the race), it just is not needed.

An honesty note for Windows: every pull request builds Toolroll on Windows
with Node 22 and runs the native Job Object containment tests there; the full
suite runs on Ubuntu (Node 22 and 24), and on macOS nightly and for every
release. Approved setup and verification commands use
Windows' native command shell. The scheduled-task definition follows the Task
Scheduler XML schema and every `schtasks` interaction is covered by scripted
tests. A physical Windows install has not yet been certified; the exact
real-provider and post-reboot checklist is in the
[Never Stuck release certification](https://github.com/ap9000/toolroll/blob/main/docs/CERTIFICATION.md).
