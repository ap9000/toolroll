/**
 * The opened agent's conversation (docs/plans/live-conversation.md §7): what it
 * said, each step it took — its file, search or command, and how it ended —
 * and the notes people sent it, in time order with whether the agent read
 * them. It reads the run page's records window from a byte offset every 2 s
 * while the agent runs, and to the end once it has finished. Everything is
 * rendered as text; nothing from the window becomes markup.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { KButton, KIcon, KSeg } from "../kit/index.js";
import { cn } from "../kit/utils.js";

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
 * Follow one run's conversation. Each effect run is its own generation: an
 * answer from an earlier one is dropped. A refused or failed read keeps what
 * was shown and says so; a replaced file starts over visibly.
 */
export function useConversation(url: string | null, live: boolean): Conversation {
  const [shown, setShown] = useState<Conversation>(() => emptyConversation(url));
  useEffect(() => {
    let current = emptyConversation(url);
    setShown(current);
    if (url === null) return;
    let stopped = false, timer = 0;
    const publish = (next: Conversation) => { current = next; if (!stopped) setShown(next); };
    const turn = async (): Promise<void> => {
      let delay = 2_000;
      try {
        for (let page = 0; page < WINDOWS_PER_TURN && !stopped; page += 1) {
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
        // What was shown stays; the pane says the last read failed until one succeeds.
        publish({ ...current, state: current.items.length === 0 ? "unavailable" : "error", revision: current.revision + 1 });
      }
      // A finished run is read to its end; notes keep their standing fresh only while it runs.
      if (stopped || (current.final && !live) || (current.state === "off" && !live)) return;
      timer = window.setTimeout(() => void turn(), delay);
    };
    void turn();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [url, live]);
  return shown;
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

/** One quiet timed row: when · who · what (UI revamp wave B). */
function Line({ at, who, kind, children, ...data }: { at: string; who: string; kind: "say" | "tool" | "note" | "you" | "mark"; children: ReactNode } & Record<`data-${string}`, string | undefined>) {
  return <li className={cn("agents-l", `agents-l-${kind}`)} {...data}>
    <time className="agents-lt k-num" dateTime={at || undefined}>{clock(at)}</time><span className="agents-lw">{who}</span><div className="agents-lx">{children}</div>
  </li>;
}

function StepRow({ item, final }: { item: Extract<ConversationItem, { kind: "step" }>; final: boolean }) {
  const verb = KIND_VERBS[item.step];
  const command = item.step === "command" && item.target !== null;
  const done = item.done;
  // How it ended: running while it can still answer; an unknown end is never shown as success.
  const status = item.once ? null
    : done === null ? (final ? { words: "No result", tone: "muted" } : { words: "Running…", tone: "running" })
      : done.ok === true ? { words: "Done", tone: "ok" } : done.ok === false ? { words: "Failed", tone: "failed" } : { words: "Ended without a result", tone: "muted" };
  const time = done === null || done.ok === null ? null : lasted(item.at, done.at);
  const head = <span className="agents-step">
    <span className="agents-step-t">
      {item.target === null ? <span className="k-muted">{KIND_WORDS[item.step]}</span>
        : command ? <code className="k-mono" data-step-target>{item.target}</code>
          : <><span className="k-muted">{verb ?? KIND_WORDS[item.step]} </span><code className="k-mono" data-step-target>{item.target}</code></>}
    </span>
    {status !== null && <span className={cn("agents-step-s", `agents-step-${status.tone}`)} data-step-status={status.tone}>
      {status.tone === "ok" ? <KIcon name="check" small /> : status.tone === "failed" ? <KIcon name="x" small /> : null}
      <span className={status.tone === "ok" ? "k-sr" : undefined}>{status.words}</span>{time !== null && <span className="k-num">{time}</span>}
    </span>}
  </span>;
  const out = done?.out ?? [];
  return <Line at={item.at} who="Tool" kind="tool" data-step={item.step}>{out.length === 0 ? head : <StepOutput head={head} out={out} />}</Line>;
}

/** A step with output: Show output opens its last lines under the row. */
function StepOutput({ head, out }: { head: ReactNode; out: string[] }) {
  const [open, setOpen] = useState(false);
  return <>
    {head}
    <span className="agents-step-more"><KButton variant="ghost" sm label={open ? "Hide output" : "Show output"} aria-expanded={open} onClick={() => setOpen(value => !value)} data-step-toggle /></span>
    <div hidden={!open} className="agents-out" data-step-output>{out.join("\n")}</div>
  </>;
}

function NoteRow({ note }: { note: ConversationNote }) {
  return <Line at={note.at} who={note.mine ? "You" : note.author} kind="you" data-conversation-note={String(note.id)}>
    <span className="agents-note-x">{note.text}</span>
    <span className="agents-note-s" data-note-standing>{note.standing}{note.readAt === null ? "" : ` ${clock(note.readAt)}`}</span>
  </Line>;
}

type Shown = { key: string; at: string; node: ReactNode };

/** Items and notes in one time order; an item with no time (an older run's plain line) keeps its place. */
function merged(conversation: Conversation, agent: string): Shown[] {
  const notes = conversation.notes.slice().sort((a, b) => a.at.localeCompare(b.at));
  const out: Shown[] = [];
  let next = 0;
  for (const item of conversation.items) {
    while (next < notes.length && item.at !== "" && notes[next]!.at < item.at) {
      const note = notes[next++]!;
      out.push({ key: `note:${note.id}`, at: note.at, node: <NoteRow key={`note:${note.id}`} note={note} /> });
    }
    const node = item.kind === "say"
      ? <Line key={item.key} at={item.at} who={agent} kind="say">{item.lines.join("\n")}</Line>
      : item.kind === "step" ? <StepRow key={item.key} item={item} final={conversation.final} />
        : <Line key={item.key} at={item.at} who="Toolroll" kind="mark" data-conversation-marker="">{item.words}</Line>;
    out.push({ key: item.key, at: item.at, node });
  }
  for (; next < notes.length; next += 1) {
    const note = notes[next]!;
    out.push({ key: `note:${note.id}`, at: note.at, node: <NoteRow key={`note:${note.id}`} note={note} /> });
  }
  return out;
}

/** Output lines a terminal line shows under its step: the tail, as the records carry it. */
export const TERMINAL_TAIL = 12;
const VIEW_SETTING = "toolroll.agent.view";
function savedView(): "conversation" | "terminal" {
  try { return window.localStorage.getItem(VIEW_SETTING) === "terminal" ? "terminal" : "conversation"; } catch { return "conversation"; }
}

/**
 * The terminal view (cockpit §5): the same records, dense and monospace — what the agent said, each step as one line
 * (a command as `$ command`), how it ended, and its output's last lines; notes inline. It reads only what the
 * conversation reads (sanitized, text only, commands only where the project allows them), and never types anything.
 */
function TerminalLines({ conversation }: { conversation: Conversation }) {
  const lines: ReactNode[] = [];
  const notes = conversation.notes.slice().sort((a, b) => a.at.localeCompare(b.at));
  let next = 0;
  const note = (one: ConversationNote) => lines.push(<li key={`note:${one.id}`} className="agents-t-note" data-terminal-note>
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
      {status !== "" && <span className={done?.ok === false ? "agents-step-failed" : "k-muted"}>{status}</span>}
      {tail.length > 0 && <span className="agents-t-out k-muted" data-terminal-output>{out.length > tail.length ? `… ${out.length - tail.length} earlier lines\n` : ""}{tail.join("\n")}</span>}
    </li>);
  }
  for (; next < notes.length; next += 1) note(notes[next]!);
  return <ol className="agents-term" data-terminal>{lines}</ol>;
}

export function ConversationPane({ url, live, agent = "Agent" }: { url: string | null; live: boolean; agent?: string }) {
  const conversation = useConversation(url, live);
  const box = useRef<HTMLDivElement | null>(null);
  const pinned = useRef(true);
  const unwatch = useRef<(() => void) | null>(null);
  // The pane scrolls on a desk; on a phone the whole agent view does. Pin whichever is scrolling.
  const scroller = (): HTMLElement | null => {
    const node = box.current;
    if (node === null) return null;
    return node.scrollHeight > node.clientHeight + 1 ? node : node.closest<HTMLElement>("[data-agent-scroll]") ?? node;
  };
  // Attached when the conversation itself mounts (it is absent while empty), so the outer view's scroll is heard too.
  const attach = (node: HTMLDivElement | null) => {
    unwatch.current?.();
    unwatch.current = null;
    box.current = node;
    const outer = node?.closest<HTMLElement>("[data-agent-scroll]") ?? null;
    if (outer === null) return;
    const watch = () => { if (scroller() === outer) pinned.current = outer.scrollTop + outer.clientHeight >= outer.scrollHeight - 24; };
    outer.addEventListener("scroll", watch, { passive: true });
    unwatch.current = () => outer.removeEventListener("scroll", watch);
  };
  useEffect(() => () => unwatch.current?.(), []);
  useLayoutEffect(() => {
    const node = scroller();
    if (node !== null && pinned.current) node.scrollTop = node.scrollHeight;
  }, [conversation.revision]);
  const shown = merged(conversation, agent);
  const [view, setView] = useState<"conversation" | "terminal">(savedView);
  const choose = (next: "conversation" | "terminal") => { setView(next); try { window.localStorage.setItem(VIEW_SETTING, next); } catch { /* this browser keeps no settings */ } };
  // Switching views keeps the pin: a reader at the end stays at the end.
  useLayoutEffect(() => {
    const node = scroller();
    if (node !== null && pinned.current) node.scrollTop = node.scrollHeight;
  }, [view]);
  const failed = "Couldn't read the conversation just now. Trying again.";
  const empty = conversation.state === "off" ? "Output from other computers isn't shown yet."
    : conversation.state === "unavailable" || conversation.state === "error" ? failed
    : conversation.state === "loading" ? "Reading the conversation…" : live ? "Nothing yet. What the agent says and does shows here as it works." : "This agent left no transcript.";
  return <section aria-label="Conversation" className="agents-conv">
    <div className="agents-conv-h">
      <h3 className="k-sr">{view === "terminal" ? "Terminal" : "Conversation"}</h3>
      <span data-conversation-view={view}>
        <KSeg label="How to show it" current={view} onChange={key => choose(key === "terminal" ? "terminal" : "conversation")}
          items={[{ key: "conversation", label: "Conversation" }, { key: "terminal", label: "Terminal" }]} />
      </span>
    </div>
    {shown.length === 0 ? <p className="agents-conv-empty" data-transcript-empty>{empty}</p>
      : <div ref={attach} tabIndex={0} aria-label="Agent conversation" data-agent-transcript className="agents-tx"
        onScroll={event => { const node = event.currentTarget; if (scroller() === node) pinned.current = node.scrollTop + node.clientHeight >= node.scrollHeight - 24; }}>
        {conversation.older > 0 && <p className="k-note">{conversation.older} earlier {conversation.older === 1 ? "note is" : "notes are"} on the task page.</p>}
        {view === "terminal" ? <TerminalLines conversation={conversation} /> : <ol className="agents-lines">{shown.map(one => one.node)}</ol>}
        {conversation.state === "off" && <p className="k-note" data-conversation-state="off">{empty}</p>}
        {(conversation.state === "error" || conversation.state === "unavailable") && <p role="status" className="k-note" data-conversation-state="error">{failed}</p>}
      </div>}
    {conversation.detail === "base" && <p className="k-note" data-conversation-detail="base">
      Commands were hidden for this run. <a className="k-link" href="/settings/project">Change this in project settings</a>
    </p>}
  </section>;
}
