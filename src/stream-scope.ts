/**
 * Whose event is this (docs/plans/agents-view.md §2.1): Claude's `stream-json` interleaves the session's own events
 * with its subagents', and a subagent's carry `parent_tool_use_id` (the parent's Task/Agent call). Only the session's
 * own events drive its lifecycle, identity and accounting: the receipt, the primary result, the saved session, live
 * input, the turn and activity marks, and the billing observations. A subagent's init, words or result prove nothing
 * about the main query.
 *
 * Unknown shapes fail toward "not the parent": any present, non-null `parent_tool_use_id` (an id, `""`, a number)
 * makes the event a subagent's. Pure, no imports: every reader shares this one copy.
 */

/** The session's own event: `parent_tool_use_id` absent or null. */
export function topLevelEvent(event: Record<string, unknown>): boolean {
  const parent = event["parent_tool_use_id"];
  return parent === undefined || parent === null;
}

/**
 * The main query's `result`, selected structurally (finding 10): top-level, and its `origin` absent, null or
 * `{kind: "human"}`. An allowlist, so a background task's result, a subagent's result, or any future origin kind is
 * never the run's envelope.
 */
export function primaryResultEvent(event: Record<string, unknown>): boolean {
  if (event["type"] !== "result" || !topLevelEvent(event)) return false;
  const origin = event["origin"];
  if (origin === undefined || origin === null) return true;
  return typeof origin === "object" && String((origin as Record<string, unknown>)["kind"] ?? "") === "human";
}
