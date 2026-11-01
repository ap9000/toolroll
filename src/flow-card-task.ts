/** The task behind an agent zone, read through the same status as its task page.
 * Only saved milestone progress belongs on the card; tool calls and logs do not. */
import { assignmentOf } from "./assignment.js";
import { scanForSecrets } from "./evidence.js";
import { scrubIntegrationText } from "./integrations.js";
import type { Store } from "./store.js";
import { assignmentStatusFacts, taskStatusOf, type TaskStatus } from "./task-status.js";
import { taskWorkSummaryOf } from "./work-summary.js";
import { buildProgressOf } from "./workspace-ui.js";

/** Redact before shortening: a cut-off credential must never slip through a scanner.
 * Structured arguments, commands and credential assignments aren't card copy. */
function cardReason(text: string | null, fallback: string, secrets: readonly string[]): string {
  if (text === null) return fallback;
  const raw = /[{}\[\]`]|\b[\w.-]+\s*=|(?:^|\s)--[\w-]+|\b(?:arguments|tool_input|command|cmd|password|passwd|token|secret|api[_ -]?key|authorization)\s*:|\bcurl\s/i.test(text);
  if (raw || secrets.some(secret => secret !== "" && text.includes(secret)) || scanForSecrets(text).length > 0) return fallback;
  const clean = scrubIntegrationText(text, secrets).replace(/[\p{Cf}]/gu, "").replace(/[.\s]+$/, "");
  if (clean === "" || clean.includes("[hidden]")) return fallback;
  return clean.length > 100 ? `${clean.slice(0, 99).trimEnd()}…` : clean;
}

/** A task's status as its page reads it, from the store alone (no evidence files); null when it can't be read. */
/** `root`: where results' saved evidence is. Without it the receipt is read without its saved checks, so a completion
 * (bound to the receipt read with them) doesn't read as one: a status that must say Complete passes it. */
export function storedTaskStatus(store: Store, taskId: string, repo: string, now: Date, root?: string): { status: TaskStatus; activeTaskId: string; live: ReturnType<Store["getRun"]> } | null {
  const access = { principal: "operator" as const, repos: [repo], dependencyRepos: [repo] };
  const assignment = assignmentOf(store, taskId, now, access, root);
  if (assignment === null) return null;
  const work = taskWorkSummaryOf(store, assignment.activeTaskId, now, access);
  if (work === null) return null;
  const live = work.liveRunId === null ? null : store.getRun(work.liveRunId);
  const facts = assignmentStatusFacts(assignment, { work: work.status, planning: live?.role === "planner" });
  // The canvas reads no evidence files. Keep the machine's recorded check visible
  // when the full receipt has no artifact root from which to read its check.
  const check = assignment.receipt === null ? null : store.runCheckFor(assignment.receipt.runId);
  // With neither, nothing about the check was read here: the line says nothing about it, never a pass and never an ask.
  if (facts.checks?.status === "unavailable") facts.checks = check === null ? null : { ...facts.checks, status: check.status, exitCode: check.exitCode };
  return { status: taskStatusOf(facts), activeTaskId: assignment.activeTaskId, live };
}

export function flowCardTaskLine(store: Store, taskId: string, repo: string, now: Date, secrets: readonly string[] = []): string {
  const read = storedTaskStatus(store, taskId, repo, now);
  if (read === null) return "Task unavailable";
  const { status, live } = read;
  if (status.headline === "Needs you") {
    const fallback = status.need?.action.label ?? "Open the task";
    // The question itself is useful; routine approvals are clearer as the short action.
    const what = status.need?.key === "answer" || status.need?.key === "other"
      ? cardReason(status.sentence, fallback, secrets) : fallback;
    return `Waiting on you: ${what}`;
  }
  if (status.headline === "Building" && live !== null) {
    const ref = store.lookupRef(read.activeTaskId);
    const checkpoint = store.latestCheckpointForRun(live.id);
    const progress = buildProgressOf(checkpoint?.taskRef !== ref?.id ? null : checkpoint?.snapshot.milestones.map(one => ({ description: null, state: one.state, note: one.note })));
    if (progress?.stuck != null) return `Stuck: ${cardReason(progress.stuck.why, `step ${progress.step} of ${progress.total}`, secrets)}`;
    if (progress !== null) return `Building · step ${progress.step} of ${progress.total}`;
  }
  if (status.headline === "Failed") return `Stuck: ${cardReason(status.sentence, "Open the task", secrets)}`;
  return status.headline === "Ready for review" ? "Ready" : status.headline;
}
