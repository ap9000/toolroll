import type { Database } from "./store.js";

/** v99: sign-ins (and refusals, lockouts, sign-outs) and policy changes are their own kinds of event.
 * v110: commands a person ran on this server with their API token, from the CLI ('api') or their agent ('mcp'). */
export const LEDGER_SOURCES = ["work", "request", "access", "sign-in", "policy", "api", "mcp"] as const;
export type LedgerSource = typeof LEDGER_SOURCES[number];

export type LedgerEntry = {
  id: number; at: string; actor: string; repo: string | null;
  taskId: string | null; runId: number | null;
  action: string; outcome: string; source: LedgerSource;
  /** v99: what changed, in a short line (a policy's "before → after"); never a secret, prompt or body. */
  detail: string | null;
};

/** The table as v54 made it: the one earlier shape the v99 rebuild accepts. */
export const LEDGER_V54_TABLE = (name: string) => `CREATE TABLE ${name} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL, actor TEXT NOT NULL, repo TEXT,
  task_id TEXT, run_id INTEGER,
  action TEXT NOT NULL, outcome TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('work','request','access'))
)`;
export const LEDGER_V54_COLUMNS = ["id", "at", "actor", "repo", "task_id", "run_id", "action", "outcome", "source"] as const;
/** The table as v99 made it: the v110 rebuild accepts this shape and v54's. */
export const LEDGER_V99_TABLE = (name: string) => `CREATE TABLE ${name} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL, actor TEXT NOT NULL, repo TEXT,
  task_id TEXT, run_id INTEGER,
  action TEXT NOT NULL, outcome TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('work','request','access','sign-in','policy')),
  detail TEXT
)`;
export const LEDGER_TABLE = (name: string) => `CREATE TABLE ${name} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL, actor TEXT NOT NULL, repo TEXT,
  task_id TEXT, run_id INTEGER,
  action TEXT NOT NULL, outcome TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('work','request','access','sign-in','policy','api','mcp')),
  detail TEXT
)`;

export const LEDGER_SCHEMA = `
${LEDGER_TABLE("IF NOT EXISTS action_ledger")};
CREATE INDEX IF NOT EXISTS action_ledger_project ON action_ledger(repo, id DESC);
CREATE INDEX IF NOT EXISTS action_ledger_actor ON action_ledger(actor, id DESC);
CREATE TRIGGER IF NOT EXISTS action_ledger_no_update BEFORE UPDATE ON action_ledger
BEGIN SELECT RAISE(ABORT, 'action history is append-only'); END;
CREATE TRIGGER IF NOT EXISTS action_ledger_no_delete BEFORE DELETE ON action_ledger
BEGIN SELECT RAISE(ABORT, 'action history is append-only'); END;
`;

/** Installed after all table migrations. Work events commit with the work,
 * including CLI and unattended workers; no prompts, tool arguments, tokens,
 * decision text, or transcript content are copied into the ledger. */
export function installLedgerTriggers(db: Database): void {
  const repo = (ref: string) => `(SELECT repo FROM task_ref WHERE id = ${ref})`;
  const task = (ref: string) => `(SELECT external_id FROM task_ref WHERE id = ${ref})`;
  const runRef = `(SELECT task_ref FROM run WHERE id = NEW.run)`;
  const event = (at: string, actor: string, project: string, taskId: string, runId: string, action: string, outcome: string) =>
    `INSERT INTO action_ledger(at,actor,repo,task_id,run_id,action,outcome,source) VALUES (${at},${actor},${project},${taskId},${runId},'${action}',${outcome},'work');`;
  db.exec(`
CREATE TRIGGER IF NOT EXISTS ledger_run_started AFTER INSERT ON run BEGIN
  ${event("NEW.started_at", "NEW.runner", repo("NEW.task_ref"), task("NEW.task_ref"), "NEW.id", "run started", "NEW.role")}
END;
CREATE TRIGGER IF NOT EXISTS ledger_run_finished AFTER UPDATE OF outcome ON run
WHEN NEW.outcome IS NOT NULL AND OLD.outcome IS NOT NEW.outcome BEGIN
  ${event("COALESCE(NEW.finished_at, NEW.started_at)", "NEW.runner", repo("NEW.task_ref"), task("NEW.task_ref"), "NEW.id", "run finished", "NEW.outcome")}
END;
CREATE TRIGGER IF NOT EXISTS ledger_decision_opened AFTER INSERT ON decision BEGIN
  ${event("NEW.created_at", "'system'", repo(runRef), task(runRef), "NEW.run", "decision opened", "NEW.state")}
END;
CREATE TRIGGER IF NOT EXISTS ledger_decision_answered AFTER UPDATE OF answered_at ON decision
WHEN NEW.answered_at IS NOT NULL AND OLD.answered_at IS NULL BEGIN
  ${event("NEW.answered_at", "COALESCE(NEW.answered_by,'system')", repo(runRef), task(runRef), "NEW.run", "decision answered", "NEW.state")}
END;
CREATE TRIGGER IF NOT EXISTS ledger_scope_approved AFTER UPDATE OF approved_at, approved_digest ON task_scope
WHEN NEW.approved_at IS NOT NULL AND (OLD.approved_at IS NOT NEW.approved_at OR OLD.approved_digest IS NOT NEW.approved_digest) BEGIN
  ${event("NEW.approved_at", "COALESCE(NEW.approved_by,'system')", "(SELECT repo FROM task_ref WHERE backend = 'built-in' AND external_id = NEW.task_id)", "NEW.task_id", "NULL", "scope approved", "'approved'")}
END;
CREATE TRIGGER IF NOT EXISTS ledger_task_state AFTER UPDATE OF state ON task
WHEN OLD.state IS NOT NEW.state BEGIN
  ${event("NEW.updated_at", "'system'", "(SELECT repo FROM task_ref WHERE backend = 'built-in' AND external_id = NEW.id)", "NEW.id", "NULL", "task state changed", "NEW.state")}
END;
CREATE TRIGGER IF NOT EXISTS ledger_task_placed AFTER UPDATE OF repo ON task_ref
WHEN OLD.repo IS NOT NEW.repo BEGIN
  ${event("strftime('%Y-%m-%dT%H:%M:%fZ','now')", "'system'", "NEW.repo", "NEW.external_id", "NULL", "task placed", "'recorded'")}
END;
CREATE TRIGGER IF NOT EXISTS ledger_coordinator_minted AFTER INSERT ON coordinator_credential BEGIN
  INSERT INTO action_ledger(at,actor,repo,task_id,run_id,action,outcome,source,detail) VALUES (NEW.created_at, NEW.created_by, NULL, NULL, NULL,
    'coordinator minted: ' || NEW.name, 'minted', 'access', 'projects: ' || NEW.repos);
END;
CREATE TRIGGER IF NOT EXISTS ledger_task_registered AFTER INSERT ON task_ref BEGIN
  ${event("strftime('%Y-%m-%dT%H:%M:%fZ','now')", "'system'", "NEW.repo", "NEW.external_id", "NULL", "task registered", "'recorded'")}
END;
CREATE TRIGGER IF NOT EXISTS ledger_steer AFTER INSERT ON task_steer BEGIN
  ${event("NEW.created_at", "NEW.author", repo("NEW.task_ref"), task("NEW.task_ref"), "NEW.attached_run", "steering added", "NEW.authorship_state")}
END;
`);
}
