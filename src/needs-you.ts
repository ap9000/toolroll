/** Every reason a task, result or flow card can wait on a person, in one
 * place: the plain sentence it shows and the one action that resolves it
 * (task-status.ts reads it for every surface). A reason no person can act
 * on is not Needs you: it is a Waiting reason, worded as what it waits for.
 *
 * The words never name the machine's internals; `plainSentence` keeps a
 * recorded reason only when it is free of them. */

/** What a person is asked for. */
export type NeedKey =
  | "approval" | "card" | "answer" | "questions" | "sign-in" | "confirm-stopped" | "check-stopped" | "hold"
  | "choose-project" | "define-task" | "fix-request" | "choose-agent" | "fix-dependency" | "add-requirement"
  | "connect-builder" | "start-builder" | "vanished" | "review-result" | "rebuild" | "earlier-version" | "other";
/** What the work waits for when no person can act. */
export type WaitKey = "build-stopping" | "build-finishing" | "other-computer" | "card-reply" | "card-time" | "card-ci";

/** The action's code: the WorkAction that owns the act, or one of the acts a surface renders itself. */
export type NeedActionCode =
  | "approve-scope" | "approve-card" | "answer-decision" | "inspect-decisions" | "sign-in" | "confirm-stopped" | "inspect-hold"
  | "place-task" | "write-scope" | "select-agent" | "repair-dependency" | "repair-capability" | "start-worker" | "reconcile-run"
  | "open-result" | "retry-task" | "inspect-task";
export type NeedAction = { code: NeedActionCode; label: string };
/** `build`: the run a sentence names; `provider`: the agent that signed out. */
export type NeedContext = { build?: number | null; provider?: string | null };

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
  "confirm-stopped": { sentence: context => `Toolroll can't confirm ${build(context)} stopped. Nothing from it is running.`, action: { code: "confirm-stopped", label: "Confirm it stopped" } },
  // Toolroll can't look at all: never "nothing is running"; the person checks, says so, then confirms.
  "check-stopped": { sentence: context => `Toolroll can't check whether ${build(context)} stopped. Make sure nothing from it is running, then confirm.`, action: { code: "confirm-stopped", label: "Confirm it stopped" } },
  hold: { sentence: () => "A hold is keeping this task from starting. Review it to release it.", action: { code: "inspect-hold", label: "Review hold" } },
  "choose-project": { sentence: () => "Choose a project so a builder can start.", action: { code: "place-task", label: "Choose a project" } },
  "define-task": { sentence: () => "Say what the task should do so it can be planned.", action: { code: "write-scope", label: "Define the task" } },
  "fix-request": { sentence: () => "The request can't be planned as written. Edit it so the planner can start.", action: { code: "write-scope", label: "Edit the request" } },
  "choose-agent": { sentence: () => "Choose an agent to build this.", action: { code: "select-agent", label: "Choose an agent" } },
  "fix-dependency": { sentence: () => "A task this one waits on didn't finish. Fix or remove it so this one can start.", action: { code: "repair-dependency", label: "Fix the required task" },
    useReason: reason => /didn't finish|did not finish|before it finished/i.test(reason), withReason: reason => `${reason.replace(/[.\s]*$/, ".")} Fix or remove it so this one can start.` },
  "add-requirement": { sentence: () => "This project is missing something the task needs. Add it so a builder can start.", action: { code: "repair-capability", label: "Add the requirement" } },
  "connect-builder": { sentence: () => "No builder works on this project yet. Connect one so the task can start.", action: { code: "start-worker", label: "Connect a builder" } },
  "start-builder": { sentence: () => "The builder for this project is offline. Start it and the task begins on its own.", action: { code: "start-worker", label: "Start the builder" } },
  vanished: { sentence: context => `${Build(context)} stopped without finishing. Check it, then retry.`, action: { code: "reconcile-run", label: "Check the build" } },
  "review-result": { sentence: () => "Check the result, then accept it or ask for changes.", action: { code: "open-result", label: "Open result" } },
  // Accepting it would not help: it was built to terms that are no longer the plan.
  rebuild: { sentence: context => `${Build(context)} was made to an earlier plan. Build it again to the current plan.`, action: { code: "retry-task", label: "Build again" } },
  "earlier-version": { sentence: () => "An earlier version of this task still needs you. Finish it first.", action: { code: "inspect-task", label: "Open earlier version" } },
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
export type AskChip = "Plan" | "Result" | "Mismatch" | "Plan changed" | "Failed" | "Builder offline";
/** `mismatch`: the saved report doesn't match its changes; `planChanged`: the plan changed after it was built. */
export function askChipOf(read: { headline: string; need?: NeedKey | null; mismatch?: boolean; planChanged?: boolean; ask?: Ask | null }): AskChip | null {
  if (read.headline === "Failed") return "Failed";
  if (read.planChanged === true || read.need === "rebuild") return "Plan changed";
  if (read.mismatch === true) return "Mismatch";
  if (read.headline === "Ready for review" || read.need === "review-result" || read.ask === "review") return "Result";
  if (read.need === "approval") return "Plan";
  if (read.need === "start-builder" || read.need === "connect-builder") return "Builder offline";
  return null;
}

/** Why a saved result can't simply be accepted yet, in its own words (each Review row says its own reason,
 * never a boilerplate line). The facts are the ones the Tasks list and the task page both read. */
export type ResultHoldUp = { hold: string | null; planChanged: boolean; unapproved: boolean; running: boolean; unfinished: boolean;
  noCommit: boolean; question: boolean; report: boolean };
export function resultHoldUpSentence(facts: Partial<ResultHoldUp>): string {
  if (facts.hold != null && facts.hold.trim() !== "" && !hasInternalWords(facts.hold)) return `On hold: ${facts.hold.trim().replace(/[.\s]*$/, "")}. Release the hold to accept it.`;
  if (facts.hold != null) return "A hold is on this result. Release it to accept the result.";
  if (facts.planChanged) return "The plan changed after this was built. Build it again to the current plan.";
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
  "review-result": "review", rebuild: "review",
  "sign-in": "unblock", "confirm-stopped": "unblock", "check-stopped": "unblock", hold: "unblock", "fix-dependency": "unblock",
  "add-requirement": "unblock", "connect-builder": "unblock", "start-builder": "unblock", vanished: "unblock", "earlier-version": "unblock", other: "unblock",
};

export const WAITS: Readonly<Record<WaitKey, (context: NeedContext) => string>> = {
  "build-finishing": () => "Finishing up; this clears on its own.",
  "build-stopping": context => `Waiting for ${build(context)} to stop. Nothing is needed from you.`,
  "other-computer": context => `Waiting for the computer that ran ${build(context)} to confirm it stopped.`,
  "card-reply": () => "Waiting for a reply.",
  "card-time": () => "Waiting before moving on.",
  "card-ci": () => "Waiting for the pull request's checks.",
};

/** Words that name the machine's internals; no Needs you or Waiting sentence carries them. */
export const BANNED_WORDS = ["witness", "unproven", "quiescence", "quiescent", "digest", "scope digest"] as const;
const BANNED = new RegExp(`\\b(?:${BANNED_WORDS.join("|")})\\b`, "i");
export const hasInternalWords = (text: string): boolean => BANNED.test(text);

/** The sentence for a need: its recorded reason when the need keeps one and
 * it reads plainly, otherwise the need's own words. */
export function needSentence(key: NeedKey, reason: string | null, context: NeedContext = {}): string {
  const need = NEEDS[key];
  const plain = reason?.trim() || null;
  if (need.useReason === undefined || plain === null || !need.useReason(plain) || hasInternalWords(plain)) return need.sentence(context);
  return need.withReason === undefined ? plain : need.withReason(plain);
}

export function waitSentence(key: WaitKey | undefined, reason: string | null, context: NeedContext = {}): string {
  if (key !== undefined) return WAITS[key](context);
  const plain = reason?.trim() || null;
  return plain !== null && !hasInternalWords(plain) ? plain : "Waiting for the work to continue on its own.";
}

/** A finished run Toolroll can't prove stopped (store.stopQuiescenceFact):
 * a person can confirm it only when nothing of it may still be running.
 * `unknown`: Toolroll can't check, so the person confirms they checked. */
export function processNeedOf(fact: { run: number; kind: "open" | "alive" | "elsewhere" | "unprovable" | "unknown" | "settling" } | null):
  { need: "confirm-stopped" | "check-stopped"; build: number } | { wait: WaitKey; build: number } | null {
  if (fact === null) return null;
  if (fact.kind === "settling") return { wait: "build-finishing", build: fact.run };
  if (fact.kind === "unprovable") return { need: "confirm-stopped", build: fact.run };
  if (fact.kind === "unknown") return { need: "check-stopped", build: fact.run };
  return { wait: fact.kind === "elsewhere" ? "other-computer" : "build-stopping", build: fact.run };
}

/** Dispatch and work-index codes that wait on a person, as their need. */
export const CODE_NEED: Readonly<Record<string, NeedKey>> = {
  "signed-out": "sign-in", "needs-approval": "approval", "waiting-decision": "answer", "decision-queue": "answer",
  "needs-project": "choose-project", "needs-scope": "define-task", "planner-source": "fix-request", "needs-agent-profile": "choose-agent",
  "terminal-dependency": "fix-dependency", "missing-requirement": "add-requirement", "no-worker-registered": "connect-builder",
  "no-worker-online": "start-builder", "vanished-run": "vanished", "needs-verification": "review-result", "proof-refuted": "review-result",
  "no-build-record": "review-result", "verification-needed": "review-result", "evidence-mismatch": "review-result",
  "record-incomplete": "review-result", "evidence-damaged": "review-result",
};

/** A stopped run's recorded reason code, in words (the run record, the thread, a failed task's status). */
export const RUN_REASON_WORDS: Readonly<Record<string, string>> = {
  agent: "the agent failed",
  "agent-reported": "the agent reported it could not finish",
  "no-op": "nothing changed when something should have",
  "no-handoff": "the agent stopped before handing off; its work was kept and it is being resumed",
  "moved-head": "the branch moved underneath the build",
  "moved-branch": "the branch moved underneath the build",
  timeout: "ran out of time",
  git: "a git step failed",
  "malformed-decision": "the agent's question was malformed",
  "malformed-plan": "the plan was malformed",
  fenced: "another worker took the task over",
  unapproved: "the scope was not approved",
  "scope-changed": "the scope changed after approval",
  capability: "a requirement was missing",
  setup: "the workspace preparation step failed",
  "provider-init": "the agent could not start",
  "commit-failure": "the commit failed",
  "protected-branch": "refused to touch a protected branch",
  "wrong-branch": "the checkout was on the wrong branch",
  "not-leased": "the lease was not valid",
  "no-claim": "the lease was not valid",
  "not-yours": "the lease was not valid",
  "no-run-record": "the run record was missing",
  "missing-mailbox": "the resume mailbox could not be read",
  "unreadable-mailbox": "the resume mailbox could not be read",
  "revision-brief": "the revision brief could not be read",
  "repaired-park": "resumed from a parked question",
  stopped: "stopped by the operator",
  acceptance: "the result didn't meet its signed requirements",
  evidence: "its evidence could not be saved",
  interrupted: "the attempt was interrupted",
  orphaned: "the attempt lost its worker",
  "retryable-infra": "a temporary problem on the machine stopped it",
  unknown: "the attempt stopped unexpectedly",
  "spawn-failed": "the agent process could not start",
  "provider-protocol": "the agent's reply could not be read",
  "auth-expired": "the agent's sign-in expired",
  "budget-unenforceable": "its spending limit could not be enforced",
  "stale-source": "the request changed while the plan was being made",
  "stale-approval": "the approval no longer matched the scope",
  "source-invalid": "the plan's source could not be recorded",
  "external-closed": "the linked issue was closed while it was being built",
  "repair-admission": "the repair could not start",
  "reviewer-error": "the review failed",
  "malformed-report": "the scout's report was malformed",
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
  acceptance: "Before handing off, check each signed requirement against the changes.",
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
