# youiyoux in Toolroll: what else to bring in

Status: research, 2026-11-22. Nothing here is built or approved. Sources: the youiyoux checkout
(README, docs/agents.md, docs/commands.md, docs/self-hosting.md, packages/, schema/) and Toolroll at
`feat/native-mac-app-v1`.

## Short answer

Three things are worth doing, and two of them need almost no Toolroll code:

1. **Give build agents the youiyoux MCP server** (a catalog entry in project tools), so
   `ui_find_component` works during a build. Today it cannot.
2. **Run `check --diff` in the project's check**, so design drift shows up on the result before review.
3. **Let `render` feed check screenshots**, so a UI result arrives with light/dark, desktop/phone and
   before/after images through the screenshot path that already exists.

Everything else is Maybe or Skip. The requests-to-tasks idea is already shipped.

## A gap found on the way

Toolroll's own AGENTS.md (the generated youiyoux block) tells agents to call `ui_find_component`,
`system_*`, `ui_render`, `requests_list` and `screens_capture` on the MCP server `youiyoux`. In a Toolroll build
that server is not there:

- Builds start with `--strict-mcp-config` and load no repository `.mcp.json`
  (`src/provider.ts` `CLAUDE_BUILD_ISOLATION_ARGV`, `CODEX_BUILD_ISOLATION_ARGV`). A build gets only its
  project's named tools (`src/project-tools.ts`).
- `TOOL_CATALOG` has Playwright, Chrome DevTools, Context7, shadcn and others; it has no youiyoux entry.
- Toolroll's own `.mcp.json` and `.codex/config.toml` register only shadcn, so local sessions lack it too.
- Builds never start Chromium (`docs/plans/checks-screenshots.md`), so `ui_render` and `screens_capture`
  would fail in a build even with the server present.

So the rule is followed only through the CLI fallbacks (`npx -y youiyoux show`, `check --diff`). I could not
see the store, so a project may have added the server by hand; the repo itself does not.

## What already exists (do not rebuild)

| Touchpoint | Where |
| --- | --- |
| Change and options requests become tasks, filed once, always wait for a person | `src/youiyoux-intake.ts`, `src/contracts/youiyoux-request.ts`, `src/task-source.ts` |
| Status written back beside each request (`<id>.task.json`); options copied to `.youi/proposals` | `src/youiyoux-intake.ts` |
| Approve the filed tasks from chat, one or all | `src/chat-decide.ts`, `src/chat-terms.ts` |
| Settings → Integrations youiyoux row, Turn off | `src/integrations.ts`, `src/server/settings.ts` |
| A task shows the request, page, component and file:line it came from | `src/task-source.ts` |
| Onboarding line for a project that uses youiyoux | `src/agent-onboard.ts` |
| PR drift check, strict, advisory to releases | `.github/workflows/youiyoux.yml`, `src/release.ts` `ADVISORY_PR_CHECKS` |
| Design system config, baseline, lock, portable rules | `youi.config.json`, `youi.project.json`, `youi.baseline.json`, `youi.lock.json`, `youi-rules/` |
| Generated tokens, contracts, rules, skill, AGENTS.md block | `src/design/*`, `.agents/skills/youiyoux/SKILL.md` |
| Screen list for captures | `.youi/screens/screens.json` |
| App and web token parity | `src/mac-palette.test.ts` |

### What the Mac Canvas already covers

`mac/Sources/ToolrollCore/CanvasModels.swift`, `CanvasWorkspaceView.swift`, `ScreenFocusLightboxView.swift`,
`WorkbenchStore.swift`:

- Screens: route discovery (`.youi/screens`, then TanStack, Next, Astro/Vite), live tiles at desktop and phone
  size, a disk tile cache, one managed preview server.
- Pins: point at an element, comment, batch as per screen, single task or per pin, and file. Each pin is written
  as a `youi.request/v1` file with a cropped screenshot, so the intake above turns it into a task.
- Compare: wipe, side by side and pixel diff with a changed-pixel share, run-scoped baseline checkpoints,
  reference mockups, live style tweaks.

That is youiyoux's Screens, requests and "before and after" surface, done natively. Proposals below avoid it.

## youiyoux capabilities, inventoried

| Area | Capability |
| --- | --- |
| Report | `npx youiyoux`: HTML report, share card PNG, summary markdown; `--json`; top fixes with files and a next step |
| Diff check | `check --diff [base]`: near-duplicates, hardcoded values, off-library imports, rule breaks; `--strict`, `--json`, `--format github` |
| Whole check | `check`: rules plus lockfile drift, against a baseline |
| Render | `render` / `ui_render`: a component's real looks, light and dark, 1280 and 390, axe issues marked new or pre-existing, pixel diff against base |
| Find | `ui_find_component`: existing component for a need, with import, props, real usage and what it lacks |
| System lookups | `system_search`, `system_get_component`, `system_get_tokens`, `system_get_rules`, `system_where_used`, `system_screen_bom`, `system_check`, `system_plan`; CLI `show`, `where`, `bom`, `plan` |
| Index | `index_where_used`, `index_swap_impact`, `index_rule_covers`; `inventory`, `gaps`, `scan`, `index` |
| Requests | `requests_list`, `request_reply`, `request_addressed`; CLI `requests` |
| Screens | `screens capture`, `screens login`, `screens_capture` |
| Agent setup | `agents install/remove` (rule block plus MCP registration), `hooks install` (Claude post-edit, git pre-commit, CI) |
| Design system | `adopt`, `system extract`, `init`, `sync`, `link`, `upgrade`, `migrate`, `build`, `parity`, `schema --check` |
| Library and Discover | `library search/request/ingest` (GitHub, Storybook, Figma, DESIGN.md), `discover` (shadcn registries, npm), `detect` (repo or site) |
| Hubs | `ui` local hub (screens canvas, rule and style editors, Discover gallery, workspace view); `hub serve` and `record` for a team's hosted hub |
| Status | `status --json`: System version, pending sync, drift, errors, open requests, next step |

## Recommend

### 1. youiyoux as a project tool for builds

- **What:** a pinned `youiyoux mcp` entry in the project tools catalog.
- **Value in the loop:** during a build the agent asks `ui_find_component` before writing a component and reads
  exact contracts with `system_get_component` and `system_get_tokens`. Fewer duplicate components and guessed
  props means fewer revisions at review. It also makes the AGENTS.md rule true for any project that ran
  `youiyoux agents install`.
- **Plugs in:** `src/project-tools.ts` `TOOL_CATALOG` (one entry, same shape as shadcn). The version should be
  the one `.github/workflows/youiyoux.yml` pins. No web or Mac change: the existing project tools screen lists it.
- **Effort:** S. **Bloat:** none; it is one more catalog row. **Freeze:** not a frozen area; it is settings work.
- **Risks and open questions:**
  - The server reads the checkout, which is build-controlled. It must run inside the build's fence like other
    project tools, never beside the plane. Confirm how the tool broker starts stdio servers before adding it.
  - `npx -y` fetches from npm at run start. Confirm the build fence's network policy allows it, or the entry
    will fail quietly. Pin an exact version.
  - Three tools write: `request_reply` and `request_addressed` write `.youi/requests`, `screens_capture` writes
    `.youi/screens`. In a build these land in the worktree, not the project's main checkout, and Toolroll already
    owns request status. Limit the build to the read tools if project tools support per-action rules
    (`ToolRule` in `src/store.ts` suggests they may), or ask youiyoux for a read-only flag.
  - `ui_render` and `screens_capture` need Chromium and will fail in a build. The agent should be told so, or it
    will retry. See item 3 for where rendering belongs.
  - Sealed at approval: a task approved before the tool was added will not have it.

### 2. `check --diff` in the project's check

- **What:** the design drift check runs after a build, on the candidate, and its findings reach the result.
- **Value in the loop:** the reviewer sees "this change adds a second Button" or "2 hardcoded colours" with the
  fix, before accepting. Today that only appears later on the pull request.
- **Plugs in, two steps:**
  - Step A (S, no Toolroll code): a project adds
    `npx -y youiyoux@<pin> check --diff <base> --strict` to its approved Quick or Full check
    (`src/check-levels.ts`). It then passes or fails like any other check line.
  - Step B (M, later, only if A proves useful): Toolroll runs it itself as an advisory "Design" line on the
    result, never gating, mirroring how releases treat the CI job. Touches `src/batch-checks.ts`,
    `src/check-report.ts`, `src/browser/views/result-view.tsx`, and `TaskCockpitView.swift` on the Mac.
- **Bloat:** A none. B low if it is one line with the findings behind a disclosure.
- **Freeze:** not frozen. B adds a result-page element, so it needs the simplicity pass.
- **Risks:**
  - It runs in a build-controlled checkout: check fence only, through the shared hardened helper.
  - The base must be the base Toolroll recorded for the task, never one read from the checkout.
  - The output is outside text: cap it, clean it, and never make a decision from it.
  - `incomplete: true` means "could not run", never a pass. youiyoux and Toolroll agree on this rule.
  - With `--strict` in Step A a design finding fails the check. Projects that want advice only should wait for B.
  - Needs network for `npx` in the check fence, or a preinstalled copy.

### 3. Render images as check screenshots

- **What:** the project's check runs `youiyoux render` and saves the images where Toolroll already looks.
- **Value in the loop:** a UI result arrives with the changed component drawn light and dark, at desktop and
  phone width, plus a before/after diff and new accessibility issues. That is the "Ready with screenshots" half
  of the loop, for component-level changes, without the project writing Playwright tests.
- **Plugs in:** no Toolroll code. `src/check-screenshots.ts` already ingests up to 8 validated PNG or JPEG files
  from `evidence/checks/` after a check. The project's check script copies render's output there
  (`render --json` lists the paths). A short recipe in `docs/guide/` is the only deliverable.
- **Effort:** S. **Bloat:** none. **Freeze:** not frozen.
- **Risks:**
  - `render` bundles and server-renders the project's own code. That is fine in the check fence, where
    Chromium is allowed, and nowhere else.
  - Chromium is a 100 MB download on first use; set `YOUI_CHROMIUM` to an installed one.
  - Render caches under `~/.cache/youiyoux`. The check fence may not allow that path; point the cache inside
    an allowed folder or expect a cold render each time.
  - These images are reviewer evidence only. They never satisfy an acceptance criterion
    (`docs/plans/checks-screenshots.md`), and with a cap of 8 a large change shows a sample.

## Maybe

### 4. Top fix becomes a proposed task

- **What:** `youiyoux report --json` names the top fixes, each with the files to change and a concrete step.
  Toolroll offers the first one as a task proposal.
- **Value:** a ready-made, exactly scoped task ("keep Button in X, remove the copy in Y") is what the approval
  step wants. Good first-run material for a project with UI: a real, small, safe first task.
- **Plugs in:** a reader beside `src/youiyoux-intake.ts`, filing through `src/proposal.ts` under the same
  outside-request quarantine; surfaced in Projects → Activity (`src/project-activity.ts`), not on Work.
- **Effort:** M. **Bloat:** medium; it is a new source of suggested work. **Freeze:** not named, but it is new
  capability, so weigh it against first-run work.
- **Risks:** the report is derived from the repo, so its text is outside text; a scan of a large repo is slow;
  the suggestion must be on demand, never filed by itself.

### 5. Report card numbers in Projects → Activity

- **What:** one line per project: duplicates, hardcoded values, off-library imports, and the trend.
- **Value:** shows whether agent-built UI is drifting over time. Useful, but it is not in the approve, build,
  review loop.
- **Plugs in:** `youiyoux status --json` or `inventory --history`, read on demand into
  `src/project-activity.ts`; not a Work widget.
- **Effort:** M. **Bloat:** high if it lands on Work; low as one Activity line. **Freeze:** not named; low
  priority against speed and first-run.

### 6. Extend the Integrations row into one switch

- **What:** the existing youiyoux row also shows whether builds have the tool (item 1) and whether the check
  runs it (item 2), with one "Set up" action.
- **Value:** first-run and settings are the stated priorities, and today the three pieces are set in three places.
- **Plugs in:** `src/integrations.ts` `youiyouxIntegrations`, `src/server/settings.ts`,
  `ProjectSettingsSheet.swift`.
- **Effort:** M. **Bloat:** low. **Freeze:** fits settings. Only after 1 and 2 exist and are used.

### 7. Exact pin targets from the usage map

- **What:** the Mac Canvas resolves a pinned element to its component and file:line with youiyoux's scan
  (`where`, `bom`) instead of its own source-file search.
- **Value:** the intake keeps a task's file list only when every path is known. Better targets mean more tasks
  arrive with an exact file scope to approve.
- **Plugs in:** `CanvasModels.swift` `findSourceFile` and `writeYouiRequest`.
- **Effort:** M. **Bloat:** none. **Freeze:** not frozen. **Risk:** the scan reads the project's main checkout
  and needs `youiyoux scan` to be current; measure how often the current search is wrong first.

### 8. System update as a task

- **What:** when `status --json` says a design system release is pending, offer `youiyoux upgrade` as a task.
  Its preview is the scope.
- **Value:** design-language sync for any connected project, with a person approving the exact change.
- **Effort:** M. **Bloat:** medium. **Freeze:** new capability; wait for a project that actually has an
  external design repo. A person can file "run youiyoux upgrade" as an ordinary task today.

## Skip

| Feature | Why |
| --- | --- |
| Requests to tasks, status back, options on the canvas | Shipped (0.9.85). |
| Screens capture, pins, compare, before/after | The Mac Canvas does it natively. Recapturing a route at a result's commit needs the app running at that commit: large, and builds never start a browser. |
| `request_addressed` from the build agent | Toolroll writes the request's status itself; an agent's write would land in a throwaway worktree. |
| Claude post-edit hook (`hooks install --claude`) | Builds load no settings or hooks by design. Item 2 covers the same findings at the check. |
| Hosted hub, `record`, workspaces | A team-wide, CI-fed product of its own. No place in a single person's review loop. |
| Local hub rule and style editors, design approvals | Toolroll would become a design tool. Keep that in youiyoux. |
| Discover, Library ingest, Figma, `detect <url>` | Fetches outside code and sites. The shadcn tool is already in the catalog. |
| `adopt`, `system extract`, `migrate` as Toolroll features | One-off repo changes. File them as ordinary tasks; no product surface needed. |
| `inventory`, `gaps`, `index_*` on their own | They come with the MCP server in item 1. No separate UI. |
| `parity`, `build`, `schema --check` | Design-repo maintenance. Toolroll already tests its own parity. |
| Share card and HTML report inside Toolroll | A marketing and audit artifact, not review evidence. |

## Suggested order

1. Item 1, after confirming the fence and network questions. It also fixes the gap in Toolroll's own builds.
2. Item 3 as a written recipe, tried on Toolroll itself.
3. Item 2 Step A on Toolroll itself for two weeks. Count how often a finding changed a review.
4. Only if those are used: item 6 (one switch), then item 2 Step B.
5. Items 4, 5, 7 and 8 wait until after the 20 outside users.

## Not verified

- Whether the build and check fences allow `npx` to reach npm, and where project tool servers run.
- Whether project tools can limit a server to some of its tools.
- Whether a project in the store already lists youiyoux as a tool.
- How often the Mac Canvas's source-file search picks the wrong file.
- No youiyoux command was run for this research; behaviour is taken from its docs and source layout.
