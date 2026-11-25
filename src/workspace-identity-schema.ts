/** v177: stable workspace identity, not an execution or credential grant. */
export const WORKSPACE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const RECOVERY_GENERATION_PATTERN = /^[0-9a-f]{32}$/;
export type WorkspaceIdentity = { id: string; recoveryGeneration: string; createdAt: string };
export const V177_STEPS = Object.freeze(["workspace-identity"] as const);
export const V177_SCHEMA = `
CREATE TABLE IF NOT EXISTS workspace_identity (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  workspace_id TEXT NOT NULL CHECK (workspace_id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
  recovery_generation TEXT NOT NULL CHECK (length(recovery_generation) = 32 AND recovery_generation NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS workspace_identity_immutable BEFORE UPDATE OF singleton, workspace_id, created_at ON workspace_identity
WHEN NEW.singleton IS NOT OLD.singleton OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'workspace identity is immutable');
END;
CREATE TRIGGER IF NOT EXISTS workspace_identity_not_deleted BEFORE DELETE ON workspace_identity
BEGIN
  SELECT RAISE(ABORT, 'workspace identity cannot be deleted');
END;
`;
export const V177_OBJECTS = Object.freeze([...V177_SCHEMA.matchAll(/CREATE (TABLE|TRIGGER) IF NOT EXISTS (\w+)/g)].map(one => [one[1] === "TABLE" ? "table" : "trigger", one[2]!] as const));
