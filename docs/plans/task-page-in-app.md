# The task page's own behaviour, moved into the app

Status: plan v2, 2026-11-10. Codex reviewed v1 once, read-only: go with changes. Its eight findings are folded in and
listed at the end. No second plan review (the arc's budget is two rounds; the other one is for the implementation).

Built: C1 (PR #353, 2026-11-11; the implementation review was spent on it) and C2 (2026-11-11, verified without a
further review round). The work version is 2 since C2.

## Why

Alex's words: "Do the next slice to get the rest into the app so it's not reloading".

`docs/plans/live-pages-and-home.md` made pages change in place, with one exception it listed under "Later": a page
that carries its own page script still loads as a whole document, because a page script is a string the server ships
and it runs once per document. This plan removes that exception for the task page.

What is true today (read at `69f16ad4`):

- The server decides it per page: `inPlace = inPlaceRoute(...) && !sensitive && functional === ''`
  (`src/serve.ts:1651`). `functional` is the page's script string.
- A task page carries a script string in three cases (`src/server/render-tasks.ts:3201`,
  `src/server/task-views.ts:927`):
  1. A build is running: `regionScript("check-progress", …)`, which keeps the check progress line current, and with
     the live file view on, `regionScript("run-peek", …)`, which keeps "What is changing right now" current.
  2. A question is open: `decisionAnswerScript()`, which answers it without a reload.
  3. The task has a result: `reviewEvidenceScript()` and `RESULT_REVIEW_SCRIPT` (result tabs, line notes, the
     Request changes form, its draft and its one-time request token, the reading position).
- So opening a task with a result, a running build or an open question reloads the whole page. A task with a result
  is the most common one a person opens.
- `#check-progress` is drawn inside the status HTML (`render-tasks.ts:2689`), which the React view shows when the
  task has no structured status card (`task-view.tsx:920`, `983`). So its script is live in that case and is ported
  like the others. (v1 said it was dead. That was wrong.)
- A password page with a result still carries the result's script: `task-views.ts:927` adds it after the task page
  dropped its own. That stays exactly as it is.
- The React task view draws these parts already: the peek region and the question forms are server HTML placed by
  `GuardedHtml` (immutable: installed once); the result panel is React markup with server HTML inside. The scripts
  bind to that DOM after the first render and are never cleaned up, which is why they cannot run twice in a document.
- A page with a password field (`sensitive`) is its own document by rule A1.2. That rule is not touched here.

## What a person notices

| Before | After |
| --- | --- |
| Opening a task that has a result, a running build or an open question reloads the whole page. | It opens in place, like a task without them: the sidebar and header stay, the content changes with the short transition, Back returns to where you were. (Running build and open question in C1; result in C2.) |
| Hovering such a task does nothing. | It is read ahead on hover, so the press shows it at once. |
| Result tabs, line notes, Request changes, answering a question and the live file view work after a full load. | They work the same after an in-place open. |
| A question that opens, or a build that starts, while the task page is open works only after a reload. | It works at once. |
| A task page that shows a password field loads as its own page. | Unchanged, on purpose (the safety rule). With Passwordless on, no password field shows, so these open in place too. |
| A button that posts a form (Request changes, Complete) reloads the page. | Unchanged in this slice. |

## The design

### 1. The app runs the behaviour; the server names it

- New module `src/browser/page-work.ts` and one file per behaviour under `src/browser/work/`. Each behaviour is a
  TypeScript function `(entry, signal: AbortSignal) => void` that does what its script string does and registers
  every listener, timer, live-room subscription and fetch with `signal`, so aborting it leaves nothing behind.
- The workspace JSON gains `work?: readonly PageWork[]`. It is data, a closed list:
  `{ kind: "answer" }`, `{ kind: "region", region: "check-progress" | "run-peek", run: number }`,
  `{ kind: "result" }` (C2). No script text, selector or address travels in it. The app runs only kinds it knows.
- `Screen.functional` gains `app?: readonly PageWork[]`: "the app has its own version of this **whole** script".
  Composition is all or nothing: adding a script without `app` to one that has it drops `app` (one helper,
  `withScript`, used wherever a task page adds a script). So in C1 a page with a result stays a document, and a page
  can never get half its behaviour from the string and half from the app.

### 2. Which form a page gets (the server's one decision)

In `serve.ts`, React document arm, the app form is used only when **all** of these hold; otherwise the page is
exactly as today (the string ships, no `work`, `inPlace` false):

1. `functional.app` covers the whole script (and the page is the task's own view, not the chat-only arm);
2. the page is not sensitive (a password page keeps today's string path, including the result script on it);
3. the route is on the in-place allowlist (unchanged);
4. the reader can run it: a document load (the app bundle is served `no-store`, so the document always gets the
   bundle that matches the server), or a workspace read that says so with `x-toolroll-work: <version>`, exactly
   the server's own (`PAGE_WORK_VERSION`: 1 in C1, 2 since C2 added `result`). The header is a capability hint
   like `x-toolroll-read`: it chooses between two safe forms of the same page and no authorisation decision reads
   it. A tab that still runs an older app sends no header, or an earlier version, and keeps every barrier it has
   today, on its re-reads too.

When the app form is used: no page script string in the document, `work` in the workspace, and the existing rule
makes the page `inPlace`. A document that does ship a page script string says so: `scripted: true` in its workspace.

### 3. The door and the controller (the app's side)

`acceptWorkspace` (the one door) gains two refusals, for "navigate" and "confirm":

- **A document that ran a page script string never changes pages in place** (`documentStart.scripted`). Its
  document-wide listeners live as long as the document, so the next page gets a clean one. (Today such a document
  could leave in place once its script went away on a re-read; that was harmless only because every page those
  listeners could act on loaded as a document.)
- **Work this app does not know** loads the page as a document.

The work controller (`page-work.ts`), driven by one hook in `WorkspaceApp`:

- One controller per page shown (per epoch). It is stopped when the page is replaced or the app unmounts; stopping
  aborts every entry's signal.
- It never runs on a sensitive page, in a document that ran a page script string, or on a page shown ahead of its
  own read (`pageHeld()`; the confirmed page is a new epoch and starts then).
- **A re-read of the same page reconciles by key** (`answer`, `result`, `region:<name>:<run>`): an entry that is new
  starts; a region whose entry left stops; `answer` and `result` are never restarted and stay until the page is
  replaced (so a draft, a request token or the open tab is never reset by a re-read). This is how a question that
  opens, or a build that starts, while the page is open begins to work.
- Rule A1.2.3 is unchanged for strings: a page that gains an **uncovered script** on its re-read keeps showing and
  runs nothing until the next document load. Only ported work may start after a re-read.

### 4. The behaviours

**answer** (`decisionAnswerScript`). One delegated `submit` listener on the document for `form.decide-inline`.
Kept exactly: the action read through `HTMLFormElement.prototype.getAttribute` (a field named "action" cannot shadow
it); the body is `new URLSearchParams(new FormData(form))`, so the shell's delegated key fill still fires on
`formdata`; the landed-pathname check; the card-local receipt (`.answered`) or the card's removal. Where the string
sets `location.href`, the port calls `loadDocument`. After the response body is parsed, and again before any fallback
navigation, it checks that the page was not replaced: a late answer touches nothing and loads nothing. (Aborting
never undoes an answer the server already took.)

**region** (`regionScript`, workspace-page arm only): both `check-progress` (fragment `check`) and `run-peek`
(fragment `peek`), path fixed as `/r/<run>?fragment=<name>` with the run from the work entry.

- Binding: the element by its id; for `run-peek` only when its closest `[data-live-run]` names the entry's run. Looked
  for at start and on every `standing-orders:workspace-rendered`. A bound element that left the document is let go
  and looked for again.
- `task-view.tsx` keys the attempt fragment by its run, so a new run's card replaces the old one (the HTML stays
  immutable within a run).
- Kept exactly: one fetch in flight and one more when a change arrived during it; `redirect: "manual"`,
  `cache: "no-store"`; a redirect, 401 or 403 loads `/login` as a document; the stamp line ("updated Ns ago" /
  "stale — retrying (Ns old)") every second; a fragment carrying `[data-region-stop]` stops the region and clears the
  stamp; no fetch at start (the page was just rendered).
- Change hints come from the page's one stream through a new `joinLiveRoom(room, listener)` export at the end of
  `live.ts` that returns its leave function: nothing is pushed onto `window.__soLiveRooms`.
- Stopping clears the interval, leaves the room and makes every continuation a no-op: a late response is dropped
  before any DOM write or redirect.
- Not ported (the task page never used them): the board's lane, focus and animation code, and the standalone
  `EventSource` arm.

**result** (C2: `reviewEvidenceScript` + `RESULT_REVIEW_SCRIPT`, task-page arm). Bound once per page to the result
the page opened with; its delegated handlers are scoped to that panel. Same storage keys and shapes, so a draft
written by one form is read by the other. Acceptance list, each with a test: `section` on the task page vs `tab`
elsewhere; keyboard tabs (arrows, Home, End); the hidden `tab` field of the comment form; diff modes; opening
Request changes on `#request-changes`; line and file pins (and the confirm on replacing a note); screenshot
feedback (attach, remove); which actions are enabled; the note tally; pruning old drafts; recorded-request receipts;
the request token (minted, rotated when the note, path, line or image changes, `sent` tracking, rotated on
`?conflict=`, cleared on a matching `?noted=`); the submit latch and its `pageshow` recovery; the evidence link.

- `?noted=` focus waits for `load` in the string; the port does it after mount when the document has already
  loaded, and cancels the delayed focus on stop.
- Reading position: not ported. In the workspace the window never scrolls (the page scrolls an inner pane and
  `useWindowStaysPut` holds the window at zero), so the string's `window.scrollY` record restores nothing there.
  The app's navigation already keeps each history entry's place, in the real pane, across Back and reload.
- Result tabs rewrite the address (`section`). `navigate.ts` gains `replaceAddress(url)`: it keeps
  `history.state` (the entry's name) and updates the address navigation compares against, so places keep being
  saved after a tab change. The task view's own local address rewrites use it too.
- Not ported: the chat-page arm (no result panel); chat pages keep the string. The mark that arm reads (a time,
  left when the result page is left, so a conversation opened from a result returns the reader to their place in
  it) is still left: on `pagehide` as in the string, and when the page is left in place.
- A read ahead of a result page writes nothing: "How it ran" is derived for it and saved only by an ordinary read.

Never started per page: the kit's own behaviour, `chromeScript` and the key fill stay the document's services.

### 5. One behaviour, two forms, kept the same

The strings stay for plain documents, password pages and other pages (chat, history, the result's own page). Each
behaviour has one table of observable cases that runs against both forms in happy-dom:

- answer: the string runs with its document listener captured and removed between cases (today's test never removes
  it).
- region: the workspace-page cases are shared; the standalone `EventSource` cases stay with the string.
- result (C2): new; the string has no unit tests today.
- The route test that asserts the check-progress target, its text and its fragment stays as it is.

Port and controller tests: after stop, a submit posts nothing, a live event fetches nothing and no timer fires;
open task A then task B answers with exactly one POST; a held page starts nothing and its confirmation starts once;
work added on a re-read starts and existing work is not restarted; a new run replaces the old region; a late
response after stop writes nothing and loads nothing; nothing starts on a sensitive page or in a scripted document.

Server tests: the four conditions of section 2 one by one (a covered page read with the header has `work`, no
`scripted`, `inPlace`; without the header it is exactly today's answer; a sensitive task with a result ships the
result string and no `work`; in C1 a covered script plus a result is a document); the document ships no page script
string when it ships `work`; the read-ahead purity test gains a task with a question and (C2) a result.

Door tests: a scripted document refuses navigate and confirm and accepts refresh; unknown work refuses navigate and
confirm; sensitive transitions on refresh, navigate and confirm stay as A1.2 has them.

`src/password-freshness.test.ts` pins function positions in files that name password checks: run it, and review any
pin that moved rather than regenerate it.

## Build order

- **C1**: sections 1 to 3, `answer`, both regions, the run-keyed attempt card. A task with a running build or an
  open question (and no result) opens in place. Journeys (`pages` group, desktop and phone): from Tasks open a task
  with an open question in place (a window marker survives), answer it (one POST, the answer form leaves the page),
  go Back; once the task has a result it still loads as a document. The `stop` group's journey opens its running
  build in place.
- **C2**: `result`, `replaceAddress`. A task with a result opens in place. Journey (`pages` group, the same one,
  continued on desktop): open it in place, switch a result section, pin a line (Request changes opens on it), type
  a note, go Back and Forward (the section, the pin and the draft are kept), reload (the same), leave through a
  form post (Accept).

Each is its own PR.

## Files

- New: `src/page-work-contract.ts` (the kinds of work, shared by the server and the app), `src/browser/page-work.ts`,
  `src/browser/work/answer.ts`, `region.ts`, `result.ts` (C2), and their tests.
- Changed: `src/browser-workspace.ts` (`work`, `scripted`), `src/server/chrome.ts` (`functional.app`, `withScript`),
  `src/server/render-tasks.ts`, `src/server/task-views.ts`, `src/serve.ts` (React arm, the header),
  `src/server/request-context.ts`, `src/browser/workspace-client.ts` (the header on page reads, `work` checked),
  `src/browser/app.tsx` (the door, the hook), `src/browser/live.ts` (`joinLiveRoom`, at the end),
  `src/browser/views/task-view.tsx` (the attempt key), `src/browser/navigate.ts` (C2), `scripts/app-e2e.mjs`.
- Not changed: `src/server/in-place.ts`, `GuardedHtml`, the sensitive rule, any route's checks.

## Safety self-review (AGENTS.md list), answered for the plan

- Check and write together: no server check moves. Every act (an answer, a note, Request changes) is the same request
  to the same route with the same CSRF field and mutation key; the server proves the person as before.
- Never widen implicitly: `inPlace` still needs an allowlisted route and no password field. A page becomes eligible
  only when every script it carries is declared covered; anything else keeps it a document, as today. The door gets
  stricter (a scripted document no longer leaves in place).
- Grant files, not folders: `work` is a closed list. A region's path is fixed and takes only the entry's run number;
  the server checks access to that run as it does today.
- Input does not choose what is trusted: no code, selector or address comes from the workspace JSON, and the app
  never evaluates text. The capability header only picks between two safe forms of the same page. Server HTML
  reaches the page through the same two sinks as today (`GuardedHtml`, the region swap).
- Approvals: none is made, minted or moved by this slice. Password pages stay their own document and keep their
  string path.
- Credentials: nothing new is stored or sent. Storage keys are the ones the string already uses.
- Tests never touch the person's real setup: happy-dom unit tests and scripted journeys on a throwaway fixture.
- Prove it against the real thing: the scripted journeys run the built app in a real browser.

## Later (not in this slice)

- Chat's page scripts, and the history and result pages.
- Form posts on the task page acting in place (Request changes, Complete).
- The attempt picker and the "newer result" Reload changing in place.

## Review findings folded in (Codex, plan v1, 2026-11-10)

1. High: check-progress is still drawn. → Ported as a region; the string and its route test stay (Why, 4).
2. High: an effect keyed only by the page cannot start work a re-read adds. → Reconcile by key (3).
3. High: an old tab, or a document that ran a string, could leave in place with listeners attached. → The capability
   header (2), the scripted-document door rule and the unknown-work rule (3).
4. High: a password page with a result keeps its script. → Condition 2 of section 2; the controller never runs on a
   sensitive page (3).
5. Medium: the attempt card kept the previous run. → Run-keyed fragment, card-bound region, late responses dropped (4).
6. Medium: reading position and local address rewrites. → Not ported, with the reason; `replaceAddress` (4, C2).
7. Medium: a lifecycle list per behaviour. → Section 4.
8. Medium: test boundaries and the C1/C2 split. → Section 5; all-or-nothing composition (1); separate journeys.
