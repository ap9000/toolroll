# Settings revamp: build plan (UI revamp, Phase 3)

Status: plan, 2026-10-31. Nothing is built yet. This plan is built on `main` **after PR #270 (Models editor) merges**.
Every slice branches from that `main`.

Inputs: `docs/plans/settings-ui-audit.md` (the merged top 10), `evidence/ui-revamp/audit-{A,B,C,D}-*.md`,
`evidence/ui-revamp/SCOPE.md`, `evidence/ui-revamp/directions.md`, and the prototype `evidence/ui-revamp/directions.html`
(the screens to match are `directions/1-refined-*.png` and `1-guided-hub-*.png`). The evidence folder is gitignored, so
build agents get these files copied into their worktree, or a path to them.

**What the owner chose.** Direction 1, "Guided setup + grouped hub":
- A five-step `/setup`: Password → Project → Agent and models (Sized by job applied) → Phone (optional) → First task.
  Every step can be skipped, and the screen says what skipping costs.
- The Settings hub becomes an index of eight groups: General, Agents and models, Chat apps and alerts, Approvals and
  safety, Projects, People and sign-in, Spend, System. A "Needs you" block sits on top.
- Each group is a short page with a sticky save bar.
- One step-up password dialog per Save. It honours the 15-minute remember and Passwordless.
- One page per chat app: token → pair → test.

Added from Direction 3: a "Before your first task" checklist, filtered to the steps still open, for anyone who skipped
part of setup.

Also in scope: the accessibility and guideline fixes, the frame fixes, the Spend number fixes, one name per model, a
project picker that shows the open project, `/system`'s stale wording, showing the `up` password, and the `serve`-path
"no builder" dead end.

---

## 1. What the code says (read this before any slice)

These facts come from the source. They decide how the slices are cut and what a reviewer checks.

1. **The 15-minute remember covers three routes, and none of them is a settings save.** `route-table.ts` marks
   exactly `task.act.approve`, `chat.send` and `chat.proposal.confirm` as `freshness: "allowlist"`, and
   `src/password-freshness.test.ts` pins that list. Every settings Save today needs a password typed now, or
   Passwordless. So a dialog that skips the password on a remembered session would **widen** a proof. In this plan
   the dialog only *reflects* what the server already accepts. Making settings saves honour the remember is a
   separate, owner-gated security slice (S18, decision D1).
2. **Passwordless already covers the dialog's other case.** `proveAccountNow` (`src/scope.ts`) accepts an empty
   password when Passwordless is on and the request comes from this person's live browser session. Credential acts
   (`proveCredential`, the closed list in `docs/plans/passwordless.md`) always need a typed password. Examples are
   pairing a chat, inviting someone, SSO settings, a project's network, writes, check access or sandbox, and turning
   Passwordless on. `passwordlessSessionFor(store, by)` already tells a page which case applies.
3. **Sensitive pages are decided from the page as written.** `sendScreen` (`src/serve.ts` ~1441) treats a page as
   sensitive when it says so explicitly, or when its HTML holds a password field (`SENSITIVE_INPUT`). A sensitive page
   gets no live sidebar states, no summary room and no chrome forms (`chrome.ts` ~649). This is why the sidebar
   "drops rows" on pages with a password field. **A step-up dialog must keep its password field in the
   server-rendered HTML, or the page must set `sensitive: true`.** A field that a script adds in the browser would
   turn a password page into a non-sensitive one.
4. **Function positions are pinned.** `src/password-freshness.test.ts` pins where functions sit in `src/operate.ts`,
   `src/store.ts`, `src/server/tasks.ts` and `src/server/settings.ts`, for example
   `createSettingsHandlers@1>controlAct@73`. **New inner handlers go after the last inner function of
   `createSettingsHandlers`, and new logic goes in new modules.** Any new mention of `authenticateApprover`,
   `authenticateAccount`, `approveSetup`, `fresh` or the freshness facts changes a pinned count. That makes it a
   reviewed security change, so name it in the PR.
5. **Routes.** Each address is one row in `src/server/route-table.ts` with exactly one handler
   (`handler-registry.ts` fails startup otherwise). Domain factories register handlers with `handlersOf`, and new
   factories can live in their own module (as `createSweepHandlers` does). `route-roles-http.test.ts`,
   `route-policy-http.test.ts`, `get-quiet.test.ts` (every GET only reads) and `post-forms-http.test.ts` (every POST
   form carries the session's CSRF field) are generated from the table, so new rows are covered automatically. Each
   new row still needs its line in the compact role expectations.
6. **PR #270 already applies Sized by job.** On a new installation with nothing chosen, approving project setup
   (`control-setup.ts` `approveSetup`, via `POST /control/setup-approve`) applies `DEFAULT_PRESET` ("sized"). The
   setup wizard reuses that route. It does not add a second way to apply models.
7. **The hub is React; the other settings pages are server HTML.** `src/browser/views/settings-view.tsx` draws the
   hub from `BrowserSettingsView` (`src/contracts/console-api.ts`). Every other settings page is server HTML shown in
   the shell's `.so-native-region`. `render-settings.ts` `settingsPage` builds a no-JS twin of every hub card
   (permission, quality, keys, workers, updates, chat, messaging, push, digest, Telegram token). Group pages reuse
   those twins as server HTML.
8. **Known bug locations.**
   - Project picker: `src/browser/app.tsx` ~589 picks the current project only from `?project=`, `?repo=` or the focused task, never the session's open project.
   - Two h1s: `app.tsx` ~1004, plus the sr-only h1 at `settings-view.tsx` ~481.
   - 44px targets: `console.css` 268–270 beats `workspace.css` 373 on specificity.
   - Input contrast: `tokens.css` `--so-input-line` is #d4d4d4 (1.48:1).
   - "Connect a builder" links to its own page: `browser-crew.ts:29` points `start-worker` at `#run-status`.
   - Stale `/system` copy: `render-pages.ts:321`, "never by a browser click".
   - Cents dropped: `spend.ts` `usd()` drops cents at $10 and above. It is shared with `budget-alerts.ts`, `limits-ui.ts`, `tier-report.ts`, `evidence-pack.ts` and `store.ts`.
   - The `up` password: `operate.ts` `UP_LOGIN_FILE` writes it to `up-login.txt` with mode 0600 and never shows it.
   - Keyboard autosave: `settings-view.tsx` `AutoForm`, and `render-settings.ts` `SETTINGS_AUTOSAVE_SCRIPT`.
   - Telegram loop: `telegram-settings.ts:22`.
9. **Accent.** `--so-attention` is `var(--so-signal)`, and `accent-colors.ts` rewrites `--so-signal` from the accent
   cookie. So today the accent picker repaints "needs you". Ink acts (`--so-attention` on result buttons and counts)
   must stay ink. Needs-you therefore gets **new** tokens, not a re-pointed `--so-attention`.

## 2. Rules for every build agent

- Worktree off `main` (after #270), one slice each. Open a **non-draft PR; don't merge**. Don't write live state: no
  `:4180`, no `~/.config/standing-orders`, no real database. Build the fixture the way
  `evidence/ui-revamp/capture.mjs` does (temp HOME, temp DB, random 127.0.0.1 port).
- Read `AGENTS.md`. Run its UI simplicity pass on every page you touch. Run the **safety self-review** before committing
  anything that touches step-up, credentials, sessions, sensitivity, routes or approvals, and say in the PR how each
  item applies. Pass that review on to anyone you hand work to.
- Placement: new handlers in new modules, or at the end of `createSettingsHandlers`. Never insert a function above
  existing ones in `settings.ts`, `operate.ts`, `store.ts` or `tasks.ts`. Run `npx vitest run src/password-freshness.test.ts`
  on every slice that touches `src/server/`.
- Tests: only the kinds `docs/testing.md` keeps (security rules, contracts, data integrity). Route, auth and redirect
  contracts go through HTTP. No wording, markup or CSS unit tests, and no copy matrices. Run the affected test files
  only (`npx vitest run <files>`); GitHub CI and the release check run the full suite.
- UI evidence: run the settings journey (S1) at **1440 and 390**, with its a11y probes, and put the screenshots in
  `evidence/<slice>/`. Never commit images.
- Commit trailers exactly:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01U8qFAnWnZybhqHvofLBVL7
  ```
- **Old URLs keep working.** Every GET address that exists today either still renders, now under its group's
  breadcrumb, or redirects to its new home with the same redirect `/tasks → /work` uses. **POST endpoints don't
  move.** Forms move between pages, but they keep posting to the same routes with the same proofs. Only the
  page each handler returns to changes. CLI, chat and Telegram callers are unaffected.

## 3. Information architecture

| Group (hub card) | URL | Holds | Comes from |
|---|---|---|---|
| General | `/settings/general` | Appearance (theme; accent under "Customize accent", ≤6 presets + hex); this browser (chime, remembered password + Forget, moved out of the sidebar) | hub Appearance + Accent cards, sidebar chips |
| Agents and models | `/settings/agents` | Agent (builder + sign-in state + how it's paid: AI providers), **the Models editor from #270** (`#models`), then rows: Lead, Subagents, Tools, Skills, Knowledge, Learning | hub AI providers card, `/settings/models`, Agents tiles |
| Chat apps and alerts | `/settings/alerts` | Rows per chat app (Telegram, Slack, Discord, Teams) with state; what reaches you (chat messages, digest, screenshots, per-project mute); this device (push); email (closed, Google first); phone access (Tailscale) | hub Notifications + phone card + Email, Chat apps tiles, chat-app half of `/settings/integrations` |
| Approvals and safety | `/settings/safety` | Defaults for new tasks (unattended permissions, quality), who approves (approval rules + release approval), limits (policy), per project (operating mode summary → `/mode`, project sandbox/network → `/settings/project`), one sentence on which wins | hub Permission + Quality cards, Approval rules, Policy, `/mode` |
| Projects | `/settings/projects` | One row per project → Project settings, Checks, Pull requests, Tools for it; incoming webhooks (Integrations' webhook half) | Project tile, Projects-only links, Integrations |
| People and sign-in | `/settings/people` | People (list, invite), Sessions & tokens, Sign-in (SSO), Passwordless | `/people` (Workspace tools), Access tiles |
| Spend | `/settings/spend` (exists) | This month in one line, monthly limits (cents, at-risk marked), link to the report `/spend` | today's Spend limits page |
| System | `/settings/system` | Builders/workers (with **Start a builder**, `#builder`), Updates (one place), Backups, Storage, Retention, Data, Monitoring; rows to Fleet, Requirements, `/system` | hub Workers + Updates cards, System tiles, Workspace-tools Settings group |

Redirects and addresses that stay:
- `/settings/models` → `/settings/agents#models`.
- `/settings/checks` and `/settings/pull-requests` with no `?repo=` → the open project's page, else `/settings/projects`.
  Today they return 404.
- `/settings/integrations` → `/settings/alerts` (decision D3).
- `/people`, `/mode`, `/fleet`, `/caps`, `/system`, `/control` and every `/settings/<tile>` page stay where they are.
  Chat, the CLI, Telegram and old links point at them. Each now shows "Settings / <Group>" as its breadcrumb.
- The hub's old anchors (`/settings#telegram-token`, `#phone`) forward to the new page through a small hash map in
  the hub script.
- Workspace tools' separate "Settings" group (`chrome.ts` `settingsRows`) shrinks to the single Settings entry. Its
  rows (Fleet, Requirements, People, Operating mode, System) live inside groups.

## 4. Shared patterns (built once in S2, used by every later slice)

- **Settings frame.**
  - One `<h1>`, from the page. The shell header shows the section name as text: `app.tsx` already has the `pageOnly`
    branch for this.
  - A breadcrumb "Settings / Group" made of real links.
  - One content width token for every settings page, matching the prototype's 760px column.
  - The Single frame (no Crew sheet) on `/settings/*`, `/setup`, `/people`, `/mode`, `/control` and `/spend`.
- **Section.** A heading, a one-line state, then the form. No nested wells.
- **Sticky save bar.**
  - It reads "No changes", or "1 change", or "<what changed>", and has one ink **Save**.
  - Only one section on a page can be changed at a time. Editing a second one asks you to Save or Discard the first
    (decision D6).
  - Save submits that section's existing form to its existing route. Nothing is sent by `fetch`, nothing is batched,
    and no new endpoints are added.
- **Step-up dialog.**
  - It is a server-rendered `<dialog>` holding the same `password` field the handler reads today
    (`autocomplete="current-password"`, a visible label). On a phone it opens as a bottom sheet.
  - It shows the change before → after, where the page knows it. The Models preview already does this.
  - The server tells each form which proof it needs: `none` (Passwordless and not a credential act), `password`, or
    `password-credential`. The dialog only asks when needed.
  - Saving always posts to the server, which proves it again. A wrong guess in the browser can only lead to a
    refusal, never to a bypass.
  - Without JavaScript, the field shows inline, as it does today.
- **Field errors.**
  - On a refused Save, the handler re-renders the page with status 422 and no redirect.
  - Values are kept. Password and secret fields are never echoed back.
  - The message sits under the field (`id` + `aria-describedby`, `aria-invalid="true"`), and focus moves to that field.
  - `?problem=` links still render, for back-compat.
  - Toasts are for success only.
- **Secret inputs.** One helper for API keys, bot tokens, client secrets and SMTP passwords. Each gets
  `autocomplete="off"`, a name that doesn't read as "password", and the password-manager opt-outs (`data-1p-ignore`,
  `data-lpignore="true"`, `data-bwignore`, `data-form-type="other"`). Only the step-up field is `current-password`.
- **Choice groups.** A `fieldset` with a `legend`, each option's detail linked by `aria-describedby`, and **no
  autosave**. A choice goes to the save bar. Per-browser preferences (theme, accent, chime) may save in the background,
  as long as each announces "Saved" in an `aria-live="polite"` node and leaves focus where it was.
- **Repeated buttons name their object**, for example `aria-label="Manage Anthropic"`.

## 5. Slices

Each slice lists: what the user gets, the files, the routes, security notes, tests, what it depends on, and its wave.
Slices in the same wave can run at the same time; **no two slices in a wave touch the same file.**

### S1. Settings journey and capture harness (wave 1)
- **User value:** reviewers and the owner see every settings and setup page at 1440 and 390 on every PR. The
  accessibility rules get checked the same way each time, instead of by eye.
- **Files:**
  - New `scripts/settings-journey.mjs`, built from `capture.mjs`'s synthetic fixture.
  - New `scripts/settings-journey/*.mjs`, one step file per slice, so later slices add a file instead of editing a
    shared one.
  - Output goes to `evidence/` only.
- **What it does:**
  - Unrolls the inner scroller (`.so-main-column`) before full-length shots. This is the Phase 0 bug.
  - Captures each page at 1440 and 390.
  - Probes each page:
    - exactly one `h1`;
    - no sideways scroll;
    - every input, select, button and link in the main region is ≥44px tall at 390;
    - after a forced bad Save, the failing field has `aria-invalid="true"` and an `aria-describedby` target holding
      text;
    - pressing ArrowDown in a radio group sends no request;
    - secret inputs carry the opt-outs;
    - the sidebar's set of rows is the same on a sensitive page as on a normal one.
- **Security:** fixture only (temp HOME, temp database). It refuses to run if HOME or the DB path resolves to the real
  ones.
- **Tests:** the journey is the test. No unit tests.

### S2. One frame and the settings kit (wave 1)
- **User value:**
  - Every settings page has the same top bar, breadcrumb, single title and column width.
  - The sidebar no longer jumps between pages.
  - The project picker names the open project instead of "All projects".
  - Text fields and buttons on a phone are 44px tall.
  - Settings pages drop the unrelated Crew sheet.
  - The kit in §4 is ready for the slices that follow.
- **Files:**
  - `src/browser/app.tsx`: header h1 rule, project picker from the session's open project, sidebar slots on sensitive
    pages.
  - `src/browser/workspace.css`: width token, 44px specificity.
  - `src/server/console.css`: the input rule moves into `:where()`.
  - `src/server/chrome.ts`: crumbs on `Chrome`, Single frame for settings, inert sidebar placeholders on sensitive
    pages.
  - `src/contracts/console-api.ts`: `openProject` and `crumbs` on the workspace.
  - `src/serve.ts`: only `sendScreen` passing those two fields.
  - New `src/settings-kit.ts`: section, save bar, step-up dialog markup, field problem, secret input and fieldset
    helpers, plus the kit's CSS as an exported string (the way `MODELS_CSS` does it).
  - New `src/settings-kit-script.ts`: the enhancement script for the dialog and save bar.
- **Routes:** none.
- **Security:**
  - A sensitive page **keeps** its row *slots*, drawn as static, inert text: no live states, no summary room, no
    forms, no extra script. The R14 rule stands, and only the layout changes.
  - The kit's dialog renders its password field on the server, so `SENSITIVE_INPUT` still classes the page.
  - The kit never sets `value` on a password or secret input.
- **Tests:**
  - `serve.sidebar.test.ts`: one case added to its rule. A sensitive page has the same rows but no live states and no
    chrome forms.
  - `serve.chrome.test.ts`: the project picker's current value is the session's open project.
  - One contract case in a new `src/settings-kit.test.ts`: dialog and secret helpers never emit a `value` for
    password or secret fields, and the dialog's field name matches the handler's (`password`).
  - Journey probes.
- **Depends on:** #270 merged.

### S3. The first-account page (wave 1)
- **User value:** creating the first account (the `toolroll serve` path) states its rules up front and keeps what you
  typed when something's wrong. Errors sit beside the field and are announced. It says how many code attempts are
  left. It has a real title: "Create the first account".
- **Files:** `src/server/render-people.ts` (`signupPage`), `src/server/people-tokens.ts` (`signupSend`; edits inside
  the existing function only).
- **What changes:**
  - `<h1>Create the first account</h1>`, with the wordmark as a logo, and per-page `<title>`s for login, signup and
    errors.
  - `required`, `minlength="8"`, and the username `pattern` with hint text.
  - The username is kept on every error. The setup code is kept only when the error isn't about the code.
  - `role="alert"`, plus `aria-describedby` on the failing field.
  - Error copy in sentence case.
- **Security:**
  - The password is never echoed back. The attempt counter and lockout are unchanged.
  - The page stays sensitive and `no-store`.
  - `signupSend`'s position and its `authenticateAccount` mention are unchanged (tripwire).
- **Tests:** an HTTP case in the existing signup test. A wrong code returns 4xx with the username kept and the code
  field empty, and five tries still lock. `password-freshness.test.ts` must pass unchanged.

### S4. No dead end without a builder, and one name per model (wave 1)
- **User value:**
  - Under `toolroll serve`, a task with no builder says what to do and links to **Start a builder**, with the exact
    command and a Copy button. It no longer links back to itself.
  - `/system` no longer says models can't be changed in the browser. It links to Agents and models instead.
  - A model has one display name everywhere.
- **Files:**
  - `src/needs-you.ts` and `src/browser-crew.ts`: the `start-worker` action goes to `/system#builder` until the
    System group exists. S16 re-points it to `/settings/system#builder`.
  - `src/server/render-tasks.ts`: how the `start-worker` action renders.
  - `src/server/render-pages.ts`: the `/system` Agents copy, a `#builder` section with `toolroll up` and Copy, and model
    names.
  - New `src/model-names.ts`: `modelName(provider, id)` built on #270's catalog labels. Used here, then by S6, S11
    and S13.
- **Routes:** none.
- **Security:** read-only copy and links. The command shown is a constant, never built from input.
- **Tests:** add one case to `serve.workspace.slow.test.ts`'s existing "no-worker-registered" check: the action's
  target is the builder section, not the task's own page. One table test for `modelName` (contract: an id with no
  catalog row falls back to the id).

### S5. Needs-you colour and contrast tokens (wave 2; waits for `evidence/ui-revamp/needs-you-colour.md`)
- **User value:**
  - What waits on you is marked again: an amber outline plus a "Needs you" chip on Crew items, the sidebar chip, the
    hub's Needs you block and an at-risk spend limit.
  - Input borders and the off-state switch reach 3:1.
  - The accent picker can no longer repaint needs-you.
- **Files:**
  - `src/design/tokens.css`: `--so-needs-you`, `--so-needs-you-line`, `--so-needs-you-text` and
    `--so-needs-you-soft`, each in light, dark and `[data-theme]` blocks, with the values from the colour doc. Also a
    darker `--so-input-line` and a new `--so-switch-off`.
  - `DESIGN.md`: frontmatter colours, and a rule that needs-you is never themeable.
  - `src/browser/workspace.css`: only the needs-you selectors (`.so-needs-chip`, project-state needs-you, Crew rows)
    move to the new tokens. Ink verbs and counts stay on `--so-attention`.
  - `src/browser/components/ui/switch.tsx` and `form-controls.tsx`.
  - `src/accent-colors.ts`: the description changes to "Colour for buttons and focus. Things that need you are always
    amber", and the amber warning on the ink default is dropped.
- **Routes:** none.
- **Security:** none. These are CSS tokens.
- **Tests:** one table case in `src/accent-colors.test.ts`: for every accent preset, the needs-you tokens the page
  prints are unchanged. The journey probe computes the outline contrast (≥3:1) and the chip text contrast (≥4.5:1) on
  paper, in light and dark.
- **Depends on:** S2 (`workspace.css`) and the colour doc. Until S5 lands, later slices write
  `var(--so-needs-you, var(--so-warning))`, so nothing waits on it.

### S6. Spend you can trust, on the new save pattern (wave 2)
- **User value:**
  - Limits and totals show cents: "$12.57 of $13.00 · 96%". A zero reads as "$0", not "None", and empty KPI tiles
    are hidden.
  - A limit that will stop work at 90% or more is marked as needing you, in words as well as colour ("Near the
    limit"). An over-limit alert-only line says so in words.
  - `/spend` and `/settings/spend` have different titles.
  - The limits page loses its unrelated Models block, and model rows use one name.
  - This is the first page on the save bar, the step-up dialog and inline field errors: a bad amount keeps what you
    typed and points at the field.
- **Files:**
  - `src/spend.ts`: `usd()` shows cents whenever the amount isn't whole dollars (decision D7).
  - `src/spend-ui.ts`.
  - `src/server/settings.ts`: `spendSettingsPage` and `spendBudget`, edited in place, re-rendering with 422 on a
    refused form.
- **Routes:** none new. `POST /spend/budget` keeps its operator role and step-up.
- **Security:**
  - The budget write still proves the password, or Passwordless, inside the handler as today.
  - The 422 re-render echoes the amount and scope, never the password.
  - The page is sensitive, because the dialog's field is server-rendered.
- **Tests:**
  - HTTP: a bad amount returns 422 with the amount kept, `aria-invalid`, and no redirect.
  - A wrong password is refused with nothing written (one case in the existing spend route test).
  - `src/spend.test.ts`: one table case for `usd` (12.57 → "$12.57", 50 → "$50").
  - Callers in `budget-alerts.ts` and `limits-ui.ts` keep their tests.
- **Depends on:** S2. Can run beside S5.

### S7. The hub and the eight group pages (wave 3)
- **User value:**
  - Settings becomes a one-screen index, from about 4,000px down to roughly 1 screen at a desk and 2 on a phone.
    "Needs you" is at the top: no builder running, agent not signed in, models not set, a hard-stop limit at 90% or
    more, Telegram failing. Each item has one verb.
  - Below are eight group cards, each with a state sentence ("Claude, signed in · Sized by job").
  - Every inline hub card moves to its group page. People, Fleet, Requirements, Operating mode and System are found
    under Settings.
  - Viewers see only groups they can open. A refusal reads as a neutral notice, not a red error.
  - The Models editor (#270) lives on Agents and models.
  - Choice groups no longer save on arrow keys.
- **Files:**
  - `src/browser/views/settings-view.tsx`, rewritten as the index: Needs-you block plus group cards. Gone: the
    `AutoForm`, `AccentPicker`, Email, Providers, Notifications and Telegram token components.
  - `src/server/render-settings.ts`: the no-JS hub becomes an index. `SETTINGS_GROUPS` becomes the eight groups.
    `SETTINGS_AUTOSAVE_SCRIPT` is removed. The card twins are extracted into the group modules.
  - `src/server/settings.ts`: `settingsHome` slimmed; moved forms' handlers return to their group page (target
    strings only); `modelsPage` redirects; `checksPage` and `pullRequestsPage` redirect instead of returning 404;
    `integrationsPage` redirects (D3).
  - `src/server/route-table.ts`: 7 new GET rows (`/settings/{general,agents,alerts,safety,projects,people,system}`),
    with the same roles as the pages they gather (operator-only rows hidden for others).
  - New `src/server/settings-groups.ts`: `createSettingsGroupHandlers`.
  - New `src/settings-groups/{general,agents,alerts,safety,projects,people,spend,system}.ts`: one render module per
    group, so later polish slices each own one file.
  - New `src/settings-needs.ts`: facts → needs-you items.
  - `src/server/chrome.ts`: `settingsRows`, `SETTINGS_KEYS`, the neutral refusal tone at ~108.
  - `src/contracts/console-api.ts`: the hub view.
  - `src/serve.ts`: registering the new factory, one line.
  - `src/models-ui.ts`: an embeddable variant whose forms return to `/settings/agents#models`.
- **Routes:** the 7 GETs above. Redirects: `/settings/models`, `/settings/integrations`, and repo-less `/settings/checks`
  and `/settings/pull-requests`. No POST route changes.
- **Security:**
  - The group GETs only read (`get-quiet.test.ts`). Each declares the strictest role of what it shows, and shows
    owner-only sections only to operators. Admission still happens in the table.
  - Every moved form keeps its route, CSRF field and proof. Handlers change only their return target.
  - Group pages with a step-up form are sensitive.
  - `settings-needs.ts` reads facts and never acts.
  - Redirects use fixed targets, never a caller-supplied URL.
- **Tests:**
  - Route contracts over HTTP: each new row's roles in `route-roles-http.test.ts`. Each old URL lands on its new home
    with the right status. A viewer gets the neutral refusal on an operator group.
  - `get-quiet` and `post-forms-http` run as generated.
  - `src/settings-needs.test.ts`: one table covering which facts raise an item (the 90% hard-stop rule, alerts-only at
    96% doesn't, no builder, models unresolved). No wording.
  - Journey: hub and all eight groups at 1440 and 390, and keyboard through a choice group sends nothing until Save.
- **Depends on:** S2 and S6 (`settings.ts`). S5 if it has landed; otherwise it uses the fallback variable.

### S8. Telegram on one page: token → pair → test (wave 4)
- **User value:** connecting Telegram happens on one page, in three numbered steps.
  1. Create a bot. A link to `t.me/BotFather` and the exact `/newbot` words, then paste the token.
  2. Pair your phone. A Copy button for `/pair 123456` with an announced "Copied", plus an **Open the bot** link to
     `t.me/<bot>`.
  3. Send a test message.

  The hub, the alerts page and setup all link here. The loop back to the hub is gone.
- **Files:**
  - `src/telegram-settings.ts`: the three steps; it also exports the step renderer for `/setup`.
  - `src/server/settings.ts`: `telegramPage`, and `telegramTokenSave`, which returns to `/settings/telegram`. A new
    `telegramTest` handler goes at the end of `createSettingsHandlers`.
  - `src/server/route-table.ts`: `POST /settings/telegram/test` (approver, `limited: "self"`, act scope).
  - `src/telegram.ts`, if sending needs a helper.
- **Security:**
  - Pairing stays a **credential act**: a typed password, even under Passwordless. The dialog is told
    `password-credential`.
  - The token save keeps its step-up. The token is never echoed and uses the secret input.
  - **The pairing code never goes in a URL** (decision D4), so there is no `?start=<code>` link and no QR of the code.
  - The test sends only to the person's own paired chat, through the existing send path, and states the result.
- **Tests:**
  - HTTP: the test route refuses a viewer and someone else's pairing, and sends one message to the caller's own
    binding (fake bot).
  - `src/telegram-settings.test.ts`: one case that no rendered link contains the pairing code.
- **Depends on:** S7.

### S9. Agents and models, finished (wave 4)
- **User value:**
  - One page answers "which agent builds, how it's paid, which model does what".
  - Sign-in method words agree everywhere: "Your Claude plan" or "API key".
  - The lead's separate key form becomes a link to AI providers.
  - The lead name field renders properly.
  - Tools asks for the password *after* you pick a tool, and its secret fields stop inviting password managers.
- **Files:** `src/settings-groups/agents.ts`, `src/server/render-settings.ts` (`leadSettingsHtml`, `leadConfigForm`),
  `src/tools-ui.ts`, `src/models-ui.ts` (copy only).
- **Pre-check:** confirm the plan page shows the task size and the model. The sizing copy says "you see the size and
  model on the plan before you approve". If the plan page doesn't show them, change the copy, or file the plan-page
  change as a follow-up. Never ship the claim untrue.
- **Security:** the lead's own key path keeps its proof until it is removed. Removing it must not leave a stored key
  reachable: the existing key stays usable, readable only from AI providers.
- **Tests:** HTTP: the Tools connect form still refuses without proof. The journey covers the Agents page.
- **Depends on:** S7. Runs beside S8.

### S10. Chat apps and alerts, finished (wave 4)
- **User value:**
  - Slack, Discord and Teams follow the same token → pair → test layout as Telegram.
  - Email is one closed row, with Google first. The SMTP username stops pairing with a password field, so a password
    manager can't put your Toolroll password into it.
  - The Tailscale row gets **Check again**.
  - The Integrations page's duplicate chat-app list is gone.
- **Files:** `src/settings-groups/alerts.ts`, `src/slack-settings.ts`, `src/discord-settings.ts`,
  `src/teams-settings.ts`, `src/integrations-ui.ts`.
- **Security:** connect, pair and alerts stay credential acts. SMTP and Google secrets use the secret input. No route
  changes.
- **Tests:** the journey. One HTTP case: the email form's username field is not `autocomplete="username"`.
- **Depends on:** S7. Runs beside S8 and S9.

### S11. General (wave 4)
- **User value:**
  - Appearance in one place.
  - The accent becomes "Customize accent": up to 6 presets and a hex field. The rainbow plane and the 31 swatches go.
  - "Password remembered · 15 min [Forget]" and "Chime" move out of the sidebar into General, and into the account
    menu under your name.
- **Files:** `src/settings-groups/general.ts`, `src/accent-colors.ts` (preset list), `src/browser/app.tsx` (sidebar
  chips → account menu).
- **Security:** Forget keeps its route (`/session/forget-password`) and its effect. Theme and accent stay cookies.
- **Tests:** `serve.sidebar.test.ts`: one case saying the fresh chip is reachable from the account menu and Forget still
  ends the window.
- **Depends on:** S5 (`accent-colors.ts`), S7. Runs beside S8–S10.

### S12. Guided `/setup` (wave 5)
- **User value:**
  - A new owner goes from install to a first planned task in about 6 steps (the `up` path) or 8 (the `serve` path),
    down from 9–11 and 16–19.
  - No CLI command after install, except the provider's own sign-in.
  - "Sized by job" is applied.
  - The `up` password is shown once.
  - Every step can be skipped and says what skipping costs.
- **Routes:**
  - `GET /setup`, which redirects to the first open step.
  - `GET /setup/{password,project,agent,phone,task}`: approver; `limited: "deny"`; sensitive on `password` and `agent`.
  - `POST /setup/skip` (`step=`), cookie only, act scope. It records the skip and nothing else.
  - Writes reuse existing POSTs, each with `return=/setup/<next>`:
    - `/projects/open`;
    - `/control/setup-preview` then `/control/setup-approve` (builder + Sized by job, through #270's `approveSetup`);
    - `/settings/telegram-token` and `/settings/telegram/pair`;
    - push enrolment;
    - task creation.
- **The steps:**
  1. **Password.**
     - `serve` path: "Password set" is already done; it offers Passwordless as a link.
     - `up` path: it shows the generated password **once**, with Copy and a password-manager save prompt (a form with
       the username plus `autocomplete="new-password"`), and "I've saved it" to continue (decision D2).
  2. **Project.** Repos under the projects folder, with the current one preselected. GitHub and paste-a-link sit under
     a disclosure.
  3. **Agent and models.**
     - The builder is a radio list with the sign-in state beside each option, replacing the 9 ink buttons in
       `control-ui.ts`. The common three come first; the rest are under "Something else".
     - The models card shows Sized by job (recommended) or Opus for everything, with the size table.
     - "Use Sized by job and continue" is the existing preview, then approve.
     - If the provider can't take the preset, the step blocks and says why in plain words.
     - Not signed in: the exact command with Copy, and **Check again**, which is the existing
       `POST /settings/connection/check`.
     - No builder connected (`serve`): Start a builder (S4's section).
  4. **Phone (optional).** Telegram (S8's step renderer), or This device (push), or Skip.
  5. **First task.** `firstTaskSuggestions` plus a text box → **Plan it**, which lands on the task page.
- **Landing:**
  - `/` sends an approver to `/setup` while setup has open steps that weren't skipped and nothing has been filed yet.
    This is in `pages.ts` (home).
  - Signup already lands on `/`.
  - The `up` one-time link (`people-tokens.ts:345`) lands on `/` instead of `/chat`.
- **Files:**
  - New `src/server/setup.ts` (`createSetupHandlers`) and new `src/setup-ui.ts`.
  - `src/first-run.ts`: setup facts. The agent step is done only when the agent is signed in **and** a builder is
    connected; models resolved is its own fact.
  - `src/control-ui.ts`: builder radio list and shared model names.
  - `src/server/settings.ts`: `controlAct` honours a `return` limited to `/setup/*` through `safeReturn`, edited in
    place.
  - `src/server/route-table.ts`, `src/server/pages.ts` (home), `src/server/people-tokens.ts` (the once-link target).
  - `src/serve.ts`: registration.
- **Security:**
  - GET `/setup/*` only reads: no agent probes on GET, which reads the cached check, and no nonce minting. Approval
    nonces are minted only by the existing preview POST, which restates the terms.
  - Every write goes through its existing route with its existing proof. `/setup` adds no way to apply models or pick
    a builder.
  - `return` is accepted only for `/setup/...` paths (`safeReturn` plus a prefix check). Anything else falls back to
    the handler's own page.
  - **The `up` password reveal** reads `up-login.txt` on GET and shows it only if all of these hold:
    - the request is from this computer (`fromThisComputer`);
    - the session belongs to the account named in the file;
    - the file still verifies against that account's password hash (a stale file shows nothing);
    - the response is `no-store` and sensitive;
    - it is never logged and never in a URL.

    It shows nothing for a remote or SSO session. Reading a file on GET counts as a read under `get-quiet`; confirm the
    quiet-world harness allows it.
  - Step 3's "No password needed" line appears only when the server's own proof would accept an empty field:
    Passwordless now, or S18 if approved.
  - Skips record nothing security-relevant (decision D8).
- **Tests:**
  - HTTP:
    - `/` lands an approver on `/setup` on a fresh install and on `/chat` once a task exists;
    - the password reveal refuses a non-local request, another account, and a file whose password doesn't verify;
    - `return=https://…` and `return=/settings` are ignored;
    - completing step 3 through the wizard leaves the same models rows as `/control` does (one case in
      `serve.models.test.ts`).
  - `src/first-run.test.ts`: one case saying the agent step isn't done without a connected builder.
  - `password-freshness.test.ts` must pass. If `approveSetup` or a prover is mentioned anywhere new, the pin changes,
    and the PR names it.
  - Journey: the whole `serve`-path walk at 1440 and 390, plus a skip on every step.
- **Depends on:** S3 (`people-tokens.ts`), S4 (builder section, model names), S8 (Telegram step, `settings.ts`,
  `route-table.ts`).

### S13. Approvals and safety (wave 6)
- **User value:** "how much runs without asking" is answered on one page, in plain words.
  - Defaults come first, then who approves, then limits, then per project.
  - One sentence says which setting wins.
  - `/mode` loses "touchpoints", "publication grant" and "my filings", and its select options become short labels
    with the explanation on their own line, so nothing is cut off on a phone.
  - Two password fields per page become one dialog.
- **Files:** `src/settings-groups/safety.ts`, `src/approval-rules-ui.ts`, `src/policy-ui.ts`, `src/server/settings.ts`
  (`modePage` copy, in place).
- **Security:**
  - Full access as a permission default still needs the password; narrowing doesn't. That rule is unchanged.
  - Signing a mode with chat approval stays a credential act, and the signed terms stay fully visible before consent.
  - The mode's digest-bound fields are unchanged. Only labels change, and the digest covers values, not words: check
    this.
- **Tests:** HTTP: `/mode/sign` refuses without proof, and its digest is unchanged for the same choices. One case added
  to the existing mode test.
- **Depends on:** S12 (`settings.ts`).

### S14. People and sign-in (wave 6)
- **User value:**
  - A people list (name, role, projects, last active, a ⋯ menu), with no destructive button first.
  - **Invite someone** opens a dialog and shows the link with Copy after the password.
  - One set of role names everywhere: "Can view" and "Can approve".
  - SSO warns when the console's address is loopback.
- **Files:** `src/settings-groups/people.ts`, `src/server/render-people.ts`, `src/server/people-tokens.ts`
  (`peoplePage` render data only), `src/sso-ui.ts`.
- **Security:** invite, widen access and SSO stay credential acts. Remove and revoke keep their proofs. Role
  *names* change; role *values* and checks don't.
- **Tests:** HTTP: an invite without a typed password is refused even under Passwordless (one case in
  `serve.passwordless.test.ts`).
- **Depends on:** S3 and S12 (`people-tokens.ts`). Runs beside S13.

### S15. Projects (wave 6)
- **User value:**
  - One row per project, with Project settings, Checks, Pull requests and Tools.
  - The project page shows its name with the path muted, and has one primary action.
  - Radio groups get legends.
  - Incoming webhooks are listed here.
- **Files:** `src/settings-groups/projects.ts`, `src/project-delete-ui.ts`, `src/check-levels-ui.ts`,
  `src/pull-request-ui.ts`.
- **Security:** network, writes, check access and sandbox stay credential acts. Delete keeps typing the name plus the
  password.
- **Tests:** the journey. No new routes.
- **Depends on:** S7. Runs beside S13 and S14.

### S16. System (wave 5)
- **User value:**
  - One page shows builders (with Start a builder), the version and updates (one place, not two), last backup, disk
    use and retention.
  - Plain words replace "repair turns", "re-reserve" and "probed on the worker".
  - Monitoring placeholders say `toolroll`.
- **Files:**
  - `src/settings-groups/system.ts`.
  - `src/server/render-pages.ts`: `/system` and Fleet copy; the `#builder` section moves here, and `/system` keeps
    a link to it.
  - `src/server/render-settings.ts` (`capsPage`).
  - `src/monitoring-ui.ts`, `src/toolroll-update-ui.ts`.
  - `src/needs-you.ts` and `src/browser-crew.ts`, re-pointed to `/settings/system#builder`.
- **Security:** read-only status. Register and retire a worker are unchanged (credential act).
- **Tests:** the journey, and one link-target case in the existing no-worker check.
- **Depends on:** S4, and S9 (`render-settings.ts`).

### S17. "Before your first task" on `/chat` (wave 6)
- **User value:** someone who skipped part of setup sees only the steps still open, as needs-you rows, each with one
  verb that opens its `/setup` step. "Write your first task" waits until models and a builder are ready. It retires
  after the first result, as today.
- **Files:** `src/first-run.ts` (filter), `src/browser/first-run.tsx`, `src/server/chat.ts` (`chatFirstRun`).
- **Security:** read-only. `chat.ts` carries freshness pins, so edit inside `chatFirstRun` only.
- **Tests:** `src/first-run.test.ts`: one table case for the filter (done steps hidden; task step locked until models
  and builder are both done).
- **Depends on:** S12. Runs beside S13–S16.

### S18. Remembered password for settings saves (wave 7, only if the owner says yes to D1)
- **User value:** within 15 minutes of typing your password on this computer, a settings Save stops asking again,
  including setup step 3's "you set it 2 minutes ago".
- **Files:**
  - `src/server/route-table.ts`: `freshness: "allowlist"` on a closed list of **non-credential, non-widening** settings
    saves. Proposed list: models apply, spend budget, quality default, notification settings, retention, backups.
  - Each listed handler wraps its proof in `withFreshness(...)`.
  - `src/password-freshness.test.ts`: new pins.
- **Security:** this widens what a remembered session can do, so it needs Codex review before merge.
  - Excluded: credential acts, Full access, anything that widens a grant or an approval scope, and Passwordless
    itself.
  - Only on direct local requests, with the same window, the same Forget, and the check made at the moment of the act
    (the existing `freshnessFor` rules).
- **Tests:** the existing freshness table gains one row per new route (allowed when local and fresh; refused when
  remote, stale, after Forget, or for another person), and the allowlist pin is updated.

## 6. Running order

| Wave | Slices, run in parallel | Waits for |
|---|---|---|
| 1 | S1 harness · S2 frame + kit · S3 first account · S4 builder dead end + model names | #270 on main |
| 2 | S5 tokens (once the colour doc lands) · S6 Spend | S2 |
| 3 | S7 hub + groups | S2, S6 (S5 optional) |
| 4 | S8 Telegram · S9 Agents and models · S10 Chat apps and alerts · S11 General | S7 (S11 also S5) |
| 5 | S12 `/setup` · S16 System | S8 (S12); S4, S9 (S16) |
| 6 | S13 Safety · S14 People · S15 Projects · S17 checklist | S12 (S13, S14, S17); S7 (S15) |
| 7 | S18 remembered password (owner-gated) | S12, S13 |

S16 sits in wave 5 because it needs only S4 and S9, and it shares no file with S12. Within each wave I checked that
the file lists don't overlap. The files that force an order are `src/server/settings.ts` (S6 → S7 → S8 → S12 → S13),
`src/server/route-table.ts` (S7 → S8 → S12 → S18), `src/server/render-settings.ts` (S7 → S9 → S16), `app.tsx` and
`workspace.css` (S2 → S5 → S11), and `people-tokens.ts` (S3 → S12 → S14). If two slices in a wave turn out to need
the same file, the later one waits. Don't resolve it with a cross-PR merge.

## 7. Owner decisions (recommendations in bold)

- **D1. Remembered password on settings saves.** Today the 15-minute remember covers only approving a plan and chat.
  The dialog can honour Passwordless without changing any proof, but honouring the remember on settings saves
  extends a proof. **Ship the dialog without it (S2 onwards), and decide S18 separately: yes for a closed
  non-credential list, after a Codex review.**
- **D2. The `up` password.** **Show it once in `/setup` step 1, with the local-only, own-account, still-valid rules in
  S12.** Other options are printing it in the terminal (it was kept out of scrollback on purpose) or leaving it in the
  file. Letting the person choose a new password without typing the old one would turn the one-time link into a
  credential act, so that one is off the table.
- **D3. Where the stragglers live.** **As in §3: Knowledge and Learning under Agents and models; starter flows stay
  on the Flows page with no Settings tile; Integrations splits (chat apps → Chat apps and alerts, webhooks → Projects)
  and `/settings/integrations` redirects; Operating mode under Approvals and safety, keeping `/mode` for the signing
  ceremony.**
- **D4. Telegram one-tap pairing.** A `t.me/<bot>?start=<code>` link or a QR code would put the pairing code (a
  credential) in a URL. **No: Copy the `/pair` code, plus an "Open the bot" link without the code.**
- **D5. Accent.** **Amber is fixed for needs-you and isn't themeable. The accent changes only buttons and focus, with
  up to 6 presets and a hex field under General → Appearance.** The other option is removing the picker.
- **D6. Save bar scope.** **One section at a time per page, each saved to its own route with its own proof.** A
  multi-section batch (Direction 2's idea) would need a new combined endpoint and a combined proof.
- **D7. Cents.** **Change `usd()` everywhere: cents whenever the amount isn't whole dollars ($12.57, $50).** This also
  fixes budget alert texts that say "$13 of $13". The alternative is cents on Spend pages only.
- **D8. Remembering skipped setup steps.** **Work out "done" from live facts. Store only "skipped" per account in the
  existing instance settings ledger if a new key needs no migration, and fall back to a cookie otherwise. `/` opens
  `/setup` only until the first task is filed.**
- **D9. Spend titles.** **`/settings/spend` is "Spend" (the group: this month plus limits). `/spend` becomes "Spend
  report".**
- **D10. Crew sheet on settings pages.** **Off (DESIGN.md's Single frame). The sidebar count still carries
  needs-you.**
- **D11. Role names.** **"Can view" and "Can approve" everywhere, replacing viewer/operator/approves/watches/instance
  operator in the UI. Role values in the database don't change.**
- **D12. Outline-button ring and blur shadow** (audit C M2, a DESIGN.md "Hairline first" choice). **Leave it out of
  this arc.** It is a design-system change, and DESIGN.md should decide it, not a settings slice.
- **D13. `serve` and builders.** **Link to Start a builder now (S4).** Having `serve` start a local builder by itself
  is a separate arc.

## 8. Not in this plan

- The macOS desktop app's setup.
- Terminal `up` and `demo` output, beyond D2.
- Connected states that need real tokens or outside services. Their pages follow the same pattern, but nothing here
  checks them against a real service.
- The plan-page tier display, beyond S9's pre-check.
- `/settings/slack/manifest` (a download).
