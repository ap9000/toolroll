# The Toolroll kit

The rules every page follows, server HTML and React alike. The owner approved this look in the revamp prototype
(2026-11-02, "let's ship it"); the waves move each page onto it. A page built from the kit must look like it was
always there: copy what an existing kit page does, invent nothing the kit already has. youiyoux enforces it
(see [youiyoux](#youiyoux) at the end).

## Where it lives

| Part | File | Used by |
|---|---|---|
| Tokens (colour, type, radius, spacing) | `src/design/system/tokens/*.json` → generated `src/design/tokens.css`, `src/design/theme.css` | every page; `youiyoux sync` regenerates them |
| Look | `src/design/kit.css` (classes `k-*` only) | served after `console.css` (`STYLE` in `src/server/chrome.ts`) |
| Words and rules | `src/design/kit.ts` (status words, approval asks, terms, timing, icons, Settings groups) | both kits |
| Server pages | `src/server/kit.ts` (`Html` builders) | `sendScreen` pages and fragments `GuardedHtml` places |
| React views | `src/browser/kit/` (`KButton`, `KComposer`, …; import from `kit/index.js`) | the workspace views |
| Behaviour | `src/browser/kit/behavior.ts` | React kit components, and any kit markup the workspace places (`installKitBehavior` in `app.tsx`) |
| Behaviour off the workspace | `src/server/kit-standalone.ts` | a chromed server page answered without the workspace bundle: `sendScreen` adds it to the page's one nonce'd script when the page has kit behaviour markup, never on a sensitive page |
| Contracts | `src/design/system/components/*/…contract.json`, rules in `src/design/system/rules/` | youiyoux |

Both kits write the same markup for the same piece, so a server page and a React view never have two looks. Every
kit class starts with `k-`, so the kit never touches the older `console.css` and workspace rules the waves retire.
The React workspace's scoped preflight skips any element with a `k-` class (`src/browser/tailwind.css`).

## Tokens

Colour comes only from `--so-*` tokens. No hex, `rgb()` or new colours in a page. Paper `--so-paper` is every
surface; frame grey `--so-ground` is the rail only; dividers are 1px `--so-line` hairlines; fields and outline
buttons use `--so-field-line`; floating edges use `--so-overlay-line`.

The kit added these System tokens to Signal 1.0.0's (in `src/design/system/tokens`, generated into `tokens.css`):

| Token | Light / dark | For |
|---|---|---|
| `--so-needs`, `--so-needs-soft` | the warning amber and its wash | what waits on this person, only |
| `--so-field-line` | `#8f8f8f` / `#6b6b6b` (3:1 on paper) | the boundary that identifies a control (audit F6) |
| `--so-overlay-line` | `#b8b8b8` / `#4a4a4a` | the border of a popover, sheet, drawer or menu |
| `--so-ring` | ink | the 2px `:focus-visible` outline |
| `--so-scrim` | black 22% / 50% | what a blocking kit overlay dims the page with |

`kit.css` derives the rest from tokens: `--so-needs-ink`, `--so-live-ink`, `--so-done-ink`, `--so-fail-ink` (status
words on their wash, mixed toward ink for 4.5:1) and the motion vocabulary `--m-quick` 120ms, `--m-base` 160ms,
`--m-slow` 220ms, `--m-ease` (Signal's ease-out). No Signal token changed value: the older pages keep their look until
their wave moves them.

**No resting shadows.** Kit pieces never use one: floating things get a border, blocking ones the scrim. (The older
components still use Signal's shadow tokens; zeroing them waits for the waves that retire those components.)

**Type** (Geist; Geist Mono only for ids, versions, SHAs, paths and counts in tables, class `k-mono`; numbers
`k-num`):

| Use | Spec |
|---|---|
| Doc page title `.k-dh h1` | 600 24px/1.3, −0.02em (20px on a phone) |
| Settings section title `.k-sbody h2` | 600 20px/1.3 |
| Top bar title `.k-tb h1` | 600 15px/1.3 |
| Box heading `.k-slot-status h2` | 600 15px/1.35 |
| Section heading `.k-sec h3`, `.k-secthead h3` | 600 13px/1.3 |
| Group heading `.k-grp` | 600 12.5px |
| Body | 400 13px/1.5; reading paragraphs 14px/1.7, max 66ch |
| Label, button | 500 13px (`k-btn-sm` 12.5px) |
| Meta, muted lines | 12–12.5px `--so-muted` |
| Chip | 500 11.5px |

**One title per screen.** Never the same title twice in a row. On a phone, a page whose phone header already says
its title passes `same` (`docHeader({ same: true })`, `KDocHeader same`) or uses the Settings frame, which does it.

**Spacing** comes from the containers: list pages use the top bar `k-tb` (48px, 24px sides) then full-bleed rows
(24px sides); reading pages use `k-doc` (760px column, 22px gap); settings use `k-settings > k-snav + k-sbody`
(760px, 24px between sections). Gaps you add: 4 / 8 / 12 / 16 / 20 / 24px. Phone gutter 16px.

## Status: five words, one tone each

| Word | `kit.ts` `STATUS` | Tone | Meaning |
|---|---|---|---|
| Needs you | `needs` | amber (`k-chip needs`) | waits on this person |
| Running | `running` | blue (`live`) | happening now |
| Queued | `queued` | neutral | will happen |
| Finished | `finished` | green (`done`) | done or passed |
| Failed | `failed` | vermilion (`failed`) | broke; nothing waits unless it also needs you |

A task's headline (`task-status.ts`) maps onto them with `chipOfHeadline` / `statusOfHeadline` (server
`headlineChip`, React `KHeadlineChip`): Needs you and Ready for review wait on you; Planning and Building run;
Waiting, Queued and Stopped are neutral (something that waits on someone else is never amber); Complete is finished;
Failed is failed. Inside a Needs-you group the chip names the specific ask in the `ask` tone (`chip("Plan", "ask")`),
never the group's word again. A more specific running word (Building, Merging) keeps `live`; a more specific finished
word (Merged, Released) keeps `done`.

**Resource states** (a computer that builds, not work): `RESOURCE` Idle neutral, Building `live`, Offline `failed`.
Never amber.

**Amber means "waits on you", only**: the Needs-you chip, the 7px dot, the outline of a waiting `k-slots wait` box
and the `k-needs` panel. Never warnings, quota, caution, links, decoration or emphasis. The one verb that resolves a
wait is the ink primary.

**One ink primary per screen.** Every other act is outline or ghost. Navigation is never the primary. An irreversible
act is `danger` (vermilion words on paper, never filled).

## Pieces

Server builders are in `src/server/kit.ts`; React components in `src/browser/kit/`. The same row is one piece.

| Piece | Server | React | Notes |
|---|---|---|---|
| Icon | `icon(name)` | `KIcon` | the set in `kit.ts` `KIT_ICONS` |
| Button | `btn(label, { variant, sm, iconOnly, lead, href, type, docked })` | `KButton`, `KLinkButton` | 32px (sm 28px), 44px on a phone; faces: label → busy → done |
| Chip, status | `chip`, `status`, `headlineChip` | `KChip`, `KStatus`, `KHeadlineChip` | the five words |
| Count | `count(n, { ink })` | `KCount` | ink only for a Needs-you count |
| Tabs | `linkTabs` | `KLinkTabs`, `KTabs` | sections of one object; link tabs are addresses |
| Filters | `segLinks`, `iconSegLinks` | `KSeg`, `KLinkSeg` | views and filters of one list; as addresses when the server filters (List / Board as icons) |
| Text filter | `filterInput` | `KFilter` | narrows the rows already on the page; site search is ⌘K |
| Field | `field`, `input`, `textarea` | `KField`, `KInput`, `KTextarea` | the error sits next to the control, never a banner |
| Select | `select` | `KSelect` | native, with the chevron |
| Switch | `switchInput` | `KSwitch`, `KSwitchInput` | says its state in words |
| Form row | `formRow(label, hint, control, variant)` | `KFormRow` | `inline`, `top`, `wide` |
| Radio cards | `radios` | `KRadios` | |
| Facts, acts, notes | `facts`, `acts`, `note`, `notice`, `infoLine` | `KFacts`, `KActs`, `KNote`, `KNotice`, `KInfoLine` | a refusal is `notice` (role=alert); a neutral system line is `infoLine` |
| Empty state | `empty({ title, text, action })` | `KEmpty` | one sentence, one action |
| Disclosure | `disclose` | `KDisclose` | secondary detail only |
| List row | `group`, `row` | `KGroup`, `KRow` | chip · title (the row is the link) · one line · meta · one action |
| List page header | `pageHeader`, `phoneHeader` | `KPageHeader`, `KPhoneHeader` | |
| Reading page | `doc`, `docHeader` | `KDoc`, `KDocHeader` | |
| Approval box | `slots` | `KSlots` | four fixed slots in every state |
| Approve control | `approveForm` | `KApprove` | see [Approval](#approval) |
| Needs-you panel | `needsPanel` | `KNeedsPanel` | waits that aren't tasks, on their own page |
| Overlays | `overlay` + `overlayTrigger` | `KOverlay`, `useKMenu` | popover, drawer, sheet, menu |
| Timing rows | `timing` | `KTiming` | steps on one elapsed-time axis |
| Progress line | `steps` | `KSteps` | a single object's fixed stages (a task: Plan · Approval · Build · Checks · Ready), the current one's reason under it |
| Board | `board`, `boardCol`, `card` | `KBoard`, `KBoardCol`, `KCard` | a list's rows as columns, the optional view beside List; one column at a time on a phone |
| Not found | `notFound(path)` | `KNotFound` | inside the shell |
| Settings frame | `settingsShell` | `KSettingsShell` | Overview + the eight groups (`SETTINGS_GROUPS`) |
| Settings section | `settingsSection` | — | heading (+ muted state) · one muted lead · rows; `id` is the anchor |
| Settings link rows | `settingsLink`, `settingsLinks` | — | icon · title (+ "1 item needs you") · one status line · chevron; the whole row is the link |
| Settings record | `settingsRecord` | — | a session, token, person or device: title · one line · when · one action · what opens under it |
| Section form | `kitSectionForm` (`settings-kit.ts`) | — | see [Section saves](#section-saves) |
| Phone dock | `dock(primary)` | `KDock` | the screen's one primary on a phone |
| Composer | `composer`, `sendButton` | `KComposer` | see [Composer](#composer) |
| Page outside the shell | `outPage`, `outField` | — | sign in, first account, invite, an error; see [Outside the shell](#outside-the-shell) |
| Guided steps | `checklist` | — | the first run's steps: mark, step and one line, its one action |
| Ideas | `ideas` | — | words a tap drafts into a composer (`data-k-draft`); a link without script |

**Row anatomy** (`k-row`, 48px min, hairline below): chip column (96px) · title (500; 600 when it waits on you;
the whole row is the link) · one muted line · meta (project, age in `k-num`) · one action (124px column, outline
`sm`, 108px min, always visible, same place every row). A refusal sits under the row (`message`). Phone: title on
top, chip under it, the line below, the action on the right, meta hidden. Lists are rows between hairlines under
`group` headings, never cards.

**List tools.** A list page's top bar holds, in order: the title, the project filter (`segLinks`, when there is more
than one project), the status filters with their counts, then on the right the text filter, the List / Board switch
and the page's one primary. On a phone they become one row under the header (`k-tbp`): selects for project and status,
and the switch. A Needs-you count is ink only in its own filter; zero is muted.

**Two page shapes.** List pages (Home, Tasks, Flows, Agents, Projects, Search, Chat, Settings) have the desk top
bar. Reading pages (a task, a release, a run, a record, an agent, New task, a project, setup) have no desk top bar:
the phone header, then `doc(docHeader(…), …)`.

## Phone (760px and narrower)

The console's one breakpoint (the prototype drew at 640px; the app has always switched at 760px, and two
breakpoints left controls at 28–32px in between, audit B M4). Every standalone kit control is 44px; every field
has 16px text; no horizontal page scroll at 390px. The top bar becomes the phone header (back or menu · title ·
one trailing action). The screen's one primary lives in the dock (`dock`, `KDock`); the card's copy of it is
hidden on a phone when it is marked `docked`. The Settings section nav is hidden, so a settings page links its
sections from the body.

## Composer

The message box is one soft rounded container (22px radius, hairline `--so-field-line`, no shadow, no inner boxed
fields). Its textarea grows from `rows` to `maxRows` (8) lines and then scrolls. Focus shows on the box (ink border
and a faint ink ring), never on the textarea. One bottom row inside it: a small **+** (Attach a file, Mention a task,
Choose project; only what this box supports), the project as a quiet chip that opens a menu (a bottom sheet on a
phone), any small controls (`before`), then the **round send**: an arrow up, 34px drawn and 44px to touch on a
phone, muted while the box is empty, ink once it has text. `gate` (a message box) marks it `aria-disabled` while
empty; a form's send stays pressable so an empty press says what is missing next to the box. With Stop it carries
its twin: the box's `working` class swaps them and the icon morphs (160ms, none under reduced motion). No "Enter
sends" hint. On a phone the text is 16px; with the keyboard up (`visualViewport` → `html.kb-open`, `--kb`) a
docked composer (`k-composer-dock`) rides just above it and the dock steps aside. A refused send keeps the words in
the box with the reason under it (`composerError`). A note can follow the box's switch without script (`k-on-note`,
`k-off-note`). A form whose send the phone dock carries (`k-dock-send`, as New task) hides the round send on a phone.

## Outside the shell

Sign in, the first account, an invite, signed out and the error page stand alone (`outPage`): the brand, one 380px
column on paper with the one h1, an optional muted line, the form or the facts, and a foot line under a hairline. They
carry no script and no session; every control is plain HTML. A refusal sits under the field it is about (`outField`
`error`: the field is aria-invalid, described by the hint and the error, and focused); a refusal about the whole form is
a `notice` above it. The submit is the one primary, full width (`k-wide`). A refusal's words come from many callers, so
the `k-refusal` wrapper capitalises their first letter.

A page with steps (the first run) uses `checklist`: done steps read muted with a check, a step being checked shows a
static ring, and the next required step's action is the screen's one primary (`docked`, so the phone dock carries it).

## Motion

Only the kit's durations: `--m-quick` 120ms (colour, press, hover), `--m-base` 160ms (popovers, a box changing state,
a message appearing), `--m-slow` 220ms (drawers, sheets). One curve. No bounce, no overshoot, nothing over 220ms.
Do not animate running state (no pulses, sweeping bars or spinners on running checks: a static ring says running;
the spinner is only the busy face of a button you just pressed), focus rings, layout on first paint, scroll
position, or anything on a timer nobody caused. Reduced motion changes presentation only: state timing, gates and
the order of events are identical.

## Focus, overlays, outcomes

- Every floating thing goes through the kit overlay (`overlay`/`overlayTrigger`, `KOverlay`, `openMenu`):
  `role=dialog`, `aria-modal`, the app behind `inert`, Tab kept inside, Escape and the labelled Close and the scrim
  close it, focus returns to the trigger (or, if it is hidden at this width, a visible twin, then the dock's
  primary). One at a time, except an approval asked from inside an open overlay: its password popover opens over
  it, Escape closes only the popover. A popover and a menu become a bottom sheet on a phone. Sheets are a phone
  pattern; at a desk use a drawer or popover.
- Focus is a 2px ink `:focus-visible` outline, never removed, never animated.
- After an act, keep focus on the same control. There are no toasts: outcomes appear in place (the button's face,
  a row leaving, a notice under the control).
- A refusal must be seen: in place, with what didn't change ("Nothing changed."). The draft stays.
- Every act shows its busy face ("Starting…", "Sending…", "Saving…") until the outcome is known.

## Approval

Anything that asks for a decision uses the slots (`slots`, `KSlots`): status (chip + heading) · supporting text ·
actions · terms, plus the error slot, the same in every state (waiting, approved, automatic, refused) so nothing
moves. Waiting = `wait` (amber outline). Give the slots `data-approval="<digest>"` on a server page:
`GuardedHtml` disables a kit approval form (`form.k-approve`) whose approval changed under an open edit, as it does
for the console's ceremonies.

**What a page shows** (`approvalAsk(kind, facts)` in `kit.ts`; `approveForm`, `KApprove`):

| Kind | For | Shows |
|---|---|---|
| `none` | answer, accept, retry, merge, remove a hold | one click |
| `standard` | approving standard work | the password, unless Passwordless is on or a password typed on this computer in the last 15 minutes stands in (`facts.remembered`) |
| `step-up` | anything else that needs a person's proof | the password, unless Passwordless is on |
| `way-in` | invites, tokens, sign-in methods, anything that creates or widens a way in | always the password typed now, even with Passwordless on or a remembered password |

An automatic-approval rule (`facts.automatic`) shows no button: the box says "Approved automatically" and the rule.
Never for `way-in`. The terms line says which applies (`termsOf(kind, facts)`).

`facts` are what the server read for this page: `passwordless` from `passwordlessRendering()` (`approvalFactsNow`
fills it), `remembered` from the freshness preview (`scope.ts` `freshnessFor(…, true)` inside the act's allowlisted
`withFreshness`), `automatic` from the project's rule. The kit never reads freshness itself: the page that does is a
new place for the password-freshness tripwire (`src/password-freshness.test.ts`), reviewed by a person when it
lands. **These decide only what the page shows.** The server proves
the person, the freshness and the exact scope again when the form arrives, in the same transaction as the write;
a page that showed one click for an act the server then refuses says so in place. The password field is named
`token` with `autocomplete="current-password"`, like every ceremony.

**An approval covers exactly what was shown.** Take one validated snapshot of the form when its button is pressed;
build the terms (the panel and the password popover) and the submitted value from that snapshot, never from live
fields. Invalid values are refused next to their field before any popover. One pending act per form: a second press
does nothing until the first settles. However a password popover goes away (Close, Escape, the scrim, a navigation
or re-render), it settles as cancelled (`onClose`), so the pending guard is released.

## Section saves

A settings section that saves is one `kitSectionForm` (`src/settings-kit.ts`), drawn from its proof inventory row
(`src/settings-proofs.ts`) so the proof field is exactly the one its handler reads. Without script it is a plain form:
the proof field shows in place and Save posts. With the workspace's kit behaviour (`src/browser/kit/section-forms.ts`):

- `gate`: Save shows only once something in the section changed; the bar says what changed ("Quality: Strict ·
  Asks for your password."). The section edited last carries the one ink Save; another changed section keeps an
  outline Save. Without `gate` (an act: Invite, Remove, Cancel invite) the button always shows.
- Save takes one snapshot of the form; the password popover's terms and the posted values come from it.
- The password is asked only when the server rendered a proof field (Passwordless and CSRF-only rows render none)
  and, with `proofWhen`, only when the snapshot posts that value (Full access, approve releases automatically).
- One pending save per form. The snapshot posts with fetch; a handler's refusal (`?problem=`, a 4xx refusal page)
  shows next to Save with the edits kept; success opens the page the server answered with. Anything that proves
  nothing (a network failure, a server error, a sign-in page) is unconfirmed: the page opens again with
  `?unconfirmed=<form id>` and `kitSectionForm` draws "Couldn't confirm whether this saved" in that section.
- Saving while other sections have unsaved changes asks first, in place; leaving with changes asks through the
  browser. Nothing is kept in Web Storage.
- `native`: the answer is a page of its own (a one-time secret, a review, another site), so it posts as a navigation.

## Words

Conventional words, sentence case, no metaphors, no jargon, no exclamation marks ("Connected messaging", "Receives
alerts", "Spend limit"). Outcomes say what happened and what didn't. Roles read **Can view** and **Can manage and
approve**. Busy faces end in "…".

## youiyoux

The kit is the youiyoux System `toolroll` (`youi.config.json`; this product follows it, `youi.project.json`):
Signal 1.0.0's tokens plus the kit's, the kit components' contracts and the rules in `src/design/system/rules`.
youiyoux generates `src/design/tokens.css`, `src/design/theme.css`, `src/design/SYSTEM.md`, the agent skill and the
AGENTS.md block from them; never edit those by hand.

- Change a token, contract or rule in `src/design/system/`, then `npx youiyoux@0.1.21 sync` and commit what it wrote.
- Before finishing UI work: `npx youiyoux@0.1.21 check --diff origin/main --strict` (and `check --baseline` for the
  whole repo: `youi.baseline.json` holds the violations that predate the kit). The pull-request job runs the
  same and fails on drift a change adds. A release never waits for or fails on that job (`release.ts`
  `ADVISORY_PR_CHECKS`, by its exact name and workflow file).
- The screens youiyoux compares wave by wave are listed in `.youi/screens/screens.json` (tracked; the pictures
  beside it are not). Capture them from a demo fixture with `npx youiyoux@0.1.21 screens capture --base <url>`.
