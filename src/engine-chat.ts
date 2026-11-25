/**
 * The engine API's Lead chat read (`GET /engine/chat`, contracts/engine-api.ts): the same central Lead conversation
 * `/chat` renders, projected as structured plain text, validated `ChatCard` blocks, and confirmable proposals — never
 * raw HTML. Every internal task link is parsed from Toolroll's own fixed routes so a terminal client can jump its Peek
 * inspector straight to that task and tab without ever guessing from model prose.
 */
import { CHAT_ACTIONS, sharedActionNeedsReview, sharedActionPayload, sharedActionReviewPath } from "./chat-actions.js";
import { cardOfProposal, cardPlainOf, cardsFirst, isCardProposal } from "./chat-card.js";
import { CHAT_CONTROLS, chatControlHref, isChatControl } from "./chat-controls.js";
import { CHAT_TASK_ACTIONS, isChatTaskAction } from "./chat-task-actions.js";
import { isCheckLevel } from "./check-levels.js";
import { ENGINE_API_VERSION, type LeadChat, type LeadChatCard, type LeadChatLink } from "./contracts/engine-api.js";
import { closedQuestionReason } from "./decision.js";
import { FLOW_HREF } from "./flow-engine.js";
import { PROPOSAL_WAIT_REASON } from "./lead-doors.js";
import type { LeadQueueRow } from "./lead-queue.js";
import { parseFeedbackImage } from "./result-review.js";
import { shapeReply } from "./reply-shape.js";
import { taskHref } from "./server/http.js";
import type { Decision, LeadAsk, LeadMessage, LeadProposal, LeadTurn } from "./store.js";

const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Parse a fixed internal Toolroll path into a task + preferred detail tab for the terminal Peek inspector. */
export function parseLeadLink(label: string, href: string): LeadChatLink {
  const clean = href.split("#")[0] ?? href;
  const [pathname = "", query = ""] = clean.split("?");
  const params = new URLSearchParams(query);
  // `/t/<id>`, `/t/<id>/steps`, `/t/<id>/diff`, `/t/<id>/evidence`
  if (pathname.startsWith("/t/")) {
    const parts = pathname.slice(3).split("/").filter(Boolean);
    const id = parts[0] ? decodeSafe(parts[0]) : null;
    if (id !== null && TASK_ID_RE.test(id)) {
      const sub = parts[1] ?? null;
      const tab = sub === "diff" ? "diff" : sub === "steps" ? "steps" : null;
      return { label, href, task: id, tab };
    }
  }
  // `/chat?task=<id>[&result=<run>]`
  if (pathname === "/chat") {
    const id = params.get("task");
    if (id !== null && TASK_ID_RE.test(id)) {
      const tab = params.has("result") ? "diff" : null;
      return { label, href, task: id, tab };
    }
  }
  return { label, href, task: null, tab: null };
}

function decodeSafe(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

const sentence = (words: string): string => (words === "" ? "" : words.charAt(0).toUpperCase() + words.slice(1));

function proposalLinesOf(
  proposal: LeadProposal,
  decision: Decision | null,
): { label: string; action: string; lines: string[]; irreversible: boolean } {
  const payload = proposal.payload;
  const text = (key: string): string => (typeof payload[key] === "string" ? (payload[key] as string) : "");
  const task = text("task");
  const repoId = text("repoId");
  const lines: string[] = [];
  const push = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed !== "") lines.push(trimmed);
  };
  const fact = (key: string, value: string): void => {
    const trimmed = value.trim();
    if (trimmed !== "") lines.push(`${key}: ${trimmed}`);
  };
  const presentations: Record<LeadProposal["kind"], { label: string; action: string }> = {
    task: { label: payload["report"] === true ? "Scout investigation" : "New task", action: "File task" },
    next: { label: "Queue priority", action: "Move to front" },
    reserve: { label: "Worker assignment", action: payload["worker"] === null ? "Release" : "Reserve" },
    hold: { label: "Pause work", action: "Hold" },
    unhold: { label: "Resume work", action: "Release hold" },
    steer: { label: "Guidance for the agent", action: "Add guidance" },
    scope: { label: "Plan change", action: "Save plan" },
    answer: { label: "Decision answer", action: "Confirm answer" },
    cancel: { label: "Cancel task", action: "Open task" },
    repair: {
      label: "Task is waiting",
      action: text("operation") === "retry" ? "Try again" : text("operation") === "replace" ? "Wait for another task" : "Continue without it",
    },
    agents: { label: "Agents change", action: "Change agents" },
    review: { label: text("operation") === "revise" ? "Changes to make" : "Note for later", action: text("operation") === "revise" ? "Send back" : "Save for later" },
    control: { label: "Open control", action: "Open" },
    action: { label: text("title") || "Review action", action: sharedActionPayload(payload) ? sentence(CHAT_ACTIONS[sharedActionPayload(payload)!.operation].label) : "Unavailable" },
    task_action: {
      label: payload["operation"] === "stop" ? "Stop task?" : payload["operation"] === "resume" ? "Resume task?" : "Task update",
      action: isChatTaskAction(payload["operation"]) ? sentence(CHAT_TASK_ACTIONS[payload["operation"]].label) : "Unavailable",
    },
  };
  const presentation = presentations[proposal.kind];
  let irreversible = false;

  if (proposal.kind === "task") {
    push(text("title"));
    push(text("goal"));
    fact("project", repoId);
    fact("deliverable", payload["report"] === true ? "report only" : "branch");
    const checks = payload["checks"];
    if (isCheckLevel(checks)) {
      fact("checks", { quick: "Quick checks", full: "Full checks", off: "Off — built, not checked" }[checks]);
    }
    fact("out of scope", text("not"));
    if (Array.isArray(payload["touches"]) && payload["touches"].length > 0) {
      fact("may touch", (payload["touches"] as unknown[]).map(String).join(", "));
    }
  } else if (proposal.kind === "action") {
    const action = sharedActionPayload(payload);
    if (action === null) push("This action is unavailable.");
    else if (action.operation === "task_start") {
      push(action.title);
      fact("project", action.repo.split(/[\\/]/).filter(Boolean).at(-1) ?? action.repo);
    } else if (!sharedActionNeedsReview(action)) {
      for (const term of action.terms) push(term);
    } else {
      push("Full terms and confirmation are shown on the review screen.");
    }
  } else if (proposal.kind === "task_action") {
    const op = payload["operation"];
    push(text("taskTitle") || task);
    if (op === "stop" || op === "resume") push(`${task} · Run #${String(payload["run"] ?? "?")}`);
    push(isChatTaskAction(op) ? CHAT_TASK_ACTIONS[op].detail : "Action unavailable.");
    push(text("dependencyTitle"));
  } else if (proposal.kind === "control") {
    const control = payload["control"];
    push(isChatControl(control) ? CHAT_CONTROLS[control].label : "Control unavailable");
    push(text("taskTitle"));
  } else if (proposal.kind === "review") {
    push(text("taskTitle") || task);
    const snapshot = payload["snapshot"] as import("./chat-review.js").ReviewSnapshot | undefined;
    const ids = Array.isArray(payload["notes"]) ? (payload["notes"] as number[]) : [];
    const selected = snapshot?.notes.filter(one => ids.includes(one.id)) ?? [];
    const notes = [
      ...selected,
      ...(text("note") === ""
        ? []
        : [{ note: text("note"), path: text("path") || null, line: typeof payload["line"] === "number" ? payload["line"] : null, image: parseFeedbackImage(payload["image"]) || null }]),
    ];
    for (const one of notes) {
      const where = one.path === null ? "" : `${one.path}${one.line === null ? "" : `:${one.line}`} — `;
      push(`${where}${one.note}`);
    }
    push(text("operation") === "revise" ? "Updates this task. Your approval settings apply." : "No work starts.");
  } else if (proposal.kind === "next") {
    push(`Move ${task} to the front`);
    fact("position", `${String(payload["position"] ?? "?")} of ${String(payload["of"] ?? "?")}`);
    fact("project", repoId);
  } else if (proposal.kind === "reserve") {
    push(`${payload["worker"] === null ? "Release" : "Reserve"} ${task}`);
    fact("destination", payload["worker"] === null ? "shared queue" : text("worker"));
    fact("project", repoId);
  } else if (proposal.kind === "hold") {
    push(`Hold ${task}`);
    push(text("reason"));
    fact("project", repoId);
  } else if (proposal.kind === "unhold") {
    push(`Release ${task} from its hold`);
    fact("project", repoId);
  } else if (proposal.kind === "steer") {
    const title = text("taskTitle") || task;
    const mode = payload["mode"];
    if (mode === "pause") push(`Pause ${title}`);
    else if (mode === "resume") push(`Resume ${title}`);
    else if (mode === "pause-and-steer") {
      push(`Pause ${title} and send a note`);
      push(text("note"));
    } else {
      push(`Guidance for ${title}`);
      push(text("note"));
    }
    fact("project", repoId);
  } else if (proposal.kind === "agents") {
    const title = text("taskTitle") || task;
    const role = text("role");
    const clear = payload["clear"] === true;
    const agentWords = text("provider") === "" ? "" : `${text("provider")} · ${text("model")}`;
    push(role !== "" && !clear ? `Run ${title}'s ${role} on ${agentWords}` : `Change agents for ${title}`);
    push(text("why"));
    fact("agents now", text("before"));
    fact("project", repoId);
  } else if (proposal.kind === "scope") {
    push(`Rewrite ${task}`);
    push(text("goal"));
    fact("out of scope", text("not"));
    if (Array.isArray(payload["touches"]) && payload["touches"].length > 0) {
      fact("may touch", (payload["touches"] as unknown[]).map(String).join(", "));
    }
    fact("project", repoId);
  } else if (proposal.kind === "repair") {
    const op = text("operation");
    const title = text("taskTitle") || task;
    const blocker = text("blockerTitle") || text("blocker");
    const replacement = text("replacementTitle") || text("replacement");
    if (op === "retry") push(`Try ${blocker} again`);
    else if (op === "replace") push(`Have ${title} wait for ${replacement} instead`);
    else push(`Let ${title} continue without ${blocker}`);
    fact("project", repoId);
  } else if (proposal.kind === "answer") {
    irreversible = payload["reversible"] === false;
    const decisionId = typeof payload["decision"] === "number" ? payload["decision"] : 0;
    push(`Answer decision #${decisionId} on ${task}`);
    if (decision !== null) {
      push(decision.question);
      const pick = text("option");
      for (const opt of decision.options) {
        const tags = [
          opt.reversible ? "" : "irreversible",
          opt.id === decision.recommendation ? "builder recommends" : "",
          opt.id === pick ? "proposed" : "",
        ].filter(Boolean);
        push(`• ${opt.label}${tags.length === 0 ? "" : ` (${tags.join(", ")})`} — ${opt.consequence}`);
      }
    } else {
      push("The decision is gone.");
    }
    fact("proposed answer", text("optionLabel"));
    push(text("rationale"));
  } else {
    push(`Cancel ${task}`);
    push(text("reason"));
    fact("project", repoId);
  }

  return { label: presentation.label, action: presentation.action, lines, irreversible };
}

function projectLeadCard(proposal: LeadProposal, inert: boolean, decision: Decision | null): LeadChatCard {
  const payload = proposal.payload;
  const text = (key: string): string => (typeof payload[key] === "string" ? (payload[key] as string) : "");
  const task = text("task");

  if (proposal.kind === "answer" && decision?.supersededReason != null) {
    return {
      id: proposal.id,
      kind: proposal.kind,
      label: "Question closed",
      state: proposal.state as LeadChatCard["state"],
      data: false,
      lines: [decision.question, closedQuestionReason(decision.supersededReason)],
      card: null,
      said: null,
      note: null,
      primary: null,
      dismissable: false,
      links: [],
    };
  }

  if (isCardProposal(proposal)) {
    const shown = cardOfProposal(proposal);
    const links = shown?.buttons.map(one => parseLeadLink(one.label, one.path)) ?? [];
    return {
      id: proposal.id,
      kind: proposal.kind,
      label: shown?.title ?? "Card",
      state: "pending",
      data: true,
      lines: shown === null ? [cardPlainOf(proposal)] : [],
      card: shown,
      said: null,
      note: null,
      primary: null,
      dismissable: false,
      links,
    };
  }

  if (proposal.kind === "control") {
    const control = payload["control"];
    if (isChatControl(control) && proposal.state === "pending" && !inert) {
      const title = text("taskTitle");
      const label = CHAT_CONTROLS[control].label;
      const href = chatControlHref(control, task, payload["run"], payload["project"]);
      const parsed = parseLeadLink(label, href);
      return {
        id: proposal.id,
        kind: proposal.kind,
        label: title === "" ? label : title,
        state: "pending",
        data: false,
        lines: title === "" ? [] : [title],
        card: null,
        said: null,
        note: null,
        primary: { kind: "link", label, href, task: parsed.task, tab: parsed.tab },
        dismissable: false,
        links: [parsed],
      };
    }
  }

  const { label, action, lines, irreversible } = proposalLinesOf(proposal, decision);
  const outcome = proposal.outcome as { said?: unknown; taskId?: unknown; href?: unknown } | null;
  const said = outcome !== null && typeof outcome.said === "string" ? outcome.said : null;
  const filedTask = outcome !== null && typeof outcome.taskId === "string" ? outcome.taskId : null;
  const flowHref = proposal.state === "confirmed" && outcome !== null && typeof outcome.href === "string" && FLOW_HREF.test(outcome.href) ? outcome.href : null;
  const reviewAction = proposal.kind === "action" ? sharedActionPayload(payload) : null;
  const pending = proposal.state === "pending" && !inert;

  let primary: LeadChatCard["primary"] = null;
  if (pending) {
    if (reviewAction !== null && sharedActionNeedsReview(reviewAction)) {
      const href = sharedActionReviewPath(proposal.id);
      const parsed = parseLeadLink(reviewAction.operation === "task_start" ? "Review and start" : "Review action", href);
      primary = { kind: "link", label: parsed.label, href: parsed.href, task: parsed.task, tab: parsed.tab };
    } else if (proposal.kind === "control") {
      if (isChatControl(payload["control"])) {
        const href = chatControlHref(payload["control"], task, payload["run"], payload["project"]);
        const parsed = parseLeadLink(CHAT_CONTROLS[payload["control"]].label, href);
        primary = { kind: "link", label: parsed.label, href: parsed.href, task: parsed.task, tab: parsed.tab };
      }
    } else if (proposal.kind === "cancel") {
      const href = taskHref(task);
      const parsed = parseLeadLink("Open task", href);
      primary = { kind: "link", label: parsed.label, href: parsed.href, task: parsed.task, tab: parsed.tab };
    } else {
      primary = {
        kind: "confirm",
        label: sentence(action),
        irreversible,
        native: proposal.kind === "task_action" && payload["operation"] === "resume",
      };
    }
  }

  const links: LeadChatLink[] = [];
  if (proposal.state === "confirmed") {
    if (filedTask !== null) {
      links.push(parseLeadLink(proposal.kind === "task" ? "Open the new task" : "Open the task", taskHref(filedTask)));
    }
    if (flowHref !== null) {
      links.push(parseLeadLink("Open the flow", flowHref));
    }
  } else if (task !== "" && TASK_ID_RE.test(task)) {
    links.push(parseLeadLink(`Peek ${task}`, taskHref(task)));
  }

  const note = proposal.state === "pending" && inert
    ? PROPOSAL_WAIT_REASON
    : pending && proposal.kind === "cancel"
      ? "Cancelling is confirmed on the task itself."
      : proposal.state === "dismissed"
        ? "Dismissed."
        : proposal.state === "expired"
          ? "Expired — this conversation moved on."
          : null;

  return {
    id: proposal.id,
    kind: proposal.kind,
    label,
    state: proposal.state as LeadChatCard["state"],
    data: false,
    lines,
    card: null,
    said: proposal.state === "confirmed" || proposal.state === "refused" ? said : null,
    note,
    primary,
    dismissable: pending && proposal.kind !== "control",
    links,
  };
}

export type LeadChatReadInput = {
  room: string;
  session: number | null;
  leadName: string;
  canSend: boolean;
  problem: string | null;
  project: string | null;
  messages: LeadMessage[];
  proposals: LeadProposal[];
  decisions: Map<number, Decision>;
  pending: LeadTurn | null;
  ask: LeadAsk | null;
  staleAsk?: number | null;
  asks: Map<number, LeadAsk>;
  queue?: Map<number, LeadQueueRow>;
};

/** Project the central Lead conversation into the typed `LeadChat` engine contract. */
export function leadChatOf(input: LeadChatReadInput): LeadChat {
  const inert = input.pending !== null;
  const openAskTurn = inert ? null : input.ask?.turn ?? null;

  // Map each assistant reply to the operator message it answered so reply-shaping matches `/chat`.
  const askedBy = new Map<number, string>();
  let lastAsked: string | undefined;
  for (const m of input.messages) {
    if (m.role === "operator") lastAsked = m.text;
    else if (lastAsked !== undefined) askedBy.set(m.id, lastAsked);
  }

  let pendingProposals = 0;
  const messages: LeadChat["messages"] = input.messages.map(m => {
    const cards: LeadChatCard[] = m.role === "operator" || m.turn === null
      ? []
      : cardsFirst(input.proposals.filter(p => p.turn === m.turn)).map(p => {
          const decision = typeof p.payload["decision"] === "number" ? input.decisions.get(p.payload["decision"]) ?? null : null;
          const card = projectLeadCard(p, inert, decision);
          if (!card.data && card.state === "pending" && card.primary?.kind === "confirm") {
            pendingProposals += 1;
          }
          return card;
        });
    const rawAsk = m.role === "assistant" && m.turn !== null ? input.asks.get(m.turn) ?? null : null;
    const ask = rawAsk === null
      ? null
      : {
          turn: rawAsk.turn,
          question: rawAsk.question,
          options: [...rawAsk.options],
          open: rawAsk.turn === openAskTurn,
          stale: rawAsk.turn === input.staleAsk,
        };
    const text = m.role === "assistant"
      ? shapeReply(m.text, askedBy.has(m.id) ? { asked: askedBy.get(m.id)! } : {})
      : m.text;
    return {
      id: m.id,
      role: m.role,
      text,
      activity: m.activity,
      createdAt: m.createdAt,
      cards,
      ask,
    };
  });

  const queued: LeadChat["queued"] = [];
  if (input.queue !== undefined) {
    const textById = new Map(input.messages.map(m => [m.id, m.text]));
    for (const row of input.queue.values()) {
      const status: LeadChat["queued"][number]["status"] | null =
        row.status === "queued" ? "queued"
        : row.status === "running" && row.turnId === null ? "starting"
        : row.status === "cancelled" ? "cancelled"
        : row.status === "failed" ? "failed"
        : row.status === "uncertain" ? "uncertain"
        : null;
      if (status === null) continue;
      const detail = status === "queued"
        ? (row.error?.startsWith("Waiting: ") ? row.error.slice("Waiting: ".length) : "Waiting for your earlier messages…")
        : status === "starting"
          ? null
          : row.error ?? (status === "uncertain" ? "Delivery could not be confirmed. Nothing was sent again." : "It was not sent.");
      queued.push({ id: row.message, text: textById.get(row.message) ?? "", status, detail });
    }
  }

  return {
    version: ENGINE_API_VERSION,
    room: input.room,
    session: input.session,
    leadName: input.leadName,
    canSend: input.canSend,
    problem: input.problem,
    project: input.project,
    busy: inert,
    pendingProposals,
    queued,
    messages,
  };
}
