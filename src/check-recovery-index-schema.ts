/** v178: index only check-recovery hold actions in the append-only ledger without changing authority or history. */
export const V178_STEPS = Object.freeze(["action-ledger-index"] as const);
export const V178_INDEX = "action_ledger_action";
export const V178_SCHEMA = "CREATE INDEX IF NOT EXISTS action_ledger_action ON action_ledger(action, id) WHERE action = 'checks recovery held';";
