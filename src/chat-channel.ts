/** Shared membership-chat identity, proposal previews and result links. Transport adapters never grant authority. */
import { FLOW_HREF } from "./flow-engine.js";
import { createHash } from "node:crypto";
import {
  sharedActionPayload,
  sharedActionNeedsReview,
  sharedActionReviewPath,
  sharedActionAllowsChallenge,
  CHAT_ACTIONS,
} from "./chat-actions.js";
import { isDirectChatProvider, subscriptionCredentialKey } from "./converse.js";
import { MATE_MESSAGE_MAX_CHARS } from "./mate.js";
import type { DoorOutcome } from "./mate-doors.js";
import { MATE_TOOL_SCHEMAS } from "./mate-tools.js";
import { verifyApproverStanding, type VerifiedApprover } from "./principal.js";
import { canonicalProject } from "./project.js";
import type {
  ChatConfig,
  MateProposal,
  MateSession,
  MateThread,
  Store,
  SubscriptionChatProviderId,
} from "./store.js";
import { phoneText, projectLabel } from "./telegram-status.js";
import {
  CHAT_CONTROLS,
  chatControlHref,
  chatResultHref,
  isChatControl,
  type ChatControl,
} from "./chat-controls.js";
import { CHAT_TASK_ACTIONS, isChatTaskAction } from "./chat-task-actions.js";
export function channelRepos(
  store: Store,
  approver: string,
  registry: readonly string[],
): string[] {
  const seen = new Set<string>();
  const repos: string[] = [];
  for (const path of registry) {
    const canonical = canonicalProject(path) ?? path;
    if (seen.has(canonical) || !store.accountCanAccess(approver, canonical))
      continue;
    seen.add(canonical);
    repos.push(canonical);
  }
  return repos;
}

export type ResolvedMate =
  | {
      ok: true;
      who: VerifiedApprover;
      session: MateSession;
      thread: MateThread;
      config: ChatConfig & { provider: SubscriptionChatProviderId };
    }
  | {
      ok: false;
      reason:
        | "unpaired"
        | "unconfigured"
        | "direct-api"
        | "no-projects"
        | "busy"
        | "no-session";
      said: string | null;
    };

/**
 * The session and thread a paired phone speaks in: the approver's live
 * session when it is compatible (same generation, same membership
 * credential, same ceiling), else a fresh one minted under the very terms
 * the console and CLI state for membership chat (no dollar ceiling, this
 * ceiling digest). An incompatible session or thread left open on the
 * computer is replaced rather than refused, so a message from the phone
 * always gets an answer — except while a turn is still running there,
 * which is "busy": the message waits its turn instead of ending it.
 */
export function resolveChannelMate(
  store: Store,
  binding: { approver: string; approverGeneration: number },
  repos: readonly string[],
  now: Date,
): ResolvedMate {
  const config = store.getChatConfig();
  if (config === null) {
    return {
      ok: false,
      reason: "unconfigured",
      said: "Chat isn't set up yet. Choose a chat provider in Toolroll settings on the computer, then message again. Nothing was changed.",
    };
  }
  if (isDirectChatProvider(config.provider)) {
    return {
      ok: false,
      reason: "direct-api",
      said: "Chat from this phone uses your membership login. Direct API chat stays on the computer so this chat cannot spend your API budget. Nothing was changed.",
    };
  }
  if (repos.length === 0) {
    return {
      ok: false,
      reason: "no-projects",
      said: "No connected projects are available to this phone. Add a project in Toolroll on the computer, then message again.",
    };
  }
  const verified = verifyApproverStanding(
    store,
    binding.approver,
    binding.approverGeneration,
    repos,
  );
  if (!verified.ok) return { ok: false, reason: "unpaired", said: null };
  const who = verified.who;
  const credentialKey = subscriptionCredentialKey(config.provider);
  let session = store.activeMateSession(who.name);
  const liveThread = store.liveMateThreadFor(who.name);
  const sessionMismatch =
    session !== null &&
    (session.approverGeneration !== who.generation ||
      session.credentialKey !== credentialKey ||
      session.ceilingDigest !== who.ceilingDigest);
  const threadMismatch =
    liveThread !== null && liveThread.ceilingDigest !== who.ceilingDigest;
  // Replacing either would end a turn still running on the computer.
  if ((sessionMismatch || threadMismatch) && store.liveMateTurnFor(who.name) !== null)
    return { ok: false, reason: "busy", said: null };
  if (session === null || sessionMismatch) {
    const termsDigest = createHash("sha256")
      .update(`0\n${who.ceilingDigest}`)
      .digest("hex");
    const id = store.mintMateSession(
      {
        approver: who.name,
        approverGeneration: who.generation,
        credentialKey,
        ceilingMicrousd: 0,
        ceilingDigest: who.ceilingDigest,
        termsDigest,
      },
      now,
    );
    session = store.getMateSession(id);
    if (session === null)
      return { ok: false, reason: "no-session", said: couldNotAnswerText("a new chat session couldn't be started") };
  }
  // openMateThread closes a thread kept under another ceiling.
  const thread =
    threadMismatch || liveThread === null
      ? store.openMateThread(who.name, who.ceilingDigest, now).thread
      : liveThread;
  return {
    ok: true,
    who,
    session,
    thread,
    config: config as ChatConfig & { provider: SubscriptionChatProviderId },
  };
}

/** A phone exchange about one task (a reply to that task's or result's
 * message) stays in the lead conversation, and is kept in the task's own
 * chat as well, so the task shows everything asked of it wherever it was
 * asked. Best effort: the phone conversation never depends on it. */
export function mirrorToTaskChat(store: Store, who: VerifiedApprover, taskId: string, surface: string, message: string, reply: string, now: Date): void {
  try {
    const root = store.taskFamilyOf(taskId, who.repos, false)?.root.id ?? taskId;
    if (!taskInCeiling(store, root, who.repos)) return;
    const thread = store.openMateThread(who.name, who.ceilingDigest, now, { kind: "task", key: root }).thread;
    store.appendMateMessage({ thread: thread.id, turn: null, role: "operator", text: `From ${surface}: ${message}` }, now);
    store.appendMateMessage({ thread: thread.id, turn: null, role: "assistant", text: reply }, now);
  } catch {
    // The task chat is a copy; the phone's own conversation already has it.
  }
}

/** The one short message a person gets when their question could not be answered. */
export function couldNotAnswerText(reason: string): string {
  return `I couldn't answer that just now: ${reason.replace(/\.$/, "")}. Ask again, or open the console.`;
}

export function tooLongText(length: number): string {
  return `That message is ${length.toLocaleString("en-US")} characters; chat takes up to ${MATE_MESSAGE_MAX_CHARS.toLocaleString("en-US")}. Nothing was sent to the assistant. Send it in shorter parts, or say which part matters most.`;
}

/** A reply to a message about several tasks is never guessed: it names them and says how to choose. */
export function whichTaskText(titles: readonly string[]): string {
  return [
    "That message is about more than one task:",
    ...titles.map((title) => `• ${phoneText(title, 64)}`),
    "Reply to a message about just one of them, or send /tasks to pick one.",
  ].join("\n");
}

/** The server-authored context a reply to a result message carries into the turn — the exact execution and run, never a guess. */
export function replyContextFor(taskId: string, run: number | null): string {
  return [
    `Current task: ${taskId}. Read it with get_task before answering or proposing changes. Read its currentExecution next and bind new actions to that exact execution. Never replace the target of a prior proposal with a newer revision. Keep this turn about that task unless the operator explicitly asks to broaden it.`,
    run === null
      ? `The operator is replying to a message about execution ${taskId}.`
      : `The operator is replying to result #${run} from execution ${taskId}. Use get_result for that exact execution and run when responding to feedback; do not substitute another result. If the operator asks for changes, use propose_review revise; use note only when they explicitly ask to save feedback without starting work.`,
  ].join(" ");
}

/** The context a chosen task (/tasks, /task <name>) carries into each turn from that chat. */
export function focusContextFor(taskId: string): string {
  return `Current task: ${taskId}. The operator chose this task in their chat app; their messages there are about it until they switch back. Read it with get_task before answering or proposing changes, and bind new actions to its currentExecution. Read get_task_conversation when they refer to earlier discussion. Keep this turn about that task unless the operator explicitly asks to broaden it.`;
}

/** A step the phone cannot take itself: said once; the button (or its absence) says where. */
const HANDOFF = "This step finishes in Toolroll.";
/** No trusted https origin is configured: one honest line, no localhost, no promise. */
export const NO_PHONE_LINK =
  "Phone access isn't configured. Open Toolroll on your computer.";
/** An origin exists but the card's task is not one this phone may reach now: said as that, never as missing setup. */
export const NO_TASK_LINK =
  "No phone link: this task is outside your connected projects now, so open Toolroll on the computer.";

/** A fixed console destination beside its button label. The path is one of chat-controls' own; the origin joins it only at send time. */
export type PhoneLink = { label: string; path: string };

/** Is this task one the phone's ceiling admits right now? A link names a stored identity, never a model's word alone. */
export function taskInCeiling(
  store: Store,
  taskId: string,
  repos: readonly string[],
): boolean {
  const ref = store.lookupRef(taskId);
  return ref !== null && ref.repo !== null && repos.includes(ref.repo);
}

/** The recorded scope's standing — none filed yet (a planner is drafting), waiting for approval, or approved (by hand or under a signed mode). Read from the row, never from an outcome's words. */
function approvalState(
  store: Store,
  taskId: string,
): "none" | "planning" | "waiting" | "approved" {
  const scope = store.getScope(taskId);
  if (scope === null) return "none";
  if (scope.approvedDigest != null && scope.approvedDigest === scope.digest) return "approved";
  // Nothing to approve while the planner is still writing the plan.
  return store.lookupRef(taskId)?.plan === "requested" ? "planning" : "waiting";
}

function controlLink(
  control: ChatControl,
  taskId: string,
  run?: unknown,
  project?: unknown,
): PhoneLink {
  return {
    label: CHAT_CONTROLS[control].label,
    path: chatControlHref(control, taskId, run, project),
  };
}

/**
 * Where a task's next step lives, from its recorded state: the approval
 * control while its scope waits for one, else the task itself.
 */
function taskLink(
  store: Store,
  taskId: string,
  repos: readonly string[],
): PhoneLink | null {
  if (!taskInCeiling(store, taskId, repos)) return null;
  return controlLink(
    approvalState(store, taskId) === "waiting" ? "approval" : "task",
    taskId,
  );
}

/**
 * The link a PENDING card carries: only the handoff kinds (cancel, a console
 * control), whose whole point is where to go. Confirmable cards keep their
 * Confirm/Dismiss buttons alone — a second button on a card that acts is a
 * choice the operator did not need.
 */
/** A chat transport that renders cards and confirms them in place. The
 * console ("web") and the terminal are not chat channels. */
export type ChatChannelName = "telegram" | "slack" | "discord" | "teams";

/** The card text once its challenge is armed: an irreversible answer or a
 * challenge action, in the same words on every channel. */
export function armedCardText(proposal: MateProposal, previewText: string): string {
  const body = previewText.split("\n\nConfirm or Dismiss below")[0] ?? previewText;
  if (proposal.kind === "action") return `${body}\n\nThis records that you handled this exact result. Confirm?`;
  return `⚠ This answer is IRREVERSIBLE.\n\n${body}\n\nConfirm?`;
}

/** The "yes" button's label for an armed card. */
export function armedYesLabel(proposal: MateProposal): string {
  if (proposal.kind === "action") {
    const action = sharedActionPayload(proposal.payload);
    return `Yes, ${(action === null ? "confirm" : CHAT_ACTIONS[action.operation].label).toLowerCase()}`;
  }
  return "Yes, answer";
}

export function proposalLink(
  store: Store,
  proposal: MateProposal,
  repos: readonly string[],
  channel: ChatChannelName | null = null,
): PhoneLink | null {
  const payload = proposal.payload;
  if (proposal.kind === "action") {
    const action = sharedActionPayload(payload);
    return action &&
      repos.includes(action.repo) &&
      sharedActionNeedsReview(action) &&
      !(channel !== null && sharedActionAllowsChallenge(action))
      ? { label: "Review action", path: sharedActionReviewPath(proposal.id) }
      : null;
  }
  const task = typeof payload["task"] === "string" ? payload["task"] : "";
  if (proposal.kind === "cancel")
    return task !== "" && taskInCeiling(store, task, repos)
      ? controlLink("cancel", task)
      : null;
  if (proposal.kind === "control") {
    const control = payload["control"];
    if (!isChatControl(control)) return null;
    if (control === "skills" || control === "tools")
      return typeof payload["project"] === "string" &&
        repos.includes(payload["project"])
        ? controlLink(control, task, undefined, payload["project"])
        : null;
    if ("href" in CHAT_CONTROLS[control]) return controlLink(control, task);
    return task !== "" && taskInCeiling(store, task, repos)
      ? controlLink(control, task, payload["run"])
      : null;
  }
  return null;
}

/**
 * The link a CONFIRMED card carries: the exact recorded task the outcome
 * names, where its remaining step lives — the approval control while the
 * scope waits for one (a manual approval), the task otherwise (an
 * automatic approval, a staged resume). Kinds whose outcome is complete
 * carry none.
 */
export function confirmedLink(
  store: Store,
  outcome: DoorOutcome,
  proposal: MateProposal,
  repos: readonly string[],
): PhoneLink | null {
  // A flow change opens its canvas, the card selected.
  if (outcome.ok && proposal.kind === "action" && typeof outcome.href === "string" && FLOW_HREF.test(outcome.href)) return { label: "Open the flow", path: outcome.href };
  if (!outcome.ok || outcome.taskId === null) return null;
  if (
    proposal.kind === "action" &&
    proposal.payload["operation"] === "skill_test"
  )
    return taskLink(store, outcome.taskId, repos);
  const staged =
    proposal.kind === "task" ||
    proposal.kind === "scope" ||
    proposal.kind === "agents" ||
    (proposal.kind === "task_action" &&
      proposal.payload["operation"] === "resume") ||
    (proposal.kind === "review" && proposal.payload["operation"] === "revise");
  return staged ? taskLink(store, outcome.taskId, repos) : null;
}

/** One url button: navigation only — it opens the console's own authenticated control and grants nothing. */

function lines(text: string, cap: number): string[] {
  return phoneText(text, cap)
    .split("\n")
    .map((line) => `| ${line}`);
}

/** The card: plain words for what confirming does, the exact terms it binds to, and whether a button belongs on it. */
export function proposalPreview(
  store: Store,
  proposal: MateProposal,
  repos: readonly string[],
  channel: ChatChannelName | null = null,
): { text: string; buttons: boolean } {
  const payload = proposal.payload;
  const t = (key: string, cap = 200): string =>
    typeof payload[key] === "string"
      ? phoneText(payload[key] as string, cap)
      : "";
  const task = t("task", 64);
  const taskName = t("taskTitle", 120) || task;
  const repoLabel = (() => {
    const id = t("repoId", 8);
    const path = /^r[0-9]+$/.test(id)
      ? repos[Number(id.slice(1)) - 1]
      : undefined;
    return path === undefined ? id : projectLabel(path);
  })();
  // Telegram's card leads with the action and what confirming does, then the exact terms; its buttons say the rest.
  const phone = channel === "telegram";
  const card = (
    headline: string,
    body: string[] = [],
    consequence: string | null = null,
  ): { text: string; buttons: boolean } => ({
    text: (phone
      ? [
          headline,
          ...(consequence === null ? [] : [consequence]),
          ...(body.length === 0 ? [] : ["", ...body]),
          "",
          "Nothing changes until you confirm.",
        ]
      : [
          headline,
          ...body,
          ...(consequence === null ? [] : ["", consequence]),
          "",
          "Confirm or Dismiss below. Nothing changes until you confirm.",
        ]).join("\n"),
    buttons: true,
  });
  const lasting = phone ? " ⚠ can't be undone" : " — IRREVERSIBLE";
  // A handoff's text is origin-free on purpose: it is persisted before the
  // send, and the button or the missing-setup line joins it at send time.
  const handoff = (
    headline: string,
    body: string[] = [],
  ): { text: string; buttons: boolean } => ({
    text: [headline, ...body, "", HANDOFF].join("\n"),
    buttons: false,
  });

  switch (proposal.kind) {
    case "action": {
      const action = sharedActionPayload(payload);
      if (!action) return handoff("This action is unavailable.");
      if (channel !== null && sharedActionAllowsChallenge(action))
        return card(
          phoneText(action.title, 200),
          action.terms.map((term) => phoneText(term, 1200)),
          "Confirm asks once more before anything is recorded.",
        );
      return sharedActionNeedsReview(action)
        ? handoff(phoneText(action.title, 200), [
            "Review the full details and confirm this exact action.",
          ])
        : card(
            phoneText(action.title, 200),
            action.terms.map((term) => phoneText(term, 1200)),
          );
    }
    case "task":
      return card(
        `Create task in ${repoLabel || "the project"}: ${t("title", 120)}`,
        [
          `Goal: ${t("goal", 600)}`,
          ...(t("not") === "" ? [] : [`Not: ${t("not", 300)}`]),
          ...(payload["report"] === true
            ? ["A scout task: it delivers a report, never a branch."]
            : []),
        ],
        payload["report"] === true
          ? "Confirm files it; a scout needs no approval."
          : "Confirm files it. You still approve its scope before work starts.",
      );
    case "next":
      return card(
        `Move ${taskName} to the front of its queue (now ${String(payload["position"] ?? "?")} of ${String(payload["of"] ?? "?")}).`,
      );
    case "reserve":
      return card(
        payload["worker"] === null
          ? `Release ${taskName} to the shared queue.`
          : `Reserve ${taskName} for ${t("worker", 80)}.`,
      );
    case "hold":
      return card(
        `Hold ${taskName}: ${t("reason", 300)}`,
        [],
        "The task waits until the hold is released.",
      );
    case "unhold":
      return card(`Release ${taskName} from its hold.`);
    case "steer":
      return card(
        `Guide ${taskName}'s next attempt:`,
        lines(t("note", 1_000), 1_000),
        "Scope stays the same; active work is not interrupted.",
      );
    case "repair": {
      const blocker = t("blockerTitle", 120) || t("blocker", 64);
      const operation = t("operation", 16);
      const headline =
        operation === "retry"
          ? `Queue ${blocker} again; ${taskName} follows when it finishes.`
          : operation === "unlink"
            ? `Let ${taskName} continue without ${blocker}.`
            : `Make ${taskName} wait for ${t("replacementTitle", 120) || t("replacement", 64)} instead of ${blocker}.`;
      return card(headline);
    }
    case "agents": {
      const parts = [
        ...(t("risk") === "" ? [] : [`risk ${t("risk", 32)}`]),
        ...(t("role") === ""
          ? []
          : [
              payload["clear"] === true
                ? `${t("role", 32)}: back to the recommendation`
                : `${t("role", 32)}: ${t("provider", 40)} ${t("model", 80)}`,
            ]),
      ];
      return card(
        `Change agents for ${taskName}: ${parts.join("; ")}`,
        [],
        "Changing agents or risk needs renewed approval before work starts.",
      );
    }
    case "scope":
      return card(
        `Rewrite the scope of ${taskName}:`,
        [
          `Goal: ${t("goal", 600)}`,
          ...(t("not") === "" ? [] : [`Not: ${t("not", 300)}`]),
        ],
        "After confirming, the new scope still needs your password approval before work starts.",
      );
    case "answer": {
      const id =
        typeof payload["decision"] === "number" ? payload["decision"] : null;
      const decision = id === null ? null : store.getDecision(id);
      const pick = t("option", 64);
      const irreversible = payload["reversible"] === false;
      const body =
        decision === null
          ? ["(the decision is gone)"]
          : [
              `Q: ${phoneText(decision.question, 400)}`,
              ...decision.options.map(
                (one) =>
                  `${one.id === pick ? "→" : " "} ${phoneText(one.label, 120)}${one.reversible ? "" : lasting}${one.id === decision.recommendation ? " (the builder recommends this)" : ""}: ${phoneText(one.consequence, 300)}`,
              ),
              ...(t("rationale") === "" ? [] : [`Why: ${t("rationale", 300)}`]),
            ];
      return card(
        `Answer decision #${String(id ?? "?")} on ${taskName} with "${t("optionLabel", 120) || pick}"`,
        body,
        irreversible
          ? phone ? "⚠ This choice can't be undone. Confirming asks you once more." : "⚠ This choice is irreversible. Confirming asks you once more."
          : null,
      );
    }
    case "task_action": {
      const operation = payload["operation"];
      const action = isChatTaskAction(operation)
        ? CHAT_TASK_ACTIONS[operation]
        : null;
      const dependency = t("dependencyTitle", 120) || t("dependency", 64);
      if (action === null)
        return handoff(`An unavailable action was proposed for ${taskName}.`);
      return card(
        `${action.label}: ${taskName}${dependency === "" ? "" : ` · ${dependency}`}`,
        [action.detail],
        operation === "resume"
          ? "Confirming only requests the resume. Work resumes after the password step on the task, not from here."
          : null,
      );
    }
    case "review": {
      const revise = payload["operation"] === "revise";
      const snapshot = payload["snapshot"] as
        | {
            notes?: {
              id: number;
              note: string;
              path: string | null;
              line: number | null;
            }[];
          }
        | undefined;
      const selected = Array.isArray(payload["notes"])
        ? (payload["notes"] as number[])
        : [];
      const saved = (snapshot?.notes ?? []).filter((one) =>
        selected.includes(one.id),
      );
      const note = t("note", 1_000);
      const path = t("path", 300);
      return card(
        `${revise ? "Request changes to" : "Save feedback on"} result #${String(payload["run"] ?? "?")} of ${taskName}`,
        [
          ...(note === ""
            ? []
            : [
                `Your feedback${path === "" ? "" : ` (${path}${typeof payload["line"] === "number" ? `:${payload["line"]}` : ""})`}:`,
                ...lines(note, 1_000),
              ]),
          ...(saved.length === 0
            ? []
            : [
                "Saved notes included:",
                ...saved.map(
                  (one) =>
                    `• ${one.path === null ? "" : `${phoneText(one.path, 120)}${one.line === null ? "" : `:${one.line}`}: `}${phoneText(one.note, 300)}`,
                ),
              ]),
        ],
        revise
          ? "Creates a revision of the same task. Its approval follows your settings."
          : "Saves feedback; no work starts.",
      );
    }
    case "cancel":
      return handoff(`Cancel ${taskName}: ${t("reason", 300)}`, [
        "Cancelling is armed on the task itself, never from a card.",
      ]);
    case "control": {
      const control = payload["control"];
      const label = isChatControl(control)
        ? CHAT_CONTROLS[control].label
        : "A console control";
      return handoff(`${label}${taskName === "" ? "" : ` for ${taskName}`}`, [
        "This opens an existing control; nothing changes from here.",
      ]);
    }
    default:
      return handoff(
        "This kind of proposal cannot be confirmed from the phone.",
      );
  }
}

/** The card after it resolves, from the recorded outcome — the same words every surface shows. */
export function proposalOutcomeText(proposal: MateProposal): string {
  const outcome = proposal.outcome as { said?: unknown; via?: unknown } | null;
  const said =
    outcome !== null && typeof outcome.said === "string"
      ? phoneText(outcome.said, 600)
      : "";
  const via =
    outcome !== null && typeof outcome.via === "string"
      ? ` (from ${outcome.via})`
      : "";
  switch (proposal.state) {
    case "confirmed":
      return `✓ Done${via}${said === "" ? "" : `: ${said}`}`;
    case "refused":
      return `✗ Not done${via}${said === "" ? "" : `: ${said}`}`;
    case "dismissed":
      return "Dismissed.";
    case "expired":
      return "This card expired.";
    case "confirming":
      return "Being confirmed elsewhere right now.";
    default:
      return "Still waiting for your confirmation.";
  }
}

// ---- the parity matrix -----------------------------------------------------------

export type ParitySupport = "direct" | "handoff" | "missing";

/**
 * One row per mate tool: how the paired phone reaches it. `direct` means
 * the same engine tool or the same confirm door runs from Telegram;
 * `handoff` means the phone shows where the existing authenticated
 * control lives and does nothing itself; `missing` means no phone path
 * yet. The test suite refuses a tool this table does not name, and the
 * committed matrix document must agree with it line for line.
 */
export const CHAT_ACTION_PARITY: Record<
  string,
  { support: ParitySupport; how: string; gap: string | null }
> = {
  get_brief: {
    support: "direct",
    how: "Reads current tasks, decisions, results and project knowledge from the local database through the shared engine, within the enrolled projects.",
    gap: "Dedicated Telegram and Slack journeys for this tool and live channel rendering remain unverified.",
  },
  get_project_context: {
    support: "direct",
    how: "Reads bounded source excerpts or advisory import impact in an accessible enrolled project through the shared engine, with source-search fallback when its index is unavailable.",
    gap: "Index refresh uses the local CLI. Dedicated Telegram and Slack journeys for this tool and live channel rendering remain unverified.",
  },
  get_action_status: {
    support: "direct",
    how: "Reads the exact saved shared action and its outcome, including completion through secure review.",
    gap: null,
  },
  get_actions: {
    support: "direct",
    how: "Lists the shared action catalogue and required inputs.",
    gap: null,
  },
  propose_action: {
    support: "direct",
    how: "Prepares exact shared skill, knowledge, approval, acceptance, cancel and resume actions (the separate review request was removed on 2026-09-21). Short ordinary changes confirm here; protected or long changes use one secure review and record the result on the same proposal.",
    gap: "Secure review requires a working HTTPS console connection. Real transport verification is required.",
  },
  recap: {
    support: "direct",
    how: "Read by the model during a phone turn over the enrolled ceiling.",
    gap: null,
  },
  list_repos: {
    support: "direct",
    how: "Read during a turn; projects are r1..rN in enrollment order, as on the console.",
    gap: null,
  },
  get_skills: {
    support: "direct",
    how: "Reads the same project skill library, saved selections and enabled versions as the console. Use propose_action for changes and tests.",
    gap: "Skill import and long content require secure review. Folder and GitHub import still use the project Skills screen.",
  },
  get_project_knowledge: {
    support: "direct",
    how: "Read during a turn.",
    gap: null,
  },
  get_models: { support: "direct", how: "Read during a turn: default agents with the exact model each runs, CLI versions and new models. Changes use the labelled Settings → Models page.", gap: null },
  get_diff: { support: "direct", how: "Read during a turn: the exact result's changed files, then one file's diff, so a requested change names the right file and line.", gap: null },
  get_check_log: { support: "direct", how: "Read during a turn: the end of the exact result's check log, a page of it, or the lines matching a search.", gap: null },
  get_project_tools: { support: "direct", how: "Read during a turn: a project's tools, the common tools list and servers found on the computer. Adding one is a secure-review card; secrets are set only on the console's Tools page.", gap: null },
  get_task_conversation: { support: "direct", how: "Read during a turn: what the person and the lead said in one task's own chat, including what was confirmed there.", gap: null },
  get_flows: { support: "direct", how: "Read during a turn: a person's flows, each one's steps in order and its cards — where each card is, what it waits on, whether it needs them, its owner and its discussion.", gap: null },
  get_teammates: { support: "direct", how: "Read during a turn: the project's AI teammates, their soul files, the zones they work, what they did today and the questions they're waiting on.", gap: null },
  propose_teammate: { support: "direct", how: "Adds a teammate from a template or a soul file, changes one section of its soul file (or the whole short file), pauses, resumes or removes it, passes it a note, or answers its question for the person asked, through the shared confirm door.", gap: "Soul files longer than one message are edited on the console's teammate page; the phone changes one section at a time." },
  get_flow_insights: { support: "direct", how: "Read during a turn: where each flow's cards pass, fail or are sent back, how long they wait, how its scripts did, and a run's log.", gap: null },
  propose_flow: { support: "direct", how: "Creates or changes a flow, adds, moves, approves, sends back or cancels its cards, comments on them (@name pings that person), sets their owner, follows them, saves the project's scripts, and adds, pauses or removes its triggers, through the shared confirm door; a long drawing opens the secure review. Work a card files is an ordinary task under the usual approvals.", gap: "The flow canvas itself is on the console; the phone confirms cards but draws nothing. Webhook addresses and the Linear key are set on the console's Triggers panel." },
  commit_to: { support: "direct", how: "Records what the lead promised to follow up on (a task, attempt, check or time; 7 days at most). The follow pass says one line when it is met, in the shared conversation and on the chat the promise was made on.", gap: null },
  release_commitment: { support: "direct", how: "Stops following up on one of the person's open promises, with the reason.", gap: null },
  remember: { support: "direct", how: "Proposes a correction or lasting preference as a decision, project instruction or about-you card, through the shared confirm door; an about-you card shows the line it replaces.", gap: null },
  get_person: { support: "direct", how: "Read during a turn: one person, AI teammate or team chat in full, with their open tasks.", gap: null },
  get_integrations: { support: "direct", how: "Read during a turn: which chat apps, email, GitHub, project tools and monitoring are Connected, Not set up or Broken, as Settings → Integrations shows them.", gap: null },
  get_capabilities: { support: "direct", how: "Read during a turn: which agents are signed in, which workers are online, which tools and skills work, which integrations are connected and what checks the project runs, each with its next step and settings link.", gap: null },
  ask_owner: { support: "direct", how: "One question with 2-4 options and Something else, drawn as buttons under the reply; the tapped option is sent as the person's next message.", gap: null },
  search_project_memory: { support: "direct", how: "Read during a turn: one search over decisions, references, lessons and the conversations the person may read.", gap: null },
  list_tasks: { support: "direct", how: "Read during a turn.", gap: null },
  get_task: {
    support: "direct",
    how: "Read during a turn; a reply to a result message pins the exact execution.",
    gap: null,
  },
  get_agents: { support: "direct", how: "Read during a turn.", gap: null },
  list_decisions: { support: "direct", how: "Read during a turn.", gap: null },
  get_decision: { support: "direct", how: "Read during a turn.", gap: null },
  queue: { support: "direct", how: "Read during a turn.", gap: null },
  get_result: {
    support: "direct",
    how: "Read during a turn; the phone card shows the verification verdict, never a local link.",
    gap: "Secure remote evidence links are not delivered to the phone; a result's screenshots travel through get_result_images.",
  },
  get_result_images: {
    support: "direct",
    how: "Read during a turn; every verified original PNG/JPEG the turn selected (at most 8 per reply, the rest by offset or image id) is sent as a document with a short safe caption after the reply, re-verified before each upload, and a reply to an image binds that exact task and run.",
    gap: "An image whose record or bytes fail verification, or one Telegram refuses, is named in the chat rather than sent, through the same durable retried part; the operator opens the exact result in the console. Fixture proof only, no physical-phone rendering.",
  },
  get_controls: { support: "direct", how: "Read during a turn.", gap: null },
  get_acceptance_evidence: {
    support: "direct",
    how: "Shared read-only acceptance packet: exact result, criterion states, gate, reviewer findings, caveats and recorded human acceptance. Screenshot files use get_result_images; marking complete is a propose_action result_accept confirmed behind the phone's own yes/cancel challenge or on the signed-in console.",
    gap: "A physical-phone completion has not been exercised.",
  },
  offer_approval: {
    support: "direct",
    how: "Pushes the plan's or flow card's own decision card to the owner's paired chat: Approve arms Yes and Cancel, and only the owner's Yes decides, through sealScopeApproval (as a chat-origin approval) or decideFlowCard. Outside the owner's chat-approval setting or a decision's rules it answers why, and the lead opens the console control.",
    gap: "A flow card's Send back, Edit and a Person chooses step act from the pushed card; a plan's Send back stays in the console. Fixture proof only, no physical-phone rendering.",
  },
  show_control: {
    support: "handoff",
    how: "The card names the control and the task, with one url button to that exact console control when a trusted https console-url is configured; the button opens the signed-in console and acts on nothing.",
    gap: "Incomplete phone action: the control itself runs in the console, after sign-in.",
  },
  propose_task: {
    support: "direct",
    how: "Card with Confirm/Dismiss through confirmMateProposal (filed as a mate proposal, via telegram). The confirmed card links Review & start for the filed task while its scope waits; under a signed automatic mode it says the scope is approved and links the task.",
    gap: "Under manual approval the password step happens in the console, reached from the card's button.",
  },
  propose_scope: {
    support: "direct",
    how: "Confirm rewrites the scope through the shared door; the confirmed card links Review & start for the exact task.",
    gap: "Approving the rewritten scope needs the password, in the console.",
  },
  propose_next: {
    support: "direct",
    how: "Confirm through the shared door with the queue revision it saw.",
    gap: null,
  },
  propose_reserve: {
    support: "direct",
    how: "Confirm through the shared door.",
    gap: null,
  },
  propose_agents: {
    support: "direct",
    how: "Confirm through the shared route-edit door; when the change stales the approval, the confirmed card links Review & start for the exact task.",
    gap: "Renewed approval after the route change happens in the console.",
  },
  propose_hold: {
    support: "direct",
    how: "Confirm through the shared door.",
    gap: null,
  },
  propose_unhold: {
    support: "direct",
    how: "Confirm through the shared door.",
    gap: null,
  },
  propose_steer: {
    support: "direct",
    how: "Confirm through the shared door; the guidance is shown verbatim on the card.",
    gap: null,
  },
  propose_dependency_repair: {
    support: "direct",
    how: "Confirm retry/unlink/replace through the shared door with both projects re-checked.",
    gap: null,
  },
  propose_task_action: {
    support: "direct",
    how: "stop, retry, plan, wait_for and stop_waiting confirm through the shared door (a stop is audited via telegram); resume confirms only the request, says nothing has resumed, and links the task where the password step lives.",
    gap: "resume completes in the console (incomplete phone action).",
  },
  propose_answer: {
    support: "direct",
    how: "Confirm answers through the shared door, audited via telegram; an irreversible option arms a second tap first.",
    gap: null,
  },
  propose_review: {
    support: "direct",
    how: "note saves feedback; revise creates the same-family revision through the shared result service, honouring automatic approval settings; the confirmed card links Review & start for the revision while it waits, or the task once approved.",
    gap: "Under manual approval the revision is approved in the console, reached from the card's button; under a signed automatic-approval mode it runs unattended.",
  },
  propose_cancel: {
    support: "handoff",
    how: "The door refuses cancel from any card; the card links the exact task's Cancel control when a trusted https console-url is configured, and the cancel is armed there.",
    gap: "Incomplete phone action: no phone path to cancel by design; the button only opens the task.",
  },
};

/** Every tool the model can call, mapped; a new tool must name its phone road. */
export function parityGaps(): string[] {
  return MATE_TOOL_SCHEMAS.map((tool) => tool.name).filter(
    (name) => CHAT_ACTION_PARITY[name] === undefined,
  );
}

export function handoffCardText(text: string, note: string | null): string {
  return note === null ? text : `${text}\n\n${note}`;
}

/**
 * The resolved card, from what is RECORDED about the task the outcome
 * names — never from a word search over the door's sentence. A scope that
 * still waits for approval has one next action: approve it (the button, or
 * the console on the computer when no link exists). A scope approved under
 * a signed mode asks for nothing more. A staged resume says what remains.
 */
export function confirmedCardText(
  store: Store,
  outcome: DoorOutcome,
  proposal: MateProposal,
  note: string | null,
): string {
  const said = phoneText(outcome.said, 600);
  if (!outcome.ok) return `✗ Not done: ${said}`;
  const taskId = outcome.taskId;
  const resume =
    proposal.kind === "task_action" &&
    proposal.payload["operation"] === "resume";
  const revise =
    proposal.kind === "review" && proposal.payload["operation"] === "revise";
  const staged =
    proposal.kind === "task" ||
    proposal.kind === "scope" ||
    proposal.kind === "agents" ||
    resume ||
    revise;
  if (!staged || taskId === null) return `✓ ${said}`;
  const state = approvalState(store, taskId);
  const approval = state === "waiting";
  // The door's sentence carries an approval instruction for a filed task or
  // a revision; under a signed automatic mode the recorded scope is already
  // approved, and the card says that instead of asking again.
  const words =
    proposal.kind === "task" && state === "approved"
      ? `${said.split(" — ")[0]} — approved under your automatic approval settings; nothing more is needed from you.`
      : revise && state === "approved"
        ? "Revision created under your automatic approval settings."
        : said;
  const next = resume
    ? "Nothing has resumed yet: the password step on the task finishes it."
    : approval && note !== null
      ? "Approve it in Toolroll on the computer."
      : "";
  const setup = (approval || resume) && note !== null ? note : "";
  return [`✓ ${words}`, ...[next, setup].filter((one) => one !== "")].join(
    "\n\n",
  );
}
