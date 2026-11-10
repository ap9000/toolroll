/**
 * The work (docs/plans/task-page-steps.md "Watch the work"; docs/plans/live-conversation.md §7): one agent's work as a
 * chat. Rules: src/design/KIT.md "The work"; the frame is the same markup as src/server/kit.ts `work`.
 *
 * - `KWork`: the frame — a header (title, who is working, a blue dot while it runs, close), the scrolling body, and the
 *   message box at the foot.
 * - `useConversation` follows one run's records window (`/r/<run>?fragment=transcript&shape=records`) from a byte offset
 *   every 2 s while the agent runs, and to the end once it has finished. It makes no request while `paused` (a password
 *   is asked on the page: `usePasswordAsked`), and goes on where it stopped when that ends.
 * - `KWorkRecords` draws a conversation: the agent's words as text, each action as one quiet line with our fixed kind
 *   words and its target, the notes people sent as bubbles on the right with their read state. Everything is rendered as
 *   text; nothing from the window becomes markup. `KWorkConversation` is the two together, with the Terminal view the
 *   Agents page offers.
 */
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { KButton } from "./k-button.js";
import { KIcon } from "./k-icon.js";
import { KSeg } from "./k-seg.js";
import { cn } from "./utils.js";

type Kind = "session" | "message" | "edit" | "command" | "read" | "search" | "lookup" | "plan" | "delegate" | "tool";
type WireRecord =
  | { k: "open"; at: string; detail: "base" | "commands" }
  | { k: "start"; at: string }
  | { k: "say"; at: string; t: string[] }
  | { k: "step"; at: string; id: string; kind: Kind; target?: string; once?: true }
  | { k: "done"; at: string; id: string; ok: boolean | null; out?: string[] }
  | { k: "cut"; at: string }
  | { k: "cap"; at: string };
export type ConversationNote = { id: number; author: string; mine: boolean; at: string; text: string; standing: string; readAt: string | null };
export type WindowAnswer = {
  records?: WireRecord[]; nextOffset?: number; gen?: string | null; inKey?: boolean; keyTail?: string; final?: boolean;
  notes?: ConversationNote[]; older?: number; error?: string;
};

export type ConversationItem =
  | { key: string; kind: "say"; at: string; lines: string[] }
  | { key: string; kind: "step"; at: string; step: Kind; target: string | null; once: boolean; done: { at: string; ok: boolean | null; out: string[] } | null }
  | { key: string; kind: "marker"; at: string; words: string };

export type Conversation = {
  items: ConversationItem[];
  notes: ConversationNote[];
  older: number;
  /** What this run's project allowed when it started (the file's first record); null before it is read. */
  detail: "base" | "commands" | null;
  /** off: this console cannot read the transcript; unavailable: never could be read; error: a read failed just now (retrying). */
  state: "loading" | "ready" | "off" | "unavailable" | "error";
  /** The agent finished and every record has been read. */
  final: boolean;
  offset: number;
  gen: string | null;
  /** The last read ended inside a key block: the next one is told, so the block stays hidden. */
  inKey: boolean;
  /** The end of the last line read, so a key marker split across reads is still seen. */
  keyTail: string;
  /** Every item's own number, never reused even after older items are dropped: React keys come from it. */
  seq: number;
  /** Bumps whenever something shown changed: the scroll pin follows it. */
  revision: number;
};

export const KEEP_ITEMS = 1500;
/** The shape of a carried key tail (live-records.ts validKeyTail): checked again here, never trusted as given. */
const KEY_TAIL = /^(?:(?:-{0,5}|-----B|-----BE|-----BEG|-----BEGI)\|(?:-{0,5}|-----B|-----BE|-----BEG|-----BEGI)\|(?:-{0,5}|-----B|-----BE|-----BEG|-----BEGI)\|[COE]?)?$/;

export const emptyConversation = (url: string | null): Conversation => ({
  items: [], notes: [], older: 0, detail: null, state: url === null ? "unavailable" : "loading", final: false, offset: 0, gen: null, inKey: false, keyTail: "", seq: 0, revision: 0,
});

/** One window's answer folded into the conversation: steps by id (a result updates its row), notes replaced whole. */
export function applyWindow(previous: Conversation, answer: WindowAnswer): Conversation {
  const next: Conversation = { ...previous, items: previous.items.slice(), revision: previous.revision + 1 };
  if (Array.isArray(answer.notes)) next.notes = answer.notes;
  if (typeof answer.older === "number") next.older = answer.older;
  if (answer.error === "off") return { ...next, state: "off" };
  const index = new Map<string, number>();
  next.items.forEach((item, at) => { if (item.kind === "step") index.set(item.key, at); });
  for (const record of answer.records ?? []) {
    switch (record.k) {
      case "open": next.detail = record.detail; break;
      case "start": next.items.push({ key: `m${next.seq++}`, kind: "marker", at: record.at, words: "The agent started" }); break;
      case "say": next.items.push({ key: `t${next.seq++}`, kind: "say", at: record.at, lines: record.t }); break;
      case "step":
        index.set(record.id, next.items.length);
        next.items.push({ key: record.id, kind: "step", at: record.at, step: record.kind, target: record.target ?? null, once: record.once === true, done: null });
        break;
      case "done": {
        const at = index.get(record.id);
        const item = at === undefined ? undefined : next.items[at];
        if (item !== undefined && item.kind === "step") next.items[at!] = { ...item, done: { at: record.at, ok: record.ok, out: record.out ?? [] } };
        break;
      }
      case "cut": next.items.push({ key: `c${next.seq++}`, kind: "marker", at: record.at, words: "A line was too long to show" }); break;
      case "cap": next.items.push({ key: `p${next.seq++}`, kind: "marker", at: record.at, words: "The live view stopped at its size limit. The run's record continues." }); break;
    }
  }
  if (next.items.length > KEEP_ITEMS) next.items = next.items.slice(-KEEP_ITEMS);
  if (typeof answer.nextOffset === "number" && answer.nextOffset >= next.offset) next.offset = answer.nextOffset;
  if (typeof answer.gen === "string") next.gen = answer.gen;
  // An answer that does not say keeps what the last one said: a failed read never forgets an open key block.
  if (typeof answer.inKey === "boolean") next.inKey = answer.inKey;
  // Only a tail this code could have produced rides the cursor: three "-----BEGIN" prefixes and an escape flag.
  if (typeof answer.keyTail === "string") next.keyTail = KEY_TAIL.test(answer.keyTail) ? answer.keyTail : "";
  next.final = answer.final === true;
  next.state = "ready";
  return next;
}

/** At most this many windows are read in one go before the page gets a turn; reading continues right after. */
const WINDOWS_PER_TURN = 50;

/**
 * Follow one run's conversation. Each effect run is its own generation: an answer from an earlier one is dropped. A
 * refused or failed read keeps what was shown and says so; a replaced file starts over visibly. While `paused` no
 * request is made at all; the reading goes on from the same place once it is not.
 */
export function useConversation(url: string | null, live: boolean, paused = false): Conversation {
  const [shown, setShown] = useState<Conversation>(() => emptyConversation(url));
  const hold = useRef(paused);
  hold.current = paused;
  /** Start reading again after a pause (set by the reading effect while it waits on one). */
  const resume = useRef<(() => void) | null>(null);
  useEffect(() => {
    let current = emptyConversation(url);
    setShown(current);
    resume.current = null;
    if (url === null) return;
    let stopped = false, timer = 0;
    const publish = (next: Conversation) => { current = next; if (!stopped) setShown(next); };
    const turn = async (): Promise<void> => {
      // Paused: nothing is asked; the pause's end starts the next turn.
      if (hold.current) { resume.current = () => { resume.current = null; if (!stopped) void turn(); }; return; }
      let delay = 2_000;
      try {
        for (let page = 0; page < WINDOWS_PER_TURN && !stopped; page += 1) {
          if (hold.current) { resume.current = () => { resume.current = null; if (!stopped) void turn(); }; return; }
          const gen = `${current.gen === null ? "" : `&gen=${encodeURIComponent(current.gen)}`}${current.inKey ? "&inkey=1" : ""}${current.keyTail === "" ? "" : `&ktail=${encodeURIComponent(current.keyTail)}`}`;
          const answer = await fetch(`${url}&from=${current.offset}${gen}`, { cache: "no-store", credentials: "same-origin", redirect: "manual" });
          if (stopped) return;
          if (answer.status === 409) {
            publish({ ...emptyConversation(url), notes: current.notes, revision: current.revision + 1,
              items: [{ key: `restart:${current.revision}`, kind: "marker", at: "", words: "The view restarted" }] });
            continue;
          }
          if (!answer.ok) { publish({ ...current, state: current.items.length === 0 ? "unavailable" : "error", revision: current.revision + 1 }); break; }
          const data = await answer.json() as WindowAnswer;
          if (stopped) return;
          const before = current.offset;
          publish(applyWindow(current, data));
          if (current.state === "off" || current.final) break;
          // More waits in the file: read on at once, in the next turn if this one is spent.
          if (current.offset === before) break;
          if (page === WINDOWS_PER_TURN - 1) delay = 0;
        }
      } catch {
        // What was shown stays; the view says the last read failed until one succeeds.
        publish({ ...current, state: current.items.length === 0 ? "unavailable" : "error", revision: current.revision + 1 });
      }
      // A finished run is read to its end; notes keep their standing fresh only while it runs.
      if (stopped || (current.final && !live) || (current.state === "off" && !live)) return;
      timer = window.setTimeout(() => void turn(), delay);
    };
    void turn();
    return () => { stopped = true; resume.current = null; window.clearTimeout(timer); };
  }, [url, live]);
  useEffect(() => { if (!paused) resume.current?.(); }, [paused]);
  return shown;
}

/** A password field anywhere on the page (a ceremony, or the password popover while it is open): while one is there the
 * work's reader asks for nothing. Read again whenever the page changes. */
const passwordShown = (): boolean => typeof document !== "undefined" && document.querySelector('input[type="password" i]') !== null;
export function usePasswordAsked(): boolean {
  const [asked, setAsked] = useState(passwordShown);
  useEffect(() => {
    const read = () => setAsked(passwordShown());
    read();
    const watch = new MutationObserver(read);
    watch.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["type"] });
    return () => watch.disconnect();
  }, []);
  return asked;
}

const KIND_WORDS: Record<Kind, string> = {
  session: "Started", message: "Said", edit: "Edited files", command: "Ran a command", read: "Read the code", search: "Searched the code",
  lookup: "Looked something up", plan: "Updated its plan", delegate: "Asked a helper", tool: "Used a tool",
};
const KIND_VERBS: Partial<Record<Kind, string>> = { edit: "Edited", read: "Read", search: "Searched for", lookup: "Looked up", delegate: "Asked a helper:" };

const clock = (iso: string): string => {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? "" : new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};
const lasted = (from: string, to: string): string | null => {
  const ms = Date.parse(to) - Date.parse(from);
  if (Number.isNaN(ms) || ms < 0) return null;
  return ms < 1_000 ? "<1s" : ms < 60_000 ? `${Math.round(ms / 1_000)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1_000)}s`;
};

/** One action as one quiet line: the kind's words and its target, how it ended, how long it took. */
function StepLine({ item, final }: { item: Extract<ConversationItem, { kind: "step" }>; final: boolean }) {
  const verb = KIND_VERBS[item.step];
  const command = item.step === "command" && item.target !== null;
  const done = item.done;
  // How it ended: running while it can still answer; an unknown end is never shown as success.
  const status = item.once ? null
    : done === null ? (final ? { words: "No result", tone: "muted" } : { words: "Running", tone: "running" })
      : done.ok === true ? { words: "Done", tone: "ok" } : done.ok === false ? { words: "Failed", tone: "failed" } : { words: "Ended without a result", tone: "muted" };
  const time = done === null || done.ok === null ? null : lasted(item.at, done.at);
  const out = done?.out ?? [];
  const [open, setOpen] = useState(false);
  return <li className={cn("k-work-step", status?.tone === "running" && "running")} data-step={item.step}>
    <span className="k-work-step-l">
      {status?.tone === "running" && <span className="k-work-dot" aria-hidden="true" />}
      <span className="k-work-step-t">
        {item.target === null ? KIND_WORDS[item.step]
          : command ? <code className="k-mono" data-step-target>{item.target}</code>
            : <>{verb ?? KIND_WORDS[item.step]} <code className="k-mono" data-step-target>{item.target}</code></>}
      </span>
      {status !== null && <span className={cn("k-work-step-s", status.tone)} data-step-status={status.tone}>
        {status.tone === "ok" ? <KIcon name="check" small /> : status.tone === "failed" ? <KIcon name="x" small /> : null}
        <span className={status.tone === "ok" ? "k-sr" : undefined}>{status.words}</span>{time !== null && <span className="k-num">{time}</span>}
      </span>}
      {out.length > 0 && <KButton variant="ghost" sm label={open ? "Hide output" : "Show output"} aria-expanded={open} onClick={() => setOpen(value => !value)} data-step-toggle />}
    </span>
    {out.length > 0 && <div hidden={!open} className="k-work-out" data-step-output>{out.join("\n")}</div>}
  </li>;
}

/** A note a person sent: a bubble on the right, who sent it and whether the agent read it under it. */
function NoteBubble({ note }: { note: ConversationNote }) {
  return <li className="k-work-note" data-conversation-note={String(note.id)}>
    <p className="k-work-bubble">{note.text}</p>
    <p className="k-work-note-s"><span>{note.mine ? "You" : note.author}</span> · <span data-note-standing>{note.standing}{note.readAt === null ? "" : ` ${clock(note.readAt)}`}</span></p>
  </li>;
}

type Block = { key: string; node: ReactNode };

/** Items and notes in one time order, consecutive actions grouped; an item with no time (a restart line) keeps its place. */
function blocks(conversation: Conversation): Block[] {
  const notes = conversation.notes.slice().sort((a, b) => a.at.localeCompare(b.at));
  const out: Block[] = [];
  let steps: Extract<ConversationItem, { kind: "step" }>[] = [];
  const flush = () => {
    if (steps.length === 0) return;
    const group = steps;
    steps = [];
    out.push({ key: `steps:${group[0]!.key}`, node: <li key={`steps:${group[0]!.key}`} className="k-work-steps-li"><ul className="k-work-steps">
      {group.map(item => <StepLine key={item.key} item={item} final={conversation.final} />)}</ul></li> });
  };
  const note = (one: ConversationNote) => { flush(); out.push({ key: `note:${one.id}`, node: <NoteBubble key={`note:${one.id}`} note={one} /> }); };
  let next = 0;
  for (const item of conversation.items) {
    while (next < notes.length && item.at !== "" && notes[next]!.at < item.at) note(notes[next++]!);
    if (item.kind === "step") { steps.push(item); continue; }
    flush();
    out.push({ key: item.key, node: item.kind === "say"
      ? <li key={item.key} className="k-work-say" data-work-say>{item.lines.join("\n")}</li>
      : <li key={item.key} className="k-work-mark" data-conversation-marker="">{item.words}</li> });
  }
  for (; next < notes.length; next += 1) note(notes[next]!);
  flush();
  return out;
}

/** Output lines a terminal line shows under its step: the tail, as the records carry it. */
export const TERMINAL_TAIL = 12;

/**
 * The terminal view (cockpit §5): the same records, dense and monospace — what the agent said, each step as one line
 * (a command as `$ command`), how it ended, and its output's last lines; notes inline. It reads only what the
 * conversation reads (sanitized, text only, commands only where the project allows them), and never types anything.
 */
function TerminalLines({ conversation }: { conversation: Conversation }) {
  const lines: ReactNode[] = [];
  const notes = conversation.notes.slice().sort((a, b) => a.at.localeCompare(b.at));
  let next = 0;
  const note = (one: ConversationNote) => lines.push(<li key={`note:${one.id}`} className="k-work-term-note" data-terminal-note>
    {`» ${one.mine ? "you" : one.author}: ${one.text}`}<span className="k-muted">{`  (${one.standing}${one.readAt === null ? "" : ` ${clock(one.readAt)}`})`}</span></li>);
  for (const item of conversation.items) {
    while (next < notes.length && item.at !== "" && notes[next]!.at < item.at) note(notes[next++]!);
    if (item.kind === "say") { lines.push(<li key={item.key} data-terminal-say>{item.lines.join("\n")}</li>); continue; }
    if (item.kind === "marker") { lines.push(<li key={item.key} className="k-muted" data-terminal-marker>{`— ${item.words} —`}</li>); continue; }
    const done = item.done;
    const status = item.once ? "" : done === null ? (conversation.final ? "  [no result]" : "  [running]") : done.ok === true ? "" : done.ok === false ? "  [failed]" : "  [ended without a result]";
    const head = item.step === "command" && item.target !== null ? `$ ${item.target}`
      : `› ${KIND_VERBS[item.step] ?? KIND_WORDS[item.step]}${item.target === null ? "" : ` ${item.target}`}`;
    const out = done?.out ?? [];
    const tail = out.slice(-TERMINAL_TAIL);
    lines.push(<li key={item.key} data-terminal-step={item.step}>
      <span className={item.step === "command" ? undefined : "k-muted"}>{head}</span>
      {status !== "" && <span className={done?.ok === false ? "k-work-term-failed" : "k-muted"}>{status}</span>}
      {tail.length > 0 && <span className="k-work-term-out k-muted" data-terminal-output>{out.length > tail.length ? `… ${out.length - tail.length} earlier lines\n` : ""}{tail.join("\n")}</span>}
    </li>);
  }
  for (; next < notes.length; next += 1) note(notes[next]!);
  return <ol className="k-work-term" data-terminal>{lines}</ol>;
}

/** What the view says where there is nothing to show, or why it shows nothing more. */
export function workEmptyWords(conversation: Conversation, live: boolean, paused: boolean): string {
  if (paused) return "The live view waits while this page asks for your password.";
  if (conversation.state === "off") return `The agent's words aren't shown here: it ${live ? "runs" : "ran"} on another computer.`;
  if (conversation.state === "unavailable" || conversation.state === "error") return "Couldn't read the work just now. Trying again.";
  if (conversation.state === "loading") return "Reading the work…";
  return live ? "Nothing yet. What the agent says and does shows here as it works." : "This agent left no record of its work.";
}

/**
 * One conversation drawn: the records and the notes, the reason when there is nothing, and whether commands were hidden.
 * `view`: the terminal look instead of the chat. The scroll pin keeps the newest line in sight while the reader is at
 * the end, in this list or in whatever scrolls around it (`[data-agent-scroll]`).
 */
export function KWorkRecords({ conversation, live, paused = false, view = "conversation", older }: { conversation: Conversation; live: boolean; paused?: boolean;
  view?: "conversation" | "terminal";
  /** How the notes left out of this view are said ("3 earlier notes are on the task page."). */
  older?: (count: number) => string }) {
  const box = useRef<HTMLDivElement | null>(null);
  const pinned = useRef(true);
  const unwatch = useRef<(() => void) | null>(null);
  // The list scrolls itself on the Agents page; in a panel the panel's body does. Pin whichever is scrolling.
  const scroller = (): HTMLElement | null => {
    const node = box.current;
    if (node === null) return null;
    return node.scrollHeight > node.clientHeight + 1 ? node : node.closest<HTMLElement>("[data-agent-scroll]") ?? node;
  };
  /** Put the end of this list at the bottom of what scrolls (the list may be followed by more in the same body). */
  const toEnd = () => {
    const node = box.current, outer = scroller();
    if (node === null || outer === null) return;
    if (outer === node) { node.scrollTop = node.scrollHeight; return; }
    const below = outer.getBoundingClientRect().bottom - node.getBoundingClientRect().bottom;
    outer.scrollTop = Math.max(0, outer.scrollTop - below);
  };
  const atEnd = (outer: HTMLElement): boolean => {
    const node = box.current;
    if (node === null) return true;
    if (outer === node) return outer.scrollTop + outer.clientHeight >= outer.scrollHeight - 24;
    return node.getBoundingClientRect().bottom <= outer.getBoundingClientRect().bottom + 24;
  };
  // Attached when the list itself mounts (it is absent while empty), so the outer view's scroll is heard too.
  const attach = (node: HTMLDivElement | null) => {
    unwatch.current?.();
    unwatch.current = null;
    box.current = node;
    const outer = node?.closest<HTMLElement>("[data-agent-scroll]") ?? null;
    if (outer === null) return;
    const watch = () => { if (scroller() === outer) pinned.current = atEnd(outer); };
    outer.addEventListener("scroll", watch, { passive: true });
    unwatch.current = () => outer.removeEventListener("scroll", watch);
  };
  useEffect(() => () => unwatch.current?.(), []);
  // Only while it runs: a finished run's record reads from the top.
  useLayoutEffect(() => { if (pinned.current && live) toEnd(); }, [conversation.revision, view]);
  const shown = view === "conversation" ? blocks(conversation) : [];
  const failed = workEmptyWords({ ...conversation, state: "error" }, live, false);
  const empty = workEmptyWords(conversation, live, paused);
  const nothing = view === "conversation" ? shown.length === 0 : conversation.items.length === 0 && conversation.notes.length === 0;
  return <>
    {nothing ? <p className="k-work-empty" data-transcript-empty>{empty}</p>
      : <div ref={attach} tabIndex={0} aria-label="The agent's work" data-agent-transcript className="k-work-tx"
        onScroll={event => { const node = event.currentTarget; if (scroller() === node) pinned.current = atEnd(node); }}>
        {conversation.older > 0 && <p className="k-note">{older?.(conversation.older) ?? `${conversation.older} earlier ${conversation.older === 1 ? "note is" : "notes are"} on the task page.`}</p>}
        {view === "terminal" ? <TerminalLines conversation={conversation} /> : <ol className="k-work-lines">{shown.map(one => one.node)}</ol>}
        {paused && <p className="k-note" data-conversation-state="paused">{empty}</p>}
        {!paused && conversation.state === "off" && <p className="k-note" data-conversation-state="off">{empty}</p>}
        {!paused && (conversation.state === "error" || conversation.state === "unavailable") && <p role="status" className="k-note" data-conversation-state="error">{failed}</p>}
      </div>}
    {conversation.detail === "base" && <p className="k-note" data-conversation-detail="base">
      Commands were hidden for this run. <a className="k-link" href="/settings/project">Change this in project settings</a>
    </p>}
  </>;
}

const VIEW_SETTING = "toolroll.agent.view";
function savedView(): "conversation" | "terminal" {
  try { return window.localStorage.getItem(VIEW_SETTING) === "terminal" ? "terminal" : "conversation"; } catch { return "conversation"; }
}

/** One run's work, followed and drawn, with the Conversation / Terminal choice (kept in this browser). The Agents page's
 * view; a panel follows the conversation itself (`useConversation`) and draws it with `KWorkRecords`. */
export function KWorkConversation({ url, live, paused = false }: { url: string | null; live: boolean; paused?: boolean }) {
  const conversation = useConversation(url, live, paused);
  const [view, setView] = useState<"conversation" | "terminal">(savedView);
  const choose = (next: "conversation" | "terminal") => { setView(next); try { window.localStorage.setItem(VIEW_SETTING, next); } catch { /* this browser keeps no settings */ } };
  return <section aria-label="Conversation" className="k-work-conv">
    <div className="k-work-conv-h">
      <h3 className="k-sr">{view === "terminal" ? "Terminal" : "Conversation"}</h3>
      <span data-conversation-view={view}>
        <KSeg label="How to show it" current={view} onChange={key => choose(key === "terminal" ? "terminal" : "conversation")}
          items={[{ key: "conversation", label: "Conversation" }, { key: "terminal", label: "Terminal" }]} />
      </span>
    </div>
    <KWorkRecords conversation={conversation} live={live} paused={paused} view={view} />
  </section>;
}

/**
 * The work's frame: a header (the title, who is working with a blue dot while it runs, Close), the body that scrolls,
 * and the message box at the foot. `hidden` keeps it mounted and out of sight. Same markup as the server's `work`.
 */
export function KWork({ id, title, who, live = false, onClose, closeLabel = "Close", closeData = {}, hidden = false, foot, children, onClick, ...data }: {
  id: string; title: string; who?: ReactNode; live?: boolean; onClose?: () => void; closeLabel?: string; hidden?: boolean; foot?: ReactNode; children?: ReactNode;
  /** A page's own click handling for what the frame holds (its in-page links). */
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  /** Data attributes for the Close button (a page's own hook for it). */
  closeData?: Record<`data-${string}`, string>;
} & Record<`data-${string}`, string | undefined>) {
  return <aside className="k-work" id={id} aria-labelledby={`${id}-h`} hidden={hidden} onClick={onClick} {...data}>
    <header className="k-work-head">
      <div className="k-work-title"><h2 id={`${id}-h`}>{title}</h2>
        {who !== undefined && who !== null && who !== "" && <p className="k-work-who">{live && <span className="k-work-dot" aria-hidden="true" />}<span>{who}</span></p>}</div>
      {onClose !== undefined && <KButton variant="ghost" sm iconOnly="x" label={closeLabel} onClick={onClose} {...closeData} />}
    </header>
    <div className="k-work-body" data-agent-scroll="">{children}</div>
    {foot !== undefined && foot !== null && <div className="k-work-foot">{foot}</div>}
  </aside>;
}
