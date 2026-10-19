---
target: Toolroll task experience after 0.9.14
total_score: 22
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
timestamp: 2026-10-02T23-27-19Z
slug: src-browser-views
---
Method: dual-agent (A: design review · B: detector + browser evidence) — re-run after 0.9.14 (say what went wrong)

| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of status | 2 | Requirements "Unverified" on the card but "Met" in the Checks tab; Checks "Didn't run" beside PR "CI passed" |
| 2 | Match real world | 2 | "signed requirements", "judgement(s)", "Retry, keeping the branch and workspace" |
| 3 | User control | 2 | "Edit plan" is read-only; Request changes jumps ~900px |
| 4 | Consistency | 2 | Inspect vs Open the result; Unblock vs Failed/Stopped; 3 disclosure glyphs; 3 time formats |
| 5 | Error prevention | 3 | Reason required to override; sealed approval |
| 6 | Recognition | 3 | Failed task doesn't show its criteria |
| 7 | Flexibility | 2 | Ctrl K dead on the plan page; password every approval |
| 8 | Minimalist | 3 | Chips repeat their heading; nested cards |
| 9 | Error recovery | 1 | Failure names no criterion; empty run record, Not found, Chat loop |
| 10 | Help | 2 | Accept vs Complete, the password, Checks level unexplained |
| **Total** | | **22/40** | **Acceptable** |

Landed: mismatch headline, unverified requirements, reason before accepting, one-line plain failure reason, Retry as the act, red failed card; detector clean (no contrast/overflow/console issues; failed page has no long lines).
Still open: [P1] failure has no diagnosis (no criterion named; dead-end run record /r/7, /review Not found for failed runs, Run checks loops via Chat); [P1] contradictory truth (Unverified vs Met; CI vs project checks; 7h time offset; the mismatch itself not itemized); [P1] accept-flow order (decision above evidence, Accept enabled before the human check, stale count, phone dock covers facts); [P2] consent facts and Edit plan; [P2] list chips repeat headings, boilerplate Review detail lines.
