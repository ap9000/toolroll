# Changelog

## Unreleased

- **youiyoux change requests become tasks by themselves.** In a project that
  uses youiyoux, each open change request in `.youi/requests` is filed once as
  a task with its goal, exclusions, files and requirements, and waits for your
  approval: no mode, grant or schedule approves it. Toolroll writes the task's
  status beside the request for youiyoux to show, with links to the task and
  to what needs you (your console address, or this computer's own console).
  Settings → Integrations has a youiyoux row per project, with **Turn off**.
- **Approve youiyoux requests from chat, all at once.** Each pass sends one
  card to your paired chat listing every new task with every word of its
  terms, with **Approve all** and each task's own **Approve**, two taps each.
  Only the exact words shown are approved; a task whose terms changed, or that
  doesn't fit one message, is named and left for Toolroll. Needs approving
  from chat turned on.
- **A task shows the youiyoux request it came from**: the request, page,
  component and file:line, on its page and its approval.
- **youiyoux options requests: options back on the Screens canvas.** An
  options request becomes a task that may write one file, its options. Once
  the result is ready for review, Toolroll copies that file from the result
  into the project for youiyoux's hub, only when it is safe and never over a
  file already there. Picking an option or dismissing them in the hub marks
  the task complete without merging its branch, with who decided what in its
  history; a task that needs more stays ready for review and says why.
- **A youiyoux request's status reads done once its task is complete.**

## 0.9.83 — 2026-10-31

- **A folder that doesn't answer can't freeze the console.** A disconnected
  drive, an iCloud-synced Documents folder or a pending macOS privacy prompt
  used to stall the whole console at startup. Folder reads now run in a
  separate, time-limited process: the console keeps answering, and the one
  page that needed the folder says it didn't answer.
- **Projects come back by themselves.** A saved project whose folder was
  away when Toolroll started connects as soon as the folder returns, with no
  restart. It reconnects only to the same folder it was saved as, and a
  project you remove stays removed.
- **Safer project paths.** A project's access is decided from its real,
  resolved location, never from how its path is spelled.

## 0.9.82 — 2026-10-31

- **A failing nightly holds your releases.** Turn it on with
  `toolroll release nightly --github` (your password). When a lane of your
  project's GitHub nightly fails on main, every deploy, the merge and the tag
  of a release wait until a later nightly passes that lane, and Needs you
  says which lane and why. A release whose own pull request re-ran that lane
  after the failure, with the same CI files, goes through. A nightly that
  can't be read gives a warning, never a pass.
- **Every run and chat turn records the model and cost the provider
  reported:** the exact model id, provider turns, cache-aware tokens, and
  cost, with API dollars, subscription usage and unknown kept apart (unknown
  is never shown as zero).
- **Evals (groundwork).** `toolroll evals` runs repeatable test tasks in
  throwaway worlds, graded by a separate checker process the agent can't
  reach. Ten starter tasks ship as drafts; real comparison runs stay off
  until they're validated.
- **CI:** required checks report under their exact names on every pull
  request; a slow git config read now says it timed out instead of blaming
  the project's config.

## 0.9.81 — 2026-10-30

- **The release proof works after the merge.** GitHub empties a CI run's
  pull-request link once the pull request merges and its branch is deleted,
  so 0.9.80's tag could never prove its checks and wasn't published. A run
  with no link now stands only when its branch has had exactly one pull
  request, ever, and that pull request merged into main. 0.9.80's changes
  ship in this release.

## 0.9.80 — 2026-10-30

- **Each test runs once, where it adds something** (docs/plans/test-matrix.md).
  Pull requests run the unit suite on Node 24 (Linux and macOS) and every
  area lane (Windows, Linux fence and cgroup, git 2.41 and 2.47); a pull
  request that only changes Markdown under `docs/`, the changelog or the
  README skips the area lanes. Node 22 runs on Linux and macOS once per
  release, on the `release-*` branch's pull request, in the new
  Release candidate workflow. Release tags no longer rerun the macOS suites:
  a release proof reads GitHub's record that the tagged tree passed every
  required check on its pull request before npm publication. A push to main
  typechecks and builds, and runs the full CI only when it can't prove the
  merge commit was tested. The nightly runs everything. A release now needs
  every required check executed, never skipped, and refuses to merge while
  main's branch protection doesn't require all of them. Hosted unit shards
  require their platform's native fence attacks to run.

## 0.9.79 — 2026-10-29

- **`toolroll release` rides out a short network failure instead of
  stopping.** A read from GitHub or git (`gh api`, `gh pr list`,
  `git ls-remote`, `git fetch`) that fails for a passing reason (no
  connection, a name that didn't resolve, a timeout, a 5xx, an answer cut
  short, GitHub's secondary rate limit) is asked again with backoff for up
  to about three minutes, saying why once; then it stops with the original
  error. A definitive answer (404, 401/403) is never asked again. A merge or
  a tag is never sent twice blindly: after a lost answer the release reads
  GitHub to learn whether it happened, and asks again only when it didn't.
  When main's branch protection can't be read, the release now says
  "Couldn't read GitHub's branch protection" instead of "main's protection
  doesn't hold", and still stops.

## 0.9.78 — 2026-10-29

- **Toolroll says when it is restarting.** The worker and console now record
  when they start, keep a heartbeat every 15 seconds, and record when they
  begin stopping and when they have stopped. While one is stopping it takes no
  new work, `/healthz` answers "draining" at once, pages say "Toolroll is
  restarting", and a new start waits only until the old one has finished
  stopping instead of a fixed window. A worker that stopped cleanly never
  holds its projects. A second live `up` is still refused.
- **The database is copied every few minutes.** Besides scheduled backups,
  the worker copies the database online every 5 minutes (change it, or the
  folder, in Settings → Backups), checks each copy and keeps the newest 24
  and one a day for a week. It never holds up the console or the worker. A
  deploy uses the latest copy when it is recent and matches the database
  exactly, instead of making a new one. Restoring stays a manual
  `toolroll restore`.
- **See where the time went.** A task's page has a "Where the time went"
  section under Details: when each part of its release check started and
  ended, and each step of its deploys, including what a deploy waited for.
  Console pages that take over a second keep a short record of where the
  time went, which an instance operator reads on `/health`. Only page names,
  step names and reasons are kept, never addresses or form contents.
- **A crashed worker is noticed in a minute, not three.** Workers check in
  every 15 seconds and are treated as gone after a minute of silence. A
  project lease is never taken for longer than a minute.
- **A release's version bump alone no longer owes the upgrade path.** Toolroll
  now decides from both commits' verified files that package.json and
  package-lock.json changed only in the project's own version (the check's
  own rule); any other change to them still owes it.
- **The macOS suite runs on the candidate before it merges.** Pull requests
  and main pushes now run the unit suite on hosted macOS with Node 22 and 24,
  in four shards each, joined into `node 22 · macos-latest` and
  `node 24 · macos-latest` exactly like the Linux checks. `toolroll release`
  waits for them; main's protection not requiring them yet is reported, not
  refused. After the merge, publication waits only for the tag's publish job,
  no longer for main's own CI run on the merge commit. The nightly and tag
  macOS jobs are renamed so no other workflow shares a required name.
- **A release is published without waiting for Homebrew.** `toolroll release`
  ends with "Published; Homebrew pending" once npm and the GitHub release are
  verified, instead of waiting up to 45 minutes for the tap's checks. Homebrew
  is its own state in the release journal (pending, failed or current), and
  running the same command again finishes it: it waits for the tap change's
  checks, then merges exactly that change, with the checksum still taken from
  npm's tarball. A tap already on a newer version is never moved back, checked
  again right before the merge.
- **A release whose checks run outside the sandbox now reruns its own check
  after Toolroll's machine fails.** Such a release can't carry later commits,
  so it used to file without release terms, and a check stopped by Toolroll's
  own shutdown, a lost build or a command that never started waited for a
  person. Its approval now seals a release check purpose instead: the check
  is held to the release's rules (a complete report, no CI standing in for
  its units), and only a failure Toolroll itself confirmed as its own
  infrastructure reruns, on the same commit under the same approval, at most
  twice. Another commit, a changed scope, release check or check access, or
  an approval that no longer stands never reruns. It never carries a later
  commit. (Schema v138 adds the column; saved scopes are unchanged.)
- **A deploy no longer gets stuck behind an `up` that won't stop.** When the
  old service's processes outlive their stop (a supervisor that exited while
  its `up` ignored SIGTERM), the deployment stops them itself, but only
  processes proved, by exact runtime path and arguments, to be that service's
  supervisor, `up` or console and worker. Anything it can't prove refuses and
  nothing is signalled.
- **A killed `up` no longer blocks the next start for three minutes.** `up`
  records each process it gives its worker credential to. A new start that
  proves every one of them has exited signs the old worker off and takes over
  at once; a second live `up` is still refused.
- **`up` signs off however it is stopped.** SIGTERM, Ctrl-C, its supervisor
  dying or its channel closing all end with the worker retired. A stop that
  hangs past the worker's grace stops the console and worker outright
  instead of waiting for launchd to kill it.
- **Deployments wait long enough, and say why.** Restoring the previous
  service, starting the new one and waiting for its project leases now allow
  two minutes (past a stale worker heartbeat's one) and name what they are
  waiting for. "Current work must finish first" now says what is running and
  what to do.
- **One command puts back a deployment that stopped half way.**
  `toolroll release --recover-deploy` shows what recovery will do for the
  unfinished deployment; `--yes` does it: stops only that service's proved
  leftovers, starts the previous service again and lifts the update pause.
  It is safe to run again.

## 0.9.77 — 2026-10-29

- **CI finishes in about a third of the time.** The unit suite runs in four
  shards per Node version instead of one 14–21 minute job. The required
  checks keep their names ("node 22 · ubuntu-latest", "node 24 ·
  ubuntu-latest") and pass only when every shard passed on the tested commit
  and the shards together ran every test file once, so main's branch
  protection needs no change. A flaky shard reruns in minutes, not twenty.
- **The release check's real-model journeys start sooner.** They run in the
  browser lanes as soon as the scripted journeys end, instead of also waiting
  for the unit suite; the check's load budget is unchanged.
- **An automatic release checks while CI runs.** With "Approve automatically
  when checks pass" on, the release files its task and runs its check beside
  CI instead of after it. Toolroll approves it only once every pull request
  check passed on the commit.
- **A release asks for your approval while CI runs.** `toolroll release` files
  the release task and asks you right away instead of waiting for GitHub's
  checks; after you approve, the release check runs beside CI. The approval
  says "GitHub's checks are still running; nothing deploys until they pass."
  Nothing is deployed, merged, tagged or published until every required check
  passed on the exact commit, read again right before the deploy; if one
  fails, the release stops before the deploy. A check that already failed
  still stops the release before anyone is asked.
- **The console stays responsive while builds and checks run.** `toolroll up`
  now runs two processes: the console (pages, sign-in and approvals) and the
  worker (builds, checks, follow-ups and housekeeping). On a copy of a real
  database, the slowest console answer during a heavy check fell from about
  5–6 seconds to under 0.3 seconds. A worker that crashes is started again
  and recovers its interrupted work as a restarted `up` does; a stop still
  lets running builds finish first. A running check's progress is saved at
  most once a second, and its final result at once. `--single-process` keeps
  the old one-process layout.
- **Console pages open faster and stay quick while work runs.** The sidebar,
  the Tasks count and the crew list are read once per database change for each
  person instead of up to four times per page, and before a page is drawn they
  are read on a background thread so the console keeps answering meanwhile.
  The chat landing's lists are kept the same way, and the task page reuses its
  "behind main" line for 15 seconds instead of asking Git twice per view. On a
  copy of a real database: /board 348 → 26 ms, /agents 320 → 4 ms, /chat 905 →
  19 ms, a task page 1.5 s → 0.2 s; with the database changing 40 times a
  second, pages take 0.27–0.47 s and the console answers other requests in
  about 1 ms (before: 0.35 s typical, up to 1.4 s). A page that re-reads after
  a live update gets "unchanged" when nothing it shows changed.
- **Fixes from the first review of the above.** CI's required checks now
  judge the shards with the verifier from the base branch, run none of the
  change's code, and fail when a shard executed no tests, its counts don't
  add up, or it skips tests the base always ran; a required check counts only
  from the CI workflow, never a same-named job elsewhere. A release filed
  while CI runs can't be approved by anyone until Toolroll itself saw CI pass,
  and you're asked only then. A worker that crashes while a removed project is
  still finishing recovers that project's work before anything new starts. A
  deploy waits until the console and the worker have both exited. A worker or
  console that refuses to start again stops `toolroll up` instead of
  restarting forever. A check's final progress is kept until it's saved.


- **Sandboxed commands no longer hang on macOS 26.5.** The fence denies most
  macOS system services and, by default, asked macOS to report each denial; on
  macOS 26.5.2 about one denied lookup in 70 never returned while that report
  was made, so a sandboxed `npm ci`, `npm pack` or any Node program setting up
  DNS could hang forever (a release carry until its 20-minute timeout). Denials
  are now made without the report; nothing the fence allows or denies changed.
- **The console is fast again.** 0.9.76's release-approval setting was read by
  walking a project's whole action ledger once per task row, and every page's
  sidebar runs that list four times, so each page blocked the console for about
  3 seconds (more with tabs open while anything builds). It now reads the
  setting rows through an existing index: pages went from about 2 s to about
  0.4 s on a real database. Sizing build checkouts every half hour no longer
  freezes the console either.
- **A release check's result is always saved.** The release check's streamed
  part lines now carry a tag no Toolroll version misreads as a journey's own
  line; an older console counted them twice, built a progress snapshot it then
  refused, and the refusal stopped the check's log and result from being saved
  (the check read as "unavailable"). A progress update that fails to save can
  no longer stop sealing, and a result that can't be saved says so on the run.
- **A renamed or dropped CI job no longer hides its failure.** Every failed
  attempt on a commit is judged before newer runs replace older ones, so a
  job a newer run renamed or dropped can't erase a test failure from an
  automatic approval. The Windows containment repeat job keeps one name
  whatever its count.
- **Toolroll decides what a Full release check owes.** Before the check runs,
  Toolroll works out from its own record of the last release which parts it
  owes (units, scripted and real-model journeys, upgrades), seals that, and
  tells the check, which runs at least those. Every owed part needs a result,
  whatever the check's report says it selected. CI never stands in for a
  release's unit suite, and a journey or upgrade run that listed nothing it
  ran is no result.
- **Missing evidence is unknown, not clean.** What passed only on a retry is
  sealed in the check's receipt. If a check's report is lost or damaged, its
  retries are unknown and nothing approves itself; the receipt's report and
  inventory files are checked byte for byte. A check that passed only when
  rerun after the approved setup counts as a retry, and the setup rerun only
  happens when the check never started.
- **Merging checks main on GitHub itself.** A release reads main's head and
  compares the branch through GitHub's API, never a local ref, and reads
  main again right before merging. Releases approve themselves only while
  main's branch protection requires branches to be up to date before
  merging; without it, a person's release says which setting to turn on.
  Toolroll only reads that setting.
- **No lazy fetch on any supported git.** Protected Git reads (the release's
  object reader and extraction, project knowledge and learning, the task
  base, release coverage, review screenshots, grants) run through a frozen
  copy of the repository's config on every git version, refuse every
  network transport and are time-bounded, so an include, a partial clone or
  a planted filter can't fetch, run or hang anything. The deployment script
  reads a commit's files with no filter or attribute applied. CI's oldest-git
  lane now tests git 2.41.0 exactly.
- **Main's protection must actually hold.** A release now reads main's whole
  branch protection and rulesets and counts them only when they require
  branches to be up to date, require the release's CI checks, and can't be
  bypassed by the account that merges ("Do not allow bypassing the above
  settings"; no ruleset bypass for a role, team, app or organization admin).
  A person's release names exactly what is missing, and says which new CI
  checks main's protection doesn't require yet.
- **Deployment reads only verified objects, with none of the repository's
  config.** The deployment script hashes the commit and every tree as well
  as every file against their ids, and runs git on a copy of the
  repository's layout with a config of its own, so a corrupted tree, a
  config change mid-read or a custom transport helper can't substitute files
  or fetch anything.
- **An unreadable last release never shrinks a check.** When the last
  release Toolroll recorded can't be verified, the release check doesn't
  run and says so, and the release card's change list reads "couldn't be
  read", instead of acting as if there were no previous release.
- **Setup recovery needs proof the check never started.** The approved setup
  reruns a check only when Toolroll itself found the check's program missing
  before starting it and the shell said exactly that and nothing else. Any
  other failure is the check's own result for a person to judge, and a
  release after a setup rerun says why the first attempt failed.
- **Dispatch and coding handoffs can't be held up by a project's Git
  config.** The worktree binding reads Git's registry as plain files, and the
  handoff's branch read is bounded and runs outside its database
  transactions.
- **A release check that's cut short still leaves its evidence.** Every
  part of the release check (typecheck, build, units, journeys, upgrades)
  now prints its output as it runs, each line tagged with its part (and
  upgrade version), instead of only at the very end. Each part's end is
  recorded with its start time, exit code, signal, timeout and whether it
  was stopped, and a failing upgrade version's own log is printed the moment
  it fails. Release check 3261 was stored as "exit 1" with nothing but its
  header: a signal had ended it, the plane recorded the signal as a plain
  exit 1, and the parts' output was still waiting to be printed. A command
  ended by a signal, or by Toolroll's own shutdown, now says so.
- **No complete result, no pass.** A release's Full check counts only with
  its valid report (carrying that run's secret), a result for every part,
  unit file, journey group and upgrade version it owed, and a successful
  exit. A missing, malformed, cut-short or incomplete report is an error
  ("no result"), never a pass.
- **Failures are classed, and only Toolroll's own infrastructure is rerun.**
  The flat "two flakes" allowance is gone. A failing test, typecheck, build,
  attack test or upgrade is never rerun to pass: fix the branch. A failure
  Toolroll itself confirms as infrastructure (the check never started, the
  worker lost the build, Toolroll's shutdown stopped it, or a GitHub job
  whose runner failed before any of its steps ran) is checked again on the
  same commit under the same approval, at most once per incident and twice
  per commit, with no new approval. An unexplained failure blocks: a
  diagnostic rerun may run, but its pass doesn't erase the failure, so you
  decide. Real-model journeys are counted, never rerun until they pass, and
  one that passed only on a retry is now reported (an automatic approval
  won't approve it). `toolroll release` says which of these happened and
  what to do next, instead of always asking for `--new`.
- **A password that starts with "--" works on the command line.** About one
  minted password in 4096 began with "--", and `toolroll release publish-ok`
  (and other commands) read it as a missing value. A `--token` or
  `--password` value is now always the next argument, `--token=<value>`
  works everywhere, and new passwords, invites and tokens never start with
  "-".
- **CI tests the commit a release trusts.** Every pull-request job now checks
  out the pull request's own head commit, not the merge commit GitHub makes,
  and proves it before building.
- **Git 2.41 or newer is required, and tested.** Toolroll's hardened git reads
  need `git --attr-source`, which arrived in git 2.41. `toolroll up`, `serve`
  and `watch` won't start on an older git, and `toolroll doctor` names it,
  each with the installed and the required version. Git 2.41 to 2.44 has no
  `--no-lazy-fetch`: there Toolroll leaves it out and instead refuses a
  project that is a partial clone for protected reads ("this project is a
  partial clone; protected reads need git 2.45 or newer"), judged from the
  frozen copy of the config git then runs with (never checked, then run),
  and every read still refuses all network protocols.
  Two CI jobs run the git attack and worktree tests on git 2.41 and 2.47, as
  an unprivileged user, fail if any test is skipped, and are now required
  for a release.
- **A release branch must contain main.** CI tests the pull request's own
  commit, so `toolroll release` refuses a branch that doesn't contain main's
  head ("the branch is behind main; update it and push"), at the gate before
  anything is filed and again right before the merge.
- **Tests can't lean on a guessed git identity.** Each test's home tells git
  never to guess a name and email from the host, so a test that commits
  without setting one fails on a Mac just as it would on Linux CI.
- **Two timing-sensitive tests now wait for events.** The read-worker test and
  the watch recovery test no longer fail when a busy machine runs slowly.

## 0.9.76 — 2026-10-28

- **Releases can approve themselves when they're green.** A new per-project
  setting, **Release approval: Ask me / Approve automatically when checks
  pass**, is off by default. Turning it on takes your typed password;
  turning it off takes one click and withdraws every automatic approval not
  yet merged. When it's on, a release task first reads "Checking
  automatically" (`auto-check`), which lets its release check run and
  nothing else. Once GitHub CI and the release check both pass on the exact
  candidate, it approves itself (`auto-green`) and the release continues as
  after your yes. You're told, not asked.
- **What an automatic approval must prove.** Up to two failed attempts per
  CI job, and two failed release-check builds on the same commit, are
  tolerated as flakes. Past that it asks you. The change must touch only
  allowed paths: product code and its tests, test files under `test/`,
  docs, the changelog and a version-only `package.json` bump. Scripts, CI,
  configuration, dependencies, policy files and test helpers (found from the
  tests' own imports) need a person. CI is read again before the deploy, the
  CLI switch, the merge and the tag. Anything not green stops the release,
  withdraws the approval and tells you.
- **A red CI after the merge holds publishing.** No tag, npm publish or
  Homebrew update happens until a person runs
  `toolroll release publish-ok <task>` with their password.
- **Stricter CI verdicts on every release, yours too.** Only checks on the
  exact head count. Required checks must come from GitHub Actions, so
  another app's same-name success can't hide a failure. A newer run of the
  same workflow supersedes its older runs on the commit.
- **Toolroll's own git on agent checkouts runs against a frozen view.**
  Every git command the plane runs on a checkout an agent wrote (staging,
  committing, cleanup, pool refresh, scouts, planners, coding sessions, page
  reads) runs against a private copy of the repository's settings taken
  once. Changes the agent makes to them afterwards are never read.
- **Git settings are denied by default.** Only audited config sections and
  variables pass. Aliases, URL rewrites that reach remote helpers, empty
  filter names and `hook.*` are refused. Writes allow no network transport.
  Local git-lfs installs still work.
- **Writes are bound to the project's recorded repository.** A checkout
  whose `.git` points anywhere else is refused. Before git writes through a
  view, every path it could write is walked for links and hard links. Plane
  git writes on one checkout run one at a time. On git before 2.48, a
  checkout added through the view is pointed at its repository, not at the
  view.
- **A git incident is recorded and you're notified.** A swap seen after git
  ran is logged and raised as an attention notification. The notification
  names the project by Toolroll's own record, never by a path the agent
  chose.
- **`discover --dirty` reads repositories through the same hardened git.**
- Database: schema v136 (unchanged).

## 0.9.75 — 2026-10-27

- **Opening a page only shows it.** Pages no longer run checks, tidy up or
  call out as you open them. Sign-ins, integrations, update checks, storage
  and Codex's tools are checked in the background, and Models, Updates,
  Storage, Pull requests, Tools, Project setup and the GitHub listing show
  their last answer and when it was checked, with a **Check now** button to
  ask again. On a coding session, **Review for shipping** and the changes
  view are buttons, so a link preview or prefetch can't run them. Reading a
  checkout an agent wrote never runs that checkout's own git settings.
- **Reading an agent's checkout can't be raced into running a filter.** Git
  reads the checkout through a private copy of its settings taken once, so a
  filter the agent adds to its git config and `.git/info/attributes` after
  that copy never runs.
- **The task card never contradicts itself.** One answer to "did the
  approved check pass" across the task page, the road, the Tasks list, the
  result page and chat. A check whose saved log can't be read is never
  shown as passed, and a check whose command was approved again since it ran
  says so: "The check command changed since this check; run checks again."
- **Lead-filed runs nest under the lead on Agents → Live.** Runs your own
  lead filed sit under its tile. Once its turn has gone, they stay grouped
  under a quiet "Filed by lead chat" header. The lead's full screen lists
  every task it filed. Only you see what your lead filed.
- **The lead passes asks to a helper instead of answering for them.** "Ask
  Maya to …" now reaches Maya even when she seems to lack a tool or the
  knowledge for it; she says so herself or asks you first.
- **A helper's "can't" reaches whoever asked.** When a helper can't do
  something asked at its desk, its note (or its reason) goes back to the
  person or agent who asked, instead of waiting in an inbox.
- Database: schema v136 (unchanged).

## 0.9.74 — 2026-10-27

- **Agents → Live: every agent and subagent at a glance.** A read-only grid
  of everything running, on desktop and phone: what each agent is doing
  right now, how long it has run and its latest lines. Subagents get their
  own tiles nested under their parent; they appear when they start and show
  Done for 30 seconds before leaving. A quiet agent reads **Needs you** with
  a thin amber outline. Click a tile's title to open it full screen (Escape
  brings you back). Your own lead chats show as lead tiles. Nothing on the
  page acts, and the grid holds still while you look at it. Terminals you
  drive yourself stay off the grid; one line links to Live terminals. Only a
  signed-in browser can read it: tokens are refused.
- **Visiting a page starts nothing.** Opening Chat, a task, a result or a
  project shows the page with a ready composer; your first message starts
  the conversation. A retry or double submit lands in the conversation it
  started. Link previews and prefetches can't start one.
- **A cleaner console.** One status chip everywhere, framed panels on the
  Board, Settings, Knowledge and Projects, and a road on every task (Plan →
  You approve → Build → Checks → Ready) built only from what happened.
  Attempts show as a timeline and warnings as plain notices. Amber now means
  only "waits on you". Built from ReUI's free, MIT-licensed components
  (credited in THIRD_PARTY_NOTICES.md).
- **The old task list is retired.** `/tasks` now opens Work, which gained a
  state filter (`/work?state=`), templates (`/tasks/new?template=`) and keeps
  your draft when a filing is refused.
- **Rerunning a failed release check keeps your approval.**
  `toolroll task regate` queues the same approved commit again instead of
  re-filing it, and `toolroll release` waits for the rerun and uses it. A
  changed commit, scope or approval still refuses.
- Database: schema v136 (each run's "Show commands" answer is kept for the
  live view).

## 0.9.73 — 2026-10-25

- **Carry release approvals when checks aren't sandboxed.** A project whose
  checks run outside the sandbox (like Toolroll's own release project) can
  let later test-only commits carry a release approval:
  `toolroll release unsandboxed-carry on --repo <path> --as <you> --token
  <password>`. It is off by default; only a person turns it on, and it counts
  only for releases approved while it is on. The approval sheet says plainly
  that those later commits will run outside the sandbox without being shown
  to you first. Every other carry rule stays: tests and docs only, the
  400-line, 20-file and 800-line-churn limits, an identical production build,
  and main's open nightly failures. Turning it off, or checks that reach
  further than at the approval, stops carrying.
- **`toolroll release` stops at the gate when the pull request's checks
  fail.** Before it files the release task or asks for your approval, it
  reads the required checks on the exact commit. One that failed or was
  cancelled stops the release with the failing job names, so you aren't
  asked to approve a commit that can't merge. Checks not started or still
  running are named and waited for; if they don't finish within the gate's
  limit (60 minutes, `--limit gate=<min>`), it stops there too. The ci step
  still checks every one again before merging.
- **Chat apps, browsers and password managers are off limits to every
  launch.** Builds, checks, flows, tool servers and coding sessions can't
  read or write where Slack, Telegram, Discord, Teams, WhatsApp, 1Password,
  Bitwarden, or the Chrome, Chromium, Brave, Edge, Arc, Firefox, Zen,
  Vivaldi, Opera, Orion and Safari profiles keep their data, on macOS and
  Linux, under both sandbox versions and in Codex's sandbox. This covers the
  folders by name and by real path, links inside them, and a moved profile
  or config folder named in the environment. No project setting reopens
  them, and those apps' variables (SLACK_, TELEGRAM_, DISCORD_, TEAMS_, OP_,
  BW_, BITWARDENCLI_) are removed from every launch; a tool server keeps the
  secrets it names.
- **`toolroll release` runs Git safely on the release checkout.** The release
  used to run plain Git there, so a setting planted in the checkout's Git
  config (an include, a hook folder, an ssh command, a proxy, a URL rewrite
  and the like) could run a command or send the gh token elsewhere. Now it
  uses the repository and GitHub URL from Toolroll's own records, runs Git,
  gh and ssh by absolute path with a fixed environment, pins HTTPS settings
  on the command line, and allows only the plain settings Git writes itself.
  Any other setting stops the release and names it. The checkout must be a
  project Toolroll records, with a recorded remote.
- **Widening actions take your password.** Setting the permission default to
  Full access, giving a subagent a tool, loosening a tool rule, accepting a
  subagent's suggested looser rule, and adding a trigger that brings in work
  from anyone (GitHub from anyone, mail from any sender, from the Triggers
  panel, a gallery template or a starter kit) now ask for your password (a
  signed-in session does under Passwordless). Narrowing needs none. A chat
  card, import or template can no longer do any of these; it points to the
  page that can.
- **Approving a release from chat shows the whole release first.** A tap
  approves a deploy only through the release card: every signed term and
  release term, one line each (it says so when later test-only commits
  will run outside the sandbox), and the commits since the last release
  Toolroll recorded as merged. Continue sends the terms (as a file where the
  chat app allows), and Approve is bound to exactly what was shown;
  anything changed in between refuses with the new card. It works only in
  your own private chat (Telegram or a Slack direct message); a group,
  someone else's chat, Discord and Teams are refused. Each such approval is
  announced to you, naming the chat app.
- **Network, writes, check access and sandbox settings stay on the typed
  password under Passwordless,** and a test now fails if one moves to the
  ordinary signed-in step-up.
- **Launches don't wait on macOS's "access data from other apps" prompt.**
  Toolroll looks inside other apps' containers only after a 3-second look in
  a separate process shows macOS lets it, so a service run by launchd no
  longer hangs every fenced launch. While macOS is still asking, the
  containers stay denied by name and real path, and the links found by the
  last full look stay denied; a look that fails for any other reason refuses
  the launch.
- **The release check ends itself before its time limit,** stopping the
  parts still running and keeping every log and its report, and a failed
  part's log reaches the run's output as soon as it fails.
- **`toolroll release` rides out short GitHub network timeouts** while a
  step waits, asking again until that step's own limit.
- No database change: the schema stays at v135.

## 0.9.72 — 2026-10-25

- **One approval per release.** A person approves a release once. Later
  commits on the same pull request carry that approval only when every change
  since is unit tests, journey scripts, Markdown under docs/, the README or
  the changelog, within 400 changed lines, 20 files and 800 lines of churn,
  and the production build is byte-for-byte the approved one. Anything else
  asks again, and so does any change after the deploy has started. The
  approval sheet states the release and what asks again; the release summary
  and the squash message list every commit that landed after the approval.
  **Stop carrying later commits** on the task page (or `toolroll release
  revoke`) ends it, and `toolroll release ask-every-commit on` makes a
  project's releases ask for every commit. A release approval expires after
  3 days.
- **Re-checks of a release re-run only what failed.** On the second and later
  release checks, only the failed unit files, journey groups and upgrade
  versions run again, with every test changed since and a short sanity pass.
  A check that can't prove it covered everything counts as failed, and a
  test that disappears or is newly skipped stops carrying.
- **A nightly full check of main.** `toolroll release nightly --repo <path>`
  sets up a daily full check of main (03:00 local by default). A failure
  becomes an attention notice naming what failed, holds re-checks that run
  only part of the suite until a full check passes it again, and a nightly
  that hasn't run for 26 hours says so.
- **Sandboxed checks can start Chromium on macOS.** Playwright's default
  browser (its Chromium headless shell) now starts inside the check sandbox:
  the sandbox may register and look up Chromium's port rendezvous service,
  `org.chromium.Chromium.MachPortRendezvousServer.<pid>`, and nothing else.
  Builds, flows and tool servers don't get this; SECURITY.md says what a
  hostile check could do with it. A project set to **Not sandboxed** only for
  a headless browser check can go back to **Sandboxed** in Settings → Project
  → Check access. Chrome for Testing (`channel: "chromium"`, headed runs)
  still needs **Not sandboxed**.
- **Checks with sign-ins no longer reach your keychain.** Toolroll reads
  Claude Code's and gh's sign-ins from the keychain itself, outside the
  sandbox, and hands the check just those tokens in its environment. A check
  gets Claude's current access token and can't renew it.
- **A wrong password on an approval says "That password didn't match."**
  instead of "not approved: not-an-approver". Someone who isn't an approver
  gets the same answer.
- **Closing a live terminal signals only its own processes.** It stops them
  before it kills them, so a child one starts at that moment can't slip out
  from under the close; each signal goes only to a process still the one it
  saw (same pid, same start); and after the program ends, its terminal's
  name no longer counts as proof, since the device may already be someone
  else's. A process it can't prove is its own is never signalled, and the
  close says it's uncertain (the worktree stays).
- **Only a person approves work.** The lead's token used to approve a task's
  scope and be recorded as its owner's password approval, including on a
  release. Now `task approve` (and `task repair --yes`) with a lead token, or
  any approval made with a remote API token, is refused: "Only a person can
  approve this." Approve on the task page or from your paired chat
  (docs/plans/approval-policy.md, phase 1; the setting that lets the lead
  approve, recorded as the lead's, comes next).
- **Only a person merges by hand.** `task merge` (including `--anyway`) and
  the merge button refuse a lead or API token. A flow's Pull request zone
  merges only after a person's recorded decision; a subagent's approval, or
  a decision from before decisions recorded who made them, waits.
- **Protected work counts only people.** A vote a machine credential left, or
  one with no proof on record, doesn't count as one of the two people, and a
  lead or API token's completion is never the second person. A person can
  mark an already-complete result complete again to release a held push.
- **Releases and deployments need a person's approval with its proof on
  record.** The release gate and `deploy-browser.mjs` (every phase, resumed
  ones included) refuse an approval a lead token made, a mode, a flow, a
  standing order, or an approval with no recorded proof. `toolroll release` proves the
  candidate in its own runtime, and that the checkout is exactly that commit,
  before it runs anything from the candidate's checkout. Paired-chat
  approvals now record their own proof, so they still count. Update the
  plane before running `toolroll release`: an older plane can't say who
  approved, and the release waits.
- Approvals a lead token made before this change are read for what they were:
  they no longer dispatch, and the task asks for a person's approval. Seals
  with no recorded authority stand on nothing. A standing order's firing is
  approved by its own authority (`schedule`), which stands only while its
  approver can still approve in the project.
- Schema v134 and v135 only add columns and tables; `toolroll update` runs
  them in place.

## 0.9.71 — 2026-10-25

- **Sandboxed launches can open a terminal of their own on macOS.** A check
  or build that drives a pseudo-terminal (node-pty, `script`, a test that
  runs a shell) now works inside the sandbox. Only terminals the sandboxed
  process made itself open: Toolroll doesn't turn on the sandbox runtime's
  `allowPty`, which also opens your other open terminals, and it now denies
  reading those by name, which the runtime's baseline allowed. Nothing
  sandboxed can type into a terminal, and every sandboxed launch starts in a
  session of its own, so a console started from your terminal doesn't hand
  it that terminal.
- **Only a build's agent reaches your keychain.** The sandbox runtime lets
  every sandboxed process ask macOS's keychain service, so it could read
  keychain items any program may read (anthropics/sandbox-runtime#755). A
  build's setup and check commands, a project's checks, flows and tool
  servers are now denied it. A build's agent keeps it (Claude Code signs in
  from the keychain), and so does a check whose project gave it
  **sign-ins**, while the instance operator who chose that still is one. The
  sign-ins choice now says it includes Keychain access.

## 0.9.70 — 2026-10-24

- **Every sandbox is now Anthropic's sandbox-runtime.** Builds, their setup
  and check commands, a saved result's checks, flows and project tool servers
  all run in `@anthropic-ai/sandbox-runtime` 0.0.79, the same sandbox Claude
  Code uses: its own code writes the macOS Seatbelt profile and the Linux
  bubblewrap and seccomp command for each launch. Toolroll hands it only a
  short list: its own folders and database are off limits, the build's
  checkout is writable, other tasks' checkouts are read and never written,
  your project's read-deny list, and the run's proxy as the only way out.
  `toolroll doctor` and Settings → Project → Home folder name the engine and
  its version. Codex builds keep Codex's own sandbox with the same rules.
- **Checks that start Chrome don't run sandboxed on macOS yet.** The sandbox
  runtime has no setting for the service Chromium registers at startup, so a
  Playwright or browser check fails inside it. Until a follow-up adds that one
  rule, set such a project's check access to **Not sandboxed** in
  Settings → Project → Check access.
- **Your home folder is readable to new scopes, as in the sandbox runtime.**
  A project hides what it wants back with Settings → Project → **Home
  folder**, or `toolroll project sandbox --repo <p> --read-deny "~/.ssh"`.
  Each approved scope seals its list. Scopes approved before 0.9.70 keep
  hiding your credentials and agent settings, as they were approved.
- **The macOS services a project's builds may also reach** (`--mach`, for Go
  tools that verify TLS through trustd) seal only on a person's password.
  Approval cards and the CLI's scope view say what a scope reads and which
  services it adds.
- **Checks can use your Claude, Codex and GitHub sign-ins again.** The
  "Sandboxed, with model and GitHub sign-ins" level is on: a check reads
  exactly those files, by name, inside its sandbox, never through a link.
- Flows, tool servers started outside a build and interactive Codex coding
  sessions now run in the same sandbox as builds. A machine that can't
  sandbox runs none of them unless an instance operator allowed unconfined
  agents.
- On Linux the sandbox needs bubblewrap, socat and ripgrep; without them
  nothing starts (as before, unless unconfined agents are allowed).
- A result that adds or changes a Git hook or config, editor or Claude
  settings, a shell profile, `.envrc`, `.npmrc` or `.mcp.json` is refused at
  the handoff, with its work kept. Toolroll's own install and the sandbox
  runtime can't be written from inside a sandbox.
- The scout's browser runs outside the sandbox, as an explicit exception: a
  pinned Playwright release installed from a lockfile into Toolroll's own
  folder, with exactly the arguments and environment it was approved with.
- Limits that come with the sandbox runtime: rules are fixed when a launch
  starts, concurrent builds share its temp folder, and on macOS a build can
  read another process's arguments and environment. Write unlocks for
  protected files are gone (the runtime can't grant them).

## 0.9.69 — 2026-10-23

- **Choose how far a project's checks reach.** Settings → Project has a new
  Check access section, and `toolroll project check-access --repo <p>` shows
  or sets the same thing. **Sandboxed** (the default) runs a project's setup
  and check commands in the plane's fence, as before. **Not sandboxed** runs
  them with your full access, as before 0.9.66: for a project whose checks
  must create sandboxes themselves, such as Toolroll's own.
- Widening takes an instance operator with their password typed now (a
  remembered sign-in or a single sign-on recheck doesn't count). Any approver
  for the project can narrow it back. Each change is in the ledger.
- The level is part of what you approve. A scope seals it, the approval card
  says "Checks: not sandboxed", and tasks already approved keep the level
  they were approved with. Each run records the level its checks actually ran
  at, and the result page says when they ran without a sandbox. Later checks
  of a saved result never run wider than that run did. A mode, a grant or a
  chat confirmation can't approve a wider level; only a person's password can.
- **A third level, "Sandboxed, with model and GitHub sign-ins", is built but
  off.** It would let a check read your Claude, Codex and GitHub sign-in files.
  Reading those files safely needs a way to open a file that a running build
  can't redirect partway (Node can't do that yet), so the option is shown
  disabled with the reason. Choosing it is refused, and a level saved before
  runs sandboxed and says so.
- **The fence holds your home configuration by name.** `~/.codex`,
  `~/.config/gh`, `~/.ssh` and the rest are denied whether or not they exist
  when a build starts, so a build can't create one or swap it for a link
  later. The folders above them can't be renamed or made during a build.
- A check's temporary folder on a Mac is now short (under `/private/tmp`), so
  tests that open a unix socket there work inside the fence. Other launches'
  folders stay out of reach.
- With no OS sandbox on the machine and unconfined running allowed, the
  settings page and `project check-access` say checks run without a sandbox,
  whatever level is saved.

## 0.9.68 — 2026-10-23

- **The lead chat is redesigned.** Your messages sit in grey bubbles and the
  lead's replies read as plain text, with code blocks. Its work folds into one
  "Worked …" line, live steps show a spinner and then a check, and anything
  waiting on you carries a "Needs you" chip. The message box is one row that
  grows as you type, with a send arrow (Queue while a reply runs).
- **Comment on a line of a change.** In a result's Changes tab, a pin on any
  line opens a one-line comment. Enter sends it to the lead as its next
  message, naming the file, line and run and quoting the line. The thread
  shows it as a reference, the quoted line, and your words. On a phone the
  result opens as a sheet over the chat.
- **A fenced check can build bundles from the shared dependencies.** On a Mac
  the sandbox let a build look up the linked copy's folder but not list it,
  so esbuild couldn't find node_modules ("could not resolve react"). That one
  folder may now be listed; nothing in it is readable beyond node_modules.
  The console's own browser build also resolves through the checkout's links.
- The release check passes inside the plane's macOS check sandbox: tests that
  need to create a sandbox or watch other processes skip there and still run
  in CI, and the browser journeys' throwaway planes run their agents inside
  the check's own sandbox.
- A Claude build no longer refuses to start when a sandbox around Toolroll
  hides your Claude settings file: it signs in from the keychain as before,
  and a sign-in that needed the file still fails quickly and says so.
- The test suite reads its own home and temp folders, never yours, so it runs
  the same on your machine and inside a check's sandbox. Tests that need a
  socket path shorter than any folder the sandbox allows, and the one browser
  journey that resumes a saved Claude session, skip inside the sandbox and
  still run in CI.
- `toolroll release` no longer stops at merge when GitHub has already deleted
  the merged branch: it looks a few times, 2 seconds apart, before calling the
  delete a failure (0.9.66 and 0.9.67 both stopped there).
- Leaner code, with every feature kept (about 5,600 fewer lines). The
  deprecated team and native session commands are gone, and `chat` and
  `brief` without `--local` refuse when a central profile is saved.

## 0.9.67 — 2026-10-23

- **A project's checks read their own dependencies again.** 0.9.66 began
  running checks in a fenced checkout but left out the grant for the shared
  install the checkout links, so any check that loaded a package failed
  ("could not resolve"). The linked copy is readable again; others stay fenced.
- **Builds that write only their workspace resolve host names again on a
  Mac.** 0.9.66 denied every unix socket to such a build, including the
  system's DNS service, so with an open network nothing resolved (npm, git,
  any fetch failed with "could not resolve host"). The DNS socket is allowed;
  every other socket stays denied.
- 0.9.66 as released to the console, published: its macOS check failed on a
  test whose socket path outgrew macOS's 104-byte limit in the runner's temp
  folder. The test now makes its sockets under /tmp. The browser journeys'
  model stand-ins also keep their call journal where a workspace-only build
  may write, so the release check runs them under the default sandbox.
- `toolroll project network` takes `--open` and `--allowlist` again, and
  reads `--remove <hosts>` and `--local any|none` as values: the shared flag
  parser had refused the first two and read the others as switches.

## 0.9.66 — 2026-10-22 (tagged, not published)

- **The board is live to watch.** A strip of workers sits above the lanes:
  what each is building on this board, its stage and a running clock (or
  offline, or no build here). A card that changes lane slides there, a new one
  drops in, and a worker that picks up work lights up once — all off under
  reduced motion. Building cards show three quiet steps (setting up, writing,
  checking and committing) from the run's own phase, never a percent. On a phone
  the lane sections now use the full width.
- **Builds write only their workspace.** A new per-project setting (Settings →
  Project → Where builds write, `toolroll project writes`), sealed into each
  approval: by default a build writes only its checkout and commit data, the
  project's package caches, its temp folder and its agent's session files —
  never your shell profile, login items, agent settings or the repository's Git
  config and hooks. `anywhere` keeps the old behaviour; approvals from before
  keep it too. Enforced by Seatbelt, bubblewrap and Codex's own profile.
- **Setup and check commands run in the build's fence**, with their own temp
  folder and the project's caches.
- **The plane's Git on a build's checkout runs hardened** (no hooks, fsmonitor
  or submodules) and refuses a checkout whose config names a command.
- **Tool servers start outside the checkout** and never run a file the build
  wrote.
- **A live terminal comes back as its screen.** The server keeps each
  terminal's screen (a headless xterm), so a page that reconnects gets the
  screen, its last 5,000 lines and its modes — a full-screen program like
  Claude Code or Codex redraws whole, never from a raw replay cut mid-sequence.
- **Terminals draw on the GPU** where the browser allows (falling back when it
  doesn't), with Unicode 11 widths for emoji and wide characters.
- **`toolroll release` finishes when GitHub deletes the merged branch
  itself.** A delete that fails because the branch is already gone counts as
  done; one that fails while the branch is still there still stops.
- **`toolroll release` merges a Homebrew tap that runs no checks on a
  change.** It no longer waits out its time limit for checks that will never
  come. Any check run or commit status that does appear is still judged (each
  app on its own), and a tap whose workflows run on pull requests still needs
  its own GitHub Actions run to pass.

## 0.9.65 — 2026-10-22

0.9.64 was tagged but never published: a macOS check failed on Node 24.
0.9.65 is the first published release with everything listed under 0.9.64
below, plus:

- **The release check's upgrade test** skips a tagged release that never
  reached npm, instead of failing to install it.
- **A Linux build's network bridge always fits a socket path.** When the
  plane's own folder is too deep for one, the bridge goes in the system temp
  folder, which a confined Linux build never sees (its `/tmp` is its own).

## 0.9.64 — 2026-10-22

**Upgrading:** builds now reach only the network their approval allows
(below). On a Mac, a project whose tests start a local server needs
**Settings → Project → Network → local services** turned on. A machine with
no OS sandbox (Windows, Linux without bubblewrap) no longer runs builds
unless an instance operator allows it (`toolroll config unconfined-agents`).

- **Builds reach only their approved network.** Each approved task seals
  what its build may reach: the agent's provider, the package registries
  the project uses, and hosts you add in **Settings → Project → Network**
  (or `toolroll project network`). The OS sandbox refuses everything else,
  name lookups included; a result's **Network** row shows what the build
  connected to and what was refused.
- **Agents you can watch.** A light cockpit with each task's agent lanes,
  the live conversation in time order, and real terminals for running
  builds.
- **ACP agents.** OpenCode, Cursor, Cline, Qwen and Goose can build, each
  checked on this machine before it takes work.
- **Passwordless mode.** Signing in is the only password; credential
  changes still ask for it.
- **One page per task and agent**, with Activity, Result and Plan tabs and
  one ⋯ menu.
- **Lead sweeps.** One card and one yes start many isolated tasks, tracked
  in one table.
- **The lead queue.** Messages sent while the lead answers wait their turn.
- **Lead tools on demand**, with prompt caching: smaller, cheaper turns.
- **How it ran.** Every result shows time, turns, tokens and cache use.
- **Signed webhooks become tasks.**
- **Phone keyboard.** Chat and text boxes stay above it; Return writes a
  new line on a phone.
- **A calmer UI**: one button style, theme tokens, status glyphs and a Crew
  rail.
- **`toolroll release` finishes**: a release build is recorded as a commit of
  its own holding exactly the candidate's files; the release now accepts it
  by its files and deploys to it, instead of stopping at the check.
- **Release check** sizes itself to the machine; deploys keep hidden table
  ids and find dependencies behind macOS's temp-folder link.

## 0.9.63 — 2026-10-13

- **Scheduled flows run on their own.** Sign a flow once with limits
  (runs a day, budget, end date); its on-time firings build without a
  person, and the script it runs is checked again when it fires.
- **Secrets in the OS keychain.** Tool keys, the Linear key, Google mail and
  flow secrets move into the macOS Keychain or Linux Secret Service, never
  argv or the database. OAuth tools give each run a short-lived token, never
  the refresh token. Settings shows how each tool's runs get credentials.
- **Builds stay in their own checkout.** A build can't read or write another
  project's or another task's checkout, and a checkout swapped for a link
  is refused at the next launch.
- **Safer cleanup.** Removing finished checkouts runs git with hooks,
  filters and nested-repo config switched off.
- **Attack suite.** Every bypass found in review is a permanent test, run by
  the Quick check whenever sandbox or secrets code changes.
- **Tool secrets stay outside the build.** A broker outside the sandbox
  holds them. Codex refuses tools that carry secrets. Shared dependencies and
  `git gc` work inside the fence.
- **Tighter sandbox.** Builds can no longer rename folders above protected
  paths or inspect other processes' memory; tool servers get only the
  environment they need.
- **Tools with secrets need the macOS sandbox.** A build without it, and
  every build on Linux, leaves those tools out and says why.
- **`toolroll doctor`.** Checks that Toolroll's service holds no key a build
  could read, and lists the steps to fix it. It reads only.
- **Research tools answer every refusal**, even when the service accepts the
  rest with an empty reply.

## 0.9.62 — 2026-10-12

- **Release checks in minutes.** The upgrade path runs on a sample, CI's
  passing run on the exact commit is reused, and the first failure stops it.
- **Storage sweep waits for quiet.** It runs when nothing is building, and
  Settings → Storage says when it last ran and why it waits.
- **Landing proof you can trust.** A task completes on its own only for a
  merged pull request or the project's recorded remote main, never a local
  branch a build could move. Projects added before this need it once: you
  (the owner) or an instance operator's lead runs
  `toolroll repos add <project> --remote <url>`. Until then, their tasks wait
  for you.
- **Cleanup follow-ups.** Only branches Toolroll created are removed, counted
  from when it made them; scout branches stay, and duplicate teardowns merge.
- **Fresh base.** A task with no commits starts from current main; the task
  page shows its base.

## 0.9.61 — 2026-10-12

- **Agents board.** One place to check on running agents: Needs you,
  Working, Stuck, Done and Idle, live on desktop and phone. Agents can ask a
  question mid-run, and you reply from the board.
- **Steer in seconds.** A note reaches a running Claude build within seconds.
  Pause, Resume, and Pause and steer sit beside Stop.
- **Builds run on their own setup.** Your personal Claude hooks, plugins, MCP
  servers and memory no longer load into builds.
- **The sweep can't stop builds.** Storage cleanup runs in its own process
  with a time limit, and never removes what a build is using.
- **Finished work cleans up.** Tasks whose work has landed complete on their
  own, and their checkouts and branches are removed.
- **Release checks test everything since the last release.**

## 0.9.60 — 2026-10-11

- **Steer a running build.** A note now reaches the agent while it works, and
  shows when the agent has read it. Notes it misses go to the next attempt.
- **One inbox for the lead.** Every update, including cancellations, reaches
  the lead through one inbox.
- **Lighter status work.** Status sweeps skip when nothing changed, and
  `--version` and `--help` answer instantly.
- **Signal tokens.** The console's colours and type come from the generated
  Signal design tokens.

## 0.9.59 — 2026-10-10

- **Safer deploys.** A deploy that fails before the swap releases its own
  lock. A stranded lock clears with one guided command.
- **Planning restarts on a new scope.** Changing a task's scope restarts its
  planning. Cancelling a task closes its open questions.

## 0.9.58 — 2026-10-09

- **One token kind.** Personal, lead and coordinator tokens now live in one
  table with one check. Existing tokens keep working.
- **Sessions join the CLI API.** The sessions API is now part of the CLI API.
- **Passwords as tokens warn.** Sending your password as a token still works
  this release but warns. Create a token with `toolroll tokens create`.

## 0.9.57 — 2026-10-09

- **Truthful status.** Finished tasks read Complete everywhere. With checks
  off, criteria read "checked at release" instead of Needs you.
- **No false finish.** Completing or deploying refuses a failed or missing
  check, an unmet criterion, a serious review finding, or missing evidence.
- **Clear revisions.** Revisions are named after their task: -v2, -v3.

## 0.9.56 — 2026-10-09

- **One lead.** Your assistant in the console, on your phone, in chat and in
  the CLI is the same lead. Teammates are now its subagents, with their
  personalities and rules: "ask Rosa to…", or from a flow step.
- **Retiring soon.** The central team service and native coding sessions are
  hidden and warn when used; they are removed next release.
- **Fresh baseline.** New installs start from a baseline schema. Databases
  older than 0.5.0 are asked to update through 0.9.x first.

## 0.9.55 — 2026-10-09

- **One door per route.** Every page's access comes from one table with one
  handler each; pages escape automatically and forms carry CSRF protection.
- **One live stream.** It re-checks your session and project access before
  every update.
- **One-command release.** `toolroll release <branch>` runs a whole release
  after your scope approval and never merges on pending or failed CI.

## 0.9.54 — 2026-10-09

- **One chat core.** Telegram, Slack, Discord and Teams now share one chat
  core, and 70 old chat tables are gone.
- **Nothing to redo.** Chat history and pairings carry over on upgrade.
- **Consent stays put.** An existing approval consent still covers only the
  chat providers it named.

## 0.9.53 — 2026-10-08

- **Fewer features to learn.** Contests, held sessions and fallback chains
  are gone. Routines are now scheduled flows; existing routines migrate,
  paused, and `toolroll routine` points you to flows.
- **Schedule limits hold.** Moving a flow card can't reset its spending or
  single-flight limits.

## 0.9.52 — 2026-10-07

- **Smaller database.** Process logs are compacted after each run, so the
  database file shrinks (one install went from about 116 MB to 26 MB), and
  backups shrink with it. The action ledger is checkpointed automatically.
- **Lighter under the hood.** Update checks read history with bounded memory,
  and live views update without database triggers.
- **Honest release check.** It runs every unit test on 8 workers, and its
  tests check behaviour at runtime instead of reading source text.
- **Webhook alerts keep working.** Legacy Slack and Discord webhooks still
  send this release, with a notice pointing to Chat settings.

## 0.9.51 — 2026-10-07

- **No lockout by username.** Wrong passwords slow the source that sent them,
  not the account. A device you've signed in on always gets through.
- **Guessing stays bounded.** Rotating addresses can't buy more guesses at an
  account, and IPv6 addresses count per /64.
- **Usernames stay private.** Real and made-up names answer the same way,
  even after a flood.

## 0.9.50 — 2026-10-07

- **One route policy table.** Every route's access rules live in one table,
  checked before any handler runs. Undeclared routes are refused, approvals
  are browser-only, and read tokens can't change anything.
- **Server split by area.** The server code now lives in smaller modules.
  No behaviour change for users.

## 0.9.49 — 2026-10-07

- **Tokens keep their limits.** A token's scope and project limits now hold
  on every remote route.
- **Browser login for step-ups.** Approvals and other password step-ups need
  a browser login. OAuth refuses plain HTTP off loopback or your tailnet.
- **Request budgets everywhere.** Budgets cover every remote route, and fake
  account names can't lock anyone out.

## 0.9.48 — 2026-10-07

- **Instant live views.** Changes reach open pages in about 2 ms (was about
  half a second). Idle pages cost the server nothing. A slow connection is
  told to reload instead of freezing.
- **Faster under load.** With 20 people and 50 agents busy, the slowest 1%
  of requests drop from about 17 s to 0.3 s, with no dropped requests. The
  task list now builds off the main thread.
- **`toolroll health`** shows response times, server delay, database waits
  and open live views. Operators get a team load benchmark
  (`scripts/bench-team.mjs`).

## 0.9.47 — 2026-10-07

- **Live tasks.** Task pages update live and show who else is viewing.
- **Last activity.** Running tasks say what the agent did last and when
  ("Ran the tests · 40 s ago"). After 5 minutes of silence they turn amber,
  and they say "Worker offline" when it is.
- **Flow cards** show their task's state: "Building · step 3 of 6",
  "Stuck: …", "Waiting on you".
- **Teammates.** People limited to some projects now get live flows and
  presence.
- **Refresh.** The task list, task pages and home refresh on their own,
  with or without the chat open.
- **One badge.** The Needs-you count is the same everywhere, and says which
  projects it covers.

## 0.9.46 — 2026-10-07

- **Tokens from the terminal.** `toolroll tokens create|list|revoke|rotate`.
  Creating or rotating asks for your password and shows the secret once.
  Tokens can be limited to projects and always expire; rotating never
  extends one. You're warned 7 days and 1 day before expiry.
- **Request limits per token.** Too many requests get a 429 with
  Retry-After. Owners change the limits in the console.
- **`toolroll audit`** and the People page show who did what remotely, with
  which token, and how it went. People see only their own.
- **A real domain, safely.** HSTS only on the https public host. Tokens are
  refused over plain HTTP from outside this machine or your tailnet.
  `toolroll serve check-public` checks the setup; see docs/team-server.md.
- **Agents sign in instead of pasting a token.** OAuth with PKCE and a
  consent screen, short-lived tokens, and reuse detection. Pasted tokens
  still work.
- Still to come: `brief` and `spend` remotely for limited access.

## 0.9.45 — 2026-10-07

- **Your projects, your lists.** People with access to some projects can now
  run `status`, `task list` and `ready` remotely, and their agents' list
  tools, and see and count only those projects. A task waiting on one in
  another project says "waits for a task in another project", with no id,
  and queue position counts only your projects. Owners see exactly what they
  did before.
- Still unavailable remotely for limited access: `brief`, `spend` and
  choosing a task's `--id`.

## 0.9.44 — 2026-10-07

- **Work from your own laptop.** `toolroll connect https://… --token so_…`
  and allowed commands run on the server as you, with the same output and
  exit codes. Approvals, people, policy and anything touching the server's
  files stay in the console and chat.
- **Agents connect over HTTPS.** `claude mcp add --transport http toolroll
  https://<host>/mcp --header "Authorization: Bearer so_…"`. Tools cover only
  that person's projects.
- **Every remote action is on the record**: who, whether it came from the CLI
  or an agent, and the token's name. A revoked token stops on its next call.
  Other projects' tasks and runs answer "not found".
- **For now, people limited to some projects** can't run the commands that
  list across projects (`status`, `task list`) or choose a task's `--id`;
  they're refused rather than shown a partial list. Filtered views are next.
- Still to come: token management in the CLI, rate limits, an audit view, a
  real domain with TLS, and sign-in for agents.

## 0.9.43 — 2026-10-06

- **Approve from chat and the CLI.** A plan waiting on you and a flow's
  approval or choose step get **Approve** and **Send back** buttons in your
  paired Telegram chat, two taps each, recorded like a console decision. Ask
  the lead to "approve X" and it answers with those buttons; your tap is
  still the approval. `toolroll flows card approve <flow> <card>` and
  `toolroll flows card send-back <flow> <card> --note …` do the same from the
  terminal with your login.
- **Chat approval can stay on.** `toolroll chat-approval on|off [--repo <p>]`
  turns approving from chat on for one project or all of them, with your
  password to turn it on; off is instant and off for all really is all. It no
  longer lapses with a weekly mode. Plans that widen permissions, go over a
  cap or touch protected paths still go to the console.
- **Old cards point onward.** A card in a past conversation says where the
  item went and links to it when you can open it.
- Still to come: Slack, Discord and Teams buttons, a Settings screen for chat
  approval, and sending a plan back from chat.

## 0.9.42 — 2026-10-06

- **Zod revamp, waves 3 and 4.** What comes into Toolroll from outside and
  what it reads back from disk now goes through one schema each in
  `src/contracts/`: console forms and JSON, CLI `--json` output, webhook,
  GitHub, Linear, email and form payloads, OAuth replies and tool specs,
  settings, every JSON column in the database, update and recovery journals,
  and evidence files. All of it is read as leniently as before. Replayed
  against real data with 0 differences: 655 runs and 984 evidence folders,
  5,158 database rows, 7 tool connections. Console JSON and CLI `--json` bytes
  are unchanged. Console API and CLI input are partly done; what remains is
  listed in `docs/plans/zod-revamp.md`.
- **Changed on purpose.** Recipe refusals start with the field's path. An
  unknown provider is refused as `provider: unknown provider`, without
  repeating what was typed. A sign-in that answers with an empty token says
  it couldn't be reached instead of crashing. An update journal missing its
  core fields (no release since 0.8.0 writes one) is refused rather than read.

## 0.9.41 — 2026-10-06

- **A read-only PostHog connection works for research.** PostHog adds
  `introspection` to every connection it grants, asked for or not; it only
  lets a connection be checked and reaches no data. Toolroll counted it as
  write access, so research skipped PostHog even after **Reconnect read-only**.
  It now counts as read-only alongside the reads it came with. Nothing is
  requested differently, and a connection that already reconnected read-only
  works without signing in again.

## 0.9.40 — 2026-10-06

- **Confirming a proposal checks the same things the card does, everywhere.**
  The console, a direct request, Telegram and the CLI all ask one check: you
  can act on this chat (with the current provider, model and price), and no
  reply is still running. If the terms changed, the card says to turn chat on
  again and every other way of confirming refuses too, with the same reason.
  A teammate reply that stalls before it starts stops blocking confirms after
  a short limit instead of until a restart.

## 0.9.39 — 2026-10-06

- **Chat is the conversation.** The Chat tab is your conversation with the
  lead, with the box to write in ready. Home (what's running, the counts,
  Catch up) moves to the panel beside it, and behind **Work** on a phone.
  When the projects the lead can reach change and a new conversation starts,
  the previous one stays readable above a line saying so; the lead doesn't
  see it, and its old cards can't be confirmed. Pairing your phone is a
  one-line notice in chat, with the full card in Settings → Chat apps.
- **Team chat shows proposals where they were made.** A teammate's proposed
  action, flow or decision sits under the message that made it, using the
  same card as lead chat, with the same rules about who can act and when.
  Older proposals still show.
- **The release check runs app journeys side by side when there's room.**
  With normal memory pressure the app journeys split into lanes; under
  pressure, or when memory can't be read, they use one lane, and the check
  log says how many and why. `TOOLROLL_E2E_LANES` sets the number.

## 0.9.38 — 2026-10-06

- **The release check is faster.** Its app journeys run in about 8 minutes
  instead of about 12, with no journey or coverage dropped.
- **Lead chat tool steps tell the truth.** A step shows done only when it
  succeeded. A failed step says why in plain words.
- **Telegram decision cards lead with the action.** Decisions, plans, lead
  proposals, flow approvals and flow choices say what to do and what it does
  first. "Nothing changes until you confirm." stays on every proposal, and
  buttons on cards already sent still work.
- **Crew rows say why.** A task that is waiting, failed or needs you shows the
  reason in one line; tap it to read the rest. The whole row still opens the
  task.
- **Dependency updates.** @slack/socket-mode 3.1.0, imapflow 2.2.5,
  nodemailer 10.0.15, mailparser 3.9.36, lucide-react 1.52.0, @xyflow/react
  12.12.0, happy-dom 20.14.5 and tsx 4.23.15. Vitest takes the 4.1.11 security
  patch and stays on 4; version 5 waits for its own migration. `npm audit`
  reports no vulnerabilities.

## 0.9.37 — 2026-10-06

- **Zod revamp, waves 1 and 2 finished.** Every handoff between a model and
  Toolroll, and the context passed between steps, is now one schema each in
  `src/contracts/`: the lead's 51 tools and the 25 MCP gateway tools, the
  scout report, task sizing, reviewer findings, decisions, teammate turns and
  sort answers, the lead's context bundle, project knowledge, memory and
  skills, chat actions and channel callbacks, and the desktop coding handoff,
  context and session record. A model gets the schema as `--json-schema`
  where its harness takes one; a refusal names the field
  (`steps[0].routes[0].goesTo: required`). Everything that was accepted before
  is still accepted: tool calls with extra or loose arguments, model answers
  with nulls or overlong text (clipped as before), saved reports, rows,
  sessions, chat buttons and proposals. Replayed against real saved data
  (scout reports, findings, decisions, 410 scopes and 796 routes, 279 chat
  buttons, every saved flow and card), all of it reads the same.
- **Research can read PostHog.** A research run gets a connected service's
  query tool (PostHog's `exec`) only when the access the service actually
  granted is read-only. Otherwise it skips it and says why on the run and the
  integration, with a **Reconnect read-only** action. Connecting PostHog as
  usual is unchanged, and builds keep every tool. Connections made before this
  release didn't record what was granted, so research skips them until you
  reconnect read-only.
- **A question's recommendation can carry its reason.** `connect: because…`
  now counts as recommending `connect`, instead of failing the question.
- **A Telegram update Toolroll can't read** is logged and answered OK, so
  Telegram doesn't keep resending it. A Slack, Discord or Teams message part
  that can't be read is dropped with its reason instead of retried forever.
- **Rolling back:** flow cards written by 0.9.37 read as empty in 0.9.36, so a
  rollback loses the step outputs of cards still in progress.
- **Scopes, acceptance criteria and sealed routes have one contract.** A task's
  scope (goal, exclusions, touch paths, rubric) and an acceptance criterion are
  described once from the plan contract's own fields (`src/contracts/scope.ts`);
  a sealed agent route, in both versions it has been saved in, with its
  overrides and task size, is one schema (`src/contracts/route.ts`). The shared
  rubric input schema is ready for the lead-tool migration. Every saved scope,
  standing order and sealed route reads and digests exactly as before, so no
  approval changes.
  Nothing new is refused: a scope still names up to 50 paths and a criterion
  still ignores keys it doesn't use. Rubric and route refusals are now
  field-named lines (`acceptance[0].statement over 1,000 bytes`), and a route
  made by a newer Toolroll says so.
- **What a flow's steps hand on has one contract.** A finished zone's
  `{{stage.…}}` words, a card's saved outputs, and what Send to me and Person
  chooses send are each described once (`src/contracts/stage-output.ts`,
  `flow-send.ts`, `flow-card.ts`). Saved cards and sends read exactly as
  before. A build or research task filed after a step whose output was too
  long to pass on now gets that output whole, not just a link to it.
- **Tightened, on purpose.** Saving a flow with a new `{{stage.…}}` that its
  zone doesn't hand on is refused, naming where:
  `stages[2].instructions: stage.research.unknown is not available (Research
  hands on {{stage.research}}, {{stage.research.items}} and
  {{stage.research.report}})`. This covers the canvas, `toolroll flows
  create/edit/import`, the lead and templates. A reference a flow already had
  is never refused, and nothing changes for flows that are only read or run.
  Card outputs and kept sends are saved with a version; ones a newer Toolroll
  wrote are refused rather than misread or overwritten.

## 0.9.36 — 2026-10-06

- **Flows have one contract.** Every kind of zone, step, route, answer,
  option, trigger and the flow file is described once
  (`src/contracts/flow.ts`), and that description is what the lead's
  `propose_flow` is told, what `toolroll flows create/edit/import` and the
  console check, and what `docs/flow-file.schema.json` publishes (now
  generated, so it includes Send to me, Person chooses and `ifReplied`, which
  the hand-written one had missed). A refusal names the field and suggests the
  one meant: `steps[0].routes[0]: unknown key 'to' (did you mean goesTo?)`,
  `zones[2]: unknown key 'onFail' (did you mean ifFails?)`, instead of
  "there's no step called ." Every saved flow, template, starter, kit and
  gallery flow reads exactly as before: the same saved bytes and digests, and
  the same exported files.
- **Tightened, on purpose.** A step, flow file zone, trigger setting or
  `propose_flow` argument with a key its kind doesn't take is refused by name
  rather than silently ignored: `planning` on a Holding step, `remindAfter` on
  a Wait step, `ifFails` on a Sort step (use `ifNotSure`, which it meant) or
  `next` on a Sort or Person chooses step. A sort's `sureAt` is 0.5–99. A flow
  file's zones keep only the words their kind uses when exported, and a file
  or drawing made by a newer Toolroll is refused as such. Messages for flows
  and triggers changed from "Zone Build: …" sentences to path-named lines.

- **Builder handoffs and proofs have one contract.** The handoff a builder
  leaves, its proof and the verification receipt are versioned schemas. Fifteen
  real past runs replay with identical verdicts, receipt bytes and digests.
- **One compact review packet.** `toolroll task review <id> --brief` (or
  `--json`) shows a build's conclusion, changed files, check result, review
  findings by severity, screenshot paths and what to do next, in about 40
  lines and without logs or diffs.
- **PostHog connects in one short step.** Its sign-in now uses PostHog's own
  MCP permission preset instead of listing every permission, which showed a
  75-group permission screen. Sign-in returns are now logged.
- **Tests can't mistake a real process for a fake one.** Fake process IDs in
  tests sit above every platform's limit, and a guard refuses new low ones (a
  Brave tab and a GitHub runner process had made tests fail at random).

## 0.9.35 — 2026-10-05

- **One-click sign-ins ask for every permission a service lists.** Toolroll
  asked for only the first 20, so a service needing one later in its list
  issued a token it then refused (PostHog needs `user:read`, its 140th).
  Reconnect a service that failed its test after signing in.

## 0.9.34 — 2026-10-05

- **Plans have one contract.** The first step of making every handoff robust:
  a plan is described once, and that description is both what the planner is
  told to return and what Toolroll checks. Limits come from one place, so the
  2,000-versus-8,000 mismatch from 0.9.30 can't happen again, and a malformed
  plan's retry quotes the exact field that was wrong.
- **Projects added from the command line show in the console.** `toolroll
  repos add` (you or the lead) admits a project the same way the console's Add
  a project does, and it appears within seconds without a restart. Removing
  works the same way. Every addition is recorded with who made it.
- **Crew rows show when they last changed** ("4m", "2h", "3d").

## 0.9.33 — 2026-10-05

- **A restart never breaks a project's builds.** A project's identity no
  longer includes the disk's device number, which macOS can change at restart.
  Saved project knowledge from before such a change no longer stops a build:
  the build runs without it, and one notice offers to apply it again (Knowledge
  page, or `toolroll knowledge apply`). When it is provably the same repository,
  it carries over by itself.

## 0.9.32 — 2026-10-04

- **Lighter on your computer.** A version bump no longer reinstalls every
  dependency (about 22,000 files each time); it reuses the install. Tests and
  checks remove their temp folders and stop what they started however they
  end, and Toolroll sweeps what's left once a day by itself: old test folders,
  processes a finished run left behind, finished release checkouts, extra
  staged versions and unused installs. Spotlight skips Toolroll's folders.
- **The release check fits the machine.** Each part waits for memory and a
  free model slot (4 real turns at once by default) instead of starting
  everything at once, so a busy computer makes it slower, not failed. Most
  browser journeys now run against a scripted model; real models run when
  model-facing code changes and nightly. A UI-only check went from 9.3 to 5.8
  minutes and from 95 real model turns to none.
- **The lead never goes silent.** A reply that runs past its time ends, says
  it took too long, keeps any proposal it made, and frees the chat for your
  next message.
- **Batch checks.** Projects that check every build can check results that
  finish together once, on a temporary combined commit, and split the batch if
  it fails. Off unless you turn it on for a project.

## 0.9.31 — 2026-10-04

- **Flow templates for your integrations.** Nine new templates put connected
  tools to work: UI inspiration (Mobbin), Metrics digest and Fix the biggest
  drop-off (PostHog), Outage to cause (Better Stack), Figma frame to pull
  request, Worker errors to fix (Cloudflare), Failed deploy to fix (Vercel),
  Linear issues to PRs, and Support to bug fix (Intercom). Error to fix now
  reads stack traces through Sentry. Each card shows its tool's logo and
  whether it's connected; one that isn't offers Connect first. Research steps
  only read, and nothing merges.
- **Templates show their steps.** The unlabeled boxes on each template are
  now a named step strip, like "Find the drop-off → You choose → Build the fix
  → Pull request → Sent to you", with your steps marked.

## 0.9.30 — 2026-10-04

- **Long tasks can be planned.** 0.9.28 let task goals run to 8,000
  characters, but plans still had to fit the goal in 2,000, so every plan for a
  longer task was refused. Plans now take the same limit as the task.

## 0.9.29 — 2026-10-04

- **Tasks filed from the command line get sized too.** `task scope` now sizes
  the task from its goal before the plan is sealed, so work the lead files
  gets the same fast-or-strong model choice as work filed in the console.
- **A reused process ID no longer blocks finishing a release.** Once
  Toolroll has recorded that a process exited, a new program taking its
  number doesn't count as the old one. Leftover process records close when the
  run ends, and a wait that clears by itself says so instead of asking you to
  confirm.
- **Status shows each task once.** A task that is building appears only under
  Building, an approved plan no longer reads as waiting for review, and risky
  routes say "Risky" instead of "routine".

## 0.9.28 — 2026-10-04

- **Each task gets the right model.** When a task is filed, a fast
  classifier on your own subscription sizes it as small, medium or large and
  flags risky work. Small changes build on a fast model with no plan. Large or
  risky ones get your strong models for planning and building. The choice is
  sealed into the plan you approve, with the reason, and you can override it.
  Where a tier has both Claude and Codex, it picks the one with more of its
  plan left. `toolroll spend` shows what each tier took.
- **Nothing gets cut off.** Task goals hold 8,000 characters (up from 2,000),
  notes 4,000 (up from 500) and flow instructions 8,000. Agents are told each
  limit before they write and get one chance to shorten. Anything still over
  is kept whole and linked. Chat messages split instead of cutting.

## 0.9.27 — 2026-10-04

- **Integrations show their real logos.** Every integration has its own mark
  in one style and size, ink when connected and muted otherwise, across Tools,
  Integrations and the Settings home. The marks come from Simple Icons and
  svgl and ship inside Toolroll. Services with no open logo keep a letter
  tile.
- **Research messages explain each example.** After a research step, the chat
  message lists every example: the pattern, why it fits, how it would plug
  in, and its link. Screenshots are numbered to match.

## 0.9.26 — 2026-10-04

- **Connecting a tool goes to the project you see.** On Settings → Tools,
  changing the project switches the page at once. Every button names its
  project ("Connect Mobbin to standing-orders"), and a post from a page that
  showed another project is refused. You can also add a connected service to
  another project in one step.
- **Figma connects through its desktop app.** Figma doesn't let other apps
  sign in to its online server, so Toolroll uses the desktop app's Dev Mode
  server instead, with no key. A Connect that fails now says why right at the
  button.
- **Flow cards move on while builds run.** Moves, triggers and steps run on
  their own 15-second beat, and a finished step moves its card at once.

## 0.9.25 — 2026-10-04

- **Connect by signing in: Mobbin, Figma, PostHog and Better Stack.** Settings
  → Tools has a Connect button for each. You sign in once in the browser; no
  keys.
- **Research can read your connected tools.** A research step gets only their
  reading actions (list, get, search and the like), never anything that
  changes something. With Mobbin connected, UI research looks there first for
  real app screens. Codex research runs are held to the same rule.

## 0.9.24 — 2026-10-04

- **Settings, grouped.** The Settings home puts its tiles under five headings
  (Agents, Automation, Chat apps, Access and rules, System), every tile has an
  icon, and each chat app says how it stands: Gets alerts, Connected, Not set
  up, or Has a problem. The first change from the UI inspiration flow.

## 0.9.23 — 2026-10-04

- After a research step, a flow's message to you now carries that research's
  screenshots. Before, it only looked for a build's.

## 0.9.22 — 2026-10-04

- **Research takes screenshots again.** The research step's browser now runs
  outside the agent's sandbox with Chrome's own sandbox on, reached on a
  private local port. It still opens public pages only. A short check before
  research starts says once, in plain words, if the browser can't start.

## 0.9.21 — 2026-10-03

- **Flows send you what was done.** A new "Send to me" step sends the last
  step's summary, links and pictures to your chat apps. Every template can
  end with one.
- **Flows ask with your own buttons.** A "Choose" step offers 2-4 options you
  name, for example Implement, Remix or Ignore, on Telegram, Slack, Discord,
  Teams and the console. Reply instead to give a note.
- **Research brings back pictures.** A research step can screenshot the
  public pages it visits (and your project's demo, if you set one) and return
  up to 6 examples with links. Later steps can use them all. Its browser and
  web reads reach public addresses only.
- A Build step can work in another project you have access to.

## 0.9.20 — 2026-10-03

- **Scouts deliver again.** Claude scouts hand back their report, or a
  question for you, as structured output. Plan mode no longer swallows the
  report.
- **The morning review stops filing work for things only you can do.**
  Unopened results, questions, plan approvals and holds no longer start an
  investigate-and-fix flow. Anything waiting over 3 days gets one line in the
  review's summary, with a link to Needs you.

## 0.9.19 — 2026-10-03

- A release candidate whose check was rerun on the same commit can be
  deployed; no fresh gate needed.
- Screenshots with results follow their result message and thread under it on
  Slack and Discord, never sent twice.
- A process-cleanup test no longer flakes under load.

## 0.9.18 — 2026-10-03

- **Decide in Telegram.** A ready result's Accept and finish, Request changes
  and Retry now work right in the chat, each confirmed with a second tap. With
  `toolroll mode set … --chat-approve` signed once, you can also approve plans
  and merge pull requests from Telegram. Anything outside the mode's terms
  still links to the console.
- **Screenshots with results, if you want them.** Settings → Notifications →
  Screenshots with results: Off, First one, or Up to 4. On Telegram they
  arrive as photos with a plain caption.

## 0.9.17 — 2026-10-03

- **The lead checks before it promises.** One check covers agents (signed in
  or not), workers, tools and skills, integrations and checks. It won't
  propose work that needs one until it has looked. If something isn't ready,
  it says so with the next step and a link.
- **Replies read like a person wrote them.** On every channel: no headers,
  links with plain labels, no internal ids, and little bold. A reply that
  says it's attaching something has to attach it. Errors are in plain words,
  and you see a 👍 and typing while it works.
- **It knows you and your people.** "What your lead knows about you" is a
  short list you confirm line by line, editable in Settings → Lead. The lead
  also keeps an index of the people, teammates and team chats you work with,
  and looks a person up before answering about them.
- Promises made on Slack, Discord and Teams are delivered there. Long
  Telegram replies split safely.

## 0.9.16 — 2026-10-03

- **Name your lead.** Settings → Lead takes a name and a short persona. The
  lead uses them wherever it speaks.
- **The lead knows who it's talking to.** Every turn it sees your first name,
  today's date, the channel it's on, what needs you, and your projects by name
  with their decisions.
- **It checks before it speaks.** It says what it checked and marks guesses.
  It searches project memory before recommending anything, and it checks an
  integration before promising work that needs it.
- **Questions with buttons.** When it needs an answer, it asks one question
  with tap-to-answer options in the console, Telegram, Slack, Discord and
  Teams.
- **It keeps its promises.** "I'll tell you when the checks pass" is recorded
  and reported once, on the chat where you asked. Corrections become a card
  you confirm, and it remembers them from the next reply.
- Accepting a result that doesn't match its report needs a reason, enforced by
  the server. Every time on a page shows in your time zone.

## 0.9.15 — 2026-10-02

- **Accept finishes the task.** One step, Accept and finish, after the
  evidence. Your own checks come first, and the count updates as you answer.
- **Failures say what failed.** A failed task names the requirement or check
  it missed and suggests what to change, prefilled in Retry. Failed builds get
  a real result page. Builds show "Step 2 of 6" and say when they're stuck.
- **One set of words.** The same state names in the list, task page, result
  page and Crew. Project checks and PR CI are labelled apart, and every time
  shows in your own time zone.
- **Approving says what you allow.** A plain "You're allowing" line sits above
  Approve, your password says what it signs, and Edit plan edits in place.
- **Safer deploys.** An interrupted deploy puts the old service and its coding
  store back.

## 0.9.14 — 2026-10-02

- **Results and failures say what went wrong.** A result whose report doesn't
  match its saved changes says so in its headline and lists each mismatch,
  with its requirements shown as unverified; accepting it asks for a reason. A
  failed task shows its latest attempt's reason in one plain line (or that
  none was recorded), linked to the log, with Retry as its one action.

## 0.9.13 — 2026-10-02

- **One page per result.** Every build's result has one page, titled with its
  task, with exactly one main action: Accept, Run checks, or Request changes.
  A result that can't be accepted says why in one line.

## 0.9.12 — 2026-10-02

- **Approving a plan fits one phone screen.** The plan shows up front in plain
  rows (Goal, Changes, Won't touch, Done when) with one Approve & start, pinned
  to the bottom on phones, and a line saying what happens next. The fine print
  sits under Details.
- **Tasks puts what needs you first.** Waiting work is grouped as Decide,
  Review and Unblock, each with a solid ink chip, and usage folds to one line.
- **Reviewing a result shows the change before Accept.** Each thing you check
  comes with its evidence and Looks right / Not right; Accept says "Accept
  without checks" when they didn't run, and what accepting does.
- **Your lead tells you what it's doing.** A task your lead is handling says
  "Your lead is on it" instead of waiting on you, and short updates from your
  lead arrive in chat.
- **Updates over 0.9.11 work.** Stopping the service no longer leaves the
  coding server's record behind, and a deploy or update that fails after
  stopping it puts the previous version back on its own.

## 0.9.11 — 2026-10-02

- **The Telegram bot always answers.** Replies and notifications go out from
  the service itself, never from inside a build. If it can't answer, it says
  why in plain words, and a session mix-up starts a fresh conversation instead
  of refusing.

## 0.9.10 — 2026-10-02

- **Chat reads like a teammate.** Short messages, outcome first, with real
  choices: Merge or Mark complete, and Look first. Updates within two minutes
  arrive as one message. You're never told about your own actions, release
  checks and replaced tasks stay quiet, and a release sends one "is live" line.
  The Telegram bot is named Toolroll.

## 0.9.9 — 2026-10-02

- **Faster, lighter tests.** The unit suite runs about three times faster
  (the biggest test files are split by area), tests use at most 4 workers,
  and a project's Quick check can be a typecheck plus the tests for the
  changed files.
- **Toolroll cleans up after itself.** When a run ends, it stops what the run
  left running. Tests delete their temp folders, and `toolroll storage clean`
  removes leftovers. Replaced release checks give up their checkouts, and
  kept checkouts drop their dependencies until they're needed.
- **Checkouts share dependencies.** One install per lockfile, linked into
  each checkout: about 1,900 files instead of 20,000, set up in under a second.
- **Every "Needs you" says what it needs, with the button that does it.**
  Anything you can't act on shows as Waiting instead.
- **Finished tasks read Complete everywhere.** Status, the console and chat
  agree, and old "process exit not recorded" entries clear themselves.
- **Updates never hang.** The updater settles leftover records itself, stops
  waiting after 2 minutes otherwise, and says the one command that clears it.
  Release checks now test upgrading from the last three releases.
- **Screenshots stay out of the repository.** Images under `evidence/` are
  left out of commits and show as one line in the review.

## 0.9.8 — 2026-10-01

- **One automatic review per build.** When a build's checks pass (or it
  finishes, with checks Off) in a project with review on, one read-only
  reviewer reads the scope, acceptance and diff and grades each finding HIGH,
  MEDIUM or LOW. Any HIGH sends the task back once, with the findings as its
  note; a HIGH on that revision comes to you. MEDIUM and LOW never block: they
  show on the result as suggested follow-ups. A review that fails or times
  out never blocks: the result reaches you marked Not reviewed. Turn it on or
  off per project in Settings or with `toolroll review on|off --repo <path>`;
  it's on by default under a hands-off mode. Release candidate checks are
  never reviewed.
- **Evidence is kept 1, 7, 14 or 28 days, or forever.** Settings →
  Retention and `toolroll retention set evidence 1d` take any of them. Until
  someone chooses, evidence is kept 28 days: **after upgrading, the daily
  sweep starts removing finished tasks' evidence older than 28 days.** A
  period chosen before stays as it was; one the page no longer offers shows
  as "30 days (custom)".
  Nothing a task still needs is removed: unfinished tasks, results Ready for
  review, anything on hold, live runs and release candidates.
- **A run whose process never started no longer blocks updates.** A spawn
  that fails now settles its own record, and Toolroll settles a finished run's
  leftover record once its processes are provably gone, noting it in the
  ledger. For the rare record that can't be proven either way, an approver
  can run `toolroll run settle <run> --why "<reason>"`; it refuses while
  anything of the run is alive.

## 0.9.7 — 2026-10-01

- **Onboarding without a password or a form.** `toolroll up` prints three
  lines and opens the console already signed in, through a one-time link that
  works once, for ten minutes, from this computer only. The lead turns on by
  itself with the agent that's signed in (Claude Code, else Codex); the old
  setup form moved to Settings → Lead → Advanced. With no agent signed in,
  Chat shows the command to install and sign in, and checks again on its own.
  A short "how it works", a live Plan → Ready timeline on your first task, a
  card for pairing your phone, and a "wrong host" page that says what to run.
- **The task page is one conversation.** The status stays on top; below it
  the plan, the agent's notes and results, questions and your replies, in
  order, ending in a box to message the agent (Build, Plan only, or Just
  answer). Details (scope, attempts, audit) moved to a side panel, or a sheet
  on phones. The Chat home shows who is working now and four counts, and
  Catch up and the Inbox have tabs: Needs you, Ready, Running, All.
- **Checks: quick while building, easy to turn off.** Each project has a
  check level: Quick (the default for new projects), Full or Off, and a task
  can override it ("skip the tests"). With checks Off a result is still
  Ready for review, and says no check ran. Any result can run its checks again or file a task to add tests.
- **A flow gallery, and flows as files.** Flows → New is a gallery of
  templates grouped by what they're for, with new ones for developers
  (Overnight bug bash, Flaky test hunter, Release notes writer, Docs follow
  the code, Error to fix, PR second opinion and more). Export any flow as a
  `.toolroll-flow.json` file and import one from a file or a link, with a
  preview; secrets never leave, and imported triggers start switched off.
- **Several builds at once on one project.** The service builds up to two
  tasks of a project at a time (Settings → Projects, `toolroll project
  concurrency`), within the machine's limit. Stopping the service mid-build
  saves the work and resumes it next time.
- **The lead's housekeeping stays quiet.** An agent acting as your lead gets
  its own credential (`toolroll lead token`); its work pings nobody unless it
  hands something to you. Your own actions never ping you, a replaced task
  reads "Replaced by", and a whole project can be muted.
- **A faster release check.** Flow journeys run in parallel groups, browser
  journeys are rebalanced, and a version-only bump no longer forces every
  test.

## 0.9.6 — 2026-10-01

- **Every task's status, clear at a glance.** One headline from a fixed set
  (Queued, Planning, Needs you, Building, Ready for review, Complete, Failed,
  Stopped) and one plain sentence, the same words on the Tasks list, the task
  page, the result, Crew, the Telegram/Slack/Discord/Teams card and
  `toolroll status`. Checks, the pull request, requirements and saved
  evidence sit underneath as quiet rows. A pull request that couldn't open
  is an amber note with one action, never a red chip beside Complete: red
  now means only Failed. The exact technical reason stays under Details.

## 0.9.5 — 2026-10-01

- **A demo you can feel in 90 seconds.** In `npx toolroll demo`, Chat has a
  scripted lead: ask for anything and it answers with a short plan in a
  sample project; Approve builds it live to Ready with a diff, a passing
  check and a screenshot, then Complete or Request changes. It never calls a
  model, reaches outside or spends. The sandbox folder is now `toolroll-demo-*`.
- **Calmer first impressions.** A result in Chat shows each fact once, in
  plain words ("You check this one: …" instead of criterion and evidence
  terms), and a first start on Linux without process containment says so in
  one sentence instead of a cgroup error.
- **Pull requests open reliably.** Each project's worker now publishes only
  its own project's pull requests, under one permission lookup shared by
  Complete, flows and the publisher. Before, another project's worker could
  give up on a pull request that was actually opened, and a flow could file a
  needless rebuild.

## 0.9.4 — 2026-10-01

- **Flow steps act exactly once.** However many workers advance a
  project's flows at the same time, a card files its task, runs its script
  and posts its update once; a retried card takes the same guarded path.
- **Pull requests from the terminal.** `toolroll task complete <id>
  --pull-request` completes a result and opens its pull request, and
  `toolroll task merge <id>` merges it once checks pass, behind your password.

## 0.9.3 — 2026-10-01

- **Flows never get stuck on a long step output.** A research or build step's
  goal keeps its instructions whole and trims only what was filled in from
  earlier steps (start and end kept, with the full text on the card and given
  to the agent as untrusted context). Instructions too long to fit are refused
  when the flow is saved. A card that couldn't file its work tries again on
  the next pass.

## 0.9.2 — 2026-10-01

- **Flows from a terminal.** `toolroll flows` lists and shows flows (zones
  with their next and failure paths, triggers, recent cards) and sets them
  up under the console's own rules: `create` from a template, a starter flow
  or the lead's step format, `edit`, `trigger add|pause|resume|remove|check`,
  `script save`, `card add` and `archive`. Writes take an approver's
  password (`--as/--token` or the remembered login) and land in the ledger;
  create, edit, archive and trigger add preview until `--yes`. It is in
  `contract --commands` and `skills get operating`.
- **Toolroll reviews its own last day, every morning.** A new plane review
  trigger reads the last 24 hours from the store at 07:30 and makes one card
  per problem worth fixing — failed runs by cause, tasks waiting on a person,
  sign-in and plan-limit pauses, chat delivery failures, Broken integrations,
  failed release checks and worker breakages — with counts, run ids and
  redacted excerpts. A problem that comes back joins its card; a clean day
  adds nothing. The **Morning plane review** starter (Settings → Flows, or
  `toolroll onboard --starter plane-review`) researches each one, builds a fix
  under the usual approvals and opens a pull request; failures wait in
  **Needs a look**. Flow insights show which problems recur.
- **Flows that test Toolroll.** `scripts/flows/real-model-journeys.mjs` runs
  the journeys that use real models (unit tests and CI never do), retrying a
  failure once before calling it real, and `scripts/flows/weekly-upkeep.mjs`
  reports outdated or vulnerable dependencies and new agent CLI versions.
  Both run in a flow's check zone. A Toolroll started inside the agents'
  fence now runs its agents inside that outer fence instead of failing to
  nest a second one.

## 0.9.1 — 2026-09-30

- **Phones show more on a screen.** On a phone the console is about a third
  denser: a row's action sits on its title line, status chips beside the
  name, facts on one line, and times shorten to "16:39", "Yesterday 16:39"
  or "Sep 28" (the full time stays on desktop and on hover). Every tap target
  is still at least 44px and text fields 16px; nothing scrolls sideways at
  320px, and the desktop layout is unchanged.
- **Flows open pull requests, and starter flows are one yes away.** A new
  Pull request zone opens a PR for a card's built result under the project's
  pull request setup, waits for CI, moves on when it passes and takes the
  failure path (naming the failing check) when it fails; it can merge, squash
  by default, only after a person approved the card. The Issues to PRs
  template runs labelled GitHub issues through build, approval, pull request
  and a closing comment. Settings → Flows and `toolroll onboard --starter`
  switch on Fix failing CI, Issues become tasks and Overnight queue; a task's
  "Do this every time…" and chat offer the matching one.

## 0.9.0 — 2026-09-30

- **Chat pings only when you're needed.** In Telegram, Slack, Discord and
  Teams each task is one message, updated in place from filed to Ready (and
  tasks filed within a minute share one). A new message arrives only when
  something needs you: a result Ready for review, a question or approval, a
  failure that needs a decision, a sign-in or plan-limit pause, or a security
  alert. Choose Only when I'm needed (the default) or Every step, and an
  optional evening digest, in Settings → Notifications or with
  `toolroll notifications quiet|all|digest <HH:MM>|digest off`. Delivery
  receipts and the console's activity are unchanged.
- **Complete opens a pull request, and Merge is one step.** Turn on pull
  requests once per project (Projects → Pull requests, or
  `toolroll publish setup`): Toolroll checks the GitHub remote, the default
  branch, `gh` sign-in and push rights, and says what to fix. Complete then
  offers "Complete and open a pull request" beside "Complete only"; the pull
  request opens from the exact completed commit. The task shows the PR link
  and its CI. Green reads Ready to merge with one Merge (behind your
  password; Telegram and Slack link to it), which squashes by default,
  deletes the branch and records the merge commit in the ledger. Red files
  one revision with the failing check's name and a fenced log excerpt, at
  most twice per task, then asks you. "Merge when checks pass" is an
  opt-in project setting.
- **Settings → Integrations: what works, what's broken.** One list of
  Telegram, Slack, Discord, Teams, GitHub, Linear, email, each project's MCP
  tools, monitoring destinations, Claude and Codex. Each says Connected, Not
  set up or Broken, with its last success and last error, what uses it, and
  one action: Set up, Send test, or Fix in plain words. Checks are read-only,
  run in the background and never hold up a page; `toolroll integrations`
  shows the same, and `toolroll status` adds a line when something is broken.

## 0.8.2 — 2026-09-30

- **Task checkouts stop using space nobody wants.** A finished task's clean
  checkout now goes when its task is complete or cancelled (Settings →
  Storage or `toolroll storage cleanup` changes that to 2 days, a week or
  never); its branch always stays. Toolroll's own progress file no longer
  keeps a checkout forever. `toolroll storage clean` and the Clean up button
  preview what goes, what it frees and what stays and why, then remove it;
  a checkout kept for its changes can be discarded on purpose. Every removal
  is in the ledger.
- **Safer recovery.** A failed update no longer moves a healthy database aside
  (only one that can't be read), checks the backup and free space first, and
  puts the database back if the restore fails. `toolroll mcp` exits when its
  database is replaced, so an agent's writes never go to a stale file.
  Cancelling re-reads the update under its lock, `toolroll onboard` removes
  only guide copies it wrote, more agents are recognised as agents, and the
  console never waits on npm.

## 0.8.1 — 2026-09-30

- **Safer `toolroll update`.** A release is accepted only when its signing
  certificate names ap9000/toolroll, its publish workflow and GitHub
  Actions, checked with the Sigstore verifier npm already ships (found from
  npm itself, so a custom npm global folder works too). A failed
  update puts the commands back before stopping the service, stops and
  restarts per-project watch workers with it, restores even when the live
  database can't be copied aside, and keeps the last good update so
  `--rollback` still works after a refused attempt, including for the update
  that brought 0.8.1. The console's update job
  finds pnpm, bun and npm where they are installed; the desktop app is never
  offered npm.
- **Safer `toolroll onboard`.** It adds the main checkout rather than a
  temporary worktree, never adds your home folder, and asks before adding a
  project. Run by an agent, `toolroll up` never prints the password. Login
  advice matches how the install actually signs in, and uses the port `up`
  serves on. A skill you have edited is left alone.
- **Chat opens instantly.** First-run suggestions and the agent sign-in check
  refresh in the background, so a slow network never holds up the page.
  Tapping a suggestion adds to what you typed instead of replacing it.

## 0.8.0 — 2026-09-30

- **Install with your agent.** `toolroll onboard`, run by the agent that
  installed Toolroll, adds the repository as a project, says which agent
  CLIs are signed in, and with `--yes` installs a small marked Toolroll
  skill for Claude Code and Codex so the agent knows how to hand work over,
  wait and review (`--remove` takes it out; a skill you wrote yourself is
  never touched). It prints the MCP line rather than running it and ends
  with a handoff for the person: the console address and where the login is
  saved, never the password. `toolroll up` without a terminal prints that
  handoff instead of opening a browser.
- **A first run that leads to a first result.** Chat and the inbox show three
  plain steps (Agent signed in, Project added, Your first task), each done or
  with one action, until the first Ready result. Until a task exists, Chat
  offers three first tasks: the repository's open GitHub issues, else its
  TODO and FIXME notes, else safe generic ones. A tap only drafts the
  message, and text from issues and notes is kept to what a person can see.
  Settings shows how long the first result took.
- **Calmer secret alerts.** The commit secret scan looks only at lines a
  change adds and skips documented placeholders, so pushes no longer warn
  about keys that were already there or never real. A real hit still blocks
  publication; the alert names the file and line, once per commit, and says
  what to do.
- **`toolroll update`: verified, drained, undoable updates.** Installs the
  new release from the npm registry beside the running one, under npm's own
  signature and attestation check; the installed bytes must be the ones
  downloaded and hashed, and their provenance must name ap9000/toolroll and
  its publish workflow. It lets running work finish (`--when-idle`, the
  default; `--now` refuses while work runs and names it; `--at 03:00`
  waits), stops the service and waits for it to exit, backs up the database
  and coding catalog, rehearses, switches the service and every
  `toolroll`/`standing-orders` on PATH, restarts and health-checks. A failed
  check restores the previous version, database and coding catalog on its
  own, keeping what the new version wrote in a named copy;
  `toolroll update --rollback` goes back later. It refuses while a
  foreground `toolroll up` runs, when a command on PATH is a shim it cannot
  switch, and to an older release without `--allow-downgrade`, and keeps two
  release runtimes. Settings → Updates offers Update now, When idle and
  Tonight (03:00) behind your password, shows the steps live, and a one-time
  What's new card afterwards; while update checks are off it asks npm
  nothing until Check now. The console's update job runs once, for that
  update only. Every update, rollback, refusal and failure is in the ledger.

## 0.7.0 — 2026-09-30

- **Know when a newer Toolroll exists.** Once a day Toolroll makes one
  anonymous request to npm, plus one to GitHub for that release's notes, and
  keeps the answer beside the database; offline it says nothing.
  `toolroll status` adds one line when a newer version exists, the console
  shows a quiet notice you can dismiss per version, and Settings → Updates
  shows this version, the latest and its notes, the command for how you
  installed it, each worker's version, and a switch to turn the check off
  (or set `TOOLROLL_NO_UPDATE_CHECK=1`). A security release (notes with a
  "Security" line or heading) also messages each operator once. A plane
  deployed from a checkout reads as a source install.

## 0.6.0 — 2026-09-30

- **Ink instead of magenta.** The accent for what waits on a person is ink
  by default (#171717 light, #ededed dark), the way Vercel, Linear and
  GitHub work: the console is black, white and grey, and colour is kept for
  status (building, complete, warning, danger). Settings → Appearance
  starts its presets with Ink, Violet and Chart magenta; a colour you chose
  stays.

- **The console feels right under a finger.** Hover effects apply only to a
  mouse or trackpad (no stuck hover after a tap), no tap flash or tap delay
  on phones, link-buttons press like buttons, and one stronger ease-out
  curve. The phone navigation drawer slides in and out from the left,
  dialogs and menus get short entrances and exits (menus from their
  trigger), and everything is a plain fade under reduced motion. The ⌘K
  palette opens instantly.

- **Rename leftovers.** Deploy picks the state folder that holds the
  database; a new watch installs before the old-named one is removed; the
  setup guide still offers to update stale or old-folder instructions.

- **Faster, stricter release checks** (for contributors). `scripts/release-check.mjs`
  runs the unit tests related to a change and the browser journeys only
  when something a page shows changed; `e2e-parallel` retries only failed
  journeys (the whole group when the browser-error check failed), and a
  retry passes only if every first-run failure passed in its report.

- **Releases publish themselves.** Pushing a `v*` tag runs
  `.github/workflows/publish.yml`, which publishes to npm through npm's
  trusted publishing (no token, with provenance) and creates the GitHub
  release; the Homebrew tap follows within six hours.

- **An expired sign-in pauses that agent instead of burning retries.** A run
  that fails because its sign-in or API key no longer works (Claude's expired
  OAuth session or "Please run /login", a revoked key, Codex or Gemini not
  logged in, a 401) is `auth-expired`: no strike, no retry, never a paid
  fallback. Its task goes back to the queue and new work for that provider
  waits while the others keep running. `status`, `ready`, `task show` and the
  console say "Claude needs you to sign in again" and what to run, and every
  connected channel gets one message per incident. The pause lifts when a run
  or sign-in check on that provider works, or with **Resume** in the console
  or `toolroll providers resume <provider>`; one short message says how many
  tasks resumed.

- **An agent that stops before its handoff keeps its work.** Every builder,
  revision and repair prompt now says the agent runs headless (foreground
  commands only, no background-and-wait, wakeups or loops; hand off before
  stopping), and claude runs start with `--disallowedTools
  ScheduleWakeup,CronCreate,Monitor`. When an attempt ends with changes but no
  handoff, its own session is resumed in the same worktree with a short turn
  to finish and hand off. Its changes are saved as a patch in the run's
  evidence folder first; when the session cannot be resumed they become a
  work-in-progress commit on the branch the next attempt continues from, and
  a retry never resets that work. The failure reads "The agent stopped before
  handing off; its work was kept and it is being resumed". A handoff and a
  passing check are still required for success.

- **Sign-in pauses and kept work, follow-ups.** Fallback entries, attended
  continuations and resumed race lanes on a paused provider now wait (with the
  same one-trial-every-10-minutes) instead of failing, and the Tasks list
  shows every task the gate holds as waiting for a sign-in — planners and
  tasks on a configured or pinned provider included. A retry now actually
  inherits unhanded work (its admission refused it before); an attempt that
  finds a kept work-in-progress commit already complete and hands off with a
  clean tree succeeds; and once a later attempt fails some other way, the
  saved tree can be reset.

## 0.5.0 on npm as toolroll — 2026-09-30

The first `toolroll` package, published from the rename (PR 105). It carries the 0.5.0 notes below plus:

- **Toolroll under the hood.** The internal names follow the product name;
  every existing install, database, branch and integration keeps working, and
  nothing is moved. The npm package is `toolroll` (both the `toolroll` and
  `standing-orders` commands remain). A fresh install keeps its state in
  `~/.config/toolroll`, `~/.toolroll` and `~/.cache/toolroll`; a folder that
  already exists under `standing-orders` (or `nightorders`) keeps being used
  until one exists under the new name. Every `STANDING_ORDERS_*` variable has
  a `TOOLROLL_*` twin that wins when both are set; the old name still works
  alone, and processes Toolroll starts get both. New task branches are
  `toolroll/<id>`; `standing-orders/<id>` branches stay the plane's own (a
  retry reuses one, project delete, races, publication grants and coding
  handoffs recognise both). Watches install as `com.toolroll.watch.*`, and
  installing, stopping or removing one also finds, stops and removes the same
  repo's `com.standing-orders.watch.*` job. The skill folder is
  `.claude/skills/toolroll`; a managed `standing-orders` copy is replaced on
  install. Slack buttons send `toolroll_*` action ids and still accept
  `standing_orders_*` ones on older messages. Hash and digest inputs, the
  ledger genesis and stored format ids are unchanged, so existing data
  verifies.
  **Breaking for monitoring:** Prometheus metrics are renamed from
  `standing_orders_*` to `toolroll_*` (for example
  `toolroll_ledger_chain_ok`), and OTLP traces report `service.name` and the
  instrumentation scope as `toolroll`; the monitoring webhook `user-agent` is
  `toolroll/<version>`, and the MCP server and client name is `toolroll`.
  Update dashboards, alerts and collector filters. Span attribute keys
  (`standing_orders.*`) and the audit webhook's signature header are unchanged.

- **Retention settings.** An instance operator chooses how long run
  evidence and logs, finished checkout records, chat messages and
  notifications are kept (forever until chosen), on Settings → Retention or
  with `standing-orders retention show|set|preview`. Changes take the
  password and are in the action ledger. The worker sweeps once a day and
  writes one ledger entry saying what it removed and about how much space it
  freed. The ledger, unfinished tasks, results not yet completed and anything
  on hold are never removed; removed evidence says so instead of looking
  damaged.

- **Delete a project.** An instance operator can remove everything Standing
  Orders holds for a project: its tasks and their versions, runs and their
  evidence, the checkouts and `standing-orders/` branches it made, chats,
  flows and cards, teammates, budgets, settings and knowledge. Settings →
  Project asks for the project's name, then shows exactly what goes and
  asks for the password; `standing-orders project delete --repo <path>`
  previews and `--yes` deletes. Nothing is deleted while any of the
  project's work is running. The repository, its working copy and its own
  branches are never touched, other projects keep their rows, and the ledger
  keeps every entry (the chain still verifies) and gains one saying who
  deleted what. No undo; no schema change.

- **Organisation policy.** Settings → Policy (and `standing-orders policy
  show|set`) sets which providers and models may run, which project tools
  agents may use, and the highest permission level anything runs with
  (safe, standard or escalated). Saving takes your password; each change is
  in the action ledger, before → after, and the page shows that history.
  Scope approval, the tick and the last check before a build, fallback
  entries, race lanes, attended sessions, the lead and project chats,
  teammates and flow steps all obey it and say which rule stopped them.
  New filings are lowered to the ceiling; work approved above it runs
  lowered (the ledger says so), attended sessions are refused, and a
  provider with no setting that low (Codex at Safe) is refused.

- **Cost guardrails.** Work on a subscription (a Claude or Codex sign-in)
  counts as $0: what binds it is the plan's usage windows, which Tasks now
  shows as tiles (Claude's 5-hour and weekly windows as Claude reports them
  on every turn, Codex's as its app server answers every five minutes), each
  with when it resets, amber from 80 % and red when used up. How work is
  billed follows what the CLI actually did (Claude's key source on each run,
  Codex's account), not only the setting. Work billed to an API key is
  priced: what the provider reported, or its tokens at the model's price in
  Settings → Models (the provider's highest listed price when the model
  isn't listed), frozen when the run settles; key work that can't be priced
  at all waits under a budget until prices are loaded. The Spend page
  (and `standing-orders spend`) shows each month by project, person,
  teammate and model, with a CSV. Monthly budgets for the whole
  installation, a project, a person or an AI teammate alert at 50, 80 and
  100 % (once each, again after a change; a person's budget to that person,
  on Telegram too) and, unless set to alert only, stop API work at 100 %:
  queued tasks, fallbacks, resumed races, continuations, repair turns, key
  chats and flow sorts wait (the task page says why), and a Claude run's cap
  shrinks to what's left. Budgets and their limits also show as tiles on
  Tasks, are set on the Spend page or with `standing-orders budget`, with a
  step-up, and every change is in the ledger. Schema 105.

- **Stream it out.** Settings → Monitoring sends what Standing Orders does
  to the tools a company already watches. The audit stream delivers every
  sealed ledger entry, in order and at least once (retried, never skipped),
  to a webhook, each request signed with a secret shown once
  (`x-standing-orders-signature: t=…,v1=<HMAC-SHA256 of "t.body">`), and/or
  a folder of JSON Lines files; each batch carries the chain head, so the
  receiver keeps its own copy of the checkpoints. Traces send each run as an
  OpenTelemetry span (OTLP over HTTP) under its task's trace: timings,
  model, tokens and cost, never a prompt or code. `/metrics` serves
  Prometheus metrics to an instance operator's API token.
  `standing-orders monitoring` shows how each destination is doing.
  Schema 104.

- **Storage kept in check.** Standing Orders used to keep every build
  checkout and every staged release forever (78 GB here after a week). Now
  the worker removes a finished task's clean checkout two days after it was
  let go (a result marked complete, or a release candidate, a week after,
  since a deploy installs the build in its checkout). Its branch and commits stay; a checkout with
  anybody's changes, or commits on no branch, is never touched, nor is
  anything an unfinished or unplaced task works on. Each removal is in the
  action ledger. A deploy keeps the release it installed, the one before,
  the newest few and any a service or the CLI runs from; older ones go with
  the database backups they hold. `standing-orders storage` shows where
  the disk goes.

- **Audit you can prove.** The action ledger is now a hash chain: each entry
  is sealed with the one before it, and the ledger page (or `ledger verify`)
  says whether it still verifies, or the first entry that was changed,
  removed or added. Instance operators make checkpoints to copy off the
  machine (`ledger checkpoint`); `ledger verify --checkpoint` compares one,
  and is what proves history before it wasn't rewritten.
  Every task has an evidence pack, as a printable page and JSON: who filed
  it, the approved terms and approvers, the rules in force, agents and
  cost, changed files, checks, completion, publication and its sealed
  ledger entries (`task evidence <id>`). The ledger page's Audit export (or
  `ledger export --from --to`) downloads a date range with a pack for each
  task. AI teammates' tool calls (and who approved or undid them) and new
  coordinators are in the ledger now too. Schema 103.

- **Separation of duties.** Every task records who filed it (the person, or
  the person a coordinator acts for). Settings → Approval rules (or
  `project rules`) lets an instance operator turn on, per project,
  "someone other than the requester approves" and protected work: the whole
  project, or paths like `infra/**`, need two different people to approve
  the same scope ("1 of 2" until the second; a changed scope starts over),
  and never an operating mode, a routine, a watched run or an AI teammate.
  Whoever wrote the scope or made a standing order counts as a requester,
  and a result whose actual diff reaches protected files on a one-person
  approval completes only by someone else. Everything is off until a
  project turns it on. Schema 102.

- **Sessions and API tokens.** Settings → Sessions & tokens lists where
  you're signed in and signs any of it out; sessions now survive a restart.
  API tokens (read, or act as you, never approve) replace passwords on
  requests for scripts and CI, expire in 30 to 365 days, are shown once and
  named in the ledger on every request. Coordinator credentials expire (90
  days unless `--days`), and runner tokens a year after registering.
  Schema 101.

- **Sign in with your identity provider.** Settings → Sign-in connects Okta,
  Microsoft Entra, Google or any OpenID Connect provider. People sign in
  there; their groups make their account and set its role (Operator or
  Viewer) and projects again at each sign-in. Approvals are confirmed by
  that sign-in (within ten minutes, or "Confirm with …"), not a password.
  Passwords can be kept for instance operators only, as a way in if the
  provider is down, and an existing account can be linked. Schema 100.

- **Hardening for teams.** Five wrong passwords lock a name for 15 minutes,
  on every road a password takes (signing in, a request, a step-up), and one
  address guessing across names runs out of tries. The action ledger now
  records sign-ins and policy changes with what changed (the permission
  default "Auto → Full access", a teammate's tool rules, an agent choice, an
  operating mode), and shows installation events to instance operators. A
  person's coordinators end with their standing. `/healthz` answers a probe,
  errors are always logged (`STANDING_ORDERS_LOG_FORMAT=json` for JSON
  lines), and more key shapes (Stripe, Google, GitLab, Telegram and Discord
  tokens, passwords in URLs) are blanked. Schema 99.

- **One look on every page.** Board, Inbox, Next, Done, System, Portfolio,
  Code and Settings → Tools now sit in the same workspace as everything else,
  with the same navigation and search. Live pages (System, Activity) refresh
  themselves inside it without disturbing a form you're filling in. Sign-in,
  invites, error pages and "not found" share the look too, and a one-time
  secret (a worker token, an invite link, a pairing code) gets a focused page
  in the same style, still with no script on it.

- **Connect a service with one click.** Stripe, Notion, Linear, Sentry, Jira,
  Intercom, Attio and ten more connect by signing in on the service's own
  page: no key to copy. The sign-in stays in the tool's secrets file and is
  renewed before it runs out. A starter kit's Connect also lets its teammate
  use the tool. The lead points you to the right tile instead of asking for a
  key.

- **Starter kits.** Support desk, Bug triage, Sales follow-up and Ops
  requests each set up a teammate, the flow it works and its buttons in one
  click. The kit's page lists what's left (email, the tools it uses) and
  **Try it** puts a sample card in front of the teammate so you see it work.
  The lead can set one up too.

- **Smoother page changes.** Moving between pages fades the old one out
  before the new one arrives, so text never overlaps mid-change, and the
  sidebar holds still.

- **Telegram pushes your messages.** With a public hooks address, Telegram
  delivers each message and tap to Standing Orders the moment you send it,
  signed with a secret, instead of Standing Orders asking for them. No other
  program can take your bot's messages meanwhile, and "Conflict" no longer
  fills the log when one tries.

- **A weekly report per teammate, and undo.** Every Monday its manager gets the
  week: what it did, its tool calls, what its turns cost, and what you
  overrode, each linked. Name an action's opposite (remove_label for
  add_label) and its receipts get an Undo that calls it with the same input,
  as you.

- **Message a teammate by name, and give it routines.** "@maya where's order
  2201?" in Telegram, Slack, Discord or Teams lands on Maya's desk, and the
  answer comes back to you there. Routines ("weekdays 09:00: look up
  yesterday's refunds") put a card on its desk on a schedule and report to
  its manager. A code change it's asked for is filed as an ordinary task
  under your approvals.

- **Teammates remember, and learn from you.** Each teammate keeps a memory:
  what you tell it, and short facts it keeps from the cards it works, read
  back when a later card is about the same thing. Search, edit or forget any
  of it. Approve the same kind of call five times in a row and it suggests
  the rule that lets it act alone; one tap accepts.

- **Teammates that act.** Let a teammate use your project's tools (a shop, a
  CRM, a mailbox) with a rule for each action: do it, do it up to a limit,
  ask first, or never. An ask-first call reaches you on the card and in your
  chat app exactly as it would be made; Approve makes that call, Deny doesn't.
  Every call is a receipt on the card and the teammate's page, and the lead
  can change a rule from plain words.

- **AI teammates.** Agents with a soul file you write (who they are, how they
  write, what they decide alone, what they ask first, what they never do)
  decide "Person decides" zones and handle their own zones, write replies,
  move cards on, and bring you what their rules say to ask about, in your chat
  app under their own name. A note for this week, a daily summary, a pause
  button, and templates for support, sales, ops and triage. Answer a
  teammate's question with a tap, or in your own words, in Telegram, Slack,
  Discord or Teams.

- **Wait for replies.** A Wait zone after a Send email zone waits for the
  person to answer. Their reply moves the card on and joins its discussion;
  with none in time, the card takes its no-reply path, like a nudge that stays
  in the same thread. Only replies from people the card wrote to count.

- **Time limits.** Any zone can remind whoever a card is waiting on after a
  while, and Holding and decision zones can move it on. New templates: Reply
  and follow up, and Decisions that don't stall.

- **Send-backs are planned again.** Sending a result back with a note has the
  planner update the plan with it; a note asking for more becomes a change
  you see and approve before anything builds.

## 0.5.0 — 2026-09-25

Flows: your process drawn as zones that cards move through, with agents doing
the work and people deciding.

- **Canvas and chat.** Draw flows on a canvas or describe them to the lead;
  every change is a card you confirm. Templates for coding, research, issue
  triage, spam filtering, lead, effort and exception routing, and email replies.
- **Triggers.** Buttons (and public forms), schedules, GitHub, Linear, other
  flows and webhooks start cards on their own.
- **People.** Owners, followers, @mentions, and a flow owner whom decisions
  go to, in their chat app.
- **Steps with and without AI.** Build and Research tasks; scripts with no AI;
  **Sort** with Jev (TypeSafe's decision model, through OpenRouter); **Draft**
  with Claude; web requests with secrets kept to headers; email through your
  own mail server; any of a project's MCP tools; updates to the GitHub or
  Linear issue a card came from.
- **Decisions from your phone.** Telegram, Slack, Discord and Teams
  messages carry the draft with Approve, Edit and Send back.
- **Email in.** An Email inbox trigger turns new mail into cards (IMAP, or
  a Google account signed in with Google), and replies to the sender stay
  in the thread. Automatic replies and your own mail never become cards.
- **Code in flows.** Scripts in Python, Node or shell (or a file in the
  project) get the card as data; what they print is passed on, a `goto:` line
  picks the next zone, saved secrets arrive as variables, and a schedule can
  run a script to make a card of each item it prints.
- **Chat in.** A Slack, Discord or Teams channel, or a Telegram group, feeds
  a flow after `flow 12` in it: each message is a card, replies in its thread
  join the discussion, and an Update zone answers in that thread.
- **Live canvas.** A flow open in several browsers changes in all of them
  the moment a card moves, and shows who else has it open and which card
  they're looking at.
- **Insights.** Where each flow breaks, how scripts do, how well sorting
  sorts, and every step's log.
- **Linux.** A one-command installer, and Claude and Gemini agents fenced
  with bubblewrap the way Seatbelt fences them on macOS.
- **First look.** `demo` now includes two flows mid-flight, and an empty
  Flows page offers a working example.
- **Settings.** An Email section, and "Check again" that really tests an
  API key.

Schema 90: the database upgrades itself on first start.
