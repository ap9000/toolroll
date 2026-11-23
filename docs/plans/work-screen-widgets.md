# Work screen as widgets — plan (for Codex + critic review)

Owner decisions (2026-11-22, design canvas https://claude.ai/artifact/WLfji2iniMqAZqbv4TrAry):
- Ship version **A · Quiet list** as the Mac app's Work screen, plus sidebar fix **1** ("New task" as the first row,
  drop the "Nothing active / Start something new (⌘N)" text).
- Build it **as widgets from day one**; the editing layer (version D: edit mode, agent proposals, gallery) follows.
- Optimize for: very beautiful widgets; everything fully customizable; widgets easily downloadable, including from a
  widget store the owner (or anyone) hosts; a data backend that can use connector data (Linear, GitHub, …).
- Feature freeze (AGENTS.md) allows Work-screen work; it forbids new flows/teammates/inboxes/evals features.

## 1. Concepts

**Widget** — a declarative manifest, never code. `toolroll.widget/v1`:
```json
{
  "schema": "toolroll.widget/v1",
  "id": "failing-checks", "version": "1.2.0",
  "name": "Failing checks", "description": "…", "author": "…", "license": "MIT",
  "icon": "checkmark.circle",            // SF Symbol name from an allowlist
  "source": { "kind": "engine", "name": "checks", "params": { "result": "failed" } },
  "view":   { "type": "list", "fields": { "title": "$.name", "subtitle": "$.project", "trailing": "$.age" },
              "empty": "No failing checks" },
  "actions": [ { "id": "open", "on": "row" }, { "id": "retry", "on": "row" } ],
  "options": { "project": { "type": "project", "label": "Project" },
               "limit":   { "type": "int", "min": 1, "max": 20, "default": 5 } },
  "style":   { "size": "M", "accent": "auto", "density": "comfortable" }
}
```
- `options` are typed knobs the person (or the lead) sets per instance; `params` may reference them (`"$opt.project"`).
- Field mapping is a tiny path language (`$.a.b`, no expressions, no functions).
- Nothing in a manifest executes: the app has a fixed renderer for each `view.type`.

**Layout** — per person per workspace: ordered instances `{ instance, widget: "id@version" | inline manifest,
options, size: S|M|L|XL (grid span), collapsed }`. Stored on the server with a version history (undo, "what changed").

**Package** — one `*.toolrollwidget.json` file (manifest + optional preview image URL). A **store** is a static
`index.json` anyone can host (GitHub Pages, S3, a gist): `[{ id, version, name, description, url, sha256, preview }]`.
The app adds stores by URL, installs by downloading the package and checking `sha256`; packages are data-only, so a
store can't run code on anyone's Mac. Export a widget or a whole layout as one file (share by AirDrop/Slack/gist).

## 2. Data backend

Three source kinds, one output contract: every source returns `{ shape: "records"|"series"|"stat", fields, rows,
updatedAt, problem }`, capped (rows ≤ 200, payload ≤ 256 KB).

1. **`engine`** — a curated registry of named reads over Toolroll's own data, each re-proving access exactly like the
   existing reads (`accountCanAccess`, project grants): `work.rows`, `usage.plan-windows` (today in `toolroll status`),
   `machines` (registered computers, capacity, liveness), `pull-requests` (publication table), `checks`, `spend`,
   `integrations` (status). One route: `GET /engine/widgets/data?source=<name>&<typed params>`; params validated
   against the source's zod schema. New sources are added in code (a PR), not by manifests.
2. **`feed`** — **connector data, fetched by an agent, stored by Toolroll.** Toolroll stays an MCP *server* only
   (docs/mcp-gateway-spec.md: "never the other way round"), so it never calls Linear/GitHub/Datadog itself. A widget
   declares `source: { kind: "feed", feed: "linear-my-issues", refresh: "15m", recipe: { connector: "linear",
   tool: "list_issues", args: {…} } }`. A scheduled refresh runs in an agent session that has the person's connectors
   (Claude Code plugins / Codex MCP servers): it calls the read-only tool, maps the result to the output contract, and
   posts it to `POST /engine/widgets/feeds/<feed>` (local-owner or lead token; new act `write-widget-feed`). Toolroll
   stores `{rows, updatedAt, by}` in `widget_feed`. Feed text is untrusted: rendered as plain text, never put into
   another agent's prompt unfenced, size-capped, and links only open http(s) after a hover/preview.
   - Refresh cadence uses the existing scheduler; a feed shows its age and "refresh now".
   - The recipe's tool must be read-only (connector tool annotations `readOnlyHint`; otherwise refuse to schedule).
3. **`static`** — inline rows in the manifest (notes, links, a pinned checklist). No network.

Explicitly not in v1: arbitrary URL fetch from the app (egress/SSRF), JavaScript/WebView widgets.

## 3. Views (where "beautiful" comes from)

The only way pixels are drawn is a built-in SwiftUI renderer library, designed to one standard (ToolrollPalette
tokens, 4/8 spacing, SF type scale, light+dark, reduce-motion, VoiceOver labels):
`grouped-list` (the Work list: groups, status dot, title, project · branch, chips, trailing age, row actions),
`list`, `stat` (big number + delta), `meter` (usage bars with reset time), `bars` / `sparkline`, `table`,
`status-grid` (machines), `timeline`, `note` (markdown subset), `links`.
Customization per instance: size, accent (from a palette, auto by default), density, title, which fields show,
sort/group, filters. Widgets look native because only the renderers draw — that is also the safety story.
A view library version is negotiated: a manifest declares `minViews: 1`; unknown view types show a calm
"Update Toolroll to show this widget" card.

## 4. Actions

Only references to Toolroll's existing acts: `open`, `retry`, `archive`, `cancel`, `change-models`, `open-link`
(PR/issue URLs from the data). Every act keeps its own approvals and refusal words; a manifest can't invent one.

## 5. Agent editing (phase 2)

A lead/MCP tool `work.layout.propose(diff)` returns a proposed layout (add/remove/move/options) or a new manifest
(validated against the schema). The screen shows it in place ("added by the lead") with Keep / Undo; nothing persists
until Keep (a local-owner act `edit-work-layout`). Chat parity per AGENTS.md: "change my Work screen" works in chat.

## 6. Phase 1 — this build

1. Sidebar: "New task ⌘N" as the first row, always visible; remove the empty-state text.
2. Contracts: `src/contracts/widget.ts` (zod: manifest, layout, source output) + Swift Codable mirrors; JSON Schema
   exported for third parties (same pattern as `schemas.json`).
3. Engine sources v1: `work.rows`, `usage.plan-windows`, `machines`, `pull-requests`; `GET /engine/widgets/data`.
4. Layout storage: `work_layout` table (migration) + `GET/PUT /engine/work/layout` (local-owner act
   `edit-work-layout`), version history (last 20).
5. Mac: Work screen renders the layout; default layout = version A (`header-counts`, `limits-strip`,
   `grouped-list` over `work.rows` with groups Waiting on you / Running / In review / Settled).
   Renderers in phase 1: `grouped-list`, `meter` (limits strip variant), `stat`, `list`.
6. Edit mode v1: reorder, remove, resize, per-instance options sheet, add from the built-in gallery, import a
   `.toolrollwidget.json` file, export a widget/layout.
Phase 2: lead proposals, feeds + scheduler, store index (add store by URL), web/TUI renderers.

## Questions for reviewers
1. Is agent-fed `feed` the right connector design given the MCP gateway's server-only rule, or should Toolroll gain a
   narrowly-scoped MCP client for read-only tools? Trust, credential and freshness trade-offs.
2. Is the manifest/path language small enough to stay safe yet expressive enough for a real community?
3. Layout per person vs per workspace vs per device; sync and conflict handling.
4. Store trust: digest-only, or signed packages (minisign/Sigstore) from day one?
5. Where should the renderer contract live so web and TUI can render the same widgets later?
6. Anything in phase 1 that will be expensive to change later.
