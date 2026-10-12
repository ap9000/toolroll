/** The Agents board: every agent in one place, grouped Needs you, Working,
 * Stuck, Done and Idle, each row with its task, project, last line, elapsed
 * time and diff size. A row opens that agent's live view beside the list (a
 * full-screen view on a phone): its question, transcript and changes, with
 * one composer at the bottom — Reply while it asks, otherwise a note that
 * steers it. The page follows the workspace and the opened agent's own room,
 * so it updates in place; forms keep what is being typed. */
import { ArrowLeft, ArrowUpRight, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AgentGroupKey, BrowserAgentDetail, BrowserAgentRow, BrowserAgentsView } from "../../browser-workspace.js";
import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger, Textarea, cn } from "../components/ui/index.js";
import { GuardedHtml } from "../guarded-html.js";
import { useLiveRoom } from "../live.js";
import { useNow, WORKSPACE_NUDGE } from "../live-task.js";
import { Alert, PostForm } from "../ui/index.js";

const CHIP: Record<AgentGroupKey, string> = {
  "needs-you": "bg-attention-soft text-attention",
  working: "bg-info-soft text-info",
  stuck: "bg-warning-soft text-warning",
  done: "bg-success-soft text-success",
  idle: "bg-neutral-soft text-neutral-ink",
};
const PROBLEM = new Set(["Failed", "Stopped unexpectedly", "Not started"]);
const GROUP_LABEL: Record<AgentGroupKey, string> = { "needs-you": "Needs you", working: "Working", stuck: "Stuck", done: "Done", idle: "Idle" };

/** "38 s", "4 min", "1 h 12 min". */
export function elapsedWords(fromIso: string, to: number): string {
  const seconds = Math.max(0, Math.floor((to - Date.parse(fromIso)) / 1000));
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
}

function StateChip({ row, className }: { row: Pick<BrowserAgentRow, "group" | "label">; className?: string }) {
  return <span data-agent-state={row.label} className={cn("inline-flex w-fit shrink-0 items-center whitespace-nowrap rounded-badge px-1.5 py-px text-badge",
    PROBLEM.has(row.label) ? "bg-danger-soft text-danger" : CHIP[row.group], className)}>{row.label}</span>;
}

/** "Running 4 min", or "Ran 25 min · finished 45 min ago": how long it ran, and when it ended, each labelled. */
export function timeWords(row: Pick<BrowserAgentRow, "startedAt" | "endedAt">, now: number): string {
  if (row.endedAt === null) return `Running ${elapsedWords(row.startedAt, now)}`;
  const since = now - Date.parse(row.endedAt);
  return `Ran ${elapsedWords(row.startedAt, Date.parse(row.endedAt))} · finished ${since < 60_000 ? "just now" : `${elapsedWords(row.endedAt, now)} ago`}`;
}

function Elapsed({ row }: { row: Pick<BrowserAgentRow, "startedAt" | "endedAt"> }) {
  const now = useNow();
  return <time dateTime={row.endedAt ?? row.startedAt} className="tabular-nums" data-agent-time>{timeWords(row, now)}</time>;
}

function AgentRow({ row, selected }: { row: BrowserAgentRow; selected: boolean }) {
  // A row's chip says what its group heading doesn't: the heading already says Working, so a working row wears none.
  const chip = row.label !== GROUP_LABEL[row.group];
  return <li data-agent-row={row.runId} data-agent-group={row.group}>
    <a href={row.href} aria-current={selected ? "page" : undefined}
      className={cn("grid min-h-11 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 rounded-md px-2.5 py-2.5 outline-none transition-colors hover:bg-raised focus-visible:ring-2 focus-visible:ring-ring",
        selected && "bg-card shadow-pill")}>
      <span className="flex min-w-0 items-center gap-2">
        {chip && <StateChip row={row} />}
        <span className={cn("truncate text-[13.5px] leading-snug", row.group === "needs-you" ? "font-semibold" : "font-medium")}>{row.title}</span>
      </span>
      {row.diff !== null && <span className="text-right text-caption whitespace-nowrap text-muted-foreground tabular-nums" data-agent-diff>{row.diff}</span>}
      {row.line !== null && <span className={cn("col-span-2 min-w-0 truncate text-[12.5px]", row.quiet || row.group === "stuck" ? "text-warning" : row.group === "needs-you" ? "text-foreground" : "text-muted-foreground")}
        data-agent-line title={row.line}>{row.line}</span>}
      <span className="col-span-2 min-w-0 truncate text-caption text-muted-foreground">{[row.project, row.agent].filter(Boolean).join(" · ")} · <Elapsed row={row} /></span>
    </a>
  </li>;
}

function Board({ view, selected }: { view: BrowserAgentsView; selected: number | null }) {
  if (view.groups.length === 0) return <p className="rounded-card border border-border bg-card px-4 py-10 text-body text-muted-foreground" data-agents-empty>{view.empty}</p>;
  return <div className="flex flex-col gap-5 phone:gap-4">
    {view.groups.map(group => <section key={group.key} data-agent-group-section={group.key} aria-labelledby={`agents-${group.key}`}>
      <h2 id={`agents-${group.key}`} className="flex items-baseline gap-2 border-b border-border px-2.5 pb-1.5 text-body font-semibold leading-5">
        {group.label}<span className="font-mono text-mono font-medium tabular-nums text-muted-foreground">{group.rows.length}</span>
      </h2>
      <ul className="mt-1 flex flex-col gap-0.5">{group.rows.map(row => <AgentRow key={row.runId} row={row} selected={row.runId === selected} />)}</ul>
    </section>)}
  </div>;
}

type Transcript = { lines: string[]; state: "loading" | "ready" | "off" | "unavailable" };
const KEEP_LINES = 1500;

/** The live transcript, read forward from its byte offset (the run page's own JSON window), every 2 s while it runs. */
function useTranscript(url: string | null, live: boolean): Transcript {
  const [read, setRead] = useState<Transcript>({ lines: [], state: url === null ? "unavailable" : "loading" });
  useEffect(() => {
    if (url === null) return;
    let offset = 0, lines: string[] = [], stopped = false, timer = 0;
    const once = async (): Promise<void> => {
      try {
        for (let page = 0; page < 40 && !stopped; page++) {
          const answer = await fetch(`${url}&from=${offset}`, { cache: "no-store", credentials: "same-origin", redirect: "manual" });
          if (answer.status === 409) { offset = 0; lines = []; continue; }
          if (!answer.ok) { setRead({ lines, state: lines.length === 0 ? "unavailable" : "ready" }); break; }
          const data = await answer.json() as { text?: string; nextOffset?: number; final?: boolean; error?: string };
          if (data.error === "off") { stopped = true; setRead({ lines: [], state: "off" }); return; }
          if (typeof data.text === "string" && data.text !== "") lines = lines.concat(data.text.split("\n").filter(one => one !== "")).slice(-KEEP_LINES);
          const moved = typeof data.nextOffset === "number" && data.nextOffset !== offset;
          if (typeof data.nextOffset === "number") offset = data.nextOffset;
          if (data.final === true) stopped = true;
          if (!moved || stopped) break;
        }
        setRead({ lines, state: "ready" });
      } catch {
        setRead({ lines, state: lines.length === 0 ? "unavailable" : "ready" });
      }
      if (!stopped && live) timer = window.setTimeout(() => void once(), 2_000);
    };
    void once();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [url, live]);
  return read;
}

/** The changes so far while it runs: the run page's live look at its checkout, every 10 s while open. */
function useLiveChanges(url: string | null, open: boolean): string | null {
  const [fragment, setFragment] = useState<string | null>(null);
  useEffect(() => {
    if (url === null || !open) return;
    let stopped = false, timer = 0;
    const once = async () => {
      try {
        const answer = await fetch(url, { cache: "no-store", credentials: "same-origin", redirect: "manual" });
        if (answer.ok && !stopped) setFragment(await answer.text());
      } catch { /* the next look */ }
      if (!stopped) timer = window.setTimeout(() => void once(), 10_000);
    };
    void once();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [url, open]);
  return fragment;
}

function TranscriptPane({ detail }: { detail: BrowserAgentDetail }) {
  const read = useTranscript(detail.transcript, detail.live);
  const box = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const node = box.current;
    if (node !== null && pinned.current) node.scrollTop = node.scrollHeight;
  }, [read.lines.length]);
  const words = read.state === "off" || read.state === "unavailable" ? "The transcript can be read on the computer that runs the agent."
    : read.state === "loading" ? "Reading the transcript…" : detail.live ? "Nothing yet. Lines show here as the agent works." : "This agent left no transcript.";
  return <section aria-label="Transcript" className="flex min-h-0 flex-col">
    <h3 className="mb-1.5 text-caption font-medium text-muted-foreground">Transcript</h3>
    {read.lines.length === 0 ? <p className="rounded-md border border-dashed border-border px-3 py-6 text-body text-muted-foreground" data-transcript-empty>{words}</p>
      : <pre ref={box} tabIndex={0} aria-label="Agent transcript" data-agent-transcript
        onScroll={event => { const node = event.currentTarget; pinned.current = node.scrollTop + node.clientHeight >= node.scrollHeight - 24; }}
        className="max-h-[52vh] min-h-40 overflow-y-auto overscroll-contain rounded-md border border-border bg-card px-3 py-2.5 font-mono text-mono leading-[1.55] whitespace-pre-wrap break-words outline-none focus-visible:ring-2 focus-visible:ring-ring phone:max-h-none phone:min-h-0 phone:flex-1">
        {read.lines.join("\n")}
      </pre>}
  </section>;
}

function ChangesPane({ detail }: { detail: BrowserAgentDetail }) {
  const [open, setOpen] = useState(false);
  const fragment = useLiveChanges(detail.peek, open);
  return <Collapsible open={open} onOpenChange={setOpen} data-agent-changes>
    <CollapsibleTrigger className="group flex min-h-9 w-full items-center gap-1.5 rounded-md text-left text-caption font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring phone:min-h-11">
      <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 motion-safe:transition-transform group-data-[state=open]:rotate-90" />
      Changes<span className="font-normal tabular-nums">{detail.diff ?? ""}</span>
    </CollapsibleTrigger>
    <CollapsibleContent className="pt-1.5 pl-5">
    {detail.live
      ? detail.peek === null ? <p className="text-body text-muted-foreground">The changes can be read on the computer that runs the agent.</p>
        : fragment === null ? <p className="text-body text-muted-foreground">Looking at the checkout…</p>
        : <GuardedHtml html={fragment} className="so-native-region text-body" />
      : detail.files.length === 0 ? <p className="text-body text-muted-foreground">No saved changes.</p>
      : <ul className="flex flex-col gap-1 font-mono text-mono">
        {detail.files.map(file => <li key={file.path} className="flex min-w-0 gap-3"><span className="min-w-0 flex-1 truncate" title={file.path}>{file.path}</span>
          <span className="shrink-0 tabular-nums text-success">{file.added === null ? "" : `+${file.added}`}</span>
          <span className="shrink-0 tabular-nums text-danger">{file.removed === null ? "" : `−${file.removed}`}</span></li>)}
        {detail.filesMore > 0 && <li className="text-muted-foreground">{detail.filesMore} more in the result</li>}
      </ul>}
    </CollapsibleContent>
  </Collapsible>;
}

/** One composer at the bottom: Reply while the agent asks, otherwise a note that steers it. */
function Composer({ detail }: { detail: BrowserAgentDetail }) {
  const question = detail.question;
  const [text, setText] = useState("");
  if (!detail.canAct || (question === null && detail.steer === null)) return null;
  const reply = question !== null;
  return <PostForm action={reply ? question.action : detail.steer!.action} data-agent-composer={reply ? "reply" : "steer"}
    className="flex items-end gap-2 border-t border-border pt-3 desk:bg-card phone:bg-background desk:sticky desk:bottom-0 desk:pb-1 phone:shrink-0 phone:px-4 phone:pb-[max(12px,env(safe-area-inset-bottom))]">
    {reply ? <input type="hidden" name="question" value={String(question.id)} />
      : <><input type="hidden" name="return" value="agents" /><input type="hidden" name="run" value={String(detail.steer!.run)} /></>}
    <label className="sr-only" htmlFor="agent-composer">{reply ? `Reply to: ${question.text}` : "A note for the agent"}</label>
    <Textarea id="agent-composer" name={reply ? "answer" : "note"} rows={1} required maxLength={reply ? 1500 : 4000} value={text} onChange={event => setText(event.target.value)}
      placeholder={reply ? "Your answer" : "Tell the agent something"} className="min-h-11 min-w-0 flex-1 resize-none phone:min-h-11"
      onKeyDown={event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) event.currentTarget.form?.requestSubmit(); }} />
    <Button type="submit" variant={reply ? "attention" : "default"} className="h-11 w-auto shrink-0" disabled={text.trim() === ""}>{reply ? "Reply" : "Send"}</Button>
  </PostForm>;
}

function AgentDetail({ detail }: { detail: BrowserAgentDetail }) {
  return <section aria-labelledby="agent-title" data-agent-detail={detail.runId}
    className="flex min-w-0 flex-col gap-4 desk:sticky desk:top-4 phone:fixed phone:inset-0 phone:z-40 phone:gap-0 phone:bg-background">
    <header className="flex min-w-0 flex-col gap-1.5 phone:shrink-0 phone:border-b phone:border-border phone:px-2 phone:pt-[max(4px,env(safe-area-inset-top))] phone:pb-2.5">
      <div className="flex min-w-0 items-center gap-1">
        <Button asChild variant="ghost" size="icon" className="desk:hidden"><a href="/agents" aria-label="Back to all agents"><ArrowLeft /></a></Button>
        <h2 id="agent-title" className="min-w-0 flex-1 truncate text-headline font-semibold tracking-[-0.01em] phone:text-title">{detail.title}</h2>
        <Button asChild variant="ghost" size="sm" className="shrink-0"><a href={detail.resultHref ?? detail.taskHref}>{detail.resultHref === null ? "Task" : "Result"}<ArrowUpRight /></a></Button>
      </div>
      <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-caption text-muted-foreground phone:px-2.5">
        <StateChip row={detail} />
        {detail.project && <><span>{detail.project}</span><span aria-hidden="true">·</span></>}
        <span>{detail.agent}</span><span aria-hidden="true">·</span><Elapsed row={detail} />
        {detail.diff && <><span aria-hidden="true">·</span><span className="tabular-nums">{detail.diff}</span></>}
      </p>
    </header>
    <div className="flex min-w-0 flex-col gap-4 phone:min-h-0 phone:flex-1 phone:overflow-y-auto phone:overscroll-contain phone:px-4 phone:py-3">
      {detail.said && <Alert tone={detail.said.tone} data-agent-said>{detail.said.text}</Alert>}
      {detail.question !== null ? <div className="rounded-card border border-border bg-attention-soft px-3.5 py-3" data-agent-question={detail.question.key}>
        <p className="text-caption font-medium text-attention">The agent asks</p>
        <p className="mt-1 text-body-reading break-words text-foreground">{detail.question.text}</p>
      </div> : detail.line !== null && <p className={cn("text-body break-words", detail.group === "stuck" ? "text-warning" : "text-muted-foreground")} data-agent-line>{detail.line}</p>}
      <TranscriptPane detail={detail} />
      <ChangesPane detail={detail} />
    </div>
    <Composer key={`${detail.runId}:${detail.question?.id ?? "steer"}`} detail={detail} />
  </section>;
}

export function AgentsView({ view }: { view: BrowserAgentsView }) {
  const selected = view.selected;
  // The opened agent's own room: a change reads the page again in place; while open, this person is watching it.
  useLiveRoom(selected?.room ?? null, event => { if (event === "change" || event === "reload") window.dispatchEvent(new Event(WORKSPACE_NUDGE)); });
  return <div className={cn("w-full", selected === null ? "max-w-[860px]" : "desk:grid desk:grid-cols-[minmax(300px,400px)_minmax(0,1fr)] desk:items-start desk:gap-6")} data-agents-board>
    <div className={cn("flex min-w-0 flex-col gap-4", selected !== null && "phone:hidden")}>
      <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.02em]">Agents</h1>
      <Board view={view} selected={selected?.runId ?? null} />
    </div>
    {selected !== null && <AgentDetail key={selected.runId} detail={selected} />}
  </div>;
}
