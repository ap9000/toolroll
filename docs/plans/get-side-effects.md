# Quiet GETs: a page visit only reads

Status: built, 2026-10-27. Branch `get-no-side-effects`.

Alex: *"need those fixed in all cases"*. A plain GET of any console page or JSON endpoint must not change state or
act. 0.9.74 (PR #246) stopped GETs from starting lead conversations; this finishes the job for every other route.

A prefetch, a link preview (Slack, iMessage), an `<img src>` pointing at a console address, a browser restoring tabs,
or a person opening a page must never: spend, settle spend, resume or pause work, turn the lead on, queue a
notification, lift a pause, close a mode or grant, start a process, or call the network.

## The rule

- **A GET reads.** It renders the saved state and the last answer of each check, with when it was checked.
- **Checks run in the background** (`backgroundChecks` in `serve.ts`, on for `up`, `serve` and the demo): this
  computer's agent sign-ins, the other keyed agents, integration checks, the OpenRouter lists, the newest release, the
  checkout sizes, Codex's configured tools, Chat's first tasks and learning recovery. They also do the tidy-ups pages
  used to do: closing an operating mode or a flow's "runs on its own" grant past its expiry, releasing a stalled update,
  expiring old coordinator proposals, discovering the identity provider, moving the demo's story on.
- **"Check now" is a POST** with the person's form token and the same role the page needs. Each one runs the same check
  the background runs and redirects back to the page.
- Every GET and HEAD runs inside `asReadOnlyRequest` (`src/read-only-request.ts`). The few store reads that used to tidy
  up as they went check it and leave the write to the background pass or the next path that acts:
  `Store.activeMode`, `activeUnattendedGrant`, `waitingUpdate`/`desktopUpdateWaitingOf`, `reconcileIdentity`,
  `learningView`, `secretFolder`, `readToolSecrets`, `readHeldSecret`, `secretsSetFor`, the Knowledge search's git, and
  the project identity (read from the `.git` folder itself instead of `git rev-parse`).

Permissions are unchanged: each new POST carries the role of the page it serves (or a stricter one, noted below), the
shared CSRF/origin guard, and no new step-up was removed.

## Allowed bookkeeping

What a read may still write, because it records the read itself or caches what is already decided:

| What | Where | Why it stays |
| --- | --- | --- |
| Session last seen (at most once a minute), an ended session dropped | `web_session` | The sign-in's own idle clock. |
| API token last used (at most once a minute) | `credential.last_used_at` | Same, for a token. |
| Request counters and their 429 audit line | `request_budget_usage`, `action_ledger` | Rate limits count reads. |
| Audit lines: refusals, sign-in lockouts, `ledger.export`'s "ledger exported" | `action_ledger` | Recording that data left, or was refused, is the audit trail, not an action. |
| Ledger seals of entries already written | `ledger_seal` | Deterministic hashes of existing rows; the worker writes the same each pass. |
| The workspace revision cursor | `service_cursor` `workspace-content:v1` | Moves with the rows above. |
| Seen marks | `agent_seen`, the inbox-seen cookie, `session.sawBoardAt` (memory) | A person looking is the fact recorded. |
| Derived caches | `run_efficiency`, the conversation/memory search index, in-memory page caches | Recomputable from saved rows. |
| The first-success fact | `installation_fact` `first-success-at` | Memo of a run that already finished. |
| Form nonces | memory, `ceremony_nonce` (capped per approver) | A form can't render without one. |
| Live presence | `agent_view` lease while `/live` is open | Holds chat pings while someone watches; ends with the connection. |
| Expired OAuth client and code rows | `oauth_client`, `oauth_code` (on `/oauth/authorize`) | Pruning state that has already expired. |

`src/server/get-quiet.test.ts` hashes every other table whole.

## Kept on GET, with reasons

| Probe | Route | Why it may stay |
| --- | --- | --- |
| Protocol callbacks: OAuth returns (`edge.google-callback`, `edge.connect-callback`), SSO (`edge.sso-callback`, `edge.sso-finish`), the one-time sign-in link (`edge.login-link`), `edge.oauth-authorize` | the provider sends the browser back with a GET | The protocol is a GET carrying single-use state minted by the person's own POST; each is consumed once and a replay does nothing. |
| `git` in a coding session's checkout | `code.changes`, `code.ship` | Read-only (`--no-optional-locks`), bounded (60 s), local, through the hardened checkout git (`checkoutGit`, new `checkoutGitSync`): a config that could run a command is refused, no system or global config, submodules skipped. On top, `PAGE_READ_FLAGS` hold even if the config changes after it was inspected: hooks, fsmonitor and the pager off, no lazy fetch, every protocol refused, attributes read from the empty tree (so no filter or textconv runs), and a diff takes `--no-ext-diff --no-textconv`. |
| `git` for Settings → Knowledge's search (`?q=`) | `settings.knowledge` | Only when the person searches; the same hardened checkout git with `PAGE_READ_FLAGS`, bounded (10 s). |
| The update lock probe | `settings.updates`, the chrome for operators | Whether the updater holds its lock: opens the lock file only if it exists, takes and rolls back an exclusive lock, never creates or changes the file (`lockHeld`). |
| The keychain read (`/usr/bin/security`, `secret-tool`) | Tools, Flows, Kits pages | Reads whether a secret is set; owner-checked binary, bounded (20 s), local. Moving legacy files in, the lock file and the names cache now wait for a non-GET read. |
| Process liveness (`kill -0`, `/bin/ps`, the Windows job helper) | task, review, inbox, sweep pages | Reads whether a run's process is alive; bounded (1–5 s), local, writes nothing. |
| Folder walks (projects browse, retention plan, peek) | | File-system reads, bounded by their own limits. |
| The terminal WebSocket (`term.socket`) | | The upgrade is a GET by protocol; it attaches to an existing terminal after the same cookie, role and origin checks, and keystrokes are frames sent by the page, not the GET. |

## The audit

Every GET and HEAD row in `src/server/route-table.ts`. "Reads" means reads plus the bookkeeping above. Every console
page also renders the shared chrome, which did two of the actions below (marked *chrome*).

| Route | What it did beyond reading | What it does now |
| --- | --- | --- |
| *chrome* (every page with a project) | `activeMode` closed an expired mode: revoked it, withdrew mode-sealed approvals, moved merge intents to waiting-human, queued "approval needs renewing" notices | Reads it as no mode; the background pass (`closeExpiredModes`) and acting paths close it |
| *chrome* (operators) | `waitingUpdate` released a stalled `toolroll update` or desktop update: ungated, deleted the stage folder, wrote the journal and ledger | Reads; the background pass runs the same `waitingUpdate` outside a page visit, so it releases in every folder the chrome looks in |
| `lead.status` | Fresh provider CLI probes, could lift a sign-in pause (resumed tasks, notified operators), and with lead-by-default turned the lead on | Reads the last answer (with `checkedAt`); Chat's first run polls the new `POST /lead/check` (form token), which probes and applies lead-by-default |
| `inbox`, `chat.page` (first run) | Started the same probes in the background; `gh issue list` and `git grep` for first tasks | Reads the last answers; the background pass probes every 2 min and finds first tasks while the first run is open |
| `settings.lead` | Same probes when none had run; OpenRouter catalog fetch with the saved key | Reads; **Check again** (`POST /lead/check`) when no agent is signed in |
| `chat.page` | `sweepStaleChatTurns`, `sweepStaleLeadTurns` (settled spend into `lead_session.spent_microusd`), `sweepCoordinatorProposals`; OpenRouter fetch | Reads; the lead's follow pass (every 5 s, and now also while an update drains and in the demo) settles turns, the background pass expires proposals |
| `chat.mate-status` | `sweepStaleLeadTurns` on every poll | Reads |
| `task.page`, `chat.task-status`, `workbench?t=` (approvers) | `sweepCoordinatorProposals` | Reads |
| `settings.models` | Hourly `checkModels`: OpenRouter and npm fetches, `--version` spawns, catalog writes, "new model" notifications | Shows the last check and when; **Check now** (existing POST) and the watch loop's automatic checks |
| `settings.integrations` | Started every integration check (Telegram, Slack, Discord, Teams, Linear, mail, `gh api user`, agent sign-ins, MCP tool tests) when older than a minute | Reads saved checks; the background pass checks every 10 min; **Send test** unchanged |
| `settings.page` (approvers), `control`, `control.connection` | Provider sign-in checks (could lift a pause); `?check-connection=` verified an API key over the network | Show the last answer; **Check again** is `POST /settings/connection/check` |
| `control` (OpenRouter) | Catalog fetch with the saved key; `?refresh-models=1` | Shows the last list; **Refresh models** is `POST /control/models-refresh` |
| `settings.updates` | npm registry fetch; `?check=now`; released a stalled update | Shows the last answer; **Check now** is `POST /settings/updates/check` (operator) |
| `settings.storage` | `du` with no timeout and git per checkout | Shows the last measurement and when; **Check now** is `POST /settings/storage/check` (operator); clean-up re-measures; `du` now has a timeout |
| `settings.pull-requests` | `git remote`, `gh auth status`, `gh repo view`, `gh api user` when off | Shows the last setup check; **Check setup** is `POST /settings/pull-requests/check` (approver who may turn it on) |
| `settings.tools` | `codex mcp list --json` | Reads the background pass's list (every 10 min per project) |
| `settings.project` | The macOS sandbox probe (`sandbox-exec … /usr/bin/true`) | Asked once as the console starts |
| `settings.skills`, `settings.knowledge`, `settings.learning` | `git rev-parse` for the project identity; carried saved rows to a new identity; recovered learning rows from reviewed runs | Identity read from the `.git` folder (small plain files only, never through a link); the background pass carries every managed project's identity and recovers learning (and each run's start recovers, as before), with its git bounded and hooks off |
| `projects.github` | `gh repo list` on every visit | Shows the last listing; **List repositories** / **Refresh list** is `POST /projects/github` (approver, browser) |
| `push.key` | Created the VAPID key file (in the working folder when no config folder) | Reads; the pair is made as the console starts |
| `settings.tools`, `settings.project`, `flows.new`, `flows.gallery`, `flow.page`, `kit.page` | Prepared the secrets folder (lock, key file), moved legacy secret files into the keychain (and destroyed them), took lock files, wrote the names cache | Read the keychain or the old file; the folder is prepared as the console starts (a page before that says secrets can't be read yet); moving waits for a non-GET read |
| `flow.page` | Closed an expired "runs on its own" grant (ledger line, approvals withdrawn) | Reads; `closeExpiredUnattendedGrants` in the background pass |
| `recipes.preview`, `mode`, `settings.checks` | `activeMode` expiry, as the chrome | Reads |
| `code.changes`, `code.ship` | git in the agent-written checkout without the hardened helper | Kept (see above), now hardened |
| `edge.google-callback`, `edge.connect-callback`, `edge.sso-callback`, `edge.sso-finish`, `edge.login-link`, `edge.oauth-authorize` | Protocol state consumed, tokens exchanged, secrets stored, a tool added | Kept: protocol-required (see above) |
| `edge.sso-start` | Fetched the identity provider's discovery document when not cached | Uses the provider as last discovered (at console start, by the background pass every ten minutes, when sign-in settings are saved or tested); before the first discovery it says the provider isn't answering yet |
| `settings.updates` (and the chrome for operators) | The updater lock probe created `worker.sqlite` and changed its mode | `lockHeld` reads without creating or changing the file |
| `ledger`, `metrics`, `task.evidence`, `ledger.export` | Sealed unsealed ledger entries; export writes its audit line | Kept as bookkeeping |
| `agents`, `review` | `agent_seen` marks; `run_efficiency` cache | Kept as bookkeeping |
| `live` | `agent_view` lease | Kept as bookkeeping |
| `chat.action` | `ceremony_nonce` row | Kept as bookkeeping |
| `chat.page`, `chat.demo-live` in `toolroll demo` | Advanced the scripted story (finished runs, wrote evidence) | Read only; the beat timers and the background pass move it on |
| Every other row: `edge.healthz`, `edge.instance`, `edge.flow-form`, `edge.oauth-discovery`, `edge.team-read`, assets, fonts, `edge.desktop-health`, `edge.login-page`, `edge.join`, `home`, `work`, `next`, `morning`, `board`, `spend`, `activity`, `done`, `people.page`, `system`, `tasks`, `queue`, `peek`, `agents.live`, `agents.live.read`, `fleet`, `tasks.new`, `runs`, `menu`, `run.page`, `run.evidence`, `caps`, `flows.page`, `kits`, `subagents*`, `flow.insights`, `flow.run`, `flow.export`, `recipes*`, `routines`, `routine.page`, `chat.ack`, `settings.approval`, `settings.policy`, `settings.monitoring`, `settings.retention`, `settings.backups`, `settings.data`, `settings.sign-in`, `settings.sessions`, `settings.teams`, `settings.discord`, `settings.slack`, `settings.slack/manifest`, `settings.flows`, `settings.telegram`, `settings.passwordless`, `health`, `decision.page`, `decision.evidence`, `term.*`, `sweep.page`, `code.page`, `code.session`, `code.state`, `code.other`, `projects.browse`, `projects.page` | Reads (plus bookkeeping) | Unchanged |


## What a person notices

- Settings pages say when something was last checked and offer **Check now** / **Check again** / **Check setup** /
  **List repositories** where a check used to run on opening. Right after a restart, before the first background pass,
  a page can say "Not checked yet".
- Chat's first run asks this computer again through a POST every few seconds, as before; a viewer's page no longer
  can (approvers only).
- The lead turns on by default from the start-up look or the background pass (within about two minutes of signing
  in an agent), or at once from Chat's first run or Settings → Lead → **Check again**.
- An expired mode or flow grant shows as ended at once; its row and notices are written within 30 seconds by the
  background pass.

## Tests

- `src/server/get-quiet.test.ts`: every GET and HEAD row, signed in and signed out, plus deeper addresses
  (a project named, a search, the old check query strings, a task's chat), against a world where each old action would
  fire (an open sign-in pause a probe would lift, lead-by-default with an agent signed in, a stale lead turn, an
  expired mode, a never-checked model list, a git project). No table changes outside the bookkeeping above, no file
  under the world created or changed, no child process (every `node:child_process` function is spied; only the
  Knowledge search's hardened git is let through), no `fetch` or `https` request, no notification; and the pages that
  used to act really rendered (200).
- `test/attacks/get-prefetch-preview.test.ts`: the same world fetched as a prefetch, a link preview bot, a cross-site
  image and a navigation, then the CSRF-bound POSTs as the positive control.
- `src/server/get-quiet-background.test.ts`: the moved actions happen at their new trigger (the background pass, the
  follow pass even while an update drains, each Check now).
- `test/attacks/checkout-git-sync.test.ts`: a checkout whose config names fsmonitor, a filter, an include, a pager or
  an external diff is refused, and the page-read flags alone keep each from running when it is planted after the
  inspection.
