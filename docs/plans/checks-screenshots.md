# Screenshots from Checks, not from the build agent

Status: revised 2026-11-22 after critic review (v1 below supersedes the original design, kept for the record). Owner decision (Alex): builds never start Chrome; screenshots move to
the Checks step.

## Problem

An acceptance criterion whose evidence is `screenshot` makes the build agent produce images itself
(`builder.ts:1011` requires a committed screenshot inventory; `builder.ts:2587` validates the agent's claimed files).
A build's sandbox never allows Chromium (`agent-fence.ts fenceFor`: the Mach rendezvous rule `SEATBELT_CHROMIUM` is
for kind `check` and approved flows only), and both reviews (2026-11-22) advise keeping it that way: build-controlled
code could message other launches' Chromium. So a Vite site task with a screenshot criterion can never finish: the
agent builds everything, then reports "Chromium launch failed: Mach-port permission denied" (run 24).

## Revised v1 (after critic review)

The original design below is withdrawn for v1. The critic found:
- adjudication happens at build time from the agent's proof (`proof.ts:59-67, 704-717, 773-778`), so Checks images
  can't satisfy a criterion without a new post-check adjudication path;
- letting a project-wide capture satisfy "shown in a screenshot" would change what an approver agreed to;
- Playwright and Chromium aren't in Toolroll's install.

v1:
1. **Meaning first.** Checks screenshots are reviewer evidence on the result. They never satisfy an acceptance
   criterion by themselves. A plan that needs screenshots from a site build uses `check` evidence for its criteria,
   and the reviewer sees the images.
2. **Ingest, don't capture.** A project's own check (for example its Playwright test) writes PNGs to
   `evidence/checks/` in the candidate checkout. After the check, at the `checkoutRunner` call sites
   (`batch-checks.ts:198,206`, `result-follow-ups.ts:275,287`), Toolroll reads at most 8 files through the existing
   mailbox reader (no links, size cap), validates each with `validateScreenshotBytes` and stores it with
   `storeEvidence(..., "screenshot")` against each run the check covered.
3. **Bound to the candidate.** The evidence record gains the candidate digest, from Toolroll's store, never the
   checkout. `result-evidence-readers.ts:8` and the result views read Checks images by that binding, so a later
   candidate never shows an earlier one's images.
4. **Chromium stays where it already runs.** Project checks already run in the check fence with `browser: true`
   (`agent-fence.ts:1226`); nothing new is granted to builds or checks.

Tests: ingest refuses links, oversize files, non-images and more than 8; per-run attribution in a batch; candidate
binding (a new candidate hides old images); the result reader shows Checks images.

Later, only if ingest proves insufficient: a Toolroll-owned capture (its own dependency, packaging and real-fence
Chromium test, process-group cleanup of the preview).

## Original design (withdrawn)

Toolroll captures the screenshots itself, in the **check** fence, after the candidate's checks pass, with its own
capture script (never build-controlled code driving the browser's launch):

1. **Project setting `previewCommand` + `screenshotPaths`** (Project Settings → Checks; CLI
   `toolroll project checks --preview "<cmd>" --paths /,/about`). The preview command is trusted like the check
   command (an approver sets it with a password, ledgered). `{port}` is substituted with a free loopback port.
2. **Capture step** (`src/result-shots-capture.ts`): inside `fencedCheckoutCommands` for the saved candidate (kind
   `check`: Chromium allowed, the project's live network): start the preview command, wait for the port (fact-based
   wait, bounded), run Toolroll's own Playwright script (shipped in `dist/`, resolved from Toolroll's install, never
   the checkout) for each path at desktop 1440x900 and phone 390x844, then stop the preview's process group.
3. **Evidence**: each PNG validated with `validateScreenshotBytes` and stored with `storeEvidence(..., "screenshot")`
   against the checked run and candidate digest; a page that failed is recorded as a missing image with the reason
   (never silently dropped). The result page and the Mac app's result view already render run screenshots.
4. **Acceptance**: a criterion's `screenshot` evidence is satisfied by Checks screenshots of the same candidate. The
   build's requirement at `builder.ts:1011` no longer forces the agent's own inventory when the project has a
   capture configured; the planner's brief tells the agent screenshots come from Checks.
5. **Needs local services**: the preview listens on loopback. When the project's network has local services off, the
   capture step doesn't start and the result says so with the one action ("Allow this Mac's local services").

## Security notes

- The browser runs in the check fence, as project checks with Playwright already do; nothing new is granted to builds.
- The page content is build-controlled (it is the candidate); the browser's launch, flags and output paths are not.
- Images are bound to the candidate digest; a later candidate never inherits them.

## Tests

- Unit: setting validation (paths are `/`-rooted, no scheme or host; at most 8); candidate binding; missing-image
  reasons; the `builder.ts:1011` requirement with and without a capture configured.
- Native (macOS, real sandbox-exec): the capture script starts headless Chromium in a `check` fence and saves a PNG
  of a tiny static preview; with local services off it refuses with the setting's words.
- Live: a task on a sample site (my-site) with a screenshot criterion completes on Codex with desktop and phone images.

## Out of scope

Interactive browser use by build agents; screenshots on Linux (follows the existing Linux check fence later).
