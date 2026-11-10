/** A flow's canvas: zones are the stages of a team's process, cards are the
 * work moving through them. Drag a card to another zone to move it; open a
 * card to see its history, what zones reported, and to approve or send it
 * back. "Edit flow" lets you move, resize, add and connect zones: the solid
 * arrow is where work goes next, the dashed one where it goes if it's sent
 * back or fails. Every change is the server's: it answers with the flow as
 * it now stands, and every open page hears the moment it changes (v88),
 * with the faces of whoever else has it open. */
import { SteerControls, SteerNote } from "./steer-composer.js";
import { GuardedHtml } from "../guarded-html.js";
import { roomName, useLiveRoom } from "../live.js";
import { NEEDS } from "../../needs-you.js";
import { Background, BackgroundVariant, BaseEdge, EdgeLabelRenderer, Handle, MarkerType, NodeResizer, Position, ReactFlow, ReactFlowProvider, applyNodeChanges, getSmoothStepPath, useReactFlow, useViewport, type Connection, type Edge, type EdgeProps, type Node, type NodeChange, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./flow-view.css";
import { Bell, BellOff, Bot, CalendarClock, Download, Ellipsis, Hourglass, LineChart, ListChecks, MessageSquareReply, Copy, Flag, GitPullRequest, Hammer, Inbox, Megaphone, MessageSquare, MousePointerClick, Pencil, PenLine, Plus, Search, Send, Signpost, Split, Globe, Mail, Wrench, SquareKanban, UserCheck, Webhook, Workflow, X, Zap } from "lucide-react";
import { threadWhen } from "./task-view.js";
import { deadlineWords, shortWhen, viewerZone } from "../../when-html.js";
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { BrowserFlowCard, BrowserFlowSentItem, BrowserFlowStage, BrowserFlowTrigger, BrowserFlowView } from "../../browser-workspace.js";
import { unattendedBudgetOf, unattendedCoverWords, unattendedEndAfterWords, unattendedLimitWords, unattendedRunsOf, untilDayWords } from "../../flow-unattended-words.js";
import { Passwordless } from "../ui/post-form.js";
import { Badge, Button, Input, Label, Textarea, cn } from "../components/ui/index.js";
import { KActs, KApprove, KButton, KIcon, openOverlay, KChip, KCount, KDisclose, KDock, KEmpty, KField, KGroup, KInput, KLinkButton, KNotice, KOverlay, KPageHeader, KRow, KSeg, KSelect, KSlots, KStatus, useKMenu } from "../kit/index.js";
import { keyed } from "../mutation-key.js";

/** A person's initials in a small circle, the same colour for the same name everywhere. */
function Face({ name, size = "sm" }: { name: string; size?: "sm" | "md" }) {
  const hue = [...name].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 360, 7);
  const initials = name.split(/[\s._-]+/).filter(Boolean).map(part => part[0]!.toUpperCase()).slice(0, 2).join("") || name.slice(0, 2).toUpperCase();
  return <span title={name} aria-label={name} className={cn("inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white", size === "sm" ? "size-5 text-[9px]" : "size-7 text-[11px]")}
    style={{ background: `hsl(${hue} 45% 45%)` }}>{initials}</span>;
}

const COLORS: Record<string, string> = { slate: "#64748b", blue: "#3b82f6", violet: "#8b5cf6", amber: "#d97706", green: "#059669", rose: "#e11d48" };
const KIND_ICONS: Record<BrowserFlowStage["kind"], ReactNode> = {
  inbox: <Inbox className="size-3.5" aria-hidden="true" />, task: <Hammer className="size-3.5" aria-hidden="true" />, report: <Search className="size-3.5" aria-hidden="true" />,
  approval: <UserCheck className="size-3.5" aria-hidden="true" />, notify: <Megaphone className="size-3.5" aria-hidden="true" />, done: <Flag className="size-3.5" aria-hidden="true" />,
  check: <ListChecks className="size-3.5" aria-hidden="true" />, "pull-request": <GitPullRequest className="size-3.5" aria-hidden="true" />, update: <MessageSquareReply className="size-3.5" aria-hidden="true" />,
  sort: <Split className="size-3.5" aria-hidden="true" />, draft: <PenLine className="size-3.5" aria-hidden="true" />,
  request: <Globe className="size-3.5" aria-hidden="true" />, email: <Mail className="size-3.5" aria-hidden="true" />, tool: <Wrench className="size-3.5" aria-hidden="true" />, wait: <Hourglass className="size-3.5" aria-hidden="true" />, subagent: <Bot className="size-3.5" aria-hidden="true" />,
  send: <Send className="size-3.5" aria-hidden="true" />, choose: <Signpost className="size-3.5" aria-hidden="true" />,
};


/** What Jev decided about a card: its answer and how sure. A card it wasn't sure about says so. */
function SortChip({ sorted }: { sorted: NonNullable<BrowserFlowCard["sorted"]> }) {
  return <span className={cn("inline-flex max-w-full items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-mono-count leading-4 font-medium", !sorted.confident && "text-foreground")}
    title={sorted.confident ? "Sorted by Jev" : "Jev wasn't sure"} data-sort-chip>
    <Split className="size-3 shrink-0" style={{ color: sorted.confident ? COLORS["violet"] : undefined }} aria-hidden="true" /><span className="truncate">{sorted.confident ? sorted.chip : `Not sure · ${sorted.chip}`}</span></span>;
}

const TRIGGER_ICONS: Record<string, ReactNode> = {
  button: <MousePointerClick className="size-3.5" aria-hidden="true" />, schedule: <CalendarClock className="size-3.5" aria-hidden="true" />, github: <GitPullRequest className="size-3.5" aria-hidden="true" />,
  linear: <SquareKanban className="size-3.5" aria-hidden="true" />, flow: <Workflow className="size-3.5" aria-hidden="true" />, webhook: <Webhook className="size-3.5" aria-hidden="true" />,
  email: <Mail className="size-3.5" aria-hidden="true" />, chat: <MessageSquare className="size-3.5" aria-hidden="true" />,
};

type Reveal = { path: string; address: string | null; secret: string | null };
type Said = { ok: boolean; said: string; view?: BrowserFlowView; reveal?: Reveal };

/** The page was opened to allow browser use (`?browser=1`, the link a waiting card and chat give). */
const browserAsked = () => { try { return new URLSearchParams(window.location.search).get("browser") === "1"; } catch { return false; } };

async function send(path: string, fields: Record<string, string>, csrf: string): Promise<Said> {
  const body = new URLSearchParams({ csrf, ...fields });
  try {
    const response = await fetch(path, { method: "POST", body, credentials: "same-origin", headers: keyed({ accept: "application/json" }), signal: AbortSignal.timeout(20_000) });
    const data = await response.json() as Said;
    return { ok: data.ok === true, said: typeof data.said === "string" ? data.said : response.ok ? "Done." : "That didn't go through.", ...(data.view === undefined ? {} : { view: data.view }), ...(data.reveal === undefined ? {} : { reveal: data.reveal }) };
  } catch {
    return { ok: false, said: "That didn't go through. Check your connection and try again." };
  }
}

type Here = { name: string; cards: number[]; editing: boolean };

/** The flow as it stands, for everyone: its room says the moment it changes, and who else has it open. */
function useLiveFlow(view: BrowserFlowView, setView: (view: BrowserFlowView) => void, me: { card: number | null; editing: boolean }): Here[] {
  const [others, setOthers] = useState<Here[]>([]);
  const seen = useRef(view.live);
  seen.current = view.live;
  // While someone changes the flow, their draft is what they see; saving checks the revision.
  const paused = useRef(me.editing);
  paused.current = me.editing;
  const reading = useRef(false);
  // A nudge that arrives mid-read, or while the flow is being changed, is kept: one more read follows.
  const again = useRef(false);
  const retry = useRef<number | undefined>(undefined);
  const href = view.flow.href;
  const read = useCallback(async (): Promise<void> => {
    if (reading.current || paused.current) { again.current = true; return; }
    reading.current = true;
    again.current = false;
    window.clearTimeout(retry.current);
    let ok = false;
    try {
      const response = await fetch(`${href}?format=json`, { credentials: "same-origin", headers: { accept: "application/json" } });
      if (response.ok) { const next = await response.json() as BrowserFlowView; seen.current = next.live; setView(next); ok = true; }
    } catch { /* retried below */ }
    finally { reading.current = false; }
    if (again.current) void read();
    // A failed read doesn't leave the page stale until the next write: try again shortly.
    else if (!ok) retry.current = window.setTimeout(() => { if (document.visibilityState === "visible") void read(); }, 5000);
  }, [href, setView]);
  // Done changing the flow: catch up on anything held back meanwhile.
  useEffect(() => { if (!me.editing && again.current) void read(); }, [me.editing, read]);
  useEffect(() => () => window.clearTimeout(retry.current), []);
  useLiveRoom(roomName("flow", view.flow.id, { card: me.card, editing: me.editing }), (event, data) => {
    if (event === "change") { const at = data["at"]; if (typeof at !== "string" || at !== seen.current) void read(); }
    // The server's stream fell behind and caught up: read again.
    else if (event === "reload") void read();
    else if (event === "here") { const people = data["people"]; if (Array.isArray(people)) setOthers(people as Here[]); }
    else if (event === "gone" || event === "lost") setOthers([]);
  });
  return others;
}

/** Who else has this flow open: faces, and in words on hover and for screen readers. */
function AlsoHere({ others, cards }: { others: Here[]; cards: BrowserFlowCard[] }) {
  if (others.length === 0) return null;
  const doing = (one: Here) => {
    if (one.editing) return "changing this flow";
    const titles = one.cards.map(id => cards.find(card => card.id === id)?.title).filter((title): title is string => title !== undefined);
    return titles.length === 0 ? "looking at the flow" : `looking at ${titles.map(title => `“${title}”`).join(", ")}`;
  };
  const words = others.map(one => `${one.name} is ${doing(one)}`).join(". ");
  const editor = others.find(one => one.editing);
  return <div className="inline-flex min-w-0 items-center gap-1.5" data-also-here role="status" aria-label={`Also here: ${words}`} title={words}>
    <span className="flex -space-x-1.5">{others.slice(0, 4).map(one => <span key={one.name} className="rounded-full ring-2 ring-card"><Face name={one.name} /></span>)}</span>
    <span className="truncate text-caption text-muted-foreground font-normal">{editor !== undefined ? `${editor.name} is changing this flow` : others.length === 1 ? `${others[0]!.name} is here` : `${others.length} others here`}</span>
  </div>;
}

type ZoneData = {
  stage: BrowserFlowStage; kindLabel: string; owner: string; cards: BrowserFlowCard[]; editing: boolean; canMove: boolean; start: boolean;
  /** v92: the subagent who decides or handles this zone, by name. */
  subagent: string | null;
  selectedCard: number | null; onCard: (id: number, from: HTMLElement | null) => void; onDrop: (card: number, stage: string) => void; hidden: number;
  /** Who else has each card open right now. */
  lookers: Record<number, string[]>;
  onResize: (stage: string, box: { x: number; y: number; width: number; height: number }) => void;
  /** A script zone that starts a browser and may not yet: one quiet line (the decision itself is on the page). */
  browserLine: ReactNode;
};

/** One zone: its step (icon, name, what it is, who), the cards in it now, and the dots that connect it while editing. */
function ZoneNode({ data, selected }: NodeProps<Node<ZoneData, "zone">>) {
  const { stage, cards, editing, canMove } = data;
  const [over, setOver] = useState(false);
  const handle = cn("fl-handle", !editing && "off");
  return <div
    // Zones are paper sheets in both themes; a zone's colour is said once, on its icon.
    className={cn("fl-zone-n", selected && editing && "selected", over && "over")}
    onDragOver={event => { if (!canMove || editing) return; event.preventDefault(); setOver(true); }}
    onDragLeave={() => setOver(false)}
    onDrop={event => { setOver(false); const id = Number(event.dataTransfer.getData("text/so-card")); if (id > 0) data.onDrop(id, stage.id); }}
    data-zone={stage.id}>
    {editing && <NodeResizer isVisible={selected} minWidth={220} minHeight={160} lineClassName="fl-resize-line" handleClassName="fl-resize-handle" onResizeEnd={(_event, box) => data.onResize(stage.id, box)} />}
    {/* Drawing handles: the right dot makes a "then" arrow, the bottom dot an "if sent back" arrow; any side receives. */}
    <Handle type="source" position={Position.Right} id="next" className={cn(handle, "next")} isConnectable={editing} />
    <Handle type="source" position={Position.Bottom} id="fail" className={cn(handle, "fail")} style={{ left: "75%" }} isConnectable={editing} />
    {(["Left", "Right", "Top", "Bottom"] as const).map(side => <Handle key={`t-${side}`} type="target" position={Position[side]} id={`t-${side}`} className={handle} isConnectable={editing} />)}
    {/* Routing handles: arrows leave from whichever side faces their target. Never drawn from. */}
    {(["Left", "Right", "Top", "Bottom"] as const).map(side => <Handle key={`s-${side}`} type="source" position={Position[side]} id={`s-${side}`} className="fl-handle route" isConnectable={false} />)}
    <header className="fl-zone-h">
      <span className="fl-ico" style={{ color: COLORS[stage.zone.color] ?? COLORS["slate"] }}>{KIND_ICONS[stage.kind]}</span>
      <span className="fl-zone-t"><b>{stage.title}</b><span>{data.kindLabel}{data.start ? " · new cards start here" : ""}{data.subagent !== null ? ` · ${data.subagent}` : stage.toOwner === true ? ` · ${data.owner}` : stage.approver ? ` · ${stage.approver}` : ""}</span></span>
      {cards.length > 0 && <KCount n={cards.length} ink={cards.some(card => card.canDecide)} />}
    </header>
    {data.browserLine !== null && stage.kind === "check" && stage.browser === true && !editing && <p className="fl-zone-br" data-zone-browser>{data.browserLine}</p>}
    <ul className="nowheel fl-zone-cards">
      {cards.map(card => <li key={card.id}>
        <button type="button" draggable={canMove && !editing}
          onDragStart={event => { event.dataTransfer.setData("text/so-card", String(card.id)); event.dataTransfer.effectAllowed = "move"; }}
          onClick={event => data.onCard(card.id, event.currentTarget)}
          className={cn("nodrag nopan fl-card", data.selectedCard === card.id && "selected", card.canDecide && "wait")}
          data-card={card.id}>
          <span className="fl-card-top">
            <span className="fl-card-t">{card.title}</span>
            {(data.lookers[card.id]?.length ?? 0) > 0 && <span className="fl-faces" data-card-lookers title={`${data.lookers[card.id]!.join(" and ")} ${data.lookers[card.id]!.length === 1 ? "is" : "are"} looking at this`}>
              {data.lookers[card.id]!.slice(0, 2).map(name => <Face key={name} name={name} />)}</span>}
          </span>
          {card.sorted !== null && <span className="fl-card-l"><SortChip sorted={card.sorted} /></span>}
          {card.waiting !== null && <span className={cn("fl-card-l", card.canDecide || card.question?.mine ? "mine" : "")}><span>{card.canDecide ? NEEDS.card.sentence({}) : card.question?.mine ? `${card.question.from.split(" · ")[0]} asks you` : card.waiting}</span></span>}
          {card.deadline != null && <span className="fl-card-l" data-card-deadline>{deadlineWords(card.deadline)}</span>}
          {(card.owner !== null || card.comments.length > 0) && <span className="fl-card-foot">
            {card.owner !== null && <Face name={card.owner} />}
            <span className="k-grow" />
            {card.comments.length > 0 && <span className="fl-card-c"><MessageSquare className="size-3" aria-hidden="true" />{card.comments.length}</span>}
          </span>}
        </button>
      </li>)}
      {cards.length === 0 && <li className="fl-zone-empty">{editing ? stage.kind === "done" ? "" : "Drag the dots to connect zones." : data.hidden > 0 ? "" : "No cards here."}</li>}
      {data.hidden > 0 && <li className="fl-zone-empty">{data.hidden} other card{data.hidden === 1 ? "" : "s"}</li>}
    </ul>
  </div>;
}

type TriggerData = { triggers: BrowserFlowTrigger[]; onOpen: (id: number, from: HTMLElement | null) => void; onPress: (id: number, from: HTMLElement | null) => void };
const TRIGGER_ROW = 48, TRIGGER_HEAD = 30;

/** What starts cards in one zone, beside it: each trigger in a line, whether it is well, and Start for a button. One arrow into the zone. */
function TriggerNode({ data }: NodeProps<Node<TriggerData, "trigger">>) {
  return <div className="fl-trig-n" data-trigger-group>
    <Handle type="source" position={Position.Right} id="out" className="fl-handle route" isConnectable={false} />
    <div className="fl-trig-h" style={{ height: TRIGGER_HEAD }}><KIcon name="bolt" small />Starts cards</div>
    {data.triggers.map(trigger => {
      const attention = trigger.failing || (trigger.hook !== null && !trigger.hook.ready);
      const line = trigger.state === "paused" ? "Paused" : trigger.failing ? "Needs attention" : trigger.hook !== null && !trigger.hook.ready ? "Needs its secret" : trigger.detail;
      return <div key={trigger.id} className={cn("fl-trig", trigger.state === "paused" && "paused")} style={{ height: TRIGGER_ROW }} data-trigger={trigger.id}>
        <span className="fl-ico">{TRIGGER_ICONS[trigger.kind] ?? <Zap className="size-3.5" aria-hidden="true" />}</span>
        <span className="fl-trig-b"><KButton variant="ghost" sm label={trigger.name} className="nodrag nopan" aria-label={`Trigger: ${trigger.words}`} onClick={event => data.onOpen(trigger.id, event.currentTarget)} />
          <span className={attention ? "bad" : ""}>{line}</span></span>
        {trigger.button !== null && trigger.state === "active" && <KButton sm label="Start" className="nodrag nopan" onClick={event => data.onPress(trigger.id, event.currentTarget)} />}
      </div>;
    })}
  </div>;
}

const NODE_TYPES = { zone: ZoneNode, trigger: TriggerNode };

type StepPath = { offset?: number; borderRadius?: number };
/** A named arrow whose name can sit along its line, clear of another arrow's name (see spreadLabels). */
function NamedEdge({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, label, labelStyle, labelBgStyle, markerEnd, style, data }: EdgeProps) {
  const { path: options, shift } = (data ?? {}) as { path?: StepPath; shift?: { x: number; y: number } };
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, ...options });
  // The name sits above every line (not just this one's), so another arrow never runs through it.
  const words = labelStyle as { fill?: string; fontSize?: number; fontWeight?: number } | undefined;
  return <>
    <BaseEdge path={path} {...(markerEnd === undefined ? {} : { markerEnd })} {...(style === undefined ? {} : { style })} />
    <EdgeLabelRenderer>
      <div className="nodrag nopan pointer-events-none absolute rounded-sm px-1 leading-4 whitespace-nowrap"
        style={{ transform: `translate(-50%, -50%) translate(${labelX + (shift?.x ?? 0)}px, ${labelY + (shift?.y ?? 0)}px)`, color: words?.fill, fontSize: words?.fontSize, fontWeight: words?.fontWeight, background: (labelBgStyle as { fill?: string } | undefined)?.fill }}>{label}</div>
    </EdgeLabelRenderer>
  </>;
}
const EDGE_TYPES = { named: NamedEdge };

/**
 * Arrows' names are drawn at their middles, so arrows that meet (a send-back
 * loop crossing a branch into the same zone) can stack their names on one
 * spot. Where one would land on another, it moves along its own line (up or
 * down a vertical middle, sideways along a horizontal one) until it's clear.
 */
function spreadLabels(edges: Edge[], stages: readonly BrowserFlowStage[]): Edge[] {
  const at = (id: string, handle: string | null | undefined) => {
    const zone = stages.find(one => one.id === id)?.zone;
    if (zone === undefined || handle == null) return null;
    const side = handle.slice(2) as "Left" | "Right" | "Top" | "Bottom";
    const x = side === "Left" ? zone.x : side === "Right" ? zone.x + zone.w : zone.x + zone.w / 2;
    const y = side === "Top" ? zone.y : side === "Bottom" ? zone.y + zone.h : zone.y + zone.h / 2;
    return { x, y, position: Position[side] };
  };
  const taken: { x: number; y: number; w: number; h: number }[] = [];
  const clash = (box: { x: number; y: number; w: number; h: number }) => taken.some(one => Math.abs(one.x - box.x) < (one.w + box.w) / 2 + 4 && Math.abs(one.y - box.y) < (one.h + box.h) / 2 + 2);
  return edges.map(edge => {
    if (typeof edge.label !== "string" || edge.type !== "smoothstep") return edge;
    const from = at(edge.source, edge.sourceHandle), to = at(edge.target, edge.targetHandle);
    if (from === null || to === null) return edge;
    const options = (edge as Edge & { pathOptions?: StepPath }).pathOptions;
    const [, x, y] = getSmoothStepPath({ sourceX: from.x, sourceY: from.y, sourcePosition: from.position, targetX: to.x, targetY: to.y, targetPosition: to.position, ...options });
    const w = edge.label.length * 6.4 + 10, h = 18;
    const across = (from.position === Position.Left || from.position === Position.Right) && (to.position === Position.Left || to.position === Position.Right);
    const step = across ? { x: 0, y: h + 6 } : { x: w / 2 + 34, y: 0 };
    let shift = { x: 0, y: 0 };
    for (const k of [0, 1, -1, 2, -2, 3, -3]) {
      shift = { x: step.x * k, y: step.y * k };
      if (!clash({ x: x + shift.x, y: y + shift.y, w, h })) break;
    }
    taken.push({ x: x + shift.x, y: y + shift.y, w, h });
    const { pathOptions: _path, ...rest } = edge as Edge & { pathOptions?: StepPath };
    return { ...rest, type: "named", data: { ...edge.data, path: options, shift } };
  });
}
type FlowNode = Node<ZoneData, "zone"> | Node<TriggerData, "trigger">;

/** Zones in the order work usually meets them: from the start, following each zone's next. */
function flowOrder(stages: BrowserFlowStage[], start: string): BrowserFlowStage[] {
  const ordered: BrowserFlowStage[] = [];
  const seen = new Set<string>();
  const visit = (id: string | null) => {
    while (id !== null && !seen.has(id)) {
      const stage = stages.find(one => one.id === id);
      if (stage === undefined) return;
      seen.add(id); ordered.push(stage);
      for (const answer of stage.sort?.answers ?? []) visit(answer.to);
      if (stage.sort !== null && stage.onFail !== null) visit(stage.onFail);
      id = stage.next;
    }
  };
  visit(start);
  for (const stage of stages) if (!seen.has(stage.id)) visit(stage.id);
  return [...ordered.filter(one => one.kind !== "done"), ...ordered.filter(one => one.kind === "done")];
}

function slug(title: string, taken: Set<string>): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "zone";
  let id = base, n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
}

/** The one formatter (when-html.ts), in the viewer's zone. */
const when = (at: string) => threadWhen(at);
/** The same, keeping the time of day on a date further out ("Sep 28 16:39"): a deadline or history line needs its hour. */
const whenAt = (at: string, now = new Date()) => Number.isNaN(new Date(at).getTime()) ? "" : shortWhen(at, now, viewerZone(), true);
/** Minutes as people say them: "45 min", "4 h", "3 days". */
const minutesWords = (minutes: number) => minutes % 1440 === 0 ? `${minutes / 1440} day${minutes === 1440 ? "" : "s"}` : minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`;

/** A comment's text with the people it pinged picked out. */
/** A trigger status that points somewhere: one short link after its words. */
function StatusLink({ link }: { link: BrowserFlowTrigger["statusLink"] }) {
  return link === null ? null : <> <a className="font-medium text-primary underline-offset-4 hover:underline" href={link.href} data-status-link>{link.label}</a></>;
}

function Mentioned({ body, mentions }: { body: string; mentions: string[] }) {
  if (mentions.length === 0) return <>{body}</>;
  const pattern = new RegExp(`(@(?:${mentions.map(one => one.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")}))(?![A-Za-z0-9_])`, "gi");
  return <>{body.split(pattern).map((part, index) => index % 2 === 1 ? <span key={index} className="font-semibold text-primary">{part}</span> : part)}</>;
}

/** What people said on a card, and a box to add to it. "@" suggests the people on this project. */
function Discussion({ card, view, csrf, apply }: { card: BrowserFlowCard; view: BrowserFlowView; csrf: string; apply: (result: Said) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const partial = /(?:^|\s)@([A-Za-z0-9_.-]*)$/.exec(text)?.[1];
  const suggestions = partial === undefined ? [] : view.approvers.filter(name => name !== view.me && name.toLowerCase().startsWith(partial.toLowerCase())).slice(0, 6);
  return <div className="flex flex-col gap-2" data-flow-discussion>
    <h3 className="text-body font-semibold">Discussion</h3>
    {card.comments.length === 0 ? <p className="text-caption text-muted-foreground font-normal">No comments yet.</p>
      : <ol className="flex flex-col gap-3">{card.comments.map(comment => <li key={comment.id} className="flex gap-2" data-comment={comment.id}>
        <Face name={comment.author} size="md" />
        <div className="min-w-0 flex-1">
          <p className="text-caption text-muted-foreground font-normal"><span className="font-semibold text-foreground">{comment.author}</span> · {when(comment.at)}</p>
          <p className="whitespace-pre-wrap break-words text-body"><Mentioned body={comment.body} mentions={comment.mentions} /></p>
        </div>
      </li>)}</ol>}
    {view.canEdit && <form className="flex flex-col gap-2" onSubmit={async event => {
      event.preventDefault(); setBusy(true);
      const result = await send(`${view.flow.href}/cards/${card.id}/comment`, { body: text }, csrf);
      setBusy(false); apply(result); if (result.ok) setText("");
    }}>
      <Textarea value={text} onChange={event => setText(event.target.value)} rows={3} maxLength={4000} placeholder="Add a comment. Type @ and a name to ping someone." aria-label="Comment" />
      {suggestions.length > 0 && <div className="flex flex-wrap gap-1.5" aria-label="People to mention">{suggestions.map(name => <button key={name} type="button"
        className="inline-flex min-h-8 items-center gap-1.5 rounded-full border px-2 text-caption hover:border-primary/60 font-normal" onClick={() => setText(current => current.replace(/@([A-Za-z0-9_.-]*)$/, `@${name} `))}>
        <Face name={name} />{name}</button>)}</div>}
      <Button type="submit" size="sm" className="self-start" disabled={busy || text.trim() === ""}>Comment</Button>
    </form>}
  </div>;
}

/** Who owns a card and who follows it, with the viewer's own switch. */
function CardPeople({ card, view, csrf, apply }: { card: BrowserFlowCard; view: BrowserFlowView; csrf: string; apply: (result: Said) => void }) {
  const [busy, setBusy] = useState(false);
  const act = async (path: string, fields: Record<string, string>) => { setBusy(true); apply(await send(`${view.flow.href}/cards/${card.id}/${path}`, fields, csrf)); setBusy(false); };
  const others = card.watchers.filter(name => name !== card.owner);
  return <div className="flex flex-col gap-2" data-flow-card-people>
    {view.canEdit && card.state === "active" ? <label className="grid gap-1.5"><span className="text-body font-medium">Owner</span>
      <select className={SELECT} value={card.owner ?? ""} disabled={busy} onChange={event => void act("assign", { owner: event.target.value })} aria-label="Owner">
        <option value="">No owner</option>
        {view.approvers.map(name => <option key={name} value={name}>{name === view.me ? `${name} (you)` : name}</option>)}
      </select></label>
      : card.owner !== null && <p className="flex items-center gap-2 text-body"><Face name={card.owner} /> Owned by {card.owner}</p>}
    <div className="flex flex-wrap items-center gap-2">
      {view.canEdit && card.state === "active" && card.owner === null && <Button size="sm" variant="outline" disabled={busy} onClick={() => void act("assign", { owner: view.me })}>Take it</Button>}
      {others.length > 0 && <span className="flex items-center gap-1 text-caption text-muted-foreground font-normal">{others.slice(0, 5).map(name => <Face key={name} name={name} />)}{others.length === 1 ? " follows it" : " follow it"}</span>}
      {view.canEdit && card.owner !== view.me && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act("watch", { watching: card.watching ? "no" : "yes" })} aria-pressed={card.watching}>
        {card.watching ? <><BellOff className="size-4" />Stop following</> : <><Bell className="size-4" />Follow</>}</Button>}
    </div>
  </div>;
}

/** Links a "Send to me" or "Person chooses" sent: Toolroll's pages here, a pull request in a new tab. */
function SentLinks({ links }: { links: { label: string; href: string }[] }) {
  return <div className="flex flex-wrap gap-x-3 gap-y-1">{links.map(link => <a key={link.label} className="text-body text-primary underline-offset-4 hover:underline font-medium" href={link.href}
    {...(link.href.startsWith("/") ? {} : { target: "_blank", rel: "noreferrer" })}>{link.label}</a>)}</div>;
}

/** After research: the report's items as the message numbered them, each beside its screenshot. */
function SentItems({ items }: { items: BrowserFlowSentItem[] }) {
  return <ol className="flex flex-col gap-3" data-flow-items>{items.map(item => <li key={item.number} className="flex items-start gap-3" data-flow-item={item.number}>
    <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-[12.5px]">
      <p className="font-semibold">{item.number}. {item.title}</p>
      {item.lines.map((line, index) => <p key={index} className="break-words text-muted-foreground">{line}</p>)}
      <a className="self-start font-medium text-primary underline-offset-4 hover:underline" href={item.url} target="_blank" rel="noreferrer">{item.source}</a>
    </div>
    {item.image !== null && <a className="w-28 shrink-0" href={item.image.src} target="_blank" rel="noreferrer">
      <img className="w-full rounded-md border object-cover object-top" style={{ aspectRatio: "4 / 3" }} src={item.image.src} alt={item.image.caption} loading="lazy" />
    </a>}
  </li>)}</ol>;
}

/** What a "Send to me" last sent the card's person. */
function SentBox({ sent }: { sent: NonNullable<BrowserFlowCard["sent"]> }) {
  return <details className="rounded-md border px-3 py-2" data-flow-sent>
    <summary className="cursor-pointer text-body font-medium">Sent to {sent.person} · {when(sent.at)}</summary>
    <div className="mt-2 flex flex-col gap-2">
      <p className="text-caption text-muted-foreground font-normal">{sent.title}</p>
      <p className="max-h-60 overflow-auto whitespace-pre-wrap break-words text-[12.5px]">{sent.summary}</p>
      {sent.items !== undefined && <SentItems items={sent.items} />}
      {sent.cardHtml !== undefined && <GuardedHtml html={sent.cardHtml} immutable />}
      {sent.links.length > 0 && <SentLinks links={sent.links} />}
    </div>
  </details>;
}

/** "Person chooses": what was done, the flow's options, and a reply instead — for the person it waits on. Others see who it waits on. */
function ChooseBox({ choose, base, csrf, apply }: { choose: NonNullable<BrowserFlowCard["choose"]>; base: string; csrf: string; apply: (result: Said) => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const act = async (fields: Record<string, string>) => {
    setBusy(true);
    const result = await send(`${base}/choose`, fields, csrf);
    setBusy(false);
    apply(result);
    if (result.ok) setNote("");
  };
  return <div className="flex flex-col gap-2 rounded-lg border border-attention/50 p-3" data-flow-choose>
    <p className="text-caption text-muted-foreground font-normal">{choose.title}</p>
    <p className="max-h-60 overflow-auto whitespace-pre-wrap break-words text-[12.5px]">{choose.summary}</p>
    {choose.items !== undefined && <SentItems items={choose.items} />}
    {choose.links.length > 0 && <SentLinks links={choose.links} />}
    {!choose.mine ? <p className="text-[12.5px] text-muted-foreground">Waiting for {choose.person} to choose.</p> : <>
      <div className="flex flex-wrap gap-2">{choose.options.map(option => <Button key={option.choice} size="sm" variant={option.choice === 0 ? "default" : "outline"} disabled={busy}
        onClick={() => void act({ choice: String(option.choice), label: option.label, entry: String(choose.entry) })} data-flow-choice={option.choice}>{option.label}</Button>)}</div>
      {choose.reply && <>
        <Textarea value={note} onChange={event => setNote(event.target.value)} rows={2} maxLength={4000} placeholder="Or say what you'd change" aria-label="What you'd change" />
        <Button size="sm" variant="outline" className="self-start" disabled={busy || note.trim() === ""} onClick={() => void act({ note, entry: String(choose.entry) })}>Send reply</Button>
      </>}
    </>}
  </div>;
}

function CardPanel({ card, view, csrf, apply, onAllowBrowser }: { card: BrowserFlowCard; view: BrowserFlowView; csrf: string; apply: (result: Said) => void; onAllowBrowser?: () => void }) {
  const [note, setNote] = useState("");
  const [draftText, setDraftText] = useState(card.draft?.text ?? "");
  useEffect(() => { setDraftText(card.draft?.text ?? ""); }, [card.id, card.draft?.text]);
  const [busy, setBusy] = useState(false);
  const stage = view.stages.find(one => one.id === card.stage);
  const act = async (path: string, fields: Record<string, string>) => {
    setBusy(true);
    const result = await send(path, fields, csrf);
    setBusy(false);
    apply(result);
    if (result.ok) setNote("");
  };
  const base = `${view.flow.href}/cards/${card.id}`;
  return <div className="flex flex-col gap-4" data-flow-card-panel={card.id}>
    <div className="min-w-0">
      <p className="text-caption text-muted-foreground font-normal">{card.state === "active" ? `In ${stage?.title ?? card.stage}` : card.state === "done" ? "Done" : card.waiting === "Ignored" ? "Ignored" : "Cancelled"} · added by {card.createdBy}</p>
      {card.sorted !== null && <div className="mt-1.5 flex"><SortChip sorted={card.sorted} /></div>}
    </div>
    {card.source !== null && (card.source.shown != null && card.source.url !== null
      // v126: an outside event's card says how it was proved, and its link shows where it goes (host and path).
      ? <p className="text-caption text-muted-foreground font-normal break-all">From {card.source.label}{card.source.proved === undefined ? null : ` (${card.source.proved})`} · <a className="font-medium text-primary underline-offset-4 hover:underline" href={card.source.url} target="_blank" rel="noopener noreferrer">{card.source.shown}</a></p>
      : <p className="text-caption text-muted-foreground font-normal">From {card.source.url === null ? card.source.label
        : <a className="font-medium text-primary underline-offset-4 hover:underline" href={card.source.url} {...(card.source.url.startsWith("/") ? {} : { target: "_blank", rel: "noopener noreferrer" })}>{card.source.label}</a>}{card.source.proved === undefined ? null : ` (${card.source.proved})`}</p>)}
    {card.description !== null && <p className="whitespace-pre-wrap text-body">{card.description}</p>}
    {card.waiting !== null && card.question == null && card.choose == null && card.state === "active" && <p className="rounded-md bg-muted px-3 py-2 text-body">{card.waiting}{card.deadline != null && <span className="block text-muted-foreground">{deadlineWords(card.deadline)}</span>}</p>}
    {card.browserWait === true && card.state === "active" && view.canEdit && view.browser?.canApprove !== false && (onAllowBrowser !== undefined
      ? <Button size="sm" variant="outline" className="self-start phone:min-h-11" onClick={onAllowBrowser} data-card-allow-browser>Allow browser</Button>
      : <a className="text-body font-medium text-primary underline-offset-4 hover:underline" href={`${view.flow.href}?browser=1`} data-card-allow-browser>Allow browser</a>)}
    {card.question != null && <SubagentQuestion question={card.question} csrf={csrf} apply={apply} />}
    {card.choose != null && <ChooseBox choose={card.choose} base={`${view.flow.href}/cards/${card.id}`} csrf={csrf} apply={apply} />}
    {card.sent != null && <SentBox sent={card.sent} />}
    {card.resultHtml !== undefined && <details className="rounded-md border px-3 py-2"><summary className="cursor-pointer text-body font-medium">What happened</summary><GuardedHtml html={card.resultHtml} immutable /></details>}
    {card.question != null && card.deadline != null && <p className="text-caption text-muted-foreground font-normal">{deadlineWords(card.deadline)}</p>}
    <CardPeople card={card} view={view} csrf={csrf} apply={apply} />
    {card.task !== null && <a className="text-body text-primary underline-offset-4 hover:underline font-medium" href={card.task.href}>Open its task</a>}
    {card.task?.composer != null && <div className="flex flex-col gap-1" data-flow-task-composer>
      <SteerControls controls={card.task.composer.controls} back={`flow:${view.flow.id}:${card.id}`} />
      {card.task.composer.steer !== null && <SteerNote key={`${card.id}:${card.task.composer.steer.run}`} steer={card.task.composer.steer} controls={card.task.composer.controls} back={`flow:${view.flow.id}:${card.id}`} />}
    </div>}
    {card.draft !== null && !card.canDecide && <details className="rounded-md border px-3 py-2" open data-flow-draft>
      <summary className="cursor-pointer text-body font-medium">Draft from {card.draft.title}</summary>
      <p className="mt-2 whitespace-pre-wrap text-[12.5px]">{card.draft.text}</p>
    </details>}
    {card.canDecide && <div className="flex flex-col gap-2 rounded-lg border border-attention/50 p-3">
      {card.handoff != null && <p className="rounded-md bg-muted px-3 py-2 text-body" data-subagent-handoff><span className="font-medium">{card.handoff.from}:</span> {card.handoff.note}</p>}
      {card.draft !== null && <>
        <Label htmlFor="flow-draft" className="text-body">Draft from {card.draft.title}</Label>
        <Textarea id="flow-draft" value={draftText} onChange={event => setDraftText(event.target.value)} rows={8} maxLength={12000} data-flow-draft-edit />
        {draftText.trim() !== card.draft.text.trim() && <p className="text-caption text-muted-foreground font-normal">Approving sends your edited version on.</p>}
      </>}
      <Label htmlFor="flow-note" className="text-body">{stage?.title ?? "Decision"}: approve, or send it back</Label>
      <Textarea id="flow-note" value={note} onChange={event => setNote(event.target.value)} placeholder="What should change? (needed to send it back)" rows={3} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy || (card.draft !== null && draftText.trim() === "")} onClick={() => void act(`${base}/decide`, { decision: "approve", note, ...(card.draft === null ? {} : { draft: draftText }) })}>{NEEDS.card.action.label}</Button>
        {stage?.onFail !== null && stage?.onFail !== undefined && <Button size="sm" variant="outline" disabled={busy || note.trim() === ""} onClick={() => void act(`${base}/decide`, { decision: "send-back", note })}>Send back</Button>}
      </div>
    </div>}
    {view.canEdit && card.state === "active" && <div className="flex flex-col gap-2">
      <Label htmlFor="flow-move" className="text-body">Move to</Label>
      <select id="flow-move" className={SELECT_INLINE} value={card.stage} disabled={busy}
        onChange={event => void act(`${base}/move`, { stage: event.target.value })}>
        {view.stages.map(one => <option key={one.id} value={one.id}>{one.title}</option>)}
      </select>
    </div>}
    {(card.calls ?? []).length > 0 && <details className="rounded-md border px-3 py-2" data-subagent-calls>
      <summary className="cursor-pointer text-body font-medium">Tool calls ({card.calls!.length})</summary>
      <ol className="mt-2 flex flex-col gap-2.5">{card.calls!.map(call => <li key={call.id} className="flex flex-col gap-0.5 text-[12.5px]" data-subagent-call={call.state}>
        <span className="break-words"><span className="font-medium">{call.who}</span> · {call.words}</span>
        <span className="text-muted-foreground">{call.outcome}{call.why !== "" && call.state !== "refused" ? ` · ${call.why}` : ""}</span>
        {call.result !== null && call.result !== "" && (call.state === "done" || call.state === "failed") && <span className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-muted px-2 py-1 text-caption font-normal">{call.result}</span>}
        {call.undo != null && call.subagent !== undefined && <Button size="sm" variant="outline" className="mt-1 self-start" disabled={busy} data-subagent-undo={call.id}
          onClick={() => void act(`/settings/lead/subagents/${call.subagent}/week`, { op: "undo", id: String(call.id) })}>Undo with {call.undo}</Button>}
      </li>)}</ol>
    </details>}
    {card.outputs.length > 0 && <div className="flex flex-col gap-2">
      <h3 className="text-body font-semibold">What zones reported</h3>
      {card.outputs.map(output => <details key={output.stage} className="rounded-md border px-3 py-2">
        <summary className="cursor-pointer text-body font-medium">{output.title}</summary>
        <p className="mt-2 whitespace-pre-wrap text-[12.5px] text-muted-foreground">{output.text}</p>
      </details>)}
    </div>}
    <Discussion card={card} view={view} csrf={csrf} apply={apply} />
    <div className="flex flex-col gap-1.5">
      <h3 className="text-body font-semibold">History</h3>
      <ol className="flex flex-col gap-1.5">{card.history.map((line, index) => <li key={index} className="text-caption font-normal"><span className="text-muted-foreground">{whenAt(line.at)}</span> · {line.text}</li>)}</ol>
    </div>
    {view.canEdit && card.state === "active" && <Button variant="ghost" size="sm" className="self-start text-destructive" disabled={busy} onClick={() => void act(`${base}/cancel`, {})}>Cancel card</Button>}
  </div>;
}

/** One labelled setting: defined once at the top level, so typing in it never remounts the input. */
function Field({ label, hint, children }: { label: string; hint?: string | undefined; children: ReactNode }) {
  return <label className="grid gap-1.5"><span className="text-body font-medium">{label}</span>{children}{hint !== undefined && <span className="text-caption text-muted-foreground font-normal">{hint}</span>}</label>;
}
const SELECT = "h-9 w-full rounded-xl border border-transparent bg-field px-3 text-body";
/** The same field-family select, sized to its words. */
const SELECT_INLINE = "h-9 rounded-xl border border-transparent bg-field px-3 text-body";

const SURE_LEVELS = [0.95, 0.9, 0.85, 0.8, 0.7, 0.6];
type SortSettingsValue = NonNullable<BrowserFlowStage["sort"]>;

/** A sort zone: the question Jev answers, each answer and where it sends the card, how sure it must be to act alone, and anything else it notes. */
function SortSettings({ sort, others, ready, set }: { sort: SortSettingsValue; others: BrowserFlowStage[]; ready: boolean; set: (sort: SortSettingsValue) => void }) {
  const answer = (index: number, change: Partial<SortSettingsValue["answers"][number]>) => set({ ...sort, answers: sort.answers.map((one, at) => at === index ? { ...one, ...change } : one) });
  const note = (index: number, change: Partial<SortSettingsValue["notes"][number]>) => set({ ...sort, notes: sort.notes.map((one, at) => at === index ? { ...one, ...change } : one) });
  return <>
    {!ready && <p className="rounded-md border border-border px-3 py-2 text-[12.5px]" data-sort-needs-key>Sorting needs an OpenRouter key. <a className="font-medium text-primary underline-offset-4 hover:underline" href="/settings/agents#providers">Add it in Settings</a></p>}
    <Field label="Question">
      <Input value={sort.question} maxLength={300} onChange={event => set({ ...sort, question: event.target.value })} aria-label="Question" />
    </Field>
    <div className="grid gap-2"><span className="text-body font-medium">Answers</span>
      {sort.answers.map((one, index) => <div key={index} className="grid gap-1.5 rounded-md border p-2" data-sort-answer={index}>
        <div className="flex items-center gap-1.5">
          <Input value={one.answer} maxLength={40} placeholder="Answer" onChange={event => answer(index, { answer: event.target.value })} aria-label={`Answer ${index + 1}`} />
          <Button variant="ghost" size="icon" disabled={sort.answers.length <= 2} onClick={() => set({ ...sort, answers: sort.answers.filter((_, at) => at !== index) })} aria-label={`Remove ${one.answer || `answer ${index + 1}`}`}><X className="size-4" /></Button>
        </div>
        <Input value={one.means} maxLength={200} placeholder="What it means, in a few words" onChange={event => answer(index, { means: event.target.value })} aria-label={`What ${one.answer || `answer ${index + 1}`} means`} />
        <select className={SELECT} value={one.to} onChange={event => answer(index, { to: event.target.value })} aria-label={`Where ${one.answer || `answer ${index + 1}`} goes`}>
          {one.to === "" && <option value="">Choose where it goes</option>}
          {others.map(zone => <option key={zone.id} value={zone.id}>Goes to {zone.title}</option>)}
        </select>
      </div>)}
      {sort.answers.length < 12 && <Button size="sm" variant="outline" className="self-start" onClick={() => set({ ...sort, answers: [...sort.answers, { answer: "", means: "", to: "" }] })}><Plus className="size-4" />Add an answer</Button>}
    </div>
    <Field label="Acts on its own when" hint="Below this, the card takes the not-sure path.">
      <select className={SELECT} value={String(sort.sureAt)} onChange={event => set({ ...sort, sureAt: Number(event.target.value) })} aria-label="Acts on its own when">
        {[...new Set([...SURE_LEVELS, sort.sureAt])].sort((a, b) => b - a).map(level => <option key={level} value={String(level)}>{Math.round(level * 100)}% sure or more</option>)}
      </select>
    </Field>
    <details className="rounded-md border px-3 py-2" open={sort.notes.length > 0}>
      <summary className="cursor-pointer text-body font-medium">Also note on the card{sort.notes.length > 0 ? ` (${sort.notes.length})` : ""}</summary>
      <div className="mt-2 grid gap-2">
        {sort.notes.map((one, index) => <div key={index} className="grid gap-1.5 rounded-md border p-2" data-sort-note={index}>
          <div className="flex items-center gap-1.5">
            <select className={SELECT} value={one.kind} onChange={event => note(index, event.target.value === "score" ? { kind: "score", levels: one.levels ?? ["Low", "Medium", "High"] } : { kind: "yes-no", levels: null })} aria-label={`Note ${index + 1}: kind`}>
              <option value="score">A score</option><option value="yes-no">Yes or no</option>
            </select>
            <Button variant="ghost" size="icon" onClick={() => set({ ...sort, notes: sort.notes.filter((_, at) => at !== index) })} aria-label={`Remove note ${index + 1}`}><X className="size-4" /></Button>
          </div>
          <Input value={one.question} maxLength={300} placeholder={one.kind === "score" ? "How urgent is this?" : "Is the customer asking for money back?"} onChange={event => note(index, { question: event.target.value })} aria-label={`Note ${index + 1}: question`} />
          {one.kind === "score" && <Textarea rows={3} value={(one.levels ?? []).join("\n")} onChange={event => note(index, { levels: event.target.value.split("\n") })} placeholder={"One level per line, lowest first"} aria-label={`Note ${index + 1}: levels, lowest first`} />}
        </div>)}
        {sort.notes.length < 3 && <Button size="sm" variant="outline" className="self-start" onClick={() => set({ ...sort, notes: [...sort.notes, { id: "", kind: "yes-no", question: "", levels: null }] })}><Plus className="size-4" />Add a note</Button>}
      </div>
    </details>
  </>;
}

const FILL_INS = "Fill-ins: {{card.title}}, {{card.description}}, {{card.email}}, {{stage.<zone id>}}.";
type RequestValue = NonNullable<BrowserFlowStage["request"]>;

/** A web request: the address, how it's called, headers (secrets go here), and what it sends. */
function RequestSettings({ request, view, csrf, apply, set }: { request: RequestValue; view: BrowserFlowView; csrf: string; apply: (result: Said) => void; set: (request: RequestValue) => void }) {
  const headers = Object.entries(request.headers);
  const header = (index: number, name: string, value: string) => set({ ...request, headers: Object.fromEntries(headers.map((one, at) => at === index ? [name, value] : one).filter(([key]) => key !== "")) });
  return <>
    <Field label="Address" hint={`The host is written out; fill-ins can go after it. ${FILL_INS}`}>
      <div className="flex gap-1.5">
        <select className={cn(SELECT, "w-24 shrink-0")} value={request.method} onChange={event => set({ ...request, method: event.target.value as RequestValue["method"] })} aria-label="Method">
          {(["GET", "POST", "PUT", "PATCH", "DELETE"] as const).map(one => <option key={one} value={one}>{one}</option>)}
        </select>
        <Input value={request.url} maxLength={2000} onChange={event => set({ ...request, url: event.target.value })} className="font-mono text-[12.5px]" placeholder="https://api.example.com/items" aria-label="Address" />
      </div>
    </Field>
    <div className="grid gap-1.5"><span className="text-body font-medium">Headers</span>
      {headers.map(([name, value], index) => <div key={index} className="flex gap-1.5" data-request-header={index}>
        <Input value={name} maxLength={64} onChange={event => header(index, event.target.value, value)} className="w-32 shrink-0 font-mono text-mono" placeholder="Authorization" aria-label={`Header ${index + 1} name`} />
        <Input value={value} maxLength={500} onChange={event => header(index, name, event.target.value)} className="font-mono text-mono" placeholder="Bearer {{secret.API_TOKEN}}" aria-label={`Header ${index + 1} value`} />
        <Button variant="ghost" size="icon" onClick={() => set({ ...request, headers: Object.fromEntries(headers.filter((_, at) => at !== index)) })} aria-label={`Remove header ${name || index + 1}`}><X className="size-4" /></Button>
      </div>)}
      {headers.length < 10 && <Button size="sm" variant="outline" className="self-start" onClick={() => set({ ...request, headers: { ...request.headers, [`X-Header-${headers.length + 1}`]: "" } })}><Plus className="size-4" />Add a header</Button>}
    </div>
    {request.method !== "GET" && request.method !== "DELETE" && <Field label="What it sends" hint="JSON is sent as JSON, with fill-ins inside its strings; anything else as plain text.">
      <Textarea rows={5} value={request.body ?? ""} maxLength={8000} onChange={event => set({ ...request, body: event.target.value })} className="font-mono text-mono" aria-label="What it sends" />
    </Field>}
    <SecretsBox view={view} csrf={csrf} apply={apply} words={<>Kept on this computer, never shown again. Use one in a header as {"{{secret.NAME}}"}.</>} />
  </>;
}

/** The project's flow secrets: their names, a way to save one, and (for a script zone) which ones it gets. Values are never shown. */
function SecretsBox({ view, csrf, apply, words, chosen, choose }: { view: BrowserFlowView; csrf: string; apply: (result: Said) => void; words: ReactNode; chosen?: string[]; choose?: (names: string[]) => void }) {
  const [secret, setSecret] = useState({ name: "", value: "" });
  const [busy, setBusy] = useState(false);
  const picked = chosen ?? [];
  return <details className="rounded-md border px-3 py-2" data-request-secrets open={picked.length > 0 ? true : undefined}>
    <summary className="cursor-pointer text-body font-medium">Secrets{choose !== undefined ? picked.length > 0 ? ` (${picked.length} used)` : "" : view.requestSecrets.length > 0 ? ` (${view.requestSecrets.length})` : ""}</summary>
    <div className="mt-2 grid gap-2">
      <p className="text-caption text-muted-foreground font-normal">{words}</p>
      {view.requestSecrets.length > 0 && (choose === undefined
        ? <p className="flex flex-wrap gap-1.5">{view.requestSecrets.map(name => <Badge key={name} tone="neutral" className="font-mono">{name}</Badge>)}</p>
        : <div className="flex flex-wrap gap-x-3 gap-y-1.5">{view.requestSecrets.map(name => <label key={name} className="inline-flex items-center gap-1.5 font-mono text-mono">
            <input type="checkbox" className="size-4 accent-primary" checked={picked.includes(name)} onChange={event => choose(event.target.checked ? [...picked, name] : picked.filter(one => one !== name))} />{name}</label>)}</div>)}
      {picked.filter(name => !view.requestSecrets.includes(name)).map(name => <p key={name} className="text-caption text-foreground font-medium">{name} isn't saved yet: save it below.</p>)}
      <div className="flex gap-1.5">
        <Input value={secret.name} onChange={event => setSecret({ ...secret, name: event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_") })} className="w-32 shrink-0 font-mono text-mono" placeholder="API_TOKEN" aria-label="Secret name" />
        <Input type="password" autoComplete="off" value={secret.value} onChange={event => setSecret({ ...secret, value: event.target.value })} placeholder="Its value (empty removes it)" aria-label="Secret value" />
      </div>
      <Button size="sm" variant="outline" className="self-start" disabled={busy || secret.name === ""} onClick={async () => {
        setBusy(true); const result = await send(`${view.flow.href}/secrets`, secret, csrf); setBusy(false); apply(result);
        if (result.ok) { if (choose !== undefined && secret.value.trim() !== "" && !picked.includes(secret.name)) choose([...picked, secret.name]); setSecret({ name: "", value: "" }); }
      }}>Save secret</Button>
    </div>
  </details>;
}

/** A script zone (v90): which script, where it runs, the answers its "goto:" line picks, and the secrets it gets. */
/** The answers a zone may pick, each with the zone it leads to (a script's "goto:", a subagent's choice). */
function Answers({ routes, others, set, hint }: { routes: { answer: string; to: string }[]; others: BrowserFlowStage[]; set: (next: { answer: string; to: string }[]) => void; hint: React.ReactNode }) {
  return <div className="grid gap-1.5" data-code-routes><span className="text-body font-medium">Answers (optional)</span>
    <p className="text-caption text-muted-foreground font-normal">{hint}</p>
    {routes.map((route, index) => <div key={index} className="flex gap-1.5">
      <Input value={route.answer} maxLength={40} onChange={event => set(routes.map((one, at) => at === index ? { ...one, answer: event.target.value } : one))} className="w-32 shrink-0" placeholder="Urgent" aria-label={`Answer ${index + 1}`} />
      <select className={SELECT} value={route.to} onChange={event => set(routes.map((one, at) => at === index ? { ...one, to: event.target.value } : one))} aria-label={`Where ${route.answer || `answer ${index + 1}`} leads`}>
        {others.map(one => <option key={one.id} value={one.id}>{one.title}</option>)}</select>
      <Button variant="ghost" size="icon" onClick={() => set(routes.filter((_, at) => at !== index))} aria-label={`Remove ${route.answer || `answer ${index + 1}`}`}><X className="size-4" /></Button>
    </div>)}
    {routes.length < 12 && others.length > 0 && <Button size="sm" variant="outline" className="self-start" onClick={() => set([...routes, { answer: "", to: others[0]!.id }])}><Plus className="size-4" />Add an answer</Button>}
  </div>;
}

/** v92: a subagent's question about this card; the person asked answers with a tap or in their words. */
function SubagentQuestion({ question, csrf, apply }: { question: NonNullable<BrowserFlowCard["question"]>; csrf: string; apply: (result: Said) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const answer = async (fields: Record<string, string>) => { setBusy(true); const result = await send(`/settings/lead/subagents/questions/${question.id}/answer`, fields, csrf); setBusy(false); apply(result); if (result.ok) setText(""); };
  const call = question.call ?? null;
  return <div className="flex flex-col gap-2 rounded-lg border border-attention/50 p-3" data-subagent-question={question.id}>
    <p className="text-caption text-muted-foreground font-normal">{call === null ? `${question.from} asks${question.mine ? " you" : ` ${question.askedOf}`}` : `${question.from} needs ${question.mine ? "your" : `${question.askedOf}'s`} approval`}</p>
    <p className="break-words text-body font-medium">{question.question}</p>
    {call !== null && <p className="text-[12.5px] text-muted-foreground" data-subagent-call-why>{call.why !== "" && <>{call.why} </>}({call.rule})</p>}
    {question.mine && <>
      {question.options.length > 0 && <div className="flex flex-wrap gap-2">{question.options.map((one, at) => <Button key={one.id} size="sm" variant={call !== null && at === 0 ? "default" : "outline"} disabled={busy} onClick={() => void answer({ choice: one.id })}>{one.label}</Button>)}</div>}
      <Textarea value={text} onChange={event => setText(event.target.value)} rows={2} maxLength={2000} placeholder={call === null ? "Or answer in your words" : `Or tell ${question.from.split(" · ")[0]} what to do instead`} aria-label="Your answer" />
      <Button size="sm" className="self-start" disabled={busy || text.trim() === ""} onClick={() => void answer({ text })}>Answer</Button>
    </>}
  </div>;
}

/** v92: a "Subagent handles it" zone: who, what to do here, and where its answers lead. */
function SubagentSettings({ stage, others, view, update }: { stage: BrowserFlowStage; others: BrowserFlowStage[]; view: BrowserFlowView; update: (change: Partial<BrowserFlowStage>) => void }) {
  const mates = view.subagents ?? [];
  return <>
    <Field label="Subagent" hint={mates.length === 0 ? undefined : "It follows its soul file's rules, and asks the flow's owner when they say to."}>
      {mates.length === 0 ? <p className="text-body text-muted-foreground">No subagents in this project yet. <a className="font-medium text-primary underline-offset-4 hover:underline" href="/settings/lead/subagents">Add one</a>.</p>
        : <select className={SELECT} aria-label="Subagent" value={stage.subagent ?? ""} onChange={event => update({ subagent: event.target.value })}>
          {mates.map(one => <option key={one.handle} value={one.handle}>{one.label}{one.working ? "" : " (paused)"}</option>)}</select>}
    </Field>
    <Field label="What to do here"><Textarea rows={4} value={stage.instructions ?? ""} maxLength={8000} onChange={event => update({ instructions: event.target.value })} aria-label="What to do here" placeholder="Read the customer's reply and decide what happens next." /></Field>
    <Answers routes={stage.routes ?? []} others={others} set={routes => update({ routes })} hint="It picks one, and writes what the next zones send. With none, it moves the card on to “Then”." />
    <label className="flex items-start gap-2 text-body"><input type="checkbox" className="mt-0.5 size-4" checked={stage.reply === true} onChange={event => update({ reply: event.target.checked ? true : undefined })} data-subagent-reply />
      <span>Answer whoever asked<span className="block text-caption text-muted-foreground font-normal">What it writes goes back to the person who added the card, in their chat app.</span></span></label>
  </>;
}

function CodeSettings({ stage, others, view, csrf, apply, update }: { stage: BrowserFlowStage; others: BrowserFlowStage[]; view: BrowserFlowView; csrf: string; apply: (result: Said) => void; update: (change: Partial<BrowserFlowStage>) => void }) {
  const routes = stage.routes ?? [];
  const script = view.scripts.find(one => one.name === stage.script);
  const setRoutes = (next: { answer: string; to: string }[]) => update({ routes: next });
  return <>
    <Field label="Script" hint={view.scripts.length === 0 ? "This project has no scripts yet: make one with Scripts in the toolbar, or ask your lead in chat." : script !== undefined ? `${LANGUAGE_NAMES[script.language]}${script.file === null ? "" : `, runs ${script.file}`}. It gets the card as JSON on stdin; what it prints is this step's result.` : undefined}>
      <select className={SELECT} aria-label="Script" value={stage.script ?? ""} onChange={event => update({ script: event.target.value || null })}>
        <option value="">Choose a script</option>
        {view.scripts.map(one => <option key={one.name} value={one.name}>{one.name} — {one.about}</option>)}
        {stage.script !== null && !view.scripts.some(one => one.name === stage.script) && <option value={stage.script}>{stage.script} (missing)</option>}
      </select>
    </Field>
    <Field label="Runs in" hint={(stage.runIn ?? "copy") === "folder" ? "Fast. The project's folder is at $FLOW_PROJECT." : "The project's setup runs first. Use this to test or check code."}>
      <select className={SELECT} aria-label="Runs in" value={stage.runIn ?? "copy"} onChange={event => update({ runIn: event.target.value as "folder" | "copy" })}>
        <option value="folder">An empty folder</option><option value="copy">A copy of the project, at the card's work</option>
      </select>
    </Field>
    <label className="flex items-start gap-2 text-body"><input type="checkbox" className="mt-0.5 size-4 accent-primary" checked={stage.browser === true} onChange={event => update({ browser: event.target.checked ? true : undefined })} data-zone-browser-toggle />
      <span>Starts a browser<span className="block text-caption text-muted-foreground font-normal">Playwright's Chromium. It runs only once a person allows browser use for this flow.</span></span></label>
    <Answers routes={routes} others={others} set={setRoutes} hint={<>If its last line is “goto: <em>answer</em>”, the card goes where that answer leads.</>} />
    <SecretsBox view={view} csrf={csrf} apply={apply} chosen={stage.secrets ?? []} choose={names => update({ secrets: names })}
      words="Kept on this computer, never shown again. The script gets each one it's given as a variable of the same name." />
  </>;
}

const LANGUAGE_NAMES: Record<string, string> = { shell: "Shell", python: "Python", node: "Node" };
/** What a new script looks like in each language: read the card, print a result. */
const SCRIPT_EXAMPLES: Record<string, string> = {
  python: "import json, sys\ncard = json.load(sys.stdin)[\"card\"]\nprint(f\"Looked at {card['title']}\")",
  node: "import { readFileSync } from \"node:fs\";\nconst { card } = JSON.parse(readFileSync(0, \"utf8\"));\nconsole.log(`Looked at ${card.title}`);",
  shell: "npm ci\nnpm test",
};

/** An email: who it goes to, the subject and the words. */
function EmailSettings({ email, view, set }: { email: NonNullable<BrowserFlowStage["email"]>; view: BrowserFlowView; set: (email: NonNullable<BrowserFlowStage["email"]>) => void }) {
  return <>
    {!view.emailReady && <p className="rounded-md border border-border px-3 py-2 text-[12.5px]" data-email-needs-setup>Email isn't set up yet. <a className="font-medium text-primary underline-offset-4 hover:underline" href="/settings/alerts#email">Add your mail server in Settings</a></p>}
    <Field label="To"><Input value={email.to} maxLength={500} onChange={event => set({ ...email, to: event.target.value })} aria-label="To" /></Field>
    <Field label="Subject"><Input value={email.subject} maxLength={200} onChange={event => set({ ...email, subject: event.target.value })} aria-label="Subject" /></Field>
    <Field label="Email" hint={FILL_INS}><Textarea rows={6} value={email.body} maxLength={8000} onChange={event => set({ ...email, body: event.target.value })} aria-label="Email" /></Field>
  </>;
}

/** A project tool: which one, which of its functions, and the arguments. */
function ToolSettings({ tool, view, set }: { tool: NonNullable<BrowserFlowStage["tool"]>; view: BrowserFlowView; set: (tool: NonNullable<BrowserFlowStage["tool"]>) => void }) {
  const chosen = view.tools.find(one => one.name === tool.server);
  return <>
    {view.tools.length === 0 ? <p className="rounded-md border border-border px-3 py-2 text-[12.5px]" data-tool-needs-setup>This project has no tools yet. <a className="font-medium text-primary underline-offset-4 hover:underline" href="/settings/tools">Add one on the Tools page</a></p>
      : <Field label="Tool" {...(chosen !== undefined && !chosen.ready ? { hint: "It needs its secrets set on the Tools page first." } : chosen !== undefined ? { hint: chosen.about } : {})}>
        <select className={SELECT} value={tool.server} onChange={event => set({ ...tool, server: event.target.value, name: view.tools.find(one => one.name === event.target.value)?.functions[0] ?? "" })} aria-label="Tool">
          {chosen === undefined && <option value={tool.server}>{tool.server === "" ? "Choose a tool" : `${tool.server} (missing)`}</option>}
          {view.tools.map(one => <option key={one.name} value={one.name}>{one.name}</option>)}
        </select>
      </Field>}
    <Field label="What it does" hint={chosen !== undefined && chosen.functions.length === 0 ? "Test the tool on the Tools page to list what it can do." : undefined}>
      {chosen !== undefined && chosen.functions.length > 0
        ? <select className={SELECT} value={tool.name} onChange={event => set({ ...tool, name: event.target.value })} aria-label="What it does">
          {!chosen.functions.includes(tool.name) && <option value={tool.name}>{tool.name || "Choose"}</option>}
          {chosen.functions.map(one => <option key={one} value={one}>{one}</option>)}
        </select>
        : <Input value={tool.name} maxLength={100} onChange={event => set({ ...tool, name: event.target.value })} className="font-mono" aria-label="What it does" />}
    </Field>
    <Field label="Arguments" hint={`JSON, with fill-ins inside its strings. ${FILL_INS}`}>
      <Textarea rows={5} value={tool.args} maxLength={4000} onChange={event => set({ ...tool, args: event.target.value })} className="font-mono text-mono" aria-label="Arguments" />
    </Field>
  </>;
}

function ZonePanel({ stage, stages, view, csrf, apply, update, remove, makeStart, onClose }: { stage: BrowserFlowStage; stages: BrowserFlowStage[]; view: BrowserFlowView; csrf: string; apply: (result: Said) => void; update: (change: Partial<BrowserFlowStage>) => void; remove: () => void; makeStart: () => void; onClose: () => void }) {
  const others = stages.filter(one => one.id !== stage.id);
  const select = SELECT;
  const kind = view.kinds.find(one => one.kind === stage.kind);
  return <div className="flex flex-col gap-3" data-flow-zone-panel={stage.id}>
    <div className="flex items-center gap-2"><h2 className="flex-1 text-title">Edit zone</h2><Button variant="ghost" size="icon" onClick={onClose} aria-label="Close"><X className="size-4" /></Button></div>
    <Field label="Name"><Input value={stage.title} maxLength={60} onChange={event => update({ title: event.target.value })} aria-label="Zone name" /></Field>
    <Field label="What happens here" {...(kind === undefined ? {} : { hint: kind.about })}>
      <select className={select} aria-label="What happens here" value={stage.kind} onChange={event => update({ kind: event.target.value as BrowserFlowStage["kind"], ...(event.target.value === "done" ? { next: null, onFail: null } : {}),
        ...(event.target.value === "update" ? { close: stage.close ?? true, message: stage.message ?? "Done: {{card.title}}" } : {}), ...(event.target.value === "check" ? { script: stage.script ?? view.scripts[0]?.name ?? null, runIn: stage.runIn ?? "folder" } : {}),
        ...(event.target.value === "request" ? { request: stage.request ?? { method: "POST", url: "https://", headers: {}, body: '{"title": "{{card.title}}", "details": "{{card.description}}"}' } } : {}),
        ...(event.target.value === "email" ? { email: stage.email ?? { to: "{{card.email}}", subject: "Re: {{card.title}}", body: stages.find(one => one.kind === "draft") ? `{{stage.${stages.find(one => one.kind === "draft")!.id}}}` : "" } } : {}),
        ...(event.target.value === "tool" ? { tool: stage.tool ?? { server: view.tools[0]?.name ?? "", name: view.tools[0]?.functions[0] ?? "", args: '{"text": "{{card.title}}"}' } } : {}),
        ...(event.target.value === "draft" ? { instructions: stage.instructions ?? "Write a short, friendly reply to the person who sent this card, in plain words." } : {}),
        ...(event.target.value === "approval" ? { toOwner: stage.toOwner ?? true } : {}),
        ...(event.target.value === "wait" ? { wait: stage.wait ?? { for: "reply", minutes: 3 * 24 * 60 } } : {}),
        ...(event.target.value === "subagent" ? { subagent: stage.subagent ?? view.subagents?.[0]?.handle, instructions: stage.instructions ?? "Read the card and decide what happens next." }
          : event.target.value !== "approval" ? { subagent: undefined } : {}),
        ...(event.target.value === "wait" || event.target.value === "done" ? { limit: undefined } : event.target.value !== "inbox" && event.target.value !== "approval" && event.target.value !== "choose" && stage.limit !== undefined ? { limit: { ...stage.limit, to: null } } : {}),
        ...(event.target.value === "choose" ? { next: null, options: stage.options ?? [{ label: "Looks good", to: others.find(one => one.kind === "done")?.id ?? others[0]?.id ?? "end" }, { label: "Ignore", to: "end" }] } : { options: undefined }),
        ...(event.target.value === "task" ? {} : { repo: undefined }),
        ...(event.target.value === "sort" ? { next: null, sort: stage.sort ?? { question: "What kind of card is this?", answers: others.slice(0, 2).map(one => ({ answer: one.title.slice(0, 40), means: one.title, to: one.id })), sureAt: 0.8, notes: [] } } : {}) })}>
        {view.kinds.map(one => <option key={one.kind} value={one.kind}>{one.label}</option>)}
      </select>
    </Field>
    {stage.kind === "draft" && <Field label="What Claude should write" hint="Claude reads the card and what earlier zones said. Put a “Person decides” zone next to read and edit it first.">
      <Textarea rows={5} value={stage.instructions ?? ""} maxLength={8000} onChange={event => update({ instructions: event.target.value })} aria-label="What Claude should write" />
    </Field>}
    {(stage.kind === "task" || stage.kind === "report") && <Field label="What the agent should do" hint={"Fill-ins: {{card.title}}, {{card.description}}, {{note}} (the latest send-back note), {{stage.<zone id>}} (an earlier zone's report; a research zone adds .items and .report)."}>
      <Textarea rows={7} value={stage.instructions ?? ""} onChange={event => update({ instructions: event.target.value })} aria-label="What the agent should do" />
    </Field>}
    {stage.kind === "task" && (view.projects ?? []).length > 1 && <Field label="Builds in" hint="Another project files its task there, as the flow's owner, under that project's approvals.">
      <select className={select} aria-label="Builds in" value={stage.repo ?? view.projects![0]!.path} onChange={event => update({ repo: event.target.value === view.projects![0]!.path ? undefined : event.target.value })}>
        {view.projects!.map((one, index) => <option key={one.path} value={one.path}>{index === 0 ? `${one.name} (this flow's project)` : one.name}</option>)}
        {stage.repo !== undefined && !view.projects!.some(one => one.path === stage.repo) && <option value={stage.repo}>{stage.repo} (not yours)</option>}
      </select>
    </Field>}
    {stage.kind === "choose" && <ChooseSettings options={stage.options ?? []} others={others} set={options => update({ options })} />}
    {stage.kind === "task" && <Field label="Plan first?">
      <select className={select} aria-label="Plan first?" value={stage.planning ?? "auto"} onChange={event => update({ planning: event.target.value as "auto" | "required" | "skip" })}>
        <option value="auto">Let Toolroll decide</option><option value="required">Always plan first</option><option value="skip">Build directly</option>
      </select>
    </Field>}
    {stage.kind === "approval" && <Field label="Who decides">
      <select className={select} aria-label="Who decides" value={stage.subagent !== undefined ? `__mate__:${stage.subagent}` : stage.toOwner === true ? "__owner__" : stage.approver ?? ""}
        onChange={event => update(event.target.value.startsWith("__mate__:") ? { subagent: event.target.value.slice(9), toOwner: true, approver: null }
          : event.target.value === "__owner__" ? { subagent: undefined, toOwner: true, approver: null } : { subagent: undefined, toOwner: false, approver: event.target.value === "" ? null : event.target.value })}>
        {(view.subagents ?? []).map(one => <option key={one.handle} value={`__mate__:${one.handle}`}>{one.name} (subagent), handing hard ones to the flow's owner{one.working ? "" : " (paused)"}</option>)}
        <option value="__owner__">The flow's owner ({view.flow.owner}), in their chat app</option>
        <option value="">Anyone who can approve</option>{view.approvers.map(name => <option key={name} value={name}>{name}</option>)}
      </select>
    </Field>}
    {stage.kind === "notify" && <Field label="Message"><Input value={stage.message ?? ""} maxLength={1000} onChange={event => update({ message: event.target.value })} aria-label="Message" /></Field>}
    {stage.kind === "update" && <>
      <Field label="Comment on the issue" hint={"Fill-ins: {{card.title}}, {{note}}, {{stage.<zone id>}}."}><Textarea rows={3} value={stage.message ?? ""} maxLength={1000} onChange={event => update({ message: event.target.value })} aria-label="Comment on the issue" /></Field>
      <label className="flex items-center gap-2 text-body"><input type="checkbox" className="size-4 accent-primary" checked={stage.close !== false} onChange={event => update({ close: event.target.checked })} />Close the issue too (Linear: move it to done)</label>
    </>}
    {stage.kind === "pull-request" && <Field label="When checks pass" hint="Merging needs a “Person decides” zone before this one, and a person's approval of the card since it was built.">
      <select className={select} aria-label="When checks pass" value={stage.merge ?? ""} onChange={event => update({ merge: event.target.value === "" ? undefined : event.target.value as "squash" | "merge" | "rebase" })}>
        <option value="">Move on; a person merges</option><option value="squash">Merge (squash)</option><option value="merge">Merge (merge commit)</option><option value="rebase">Merge (rebase)</option>
      </select>
    </Field>}
    {stage.kind === "check" && <CodeSettings stage={stage} others={others} view={view} csrf={csrf} apply={apply} update={update} />}
    {stage.kind === "subagent" && <SubagentSettings stage={stage} others={others} view={view} update={update} />}
    {stage.kind === "request" && stage.request !== undefined && <RequestSettings request={stage.request} view={view} csrf={csrf} apply={apply} set={request => update({ request })} />}
    {stage.kind === "email" && stage.email !== undefined && <EmailSettings email={stage.email} view={view} set={email => update({ email })} />}
    {stage.kind === "tool" && stage.tool !== undefined && <ToolSettings tool={stage.tool} view={view} set={tool => update({ tool })} />}
    {stage.kind === "sort" && stage.sort !== null && <SortSettings sort={stage.sort} others={others} ready={view.sortReady} set={sort => update({ sort })} />}
    {stage.kind === "wait" && stage.wait !== undefined && <>
      <Field label="Wait for" hint={stage.wait.for === "reply" ? "Only a reply from someone it emailed counts. Needs the inbox in Settings → Email." : undefined}>
        <select className={select} aria-label="Wait for" value={stage.wait.for} onChange={event => update({ wait: event.target.value === "hours" ? { for: "hours", minutes: 0, from: stage.wait!.from ?? "22:00", to: stage.wait!.to ?? "06:00" }
          : { for: event.target.value as "reply" | "time", minutes: stage.wait!.minutes > 0 ? stage.wait!.minutes : 24 * 60 } })}>
          <option value="reply">A reply to the card's email</option><option value="time">A set time</option><option value="hours">Set hours, like overnight</option>
        </select>
      </Field>
      {stage.wait.for === "hours" ? <div className="grid grid-cols-2 gap-2">
        <Field label="From"><Input type="time" value={stage.wait.from ?? "22:00"} onChange={event => update({ wait: { ...stage.wait!, from: event.target.value } })} aria-label="From" /></Field>
        <Field label="Until"><Input type="time" value={stage.wait.to ?? "06:00"} onChange={event => update({ wait: { ...stage.wait!, to: event.target.value } })} aria-label="Until" /></Field>
      </div>
        : <Field label={stage.wait.for === "reply" ? "For up to" : "How long"}><Duration minutes={stage.wait.minutes} label={stage.wait.for === "reply" ? "For up to" : "How long"} set={minutes => update({ wait: { ...stage.wait!, minutes } })} /></Field>}
    </>}
    {stage.kind !== "done" && stage.kind !== "sort" && stage.kind !== "choose" && <Field label={stage.kind === "wait" && stage.wait?.for === "reply" ? "When they reply" : "Then"}>
      <select className={select} aria-label={stage.kind === "wait" && stage.wait?.for === "reply" ? "When they reply" : "Then"} value={stage.next ?? ""} onChange={event => update({ next: event.target.value || null })}>
        <option value="">Wait here</option>{others.map(one => <option key={one.id} value={one.id}>{one.title}</option>)}
      </select>
    </Field>}
    {stage.kind === "wait" && stage.wait?.for === "reply" && <Field label="If no reply">
      <select className={select} aria-label="If no reply" value={stage.onFail ?? ""} onChange={event => update({ onFail: event.target.value || null })}>
        <option value="">Stay here for a person</option>{others.map(one => <option key={one.id} value={one.id}>{one.title}</option>)}
      </select>
    </Field>}
    {(stage.kind === "approval" || stage.kind === "task" || stage.kind === "report" || stage.kind === "check" || stage.kind === "pull-request" || stage.kind === "update" || stage.kind === "sort" || stage.kind === "request" || stage.kind === "email" || stage.kind === "tool" || stage.kind === "subagent" || stage.kind === "choose") && <Field label={FAIL_LABELS[stage.kind] ?? "If it fails"} {...(stage.kind === "choose" ? { hint: "Their reply is the note there ({{note}})." } : {})}>
      <select className={select} aria-label={FAIL_LABELS[stage.kind] ?? "If it fails"} value={stage.onFail ?? ""} onChange={event => update({ onFail: event.target.value || null })}>
        <option value="">{stage.kind === "approval" ? "Can't be sent back" : stage.kind === "sort" ? "Wait here for a person" : stage.kind === "choose" ? "Where the first option goes" : "Wait here"}</option>{others.map(one => <option key={one.id} value={one.id}>{one.title}</option>)}
      </select>
    </Field>}
    {stage.kind !== "wait" && stage.kind !== "done" && <TimeLimit stage={stage} others={others} update={update} />}
    <div className="grid gap-1.5"><span className="text-body font-medium">Color</span>
      <div className="flex gap-2">{view.colors.map(color => <button key={color} type="button" aria-label={color} aria-pressed={stage.zone.color === color}
        className={cn("size-7 rounded-full border-2", stage.zone.color === color ? "border-foreground" : "border-transparent")} style={{ background: COLORS[color] }}
        onClick={() => update({ zone: { ...stage.zone, color } })} />)}</div>
    </div>
    <div className="flex flex-wrap gap-2 pt-1">
      {view.start !== stage.id && <Button variant="outline" size="sm" onClick={makeStart}>New cards start here</Button>}
      <Button variant="ghost" size="sm" className="text-destructive" onClick={remove} disabled={stages.length <= 1}>Delete zone</Button>
    </div>
  </div>;
}

/** What a zone's failure path is called in its settings. */
const FAIL_LABELS: Partial<Record<BrowserFlowStage["kind"], string>> = { approval: "If sent back", sort: "If it isn't sure", subagent: "If it can't handle it", "pull-request": "If checks fail", choose: "If they reply" };

/** A "Person chooses" zone's buttons: 2 to 4, each with its words and where it leads (or ignoring the card). */
function ChooseSettings({ options, others, set }: { options: { label: string; to: string }[]; others: BrowserFlowStage[]; set: (options: { label: string; to: string }[]) => void }) {
  const change = (index: number, change: Partial<{ label: string; to: string }>) => set(options.map((one, at) => at === index ? { ...one, ...change } : one));
  return <div className="grid gap-2" data-choose-options>
    <span className="text-body font-medium">Buttons</span>
    {options.map((option, index) => <div key={index} className="flex flex-wrap items-center gap-2">
      <Input className="min-w-0 flex-1" value={option.label} maxLength={40} onChange={event => change(index, { label: event.target.value })} aria-label={`Button ${index + 1}`} />
      <select className={cn(SELECT, "min-w-0 flex-1")} aria-label={`Button ${index + 1} goes to`} value={option.to} onChange={event => change(index, { to: event.target.value })}>
        <option value="end">Ignore the card</option>{others.map(one => <option key={one.id} value={one.id}>{one.title}</option>)}
      </select>
      {options.length > 2 && <Button type="button" variant="ghost" size="icon" onClick={() => set(options.filter((_, at) => at !== index))} aria-label={`Remove button ${index + 1}`}><X className="size-4" /></Button>}
    </div>)}
    {options.length < 4 && <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => set([...options, { label: "", to: others[0]?.id ?? "end" }])}><Plus className="size-4" />Add a button</Button>}
  </div>;
}

/** A length of time as a number and a unit: minutes, hours or days. */
function Duration({ minutes, label, set }: { minutes: number; label: string; set: (minutes: number) => void }) {
  const unit = minutes % 1440 === 0 ? 1440 : minutes % 60 === 0 ? 60 : 1;
  return <div className="flex gap-2">
    <Input type="number" min={1} max={Math.floor(43200 / unit)} value={minutes / unit} className="w-24" aria-label={`${label} (number)`}
      onChange={event => { const n = Math.round(Number(event.target.value)); if (Number.isFinite(n) && n >= 1) set(Math.min(43200, n * unit)); }} />
    <select className={SELECT} aria-label={`${label} (unit)`} value={unit} onChange={event => set(Math.min(43200, Math.max(1, (minutes / unit) * Number(event.target.value))))}>
      <option value={1}>minutes</option><option value={60}>hours</option><option value={1440}>days</option>
    </select>
  </div>;
}

/** v91: how long a card may sit in a zone before the person it waits on is reminded (and, for Holding and decisions, where it goes then). */
function TimeLimit({ stage, others, update }: { stage: BrowserFlowStage; others: BrowserFlowStage[]; update: (change: Partial<BrowserFlowStage>) => void }) {
  const moves = stage.kind === "inbox" || stage.kind === "approval" || stage.kind === "choose";
  return <div className="grid gap-2" data-time-limit>
    <label className="flex items-center gap-2 text-body font-medium"><input type="checkbox" className="size-4 accent-primary" checked={stage.limit !== undefined}
      onChange={event => update({ limit: event.target.checked ? { minutes: 24 * 60, to: null } : undefined })} />Time limit</label>
    {stage.limit !== undefined && <>
      <Field label="Remind after" hint={stage.kind === "approval" ? "Whoever decides hears about it once." : stage.kind === "choose" ? "Whoever chooses hears about it once." : "The card's owner (or the flow's) hears about it once."}>
        <Duration minutes={stage.limit.minutes} label="Remind after" set={minutes => update({ limit: { ...stage.limit!, minutes } })} />
      </Field>
      {moves && <Field label={stage.kind === "choose" ? "If no reply" : "Then"}>
        <select className={SELECT} aria-label="After the time limit" value={stage.limit.to ?? ""} onChange={event => update({ limit: { ...stage.limit!, to: event.target.value || null } })}>
          <option value="">Keep it here</option>{others.map(one => <option key={one.id} value={one.id}>Move it to {one.title}</option>)}
        </select>
      </Field>}
    </>}
  </div>;
}

function NewCard({ view, csrf, apply }: { view: BrowserFlowView; csrf: string; apply: (result: Said) => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const start = view.stages.find(one => one.id === view.start);
  return <form className="flex flex-col gap-2" onSubmit={async event => {
    event.preventDefault();
    setBusy(true);
    const result = await send(`${view.flow.href}/cards`, { title, description }, csrf);
    setBusy(false);
    apply(result);
    if (result.ok) { setTitle(""); setDescription(""); }
  }}>
    <p className="text-caption text-muted-foreground font-normal">It starts in {start?.title ?? "the first zone"}.</p>
    <Input value={title} onChange={event => setTitle(event.target.value)} placeholder="What needs doing?" maxLength={200} required aria-label="Title" />
    <Textarea value={description} onChange={event => setDescription(event.target.value)} placeholder="Details (optional)" rows={4} aria-label="Details" />
    <KActs><KButton type="submit" variant="primary" label="Add card" busy={busy ? "Adding…" : false} disabled={title.trim() === ""} /></KActs>
  </form>;
}

const ago = (at: string | null): string => {
  if (at === null) return "";
  const minutes = Math.round((Date.now() - Date.parse(at)) / 60_000);
  return minutes < 1 ? "Just now" : minutes < 60 ? `${minutes} min ago` : minutes < 1440 ? `${Math.round(minutes / 60)} h ago` : threadWhen(at);
};

function CopyLine({ label, value }: { label: string; value: string }) {
  const [said, setSaid] = useState<string | null>(null);
  const copy = () => { void navigator.clipboard?.writeText(value).then(() => setSaid(`${label} copied.`), () => setSaid("Select it and copy it by hand.")); };
  return <div className="grid gap-1"><span className="text-caption">{label}</span>
    <div className="flex gap-2"><Input readOnly value={value} className="h-8 font-mono text-mono" onFocus={event => event.target.select()} aria-label={label} />
      <Button type="button" size="sm" variant="outline" onClick={copy} aria-label={`Copy ${label.toLowerCase()}`}><Copy className="size-3.5" /></Button></div>
    {said !== null && <p className="k-note" role="status">{said}</p>}</div>;
}

/** A new webhook address (and GitHub's secret), shown once. */
function RevealBox({ kind, reveal, onDone }: { kind: string; reveal: Reveal; onDone: () => void }) {
  return <div className="flex flex-col gap-2 rounded-lg border border-primary/40 bg-primary/5 p-3" data-trigger-reveal>
    <p className="text-body font-semibold">Copy these now. They aren't shown again.</p>
    {reveal.path === "" ? null : reveal.address === null
      ? <p className="text-caption font-normal">Save your public webhook address below first, then choose New address. <span className="break-all font-mono">{reveal.path}</span></p>
      : <CopyLine label="Address" value={reveal.address} />}
    {reveal.secret !== null && <CopyLine label="Secret" value={reveal.secret} />}
    <p className="text-caption text-muted-foreground font-normal">{kind === "github" ? "In GitHub: Settings → Webhooks → Add webhook. Paste the address and the secret, choose application/json, and pick the events this trigger watches (Issues, Pull requests or Workflow runs)."
      : kind === "linear" ? "In Linear: Settings → API → Webhooks → New webhook. Paste the address and choose Issues. Then paste Linear's signing secret on this trigger."
      : kind === "form" ? "Share this link. Anyone who has it can add a card without signing in; the work it starts still waits for your approval."
      : kind === "sentry" ? "In Sentry: Settings → Developer Settings → Internal Integration. Paste the address as its Webhook URL, turn on Alert Rule Action and Issue events, then paste its Client Secret on this trigger."
      : kind === "vercel" ? "In Vercel: Settings → Webhooks. Paste the address, choose Deployment Error, then paste the secret Vercel shows on this trigger."
      : kind === "standard" ? "Give the sender the address and the secret (whsec_…): it signs each delivery the Standard Webhooks way."
      : kind === "github-style" ? "Give the sender the address and the secret: it signs each delivery's body with HMAC-SHA256 in an X-Hub-Signature-256: sha256=… header."
      : "Post JSON to the address. A title field becomes the card's title; description, its details. Anyone with the address can post: choose who signs it to close that."}</p>
    <Button type="button" size="sm" variant="outline" className="self-start" onClick={onDone}>Done</Button>
  </div>;
}

const TRIGGER_KEYS: Record<string, string[]> = {
  button: ["label", "questions"], schedule: ["schedule", "title", "description", "script", "secrets"], github: ["repo", "watch", "label", "branch", "from", "delivery"],
  linear: ["team", "state", "label", "delivery"], flow: ["flow", "when"], webhook: ["title", "titleField", "bodyField"], email: ["folder", "sender", "subject"],
  "plane-review": ["at", "timeZone"],
};

function AddTrigger({ view, csrf, open, onResult }: { view: BrowserFlowView; csrf: string; open: boolean; onResult: (result: Said, kind: string) => void }) {
  const setup = view.triggerSetup;
  const [kind, setKind] = useState("button");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [scripted, setScripted] = useState(false);
  const [busy, setBusy] = useState(false);
  // A trigger that takes deliveries mints a webhook address: a credential act, so it asks for the password (passwordless.md).
  const [password, setPassword] = useState("");
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const defaults: Record<string, Record<string, string>> = {
    schedule: { schedule: `daily 09:00 ${timezone}` }, github: { repo: setup.githubRepo ?? "", watch: "issues", from: "team", delivery: "poll", branch: "main" },
    linear: { delivery: "poll" }, flow: { flow: String(setup.otherFlows[0]?.id ?? "") }, webhook: { title: "Webhook" }, email: { folder: "INBOX" },
    "plane-review": { at: "07:30", timeZone: timezone },
  };
  const v = (key: string) => fields[key] ?? defaults[kind]?.[key] ?? "";
  const ingress = kind === "webhook" || ((kind === "github" || kind === "linear") && v("delivery") === "webhook");
  // Items from anyone (GitHub from anyone, mail from any sender): an ordinary step-up (chat-management.md §0a.3).
  const anyone = !ingress && ((kind === "github" && v("from") === "anyone") || (kind === "email" && v("sender").trim() === ""));
  const passwordless = useContext(Passwordless);
  const set = (key: string) => (event: { target: { value: string } }) => setFields(current => ({ ...current, [key]: event.target.value }));
  const source = setup.otherFlows.find(one => String(one.id) === v("flow"));
  const submit = async (event: { preventDefault: () => void }) => {
    event.preventDefault();
    const trigger: Record<string, unknown> = { kind, zone: v("zone") || null };
    for (const key of TRIGGER_KEYS[kind] ?? []) trigger[key] = key === "questions" ? v(key).split("\n") : key === "flow" ? Number(v(key)) : v(key) || null;
    setBusy(true);
    const result = await send(`${view.flow.href}/triggers`, { trigger: JSON.stringify(trigger), ...(ingress || anyone ? { password } : {}) }, csrf);
    if (result.ok) setPassword("");
    setBusy(false);
    onResult(result, kind);
    if (result.ok) setFields({});
  };
  return <details className="rounded-lg border px-3 py-2" open={open}>
    <summary className="cursor-pointer text-body font-semibold">Add a trigger</summary>
    <form className="flex flex-col gap-3 pt-3" onSubmit={event => void submit(event)} data-add-trigger>
      <Field label="What starts cards">
        <select className={SELECT} value={kind} onChange={event => { setKind(event.target.value); setFields({}); }}>
          {setup.kinds.map(one => <option key={one.kind} value={one.kind}>{one.label}</option>)}
        </select>
      </Field>
      {kind === "button" && <>
        <Field label="Button name"><Input value={v("label")} onChange={set("label")} placeholder="Report a bug" maxLength={40} required /></Field>
        <Field label="Questions it asks" hint="One per line. The first answer becomes the card's title.">
          <Textarea rows={3} value={v("questions")} onChange={set("questions")} placeholder={"What happened?\nSteps to reproduce\nHow bad is it?"} /></Field>
      </>}
      {kind === "schedule" && <>
        <Field label="When" hint="For example: daily 09:00 Europe/London, monday 09:00, every 4 hours."><Input value={v("schedule")} onChange={set("schedule")} required /></Field>
        <Field label="Makes">
          <select className={SELECT} value={v("script") === "" && !scripted ? "card" : "script"} aria-label="Makes" onChange={event => { setScripted(event.target.value === "script"); setFields(current => ({ ...current, script: event.target.value === "script" ? view.scripts[0]?.name ?? "" : "" })); }}>
            <option value="card">One card each time</option><option value="script">A card for each item a script prints</option></select></Field>
        {v("script") !== "" || scripted
          ? view.scripts.length === 0 ? <p className="text-body text-muted-foreground">This project has no scripts yet: make one with Scripts in the toolbar.</p> : <>
            <Field label="Script" hint="It prints one item per line (a title, or JSON like {&quot;title&quot;: &quot;…&quot;, &quot;key&quot;: 42}). The same item never makes two cards.">
              <select className={SELECT} value={v("script")} onChange={set("script")} aria-label="Script">{view.scripts.map(one => <option key={one.name} value={one.name}>{one.name} — {one.about}</option>)}</select></Field>
            <Field label="Secrets it gets (optional)" hint="Names of saved secrets, like CRM_KEY. Save them on a script zone's Secrets."><Input value={v("secrets")} onChange={set("secrets")} className="font-mono" placeholder="CRM_KEY" maxLength={400} /></Field>
          </>
          : <>
            <Field label="Card title" hint="Each card's date is added to it."><Input value={v("title")} onChange={set("title")} placeholder="Dependency check" maxLength={200} required /></Field>
            <Field label="Details (optional)"><Textarea rows={3} value={v("description")} onChange={set("description")} /></Field>
          </>}
      </>}
      {kind === "github" && <>
        <Field label="Repository"><Input value={v("repo")} onChange={set("repo")} placeholder="owner/name" required /></Field>
        <Field label="Watch"><select className={SELECT} value={v("watch")} onChange={set("watch")}>
          <option value="issues">New issues</option><option value="pulls">New pull requests</option><option value="checks">Failed checks</option></select></Field>
        {v("watch") !== "checks" && <Field label="Label (optional)" hint={v("watch") === "issues" ? "With a label, an issue joins the moment it gets the label." : "Only pull requests with this label."}>
          <Input value={v("label")} onChange={set("label")} placeholder="bug" maxLength={50} /></Field>}
        {v("watch") === "checks" && <Field label="Branch"><Input value={v("branch")} onChange={set("branch")} maxLength={100} /></Field>}
        {v("watch") !== "checks" && <Field label="From" hint={v("from") === "anyone" ? "Anyone who can open one there can write what the agent reads. The work still waits for your approval." : undefined}>
          <select className={SELECT} value={v("from")} onChange={set("from")}><option value="team">People with write access</option><option value="anyone">Anyone</option></select></Field>}
      </>}
      {kind === "linear" && <>
        <Field label="Team key" hint="Like ENG. Name a team, a label, or both."><Input value={v("team")} onChange={set("team")} placeholder="ENG" maxLength={12} /></Field>
        <Field label="When it moves to (optional)"><Input value={v("state")} onChange={set("state")} placeholder="Todo" maxLength={40} /></Field>
        <Field label="Label (optional)"><Input value={v("label")} onChange={set("label")} placeholder="bug" maxLength={50} /></Field>
      </>}
      {(kind === "github" || kind === "linear") && <Field label="How it arrives"
        hint={v("delivery") === "webhook" ? setup.hooksBase === null ? "Needs your public webhook address: set it under Settings below." : "You'll get an address to paste into " + (kind === "github" ? "GitHub." : "Linear.")
          : kind === "linear" && !setup.linearKey ? "Save your Linear key under Settings below first." : undefined}>
        <select className={SELECT} value={v("delivery")} onChange={set("delivery")}><option value="poll">Checked every 2 minutes</option><option value="webhook">Sent to a webhook address</option></select></Field>}
      {kind === "flow" && (setup.otherFlows.length === 0 ? <p className="text-body text-muted-foreground">There are no other flows to follow yet.</p> : <>
        <Field label="Flow"><select className={SELECT} value={v("flow")} onChange={event => setFields(current => ({ ...current, flow: event.target.value, when: "" }))}>
          {setup.otherFlows.map(one => <option key={one.id} value={one.id}>{one.name}</option>)}</select></Field>
        <Field label="When a card reaches"><select className={SELECT} value={v("when")} onChange={set("when")}>
          <option value="">The end</option>{source?.zones.map(one => <option key={one.id} value={one.id}>{one.title}</option>)}</select></Field>
      </>)}
      {kind === "chat" && <div className="flex flex-col gap-2 rounded-md bg-muted px-2.5 py-2 text-[12.5px]" data-chat-connect>
        <p>Connect a Slack, Discord or Teams channel, or a Telegram group, from the channel itself. Where Toolroll is, send:</p>
        <p><code className="rounded bg-background px-1.5 py-0.5 font-semibold">flow {view.flow.id}</code></p>
        <p className="text-muted-foreground">Each new message there becomes a card here, and replies in its thread join the card's discussion. “flow off” stops it. In Teams, mention Toolroll in each message. In Telegram, send /flow {view.flow.id}, and turn the bot's privacy mode off in BotFather so it sees every message.</p>
      </div>}
      {kind === "email" && <>
        {setup.mailbox === null
          ? <p className="rounded-md bg-muted px-2.5 py-2 text-[12.5px]" data-mailbox-missing>Reading mail isn't set up yet. Add your mail server's IMAP address, or sign in with Google, in <a className="underline" href="/settings/alerts#email">Settings → Email</a>.</p>
          : <p className="text-[12.5px] text-muted-foreground">New mail in {setup.mailbox} becomes cards, from now on. The mailbox is only read: nothing is marked or moved.</p>}
        <Field label="Folder"><Input value={v("folder")} onChange={set("folder")} placeholder="INBOX" maxLength={100} /></Field>
        <Field label="Only from (optional)" hint="Addresses or domains, like priya@example.com, example.com."><Input value={v("sender")} onChange={set("sender")} maxLength={300} /></Field>
        <Field label="Subject has (optional)"><Input value={v("subject")} onChange={set("subject")} placeholder="Order" maxLength={100} /></Field>
      </>}
      {kind === "plane-review" && <>
        <p className="text-[12.5px] text-muted-foreground">Every morning, reads the last 24 hours and makes one card per problem worth fixing. A problem that comes back joins its card. A clean day adds nothing.</p>
        <Field label="Time" hint={`Every day, in ${v("timeZone") || "your time zone"}.`}><Input type="time" value={v("at")} onChange={set("at")} required /></Field>
      </>}
      {kind === "webhook" && <>
        <Field label="Title field" hint="Where to find the card's title in the posted JSON, like title or data.issue.title."><Input value={v("titleField")} onChange={set("titleField")} placeholder="title" maxLength={80} /></Field>
        <Field label="Details field"><Input value={v("bodyField")} onChange={set("bodyField")} placeholder="description" maxLength={80} /></Field>
        <Field label="Title when there is none"><Input value={v("title")} onChange={set("title")} maxLength={120} /></Field>
      </>}
      {kind !== "chat" && <Field label="Cards start in"><select className={SELECT} value={v("zone")} onChange={set("zone")}>
        <option value="">{view.stages.find(one => one.id === view.start)?.title ?? "The first zone"}</option>
        {view.stages.filter(one => one.id !== view.start).map(one => <option key={one.id} value={one.id}>{one.title}</option>)}</select></Field>}
      {ingress && <StepUp view={view} password={password} setPassword={setPassword} credential />}
      {anyone && <StepUp view={view} password={password} setPassword={setPassword} />}
      {kind !== "chat" && <Button type="submit" size="sm" className="self-start" disabled={busy || (kind === "flow" && setup.otherFlows.length === 0) || (ingress && !stepUpReady(view, password)) || (anyone && !stepUpReady(view, password, passwordless))}><Plus className="size-4" />Add trigger</Button>}
    </form>
  </details>;
}

/** Installation settings a trigger may need: the Linear key (behind the password) and the public webhook address. */
function TriggerSettings({ view, csrf, apply }: { view: BrowserFlowView; csrf: string; apply: (result: Said) => void }) {
  const setup = view.triggerSetup;
  const passwordless = useContext(Passwordless);
  const [key, setKey] = useState("");
  const [password, setPassword] = useState("");
  const [address, setAddress] = useState(setup.hooksBase ?? "");
  const [busy, setBusy] = useState(false);
  const act = async (path: string, fields: Record<string, string>) => { setBusy(true); const result = await send(path, fields, csrf); setBusy(false); apply(result); if (result.ok) { setKey(""); setPassword(""); } };
  return <details className="rounded-lg border px-3 py-2">
    <summary className="cursor-pointer text-body font-semibold">Settings</summary>
    <div className="flex flex-col gap-4 pt-3">
      {setup.linearKey
        ? <div className="grid gap-1.5"><span className="text-body font-medium">Linear key</span><p className="text-caption text-muted-foreground font-normal">Saved on this computer.</p>
            <Button type="button" size="sm" variant="ghost" className="self-start text-destructive" disabled={busy} onClick={() => void act(`${view.flow.href}/linear-key`, { remove: "yes" })}>Remove key</Button></div>
        : <form className="flex flex-col gap-2" onSubmit={event => { event.preventDefault(); void act(`${view.flow.href}/linear-key`, { key, password }); }}>
            <Field label="Linear key" hint="From Linear → Settings → Security & access → Personal API keys. Kept on this computer only.">
              <Input type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} placeholder="lin_api_…" /></Field>
            <StepUp view={view} password={password} setPassword={setPassword} credential />
            <Button type="submit" size="sm" className="self-start" disabled={busy || key.trim() === "" || !stepUpReady(view, password, passwordless)}>Save key</Button>
          </form>}
      <form className="flex flex-col gap-2" onSubmit={event => { event.preventDefault(); void act(`${view.flow.href}/hooks-address`, { address }); }}>
        <Field label="Public webhook address" hint="The https site your reverse proxy (Caddy, for example) serves. Have it pass only paths starting /hooks/ to this console.">
          <Input value={address} onChange={event => setAddress(event.target.value)} placeholder="https://hooks.example.com" /></Field>
        <Button type="submit" size="sm" variant="outline" className="self-start" disabled={busy}>Save address</Button>
      </form>
    </div>
  </details>;
}

/** A step-up: the person's password, or (signed in with the identity provider) that sign-in, confirmed or to confirm.
 * Passwordless (docs/plans/passwordless.md): an ordinary one shows nothing; a credential act (`credential`) always asks. */
function StepUp({ view, password, setPassword, credential = false }: { view: BrowserFlowView; password: string; setPassword: (value: string) => void; credential?: boolean }) {
  const passwordless = useContext(Passwordless);
  if (!credential && passwordless) return null;
  if (view.stepUp === undefined) return <Field label="Your Toolroll password"><Input type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} /></Field>;
  return view.stepUp.fresh
    ? <p className="text-body text-success" data-sso-step-up="confirmed">✓ Confirmed with {view.stepUp.label}</p>
    : <a className="text-body underline" data-sso-step-up="confirm" href={view.stepUp.confirmHref}>Confirm with {view.stepUp.label}</a>;
}
const stepUpReady = (view: BrowserFlowView, password: string, passwordless = false) => passwordless || (view.stepUp === undefined ? password !== "" : view.stepUp.fresh);

/** A one-click action that opens a way in (a form link, a new webhook address): it asks for the password first, inline. */
function CredentialAction({ view, label, busy, className, onConfirm }: { view: BrowserFlowView; label: string; busy: boolean; className?: string; onConfirm: (password: string) => Promise<boolean> }) {
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState("");
  if (!asking) return <Button size="sm" variant="outline" className={className} disabled={busy} onClick={() => setAsking(true)}>{label}</Button>;
  return <span className="flex w-full flex-wrap items-end gap-2" data-credential-action>
    <StepUp view={view} password={password} setPassword={setPassword} credential />
    <Button size="sm" disabled={busy || !stepUpReady(view, password)} onClick={() => void onConfirm(password).then(done => { if (done) { setAsking(false); setPassword(""); } })}>{label}</Button>
    <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setAsking(false); setPassword(""); }}>Cancel</Button>
  </span>;
}

const SECRET_LABELS: Record<string, { label: string; hint: string }> = {
  linear: { label: "Linear's signing secret", hint: "Linear shows it when you create the webhook." },
  sentry: { label: "Sentry's Client Secret", hint: "In Sentry: Settings → Developer Settings → your Internal Integration → Client Secret." },
  vercel: { label: "Vercel's webhook secret", hint: "Vercel shows it once when you create the webhook (an integration's webhooks use its Client Secret)." },
};
const SENDER_CHOICES: [string, string][] = [["none", "Unsigned (the address alone)"], ["standard", "Standard Webhooks"], ["github-style", "GitHub-style signature"], ["sentry", "Sentry"], ["vercel", "Vercel"]];

/** v126: how a webhook's deliveries are proved, changed only here behind one password: who signs them, a new secret
 * Toolroll makes (Standard, GitHub-style; shown once, the address kept), or the sender's own pasted (Sentry, Vercel) —
 * first or as a replacement. New address is its own button and keeps the secret. */
function WebhookSigning({ trigger, view, csrf, apply, onReveal }: { trigger: BrowserFlowTrigger; view: BrowserFlowView; csrf: string; apply: (result: Said) => void; onReveal: (reveal: Reveal) => void }) {
  const hook = trigger.hook!;
  const current = hook.sender ?? "none";
  const [sender, setSender] = useState(current);
  const [secret, setSecret] = useState("");
  const [project, setProject] = useState(hook.scope?.project ?? "");
  const [team, setTeam] = useState(hook.scope?.team ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async (path: string, fields: Record<string, string>) => {
    setBusy(true);
    const result = await send(`${view.flow.href}/triggers/${trigger.id}/${path}`, { ...fields, password }, csrf);
    setBusy(false); apply(result);
    if (result.ok) { setPassword(""); setSecret(""); }
    if (result.reveal !== undefined) onReveal(result.reveal);
  };
  const changing = sender !== current;
  const words = SECRET_LABELS[current];
  const ready = stepUpReady(view, password);
  return <details className="mt-2 rounded-md border px-2 py-1.5" open={!hook.ready || hook.warning !== null} data-trigger-signing={current}>
    <summary className="cursor-pointer text-body font-medium">Signing{hook.ready && current !== "none" ? "" : " · needs you"}</summary>
    <div className="mt-2 flex flex-col gap-2">
      {hook.warning !== null && <p className={cn("text-caption font-normal", current === "none" || !hook.ready ? "text-foreground" : "text-muted-foreground")} data-trigger-signing-warning>{hook.warning}</p>}
      {hook.readerNote !== null && <p className="text-caption text-muted-foreground font-normal" data-trigger-reader-note>{hook.readerNote}</p>}
      <Field label="Signed by" hint="Who signs this webhook's deliveries. Changing it keeps the address and drops the secret: it then needs one again.">
        <select className={SELECT_INLINE} value={sender} onChange={event => setSender(event.target.value)} data-trigger-sender>
          {SENDER_CHOICES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </Field>
      {!changing && hook.scope !== null && <Field label={current === "vercel" ? "Vercel project ID" : "Sentry project"} hint={current === "vercel" ? "Only this project's deployments add cards (prj_…, from the project's Settings). Blank takes any project the secret covers." : "Only this project's issues add cards (its slug or number). Blank takes any project the integration sees."}>
        <Input value={project} onChange={event => setProject(event.target.value)} data-trigger-project />
      </Field>}
      {!changing && current === "vercel" && <Field label="Vercel team ID" hint="Only deliveries from this team (team_…). Blank takes any.">
        <Input value={team} onChange={event => setTeam(event.target.value)} data-trigger-team />
      </Field>}
      {!changing && words !== undefined && <Field label={hook.ready ? `Replace ${words.label}` : words.label} hint={words.hint}>
        <Input type="password" autoComplete="off" value={secret} onChange={event => setSecret(event.target.value)} data-trigger-secret />
      </Field>}
      <StepUp view={view} password={password} setPassword={setPassword} />
      <div className="flex flex-wrap gap-1.5">
        {changing && <Button type="button" size="sm" disabled={busy || !ready} onClick={() => void go("sender", { sender })}>Change who signs it</Button>}
        {!changing && hook.makesSecret && <Button type="button" size="sm" variant="outline" disabled={busy || !ready} onClick={() => void go("setup", {})} data-trigger-setup>{hook.ready ? "Replace secret" : "Set up"}</Button>}
        {!changing && words !== undefined && <Button type="button" size="sm" disabled={busy || !ready || secret.trim() === ""} onClick={() => void go("secret", { secret })}>{hook.ready ? "Replace secret" : "Save secret"}</Button>}
        {!changing && hook.scope !== null && (project.trim() !== (hook.scope.project ?? "") || team.trim() !== (hook.scope.team ?? "")) && <Button type="button" size="sm" variant="outline" disabled={busy || !ready} onClick={() => void go("scope", { project, team })} data-trigger-save-scope>Save project</Button>}
      </div>
    </div>
  </details>;
}

function LinearSecret({ trigger, view, csrf, apply }: { trigger: BrowserFlowTrigger; view: BrowserFlowView; csrf: string; apply: (result: Said) => void }) {
  const words = SECRET_LABELS[trigger.hook?.sender ?? trigger.kind] ?? SECRET_LABELS["linear"]!;
  const [secret, setSecret] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  return <form className="mt-2 flex flex-col gap-2 rounded-md border border-attention/50 p-2" onSubmit={async event => {
    event.preventDefault(); setBusy(true);
    const result = await send(`${view.flow.href}/triggers/${trigger.id}/secret`, { secret, password }, csrf);
    setBusy(false); apply(result); if (result.ok) { setSecret(""); setPassword(""); }
  }}>
    <Field label={words.label} hint={words.hint}><Input type="password" autoComplete="off" value={secret} onChange={event => setSecret(event.target.value)} /></Field>
    <StepUp view={view} password={password} setPassword={setPassword} credential />
    <Button type="submit" size="sm" className="self-start" disabled={busy || secret.trim() === "" || !stepUpReady(view, password)}>Save secret</Button>
  </form>;
}

/**
 * A step-up act: Toolroll's own password in a popover only when the rules ask for it (KApprove: Passwordless shows one
 * click), or, signed in with the identity provider, that sign-in, confirmed (a link to confirm it when it isn't).
 * `check` takes and validates the snapshot the act will carry before anything opens; `act` posts it with the password
 * typed (empty when none was asked) and answers a refusal to show, or null. The server proves the person again.
 */
function StepUpAct({ view, label, busyLabel, terms, text, docked, check, act }: { view: BrowserFlowView; label: string; busyLabel: string; terms: ReactNode; text?: ReactNode; docked?: boolean; check?: () => boolean; act: (password: string) => Promise<string | null> }) {
  const passwordless = useContext(Passwordless);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  if (view.stepUp !== undefined) {
    if (!stepUpReady(view, "")) return <KLinkButton variant="primary" href={view.stepUp.confirmHref} label={`Confirm with ${view.stepUp.label}`} data-sso-step-up="confirm" />;
    return <>
      <KButton variant="primary" label={label} docked={docked === true} busy={busy ? busyLabel : false} data-sso-step-up="confirmed"
        onClick={async () => { if (busy || (check !== undefined && !check())) return; setBusy(true); setRefused(null); try { setRefused(await act("")); } finally { setBusy(false); } }} />
      {refused !== null && <KNotice>{refused}</KNotice>}
    </>;
  }
  return <KApprove kind="step-up" facts={{ passwordless, remembered: false }} label={label} terms={terms} {...(text === undefined ? {} : { text })} {...(docked ? { docked: true } : {})} {...(check === undefined ? {} : { check })}
    onApprove={password => act(password ?? "")} />;
}

/** "Runs on its own", in the flow's facts line: until when (the exact time on hover) and Revoke (one click, no
 * password); or, when a change ended it early, that it no longer does and why. */
function UnattendedLine({ view, csrf, apply }: { view: BrowserFlowView; csrf: string; apply: (result: Said) => void }) {
  const [busy, setBusy] = useState(false);
  const own = view.unattended.active, ended = view.unattended.ended ?? null;
  if (own !== null) return <span className="fl-meta-item" data-flow-unattended="on">
    <span title={`Ends ${own.untilWords} · covers ${own.covers.join("; ")}`}>Runs on its own until {untilDayWords(own.until)}</span>
    {view.canEdit && <KButton variant="ghost" sm label="Revoke" busy={busy ? "Revoking…" : false} data-flow-unattended-revoke
      onClick={async () => { if (busy) return; setBusy(true); apply(await send(`${view.flow.href}/unattended-off`, {}, csrf)); setBusy(false); }} />}
  </span>;
  if (ended !== null) return <span className="fl-meta-item" data-flow-unattended-ended>No longer runs on its own: {ended.why} ({untilDayWords(ended.at)}), so steps wait for you again</span>;
  return null;
}

/** Browser use, once allowed: routine, so one quiet line in the facts, with Turn off (one click). */
function BrowserLine({ view, csrf, apply }: { view: BrowserFlowView; csrf: string; apply: (result: Said) => void }) {
  const [busy, setBusy] = useState(false);
  const browser = view.browser;
  if (browser == null || browser.status !== "allowed") return null;
  return <span className="fl-meta-item" data-flow-browser="allowed"><span>{browser.words}</span>
    {view.canEdit && <KButton variant="ghost" sm label="Turn off" busy={busy ? "Turning off…" : false} data-flow-browser-off
      onClick={async () => { if (busy) return; setBusy(true); apply(await send(`${view.flow.href}/browser-off`, {}, csrf)); setBusy(false); }} />}
  </span>;
}

/**
 * Browser use not allowed, or its approval expired: the decision frame (ink outline: the next run waits on a person), the
 * reason in one line, the scope you'd approve visible before you consent, and Allow browser as the screen's primary.
 * The terms are frozen when the frame is first read: a live update never swaps what the password approves; when the
 * flow's terms move on, it says so and the person reads the new ones first. The digest shown rides back.
 */
type BrowserNow = NonNullable<BrowserFlowView["browser"]>;
/**
 * The browser terms a person is reading, frozen when they first see them unapproved (the frame and the dock share it).
 * Each time browser use stops standing (none, ended, or allowed and then ended), the first unapproved reading is the
 * one shown and approved; anything newer only offers "Read the new terms", never a yes to terms nobody read.
 */
function useFrozenBrowser(browser: BrowserFlowView["browser"]): { frozen: BrowserNow | null; moved: boolean; reread: () => void } {
  const unapproved = browser != null && browser.status !== "allowed" ? browser : null;
  const shown = useRef<BrowserNow | null>(unapproved);
  const [, redraw] = useState(0);
  // Allowed (or gone): the next unapproved reading freezes afresh. Unapproved: the first reading stays.
  if (unapproved === null) shown.current = null;
  else if (shown.current === null) shown.current = unapproved;
  const reread = useCallback(() => { shown.current = unapproved; redraw(n => n + 1); }, [unapproved]);
  const frozen = shown.current;
  return { frozen, moved: frozen !== null && unapproved !== null && frozen.digest !== unapproved.digest, reread };
}

function BrowserFrame({ view, csrf, apply, phone, frozen, moved, reread }: { view: BrowserFlowView; csrf: string; apply: (result: Said) => void; phone: boolean; frozen: BrowserNow | null; moved: boolean; reread: () => void }) {
  const browser = view.browser;
  if (browser == null || browser.status === "allowed" || frozen === null) return null;
  const ended = browser.status === "ended";
  const zone = frozen.zones[0]?.title ?? view.stages.find(one => one.kind === "check" && one.browser === true)?.title ?? "A step";
  const why = browser.words.replace(/^Browser approval ended: /, "");
  const canAllow = view.canEdit && browser.canApprove !== false;
  const allow = canAllow && browser.problem === null && frozen.digest !== null && !moved
    ? <StepUpAct view={view} label="Allow browser" busyLabel="Allowing…" docked={phone}
        terms={`${view.flow.name} · ${frozen.zones.map(one => `${one.title} runs ${one.script} v${one.version}`).join("; ")} · digest ${frozen.digest.slice(0, 12)}`}
        act={async password => { const result = await send(`${view.flow.href}/browser`, { digest: frozen.digest!, password }, csrf); if (!result.ok) return result.said; apply(result); return null; }} />
    : null;
  return <div className="fl-browser" id="fl-browser" data-flow-browser-panel data-flow-browser={browser.status}>
    <KSlots wait status={<><KChip word="Needs you" tone="needs" /><h2>{ended ? "Browser approval expired" : `Allow browser for ${zone}?`}</h2></>}
      text={<>{ended ? `It ended because ${why}. The next run waits at ${zone} until someone allows it again.` : `${zone} starts a browser. The next run waits there until someone allows it.`}
        {frozen.zones.length > 0 && <span className="fl-zones" data-flow-browser-zones>{frozen.zones.map(one => <span key={one.zone} className="fl-zone"><b>{one.title}</b> runs <span className="k-mono">{one.script}</span> v{one.version}<span className="k-mono fl-dig">{one.digest}</span></span>)}</span>}</>}
      acts={moved
        ? <span data-flow-browser-moved><KButton label="Read the new terms" onClick={reread} /></span>
        : allow}
      terms={!canAllow ? "Only an approver with access to every project can allow browser use."
        : browser.problem !== null ? browser.problem
        : moved ? "This flow or its scripts changed while you were reading."
        : view.stepUp !== undefined ? `Asks you to confirm with ${view.stepUp.label}.` : "Allowing it is a step-up: it asks for your password unless Passwordless is on."} />
    {frozen.terms.length > 0 && <KDisclose summary="What else allowing means"><div className="fl-terms" data-flow-browser-terms>
      <ul>{["Each run of these steps starts a headless Chromium.", ...frozen.terms].map((line, index) => <li key={index}>{line}</li>)}</ul>
      <p className="k-note">Approval digest <span className="k-mono">{frozen.digest}</span></p></div></KDisclose>}
  </div>;
}

/** One validated reading of the "Run on its own" form: what a signature would cover, or why it can't yet. */
type OwnSnapshot = { days: number; budgetMicrousd: number | null; dailyRunCap: number | null; include: number[]; covered: { id: number; words: string }[]; schedulesDigest: string; revision: number };
function readOwn(view: BrowserFlowView, draft: { days: string; budget: string; runs: string; include: number[] }): { errors: { budget?: string; runs?: string }; snapshot: OwnSnapshot | null } {
  const budget = unattendedBudgetOf(draft.budget), runs = unattendedRunsOf(draft.runs);
  const errors = { ...(budget.ok ? {} : { budget: budget.message }), ...(runs.ok ? {} : { runs: runs.message }) };
  if (!budget.ok || !runs.ok) return { errors, snapshot: null };
  const days = Math.min(view.unattended.maxDays, Math.max(1, Math.round(Number(draft.days)) || 1));
  const optional = new Set(view.unattended.schedules.filter(one => one.optional !== null).map(one => one.id));
  const include = draft.include.filter(id => optional.has(id));
  const covered = view.unattended.schedules.filter(one => one.optional === null || include.includes(one.id)).map(one => ({ id: one.id, words: one.words }));
  return { errors, snapshot: { days, budgetMicrousd: budget.value, dailyRunCap: runs.value, include, covered, schedulesDigest: view.unattended.schedulesDigest, revision: view.flow.revision } };
}
const ownTerms = (view: BrowserFlowView, own: OwnSnapshot): string[] =>
  [...view.unattended.terms.head, ...(own.covered.length === 0 ? [] : [unattendedCoverWords(own.covered)]), ...unattendedLimitWords(own.budgetMicrousd, own.dailyRunCap), ...view.unattended.terms.rules, unattendedEndAfterWords(own.days)];

/**
 * Signing "Runs on its own": the fields are a draft; the terms list, the password popover's terms and the values sent
 * all come from ONE validated snapshot of them (readOwn), so what is signed is exactly what is stored. An invalid
 * field is refused next to itself before any password is asked; the terms list follows the last valid reading.
 */
function UnattendedPanel({ view, csrf, apply, onSigned }: { view: BrowserFlowView; csrf: string; apply: (result: Said) => void; onSigned: () => void }) {
  const passwordless = useContext(Passwordless);
  const [draft, setDraft] = useState({ days: "1", budget: "", runs: "", include: [] as number[] });
  const [missing, setMissing] = useState<string | null>(null);
  const [signing, setSigning] = useState<OwnSnapshot | null>(null);
  const read = readOwn(view, draft);
  const lastValid = useRef<OwnSnapshot | null>(read.snapshot);
  if (read.snapshot !== null) lastValid.current = read.snapshot;
  const shown = read.snapshot ?? lastValid.current;
  const pending = useRef<OwnSnapshot | null>(null);
  const budgetField = useRef<HTMLInputElement>(null), runsField = useRef<HTMLInputElement>(null);
  if (!view.unattended.canSign) return <div data-flow-unattended-panel><p className="k-note" data-flow-unattended-problem>{view.unattended.problem}</p></div>;
  const set = (key: "days" | "budget" | "runs") => (event: { target: { value: string } }) => { setMissing(null); setDraft(current => ({ ...current, [key]: event.target.value })); };
  const check = (): boolean => {
    const now = readOwn(view, draft);
    if (now.snapshot === null) { (now.errors.budget !== undefined ? budgetField : runsField).current?.focus(); return false; }
    if (now.snapshot.covered.length === 0) { setMissing("Pick a schedule above to sign."); return false; }
    pending.current = now.snapshot; setSigning(now.snapshot);
    return true;
  };
  const optional = view.unattended.schedules.filter(one => one.optional !== null);
  return <div className="fl-form" data-flow-unattended-panel>
    <p className="k-note">While it runs on its own, cards its schedule adds move past steps that would wait for you, within the limits you set here. It never merges or ships anything.</p>
    <KField label="Lasts">{ids => <KSelect id={ids.id} value={draft.days} onChange={set("days")} data-flow-unattended-days wide
      items={Array.from({ length: view.unattended.maxDays }, (_, index) => [String(index + 1), `${index + 1} day${index === 0 ? "" : "s"}`] as const)} />}</KField>
    <div className="fl-two">
      <KField label="Budget per attempt ($)" error={read.errors.budget ?? null}>{ids => <KInput ref={budgetField} id={ids.id} inputMode="decimal" placeholder="No cap" value={draft.budget} onChange={set("budget")} aria-invalid={ids.invalid || undefined} aria-describedby={ids.describedBy} data-flow-unattended-budget />}</KField>
      <KField label="Runs a day" error={read.errors.runs ?? null}>{ids => <KInput ref={runsField} id={ids.id} inputMode="numeric" placeholder="No limit" value={draft.runs} onChange={set("runs")} aria-invalid={ids.invalid || undefined} aria-describedby={ids.describedBy} data-flow-unattended-runs />}</KField>
    </div>
    {optional.length > 0 && <fieldset className="fl-checks" data-flow-unattended-schedules>
      <legend>Also cover</legend>
      {optional.map(one => <label key={one.id} className="fl-check">
        <input type="checkbox" checked={draft.include.includes(one.id)} onChange={event => { setMissing(null); setDraft(current => ({ ...current, include: event.target.checked ? [...current.include, one.id] : current.include.filter(id => id !== one.id) })); }} />
        <span>{one.words}<span className="k-note">{one.optional}</span></span></label>)}
    </fieldset>}
    {shown !== null && <div className="fl-signs" data-flow-unattended-terms>
      <b>{view.stepUp === undefined && !passwordless ? "Your password signs exactly this" : "Signing covers exactly this"}</b>
      <ul aria-live="polite">{ownTerms(view, shown).map((line, index) => <li key={index}>{line}</li>)}</ul>
    </div>}
    {missing !== null && <KNotice>{missing}</KNotice>}
    <KActs><StepUpAct view={view} label="Sign" busyLabel="Signing…" check={check}
      terms={signing === null ? "" : `${view.flow.name} · ${signing.days} day${signing.days === 1 ? "" : "s"} · ${unattendedLimitWords(signing.budgetMicrousd, signing.dailyRunCap).join(" ")}`}
      act={async password => {
        const own = pending.current;
        if (own === null) return "Read the terms again. Nothing was signed.";
        const result = await send(`${view.flow.href}/unattended`, { days: String(own.days), budget: own.budgetMicrousd === null ? "" : (own.budgetMicrousd / 1_000_000).toFixed(2), runs: own.dailyRunCap === null ? "" : String(own.dailyRunCap),
          include: own.include.join(","), schedules: own.schedulesDigest, password, revision: String(own.revision) }, csrf);
        if (!result.ok) return result.said;
        apply(result); onSigned(); return null;
      }} /></KActs>
  </div>;
}

function TriggersPanel({ view, csrf, apply, focus, onPress }: { view: BrowserFlowView; csrf: string; apply: (result: Said) => void; focus: number | null; onPress: (id: number) => void }) {
  const [reveal, setReveal] = useState<{ kind: string; reveal: Reveal } | null>(null);
  const [busy, setBusy] = useState(false);
  const base = `${view.flow.href}/triggers`;
  const act = async (path: string, kind: string, fields: Record<string, string> = {}) => {
    setBusy(true);
    const result = await send(path, fields, csrf);
    setBusy(false);
    apply(result);
    if (result.reveal !== undefined) setReveal({ kind, reveal: result.reveal });
    return result.ok;
  };
  const live = view.triggers.filter(one => one.state !== "removed");
  useEffect(() => { if (focus !== null) document.querySelector(`[data-trigger-row="${focus}"]`)?.scrollIntoView({ block: "nearest" }); }, [focus]);
  return <div className="flex flex-col gap-4" data-flow-triggers>
    {/* A schedule's standing order says its own approval terms beside it (one may build without asking). */}
    <p className="text-body text-muted-foreground">Triggers add cards to this flow on their own.{live.some(one => one.order !== undefined) ? "" : " The work they start still waits for your usual approvals."}</p>
    {reveal !== null && <RevealBox kind={reveal.kind} reveal={reveal.reveal} onDone={() => setReveal(null)} />}
    {live.length > 0 && <ul className="flex flex-col gap-3">{live.map(trigger => <li key={trigger.id} className={cn("rounded-lg border p-3", focus === trigger.id && "ring-2 ring-primary/50")} data-trigger-row={trigger.id}>
      <div className="flex items-start gap-2">
        <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">{TRIGGER_ICONS[trigger.kind] ?? <Zap className="size-3.5" aria-hidden="true" />}</span>
        <div className="min-w-0 flex-1">
          <p className="text-body leading-snug font-medium">{trigger.words}</p>
          <p className="text-caption text-muted-foreground font-normal">Starts in {trigger.zone}{trigger.state === "paused" ? " · Paused" : ""}{trigger.shared ? " · Shared as a form" : ""}</p>
          {trigger.status !== null && <p className={cn("text-caption font-normal", trigger.failing ? "text-foreground" : "text-muted-foreground")}>{ago(trigger.statusAt)}: {trigger.status}<StatusLink link={trigger.statusLink} /></p>}
        </div>
      </div>
      {/* Its approval is what turning it on agrees to, so it stays in view; the terms each run files open on demand. */}
      {trigger.order !== undefined && <p className="mt-2 text-caption break-words font-normal" data-trigger-approval>{trigger.order.at(-1)}</p>}
      {trigger.order !== undefined && <details className="mt-2 rounded-md border px-3 py-2" data-trigger-order>
        <summary className="cursor-pointer text-body font-medium">What each run files</summary>
        <ul className="mt-1 flex flex-col gap-1 text-caption text-muted-foreground font-normal">{trigger.order.slice(0, -1).map((line, index) => <li key={index} className="break-words">{line}</li>)}</ul>
      </details>}
      {trigger.hook?.dropped != null && <div className="mt-2 flex flex-col gap-1.5 rounded-md border border-attention/50 p-2" data-trigger-dropped>
        <p className="text-body font-medium">{trigger.hook.dropped.count === 1 ? "1 delivery was" : `${trigger.hook.dropped.count} deliveries were`} turned away since {ago(trigger.hook.dropped.since)}: too many were already waiting.</p>
        <p className="text-caption text-muted-foreground font-normal">{trigger.hook.dropped.resend}</p>
        <Button size="sm" variant="outline" className="self-start" disabled={busy} onClick={() => void act(`${base}/${trigger.id}/dropped`, trigger.kind)}>Clear</Button>
      </div>}
      {trigger.hook?.sender != null && <WebhookSigning trigger={trigger} view={view} csrf={csrf} apply={apply} onReveal={revealed => setReveal({ kind: trigger.hook?.sender ?? trigger.kind, reveal: revealed })} />}
      {trigger.hook?.sender == null && trigger.hook?.needsSecret === true && !trigger.hook.ready && <LinearSecret trigger={trigger} view={view} csrf={csrf} apply={apply} />}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {trigger.button !== null && trigger.state === "active" && <Button size="sm" onClick={() => onPress(trigger.id)}>Start</Button>}
        {trigger.button !== null && <CredentialAction view={view} busy={busy} label={trigger.shared ? "New form link" : "Share as a form"} onConfirm={password => act(`${base}/${trigger.id}/share`, "form", { password })} />}
        {trigger.shared && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(`${base}/${trigger.id}/unshare`, "form")}>Stop sharing</Button>}
        {trigger.checkable && trigger.state === "active" && <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(`${base}/${trigger.id}/check`, trigger.kind)}>{trigger.kind === "schedule" ? "Run now" : "Check now"}</Button>}
        {trigger.hook !== null && <CredentialAction view={view} busy={busy} label="New address" onConfirm={password => act(`${base}/${trigger.id}/renew`, trigger.kind, { password })} />}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(`${base}/${trigger.id}/${trigger.state === "paused" ? "resume" : "pause"}`, trigger.kind)}>{trigger.state === "paused" ? "Turn on" : "Pause"}</Button>
        <Button size="sm" variant="ghost" className="text-destructive" disabled={busy} onClick={() => void act(`${base}/${trigger.id}/remove`, trigger.kind)}>Remove</Button>
      </div>
    </li>)}</ul>}
    <AddTrigger view={view} csrf={csrf} open={live.length === 0} onResult={(result, kind) => { apply(result); if (result.reveal !== undefined) setReveal({ kind, reveal: result.reveal }); }} />
    <TriggerSettings view={view} csrf={csrf} apply={apply} />
  </div>;
}

/** Pressing a button trigger: its questions, the first answer as the card's title. */
function PressPanel({ trigger, view, csrf, apply, onDone }: { trigger: BrowserFlowTrigger; view: BrowserFlowView; csrf: string; apply: (result: Said) => void; onDone: () => void }) {
  const questions = trigger.button?.questions ?? [];
  const [answers, setAnswers] = useState<string[]>(questions.map(() => ""));
  const [busy, setBusy] = useState(false);
  const answer = (index: number) => (event: { target: { value: string } }) => setAnswers(current => current.map((one, at) => at === index ? event.target.value : one));
  return <form className="flex flex-col gap-3" data-flow-press={trigger.id} onSubmit={async event => {
    event.preventDefault(); setBusy(true);
    const result = await send(`${view.flow.href}/triggers/${trigger.id}/press`, { answers: JSON.stringify(answers) }, csrf);
    setBusy(false); apply(result); if (result.ok) onDone();
  }}>
    <p className="text-caption text-muted-foreground font-normal">The card starts in {trigger.zone}.</p>
    {questions.map((question, index) => <Field key={index} label={question}>
      {index === 0 ? <Input value={answers[index] ?? ""} onChange={answer(index)} maxLength={200} required autoFocus /> : <Textarea rows={3} value={answers[index] ?? ""} onChange={answer(index)} />}
    </Field>)}
    <KActs><KButton type="submit" variant="primary" label="Add card" busy={busy ? "Adding…" : false} disabled={(answers[0] ?? "").trim() === ""} /></KActs>
  </form>;
}

/** The project's script library: reusable steps with no AI that any of its flows can run. */
function ScriptsPanel({ view, csrf, apply }: { view: BrowserFlowView; csrf: string; apply: (result: Said) => void }) {
  const blank = { name: "", about: "", body: "", timeoutMinutes: "15", language: "python", file: "" };
  const [draft, setDraft] = useState<typeof blank | null>(view.scripts.length === 0 ? blank : null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (draft === null) return;
    setBusy(true);
    const result = await send(`${view.flow.href}/scripts`, draft, csrf);
    setBusy(false); apply(result); if (result.ok) { setDraft(null); setRunsFile(false); }
  };
  const set = (key: keyof typeof blank) => (event: { target: { value: string } }) => setDraft(current => current === null ? current : { ...current, [key]: event.target.value });
  const [runsFile, setRunsFile] = useState(false);
  return <div className="flex flex-col gap-4" data-flow-scripts>
    <p className="text-body text-muted-foreground">Reusable steps with no AI, in shell, Python or Node. A “Run a script” zone runs one with the card, and a schedule can run one to make cards. Any flow in {view.flow.project} can use them.</p>
    {view.scripts.length > 0 && <ul className="flex flex-col gap-2">{view.scripts.map(script => <li key={script.name} className="rounded-lg border p-3" data-script={script.name}>
      <div className="flex items-start gap-2">
        <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"><ListChecks className="size-3.5" aria-hidden="true" /></span>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-1.5 font-mono text-body font-semibold">{script.name}{script.held && <Badge tone="attention">Needs approval</Badge>}</p>
          <p className="text-[12.5px]">{script.about}</p>
          <p className="text-caption text-muted-foreground font-normal">{LANGUAGE_NAMES[script.language]}{script.file === null ? "" : ` · runs ${script.file}`} · version {script.version} · {script.savedBy} · up to {script.timeoutMinutes} min{script.usedHere.length > 0 ? ` · runs in ${script.usedHere.join(", ")}` : " · not used in this flow"}</p>
        </div>
      </div>
      {script.file === null && <details className="mt-2"><summary className="cursor-pointer text-caption text-muted-foreground font-normal">Show the script</summary><pre className="mt-2 max-h-56 overflow-auto rounded-md bg-muted p-2 font-mono text-mono">{script.body}</pre></details>}
      {script.held && <p className="mt-2 text-[12.5px]" data-script-held>It came with an imported flow, so it doesn't run until you approve it. Read it first.</p>}
      {view.canEdit && <div className="mt-2 flex gap-1.5">
        {script.held && <Button size="sm" disabled={busy} onClick={async () => { setBusy(true); apply(await send(`${view.flow.href}/scripts`, { approve: "yes", name: script.name, version: String(script.version), digest: script.digest }, csrf)); setBusy(false); }} data-approve-script>Approve</Button>}
        <Button size="sm" variant="outline" onClick={() => { setRunsFile(script.file !== null); setDraft({ name: script.name, about: script.about, body: script.body, timeoutMinutes: String(script.timeoutMinutes), language: script.language, file: script.file ?? "" }); }}>Edit</Button>
        <Button size="sm" variant="ghost" className="text-destructive" disabled={busy} onClick={async () => { setBusy(true); apply(await send(`${view.flow.href}/scripts`, { remove: "yes", name: script.name }, csrf)); setBusy(false); }}>Remove</Button>
      </div>}
    </li>)}</ul>}
    {view.canEdit && (draft === null
      ? <Button size="sm" variant="outline" className="self-start" onClick={() => { setRunsFile(false); setDraft(blank); }}><Plus className="size-4" />New script</Button>
      : <form className="flex flex-col gap-3 rounded-lg border p-3" onSubmit={event => { event.preventDefault(); void save(); }} data-script-form>
        <Field label="Name" hint="Lowercase and dashes, like run-tests. Saving under an existing name makes a new version."><Input value={draft.name} onChange={set("name")} maxLength={40} className="font-mono" required /></Field>
        <Field label="What it checks or does"><Input value={draft.about} onChange={set("about")} maxLength={160} placeholder="Looks the company up in our CRM" required /></Field>
        <div className="flex gap-2">
          <Field label="Language"><select className={SELECT} value={draft.language} onChange={set("language")} aria-label="Language"><option value="python">Python</option><option value="node">Node</option><option value="shell">Shell</option></select></Field>
          <Field label="Runs"><select className={SELECT} value={draft.file === "" && !runsFile ? "here" : "file"} onChange={event => { setRunsFile(event.target.value === "file"); setDraft(current => current === null ? current : { ...current, file: event.target.value === "file" ? current.file : "" }); }} aria-label="Runs">
            <option value="here">What's written here</option><option value="file">A file in the project</option></select></Field>
        </div>
        {runsFile || draft.file !== ""
          ? <Field label="File" hint="A path from the top of the project. It gets the card as JSON on stdin (and in $FLOW_INPUT); what it prints is the step's result."><Input value={draft.file} onChange={set("file")} maxLength={200} className="font-mono" placeholder="scripts/enrich.py" required /></Field>
          : <Field label="Script" hint={"It gets the card as JSON on stdin (and in $FLOW_INPUT). What it prints is the step's result; a last line “goto: <answer>” picks the next zone. Exit 0 passes."}>
            <Textarea value={draft.body} onChange={set("body")} rows={8} className="font-mono text-[12.5px]" placeholder={SCRIPT_EXAMPLES[draft.language] ?? ""} required /></Field>}
        <Field label="Stop it after (minutes)"><Input type="number" min={1} max={60} value={draft.timeoutMinutes} onChange={set("timeoutMinutes")} className="w-28" /></Field>
        <div className="flex gap-2"><Button type="submit" size="sm" disabled={busy}>Save script</Button><Button type="button" size="sm" variant="ghost" onClick={() => setDraft(null)}>Cancel</Button></div>
      </form>)}
  </div>;
}

type Insights = {
  days: number; cards: { started: number; finished: number; active: number };
  zones: { zone: string; title: string; kind: string; entered: number; movedOn: number; failed: number; sentBack: number; here: number; typicalMinutes: number | null; lastProblem: { cardTitle: string; note: string | null; at: string } | null }[];
  breaks: { zone: string; title: string; problems: number; of: number }[];
  scripts: { script: string; runs: number; passed: number; failed: number; typicalSeconds: number | null; lastFailure: string | null }[];
  sorts: { zone: string; title: string; sureAt: number; sorted: number; alone: number; notSure: number; corrected: number; bands: { from: number; to: number; right: number; of: number }[]; costUsd: number; suggestion: string | null }[];
  runs: { card: number; cardTitle: string; entry: number; zoneTitle: string; kind: string; script: string | null; version: number | null; state: string; result: string | null; exitCode: number | null; durationMs: number | null; at: string; hasLog: boolean }[];
  recurring?: { problem: string; title: string; days: number; lastSeen: string; card: number | null }[];
};
const duration = (minutes: number | null) => minutes === null ? "—" : minutes < 1 ? "under a minute" : minutes < 90 ? `${Math.round(minutes)} min` : minutes < 2880 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / 1440)} days`;

/** How work moves through this flow and where it breaks, and every script and update run with its log. */
function InsightsPanel({ view }: { view: BrowserFlowView }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Insights | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [log, setLog] = useState<{ key: string; text: string } | null>(null);
  useEffect(() => {
    let live = true;
    setData(null); setProblem(null);
    fetch(`${view.flow.href}/insights?days=${days}`, { credentials: "same-origin", headers: { accept: "application/json" } })
      .then(async response => { if (!live) return; if (!response.ok) throw new Error("load"); setData(await response.json() as Insights); })
      .catch(() => { if (live) setProblem("The insights couldn't load. Try again."); });
    return () => { live = false; };
  }, [days, view.flow.href, view.flow.revision]);
  const openLog = async (card: number, entry: number) => {
    const key = `${card}:${entry}`;
    if (log?.key === key) { setLog(null); return; }
    try {
      const response = await fetch(`${view.flow.href}/runs/${card}/${entry}`, { credentials: "same-origin", headers: { accept: "application/json" } });
      const body = await response.json() as { log?: string };
      setLog({ key, text: body.log === undefined || body.log === "" ? "This run left no output." : body.log });
    } catch { setLog({ key, text: "The log couldn't load." }); }
  };
  return <div className="flex flex-col gap-4" data-flow-insights>
    <div className="fl-secthead"><h3>How it went</h3>
      <KSelect sm value={String(days)} onChange={event => setDays(Number(event.target.value))} aria-label="Period" items={[["7", "Last 7 days"], ["30", "Last 30 days"], ["90", "Last 90 days"]]} /></div>
    {problem !== null && <p className="text-body text-destructive">{problem}</p>}
    {data === null && problem === null && <p className="text-body text-muted-foreground">Loading…</p>}
    {data !== null && <>
      <p className="text-body">{data.cards.started} card{data.cards.started === 1 ? "" : "s"} started, {data.cards.finished} finished, {data.cards.active} in progress.</p>
      <section className="flex flex-col gap-2">
        <h3 className="text-body font-semibold">Where it breaks</h3>
        {data.breaks.length === 0 ? <p className="text-[12.5px] text-muted-foreground">Nothing failed or was sent back in this period.</p>
          : <ul className="flex flex-col gap-2">{data.breaks.map(one => { const zone = data.zones.find(z => z.zone === one.zone); return <li key={one.zone} className="rounded-lg border border-border p-2.5 text-body">
            <p><span className="font-semibold">{one.title}</span>: {one.problems} of {one.of} card{one.of === 1 ? "" : "s"} failed or were sent back</p>
            {zone?.lastProblem && <p className="mt-0.5 text-caption text-muted-foreground font-normal">Latest: {zone.lastProblem.cardTitle}{zone.lastProblem.note === null ? "" : ` — ${zone.lastProblem.note.split("\n")[0]}`}</p>}
          </li>; })}</ul>}
      </section>
      <section className="flex flex-col gap-1.5">
        <h3 className="text-body font-semibold">Zones</h3>
        <table className="w-full text-left text-caption font-normal"><thead className="text-muted-foreground"><tr><th className="py-1 font-medium">Zone</th><th className="font-medium">In</th><th className="font-medium">On</th><th className="font-medium">Failed</th><th className="font-medium">Back</th><th className="font-medium">Typical stay</th></tr></thead>
          <tbody>{data.zones.map(zone => <tr key={zone.zone} className="border-t">
            <td className="py-1.5 pr-2 font-medium">{zone.title}{zone.here > 0 ? <span className="text-muted-foreground"> · {zone.here} here</span> : null}</td>
            <td>{zone.entered}</td><td>{zone.movedOn}</td><td className={zone.failed > 0 ? "font-semibold text-destructive" : ""}>{zone.failed}</td><td className={zone.sentBack > 0 ? "font-semibold text-foreground" : ""}>{zone.sentBack}</td><td>{duration(zone.typicalMinutes)}</td>
          </tr>)}</tbody></table>
      </section>
      {data.scripts.length > 0 && <section className="flex flex-col gap-1.5">
        <h3 className="text-body font-semibold">Scripts</h3>
        <ul className="flex flex-col gap-1 text-[12.5px]">{data.scripts.map(one => <li key={one.script}><span className="font-mono font-semibold">{one.script}</span>: {one.passed} of {one.runs} passed{one.typicalSeconds === null ? "" : `, usually ${one.typicalSeconds < 90 ? `${one.typicalSeconds} s` : `${Math.round(one.typicalSeconds / 60)} min`}`}</li>)}</ul>
      </section>}
      {data.sorts.length > 0 && <section className="flex flex-col gap-2" data-insights-sorts>
        <h3 className="text-body font-semibold">Sorting</h3>
        {data.sorts.map(one => <div key={one.zone} className="rounded-lg border p-2.5 text-[12.5px]" data-insights-sort={one.zone}>
          <p><span className="font-semibold">{one.title}</span>: {one.sorted} sorted · {one.alone} on its own · {one.notSure} for a person{one.corrected > 0 && <> · <span className="font-semibold text-attention">{one.corrected} moved elsewhere by people</span></>}</p>
          {one.bands.some(band => band.of > 0) && <p className="mt-1 text-muted-foreground">Right when {one.bands.filter(band => band.of > 0).map(band => `${band.from}–${band.to}% sure: ${band.right} of ${band.of}`).join(" · ")}</p>}
          {one.suggestion !== null && <p className="mt-1">{one.suggestion}</p>}
          {one.costUsd > 0 && <p className="mt-1 text-muted-foreground">Cost: {one.costUsd < 0.01 ? "under 1¢" : `$${one.costUsd.toFixed(2)}`}</p>}
        </div>)}
      </section>}
      {(data.recurring ?? []).length > 0 && <section className="flex flex-col gap-1.5" data-insights-recurring>
        <h3 className="text-body font-semibold">What keeps coming back</h3>
        <ul className="flex flex-col gap-1 text-[12.5px]">{data.recurring!.map(one => <li key={one.problem} className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate">{one.card === null ? one.title : <a className="underline-offset-2 hover:underline" href={`${view.flow.href}?card=${one.card}`}>{one.title}</a>}</span>
          <span className={cn("shrink-0 tabular-nums", one.days > 1 ? "font-semibold text-foreground" : "text-muted-foreground")}>{one.days} day{one.days === 1 ? "" : "s"}</span></li>)}</ul>
      </section>}
      <section className="flex flex-col gap-1.5">
        <h3 className="text-body font-semibold">Recent runs</h3>
        {data.runs.length === 0 ? <p className="text-[12.5px] text-muted-foreground">No scripts, sorts or updates have run in this period.</p>
          : <ul className="flex flex-col gap-1.5">{data.runs.map(run => { const key = `${run.card}:${run.entry}`; return <li key={key} className="rounded-md border px-2.5 py-2 text-[12.5px]" data-run={key}>
            <button type="button" className="flex w-full items-start gap-2 text-left" onClick={() => void openLog(run.card, run.entry)} aria-expanded={log?.key === key}>
              <span className={cn("mt-1 size-2 shrink-0 rounded-full", run.state === "passed" ? "bg-success" : run.state === "failed" ? "bg-destructive" : "bg-info")} aria-hidden="true" />
              <span className="min-w-0 flex-1"><span className="font-medium">{run.script ?? run.zoneTitle}</span> · {run.cardTitle}<span className="block text-caption text-muted-foreground font-normal">{run.kind === "sort" && run.state === "passed" && run.result !== null ? run.result.split(". ")[0]!.replace(/\.$/, "") : run.state === "passed" ? "Passed" : run.state === "failed" ? "Failed" : run.state === "waiting" ? "Trying again" : "Running"}{run.durationMs === null ? "" : run.kind === "sort" ? ` · ${run.durationMs < 1000 ? `${run.durationMs} ms` : `${(run.durationMs / 1000).toFixed(1)} s`}` : ` in ${Math.max(1, Math.round(run.durationMs / 1000))} s`} · {when(run.at)}</span></span>
            </button>
            {log?.key === key && <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 font-mono text-[11.5px]" data-run-log>{log.text}</pre>}
          </li>; })}</ul>}
      </section>
    </>}
  </div>;
}

const PHONE_QUERY = "(max-width: 760px)";
/** The console's one breakpoint (src/design/KIT.md): a phone gets the list, a one-column canvas and the dock. */
function usePhone(): boolean {
  const [phone, setPhone] = useState(() => typeof window !== "undefined" && window.matchMedia(PHONE_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(PHONE_QUERY);
    const change = () => setPhone(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  return phone;
}

type Draft = { name: string; start: string; stages: BrowserFlowStage[]; owner: string };
const ZOOM = { min: 0.4, max: 2.5 } as const;
const PHONE_ZONE_WIDTH = 300;

/** A phone's canvas: one column in the order work meets the zones, each as tall as its cards (a narrow screen can't
 * hold zones side by side at a readable size). Arrows follow from the positions: next runs down, a send-back loops
 * up the left side. */
function columnOf(stages: BrowserFlowStage[], start: string, cardsIn: (id: string) => number): BrowserFlowStage[] {
  let y = 0;
  return flowOrder(stages, start).map(stage => {
    const h = Math.min(360, 64 + Math.max(1, cardsIn(stage.id)) * 64);
    const placed = { ...stage, zone: { ...stage.zone, x: 0, y, w: PHONE_ZONE_WIDTH, h } };
    y += h + 64;
    return placed;
  });
}

/** − / % / + / Fit (and Expand on a phone): the canvas's zoom bar. Keys when the canvas has focus: + − 0 and arrows. */
function ZoomBar({ onExpand }: { onExpand?: (from: HTMLElement) => void }) {
  const flow = useReactFlow();
  const { zoom } = useViewport();
  return <div className="fl-zoom nodrag nopan" role="toolbar" aria-label="Zoom">
    <KButton variant="outline" sm iconOnly="minus" label="Zoom out (−)" onClick={() => void flow.zoomOut({ duration: 160 })} disabled={zoom <= ZOOM.min + 0.001} />
    <span className="fl-zoom-n k-num" aria-live="polite">{Math.round(zoom * 100)}%</span>
    <KButton variant="outline" sm iconOnly="plus" label="Zoom in (+)" onClick={() => void flow.zoomIn({ duration: 160 })} disabled={zoom >= ZOOM.max - 0.001} />
    <KButton variant="outline" sm lead="fit" label="Fit" title="Fit (0)" onClick={() => void flow.fitView({ padding: 0.12, maxZoom: 1, duration: 160 })} />
    {onExpand !== undefined && <KButton variant="outline" sm label="Expand" aria-label="Expand the canvas to the full screen" data-flow-expand onClick={event => onExpand(event.currentTarget)} />}
  </div>;
}

type CanvasProps = {
  view: BrowserFlowView; stages: BrowserFlowStage[]; start: string; owner: string; editing: boolean; vertical: boolean; expanded: boolean;
  mineOnly: boolean; selectedCard: number | null; lookers: Record<number, string[]>;
  onCard: (id: number, from: HTMLElement | null) => void; onDrop: (card: number, stage: string) => void;
  onTriggers: (id: number, from: HTMLElement | null) => void; onPress: (id: number, from: HTMLElement | null) => void;
  onZone: (id: string | null) => void; setDraft: (change: (current: Draft | null) => Draft | null) => void;
  onExpand?: (from: HTMLElement) => void; onCollapse?: () => void; name: string;
  /** A drawer is open over the page (a card, triggers…): the expanded canvas steps back under it until it closes. */
  covered?: boolean;
};

/**
 * The flow as a surface you move: drag to pan (a tap still opens a card), pinch, ctrl or ⌘ + wheel or a trackpad pinch
 * to zoom (0.4× to 2.5×), the zoom bar's − / + / Fit, and + − 0 and the arrows when it has focus. Up and down on a wheel
 * still scroll the page. At a desk it starts fitted, never above 100%; a phone's starts at 100% with the first zone in
 * view, and Expand gives it the whole screen (Done, or Escape, comes back).
 */
function FlowCanvas(props: CanvasProps) {
  const { view, editing, vertical, expanded } = props;
  const flow = useReactFlow();
  const box = useRef<HTMLDivElement>(null);
  const cardsIn = useCallback((id: string) => view.cards.filter(card => card.stage === id && card.state === "active" && (!props.mineOnly || card.mine)).length, [view.cards, props.mineOnly]);
  const stages = useMemo(() => vertical ? columnOf(props.stages, props.start, cardsIn) : props.stages, [vertical, props.stages, props.start, cardsIn]);
  const start = props.start;
  const updateStage = (id: string, change: Partial<BrowserFlowStage>) =>
    props.setDraft(current => current === null ? current : { ...current, stages: current.stages.map(one => one.id === id ? { ...one, ...change } : one) });

  const zoneNodes: Node<ZoneData, "zone">[] = useMemo(() => stages.map(stage => ({
    id: stage.id, type: "zone" as const, position: { x: stage.zone.x, y: stage.zone.y }, width: stage.zone.w, height: stage.zone.h,
    style: { width: stage.zone.w, height: stage.zone.h }, draggable: editing, selectable: editing,
    data: {
      stage, kindLabel: view.kinds.find(one => one.kind === stage.kind)?.label ?? stage.kind, owner: props.owner,
      subagent: stage.subagent === undefined ? null : view.subagents?.find(one => one.handle === stage.subagent)?.name ?? stage.subagent,
      cards: view.cards.filter(card => card.stage === stage.id && card.state === "active" && (!props.mineOnly || card.mine)),
      hidden: props.mineOnly ? view.cards.filter(card => card.stage === stage.id && card.state === "active" && !card.mine).length : 0, lookers: props.lookers,
      editing, canMove: view.canEdit && !vertical, start: stage.id === start, selectedCard: props.selectedCard,
      onCard: props.onCard, onDrop: props.onDrop,
      onResize: (id: string, next: { x: number; y: number; width: number; height: number }) => props.setDraft(current => current === null ? current : { ...current, stages: current.stages.map(one => one.id === id
        ? { ...one, zone: { ...one.zone, x: Math.round(next.x), y: Math.round(next.y), w: Math.round(next.width), h: Math.round(next.height) } } : one) }),
      browserLine: stage.kind === "check" && stage.browser === true && view.browser != null && view.browser.status !== "allowed" ? "Starts a browser · not allowed" : null,
    },
  })), [stages, view, editing, start, props.mineOnly, props.lookers, props.selectedCard, props.owner, props.onCard, props.onDrop, props.setDraft, vertical]);
  // Triggers sit to the left of the zone they start cards in (a desk's canvas; a phone's lists them under Triggers).
  const liveTriggers = useMemo(() => view.triggers.filter(one => one.state !== "removed"), [view.triggers]);
  const triggerNodes: Node<TriggerData, "trigger">[] = useMemo(() => {
    if (vertical) return [];
    const byZone = new Map<string, BrowserFlowTrigger[]>();
    for (const trigger of liveTriggers) {
      const zone = stages.some(one => one.id === trigger.zoneId) ? trigger.zoneId : start;
      byZone.set(zone, [...byZone.get(zone) ?? [], trigger]);
    }
    return [...byZone].flatMap(([zoneId, triggers]) => {
      const zone = stages.find(one => one.id === zoneId);
      if (zone === undefined) return [];
      const height = TRIGGER_HEAD + triggers.length * TRIGGER_ROW;
      return [{ id: `trigger-${zoneId}`, type: "trigger" as const, position: { x: zone.zone.x - 272, y: zone.zone.y + Math.max(0, (zone.zone.h - height) / 2) }, width: 236, height, style: { width: 236, height },
        draggable: false, selectable: false, data: { triggers, onOpen: props.onTriggers, onPress: props.onPress } }];
    });
  }, [liveTriggers, stages, start, vertical, props.onTriggers, props.onPress]);
  const computed: FlowNode[] = useMemo(() => [...zoneNodes, ...triggerNodes], [zoneNodes, triggerNodes]);
  // React Flow keeps its own node state (measurements, selection, a drag in progress); ours changes only when a drag
  // or resize ends, so the two never chase each other.
  const [nodes, setNodes] = useState<FlowNode[]>(computed);
  useEffect(() => {
    setNodes(previous => computed.map(node => {
      const old = previous.find(one => one.id === node.id);
      return old === undefined ? node : { ...old, ...node, ...(old.measured === undefined ? {} : { measured: old.measured }), selected: editing && old.selected === true };
    }));
  }, [computed, editing]);

  const edges: Edge[] = useMemo(() => {
    const center = (stage: BrowserFlowStage) => ({ x: stage.zone.x + stage.zone.w / 2, y: stage.zone.y + stage.zone.h / 2 });
    // The side of each zone that faces the other: arrows leave and arrive where it's shortest.
    const sides = (from: BrowserFlowStage, to: BrowserFlowStage, sendBack: boolean): { source: string; target: string } => {
      const a = center(from), b = center(to), dx = b.x - a.x, dy = b.y - a.y;
      const horizontal = Math.abs(dx) >= Math.abs(dy);
      if (sendBack) {
        // Back to a zone on another row and column: through the gap between them, not around (and across) the zones between.
        const apartX = to.zone.x >= from.zone.x + from.zone.w || from.zone.x >= to.zone.x + to.zone.w;
        const apartY = to.zone.y >= from.zone.y + from.zone.h || from.zone.y >= to.zone.y + to.zone.h;
        if (apartX && apartY) return dx >= 0 ? { source: "s-Right", target: "t-Left" } : { source: "s-Left", target: "t-Right" };
        return horizontal ? { source: "s-Bottom", target: "t-Bottom" } : { source: "s-Left", target: "t-Left" };
      }
      if (horizontal) return dx >= 0 ? { source: "s-Right", target: "t-Left" } : { source: "s-Left", target: "t-Right" };
      return dy >= 0 ? { source: "s-Bottom", target: "t-Top" } : { source: "s-Top", target: "t-Bottom" };
    };
    const label = { labelStyle: { fontSize: 11, fontWeight: 600, fill: "var(--so-ink)" }, labelBgStyle: { fill: "var(--so-paper)" } };
    const quiet = { labelStyle: { fontSize: 11, fill: "var(--so-muted)" }, labelBgStyle: { fill: "var(--so-paper)" } };
    const fromTriggers: Edge[] = triggerNodes.map(node => ({ id: `${node.id}->zone`, source: node.id, sourceHandle: "out", target: node.id.slice("trigger-".length), targetHandle: "t-Left",
      type: "smoothstep", deletable: false, markerEnd: { type: MarkerType.ArrowClosed }, style: { strokeWidth: 1.5 } }));
    return spreadLabels([...fromTriggers, ...stages.flatMap(stage => {
      const next = stage.next === null ? undefined : stages.find(one => one.id === stage.next);
      const fail = stage.onFail === null ? undefined : stages.find(one => one.id === stage.onFail);
      const limitTo = stage.limit?.to == null ? undefined : stages.find(one => one.id === stage.limit!.to);
      // A sort zone (or a script zone's answers, v90): one arrow to each zone its answers lead to, named by those answers.
      const picks = stage.kind === "sort" && stage.sort !== null ? stage.sort.answers : stage.kind === "check" || stage.kind === "subagent" ? stage.routes ?? []
        : stage.kind === "choose" ? (stage.options ?? []).filter(one => one.to !== "end").map(one => ({ answer: one.label, to: one.to })) : [];
      const answers = picks.length > 0 ? [...new Set(picks.map(one => one.to))].flatMap(to => {
        const target = stages.find(one => one.id === to);
        if (target === undefined) return [];
        const handles = target.zone.x > stage.zone.x + stage.zone.w ? { source: "s-Right", target: "t-Left" } : sides(stage, target, false);
        return [{ id: `${stage.id}->answer-${to}`, source: stage.id, target: to, sourceHandle: handles.source, targetHandle: handles.target,
          type: "smoothstep", label: picks.filter(one => one.to === to).map(one => one.answer).join(", "), ...label, markerEnd: { type: MarkerType.ArrowClosed }, style: { strokeWidth: 2 }, deletable: false }];
      }) : [];
      return [
        ...answers,
        ...(next === undefined ? [] : [{ id: `${stage.id}->next`, source: stage.id, target: next.id, sourceHandle: sides(stage, next, false).source, targetHandle: sides(stage, next, false).target,
          type: "smoothstep", markerEnd: { type: MarkerType.ArrowClosed }, style: { strokeWidth: 2 }, deletable: editing,
          ...(stage.kind === "wait" && stage.wait?.for === "reply" ? { label: "replied", ...label } : {}) }]),
        // Outside editing, a failure that lands where one of its answers already goes is that arrow, not a second one crossing the canvas.
        ...(fail === undefined || (!editing && answers.some(one => one.target === fail.id)) ? [] : [{ id: `${stage.id}->fail`, source: stage.id, target: fail.id, sourceHandle: sides(stage, fail, true).source, targetHandle: sides(stage, fail, true).target,
          type: "smoothstep", pathOptions: { offset: 28, borderRadius: 10 }, label: stage.kind === "approval" ? "sent back" : stage.kind === "sort" ? "not sure" : stage.kind === "wait" ? "no reply" : stage.kind === "choose" ? "reply" : "fails", ...quiet,
          markerEnd: { type: MarkerType.ArrowClosed, color: "var(--so-muted)" }, style: { strokeWidth: 1.5, strokeDasharray: "6 4", stroke: "var(--so-muted)" }, deletable: editing }]),
        // A time limit that moves the card on (v91): a dashed arrow named by the time.
        ...(limitTo === undefined || stage.limit === undefined ? [] : [{ id: `${stage.id}->limit`, source: stage.id, target: limitTo.id, sourceHandle: sides(stage, limitTo, true).source, targetHandle: sides(stage, limitTo, true).target,
          type: "smoothstep", pathOptions: { offset: 36, borderRadius: 10 }, label: `after ${minutesWords(stage.limit.minutes)}`, ...quiet,
          markerEnd: { type: MarkerType.ArrowClosed, color: "var(--so-muted)" }, style: { strokeWidth: 1.5, strokeDasharray: "2 4", stroke: "var(--so-muted)" }, deletable: editing }]),
      ];
    })], stages);
  }, [stages, editing, triggerNodes]);

  const onNodesChange = (changes: NodeChange<FlowNode>[]) => {
    setNodes(current => applyNodeChanges(changes, current));
    if (!editing) return;
    for (const change of changes) if (change.type === "select" && change.selected && !change.id.startsWith("trigger-")) props.onZone(change.id);
  };
  const onNodeDragStop = (_event: unknown, node: FlowNode) => {
    if (!editing || node.type !== "zone") return;
    props.setDraft(current => current === null ? current : { ...current, stages: current.stages.map(one => one.id === node.id
      ? { ...one, zone: { ...one.zone, x: Math.round(node.position.x), y: Math.round(node.position.y) } } : one) });
  };
  const onConnect = (connection: Connection) => {
    if (!editing || connection.source === connection.target) return;
    const from = stages.find(one => one.id === connection.source);
    if (from?.kind === "sort" && from.sort !== null && connection.sourceHandle !== "fail") {
      // From a sort zone, a new arrow is a new answer, named after where it goes until it's renamed.
      const target = stages.find(one => one.id === connection.target);
      if (target !== undefined && from.sort.answers.length < 12) updateStage(from.id, { sort: { ...from.sort, answers: [...from.sort.answers, { answer: target.title.slice(0, 40), means: target.title, to: target.id }] } });
      props.onZone(from.id);
      return;
    }
    if (from?.kind === "choose" && connection.sourceHandle !== "fail") {
      // From a "Person chooses" zone, a new arrow is a new button, named after where it goes until it's renamed.
      const target = stages.find(one => one.id === connection.target);
      if (target !== undefined && (from.options ?? []).length < 4) updateStage(from.id, { options: [...from.options ?? [], { label: target.title.slice(0, 40), to: target.id }] });
      props.onZone(from.id);
      return;
    }
    updateStage(connection.source, connection.sourceHandle === "fail" ? { onFail: connection.target } : { next: connection.target });
  };

  // Where it starts: a desk fits the drawing (never above 100%); a phone shows the first zone at 100%, and expanding
  // keeps where you were (Fit is one tap away).
  const placed = useRef<string | null>(null);
  const placing = vertical ? "v" : "d";
  useEffect(() => {
    if (placed.current === placing) return;
    placed.current = placing;
    const frame = requestAnimationFrame(() => {
      if (!vertical) { void flow.fitView({ padding: 0.12, maxZoom: 1 }); return; }
      const width = box.current?.querySelector(".fl-vp")?.clientWidth ?? 360;
      void flow.setViewport({ x: Math.max(8, (width - PHONE_ZONE_WIDTH) / 2), y: 16, zoom: 1 });
    });
    return () => cancelAnimationFrame(frame);
  }, [placing, vertical, flow]);
  // Expanded, the canvas is the kit's modal surface (openOverlay): the page behind is inert, Tab stays inside, Escape
  // from anywhere in it comes back, and Done takes focus. Coming back puts focus on Expand again (the page does that).
  const collapseRef = useRef(props.onCollapse);
  collapseRef.current = props.onCollapse;
  // A drawer opened from it (a card) takes over the modal; when that drawer closes the canvas is the modal surface again,
  // with focus where the drawer left it (the card that opened it).
  const covered = props.covered === true;
  const registered = useRef(false);
  useLayoutEffect(() => {
    const node = box.current;
    if (!expanded || covered || node === null) return;
    let settled = false;
    const restore = () => { node.hidden = false; node.removeAttribute("role"); node.removeAttribute("aria-modal"); node.removeAttribute("tabindex"); };
    const before = document.activeElement;
    const close = openOverlay(node, null, { dim: false, onClose: how => {
      settled = true; restore();
      // Escape, the scrim, or the surface removed: come back. Replaced by another overlay ("close" from the kit): the
      // covered prop takes it from here, and re-registers it when that one closes.
      if (how !== "close") collapseRef.current?.();
    } });
    node.setAttribute("aria-label", `${props.name}, full screen`);
    if (registered.current && before instanceof HTMLElement && node.contains(before)) before.focus({ preventScroll: true });
    else node.querySelector<HTMLElement>("[data-flow-collapse]")?.focus();
    registered.current = true;
    return () => { if (!settled) close(); restore(); node.removeAttribute("aria-label"); };
  }, [expanded, covered, props.name]);
  useEffect(() => { if (!expanded) registered.current = false; }, [expanded]);
  // Expanding or coming back changes the canvas's width: keep the zoom and the height you were at, centred again.
  const wasExpanded = useRef(expanded);
  useEffect(() => {
    if (!vertical || wasExpanded.current === expanded) return;
    wasExpanded.current = expanded;
    const timer = window.setTimeout(() => {
      const { y, zoom } = flow.getViewport();
      const width = box.current?.querySelector(".fl-vp")?.clientWidth ?? 360;
      void flow.setViewport({ x: Math.max(8, (width - PHONE_ZONE_WIDTH * zoom) / 2), y, zoom });
    }, 60);
    return () => window.clearTimeout(timer);
  }, [expanded, vertical, flow]);
  // New or removed triggers change what a desk's canvas holds: fit it again so nothing sits off the edge.
  const triggerKey = vertical ? "" : liveTriggers.map(one => `${one.id}:${one.zoneId}`).join(",");
  const fitted = useRef(triggerKey);
  useEffect(() => {
    if (fitted.current === triggerKey) return;
    fitted.current = triggerKey;
    const frame = requestAnimationFrame(() => { void flow.fitView({ padding: 0.12, maxZoom: 1, duration: 160 }); });
    return () => cancelAnimationFrame(frame);
  }, [triggerKey, flow]);

  const keys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const step = 48;
    const { x, y, zoom } = flow.getViewport();
    if (event.key === "+" || event.key === "=") void flow.zoomIn({ duration: 160 });
    else if (event.key === "-" || event.key === "_") void flow.zoomOut({ duration: 160 });
    else if (event.key === "0") void flow.fitView({ padding: 0.12, maxZoom: 1, duration: 160 });
    else if (event.key.startsWith("Arrow")) void flow.setViewport({ x: x + (event.key === "ArrowLeft" ? step : event.key === "ArrowRight" ? -step : 0), y: y + (event.key === "ArrowUp" ? step : event.key === "ArrowDown" ? -step : 0), zoom });
    else return;
    event.preventDefault();
  };

  return <div ref={box} className={cn("fl-canvas", vertical && "column", expanded && "expanded", expanded && covered && "covered", editing && "editing")} data-flow-canvas>
    {expanded && <div className="fl-xbar"><b>{props.name}</b><span className="k-note">Drag to move · pinch to zoom</span><span className="k-grow" />
      <KButton variant="primary" label="Done" data-flow-collapse onClick={() => props.onCollapse?.()} /></div>}
    <div className="fl-vp" tabIndex={0} role="group" aria-roledescription="canvas" onKeyDown={keys}
      aria-label={`${props.name}: its zones and cards. Drag to move, pinch or press + and − to zoom, 0 to fit.`}>
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES} onNodesChange={onNodesChange} onNodeDragStop={onNodeDragStop} onConnect={onConnect}
        onEdgesDelete={deleted => { for (const edge of deleted) updateStage(edge.source, edge.id.endsWith("->fail") ? { onFail: null } : edge.id.endsWith("->limit") ? { limit: { ...(stages.find(one => one.id === edge.source)?.limit ?? { minutes: 1440 }), to: null } } : { next: null }); }}
        onPaneClick={() => { if (editing) props.onZone(null); }}
        // A node with a click handler keeps its pointer events outside edit mode: cards are clicked and dragged.
        onNodeClick={() => undefined}
        nodesDraggable={editing} nodesConnectable={editing} elementsSelectable={editing} minZoom={ZOOM.min} maxZoom={ZOOM.max}
        zoomOnScroll={false} zoomActivationKeyCode={["Meta", "Control"]} zoomOnPinch zoomOnDoubleClick={!editing} panOnDrag preventScrolling={false}
        proOptions={{ hideAttribution: true }} deleteKeyCode={editing ? ["Backspace", "Delete"] : null}>
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--so-line)" />
      </ReactFlow>
      <ZoomBar {...(vertical && !expanded && props.onExpand !== undefined ? { onExpand: props.onExpand } : {})} />
    </div>
    {editing && <p className="fl-hint k-note">Drag zones to arrange them. Drag from a zone's right dot to say where work goes next, from its bottom dot for where it goes if sent back.</p>}
  </div>;
}

/** Where a card stands, as one of the kit's words: waiting on you, running, waiting on someone else, or ended. */
function cardChip(card: BrowserFlowCard): ReactNode {
  if (card.state === "done") return <KStatus status="finished" />;
  if (card.state === "cancelled") return <KChip word={card.waiting === "Ignored" ? "Ignored" : "Cancelled"} dot={false} />;
  if (card.canDecide || card.question?.mine === true || card.choose?.mine === true) return <KChip word="Needs you" tone="needs" />;
  return card.waiting !== null ? <KChip word="Waiting" dot={false} /> : <KStatus status="running" />;
}
const waitsOnMe = (card: BrowserFlowCard) => card.state === "active" && (card.canDecide || card.question?.mine === true || card.choose?.mine === true);

/** A press-steady primary: its label and act never change under a press. When what the primary should be changes (a
 * card starts waiting on you, live), the old one holds for `settleMs` before the new one takes its place, and the change
 * is said politely (aria-live) instead of swapped under the finger. The act is taken when the press starts
 * (pointerdown) and that act runs on its click, whatever the button says by then. A keyboard press (click with detail
 * 0) runs what is shown. */
export const PRIMARY_SETTLE_MS = 600;
type Primary = { label: string; busy?: string | false; act: (from: HTMLElement) => void; data?: Record<string, string> };
const primaryKey = (one: Primary | null): string => one === null ? "" : `${one.label}\u0000${JSON.stringify(one.data ?? {})}`;
function useSteadyPrimary(next: Primary | null, settleMs = PRIMARY_SETTLE_MS) {
  const key = primaryKey(next);
  const [shownKey, setShownKey] = useState(key);
  const held = useRef<Primary | null>(next);
  // Where no primary showed (editing just ended), nothing can be pressed by mistake: the new one shows at once.
  const settled = key === shownKey || shownKey === "";
  if (settled) held.current = next;
  useEffect(() => {
    if (key === shownKey) return;
    const timer = setTimeout(() => setShownKey(key), shownKey === "" ? 0 : settleMs);
    return () => clearTimeout(timer);
  }, [key, shownKey, settleMs]);
  const shown = settled ? next : held.current;
  const pressed = useRef<Primary | null>(null);
  const onPointerDown = () => { pressed.current = shown; };
  const run = (event: { detail: number; currentTarget: HTMLElement }) => {
    const chosen = event.detail > 0 && pressed.current !== null ? pressed.current : shown;
    pressed.current = null;
    chosen?.act(event.currentTarget);
  };
  /** What changed, said once politely while the old primary holds and after: never a swap under the finger. */
  const said = settled || next === null ? "" : `${next.label} is next.`;
  return { shown, onPointerDown, run, said };
}

type Overlay = { card: number } | { triggers: number | null } | { press: number } | { scripts: true } | { unattended: true } | { newCard: true };

/** An act's outcome, in place: a refusal says what didn't change; a success is one quiet line. No toasts. */
function Outcome({ outcome }: { outcome: { ok: boolean; said: string } | null }) {
  if (outcome === null) return null;
  return outcome.ok ? <p className="k-note fl-outcome" role="status" data-flow-outcome>{outcome.said}</p> : <KNotice>{outcome.said}</KNotice>;
}

/**
 * One flow's page: what it's doing in one line, the browser decision when it waits on one, the canvas (a list on a
 * phone, with the canvas a tap away) with its recent cards beneath, and the runs with how they went. Triggers, scripts,
 * a card, a new card and "Run on its own" open in drawers; editing the drawing keeps its panel beside the canvas.
 */
export function FlowView({ view: initial, csrf }: { view: BrowserFlowView; csrf: string }) {
  const phone = usePhone();
  const [view, setView] = useState(initial);
  const [outcome, setOutcome] = useState<{ ok: boolean; said: string } | null>(null);
  const apply = useCallback((result: Said) => {
    setOutcome({ ok: result.ok, said: result.said });
    if (result.view !== undefined) setView(result.view);
  }, []);
  const [overlay, setOverlayState] = useState<{ open: Overlay; from: HTMLElement | null } | null>(() =>
    initial.selectedCard !== null ? { open: { card: initial.selectedCard }, from: null }
      : initial.startTrigger !== null && initial.triggers.some(one => one.id === initial.startTrigger && one.button !== null) ? { open: { press: initial.startTrigger }, from: null } : null);
  const open = useCallback((next: Overlay, from: HTMLElement | null) => { setOutcome(null); setOverlayState({ open: next, from }); }, []);
  const close = useCallback(() => setOverlayState(null), []);
  const [tab, setTab] = useState<"steps" | "runs">("steps");
  const [layout, setLayout] = useState<"list" | "canvas">("list");
  const [expanded, setExpanded] = useState(false);
  const expandFrom = useRef<HTMLElement | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [zone, setZone] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [mineOnly, setMineOnly] = useState(() => { try { return window.localStorage.getItem("so-flows-mine") === "1"; } catch { return false; } });
  useEffect(() => { try { window.localStorage.setItem("so-flows-mine", mineOnly ? "1" : "0"); } catch { /* a private window keeps it for this visit */ } }, [mineOnly]);
  const menu = useKMenu();
  const browserTerms = useFrozenBrowser(view.browser);

  const openCard = overlay !== null && "card" in overlay.open ? overlay.open.card : null;
  const others = useLiveFlow(view, setView, { card: openCard, editing });
  const lookers = useMemo(() => {
    const byCard: Record<number, string[]> = {};
    for (const one of others) if (!one.editing) for (const card of one.cards) (byCard[card] ??= []).push(one.name);
    return byCard;
  }, [others]);

  const move = useCallback(async (card: number, stage: string) => {
    const current = view.cards.find(one => one.id === card);
    if (current === undefined || current.stage === stage) return;
    apply(await send(`${view.flow.href}/cards/${card}/move`, { stage }, csrf));
  }, [view, csrf, apply]);
  const onCard = useCallback((id: number, from: HTMLElement | null) => open({ card: id }, from), [open]);
  const onTriggers = useCallback((id: number, from: HTMLElement | null) => open({ triggers: id }, from), [open]);
  const onPress = useCallback((id: number, from: HTMLElement | null) => open({ press: id }, from), [open]);
  const setDraftFn = useCallback((change: (current: Draft | null) => Draft | null) => setDraft(change), []);

  // The page was opened to allow browser use (?browser=1, the link a waiting card and chat give): bring the decision up.
  useEffect(() => { if (initial.browser != null && browserAsked()) document.getElementById("fl-browser")?.scrollIntoView({ block: "center" }); }, [initial.browser]);
  // Expanded on a phone: the canvas has the screen; the page behind doesn't scroll.
  useEffect(() => {
    document.documentElement.classList.toggle("fl-locked", expanded);
    return () => document.documentElement.classList.remove("fl-locked");
  }, [expanded]);
  useEffect(() => { if (!phone) { setExpanded(false); } }, [phone]);
  const collapse = useCallback(() => setExpanded(false), []);
  // Back from full screen: focus returns to Expand, once it is drawn again.
  const wasExpanded = useRef(false);
  useEffect(() => {
    if (expanded) { wasExpanded.current = true; return; }
    if (!wasExpanded.current) return;
    wasExpanded.current = false;
    document.querySelector<HTMLElement>("[data-flow-expand]")?.focus({ preventScroll: true });
  }, [expanded]);

  const live = view.triggers.filter(one => one.state !== "removed");
  const stages = draft?.stages ?? view.stages;
  const start = draft?.start ?? view.start;
  const dirty = draft !== null && JSON.stringify({ name: draft.name, start: draft.start, stages: draft.stages, owner: draft.owner }) !== JSON.stringify({ name: view.flow.name, start: view.start, stages: view.stages, owner: view.flow.owner });
  const startEditing = () => { setDraft({ name: view.flow.name, start: view.start, stages: view.stages, owner: view.flow.owner }); setEditing(true); setZone(null); close(); setTab("steps"); };
  const stopEditing = () => { setDraft(null); setEditing(false); setZone(null); };
  const save = async () => {
    if (draft === null || saving) return;
    setSaving(true);
    const result = await send(`${view.flow.href}/save`, { name: draft.name, owner: draft.owner, revision: String(view.flow.revision), definition: JSON.stringify({ version: 1, start: draft.start, stages: draft.stages }) }, csrf);
    setSaving(false);
    apply(result);
    if (result.ok) stopEditing();
  };
  const flowApi = useRef<{ center: () => { x: number; y: number } } | null>(null);
  const addZone = () => {
    if (draft === null) return;
    const taken = new Set(draft.stages.map(one => one.id));
    const at = flowApi.current?.center() ?? { x: 0, y: 0 };
    const stage: BrowserFlowStage = { id: slug("New zone", taken), title: "New zone", kind: "inbox", zone: { x: Math.round(at.x - 140), y: Math.round(at.y - 120), w: 280, h: 300, color: "slate" },
      instructions: null, planning: null, approver: null, message: null, close: null, script: null, sort: null, next: null, onFail: null };
    setDraft({ ...draft, stages: [...draft.stages, stage] });
    setZone(stage.id);
  };
  const updateStage = (id: string, change: Partial<BrowserFlowStage>) => setDraft(current => current === null ? current : { ...current, stages: current.stages.map(one => one.id === id ? { ...one, ...change } : one) });

  // What the flow is doing, in one line, then the latest card and the facts.
  const active = view.cards.filter(card => card.state === "active");
  const mine = active.filter(waitsOnMe);
  const latest = [...view.cards].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  const titleOf = (id: string) => view.stages.find(one => one.id === id)?.title ?? id;
  const lead = mine.length > 0 ? (mine.length === 1 ? `A card waits for you in ${titleOf(mine[0]!.stage)}` : `${mine.length} cards wait for you`)
    : active.length > 0 ? `${active.length} card${active.length === 1 ? "" : "s"} in progress` : view.cards.length > 0 ? "Nothing in progress" : "No cards yet";
  const browserBlocked = view.browser != null && view.browser.status !== "allowed";
  const button = live.find(one => one.button !== null && one.state === "active");
  const schedule = live.find(one => one.kind === "schedule" && one.checkable && one.state === "active");
  const [running, setRunning] = useState(false);
  const runNow = async () => { if (schedule === undefined || running) return; setRunning(true); apply(await send(`${view.flow.href}/triggers/${schedule.id}/check`, {}, csrf)); setRunning(false); };
  /** The screen's one primary: what resolves a wait on you first, then the act that starts work. */
  const wanted: Primary | null = editing ? null
    : mine.length > 0 ? { label: mine.length === 1 ? "Review" : `Review ${mine.length}`, act: from => open({ card: mine[0]!.id }, from), data: { "data-flow-review": "" } }
    : browserBlocked && view.canEdit && view.browser?.canApprove !== false ? null
    : button !== undefined ? { label: button.button!.label, act: from => open({ press: button.id }, from), data: { "data-flow-press": String(button.id) } }
    : schedule !== undefined && view.canEdit ? { label: "Run now", busy: running ? "Starting…" : false, act: () => void runNow(), data: { "data-flow-run-now": "" } }
    : view.canEdit ? { label: "New card", act: from => open({ newCard: true }, from), data: { "data-flow-new-card": "" } } : null;
  const steady = useSteadyPrimary(wanted);
  const primary = steady.shown;
  const primaryButton = (sm: boolean) => primary === null ? null
    : <KButton variant="primary" sm={sm} label={primary.label} busy={primary.busy ?? false} {...primary.data} {...(primary.label === "New card" ? { lead: "plus" as const } : {})}
      onPointerDown={steady.onPointerDown} onClick={event => steady.run(event)} />;
  const more = (from: HTMLElement) => menu(from, phone ? view.flow.name : "More", [
    ...(phone ? [{ label: "Triggers", act: () => open({ triggers: null }, from) }, { label: "Scripts", act: () => open({ scripts: true }, from) }] : []),
    ...(view.canEdit && !phone ? [{ label: "Edit flow", act: startEditing }] : []),
    ...(view.canEdit && primary?.label !== "New card" ? [{ label: "New card", act: () => open({ newCard: true }, from) }] : []),
    ...(view.canEdit && view.unattended.scheduled && view.unattended.active === null ? [{ label: "Run on its own…", act: () => open({ unattended: true }, from) }] : []),
    ...(view.canEdit ? [{ label: "Change it in chat", act: () => { window.location.assign(view.chatHref); } }] : []),
    { label: "Export as a file", act: () => { window.location.assign(`${view.flow.href}/export`); } },
  ]);
  const tabs = <KSeg label="View" current={tab} onChange={key => setTab(key as "steps" | "runs")} items={[{ key: "steps", label: "Steps" }, { key: "runs", label: "Runs", count: <KCount n={view.cards.length} /> }]} />;
  const moreButton = (props: { sm?: boolean } = {}) => <KButton variant="ghost" iconOnly="more" label="More" sm={props.sm === true} aria-haspopup="dialog" data-flow-menu onClick={event => more(event.currentTarget)} />;

  const header = editing && draft !== null
    ? <div className="k-tb fl-edit-tb">
        <KInput value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} maxLength={80} aria-label="Flow name" className="fl-name" />
        <label className="fl-owner"><span className="k-note">Owner</span>
          <KSelect sm value={draft.owner} onChange={event => setDraft({ ...draft, owner: event.target.value })} aria-label="Flow owner"
            items={[...new Set([draft.owner, ...view.approvers])].map(name => [name, name === view.me ? `${name} (you)` : name] as const)} /></label>
        <span className="k-grow" />
        <KButton variant="ghost" sm lead="code" label="Scripts" onClick={event => open({ scripts: true }, event.currentTarget)} />
        <KButton sm lead="plus" label="Add zone" onClick={addZone} />
        <KButton variant="ghost" sm label="Discard" onClick={stopEditing} />
        <KButton variant="primary" sm label="Save flow" busy={saving ? "Saving…" : false} disabled={!dirty} onClick={() => void save()} />
      </div>
    : <KPageHeader title={view.flow.name} back="/flows" ctx={view.flow.project}
        right={<>{tabs}{view.canEdit && <KButton variant="ghost" sm lead="bolt" label={live.length > 0 ? `Triggers · ${live.length}` : "Triggers"} data-open-triggers onClick={event => open({ triggers: null }, event.currentTarget)} />}
          <KButton variant="ghost" sm lead="code" label="Scripts" data-open-scripts onClick={event => open({ scripts: true }, event.currentTarget)} />{moreButton({ sm: true })}{primaryButton(true)}</>}
        trailing={moreButton()} />;

  const latestLine = latest === undefined ? null : <p className="fl-latest"><span className={cn("fl-dot", waitsOnMe(latest) ? "wait" : latest.state === "done" ? "ok" : latest.state === "active" && latest.waiting === null ? "run" : "idle")} aria-hidden="true" />
    <span>{latest.title} · {latest.state === "active" ? `in ${titleOf(latest.stage)}${latest.waiting !== null ? `: ${latest.waiting}` : ""}` : latest.state === "done" ? "done" : "cancelled"}</span><span className="fl-when k-num">{when(latest.updatedAt)}</span></p>;
  const firstTrigger = live.find(one => one.state === "active") ?? live[0];
  const head = <div className="fl-head">
    <h2 className="fl-lead">{lead}</h2>
    <span className="sr-only" role="status" aria-live="polite" data-flow-primary-said>{steady.said}</span>
    {latestLine}
    <p className="fl-meta">
      <span className="fl-meta-item">{firstTrigger === undefined ? "Cards are added by hand" : firstTrigger.words}</span>
      <span className="fl-meta-item">owner {view.flow.owner}</span>
      <UnattendedLine view={view} csrf={csrf} apply={apply} />
      <BrowserLine view={view} csrf={csrf} apply={apply} />
      <AlsoHere others={others} cards={view.cards} />
    </p>
    {overlay === null && <Outcome outcome={outcome} />}
  </div>;

  const recent = [...view.cards].sort((a, b) => Number(waitsOnMe(b)) - Number(waitsOnMe(a)) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const cardRow = (card: BrowserFlowCard) => <div key={card.id} className="fl-rowwrap" data-card-row={card.id}
    onClick={event => { const link = (event.target as HTMLElement).closest("a.k-row-t"); if (link === null) return; event.preventDefault(); open({ card: card.id }, link as HTMLElement); }}>
    <KRow href={`${view.flow.href}?card=${card.id}`} chip={cardChip(card)} title={card.title} wait={waitsOnMe(card)}
      desc={card.state === "active" ? `In ${titleOf(card.stage)}${card.waiting !== null ? ` · ${card.waiting}` : ""}` : card.history.at(-1)?.text ?? (card.state === "done" ? "Finished" : "Cancelled")}
      meta={<span className="k-num">{when(card.updatedAt)}</span>}
      action={waitsOnMe(card) ? <KButton sm label="Review" onClick={event => open({ card: card.id }, event.currentTarget)} /> : undefined} />
  </div>;
  const recentRuns = recent.length === 0 ? null : <div className="fl-recent" aria-label="Recent runs">
    <KGroup label="Recent runs" count={<KCount n={recent.length} />} />
    {recent.slice(0, 3).map(cardRow)}
    {recent.length > 3 && <p className="fl-more-runs"><KButton variant="ghost" sm label={`See all ${recent.length} runs`} onClick={() => setTab("runs")} /></p>}
  </div>;

  const phoneList = <div className="fl-list" data-flow-list>
    {flowOrder(view.stages, view.start).map(stage => {
      const cards = view.cards.filter(one => one.stage === stage.id && one.state === "active");
      return <section key={stage.id} className="fl-step" data-step={stage.id} aria-label={stage.title}>
        <header className="fl-step-h"><span className="fl-ico" style={{ color: COLORS[stage.zone.color] ?? COLORS["slate"] }}>{KIND_ICONS[stage.kind]}</span>
          <span className="fl-step-t"><b>{stage.title}</b><span className="k-note">{view.kinds.find(one => one.kind === stage.kind)?.label ?? stage.kind}{stage.id === view.start ? " · new cards start here" : ""}</span></span>
          {cards.length > 0 && <KCount n={cards.length} ink={cards.some(waitsOnMe)} />}</header>
        {stage.kind === "check" && stage.browser === true && browserBlocked && <p className="fl-step-br k-note">Starts a browser · not allowed</p>}
        {cards.length > 0 && <ul className="fl-cards">{cards.map(one => <li key={one.id}><a href={`${view.flow.href}?card=${one.id}`} className={cn("fl-card", waitsOnMe(one) && "wait")} data-card={one.id} onClick={event => { event.preventDefault(); onCard(one.id, event.currentTarget); }}>
          <span className="fl-card-t">{one.title}</span>
          {one.sorted !== null && <span className="fl-card-l"><SortChip sorted={one.sorted} /></span>}
          {one.waiting !== null && <span className={cn("fl-card-l", waitsOnMe(one) && "mine")}>{one.canDecide ? NEEDS.card.sentence({}) : one.question?.mine ? `${one.question.from.split(" · ")[0]} asks you` : one.waiting}</span>}
        </a></li>)}</ul>}
      </section>;
    })}
  </div>;

  const canvas = <FlowCanvas view={view} stages={stages} start={start} owner={draft?.owner ?? view.flow.owner} editing={editing} vertical={phone} expanded={expanded}
    mineOnly={mineOnly} selectedCard={openCard} lookers={lookers} onCard={onCard} onDrop={(card, to) => void move(card, to)} onTriggers={onTriggers} onPress={onPress}
    onZone={setZone} setDraft={setDraftFn} name={view.flow.name} covered={overlay !== null} onExpand={from => { expandFrom.current = from; setExpanded(true); }} onCollapse={collapse} />;
  const hasOthers = view.cards.some(card => card.state === "active" && !card.mine);
  const steps = <>
    {phone && <div className="fl-viewsw"><KSeg label="Layout" current={layout} onChange={key => { setLayout(key as "list" | "canvas"); setExpanded(false); }} items={[{ key: "list", label: "List" }, { key: "canvas", label: "Canvas" }]} /></div>}
    {!phone && !editing && hasOthers && <div className="fl-filter"><KSeg label="Which cards" current={mineOnly ? "mine" : "all"} onChange={key => setMineOnly(key === "mine")} items={[{ key: "all", label: "All cards" }, { key: "mine", label: "Mine" }]} /></div>}
    <div className={cn("fl-stage", editing && zone !== null && "with-aside")}>
      {phone && layout === "list" ? phoneList : <ReactFlowProvider><CanvasApi api={flowApi} />{canvas}</ReactFlowProvider>}
      {editing && zone !== null && draft !== null && (() => {
        const selected = draft.stages.find(one => one.id === zone);
        return selected === undefined ? null : <aside className="fl-aside" data-flow-drawer>
          <ZonePanel stage={selected} stages={draft.stages} view={view} csrf={csrf} apply={apply} update={change => updateStage(selected.id, change)}
            remove={() => { setDraft(current => current === null ? current : { ...current, start: current.start === selected.id ? current.stages.find(one => one.id !== selected.id)!.id : current.start,
              stages: current.stages.filter(one => one.id !== selected.id).map(one => ({ ...one, next: one.next === selected.id ? null : one.next, onFail: one.onFail === selected.id ? null : one.onFail })) }); setZone(null); }}
            makeStart={() => setDraft(current => current === null ? current : { ...current, start: selected.id })} onClose={() => setZone(null)} />
        </aside>;
      })()}
    </div>
    {!editing && recentRuns}
  </>;
  const runs = <div className="fl-runs">
    {view.cards.length === 0 ? <KEmpty title="This flow hasn't run yet." text={button !== undefined ? `It runs when someone presses ${button.button!.label}.` : schedule !== undefined ? `It runs ${schedule.words.replace(/^./, char => char.toLowerCase())}, or press Run now.` : "It runs when its trigger fires, or add a card by hand."} />
      : <><KGroup label="Runs" count={<KCount n={view.cards.length} />} />{recent.map(cardRow)}</>}
    <section className="fl-insights"><InsightsPanel view={view} /></section>
  </div>;

  const overlayCard = overlay !== null && "card" in overlay.open ? view.cards.find(one => one.id === (overlay.open as { card: number }).card) ?? null : null;
  const pressing = overlay !== null && "press" in overlay.open ? view.triggers.find(one => one.id === (overlay.open as { press: number }).press && one.button !== null) ?? null : null;
  const drawer = overlay === null ? null
    : overlayCard !== null ? { title: overlayCard.title, body: <CardPanel card={overlayCard} view={view} csrf={csrf} apply={apply}
        onAllowBrowser={() => { close(); requestAnimationFrame(() => { const frame = document.getElementById("fl-browser"); frame?.scrollIntoView({ block: "center" }); frame?.querySelector<HTMLElement>(".k-btn-primary")?.focus({ preventScroll: true }); }); }} /> }
    : pressing !== null ? { title: pressing.button!.label, body: <PressPanel key={pressing.id} trigger={pressing} view={view} csrf={csrf} apply={apply} onDone={close} /> }
    : "triggers" in overlay.open ? { title: "Triggers", body: <TriggersPanel view={view} csrf={csrf} apply={apply} focus={overlay.open.triggers} onPress={id => open({ press: id }, overlay.from)} /> }
    : "scripts" in overlay.open ? { title: "Scripts", body: <ScriptsPanel view={view} csrf={csrf} apply={apply} /> }
    : "unattended" in overlay.open ? { title: "Run on its own", body: <UnattendedPanel view={view} csrf={csrf} apply={apply} onSigned={close} /> }
    : "newCard" in overlay.open ? { title: "New card", body: <NewCard view={view} csrf={csrf} apply={result => { apply(result); if (result.ok) close(); }} /> }
    : null;

  return <div className="fl-page" data-kit-page data-flow={view.flow.id}>
    {header}
    {phone && !editing && <div className="fl-phonebar">{tabs}</div>}
    {!editing && head}
    {editing && <Outcome outcome={outcome} />}
    {!editing && <BrowserFrame view={view} csrf={csrf} apply={apply} phone={phone} {...browserTerms} />}
    <div className="fl-body">{tab === "runs" && !editing ? runs : steps}</div>
    {phone && !editing && primary !== null && !(browserBlocked && view.canEdit) && <KDock>{primaryButton(false)}</KDock>}
    {phone && !editing && browserBlocked && view.canEdit && view.browser?.canApprove !== false && !browserTerms.moved && browserTerms.frozen !== null && <BrowserDock view={view} csrf={csrf} apply={apply} frozen={browserTerms.frozen} />}
    {drawer !== null && <KOverlay kind="drawer" title={drawer.title} trigger={overlay!.from} onClose={close}>
      {/* The drawer is portalled to <body>: it keeps the flow view's own ground (its scoped reset and the fl- rules). */}
      <div data-view="flow-drawer" className="fl-drawer-body"><Outcome outcome={outcome} />{drawer.body}</div></KOverlay>}
  </div>;
}

/** The phone dock's copy of Allow browser (the frame's own is hidden on a phone): the same terms, from the same view. */
function BrowserDock({ view, csrf, apply, frozen: browser }: { view: BrowserFlowView; csrf: string; apply: (result: Said) => void; frozen: BrowserNow }) {
  if (browser.problem !== null || browser.digest === null) return null;
  const digest = browser.digest;
  return <KDock><StepUpAct view={view} label="Allow browser" busyLabel="Allowing…"
    terms={`${view.flow.name} · ${browser.zones.map(one => `${one.title} runs ${one.script} v${one.version}`).join("; ")} · digest ${digest.slice(0, 12)}`}
    act={async password => { const result = await send(`${view.flow.href}/browser`, { digest, password }, csrf); if (!result.ok) return result.said; apply(result); return null; }} /></KDock>;
}

/** Lets the page ask the canvas where its middle is (a new zone lands there). */
function CanvasApi({ api }: { api: { current: { center: () => { x: number; y: number } } | null } }) {
  const flow = useReactFlow();
  useEffect(() => { api.current = { center: () => flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 }) }; return () => { api.current = null; }; }, [flow, api]);
  return null;
}
