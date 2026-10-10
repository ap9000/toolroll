import { publicChatText } from './chat-display.js';
import { manualReviewOnly } from "./proof.js";
/** Read-only phone views over the same dispatch and proof records as chat.
 * No provider calls, repository access, new workflow state, or inferred success. */
import { diagnoseTaskDispatch, withDispatchDiagnoses, type DispatchDiagnosis } from "./dispatch.js";
import type { Notification, Store } from "./store.js";
import { familyCompleted } from "./result-completion.js";
import { assignmentStatusFacts, plainReasonOf, stageOfDispatch, taskStatusOf, type TaskStatus } from "./task-status.js";
import { assignmentOf } from "./assignment.js";
import { CHAT_CONTROLS, chatControlHref, chatResultHref, type ChatControl } from "./chat-controls.js";

export type PhoneCommand = { kind: "status" } | { kind: "help" } | { kind: "task"; id: string } | { kind: "tasks" } | { kind: "lead" };

export function phoneCommand(text: string): PhoneCommand | null {
  // Slash forms everywhere; the bare words too, because Slack and Discord
  // keep unregistered slash text for themselves. Only a whole message that
  // is exactly the command counts — prose never is.
  const t = text.trim();
  if (/^\/?(?:help|start)$/i.test(t)) return { kind: "help" };
  if (/^\/?status$/i.test(t)) return { kind: "status" };
  // The picker: /tasks (or /task alone) lists them to choose from; /lead
  // goes back to the lead conversation.
  if (/^\/?tasks?$/i.test(t)) return { kind: "tasks" };
  if (/^\/?lead$/i.test(t)) return { kind: "lead" };
  // An id, a number from the list, or words from the title.
  const task = /^\/?task\s+([A-Za-z0-9][A-Za-z0-9 ._'-]{0,63})$/i.exec(t);
  if (task !== null) return { kind: "task", id: task[1]!.trim() };
  // A mistyped slash command gets help, but arbitrary prose is not a command.
  return /^\/(?:status|tasks?|lead|help|start)(?:\s|$)/i.test(t) ? { kind: "help" } : null;
}

export const PHONE_HELP = [
  "Toolroll in chat",
  "",
  "Say what you want in plain words: ask how something is going, ask for a change, or describe new work. The lead answers here and shows a card before anything changes; nothing changes until you act.",
  "",
  "Reply to any message about a task (an update, a result, a status or the lead's answer) to talk about that task.",
  "",
  "/tasks — pick a task to talk about",
  "/task <name or number> — the same, by a word from its name",
  "/lead — back to talking about everything",
  "/status — what's happening across your projects",
  // D5: /team (the central team service's conversations) is deprecated: it still answers this release, unlisted.
  "/help — this message",
  "",
  "To answer an agent's question, tap its buttons; reply to the question to add a note. Approvals that need your password, cancelling and publishing finish in the Toolroll console, and a console button only takes you there. The computer must be awake and connected to reply.",
].join("\n");

/** A third-party transport receives a small display copy, not logs, paths,
 * credentials, or arbitrary markup. Scan BEFORE truncation/normalization. */
const plain = publicChatText;

/** The same display scrub for every phone-bound string a person or a model authored. */
export const phoneText = plain;

export function projectLabel(repo: string): string {
  return plain(repo.split(/[\\/]/).filter(Boolean).pop() ?? "project", 48);
}

/** The phone's reading of saved results: `root` lets a finished result read its saved checks, requirements and
 * review exactly as the console does. Without it, the dispatch diagnosis speaks. */
export type PhoneRead = { root?: string | undefined; now?: Date; repos?: readonly string[] };

/** The shared headline (task-status.ts) for a dispatch diagnosis on the phone. */
function headlineFor(store: Store, id: string, d: DispatchDiagnosis, read_: PhoneRead = {}): TaskStatus {
  // Any version of a completed family reads Complete, as taskWaitSnapshot says.
  const completed = d.code === "complete" && familyCompleted(store, id);
  const read = stageOfDispatch(d, { completed });
  // A finished result reads the console's own facts: its requirements, checks Off at release, and what holds it back.
  if (read.stage === "finished" && read_.root !== undefined && read_.now !== undefined && read_.repos !== undefined) {
    const assignment = assignmentOf(store, id, read_.now, { principal: "operator", repos: read_.repos }, read_.root);
    if (assignment !== null && assignment.state === "ready-to-check") return taskStatusOf(assignmentStatusFacts(assignment));
  }
  const finished = read.stage === "finished" || read.stage === "complete" || read.stage === "failed";
  return taskStatusOf({ stage: read.stage, ...(read.need === undefined ? {} : { need: read.need }), reason: finished ? null : plainReasonOf(read.stage, d.code, d.detail),
    checks: read.stage === "failed" && d.code === "proof-refuted" ? { status: "failed", exitCode: null, head: null } : null });
}

function groupOf(d: DispatchDiagnosis): string {
  if (d.condition === "running") return "Working";
  if (d.code === "cancelled") return d.summary.startsWith("Replaced by ") ? "Replaced" : "Cancelled";
  if (d.code === "complete") return "Finished";
  if (d.code === "review-pending" || d.action === null) return "Waiting / next up";
  return "Needs attention";
}

function nextStep(d: DispatchDiagnosis): string {
  if (d.code === "review-pending") return "An older review request is on record; nothing runs for it. Open the saved result in the console.";
  switch (d.action) {
    case "open-result": return "Open this task's result in the console, inspect it, then mark it complete or request changes.";
    case "retry-task": return "Open this task in the console, review why it stopped, and use the available retry action.";
    case "place-task": return "Choose a project for this task in the console.";
    case "write-scope": return "Describe the goal and success checks in the console, or ask the planner to draft them.";
    case "select-agent": return "Open this task in the console and check its agent settings or provider availability.";
    case "approve-scope": return "Read the proposed work in the console and approve it if it is right.";
    case "answer-decision": return "Answer the waiting question using its decision buttons or the console.";
    case "unhold": return "Open this task in the console and release its hold when you want it to continue.";
    case "inspect-hold": return "Open this task in the console to see what must change before it can continue.";
    case "repair-dependency": return "Open this task in the console. Retry the required task, choose a different task to wait for, or explicitly stop waiting for it.";
    case "repair-capability": return "Open this task's requirements in the console and fix the named setup issue.";
    case "start-worker": return "Reopen Toolroll on the computer and finish any project-access setup. Approved work can resume when the builder reconnects.";
    case "retry-review": return "Open the saved result in the console. Nothing reruns a review; mark the result complete or request changes.";
    case "resume-run": return "Open this task in the console and choose Resume after its stopped attempt has finished stopping.";
    case null: return d.condition === "running" ? "No action needed from you right now." : d.code === "cancelled" ? "Nothing else will run for this task." : "Toolroll can reconsider this task when its waiting condition clears.";
  }
}

/** repos is the transport's explicit enrollment ceiling, never opened-project
 * history. This snapshot is intentionally bounded and advertises that bound. */
export function phoneStatus(store: Store, repos: readonly string[], now: Date, focused: string | null = null, root?: string): string {
  if (repos.length === 0) return "No connected projects are available to this bridge. Add a project in Toolroll, then send /status again.";
  return store.transact(() => {
    const snapshot = withDispatchDiagnoses(store, store.chatSnapshot(repos, now), now);
    const lines = [...(focused === null ? [] : [`Talking about: ${focused} · /lead to switch back`, ""]), "Recent work", `As of ${now.toISOString().replace("T", " ").slice(0, 19)} UTC · ${repos.length} project(s)`, ""];
    if (snapshot.tasksSaturated) lines.push("Newest 60 tasks only — older work may still need attention.", "");
    if (snapshot.tasks.length === 0) lines.push("No tasks are recorded in these projects.");
    for (const group of ["Needs attention", "Working", "Waiting / next up", "Finished", "Replaced", "Cancelled"]) {
      const rows = snapshot.tasks.filter(t => t.dispatch !== null && t.dispatch !== undefined && groupOf(t.dispatch) === group);
      if (rows.length === 0) continue;
      lines.push(`${group} · ${rows.length}${snapshot.tasksSaturated ? " in this snapshot" : ""}`);
      for (const task of rows.slice(0, 2)) {
        lines.push(`${plain(task.id, 64)} · ${projectLabel(repos[task.repoIndex]!)}`, `  ${plain(task.title, 64)} — ${headlineFor(store, task.id, task.dispatch!, { root, now, repos }).headline}`);
      }
      if (rows.length > 2) lines.push(`  +${rows.length - 2} more in the console`);
      lines.push("");
    }
    lines.push("Send /tasks to pick one, or /task <name> for its next step. Status is a snapshot, not a promise that the next attempt will succeed.");
    return lines.join("\n");
  });
}

/** One task a person can pick to talk about from a chat app. */
export type PhoneTaskChoice = { id: string; title: string; label: string; group: string };
const PICK_GROUPS = ["Needs attention", "Working", "Waiting / next up", "Finished"];

/** The tasks a paired chat can pick from: what needs the person first,
 * then work in progress, waiting work and recent results; one entry per
 * task (its revisions share it), optionally narrowed by words in the id or
 * title. Bounded, within the chat's own project ceiling. */
export function phoneTaskChoices(store: Store, repos: readonly string[], now: Date, query: string | null = null, limit = 8, root?: string): PhoneTaskChoice[] {
  if (repos.length === 0) return [];
  return store.transact(() => {
    const snapshot = withDispatchDiagnoses(store, store.chatSnapshot(repos, now), now);
    const words = query === null ? [] : query.toLowerCase().split(/\s+/).filter(Boolean);
    const rows = snapshot.tasks
      .filter(one => one.dispatch !== null && one.dispatch !== undefined && PICK_GROUPS.includes(groupOf(one.dispatch)))
      .sort((a, b) => PICK_GROUPS.indexOf(groupOf(a.dispatch!)) - PICK_GROUPS.indexOf(groupOf(b.dispatch!)) || a.ageHours - b.ageHours);
    const seen = new Set<string>();
    const choices: PhoneTaskChoice[] = [];
    for (const row of rows) {
      const id = row.rootId ?? row.id;
      if (seen.has(id) || !words.every(word => `${id} ${row.title}`.toLowerCase().includes(word))) continue;
      seen.add(id);
      choices.push({ id, title: plain(row.title, 64), label: headlineFor(store, row.id, row.dispatch!, { root, now, repos }).headline, group: groupOf(row.dispatch!) });
      if (choices.length >= limit) break;
    }
    return choices;
  });
}

/** `id` keys the chat's choice (the task's first version, where its chat
 * lives); `view` is what to show: the exact version named, else the current one. */
export type PhoneTaskPick = { kind: "one"; id: string; view: string; title: string } | { kind: "many"; choices: PhoneTaskChoice[] } | { kind: "none" };

/** `/task <what>`: an exact task id, a number from the /tasks list, or
 * words from a title — one match is chosen, several are offered. */
export function resolvePhoneTask(store: Store, repos: readonly string[], now: Date, query: string): PhoneTaskPick {
  const ref = store.lookupRef(query);
  if (ref?.repo != null && repos.includes(ref.repo)) {
    const root = store.taskFamilyOf(query, repos, false)?.root ?? null;
    return { kind: "one", id: root?.id ?? query, view: query, title: plain(root?.title ?? store.getTask(query)?.title ?? query, 64) };
  }
  const chosen = (one: PhoneTaskChoice): PhoneTaskPick => ({ kind: "one", id: one.id, view: store.taskFamilyOf(one.id, repos, false)?.current.id ?? one.id, title: one.title });
  if (/^\d{1,2}$/.test(query)) {
    const pick = phoneTaskChoices(store, repos, now)[Number(query) - 1];
    return pick === undefined ? { kind: "none" } : chosen(pick);
  }
  const matches = phoneTaskChoices(store, repos, now, query);
  return matches.length === 0 ? { kind: "none" } : matches.length === 1 ? chosen(matches[0]!) : { kind: "many", choices: matches };
}

/** The picker as text, for chat apps without buttons. */
export function phoneTaskListText(choices: readonly PhoneTaskChoice[], focused: string | null): string {
  if (choices.length === 0) return "No open or recent tasks in your connected projects. Describe what you want done and the lead will draft one.";
  return [
    ...(focused === null ? [] : [`Talking about: ${focused}`, ""]),
    "Your tasks",
    ...choices.map((one, index) => `${index + 1}. ${one.title} — ${one.label}`),
    "",
    "Send /task <number or name> to talk about one. /lead goes back to the lead.",
  ].join("\n");
}

/** Said under a task's status when a chat app chooses it. */
export const PHONE_FOCUS_LINE = "Talking about this task now: ask anything or say what to change. Reply to this message later to come back to it; /lead goes back to the lead.";

/** A chosen task's status, then the line that says the chat now talks about it. */
export function phoneFocusText(view: string): string {
  return `${view}\n\n${PHONE_FOCUS_LINE}`;
}

export const PHONE_NO_MATCH = "No such task in your connected projects. Send /tasks to pick one.";
export const PHONE_BACK_TO_LEAD = "Back to the lead. Your messages here are about all your work again.";

/** A fixed console destination for one task, named beside its label; the origin joins it only on the wire. */
export type PhoneTaskLink = { label: string; path: string };
/** Where the rest lives when no button can say so: the closing line of an unlinked `/task`. */
export const PHONE_CONSOLE_FOOTER = "Read-only status. Saved files and full actions are in the console.";

/**
 * Where `/task`'s one button goes, from the recorded diagnosis: the exact
 * saved result's checks (a recorded verdict) or changes (none yet) for a
 * finished task; the approval control while the scope waits; the task's
 * own page for retry, hold, dependency and resume ceremonies; the task lens
 * otherwise (a worker that must be started is not a browser step, and the
 * lens says so). Only a task inside the phone's ceiling gets here.
 */
function taskLinkFor(id: string, d: DispatchDiagnosis, result: { run: number; verdict: boolean } | null): PhoneTaskLink {
  const control = (name: ChatControl): PhoneTaskLink => ({ label: CHAT_CONTROLS[name].label, path: chatControlHref(name, id) });
  if (result !== null) return result.verdict ? { label: "Open checks", path: chatResultHref(id, result.run, "checks") } : { label: "Open changes", path: chatResultHref(id, result.run, "changes") };
  switch (d.action) {
    case "approve-scope": return control("approval");
    case "retry-task": case "unhold": case "inspect-hold": case "repair-dependency": case "retry-review": case "resume-run": return control("recovery");
    default: return control("task");
  }
}

export function phoneTask(store: Store, repos: readonly string[], id: string, now: Date, root?: string): string {
  return phoneTaskView(store, repos, id, now, root).text;
}

/** One task's status for a chat app: the words, its one console link, and
 * the saved result it shows (a reply to it is about that result). */
export function phoneTaskView(store: Store, repos: readonly string[], id: string, now: Date, root?: string): { text: string; link: PhoneTaskLink | null; run: number | null } {
  return store.transact(() => {
    const ref = store.lookupRef(id);
    // Check admission before reading a title, run, proof, or diagnosis.
    const task = ref?.repo != null && repos.includes(ref.repo) ? store.getTask(id) : null;
    if (task === null || ref?.repo == null) return { text: "No such task in your connected projects. Send /status for task IDs.", link: null, run: null };
    const d = diagnoseTaskDispatch(store, id, now);
    if (d === null) return { text: "This task's status is unavailable. Open it in the console before retrying.", link: null, run: null };
    const shared = headlineFor(store, id, d, { root, now, repos });
    const lines = [plain(task.title, 140), `${plain(id, 64)} · ${projectLabel(ref.repo)}`, `As of ${now.toISOString().replace("T", " ").slice(0, 19)} UTC`, "", shared.headline];
    const blocker = d.blockerTaskId === null ? null : store.lookupRef(d.blockerTaskId);
    const hiddenDependency = blocker !== null && (blocker.repo === null || !repos.includes(blocker.repo));
    lines.push(hiddenDependency ? "A required task outside this phone view has not finished. Open the dependency in the console." : plain(shared.sentence, 650));
    if (d.nextAt !== null) lines.push(`Earliest recorded wake: ${plain(d.nextAt, 40)} (a connected worker is still required).`);

    const runs = store.runsFor(ref.id);
    const result = task.state === "done" ? runs.find(r => (r.role === "builder" || r.role === "scout") && (r.outcome === "built" || r.outcome === "no-change") && r.finishedAt !== null) : undefined;
    const latest = result ?? runs[0];
    if (latest !== undefined) {
      lines.push("", `${result === undefined ? "Latest recorded attempt" : "Saved result"}: #${latest.id} · ${plain(latest.provider, 40)}${latest.model === null ? "" : ` / ${plain(latest.model, 80)}`}`);
      // Terminal status wins; a leftover internal phase must never read as activity.
      if (latest.finishedAt !== null) lines.push(`Attempt ended: ${plain(latest.finishedAt, 40)}`);
      else if (d.condition === "running") {
        const checkpoint = store.latestCheckpointForRun(latest.id);
        lines.push(checkpoint === null ? "No milestone progress has been recorded for this attempt." : `Latest agent-reported milestone update: ${plain(checkpoint.createdAt, 40)} (not independent proof).`);
      }
    }
    let link: PhoneTaskLink | null = null;
    if (result !== undefined) {
      const proof = store.proofVerdictFor(result.id);
      link = taskLinkFor(id, d, { run: result.id, verdict: proof !== null });
      const accepted = store.proofAcceptance(result.id) !== null;
      const proofWords = { verified: "Checks passed at completion", attested: "Checks reported by the agent, not run by Toolroll", short: "Required saved material is missing", refuted: "The saved result conflicts with the approved scope" };
      lines.push(`Checks: ${proof === null ? "No completion record saved" : manualReviewOnly(proof) ? accepted ? "Accepted by a person; the recorded checks are unchanged" : "A person must inspect this result; no recorded check failed" : proofWords[proof.verdict]}.`);
      if (manualReviewOnly(proof) && !accepted) lines.push('Reply “Send the result summary” for the checks, notes and screenshots.');
      if (proof !== null && proof.matrix.length > 0) lines.push(`Requirements: ${proof.matrix.filter(row => row.state === "pass").length}/${proof.matrix.length} satisfied in the saved record.`);
      if (accepted && !manualReviewOnly(proof)) lines.push("An operator accepted this result; that does not change its recorded checks.");
      const publication = store.publicationForRun(result.id);
      const delivery = publication?.remoteState === "MERGED" ? `#${publication.prNumber ?? "?"} merged` : publication?.remoteState === "CLOSED" ? `#${publication.prNumber ?? "?"} closed without merging` : publication?.state === "opened" ? `#${publication.prNumber ?? "?"} open` : publication?.state === "pushed" || publication?.state === "intended" ? "Opening…" : publication?.state === "failed" ? "Couldn't open; the commit is safe locally" : null;
      if (delivery !== null) lines.push(`Pull request: ${delivery}.`);
    }
    if (result === undefined) link = taskLinkFor(id, d, null);
    // Said once: the button is where; the sender adds the closing line when no button can ride.
    lines.push("", `Next: ${nextStep(d)}`);
    return { text: lines.join("\n"), link, run: result?.id ?? null };
  });
}

/** Concise display only: authorization uses the stored full project identity. */
/** Where a fact belongs: its project and, given one, the task's short title — never the task's id. */
export function notificationIdentity(row: Pick<Notification, "project" | "taskId">, title?: string): string {
  if (row.project === null) return "";
  return `${projectLabel(row.project)}${row.taskId === null || title === undefined ? "" : ` / ${plain(title, 64)}`} · `;
}
