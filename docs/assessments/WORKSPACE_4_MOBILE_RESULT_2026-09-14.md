# Package 4 — mobile refinement, source verified

Source candidate: `23be6e048b324a20fd05af1c52d76acf17db1b57`, branch `codex/workspace-4-mobile-polish`, based on `235eb9188c4a7e4f5df0d3023ecf47d712ce4797`. September 14, 2026. Subsequent assessment/roadmap edits are documentation only.

**Source verified through Standing Orders; physical-phone acceptance and deployment remain open.** The UI implementation used disposable synthetic fixtures. A subsequent subscription-backed release-validation task independently reviewed the bounded source diff and passed the unchanged full verifier. It did not rebuild the UI or independently repeat the browser captures. The installed app is unchanged; the live database now includes the validation task described below.

## Final native gate — September 14

- Task `workspace-4-release-validation-20260914`, scope `e2939ea437c5f34c43d6196b506df360`, run **1558**. Actual route: **Codex / gpt-6-astra / subscription**. No new dollar cap, permission setting or agent time limit.
- Base `2d54e48647fce6a373ab469197d3ea5ceaffc24a`; machine-committed head `770aba98e04992a27ee65837d6e5a6e46e0ee3f4`. The only new file is the [bounded release assessment](WORKSPACE_4_RELEASE_VALIDATION_2026-09-14.md). Runtime and tests are identical to `23be6e0`; subsequent roadmap/status edits are documentation only.
- The unchanged approved command ran **once**, exit **0**: `npm run typecheck && npm test -- --run --reporter=dot --no-file-parallelism && npm run build`. **166 test files passed; 2,871 tests passed, 23 skipped** (existing suite/platform conditions; no new skips). Vitest reported 297.80 seconds. No duplicate full-suite run by the reviewer.
- Native result: task **done**, proof **verified**, both signed criteria **pass**, **Ready to review**. The agent's honest pending-verification criterion was resolved by the machine check, not an approval exception.
- Check artifact `1558/check-log.txt`, SHA-256 `f6b0a728f270f7ec8b231385798b087d37aa092fa4ac0c175d8037ab6910c2a4`; stored bytes match the recorded hash. Capture status is `ok`, but the artifact is marked truncated. It retains the command, exit status and test summary; it is not a complete raw transcript.
- Earlier attempt **1557** refused before starting a provider: standalone CLI `build` defaulted to Claude despite the approved Astra route. The normal queue workflow started the approved route correctly. This operator workaround is recorded, not counted as autonomous recovery; the separate CLI parity fix is in the [pilot backlog](WORKSPACE_5_REAL_WORK_PILOT_2026-09-14.md). The queue considered only one actual dispatch; the pre-existing `nightly-deps` routine was refused for missing current acceptance terms and did not run.

The assessment below preserves the original implementation evidence and its limitations. Source verification is not physical-device certification or proof that the installed app has updated.

## What changed

- Phone header: one project-selector surface, **90px → 57px including the border**. Chat / Work / Projects stay in their familiar positions. Primary navigation and project controls have 44–48px targets.
- Project context: vertical rows instead of a horizontal card carousel. On a phone, focus enters the dialog, Tab wraps, background controls become inert, and Escape/close returns focus. Work tools and project menus close with Escape; command-palette focus returns too.
- Result reading: removed the extra phone card border/padding. Summary / Changes / Checks, normal feedback, annotations and explicit revision approval remain intact.
- Typing: composer height determines bottom clearance. Visual-viewport shrink adjusts the composer and hides bottom navigation only when a soft keyboard is indicated; hardware-keyboard focus and pinch zoom do not hide it. No Space interception, provider changes, extra timers, or new UI dependencies.
- Simplicity: removed the repeated chat setup subtitle, routine “conversation live” badge and idle “Connected” message. Real connection/receipt errors remain visible. Approval now begins **Review plan** / **Nothing starts until you approve**, followed by every original signed term and the password confirmation. Removed only the redundant counts, paragraph and jump links, not consent terms.
- Delivery: one content-addressed CSS asset, gzip for accepting clients, immutable caching, representation-specific ETags, HEAD/304 support and exact-path routing. HTML/fragments remain `no-store`, uncompressed, and protected by the existing nonce/authority checks. No build system or runtime dependency was added.

The [research brief](WORKSPACE_4_RESEARCH_2026-09-14.md) records the actual logged-in Mobbin ChatGPT/Claude screens and flows, Linear's primary references, and Apple/W3C guidance inspected before the corresponding layout changes.

## Evidence and checks

Environment: a desktop Mac, macOS 26.5.2; headed Chromium via Playwright CLI. `scripts/ui-polish-fixture.mjs` supplied in-memory tasks, throwaway repositories, synthetic credentials, scripted replies and deliberately damaged evidence. No paid model calls or real tasks were used.

- `npm run typecheck` and `npm run build` passed.
- `npx vitest run src/serve.test.ts src/chat-continuity.test.ts src/mobile-viewport.test.ts src/style-asset.test.ts --reporter=dot --no-file-parallelism`: **318 passed**, 18.94s. Log: `output/playwright/workspace4-focused-tests.log`.
- The final addition to the existing drawer test then passed separately, executing the shipped script to check focus entry/return and inert cleanup. Typecheck passed again. No tests were removed, skipped or relaxed. Filtered development runs select tests; those selection skips are not changes to the suite.
- First broader affected-file run found 11 assertions expecting inline CSS. All were changed to inspect the actual linked stylesheet, including negative assertions, token ramps, fonts, focus and reduced-motion rules. A prior new-test failure was a null-header assertion on an ordinary unauthenticated redirect; the expectation was corrected. These were test-adaptation failures, not successful first runs.
- Exact 320×740, 390×844 and 430×932 viewports: empty chat, Work, long approval, damaged result, Changes and project dialog. All 18 captured states had zero document-level horizontal overflow. Diffs scroll within their own region. Header/settings/project/review actions checked at 44px; bottom tabs 48px. Text/labels were visually inspected, not accepted from overflow checks alone.
- Fresh empty conversations were independently minted and captured at 1280×800 and 1440×900. These are not populated conversations resized to look empty.
- Desktop result → Changes → regular note → one revision worked; the unsent chat draft survived opening the result. The phone journey combined one line annotation and one regular note into one revision, still requiring approval. Both use the existing seal/lineage road. These unchanged-flow captures were retained after the final approval-only copy/CSS reduction; the affected approval views were recaptured at all three phone widths and 1440px.
- Keyboard: project-dialog focus loop and Escape, Work tools Escape, command palette return, and literal `A B / ? g` in the composer passed. Offline mode disabled sending, preserved the draft, displayed the real problem, and recovered without sending the draft automatically.
- A settled eight-line draft produced a 213.4px composer; at the bottom of the page the conversation details ended at y=538, composer began at y=570.6, and bottom navigation began at y=787. Messages and trailing controls remain reachable above it. The capture was retaken after the resize observer settled, not accepted from an earlier transient position.
- Reduced-motion emulation: project panel computed `animation: none`, `transition-duration: 0s`. Light and dark failure states inspected. Status text uses foreground color, not colored text: token contrast 17.18:1 light / 15.89:1 dark; muted text 5.23:1 / 5.86:1 against the respective base/card tokens. This is not a claim that every composited gradient pixel was contrast-audited.
- 200% CSS zoom and 720px reflow passed without document overflow. **CSS zoom is not native browser zoom.** Browser zoom controls and physical-phone zoom remain unverified.

### Local viewport evidence

All are viewport-only images of synthetic data, not stitched full-page phone images. Local files are intentionally in ignored `output/playwright/`, not new binary assets in the source package.

| Surface | Before / after or current capture |
| --- | --- |
| Empty phone chat | `workspace4-before-empty-390.png` → `workspace4-empty-390.png` |
| Phone result | `workspace4-before-result-390.png` → `workspace4-after-result-390.png` |
| Approval introduction | `workspace4-approval-long-320.png` → `workspace4-approval-final-320.png` |
| Project dialog | `workspace4-projects-320.png`, `workspace4-projects-390.png`, `workspace4-projects-430.png` |
| Desktop empty / result | `workspace4-empty-1280.png`, `workspace4-empty-1440.png`, `workspace4-result-1440.png` |
| Mobile failures / draft | `workspace4-failure-390.png`, `workspace4-failure-dark-390.png`, `workspace4-offline-390.png`, `workspace4-populated-long-draft-390.png` |
| Annotation / revision | `workspace4-annotation-390.png`, `workspace4-phone-revision.png`, `workspace4-desktop-revision.png` |
| Interaction recording | `workspace4-phone-review.webm` |

Raw measurements: `workspace4-layout-results.txt`, `workspace4-interaction-results.txt`, `workspace4-send-results.txt`. The ad-hoc CLI callbacks beside them refer to disposable fixture ports; start a new fixture and replace that origin before rerunning. Existing `scripts/workspace-result-proof.mjs` remains the reusable full result journey; no overlapping browser suite was added to CI.

## Measured delivery weight

Fresh, equivalent three-project fixture states before/after; authenticated response-body bytes, excluding unchanged font/image bytes and transport headers. No encoding on HTML. Actual gzip Content-Length for CSS, not an estimated compressed size. The matched A/B measurement preceded the final approval-only copy repair:

| Page | Baseline inline HTML | Warm HTML + cached CSS | Reduction |
| --- | ---: | ---: | ---: |
| Chat | 236,565 B | 55,389 B | 76.6% |
| Work | 223,694 B | 41,341 B | 81.5% |
| Projects | 210,535 B | 28,182 B | 86.6% |
| Result in chat | 259,402 B | 78,284 B | 69.8% |

Initial CSS was 34,931 transferred bytes (185,672 decoded). After removing the redundant approval styling, final CSS is **34,864 transferred bytes / 185,093 decoded**, at `/assets/workspace-11e9c5747da411be53d2ac2cbcf37747d6250e89170c01561a70a6af924c803d.css`. Browser Resource Timing confirmed **0 transferred bytes on the warm fetch**. A final HTML check after the 20-send timing exercise yielded 55,700 / 41,341 / 28,182 / 78,595 B: the two chat pages include 311 additional bytes of recent-turn audit detail. Even this larger final state is 69.7–86.6% smaller warm, and 56.3–70.1% smaller cold including the final CSS. No cold-transfer regression.

## Local interaction timing

20 samples each, p95: project open acknowledgement to the next rendered frames **10.6ms**; result-tab selection to the next frame **9.6ms**; composer submit to visible **Sent** receipt **8.4ms**. Sending includes the loopback HTTP receipt, not a real network/provider response. These are local presentation/receipt measurements on the declared Mac, not animation-completion times or a universal phone-speed guarantee. Scripted provider answers cannot establish production model latency.

## Remaining gates

1. **Source gate completed** in native run 1558, with user direction to finalize and push. The final GitHub commit includes documentation-only receipt/plan edits; its hosted CI is a separate check, not claimed by the earlier local runtime evidence.
2. Physical iPhone Safari: soft keyboard/predictive area, browser chrome, safe areas, rotation, foreground/Back and native zoom. Unit visual-viewport shrink and desktop emulation do not certify these. In particular the Android resize-viewport path is unit-informed, not physical-device verified.
3. Package 5's real subscription-backed chat → result → revision pilot and unfamiliar-user assessment. The first three improvements are [planned here](WORKSPACE_5_REAL_WORK_PILOT_2026-09-14.md), not started. The release-assessment run is not a completed implementation/revision pilot or a product-wide 9–10 score.
4. Signed-Mac installation/access persistence and physical Windows acceptance remain separately deferred. No signing workaround, app replacement, service restart or npm publication is included in this source finalization.
