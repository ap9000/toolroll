/**
 * Live replies in Slack, Discord and Teams (docs/plans/responsive-chat.md §3.2, §3.5, slice 3): the 👀 on a person's
 * message when it arrives, and one "Working on it…" message per turn that shows the lead's status and its reply as it
 * is written, then becomes the answer.
 *
 * - The 👀 is put on beside the serial chat queue (a turn there can take a minute), from the saved event, for the
 *   owner's own direct message only, and taken off once the answer or the failure notice is delivered. It carries no
 *   project data: the lease and a live binding are its fence.
 * - The live message is its own `chat_live` row (v157), never a `chat_part`: planning the reply still adds its own
 *   parts, and the first of them edits this message, so the event stays queued until then. Creation is
 *   creating → placed. On Discord a nonce makes a repeated create within its window return the same message, and
 *   a lookup that fails decides nothing; on Slack and Teams an answer that never came leaves the row uncertain, as
 *   does an older Discord create not found among the recent messages. An uncertain message is never posted again (the
 *   reply then posts fresh, and the event's problem says a "Working on it…" may be left above it). That is the
 *   promise: no duplicate, except after an uncertain create.
 * - Edits go through one serialized sender per message (live-reply.ts): one request in flight, the newest view
 *   waiting, closed (and the request in flight settled) before the reply is planned. Every edit re-proves the chat's
 *   standing (`standing`, the same proof final delivery uses), then the lease after it. Once that fails, nothing more is
 *   edited, cleanup included: the last text already ends "(still writing — not final)".
 * - Cosmetic sends share the app's cooldown with durable delivery: none goes while it holds, and a "slow down" on one
 *   sets it for everything. Final parts come first (they never wait on these), then the 👀, then live edits, which
 *   start each app's spacing conservatively and widen it on every "slow down".
 *
 * No live payload carries a button, a card or an ask: those exist only on the planned reply.
 */
import { createLiveReply, createLiveSender, LIVE_STATUS, type LiveView } from "./live-reply.js";
import type { LeadProgress } from "./lead-progress.js";
import { renderReply, shapeReplyParts, type ShapeOptions } from "./reply-shape.js";
import type { ChatContent, ChatEvent, ChatState } from "./chat-delivery-state.js";

export type LivePlatform = "slack" | "discord" | "teams";

/** The live message's fixed words. */
export const LIVE_WORDS = {
  working: "Working on it…",
  notFinal: "(still writing — not final)",
  continues: "(continues…)",
  maybeLeft: "A “Working on it…” message may be left above this reply.",
} as const;

/** Each app's starting least time between two live edits (§3.5); a "slow down" doubles it, up to the most. */
export const LIVE_SPACING_MS: Readonly<Record<LivePlatform, number>> = { slack: 1_500, discord: 1_250, teams: 2_000 };
const MOST_SPACING_MS = 10_000;
/** A message older than this when the 👀 would go gets none. */
const ACK_WINDOW_MS = 60_000;
/** One 👀 per person a second; a burst waits its turn. */
const ACK_SPACING_MS = 1_000;
/** After an app refused reactions (a missing permission), ask again at most this often (one quiet try a minute). */
const ACK_REFUSED_RETRY_MS = 60_000;
/** The chat_meta key that says reactions were refused, and when. */
export const ACK_REFUSED_META = "reactions-refused";

/** What one app does for a live message. Text arrives already rendered in the app's format (`liveText`). */
export type ChatLiveTransport = {
  platform: LivePlatform;
  /** The longest rendered text one live message carries (the reply's first window plus the marker). */
  limit: number;
  /** Starting spacing; tests pass 0. */
  spacingMs?: number;
  /** Post the live message; resolves its id. Discord sends its nonce, so a repeat returns the same message. */
  create(text: string): Promise<string>;
  /** Discord only: the message an unconfirmed create left, found by its nonce, or null (not among the recent ones).
   * Throws when the lookup itself failed: that is not absence. */
  recover?(): Promise<string | null>;
  /** With `recover`: how long after a create a repeat under the same nonce is known to return the same message. */
  nonceMs?: number;
  /** Replace the live message's whole text (every field, as the final edit does). */
  edit(message: string, text: string): Promise<void>;
  /** The wait an error asks for when it means "slow down", else null. */
  rateLimited(error: unknown): number | null;
  /** True when the app may not have done it (the answer was lost). */
  uncertain(error: unknown): boolean;
};

/** A worker's live-reply switch: on, or on with a least spacing between edits (tests pass 0). */
export type LiveReplies = boolean | { spacingMs: number };
/** The transport's spacing for that switch (undefined: the app's own start). */
export const liveSpacingOf = (on: LiveReplies | undefined): number | undefined => typeof on === "object" ? on.spacingMs : undefined;

// ---- rate state ------------------------------------------------------------------------------------------------

type Gate = { spacing: number; base: number; liveNext: number };
const gates = new Map<string, Gate>();
function gateOf(state: ChatState, installation: string, base: number): Gate {
  const key = `${state.provider}:${installation}`;
  let gate = gates.get(key);
  if (gate === undefined || gate.base !== base) gates.set(key, gate = { spacing: base, base, liveNext: 0 });
  return gate;
}
/** The app asked everyone to wait (shared with durable delivery). */
const coolingDown = (state: ChatState, installation: string, now: Date): boolean => state.retryAt(installation) > now.toISOString();
/** A "slow down" on a cosmetic send: the whole connection waits, and live edits space out further. */
function slowDown(state: ChatState, installation: string, gate: Gate | null, retryMs: number, now: Date): void {
  state.deferUntil(installation, new Date(now.getTime() + Math.max(1_000, retryMs)).toISOString());
  if (gate !== null) gate.spacing = Math.min(MOST_SPACING_MS, Math.max(gate.base, gate.spacing * 2, 500));
}
const easeBack = (gate: Gate): void => { gate.spacing = Math.max(gate.base, gate.spacing - (gate.spacing - gate.base) / 4); };
/** Forget every connection's live spacing (tests). */
export function resetLiveGates(): void { gates.clear(); }

// ---- rendering --------------------------------------------------------------------------------------------------

const italic = (platform: LivePlatform, plain: string): string => {
  const words = renderReply(plain, platform);
  return platform === "discord" ? `*${words}*` : `_${words}_`;
};

/**
 * A view as one live message's text, rendered for the app and measured after rendering: the shaped reply's first
 * window that fits (cut where the final split would cut, never inside a link, code or bold), "(continues…)" when
 * more follows, then the status and the "not final" marker. Null: nothing to show (the turn ended).
 */
export function liveText(view: LiveView, platform: LivePlatform, limit: number, shape: ShapeOptions = {}): string | null {
  switch (view.phase) {
    case "closed": return null;
    case "queued": return italic(platform, LIVE_STATUS.queued);
    case "working": return italic(platform, view.status);
    case "writing": {
      const marker = italic(platform, view.status === LIVE_STATUS.writing ? LIVE_WORDS.notFinal : `${view.status} ${LIVE_WORDS.notFinal}`);
      const room = Math.max(200, limit - marker.length - LIVE_WORDS.continues.length - 8);
      const windows = shapeReplyParts(view.text, room, shape, shaped => renderReply(shaped, platform).length);
      const first = renderReply(windows[0] ?? "", platform).slice(0, room);
      const more = windows.length > 1 ? `\n\n${italic(platform, LIVE_WORDS.continues)}` : "";
      return `${first}${more}\n\n${marker}`;
    }
  }
}

// ---- the saved row ----------------------------------------------------------------------------------------------

export type LiveRow = { state: "creating" | "uncertain" | "placed" | "finalized" | "abandoned"; message: string | null; generation: number; problem: string | null; created: string };

export function liveRow(state: ChatState, event: string): LiveRow | null {
  const row = state.prepare("SELECT state, message, generation, problem, created FROM chat_live WHERE provider = :provider AND event = ?").get(event);
  return row === undefined ? null : { state: String(row["state"]) as LiveRow["state"], message: row["message"] == null ? null : String(row["message"]),
    generation: Number(row["generation"]), problem: row["problem"] == null ? null : String(row["problem"]), created: String(row["created"]) };
}

/** The message an unconfirmed create left: found, not among the recent messages (absent), or the lookup failed (a
 * "slow down" is shared). */
async function recoverLive(state: ChatState, installation: string, transport: ChatLiveTransport, now: () => Date): Promise<{ found: string } | { absent: true } | { failed: true }> {
  try {
    const found = await transport.recover!();
    return found === null ? { absent: true } : { found };
  } catch (error) {
    const wait = transport.rateLimited(error);
    if (wait !== null) slowDown(state, installation, null, wait, now());
    return { failed: true };
  }
}
const setLive = (state: ChatState, event: string, from: LiveRow["state"][], to: LiveRow["state"], now: Date, extra: { message?: string; problem?: string } = {}): boolean =>
  Number(state.prepare(`UPDATE chat_live SET state = ?, message = COALESCE(?, message), problem = COALESCE(?, problem), updated = ?
    WHERE provider = :provider AND event = ? AND state IN (SELECT value FROM json_each(?))`)
    .run(to, extra.message ?? null, extra.problem ?? null, now.toISOString(), event, JSON.stringify(from)).changes) === 1;

/** Is this message id the live message of that event (the one its reply's first part edits)? */
export function isLiveMessage(state: ChatState, event: string, message: string | undefined): boolean {
  if (message === undefined) return false;
  const row = liveRow(state, event);
  return row !== null && row.message === message;
}

/** A first reply part that may replace the live message: words only, to the person's own chat. */
const editable = (part: ChatContent | undefined): part is ChatContent =>
  part !== undefined && part.edit === undefined && part.channel === undefined && part.proposal === undefined && part.image === undefined &&
  part.rich === undefined && part.ask === undefined && part.decide === undefined && part.flow === undefined && part.choose === undefined &&
  part.note === undefined && part.question === undefined && part.prompt === undefined;

/**
 * Plan an event's reply (ChatState.plan) onto its live message: when one was placed, the first part edits it, and the
 * row is finalized in the same transaction. An uncertain create (Slack, Teams) leaves the reply to post fresh, and
 * the event's problem says a "Working on it…" may be left above it.
 */
export function planWithLive(state: ChatState, event: string, parts: ChatContent[], now: Date): void {
  state.store.transact(() => {
    const row = liveRow(state, event);
    const onto = row !== null && row.message !== null && (row.state === "placed" || row.state === "abandoned") && editable(parts[0]);
    state.plan(event, onto ? [{ ...parts[0]!, edit: row.message! }, ...parts.slice(1)] : parts, now);
    if (row === null) return;
    if (onto) setLive(state, event, ["placed", "abandoned"], "finalized", now);
    else if (row.state === "creating" || row.state === "uncertain") {
      setLive(state, event, ["creating", "uncertain"], "uncertain", now, { problem: LIVE_WORDS.maybeLeft });
      state.prepare("UPDATE chat_event SET problem = ? WHERE provider = :provider AND id = ?").run(LIVE_WORDS.maybeLeft, event);
    }
  });
}

// ---- one turn's live message -------------------------------------------------------------------------------------

export type ChatLiveTurn = {
  /** Feed one engine event (synchronous, never throws). The first one posts "Working on it…". */
  push(event: LeadProgress): void;
  /** The message waits behind earlier ones: post "Waiting for your earlier messages…" unless a live message is up. */
  queued(): Promise<void>;
  /** Stop editing: drop the waiting view and settle the request in flight. Resolves before the reply may be planned. */
  close(): Promise<void>;
};

export function openChatLive(input: {
  state: ChatState;
  event: ChatEvent;
  installation: string;
  transport: ChatLiveTransport;
  /** The owner's message and this app's origin, as the final reply is shaped. */
  shape: ShapeOptions;
  /** The lease, the connection and the binding, read locally (no network): the fence for words that carry no data. */
  fenced: () => boolean;
  /** The chat's full standing (channelAccess under the turn's ceiling) before an edit that carries the turn's words. */
  standing: () => Promise<boolean>;
  now: () => Date;
}): ChatLiveTurn {
  const { state, event, transport } = input;
  const gate = gateOf(state, input.installation, transport.spacingMs ?? LIVE_SPACING_MS[transport.platform]);
  const live = createLiveReply(input.shape);
  let row = liveRow(state, event.id);
  // Off for good: an uncertain or finished message, a refused create, or lost standing.
  let off = row !== null && row.state !== "placed" && !(row.state === "creating" && transport.recover !== undefined);
  // A create from before a restart on an app that can't tell whether it landed: uncertain, never posted again.
  if (row?.state === "creating" && transport.recover === undefined) setLive(state, event.id, ["creating"], "uncertain", input.now(), { problem: LIVE_WORDS.maybeLeft });
  let message = row?.state === "placed" ? row.message : null;
  let placing: Promise<void> | null = null;
  const stopped = new AbortController();

  const abandon = (problem: string): void => {
    off = true;
    setLive(state, event.id, ["creating", "placed"], "abandoned", input.now(), { problem });
  };
  const place = (text: string): Promise<void> => {
    if (off || message !== null) return Promise.resolve();
    placing ??= (async () => {
      try {
        if (!input.fenced() || coolingDown(state, input.installation, input.now())) return;
        row = liveRow(state, event.id);
        if (row === null) {
          state.prepare("INSERT OR IGNORE INTO chat_live (provider, event, state, created, updated) VALUES (:provider, ?, 'creating', ?, ?)")
            .run(event.id, input.now().toISOString(), input.now().toISOString());
        } else if (row.state === "creating") {
          // A create from before a restart: Discord finds it by its nonce, or repeats it under the same nonce while
          // that is known to return the same message; Slack and Teams can't know, so it is never posted again.
          if (transport.recover === undefined) { off = true; setLive(state, event.id, ["creating"], "uncertain", input.now(), { problem: LIVE_WORDS.maybeLeft }); return; }
          const found = await recoverLive(state, input.installation, transport, input.now);
          // The lookup failed: undecided, so nothing is posted; the row stays creating for a later look.
          if ("failed" in found) return;
          if ("found" in found) { message = found.found; setLive(state, event.id, ["creating"], "placed", input.now(), { message: found.found }); return; }
          const age = input.now().getTime() - Date.parse(row.created);
          if (!(age >= 0 && age < (transport.nonceMs ?? 0))) {
            off = true;
            setLive(state, event.id, ["creating"], "uncertain", input.now(), { problem: LIVE_WORDS.maybeLeft });
            return;
          }
        } else if (row.state === "placed") { message = row.message; return; }
        else { off = true; return; }
        if (!input.fenced()) return;
        const id = await transport.create(text);
        message = id;
        setLive(state, event.id, ["creating"], "placed", input.now(), { message: id });
        gate.liveNext = input.now().getTime() + gate.spacing;
      } catch (error) {
        const wait = transport.rateLimited(error);
        if (wait !== null) slowDown(state, input.installation, gate, wait, input.now());
        if (transport.uncertain(error) && transport.recover === undefined) {
          off = true;
          setLive(state, event.id, ["creating"], "uncertain", input.now(), { problem: LIVE_WORDS.maybeLeft });
        } else if (transport.uncertain(error)) {
          // Discord: the row stays creating, so the reply's planning looks for it by nonce once more (settleLive).
          const found = await recoverLive(state, input.installation, transport, input.now);
          if ("found" in found) { message = found.found; setLive(state, event.id, ["creating"], "placed", input.now(), { message: found.found }); }
          else off = true;
        } else {
          // Refused outright: nothing was posted. The reply goes out as a new message.
          off = true;
          state.prepare("DELETE FROM chat_live WHERE provider = :provider AND event = ? AND state = 'creating'").run(event.id);
        }
      } finally {
        placing = null;
      }
    })();
    return placing;
  };

  const pause = (ms: number): Promise<void> => new Promise(resolve => {
    if (ms <= 0 || stopped.signal.aborted) return resolve();
    const end = () => { clearTimeout(timer); stopped.signal.removeEventListener("abort", end); resolve(); };
    const timer = setTimeout(end, ms);
    (timer as { unref?: () => void }).unref?.();
    stopped.signal.addEventListener("abort", end, { once: true });
  });

  const sender = createLiveSender<string>({
    send: async (text, generation) => {
      if (placing !== null) await placing;
      if (off || message === null || stopped.signal.aborted) return;
      // Spacing: the app's current pace, and a 👀 just sent goes first.
      await pause(gate.liveNext - input.now().getTime());
      if (off || stopped.signal.aborted) return;
      if (!input.fenced()) return abandon("Chat access changed");
      let standing = false;
      try { standing = await input.standing(); } catch { standing = false; }
      if (!standing) return abandon("Chat access changed");
      // Re-read after the awaits: the turn may have ended, or the lease moved, meanwhile.
      if (off || stopped.signal.aborted || !input.fenced()) return;
      // A cooldown holds: this view is dropped (a later one may go).
      if (coolingDown(state, input.installation, input.now())) return;
      gate.liveNext = input.now().getTime() + gate.spacing;
      try {
        await transport.edit(message, text);
        easeBack(gate);
        state.prepare("UPDATE chat_live SET generation = ?, updated = ? WHERE provider = :provider AND event = ? AND state = 'placed'")
          .run(generation, input.now().toISOString(), event.id);
      } catch (error) {
        const wait = transport.rateLimited(error);
        if (wait !== null) slowDown(state, input.installation, gate, wait, input.now());
        // Anything else: this view is dropped, previews are best effort.
      }
    },
  });

  const show = (view: LiveView): void => {
    // A blocked preview clears at once back to the status line; the turn may still answer.
    const shown = view.phase === "closed" && view.why === "blocked" ? { phase: "working", status: live.status() } as const : view;
    const text = liveText(shown, transport.platform, transport.limit, input.shape);
    if (text === null) return;
    void place(italic(transport.platform, LIVE_WORDS.working));
    sender.offer(text);
  };

  return {
    push(progress) {
      try {
        if (off || sender.closed) return;
        if (live.push(progress)) show(live.view());
        else if (message === null && placing === null) void place(italic(transport.platform, LIVE_WORDS.working));
      } catch { /* a live message never breaks the turn */ }
    },
    async queued() {
      if (off || message !== null) return;
      await place(italic(transport.platform, LIVE_STATUS.queued));
    },
    async close() {
      stopped.abort();
      await sender.close();
      if (placing !== null) await placing;
    },
  };
}

// ---- the 👀 ----------------------------------------------------------------------------------------------------

/** What one app does for the 👀. Teams gives bots no reactions: its ack is "typing…", with nothing to take off. */
export type ChatAckHooks = {
  react?: (event: ChatEvent) => Promise<unknown>;
  unreact?: (event: ChatEvent) => Promise<unknown>;
  typing?: (event: ChatEvent) => Promise<unknown>;
  /** This install may not react (a missing permission or scope): stop asking for a while, quietly. */
  refused: (error: unknown) => boolean;
  /** Already so: the reaction is already on (when adding) or already gone, with its message (when taking it off). */
  settled: (error: unknown) => boolean;
  rateLimited: (error: unknown) => number | null;
};

const setAck = (state: ChatState, event: string, ack: "sent" | "done" | "skipped", now: Date): void => {
  state.prepare(`INSERT INTO chat_ack (provider, event, state, created, updated) VALUES (:provider, ?, ?, ?, ?)
    ON CONFLICT (provider, event) DO UPDATE SET state = excluded.state, updated = excluded.updated`).run(event, ack, now.toISOString(), now.toISOString());
};

/** Did this install refuse reactions within the last minute? Then no 👀 is asked for (no error after error). */
export function reactionsRefused(state: ChatState, installation: string, now: Date): boolean {
  const at = state.meta(installation, ACK_REFUSED_META);
  return at !== null && Date.parse(at) + ACK_REFUSED_RETRY_MS > now.getTime();
}

const lastAck = new Map<string, number>();

/**
 * One step of the 👀 work for an installation, beside the queue: take one 👀 off a message whose reply (or failure
 * notice) is delivered, else put one on the next owner's message that arrived. True: it did something (call again).
 */
export async function ackPass(input: {
  state: ChatState;
  installation: string;
  owner: string;
  current: () => boolean;
  hooks: ChatAckHooks;
  now: () => Date;
}): Promise<boolean> {
  const { state, installation, hooks } = input;
  const fenced = () => input.current() && state.owns(installation, input.owner, input.now());
  if (!fenced() || coolingDown(state, installation, input.now())) return false;
  const eventOf = (row: Record<string, unknown> | undefined) => (row === undefined ? null : state.event(String(row["event"])));
  // Taking one off: its event is handled and nothing of its reply waits to send.
  if (hooks.unreact !== undefined) {
    const done = eventOf(state.prepare(`SELECT a.event FROM chat_ack a JOIN chat_event e ON e.provider = a.provider AND e.id = a.event
      WHERE a.provider = :provider AND a.state = 'sent' AND e.installation = ? AND e.state IN ('done','dropped')
        AND NOT EXISTS (SELECT 1 FROM chat_part p WHERE p.provider = a.provider AND p.event = a.event AND p.state = 'pending')
      ORDER BY a.created LIMIT 1`).get(installation));
    if (done !== null) {
      try {
        await hooks.unreact(done);
        setAck(state, done.id, "done", input.now());
      } catch (error) {
        const wait = hooks.rateLimited(error);
        if (wait !== null) slowDown(state, installation, null, wait, input.now());
        // Gone already, or not ours to take off any more: settled. Anything else is tried again on a later pass.
        else if (hooks.settled(error) || hooks.refused(error)) setAck(state, done.id, "done", input.now());
        else return false;
      }
      return true;
    }
  }
  // Putting one on: the owner's own direct message, saved and not yet acknowledged, recent enough to matter.
  const since = new Date(input.now().getTime() - ACK_WINDOW_MS).toISOString();
  const event = eventOf(state.prepare(`SELECT e.id AS event FROM chat_event e JOIN chat_binding b ON b.provider = e.provider AND b.id = e.binding
    WHERE e.provider = :provider AND e.installation = ? AND e.kind = 'message' AND e.state = 'queued' AND e.created >= ?
      AND b.revoked IS NULL AND e.member = b.member AND e.channel = b.channel
      AND NOT EXISTS (SELECT 1 FROM chat_ack a WHERE a.provider = e.provider AND a.event = e.id)
    ORDER BY e.created, e.id LIMIT 1`).get(installation, since));
  if (event === null || event.binding === null) return false;
  const binding = state.bindingById(event.binding);
  if (binding === null || !state.live(binding)) { setAck(state, event.id, "skipped", input.now()); return true; }
  const key = `${state.provider}:${binding.id}`;
  if ((lastAck.get(key) ?? Number.NEGATIVE_INFINITY) + ACK_SPACING_MS > input.now().getTime()) return false;
  if (hooks.react === undefined && hooks.typing === undefined) { setAck(state, event.id, "skipped", input.now()); return true; }
  if (hooks.react !== undefined && reactionsRefused(state, installation, input.now())) { setAck(state, event.id, "skipped", input.now()); return true; }
  if (!fenced()) return false;
  lastAck.set(key, input.now().getTime());
  // Saved as on before it is asked for: a crash in between can only leave a take-off with nothing to take off.
  setAck(state, event.id, hooks.react !== undefined ? "sent" : "done", input.now());
  // A 👀 goes before the next live edit.
  for (const [name, gate] of gates) if (name === `${state.provider}:${installation}`) gate.liveNext = Math.max(gate.liveNext, input.now().getTime() + gate.spacing / 2);
  try {
    if (hooks.react !== undefined) await hooks.react(event);
    else await hooks.typing!(event);
    if (hooks.react !== undefined) state.deleteMeta(installation, ACK_REFUSED_META);
  } catch (error) {
    const wait = hooks.rateLimited(error);
    if (wait !== null) slowDown(state, installation, null, wait, input.now());
    if (hooks.react !== undefined && hooks.settled(error)) return true;
    if (hooks.react !== undefined && hooks.refused(error)) state.setMeta(installation, ACK_REFUSED_META, input.now().toISOString(), input.now());
    setAck(state, event.id, "skipped", input.now());
  }
  return true;
}

/**
 * Before an event's reply is planned: a create that never confirmed (this pass, or before a restart) is found by its
 * nonce on Discord, else marked uncertain, so planning edits the right message or none. False: the lookup failed, so
 * it is still undecided and planning waits (a "slow down" is shared).
 */
export async function settleLive(state: ChatState, event: string, transport: ChatLiveTransport | null, now: () => Date): Promise<boolean> {
  const row = liveRow(state, event);
  if (row?.state !== "creating") return true;
  const found = transport?.recover === undefined ? { absent: true } as const : await recoverLive(state, state.event(event)?.installation ?? "", transport, now);
  if ("failed" in found) return false;
  if ("found" in found) setLive(state, event, ["creating"], "placed", now(), { message: found.found });
  else setLive(state, event, ["creating"], "uncertain", now(), { problem: LIVE_WORDS.maybeLeft });
  return true;
}

/** Forget who was acknowledged when (tests). */
export function resetAckSpacing(): void { lastAck.clear(); }

/**
 * The 👀 loop a worker runs beside its queue while its connection is the current one: a pass every quarter second,
 * and at once when `wake` is called (a message just arrived). Never throws.
 */
export function runChatAcks(input: Omit<Parameters<typeof ackPass>[0], "now"> & { same: () => boolean; signal: AbortSignal; now?: () => Date }): { wake: () => void; done: Promise<void> } {
  let wakeUp: (() => void) | null = null;
  const wake = () => { wakeUp?.(); };
  input.signal.addEventListener("abort", wake, { once: true });
  const done = (async () => {
    while (input.same() && !input.signal.aborted) {
      try {
        for (let steps = 0; steps < 8 && await ackPass({ ...input, now: input.now ?? (() => new Date()) }); steps++);
      } catch { /* quiet: a 👀 is a courtesy */ }
      if (!input.same() || input.signal.aborted) break;
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => wakeUp?.(), 250);
        (timer as { unref?: () => void }).unref?.();
        wakeUp = () => { clearTimeout(timer); wakeUp = null; resolve(); };
      });
    }
    input.signal.removeEventListener("abort", wake);
  })();
  return { wake, done };
}
