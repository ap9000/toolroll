# Task status: one answer, then the details

*Design brief, 2026-10-01. Problem reported by the owner from a phone: a finished, complete task (checks passed, merged by hand) "looks like the whole task failed" because a red "Publish failed" chip and a red line sat beside "Complete".*

## What's wrong today

1. **No single answer.** A task shows a status card (one tone for the whole card), verdict chips (Checks passed · Publish failed · Partial output, all at the same weight), requirement labels (Not assessed · Human review · Evidence checks passed) and free-text problems. Nothing ranks them, so a side problem looks as serious as the outcome.
2. **Red means two things.** The same danger red marks "the work failed" (checks failed, build broke) and "a later step had trouble" (the pull request couldn't open, some saved output was shortened). A person scanning from a phone reads red as failure.
3. **Too many words for the same state.** Needed: "Needs you", "Needs your decision", "Needs your approval", "Waiting on your answer", "Needs a look". Finished: "Ready", "Ready to inspect", "Ready for review", "Changes saved". And "Ready to run" means *queued*, the opposite of a Ready result.
4. **Internal words.** "no live publication grant — nothing may be pushed", "Not assessed", "criterion c1 requires manual-review evidence", "Publication failed after 5 attempts".

## How well-made tools do it

- **GitHub pull requests:** one state pill at the top (Open, Merged, Closed, Draft). Checks live in the merge box as one summary line ("All checks have passed"), expandable to a list. A failing check never repaints the PR's state.
- **Vercel deployments:** one status with a dot (Building, Ready, Error, Canceled). Domains, logs and checks are separate rows underneath, neutral until something needs you.
- **Linear:** exactly one status per issue from a short, ordered set, each with its own icon; everything else is in the activity.
- **Common rules (Apple HIG, Material, Nielsen's "visibility of system status"):** colour is never the only signal (icon and words too); red is for errors that block the user's goal; an error message says what happened in plain words and what to do next.

## The model

**1. One headline status per task**, from a fixed, ordered set, the same words everywhere (Tasks list, task page, build page, Crew, Chat result card, Telegram/Slack card, `toolroll status`):

| Headline | Means | Tone |
|---|---|---|
| Queued | Waiting for a worker (was "Ready to run") | neutral |
| Planning | The lead is writing the plan | live |
| Needs you | A decision, approval, answer or sign-in from a person; the sentence says which | attention (the ink/magenta "person needed" tone) |
| Building | An agent is working, or checks are running | live |
| Ready for review | Built, and the project's checks passed on the commit | success-quiet |
| Complete | A person marked it complete | success |
| Failed | The build or its checks failed and it isn't being retried | danger |
| Stopped | Cancelled or put on hold by a person | neutral |

One sentence under the headline says why and what's next, in plain words (e.g. "Checks passed on a1b2c3d. Review the change, then mark it complete.").

Crew is not exempt: it reads the Tasks list's own words for each task, the headline a list row wears outside a group. The list's group headings (Decide, Review, Unblock) and ask chips only arrange the list, so Crew never shows them in place of the headline.

**2. Details as a quiet list underneath**, one row each, neutral text with a small icon. Colour only on the icon, and only when it matters:

- Project checks: passed / failed / running / couldn't run. A quick check says so ("Quick checks passed on a1b2c3d"); Off reads "Checked at release" with **Run checks**, then "Passed at release on <commit>" once a passing full release check's commit contains it (read from the existing receipts and Git ancestry, never stored); a follow-up check reads "Full checks running"
- Pull request: none · opening · #12 open · PR CI running · #12 merged · couldn't open
- Requirements: "3 of 3 met" · "You check 1" (not "Not assessed")
- Saved evidence: complete · some output shortened

**3. Severity rules.**
- Red only when the headline is Failed.
- A detail problem that doesn't undo the outcome (pull request couldn't open, output shortened) is an amber note *on that row*, with one action ("Open the pull request", "Retry", "Open it on GitHub"). It never turns the headline, the card border or the whole card red.
- A detail problem that blocks the next step makes the headline "Needs you", with that problem as the sentence.

**Ready, or Needs you with the ask.** A finished result reads Ready for review unless a person must act first: a requirement only they can check, a missing screenshot, an unmet requirement, a missing required check or an unresolved HIGH review finding reads Needs you, and the sentence is that ask. A failed check reads Failed. The same rule (`completionBlockersOf`) refuses `task complete`, the console and chat completion and `scripts/deploy-candidate.mjs`: a failed or missing required check, an unresolved requirement or an unresolved HIGH finding. Checks deliberately Off are not missing; a requirement a release check covers counts as met. The shown verdict is derived the same way and never rewrites the stored one.

**4. One primary action**, chosen from the headline and details (Approve, Review, Mark complete, Merge, Retry the pull request…). Secondary actions stay quiet.

**5. Plain words.** No grant, criterion, evidence, operator, verify, publication, assessment in anything a person reads by default; the exact technical reason stays one tap away (the status card's "More" fold and the run log).

## Check levels

Each project checks at one level, chosen in Settings → Projects → Checks or with `toolroll verify level quick|full|off` (an approver's act, in the ledger): **Quick** runs the approved quick command (typecheck and the tests near the change; new projects start here), **Full** runs the full command (projects from before levels keep it), **Off** runs nothing. A task can choose its own at filing (`task add --checks`, or in chat "skip the tests" / "run the full checks"). With Quick or Off, the full check runs when a pull request opens and Merge waits for it unless a person merges anyway. Every result offers **Run checks** (quick or full, on that exact commit; a pass upgrades the status, a failure stays visible) and **Add tests** (files a small task, unapproved, to write tests for that change).

**Batch checks** (Settings → Projects → Checks, or `toolroll project checks --batch on|off`; off by default, an approver's act in the ledger): with Full checks, results of the same project and approved command that finish within 10 minutes share one check. They are merged onto the recorded base in a temporary detached checkout; a pass gives each its own sealed receipt naming the batch commit ("Checked together with … on <batch commit>"); a failure splits the batch until the result that breaks it is found; a merge conflict checks each on its own. No real branch or ref changes, and Merge waits for the batch check like it waits for a Quick result's full check.

## Implementation notes

- One shared status function (task + assignment + receipt + publication + proof → `{ headline, sentence, tone, details[], primaryAction }`) used by the React views, the server-rendered pages, the chat cards and `toolroll status`, so the words can't drift apart again. Unit tests pin the headline for every combination that exists today, including: checks passed + PR failed + completed (the reported case), checks failed, checks passed + PR open + CI running, merged, waiting for approval, building, stopped, sign-in pause.
- Keep the Signal/ink design (DESIGN.md): neutral frame, the ink accent only for "Needs you", colour only for status, Geist. Light and dark.
- Phones: the headline and its sentence fit the first screen; details are one line each; no chip rows that wrap into three lines.

## Done when

Before/after screenshots at 1440 and 390, light and dark, of: the reported case (complete, checks passed, PR couldn't open), Ready for review, Building, Needs you (approval), Failed (checks failed), Complete with a merged PR, and the Tasks list showing a mix. The reported case must read as a success with one amber detail, at a glance, on a phone.
