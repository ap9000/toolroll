/**
 * v173: why a planner's plan or question was refused (planner.ts plannerPayload's problem list, the stranger test round
 * 10). Adds one column and changes no saved row: `run.plan_problems_json`, the validator's own messages for a malformed
 * plan ("plan must start with ## Approach"), cleaned as what the agent said is (agent-said.ts agentSaidTail) because they
 * can echo what the planner wrote, as a JSON array of at most eight short lines (a saved run reads none, NULL). Read only
 * through store.ts planProblemsOf; never sent outside Toolroll. Kept apart from the store so the update road can read the
 * list without it.
 */

export const V173_ADDED_COLUMNS: Readonly<Record<string, Readonly<Record<string, { definition: string; saved: string }>>>> = Object.freeze({
  run: { plan_problems_json: { definition: "TEXT CHECK (plan_problems_json IS NULL OR length(plan_problems_json) BETWEEN 2 AND 4096)", saved: "NULL" } },
});

/** The v173 migration's steps, in order (a test seam may stop after each). */
export const V173_STEPS = Object.freeze(["plan-problems-column"] as const);
