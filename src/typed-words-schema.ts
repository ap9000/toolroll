/**
 * v163: which words a person typed themselves (one-workspace S5, "You said"). Adds only a table: no saved row changes.
 * Kept apart from the store so the update road can read the lists without it.
 *
 * - `typed_by_person`: one row per saved result note (`comment`, a diff_comment) or note sent to the agent (`steer`, a
 *   task_steer row) that a signed-in person typed into a Toolroll browser form, written in the same transaction as the
 *   note, under the session's own account. A note with no row here (an API token, the CLI, a chat card a lead drafted,
 *   GitHub, a reviewer, anything saved before v163) is never quoted as a person's words. `words` is exactly what the
 *   person typed into their own field, never the text a page filled in for them (a retry's suggestion, a check's
 *   failure, a quoted requirement) and never what a reply was about: only these words are ever quoted, and only while
 *   the note still holds them. `question` is the agent's question a reply answers (agent-written, shown outside the
 *   quote and labelled as the agent's). `author` must match the note's own author when read; the row is written once
 *   and never changed.
 */
export const V163_SCHEMA = `
CREATE TABLE IF NOT EXISTS typed_by_person (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  comment   INTEGER UNIQUE REFERENCES diff_comment(id) ON DELETE CASCADE,
  steer     INTEGER UNIQUE REFERENCES task_steer(id) ON DELETE CASCADE,
  author    TEXT NOT NULL CHECK (length(author) BETWEEN 1 AND 200),
  words     TEXT NOT NULL CHECK (length(trim(words)) BETWEEN 1 AND 8000),
  question  TEXT CHECK (question IS NULL OR length(question) BETWEEN 1 AND 400),
  typed_at  TEXT NOT NULL,
  CHECK ((comment IS NULL) <> (steer IS NULL))
);
CREATE TRIGGER IF NOT EXISTS typed_by_person_written_once BEFORE UPDATE ON typed_by_person
BEGIN
  SELECT RAISE(ABORT, 'who typed a note is written once');
END;
`;

export const V163_TABLES = Object.freeze(["typed_by_person"] as const);
/** The v163 migration's steps, in order (a test seam may stop after each). */
export const V163_STEPS = Object.freeze(["typed-by-person"] as const);
