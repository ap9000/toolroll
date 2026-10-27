/** The Agents view's Live grid (docs/plans/agents-view.md §1): every running agent as a tile with its live lines, its
 * subagents nested under it, and nothing on it that acts. Read-only: it reads the grid's JSON and each run's live
 * windows (one scheduler, four reads at most, one per file), and hears its own room. Tiles keep their order; nothing
 * leaves or moves while the grid is being looked at (pointer over it or focus in it) — changes wait, and the header
 * says so. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "../components/ui/index.js";
import { useLiveRoom } from "../live.js";
import { useNow } from "../live-task.js";
import { elapsedWords } from "./agents-view.js";

type Tile = { runId: number; role: string; title: string; project: string | null; agent: string; model: string | null; startedAt: string; endedAt: string | null;
  state: "working" | "needs-you" | "done" | "failed" | "stopped" | "parked"; why: "quiet" | "question" | null; quietSince: string | null; local: boolean; parentRun: number | null };
type Wire = { k: string; at?: string; s?: number; t?: string[]; id?: string; kind?: string; target?: string; once?: boolean; ok?: boolean | null; parent?: string | null; via?: number; desc?: string };
type Child = { s: number; via?: number; desc: string; lines: string[]; step: string | null; startedAt: number; endedAt: number | null; ok: boolean | null };
type Stream = { lines: string[]; step: string | null; children: Map<number, Child>; state: "loading" | "ready" | "off" | "unavailable"; earlier: boolean };

const KEEP_LINES = 200, SHOW_LINES = 12, STREAMED = 24, MAX_READS = 4, READ_DEADLINE_MS = 10_000, CHILD_DONE_MS = 30_000;
const STATE_WORDS: Record<Tile["state"], string> = { working: "Working", "needs-you": "Needs you", done: "Done", failed: "Failed", stopped: "Stopped", parked: "Parked" };
const STEP_WORDS: Record<string, string> = { edit: "Editing", command: "Running a command", read: "Reading", search: "Searching for", lookup: "Looking up", plan: "Planning", delegate: "Handing off", tool: "Using a tool", session: "Starting", message: "" };

const stepLine = (one: Wire): string => `${STEP_WORDS[one.kind ?? "tool"] ?? "Working"}${one.target ? ` ${one.target}` : ""}`;
/** A window's records as lines, the open step, and its subagents (sub file). */
function apply(stream: Stream, records: Wire[]): Stream {
  const lines = [...stream.lines];
  let step = stream.step;
  const children = new Map(stream.children);
  for (const one of records) {
    if (one.k === "over") { lines.push("More subagents started than are shown."); continue; }
    if (one.s !== undefined) {
      // Times from the records themselves (when the subagent started and ended), not from when this page read them.
      const stamp = one.at !== undefined && Number.isFinite(Date.parse(one.at)) ? Date.parse(one.at) : Date.now();
      if (one.k === "child") { children.set(one.s, { s: one.s, ...(one.via === undefined ? {} : { via: one.via }), desc: one.desc ?? "Subagent", lines: [], step: null, startedAt: stamp, endedAt: null, ok: null }); continue; }
      const child = children.get(one.s);
      if (child === undefined) continue;
      const next = { ...child, lines: [...child.lines] };
      if (one.k === "end") { next.endedAt = Math.max(stamp, next.startedAt); next.ok = one.ok ?? null; next.step = null; }
      else if (one.k === "say") next.lines.push(...(one.t ?? []));
      else if (one.k === "step") { next.step = stepLine(one); next.lines.push(`→ ${stepLine(one)}`); }
      else if (one.k === "done" && one.ok === false) next.lines.push("✗ failed");
      next.lines = next.lines.slice(-KEEP_LINES);
      children.set(one.s, next);
      continue;
    }
    if (one.k === "say") lines.push(...(one.t ?? []));
    else if (one.k === "step") { step = stepLine(one); lines.push(`→ ${step}`); }
    else if (one.k === "done") { if (one.ok === false) lines.push("✗ failed"); step = null; }
    else if (one.k === "start") lines.push("The agent session started.");
    else if (one.k === "cut") lines.push("A line was too long to show.");
    else if (one.k === "cap") lines.push("Output stopped at its size limit.");
  }
  return { ...stream, lines: lines.slice(-KEEP_LINES), step, children, state: "ready" };
}

const EMPTY: Stream = { lines: [], step: null, children: new Map(), state: "loading", earlier: false };

/** One reader for the whole page: at most MAX_READS at once and one per file; a nudge marks a file pending, and a
 * read that ends with more written (or a nudge meanwhile) goes again; each read has a deadline. */
function useWindows(onRead: (key: string, answer: { records?: Wire[]; error?: string; earlier?: boolean }) => void) {
  const state = useRef({ cursors: new Map<string, string>(), pending: new Set<string>(), running: new Set<string>(), backoff: new Map<string, number>() });
  const pump = useCallback(() => {
    const s = state.current;
    for (const key of [...s.pending]) {
      if (s.running.size >= MAX_READS) break;
      if (s.running.has(key) || (s.backoff.get(key) ?? 0) > Date.now()) continue;
      s.pending.delete(key);
      s.running.add(key);
      const [run, file] = key.split(":") as [string, string];
      const cursor = s.cursors.get(key);
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), READ_DEADLINE_MS);
      fetch(`/agents/live/${run}?file=${file}${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`, { signal: controller.signal, credentials: "same-origin" })
        .then(async response => (response.ok ? response.json() : { error: response.status === 404 ? "gone" : "retry" }) as Promise<{ records?: Wire[]; cursor?: string; more?: boolean; error?: string; earlier?: boolean }>)
        .then(answer => {
          if (answer.cursor !== undefined) s.cursors.set(key, answer.cursor);
          s.backoff.delete(key);
          if (answer.more === true) s.pending.add(key);
          onRead(key, answer);
        })
        .catch(() => { const wait = Math.min(30_000, ((s.backoff.get(key) ?? Date.now()) - Date.now()) * 2 || 1_000); s.backoff.set(key, Date.now() + wait); s.pending.add(key); })
        .finally(() => { clearTimeout(deadline); s.running.delete(key); pump(); });
    }
  }, [onRead]);
  const want = useCallback((keys: string[]) => { for (const key of keys) state.current.pending.add(key); pump(); }, [pump]);
  useEffect(() => { const timer = setInterval(pump, 1_000); return () => clearInterval(timer); }, [pump]);
  return want;
}

/** A status chip (youiyoux's spec): 20px high, 6px radius, a soft fill, 11.5px text and a dot in the status colour. */
const CHIP_TONE: Record<string, string> = {
  working: "bg-info-soft text-info", done: "bg-success-soft text-success", failed: "bg-danger-soft text-danger",
  stopped: "bg-neutral-soft text-neutral-ink", parked: "bg-neutral-soft text-neutral-ink",
};
/** "Needs you" (DESIGN.md, waits on you): the amber warning token as a thin full outline and a chip with a dot; never a
 * fill, never an edge stripe. */
const NEEDS_CHIP = "bg-warning-soft text-warning";
const NEEDS_TILE = "border-warning";

function Chip({ tone, children }: { tone: string; children: string }) {
  return <span className={cn("inline-flex h-5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sm px-1.5 text-[11.5px] font-medium leading-none", tone)} data-live-chip>
    <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />{children}
  </span>;
}

/** The log as a sunken well: mono 12px, as tall as its lines up to a cap; the top fades only when lines are cut. */
function Lines({ lines, short }: { lines: string[]; short: boolean }) {
  const shown = lines.slice(short ? -4 : -SHOW_LINES);
  const box = useRef<HTMLDivElement>(null), text = useRef<HTMLPreElement>(null);
  const [clipped, setClipped] = useState(false);
  // Lines leave over the top (the well is bottom-anchored), which scrollHeight doesn't count: compare the text's height.
  useLayoutEffect(() => { const node = box.current, inner = text.current; if (node !== null && inner !== null) setClipped(inner.offsetHeight > node.clientHeight - 16 + 1); });
  if (shown.length === 0) return <p className="text-[12px] text-muted-foreground">No output yet.</p>;
  return <div ref={box} className={cn("relative flex flex-col justify-end overflow-hidden rounded-md border border-border bg-code-bg px-2.5 py-2",
    short ? "max-h-[calc(4*1.5*12px+1rem)]" : "max-h-[calc(12*1.5*12px+1rem)] phone:max-h-[calc(4*1.5*12px+1rem)]",
    clipped && "before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:z-[1] before:h-6 before:bg-[linear-gradient(to_bottom,var(--so-code-bg)_30%,transparent)] before:content-['']")}>
    <pre ref={text} className="whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.5] text-foreground" data-live-lines>{shown.join("\n")}</pre>
  </div>;
}

function ChildTile({ child, now, last }: { child: Child; now: number; last: boolean }) {
  const words = child.endedAt === null ? "Working" : child.ok === false ? "Ended with an error" : "Done";
  const tone = child.endedAt === null ? CHIP_TONE.working! : child.ok === false ? CHIP_TONE.failed! : CHIP_TONE.done!;
  // A hairline elbow from the parent's spine to this tile; the spine runs on only to the next subagent.
  return <li className={cn("relative pl-5", !last && "pb-2",
    "before:absolute before:left-0 before:top-0 before:h-[22px] before:w-3.5 before:rounded-bl-sm before:border-b before:border-l before:border-border before:content-['']",
    !last && "after:absolute after:bottom-0 after:left-0 after:top-[22px] after:border-l after:border-border after:content-['']")} data-live-child={child.s}>
    <article className="flex flex-col gap-2 rounded-card border border-border bg-card p-3">
      <header className="flex items-start gap-2">
        <h3 className="line-clamp-2 min-w-0 flex-1 text-[13px] font-semibold leading-[1.35]" title={child.desc}>{child.desc}</h3>
        <Chip tone={tone}>{words}</Chip>
      </header>
      <p className="flex gap-2 text-[12px] text-muted-foreground"><span className="min-w-0 flex-1 truncate">{child.endedAt === null ? child.step ?? "" : ""}</span>
        <span className="shrink-0 tabular-nums">{elapsedWords(new Date(child.startedAt).toISOString(), child.endedAt ?? now)}</span></p>
      <Lines lines={child.lines} short />
    </article>
  </li>;
}

function LiveTile({ tile, stream, streamed, now, holding }: { tile: Tile; stream: Stream; streamed: boolean; now: number; holding: boolean }) {
  const needsYou = tile.state === "needs-you";
  // What it is doing right now; nothing rather than the chip's word again.
  const line = tile.why === "quiet" && tile.quietSince !== null ? `Quiet for ${elapsedWords(tile.quietSince, now)}` : tile.why === "question" ? "Asked a question" : tile.endedAt === null ? stream.step ?? "" : "";
  // A finished subagent holds Done for 30 s, and longer while the grid is being looked at: nothing leaves under a glance.
  const children = [...stream.children.values()].filter(child => child.endedAt === null || holding || now - child.endedAt < CHILD_DONE_MS).sort((a, b) => a.s - b.s);
  const meta = [tile.project?.split("/").pop(), tile.role, tile.agent, tile.model].filter(Boolean).join(" · ");
  return <li className="flex min-w-0 flex-col gap-2" data-live-tile={tile.runId} data-live-state={tile.state}>
    <article className={cn("flex min-w-0 flex-col gap-2.5 rounded-card border bg-card p-3.5", needsYou ? NEEDS_TILE : "border-border")}>
      <header className="flex flex-col gap-1">
        <div className="flex items-start gap-2">
          <h2 className="line-clamp-2 min-w-0 flex-1 text-[15px] font-semibold leading-[1.3]">
            <a href={`/agents?run=${tile.runId}`} className="hover:underline hover:underline-offset-4" title={tile.title}>{tile.title}</a>
          </h2>
          <Chip tone={needsYou ? NEEDS_CHIP : CHIP_TONE[tile.state] ?? CHIP_TONE.working!}>{STATE_WORDS[tile.state]}</Chip>
        </div>
        <p className="truncate font-mono text-[11px] text-muted-foreground" title={meta}>{meta}</p>
      </header>
      <p className="flex gap-2 text-[13px]"><span className="min-w-0 flex-1 truncate">{line}</span>
        <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">{elapsedWords(tile.startedAt, tile.endedAt === null ? now : Date.parse(tile.endedAt))}</span></p>
      {!tile.local ? <p className="text-[12px] text-muted-foreground">Output is on another computer.</p>
        : !streamed ? <p className="text-[12px] text-muted-foreground">Not shown live (more than {STREAMED} agents).</p>
        : stream.state === "unavailable" ? <p className="text-[12px] text-muted-foreground">Output unavailable.</p>
        : <>{stream.earlier && <p className="text-[11.5px] text-muted-foreground">Earlier output isn't shown.</p>}<Lines lines={stream.lines} short={false} /></>}
    </article>
    {children.length > 0 && <ul aria-label={`Subagents of ${tile.title}`} className="ml-4 flex flex-col">{children.map((child, index) => <ChildTile key={child.s} child={child} now={now} last={index === children.length - 1} />)}</ul>}
  </li>;
}

/** The headline (youiyoux's): one sentence that carries the counts. */
function Headline({ working, needsYou, shownLive, total }: { working: number; needsYou: number; shownLive: number; total: number }) {
  const n = (value: number) => <span className="font-semibold tabular-nums text-foreground">{value}</span>;
  return <p className="text-[13px] text-muted-foreground" data-live-headline>
    {n(working)} {working === 1 ? "agent" : "agents"} working{needsYou > 0 && <> · {n(needsYou)} {needsYou === 1 ? "needs" : "need"} you</>}
    {total > shownLive && <> · {n(shownLive)} of {n(total)} shown live</>}
  </p>;
}

export function LiveGrid() {
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [shown, setShown] = useState<Tile[]>([]);
  const [streams, setStreams] = useState<Map<number, Stream>>(new Map());
  const [loaded, setLoaded] = useState(false);
  const [terminals, setTerminals] = useState(0);
  const looking = useRef(false);
  const [holding, setHolding] = useState(false);
  const now = useNow(1_000);
  const onRead = useCallback((key: string, answer: { records?: Wire[]; error?: string; earlier?: boolean }) => {
    const run = Number(key.split(":")[0]);
    setStreams(previous => {
      const next = new Map(previous);
      const stream = next.get(run) ?? EMPTY;
      next.set(run, answer.error !== undefined ? { ...stream, state: answer.error === "off" ? "off" : stream.lines.length === 0 ? "unavailable" : stream.state }
        : { ...apply(stream, answer.records ?? []), earlier: stream.earlier || answer.earlier === true });
      return next;
    });
  }, []);
  const want = useWindows(onRead);
  const refresh = useCallback(() => {
    fetch("/agents/live", { credentials: "same-origin" }).then(response => response.ok ? response.json() : null).then((answer: { tiles: Tile[] } | null) => {
      if (answer === null) return;
      setTiles(answer.tiles);
      setLoaded(true);
      want(answer.tiles.filter(tile => tile.local).slice(0, STREAMED).flatMap(tile => [`${tile.runId}:main`, `${tile.runId}:sub`]));
    }).catch(() => {});
  }, [want]);
  useEffect(() => { refresh(); }, [refresh]);
  useLiveRoom("agents-live", event => { if (event === "change" || event === "reload") refresh(); });
  useEffect(() => {
    fetch("/term/state", { credentials: "same-origin" }).then(response => response.ok ? response.json() : null)
      .then((state: { sessions?: { endedAt: string | null }[] } | null) => setTerminals((state?.sessions ?? []).filter(one => one.endedAt === null).length)).catch(() => {});
  }, []);
  // Stable order: a tile keeps its place; a new one joins at the end; one that left goes only while nobody is looking.
  const settle = useCallback(() => setShown(previous => {
    const kept = previous.flatMap(old => { const now = tiles.find(tile => tile.runId === old.runId); return now !== undefined ? [now] : looking.current ? [old] : []; });
    return [...kept, ...tiles.filter(tile => !previous.some(old => old.runId === tile.runId)).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))];
  }), [tiles]);
  useEffect(() => { settle(); }, [settle]);
  const hold = (on: boolean) => { looking.current = on; setHolding(on); if (!on) settle(); };
  const parents = shown.filter(tile => tile.parentRun === null || !shown.some(other => other.runId === tile.parentRun));
  const working = shown.filter(tile => tile.endedAt === null).length;
  const needsYou = shown.filter(tile => tile.state === "needs-you").length;
  const streamedIds = new Set(shown.filter(tile => tile.local).slice(0, STREAMED).map(tile => tile.runId));
  const waiting = tiles.length !== shown.length || tiles.some(tile => !shown.some(one => one.runId === tile.runId));
  return <section className="flex w-full flex-col gap-4" data-live-grid aria-label="Live">
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 phone:sticky phone:top-0 phone:z-10 phone:bg-card phone:py-2">
      <Headline working={working} needsYou={needsYou} shownLive={Math.min(STREAMED, shown.length)} total={shown.length} />
      {waiting && holding && <p className="text-[12px] text-muted-foreground">Changes wait while you look.</p>}
    </div>
    {loaded && parents.length === 0 ? <p className="text-[13px] text-muted-foreground">No agents running.</p>
      : <ul className="grid items-start gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,340px),1fr))]" onPointerEnter={() => hold(true)} onPointerLeave={() => hold(false)}
          onFocus={() => hold(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) hold(false); }}>
        {parents.map(tile => <LiveTile key={tile.runId} tile={tile} stream={streams.get(tile.runId) ?? EMPTY} streamed={streamedIds.has(tile.runId)} now={now} holding={holding} />)}
      </ul>}
    {terminals > 0 && <p className="border-t border-border pt-3 text-[12px] text-muted-foreground"><a href="/term" className="underline decoration-border underline-offset-4 hover:text-foreground hover:decoration-current"><span className="tabular-nums">{terminals}</span> {terminals === 1 ? "terminal" : "terminals"} you're driving</a></p>}
  </section>;
}
