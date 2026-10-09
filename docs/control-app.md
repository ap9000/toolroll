# Desktop control app and guided setup

The macOS shell opens the existing Toolroll console and supervises the
existing `up` command with launchd. There is one queue, one project registry,
one worker/recovery implementation, and the same approval controls in the
browser and desktop app. Closing the window leaves the service running.

## Build and run

The local build requires macOS 13 or later, the Swift compiler, and the Node
runtime required by this checkout. From the repository:

```sh
npm ci
npm run build:desktop -- --sign-identity "Developer ID Application: Your Team (TEAMID)" --notary-profile standing-orders-release
```

The command prints a fresh artifact path under `output/desktop/`. It does not
install or open the app. An explicit new `.app` output path is also accepted;
an existing file, directory, or link is always refused, even a previous build.
Use the controlled update flow below before replacing an installation.

The bundle includes the compiled controller and a standalone official Node
binary, preserving Node's original signature and license. Releases require a
valid **Developer ID Application** identity from the signing keychain; there
is no automatic ad-hoc fallback. `TOOLROLL_SIGN_IDENTITY` can supply the
same identity. `--notary-profile` (or `TOOLROLL_NOTARY_PROFILE`) uses
credentials already stored with Apple's `notarytool`, waits for acceptance,
then staples and validates the ticket. Without that option the result is
explicitly **signed, not notarized**, and is not ready for distribution.
Do not put signing private keys or Apple account passwords in this repository.

The build script reserves a new output, then publishes its `Contents` only
after compilation, signing and any requested notarization succeed. It never
moves or removes the installed app. Failure cleans up only its own empty
reservation and temporary build directory; unexpected output changes are
preserved. The existing `~/Applications/Standing Orders.app`, if present, is
a read-only signing-continuity reference. Use `--upgrade-from /path/to/App.app`
for another installation; an explicit missing reference is refused. Signed
updates must retain that reference's signing team and satisfy its designated
code requirement. Migrating an old ad-hoc build to the first properly signed
release may need one new approval.

The first launch imports a valid existing local login, or asks for an operator
account, then lets the operator choose Git projects. Sign-in is saved in
Keychain. The background controller uses its existing owner-only `up-login.txt`
restart credential. Pairing never replaces another valid remembered login.
Approval screens still require the operator's password and an exact preview.

File → Start background service starts or reconnects the launchd service.
File → Stop background service uses the controller's normal shutdown path.
The service stops new admission, allows its normal grace period, and uses
existing owned-process cleanup and recovery. This is a service control, not a
per-task instant stop/resume feature. File → Open service logs opens the state
directory.

File → **Check installation** remains available when the saved database is
missing, incompatible, or damaged. It distinguishes a running service from an
identity-verified responding console; neither alone certifies project access.
Stop also remains available in those database failure states. Start refuses
an incompatible or missing database before changing the service. Reopening
an established installation never turns a missing database into an empty queue.
Only a recorded first-time setup may create the initial database.

Each artifact has a build ID in its signed `runtime.json`. The native app passes
it into the shared service definition. A new build at the same path therefore
changes the launchd definition; reopening the same build stays idempotent.
This is runtime identification, not permission to update under active work.

State defaults to `~/Library/Application Support/Standing Orders`. The selected
control database follows the CLI's existing database selection. Opening an
existing database requires this build's exact schema version: the shell never
silently migrates an older running installation. Perform the documented
controller upgrade separately.

### Install an app update

For two controlled-update-capable apps on the **same database schema**, use
**File → Install app update** and choose the new `.app`. The review names the
current and new builds. Nothing is replaced until you confirm **Install update**.

The updater:

1. Validates the complete bundles, signing identity and schema compatibility.
   A production release must preserve the installed signing team and designated
   requirement, pass Gatekeeper, and carry a valid stapled notarization ticket.
   A development app can only update the separate development identity.
2. Pauses new work at the database boundary and lets existing work finish.
   Running work is not given a new time limit or killed to make an update fit.
   An unresolved process witness keeps the update waiting, with a reason.
3. Makes a private SQLite backup and verifies integrity, relationships and
   retained task/approval/run/evidence data. Saves the project registry,
   desktop configuration and restart login alongside it. Keychain is untouched.
4. Stops the service through its normal lifecycle, rechecks that work is quiet,
   then atomically exchanges the installed and staged app on the same volume.
   There is no two-rename fallback that could leave the installed path empty.
5. Starts the candidate with new admission still paused. Completion requires
   the new build's loaded service definition, a fresh worker/project-access
   receipt, live project watch leases, and an identity-verified console.
   A service that was stopped before the update is stopped again after checking.
6. Resumes new work only after verification. If verification fails, restores
   and verifies the previous **app**, keeping the **current task database**.
   It never copies an old backup over newer tasks.

The update is a separate background operation; closing the window does not
cancel it. A temporary macOS recovery job runs from the private staged copy,
independent of the app being replaced. If the updater crashes, it resumes from
the saved state automatically. If the recovery process itself crashes, macOS
can start it again on its 15-second wakeup interval while you are logged in and
the computer is awake. No app reopening or **Resume** is needed for these cases.
The OS-held locks prevent duplicate operations, while the admission pause
survives in SQLite. The temporary job removes itself when finished.

**File → Update status** shows progress, automatic recovery, **Retry safely**
when intervention is required, cancellation, retained files, and **Reopen
updated app** when ready. Cancellation before shutdown leaves current work
alone; after installation it restores the previous app. **Stop** is recorded
separately and takes precedence over automatic recovery: the service stays off.

There is no arbitrary task-duration cap. A three-minute no-progress watchdog
restarts only the updater process; legitimate draining continues to report
progress without interrupting running tasks. New-worker readiness also has a
bounded diagnostic window. After three interrupted forward attempts, recovery
requests the previous app, with up to three restoration attempts. Retry counts
survive recovery-process crashes. Exhaustion leaves a clear reason and a safe
retry action, not an endless loop. A changed installation, configuration,
backup, app, unreadable receipt, or competing controller is a reason to stop
safely, not to overwrite unknown state or bypass permission controls.

Backups and the standalone updater are kept beside the installed app under
`.standing-orders-updates/<update-id>/`, with owner-only folder/file access.
`desktop-update.json` in the state directory points to the operation; the
private update folder also has `receipt.json`, `recovery.json` and `update.log`.
A damaged primary record suspends the matching recovery job using the retained
receipt when that receipt can still be validated; it is not overwritten with
possibly stale state. Do not post
this folder publicly: it includes database and restart-login backups. No
automatic backup deletion is performed.

If the window cannot reopen, run the retained helper from that operation:

```sh
updater_app="/absolute/path/from/the/update/record/Updater.app"
state_dir="$HOME/Library/Application Support/Standing Orders"
"$updater_app/Contents/Resources/runtime/node" \
  "$updater_app/Contents/Resources/dist/desktop-host.js" \
  update-status --state "$state_dir"
```

Use `update-resume` in place of `update-status` to retry, or `update-cancel` to
request the previous app. These use the recorded installation, not a guessed
destination. If signature/backup/configuration checks refuse recovery, retain
the files and resolve the named problem; do not delete the admission gate or
restore the database by hand to force the queue to run.

The candidate must advertise recovery protocol 1; an older installed app may
lack that flag if it supports the same controlled-update and database protocol.
An older candidate is refused before work is paused. This native updater
currently targets macOS. It does **not** silently migrate
schemas, replace a legacy bundle without update metadata, convert an ad-hoc
release identity into a signed one, or certify permission persistence. Those
cases use the explicit procedure and release acceptance below. The build
command itself never updates a live installation. Crash recovery without an
open window is verified with disposable development apps; physical logout,
reboot, production-signature/access persistence and Windows remain separate
acceptance checks. See the [recovery evidence](assessments/AUTOMATIC_UPDATE_RECOVERY_2026-09-13.md).

### First installation, legacy replacement or schema migration

1. Build a separate signed artifact and verify signing continuity against the
   actual installed destination. Notarize before distribution. Keep the old
   app unchanged while the candidate is being validated.
2. Ask the candidate whether it understands the saved database, without
   launching its UI, creating state, starting a worker, or migrating anything:

   ```sh
   candidate_app="/absolute/path/to/new/Standing Orders.app"
   "$candidate_app/Contents/Resources/runtime/node" \
     "$candidate_app/Contents/Resources/dist/desktop-host.js" \
     database-status --state "$HOME/Library/Application Support/Standing Orders"
   ```

   `ready: true` means schema compatibility only, not permission persistence,
   data integrity, or a completed installation. A refusal leaves data intact.
3. Before replacement, stop admission and let active work finish. Stop the
   desktop service, quit its window, and stop any other controller or CLI
   writer sharing this database. Preserve the current app, desktop state,
   project registry and private restart-login file. Take a consistent SQLite
   backup using its backup API; do not copy just the main database while a
   writer or WAL is active. Verify the backup opens and contains the expected
   tasks, approvals and runs. Keep backups private and outside the app bundle.
4. If a schema upgrade is needed, rehearse it on a separate copy of that backup
   using the candidate's existing CLI, then check retained data and integrity.
   Only with all old writers stopped and a verified backup should that same
   migration be run on the live database. A newer or malformed schema is not
   a license to downgrade or overwrite the database.
5. Preserve the old bundle separately and install the candidate at the same
   app path. Start normally. Verify the saved login, projects, new build's
   loaded service definition, fresh worker access receipt, live watch leases,
   and responding console. Then complete the two-build/reboot acceptance below.
6. On failure, stop the new service and preserve its logs and database. An old
   app is safe to restore only if it can read the **current** database. Never
   automatically restore an old database over tasks created after the backup.

This manual procedure is separate from the same-schema app updater. Automatic
database migration is deliberately not claimed. Native release acceptance must
precede unattended distribution.

## Isolated preview

Use a separate output bundle and an explicit state directory. Keep this
disposable runtime outside Documents/Desktop/Downloads so protected-folder
access to the test app itself does not obscure the worker check:

```sh
preview_root="$(mktemp -d)"
npm run build:desktop -- --development "$preview_root/Toolroll Development.app"
open -n "$preview_root/Toolroll Development.app" --args --state "$preview_root/state"
```

Development builds require an explicit destination and use
`com.standing-orders.desktop.development`, a **Toolroll Development**
window, and separate default state/Keychain/service identities. They cannot
replace the installed release. Ad-hoc development builds are not evidence
that permissions persist across release updates. Do not combine development
mode with release-signing or notarization environment variables.

A new custom state directory gets its own database, configuration, Keychain
account, and launchd label derived from the directory. Select its projects
explicitly; the service directory and source checkout are not implicitly
enrolled. Different previews still need different free ports, configured in
`desktop.json` before starting; the default is 4187. After testing, stop the
preview service and quit the app.

The native shell verifies a fresh HMAC challenge before submitting its login
on loopback. Its helper commands execute off the UI thread with bounded time
and output. No credential is passed in process arguments or service logs.

## Project access: approve once, verify the worker

The native app and its launchd service are explicitly associated through
`AssociatedBundleIdentifiers`. The Files & Folders prompt explains that the
selected Git projects need to remain accessible while the window is closed.
This association identifies the app; it does not grant access by itself.

The **Finish project access** panel reports checks performed by a child of the
actual background controller, not a Terminal or foreground-only test. Each
check reads the project directory and creates, reads back and removes a unique
scratch file inside Git's common metadata directory. It never edits tracked
files, commits, pushes, or invokes an AI provider. File-specific restrictions,
credentials and provider availability still need their own checks.

Setup says **Project access verified** only after that worker's checks pass,
each saved project has a live watch lease, and the identity-verified console
answers. Receipts from a previous worker, changed project selection, or before
**Check again** are not accepted as current readiness. The check runs on worker
startup, project-selection changes and explicit rechecks, not on every task.

If access is blocked, **Open Privacy Settings** opens Files & Folders; only the
operator changes the grant. **Check again** requests a fresh background check
and reconnects without restarting an unchanged healthy controller. Missing
folders and disconnected drives are reported separately from access denials.
No Full Disk Access, Accessibility, `sudo`, or agent “skip permissions” toggle
is automatically enabled. Signing/notarization never substitutes for consent.

### Release acceptance: permission persistence

Use a disposable Mac user or VM with two successive **Developer ID signed**
builds, the same app destination, bundle ID and signing team:

1. Install build A, select a disposable Git repository in Documents, authorize
   the app once, and wait for **Project access verified**. Record the app's
   designated requirement and the private `project-access.json` receipt.
2. Close the window; verify fresh worker heartbeats and access remain. Upgrade
   to build B, without resetting TCC or re-granting access. Check again and
   verify the new worker's receipt, watch leases and authenticated console.
3. Log out/in or reboot manually, then verify again without any new grant.
   Use the existing restart certificate for the installed service. Record
   whether a permission prompt was actually observed; health alone does not
   prove no prompt occurred.
4. Deny/revoke project access and repeat setup: it must not report ready. Grant
   it through macOS and check again; tasks/configuration must be preserved.
5. Record Windows results separately; macOS TCC tests are not Windows evidence.

The build enforces signing continuity; real permission persistence remains a
manual OS acceptance gate until a valid signing identity and unlocked test
session are available. For new repositories, a dedicated workspace outside
Documents/Desktop/Downloads avoids those protected-folder prompts. Existing
repositories are never silently moved.

Apple references: [file-system permissions and stable signing](https://developer.apple.com/forums/thread/678819),
[notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).

## Project setup

Open **Project setup** in the desktop toolbar, **Set up this project** in
Settings, or **set up** on a portfolio project card.

- Choose the default builder for new tasks. Codex suggestions come from its
  local visible model catalog; custom exact model ids remain possible. Claude
  uses its documented aliases rather than fixed version guesses.
- Check the provider's non-spending sign-in status. A saved API key is reported
  as present, not verified. Unknown CLI responses never become “Connected.”
  Sign-in status does not guarantee model access, quota, or runner readiness.
- Browse OpenRouter text models with search, context sizes, tool support, and
  reported input/output/cache prices. A saved key uses the account-filtered
  endpoint; keyless browsing uses the public catalog. Loading a catalog makes
  no generation request. Price and availability gaps remain explicit.
- Review a preparation command suggested by repository lockfiles. Saving does
  not run it. The approved preparation applies to subsequent runs, including
  already approved tasks; the builder default applies to new tasks. Clearing
  preparation is respected on later visits. Task scopes and signed routes are
  not rewritten.
- Preview and install the existing managed Toolroll agent instructions.
  Linked paths and foreign instructions are refused; stale previews must be
  reviewed again. Installation writes only the managed skill file.

Setup approval uses the existing authenticated session, CSRF check, project
boundary, one-use approval nonce, password verification, and a fingerprint
binding the shown inputs to the current saved configuration. Changing the
project or configuration after preview requires a new review.

Planning, review, repair, routing tiers, fallback, verification, and chat
continue through the existing Fleet, Settings, task, and chat screens. Guided
setup does not invent alternative policies for them.

## Calendar schedules

A flow's schedule trigger supports daily, weekly, and custom interval
schedules, in this computer's timezone unless you name one. Template
schedules retain their original timezone.

The same parser is used by the CLI and approval digest:

```text
every:120
daily:03:30
daily:09:00@America/Los_Angeles
weekly:2:18:45@Asia/Kathmandu
```

Weekdays are 0 for Sunday through 6 for Saturday. Without an explicit timezone,
calendar schedules remain UTC. The timezone and weekday are signed terms.
A nonexistent local time during a clock change skips that occurrence; a repeated
time runs once at its first occurrence. Missed work follows the existing
single-flight and no-backfill rules.

Provider references checked during integration: [Claude model aliases](https://code.claude.com/docs/en/model-config),
[OpenRouter public model catalog](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties),
and [OpenRouter account-filtered catalog](https://openrouter.ai/docs/api/api-reference/models/list-models-filtered-by-user-provider-preferences-privacy-settings-and-guardrails).
