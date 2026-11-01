# ReUI: what the free parts can do for the console (assessment)

Status: assessment only (2026-10-27). Nothing in `src/` changes with this note. Alex asked "just assess what we
can do with the free elements for now", so this note covers only the MIT-licensed parts of ReUI and leaves Pro
out, apart from the one licence line below.

Sources read: the ReUI repo at commit `067aa0d` (2026-10-16, `keenthemes/reui`), the published registry JSON
(`https://reui.io/r/styles/radix-nova/<name>.json`), https://reui.io/legal/license, https://reui.io/pricing and
https://reui.io/docs/get-started. The "before" screenshots of the current console come from the isolated
UI-polish fixture (`scripts/ui-polish-fixture.mjs`) at 1440×900 and 390×844. They sit outside the repo in the
session scratchpad as `reui/before-<screen>-<desktop|phone>.png`.

## 1. Licence, in one paragraph

ReUI's public repo is MIT ("Copyright (c) 2025 Keenthemes Inc", `LICENSE.md`). The licence page confirms the
free scope: "the shadcn component examples, ReUI primitives, and hooks that we publish in the public ReUI
repository, are not Licensed Materials … They are licensed under the MIT License." **Pro cannot go in our repo.**
The Pro licence ($249 one-time, one user) forbids publishing the Licensed Materials "in a public or open-source
repository, or anywhere the original source code can be downloaded by the public". It also forbids building a
competing UI kit, and it says the free *templates* are not MIT. Even an OEM licence would not allow a public repo.
Free templates are therefore out too. Only the primitives, the examples and the hooks are usable.

## 2. Compatibility and how the code would come in

| Question | Finding | What it means for us |
|---|---|---|
| React | ReUI's own app pins React 19.2.7. The primitives use plain function components and `Slot`. | Works on our 19.3.0 as-is. |
| Tailwind | The source is v4 only: `@import "tailwindcss"`, `@custom-variant style-*`, and `(--var)` arbitrary values. The README's "Tailwind 3+" line is out of date. | Works on our 4.3.3. The `style-vega:` / `style-nova:` variants must be **deleted** on copy. We pick one geometry and drop the other styles. |
| Radix vs Base UI | Every primitive ships twice: `registry-reui/bases/radix/reui` and `bases/base/reui`. | **Use the Radix base.** Our whole console is Radix (`@radix-ui/react-*` per package). Base UI would add a second primitive engine (about 40–60 KB) for no gain. One exception: data-grid's registry entry lists `@base-ui/react` even in the Radix style, which is one more reason to skip it (see §5). |
| Imports | The primitives import `{ Slot } from "radix-ui"` (the umbrella package) and `{ cn } from "cn"`. | Rewrite both on copy: use `@radix-ui/react-slot` (already pinned at 1.3.3) and our `components/ui/utils.ts` `cn`, which is tailwind-merge extended with Signal's type, radius and shadow names. **Do not** add the `radix-ui` umbrella package or the npm package called `cn`. |
| Registry and CLI | Install is `npx shadcn add @reui/<name>`. It needs a `components.json` with a `registries` entry, and it writes `cssVars` (success, info, warning, invert…) into the global CSS. | **Don't run the CLI.** We have no `components.json`, and `init` would rewrite `tailwind.css`, add a preflight we deliberately scope to `[data-view]`, and inject tokens that compete with `src/design/tokens.css`. Instead, read the public registry JSON (or the repo file at a pinned commit), copy the one `.tsx` by hand into `src/browser/components/ui/`, and record the upstream path, commit and changes in `THIRD_PARTY_NOTICES.md` under a new "ReUI — MIT" section. This is the same pattern the shadcn/ui and beUI sections already follow. |
| Plain shadcn parts | `card`, `tabs`, `sheet`, `command`, `empty`, `skeleton`, `kbd`, `tooltip`, `avatar`… are **shadcn's** files mirrored in ReUI's repo (`registry/bases/radix/ui`). reui.io returns 404 for them. | They add nothing over shadcn/ui, which we already adapt. We take them from shadcn directly, if at all, and credit them under the existing shadcn/ui notice. |

## 3. Security posture of imported code

I searched both ReUI trees for `dangerouslySetInnerHTML`, `eval`, `new Function` and `fetch`. There are only two hits:

- `ui/chart.tsx`: a style tag, the standard shadcn chart. **Excluded.**
- `reui/emoji-picker.tsx`: fetches emoji data over the network. **Excluded.**

None of the components recommended below has any of these. The rules for anything we bring in:

- It is copied source, reviewed line by line, with no install scripts and no CLI.
- No new network access, no `dangerouslySetInnerHTML`, no `localStorage`.
- Any new runtime dependency is named, pinned to an exact version, and listed in the notices with a reason.

The recommended set needs **no new dependency at all**. The only candidates that would add one (`@dnd-kit/*`,
`@tanstack/react-table`, `@tanstack/react-virtual`, `cmdk`, `date-fns`) are the ones this note advises against
or defers.

## 4. Component fit, screen by screen

Effort: **S** is under 150 lines and a few hours. **M** is 150–400 lines, one slice. **L** is several slices or a
new dependency. Sizes are upstream line counts before our cuts. "Bundle" is the minified cost added to
`workspace.js`, which today is 1,092,674 bytes; our own `src` is about 458 KB, react-dom about 205 KB and
`@xyflow` about 120 KB.

| # | ReUI piece (MIT) | Screen / use | The improvement | Adaptation to Signal and DESIGN.md | Size / deps / bundle | Effort |
|---|---|---|---|---|---|---|
| 1 | **Badge** (`reui/badge.tsx`, 99 lines), light variants and size scale, plus the status-dot pattern from example `c-badge-22` | Board cards and Board column heads, Agents list, Projects peek chips, Tasks rows outside groups, Crew rail, task and result header | One status chip everywhere: a soft tint, a 1px same-hue border and a 5px dot. It is the same chip the approved Agents → Live view already wears ("● Working", "● Needs you", "● Done"). Today the console mixes grey pill badges (`done`, `queued` on /tasks), coloured text (`running`, `failed`), coloured dots with lowercase labels (Board) and glyph-only rows. | Fold `-light` into our existing `badgeVariants` as a `dot` boolean and an `outline` treatment. Keep our tone names (`neutral/attention/success/info/warning/danger`) and our `--so-*` tokens, so we don't take ReUI's `cssVars`. Drop `style-*` radius variants and the `focus`/`invert` tones. Take Geist 11.5px, not mono. Map tone through `toneOf` only. | +~40 lines in `components/ui/badge.tsx`, 0 deps, <1 KB | **S** |
| 2 | **Frame** (`reui/frame.tsx`, 180 lines): a muted well that holds stacked hairline panels with header and footer slots | Board columns, Agents → List groups, Task page "The plan" and details, Settings sections, Knowledge sections, Projects rows | This is the youiyoux "panel + well" treatment Alex just approved on Agents → Live. A raised `bg-raised` well holds flat paper panels, which gives Board columns a real container in place of grey boxes with chevrons floating above, and gives Settings and Knowledge structure in place of a loose stack of headings and inputs. | Replace every `style-*:[--frame-*]` with one fixed set: 12px well radius (`rounded-card`), 8px panel radius, `--so-line` hairline, `bg-raised` well and `bg-card` panel. **Remove the `shadow-xs` and the `before:` inner shadow** under the One Sheet Shadow and Hairline First rules. Never nest a Frame in a card. | ~90 lines after cuts, 0 deps, <1 KB | **S** |
| 3 | **Timeline** (`reui/timeline.tsx`, 218 lines: item, indicator, separator, date, title, content) | Task page "attempts" history and run log, Result page "Build details", Knowledge "Learning history", Settings → Learning history, Agents → List "Done" | Gives history a time axis: an indicator on a hairline rail, a mono clock, a title and a body. Today it is a flat list or a collapsed disclosure. | The indicator uses our `StatusGlyph` (state as shape), never a coloured fill. The rail is `--so-line`. Dates are Geist Mono 12px (Machine Fact Rule). Swap `radix-ui` `Slot` for `@radix-ui/react-slot`. Horizontal mode is dropped. | ~150 lines, 0 deps, ~1.5 KB | **M** |
| 4 | **Stepper** (`reui/stepper.tsx`, 477 lines; keyboard roving and orientation) | Approval / ceremony surfaces (scope → approve → build → review → merge), the onboarding preview ceremony on Projects, the Flow import preview | Shows where a task stands in its one fixed road, read-only, as an `aria-current="step"` list, so "Needs you" reads as a step on a road rather than a boxed headline. | Read-only use only: strip the controlled and keyboard-navigation parts we wouldn't use (about half the file). The current step takes the attention treatment only when it waits on a person. Done steps use the green glyph, future steps the dashed ring. Labels come from `src/task-status.ts` words, not new ones. | ~200 lines after cuts, 0 deps, ~2 KB | **M** |
| 5 | **Alert** (`reui/alert.tsx`, 92 lines) | Result page warnings ("Couldn't be read", "Some saved files changed"), Projects "choose which folder…", Flows import errors, sign-in errors | One shape for inline notices inside a card, with an icon, a title and a body, replacing the four ad-hoc warning lines on the result page. | **Only the neutral and destructive variants.** Under DESIGN.md, a problem line inside a non-failed card is neutral (raised fill, ink text). Vermilion appears only on real failures. No `info`/`warning`/`success` filled alerts, **no coloured banners in the main column**, no side stripe. Take the existing `.ui-alert` under `ui/primitives.tsx`. | ~50 lines after cuts, 0 deps, <1 KB | **S** |
| 6 | **Kanban** (`reui/kanban.tsx`, 1,021 lines) | Board (State) and Board → order | It would turn the Board into a React view with real column containers and drag to reorder. | The Board is **server-rendered HTML** today, and its drag-to-reorder works through `/queue/move` with progressive enhancement. Kanban needs `@dnd-kit/core`, `/sortable` and `/utilities` (about 45 KB min) plus a React rebuild of the page. **Defer.** Get 80% of the look from Badge + Frame + server CSS now. Reconsider only if the Board becomes a React view for other reasons. | ~700 lines after cuts, +3 deps, ~45–50 KB | **L** |
| 7 | **Data grid** (`reui/data-grid/`, 12 files, ~11.5k lines) and **Filters** (`reui/filters/`, 14 files, ~10.2k lines) | Tasks (`/tasks` server list), Agents → List | Sortable, filterable columns. | **Doesn't fit.** Tasks is deliberately a grouped list (Decide / Review / Unblock) with one action per row and server-side paging (real URLs). A grid adds `@tanstack/react-table`, `@tanstack/react-virtual`, `@dnd-kit/*`, `@base-ui/react` and `date-fns`: roughly 150–200 KB, about 15–20% on a 1 MB bundle that is already the budget problem. The filter builder is a query UI we don't need for tens of tasks. **Out.** If `/tasks` needs a table, use shadcn's 100-line `table` (0 deps) in the server sheet's style. | ~22k lines, +6–8 deps, +150–200 KB | **L — reject** |
| 8 | **Number field / time picker / date selector** | Settings → models (budgets), Routines, Spend → budget | Clean steppers in place of bare `<input type=number>`. | Mono for the number (Machine Fact). Keep native inputs underneath so forms still post without JS. `date-selector` pulls `date-fns`, so skip it unless Routines needs it. | number-field ~180 lines, 0 deps | **S–M**, later |
| 9 | **Autocomplete** (Radix popover) | "Add from GitHub" repo picker, Flow import project picker | Typeahead over the gh repo list. | Needs `@radix-ui/react-popover` (one more pinned Radix package, ~10 KB). Low priority. | ~250 lines, +1 dep | **M**, later |
| 10 | **Tree** (`reui/tree/`) | Knowledge "Relevant code", task Changes file list | Collapsible path tree. | Today's mono path list is honest and short. Defer until a task routinely touches more than about 30 paths. | ~600 lines | **L**, defer |

Not worth importing from ReUI because shadcn originals already exist, or we already have a better version:

- **tabs**: ours already follows DESIGN.md's segmented tabs.
- **sheet**: we have Radix dialog.
- **command**: `cmdk`, +15 KB; the ⌘K menu is server-driven.
- **sonner**: we wire sonner; ReUI's copy adds `next-themes`, which we must not take.
- **skeleton**: one line of CSS.
- **kbd**: we already style the ⌘K hint.
- **empty**: worth copying as **pattern only**, a 103-line shadcn file with no deps, for Settings / Knowledge / Flows empty states.

Excluded on principle: `chart` (raw HTML), `emoji-picker` (network), `signature-pad`, `rating`, `phone-input`,
`color-picker` (Settings → Appearance already has its own), `gantt` and `event-calendar` (heavy, no screen).

## 5. Where it would show most (ranked by visible impact)

From the before screenshots. Inside each slice, the pieces from §4 do the work.

1. **Board** (`before-board-*.png`). It is the most unpolished high-traffic screen: lowercase coloured-dot
   column heads, grey column boxes with floating chevrons, mono slugs above every title, and key/value rows in mono
   ("worker / model / branch"). Badge + Frame + one card spec, all server CSS plus the shared chip classes. **M.**
2. **Status chips everywhere.** One Badge (dot) across `/tasks`, Board, Agents → List, Projects and Crew. This is the
   single change seen on every screen, and it carries the approved Agents → Live chip to the rest of the console.
   **S** for the component; then each screen adopts it inside its own slice.
3. **Settings and Knowledge** (`before-settings-*`, `before-knowledge-*`). Settings is a link row over one disclosure
   on an empty sheet. Knowledge is a long column of labels, selects and buttons with no grouping. Frame sections,
   an Empty pattern for "No decisions yet", and inline buttons beside their inputs. **M.**
4. **Task page and approval ceremony** (`before-task-*`). Stepper for "where this task is", Frame for "The plan",
   and Timeline for attempts. The plan card is already decent, so the gain is in orientation. **M.**
5. **Result page** (`before-result-*`). Four warning lines become neutral Alerts, and Build details becomes a
   Timeline. **S–M.**
6. **/tasks server list** (`before-tasks-*`). Mono slug + title + grey `done` pills, and a raw temp path under the
   title. Badge (dot) + a quieter row matching the React `/work` list (`before-work-*`), or retire `/tasks` in favour
   of `/work`. **S** (that is a product call; see questions).
7. **Projects** (`before-projects-*`). Already reasonable. Swap the peek chips for Badge, with only "N waiting on
   you" taking the attention treatment. **S.**
8. **Flows list** (`before-flows-*`). Raw native file input and unstyled selects. Frame sections plus our Select.
   No ReUI-specific gain beyond Frame. **S.**
9. **Agents → Live.** It is already on this direction (agents-view-4, still in progress). **Last.** Do nothing here
   until slice 8 of agents-view-4 lands, then consolidate its local chip and panel classes onto the shared Badge
   and Frame.

Untouched: the terminal page (xterm), sign-in (already minimal) and chat (its own component set from AI Elements).

## 6. What clashes with our rules

- **Accent and amber.**
  - ReUI's coloured variants (`warning`, `warning-light`, `focus`) would happily spread amber across the console,
    which Alex has rejected. Waiting on a person keeps **one** treatment: a thin full outline plus a chip with a dot.
  - It is never a fill and never an edge stripe. Today's `bg-attention` count pills on tabs and the sidebar are the
    allowed exceptions (counts).
  - We import no `warning` tone for "needs you".
  - **Divergence to settle.** DESIGN.md on main still says the waiting accent is *ink* ("Ink accent … for what
    waits on a person", amber = setup trouble). The approved Agents → Live view uses an *amber* outline and chip
    for "Needs you".
  - The Badge slice has to know which one is canonical before it ships (open question 1).
- **No KPI box rows.**
  - ReUI's examples lean on stat cards, and Frame makes them easy to build. We don't build them.
  - The usage tiles on `/work` stay folded to one line.
- **No coloured banners in the main column.**
  - Alert ships only `neutral` + `destructive`.
  - `destructive` is reserved for an actual failure, and a page-level notice stays neutral.
- **Shadows and nesting.**
  - Frame's `shadow-xs` and inner `before:` shadow are removed.
  - Frames don't nest in Cards (One Sheet Shadow / Hairline First).
- **Mono.**
  - ReUI examples set ids, labels and kbd in mono freely.
  - We keep mono only for machine facts. Status words in chips are Geist.
- **Upper-case and tracking.** Some ReUI examples use uppercase tracked labels, which DESIGN.md forbids.
- **Server-rendered pages.**
  - ReUI is React. Board, `/tasks`, Flows, Knowledge, Settings landing, Inbox and sign-in are server HTML styled by
    `src/server/console.css`.
  - On those pages we port the *visual spec* (classes and tokens), not the component.
  - Rebuilding them as React views just to host a component is out of scope.
- **Security.** The `chart` and `emoji-picker` exclusions, and the no-CLI, no-`cssVars`, no-umbrella-`radix-ui`
  rules above.

## 7. Design-system plumbing

- **DESIGN.md is the source of truth.**
  - Each adopted piece gets a short entry under Components: a Badge "dot" and "outline" note, a Frame entry, and a
    Timeline/Stepper entry. Each states the rule it obeys.
  - ReUI's names don't enter DESIGN.md. Ours do.
- **youiyoux.**
  - Frame and Badge are the same treatments youiyoux's `design.md` calls panel/well and chip.
  - Run `youiyoux check --diff` on every slice and require **0 new drift**.
- **Claude Design sync** (`.design-sync/config.json`). After the Badge and Frame slices, re-run the sync so the
  previews show the shared chip and well.
- **Notices.**
  - Add a "ReUI — MIT" section to `THIRD_PARTY_NOTICES.md`, with the upstream commit, file paths and modifications.
  - The built `dist/browser/THIRD_PARTY_NOTICES.txt` follows.

## 8. Suggested order if Alex says go

Each slice is 400 lines or fewer, with before/after shots from the same fixture at 1440×900 and 390×844, and
typecheck plus the screen's browser tests:

1. **Badge.** Dot and outline added to the shared Badge, and the notice. Then it is adopted on Projects.
2. **Frame.** It is adopted on Settings and Knowledge, with the Empty pattern.
3. **Board.** Server CSS: Frame columns, Badge chips, Geist titles, and mono only for slugs, clocks and branch.
4. **/tasks list.** It is aligned with `/work`, or retired; this is Alex's call.
5. **Result page.** Neutral Alerts and a Build details Timeline.
6. **Task page.** Stepper and attempts Timeline.
7. **Agents → List and Live.** They are consolidated onto Badge and Frame, after agents-view-4 merges.

Bundle budget for the whole run: **+10 KB minified at most**, with no new npm dependency. Kanban, data-grid,
filters and command stay out unless a later decision changes that.

## 9. Open questions for Alex

1. **Needs-you colour.** Is it the amber outline + dot chip from Agents → Live (then DESIGN.md's "ink accent"
   section changes), or the ink accent DESIGN.md describes today? The Badge slice can't ship without this.
2. **Board.** Keep it server-rendered and port the look via CSS (recommended, no new deps), or rebuild it as a
   React view with ReUI Kanban (+~50 KB, `@dnd-kit`)?
3. **`/tasks` vs `/work`.** Two task lists exist (`before-tasks-*` and `before-work-*`). Retire the older one, or
   polish both?
4. Are Timeline on the task and result pages, and Stepper on the approval ceremony, wanted? Or is a calmer page
   preferred even at the cost of orientation?
5. Should the ReUI notice credit go in `THIRD_PARTY_NOTICES.md` only (as with beUI), or also in the README?
