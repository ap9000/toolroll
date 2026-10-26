/**
 * A Claude build's live input (live steering). The build runs with
 * `--input-format stream-json` and its stdin left open, so Toolroll can talk
 * to the session while it works instead of only through files it reads
 * between steps (checked on Claude Code 2.1.290):
 *
 * - The brief is the FIRST stdin message, a user frame with its own uuid. A
 *   `-p` prompt is silently dropped once stdin carries input, so the argv
 *   never carries the brief.
 * - A later user frame is taken up as soon as the current tool call ends,
 *   inside the turn that is running: it adds no result of its own.
 * - An interrupt control request stops the current turn within milliseconds
 *   and keeps the process; the next user frame continues the same session
 *   as a new turn. That is Pause; Resume is that next frame with only a
 *   short "continue". Stop is still the process-tree kill it always was.
 * - One process emits a result per turn, so the run ends when Toolroll
 *   closes stdin, not at the first result: after a turn ends with the
 *   handoff written or with nothing more owed, when the turn budget is
 *   spent, or when a paused session reaches the idle limit. `--max-turns`
 *   applies per user message, so the total is counted here. The idle
 *   watchdog stays the transport's own; a paused session only asks it to
 *   close stdin first (idleLimit), so the build settles from its handoff.
 *   closeReason tells settlement which ending Toolroll chose.
 *
 * Sending is never reading: a note written here still counts as read only
 * when the agent moves its file to handled/ (steer-mailbox.ts). Nothing here
 * touches the store; the builder's dispatcher records what happened.
 */
import { randomUUID } from "node:crypto";
import { primaryResultEvent, topLevelEvent } from "./stream-scope.js";

/** The child's stdin, as the transport hands it over. */
export type LiveInputIo = { write(line: string): void; end(): void };

/** Why stdin closed: the handoff was written, the session had nothing more owed, the turn budget ran out, a paused
 * session reached the idle limit, the process ended first, or a write failed. */
export type LiveCloseReason = "finished" | "settled" | "turn-budget" | "paused-idle" | "ended" | "input-failed";

/** What Resume sends a paused session: only a nudge to go on, never a note. */
export const CONTINUE_TEXT = "continue";

export type LiveInputOptions = {
  /** Toolroll's total for the whole session: distinct assistant turns across every message. */
  maxTurns: number;
  /** The agent wrote its handoff (done, park or a plan revision): a turn that ends now closes stdin. */
  finished?: () => boolean;
  /** stdin is attached and the brief was written. */
  onOpen?: () => void;
  onClose?: (why: LiveCloseReason) => void;
  /** The current turn stopped for a Pause (the harness confirmed the interrupt, or the turn's result arrived). */
  onPaused?: () => void;
};

/** A stdin user frame, in the shape the harness reads. */
export const userFrame = (text: string, uuid: string): string =>
  JSON.stringify({ type: "user", message: { role: "user", content: text }, uuid });

/** A stdin interrupt: stop the current turn, keep the session. */
export const interruptFrame = (requestId: string, cancelQueued = false): string =>
  JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "interrupt", ...(cancelQueued ? { cancel_queued: true } : {}) } });


export class LiveInput {
  readonly maxTurns: number;
  #options: LiveInputOptions;
  #io: LiveInputIo | null = null;
  #pending: string[] = [];
  #begun = false;
  #closed = false;
  #turnActive = false;
  /** A user frame was written while an interrupted turn had not yet ended: that frame's own turn is owed a result. */
  #owed = false;
  #paused = false;
  #interrupts = new Set<string>();
  #turns = new Set<string>();
  #closeReason: LiveCloseReason | null = null;
  /** The brief's frame uuid, once begun. */
  briefUuid: string | null = null;

  constructor(options: LiveInputOptions) {
    this.#options = options;
    this.maxTurns = Math.max(1, Math.floor(options.maxTurns));
  }

  /** Queue the brief as the first frame. Once, before the process is attached. */
  begin(brief: string, uuid: string = randomUUID()): void {
    if (this.#begun) throw new Error("a live session's brief is sent once");
    this.#begun = true;
    this.briefUuid = uuid;
    this.#turnActive = true;
    this.#write(userFrame(brief, uuid));
  }

  /** The transport spawned the child with stdin piped: write what is queued, brief first. */
  attach(io: LiveInputIo): void {
    if (this.#io !== null || this.#closed) return;
    this.#io = io;
    const pending = this.#pending;
    this.#pending = [];
    for (const line of pending) if (!this.#raw(line)) return;
    try { this.#options.onOpen?.(); } catch { /* display state never touches the session */ }
  }

  /** stdin is attached and still open: a note reaches the agent in seconds, and a Pause can stop its turn. */
  get open(): boolean {
    return this.#io !== null && !this.#closed;
  }

  get paused(): boolean {
    return this.#paused;
  }

  /** Distinct assistant turns so far, across every message. */
  get turns(): number {
    return this.#turns.size;
  }

  /** Why stdin closed, once it has. */
  get closeReason(): LiveCloseReason | null {
    return this.#closeReason;
  }

  /**
   * Send a note (or anything the session should read next). A paused session continues. False once stdin is closed.
   * Mid-turn, the harness folds it into the running turn; after an interrupt that turn is over, so the frame starts a
   * turn of its own whose result is owed before stdin closes.
   */
  send(text: string, uuid: string): boolean {
    if (!this.open) return false;
    if (!this.#write(userFrame(text, uuid))) return false;
    if (this.#turnActive && this.#interrupts.size > 0) this.#owed = true;
    this.#paused = false;
    this.#turnActive = true;
    return true;
  }

  /** Resume a paused session with a short continue frame and no note. "not-paused" when nothing waits to go on. */
  resume(uuid: string): "sent" | "not-paused" | "closed" {
    if (!this.open) return "closed";
    if (!this.#paused) return "not-paused";
    return this.send(CONTINUE_TEXT, uuid) ? "sent" : "closed";
  }

  /**
   * The transport's idle limit was reached. A paused session closes stdin instead of being killed — the harness exits
   * and the build settles from whatever handoff it saved — and true asks the watchdog to wait once more for that exit.
   * Anything else is an ordinary idle timeout.
   */
  idleLimit(): boolean {
    if (!this.open || !this.#paused) return false;
    this.close("paused-idle");
    return true;
  }

  /**
   * Pause: stop the current turn, keep the session. "sent" when an interrupt was written; "idle" when no turn was
   * running (the session is already waiting, so it is paused as it stands); "closed" when stdin is gone.
   */
  interrupt(requestId: string): "sent" | "idle" | "closed" {
    if (!this.open) return "closed";
    this.#paused = true;
    if (!this.#turnActive) return "idle";
    if (!this.#write(interruptFrame(requestId))) return "closed";
    this.#interrupts.add(requestId);
    return "sent";
  }

  /** Every parsed stdout event, in order. */
  observe(event: Record<string, unknown>): void {
    const type = String(event["type"] ?? "");
    // The session's own words count; a subagent's (parent_tool_use_id set) or a background task's never do.
    if (type === "assistant" && topLevelEvent(event)) {
      this.#turnActive = true;
      const message = event["message"] as Record<string, unknown> | undefined;
      const id = typeof message?.["id"] === "string" ? message["id"] : `turn-${this.#turns.size + 1}`;
      this.#turns.add(id);
      if (this.#turns.size > this.maxTurns && this.open) {
        // The total is spent once a turn past it starts: the last allowed turn ran in full, tools and all. Stop this
        // one, then let the process finish on its own; settlement reads the handoff (closeReason).
        // cancel_queued: a note already queued must not start a turn past the budget after stdin closes.
        this.#write(interruptFrame(`budget-${randomUUID()}`, true));
        this.close("turn-budget");
      }
    } else if (type === "control_response") {
      const response = event["response"] as Record<string, unknown> | undefined;
      const requestId = typeof response?.["request_id"] === "string" ? response["request_id"] : null;
      if (requestId !== null && this.#interrupts.has(requestId) && response?.["subtype"] === "success" && this.#paused) this.#notifyPaused();
    } else if (type === "result" && primaryResultEvent(event)) {
      this.#turnActive = false;
      this.#interrupts.clear();
      if (this.#paused) {
        // A paused session waits for the next note; the idle watchdog still bounds the wait.
        this.#notifyPaused();
        return;
      }
      // A frame written after this turn was interrupted starts a turn of its own: wait for its result.
      if (this.#owed) {
        this.#owed = false;
        return;
      }
      let finished = false;
      try { finished = this.#options.finished?.() === true; } catch { finished = false; }
      this.close(finished ? "finished" : "settled");
    }
  }

  /** Close stdin: the harness finishes what it has and exits. Further sends refuse. */
  close(why: LiveCloseReason): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeReason = why;
    this.#paused = false;
    if (this.#io !== null) {
      try { this.#io.end(); } catch { /* already gone */ }
    }
    try { this.#options.onClose?.(why); } catch { /* display state never touches the session */ }
  }

  /** The process ended (or its stdin failed): nothing more is written. */
  detach(why: "ended" | "input-failed" = "ended"): void {
    const closedAlready = this.#closed;
    this.#closed = true;
    if (!closedAlready) this.#closeReason = why;
    this.#paused = false;
    this.#io = null;
    if (!closedAlready) {
      try { this.#options.onClose?.(why); } catch { /* display state never touches the session */ }
    }
  }

  #notifyPaused(): void {
    try { this.#options.onPaused?.(); } catch { /* display state never touches the session */ }
  }

  #write(line: string): boolean {
    if (this.#closed) return false;
    if (this.#io === null) {
      this.#pending.push(line);
      return true;
    }
    return this.#raw(line);
  }

  #raw(line: string): boolean {
    try {
      this.#io!.write(`${line}\n`);
      return true;
    } catch {
      this.detach("input-failed");
      return false;
    }
  }
}
