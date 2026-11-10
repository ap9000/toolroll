# One table for deployment phases

Status: plan v2, 2026-11-09. Branch `deploy-phase-table`. First of the state-machine fixes Alex chose on 2026-11-09
(order: deployment phase, how a run ended, incoming chat message, outgoing chat part, task state).
v1 went to Codex (round 1): NO-GO, 8 findings. v2 folds them in; the ledger is at the end. One Codex round is
left, kept for the build.

## Goal

A deployment journal's `phase` is one of 17 words. Today nine places each keep their own list of some of those
words, and the lists disagree at `starting`. After this change one data file names every phase and the one action a
stopped deployment at that phase calls for; every reader uses it; a journal write of an unknown word is refused; a
test with its own hand-written expectations fails when the file and the expectations part.

Nothing about what a deployment does in a normal, uninterrupted run changes. `swap()` is not edited.

## Today

| Where | List | Words |
| --- | --- | --- |
| `src/release-gate.ts:29` | `BEFORE_SWAP` | preparing, admission-paused, frozen, backup-verified, rehearsed |
| `scripts/deploy-recovery.mjs:14` | `PAUSED_BEFORE_SWAP` | admission-paused, frozen, backup-verified, rehearsed |
| `scripts/deploy-recovery.mjs:16` | `MIGRATION_STARTED` | migrating, migrated, start-failed |
| `scripts/deploy-recovery.mjs:17` | `RESTARTABLE` | stopped, backup-restored, + MIGRATION_STARTED |
| `src/deploy-rescue.ts:24` | `FORWARD_ONLY` | starting, started, healthy |
| `src/deploy-rescue.ts:25` | `FINISHED` | released, deployed |
| `src/deploy-rescue.ts:55,56` | inline | stopping, stopped, migrating, migrated, start-failed, backup-restored |
| `src/release-adapters.ts:75` | `FINISHES_FORWARD` | started, healthy |
| `src/release-adapters.ts:556` | inline (`deploymentIdle`) | preparing, released, deployed |
| `scripts/deploy-phases.mjs:470` | inline (finish) | started, healthy |
| `scripts/deploy-phases.mjs:227,228` | inline | preparing, released, deployed |
| `src/release-next.ts:68` | `deployActionOf` | built from BEFORE_SWAP, FORWARD_ONLY, two literals; any other string is "roll-back" |
| `src/staged-runtimes.ts:66` | inline | deployed (only) |
| `src/checkout-cleanup.ts:85` | inline | deployed (only) |

Writers: `save(r, "<word>")` and `save(r, r.phase)` in `scripts/deploy-phases.mjs`, `save(r, "rehearsed")` in
`scripts/deploy-browser.mjs`, the first journal object (`phase: "preparing"`, deploy-phases.mjs:332), `mark("<word>")`
in `scripts/deploy-recovery.mjs`, and `phase: "released"` in `src/release-gate.ts:163`.

The command words of `--phase` (stage, prepare, rehearse, swap, finish, recover) are a different vocabulary and are
not part of this table.

### The gap at `starting`

`swap()` journals `starting` right after `launchctl bootstrap` and then waits up to `HEALTH_WAIT_MS` for the new
service; it journals `started` or `start-failed` after. A deployment killed inside that wait leaves `starting`:

- `deployActionOf("starting")` is "forward": `settleDeployment` says "Finishing the deployment that was under way."
- `recoverDeploy` (`src/release-adapters.ts:527`) finishes forward only at `started`/`healthy`, so at `starting` it
  runs `--phase recover` instead.
- `recoverFailedDeployment("starting", …)` matches no list and returns null; `recoverJournal` prints "stopped at
  starting … New work stays paused" and reports not done.
- `rescueDeployment` at `starting` refuses with "Continue it forward with `toolroll release <branch>`", which is the
  command that just did the above.
- `finish()` itself refuses: "Unexpected finish phase: starting."

No supported command resolves it. (Read from the code and confirmed by Codex's trace; not reproduced live.)

A second, smaller hole: `deployActionOf` answers "roll-back" for any string it does not know.

## The table

One row per phase, in journal order. `action` is what the release coordinator does with a stopped deployment there.

| Phase | Action | Flags |
| --- | --- | --- |
| preparing | lift-pause | beforeSwap |
| admission-paused | lift-pause | beforeSwap, pausedBeforeSwap |
| frozen | lift-pause | beforeSwap, pausedBeforeSwap |
| backup-verified | lift-pause | beforeSwap, pausedBeforeSwap |
| rehearsed | lift-pause | beforeSwap, pausedBeforeSwap |
| stopping | roll-back | |
| stopped | roll-back | restartable |
| migrating | roll-back | migrationStarted, restartable |
| migrated | roll-back | migrationStarted, restartable |
| starting | forward | |
| started | forward | |
| healthy | forward | |
| start-failed | roll-back | migrationStarted, restartable |
| backup-restored | roll-back | restartable |
| restored | roll-back | (the roll-back road only lifts the pause here; same as today) |
| released | none | |
| deployed | none | deployed |

- Actions are exactly today's `deployActionOf` for all 17 words (`restored` stays "roll-back"; `starting` was
  already "forward"). The only change in the lookup: a string that is not in the table is "refuse", not "roll-back".
- Two separate questions, never one flag: **needs no recovery** (action "none": released, deployed) and
  **deployed** (only `deployed`). `staged-runtimes.ts` and `checkout-cleanup.ts` keep asking the second, so a
  `released` stage keeps its seven-day retention and is never taken as the installed build.
- `deploymentIdle`'s list (preparing, released, deployed) becomes a named helper `stoppedWhereNothingChanged`.

## Where the table lives: one authored file

`src/deploy-phase-data.json`: the 17 rows, nothing else.

- TypeScript: `src/deploy-phase.ts` imports it (`with { type: "json" }`, `resolveJsonModule` on; `tsc` copies it
  into `dist`), checks its shape once at load, and exports the typed helpers (`DeployPhase`, `DeployAction`,
  `deployActionOf`, `isDeployPhase`, the derived lists). Readers: `release-gate.ts`, `deploy-rescue.ts`,
  `release-next.ts`, `release-adapters.ts`, `staged-runtimes.ts`, `checkout-cleanup.ts`.
- Scripts: `scripts/deploy-phase-table.mjs` reads the same file from the source tree
  (`new URL("../src/deploy-phase-data.json", import.meta.url)`), runs the same shape check, and exports the same
  helpers. The deploy scripts always run from a full extraction of a commit or from a checkout, so `src/` is beside
  `scripts/`; no built runtime is needed, which recovery requires.
- The old exported names (`BEFORE_SWAP`, `FORWARD_ONLY`, `FINISHED`, `PAUSED_BEFORE_SWAP`, `MIGRATION_STARTED`) stay,
  derived from the table, so nothing else has to change.

The two small helper files are code, not data; a test runs both over every word and compares.

## Refusing unknown words at the write

- `save(r, phase)` in `deploy-phases.mjs` and the recovery `mark(phase)` refuse a word that is not in the table,
  before anything is written.
- `release-gate.ts` writes `released` through the typed constant.

## Closing the gap at `starting`

The resumed forward step only looks. It never stops, boots out or restores anything.

1. **`finish()` accepts `starting`.** At `starting` it first waits up to `HEALTH_WAIT_MS` for the service to run
   from the new runtime (`service(nextDist)`), the same probe `swap()` uses.
   - Up: it proves, read-only, that the live database is at the journal's new schema and that this deployment still
     owns the pause; then `r.newService = live; save(r, "started")` and finish goes on exactly as it does from
     `started` today.
   - Not up, or a proof fails: it refuses. The journal stays at `starting`; nothing was stopped or changed.
2. **`--phase recover` handles `starting` by observation only.** `recoverFailedDeployment` gains one arm: at
   `starting`, when this deployment still owns the pause (`effects.ownsPause()`) and `effects.stopProved()` says the
   service label is not loaded and no process of the previous or the new runtime remains, it goes on as from
   `start-failed` (backup first unless the previous runtime reads the result, then the previous service, then the
   pause). Otherwise it returns null as today and nothing is touched. Recovery still never stops a service: "a
   historical journal cannot authorize stopping a current service" holds.
3. **Recovery only restores from the original context.** `--phase finish` reads the installed service definition,
   which after the swap names the *new* runtime; a restore from that process would start the candidate again and call
   it the previous service. `recoverJournal`'s `restoreBackup` and `restoreService` now refuse, before touching
   anything, unless this process's installed runtime is the journal's `priorRuntime`. Today that can never fire (a
   finish process only sees `started`/`healthy`/`deployed`, where recovery does nothing); it guards the new road.
   The refusal names the command that does run from the saved definition (`--phase recover`).
4. **`recoverDeploy` (release adapter)** at a phase whose action is "forward": prove the candidate, run
   `--phase finish`. If that fails and the journal is still at `starting`, run `--phase recover` with the recorded
   commit; its answer is the result. At `started`/`healthy` a failed finish stops as today.

What a person sees after a release was killed at `starting` and they rerun `toolroll release <branch>`:

- New service healthy: the deployment finishes and the release carries on.
- New service gone (label not loaded, no processes): the previous service is put back and the pause lifted.
- New service loaded but not healthy within the wait (for example, it keeps crashing under launchd): nothing is
  stopped. The release stops and names the one manual step: stop the service (`launchctl bootout gui/<uid>/<label>`),
  then rerun. **This case stays manual on purpose in this arc.** Letting recovery stop the new service itself needs
  a proof that the loaded service is the one this deployment started; that is a separate, security-reviewed change
  and a decision for Alex.

Limits, stated in the PR:

- The fix lives in the candidate's own scripts. A deployment whose candidate predates it still ends where it does
  today (its `finish` refuses `starting`, the adapter then runs its `recover`, which returns null). Newer scripts
  are never substituted for an approved commit's own.
- With an older installed coordinator and a new candidate, `starting` still goes to `--phase recover`, which now
  rolls back when the new service is proved gone.

## What must not change

- `swap()` and every proof and journal write in an uninterrupted deployment.
- What recovery does at every phase other than `starting`.
- A historical journal never authorizes stopping a service.
- The pause is lifted only by its owner (`updateGateOwned`).
- No new way to move a journal backwards.
- Which stages `staged-runtimes.ts` keeps and which build `checkout-cleanup.ts` takes as deployed.

## Safety self-review (AGENTS.md), to be re-run on the build

- Check and write together: the resume proves service, schema and pause owner immediately before `save(r,
  "started")`; the recover arm proves pause owner and stop immediately before the first restore; restores re-prove
  the stop as today.
- Never widen implicitly: unknown word refuses; the new recover arm requires more than the existing arms
  (pause ownership), not less.
- Don't let input choose what's trusted: a journal phase picks a row of a fixed file; it cannot add an action. The
  restore context comes from the saved definition, checked against the journal, never from whichever plist is
  installed.
- Approvals: finishing forward at `starting` proves the candidate first (`proveCandidate`), as at `started`.
- Credentials: none touched.
- Tests never touch the person's real setup: fakes for launchctl, services, state folder and database.
- Prove it against the real thing: a real deployment killed at `starting` can't be staged by the suite. Say so in
  the PR.

## Tests

- `src/deploy-phase.test.ts` (new):
  - a hand-written expected table (17 words → action and each derived list written out in the test, not computed)
    compared with the data file through both helper files;
  - TypeScript helpers and script helpers agree on every word and on an unknown word ("refuse");
  - every literal phase a script or `release-gate.ts` writes is in the table, and every table word has a writer
    (scan covers `save(r, "<w>")`, `mark("<w>")`, `phase: "<w>"`);
  - `save`/`mark` refuse an unknown word without writing;
  - the JSON is in the build output the package ships.
- `src/deploy-recovery.test.ts`: existing cases unchanged; new arm at `starting`: owned + proved stopped →
  restores (compatible and incompatible); not owned → null, no restore effect called; not proved stopped → null.
- `src/deploy-coding.slow.test.ts` (the swap/finish fixture): `finish()` at `starting` in a **fresh-process
  context** (installed definition already names the candidate, `priorDist === nextDist`):
  - service up → `started` → `deployed`;
  - service never up → refusal, journal still `starting`, no `bootout`/`bootstrap` call, database and definition
    byte-identical; exit recovery in that same context restores nothing even when the service is proved gone;
  - pause owner changed, or schema not the new one → refusal before `started`;
  - a healthy replacement from another runtime beside a stale `starting` journal → nothing stopped;
  - then `recoverJournal` in the original context (saved definition): proved gone → previous service started from
    the **original** definition and runtime, pause lifted, backup restored only when incompatible.
- `src/release-adapters.test.ts`: at `starting`: candidate proof refused → stops, no script run; finish ok → ok;
  finish fails, journal still `starting` → recover runs and its answer is returned; finish refusing `starting` (an
  older candidate's script) → same road, no regression. At `started`: failed finish stops as today.
- `src/release-next.test.ts`: `deployActionOf` for all 17 + unknown + non-string; `restored` stays roll-back.
- `src/staged-runtimes.test.ts`, checkout cleanup test: a `released` stage is not "deployed" (retention unchanged).
- Guard tests and typecheck. Full suite in GitHub CI.

## Not in this arc

- Recovery stopping an unhealthy new service by itself (needs ownership proof; Alex's decision).
- Existing recovery arms (`stopped`, `migrating`, `migrated`, `start-failed`, `backup-restored`) do not check pause
  ownership before restoring a backup. Noted while reading; unchanged here; worth its own look.
- A kill between `launchctl bootstrap` and `save(r, "starting")` leaves `migrated` with the new service loaded;
  recovery refuses there as today.
- The Mac app updater's journal (`src/toolroll-update.ts` `RuntimePhase`), a different machine.
- The other four state machines.

## Size

About 250 lines changed across 9 files plus three new small files and tests. Ships alone, in its own release.

## Ledger: Codex round 1 on plan v1 (NO-GO)

| # | Sev | Finding | Answer in v2 |
| --- | --- | --- | --- |
| 1 | High | Re-running the teardown on resume can stop a healthy replacement without proving ownership | No teardown on resume. Forward resume only looks; recovery only observes exit. |
| 2 | High | A fresh `finish` process has the candidate's definition as "previous"; in-process recovery would start the candidate again | Restores refuse outside the original context; the adapter runs `--phase recover` (saved definition) instead. |
| 3 | High | Resume lacked proofs (pause owner, schema) before acting; plan's "re-observes" claim was wrong | Schema and pause owner proved before `started`; no destructive act on resume; claim removed. |
| 4 | Med | `restored` row changed routing; a shared `finished` flag would let `released` stages be pruned early | `restored` is roll-back; "needs no recovery" and "deployed" are separate. |
| 5 | Med | Two hand-kept tables are avoidable | One JSON data file read by both sides. |
| 6 | Med | A newer coordinator can't fix an older candidate's script | Stated as a limit; nothing substituted. |
| 7 | Med | Inventory missed `deploymentIdle`, `checkout-cleanup`, the first journal write, `release-gate`'s `released`, dynamic saves; derived-vs-derived test is circular | Inventory extended; writes validated at `save`/`mark`; test holds its own hand-written expectations. |
| 8 | High | Tests missed the dangerous restart cases | Fresh-process context tests, replacement beside a stale journal, proofs failing, original-runtime restoration, adapter refusal and older-script cases. Teardown-interruption cases no longer exist (no teardown). |

## Build decisions (2026-11-09)

Choices made while building that the plan did not spell out, for the build review.

| # | Decision | Why |
| --- | --- | --- |
| 1 | A word the table does not hold: the automatic settle at the start of a release refuses and names `toolroll release --recover-deploy --yes`. The explicit `--recover-deploy --yes` and `recoverDeploy`'s non-forward road still hand the journal to the deployment's own recovery script. | The coordinator is the older installed build. A newer candidate's own phase word must not strand its deployment, and the recorded commit's script knows its own phases and refuses what it can't prove. Nothing acts on an unknown word without a person's `--yes`. |
| 2 | At `starting` the candidate proof gates only the forward finish. `--phase recover` is still tried while the journal stays at `starting`, proven candidate or not. | Putting the previous service back never needed approval of the candidate. |
| 3 | No new arm in `recoverFailedDeployment`. `--phase recover` runs an async pre-step, `proveStartFailed`, that moves `starting` to `start-failed` and stops nothing. It requires: this run's runtimes, database and commit equal the journal's; the pause is this deployment's; the service is not loaded and no process of either runtime runs on this database; the staged runtime is proved to be the recorded commit; the coding backup and custody checks swap's failed-start branch makes. Anything unproved leaves `starting` and says why. | `starting` stays in no list recovery acts on: a journal alone never rolls a started service back. |
| 4 | `restoreBackup` and `restoreService` refuse unless this run's "previous runtime" equals the journal's (`priorDist === r.priorRuntime`). | A fresh process after the swap reads the installed definition, where "previous" is the candidate. Only `--phase recover --stage` reads the saved one. |
| 5 | `observeStart` (finish at `starting`) waits only while launchd has the service loaded. | Nothing starts a service launchd does not have. |
| 6 | `proveStartFailed` calls `proveStaged()` before it loads the candidate's coding module, and requires `--head` to equal the journal's candidate. | That module's code answers for its own coding agents. Cost: one clean build inside the recover run. A failure leaves `starting`. |
| 7 | The data file is `src/deploy-phase-data.json`; the scripts read it from the commit's `src/`, the runtime from `dist/` (copied by `scripts/postbuild.mjs`). One test fixture that copied only `scripts/deploy-*.mjs` into a stand-in extraction now copies the data file too. | The release extracts the whole commit, so `src/` is beside `scripts/` there. |

Left as is, and said in the pull request:

- At `starting` the new service's process ids were never recorded, so "gone" is proved by launchd not having the
  label, no process of either runtime on this database, and the coding custody check.
- A new service that is loaded but never answers is not stopped by anything here. The message names
  `launchctl bootout gui/<uid>/<label>` and the rerun. Letting recovery stop it needs proof that the loaded service
  is the one this deployment started; that is a separate decision.
- During this change's own release the coordinator is the previous build: at `starting` it runs `--phase recover`
  with the new scripts (the pre-step applies). "Finish first, then recover" starts with the release after.
- `recoverJournal` latches after a thrown refusal, so a second call in the same process does nothing (existing
  design, kept).
