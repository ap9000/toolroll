# Everyday use: small, reviewable repairs

Based on the isolated Stranger 11 evaluation of 0.9.115: first run 9/10,
everyday use 8/10. These are synthetic journey findings, not customer research.

## 1. Connection failure and recovery

Explain failures from Toolroll's recorded model calls, never from agent claims.
Keep an uncertain outcome uncertain; suggest inspecting changes before an explicit
Reply. Do not retry automatically, change models, weaken consent, or alter spend.
Retain diagnostic records. Cover unreachable service, interrupted connection,
rate limit, ordinary agent error, and a failed call followed by recovery.

Done when focused trust-boundary tests pass and the error can be understood in
the workbench without reading raw JSON. Independent review is required if the
change affects authorization or credential handling.

## 2. Phone navigation and long labels

Fix the stale Settings title on Agents/Live, expose the existing Live/Agents
navigation on phones, and prevent short status words from splitting vertically.
Use existing kit components. Inspect desktop and 390px phone views, long content,
empty and failure states, keyboard access, and tap targets. Physical phone and IME
remain unverified unless tested on a device.

## 3. Failed plan recovery

Carry the saved validation reason into the failed state and Plan again review.
Keep the same task identity, stale-approval rejection and explicit approval before
building. Inspect one malformed-plan → Plan again → plan-ready journey.

## 4. Try alongside Herdr or Rex

Verify one existing-user walkthrough per app: open a repository, hand off one
small task, inspect the actual diff/check status, then accept or request a revision.
Start with the existing Herdr guide. Document only tested commands and supported
behavior; distinguish task handoff from interactive terminal attachment. Make a
short demonstration with honest skipped-check and failure states. Seek feedback
from a small pilot before changing positioning or claiming conversion results.

## 5. Attach mode continues separately

Follow docs/plans/attach-mode.md: relay, real interactive process, terminal service,
workbench control, browser/phone, panes, then Ship and final enablement evidence.
Each security slice needs a separate Codex reviewer. Existing slices 0 and 1 are
unmerged; this plan does not authorize merging, deployment, or interactive launch.

## Delivery

Use a separate branch/PR for each piece, based on verified main where possible.
Record the exact candidate and focused checks; do not repeat the whole suite.
Keep screenshots and journey output under ignored evidence/. A reviewable repair
is not a released repair. Re-evaluate everyday use after the first three pieces;
do not award a higher score from source review alone.
