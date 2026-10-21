# Heavy jobs off the busy machine — plan

Status: **v2** (2026-10-21). v1 NO-GO (4 High, 2 Medium). v2 builds only layer 1, rewritten so it can never hide a
failure; layers 2 and 3 are deferred to designs of their own (what Codex required of each is kept below).

## What and why

Laminar runs on "cattle, not pets": disposable workers, so the number of conversations and the number of computers
doing work are separate capacity decisions. Toolroll is local-first on purpose and stays so — but 2026-10-20 showed
the cost of one busy machine doing everything: the release check for b0c7a860 failed twice on **load flakes**, not
code (#3199: two `page.goto` 30 s timeouts on ordinary pages; #3200: `ECONNRESET` on an idempotent GET), on a Mac at
load ~21/24 cores with OrbStack, Docker, Spotlight and a second test run competing. The same journeys passed three
times locally on a quieter machine.

## Layer 1 (built): the release check never makes its own load

- **One concurrency budget** (`checkBudget`): three quarters of the cores, less the load already on the machine, at
  least 2; half to the unit suite's workers (`--maxWorkers`), the rest to browser lanes (app ≤ 4, flows ≤ 2) and
  upgrade workers (≤ 4). On the 2026-10-20 machine (load 21 of 24) that is one of each: slower, never stacked.
- **Two waves**: scripted journeys beside the units first; the real-model journeys after both, since they wait mostly on
  the provider. Fail-fast is unchanged: the first hard failure stops the rest.
- **A busy machine gets up to five minutes to quieten** before the check starts (load past 85% of the cores), said in
  the log; then it starts anyway with the smaller budget.
- **The load it ran under is in the summary** (start, peak, mean, the budget chosen) so a failure on a busy machine can
  be judged. It is never used to excuse one.
- **No retries.** v1's navigation and network retries are dropped: a healthy `/healthz` doesn't prove a page works, and
  a reset doesn't prove load. The keep-alive change is dropped too until the reuse failure is reproduced (Node's
  keep-alive governs idle time after a response; Tailscale Serve's backend idle timeout is 90 s).
- Load is advisory everywhere: unmeasured on Windows (it reports 0), budgeted from the cores alone there.

## Deferred: layer 2, heavy checks never stack (its own design)

Must cover every heavy path — inline verification inside a build (builder.ts), follow-up and batch checks run from
maintenance (result-follow-ups.ts, batch-checks.ts), release checks — under one atomic reservation per **physical
host** (trusted identity, not a runner name); classify from the effective check configuration; a nested check reuses
its owner's reservation; waiting returns a disposition without holding a transaction or spending the day's admission
budget (dispatch reserves a daily start before acquireIfReady today); fair ordering, fresh authenticated load samples
with hysteresis, bounded preference, ownership held until process exit is proven.

## Deferred: layer 3, a runner elsewhere (its own design)

Registration, `up` and claims are local today; a tag doesn't connect another machine. Needs authentication, repository
identity and path mapping, exact-candidate transfer, artifact transport, cancellation, partition recovery,
process-exit evidence, and the native (macOS) verification requirements kept.

## Tests

`checkBudget` arithmetic (quiet, busy, tiny machines, unmeasured load), `machineBusy`, the summary words
(src/release-check-budget.test.ts); the release check's plan output unchanged.

## Out of scope

Cloud sandboxes; moving the lead or conversations off the operator's machine.
