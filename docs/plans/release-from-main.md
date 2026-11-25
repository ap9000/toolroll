# Releasing Toolroll from main

Status: parts A and C built on `release-from-main` (2026-11-25). Parts B (docs-and-version pull requests reuse CI) and
D (platform-dependent tests without new lanes) are not built.

## What a release is now

A release is one commit **M** on main: the squash merge of the newest pull request from `release-<version>` into main.
That branch name matters: `release-candidate.yml` runs Node 22 only on `release-*` heads, so M's tree is the one Node 22
ran on. M never moves. Commits that land on main after it go in the next release.

```
toolroll release prepare 0.9.120 [--notes notes.md]   # opens the version pull request
# merge it like any pull request once its checks pass
toolroll release 0.9.120 [--full]                     # releases M
```

`prepare` makes one commit from main's head through GitHub's Git data API (no checkout is written): package.json and
package-lock.json with only the version spans changed, and the CHANGELOG entry (from `--notes`, unless CHANGELOG.md
already has `## 0.9.120`). It opens the pull request; a person merges it. `toolroll release` never merges.

`toolroll release <version>` steps: gate → approval → check → complete → quiet → deploy → link → tag → publish →
homebrew. Gone: branch update, carry, ci, merge, tree.

- **The proof.** `scripts/release-proof.mjs proveRelease`, the function publish.yml runs, now reads GitHub through an
  injected reader (the plane's own gh): squash of exactly one merged pull request, the head's tree equal to M's, the
  compare-API squash ancestry, the timeline's retarget history, the attempt race re-read, and every required job's
  newest attempt on the tested head. The coordinator adds: the same commit, tree, pull request, head and branch the
  journal was bound to (every resume); M still on main's first-parent history (appends are harmless, a rewrite or
  removal stops); every other check reported on the tested head passing (`node 26 · SQLite`, say). It runs before
  anything is filed, immediately before the deploy (and before resuming an interrupted one) and immediately before the
  tag, and each proof after filing is kept in the plane's action ledger for the task (`main release proved`). A proof
  stands 30 minutes for a deployment, and a re-proof that fails is kept too (`main release proof failed`) and makes
  every earlier proof unusable: a direct `deploy-browser.mjs` run can't stand on a stale or overtaken proof. Within
  those 30 minutes a newer CI failure nobody re-proved is not seen by a direct deploy (the coordinator's own deploy
  always re-proves first).
- **The scope.** The task is filed with `task scope --release <v>:<pr>:<branch> --from-main [--full-check]`: a release
  check purpose `main-release` with the check it runs (`deploy` or `full`), sealed into the scope digest a person
  approves. Never release terms: nothing carries. A release from main always asks a person (no automatic approval).
- **The check.** The plane's worker runs it after the approval (the deploy check runs the candidate's code). Coverage
  `deploy` (or `full` with `--full`) is what the coordinator, `deploy-gate.ts` and `deploy-candidate.mjs` accept, and
  only for a sealed main release whose newest proof record came after the approval and names exactly the approved
  commit, tree, pull request and branch. A branch release never deploys on a deploy check.
- **Journals.** `releases/from-main/<version>.json`. Branch journals (`releases/<branch>.json`) are read exactly as
  before: `toolroll release <branch>` still finishes a release it began, from its durable deployment facts, and neither
  command reads the other's journal. `release approve <version>` finds a release from main.

## The deploy check (part C)

The worker copies its own database with SQLite's online backup into a 0700 temp folder, seals the attempt (inventory
marked `deploy`; owed: build, rehearsal, and the upgrade path when a full check would owe it), and hands
`scripts/release-check.mjs` only that copy on its handshake (`{"mode":"deploy","copy":…}`). The check reads the
handshake first and runs nothing of a full check's planning (not even its fetch of origin's tags), then the build, the
rehearsal and the upgrade path when owed. The plane deletes the folder however the check ends; a copy it can't delete
fails the check.

**What is fenced, and what isn't.** The check's own entry, `scripts/release-check.mjs`, and what it and
`scripts/deploy-check.mjs` import (`isolated-env.mjs`, `deploy-phases.mjs`, `suite-lifecycle.mjs`…), are the release
commit's code and run as the plane's approved check command with the project's check access (for Toolroll, outside the
sandbox: full access to this computer) — that can't be fenced from inside it, and the release card says so. Everything
else runs in a throwaway computer and a fence written before it starts:

- the throwaway computer, in the copy's folder (`isolated-env.mjs`: its own HOME, XDG folders, TMPDIR and PATH of
  approved tools from node's own folder and the system's, stand-ins for gh, launchctl and browsers, no credentials),
  checked before every spawn;
- a Seatbelt profile per step that denies reading file contents by default (readable: the throwaway folder, the
  checkout with its dependencies by their real paths, node's own install, the system's folders; the person's secret
  folders never), writes only in the throwaway folder (the build also in the checkout, never its `.git`), and no
  network but, for the console, its own loopback port. Outside macOS it refuses.

Fenced so: `npm run build` (with every build script and dependency it loads), the candidate's store on the copy, its
console and its `task list`. Then: the candidate's store opens the copy twice (history kept, integrity and foreign keys clean), its console starts
with `serve --rehearsal` (127.0.0.1, ephemeral port; no loop beside the console, no queue, team, lead upkeep,
telemetry, background check, backup, sign-in probe, update check or git-incident notice; bridges, webhooks, schedules
and flows only ever run in the worker, which `serve` never starts), `/healthz` must answer, the candidate's
`task list` must read the copy, and the process group is stopped and proven gone. `/healthz` is fetched with no
redirect followed. Anything the rehearsal started or made that is still there afterwards (a process, its folder, the
copy) fails it. A rehearsal never signals a process its copy records: Direct Chat polling, thread recovery and engine
upkeep don't start, and while it serves, `process.kill` and custody's signal road refuse any pid but its own. On this
Mac the fenced build took about 4 s and the fenced rehearsal about 11 s on a fresh database; the owner's database will
take longer to migrate.

The upgrade-path sample stays, under the full check's rule (only when store, schema or migration code changed since the
last release). It installs the last five releases from npm, so it adds minutes when it runs; it was not measured on the
owner's Mac. Real-model journeys are not part of the release path.

## Owner decisions (2026-11-25)

- Speed: a release doesn't re-run the full suite on this Mac. `--full` runs it, on request.
- Judge, build or test-harness changes since the previous release are **shown** (with `--full` offered), never forced.
- Real-model journeys are not part of the release path.
- Approval comes before the deploy check. Its own scripts run the candidate's code with the project's check access (for
  Toolroll, full access to this computer); its build, store and console run fenced.

**Residual risk, accepted by the owner:** candidate code can influence its own CI results through build scripts,
dependencies, test setup or reporters (Codex review, finding 1); the local full check no longer guards against that by
default. A change to the judges or the harness is said on the release, not acted on. `--full` is the guard when wanted.
Neither flow defends against a malicious test author.

## Codex review findings for A and C

- 3 (journeys and upgrades): the owner chose not to keep a blocking local journey run; the upgrade sample is kept
  under its existing rule; real-model journeys are out of the release path.
- 4 (rehearsal isolation): isolated environment and a deny-by-default fence for the build and every candidate process
  (the check's own orchestration scripts excepted, said above and on the card); every start path of the console
  disabled and tested (`src/serve-rehearsal.test.ts`), including the recorded processes of a copy left alive; the real
  fence, the fenced build and a real rehearsal tested on macOS (`src/deploy-check.test.ts`); cleanup fails closed.
- 5 (complete proof, refreshed): the whole of publish.yml's proof before filing, deploy and tag, plus first-parent
  membership; every resume bound to the same M, tree, version, pull request and head.
- 8 (activation and legacy): an older plane reads a `main-release` scope or a `deploy` receipt as malformed and refuses
  (fail closed); branch journals keep their identities, approvals and commands until settled.

## Bootstrap (the first release from main)

Who runs what:

- `toolroll release …` is the **coordinator**: whichever CLI the person starts. Its plane calls go to the `bin.js`
  beside its own modules (`release-adapters.ts ownCli`), and it opens the plane's database itself (authority, progress,
  the deploy gate). The deployment runs the approved commit's own `scripts/deploy-browser.mjs`, extracted by the
  coordinator, which proves the candidate with the **installed** runtime's modules.
- The **check** is not run by the coordinator: the installed worker (launchd) builds the release task and runs the
  project's approved check command with a handshake its own builder decides.

So on this Mac, which runs 0.9.116, the first release can't be a release from main, and running the candidate's own
CLI (`node dist/bin.js release 0.9.119` from its checkout) doesn't change that:

1. the 0.9.116 worker can't run a deploy check: it doesn't know the `main-release` purpose or the deploy handshake, so
   it never seals a `deploy` coverage, and the coordinator refuses anything else for a release from main;
2. the candidate's CLI would migrate the live database (schema 176 → 184) under the running 0.9.116 services, which
   then refuse it. `toolroll release <version>` now refuses to run with a build whose schema isn't the database's
   (`liveSchemaProblem`), saying so before anything changes.

The first release that carries this code is therefore made the earlier way, once, with its full check (about 40
minutes): a `release-0.9.119` branch with the version and changelog, its pull request open, then

```
toolroll release release-0.9.119 --repo <the gate checkout>
```

Once 0.9.119 is deployed here, every later release is `toolroll release prepare 0.9.120` → merge → `toolroll release
0.9.120` (no 40-minute check). Nothing in A or C weakens the proof or the approval to avoid that one full check.

## Not done

- Part B (CI reuse for docs-and-version pull requests) and part D (the platform-read guard).
- `toolroll release <version>` doesn't wait for and merge the release pull request; a person merges it.
- The upgrade sample's cost on the owner's Mac isn't measured.
- The legacy `toolroll release <branch>` still works unchanged; pointing it to the new way (plan slice 7) is left for
  when the branch journals are settled.
- **Known limit of the build's cleanup:** the fenced build runs in its own process group and anything left in that
  group fails the build, but a process that leaves the group itself (setsid/setpgid) isn't followed. The fence
  denies it signals to other processes, network and writes outside the checkout, so such a process can only idle;
  following descendants by session or parent is future work.
