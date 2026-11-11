# Home shows releases, flow decisions and setup

Status: plan v2 (Codex plan review round 1: GO WITH CHANGES, six findings folded in below under "v2 changes"). Alex asked (2026-11-11): "I wanna have home show flow release and setup stuff."

## Today

Home (`src/server/home.ts` `homeView`, `src/browser/views/home-view.tsx`) lists only tasks that need the person, read
from the work index (`needs-you` view), grouped Approve a plan / Answer a question / Something went wrong / Review
results / Needs you. Three other kinds of thing wait on a person and Home does not say so:

- **Releases.** A release is a built-in task (`release-<ver>-<sha7>`, `releaseTaskOf` in `src/release-approval.ts`),
  so while unapproved it already shows on Home as an ordinary row under "Approve a plan", and selecting it offers
  Home's one-press plan approval (`home-approval.tsx`). Its own page is the release sheet `/t/<id>/release`
  (`task.release`), which shows CI, the refusals (`refusalOf`), and approves with `sheet=release`. A held automatic
  publication (`autoPublishHeld`, `src/release-auto.ts`) waits on a person at `/t/<id>/release/go-on` (password typed
  now). Neither is named as a release on Home.
- **Flow decisions.** A card in an approval zone waits on its decider (`deciderOf`, `src/flows.ts`; the person rule is
  `canDecide` in `src/flows-ui.ts`); a card in a choose zone waits on one person (`flowChoiceAt(...).person`); a card's
  subagent can ask one person a question (`openSubagentQuestionOn(...).askedOf`). These are only on `/flows` and
  `/flows/<id>`, and the flows list and sidebar count every such card without checking who decides.
- **Setup.** The first-run steps (`firstRunStepsNow` + `withBuilderStep`, `src/first-run.ts`) are on `/welcome`; Home
  carries only `setup: "/welcome"`. An agent that signed out (`signInNotices`, `src/provider-auth.ts`) is a chrome
  banner. Per-task setup needs (sign in, connect/start a builder, choose a project, storage hold) are already task rows.

## What changes

Home's list gains three groups, each with its exact count, in this order:

1. **Approve a release** (new) — 2. Approve a plan — 3. Answer a question — 4. **Flow decisions** (new) —
5. Something went wrong — 6. Review results — 7. **Finish setting up** (new) — 8. Needs you.

The sentence at the top counts tasks as today and names the rest: "3 tasks need you", "3 tasks and 2 other things need
you", "2 things need you" (no task). The menu's Tasks count stays a task count, so it keeps agreeing with the Tasks
list it opens.

### 1. Approve a release

- Rows: every needs-you task row whose active task `releaseTaskOf` recognises (sealed state only, never the title or
  id), moved out of "Approve a plan" into this group; plus every visible release task whose publication is held
  (`autoPublishHeld` non-null), worded "Publication waits for you".
- Counts: a dedicated read, not the 30 listed rows: release tasks in view (same `WorkSummaryAccess` repos) with an
  unapproved release scope or a held publication. "Approve a plan"'s count is the work index's figure minus the
  releases in it, so the two never count the same task.
- Line: the version and project, and the sheet's refusal when there is one (CI failed, check failed, terms changed,
  put away), so a release that can't take a yes says why.
- Act: **never approved on Home.** The row's one action is "Review the release" → `/t/<id>/release` (the sheet keeps
  its password / remembered-approval rule and its digest). Selecting the row shows the line and that link, not the
  plan approval pane. This also closes today's path where a release row offered Home's one-press plan approval.
- Who: approvers only (the sheet mints its nonce only for approvers). For anyone else a release stays an ordinary
  task row as today.

### 4. Flow decisions

- Rows: active cards, in flows of projects this person can see (`access.repos`, `accountCanAccess`), that wait on
  **this person**: approval zone where the existing `canDecide` rule holds; choose zone where the choice waits on them;
  a card subagent's open question asked of them. Nothing else (cards whose waiting text asks "someone" stay on the
  flow page for now).
- One rule: `canDecide` and the choose/question checks move into one exported function (`flowCardWaitsOn(store, flow,
  card, viewer)` in `src/flows-ui.ts`) that both `flowView` and Home call, so the flow page and Home can never
  disagree.
- Line: the card's `waiting` words; project; age from the card's entry into the zone.
- Act: "Decide" / "Choose" / "Answer" → `/flows/<id>?card=<card>` (the flow page's own forms, CSRF, and the
  `decideFlowCard` / `chooseFlowCard` decider checks). Nothing is decided on Home in this build.

### 7. Finish setting up

- Rows: each first-run step not yet done (`firstRunStepsNow` + `withBuilderStep`; null for a restricted console, the
  demo, or after a first success), with the step's own action; and each agent sign-in pause (`signInNotices`) with
  "Sign in again" → its resume page. Approvers only; sign-in pauses for an instance operator only (they are
  instance-wide).
- Per-task setup needs stay task rows (no duplicates). App updates stay in the menu's update line.
- Home's redirect to `/chat` on a first run with no work stays.

### Shape

- `BrowserHomeAsk` gains `release | flow | setup`. Rows keep `BrowserHomeRow`; a non-task row's `href` is its own page
  and `id` is namespaced (`release:<taskId>`, `flow:<cardId>`, `setup:<key>`) so selection and the "gone" set never
  collide with task ids. The open pane for these three shows the line and the one link (no in-place act).
- Phone: the "next" card is the first row in group order, whatever its kind.
- Reads: one new module `src/server/home-asks.ts` (`releaseAsks`, `flowAsks`, `setupAsks`), called from
  `homeRedirect` in `src/server/pages.ts` and passed to `homeView` as facts; `homeView` stays a pure assembler.
- Live: Home re-reads on the live room's change events today; the build checks that a flow card move, a release
  approval and a sign-in pause bump what Home listens to, and adds the missing ones.

## Safety self-review (AGENTS.md)

- **Check and write together:** Home writes nothing new; every act stays on its own route with its own checks.
- **Never widen implicitly:** reads are filtered by the same repos and account access as the pages they link to; a
  person sees a flow card on Home only when that flow page would let them decide it.
- **Grant files, not folders:** no new routes or permissions.
- **Input does not choose what is trusted:** a release is recognised from its sealed scope (`releaseTaskOf`), a
  decider from the flow definition; no title, id or card text decides anything.
- **Approvals:** fewer approval paths, not more — the release row loses Home's one-press approve; nothing new is
  approved on Home.
- **Credentials:** none touched; Home still has no password field.
- **Tests never touch the person's real setup:** fixture stores and throwaway consoles only.
- **Prove it against the real thing:** a scripted journey files a release-shaped task and a flow with an approval
  zone, opens Home, sees both groups with the right counts, follows each link to its own page.

## Tests

- `home.test.ts`: group order; counts exact past 30 rows; a release never counted twice; a release row has no plan
  approval; refusal words; non-approver sees a release as a task row.
- `home-asks.test.ts`: flow rows only for the decider (named decider, owner-decides, any-approver, subagent deciding →
  none, choose zone person, question asked of someone else → none); project access filter; setup rows null when
  restricted/demo/after first success; sign-in pauses only for an operator.
- `flows-ui` test: `flowView.canDecide` unchanged after the extraction (same table of cases).
- `home-view` test: new groups render, the open pane shows one link, ids namespaced.
- Scripted journey as above.

## v2 changes (Codex plan review round 1)

0. **Part 0 lands first, on its own branch: a release is approved only under the release rules, whatever the caller
   sends.** Today the plain approve POST (`tasks.ts` ~2258) picks the release wrapper from the submitted `sheet=release`
   field; without it, `approveScope` seals a release while the sheet would refuse it (CI recorded failed with no hold,
   release check failed on this commit, terms changed after an earlier approval). Local-owner approval and the CI hold
   are already refused inside the core (`scope.ts` ~1560/1606). Fix: the shared approval core (`scope.ts`, beside the
   existing `releaseSealProblem` / `releaseCiHoldOf` checks) refuses a release scope for every reason `refusalOf`
   (`release-approval.ts`) gives, so the web form, Home, `toolroll task approve` and the sheet all get the same
   refusals. One source for the reasons (no copied list). Tests: each refusal through the plain web POST, through
   Home's in-place POST, and through the CLI path; the sheet unchanged.
1. **Releases (finding 2):** classified in the shared work-index projection, not subtracted afterwards. A needs-you
   family whose ask would be `approve` and whose active task is a release (the same sealed-state rule as
   `releaseTaskOf`) gets ask group `release`, so rows and every count come from one read. A failed release stays in
   Something went wrong; a release result stays in Review results. A held publication (`autoPublishHeld`) is one row
   per family in Approve a release, counted only when that family is not already a needs-you row elsewhere; the
   headline's "other things" counts it.
2. **Sign-in pauses (finding 3):** not a Home row. The sign-in banner (command + Resume form) already shows on every
   page, Home included; a second copy would only repeat it.
3. **Flows (findings 4, 5):** the row means "this card waits on you", never "you may press Decide here". Its one action
   is "Open the card" → `/flows/<id>?card=<card>`; the flow page shows what this session may do (a local-owner session is
   told to sign in there, as today). Approver standing is required on every branch. The extracted rule
   (`flowCardWaitsOn`) covers: approval zone (`canDecide` rule), choose zone person, a card subagent's open question or
   tool-call request asked of you, a browser permission wait (`browserWait`, with its own eligibility), and a reply
   wait that timed out and asks the card owner (or flow owner) to move it on.
4. **Setup (finding 6):** a step that is done or only being checked (`checking: true`, no action) is not a row. The
   builder step is not shown when a needs-you task row already waits for a builder (`connect-builder` /
   `start-builder`); those task rows stay task rows.
5. **Answers:** the Tasks count in the menu stays tasks only (Codex agreed). Live refresh is already wired: `flow_card`,
   `task_scope` and `provider_auth_pause` writes bump the workspace revision Home listens to.

## Open questions (v1, answered in v2 changes)

1. Is moving release rows out of "Approve a plan" (and subtracting them from its count) sound, or should the work
   index itself learn a `release` ask group so every count comes from one read?
2. Today a release task row on Home offers the one-press plan approval (`home-approval.tsx`) while the release sheet
   refuses the local-owner session. Is that an existing hole (a release approved without the sheet's rules), and should
   the fix land on its own first?
3. The sentence counts "other things" while the menu count stays tasks only. Acceptable, or should the menu badge
   include them?
4. Is `canDecide` + choose + subagent question the complete set of "this card waits on this person"?
