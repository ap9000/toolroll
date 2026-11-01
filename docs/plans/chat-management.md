# Manage from chat — plan

Status: plan, revision 3, 2026-10-25. Branch `chat-manage-plan`, based on `release-0.9.72` (approval-policy phase 1
and release-once are in). Not built.

- **Revision 2** answered Codex round 1 (NO-GO, 7 High); the map is at the end.
- **Revision 4** answers Codex round 2 on revision 3 (NO-GO: original 2, 4, 5, 7 closed; 1, 3, 6 partial; 7 new).
  There is no further plan round; phase 0a's implementation gets a code review. The map is at the end.
- **Revision 3** took Alex's decision (2026-10-25): "Chat should be able to deploy and approve still." Chat keeps
  approving releases and deploy gates by tap until the authenticator ships, through a hardened release card, and gains
  a **Deploy** action. Then both need the code.

Alex (2026-10-25): "How do we make it so all code and management can be done from slack or telegram without ui? Needs
to be a setting for that."

## In one paragraph

A new instance setting, **Manage from chat**, with three levels:

- **Off**: today's behaviour.
- **Everyday work**: tasks, steering and reviews in chat, plus approvals and merges of normal work.
- **Everything**: releases, password-level settings and raising the lead's approval power too.

A **linked chat account is not proof of a person**: an agent holding the person's chat session or a user token can
press buttons and send messages as them. So a tap is enough only for acts the console takes without a password. Every
act the console guards with a password needs a **6-digit authenticator code** (TOTP, RFC 6238), at either level.
Everything adds the credential acts. **Releases are the exception (Alex, 2026-10-25):** chat approves and deploys
them by tap today, through a hardened release card, and with the code once the authenticator ships. The code goes into a keypad or form bound to one request, never into
an ordinary message. Chat runs every act through the console's own admission — role, project access, the operation's
proof — taken from the route table, which gains a chat column, rather than a new registry.

## What exists today (the base this builds on)

- **Linking is pairing.**
  - `chat_binding` holds provider, installation, member (an immutable user id), channel, approver and generation.
    The legacy `telegram_*` tables are migrated into it (`chat-migration.ts`).
  - Pairing codes are minted by a credential act: a password typed now, in the console or by
    `toolroll bridge telegram pair`. They are redeemed in a private chat (`telegram.ts` `/pair`; Slack `pair <hex>` in
    `slack-chat.ts receiveSlack`).
- **Buttons are opaque one-use tokens** bound to binding, chat and message.
  - `applyDecideTap` re-proves standing and staleness at the tap. Irreversible acts ask twice.
  - Telegram's `applyCallback` takes the tapper from `callback.from.id`. Slack's `applyChatAction` checks the member and
    channel again.
- **Inbound hygiene.**
  - Telegram ignores forwards, `via_bot`, `sender_chat` and captions.
  - Slack ignores subtypes, bot messages, other apps and teams, and externally shared channels.
  - Each update or event applies once.
- **Approving and merging from chat** work today only under the person's **Approve from chat** setting
  (`chat-approval.ts`) or a mode's `chatApprove` term.
  - The setting is per person, for all projects or one, with limits: full access or not, and an attempt cap. Turning
    it on is a credential act.
  - `planInChat` refuses: coordinator, scout or mate text (`quarantinedAuthor`); unresolved routes; plans over the
    limits; protected work; organisation policy; unverifiable plans.
  - `mergeInChat` refuses release and nightly tasks.
  - The yes seals basis `chat` with an `approval proved` row, outcome `chat`, which `personProof` counts as a person.
- **Protected chat actions** (`chat-actions.ts CHAT_ACTIONS`, `protected: true`) open a secure console screen
  (`/chat/action/:id`) instead of acting in chat: `scope_approve`, `sweep_file`, `task_resume`, `tool_add` (with a
  password); `skill_import`, `task_cancel`; and `result_accept`, which takes an in-chat challenge.
- **The route table** (`src/server/route-table.ts`) declares every console address with its callers, scope
  (`act` / `step-up`), role (`approver` / `operator`), project resolver and limited access. The server admits a
  request against it before any handler runs.
- **The fence** (`agent-fence.ts`): builds run as the OS user.
  - Under policy 1, home reads are allowed except `HOME_CONFIGURATION` (`.ssh`, `.aws`, `.claude`, `.codex`,
    `.config/gh`, ACP agents' homes …).
  - Under policy 2, `v2Boundary` denies nothing in home.
  - Neither denies chat app data or browser profiles today.
  - Build agents keep the Keychain (`sandbox-runtime.ts SEATBELT_NO_KEYCHAIN` applies to every other launch).
  - The console's chat lead runs with Toolroll's own tools only (`lead.ts`, `LEAD_TOOL_SCHEMAS`), with no shell or
    file access.
- **Files**: Telegram `sendDocument` and Slack `files:write` are already in use.
- **Secrets at rest**: `tool-secret-store.ts` (Keychain or Secret Service, sealed AES-256-GCM with a fenced key,
  bound to the item address; owner-only files elsewhere).
- **Nothing TOTP-like exists.**

## 0. Phase 0 — hardening that ships first (0.9.73), and Deploy from chat

Alex (2026-10-25): "Chat should be able to deploy and approve still." So phase 0 takes nothing away from chat. The
paired-chat tap keeps approving releases and deploy gates, recorded as a person's `chat` proof, which `personApprovalOf`,
`ownerApproval` and `deploymentCandidate` accept today. Phase 3 changes that to the code (§4). Until then the tap is
made meaningful, and the ways an agent could take the chat session are narrowed.

### 0a. Ships in 0.9.73: exactly five items

1. **Protected storage, denied to every launch** (§1.1): chat apps, browser profiles and password managers.
   - A mandatory deny list outside the version-1-only `HOME_CONFIGURATION`, applied by every boundary builder under
     both fence policies and on every backend, whatever the project's read settings.
   - Nested-link discovery, and the known configuration overrides.
   - Chat and vault variables kept out of every launch's environment.
   - Attack tests under both policies.
2. **Harden the release coordinator's Git.** This exposure exists **today** (below).
3. **A password on the three widening actions that take none today**: permission default to full access
   (`settings.permission-default-send`), a subagent tool grant (`subagent.tools op=grant`), and a kit's GitHub trigger
   (`kit.github`, which admits issues from anyone into a flow, `kits.ts addKitGithubTrigger`). An ordinary step-up, so
   a session works under Passwordless.
4. **Four project settings join the passwordless closed list**: network, writes, check access and sandbox. They
   already call `authenticateCredential`; listing them puts them under the static list test.
5. **The hardened release card**, with the complete terms renderer and a recorded change-list baseline (below).

Nothing else is in 0a. Deploy (0b) and every chat-management feature come after it.

#### 0a.2 The release coordinator's Git (today's exposure)

`toolroll release` runs plain `git -C <gate checkout> …` (`release-adapters.ts releaseAdapters`, the `git` helper)
with the inherited environment. It takes the repository's identity from that checkout's `origin` and fetches with its
configuration. `begin()` (`release.ts`) reaches `repo.github()`, `repo.sync()` and `remoteHead()` before any candidate
check.

The gate checkout is where the release check ran the build's own code, so its `.git/config` is build-writable. An
`include.path`, `core.sshCommand`, `core.fsmonitor`, a `remote.<name>.vcs` / `ext::` remote helper, or a `credential`
helper planted there **runs as the person, outside the fence, every time `toolroll release` runs or resumes today.**
It belongs in 0a, before any Deploy button exists.

The fix, all through shared code, never a new direct spawn:

- **One hardened Git runner** for the adapters, built on the existing pieces:
  - `HARDENED_GIT_ARGS` (`core.hooksPath=/dev/null`, `core.fsmonitor=false`, `--no-optional-locks`), plus
    `--no-replace-objects`, `-c protocol.allow=never` with `-c protocol.https.allow=always` (and `ssh` only when the
    recorded remote is ssh), `-c core.sshCommand=` pinned to the absolute system `ssh`, `-c credential.helper=`, and
    `-c include.path=`;
  - `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=/dev/null`;
  - `teardown-git.ts commandSetting`, which already refuses project config that names a command or includes a file:
    any such setting stops the release with its name.
- **Trusted identity**:
  - the repository's Git directory and its GitHub `owner/name` come from Toolroll's records (`repos add --remote`,
    the trusted remote), never from the checkout's `origin`;
  - fetches name that recorded URL explicitly;
  - the checkout is resolved with `realpath` and must be one of the project's recorded checkouts.
- **An allowlisted environment** (`PATH` set to fixed system folders, `HOME`, `LANG`, and gh/npm's own config
  locations) and **absolute executables** (`/usr/bin/git` or the recorded Git, the installed `gh`, the installed
  runtime's `node`), resolved once at start, never by `PATH` lookup.
- `gh` calls name the recorded `owner/name` (`--repo`) and never read the checkout's Git config.
- **Attack test** (`test/attacks/release-git-config.test.ts`): a gate checkout with each of `include.path`,
  `core.sshCommand`, `core.fsmonitor`, `core.hooksPath`, a `remote.origin.url` with `ext::`, a `remote.<name>.vcs`
  helper and a `credential.helper`, all pointing at a marker script. Run release preflight (`begin`) and resume; the
  marker never runs and the release stops naming the setting.

#### 0a.5 The hardened release card

**What counts as a deploy gate.** A scope with a `candidate` or `release_terms_json`, read by one helper,
`deployGateScope(scope)`. Both are signed terms in the scope digest, written at filing, before any
`release_authority` row exists. That covers the first approval and fallback gates filed without `--release`
(`release-adapters.ts fileGate`).

**The complete terms renderer comes into 0a** (from the phone plan's phase 2): `approvalTermsOf(scope)`, one
function, with a chat-text presentation now and HTML later. Before Approve, the card shows every signed term:

- **The scope's terms**: title, project, who filed it; goal, exclusions, paths it may touch, acceptance criteria;
  agents, model and profile words; checks level; check access; budget.
- **Every field of `release_terms_json`** (`contracts/release-terms.ts`):
  - repository, package version, branch, pull request, base;
  - approved commit and tree;
  - carry on or off, protected paths (or "the whole project"), and the carry limits (lines, files, churn);
  - the release check grant (id and digest), check access (`sandboxed`), and the expiry.
- **Short form, then the rest.** The card shows the common terms in a few lines. The full list is sent with it as a
  file (`release-0.9.73-terms.txt`) before Continue is offered.
- **A contract test** builds a scope with every field set, renders it, and requires each field's value in the output.
  A field added to the scope or the release terms later and missing from the renderer fails it. A test with each field
  omitted in turn checks the renderer says "none" rather than dropping the line.

**What changed since the last release, from a recorded baseline, not a tag.**

- **The baseline** is the plane's own record: the newest `release_authority` for the repo in state `merged` whose
  `merge` operation `succeeded`. Its `external_ref` is the merge commit, recorded from GitHub's answer after
  `release.ts` verified the merged tree.
- **The list** is the commits from that commit to the candidate, read with the hardened runner from the recorded Git
  directory, objects only, never a ref.
- **No recorded baseline** (the first release under release-once) → the card says "No earlier verified release is
  recorded" and shows the pull request's own commit list from GitHub for the recorded `owner/name`.
- **Tags are never read**, so moving a local tag changes nothing. Test: a tag moved to the candidate; the list is
  unchanged.
- **The baseline commit and the list's digest are bound into the card.** `cardDigest = H(scope digest, form digest,
  baseline, change-list digest)`, and Approve's token carries it. A different baseline at the tap refuses.

**Then Continue → Approve.**

- Continue re-renders the terms and the list against the live records.
- Approve is a decide token bound to `cardDigest`. Anything changed since refuses: "This release changed while you
  were reading", with the new card.

**Only from the person's private linked chat.** The token is bound to binding, chat and message (today's decide
rules). A group, a forwarded card or another member does nothing.

**Every other `planInChat` rule still applies**: the person's Approve from chat setting and limits for that project,
no coordinator- or lead-written text, organisation policy. Nightly checks are never approved or merged from chat
(`nightlyTaskRef`, recorded with `nightly_check` at filing).

**The seal knows which card it came from.**

- `sealScopeApproval` with basis `chat` on a `deployGateScope` requires the release-card evidence: the act
  `release-approve` and its `cardDigest`, in the same transaction.
- A chat seal of a deploy gate through any other road (the ordinary plan card, `offer_approval`'s generic card)
  refuses.
- The proof row stays outcome `chat`, with detail `{"v":1,…,"card":"release","cardDigest":…}`.

**Notices.** Every release approval from chat is announced in the person's other linked chats and by push, naming the
chat it came from.

#### 0a tests

- **The release card:**
  - a fresh fallback gate and a `--release` gate **with no authority row**: the plain plan card refuses and points to
    the release card; Continue → Approve seals it, basis `chat`, and opens the authority;
  - a scope change, a new baseline or a changed change list between Continue and Approve → refused;
  - a moved tag → the same list;
  - a tap from a group, another member or a forwarded card → nothing;
  - a nightly task → refused;
  - `ownerApproval` and `deploymentCandidate` accept the resulting seal;
  - the renderer contract test.
- **Release Git**: the attack test above.
- **Protected storage and environment**: the attack tests in §1.1, under both policies.
- **The three widening actions** refuse without a password.
- **The closed-list static test** includes the four settings.

### 0b. Deploy from chat (after 0a)

Today a release runs only as `toolroll release <branch>` in a terminal (`release-cli.ts`, `runRelease`). The same
command resumes after a stop: it holds the release's lease and epoch, and recovers a deployment's saved stage first.
Chat gains one operation, **Deploy**, that starts or resumes that run.

**Prerequisite:** 0a.2, the release Git hardening.

**What it maps to.** A new operator-only console operation, `release.run`, called by chat and the console alike. It
takes **no arguments**: the release is the approved one on the card.

**The process lives outside the service it replaces (finding 7, round 2).** The swap boots out the worker's service
and proves every old process is gone (`deploy-phases.mjs swap`: `launchctl bootout`, then `verifyServiceStopped`). A
child of the worker would die there. So:

- **macOS**: the worker bootstraps a **separate launchd job** for the run, label `com.toolroll.release.<job id>` in the
  person's `gui/<uid>` domain. Its program is the installed runtime's absolute `node` and CLI script, real paths pinned
  at start (a versioned runtime folder, unaffected by the relink). It has `RunAtLoad`, no `KeepAlive`, its own log
  file, and the allowlisted environment above. **Linux**: `systemd-run --user --unit toolroll-release-<job id>
  --collect` with the same program and environment.
  - It is never a child of the service, so `bootout` and `verifyServiceStopped` don't touch it. The test makes sure
    `verifyServiceStopped`'s pid list never includes it.
- **Durable identity**: a `release_job` row: job id, release authority, label or unit, pid and process start time
  (the same proof `release_operation.issuer_pid` / `issuer_started` uses), the runtime path, requested by, the chat
  binding, started, finished, outcome.
- **Restart reconciliation.** On every worker start and each tick, for each unfinished `release_job`:
  - the label or unit is still loaded and the pid has the same start time → still running;
  - otherwise the job is `lost`; the release's own journal and `release_operation` rows say where it stopped, and the
    card offers **Resume**. The coordinator's recovery settles a started operation only once its issuer is proven
    gone, as today.
- **Completion is durable, delivery is retried.** The coordinator writes its outcome to the journal and `release_job`
  before it exits. The chat and push notices are made from those rows by the worker's outbox, so a notice lost across
  the swap is sent when the new worker starts.
- **One at a time.** The coordinator's lease (`rel.renew`, `rel.start` epochs) stays the authority. `release.run` also
  refuses while a `release_job` for that release is running ("Already deploying"), inside one transaction with the
  insert.

**What it needs.** A release whose gate approval is a person's (`ownerApproval`: `password` or `chat` today), and
whose full check passed on the exact commit. Deploy grants nothing new: the run re-proves all of it at every phase, as
it does from the terminal.

**Who.** An instance operator, through the route-table admission (§3), from the person's private linked chat.

**The card.** On the release's card once approved and checked: **Deploy** → Continue (version, commit, "This deploys
to this computer's Toolroll and merges the pull request") → **Deploy now**. Progress comes back as stage lines (drain,
backup, swap, merge, tag, publish). A stop says why, with **Resume**.

**Class.** `tap` until the authenticator ships, then `code-everyday` (phase 3).

**`release` command variants (reconciled with §5)**: `release.run` is the no-argument start or resume.

- `--new`, `--limit`, and `--release-gate --yes` (lifting an update pause) are `ui-only`: CLI recovery and override
  tools.
- `release revoke` is the same operation as the console's stop carrying (`tap`, lowering).
- `release carry` by hand, `release nightly` and `release ask-every-commit` are `code-everything`, reachable in chat
  only at Everything with the code (phase 3). Carrying under release-once keeps working automatically.

**0b tests**, against the real service boundary:

- Deploy on an unapproved, a lead-approved and a check-failed release → refused.
- Deploy twice → one run.
- Deploy by a non-operator → refused.
- **The swap boundary**: a fixture service bootstrapped like the real one, a release job started, the swap's
  `bootout` and `verifyServiceStopped` run → the job survives and finishes.
- **Lost completion**: the worker is killed after the job writes its outcome and before the notice goes → the notice
  is sent on restart, exactly once.
- **Lost job**: the job is killed mid-deploy → the row reads `lost`, Resume continues from the saved stage.
- The job runs the installed runtime's script, never the candidate's (extend
  `test/attacks/deploy-candidate-approval.test.ts`).

### Phase 3 change (unchanged timing)

From phase 3, a deploy gate's approval from chat and Deploy both require the code. The release card's Approve and
**Deploy now** open the keypad or modal (§4), and `ownerApproval` and `deploymentCandidate` accept basis `chat` only
with proof `chat-code`. Recommendation (decision 3): ship phase 3's release part together with phase 2, so the window
is one release long.

## 1. Who is acting: a linked account is not a person (finding 1)

### What can act as the linked account without the person

- **Telegram user clients.** Telegram's user API lets any logged-in client press a bot's buttons
  (`messages.getBotCallbackAnswer`) and send messages. Anything holding the person's Telegram session can do both, and
  the immutable `from.id` check passes:
  - Telegram Desktop's `tdata`;
  - a library session string (Telethon, TDLib);
  - a logged-in device.
- **Slack user tokens.** A user token writes as the user, so it can send DMs and commands. Two sources:
  - Slack desktop's `xoxc` token and `d` cookie, kept in its app data folder; the cookie key is in the Keychain.
  - An OAuth `xoxp` token from any app the person installed.
- **Provider-side history.** Whoever holds those credentials reads the DM: every card, file and diff we send, and any
  code the person ever typed as a message.
- **Account takeover**: a Slack admin or SSO reset, or a Telegram SIM swap, gives the same power. Export access alone
  only reads.

### What Toolroll enforces

#### 1. Protected storage: a mandatory deny for every launch (phase 0a)

**Today's list doesn't reach version-2 fences.** `HOME_CONFIGURATION` is read only by the version-1 boundary:
`taskBoundary` returns through `v2Boundary` first (`agent-fence.ts`, policy 2), which denies nothing in home, and
`test/attacks/fence-home-reads.test.ts` expects version 2 to read home credentials. So the new denies are **not** added
to that list.

- **A new list, `PROTECTED_STORAGE`** (`src/protected-storage.ts`), is applied by one function,
  `protectedStorageDenies(home, env)`. It is called by **every** boundary builder:
  - `taskBoundary` and `v2Boundary`;
  - the launches through `fenceFor` / `sandboxedSpawn`: builds, repairs, planners and reviews (`invoke.ts`), checks
    (`exec.ts`, batch checks), flow code (`flow-code.ts`), project tool servers (`project-tools.ts`), coding sessions
    (`coding-provider.ts`), release-carry verification (`release-carry.ts`) and egress probes (`egress.ts`).
- **Under both policies and on every backend**: Seatbelt, the sandbox runtime, bubblewrap, Codex permission profiles,
  and Claude's file-tool deny rules.
- **Whatever the project's read settings.** A project sandbox setting can add denies, never remove these. A grant
  equal to or inside a protected path is dropped, as `flattened()` already does for denies.
- **Read and write denied, by name, present or not.** A build can't create the folder now and swap in a link later.
- **Not covered: Live terminals.** They are the operator's own shell and are unfenced by design. An agent started in a
  Live terminal is outside this isolation, and §1's "can't enforce" list names it.

**Supported storage.** The paths below are relative to home unless absolute.

| App | macOS | Linux |
| --- | --- | --- |
| Slack | `Library/Application Support/Slack`; App Store: `Library/Containers/com.tinyspeck.slackmacgap` | `.config/Slack`; Snap: `snap/slack`; Flatpak: `.var/app/com.slack.Slack` |
| Telegram | Desktop: `Library/Application Support/Telegram Desktop`; App Store Desktop: `Library/Containers/org.telegram.desktop`; Telegram for macOS: `Library/Group Containers/6N38VWS5BX.ru.keepcoder.Telegram`, `Library/Containers/ru.keepcoder.Telegram` | `.local/share/TelegramDesktop`; Snap: `snap/telegram-desktop`; Flatpak: `.var/app/org.telegram.desktop` |
| Discord | `Library/Application Support/discord`, `discordptb`, `discordcanary` | `.config/discord`; Snap: `snap/discord`; Flatpak: `.var/app/com.discordapp.Discord` |
| Teams | new: `Library/Containers/com.microsoft.teams2`, `Library/Group Containers/UBF8T346G9.com.microsoft.teams`; classic: `Library/Application Support/Microsoft/Teams` | classic: `.config/Microsoft/Microsoft Teams` (web Teams lives in a browser profile) |
| 1Password | 8: `Library/Group Containers/2BUA8C4S2C.com.1password`, `Library/Containers/com.1password.1password`; 7: `Library/Group Containers/2BUA8C4S2C.com.agilebits`, `Library/Application Support/1Password`; CLI: `.config/op`, `.op` | desktop: `.config/1Password`; Snap: `snap/1password`; Flatpak: `.var/app/com.onepassword.OnePassword`; CLI: `.config/op`, `.op` |
| Bitwarden | desktop: `Library/Application Support/Bitwarden`; App Store: `Library/Containers/com.bitwarden.desktop`; CLI: `Library/Application Support/Bitwarden CLI` | desktop: `.config/Bitwarden`; Snap: `snap/bitwarden`; Flatpak: `.var/app/com.bitwarden.desktop`; CLI: `.config/Bitwarden CLI` |
| Bitwarden and 1Password browser extensions | inside the browser profiles below | inside the browser profiles below |
| Chrome | `Library/Application Support/Google/Chrome`, `… Chrome Beta`, `… Chrome Canary` | `.config/google-chrome`, `-beta`, `-unstable`; Flatpak: `.var/app/com.google.Chrome` |
| Chromium | `Library/Application Support/Chromium` | `.config/chromium`; Snap: `snap/chromium`; Flatpak: `.var/app/org.chromium.Chromium` |
| Brave | `Library/Application Support/BraveSoftware` | `.config/BraveSoftware`; Snap: `snap/brave`; Flatpak: `.var/app/com.brave.Browser` |
| Edge | `Library/Application Support/Microsoft Edge` | `.config/microsoft-edge`; Flatpak: `.var/app/com.microsoft.Edge` |
| Arc | `Library/Application Support/Arc` | — |
| Firefox | `Library/Application Support/Firefox` | `.mozilla/firefox`; Snap: `snap/firefox`; Flatpak: `.var/app/org.mozilla.firefox` |
| Safari and WebKit | `Library/Safari`, `Library/Containers/com.apple.Safari`, `Library/Cookies`, `Library/HTTPStorages`, `Library/WebKit` | — |

**Configured overrides, where Toolroll can know them** (read by the plane at each launch, never from a checkout):

- Linux `XDG_CONFIG_HOME` and `XDG_DATA_HOME`, from the plane's own environment: each `.config` and `.local/share`
  row is also denied under the configured root.
- `BITWARDENCLI_APPDATA_DIR` and `OP_CONFIG_DIR`, if set in the plane's environment.
- Firefox's `profiles.ini`: profiles at absolute paths outside the default root are denied by those paths.
- A Chromium `--user-data-dir` chosen at the browser's own launch, or any other custom location, is **not knowable**.
  Settings and SECURITY.md say isolation covers the listed storage only.

**Links.** Each root is denied by its name and its real path (the existing rule). Two additions:

- **Nested outward links.** At each launch, the plane walks each present root without following links, bounded to
  depth 4 and 5,000 entries. It adds the real path of every symlink target outside the root. A root over the bound
  is logged ("not fully walked"), and isolation isn't claimed past it.
- **Launch-time changes.** Roots are resolved at every launch, never cached. A link changed after launch is outside
  the walk; the person's own apps are the only writers there, since the build is denied writes.

**Tests** (`test/attacks/fence-protected-storage.test.ts`), each case under policy 1 **and** policy 2 and on every
backend available on the runner (Seatbelt, the sandbox runtime, bubblewrap, the Codex sandbox):

- a read of each listed root that exists in the fixture home;
- a link from the checkout into a protected root (an alias);
- a protected root that is itself a link to a relocated folder;
- a link inside a protected root pointing outward (nested);
- a root created after the plane's first launch;
- an `XDG_CONFIG_HOME` override;
- a project read setting that tries to grant a protected path.

Every case must fail to read.

#### 2. Builds get no chat or vault credentials by environment

The setup and agent env allowlists (`builder.ts SETUP_ENV_ALLOWLIST`) already drop unknown variables. An attack test
pins that `SLACK_*`, `TELEGRAM_*`, `DISCORD_*`, `TEAMS_*`, `OP_*` and `BW_*` never reach any launch kind above.

#### 3. The console's chat lead has no shell or files

It runs with Toolroll's tools only. A test pins that `LEAD_TOOL_SCHEMAS` has no tool that reads arbitrary files or
runs commands.

#### 4. The Keychain, said plainly

Build agents keep Keychain access: Claude Code signs in from it (`sandbox-runtime.ts SEATBELT_NO_KEYCHAIN` applies to
every launch except a build agent's).

- **macOS Chrome-family browsers** encrypt cookies with a "Safe Storage" key kept in the Keychain. So the **profile
  deny is the protection** for web-chat sessions, not the encryption.
- **Linux Chromium** keeps that key in the Secret Service or, without one, a fixed key: effectively plaintext.
- **Safari's and Firefox's cookies** aren't encrypted at rest.

A build that could read a profile could take the web Slack, Telegram Web or Teams session.

### What Toolroll can't enforce, said plainly

- **An agent running outside the fence as the same OS user** can read the Slack desktop data and drive the client.
  That includes an assistant in the person's own terminal, and Toolroll's own CLI lead, which runs there with a lead
  token. This is the same limit as the remembered login (approval-policy "Remaining limits").
- **Agents in a Live terminal**: the operator's shell is unfenced by design.
- **Storage Toolroll doesn't know about**: a browser started with a custom `--user-data-dir`, a portable app, an
  unlisted password manager or authenticator. Isolation covers the listed storage (§1.1) only, and Settings says so.
- **The Keychain for build agents** (§1.1, item 4), so the profile denies carry the weight.
- **Telegram and Slack sessions on other devices and servers**, and **provider-side DM history**.

### So, per level

A tap from the linked account proves only "someone with this chat account". Recommendation:

| Act | Off | Everyday | Everything |
| --- | --- | --- | --- |
| Reads (status, task pages, diffs, files) | as today | tap | tap |
| `act` rows: no password in the console (steer, retry, hold, request changes, note, run checks …) | as today | tap | tap |
| `step-up` rows: a password or session step-up in the console (approve, merge, accept with a second person, resume …) | as today | **code** | **code** |
| **Release approval and Deploy** (Alex's decision) | tap through the hardened release card (§0), until phase 3 | same | same |
| … from phase 3 | **code** | **code** | **code** |
| Credential acts (the passwordless closed list), raising the lead's power | console | console | **code** |
| UI-only operations (§5) | console | console | console |

- **The code is the independent person ceremony.** The authenticator lives on a device the agent can't reach: the
  phone's authenticator app, or a password manager whose data folder is fenced and which locks on its own. If the
  person keeps it in an unlocked manager that an unfenced agent can drive, the code proves nothing more than the tap;
  setup says so.
- **Off** keeps today's tap-only Approve from chat, for compatibility. Recommendation (decision 3): once a person
  enrols an authenticator, their Approve from chat asks for the code too. The tap-only road is retired in the
  following release, with a notice.
- **Everyday therefore needs an enrolled authenticator for approvals and merges.** Without one, those cards keep
  **Open in Toolroll**.
- **Releases are the stated exception until phase 3.** The release card and Deploy work by tap, because Alex chose to
  keep chat able to approve and deploy. Until then, anyone holding the person's chat session can approve and deploy
  a release (§6). The fence (phase 0a) narrows who that can be; it doesn't close it.

## 2. The setting

### Levels and where they live

- **Per instance**: Settings → Chat → **Manage from chat** (Off / Everyday work / Everything), and
  `toolroll chat manage <off|everyday|everything>` with a password typed at the terminal.
  - One append-only ledger, like `passwordless.ts`: action `chat management changed`, outcome, actor, `before → after`.
  - Reader `chatManageLevel(store)`; missing or unreadable reads as `off`.
- **Per project: lower only.** Settings → Approval rules gets "Manage from chat here: As the instance / Everyday only /
  Off". `chatManageLevelFor(store, repo)` = min(instance, project).
- **Per person**: their linked chat, their authenticator, and their Approve from chat limits. Nobody else's chat
  gains anything.
- **Raising** is a credential act by an instance operator (`proveCredential`: a password typed now or `sso-now`),
  never from a session, token, lead or chat. It joins the closed list in `passwordless.md`. Raising to Everything also
  requires the operator's own enrolled authenticator.
- **Lowering** is one step from anywhere, chat included (`/manage off`), with no code. In the same transaction it
  cancels open code ceremonies. Buttons minted under the higher level re-check it at the tap.

### Approvals keep every existing rule (finding 5)

Every approval from chat, at every level, goes through `approve()` itself, the console's own road, with method
`chat-code`. Every one of these rules applies:

- `planInChat` eligibility, unchanged:
  - no coordinator, scout or **mate** text (`quarantinedAuthor`);
  - a resolved route;
  - no protected work, which needs two people in the console;
  - organisation policy;
  - a verified plan and revision notes;
  - and, for a deploy gate, only through the hardened release card (§0).
- The person's **Approve from chat** setting for that project, with its limits (full access, attempt cap). No level
  and no code lifts the limits in v1 (decision 6).
- `approve()`'s own rules: the requester rule, the approval gate, standing and project access.

Consequences, stated rather than papered over:

- **Sweeps stay in the console.** `sweep_file` files children with `proposedVia: "mate"` (`chat-actions.ts
  fileSweepChild`) and approves each through the password road (`fileSweep`). Mate text is quarantined from chat, so
  a sweep card at any level keeps its secure-screen link. A stronger ceremony for lead-written text is future work;
  it would need per-child terms shown before the code and the separation-of-duties rules kept.
- **The secure screen stays** for `scope_approve` and `sweep_file`. In chat, `scope_approve` becomes possible only
  where `planInChat` allows it, through the code ceremony. No tap or two-tap stands in for the password screen.
- `task_resume` (a password in the console) → code. `task_cancel` (protected, no password) → two taps at Everyday.
  `tool_add` and `skill_import` → see §5.

## 3. Reaching every action, through existing definitions (findings 4 and 6, and the simplification)

No new universal registry. The existing definitions gain what chat needs, and coverage is derived from them.

### The route table gains a `chat` column, per operation

- `RouteDeclaration` gains `chat: ChatClass | { by: string; ops: Record<string, ChatClass> }`.
  - `ChatClass` = `"tap" | "code-everyday" | "code-everything" | "ui-only"` plus a `reason`, required for `ui-only`.
  - `by` names the form field that picks the operation, for example `action` on `/settings/sessions`
    (`end-*`, `create-token`, `revoke-token`) or the monitoring fields.
  - **Every operation discriminant is classified, never a whole route.** A handler that meets a value not in `ops`
    refuses chat.
- **The default comes from the row, once the row tells the truth**:
  - `scope: "act"` → `tap`;
  - `scope: "step-up"` → `code-everyday`;
  - credential acts (the passwordless closed list, already enumerated by its static test) → `code-everything`.
  - Phase 1 first fixes the rows whose scope disagrees with what the handler proves (§5).
  - A row may only tighten its default, never loosen it. The one exception is an operation that only lowers, which
    may be `tap`.
- **CLI-only user commands** gain the same field in `OPERATE_COMMANDS` (`src/cli.ts`).

### Chat is a caller, admitted like any other

- `Caller` gains `"chat"`. A chat act becomes `{ route, operation, form, resource }` and goes through **the same
  admission** as an HTTP request: caller, scope, project resolver, limited access, and role.
  - The role comes from the bound account's **current** role and instance-wide access, so `operator` rows refuse a
    project approver with any proof.
  - The project comes from the resource the act names: the task's, flow's or project's repo.
- Admission becomes a function both the HTTP pipeline and chat call: `admitOperation(row, principal, resource)`.
- Checks that today live in a handler rather than the row move into the shared operation function the handler calls,
  so chat can't skip them. Examples: `approvalSave` relies on the row's operator admission; `monitoringSave` refuses
  without `configDir`. Phase 1 lists each such check, and a test runs chat and HTTP through the same function.
- **Existing chat definitions point at routes.** Each `chat-actions.ts CHAT_ACTIONS` entry and each decide act
  (`chat-decide.ts DECIDE_ACTS`) gains `route` (and `operation`). Chat performs the act only through that route's
  admission and operation function. `chat-controls.ts CHAT_CONTROLS` stays the list of console links for `ui-only`
  operations.
- **Coverage is derived.** A test walks every POST row and operation, and every user CLI command, and requires a
  `chat` class. For every non-`ui-only` class it requires at least one chat entry (a `CHAT_ACTIONS` or decide act, a
  lead `propose_*` tool, or a command) that names it. The audit numbers in §5 are this test's output, regenerated by
  `scripts/chat-coverage.mjs`, not hand counts.

### The proof is bound to the exact operation, checked at runtime

- A code ceremony (§4) mints a **`ChatCodeProof`** inside the acting transaction:
  `{ ceremony, account, generation, binding, route, operation, termsDigest, step }`.
- The operation function receives it and re-derives `route`, `operation` and `termsDigest` from its own inputs. Any
  mismatch refuses. Then the ceremony is consumed, in the same transaction.
- The proof is never stored as a credential, never returned, never reusable. A `chat-code` proof for one operation
  can't authorise another (runtime test, not only a static call-site test).
- `credentialProof` stays `password-now | sso-now`. A credential-act operation accepts `chat-code` only when its
  class is `code-everything`, the level is Everything for that project, and the proof names that operation and terms.
  One function does this, `chatCredentialProof(row, op, proof, level)`, called inside the operation.

### Ways in

- **Short commands** (`/tasks`, `/task 412`, `/approve 412`, `/merge 412`, `/diff 412`, `/release 0.9.73`,
  `/manage off`) are parsed deterministically.
- **Plain language** goes to the lead, whose existing `propose_*` tools and `propose_action` gain the missing
  operations.
- **Either way the result is a card.** Its text is rendered by Toolroll from stored terms (the shared terms renderer,
  §7), never written by the lead. Its buttons are decide tokens.
- **Commands don't act directly.** `/approve 412` renders the terms and a **Continue** button, exactly like a lead
  proposal.
- **Reads come back as messages or files.** Past the channel limit they arrive as a file (`task-412.md`,
  `task-412.diff`), private chat only, through the existing redaction.

## 4. The authenticator code

### TOTP

RFC 6238: HMAC-SHA1, 6 digits, 30-second steps, which every authenticator app reads from an `otpauth://totp/` URI.
Codes are computed with `node:crypto`; no new dependency.

### Enrolment

A credential act, never in chat.

- **Console:** Settings → Chat → **Set up authenticator**. The password goes in the form. Toolroll shows a QR code and
  the secret, then asks for one code to confirm.
- **CLI:** `toolroll chat authenticator setup`. The password is typed at the terminal; the remembered login is
  refused. The QR code prints in the terminal, followed by a confirming code.
- **The enrolment ceremony**: in memory, one use, 10 minutes, bound to account, generation and (console) session.
  Confirming and inserting happen in one transaction that rechecks all of them.
- Re-enrolling replaces the old secret only after the new one's confirming code checks.
- Setup recommends an authenticator on the phone, not in a password manager this computer's agents could drive (§1).

### Storage

- **The secret**: 20 random bytes, stored through `tool-secret-store.ts` as item `{ service:
  "toolroll-authenticator", account: sha256(instance id + account) }`.
  - It goes to the Keychain or Secret Service, sealed with the fenced key; owner-only files where there's neither.
  - It never goes in the database, logs, the ledger, exports or backups. A restore needs re-enrolment, and the
    restore summary says so.
- **Table `chat_authenticator`**: account, generation, state, an HMAC fingerprint of the secret (to detect a swapped
  item), `last_step`, and the failure counters.
- A missing, unreadable or swapped secret fails closed.

### Checking a code

`checkChatCode` runs inside the acting transaction:

- the row is active, on the account's current generation, and not locked;
- the code is exactly six digits;
- steps `t-1 … t+1` are compared in constant time;
- **the accepted step must be greater than `last_step`**, written with a compare-and-set.

So each code works once, an older in-window code can't follow a newer one, and two racing ceremonies can't share a
code.

### Rate limiting, lockout, recovery

- **Lockout:**
  - 5 wrong codes in 15 minutes per account → codes lock for 15 minutes;
  - 10 wrong since the last success → locked until a reset with a typed password, in the console or CLI;
  - each lock is announced in every linked chat and by push.
  - Taps and the console are never locked.
- **Recovery** is the typed password in the console or CLI: **Reset authenticator**, then enrol again. There are no
  recovery codes in v1.
- **Retirement:** a password change or reset (a generation bump) and account revocation retire the authenticator.

### The code ceremony (findings 2 and 3)

```
chat_code_ceremony: id, channel, binding, chat, account, generation, route, operation, terms_digest,
                    card_message, opened_at, expires_at (5 min), entry (pad state), consumed_at, outcome
```

**Opened only by the person's Continue tap** on a card in their private chat. A command renders the card first; the
lead can propose the card but can't tap. There is one open ceremony per binding: a new Continue closes the old one,
and its card is edited to "Replaced. Nothing was done."

**The code never travels as an ordinary message.**

- **Telegram: a keypad on the ceremony card.** The card's inline keyboard holds the digits 0–9, ⌫ and **Confirm**.
  - Each key's `callback_data` is an opaque token minted for this ceremony and this card, with a random digit-to-token
    mapping per ceremony, stored server-side.
  - The tap is checked like every decide tap: the tapper's live binding, the card's chat and message id, and the
    ceremony still current. A tap on a replaced card, another card or another chat does nothing.
  - The card shows ● for each digit entered. **Confirm** runs the check. Digits live in the ceremony row only until
    Confirm or expiry, then are wiped.
  - Nothing a person types reaches the chat history. The lead never sees keypad taps, and the stored form of a tap
    is the projection below, never the card's keyboard.
- **Slack: a modal.** **Continue** opens a modal (`views.open` with the action's `trigger_id`): a single 6-digit
  input. `private_metadata` is the ceremony id, MAC'd with an instance key.
  - The `view_submission` arrives through Socket Mode, and `receiveSlack` handles it **before** building any queued
    event (`slack-chat.ts`, ahead of the `event.text` payload at line 121).
  - The modal user must be the binding's member and the metadata must name the open ceremony. The value is checked,
    then dropped. It never enters `chat_event`, the lead or a log.
  - Modal input isn't part of channel history.
- **Binding:** the ceremony id travels with the input (keypad tokens, modal metadata), and the ceremony is current,
  unexpired, opened before the input, and on the same binding, chat and card. A code entered for card A can't
  approve B: A was closed when B opened, and A's keypad tokens and modal id die with it.
- **Terms at use:** the live terms must still hash to `terms_digest`. If not: "This changed while you were reading",
  and the new card is shown.

**What is stored for a credential event (finding 3, round 2).**

- **Telegram's raw envelope can reconstruct a code.** A `callback_query` carries the card's `message`, including its
  `reply_markup`: every key's label and token. Stored next to the taps, that rebuilds the code.
- **So from phase 2, nothing stores a raw Telegram envelope.** `keepPushedUpdate` and the `getUpdates` path parse each
  update and persist only a **validated projection**, never `JSON.stringify(raw)`:
  - **callback query**: `{update_id, callback_id, from_id, chat_id, message_id, data}`. No `message` body, no
    `reply_markup`, no nested messages.
  - **ordinary message**: `{update_id, message_id, from_id, chat_id, chat_type, date, text (scrubbed below),
    reply_to_message_id, forwarded, via_bot, sender_chat, has_caption, edited}`. The flags the existing filters read
    are kept as booleans. No nested `reply_to_message` or `quote` bodies, and no `reply_markup`.
  - Anything else is reduced to `{update_id, kind}` and ignored, as today.
- **Slack**: `view_submission` for a ceremony is handled before `receiveSlack` builds any `chat_event`, and only
  `{ceremony, member, ok}` is kept. Ordinary messages are scrubbed before the payload is built (line 121).

**A code typed as a message is never used and never kept.**

- **Where the scrub runs.** At initial ingress, before persistence, one function, `scrubCodeLike(text)`, finds **any**
  run of six digits, allowing separators (`123456`, `123 456`, `code: 123-456`, `#123456`), in a message from a
  linked account with an enrolled authenticator. **There is no exemption** (finding 6, round 2).
- **What happens to that message:**
  - it is persisted only with the digits replaced by `[number removed]`;
  - it is **not sent to the lead**, not even redacted;
  - the person gets a reply: "That looked like a code, so it wasn't used or passed on. Codes go in the keypad. For an
    issue or pull request, use its link or /task."
  - Telegram deletes the message (`deleteMessage` in a private chat). Slack can't delete a user's DM with a bot token.
- **The window burn**: in the same transaction as the persistence,
  `UPDATE chat_authenticator SET last_step = MAX(last_step, :step + 1) WHERE account = ?`. It is atomic and only ever
  moves forward.
- **What the burn does and doesn't do.** It protects **after ingress**: once Toolroll has seen the message, nobody who
  reads it later (stored history, a user-token holder reading the DM) can use the code.
  - It does **not** stop a provider-side race. Someone holding the person's chat session can read the message and tap
    the keypad with it before Toolroll's ingress sees the message.
  - That race exists only when the person types a code where they shouldn't. The keypad and modal never put a code
    in history.
- **No ceremony "replies".** No message is ever a ceremony answer, so there are no malformed ceremony replies to keep
  from the lead.

### The proof

- `chat-code` is added to `person-proof.ts OTHER_PERSON_PROOFS`.
- `approval-authority.ts` renders its `PERSON_PROOFS` SQL list from the same exported constant, with an agreement
  test.
- A chat approval seals basis `chat` with an `approval proved` row, outcome `chat-code`, detail
  `{"v":1,"at","generation","digest","channel","binding","ceremony","route","operation","step"}`. The existing
  readers already parse `v:1`.
- Release and deploy gates accept a plain `chat` proof from the release card until phase 3, then basis `chat` only
  with `chat-code`.
- Protected work still needs two different people.

## 5. Coverage audit (per operation)

### Inventory

The inventory comes from the code on `release-0.9.72`, read handler by handler.

- **Console.** `src/server/route-table.ts` has 250 POST rows. Of those, 231 are console rows (loops expanded); the
  other 19 (5 demo, 14 edge/protocol) are left out. The 231 rows split into **314 operations** by their form
  discriminants.
  - 8 operations only preview: they mint a nonce or show terms and save nothing. Chat renders its own card instead,
    so they aren't classified.
  - 3 rows have no operation (404 or 410).
  - That leaves **306 acting operations**.
- **CLI.** **46 user commands** exist only in the CLI. Scheduler and worker plumbing is left out.
- **Total: 352 operations.**
- **Phase 1 makes these numbers a test.** `scripts/chat-coverage.mjs` regenerates them from the `chat` column, and the
  coverage test fails on any operation without a class.

**Classes**, with the rule that assigns each one:

- **tap**: the console takes no password, or the operation only lowers (removes, narrows, turns off, revokes).
- **code-everyday**: the handler proves a password or session step-up on work (approve, merge, resume, reopen …).
- **code-everything**: credential acts, security and instance settings (approval rules, policy, budgets, check
  levels, project network, writes, sandbox and check access, modes, updates, retention and storage), release
  configuration (nightly, carry, ask-every-commit), and acts that widen authority even where the console takes no
  password today.
- Release approval and **Deploy** (`release.run`, mapping to `toolroll release`) are `code-everyday`, by Alex's
  decision. They work by tap through the release card until phase 3.

**Effective classes depend on validated arguments and current state where the operation does.**

- A row's `chat` entry may be a pure function, `(operation, validatedArgs, state) => ChatClass`, declared beside the
  row. It may only return its default or something stricter.
- It is evaluated at admission, on the arguments after the handler's own validation, and on the state read in the
  acting transaction. The same function decides the card (tap, Continue, keypad) and the admission.
- Cases:
  - **complete / accept**: `tap`, but `code-everyday` when the completion would be the second person on protected
    work (approval-policy 1.7a) or completes a deploy-gate candidate;
  - **approve**: `code-everyday`, and for a `deployGateScope` the release card (tap until phase 3);
  - **sessions**: ending your own session or token is `tap`; another person's is operator-admitted `tap`;
  - **check access**: narrowing is `code-everyday`, widening `code-everything`;
  - **permission default**: `auto` is `tap`, full access `code-everything`;
  - **pull requests**: off is `tap`, on and settings `code-everything`;
  - **`release`**: no arguments is `release.run`; `--new`, `--limit` and `--release-gate` are `ui-only`; `carry`,
    `nightly` and `ask-every-commit` are `code-everything`; `revoke` is `tap`;
  - **flow card decide**: send back is `tap`, approve `code-everyday`.
- **Tests check the effective class.** A table of (operation, arguments, state) → expected class runs through chat
  admission, and the card shown must agree. A test that only asks whether a route has an entry isn't enough.
- **ui-only**:
  1. it takes or shows a secret, token, pairing code, invite or capability URL;
  2. it roots chat's own authority (linking, Approve from chat on or raised, a mode with chat approval);
  3. it is browser- or session-bound by nature (cookies, push, the console lead pane);
  4. it acts on this computer's screen or files (Finder, Live terminals, PATH, local installs);
  5. it sends data to a new outside destination (monitoring, backup folder, data export, OAuth and tool connects).

**The class follows what the handler actually proves, not only the route's scope.** The inventory found they
disagree:

- Step-up rows whose handler checks no password: updates seen/cancel, Telegram retry, chat alerts, the coding-session
  sends, SSO test, tool remove/test, live view off, the hooks address, flow secrets, Linear key removal, reject
  revision.
- Act rows that do take one: merge, Passwordless on, triggers with an address, trigger share/renew.

Phase 1 fixes the route rows to match, before the column is derived from them.

### Headline

| Class | Console (306) | CLI-only (46) | Total (352) |
| --- | --- | --- | --- |
| tap | 195 | 16 | **211** (60%) |
| code-everyday | 16 | 5 | **21** (6%) |
| code-everything | 41 | 15 | **56** (16%) |
| ui-only | 54 | 10 | **64** (18%) |

- **Reach by level:** Everyday reaches 232 of 352 operations (66%); Everything reaches 288 (82%). 64 stay in the
  console or CLI.
- **What chat can do today** isn't recounted per operation here. Revision 1's grouped audit found 41 of 147 grouped
  actions; the per-operation figure comes from the coverage script in phase 1.
- **Changed from revision 1**: monitoring (every destination and secret operation, now ui-only), backup folder and
  data export (ui-only), Approve from chat on and a mode with chat approval (ui-only, rule 2), and widening acts with
  no password today (permission default to full access, subagent tool grants: code-everything).
- **Changed in revision 4**: the kit GitHub trigger moves from tap to code-everything; the `release` variants are
  reconciled with §0b; classes depend on arguments and state.

### Console: per domain

**Settings (139 acting operations): tap 70 · code-everyday 4 · code-everything 31 · ui-only 34**

| Class | Operations |
| --- | --- |
| tap | provider resume; update checks on/off, update seen/cancel; skills revise/test/enable/disable/restore; concurrency; live view off; Passwordless off; pull requests off; quick-check command cleared; back up now; integrations test; tool remove/test; starter flow on; models check, watch on/off, role model, inherit; knowledge refresh, proposal accept/reject, decision record/retire, knowledge instructions/save/remove/restore/apply; learning adopt/enable/disable/pause/reset; Slack, Teams and Discord unpair/disconnect/alerts (9); Telegram retry/unpair; Approve from chat off; primary channel; permission default auto; quality default; notifications mode/digest/screenshots, mute/unmute, Telegram digest; provider key clear; email test, read test; Google disconnect; mode revoke; lead identity, about, promise cancel, lead on |
| code-everyday | live view on; check access **narrowed** (a credential act in the console today, so a code, not a tap); control setup approve; agent instructions approve |
| code-everything | skills import (paste, GitHub); budget set/remove; project network, writes, check access widened, sandbox; project delete; policy; approval rules; request limits set/clear; apply an update; retention; storage policy, clean, discard; pull requests on, settings; checks review, batch, level, quick command; tool add from catalog, add custom, import discovered; update an agent CLI; permission default **full access**; auth mode (subscription vs API key); sign a mode **without** chat approval |
| ui-only | update notice dismiss (3); forget remembered password (3); skills folder upload (4); Passwordless on (1, about sign-in); SSO test/save/remove (1); backup settings with a folder (5); data export (5); **monitoring webhook, folder, traces endpoint, header value, rotate** (1, 5); tool connect OAuth, read-only reconnect, connect to another project, local app (4, 5); tool secret (1); appearance accent, theme (3); Slack, Teams, Discord connect and pair (1, 2); Approve from chat save (2); Telegram pair (2); provider key save (1); Telegram bot token (1); email server (1); Google OAuth (1, 5); mode **with** chat approval (2) |

**People (8): tap 4 · code-everything 2 · ui-only 2**

| Class | Operations |
| --- | --- |
| tap | end a session, end others, revoke an API token, cancel an invite (another person's session or token still needs operator admission) |
| code-everything | set an account's projects (can widen to operator); remove an account |
| ui-only | create an API token (1); invite (1) |

**Pages (7 acting): tap 3 · code-everything 2 · ui-only 2**

| Class | Operations |
| --- | --- |
| tap | ledger checkpoint; remove a project from the lists; retire a worker |
| code-everything | open (admit) a local repository path; clone and admit from GitHub |
| ui-only | switch the session's project (3); register a worker (1) |

**Tasks (66 acting): tap 55 · code-everyday 8 · ui-only 3**

| Class | Operations |
| --- | --- |
| tap | coding-session send/stop/resume/recover/continue/ship, answer questions, decline; close/remove a terminal; sweep cancel rest; add a task; queue move/note; answer a decision; hold, unhold, requeue, cancel; edit scope; request plan, edit plan; move up, undo; steer ×3, reply; accept proof; reject revision; route ×3; complete, accept and finish, complete and open a PR (see note); stop carrying a release (lowering); stop; pause ×3; block, unblock; repair dependency ×3; scout follow-up; run note, comment, request changes, revise, draft repair, run checks, add tests; resolve incident |
| code-everyday | start a coding session; accept an extra-access request; **approve**; reopen; accept revision; **merge**; confirm stopped; resume |
| ui-only | start a Live terminal (4); show checkout in Finder (4); editor links for this session (3) |

Note on completion: a tap completes ordinary work. A completion that would be the **second person** on protected work,
or that completes a deploy-gate candidate, needs a code (approval-policy 1.7a's `proof person` mark).

Note on scope edits: a scope edited from a lead card keeps `proposedVia` from the lead (approval-policy 1.4). A chat
edit never resets provenance as if the person typed it.

**Flows (67 acting): tap 51 · code-everyday 2 · code-everything 6 · ui-only 8**

| Class | Operations |
| --- | --- |
| tap | kit setup, sample card; subagent create, soul, state ×3, note, settings, summary, tool revoke, memory edit/forget, routines add/run/remove, undo, week report, answer; gallery create, create, example, import (confirm); save, add card, archive; script remove, script save; Linear key remove; unattended off; trigger without an address; card move, send back, cancel, comment, assign, watch, unwatch, choose; trigger pause/resume/remove/check/press/dropped; unshare; recipes ×5 |
| code-everyday | approve a flow script; card decision **approve** (it can merge through a Pull request zone, approval-policy 1.7) |
| code-everything | **kit GitHub trigger** (admits issues from anyone into the flow); subagent tool grant; subagent per-action rules; unattended on; trigger scope; trigger sender |
| ui-only | Linear key (1); hooks address (1); flow secrets (1); trigger with an address (1); trigger renew, secret, setup (1); share a public form (1) |

**Chat and push (19): tap 12 · code-everyday 2 · ui-only 5**

| Class | Operations |
| --- | --- |
| tap | remove a push device; dismiss the phone card; chat lead off, forget key; stop the live turn; remove a queued message; confirm a lead proposal (each kind then meets its own operation's class) and dismiss; confirm/dismiss a coordinator proposal; message the lead (both roads) |
| code-everyday | file a chat draft as a task (a step-up today); acknowledge unknown spend |
| ui-only | push subscribe (3); chat lead provider and key (1); console lead session mint/follow/end (3) |

### CLI-only (46): tap 16 · code-everyday 5 · code-everything 15 · ui-only 10

| Class | Commands |
| --- | --- |
| tap | `task ask`, `task require`, `task regate`; `lead token --revoke`; `runner capacity`; `coordinator revoke`; `cap add`, `cap scan`; `config clear`; `config unconfined-agents refuse`; `setup clear`; `verify clear`; `revoke` (authority grant); `agents revoke`; `project demo`; `memory propose` |
| code-everyday | `task repair` (approve a repair draft); `config set <phase> --repo`; `publish rearm`; `publish refire`; **`release <branch>`** (start or resume; chat's **Deploy**, `release.run`, §0b; tap until phase 3) |
| code-everything | `task state`; `runner bind`; `cap probe`; `config unconfined-agents allow`; `verify set` (full command); `webhook set console-url`; `publish unblock`; `enroll`; `agents check`; `agents billing`; `repos add --remote`; `release nightly`; `release carry`; `release ask-every-commit`; `update --rollback` |
| ui-only | `lead token` (1); `lead say` (the lead's own command); `approver add` (1); `coordinator mint` (1); `tokens rotate` (1); `skills install`, `link`, `unlink`, `demo`, `onboard` (4) |

### Found while auditing (the first two are fixed in phase 0a; the third in phase 1)

- **Credential acts outside the passwordless closed list.** Project network, writes, check access and sandbox call
  `authenticateCredential` but aren't listed in `passwordless.md`. Add them, so the static list test covers them.
- **Widening with no password.** Permission default to full access, subagent tool grants and a kit's GitHub trigger
  widen authority on a plain click. Chat classes all three code-everything, and phase 0a adds a password in the
  console.
- **Route scope vs handler.** Fix the mismatches listed above, so the derived classes are right.

## 6. Threat model

| Attacker | Off | Everyday | Everything |
| --- | --- | --- | --- |
| **Someone else in a group or channel** | Their taps fail: tokens are bound to the person's binding. Groups can't pair. | Same. Changes, ceremonies and files only in the private chat. | Same. |
| **A forwarded message, an edited message** | Ignored (`forward_origin`, `via_bot`, `sender_chat`; `edited_message` added to the explicit ignore list). A forwarded card's tokens fail. | Same. | Same. |
| **A replayed button** | One-use tokens bound to binding, chat, message and digest; staleness checked at the tap; updates applied once. | Plus a level re-check. | Keypad tokens die with their ceremony; the code step is monotonic. |
| **The console's chat lead** | Posts as the bot; never a person's message. No approve or merge tool. | Proposes cards whose words are Toolroll's. Never sees keypad taps or modal input; code-like messages never reach it. | Can't open a ceremony or tap. |
| **A fenced build agent** | Can't read bot tokens (fenced `tool-secrets`) or mint pairing codes. From phase 0a, at every level: can't read the listed chat apps, **browser profiles** or password managers, or chat and vault environment variables, under either fence policy (§1.1, attack-tested). It keeps the Keychain, so Chrome's encrypted cookies are protected by the profile deny, not the encryption. Unlisted or custom storage isn't covered. | Same. | Same. |
| **Poisoned Git config in the gate checkout** | Until phase 0a, it runs as the person whenever `toolroll release` runs or resumes. From 0a, the hardened runner refuses it (attack-tested). | Same; Deploy (0b) exists only after 0a. | Same. |
| **An agent outside the fence, or one holding the person's chat session or user token** | Can tap where Approve from chat is on: **today's exposure**. Decision 3 closes it once an authenticator is enrolled. | Taps `act` rows (steer, retry, request changes …), reads everything sent. **Can't approve, merge or do any step-up**: no code. **Exception until phase 3: it can approve and deploy a release** (next row). | Same. Credential acts need the code too. |
| **Anyone holding Alex's Telegram or Slack session, until the code ships** (an agent with his session, a session thief, a Slack admin who took over his member) | **Can approve a release through the release card and deploy it with Deploy**, as Alex. | Same. | Same. |
| **A compromised bot token** | Reads what we send, races updates, edits our cards' words and buttons (can't mint tokens or act as the person). | Sees more (reads, diffs, files). Can relabel a card to mislead a tap. | Can mislead the person about what a code ceremony approves: the code doesn't fix that. It can decode keypad taps only by copying the card. A stolen code can't be used without the linked user's own taps. Detection: our webhook replaced, or `getUpdates` 409 → unlink every Telegram chat and alert. |
| **Slack admin who takes over the member** (SSO or password reset) | Today's tap exposure. | `act` rows only. | Codes needed; reads the DMs. |
| **Slack admin with export access only** | Reads DM history. | Reads cards, files, diffs. No keypad or modal input is in history. | Same. |
| **Telegram account takeover** | Today's tap exposure. | `act` rows only. | Codes needed. |
| **A stolen, unlocked phone holding both the chat app and the authenticator** | As today. | Everything the person can do in chat. | Same. Mitigation: `/unlink-all` from any other chat, or unlink in the console; a password change retires both. |

**Releases until phase 3, said plainly.** Alex chose to keep chat approving and deploying releases (2026-10-25).
Until the authenticator ships, a release can be approved and deployed by whoever holds his linked chat session.

- **What narrows it:**
  - phase 0a fences every build from the chat apps' data, password managers and chat environment variables, so a
    build agent can't take the session;
  - the release card is bound to the exact digest and only works in his private chat;
  - the deployment still needs the passing full check on the exact commit and the pull request's checks, and every
    phase re-proves them;
  - every release approval and Deploy is announced in his other linked chats and by push, naming the chat it came
    from.
- **What doesn't:**
  - an agent outside the fence (an assistant in his terminal can read the Slack desktop data);
  - his Telegram session on another device;
  - a Slack admin takeover.
- **What closes it:** phase 3, the code, shipped with phase 2 if Alex agrees (decision 3).

**No level protects against:**

- a person misreading a relabelled or misleading card;
- data the chat provider keeps;
- one unlocked phone holding both factors;
- an authenticator kept where an unfenced agent can drive it;
- the accepted remembered-login limit.

**TOTP versus a passkey.** A passkey is origin-bound and can't be phished; a code can be relayed. This design
narrows the relay: input only through the ceremony's own keypad or modal from the linked account, once, for one
operation and its terms.

## 7. Overlaps

### Approval-policy phase 2 (Only people / People and the lead / Approve automatically)

These are different questions: **who** approves (a person, the lead or a mode) versus **where** a person may act
(console, or chat and how far).

- Raising a project to People and the lead is a credential act: chat can do it only at Everything, with a code.
  Lowering is one step anywhere.
- A chat yes is always a person's (`chat-code`), never `lead`.
- The chat lead keeps no approve tool.
- Phase 2's line "never in chat" becomes "never in chat below Everything".

### The phone-approval passkey plan

Release approval from the phone is reached by chat at Everything, with no browser. Recommendation (decision 11):

- **Keep its phase 2, the shared terms renderer, as this plan's phase 1 prerequisite.** One renderer, HTML and chat
  text, with "Changed since your last yes" and one contract test that every signed field appears.
- **Keep its phase 3 (the buzz opens the console approval page) as optional.**
- **Shelve passkeys (phases 0–1).** `passkey` stays reserved in the proof list. If passkeys are built later, their
  "Passkey required for approvals" policy also refuses `chat-code`.

## 8. Rollout

Each phase is a small branch with a Codex round and the AGENTS.md safety self-review before each security commit.
Tests cover only what `docs/testing.md` keeps: security rules, migrations, contracts.

### Phase 0a: hardening (§0), ships in 0.9.73

Exactly the five items of §0a, reviewed as one implementation:

1. **Protected storage**: `src/protected-storage.ts` (`PROTECTED_STORAGE`, `protectedStorageDenies`), called by
   `taskBoundary`, `v2Boundary` and every `fenceFor` / `sandboxedSpawn` launch. Link walk and overrides. Environment
   allowlist test. `test/attacks/fence-protected-storage.test.ts` under both policies.
2. **Release Git**: the hardened runner in `release-adapters.ts`, trusted identity from the project's records,
   allowlisted environment, absolute executables. `test/attacks/release-git-config.test.ts`.
3. **Passwords** on `settings.permission-default-send` (full access), `subagent.tools` (grant) and `kit.github`.
4. **Closed list**: `docs/plans/passwordless.md` and its static test gain the four project settings.
5. **The release card**:
   - `scope.ts deployGateScope`;
   - `approvalTermsOf` (the complete terms renderer) with its contract test;
   - the recorded change-list baseline;
   - `chat-decide.ts`: the `release-approve` act, its card, Continue and `cardDigest`;
   - `store.ts sealScopeApproval`: release-card evidence for a chat seal of a deploy gate;
   - notices.

### Phase 0b: Deploy from chat (§0b)

After 0a.

- `release.run`, operator-only, no arguments.
- The `release_job` row.
- The supervised launchd job / `systemd-run` unit, outside the service.
- Restart reconciliation and durable notices.
- The card's **Deploy** / **Resume** with stage progress.

Tap until phase 3. Tested at the real swap boundary.

### Phase 1: admission, the setting, Everyday taps

- **Route table**: the `chat` column and `Caller "chat"`; `admitOperation` extracted; handler-only checks moved into
  shared operation functions; `OPERATE_COMMANDS` gains `chat`.
- **Coverage**: `CHAT_ACTIONS` and `DECIDE_ACTS` gain `route` / `operation`; the derived coverage test;
  `scripts/chat-coverage.mjs`.
- **Setting**: `src/chat-manage.ts` (`chatManageLevel`, `chatManageLevelFor`, `setChatManageLevel`); the command
  parser beside `phoneCommand` (Telegram) and in `processSlackEvent`.
- **Lead and reads**: the lead's `propose_*` tools gain the `tap` operations; the read renderers and file fallback.
- **The shared terms renderer**'s HTML presentation for the console (its chat text ships in 0a).
- **Linking**: notices, `/unlink`, `/unlink-all`, `toolroll chat link|unlink|manage`; `edited_message` ignored.

### Phase 2: the authenticator and the code ceremony

- **Schema v136**: `chat_authenticator`, `chat_code_ceremony` (unique open ceremony per binding).
- **Code**: `src/chat-authenticator.ts` (enrol, reset, `checkChatCode`, storage); the Telegram keypad and the Slack
  modal; `scrubCodeLike` at ingress with the window burn; `ChatCodeProof` and its runtime check; the `chat-code`
  proof.
- **What it unlocks**: `code-everyday` operations (approve and merge within `planInChat` and the person's limits,
  resume, the other step-ups); decision 3 for Off.

### Phase 3: Everything

- `code-everything` operations and `chatCredentialProof`.
- Release approval and Deploy in chat switch from tap to the code: the release card's Approve and **Deploy now**
  open the keypad or modal. `sealScopeApproval`, `ownerApproval` and `deploymentCandidate` accept basis `chat` for a
  deploy gate only with `chat-code`. Recommended to ship with phase 2 (decision 3).
- Raising the lead's power (after approval-policy phase 2).
- Bot-token compromise detection.

### Tests

1. **Phase 0a and 0b**: as listed in §0's test lists. That covers:
   - the release card with no authority row, a moved tag and an omitted field;
   - the release Git attack test;
   - protected storage under both policies;
   - Deploy's refusals, its single run, the swap boundary and lost completion.
2. **Admission parity**: for a sample of each role and resolver kind, chat and HTTP give the same verdict.
   - **Non-operator**: an approver with a valid code on an `operator` row (approval rules, monitoring, updates,
     retention) → refused.
   - **Cross-project**: a code from an approver without access to the task's project → refused.
   - **Viewer** → refused.
   - **Limited account outside its project** → refused.
3. **Proof binding at runtime**: a `ChatCodeProof` for operation X presented to operation Y, for terms T to terms T′,
   for account A to account B, or after consumption → refused.
4. **Ceremony binding**: open A then B; A's keypad tokens and A's modal submission do nothing; B's work. A keypad tap
   from another chat or member does nothing. Input before `opened_at` is refused. An expired ceremony is refused.
5. **Ingress scrub**: code-like text (`123456`, `123 456`, `code: 123-456`, inside a sentence) from a linked,
   enrolled account → absent from `telegram_update` raw JSON, `chat_event`, `telegram_conversation` and the lead's
   queue; the window is burned (the same code then fails in the keypad); the person is told. Slack `view_submission`
   never reaches the queue.
6. **TOTP**: RFC 6238 SHA-1 vectors; window edges; same code twice; an older in-window code after a newer one; one
   code for two racing ceremonies.
7. **Lockout**: 5 failures → 15 minutes; 10 → hard lock; reset needs a typed password; taps keep working.
8. **Approval rules**: through the real chat intake, a code approval of
   - a mate-written scope;
   - a sweep;
   - protected work;
   - an over-limit plan;
   - a plan with Approve from chat off;
   - a deploy gate through the plain plan card instead of the release card;

   all refused. A normal plan within limits → approved, basis `chat`, proof `chat-code`.
9. **Levels table**: one row per class × level × project override. Raising refuses session, remembered login, lead
   token, API token and chat. Lowering works from chat and cancels ceremonies.
10. **Coverage contract**: every POST row operation and user CLI command is classified; every non-`ui-only` class has
    a chat entry; `ui-only` has a reason; a row can't loosen its default; an unknown discriminant value refuses chat.
11. **Fence**: §1.1's cases (aliases, relocated roots, nested links, creation after launch, overrides, a project grant)
    under both policies and every available backend; chat and vault environment variables absent.
12. **Storage**: the secret never appears in the database, ledger, export or backup; a swapped item fails closed;
    enrolment refuses the remembered login.
13. **Proof contract**: `chat-code` is a person's proof in `personProof` and in SQL (agreement test);
    `credentialProof` refuses it.
14. **Retirement**: a password change, revocation or reset retires the authenticator and open ceremonies.
15. **Migration**: v136 on a seeded v135 database; the level reads `off`; bindings unchanged.

**Journeys** (UI work only):

- Settings → Chat at desktop and phone.
- On Alex's phone in Telegram: file → approve with the keypad → merge with the keypad (Everyday), then a release with
  the keypad (Everything).
- A Slack modal approval.

Evidence goes under `evidence/`, not committed.

## 9. Words (plain UI)

- **Setting**: **Manage from chat** — Off / Everyday work / Everything.
  - Everyday work: "Tasks and reviews in your linked chat. Approvals and merges ask for your authenticator code."
  - Everything: "Releases and security settings too, each with your authenticator code."
- **Settings rows:**
  - **Linked chats**: "Telegram @alex · linked Oct 25" · **Unlink**.
  - **Authenticator app**: **Set up** / **Reset**.
- **In chat:**
  - Keypad card: "Enter your authenticator code" with ● ● ● ○ ○ ○, then **Confirm**.
  - "That code didn't work." / "Codes are locked for 15 minutes after several wrong tries."
  - "Codes go in the keypad, never in a message. That code wasn't used."
  - "Do this in your own chat with Toolroll." / "Releases are approved in Toolroll."
  - "Managing from chat is off here. Open Toolroll to do this."
  - "A new chat was linked to your account: Telegram @name. Not you? Reply /unlink-all."

## 10. Decisions for Alex

1. **Phase 0a ships in 0.9.73 and takes nothing away from chat** (Alex, 2026-10-25: "Chat should be able to deploy
   and approve still"). It contains:
   1. protected storage (chat apps, browser profiles, password managers) denied to every launch under both fence
      policies, plus chat and vault environment variables, with attack tests;
   2. the release coordinator's Git hardened, closing an exposure `toolroll release` has today;
   3. a password on the three widening actions;
   4. the four project settings on the closed list;
   5. the hardened release card: every signed term first, the change list from the recorded last release (never a
      tag), Continue then Approve, private linked chat only, bound to the card's digest.

   Phase 0b then adds **Deploy**: a supervised release process outside the service, by tap until phase 3.
   *Recommend yes.*
2. **A linked chat is not proof of a person.** Taps cover only operations the console takes without a password; every
   step-up needs a code at Everyday and Everything (§1). *Recommend yes.* The alternative, taps for approvals at
   Everyday, is open to any agent holding the chat session.
3. **When the tap stops being enough.**
   - Ordinary approvals and merges: once a person enrols an authenticator, Approve from chat asks for the code, and
     the tap-only road retires in the release after phase 2.
   - Release approval and Deploy: tap until phase 3, then the code.
   - **Recommend shipping phase 3's release part together with phase 2**, so the window where a held chat session
     can approve and deploy a release is as short as possible. *Recommend yes.*
4. **Release-once's "or a paired-chat tap" stands until phase 3**, narrowed to the release card. A chat seal of a
   deploy gate through any other card refuses. From phase 3 it reads "or a paired-chat tap with the authenticator
   code". Release and Deploy are available at **Everyday** and above (and through Approve from chat at Off, as today),
   not only at Everything. *Recommend yes.*
5. **Instance level with a lower-only project override**, three levels, default Off. *Recommend yes.*
6. **Chat approvals keep `planInChat` and the person's Approve from chat limits at every level.** No code lifts the
   limits, and sweeps and other lead-written text stay in the console in v1. *Recommend yes.*
7. **Code entry**: a keypad on the card (Telegram) and a modal (Slack); a code typed as a message is never used, and
   it burns the current window. *Recommend yes.*
8. **Any six-digit run in a message from an enrolled person is withheld from the lead and stored with the digits
   removed. No exemption, not even "#123456".** Issues and pull requests are referred to by link or `/task`.
   *Recommend yes.* It's the price of never letting a code reach the lead.
9. *(Part of phase 0a, decision 1.)* **Deny the listed chat-app, browser-profile and password-manager storage to every
   launch, and claim no isolation for unlisted or custom storage** (§1.1).
   *Recommend yes.*
10. **Enrolment and recovery only in the console or this computer's CLI with a typed password**; no recovery codes; a
    password change retires the authenticator. *Recommend yes.*
11. **The passkey plan: shelve phases 0–1**, and keep the shared terms renderer (needed here) and the optional
    notification phase. *Recommend yes.*
12. **The 64 ui-only operations stay out of chat even at Everything**: secrets, linking, raising chat's own power,
    browser- and computer-bound acts, new outside destinations. *Recommend yes.*
13. *(Part of phase 0a, decision 1.)* **Ask for a password in the console too** for the three widening acts that take none today (permission default to
    full access, subagent tool grants, a kit's GitHub trigger)? *Recommend yes*, as a separate small fix.
14. **Lockout thresholds**: 5 wrong codes in 15 minutes → a 15-minute lock; 10 since the last success → a password
    reset. *Recommend yes.*
15. **Signs of a stolen bot token unlink every Telegram chat and alert.** *Recommend yes.*

## Review — round 1 (Codex, NO-GO, 7 High), and what changed

1. **A linked account isn't a person** (user clients press buttons, user tokens write) → §1.
   - Builds are fenced from chat app data, password managers and chat env variables, with attack tests.
   - What can't be enforced is stated: unfenced agents, the Keychain, other devices, provider history.
   - Every step-up and credential act needs a code at every level. Taps cover only `act` rows.
   - Today's tap-only Approve from chat asks for the code once an authenticator exists (decision 3).
2. **A code could approve another ceremony** → §4. Input is bound to the ceremony through keypad tokens on its own
   card or modal metadata; replaced, unrelated, other-chat and earlier input refused. Commands render terms and need
   Continue.
3. **Codes reached queues and transcripts** → §4.
   - The keypad (Telegram) and the modal (Slack) are dedicated inputs; no message is a code answer.
   - Code-like messages are scrubbed at initial ingress (before `keepPushedUpdate`'s raw store, the `getUpdates`
     store and Slack's queueing), never given to the lead, and the code window is burned.
   - Provider history is named as unprotectable.
4. **Function reuse isn't authorization reuse** → §3.
   - Chat is a route-table caller admitted by the same `admitOperation` (role, project, scope, limited access).
   - Handler-only checks move into shared operation functions.
   - A runtime `ChatCodeProof` is bound to route, operation and terms.
   - Non-operator, cross-project, viewer and limited tests.
5. **Everyday approvals contradicted planInChat** → §2. Every chat approval goes through `approve()` with
   `planInChat` and the person's limits. Sweeps (mate text) and protected work stay in the console. No two-tap stands
   in for the password screen.
6. **Per-operation classification; monitoring** → §3 and §5.
   - Classes live per operation discriminant on the route rows.
   - 352 operations are classified one by one: 306 acting console operations plus 46 CLI-only commands.
   - Every monitoring operation (destinations, header secret, rotate) is ui-only, as are backup folders and data
     export.
   - The counts come from the inventory, and phase 1 makes them a generated test.
7. **Phase 0 missed the first release approval** → §0.
   - Deploy gates are recognised from the signed scope terms (`candidate`, `release_terms_json`) before any authority
     row.
   - By Alex's decision (revision 3) chat keeps approving them, but only through the hardened release card: a chat
     seal of a deploy gate without the release-card evidence refuses, and the gates accept that card's `chat` proof
     until phase 3.
   - The test runs with no authority row.

Simplification taken: no new registry. The route table, `OPERATE_COMMANDS`, `CHAT_ACTIONS` and `DECIDE_ACTS` are
extended, and coverage is derived from them.

## Review — round 2 (Codex on revision 3: NO-GO), and what changed

Round 1's findings 2, 4, 5 and 7 were closed. Findings 1, 3 and 6 were partial, and there were 7 new ones. Alex's tap
for releases stands.

1. **`HOME_CONFIGURATION` is ignored by version-2 fences** → §1.1. A new mandatory `PROTECTED_STORAGE` deny, outside
   the version-1 list, is applied by every boundary builder and launch kind, under both policies and every backend,
   whatever the project's read settings. The attack tests run under both policies.
2. **Incomplete path inventory; the symlink claim was too broad** → §1.1.
   - The storage table covers each app and install variant on macOS and Linux: Slack, Telegram, Discord, Teams,
     1Password (with `~/.config/1Password` and Snap), Bitwarden (desktop, CLI, extensions), and the Chrome, Chromium,
     Brave, Edge, Arc, Firefox and Safari profiles.
   - It adds the known configuration overrides and a bounded walk for nested outward links.
   - Tests cover aliases, relocated roots, nested links, launch-time creation and overrides.
   - No isolation is claimed for unlisted or custom storage.
   - The threat model says builds keep the Keychain, so the profile deny is what protects Chrome's cookies.
   - (Round-1 finding 1 → closed by this and the next item.)
3. **The release coordinator's Git runs checkout-controlled config** → §0a.2. This exposure exists in today's
   `toolroll release`, so the fix is in 0a:
   - a hardened runner, with config commands refused;
   - trusted recorded identity and remote, and canonical paths;
   - an allowlisted environment and absolute executables;
   - an attack test for include, `sshCommand`, fsmonitor, hooks, `ext::`, remote helpers and credential helpers
     during preflight and resume.

   It is a prerequisite for Deploy.
4. **Release card terms incomplete; a mutable tag as the baseline** → §0a.5.
   - The complete terms renderer moves into 0a, showing every scope field and every `release_terms_json` field, with
     a contract test and an omitted-field test.
   - The baseline is the plane's recorded verified merge commit of the last merged release, never a tag, and is bound
     into `cardDigest`.
   - A moved-tag test.
5. **`kit.github` was still a tap; conflicts in the release exclusions** → §5 and §0b.
   - `kit.github` is code-everything (and gets a console password in 0a).
   - The `release` command's variants are reconciled.
   - Effective classes are a function of validated arguments and state, tested as effective classes.
   - Counts regenerated: tap 211, code-everyday 21, code-everything 56, ui-only 64.
6. **Raw envelopes could rebuild a code; the "#123456" exemption** → §4. (Round-1 finding 3 → closed by this item.)
   - Telegram and Slack persist a minimal validated projection, with no `reply_markup` and no nested messages.
     Ordinary envelopes are scrubbed before persistence.
   - The exemption is removed.
   - The window burn is an atomic `MAX` update, stated as post-ingress protection only.
7. **Deploy job lifetime across the swap** → §0b.
   - A separate launchd job or `systemd-run` unit outside the replaced service, with durable process identity (pid and
     start time) and restart reconciliation.
   - Durable completion with retried notices.
   - Tests at the real stop and swap boundary, for a duplicate Deploy and a lost completion.

Round-1 finding 6 (classification) → closed by item 5. The stale findings-map sentence (round-1 item 7) is rewritten.
