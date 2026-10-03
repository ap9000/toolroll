/** Quiet chat: a task's whole life is one chat message edited in place, and a
 * new message arrives only when a person is needed. Every transport (Telegram,
 * Slack, Discord, Teams) asks the same questions here: does this fact need a
 * person, what does the task's card say now, and what does the Ready ping say.
 * Delivery receipts, claims and retries stay with each transport; the
 * console's activity keeps every fact whatever a chat showed. */
import { assignmentOf } from "./assignment.js";
import { chatControlHref, chatResultHref } from "./chat-controls.js";
import { telegramProgressCard, type ProgressEntity } from "./telegram-progress.js";
import { assignmentStatusFacts, headlineEmoji, taskStatusOf, type Headline } from "./task-status.js";
import { asksToFinish, batchLine, chatText, chatTitle, factLinkLabel, mentions, READY_ACTIONS, type FinishedFact } from "./chat-voice.js";
import { phoneText, projectLabel, type PhoneTaskLink } from "./telegram-status.js";
import { isLifecycleNotification, type ChatBatch, type Notification, type Run, type Store } from "./store.js";
import { leadSubjectOf } from "./lead-voice.js";
import { decideFallbackLink, decideTargetOf, type DecideTarget } from "./chat-decide.js";

/** `also`: more buttons after `link`, such as [Look first] beside [Merge]. `target`: the one card a chat may act on in
 * place (chat-decide.ts), when the message is about one result, plan, failure or pull request. */
export type QuietView = { text: string; entities: ProgressEntity[]; link: PhoneTaskLink; also?: PhoneTaskLink[]; target?: DecideTarget };

/** What always makes a new message, even in quiet mode: a question or approval waiting, a failure or other
 * attention fact, a result Ready for review, a security alert or release, and anything addressed to one person
 * (a sign-in or plan-limit pause, an evening digest). */
const NEEDED_KINDS = new Set([
  "acceptance-ready", "acceptance-evidence", "flow-decision", "flow-card", "plan-ready", "report-ready",
  "stale-approval", "security-release", "secret-detected",
]);

export function needsPerson(row: Pick<Notification, "dedupeKey" | "kind" | "pushClass" | "recipient">): boolean {
  if (row.recipient !== null) return true;
  if (/^decision:\d+$/.test(row.dedupeKey)) return true;
  if (row.pushClass !== null && row.pushClass !== "progress") return true;
  if (NEEDED_KINDS.has(row.kind)) return true;
  // A built or unchanged result is Ready: the one lifecycle step that asks for a person.
  return isLifecycleNotification(row) && row.kind === "run-finished";
}

/** A fact about one placed task: in quiet mode it lands on that task's card. */
export function isTaskFact(row: Pick<Notification, "taskRef" | "taskId" | "project">): row is typeof row & { taskRef: number; taskId: string; project: string } {
  return row.taskRef !== null && row.taskId !== null && row.project !== null;
}

/** The attempt a task's card follows: its newest builder attempt, outside any contest. */
function cardRun(store: Store, taskRef: number): Run | null {
  return store.runsFor(taskRef).find(run => run.role === "builder" && run.contestant === null) ?? null;
}

/** Before any attempt starts, the card says where the task stands in the words of its last lifecycle fact. */
const before = (headline: Headline) => ({ icon: headlineEmoji(headline), status: headline });
const BEFORE_RUN: Record<string, { icon: string; status: string }> = {
  "task-filed": before("Queued"),
  "scope-approved": before("Queued"),
  "approval-withdrawn": before("Needs you"),
  "task-held": before("Stopped"),
  "task-released": before("Queued"),
  "task-queued": before("Queued"),
  "task-requeued": before("Queued"),
  "task-cancelled": before("Stopped"),
};

type TaskLine = { title: string; icon: string; status: string; project: string; view: QuietView };

function taskLine(store: Store, taskRef: number, now: Date, root?: string, viewer?: string): TaskLine | null {
  const ref = store.refById(taskRef);
  if (ref === null || ref.repo === null) return null;
  const task = store.getTask(ref.externalId);
  // A short human title: never "— revision" or an id (chat-voice.ts).
  const title = chatTitle(store, ref.externalId);
  // Replaced, never "Cancelled": the card says a newer task took over and links to it, without either id.
  const successor = task?.state === "cancelled" ? store.replacementOf(ref.externalId) : null;
  if (successor !== null) {
    const words = "Replaced by a newer task";
    const heading = `${headlineEmoji("Stopped")} ${words}`;
    const text = [title, heading, "", projectLabel(ref.repo)].join("\n");
    return { title, icon: headlineEmoji("Stopped"), status: words, project: ref.repo, view: {
      text, entities: [{ type: "bold", offset: 0, length: title.length }, { type: "bold", offset: title.length + 1, length: heading.length }],
      link: { label: "Open the new task", path: chatControlHref("task", successor) },
    } };
  }
  const run = cardRun(store, taskRef);
  if (run !== null) {
    const view = telegramProgressCard(store, run, ref.externalId, ref.repo, now, root, viewer);
    const heading = view.entities[1] === undefined ? "" : view.text.slice(view.entities[1].offset, view.entities[1].offset + view.entities[1].length);
    const split = heading.indexOf(" ");
    return { title, icon: heading.slice(0, split), status: heading.slice(split + 1), project: ref.repo, view };
  }
  const fact = store.latestTaskFact(taskRef);
  const words = task?.state === "cancelled" ? BEFORE_RUN["task-cancelled"]! : BEFORE_RUN[fact?.kind ?? ""] ?? BEFORE_RUN["task-filed"]!;
  const heading = `${words.icon} ${words.status}`;
  const text = [title, heading, "", projectLabel(ref.repo)].join("\n");
  return { title, icon: words.icon, status: words.status, project: ref.repo, view: {
    text, entities: [{ type: "bold", offset: 0, length: title.length }, { type: "bold", offset: title.length + 1, length: heading.length }],
    link: { label: "Open task", path: chatControlHref("task", ref.externalId) },
  } };
}

/** The card's words now: one task's progress card, or one line per task when several were filed together. */
export function quietCardView(store: Store, taskRefs: readonly number[], now: Date, root?: string, viewer?: string): QuietView | null {
  const lines = taskRefs.map(ref => taskLine(store, ref, now, root, viewer)).filter((one): one is TaskLine => one !== null);
  if (lines.length === 0) return null;
  if (lines.length === 1) return lines[0]!.view;
  const heading = `${lines.length} tasks`;
  const projects = [...new Set(lines.map(one => projectLabel(one.project)))];
  const text = [heading, ...lines.map(one => `${one.icon} ${phoneText(one.title, 60)} · ${one.status}`), "", projects.join(", ")].join("\n");
  return { text, entities: [{ type: "bold", offset: 0, length: heading.length }], link: { label: "Open tasks", path: "/tasks" } };
}

/** Facts that carry their own controls or must stand alone (a security alert, a decision, a flow card, a
 * screenshot, an acceptance packet) are never folded into a batch. */
const OWN_MESSAGE_KINDS = new Set(["security-release", "secret-detected", "flow-decision", "flow-card", "acceptance-ready", "acceptance-evidence"]);

/** Whether this update for a person joins their two-minute batch: anything about one task that needs them,
 * except a fact that must stand alone. */
export function joinsBatch(row: Pick<Notification, "dedupeKey" | "kind" | "pushClass" | "recipient" | "taskRef">): boolean {
  return row.taskRef !== null && row.recipient === null && needsPerson(row) && !OWN_MESSAGE_KINDS.has(row.kind) && !/^decision:\d+$/.test(row.dedupeKey);
}

/** A few words for an update in a list, and how it counts: "has a plan to review", "failed". */
function updatePhrase(row: Pick<Notification, "kind" | "pushClass">): { phrase: string; headline: string } {
  if (row.kind === "plan-ready") return { phrase: "has a plan to review", headline: "Needs you" };
  if (row.kind === "report-ready") return { phrase: "has a report to read", headline: "Update" };
  if (row.kind === "stale-approval" || row.kind === "approval-withdrawn") return { phrase: "needs a fresh approval", headline: "Needs you" };
  if (row.pushClass === "merge" || row.kind === "pull-request-ready") return { phrase: "is ready to merge", headline: "Update" };
  if (/fail|exhausted|stalled|fenced/.test(row.kind)) return { phrase: "failed", headline: "Failed" };
  return { phrase: "needs you", headline: "Needs you" };
}

type BatchLine = { fact: FinishedFact; link: PhoneTaskLink; also: PhoneTaskLink[]; target?: DecideTarget | null };

/** One task's line in a batch: a finished result in a person's words with its real next step, or another
 * update in its own words with its own link. */
function lineOf(store: Store, item: ChatBatch["items"][number], now: Date, root?: string, viewer?: string): BatchLine | null {
  const ref = store.refById(item.taskRef);
  if (ref === null || ref.repo === null) return null;
  const summary = chatTitle(store, ref.externalId);
  const row = item.notification === null ? null : store.notificationById(item.notification);
  if (row !== null && row.kind !== "run-finished") {
    // Never the task's id or a "— revision" suffix; the title once, in front unless the words already name it.
    const subject = leadSubjectOf(store, row, viewer);
    const words = chatText(phoneText(row.body === "" ? subject : `${subject}\n\n${row.body}`, 2500), [{ id: ref.externalId, title: summary }]);
    const { phrase, headline } = updatePhrase(row);
    const target = decideTargetOf(row);
    return { also: [], target, link: decideFallbackLink(target) ?? (row.link === null ? { label: "Open task", path: chatControlHref("task", ref.externalId) } : { label: factLinkLabel(row.link), path: row.link }),
      fact: { summary, headline, checks: null, report: false, completedBy: null, update: { words: mentions(words, summary) ? words : `${summary} · ${words}`, phrase } } };
  }
  const run = item.run === null ? null : store.getRun(item.run);
  if (run === null) return null;
  const card = telegramProgressCard(store, run, ref.externalId, ref.repo, now, root, viewer);
  const checks = card.facts.checks ?? null;
  const pullRequest = card.facts.pullRequest?.state === "open";
  const fact: FinishedFact = {
    summary,
    headline: card.status.headline,
    checks: checks === null ? null : checks.level === "off" && checks.status !== "passed" ? "off"
      : checks.status === "passed" || checks.status === "failed" || checks.status === "not-run" ? checks.status : null,
    report: card.facts.report === true,
    completedBy: card.facts.completedBy ?? null,
    pullRequest,
    // The lead speaks as "I" for what it did: the work it filed or approved, or the completion it recorded.
    lead: card.status.headline === "Complete" ? card.completedByLead : store.leadWorkOf(item.taskRef) !== null,
    ...(card.facts.lead === "on-it" ? { leadOnIt: true, ...(card.facts.leadName === undefined ? {} : { leadName: card.facts.leadName }) } : {}),
  };
  // A result ready for a person offers its real next step, then a look first.
  if (asksToFinish(fact)) return { fact, also: [{ label: READY_ACTIONS.look, path: chatResultHref(ref.externalId, run.id, "changes") }],
    target: pullRequest ? { kind: "merge", taskId: ref.externalId, run: run.id } : { kind: "result", taskId: ref.externalId, run: run.id },
    link: pullRequest ? { label: READY_ACTIONS.merge, path: `/t/${encodeURIComponent(ref.externalId)}#merge` } : { label: READY_ACTIONS.complete, path: chatResultHref(ref.externalId, run.id) } };
  return { fact, link: card.link, also: [] };
}

/** One person's update message: one task says what happened with its next step; several updates within two
 * minutes become "4 tasks finished: …" (or "3 updates: …") with one Open button. Null when none can be read. */
export function finishedView(store: Store, batch: Pick<ChatBatch, "items">, now: Date, root?: string, viewer?: string): QuietView | null {
  const lines = batch.items.map(one => lineOf(store, one, now, root, viewer)).filter((one): one is BatchLine => one !== null);
  if (lines.length === 0) return null;
  const text = batchLine(lines.map(one => one.fact));
  if (lines.length > 1) return { text, entities: [], link: { label: "Open", path: "/tasks" } };
  const target = lines[0]!.target ?? null;
  return { text, entities: [], link: lines[0]!.link, ...(lines[0]!.also.length === 0 ? {} : { also: lines[0]!.also }), ...(target === null ? {} : { target }) };
}

// ---- the evening digest ----------------------------------------------------------

const FAILURE = /fail|exhausted|fenced/;
const pad = (n: number) => String(n).padStart(2, "0");
/** This computer's local day and time, which is what a person means by "the evening". */
export function localDay(now: Date): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
export function localTime(now: Date): string {
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/** One person's evening: what finished and what failed in the last day, and what waits for them now. Null when
 * nothing happened, so a quiet day sends nothing. */
export function eveningDigestText(store: Store, account: string, now: Date, root?: string): string | null {
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  const recent = new Date(now.getTime() - 14 * 86_400_000).toISOString();
  const visible = (row: Notification) => row.project !== null && store.accountCanAccess(account, row.project);
  const title = (taskId: string) => chatTitle(store, taskId);
  const finished = new Map<string, string>(), failed = new Map<string, string>(), waits = new Map<string, string>();
  const facts = store.taskFactsSince(recent).filter(visible);
  for (const row of facts) {
    if (row.createdAt < since || row.taskId === null) continue;
    if (isLifecycleNotification(row) && row.kind === "run-finished") finished.set(row.taskId, title(row.taskId));
    else if (FAILURE.test(row.kind)) failed.set(row.taskId, title(row.taskId));
  }
  for (const taskId of new Set(facts.map(row => row.taskId).filter((one): one is string => one !== null))) {
    let headline: Headline | null = null;
    try {
      const project = facts.find(row => row.taskId === taskId)!.project!;
      const assignment = assignmentOf(store, taskId, now, { principal: "operator", repos: [project] }, root);
      headline = assignment === null ? null : taskStatusOf(assignmentStatusFacts(assignment)).headline;
    } catch { headline = null; }
    if (headline === "Ready for review" || headline === "Needs you") waits.set(taskId, `${title(taskId)} · ${headline}`);
    else if (headline === "Failed") failed.set(taskId, title(taskId));
  }
  if (finished.size + failed.size + waits.size === 0) return null;
  const section = (name: string, items: Map<string, string>) => items.size === 0 ? [] : ["", `${name} (${items.size})`, ...[...items.values()].slice(0, 12).map(one => `• ${one}`), ...(items.size > 12 ? [`• and ${items.size - 12} more`] : [])];
  return [...section("Finished", finished), ...section("Waiting for you", waits), ...section("Failed", failed)].slice(1).join("\n");
}

/** Record each due evening digest once per person per local day, as one notification addressed to that person:
 * every chat they paired delivers it with the usual receipts, and the console keeps it. */
export function enqueueEveningDigests(store: Store, now: Date, root?: string): number {
  const day = localDay(now), time = localTime(now);
  let queued = 0;
  for (const person of store.eveningDigestPeople()) {
    if (person.digestAt > time || (person.digestOn !== null && person.digestOn >= day)) continue;
    store.transact(() => {
      if (!store.claimEveningDigestDay(person.account, day)) return;
      const body = eveningDigestText(store, person.account, now, root);
      if (body === null) return;
      if (store.enqueueNotification({ dedupeKey: `digest:evening:${person.account}:${day}`, kind: "evening-digest", subject: "Evening digest", body,
        link: "/tasks", source: { installation: true }, recipient: person.account }, now)) queued++;
    });
  }
  return queued;
}
