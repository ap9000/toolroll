# Pages that change in place, and a Home you can decide from

Status: plan v1, 2026-11-10. Not built. Awaiting a read-only Codex review before any building.

## Why

Alex's words: "How do we get the site to be live instead of refresh pages every click??", then "Make a nice animation
and instant feeling together. And ok do 1 and 2 in parallel", and "Yes do the approval from home."

What is true today (read at `762e139a`):

- Content already updates by itself: one `EventSource` per page (`GET /live`), rooms, and "change" hints that make a
  part re-read itself (`src/browser/live.ts`).
- What reloads is moving between pages (plain links) and most buttons (native `method="post"` forms that answer with
  a redirect).
- One React app draws every chromed page (`WorkspaceApp` in `src/browser/app.tsx`; `ViewHost` picks the view; pages
  the server draws arrive as `workspace.pageHtml`).
- Every chromed page that is not a one-time-secret page can already be read as data: `GET <path>?format=workspace`
  answers the `BrowserWorkspace` JSON (`src/serve.ts`, the `requestFacts.workspaceRead` arm), with an ETag.
- A page that shows a password field is `sensitive`: it opens no live connection and runs one script only.
- Some pages carry their own page script (`functional: { script }`: chat, flows, recipes, results, history, a task
  page with a running check or an open question, some Settings pages, the queue). That script runs once per document.

Two parts, built in parallel on two branches, both from `origin/main`.

- **Part 1, `live-nav`**: pages change in place, with a transition, and feel instant.
- **Part 2, `home-act`**: Home is rebuilt to the approved mock, and a plan is approved from Home without leaving it.

## What a person notices

| Before | After |
| --- | --- |
| Every click on a menu item or a row reloads the whole page. | The menu, the message box and the live connection stay. Only the middle changes, with a short fade and slide. |
| A click waits for the server before anything moves. | The clicked item is marked at once. The page is usually already fetched, so it shows at once. |
| Back reloads and loses the scroll position. | Back shows the page at once, at the place it was left. |
| Home lists what needs you. Each one opens another page. | Home shows the open step of the selected task. A plan is read and approved there, and the next one opens. |
| Chat is not in the menu. New task is a pencil. | Chat is in the menu under Home. The lead's last message sits above the message box. New task is a plus. |

Sign-in, password pages and pages with a one-time secret still load as their own page. So do pages that carry a page
script, until that script is moved into the app (listed under "Later").

---

## Part 1: pages change in place (`live-nav`)

### 1.1 The rule for which pages may change in place

The server decides, never the client. `BrowserWorkspace` gains one field:

```ts
/** True when this page may replace another without a document load: it shows no password field or secret and carries no page script. */
inPlace: boolean;
```

Set in the one place the workspace is built (`src/serve.ts`, next to `sensitive`):
`inPlace = !sensitive && functionalScript === ""` where `functionalScript` is the same value the document would run
(`s.functional?.script ?? ""`, or `RESULT_REVIEW_SCRIPT` on the result arm). A `forceSensitive` page answers no
workspace at all, as today.

The client follows a link in place only when **both** the page being left and the page being entered say
`inPlace: true`. Anything else is a normal document load (`location.assign`). So a sensitive page is always its own
document, on the way in and on the way out, and `setLiveQuiet` keeps its present meaning.

### 1.2 Three kinds of workspace read

Today every `?format=workspace` GET is passive (it does not extend the session, `src/serve.ts:872`). Part 1 names the
purpose in a request header, `x-toolroll-read`:

| Value | Sent when | Extends the session | Mints an approval nonce | Other side effects |
| --- | --- | --- | --- | --- |
| absent or `poll` | the page re-reads itself (today's behaviour) | no | as today | as today |
| `navigate` | a person clicked a link or pressed Back | yes, exactly like the HTML GET of the same URL | as the HTML GET does | as the HTML GET does |
| `prefetch` | the pointer rests on a link, or a touch starts on it | no | no (`mintNonce: false`) | none |

- `navigate` gives the JSON read the session effect of the HTML read of the same path, no more. The header never
  changes who is signed in, which route answers, or what the route allows. Any other header value is treated as
  `poll`.
- `prefetch` is answered only for an allowlist of route ids proven free of side effects on GET: Home, the Tasks list,
  Projects, Agents, Search, and the task page (with `mintNonce: false`). Every other route answers a prefetch with
  `204` and the client simply does not have that page ready. The builder proves each allowlisted route by reading its
  GET handler for writes (seen marks, one-time notices such as `receipt`, nonce mints) and adds one test per route
  that a prefetch changes nothing in the store and does not move the session's idle time.
- A page shown from a prefetch is always confirmed by one `navigate` read before it counts as current (1.4). A form
  that needs a nonce is never sent with the `"unminted"` value: the approve control stays disabled until the
  confirming read lands.

### 1.3 The navigator

A new file `src/browser/navigate.tsx`. The mount in `src/browser/app.tsx` renders `<Navigator initial={initial} />`
instead of `<WorkspaceApp initial={initial} />`.

```tsx
function Navigator({ initial }) {
  const [page, setPage] = useState({ workspace: initial, epoch: 0 });
  // …listeners, see below…
  return <WorkspaceApp key={page.epoch} initial={page.workspace} />;
}
```

A new page is a new `epoch`: `WorkspaceApp` remounts with the new workspace as its `initial`, so every piece of state
that derives from `initial` (draft scope, live task, the rooms it follows, the CSRF value in `FormToken`) is correct
by construction, with no partial-update paths. The live connection (`LiveHub`) lives outside React and stays open;
rooms are left and joined by the unmount and mount effects that exist today.

What must not blink on a remount (the builder checks each and keeps it stable): the sidebar's scroll and open groups,
the message box text (it is already restored from the saved draft per scope), the phone header. If remounting the
whole app makes the menu or the message box flicker, the fallback inside this plan is to lift `Rail` and the composer
above the keyed part; the keyed remount of the content column stays.

One capture-phase `click` listener on `document` decides. A click is handled in place only when all hold:

- left button, no modifier key, `event.defaultPrevented` false;
- the target is inside an `<a href>` with no `target`, no `download`, no `data-full-load`, no `rel="external"`;
- same origin, and not a hash-only change on the current path;
- the path is not on a short deny list kept in one constant (`/sign-in`, `/sign-out`, `/login`, `/assets/`,
  `/artifacts/`, `/terminal`, any path the server marks as a file download);
- the current workspace says `inPlace: true`.

Then: mark the clicked item pressed at once (1.5), read the page (`readPage(href, "navigate")` in
`src/browser/workspace-client.ts`, which adds `format=workspace` and the header), and:

- JSON with `inPlace: true` → `history.pushState`, set `document.title`, swap inside a view transition (1.5), move
  focus to `#workspace-main`, say the title in a polite live region, scroll to top;
- anything else (redirected, not JSON, `inPlace: false`, 401/403, 5xx, network error, more than 8 s) →
  `location.assign(href)`. The browser then does what it does today, including sign-in.

Forms are not touched by Part 1. A native post still loads a document.

Back and Forward: `popstate` reads the entry's URL the same way (from the cache when present) and swaps without
`pushState`. `history.scrollRestoration = "manual"`; each entry's scroll offset of `#workspace-main` (and the
window) is saved in `history.state` on the way out and restored after the swap. An entry that was a document load is
handled by the browser as today.

Two navigations at once: a new click aborts the read in flight (`AbortController`) and skips a running transition
(`transition.skipTransition()`); only the last click wins.

### 1.4 Instant feel

- **Prefetch.** A link is prefetched when the pointer has rested on it for 65 ms, on `touchstart`, and on keyboard
  focus. At most two prefetches run at once. Results live in memory only (a `Map` of at most 20 pages, each good for
  10 seconds, never written to storage), and the whole map is dropped on any `change` hint for the `workspace` room
  and on any in-place act (Part 2). `Save-Data` and a hidden tab turn prefetch off.
- **Show, then confirm.** On click, a prefetched page is shown at once and the `navigate` read runs behind it; when it
  lands, the page is replaced by the confirmed one without a transition (React keeps the same `epoch`; the workspace
  goes through the existing "newer workspace" path in `useWorkspace`). Without a prefetch the click waits for the
  `navigate` read.
- **Never a blank wait.** The clicked menu item or row is marked the moment it is pressed. If the read takes longer
  than 150 ms, a 2px ink line runs along the top of the content column until it lands. No spinner, no skeleton.

### 1.5 The transition

Only the content column moves. The sidebar, the phone header and the message box hold still (they already have their
own `view-transition-name` with `animation: none` in `src/server/console.css`).

- Same level (menu item to menu item): old content fades out in 80 ms, new content fades in over 160 ms. No movement.
- Going deeper (a list row to its page): new content fades in and moves 8px from the right over 200 ms,
  `cubic-bezier(.2, .8, .2, 1)`; the old fades out in 80 ms. Back and Forward to a shallower page mirror it (from the
  left). Depth is the number of path segments, decided in one small pure function with tests.
- Done with `document.startViewTransition(() => flushSync(() => setPage(next)))`, with a class on `<html>` for the
  direction (`so-nav-deeper`, `so-nav-back`, `so-nav-same`) that is removed when the transition finishes. The
  existing cross-document rules (`@view-transition { navigation: auto }`, `so-page-leave`, `so-page-arrive`) stay for
  document loads, and are retimed to the same numbers so an in-place change and a document load look alike.
- `prefers-reduced-motion: reduce`: no animation at all (the existing rule is extended to the new classes). A browser
  without `startViewTransition`: a plain swap.
- A transition never delays input: the swap happens in the transition's first frame and the animation is under
  220 ms in every case.

### 1.6 Things the builder must verify, not assume

1. Everything that runs once per document and serves the chrome (`chromeScript()`, `WORKSPACE_MOTION_SCRIPT`,
   `installKitBehavior`, the mutation-key fill for forms) works for content that arrives later. Where a script binds
   to elements at load instead of delegating, either it is made to delegate or pages that need it are not `inPlace`.
   The mutation key in particular: a native form on a page shown in place must still carry `x-toolroll-key`'s form
   equivalent on protected loopback installs; one test posts such a form after an in-place change.
2. A page's `refreshUrl`, `csrf`, `notices` and `receipt` are the new page's, and a one-time `receipt` shows once.
3. `/chat` keeps its own ETag validator; a `navigate` read of it is not confused with its poll.
4. The phone layout: the phone header title, the bottom message bar above the keyboard, and the drawer menu closing
   on an in-place change.
5. The terminal page, the first-run pages and the sign-in pages are never entered in place.

### 1.7 Files (Part 1 owns these)

- new `src/browser/navigate.tsx`, `src/browser/navigate.test.ts`, `src/browser/nav-depth.ts` (+ test)
- `src/browser/app.tsx`: the mount (last lines) and nothing else, unless 1.3's fallback is needed
- `src/browser/workspace-client.ts`: `readPage` added at the end
- `src/browser-workspace.ts`: the `inPlace` field only
- `src/serve.ts`: the read-purpose fact, the session touch for `navigate`, the prefetch allowlist and `204`,
  `inPlace`
- `src/server/request-context.ts`: `readPurpose`
- `src/server/task-views.ts` / the task route: `mintNonce: false` on a prefetch
- `src/server/console.css`: the transition rules
- tests: session-touch table (poll no, prefetch no, navigate yes), prefetch-changes-nothing per allowlisted route,
  sensitive page never in place (both directions), fallback to document load on each listed doubt, Back restores
  scroll, reduced motion.

---

## Part 2: Home you can decide from (`home-act`)

### 2.1 What Home shows (the approved mock)

Desktop, something needs you:

- Heading "N tasks need you" said once; under it one quiet line "1 building now · 1 queued".
- One project filter (a select), not a row of tabs.
- Left: the list, grouped by what is asked: **Approve a plan**, **Answer a question**, **Something went wrong**,
  **Review a result**. A group heading carries its count. A row is one link: title, then project and age. Only a
  failed row has a reason, in red. No chip per row.
- Right: the open step of the selected task, the same block the task page shows, with its one action.
- Bottom: the lead's last message as one line that links to the chat, then the filled rounded message box
  ("Message the lead").
- Menu: **Chat** under Home. New task is a plus beside the brand.

Nothing needs you: what is running, what finished today, and the message box in the middle of the page.

Phone: the next one as a card with its one action, then the same grouped list; the last-message line and the message
box at the bottom, with a round plus for New task.

Colours: no amber anywhere. Ink marks what waits on the viewer (solid "Needs you" chip, 1px ink outline on the open
step, one solid ink button). Blue only running, green only passed, red only failed. Hairlines, not nested boxes. No
internal codes, paths or ISO times.

### 2.2 Data

`src/server/home.ts` (`homeView`) gains, in `BrowserHomeView`:

- `groups: { key: "approve" | "answer" | "wrong" | "review"; label: string; count: number; rows: BrowserHomeRow[] }[]`
  built from the same four `workIndexPage` reads as today; `count` is the group's true total, `rows` the first
  `HOME_NEEDS_SHOWN` across groups as today.
- on a row: `ask: "approve" | "answer" | "wrong" | "review"`, and `reason: string | null` (set only for a failed
  row). The per-row chip is dropped from the view.
- `lastLead: { text: string; age: string; href: string } | null`: the lead's last message in the viewer's main
  thread, plain text, cut to one line server side. `null` when there is none or the viewer may not read it.
- `finishedToday: BrowserHomeRow[]` for the clear state (from the existing completed read).

The menu's Chat item and the plus are in `Rail` (`src/browser/shell.tsx`), for every page.

### 2.3 The open step on Home

When a row is selected, Home reads that task's own page data: `GET /t/<id>?format=workspace` (the existing read, which
mints the approval nonce today; "How the two parts stay apart, and meet" says how it is sent once Part 1 is merged).
It renders the task view's open-step component from that data. The open-step component and `ApprovalBox`
are exported from `src/browser/views/task-view.tsx` and reused unchanged, so Home and the task page cannot drift.

Why read the task page instead of putting approval data in Home's rows: one source of truth for the plan, the digest
and the nonce; no thirty nonces minted for thirty rows; every server rule that decides whether a plan can take a yes
(`closedDoor`, the consent door, a broken revision) is the task page's rule, unchanged.

**Home never shows a password field.** Home stays a live page. So:

- If the task's data says the approval is one click (`approvalAsk(kind, facts)` is `"click"` or `"automatic"`: the
  session is passwordless, or the password is remembered on this computer, or the local owner is eligible), Home
  shows the plan and the solid **Approve** button.
- If it says `"password"`, or the task's workspace is `sensitive`, Home shows the plan and one link, **Review the
  plan**, to the task page, marked `data-full-load`. The password is asked there, as today.

"Request changes" is a link to the task's chat (`taskChatHref`), as on the task page.

### 2.4 Approving in place

The client posts the same form the task page posts, with `fetch`:

```
POST /t/<id>/approve
headers: keyed({ "x-toolroll-act": "in-place", accept: "application/json" })
body:    csrf, nonce, digest, rebuild?, return=next
```

The server route, its scope (`step-up`), its freshness rule and every proof in `case "approve"`
(`src/server/tasks.ts`) are unchanged: cookie session only, the nonce consumed once and bound to who saw which digest
of which task, the digest equal to `approvalFormDigest(...)`, a password required unless the session is passwordless
or fresh or the local owner is eligible, then `approveScope`. An in-place approve never carries a `token` field; if
the server needs a password it answers the refusal it answers today.

The only server change is the **shape of the answer** when `x-toolroll-act: in-place` is present on this route:

- success → `200 {"ok":true}` instead of `303`;
- a problem → the status it has today with `{"ok":false,"problem":"<the same words>"}` instead of a page or a
  redirect that carries them.

The header chooses the answer's shape only. It is read in one helper, `answersInPlace(request)`, added at the end of
`src/server/http.ts`, and used in `approvalProblem` and at the success redirect. Anything the dispatcher answers
before the handler (signed out, step-up needed, rate limited, CSRF or key refused) is answered as today; the client
treats any answer that is not this JSON as "open the task page" and does a document load of `/t/<id>`.

After a yes:

- the row leaves the list (height and opacity over 200 ms; none with reduced motion), the next row is selected and
  its step opens; a line "Approved. The build starts." shows through the existing `receipt`/notice path, not a new
  toast;
- Home re-reads itself (`WORKSPACE_NUDGE`) and drops any prefetched pages;
- after a problem, the words show in place under the button with "Nothing changed.", and Home re-reads the task's
  data for a fresh nonce. The button is disabled while a post is in flight, and a nonce is used for one post only.

The task page's own approve button uses the same in-place post when the ask is one click (it stays on the task page
and the step changes through the live path). The password case on the task page keeps its native form.

Answering a question from Home works in place today (`/d/<id>/answer`) and is kept; its refusal words move to the
same JSON shape only if that is a small change, otherwise it stays as it is.

### 2.5 Files (Part 2 owns these)

- `src/server/home.ts`, `src/browser/views/home-view.tsx` (+ tests), Home's CSS
- `src/browser-workspace.ts`: `BrowserHomeView` and `BrowserHomeRow` only
- `src/browser/shell.tsx`: `Rail` (Chat item, plus)
- `src/browser/views/task-view.tsx`: export the open step and `ApprovalBox`; in-place post for the one-click case
- new `src/browser/act.ts` (+ test): `postInPlace(action, fields)` → `{ ok: true } | { ok: false, problem } |
  { ok: "elsewhere" }`
- `src/server/http.ts`: `answersInPlace` at the end; `src/server/tasks.ts`: the two answer sites in `case "approve"`
- tests: the approve route's proofs are identical with and without the header (same table run both ways: stale
  nonce, wrong digest, wrong viewer, password needed, spent nonce, closed door); Home renders no `input
  type="password"` in any state; a `"password"` ask renders the link with `data-full-load`; a refusal shows its
  words and re-reads; the scripted journey approves a plan from Home.

---

## How the two parts stay apart, and meet

- Different files, except `src/browser-workspace.ts` (different types) and CSS (different files). Whichever merges
  second rebases.
- Part 2 does not need Part 1: its acts use `fetch` and the existing nudge. Part 1 does not need Part 2.
- Meeting points, fixed here so neither side guesses: the attribute `data-full-load` on a link (Part 1 honours it,
  Part 2 sets it on the password link); the header names `x-toolroll-read` (Part 1) and `x-toolroll-act` (Part 2);
  after an in-place act Part 2 dispatches the existing `WORKSPACE_NUDGE`, and Part 1's prefetch map listens for it.
- With both merged, Home's read of the selected task is sent as a `prefetch` while the pointer moves down the list
  and as a `navigate` read when a row is selected (that read mints the nonce the Approve button uses).

## Safety self-review (AGENTS.md list), answered for the plan

- **Check and write together.** The approve route is unchanged: nonce consume, digest check, person proof and
  `approveScope` run in the same handler as today. The in-place answer is written after them.
- **Never widen implicitly.** `inPlace` is opt-in per page from the server and false for any page with a password
  field or a page script. Prefetch is an allowlist of route ids; everything else answers `204`.
- **Grant files, not folders.** Not applicable (no file access changes).
- **Don't let input choose what's trusted.** `x-toolroll-read` chooses only session-touch-or-not (never more than the
  HTML GET of the same URL gives) and mint-or-not (never more). `x-toolroll-act` chooses only the answer's shape.
  Neither is read by any authorisation decision.
- **Approvals mean a person's yes to exactly this.** The nonce is still minted when the person is shown this digest
  of this task, used once, and bound to them. A prefetch mints nothing. Home shows the same plan block the task page
  shows, from the same data, before the button can be pressed. No model and no script approves: the post is sent
  only from a click on the Approve button.
- **Credentials go only where they belong.** Home never renders a password field and an in-place post never carries
  `token`. The password is typed only on the task page, a sensitive document with no live connection, as today.
- **Tests never touch the person's real setup.** All tests use the fixture store and fixture sessions.
- **Prove it against the real thing.** The scripted journey (`--journeys scripted`) gains: change pages in place and
  check the live connection id is the same before and after; approve a plan from Home; open a password approval from
  Home and check it is a document load with no live connection.

## Later (not in this build)

- Move the page scripts of the task page (`regionScript` check progress and peek, `decisionAnswerScript`) and of
  Chat into the app, so those pages change in place too. Until then they load as documents with the same fade.
- Other acts in place (accept a result, retry a failed build, queue acts), one route at a time with the same
  answer-shape rule.
- Home's list carrying flow, release and setup decisions.

## Open questions for review

1. Is the keyed remount of `WorkspaceApp` the right cut, or should `Rail` and the composer sit above it from the
   start?
2. Is a request header the right carrier for the read purpose, given that `navigate` extends the session? Is there a
   way a background script on an open tab could keep a session alive with it that the HTML GET does not already
   allow?
3. Does reading `/t/<id>?format=workspace` from Home (which mints a nonce per selection) put pressure on the nonce
   store (cap 500, 15 minutes) with arrow-key browsing of a long list? Should selection reads be unminted, with one
   minted read on pointer-down of the Approve button instead?
4. Any GET in the prefetch allowlist with a side effect this plan missed.
