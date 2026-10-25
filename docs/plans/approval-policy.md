# Who can approve work — plan

Status: plan, revision 3, 2026-10-24. Branch `approval-policy`. Alex approved building phase 1 after round 2.
Round 1 (Codex): NO-GO, 8 findings. Round 2: 1, 2, 6–8 closed; 3–5 partial plus new findings. All are answered
below; the map is at the end.

## The problem (found by Codex)

A lead token can approve a task's scope today, and the result is recorded as the owner's own approval —
including on a release.

- The CLI lets a lead token run `task` commands (`LEAD_COMMANDS`, `src/operate.ts`).
- `credentialsFrom()` hands out the owner's name with the lead token (`operate.ts`).
- `proveAccountNow()` knows it was the lead: method `"lead-token"` (`src/scope.ts`).
- `approve()` ignores the method and seals with no basis, so the row says `approval_basis = 'password'`,
  `approved_by = <owner>` (`scope.ts approve`, `store.ts sealScopeApproval`).
- `ownerApproval()` (`src/release.ts`) reads only basis and name, so it takes that seal as the owner's yes.
- The release test rejects only a made-up name, `lead:alex` (`src/release.slow.test.ts`).

The audit found the hole is wider than approval:

- **Merging.** `task merge` (a `task` command, so open to the lead token) checks only that the credential is valid,
  then `mergeAsPerson()` checks the same (`task-outcome-cli.ts`, `pull-request-flow.ts`). The lead can merge,
  including `--anyway`, which skips waiting for the full check.
- **Deploying.** `deploymentCandidate()` (`scripts/deploy-candidate.mjs`, used by every phase of
  `deploy-browser.mjs`) checks digests, the passing check and completion, never who approved.
- **Votes.** On protected work the lead's approval is stored as the owner's vote (`scope_approval_vote` has no proof),
  and both vote counters (`approvalGate`, `protectedResultProblem`) count it as a person.
- **Provenance.** A refile through `task scope` writes `proposed_via = NULL` (`proposeLocked` default →
  `saveScope`), so the lead can wipe a scout, coordinator or chat-proposal mark before approving.
- **Default-allow readers.** Dispatch and the work index accept any basis that isn't `mode`/`grant`;
  `approvalOf()` ignores basis; `modeApprovalLive()` returns true unless it recognises a dead mode or grant. A new or
  corrupt basis would stand.
- **Schedules.** A standing order's firing seals with no basis (`flow-schedule.ts`, kind `automation`), so it is also
  recorded as `password`.

What is truthful today: the proof row (`action_ledger`, `approval proved`, outcome `lead-token`) and `task_act`
(`act = 'approved'`, `lead = 1`, plus its "lead for <owner>" ledger line). The migration uses both.

## Alex's decision

The lead may approve, under a per-project setting with three choices:

1. **Only people** — the lead's approval is refused.
2. **People and the lead** — the lead may approve, recorded as the lead's (basis `lead`), never as a person's.
3. **Approve automatically** — the existing signed, expiring operating modes (basis `mode`). Reused, not rebuilt.

## How the setting fits the modes

The setting stores two values, `people` or `lead`. Option 3 is a mode.

- Choosing **Approve automatically** opens the existing mode ceremony with the auto-approve preset. The mode is the
  record, with its own expiry and one-click revoke. While it is live the setting reads "Approve automatically until
  Fri 10:00 · Afterwards: Only people" (the stored value).
- A mode does not change what the lead may approve by hand. Filings a mode covers seal as `mode`, as today, including
  the lead's own CLI filings (decision 3). No new mode term, so no existing signature changes meaning.

## Words used below

- **Proof**: how the approver was proved, recorded beside every yes. `personProof(proof: string)` is true only for
  `password-now`, `sso-now`, `fresh-password`, `fresh-sso`, `session`, `cli-login`, `chat`, `passkey`. Everything else —
  `lead-token`, `remote-token`, a missing row, any unknown string — is false. It takes a runtime string, so a
  corrupt or future value fails closed; a type-level exhaustive switch over `AuthMethod` makes a new method a compile
  error until classified. `passkey` is listed now for the phone plan; a passkey approval seals with basis `password`
  (a person's ceremony), and its proof row uses the structured record below.
- **Proof row reader.** `approvalProofOf` reads both forms: the legacy text detail (`<at> · generation <n> · digest
  <d>`) and a versioned structured detail (`{"v":1,"at":…,"generation":…,"digest":…, …}`, extra fields allowed). Any
  other shape is no proof.
- **Person approval** of a task: basis `password` or `chat`, *and* a proof row for that approver and that exact digest
  with `personProof`. One function, `personApprovalOf(store, taskId)`, used by release, deploy and vote counting.
- **Authority** of a seal: its basis. Allowed values: `password`, `chat`, `mode`, `grant`, `schedule`, `lead`.
- **Machine actor**: the lead (`currentActor().lead`) or a remote API run (`activeRemote()`). Trusted context, never a
  flag or a name.

## Phase 1 — close the hole (Only people is the only behaviour)

Ships alone. No setting, no new UI beyond refusal words.

### 1.1 Approval

- `approve()`: right after authentication, before any vote or proof row, refuse unless `personProof(method)`.
  Words: **"Only a person can approve this. Approve it on the task page or from your paired chat."**
- `sealScopeApproval()` belt: a seal with no basis is a person's, so it refuses when `currentActor()?.lead === true`
  or `activeRemote() !== null`. Every caller that isn't a person passes a basis (schedules included, 1.6).
- `task approve` and `task repair --yes` under a lead token refuse before asking for anything.

### 1.2 Chat proof

The paired-chat approval (`chat-decide.ts`, basis `chat`) writes a real proof row beside its seal: action
`approval proved`, outcome `chat`, detail in the same digest-bound format (`<at> · generation <n> · digest <d>`),
with the chat binding in its own ledger line as today. `chat` is classified as a person. Only the paired-chat tap
writes it; it is never a password proof. Chat merges (`mergeInChat`) already record their own person tap.

### 1.3 Votes

- `scope_approval_vote` gains a `proof` column. `recordApprovalVote` writes the method; `approve()` already refuses
  machine proofs, so new votes are always a person's.
- Both counters (`approvalGate`, `protectedResultProblem`) count only votes with `personProof(proof)`.
- Migration fills `proof` from the matching proof row (task, approver, digest). Votes with a machine proof, and votes
  with no matching proof row (ambiguous), are kept as history but never counted.
- Reassessment, in the same migration: every sealed protected scope whose counted votes fall below two is
  - **queued with no live claim** → the seal is cleared and the task gets "Approval needs renewing";
  - **claimed, running or finished** → history kept; the vote counter at completion now asks for a second person,
    and deploy and release need a person approval anyway.

### 1.4 Provenance can't be erased

`saveScope` derives who wrote the text from the trusted actor, not from the caller:

- a lead-token write sets `proposed_via = 'lead'` if nothing stronger is there; a lead or remote write **never clears
  or downgrades** an existing `mate`, `scout`, `coordinator` or `lead` mark;
- only a write by a person (no lead actor, no remote run) may reset it, as today, since a person wrote those bytes.

The mate/coordinator/scout quarantine for modes is unchanged. `lead` is **not** added to it, so mode-covered lead CLI
filings keep working (decision 3). Every provenance consumer asks one question, `quarantinedAuthor(via)` (true for
`mate`, `scout`, `coordinator`), instead of "is it non-null": the mode seal quarantine, planning pre-authorization
(`plan-auto.ts`: new filing, `authorizePlanUnderMode`, flow grant filing), chat approval eligibility
(`chat-decide.ts`), the remembered-password rule (`freshlyApprovable`) and the stored-scope integrity check (which
accepts `lead`). The CLI → planner → mode seal journey for a lead filing is a compatibility test. In phase 2, `lead` and `mate` mean "the lead's own text"; `scout` and
`coordinator` mean another machine's.

### 1.5 Authority readers, all allowlists

`lead` and anything unknown never count as a person, and nothing unrecognised stands.

| Reader | Today | Phase 1 |
| --- | --- | --- |
| `readScope` (`store.ts`) | unchecked cast | allowed values pass; anything else reads as `unknown` (kept, not cast) |
| `approvalOf` (`scope.ts`) | ignores basis | null or `unknown` basis → `{ approved: false, reason: "authority" }` |
| `modeApprovalLive` (claim and build call it directly) | true unless a known mode/grant is dead | judges the seal that exists: no seal → true (nothing claimed; see below); `password`/`chat` true; `mode`/`grant` live checks as today; `schedule` (1.6); `lead` false in phase 1; a seal with null or unknown authority false |
| `dispatch.ts scopeApprovedForDispatch` | deny-list | same allowlist in SQL |
| `work-index.ts` `dispatch_approval` | deny-list | same allowlist in SQL |
| `release-adapters.ts` + `release.ts ownerApproval` | basis + name | `personApprovalOf`; `lead`/`mode`/`schedule` refuse in words |
| `deploy-candidate.mjs` | no approval check | `personApprovalOf` (1.7) |
| `evidence-pack.ts` | anything else is `"person"` | `person` only for a person approval; else `lead`, `mode`, `flow`, `schedule`, `unknown` |
| `noteLifecycle` (in `sealScopeApproval`) | an unlisted basis says "under the operating mode" | one wording per basis; `lead` → "Approved by the lead", `schedule` → "Approved by its standing order" |
| `render-tasks.ts approvalProofWords` | words for session/remembered | `chat` and `lead-token` get words; unknown says nothing |
| `claim.ts` plan-ready words | mode vs grant | unchanged (display only) |
| `chat-actions.ts` sweep-child fingerprint | drops approval fields | unchanged (not an authorization) |
| store demotions | reset basis | unchanged; they clear approval |

**Planning and checks versus building.** The shared claim primitive (`acquireLocked`) also admits planners (only
before approval) and scope-free checks (`acquireForCheck`). So the claim-time belt judges only a seal that exists: an
unsealed scope claims no authority and passes, exactly as today, and the role gates decide (a planner needs a
requested plan and no approval; a builder needs `scopeApprovedForDispatch`). A sealed row whose authority is null,
unknown or dead is refused at claim. The builder's last check requires `approvalOf` approved *and* the belt, so a
build never runs on null or unknown authority.

**Legacy null.** A sealed row with a null basis comes from before the basis column, when only the password ceremony
sealed. The migration sets it to `password`. After that, null is never written and reads as no authority.

**Legacy `password` without a proof row** (from before proof rows): stays `password` and keeps dispatching
(grandfathered, as today), but is not a person approval for release, deploy or vote counting. Release tasks are filed
fresh per commit, so this costs nothing there.

### 1.6 Schedules get their own basis

A standing order's firing seals with basis `schedule`, with the standing order's id as its authority reference (the
`mode_digest` column, which already carries grant and chat references). It is automatic: never a person, never a
vote, never enough for release, deploy or protected work (the gate already refuses kind `automation` there). It
stands at claim and build only while its approver is still an active approver with access to the project. That
live standing check is new work (today's `standingApproval` checks frozen terms and routing, not the account). A
schedule seal never counts as a person, whatever its approver's name. Migration: `password` seals on tasks filed by a standing order, with no person proof
row, become `schedule`.

### 1.7 Merge and deploy need a person

- **Merge.** The shared manual-merge boundary, `mergeAsPerson()`, requires a person proof from
  `authenticateApprover` (not just `.ok`); `task merge` refuses a lead token before asking, `--anyway` included.
  Words: **"Only a person can merge. Merge it on the task page or from your paired chat."** Automatic merging under a
  mode's grant and chat merges are unchanged.
- **Deploy.** `deploymentCandidate()` also requires `personApprovalOf` for the candidate's task. Every entry to
  `deploy-browser.mjs` — the whole run and each resumed phase (stage, prepare, rehearse, swap, finish) — already
  re-proves the candidate through it, so resumed phases are covered. `--phase recover` still needs no approval: it
  only puts the previous service back. The passing check and exact-completion requirements are unchanged.

- **Flow merges.** A flow's Pull request zone merges after an approval zone said yes (`approvedSinceBuild` →
  `mergePullRequest`). A subagent can staff that zone. Each flow move now records its decision authority
  (`person`, `subagent`, `lead`, `remote`, `flow`) beside the event. `approvedSinceBuild` counts only a `person`
  decision; subagent, machine and legacy events with no recorded authority never qualify (the card waits with the
  existing words: "merge it from its task, or send it through a decision").

### 1.7a Completion as the second person

Protected work approved by one person completes only by someone else (`protectedResultProblem`). Today any active
account can be that someone, including through a lead token (`checkAssignmentAsOperator`) or a remote `task
complete`.

- The completion ledger row records its proof: `proof person` or `proof machine` in its detail, from trusted context.
- A machine completion is allowed when nobody else is needed (ordinary lead completion stays). When completion would
  supply the second person, a machine completer is refused: "This result changed protected files, so a person other
  than its approver marks it complete."
- The publication reader (`protectedPublicationHold`) counts only completions marked `proof person`. Legacy rows
  without a mark are ambiguous and do not count; a person can complete an already-complete result again to record
  their mark, which releases the hold.

### 1.8 Existing data (one migration)

1. Null basis on sealed rows → `password` (1.5).
2. `password` seals whose own proof row is `lead-token` or `remote-token`, or whose `task_act` row says `approved`
   with `lead = 1` for that seal → `lead`, with the owner's lead credential as reference when it can be matched,
   otherwise `unknown-credential` (never stands).
3. Schedule seals → `schedule` (1.6).
4. Vote proofs and the protected reassessment (1.3).
5. Queued, unclaimed tasks that end up `lead` (or lose their second vote) are unsealed with the normal notice;
   running and finished work keeps its history.

## Phase 2 — the setting: People and the lead

### 2.1 The setting

- **Where:** per project, Settings → Approval rules, beside the requester and protected-work rules.
- **Record:** append-only ledger, newest wins, like `passwordless.ts` and `batch-policy.ts`: action
  `lead approval changed`, repo, outcome `people` | `lead`, actor, time, `before → after`. Reader
  `leadMayApprove(store, repo)`; missing or unreadable is `people`. SQL twin `leadApprovalStandsSql(repo)`.
- **Who:** an instance operator. Raising is a credential act (`proveCredential`: a password typed now or a one-use
  identity-provider re-check; never a session, remembered login or token) and joins the closed list in
  `docs/plans/passwordless.md`. Lowering is one click. Never from a lead token, an API token or chat.
- **Default: Only people**, for existing and new installs. Fail closed: today's lead approvals were a bug that looked
  like a person's, a missing setting must never widen authority, and it matches modes (no mode, no automation).

### 2.2 Sealing as the lead

`approve()` with `lead-token`, when `leadMayApprove(repo)` and the scope is **lead-approvable**, seals basis `lead`,
`approved_by` = the owner, authority reference = the lead credential's public id, proof row `lead-token`.
Lead-approvable means all of:

- standard permissions (not escalated); no check access beyond the fence;
- no requester rule and no protected work on this task (`approvalGate` kind `lead`, handled like `ai`); the lead
  never adds a vote;
- the text is the lead's own (`lead`, `mate`) or a person's (null) — never `scout` or `coordinator`;
- the organisation policy allows it (as for every seal).

Remote tokens never approve, in any setting.

### 2.3 When a lead seal stands

At dispatch, claim and build (`approvalAuthorityLive`, the dispatch and work-index SQL), a `lead` seal stands only
while all of these hold:

- the project setting is `lead`;
- the lead credential named in the authority reference is not revoked or replaced;
- its owner is still `approved_by`, an active approver, with access to the project.

So demoting the owner, removing their project access, or revoking or replacing the lead token makes outstanding lead
seals stop standing, as a mode stops when its signer does. Those events also run `withdrawLeadApprovals` (below) so
queued tasks show "Approval needs renewing" instead of silently stalling.

### 2.4 Lowering the setting, and the exact cutoff

- In the same transaction as the ledger row, `withdrawLeadApprovals(repo)` unseals lead seals on **queued tasks with
  no live claim**, each with the notice "The lead's approval no longer counts here. Approve it before it runs."
- **The cutoff is the builder's final authority check** (`builder.ts`, the last check before money), the rule modes
  follow today:
  - claim taken, builder not yet past its check → the builder refuses, the claim is released, and the task is
    unsealed with the notice;
  - builder past its check → that attempt runs to the end and its result can be inspected as usual;
  - any next attempt — retry, repair, revision, a resumed run — meets the check again and waits for a person.
- History is never rewritten: finished work keeps basis `lead`.

### 2.5 Gates

| Gate | A person | The lead (People and the lead) | A mode |
| --- | --- | --- | --- |
| Ordinary scope, standard permissions | yes | yes, basis `lead` | signer's own filings |
| Escalated permissions | yes | no | as signed |
| Check access (sign-ins, no sandbox) | yes | no | no (today) |
| Coordinator- or scout-written text | yes | no | no (today) |
| The lead's own text (CLI or chat proposal) | yes | yes | CLI filings yes, chat proposals no (today) |
| Requester rule on | yes, not the requester | no | as today |
| Protected work (two people) | one vote | no, never a vote | no (today) |
| Repair draft (`task repair --yes`) | yes | as ordinary scope | as today |
| Manual merge (`task merge`, merge button) | yes | **no** (decision 2) | grant + automerge (today) |
| Release | yes | **no** (decision 1) | no |
| Deploy | yes | **no** (decision 1) | no |
| Standing-order firing | — | — | basis `schedule` |

### 2.6 UI

- **Settings → Approval rules**, first block: **Who can approve work** — Only people / People and the lead / Approve
  automatically. One hint under the second: "Marked as the lead's. Merges and releases still need a person."
  The third opens the mode screen; while a mode is live the block shows its end and "Afterwards: …". Raising asks for
  the password inside the form; lowering is a click.
- **Task page, approval cards, board**: **"Approved by the lead"** with the time, never the owner's name alone.
- **The lead's tools**: the console chat lead gets no approve tool; it keeps offering the owner's own Approve buttons
  in paired chat (`lead-tools.ts`). Its facts say whether it may approve in this project. The lead approves only
  through `task approve` with its token, which meets the one rule.
- **MCP**: unchanged. `propose_scope` writes a proposal; a coordinator never approves.
- **Chat parity**: the setting is changed on its page (raising needs a password, so never in chat); the lead links to
  it with `show_control`.

Simplicity pass: one heading, three plain choices, one hint.

## Phase 3 — Approve automatically

The third choice opens the mode ceremony with its preset, and the block shows the mode's end and the fallback. UI
only; one desktop and one phone journey.

## Tests

Only what `docs/testing.md` keeps: security rules, migrations, contracts. Run the AGENTS.md safety self-review before
each security commit. Every case goes through the real road, not a hand-made gate.

Phase 1:

1. **Real lead-token approval** (`runOperate` with `TOOLROLL_LEAD_TOKEN` from a minted lead token, `task approve
   --yes --digest`): refused; scope unsealed; no vote, no proof row. Same for `task repair --yes`.
2. **Real lead-token merge**: `task merge` and `task merge --anyway` refused; `mergeAsPerson` with a lead token
   refused; a person's merge still works.
3. **Release and deploy**: over a lead-relabelled row, a schedule row, a mode row and a legacy no-proof row, both
   `ownerApproval` (through `release-adapters`) and `deploymentCandidate` refuse; a password row with proof and a
   chat row with its new chat proof pass. Deploy is also entered at a resumed phase.
4. **Seal belt**: `sealScopeApproval` with no basis under a lead actor or a remote run returns false.
5. **Final belts table**: one table over `approvalOf`, `approvalAuthorityLive` as called by claim and by build, the
   dispatch query and the work index. Rows: password, chat, live/dead mode, live/dead grant, schedule, lead, null,
   `bogus`. Null and `bogus` never stand anywhere.
6. **Votes**: a machine vote plus a later person's vote does not seal protected work; a sealed protected scope with a
   machine first vote is reassessed by the migration (queued → unsealed; running → completion asks for a second
   person).
7. **Provenance**: a lead refile of a scout, coordinator or mate scope keeps the mark; a person's refile resets it.
8. **Proof contract**: `personProof` is exhaustive at type level and false for unknown runtime strings.
9. **Migration**: seeded old database covering null basis, lead-token proof, `task_act` lead, a schedule firing,
   machine and missing-proof votes.
10a. **Completion**: a lead-token and a remote `task complete` cannot be the second person on protected work; an
    ordinary lead completion still works; a legacy unmarked completion doesn't release the publication hold, and a
    person's completion does.
10b. **Flow merge**: build → subagent approval zone → pull request with merge: no merge; a person's decision merges;
    a legacy event with no authority doesn't.
10c. **Compatibility**: a pre-approval planner claim, a scope-free check claim, and the lead's CLI filing → planner →
    mode seal all still work.
10. **Attack case**: the lead with its token env removed can't fall back to the owner's remembered login (the fence
    hides `up-login.txt`; add the case to the attack suite if missing).

Phase 2:

11. Lead-token approval under People and the lead seals `lead` with the credential reference; release, deploy and
    merge still refuse it.
12. **Gate table**: one row per line of 2.5, setting on and off; the lead never adds a vote.
13. **Standing**: owner demoted, owner loses project access, lead token revoked, lead token replaced → the seal stops
    standing at dispatch, claim and build, and queued tasks are unsealed.
14. **Cutoff interleavings**: claim → lower → build refuses and releases; build past its check → lower → attempt
    finishes, retry refuses.
15. **Setting**: raising refuses a session, remembered login, lead token and API token; lowering is one click;
    a viewer or non-operator is refused; ledger rows written.

## Decisions for Alex

1. **Releases and deploys always need a person**, even with People and the lead or a mode? *Recommend yes.*
2. **Manual merges always need a person** (the lead never merges by hand; automatic merging stays a mode's grant)?
   *Recommend yes.*
3. **Modes keep covering the lead's own CLI filings** (today's behaviour), while chat-proposal, scout and coordinator
   text stays quarantined from modes? *Recommend yes*; that is what Approve automatically is for. The alternative
   (quarantine all lead text from modes) means Approve automatically would not approve the lead's work.
4. **What the lead may approve by hand**: everyday work, its own or a person's text, never another machine's (2.2)?
   *Recommend yes.*
5. **Revoking or replacing the lead token, or the owner losing standing, ends outstanding lead seals** (2.3)?
   *Recommend yes*; it is the same rule as a mode's signer.
6. **Remote API tokens never approve**, in any setting? *Recommend yes* (the remote-team plan keeps approvals in the
   console and chat).
7. **Default Only people for new installs too**, and raising is a credential act (typed password, even under
   Passwordless)? *Recommend yes.*
8. **Legacy rows**: relabel lead approvals to `lead`, don't count machine or unproven votes, and keep no-proof
   `password` rows dispatching but not counting as a person for release, deploy or votes? *Recommend yes.*

## Round 1 findings → where answered

1. `task merge` open to the lead → 1.7, test 2.
2. Deploy gate never asks who approved → 1.7, test 3.
3. Machine votes counted as people → 1.3, 1.8, test 6.
4. Provenance erased by refiling → 1.4, test 7; reconciled with mode-covered CLI filings in decision 3.
5. Default-allow final belts → 1.5 (allowlist, legacy-null policy), test 5.
6. Chat approvals have no proof → 1.2, test 3.
7. Claimed vs started cutoff → 2.4, test 14.
8. Owner and token revocation → 2.3, test 13.

Round 2:

1. Completion as the second person → 1.7a, test 10a.
2. Subagent flow decision feeding a merge → 1.7 (flow merges), test 10b.
3. (phone plan) paired chat and passkey policy → the phone plan; here `chat` stays a person proof.
4. Strict belt blocking planners and checks → 1.5 (planning and checks versus building), test 10c.
5. `lead` provenance breaking mode-covered planning → 1.4 (`quarantinedAuthor`), test 10c.
6. Passkey proof format → "Words used below" (`passkey`, structured reader).

Also: schedules get basis `schedule` (1.6); `noteLifecycle` gets `lead` and `schedule` words (1.5); `task_act.lead`
is used as an existing truthful record (1.8).
