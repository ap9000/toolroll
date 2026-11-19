/** v176: an explicitly enabled, exact-model Codex backup and counted provider attempts. */
export const V176_ADDED_COLUMNS: Readonly<Record<string, Readonly<Record<string, { definition: string; saved: string }>>>> = Object.freeze({
  subagent: { authority_generation: { definition: "INTEGER NOT NULL DEFAULT 0 CHECK (authority_generation >= 0)", saved: "0" }, codex_backup_model: { definition: "TEXT", saved: "NULL" } },
  subagent_turn: {
    provider: { definition: "TEXT NOT NULL DEFAULT 'claude' CHECK (provider IN ('claude','codex'))", saved: "'claude'" },
    card_entry: { definition: "INTEGER", saved: "NULL" },
    model_reported: { definition: "TEXT", saved: "NULL" },
    backup_of: { definition: "INTEGER REFERENCES subagent_turn(id)", saved: "NULL" },
    authority_generation: { definition: "INTEGER NOT NULL DEFAULT 0 CHECK (authority_generation >= 0)", saved: "0" },
    counted_attempt: { definition: "INTEGER NOT NULL DEFAULT 0 CHECK (counted_attempt IN (0,1))", saved: "0" },
    failure_kind: { definition: "TEXT CHECK (failure_kind IN ('usage-limit','unavailable'))", saved: "NULL" },
    pending: { definition: "INTEGER NOT NULL DEFAULT 0 CHECK (pending IN (0,1))", saved: "0" },
  },
});
export const V176_STEPS = Object.freeze(["subagent-backup-columns"] as const);

export const V176_SCHEMA = `
CREATE UNIQUE INDEX IF NOT EXISTS subagent_backup_once ON subagent_turn(backup_of) WHERE backup_of IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS subagent_authority_changed AFTER UPDATE OF state, soul, model, codex_backup_model, daily_turns, manager ON subagent
WHEN NEW.state IS NOT OLD.state OR NEW.soul IS NOT OLD.soul OR NEW.model IS NOT OLD.model
  OR NEW.codex_backup_model IS NOT OLD.codex_backup_model OR NEW.daily_turns IS NOT OLD.daily_turns OR NEW.manager IS NOT OLD.manager
BEGIN
  UPDATE subagent SET authority_generation = OLD.authority_generation + 1 WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS subagent_policy_changed AFTER UPDATE ON org_policy
BEGIN
  UPDATE subagent SET authority_generation = authority_generation + 1;
END;
CREATE TRIGGER IF NOT EXISTS subagent_policy_inserted AFTER INSERT ON org_policy
BEGIN
  UPDATE subagent SET authority_generation = authority_generation + 1;
END;
CREATE TRIGGER IF NOT EXISTS subagent_policy_removed AFTER DELETE ON org_policy
BEGIN
  UPDATE subagent SET authority_generation = authority_generation + 1;
END;
`;
export const V176_OBJECTS = Object.freeze([...V176_SCHEMA.matchAll(/CREATE (UNIQUE INDEX|TRIGGER) IF NOT EXISTS (\w+)/g)].map(one => [one[1] === "UNIQUE INDEX" ? "index" : "trigger", one[2]!] as const));
