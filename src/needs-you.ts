/** Every reason a task, result or flow card can wait on a person, in one
 * place: the plain sentence it shows and the one action that resolves it
 * (task-status.ts reads it for every surface). A reason no person can act
 * on is not Needs you: it is a Waiting reason, worded as what it waits for.
 *
 * The words never name the machine's internals; `plainSentence` keeps a
 * recorded reason only when it is free of them. */

/** What a person is asked for. */
export type NeedKey =
  | "approval" | "card" | "answer" | "questions" | "sign-in" | "stop-unproven" | "hold"
  | "choose-project" | "define-task" | "fix-request" | "choose-agent" | "fix-dependency" | "add-requirement"
  | "connect-builder" | "start-builder" | "vanished" | "review-result" | "rebuild" | "replan" | "earlier-version" | "history" | "other";
/** What the work waits for when no person can act. */
export type WaitKey = "build-stopping" | "build-finishing" | "build-checking" | "other-computer" | "card-reply" | "card-time" | "card-ci"
  | "plan-next" | "research-next" | "builders-busy" | "retry-later" | "app-update" | "other-task";

/** The action's code: the WorkAction that owns the act, or one of the acts a surface renders itself. */
export type NeedActionCode =
  | "approve-scope" | "approve-card" | "answer-decision" | "inspect-decisions" | "sign-in" | "recheck-stopped" | "inspect-hold"
  | "place-task" | "write-scope" | "select-agent" | "repair-dependency" | "repair-capability" | "start-worker" | "reconcile-run"
  | "open-result" | "retry-task" | "inspect-task";
export type NeedAction = { code: NeedActionCode; label: string };
/** Where "Connect a builder" and "Start the builder" lead (code `start-worker`): the Start a builder page, which shows
 * the one command to run and the open project's builder state. Every signed-in person can open it, a project-limited
 * one included (System is instance-only). Never the task's own page, which only repeats that nothing is connected. */
export const START_BUILDER_HREF = "/start-builder";
/** Start a builder for one task: the page reports that task's own project, whatever project is open. */
export const startBuilderHref = (taskId: string | null): string =>
  taskId === null ? START_BUILDER_HREF : `${START_BUILDER_HREF}?task=${encodeURIComponent(taskId)}`;
/** What starts a builder: run on the machine where the project lives, in the project's folder. */
export const START_BUILDER_COMMAND = "toolroll up";
/** `build`: the run a sentence names; `provider`: the agent that signed out; `task`: another task it names (an
 * earlier version); `retry`: when Toolroll tries again, in words ("in 4 minutes"). */
export type NeedContext = { build?: number | null; provider?: string | null; task?: string | null; retry?: string | null };

/** `useReason`: which recorded reasons say what is needed better than the default words. */
type Need = { sentence: (context: NeedContext) => string; action: NeedAction; useReason?: (reason: string) => boolean;
  /** How a kept reason reads: by default the reason alone. */
  withReason?: (reason: string) => string };
const always = (): boolean => true;

const build = (context: NeedContext): string => context.build == null ? "the last build" : `build #${context.build}`;
const Build = (context: NeedContext): string => context.build == null ? "The last build" : `Build #${context.build}`;

export const NEEDS: Readonly<Record<NeedKey, Need>> = {
  approval: { sentence: () => "Review the plan and approve it to start.", action: { code: "approve-scope", label: "Approve plan" } },
  card: { sentence: () => "This card is waiting for your approval.", action: { code: "approve-card", label: "Approve card" } },
  answer: { sentence: () => "Answer the question so the work can continue.", action: { code: "answer-decision", label: "Answer the question" }, useReason: always },
  questions: { sentence: () => "Too many questions are open. Answer one so this task can start.", action: { code: "inspect-decisions", label: "Answer questions" } },
  "sign-in": { sentence: context => `${context.provider ?? "Your agent"} needs you to sign in again. The task starts on its own after.`, action: { code: "sign-in", label: "Sign in again" }, useReason: reason => /sign in|API key/i.test(reason) },
  // Toolroll proves a build stopped itself (stop-proof.ts); nobody is asked to vouch for it. Only when this computer
  // can't look, or something Toolroll didn't start is using the build's folder, is the work held: the person can close
  // what's theirs and have it look again, nothing more.
  "stop-unproven": { sentence: context => `Toolroll can't prove ${build(context)} stopped from this computer, so the work is held. Close anything of yours that is using its folder, then check again.`, action: { code: "recheck-stopped", label: "Check again" } },
  hold: { sentence: () => "A hold is keeping this task from starting. Review it to release it.", action: { code: "inspect-hold", label: "Review hold" } },
  "choose-project": { sentence: () => "Choose a project so a builder can start.", action: { code: "place-task", label: "Choose a project" } },
  "define-task": { sentence: () => "Say what the task should do so it can be planned.", action: { code: "write-scope", label: "Define the task" } },
  "fix-request": { sentence: () => "The request can't be planned as written. Edit it so the planner can start.", action: { code: "write-scope", label: "Edit the request" },
    // Its own size and limit say exactly what to shorten.
    useReason: reason => /the planner can carry at most/.test(reason) },
  "choose-agent": { sentence: () => "Choose an agent to build this.", action: { code: "select-agent", label: "Choose an agent" } },
  "fix-dependency": { sentence: () => "A task this one waits on didn't finish. Fix or remove it so this one can start.", action: { code: "repair-dependency", label: "Fix the required task" },
    useReason: reason => /didn't finish|did not finish|before it finished/i.test(reason), withReason: reason => {
      // A reason that already says what to do is said once.
      const said = reason.replace(/[.\s]*$/, ".");
      return /Fix or remove it so this one can start\.$/.test(said) ? said : `${said} Fix or remove it so this one can start.`;
    } },
  "add-requirement": { sentence: () => "This project is missing something the task needs. Add it so a builder can start.", action: { code: "repair-capability", label: "Add the requirement" } },
  "connect-builder": { sentence: () => "No builder works on this project yet. Connect one so the task can start.", action: { code: "start-worker", label: "Connect a builder" } },
  "start-builder": { sentence: () => "The builder is offline. Start the builder.", action: { code: "start-worker", label: "Start the builder" } },
  // The same act as before (it opens the build, where Retry is): only the words are plainer.
  vanished: { sentence: context => `${Build(context)} stopped unexpectedly. Retry it.`, action: { code: "reconcile-run", label: "Open the build" } },
  "review-result": { sentence: () => "Check the result, then accept it or send it back.", action: { code: "open-result", label: "Open result" } },
  // Accepting it would not help: it was built to terms that are no longer the plan.
  rebuild: { sentence: context => `${Build(context)} was made to an earlier plan. Retry it on the current plan.`, action: { code: "retry-task", label: "Retry" } },
  // The plan was rewritten after the build and not yet approved: the yes comes first, then Build again.
  replan: { sentence: context => `The plan changed after ${build(context)}. Approve the new plan, then retry it.`, action: { code: "approve-scope", label: "Approve plan" } },
  "earlier-version": { sentence: context => context.task == null ? "An earlier version of this task still needs you. Finish it first." : `An earlier version, ${context.task}, still needs you. Finish it first.`,
    action: { code: "inspect-task", label: "Open earlier version" } },
  // An actionable need, never a quiet Waiting: a person opens it to retry or archive it.
  history: { sentence: () => "Toolroll can't read this task's history. Open it to retry or archive it.", action: { code: "inspect-task", label: "Open the task" } },
  other: { sentence: () => "Open the task to see what it needs from you.", action: { code: "inspect-task", label: "Open the task" }, useReason: always },
};

/** What a waiting task asks of a person, in three kinds the Tasks list groups
 * by: a choice to make, a result to accept or send back, or something in the
 * way to clear. Decide comes first. */
export type Ask = "decide" | "review" | "unblock";
export const ASKS: readonly Ask[] = ["decide", "review", "unblock"];
export const ASK_LABEL: Readonly<Record<Ask, string>> = { decide: "Decide", review: "Review", unblock: "Unblock" };
/** A waiting row's chip: the specific thing asked, never its group's own word (no "Decide" chip under Decide).
 * Null: the group heading and the row's sentence already say it, so the row wears no chip. */
export type AskChip = "Plan" | "Result" | "Mismatch" | "Plan changed" | "Failed" | "Builder offline" | "Question" | "On hold" | "Stopped" | "Sign in";
/** `mismatch`: the saved report doesn't match its changes; `planChanged`: the plan changed after it was built. */
export function askChipOf(read: { headline: string; need?: NeedKey | null; mismatch?: boolean; planChanged?: boolean; ask?: Ask | null }): AskChip | null {
  if (read.headline === "Failed") return "Failed";
  if (read.planChanged === true || read.need === "rebuild" || read.need === "replan") return "Plan changed";
  if (read.mismatch === true) return "Mismatch";
  if (read.headline === "Ready for review" || read.need === "review-result" || read.ask === "review") return "Result";
  if (read.need === "approval") return "Plan";
  if (read.need === "start-builder" || read.need === "connect-builder") return "Builder offline";
  if (read.need === "answer" || read.need === "questions") return "Question";
  if (read.need === "hold") return "On hold";
  if (read.need === "vanished" || read.need === "stop-unproven") return "Stopped";
  if (read.need === "sign-in") return "Sign in";
  return null;
}

/** Why a saved result can't simply be accepted yet, in its own words (each Review row says its own reason,
 * never a boilerplate line). The facts are the ones the Tasks list and the task page both read. */
export type ResultHoldUp = { hold: string | null; planChanged: boolean; unapproved: boolean; running: boolean; unfinished: boolean;
  noCommit: boolean; question: boolean; report: boolean };
export function resultHoldUpSentence(facts: Partial<ResultHoldUp>): string {
  if (facts.hold != null && facts.hold.trim() !== "" && !hasInternalWords(facts.hold)) return `On hold: ${facts.hold.trim().replace(/[.\s]*$/, "")}. Release the hold to accept it.`;
  if (facts.hold != null) return "A hold is on this result. Release it to accept the result.";
  if (facts.planChanged) return facts.unapproved ? "The plan changed after this was built. Approve the new plan, then build it again."
    : "The plan changed after this was built. Build it again to the current plan.";
  if (facts.unapproved) return "The current plan isn't approved. Approve it, then review the result.";
  if (facts.question) return "A question is still open. Answer it, then review the result.";
  if (facts.running) return "A build is still running on this task.";
  if (facts.unfinished) return "An earlier attempt never finished. Check it, then review the result.";
  if (facts.noCommit) return facts.report ? "The report is missing or incomplete. Open it to see what was saved." : "The build saved no commit to review. Open the result to see what was kept.";
  return "Open the result to see what it needs before you can accept it.";
}

export const NEED_ASK: Readonly<Record<NeedKey, Ask>> = {
  approval: "decide", card: "decide", answer: "decide", questions: "decide", "choose-project": "decide", "define-task": "decide",
  "fix-request": "decide", "choose-agent": "decide",
  "review-result": "review", rebuild: "review", replan: "decide",
  "sign-in": "unblock", "stop-unproven": "unblock", hold: "unblock", "fix-dependency": "unblock",
  "add-requirement": "unblock", "connect-builder": "unblock", "start-builder": "unblock", vanished: "unblock", "earlier-version": "unblock", history: "unblock", other: "unblock",
};

export const WAITS: Readonly<Record<WaitKey, (context: NeedContext) => string>> = {
  "build-finishing": () => "Finishing up; this clears on its own.",
  "build-checking": context => `Making sure ${build(context)} stopped. This clears on its own.`,
  "build-stopping": context => `Waiting: Toolroll is stopping ${build(context)}.`,
  "other-computer": context => `Waiting for the computer that ran ${build(context)} to confirm it stopped.`,
  "card-reply": () => "Waiting for a reply.",
  "card-time": () => "Waiting before moving on.",
  "card-ci": () => "Waiting for the pull request's checks.",
  "plan-next": () => "Waiting to plan.",
  "research-next": () => "Waiting to research.",
  "builders-busy": () => "Waiting its turn: builders are busy.",
  "retry-later": context => `Waiting: Toolroll retries ${build(context)} ${context.retry ?? "soon"}.`,
  "app-update": () => "Waiting: Toolroll is updating. New work starts after it.",
  "other-task": context => context.task == null ? "Waiting for another task to finish first." : `Waiting for ${context.task} to finish first.`,
};

/** Words that name the machine's internals (plain-words.ts, the one table); no Needs you or Waiting sentence carries
 * them, and a recorded reason that does is replaced by the need's own words. */
export { BANNED_WORDS, PLAIN_WORDS, bannedWordsIn, hasInternalWords } from "./plain-words.js";
import { hasInternalWords } from "./plain-words.js";

/** The sentence for a need: its recorded reason when the need keeps one and
 * it reads plainly, otherwise the need's own words. */
export function needSentence(key: NeedKey, reason: string | null, context: NeedContext = {}): string {
  const need = NEEDS[key];
  const plain = reason?.trim() || null;
  if (need.useReason === undefined || plain === null || !need.useReason(plain) || hasInternalWords(plain)) return need.sentence(context);
  return need.withReason === undefined ? plain : need.withReason(plain);
}

/** Waits whose words need a fact (when it retries, which task it waits on): without it, a plain recorded reason that
 * already says it is kept. */
const WAITS_WITH_FACTS: Readonly<Partial<Record<WaitKey, (context: NeedContext) => boolean>>> = {
  "retry-later": context => context.retry != null, "other-task": context => context.task != null,
};
export function waitSentence(key: WaitKey | undefined, reason: string | null, context: NeedContext = {}): string {
  const plain = reason?.trim() || null;
  const known = plain !== null && !hasInternalWords(plain) ? plain : null;
  if (key !== undefined) return WAITS_WITH_FACTS[key]?.(context) === false && known !== null ? known : WAITS[key](context);
  return known ?? "Waiting for the work to continue on its own.";
}

/** A finished run Toolroll can't yet prove stopped (store.stopQuiescenceFact). Nobody is asked to confirm it:
 * `unprovable` is Toolroll's own check still to run (stop-proof.ts), which settles by itself; `unknown` is that this
 * computer can't look, or something Toolroll didn't start is in the build's folder — held, with nothing to vouch for. */
export function processNeedOf(fact: { run: number; kind: "open" | "alive" | "elsewhere" | "unprovable" | "unknown" | "settling" } | null):
  { need: "stop-unproven"; build: number } | { wait: WaitKey; build: number } | null {
  if (fact === null) return null;
  if (fact.kind === "settling") return { wait: "build-finishing", build: fact.run };
  if (fact.kind === "unprovable") return { wait: "build-checking", build: fact.run };
  if (fact.kind === "unknown") return { need: "stop-unproven", build: fact.run };
  return { wait: fact.kind === "elsewhere" ? "other-computer" : "build-stopping", build: fact.run };
}

/** The stages a code reads as (task-status.ts TaskStage). */
export type CodeStage = "queued" | "planning" | "needs-you" | "waiting" | "building" | "checking" | "reviewing" | "finished" | "complete" | "failed" | "stopped";
/** Every dispatch and work-index code, as what it means for a person (docs/plans/plain-toolroll.md P1.2): a need with
 * the act that resolves it, a wait (worded as what it waits for), or a plain state. A code is exactly one of these.
 * `act` is the work-index row's own act for the code, the same act it had before this table: a need keeps its act, a
 * wait offers none. `stopped` and `failed` keep their own act too (Resume, Retry). */
export type CodeReading = { stage: CodeStage; need?: NeedKey; wait?: WaitKey; act?: NeedActionCode | "inspect-stop" | "resume-run" | "unhold" | "answer-agent" | "inspect-run" | null };
export const CODE_READING: Readonly<Record<string, CodeReading>> = {
  // Plain states: nothing is asked and nothing is waited on by name.
  queued: { stage: "queued" }, ready: { stage: "queued" }, "provider-quota": { stage: "queued" },
  running: { stage: "building" }, reviewing: { stage: "reviewing" }, "review-pending": { stage: "building" }, "checks-running": { stage: "checking" },
  "ready-to-check": { stage: "finished", act: "open-result" }, "ready-to-review": { stage: "finished" }, "report-ready": { stage: "finished" }, "no-change": { stage: "finished" },
  "pr-opened": { stage: "finished" }, "merge-observed": { stage: "finished" }, "pr-closed": { stage: "finished" }, "agent-attested": { stage: "finished" }, "accepted-exception": { stage: "finished" },
  complete: { stage: "complete", act: "open-result" }, cancelled: { stage: "stopped", act: "inspect-task" }, paused: { stage: "stopped" },
  stopped: { stage: "stopped", act: "resume-run" },
  failed: { stage: "failed", act: "retry-task" }, "checks-failed": { stage: "failed" },
  // The same failure again and again: a need over Retry, its own act, said plainly.
  "waiting-incident": { stage: "failed", act: "retry-task" },
  // Waits: Toolroll or another task moves these on; no person is asked.
  stopping: { stage: "waiting", wait: "build-stopping" },
  "build-stopping": { stage: "waiting", wait: "build-stopping" }, "other-computer": { stage: "waiting", wait: "other-computer" },
  "planning-ready": { stage: "waiting", wait: "plan-next" }, "scouting-ready": { stage: "waiting", wait: "research-next" },
  "worker-at-capacity": { stage: "waiting", wait: "builders-busy" }, "retry-scheduled": { stage: "waiting", wait: "retry-later" },
  updating: { stage: "waiting", wait: "app-update" }, "waiting-dependency": { stage: "waiting", wait: "other-task" },
  // Needs, each over the act it has always had.
  "history-problem": { stage: "needs-you", need: "history", act: "inspect-task" },
  "earlier-active": { stage: "needs-you", need: "earlier-version", act: "inspect-task" },
  "waiting-decision": { stage: "needs-you", need: "answer", act: "answer-decision" },
  "decision-queue": { stage: "needs-you", need: "questions", act: "inspect-decisions" },
  // A saved result that can't simply be accepted yet: its own reason (resultHoldUpSentence) is the sentence.
  "result-needs-attention": { stage: "needs-you", need: "other", act: "inspect-run" },
  "process-needs-attention": { stage: "needs-you", need: "stop-unproven", act: "inspect-run" },
  "vanished-run": { stage: "needs-you", need: "vanished", act: "reconcile-run" },
  held: { stage: "needs-you", need: "hold", act: "inspect-hold" },
  "terminal-dependency": { stage: "needs-you", need: "fix-dependency", act: "repair-dependency" },
  "needs-project": { stage: "needs-you", need: "choose-project", act: "place-task" },
  "needs-scope": { stage: "needs-you", need: "define-task", act: "write-scope" },
  "invalid-scope": { stage: "needs-you", need: "define-task", act: "write-scope" },
  "planner-source": { stage: "needs-you", need: "fix-request", act: "write-scope" },
  "needs-agent-profile": { stage: "needs-you", need: "choose-agent", act: "select-agent" },
  "needs-approval": { stage: "needs-you", need: "approval", act: "approve-scope" },
  "missing-requirement": { stage: "needs-you", need: "add-requirement", act: "repair-capability" },
  "no-worker-registered": { stage: "needs-you", need: "connect-builder", act: "start-worker" },
  "no-worker-online": { stage: "needs-you", need: "start-builder", act: "start-worker" },
  "signed-out": { stage: "needs-you", need: "sign-in", act: "sign-in" },
  "needs-verification": { stage: "needs-you", need: "review-result" }, "proof-refuted": { stage: "needs-you", need: "review-result" },
  "no-build-record": { stage: "needs-you", need: "review-result" }, "verification-needed": { stage: "needs-you", need: "review-result" },
  "evidence-mismatch": { stage: "needs-you", need: "review-result" }, "record-incomplete": { stage: "needs-you", need: "review-result" },
  "evidence-damaged": { stage: "needs-you", need: "review-result" },
};
/** A code that waits on Toolroll or another task: no person is asked. */
export const isWaitCode = (code: string): boolean => CODE_READING[code]?.stage === "waiting";

/** Notification kinds that need nothing from a person: they stay in the activity log and never ping a phone. */
export const ACTIVITY_ONLY_KINDS: ReadonlySet<string> = new Set(["check-progress"]);

/** Dispatch and work-index codes that wait on a person, as their need (read from CODE_READING). */
export const CODE_NEED: Readonly<Record<string, NeedKey>> = Object.fromEntries(Object.entries(CODE_READING)
  .flatMap(([code, reading]) => reading.need === undefined ? [] : [[code, reading.need] as const]));

/** A stopped run's recorded reason code, in words (the run record, the thread, a failed task's status). */
export const RUN_REASON_WORDS: Readonly<Record<string, string>> = {
  agent: "the agent failed",
  "agent-reported": "the agent reported it could not finish",
  "no-op": "nothing changed when something should have",
  "usage-exhausted": "the agent ran out of its plan, so its work moved to the next approved agent",
  "no-handoff": "the agent stopped before handing off; its work was kept and it is being resumed",
  "moved-head": "the branch moved underneath the build",
  "moved-branch": "the branch moved underneath the build",
  timeout: "ran out of time",
  git: "a git step failed",
  "malformed-decision": "the agent's question was malformed",
  "malformed-plan": "the plan was malformed",
  fenced: "another builder took the task over",
  unapproved: "the plan was not approved",
  "scope-changed": "the plan changed after approval",
  capability: "a requirement was missing",
  setup: "the workspace preparation step failed",
  "provider-init": "the agent could not start",
  "commit-failure": "the commit failed",
  "protected-branch": "refused to touch a protected branch",
  "wrong-branch": "the checkout was on the wrong branch",
  "not-leased": "the builder lost its hold on the task",
  "no-claim": "the builder lost its hold on the task",
  "not-yours": "the builder lost its hold on the task",
  "no-run-record": "the build's record was missing",
  "missing-mailbox": "the saved notes to resume from could not be read",
  "unreadable-mailbox": "the saved notes to resume from could not be read",
  "revision-brief": "the revision brief could not be read",
  "repaired-park": "resumed from a parked question",
  stopped: "stopped by a person",
  acceptance: "the result didn't meet its approved requirements",
  evidence: "its saved files could not be kept",
  interrupted: "the attempt was interrupted",
  orphaned: "the attempt lost its builder",
  "retryable-infra": "a temporary problem on the machine stopped it",
  unknown: "the attempt stopped unexpectedly",
  "spawn-failed": "the agent process could not start",
  "provider-protocol": "the agent's reply could not be read",
  "auth-expired": "the agent's sign-in expired",
  "budget-unenforceable": "its spending limit could not be enforced",
  "stale-source": "the request changed while the plan was being made",
  "stale-approval": "the approval no longer matched the plan",
  "source-invalid": "the plan's source could not be recorded",
  "external-closed": "the linked issue was closed while it was being built",
  "repair-admission": "the repair could not start",
  "reviewer-error": "the review failed",
  "malformed-report": "the research report was malformed",
  "attempts-exhausted": "it failed too many times in a row",
  "plan-revised": "the plan changed, so a fresh attempt took over",
};

/** A run's recorded reason in words. A recorded code is never shown as it is
 * stored: one with no words of its own reads as an unexpected stop; a reason
 * already written as words (it has a space) is said as written. */
export function runReasonWords(reason: string): string {
  const known = RUN_REASON_WORDS[reason];
  if (known !== undefined) return known;
  if (reason.startsWith("decision:")) return "the agent asked a question";
  return /\s/.test(reason.trim()) ? reason.trim() : "the attempt stopped unexpectedly";
}

/** The latest finished build attempt among a task's runs (any order), whatever its outcome: planning and reviewing
 * are not attempts, and an older failure never stands in for a newer attempt. */
export function latestFinishedAttempt<T extends { id: number; role: string; finishedAt: string | null; outcome?: string | null }>(runs: readonly T[]): T | null {
  let latest: T | null = null;
  // Ended means a finish time or an outcome: a reconcile can mark a run failed without stamping finished_at.
  for (const run of runs) if ((run.finishedAt !== null || (run.outcome ?? null) !== null) && run.role !== "planner" && run.role !== "reviewer" && (latest === null || run.id > latest.id)) latest = run;
  return latest;
}

export const NO_REASON_RECORDED = "No reason was recorded for this attempt.";
export const INTERNAL_ERROR = "The attempt stopped with an internal error.";
/** About as long as one plain line reads. */
export const REASON_LINE_LIMIT = 140;

/** A recorded reason that is machine output, not words: a stack trace, a file path or "Error:" text. Its detail
 * belongs behind a link, never in the line itself. */
export function isInternalErrorReason(reason: string | null | undefined): boolean {
  const text = reason?.trim() ?? "";
  if (text === "" || RUN_REASON_WORDS[text] !== undefined) return false;
  return /\b[A-Za-z]*(?:Error|Exception):/.test(text) // Error:, TypeError:, SomeException:
    || /^\s*at\s+\S+/m.test(text) && /\n/.test(text) // a stack frame below the first line
    // An absolute path of two or more segments (/Users/…, ~/x/y): plain sentences may name a project file (src/ledger.ts).
    || /(?:^|[\s(“"'])~?\/(?:[\w.@-]+\/)+[\w.@-]+/.test(text)
    || /[A-Za-z]:\\/.test(text) // C:\…
    || /\.[cm]?[jt]sx?:\d+/.test(text); // ledger.ts:14
}

/** A failed attempt in one plain line: its recorded reason in words (first line only, about 140 characters at most),
 * that it stopped with an internal error when the reason is machine output, or that none was recorded. */
export function failedAttemptSentence(reason: string | null | undefined): string {
  const code = reason?.trim() ?? "";
  if (code === "") return NO_REASON_RECORDED;
  if (isInternalErrorReason(code)) return INTERNAL_ERROR;
  const words = runReasonWords(code.split(/\r?\n/, 1)[0]!.trim()).replace(/\s+/g, " ").replace(/[.\s]+$/, "");
  const line = words.length <= REASON_LINE_LIMIT ? words
    : `${words.slice(0, REASON_LINE_LIMIT - 1).replace(/\s+\S*$/, "").replace(/[,;:\s]+$/, "")}…`;
  return `${line.charAt(0).toUpperCase()}${line.slice(1)}${line.endsWith("…") ? "" : "."}`;
}

/** What to change before the next attempt, by a stopped run's recorded reason: one plain suggestion, the note Retry
 * starts with. A reason with no suggestion of its own gets the general one. */
const STOP_SUGGESTIONS: Readonly<Record<string, string>> = {
  acceptance: "Before handing off, check each approved requirement against the changes.",
  timeout: "Split the work into smaller steps, or name the one part to finish first.",
  "no-op": "Say exactly which files or behaviour should change.",
  agent: "Say what to do differently this time, or name the part to try first.",
  "agent-reported": "Answer what the agent said it was missing, or narrow the task.",
  "provider-init": "Check the agent is signed in and installed, then retry.",
  "spawn-failed": "Check the agent is signed in and installed, then retry.",
  "auth-expired": "Sign the agent in again, then retry.",
  "provider-protocol": "Retry as it is; if it stops the same way, try another agent.",
  setup: "Fix the project's setup step, then retry.",
  git: "Make sure the project's branch is clean and reachable, then retry.",
  "commit-failure": "Make sure the project's commit hooks pass, then retry.",
  "moved-head": "Retry: the next attempt starts from where the branch is now.",
  "moved-branch": "Retry: the next attempt starts from where the branch is now.",
  "retryable-infra": "Retry as it is.",
  interrupted: "Retry as it is.",
  orphaned: "Retry as it is.",
  capability: "Add what the project is missing, then retry.",
  "attempts-exhausted": "Say what to do differently this time, or narrow the task.",
};
export const GENERAL_SUGGESTION = "Say what to do differently this time.";

export function stopSuggestionOf(reason: string | null | undefined): string {
  const code = reason?.trim() ?? "";
  return STOP_SUGGESTIONS[code] ?? GENERAL_SUGGESTION;
}

/** A signed requirement in the middle of a sentence: its first letter lowered unless it starts a name or an acronym. */
function inSentence(statement: string): string {
  const plain = statement.trim().replace(/[.\s]+$/, "");
  return /^[A-Z][a-z]/.test(plain) ? `${plain.charAt(0).toLowerCase()}${plain.slice(1)}` : plain;
}

/** The suggestion for a requirement the result missed: make sure of it before handing off. */
export function missedRequirementSuggestion(statement: string): string {
  return `Before handing off, make sure ${inSentence(statement)}.`;
}

/** The suggestion for a check that failed on the result: make it pass, starting with the line it ended on. */
export function failingCheckSuggestion(line: string): string {
  return `Make the check pass. It ended on: ${line.replace(/[.\s]+$/, "")}.`;
}

/** What a failed attempt missed, in plain words: what failed (the missed requirement, the failing check's line or the
 * stop reason), the evidence line behind it, and one suggestion of what to change (Retry's note starts with it). */
export type FailureExplanation = {
  kind: "requirement" | "check" | "reason";
  line: string;
  evidence: string | null;
  suggestion: string;
  link: { label: string; href: string } | null;
};

/** The line for a missed requirement: “Missed: <statement>”, cut to one line. */
export function missedRequirementLine(statement: string): string {
  const plain = statement.trim().replace(/\s+/g, " ").replace(/[.\s]+$/, "");
  const cut = plain.length <= REASON_LINE_LIMIT - 10 ? plain : `${plain.slice(0, REASON_LINE_LIMIT - 11).replace(/\s+\S*$/, "")}…`;
  return `Missed a requirement: ${cut}${cut.endsWith("…") ? "" : "."}`;
}

/** The longest note Retry's field takes. */
export const RETRY_NOTE_LIMIT = 500;

/** Retry's note, prefilled with the suggestion: cut to what the field takes, at a word, so the form always posts. */
export function retryNoteOf(suggestion: string): string {
  const plain = suggestion.trim();
  if (plain.length <= RETRY_NOTE_LIMIT) return plain;
  return `${plain.slice(0, RETRY_NOTE_LIMIT - 1).replace(/\s+\S*$/, "").replace(/[,;:\s]+$/, "")}…`;
}
