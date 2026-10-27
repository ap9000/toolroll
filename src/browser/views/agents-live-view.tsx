/** The Agents view's Live grid (docs/plans/agents-view.md §1): every running agent as a tile with its live lines, its
 * repairs and subagents nested under it, and nothing on it that acts. Read-only: it reads the grid's JSON and each
 * run's live windows (one scheduler: four reads at most, one per file, a deadline each, backoff on failure, all of it
 * stopped when the page goes), and hears its own room. Tiles keep their order; nothing leaves while the grid is being
 * looked at (pointer over it or focus in it) — changes wait, and the header says so. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "../components/ui/index.js";
import { useLiveRoom } from "../live.js";
import { useNow } from "../live-task.js";
import { elapsedWords } from "./agents-view.js";

type Tile = { runId: number; role: string; title: string; project: string | null; agent: string; model: string | null; startedAt: string; endedAt: string | null;
  state: "working" | "needs-you" | "done" | "failed" | "stopped" | "parked"; why: "quiet" | "question" | null; quietSince: string | null; local: boolean; parentRun: number | null };
type Wire = { k: string; at?: string; s?: number; t?: string[]; id?: string; kind?: string; target?: string; once?: boolean; ok?: boolean | null; out?: string[]; parent?: string | null; via?: number; desc?: string };
type FileState = "loading" | "ready" | "off" | "unavailable" | "error";
/** One stream's lines and its open steps (by id, in order), so the current step is the newest still open. */
type Feed = { lines: string[]; open: [string, string][] };
type Child = Feed & { s: number; via?: number; desc: string; startedAt: number; endedAt: number | null; ok: boolean | null; expired: boolean };
export type Stream = { main: Feed; children: Map<number, Child>; mainState: FileState; subState: FileState; earlier: boolean; restarted: boolean };
export type Answer = { records?: Wire[]; error?: string; earlier?: boolean; restarted?: boolean };

export const KEEP_LINES = 200, STREAMED = 24, MAX_READS = 4, READ_DEADLINE_MS = 10_000, CHILD_DONE_MS = 30_000, MAX_BACKOFF_MS = 30_000;
const STATE_WORDS: Record<Tile["state"], string> = { working: "Working", "needs-you": "Needs you", done: "Done", failed: "Failed", stopped: "Stopped", parked: "Parked" };
const STEP_WORDS: Record<string, string> = { edit: "Editing", command: "Running", read: "Reading", search: "Searching for", lookup: "Looking up", plan: "Planning", delegate: "Handing off", tool: "Using a tool", session: "Starting", message: "" };
const NO_TARGET: Record<string, string> = { command: "Running a command", edit: "Editing files", read: "Reading the code", search: "Searching the code", lookup: "Looking something up" };

const stepLine = (one: Wire): string => one.target ? `${STEP_WORDS[one.kind ?? "tool"] ?? "Working"} ${one.target}` : NO_TARGET[one.kind ?? ""] ?? STEP_WORDS[one.kind ?? "tool"] ?? "Working";
const emptyFeed = (): Feed => ({ lines: [], open: [] });
/** One stream's record, folded into its feed: words, steps (a one-off step opens nothing), closes by id, output. */
function fold(feed: Feed, one: Wire): Feed {
  const lines = [...feed.lines];
  let open = feed.open;
  if (one.k === "say") lines.push(...(one.t ?? []));
  else if (one.k === "step") { const words = stepLine(one); lines.push(`→ ${words}`); if (one.once !== true && one.id !== undefined) open = [...open.filter(([id]) => id !== one.id), [one.id, words]]; }
  else if (one.k === "done") { open = open.filter(([id]) => id !== one.id); lines.push(...(one.out ?? []).map(line => `  ${line}`)); if (one.ok === false) lines.push("✗ failed"); }
  else if (one.k === "start") lines.push("The agent session started.");
  else if (one.k === "cut") lines.push("A line was too long to show.");
  else if (one.k === "cap") lines.push("Output stopped at its size limit.");
  return { lines: lines.slice(-KEEP_LINES), open };
}
const stepNow = (feed: Feed): string | null => feed.open.at(-1)?.[1] ?? null;

export const EMPTY: Stream = { main: emptyFeed(), children: new Map(), mainState: "loading", subState: "loading", earlier: false, restarted: false };
const stampOf = (at: string | undefined) => at !== undefined && Number.isFinite(Date.parse(at)) ? Date.parse(at) : Date.now();

/** A window's records into a run's stream: the run's own (main) or its subagents' (sub). A restart starts that file over. */
export function applyWindow(stream: Stream, file: "main" | "sub", answer: Answer): Stream {
  if (answer.error !== undefined) {
    const state: FileState = answer.error === "off" ? "off" : answer.error === "gone" ? "unavailable" : "error";
    return file === "main" ? { ...stream, mainState: state } : { ...stream, subState: state };
  }
  const restarted = answer.restarted === true;
  let main = file === "main" && restarted ? { lines: ["Output restarted."], open: [] } : stream.main;
  const children = file === "sub" && restarted ? new Map<number, Child>() : new Map(stream.children);
  for (const one of answer.records ?? []) {
    if (file === "main") { if (one.s === undefined) main = fold(main, one); continue; }
    if (one.k === "over" || one.s === undefined) continue;
    if (one.k === "child") {
      children.set(one.s, { ...emptyFeed(), s: one.s, ...(one.via === undefined ? {} : { via: one.via }), desc: one.desc ?? "Subagent", startedAt: stampOf(one.at), endedAt: null, ok: null, expired: false });
      continue;
    }
    const child = children.get(one.s);
    if (child === undefined) continue;
    if (one.k === "end") children.set(one.s, { ...child, open: [], endedAt: Math.max(stampOf(one.at), child.startedAt), ok: one.ok ?? null });
    else children.set(one.s, { ...child, ...fold(child, one) });
  }
  return { ...stream, main, children, earlier: stream.earlier || answer.earlier === true, restarted: stream.restarted || restarted,
    ...(file === "main" ? { mainState: "ready" as const } : { subState: "ready" as const }) };
}

export type Scheduler = { want(keys: string[]): void; dispose(): void };
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
    const step = Math.min(MAX_BACKOFF_MS, Math.max(waitMs ?? 0, (delay.get(key) ?? 500) * 2));
    delay.set(key, step);
    retryAt.set(key, Date.now() + step);
    pending.add(key);
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
          if (!response.ok) { const after = Number(response.headers.get("retry-after")); fail(key, Number.isFinite(after) && after > 0 ? after * 1000 : undefined); return; }
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
    dispose() { disposed = true; if (timer !== null) clearTimeout(timer); for (const controller of running.values()) controller.abort(); running.clear(); pending.clear(); },
  };
}

/** A status chip (youiyoux's spec): 20px high, the 6px radius, a soft fill, 11.5px ink text, a status-coloured dot. */
const DOT: Record<string, string> = { working: "text-info", done: "text-success", failed: "text-danger", stopped: "text-neutral-ink", parked: "text-neutral-ink" };
const FILL: Record<string, string> = { working: "bg-info-soft", done: "bg-success-soft", failed: "bg-danger-soft", stopped: "bg-neutral-soft", parked: "bg-neutral-soft" };
/** "Needs you" (DESIGN.md, waits on you): the amber warning token as a thin full outline and a chip with a dot; never a
 * fill, never an edge stripe. */
const NEEDS_FILL = "bg-warning-soft", NEEDS_DOT = "text-warning", NEEDS_TILE = "border-warning";

function Chip({ fill, dot, children }: { fill: string; dot: string; children: string }) {
  return <span className={cn("inline-flex h-5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sm px-1.5 text-[11.5px] font-medium leading-none text-foreground", fill)} data-live-chip>
    <span aria-hidden="true" className={cn("size-1.5 rounded-full bg-current", dot)} />{children}
  </span>;
}

/** The log as a sunken well: mono 12px, as tall as its lines up to a cap, scrollable through what is kept; it follows the
 * newest line until the person scrolls up, then waits, with "Jump to latest". The top fades only when lines are hidden. */
function Lines({ lines, short }: { lines: string[]; short: boolean }) {
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
      short ? "max-h-[calc(4*1.5*12px+1rem)]" : "max-h-[calc(12*1.5*12px+1rem)] phone:max-h-[calc(4*1.5*12px+1rem)]")}>
      <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.5] text-foreground" data-live-lines>{lines.join("\n")}</pre>
    </div>
    {hiddenAbove && <span aria-hidden="true" className="pointer-events-none absolute inset-x-px top-px h-6 rounded-t-md bg-[linear-gradient(to_bottom,var(--so-code-bg)_30%,transparent)]" />}
    {!following && <button type="button" onClick={() => setFollowing(true)} className="absolute bottom-2 right-2 rounded-sm border border-border bg-card px-2 py-0.5 text-[11.5px] text-foreground shadow-pill phone:min-h-11">Jump to latest</button>}
  </div>;
}

/** A subagent's tile: its description, what it is doing, how long, its lines; its own subagents nested under it. */
function ChildTile({ child, all, now, last }: { child: Child; all: Child[]; now: number; last: boolean }) {
  const words = child.endedAt === null ? "Working" : child.ok === false ? "Ended with an error" : "Done";
  const key = child.endedAt === null ? "working" : child.ok === false ? "failed" : "done";
  const nested = all.filter(one => one.via === child.s);
  // A hairline elbow from the parent's spine to this tile; the spine runs on only to the next subagent.
  return <li className={cn("relative pl-5", !last && "pb-2",
    "before:absolute before:left-0 before:top-0 before:h-[22px] before:w-3.5 before:rounded-bl-sm before:border-b before:border-l before:border-border before:content-['']",
    !last && "after:absolute after:bottom-0 after:left-0 after:top-[22px] after:border-l after:border-border after:content-['']")} data-live-child={child.s}>
    <article className="flex flex-col gap-2 rounded-card border border-border bg-card p-3">
      <header className="flex items-start gap-2">
        <h3 className="line-clamp-2 min-w-0 flex-1 text-[13px] font-semibold leading-[1.35]" title={child.desc}>{child.desc}</h3>
        <Chip fill={FILL[key]!} dot={DOT[key]!}>{words}</Chip>
      </header>
      <p className="flex gap-2 text-[12px] text-muted-foreground"><span className="min-w-0 flex-1 truncate">{child.endedAt === null ? stepNow(child) ?? "" : ""}</span>
        <span className="shrink-0 tabular-nums">{elapsedWords(new Date(child.startedAt).toISOString(), child.endedAt ?? now)}</span></p>
      <Lines lines={child.lines} short />
    </article>
    {nested.length > 0 && <ul aria-label={`Subagents of ${child.desc}`} className="ml-4 mt-2 flex flex-col">
      {nested.map((one, index) => <ChildTile key={one.s} child={one} all={all} now={now} last={index === nested.length - 1} />)}</ul>}
  </li>;
}

function Output({ tile, stream, streamed }: { tile: Tile; stream: Stream; streamed: boolean }) {
  const quiet = "text-[12px] text-muted-foreground";
  if (!tile.local || stream.mainState === "off") return <p className={quiet}>Output is on another computer.</p>;
  if (!streamed) return <p className={quiet}>Not shown live (more than {STREAMED} agents).</p>;
  if (stream.mainState === "unavailable") return <p className={quiet}>Output unavailable.</p>;
  return <>
    {stream.earlier && <p className="text-[11.5px] text-muted-foreground">Earlier output isn't shown.</p>}
    {stream.mainState === "error" && <p className="text-[11.5px] text-muted-foreground">Couldn't read the latest output. Retrying.</p>}
    {stream.mainState === "loading" ? <p className={quiet}>Loading output…</p> : <Lines lines={stream.main.lines} short={false} />}
  </>;
}

function LiveTile({ tile, stream, streamed, now, repairs, streams, streamedIds }: { tile: Tile; stream: Stream; streamed: boolean; now: number;
  repairs: Tile[]; streams: Map<number, Stream>; streamedIds: Set<number> }) {
  const needsYou = tile.state === "needs-you";
  // What it is doing right now; nothing rather than the chip's word again.
  const line = tile.why === "quiet" && tile.quietSince !== null ? `Quiet for ${elapsedWords(tile.quietSince, now)}` : tile.why === "question" ? "Asked a question" : tile.endedAt === null ? stepNow(stream.main) ?? "" : "";
  const children = [...stream.children.values()].filter(child => !child.expired).sort((a, b) => a.s - b.s);
  const top = children.filter(child => child.via === undefined || !children.some(one => one.s === child.via));
  const meta = [tile.project?.split("/").pop(), tile.role, tile.agent, tile.model].filter(Boolean).join(" · ");
  const key = needsYou ? "needs" : tile.state;
  return <li className="flex min-w-0 flex-col gap-2" data-live-tile={tile.runId} data-live-state={tile.state}>
    <article className={cn("flex min-w-0 flex-col gap-2.5 rounded-card border bg-card p-3.5", needsYou ? NEEDS_TILE : "border-border")}>
      <header className="flex flex-col gap-1">
        <div className="flex items-start gap-2">
          <h2 className="line-clamp-2 min-w-0 flex-1 text-[15px] font-semibold leading-[1.3]" title={tile.title}>{tile.title}</h2>
          <Chip fill={key === "needs" ? NEEDS_FILL : FILL[key] ?? FILL.working!} dot={key === "needs" ? NEEDS_DOT : DOT[key] ?? DOT.working!}>{STATE_WORDS[tile.state]}</Chip>
        </div>
        <p className="truncate font-mono text-[11px] text-muted-foreground" title={meta}>{meta}</p>
      </header>
      <p className="flex gap-2 text-[13px]"><span className="min-w-0 flex-1 truncate">{line}</span>
        <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">{elapsedWords(tile.startedAt, tile.endedAt === null ? now : Date.parse(tile.endedAt))}</span></p>
      <Output tile={tile} stream={stream} streamed={streamed} />
    </article>
    {repairs.length > 0 && <ul aria-label={`Repairs of ${tile.title}`} className="ml-4 flex flex-col gap-2">
      {repairs.map(repair => <LiveTile key={repair.runId} tile={repair} stream={streams.get(repair.runId) ?? EMPTY} streamed={streamedIds.has(repair.runId)} now={now} repairs={[]} streams={streams} streamedIds={streamedIds} />)}</ul>}
    {top.length > 0 && <ul aria-label={`Subagents of ${tile.title}`} className="ml-4 flex flex-col">
      {top.map((child, index) => <ChildTile key={child.s} child={child} all={children} now={now} last={index === top.length - 1} />)}</ul>}
  </li>;
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
  const [shown, setShown] = useState<Tile[]>([]);
  const [streams, setStreams] = useState<Map<number, Stream>>(new Map());
  const [loaded, setLoaded] = useState<"loading" | "ready" | "error">("loading");
  const [lost, setLost] = useState(false);
  const [terminals, setTerminals] = useState(0);
  const pointerIn = useRef(false), focusIn = useRef(false);
  const [holding, setHolding] = useState(false);
  const now = useNow(1_000);
  const scheduler = useRef<Scheduler | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    const created = createScheduler((key, answer) => {
      const [run, file] = key.split(":") as [string, "main" | "sub"];
      setStreams(previous => new Map(previous).set(Number(run), applyWindow(previous.get(Number(run)) ?? EMPTY, file, answer)));
    });
    scheduler.current = created;
    return () => { created.dispose(); scheduler.current = null; };
  }, []);
  // The streamed set, one for reading and showing: the newest local runs, up to STREAMED.
  const streamedIds = new Set(tiles.filter(tile => tile.local).slice(0, STREAMED).map(tile => tile.runId));
  const refresh = useCallback(() => {
    const mine = ++generation.current;
    fetch("/agents/live", { credentials: "same-origin" }).then(response => response.ok ? response.json() : null).then((answer: { tiles: Tile[] } | null) => {
      if (mine !== generation.current) return; // a newer read already answered
      if (answer === null) { setLoaded(previous => previous === "ready" ? "ready" : "error"); return; }
      setTiles(answer.tiles);
      setLoaded("ready");
      scheduler.current?.want(answer.tiles.filter(tile => tile.local).slice(0, STREAMED).flatMap(tile => [`${tile.runId}:main`, `${tile.runId}:sub`]));
    }).catch(() => { if (mine === generation.current) setLoaded(previous => previous === "ready" ? "ready" : "error"); });
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  useLiveRoom("agents-live", event => {
    if (event === "lost") { setLost(true); return; }
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
  const working = shown.filter(tile => tile.endedAt === null).length;
  const needsYou = shown.filter(tile => tile.state === "needs-you").length;
  const waiting = tiles.length !== shown.length || tiles.some(tile => !ids.has(tile.runId));
  return <section className="flex w-full flex-col gap-4" data-live-grid aria-label="Live">
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 phone:sticky phone:top-0 phone:z-10 phone:bg-card phone:py-2">
      <Headline working={working} needsYou={needsYou} shownLive={streamedIds.size} local={tiles.filter(tile => tile.local).length} />
      {waiting && holding && <p className="text-[12px] text-muted-foreground">Changes wait while you look.</p>}
      {lost && <p className="text-[12px] text-muted-foreground" role="status">Reconnecting…</p>}
    </div>
    {loaded === "error" ? <p className="text-[13px] text-muted-foreground" role="status">Couldn't load the agents. Retrying.</p>
      : loaded === "ready" && parents.length === 0 ? <p className="text-[13px] text-muted-foreground">No agents running.</p>
      : <ul className="grid items-start gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,340px),1fr))]"
          onPointerEnter={() => hold(true, null)} onPointerLeave={() => hold(false, null)}
          onFocus={() => hold(null, true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) hold(null, false); }}>
        {parents.map(tile => <LiveTile key={tile.runId} tile={tile} stream={streams.get(tile.runId) ?? EMPTY} streamed={streamedIds.has(tile.runId)} now={now}
          repairs={repairsOf(tile.runId)} streams={streams} streamedIds={streamedIds} />)}
      </ul>}
    {terminals > 0 && <p className="border-t border-border pt-3 text-[12px] text-muted-foreground">
      <a href="/term" className="inline-block underline decoration-border underline-offset-4 hover:text-foreground hover:decoration-current phone:min-h-11 phone:py-3"><span className="tabular-nums">{terminals}</span> {terminals === 1 ? "terminal" : "terminals"} you're driving</a></p>}
  </section>;
}
