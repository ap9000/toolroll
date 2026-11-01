/** The Agents view's Live grid (docs/plans/agents-view.md §1): every running agent as a tile with its live lines, its
 * repairs and subagents nested under it, and nothing on it that acts. Read-only: it reads the grid's JSON and each
 * run's live windows (one scheduler: four reads at most, one per file, a deadline each, backoff on failure, all of it
 * stopped when the page goes), and hears its own room. Tiles keep their order; nothing leaves while the grid is being
 * looked at (pointer over it or focus in it) — changes wait, and the header says so. */
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { Badge, cn } from "../components/ui/index.js";
import { useLiveRoom } from "../live.js";
import { useNow } from "../live-task.js";
import { elapsedWords } from "./agents-view.js";

type Tile = { runId: number; role: string; taskId: string; title: string; project: string | null; agent: string; model: string | null; startedAt: string; endedAt: string | null;
  state: "working" | "needs-you" | "done" | "failed" | "stopped" | "parked"; why: "quiet" | "question" | null; quietSince: string | null; local: boolean; parentRun: number | null;
  taskHref: string | null;
  /** The viewer's own lead chat that filed this task (docs/plans/lead-dispatched-tiles.md): it nests under that lead. */
  filedBy?: { thread: number; chat: "lead" | "project" | "task" } | null };
type Wire = { k: string; at?: string; s?: number; t?: string[]; id?: string; kind?: string; target?: string; once?: boolean; ok?: boolean | null; out?: string[]; parent?: string | null; via?: number; desc?: string };
type FileState = "loading" | "ready" | "off" | "unavailable" | "error";
/** One stream's lines and its open steps (by id, in order), so the current step is the newest still open. */
type Feed = { lines: string[]; open: [string, string][] };
type Child = Feed & { s: number; via?: number; desc: string; startedAt: number; endedAt: number | null; ok: boolean | null; expired: boolean };
export type Stream = { main: Feed; children: Map<number, Child>; mainState: FileState; subState: FileState; earlier: boolean; restarted: boolean;
  /** The subagents' file started over (its earlier subagents are gone from view), or more started than it keeps. */
  subRestarted: boolean; over: boolean };
export type Answer = { records?: Wire[]; error?: string; earlier?: boolean; restarted?: boolean };

/** A tile keeps its last 200 lines; the agent open full screen keeps 2,000. */
export const FULL_LINES = 2_000;
export const KEEP_LINES = 200, STREAMED = 24, MAX_READS = 4, READ_DEADLINE_MS = 10_000, CHILD_DONE_MS = 30_000, MAX_BACKOFF_MS = 30_000;
const STATE_WORDS: Record<Tile["state"], string> = { working: "Working", "needs-you": "Needs you", done: "Done", failed: "Failed", stopped: "Stopped", parked: "Parked" };
const STEP_WORDS: Record<string, string> = { edit: "Editing", command: "Running", read: "Reading", search: "Searching for", lookup: "Looking up", plan: "Planning", delegate: "Handing off", tool: "Using a tool", session: "Starting", message: "" };
const NO_TARGET: Record<string, string> = { command: "Running a command", edit: "Editing files", read: "Reading the code", search: "Searching the code", lookup: "Looking something up" };

const stepLine = (one: Wire): string => one.target ? `${STEP_WORDS[one.kind ?? "tool"] ?? "Working"} ${one.target}` : NO_TARGET[one.kind ?? ""] ?? STEP_WORDS[one.kind ?? "tool"] ?? "Working";
const emptyFeed = (): Feed => ({ lines: [], open: [] });
/** One stream's record, folded into its feed: words, steps (a one-off step opens nothing), closes by id, output. */
function fold(feed: Feed, one: Wire, keep: number): Feed {
  const lines = [...feed.lines];
  let open = feed.open;
  if (one.k === "say") lines.push(...(one.t ?? []));
  else if (one.k === "step") { const words = stepLine(one); lines.push(`→ ${words}`); if (one.once !== true && one.id !== undefined) open = [...open.filter(([id]) => id !== one.id), [one.id, words]]; }
  else if (one.k === "done") { open = open.filter(([id]) => id !== one.id); lines.push(...(one.out ?? []).map(line => `  ${line}`)); if (one.ok === false) lines.push("✗ failed"); }
  else if (one.k === "start") lines.push("The agent session started.");
  else if (one.k === "cut") lines.push("A line was too long to show.");
  else if (one.k === "cap") lines.push("Output stopped at its size limit.");
  return { lines: lines.slice(-keep), open };
}
const stepNow = (feed: Feed): string | null => feed.open.at(-1)?.[1] ?? null;

export const EMPTY: Stream = { main: emptyFeed(), children: new Map(), mainState: "loading", subState: "loading", earlier: false, restarted: false, subRestarted: false, over: false };
const stampOf = (at: string | undefined) => at !== undefined && Number.isFinite(Date.parse(at)) ? Date.parse(at) : Date.now();

/** A window's records into a run's stream: the run's own (main) or its subagents' (sub). A restart starts that file over. */
export function applyWindow(stream: Stream, file: "main" | "sub", answer: Answer, keep = KEEP_LINES): Stream {
  if (answer.error !== undefined) {
    // "missing": nothing written yet (no subagents, or not started) — not a problem; "retry": the reader is trying again.
    if (answer.error === "missing") return file === "main" ? { ...stream, mainState: "ready" } : { ...stream, subState: "ready" };
    const state: FileState = answer.error === "off" ? "off" : answer.error === "gone" || answer.error === "unavailable" ? "unavailable" : "error";
    return file === "main" ? { ...stream, mainState: state } : { ...stream, subState: state };
  }
  const restarted = answer.restarted === true;
  let main = file === "main" && restarted ? { lines: ["Output restarted."], open: [] } : stream.main;
  const children = file === "sub" && restarted ? new Map<number, Child>() : new Map(stream.children);
  let over = stream.over && !(file === "sub" && restarted);
  for (const one of answer.records ?? []) {
    if (file === "main") { if (one.s === undefined) main = fold(main, one, keep); continue; }
    if (one.k === "over") { over = true; continue; }
    if (one.s === undefined) continue;
    if (one.k === "child") {
      children.set(one.s, { ...emptyFeed(), s: one.s, ...(one.via === undefined ? {} : { via: one.via }), desc: one.desc ?? "Subagent", startedAt: stampOf(one.at), endedAt: null, ok: null, expired: false });
      continue;
    }
    const child = children.get(one.s);
    if (child === undefined) continue;
    // An end with no time (read from a checkpoint) is long past: it never shows as just finished.
    if (one.k === "end") children.set(one.s, { ...child, open: [], endedAt: one.at === undefined ? 0 : Math.max(stampOf(one.at), child.startedAt), ok: one.ok ?? null });
    else children.set(one.s, { ...child, ...fold(child, one, keep) });
  }
  return { ...stream, main, children, over, earlier: stream.earlier || answer.earlier === true, restarted: stream.restarted || restarted,
    subRestarted: file === "sub" ? stream.subRestarted || restarted : stream.subRestarted,
    ...(file === "main" ? { mainState: "ready" as const } : { subState: "ready" as const }) };
}

export type Scheduler = { want(keys: string[]): void; keep(keys: Set<string>): void; dispose(): void };
/** One reader for the whole page: at most MAX_READS at once and one per file; a nudge marks a file pending, and a
 * read that ends with more written (or a nudge meanwhile) goes again; each read has a deadline; a failure backs off
 * (doubling up to 30 s, or as long as the server asks); the page going aborts every read and drops the rest. */
export function createScheduler(onRead: (key: string, answer: Answer) => void, fetcher: typeof fetch = (...args) => fetch(...args)): Scheduler {
  const cursors = new Map<string, string>(), pending = new Set<string>(), running = new Map<string, AbortController>();
  const retryAt = new Map<string, number>(), delay = new Map<string, number>();
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const later = () => {
    if (disposed || timer !== null || pending.size === 0) return;
    const next = Math.min(...[...pending].map(key => retryAt.get(key) ?? Date.now()));
    timer = setTimeout(() => { timer = null; pump(); }, Math.max(50, next - Date.now()));
  };
  const fail = (key: string, waitMs?: number) => {
    // Our own backoff doubles up to 30 s; a server that asks for longer is given what it asks.
    const step = Math.min(MAX_BACKOFF_MS, (delay.get(key) ?? 500) * 2);
    delay.set(key, step);
    retryAt.set(key, Date.now() + Math.max(step, waitMs ?? 0));
    pending.add(key);
    onRead(key, { error: "retry" });
  };
  const askedWait = (value: string | null): number | undefined => {
    if (value === null) return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
    const at = Date.parse(value);
    return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
  };
  const pump = (): void => {
    if (disposed) return;
    for (const key of [...pending]) {
      if (running.size >= MAX_READS) break;
      if (running.has(key) || (retryAt.get(key) ?? 0) > Date.now()) continue;
      pending.delete(key);
      const controller = new AbortController();
      running.set(key, controller);
      const [run, file] = key.split(":") as [string, string];
      const cursor = cursors.get(key);
      const deadline = setTimeout(() => controller.abort(), READ_DEADLINE_MS);
      fetcher(`/agents/live/${run}?file=${file}${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`, { signal: controller.signal, credentials: "same-origin" })
        .then(async response => {
          if (disposed) return;
          if (response.status === 404) { onRead(key, { error: "gone" }); return; }
          if (!response.ok) { fail(key, askedWait(response.headers.get("retry-after"))); return; }
          const answer = await response.json() as Answer & { cursor?: string; more?: boolean };
          if (disposed) return;
          if (answer.cursor !== undefined) cursors.set(key, answer.cursor);
          delay.delete(key); retryAt.delete(key);
          if (answer.more === true) pending.add(key);
          onRead(key, answer);
        })
        .catch(() => { if (!disposed) fail(key); })
        .finally(() => { clearTimeout(deadline); running.delete(key); if (!disposed) pump(); });
    }
    later();
  };
  return {
    want(keys) { if (disposed) return; for (const key of keys) pending.add(key); pump(); },
    /** Only these files are read from now on: any other is aborted, dropped and forgotten (its cursor and backoff). */
    keep(keys) {
      for (const key of [...pending, ...running.keys(), ...cursors.keys(), ...retryAt.keys()]) {
        if (keys.has(key)) continue;
        running.get(key)?.abort(); running.delete(key); pending.delete(key); cursors.delete(key); retryAt.delete(key); delay.delete(key);
      }
    },
    dispose() { disposed = true; if (timer !== null) clearTimeout(timer); for (const controller of running.values()) controller.abort(); running.clear(); pending.clear(); },
  };
}

/** A status chip: the shared Badge chip (components/ui/badge.tsx, youiyoux's spec): 20px, the 6px radius, a soft fill,
 * ink words and the tone in the dot. "Needs you" (DESIGN.md, waits on you) is the amber wash and dot with its words
 * leaned toward ink (`text-needs`); the tile that waits takes the thin full amber outline, never a fill or a stripe. */
type ChipTone = "info" | "success" | "danger" | "neutral" | "needs";
const TONE: Record<string, ChipTone> = { working: "info", done: "success", failed: "danger", stopped: "neutral", parked: "neutral" };
const NEEDS_TILE = "border-warning";
export const NEEDS_TEXT = "text-needs";

function Chip({ tone, children }: { tone: ChipTone; children: string }) {
  return <Badge size="chip" dot tone={tone} data-live-chip>{children}</Badge>;
}

/** The log as a sunken well: mono 12px, as tall as its lines up to a cap, scrollable through what is kept; it follows the
 * newest line until the person scrolls up, then waits, with "Jump to latest". The top fades only when lines are hidden. */
function Lines({ lines, short, tall = false }: { lines: string[]; short: boolean; tall?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const [hiddenAbove, setHiddenAbove] = useState(false);
  useLayoutEffect(() => {
    const node = box.current;
    if (node === null) return;
    if (following) node.scrollTop = node.scrollHeight;
    setHiddenAbove(node.scrollTop > 1);
  });
  if (lines.length === 0) return <p className="text-[12px] text-muted-foreground">No output yet.</p>;
  return <div className="relative">
    <div ref={box} tabIndex={0} role="log" aria-label="Output" onScroll={event => {
      const node = event.currentTarget;
      setFollowing(node.scrollHeight - node.scrollTop - node.clientHeight < 4);
      setHiddenAbove(node.scrollTop > 1);
    }} className={cn("overflow-y-auto overscroll-contain rounded-md border border-border bg-code-bg px-2.5 py-2",
      tall ? "max-h-[60vh]" : short ? "max-h-[calc(4*1.5*12px+1rem)]" : "max-h-[calc(12*1.5*12px+1rem)] phone:max-h-[calc(4*1.5*12px+1rem)]")}>
      <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.5] text-foreground" data-live-lines>{lines.join("\n")}</pre>
    </div>
    {hiddenAbove && <span aria-hidden="true" className="pointer-events-none absolute inset-x-px top-px h-6 rounded-t-md bg-[linear-gradient(to_bottom,var(--so-code-bg)_30%,transparent)]" />}
    {!following && <button type="button" onClick={() => setFollowing(true)} className="absolute bottom-2 right-2 rounded-sm border border-border bg-card px-2 py-0.5 text-[11.5px] text-foreground shadow-pill phone:min-h-11">Jump to latest</button>}
  </div>;
}

/** A nested tile's hairline elbow from its parent's spine; the spine runs on only to the next one. */
const elbow = (last: boolean) => cn("relative pl-5", !last && "pb-2",
  "before:absolute before:left-0 before:top-0 before:h-[22px] before:w-3.5 before:rounded-bl-sm before:border-b before:border-l before:border-border before:content-['']",
  !last && "after:absolute after:bottom-0 after:left-0 after:top-[22px] after:border-l after:border-border after:content-['']");

/** A subagent's tile: its description, what it is doing, how long, its lines; its own subagents nested under it. */
function ChildTile({ child, all, now, last }: { child: Child; all: Child[]; now: number; last: boolean }) {
  const words = child.endedAt === null ? "Working" : child.ok === false ? "Ended with an error" : child.ok === true ? "Done" : "Ended";
  const key = child.endedAt === null ? "working" : child.ok === false ? "failed" : child.ok === true ? "done" : "stopped";
  const nested = all.filter(one => one.via === child.s);
  // A hairline elbow from the parent's spine to this tile; the spine runs on only to the next subagent.
  return <li className={elbow(last)} data-live-child={child.s}>
    <article className="flex flex-col gap-2 rounded-card border border-border bg-card p-3">
      <header className="flex items-start gap-2">
        <h3 className="line-clamp-2 min-w-0 flex-1 text-[13px] font-semibold leading-[1.35]" title={child.desc}>{child.desc}</h3>
        <Chip tone={TONE[key] ?? "info"}>{words}</Chip>
      </header>
      <p className="flex gap-2 text-[12px] text-muted-foreground"><span className="min-w-0 flex-1 truncate">{child.endedAt === null ? stepNow(child) ?? "" : ""}</span>
        <span className="shrink-0 tabular-nums">{elapsedWords(new Date(child.startedAt).toISOString(), child.endedAt ?? now)}</span></p>
      <Lines lines={child.lines} short />
    </article>
    {nested.length > 0 && <ul aria-label={`Subagents of ${child.desc}`} className="ml-4 mt-2 flex flex-col">
      {nested.map((one, index) => <ChildTile key={one.s} child={one} all={all} now={now} last={index === nested.length - 1} />)}</ul>}
  </li>;
}

function Output({ tile, stream, streamed, showLive, tall = false, lost = false }: { tile: Tile; stream: Stream; streamed: boolean; showLive: () => void; tall?: boolean; lost?: boolean }) {
  const quiet = "text-[12px] text-muted-foreground", note = "text-[11.5px] text-muted-foreground";
  const main = !tile.local || stream.mainState === "off" ? <p className={quiet}>Output is on another computer.</p>
    : !streamed ? <p className={cn(quiet, "flex items-center gap-2")}>Not shown live.
      <button type="button" onClick={showLive} className="rounded-sm border border-border bg-card px-2 py-0.5 text-[11.5px] text-foreground phone:min-h-11">Show live</button></p>
    : stream.mainState === "unavailable" ? <p className={quiet}>Output unavailable.</p>
    : <>
      {stream.earlier && <p className={note}>Earlier output isn't shown.</p>}
      {stream.mainState === "error" && <p className={note}>Couldn't read the latest output. Retrying.</p>}
      {stream.mainState === "loading" ? <p className={quiet}>Loading output…</p> : <Lines lines={stream.main.lines} short={false} tall={tall} />}
    </>;
  // The connection and the subagents' file speak for themselves, whatever the run's own output says.
  return <>
    {lost && <p className={note}>Reconnecting… these lines may not be the latest.</p>}
    {main}
    {stream.subState === "unavailable" && <p className={note}>Subagents' output unavailable.</p>}
    {stream.subState === "error" && <p className={note}>Couldn't read the subagents' output. Retrying.</p>}
    {stream.subRestarted && <p className={note}>Subagents' output restarted.</p>}
    {stream.over && <p className={note}>More subagents started than are shown.</p>}
  </>;
}

function LiveTile({ tile, stream, streamed, now, repairs, streams, streamedIds, showLive, openRun, nested }: { tile: Tile; stream: Stream; streamed: boolean; now: number;
  repairs: Tile[]; streams: Map<number, Stream>; streamedIds: Set<number>; showLive: (run: number) => void; openRun: (run: number) => void;
  /** Nested under the lead that filed it: its place among its siblings, for the connector. */
  nested?: { last: boolean } }) {
  const needsYou = tile.state === "needs-you";
  // What it is doing right now; nothing rather than the chip's word again.
  const line = tile.why === "quiet" && tile.quietSince !== null ? `Quiet for ${elapsedWords(tile.quietSince, now)}` : tile.why === "question" ? "Asked a question" : tile.endedAt === null ? stepNow(stream.main) ?? "" : "";
  const children = [...stream.children.values()].filter(child => !child.expired).sort((a, b) => a.s - b.s);
  const top = children.filter(child => child.via === undefined || !children.some(one => one.s === child.via));
  const meta = [tile.project?.split("/").pop(), tile.role, tile.agent, tile.model].filter(Boolean).join(" · ");
  const key = needsYou ? "needs" : tile.state;
  return <li className={cn("flex min-w-0 flex-col gap-2", nested !== undefined && elbow(nested.last))} data-live-tile={tile.runId} data-live-state={tile.state}>
    <article className={cn("flex min-w-0 flex-col gap-2.5 rounded-card border bg-card p-3.5", needsYou ? NEEDS_TILE : "border-border")}>
      <header className="flex flex-col gap-1">
        <div className="flex items-start gap-2">
          <h2 className="line-clamp-2 min-w-0 flex-1 text-[15px] font-semibold leading-[1.3]" title={tile.title}>
            {/* Opens this agent full screen inside Live (watching only: no seen mark, no watch). */}
            <button type="button" data-live-open={tile.runId} onClick={() => openRun(tile.runId)} className="text-left hover:underline hover:underline-offset-4 phone:min-h-11">{tile.title}</button>
          </h2>
          <Chip tone={key === "needs" ? "needs" : TONE[key] ?? "info"}>{STATE_WORDS[tile.state]}</Chip>
        </div>
        <p className="truncate font-mono text-[11px] text-muted-foreground" title={meta}>{meta}</p>
      </header>
      <p className="flex gap-2 text-[13px]"><span className="min-w-0 flex-1 truncate">{line}</span>
        <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">{elapsedWords(tile.startedAt, tile.endedAt === null ? now : Date.parse(tile.endedAt))}</span></p>
      <Output tile={tile} stream={stream} streamed={streamed} showLive={() => showLive(tile.runId)} />
    </article>
    {repairs.length > 0 && <ul aria-label={`Repairs of ${tile.title}`} className="ml-4 flex flex-col gap-2">
      {repairs.map(repair => <LiveTile key={repair.runId} tile={repair} stream={streams.get(repair.runId) ?? EMPTY} streamed={streamedIds.has(repair.runId)} now={now} repairs={[]} streams={streams} streamedIds={streamedIds} showLive={showLive} openRun={openRun} />)}</ul>}
    {top.length > 0 && <ul aria-label={`Subagents of ${tile.title}`} className="ml-4 flex flex-col">
      {top.map((child, index) => <ChildTile key={child.s} child={child} all={children} now={now} last={index === top.length - 1} />)}</ul>}
  </li>;
}

/** One agent full screen (a sheet on a phone): the same facts and output states as its tile, every kept line, every
 * subagent open, and its task's page when this console keeps the task. A modal dialog (Radix: focus held inside, the page
 * behind it hidden from assistive tech, Escape closes); focus starts on Close and returns to the tile it came from, or to
 * the grid when that tile has gone. Watching only: nothing here acts. */
function FullScreen({ runId, tile, stream, streamed, now, lost, onClose, showLive }: { runId: number; tile: Tile | null; stream: Stream; streamed: boolean; now: number; lost: boolean;
  onClose: () => void; showLive: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  const children = [...stream.children.values()].sort((a, b) => a.s - b.s);
  const top = children.filter(child => child.via === undefined || !children.some(one => one.s === child.via));
  return <DialogPrimitive.Root open onOpenChange={open => { if (!open) onClose(); }}>
    {/* Inside the view, so its styles (and its scoped reset) apply. */}
    <DialogPrimitive.Portal container={typeof document === "undefined" ? undefined : document.querySelector<HTMLElement>("[data-view]") ?? undefined}>
      <DialogPrimitive.Overlay className="ui-dialog-overlay" />
      <DialogPrimitive.Content data-live-full aria-describedby={undefined}
        onOpenAutoFocus={event => { event.preventDefault(); close.current?.focus(); }}
        onCloseAutoFocus={event => {
          event.preventDefault();
          const opener = document.querySelector(`[data-live-open="${runId}"]`) as HTMLElement | null;
          (opener ?? document.querySelector("[data-live-grid]") as HTMLElement | null)?.focus();
        }}
        className="ui-dialog-content flex !w-[min(1100px,calc(100vw-48px))] flex-col gap-3 !p-5 phone:!bottom-0 phone:!left-0 phone:!top-auto phone:!max-h-[calc(100dvh-2rem)] phone:!w-full phone:!rounded-b-none phone:!p-4 phone:!pb-[max(1rem,env(safe-area-inset-bottom))] phone:![transform:none]">
        <header className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <DialogPrimitive.Title className="text-[18px] font-semibold leading-[1.3]" data-live-full-title>{tile?.title ?? "This agent isn't on the grid anymore"}</DialogPrimitive.Title>
            {tile !== null && <p className="truncate font-mono text-[11px] text-muted-foreground">{[tile.project?.split("/").pop(), tile.role, tile.agent, tile.model].filter(Boolean).join(" · ")}</p>}
          </div>
          {tile !== null && <Chip tone={tile.state === "needs-you" ? "needs" : TONE[tile.state] ?? "info"}>{STATE_WORDS[tile.state]}</Chip>}
          <DialogPrimitive.Close ref={close} className="shrink-0 rounded-sm border border-border px-2.5 py-1 text-[12.5px] phone:min-h-11">Close</DialogPrimitive.Close>
        </header>
        {tile !== null && <>
          <p className="flex items-center gap-3 text-[13px]">
            <span className="min-w-0 flex-1 truncate">{tile.why === "quiet" && tile.quietSince !== null ? `Quiet for ${elapsedWords(tile.quietSince, now)}` : tile.why === "question" ? "Asked a question" : tile.endedAt === null ? stepNow(stream.main) ?? "" : ""}</span>
            <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">{elapsedWords(tile.startedAt, tile.endedAt === null ? now : Date.parse(tile.endedAt))}</span>
            {tile.taskHref !== null && <a href={tile.taskHref} className="shrink-0 text-[12.5px] underline decoration-border underline-offset-4 hover:decoration-current phone:inline-flex phone:min-h-11 phone:items-center">Open task</a>}
          </p>
          <Output tile={tile} stream={stream} streamed={streamed} showLive={showLive} tall lost={lost} />
          {top.length > 0 && <section aria-label="Subagents" className="flex flex-col gap-2">
            <h3 className="text-[13px] font-semibold">Subagents <span className="font-normal tabular-nums text-muted-foreground">{children.length}</span></h3>
            <ul className="flex flex-col">{top.map((child, index) => <ChildTile key={child.s} child={child} all={children} now={now} last={index === top.length - 1} />)}</ul>
          </section>}
        </>}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>;
}

/** A lead chat turn of the viewer's own (agents-live-lead.ts): its words already redacted on the server, kept there. */
type Lead = { thread: number; turn: number | null; scope: "lead" | "project" | "task"; title: string; project: string | null; state: "working" | "done" | "failed";
  startedAt: string; endedAt: string | null; stepAt: string[]; doing: string | null; lines: string[]; earlier: boolean; chatHref: string; taskHref: string | null };
const leadMeta = (lead: Lead) => ["lead chat", lead.project?.split("/").pop(), lead.stepAt.length > 1 ? `step ${lead.stepAt.length}` : null].filter(Boolean).join(" · ");

const CHAT_WORDS: Record<NonNullable<Tile["filedBy"]>["chat"], string> = { lead: "lead chat", project: "project chat", task: "task chat" };
/** The runs a lead filed, nested under it (its tile, or its quiet header once its tile has gone), each with its connector. */
function Filed({ thread, runs, label, render }: { thread: number; runs: Tile[]; label: string; render: (tile: Tile, last: boolean) => ReactElement }) {
  return runs.length === 0 ? null : <ul aria-label={label} className="ml-4 flex flex-col" data-live-filed={thread}>{runs.map((tile, index) => render(tile, index === runs.length - 1))}</ul>;
}

/** A lead's own tile: what it is doing, how long, its lines. Watching only; the title opens it full screen. */
function LeadArticle({ lead, now, openLead }: { lead: Lead; now: number; openLead: (thread: number) => void }) {
  return <article className="flex min-w-0 flex-col gap-2.5 rounded-card border border-border bg-card p-3.5">
    <header className="flex flex-col gap-1">
      <div className="flex items-start gap-2">
        <h2 className="line-clamp-2 min-w-0 flex-1 text-[15px] font-semibold leading-[1.3]" title={lead.title}>
          <button type="button" data-live-open-lead={lead.thread} onClick={() => openLead(lead.thread)} className="text-left hover:underline hover:underline-offset-4 phone:min-h-11">{lead.title}</button>
        </h2>
        <Chip tone={TONE[lead.state] ?? "info"}>{STATE_WORDS[lead.state]}</Chip>
      </div>
      <p className="truncate font-mono text-[11px] text-muted-foreground">{leadMeta(lead)}</p>
    </header>
    <p className="flex gap-2 text-[13px]"><span className="min-w-0 flex-1 truncate">{lead.doing ?? ""}</span>
      <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">{elapsedWords(lead.startedAt, lead.endedAt === null ? now : Date.parse(lead.endedAt))}</span></p>
    {lead.earlier && <p className="text-[11.5px] text-muted-foreground">Earlier lines aren't shown.</p>}
    <Lines lines={lead.lines} short={false} />
  </article>;
}

/** A lead and the runs it filed, as one grid item: its tile while that is shown, else a quiet header (no chip, no lines),
 * there while any of its runs is. One component and one key either way, so the runs under it are never rebuilt (their
 * scroll and follow state stay) when the lead's tile comes or goes: only the heading changes. */
function LeadGroup({ thread, lead, runs, now, openLead, render }: { thread: number; lead: Lead | null; runs: Tile[]; now: number; openLead: (thread: number) => void;
  render: (tile: Tile, last: boolean) => ReactElement }) {
  const projects = [...new Set(runs.map(tile => tile.project?.split("/").pop()).filter(Boolean))].join(", ");
  const words = runs.length === 0 ? "" : `Filed by ${CHAT_WORDS[runs[0]!.filedBy!.chat]}${projects === "" ? "" : ` · ${projects}`}`;
  return <li className="flex min-w-0 flex-col gap-2" {...(lead !== null ? { "data-live-lead": thread, "data-live-state": lead.state } : { "data-live-filed-group": thread })}>
    {lead !== null ? <LeadArticle lead={lead} now={now} openLead={openLead} /> : <p className="truncate text-[12px] text-muted-foreground" title={words}>{words}</p>}
    <Filed thread={thread} runs={runs} label={lead !== null ? `Filed by ${lead.title}` : words} render={render} />
  </li>;
}

/** A lead turn full screen: the same dialog as an agent's, with its chat (and its task, for a task's chat) a link away. */
function LeadFull({ thread, lead, now, lost, onClose, filed }: { thread: number; lead: Lead | null; now: number; lost: boolean; onClose: () => void; filed: Tile[] }) {
  const close = useRef<HTMLButtonElement>(null);
  const link = "shrink-0 text-[12.5px] underline decoration-border underline-offset-4 hover:decoration-current phone:inline-flex phone:min-h-11 phone:items-center";
  return <DialogPrimitive.Root open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogPrimitive.Portal container={typeof document === "undefined" ? undefined : document.querySelector<HTMLElement>("[data-view]") ?? undefined}>
      <DialogPrimitive.Overlay className="ui-dialog-overlay" />
      <DialogPrimitive.Content data-live-full aria-describedby={undefined}
        onOpenAutoFocus={event => { event.preventDefault(); close.current?.focus(); }}
        onCloseAutoFocus={event => {
          event.preventDefault();
          const opener = document.querySelector(`[data-live-open-lead="${thread}"]`) as HTMLElement | null;
          (opener ?? document.querySelector("[data-live-grid]") as HTMLElement | null)?.focus();
        }}
        className="ui-dialog-content flex !w-[min(1100px,calc(100vw-48px))] flex-col gap-3 !p-5 phone:!bottom-0 phone:!left-0 phone:!top-auto phone:!max-h-[calc(100dvh-2rem)] phone:!w-full phone:!rounded-b-none phone:!p-4 phone:!pb-[max(1rem,env(safe-area-inset-bottom))] phone:![transform:none]">
        <header className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <DialogPrimitive.Title className="text-[18px] font-semibold leading-[1.3]" data-live-full-title>{lead?.title ?? "This reply isn't on the grid anymore"}</DialogPrimitive.Title>
            {lead !== null && <p className="truncate font-mono text-[11px] text-muted-foreground">{leadMeta(lead)}</p>}
          </div>
          {lead !== null && <Chip tone={TONE[lead.state] ?? "info"}>{STATE_WORDS[lead.state]}</Chip>}
          <DialogPrimitive.Close ref={close} className="shrink-0 rounded-sm border border-border px-2.5 py-1 text-[12.5px] phone:min-h-11">Close</DialogPrimitive.Close>
        </header>
        {lead !== null && <>
          <p className="flex items-center gap-3 text-[13px]">
            <span className="min-w-0 flex-1 truncate">{lead.doing ?? ""}</span>
            <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">{elapsedWords(lead.startedAt, lead.endedAt === null ? now : Date.parse(lead.endedAt))}</span>
            <a href={lead.chatHref} className={link}>Open chat</a>
            {lead.taskHref !== null && <a href={lead.taskHref} className={link}>Open task</a>}
          </p>
          {lead.earlier && <p className="text-[11.5px] text-muted-foreground">Earlier lines aren't shown.</p>}
          <Lines lines={lead.lines} short={false} tall />
        </>}
        {/* Said whatever is shown: the turn's lines or, once it has left, the runs it filed (Codex filed r2 #1). */}
        {lost && (lead !== null || filed.length > 0) && <p className="text-[11.5px] text-muted-foreground">Reconnecting… these lines may not be the latest.</p>}
        {/* The runs it filed stay listed after its turn has left the grid: they are still there, under its header. */}
        {filed.length > 0 && <section aria-label="Tasks it filed" className="flex flex-col gap-2" data-live-full-filed>
            <h3 className="text-[13px] font-semibold">Tasks it filed <span className="font-normal tabular-nums text-muted-foreground">{filed.length}</span></h3>
            <ul className="flex flex-col gap-1.5">{filed.map(tile => <li key={tile.runId} className="flex items-center gap-2 text-[13px]">
              <span className="min-w-0 flex-1 truncate" title={tile.title}>{tile.title}</span>
              <Chip tone={tile.state === "needs-you" ? "needs" : TONE[tile.state] ?? "info"}>{STATE_WORDS[tile.state]}</Chip>
              {tile.taskHref !== null && <a href={tile.taskHref} className={link}>Open task</a>}
            </li>)}</ul>
          </section>}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>;
}

/** The headline (youiyoux's): one sentence that carries the counts. */
function Headline({ working, needsYou, shownLive, local }: { working: number; needsYou: number; shownLive: number; local: number }) {
  const n = (value: number) => <span className="font-semibold tabular-nums text-foreground">{value}</span>;
  return <p className="text-[13px] text-muted-foreground" data-live-headline>
    {n(working)} {working === 1 ? "agent" : "agents"} working{needsYou > 0 && <> · {n(needsYou)} {needsYou === 1 ? "needs" : "need"} you</>}
    {local > shownLive && <> · {n(shownLive)} of {n(local)} shown live</>}
  </p>;
}

export function LiveGrid() {
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [shown, setShown] = useState<Tile[]>([]);
  const [streams, setStreams] = useState<Map<number, Stream>>(new Map());
  const [loaded, setLoaded] = useState<"loading" | "ready" | "error">("loading");
  const [lost, setLost] = useState(false);
  const [terminals, setTerminals] = useState(0);
  const pointerIn = useRef(false), focusIn = useRef(false);
  const [holding, setHolding] = useState(false);
  const now = useNow(1_000);
  const scheduler = useRef<Scheduler | null>(null);
  // The agent open full screen (?view=live&run=…, so back and reload work).
  const runOf = () => { const run = Number(new URLSearchParams(location.search).get("run")); return Number.isSafeInteger(run) && run > 0 ? run : null; };
  const [openRunId, setOpenRunId] = useState<number | null>(runOf);
  const openRef = useRef<number | null>(openRunId);
  openRef.current = openRunId;
  const streamedIdsRef = useRef<Set<number>>(new Set());
  const grid = useRef<HTMLUListElement>(null);
  const generation = useRef(0);
  useEffect(() => {
    const created = createScheduler((key, answer) => {
      const [run, file] = key.split(":") as [string, "main" | "sub"];
      setStreams(previous => new Map(previous).set(Number(run), applyWindow(previous.get(Number(run)) ?? EMPTY, file, answer, Number(run) === openRef.current ? FULL_LINES : KEEP_LINES)));
    });
    scheduler.current = created;
    return () => { created.dispose(); scheduler.current = null; };
  }, []);
  // The streamed set, one for reading and showing: runs the person asked to show live first, then the newest local runs,
  // up to STREAMED. A tile held on screen while looked at keeps its place in it.
  const [pinned, setPinned] = useState<number[]>([]);
  const candidates = [...tiles, ...shown.filter(old => !tiles.some(tile => tile.runId === old.runId))].filter(tile => tile.local);
  // The agent open full screen comes first, whenever it is one this page may read.
  const streamedIds = new Set([...new Set([...(openRunId !== null && candidates.some(tile => tile.runId === openRunId) ? [openRunId] : []),
    ...pinned.filter(run => candidates.some(tile => tile.runId === run)), ...candidates.map(tile => tile.runId)])].slice(0, STREAMED));
  const streamedKey = [...streamedIds].sort((a, b) => a - b).join(",");
  useEffect(() => {
    const keys = streamedKey === "" ? [] : streamedKey.split(",").flatMap(run => [`${run}:main`, `${run}:sub`]);
    scheduler.current?.keep(new Set(keys));
    scheduler.current?.want(keys);
  }, [streamedKey]);
  streamedIdsRef.current = streamedIds;
  useEffect(() => {
    const moved = () => setOpenRunId(runOf());
    window.addEventListener("popstate", moved);
    return () => window.removeEventListener("popstate", moved);
  }, []);
  const openRun = (run: number) => {
    if (openRef.current === run) return; // already open: one history entry per opening
    openRef.current = run;
    history.pushState({ liveRun: run }, "", `/agents?view=live&run=${run}`);
    setOpenRunId(run);
  };
  const closeRun = () => {
    const run = openRef.current;
    if (run === null) return;
    openRef.current = null;
    if ((history.state as { liveRun?: number } | null)?.liveRun === run) history.back();
    else history.replaceState(null, "", "/agents?view=live");
    setOpenRunId(null);
  };
  // Closing (or switching) gives the run back its tile's retention: what the open view kept beyond 200 lines goes.
  const previousOpen = useRef<number | null>(openRunId);
  useEffect(() => {
    const before = previousOpen.current;
    previousOpen.current = openRunId;
    if (before === null || before === openRunId) return;
    setStreams(previous => {
      const stream = previous.get(before);
      if (stream === undefined) return previous;
      const children = new Map([...stream.children].map(([s, child]) => [s, { ...child, lines: child.lines.slice(-KEEP_LINES) }]));
      return new Map(previous).set(before, { ...stream, main: { ...stream.main, lines: stream.main.lines.slice(-KEEP_LINES) }, children });
    });
  }, [openRunId]);
  // A lead turn open full screen (?view=live&lead=…), the same way.
  const leadOf = () => { if (runOf() !== null) return null; const thread = Number(new URLSearchParams(location.search).get("lead")); return Number.isSafeInteger(thread) && thread > 0 ? thread : null; };
  const [openLeadId, setOpenLeadId] = useState<number | null>(leadOf);
  const leadRef = useRef<number | null>(openLeadId);
  leadRef.current = openLeadId;
  useEffect(() => {
    const moved = () => setOpenLeadId(leadOf());
    window.addEventListener("popstate", moved);
    return () => window.removeEventListener("popstate", moved);
  }, []);
  const openLead = (thread: number) => {
    if (leadRef.current === thread) return;
    leadRef.current = thread;
    history.pushState({ liveLead: thread }, "", `/agents?view=live&lead=${thread}`);
    setOpenLeadId(thread);
  };
  const closeLead = () => {
    const thread = leadRef.current;
    if (thread === null) return;
    leadRef.current = null;
    if ((history.state as { liveLead?: number } | null)?.liveLead === thread) history.back();
    else history.replaceState(null, "", "/agents?view=live");
    setOpenLeadId(null);
  };
  const showLive = (run: number) => setPinned(previous => [run, ...previous.filter(one => one !== run)].slice(0, STREAMED));
  const refresh = useCallback(() => {
    const mine = ++generation.current;
    fetch("/agents/live", { credentials: "same-origin" }).then(response => response.ok ? response.json() : null).then((answer: { tiles: Tile[]; leads?: Lead[] } | null) => {
      if (mine !== generation.current) return; // a newer read already answered
      if (answer === null) { setLoaded(previous => previous === "ready" ? "ready" : "error"); return; }
      setTiles(answer.tiles);
      setLeads(answer.leads ?? []);
      setLoaded("ready");
      // A nudge: every file being shown is read again from its cursor (the selection itself is kept by the effect).
      scheduler.current?.want([...streamedIdsRef.current].flatMap(run => [`${run}:main`, `${run}:sub`]));
    }).catch(() => { if (mine === generation.current) setLoaded(previous => previous === "ready" ? "ready" : "error"); });
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  useLiveRoom("agents-live", event => {
    if (event === "lost" || event === "retrying") { setLost(true); return; }
    if (event === "change" || event === "reload") { setLost(false); refresh(); }
  });
  useEffect(() => {
    fetch("/term/state", { credentials: "same-origin" }).then(response => response.ok ? response.json() : null)
      .then((state: { sessions?: { endedAt: string | null }[] } | null) => setTerminals((state?.sessions ?? []).filter(one => one.endedAt === null).length)).catch(() => {});
  }, []);
  // Stable order: a tile keeps its place; a new one joins at the end; one that left goes only while nobody is looking.
  const settle = useCallback((hold: boolean) => setShown(previous => {
    const kept = previous.flatMap(old => { const now = tiles.find(tile => tile.runId === old.runId); return now !== undefined ? [now] : hold ? [old] : []; });
    return [...kept, ...tiles.filter(tile => !previous.some(old => old.runId === tile.runId)).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))];
  }), [tiles]);
  useEffect(() => { settle(pointerIn.current || focusIn.current); }, [settle]);
  // Focus can leave without a blur (its element went away): look again each second, and let go when it is gone.
  useEffect(() => {
    if (focusIn.current && grid.current !== null && !grid.current.contains(document.activeElement)) hold(null, false);
  });
  // A finished subagent leaves 30 s after it ended — not while the grid is being looked at, and never back again.
  useEffect(() => {
    if (holding) return;
    setStreams(previous => {
      let changed = false;
      const next = new Map(previous);
      for (const [run, stream] of previous) {
        const due = [...stream.children.values()].filter(child => !child.expired && child.endedAt !== null && now - child.endedAt >= CHILD_DONE_MS);
        if (due.length === 0) continue;
        const children = new Map(stream.children);
        for (const child of due) children.set(child.s, { ...child, expired: true });
        next.set(run, { ...stream, children });
        changed = true;
      }
      return changed ? next : previous;
    });
  }, [now, holding, streams]);
  const hold = (pointer: boolean | null, focus: boolean | null) => {
    if (pointer !== null) pointerIn.current = pointer;
    if (focus !== null) focusIn.current = focus;
    const on = pointerIn.current || focusIn.current;
    setHolding(on);
    if (!on) settle(false);
  };
  const ids = new Set(shown.map(tile => tile.runId));
  const repairsOf = (runId: number) => shown.filter(tile => tile.role === "repair" && tile.parentRun === runId);
  const parents = shown.filter(tile => !(tile.role === "repair" && tile.parentRun !== null && ids.has(tile.parentRun)));
  // Runs the viewer's own lead filed nest under it: under its tile while that is shown, else under a quiet header; either
  // stands where the first of them stands in the grid's stable order. A run is shown once: nested, never also on its own.
  const filedOf = (thread: number) => parents.filter(tile => tile.filedBy?.thread === thread);
  const renderRun = (tile: Tile, last: boolean) => <LiveTile key={tile.runId} tile={tile} stream={streams.get(tile.runId) ?? EMPTY} streamed={streamedIds.has(tile.runId)} now={now}
    repairs={repairsOf(tile.runId)} streams={streams} streamedIds={streamedIds} showLive={showLive} openRun={openRun} nested={{ last }} />;
  const working = shown.filter(tile => tile.endedAt === null).length + leads.filter(lead => lead.endedAt === null).length;
  const needsYou = shown.filter(tile => tile.state === "needs-you").length;
  const waiting = tiles.length !== shown.length || tiles.some(tile => !ids.has(tile.runId));
  return <section className="flex w-full flex-col gap-4 outline-none" data-live-grid aria-label="Live" tabIndex={-1}>
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 phone:sticky phone:top-0 phone:z-10 phone:bg-card phone:py-2">
      <Headline working={working} needsYou={needsYou} shownLive={streamedIds.size} local={tiles.filter(tile => tile.local).length} />
      {waiting && holding && <p className="text-[12px] text-muted-foreground">Changes wait while you look.</p>}
      {lost && <p className="text-[12px] text-muted-foreground" role="status">Reconnecting…</p>}
    </div>
    {loaded === "error" ? <p className="text-[13px] text-muted-foreground" role="status">Couldn't load the agents. Retrying.</p>
      : loaded === "ready" && parents.length === 0 && leads.length === 0 ? <p className="text-[13px] text-muted-foreground">No agents running.</p>
      : <ul ref={grid} className="grid items-start gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,340px),1fr))]"
          onPointerEnter={() => hold(true, null)} onPointerLeave={() => hold(false, null)}
          onFocus={() => hold(null, true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) hold(null, false); }}>
        {leads.filter(lead => filedOf(lead.thread).length === 0).map(lead => <LeadGroup key={`lead-${lead.thread}`} thread={lead.thread} lead={lead} runs={[]} now={now} openLead={openLead} render={renderRun} />)}
        {parents.map(tile => {
          const thread = tile.filedBy?.thread;
          if (thread === undefined) return <LiveTile key={tile.runId} tile={tile} stream={streams.get(tile.runId) ?? EMPTY} streamed={streamedIds.has(tile.runId)} now={now}
            repairs={repairsOf(tile.runId)} streams={streams} streamedIds={streamedIds} showLive={showLive} openRun={openRun} />;
          // The group stands where the first of its runs stands: its lead's tile while that is shown, else its header.
          const group = filedOf(thread), lead = leads.find(one => one.thread === thread);
          return group[0] !== tile ? null : <LeadGroup key={`group-${thread}`} thread={thread} lead={lead ?? null} runs={group} now={now} openLead={openLead} render={renderRun} />;
        })}
      </ul>}
    {openRunId !== null && <FullScreen key={openRunId} runId={openRunId} tile={[...tiles, ...shown].find(tile => tile.runId === openRunId) ?? null} stream={streams.get(openRunId) ?? EMPTY}
      streamed={streamedIds.has(openRunId)} now={now} lost={lost} onClose={closeRun} showLive={() => showLive(openRunId)} />}
    {openLeadId !== null && <LeadFull key={`lead-${openLeadId}`} thread={openLeadId} lead={leads.find(lead => lead.thread === openLeadId) ?? null} now={now} lost={lost} onClose={closeLead} filed={shown.filter(tile => tile.filedBy?.thread === openLeadId)} />}
    {terminals > 0 && <p className="border-t border-border pt-3 text-[12px] text-muted-foreground">
      <a href="/term" className="inline-block underline decoration-border underline-offset-4 hover:text-foreground hover:decoration-current phone:min-h-11 phone:py-3"><span className="tabular-nums">{terminals}</span> {terminals === 1 ? "terminal" : "terminals"} you're driving</a></p>}
  </section>;
}
