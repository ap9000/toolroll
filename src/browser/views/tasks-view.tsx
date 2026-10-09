/** Tasks, rebuilt with shadcn/ui: a visible title with what needs you, link
 * tabs with counts, then one row per task. What needs a person comes first,
 * grouped by what it asks (Decide, Review, Unblock), and wears a solid ink
 * chip naming the ask; every other row keeps a quiet neutral chip. The next
 * step is one quiet button. Filtering and paging stay server-side (real
 * URLs), so Back and bookmarks work. Usage folds to one line on a desk and
 * sits below the list on a phone, so the first task is near the top. */
import { ArrowRight, ChevronDown, ChevronRight, Ellipsis, Inbox, LayoutGrid, ListTodo, Plus, Sparkles, Code2, ListOrdered, Briefcase } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { BrowserLimits, BrowserLimitTile, BrowserTasksView } from "../../browser-workspace.js";
import { Button, Card, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, cn } from "../components/ui/index.js";
import { HeadlineBadge } from "./status-summary.js";

const TOOL_ICONS: Record<string, ReactNode> = {
  "/inbox": <Inbox />, "/code": <Code2 />, "/board": <LayoutGrid />, "/board?view=order": <ListOrdered />,
  "/tasks": <ListTodo />, "/recipes": <Sparkles />, "/workbench": <Briefcase />,
};

const LIMIT_FILL: Record<BrowserLimitTile["tone"], string> = { neutral: "bg-foreground", warning: "bg-warning", danger: "bg-destructive" };
const LIMIT_TEXT: Record<BrowserLimitTile["tone"], string> = { neutral: "", warning: "text-warning", danger: "text-destructive" };

/** One limit: whose and which window, the figure, a bar (with the 50/80 % alert marks on a budget), and when it resets. */
function LimitTile({ tile }: { tile: BrowserLimitTile }) {
  const body = <>
    <p className="flex min-w-0 items-baseline gap-1.5 text-[12px] leading-4">
      <span className="truncate font-medium text-foreground">{tile.name}</span>
      <span className="shrink-0 text-muted-foreground">{tile.window}</span>
    </p>
    <p className={cn("mt-2.5 flex items-baseline tabular-nums phone:mt-1.5", tile.unit === "%" ? "gap-px" : "gap-1")}>
      <span className={cn("text-[22px] font-semibold leading-none tracking-[-0.02em]", tile.tone === "danger" && "text-destructive")}>{tile.value}</span>
      <span className="text-[12px] text-muted-foreground">{tile.unit}</span>
    </p>
    <div className="relative mt-3 h-1.5 phone:mt-2 overflow-hidden rounded-full bg-muted" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(100, tile.percent))}
      aria-label={`${tile.name} ${tile.window}`}>
      <div className={cn("h-full rounded-full motion-safe:transition-[width] motion-safe:duration-500 motion-safe:ease-out", LIMIT_FILL[tile.tone])} style={{ width: `${Math.min(100, Math.max(0, tile.percent))}%` }} />
      {tile.marks.map(mark => <span key={mark} aria-hidden="true" className="absolute inset-y-0 w-0.5 bg-card" style={{ left: `calc(${mark}% - 1px)` }} />)}
    </div>
    <p className={cn("mt-2 truncate text-[12px] leading-4 phone:mt-1.5", tile.tone === "neutral" ? "text-muted-foreground" : LIMIT_TEXT[tile.tone])}>{tile.detail}</p>
  </>;
  const frame = "block min-w-0 rounded-[10px] border border-border bg-card px-3.5 py-3 phone:w-[152px] phone:px-3 phone:py-2.5 phone:shrink-0 phone:snap-start";
  return <li data-limit={tile.key} title={tile.title ?? undefined} className="min-w-0 phone:shrink-0">
    {tile.href === null ? <div className={frame}>{body}</div>
      : <a href={tile.href} className={cn(frame, "transition-colors hover:border-input hover:bg-[var(--so-raised)]")}>{body}</a>}
  </li>;
}

/** Plans' usage windows and monthly budgets: one row of tiles, scrolling sideways on a phone. */
function LimitTiles({ limits, id, className }: { limits: BrowserLimits; id?: string; className?: string }) {
  return <section aria-label="Usage" id={id} className={className}>
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(176px,1fr))] gap-2 phone:-mx-4 phone:flex phone:snap-x phone:snap-mandatory phone:scroll-px-4 phone:overflow-x-auto phone:px-4 phone:pb-1 phone:[scrollbar-width:none]">
      {limits.tiles.map(tile => <LimitTile key={tile.key} tile={tile} />)}
    </ul>
  </section>;
}

/** Each limit as a word and a percentage: the plan's name for its first window, the window's name after it
 * ("Claude 48% · Weekly 83% · Codex 12%"). */
export function usageSummary(limits: BrowserLimits): { key: string; text: string; tone: BrowserLimitTile["tone"] }[] {
  const named = new Set<string>();
  return limits.tiles.map(tile => {
    const word = named.has(tile.name) ? tile.window : tile.name;
    named.add(tile.name);
    return { key: tile.key, text: `${word} ${Math.round(Math.max(0, tile.percent))}%`, tone: tile.tone };
  });
}

/** A row's chip. A waiting row sits under its group heading (Decide, Review, Unblock), so its chip names the
 * specific ask in ink (Plan, Result, Mismatch, Failed, Builder offline), never the heading again; with no
 * specific ask it wears none, and its state stays one tap away in the row's own words. Outside a group (an
 * ungrouped list, or a row no heading covers) such a row wears its headline in the same ink chip, so every row
 * shows a state word and every waiting row reads alike.
 * Every other row wears its headline, the same words as the task page, the result and Crew. */
function TaskChip({ row, grouped }: { row: BrowserTasksView["rows"][number]; grouped: boolean }) {
  const place = "text-[12px] desk:col-start-1 desk:row-start-1 desk:justify-self-start phone:col-start-1 phone:row-start-2 phone:self-center";
  if (row.ask === null) return <HeadlineBadge label={row.status.label} tone={row.status.tone === "attention" ? "neutral" : row.status.tone} className={place} />;
  if (row.chip === null && grouped) return <span className={cn("sr-only", place)} data-headline={row.status.label}>{row.status.label}</span>;
  // Outside a group, a chip-less waiting row wears the same ink chip, its headline as the word.
  return <span data-ask={row.ask} {...(row.chip === null ? {} : { "data-chip": row.chip })} data-headline={row.status.label} title={row.status.label}
    className={cn("inline-flex w-fit shrink-0 items-center whitespace-nowrap rounded-[5px] bg-primary px-1.5 py-px font-semibold leading-[18px] text-primary-foreground", place)}>
    {row.chip === null ? row.status.label : <><span className="sr-only">{row.status.label}: </span>{row.chip}</>}
  </span>;
}

function TaskRow({ row, grouped = false }: { row: BrowserTasksView["rows"][number]; grouped?: boolean }) {
  // On a phone the row is a small grid: the title with its action on the right, then the chip beside the
  // project and age, then any detail. The title block and the chip cluster dissolve into it (contents).
  const waiting = row.ask !== null;
  return <li data-task={row.id} data-work-status={row.status.token} data-group={row.group}
    className="grid grid-cols-1 gap-y-2 border-b border-border px-2 py-3 transition-colors hover:bg-[var(--so-raised)] desk:col-span-3 desk:grid-cols-subgrid desk:items-center desk:gap-x-4 phone:grid-cols-[auto_minmax(0,1fr)_auto] phone:gap-x-2 phone:gap-y-0.5 phone:py-1.5">
    <div className="min-w-0 desk:col-start-2 desk:row-start-1 phone:contents">
      <a href={row.href} className={cn("block text-[13.5px] leading-snug hover:underline hover:underline-offset-4 phone:col-[1/3] phone:row-start-1 phone:flex phone:min-h-11 phone:items-center",
        waiting ? "font-semibold" : "font-medium")}>{row.title}</a>
      <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[12.5px] text-muted-foreground phone:col-[2/4] phone:row-start-2 phone:mt-0 phone:min-w-0 phone:leading-[1.35]">
        {row.project && <span className="text-foreground/80">{row.project}</span>}
        {row.project && <span aria-hidden="true">·</span>}
        <span className="tabular-nums">{row.age}</span>
      </p>
      {/* A failed row's problem line is vermilion; every other detail stays muted. */}
      {row.detail && <p className={cn("mt-1 text-[12.5px] phone:col-span-full phone:leading-[1.35]", row.status.label === "Failed" ? "text-destructive" : "text-muted-foreground")}
        {...(row.status.label === "Failed" ? { "data-problem-line": "" } : {})}>{row.detail}</p>}
      {row.problem && <p className="mt-1 text-[12.5px] text-muted-foreground phone:col-span-full phone:leading-[1.35]">{row.problem}</p>}
      {row.notes.map(note => <p key={note} className="mt-1 text-[12.5px] text-muted-foreground phone:col-span-full phone:leading-[1.35]">{note}</p>)}
    </div>
    <div className="flex items-center gap-3 phone:contents desk:contents">
      <TaskChip row={row} grouped={grouped} />
      {row.action && <Button asChild variant="outline" size="sm" className="desk:col-start-3 desk:row-start-1 desk:justify-self-end phone:col-start-3 phone:row-start-1 phone:self-start">
        <a href={row.action.href} data-primary-action>{row.action.label}<ArrowRight /></a>
      </Button>}
    </div>
  </li>;
}

/** The rows in the view's groups, in order, each under a small heading with its count; a plain list otherwise.
 * On a desk every group shares one grid (chip, title, action), so chips and actions line up down the page. */
function TaskList({ view }: { view: BrowserTasksView }) {
  const grid = "desk:grid desk:grid-cols-[auto_minmax(0,1fr)_auto]";
  if (view.groups === null) return <ul className={cn(grid, "border-t border-border")}>{view.rows.map(row => <TaskRow key={row.id} row={row} />)}</ul>;
  const sections = view.groups.map(group => ({ ...group, rows: view.rows.filter(row => row.group === group.key) })).filter(one => one.rows.length > 0);
  const placed = new Set(sections.map(one => one.key));
  const loose = view.rows.filter(row => !placed.has(row.group));
  return <div className={cn(grid, "flex flex-col gap-5 phone:gap-3.5 desk:gap-0")}>
    {sections.map((section, index) => <section key={section.key} data-task-group={section.key} aria-labelledby={`task-group-${section.key}`} className="desk:contents">
      <h2 id={`task-group-${section.key}`} className={cn("flex items-baseline gap-2 border-b border-border px-2 pb-1.5 text-[13px] font-semibold leading-5 desk:col-span-3", index > 0 && "desk:mt-6")}>
        {section.label}<span className="font-mono text-[12px] font-medium tabular-nums text-muted-foreground">{section.count}</span>
      </h2>
      <ul className="desk:contents">{section.rows.map(row => <TaskRow key={row.id} row={row} grouped />)}</ul>
    </section>)}
    {loose.length > 0 && <ul className="desk:contents">{loose.map(row => <TaskRow key={row.id} row={row} />)}</ul>}
  </div>;
}

/** On a desk the usage tiles fold to one line beside the title; a click shows them. */
function UsageToggle({ limits, open, onToggle, controls }: { limits: BrowserLimits; open: boolean; onToggle: () => void; controls: string }) {
  const parts = usageSummary(limits);
  return <button type="button" aria-expanded={open} aria-controls={controls} onClick={onToggle} data-usage-summary
    className="ml-auto inline-flex min-h-8 min-w-0 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-muted-foreground transition-colors hover:bg-[var(--so-raised)] hover:text-foreground phone:hidden">
    <span className="sr-only">Usage: </span>
    <span className="truncate tabular-nums">{parts.map((part, index) => <span key={part.key}>{index > 0 && <span aria-hidden="true"> · </span>}<span className={LIMIT_TEXT[part.tone]}>{part.text}</span></span>)}</span>
    <ChevronRight aria-hidden="true" className={cn("size-3.5 shrink-0 motion-safe:transition-transform", open && "rotate-90")} />
  </button>;
}

/** A strip that scrolls sideways (the view tabs on a phone): the edge that has more fades out,
 * so a cut-off tab reads as "scroll for more" rather than clipped. */
function ScrollStrip({ label, className, children }: { label: string; className: string; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const [more, setMore] = useState({ before: false, after: false });
  useEffect(() => {
    const strip = ref.current;
    if (strip === null) return;
    const measure = () => setMore(was => {
      const now = { before: strip.scrollLeft > 1, after: strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1 };
      return now.before === was.before && now.after === was.after ? was : now;
    });
    measure();
    strip.addEventListener("scroll", measure, { passive: true });
    const resized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    resized?.observe(strip);
    return () => { strip.removeEventListener("scroll", measure); resized?.disconnect(); };
  }, []);
  const fade = more.before || more.after
    ? `linear-gradient(to right, ${more.before ? "transparent, #000 28px" : "#000"}, ${more.after ? "#000 calc(100% - 40px), transparent" : "#000"})` : undefined;
  return <nav ref={ref} aria-label={label} className={cn("[scrollbar-width:none] [&::-webkit-scrollbar]:hidden", className)}
    data-scrolls={more.before || more.after ? (more.after ? "more" : "end") : undefined}
    style={fade === undefined ? undefined : { maskImage: fade, WebkitMaskImage: fade }}>{children}</nav>;
}

export function TasksView({ view }: { view: BrowserTasksView }) {
  const [usageOpen, setUsageOpen] = useState(false);
  const usageId = useId();
  const limits = view.limits !== null && view.limits.tiles.length > 0 ? view.limits : null;
  return <div className="flex w-full max-w-[960px] flex-col gap-5 phone:gap-3 phone:px-0.5">
    <div className="flex min-w-0 items-baseline gap-x-3 gap-y-1">
      <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.02em]">Tasks</h1>
      {view.needsYou > 0 && <p className="whitespace-nowrap text-[13px] text-muted-foreground" data-needs-you-count>
        <span className="font-semibold tabular-nums text-foreground">{view.needsYou}</span> {view.needsYou === 1 ? "needs" : "need"} you</p>}
      {limits && <UsageToggle limits={limits} open={usageOpen} onToggle={() => setUsageOpen(open => !open)} controls={usageId} />}
      <div className={cn("flex shrink-0 items-center gap-2 self-center", !limits && "ml-auto", "phone:ml-auto")}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="outline" size="sm" aria-label="Work tools"><span className="phone:hidden">Work tools</span><ChevronDown className="phone:hidden" /><Ellipsis className="desk:hidden" /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {view.tools.map(tool => <DropdownMenuItem key={tool.href} asChild><a href={tool.href}>{TOOL_ICONS[tool.href]}{tool.label}</a></DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button asChild size="sm" className="desk:hidden"><a href={view.newTask.href}><Plus />{view.newTask.label}</a></Button>
      </div>
    </div>
    {limits && usageOpen && <LimitTiles limits={limits} id={usageId} className="phone:hidden" />}
    <div className="flex min-w-0 items-center">
      <ScrollStrip label="Task views" className="-mx-1 min-w-0 max-w-full overflow-x-auto px-1 phone:-mr-4 phone:max-w-none phone:pr-4">
        <ul className="inline-flex h-8 items-center gap-0.5 rounded-lg bg-muted p-0.5 phone:h-12">
          {view.tabs.map(tab => <li key={tab.href} className="h-full">
            <a href={tab.href} aria-current={tab.active ? "page" : undefined}
              className={cn("inline-flex h-full items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground",
                tab.active && "bg-card text-foreground shadow-[var(--so-pill-shadow)]")}>
              {tab.label}
              <span className={cn("min-w-[18px] rounded-full px-1.5 text-center font-mono text-[12px] leading-[18px] tabular-nums", tab.label === "Needs you" && tab.count > 0 ? "bg-attention text-on-attention" : "text-muted-foreground")}>{tab.count}</span>
            </a>
          </li>)}
        </ul>
      </ScrollStrip>
    </div>

    {view.empty !== null ? <Card className="items-start py-10">
      <p className="text-base text-muted-foreground">{view.empty.text}</p>
      {view.empty.action && <Button asChild variant="outline"><a href={view.empty.action.href}>{view.empty.action.label}</a></Button>}
    </Card> : <TaskList view={view} />}

    {(view.pages.first || view.pages.next) && <nav aria-label="Task pages" className="flex gap-2">
      {view.pages.first && <Button asChild variant="outline" size="sm"><a href={view.pages.first}>First page</a></Button>}
      {view.pages.next && <Button asChild variant="outline" size="sm"><a href={view.pages.next} rel="next">Next page</a></Button>}
    </nav>}
    {limits && <LimitTiles limits={limits} className="desk:hidden" />}
  </div>;
}
