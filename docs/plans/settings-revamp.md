# Settings revamp: build plan (UI revamp, Phase 3)

Status: plan, revised after Codex review round 1 (2026-10-31). Nothing is built yet.

**Base:** `main` **after PR #270 (Models editor) merges**. Every slice branches from a `main` that already contains
its prerequisites. Before S11 starts, check on that `main` that `control-setup.ts` `approveSetup` applies the Sized
preset. On #270's head (64b5ca91) it does, but only when the installation has no model rows yet and the person
approving is an instance operator. In any other case it refuses with a message.

**Inputs:**
- `docs/plans/settings-ui-audit.md` (the merged top 10)
- `evidence/ui-revamp/audit-{A,B,C,D}-*.md`
- `evidence/ui-revamp/SCOPE.md`
- `evidence/ui-revamp/directions.md`
- the prototype `evidence/ui-revamp/directions.html`. The screens to match are `directions/1-refined-*.png` and
  `1-guided-hub-*.png`.

The evidence folder is gitignored, so build agents get these copied in or are given their path.

**What the owner chose:** Direction 1, "Guided setup + grouped hub".
- `/setup` has five steps: Password → Project → Agent and models (Sized by job applied) → Phone (optional) → First
  task. You can skip any step, and the page says what skipping costs.
- The Settings hub becomes an index of eight groups: General, Agents and models, Chat apps and alerts, Approvals and
  safety, Projects, People and sign-in, Spend, System. A "Needs you" block sits on top.
- Each group is a short page with sticky saving.
- Saving opens one step-up dialog. It asks for exactly the proof that action already needs.
- Each chat app gets one page: token → pair → check.
- From Direction 3: a "Before your first task" checklist, filtered to the steps still open, for anyone who skipped
  setup steps.

Also in scope:
- the accessibility and guideline fixes;
- the frame fixes;
- the Spend number fixes;
- one name per model;
- a project picker that shows the open project;
- `/system`'s stale wording;
- making the `up` password easy to find;
- the dead end on the `serve` path when there is no builder.

---

## 1. What the code says (read this before any slice)

1. **Proofs differ by action, and the plan changes none of them.**
   - The step-up field is called `password` on some routes and `token` on others (`/control/*`, `/mode/*`,
     `/people/*`, `/push/subscribe`, `/chat/config`, chat-approval).
   - Some forms have a field named like a credential that is **not a proof**:
     - in `/settings/telegram-token`, `token` is the bot token;
     - in `/settings/email`, `password` is the SMTP password;
     - `provider-key` sends the API key as `value`.
   - Many saves need nothing beyond the session and CSRF: quality, notifications, messaging, digest, provider key,
     Telegram token, email, Google.
   - Credential acts need a typed password, even under Passwordless.
   - Widening check access needs a password typed *now* by an instance operator (`settings.ts` ~2406).
   - When someone signed in through an identity provider, `sendScreen` replaces the step-up fields on the page with a
     one-use re-check link (`ssoStepUps`).
   - Approvals carry a nonce and a digest. Project setup consumes its nonce **before** it checks the password
     (`settings.ts` ~1550), so after a failed attempt the person must review again.
   - The 15-minute remember covers three routes only: `task.act.approve`, `chat.send` and `chat.proposal.confirm`. It
     stays that way in this arc.
2. **There are two kinds of sensitive page.**
   - A page that has a password field in its server HTML, or `sensitive: true`, keeps its script. It loses the live
     sidebar states, the summary room and the chrome forms.
   - A page with `forceSensitive: true` holds a one-time secret: an API token, an invite link, a pairing code. It
     leaves the workspace for a focused page with **no script at all** (`serve.ts` ~1580).
   - So a step-up dialog keeps its field in the server HTML, and a revealed secret stays script-free, with text you
     can select and no scripted Copy.
3. **Positions are pinned.** `src/password-freshness.test.ts` pins where functions sit in `operate.ts`, `store.ts`,
   `server/tasks.ts` and `server/settings.ts`, and counts every mention of the provers and the freshness facts.
   - New handlers go after the last inner function of `createSettingsHandlers`, or in new modules.
   - Edits inside existing functions must not add arrow functions ahead of pinned anonymous ones (for example
     `controlAct@73><anonymous>@1`).
   - A pin change is a reviewed security change. Say so in the PR.
4. **Routes.**
   - Every address is one row in `route-table.ts` with one handler.
   - A console GET needs an open project unless its row sets `needsProject: false` (`route-table.ts` ~110).
   - `/` sends a browser session to `/chat`, but sends a restricted (project-limited) account or a token caller to
     `/work` (`pages.ts` `homeRedirect`).
   - The sign-in return list is `http.ts` `LOGIN_RETURN_PAGES`.
   - `sayTo(page, anchor)` writes the query and then the anchor. Pass an anchor as that argument, never inside the
     page string.
   - The generated suites (`route-roles-http`, `route-policy-http`, `get-quiet`, `post-forms-http`) cover new rows.
   - `get-quiet` pins some current pages at 200. Making one of them a redirect means changing that test on purpose.
5. **Where the code differs from what the design assumed.**
   - The lead's API key lives in `chat-key-<provider>` under the config folder (`serve.ts` ~1338, `chat.ts` ~1241),
     separate from AI-provider keys (`keys.ts` `keyFileFor`).
   - Integrations is more than chat apps and webhooks. It also covers GitHub, Linear, email, MCP tools, monitoring,
     agents, diagnostics, and warnings about how secrets are stored.
   - Its "Send test" button runs a connection check. It does not deliver a message.
   - `/settings/models` reads `scope`, `preset`, `switch` and `to`.
   - The hub's anchors used across the code are `#providers`, `#email`, `#settings-chat-apps`, `#telegram-token` and
     `#updates`. S7 lists them all with grep.
   - `up-login.txt` can hold a password the person chose themselves, not only a generated one (`operate.ts` ~7405).
   - `up` prints where that file is only when the browser fails to open (`operate.ts` ~8000).
   - No CLI command shows the password. Reading the file with `cat` is the only way today.
6. **Bug locations.**
   - Project picker: `app.tsx` ~589 doesn't read the open project.
   - Two h1s: `app.tsx` ~1004, plus the screen-reader-only h1 at `settings-view.tsx` ~481.
   - 44px targets: `console.css` 268–270 beats `workspace.css` 373.
   - `--so-input-line` contrast is 1.48:1.
   - `start-worker` points at `#run-status` (`browser-crew.ts:29`).
   - `/system` stale copy: `render-pages.ts:321`.
   - `usd()` drops cents at $10 and above (`spend.ts`, shared with alerts and limits).
   - Autosave on arrow keys: `AutoForm` and `SETTINGS_AUTOSAVE_SCRIPT`.
   - Telegram loop: `telegram-settings.ts:22`.
   - `--so-attention` is `var(--so-signal)`, which the accent cookie rewrites (`accent-colors.ts`).

## 2. Rules for every build agent

- **Branch and PR.** Use a worktree off a `main` that contains the slice's prerequisites. Open a **non-draft PR and
  don't merge**.
- **No live state.** Don't touch `:4180`, `~/.config/standing-orders` or the real database. Use S1's fixture.
- **Reviews.** Read `AGENTS.md` and run its UI simplicity pass. Run the **safety self-review** before any commit that
  touches step-up, credentials, sessions, sensitivity, routes, approvals or redirects, and say in the PR how each item
  applies.
- **Placement.** Follow §1.3. Run `npx vitest run src/password-freshness.test.ts` on every slice that touches `src/`
  server code.
- **Never normalise auth handlers.** A slice may change where a handler returns to, and how it reports field
  validation errors (§4). It may not change:
  - which field a handler reads;
  - which prover it calls;
  - its role;
  - its nonce or digest;
  - its Passwordless or SSO behaviour.
- **Tests.**
  - Only the kinds `docs/testing.md` keeps: security rules, contracts, data integrity.
  - Route, auth and redirect contracts are tested over HTTP.
  - No tests for wording, markup or CSS.
  - Run only the affected files with `npx vitest run <files>`. CI and the release check run everything.
- **Evidence.** See §6.
- **Trailers**, exactly:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01U8qFAnWnZybhqHvofLBVL7
  ```
- **Compatibility.** Old URLs keep working (§3). POST endpoints don't move: forms move between pages but keep the same
  routes, fields and proofs.

## 3. Information architecture

| Group | URL | Holds | Comes from |
|---|---|---|---|
| General | `/settings/general` | Appearance (theme; accent under "Customize accent"); the remembered-password chip with Forget, and chime, moved out of the sidebar | hub Appearance and Accent; sidebar chips |
| Agents and models | `/settings/agents` | The agent (builder, sign-in state, how it's paid = AI providers); **#270's Models editor** at `#models`; rows for Lead, Subagents, Tools, Skills, Knowledge, Learning | hub AI providers; `/settings/models`; Agents tiles |
| Chat apps and alerts | `/settings/alerts` | One row per chat app with its state; what reaches you (chat messages, digest, screenshots, mute per project); this device (push); email (closed, Google first); phone access (Tailscale) | hub Notifications, phone and Email; Chat apps tiles |
| Approvals and safety | `/settings/safety` | Defaults for new tasks (permissions, quality); who approves (approval rules, release approval); limits (policy); per project (summary of the operating mode → `/mode`; sandbox and network → `/settings/project`); one sentence on which setting wins | hub Permission and Quality; Approval rules; Policy; `/mode` |
| Projects | `/settings/projects` | One row per project → Project settings, Checks, Pull requests, Tools | Project tile; links that today exist only on Projects |
| People and sign-in | `/settings/people` | People, Sessions and tokens, Sign-in (SSO), Passwordless | `/people`; Access tiles |
| Spend | `/settings/spend` (already exists) | This month in one line, monthly limits, a link to the `/spend` report | today's limits page |
| System | `/settings/system` | Builders (with **Start a builder**, `#builder`), Updates, Backups, Storage, Retention, Data, Monitoring; rows to Fleet, Requirements, `/system`, and **Integrations**, which stays a status page of its own | hub Workers and Updates; System tiles; the Workspace-tools Settings group |

**Who can open a group page.**
- A group page lets in anyone who can read **any** part of it. The server then drops the sections and controls that
  person can't use. Every action keeps its own role check.
  - A viewer still sees the Models read-out, their own People entry and their own sessions.
  - A project-limited approver sees only their projects.
  - A token caller gets exactly what it gets today on the pages being gathered.
- Hiding a hub card is not the same as keeping someone's access. The tests check both.

**Compatibility map.** S7 owns it. Every target is a fixed path.

| Old | New | Kept |
|---|---|---|
| `/settings/models?scope=&preset=&switch=&to=&said=&problem=` | `/settings/agents?<same validated params>#models` | Each parameter is checked with the #270 editor's own validators and dropped if it fails. A bad scope never quietly becomes the installation-wide scope |
| `/settings#providers` | `/settings/agents#providers` | — |
| `/settings#email`, `#settings-chat-apps`, `#telegram-token`, `#phone` | `/settings/alerts#email`, `/settings/alerts`, `/settings/telegram#token`, `/settings/alerts#phone` | Forwarded by the hub script, because fragments never reach the server. Internal links that point at these anchors are updated |
| `/settings#updates` | `/settings/system#updates` | — |
| `/settings/checks` or `/settings/pull-requests` with no `?repo=` | the open project's page, otherwise `/settings/projects` | Today these return 404 |
| `/people`, `/mode`, `/fleet`, `/caps`, `/system`, `/control`, `/settings/integrations`, every `/settings/<tile>` | unchanged | breadcrumb "Settings / Group" |

When a handler's return target gains an anchor, the anchor goes in `sayTo`'s anchor argument, so the query comes
before the fragment.

## 4. The settings kit (built in S2, used by every later slice)

- **Frame.**
  - One `<h1>`, the page's own. The shell header shows the section name as text, using the existing `pageOnly` branch.
  - The breadcrumb "Settings / Group" uses real links.
  - One content width token: a 760px column.
  - Single frame with no Crew sheet on `/settings/*`, `/setup`, `/people`, `/mode`, `/control` and `/spend`.
- **Section.** A heading, a one-line state, then the form. No nested wells.
- **Save, local to each section.**
  - Each editable section has its own sticky Save: "No changes" or "<what changed>", plus one ink Save button.
  - Save submits that section's existing form to its existing route.
  - There is no lock across sections, no batching and no `fetch`.
- **Step-up dialog, drawn from each action's own contract.**
  - The server renders the form's real proof field (`password` or `token`, with a visible label and
    `current-password`) inside a `<dialog>` in its own HTML.
  - It opens on submit. It keeps the original submitter (the pressed button's `name=value`) and every hidden term
    (nonce, digest, fingerprint).
  - Cancel closes it without posting.
  - Without JavaScript, the field shows inline exactly as it does today.
  - SSO replaces the field written into the page, as it does today.
  - It asks for nothing on CSRF-only actions.
  - Under Passwordless it asks for nothing only where the action is not a credential act.
  - The server still proves everything, so a wrong guess in the page leads to a refusal, never a bypass.
- **Errors.**
  - **Field validation errors** (a bad amount, a missing field) come back as an inline 422 with the values kept.
    Credential and secret fields are never echoed back.
  - The message sits under the field, with `aria-invalid` and `aria-describedby`, and focus moves there.
  - **Auth refusals, conflicts and rate limits** keep their current responses.
  - **A consumed or stale approval nonce** sends the person back to review, with a fresh preview. The form never
    returns with a dead nonce.
  - Handlers this arc doesn't move keep redirecting with `?problem=`. The kit shows that message, with
    `role="alert"`, in the section the anchor points to.
  - Toasts are for success only.
- **Secret inputs.**
  - Use `autocomplete="off"` and a field name that doesn't read as "password".
  - Add the password-manager opt-outs: `data-1p-ignore`, `data-lpignore="true"`, `data-bwignore`,
    `data-form-type="other"`.
  - The SMTP username stops using `autocomplete="username"`.
- **Revealed secrets** (pairing code, API token, invite link) stay `forceSensitive`, with no script and selectable
  text. Scripted Copy is **Later**.
- **Choice groups.**
  - `fieldset` with a `legend`. Option details are linked with `aria-describedby`.
  - No autosave.
  - Preferences kept per browser (theme, accent, chime) may save in the background. Each save is announced with
    `aria-live`, and focus stays where it was.
- **Repeated buttons name their object**, for example "Manage Anthropic".

### Proof inventory

S2 completes this table from the handlers, pins it with a test, and the kit renders from it. The rows below come from
the `console-api.ts` form contracts and `route-table.ts`; S2 checks each against its handler. "Credential" means the
Passwordless closed list: a password typed now, or an SSO one-use re-check.

| Action | Route(s) | Proof field | Role | Proof today | Nonce/digest |
|---|---|---|---|---|---|
| Quality default, notifications, mute, messaging, Telegram digest | `/settings/{quality-default,notifications,notifications/mute,messaging,telegram-digest}` | none (CSRF) | approver | session | — |
| Provider key | `/settings/provider-key(-clear)` | none; `value` is the API key **secret** | approver | session | — |
| Telegram bot token | `/settings/telegram-token` | none; `token` is the **bot credential** | approver | session | — |
| Email, Google | `/settings/email*`, `/settings/google*` | none; `password` and `clientSecret` are **service secrets** | approver | session | — |
| Permission default | `/settings/permission-default` | `password`, only for Full access | approver | step-up when widening | — |
| Spend limit | `/spend/budget` | `password` | operator | step-up | — |
| Models apply/agent | `/settings/models/{apply,agent}` | `password` | operator | step-up | state + change digest |
| Policy, approval rules, retention, backups, data, monitoring | `/settings/<name>` | `password` | operator | step-up | — |
| Sign-in (SSO), Passwordless on, release auto-approve | `/settings/{sign-in,passwordless,release-approval}` | `password` | operator / approver | **credential** | — |
| Project network, writes, sandbox, check access | `/settings/project/*` | `password` | per row | **credential**; widening check access: typed now + operator | — |
| Project delete | `/settings/project/delete` | `password` + typed name | operator | step-up | — |
| Tools connect/change | `/settings/tools/{connect,change}` | `password` | approver | step-up | `shown` digest |
| Telegram pair/unpair; Slack, Discord, Teams connect/pair/… | `/settings/telegram/*`, `/settings/{slack,discord,teams}/*` | `password` | approver | **credential** | — |
| Chat approval save | `/settings/chat-approval/save` | `token` | approver, self | **credential** | nonce + digest |
| Push enrol | `/push/subscribe` | `token` | approver | step-up | — |
| Project setup approve | `/control/setup-approve` | `token` | approver | step-up | nonce (consumed first) + fingerprint |
| Mode sign | `/mode/sign` | `token` | approver | step-up; **credential** with chat-approve | nonce + digest |
| People invite, projects, revoke, invite-revoke | `/people/*` | `token` | operator / approver | invite and widening: **credential** | — |
| Lead config and key | `/chat/config` | `token` | approver | step-up | — |

## 5. Slices

Each slice lists what the user gets, files, routes, security notes, tests and prerequisites. The wave is in the
heading. **No two slices in a wave touch the same file**, and that includes shared test and contract files.

### S1. Settings journey harness (wave 0, interface first)
- **User value:** the owner and reviewers see the pages each PR changes at 1440 and 390, with the same accessibility
  probes every time.
- **Stage 1 (wave 0), lands before wave 1:**
  - `scripts/settings-journey.mjs`, which builds the synthetic fixture: temp HOME, temp DB, random port. It refuses to
    run if any path resolves to the real setup.
  - The step-file interface: `scripts/settings-journey/<slice>.mjs` exports pages and actions.
  - The probe API.
- **Stage 2:** each later slice adds its own step file. Nothing edits the runner except S1.
- **Probes:**
  - exactly one `h1`;
  - no sideways scroll;
  - main-region controls at least 44px tall at 390;
  - after a forced validation error, `aria-invalid` and a description are present;
  - ArrowDown in a radio group sends no request;
  - secret inputs carry the opt-outs;
  - the sticky save never covers the focused control;
  - keyboard focus is visible after the dialog closes;
  - the sidebar has the same slots on sensitive pages.
- **How it runs:** with the real scroller intact, scrolling the sheet. Unrolled full-length shots are extra. A no-JS
  pass for any form the slice changed, and a long-error case.
- **Security:** fixture only.
- **Tests:** the journey itself.

### S2. One frame and the settings kit (wave 1)
- **User value:**
  - the same top bar, breadcrumb, single title and width on every settings page;
  - the sidebar stops jumping;
  - the project picker shows the open project;
  - 44px targets on a phone;
  - no Crew sheet on settings pages;
  - the kit and the proof inventory exist for later slices.
- **Files:**
  - `src/browser/app.tsx`
  - `src/browser/workspace.css`
  - `src/server/console.css` (move the input rule into `:where()`)
  - `src/server/chrome.ts` (breadcrumbs, single frame, inert sidebar slots on sensitive pages)
  - `src/contracts/console-api.ts` (`openProject`, `crumbs`)
  - `src/serve.ts` (`sendScreen` passes those two, nothing else)
  - new: `src/settings-kit.ts` (helpers and a CSS string), `src/settings-kit-script.ts`, `src/settings-proofs.ts`
    (the inventory as data), `src/settings-kit.test.ts`
  - `src/serve.sidebar.test.ts`, `src/serve.chrome.test.ts`
- **Routes:** none.
- **Security:**
  - A sensitive page keeps its sidebar *slots* as static, inert text: no live states, no summary room, no forms, no
    added script.
  - The dialog's field is in the server HTML, so sensitivity and the SSO replacement both still apply.
  - The kit never sets `value` on a proof or secret field.
  - Only rendering code reads the inventory. Handlers never read it.
- **Tests:**
  - `settings-kit.test.ts`, as contract tables:
    - for every inventory row, the rendered proof field name equals the handler's form-contract field;
    - CSRF-only rows render no proof field;
    - secret fields never carry `value`;
    - the dialog keeps the submitter and the hidden fields.
  - One sidebar case: a sensitive page keeps the same slots, with no live states and no chrome forms.
  - One picker case: it shows the open project.

### S3. The first-account page (wave 1)
- **User value:** creating the first account:
  - shows the rules up front;
  - keeps what you typed when something's wrong;
  - announces each error next to its field;
  - says how many tries are left;
  - has a real title.
- **Files:** `src/server/render-people.ts` (`signupPage`), `src/server/people-tokens.ts` (inside `signupSend` only).
- **Changes:**
  - `<h1>Create the first account</h1>`, plus page titles.
  - `required`, `minlength="8"`, and a username `pattern` with a hint.
  - The username is kept on every error. The setup code is kept unless the error is about the code.
  - `role="alert"` plus `aria-describedby`.
  - Errors in sentence case.
- **Security:**
  - The account is still created all at once or not at all.
  - The **five-try lockout** is unchanged.
  - The password is never echoed back.
  - The page is sensitive and `no-store`.
  - No pins change.
- **Tests:** HTTP cases added to the existing signup test:
  - a wrong code keeps the username, empties the code and counts down;
  - the fifth try locks;
  - a failed create leaves no account behind.

### S4. First-run dead ends (wave 1)
- **User value:**
  - A task with no builder links to **Start a builder**, which shows the exact command. It no longer links to itself.
  - `/system` stops saying models can't be changed in the browser.
  - Each model has one name everywhere.
  - `up` always says where your password is and how to see it: "Your password: run `cat ~/…/up-login.txt`". Today it
    says this only when the browser fails to open.
- **Files:**
  - `src/needs-you.ts`
  - `src/browser-crew.ts`
  - `src/server/render-tasks.ts`
  - `src/server/render-pages.ts` (`/system` copy and its `#builder` section)
  - new `src/model-names.ts` (`modelName(provider, id)` over #270's catalog labels)
  - `src/operate.ts` (the `up` print block ~7998, edited in place)
- **Routes:** none.
- **Security:**
  - The commands are constants plus Toolroll's own path. The password itself is never printed.
  - In `operate.ts`, only the existing print lines change; no functions are added.
- **Tests:**
  - One case added to the no-worker check in `serve.workspace.slow.test.ts`: the action points at the builder section.
  - A `modelName` table, where an unknown id falls back to the id.
  - One case in the existing `up` output test: the password-file line prints whether or not the browser opened.

### S5. Needs-you colour and contrast tokens (wave 2; waits for `evidence/ui-revamp/needs-you-colour.md`)
- **User value:**
  - The amber outline and chip return for what waits on you.
  - Input borders and the off switch reach 3:1 contrast.
  - The accent can't repaint needs-you any more.
- **Files:**
  - `src/design/tokens.css`: `--so-needs-you{,-line,-text,-soft}` in light, dark and `[data-theme]`; a darker
    `--so-input-line`; `--so-switch-off`.
  - `DESIGN.md`
  - `src/browser/workspace.css`: needs-you selectors only. Ink verbs and counts stay on `--so-attention`.
  - `src/browser/components/ui/{switch,form-controls}.tsx`
  - `src/accent-colors.ts`: copy only, and remove the amber warning on the ink default.
- **Security:** none.
- **Tests:**
  - One case in `accent-colors.test.ts`: for every preset, **and for a saved custom colour**, the needs-you tokens
    don't change.
  - Contrast is checked by a journey probe: outline at least 3:1 and chip text at least 4.5:1, in light and dark.
- **Prerequisite:** S2. Until S5 lands, later slices write `var(--so-needs-you, var(--so-warning))`.

### S6. Spend you can trust (wave 2)
- **User value:**
  - "$12.57 of $13.00 · 96%".
  - Zero reads "$0", and empty KPI tiles are hidden.
  - A hard-stop limit at 90% or more is marked as needing you, in words as well as colour.
  - `/spend` is titled "Spend report".
  - The limits page loses its Models block and uses one name per model.
  - This is the first page on the kit: a Save for its own section, the dialog, and an inline 422 for a bad amount.
- **Files:**
  - `src/spend.ts` (`usd()` formatting only)
  - `src/spend-ui.ts`
  - `src/server/settings.ts` (`spendSettingsPage` and `spendBudget`, in place; **the first handler moved to inline
    field errors**)
  - `scripts/settings-journey/spend.mjs`
- **Routes:** unchanged.
- **Security:**
  - The budget's step-up and operator role are unchanged.
  - The 422 echoes the amount and target, never the password.
  - Auth refusals keep their response.
- **D7, display only:** stored money, `--json` output and the budget input (whole dollars) don't change. If `usd()`
  feeds any JSON or machine output, add a separate display formatter instead of changing it.
- **Tests:**
  - HTTP:
    - a bad amount returns 422 with the amount kept, `aria-invalid` set and nothing written;
    - a wrong password gets today's refusal with nothing written;
    - a missing or foreign CSRF token is refused.
  - A `usd` table.
- **Prerequisite:** S2.

### S7. The hub and the eight group pages (wave 3)
- **User value:**
  - Settings becomes a one-screen index.
  - "Needs you" sits on top, with one verb each: no builder, agent not signed in, models not set, a hard-stop limit at
    90% or more, Telegram failing.
  - Eight group cards, each with a state sentence.
  - Every inline hub card moves to its group.
  - People, Fleet, Requirements, Operating mode and System are reachable under Settings.
  - Viewers see only what they can open, and refusals are neutral.
  - The Models editor lives on Agents and models.
  - Arrow keys no longer save a choice.
- **Files:**
  - `src/browser/views/settings-view.tsx`: rewritten as the index.
  - `src/server/render-settings.ts`: the no-JS index; the eight `SETTINGS_GROUPS`; `SETTINGS_AUTOSAVE_SCRIPT` removed;
    the card twins extracted.
  - `src/server/settings.ts`, in place:
    - `settingsHome`;
    - the return targets of moved forms, through `sayTo(page, anchor)`;
    - `modelsPage` becomes the compatibility redirect;
    - checks and pull requests with no repo redirect.
  - `src/server/route-table.ts`: 7 GET rows, `/settings/{general,agents,alerts,safety,projects,people,system}`. Their
    callers are the union of the pages they gather, and their roles follow §3 (anyone who can read any part).
  - New `src/server/settings-groups.ts` (`createSettingsGroupHandlers`).
  - New `src/settings-groups/{general,agents,alerts,safety,projects,people,spend,system}.ts`.
  - New `src/settings-needs.ts`.
  - `src/server/chrome.ts` (`settingsRows`, `SETTINGS_KEYS`, a neutral tone for refusals).
  - `src/contracts/console-api.ts`.
  - `src/serve.ts` (registration).
  - `src/models-ui.ts` (an embeddable variant that returns to its group).
  - `route-roles-http.test.ts`; `get-quiet.test.ts` (redirected pages move from 200 to 302/303 on purpose);
    `scripts/settings-journey/hub.mjs`.
- **Security:**
  - Group GETs only read.
  - Sections and controls are filtered on the server per person. Action routes keep their own roles.
  - Every redirect goes to a fixed target. Kept parameters are checked by the page that owns them.
  - Moved forms keep their route, fields, CSRF and proof.
  - `settings-needs.ts` reads facts and never acts.
- **Tests:**
  - HTTP, each run as operator, viewer, project-limited approver and bearer token:
    - every group page;
    - every old URL in the compatibility map, with its parameters and notices kept. This includes
      `/settings/models?scope=<project>&preset=sized` landing on that project's preview, and a bad `scope` that
      doesn't fall back to the installation-wide scope;
    - a notice that survives the query-then-anchor order.
  - `settings-needs.test.ts`: one table of which facts raise an item.
  - The journey: moving through a choice group with the keyboard sends nothing until Save.
- **Prerequisites:** S2 and S6 (`settings.ts`). S5 is optional.

### S8. Chat apps and alerts (wave 4)
- **User value:**
  - Telegram, Slack, Discord and Teams each get one page with numbered steps.
  - Telegram: a `t.me/BotFather` link and the `/newbot` words → paste the token → pair → check.
  - The pairing code shows on its own script-free page as selectable text, with an **Open the bot** link that doesn't
    contain the code.
  - The check step uses the existing connection or delivery state, labelled "Check connection", nothing more.
  - The loop back to the hub is gone.
  - On the alerts page:
    - email is one closed row, Google first;
    - the SMTP username can no longer pull in your Toolroll password;
    - push for this device is one row;
    - the Tailscale row keeps its wording.
- **Files:**
  - `src/telegram-settings.ts`
  - `src/chat-settings-page.ts`
  - `src/{slack,discord,teams}-settings.ts`
  - `src/server/settings.ts` (`telegramPage` and the `telegramTokenSave` return target, in place)
  - `src/settings-groups/alerts.ts`
  - `scripts/settings-journey/chat-apps.mjs`
- **Routes:** none new. Endpoints that send a test message are Later.
- **Security:**
  - Pairing and connecting stay credential acts.
  - Saving the token stays CSRF-only, with the token in a secret input that is never echoed.
  - The pairing code never goes in a URL or QR (D4).
  - `forceSensitive` pages stay script-free.
- **Tests:**
  - `telegram-settings.test.ts`: one case that no rendered link contains the pairing code.
  - HTTP: the pairing response is still script-free (no `<script>`).
- **Prerequisite:** S7.

### S9. Agents and models (wave 4)
- **User value:**
  - One page answers which agent builds, how it's paid, and which model does what.
  - Sign-in words agree: "Your Claude plan" or "API key".
  - The lead's own key controls stay where they are, clearly labelled "The lead's own key", not merged into AI
    providers.
  - The lead's name field renders properly.
  - Tools asks for the password only after you pick a tool.
  - Secret fields stop inviting password managers.
- **Files:**
  - `src/settings-groups/agents.ts`
  - `src/server/render-settings.ts` (`leadSettingsHtml`, `leadConfigForm`; rendering only)
  - `src/tools-ui.ts` (rendering only; the field names and the `shown` digest stay the same)
  - `src/models-ui.ts` (copy)
- **Pre-check:** confirm the plan page shows the task's size and model. If it doesn't, change the sizing copy so it
  doesn't promise that.
- **Security:** the lead key's storage, precedence, rotation and removal are unchanged. Nothing is copied between
  stores.
- **Tests:**
  - HTTP: Tools connect without proof is still refused.
  - A journey step file.
- **Prerequisite:** S7.

### S10. General (wave 4)
- **User value:**
  - Appearance in one place.
  - "Customize accent" offers up to 6 presets plus a hex field.
  - The remembered-password chip with Forget, and the chime, move from the sidebar to General and the account menu.
- **Files:**
  - `src/settings-groups/general.ts`
  - `src/accent-colors.ts` (the preset list; **a saved custom colour keeps working**)
  - `src/browser/app.tsx`
  - `src/serve.sidebar.test.ts`
- **Security:** Forget keeps its route and its effect. Theme and accent stay in cookies.
- **Tests:** one sidebar case: Forget is reachable from the account menu and still ends the window.
- **Prerequisites:** S5, S7.

### S11. Guided `/setup` (wave 5)
- **User value:**
  - A new owner gets from install to a first planned task in far fewer steps.
  - Sized by job is applied.
  - The `up` password is easy to find.
  - Every step except creating the account can be skipped, and the page says what skipping costs.

**Who sees it.**
- `/setup` is for a browser session (`via: "cookie"`) that is not restricted and has installation access, on a
  non-demo installation that hasn't had its first result.
- Everyone else keeps today's landing: restricted accounts and tokens go to `/work`, everyone else to `/chat`.
- `/` sends an eligible person to `/setup` until each step is either done or skipped by that person.

**Steps.** A closed set of ids, `password | project | agent | phone | task`. Each maps to the **constant** path
`/setup/<id>`. Forms post `step=<id>`, never a path.

- **Password.** Creating the account (signup, or `up`'s account) happens before `/setup` and can't be skipped. This
  step only says where the password is:
  - On `serve`: you just set it.
  - On `up`: "It's saved on the computer running Toolroll. In a terminal there, run `cat ~/…/up-login.txt`". The path
    is shown only on a request from this computer.
  - A link to Passwordless.
  - No secret appears on the page.
- **Project.** Repositories under the projects folder, with the current one preselected → the existing
  `/projects/open`.
- **Agent and models.**
  - The builder is a radio list with each one's sign-in state. This replaces the 9 ink buttons in `control-ui.ts`.
  - Models: Sized by job (recommended) or Opus for everything.
  - "Continue" posts to the existing `/control/setup-preview`. Its review page (`setupPreviewHtml`) carries
    `step=agent` into `/control/setup-approve`. Only on **success** does `controlAct` send the person to
    `/setup/phone`.
  - A consumed or stale nonce goes back to a fresh preview.
  - If the provider can't take the preset, or the person isn't an instance operator, the step blocks and gives the
    exact reason.
  - Not signed in: the command, plus **Check again** (the existing `/settings/connection/check`).
  - No builder: Start a builder (S4). For `serve`, the page says this needs `toolroll up` in a terminal. It doesn't
    promise "no CLI after install".
- **Phone.**
  - Telegram goes through S8's steps. The pairing code stays on its own script-free response page, which gets a
    separate **Continue setup** link (a constant path), shown only when `step=phone` was posted.
  - Push posts to the existing `/push/subscribe` with `step=phone`. On success it goes to `/setup/task`.
- **First task.** `firstTaskSuggestions` plus a text box → the existing task creation → the task page.

**Skips.**
- `POST /setup/skip` with `step=<id>` records a skip **bound to the signed-in account**.
- A skip changes only what is shown. It never counts as done for models, builder, approval or readiness.
- A skip can be undone ("Un-skip" on the checklist).
- When everything left has been skipped, the person lands on `/chat` with the "Before your first task" checklist
  (S16).
- `/setup` can always be reopened from the hub ("Finish setup") while any step is open.
- Storage (D8): one record per account in the store, using the next free schema version if one is needed. Only the
  setup and checklist modules read it, and a static test pins that.

**Routes.**
- `GET /setup` and `GET /setup/{password,project,agent,phone,task}`: cookie callers, approver, `limited: "deny"`.
  `needsProject: false` on `/setup`, `password`, `project` and `phone`.
- `POST /setup/skip`: cookie, act scope.
- `/setup` is added to `LOGIN_RETURN_PAGES` on purpose.

**Files.**
- New: `src/server/setup.ts`, `src/setup-ui.ts`, `src/setup-steps.ts` (id → path), `scripts/settings-journey/setup.mjs`.
- `src/server/route-table.ts`
- `src/server/http.ts` (login return)
- `src/contracts/console-api.ts` (`step` on the project-open, setup, push and Telegram-pair contracts)
- `src/control-ui.ts` (`setupPreviewHtml` carries `step`; the builder radio list; model names)
- `src/server/settings.ts` (`controlAct`'s success target, in place, with no new closures before pinned ones)
- `src/server/chat.ts` (`pushSubscribe`'s success target, in place)
- `src/telegram-settings.ts` (the Continue setup link)
- `src/server/pages.ts` (`homeRedirect`, and the `projects.open` success target)
- `src/server/people-tokens.ts` (the once-link lands on `/`)
- `src/first-run.ts` (setup facts: the agent step is done only when signed in **and** a builder is connected; models
  resolved)
- `src/serve.ts` (registration and the builder-connected facts)
- The store module for the skip record: new code at the end of the file, plus a migration if needed.
- `route-roles-http.test.ts`, `get-quiet.test.ts`, `first-run.test.ts`

**Security.**
- GET `/setup/*` only reads. Agent checks are cached, and no nonce is minted on a GET.
- Every write goes through its existing route and proof.
- A step id outside the set is refused. Destinations are constants: no prefix matching, nothing to escape with `..`.
- Callers that aren't the wizard keep their destinations when `step` is absent.
- `password-freshness.test.ts` must pass, and any pin change is named in the PR.

**Tests (HTTP).**
- Landing:
  - a fresh install goes to `/setup`;
  - a restricted account and a token still go to `/work`;
  - a demo installation goes to `/chat`;
  - an installation with a first result goes to `/chat`.
- Steps:
  - `step=../settings` and unknown ids are refused;
  - a missing `step` keeps today's target;
  - a consumed nonce goes back to preview.
- Models: the rows written match the `/control` path (one case added in `serve.models.test.ts`).
- Skips:
  - skipping models still leaves plans unapprovable;
  - one account's skip doesn't affect another.
- The pairing response stays script-free and carries the Continue link only with `step=phone`.
- A sign-in with `return=/setup` lands there.

**Prerequisites:** S3, S4, S8.

### S12. System (wave 5)
- **User value:**
  - One page shows builders (with Start a builder), the version and updates (in one place), the last backup, disk use
    and retention.
  - Plain words replace "repair turns", "re-reserve" and "probed on the worker".
  - Monitoring placeholders say `toolroll`.
  - Integrations stays a status page linked from here. Its "Send test" becomes "Check connection".
- **Files:**
  - `src/settings-groups/system.ts`
  - `src/server/render-pages.ts`
  - `src/server/render-settings.ts` (`capsPage`)
  - `src/monitoring-ui.ts`
  - `src/toolroll-update-ui.ts`
  - `src/integrations-ui.ts` (labels)
  - `src/needs-you.ts`, `src/browser-crew.ts` (point to `/settings/system#builder`; `/system` keeps a link)
- **Security:** read-only status. Registering and retiring workers is unchanged.
- **Tests:** update the existing no-worker link case; a journey step file.
- **Prerequisites:** S4, S9 (`render-settings.ts`).

### S13. Approvals and safety (wave 6)
- **User value:**
  - "How much runs without asking" is answered on one page.
  - One sentence says which setting wins.
  - `/mode` loses "touchpoints", "publication grant" and "my filings". Its options get short labels with the
    explanation on its own line.
  - The permission default, approval rules and policy handlers move to inline field errors.
- **Files:**
  - `src/settings-groups/safety.ts`
  - `src/approval-rules-ui.ts`
  - `src/policy-ui.ts`
  - `src/server/settings.ts`, in place: `modePage` copy, and the validation responses of `approvalSave`,
    `policySave` and `permissionDefaultSave`
- **Security:**
  - Full access still needs the password.
  - Signing a mode with chat approval stays a credential act, with its full terms visible.
  - The mode digest covers values, not labels. Check this and pin it.
- **Tests (HTTP):**
  - `/mode/sign` refuses without proof.
  - The same choices give the same digest.
  - A policy validation error returns 422 with the values kept.
- **Prerequisite:** S11 (`settings.ts`).

### S14. People and sign-in (wave 6)
- **User value:**
  - A people list (name, role, projects, last active, ⋯ menu). The first button is no longer a destructive one.
  - **Invite someone** opens a form whose link shows on its existing script-free page.
  - Role names "Can view" and "Can manage and approve". Installation-wide authority is stated separately where it is
    granted.
  - SSO warns when the address is loopback.
- **Files:**
  - `src/settings-groups/people.ts`
  - `src/server/render-people.ts`
  - `src/server/people-tokens.ts` (render data only)
  - `src/sso-ui.ts`
  - `src/serve.passwordless.test.ts`
- **Security:**
  - Inviting, widening access and SSO stay credential acts.
  - Role names change in the UI only; machine and CLI values stay the same.
- **Tests (HTTP):**
  - An invite without a typed password is refused under Passwordless.
  - A viewer still reaches their own People and Sessions information.
- **Prerequisites:** S3, S11 (`people-tokens.ts`).

### S15. Projects (wave 6)
- **User value:**
  - One row per project.
  - The project page shows the name with the path muted, and has one primary action.
  - Radio groups get legends.
- **Files:** `src/settings-groups/projects.ts`, `src/project-delete-ui.ts`, `src/check-levels-ui.ts`,
  `src/pull-request-ui.ts`. Rendering only; the handlers keep `sayTo` with anchors.
- **Security:**
  - Network, writes, check access and sandbox stay credential acts.
  - Widening check access still needs the password typed now by an operator.
  - Delete still needs the typed name and the password.
- **Tests:** the journey. No new routes.
- **Prerequisite:** S7.

### S16. "Before your first task" on `/chat` (wave 6)
- **User value:**
  - Someone who skipped steps sees only the open ones, as needs-you rows.
  - Each row has one verb that opens its constant `/setup/<id>`. Skipped rows offer Un-skip.
  - "Write your first task" stays locked until models and a builder are ready.
  - The checklist goes away after the first result.
- **Files:**
  - `src/first-run.ts` (the filter)
  - `src/browser/first-run.tsx`
  - `src/server/chat.ts` (`chatFirstRun` only)
  - `src/first-run.test.ts`
- **Security:** read-only. A skip never unlocks anything.
- **Tests:** a filter table:
  - done steps are hidden;
  - a skipped step still shows as open;
  - the task step stays locked until models and a builder are both done.
- **Prerequisite:** S11.

## 6. Verification plan

- **Every PR runs its own step files** from S1's journey, at 1440 and 390, with the real scroller. Unrolled shots are
  extra. It also checks:
  - a no-JS pass on each form it changed;
  - long errors;
  - keyboard focus;
  - that the sticky save doesn't overlap the focused control.

  It does not run every settings page on every small PR.
- **Focused HTTP cases that the generated suites don't reach:**
  - one-time POST responses (pairing code, invite link, token): script-free and `no-store`;
  - a first install, and who is eligible for landing;
  - a missing or foreign CSRF token on newly placed forms;
  - SSO one-use re-check vs Passwordless vs a typed credential, on at least one row of each proof kind;
  - repeated and expired previews (setup, models, mode);
  - skipped steps;
  - compatibility redirects, with parameters and notices kept.
- **Invariants that must stay true wherever a slice touches them:**
  - creating the first account happens all at once, with the five-try lockout;
  - the freshness allowlist stays at three routes;
  - tripwire pins;
  - `get-quiet` passes for every GET.

## 7. Running order

| Wave | Slices, run in parallel | Waits for |
|---|---|---|
| 0 | S1 stage 1 (harness interface) | #270 on main |
| 1 | S2 frame + kit · S3 first account · S4 first-run dead ends | S1 stage 1 |
| 2 | S5 tokens (once the colour doc lands) · S6 Spend | S2 |
| 3 | S7 hub + groups | S2, S6 (S5 optional) |
| 4 | S8 chat apps and alerts · S9 Agents and models · S10 General | S7 (S10 also S5) |
| 5 | S11 `/setup` · S12 System | S3, S4, S8 (S11); S4, S9 (S12) |
| 6 | S13 Safety · S14 People · S15 Projects · S16 checklist | S11 (S13, S14, S16); S7 (S15) |

Files that force an order:

| File | Order |
|---|---|
| `src/server/settings.ts` | S6 → S7 → S8 → S11 → S13 |
| `src/server/route-table.ts` | S7 → S11 |
| `src/server/render-settings.ts` | S7 → S9 → S12 |
| `src/browser/app.tsx` and `workspace.css` | S2 → S5 → S10 |
| `src/server/people-tokens.ts` | S3 → S11 → S14 |
| `src/telegram-settings.ts` | S8 → S11 |
| `src/first-run.ts` | S11 → S16 |
| `src/needs-you.ts` and `src/browser-crew.ts` | S4 → S12 |
| `src/accent-colors.ts` | S5 → S10 |
| `src/contracts/console-api.ts` | S2 → S7 → S11 |
| test `route-roles-http` | S7 → S11 |
| test `get-quiet` | S7 → S11 |
| test `serve.sidebar` | S2 → S10 |

If a slice finds it needs a file another slice in its wave owns, it waits. Never merge across PRs to get around it.

## 8. Owner decisions

| | Decision | Status | Outcome |
|---|---|---|---|
| D1 | Remembered password on settings saves | Settled | **Not in this arc** (Later). The dialog asks exactly what each action requires today. |
| D2 | The `up` password | Settled | **No web reveal.** `up` always prints the path and the `cat` command, and setup step 1 says the same in words. A one-use bootstrap capability is Later. |
| D3 | Where the leftover pages go | Recommended | **As in §3.** Knowledge and Learning go under Agents and models. Starter flows stay on Flows. Integrations stays a status page linked from System. `/mode` stays for signing, under Approvals and safety. |
| D4 | Telegram pairing links | Settled | **No code in any URL or QR.** Selectable text plus an "Open the bot" link. |
| D5 | Accent | Recommended | **Amber is fixed for needs-you.** The accent covers buttons and focus only: up to 6 presets plus hex, and saved custom colours keep working. Still to settle before S10: which ink actions stay themeable, because DESIGN.md says every act is ink. |
| D6 | Saving | Settled | **Save is local to each section.** No lock across sections, no batching. |
| D7 | Cents | Settled | **Display formatting only.** Storage, JSON and the budget input don't change. |
| D8 | Skipped steps | Settled | **A per-account record that only changes what is shown, can be undone, and never grants readiness.** Recommended storage is in S11. |
| D9 | Spend titles | Recommended | **"Spend" for the group, "Spend report" for `/spend`.** |
| D10 | Crew sheet on settings pages | Recommended | **Off.** No live state comes back to sensitive pages to make up for it. |
| D11 | Role names | Settled | **"Can view" and "Can manage and approve".** Installation authority is stated separately. Machine values don't change. |
| D12 | Ring and blur on outline buttons | Recommended | **Defer** to DESIGN.md. |
| D13 | `serve` and builders | Settled | **Link only.** No "no CLI after install" promise for `serve`, and `serve` doesn't start workers. |

## 9. Later (outside this arc)

- **A one-use bootstrap capability for the `up` password.** It expires, and it is bound to the newly generated
  credential, the account's generation and the intended local session. A POST with CSRF consumes it atomically. A GET
  neither reveals it nor consumes it. `up-login.txt` stays, because the CLI uses it. This is a separate security slice
  with a Codex review.
- **Remembered password for settings saves**, on a closed list of exact non-credential actions. It needs its own
  Codex review and pin updates.
- **One place for credentials:** the lead's `chat-key-*` file and the AI-provider keys, with precedence, migration and
  removal defined.
- **Scripted Copy on revealed secrets.** This changes the script-free secret page, so it's a separate security
  decision.
- **Endpoints that send a real test message** to chat apps, with ownership tests, and a Tailscale check-again endpoint.
- **Breaking up Integrations**, once each of its capabilities has a home.
- **Other:** `serve` starting a local builder; the outline-button shadow; the macOS app's setup; connected states
  checked against real services.

## 10. Review round 1 (Codex, on 7dd186c9: NO-GO, 12 findings)

| # | Finding | Checked in code | Outcome |
|---|---|---|---|
| 1 | The GET reveal exposes stored passwords and doesn't happen only once | `operate.ts` ~7405 stores a password the person chose; ~8000 prints the path only when the browser fails | **Closed.** Reveal dropped. `up` always prints the path and the `cat` command (S4), and step 1 says it in words. The bootstrap capability moves to Later. |
| 2 | The dialog's proof model doesn't match the code | `console-api.ts` uses `token` and `password`; quality and notifications are CSRF-only; Telegram's `token` is the bot credential; check access needs a password typed now | **Closed.** Proof inventory added (§4). The kit renders each action's existing contract, and handlers are never normalised. S18 removed. |
| 3 | Sensitive forms and revealed secrets need different rendering | `serve.ts` ~1580: `forceSensitive` gives a page with no script | **Closed.** Revealed secrets stay script-free with selectable text; scripted Copy is Later. Dialogs keep their field in the server HTML, so the SSO replacement still works. |
| 4 | The wizard's return flow is incomplete, and the prefix check can be escaped | Preview → approve at `settings.ts` ~1521–1554; push goes back to `/settings` (`chat.ts` ~553); `LOGIN_RETURN_PAGES` doesn't include `/setup` | **Closed.** Step ids map to constant paths. Every transition is listed with its file. The wizard continues only after success. The pairing secret stays on its page with a separate Continue. The login return list is updated on purpose. |
| 5 | Eligibility and skipping are underspecified | `homeRedirect` sends restricted users to `/work`; GETs default to `needsProject: true` | **Closed.** Eligibility is explicit. `needsProject: false` on the steps before a project exists. Creating the account can't be skipped. Skips are per account, change only what is shown, can be undone, and never grant readiness. The all-skipped destination is defined. |
| 6 | "Strictest role in the group" removes read access | The Models GET is open to anyone signed in; People and Sessions show a person their own data | **Closed.** Anyone who can read any part gets in, with server-side filtering. Actions keep their own roles. Tests run as operator, viewer, limited approver and token. |
| 7 | Fixed redirects lose Models parameters and notices | `/settings/models` reads `scope`, `preset`, `switch` and `to`; `sayTo` puts `?problem` after the `#` if the anchor is in the page string | **Closed.** Compatibility map added (§3). Kept parameters are checked by the page that owns them, anchors go through `sayTo`'s argument, and every hub anchor is mapped. |
| 8 | One 422 rule for everything conflicts with how approvals recover | `controlAct` consumes the nonce before checking the password | **Closed.** 422 only for field validation. Auth, conflict and rate-limit responses are kept. A stale nonce goes back through review. The dialog keeps the submitter and the hidden terms, Cancel posts nothing, and it works without JS. |
| 9 | Removing the Lead key form strands a separate credential store | `chat-key-<provider>` vs `keys.ts` `keyFileFor` | **Closed.** The Lead key controls stay intact, labelled as the lead's. Combining the stores is Later. |
| 10 | The Integrations split leaves things out | `integrations-ui.ts` groups; "Send test" is a connection check | **Closed.** Integrations stays a status page linked from System, with accurate labels. No new test-message endpoints. |
| 11 | The waves rely on incomplete file lists | `chat-settings-page.ts` is shared; S12's return work spans `console-api`, `http`, `control-ui`, `chat` and `serve` | **Closed.** S8 and S10 merged into one slice (now S8). The `/setup` file list is expanded. Each handler change has an owner: S6 for spend; S13 for permission, approval and policy; everything else keeps `sayTo`. S1's interface lands first. Shared test and contract files are in the ordering. |
| 12 | Verification misses the riskiest paths and over-tests | `post-forms-http` reads only GET pages; `get-quiet` pins pages that are about to redirect | **Closed.** §6 adds focused cases: one-time POST pages, first install, CSRF, SSO vs Passwordless vs credential, stale previews, skips, redirects. The real scroller comes first. Each PR runs only its own pages. `get-quiet` is edited on purpose in S7 and S11. |

Codex's views on D1–D13 are applied:
- D1 and D2 moved to Later.
- D6: Save is local to each section.
- D7: display only.
- D11: "Can manage and approve".
- D13: link only.
- D5: saved custom colours keep working.
