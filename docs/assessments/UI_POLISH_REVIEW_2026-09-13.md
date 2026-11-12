# Independent UI polish review

## Execution record

- Standing Orders task: `ux-polish-2026-09-13` (reference 66).
- Real worker build: `1540`, started 2026-09-13 18:12:53 UTC.
- Builder: Claude Opus, using the saved project configuration and subscription harness.
- Scope: `58cb9601404d321344b053e7664c91d3`; six explicit acceptance criteria.
- Branch: `standing-orders/ux-polish-2026-09-13`.
- Base: `b1290a74795761d070f14993a789980ff849c71e`, a snapshot of the existing local improvements plus the design brief. The user's main checkout and normal index were not changed by creating this snapshot.
- No public push, merge, publication, or live service upgrade authorized by this UI task.

## Baseline evidence

The installed UI's inspected surfaces receive a subjective **6/10**, mainly because repeated context and technical copy obscure the main action. The current local source has newer mobile fixes; its independent viewport baseline is:

| Width | Document width | Composer top | Composer height |
| --- | --- | --- | --- |
| 320 | 320 | 640.5 | 60 |
| 390 | 390 | 609.3 | 44 |
| 430 | 430 | 589.8 | 44 |
| 1440 | 1440 | 986.5 | 56 |

Phone height was 844 px, desktop height 900 px. Fresh reload at each size. No document overflow in this ready-chat fixture, but the desktop composer is below the fold. This does not measure real phone browser chrome or a physical soft keyboard.

Current-source screenshots are in `output/playwright/ux-current-chat-start-mobile.png`, `ux-current-chat-ready-mobile.png`, and `ux-current-chat-ready-desktop.png`. Installed-UI screenshots use the `ux-before-` prefix.

Current-source start-chat fixture payload (raw / calculated gzip): HTML **173,747 / 33,846 bytes**, inline CSS **156,089 bytes**, inline JS **4,093 bytes**. The server serves this markup uncompressed; the gzip figure is a local calculation, NOT measured wire transfer. Compare the same state/fixture when scoring final weight; random session IDs can create small differences. Neither figure measures frame rate.

Baseline check: `npm test -- src/chat-continuity.test.ts` — 9 passed.

Additional baseline: `npm test -- src/serve.test.ts` — 259 passed. The builder's browser probe completed 54 checks against an isolated seeded fixture, with 48 passing and 6 failing. It captured 18 viewport screenshots; a copy is in `output/playwright/ux-baseline-builder/`.

The six failures were: start-chat CTA below the first phone viewport (top 946 px), 15 px composer text, no explicit Review scope jump, a reduced-motion thinking pulse still running, a grid-column transition, and a layout-driving `rise` keyframe. These checks measure specific requirements; 48/54 is not an overall design score.

The pending-reply fixture also preserved a follow-up draft and textarea focus across the reply; retain this behavior in the redesign.

## Result score

**8/10 for the inspected revised UI**, up from a subjective 6/10 for the installed baseline. This is a design assessment of these surfaces, not a product-wide reliability score or a measured comparison with competitors. The code and browser checks below support the assessment; worker completion and deployment are separate facts.

| Dimension | Weight | Score | Assessment |
| --- | --- | --- | --- |
| Hierarchy / clarity | 25% | 8 | The primary chat action fits, project context is optional, and build facts are subordinate. Some repeated explanation remains. |
| Workflow cohesion | 25% | 8 | Both revision modes, explicit approvals, and navigation are retained and exercised. The real annotation-to-revision workflow also ran successfully. |
| Mobile fit | 20% | 8.5 | Viewport checks cover 320/390/430 px without document overflow or primary-control overlap. Physical phone keyboard behavior remains untested. |
| Visual consistency | 15% | 7.5 | Calmer disclosure rows, consistent radii, restrained motion. Approval/result screens still use too many nested cards and duplicate status labels. |
| Motion / accessibility / performance | 15% | 7.5 | Keyboard, reduced motion, and no animated layout/blur checked. No new runtime dependency. Frame timing and low-powered hardware are unmeasured; inline CSS remains substantial and uncompressed. |

Weighted result: **7.95**, rounded to **8/10**. To justify a 9: remove repeated reassurance/status copy and reduce approval-card nesting, then verify Safari/physical-phone keyboard and motion behavior. Do not erase exact scope terms or authorization controls to get a cleaner screenshot.

### First-pass independent finding

The first browser report reached 54/54, later 55/55, but did not check a genuinely empty desktop conversation. A separate new fixture at 1440×900 reproduced a composer top of **882.7 px** and bottom of **938.7 px** (clipped below the window). Evidence: `output/playwright/ux-independent-empty-desktop.png`. The builder's desktop screenshot reused the earlier phone conversation; it cannot stand in for this state. Recorded as Standing Orders steering notes 70 and 71. The approval orientation was also initially too bulky and amber; the builder subsequently changed it to neutral. These findings must not be hidden behind a passing test count or the implementer's provisional 7.9/10 self-score.

### Real review-to-revision exercise

- Build 1540 finished as `built`, sealed at `cb9e66329e4c2215e91b87e0c7fe83a599e85055`.
- Independently reran `npm run typecheck` and the five focused UI/continuity/recipe test files against that result: **297 passed**.
- Submitted two annotations in the live run page and used **Create revision from annotations**. This created task `revise-ux-polish-2026-09-13-from-2-annotations-on-build-` (reference 67), not a manually fabricated retry.
- The second annotation records another genuine UX failure found while using the product: review textareas advertise `maxlength=2000`, but the server accepts only 500 characters and sends a longer submission to a generic refusal page. The requested fix aligns the UI with the existing limit; it does not widen the backend limit.
- Narrowed the revision to desktop empty-state fit and truthful annotation limits, preserving the original pass. Explicit desktop acceptance: the entire textarea and Send control fit at both **1440×900 and 1280×800**, with an independent fresh empty conversation per viewport.
- Approved exact revision scope `2b494375764a845feca8086f38123e11`. Real build **1541** started through the normal worker with Claude Opus, based on `cb9e66329e4c2215e91b87e0c7fe83a599e85055`.
- At dispatch, revision verification and the final score were pending. No main merge or live installation was performed.

### Independent revision verification

- `npm run typecheck`: pass.
- `npm test -- src/serve.test.ts src/chat-continuity.test.ts src/mate-continuity.test.ts src/recipe-surface.test.ts src/recipes.test.ts`: **299 passed**.
- Separately inspected the builder's final full-suite log: **161 files passed; 2,787 tests passed; 23 skipped**, duration 68 seconds. This was the worker's run, not a second independent full-suite invocation.
- `node scripts/ui-polish-proof.mjs --out ~/Documents/standing-orders/output/playwright/ux-final-independent --strict`: **75/75 checks, 21 screenshots**. This is an independent invocation, not a copy of the builder's report. The scripted chat/project data are explicitly synthetic; the browser controls and rendered application are real.
- Fresh desktop conversations have zero messages and `scrollY=0`. At 1440×900, textarea bottom is **520.47 px**; at 1280×800, **516.47 px**. Both the whole textarea and Send fit; the overview opens/closes by keyboard. Independently captured settled screenshots are `output/playwright/ux-final-empty-desktop-{1440,1280}.png`.
- Both annotation forms display the 500-character limit and an input counter. The browser caps a 600-character input to 500; annotation submission and revision creation still work.
- No new dependency. Relative to the original fixture baseline: CSS **+6,833 bytes** (~4.4%), chat JS **+69 bytes**, run-page JS **+349 bytes**. Raw page HTML is roughly **181–199 KB**, an increase of **6.8–7.7 KB**. These are uncompressed served bytes, not gzip estimates or frame-rate measurements.
- Screenshots were visually inspected for chat (desktop/phone), mobile project menu, approval, result, review cockpit, and annotated diff. Phone captures are exact viewports, not stitched pages with a floating navbar.
- Revised code is sealed at **`d12d776897e3d4a0bb329737e8f09f624285f467`** on `standing-orders/revise-ux-polish-2026-09-13-from-2-annotations-on-build-`. The final source's only changes after the independent checks were a comment and indentation; the rendered code is unchanged. No deployment, push, or main merge is implied by these checks.

### Separate machine-verification status

The first build's repository-approved verifier was **not green**: its serial full-suite run failed `src/store-contention.test.ts:100`, where a persistent-lock wait took 12,165 ms against a 10,000 ms assertion. That file is unchanged by the UI work. The parallel full-suite pass must not be substituted for this failure. Standing Orders correctly retains `proof-refuted` on that attempt; no acceptance override was issued.

An independent targeted rerun on the sealed revision (`npm test -- src/store-contention.test.ts --no-file-parallelism`) passed **4/4 tests** in 7.66 seconds. This is consistent with a timing-sensitive failure, not proof of its exact cause.

**Final status: implemented, but NOT fully verified for integration.** Build 1541 finished as `built` at `d12d776897e3d4a0bb329737e8f09f624285f467`; its exact approved serial verifier again exited 1 on the same test, this time **11,894 ms** against 10,000 ms. Final verifier totals: **160 files passed, 1 failed; 2,786 tests passed, 1 failed, 23 skipped**, duration 295.81 seconds. Evidence artifact **401**, `1541/check-log.txt`, is retained by Standing Orders. The task correctly reports `proof-refuted` / "Proof correction needed".

The UI score remains **8/10**, but is not a claim of a passed release gate. No test limit, verification command, proof status, or acceptance requirement was weakened. Diagnosing and fixing the environment/serial-test discrepancy is separate from the approved UI-only change; no unrelated backend fix was smuggled into the result.

Final independent score and the verification qualification were also saved as operator notes on the real Standing Orders run. The user's main checkout remains at `45ad5a70e1c4b4435d663066e3c9d7c329513c00` with its existing edits preserved. No live service upgrade, public push, or main merge occurred.
