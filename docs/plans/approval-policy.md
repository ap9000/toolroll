# Who can approve work — plan

Status: plan, 2026-10-24. Branch `approval-policy`. Plan only; no code yet.

## The problem (found by Codex)

A lead token can approve a task's scope today, and the result is recorded as the owner's own approval —
including on a release.

- The CLI lets a lead token run `task` commands (`LEAD_COMMANDS`, `src/operate.ts`).
- `credentialsFrom()` hands out the lead's owner name with the lead token (`operate.ts`).
- `proveAccountNow()` knows it was the lead: it returns method `"lead-token"` (`src/scope.ts`).
- `approve()` ignores the method and seals through the default basis, so the row says
  `approval_basis = 'password'`, `approved_by = <owner>` (`scope.ts approve`, `store.ts sealScopeApproval`).
- `ownerApproval()` in `src/release.ts` reads only basis and name, so it accepts that seal as the owner's yes.
- The release test only rejects a made-up name, `lead:alex` (`src/release.slow.test.ts`), never the real path.

Two more things the audit found that make it worse:

- On protected work the lead's approval counts as the owner's **vote** (`approvalGate(…, "person")`), so the lead
  can supply one of the "two people".
- `scopeApprovedForDispatch` (`src/dispatch.ts`) and the work index (`src/work-index.ts`) treat every basis that
  isn't `mode` or `grant` as standing. A new basis would stand by default. These must become allowlists first.

Only the proof row (`action_ledger`, action `approval proved`, outcome `lead-token`) tells the truth today.

## Alex's decision

The lead may approve, under a per-project setting with three choices:

1. **Only people** — a person's approval counts; the lead's is refused.
2. **People and the lead** — the lead may approve, recorded truthfully as the lead's (basis `lead`), never as a person's.
3. **Approve automatically** — the existing signed, expiring operating modes (`docs/AUTO_APPROVAL.md`, basis `mode`).
   Reused, not rebuilt.

## How the setting fits the modes

Modes already answer "approve automatically": a signed, expiring envelope that seals the **signer's own filings**
(`autoApproveFiling`, `planAuto`), with demotion on expiry or revocation. They also carry unrelated terms
(permissions, reviews, repairs, merging).

Proposal: **the setting stores two values, `people` or `lead`; option 3 is a mode.**

- The ledger holds the project's standing answer: Only people, or People and the lead.
- Choosing **Approve automatically** opens the existing mode ceremony with the auto-approve preset. Nothing new is
  signed or stored; the mode is the record, with its own expiry and one-click revoke.
- While such a mode is live the setting reads "Approve automatically until Fri 10:00", with "Afterwards: Only people"
  (the stored value). When the mode ends, the stored value is simply what's left.
- A mode does not change what the lead may approve by hand. Filings it covers seal as `mode` exactly as today
  (including the lead's own CLI filings, which sign in as the owner); anything else the lead approves follows the
  stored value. No new mode term, so no existing signature changes meaning.

Why not a new mode term ("the lead approves too")? It would make a time-limited signature also widen the lead, and
old signatures would need a rule. Keeping the two apart means each answer has one owner and one record.

## The setting

- **Where:** per project, in Settings → Approval rules, beside the requester and protected-work rules.
- **Record:** an append-only ledger entry, newest wins, like `passwordless.ts` and `batch-policy.ts`: action
  `lead approval changed`, repo set, outcome `people` | `lead`, actor, time, detail `before → after`. One reader,
  `leadMayApprove(store, repo)`, read live at each act; an unreadable or missing row is `people`. One SQL twin,
  `leadApprovalStandsSql(repo)`, for the dispatch belts (same newest-row rule), like `grantStandsSql`.
- **Who changes it:** an instance operator, as for approval rules.
  - Raising to **People and the lead** is a credential act (`proveCredential`: a password typed now or a one-use
    identity-provider re-check, never a session, remembered login or token), because it gives a machine credential a
    new power. It joins the closed list in `docs/plans/passwordless.md`.
  - Lowering to **Only people** is one click, like revoking a mode.
  - Neither can be done with a lead token or an API token, and neither from chat.
- **Default: Only people**, for existing and new installs. Fail closed: today's lead approvals were a bug that looked
  like a person's yes, so no install should keep that power without someone choosing it; a missing setting must never
  widen authority; and it matches modes, where no mode means every act keeps its own ceremony.

## One enforcement point

Every scope approval ends in `approve()` (`scope.ts`) or `store.sealScopeApproval()`. The rule lives there.

1. **Classify the proof.** `personProof(method)` in `scope.ts`, an exhaustive switch over `AuthMethod`:
   `password-now`, `sso-now`, `fresh-password`, `fresh-sso`, `session`, `cli-login` are a person; `lead-token` is
   the lead; `remote-token` is a machine. A new method fails to compile until it is classified.
2. **`approve()`**, right after authentication and before any vote or proof row:
   - person proof → today's road, basis `password`.
   - `lead-token` → refused unless `leadMayApprove(repo)` and the scope is everyday work (below); then sealed with
     basis `{ kind: "lead" }`, `approved_by` = the owner whose lead it is, proof row `lead-token`.
   - `remote-token` → always refused (the remote surface already marks `task approve` as step-up; this is the belt).
3. **The primitive's belt.** `sealScopeApproval` with no basis (a person's seal) returns false when
   `currentActor()?.lead === true` or `activeRemote() !== null`. Any road written later that forgets `approve()`
   still can't mint a person's seal from a machine.
4. **Everyday work only.** A lead seal passes through the same quarantine block modes do, and takes the gate as a
   non-person:
   - coordinator-filed tasks: refused (a person sees who asked);
   - checks that reach beyond the fence (check access): refused;
   - escalated permissions: refused;
   - scopes the lead, a scout or a coordinator proposed (`proposed_via`): refused (decision 3);
   - requester rule or protected work on: refused, and the lead never counts as a vote (`approvalGate` kind `lead`,
     handled like `ai`).

   This is `freshlyApprovable()` plus check access: the same "everyday work" rule a remembered password already uses.

Refusal words, one line: **"Only a person can approve this. Approve it on the task page or from your paired chat."**
When the setting is the reason: **"This project lets only people approve work."**

## Every reader of `approval_basis`

`lead` is never "person" anywhere. Each reader moves to an allowlist so the next new basis fails closed too.

| Reader | Today | Change |
| --- | --- | --- |
| `dispatch.ts scopeApprovedForDispatch` | `NOT IN ('mode','grant')` stands | Allowlist: `password`, `chat`, live `mode`, live `grant`, `lead` only while `leadApprovalStandsSql` |
| `work-index.ts` `dispatch_approval` | same deny-list | same allowlist |
| `store.ts modeApprovalLive` (claim and build belts, `claim.ts`, `builder.ts`) | removes dead mode/grant | also false for `lead` when the setting is `people` |
| `store.ts sealScopeApproval` quarantines | apply when a basis is given | apply to `lead` too (falls out of passing a basis) |
| `store.ts approvalGate` | kind from caller | `lead` kind: refused when any rule applies; never a vote |
| `store.ts` demotions (mode, grant) | reset basis to `password` | unchanged; new `withdrawLeadApprovals` beside them |
| `scope.ts` `Scope.approvalBasis` type, `store.ts readScope` | four values | add `lead`; unknown text reads as `null` (unapproved), not cast |
| `evidence-pack.ts` | anything else is `"person"` | `password`/`chat` → `person`, `lead` → `lead`, `mode`, `flow`; unknown → `unknown` |
| `release-adapters.ts` + `release.ts ownerApproval` | basis + name | also the proof method (below) |
| `claim.ts` plan-ready words | mode vs grant | unchanged: lead never auto-approves a plan |
| `chat-actions.ts` revision strip | drops the field | unchanged: a revision is new text and needs a new yes |
| `render-tasks.ts approvalProofWords` | words for session/remembered | `lead-token` → " (by the lead)"; but the fact line itself says it (UI) |
| `lead-tools.ts scopeStandingOf` | approved / not | "approved by the lead" when basis is `lead` |
| `store.ts noteLifecycle` "Scope approved" | already says "the lead" | unchanged |

Per gate, what the lead may approve with the setting on:

| Gate | A person | The lead (People and the lead) | A mode |
| --- | --- | --- | --- |
| Ordinary scope, standard permissions | yes | yes, basis `lead` | signer's own filings |
| Escalated permissions | yes | no | as signed |
| Check access (sign-ins, no sandbox) | yes | no | no (today) |
| Coordinator-filed task | yes | no | no (today) |
| Lead/scout/coordinator-proposed text | yes | no (decision 3) | no (today) |
| Requester rule on | yes, not the requester | no | as today |
| Protected work (two people) | counts as one vote | no, never a vote | no (today) |
| Repair draft (`task repair --yes`) | yes | as ordinary scope (goes through `approve()`) | as today |
| Merge (`publish merge`) | yes | no (not a lead command; unchanged) | grant + automerge (today) |
| Release / deploy | yes | **no** (decision 1) | **no** |

## Releases

Recommendation: **a release always needs a person, whatever the setting.** It ships to everyone, and it is the one
gate where a machine approving its own build can't be caught later.

- `ownerApproval()` keeps its allowlist (`password`, `chat`) and adds the proof: the release adapter reads
  `approvalProofOf(task, by, digest)` and the gate refuses unless `personProof(method)`. A missing proof row refuses
  ("approve it again"); release tasks are filed fresh per commit, so this costs nothing.
- `lead` and `mode` bases refuse with "approved by the lead, not by a person" / "approved by a mode, not by a person".
- The release test goes through the real lead-token path, not a synthetic name.

## Revocation

Lowering to **Only people** works like a mode ending (`reconcileIntentsForMode`, `withdrawGrantApprovals`):

- In the same transaction, `withdrawLeadApprovals(repo)` clears lead-sealed scopes on **queued tasks with no live
  claim**, and each gets the existing "Approval needs renewing" notice: "The lead's approval no longer counts here.
  Approve it before it runs."
- **Running work keeps running.** An attempt already claimed or building finishes, and its result can be inspected
  as usual. The belts (`claim.ts`, `builder.ts`, dispatch) read the setting live, so any next attempt — retry,
  repair, the next dispatch after a race — waits for a person.
- History is never rewritten: finished work keeps its basis `lead`.

## Existing data

Rows sealed before the fix say `password` but their proof says `lead-token`. Phase 1 adds a data migration:

- Find seals with basis `password` whose own proof row (same task, approver, approved digest) is `lead-token` or
  `remote-token`; relabel them basis `lead`. History becomes truthful.
- Because the default is Only people, the queued, unclaimed ones then demote with the normal notice; running and
  finished ones keep their history.
- Migration test with a seeded old database, per AGENTS.md.

## UI

- **Settings → Approval rules**, first block: **Who can approve work** — Only people / People and the lead / Approve
  automatically. One hint under the second choice: "Marked as the lead's. Releases still need a person." Choosing the
  third opens the mode screen with its preset; while a mode is live the block shows its end time and "Afterwards: …".
  Raising asks for the password inside the form; lowering is a click.
- **Task page**: the approval fact reads **"Approved by the lead"** with the time, never the owner's name alone. A
  refused lead approval leaves the normal approval card for a person.
- **Approval cards and the board**: the same three words wherever "Approved by alex" appears today.
- **The lead's tools and chat**: the console chat lead keeps no approve tool. It still offers the owner's own Approve
  buttons in paired chat (`lead-tools.ts`), and its facts say whether it may approve in this project. The lead
  approves only through the CLI it already uses (`task approve` with its token), which hits the one rule.
- **MCP proposals**: unchanged. `propose_scope` writes a proposal; a coordinator never approves, under any setting.
- **Chat parity**: the setting is changed on its page (raising needs a password, so never in chat); the lead can link
  to it with `show_control`.

Simplicity pass before sign-off: one heading, three plain choices, one hint, no explanation paragraphs.

## Tests

Only what `docs/testing.md` keeps: security rules, migrations, contracts. Run the AGENTS.md safety self-review before
each security commit.

1. **Real lead-token regression** (`runOperate` with `TOOLROLL_LEAD_TOKEN` from a minted lead token, `task approve
   --yes --digest`):
   - Only people → refused with the words; scope unsealed; no vote, no proof row.
   - People and the lead → sealed, `approval_basis = 'lead'`, proof `lead-token`.
   - Release gate over that row refuses in both settings (through `release-adapters`, not a hand-made gate).
2. **Primitive belt**: `sealScopeApproval` with no basis inside `withActor({ lead: true })` or a remote run returns
   false.
3. **Gate table**: one table test, one row per line of the gate table above (setting on/off × gate), asserting seal or
   refusal and that the lead never adds a vote.
4. **Reader table**: one table over dispatch, work index, `modeApprovalLive`, evidence export: `lead` with setting on,
   `lead` with setting off, an unknown basis — the unknown one never stands.
5. **Contract**: `personProof` is exhaustive (type-level `never`); remote `task approve` stays step-up.
6. **Revocation**: lowering demotes queued unclaimed lead seals; a claimed one keeps running; its next dispatch waits.
7. **Setting**: raising refuses a session, remembered login, lead token and API token; lowering is one click; a viewer
   or non-operator is refused; ledger rows written.
8. **Migration**: old `password` + `lead-token` proof → `lead`, queued ones demoted.
9. **Attack case**: the lead with its token env removed can't fall back to the owner's remembered login (the fence
   already hides `up-login.txt`; add the case to the attack suite if it's missing).

## Phases

1. **The fix: only people.** `personProof`; `approve()` refuses `lead-token` and `remote-token`; the primitive's
   belt; allowlists in dispatch and the work index; `lead` basis known to every reader and never standing; release
   reads the proof; evidence export fixed; migration of old rows; tests 1 (refusal half), 2, 4, 5, 8, 9. Small, no UI
   beyond the refusal words. Ships alone.
2. **The setting: people and the lead.** Ledger + reader + SQL twin; Settings → Approval rules block (two choices);
   `approve()` seals `lead` for everyday work; `approvalGate` kind; `withdrawLeadApprovals`; task page, cards and lead
   facts say "the lead"; tests 1 (seal half), 3, 6, 7.
3. **Approve automatically.** The third choice opens the mode ceremony with its preset and shows the mode's end and
   the fallback. UI only; one desktop and one phone journey.

## Decisions for Alex

1. **Releases always need a person**, even with People and the lead or a mode? *Recommend yes.*
2. **Option 3 is a mode, not a stored value**, and a mode doesn't widen what the lead approves by hand? *Recommend
   yes* (alternative: a new signed mode term that also lets the lead approve).
3. **What the lead may approve**: everyday work only — standard permissions, no protected work or requester rule, no
   check access, not coordinator-filed, and not text the lead or a scout proposed? *Recommend yes.* Allowing its own
   chat proposals is the one tempting widening; it would mean the lead writes and approves the same words.
4. **Remote API tokens never approve**, under any setting? *Recommend yes* (the remote-team plan already keeps
   approvals in the console and chat).
5. **Default Only people for new installs too**, not just existing ones? *Recommend yes*; turning it on is one
   deliberate act.
6. **Raising the setting is a credential act** (typed password, even under Passwordless)? *Recommend yes*; it gives a
   token a new power.
7. **Old lead approvals**: relabel to `lead` and demote the queued ones on upgrade? *Recommend yes*; the alternative
   (leave them as the owner's) keeps a false record.
