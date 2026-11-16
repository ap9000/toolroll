/**
 * v170: what the agent said on its way out of a failed attempt (agent-said.ts). Adds one column and changes no saved
 * row: `run.agent_said_json`, the cleaned tail of the attempt's own output as a JSON array of at most eight short lines
 * (a saved run reads none, NULL). Kept apart from the store so the update road can read the list without it.
 */

export const V170_ADDED_COLUMNS: Readonly<Record<string, Readonly<Record<string, { definition: string; saved: string }>>>> = Object.freeze({
  run: { agent_said_json: { definition: "TEXT CHECK (agent_said_json IS NULL OR length(agent_said_json) BETWEEN 2 AND 4096)", saved: "NULL" } },
});

/** The v170 migration's steps, in order (a test seam may stop after each). */
export const V170_STEPS = Object.freeze(["agent-said-column"] as const);
