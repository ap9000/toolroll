/**
 * Live turn states from the agent's own output stream (Agents board): no
 * hooks, no model. The builder already parses Claude stream-json and Codex
 * --json events for the live log; this reads the same events for three facts:
 *
 * - busy: a session, turn or tool call started (or the agent is mid-turn);
 * - idle: the turn's result arrived (success or not, it is a result);
 * - crashed: the process ended while a turn was still open — no result.
 *
 * Each change is recorded once, under the run's attempt key
 * (agent-board.ts decides whether it may move the current snapshot).
 * The same events say which tool calls are open — a Claude tool_use until its
 * tool_result, a Codex command or tool item until it completes — so a long,
 * silent command is not mistaken for a stuck agent. Only those known shapes
 * count, at most OPEN_TOOLS_CAP at once, and a turn result or the process
 * ending closes them all.
 * Fail-soft: a recording that throws never touches the build.
 */
import type { AgentTurn, ToolKind } from "./agent-board.js";

type Observer = { observe(event: Record<string, unknown>): void; close(): void };

/** What one stream event says about the turn; null when it says nothing. */
export function turnSignalOf(event: Record<string, unknown>): Exclude<AgentTurn, "crashed"> | null {
  const type = typeof event["type"] === "string" ? event["type"] : "";
  switch (type) {
    // Claude stream-json: the session starts, the assistant speaks or calls a tool, a tool answers; then one result.
    case "system": return event["subtype"] === "init" ? "busy" : null;
    case "assistant": case "user": return "busy";
    case "result": return "idle";
    // Codex --json: a thread and its turns start, items run; a turn completes or fails.
    case "thread.started": case "turn.started": case "item.started": case "item.updated": case "item.completed": return "busy";
    case "turn.completed": case "turn.failed": return "idle";
    // Gemini stream-json, which the same live log reads.
    case "init": case "tool_use": case "tool_call": case "message": return "busy";
    default: return null;
  }
}

/** At most this many open calls are tracked; past it, a new one is not (the oldest still holds the long threshold). */
export const OPEN_TOOLS_CAP = 64;
const CODEX_TOOL_ITEMS: ReadonlyMap<unknown, ToolKind> = new Map([["command_execution", "command"], ["mcp_tool_call", "tool"], ["web_search", "tool"], ["file_change", "tool"]]);
const COMMAND_TOOLS = new Set(["Bash", "BashOutput"]);
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const callId = (value: unknown): string | null => typeof value === "string" && value !== "" && value.length <= 200 ? value : null;

/** The tool calls one stream event opens and closes, by id: only Claude's and Codex's known shapes. */
export function toolCallsOf(event: Record<string, unknown>): { opened: { id: string; kind: ToolKind }[]; closed: string[] } {
  const opened: { id: string; kind: ToolKind }[] = [], closed: string[] = [];
  const type = event["type"];
  if (type === "assistant" || type === "user") {
    const content = object(event["message"])?.["content"];
    for (const part of Array.isArray(content) ? content : []) {
      const block = object(part);
      if (block === null) continue;
      if (type === "assistant" && block["type"] === "tool_use") {
        const id = callId(block["id"]);
        if (id !== null) opened.push({ id, kind: COMMAND_TOOLS.has(String(block["name"])) ? "command" : "tool" });
      } else if (type === "user" && block["type"] === "tool_result") {
        const id = callId(block["tool_use_id"]);
        if (id !== null) closed.push(id);
      }
    }
  } else if (type === "item.started" || type === "item.completed") {
    const item = object(event["item"]);
    const id = callId(item?.["id"]), kind = CODEX_TOOL_ITEMS.get(item?.["type"]);
    if (id !== null && kind !== undefined) (type === "item.started" ? opened.push({ id, kind }) : closed.push(id));
  }
  return { opened, closed };
}

export type OpenTool = { kind: ToolKind; at: Date } | null;

export type TurnRecorder = Observer & {
  /** The agent process is gone: a turn still open ended without its result. */
  ended(): void;
  /** The last state recorded (null: nothing yet). */
  readonly state: AgentTurn | null;
};

/**
 * Watch a run's stream for turn changes, beside its live log (which may be
 * null), and for the oldest tool call still open (recordTool hears it move;
 * a turn that leaves busy closes them all, and its own record clears them).
 */
export function withAgentTurns(inner: Observer | null, record: (state: AgentTurn, at: Date) => void, clock: () => Date,
  recordTool: (open: OpenTool, at: Date) => void = () => {}): TurnRecorder {
  let state: AgentTurn | null = null;
  let spoke = false;
  const open = new Map<string, { kind: ToolKind; at: Date }>();
  let oldest: { kind: ToolKind; at: Date } | null = null;
  const move = (next: AgentTurn) => {
    if (next === state) return;
    state = next;
    if (next !== "busy") { open.clear(); oldest = null; }
    try { record(next, clock()); } catch { /* display state: the next change tries again */ }
  };
  const tools = (event: Record<string, unknown>) => {
    const calls = toolCallsOf(event);
    if (calls.opened.length === 0 && calls.closed.length === 0) return;
    const at = clock();
    for (const id of calls.closed) open.delete(id);
    for (const one of calls.opened) if (!open.has(one.id) && open.size < OPEN_TOOLS_CAP) open.set(one.id, { kind: one.kind, at });
    const first = open.values().next().value ?? null;
    if (first === oldest) return;
    oldest = first;
    try { recordTool(first, at); } catch { /* display state: the next change tries again */ }
  };
  return {
    observe(event) {
      inner?.observe(event);
      if (state === "crashed") return;
      let signal: ReturnType<typeof turnSignalOf> = null;
      try { signal = turnSignalOf(event); } catch { signal = null; }
      if (signal === null) return;
      spoke = true;
      move(signal);
      if (signal === "busy") { try { tools(event); } catch { /* an unreadable call: the turn's result closes it */ } }
    },
    close() { inner?.close(); },
    ended() {
      if (state === "crashed") return;
      // A process that never spoke, or whose last turn never reported its result, ended without one.
      if (!spoke || state !== "idle") move("crashed");
    },
    get state() { return state; },
  };
}
