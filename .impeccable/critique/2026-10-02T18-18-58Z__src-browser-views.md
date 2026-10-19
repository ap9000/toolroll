---
target: Toolroll task experience after 0.9.12
total_score: 19
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 3
timestamp: 2026-10-02T18-18-58Z
slug: src-browser-views
---
Method: dual-agent (A: design review · B: detector + browser evidence) — re-run after 0.9.12 (approval-plain, needs-you-triage, result-review)

## Design Health Score
| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | "Checks: Didn't run" beside "PR #47 open, CI passed"; sidebar needs-you count changes between pages |
| 2 | Match System / Real World | 2 | Rows plain; deeper copy not ("review its incident", "execution or scope issue", "Unmet: c1") |
| 3 | User Control and Freedom | 2 | Not now / Edit plan / Request changes exist; review dead-ends in a loop |
| 4 | Consistency and Standards | 1 | Same task reads Unblock / Failed / Needs you by surface; two result pages |
| 5 | Error Prevention | 3 | Password gate, exact paths, honest "Accept without checks" |
| 6 | Recognition Rather Than Recall | 2 | Task page headline "Needs you" drops the ask; "Fixes what build #9 missed" |
| 7 | Flexibility and Efficiency | 2 | Accept is 4 acts over 2 pages; password every approval |
| 8 | Aesthetic and Minimalist Design | 2 | List clean; result status card is a 5-sentence hedge; three "Details" on approval |
| 9 | Error Recovery | 1 | Failures never say what failed |
| 10 | Help and Documentation | 2 | Good one-liners; terms unexplained |
| **Total** | | **19/40** | **Poor–Acceptable** |

## Verdict
The three targeted surfaces improved and are now the product's strengths: the list grouped by ask (Decide / Review / Unblock) with one verb per row; the plan as a plain contract with a docked Approve & start; "You check this one" with Looks right / Not right and an honest "Accept without checks". Deeper end-to-end walks found problems the first pass didn't reach. Detector: no overflow, no console errors, no contrast failures light or dark; real items are 10.56px labels in the approval Details fold, 90–110 cpl lines, 14px phone gutters on task/result pages, 20px meta links on the result page, the tab strip clipping "Complete 0".

## Priority Issues
- [P0] Review loop with no accept: a result whose report doesn't match its saved changes shows "Needs you" with ink "Open the task" (navigation) and Request changes; the task page sends back; no Accept and no reason.
- [P1] Two diverging result pages (/r/<id> and /review?result=): different titles, actions, callouts and project scoping.
- [P1] Status and vocabulary fragmentation: Unblock vs Failed vs Stopped by surface; chips repeat group headings; revision/repair/correction.
- [P1] Opaque failure and caveat copy; consent terms (permissions, attempt cap, earlier version still active) hidden in Details.
- [P2] Action hierarchy on waiting screens: no single ink act on the accept dock; buttons touching on desk.
