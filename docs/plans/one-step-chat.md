# One-step start from chat, and a three-state Home

Status: plan v2, 2026-11-09 (one Codex round: GO WITH CHANGES, ledger at the end; the owner decided a typed yes
counts). Two branches from main after #328 and #329: `one-step-chat` (C1-C5) and `home-three-groups` (H1-H2). Line
numbers below were read at d8019ced; the builder refreshes them after rebasing.

## Goal

A person with authority asks for a small change in any chat (web chat, Telegram, Slack, Discord, Teams) and starts it
with one Start button, under exactly the fast start rules the New task form has today. On Telegram they can also
reply yes to the card. Home groups work the way a
person thinks about it: **Waiting on you**, **Working**, **Done**, each row with its next action in place. Nothing
fast start allows today gets wider, and nothing Home shows today disappears.

## How it works today

**Chat, message to running work** (four person actions: message, Confirm, Approve, Accept):
1. The lead drafts the task: `propose_task` (`src/lead-tools.ts:1697`) validates text and secrets and calls
   `ctx.draft("task", …)`. Drafts go `pending` when the turn answers (`store.ts:20901`, from `lead.ts:749`) and also
   when a timed-out turn is finalized (`lead.ts:475`).
2. The card shows "New task · file task" (`src/server/render-chat.ts:727`). Its Confirm runs `confirmLeadProposal`
   (`src/lead-doors.ts:190`) from web chat (`src/server/chat.ts:770`), Telegram (`src/telegram-lead.ts:335`), Slack,
   Discord and Teams (`src/chat-delivery.ts:862`) or `toolroll chat` (`src/lead-cli.ts:375`). Gates: approver
   re-proved, thread is theirs, chat on and no live turn (`proposalActGate`, `lead-doors.ts:173`), project access
   unchanged, turn answered, single-use CAS `pending → confirming` (`lead-doors.ts:231`).
3. `executeProposal` kind `task` (`lead-doors.ts:343`) files it with `fileTaskProposal`, `filedVia: "mate"`, and says
   "filed X — review and approve its scope to start work" (`lead-doors.ts:375`). Nothing is approved.
4. Approval is a second card: the lead's `offer_approval` (`lead-tools.ts:747`) or the planner's plan-ready notice
   (`claim.ts:1514`) sends "Approve & start" (`planInChat`, `src/chat-decide.ts:107`), which asks twice and then calls
   `approve(…, chat)` (`chat-decide.ts:898`). Or `scope_approve` (`src/chat-actions.ts:993`, executed at `:1488`).
   Every chat approval goes through `approvalBy` (`chat-actions.ts:1635`): the person's own chat setting and limits;
   `toolroll chat` is refused there ("Approve this in chat or in Toolroll").
5. `approve()` (`src/scope.ts:1521`) re-checks in one transaction: no machine (`:1547`), approver role and project
   access, the digest seen, the card's shown words (`cardShowsScope`, `:1574`), policy, release, CI hold, the gate,
   then seals with basis `chat` and writes the `approval proved` row. Dispatch reads `authorityStandsSql`
   (`src/approval-authority.ts:25`).
6. Accept is a third card (`result_accept`, `chat-actions.ts:1508`).

Chat already files and approves in one tap for a sweep of 2-20 tasks (`sweep_file`, `chat-actions.ts:668`, executed
by `fileSweep` at `:1648`), with a rolled-back dry run so the card shows every word (`sweepChildScopes`, `:1614`).

**Why fast start is closed to chat** (`src/fast-start.ts`):
- `FastVia` is `"console" | "terminal-ui" | "cli"` (`:42`) and the preview row must match the surface (`:198`).
- `machineActing()` (`scope.ts:1915`) refuses at `:96`, `:159`, `:192`. The lead's tools run as the lead, so the
  lead can't even preview one.
- The web routes take a cookie only (`src/server/tasks.ts:891`, `:2988`).
- The password rule (`:123-124`) reads console freshness, which chat doesn't have.
- The dispatch guard: `fastStartStandsSql` (`approval-authority.ts:45-48`) requires basis `password` for any task with
  `fast_start_until`. A chat seal on a fast-marked task never dispatches; `src/fast-start.test.ts:210` proves it.
- The decision: `docs/plans/plain-toolroll.md` P2.4 lists "each chat bridge" as a must-refuse caller and calls chat's
  one-tap Approve "a named and deliberate difference". This arc reverses that at the owner's request.

**What chat apps store today** (one set of tables for Telegram, Slack, Discord and Teams, `src/chat-messages.ts`):
an inbound message is a `chat_event` row (`kind = 'message'`, `ts` = the app's message id, `thread` = the message it
replies to, saved once per app update id); what Toolroll sends is `chat_part` rows (`state`, `message` = the sent
message id, `uncertain`); a card's buttons are `chat_action` rows bound to the part and the proposal. Telegram's
ingress already drops forwarded messages, messages sent through another bot, channel posts and captions before a
message is queued for the lead (`src/telegram.ts:1631`, `:1716`, `:1868`, `:1981`), and a tapped question option is
queued as text by a different path (`:2349`). On the owner's own Telegram chat, message ids run one after another
across both directions (read-only check of the live record: a reply to message 2771 is 2772, the next message typed
is 2773).

**Home today** (`/`, `src/server/route-table.ts:357`, handler `homeRedirect` in `src/server/pages.ts:207`):
- `homeView` (`src/server/home.ts:81`) reads the work index three times: `needs-you` (30 rows), `running` (8),
  `queued` (8, only rows whose label is "Waiting").
- Groups: Decide, Review, Unblock (`ASK_LABEL`, `src/needs-you.ts:99`; unnamed asks go under Decide, `home.ts:107`),
  then Running, then Waiting (Toolroll waits, nobody is asked). Counts: Needs you, Running, Queued, Finished
  (`home.ts:94-99`), each linking to the Tasks filter it equals (`src/serve.home.test.ts:86`).
- Rendered by `HomeView` (`src/browser/views/home-view.tsx:100`): list, selected row open beside it (`OpenPane`,
  `:63`), an agent's question answered in place (`Question`, `:30`), the lead's box. Phone and the installed app use
  the same component (`isPhone`); the dock holds New task. Types: `BrowserHomeView` (`src/browser-workspace.ts:825`).
- The chat page's own home already says "Working now · Waiting on you · Ready to review · Done this week"
  (`chatHomeOf`, `src/server/chat.ts:1407-1426`).
- Terminal: `toolroll status` prints Tasks, Building, Queued, Ready for review (`renderInstallationStatus`,
  `src/lead-status.ts:312`). The terminal UI lists rows with a status word and a "needs you" line
  (`src/tui/app.tsx:254`, `:357`; rows from `src/tui-source.ts`). Chat `/status` groups "Needs attention / Working /
  Waiting / next up / Finished" (`phoneStatus`, `src/telegram-status.ts:81`, `:119`).

## Slices

### C1 — Fast start gains a chat surface (`src/fast-start.ts`, `src/approval-authority.ts`, `src/plain-schema.ts`)

- `FastVia` adds `"chat"`. `fileIt` files a chat start with `filedVia: "chat"` and `proposedVia: "mate"`: the lead
  wrote the words, so the text stays quarantined (`scope.ts:1983`).
- Split `fastStartEligible` into `fastStartRules` (every check from `:97` to `:128`, unchanged, including the
  escalated and check-access exclusions at `:120`) and the existing wrapper that adds the machine check. Only the
  person-proof step gets a second form: `{ password: PasswordFacts }` (today's rule) or
  `{ chat: ChatApprovalLimits }`, which passes only when `chatLimitProblem(scope, limits, …)` is null.
- The honest difference between the two forms: the chat form doesn't run `approvalPasswordField` (chat has no
  password), so the remembered-password check for quarantined text doesn't apply. What stands in its place is the rule
  chat approvals already have: quarantined text is approvable in chat only when the card showed every term whole
  (`store.ts:9519`). C2 requires that. `prepareFastStart`'s refusal for a project whose mode auto-approves filings
  (`:163`) applies to the chat form too.
- New at the end: `prepareChatStart(store, { actor, repo, title, turn }, now)`: classify with `filingSizer()` within
  its budget, dry-run the filing, read `fastStartRules`, and on success write a `fast_preview` row with
  `via = 'chat'` and the lead turn it was prepared in. It doesn't refuse a machine caller: a preview grants nothing,
  and `fastStartBuild` still refuses one (`:192`).
- `fast_preview` gains a nullable `turn` column (next schema version; main is 158). A chat preview without a turn is
  unusable. C2 checks the preview's turn is the proposal's turn; dismissing a Start card consumes its preview.
- `fastStartStandsSql`: keep the `password` arm; add a second arm: basis `chat` stands only when there is ONE
  `approval proved` row that matches all of: this task, the seal's approver, the seal's instant, the approved digest,
  outcome `chat`, and a detail that is valid JSON (`json_valid` before any `json_extract`) with
  `$.fastStart.rule = 'small-v1'`, `$.at` the seal's instant and `$.digest` the approved digest. Window, machine-seal
  and person-seal clauses apply to both arms.
- Rollback that doesn't depend on the caller: `store.transact` runs a nested body in place (`store.ts:8367`), and
  `fastStartBuild` catches its own refusal, so called inside another transaction today it would return "refused" with
  the filing still written. Its body moves into `store.savepoint` inside the `transact`, and `dryRun` gets the same
  savepoint, so both undo their writes at any nesting depth.
- Tests (`src/fast-start.test.ts`): a chat start with its proof dispatches inside the window and not after 30
  minutes; `:210` becomes "a `chat` basis written without a chat fast-start proof doesn't dispatch" (forged UPDATE);
  the new arm refuses a proof row with another digest, another actor, another instant, the facts split across two
  rows, and a detail that isn't JSON; a password-basis fast start still dispatches as today; a chat preview can't be
  built as `console` and a console preview can't be built as `chat`; `fastStartBuild` as the lead or a remote run is
  refused; the person's chat limit refuses; a refused build called inside an open transaction leaves no task, no scope
  and an unused preview; each P2.4 plan refusal (protected, release, trial, chain, monthly, classifier silent, medium,
  auto-approve mode, escalated access) refuses on the chat form too, as one table test.
- Must not change: the caps, the window, `FAST_PREVIEW_MS`, the single-approver default (`fastStartOn`), the Accept
  backstop and `fastPublishProblem`, and the console, TUI and CLI roads.

### C2 — The Start card (`src/chat-actions.ts`, `src/contracts/chat-actions.ts`, `src/local-owner.ts`, `src/server/render-chat.ts`)

- `CHAT_ACTIONS.task_start: { label: "Start work", protected: true, password: false }`, in `APPROVAL_ACTIONS` (so
  also `CHALLENGE_ACTIONS`). Request schema: `{ repo, preview }`. `CHAT_ACTION_LOCAL_ACTS.task_start: "build-now"`,
  which `approve()` already allows with a fast marker (`scope.ts:1558`).
- `prepareSharedAction` branch: the `fast_preview` row must be this person's, `via = 'chat'`, prepared in this
  proposal's turn, unexpired and unused. Dry-run the filing in an always-rolled-back savepoint (the
  `sweepChildScopes` pattern) and run `fastStartRules`. Terms, all Toolroll's words: "Starts now as a small change.
  If it grows past 3 files or 150 changed lines, it waits for you to approve it again.", then
  `scopeTermsText(scope)`, the `fastTermsLines` rows the form shows (`src/fast-terms.ts`), and the agent permissions
  line. The goal and acceptance text are the lead's and are shown exactly, under "Written by the lead from your
  request", never as the person's own words. State: `{ preview, taskId, digest }`; `shown` is set by the existing
  approval rule (`chat-actions.ts:1097`).
- Executor branch, two proofs of the person and no third: (a) `approvalBy` returns `chat` with `shown` (a chat app
  tap, a Telegram typed yes under C5, or a signed-in web chat click through the review page): proof
  `{ chat: by.limits }`, sealed through `approve(…, fast, by.chat)`; (b) the local owner on web chat
  (`options.authority === "local-owner"`, where `approvalBy` returns no `chat`): proof
  `{ password: { localOwner: true, … } }`, sealed through `approve(…, fast)` with no `chat`, which proves the local
  owner itself and allows the `build-now` act only with a fast marker; its seal's basis is the password arm's.
  Anything else refuses. A refusal throws through the action's savepoint (`chat-actions.ts:1343`), which takes the
  filing back. If the real filing differs from the dry run, the stamp comparison and `approve()`'s digest and
  whole-terms checks refuse it. Said: "Started. It's building now." with the task link.
- Rendering is new work, not free: web chat's protected cards leave their terms off the card today
  (`render-chat.ts:774`). The web Start card shows the title, the project and "Review and start", which opens the
  review page (`/chat/action/:id`, `server/chat.ts:418`) where the whole terms and "I confirm this exact action" are.
- `propose_action` refuses `task_start` (as it does `flow_`, `lead-tools.ts:672`), and action discovery leaves it
  out: only C3 drafts one.
- Contracts: the `task_start` request schema, the contract fixtures and the exhaustive action samples
  (`src/contracts/chat-actions.test.ts:17`).
- Tests (`src/chat-actions.slow.test.ts`, `src/chat-parity.test.ts`): a tap files, approves and marks the task in one
  write; a refused tap leaves no task and an unused preview; a card whose project default changed is stale; a payload
  edited after drafting doesn't match its stamp; a replayed token does nothing; another person's tap is refused; a
  preview from another turn is refused; the person's chat approval off, or a limit, refuses; `via: "cli"` refuses;
  terms too long open the review page; a lead-actor call to the executor is refused; a dismissed card's preview can't
  be used.
- Must not change: any other action, `approvalBy`, `sharedActionNeedsReview`, the challenge.

### C3 — The lead drafts a start (`src/lead.ts`, `src/lead-tools.ts`, `src/contracts/lead-tools.ts`, `src/lead-contract.ts`)

- New tool `propose_start { repo, title }`: "The person asked for one small, clear change to be done now. Toolroll
  decides whether it can start right away; if not, you get an ordinary task card." Same text and secret checks as
  `propose_task`; refused in a team chat (`teamRoomOf`) and for a project the person can't reach.
- Order inside the loop (`lead.ts:703-715`), for `propose_start` only:
  1. the advertisement gate (`lead.ts:713`), then the tool's own validation, moved into a pure
     `startInputOf(ctx, args)` that the handler also uses: schema, project reach, text and secret checks, and the
     memory and capability checks `executeLeadTool` makes (`lead-tools.ts:2215`). Invalid input never reaches the
     classifier;
  2. `await prepareChatStart(...)` with the validated input and this turn's id (up to the 5 s classifier budget);
  3. the loop's own `guard(await revalidated())` again: the wait is long enough for the person's access or the thread
     to change;
  4. the tool runs synchronously with the result of step 2 in a per-call context keyed by the tool call id. Two
     `propose_start` calls in one turn get two previews. The preview id never comes from the model's arguments.
- Eligible: the handler drafts the `task_start` action. Ineligible: it drafts today's `task` proposal with
  `planning: "skip"` and says why in the tool body (`fastRefusalWords`), so the person still gets the two-step road.
- Contract: small, clear "just do it" requests use `propose_start`; everything else stays `propose_task`. "A typed
  yes to a Start card is Toolroll's to read, not yours. If you see one, it didn't count: say so and point to the
  card." Version 52 → 53. Tool schemas and fixtures in `src/contracts/lead-tools.ts` and
  `src/contracts/tools.test.ts:29`.
- Tests (the lead tool and lead loop tests): a small request drafts a Start card whose preview came from the loop; a
  preview id in the arguments is ignored; invalid input makes no classifier call; two calls get two previews; access
  removed during the wait drafts nothing; a medium or protected request drafts a task card with the reason; a team
  chat refuses; a classifier that never answers gives the task card.

### C4 — Every chat shows it (`src/telegram-lead.ts`, `src/chat-delivery.ts`, `src/teams-chat.ts`, `src/server/chat.ts`)

- `task_start` is an `action` card. Telegram arms "✓ Yes, start work / Cancel" (`telegram-lead.ts:315`); Slack and
  Discord arm the same yes/cancel; Teams arms its submit buttons (`teams-chat.ts:188`); web chat opens the review
  page (C2). When the terms don't fit a chat app's card, the card links to the review page, as approvals do today.
- `toolroll chat` keeps refusing approvals; for `task_start` the words name the terminal road: "Start it from the
  terminal with `toolroll task new "<title>" --repo <project>`." That command is the CLI's fast start today
  (`newTaskCommand`, `src/operate.ts:14182`). Wording lives in the executor (`chat-actions.ts:1638`).
- Tests: `src/telegram-lead.slow.test.ts`, the Slack, Discord and Teams delivery tests and
  `src/serve.chat.slow.test.ts` each run tap → confirm → task approved and marked → a wake is bumped; the
  `toolroll chat` test checks the refusal names `toolroll task new`.

### C5 — A typed yes starts it, on Telegram (owner's decision, 2026-11-09)
(`src/chat-migration.ts`, `src/chat-messages.ts`, `src/telegram.ts`, `src/telegram-lead.ts`, `src/lead-doors.ts`,
`src/chat-actions.ts`)

The person may answer a Start card by typing yes instead of tapping. Toolroll reads the word when the message
arrives, before any model runs. The lead never sees it as an instruction and has no tool that presses a card. A model
still never approves.

**Why Telegram only, for now.** A typed yes has to be tied to one exact card by stored facts. Telegram already stores
what that needs: every inbound message with its own id and the id it replies to, every sent card with its message
id, and an ingress that drops forwards, captions and other bots' messages. Slack, Discord and Teams don't store where
an inbound message came from (forwarded, attached, edited), so their cards keep the tap; they follow in a later arc
once their ingress records it. Web chat keeps its click on the review page.

**The card's last line** on Telegram, outside the terms (terms are digest-bound), in Toolroll's fixed words: "Tap
Start work, or reply yes." The Start card is always the last message Toolroll sends for that turn. This line is what
tells the person what a yes does; no part of the lead's reply is inspected.

**The record.** New table `chat_typed_start` (next schema version): `provider`, `event` (the inbound message, primary
key with `provider`, foreign key to `chat_event`), `proposal`, `card_message` (the chat message that carried the
card), `stamp` (the card's action stamp when the yes arrived), `how` (`reply` or `next`), `created`, and `outcome`,
`task_id`, `finished` (all null until settled).

**At ingress** (`telegram.ts`, the typed-message path only, at the point a message would be queued for the lead;
never the tapped-option path at `:2349`): in the same transaction that writes the `chat_event` row, Toolroll writes a
`chat_typed_start` row when all of these hold. Otherwise the message is queued for the lead exactly as today.
1. The text, trimmed, lower-cased and with one trailing `.` or `!` removed, is exactly one of: `yes`, `y`, `yep`,
   `yeah`, `yes please`, `yes start`, `start`, `start it`, `go ahead`, `do it`. Anything longer or different ("yes
   but make it blue", "ok", "sure") is an ordinary message to the lead.
2. It is a new, original text message in the paired one-to-one chat. Ingress has already dropped forwards, captions,
   messages through another bot and channel posts; edits arrive as a different update type and voice notes by a
   different path, and neither reaches this point (the builder proves each with a test, and adds the drop if one
   does).
3. The chat's last sent card is a Start card: a `chat_part` in this chat for a `task_start` proposal, `state = 'sent'`,
   not `uncertain`, the last part of its event, with its terms whole on the card (`sharedActionAllowsChallenge`).
4. The message is tied to that card by ids, one of two ways: it is a Telegram reply to the card's message
   (`how = 'reply'`), or it is not a reply to anything and its message id is the card's message id plus one
   (`how = 'next'`). The second form means nothing at all was sent or typed in that chat between the card and the
   yes. A yes typed after any other message doesn't count unless it is a reply to the card.
5. That proposal is pending, is the only pending proposal in the person's own thread with the lead (never a team
   room), and came from a turn that answered (a turn finalized after a timeout doesn't qualify).

**When the worker takes the message** (`telegram-lead.ts`, before a session's lead turn is started): if the message
has a `chat_typed_start` row, it calls `confirmTypedStart(store, who, { provider, event }, now, options)` (new, at
the end of `lead-doors.ts`) and no lead turn runs for that message. In ONE transaction it:
- returns the saved outcome if the row is already settled (a redelivery, or a crash after the write);
- re-proves the approver and the pairing, then checks 3, 4 and 5 again from the tables, that the proposal's stamp
  still equals the recorded stamp, and that the preview is unexpired and unused;
- confirms through `confirmLeadProposal` with `via: "telegram"` and a new option `typedStart: { provider, event }`.
  That option is the only new way past the "confirm this" gate in the door (`lead-doors.ts:220`) and in the action
  executor (`chat-actions.ts:1304`). Both accept it only for operation `task_start`, only on a chat app, and only
  when the unsettled `chat_typed_start` row names this proposal; any other use refuses. It doesn't set
  `confirm: true`, doesn't mint a review nonce and doesn't change `via`. Everything after the gate is the tap's road:
  the single-use `pending → confirming` step (a tap racing a typed yes: one wins, the other is told it was already
  acted on), `approvalBy` with the person's own chat setting and limits, `fastStartBuild`, `approve()`;
- writes the outcome and the task id on the `chat_typed_start` row, marks the message done, and queues Toolroll's own
  reply ("Started. It's building now." with the link, or the refusal's words) as a `chat_part`.
If any check fails at this point, the row settles as "didn't count", nothing starts, and Toolroll replies "That yes
didn't start anything. Tap Start work on the card." It is not passed to the lead as an instruction.

- The `approval proved` detail for a typed start carries `typed: { provider, event }` beside the fast marker, so the
  record shows which message was the yes.
- Only `task_start`, only Telegram. Other approval cards (approve a plan, accept a result, a sweep, a release) keep
  their taps.
- Tests (`src/telegram.test.ts`, `src/telegram-lead.slow.test.ts`, the door's tests): each word starts the task
  once, as a reply and as the next message; "yes" with any extra word, a forward, a caption, an edit, a voice note, a
  tapped question option whose text is "yes": each goes its ordinary way and starts nothing; a yes two messages after
  the card that isn't a reply; a yes whose id is below the card's (typed before the card arrived); a reply to a
  different message; a card that wasn't delivered or is `uncertain`; a card that links to the review page; two
  pending proposals; a proposal from a timed-out turn; a team room; an expired or used preview; chat approval off or
  over its limit; a stamp that changed between ingress and the worker: each starts nothing and says so; a typed yes
  and a tap together start one task; a redelivered update and a crash between ingress and the worker start nothing
  more and return the first outcome; a different Start card drafted after the yes was recorded doesn't get started
  by it; `typedStart` on any other operation, on `via: "web"` or `"cli"`, or from a lead-actor call is refused.

### H1 — Home in three groups (`src/home-groups.ts` new, `src/server/home.ts`, `src/browser-workspace.ts`, `src/browser/views/home-view.tsx`)

- A new pure module `src/home-groups.ts` (no server or rendering imports, so the terminal can use it):
  `homeGroupOf(item)` returns `"you"`, `"working"`, `"done"` or `null`. Precedence, in order: `"you"` when
  `status.views` holds `needs-you`; `"working"` when running or queued (every queued task, as built: the first
  rule, queued only with the label "Waiting", left a just-queued task in no group); `"done"` when
  complete; `null` for cancelled, replaced and any other finished row. One row per `rootId`.
- `homeView` groups: **Waiting on you** (the same 30 needs-you rows, in today's order Decide, Review, Unblock,
  unnamed; each row's chip already names the ask), **Working** (today's Running rows, then the queued rows, each
  read with its own bound as today, never merged and then cut to eight), **Done** (a fourth read, `view:
  "completed"`, filtered to the last 7 days by completion time before the cap of 8).
- Figures keep the meaning of the list each opens: Waiting on you (needs-you), Running (`totals.running`; the label
  stays Running because the list it opens is Running), Queued, Done (the full Completed total, not 7 days). Views
  and hrefs don't change. `homeSentence` is unchanged.
- Everything keyed on the old group names moves to the new ones: selection, the "waits" wording and progress in
  `home-view.tsx:102` and `:147`, and the overflow count in `home.ts:118`.
- In place: Waiting on you keeps its action and the in-place question; Working rows show what the agent is doing and
  "Open task"; Done rows show whichever primary action the work index gives them (some give "View task details",
  `src/work-index.ts:717`). No new POST from Home.
- Tests (`src/home-groups.test.ts`, `src/browser/home-view.test.ts`, `src/serve.home.test.ts`): every row today's
  groups show is in exactly one new group, on the demo's work; a row that both needs you and is running is under
  Waiting on you; cancelled and replaced rows are in no group; each figure still equals its list; a Done row older
  than 7 days isn't listed even when fewer than 8 are newer; the selected row is still the first that waits on you;
  the overflow count is right; phone layout shows the three headings.
- Must not change: what is read (`workIndexPage` filters), the question's POST, the dock, the lead's box.

### H2 — The same figures in the terminal and chat `/status` (`src/lead-status.ts`, `src/tui-source.ts`,
`src/tui-contract.ts`, `src/tui/app.tsx`, `src/telegram-status.ts`)

- `toolroll status` (and `--json`) and chat `/status` open with one line from the same work index totals: "Waiting on
  you N · Running N · Queued N · Done N". Everything below stays: `/status` groups dispatch diagnoses
  (`telegram-status.ts:81`), which aren't the work index's families, so its headings are not renamed.
- The terminal UI: where a `TuiRow` is built from a work index item (`src/tui-source.ts`), it gains `group` from
  `homeGroupOf` and the main list shows the three headings in Home's order. If the rows turn out not to be work
  index items, H2 stops at the opening line and says so in the PR.
- Tests: `src/lead-status.test.ts`, `src/tui/app.test.ts`, `src/telegram-status.test.ts`.
- H2 can ship after H1 without holding it.

## Build and review

- PR A, branch `one-step-chat`: C1-C5, one Opus builder, with the AGENTS.md safety self-review. The arc's last Codex
  round reviews this PR.
- PR B, branch `home-three-groups`: H1-H2, a second Opus builder. It changes no authority, so I review it myself.
- The two builders share one test lock, so one vitest process runs at a time.

## Safety self-review (AGENTS.md)

- **Check and write together:** the Start tap re-reads the preview, re-files, re-runs `fastStartRules` and the chat
  limits, and seals through `approve()` in the door's one transaction; a refusal rolls the filing back at any nesting
  depth. A typed yes is recorded in the transaction that saves the message and is checked again, consumed and acted
  on in one transaction.
- **Never widen implicitly:** the chat form runs the same eligibility code; the dispatch guard gains one arm that
  needs one complete chat proof carrying the fast marker; `typedStart` opens one gate for one operation on chat apps
  and refuses everywhere else; nothing about caps, window or Accept moves.
- **Don't let input choose what's trusted:** the preview comes from the turn loop, not the model, and is bound to the
  person, the turn and `via = 'chat'`; sizing comes from Toolroll's classifier record; which card a yes belongs to
  comes from Telegram's message ids and Toolroll's own delivery record, never from the text or the lead.
- **Approvals mean a person's yes to exactly this:** the card's words are Toolroll's, include the whole terms text,
  and are digest-bound (`state.shown`); `approve()` refuses a machine. A typed yes counts only for one delivered,
  whole-shown Start card that says "reply yes", only as a reply to it or as the very next message in the chat, only
  from a fixed word list matched before any model runs.
- **Credentials go only where they belong:** no password or token enters chat; nothing new is stored but ids.
- **Tests never touch the person's real setup:** Telegram is the scripted transport the existing tests use.
- **Prove it against the real thing:** each guard above has a test that tries to get around it.

## What must not change

- Fast start's rules: small only, classifier must confirm, attended, single-approver default, 3 files / 150 lines,
  30-minute window, Accept by a person before completion, publish or merge.
- Chat approval rules: the person's own off and limits, the challenge on chat apps for a tap, the review page on web
  chat for a click, long terms to the review page, a model never approves, no password in chat. The one addition is
  C5's typed yes to a Start card on Telegram.
- `toolroll task add` and every token, MCP, flow and import caller stay refused by fast start.
- Home's reads, the figures' meaning and the Tasks filters they open.

## Not in this arc

- A typed yes on Slack, Discord, Teams or web chat, or for any card other than Start work.
- Starting bigger tasks in one step from chat (the sweep card already does that for batches).
- Approve or Accept buttons directly on Home (they stay one click away on their own pages).
- Changing the Accept step.

## Checks

Targeted only. PR A: `src/fast-start.test.ts`, `src/fast-start-surfaces.test.ts`, `src/cli-fast.test.ts`,
`src/chat-actions.slow.test.ts`, `src/chat-parity.test.ts`, `src/telegram.test.ts`, `src/telegram-lead.slow.test.ts`,
`src/serve.chat.slow.test.ts`, the Slack, Discord and Teams delivery tests, the lead tool and lead loop tests, the
contract tests under `src/contracts/`, the migration tests, `src/plain-words.test.ts`, `src/one-vocabulary.test.ts`.
PR B: `src/home-groups.test.ts`, `src/browser/home-view.test.ts`, `src/serve.home.test.ts`,
`src/lead-status.test.ts`, `src/tui/app.test.ts`, `src/telegram-status.test.ts`. Both: typecheck and the guard
tests. Full suite in GitHub CI.

## Decisions

1. **Whose words become the task?** The lead's one-line title, filed as title and goal exactly as fast start files
   the form's words, shown whole on the card and labelled as the lead's.
2. **Confirm step on a tap:** kept. On chat apps Start is followed by "Yes, start work"; on web chat it opens the
   review page.
3. **A typed yes counts** (the owner, 2026-11-09): slice C5, Telegram first.
4. **A Start card can be used for 15 minutes**, as the form (`FAST_PREVIEW_MS`); after that it says "This expired.
   Ask again."
5. **No separate switch for chat starts:** the project's "Small tasks start right away" setting and the person's own
   chat approval setting decide it.
6. **Ready results sit under Waiting on you** (Accept is the person's act); Done lists the last 7 days and its figure
   is the full Completed total.

## Codex round 1 ledger (v1.2 → v2)

| # | Severity | Finding | Change |
| --- | --- | --- | --- |
| 1 | High | A typed yes couldn't be proven from stored messages on every chat (no record of forwards, attachments, or whole-card delivery) | C5 is Telegram only, where ingress and delivery are already stored; a card must be `sent`, not `uncertain`, with whole terms. Other apps keep the tap |
| 2 | High | "Newest reply with no question mark" doesn't tie a yes to the card | Tied by ids: a reply to the card, or the message id right after the card's. Fixed prompt on the card; no reading of the lead's text. Narrower word list. Codex preferred reply-only; the next-message form is kept because the owner asked for a plain yes, and it proves nothing came between |
| 3 | High | Reusing `confirm: true` isn't enough, and web has a second gate | One `confirmTypedStart` operation in one transaction with its own `typedStart` proof through both gates, `task_start` only; web isn't in C5 |
| 4 | High | Queued and replayed messages weren't covered | The yes is recorded at ingress with the message; the outcome is saved on that record and returned on redelivery or after a crash |
| 5 | Medium | The chat form's authority difference wasn't stated | Stated in C1; `proposedVia: "mate"`, whole terms, and both exclusions kept; the lead's words labelled as the lead's |
| 6 | Medium | The new dispatch arm could match partial or malformed proof | One complete row, `json_valid` first, with tests for each mismatch |
| 7 | Medium | The classifier ran before the tool's validation; previews weren't per call | Validate, then prepare, then revalidate, then run; per-call preview bound to the turn; a dismissed card consumes it |
| 8 | Medium | Home's groups and figures disagreed; shared code sat under the server; `/status` isn't the work index | Figures keep their lists' names; `src/home-groups.ts`; a `null` group; `/status` gets the opening line only |
| 9 | Medium | Code keyed on old group names; Done's action and cap | Each place listed; Done filtered by time before the cap; its action is whatever the work index gives |
| 10 | Medium | Facts: timeout-finalized drafts, Teams buttons, web cards omit terms, contract files and test names, contract version | All corrected in place |

Also confirmed by Codex: the savepoint change in C1 is right.
