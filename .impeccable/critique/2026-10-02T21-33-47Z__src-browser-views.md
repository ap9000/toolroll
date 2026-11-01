---
target: Toolroll task experience after 0.9.13
total_score: 22
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
timestamp: 2026-10-02T21-33-47Z
slug: src-browser-views
---
Method: dual-agent (A: design review · B: detector + browser evidence) — re-run after 0.9.13 (one result page)

| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of status | 2 | Looks right doesn't update the requirement count; building card hides a blocked step |
| 2 | Match real world | 2 | revision / repair / correction / fix-1; "execution or scope issue"; c1/c2 |
| 3 | User control | 3 | Good exits; Edit plan lands on a read-only view |
| 4 | Consistency | 2 | Unblock in list vs Failed in Crew; 4 disclosure markers, 3 tab styles, 3 time formats |
| 5 | Error prevention | 3 | Password step-up; reason required to accept a mismatch |
| 6 | Recognition | 2 | The mismatch is never identified; earlier active version folded away |
| 7 | Flexibility | 2 | No keyboard approve/accept, no next-result, no bulk approve |
| 8 | Minimalist | 3 | Calm; chips repeat their heading; three things named Details |
| 9 | Error recovery | 1 | Failure reason and retry link both point at themselves |
| 10 | Help | 2 | Nothing explains Checks vs CI vs Agent checks |
| **Total** | | **22/40** | **Acceptable** |

Resolved since the last run: the P0 can't-accept loop; two result pages; phone gutters now 16px everywhere; result-page detector findings 12/7 → 8/1; no contrast failures, overflow or console errors.

Priority: [P1] the mismatch result doesn't say what mismatches (green ticks outweigh the blocker); [P1] failure recovery goes in circles ("the build records have the detail", retry links to itself, two ink buttons); [P1] Edit plan and binding terms live elsewhere (20+ controls three folds deep; permissions, attempt cap, earlier version folded below Approve); [P2] accept gives no feedback and ends in two steps; [P2] terminology and consistency drift.
