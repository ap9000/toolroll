/**
 * v172: each person's own Claude sign-in for interactive agent threads (flexible-sign-in.ts; the thread sign-in plan
 * v2 §2). Adds one table and three nullable columns, and changes no saved row:
 *
 * - `flexible_sign_in`: one row per person and sign-in generation. It holds no value and no hash of one: the secret
 *   itself rests in Toolroll's secrets folder (tool-secret-store.ts, an address of its own per person and generation,
 *   never overwritten). A row is `staged` while its save is under way (with the one-use binding its activation must
 *   match: `save_op`, the proof it was made with, the account generation), `active` once that save committed (at most
 *   one per person), and `retiring` once replaced, removed, expired or reset (terminal: its secret is deleted, then
 *   the row). A row counts only while its account is active at the same generation. `check_outcome` and
 *   `check_status` are the last live token-count check of that generation (informational: a check never clears or
 *   widens anything).
 * - `thread_relay_call` and `thread_relay_pending` gain `sign_in_person` and `sign_in_generation`: whose sign-in, and
 *   which generation of it, a call was reserved and sent with. `thread_relay_call.sign_in_refused` marks a call Claude
 *   answered with an authentication refusal (HTTP 401, or 403 authentication_error): that generation of that person's
 *   sign-in is refused from then on (derived, never written anywhere else). Saved calls read NULL.
 *
 * Kept apart from the store so the update road can read the lists without it.
 */

export const V172_SCHEMA = `
CREATE TABLE IF NOT EXISTS flexible_sign_in (
  person             TEXT NOT NULL CHECK (length(person) BETWEEN 1 AND 200),
  account_generation INTEGER NOT NULL CHECK (account_generation >= 0),
  generation         TEXT NOT NULL CHECK (length(generation) = 32 AND generation NOT GLOB '*[^0-9a-f]*'),
  kind               TEXT NOT NULL CHECK (kind IN ('setup-token')),
  state              TEXT NOT NULL CHECK (state IN ('staged', 'active', 'retiring')),
  save_op            TEXT CHECK (save_op IS NULL OR (length(save_op) = 32 AND save_op NOT GLOB '*[^0-9a-f]*')),
  proof              TEXT NOT NULL CHECK (proof IN ('password-now', 'sso-now', 'restored')),
  staged_at          TEXT NOT NULL,
  retire_after       TEXT,
  activated_at       TEXT,
  retired_at         TEXT,
  check_outcome      TEXT NOT NULL DEFAULT 'not-checked' CHECK (check_outcome IN ('not-checked', 'accepted', 'refused', 'inconclusive', 'unreachable')),
  check_status       INTEGER CHECK (check_status IS NULL OR check_status BETWEEN 100 AND 599),
  checked_at         TEXT,
  PRIMARY KEY (person, generation),
  CHECK ((state = 'staged') = (save_op IS NOT NULL)),
  CHECK (state <> 'staged' OR retire_after IS NOT NULL),
  CHECK (state <> 'active' OR activated_at IS NOT NULL),
  CHECK (state <> 'retiring' OR retired_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS flexible_sign_in_one_active ON flexible_sign_in (person) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS thread_relay_call_sign_in_refused ON thread_relay_call (sign_in_person, sign_in_generation) WHERE sign_in_refused = 1;
`;

/** v172's columns, by table, with the value every row saved before it reads (toolroll-update's HISTORY_RULES). */
export const V172_ADDED_COLUMNS: Readonly<Record<string, Readonly<Record<string, { definition: string; saved: string }>>>> = Object.freeze({
  thread_relay_call: {
    sign_in_person: { definition: "TEXT CHECK (sign_in_person IS NULL OR length(sign_in_person) BETWEEN 1 AND 200)", saved: "NULL" },
    sign_in_generation: { definition: "TEXT CHECK (sign_in_generation IS NULL OR (length(sign_in_generation) = 32 AND sign_in_generation NOT GLOB '*[^0-9a-f]*'))", saved: "NULL" },
    sign_in_refused: { definition: "INTEGER CHECK (sign_in_refused IS NULL OR (sign_in_refused = 1 AND sign_in_person IS NOT NULL AND sign_in_generation IS NOT NULL AND status = 'upstream-error'))", saved: "NULL" },
  },
  thread_relay_pending: {
    sign_in_person: { definition: "TEXT CHECK (sign_in_person IS NULL OR length(sign_in_person) BETWEEN 1 AND 200)", saved: "NULL" },
    sign_in_generation: { definition: "TEXT CHECK (sign_in_generation IS NULL OR (length(sign_in_generation) = 32 AND sign_in_generation NOT GLOB '*[^0-9a-f]*'))", saved: "NULL" },
  },
});

export const V172_TABLES = Object.freeze(["flexible_sign_in"] as const);
/** The v172 migration's steps, in order (a test seam may stop after each). */
export const V172_STEPS = Object.freeze(["flexible-sign-in-columns", "flexible-sign-in"] as const);
/** v172's named objects, as a current or resumed file must hold them exactly (store.ts checks each). */
export const V172_OBJECTS = Object.freeze([
  ["table", "flexible_sign_in"], ["index", "flexible_sign_in_one_active"], ["index", "thread_relay_call_sign_in_refused"],
] as const);
