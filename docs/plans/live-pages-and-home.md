# Pages that change in place, and a Home you can decide from

Status: plan v2, 2026-11-10. Not built. v1 was reviewed read-only by Codex (GO WITH CHANGES, 13 findings); all
thirteen are folded in below and listed at the end.

## Why

Alex's words: "How do we get the site to be live instead of refresh pages every click??", then "Make a nice animation
and instant feeling together. And ok do 1 and 2 in parallel", and "Yes do the approval from home."

What is true today (read at `762e139a`):

- Content already updates by itself: one `EventSource` per page (`GET /live`), rooms, and "change" hints that make a
  part re-read itself (`src/browser/live.ts`). The stream is closed and reopened when the set of rooms changes.
- What reloads is moving between pages (plain links) and most buttons (native `method="post"` forms that answer with
  a redirect).
- One React app draws every chromed page (`WorkspaceApp` in `src/browser/app.tsx`; `ViewHost` picks the view; pages
  the server draws arrive as `workspace.pageHtml`, shown by `GuardedHtml`, which can refuse a replacement).
- Every chromed page that is not a one-time-secret page can already be read as data: `GET <path>?format=workspace`
  answers the `BrowserWorkspace` JSON (`src/serve.ts`, the `requestFacts.workspaceRead` arm), with an ETag. These
  reads do not extend the session (`src/serve.ts:872`).
- A task page read mints an approval nonce every time it is read while a plan waits
  (`src/server/task-views.ts:332`, `:861`). The nonce store is shared, capped at 500, 15 minutes each
  (`src/server/session.ts:32`); at the cap the oldest is dropped whoever it belongs to (`src/serve.ts:784`).
- A page that shows a password field is `sensitive`: it opens no live connection and runs one script only.
- Some pages carry their own page script (`functional: { script }`: chat, flows, recipes, results, history, a task
  page with a running check or an open question, some Settings pages, the queue). It runs once per document
  (`src/browser-shell.ts:51`).

## What a person notices

| Before | After |
| --- | --- |
| Every click on a menu item or a row reloads the whole page. | The menu and the message box stay. Only the middle changes, with a short fade and slide. |
| A click waits for the server before anything moves. | The clicked item is marked at once. The page is usually already fetched, so it shows at once. |
| Back reloads and loses the scroll position. | Back shows the page at once, at the place it was left. |
| Home lists what needs you. Each one opens another page. | Home shows the open step of the selected task. A plan is read and approved there, and the next one opens. |
| Chat is not in the menu. New task is a pencil. | Chat is in the menu under Home. The lead's last message sits above the message box. New task is a plus. |

Sign-in, password pages, first-run pages, the terminal and pages with a one-time secret still load as their own
page. So do pages that carry a page script, until that script is moved into the app (listed under "Later").

## Build order

Two streams run side by side. Each stream is two pull requests.

| | Stream A (navigation) | Stream B (Home) |
| --- | --- | --- |
| First | **A1 `live-nav`**: the shared base and in-place page changes, plain swap | **B1 `home-act`**: Home's data and layout to the mock, Chat in the menu, the plus. No approval change |
| Then | **A2**: the transition, prefetch, Back with scroll | **B2**: approve in place, on Home and on the task page (needs A1 merged) |

A1 and B1 touch different files. B2 starts when A1 is merged, and runs beside A2.

---

## A1: the shared base and in-place page changes

### A1.1 Which pages may change in place

The server decides. `BrowserWorkspace` gains:

```ts
/** True when this page may replace another without a document load. */
inPlace: boolean;
```

`inPlace = eligibleRoute && !sensitive && functionalScript === ""`, computed in the one place the workspace is
built (`src/serve.ts`), where:

- `eligibleRoute` is an explicit allowlist of route ids kept in one constant: Home, the Tasks list, the task page,
  Projects, Agents (the list, not the Live grid), Search, and the Settings pages. Nothing is eligible by default.
  `/welcome` and every first-run page, `/term` and its pages, sign-in pages and the release sheet are not on it.
- `functionalScript` is the exact value the document would run. The expression that is computed today after the
  JSON return (`src/serve.ts:1695`) is hoisted above it so both arms use one value, and it is taken after the task
  page has appended its result scripts (`src/server/task-views.ts:925`).
- A `forceSensitive` page answers no workspace at all, as today.

### A1.2 One door for every new workspace

Today a workspace reaches the screen by three roads: the first render, the page's own re-read (`useWorkspace`
`check()`), and nothing else. A1 adds navigation, so every road now goes through one function, `acceptWorkspace(next,
how)` in `src/browser/app.tsx`, where `how` is `"refresh"` (same page re-read), `"navigate"` or `"confirm"` (A2).
It enforces, before anything is rendered:

1. **Sensitive pages are their own document.** If `next.sensitive` is true and the document did not start as that
   sensitive page, the browser loads `next`'s URL as a document (`location.assign`) and nothing of `next` is
   rendered. This holds for all three `how` values, including a page that becomes sensitive on its own re-read.
2. **In place only between eligible pages.** For `"navigate"` and `"confirm"`: both the page being left and `next`
   must say `inPlace: true`, else a document load.
3. A page that gains a page script on its own re-read (`inPlace` turns false under `"refresh"`) is kept as it is
   today: no script runs until the next document load. This is deliberate, and it is today's behaviour.

`setLiveQuiet` keeps its meaning. No sensitive page is ever shown inside a document that ran another page's code.

### A1.3 The shell stays, the page content is keyed

`WorkspaceApp` is split:

- **Shell** (mounted once per document): `FormToken`/`Passwordless` providers, `Rail`, the phone header and drawer,
  the message box, `NeedsDock`, `SearchMenu`, the notices line.
- **Page** (`<Page key={epoch} …>`): the header, `#workspace-main` and the view, with every piece of state that
  today derives from `initial` (live task, agents board, the rooms it follows, the approval snapshot in `TaskView`,
  `GuardedHtml`'s accepted markup).

A navigation is a new `epoch`. The page remounts with the new workspace as its starting value, so page state is
correct by construction and `GuardedHtml` gets a fresh instance instead of a refused replacement. The shell reads
the current workspace through context and re-renders (new `navigation`, `crumbs`, `csrf`, `needsYou`).

Shell rules:

- The message box keeps its text across a navigation when the conversation scope is the same, and uses the saved
  draft for the new scope when it differs. Home's ask box (today local state only, `home-view.tsx:80`) is given the
  same saved-draft handling.
- The phone drawer closes on every navigation.
- There is one live stream at a time. It may reconnect when the rooms change; nothing in this plan requires the
  same connection to survive.

### A1.4 Read purposes

A request header on workspace GETs, `x-toolroll-read`, names the purpose. It is a hint about bookkeeping, not proof
that a person clicked, and no authorisation decision reads it.

| Value | Sent when | Extends the session | Mints an approval nonce |
| --- | --- | --- | --- |
| absent, `poll`, or any unknown value | the page re-reads itself | no (today) | as today |
| `navigate` | a link was followed or Back was pressed | yes, as the HTML GET of the same URL would | as the HTML GET does |
| `prefetch` | a page is fetched ahead, or Home reads the selected task (B2) | no | no (`mintNonce: false`, the value is `"unminted"`) |

- `navigate` applies only to `?format=workspace` GETs and only where the HTML GET of the same URL extends the
  session. Every existing no-touch exception stays a no-touch exception whatever the header says (live rooms,
  fragments in `NO_TOUCH_FRAGMENTS`, `/code/…/state`, `/term/state`, `/agents/live…`, `/agents?view=live`,
  `src/serve.ts:873-875`). A same-origin script can already extend a session with an ordinary page GET, so this adds
  no new ability; a test pins that the header does nothing on a non-workspace request.
- `prefetch` is answered only for cookie sessions (any other caller gets `204` before authentication bookkeeping
  such as token usage is written) and only for the prefetch allowlist: Home, the Tasks list, Projects, Agents (the
  list), Search, the task page. Every other route answers `204`.
- "A prefetch changes nothing" means: no business state written, no nonce minted or evicted, the session's last-seen
  time unchanged. One test per allowlisted route proves it, including its query variants (`?project=`, paging).
- A prefetched page is data only. It is never mounted, visibly or hidden, before the person goes there: mounting has
  effects (the Agents detail marks a run seen and takes a watch, `agents-view.tsx:531`).

### A1.5 Following a link

A new file `src/browser/navigate.ts`. One `click` listener on `document` in the **bubble** phase, so every
component's own handler has already run. (Home selects a row and prevents the default in its own handler,
`home-view.tsx:143`; the menu's Search opens a panel, `shell.tsx:142`; both keep working.) A click is followed in
place only when all hold:

- `event.defaultPrevented` is false; left button; no modifier key;
- the target is inside an `<a href>` with no `target`, no `download`, no `data-full-load`;
- same origin, and not a hash-only change on the current path;
- the current workspace says `inPlace: true`.

Then: read the page (`readPage(href, "navigate")`, added at the end of `src/browser/workspace-client.ts`), and

- JSON that passes `acceptWorkspace(next, "navigate")` → `history.pushState`, `document.title`, new `epoch`, focus
  to `#workspace-main`, the title said in a polite live region, scroll to top;
- anything else (redirected, not JSON, refused by `acceptWorkspace`, 401/403, 5xx, network error, more than 8 s) →
  `location.assign(href)`, and the browser does what it does today, including sign-in.

Native forms are not touched by A1: a post still loads a document. Two clicks at once: the later one aborts the
earlier read.

`popstate` reads the entry's URL the same way and swaps without `pushState`. (Scroll restore is A2.)

### A1.6 Code that runs once per document

Found by the review, to be handled in A1, each with a test:

- Kit behaviour already delegates and rescans inserted content (`src/browser/kit/behavior.ts:303`, `:374`). Keep.
- The mutation-key fill for native forms already delegates (`src/server/mutation-key.ts:167`). Keep, and add a test
  that a native form on a page shown in place posts with the key.
- `chromeScript()` binds some nodes once at load (`src/server/chrome.ts:422`). The builder lists each binding and
  either makes it delegate or moves it into the shell component, with cleanup. A page that needs a binding that
  cannot be moved is taken off the eligible list.
- `WORKSPACE_MOTION_SCRIPT` is not part of the React workspace document (`src/serve.ts:1700`); nothing to do.
- The existing hash reveal and window-scroll correction (`src/browser/app.tsx:625`) runs per page mount, and must not
  fight A2's scroll restore.

### A1.7 Files and tests

- new `src/browser/navigate.ts` (+ test); `src/browser/app.tsx` (the split, `acceptWorkspace`);
  `src/browser/workspace-client.ts` (`readPage`); `src/browser-workspace.ts` (`inPlace` only); `src/serve.ts` (read
  purpose, session touch, prefetch allowlist and `204`, `inPlace`, the hoisted script value);
  `src/server/request-context.ts` (`readPurpose`); `src/server/task-views.ts` (`mintNonce: false` on a prefetch);
  `src/server/chrome.ts` (bindings).
- Tests: the session table (poll no, prefetch no, navigate yes, each no-touch exception still no); prefetch changes
  nothing, per route; prefetch from a non-cookie caller is `204`; `/welcome` and `/term` are never `inPlace`; a
  sensitive workspace is never rendered by any of the three roads; each listed doubt falls back to a document load;
  Home's row selection and the Search panel still work with the listener installed; drafts across a navigation; the
  drawer closes.

---

## A2: the transition, prefetch, Back

### A2.1 Prefetch, and showing a page before it is confirmed

- A link to a prefetch-allowlisted page is fetched (`x-toolroll-read: prefetch`) when the pointer has rested on it
  for 65 ms, on `touchstart`, and on keyboard focus. At most two at once. Results live in memory only (at most 20
  pages, each good for 10 seconds), and all are dropped on a `change` hint for the `workspace` room and on
  `WORKSPACE_NUDGE`. `Save-Data` and a hidden tab turn prefetch off.
- On click, a prefetched page is shown at once with the page content `inert` (visible, not interactive), while the
  `navigate` read runs. When it lands it goes through `acceptWorkspace(next, "confirm")` and the page content is
  remounted from the confirmed workspace with no animation (a new `epoch`, scroll kept). Remounting, not patching,
  is the point: `useWorkspace`'s state, the task view's pinned approval and `GuardedHtml` all start from the
  confirmed data, so an `"unminted"` nonce is never left in a live form. If the confirming read fails any check, the
  document loads instead.
- Without a prefetch the click waits for the `navigate` read. The clicked menu item or row is marked the moment it
  is pressed. If the read takes longer than 150 ms, a 2px ink line runs along the top of the content column until it
  lands. No spinner, no skeleton.

### A2.2 The transition

Only the page content moves. The sidebar, the phone header and the message box hold still: the sidebar already has
a `view-transition-name` with `animation: none` (`src/server/console.css:2668`); the phone header and the message
box get the same.

- Same level (menu item to menu item): old content fades out in 80 ms, new content fades in over 160 ms. No movement.
- Going deeper (a list row to its page): new content fades in and moves 8px from the right over 200 ms,
  `cubic-bezier(.2, .8, .2, 1)`; the old fades out in 80 ms. Going back to a shallower page mirrors it. Depth is the
  number of path segments, in one small pure function with tests.
- `document.startViewTransition(() => flushSync(() => setPage(next)))`, with a class on `<html>` for the direction
  that is removed when the transition finishes. The cross-document rules that exist (`@view-transition { navigation:
  auto }`, `so-page-leave`, `so-page-arrive`) are retimed to the same numbers, so a document load looks the same.
- `prefers-reduced-motion: reduce`: no animation. A browser without `startViewTransition`: a plain swap. A new click
  skips a running transition. Nothing animates longer than 220 ms.

### A2.3 Back

`history.scrollRestoration = "manual"`; the scroll offset of the page content and the window is saved in
`history.state` on the way out and restored after the swap, after the hash-reveal correction has run. An entry that
was a document load is handled by the browser as today.

---

## B1: Home's data and layout

### B1.1 What Home shows (the approved mock)

Desktop, something needs you:

- Heading "N tasks need you" said once; under it one quiet line "1 building now · 1 queued".
- One project filter (a select), not a row of tabs.
- Left: the list, grouped by what is asked: **Approve a plan**, **Answer a question**, **Something went wrong**,
  **Review results**, and **Needs you** for any row that fits none of the four. A group heading carries its count.
  A row is one link: title, then project and age. Only a failed row has a reason, in red. No chip per row.
- Right: the selected task's summary and its one action, as today (B2 puts the plan and Approve there).
- Bottom: the lead's last message as one line that links to the chat, then the filled rounded message box
  ("Message the lead").
- Menu: **Chat** under Home; New task is a plus beside the brand.

Nothing needs you: what is running, what finished today, and the message box in the middle of the page.

Phone: the next one as a card with its one action, then the same grouped list; the last-message line and the message
box at the bottom, with a round plus for New task.

No amber anywhere. Ink marks what waits on the viewer (solid "Needs you" chip, 1px ink outline, one solid ink
button). Blue only running, green only passed, red only failed. Hairlines, not nested boxes. No internal codes, paths
or ISO times.

### B1.2 Data

`BrowserHomeView` gains:

- `groups: { key: "approve" | "answer" | "wrong" | "review" | "other"; label: string; count: number; rows }[]`.
  `count` is the exact total. The work index counts approvals and questions together today (`decide`,
  `src/work-index.ts:67`, `:405`), so it gains exact per-ask counts, computed before the page limit.
- on a row: `ask` (the group key) and `reason: string | null` (a failed row only). The per-row chip leaves the view.
- `lastLead: { text; age; href } | null`: the lead's last message in the viewer's main thread, plain text, one line,
  cut server side; `null` when there is none or the viewer may not read it.
- `finishedToday`: filtered to today **before** the limit is applied (today the completed read is cut to 8 first,
  `src/server/home.ts:94`, `:120`).

The menu: `browserNavigationOf` (`src/browser-workspace.ts:946`) gains a **Chat** item (`/chat`), and Home stops
being the active item on `/chat`. `Rail` (`src/browser/shell.tsx`) draws the plus.

### B1.3 Files and tests

`src/server/home.ts`, `src/work-index.ts` (counts), `src/browser/views/home-view.tsx`, Home's CSS,
`src/browser-workspace.ts` (`BrowserHomeView`, `BrowserHomeRow`, `browserNavigationOf`), `src/browser/shell.tsx`.
Tests: group counts are exact past the page limit; the fallback group; finished today past eight; Chat is active on
`/chat` and Home is not; no amber token in Home's CSS; the phone layout.

---

## B2: approve in place

### B2.1 What Home shows for the selected task

A new component in `src/browser/views/home-approval.tsx`, written for Home, not the task page's open step reused
whole (that block can hold server HTML and `KApprove` opens a password dialog when its facts say password,
`k-approve.tsx:54`). It can render only: the plan, the terms line, one **Approve** button, one link.

Home reads the selected task with `GET /t/<id>?format=workspace` and `x-toolroll-read: prefetch`: no nonce is
minted and the session is not extended while a person arrows down the list. From that data it keeps one
**snapshot**: `{ taskId, action, digest, rebuild, heading, text, termsWords, planHtml, kind, facts }`.

- Every selection read carries a generation number. A response for a row that is no longer selected, or an older
  generation, is dropped.
- The snapshot on screen is replaced only by a newer read of the same selected task. If its `digest` differs from
  the one shown, the plan area is redrawn and a line says "The plan changed. Read it again." The Approve button
  takes no press for 600 ms after any redraw.

What is offered:

- `approvalAsk(kind, facts)` is `"click"` or `"automatic"` (passwordless session, a password remembered on this
  computer, or an eligible local owner), the task's workspace is not `sensitive`, and `planHtml` holds no form
  control (`<input|form|button|select|textarea`, checked before render) → the plan and the solid **Approve** button.
- Anything else → the plan (or none, if it failed the check) and one link, **Review the plan**, to the task page
  with `data-full-load`. The password is asked there, as today.

Home has no `input type="password"` in any state. That is checked after every selection read and every re-read, and
pinned by a test over every state.

"Request changes" is a link to the task's chat (`taskChatHref`).

### B2.2 The press

One press on Approve (pointer or keyboard) does two requests, in order:

1. **Mint for exactly what is shown.** `GET /t/<id>?format=workspace` with no read-purpose header (a minting read,
   as the task page does today). If the answer's `approve.fields.digest` is not the snapshot's digest, or the ask is
   no longer one click, or the page is `sensitive`: nothing is posted, the snapshot is replaced, and the line "The
   plan changed. Read it again." shows. A newer digest is never approved by the press that discovered it.
2. **Post** to the snapshot's `action` with `fetch`:
   `headers: keyed({ "x-toolroll-act": "in-place", accept: "application/json" })`,
   `body: csrf, nonce (from step 1), digest (the snapshot's), rebuild (the snapshot's, if any), return=next`.
   No `token` field, ever.

So a nonce is minted once per press, not per row looked at, which also keeps Home from pushing other people's
nonces out of the capped store.

The button is disabled from the press until an outcome is known.

### B2.3 The server's answer

The route, its scope (`step-up`), its freshness rule and every proof in `case "approve"` (`src/server/tasks.ts`)
are unchanged: cookie session only; the nonce consumed once and bound to who saw which digest of which task; the
digest equal to `approvalFormDigest(...)`; a password required unless the session is passwordless or fresh or the
local owner is eligible; the revision brief re-verified; then `approveScope`.

Only the **shape of the answer** changes, and only when `x-toolroll-act: in-place` is present, read in one helper
`answersInPlace(request)` added at the end of `src/server/http.ts`, after authorisation is done. The handler names
its outcome instead of leaving the client to guess from a status:

| `outcome` | When (today's code) | Status | The task changed? |
| --- | --- | --- | --- |
| `approved` | the success redirect | 200 | yes |
| `vote` | a first yes on protected work is recorded (`second-approver`), words from `gateWords` | 200 | yes, a vote |
| `approved-not-rebuilt` | approved, but building again did not start (two message sites) | 200 | yes |
| `refused` | every other `approvalProblem` (stale form, changed plan, policy, not allowed, blocked brief) | as today | no |

Body: `{ "outcome": …, "words": "<the same words the page shows today>" }`. `approvalProblem` is given the outcome
by each caller; none is inferred from the status.

Anything the dispatcher answers before the handler (signed out, step-up needed, rate limited, CSRF or key refused)
is answered as today. The client treats any answer that is not this JSON as `elsewhere` and loads the task page as
a document.

### B2.4 What the client does with it

- `approved`: the row leaves the list (height and opacity over 200 ms; none with reduced motion), the next row is
  selected, and a line "Approved." shows above the list until the next selection. Home re-reads itself
  (`WORKSPACE_NUDGE`).
- `vote`, `approved-not-rebuilt`: the server's words show in the pane; Home re-reads itself; the row stays or leaves
  as the re-read says.
- `refused`: the server's words show under the button with "Nothing changed."; the selection is read again.
- **No answer** (network error, timeout, a response that could not be read): the client does not say it failed. It
  shows "Checking…", reads the task again, and reports what the task now says (approved, or still waiting). The
  button stays disabled until that read lands. The approval write happens before the response is sent, so a lost
  answer proves nothing.

Home's outcome line is Home's own state. `workspace.receipt` is about message delivery and is not used for this.

The task page's approve button uses the same press (B2.2 step 2 only: it already holds a minted nonce in its pinned
snapshot) when the ask is one click. Its password case keeps the native form.

Answering a question from Home works in place today (`/d/<id>/answer`) and is left as it is.

### B2.5 Files and tests

- new `src/browser/views/home-approval.tsx`, `src/browser/act.ts` (`postInPlace`) (+ tests);
  `src/browser/views/home-view.tsx`; `src/browser/views/task-view.tsx` (the one-click press);
  `src/server/http.ts` (`answersInPlace` at the end); `src/server/tasks.ts` (`case "approve"` answer sites).
- Tests: the approve route's proofs give the same result with and without the header (one table run both ways:
  stale nonce, spent nonce, wrong digest, another viewer's nonce, password needed, closed door, blocked brief, first
  vote, rebuild not started); each outcome's JSON; Home has no password input in any state; a `"password"` ask and a
  plan with a form control both render the link with `data-full-load`; a late selection response is dropped; a
  changed digest at step 1 posts nothing; a lost answer leads to a re-read, never to "failed"; arrowing through 600
  rows mints nothing; the scripted journey approves a plan from Home and opens a password approval as a document.

---

## Where the streams meet

Fixed here so neither side guesses:

- `data-full-load` on a link: A1 honours it, B2 sets it.
- `x-toolroll-read` is A1's; B2 only sends `prefetch` and the header-less minting read.
- `x-toolroll-act` is B2's.
- `WORKSPACE_NUDGE` after an in-place act (B2) also empties A2's prefetch map.
- `src/browser-workspace.ts`: A1 adds `inPlace`; B1 changes Home's types and `browserNavigationOf`. `src/serve.ts`
  is A1's. `src/browser/app.tsx` is A1's. `src/browser/shell.tsx` `Rail` is B1's; A1 changes how the shell is
  mounted, not `Rail`. Whichever merges second rebases.

## Safety self-review (AGENTS.md list), answered for the plan

- **Check and write together.** The approve route is unchanged: nonce consume, digest check, person proof, brief
  re-verification and `approveScope` run in one handler as today. The in-place answer is written after them.
- **Never widen implicitly.** `inPlace` is an allowlist of routes and is false for any page with a password field or
  a page script. Prefetch is an allowlist of routes and of callers (cookie sessions). Every existing no-touch
  exception stays.
- **Grant files, not folders.** Not applicable.
- **Don't let input choose what's trusted.** `x-toolroll-read` chooses only whether a workspace read extends the
  session (never more than the HTML GET of the same URL) and whether it mints (prefetch never does). `x-toolroll-act`
  chooses only the answer's shape, after authorisation. Neither is read by any authorisation decision.
- **Approvals mean a person's yes to exactly this.** The nonce is minted at the press, for the digest on screen, for
  this viewer and this task, and used once. If the digest moved, nothing is approved and the person is told to read
  again. The action, digest, nonce, rebuild target and terms all come from one snapshot. No script approves: the post
  is sent only from a press on the button, which takes no press for 600 ms after the plan redraws.
- **Credentials go only where they belong.** Home never renders a password field and an in-place post never carries
  `token`. The password is typed only on the task page, a sensitive document that no in-place change can enter or
  leave.
- **Tests never touch the person's real setup.** Fixture store and fixture sessions only.
- **Prove it against the real thing.** The scripted journey (`--journeys scripted`) gains: change pages in place and
  check one live stream is open after; approve a plan from Home; open a password approval from Home and check it is
  a document load with no live connection.

## Later (not in this build)

- Move the page scripts of the task page (check progress, peek, answering a question) and of Chat into the app, so
  those pages change in place too. Until then they load as documents with the same fade.
- Other acts in place (accept a result, retry a failed build, queue acts), one route at a time with the same
  named-outcome rule.
- Home's list carrying flow, release and setup decisions.
- A per-viewer bound on the nonce store. (The task page still mints on each of its own re-reads, as today.)

## Review findings folded in (Codex, round 1)

1. HIGH. A prefetched page cannot be confirmed through `useWorkspace`'s existing path → A2.1: shown `inert`, then
   remounted from the confirmed workspace.
2. HIGH. The sensitive boundary was only on link navigation → A1.2: one door for every workspace, with a document
   load before a sensitive page is rendered; B2.1: Home has its own restricted component, not `KApprove`.
3. HIGH. `{ok:false}` plus "Nothing changed" would be false for a recorded vote, for approved-but-not-rebuilt, and
   for a lost answer → B2.3 named outcomes, B2.4 the no-answer rule; "The build starts." removed.
4. HIGH. Home needs snapshot and selection identity → B2.1 snapshot and generations; B2.2 a moved digest is never
   approved by the press that found it.
5. HIGH. A capture-phase listener would take Home's row selection and the Search panel → A1.5 bubble phase.
6. MEDIUM. The read header is a hint, not proof of a person → A1.4 wording, workspace GETs only, every no-touch
   exception kept.
7. MEDIUM. Selection reads minted and could evict another person's nonce → B2.1 unminted selection reads; B2.2 mint
   at the press.
8. MEDIUM. Prefetch purity must cover authentication and mounting → A1.4 cookie sessions only, never mounted; B2.4
   Home's own outcome line, not `receipt`.
9. MEDIUM. The `inPlace` predicate alone would admit `/welcome`; the terminal is `/term` → A1.1 route allowlist and
   the hoisted script value.
10. MEDIUM. A keyed remount of the whole app loses the shell → A1.3 shell stays, page is keyed; drafts; drawer; one
    stream that may reconnect.
11. MEDIUM. Once-per-document scripts need named work → A1.6.
12. MEDIUM. The two parts were not independent → the build order: A1 carries the shared base, B1 runs beside it
    with no shared files, B2 follows A1.
13. LOW. Group totals and "finished today" → B1.2 exact per-ask counts, the fallback group, filter before limit.
