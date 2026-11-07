# Fleet follow-through: what happens to a result after an agent finishes

Status: plan, 2026-11-07. Branch `fleet-loop`, on the pending 0.9.94 head. Schema v155 (new tables only).

## Problem

Results stop moving when an agent stops. The 0.9.94 release check failed and a person found the cause, fixed it and
retested by hand. Sealed criteria and enforced authority are strong; what's missing is the road after them.

## What already exists (verified against the code)

- **Findings** are saved in `build_review.findings_json`. One HIGH send-back per task family goes through the ordinary
  revision road (`mayResend`); a later HIGH goes to the person. MEDIUM and LOW only sit on the result. Nothing records
  an answer, and steering notes close on "read".
- **Steering mailbox** (`steer-mailbox.ts`) mails numbered, keyed files into the worktree. It speaks with the
  operator's voice, so model-written text must not ride it as a steering note.
- **Repair ledger** (`repair_chain`, `maybeTriggerRepair`, `openRepairDraft`) drafts a revision inside the source
  scope. Its stops (integrity, no progress, attempt cap) work. Nothing calls it automatically: `automatic` returns
  none, and `mode set` refuses `--repair-auto`.
- **Same-commit rerun** (`regateTask`), **follow-up checks** on a result's exact commit (`result-follow-ups.ts`, no
  agent), and **release-check classes** (`check-failure.ts`) all exist. A release check's scope covers only that
  commit, so its repair can never run under that scope.
- **Per-attempt handoff** reaches the next brief only while the branch hasn't moved. There is no per-task note.
- **Fallback chains are gone.** Removed in v115 (0.9.53) with their tables; `docs/fallback-fixtures.md` went too;
  `exhaustion.ts` now only recognises a dead sign-in. `usage-exhausted` is read from old rows, never produced.

## Design

Five new tables in v155 (`fleet-schema.ts`), no column added to an existing table, so no updater history rule is
needed. Every reader tolerates the older schema: a deploy reads with new code over the installed database before the
migration has run, as `buildReviewOf` does.

### 1. Send a finding to the owner (`findings.ts`)

- A `finding` belongs to a task family, so a revision or repair inherits it. Sources: `build-review`, `person`,
  `check-failure`. It holds the text, file and line, revision, evidence pointer, bounded excerpt, requested action.
- Delivery: a running build gets a `f<NNN>.json` file in its existing mailbox, with its attempt key. It is a separate
  name from steering notes, labelled data, and has its own reminder. Otherwise the next attempt's brief quotes it.
- Answer: the agent writes `answers/<id>.json` in the mailbox folder with the attempt key. `accepted` needs words on
  what changed, and only counts if that run moved the head past the finding's revision. `rejected` needs a reason and
  a file that exists at the run's head. An answer that fails either stays open. Moving a file to `handled/` means
  read, nothing more. An answer from a failed run doesn't count.
- Bound: two rounds. A resend, or a review raising the same finding again, is a round. At the limit the finding goes
  to a person, and only a signed-in person closes it. An answer closes nothing but the finding: it touches no proof,
  no check, no approval.

### 2. Failed checks: one owner, bounded repair (`check-repair.ts`)

- At disposition a failed check gets one `check_repair` row per task family, revision and failure, so the same failure
  on the same revision never starts a second repair.
- Under a mode a person signed with `--repair-auto --repair-max-attempts N` (0..3), the repair is drafted and approved
  by that mode, as the existing ledger allows. `mode set` stops refusing those two flags; the terms show the signed
  limit. Older signatures can't reach this: modes last at most seven days.
- Without that signature nothing is drafted and nothing spends. The row waits on a person, who starts a repair (a
  draft that takes the normal plan approval).
- It goes to a person, with the evidence, at the limit, on a failure the change can't have caused, or when the plan
  doesn't cover a repair: a prepared candidate or release check, a published result.
- A held, stopped or question-waiting task stays quiet, with no notification, until it isn't parked.

### 3. Handover note (`handover-note.ts`)

Derived on every read from existing records; nothing is stored, so it can't go stale. Holds current revision, accepted
decisions, rejected approaches, open findings, verification results with links, next action. A fresh run's brief
quotes it inside a data block, bounded. `task handover <id>` and a page at `/t/<id>/handover` show it.

### 4. Before-and-after evidence (`evidence-pair.ts`)

- `evidence_pair` saves a failed run's receipt digest, revision and check command digest. A repair saves one by itself.
- The after side is read, not stored: the newest result in the family that ran the same command, from its own check or
  a follow-up check. The rerun is `requestFollowUpChecks`, the existing no-agent road, on the latest result.
- The reading is `failing`, `fixed`, `still-failing`, `check-changed` or `out-of-date`; a newer commit than the after
  side is out of date. Captures are the two runs' saved screenshots, reached the way `get_result_images` reaches them.
- Failing test first is a per-task option. The brief asks for it, the agent's report is saved and shown as its own
  report, never as a check Toolroll ran.

### 5. Agent fallback (`provider-capture.ts`)

Not re-enabled; there's nothing to re-enable. No recogniser is added and no routing reads captures. When an attempt
ends in a provider failure, the bounded, secret-scrubbed terminal text is saved automatically, with a `hint` flag when
it mentions limits. A person can list, read, mark and export them. The handover note reaches the next agent whichever
provider it is. What's still needed is reported at the end of the arc.

## Safety

- Finding text, excerpts, handover notes and agent answers are model output or repo content. They reach an agent only
  through `fence()` inside blocks that say they are data, and the attempt key is never in them.
- Secrets are scrubbed on save. Answers are bounded, one line, bound to the run they were delivered to.
- Nothing here adds an approval path. A model can't close a finding that went to a person, sign a mode or approve a
  repair. A person-started repair uses the normal plan approval, spend rails and scope; the mode road uses the seal
  that already exists, and only a person signs a mode.

## Order

Plan, schema, findings, check repair, handover note, evidence, capture. CLI and task page land with each.
