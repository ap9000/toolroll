/**
 * The quick-answer router (docs/plans/responsive-chat.md §8, owner decision 7): which model answers a reply, decided
 * before the turn, deterministically and conservatively. A reply goes to the faster model only when quick answers are
 * on, the lead runs on the Claude membership, the organisation policy allows that model, the message carries no task
 * or reply context, it doesn't answer the lead's own open question, and it reads as a status or read question with no
 * act word. Everything else stays on the main model, unchanged.
 *
 * A quick reply is read-only by construction: its requests advertise only QUICK_READ_TOOLS (and find_tools, the way to
 * ask for more). A quick step that asks for anything else has its calls discarded unrun, and the main model takes the reply over from that step (lead.ts).
 */
import { aliasTarget } from "./model-catalog.js";
import { exactModelId } from "./phase-routing.js";
import { SONNET } from "./model-choices.js";
import type { LeadRoute } from "./lead-latency-schema.js";
import type { Store } from "./store.js";

/** Words that ask for something to be done (§8's fixed list, plus a few plain synonyms). Any of them keeps a message on
 * the main model. Matched as whole words in their plain form, the form a request takes ("fix it", "can you merge",
 * "file a task"): "what's running?" or "is it merged?" ask about a state and stay quick. A quick step that asks to act
 * anyway is escalated (quickStepEscalates), so this list is the first line, not the only one. */
export const QUICK_ACT_WORDS: readonly string[] = Object.freeze([
  "file", "make", "create", "add", "fix", "change", "build", "plan", "approve", "confirm", "merge", "release", "ship",
  "deploy", "cancel", "pause", "hold", "resume", "retry", "steer", "remember", "delete", "archive", "send", "run",
  "start", "stop",
  // Plain synonyms of the same acts.
  "rerun", "redo", "undo", "revert", "push", "publish", "kill", "edit", "remove", "rename", "reset", "restart",
  "install", "upgrade", "enable", "disable", "accept", "reject", "schedule", "assign", "write", "draft", "set", "move",
  "close", "reopen", "unhold", "dismiss", "prioritize", "prioritise", "split", "revise",
]);

/** Openings that ask about the state of things. */
const ASKING_OPENINGS = new Set([
  "what", "what's", "whats", "which", "who", "who's", "whose", "why", "when", "where", "how", "how's", "is", "are", "was",
  "were", "did", "does", "do", "has", "have", "had", "any", "anything", "show", "list", "status", "tell", "give",
]);

/** The longest message the quick model takes: longer ones are rarely a plain status question. */
export const QUICK_MESSAGE_MAX_CHARS = 240;

const words = (text: string): string[] => text.toLowerCase().replace(/[’]/g, "'").split(/[^a-z0-9']+/).filter(one => one !== "");

/** Whether a message reads as a status or read question with no act word (§8's message rule). */
export function quickQuestion(message: string): boolean {
  const text = message.trim();
  if (text === "" || text.length > QUICK_MESSAGE_MAX_CHARS || /[\r\n]/.test(text)) return false;
  const all = words(text);
  if (all.length === 0) return false;
  if (all.some(word => QUICK_ACT_WORDS.includes(word.replace(/'s$/, "")))) return false;
  // A negated or conditional request ("don't…", "if…, then…") is a judgement call: the main model takes it.
  if (all.some(word => word === "don't" || word === "dont" || word === "if" || word === "please")) return false;
  return text.endsWith("?") || ASKING_OPENINGS.has(all[0]!);
}

/**
 * The tools a quick reply's requests advertise: reads only. Every one is a read of saved state as this person sees it;
 * none drafts, records a question, a promise, a memory or a card, or opens a page. `find_tools` is advertised beside them
 * but is not one of them: it is how a quick step says it needs something else ("search before saying something can't
 * be done"), so calling it hands the reply to the main model, unrun (more conservative than §8's "find_tools for
 * something to change": any search escalates).
 */
export const QUICK_READ_TOOLS: ReadonlySet<string> = new Set([
  "get_brief", "get_project_context", "get_code_map", "get_project_activity", "get_actions", "get_action_status", "get_skills",
  "get_acceptance_evidence", "recap", "list_repos", "list_tasks", "get_task", "get_result", "get_result_images", "get_controls",
  "get_agents", "get_project_knowledge", "get_flaky_tests", "get_task_conversation", "get_diff", "get_check_log",
  "get_project_tools", "get_flows", "get_flow_insights", "list_decisions", "get_decision", "queue",
  "get_findings", "get_subagents", "get_person", "get_integrations", "get_capabilities", "search_project_memory", "get_models", "get_sweep",
]);

/** Whether a quick step's request advertises this tool: the reads, and find_tools as the way to ask for more. */
export function quickAdvertises(name: string): boolean {
  return QUICK_READ_TOOLS.has(name) || name === "find_tools";
}

/** The faster model, as the model catalog names it: the newest Sonnet this computer's Claude has been seen to run, else
 * the compiled current one. Always an exact id, never an alias that could move under a recorded route. */
export function quickLeadModel(store: Store): string {
  const seen = aliasTarget(store, "sonnet")?.id ?? null;
  return seen !== null && exactModelId(seen) ? seen : SONNET;
}

export type QuickRouteInput = {
  /** Settings → Lead's switch. */
  enabled: boolean;
  provider: string;
  /** The configured model, which a quick reply would otherwise run on. */
  mainModel: string;
  message: string;
  /** Server-authored context for this turn (a task page, a crew update): present keeps the main model. */
  hasContext: boolean;
  /** The message replies to an image (a result's screenshot). */
  hasReplyImage: boolean;
  /** The thread's newest reply asked the owner a question. */
  askOpen: boolean;
  /** The faster model, and whether the organisation policy allows it. */
  quickModel: string;
  quickAllowed: boolean;
};

/** Which model answers: the faster one only when every condition holds. */
export function quickRoute(input: QuickRouteInput): { route: Extract<LeadRoute, "fast">; model: string } | { route: Extract<LeadRoute, "default"> } {
  if (!input.enabled || input.provider !== "claude-subscription" || !input.quickAllowed) return { route: "default" };
  if (input.quickModel === input.mainModel || input.hasContext || input.hasReplyImage || input.askOpen) return { route: "default" };
  return quickQuestion(input.message) ? { route: "fast", model: input.quickModel } : { route: "default" };
}

/** Whether a quick step asked for anything beyond the quick reads: its calls are then discarded unrun (§8). */
export function quickStepEscalates(calls: readonly { name: string }[]): boolean {
  return calls.some(call => !QUICK_READ_TOOLS.has(call.name));
}

/** "Sonnet 5.5" for claude-sonnet-5-5; the id itself for anything else. */
export function modelName(model: string): string {
  if (model === "default") return "the main model";
  const family = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/.exec(model);
  if (family !== null) return `${family[1]!.charAt(0).toUpperCase()}${family[1]!.slice(1)} ${family[2]}${family[3] === undefined ? "" : `.${family[3]}`}`;
  if (/^(opus|sonnet|haiku|fable)$/.test(model)) return `${model.charAt(0).toUpperCase()}${model.slice(1)}`;
  return model;
}

/** The activity line's words for a routed reply: "answered by Sonnet 5.5", "moved to Opus"; nothing for the default. */
export function routeWords(route: LeadRoute, quickModel: string, mainModel: string): string | null {
  if (route === "fast") return `answered by ${modelName(quickModel)}`;
  if (route === "escalated") return `moved to ${modelName(mainModel)}`;
  return null;
}
