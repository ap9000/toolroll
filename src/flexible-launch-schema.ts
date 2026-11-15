/**
 * v165: Flexible threads' agent launches and their levels (the Flexible plan v2 §4, §5 and enable gate 1 "full process
 * custody", slice F2c). Adds only tables: no saved row changes, and nothing writes them while Flexible isn't available
 * (flexible-available.ts). Kept apart from the store so the update road can read the lists without it.
 *
 * - `flexible_thread_launch`: one row per agent process Toolroll started for a thread (flexible-launch.ts), written
 *   BEFORE the spawn (state `spawning`, with the launch's custody token and this boot's identity), so a crash between
 *   the spawn and its registration is on the record; the agent itself can't run until the row is `live` (its start
 *   gate stays shut, flexible-thread.ts). What was launched (provider, the level its prompts were set for, the fence
 *   digest, the turn it was started for, the holder process, the host, boot and custody token) is written once. The
 *   leader's pid and start identity are written once, as the row goes live. `namespaces` (the Linux pid namespaces the
 *   launch made) and `witnesses` (every descendant seen, pid and start identity) only grow while it is unsettled.
 *   `state` only moves forward: spawning → live | exited; live → stopping | exited | unresolved; stopping → exited |
 *   unresolved; unresolved → stopping | exited | unresolved. `exited` is written only on a verified exit of the whole
 *   tree (no group member, no namespace member, no witness, no descendant and no process of the thread's working in its
 *   folder left), or for a launch whose start gate never opened. At most one unsettled launch per thread.
 * - `flexible_relay_grant`: each relay token Toolroll handed a thread's agent (by its SHA-256, never the token), for
 *   exactly which launch (and its thread and turn), and when it was revoked. The relay checks it on every call; any Toolroll process revokes it
 *   when it stops the thread, so the relay's service ends at once whichever process stopped it. Only ever revoked.
 * - `flexible_thread_level`: the level a thread's owner last chose for it (lowered to, or raised to with a fresh proof);
 *   no row is the level its turns were admitted at.
 */
export const V165_SCHEMA = `
CREATE TABLE IF NOT EXISTS flexible_thread_launch (
  id           TEXT PRIMARY KEY CHECK (length(id) = 32 AND id NOT GLOB '*[^0-9a-f]*'),
  thread       TEXT NOT NULL CHECK (length(thread) = 32 AND thread NOT GLOB '*[^0-9a-f]*'),
  turn         TEXT CHECK (turn IS NULL OR (length(turn) = 32 AND turn NOT GLOB '*[^0-9a-f]*')),
  provider     TEXT NOT NULL CHECK (provider IN ('claude', 'codex', 'gemini', 'openrouter')),
  level        TEXT NOT NULL CHECK (level IN ('supervised', 'auto', 'full')),
  fence_digest TEXT NOT NULL CHECK (length(fence_digest) = 32 AND fence_digest NOT GLOB '*[^0-9a-f]*'),
  holder       TEXT NOT NULL CHECK (length(holder) BETWEEN 1 AND 128),
  host         TEXT NOT NULL,
  machine_id   TEXT,
  boot_id      TEXT,
  marker       TEXT NOT NULL CHECK (length(marker) = 32 AND marker NOT GLOB '*[^0-9a-f]*'),
  leader_pid   INTEGER CHECK (leader_pid IS NULL OR leader_pid > 1),
  leader_start TEXT,
  namespaces   TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(namespaces) AND json_type(namespaces) = 'array'),
  witnesses    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(witnesses) AND json_type(witnesses) = 'array'),
  state        TEXT NOT NULL CHECK (state IN ('spawning', 'live', 'stopping', 'exited', 'unresolved')),
  started_at   TEXT NOT NULL,
  stop_reason  TEXT CHECK (stop_reason IS NULL OR length(stop_reason) <= 200),
  ended_at     TEXT,
  end_detail   TEXT CHECK (end_detail IS NULL OR length(end_detail) <= 2000),
  network_closed_at TEXT,
  CHECK ((leader_pid IS NULL) = (leader_start IS NULL)),
  CHECK (state NOT IN ('live', 'stopping', 'unresolved') OR leader_pid IS NOT NULL),
  CHECK ((ended_at IS NULL) = (state <> 'exited'))
);
CREATE UNIQUE INDEX IF NOT EXISTS flexible_thread_launch_unsettled ON flexible_thread_launch (thread) WHERE state <> 'exited';
CREATE INDEX IF NOT EXISTS flexible_thread_launch_holder ON flexible_thread_launch (holder, state);
CREATE TRIGGER IF NOT EXISTS flexible_thread_launch_written_once BEFORE UPDATE ON flexible_thread_launch
WHEN NEW.id IS NOT OLD.id OR NEW.thread IS NOT OLD.thread OR NEW.turn IS NOT OLD.turn OR NEW.provider IS NOT OLD.provider OR NEW.level IS NOT OLD.level
  OR NEW.fence_digest IS NOT OLD.fence_digest OR NEW.holder IS NOT OLD.holder OR NEW.host IS NOT OLD.host OR NEW.machine_id IS NOT OLD.machine_id
  OR NEW.boot_id IS NOT OLD.boot_id OR NEW.marker IS NOT OLD.marker OR NEW.started_at IS NOT OLD.started_at
  OR (OLD.leader_pid IS NOT NULL AND (NEW.leader_pid IS NOT OLD.leader_pid OR NEW.leader_start IS NOT OLD.leader_start))
  OR (OLD.network_closed_at IS NOT NULL AND NEW.network_closed_at IS NOT OLD.network_closed_at)
  OR OLD.state = 'exited'
  OR (OLD.state = 'spawning' AND NEW.state NOT IN ('spawning', 'live', 'exited'))
  OR (OLD.state = 'live' AND NEW.state = 'spawning')
  OR (OLD.state IN ('stopping', 'unresolved') AND NEW.state NOT IN ('stopping', 'unresolved', 'exited'))
  OR json_array_length(NEW.namespaces) < json_array_length(OLD.namespaces) OR json_array_length(NEW.witnesses) < json_array_length(OLD.witnesses)
BEGIN
  SELECT RAISE(ABORT, 'a flexible launch is written once, its state only moves forward and what it saw only grows');
END;
CREATE TABLE IF NOT EXISTS flexible_relay_grant (
  token_digest TEXT PRIMARY KEY CHECK (length(token_digest) = 64 AND token_digest NOT GLOB '*[^0-9a-f]*'),
  thread       TEXT NOT NULL CHECK (length(thread) = 32 AND thread NOT GLOB '*[^0-9a-f]*'),
  turn         TEXT NOT NULL CHECK (length(turn) = 32 AND turn NOT GLOB '*[^0-9a-f]*'),
  launch       TEXT NOT NULL CHECK (length(launch) = 32 AND launch NOT GLOB '*[^0-9a-f]*'),
  issued_at    TEXT NOT NULL,
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS flexible_relay_grant_launch ON flexible_relay_grant (launch, revoked_at);
CREATE TRIGGER IF NOT EXISTS flexible_relay_grant_written_once BEFORE UPDATE ON flexible_relay_grant
WHEN NEW.token_digest IS NOT OLD.token_digest OR NEW.thread IS NOT OLD.thread OR NEW.turn IS NOT OLD.turn OR NEW.launch IS NOT OLD.launch OR NEW.issued_at IS NOT OLD.issued_at
  OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'a relay grant is written once and only revoked');
END;
CREATE TABLE IF NOT EXISTS flexible_thread_level (
  thread       TEXT PRIMARY KEY CHECK (length(thread) = 32 AND thread NOT GLOB '*[^0-9a-f]*'),
  level        TEXT NOT NULL CHECK (level IN ('supervised', 'auto', 'full')),
  set_by       TEXT NOT NULL,
  set_at       TEXT NOT NULL
);
`;

export const V165_TABLES = Object.freeze(["flexible_thread_launch", "flexible_relay_grant", "flexible_thread_level"] as const);
/** The v165 migration's steps, in order (a test seam may stop after each). */
export const V165_STEPS = Object.freeze(["thread-launch"] as const);
/** v165's named objects, as a current or resumed file must hold them exactly (store.ts checks each). */
export const V165_OBJECTS = Object.freeze([
  ["table", "flexible_thread_launch"], ["index", "flexible_thread_launch_unsettled"], ["index", "flexible_thread_launch_holder"],
  ["trigger", "flexible_thread_launch_written_once"], ["table", "flexible_relay_grant"], ["index", "flexible_relay_grant_launch"],
  ["trigger", "flexible_relay_grant_written_once"], ["table", "flexible_thread_level"],
] as const);
