/** Live progress of one lead turn (chat streaming): what the lead is doing
 * and the reply as it is written. Nothing here is durable or authoritative —
 * the finished turn's saved message and cards remain the record. */

export type LeadProgress =
  | { kind: "started"; turn: number }
  | { kind: "step"; turn: number; step: number }
  | { kind: "tool"; turn: number; step: number; id: string; label: string }
  | { kind: "tool-result"; turn: number; step: number; id: string; outcome: LeadToolOutcome }
  | { kind: "text"; turn: number; step: number; text: string };

export type LeadToolOutcome = { state: "succeeded" } | { state: "failed"; reason: string };
export type LeadLiveTool = { id: string; label: string } & ({ state: "running" } | LeadToolOutcome);
/** Keep tools as labels for older clients; toolCalls adds per-call outcomes. */
export type LeadLiveStep = { tools: string[]; toolCalls: LeadLiveTool[]; text: string };

/** Plain words for each tool the lead uses, as the person watching reads them. */
const TOOL_LABELS: Record<string, string> = {
  get_brief: "Catching up on your work",
  get_project_context: "Reading the project",
  get_action_status: "Checking an action",
  get_actions: "Checking available actions",
  get_controls: "Checking the controls",
  get_result: "Reading the result",
  get_diff: "Reading the changes",
  get_check_log: "Reading the check log",
  get_acceptance_evidence: "Checking the evidence",
  get_result_images: "Looking at the screenshots",
  recap: "Recapping",
  list_repos: "Listing projects",
  get_skills: "Checking skills",
  get_project_tools: "Checking the project's tools",
  get_flows: "Reading the flows",
  get_flow_insights: "Looking at how the flows are doing",
  get_project_knowledge: "Reading project knowledge",
  search_project_memory: "Searching project memory",
  get_integrations: "Checking integrations",
  get_capabilities: "Checking what can run",
  ask_owner: "Preparing a question",
  get_models: "Checking the models",
  list_tasks: "Listing tasks",
  get_task: "Reading the task",
  get_task_conversation: "Reading the task's conversation",
  get_agents: "Checking the agents",
  list_decisions: "Reading decisions",
  get_decision: "Reading a decision",
  queue: "Checking the queue",
  show_control: "Finding the right control",
  commit_to: "Noting what I promised",
  release_commitment: "Updating what I promised",
  remember: "Preparing a card for you to confirm",
  get_person: "Looking them up",
};

export function leadToolLabel(name: string): string {
  if (name in TOOL_LABELS) return TOOL_LABELS[name]!;
  return name.startsWith("propose_") ? "Preparing a card for you to confirm" : "Working";
}

/** Tool errors instruct the model how to retry. Only known, fixed copy belongs
 * in the live UI; never echo arguments, redaction placeholders or exceptions. */
const TOOL_FAILURE_REASONS = new Map<string, string>([
  ["Choose a project from list_repos.", "That project isn't available."],
  ["Choose an available project from list_repos.", "That project isn't available."],
  ["repo must be one of the ids from list_repos", "That project isn't available."],
  ["not-found: no such task in your projects", "That task isn't available in your projects."],
  ["That task is not in your projects.", "That task isn't available in your projects."],
  ["not-found: no such decision in your projects", "That decision isn't available in your projects."],
  ["that decision is no longer open", "That decision is already closed."],
  ["No such flow in your projects.", "No such flow in your projects."],
  ["That action is outside your access.", "You don't have access to that action."],
  ["Read the current task version before proposing this action.", "The task needs to be checked again before this action."],
  ["That file is not in these changes. Call get_diff without file for the list.", "That file isn't in the saved changes."],
  ["The saved changes could not be verified.", "The saved changes could not be verified."],
  ["The saved check log could not be verified.", "The saved check log could not be verified."],
  ["Saved results are unavailable here.", "Saved results are unavailable here."],
  ["There is no finished result for that version yet.", "There is no finished result for that version yet."],
  ["Task text cannot contain credentials.", "The task text contains a password or secret key."],
  ["that tool refused — the plane could not answer it right now", "Toolroll couldn't finish that step right now."],
]);

export function leadToolFailureReason(name: string, message: string): string {
  return TOOL_FAILURE_REASONS.get(message) ?? `That step didn't work (${leadToolLabel(name)}).`;
}

/** The `text` of a structured answer still being written, when the answer
 * opens with it (`{"text": "…`); null until then. Escapes are decoded, and
 * an escape cut off at the end is left for the next chunk. */
export function partialAnswerText(partial: string): string | null {
  const opening = /^\s*\{\s*"text"\s*:\s*"/.exec(partial);
  if (opening === null) return null;
  const simple: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
  let out = "";
  for (let i = opening[0].length; i < partial.length; i++) {
    const char = partial[i]!;
    if (char === '"') return out;
    if (char !== "\\") { out += char; continue; }
    const next = partial[i + 1];
    if (next === undefined) return out;
    if (next in simple) { out += simple[next]; i++; continue; }
    if (next !== "u") return out;
    const hex = partial.slice(i + 2, i + 6);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) return out;
    out += String.fromCharCode(parseInt(hex, 16));
    i += 5;
  }
  return out;
}

/** A reader for `claude -p --output-format stream-json --include-partial-messages`:
 * follows the structured-output block and reports its text as it grows. */
export function claudeStreamReader(onText: (text: string) => void, capBytes = 1_048_576): (chunk: string) => void {
  let pending = "";
  let json = "";
  let structured = false;
  let last = "";
  const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
  return chunk => {
    pending += chunk;
    if (pending.length > capBytes) { pending = ""; return; }
    for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      let event: unknown;
      try { event = JSON.parse(line); } catch { continue; }
      if (!record(event) || event["type"] !== "stream_event" || !record(event["event"])) continue;
      const inner = event["event"];
      if (inner["type"] === "content_block_start") {
        const block = inner["content_block"];
        structured = record(block) && block["type"] === "tool_use" && block["name"] === "StructuredOutput";
        if (structured) json = "";
        continue;
      }
      const delta = inner["delta"];
      if (inner["type"] !== "content_block_delta" || !structured || !record(delta) || delta["type"] !== "input_json_delta" || typeof delta["partial_json"] !== "string") continue;
      json += delta["partial_json"];
      if (json.length > capBytes) continue;
      const text = partialAnswerText(json);
      if (text !== null && text !== last) { last = text; onText(text); }
    }
  };
}
