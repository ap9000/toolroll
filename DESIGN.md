---
name: Signal
description: "The Toolroll control plane: a neutral grey frame with paper sheets inset into it, ink for every act, and an ink accent for what waits on a person; colour is kept for status."
colors:
  signal: "#171717"
  signal-hover: "#383838"
  on-signal: "#ffffff"
  signal-soft: "#e8e8e8"
  selection: "#d4d4d4"
  ground: "#efefef"
  paper: "#ffffff"
  raised: "#f5f5f5"
  soft: "#f2f2f2"
  ink: "#171717"
  ink-hover: "#383838"
  on-ink: "#ffffff"
  muted: "#666666"
  nav-ink: "#525252"
  nav-hover: "#e4e4e4"
  line: "#e6e6e6"
  input-line: "#d4d4d4"
  neutral-ink: "#525252"
  neutral-soft: "#f0f0f0"
  danger: "#c4320a"
  danger-soft: "#feebe7"
  warning: "#ab6400"
  warning-soft: "#fff4d5"
  success: "#218358"
  success-soft: "#e6f6eb"
  info: "#0d74ce"
  info-soft: "#e6f4fe"
  signal-dark: "#ededed"
  signal-hover-dark: "#ffffff"
  on-signal-dark: "#0a0a0a"
  signal-soft-dark: "#2e2e2e"
  selection-dark: "#3a3a3a"
  ground-dark: "#0b0b0b"
  paper-dark: "#161616"
  raised-dark: "#1c1c1c"
  soft-dark: "#1f1f1f"
  ink-dark: "#ededed"
  ink-hover-dark: "#ffffff"
  on-ink-dark: "#0a0a0a"
  muted-dark: "#a1a1a1"
  nav-ink-dark: "#a1a1a1"
  nav-hover-dark: "#171717"
  line-dark: "#262626"
  input-line-dark: "#363636"
  neutral-ink-dark: "#b4b4b4"
  neutral-soft-dark: "#1f1f1f"
  danger-dark: "#ff977d"
  danger-soft-dark: "rgb(255 151 125 / .12)"
  warning-dark: "#ffca16"
  warning-soft-dark: "rgb(255 202 22 / .12)"
  success-dark: "#3dd68c"
  success-soft-dark: "rgb(61 214 140 / .12)"
  info-dark: "#70b8ff"
  info-soft-dark: "rgb(112 184 255 / .12)"
typography:
  display:
    fontFamily: "'Geist', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "26px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.025em"
  headline:
    fontFamily: "'Geist', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.375
  title:
    fontFamily: "'Geist', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "-0.01em"
  title-sm:
    fontFamily: "'Geist', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  body:
    fontFamily: "'Geist', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  body-reading:
    fontFamily: "'Geist', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.7
  label:
    fontFamily: "'Geist', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.2
  caption:
    fontFamily: "'Geist', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.5
  badge:
    fontFamily: "'Geist', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "11.5px"
    fontWeight: 500
    lineHeight: "18px"
  mono:
    fontFamily: "'Geist Mono', ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  mono-count:
    fontFamily: "'Geist Mono', ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1
    fontFeature: "'tnum'"
rounded:
  badge: "5px"
  sm: "6px"
  md: "8px"
  card: "10px"
  sheet: "12px"
  full: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  2xl: "24px"
  3xl: "28px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    height: "32px"
    padding: "0 12px"
  button-primary-hover:
    backgroundColor: "{colors.ink-hover}"
  button-signal:
    backgroundColor: "{colors.signal}"
    textColor: "{colors.on-signal}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    height: "32px"
    padding: "0 12px"
  button-signal-hover:
    backgroundColor: "{colors.signal-hover}"
  button-outline:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    height: "32px"
    padding: "0 12px"
  button-outline-hover:
    backgroundColor: "{colors.soft}"
  button-ghost:
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    height: "32px"
    padding: "0 12px"
  button-ghost-hover:
    backgroundColor: "{colors.soft}"
    textColor: "{colors.ink}"
  button-danger:
    backgroundColor: "{colors.danger-soft}"
    textColor: "{colors.danger}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    height: "32px"
    padding: "0 12px"
  button-sm:
    height: "28px"
    padding: "0 10px"
  button-touch:
    height: "44px"
    padding: "0 16px"
  input:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    height: "32px"
    padding: "0 10px"
  input-touch:
    height: "44px"
  badge-neutral:
    backgroundColor: "{colors.neutral-soft}"
    textColor: "{colors.neutral-ink}"
    typography: "{typography.badge}"
    rounded: "{rounded.badge}"
    padding: "1px 6px"
  badge-attention:
    backgroundColor: "{colors.signal-soft}"
    textColor: "{colors.signal}"
    typography: "{typography.badge}"
    rounded: "{rounded.badge}"
    padding: "1px 6px"
  badge-success:
    backgroundColor: "{colors.success-soft}"
    textColor: "{colors.success}"
    typography: "{typography.badge}"
    rounded: "{rounded.badge}"
    padding: "1px 6px"
  badge-warning:
    backgroundColor: "{colors.warning-soft}"
    textColor: "{colors.warning}"
    typography: "{typography.badge}"
    rounded: "{rounded.badge}"
    padding: "1px 6px"
  badge-danger:
    backgroundColor: "{colors.danger-soft}"
    textColor: "{colors.danger}"
    typography: "{typography.badge}"
    rounded: "{rounded.badge}"
    padding: "1px 6px"
  badge-info:
    backgroundColor: "{colors.info-soft}"
    textColor: "{colors.info}"
    typography: "{typography.badge}"
    rounded: "{rounded.badge}"
    padding: "1px 6px"
  nav-item:
    textColor: "{colors.nav-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    height: "32px"
    padding: "6px 8px"
  nav-item-hover:
    backgroundColor: "{colors.nav-hover}"
    textColor: "{colors.ink}"
  nav-item-current:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
  nav-count:
    backgroundColor: "{colors.signal}"
    textColor: "{colors.on-signal}"
    typography: "{typography.mono-count}"
    rounded: "{rounded.full}"
    height: "18px"
    padding: "0 5px"
  new-task:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    height: "32px"
  sheet:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sheet}"
  sheet-header:
    typography: "{typography.title-sm}"
    height: "52px"
    padding: "8px 12px 8px 20px"
  card:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "20px"
  tabs-list:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.muted}"
    rounded: "{rounded.sheet}"
    height: "32px"
    padding: "2px"
  tabs-trigger-active:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
  task-row:
    typography: "{typography.body}"
    padding: "12px 8px"
  menu:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "4px"
  menu-item:
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "6px 8px"
  composer:
    backgroundColor: "{colors.paper}"
    rounded: "{rounded.sheet}"
    padding: "10px 10px 8px 12px"
  alert-danger:
    backgroundColor: "{colors.danger-soft}"
    textColor: "{colors.danger}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
  notice:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "9px 12px"
---

# Design System: Signal

## Overview

**Creative North Star: "The Chart Light"**

Signal is printed in quiet greys and ink, the way Vercel, Linear and GitHub are: the interface is achromatic, and colour is kept for status (building, complete, warning, danger), where it carries meaning. Toolroll is a control plane for unattended coding agents, and most of what it shows needs nobody: builds running, results filed, queues moving. That material is grey and black on paper. What waits on a person is marked by ink weight, not a hue: the needs-you count is a solid ink pill, a waiting task's badge is a strong ink chip, and the one verb that settles it is the ink button. A person should be able to glance at the screen, see the solid ink, open the one thing that needs them, act, and leave. (Until 2026-09-30 this accent was chart magenta; it remains a preset.)

The surface is the Raycast and Arc canon, played straight. A neutral grey frame holds the sidebar directly, and the work sits on white paper sheets inset 8px into that frame: the main sheet, and beside it the Crew sheet. Density is Raycast-compact, with 13px rows and 32px controls at a desk. Depth comes from the contrast between frame and paper, one soft sheet shadow, and 1px hairlines inside the sheets. Words are set in Geist and machine facts in Geist Mono. Every act a person can take is ink: a black button in light mode, a near-white one in dark.

The system rejects the dashboard default. Status does not get coloured everywhere, buttons do not all get an accent, and there is no glass, no gradients and no blur. The four status hues (vermilion, amber, blue, green) exist, but they speak quietly through soft badges and small dots. Accent never means "failed".

**Key Characteristics:**
- Grey frame, paper sheets, 8px inset and 12px sheet corners; the sidebar sits on the frame, not on a sheet.
- Ink is the colour of every act; the ink accent is kept for "a person is needed", plus focus, caret and selection.
- Geist for words, Geist Mono only for machine facts (ids, counts, seals, paths, shortcut keys).
- Compact desk density (13px body, 32px controls, 52px sheet headers) that becomes 44px touch targets on phones.
- Flat and hairline-first: one soft sheet shadow, a smaller pill shadow for the raised current item, a deeper one only for floating menus and dialogs.
- Light and dark are equal schemes. The device decides unless the person pins one.

## Colors

The palette is a true neutral grey ramp with one the ink accent and four quiet status hues. Every token has a light and a dark value. The frontmatter keys ending in `-dark` are the dark-scheme values of the same roles. They are defined once, in `THEME_LIGHT` / `THEME_DARK` in `src/serve.ts`, and every surface reads them: server pages, the React workspace, and the pre-script fallback.

### Primary
- **Ink accent** (signal, #171717 light / #ededed dark): the default accent, used for what waits on a person. It fills the sidebar's needs-you count, the "Needs you" tab count and the Results menu count. It is the text of an attention badge ("Needs your decision") on its grey wash, and the fill of the one verb that resolves a waiting screen (Approve, Inspect the result, the result page's next act). It is also focus, caret and selection.
- **Ink wash** (signal-soft, #e8e8e8 / #2e2e2e): the fill behind attention badge text and the 3px focus halo around a focused field or composer — one step stronger than the neutral badge fill, so a waiting badge still reads first.
- **Selection** (selection, #d4d4d4 / #3a3a3a): text selection highlight, with ink text on it.
- **A chosen accent** (Settings → Appearance, per browser in the `so-accent` cookie as six hex digits): a person may re-pigment the signal with any colour from a compact picker (a saturation and brightness plane, a hue slider and a hex field), with Pantone's colours of the year as preset dots (`src/accent-colors.ts`). Ink is the default; violet and chart magenta are the first presets. Each colour keeps its hue and gives up only lightness, and chroma where sRGB requires it, until it reads: in light its text passes 4.5:1 on its own wash, and in dark 6:1 on the dark paper. The page previews the colour live and prints the derived tokens in a `<style data-accent>` after the shared stylesheet once it is saved. A colour near grey or near a status hue is labelled as such. Only the signal tokens change; every rule about where the signal may appear stays the same.

### Neutral
- **Frame Grey** (ground, #efefef / #0b0b0b): the frame the sidebar sits on, and the page background of server pages. The browser `theme-color` matches it.
- **Paper** (paper, #ffffff / #161616): every sheet, card, field, menu and dialog. In light mode it is also the raised current nav pill.
- **Raised** (raised, #f5f5f5 / #1c1c1c): segmented-tab tracks, notices, row hover fills, and the muted well behind a "next step" block or a neutral problem line.
- **Soft** (soft, #f2f2f2 / #1f1f1f): hover fills on outline and ghost buttons, menu items and suggestions. In light mode the user's chat bubble shares its grey. In dark mode it is also the current nav pill.
- **Ink** (ink, #171717 / #ededed): all body text, and the colour of every act: primary buttons, the New task button, switches and radio cards when on. In the code the act role is `--so-accent` (Tailwind `primary`). It carries ink's value in both schemes, so an act and a sentence read as the same material. Hover deepens it to #383838 in light mode and brightens it to #ffffff in dark.
- **Muted** (muted, #666666 / #a1a1a1): meta lines, fact keys, ghost buttons, placeholders, idle tab counts. It passes 4.5:1 on paper and on frame grey.
- **Nav Ink** (nav-ink, #525252 / #a1a1a1) and **Nav Hover** (nav-hover, #e4e4e4 / #171717): idle sidebar rows and their hover fill on the frame.
- **Hairline** (line, #e6e6e6 / #262626): every divider. It runs under the sheet header, between rows, above the facts grid and around cards.
- **Control Line** (input-line, #d4d4d4 / #363636): the boundary of fields, the composer, and the switch track when off.
- **Neutral Badge** (neutral-soft #f0f0f0 / #1f1f1f with neutral-ink #525252 / #b4b4b4): the badge for anything that is a fact and not a claim on the person, such as queued, running or built today in a project peek, or a count in a fold.

### Status
- **Vermilion** (danger, #c4320a / #ff977d; soft #feebe7 / 12%): failure and irreversible acts. It is used on a failed status card's border (at 50%), on problem alerts inside a failed card, on the Cancel task fold, and on Remove / Delete ghost buttons. It sits deliberately off the accent hue so a failure can never be read as "waits on you".
- **Amber** (warning, #ab6400 / #ffca16; soft #fff4d5 / 12%): setup trouble and caution. It covers a failing trigger, a secret not yet saved, "several are connected and none was chosen", a lost connection, the result page's list of things worth a look, and deferred notices.
- **Live Blue** (info, #0d74ce / #70b8ff; soft #e6f4fe / 12%): something is running right now. It appears on the live dot, a scout badge, a version notice, and a run that is still in progress.
- **Built Green** (success, #218358 / #3dd68c; soft #e6f6eb / 12%): done and passed, used for "Checks passed", "Open now" and a finished live step.

### Named Rules
**The One Signal Rule.** The accent (ink by default) in its solid or attention form means that a person is needed, and nothing else. Its only other jobs are focus, caret, selection and the brand mark. A screen that waits on nobody shows no solid accent beyond the brand mark. Status hues never stand in for it.

**The Ink Acts Rule.** Every act a person can take is ink (primary) or a paper pill (outline). The accent verb is the exception (with the ink default it looks like any ink button; a chosen colour makes it stand out). There is at most one per screen or card, and only when that screen waits on the person.

**The Quiet List Rule.** In a list, the colour goes on the status badge and the row's action stays an outline button. Nine accent buttons in a list would shout.

**The Status Keeps Its Hue Rule.** Failure is vermilion, setup trouble is amber, live is blue, and done is green. Accent is never a failure, a warning, or a card border. A problem line inside a card that has not failed is neutral (raised fill, ink text), not red.

## Typography

**Body Font:** Geist (with ui-sans-serif, system-ui, -apple-system, Segoe UI)
**Label/Mono Font:** Geist Mono (with ui-monospace, SF Mono, Menlo, Consolas)

Both families are self-hosted as latin woff2 at weights 400, 500 and 600 from `/fonts`, with `font-display: swap`. No CDN is used.

**Character:** Geist is a neutral, slightly engineered grotesque, set tight at display sizes and plain at 13px. Geist Mono sits beside it as a second voice kept for what a machine said.

### Hierarchy
- **Display** (600, 26px, 1.25, -0.025em): the page title on task, result and projects pages, and the empty-chat greeting (26px / 1.15 / -0.035em). It drops to 22px on phones. Server fragments inside the workspace set their h1 at 22px.
- **Headline** (600, 18px, 1.375): the state line of a status card ("Needs your decision"), with a 10px state dot before it.
- **Title** (600, 15px, 1.4, -0.01em): fold and section summaries (Result, Build activity, Scope, Request changes) and server-fragment h2s. Titles of standalone cards take 16px / 600.
- **Title Small** (600, 14px, 1.3, -0.01em): the sheet header's page name, panel headers, plan and confirmation titles. It is 16px on phones.
- **Body** (400, 13px, 1.5): the workspace's base size for rows, crew items, menus and forms. Row titles take 500 at 13 to 13.5px. Standalone server pages (sign-in, handoff) keep a 14px base.
- **Body Reading** (400, 14px, 1.7, max 72ch): chat messages and long prose. It is 15px on phones.
- **Label** (500, 13px, 1.2): buttons, nav rows, tab triggers.
- **Caption** (500, 12px): field labels, fact keys, section-heading links. Meta lines use the same 12 to 12.5px at 400 in muted.
- **Badge** (500, 11.5px, 18px line): status badges, in sentence case.
- **Mono** (Geist Mono 400, 12px): task ids, paths, seals and digests, slash commands (12.5px / 500), number inputs.
- **Mono Count** (Geist Mono 500, 11px, tabular): the needs-you count, tab counts, and the ⌘K hint.

### Named Rules
**The Machine Fact Rule.** Geist Mono is only for facts a machine produced: ids, counts, seals, paths, keys, models and clocks. Headings, labels and status words are never mono, and mono is never used to make something look technical.

**The Sentence Case Rule.** Titles, badges, buttons and headings are in sentence case. Server-rendered headings inside the workspace are raised to sentence case with `::first-letter`, and nothing is uppercase and letter-spaced.

## Layout

**The frame (desk, above 1150px).** Frame grey fills the viewport (100dvh, minimum 440px) with 8px padding on the top, right and bottom and none on the left, so the sidebar sits flush on the frame. It is a three-column grid with 8px gaps: the sidebar (216px), the main sheet (`minmax(0, 1fr)`), and the Crew sheet (320px). The first viewport reads, left to right: the accent mark and wordmark, the ink New task button, the project switch, nav rows with the current page as a raised pill and the accent needs-you count, then the main sheet with its 52px header over compact rows, and the Crew sheet beside it.

**Frame variants.**
- *Detail:* a task opened beside the list uses 196px | `minmax(330px, 1fr)` | `minmax(400px, 1.12fr)`.
- *Docked Ask panel:* on a task, result or project page with its own conversation, the columns are 204px | 1fr | `minmax(340px, 400px)`. A Chat / Crew segmented control sits over the right sheet.
- *Single:* on full-width pages (Tasks at `/work`, the board, queue, workbench, code and flows) the columns are 216px | 1fr and **the Crew sheet is absent, because the list already is the crew.**

**The Chat landing (`/chat`).** The conversation is the page. The main sheet holds only the thread and, pinned below it outside the scroll, the composer. The thread fills the sheet; an empty one says "What would you like to work on?" and offers the starter kits on one line, nothing more. Home (Now, the four counts, plan use, Catch up) sits in the right sheet, the Work panel, under a Home / Crew segmented control with Home first; the Crew is one tap away. A phone reaches the same panel from the header's **Work** button (**Open work** while a task or result is open). Home and the Crew keep every link they had; neither ever renders inside the conversation. Only the landing swaps Crew for Work: task, project and team chats keep the Crew sheet as before. At a desk with a mouse the composer takes focus when the page opens (unless a `#section` link or another control already has it); a touch screen waits for a tap, so no keyboard covers the thread.

**A replaced thread.** When the projects the lead can reach change, a new lead thread starts (mate arc ruling 9). The previous thread's words stay readable above one quiet centred divider, "New conversation — the projects I can reach changed", with hairlines either side. Its cards keep their outcome and lose their buttons; only the thread below the divider can be answered or acted on. Ending the conversation forgets its words, so nothing is shown after an end.

**The phone setup.** "Use it from your phone" (pair a chat app, or this console over Tailscale) lives in Settings → Chat apps under the tiles. After the first Ready result Chat shows one dismissible line in the notice gutter, "Use it from your phone too · Set up", linking there, until it is put away or Telegram is paired.

**Compact desk (901 to 1150px).** The sidebar narrows to 184px (172px in detail, 178px docked) and the Crew sheet to 286px. Gutters tighten to 17 to 22px.

**Phones (900px and below).** The frame dissolves. The layout becomes a single flex column with no padding, the background turns paper, and the sheet fills the screen with no inset, radius or shadow. The sidebar is replaced by a menu button that opens it as a left drawer (at most 300px, on frame grey). Crew and the Ask panel become a second full-screen view, reached from a header button and returned from with a back button. The header grows to 60px (52px at 760px and below) and clears the status bar with `env(safe-area-inset-top)`. The composer clears the home indicator. Controls, nav rows, summaries and standalone links become 44px tall. Inputs are set at 16px so iOS does not zoom.

**Inside a sheet.** A 52px header sits over a hairline, holding the page name (Title Small), a muted focus label, and on the right the command trigger with its mono ⌘K hint. Page content is padded 24px top and bottom and 28px on the sides (16px on the sides on phones). Notices stack in the top gutter with 8px gaps.

**Content widths.** The Tasks list is left-aligned and capped at 960px, so a row's chip, title and action stay together; Projects spans the sheet, sharing the notice's left edge and the header's right edge. Task and result pages are centred at up to 56rem. The conversation column is centred at 780px with prose capped at 72ch. Empty-state copy is capped at 42ch.

**Rows and grids.**
- *Tasks list:* a visible 22px title with "3 need you" beside it, usage folded to one line on its right ("Claude 48% · Weekly 83% · Codex 12%", the tiles on click; below the list on a phone). What needs a person comes first, grouped by its ask under small headings with counts: Decide (approve a plan, answer a question), Review (a result to accept or send back), Unblock (sign-in, builder offline, a blocked or failed task); All then lists Building, then the rest by recency. One three-column grid is shared by every row and group through `subgrid`, with a 16px column gap: chip (auto), title and meta (`minmax(0, 1fr)`), action (auto). A waiting row's chip is solid ink naming the ask, and its title is 600; every other row keeps a quiet neutral badge and a 500 title. Rows are padded 12px by 8px and separated by hairlines, not inside a card, and a hovered row fills with raised. At 760px and below a row is a small grid: the title with its 44px action on the right of the title line, then the chip beside the project and age, then any detail.
- *Task facts:* a definition grid under a hairline (not a card), with a 32px column gap and 16px row gap. It has one column below 480px, two from 480px and three from 1024px.
- *Settings home:* the destination tiles sit under short muted headings (Agents, Automation, Chat apps, Access and rules, System), four across at a desk and two on a phone; each chat app's tile adds one muted status line with its dot ("Gets alerts", "Connected", "Not set up", or "Has a problem" with a warning dot when its saved delivery state reports one), from state the server already holds.
- *Crew rows:* the title (13px / 500) with its badge under it (the task's headline, the same words as the Tasks list, task page and result page), the project name in muted 12px, and an optional text action. Hairlines run above the first row and between rows. On phones the badge moves beside the title.

**Rhythm.** Spacing steps are 4, 8, 12, 16, 20, 24 and 28px. Page blocks stack with 16 to 20px gaps, card internals with 12 to 16px, and inline clusters with 6 to 8px. Section headings get more space above them than below.

**Phone density (760px and below).** Phones show about a third more on a screen, compact by layout and never by shrinking what a finger hits. The header is 52px, the side gutter 16px, and the steps tighten to the shared `--so-phone-*` tokens (in `serve.ts`): 12px under the header, 14px between page blocks, 8px between rows, 12 to 14px inside a card. Secondary lines sit at a 1.35 line height and meta text keeps the desk's size. A row's action sits at the right of its title line, a status chip stays beside the name or on the meta line, and secondary facts run on as one line ("Last success 16:39 · Used by Alerts"). Times shorten to "16:39" today, "Yesterday 16:39", or "Sep 28"; the full stamp stays in the `title` and on a desk (`when-html.ts`). Every tap target stays at least 44px (a small control may reach it with transparent padding taken back by a negative margin, or a larger hit area) and every field 16px.

**Control heights.** Controls are 32px at a desk (28px for the small size) and 44px on phones. The shell switches at 900px. The shadcn components switch at 760px (the `phone:` variant in `tailwind.css`, with `desk:` above it), so between 761px and 900px they stay 32px. This is a known divergence.

## Elevation & Depth

Signal is flat by construction. Depth comes from three layers of material rather than from shadows: the frame (ground), the paper sheet on it, and the raised or soft fills on the paper. Inside a sheet, separation is a 1px hairline. There is one resting shadow for sheets, a smaller one for the single raised pill, and a deep one only for things that float above the page. There is no glass, no backdrop blur and no gradient anywhere. The console's older `--glass*` tokens now resolve to paper, `--ambient-*` to transparent, and server cards' `--shadow` to none. In dark mode shadows barely read on near-black, so every shadow leads with a 1px ring and the ring does the work.

### Shadow Vocabulary
- **Sheet** (`box-shadow: 0 0 0 1px rgb(0 0 0 / .06), 0 1px 2px rgb(0 0 0 / .04), 0 4px 12px -6px rgb(0 0 0 / .06)`; dark `0 0 0 1px #262626, 0 1px 2px rgb(0 0 0 / .4)`): the main sheet, the Crew sheet and the Ask sheet. Nothing else rests at this height.
- **Pill** (`box-shadow: 0 0 0 1px rgb(0 0 0 / .06), 0 1px 2px rgb(0 0 0 / .06)`; dark `0 0 0 1px #2a2a2a, 0 1px 2px rgb(0 0 0 / .5)`): the current nav pill, the active segmented tab, outline buttons, the project switch and chat suggestions. These are paper pills on a grey track or frame.
- **Overlay** (`box-shadow: 0 0 0 1px rgb(0 0 0 / .08), 0 24px 48px -12px rgb(0 0 0 / .22)`; dark `0 0 0 1px #2e2e2e, 0 24px 48px -12px rgb(0 0 0 / .7)`): dialogs, the command menu, dropdown menus, the slash menu and the scroll-to-latest button. Dialogs sit over a scrim of `rgb(0 0 0 / .32)` (`.6` in dark).
- **Focus halo** (`box-shadow: 0 0 0 3px` ink wash, with the border turned accent): a focused field or the composer. Buttons and links take a 2px accent outline at a 2px offset instead.

### Named Rules
**The Hairline First Rule.** Separate things with a 1px line before you reach for a shadow. A new surface inside a sheet gets a hairline or a raised fill and never its own shadow.

**The One Sheet Shadow Rule.** Only sheets rest on the sheet shadow. Cards inside a sheet are flat (a hairline border and no shadow), and cards are never nested.

## Shapes

The corners nest: the further in a surface sits, the smaller its radius. Sheets, dialogs, the composer, user chat bubbles and segmented tab tracks are 12px. Cards, dropdown menus and the slash menu are 10px. Buttons, inputs, nav pills, alerts, notices and active tab triggers are 8px. Menu items and small source chips are 6px. Badges are 5px. Counts are full pills (9999px) so a number can never be mistaken for a state badge. Status dots are circles: 6px for the live dot, 8px in lists and menus, 10px on a status card.

Borders are always 1px. Hairline is used for separation and cards, control line for field boundaries, and a status hue at reduced strength only on a failed card (vermilion at 50%) or the Cancel fold (vermilion at 30%). A coloured left stripe is never used as an accent. Callouts are a soft fill with a full hairline or no border at all.

The brand mark is three 3.5px bars skewed −10°, with the middle bar taller (20px against 13px), filled in the ink accent. It sits beside a 13.5px / 600 wordmark with −0.02em tracking.

## Components

### Buttons
Quiet, compact, and ink by default. The colour is saved for the one verb that settles a wait.
- **Shape:** gently rounded (8px). The label is 13px / 500 with a 14px icon on the trailing side for "go" acts (→).
- **Primary:** ink fill with paper text (on-ink), 32px tall and 12px of side padding. It is used for the New task button, Mark complete, and a status card's action when the state is not a wait.
- **Signal (attention):** accent fill with on-signal text, the same geometry. There is at most one per screen or card, and only when the screen waits on the person: Inspect the result, Approve, the result page's next act.
- **Outline:** a paper pill with the pill shadow, ink text, and a soft fill on hover. It is the default for every row action, page tool and secondary choice (Request changes, Open, Work tools, Next page).
- **Ghost:** muted text on nothing, with a soft fill and ink text on hover. It is used for toolbars, knowledge links, and destructive text buttons (with vermilion text) that sit far from the primary act.
- **Danger:** vermilion text on the vermilion wash, used for a confirmed destructive act (Remove key) behind a disclosure.
- **Hover / Focus:** colour transitions run 120ms ease-out. Focus is a 2px accent ring at a 2px offset, in the shell, on server pages and on the rebuilt shadcn controls (`--color-ring` maps to the signal). Disabled buttons drop to 48 to 50% opacity and show a not-allowed cursor.
- **Sizes:** default 32px, small 28px (12.5px text), icon 32px square. All of them become 44px below the phone breakpoint.

### Badges (status chips)
- **Style:** 5px corners, 1px by 6px padding, 11.5px / 500 on an 18px line, in sentence case. The text is the hue and the fill is its soft wash. There is no border.
- **Tones:** neutral (the default, for any fact), attention (accent, a person is needed), danger, warning, info and success. A status's tone comes from one mapping (`toneOf`), so a task reads the same in the list, in the Crew sheet and on its own page.
- **Peek chips:** on the Projects page, only "N waiting on you" takes colour (attention). Running, queued and built today are neutral facts.

### Cards / Containers
- **Corner Style:** 10px.
- **Background:** paper, on a paper sheet, so a card is defined by its hairline border and not by its fill.
- **Shadow Strategy:** none. See Elevation.
- **Border:** a 1px hairline. A failed status card takes vermilion at 50% and nothing else changes colour. A waiting card keeps a neutral border, and its badge and single accent verb carry the wait.
- **Internal Padding:** 20px (14px on phones), with a 16px gap between blocks (12px on phones). Grouped folds (task details, Manage) are one card with zero padding, divided by hairlines, each fold with a 15px / 600 summary and a rotating chevron.

### Inputs / Fields
- **Style:** a paper fill, a 1px control-line border, 8px corners, 32px tall, 10px side padding and 13px text. Placeholders are muted.
- **Focus:** the border turns accent with a 3px accent-wash halo (shell and server fields, the composer). The shadcn inputs and selects show a 2px accent ring. The caret is accent everywhere.
- **Error / Disabled:** an error is a vermilion alert (a vermilion wash fill, 8px corners, 13px text), never a red border alone. Disabled controls are dimmed with a not-allowed cursor.
- **Touch:** 44px tall with 16px text below the phone breakpoint.

### Navigation (the sidebar)
- **Style:** it sits directly on frame grey, with no sheet and no border. Top to bottom: the brand mark and wordmark, the ink New task button (full width, 32px), the project switch (a paper pill select), the primary rows (Chat, Tasks, Flows, Projects, Knowledge, Settings), then Workspace tools and the account at the foot, above a hairline.
- **Rows:** 32px, with 6px by 8px padding, 8px corners, a 16px drawn icon at 85% opacity, and 13px / 500 text in nav ink.
- **States:** hover fills with nav hover and ink text. The current page is a **raised pill**: a paper fill, ink text, the pill shadow and a full-opacity icon. The needs-you count sits at the row's right edge as a filled accent pill (18px, Geist Mono 11px, tabular).
- **Mobile:** the sidebar becomes a left drawer from the header's menu button. Rows grow to 44px and 14px text.

### Segmented tabs
- **Style:** a raised track (12px corners, 2px inset, 32px tall) holding 8px-cornered triggers in muted 13px / 500. The active trigger is a paper pill with ink text and the pill shadow. The tab counts next to the labels are Geist Mono 11px. The "Needs you" count becomes a filled accent pill when it is above zero, and every other count stays muted.
- **Link tabs:** filters stay real URLs (the Tasks views, a task's Overview / Ask), so Back and bookmarks work.

### Integration marks
- **One mark everywhere an integration shows** (Tools tiles and cards, Integrations rows): `brandMarkHtml` in `brand-mark.ts`. A 32px neutral-soft tile with 8px corners holds the logo at 20px, monochrome in `currentColor`: ink when connected, muted otherwise, in light and dark. The mark carries its own sizes (`BRAND_MARK_CSS`, `--brand-mark`); it drops to 28px (logo 17.5px) where the Tools tiles switch to their phone layout (`TILE_PHONE`, 600px).
- **Among plain icons** (the Settings home chat apps) the logo is drawn as one more icon, no tile: `brandIconHtml`, or `BrandIcon` in React, sized and coloured like the icons beside it, with the tile's state line kept.
- **Logos** are generated into `src/brand-icons.ts` by `scripts/brand-icons.mjs`: one 24x24 path each, centred, every mark with the area of a 20x20 square so a wide wordmark reads at its neighbours' size (never past the box). A logo's shapes are kept as drawn and only filled with `currentColor` and scaled; a white glyph stays see-through. Never per-brand colours, stretched or redrawn marks. A service without a logo shows its first letter in the same tile, and a custom tool always does, whatever its name.

### Task row (signature)
The row is the unit of the control plane. It has three columns and one colour at most. The first column holds the title (13.5px / 500, underlined on hover) and a muted meta line under it (the project, a centred dot, the age in tabular figures), plus any detail line. The second holds the status badge in a column shared by the whole list (a subgrid), so badges line up down the list. The third holds a single outline action with a trailing arrow. A problem line inside a row is vermilion 12.5px text. Rows are divided by hairlines and fill with raised on hover.

### Status card (signature)
This is the first block on a task or result page. It shows the state as a Headline with a 10px state dot, one muted sentence of outcome, and the one action on the right (full width on phones). The action is accent only when the state is a wait, and ink otherwise. Problems inside it are neutral unless the card has failed, in which case they become vermilion alerts and the card's border turns vermilion at 50%. "Checks passed" appears as a success badge. Attempts and notices fold beneath a hairline as quiet disclosures.

### One vocabulary
- **One state per task** from `src/task-status.ts`, in the same words on the Tasks list, the task page, the result page, Crew and chat. A Needs you row sits under its group heading (Decide, Review, Unblock); its chip names the specific ask (Plan, Result, Mismatch, Failed, Builder offline) or is left off, never repeating the heading. Outside a group, a chip-less waiting row wears its headline in the same ink chip. Each Review row says its own reason. Crew is not exempt: it reads the list's own words for each task (the headline), never a group heading or chip in its place.
- **One source per fact.** Requirement words (Met, You check, Not shown yet, Not met, Unverified) come from `requirementWordOf`, so the card and the Checks tab agree. The project's own checks are "Project checks"; the pull request's are "PR CI".
- **One time formatter** (`src/when-html.ts`): "16:39" today, "Yesterday 16:39", "Sep 28" otherwise, in the viewer's zone, with the exact minute in the title. Server-rendered times are reworded in the browser by the same formatter.
- **One name per thing.** Opening a result is always "Open result". "Task details" is the side panel, "Plan details" the plan's fold in the approval, and "More" the status card's fold. One disclosure glyph, the chevron (`src/disclosure.ts`), pointing right when shut and down when open. Badges, labels and buttons are sentence case.

### Result page (signature)
There is one result page per builder result, titled with the task (`/review?result=<task>&run=<id>`, never a project path in the URL, and the project switch keeps the person's own choice). `/r/<id>` for that result redirects to it; the raw run record sits in the folds at the foot of the page as "Run record", and the header's Build # opens it there. The status card is the headline, one sentence and the facts rows, with any caveat as one line of its own under the facts; it holds no acts. The acts sit together in the decision row after the evidence (one row, 8px gap at a desk; on a phone a full-width dock at the bottom, the ink act over the outline one). Exactly one act is ink, the one that resolves the state, and it is never navigation (`src/result-acts.ts`): everything met is Accept; checks that didn't run on a project that has one is Run checks, with Accept without checks in outline; a report that doesn't match its saved changes, or a refuted proof, is Request changes, preceded by one plain line ("Can't accept yet: what the agent reported doesn't match the changes it saved.") and followed by Accept in outline where accepting is allowed. Meta links (Build #, Open task, Discuss) are 44px targets on phones.

### Command menu and slash menu
- **Command menu:** a 480px dialog on paper with 12px corners and the overlay shadow over the scrim. It has a search input with a accent focus halo and result rows that are 36px tall, 8px-cornered and filled soft on hover or focus, each with a muted 11px hint on the right. It opens from the header trigger or ⌘K / Ctrl K.
- **Slash menu:** it floats 6px above the composer on paper with 10px corners and the overlay shadow. Items are 36px tall (44px on phones), with the command in Geist Mono 12.5px / 500 and a muted hint.

### Composer
Pinned below the thread, outside its scroll, so it never moves with the messages. A paper box with a control-line border and 12px corners, a hairline-faint 1px shadow, and 10px padding. On focus the border turns accent with a 3px wash halo. The textarea inside is borderless at 14px / 1.6 (16px on phones) and grows from 52px to 180px. The send button and a muted, tabular character count sit on one line below it.

## Do's and Don'ts

### Do:
- **Do** keep the ink accent for what waits on a person: the needs-you count, an attention badge, and the one verb that resolves the wait, plus focus, caret, selection and the brand mark.
- **Do** make every other act ink (primary) or a paper pill (outline). In lists, rows' actions are outline buttons and the badge carries the colour.
- **Do** put work on paper sheets (12px corners, sheet shadow) inset 8px into frame grey, with the sidebar directly on the frame.
- **Do** separate with 1px hairlines inside a sheet. Lists sit between hairlines and facts sit under one, without being boxed in cards.
- **Do** use Geist for every word and Geist Mono (tabular) for ids, counts, seals, paths and keys.
- **Do** map failure to vermilion (#c4320a / #ff977d), setup trouble to amber, live to blue, and done to green, as soft badges or small dots.
- **Do** size controls at 32px at a desk and 44px on phones, and set phone inputs at 16px.
- **Do** dissolve the frame at 900px and below: the sheet fills the screen with no inset, radius or shadow.
- **Do** drop the Crew sheet on pages whose content is already the crew (the Tasks list, board, queue and flows).
- **Do** give every token a light and a dark value, and let the device decide unless the person pins a theme.
- **Do** keep motion to 120ms colour transitions and an 80ms / 140ms page fade-through, and remove all of it under `prefers-reduced-motion`.

### Don't:
- **Don't** colour a card's border or a heading accent to announce a wait. The badge and the single accent verb already say it. (The flow canvas's decision cards still carry a accent outline. That is a known divergence, not the rule.)
- **Don't** put more than one accent verb on a screen or card, and don't make a recommended option accent. A recommendation is not urgency.
- **Don't** use accent, or any hue near it, for failure. Failure is vermilion.
- **Don't** colour a problem line red inside a card that has not failed. Render it neutral (raised fill, ink text).
- **Don't** use glass, backdrop blur or gradients, or a shadow on a card inside a sheet.
- **Don't** set headings, labels or status words in Geist Mono, and don't use uppercase, letter-spaced labels.
- **Don't** use a coloured side stripe as an accent on callouts, cards or alerts.
- **Don't** repeat a state that a heading already names. A chip that restates its group's title is removed.
- **Don't** nest cards, or wrap a single server card in a second card.
