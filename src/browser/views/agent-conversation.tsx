/**
 * The opened agent's conversation (docs/plans/live-conversation.md §7): what it
 * said, each step it took — its file, search or command, and how it ended —
 * and the notes people sent it, in time order with whether the agent read
 * them. It reads the run page's records window from a byte offset every 2 s
 * while the agent runs, and to the end once it has finished. Everything is
 * rendered as text; nothing from the window becomes markup.
 */
import { Bot, Check, ChevronDown, ChevronRight, FileText, Globe, ListTodo, Pencil, Search, Terminal, Wrench, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ComponentType } from "react";
import { cn } from "../components/ui/index.js";

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

const KIND_ICONS: Record<Kind, ComponentType<{ className?: string; "aria-hidden"?: boolean }>> = {
  session: Bot, message: Bot, edit: Pencil, command: Terminal, read: FileText, search: Search, lookup: Globe, plan: ListTodo, delegate: Bot, tool: Wrench,
};
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

function StepRow({ item, final }: { item: Extract<ConversationItem, { kind: "step" }>; final: boolean }) {
  const Icon = KIND_ICONS[item.step];
  const verb = KIND_VERBS[item.step];
  const command = item.step === "command" && item.target !== null;
  const done = item.done;
  // How it ended: running while it can still answer; an unknown end is never shown as success.
  const status = item.once ? null
    : done === null ? (final ? { words: "No result", tone: "muted" } : { words: "Running…", tone: "running" })
      : done.ok === true ? { words: "Done", tone: "ok" } : done.ok === false ? { words: "Failed", tone: "failed" } : { words: "Ended without a result", tone: "muted" };
  const time = done === null || done.ok === null ? null : lasted(item.at, done.at);
  const head = <span className="flex min-w-0 items-start gap-2">
    <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden={true} />
    <span className="min-w-0 flex-1 break-words">
      {item.target === null ? <span className="text-muted-foreground">{KIND_WORDS[item.step]}</span>
        : command ? <code className="font-mono text-mono text-foreground" data-step-target>{item.target}</code>
          : <><span className="text-muted-foreground">{verb ?? KIND_WORDS[item.step]} </span><code className="font-mono text-mono text-foreground" data-step-target>{item.target}</code></>}
    </span>
    {status !== null && <span className={cn("flex shrink-0 items-center gap-1 text-caption tabular-nums",
      status.tone === "ok" ? "text-success" : status.tone === "failed" ? "text-danger" : status.tone === "running" ? "text-info" : "text-muted-foreground")} data-step-status={status.tone}>
      {status.tone === "ok" ? <Check className="size-3.5" aria-hidden={true} /> : status.tone === "failed" ? <X className="size-3.5" aria-hidden={true} /> : null}
      <span className={status.tone === "ok" ? "sr-only" : undefined}>{status.words}</span>{time !== null && <span>{time}</span>}
    </span>}
  </span>;
  const out = done?.out ?? [];
  if (out.length === 0) return <li className="py-1" data-step={item.step}>{head}</li>;
  return <li className="py-1" data-step={item.step}>
    <StepOutput head={head} out={out} />
  </li>;
}

/** A step with output: the row itself shows and hides the output's last lines. */
function StepOutput({ head, out }: { head: React.ReactNode; out: string[] }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)} data-step-toggle
      className="flex w-full min-w-0 flex-col items-stretch gap-0.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring phone:min-h-11">
      {head}
      <span className="flex items-center gap-1 pl-5.5 text-caption text-muted-foreground">
        {open ? <ChevronDown className="size-3" aria-hidden={true} /> : <ChevronRight className="size-3" aria-hidden={true} />}{open ? "Hide output" : "Show output"}
      </span>
    </button>
    <pre hidden={!open} className="mt-1.5 ml-5.5 max-h-72 overflow-auto rounded-md border border-border bg-muted px-2.5 py-2 font-mono text-mono leading-[1.5] whitespace-pre-wrap break-words" data-step-output>{out.join("\n")}</pre>
  </>;
}

function NoteBubble({ note }: { note: ConversationNote }) {
  return <li className="flex justify-end py-1.5" data-conversation-note={note.id}>
    <div className="max-w-[85%] rounded-card border border-border bg-muted px-3 py-2">
      <p className="text-caption text-muted-foreground">{note.mine ? "You" : note.author} · {clock(note.at)}</p>
      <p className="mt-0.5 text-body whitespace-pre-wrap break-words text-foreground">{note.text}</p>
      <p className="mt-1 text-caption text-muted-foreground" data-note-standing>{note.standing}{note.readAt === null ? "" : ` ${clock(note.readAt)}`}</p>
    </div>
  </li>;
}

type Shown = { key: string; at: string; node: React.ReactNode };

/** Items and notes in one time order; an item with no time (an older run's plain line) keeps its place. */
function merged(conversation: Conversation): Shown[] {
  const notes = conversation.notes.slice().sort((a, b) => a.at.localeCompare(b.at));
  const out: Shown[] = [];
  let next = 0;
  for (const item of conversation.items) {
    while (next < notes.length && item.at !== "" && notes[next]!.at < item.at) {
      const note = notes[next++]!;
      out.push({ key: `note:${note.id}`, at: note.at, node: <NoteBubble key={`note:${note.id}`} note={note} /> });
    }
    const node = item.kind === "say"
      ? <li key={item.key} className="py-1.5 text-body-reading whitespace-pre-wrap break-words text-foreground">{item.lines.join("\n")}</li>
      : item.kind === "step" ? <StepRow key={item.key} item={item} final={conversation.final} />
        : <li key={item.key} className="py-1 text-caption text-muted-foreground" data-conversation-marker>{item.words}</li>;
    out.push({ key: item.key, at: item.at, node });
  }
  for (; next < notes.length; next += 1) {
    const note = notes[next]!;
    out.push({ key: `note:${note.id}`, at: note.at, node: <NoteBubble key={`note:${note.id}`} note={note} /> });
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
  const lines: React.ReactNode[] = [];
  const notes = conversation.notes.slice().sort((a, b) => a.at.localeCompare(b.at));
  let next = 0;
  const note = (one: ConversationNote) => lines.push(<li key={`note:${one.id}`} className="text-info" data-terminal-note>
    {`» ${one.mine ? "you" : one.author}: ${one.text}`}<span className="text-muted-foreground">{`  (${one.standing}${one.readAt === null ? "" : ` ${clock(one.readAt)}`})`}</span></li>);
  for (const item of conversation.items) {
    while (next < notes.length && item.at !== "" && notes[next]!.at < item.at) note(notes[next++]!);
    if (item.kind === "say") { lines.push(<li key={item.key} className="text-foreground" data-terminal-say>{item.lines.join("\n")}</li>); continue; }
    if (item.kind === "marker") { lines.push(<li key={item.key} className="text-muted-foreground" data-terminal-marker>{`— ${item.words} —`}</li>); continue; }
    const done = item.done;
    const status = item.once ? "" : done === null ? (conversation.final ? "  [no result]" : "  [running]") : done.ok === true ? "" : done.ok === false ? "  [failed]" : "  [ended without a result]";
    const head = item.step === "command" && item.target !== null ? `$ ${item.target}`
      : `› ${KIND_VERBS[item.step] ?? KIND_WORDS[item.step]}${item.target === null ? "" : ` ${item.target}`}`;
    const out = done?.out ?? [];
    const tail = out.slice(-TERMINAL_TAIL);
    lines.push(<li key={item.key} data-terminal-step={item.step}>
      <span className={item.step === "command" ? "text-foreground" : "text-muted-foreground"}>{head}</span>
      {status !== "" && <span className={done?.ok === false ? "text-danger" : "text-muted-foreground"}>{status}</span>}
      {tail.length > 0 && <span className="block pl-3 text-muted-foreground" data-terminal-output>{out.length > tail.length ? `… ${out.length - tail.length} earlier lines\n` : ""}{tail.join("\n")}</span>}
    </li>);
  }
  for (; next < notes.length; next += 1) note(notes[next]!);
  return <ol className="flex flex-col gap-0.5 font-mono text-mono leading-[1.45] whitespace-pre-wrap break-words" data-terminal>{lines}</ol>;
}

export function ConversationPane({ url, live }: { url: string | null; live: boolean }) {
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
  const shown = merged(conversation);
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
  return <section aria-label="Conversation" className="flex min-h-0 flex-col">
    <div className="mb-1.5 flex items-center justify-end gap-2">
      <h3 className="sr-only">{view === "terminal" ? "Terminal" : "Conversation"}</h3>
      <div role="group" aria-label="How to show it" className="flex gap-1" data-conversation-view={view}>
        {(["conversation", "terminal"] as const).map(one => <button key={one} type="button" aria-pressed={view === one} onClick={() => choose(one)}
          className={cn("rounded-md px-2 py-0.5 text-caption phone:min-h-11", view === one ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground")}>
          {one === "terminal" ? "Terminal" : "Conversation"}</button>)}
      </div>
    </div>
    {shown.length === 0 ? <p className="rounded-md border border-dashed border-border px-3 py-6 text-body text-muted-foreground" data-transcript-empty>{empty}</p>
      : <div ref={attach} tabIndex={0} aria-label="Agent conversation" data-agent-transcript
        onScroll={event => { const node = event.currentTarget; if (scroller() === node) pinned.current = node.scrollTop + node.clientHeight >= node.scrollHeight - 24; }}
        className="max-h-[52vh] min-h-40 overflow-y-auto overscroll-contain rounded-md border border-border bg-card px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring phone:max-h-none phone:min-h-0 phone:flex-1">
        {conversation.older > 0 && <p className="py-1 text-caption text-muted-foreground">{conversation.older} earlier {conversation.older === 1 ? "note is" : "notes are"} on the task page.</p>}
        {view === "terminal" ? <TerminalLines conversation={conversation} /> : <ol className="flex flex-col">{shown.map(one => one.node)}</ol>}
        {conversation.state === "off" && <p className="py-1 text-caption text-muted-foreground" data-conversation-state="off">{empty}</p>}
        {(conversation.state === "error" || conversation.state === "unavailable") && <p role="status" className="py-1 text-caption text-warning" data-conversation-state="error">{failed}</p>}
      </div>}
    {conversation.detail === "base" && <p className="mt-1.5 text-caption text-muted-foreground" data-conversation-detail="base">
      Commands were hidden for this run. <a className="inline-flex min-h-11 items-center underline underline-offset-2 desk:min-h-0" href="/settings/project">Change this in project settings</a>
    </p>}
  </section>;
}
