/**
 * The shared live-reply core (docs/plans/responsive-chat.md §2): one lead turn's `LeadProgress` turned into text-only
 * views that every surface renders. Surfaces never read `LeadProgress` themselves.
 *
 *   queued → working (one status line) → writing (status + display-safe partial text) → closed (answered | failed | blocked)
 *
 * Nothing here is durable or authoritative: the saved thread message and its cards remain the record, and no view ever
 * carries a card, a button, an ask or an approval. A partial is the reply as written so far, cut back to what is
 * settled (never an unfinished word, code span, link or bold run), withheld while its tail could be the start of a
 * password or key, and shaped with the final reply's own presentation policy (presentation, not redaction).
 *
 * `createLiveSender` is the one sender per live surface message (§2.4): at most one request in flight, one pending
 * slot holding only the newest view, a generation that only grows, and `close()` — after which nothing more is sent,
 * and which resolves only once the request in flight has settled, so durable delivery can start strictly after it.
 */
import { scanForSecrets } from "./evidence.js";
import type { LeadLiveTool, LeadProgress } from "./lead-progress.js";
import { shapeReply, shapeReplyPrefix, type ShapeOptions } from "./reply-shape.js";

export type LiveView =
  | { phase: "queued" }
  | { phase: "working"; status: string }
  | { phase: "writing"; status: string; text: string }
  | { phase: "closed"; why: "answered" | "failed" | "blocked" };

/** The status line's fixed words (§2.3). A running tool reads as its own label plus "…". */
export const LIVE_STATUS = {
  queued: "Waiting for your earlier messages…",
  thinking: "Thinking…",
  writing: "Writing…",
  repair: "Fixing the reply…",
  shorten: "Shortening the reply…",
  /** A preview closed because text looked like a password or key; the turn itself may still answer. */
  held: "Working on it…",
} as const;

/** One token that could still grow into a match of a secret family: a non-empty prefix of one of its openings, or the
 * whole opening followed by its body characters. Preceded by a non-word character or the start, as the detectors'
 * own word boundaries are. */
function opening(leads: readonly string[], body: string): string {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
  const alternatives = new Set<string>();
  for (const lead of leads) {
    for (let length = 1; length < lead.length; length += 1) alternatives.add(escape(lead.slice(0, length)));
    alternatives.add(`${escape(lead)}${body}*`);
  }
  return `(?:${[...alternatives].join("|")})`;
}

/**
 * The start of every `SECRET_PATTERNS` family (evidence.ts), checked against the end of the text written so far:
 * while any matches, the partial is withheld. Single-token families look at the unfinished last token; the families
 * whose match spans spaces (a private-key header, an npm `_authToken = value`) look at the whole last line.
 */
const SECRET_STARTS: readonly RegExp[] = [
  // private-key: "-----BEGIN RSA PRIVATE KEY-----", partway.
  /(?:^|\s)-{1,5}(?:B(?:E(?:G(?:I(?:N(?:[ \t][A-Z \t]*-{0,5})?)?)?)?)?)?$/,
  // npm-auth-token: "_authToken = value", partway.
  new RegExp(String.raw`(?:^|[^A-Za-z0-9])${opening(["_authToken"], String.raw`[\s=]`)}\S*$`),
  // aws-access-key, github-token, slack-token, openai-key, stripe-key, google-api-key, gitlab-token.
  new RegExp(String.raw`(?:^|[^A-Za-z0-9_])${opening(["AKIA", "ASIA"], "[0-9A-Z]")}$`),
  new RegExp(String.raw`(?:^|[^A-Za-z0-9_])${opening(["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"], "[A-Za-z0-9_]")}$`),
  new RegExp(String.raw`(?:^|[^A-Za-z0-9_])${opening(["xoxb-", "xoxa-", "xoxp-", "xoxr-", "xoxs-"], "[A-Za-z0-9-]")}$`),
  new RegExp(String.raw`(?:^|[^A-Za-z0-9_])${opening(["sk-"], "[A-Za-z0-9_-]")}$`),
  new RegExp(String.raw`(?:^|[^A-Za-z0-9_])${opening(["sk_live_", "sk_test_", "rk_live_", "rk_test_", "whsec_"], "[A-Za-z0-9]")}$`),
  new RegExp(String.raw`(?:^|[^A-Za-z0-9_])${opening(["AIza"], "[0-9A-Za-z_-]")}$`),
  new RegExp(String.raw`(?:^|[^A-Za-z0-9_])${opening(["glpat-"], "[A-Za-z0-9_-]")}$`),
  // telegram-bot-token: "123456789:AA…".
  /(?:^|[^A-Za-z0-9_])\d+(?::(?:A(?:A[A-Za-z0-9_-]*)?)?)?$/,
  // discord-bot-token: "M…24.…6.…27".
  /(?:^|[^A-Za-z0-9_])[MN][A-Za-z\d]*(?:\.[\w-]*(?:\.[\w-]*)?)?$/,
  // password-in-url: "scheme://user:password@host", partway (a scheme and its colon are enough to wait).
  /(?:^|[^A-Za-z0-9+.-])[a-z][a-z0-9+.-]*:\S*$/i,
];

/** Could the end of this text be the start of a password or key? Then nothing of it shows yet. */
export function secretMayStart(text: string): boolean {
  const lastLine = text.replace(/\r\n?/g, "\n").split("\n").at(-1) ?? "";
  return SECRET_STARTS.some(pattern => pattern.test(lastLine));
}

/**
 * What of a reply still being written is settled: everything before its last whitespace (the unfinished last word
 * stays out), then cut back before any code fence, code span, bold run or link that hasn't closed yet. Trailing
 * whitespace is trimmed.
 */
export function settledText(raw: string): string {
  const text = raw.replace(/\r\n?/g, "\n");
  let end = text.length;
  while (end > 0 && !/\s/.test(text[end - 1]!)) end -= 1;
  const shown = text.slice(0, end);
  let fence = -1, code = -1, bold = -1, link = -1;
  let linkState: "label" | "url" | null = null;
  for (let index = 0; index < shown.length; index += 1) {
    if (shown.startsWith("```", index)) {
      fence = fence === -1 ? index : -1;
      index += 2;
      continue;
    }
    if (fence !== -1) continue;
    const char = shown[index]!;
    if (char === "\n") { code = -1; bold = -1; link = -1; linkState = null; continue; }
    if (char === "`") { code = code === -1 ? index : -1; continue; }
    if (code !== -1) continue;
    if (shown.startsWith("**", index)) { bold = bold === -1 ? index : -1; index += 1; continue; }
    if (char === "[" && linkState === null) { link = index; linkState = "label"; continue; }
    if (linkState === "label" && char === "]") {
      if (shown[index + 1] === "(") { linkState = "url"; index += 1; } else { link = -1; linkState = null; }
      continue;
    }
    if (linkState === "url" && (char === ")" || /\s/.test(char))) { link = -1; linkState = null; }
  }
  const cut = Math.min(...[fence, code, bold, link].filter(at => at !== -1), shown.length);
  return shown.slice(0, cut).trimEnd();
}

/**
 * A partial as it may be shown: `blocked` when it holds a password or key (the preview closes), `withheld` while its
 * tail could still become one (show nothing new), else the settled text shaped for display. A step's finished text
 * (`final`, secret-checked whole by the engine) shows whole.
 */
export function partialDisplay(raw: string, final: boolean, shape: ShapeOptions = {}): { kind: "blocked" } | { kind: "withheld" } | { kind: "shown"; text: string } {
  if (scanForSecrets(raw).length > 0) return { kind: "blocked" };
  if (!final && secretMayStart(raw)) return { kind: "withheld" };
  const text = final ? shapeReply(raw, shape) : shapeReplyPrefix(settledText(raw), shape);
  // Shaping only relabels and removes; a secret in what it returns would mean it came from somewhere else. Never shown.
  if (scanForSecrets(text).length > 0) return { kind: "blocked" };
  return { kind: "shown", text };
}

type LiveStep = { calls: LeadLiveTool[]; raw: string; reason?: "repair" | "shorten"; shown: string };

export type LiveReply = {
  /** Feed one engine event; true when the view changed. Events after close are ignored. */
  push(event: LeadProgress): boolean;
  /** The turn ended (its outcome is the engine's, never inferred from text). Idempotent; a blocked close stays blocked. */
  close(why: "answered" | "failed"): void;
  view(): LiveView;
  /** The status line now, also once a blocked preview closed while the turn runs on. */
  status(): string;
  /** Each step's tool calls, for a surface that lists them behind a disclosure. Fixed copy only, never model text. */
  tools(): LeadLiveTool[][];
  readonly turn: number | null;
};

/** One turn's live reply. `shape`: the owner's message (`asked`) and this app's origins, as the final reply is shaped. */
export function createLiveReply(shape: ShapeOptions = {}, options: { queued?: boolean } = {}): LiveReply {
  const steps: LiveStep[] = [];
  let queued = options.queued === true;
  let closed: "answered" | "failed" | "blocked" | null = null;
  let turn: number | null = null;
  let last = "";
  const current = (): LiveStep => steps.at(-1) ?? (steps.push({ calls: [], raw: "", shown: "" }), steps.at(-1)!);
  const status = (): string => {
    const step = steps.at(-1);
    const running = step?.calls.filter(call => call.state === "running").at(-1);
    if (running !== undefined) return `${running.label}…`;
    if (step?.reason !== undefined) return LIVE_STATUS[step.reason];
    if (closed === "blocked") return LIVE_STATUS.held;
    if (step !== undefined && step.raw.trim() !== "") return LIVE_STATUS.writing;
    return LIVE_STATUS.thinking;
  };
  const view = (): LiveView => {
    if (closed !== null) return { phase: "closed", why: closed };
    if (queued && steps.length === 0) return { phase: "queued" };
    const text = [...steps].reverse().find(step => step.shown !== "")?.shown ?? "";
    return text === "" ? { phase: "working", status: status() } : { phase: "writing", status: status(), text };
  };
  const changed = (): boolean => {
    const now = JSON.stringify(view());
    if (now === last) return false;
    last = now;
    return true;
  };
  last = JSON.stringify(view());
  return {
    get turn() { return turn; },
    push(event) {
      if (closed !== null) return false;
      turn ??= event.turn;
      queued = false;
      switch (event.kind) {
        case "started": break;
        case "step": steps.push({ calls: [], raw: "", shown: "", ...(event.reason === undefined ? {} : { reason: event.reason }) }); break;
        case "tool": current().calls.push({ id: event.id, label: event.label, state: "running" }); break;
        case "tool-result":
          for (const step of steps) {
            const index = step.calls.findIndex(call => call.id === event.id);
            if (index !== -1) { step.calls[index] = { id: event.id, label: step.calls[index]!.label, ...event.outcome }; break; }
          }
          break;
        case "text": {
          const step = current();
          step.raw = event.text;
          const shown = partialDisplay(event.text, event.final === true, shape);
          if (shown.kind === "blocked") { closed = "blocked"; for (const one of steps) one.shown = ""; }
          else if (shown.kind === "shown") step.shown = shown.text;
          break;
        }
        case "blocked": closed = "blocked"; for (const one of steps) one.shown = ""; break;
      }
      return changed();
    },
    close(why) {
      if (closed === null) closed = why;
      for (const one of steps) one.shown = "";
      changed();
    },
    view,
    status,
    tools: () => steps.map(step => step.calls.map(call => ({ ...call }))),
  };
}

export type LiveSender<V> = {
  /** Offer the newest view: it replaces any view still waiting. Ignored once closed. */
  offer(view: V): void;
  /** Drop the waiting view, wait for the request in flight to settle, then refuse every later view. */
  close(): Promise<void>;
  /** Grows with every offered view; a transport may use it to refuse an older one. */
  readonly generation: number;
  readonly closed: boolean;
};

/**
 * The serialized sender for one live surface message (§2.4). `standing` re-proves the viewer's right to see this turn
 * before every send (it may await; the close is re-checked after it). `spacingMs` is the least time between two sends,
 * read before each one (a surface widens it after the platform asks for a pause). A failed send drops that view:
 * previews are best effort.
 */
export function createLiveSender<V>(options: {
  send: (view: V, generation: number) => unknown;
  standing?: () => boolean | Promise<boolean>;
  spacingMs?: number | (() => number);
  now?: () => number;
}): LiveSender<V> {
  const spacing = (): number => typeof options.spacingMs === "function" ? options.spacingMs() : options.spacingMs ?? 0;
  const now = options.now ?? Date.now;
  let generation = 0;
  let closed = false;
  let pending: { view: V; generation: number } | null = null;
  let inflight: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSent = Number.NEGATIVE_INFINITY;
  const pump = (): void => {
    if (closed || inflight !== null || timer !== null || pending === null) return;
    const wait = lastSent + spacing() - now();
    if (wait > 0) {
      timer = setTimeout(() => { timer = null; pump(); }, wait);
      (timer as { unref?: () => void }).unref?.();
      return;
    }
    const next = pending;
    pending = null;
    inflight = (async () => {
      try {
        if (options.standing !== undefined && !(await options.standing())) return;
        if (closed) return;
        lastSent = now();
        await options.send(next.view, next.generation);
      } catch { /* best effort: this view is dropped */ }
    })().finally(() => { inflight = null; pump(); });
  };
  return {
    get generation() { return generation; },
    get closed() { return closed; },
    offer(view) {
      if (closed) return;
      generation += 1;
      pending = { view, generation };
      pump();
    },
    async close() {
      closed = true;
      pending = null;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      await inflight;
    },
  };
}
