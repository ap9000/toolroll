# npm/browser deployment preflight — 2026-09-13

**Not deployed.** The user approved the npm/browser route with the signed Mac
release kept separate. No public npm publication, GitHub push, installed-app
replacement, live service switch or permission change was performed.

## Checked

- Base commit: `45ad5a7`, plus the existing local implementation changes.
  This is not a claim that the candidate is already on GitHub or npm.
- `npm run build` passed. `npm pack --ignore-scripts` produced a 262-file
  package; offline install into a disposable prefix passed. The packaged CLI
  reports version 0.4.3. Package SHA-1 from npm:
  `afa06c6bd5a8141c84fab0412b4e86b4308d17a3`.
- The first packaging attempt could not write the sandbox-excluded normal npm
  cache. Using a dedicated temporary cache succeeded; no cache ownership or
  permissions were changed. npm's root-owned-cache suggestion was not treated
  as a confirmed diagnosis.
- The candidate accepts the existing schema-57 database. Read-only inspection
  found zero open runs, unreleased claims, pending conversations, live held
  sessions and unsettled stops. Historical process witnesses remain recorded;
  they were not deleted or assumed safe from their count alone.
- The existing `com.standing-orders.desktop` supervisor was loaded, but its
  authenticated localhost:4180 health challenge received no response. Saved
  watch leases were stale. This is not a healthy deployed baseline.

## Real background preflight

The disposable job `com.standing-orders.browser-preflight.pry2qz` ran the
packaged `checkDesktopProjects` implementation under:

`~/.nvm/versions/node/v22.22.0/bin/node`

It had no native app association, no provider calls, no task database writes
and no access grants. Each project probe uses the existing bounded child and
tests reading the directory plus a unique, cleaned-up Git-metadata scratch file.
At **2026-09-13T16:56:04.348Z**, all three saved Documents repositories
(`job-scraper`, `oddcircle`, `standing-orders`) returned **unavailable** because
their access checks timed out. This is not proof of a particular missing grant
or a visible prompt. Foreground shell access is not background-worker evidence.

The probe job was booted out, confirmed absent, and its exact plist removed.
No live switch was attempted after this failed preflight. Runtime, package,
scripts, log and JSON receipt are retained locally under:

`/private/tmp/standing-orders-browser-deploy.Pry2QZ/`

These are temporary test artifacts, not a durable installed service.

## Next actions

1. In an unlocked Mac session, inspect any folder-access prompt and the actual
   background access failure. Let the operator handle protected approvals;
   do not substitute a foreground pass, broaden permissions or move projects
   silently. Retest the exact intended service runtime.
2. Once access passes, stage the package in a durable location, pause admission,
   let work drain, preserve the old service/configuration and take a verified
   SQLite backup. Switch to one supervised browser/controller service while
   keeping the native app unchanged. Verify saved login/projects, current
   worker/watch leases, console and clean restart. Restore the previous service
   configuration if acceptance fails; never restore stale task data over new work.
3. Run ten mixed approved real tasks, repair reproduced gaps, then expand to
   30–50. Measure original outcomes, proof quality, end-to-end times and manual
   technical rescues. Exercise phone steering, reconnect and recoverable faults.
4. Official signed Mac installation/two-build acceptance, physical reboot and
   Windows qualification remain explicitly separate checks. Publishing requires
   a distinct version and the normal reviewed release process; do not publish
   this local same-version tarball as though it were an already released build.

See the [prioritized acceptance criteria](../PRIORITIES.md#next-sequence).
