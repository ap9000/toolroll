/**
 * v157: live replies in Slack, Discord and Teams (docs/plans/responsive-chat.md §3.2). New tables only, so a saved row
 * reads as it did. Kept beside nothing else so the update road can read the list without loading the store.
 *
 * chat_live: one "Working on it…" message per received event, so the final answer can replace it. Separate from
 * chat_part: planning the reply still adds its own parts (the first one edits this message), and the event stays
 * queued until then. state: creating (asked the app to post it, no answer yet) → placed (its id is known), or
 * uncertain (a crash or a lost answer left it unknown whether it was posted: never posted again), then finalized
 * (the reply was planned onto it) or abandoned (live edits stopped: access changed or the app refused).
 *
 * chat_ack: the 👀 on a person's message, put on when it arrives and taken off once the answer (or the failure
 * notice) is delivered. state: sent (on, to take off later), done (taken off, or nothing to take off: Teams typing),
 * skipped (not put on: the app refused, or it waited too long).
 */
export const V157_SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_live (
 provider TEXT NOT NULL CHECK (provider IN ('slack','discord','teams')), event TEXT NOT NULL,
 state TEXT NOT NULL CHECK (state IN ('creating','uncertain','placed','finalized','abandoned')),
 message TEXT, generation INTEGER NOT NULL DEFAULT 0, problem TEXT, created TEXT NOT NULL, updated TEXT NOT NULL,
 PRIMARY KEY (provider, event),
 FOREIGN KEY (provider, event) REFERENCES chat_event(provider, id)
);
CREATE TABLE IF NOT EXISTS chat_ack (
 provider TEXT NOT NULL CHECK (provider IN ('slack','discord','teams')), event TEXT NOT NULL,
 state TEXT NOT NULL CHECK (state IN ('sent','done','skipped')), created TEXT NOT NULL, updated TEXT NOT NULL,
 PRIMARY KEY (provider, event),
 FOREIGN KEY (provider, event) REFERENCES chat_event(provider, id)
);
CREATE INDEX IF NOT EXISTS chat_ack_sent ON chat_ack(provider, state);
`;

export const V157_TABLES = Object.freeze(["chat_live", "chat_ack"] as const);
export const V157_STEPS = Object.freeze(["chat-live-tables"] as const);
