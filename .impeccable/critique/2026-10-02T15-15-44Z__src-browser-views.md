---
target: Toolroll task experience (tasks list, task page, result page, Needs you)
total_score: 21
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 3
timestamp: 2026-10-02T15-15-44Z
slug: src-browser-views
---
Method: dual-agent (A: design review · B: detector + browser evidence)

## Design Health Score
| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Status card is clear; "Building" hides two stopped attempts; times disagree between Details and the result page |
| 2 | Match System / Real World | 2 | scope, assignment, evidence pack, incident, criterion repair, fallback chain |
| 3 | User Control and Freedom | 3 | Cancel behind a fold; "Approve plan" disclosure gives no state feedback |
| 4 | Consistency and Standards | 2 | Header "Tasks" vs "Review"; two tab styles; three disclosure glyphs; "Results 1 (1)" |
| 5 | Error Prevention | 2 | Accept is primary while 0 of 1 requirements met and checks didn't run |
| 6 | Recognition Rather Than Recall | 2 | The plan is folded away; blocking task named but not linked; criteria as c1/c2 |
| 7 | Flexibility and Efficiency | 2 | ⌘K exists; no bulk or keyboard approve; password on every approval |
| 8 | Aesthetic and Minimalist Design | 2 | Sticky demo notice, usage tiles above the queue, ~20-fact Details panel |
| 9 | Error Recovery | 1 | "the build records have the detail" on every failure; duplicated sentence; empty bubble |
| 10 | Help and Documentation | 2 | "Why these agents" helps; nothing explains scope or evidence plainly |
| **Total** | | **21/40** | **Acceptable** |

## Design Specificity Verdict
Structure is authored (one sentence + one verb per status, honest check ledger, password-sealed approval); the visual layer is Linear/Vercel-generic, and with the ink accent the one signal that matters — "a person is needed" — has no visual form: the Needs you chip (#e8e8e8 / #171717 dot) reads like Stopped (#f0f0f0 / #525252). Detector: views 10 advisory findings (tile number 22px real drift; phone h1 22px false positive), serve.ts 144 (74 radius false positives from calc(); real: 10.56px approval labels, 9–10.4px journey/eyebrow text, off-ramp approval/result sizes, undocumented contract colours). Browser: no overflow, no console errors, contrast passes light and dark; Tasks list has no visible headline (sr-only h1 only); "Edit details" 67×20 on phone; desk line lengths 90–131 characters; phone text 14px from the edge (spec 16px); nested cards. Injection blocked by the nonce CSP; detector ran in a CSP-bypassed test context.

## Priority Issues
- [P0] Approval is a disguised disclosure over a wall of jargon: "Approve plan" is a <summary>; nested card; lineage bullets; 10.56px uppercase mono labels; the real act is ~3 phone screens down behind a password; no "what happens next". Fix: show the plan by default as 4 plain rows (goal, touches, won't touch, how it's checked) + agent + spend cap; one sticky "Approve & start"; lineage into a fold; no nesting. (clarify, distill, layout)
- [P1] Needs you doesn't triage and doesn't stand out: 9 of 11 tasks; decisions, reviews and setup trouble look alike; usage tiles and a sticky notice push the queue to 45% down a phone. Fix: group by ask (Decide / Review / Unblock) with counts; a heavier ink treatment for waiting rows; tiles below or folded; notice not sticky; visible headline. (layout, colorize, distill)
- [P1] Result page invites Accept before inspection: Accept leads above "0 of 1 met" and "Checks: Didn't run"; diff a tab away and truncated; stale "Open the result" sentence. Fix: show the change under "You check this one" with Looks right / Not right; honest Accept label when unmet. (layout, harden, clarify)
- [P1] Failure messages empty or broken: generic "build records have the detail"; duplicated "Fix or remove it…"; empty "Asked for a repair" bubble; failed card lacks the spec's vermilion border. Fix: one-line cause, dedupe, hide empty entries, "Attempt 3 · 2 earlier stopped". (harden, clarify)
- [P2] Consistency and type drift: uppercase mono vs lowercase labels, 3 disclosure glyphs, 2 tab styles, header labels, time formats, sub-11px text, 90–131 character lines, 14px phone edge. (polish, typeset)

## Persona Red Flags
- Alex (power user): no bulk/keyboard approve; password every time; list not sorted by urgency; 20-fact panel.
- Casey (one-handed phone): first task 45% down; sticky notice covers 66px; "Approve & start" 3 screens down plus typing a password; diff scrolls sideways; "Edit details" 20px tall.
- Jordan (first-time adopter): View assignment, Saved evidence, Evidence pack, signs <hash>, Criterion repair, Steering, "Start the builder" (what is a builder?).

## Minor Observations
Machine-made title "nightly-deps · 2026-09-30 03:30 UTC"; Parent link repeats the task title; password placeholder in mono; "open to review" beside "approved · revision 2"; phone Approve plan not full width; "no attempt yet" twice.

## Questions to Consider
- If 9 of 11 tasks "need you", is Needs you a status or a queue — should home be one next-decision card at a time?
- Could approval fit on one phone screen, with lineage moved to the audit?
- Should ticking the human requirement be the acceptance itself?
