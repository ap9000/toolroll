# The Console — design system v4, "Signal"

Rebuilt on 2026-09-27 (v4) on the Raycast and Arc canon, with Linear and
Vercel as the craft bar. **`DESIGN.md` at the repository root is the authority
for the visual system**: tokens, type, shapes, depth and components, written
from the built code. This document keeps what `DESIGN.md` does not: the
console's voice, how its pages are structured, and how a change lands.

The palette lives once, in `THEME_LIGHT` / `THEME_DARK` in `src/serve.ts`.
The server pages (`STYLE`), the React workspace (`src/browser/workspace.css`)
and the shadcn components (`src/browser/tailwind.css` maps Tailwind's names
onto it) all read those tokens. The older `design/` package still carries the
v2 tokens (IBM Plex, amber). It is not part of the build; bring it over before
using it again.

## 1. Voice

- **Quiet until a person is needed.** A neutral grey frame with paper sheets
  inset into it; hairlines, not boxes; whitespace does the grouping. A screen
  holds many rows and stays calm.
- **Ink is what you can do.** Every button, link and choice a person can take
  is ink: a black button in light, a near-white one in dark. Secondary acts
  are paper pills with a one-pixel shadow ring.
- **Accent means one thing.** The ink accent (`--so-signal`, which
  `--so-attention` and the console's `--brand` point to) marks what waits on a
  person: the needs-you count, a "Needs your decision" badge, and the one act
  that resolves a screen (approve, answer, inspect the result). Its only other
  jobs are focus, the caret, selection and the brand mark. Cards, frames,
  seals, headings and list actions stay neutral; a list's actions are outline
  buttons and the badge carries the colour. A recommended option is never
  accent, and accent never means failed.
- **Status keeps its own hue.** Failure is vermilion, setup trouble is amber,
  live is blue, done is green, each as a soft badge or a small dot, and the
  word always carries the meaning.
- **Two faces, strictly cast.** Geist is the human voice: titles, sentences,
  section headers, chips. Geist Mono is every machine fact: ids, counts,
  models, clocks, digests, paths, keys. Mono is never a costume for
  "technical", and headings are never mono.
- **Honest words.** needs you · building · queued · waiting · done;
  measured or unmeasured, never a summed $0; a stage and a clock, never a
  percent.
- **Drawn icons.** One stroke weight on a 24-unit grid, from one set
  (lucide in the workspace), never a glyph or an emoji.

## 2. Tokens

The full list with light and dark values, contrast and roles is in
`DESIGN.md` (Colors). The load-bearing ones:

| Token | Light | Dark | Role |
|---|---|---|---|
| `--so-ground` | `#efefef` | `#0b0b0b` | the frame the sidebar sits on; server page ground |
| `--so-paper` | `#ffffff` | `#161616` | sheets, cards, fields, menus |
| `--so-raised` / `--so-soft` | `#f5f5f5` / `#f2f2f2` | `#1c1c1c` / `#1f1f1f` | tracks, notices, hover fills |
| `--so-line` / `--so-input-line` | `#e6e6e6` / `#d4d4d4` | `#262626` / `#363636` | hairlines / field boundaries |
| `--so-ink` | `#171717` | `#ededed` | text |
| `--so-muted` | `#666666` | `#a1a1a1` | dim text (≥4.5:1 on paper and frame) |
| `--so-accent` | `#171717` | `#ededed` | every act (ink, by design); console `--primary` |
| `--so-signal` | `#171717` | `#ededed` | waits on a person; focus (`--ring`), caret, selection; a person may pick any colour in Settings → Appearance, with Pantone's colours of the year as presets (`src/accent-colors.ts`) |
| `--so-danger` | `#c4320a` | `#ff977d` | failed; the arm-to-cancel act |
| `--so-warning` | `#ab6400` | `#ffca16` | setup trouble, caution |
| `--so-info` | `#0d74ce` | `#70b8ff` | live (console `--running`) |
| `--so-success` | `#218358` | `#3dd68c` | built, passed |

The console's older names (`--background`, `--card`, `--primary`, `--brand`,
`--running`, `--ring`, `--glass*`) are views onto these, never a second ramp.
Light is the root; dark follows the device unless the person pins a theme
(`html[data-theme]`, from the `so-theme` cookie). Two `theme-color` metas
(`#efefef`, `#0b0b0b`); the manifest is `#0b0b0b`.

Type: 13px/1.5 Geist for the workspace, 14px/1.7 for reading; page titles
22–26px semibold with tight tracking; section headers 15px semibold ink.
Controls: 32px at a desk (28px small), 44px to a thumb. Focus: a 2px accent
ring at 2px offset on buttons and links; a accent border with a 3px wash on
fields and the composer. Radii nest: sheet 12, card 10, control 8, badge 5.

## 3. Components and where they live

| Component | Server page (CSS in `STYLE`) | Workspace (React) | Rule |
|---|---|---|---|
| Status chip | `.badge` + `.badge-open` (accent: waits on you), `-parked` (neutral), `-running`, `-done`, `-failed`; `.count.badge-open` (the needs-you count) | `Badge` with `toneOf()` | sentence case, 11.5px, soft fill; one mapping so a task reads the same everywhere |
| Attention card | `.decide-card`, `.lane-attention .lane-card`, `.workspace-card.hot` | status card in `task-view.tsx` | neutral border; the badge and the one accent verb say "needs you" |
| Row | `.row` (hairline below, hover fill) | task rows in `tasks-view.tsx` (a subgrid shared by the list) | title · meta · badge · one outline action |
| Facts | `.facts` (`.fact > .k + .v`) | task facts under a hairline | dim key, mono value for machine facts |
| Seal | `.seal` | — | the signed digest, mono, boxed in the hairline |
| Acceptance rubric | `acceptanceCeremonyHtml` (`<ul class="recap acceptance-rubric">`) | — | one line per signed criterion — mono id, sans statement, its required evidence kinds after it; restated text above the seal, never a second accent action |
| Criterion matrix | `.badge-manual-review` (+ `.badge-done`/`-failed`); `criterionMatrixHtml` / `criterionMatrixSummary` | — | one row per criterion — a state badge (pass/missing/failed/manual review), mono id, statement, required evidence, and the proof's answered evidence refs; the SAME states and words on every surface and in `task show` |
| Review judgement | reuses `.badge-done`/`-failed`/`-manual-review`; `reviewJudgementBadge` | — | a second badge beside the matrix row's own; hover title carries the reviewer's author and note |
| Context coverage (v51) | reuses `.badge`/`-manual-review`/`-failed`; `coverageBadge`, `data-context-coverage` | — | a third badge on a revision's matrix row only; a gap is never folded into the compact view |
| Semantic coverage (v51) | `.semantic-coverage`, `.receipt-coverage`; `semanticCoverageHtml`, `coverageWords` | — | one line beside (never inside) the machine verdict; identical on the task page, run page, chat receipt, and `task show` |
| Diff review | `.diff-review`, `.diff-file`, `.diff-line`, `.diff-modes`, `.diff-annotate` | — | View is quiet and default, Annotate reveals exact line targets; annotations only become work through the separate revision act |
| Repair chain card | `.card.repair-chain`; `repairChainHtml` | — | one card, one chain; the shared `passFraction` helper, never a hand-rolled "N/M criteria" |
| Card | `.card` | `Card` | paper, 1px hairline, 10px radius, no shadow; never nested |
| Buttons | `button` (secondary), `form.card > [type=submit]` (primary, ink), `.approve-form [type=submit]` (accent), `.danger` | `Button` (`default` ink, `attention` accent, `outline`, `ghost`, `destructive`) | one primary per form; approve is the only accent verb |
| Fields | `input`, `textarea`, `select` | `Input`, `Select` | paper, control line, accent focus |
| Section header | `h2` (+ `.lane-count` pill) | — | 15px semibold ink in the workspace |
| Shell | `.side` and `.mobile-top` + `.tabbar` (legacy chrome, Bearer reads and the pre-script fallback only) | `.so-workspace` in `app.tsx` | see §5 |

## 4. The board

Five lanes in pipeline order: needs you · queued · waiting · building · done
recently. Each lane is a `details` with its count in the summary and its
state dot on the header; a lane with cards is open, an empty one folds. On a
phone (≤760px) lanes stack, the summary is a 2.75rem tap with a drawn
chevron, and the poller preserves each fold across swaps.

A card: mono id eyebrow · title · one honest "why" · facts grid · chips. A
building card adds the live strip — stage word and elapsed clock in an inset
well, blue — never a percent.

## 4b. The task page

Modelled on issue detail in Linear, GitHub, and Jira (iOS): the page reads
top-down and every long thing folds.

1. **Eyebrow** — mono id · project · provenance.
2. **Title** with its state chip. A done task's dispatch-status box
   beneath it speaks the machine's own proof verdict (Priority 2) —
   *verified*, *evidence captured*, *missing evidence*, or *conflicting
   evidence* — never re-derived from the page. Accepting the latter two is
   an explicit, neutral *accepted with exception* disclosure, not a accent
   approval ceremony.
3. **Acts bar** — every verb in one row; the act that resolves the task's
   state first and primary (retry on a stalled task, plan-first with no
   scope, build-next in the queue); hold with its reason beside it; unhold
   when a hold exists. One line beneath says what the primary does. Cancel
   stays armed at the foot of the page, far from the primary.
4. **What waits on you** — when a scope waits for its yes, the approval
   ceremony IS the first card under the title (the consent-sheet shape:
   the wait stated, every bound term restated, the accent approve act in the
   first screen, "edit instead →" beside the heading); the acts bar then
   follows it with no competing primary. A scope the store cannot route
   gets the problem and a primary "edit the scope to fix it" road instead
   of a password. Otherwise the decision cards and the "this task is
   waiting on you" card, linking to the section that resolves it. The
   acceptance rubric restates immediately above the seal, in the same
   restated-text register as the goal and the touches above it — never a
   second thing to sign.
4a. **The criterion-to-evidence matrix** — a done task's dispatch-status
   box, and the run page's evidence bundle, gain one row per signed
   criterion beneath the verdict: a state badge (pass · missing · failed ·
   manual review), the criterion's id in mono, its statement in sans, and
   the evidence kinds it required. Denser surfaces (done, builds, board,
   inbox) collapse the same facts to a count chip ("2/3 criteria") plus
   the worst state present, rather than dropping the matrix — a
   grandfathered task with no rubric renders nothing extra at all.
5. **Property list** (the rail on a desktop, above the sections on a phone):
   worker or last attempt · queue place · scope with its seal · publishes as
   · this attempt · task total · strikes — one row grammar, dim key, mono
   value.
6. **Sections that fold**, each with its count: decisions, incidents,
   attempts (open), spend (folded), steering (open only when notes exist),
   scope (open; the edit form folds inside it),
   waits for (folded when empty), holds.
7. **Full evidence and revision** — the result receipt links to the run's
   immutable record. Its diff opens in View mode: folding file rows, old/new
   gutters, quiet semantic add/delete color, and horizontal containment on a
   phone. Annotate is an explicit mode, not permanent chrome; selecting a line
   prefills one ordinary feedback form. Collected annotations stay inert until
   the separate revision card seals the exact batch into one unapproved task.

### 4b′. The review cockpit (`/review`)

A master/detail over completed work, built from the same rows the done view
and the run page read. Desktop: a sticky ranked queue (`minmax(15rem, 19rem)`)
beside one detail column; at 980px and below the two stack with the selected
result first and the queue below it, so the phone reaches the result and its
primary act before the backlog. The rules:

- **Review priority is a chip, never a verdict.** Three words — *needs
  action* (`badge-failed`), *review* (`badge-manual-review`), *no flags*
  (`badge-done`) — with one short reason on the queue row. The selected
  header keeps only the receipt's own
  `receipt-proof` chip from the same `proofStateWords` mapping, so the
  cockpit and the task page never disagree: the stored verdict decides the
  word (a no-change run with a refuted proof still reads *Conflicting evidence*),
  and only a completion with no build at all wears *No build record*.
- **The queue is a window, the link is stable.** The ranked queue lists at
  most the newest 100 completions and prints that cap in its hint when it
  reaches it; a `?result=` link to an older completion opens it directly
  with a muted `.cockpit-beyond` note ("opened directly … no row there"),
  never the "not in view" problem banner, which is reserved for tasks that
  are not done, not admitted, or do not exist.
- **One primary act** (`.cockpit-next`), chosen from the state: review
  missing or conflicting evidence, draft a CI repair, seal ready annotations,
  open the pull request, or plainly "nothing waits on you". Every other road
  stays in its own section. A bearer session sees the act named, never a form.
- **Sections in one scan path**, with approved scope, the evidence bundle,
  the agent summary, and exception form progressively disclosed: approved
  scope → evidence → changes → request changes → delivery → operator notes.
  Every evidence row remains labeled by source (`data-cockpit-source`:
  machine, agent, reviewer, screenshots, caveats), and an absent source says
  so plainly. On a phone, the selected result comes before the queue.
- **Changed files carry their own priority** (`.cockpit-files`): outside the
  approved paths first (flagged `badge-failed`), then binary, dependency/CI/
  schema/credential paths, uncited files, and large changes, then churn. Each
  row anchors to its file in the sealed patch (`diff-file-<sha256[0..16]>`),
  which keeps its sealed order beneath. Signed touches match gitignore-style
  (`*` within one segment, `**/` across zero or more directories); the
  credential heuristic matches whole `-`/`_`/`.`-delimited pieces of the
  file name only, so `author.ts` or `permissions-ui.tsx` is never flagged.
- **Escaping and anchors.** Every displayed value goes through `escape`; the
  file anchor is derived from the path's bytes so a hostile name can neither
  break the id nor leave the attribute.

## 4c. The chat workspace

Chat is always an all-project surface. On a desk, a sticky project rail sits
beside the single mate thread; every admitted project shows needs-you, live,
queued, and finished-today counts, then two guarded forms: ask about its
stable `rN` alias or open its board. On a phone, those cards become one
horizontally scrolling row so the conversation remains in the first screen.
An empty thread offers three ordinary spend-authorized message forms, never
a separate action path. The mate still only proposes and every act still
lands as a confirmable card.

## 5. The shell

Every signed-in page renders in the React workspace (`[data-workspace-shell]`).
At a desk the frame is grey and the sidebar sits directly on it: the accent
mark, the ink New task button, the project switch, then Chat · Tasks · Flows ·
Projects · Knowledge · Settings with the current page as a raised paper pill
and the accent needs-you count on Tasks. The main sheet (52px header, page
name, ⌘K search) and the Crew sheet sit inset 8px into the frame. Full-width
pages (the Tasks list, board, queue, workbench, code, flows) drop the Crew
sheet because the list already is the crew. A task, result or project with its
own conversation docks an Ask sheet on the right.

At 900px and below the frame dissolves: the sheet fills the screen, the
sidebar becomes a left drawer from the header's menu button, and Crew or Ask
becomes a second full-screen view with a back button. `viewport-fit=cover`
makes the safe areas real.

One-time secrets render as script-free focus pages (`focusDocument()`), with
the brand and one card. The legacy console chrome (`.side`, `.mobile-top`,
`.tabbar`) remains only for Bearer reads and the fallback a page paints before
the workspace script runs.

## 6. Motion and browser surfaces

Colour fills on hover and press run 120ms ease-out; nothing lifts or bounces.
One navigation cross-fade for navigation a person chose; liveness swaps are
instant; the pulse dot is the one "alive" signal; everything stops under
`prefers-reduced-motion`. Selection, caret, scrollbars, focus rings and
tabular numerals are themed from the palette in both schemes.

## 7. Recording a change

A token lands in `THEME_LIGHT` / `THEME_DARK` in `src/serve.ts`; a shell or
component rule lands in `STYLE`, `src/browser/workspace.css` or the component.
Record it in `DESIGN.md` (and its sidecar `.impeccable/design.json`) in the
same commit, and here only if it changes the voice or a page's structure.
Every page carries the direction contract as its first body comment
(`DESIGN_CONTRACT` in `src/serve.ts`).

## 8. References (Mobbin)

The bar for v4 is Raycast (compact density, one accent, keycaps), Arc (the
frame with the page as an inset sheet, the raised pill for the current tab),
[Linear issues, dark](https://mobbin.com/screens/e142df2a-3527-499c-8f81-1b715947ac0c)
and [backlog, light](https://mobbin.com/screens/fd1b4d88-f021-49a3-98af-4cd3a87e1d29)
(inset canvas, a sidebar with no rule, grouped rows), and
[Vercel deployments](https://mobbin.com/screens/e9576405-bcef-419a-922a-8fb84b044a54)
and [a failed build](https://mobbin.com/screens/ff81f1e9-25b1-46f9-8448-31fa40a77e4b)
(Geist, ink primary buttons, status dots, mono hashes). Earlier references:
[Linear issues](https://mobbin.com/screens/610d34b6-6ad8-45ab-80fb-2107b31ed01e),
[Linear inbox on iOS](https://mobbin.com/screens/3d9ccfd8-2425-49e9-a00b-27189140d3a3),
[Vercel project overview](https://mobbin.com/screens/21283de1-3b87-491d-9503-2a4c13f6a181),
[Railway](https://mobbin.com/screens/cf56574a-01d3-4efe-b841-e091c9ecc39d),
[Plane](https://mobbin.com/screens/69990ffa-9153-4bf1-bb53-87317f9e040f),
[GitHub iOS](https://mobbin.com/screens/b2165009-6e10-4b74-9c30-4be5b19ad123),
[Asana iOS](https://mobbin.com/screens/51074f57-02ca-4420-9c8e-dc7317c4bcf6),
[Linear switcher](https://mobbin.com/screens/2679ae03-f852-47c3-a880-480c493c1369).

Declined on purpose: an accent on every button, glass, blur and gradient
surfaces, hover lifts, uppercase eyebrow labels, a percent on builds, and a
select-then-confirm decision screen.
