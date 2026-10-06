/** Live progress of one lead turn (chat streaming): what the lead is doing
 * and the reply as it is written. Nothing here is durable or authoritative —
 * the finished turn's saved message and cards remain the record. */

export type MateProgress =
  | { kind: "started"; turn: number }
  | { kind: "step"; turn: number; step: number }
  | { kind: "tool"; turn: number; step: number; id: string; label: string }
  | { kind: "tool-result"; turn: number; step: number; id: string; outcome: MateToolOutcome }
  | { kind: "text"; turn: number; step: number; text: string };

export type MateToolOutcome = { state: "succeeded" } | { state: "failed"; reason: string };
export type MateLiveTool = { id: string; label: string } & ({ state: "running" } | MateToolOutcome);
/** Keep tools as labels for older clients; toolCalls adds per-call outcomes. */
export type MateLiveStep = { tools: string[]; toolCalls: MateLiveTool[]; text: string };

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

export function mateToolLabel(name: string): string {
  if (name in TOOL_LABELS) return TOOL_LABELS[name]!;
  return name.startsWith("propose_") ? "Preparing a card for you to confirm" : "Working";
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
