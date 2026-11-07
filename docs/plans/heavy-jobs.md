# Heavy jobs off the busy machine — plan

Status: **v2** (2026-10-21); layer 1b added 2026-11-06. v1 NO-GO (4 High, 2 Medium). v2 builds only layer 1, rewritten so it can never hide a
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
- **Two waves**: scripted journeys beside the units first; the real-model journeys in the same browser lanes once the
  scripted ones end (since 2026-10-29 no longer also after the units: pipeline-speed.md D1 — the lanes are the
  budget's either way). Fail-fast is unchanged: the first hard failure stops the rest.
- **A busy machine gets up to five minutes to quieten** before the check starts (load past 85% of the cores), said in
  the log; then it starts anyway with the smaller budget.
- **The load it ran under is in the summary** (start, peak, mean, the budget chosen) so a failure on a busy machine can
  be judged. It is never used to excuse one.
- **No retries.** v1's navigation and network retries are dropped: a healthy `/healthz` doesn't prove a page works, and
  a reset doesn't prove load. The keep-alive change is dropped too until the reuse failure is reproduced (Node's
  keep-alive governs idle time after a response; Tailscale Serve's backend idle timeout is 90 s).
- Load is advisory everywhere: unmeasured on Windows (it reports 0), budgeted from the cores alone there.

## Layer 1b (built, 2026-11-06): a busy machine gets time, and its timeout is the machine's fault

Runs 3311 (load 18.9 of 24: a budget of 2, one unit worker) and 3315 (load 15.6: a budget of 3) ran out of the approved
hour on the owner's machine and read as unexplained failures a person had to re-approve. The check's own load line
(above) still excuses nothing: it is the candidate's output. What the plane measures itself does (`src/check-load.ts`).

- **The limit scales with the budget left.** For every prepared Full check the plane reads the load as it starts the
  command. When that cuts the check's budget (the plane's copy of `checkBudget`'s arithmetic, held equal by a test) to
  half its normal size or less, the command's limit is the approved one times normal/granted, at most twice the approved
  limit and never past two hours (an approved limit already there is never extended). The handshake's `limitMs` says it,
  so the check still ends itself before it; a run note says why. The approved grant itself is unchanged: the receipt
  names it exactly.
- **The plane's load record** (`check-load.json`, capture "release check load v1") is sealed beside the receipt: the
  load at the start and every 15 s, the limit given and why, and how long the last attempt ran by the plane's clock.
- **A timeout under a cut budget is infrastructure** (`check-failure.ts`): the least load in the record's first eleven
  minutes (the check's own load later never counts; a check that found a quiet moment is never excused) cut the budget to
  half or less, and the check ran into its own limit by the plane's clock (or the plane stopped it at its limit). The
  report can only withhold this — any failing test, typecheck, upgrade, journey, signal or unowned unit error wins, and
  no report is unknown. Then the release's existing same-commit rerun handles it: at most once per incident and twice per
  candidate, under the same approval, and only a pass of the rerun itself stands.
- **A real hang stays a failure.** A timeout with a normal budget (or with no record: every older run) is unexplained, as
  before — on the first attempt or on a rerun the machine left room for; a later pass doesn't erase it.
- **A swamped machine waits longer.** The check waits up to ten minutes (five when merely busy) when the load would leave
  it a quarter of its budget or less, says how long it waited, and prints the limit the plane gave it.
- The release's wait for the check step is six hours (three attempts of up to two hours each).

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
