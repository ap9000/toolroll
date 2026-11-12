# Progress

**2026-09-19 UTC — The check runs again on the same commit (v70 behaviour, schema unchanged).**
`task regate <id>` files a new attempt whose prepared candidate is the last
attempt's exact commit: no agent, a fresh receipt and proof, the ordinary
review. Under a mode with automatic repair, a gate failure the change did
not cause — the whole check timing out, or an untouched test's own timeout —
reruns once automatically; a second failure on the same commit is handed to
a person with the `regate` command named. A publication intent that never
pushed no longer blocks a rerun. Yesterday two candidates lost a full round
each to a flaky test; both would have rerun in three minutes.

**2026-09-19 UTC — A prepared commit is an attempt (v69).**
`task scope --candidate <sha>` names a commit the machine installs as the
attempt: it proves the commit descends from the task's base, brings the
worktree to its tree uncommitted, writes the handoff itself, and settles
through the same state machine as an agent attempt — commit, sealed diff
from the pinned base, approved gate, review. No provider is spawned. The
candidate is signed into the scope digest (folded only when present, so no
earlier digest changes); schema 69 adds `task_scope.candidate`. Yesterday
about twenty builder runs, three to eight minutes each, existed only to
`git apply` a diff someone had already written; those become zero.

**2026-09-19 UTC — Corrections ride the same filing.**
`task requeue` now accepts a finished task whose last builder result was not
accepted: a failed gate, a contradicting review, or a refuted proof. The next
attempt continues on the task's own branch under the current scope, so a
corrected candidate is a re-scope plus a requeue, not a new task. An accepted
or published result still refuses, with the reason in plain words. Yesterday's
deployment-script fix took six filings because each rejection needed a new
task; it now takes one.

**2026-09-18 UTC — Fewer limits in the way of filing and installing.**
Four frictions met in one day of real work, removed: (1) acceptance
statements may run to 1,000 bytes, and a `;` inside a statement no longer
splits the rubric — `splitAcceptanceRubric` glues a segment with no
`|evidence` part onto the next; `--acceptance plan` files the placeholder.
(2) A placeholder rubric under a mode with `planAuto` now requests a plan
from the command line exactly as a console-filed scout follow-up does, so a
build is never judged against "the operator has written a real rubric".
(3) Retained check logs keep 24 KiB per stream, four fifths of it the ending
where a test runner prints its summary and failures (`boundStreamHeadTail`);
the check-log cap rises to 160 KiB. (4) `scripts/deploy-browser.mjs --run
<builder run> --yes` is the one-action installation: it stages the packed
runtime beside the installed ones, proves verified proof, upheld review,
scope digest and the exact approved command from the plane's own records,
then drains, backs up, rehearses, swaps the launchd service, migrates and
reopens admission with a resumable journal. It replaces the per-release
hand-written script that differed by three strings.

**2026-09-18 UTC — Stop paying for failures the change did not cause.**
Mayhem-spire run 1784 passed 163 of 164 tests; the one failure was an
untouched, non-asserting balance probe timing out at its own 120 s limit.
The machine gate read exit 1 as a refuted proof and drafted `-fix-1`, whose
builder correctly changed nothing, and whose gate then passed. Three changes:
(1) `src/gate-failure.ts` classifies a failed gate from its sealed receipt,
log and candidate inventory; the automatic failed-check repair in
`maybeTriggerRepair` now skips the draft and tells a person, in plain words,
when the whole command timed out or when every failure is a per-test timeout
in a file the candidate did not touch. Assertion failures anywhere, timeouts
in touched files, and unreadable inventories still repair as before.
(2) The planner is told to state criteria as things observable on the
candidate alone, never "fails on the original base": the gate runs only the
candidate, so such a criterion can only send finished work back for evidence.
(3) The full suite runs in about 130 s with Vitest's file parallelism and
about 900 s without it; the two tests that could not finish in 15 s with
every core busy get 60 s, the default becomes 30 s, and the approved local
gate for the Developer checkout drops `--no-file-parallelism` (CI already
ran without it). The mayhem-spire probe itself now runs only under
`BALANCE_PROBE=1` (`npm run test:balance`); its gate takes 25 s.

**2026-09-13 UTC — npm/browser deployment preflight (not deployed).**
Separated the npm/browser installation path from publisher-only Mac signing.
The current source built and its 262-file npm tarball installed successfully
offline in a disposable prefix; the packaged CLI reports 0.4.3. The current
schema-57 database is compatible and has no open runs, claims, conversations,
held sessions or unsettled stops. The old desktop supervisor is loaded but
its authenticated console health check fails. A disposable launchd job using
the packaged project's access checker and the intended Node runtime timed out
on all three saved Documents projects. The probe job was removed; no live
service, database, project registry, app or permission was changed. This does
not establish whether the cause is a pending prompt or another access problem.
An unlocked-session access check remains necessary before switching services.
The next product milestone is a measured ten-task pilot, expanding to 30–50
mixed tasks after repairs, with explicit proof and rescue-rate criteria. See
[preflight evidence and next actions](assessments/NPM_DEPLOYMENT_2026-09-13.md).

**2026-09-13 UTC — Automatic update recovery (local, not deployed).**
A temporary macOS recovery job now survives updater/supervisor crashes without
reopening the app or pressing Resume. Durable attempt budgets, updater-only
hang detection, transient retry and automatic old-app restoration reuse the
existing update journal and service lifecycle. Explicit Stop remains off;
current task data is never replaced by an old backup. Real final-artifact
trials passed supervisor SIGKILL (28.405 s), updater SIGKILL after swap
(15.655 s), early updater SIGKILL (8.810 s), cancellation during drain (9.239 s)
and Stop after swap (13.327 s), with zero manual rescues and automatic
recovery-job cleanup. A separate injected health failure with real app/service
restoration passed in 11.072 s and preserved newer task data. A service-template
compatibility regression was found and fixed in the real trials. Final full
suite: **2,782 passed, 23 platform skips, 161 files**; typecheck/native build
and signature verification passed. One earlier loaded-suite held-transport
failure did not reproduce in focused/full reruns; its cause is not claimed
fixed. No live installation or OS permissions changed. Signed installed
acceptance, physical reboot and Windows remain release gates. See
[failure matrix, evidence and limits](assessments/AUTOMATIC_UPDATE_RECOVERY_2026-09-13.md).

**2026-09-13 UTC — Controlled update and recovery (local, not deployed).**
File → Install app update / Update status now manage same-schema app updates:
pause new work, drain current work, verify a private backup, atomically swap,
verify the new worker and restore the previous app on failure without restoring
old task data. Cancellation and interrupted operation recovery preserve the
service's prior state. A real forced-interruption test exposed a status-lock
race; the fix and cross-process regression were added before acceptance.
The final native artifact passed forced updater death → Resume → verified
update in **8.461 seconds**, and rejected candidate health → verified previous
app in **11.114 seconds**, with newer task data preserved. Full regression:
**2,761 passed, 23 platform skips**; final focused desktop checks: **47 passed**,
including the additional shutdown-recovery regression. Typecheck/build and
native signature checks passed. No live installation, queue or OS permission
was changed. Signed update/access persistence, physical reboot and Windows
acceptance remain separate release gates. See [scope, limits and retained
evidence](assessments/CONTROLLED_UPDATE_2026-09-13.md).

**2026-09-13 UTC — Installation/update safety (local, not deployed).** Builds
now produce separate non-overwriting artifacts. Stop/Status survive database
failures; Start refuses incompatible or missing data before touching launchd.
An established installation cannot recreate a disappeared database as an empty
queue. Build IDs participate in the native service definition, and File →
Check installation provides recovery diagnostics even when startup fails.
A candidate's `database-status` preflight is read-only and does not create
desktop state. Typecheck/build and **2,737 tests** passed (**160 files, 23
platform skips**); the native preview compiled and its signature verified.
Its temporary-folder copy recovered from clean exit in **1.744 seconds** and
forced crash in **182.361 seconds**, with **zero manual rescues**, fresh worker
access and retained data. The Documents-located preview failed to reach a
heartbeat; both outcomes are retained rather than calling platform access fixed.
Signed access-persistence, native-window, installed update/reboot and physical
Windows checks remain explicit gates. No installed app, real queue or privacy
grant was changed. See [the checkpoint and qualification bar](assessments/INSTALLATION_SAFETY_2026-09-13.md).

**2026-09-13 UTC — Conversational phone control in the existing chatbot
(local, not deployed).** Mobile Chat/Ask is the primary experience; Telegram
is optional. Browser sends now have a session-bound, content/task-bound durable
receipt in the existing mutation ledger, so a lost response or duplicate tap
does not create another turn after completion/restart. Pending replies retain
an editable composer, tab drafts survive navigation, and visible reconnect
polling replaces repeated full-page refreshes. A focused draft or approval form
is never interrupted to load a new reply. Mobile projects use a dismissible
drawer, portfolio context starts collapsed, and the empty composer precedes
starter prompts. Desktop keeps its expanded context. The full suite passed:
**159 files, 2,725 tests, 23 platform skips** (47.52 seconds), followed by
**275 focused tests** after the final composer ordering adjustment. Typecheck
and build passed. A scripted-provider, isolated-browser journey verified
natural-language request → proposal → confirmed pause, 390/320px layouts, and
offline/reconnect draft preservation. No real provider run, native permission
change, deployment, or real-phone keyboard certification is claimed. See
[phone usage](PHONE_STATUS.md) and [evidence](assessments/PHONE_CHAT_2026-09-13.md).

**2026-09-13 UTC — Read-only phone status (local, not deployed).** The existing
Telegram bridge answers `/status`, `/task <id>`, and `/help` without model calls
or task mutations. Views reuse dispatch/proof/publication records, distinguish
unfinished review and weak proof from completion, and label local versus
published results. Enrollment and pairing are re-proved; replies are bounded,
recent-history limits are explicit, and decision notes keep their existing
semantics. Typecheck/build and the full suite passed: **157 files, 2,707 tests,
23 platform skips**, 242.18 seconds. This includes the prior local desktop
signing/access foundation, which remains uninstalled. No production queue,
bot, or OS permissions changed. No live Telegram or real-provider execution
is claimed. See [usage](PHONE_STATUS.md), [validation](assessments/PHONE_STATUS_2026-09-13.md),
and the [updated work order](PRIORITIES.md#next-sequence).

**2026-09-12 — Recipe creator and frequent-work launch (schema 57).** Authors
can save reusable instructions with questions for the parts that change. Each
use asks only those questions, freezes their answers into the existing durable
preview, and uses existing approval and recovery. Saved recipes are searchable,
show recent uses first, and link directly from new-task intake. Format-1 recipes
and their digests/receipts are preserved; schema 57 fences older readers and
indexes recent-use lookups. Typecheck/build and 2,673 local tests passed. See
the [guide](WORKFLOW_RECIPES.md) and
[scope and validation record](assessments/RECIPE_CREATOR_2026-09-12.md).

**2026-09-12 — Guided workflow recipes (schema 56).** Six starters now lead
through choose, customize, and preview into the existing task/routine engine.
Project recipes are reusable immutable copies with JSON import/export; task
scopes can be copied into the editor. The preview exposes scope, success checks,
schedule, and readiness. Durable launch receipts make retries return the same
work across restarts, with atomic filing, policy application, and ledger
recording. Existing project grants and approval boundaries remain enforced.
Typecheck/build and 2,663 local tests passed; browser checks cover desktop,
phone, saving, export, and scheduled creation. The live Mac upgrade remains
behind its previously recorded OS recovery gate. See the
[guide](WORKFLOW_RECIPES.md) and [assessment](assessments/WORKFLOW_RECIPES_2026-09-12.md).

**2026-09-12 — OS process containment and controller recovery (schema 53).**
Integrated the self-hosted builder's commit with independent operator fixes in
PR #3. Native Linux cgroup v2 and Windows Job Objects admit a target only after
durable custody, terminate detached descendants, and require kernel emptiness
before settlement. Required mode refuses unsupported hosts; macOS remains
observational. Boot-aware custody and worktree occupancy preserve conservative
recovery when identity is missing. Desktop and CLI services share lifecycle
code, verify loaded generations, and supervise controller restarts. The desktop
bundles its signed Node runtime and retains one runner identity.

The fixed `2cda503` runtime passed real Claude and Codex Stop/Resume journeys,
all seven crash scenarios, and an actual disposable desktop controller recovery
check (clean exit 1.7 s, SIGKILL 182 s through normal fences, no rescue).
A schema 52→53 preview preserved all historical values across 95 tables.
The installed controller remains on schema 52: fresh launchd services blocked
reading a Documents fixture with both existing and bundled Node. OS job
relaunch was also deferred in independent launchd probes. Physical login/reboot,
protected-project access and live deployment are separate gates, not inferred
from the passing controller tests. See [the operator assessment](assessments/PROCESS_CONTAINMENT_2026-09-12.md)
and [capabilities and boundaries](PROCESS_CONTAINMENT.md).

**2026-09-12 09:40 UTC — Installed controller upgraded and verified.**
Main includes PR #2 (`4c70a8c`), and the live desktop runs the certified
`82d0d28` runtime on schema 52. Both real providers passed Stop/Resume without
rescue, all seven crash scenarios passed, the full suite passed 2,550 tests,
and all six final PR CI jobs passed. The actual live migration preserved all
historical data, the saved login works, and a fresh heartbeat was verified.
See the [deployment record](assessments/LIVE_UPGRADE_2026-09-12.md) and
[certification boundaries](assessments/STOP_RESUME_CERTIFICATION_2026-09-12.md).

**2026-09-12 — Safe task stop and resume (schema 52).** An authenticated
operator stops ONE exact active attempt: `task stop <id> --run <n>` or the
console's Stop, which name the run and are recorded — who, when, from where —
in `run_stop` BEFORE any process is signalled. The answer is *Stopping…*,
never *Stopped*: the attempt's own process tree (provider, repair turns,
setup and check children, or a held session through its supervisor) is
ended through the handle the worker holds under a database-and-run owner tag. Settlement requires both observed
process exit and the fenced interruption seal
(`finalizeInterruptedFenced`: claim released as `interrupted`, the run and
every owned descendant `failed / interrupted`, the task requeued under the
stop's own `stop`-owned hold — no strike, no backoff, no incident, no
automatic repair). A stop that commits before terminal settlement wins at
every road — build success, park, failure, plan ingestion, review
ingestion, fallback resolution, publication admission — so late output is
never accepted; a finished attempt refuses a stop and its completion
stands; a run that already admitted a publication refuses in those words.
Descendants sharing the stopped run's lease inherit the stop; a successor
under a fresh claim never does. Crash recovery (dead runner and dead
incarnation) keeps a stop pending while observed descendants remain live;
only proven quiescence settles it as `recovered`, preserving evidence,
commits and dirty worktrees. The held supervisor settles as `held`.
Resume (`task resume`, or the console's password ceremony over a durable
nonce bound to the run, its settlement, and the scope approval) refuses
until the exact attempt is quiescent — settled, owned runs ended, no live
claim, workspace not held by a live process — lifts only that stop's hold,
approves nothing, and points a stopped review at the bounded explicit
retry door. The recovered-draft road refuses to inherit a stopped draft
until it is resumed; the next pass takes a fresh claim, re-proves the
signed scope, quarantines the old handoff, and requires fresh proof. Real
subprocess tests stop one of two simultaneous trees and prove no write after
settlement; a real Git journey interrupts a dirty draft mid-flight from
another connection, resumes it through the CLI, and lands one accepted
result with main untouched. Desktop and phone captures of Stop, Stopping…,
Paused/Resume, and the resume ceremony are under
`evidence/safe-task-stop-and-resume/`. See [the plan](TASK_CONTROL_PLAN.md).

**2026-09-12 UTC — Contract handoffs integrated and certified in bounded workflows.**
All three implementation tasks completed through Standing Orders, followed by
operator-led integration hardening. This is assisted implementation. The Agor
source assessment supports using existing task/run/artifact records, explicit
ancestry, and bounded context instead of adding a memory platform.

Planning now proves the recorded source bytes and full contract again at
atomic finalization; stale identity releases the claim, and lost evidence or
undeclared amendments cannot land a plan. Decision history beyond the explicit
five-answer limit refuses visibly. Revision creation binds the actual source
run/scope/head and full annotation batch, retains permission and budget ceilings,
and preserves bounded repair ancestry. New revision builds start at the verified
source head. Review inventories retain paths across successive revisions, bind
ancestor evidence and reviewer lineage, verify Git blob identities, require
criterion-relevant citations, and recheck input custody at atomic ingestion.
Mixed patch/inherited coverage and missing context are represented explicitly.

A private backup of the live schema-49 database upgraded to 51 twice-opened
successfully, with all table counts preserved and clean integrity/foreign-key
checks. The live controller was still on schema 49 at that certification
checkpoint; it has since reached schema 52 as recorded above. That suite passed
132 files / 2,507 tests (12 existing skips). Both real
provider handoff journeys and the broader 20-case pilot pass without rescue
interventions. See [the integration report](assessments/CONTRACT_HANDOFF_RESULT.md)
and its compact certificate. Earlier per-task certificates below describe their
own source snapshots.


**2026-09-11 — Revision terms preserved through one boundary (contract
handoff task 2).** Annotation revisions, CI repair drafts, and criterion
repair drafts now file through one `Store.sealRevision` under one
field-by-field policy. The seal proves the source binding inside its own
savepoint before creating anything — source task, source run belongs to it,
the scope digest the caller read still stands, the stored terms read back
exactly, and the brief file re-hashes and names that exact source — and
refuses `source-task` / `source-run` / `stale-source` / `source-terms` /
`brief-custody` / `comments-taken` / `duplicate` with zero rows, nested or
not. The child carries the source's goal (plus the described repair),
exclusions, touches, exact rubric, declared risk (never below the signed
level), quality (strict stays strict), permission posture (never wider), budget
ceiling (a mode default may only tighten it), route overrides, and pins —
read from the source rows, never a caller's copy — so a changed installation
default cannot downgrade, widen, or uncap a revision. The route, profile, and
fallback chain are re-resolved for a fresh approval; the approval stamp,
attended authorizations, publication and merge grants, and the plan never
inherit. The repair loop finds the chain a task continues through its
revision ancestry (`repairLineageOf`), so an annotation or CI detour keeps
the root, the attempts spent, and the remaining automatic bound across a
restart; no new retry engine and no schema change. The task page's revision
card, the approval card, and the task chat card show the actual terms and
lineage (`revisionLineageOf`). Policy: [REVISION_TERMS.md](REVISION_TERMS.md);
coverage in `src/revision-terms.test.ts` and `src/serve.test.ts`.
**2026-09-11 — Preserve the filed planning contract (schema v51).** The
planner now receives exactly what the operator filed, as quoted data: the
scope's goal, exclusions, touches, and the whole rubric (ids, statements,
evidence kinds, advisory `how`), the execution terms (risk, quality, budget,
resolved agent, task-level permission), the revision brief by verified read
when the task revises reviewed work, and the earlier answers — assembled per
attempt by `src/planner-source.ts`, bounded by one explicit 128 KiB cap, and
refused in words before any workspace, run, or provider spend when over it or
when the brief cannot be verified (the task page's dispatch diagnosis says the
same). The record is sealed on the planner run as a `plan-contract` artifact
before the brief is composed, the run is stamped with the filed scope digest,
and the brief carries the record between markers with its source identity.
Filed intent is data, never authorization. A drafted plan must reproduce the
filed contract exactly or state an `amendment`: a silent change is a
`silent-amendment` malformed plan, corrected in the same session by adding the
note (goal/outOfScope/touches/acceptance stay frozen) or sealed as a durable
incident when no session can be resumed. `finalizePlanFenced` re-derives the
source identity inside its transaction and refuses a draft whose source moved
— scope rewritten, approval changed, terms re-termed — as `stale-source`
(claim released, no strike, the newer scope untouched, the task still
requested); on ingestion it seals `plan-contract.json` with the filed terms,
the proposed terms, the amendment, and every mechanical addition, change, and
removal. The task page, the approval ceremony, `/next`, the chat approval
card, `task show`, and the `task approve` preview show the contract as
preserved exactly, amended (every change beside the planner's reason, and the
plain consequence that the yes binds the amended terms), or drafted with no
scope filed; the ordinary approval binds the scope row's digest as before.
Corrections inherit the root's record; a resumed decision re-derives the same
identity and quotes the whole request again. The v50→v51 upgrade widens
`artifact.kind` by the v46 copy-rename recipe, byte for byte, refusing any
predecessor shape it cannot prove. Typecheck, the full suite (129 files, 2,444
tests), the build, and the six-stage crash canary on the rebuilt runtime
(`evidence/preserve-filed-planning-contract/crash-canary.json`, runtime
`f6eec868…`) pass. Not in this change: revision-term inheritance, inherited
review context, and the integrated request-to-review journey with a real
provider.
**2026-09-12 — Inherited review context (schema v51).** A small revision to a
larger feature used to hand its reviewer only its own patch, so every
criterion the earlier build implemented could honestly be judged only
`cannot-tell` (run 1518 said so three times over work run 1514 had upheld).
A revision run's settlement now seals one more verified artifact,
`review-context` (`src/review-context.ts`): the source files relevant to
the signed criteria, read from git objects at the revision's exact sealed
head by `ls-tree` and `cat-file blob` — no lazy fetch, replace refs,
filters, textconv, or diff drivers, and never the working tree — with each
item bound to the source run, the commit, the path, git's blob id, and a
SHA-256 of the stored bytes. Relevance comes from verified ancestor
artifacts only (the source run's sealed proof — its changed paths and the
changed-path evidence it cited per criterion — and its sealed diff-stat);
lineage is the revision brief artifact's own run (`store.revisionSourceOf`).
Bounds are explicit (48 KiB per item, 192 KiB aggregate, 24 items, 200
candidate paths) and never truncate: an oversized, binary, non-UTF-8,
missing, non-file, or over-aggregate path is a named gap; a secret-shaped
line is redacted before storage and the redaction is a gap too. Ancestry is
checked (`merge-base --is-ancestor`), the source scope must still carry the
digest the source run built under, and each earlier reviewer judgement on
the source is carried as `priorReview` CONTEXT with its own proof —
same criterion text, verified ancestry, relevant code byte-identical at
both heads, the source review's evidence bindings intact — marked
`eligible` or `invalid` with reasons, and never folded as this run's
verdict. Per criterion the inventory records `coverage`: `patch` (new to
this rubric, or its relevant code is in the revision's own diff), `context`
(inherited and every relevant path sealed), or `gap` (inherited and
something is missing — the reasons listed); `adjudicate` copies it onto the
stored matrix rows, where changed criterion text, changed code, stale or
unproven ancestry, tampered ancestors, and limits all read as gaps or
invalid support. The reviewer pass materializes `REVIEW-CONTEXT.json`
(re-serialized from the strict reader) beside the patch, rubric, proof,
check log, and screenshots — the same bytes in Claude's scratch and Codex's
inline bundle, with one aggregate text limit now measured identically for
every provider — seals and re-hashes it after the agent ran, re-verifies
the whole inventory before spend, and binds it at atomic ingestion
(`criterion_review.context_artifact`/`context_sha`, refused both ways: an
inventory added after materialization or removed before ingest is
`stale-evidence`, a tampered scratch is `dirty-scratch`, and every failed
attempt stays on record under the unchanged three-attempt cap). Judgements
must cite supplied provenance: an `upholds` or `contradicts` on a criterion
not judged from the patch whose note cites no `ctx-<n>` item, patch path,
or sealed file name is refused whole (the same-session correction names
the id). Semantic coverage is a distinct projection (`semanticCoverage`,
`coverageWords` in `proof.ts`) rendered beside — never inside — the machine
verdict on the task page, run page, chat receipt, and `task show`: under
`default` quality an independent review is optional and the words say so;
under `strict` it is required and only `upholds` satisfies it — `cannot-tell`
never counts, under either policy — with every context gap named in the
same words the inventory used. The verdict fold itself is unchanged. Schema
v51 widens `artifact.kind` by the same exact-recognizer copy/rename as
v34/v38/v46 and adds the two binding columns additively; every historical
row reads back byte for byte. Revision branches still grow from the
project's checked-out branch (revision creation is a separate bounded
task): a source head that is not an ancestor of the revision's head is
reported as `stale-ancestry` on every inherited criterion rather than
trusted.

**2026-09-11 — Bounded explicit review retries (schema v50).** A finished
build's independent review that failed or was interrupted can now be retried
by an operator — `standing-orders task review <run> --as <you> --token <t>`
again, or the task page's and result cockpit's **Retry review** — at most
twice: three root reviewer attempts per source build, ever, a fixed cap. The
store carries the identity durably (`run.review_attempt` is the root's ordinal;
`review_request.reviewer_run` binds each spent request to the root that
answered it) and decides eligibility inside the same transactions that ask
and admit: no successful review yet, no root still open, nothing already
queued, fewer than three roots — refused as `already-reviewed`,
`review-running`, `already-requested`, or `retries-exhausted`, opening no
run. Four exact partial uniques replace v29's `one_review_per_source`: one
ordinal per (source, attempt), one live root per source, one root that
ingested a review per source (a root ends `no-change` only through
`ingestReview`), one correction child per reviewer, one root per request.
Every retry is a distinct request and root: the pass re-proves the sealed
review route, runner/watch custody, and the complete verified artifact
inventory, seals a brand-new scratch from the artifacts, and ingests through
the same atomic transaction — a late reply from an interrupted attempt finds
its root closed and lands nothing; the failed attempts, their requests,
structured-output evidence, and diagnostics stay exactly as recorded. The
source build is never rerun. `task show` prints the review state, the attempt
count against the cap, every attempt's outcome, and the exact retry command;
the typed dispatch diagnosis carries a `review` view (`queued`, `running`,
`retryable`, `exhausted`, `succeeded`, with attempt/cap/remaining and the
latest reason), a `retry-review` action, and a `review-exhausted` code; a
queued retry is never hidden behind an older failed run; the tick reports the
attempt each review pass ran and, on failure, the retries left. The v49→v50
upgrade makes every existing root attempt 1, binds it to the one request v49
spent on it, leaves ids, outcomes, comments, judgements, and evidence bindings
byte for byte, reopens idempotently and foreign-key clean, and refuses in
words any predecessor shape it cannot prove. The public crash canary's review
stage continues through the explicit retry to attempt 2 of 3 with one build,
one commit, and no further dispatch. Nothing retries by itself; automatic
review retry remains deliberately absent.

**2026-09-12 — Explicit-only review retries: automatic producers are
one-shot.** Dogfooding build 1513 found that replaying the build disposition
after a failed root review queued AND admitted attempt 2 with basis `mode`, no
operator involved — the exclusion the retry scope was written under.
`review_request.origin` (`operator` | `automatic`) now records how every ask
was produced: `task review` and the console's **Retry review** are
`operator`; the reviewAuto-mode producer and the Strict / release scope
producer (`maybeRequestAutoReview`, both roads) declare themselves
`automatic`, and a mode-basis row is automatic whatever the column says. An
automatic ask is one shot per source build: `requestReview` refuses it
`explicit-only`, in words, once the run carries any root attempt or any
earlier ask; `admitReview` re-proves the same fact inside the admission
transaction and spends a stale automatic ask `explicit-only` before the daily
rail and before any run row; the `startRun` reviewer insert refuses it too,
whatever road presents the request. A fresh operator ask still retries and
runs to success; the typed dispatch view, `task show`, and the console panel
name who asked for a queued retry. On a file from before the column, mode
rows read `automatic`, and an open human-basis ask that would already be a
retry — the exact row a replayed Strict producer wrote — is spent
`legacy-origin` rather than admitted on a guess; a person asks again. That
provenance pass is atomic and restart-safe: the column and its classification
commit as one write transaction (fault injection found an `ALTER` committed
on its own left the replayed Strict retry open as an operator's ask and it
admitted attempt 2), an interruption after the column, between the writes, or
before the commit rolls all of it back for the next open to redo, and a second
opener that waited on the lock re-checks the column inside the transaction so
an operator ask queued after the first migrator committed is never spent as
legacy. The crash canary's review stage now also replays the automatic
producer over the interrupted attempt and proves it queues nothing before the
explicit retry.

**2026-09-11 — Plan-first and routed execution fail closed without getting
stuck.** A real Codex plan-first run now finishes: `codex exec resume` has no
`--sandbox` flag (0.145.0), so every structured correction and repair-by-
resume was an immediately doomed turn that exited before it initialized — the
resume now carries its sandbox as a configuration override (`-c
sandbox_mode=…`), keeps one exact thread identity across the root and its
corrections, and ingests a schema-valid plan; a resume the harness refuses by
its own protocol, or never comes up for, ends the attempt with its typed
reason (never a second resume of the doomed identity) and the retry after the
planning backoff is a fresh planner root in a fresh session. Run admission
dictates nothing any more: every routed planner, builder, scout, reviewer,
fallback, and repair run PRESENTS the exact authority it holds
(`routeAuthorityFor` puts it in the caller's hands), and a missing, forged,
stale, or inexact legacy stamp — a `legacy` stamp must name the very sealed
profile and its build pair; the bare word belongs to a task with no scope —
opens no row, in words that say what would have had to be presented. Chain
custody is proved and written in the run's own insert: base custody opens the
cycle with the row, a parked-resume takes the parked tail's custody through
the proven transfer (the tick now resumes a parked fallback entry as that
entry, under `fallback` provenance, never as the sealed build leg), a repair
inherits exactly its same-task parent's binding, a reviewer after a fallback
takes none, and a binding that cannot be proved rolls the insert back.
Fallback admission re-proves everything it is told against durable state —
the task, the live cycle, the approved chain, the index, the entry digest,
provider, model, auth mode, repair model, and `fallback` provenance — and a
mismatch creates no run and consumes no edge. Parsing is strict everywhere
authority is read: a model is an exact id, a repair model `inherit` or one, a
turn bound or clock a positive whole number, a run row's chain index and auth
mode read as no binding rather than the base entry or the subscription
credential, and a chain-bound tail whose auth mode does not read ends as an
ordinary end. One integrity projection (`routineIntegrity`) gates a standing
order's state word, its consent door, its approval, and its firing before any
mutation: an approval is live only when its frozen snapshot reads back,
hashes with the stored terms to the signed digest, states no leg problem, and
agrees with the sealed profile's build and repair pairs; a corrupt approved
snapshot is not live, `routine refresh` withdraws such an approval even when
the working agents are unchanged, and only the explicit reapproval fires
again. The v24 data pass no longer re-runs on every upgrade — the epoch
sentinel had made −47 read as "before v24" — so an authentic v47 database and
an interrupted −47 one upgrade without re-running older passes, changing ids,
backfilling a route, or approving anything, and then refresh → reapprove →
fire succeed. Consent stays closed where no yes could bind: the inbox row
reads *needs attention* instead of *review & approve* for an unreadable,
missing, or newly unsealed legacy route, the routine's recovery is one
labelled and described button with nothing to type, and the demo's seeded
transcript plumbing is gone. The evidence under
`evidence/explainable-risk-aware-phase-routing-v1/` is a real
subscription-backed chat on a scratch plane with a manifest beside the
1400×900 and 390×844 DPR-1 captures, plus the real Codex plan-first run's
report.

**2026-09-11 — Routing authority is closed at the row, the firing, and the
door.** A task filed under agent routing never opens an unstamped run: a
planner, builder, scout, reviewer, repair turn, or fallback that presents no
route provenance gets the stamp its governing authority dictates — the sealed
route's leg for its phase, the working route's plan leg before approval, the
bound fallback entry for a chain child — proved against the run's own
provider and model exactly as a presented stamp would be, or no row opens;
the chain binding of a repair or correction child rides its own insert, and
a fallback stamp is held to exactly the entry the cycle admits (two entries
sharing a provider and model under different auth modes or repair models are
different authorities; an ambiguous pair proves nothing). A run admitted
under a route the scope has since re-sealed away refuses to spend. Routine
firings re-hash the approved profile and four-role route against the
approval, hold the build and repair legs to the sealed profile's provider
and model, refuse a route with a stated problem or unreadable snapshot
bytes, and roll the whole firing back — no instance, no ledger row, no
advanced slot — unless the instance seals under the frozen route. An
authentic v47 routine survives the v48 upgrade with its data, fires nothing,
and has one plain road: `routine refresh` (CLI) or **Refresh agents** (page)
re-resolves the agents from today's configuration and approves nothing; the
operator reads the exact agents and approves again, and only that yes fires
the new snapshot. Malformed authority fails closed everywhere: model ids
that are not ids never rehydrate, stamp, or override; corrupt route,
profile, or chain JSON reads as unreadable on the seal (a chain seal also
requires its profile mirror to read and agree); a fallback configuration
row that cannot be read files the scope unresolved instead of quietly
sealing a single profile. Task, chat, and `/next` share one consent door —
an unreadable route, a route that cannot run, or a pre-routing row whose
approval lapsed mints no nonce and shows no password or approve button,
only the reason and the act that opens it; the seal primitive refuses a new
yes on a pre-routing row (`unrouted`), while an old approval on one stays
grandfathered; the routine page mints a nonce only for an approvable order.
Agent choices are role-specific — each role offers the agents configured
for it, repair follows the build provider, a current agent the
configuration no longer names is display-only — and the chat's chosen agent
is re-proved against those choices inside the authenticated edit
transaction, so a stale card mutates nothing. The elevated-risk sentence now
stays true under strict quality and screenshot proof; the chat summary is
said once per screen; suggestion chips step aside on phones while a card is
pending so the card and composer share one screen. The seeded demo
conversation is gone; the evidence under
`evidence/explainable-risk-aware-phase-routing-v1/` is a real
subscription-backed chat on a scratch plane — `get_agents` then
`propose_agents` from a typed message, the pending card with the composer,
the confirmed result, and the task page — at 1400×900 and 390×844, DPR 1.

**2026-09-11 — Routing authority is closed end to end, and chat can steer
it.** Run admission now proves a run's route stamp before any row exists: a
malformed stamp (unknown phase, provenance word, or provider; an empty digest;
a missing model), a phase that disagrees with the run's role, a provider or
model the run would not spend as, or provenance the task does not hold — a leg
the sealed route never named, a `fallback` with no approved chain entry behind
it, `legacy` on a routed row — opens nothing and says why; the late-stamp road
wears the same proof. A real approved non-primary fallback and its bounded
repair are proved end to end to keep the same exact agent, chain entry and
credential mode, route digest, and `fallback` provenance. Routines freeze their
agents: filing resolves an exact four-role route beside the profile and binds
both into the digest, approval seals the snapshot, and every firing copies it
onto the instance verbatim so a later configuration change cannot re-route a
firing; a routine approved before agents were frozen fires nothing and pages
once until approved again. Every approval surface — task page, focused chat,
and `/next` — restates one concise line of exact agents above the password,
with the declared risk explained in a plain sentence and runtime limits behind
a closed disclosure; changing any agent stales the approval every surface
signed under. The task page's controls offer only configured, role-valid agents
from a select (gemini never reviews, repairs stay on the build provider) and
explain every risk choice; command-line hints left the route's reasons for the
CLI's own output. Chat gained `get_agents` and `propose_agents`: it reads the
task's risk, agents, reasons, and configured choices, and proposes one
confirmation-gated change — a risk, one role to a listed agent, or a cleared
hand-pick — that lands through the same authenticated route edit when the
operator confirms the card. Schema v48 adds the routine's route columns and
the `agents` proposal kind by the usual additive and exact-rebuild roads. Fresh
1400×900 and 390×844 captures of the task and chat flows sit under
`evidence/explainable-risk-aware-phase-routing-v1/`.

**2026-09-11 — Which agent runs each phase is decided once, explained, and
sealed.** Every task now carries an explainable route: one pure policy
(`src/phase-routing.ts`) recommends the plan, build, repair, and review agents
from the declared risk (routine, elevated, high), the quality mode, what the
acceptance rubric demands, the repository's publication authority, and the
operator's configured routine and strong tiers (`config set <phase> --tier
strong …`; strength is never inferred from a model's name). Each leg says why
in plain English, whether it was recommended, overridden, or pinned, and what
its runners reported about the provider — ready, unavailable with the runner's
own words, or unknown, which is stated and never upgraded. Approvers declare
risk and override phases with attribution (`task route`, the task page); every
edit re-files the scope, so a sealed approval reads stale, while a global
configuration change can never rewrite a sealed route. Repairs stay on the
build provider. A provider a runner reports unavailable halts before any
claim or spend and is never substituted; only the explicitly approved fallback
chain may switch — an unavailable primary moves to the exact approved next
entry, only under a live paid-fallback grant. Dispatch, the reviewer, and
review requests bind to the sealed route; every leg, candidate, and override
is an exact provider and model id, and a configuration that cannot make one
files the scope unresolved in words. Each run is stamped with its route and
actual agent inside the admission transaction, set once; the sealed handoff
carries the same. Schema v47 is additive with a durable route era: rows proven
to predate routing keep their digest and are governed by their sealed profile
alone; a routed row whose route is missing or corrupt fails closed. The console
shows a compact plain-English Agents summary — who plans, builds, repairs, and
reviews — with reasons and change controls closed until asked for, and
availability kept beside the agents rather than inside the approval's terms.

**2026-09-10 — Planner and reviewer handoffs can correct their own shape
without rewriting the work.** Standing Orders first applies only conservative,
syntax-level normalization to a structured reply. If strict validation still
fails and the provider supplied a resumable session, it sends the exact
validation errors back through at most two same-session child runs. Corrections
may repair format or validation defects; they may not invent scope or acceptance
criteria. Every original and corrected reply remains as sealed
`structured-output` evidence on the run that authored it, including replies a
later provider-status or session-identity gate rejects. The planner
re-proves branch, HEAD, and tree after every reply; the reviewer re-verifies its
sealed scratch bundle under Claude's cwd-restricted, read-only review posture.
Provider JSONL framing remains byte-bounded; an event too large to retain becomes
an explicit receipt with its true byte count and bounded exact prefix instead of
disappearing as silence, and conflicting provider session identities fail
closed. Reviewer ingest additionally requires the source build's exact scope
digest and complete stored criterion matrix; a later scope cannot be applied
retroactively. Accepted correction children close atomically with the
plan/decision fence or review ingest and never count as delivered builds.
Provider, custody, identity, and tamper failures never enter this repair path,
and a missing resumable session fails closed instead of starting a new
conversation.

**2026-09-10 — Project checks can repair one missing-executable failure.**
`standing-orders verify set --self-heal` now previews the exact approved setup
and its digest; confirmation must repeat it with
`--setup-digest <shown> --yes`. When the first post-commit project check cannot
start because a required project executable is missing, Standing Orders may
run that setup once and retry the exact check once—never for an ordinary
failure, timeout, or executable that exists but cannot run. Recovery stops if
the setup or project check changes, setup fails, files change, the checkout
moves, unchanged files cannot be confirmed, custody is lost, or the executable
remains missing. The first check, setup run, and retry are redacted into one
hash-verified check log. A successful task says that approved setup ran before
the check passed; stopped paths give a concise reason, and the older criterion
repair UI now presents itself as **Automatic recovery** rather than exposing
the internal “repair chain” name.

**2026-09-10 — Review evidence is calm, plain, and progressively disclosed.**
The opaque *Proof disagrees* state is now *Conflicting evidence* everywhere;
incomplete results read *Missing evidence*, and manual sign-off reads
*Accepted with exception*. The selected result names the specific cause plainly
(including the important "required command wasn't available" case for exit
127), keeps raw checks, screenshots, requirement details, agent notes, and the
exception form behind deliberate disclosures, and removes the amber exception
CTA. Mobile presents the selected result before the queue. Desktop and 390px
browser checks have no horizontal overflow or console errors.

**2026-09-10 — Review cockpit, revised from five review annotations.** A
stable `?result=<task>` link now outlives the queue window: the ranked
queue stays bounded to the newest 100 completions and says so, and a link
to an older completion resolves directly — re-proved as done, in the open
project, and inside the ceiling — with a plain "opened directly" note, so
an old receipt never reads as unfinished or foreign. Signed-touch globs are
matched gitignore-style: `src/**` followed by `/*.ts` covers `src/a.ts` and
`src/nested/a.ts`, ending a false "outside the signed touches" warning.
The credential heuristic behind the changed-file order matches whole
delimited name pieces only (`auth.ts`, `api-token.ts`, `secrets.json`,
`.env.local`), so `author.ts`, `tokenizer.ts`, `permissions-ui.tsx`, and
`.envelope.ts` read as ordinary files. The cockpit's proof-state chip is
the completion receipt's own words and precedence — the stored verdict
decides, so a no-change run with a refuted proof reads "Conflicting evidence",
never "No change needed". Small duplicated sources of truth are gone: the
selected run is fetched once, annotation eligibility is one rule shared by
the form, file buttons, and picker script, the phone-width cockpit rules
live in one media block, and the projection's docblock sits on its helper.
Tests cover the cap, the direct resolve and its refusals, globstar cases,
positive and negative credential names, chip parity with the task page,
and empty-diff eligibility; the desktop and 390px captures were retaken.

**2026-09-10 — Completed work now has a review cockpit.** The `/review` view of
builds is no longer a PR-order list; it is a master/detail over every visible
completed task, ranked by a labeled review priority — refuted or unaccepted
proofs, reviewer contradictions, and observed CI failures first; manual
completions, legacy results, and criteria still waiting for a human next —
with a stable `?result=<task>` deep link and an honest note when the link
names something not in view. The selected result joins the approved goal,
boundary, touches, and plan approach to the stored criterion matrix and the
sealed diff: every changed-path citation anchors into that file's section of
the parsed patch, files outside non-empty signed touches are flagged, and the
changed-file list is ordered by its own explained priority while the sealed
patch beneath keeps its order and downloads byte for byte. Evidence is
labeled by source — the plane's re-run, the agent's checks, the independent
reviewer's judgements and findings, validated screenshots, caveats and
follow-ups, publication state and what the CI watcher actually saw — and each
absent or truncated source says so. One primary act is chosen from the state
and posts to the endpoint that already owns it (accept-proof, comment,
revise, draft-repair) or links to the comparison screen and the pull request;
the comment endpoint now honors exactly one validated cockpit return path.
The done archive and the result receipt link into the cockpit. Route and
pure-helper coverage proves admission before ranking, escaping, legacy and
manual completions, broken artifacts, every priority band and tie-break,
action eligibility with CSRF, and the bearer read-only view; desktop and
390px captures from the seeded demo are checked in under
`evidence/review-cockpit/`. No schema, agent stage, or authority was added.

**2026-09-10 — Interrupted agents keep their work instead of starting over.**
The recovery path now re-inspects every released worktree at lease time rather
than trusting an older “clean” database flag. If a runner or console disappears
after an agent has changed files, Standing Orders keeps that draft in place,
quarantines the old handoff, preserves a binary safety patch, and starts the
successor as a reviewer of the existing work—not a second builder from zero.
A completed draft and a partial draft are named separately in the new run's
lineage and operator-visible note. While an orphaned provider process is still
alive, its PID remains the worktree's occupancy fence so another agent cannot
enter the same checkout. Persistent macOS, Linux, and Windows services also
inherit the installer PATH, so subscription CLIs found during setup remain
available after terminal close or reboot. Recovery, occupancy, lineage, and
cross-platform daemon environment paths are covered by focused tests. macOS
upgrades also wait for an asynchronous `launchctl bootout` to actually remove
the old label before loading its replacement, preventing an install that
briefly looks healthy and then disappears. The
failure that prompted this work was recovered from its captured patch and the
successor passed the full suite and production build before committing it.

**2026-09-10 — Execution plans adapt safely while a build is running.** A
running build now checkpoints durable milestone state—pending, current,
completed, blocked—against the exact plan revision its brief named, in a new
append-only `run_checkpoint` table; older attempts with no checkpoint read
exactly as before. When repository evidence invalidates a named dependency,
risk, or implementation assumption, the builder files one bounded,
evidence-linked replacement plan through a new nonce-scoped proposal file
(atomic, one-shot, quarantined like park and proof) and pauses at a safe
checkpoint rather than committing over a false premise or grinding on. The
proposal settles through the same fenced-transaction discipline as every
other terminal outcome: a plan-only refinement inside the signed scope
appends an immutable revision to a new `plan_revision` ledger and the task
requeues on its own, no strike, no second approval. A revision that would
touch goal, out-of-scope, touches, acceptance, permissions, quality, budget,
or publication authority—checked by comparing the exact authority snapshot
the run started under against the current one—instead places a new
`revision`-owner hold (the same hold table every other pause already uses)
and stays paused until an operator accepts or rejects it from the task page
or focused chat, both of which render one shared projection so they can
never disagree. Every revision preserves its prior artifact hash, reason,
evidence link, author, and milestone history; a stale accept/reject or a
malformed proposal fails closed. No parallel workflow engine or mutable plan
store was added—the existing plan artifact, claim fencing, hold, and task
lifecycle machinery carry the whole feature, and a milestone claim is
labeled as the agent's own report, never fed into the proof contract's
adjudicated verdict.

**2026-09-10 — Repository planning is now a durable execution plan, not a
Markdown blob.** New planner handoffs must state a concise approach, ordered
milestones, dependencies, risks with mitigations, and proof that names every
signed acceptance criterion. Malformed or vague handoffs fail closed before a
scope is proposed. Task, focused-chat, and triage approval surfaces render the
same verified artifact as a structured, responsive plan card; historical
free-form artifacts retain a safe plain-text fallback. Before approval, an
operator can edit the plan in place with stale-revision protection. Browser
approval is now bound to the exact verified plan hash (and any race terms), so
another tab cannot approve a plan revision it did not show; after approval the
plan is locked and the builder receives that stable artifact. No second plan
store or workflow engine was added—the existing planner artifact remains the
single durable handoff.

**2026-09-10 — Unified chat now starts from an outcome, not an order form.**
The mate treats one plain-language request as enough to draft a task: it
infers the title, narrow goal, safe non-goals, acceptance criteria, and the
need for repository planning. It asks only when the answer changes the
result—an ambiguous project or outcome, or an irreversible/public/security/
data/migration/compatibility tradeoff—and groups at most three questions with
a recommended default instead of drip-feeding fields. “Use your judgment”
closes reversible questions and chooses the narrowest safe default. Task
proposal cards now say whether the project will be inspected first; confirming
a plan-first proposal starts the existing planner and says so instead of
incorrectly asking for immediate scope approval. The empty desktop and mobile
thread leads with “What do you want to get done?”, one outcome composer, and a
plain explanation of inferred defaults. On phones the empty composer stays in
the document flow so it cannot float above its own prompt. The new planning
choice is validated again at the confirmation door, defaults old proposals to
the existing automatic policy, and adds no authority or parallel intake state.

**2026-09-08 — Verified Done now starts with a result receipt and leads to a
real review surface.** A completed task presents one shared, scan-first card on its overview
and focused Ask view: the sealed handoff summary, proof level, acceptance pass
count, final diff size, validated screenshot thumbnails, caveats, and direct
roads to the full evidence or a revision conversation. Both surfaces project
the same immutable run artifacts and stored verdict; chat cannot rewrite the
result and no new state, agent role, or review stage was introduced. The card
collapses cleanly from three facts across on desktop to one thumb-friendly
column on phones. Route coverage proves that task and chat render the same
run, verdict, criteria, diff, screenshot, and caveat facts. The evidence page
now parses the sealed unified patch into folding file and hunk rows with honest
old/new line numbers, subtle add/delete treatment, and a raw-patch escape hatch.
View mode stays quiet by default; optional Annotate mode makes exact lines
selectable, prefills the existing feedback form, and shows the accumulated
batch before the operator deliberately creates one unapproved revision task.
The revision still inherits the approved scope and must be reviewed before a
builder can run, so the richer interface adds no new authority.

**2026-09-08 — Never Stuck's pre-Windows certification is closed; the physical
handoff is explicit.** Real logged-in Claude and Codex canaries now pass the
public workflow from repository planning through exact approval, build,
verified criterion matrix, and duplicate-dispatch refusal. Windows CI proves
the native Task Scheduler/link/dispatch baseline and `cmd.exe` execution seam
on Node 22 and 24. The only machine-dependent remainder is the documented
physical Windows canary, scheduled-worker close/reboot sequence, and teardown.
Automatic fallback remains separately fail-closed until a real exhausted
subscription terminal is captured and bound to its exact CLI version; normal
provider success is not misrepresented as exhaustion coverage.

**2026-09-08 — Adding a project now looks and acts like a primary action.**
The Projects page no longer renders its local-folder and GitHub choices as
tiny status badges. A stronger section heading now leads to two full action
tiles with drawn icons, plain-language supporting copy, hover/focus feedback,
and 80px desktop / 84px mobile targets. They sit side by side on a desk and
stack without clipping at 390px; exact-path entry remains the clearly tertiary
option. Route coverage, typecheck, production build, and real-browser desktop
and mobile checks passed.

**2026-09-08 — One machine service now manages every saved project.** The
project registry now stores both explicitly added Git repositories and the
project folders approved once with `standing-orders up --project-root <dir>`.
Later starts reconnect those projects from any working directory. While `up`
is running, opening a local repository or cloning one from GitHub enrolls it,
extends the current worker's repo binding through that worker's credential,
and starts its watch loop automatically—no restart and no repeated `--repo`.
The unified chat and project rail read the same live, proved set instead of a
startup snapshot. Registry polling is bounded local file I/O and works across
macOS, Linux, and Windows; invalid paths and paths outside the saved roots are
named and ignored rather than gaining authority. Targeted tests cover v1
registry migration, root preservation, authenticated binding, live console
updates, and adding a second real Git repository during one `up` process. A
real-browser pass added that second repo from the Projects page and verified it
in unified chat at desktop and 390px. Final verification: 104 files / 1,934
tests passed, 12 skipped; typecheck and production build passed.

**2026-09-08 — One product lifecycle, with recovery copy that matches the
actual state.** `standing-orders up` is now the only normal lifecycle exposed
to users: it opens the app, connects the project, and runs its builder. The
separate console, watch loop, and OS service remain available for advanced
split or remote deployments, but normal setup, CLI help, and operator-facing
screens no longer make people choose among that plumbing. Dispatch and UI copy
now distinguish **Builder not connected** (this project has never been attached
to a machine) from **Builder disconnected** (a known builder stopped checking
in). First-time recovery explains where to start Standing Orders; reconnection
explains that the task is already filed and approved, asks the person to reopen
Standing Orders on the project machine, and promises automatic resume. Inbox,
task, activity, and system-status surfaces use the same contextual language and
do not prescribe daemon installation during an ordinary task recovery. A real
browser pass exercised both states at 390px with no overflow or console errors.
Final verification: 104 files / 1,928 tests passed, 12 skipped; typecheck and
production build passed.

**2026-09-08 — Never Stuck now has one front door and a certified recovery
path.** Every actionable dispatch diagnosis on the task page and in a focused
chat now leads with **Get this task running**. The button is derived from the
same typed diagnosis used by the queue and atomic claim, then routes to the
nearest existing guarded repair: scope, approval, decision, hold, capability,
dependency, placement, retry, or worker setup. It grants no new authority and
does not duplicate any mutation path. When the only gate is an offline worker,
the task page explains the single foreground command, `standing-orders up`,
which registers the machine, starts the worker and console, and immediately
rechecks approved work; reboot-safe installation remains an explicit optional
follow-up. Desktop and 390px browser passes verified the task and focused-chat
flows without clipping.

The crash path is now an end-to-end Never Stuck certification rather than only
a lease unit test: a successor watch encounters a stale predecessor with an
open run and a still-live claim, recovers it before dispatch, executes exactly
one replacement build through the real Git path, captures a typed proof plus
terminal diff evidence, and reaches an attested terminal result. The test then
runs dispatch again and proves the queue is empty: two run records total (one
interrupted predecessor, one accepted successor), one completed claim
generation, and no duplicate execution. Final verification: 104 files / 1,928
tests passed, 12 skipped; typecheck and production build passed.

**2026-09-08 — Waiting-task recovery now speaks in outcomes, not graph
jargon.** The task page says which named task did not finish, then asks the
operator to choose what happens next: try failed work again, choose another
task that must finish first, or continue without it. “Replace blocker,”
“unlink,” and “dependency repair” no longer appear in operator-facing actions;
the inbox, board, and unified chat use the same plain-language status. While
this choice is open, unrelated plan, hold, scope, and duplicate waiting
controls are suppressed so the page has one clear decision. Chat repair cards
now use task titles and explain the result before confirmation. A real-browser
phone pass also exercised replacement end to end and verified that the next
state reads “Waiting for another task.”

**2026-09-08 — The task page now composes for phones instead of wrapping by
accident.** At phone widths, dependency repair has explicit full-width rows
and stacks its replacement picker before text or buttons can clip; the primary
task act owns the content width; the hold reason and act form a bounded row and
stack again on the narrowest screens. Dispatch copy, title metadata, and the
no-scope prompt are denser, while the long manual scope editor stays folded
when the repository planner is the recommended path. A real-browser pass at
320, 390, and 430 CSS pixels found no horizontal overflow across inbox, chat,
board, builds, menu, task intake, or the repaired task page.

**2026-09-08 — Never Stuck dependency repair is an action, not advice.** A
failed or cancelled prerequisite now renders an inline repair surface on the
dependent task: retry a failed blocker without dropping the edge, atomically
replace the edge with unfinished work, or explicitly stop waiting. Each act
re-proves the live edge and terminal state; replacement refuses cycles without
removing the old dependency, and every successful repair bumps the durable wake
sequence so an installed worker reconsiders the queue immediately. Unified chat
can draft the same three-way repair as a rich card, showing the exact blocker,
graph change, and consequence before the operator confirms it through the
existing authenticated proposal door. The model itself never silently removes
a prerequisite. Schema v42 adds the durable `repair` proposal kind with an
exact, row-preserving migration. Final verification: 103 files / 1,922 tests
passed, 12 skipped; typecheck and production build passed.

**2026-09-08 — Never Stuck P0+P1: one lifecycle contract, one dispatch
diagnosis, and the first real Windows gate.** `dispatch.ts` now owns the
typed read-side answer to “will this task run?”: four top-level conditions
(`running`, `retrying`, `waiting`, `terminal`) refined by stable reason codes,
an optional next wake, and the nearest repair. The atomic claim remains the
authority and now imports the same task-state, hold, dependency, live-mode
approval, and capability predicates, re-proving them under its write
transaction. Task detail, order queue, `ready`, `task show`, the path-free chat
brief, and mate task/queue tools consume that diagnosis; the board also names a
failed or cancelled blocker as **dependency needs repair**, never an ordinary
wait. A dedicated regression proves the cancelled dependency is refused at the
claim and shown identically on the task and queue. Quota status gained a
read-only observer, so rendering cannot consume the half-open probe. The
outbound chat document carries only stable dispatch vocabulary — never detail
that could contain a repo path, runner name, or human hold reason. The contract
and its non-goals are recorded in `docs/NEVER_STUCK.md`.

CI keeps the full macOS/Linux Node 22/24 matrix and adds a Windows Node 22/24
baseline: type-check, production build, Task Scheduler/link behavior, and the
core lifecycle contract. This is deliberately an honest baseline, not a false
full-parity claim; physical Task Scheduler plus real provider/worktree E2E is
the next bounded portability slice. Verified locally with type-check,
production build, the 35-test Windows-equivalent slice (12 platform skips), and
the full suite: 102 files / 1915 passed / 12 skipped.

**2026-09-08 — Run 1467's fix: a strict `--json-schema` for claude review
turns, and a bounded diagnostic for when one still slips through.** Run
1467 proved reviewer isolation end to end but Opus's reply came back as
JSON `parseReview` refused — a shape close but not exact, likely fenced
or prefaced prose around the object. `provider.ts`'s `claudeArgv` now
appends `--json-schema <schema>` to the review-phase invocation only
(claude-only, review-phase-only — no other provider has the flag, no
other phase asks for structured output): a formatting floor the CLI
itself enforces, never a validator — `parseReview` stays the exact
signed-ID gate, since only it holds the run's actual signed criteria.
`claudeEnvelopeOf` now prefers the turn's `structured_output` field
(present only under `--json-schema`) over the plain `result` string for
`finalMessage`, re-serialized rather than passed through raw — the same
preference `subscription-chat.ts`'s own `--json-schema` turn already
applies. Second half: a malformed-review failure that still occurs now
persists a bounded, sanitized parse diagnostic (`safeDiagnostic`,
exported from `provider.ts` — the same control-char strip, secret scan,
and byte cap every other provider diagnostic gets) into the run's
stored reason and the request's `consumed_reason`, so a future failure
explains itself — the structural problem list plus a best-effort excerpt
of what the agent actually said — without needing a live repro. Every
other failure reason (`dirty-scratch`, `timeout`, …) is unchanged byte
for byte. New regressions: `provider.test.ts` proves the schema rides
only claude+review and the `structured_output` preference (with and
without the field, and a null field falling back); `reviewer.test.ts`
proves the persisted diagnostic's shape and bound, that a secret-shaped
spoken reply is withheld rather than quoted, and that a
`structured_output` reply ingests exactly like a plain one. Suite 100
files / 1902 tests (12 skipped).

**2026-09-08 — Run 1464's fix: reviewer isolation — no MCP servers, no
tool but reading, and no mailbox to hang on.** Run 1464 no-op'd after 8
minutes and, per the operator's own read of it, loaded global MCP servers
despite running under `--permission-mode plan`. Root cause: the review
phase's claude invocation carried no MCP or prompt isolation at all —
`--permission-mode plan` governs edits, not an MCP server's own tools or
an interactive approval prompt, so a headless `-p` turn that goes looking
for either just sits idle until the timeout kills it, having spent money
on nothing. `provider.ts`'s `claudeArgv` now appends a dedicated
`CLAUDE_REVIEW_ISOLATION_ARGV` for `phase === "review"` only (`--safe-mode
--no-session-persistence --tools Read --permission-prompts none
--strict-mcp-config --mcp-config '{"mcpServers":{}}'`) — the same flag
family `subscription-chat.ts` already uses for its own sealed turn. Since
a write tool was the other half of the leak surface (a reviewer needs
none — see below), codex gets its own fail-closed equivalent
(`CODEX_REVIEW_ISOLATION_ARGV`): `--sandbox read-only` in place of the
`workspace-write` a codex-routed reviewer was silently handed before this
fix, `approval_policy="never"` and friends so a prompt refuses rather
than hangs, and `--ignore-user-config` so the operator's own
`~/.codex/config.toml` (which can name arbitrary MCP servers) never
loads. Gemini has no such isolation flag in this codebase yet — its own
`.gemini/settings.json` loads hooks and MCP unconditionally, a leak
DESIGN.md already tracks as a follow-up — so rather than pose as confined
without being so, `resolvePhaseAgent` (`agentconfig.ts`) now refuses
gemini for the review phase outright, however it was resolved (pinned,
flagged, or configured); build and plan are untouched.

**The other half: the reviewer no longer writes anything, ever.** The
mailbox-file protocol (`STANDING-ORDERS-REVIEW-<nonce>.json`, written by
the agent into its scratch directory) needed a write tool, which is
exactly the permission surface the isolation above closes off for good
reason — a reviewer that can write is not the reviewer this slice
promised. The reviewer's answer now rides the provider's own final
message (`AgentOutcome.finalMessage`, already captured by every
adapter's parser) instead: `reviewerBrief` asks for the JSON as the
agent's literal last word, `review()` reads `result.finalMessage` in
place of `readMailbox`, and the scratch-hygiene scan — unchanged in
spirit — now treats ANY file the agent adds as foreign, the old mailbox
name included. `reviewFileName()` (evidence.ts) is gone; the
`STANDING-ORDERS-REVIEW-` naming pattern stays recognized by the general
protocol-file sweep only as a legacy cleanup target. `reviewer.test.ts`'s
~30 stubbed-agent fixtures were rewritten off the old
regex-the-prompt-for-a-filename convention onto a `spoken(payload)`
helper that encodes the review straight into the stubbed process's
stdout envelope; two new regression tests assert a normal review writes
nothing to the scratch at all, and that an agent reverting to the old
mailbox habit is read as dirty scratch, never as an answer. New argv
regressions in `provider.test.ts` (claude and codex review isolation,
each proven absent on `build`) and `agentconfig.test.ts` (gemini refused
for review via config, flag, and pin alike). Suite 100 files / 1906
tests (12 skipped).

**2026-09-08 — Run 1462's fix: the brief tells the builder to default to
exactly the signed criteria and states the evidence-array cap.** Run 1462's
code was fine, but its proof was refused wholesale: an extra (unsigned)
criterion carried 5 evidence entries against `PROOF_LIMITS.evidencePerCriterion`
(4), and because a proof is accepted or refused as one payload, the 8
signed criteria — all otherwise answerable — were never checked. The brief
in `src/builder.ts` (`brief()`) never named that cap at all, unlike the
"how" and caveat byte caps it already spells out. It now tells the agent to
default to exactly the signed criteria and add an extra one only when
genuinely worth recording, since an extra is judged by the same rules and
cannot rescue a signed criterion's failure; states the 4-entry evidence cap
explicitly, next to the existing "how"/caveat cap language; and says every
evidence ref must exactly match its source (a check command from `checks`,
a path from `changed`, or a path from `screenshots`). New regression in
`src/builder.test.ts` signs a one-criterion rubric and asserts the brief
carries all of this. Suite 100 files / 1901 tests.

**2026-09-08 — Run 1461's fix: a resumed builder attempt seals the
cumulative terminal diff, pinned to its branch's first base.** A branch
is reused across attempts — a strike retry, a warm-cold resume, an
operator re-dispatch after a `short` verdict — and every attempt after
the first read `base_revision` as wherever the PRIOR attempt's HEAD
landed, correct for the HEAD-immutability fence but wrong for evidence:
the terminal diff/diff-stat `captureTerminalDiff` sealed ran only from
that incremental slice, so the unchanged whole-task rubric could no
longer honestly cite paths an earlier attempt already committed —
`adjudicate`'s changed-path check would refuse them as absent from the
sealed diff. `store.firstBuilderBase(taskRef, branch)` finds the
EARLIEST builder run's `base_revision` for a task's branch; `builder.ts`
now seals both the no-change and completed terminal diffs from that
pinned base rather than the attempt's own, falling back to the attempt's
own base when no earlier row exists — a first attempt is byte-identical
to before. New regression in `src/builder.test.ts` drives two attempts
on one branch and asserts the second's sealed diff-stat reads
base→head as the FIRST attempt's base through the SECOND attempt's
head, never the incremental slice, while the first attempt's own diff is
untouched. Suite 100 files / 1900 tests.

**2026-09-08 — Evidence review v1, audit hardening: full ID coverage, the
check log and screenshots actually materialized, and one atomic ingest.**
Still schema v40 (purely additive columns on the still-unreleased
`criterion_review` table), `src/reviewer.ts` + `src/store.ts`. Three gaps
an audit of the slice above found, all closed together. (1)
`parseReview` validated every SUBMITTED judgement against the signed
rubric but never checked the rubric was fully ANSWERED — a reviewer that
wrote no `criteria` at all against a rubric-bearing run, or covered only
some of its ids, still landed its comments and the run read "reviewed".
Full coverage is now required whenever `approvedCriteriaIds` is
non-empty: a missing id refuses the WHOLE payload, the same wholesale law
an unsigned or duplicate id already triggers. A task with no signed
rubric is untouched — grandfathering holds exactly as before. (2) The
scratch only ever held the diff, the rubric, and the re-serialized proof
— a criterion citing `check` or `screenshot` evidence was judged from the
proof's bare claim about them, never the actual verification output or
image bytes, both of which the plane already captures and stores as
first-class artifacts (`check-log`, `screenshot`). The pass now
materializes both, sealed and tamper-checked the identical way the
rubric and proof already are — binary-safe, since a screenshot is not
UTF-8 — and named in the brief so the reviewer knows to actually open
them rather than trust the claim. Absent either (nothing configured, no
screenshots claimed) writes neither file: an omission, never a
fabrication. (3) `criterion_review` rows bound only the diff, and
comments landed through a separate `transact()` call from judgements — a
crash between the two could leave one without the other, and nothing
recorded whether the scope, head, proof, or check log the reviewer was
actually shown still matched anything by the time judgements landed.
`criterion_review` gains `scope_digest`, `head_sha`, `proof_artifact`/
`proof_sha`, `check_log_artifact`/`check_log_sha`, and
`screenshots_json` — every one RE-VALIDATED against the live store at
ingest, never trusted from the caller, inside the SAME transaction a new
`store.ingestReview` uses to land comments and judgements together (it
wraps the existing `addReviewerComments`/`ingestCriterionReviews`, which
stay reentrant-safe for direct callers). A mismatch — a scope revised, an
artifact's stored hash no longer matching what materialization read —
throws, `review()` converts that to a typed `stale-evidence` failure, and
the whole ingest rolls back: neither the comments nor the judgements
land. New tests cover all four angles the fix needed: omission (no check
log or screenshot exists), tamper (either forged in the scratch),
staleness (a proof artifact or the scope itself changed mid-review), and
rollback (a stale ingest leaves zero rows, not a partial one). `src/
demo.ts`'s reviewed+repaired scenario now seeds through the same
`ingestReview` call `reviewPass` itself makes, bindings included. Suite
100 files / 1897 tests.

**2026-09-07 — Evidence review v1: an independent reviewer judges the
signed rubric by exact id, and a bounded repair loop drafts one unmet-
criteria fix.** Schema v40, closes Priority 2's remaining gap ("the
evidence is well-formed" vs. "the outcome was delivered") and Priority 1's
"fails with a repair path" for the commonest nameable failure: a criterion
the plane can see is unmet. Two halves, both extending machinery that
already existed rather than adding a second agent invocation or a second
review mechanism.

**Half 1 (the reviewer).** The existing v29 review pass (`reviewPass`,
still at most once per source run) now also materializes `REVIEW-
RUBRIC.json` and a re-serialized `REVIEW-PROOF.json` beside `REVIEW-
DIFF.patch` — sealed the same way the patch always has (write-time hash,
re-checked after the agent runs; a tampered rubric or proof ingests
nothing) — and only when the run actually signed a rubric, so a
grandfathered run's scratch is byte-identical to before. The mailbox gains
an optional `criteria` array (`{ id, judgement, note }`); `parseReview`
folds it into the SAME wholesale law its `comments` array already
enforces — an id absent from the rubric, a duplicate, an unknown
judgement word, or an oversize note refuses the entire payload, not just
the offending entry. `src/proof.ts` gains `foldReview`, a pure fold with
exactly three rules and no fourth: `contradicts` → `refuted` (the row
becomes `failed`, the reviewer's note attributed in `detail`);
`cannot-tell` changes nothing (recorded, never moves the verdict — the
codebase's own maxim, "we could not check" is not "the claim is false",
now literally true for a second reader too); `upholds` never upgrades (a
`short` run stays `short` — the law that stops a second model laundering
a bad proof). `CriterionMatrixRow` gains `review: {judgement, note,
author} | null`; `proof_verdict` gains nullable `machine_verdict`, the
pre-fold verdict, so a render can say "the machine attested it;
reviewer:codex contradicted c2" instead of pretending the two never
differed. The store's `ingestCriterionReviews` folds and re-saves inside
ONE proving transaction — the same D8 invariants `addReviewerComments`
already checks (reviewer role, exact parentage, shared task, artifact
binding), extended to the judgements.

**Half 2 (the bounded repair loop).** `maybeTriggerRepair` (`src/
dispose.ts`) fires the instant a review pass folds a `short`/`refuted`
verdict naming at least one `missing`/`failed` criterion, and composes AT
MOST ONE durable revision draft through `sealRevision`'s own machinery
(`store.openRepairDraft`, `commentIds: null` — the CI-repair road,
reused) — the signed rubric copied verbatim, a `revision-brief` artifact
naming exactly the unmet ids, their matrix detail, and the reviewer's own
contradiction notes, no log content, no new instructions. Never repairs a
scout task, a published or merge-blocked run, a task with an open
decision or pending steering note, or an already-accepted proof. Four
independent stops, each its own test: the INTEGRITY stop (an altered
signed statement or an overclaimed changed path is a lie about the terms,
not a gap — `repair-refused-integrity`, parked for a human, unconditional
on both roads) fires first; NO-PROGRESS (two consecutive attempts that
fail to strictly shrink the unresolved set — `repair-no-progress`, also
unconditional) fires next; the ATTEMPT CAP (`repair-attempts-spent`)
bounds only the automatic road, since the default road's loop is already
bounded by requiring a fresh human "yes" per attempt; the fourth — the
existing spend and run rails — is simply the ordinary tick's own job once
a mode-approved draft dispatches as a normal builder run. `ModeTerms`
gains `repairAuto: boolean` and `repairMaxAttempts: number` (0..3) — the
`allowPaidFallback` precedent verbatim: both presets ship it off, legacy
JSON rehydrates to false/0, never inherited, only freshly signed. A chain
closes ("resolved") the instant any of its own attempts reaches
`verified`/`attested` — checked at the ordinary builder save point
(`maybeSettleRepairChain`), since `foldReview`'s monotonicity means a
review can never produce those verdicts itself. `standing-orders task
repair <run-id> [--yes]` is the first CLI road to a revision at all.

**A latent bug the reviewer role's own runs exposed, fixed alongside**:
four call sites (`src/serve.ts` task page and accept-proof, `src/
operate.ts` `task show` and `task accept`) and two SQL queries (chat
snapshot, `listCompletedWorkScoped`) picked "the latest finished run" by
id/timestamp alone, with no role filter — a reviewer run, finishing after
the build it reviews, could silently hijack the task's own completion
card with its own contentless `no-change` outcome. Never manifested until
a reviewed task's page was actually rendered end to end (this slice's own
demo scenario was the first to do it); now excluded everywhere by
`role != "reviewer"` / `role !== "reviewer"`.

`src/demo.ts` gains a sixth seeded task (`guard-payout-limiter`) built
entirely through the real functions — `adjudicate`, `addReviewerComments`
+ `ingestCriterionReviews` (the exact fold `reviewPass` performs), and
`maybeTriggerRepair` — showing a refuted proof, a contradicted criterion
badge, and an unapproved repair chain card live in a fresh sandbox.
Contract: `proof.test.ts`, `acceptance-contract.test.ts`, `scope.test.ts`
still pass byte for byte unmodified except the one matrix literal that
gained the new `review: null` field — the grandfathering promise holds.
New: `src/repair-loop.test.ts` (the four stops, the happy path, the
never-repair conditions), and `unattended.test.ts` (the idle-spend
invariant: an unapproved draft dispatches nothing; approving it is not
itself a spend; the next tick spends exactly one dispatch). Suite 100
files / 1887 tests.

**2026-09-08 — Acceptance Contract v2, three review findings closed: a
global diff check, a manual-review gate, and answered evidence on the
matrix.** Still schema v39, `src/proof.ts`. (1) The changed-path exactness
rule from the entry below was, in fact, only enforced INSIDE a
criterion that itself required `changed-path` evidence — a rubric of
pure `check`/`screenshot`/`manual-review` criteria let an untruthful or
incomplete `changed[]` through unchecked. `adjudicate` now runs the
exact-equality check GLOBALLY, ahead of the rubric rules: an
unavailable or truncated diff-stat is `short` (never silently skipped),
an overclaimed path (claimed, not in the sealed diff) is `refuted` — a
lie about presence — and an underclaimed one (in the diff, never
claimed) is `short` — a gap, not a lie. (2) A `manual-review` row
resolved unconditionally before, capping nothing — a rubric with a
verify command configured and green could read `verified` despite a
criterion nobody had actually looked at. `manual-review` now folds into
the same "unresolved" bucket as `missing`/`failed`: it holds the build
at `short` until an operator uses the SAME accept-anyway act a
short/refuted proof already offers (`proof_acceptance`, unchanged) —
no new verdict, no new mechanism. (3) `CriterionMatrixRow` gains
`answered`: the proof's own typed evidence refs for that criterion, not
only the signed required kinds, persisted in `matrix_json` for free
(additive on an already-additive column) and rendered on the task and
run pages — linked to the underlying artifact (`evidenceLinksFor` in
`src/serve.ts`) when a screenshot, check-log, or terminal-diff artifact
resolves the ref, plain text otherwise. `src/demo.ts` gains a fifth
seeded task (`confirm-empty-state-copy`) whose only criterion requires
`manual-review` evidence, so a fresh sandbox shows finding (2) fixed
live — "needs verification", not "verified", with the accept-anyway
form. Contract: `proof.test.ts`, `scope.test.ts`, `builder.test.ts`,
`stale-approval.test.ts` still pass byte for byte unmodified — none of
this touches the digest or the grandfathering path, only what
`adjudicate` does with a rubric already signed. Refreshed the desktop
and mobile demo screenshots to show both fixes live. Suite 99 files /
1825 tests.

**2026-09-07 — Acceptance Contract v2: the rubric a build is judged
against is signed before the build starts, not authored by the build
after it sees what it did.** Priority 2's second slice, schema v39.
`src/scope.ts`: `AcceptanceCriterion` (`id`, `statement`, advisory `how`,
signed `evidence` kinds drawn from `check`/`screenshot`/`changed-path`/
`manual-review`) and a 422 parser (`parseAcceptanceCriteria`) shared by
every authoring surface; `digestOf` folds the canonicalized rubric in
only when non-empty — sorted by id, `how` dropped — the same
absent-equals-empty rule `budgetMicrousd` set in v15, so a scope proposed
before this migration digests to the exact bytes it always has. The
rubric is mandatory, but not through the digest or the primitive: `propose`
stays permissive (existing fixtures, routines, and internal callers are
untouched); every ROAD that produces a scope now refuses an empty one —
`proposeGuarded` (the task editor, mate scope rewrites), `store.createConsoleTask`
(the door every filing surface funnels through: new-task forms, chat,
templates, intake, coordinator filings), `validateRoutineTerms` (routine
creation — a firing copies the template's rubric forward, never
re-authors one), and `parsePlan` (the planner drafts one alongside goal
and touches, required like every other contract field). `src/builder.ts`:
the brief quotes the signed rubric verbatim inside the fenced scope block,
and the proof instructions ask for typed evidence references — `checks`'
command, `screenshots`' path, or a `changed` path, by exact criterion id —
instead of a self-declared claim alone. `src/proof.ts`: `adjudicate` gains
`approvedCriteria` (empty runs the v1 rules byte for byte — the
grandfathering promise, golden-tested) and a `criterionMatrix` computed
once alongside the verdict: an unanswered criterion or an evidence
reference that does not resolve reads `short`; a proof that restates a
signed statement reads `refuted`, the same severity as any other altered
term; `changed-path` evidence now requires the proof's claimed paths to
equal the sealed diff exactly (both directions, not the v1 subset check),
and an unavailable or truncated diff cannot satisfy it. `src/evidence.ts`:
`imageDimensions` reads PNG IHDR and JPEG SOF headers directly (never
decoding, never trusting a claim) — screenshot evidence needs a real file
of at least 1024 bytes and 320×200 pixels or it cannot verify. The matrix
(`pass`/`missing`/`failed`/`manual-review` per criterion) is computed once,
stored beside the verdict (`proof_verdict.matrix_json`), and rendered by
one shared function on the task page, the run page's evidence bundle,
`/done`, `/runs`, the board's unverified-done card, the inbox, and
`task show`. The rubric itself renders above the approval seal on both
ceremony surfaces and the read-only scope card — restated text, never a
second amber action. Suite 99 files / 1810 tests.

**2026-09-07 — Verified done: a typed proof, adjudicated against the
plane's own evidence, replaces presence-only "complete with evidence."**
Priority 2's first slice. `src/proof.ts` (new): a scout-report-shaped 422
parser for the build's optional proof manifest — up to 12 acceptance
criteria, 12 checks with exit codes, 64 changed paths, 8 caveats, 8
screenshots — and `adjudicate()`, a pure ordered-rules function computing
one closed verdict (`verified` | `attested` | `short` | `refuted`) from
the proof plus the machine's own captures, never re-run at render.
`src/evidence.ts`: the `STANDING-ORDERS-PROOF-` protocol prefix, PNG/JPEG
signature sniffing (never a claimed extension), and a verified per-run
proof reader. Schema v38: `artifact.kind` and `incident.kind` widen by
exact recognizers (from either the v17/v7 or v34 predecessor shape — the
first exact-recognizer chain two generations deep, so an earlier
generation's rebuild also had to learn its OWN table's later shape is a
done state, the same way `rebuildRunForV29` already tolerated `V34_RUN_DDL`);
new `verify_command` table (an operator-approved per-repository shell
command, cloned from `worktree_setup`'s ceremony exactly: digest, restated
terms, `--yes`); `proof_verdict` and `proof_acceptance`, one row per run.
`src/builder.ts`: after commit and the terminal-diff capture, the builder
reads the agent's optional proof, validates every claimed screenshot
against the worktree's actual bytes, re-runs the repository's approved
verify command under the same allowlisted environment as setup, and
saves the verdict — all inside a phase (`verifying-proof`) and a
try/catch that can never turn an already-committed attempt into a
failure. A malformed proof is preserved as evidence and raises a
`malformed-proof` incident; a missing one simply reads unverified. Every
surface speaks `proof.ts`'s own words: the task page's dispatch status
(four `data-dispatch-status` tokens), a new evidence-bundle card on the
run page (criteria, the agent's declared checks, the plane's own re-run
labeled "re-run here", caveats, screenshot thumbnails linking to the full
image), `/done`, `/runs`, and the board — whose done lane now excludes,
and whose attention lane gains, a completed task with an unaccepted
short or refuted verdict (`board.ts`'s `attentionCardForUnverifiedDone`,
kept a pure sibling of `classify()` rather than forced through its
non-done precedence chain). `POST /t/<id>/accept-proof` and
`standing-orders task accept` record an operator's explicit acceptance;
`standing-orders verify [show|set|clear]` is `setup`'s ceremony under a
new name. `standing-orders demo` seeds a fully "verified" bundle,
screenshot included, so a fresh install sees the feature's honest
ceiling on the first look. Suite 97 files / 1781 tests (1769 run, 12
skipped).

**2026-09-06 — Membership-backed unified chat has no dollar maximum.**
Chat now accepts `codex-subscription` and `claude-subscription`, reusing the
local CLI's cached login instead of requiring an API key. The setup screen
defaults to Codex membership and `default`; weekly and session dollar fields
disappear for either membership provider, while the daily-turn and expiry
rails remain. Direct Anthropic and OpenRouter API modes retain their pinned
prices, pre-dispatch reservations, and mandatory ceilings. Each membership
turn runs the harness in a deleted temporary directory with repository tools,
web, apps, MCP, and ambient credential variables disabled; its structured
tool-call envelope still passes through the mate's proposal-only doors. Schema
v35 widens the two exact provider CHECKs without losing prior config or turn
rows.

**2026-09-06 — Chat becomes the unified project workspace.** The mate's
existing cross-project thread, proposal cards, confirmation doors, and
spend envelope now sit beside one bounded pulse per admitted project:
needs-you, live, queued, and finished-today counts, with direct roads to
ask about that project or open its board. Empty conversations offer three
real `/chat` prompts (attention, live work, and queue order), the screen's
scope truth is now always “all projects,” and the layout collapses to one
column below 900px. No authority changed: prompt chips are ordinary
spend-authorized mate turns and project navigation still uses the existing
CSRF-protected POST switch.
The browser pass also closed two integration gaps: multi-project chat is
exempt from the open-project redirect, and the minimal heartbeat on a
sensitive chat setup page now receives its required same-origin CSP door.

**2026-09-03 — The reduction pass, improvements 1 and 3 by hand: four
rows and a more group, one accent in two places.** The Mobbin study
(Linear web and mobile, Vercel, Railway, Supabase, GitHub) settled both.
The rail is `inbox · board · builds · projects` with `+ new task`, then a
dim **more** group drawn from ONE list (`moreRows`) that `/menu` draws
too, so desk and phone never disagree; the phone tab bar is the same four
and more, and its inbox tab wears a dot, not a number. The queue is the
board's order view: `GET /queue` answers 303 to `/board?view=order` (the
fragment the view polls still serves; every `/queue/move` and
`/queue/note` return lands there; the `g q` shortcut and the palette
follow); done, review, and activity are views on the builds screen, with
a strip under each `<h1>` and the builds row lit. The scope bar's second
"switch project →" road and the pill's "manage projects →" row are gone —
the pill is the switcher, and the projects row/tab is the one road to
`/projects`. Amber now lives on exactly two kinds of thing: the needs-you
count (rail badge, tab dot, lane-header dot, pill count, portfolio
metric, workspace bar segment) and the act that resolves a screen (the
approve button); decide cards, the ceremony frame, attention lane cards,
hot workspace cards, the seal, the parked chip, the mate's own bubbles,
and the picked answer are neutral. The queue's explainer disclosure went
with the page (§2, in part). Tests: the reduction-pass describe pins the
rail's four hrefs in order, the foot's rows, the five tabs and the dot,
`/menu`'s rows, the 303, the builds strip on all four views, and — from
the served stylesheet — the exact set of selectors that may name
`var(--brand)`. `docs/DESIGN-SYSTEM.md` §1 and §3 and the console guide
say the new rule. Not touched: §2 (helper prose) beyond the queue page,
§4–§7. Suite 92 files / 1668 tests.

**2026-09-02 — The mate v4: scout tasks, and Telegram digests; one
review round, twelve findings closed.** Spec `docs/mate-arc.md` §10, no
rule changes. `e7e480c`: `task_ref.deliverable` (v34, set at filing by
`task add --report`, the console's scout checkbox, `propose_task
{report: true}`, `file_proposal {deliverable: "report"}`), the scout
run (`run.role = 'scout'`) on the planner's read-only road with the
clean-tree proof before any payload is read, `STANDING-ORDERS-REPORT-`
parsed with the 422 rule into ONE verified `report` artifact, the task
done and `report-ready` routine, the builder's failure discipline plus a
`malformed-report` incident, the report on the task page with one-tap
follow-ups (`proposed_via = 'scout'`, never mode-sealed), `task show`,
the ledger, `get_task` (evidence root threaded through the mate and
gateway contexts), the board; `telegram_digest` with `bridge telegram
digest --every|--off`, the settings card, `claimDeliveries(only)` —
decisions and attention-class facts page singly, routine rows are held
unclaimed and go out as one digest. Schema v34: an exact run
recognizer with the v30 columns inline. Codex found twelve (eight
high), all closed in `9d08c8b`: capture failure is a failed attempt, the
deliverable rides the filing's transaction, scout checkouts are per
attempt and discarded, the tree proof sees ignored and staged writes
(shared with the planner), the digest finalizes in one transaction,
gaps and failed publications are attention-class, artifact and incident
widen by exact recognizers, credential shapes are redacted from every
report field, both ceremonies say the yes buys a report, follow-ups are
idempotent, caps are bytes, a malformed park is a `malformed-decision`.
Suite 1651.

**2026-09-02 — The mate v3: suggested answers, and proposals over the
MCP gateway; one review round, ten findings closed.** Spec
`docs/mate-arc.md` §9, two rule changes stated: the mate (and a
coordinator) may read a decision's consequences through `get_decision` —
never the recap or the builder's recommendation — and may then
`propose_answer`; coordinators gain the seven propose tools over the
gateway. `6af6f18`: schema v33 (`answer` joins `mate_proposal` by an exact
copy-rename; `coordinator_proposal`), `src/coordinator-proposals.ts`
(token re-authenticated inside the transaction, the hourly window shared
with filing, at most 20 pending per credential, seven-day expiry, expiry
on revoke), the shared executor behind both confirm doors, the answer
card (question, every option WITH its consequence, the builder's
recommendation beside the proposer's pick; an irreversible option
confirms only with the existing `confirm=yes` field — a checkbox, `confirm
N yes`, `--yes`), coordinator cards on `/chat` and the task page with
`POST /proposals/:id/confirm|dismiss`, and `standing-orders proposals`.
Codex found ten (four high), all closed in the commit after: the executor
private and self-proving, the window shared both ways, seven days at the
door, the answer's full context printed in both terminals before any
confirm, `duplicate` as `already-answered`, reading proved (get_decision in
an earlier step or earlier on the connection), "open" derived from the
deadline, union and array arguments parsed at the protocol layer, an
exact v33 recognizer with a migration test, backslashes refused in
`return`. Suite 1627.

**2026-09-02 — The mate lands: one conversation across every project,
from the console and the terminal, four slices, three review rounds,
forty-one findings closed.** Spec `docs/mate-arc.md` (v2 after a
fifteen-finding Codex round on v1). Slice 1 (`749d328`): the branded
`VerifiedApprover` (`src/principal.ts`), schema v32 (`mate_session`,
`mate_thread`, `mate_message`, `mate_proposal`, `mate_turn`;
`chat_turn.kind/mate_turn`; `task_scope.proposed_via` with the mode seal
refusing a mate-written scope in the primitive), the tool-capable wrapper
parser and the triangular worst-case reservation (`src/converse.ts`), the
tools — six reads and seven propose_* that write rows, never acts
(`src/mate-tools.ts`) — the versioned contract, and `runMateTurn`: one
reservation for the whole loop, one `chat_turn` step per request, eight
steps, tools in-process under the brand, only operator and assistant text
kept. Codex round 2 found fourteen (three critical), all closed
(`c90b938`): unknown cost charges the whole reservation; admission binds
approver, session, thread, and credential; the brand is runtime;
`mateView` scrubs every string; usage is typed integers within the
allowance; the latch is re-checked per step; settle/promote/append is one
write. Slice 2 (`bb878e1`): `src/mate-doors.ts` — the confirm door, one
transaction through the plane's own primitives with the CAS material each
card carries — and `/chat` as the thread while a mate session is live:
the mint card (the one password ceremony), a password-free composer,
proposal cards that confirm or dismiss, cancel cards that only point.
Slice 3 (`bf9fa8a`, `5fde8af`): `standing-orders chat` — the same thread
and doors from a REPL, `--say` for one turn, `--json` per turn. Slice 4
(`b2f4420`): `recapOver`/`decisionsOver`/`queueOver` shared with the MCP
gateway, which gains `recap`, `list_decisions`, `queue` for coordinators
(paths, never consequences). Codex round 3 over slices 2–4 found twelve
(five high), all closed (this commit's predecessor): a card dies with its
session, standing re-proved inside the transaction, the ordered ceiling
digest, stable REPL ordinals, the enrolled registry as the CLI's default
ceiling, the place in the CAS, minting fences in-flight turns, `since`
defined, key mismatch said in words. Deferred as recorded: propose_answer,
proposals over the MCP gateway, scout tasks, Telegram digests. Suite 1615
(one load-order flake in operate.test's `next refuses`, passes alone).

**2026-09-01 — Portfolio arc lands: three slices, two review rounds,
nine findings closed.** Spec v5 (`docs/portfolio-arc.md`) executed as
three commits. Slice 1a (`3772303`): nav regroup (inbox · portfolio ·
work · builds · fleet · more), the scope bar owning the one `/projects`
link per breakpoint, the portfolio overview with its one new read-only
query `portfolioLedgerScoped` (admission before LIMIT, `visible()`
recheck), and the shared decision-answer partial with its inline
enhancement — the survival test runs the shipped script in a DOM
(`8cfcd0a`); Codex review closed six findings (`4cf9e82`). Slice 1b
(`507094f`): the no-script move-to-front sentinel resolved server-side
against a fresh snapshot (own column only; a taken or vanished card is
the typed 409; already-front no-ops only after an explicit revision
check), typed text/plain refusals inlined on the card via textContent,
column headers naming "N building in this project · unattended capacity
M" and never a ratio. Slice 1c (`243f165`): the active attempt panel
named by build number and worker, polling the RUN's own peek/transcript
fragments; the sensitive-page composition guard decided from the
rendered body (no poller, static line, link-only decisions); the rail —
answer cards, the sealed approved scope, economics measured-or-
unmeasured on both rows, "publishes as" from `publicationGrantFor` with
push, PR, and merge phrased independently; "hold next attempt"; retry
words honest under a live claim. Codex review after commit 3 found three
(login page into the queue region on the post-move refetch; unreported
tokens summed as zero; the retry sentence twice), all closed
(`bf361ea`). Recorded deferrals stand: all-projects builds view,
cross-project gap fan-out, queue money metadata. Suite 1558.

**2026-08-30 — MCP gateway arc CLOSES: round-4 verify = GO.** All six
round-3 closures confirmed with independent gateway probes, no new
findings. The full arc: spec approved after six Codex rounds, eight
implementation commits, then four review rounds — ten findings, five
areas, six wire gaps, clean GO. `standing-orders coordinator mint`
issues the credential; `standing-orders mcp --token-file` serves the
gateway; everything a coordinator files stays quarantined until the
operator signs its scope.

**2026-08-30 — MCP review rounds 2 + 3: the wire made honest.** Round 2
(`72abb9b`, no ledger entry then — recorded here): modern requests
REQUIRE both namespaced `_meta` keys and the era pins per connection;
modern ping answers -32601; -32022 carries `{supported, requested}`;
`outputSchema` removed (it describes structuredContent these tools do
not return); the reviewer custody arm binds `registeredAt <=
startedAt` so a same-name rotation after admission refuses; setup
custody consults the request's live clock; statusFor's five joins pin
`backend='built-in'`; list_repos FAILS CLOSED on an unreadable
registry; evidence carries mediaType; the db directory is born 0700
and the gateway repairs it; the console speaks relative filing age and
full quarantine words on the no-scope coordinator page. Round 3
verified the deep closures and caught six wire gaps, all closed: the
era pin now covers EVERY classified method (a refused modern ping
pins; unknown methods cannot cross it); explicit `arguments: null`
refuses — only absence defaults; a notification is the message with NO
id, so `notifications/initialized` carrying one is malformed, not a
silent handshake; an unsupported version on `server/discover` answers
-32022 with the revision's own shape; `clientCapabilities` must be an
object — an array refuses; and `loadRepos` treats only ENOENT as an
empty registry, so a permission failure reaches the fail-closed
refusal instead of dressing up as an empty answer. Six regression
tests pin each. Suite 1533.

**2026-08-30 — MCP review round 1: NO-GO honored, all ten findings
closed.** Five fix batches: the 2026-07-28 wire made spec-true
(namespaced `_meta` key, `supportedVersions` + namespaced serverInfo on
discover, `cacheScope: private`, `-32022`, era-classified ping); the
engine validates jsonrpc/ids/arguments as InvalidParams, tracks the
legacy lifecycle, silences unknown notifications, and cancels in-flight
work only; the migration epoch commits BEFORE the fresh-SCHEMA exec and
every MCP method checks the schema inside its own snapshot; the
credential rides a per-server context (the global-variable bug is
dead); custody is proven AFTER the attestation await, before the setup
spawn, and admitReview authenticates the runner token in its admission
transaction; every mode-seal caller surfaces the quarantine; the
cancellation floor is one transaction with validated reasons; scoped
SQL pins backend='built-in' (the collision leak is dead) and the tools
say enough — lease-based running, the board's attention vocabulary,
chip words, scope words with the fallback chain, integer micro-USD
costs with coverage, opaque evidence metadata, allowlist ∩ enrolled;
coordinator_cid carries its FK, the non-migrating door cannot create,
the MCP process umasks and repairs modes, DESIGN.md §9b describes the
real credential and the same-UID threat boundary; the console carries
fingerprint + filing age. Then the regression net: 21 new tests across
three subagent batches — byte-pinned wire fixtures, the token-file
matrix, concurrent-server credential isolation, the global cap and
stale-seal arithmetic, the backend-collision and repo-null exclusions,
quarantine via the planner/attended/mode roads, machine-road dismissal
events with a rollback proof, the REAL migrator's epoch-before-DDL
proof, and takeover races at every seam. One inconsistency the tests
caught — the startup death bypassing said()'s envelope contract — is
fixed. Suite 1524.

**2026-08-30 — MCP 8: the console knows who asked.** The approval
ceremony now carries the filer INSIDE the form when a coordinator filed
the task — `filed by mcp:planner-bot#a3f2 — an agent asked for this;
nothing runs until you sign, and your signature runs THEIR request` —
composed from the cid column, never parsed from display text. The
People screen grows a coordinators card (approver eyes): name +
immutable fingerprint, rate, filing repos, last filed, revocation
state, and the revoke road. One e2e fixture closes the road: file
through the gateway → quarantine refuses the claim → password seal →
ordinary dispatch claims it → the gateway's own reads reflect the
sealed, claimed task. Suite 1496. Next: the implementation-wide Codex
review.

**2026-08-30 — MCP 7: the gateway serves.** `standing-orders mcp` is a
zero-dep MCP stdio server: newline-delimited JSON-RPC, stdout carrying
protocol bytes only, two pinned revisions (modern 2026-07-28 with
per-request `_meta` validation, `server/discover`, and schema-complete
results — `resultType`/`ttlMs`/`cacheScope`; legacy 2025-11-25 whose
initialize NEGOTIATES itself and never counter-offers the modern era),
no batching in either era, cancellations suppressing their responses
entirely, 256KiB/depth-32 limits, malformed input answered in-protocol.
Six tools from typed descriptors (status, list_tasks, get_task,
list_repos, get_contract — a NEW narrow contract guide, not the agent
guide — and file_proposal), every call re-authenticated against the
live credential row (tools/list visibility is presentation, not
authorization; revocation mid-session refuses and exits), reads
allowlist-scoped in SQL with foreign refs answering not-found, costs
and rows built by typed projection (row spreads arch-forbidden). The
CLI verb goes through the NON-migrating door, takes its token from a
0600 token file (fd-verified: O_NOFOLLOW|O_NONBLOCK, regular file, own
uid, exact mode, bounded read) XOR the environment — both set refuses —
dies at startup on a dead credential, refuses demo databases, and
re-reads the schema version on every call so a concurrent migration
ends the server in words. Nine byte-level fixtures + the drift guards
(surface contract + envelope sweep) now cover coordinator/mcp. Suite
1495.

**2026-08-30 — MCP 5: the coordinator principal exists.** Schema v31
(additive): `coordinator_credential` (immutable 12-char cid = the
identity; names unique only among the living, so revoke-and-remint
never conflates generations), `coordinator_event` (filed/dismissed/
revoked, written ATOMICALLY with their state changes — dismissal rides
the cancellation floor's seam, so even a mirror-latch on a
coordinator-filed task leaves its typed event), `mcp_idempotency`
(keyed (cid, key) with the canonical request digest — replay returns
the original ref with no rate charge, a different digest refuses), and
the `coordinator_cid` column on task_ref (authoritative linkage,
written only by the branded door; filed_via stays display-only).
src/coordinator.ts: `VerifiedCoordinator` with a module-private maker,
mint/authenticate/revoke/list, and `fileCoordinatorProposal` — ONE
transaction: in-txn token re-verification → replay → sliding-window
rate (read from the event ledger, so the window and the audit cannot
disagree) → outstanding caps (per-cid 10 / global 50; failed-but-
unsealed COUNTS) → the canonical door under the credential's repo
ceiling → cid stamp → idempotency + event rows. THE QUARANTINE lives in
the primitives: `sealScopeApproval` refuses mode-basis seals on
coordinator-filed tasks (console, CLI, direct callers — one wall), and
the shared acquisition primitive refuses `coordinator-filed` until a
password seal lands, one SQL predicate for planner/attended/raw roads
alike. Nine tests pin all of it. Suite 1485.

**2026-08-30 — MCP hardening 4: the tuple everywhere, and the migration
epoch.** The runner gate's remaining legs: tick proves its canonical
repo is in the runner's bound list BEFORE any git access, probe, or
routine fires; standalone `build` proves it before leasing anything; the
watch lease proves membership in its own transaction; the builder proves
the worktree checks out the TASK's placed repository (a runner bound to
repo B can no longer execute task A inside B's files); and
`proveRunnerCustodyForSpawn` re-proves the whole tuple against LIVE rows
immediately before every provider process exists — both gateways, all
roles — refusing `runner-custody` (no spend, no strike) when the lease,
the runner, or its binding lapsed between claim and spawn. Reviewer runs
are the one proven exception: they hold no task claim by design, so
their arm checks identity/liveness/membership without lease currency.
Schema: the migrator now commits a NEGATIVE-version epoch sentinel
before any DDL and clears it with the final bump, so a non-migrating
reader can never bless a mid-DDL database; `openStoreNoMigrate` is the
door that never creates or migrates, and `schemaCurrent()` is the
per-call re-check. Seven more test files re-fixtured with real claims
(three subagents); builder.test's steer re-attach test was passing FOR
THE WRONG REASON (lease mismatch) and now models the disposition
honestly. Suite 1476.

**2026-08-30 — MCP hardening 3: runner authority is minted, not
asserted.** `runner register` and `runner retire` are password
ceremonies (`--as`/`--token`, approver-verified) and registration BINDS
repos at the mint (`--repo`, comma/repeatable, required). The new
`runner bind <name> --repo ... --as` ceremony is the one-time migration
road for pre-gate runners — it REPLACES the list (stated authority,
never accumulation) and refuses unknown/retired names. `up` now refuses
to register or recover a runner under an UNVERIFIED operator identity
(previously it proceeded on verified:false) and passes its canonical
roots into `registerRunnerIfIdle`, so the claim gate's membership check
holds for the daemon's own dispatches. Three ceremony tests pin the
refusal matrix. Suite 1473.

**2026-08-30 — recovered: the workbench overview implementation.** The
hardening-2 commit also carried ~374 lines of serve.ts (workbench
overview + mobile rail + project peek) found uncommitted in the working
tree: an earlier session had committed its TESTS into serve.test.ts but
never the implementation, so a fresh clone failed the suite at HEAD.
Now committed; the suite passes from a clean checkout again.

**2026-08-30 — MCP hardening 2: the runner gate, first leg.** The shared
acquisition primitive now proves, INSIDE the claim transaction: the
runner's token verifies against its registered credential (a takeover
rotating the credential between the caller's auth and the CAS can no
longer let a stale process ride its successor's authority — round-5
finding 1), the task's placed repo is non-null (`unplaced` refuses:
repo-null tasks stop dispatching), and that repo is in the runner's
bound list (`unauthorized-repo` names the coming `runner bind` road).
AcquireOptions requires `token`; every variant — acquire, acquireIfReady,
acquireFallback, acquireContinuation — shares the gate. Runner repos
canonicalize at registration exactly as task repos do at filing, the
demo registers night-shift-1 through the real machinery, and the CLI
claim verb speaks the three new refusals. 253 tests across 20 files
re-fixtured to the new law (runners registered + bound, tasks placed,
tokens passed); one test's premise was rewritten because the gate
falsifies it by design ("an unregistered runner cannot claim at all").
Still to come in this leg: spawn-time re-proof, tick's pre-I/O checks,
register/retire/bind ceremonies, the migration epoch. Suite 1470.

**2026-08-30 — MCP hardening 1: the cancellation floor + the door's
empty-repo fix.** One function (`applyCancellation`) is now the only
writer of `state='cancelled'` — the generic state verb, operator
dismissal (`cancelTask`, which grew an optional validated-reason
parameter), the external-mirror latch, and disowned fenced completions
all route through it with typed reasons (`operator` /
`mirror-latched` / `disowned-completion`), and pending steering now
settles superseded on EVERY cancellation road, not just the state
verb's. An architecture test proves the write is singular; the
coordinator_event insert lands on this exact seam next. Also closed:
the canonical filing door admitted an omitted/empty repo UNDER A
CEILING (bypassing the bound wholesale) — a bounded surface must now
name a repository. Suite 1470.

**2026-08-30 — MCP gateway spec APPROVED (6 Codex rounds).** Parity II's
MCP phase has its constitution: docs/mcp-gateway-spec.md v6. standing-
orders becomes an MCP stdio server (zero-dep, two pinned protocol
revisions); every tool requires the new coordinator credential
(DESIGN.md §9b — minted ceremony, repo allowlist, cid column linkage,
rate + outstanding caps, txn-time revocation); the one write verb files
through the canonical proposal door; admission is the existing password
scope ceremony, with a coordinator quarantine enforced in the
primitives (mode-seal refusal + shared-acquisition exclusion). The loop
also surfaced pre-existing authority debts that ship in-arc: runner
mint/exec roads get password + repo binding with a three-way tuple gate
(task_ref.repo/worktree.repo/runner.repos) proven in-transaction
against takeover races; one lowest cancellation transition (typed
machine reasons, atomic events) replaces three direct 'cancelled'
writers; a migration epoch closes the mid-DDL race for non-migrating
readers. Round arc: NO-GO(6 structural) → NO-GO(6) → NO-GO(7) →
NO-GO(3) → NO-GO(2) → APPROVE clean.

**2026-08-30 — The Operations Ledger authored as a custom shadcn design
system, ready for Claude Design.** The console's design language (dark-first
ink, IBM Plex Sans as the human voice / IBM Plex Mono for machine facts,
amber meaning exclusively "waits on you", the five-word status vocabulary,
the ceremony surface for every password form) now exists as real code:
`design/` is a dev-only package (never published — npm files whitelist)
holding shadcn/ui primitives vendored from the new-york-v4 registry and
re-themed via Tailwind v4 tokens, plus the console's own vocabulary
composed on top: StatusChip, DigestSeal, AttentionCard, CeremonySurface,
KeyValueRow, Ledger/LedgerRow, NavBar, PageHeader, TextField. 16
components, 33 preview cells authored with real console content, every
sheet visually graded good; render check 16/16 clean against system Chrome
(no playwright download — DS_CHROMIUM_PATH). `.design-sync/` carries the
sync config, conventions header (the design agent's build rules: accent
discipline, mono-for-machine-facts, vocabulary-first), and notes. Upload
to claude.ai/design waits on a desktop `/design-login`; no project pinned
yet. The library is also the reference implementation for translating the
Operations Ledger into serve.ts's chrome layer (own arc, needs Alex's
go).

**2026-08-29 — GitHub listing review: NO-GO honored, all four findings
closed.** (1 HIGH, unbounded I/O) originUrlOf now refuses symlinks and
non-regular files (lstat + O_NOFOLLOW), caps the file size, and reads at
most 64 KiB through readSync — a sparse monster or a fifo planted as a
".git/config" reads as null, never a hang; the roots walk uses opendirSync
and stops at 400 entries, and runs at all only when the listing returned
repos to match. (2 MED, host confusion) githubIdentityOf accepts FULLY
ANCHORED https/ssh github.com forms only — a foreign host carrying
"github.com" in its path never maps — and the config parse is line-based
with real section tracking, so a header embedded in a value opens nothing;
the identity is documented as ADVISORY (the /projects/open road re-proves
path/ceiling/git before anything mutates). (3 LOW) updatedAt is validated
as ISO at ingestion AND at the render belt, escaped at the sink. (4) new
adversarial tests: foreign-host origin offers the clone ceremony not an
open, a section-header-in-a-value opens nothing, a hostile description
renders dead (&lt;script&gt; escaped), a non-ISO stamp never renders.
Suite 1467.

**2026-08-29 — Your GitHub repositories, offered instead of typed.** The
projects page's add card gains "see your GitHub repositories →": a new
/projects/github page lists the server's signed-in gh account's repos
(read-only, through the same hardened tree-killing gh runner onboarding
uses; every identity re-parsed through the strict parser, malformed rows
dropped, descriptions control-stripped). Each row carries exactly ONE
honest action, decided by what this machine already has: "open →" (a
registered project), "add + open →" (a clone under a configured root whose
own .git/config origin names it — a bounded file read per row, no process,
matched case-insensitively), or "clone here →" — a pre-filled form into
the EXISTING preview-and-password onboarding ceremony, so the size check
and the single-use nonce all still stand. gh missing/signed-out render
their words. Approver + cookie only (a viewer has no business enumerating
private repo names); the sandbox refuses. onboard.ts gains
listGithubRepos() beside previewGithubRepo, injectable for tests. Suite
1465 (+2 HTTP tests: the action matrix incl. case-insensitive origin
matching + anon refusal; gh-signed-out words).

**2026-08-29 — Fallback F+G review: NO-GO verdict honored, all six findings
closed.** Codex refused to bless F+G as the feature-close ("dormant defects
do not make the completed feature safe to arm") — every finding shut:
(1 HIGH) fallback models now pass the SAME argv-safety validation every
sealed model does (validateSpec in BOTH the CLI and resolveScopeChain; a
leading-dash "model" refuses; first/last-colon parsing lets openrouter's
":free"-suffixed ids seal — both tested). (2 HIGH) the chain disclosure is
folded INTO profileWords, so EVERY password-signing surface — the task
page's approve form and /next alike — states every entry, credential
included, under the digest that binds them. (3 HIGH) the watch incarnation
now rides the fallback claim, and the new incarnation-crash fault test
proves the window: claim+admit, daemon dies pre-spawn, the successor's
recoverIncarnation interrupts the admitted run, and the SHARED reconciler
closes the cycle — the ordinary road is free again. (4 MED) an unfileable
chain refuses AT SET TIME (set→prove-through-the-filing-resolver→restore
on refusal; an unresolved base passes to the filing gate), and a chain
that reaches filing broken makes the scope VISIBLY UNRESOLVED — approval
blocked with the reason in words, never a silent single-profile yes.
(5 MED) reconcileStrandedChains extracted: the tick and the fault tests
drive the EXACT same code. (6 LOW) the quota test now proves credential
ISOLATION: an exhausted subscription row never blocks the api-key entry,
the pinned credential's own exhaustion refuses, and refusal creates
nothing. Suite 1463. docs/fallback-fixtures.md (pushed earlier) records
the fixture road; final confirmation round queued.

**2026-08-29 — Fallback chains, layers F + G: the operator surfaces and the
fault matrix — task #93's build is COMPLETE.** Layer F, the words and
levers: `config set fallback --repo <path> --entries
provider:model:auth-mode[,…]` (credentialed, per-repo, 1–3 entries, every
malformed shape refused in words — unknown provider, empty model, bad auth
mode, subscription on a login-less provider; `config show` renders the
chain and `config clear fallback` removes it; NEW approvals bind it,
existing approvals untouched); `mode set --allow-paid-fallback` grants the
spend switch (NEVER a preset default — hands-off included — and the /mode
web ceremony gains the same explicit choice, carried through
confirm→sign); the approval card now SAYS the chain everywhere the yes is
read — describeScope gains "runs on claude (sonnet) — your subscription /
if that runs out: falls back to gemini (gemini-2.5-pro) — your API key;
spend moves to that account" (every CLI approve/show surface), and the web
task page's scope card carries the same line, so the digest that binds the
whole chain is signed with the whole chain in view. Layer G, the fault
matrix (fallback-faults.test.ts): crash between disposition and resolution
→ the reconciler re-derives the SAME advance from durable state; crash
after a success → 'succeeded', no lingering cycle; a racing second
resolver loses with exactly one transition; the grant revoked between
advance and admission → refused at the money moment, cycle closed clean,
nothing created; the approved chain corrupted after advance → incident,
nothing created; a replayed admission → not-pending, exactly one fallback
run ever; a third-strike-failed task → the fallback claim refuses on
state; an exhausted pinned credential → the claim refuses on quota. CLI
lesson: `--allow-paid-fallback` is a BOOLEAN flag — in the value-flag list
the parser eats the next `--as` as its value. Suite 1461 (74 files).
Remaining for #93: a Codex review round on F+G, then the fixture-capture
milestone doc (how a real exhausted-subscription fixture arms the feature).

**2026-08-29 — Fallback chains E3d VERIFY round: 1/3/5 confirmed closed;
residuals on 2/4/6/7 all closed.** Codex's verify pass confirmed the
credential pin (1), the pre-spawn custody proof's atomicity (3), and the
custody-transfer model (5) hold as claimed, and found four residuals — every
one now shut: (R2 HIGH, my own pre-flagged suspicion confirmed) the custody
proof refused REPAIR spawns (the cycle's tail is the parent) — it now
accepts exactly a bounded repair child whose parentRun IS the current tail,
proven by test alongside "binding alone is not custody" (a chain-bound
stranger still refuses, stamping nothing). (R4 MED) acquireFallback gained
the attention budget verbatim from the ordinary road — backoff really is
the ONE exemption — with the tick's max-open-decisions threaded through.
(R6 HIGH) the ordinary road's budget-unenforceable arm now FINISHES the
already-created run and resolves its cycle (a refused-but-open run deferred
a chain task forever — and read as a vanished attempt even off-chain); the
fallback belt re-derives the effective cap AFTER admission and uses that
same fresh value for the invocation's --max-budget-usd, so a backstop set
mid-await governs the spend that actually happens. (R7 MED) build()'s chain
proof re-derives the taskRef↔taskId pairing from the ref row's own
external_id — two tasks sharing a chain digest can no longer cross-execute
under each other's custody via a mismatched internal call. Suite 1450.

**2026-08-29 — Fallback chains E3d review: ALL SEVEN findings closed — the
binding chain is now fail-closed end to end.** Codex's E3d round found the
custody model still porous ("not yet fail-closed"); every hole is shut:
(1 HIGH, missing key → cached login) a chain run PINNED to api-key with no
managed/ambient key is REFUSED at the gateway as a value (`chain-credential`)
before any stamp — the provider CLI can never quietly spend its cached
subscription login; api-key mode also sheds every other own-key alias
(GOOGLE_API_KEY beside GEMINI_API_KEY) so only the ONE canonical injected
key reaches the child. (2 HIGH, repair loses the pin) every repair run now
INHERITS its parent's chain binding verbatim (inheritChainBinding,
first-write) — the mending turn spends under exactly the pinned entry.
(3 HIGH, proof↔spawn gap) proveChainCustodyForSpawn: the chain run's start
stamp IS a custody proof — ONE transaction re-derives approval standing,
cycle/tail/cursor, entry digest + pin, and (past the base) the LIVE
paid-fallback grant, stamping provider_started_at only if all stand;
refusal is `chain-custody`, no strike. (4 HIGH, bypassed gates)
acquireFallback in claim.ts: the admission's claim now enforces EVERYTHING
acquireIfReady does — task state (a third-strike failed task never
dispatches a fallback), non-backoff holds, blockers, approved scope + live
mode belt, capability, capacity, and quota KEYED BY THE PINNED
provider/model/auth-mode — with exactly one exemption, the predecessor's
backoff. (5 HIGH, re-tag backwards) the in-passing re-tag is GONE:
custody moves only through admitFallback or the new PROVEN parked-resume
transfer (resumeChainCustody: parent parked + binding + tail re-proved,
successor inherits, single-use); the ordinary road defers EVERY live cycle
except a parked tail, whose successor takes custody through that transfer.
(6 HIGH, abandoned admitted run) the budget-capability gate moved BEFORE
admission (on the peek); the unreachable belt now finishes the run and
resolves the cycle rather than abandoning either. (7 MED, caller authority)
admitNextChainEntry derives task + repo from the cycle's own task_ref, and
the dispatch proof requires the run's task_ref to equal the task being
built. Gateway refusals ride two new typed reasons through the no-strike
invariant arm. E2E updated (ambient key present for the pinned entry) +
new tests: no-binding-on-second-dispatch, proven parked-resume (live
parent refuses, parked transfers, single-use), gateway chain-credential /
chain-custody refusals with NO stamp landed. Suite 1449.

**2026-08-29 — Fallback chains, layer E3d: the admission road + the
chain-entry dispatch proof — the runtime is COMPLETE.** The last two review
findings (5/6) closed, and the whole loop now runs end-to-end through the
real tick, proven by fallback-e2e.test.ts. What shipped: (1) entryDigestOf
(scope.ts) — a per-entry binding digest (profile digest + auth mode,
domain-separated); resolveScopeChain refuses a subscription entry on a
provider with no login. (2) openChainCycleForDispatch BINDS the dispatched
run to its entry (chain_cycle/chain_index/entry_digest/pinned auth_mode,
first-write). (3) builder.ts gains THE CHAIN-ENTRY DISPATCH PROOF: a
chain-bound run re-derives everything — approval standing, live cycle at
the run's exact cursor with the run as tail, chain digest, entry digest,
pinned auth mode — then proves the given fields against the entry's WHOLE
profile; an ordinary run on a chain scope with no binding refuses
(finding 6: the base entry now dispatches, and nothing on a chain scope
can spend outside its cycle). (4) the gateway spends under the PINNED auth
mode for chain runs (finding 5) — a mode-file flip between admission and
spawn cannot move the spend. (5) resolveChainOnRunEnd is now the ONE
resolver for every concluded tail: built/no-change closes 'succeeded',
parked stays open for repair, ordinary ends close 'entry-ended' (the retry
road opens a fresh cycle at the base — a concluded tail can never re-tag),
eligible exhaustion advances; the disposition hook calls it
unconditionally, and THE CHAIN RECONCILER feeds stranded open cycles
(crash between disposition and resolution, finding 3) through the same
resolver each pass. (6) the tick DEFERS pending-admission tasks off the
ordinary road and THE CHAIN ADMISSION PASS dispatches the next entry: rail
reserved, claim + fresh worktree on the task's branch, then
admitNextChainEntry re-derives ALL authority in one transaction (approved
chain standing + cycle digest + LIVE paid-fallback grant re-proved at the
money moment + the single-use pending edge) before build() re-proves the
entry proof again pre-spawn. E2E: one tick carries base-exhaustion →
advance → same-pass admission → attested gemini fallback builds under its
pinned api-key entry → cycle closed 'succeeded' → task done; and WITHOUT
the grant, gemini provably never runs (one run total, cycle closed
'grant-withheld'). Still inert in production: no recognizer ships, so no
real terminal ever classifies eligible. Suite 1446 (73 files; +e2e pair,
resolver arms reworked). Remaining: F (surfaces: config set fallback CLI,
approval card shows the chain, exhausted-end page) and G (fault matrix) +
a Codex review of E3d.

**2026-08-29 — Fallback chains E2–E3c review: 7 findings closed (2 CRITICAL).**
Codex reviewed the live-path integration and confirmed the core (E3a seal,
E3b/c immutability, fenced-walk atomicity, E2 placement) but found real
gaps — all closed here except the two that belong to E3d, now scoped:
(1 CRITICAL) the test recognizer seam shipped in dist and could disable
fail-closed — REMOVED entirely; exhaustion.ts now has NO mutation surface,
the suite proves the eligible path by MOCKING the module, and an
architecture test forbids any `__`-export/`let recognizerLookup`/NUL byte.
(2 CRITICAL) a stale/changed approval stayed usable — approvedChainOf now
proves approved_digest===digest AND re-derives digestOf(fields,{chain})===
approved_digest, and advanceChainIfExhausted proves cycle.chainDigest===
chainDigestOf(chain); a rewritten scope loses fallback authority. (4 HIGH)
grant TOCTOU — advanceChainIfExhausted now re-reads the LIVE signed mode's
allowPaidFallback INSIDE its transaction (takes repo, not a precomputed
boolean). (7 HIGH) it now proves the predecessor genuinely finished
(outcome + finished_at + provider_started_at, matching task_ref) before
advancing. (8 MED) C8 upgraded to recognizesEligible(provider,version,
authMode) — exact per class/auth — plus classMatchesAuthMode consistency
and a first-write terminal_class stamp that never overwrites a pinned
auth_mode. (3 HIGH, partial) openChainCycleForDispatch refuses to re-tag a
concluded tail and incidents on a chain-digest mismatch; the crash
reconciler is E3d. (9 MED) the NUL-key seam is gone. DEFERRED TO E3d (per
findings 5/6): the whole-entry pin (auth mode included) + gateway
auth-mode-equals-pin, and the chain-aware dispatch proof that lets even the
BASE entry of a chain approval run (today proveApprovedProfile would
stale-approve it). Suite 1443.

**2026-08-29 — Fallback chains, layer E3c: the exhaustion→advance decision
at disposition.** The tick now, at every base/fallback run's disposition,
closes the chain cycle on success and offers a non-parked end to
store.advanceChainIfExhausted — which is fail-closed at EVERY gate. It
advances one fenced step (sanitize→advance→release-to-pending, atomically
inside one transaction so a lost inner CAS rolls the whole walk back) ONLY
when: an open cycle's tail is exactly this run; the run's gateway-stamped
terminal class is fallback-ELIGIBLE; THIS build still carries a
fixture-backed recognizer for the run's exact (provider, version) — the C8
re-check, which severs to incident on a downgrade; the operator's live mode
GRANTS allowPaidFallback (else the cycle ends clean and the run disposes as
the ordinary exhaustion it is); and a next entry exists in the IMMUTABLE
approved chain (else exhausted-end, closed). It NEVER dispatches — the next
tick admits. To prove the ELIGIBLE path a production build (shipping no
fixtures) can never reach, exhaustion.ts gained a clearly-marked TEST-ONLY
recognizer-lookup seam (default = the empty registry, so fail-closed is
untouched); tests install/reset it. Suite 1435 (+6 E3c tests).

**2026-08-29 — Fallback chains, layer E3b: the coordinator opens the base
cycle.** The tick now calls store.openChainCycleForDispatch right after it
creates a base run: if the task's approval sealed an explicit chain, the
fallback cycle opens at cursor 0 bound to that run, its digest derived from
the IMMUTABLE approved snapshot (approvedChainOf → chainDigestOf), never
mutable config. A single-profile approval — every task until an operator
configures a fallback chain — opens nothing and returns null, so it is
inert by default. A second dispatch at the open cursor (a repair/retry)
RE-TAGS the tail to the live run instead of opening a second cycle, so the
advance CAS keys off the run that actually exhausts; a cycle mid-advance is
left untouched (its next run arrives through admitFallback). A digest
mismatch against an existing open cycle refuses to re-tag. All cycle
orchestration stays in operate.ts + store.ts; builder.ts is untouched.
Suite 1429 (+3 E3b tests).

**2026-08-29 — Fallback chains, layer E3a: filing binds the chain, the seal
copies it.** The scope-filing road now produces a real chain approval when
a repo has configured fallbacks. saveScope resolves the chain
(resolveScopeChain) and, when kind:'chain', binds the SIGNED DIGEST to the
whole ordered chain and stores the working snapshot in a new
proposed_chain_json column — exactly as profile_json holds the working
profile. sealScopeApproval then COPIES proposed_chain_json into the
immutable approved_chain_json (mirroring approved_profile_json =
profile_json) and sets approval_kind, so what is sealed is byte-for-byte
what the approver agreed to — never re-resolved, and a config change after
approval can't move it. This retires the speculative, never-wired E1
sealChainApproval method (no callers, no tests) for the simpler
snapshot-mirror. Inert until an operator sets a fallback config (Layer F):
with none — every repo today — proposed_chain_json stays NULL and the
digest is the byte-identical single-profile binding, proven by test. Scope
type + readScope now carry proposedChainJson/approvedChainJson/approvalKind.
proposed_chain_json added to v30 additively (unreleased); no version bump.
Suite 1426 (+5 filing-under-chain tests).

**2026-08-29 — Fallback chains, layer E2: the gateway's honest disposal
stamp.** The invocation gateway now classifies EVERY finished attempt
where the evidence still exists — the structural terminal off that exact
envelope, the authoritative version the gateway proved at spawn, and the
auth mode that spawned it — and stamps `auth_mode` + `terminal_class` on
the run (new `stampTerminalClass`). It is purely observational and fail
closed by construction: `classifyTerminal` can only return a non-eligible
class while the recognizers ship empty (every build), so the stamp
authorizes nothing — it is the disposal record the dispatch's C8 gate
later re-checks against `hasRecognizer` before reading it as anything more
than history. A refused-before-spawn attempt (an out-of-range attestation)
never runs a process and so is never classified — terminal_class stays
NULL, honestly. Tier-1 providers prove no version at the gateway yet
(attested === null), so claude/codex classify fail-closed until their
exhaustion fixture — and the version proving needed alongside it — is
captured; the primary subscription providers get a real class only then.
Run type + readRun now expose the v30 chain fields (chainCycle/chainIndex/
entryDigest/authMode/terminalClass). Suite 1422 (+3 E2 gateway tests).

**2026-08-29 — Fallback chains E1 review closed (6 fixes) + projects page
UI.** Codex's E1 state-machine review came back APPROVE-WITH-CHANGES with
six real CAS-contract issues — all closed before the live-path wiring.
(1) incident/close now CAS on the exact transition_generation and bump
it, so a stale success observer cannot terminate a cycle that advanced.
(2) admitFallback CREATES the next run atomically, bound to the exact
pending edge (to_index === cursor), with the chain metadata (cycle,
index, entry digest, auth mode) — proven single-use: a replay opens NO
second run, and an old unconsumed quota-skip cannot authorize an
unrelated admission. (3) quota-skip goes open -> pending-admission (tail
cleared) so admission is the ONE road that installs a tail. (4) a
SAVEPOINT wraps the multi-statement primitives with INSERT-first
ordering, so a UNIQUE(cycle, from_index) conflict rolls the cursor move
back too — even nested inside an outer transaction a caller might catch
around; 'dup' returns instead of throwing. (5) the
one_live_fallback_cycle_per_task partial unique index is the real DB
backstop the comment claimed. (6) sealChainApproval is write-once and
CAS-bound to approved_digest === digest, and sealScopeApproval resets the
chain fields so a rewritten-then-reapproved scope keeps no stale chain.
Ten state-machine tests. Separately, the PROJECTS page got the UI pass
the operator asked for: each project renders as a vertical CARD with an
at-a-glance peek (waiting on you / running / queued / built today, one
cheap COUNT set each) and open action, and the two ways to add — browse
this machine's folders, or paste a GitHub repo — are one unified card
with the exact-path road behind a details. Suite 1419.


**2026-08-29 — Fallback chains, layer E1: the fenced cycle state machine
(the crash-safety core).** The durable C7 state machine, as store
primitives, each a compare-and-swap proving the exact from-state,
generation, and (where it matters) cursor + tail run. openFallbackCycle
(one live cycle per task); beginFallbackSanitize (open -> sanitizing, CAS
on state+generation+tail); advanceFallbackFenced (sanitizing ->
awaiting-release in ONE txn: the cursor moves, the immutable transition
inserts under the UNIQUE(cycle, from_index) backstop, generation bumps —
the target proven < chainLength by the caller from the approved snapshot);
releaseFallbackToPending (awaiting-release -> pending-admission, tail
cleared); admitFallback (the SINGLE-USE admission — consumes the
transition once and opens the next run in one txn; a replay finds it
consumed and the state open, both guards refusing); quotaSkipFallback
(open -> open at i+1, a recorded skip); incidentFallback / closeFallback
(terminal). Seven exhaustive tests walk the happy path AND every race:
stale generations lose, the admission cannot be replayed to open a second
run, the uniqueness index backstops even a forced double transition, and
at-end refuses. The design's crash-window proof holds: no alternate
authority exists until a transition commits. Suite 1417. Remaining: E2
(gateway classification + chain-entry proof), E3 (the sanitizer +
dispatch integration), then F/G.


**2026-08-29 — Fallback chains, layer D (core): the paid-fallback mode
grant, the config, and chain resolution.** ModeTerms gains
`allowPaidFallback` (R8): presets default FALSE, a LEGACY signed mode
(no such field) rehydrates to FALSE — a paid substitution is only ever
an explicit, freshly-signed grant, never inherited; a non-boolean is a
bad envelope (null); the ceremony renders the grant either way. A new
fallback_config table (per scope, build phase) holds the ordered
fallback entries after the base, arriving by IF NOT EXISTS on fresh and
upgraded databases alike, with set/get/clear store roads.
resolveScopeChain folds the ordinary base resolution (entry 0, wearing
the base provider's auth mode) with the configured fallbacks (each a
WHOLE ExecutionProfile via contestantProfileOf) into a ChainEntry[]:
with NO fallbacks it returns kind 'profile' — a legacy single-profile
approval, byte-identical to today; with fallbacks, kind 'chain', proven
through the strict rehydrator so a duplicate entry (same profile + auth
mode) refuses while the subscription->api-key quota switch is allowed.
Eight tests. Suite 1410. Remaining: the approval-road wiring (seal the
chain), the runtime state machine (E), surfaces (F), fault-injection
(G). Still inert — nothing dispatches on a chain yet.


**2026-08-29 — Fallback chains: foundation review (A-C) closed.** Codex
APPROVE-WITH-CHANGES — the design is sound (all three digest goldens
reproduced, the v29->v30 upgrade verified live with seeded data), with
five localized fixes landed before the runtime. (1) fallback_transition
gained its UNIQUE(cycle, from_index) index — the durable backstop the
fenced advance/skip CAS relies on. (2) The gemini parser no longer
FABRICATES a structural failure terminal from a MISSING result
(resultStatus null => structuralTerminal null); only an actual
non-success result retains one, so absence is never promoted to
exhaustion evidence. (3) The recognizer lookup is TOTAL against
adversarial version strings — Object.hasOwn, so "__proto__" /
"constructor" / "toString" resolve to no-recognizer instead of throwing
on an inherited property. (4) classifyTerminal returns unknown before
any matching unless terminal.failed === true — a non-failure terminal
is never exhaustion. (5) The v30 migration test is now an AUTHENTIC v29
fixture (real pre-v30 run/task_scope/quota shapes with seeded
scope/run/quota rows), asserting the upgrade preserves the seeded data,
extends the quota PK, restores the fallback tables + the uniqueness
index, and reopens clean. Foundation is solid; the runtime (layer E)
builds on it next. Suite 1402.


**2026-08-29 — Fallback chains, layer C: the v30 schema (the state
machine's home).** task_scope gains approved_chain_json + approval_kind
('profile' legacy | 'chain'); run gains chain_cycle / chain_index /
entry_digest / auth_mode / terminal_class (all NULL on every pre-v30 and
non-chain run). Two new tables: fallback_cycle (the durable C7 state
machine — open / sanitizing / awaiting-release / pending-admission /
incident / closed, with a monotonic transition_generation and the tail
run) and fallback_transition (the immutable audit AND the single-use
authority for the next entry, unique per (cycle, from_index), consumed
once). quota's PRIMARY KEY grew auth_mode + credential_fp so a
subscription and an API key exhaust independently (else exhausting a
claude sub would wrongly block a claude api-key fallback) — a recognized
rebuild, the four quota store methods gained the identity with LEGACY
DEFAULTS ('subscription','') so every existing caller is byte-identical.
The migration is additive + idempotent both fresh and on upgrade
(rebuildRunForV29 now recognizes the v30-augmented run shape — the
old-plus-added-columns pattern, with ALTER's real column placement
before the CHECK); proven live against the actual v29 console DB (data
intact, repeated reopens clean) and pinned by a regression test. The
feature remains inert — no runtime reads these yet. Suite 1401.


**2026-08-29 — Fallback chains, layer B: chain canonicalization + the
versioned digest union (C1), goldens byte-pinned.** The trickiest
compatibility layer. src/scope.ts gains ChainEntry ({full
ExecutionProfile, authMode}), canonicalChainJson (version rides IN the
snapshot), chainDigestOf (domain "standing-orders:chain:v1:" — a
DIFFERENT domain from ":profile:", so a chain digest can never collide
with a profile digest), and chainFromJson (strict rehydration through
the single-profile path, ≤4 entries, exact-duplicate entries rejected).
digestOf now takes a DISCRIMINATED target — a legacy single profile OR
`{chain}` — both folding through the SAME outer `profileDigest` key,
the discriminator living INSIDE the hashed value, never as an outer
field. Proven byte-for-byte: the no-profile golden stays EXACTLY
a24c72e6603f78291e1eea2e162b383e; the profile-bearing fixture stays the
review's exact 6d7cc772f312c1295df747e243a49717 (profileDigest
6df214084f95a74ed2694ecc45b2f043); a chain-of-one is a DISTINCT explicit
target (not a legacy profile); order and auth mode both move the chain
digest. Two golden/round-trip tests. Suite 1400.


**2026-08-29 — Fallback chains, layer A of the approved build: the
exhaustion taxonomy + evidence retention (fail-closed).** The spec
reached a clean APPROVE across four Codex rounds; the operator chose to
build the fail-closed scaffolding now. This first layer is the
foundation everything else proves against. src/exhaustion.ts owns the
terminal taxonomy (usage-exhausted / credits-depleted =
fallback-eligible; transient-throttle = backoff never paid;
not-exhausted / unknown = the ordinary strike road) and the classifier,
which is INERT BY CONSTRUCTION: every provider's recognizer set ships
EMPTY, so no input — not even a usage-limit-shaped terminal — can ever
return an eligible class until a versioned fixture captured from a
GENUINELY EXHAUSTED subscription is added and reviewed (the plane cannot
manufacture that shape). hasRecognizer() is the C8 gate the runtime will
consult at every authority point. And the evidence-loss Codex named is
fixed at the source: codexParse now RETAINS the turn.failed structural
terminal (message + typed code) instead of dropping it, and
ParsedEnvelope carries a structuralTerminal that a failed-but-exit-0 run
exposes for the success-ingestion block (C5). Claude and gemini parsers
expose their non-success terminals too (recognizers still empty). Four
taxonomy tests pin the fail-closed property. Suite 1398. Layers B–G
(chain digest, schema, resolution, the fenced runtime, surfaces,
fault-injection) follow; the feature stays disabled until its own
step-8 gate and never activates without a real fixture.


**2026-08-29 — Auth-mode messaging made fully accurate (verify round 5's
one open finding).** Rounds confirmed everything else closed; the last
residual was messaging honesty, now fixed. The settings save handler
VALIDATES before it mutates: an unchanged blank submission claims no
change (a mode equal to the current one is not a change), an invalid
key refuses BEFORE any mode is persisted (no hidden switch), and a
selected-but-inapplicable mode (openrouter subscription) refuses first.
Copy is mode-aware everywhere: the keys-clear guide synopsis, the CLI
and settings clear messages (subscription mode strips the ambient key,
so "environment takes over" was wrong there), and the settings intro
(a key is handed over ONLY in api-key mode). Four isolated settings
HTTP tests — HOME sandboxed so provider-key writes never touch the real
store — cover the unchanged-blank, invalid-key-no-hidden-switch,
real-change + openrouter-refusal, and subscription-clear paths. Suite
1394.


**2026-08-29 — Auth modes verify round 4 (APPROVE-WITH-CHANGES): the two
residuals closed.** The three blocking findings (isolation, resume test,
verify classification) were all confirmed closed. Two small ones: (1)
`keys auth <provider> <mode>` was UNUSABLE — an off-by-one in the
positional destructuring (`const [, wanted] = rest` read the second
element of a one-element array) made it always return usage; fixed to
`const [wanted]`, with a CLI test that switches the mode and proves the
stored key survives, plus the openrouter-refuses-subscription case. (2)
Stale messaging: `keys clear` and the settings clear both claimed "an
environment variable takes over" regardless of mode — now mode-aware
(in subscription mode the ambient is stripped, so builds are
unaffected); and a blank openrouter settings submission no longer
falsely reports a subscription switch — the save handler honors
setAuthMode's refusal and only claims a mode change when one happened.
Suite 1390.


**2026-08-29 — Provider auth modes: subscription first, key as fallback,
switchable — which also closes verify round 3's blocking finding.** The
operator asked to keep BOTH a subscription and an API key and prefer the
subscription; Codex round 3 independently flagged the same thing as
blocking (the ambient re-supply could pass a chat credential into a
Claude agent and silently switch subscription billing to API). Both are
now answered by one mechanism: a per-provider auth mode. "subscription"
(the default for Claude and Codex) uses the CLI's own login and STRIPS
that provider's own key from the spawn — its stored key is kept, just
not handed over, so an ambient key can never override the login.
"api-key" (the default for gemini/openrouter, and an opt-in for the
others) hands the managed-or-ambient key over. openrouter is api-key
only (no login); the mode file refuses subscription for it. Switching
is one act — `keys auth <provider> subscription|api-key` or the
settings card's sign-in select — and never touches the stored key.
Round 3's two smaller residuals closed alongside: the resume-XOR test
now asserts the run RAN (no protocol refusal from a suppressed id), and
the verify 400-classification requires an actual NEGATIVE marker near
the key/auth phrase ("API key not valid" rejects; "API key accepted;
malformed page size" does not). Held-Claude subscription coverage added.
Suite 1388.


**2026-08-29 — Gemini verify round 2 (REDESIGN): the last six findings,
closed.** Codex confirmed the round-1 fixes and found the residue — all
real, all shut. Finding 1 (trust proof incomplete): added DISPATCH-level
tests — an attested gemini sitting on PATH never hijacks a claude-
configured tick (only explicit selection routes to it), complementing
the existing comparison-from-explicit-terms e2e. Finding 2 (strip not
closed): the `providers` command's `codex login status` identity probe
and probeBudgetCap's version/help probes were still inheriting foreign
keys — both now strip ALL_CREDENTIAL_ENV, so no provider-binary spawn
anywhere inherits a foreign credential. Finding 3 (protocol invariant):
the resume-XOR-mint rule moved from the one repair caller to the
GATEWAY — invokeAgent drops a minted start id whenever a resume is
present, before it is ever stamped or validated, so no paid protocol
refusal can form; a gateway-level test proves it. Finding 5 (managed
keys): the Claude ambient-fallback claim was FALSE (resolveChildEnv
strips ambient ANTHROPIC_API_KEY) — the gateway now RE-SUPPLIES the
selected provider's ambient key when no managed file exists, making
"environment takes over" true for every provider while the chat-key
isolation holds elsewhere; keyHome now threads through the held gateway
too, with managed-wins and both-road injection tests. Finding 6 (verify):
the gemini key moved from the URL query to the x-goog-api-key HEADER
(no secret in a URL a diagnostic could surface), and a 400 is a
rejection ONLY when its body names a key/auth failure — a malformed-
request 400 reads as unexpected, never a false rejection; re-proven live
(real key ok, bogus rejected via the body). Suite 1383.


**2026-08-29 — Gemini verify came back REDESIGN; every finding closed,
one by a real correction.** Codex found the trust-containment claim was
FALSE — gemini 0.57.0 implements `--skip-trust` by setting
GEMINI_CLI_TRUST_WORKSPACE inside its own process (descendants inherit
it) and trusted mode is what loads a worktree's .gemini/ config. Alex
ruled the posture: gemini dispatches ONLY on EXPLICIT selection (a
phase-config row, a task pin, or a flag — never a default or fallback),
so trusting the workspace is the operator's own deliberate act, not an
ambient grant. The comment now states the mechanism honestly, and a new
invariant test pins that no default/fallback road ever resolves to
gemini (an unconfigured phase/repo is always claude; a broken config
refuses). Finding 2: the credential strip is centralized — every
version/help/which PROBE (authoritative attestation, provenance,
the providers command) now sheds ALL provider keys via
ALL_CREDENTIAL_ENV, since a feature check needs none; the full
four-provider × all-keys matrix is a test. Finding 3: S1 proved native
resume, so gemini's audit flips resume "none" → "native", and the
repair caller mints a start id ONLY when not resuming (resume XOR mint,
never both — the protocol refusal Codex named); the gemini repair test
now asserts the resume path. Finding 4: the "real bytes" fixture feeds
the captured lines as parsed objects, not a reserialize claiming false
verbatim fidelity. Suite 1379.


**2026-08-29 — Managed keys get live verification: paste, know
immediately.** The key card and CLI shape-checked but never asked the
provider whether the key was good — a typo or an expired key stored
clean and failed a build hours later. Now saving a key runs a
zero-token credential check against the provider's own auth boundary
(gemini's models endpoint, OpenAI/OpenRouter/Anthropic likewise — a
cheap authenticated GET, injectable fetcher on the converse.ts
precedent so tests never touch the network). The verdict distinguishes
what the operator must act on: REJECTED (bad, expired, or wrong
provider — fix the key), UNREACHABLE (offline or blocked — the key is
stored, verify later), UNEXPECTED (an odd status, stored but
unverified). The settings card reports it inline on save; `keys set`
auto-verifies (`--no-verify` to skip on an offline box) and `keys
verify <provider>` re-checks a stored key on demand. Proven live: the
real gemini key returns ok, a bogus one returns rejected/400. Seven
key tests. Suite 1378.


**2026-08-29 — Managed provider keys: the environment stops being the
key store.** The gemini onboarding exposed the gap: every provider key
was ambient environment, hand-edited into shell profiles, invisible to
the product. Now src/keys.ts owns them — one 0600 file per provider
under ~/.standing-orders/keys/, written from the settings card or piped
into `standing-orders keys set <provider>` (stdin or --key-file; a key
on an argv is visible to every process list, so that road does not
exist). Surfaces are WRITE-ONLY: status says stored/environment-only/
not-set with a date — never the value, never a prefix, never a length.
The invocation gateway injects a stored key into EXACTLY its own
provider's child environment at spawn (held claude sessions included),
where the symmetric foreign-credential strip has already shed everybody
else's — so the plane's own process no longer needs any key in its
environment, a rotation is a file write that applies at the next spawn
with no restart, and an ambient variable keeps working as the fallback
it always was (the managed file, being deliberate, wins). Settings card
+ keys CLI (status/set/clear) + four tests (0600 round trip, implausible
paste refusal, injection with strips proven, no-key-no-injection).
Suite 1375.


**2026-08-29 — Gemini live-auth spikes S1–S4, run against the real CLI
(0.57.0, exactly the attested version).** The API key arrived and the
four questions the adapter shipped with got their live answers. S1
PASSES: a plane-minted `--session-id` is echoed by the init event, and
`--resume <uuid>` recalls session state headless in the same cwd — the
identity contract holds against the real binary. S2 ANSWERED, and it
bit: headless gemini REFUSES untrusted directories, and a freshly
leased worktree is always untrusted — the adapter's argv now grants
`--skip-trust` per-invocation (visible, never ambient environment),
with the pinned argv test updated deliberately. S3 DONE: a live
happy-path stream is captured verbatim into the runner's test suite —
real timestamps, real session id, real delta framing — and it taught us
the live CLI emits SEPARATE assistant messages each flagged delta:true,
which the runner's concatenation rule assembles correctly. S4 CONFIRMED
by construction (child processes inherit env; the CLI claims no
scrubbing), and the mitigation that matters shipped: a symmetric
credential matrix — every adapter now sheds every OTHER provider's key
environment (GEMINI/GOOGLE, ANTHROPIC, OPENAI, OPENROUTER) before its
process exists, so a Claude build can never read the Gemini key out of
its env. The audit's configSurface tells both new truths. Suite 1371.


**2026-08-29 — 0.4.0 release prep, refreshed against what actually
ships.** The earlier prep predated the entire modes arc; the README now
tells the truth: status v29 / suite 1,369, the merge machine's
per-merge-yes-by-default posture, operating modes with the reversal
sentence quoted, the artifact-only reviewer, People with invite links
and the severing revocation, and N parallel watched sessions with the
mint picker. Verified: typecheck, build, `dist/cli.js --help` from the
built artifact, `npm pack --dry-run` (130 files, bin path in the
npm-safe form). Remaining are the operator's own acts: `npm publish`
(2FA), the v0.4.0 tag, and the cold `npx standing-orders@0.4.0 --help`
smoke from the registry.


**2026-08-27 — The live console's migration refusal, fixed.** Restarting
the :4180 console on v29 hit the fail-closed guard: the v29
merge_blocker rebuild refused the REAL database's DDL. Root cause:
SQLite stores ALTER-appended columns as "…NOT NULL\n, lifted_at TEXT…"
— a newline BEFORE the comma — and canonicalDdl's whitespace collapse
turned that into a space-comma the recognizer's expected variant never
had. Comma spacing is presentation, never shape: the normalizer now
strips space-before-comma, and a regression test reproduces the exact
live shape (v28 stamp, ALTER-appended columns) and proves the reopen
rebuilds cleanly. The refusal itself worked as designed — nothing was
touched until the shape was understood. Suite 1369.


**2026-08-27 — Layer 7 hardening: the Codex round-1 findings, closed.**
APPROVE-WITH-CHANGES with five findings, every one now shut. (1) The
bearer hole: bearer credentials produce an approver identity, and both
filing arms would have auto-sealed for them — but bearer is the machine
channel, and C1's table says console cookie or credentialed CLI only.
Both coverage calls now gate on the cookie road, with an HTTP
regression proving a bearer filing lands unapproved. (2) Revision
auto-approval now applies the mode's filing defaults WHERE THE DIGEST
IS COMPUTED: the escalated posture and the mode budget thread through
sealRevision → createConsoleTask → saveScope before anything is
sealed — and every mode-seal road (console, CLI, revision) refuses when
the profile could not resolve, exactly as the human approve() does.
(3) The CLI filing became ONE replayed composite: the file, any race or
comparison terms, and the mode seal record as a single keyed operation
— a replayed key returns the first answer whole instead of re-sealing
whatever scope happens to be current. (4) The automerge prerequisite is
re-proved INSIDE signMode's transaction — a grant revoked between the
confirm screen and the signature loses; the pre-checks only shape the
words. (5) The disclosure fixes: the attended confirm screen's chrome
binds to the task's AUTHORITY repository (the banner shown is the mode
that would cover the quick mint, never the session's project filter);
the banner names FULL permissions and passwordless minting when the
terms say so; and the /mode form's override controls became honest
tri-states whose blank value means the preset's own default — choosing
hands-off no longer promises auto-approval while an unchecked box
silently removes it. Four regression tests. Suite 1368.


**2026-08-27 — Modes arc, layer 7 of 7: the surfaces. THE ARC IS
COMPLETE.** The signed envelope reaches every screen it governs. THE
BANNER (M1): every page scoped to a repo with a live mode carries it —
name, expiry, and what it changes, one link from the full terms; a
signed posture is never invisible. THE CEREMONY (/mode): choose the
preset and overrides (automerge offered only where a merge-capable
grant exists), then the confirm screen renders EVERY resolved term in
words — the reversal sentence verbatim — and the password signs a
digest RE-DERIVED from the posted fields, 409 on drift. Ending the mode
is ONE CLICK for any approver (the v4 doctrine: raising is a ceremony,
lowering is instant). QUICK MINT (C2/M4): under a quickMint mode, the
attended confirm screen shows every term as always but accepts on the
signer's session alone — the mint TRANSACTION re-proves the mode
(live, exact digest, minter IS the signer) and stamps
authority_basis='mode' + the digest durably; a dead mode refuses with
words pointing back to the password. THE MINT PICKER (P1/C7): the
watched-session form gains a claude model select and a permission
posture (defaulting escalated when the mode says so); a choice rebuilds
the WHOLE ClaudeProfile and the digest signs that — nothing partial is
ever authorized, and the confirm screen says "FULL permissions —
nothing asks" honestly. AUTO-APPROVE FILING (C1/M3): the signer's own
credentialed filings — console cookie or CLI --as/--token — file and
seal in ONE transaction with mode provenance; the escalated matrix
seals claude bypassPermissions / gemini yolo where profiles are sealed;
the mode's default budget stamps filings that name none; plain scopes
only (tournaments and comparisons keep their human ceremony); anonymous
roads never auto-seal. The revision-seal road auto-approves when the
sealer is the signer, inside the same transaction. PLAN PINS (P2/C7):
`task plan --provider --model` binds the PLAN phase only, precedence
pin > flags > config, refused while a planner's claim is live. Nine
surface tests. Suite 1364. Layers 1–7 all shipped, each behind its own
closed Codex loop; the round-1 verify of this layer is queued.


**2026-08-27 — Layer 6, round 2 closed: the belt covers every road.**
Codex round 2 verified all four round-1 closures and found five more,
now closed. The vouch-then-write race: `approver add` runs detection,
vouching, and the save in ONE transaction — a voucher revoked
concurrently loses, there is no between. The belt's missing roads: the
mode-liveness re-proof became ONE store question (`modeApprovalLive` —
clock-checked signature, exact digest, active signer, correlated
through the built-in reference precisely) asked by the raw `acquire`
primitive every claim road shares (typed `mode-ended` refusal, CLI
included), by `acquireIfReady`'s predicate, and by the builder's last
gate before money — a custom driver with a stale claim refuses there
too. The demotion sweep's correlation now names `backend='built-in'`
on both subqueries, so a same-id external-tracker reference in another
repository can neither demote a foreign scope nor mask a live claim.
The join limiter's source key honors the documented same-host TLS
proxy: a loopback peer is the proxy, and only then is the forwarded
chain believed — last hop, the one the trusted proxy itself appended.
The content-type guard compares the exact media type. Three regression
tests (raw-road refusal + the one shared question, exact built-in
correlation, prefix-shaped media type). Suite 1355.


**2026-08-27 — Layer 6 hardening: the Codex round-1 findings, closed.**
APPROVE-WITH-CHANGES with two high findings, both real. (1) The CLI
escalation: `approver add` vouched on a bare stored-hash match, so a
VIEWER'S or a REVOKED person's credential could mint a working approver
— the one ceremony site that forgot the role. Vouching now goes through
authenticateApprover like everything else. (2) The R-REVOKE hole:
scope approvals sealed under a mode stayed dispatchable after the mode
(or its signer) died. Closed on BOTH sides — the reconciliation road
now also demotes mode-sealed, still-queued, unclaimed approvals back to
the human ceremony (running and finished work keeps its history), and
the dispatch gate grew a belt: a mode-basis approval re-proves its
digest is STILL the live mode's, signer active, expiry checked by
clock — so even the window before an expired mode is durably closed
cannot dispatch. The D7 claim is also NARROWED in words: standing acts
completed with full ceremony (grants, worktree setups, routines,
password-sealed approvals) deliberately survive their author's
revocation — revocation ends derived authority, not history. (3) The
concurrent join loser now reads as 'gone', never as a name collision:
liveness is proved FIRST inside the join transaction. (4) The sign-up
limiter became per-source buckets (10 per source, refilling slowly)
under a global ceiling, and is spent only by WELL-FORMED submissions —
a stranger's malformed flood no longer drains the door for everyone.
Six regression tests: both escalation roads, mode-revocation and
signer-revocation demotion, the running-task boundary, the expiry
window belt, the indistinguishable join loser. Suite 1353.


**2026-08-27 — Modes arc, layer 6 of 7: invites and People.** The
instance learns to hold more than one person, without a single new
authority road. THE JOIN DOOR (D6/E3): `people invite` (CLI) and the
People screen's password ceremony mint a single-use link — 128-bit
token, sha256 stored, role PINNED at mint ('viewer' watches everything
and can act on nothing; the central gate and authenticateApprover
already spoke viewer), 72-hour expiry, revocable. `/join/<token>`
answers before authentication, cookie-free and script-free; every dead
shape — unknown, expired, revoked, consumed, attempts spent — is ONE
indistinguishable page, and only a LIVE token earns real words (name
taken, weak password). Submissions meter ADMITTED attempts: one atomic
UPDATE spends the slot BEFORE scrypt runs, the door dies at ten, and
nothing refunds; a per-process bucket (30 per 10 minutes across all
invites) makes brute force pay in time before any token is looked up.
The commit is one transaction — invite CAS + unique-name account insert
+ pinned role — and the session cookie mints only after it. THE
SEVERING REVOCATION (D7): `people revoke` / the People screen's
password ceremony stamps revoked_at/revoked_by, bumps the credential
generation (live cookies die at their next lookup — the session table
already re-proves generation per hit; bearers die at
authenticateAccount), closes their open attended authorizations,
revokes their unconsumed invites, revokes every mode THEY signed with
the typed 'signer-revoked' event — each demoting its derived merge
authority through the one reconciliation road — and sweeps Telegram +
push bindings. The last active approver cannot be removed; history is
never rewritten. THE PEOPLE SCREEN: approvers see everyone — standing,
live sessions, open watched tasks, recent acts read from the rows that
were already author-stamped (approvals, decisions, steers, mode events,
merge unblocks — no new event kinds), open invites with failed-attempt
counts; a viewer sees exactly themselves. Merge blocker lifts became
stamps (lifted_at/lifted_by) so "who unblocked which merge" has rows to
stand on — and a later repair can block the same publication again. The
review phase joined the /system agents card. Eleven-test suite, store
and real HTTP. Suite 1347.


**2026-08-27 — Layer 5 verify closed: the upgrade fails closed.** Codex
round 2 on the hardening: APPROVE-WITH-CHANGES, every round-1 closure
verified (the patch re-proof, the typed authority columns with the
exact-digest re-proof, the failed-capture refusal, the one-transaction
admission — and the read-confinement boundary ruled acceptable for this
slice given the planner's identical posture, with OS sandboxing tracked
separately). The one blocking finding: an open review request queued by
the PREVIOUS commit's code as a `mode:…` display string would inherit
basis 'human' from the column default at migration — surviving the very
revocation R-REVOKE exists for. Now the migration detects the pre-typed
shape (table exists, basis column absent) and spends every open
pre-typed request as `legacy-untyped` before the typed columns land —
legacy display strings are ambiguous with human names, so NO pre-typed
request keeps authority; a person simply asks again. History keeps its
words; the sweep runs exactly once. Migration regression test drops the
typed columns to recreate the old shape, reopens, and proves the spend,
the preserved history, and that fresh typed requests survive restarts.
Suite 1336.


**2026-08-27 — Layer 5 hardening: the Codex round-1 findings, closed.**
The implementation verify came back REDESIGN with four real holes, each
now a regression test. (1) Scratch hygiene re-proves the PATCH itself:
after the agent, `REVIEW-DIFF.patch` is reread on a no-follow
descriptor and must still hash to the sealed artifact's record — an
overwritten, replaced, or symlinked patch is dirty scratch, because
comments would describe bytes nobody sealed; directory entries must be
regular files. The confinement boundary is now named honestly in the
module header: read confinement is the provider's read-only stance (the
planner's posture — policy, not proof; OS sandboxing stays the tracked
follow-up), while ingestion is the proved half. (2) R-REVOKE binds the
EXACT digest: review_request gained typed `basis` ('human'|'mode') and
`mode_digest` columns — authority lives in the columns, never in the
requested_by display string (an operator literally named "mode:…" is
human), and dispatch requires the ACTIVE mode's digest to equal the
queued one — a renewal is a new signature and inherits nothing from its
predecessor's queue. (3) A failed diff capture (stderr stored as the
artifact) refuses the request outright (`diff-capture-failed`) instead
of spending the run's one review on an error message. (4) Admission
became ONE transaction (`store.admitReview`): claim the request,
re-prove the mode, reserve the daily rail, open the reviewer run — one
winner under concurrent passes, one rail reservation per actual start;
a railed refusal leaves the request OPEN for a later pass; a crash
after commit leaves a spent request plus an outcome-NULL run (the run
table's own honesty) instead of a request no pass can ever consume.
Five new tests: exact-digest renewal kill, basis-vs-display imposter,
one-winner admission + crash shape, atomic rail refusal, patch
tampering. Suite 1335.


**2026-08-26 — Modes arc, layer 5 of 7: the reviewer.** The
artifact-only role (R1–R4 under the D5/D8 rulings): an agent pass over
one finished run's SEALED terminal diff and nothing else — no worktree,
no branch, no repository. src/reviewer.ts materializes the VERIFIED
artifact bytes (hash re-proved on the descriptor read) into an empty
scratch directory; a truncated diff is refused before any money; after
the agent, the scratch may hold exactly the patch and the one mailbox
(`STANDING-ORDERS-REVIEW-…`) or nothing is ingested. The parser is
strict and wholesale (≤ 40 comments, notes ≤ 500 chars, closed severity
vocabulary note/question/problem), and PATCH-LOCALITY is proved at the
seam: every commented path must appear in the reviewed patch — the
brief admits the reviewer saw only the diff. Ingestion is one proving
transaction (D8): the authoring run must BE role 'reviewer', parented
to exactly the commented run, sharing its task, and the artifact must
be that run's own terminal diff; rows land as ordinary diff_comments
with `reviewer_run` + `severity`, author `reviewer:<provider>·<model>`,
in the same prune-and-seal flow as human notes — sealing stays human.
`startRun` became a discriminated union (the reviewer arm carries NO
workspace; the v29 exclusive CHECK refuses every mixed shape), Run's
branch/worktree went honestly nullable, and the compiler enumerated
every workspace consumer for its guard: live peek says "reviewed the
sealed diff — no workspace existed", editor links don't form, the
continuation dispatcher refuses branchless parents (the guard that
keeps "null" out of `git worktree add`), contest picks and the brief
print null-safe. Requests ride a durable review_request queue through
ONE door (`store.requestReview`, typed refusals: unfinished, no diff,
truncated, already-reviewed, already-requested) with one review per
source run EVER (partial unique on parent_run). Triggers: `task review
<run-id>` (credentialed, queued) and the reviewAuto mode term — the
disposition service queues on built-with-changes under a live mode, and
the tick's review pass RE-PROVES the mode at dispatch (R-REVOKE: a
mode-derived request whose mode died is spent unrun, falling back to
the human ask). Rails count reviewer starts like any admission; the
review phase joined phase_config routing (`config set review`) with
plan-shaped timeout clamps; failures are typed `reviewer-<reason>` runs
— visible, additive, never blocking the task, never retried (R4).
Sixteen-test suite. Suite 1330.


**2026-08-26 — Modes arc, layer 4 of 7: the merge machine.** The
fourteen-transition table (E1) is now the code, and the five-round
Codex review chain closed with an APPROVE on exactly this layer's two
rulings. Creation binds the repo's live posture: no mode = the grant's
own signature (unchanged, as signed); a notify mode = `waiting-human`
even under a merge-capable grant; an automerge mode = basis 'mode'
bound to the signing digest. The reconciler grew its missing NOTIFY arm
— signing the stricter posture demotes even grant-basis pending
intents, while revocation/expiry demote only mode-basis rows (a grant's
own authority is never retroactively restricted). `waiting-human`
releases only through the EXACT-INTENT ceremony (`publish merge <pr>`,
password, covering one named commit — a moved head refuses).
`claimed → firing` is a DURABLE CAS inside one transaction that
re-proves the live grant's terms against the hash the intent was
written under, the exact head, and the basis-specific authority (live
automerge mode with the bound digest; the absence of a stricter notify
posture for grant-basis) — the one-winner linearization point:
revocation-first moves the row and the CAS races out; firing-first is
undemotable and the issued `gh pr merge` is one-shot.
`settleMergeIntent` became state-specific and TERMINALLY MONOTONIC — a
stale claim owner can no longer overwrite an observer-settled terminal
(the pre-existing v21 overwrite bug, closed). Stale-firing recovery
(F1): past its stamped deadline the sweep rereads the remote
structurally — observed terminals settle with a generation bump; an
OPEN same-head PR is NEVER auto-retried and pages the person for
`publish refire <pr>`, which re-enters the full road. The remote-state
observer now settles every nonterminal (waiting-human and firing
included) on an observed MERGED/CLOSED, generation bumped so late
writes lose. Nine-test machine suite covering both race orders, the
in-CAS re-proofs, monotonic terminals, refire staleness, and expiry
reconciliation. Suite 1314.

**2026-08-27 — Modes arc, layer 3 of 7: operating modes and the daily
rails.** The heart of the arc — the signed envelope itself. src/modes.ts
owns the terms (permission default, auto-approve, quick-mint,
review-auto, per-attempt budget, the two daily rails, publication
posture), a domain-separated 32-hex digest, strict rehydration, and
every term IN WORDS — including the reversal sentence verbatim ("your
signed-in browser session becomes a spend credential for this
repository"). Two presets (standard, hands-off) are starting points the
ceremony renders in full; the signature always covers resolved terms,
never a label. Store roads: activeMode (unrevoked, unexpired, its
signer STILL an active approver — D7's belt, so a missed cascade can't
leave a dead signer's authority alive; expired rows close durably on
read so the partial unique never wedges a replacement), signMode
(closes the predecessor + reconciles the repo's nonterminal merge
intents to the new posture atomically), revokeMode (one click for any
approver — the v4 doctrine that lowering authority needs no ceremony),
reconcileIntentsForMode (the ONE F2/R-REVOKE road: automerge rebinds,
otherwise waiting-human, firing untouched), and reserveModeRail (the
atomic run-count reservation — two watch loops cannot both slip under
it — plus the soft measured-dollar rail). scope.ts gains
fileAndSealUnderMode: file + seal in ONE transaction that re-proves the
mode, actor==signer, and auto-approve — never sealScopeApproval after a
filing (the TOCTOU). CLI `mode set/show/revoke` (set is a password
ceremony refusing automerge without a merge-capable grant; revoke is
one click). The tick reserves the rail before every ordinary/planner
start (1) and every tournament admission (terms.n), attended bypassing.
12-test modes suite; the surface guide, envelope sweep, and CLI router
all learned the verb. The console filing-route auto-approve wiring and
the quick-mint/banner/ceremony screens ride layer 7's surfaces. Suite
1305.

**2026-08-27 — Modes arc, layer 2 of 7: identity splits from
authority.** `authenticateAccount` returns who a credential belongs to
and what standing they hold; `authenticateApprover` becomes that plus
ACTIVE approver standing — so all ~40 password-ceremony sites now
enforce the role without one of them changing, and a revoked account
authenticates nowhere. Viewers log in (the session and bearer identity
both carry the role), read every screen the ceiling admits, and hit ONE
central POST gate that refuses everything consequential with the
viewer words — cookie and bearer alike — behind an EXACT allowlist:
the new session-only `/projects/select` (the durable-upsert
`/projects/open` stays an approver's act, the round-2 catch) and the
editor-link preference. The attended beat gained its role check inside
its own guard — round 2's predicted enumeration-miss: a viewer's open
tab now renews nothing. Tests: the viewer matrix (scope/steer/task-add
refuse and nothing lands; select works with csrf; open refuses; beats
refuse with their own words; bearer refuses; a revoked credential dies
at login while the approver road is untouched). Suite 1293.

**2026-08-27 — Modes arc, layer 1 of 7: schema v29.** The substrate for
operating modes, the reviewer role, and multi-user — shipped first per
the review's own ordering while round 5 confirms the chain's last two
rulings. Additive: operating_mode (+ one-live partial unique) and its
event table, invite (admitted-attempt metering column), mode_rail
(per-repo per-UTC-day reservation counters), approver role/revocation,
authorization and task_scope authority provenance, diff_comment
reviewer_run + severity, task_ref plan pins, merge_blocker lift stamps
(the in-table UNIQUE became a one-LIVE partial unique so lifted rows
never block re-blocking). Rebuilt with exact dual-equality recognizers:
run (role gains 'reviewer'; branch/worktree conditionally NULL under
the EXCLUSIVE check — artifact-only reviewers carry no workspace, no
sentinels), phase_config #3 ('review' joins the phases), merge_intent
(waiting-human + firing states, authority_basis grant|mode|human,
firing_at/firing_deadline for the one-winner CAS). Three migration
traps closed on the way: an earlier rebuild must wave LATER fresh
shapes through (a fresh v29 database is born at the newest DDL and
v26's recognizer ran first); canonicalDdl now strips SQL comments
(prose is not shape — the fresh literal carries comments its
recognizer constants do not); and the fresh run literal finally folded
in the historical phase/contestant addColumns whose append-at-end
order broke canonical equality. Bonus from a newly ambiguous column:
live Telegram bindings now also require an UNREVOKED approver — a
piece of the revocation cascade, delivered by the compiler. Suite 1290.

**2026-08-26 — Parallel sessions, round 1 folded: the attention mode is
a signed term.** Codex returned APPROVE-WITH-CHANGES (9 findings)
minutes after the implementation landed; everything actionable shipped
the same evening (design-parallel-sessions-v2.md has dispositions). The
load-bearing ones: `attentionMode: "console-visible"` now lives IN the
signed AttendedTerms — liveness is an admission predicate, so the beat
model is something the password agrees to, and beat-all REFUSES a
legacy page-bound signature rather than silently widening it; the
final custody proof reordered to custody-then-consume with a
throw-rollback, because a refusal returned from inside transact()
COMMITS — the old order left a run-held refusal with the one attempt
already spent (pre-existing since v25, now tested: run-held and
session-cap both leave attempt_run null); the session cap moved INSIDE
that transaction (two up watch loops racing a cap of one cannot both
insert); a budget-full tick keeps scanning for live authorizations so
--max never starves the operator's own sessions, and a held-only pass
reports success; the orphan sweep seizes first and kills concurrently
(startup pays one socket timeout, not eight seconds per orphan);
close() clears its deadline timer and returns the unsettled for up to
page durably; the beat gained its CSP bit (chrome pages carry
connect-src 'self'), rides sensitive pages EXCEPT the script-free
one-time-secret pages (the stated liveness exception), and checks the
origin allowlist beside Sec-Fetch-Site — the parameterless-vs-csrf
disagreement is documented, not hidden. Deferred with names: the two
tick-harness e2es (mixed-order --max, held-only pass), the
legacy-terms beat exclusion test, the workbench sessions rail. Suite
1289 → 1290.

**2026-08-26 — Parallel attended sessions (v28): the fleet converses.**
Alex: "we need the unlimited parallel agents/sessions feature now." The
Phase-2 architecture was per-session all along — the coordinator a
Map of controllers, one supervisor and socket per session, plural
sweeps, capacity already excluding held claims — so the singular was
ONE partial unique and its plumbing. Spec design-parallel-sessions.md
(+ implementation addendum; Codex round retrying against capacity, the
competing self-review verified the receipts: close() already fences the
whole map under one deadline, held launches already bypass --max).
Shipped: v28 drops `one_held_session_per_runner` (indexes need no
rebuild), the `runner-holding` refusal and its arms go with it; the
liveness beat moves from the task page to the CHROME layer as
`/session/attended-beats` — parameterless, cookie + form content-type +
`Sec-Fetch-Site: same-origin` as its own complete guard ahead of the
shared csrf gate, approver-bound (beats every open authorization the
signed-in approver minted on this runner, nobody else's), renewal-only
— a KNOWING reversal of v2 S2f's per-page binding, because one
foregrounded tab per session cannot scale and the signed envelope was
always the real bound; ceremony and card words now say "your console
being open keeps this session live". Sessions are unbounded by default;
`--max-held-sessions <n>` skips further launches in words against the
DURABLE custody count (a restarted up with orphans pending must count
them). Fleet and /system runner cards say "N attended sessions". The
proof: a two-session coordinator e2e — both hold on one runner (the
exact insert v25 refused), briefs settle independently, an operator
turn concludes A while B idles untouched, ledgers disjoint, custody
2→1→0 — plus a v28 migration test (old index recreated, wound back,
reopened: index gone, two custody rows coexist, run-held still
refuses). Suite 1286 → 1289.

**2026-08-26 — Phase 0: the 0.4.0 release, reconciled and proven.** The
version story was the loudest gap on the comparison page: npm at 0.3.0,
the lockfile still carrying the project's old name at 0.2.0, the README
contradicting itself (one line said 0.3.0 pending, another said the
release was 0.2.0 — while 0.3.0 had shipped on the 21st), DESIGN's
header frozen at schema v20. Reconciled to the strategy's exit
criterion (ruling 14): manifest 0.4.0, lockfile regenerated under the
right name (`npm install --package-lock-only`), README's status section
rewritten to what 0.4.0 actually carries (the attended core, the
attested runtime, comparisons — everything since 0.3.0), DESIGN header
brought to v27. The proof is a fresh `npm pack` inspection: name
standing-orders, version 0.4.0, 126 files — dist (supervisor.mjs
riding along), package.json, README, LICENSE, nothing else — and the
packed CLI cold-runs from the extracted tarball. Suite 1,286 at the
pack. The publish itself is the operator's act:
`npm publish` from the repo root (prepublishOnly re-runs typecheck +
build), then `git tag v0.4.0 && git push origin v0.4.0`, then verify
cold with `npx standing-orders@0.4.0 --help`.

**2026-08-26 — Slice B cross-check folded: the Codex round lands on
attempt five, and the resume road grows real bounds.** Codex capacity
returned mid-evening and the queued review of the comparison chain came
back REDESIGN with twelve findings — reviewed against the
pre-implementation tree, so two (the one-active index recreation, the
async-attestation placement) were already closed in the shipped code,
and the rest are dispositioned in design-comparisons-v3.md. Folded
here: the CUMULATIVE CLOCK (a comparison lane is bound by three sealed
clocks across its whole lineage — every resume re-armed the per-attempt
timeout, so a park/answer loop could have run forever); the ANSWERED
BATCH (the resume pass marks every answered lane active BEFORE running
any — the first finisher's aggregation was stranding later answered
lanes as permanently parked, a pre-existing race bug too; every bail
arm reverts its lane for the next pass); the LINEAGE ROLLUP (comparison
glance cells sum dollars and tokens over main + resumes + repairs
instead of reading the newest run); custody refreshes on every re-park
(the stale-head false-stop is closed); the resume settlement stamps
failure reasons like the initial one; `contest show`, board chips, and
the task card all speak kind words; the pick tuple binds kind; the
discipline gate's refusal no longer promises a race that pricing might
refuse. Deferred with names (task #90): contest-lane quota/capacity
atomicity (inherited from the tournament machinery, neither widened nor
narrowed), failure-message retention beyond reason tokens, and
decision-wait's deliberate exclusion from contest escalation (the
parked decision pages through its own deadline machinery). Suite 1286
(one new index assertion; the flake that showed once mid-sweep was the
documented tournament-resume 1-in-10, green on rerun).

**2026-08-26 — Parity II Phase 3, slice B: labeled comparisons — all
four runtimes, side by side, no lies about money.** The contest
machinery learns ONE discriminator instead of a fork (DESIGN §9d):
schema v27 rebuilds tournament_terms with `kind` and kind-aware money
CHECKs (races keep positive budgets; comparisons pin 0/0/0 — the
recognizer demands full canonical-DDL equality BOTH directions, the v26
lesson), contest carries the denormalized kind, and `comparison/v1` is
its own digest domain over ordered lanes with full profile digests —
race/v2 fingerprints byte-unmoved. `planComparison` admits claude,
codex, gemini, and openrouter with exact models and NO dollar fields;
the discipline gate refuses an all-raceable lineup toward the
tournament road ("race them instead" — `all-lanes-raceable`).
Spec design-comparisons.md + a COMPETING SELF-REVIEW (Codex capacity
still out; verdict REDESIGN, 7 findings, receipts in the chain) + v2
delta. The self-review's critical catch shipped as the load-bearing
fix: the decision-wait resume road computed remaining = budget −
accounted and STOPPED any lane at ≤ 0 — every parked comparison lane
would have died the instant its answer landed; the road now branches on
kind, and the e2e proves a parked gemini lane resumes. Also from the
review: contest failures now stamp their reason onto the run
(kind-agnostic — a wordless "lane 3 failed" when a binary drifts out of
its attested range was exactly the silence the attested runtime rules
out), all four money-word sites branch (glance cell "tokens only
(N tokens)", header "measured on the lanes that report dollars",
abandon and pick drop reservation language for lanes that never had
reservations), and contestantProfileOf gained its gemini branch (a
gemini string used to flow into the codex shape via the fallthrough —
unreachable until comparisons made it reachable). Surfaces: scope form
lane rows + `--compare provider:model[,…]` CLI twin, both filing inside
the shared scope+terms transaction; approve card restates lanes with
per-lane money words under the same joint digest; contest screens,
holds, notifications, and decision subjects all speak "comparison"
through one words helper. The e2e drives a mixed three-lane comparison
through the real tick with one polyglot stub speaking all three argv
dialects and a fake attested gemini on PATH: park → answer → RESUME →
pick-wait, measured/pre-latched flags per lane, the attested version on
every gemini run. Codex cross-check of the whole chain queued on its
capacity returning. Suite 1277 → 1286.

**2026-08-26 — Parity II Phase 3, slice A: the attested runtime — a
third provider, admitted by proof.** Gemini CLI joins as the ONE funded
tier-2 adapter, through the framework the strategy priced: versioned
semantic attestation (DESIGN §9d). Spec chain design-gemini-adapter.md
v1→v4, three Codex rounds (REDESIGN, REDESIGN, APPROVE-WITH-CHANGES; 27
findings, every one folded), grounded in probes of the real CLI at
0.57.0 — the captured exit-41 auth envelope is a fixture verbatim — and
a source audit of the v0.57.0 tag's stream-json formatter. What shipped:
schema v26 (phase_config's provider CHECK widened by a rebuild whose
recognizer demands FULL canonical-DDL equality — containing the old
CHECK text is not being the old shape); the `GeminiProfile` variant
sealing `--approval-mode` (auto_edit files by default; yolo is the same
ceremony class as claude's bypass, derived in ONE helper); `attest.ts` +
the gateway gate: every spawn probes one PATH-resolved realpath it then
executes, plain-release-only semver inside [0.57.0, 0.58.0), the version
riding the same pre-spawn durable write as provider_started_at;
`invokeAgent` returns a VALUE-shaped union — `provider-unattested`
(race-only; the tick's pre-claim skip reads the sealed approval snapshot
and never claims out-of-range work: zero runs, zero churn, proven by a
two-pass test) and `provider-protocol` (exit 0 without init + a success
`result` terminal, or a minted `--session-id` the init failed to echo —
refused before the handoff is ever read, spend still recorded); the
gemini retention runner assembling assistant deltas into one
`synthetic_message` line capped in serialized UTF-8 bytes; the
fresh-session repair road (resume unproven ⇒ audit says "none", repair
briefs quote the malformed payload through the standard per-line fence,
every turn mints a new identity); money honesty end-to-end (tokens
only, tournament-ineligible in its own words, "measured across N of M"
on the console, routines, /done, and /runs). One pre-existing landmine
fixed on the way: the tick force-fed DEFAULT_BUILD_TIMEOUT_MS into the
dispatch proof, stale-approving every profile whose sealed clock is
shorter than claude's — the tick now asks for nothing and the sealed
profile governs. Implementation review: Codex ran out of
capacity mid-verdict (its partial pass confirmed the v26 recognizer,
the pre-spawn stamping, and the timeout fix sound, then died naming
nothing), so per this project's standing fallback a competing self-
review ran instead and closed four real findings — warm park-resume was
provider-blind (a gemini park would have rendered `--resume` against an
unproven road; now gated on the audit), the diagnostic promised
control-normalization + secret-scanning and only had a byte cap (now
`safeDiagnostic`: controls collapse, a secret-tripping line is withheld
in words), both truncation markers now ride INSIDE their byte budgets,
and the planner road now mints session identity too. A Codex verify of
this commit is queued for when capacity returns. Live-auth spike items
S1–S4 (headless session persistence, trust gating, real happy-path
bytes, env visibility) wait on an authenticated `gemini` on this
machine; every default is fail-closed without them. Suite 1230 → 1277.

**2026-08-26 — Parity II Phase 2E.4: continuation — and Phase 2
closes.** The last A4 piece, to the reviewed rulings (v3 R7, v4 Q7, v5
P5, round-6 findings 3/5 already closed). A finished attempt's run
page offers "continue this attempt while you watch": the follow-up
text the operator types ENTERS THE SIGNED TERMS — rendered on the
confirm screen beside the parent attempt and its ACCEPTED head (built
→ the head it produced; no-change → its base; a failed parent refuses
in words and points at filing a follow-up task — a dirty preserved
tree cannot promise a clean continuation), with a moving publication
('intended', 'pushed', an open PR, a pending or claimed merge — the
concrete states, enumerated and tested) blocking the mint. The
AUTHORIZATION IS THE CLAIMABLE UNIT: `acquireContinuation` re-proves
liveness, the named runner, and the unspent attempt, then admits
through acquire's own shared gates — reservation, external mirror,
attended — while the finished parent task NEVER re-queues; its state,
strikes, holds, dependents, and (proven by test) its measured park
rate stay exactly as it finished, the park-rate arithmetic now
excluding continuation runs on both sides. tick grew the continuation
pass: open continuation authorizations named to this runner dispatch
onto the PARENT'S BRANCH — the final proof compares the leased
worktree's head against the signed accepted head, so a moved branch
refuses naming the head — and the follow-up rides the brief inside an
OPERATOR FOLLOW-UP fence, operator speech exactly like turns. The
disposition service gained the `continuation` policy: success
finishes the run, releases the claim, and opens the publication
intent under the SAME completion latch the ordinary road holds — all
one transaction — and failure records the run and releases, never a
strike, never a demotion; three failed continuations leave the parent
`done`. Suite 1230 (5 new). PHASE 2 IS COMPLETE: the attended core —
authorization, custody, ledger, conversation, continuation — is
end-to-end machinery, six ship commits from spec chain v1→v6 through
six adversarial review rounds. Next: Phase 0 release prep (0.4.0),
then the one funded adapter.


**2026-08-26 — Parity II Phase 2E.3: the badge, the dots, and the
design record.** The app-icon badge (v2 S4, round-1 finding 13's
delivery question answered): every push now carries the server-computed
waiting-on-you COUNT — the same saturated inbox classifier the
console's own sidebar badge reads, computed at send time; a number,
never content, so the closed-class push discipline holds. The service
worker sets the badge on push where supported (honest no-op
elsewhere), clears it on the notification tap, and — because a page is
always more current than a push — every chrome page load messages the
worker the server-rendered count, clearing stale badges at zero. State
dots (A5): one vocabulary — working pulses brand, waiting-on-you
warns, done succeeds, failed is destructive, queued is muted — derived
from EXISTING state fields only, ambiguous muted never green, now on
task list rows, the build list, and the task page's own run rows,
joining the board cards and fleet stats that already had it. DESIGN.md
§9c records the attended core: the signed stop-threshold budget, the
session-fatal per-turn clock, the ledger's acceptance boundary and
marginal-delta accounting, parenthood custody, and the lease-based
orphan predicate. Suite 1225. Phase 2 remaining, named: continuation
(A4 — mint from a finished run with the follow-up in the signed
terms, its own claim path, taskless dispositions).


**2026-08-26 — Parity II Phase 2E.2: the conversation — a held session
becomes a two-way channel.** The coordinator stops concluding at the
first settled turn and CLASSIFIES it (v2 S1f): a terminal handoff
concludes through the shared settlement; a park records the decision
and the session STAYS HELD; an `error_max_budget_usd` result ends the
hold typed; and a settled turn that left neither file is simply a
pause — the session waits, watching. The mid-session park
(`finalizeParkHeld` in claim.ts) preserves the payload as evidence and
unlinks it exactly like the ordinary road, records and pages the
decision WITHOUT ending anything — no lease release, no run outcome,
no task-state change — and stamps `decision.session_turn`, the causal
link the round-6 review demanded, with the one-unresolved-per-run
partial unique refusing a second open question. Answers persisted from
ANY surface reach the live session: the coordinator's pulse scans
`undeliveredDecisionsOf` (an index-backed read), the beat and answer
pokes trigger it immediately, and the injection rides the same
delivery-CAS as everything else — exactly-once whatever raced, with
`run_decision` attaching only at the turn's proven acceptance. A
malformed park takes the HELD REPAIR road (round-6 finding 3): the
repair prompt is a machine-authored ledger turn in the SAME session,
correlated to the PRODUCING TURN (a malformed mailbox has no decision
id to correlate by), bounded per source; exhaustion disposes through
the shared malformed machinery — incident, hold, page — never a
silent interruption. The operator's own voice ships with it: the run
page grows a CONVERSATION card — every stdin injection as the ledger
records it, machine turns labeled as machine, unconfirmed turns
saying honestly that the agent may or may not have seen them — and a
TURN BOX (POST /r/<id>/turn, cookie-only, 500 characters) whose every
hard gate re-proves atomically inside the recording transaction; the
route only maps refusal tokens to sentences ("answer the waiting
question first", "the agent is still working on the last message").
The per-turn wall deadline became a single re-armed timer — armed at
every write, cleared at every settlement — so a conversation is
bounded per exchange, not per session-lifetime. The whole loop is
proven end-to-end by one test: brief → idle hold → operator turn →
mid-session park with its causal link → free-form speech refused
while the question waits → answer injected exactly-once → the handoff
written on the answer turn concluding as a real `no-change` — three
ledger rows, every injection accounted. Suite 1225. Remaining in 2E:
continuation, state dots, the badge count, and the :4180 restart.


**2026-08-26 — Parity II Phase 2E.1: the attended ceremony reaches the
console — mint, beat, revoke, and the race exclusion made atomic.**
The road shipped in 2A–2D gains its human end. A task with a filed,
unapproved scope on an `up` console now offers "run it once while you
watch": the button leads to a CONFIRM screen where EVERY term renders
in words — goal, exclusions, touches, the pinned claude model and its
permission posture, repository at the EXACT head, the worker, the
budget as a stop threshold ("stops as soon as its total crosses this;
the final step may run a little past it"), the message cap and the
session-fatal per-turn clock ("one that runs past that ends the whole
session"), the repair-rides-the-same-session term, the
watching-is-the-page term, and the absolute expiry — and one password
signs exactly that: the composite digest (new `AttendedTerms` +
`attendedDigestOf` in scope.ts, domain-separated, expiry FIXED at
preview so the proof is matchable) is re-derived from LIVE state at
the yes, and anything that moved between reading and signing refuses
with 409, proven by test (the scope moves mid-read → nothing mints).
The mint is the first beat; from then on POST /session/attended-beat
— cookie-only, CARRYING the authorization id so a page watching task
A can never keep task B alive — writes the durable clock every 15
seconds while the task page is visible, paused exactly when the tab
hides. The open authorization renders as a card (watching state,
messages used, spend against budget, hard end time) with its revoke,
and revoke closes it and pokes the coordinator. Round-6 finding 5 is
closed on BOTH roads: scope proposal, the attended exclusion, and
race-term filing now share one transaction in the console form and
the CLI (`task scope --race`) alike — a refused race leaves the scope
byte-identical, proven by test — and both tournament directions
refuse (an open authorization blocks race filing; filed race terms
hide the offer and refuse the preview). Suite 1224 (4 new HTTP
ceremony tests). Remaining in 2E: the conversation loop (turn box,
held-park, answer injection, held repair per round-6 finding 3),
continuation, state dots, badge.


**2026-08-26 — Parity II Phase 2, round-6 cross-check fixes.** Codex's
round-6 review of spec v6 (the cross-check queued behind its rate
limit, landing after 2A–2D had shipped) returned REDESIGN with eight
findings; each was verified against the shipped code, six applied, and
all six are fixed. (1) CRITICAL, terminal fencing vs the transactional
gates: the coordinator's fence now opens with a TERMINAL SEIZURE —
CAS to 'fencing' plus the lease fence — so during the grace window a
late external admission or stale write refuses in ITS OWN transaction,
not merely against this process's in-memory flag; losing the CAS means
an external fencer owns settlement and the coordinator steps aside;
conclusion likewise stamps ended_at BEFORE anything awaits. (2)
CRITICAL, answers riding the brief: the builder's ordinary pre-spawn
attach claimed delivery the agent never proved — the held road now
WITHDRAWS those run_decision rows, CASes each decision's
delivered_turn to the brief turn, and acceptance re-attaches exactly
like an answer turn; a brief that dies unaccepted reverts every claim
it held, and the revert/attach machinery is generalized to any turn
carrying deliveries. (4) group drain: a tool can outlive its agent
leader, so the supervisor now drains the WHOLE process group to
proven-gone before custody releases on any child exit, and `status`
reports group custody, never one pid's liveness. (6) the held road's
receipt: attached steering settles delivered at the brief's
acceptance — the same proof the one-shot transport's onReceipt
carried. (7) capacity vs attended admission: attended authority now
skips the capacity gate (its bound is one-held-per-runner), so a full
unattended ledger cannot refuse the operator who is watching. (8)
expired-but-unconsumed authorizations: past absolute expiry the claim
gate honors nothing (an approved task is never locked to a corpse's
named runner), and tick sweeps them durably closed each pass. The two
remaining findings target 2E surfaces not yet built and are carried
into that slice: held repair correlates to the producing session_turn
(a malformed mailbox has no decision id) with evidence obligations and
the signed same-model/same-turns repair terms rendered on the form;
and the race-filing exclusion must share ONE transaction with scope
proposal on the race branch. Suite 1220 (3 new).


**2026-08-26 — Parity II Phase 2D: the attended road runs end-to-end —
coordinator, dispatch splice, claim gates, custody fence.** The
HeldSessionCoordinator (new src/held.ts) is the one owner of held
sessions in an `up` process: build() reaches its spawn point and hands
over — pulse cleared, live-log handle transferred, run/lease/worktree
ownership moved — and the watch loop keeps dispatching (the round-5
critical: held claims are also EXCLUDED from the capacity count, so
the default solo runner never freezes). The coordinator runs the FINAL
transactional proof at the actual HEAD — live scope digest, pinned
profile bytes, repo, head, named runner, each divergence refusing
`stale-authorization` naming the moved term — consumes the one attempt
and writes the custody intent in the same transaction, records the
brief as turn one, spawns through the held gateway, stamps pids (a row
closed underneath the spawn kills the child synchronously), and arms
the EXACT clocks: absolute expiry, durable-beat lapse, per-turn wall
deadline, credentialed lease pulse. A settled turn concludes through
THE SHARED settleProviderOutcome → disposeBuildOutcome pair — the
held happy path in the tests ends as a real `no-change` run with its
marginal-delta ledger charge on the run row — and every fence road
(expired, lapsed, revoked, turn-timeout, lease-lost, telemetry,
shutdown) settles conservatively to the real word `interrupted`.
Dispatch: tick's pre-filter learned the attended case (v6 W1) — a
live authorization naming this runner dispatches with the PINNED
profile as its spec and typed `attended-only` skips otherwise, never
the generic `unapproved` that masked the road; acquireLocked gained
the shared-primitive gates (`attended-held` with its own reason token
— never the reserved contract — and `attended-only` with the
expiry-never-converts rule); acquireIfReady's approval test became the
authority union. Crash custody: sweepHeldOrphans runs BEFORE the
runner door at up startup (fence-first as a store invariant — generic
recovery now EXCLUDES open custody rows), seizes via CAS + lease
fence, kills through the supervisor's cookie socket (the kernel-stable
road), and an unreachable supervisor PAGES and keeps custody — proven
by test, including recovery refusing to touch the fenced run. up
stands the coordinator up beside the console, fences all sessions
bounded at shutdown before retiring its runner. Phase-2D scope,
stated in code: the hold concludes at the agent's first settled turn;
the multi-turn conversation loop (turn box, answer injection, held
repair) arrives with its console surfaces in 2E. Suite 1217 (6 new).


**2026-08-25 — Parity II Phase 2C: the settlement and disposition
extractions.** The two refactors the held road stands on, each proven
byte-identical by the untouched suite. builder.ts's post-provider state
machine — timeout/init/agent classification, the synchronous fence
re-proof, park ingestion with its repair turns, the branch and HEAD
laws, handoff validation, evidence capture, the commit — is now
`settleProviderOutcome(captured, result)` over an explicit
`CapturedBuild` record (v4 Q2 / v6 W8): the body moved verbatim under a
destructuring header, `build()` calls it inline, and the capture's
`fenced()` closure reads the pulse's LIVE flag because settlement
decisions are about now, not the moment of capture. And the operations
that actually END an attempt — sealing parks, accepting completions
behind the completion fence with the disowned arm and the publication
intent, strikes, quota, failure classes with their backoff/stall
dispositions — moved from tick's inlined finalizers and the standalone
build command's separate road into `disposeBuildOutcome` (new
src/dispose.ts) under an explicit POLICY record: 'tick' is the full
loop behavior, 'standalone' is that road's deliberate historical shape
(no task completion, no strikes, no publication, its own narrower
broke-list) — stated as policy, never forked logic. Both call sites
are now pure reporting over a typed Disposition. The coordinator
(Phase 2D) becomes the third caller of both functions, which is the
whole point: a held run will complete through exactly the machinery
every other road uses, or not at all. Suite 1211 green, unmodified —
the refactor's own proof.


**2026-08-25 — Parity II Phase 2B: the supervisor, the held transport,
and the held invocation gateway.** The process layer under the attended
core, to the v5-P4/v6-W7+W9 rulings. `src/supervisor.mjs` — plain
zero-dependency JavaScript, shipped verbatim by postbuild — is a
minimal parent whose whole value is PARENTHOOD: it spawns the agent
detached into its own fresh process group and holds the handle, so the
eventual kill is provable (POSIX pins the child's PID while its parent
lives unreaped) instead of a PID-plus-timestamp guess. Its stdout opens
with exactly one control frame (`ready` with the agent's pgid, or
`spawn-failed` — the two-hop handshake), then relays the agent's
stream byte-for-byte; stdin relays turns in; stdin EOF, SIGTERM, and
SIGHUP all take the same AUTONOMOUS FENCE (EOF to the agent, grace,
group SIGKILL) — so an `up` crash cleans its own session up before any
database fencer runs. A cookie-authenticated unix socket (0600, path
length asserted against sun_path at spawn) answers `status` and
`kill`, where kill replies only after the group is PROVEN gone
(ESRCH-polled) — and the supervisor's own exit DEFERS until that reply
has flushed, because a fencer must hear the proof from the process
that made it (found by the new tests: the exit path raced the reply
and ate it). exec.ts gains `startClaudeHeldSession` — no timers, no
policy: it settles the start on the control frame, counts each
system/init and each primary-origin result in stream order as the
per-turn acceptance and settlement marks (the arc-1 origin allowlist
unchanged), and hands back a handle (writeTurn / endInput / terminate
/ killHard / exited). Held supervisors register in their OWN hard-stop
registry: the sweep SIGTERMs them first — the graceful fence through
the one handle that cannot miss — and only a repeat sweep SIGKILLs,
the documented residual hole. invoke.ts gains `invokeHeldAgent`, the
held door beside the one-shot gateway: same open-run verification,
claude-only (nothing else can hold in Phase 2), same
stamp-before-spawn honesty, returning the live handle because
ownership belongs to the coordinator, never to a promise chain that
would stall the watch. provider.ts exports `claudeHeldArgv` — the
one-shot family minus the positional prompt (every turn rides stdin)
plus `--input-format stream-json`, with the remaining authorization
budget as the Probe-6 cumulative backstop. Eight new tests run the
REAL supervisor around a fake agent: per-turn counting with a split
mid-line write proving relay byte-exactness, forged control frames
dropped, spawn-failed and socket-path refusals, cookie-refused and
proven kills, and both autonomous fence roads; suite 1210.


**2026-08-25 — Parity II Phase 2 groundwork (2A): schema v25 and the
attended-core store primitives, spec-first through nine adversarial
review rounds.** The attended-core spec ran four Codex REDESIGN rounds
(findings 1–13, then 8, then 7, then 5 — each round closing more than
it opened), then, with Codex rate-limited, a three-lens competing
review (ledger, process/concurrency, admission/migration — every
finding verified against source before adoption) whose REDESIGN verdict
produced v6; a Codex cross-check of v6 is queued. Two extra protocol
probes closed the money questions: `--max-budget-usd` is CUMULATIVE
across a held process (the crossing turn dies `error_max_budget_usd`,
later turns refuse with zero spend — so the argv cap is a real
session-level backstop and the signed budget is worded as a STOP
THRESHOLD), and result usage totals are cumulative per process (the
original spike note said per-turn and was corrected), so measured turn
cost is a MARGINAL DELTA from a durable baseline. This commit is the
storage layer that implements those rulings. Schema v25:
`attended_authorization` (pre-minted UUID as the ruling-12 attempt
identity; signed terms carry a per-session turn cap and the budget;
consumed-but-open lifecycle with explicit closure; one OPEN per task by
partial unique; durable `last_beat_at` with 5-second duplicate
suppression as the authoritative liveness clock), `session_turn` (every
stdin injection a row — brief, answer, operator, repair — recorded
before written, accepted only at ITS init or proven by ITS result,
settled at the marginal delta with the baseline advanced atomically;
terminal `uncertain` charges its reservation and is never reinjected;
a regressing provider total is a telemetry failure charged
conservatively, never silently zero), `held_session` (durable crash
custody: lease-based orphan predicate, helpable `fencing` state with
deadline takeover, the settlement baseline), a `run` rebuild whose
outcome admits the real word `interrupted` plus the authorization
stamp, and a `decision` rebuild that drops the one-decision-per-run
UNIQUE (a held session parks, is answered, and parks again) while a
partial unique keeps at most one UNRESOLVED question per run and
`delivered_turn` becomes the concrete delivery-CAS target — answers
attach `run_decision` only at ACCEPTANCE, revert their claim if the
turn never got there, and the ordinary resume road redelivers exactly
as today. The recording transaction is the gate where the turn cap,
the single-flight rule, the budget reservation (= remaining budget,
the true worst case under the CLI's cumulative cap), the open-decision
rule, and a SYNCHRONOUS lease re-proof all hold or refuse atomically —
and `liveClaimCount` now excludes held claims, so one watched
conversation no longer freezes a default capacity-1 runner's whole
queue (the competing review's critical find). Migration is the
recognized-exactly rebuild recipe with the FK envelope, proven fresh,
v24→v25, and v23→v25 (both passes in order); suite 1203.


**2026-08-25 — Parity II Phase 1, foundations: approvals now bind WHAT
RUNS, and steering speaks only with a verified voice.** Three Codex
rounds on the spec (REDESIGN ×2, then APPROVE WITH CHANGES — findings
1–22, all implemented), governed by the two-round-approved Parity II
strategy. Schema v24. The heart: every scope carries an EXECUTION
PROFILE — a per-provider discriminated union of what actually runs
(claude: exact model, permission argv, 40-turn/30-minute bounds, repair
model and its 4-turn/5-minute bounds; codex/openrouter: exact model,
workspace-write sandbox, the honest "no turn limit, the 20-minute clock
is the bound") — resolved ONCE at filing through one store-level
invariant every filing road shares, bound into the digest the password
signs, and SEALED as an immutable snapshot at approval. Dispatch
rederives the approved digest from the live fields plus the snapshot
immediately before every invocation — builder AND repair — and anything
that moved refuses with `stale-approval` naming the field: a config
change after approval can no longer re-route approved work, flags can no
longer override it (`--skip-permissions` on approved acceptEdits work
now refuses outright), and the exact model always rides the argv —
nothing is left for later resolution to decide. A scope that cannot say
exactly what runs is `profile-unresolved`: saved atomically ("filed but
unapprovable"), visible, blocked from approval and dispatch until
restated — which also means a fresh install now names its model once
(`config set build --model …`) before anything can be approved.
Routines bind the profile in their own digest and FIRE from the
approved snapshot, never fresh resolution; tournaments race under v2
fingerprints carrying per-contestant profiles, each lane proved against
its own snapshot, with terms discovered before flags so a pass cannot
shape an approved race; warm resume now matches the sealed scope AND
profile digests stamped on every run, or goes honestly cold. The v24
migration grandfathers every existing approval — signed bytes untouched
(byte-pinned golden test), effective profile of the day sealed beside
them, auditable provenance — parks approved routines that cannot
resolve, and QUARANTINES every undelivered pre-migration steering note.
Which closes the live hole this phase led with: CLI `task steer`
accepted any name with no credential while briefs promoted its note
under OPERATOR STEERING; steering now takes the operator's password,
authorship is a compile-enforced `VerifiedAuthor` brand constructible
only by the two authenticated callers, the attach path takes verified
rows only, and the agent guides flipped — steering moved from the
may-do list to the never-do list, in the binary-served words agents
actually read. Approval screens say what the password signs in plain
words (including the grandfathered and unapprovable states);
`task scope` gained real `--provider/--model/--repair-model` flags
(previously swallowed silently); `src/liveness.ts` defines attended
presence exactly (15s beat, 20s live, 45s grace, future = lapsed,
renewal never mints authority) for the attended work to consume; and
DESIGN.md now carries the four-principal model, the profile rule, and
the positioning turn with its one-adapter budget. Suite: 1191.

**2026-08-24 — the onboarding follow-ups, closed: a clone can receive its
first task, the CLI grew the ceremony's twin, and the ceremony is proved
over HTTP.** The three items the repo-onboarding review left named (its
findings 15/24/35 and the companion verb), implemented and then verified
by one more Codex pass (findings 1–5, all closed). Placement: /tasks/add
now computes the EFFECTIVE home — the trimmed posted repo, else the open
project — and in root mode proves exactly that path with
authorizedProject, admits exactly [canonical], and upserts it into the
projects on success, so a freshly cloned repository can receive its
first task without appearing in any table first; /routines/add proves
the open project the same way. The verification pass caught the guard's
shadow: an EMPTY placement on a scoped console now refuses server-side
(a form's `required` is a courtesy, not the guard), the no-project
filing form says the rule in words, and unscoped consoles keep their
historic unplaced filings. `repos add-from-github <owner/name> --root
<dir>`: the console ceremony as a CLI verb — strict dedicated parsing
dispatched BEFORE the registry load (a malformed registry cannot mask a
typo or block a read-only preview), preview by default with exit 3,
the same large-or-unknown gate behind --large-ok, the claim-first
clone, enrollment through the locked updateRepos — and the plain CLI
`repos add/remove` writers were converted to that same locked
primitive, keeping the updater's own failure taxonomy (a held lock is
`locked`, never "usage"). Both the console and the CLI now BIND the
clone answer to the exact promised target and normalize hook-supplied
sizes, so the new test hooks (ServeOptions.ghPreview/ghClone,
MainOptions.onboard) cannot bypass a gate the real path enforces. The
ceremony finally has HTTP proofs: card gating in both modes, preview →
password → clone → enroll → open with a real git repository, wrong
passwords, spent-nonce replays, the large checkbox, and the placement
matrix across root, repo-list, and unscoped consoles. Suite: 1176.

**2026-08-24 — arc 6, review niceties: files that open in your editor, a
review flow without friction, a tournament you can compare at a glance.**
One Codex round (APPROVE WITH CHANGES, findings 1–8), all implemented —
and with it the six-arc attended plan is COMPLETE. Editor deep links:
`serve --editor vscode` (and `up --editor vscode`) is a DEPLOYMENT
capability, not an activation — vscode:// opens on the browser's
machine, so links render only when three statements align: the operator
started the server with the capability AND `--runner`, the run belongs
to this machine's runner, and the SESSION flipped "open files in VS Code
from this device" on the build page (per-device, per-session, dies with
the cookie). Where they render — changed-file rows, review comments'
path:line, and the live peek's names — every href passes one strict
helper: absolute control-free worktree, relative single-line path with
no empty/dot/dot-dot/backslash segments, the comment form's own
1..1,000,000 line range, encoding failures degrading to plain text. The
peek links only names its sanitizer provably did not touch — a masked
credential-shaped name never carries an href disclosing what the mask
hid — and the peek cache and in-flight coalescer now vary by link mode
so one session's linked fragment is never served to another. The review
flow: commenting lands back AT the review card (`?noted=1#review`) with
the note field focused, and every changed file grew a small "comment"
button that prefills the path — client-side form mutation named as
such, riding the one composed functional script, earning neither
connect-src nor a noscript refresh. This REDUCES the unsent-note hazard
(typed-but-unsubmitted text can still be lost — said honestly); the
existing seal-into-one-revision-task remains the real batch operation.
The tournament page: an at-a-glance table (one column per agent —
outcome, changed, time, questions, cost) and side-by-side cards on wide
screens, BOTH rendered from one summary object per agent so the table
and the cards cannot tell a pick two different stories, with
verified-zero, missing-summary, and capture-failure each keeping their
own words. The diff-stat parser stopped accepting "any object with a
base key" — every rendered field is now type-proved. Suite: 1164.

**2026-08-24 — arc 5, agent ergonomics: the binary teaches its own
surface.** One Codex round (APPROVE WITH CHANGES, findings 1–8), all
implemented. Two new answers an agent can get from the exact build it is
driving: `skills list` / `skills get <name>` serve five operating guides
(operating, runner, steering, external-work, tournaments) as compiled
string constants — version-matched by construction, no file reads, no
network — and the installed SKILL.md body now COMPOSES from the same
`operating` source, so the snapshot and the served guide cannot drift
apart within a version (a hard-coded legacy fixture proves files written
by older versions are still ours to replace). `contract --commands`
dumps the DECLARED COMMAND GUIDE: every routed verb with synopsis,
audience, truthful mutation semantics (`keyed` / `identity-idempotent` /
`unkeyed` / `none` — a boolean would have lied), intended flags, and
curated reasons — with its limits stated machine-readably IN the
envelope (`authority: documentation`, flags intended-not-proven, reasons
curated-not-exhaustive), because a source comment is invisible to
consumers. Operator ceremonies are listed but DETAIL-FREE at the
subcommand level (`task approve`, `decide`, `publish grant`, `routine
run-now`, `serve`, `up`, …): a schema is not permission, and the text
dump says so in words. The guide is held to the code, not to good
intentions: the dispatchers for task/publish/config/approver/routine/
contest now consult EXPORTED action lists (unknown actions refuse naming
the real inventory — which surfaced that bare `publish` IS an action,
the publication pass), the parser's global flag vocabularies are
exported and every declared flag is tested against them with its arity,
keyed rows must declare `--key`, and every documented reason token must
appear as a literal in the source. `skills` and `contract` grew real
parsers along the way — unknown flags, missing values, and stray
positionals refuse instead of being silently ignored — and `applyInstall`
had its preflight fixed: damaged AGENTS.md markers now refuse BEFORE the
skill file is written, so "nothing was written" is true when said. Two
capability tokens joined the contract: `command-schema/1`,
`skill-guides/1`. Suite: 1157.

**2026-08-24 — arc 4, design polish: motion where a human caused it, a
board you swipe, keys everywhere it is safe.** Three Codex rounds
(APPROVE WITH CHANGES, REDESIGN, APPROVE WITH CHANGES — findings 1–24).
Two rulings held: liveness swaps stay deliberately INSTANT (a board
update that draws the eye is a defect; motion belongs to navigation,
presses, and overlays), and there is no bottom-sheet project switcher
(switching is a POST ceremony; threading its plumbing into every render
to save one tap was refused). What shipped: cross-document view
transitions as a 140 ms navigation cross-fade — pure CSS, with opt-outs
on meta-refresh pages AND inside the noscript fallback, and a
reduced-motion block that also stills the pulse dots; one restrained
accent hue used only for "you are here" and "this is alive" (active
nav, active tab, focus ring, palette selection, the live dot) — never
on verbs; the phone board became a full-width PAGER (snap-scrolled
lanes, a deliberate 1.5 rem sliver of the neighbor as the affordance,
lanes scrolling inside a viewport-bounded strip while the page still
reaches the headline above and the routines below); the region swapper
now gives back what it took — focused row, centered lane, and each
lane's scroll place, restored from bounding rects with focus last and
preventScroll so the passes cannot fight; and the chrome layer (jump
palette, g-keys, j/k row roving, a ? shortcuts overlay) went
console-wide through ONE render helper that owns the nonce, the palette
index (5 s cache, invalidated by any accepted mutation), script
composition, and the CSP — script-src only when a script ships,
connect-src only when it fetches. Sensitivity is judged PER RESPONSE:
any body showing a password input renders without the chrome additions
(tolerant classifier + forceSensitive escape hatch), so fleet and
settings keep only their functional scripts beside credential fields,
the one-time worker token page carries no script at all, and the same
task page is bare while an approval waits and chromed after it is
granted. Ceremony submits (approve-scope, tournament pick, onboarding
confirm) sit in a sticky bar above the phone tab bar; decision pages,
being option-per-card, are deliberately excluded. Browser-verified on
the live console: pager restore math exact (815 → 0 → 815), 24 px
neighbor sliver measured, overlay focus in/out, j/k roving, palette
open/close. Suite: 1144.

**2026-08-24 — repo onboarding: add a repository from GitHub, as a ceremony.**
Four Codex rounds (REDESIGN ×3, APPROVE WITH CHANGES — findings 1–39),
because a network clone writing to the filesystem is new authority. The
projects screen gains "add a repository": paste owner/name or a
github.com link, see a PREVIEW (full name via gh, visibility, size —
GitHub reports KiB, and the 1 GiB gate knows it; unknown counts as
large) before anything is written, then a password-confirmed clone that
lands under an EXPLICITLY configured --project-root and opens as the
current project. The rounds forged the machinery honest: the ceiling is
IMMUTABLE (clones admit through the existing root-derived
authorization — console onboarding is root-mode only, and the disabled
card says so in words everywhere else, up consoles included);
publication is CLAIM-FIRST (an exclusive mkdir of the final directory —
a lost race fails with NOTHING written, and the one unavoidable crash
residue, an empty claimed directory, is named honestly for manual
removal); gh runs in its own detached tree whose death is PROVEN by
polling the group to ESRCH on every outcome before any cleanup may run
(Windows cannot prove that, so onboarding refuses there); the preview
is a session-held single-use record consumed before the first await,
with session liveness re-proved at consumption; submodules and LFS
smudge fetches are off (an installed LFS filter would have fetched
objects the size gate never counted); and repos.json finally got the
locked, atomic update primitive every writer now shares — a live
owner's lock is untouchable, stale recovery requires a proven-dead pid
serialized through a reaper lock, malformed registries refuse instead
of being replaced, and up's old silent empty-registry fallback now
refuses and retires the runner it just registered. A fresh clone
enters with zero authority — no tasks, no scopes, no grants. The CLI
verb (repos add-from-github) follows in a small companion change.
Suite 1130 → 1136.

**2026-08-24 — the phone shell (arc 4, first pass): a real app on a phone.**
Screenshot-driven: at phone widths the console was the desktop squeezed —
a permanent sidebar, five lanes crammed side by side, three columns on a
task page, and the "switch project" link literally display:none on
phones. Now, below 760px: the sidebar disappears; a sticky top bar
carries the brand, the PROJECT PILL (the open project's name, one tap to
/projects), and a quick "+ task" button; a fixed bottom tab bar carries
inbox (with its badge), board, queue, builds, and "more" — which opens
/menu, an honest no-JavaScript page listing every other destination with
a one-line hint each. Board lanes keep their needs-you-first stacking;
the task page's editing surfaces (steering, scope, waits-for, acts) run
single-column and full-width. Desktop is untouched above 760px. Suite
stays 1130.

**2026-08-24 — the phone (arc 3, v23): installable console + web push.**
Three Codex rounds (REDESIGN ×2, APPROVE WITH CHANGES — findings 1–29).
The console installs to a phone's Home Screen (manifest + icons + a
DELIBERATELY MINIMAL service worker: push and the tap only, NO fetch
handler — an offline cache of an authenticated console is a data store
outside the session's control, refused by design), and the phone buzzes
when a person is needed — over a ZERO-DEPENDENCY web push stack:
RFC 8291 aes128gcm encryption byte-exact against the Appendix A vector,
RFC 8292 VAPID ES256 in P1363 form, VAPID keys minted atomically
(wx + loser-re-read + pair validation) beside the database. PAYLOAD
DISCIPLINE is the load-bearing rule: what transits Apple's and Google's
servers is a fixed phrase keyed on a CLOSED, server-owned class stamped
by producers at enqueue (decision / pick / merge / attention) plus a
machine-minted numeric console path — task titles, scope text, branch
and repo names never leave the machine, and /t/<free-form-id> is banned
from payloads outright. Push is ADDITIVE: its own (notification ×
subscription) pair ledger with owner+generation CAS transitions,
seeding gated by a transactional enrollment high-water mark (a new
phone is never backfilled with old faults), send-time fences re-proving
subscription/generation/fact-open, honest AT-LEAST-ONCE with an opaque
tag collapsing crash-duplicates, and the full RFC 8030 outcome table —
'accepted' means the push service took it, 404/410 retires the device,
401/403 is a credential episode (never device retirement), Retry-After
and exponential backoff for the rest. The outbox's own delivered_at is
never touched, so Telegram and webhooks are never suppressed. The
review rounds also fixed real gaps: tournament agents' parked questions
now page (they previously enqueued NOTHING), merge/sync faults became
EPISODES that resolve transactionally and can recur (fixed dedupe keys
had suppressed recurrence forever), and one canonical plane episode
replaced a hundred-row fan-out. Enrollment is a ceremony: password
typed again + cookie + CSRF, bearer refused, five devices per person,
bound to the approver's credential generation (rotation retires them),
lock-screen honesty on the card. The secure-origin contract is
explicit: serve/up gain --public-url (EXACTLY an https origin — the one
trust anchor; X-Forwarded-* is never consulted) which joins the Host/
Origin gates and turns cookies Secure; TLS terminates in a proxy in
front. Watch gained an independent push cadence (it runs whether or not
Telegram holds the wire); outbox deliver gained an independent push
phase; phones got the polish floor (16px inputs, 44px targets,
full-width primaries, safe-area padding). Suite 1107 → 1130. Schema
v22→v23.

**2026-08-24 — `standing-orders up` (arc 2): one command to a working cockpit.**
Four Codex rounds (REDESIGN ×3, APPROVE WITH CHANGES — findings 1–34),
because a convenience command that touches identity is where shortcuts
hide. `up` is COMPOSITION ONLY, and the rounds forced the composition
honest. New credentialed doors, each ONE write transaction:
`registerRunnerIfIdle` (take a runner name only when absent, retired,
or dead by the recovery predicate AND no watch lease is unexpired —
then finish every open run the dead holder left BY THE RUNS TABLE,
deliberately unfiltered by claim released_at so reap-released work
still requeues, findings 16/26/31), `acquireWatchLeaseAuthed` (token
verified and lease acquired together; taking over an expired lease
recovers the superseded incarnation INSIDE the same transaction),
`heartbeatWatchLeaseAuthed` + the runner heartbeat made transactional
(findings 15/25/33 — the split authenticate-then-touch let a stale
incarnation heartbeat its successor's row; now builder and planner
pulses carry the token and a takeover fences the predecessor at its
next beat), `retireRunnerIfCurrent` (cleanup fenced by the token THIS
process minted — a predecessor can never retire its successor, finding
28), and `bootstrapApproverIfNone` (insert only while the table is
EMPTY — `up` can never rotate an existing password, finding 2). The
first login is a DURABLE-INTENT file (finding 27): `up-login.txt` is
written wx/0600 and fsynced — file AND directory — BEFORE the insert;
a crash between leaves an orphan the next `up` adopts; an adopter
never unlinks a file it did not create, and a creator losing the race
keeps the file when its own identity won through adoption (finding
32). Ordering proven by test: the port is reserved before ANY
mutation — a busy port refuses with the world untouched. serveCommand
and watchCommand were re-expressed over extracted non-emitting
components (`startConsole`, `runWatchLoop` with ready/done and an
admission fence) with byte-compatible verbs — and the watch gained
the honesty it lacked: a lease that stops renewing is now FATAL,
never silently ignored. The supervisor runs one console + one watch
loop per repository over ONE shared store, first-signal graceful /
second-signal hard-stop, retires its runner on the way out (instant
restarts, no name accumulation), and opens the browser last.
Repository inputs canonicalize through `git rev-parse --show-toplevel`
+ realpath before anything enrolls (finding 10). `--json` follows
serve's precedent: ONE startup envelope when the URL is useful (url,
repos, runner, approver/approvers/approverVerified, passwordFile);
the exit code is the later health signal; `-o` gains a preflighted
early flush for serve and up (findings 11/23/30). The demo's --keep
farewell and the first-run checklist now name the road:
`standing-orders up`. Suite 1087 → 1107.

**2026-08-24 — the live window (v22): watch the agent work, and steer it.**
Arc 1 of the attended track. Four Codex rounds (REDESIGN ×3, APPROVE
WITH CHANGES — findings 1–16), because the arc rewires the money path:
claude now speaks `--output-format stream-json --verbose`, consumed by
a NEW streaming runner (`runClaudeStreamJsonl`) that retains only the
load-bearing lines — the first `system`/`init` event and the FIRST
primary `result`, selected by an ORIGIN ALLOWLIST (absent or human;
task-notification/channel/peer/coordinator/unknown kinds fail closed as
diagnostics) — so a multi-megabyte session can never trip the old 8 MiB
buffered kill that would have destroyed the accounting envelope
(finding 1). Claude thereby GAINED the init signal codex always had:
an empty failed stream now classifies provider-init (retryable infra),
and — finding 15 — an error result's diagnostic PROSE can no longer
masquerade as an agent's attempt, because the envelope carries
structural `promptConsumed` evidence and the gateway trusts only that.
The audit tells the truth about the transport (streaming-jsonl,
init signal as CAPABILITY metadata — finding 16). On top of the stream:
**the live window** — `evidenceRoot/live/<runId>.log`, 0700/0600,
O_EXCL|O_APPEND|O_NOFOLLOW with the descriptor retained, 2 KiB/line and
2 MiB/file with a reserved terminal marker, whole-line redaction on any
credential-shaped hit, tool activity described in a FIXED vocabulary
that never echoes a tool's name or inputs; display state, NEVER
evidence, said so on the page, swept by reconcile only after a
finalized run ages a day (active runs untouchable, orphans on mtime,
500-file bound). The run page's "what the agent is saying" region polls
it by BYTE OFFSET as JSON `{text,nextOffset,final}` — raw sanitized
text into textContent, complete lines only, a shrunken file answers a
typed `replaced` and the client restarts visibly, and a finished run's
final drain returns the torn tail. Session-touch fixed alongside (live
bug): ALL named read-only fragment polls are excluded from activity,
not just the board's — a 2-second poller no longer holds a session
open forever. And **steering**: `task_steer` (v22) notes filed from the
task page or `task steer <id> --note`, validated by validateNote,
quoted FENCED in the next brief under the cannot-widen-scope rule.
Attachment is its own pre-invocation transaction (finding 9) after the
run row exists and every refusal is behind; delivery settles ONLY on
the stream's own receipt — the first top-level assistant event, or a
successful primary result as fallback; error results never count
(finding 11) — via a latched, isolated callback (finding 13). A note
whose run never proved delivery re-attaches when that run is NO LONGER
LIVE by the console's one liveness fact (outcome, or lease released/
expired/superseded — finding 12: crashed runs keep outcome NULL
forever, so finalization-based re-attach would strand notes; recovery
paths untouched). At-least-once, honestly labeled: "waiting for the
next attempt" → "attached to build #N — delivery not yet proven" →
"reached build #N", superseded when the task ends first. Repair and
planner briefs never consume steering; tournaments refuse steering and
steering refuses tournaments, both directions typed. Suite 1041 → 1087
(live/steer/transcript/streaming suites; tick's "broken agent"
fixtures now show the init event their story implies). Schema v21→v22.

**2026-08-21 — the merge grant (v21): wake to MERGED pull requests.**
Four Codex rounds (REDESIGN, REDESIGN, REDESIGN, APPROVE WITH CHANGES —
findings 1–25), because this is the arc where the machine touches the
default branch. What shipped: merge authority as explicit fields on the
publication grant (`publish grant --allow-merge --merge-method squash
[--merge-delete-branch]`), whose terms restate the whole truth — this
plane's own opened-or-adopted PRs only, into the exact granted base,
ONLY after CI was OBSERVED green on the exact head commit, acting as
the gh account the preview NAMES (unpinned, said so), drafts never
merge, the same-head CI race and the all-skipped-rollup fact stated
rather than hidden. The proof machinery the rounds forced into
existence: a durable `ci_observation` table binding repo+PR+exact head
SHA+state, generation-ordered — a writer RESERVES its generation before
the network call and settles conditionally, and a LOSING settle has no
effects and can never authorize (the stalled-green race is dead;
finding 24). Round 1 also caught a live wildcard bug — episode lookups
LIKE-matched `_` in repository names — fixed with escaped predicates.
The sweep (rides every publish pass and the watch): claim the durable
merge intent by CAS with an expiring lease and a generation fence (the
delivery-claim discipline; an expired claim reclaims, the old owner
loses every subsequent write, and no permanently-claimed row is
representable), re-read the LIVE grant and compare the terms hash the
intent was born under, prove NO merge queue governs the base (every
rules page via --paginate --slurp, PLUS the classic-protection probe
with a structured status where any 200 refuses `merge-queue-unknown` —
gh silently converts merges to queue behavior, so an unprovable "no"
is a refusal), take one fresh WINNING observation green on the exact
publication head, renew the lease + re-prove the generation in the
last instant, then `gh pr merge --match-head-commit <sha>` so GitHub
itself is the final CAS. Failures classify by structured re-read,
never the exit code (auth=4 excepted): already-merged confirms,
moved-head supersedes, drafts/protection refuse with a page naming
`publish rearm <pr>`; transport retries bounded at 3. A CI-repair
draft now writes a durable merge_blocker in the same transaction —
STICKY by design after round 3 proved every lifecycle-based lift
leaked (requeue, setTaskState, revision chains, tournaments): it lifts
only by the authenticated `publish unblock <pr>` or the PR closing
remotely. Adoption itself gained the --base filter round 2 demanded —
a same-head PR aimed at a different branch can no longer be adopted,
let alone merged under another base's authority. Ten proofs in
merge.test.ts, one per finding family; doctored-v20 fixture reopened
twice. Suite 1041. The README's first sentence is now fully true:
queue twelve, walk away, come back to pull requests — merged.

**2026-08-21 — 0.3.0 published.** Alex ran the publish (fresh npm login
after a token expiry masquerading as E404); tag v0.3.0 pushed;
`npx standing-orders@0.3.0 --help` verified cold from the registry. The
release carries everything since 0.2.0: tournaments (v14–v16), the live
peek (v17), chains and next (v18), queue columns (v19), external
dispatch (v20), the UX fix batch, and the docs pass. Suite 1031.

**2026-08-20 — external dispatch (v20): the loop reaches the tracker.**
The M0-promised arc, and the hardest review of the project: FIVE Codex
rounds (REDESIGN ×4, then APPROVE WITH CHANGES with findings 40–43),
because this is the boundary where local authority meets a tracker other
people can write to. What shipped: a GitHub issue becomes an ORDINARY
local task — scope, approval, queue columns, chains, budgets all apply
untouched — plus one immutable `external_mirror` row carrying its full
remote identity (owner/name#number, collision-hashed local ids) and its
PROVENANCE (local-create | intake | granted-all; recorded at creation or
by the authorizing intake grant, trigger-enforced immutable — titles and
labels may nominate work, never establish whose it is). The `sync` pass
(daemon cadence via reconcile/watch, zero tokens, demo-fenced): an
authenticated access proof first (GitHub 404s what you cannot see, so a
label 404 is "missing" only after the proof — everything operational
blocks dispatch IMMEDIATELY, no grace), the plane-marker verdict (one
fixed label, plane id in its description, overwrite-repaired by
re-enroll; detection of a second plane, honestly never a lease), a
paginated forward scan (titles through the canonical validator, bodies
NEVER fetched), then every known mirror fetched INDIVIDUALLY — absence
from a capped listing proves nothing, and only a COMPLETE pass advances
freshness, atomically with its ledger row. Enforcement lives at the two
atomic points, never mid-build: ADMISSION (a typed gate inside
acquireLocked itself — raw claims and tournament resume included — plus
a pre-spawn re-proof; stale/closed/revoked/plane-blocked mirrors never
start, and the tick stale-scan pages each one rather than hiding it)
and COMPLETION (`completeFenced` now returns completed|disowned decided
inside its own transaction with the disposition durable on the claim
row: a mirror the tracker closed mid-build finalizes failed/
external-closed, task cancelled, branch kept as disowned evidence,
publication impossible by construction — one build's compute honestly
wasted instead of a fence that usually works). `setTaskState` itself
refuses `done` on a latched mirror (typed union, every caller
migrated); DONE STAYS DONE — remote closure never regresses a
completed dependency. Reopen is an authenticated CAS needing the
tracker SEEN open again on a later generation and a clean task — the
refusals name the existing act that clears each blocker, and exclusion/
incident-resolve now clear their holds and page episodes (finding 43).
Write-back rides `external_intent` rows under the grant's classes
exactly (`comment` is a NEW explicit class, close still withheld) — a
denial is a typed intent refusal, never a run rewrite. `dispatch` is a
grant FIELD with its own enroll terms ("this plane will BUILD what this
tracker nominates"), binding exactly one remote repository, never in
any default. Descoped by name after round 4: tournaments on mirrors and
the standalone `build` verb on mirrors (both refuse, typed — the two
interactions generating most review complexity); also out: beads
dispatch, external edges, body ingestion, a distributed lease,
retroactive v19 intake mirrors. The idempotent-acquire replay now
carries a `replayed` flag (acquire-specific) and performs exactly one
narrow repair. Suite 1031.

**2026-08-19 (evening) — the queue screen (v19): Spotify's up-next, as
per-worker columns.** Operator directive: drag-and-reorder "for
different agents", columns "with a note at the top for each so we know
theme/project". TWO Codex rounds (v1 REDESIGN findings 1–12, v2 APPROVE
WITH CHANGES 13–20), implemented to all twenty. The law lives in the ONE
claim primitive every acquisition path shares (`acquireLocked` — round-1
finding 1 caught raw CLI claim and tournament resume bypassing the
higher gate): a task reserved for one worker refuses every other with
the new stable reason `reserved`. The Spotify rule: a worker drains ITS
OWN column top-to-bottom, then the shared queue (`listReady(forRunner)`
is the dispatch view; tick passes its runner). Rank is REINTERPRETED as
position within a (worker, repo) column — `moveTaskNext` computes its
MAX per partition, `queuePosition` uses the complete tie-break order
(rank, filing time, ref id — finding 15), the task page keys its acts on
POSITION not sign (finding 16), the board badges only true column heads
("next up" for the shared queue, "next for <worker>" per column —
finding 14) and pins one head per partition onto the bounded page with a
window function. One atomic `moveTask` does assignment + both columns'
rerank in a single transaction, CAS-guarded by a `queue_state` revision
(explicit edits only — the scheduler's claims never bump it) and
touching only FREE members: anything live-claimed or racing keeps its
rank (finding 13; a setup-failure release rejoins with the rank the
operator gave it, stated in code). /queue: shared column first, then
each worker — editable theme note (validated like hold reasons), auto
project chips, retired columns kept greyed while they still own tasks,
approve-its-scope and waits-for chips, "being taken — keeps its claim"
pinned cards, the starvation truth on the shared head when every column
is busy. Drag = delegated pointer events surviving every fragment swap;
the poller re-checks focus/dirty/drag AT SWAP TIME and says "paused
while you edit" (findings 17/18); every drag has button/select
equivalents. CLI: `task assign <id> --runner <name> | --anyone` (back of
the destination column, defined), `ready` says reservedFor and that each
worker takes its own reserved work first, `claim` renders the reserved
refusal distinctly. Schema v19: task_ref.assigned_runner,
runner.queue_note, singleton queue_state — all additive. Honesty kept:
reservations are SCHEDULING, never authority (approval gates untouched);
per-worker capability warnings were dropped as unsupportable (finding
5); private-first starvation is stated on the page and here: a worker
with reserved work does not touch the shared queue until its column
empties. Suite 1017.

**2026-08-19 (later) — chains and next (v18): dependencies become a whole
feature, and the queue learns "this one first".** The operator asked for
the next orchestration and workflow-creation improvements; the assessment
found dependencies were HALF a feature (edges existed with cycle refusal,
but nothing anywhere could remove one, the console could neither create
nor see them, and the task page never said what a task waits for) and
dispatch was pure filing-order FIFO. Spec Codex-reviewed (APPROVE WITH
CHANGES, findings 1–12), implemented to all twelve. The authority line,
held throughout: chains and rank are SCHEDULING, never authority — no
digest binds them, no approval is voided by them, and the claim
transaction re-proves everything it always did. Shipped: schema v18
(`task.priority`, addColumn + doctored-v17 regression test);
`store.removeEdge` (one transaction, wake-bumped — removal cannot create
a cycle) and `store.moveTaskNext` (rank = MAX+1 over live work, computed
and written in ONE transaction so racing asks get distinct ranks — the
LAST ask wins; refuses claimed work BEFORE the state check so the honest
word is "being built", plus unknown/not-queued/tournament/overflow, all
typed) with `clearTaskPriority` because a mistaken promotion must not be
sticky; `listReady` orders `priority DESC, created_at, ref id` (the tie
now deterministic where it was timestamp-luck); CLI `task unblock` and
`task next [--undo]` (block/unblock/next all wear the tournament guard),
`task show` says "position moved up (rank N)", help updated everywhere;
console: a "waits for" card on the task page (blockers with states,
stop-waiting buttons, an add select scoped to the OPEN project and the
ceiling — a projectless roll-up gets no cross-project select), "starts
after" on the new-task form (a bad chain never loses the created task —
its page says exactly what failed), "build this next" / "back to filing
order" acts, the queued lane sorted in true dispatch order with only the
actual front card badged "next up" (the rest "moved up"), a third
bounded board query so an old promoted task cannot fall off the newest
page, and the routines empty state finally pointing at the filing form
on its own page instead of the terminal. Dispatch-order proof is a test:
two approved tasks, `task next` the second, a --max 1 tick builds it.
Deliberately out, named: per-task model override (authority-bearing —
its own round), a chain-composer form, external-backend ordering,
contest-resumption ordering (they precede the ready snapshot by design).
Suite 1015.

**2026-08-19 — the UX fix batch: liveness is proved, help is safe, and
the last raw tokens leave the pages.** A full assessment of the console
(walked live via the demo sandbox) and the CLI (probed live) became a
spec, Codex-reviewed twice (round 1 REDESIGN, findings 1–13; round 2
APPROVE WITH CHANGES, findings 14–20), then implemented to the letter.
The spine of the batch is ONE liveness fact: a run is live iff its lease
is the task's CURRENT claim — maximum generation, unreleased, strictly
unexpired (`store.currentLiveLease`) — and every surface now derives
from it instead of guessing from a null outcome. A live build's page
says "running" with plain-word phases; an orphaned run stays "never
finished", loses its pollers (fragments carry a stop marker the region
script obeys), and can no longer be called "still working" on an
interrupted tournament's comparison screen. The board's building card
lands on the live build itself (`live_run_id` projected inside
`boardScoped`'s own claim join — outcome predicate inside the subquery),
and the task page's live-peek door stops promising what a serve without
`--runner` cannot show: the link reads "open the running build", and the
run page's watch section says in place how to turn the live view on. The
peek guard's lease check was also STRENGTHENED: `liveClaimByLease` would
admit a superseded lease; the current-lease proof refuses it finally.
No-jargon sweep: hold owners ("held by a tournament", never
`held (contest)`), incident kinds, evidence-link labels, run failure
reasons, contestant states — every map with a generic plain fallback so
an unknown future token can never leak; "occupancy fence" copy replaced;
digests display truncated; bare-text 404s now refuse on the console's
own page. CLI: `--help` on any queue verb answers BEFORE the database
opens (`serve --help` once started the server; asking for help minted
orders.db) and answers as an envelope under --json; unknown flags are
refused by name instead of silently becoming booleans (`--follow` and
friends allowlisted); a mistyped verb's scan now says "if you meant a
command" and its JSON envelope finally says ok:false (reason
no-repositories — it said ok:true with exit 2); missing race budgets
name the missing flag and the config command that defaults it; `config
set budgets` names the offending flag; serve validates --port; the four
unconfirmed previews (enroll, task approve, routine approve, publish
grant) now exit 3 in BOTH modes — a deliberate, documented compatibility
change for scripts that read the human-mode 0; watch --json's one stray
stdout line (the bridge cycle) moved to stderr, with an exact-stdout
regression test. Help finally admits `approver` exists, `task`'s
unknown-subverb error lists all twelve subverbs, and `task scope`'s
usage names the whole tournament flag surface. Suite 1007.

**2026-08-17 — the live worktree peek (A2, v17): three Codex rounds, then
a native reader that executes nothing.** The attended track's blocked
item, unblocked the hard way. Round 1 (findings 13–24) killed the naive
design: ANY git spawned against an agent's checkout can execute
repo-configured clean/process filters, and even object-database reads at
poll time carry lazy-fetch/replace-refs/alternates execution surface.
Round 2 (25–36) accepted the pivot — no subprocess at observation time —
and rejected two overclaims. Round 3 (37–45) accepted the reclassified
trust story in principle and handed back an implementation checklist plus
four real walk defects, all now closed. What shipped: the base tree is
snapshotted ONCE per run in the pre-spawn window that computes the base
itself (`git ls-tree` against the project clone, never a worktree,
lazy-fetch and replace-refs disabled, env allowlisted), stored as an
enveloped `base-tree` artifact (binds repo+run+exact base OID; undecodable
paths refuse the WHOLE snapshot; capture failure disables the peek and
nothing else). A poll then runs pure Node: descriptor-DISCIPLINED walk
(O_NOFOLLOW|O_NONBLOCK opens, fstat-through-descriptor, regular-file and
same-device proofs before a byte is read, directories device-gated before
descent, symlink TARGETS compared by readlink+in-process git-blob sha1,
reads bounded to the accepted size with growth re-fstat'd, per-entry and
per-chunk deadlines, unreadable corners make the look PARTIAL and
suppress the deleted sweep), rendering NAMES AND COUNTS ONLY — changed /
deleted / new (aggregated, never suppressed, hard row cap groups
included) / explicitly UNCHECKED. The occupancy fence: worktree
lease_epoch, fresh randomness written atomically with every lease and
rotated on release — the peek proves the epoch before AND after the walk
and discards on mismatch; the fragment cache is keyed run:base:epoch,
LRU+byte bounded, re-guarded on every hit, byte-capped after escaping.
Locality is an ADMINISTRATOR ASSERTION (`serve --runner <name>`, off
without it) plus realpath containment in the pool root. Surface: the run
page's polled region (15 s, visibility-paused) + a task-page door;
cookie sessions only; Cache-Control: no-store; nothing durable ever.
Residuals stated in code where they live: same-UID is the product's
universal boundary (snapshot integrity = database integrity class), and
pathname traversal races remain a same-volume misdirection channel in a
names-only display until a sandboxed helper exists (named follow-up).
Schema v17: worktree.lease_epoch + artifact.kind admits 'base-tree' by
the recognized-exactly rebuild (doctored-db regression test; live console
migrated and verified). Suite 986.


**2026-08-17 — tournament stage 6 + the agent-count knob (v16, operator
request: "configure number of competing agents").** The count, three
ways: `task scope --race claude:claude-sonnet-5 --race-count 3`
replicates one named agent (a count that contradicts an explicit lineup
refuses — a count is never an instruction to invent agents); `config
set budgets --race-agents N` sets the installation default, applied
only where a filing names ONE agent and no count; and the console scope
form grew the whole tournament section — how many agents compete
(one/2/3/4), the competing model from the pinned price list, per-agent
and total dollars prefilled from defaults — plus the v15 budget field
it was owed. A console-filed race lands as terms beside the scope, the
approval card restates agents-and-dollars and binds the JOINT
fingerprint (finding 31 now holds on the web path too: one yes, both
documents, one transaction), and saving the form back to "one agent"
retracts the standing race. Routines gained their per-run ceiling:
`routine add --budget-usd N` is digest-bound (conditional inclusion —
existing routines digest unchanged) and lands in every instance's scope
as its own digest-bound budget term, enforced by the same native-cap
plumbing. Stage 6 housekeeping in the tick: sweepContestCleanup returns
DECIDED tournaments' checkouts to the pool — this runner's custody
only, winners and losers alike (branches and evidence survive), and a
checkout that will not release cleanly is marked attention and paged
once, never force-cleaned; escalateOverdueContests pages exactly once
at fourteen days (overdue_paged CAS), and never abandons anything on
its own. Schema v16: spend_defaults.race_agents,
routine.budget_per_run_microusd. Live console migrated and verified.
Suite 971.


**2026-08-17 — tournament stage 5: the comparison screen and the pick.**
The payoff surface. `/contest/<id>` lays every agent's result side by
side — outcome, duration, questions asked, its own conclusion, the
verified diff, and the money in dollars (an unknowable figure said in
words, never $0.00) — and offers a pick button ONLY where the evidence
predicate allows: state built, a committed real change (or a verified
no-change whose head still equals the tournament's base), typed capture
verdicts 'ok' on both diff artifacts (the capture path now stamps
capture_status from the git exit codes it already had), bytes verifying
against their recorded hashes, nothing redacted, nothing truncated.
Everything else is labeled with its reason in plain words. The ceremony
is two POSTs: the first MINTS a durable single-use nonce (finding 30 —
a GET can never mint) bound to the contest-pick/v1 tuple digest — every
agent's identity/state/run/outcome/committed/head, every artifact's
hash/bytes/capture/redaction, the selection, and the exact publication
consequence — and answers with a confirmation screen restating all of
it; the second takes the password, and finalizeContestPick does the
whole thing in ONE transaction: nonce consumed against the REBUILT
digest (evidence tampered between screens = refusal), winner's bytes
proved again, state CAS'd by generation, winner stamped, all agents
marked cleanup-pending, the contest hold lifted, the task done, and the
publication intent created now-and-only-now under exactly the tick's
own predicate (committed, non-no-change, live grant, branch under the
grant's prefix, selector satisfied). Abandon gets the same ceremony
shape and fails the task requeueably with everything kept. The board
classifier reads tournaments before the generic branches (finding 6):
racing shows "tournament — N agents racing", pick-wait/exhausted/
interrupted are needs-you cards addressed at the comparison screen, and
the aggregate boundary pages once through the outbox. Also fixed:
contest.ts carried raw NUL bytes in digest separators (git saw binary);
now \u0000 escapes, byte-identical digests. Suite 965.


**2026-08-17 — dollar thresholds land at both layers (v15, operator
request: "selectable when creating the task or with a global setting").**
Per task: the scope gains an optional budget term — `task scope <id>
--budget-usd 3.50` — that is DIGEST-BOUND (editing it strands the
approval like any term; a scope without one digests exactly as before,
so no existing approval moved), restated by the scope description in
words ("$3.50 per build attempt — the agent is stopped at this figure"),
and enforced through the same native-cap plumbing tournaments use.
Globally: `config set budgets [--build-usd N] [--race-per-usd N]
[--race-total-usd N] --as <you> --token <t>` (authenticated, audited)
writes spend_defaults — new filings PRE-FILL from these (explicit flags
always win, and the digest binds the actual numbers wherever they came
from), tournament filings inherit per-agent/total defaults, and the
build default doubles as an installation-wide backstop: the ordinary
build path now caps every attempt at the SMALLER of the scope term and
the backstop. Ruling 3's fail-closed rule holds: a provider that cannot
hold a native dollar cap does not run capped work — the tick skips it
typed ('budget-unenforceable') instead of pretending. Schema v15:
task_scope.budget_microusd + the spend_defaults singleton. Suite 954.

**2026-08-17 — tournament stage 4: questions, answers, custody, and the
lineage meter.** A racing agent that parks now records CUSTODY of its
checkout (branch, exact head, which machine, whether dirty — round-3
finding 29) before the worktree goes back to the pool, and its question
reaches the operator tagged with its agent; the database enforces ONE
open question per agent by partial unique index (finding 28, living in
the post-migration block per the v11c lesson). Answers re-admit: the
tick's new resume pass finds decision-wait tournaments whose parked
agents have answered questions, and — on the ORIGINAL machine only,
after re-leasing the SAME checkout and proving its head matches custody
— reclaims the task, reserves one worker-process slot, opens a resume
run parented to the parked one, and builds with ONLY the remaining
budget as the native cap. A checkout that cannot be proved to be the one
the agent left stops that agent ('contest-custody') rather than
cold-starting against different history. Answers are lineage-filtered:
attachAnswers now matches the receiving run's agent, so a racing
agent's answer can never leak into a sibling's brief or an ordinary
build. The EXCLUDE ceremony (`contest exclude <id> <agent-number>`,
authenticated) closes a question nobody will answer with the typed
'excluded' reason — never a fake option — stops that agent, and
re-aggregates; `contest show` gives the machine-readable state and both
verbs join the envelope sweep. Interrupted-tournament recovery now
actually runs each tick. THE CATCH: the end-to-end test (park →
decision-wait → answer → resume → pick-wait, real tick, real git)
exposed that the spend meter used MAX semantics — the park's $0.10
vanished when the resume's $0.30 settled. The meter is now CUMULATIVE
across the lineage (each invocation settles once, the agent's total is
the sum), which is what the round-2 repair-budget finding demanded all
along. The e2e also proves the resumed brief carried the answer's exact
words, exactly one agent respawned, and every slot came home. Suite 952.

**2026-08-17 — tournament stage 3b: the dispatch — a whole race runs.**
The tick now recognizes an approved tournament on a claimed task and
sends N agents instead of one builder: admission (all-or-none, quota by
distinct key, slots bound to agents), the base commit frozen by SHA and
stamped with the live setup identity, a worktree leased per agent on its
own contest-unique branch, a run opened per agent CARRYING its agent
identity, the ready barrier crossed only when every agent is prepared —
and only then the concurrent builds, each under claude's NATIVE dollar
cap (`--max-budget-usd`, plumbed Invocation→adapter argv) with the
worker-process ledger recording each spawn's process-group id via the
new onSpawn callback (exec→builder→slot). Failures anywhere before the
barrier interrupt the WHOLE tournament — worktrees, slots, and the
claim all come home, nothing spawns. Completions route through the
child finalizers: run finished honestly (built/no-change/parked/
failed), evidence captured by the builder as for any run, money settled
from the provider's reported figure (or latched at the full reservation
if it went silent after starting), and the aggregate boundary crossed
exactly once. A parked agent's question reaches the operator tagged
with its agent (decision.contestant) — full decision-wait mechanics are
stage 4. THE PROOF: an end-to-end test drives a real tick against real
git — two claude agents race, both finish, the contest lands in
pick-wait with the "compare the results and pick one" hold, both
contest branches exist in the repository, both spawns carried
--max-budget-usd 5, terminal diffs exist per agent, measured spend
equals the provider's reported figure in micro-dollars, the parent
claim released exactly once, and every worker-process slot came home.
Suite 950.

**2026-08-17 — tournament stage 3a: filing, the one yes, admission,
children, recovery.** src/contest.ts is the orchestration: raceDigestOf
(order-sensitive, retries pinned at zero) and tournament-approval/v1 —
ONE approval hash over scope AND race terms (finding 31), so `task
approve` on a tournament task refuses the scope digest alone and names
the joint fingerprint; the interactive yes prints the agents, each
agent's dollar cap, and the tournament total before asking. planTournament
refuses ineligible providers in their own words (codex: turn-end-only
usage), refuses unpriced models, and refuses a total that does not cover
the TRUE worst case (each agent's budget plus its own overrun reserve —
the arithmetic finding 24 demanded). admitContest is one reentrant
transaction: open-contest check, digest re-derived from the stored terms
(the H1 rule), approval bound to that exact digest, quota grouped by
distinct key with doubled half-open keys refused, worker-process
capacity in 'processes' mode, then contest + agents + slots created with
every slot bound to its agent — a refusal persists NOTHING. Child
finalization (findings 1/17): an agent finishing writes its own row,
frees its slot, settles its money (or latches the FULL reservation when
the provider went silent), and asks inside the same transaction whether
the tournament just ended — the REGRESSION TEST proves the first
finisher leaves the parent claim alive and the last one releases it
exactly once, installing the contest-owned hold whose reason reads
"tournament finished — compare the results and pick one". Recovery
converts a dead-leased tournament to 'interrupted' by the same
generation CAS, latching only agents that actually reached provider
start — never-started ones stay at zero. Generic task state/requeue/
unhold refuse 'contest-open' while a tournament runs. Found and fixed
along the way: liveClaimByLease initially used SQL wall-clock time
against the codebase's injected clocks — caught by the fixed-timestamp
tests disagreeing with datetime('now') across midnight UTC. Stage 3b
(dispatch: worktrees for all N, the ready barrier, N concurrent builds
under the native budget cap, child wiring in the watch) is next. Suite
949.

**2026-08-17 — tournament stage 2: the v14 schema, in plain words.**
Five new tables (the internals keep technical names; every screen will
say "tournament", "agents", and "worker processes"): tournament_terms —
immutable approved-terms rows, one ACTIVE pointer per task, money as
integer micro-dollars with the overrun reserve held apart from the
spendable budget; contest — the running tournament, whose current lease
identity lives ON the row so aggregation, reaping, and crash recovery
all fence on the same facts; contestant — one racing agent, with money
deliberately split three ways (measured = what the provider reported,
monotonic; accounted = what the ledger charges, the FULL reservation
when unknowable; unknown_spend = the honest flag that they differ) plus
checkout-custody and cleanup columns; execution_slot — one row per
worker process with a reserved/running/released life and the process
group recorded so recovery can ask the OS before freeing capacity;
ceremony_nonce — durable, hashed, single-use, consumed inside the same
transaction as the act it authorizes. Columns: run.contestant,
decision.contestant (the one-open-question-per-agent rule becomes a
real index later), artifact.capture_status (typed 'ok'/'failed' — prose
never carries authority again), runner.capacity_mode ('tasks' stays
the default; 'processes' is the explicit opt-in — an upgrade never
silently changes what an operator's capacity number means). The hold
rule widens to admit tournament ownership via the recognized-exactly
rebuild — v14 is deliberately NOT purely additive and says so where it
happens. THE CATCH OF THE DAY: the migration tail initially failed to
land (a silent no-op text replacement) while the version stamp still
advanced — the live console caught it (v14 stamp, missing columns), the
tail was landed with an assertion, the live database was rolled back a
version and re-migrated correctly, and the suite gained a
doctored-database regression test that rebuilds a genuine pre-v14 hold
shape and proves the upgrade fires. Store methods shipped for every
table: filing/approval persistence, generation-CAS state moves for
contest and contestant, the single-live-run pointer, monotonic spend +
the unknown-spend latch, the slot lifecycle, and mint/consume/sweep for
ceremony nonces — all covered by tests. Suite 940.

**2026-08-17 — tournament builds: three design rounds to APPROVE WITH
CHANGES; stage 1 ships.** The A3 design arc ran v1 → redesign (13
findings: shared finalizers would release the parent claim; dollar
ceilings unenforceable, the waiver rejected) → v2 metered kill-switch →
redesign (findings 14–23: codex/openrouter report billable usage only at
turn end — tournament-INELIGIBLE; claude's own --max-budget-usd + a
reserved one-call tail is the enforcement; monotonic persisted spend
with an unknown-spend latch; a uniform execution-slot ledger; child
finalizers embedding aggregation; decision-wait; typed capture status;
durable ceremony nonces; co-approved tournament terms) → v3 adopting
every ruling verbatim → **approve with changes** (findings 24–31: the
tail must be bounded by a pinned request ENVELOPE — quantities, not just
rates; measured vs accounted spend kept apart; slots get
reserved/running/released with incarnation; dispatching-state recovery;
decision.contestant column for SQLite-valid uniqueness; workspace
CUSTODY through decision-wait; nonce minting off GET; a joint
scope+race approval digest). The findings files are the spec
(scratchpad codex-tournament-findings.md / -v2- / -v3-). STAGE 1
SHIPPED: src/pricing.ts — pinned build-model prices with the cache
token classes priced separately and the request envelope's quantity
bounds per model, so `oneCallTailMicrousd` is the worst LEGAL call
(dearest input class × the whole window) rather than a rate with no
quantity; `settleBuildMicrousd` itemizes cache classes and returns null
on missing totals (the caller latches, never guesses). provider.ts
gains MONEY_CAPABILITIES (incremental usage, native cap flag, usage
semantics, derived tournamentEligible with the refusal said in words)
and `probeBudgetCap` — resolves the exact executable, reads its
version, and proves the flag in THAT binary's help, fail closed.
Stages 2–6 (schema v14, finalizers, decision-wait, ceremonies, cleanup)
follow the approved order. Suite 932.

**2026-08-17 — the attended track ships its first slice (workbench,
palette, live substrate, deep links).** Roadmap
(scratchpad/roadmap-attended.md, seeded by the Orca competitive read) went
through Codex review — approve with changes, 13 findings
(codex-attended-findings.md = the spec), which INVERTED the build order:
the named-region liveness substrate first, because the old fragment
swapper could only replace the whole `<main>` and would have refreshed
form-bearing panes. Shipped: (1) `regionScript` — swaps exactly one named
element, visible freshness ("updated Ns ago"), stale-state wording,
exponential backoff, hidden-tab pause, one poll in flight (findings 2/5/
6); the board migrated onto it. (2) **/workbench** (A1): the sit-and-watch
screen — a polling rail of needs-you (cap 100) and building-now (live
claims with plain-words phase, provider, client-ticking elapsed) plus a
just-finished tail, with the SELECTED task's full detail (banners, forms,
acts — never polled) in the main pane via the master-detail split;
admission before every LIMIT + per-row visible() re-check (finding 3),
which also fixed two pre-existing board holes: rolled-up done rows now
join the admission set inside boardScoped, and root ceilings enumerate
through admissionList instead of post-filtering. (3) The jump palette
(finding 4's exact contract): `g b/i/w/r/d` + `/` filter over a
server-rendered non-executable JSON index (200 tasks, saturation
declared), navigation ONLY — no key posts, ceremonies untouched; ignores
editable targets, modifiers, repeats, IME; dialog/listbox semantics; CSP
script nonce per response (never confused with approval nonces). (4) A4:
run pages poll their facts region while the run is open — elapsed ticks,
phase updates; a finished run's fragment says "finished — reload for the
final record" instead of growing forms (finding 5). (5) A5: console-URL
validator parses with URL and refuses userinfo/query/fragment (finding
11); `task add` and `template apply --file` print the console link beside
the id and carry a structured `links` object in JSON. Verified in a real
browser: rail, freshness stamp, selection, palette. **A2 (live worktree
peek) is BLOCKED per finding 7** — git clean/process filters mean diffing
an agent-controlled worktree can execute repo-configured commands; it
ships only after a hermetic-capture design passes review (park capture
flagged for the same audit). A3 (tournament builds) awaits its own
authority-bearing brief (finding 12 enumerates what it must answer).
Suite 927.

**2026-08-14 — key onboarding joins the console (operator request:
"shouldn't the key entry be part of the onboarding on the ui").** The
chat setup card gains an API-key field, on the TELEGRAM BOT-TOKEN
PRECEDENT exactly: pasted once inside the authenticated (password-again)
save, shape-checked (a pasted password is refused loudly, not stored as
a "key"), written to a mode-0600 file beside the database
(chat-key-<provider> under serve's config dir), asserted 0600 even when
the file pre-existed, NEVER written into the database, and never echoed
beyond redactToken's tail. Resolution order is environment first —
ANTHROPIC_API_KEY / OPENROUTER_API_KEY always win when set — then the
stored file; the card names each provider's key source (environment /
stored …tail / none yet). A stored key is forgettable from the settings
block (password again); storing or forgetting invalidates the catalog
cache. The CLI serve passes configDir (beside the db) already, so the
whole chat onboarding — key, provider, model from the live catalog,
ceiling — now happens on one screen with one password. Suite 919.

**2026-08-14 — the whole OpenRouter catalog, priced by the party that
bills it (operator request).** With OPENROUTER_API_KEY in the serve
environment, the chat setup card's model list becomes OpenRouter's LIVE
/api/v1/models catalog (cached 10 min, 5s timeout, 4MB cap, fatal-decode)
— every model selectable, each arriving WITH its price. The spend
discipline the Codex v3 review demanded is preserved by moving the pin to
the authenticated save: chat_config now carries price_in/out_microusd
(v13b, additive), snapshotted at `save` from the catalog (openrouter) or
the compiled table (anthropic/CLI), so reservations stay fixed-price and
an upstream price change never silently moves the ledger — re-saving
re-pins, and the card says so. Excluded rather than guessed: dynamic
pricing (openrouter/auto advertises -1) and unparseable rows; sub-micro
prices round UP to 1 so a paid model never reads free. Settlement now
takes MAX(pinned math, OpenRouter's own reported usage.cost) — the
ledger never undercounts. FLAGGED for the next Codex audit round: the
price-pin authority moved from compile time to the authenticated config
act reading the biller's catalog over TLS — same trust as the billing
itself, but it deviates from the reviewed "compiled table" wording and
deserves adversarial eyes. Suite 917.

**2026-08-14 — chat setup lives in the console (operator request: "this
will likely be mainly in the webui").** /chat now carries its own setup
card when unconfigured (and a quiet settings block when configured):
provider, model (only pinned-price models, grouped per provider), the
required weekly dollar ceiling, daily turns — submitted with the
password typed again and written whole under the session's name, the
same ceremony weight as the CLI's `config set chat`. The refusals that
need a restart (unscoped/root/unresolved ceilings, demo) stay prose;
the ones configuration can fix render the form. The API key is still
environment-only and the form says so in as many words — no key field
exists, nothing credential-shaped can reach the database from this
screen. Suite 915.

**2026-08-14 — FLEET CHAT SHIPS (v13), three Codex rounds deep.** The
design went v1 → REDESIGN → v2 → REDESIGN → v3 → approve-with-changes,
and the ten required changes are built exactly (the findings files in the
session scratchpad are the specs). What shipped: chat is a DIRECT no-tool
API call (src/converse.ts — anthropic-api / openrouter-api over fetch,
zero deps; no CLI spawn means no filesystem, no inherited AGENTS.md, no
hooks, no argv leaks, and max_tokens as a hard budget by construction);
`chat_config` is its own installation-scoped singleton, deliberately NOT
a phase row (change 1), set by the authenticated
`config set chat --provider … --model … --weekly-usd …` which refuses
--repo and unpriced models; every turn is a `chat_turn` ledger row —
metadata only, closed failure enum, integer micro-dollar WORST-CASE
RESERVATION counted transactionally against the rolling 7-day ceiling
(changes 4/10), dispatched exactly once via generation-checked CAS; a
turn that may have started but has no provable cost LATCHES its
credential (timeout, network-after-dispatch, malformed wrapper, crash
sweep) until the nonce'd, digest-bound, password-taking acknowledgement
screen charges the reserved worst case to a named approver (changes 5/6
— the ONE nonce in chat, because that screen restates financial terms
and re-enables spend). The snapshot is dedicated SQL (store.chatSnapshot,
change 9): explicit non-empty --repo list required (unscoped, root-based,
and unresolved-at-startup ceilings all refuse), admission inside every
query before its LIMIT, repo-null rows excluded from rows AND aggregates,
opaque r1/r2 ids with paths never leaving the process, decision
recaps/consequences/recommendations excluded, canary tests grepping the
serialized document for forbidden content, and the /chat page states
plainly what DOES leave (intentional provider egress, not a leak-proof
summary). Two-layer parsing (change 2): stream-capped fatally-decoded
provider wrapper (one text block, usage required, tool calls rejected,
redirect:"error") then the strict assistant envelope — duplicate-key
lexer, depth cap, exact keys, model-only DTOs with opaque repoId (change
3), at most 3 proposals, all-or-nothing; transport failures render a
static line and no model text ever. Drafts are EPHEMERAL session memory
(change 7): random 128-bit keys, 9 per approver across sessions with LRU
eviction, 30-minute TTL, gone on restart — the first durable copy of any
model text is the unapproved task/routine the operator files with a
password through the proposal door (filed_via `chat:<provider>`, single-
use in-memory CAS with no await before the claim), and the approve
ceremony is byte-identical to manual filing. The password is typed again
on EVERY message and every filing (v2 ruling 2). Door validators gained
byte caps + disguised-text on touches/requirements (change 8). Chat keys:
ANTHROPIC_API_KEY is stripped from every child process env unless a
caller re-supplies it explicitly (change 10 — it would also silently
flip claude builds to API billing). Chat refuses demo databases and
bearer callers. Suite 914 (chatledger 8, converse 13, chatsnapshot 5,
serve chat 7, all over mock transports — no network in tests).

**2026-08-14 — the demo sandbox (adoption track, step 4; the track is
COMPLETE).** `standing-orders demo`: one mkdtemp directory holding two
tiny git repos, a database, and evidence; seeded mid-flight (an approval
waiting, a blocking decision, a live claim in agent-running phase, a
finished run whose terminal diff + stat + handoff VERIFY byte-for-byte,
a failed attempt, a dependency, a hold, an approved routine with a fire
and an honest single-flight skip, and an opened PR observed passing);
served on localhost with the throwaway login printed to the TTY and a
0600 file — NEVER the --json envelope (finding 9). The honesty contract
(finding 8): the `demo` installation fact is stamped BEFORE any row and
has no unset API; `refuseDemo` fails closed in tick, watch, build,
publish, reconcile, daemon, bridge, outbox deliver, and all gh-touching
intake actions (reason "demo-database"), proven by a test matrix — a KEPT
sandbox pointed at by a real worker refuses to spend, forever. seedDemo
itself refuses an unfenced database, so synthetic history cannot land
anywhere real. Every page wears the sandbox banner (decoration; the fence
is the enforcement). Ctrl-C tears down, --keep preserves. Booted live:
login, inbox with decision card, roll-up board, banner — all verified
over real HTTP. README quickstart leads with the demo. Suite 881.

**2026-08-14 — the first-run checklist (adoption track, step 3).** serve's
inbox, while the installation has never finished a run successfully,
replaces the empty-queue card with a checklist DERIVED FROM LIVE STATE on
every render — never a stored cursor (finding 14): ceiling named (or, in
unscoped mode, named AS unscoped with the exact `serve --repo` restart
line — the wizard instructs where the console lacks authority, finding e),
spend routing (a fact about THIS DATABASE only; binaries/auth are the
worker machine's four separate facts via `standing-orders providers` —
the console never claims to have checked them, finding 15), worktree setup
command, skill installed (filesystem check per ceiling repo), first
standing order. Retirement is PERMANENT: store.firstSuccessAt derives the
first built/no-change finish from run history once, stamps it as the
append-only `first-success-at` installation fact, and later pruning cannot
resurrect the card. Template picker: /routines?template=<name> and
/tasks?template=<name> pre-fill the EXISTING forms from the library —
same guarded submission paths, nothing new to approve through; the task
form gained the not-this/touches fields the full scope always had. Suite
867.

**2026-08-14 — templates (adoption track, step 2).** Six common use cases
ship as STATIC DATA (src/templates.ts): nightly-deps, test-coverage,
docs-drift (weekly via every:10080), lint-sweep — plus issue-intake and
ci-babysitter as RECIPES: show-only walkthroughs of the existing grant and
repair ceremonies, refused at apply (reason "recipe"), because a template
must never create a grant or arm autonomous repair (finding 10). `template
apply <name> --repo <path>` PREVIEWS the exact filing (exit 3, reason
"unconfirmed" — the skills-install convention); `--file` (NOT --yes, which
reads like approval — finding 11) files it through the one door with
provenance `template:<name>`, and the output says UNAPPROVED — NO
AUTHORITY GRANTED in so many words. Edits: --title/--name/--goal/--not/
--touches/--schedule/--ceiling override at apply; a filed draft is a COPY
— editing the library later changes nothing anybody filed. A library test
proves every applyable template passes the exact validators manual input
passes. `template` joins OPERATE_COMMANDS and the TG-3 sweep. Suite 862.

**2026-08-14 — the one filing door (adoption track, step 1).** The
adoption-track + fleet-chat briefs went through Codex review (16 findings,
scratchpad codex-adoption-chat-findings.md — the findings are the spec;
verdicts: adoption approve-with-changes, fleet chat REDESIGN). Step 1 is
finding 7: before this, each filing surface validated what it happened to
think of — the console checked controls but not disguised text, nothing
ceiling-checked a typed repo, nothing recorded who filed what. Now
src/proposal.ts is the one door: `fileTaskProposal` / `fileRoutineProposal`
with an exact field allowlist (no spread — a template or model object
CANNOT smuggle approval metadata into scope rows), disguised-text refusal
on every field an approver reads, best-effort canonicalization with an
explicit-ceiling membership check (an EMPTY ceiling refuses every repo —
fail closed; an absent one is the CLI's honest none), digests computed
inside the door, and immutable `filed_via` provenance (schema v12:
task_ref.filed_via + routine.filed_via, set-once by construction — no
update API exists). Wired through: CLI `task add` (same text rules via
validateTaskText + provenance stamp, replay idempotency untouched), CLI
`routine add`, console quick capture, console routine form, intake run
(filedVia "intake"), revision seals ("revision"). Also v12:
`installation_fact` — append-only set-once markers (INSERT OR IGNORE is
the whole API) that the demo stamp and the wizard's retirement milestone
will both rest on. Suite 852.

**2026-08-13 — front-page pass two, against the field.** Studied ten front
pages (vite/bun/vhs/zod/ollama; OpenHands/aider/opencode/claude-squad/
agor). The finding that mattered: nobody in the agent category presents
their containment model with confidence — it's red warning boxes
(OpenHands), buried bullets (agor), silence (opencode), or a feature
literally named "yolo mode" (claude-squad). So trust leads here:
"Unattended is not auto-accept" is now the first section — a
can-never/enforced-by table (default branch, self-approval, irreversible
options, credentials, idle spend, unmeasured spend, guessing), closed by
the executable claim (unattended.test.ts). Also per the study: wordmark
with dark/light variants, ≤7-word category tagline, nav row, absolute
raw.githubusercontent media URLs (relative images break on npm's
renderer), Contributing/License tail, overnight-failure table de-duped
against the boundaries table. package.json: version 0.1.1, category-first
description, 15 keywords — awaiting the operator's republish so the
registry page catches up.

**2026-08-13 — the repo is the product too.** Pre-publish front-door pass:
GitHub Actions CI (ubuntu + macos × node 22/24: typecheck, build, the full
suite) with badges; CONTRIBUTING.md (fail-closed rules, the adapter
contract as the contribution surface); issue forms that ask for `--json`
output and warn against pasting tokens; repo topics; and a README
restructure — hero with an animated SVG of the unattended stretch
(hand-built, no GIF tooling; since removed), a three-line npx
quickstart, and the status wall moved to its own section above Milestones
so the first screen is proof, not prose. npm publish remains the
operator's act; the README now ships as the registry front page when it
happens.

**2026-08-13 — the product is `standing-orders`.** The tagline was the
brand all along ("Standing orders for your agents"): the rename drops the
last night-shaped thing before anything is published, keeps the naval
lineage (a night order IS a standing order), and costs almost nothing at
this exact moment — the npm name was still unclaimed. Swept: package
name and bin, every command example and console surface (the brand reads
standing·orders), env vars (STANDING_ORDERS_*), branch namespaces
(standing-orders/<task>). SECOND PASS same day, per the operator ("all
under one name"): the protocol markers are STANDING-ORDERS-PARK/DONE/
PLAN-* (the worktree sweep still recognizes pre-rename NIGHTORDERS-*
leftovers — cleanup has no vintage), unattended.test.ts carries the E2E
(née night.test.ts), and the working folder itself is
~/Documents/standing-orders. Continuity: databasePath, evidenceRoot, and repos.json all fall back to
their nightorders-named homes when no new-name file exists — the rename
orphans nobody. Earlier entries below keep the old name: they are
history, and history happened under it.

The living ledger of what has actually shipped, against the milestones in
[`DESIGN.md`](DESIGN.md) §10. One row per milestone item: its state, the
commit that proved it, and the date. "Proved" means tests exist and pass —
an item no test exercises is *in progress* no matter what the code looks
like.

Updated in the same commit as the work it records. If this file and the
code disagree, the code is right and this file is a bug.

## M0 — useful before it is autonomous

Ships when: `npx nightorders` shows every branch, PR, and issue in flight.

| Item | State | Proof |
|---|---|---|
| Zero-config discovery (branches, PRs, issues) | **done** | `d1a21ee` — scan, pulls, remote |
| Graph-backend detection (`nightorders graph`) | **done** | `6037c96` |
| Setup guidance without setting anything up | **done** | `d828d36` |
| Adapters: built-in SQLite store | **done** | `62aaf26` |
| Adapters: beads · GitHub Issues, or refuse and say why | **done** | `f20c816` |
| BackendGrant — write access handed over deliberately | **done** | `915a5b9` |
| Claim/lease with fencing | **done** | `62aaf26` |
| Idempotency (`--key` replays the first answer) | **done** | `62aaf26` |
| Agent-first CLI (envelope, stable reasons, exit codes) | **done** | `86d0d6a` |
| npm publish (`npx standing-orders`) | **done** — 2026-08-13 | published as `standing-orders@0.1.0`; see the M4 operator-publish row |

M0 is functionally complete except publishing. Publishing is deliberately
parked until M1 settles, so the first published version is one whose
unattended loop can be trusted.

## M1 — one task goes queued → branch → commit unattended — **complete 2026-08-11**

Ships when: exactly that, and it did — `src/tick.test.ts` proves it against
real git with only the agent stubbed. Every item below is done and tested;
the closing hardening round was driven by a Codex review of the finishing
plan, which found the mid-build liveness hole was really three holes
(provenance, fencing, and completion acceptance) and prescribed the shape
of the fixes.

The nightly shape: `nightorders reconcile && nightorders tick` from cron.
The sweep recovers what the last night left behind; the pass builds what is
ready and approved; a pull request stays a person's decision.

| Item | State | Proof |
|---|---|---|
| Runner registration, auth from the first commit | **done** | `c8d582b` — token hashed, shown once |
| Runner heartbeat + liveness | **done** | `c8d582b` |
| Worktree pool (treehouse semantics, native) | **done** | `c8d582b` — see scope note below |
| claude builder, gated four ways | **done** | `2f27659` |
| Builder fenced to the exact lease | **done** | `d088ef8` |
| Reconciliation: dead runner | **done** | `c8d582b` — `runner reap` |
| Reconciliation: duplicate completion | **done** | `62aaf26` — reconciled, not refused |
| Reconciliation: orphaned worktree | **done** | `nightorders reconcile` — fail-closed discovery (a failed git listing is an error, not an empty answer), adoption scoped to the pool root, E2E against real git |
| `tick` — the unattended pass | **done** | `d088ef8` — atomic ready-check claim, fenced completion, sorted refusals |
| Release provenance (`released_by`) | **done** | `5cb9357` — a reclaimed lease's late completion is fenced, not accepted as a duplicate |
| Atomic dead-runner recovery | **done** | `5cb9357` — death re-proved inside the transaction that acts on it |
| Heartbeat *during* a build | **done** | the pulse: lease extended + runner touched every beat, error latch, mandatory synchronous re-proof after the agent, post-agent branch recheck (`moved-branch` finally returned) |
| Default-branch protection by discovery | **done** | origin's HEAD, else the parent checkout's branch; if neither can be named, nothing builds — a gate that cannot name the branch it protects is not a gate |
| Durable run records | **done** | `run` table opened before the agent spends, finalized after; outcome NULL = cut down mid-flight; `task show` reports them |
| `tick` honors completion fences | **done** | a completion `completeFenced` refuses is reported `fenced`, never `built` |

**Scope note — "treehouse adapter".** The milestone named an adapter; what
shipped is the pool itself with treehouse's semantics copied wholesale, as
DESIGN.md's credits describe: untracked files count as dirty, in-use is
detected from the running process recorded in the lease marker, and
reconstructed state is leased-until-verified. There is no external
treehouse installation to drive, so an adapter would adapt to nothing.
Recorded here rather than silently reinterpreted.

## M2 — fill one gap, three tasks start — **complete 2026-08-11**

Ships when: one supplied capability lets several blocked tasks dispatch —
and it does, executably: three tasks skipped naming their gap, the
capability supplied with the probe untouched, all three built on the next
pass (`tick.test.ts`). Plan Codex-reviewed 2026-08-11; its findings
reshaped the identity model (tasks carry a repo; requirements are
qualified `kind:name` keys; verification is stamped with whose
environment answered, and tick trusts only what it re-proves where it
stands) and scoped the outbox to episodes with receipts.

The morning shape: `nightorders reconcile && nightorders tick`, then
`nightorders brief` with coffee, and `outbox deliver` pointed at
whatever pings your phone.

| Item | State | Proof |
|---|---|---|
| Capability records + probes | **done** | `capability` table (a test asserts there is nowhere to put a value), `cap add/list/probe`, sh-probes with the probe's own words kept on failure, no manual verify — an assertion is less than a probe |
| Task placement + qualified requirements | **done** | `task_ref.repo`, `task add --repo`, `task require --cap kind:name` |
| Detection from disk (`cap scan`) | **done** | .env.example · .mcp.json · supabase/config.toml · workflow secrets; scanned content never becomes shell code (validated identifiers into fixed templates, or no probe at all); ci secrets are ci capabilities, not manufactured local gaps; scan proposes and never overwrites |
| Dispatch gate: unverified does not run | **done** | inside the claim transaction (a key that expired between survey and take is caught) *and* the builder (`nightorders build` cannot bypass it); tick probes at its own checkpoint and reports each gap by name |
| Fill one gap, three tasks start | **done** | executable in `tick.test.ts`: three tasks skipped naming the gap, the capability supplied with the probe untouched, all three built on the next pass |
| `gaps` ranked by what they unblock | **done** | derived view; a task waiting on two gaps counts toward neither's `unblocks` and both's `alsoBlocks`, so the ranking sends the operator to the right gap first |
| Morning briefing | **done** | `nightorders brief`: the overnight from the run table (cut-down attempts surfaced by name), BLOCKED = the gaps view, REVIEW distinguishes read-and-empty from *not read* (`--local` or a failed `gh`), OUTBOX count, DECIDE points at M3. No token/dollar line until something measures one |
| Notification outbox | **done** | durable rows enqueued in the same transaction as the run record they describe; dedupe keys are episode identities (a gap re-nags after it fills and recurs); delivery passes text as environment, never into the command line; receipts and failed attempts recorded. Quiet hours, escalation, deep links → M4 with the loop |
| Exit-code cleanup (deferred here from M1) | **done** | standalone `build` now exits 1 when the attempt broke (agent/timeout/git) and 3 only when a gate said no |

## M3 — a park renders as one screen, answerable on a phone — **complete 2026-08-11**

Ships when: exactly that, and it does, executably — `serve.test.ts`'s first
test parks, renders the one screen, answers it, and watches the hold lift;
`tick.test.ts` carries the answer into the resumed agent's brief against
real git. Plan Codex-reviewed 2026-08-11 (16 findings, 11 HIGH); the
findings reshaped the park lifecycle into fenced transactions, gave holds
owners, made decision identity the run alone, and kept the driver role
honestly unshipped until M4.

The morning shape now: `nightorders reconcile && nightorders tick` from
cron; `brief` with coffee; `decide` (or `serve`, from the phone) for the
questions; `outbox deliver` for the paging; `incident resolve` for the
parks that could not say what they wanted.

| Item | State | Proof |
|---|---|---|
| Schema: rebuild migration (run CHECK + role, owned holds) | **done** | first versioned table-rebuild; proved against a real M2 fixture, not just fresh databases; `PRAGMA foreign_key_check` before commit |
| Decision / artifact / incident records | **done** | decision's identity is its run (UNIQUE, joined — never denormalized); evidence links refuse to cross runs in the INSERT itself; incidents never age out of a brief |
| `parseDecision` — the 422 rule as a library | **done** | fail-closed, every problem reported at once with stable reasons; reversibility stated or invalid, never defaulted; caps + C0/C1 rejection on every string, because payloads reach terminals, web pages, and later briefs |
| Park path (mailbox, finalizeParkFenced) | **done** | the brief's prose escape hatch is now a protocol: a nonce-named mailbox, ingested once through O_NOFOLLOW, quarantined when stale or cut down, never committed; the seal is one fenced transaction — decision, hold, run outcome, and outbox row exist together or, if the lease was superseded, not at all; a parked pass exits 0; E2E against real git |
| Bounded repair → incident | **done** | two resumed turns, each a `role='repair'` child run with its own model, outcome, and parentage — never called a driver; the compact error names every failure at once; a broken turn spends an attempt; each resume is bound to the exact same durable session id and a provider fork fails closed; exhaustion is the fenced incident transaction; no session id, no repair — straight to the problems |
| Evidence capture (machine-collected) | **done** | base revision stamped before the agent spends; diff (ext-diff and textconv disabled) + porcelain inventory captured at park, hashed, bounded, with the capture command and exit recorded; a truncated or failed capture says so; files 0600 outside the worktree, keys relative to the evidence root beside the database |
| `decide` + brief DECIDE, authenticated answers | **done** | answering takes the approver credential — who decided is recorded, never asserted; one transaction for the CAS + hold + outbox episode; answered once (same choice replays, different refuses); expiry gets louder, never chooses, stays answerable; `incident list/resolve` is the authenticated act that frees a malformed-park task (`task unhold` deliberately cannot); brief DECIDE and INCIDENTS are real, and incidents ignore the briefing window |
| Resume (run_decision causation, attention budget) | **done** | answers attach to the resume run causally, snapshot included — a failed resume is handed them again, a built run is the terminus, never "newer than" timestamps; the resumed brief quotes question/option/note fenced before the rules and the trusted directive names only ids; §8's attention budget re-proved inside the claim transaction — measured parkers step aside over budget, first-timers pass, park_rate maintained where attempts conclude |
| Web decision view (`serve`) | **done** | node:http, zero dependencies, no page JavaScript; approver credential required on every bind, localhost included (cookie session HttpOnly SameSite=Strict, or Bearer name:token — never a URL); Host proved before routing, Origin + CSRF on cookie mutations; every string escaped at the sink under a default-src 'none' CSP; irreversible options confirm-armed and server-checked; evidence streamed only through the decision's relation, hash re-proved, as a plain-text attachment. The milestone sentence is `serve.test.ts`'s first test |
| Driver role | **deferred to M4** | the design's driver is the event-woken gate agent, which first exists with the loop; repair turns are recorded as `role='repair'` with parentage, because calling them a driver would make M4's cost data mean two things |

## M4 — the loop — in progress (2026-08-12)

Plan Codex-reviewed (37 findings, 24 HIGH; the findings are the spec).
Executed as M4a (accounting, failure semantics, capacity, watch recovery)
then M4b (publication, CI, briefing, packaging). Deferred post-M4, in
writing: quiet hours, unanswered-decision escalation, deep links,
multi-chat routing, the CI-repair driver, external-backend dispatch.

| Item | State | Proof |
|---|---|---|
| Schema v4 | **done** | 'no-change' outcome, 'backoff' hold owner, stall/commit-failure incidents, strikes, claim incarnations, economics columns; one generic exact-DDL rebuild that refuses unknown shapes; proved on M2 and M3 fixtures |
| Invocation gateway | **done** | `invokeAgent` is the only door to the provider binary — an architecture test fails any new direct call; runs are stamped before the spawn (provider spawns == stamped runs, crash-honest); usage read off every completed process, nonzero exits included; unmeasured stays NULL, never $0.00 |
| Terminal handoff; the builder owns commits | **done** | agents no longer commit — post-agent HEAD must equal the base or it is `moved-head`, work preserved; every attempt ends with a typed handoff (completed / no-change / failed) or it is a `no-op` protocol failure; a stated no-change with a clean tree is a first-class successful outcome; agent-reported failure carries the agent's own words |
| Measured economics in the brief | **done** | dollars and tokens summed from run records, reported as "measured across M/N invocations" with the gap named — no unqualified totals |
| Fenced failure finalizer, backoff, strikes, stalls | **done** | one transaction: fenced release, typed run outcome, strike, doubling backoff hold (1-2-4-8-16m) or the three-strikes stall (incident + failed + held + paged once); commit-stage failures take neither road — an incident guards the preserved worktree, no strike; classification trusts only what the machine observed (timeout→retryable, protocol→no-op, everything else unknown with bounded retry); successes and parks reset the streak; authenticated `task requeue` undoes a stall in one transaction; STRANDED brief section names tasks behind terminally failed blockers |
| Capacity + quota gates | **done** | both inside the claim transaction with every other readiness fact: live claims counted where the claim lands (a free CPU against a full ledger is not capacity); quota keyed (runner, provider, scope) with lazy exhausted→half-open at the known reset, exactly one probe admitted and re-armed while it flies, success clears the stamp; nothing stamps quota from stderr prose — structured signals or an operator only, machinery ready for the provider adapter |
| watch (lease, incarnations, work-conserving, graceful stop) | **done** | one process composing the tested passes; watch+watch exclusive per (runner, repo), cron coexists via claims; every readiness-changing write bumps a durable wake sequence and the loop drains until refusals — a freed dependent builds in the same window, proved by a chain built under an hour-long interval; claims carry the incarnation UUID and a successor recovers exactly its predecessor's claims/runs/worktrees before dispatching (the crash liveness cannot see); signals stop admissions while the in-flight pass finishes under its own bounded timeouts and the lease keeps beating. Deferred with this note: hard kill of the provider process group on grace expiry |
| Telegram follower + event wake | **done** | one reusable long-poll actor (`followBridge`): bounded polls (25s, under the transport's 30s HTTP timeout — the client never aborts a poll Telegram is honestly holding), fenced lease renewal per cycle (a lapse takes the next generation and the cursor rides it, stranding the old poller's writes), exponential reconnect backoff, cancellation aborts the in-flight poll; standalone `bridge telegram --follow` AND embedded in watch by default when a token is configured (the timer pass remains the no-token fallback); answering already bumps the wake sequence, so a tap resumes the freed task in the same watch window — phone to build, no timer in between; a hot-spin floor pads instantly-returning transports |
| `daemon` — the loop as a service, no crontab (operator request 2026-08-12) | **done** | `daemon install/status/uninstall/logs`: writes launchd (macOS) or systemd --user (Linux) units running `watch --token-file`; the runner token lives 0600 beside the database, never in the unit; crash-only KeepAlive with throttle, restarts made safe by incarnation recovery; unsupported platforms refuse with instructions; supervisor calls scripted in tests; Windows added same day — Task Scheduler XML (logon trigger, restart-on-failure, IgnoreNew singleton, cmd log redirection) via schtasks, honestly noted as not yet exercised on physical Windows |
| Publication grant + durable push/PR intent | **done** | schema v5 (additive): an authenticated publication grant separate from tracker writes — `push-branch` and `open-pr` as distinct capabilities, exact GitHub repo/remote/head-prefix/base, task selector, draft mode, terms printed before `--yes`, revocation immediate; the intent is written **inside the fenced completion transaction** (claim's `inTransaction` now joins the store's reentrant transact) so "done" and "this must reach a PR" cannot come apart; the worker pushes the exact accepted SHA (`git push remote sha:refs/heads/head`), then adopts any existing PR on that head before daring to create (`gh pr list` → `create --body-file`, never `--body` — the body quotes an agent), every phase durable and crash-retryable, `MAX_PUBLISH_ATTEMPTS` then a durable failure that pages; the PR body regenerates byte-identical from run records (base/head SHA, answered decisions, conclusion fenced as prose so `Fixes #…` gains no semantics); `no-change` publishes nothing; CLI `publish [grant\|revoke\|status]`, and watch publishes in the same window it builds |
| CI observation + watch-episode briefing | **done** | `observeChecks` reads the structured rollup and exact head OID for every PR this plane opened (`gh pr view --json`), reusing the brief's passing/failing/running/none semantics plus not-read for transport failure; CI episodes keyed `ci:<pr>:<headOid>` — a red head pages once, resolves when that exact head turns green or a newer commit buries it, and `none`/`running`/not-read are never called green (an unread rollup neither pages nor resolves); watch observes on the reconcile cadence. The night is a row: `watch_episode` (repo, runner, incarnation, window, totals) written at start and sealed at exit — a crash leaves `ended_at` NULL, which is itself data; `brief --latest-watch` bounds the morning to exactly that episode's runner and window instead of "the last 24 hours" |
| Twelve-task E2E | **done** | unattended.test.ts — one fake-clocked night against real git, built-in backend only (stated; external dispatch deferred): clean builds, honest no-change, a park answered mid-night via `decide`, three strikes → attempts-exhausted → authenticated requeue → built, a timeout that backs off and recovers, a dependency chain, a scope approved while the night runs, duplicate empty passes refusing idempotently; the zero-token invariant asserted as arithmetic (provider spawns == stamped runs, exactly); eleven publications pushed and opened against scripted gh; the brief telling the same story from the same rows (12 built, no decisions, no incidents, nothing stranded) |
| Packaging (Node >=22.13 floor) | **done** | engines `>=22.13.0` (node:sqlite's floor — publishing `>=20` would ship a runtime that cannot open its own database); `files` allowlist ships dist + README + LICENSE + manifest only; LICENSE (MIT) added; the published build strips source maps (tsconfig.build.json); version 0.1.0; `npm pack --dry-run --json` inspected — 69 files, ~250KB, no tests, no maps, no databases, no evidence, no tokens; the exact tarball installed `--offline` in a clean temp project and its bin ran discovery and opened a database on Node v22.22 (the 22.13 exact-minimum run is noted as not yet performed — no such runtime on this machine) |
| Operator publish + registry verify + tag `m4` | **done** — 2026-08-13 | Alex ran `npm publish` (with the 2FA the registry demanded). The first attempt was refused and thereby caught a shipping bug: npm's normalizer silently deletes a `./`-prefixed bin path, which would have published a package `npx` could not invoke — fixed in `e0a75c3` before anything reached the registry. Verified after: `npm view standing-orders` shows 0.1.0 with `bin = { 'standing-orders': 'dist/cli.js' }`, and a cold `npx -y standing-orders@0.1.0 --help` from the registry in a scratch directory with its own npm cache printed the real usage screen. `git tag m4` follows this verification, in this same commit's push |

## M5 — foundations + see the work (2026-08-13, the competitive round: two research passes + Codex review; scratchpad roadmap-m5-final.md + codex-roadmap-findings.md ARE the spec)

The strategy Codex endorsed: the field optimizes live steering; unattended
with phone check-ins is the blind spot and we hold six of its seven
requirements. Close the see-the-work table stakes, surface what is already
recorded, keep every invariant. Notable rulings absorbed: reportsCost stays
claude-only (tokens are not dollars — flipping it would fake a dollar
ceiling); merge-when-green is out (a standing grant cannot make a merge
reversible, and the plane executing merges would end PR-as-terminus) —
replaced by a read-only review queue; the v1 diff is the immutable terminal
diff, because during the agent turn HEAD must equal base by design.

| Item | State | Proof |
|---|---|---|
| Envelope contract — one versioned machine shape | **done** | src/envelope.ts: `envelopeJson` stamps `envelopeVersion` 1 ahead of `ok`/`command`; all ~35 emission sites in operate.ts + cli.ts route through it (the sed left zero `JSON.stringify({ ok` — enforced by a source-rule test); scan/pulls/graph joined the envelope (pulls' bare array and graph's naked object were pre-1.0 wire breaks taken deliberately, empty-repo cases now fail as `no-repositories` instead of printing `[]`); `standing-orders contract` states the version + bounded capability tokens (envelope/1, stable-reasons, idempotency-keys, exit-codes/0-1-2-3, output-file), consumers told to ignore unknowns; `-o <file>` at the entry point tees the captured envelope to a file (requires --json, refused as usage otherwise) so an agent reads its answer from a path, not scrollback; envelope.test.ts (8) sweeps success/failure envelopes across eight subsystems |
| Provider audit + init-failure gating | **done** | provider.ts `auditOf`: per-provider facts — transport, resume support, init signal, the review-only cwd restriction (`--restricted`, proven resume-safe), and the user-global config surface that can reach an unattended build; `enforced: false` remains literal at provider scope because ordinary build turns are not cwd-restricted. `providers` renders transport/resume/isolation/config surface in its envelope. Init gating: ParsedEnvelope.initObserved (codex: thread.started seen; claude buffered: null — absence proves nothing and is never flagged), invokeAgent.initFailed only when the init signal exists, was not seen, AND the turn has nothing to show (a renamed event on a working turn must not read as broken; timeout/notFound excluded), builder + repair + planner return typed `provider-init`, classified retryable-infra — a broken environment never counts as three strikes of bad agent work. invoke.test.ts +4, provider.test.ts +2 |
| Immutable terminal diff per run | **done** | schema v11 (artifact.kind admits 'terminal-diff' + 'diff-stat', same recognized-exactly CHECK-widening recipe as v7); evidence.ts `captureTerminalDiff` — the exact base→accepted-head patch captured while the worktree still exists, under the park capture's execution posture (--no-ext-diff --no-textconv --no-color, bounded bytes, hash, capture command + exit recorded; a failed capture stores the failure); `parseNumstat` reads `--numstat -z` NUL-delimited — filenames never guessed from patch headers, binary counts null never zero, renames carried, file list bounded at 400 with counts complete; a no-change run stores the EXPLICIT zero (base against base) because "no artifact" must never be how no-change reads; run page leads with the stat + capture-health card (base→head named, empty/failed/truncated visibly distinct) and folds the bounded patch under &lt;details&gt; with a raw-artifact link — no JS, no per-file endpoints, no nonce. Bycatch: the builder test harness's empty-string worktree was landing handoff files in the process cwd — the repo-root protocol-file museum finally explained; per-test worktrees now, debris swept |
| Machine-phase activity chip | **done** | run.phase (v11 additive), a CLOSED four-value vocabulary the control plane stamps at its own state-machine boundaries — agent-running / validating-handoff / capturing-evidence / committing — never parsed from a provider stream (the Codex slice: machine phases first, normalized provider events later, post-audit). setRunPhase refuses unknown values and leaves a finished run's phase as history; building cards wear the phase in plain words ("agent working", "checking the handoff") via the board's EXISTING refresh — zero new polling, zero provider invocations, unknown values from a newer daemon show nothing rather than raw tokens; run pages show phase only while open. Bounded writes by construction: four values, each boundary passed once |
| Evidence-first screens + attempt ledger | **done** | task page reordered: decisions and incidents (what needs you), then the attempt ledger — every run with provider, duration, tokens, dollars-or-"unmeasured $", repair parentage — then spend, THEN the mechanics (scope, holds, acts). A retry storm now reads as the spike it is instead of hiding in a total. Only trustworthy facts moved up; the agent's conclusion stays labeled the agent's, on the run page, last |
| Cost surfaced honestly (tokens ≠ dollars) | **done** | spend-by-provider card on the task page (dollars only where measured; "dollar cost unmeasured" and "$X across M/N measured" as first-class states — never a fabricated $0); run page cost fact says "dollar cost unmeasured — this provider reports tokens, not prices" instead of hiding the row; /runs rows carry non-claude provider + "unmeasured $". reportsCost stays claude-only per the Codex ruling — routines keep failing closed on unmeasured providers |
| Per-repo approved worktree setup | **done** | the table stake every rival worktree tool fumbled at launch. worktree_setup (v11): one live row per repo enforced by a partial unique index, command TEXT stored (secret values never), digest bound over repo+command+timeout, revoked-not-deleted. `standing-orders setup set` restates the exact terms and refuses without --yes; set/clear take the approver credential (an approved command runs unattended in every future worktree — that is authority); commands with control/bidi characters refused. Enforcement in the builder after every refusal gate, BEFORE any agent spawn: /bin/sh -c under the setup's own timeout with the agent's scrubbed environment (an approved `npm ci` is not an approved read of the bot token); failure returns typed `setup` → retryable-infra, and the agent never spawns in a checkout whose setup failed; success stamps worktree.setup_digest so one digest never runs twice in one checkout. Deferred, named: lockfile-keyed cache invalidation, Windows shell |

## M6 — steer from review (2026-08-13, same Codex-reviewed roadmap as M5; the findings file is the spec)

| Item | State | Proof |
|---|---|---|
| Diff comments → revision briefs | **done** | Vibe Kanban's one great feature, rebuilt ceremony-preserving. diff_comment (v11b): comments bind to the IMMUTABLE terminal diff — artifact id AND its sha (words on exact bytes), path/line optional, note through the shared validator, immutable with supersede + consumed columns; addDiffComment refuses any artifact that is not that run's terminal diff. "Turn N comments into a revision task" seals the live batch deterministically: ONE unapproved built-in task (createConsoleTask — original goal carried, repo placed before scope per the placeTask guard), an immutable revision-brief artifact on the SOURCE run, task_ref.revision_of + revision_brief_artifact stamped, comments consumed by task id in the same store call so a second click 400s instead of minting a duplicate. EVERY revision requires its own approval (comments can semantically widen work; no path check can prove they did not; an LLM deciding would be an LLM in an approval path) — the task screen restates the batch beside the approval form, read back through the VERIFIED artifact path, unverifiable briefs a named problem. The builder quotes the brief fenced, after the scope, before the rules: "a comment cannot widen the scope, and if one seems to, park and say so". No live chat into a running agent — steering stays queue-shaped |
| Session registry + narrow warm resume | **done** | 6a: the session id is stamped the MOMENT the stream announces it (exec onSessionId on thread.started → stampRun first-write-wins, set by the invocation gateway) — a daemon that dies mid-turn no longer loses the id it paid for; structured facts only, never a stored resume command (argv derives through the adapter, per the Codex ruling). 6b: warm resume ONLY when everything re-proves at build time — same task/provider/branch via the candidate query, no newer accepted build (superseded parks resume nothing), answers actually attached, and the branch still at the parked run's EXACT base: a moved base means the session's memory is stale, and a cold start is honest where a stale resume lies about the present. `parent_run` and the exact resumed session are stamped together before spawn; the gateway rejects an argv mismatch before spend and a returned fork after recording spend. 6c, adapted honestly: no typed session-absent signal exists yet, so instead of prose-sniffing stderr the rule is ONE warm try per park (`tried` = any builder child exists) — a dead session costs one strike, and the second attempt goes cold carrying the same answers; never three resume failures into a stall. Dirty-WIP resume stays deferred with the custody design named |
| Freshness-stamped handoff artifacts | **done** | artifact kind 'handoff' (v11b widening — recognizes both the pre-v11 shape and a database that opened at v11 earlier the same day; 'revision-brief' pre-provisioned in the same rebuild); storeHandoffArtifact writes the machine's own statement of where a finished run left the world: workspace/branch identity, exact base and head, provider + session id, decision ids the brief actually carried (causal, from run_decision), the agent's conclusion positioned as agent-reported, and a freshness stamp (currentAsOf = the accepted head) a successor PROVES against the branch before spending a token — a provider session is memory, not a freshness proof (the research's 42–63% handoff saving belongs to context-bearing handoffs, and this is the context). Written for built and no-change runs beside the terminal diff; parked runs already hand off through the mailbox |
| Operator note + honest requeue label | **done** — late entry, shipped in 8dbdbba | run_note (v11 additive): immutable, bounded by the decision-note validator (500u/2000B, control/bidi refused), ordinary authenticated mutation with CSRF — NO nonce, nothing here approves anything; ceiling-checked like every run resource; rendered beside the machine's record. The requeue act now says what it keeps: "retry — branch and workspace kept", because runs and evidence are audit history and nothing destructive hides behind one tap. Fresh-retry-from-clean-base stays a future designed workflow with branch generations, per the Codex cut |
| Deterministic hard stop | **done** — late entry, shipped in 719f2d0 | providers spawn detached in their own process group, set by the invocation gateway and nowhere else; the streaming AND buffered transports both register live providers and both kill the GROUP on timeout (the execFile path detours through spawn when a group is required, same contract: output caps, overflow≠timeout, ENOENT). Watch: first signal graceful + starts --stop-grace (default 30s); expiry or a second signal SIGKILLs every live group via terminateLiveProviders. Runs finalize as failures, worktrees preserved, fences keep late output out of commits. The test spawns a grandchild and proves the corpse: kill(pid, 0) must throw |

## The M5–M8 post-build audit (2026-08-13, Codex: 0 critical, 6 high IV, 10 bugs, 6 deviations, 10 test gaps — scratchpad codex-m5m8-audit.md is the full report)

**Fixed this pass** (audit ids): IV-2 revisions and CI repairs INHERIT the
source scope's outOfScope and touches (createConsoleTask takes a full
scope draft; the approval screen stops claiming "no exclusions" over work
that had them). IV-3 revision approval FAILS CLOSED: no nonce and no
approve form over a brief that does not verify, the POST re-proves the
brief at the moment of the yes, briefs are size-checked BEFORE any task
exists (structured JSON is never byte-truncated), and the builder refuses
typed `revision-brief` instead of silently building comment-free. C-3
sealing is ONE transaction (store.sealRevision: task + artifact + relation
+ exactly the expected comment batch or rollback; the brief file is
written first under a nonce name — an orphan file is not authority). IV-4
the planner brief fences its inputs (inert(): controls collapse, protocol
prefixes break, fences cannot terminate — GitHub issue titles reach the
planner as quoted data). IV-5 partial: setup runs under an extended
denylist, setup stderr is REDACTED and bounded before touching SQLite or
the outbox, and `setup set` refuses credential-shaped commands (a `$VAR`
reference passes; a literal value does not). IV-6 Windows kills the tree
via taskkill /T /F (stated untested on physical Windows, like the
daemon). IV-8 `-o` writes 0600, never through a symlink or onto a
non-regular file. IV-9 PR bodies neutralize agent text (inline prose
flattens newlines; conclusions ride INDENTED, which no backtick can
terminate; template v2). IV-10 comments, seals, and PR-comment ingestion
all VERIFY the diff bytes before words attach to them. IV-11 only an
https github.com pull URL earns an anchor. C-1 watch --json sends every
progress line to stderr — stdout is one envelope. C-2 CI episodes are
keyed repo+PR+head (PR #55 in repo A can no longer light repo B's repair
button); repair briefs bind the OBSERVED failing head and its observation
time, never the click. C-6 merged/closed PRs leave the watch and the
review queue (publication.remote_state, additive). C-5 pr-comments
requires publication.githubRepo === grant.github, paginates, validates
the array, matches logins case-insensitively. C-7 deterministic ids
truncate the prefix, never the identity-bearing suffix. C-8 initFailed
requires finalMessage === null — a failed turn WITH words is an agent
failure. C-9 source_key races land in ON CONFLICT DO NOTHING. C-10 skills
ownership = exact header + mark; damaged AGENTS.md blocks refuse typed
instead of false-success. IV-1 partial: Context.shouldStop fences routine
fires and every claim admission mid-pass, and a stopping watch publishes
nothing more. Tests: +IV-2/IV-3 revision integrity E2E, +same-day-v11
migration fixture (the exact e2a08c5 shape), +C-8 nonzero-with-message.

**Deferrals closed in the follow-up pass (840 tests)**: IV-1 COMPLETED —
the stop fence rides into the builder (BuildRequest.shouldStop) and is
re-proved at the LAST gate before the commit: an operator's stop beats an
agent's finish, the work stays uncommitted and preserved; typed `stopped`
→ retryable-infra; tick test proves a fenced pass admits nothing and
spawns nothing. IV-7 COMPLETED — high-confidence secret scan (private-key
PEM, AKIA, gh tokens, slack, npm _authToken, sk- keys; deliberately NO
generic password= shapes — a detector that cries wolf trains people to
approve wolves) runs on every terminal diff: hit lines are redacted in
the stored artifact, the row says redacted, a page names the branch, and
publishPass REFUSES to push a redacted run — the branch holds the real
bytes and a person rewrites it. IV-5 COMPLETED — setup shells run under
an explicit ALLOWLIST (PATH/HOME/locale/temp; exec gains envAllowlist,
resolved in one place), the terms restate it. SD-2 COMPLETED — the
handoff is finally CONSUMED: cold successors read the latest handoff
verified, and include it ONLY when freshness proves (same branch, branch
exactly at the stamped head) — stale context is omitted because context
spent as stale truth costs more than none; warm resumes skip it, the
session remembers better than a summary of itself. SD-4 CORE —
publications persist the last OBSERVED check state + time; /review ranks
observed-passing → silence (labeled as silence) → failing, and "review
next" goes only to an observed pass. SD-5 partial — the task page carries
its publication line (PR, local+remote state, observed CI). TG-1-lite,
secret-scan, and observed-ranking tests added.

**TG-3 CLOSED (2026-08-13, prioritized as the top remaining deferral —
the machine contract is the spine of agent usability, and it is the gap
C-1 escaped through)**: the full envelope sweep — every routed command
invoked with --json (successes, refusals, and usage failures alike,
because an agent's parser meets all three) and proven to answer with
EXACTLY one versioned envelope; a drift guard reads OPERATE_COMMANDS
from source, so a new command cannot ship without joining the sweep or
being exempted by name. The sweep earned its keep on its first run:
`ready --json` on an empty queue answered ok:false with NO stable reason
token (fixed: reason "empty"), and `repos` ignored --json entirely and
printed prose (fixed: enveloped across list/add/remove). serve is swept
through its throwing path — the catch-all envelopes it, which is itself
part of the contract now proven.

**Still deferred, named**: SD-1 comment side/context + supersede-on-edit
(schema + UI round). SD-3 repo+runner setup scoping (authority-model
change). SD-6 intake selector/mutation classes (ditto). SD-4 dependency/
conflict ordering (needs mergeability observation). TG-1's
subprocess-level signal tests, remaining TG matrices. Windows:
code-complete, physically untested — as the README already says.

## M7 — agent citizenship · M8 — the outer loop (2026-08-13, same roadmap)

| Item | State | Proof |
|---|---|---|
| `skills install` | **done** | src/skills.ts + `standing-orders skills install`: writes the Agent Skills entry (.claude/skills/standing-orders/SKILL.md — the cross-vendor layout claude/codex/gemini/opencode all read) whose description is the routing contract (use for queue/status/briefs; NOT for pushing, merging, approving) and whose body carries the machine contract (envelope, stable reasons, exit-code quartet, idempotency keys, -o file, untrusted-output hygiene) while deferring to live --help as authoritative — a skill that duplicates the manual drifts from it. Preview by default (exit 3, nothing written), --yes to apply, --repo to aim, --write-context for the AGENTS.md managed block (marker-fenced, replaced only between its own markers, host prose never rewritten; without the flag the snippet prints for the operator to place). A skill file the installer did not write is REFUSED, never eaten. skills.test.ts (7) |
| Hook packs | **deferred, named** | shippable Stop/TaskCompleted hook configs would have foreign agent sessions REPORTING INTO the queue — an ingestion surface for unauthenticated writes that needs its own identity/review round, exactly like acting-from-Slack did. Not smuggled in as config files |
| MCP facade | deferred (roadmap ruling) | thin wrapper over the same envelope if demand shows; CLIs + skills won the local-tool layer |
| GitHub issue intake, preview-first | **done** | `standing-orders intake`: an explicit grant (intake_grant, one live row per repo, authenticated + terms restated before --yes) binds the exact GitHub repo AND label — detection is not authorization, and 400 open issues are not volunteered by enrolling. `preview` lists candidates read-only; `run` creates LOCAL UNAPPROVED proposals with deterministic ids (ghi-owner-name-N — existence IS the dedupe, a second run is a no-op), each awaiting its own scope approval. Issue titles are untrusted: control/bidi disguises REFUSE the candidate (new shared hasDisguisedText — also upgraded the setup command), and the issue BODY is never imported at all — the proposal links to GitHub where a person reads it. Nothing remote is ever written; external-backend dispatch remains unshipped and the command does not pretend otherwise. gh is reachable only under a grant, injected in tests |
| PR review-comment intake | **done** | `intake pr-comments`: own PRs ONLY (the publication table is the list of ours), reviewers named in the grant only (a grant without reviewers keeps this off — refused typed), the GitHub comment id the idempotency key (diff_comment.source_key, v11c, unique where present — a second pass reports duplicates, ingests nothing), every body through the shared validator (control/bidi refuse), paths disguise-checked, authorship recorded as github:<login>. Ingested comments land as ordinary diff comments bound to the run's terminal diff — they wait on the run page for the SAME one-tap seal and the SAME scope approval as comments typed in the console; no comment authorizes a spawn |
| CI-repair, suggestion-first | **done** | a red episode never spawns an agent — it EARNS a button. The run page shows "draft a repair task" only while an OBSERVED failing episode is open on that run's PR; the button creates ONE unapproved task through the revision machinery (deterministic id <task>-ci-<pr> — the second click is a 409, not a twin), brief carries pr/head/observedAt and deliberately NO log content ("read the failing checks on GitHub before approving") because external logs are injection-capable and failing-check retrieval is a later, named slice. Autonomous repair stays behind a future digest-bound standing term |
| Review-backpressure queue | **done** | /review, READ-ONLY: every open PR this plane published (ceiling-checked), reviewable-first then oldest, the top one marked "review next"; CI honesty preserved — an open episode reads "CI failing — observed", absence reads "no failing observation (the machine never calls silence green — verify on GitHub)"; deep links to the PR and the build; NOT ONE form on the page, because merge-when-green was ruled out (irreversible-never-auto-applies + PR-as-terminus) and the person merges on GitHub. The field's loudest skeptic refrain — the bottleneck is review, not parallelism — answered with the page that compresses review |

## The primary messenger (2026-08-13, the operator's ask: "ask which service… allow selection of primary")

Exactly ONE service carries the pages. `effectivePrimary` resolves it:
the explicit choice when its service is actually configured (a primary
pointing at nothing falls through rather than silencing every page),
else Telegram when present (it can hold buttons), else the sole mirror —
and the `implicit` flag is what every surface uses to say "several are
set up and none was chosen". The ASK happens at the moment multiplicity
first appears: `webhook set` adding a second service prompts
interactively (non-interactive prints the command instead), and the
console settings screen gains a "who pages you" radio — configured
services only, POSTed behind authorizeMutation, written to the same
0600 file the CLI writes. Telegram keeps draining taps and replies even
when another service pages (`deliver:false` threads through bridgePass
AND the embedded follower): answering is its job whether or not paging
is. Non-primary services stay silent — nothing pages twice. 793 tests.

## Slack and Discord, UI-only (2026-08-13, the operator's scoping — "can be ui only")

Chat mirrors, deliberately one-way: every page becomes a message with a
deep link into the console (decisions to their screen, everything else to
/next), and the ACTING stays in the console behind its own
authentication and step-ups. No bot, no pairing, no inbound events — an
outbound webhook is not an authentication surface, which is exactly what
made this cheap; the day acting-from-Slack is wanted it gets the Telegram
treatment (its own review, its own identity model), never a shortcut
through this module. Webhook URLs are CREDENTIALS: shape-checked, 0600
files beside the database or environment variables, never a column,
never in an error (a failure names the platform and status only —
proven). Delivery rides the SAME claim/finalize discipline as every
deliverer, so a mirror and a bridge can never both own one row; mirrors
deliver when Telegram is not configured, and stay quiet when a paired
chat (which can carry buttons) does the paging. `nightorders webhook
set slack|discord|console-url · status · test · clear`; the watch loop
mirrors on the bridge cadence. Node 22's global fetch — still zero
runtime deps. 792 tests.

## Free-text answers from Telegram (2026-08-13, Codex security review: verdict "safe with conditions" — the conditions ARE the build)

Reply to a decision message with prose and it becomes the answer's NOTE;
choosing stays TAP-ONLY forever (finding 2: mapping prose to an option is
never safe). The reply is accepted only as an authenticated thread: live
binding, private chat, exact chat AND user ids, a reply_to that maps
through the new outbound-message→decision table (every sent part
recorded; a lost record fails closed — never routed by recency), the
decision still unanswered, and direct initial plain text — forwards,
media, captions, bots, edits, and channel identities are silence, and so
is everything else wrong (a correction is an oracle). The note passes ONE
shared validator (500 units / 2000 bytes / controls AND bidi-invisibles
refused) before persisting as an IMMUTABLE, expiring draft — one live per
decision, superseded only by a GREATER update_id — and the bot echoes the
exact captured text back, line-prefixed, so editing the original message
cannot rewrite the audit. A tap consumes the live draft WITH the answer
in one transaction; duplicate success now requires the whole tuple
(choice AND note — a racing web answer without the note is
already-answered, never a silent success, finding 4); an EXPIRED draft
never silently drops (the tap is refused once, token unconsumed, and says
so). Irreversible confirms bind the note's digest: the challenge displays
the note it would travel with, and a newer note, expiry, or cancel
strands the armed yes (finding 3). The agent-facing fence now collapses
Unicode line separators, breaks quoted NIGHTORDERS- prefixes visibly, and
a trusted rule bounds the note to refining the CHOSEN option — never
choosing, widening, or overriding (finding 5). Schema v10. 789 tests.

## The unblock-first push (2026-08-13, Alex's three criteria; five phases)

Criteria: simple to understand and action · accelerates the work · keeps
the operator unblocking and creating. Phase A ships **/next — the triage
flow**: everything waiting on a person, ONE card at a time, hardest-
blocked first (oldest question → plans/scopes to approve → stalled work
to retry → requirement gaps), full context on the card (recap + question
with the answer buttons inline; the restated scope and plan document with
the password step-up inline — the nonce may mint here because the card
restates the digest-bound terms, the same rule as the task screen), and
every act 303s back to /next: clearing four items is four acts, not four
navigations. "Not now" is a bounded URL cursor (never session state — two
tabs cannot fight, a shared link shows the same queue) and the all-clear
remembers what was set aside. The decision answer forms were extracted to
ONE builder shared by /d and /next; return paths stay allow-listed. The
inbox offers "clear the queue →" only when something waits. Phases B–E
followed the same day — ALL FIVE SHIPPED. **B, the roll-up inbox**
(Codex pre-implementation review: 13 findings, its prescriptions built
exactly): with no project open, `/` is the overall inbox — every store
read either binds a repo-list admission BEFORE its LIMIT or returns
unbounded with the row's repo projected, serve re-proves every row with
rowVisible, the badge's union admits inside every branch (and gained the
cancelled-blocker branch it silently omitted), the cancelled-blocker
aggregate joins BOTH refs so a cross-project edge cannot leak a foreign
project's cancelled state, roll-up rows are LINKS ONLY (no forms, no
nonces, no capture), unplaced work wears an explicit chip, and the
needsProject exemption is exact-path `/`. **C**: below 40rem the board
stacks needs-you → building → queued → waiting. **D**: "since you last
looked" on the board — built/failed/asked since this session's previous
full read, fragment polls never move the anchor. **E**: quick capture on
the project inbox — title + goal straight to the approve step-up, two
steps, through the same guarded handler. 786 tests.

## Providers + phase configuration (2026-08-13, Codex plan review: 1 crit, 6 high — its prescriptions ARE the spec)

Three harnesses behind the one door. `provider.ts` is the only module that
may name a binary: **claude** (dialect unchanged, byte-identical, the
whole suite proves it), **codex** (`exec --json`, sandbox
workspace-write, resume as a subcommand, `login status` as the one cheap
identity probe; wall clocks clamped below claude's because codex has no
turn bound), and **openrouter** — the codex harness pointed at OpenRouter
through constant `-c` overrides (keys never caller-supplied, values
TOML-quoted, model ids validated against an argv-safe charset that still
admits `/ . : -`), the API key read from the runner's environment and
EXCLUDED from every shell the model itself launches. Codex JSONL rides a
new streaming transport retaining only load-bearing lines — the buffered
runner would overflow at 8 MiB and lose the terminal usage of a paid run.
`invokeAgent` takes a semantic request, refuses a run opened for a
different provider (repair inherits its parent structurally — a session
resumed across harnesses is not a session), and quota is keyed to the
resolved provider. The architecture rule reads IMPORTS, not string
literals. Schema v9: `run.provider` across all three canonical shapes
(default 'claude' — truthful history), the task agent pin, `phase_config`.

**Configuration**, layered and stated: pinned task agent (nothing
overrides it) > pass flags (`--provider/--model`,
`--plan-provider/--plan-model`, `--repair-model`; per-field — `--model`
rides the resolved provider, `--provider` runs its own default) > project
override > installation > default. Config rows live IN THE DATABASE as
complete pairs, written only by authenticated, audited verbs
(`nightorders config set/clear … --as --token`) — spend routing is
authority, and a 0600 file under the agents' own UID is not a boundary.
Routine firings resolve the instance agent inside the fire transaction
and PIN it (the review's critical finding: approved-terms firings must
not be re-routed by later flags), and a cost ceiling against a provider
that reports no dollars skips the slot with a page instead of deadlocking
on the second firing. `nightorders providers` keeps four claims apart:
installed / configured / historically successful / currently
authenticated (codex only — claude has no non-spending probe, and the
report says so; an OpenRouter key's presence "is not authorization").
Codex/openrouter runs land honestly UNMEASURED in dollars.

Deferred, named: an explicit digest-bound `agent` term on routine
templates (the fire-time pin already carries the safety; the term adds
the operator's explicit choice at approval), console surfacing of
provider/config state (system page card, board provider chips), per-task
one-off override, an agent-reviewer role (its own design round). 777
tests.

## Routines — standing orders as tracks (2026-08-13, Phase C; findings 4, 5, 9, 10 are its spec)

A routine is a pre-approved template for repeating work: goal, exclusions,
touches, requirements, schedule (`every:<minutes>` or `daily:<HH:MM>` UTC),
single-flight, and a rolling 7-day cost ceiling — every term under ONE
digest (schema v8: `routine`, the `routine_fire` ledger, and
`task_ref.routine_id`, all additive). Approving the template — CLI
`routine approve` or the console's step-up, both restating "each firing
builds WITHOUT asking" — is what makes instances legitimately automatic;
editing any term strands the yes. Firing is one store-owned transaction
(`fireRoutine`) that re-proves approval-digest equality, unpaused,
due-ness, single-flight, and budget before any write (finding 4): the
instance spawns as an ordinary task placed in the routine's repo, its
scope copied byte-for-byte from the row proven approved in that same
transaction and stamped with the template's approver — no caller supplies
approval fields. Budget FAILS CLOSED: a paid run with no recorded cost
blocks the track as "unmeasured" rather than counting as headroom
(finding 5). A due slot that cannot fire is recorded on the ledger —
unique `(routine_id, scheduled_for)` is the idempotency — and the
schedule advances aligned to cadence: one overdue firing after downtime,
never a backfill burst, never drift (finding 10). A blocking instance
pages once per instance (`routine-singleflight:<id>:<task>`), and a later
successful firing resolves the episode (finding 9). The pass (`tick`,
therefore `watch`) fires due routines before reading the ready set, so an
instance builds in the window that spawned it — proved end to end against
real git, including the stuck-instance-stops-the-track case. Surfaces:
`routine add/list/show/approve/pause/resume/run-now` (run-now is manual —
same proofs, refuses to your face, no ledger noise, schedule untouched);
`/routines` + the routine screen with the same verbs, every read and verb
proving the routine's repo against the ceiling independently of
authorizeMutation (finding 7); the board grows **track rows** under the
lanes — per routine: status, schedule, week's spend, and a run-history
strip of dots (green built · red failed · pulsing building · hollow
skipped), while instances stay OUT of the main lanes except attention,
where they surface wearing the routine's name.

A post-build Codex review of the implementation (0 critical, 2 high, 4
medium, 1 low; migration and XSS declared clean) drove a hardening round,
each with a regression test: the fire AND approval transactions re-derive
the digest from the stored terms rather than trusting the column (H1 — a
store caller smuggling edited terms under the approved digest fires
nothing); a live claim blocks single-flight regardless of the task's
state string (H2 — `task state <id> done` over a running build cannot
conjure a twin); manual firings take their own `manual:` ledger identity
and a stale scheduled pointer heals by advancing (M1 — run-now on the
exact due instant can no longer strand the schedule); the budget window
anchors to `provider_started_at`, the stamp money actually moves on (M2);
console run-now is a password step-up like approval — spend outside the
schedule re-proves the approver secret (M3); `singleFlight: false` is
refused at validation so the ceremony's "one at a time" is always true
(M4); and blocked-track pages are episodes — an open one never nags
twice, a recurrence after recovery pages again (L1). 757 tests.

## Planning mode (2026-08-13, Phase B; the round-2 findings are its spec)

`task plan <id>` (CLI, authenticated) or "plan first" (console) marks the
ask; the pass dispatches a **planner** — schema v7's third run role — into
a disposable workspace on its own branch namespace. Its role precondition
is re-proved inside the claim transaction (never an early return past the
capability/capacity/quota/attention gates; above the attention budget a
planner is refused outright), and the half-open quota probe is now
consumed only WITH the claim it admits — a refusal no longer re-arms the
quota with no probe in flight (findings 2–3, the latter a fix to shipped
M4 behavior). The planner's only endings are a parked question (the
existing decision surface — Telegram taps answer it, causal resume feeds
the answer back) or a NIGHTORDERS-PLAN handoff; both are ingested only
AFTER branch, HEAD, and clean tree are proven (finding 1 — the vandal
test smuggles a file and gets nothing ingested, question included). A
drafted plan lands as a PROPOSED scope plus a plan-document artifact; the
inbox and board flip to "review the plan"; the approve step-up is
unchanged and renders the document above the restated scope; the
builder's brief quotes the approved plan fenced-inert. Planner failures
take separate strikes and shorter backoff, malformed payloads go straight
to a durable `malformed-plan` incident whose hold blocks redispatch, and
exhaustion pages as `plan-attempts-exhausted` — builder strikes are never
spent by planning (finding 6). The whole negotiation is one E2E against
real git: ask → answer → draft → approve → build, with the plan in the
builder's brief and the planner's branch never an ancestor. 723 tests.

## Card accretion (2026-08-13, Codex round 2: 13 findings; Phase A of three)

The card now answers the question you would ask at its stage. Needs-you
cards carry the actual question and how long they have stalled ("waiting
7h"), and the lane sorts oldest-first — truthfully: the snapshot fetches
an oldest-stalls page alongside the newest page inside one transaction,
so an old stall cannot fall off a saturated board (finding 11). Queued
cards show the approved goal — the promise, not "ready". Waiting cards
name what the blocker is doing ("waits on schema-cleanup — building
now"), with the state redacted when the blocker lives outside the
ceiling (finding 12) — the edge's name belongs to the visible task; the
other project's status does not. Building cards say "attempt 2" when
strikes exist. Done cards quote the agent's conclusion. Roll-up
admission now bounds the SQL page itself, not just the render. Phases B
(planning mode) and C (routines/tracks) are specced with the same
review's findings as their spec — see the session plan addendum. 718
tests.

## The board + the long-running reframe (2026-08-13, Codex-reviewed: 12 findings)

The operator's directives: figure out the spatial work board; get rid of
the night-specific thinking — this plane is for long-running work,
whenever it runs; and dependencies are now allowed where they buy UX.

**The board** (`/board`, primary nav): the pipeline as lanes — needs you ·
queued · waiting · building · done recently. One exhaustive precedence-
ordered classifier (`board.ts`) over one transactional snapshot
(`boardScoped`), so a parked task is attention exactly once and an
unscoped task cannot vanish from every lane (findings 1–2); orphaned
`running` rows get a repair card; queued claims only task-local readiness
(finding 6); building cards carry worker · model · elapsed · branch ·
workspace, with honest "preparing workspace" before a run exists
(finding 7). Read-only by construction: every card a link, no forms, no
nonces. **Liveness without SSE** (finding 3 killed the wake-seq-driven
stream): a ~15-line first-party script — per-response nonce'd CSP, never
unsafe-inline (finding 9) — fetches the page's own fragment on a timer
and swaps it in place; `<noscript>` falls back to meta refresh; fragment
polls authenticate but never touch `lastSeen`, so an open board cannot
keep a session alive (finding 4). **The roll-up**: `/board?scope=all`
shows every project the ceiling admits on one board, each card wearing
its project chip, enforced row-by-row with the same `rowVisible`
predicate — a repo outside the server's configuration never renders.

**De-night**: `/morning` → 302 → `/activity`; `overnight()` →
`tally()` and the `--json` envelope key `overnight` → `tally` (a wire
break made exactly while the package is unpublished, finding 10); brief/
reconcile/decide/opener/task prose reframed ("builds unattended", "last
window", "No decisions were parked"); README and DESIGN now position for
long-running work nobody is watching — the captain's night orders stay
as the name's origin, one paragraph, not the frame. Brand, protocol
markers (`NIGHTORDERS-*`), and `unattended.test.ts` deliberately keep their
names. 714 tests.

## Console v3 — workflow tabs (2026-08-13, Codex-reviewed)

Navigation reorganized by workflow stage per a second Codex IA review:
`/` = **inbox** (one card per stall: decisions, scopes awaiting approval as
links to the step-up screen — never forms or nonces in lists, and the
inbox never auto-refreshes; inline retry per stalled task with allow-listed
return; cancelled-blocker repair cards; gaps that actually free work;
saturated cached badge); **work** = active queue; **done** = one row per
completed task with final build, conclusion, cost, PR, observed-only CI
state; ledger → /morning ("last 24 hours", honestly a rolling window);
machinery → /system (live-refreshing); builds/requirements demoted to
footer with deep links kept. The review also caught and fixed a ceiling
bypass in inline incident resolution. 697 tests.

## Console v2 — the workspace (2026-08-12, Codex-reviewed: 11 findings)

The user asked for a standalone multi-pane interface with project
onboarding. The review's spine: selection is never authorization. Shipped:
three-pane shell (sidebar with project switcher, waiting-on-you count, +
new task; master list panes on task/run detail; collapses to the phone
column so answering never regresses); /projects opener offering only what
the server ceiling admits (--repo list + --project-root, canonicalized,
narrowing on resolve failure, git-validated with direct argv); session-
carried open project as a view filter with a stale-tab revision; the
ceiling enforced on tasks, runs, decisions, answers, and BOTH evidence
paths (decision evidence was previously unscoped — pre-existing hole
closed); bearer X-Nightorders-Project constrained identically; placement
immutable once scoped (an approval cannot be re-aimed); atomic slugged
task creation landing on the approve card; schema v6 project registry.
Negative matrix: cross-project bypasses, stale revisions, canonical
aliases (/var vs /private/var caught live), v5→v6 migration. 695 tests.

## Toward the operations console (2026-08-12, Codex-reviewed: 21 findings)

The user asked for a web UI over all the work. The review's verdict:
authority and transactions before templates. Landed so far:

| Item | State | Proof |
|---|---|---|
| Session lifecycle | **done** | idle (12h) and absolute (7d) expiry re-proved per request; approver-generation check — credential rotation kills cookies the way it kills Telegram bindings; `POST /logout` |
| Transactional console mutations | **done** | `cancelTask` refuses under a live claim (a runner's completion can no longer overwrite a cancellation); `requeueTask` re-proves stalled-and-unclaimed server-side (a stale button erases nothing); `createConsoleTask` — atomic create+place+scope, backlog admission cap, caps and control rules on every string it will later render; `resolveIncident` owns its transaction |
| Bounded read model | **done** | `listRunsBefore` — cursor pagination, newest first, safe-integer or nothing, page size clamped in the store; `decisionsForTask`/`incidentsForTask` (resolved included: history, not attention); `computeGaps` extracted to `gaps.ts` so CLI and console rank gaps with the same function |
| Descriptor-safe evidence reads | **done** | `readVerifiedArtifact` in evidence.ts — key shape validated, realpath containment, `O_NOFOLLOW` open, fstat on the same descriptor, size == record, bounded read, SHA-256 verified before a byte leaves; serve's decision-evidence route now goes through it; `artifactForRun` enforces membership in the lookup, not route choreography |
| Routes, pages, step-up approval | **done** | the **built-in-queue console** (named honestly — external-backend tasks join when external dispatch does): home = the brief live (overnight counts, measured spend via shared `summary.ts`, DECIDE/INCIDENTS/STRANDED/gaps), `/tasks` + add, `/t/<id>` with hold/unhold (operator-owned only), requeue, cancel, guarded scope edit (`sawDigest`, refused under a live claim, voids approval visibly), `/runs` cursor-paginated, `/r/<id>` with economics + conclusion + repo-scoped evidence, `/caps` read-only. One `authorizeMutation` gate (content type, Origin, CSRF, duplicated-field refusal). **Approval is step-up**: token re-entry + single-use nonce bound to {approver, task, digest}, form restates all three digest-bound fields; `approve()` authenticates inside its transaction. GET never mutates — overdue derived at render. Ids URL-encoded in every href, decoded once. Table-driven inert-render sweep over every DB-derived string |
| Out of scope for v1, stated | — | probe execution, grant/cap editing, task-title edits, dependency editing, runner/claim/worktree/quota admin, outbox history, publication/CI views (M4b), immediate in-flight kill on cancel (cooperative only), live updates/charts/spatial board |

## Toward M4 — the Telegram bridge (shipped early, 2026-08-11)

The operator asked for the back-and-forth channel before M4: decisions to a
phone, answers back, the loop resuming — with no LLM anywhere in the path.
Plan Codex-reviewed (16 findings, 10 HIGH); the findings ARE the design.

| Item | State | Proof |
|---|---|---|
| Bot token: CLI + web settable, never a column | **done** | env `NIGHTORDERS_TELEGRAM_TOKEN` wins; else a 0600 file beside the database, written by `bridge telegram token` or serve's authenticated settings card; never echoed whole; scrubbed from every error and receipt; **stripped from every agent invocation** (`omitEnv`), repair turns included |
| Pairing: a chat is not a person | **done** | 128-bit one-time codes, hashed; consumed in one transaction with the binding; private chats only; both chat id AND immutable user id required on every tap; one live binding per bot (partial unique index); wrong codes get silence, not an oracle |
| Revocation | **done** | bindings are revoked, never deleted; approver credential rotation strands the binding, its codes, and its buttons in the same transaction; `unpair` kills outstanding actions |
| Outbound: whole context, then buttons | **done** | recap, question, every option's consequence sent plain-text (no parse_mode, no entities, previews off) across as many parts as needed; the keyboard rides the last part only; buttons carry opaque 128-bit tokens whose meaning lives in `telegram_action`, unreadable and unmintable by a stolen bot token |
| Shared delivery claiming | **done** | the bridge and `outbox deliver --cmd` claim rows before sending — one page per fact, whoever gets there first; receipts name bot, chat, and message |
| Inbound: per-update transactions | **done** | `telegram_update` PRIMARY KEY is the idempotency; effects (acks, edits) retry-or-drop outside and never hold the cursor hostage; the poll lease (owner + generation + monotonic cursor) makes overlapping pollers lose loudly (`bridge-busy`), and passes hand it back on exit |
| Irreversible two-step | **done** | one tap arms — minting fresh one-time confirm/cancel tokens — and only the minted confirm answers; cancel kills its sibling challenge and re-arms the choices; a forged or replayed confirm is a stale button |
| Migration | **done** | `answered_via` CHECK widened by the second table rebuild, exact-DDL recognition (an unknown shape refuses rather than guesses), proved against an M3-shaped fixture with answered rows, relations, and the next autoincrement id |
| `--follow` (long-poll daemon mode) | **deferred to M4** | a persistent service is loop work — leases, backoff, shutdown, observability — and Codex's verdict was to ship the cron pass first; the pass is the shape until the loop earns the daemon |
| Free-text notes over Telegram | **deferred** | needs its own injection review; the answered message names `decide --note` and the serve link |
| Multi-chat routing / escalation | **deferred to M4** | one bound chat in v1, enforced by the schema, not by hope |

## Deliberately deferred (and to where)

| Gap | Why it waits | Lands with |
|---|---|---|
| Failed blockers freeze their dependents forever | needs the failure taxonomy to say *which* failures propagate | M4 (gnhf taxonomy) |
| No-op agent run counts as success | M1 treats "changed nothing" as a real answer; the taxonomy will call it a failure mode | M4 |
| Exit-code edges: some worktree/git breakage maps to 3, not 1 | reshaping `build`'s exit contract mid-M1 breaks callers for polish | M2, with the notification outbox |
| Capability probes before dispatch | M2 scope | M2 |
| `tick` loops / daemonizes | a pass is the M1 shape; the loop and its economics are the product | M4 |

## History

- **2026-08-11 (M3)** — M3 completes: the decision schema and its
  rebuild migration (`0049c1c`), the park with machine-captured evidence
  (`3da88e4`), bounded repair as parented repair runs (`03b3393`),
  authenticated `decide` + incidents (`0cc0549`), the causal resume and
  the attention budget (`4102cd0`), and `serve` — the milestone sentence
  as a test (`04a60ef`). Plan Codex-reviewed before implementation; its
  16 findings drove the fenced park transaction, owned holds, run-only
  decision identity, the mailbox discipline, and web auth. Driver role
  recorded honestly as deferred to M4. Suite 575.

- **2026-08-11 (M2)** — M2 completes in one sitting: capabilities +
  probes (`65f0381`), the gate in the claim transaction and the builder
  with the acceptance sentence executable (`b699b56`), gaps (`f0ff397`),
  cap scan (`a055a2d`), the outbox (`d0f07a3`), the briefing and the
  build exit-code cleanup. Plan Codex-reviewed before implementation;
  its identity/authority findings drove the schema. Suite 503.

- **2026-08-11 (later)** — M1 completes. Release provenance + atomic
  dead-runner recovery (`5cb9357`); the pulse, post-agent rechecks, run
  records, and tick honoring completion fences (`5aab47d`); fail-closed
  default-branch naming (`d97a468`); `reconcile` with fail-closed orphan
  adoption. Both plans Codex-reviewed before implementation. Suite 468.
- **2026-08-11** — M1 unattended pass ships: `tick`, `acquireIfReady`,
  `completeFenced`, exact-lease fencing in the builder (`d088ef8`). Plan
  reviewed by Codex before implementation; its findings drove the
  atomicity and fencing work. E2E: 7 tests, real git. Suite 448.
- **2026-08-10 → 11** — M0 lands end to end: discovery, graph detection,
  grants, store, claim/fence, adapters, runners, worktrees, builder, CLI
  (`c54e59d` … `bb2c4f6`).
