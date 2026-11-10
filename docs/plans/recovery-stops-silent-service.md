# Recovery stops a new service that never started completely

Status: plan v2, 2026-11-09. Branch `recovery-stops-silent-service`, based on `main` at `b55c4380`.
v1 went to a read-only Codex review: NO-GO, 10 findings. v2 answers each one; the ledger is at the end (section 15).
Follows `docs/plans/deploy-phase-table.md` (PR #333), which left this one case manual on purpose.

Every statement about today's code names a file and line on `main` at `b55c4380`. Statements marked
**(inference)** were not read in the code; each says why it is believed.

## 1. The problem

A deployment that is killed while it waits for the new service leaves its journal at `starting`. When the release
runs again, it first looks for the new service, then asks the deployment's own recovery to put the previous service
back. Recovery does that only when the new service is proved gone. When launchd still has the new service loaded and
its processes never come up as a complete service, recovery stops and asks the person to run `launchctl bootout` by
hand. The owner decided the program should do that step itself once it has checked the facts in section 4.

"Never started completely" means what the code observes: `service(nextDist)` (`scripts/deploy-browser.mjs:164`–`:189`)
returns null. It returns null unless launchd reports a running pid whose command is this runtime's supervisor on this
database, with exactly one `up` child of this runtime and only this runtime's role children. It does not ask whether
the console answers. The case where the structure is complete but the console does not answer is a different case
(`started`) and is not changed here (section 14, Q7).

Where it gives up: `scripts/deploy-phases.mjs:284`, inside `proveStartFailed`. The thrown message is:

> The new service is still loaded or still has processes, so the previous one was not put back. Nothing was stopped
> and the journal stays at starting. If it is running, run the release again to finish the deployment. If it never
> answers, stop it (launchctl bootout gui/${uid}/${label}), then run the release again.

`scripts/deploy-browser.mjs:420` prints it with a `✗ ` prefix. `recoverJournal` then prints a second message for the
`starting` phase (`scripts/deploy-phases.mjs:241`). The release adapter passes the last four lines of stderr on as the
reason the release stopped (`src/release-adapters.ts:340` `tail`, used at `:543`).

## 2. Today's flow for this case

### How a journal ends up at `starting`

`swap()` (`scripts/deploy-phases.mjs:438`):

1. Stops the old service, proves it stopped, migrates, and journals `migrated` (`:443`–`:474`).
2. Builds the new definition from the saved one by replacing the runtime path, the working directory and the log
   paths (`:476`–`:477`), and writes it to `<stage>/browser.next.plist` with mode 0600 (`:478`).
3. Writes the same text to the installed definition `plist` (`:485`) and runs `launchctl bootstrap gui/<uid> <plist>`
   (`:486`–`:487`).
4. Journals `starting` (`:488`).
5. Waits up to `HEALTH_WAIT_MS` (120 s, `scripts/deploy-recovery.mjs:65`) for `service(nextDist)` to be non-null
   (`:492`–`:495`).
6. If it stays null, the same process reads the pid from `launchctl print`, collects its tree with `processTree`, runs
   `launchctl bootout gui/<uid>/<label>`, proves the tree exited, checks coding custody, and journals `start-failed`
   (`:496`–`:517`). This bootout has no proof beyond "this process bootstrapped the label up to 120 s earlier". It has
   the same late-start window as the plan below (section 7).

If the process is killed during step 5, the journal stays at `starting` and step 6 never runs.

### What the release does next

`recoverDeploy` (`src/release-adapters.ts:515`):

1. Refuses while a `deploy-browser.mjs` process for this stage still runs (`:518`–`:519`).
2. `starting` is a "forward" phase (`src/deploy-phase-data.json:12`). The adapter proves the candidate and, if that
   passes, runs `--phase finish` (`:526`–`:532`). If the candidate proof fails, it skips finish (`:533`).
3. `finish` at `starting` calls `observeStart` (`scripts/deploy-phases.mjs:558`). Before that, `loadPhase` refreshes
   the deployment's put-away reservation (`:166`), so finish is not free of writes. `observeStart` waits up to
   `HEALTH_WAIT_MS` while the label is loaded and `service(nextDist)` is null (`:538`), then refuses (`:544`). It
   writes no journal change.
4. Whether finish ran or the candidate proof failed, a journal still at `starting` goes to the recorded commit's own
   `--phase recover` (`src/release-adapters.ts:538`–`:543`). So recovery can run without any wait having happened in
   this release.

`toolroll release --recover-deploy` refuses every forward phase (`src/deploy-rescue.ts:83`–`:85`).

### What `--phase recover` does

`scripts/deploy-browser.mjs:416`–`:421`: `proveStartFailed()`, print any error, then `recoverJournal()`.

`proveStartFailed` (`scripts/deploy-phases.mjs:276`–`:299`):

1. `checkpoint()`: the journal lock is held and the run is not cancelled (`:139`, `:277`).
2. Any phase but `starting` returns false (`:278`–`:279`).
3. This run's runtimes, database and commit must equal the journal's (`:282`).
4. `proveGone()`: `serviceGone(r)` or the message in section 1 (`:284`–`:285`). `serviceGone` (`:261`–`:266`) calls
   `stopProved` (`:52`–`:57`): a non-empty set of recorded old-service pids, none running; no process of the previous
   or new runtime on this database (`leftFrom`); and `launchctl print` exits 113.
5. `proveStaged()`, coding module, coding backup, custody (`:287`–`:294`).
6. The pause is still this deployment's, and gone is proved again, with nothing awaited before the write
   (`:295`–`:296`).
7. `save(r, "start-failed")` (`:297`).

`recoverJournal` (`:195`–`:252`) then runs `recoverFailedDeployment` (`scripts/deploy-recovery.mjs:27`). At
`start-failed` it restores the verified backup when the previous runtime cannot read the migrated database
(`deploy-recovery.mjs:42`–`:46`; the live files are copied aside first, `deploy-phases.mjs:67`–`:69`), starts the
previous service (`restorePriorService`, `:303`–`:327`, which refuses a loaded label), lifts the pause and journals
`released` (`deploy-recovery.mjs:47`–`:54`). At `starting` it returns null (`:52`). In both cases it calls
`keepDeployTimeline` (`deploy-phases.mjs:238`), which is best effort: it swallows every error (`:644`–`:661`).

## 3. Who can write what this relies on

AGENTS.md says a build agent controls everything it can write and that no security decision may rest on
build-writable data (`AGENTS.md:43`–`:45`). What the code shows:

- The database and its journal files are denied to every agent (`src/agent-fence.ts:135`–`:138`).
- When the state folder is Toolroll's own (its name matches toolroll, standing-orders or nightorders), every top-level
  entry in it is denied, except the entry that holds the run's own worktree and entries that are Git repositories
  (`src/agent-fence.ts:172`–`:189`). The stage folders live under `<stateDir>/staged-upgrades/`
  (`scripts/deploy-browser.mjs:93`; `src/deploy-rescue.ts:31`). So for the default layout, the journal, the saved
  definition and `browser.next.plist` are outside every fenced agent's writable area. **(inference: no worktree is
  ever placed under `staged-upgrades/`; I did not find code that does that.)**
- `Library/LaunchAgents` is a home persistence point denied to agents (`src/agent-fence.ts:1227`, used at `:1260`).
- Not established: a state folder that is not Toolroll's own (a database in a shared folder) fences only the database
  and secret-looking names (`src/agent-fence.ts:122`–`:124`, `:188`); an operator can allow unconfined agents
  (`src/agent-fence.ts:974`); `--stage` can name any folder when the script is run by hand
  (`scripts/deploy-browser.mjs:93`); and a hand run from a worktree runs the worktree's own copy of the script.

What follows: the stop requires the placement it can check (section 4, F1). The stage's real path must be a direct
child of the real `<stateDir>/staged-upgrades`. The state folder must pass the same "Toolroll's own" test the fence
uses. The journal, `browser.next.plist` and `browser.saved.plist` must be regular files, not links. Anything else keeps
the manual message. The unconfined-agent setting and a hand run of a worktree's script are outside what this change can
check; section 6 bounds what can be stopped even then.

## 4. The facts checked

The rule the owner approved: the installed definition is identical to the one this deployment wrote, and the loaded
process is exactly this deployment's new runtime on this database. These facts implement it. If any one cannot be
read, times out, or does not match, nothing is stopped and the thrown message is today's, word for word, with one
sentence appended naming the fact (section 11).

### F1. This run is this deployment's recovery, from Toolroll's own folder

- The journal lock is held (`checkpoint`, `deploy-phases.mjs:139`), the journal is at `starting` (`:279`), and this
  run's runtimes, database and commit match the journal (`:282`).
- The update pause in the database is owned by this journal's `id` (`updateGateOwned`, as at `:283`).
- Placement (section 3): the real stage path is a direct child of the real `<stateDir>/staged-upgrades`; the state
  folder is Toolroll's own by the fence's test; the three files are regular files (`lstat`).
- The pause id is kept only in the fenced database and the fenced journals (section 3), so a fenced agent cannot read
  it to copy into a journal of its own **(inference from the fence rules above)**.

### F2. The journal names the launchd job (new field)

- `swap()` sets `r.launchd = { uid, label, plist, nextPlistSha256 }` just before writing the installed definition
  (`deploy-phases.mjs:485`); it becomes durable with `save(r, "starting")` (`:488`).
- Recovery requires `r.launchd.uid` to equal its own `userInfo().uid` (`deploy-browser.mjs:64`, not a flag), and the
  label and plist to equal this run's (`:62`–`:63`, flags or defaults).
- A journal without `r.launchd` (every deployment started before this change) keeps the manual message.

### F3. The installed definition is, byte for byte, the one this deployment wrote

- `readFileSync(plist)` equals `readFileSync(<stage>/browser.next.plist)`, its SHA-256 equals
  `r.launchd.nextPlistSha256`, and the text names `${nextDist}/cli.js`.
- This is a new function used only by the stop. `observeStart`'s `installedIsOurs` (`deploy-phases.mjs:533`–`:535`) is
  not changed and does not gain the hash requirement, so `finish` keeps accepting journals without `r.launchd`.

### F4. launchd has that definition loaded, with a running process

- `launchctl print gui/<uid>/<label>` exits 0 and, parsed strictly (section 12, T22), shows `state = running`, exactly
  one `pid = N` with N > 1, exactly one `path = <p>` with `p === plist`, and one `arguments = { ... }` block equal to
  the `ProgramArguments` of `browser.next.plist`.
- Exit 113 means not loaded; the existing path handles that. Any other status, `status: null`, a signal, a spawn
  error, a duplicate or missing field, or a mismatch keeps the manual message.
- A job loaded with no process keeps the manual message (Q3).
- The loaded environment variables are not compared. Only the file bytes on disk and the loaded path and arguments
  are.

### F5. That process has the command line of this runtime's supervisor on this database

- One `listProcesses` snapshot (`deploy-stop.mjs:18`–`:29`) gives pid, parent, start time and command for every
  process. Row N must give `commandKind(command, { dist: nextDist, database }) === "supervisor"`
  (`deploy-stop.mjs:134`–`:136`; exact runtime path, database as a whole argument, `:34`–`:49`), with parent 1.
- The same snapshot gives N's descendants by parent links, at most four levels (the depth `processTree` allows,
  `deploy-phases.mjs:616`–`:629`). An unreadable snapshot, or descendants deeper than four levels, refuses.
- argv can be written by the process itself (`deploy-stop.mjs:71`–`:75`), and parent 1 also covers orphaned
  processes. These are conditions that must hold, not proof of identity.

### F6. Runtime identities are canonical and distinct, and the previous version is not running

- `realpath` of `nextDist`, `priorDist` and `r.priorRuntime` must all be readable. The real `nextDist` must differ
  from the real previous runtimes and must lie inside the real stage folder. String inequality is not enough, because
  `commandKind` matches both spellings of a runtime (`deploy-stop.mjs:8`–`:14`).
- `leftFrom(priorDist)` and `leftFrom(r.priorRuntime)` are empty (`deploy-stop.mjs:101`–`:107`), with one row
  excused. `leftFrom` counts any command that has `up --db <database>`, so read literally it always finds the new
  service itself and the stop could never act. The excused row is a process of the observed new service's own tree
  (matched by pid and start time) whose command is exactly the new runtime's supervisor or `up` on this database.
  Every other row refuses, including a command that names this database without showing a runtime folder (for
  example `node cli.js up --db <database>` started from inside a previous runtime's folder).

### F7. The new service never started completely, as watched by this run

- For `HEALTH_WAIT_MS`, once a second, as `observeStart` does (`deploy-phases.mjs:538`): the label stays loaded with
  the same pid and path, and `service(nextDist)` stays null. The watch also ends on the clock after `HEALTH_WAIT_MS`,
  so slow checks on a busy machine do not use up the time the last checks and the act need.
- Also refuse if `http://127.0.0.1:<port>/healthz` answers `{"status":"ok"}` at any point (the check
  `restorePriorService` uses, `:317`–`:318`). This can only add refusals.
- A complete structure appearing, a new pid, or a changed path keeps the journal at `starting`. A complete structure
  gets the message "run the release again to finish the deployment".

## 5. What this does not prove

- **Who loaded the job.** A person who unloads and reloads the same installed definition by hand produces a job that
  passes every fact above. So does a definition replaced and then restored byte for byte. launchd gives no bootstrap
  identity or generation that this code reads **(inference: none is used anywhere in this repo, and the fields this
  plan parses carry none)**.
- **That the pid is the same process throughout.** Start times have one-second precision and are not instance
  identity (`deploy-stop.mjs:1`–`:3`). The repeated reads lower the chance of a reused pid; they do not rule it out.
- **That the service would never have come up.** Section 7.

Why stopping in those cases is still the act the owner approved: today's message asks the person to run
`launchctl bootout gui/<uid>/<label>` (`deploy-phases.mjs:284`) when the service is loaded and has not come up. A
person running that command checks less than this plan does: they do not compare the definition, the command line or
the database. In each case above, the job under the label is this deployment's definition, running this deployment's
new runtime on this database, and not complete. Stopping it is the same command on the same label that the message
already asks for.

## 6. What can be stopped at most, whoever wrote the journal

This is a property of the planned code. It holds whatever the journal, the stage folder and the flags say, as long as
the deploy script itself is the approved commit's (the release runs the commit's own extraction,
`src/release-adapters.ts:384`–`:394`). A hand run of a worktree's own script is not covered (section 3).

- The only act is one `launchctl bootout gui/<uid>/<label>`. `uid` is the process's own (`deploy-browser.mjs:64`), so
  the domain is always this user's GUI domain. No pid is signalled.
- It runs only when the pid launchd reports for that label has the command line of a Toolroll supervisor of some
  runtime X on some database D (`commandKind`, `deploy-stop.mjs:39`), where X and D are what this run was given.
  Nothing whose command line is not a Toolroll supervisor's can be stopped. A process can copy that command line (F5),
  so "Toolroll supervisor" here means "by its command line".
- It runs only when `service(X)` has shown no complete service structure for the whole wait and at the last check
  before the act (section 8, C6). So a service whose structure is complete is never stopped by a forged or stale
  journal.
- It also needs a live update pause in D owned by the journal's id. Without an update in progress on D there is no
  pause, and nothing is stopped.

## 7. A service that becomes complete late

The window: after the last `service(nextDist)` read (section 8, C6) there is one `launchctl print` (C7) and then the
`bootout`. A service that completes its structure inside that window, or that launchd restarts with a new pid inside
it, is stopped. The `print` re-read catches a new pid only if the restart happens before it.

`swap()`'s own failed start has the same window today, and a longer one: its last `service(nextDist)` read
(`deploy-phases.mjs:494`) is followed by `launchctl print` (`:500`), `processTree` (`:504`, several `pgrep` calls) and
`bootout` (`:507`).

What limits the harm if it happens:

- New work stays paused the whole time. The pause is installed before the swap (`deploy-phases.mjs:413`) and is lifted
  only after the previous service is restored and answers (`deploy-recovery.mjs:47`–`:54`) or after a healthy finish
  (`deploy-phases.mjs:604`). The pause blocks new work; existing leases, replies, heartbeats and task data stay
  writable (`src/desktop-update-gate.ts:24`–`:25`).
- The previous version is put back by the existing `start-failed` recovery (section 2).
- What can be lost: when the previous runtime cannot read the migrated database, the backup taken before the swap goes
  back, and the live database is copied aside first (`deploy-phases.mjs:67`–`:69`; the message names where,
  `deploy-recovery.mjs:56`). Anything the late-started service wrote is in that copy, not in the restored database.
  This is the same as for `swap()`'s failed start today.

## 8. The act

### Where

A new function in `browserDeployment`, called from `proveStartFailed` after the context check (`:282`) and only when
`serviceGone(r)` is false. When it returns, `proveStartFailed` goes on as today. No phase word is added and
`src/deploy-phase-data.json` does not change. The parsers go in a new file `scripts/deploy-launchd.mjs`.

### Bounds on every call

- Every subprocess call in this function goes through one helper: `spawnSync` with a `timeout` (10 s for `print`,
  `ps`, `pgrep` and `curl`; 75 s for `bootout`, past launchd's 60 s `ExitTimeOut`, `deploy-stop.mjs:94`), a fixed
  `PATH`, and `LC_ALL=C`.
- `service()` (`deploy-browser.mjs:164`) uses `execFileSync` with no timeout. It gains an optional runner argument;
  the stop passes the bounded helper. `swap` and `finish` keep calling it as today.
- One deadline for everything before the act: wait (120 s) + one bounded bootout (75 s) + 60 s margin, counted from
  the start of the function. No call begins after it, and a call's own timeout is cut to the time left. The loop, the
  start of C, the listing and the last structure read check it. The act begins only if a whole bounded bootout
  (75 s) still fits. After the act, absence is watched for its own 75 s.
- Interruption: every call here is synchronous, so a stop signal is only seen after a turn of the event loop. The
  function takes one such turn, then checks the lock and the signal, at the end of A, at the start of C, and after
  the last `launchctl print`. Nothing is read between that last check and the bootout.
- A timeout, a signal, `status: null`, a spawn error, or a `print` status other than 0 or 113 is **uncertain**: the
  intent is kept, nothing is restored, and a plain message is printed (section 11).

### Order

A. Read F1–F7, including the wait. Take one `listProcesses` snapshot and form the observed set: N and every
   descendant, each as `{ pid, start }`. An unreadable snapshot or an incomplete tree (deeper than four levels)
   refuses here, before anything is written.

B. Write the intent. Re-read the journal and require it to equal `r` (as `removeGate` does,
   `deploy-phases.mjs:230`–`:231`). Set
   `r.newServiceStop = { state: "requested", at, label, pids: [{ pid, start }, ...], attempts: n }` and a milestone,
   and write it with `oldRt.update.durableJson` (as `mark` does, `:236`; not `save`, because the phase does not
   change). A failed write stops here with nothing done.

C. Last checks, in this order, each bounded:
   1. F3: definition bytes and hash.
   2. F1: the pause is still owned (one read-only database read).
   3. F6: canonical runtimes, and no previous-runtime process.
   4. A new `listProcesses` snapshot: N's descendants are a subset of the recorded set. A new process refuses; it may
      be the structure completing.
   5. `curl /healthz` does not answer ok.
   6. `service(nextDist)` is null. This is the last structure read.
   7. `launchctl print` once more: same pid, `state = running`, same path and arguments. This is the last read.
   8. No read: the lock and the stop signal are checked after one turn of the event loop, and a whole bounded
      bootout must still fit before the deadline.

   Any failure: set `state: "failed"`, `acted: false`, with the reason, write the journal, keep the manual message.
   An interruption is recorded the same way (reason "recovery was interrupted") and ends the run.

D. `launchctl bootout gui/${uid}/${label}`, bounded.

### Proving absence

E. Exit status 0: go to F. A numeric non-zero status: set `state: "failed"`, `acted: true`, with the status and a
   fixed short reason (never raw stderr), write the journal, print the message, and stop. Do not look for absence in
   this run (Q4). A timeout, signal or spawn error: `state: "uncertain"`, same handling.

F. Wait for absence, observed, for at most 75 s after the act:
   - poll `launchctl print` until it exits 113;
   - every recorded `{ pid, start }` is gone: no process has that pid with that start time. A pid now held by a
     process with a different start time counts as gone, because the recorded process has exited. The same start
     time counts as still running;
   - `leftFrom(nextDist)`, `leftFrom(priorDist)` and `leftFrom(r.priorRuntime)` are empty;
   - the installed definition still equals F3;
   - `serviceGone(r)`.

G. All hold: `state: "stopped"`, milestone, write the journal, return. `proveStartFailed` continues and journals
   `start-failed`; `recoverJournal` restores.

H. Any fails or times out: `state: "uncertain"` with what was left, write the journal, print the message. The journal
   stays at `starting`.

### Intent states and what a later run does

| State | Meaning | A later run |
| --- | --- | --- |
| `requested` | Written in step B. The act may or may not have run (crash after B, crash after D, or the outcome write failed). | Treat as uncertain. |
| `failed`, `acted: false` | A last check failed. Nothing was stopped. | Full fresh proof (A–C) before any new act. |
| `failed`, `acted: true` | `bootout` returned a non-zero status. It may have had partial effect. | Treat as uncertain. |
| `uncertain` | Timeout, signal, spawn error, or absence not proved. | See below. |
| `stopped` | Absence was proved. | Continue as today to `start-failed`. |

In every state the recorded pid set stays in the journal. Every later absence proof (the new step's, and `serviceGone`
whenever `r.newServiceStop` exists) requires each recorded `{ pid, start }` to be gone. The set is only ever a list of
processes that must have exited. It never permits a signal and never permits a `bootout`.

From `requested`, `uncertain` or `failed`:

- If the label is not loaded: no act. The existing path runs, with the recorded set added to its absence proof.
- If the label is loaded: a new act needs a full fresh proof, including the full wait, and a new step B that keeps the
  old recorded pids alongside the new ones. The existing record alone never permits running `bootout` again.

Writing `r.launchd` in `swap()` and adding obligations to `serviceGone` can only make recovery refuse more.

### Journal and timeline

- `r.newServiceStop` holds the state, time, label, recorded pids with start times, attempt count, and a fixed short
  reason or exit status. No environment and no raw command output.
- Milestones go through `noteMilestone` (bounded at 40, `deploy-phases.mjs:634`–`:640`). They reach the database
  through `keepDeployTimeline` in `recoverJournal` (`:238`), which is best effort.

## 9. Exclusion: what stops a second actor, and what does not

- The deployment lock locks one journal's file: `<journal>.lock.sqlite` beside it, held by `BEGIN EXCLUSIVE`
  (`src/deploy-lock.ts:13`–`:36`). It is taken once and held for the whole run (`scripts/deploy-browser.mjs:98`–`:104`).
  Another stage has another lock. It is not a lock on the label or on the database.
- A second Toolroll deployment or update on the same database cannot start while this pause exists. Every updater
  installs the same per-database pause, and a second install refuses (`src/desktop-update-gate.ts:31`; installers at
  `scripts/deploy-phases.mjs:413`, `src/toolroll-update.ts:841`, `:1176`, `:1180`, `src/desktop-update.ts:589`,
  `:618`). F1 checks the pause is this journal's.
- Not stopped by anything here: a deployment on a different database that uses the same label (it has its own pause),
  and a person or another program loading the label by hand. Neither takes the lock or the pause.
- Added: the `launchctl print` re-read as the last step before the act (section 8, C7). What remains: a load under
  the same label between that `print` and the `bootout`. launchd offers no compare-and-swap for `bootout`. A load with
  different bytes is caught after the act by step F (definition check), so nothing is restored over it. A load with
  identical bytes cannot be told apart (section 5).

## 10. What must not happen

- No process is signalled by pid. No `kill`, `pkill` or `killall`. The only act is `launchctl bootout` of the
  journal's label in the process's own GUI domain.
- Nothing is stopped by name or pattern.
- Nothing is stopped when any fact in section 4 fails, including: another definition loaded under the label, a
  definition written since the swap, the previous runtime's supervisor, this runtime on another database (including
  one whose path only begins with this one's), a job with no process, a complete structure, or a new runtime that is
  the previous one through a link.
- Nothing is stopped at any phase but `starting`. `swap`, `finish`, `observeStart`, `recoverJournal`,
  `restorePriorService`, `stopServiceProcesses` and the release gate gain no power to stop anything.
- `finish` keeps its contract: `installedIsOurs` is unchanged and does not require `r.launchd`.
- The release gate (`src/release-gate.ts:33`) adds `launchd` and `newServiceStop` to `SWAP_FIELDS`, so a journal that
  claims a pre-swap phase but carries them is refused as contradictory (`:107`–`:108`). This only adds refusals.
- `launchctl disable` and `enable` are not used (`docs/plans/deploy-phase-table.md:284`–`:287`).

## 11. Messages

Proof failed (today's message, unchanged, plus one sentence):

> The new service is still loaded or still has processes, so the previous one was not put back. Nothing was stopped
> and the journal stays at starting. If it is running, run the release again to finish the deployment. If it never
> answers, stop it (launchctl bootout gui/501/com.toolroll.browser), then run the release again. Recovery did not
> stop it itself because the installed service definition is not the one this deployment installed.

One fixed reason per fact, for example: "the deployment journal does not name this service"; "the deployment folder
is not in Toolroll's own folder"; "launchd's loaded job is not this deployment's definition"; "launchd shows no
running process for the service"; "the running process is not the new runtime's service on this database"; "the new
and previous runtimes are the same folder"; "a process of the previous version is still running"; "new work is no
longer paused by this deployment"; "the service changed while recovery was checking it".

Structure completed during the wait:

> The new service started all its processes while recovery was waiting. Nothing was stopped and the journal stays at
> starting. Run the release again to finish the deployment.

Progress lines (through `say`):

> Stopping the new service: it is loaded but has not started all its processes for 120 seconds (process 12345).

> Stopped the new service. Putting the previous version back.

Stop returned an error:

> launchctl bootout returned an error (exit 5), so it is not known whether the new service stopped. Recovery did
> nothing more and the journal stays at starting. Run the release again: it checks again before doing anything.

Uncertain (timeout, signal, or absence not proved):

> The new service was asked to stop, but it is not proved stopped (process 12345 is still running). Nothing was put
> back and the journal stays at starting. Run the release again once it has stopped.

UI: the release stops with the last four lines of stderr as its reason (`src/release-adapters.ts:340`, `:342`). Each
message is one line. How the release card shows that reason was not checked **(inference)**; no UI change is planned.
`src/deploy-rescue.ts` does not change.

## 12. Tests

### How deploy tests fake launchd today

`src/deploy-coding.slow.test.ts` (run by `npm run test:slow`, `package.json:11`; excluded from `npm test`, `:10`):
`deployment()` (`:174`–`:306`) builds a temp root with its own database, stage, plist and runtimes, and passes fakes to
`browserDeployment`. `services` (`:193`–`:207`) holds `old`, `new` and `failed` processes made with `fakePid`. The fake
`spawnSync` (`:246`–`:268`) answers `launchctl bootout`, `bootstrap`, `print`, `pgrep -P` and `curl`; anything else
returns status 1. `asFinish()` and `asRecover()` (`:288`–`:289`) run a phase as its own process would.
`killedAtStarting()` (`:1000`) and `failedStart()` (`:1154`) set up the two journals. The fixture mocks
`verifyServiceStopped` (`:238`).

`test/attacks/commit-extract.test.ts:127`–`:130` copies every `scripts/deploy-*.mjs` and `src/deploy-phase-data.json`.
A new `scripts/deploy-launchd.mjs` matches that pattern. Any new fixture that copies the deploy scripts must copy the
data file too (`scripts/deploy-phase-table.mjs:36`).

No test calls the real `launchctl`, uses the real `~/Library/LaunchAgents` or `~/.config/standing-orders`, uses port
4180 for real, or installs a login item. The label and port appear only as strings given to fakes. New tests set their
own `HOME` and `XDG_CONFIG_HOME` to the temp root. The fixture's stage moves under `<root>/staged-upgrades/` so the
placement fact (F1) holds, and the temp root's name passes the "Toolroll's own" test.

### Fixture changes

- `print` prints `path` and an `arguments` block from the definition that was bootstrapped (kept in `services` at
  bootstrap), so the loaded job can differ from the file on disk.
- `ps -A -ww -o pid=,ppid=,lstart=,command=` returns a listing built from `services`, so the real `listProcesses`,
  `serviceProcesses` and `serviceStopper` run on it. Some cases use the real `serviceStopper` with this listing
  instead of the mock, so the real exit proof is exercised without real processes.
- Hooks on `print`, `ps`, `bootout` and `curl` for: a status, `status: null` with a signal, a spawn error, a timeout,
  a changed answer on the k-th call, and a side effect at a chosen moment.
- A hook on `durableJson` that fails a chosen write.

### Cases

- **T1. Proved case.** Stops once, then `start-failed`, `bootstrap previous while paused`, `healthz while paused`,
  `released`. `r.newServiceStop.state === "stopped"` with the recorded pids. Replaces the first half of the test at
  `:1060`.
- **T2. Each single failed fact** leaves everything untouched: no `bootout`, `bootstrap` or `healthz`; database bytes
  and definition unchanged; journal `starting`; today's message plus the fact. Rows: no `r.launchd`; journal uid,
  label or plist differs; a different domain uid; stage outside `staged-upgrades`; stage, journal or definition is a
  link; state folder not Toolroll's own; definition changed; `browser.next.plist` missing; hash differs; `print` exit
  other than 0 or 113; no pid; two pid lines; no `path`; another path; arguments differ while the disk bytes are
  unchanged; `ps` unreadable; argv of the previous runtime; this runtime on another database; on a database whose
  path only begins with this one's; parent not 1; pause not this journal's; `nextDist` and `priorDist` the same
  folder through a link; a runtime path whose `realpath` fails; a previous-runtime process present; `/healthz`
  answers ok.
- **T3. Structure completes during the wait:** no `bootout`, journal `starting`. A later `finish` reaches `started`.
- **T4. Structure completes at the last check** (C6), or a new child appears (C4): no `bootout`; `state: "failed"`,
  `acted: false`.
- **T5. Supervisor restarted with a new pid** during the wait, or between C6 and C7: no `bootout`.
- **T6. Another deployment's job** loaded under the label (different stage and runtime): untouched. The previous
  version loaded by hand: untouched.
- **T7. Reload with identical bytes** by hand before recovery: stopped (section 5 says why). The test states this is
  expected.
- **T8. Stale, copied or edited journal:** a journal copied from another stage; `r.launchd` edited; the pause id
  edited. Each refuses.
- **T9. Null or incomplete tree** (unreadable snapshot; deeper than four levels): refuses before step B, so nothing is
  written.
- **T10. Crash right after step B** (a throw from the hook after the write): journal `requested`, label still loaded.
  The next run does a full proof, keeps the old pids, and stops.
- **T11. Crash right after step D:** journal `requested`, label gone. The next run does not call `bootout`; it proves
  the recorded set gone and goes on to `start-failed`.
- **T12. The outcome write fails** after the act: the next run behaves as in T11.
- **T13. Non-zero `bootout` that did remove the job:** `state: "failed"`, `acted: true`, nothing more this run. The
  next run finds the label gone, proves the recorded set gone, and restores.
- **T14. Non-zero `bootout` that did not remove the job:** the next run does a full fresh proof before any second act.
- **T15. Still there after `bootout`** (label loaded, or a recorded pid with the same start time still listed):
  `uncertain`, nothing restored.
- **T16. Recorded pid reused** (same pid, different start time) counts as gone. The same start time does not.
- **T17. A surviving descendant** whose command no longer names the runtime blocks the next run's absence proof
  through the recorded set.
- **T18. Spawn error, signal, timeout, unknown `print` status** at each call: a refusal before the act; `uncertain`
  after it; nothing restored.
- **T19. No widening.** For every phase but `starting`, `--phase recover` with a loaded label never logs `bootout`.
  `finish` at `starting` never logs `bootout`.
- **T20. `finish` keeps its contract.** A `starting` journal without `r.launchd` whose new service is complete still
  reaches `started` and `deployed` (extends `:1013`).
- **T21. Release gate.** A pre-swap journal carrying `launchd` or `newServiceStop` is refused as contradictory, in the
  style of the existing release-gate tests.
- **T22. Parsers** (`src/deploy-launchd.test.ts`, fast): a made-up `launchctl print` block in launchd's layout as
  publicly reported parses. No output was captured from a real machine: the canary is what would show the real
  text. Only the job's own fields, one tab deep, are read; a field of the same name inside a nested block (launchd
  prints `state = active` inside `resource coalition` and `jetsam coalition`) is that block's and is ignored. A
  duplicate top-level `pid`, `path`, `state` or `arguments`, a truncated or unbalanced block, reordered fields and odd
  whitespace return null; `ProgramArguments` with a duplicate key, a nested array, an unknown entity, or an argument
  with a line break returns null.
- **T2, two more rows.** A process on this database whose command shows no runtime folder, and a child of the new
  service that names this database but is not its `up`: both refuse as a previous-version process.
- **T23. Time running out during the last checks.** Before C, during the listing, and with less than a bootout's
  time left at launchd's last answer: no bootout, `failed`, `acted: false`. No call begins past the deadline, and a
  call's timeout is cut to the time left.
- **T24. Interrupted.** A stop signal while the intent is written, or during the last `launchctl print`: no bootout,
  `failed`, `acted: false`, reason "recovery was interrupted".

### Real-launchd canary (only with the owner's explicit yes)

A script, `scripts/deploy-stop-canary.mjs`, modelled on `scripts/desktop-update-canary.mjs`. It is run only by a
person, and only after the owner has said yes to that run. It is never run in CI and never by an agent on its own.

- A unique throwaway label, `com.toolroll.canary.<random>`. Before anything, `launchctl print` of it must exit 113.
  Anything else refuses (collision).
- Everything in a fresh temp folder: the plist (never in `~/Library/LaunchAgents`), a fake runtime folder X with a
  `controller-service.js` that only idles and never starts an `up`, a `cli.js` that is never run, and a temp database
  file D. The plist's arguments are `node X/controller-service.js node X/cli.js up --db D`, so the real `commandKind`
  check passes and `service(X)` stays null: exactly this case.
- The canary runs the parser, the facts, the act and the absence proof against that label, with a short wait and a
  deadline on every step.
- Cleanup always runs: `bootout` of that label only, then `print` must exit 113, then the temp folder is removed. The
  canary reports any cleanup it could not prove.
- Never the real label, never port 4180, never `~/.config/standing-orders`.

Without that yes, the parser is tested on scrubbed real output and everything else on the fake fixture. The pull
request then says plainly that the launchd lifecycle itself (bootout timing, exit codes, KeepAlive) was not exercised.

## 13. Safety review

- **Check and write together.** The intent is written before the last checks. The last checks end with a structure
  read and a `print`, then the act. launchd has no compare-and-swap, so a window of one `print` remains (sections 7,
  9). Every outcome is written to the journal; a crash leaves `requested`, which later runs treat as uncertain.
- **Never widen implicitly.** One act, one phase, one label, after the facts in section 4. `finish` and the release
  gate gain only refusals. Tested by T19–T21.
- **Grant files, not folders.** No grant changes. The facts read exact files, by real path, and refuse links.
- **Don't let input choose what's trusted.** Flags and journal fields must agree, the stage must be in the fenced
  state folder, and section 6 bounds the act whatever they say. The journal is not independently signed; that is the
  remaining gap (Q8).
- **An approval means a person's yes to exactly this.** The owner approved this act under this rule. No candidate
  approval is used as proof of ownership.
- **Credentials go only where they belong.** None are read or written. Only fixed reasons and pids go to the journal.
- **Tests never touch the person's real setup.** Fakes for every subprocess, temp HOME and XDG folders. The canary is
  separate, opt-in and owner-approved.
- **Prove it against the real thing.** The parser is tested on scrubbed real output. The lifecycle is tested only
  through the canary with the owner's yes; otherwise the pull request says it was not exercised.

## 14. Open questions

- **Q1. Who watches?** Settled: the recover run waits the full `HEALTH_WAIT_MS` itself (F7), because the adapter can
  reach recovery without a finish (`src/release-adapters.ts:533`).
- **Q2. Compare launchd's `arguments`?** Settled: yes, with a strict parser.
- **Q3. Loaded with no process?** Recommend keeping it manual.
- **Q4. Non-zero `bootout`?** Recommend: record `failed`, `acted: true`, and do nothing more this run. The next run
  checks again. v1 claimed a non-zero bootout can still have removed the job; `src/daemon.ts:78`–`:98` does not show
  that. It only shows a bootout can still be pending after it returns.
- **Q5. Canary?** Recommend the canary in section 12, run once before merge, only if the owner says yes.
- **Q6. `proveStaged()` before the stop?** Recommend no, as today.
- **Q7. The `started` case** (complete structure, console not answering). Out of scope; named in the pull request.
- **Q8. An independent receipt for the journal.** A receipt in the fenced database, binding the update id to the
  stage, label, plist and definition hash, would make the journal's claims checkable. It needs a new table, so a
  schema change through every updater. Options: (a) not in this change; rely on the fenced folder plus section 6.
  (b) Add it now. Recommend (a): section 6 already limits a forged journal to stopping an incomplete Toolroll
  supervisor under a live pause, which is what the manual message asks a person to do.

## 15. Ledger: Codex review of v1 (NO-GO, 10 findings)

| # | Severity | Finding | v2 | Where |
| --- | --- | --- | --- | --- |
| 1 | High | Journal agreement is treated as authority; the records may be build-writable. | Adopted in part. The fenced placement is shown from the code and made a checked precondition. Section 6 bounds what a forged journal can cause. An independent database receipt is not added (Q8). | §3, §4 F1, §6, §14 Q8 |
| 2 | High | Matching a definition does not identify the bootstrap instance; pid checks don't close reuse; parent 1 includes orphans. | Adopted. Ownership claims removed. The rule is stated as approved; §5 lists what is not proved and why the act is still the approved one. | §4 F5, §5 |
| 3 | High | The lock does not exclude another deployment of the label. | Adopted. Lock scope stated; the per-database pause shown as what stops a second Toolroll updater; what is not excluded is listed; final `print` re-read added. | §9, §8 C7 |
| 4 | High | A late healthy start can still be stopped. | Adopted. No "never". Window stated; structure read and `print` are the last reads; `/healthz` refusal added; compared with `swap()`; harm limits shown from the code. | §7, §8 C, §4 F7 |
| 5 | High | A crash loses the new pid set; a null tree is not refused. | Adopted. Full `{pid, start}` set written before the act; null or incomplete tree refuses before any write; states and resume rules defined; the set is only an exit obligation. | §8 A, B, states table |
| 6 | Medium | Final proof omits previous-runtime absence; runtimes compared as strings. | Adopted. Canonical, readable, distinct runtimes; previous-runtime absence re-checked at C3 and after the act. | §4 F6, §8 C3, F |
| 7 | Medium | No timeouts; uncertain results unspecified; Q4 overstated. | Adopted. Bounded calls, one deadline, "uncertain" defined; Q4 wording corrected. | §8 bounds, E, H; §14 Q4 |
| 8 | Medium | Tests miss dangerous boundaries; a `sleep` canary cannot pass the argv check. | Adopted. Cases T2–T22 added; the real exit proof runs on fake listings; the canary uses an idle fake supervisor with a matching command line, owner's yes only. | §12 |
| 9 | Medium | A shared helper could change `finish`; the release gate lacks the new fields. | Adopted. `installedIsOurs` unchanged; `SWAP_FIELDS` gains both fields; T20, T21. | §4 F3, §10, §12 |
| 10 | Low | Overclaims (structure vs answering, finish writes, timeline best effort, environment not compared, partial bootout effects); two citations wrong. | Adopted. Wording fixed throughout; citations now `:241` and `:238`; "nothing else changed" qualified. | §1, §2, §4 F4, §8, §11 |

## 16. Ledger: Codex review of the implementation (NO-GO, 4 findings)

This was the second and last review round for this change. The fixes below were made and tested after it and have
not been reviewed again.

| # | Severity | Finding | Fix | Where |
| --- | --- | --- | --- | --- |
| 1 | High | The previous-version check dropped any process that names this database unless its command showed a previous runtime folder, so a bootout could happen while a previous-version process was still running. | Only the observed new service's own supervisor and `up` are excused (by pid, start time and exact command). Everything else refuses. | §4 F6; T2 rows |
| 2 | Medium | The parser refused launchd's real output, which has `state = active` inside its coalition blocks, so the stop could never act. | Only the job's own top-level fields are read; same-named fields in nested blocks are ignored. The sample now has both coalition blocks. | T22 |
| 3 | Medium | The deadline was only checked at the start of the last checks; they could use up the time and still reach the bootout. | No call begins after the deadline, call timeouts are cut to the time left, and the act needs a whole bootout's time. | §8 bounds, C8; T23 |
| 4 | Medium | No interruption check between the intent and the act. | One event-loop turn plus the lock and signal checks at the end of A, the start of C and after the last read. | §8 bounds, C8; T24 |

Still not proved, and named in the pull request: the real launchd lifecycle (the canary, with the owner's yes); the
text of a real `launchctl print` (the sample is made up); failures inside the real bounded structure reader (the
fixture replaces `service`).
