/**
 * v167: the answers to a Flexible thread's agent (the Flexible plan v2 §4 and §6, Codex round 2 item 9, slice F2d). Adds
 * only a table: no saved row changes, and nothing writes it while Flexible isn't available (flexible-available.ts). Kept
 * apart from the store so the update road can read the lists without it.
 *
 * - `thread_decision`: one row per decision on a request a thread's agent made (a permission request or a question),
 *   written by flexible-answers.ts. `source` says who decided: `person` (the turn's owner, at the account generation
 *   they proved: `by_generation`), `policy` (Toolroll, by a recorded rule: `rule`; a policy only ever declines or
 *   cancels, never allows) or `provider` (the agent's own automatic allow or deny, observed in its stream and recorded
 *   only: Toolroll sent nothing). A provider or policy row never reads as approved by a person.
 *   `decision_id` is the one id this decision has everywhere: the request's row in the coding catalog (a separate
 *   database, flexible-answers.ts) carries the same id, written once on both sides. `request` names that catalog row
 *   (NULL only for a provider row); `request_ref` is the agent's own id for its request; `request_digest` is the
 *   SHA-256 of the request exactly as the card showed it and `payload_digest` the SHA-256 of the exact answer to be
 *   written; `connection_id` the agent launch (process custody generation, flexible_thread_launch) the answer may be
 *   written to, and no other. Everything but `state`, `write_started_at`, `state_at` and `detail` is written once.
 *   `state` only moves forward: decided → sending | not-sent | uncertain; sending → sent | not-sent | uncertain; sent →
 *   delivered | uncertain; delivered, not-sent and uncertain are final (an uncertain answer is never sent again).
 *   A person's or policy's row is born `decided`, a provider's `delivered`. `write_started_at` is set once, only while
 *   `sending`, in the transaction that makes the final authority check and writes to the agent; a `sent` row has it.
 *   At most one decision per catalog request.
 *   The intent and each outcome are also in action_ledger (action "flexible answer": intended, then sent, delivered,
 *   not-sent or uncertain), which is append-only.
 */
export const V167_SCHEMA = `
CREATE TABLE IF NOT EXISTS thread_decision (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id      TEXT NOT NULL UNIQUE CHECK (length(decision_id) = 32 AND decision_id NOT GLOB '*[^0-9a-f]*'),
  thread           TEXT NOT NULL CHECK (length(thread) = 32 AND thread NOT GLOB '*[^0-9a-f]*'),
  turn             TEXT NOT NULL CHECK (length(turn) = 32 AND turn NOT GLOB '*[^0-9a-f]*'),
  request          TEXT CHECK (request IS NULL OR (length(request) = 32 AND request NOT GLOB '*[^0-9a-f]*')),
  request_ref      TEXT NOT NULL CHECK (length(request_ref) BETWEEN 1 AND 200),
  source           TEXT NOT NULL CHECK (source IN ('person', 'policy', 'provider')),
  rule             TEXT CHECK (rule IS NULL OR (length(rule) BETWEEN 1 AND 40 AND rule NOT GLOB '*[^a-z-]*')),
  decision         TEXT NOT NULL CHECK (decision IN ('accept', 'decline', 'cancel', 'answer')),
  request_digest   TEXT CHECK (request_digest IS NULL OR (length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*')),
  payload_digest   TEXT CHECK (payload_digest IS NULL OR (length(payload_digest) = 64 AND payload_digest NOT GLOB '*[^0-9a-f]*')),
  connection_id    TEXT NOT NULL CHECK (length(connection_id) = 32 AND connection_id NOT GLOB '*[^0-9a-f]*'),
  state            TEXT NOT NULL CHECK (state IN ('decided', 'sending', 'sent', 'delivered', 'not-sent', 'uncertain')),
  at               TEXT NOT NULL,
  by               TEXT NOT NULL CHECK (length(by) BETWEEN 1 AND 200),
  by_generation    INTEGER,
  write_started_at TEXT,
  state_at         TEXT NOT NULL,
  detail           TEXT CHECK (detail IS NULL OR length(detail) <= 500),
  CHECK ((source = 'provider') = (request IS NULL)),
  CHECK ((source = 'person') = (by_generation IS NOT NULL)),
  CHECK ((source = 'policy') = (rule IS NOT NULL)),
  CHECK (source <> 'policy' OR decision IN ('decline', 'cancel')),
  CHECK (source = 'provider' OR (request_digest IS NOT NULL AND payload_digest IS NOT NULL)),
  CHECK (source <> 'provider' OR (state = 'delivered' AND decision IN ('accept', 'decline') AND write_started_at IS NULL)),
  CHECK (state <> 'sent' OR write_started_at IS NOT NULL),
  CHECK (write_started_at IS NULL OR state IN ('sending', 'sent', 'delivered', 'not-sent', 'uncertain'))
);
CREATE UNIQUE INDEX IF NOT EXISTS thread_decision_request ON thread_decision (request) WHERE request IS NOT NULL;
CREATE INDEX IF NOT EXISTS thread_decision_turn ON thread_decision (thread, turn);
CREATE INDEX IF NOT EXISTS thread_decision_connection ON thread_decision (connection_id, state);
CREATE TRIGGER IF NOT EXISTS thread_decision_born BEFORE INSERT ON thread_decision
WHEN NEW.state IS NOT (CASE NEW.source WHEN 'provider' THEN 'delivered' ELSE 'decided' END) OR NEW.write_started_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'a thread decision is born decided (a provider''s observed delivered)');
END;
CREATE TRIGGER IF NOT EXISTS thread_decision_written_once BEFORE UPDATE ON thread_decision
WHEN NEW.id IS NOT OLD.id OR NEW.decision_id IS NOT OLD.decision_id OR NEW.thread IS NOT OLD.thread OR NEW.turn IS NOT OLD.turn
  OR NEW.request IS NOT OLD.request OR NEW.request_ref IS NOT OLD.request_ref OR NEW.source IS NOT OLD.source OR NEW.rule IS NOT OLD.rule
  OR NEW.decision IS NOT OLD.decision OR NEW.request_digest IS NOT OLD.request_digest OR NEW.payload_digest IS NOT OLD.payload_digest
  OR NEW.connection_id IS NOT OLD.connection_id OR NEW.at IS NOT OLD.at OR NEW.by IS NOT OLD.by OR NEW.by_generation IS NOT OLD.by_generation
  OR OLD.state IN ('delivered', 'not-sent', 'uncertain')
  OR (OLD.state = 'decided' AND NEW.state NOT IN ('decided', 'sending', 'not-sent', 'uncertain'))
  OR (OLD.state = 'sending' AND NEW.state NOT IN ('sending', 'sent', 'not-sent', 'uncertain'))
  OR (OLD.state = 'sent' AND NEW.state NOT IN ('sent', 'delivered', 'uncertain'))
  OR (OLD.write_started_at IS NOT NULL AND NEW.write_started_at IS NOT OLD.write_started_at)
  OR (OLD.write_started_at IS NULL AND NEW.write_started_at IS NOT NULL AND OLD.state <> 'sending')
BEGIN
  SELECT RAISE(ABORT, 'a thread decision is written once and its state only moves forward');
END;
`;

export const V167_TABLES = Object.freeze(["thread_decision"] as const);
/** The v167 migration's steps, in order (a test seam may stop after each). */
export const V167_STEPS = Object.freeze(["thread-decision"] as const);
/** v167's named objects, as a current or resumed file must hold them exactly (store.ts checks each). */
export const V167_OBJECTS = Object.freeze([
  ["table", "thread_decision"], ["index", "thread_decision_request"], ["index", "thread_decision_turn"], ["index", "thread_decision_connection"],
  ["trigger", "thread_decision_born"], ["trigger", "thread_decision_written_once"],
] as const);
