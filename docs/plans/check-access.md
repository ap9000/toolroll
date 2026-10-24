# Check access per project, and a short launch folder (0.9.69)

## Why

Since 0.9.66 a build's setup and check commands run inside the plane's OS fence. There are two runners:

- `fencedCommands` (src/invoke.ts) runs a build's setup and checks, including every release check. It uses the write mode sealed in the approved profile (`launchWritesOf(profile)`, builder.ts).
- `fencedCheckoutCommands` (src/invoke.ts) runs batch checks (batch-checks.ts) and result follow-ups (result-follow-ups.ts). It reads the project's write mode live.

Both run with `provider: "command"`. So `taskBoundary` keeps every `HOME_CONFIGURATION` entry denied: `~/.claude`, `~/.claude.json`, `~/.codex`, `~/.config/gh`, `~/.ssh` and the rest. That is right for an unknown project. It breaks three kinds of legitimate checks:

1. **Checks that call model CLIs or gh.**
   - Codex can't read `~/.codex/config.toml` or its sign-in.
   - gh can't read `~/.config/gh`.
   - Claude still signs in from the macOS keychain. But it can't resume a session: `~/.claude/projects` isn't writable. Before 0.9.68, Toolroll's own preflight also refused because `settings.json` was hidden.
2. **Checks that must create a sandbox themselves.** macOS refuses `sandbox_apply` inside any sandbox whose profile denies anything, so Toolroll's own fence, Codex and terminal tests can't run inside a fence. The fence also hides other processes from them (`process-info-pidinfo` and `kern.procargs` are denied).
3. **Unix sockets under TMPDIR.** The launch folder is `mkdtemp(tmpdir()/so-cmd-)/tmp`. On macOS that is 69 bytes before the check adds anything, which is 19 bytes deeper than a person's TMPDIR. sun_path is 104 bytes, so a console or worker socket no longer fits.

0.9.68 worked around this for Toolroll's own release check only. Tests skip inside a fence (`test/inside-fence.ts`, 23 skips), test worlds use their own HOME and XDG config, and the Claude preflight proceeds on EPERM. Those skips stay as a fallback, but they shouldn't be the way Toolroll's own release is checked.

## The setting: check access, per project

| Level | Name in the UI | What the fence does for the project's setup and check commands |
|---|---|---|
| `sandboxed` (default) | Sandboxed | As today. |
| `sign-ins` | Sandboxed, with model and GitHub sign-ins | As today, except the exact sign-in files of Claude, Codex and gh become readable, and this checkout's own Claude transcript folder becomes writable. Everything else stays denied: other projects' sessions, `.ssh`, `.aws`, `.gnupg`, `.netrc`, `.git-credentials`, `.kube`, docker config, other projects, Toolroll's state. **The commands also get the project's network fence**, which command runners don't apply today (Codex finding 1); `sign-ins` can't be chosen until they do. |
| `unsandboxed` | Not sandboxed | No OS fence around the commands, as before 0.9.66. **The project's checks are trusted by the whole instance:** they can open Toolroll's real database by path, read every credential, and act as the person on this machine. The disposable database only changes environment variables (child-database.ts:31). The short launch folder still applies. |

**Scope.** The setting covers checks and setup commands only, through both runners. Agent builds are unaffected: their fence already keeps their own provider home (`PROVIDER_HOME`), and widening an agent's fence is a different decision.

**What `sign-ins` grants, exactly.** *Superseded by "Review round 1" below:* grants are fixed canonical files, never env-derived dirs, and never whole provider homes. The draft text is kept for the record:

- **Read:**
  - `claudeConfigDir(env)` (`~/.claude` or `CLAUDE_CONFIG_DIR`) and `~/.claude.json`
  - `codexHomeDir(env)` (`~/.codex` or `CODEX_HOME`)
  - gh's config dir: `GH_CONFIG_DIR`, else `$XDG_CONFIG_HOME/gh`, else `~/.config/gh`
- **Write:** only where each CLI must keep state to work:
  - Claude: `projects/`, `todos/`, `shell-snapshots/`, `statsig/` and `.claude.json`. This list is confirmed empirically in phase 2 with the fenced-run harness. Anything not needed stays read-only.
  - Codex: `sessions/` and `log/`. Better still, follow the builds' pattern (`isolatedCodexHome`): a per-launch `CODEX_HOME` in the launch folder that links `auth.json` and `config.toml` read-only and keeps sessions there. That leaves `~/.codex` read-only.
  - gh: nothing.
- **macOS:**
  - Keychain access stays as it is under `(allow default)`; nothing new is needed, as verified in 0.9.68.
  - Paths are granted as `file-read*` subpaths after the home denies, as the linked-deps grant already does.
- **Linux:**
  - The same paths go into `FenceGrants.readOnly`, plus a writable set, through `flattened()` for bubblewrap.
  - The Codex fence argv (`codexFenceArgv`) never sees these grants: checks don't run inside Codex.
- **Bare-name grants only.** A symlinked home dir resolves with `real()`. A grant that resolves outside `$HOME`, or inside another project's checkout or Toolroll's state folder, is dropped with a one-line note. This mirrors `fenceGrants` linked-deps validation.

**Sealing.** The level is sealed into the scope like `writes` (scope.ts `writes?: WritesMode`): it is resolved when the scope is written, folds into the digest, and is shown on the approval card ("Checks: not sandboxed"). So:

- A scope filed before 0.9.69 reads as `sandboxed`.
- Changing the project's level affects scopes written afterwards; approved scopes keep theirs.
- A widened level always needs a fresh yes on a fresh scope. A release gate task is filed per commit, so the next release picks the new level up and the approval card says so.
- `fencedCheckoutCommands` (batch checks, follow-ups) has no scope of its own. It reads the level live but only ever applies `min(live, sealed level of the result's task)`. A batch check therefore never runs wider than any task in it was approved for.

**Who sets it.**
- **The person:** an instance operator, with a password step-up (`credentialApprover` + `isInstanceOperator`), as `config unconfined-agents` does. An approver alone can't, because both wider levels expose the operator's own credentials or machine.
- **The ledger:** each change is recorded with `recordPolicy(by, repo, "check access", before, after, now)`.
- **Narrowing** to `sandboxed` takes an approver for the project, as `project writes` does. Making things safer shouldn't need the operator.

**Surfaces.**
- **CLI:** `toolroll project check-access [sandboxed|sign-ins|unsandboxed] --repo <p>`, with `--as/--token(-file|-env)`, `--db` and `--json`. It follows `project writes`:
  - registered as an `operator()` row in surface.ts
  - listed in `REMOTE_STEP_UP`
  - the help text is one line.
  - With no value it shows the level, in words.
- **Console:** a "Check access" section on the project's settings page (server/settings.ts, next to build writes), using the same password form.
  - It shows a radio for each level, a plain warning under each wider one, and who changed it last and when.
  - The release-verification project shows "Not sandboxed — Toolroll's own checks create sandboxes" as its reason line.
- **Evidence:** each check run records the level it ran under (`check_access` on the run's check evidence), and the result page says "Checks ran without a sandbox" or "with model and GitHub sign-ins" whenever the level isn't sandboxed.

**Words** (plain labels; feedback-plain-ui-labels):
- **sign-ins:** "This project's checks can read your Claude, Codex and GitHub sign-ins. Its tests could use or send those credentials anywhere its network setting allows. Only choose this for projects you trust."
- **unsandboxed:** "This project's checks run with your full access to this machine, as they did before 0.9.66. Only choose this for a project whose checks must create sandboxes themselves, such as Toolroll's own."

## Short launch folder (all levels)

`fencedCommands` and `fencedCheckoutCommands` both `mkdtemp(join(tmpdir(), "so-cmd-"))`. On macOS they'll make it under `/private/tmp` instead, as `/private/tmp/so-cmd-XXXXXX`. The command's TMPDIR becomes `/private/tmp/so-cmd-XXXXXX/tmp` (29 bytes, versus about 69 today).

- The fence denies every other launch folder there by pattern, as it does under tmpdir today. `runFolders` gains a second root, and `RUN_FOLDER_PREFIXES` is denied under both.
- The writes allowlist keeps the launch folder writable and the rest of `/private/tmp` read-only, as `test/attacks/fence-writes` already asserts for the shared temp folder.
- `/private/tmp` is shared between users, so the folder is created 0700 by mkdtemp. A pre-existing symlink can't redirect it, because mkdtemp creates the leaf atomically and the fence grants the realpath. Cleanup is unchanged.
- On Linux, tmpdir is already `/tmp`; nothing changes.
- 0.9.68's socket skips (console-instance, quick-start, up, egress, agent-fence-writes) were there because no writable folder was short enough. Once the fence's TMPDIR is short they pass inside a fence. The phase 4 tests prove that.

## Migration (schema v132)

```sql
CREATE TABLE IF NOT EXISTS project_check_access (
  repo        TEXT PRIMARY KEY,
  level       TEXT NOT NULL CHECK (level IN ('sandboxed', 'sign-ins', 'unsandboxed')),
  updated_at  TEXT NOT NULL,
  updated_by  TEXT NOT NULL
);
```

- A missing row, or one that won't read, means `sandboxed`, so a damaged row is never wider than the default.
- The scope gets a `check_access` field in the profile JSON next to `writes`. It is absent on older approvals, which read as `sandboxed`.
- The upgrade path (scripts/upgrade-path.mjs) adds the v131 → v132 hop. The rollback drops nothing: the table is additive.

## Security notes

- **`sign-ins` exposes tokens to the project's code.**
  - Claude: its OAuth tokens are in the keychain, which a process under `(allow default)` can already query. The file grant adds `.claude.json` (account metadata) and `.credentials.json` on Linux.
  - Codex: `auth.json` (OAuth tokens or an API key).
  - gh: `hosts.yml` (a token, unless gh uses the keychain).
  - The project's network setting is the only exfiltration limit. The settings page should show the network setting next to the choice, with a one-line nudge when it is "open".
- **`unsandboxed` is pre-0.9.66 behaviour for that one project.** Other projects keep their fence. The level is sealed per scope, so a project can't be widened under an approved task. The approval card and the result page both say so.
- **Never the default, and never set by an agent.** It isn't in any agent tool, MCP gateway verb, mode or grant. The surface row is `operator()` (`agentMayInvoke: false`).
- **The release-verification project** gets `unsandboxed` once 0.9.69 is live. Its release approvals then read "Checks: not sandboxed", so every release yes sees it.

## Interaction with 0.9.68's workarounds

- `test/inside-fence.ts` skips stay as a fallback for an operator who keeps Toolroll's own project sandboxed. Under `unsandboxed`, `INSIDE_FENCE` is false, so nothing skips.
- The release check's report prints one line, "inside a sandbox: N tests skipped", when skips happened, so a sandboxed Toolroll release can't pass silently.
- The per-world HOME and XDG isolation and the EPERM preflight stay. They are good hygiene on their own.

## Tests

- **Unit (store and CLI):**
  - the default level
  - a damaged row reads as `sandboxed`
  - setting a wider level takes an instance operator and a password
  - an approver may narrow, and refuses to widen
  - the ledger records before and after
  - `--json` envelopes
  - the surface and contract snapshot.
- **Unit (fence):**
  - `sign-ins` adds exactly the three provider and gh homes, readable, plus the named writable session folders, and nothing else. The profile is diffed against `sandboxed`.
  - `.ssh` and `.aws` stay denied.
  - A home dir symlinked outside `$HOME` grants nothing.
  - Linux `flattened()` has the same set.
- **Unit (sealing):**
  - The scope digest changes with the level.
  - A scope written before the change keeps its level.
  - A batch check uses the narrowest level among its tasks.
  - The approval card names the level.
- **Slow fenced test (macOS sandbox, and bubblewrap on Linux CI):**
  - At `sign-ins`, `codex --version` plus a read of `$CODEX_HOME/config.toml`, `gh auth status` against a fixture `GH_CONFIG_DIR`, and a read of a fixture `CLAUDE_CONFIG_DIR/settings.json` all succeed.
  - A read of a fixture `~/.ssh/id_test` and `~/.aws/credentials` is refused.
  - At `sandboxed`, all of those are refused.
- **Slow test, `unsandboxed`:**
  - A check in project A runs with no fence: it can create a nested sandbox and its TMPDIR is under `/private/tmp`.
  - A check in project B in the same store is still fenced.
- **Socket test:** a check at `sandboxed` binds a unix socket under `$TMPDIR` with a 60-byte name. This proves the short launch folder.
- **e2e (app-e2e, settings page):**
  - The settings page shows Check access, and choosing "Not sandboxed" asks for the password and then shows the warning.
  - A new task's approval card shows "Checks: not sandboxed".
  - The result page shows "Checks ran without a sandbox".
- **Fenced harness (`fenced-run.mjs`):** run the full release check in the release-verification checkout under the deployed fence, first at `sandboxed` (skips counted) and then at `unsandboxed` (zero fence skips).

## Phases (one commit each, full suite green at each)

1. **Storage and CLI:** the v132 table, store get/set and ledger, the `project check-access` verb, the surface row and help, the upgrade-path hop, and unit tests.
2. **Fence:** the `sign-ins` grants for both runners (macOS profile, Linux flattened), the `unsandboxed` bypass, and the per-launch Codex home for checks. Confirm Claude's writable set with the fenced-run harness. Fence unit tests and the slow fenced tests.
3. **Sealing:** the level in the scope and profile and its digest, the batch-check minimum, the approval card words, the result-page evidence line, and tests.
4. **Short launch folder:** the `/private/tmp` root, the second runFolders root, and the socket test. Drop the 0.9.68 socket skips that no longer apply, proving they pass under the fence.
5. **Console:** the settings page section, the warnings, and the e2e journey.
6. **One Codex review over phases 1–5**, then fixes.

**Release 0.9.69** goes through the normal release, approved by Alex. After the deploy, Alex sets the release-verification project to "Not sandboxed" (one command or one click), and the next release check runs every test with no fence skips.

## Review round 1 (Codex): GO WITH CHANGES, all taken

These replace the draft wherever the two differ.

1. **Network is enforced, not just promised.**
   - Today neither command runner applies `grants.network`, so a check's network is the machine's.
   - Phase 0 gives both runners the project's network fence: the egress proxy plus `macosNetworkRules` on macOS, and bubblewrap's network namespace and bridge on Linux. This happens at every level except `unsandboxed`, and it ships first, on its own.
   - `sign-ins` isn't selectable until that ships.
   - The settings page shows the project's network next to the choice. "Open" network with `sign-ins` takes a second, explicit confirmation from the operator. An allowlist reduces destinations; it doesn't make credentials safe.
2. **Grants are fixed canonical files.**
   - The child's `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GH_CONFIG_DIR` and `XDG_CONFIG_HOME` are set explicitly to the defaults. Resolve grants against the final child env (builder.ts:389 env allowlist, exec.ts:504 overrides).
   - Granted, by realpath, each refused if it is a symlink or lies outside `$HOME`:
     - Claude: `~/.claude.json`, `~/.claude/settings.json`, and on Linux `~/.claude/.credentials.json`
     - Codex: `~/.codex/auth.json` and `~/.codex/config.toml`
     - gh: `~/.config/gh/hosts.yml` and `~/.config/gh/config.yml`
   - Never an ancestor folder (`~/.config` holds Toolroll's state).
3. **No access to other tasks' sessions.**
   - Claude: write only this checkout's transcript folder, `~/.claude/projects/<encoded checkout>`, mirroring the existing Claude workspace transcript grant. Nothing else under `projects/` is readable.
   - Codex: a per-launch `CODEX_HOME` inside the launch folder holding copies of `config.toml` and `auth.json`, made 0600 and deleted with the folder. Sessions are private to the launch. This is a new helper; `isolatedCodexHome` links shared sessions and isn't reused.
   - gh: read-only.
4. **Follow-ups are bound to the original run's authority.**
   - Every check execution stamps the level it actually ran under on its own receipt: the run check, the batch attempt, and the follow-up request.
   - A batch or follow-up uses the minimum of its member runs' stamped levels, never the task's current approval, because reapproval overwrites `approved_profile_json` (store.ts:8182). Missing or corrupt stamps read as `sandboxed`. A mixed batch splits by level.
5. **Only a person widens.** `sealScopeApproval` refuses to seal a scope whose check access is wider than `sandboxed` on any automatic road: mode, grant, chat automation or coordinator. Only the password ceremony does, as the coordinator quarantine works today. A routine or mode-filed scope in a widened project files as `sandboxed` unless a person approves the wider level.
6. **`unsandboxed` trust is stated as instance-wide** (see the table). Its warning: "This project's checks get your full access to this machine and to Toolroll itself, including its database and every sign-in. Only for a project whose checks must create sandboxes themselves, such as Toolroll's own."
7. **The global fallback is reported, not hidden.** When no OS fence exists and `unconfined-agents` is allowed, both runners already run commands unconfined (invoke.ts:1075/1112). That stays, but the execution stamps `unsandboxed (no OS fence on this machine)`, and the result page says so. The sealed level is a ceiling on fenced machines.
8. **Widening takes a password typed now.** It needs `password-now`, not `sso-now`: an empty password consuming a one-use SSO recheck is refused for this act (scope.ts credentialProof:1250). Narrowing to `sandboxed` takes any project approver.
9. **Linux uses its real mechanism.** Commands go `linuxFenced()` → `linuxGrants()`, which refuses read-only grants equal to or beneath a denied path (agent-fence.ts:887). So `sign-ins` removes the exact files from the deny set (a taskBoundary option) and denies their siblings explicitly, as `flattened()` splits for Codex. It is tested on Linux CI with bubblewrap.
10. **Flow script steps are out of scope.** They run approved setup through their own `agentFence()` (flow-steps.ts:374). They stay `sandboxed` whatever the project level, which is stated on the settings page.

### Launch folder corrections

- **"The rest of /private/tmp stays read-only" holds only under `workspace` writes.** Under `anywhere`, the default for approvals sealed before writes existed, the shared temp folder stays writable, as it is today. The plan claims only that other launch folders are denied.
- **macOS only.** Linux keeps `tmpdir()` (which honours `TMPDIR`), unchanged and tested. Linux's late-launch-folder exposure (folders enumerated once, no pattern mask, a private `/tmp` only with a confined network) is an existing gap. It gets its own roadmap item and an attack test.
- **Threat model.**
  - mkdtemp's atomic leaf creation stops a pre-placed symlink, not a later replacement by a same-UID process.
  - The grant is built from the realpath right after creation, and the folder gets the existing `(deny file-write* (literal own))` rename protection (agent-fence.ts:734).
  - A swap between creation and launch is covered by an attack test.

### Tests added

- **Follow-ups and batches:**
  - an original result checked after its task was reapproved wider still runs at the original level
  - missing or corrupt stamps run as `sandboxed`
  - a mixed batch splits
  - a policy change between setup and check doesn't widen the check.
- **Grants:**
  - a denied host from inside a `sign-ins` check is refused, natively
  - `GH_CONFIG_DIR=$HOME/.ssh` in the caller env grants nothing
  - a symlinked `hosts.yml` or `.claude.json` is refused
  - other projects' Claude transcripts and Codex sessions can't be read or written
  - a symlinked writable child is refused
  - all of these under both `workspace` and `anywhere` writes, with real runners.
- **Launch folders:**
  - late launch folders under both macOS roots are denied
  - the `/tmp` → `/private/tmp` alias
  - rename or replacement of the own folder is refused
  - Linux keeps `TMPDIR`.
- **Who may set it:**
  - a bearer or lead token is refused
  - a Passwordless session needs a typed password to widen
  - consuming an SSO recheck is refused for widening
  - a project-restricted approver can narrow only their own project
  - mode, grant and chat automation can't seal a widened scope.
  
  These extend passwordless-credentials.test.ts and password-policy.test.ts.
- **Real CLI work under `sign-ins`:**
  - an authenticated Claude turn that creates and then resumes a session
  - a Codex exec that writes its private session
  - gh api calls
  
  These go in the release check's real-model journeys.
- **Settings page:**
  - the warning shows before consent
  - a rejected save changes nothing
  - "open" network asks for the second confirmation
  - desktop and phone layouts.

### Phase order, revised

- **0.** Command runners apply the project network fence. It ships on its own.
- **1–6** as above. Phase 2 also includes the canonical-file grants, the transcript-folder write, the per-launch Codex home and Linux sibling denies. Phase 3 also includes the automation sealing refusal and the per-execution stamps.

## Open questions for review (answered in round 1)

- **Network:** keep "open" available with a second operator confirmation; the allowlist is advice, not safety.
- **Narrowing:** any project approver may narrow; widening stays operator-only. Narrowing doesn't revoke already sealed approvals, and the settings page says so.
- **A private Claude directory:** no. It changes the keychain entry, and linked session folders would keep shared writes, so it's the canonical files plus this checkout's transcript folder.

Original questions:

- Whether `sign-ins` should also require the project's network to be an allowlist, rather than only warning.
- Whether narrowing should also take the operator, for symmetry, or stay approver-level.
- Whether Claude's writable set can be avoided entirely with a per-launch `CLAUDE_CONFIG_DIR` that links the real one. 0.9.68 found that a different config dir loses the keychain sign-in, so probably not.

## Build notes (deviations from the reviewed plan)

- **Phase 0 lands with `sign-ins`, not on every level.** On the live instance every project uses the default network (allowlist, no local ports). Fencing every sandboxed check's network would break any project whose tests run a local server or fetch from GitHub, Toolroll's own builds included. A sandboxed check reads no credentials, so the network fence now applies where credentials are present: every `sign-ins` check runs behind a proxy of its own (on Linux, through the bridge). That is the risk review finding 1 named. Fencing sandboxed checks' network gets its own roadmap item with a rollout path.
- **No implicit hosts (security review).** A `sign-ins` check runs under exactly the project's network. Nothing is added for the services the sign-ins are for, because a check could send the person's token to any host the allowlist admits. When the allowlist doesn't cover Claude's and Codex's own hosts and GitHub's, the CLI (and the settings page) says so in plain words and names the separate command that adds them: "Model sign-ins need these hosts in this project's network allowlist: … Add them with: toolroll project network --repo … --allow …". Adding them is a network change of its own, with its own password. Tested: an unlisted service is refused, and is reached once its host is added.
- **Only session files in the transcript folder (security review).** On a Mac the sign-ins grant writes `^<folder>/[^/]+\.jsonl$` only, never the folder whole. So a check can't plant `memory/` or anything else a later real Claude session would load. A real `claude -p` session, started and then `--resume`d inside the fence, works with just that: Claude is refused `memory/` and carries on. Bubblewrap can't bind by pattern, so Linux grants no transcript folder (a Linux check can't resume a Claude session). An attack test checks that `memory/x.md` and other files are refused.
- **Claude's config folder is never set by Toolroll.** A caller's `CLAUDE_CONFIG_DIR` is removed instead, because Claude's keychain sign-in is keyed to its default folder. GH_CONFIG_DIR, XDG_CONFIG_HOME and CODEX_HOME are set to the granted ones.
- **The store write re-checks the level** in the write's own transaction (`may: narrow | widen`). A change made while a person proved themselves can't turn a narrowing into a widening (security review).
