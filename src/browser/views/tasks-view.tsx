/** Tasks (src/design/KIT.md): one list with filters and two views. The top bar holds the title, the project and
 * status filters with their counts, the text filter, the List / Board switch and New task; on a phone they become one
 * row of selects under the header. Rows are quiet one-liners between hairlines: what needs you first, grouped by what
 * it asks (Decide, Review, Unblock), each with its one action; then Running, Queued and Finished. The Board view is
 * the same index as columns. Filters and paging stay server-side (real addresses), so Back and bookmarks work; the
 * text filter narrows the rows already on the page. */
import { useMemo, useState, type ReactNode } from "react";
import type { BrowserLimits, BrowserTaskRow, BrowserTasksView } from "../../browser-workspace.js";
import {
  KBoard, KBoardCol, KButton, KCard, KChip, KCount, KEmpty, KFilter, KGroup, KIcon, KLinkButton, KLinkSeg, KPageHeader, KRow, KSeg, KSelect, useKMenu,
} from "../kit/index.js";
import { PostForm } from "../ui/post-form.js";

const go = (href: string): void => { window.location.assign(href); };

/** Each limit as a word and a percentage: the plan's name for its first window, the window's name after it
 * ("Claude 48% · Weekly 83% · Codex 12%"). */
export function usageSummary(limits: BrowserLimits): { key: string; text: string; tone: BrowserLimits["tiles"][number]["tone"]; percent: number }[] {
  const named = new Set<string>();
  return limits.tiles.map(tile => {
    const word = named.has(tile.name) ? tile.window : tile.name;
    named.add(tile.name);
    const percent = Math.round(Math.max(0, tile.percent));
    return { key: tile.key, text: `${word} ${percent}%`, tone: tile.tone, percent };
  });
}

/** A row's meta: the project (when the list spans several) and its age. */
function Meta({ row }: { row: BrowserTaskRow }) {
  return <>{row.project !== null && <span>{row.project}</span>}<span className="k-num">{row.age}</span></>;
}

/** Restore, on an archived row: a POST to the task's own route, back to this list. */
function RestoreAct({ tidy }: { tidy: NonNullable<BrowserTaskRow["tidy"]> }) {
  return <PostForm action={tidy.action} data-tidy-act="restore">
    <input type="hidden" name="return" value={tidy.returnTo} />
    <KButton type="submit" sm label="Restore" />
  </PostForm>;
}

function TaskRow({ row }: { row: BrowserTaskRow }) {
  const restore = row.tidy?.label === "Restore" ? row.tidy : null;
  const action = row.action !== null ? <KLinkButton sm label={row.action.label} href={row.action.href} data-primary-action="" />
    : restore !== null ? <RestoreAct tidy={restore} /> : undefined;
  return <KRow href={row.href} chip={<KChip word={row.word.word} tone={row.word.tone} />} title={row.title}
    desc={row.detail ?? row.problem ?? ""} meta={<Meta row={row} />} wait={row.ask !== null} {...(action === undefined ? {} : { action })} />;
}

/** Where a row sits below the Needs-you groups: running, queued, finished or stopped (by its status rank). */
const REST: readonly { key: string; label: string; ranks: readonly number[] }[] = [
  { key: "running", label: "Running", ranks: [0, 1] }, { key: "queued", label: "Queued", ranks: [2] },
  { key: "finished", label: "Finished", ranks: [3] }, { key: "stopped", label: "Stopped", ranks: [4] },
];

/** The rows in their groups: Needs you by its ask, then Running, Queued, Finished; one plain list in a narrower filter. */
function TaskList({ view, rows }: { view: BrowserTasksView; rows: BrowserTaskRow[] }) {
  if (view.groups === null) return <div data-task-list>{rows.map(row => <TaskRow key={row.id} row={row} />)}</div>;
  const asks = view.groups.filter(group => group.key === "decide" || group.key === "review" || group.key === "unblock")
    .map(group => ({ key: group.key as string, label: group.label, rows: rows.filter(row => row.ask !== null && row.group === group.key) }));
  const rest = REST.map(one => ({ key: one.key, label: one.label, rows: rows.filter(row => row.ask === null && one.ranks.includes(row.rank)) }));
  return <div data-task-list>
    {[...asks, ...rest].filter(section => section.rows.length > 0).map(section => <section key={section.key} data-task-group={section.key} aria-label={section.label}>
      <KGroup label={section.label} count={<KCount n={section.rows.length} />} />
      {section.rows.map(row => <TaskRow key={row.id} row={row} />)}
    </section>)}
  </div>;
}

/** The Board view: the same index as columns; one column at a time on a phone, chosen above it. */
function TaskBoard({ view, match }: { view: BrowserTasksView; match: (row: BrowserTaskRow) => boolean }) {
  const columns = view.board ?? [];
  const [column, setColumn] = useState<string>(() => columns.find(one => one.rows.length > 0)?.key ?? "needs");
  return <>
    <div className="k-colpager"><KSeg label="Column" current={column} onChange={setColumn}
      items={columns.map(one => ({ key: one.key, label: one.label, count: <KCount n={one.count} ink={one.key === "needs"} /> }))} /></div>
    <KBoard label="Tasks by status">{columns.map(one => <KBoardCol key={one.key} label={one.label} count={<KCount n={one.count} ink={one.key === "needs"} />}
      needs={one.key === "needs"} on={column === one.key} empty={one.empty}>
      {one.rows.filter(match).map(row => <KCard key={row.id} href={row.href} title={row.title} meta={<><KChip word={row.word.word} tone={row.word.tone} /><Meta row={row} /></>} />)}
    </KBoardCol>)}</KBoard>
  </>;
}

/** The list's other places (Order the queue, Recipes, the action ledger, Put away old tasks), in one menu. */
function ToolsMenu({ view }: { view: BrowserTasksView }) {
  const menu = useKMenu();
  const items = [...view.tools, ...(view.putAway ? [view.putAway] : [])];
  if (items.length === 0) return null;
  return <KButton variant="ghost" sm iconOnly="more" label="More task tools" aria-haspopup="dialog"
    onClick={event => menu(event.currentTarget, "Task tools", items.map(item => ({ label: item.label, act: () => go(item.href) })))} />;
}

export function TasksView({ view }: { view: BrowserTasksView }) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const match = useMemo(() => (row: BrowserTaskRow) => needle === "" || `${row.title} ${row.id}`.toLowerCase().includes(needle), [needle]);
  const rows = view.rows.filter(match);
  const current = view.tabs.find(tab => tab.active)?.key ?? (view.archived?.active ? "archived" : "all");
  const project = view.projects?.find(one => one.active)?.key ?? "";
  const statusItems = view.tabs.map(tab => ({ key: tab.key ?? tab.label, label: tab.label, href: tab.href, count: <KCount n={tab.count} ink={tab.key === "needs-you"} /> }));
  const statusChoices = [...view.tabs.map(tab => ({ key: tab.key ?? tab.label, label: tab.label, href: tab.href, count: tab.count })),
    ...(view.archived ? [{ key: "archived", label: view.archived.label, href: view.archived.href, count: view.archived.count }] : [])];
  const layouts = [{ key: "list", label: "List", href: view.layouts.list, icon: <KIcon name="list" /> }, { key: "board", label: "Board", href: view.layouts.board, icon: <KIcon name="board" /> }];
  const usage = view.limits !== null && view.limits.tiles.length > 0 ? usageSummary(view.limits).map(one => one.text).join(" · ") : null;
  const empty: ReactNode = view.empty !== null
    ? <KEmpty title={view.empty.text} {...(view.empty.action ? { action: <KLinkButton sm label={view.empty.action.label} href={view.empty.action.href} /> } : {})} />
    : rows.length === 0 ? <KEmpty title="Nothing on this page matches." action={<KButton sm variant="ghost" label="Clear the filter" onClick={() => setQuery("")} />} /> : null;
  return <div data-kit-page data-tasks-layout={view.layout}>
    <KPageHeader title="Tasks"
      ctx={<>{view.projects && <KLinkSeg label="Project" current={project} items={view.projects.map(one => ({ key: one.key, label: one.label, href: one.href }))} />}
        <KLinkSeg label="Status" current={current} items={statusItems} /></>}
      right={<><KFilter label="Filter tasks" value={query} onChange={setQuery} /><KLinkSeg icons label="View" current={view.layout} items={layouts} /><ToolsMenu view={view} />
        <KLinkButton variant="primary" sm lead="plus" label={view.newTask.label} href={view.newTask.href} /></>} />
    <div className="k-tbp">
      {view.projects && <KSelect aria-label="Project" value={project} onChange={event => { const to = view.projects!.find(one => one.key === event.target.value); if (to) go(to.href); }}
        items={view.projects.map(one => [one.key, one.key === "" ? "All projects" : one.label] as const)} />}
      {view.layout === "list" && <KSelect aria-label="Status" value={current} onChange={event => { const to = statusChoices.find(one => one.key === event.target.value); if (to) go(to.href); }}
        items={statusChoices.map(one => [one.key, `${one.label} (${one.count})`] as const)} />}
      <KLinkSeg icons label="View" current={view.layout} items={layouts} />
    </div>
    <p className="k-sr" data-needs-you-count>{view.needsYou} {view.needsYou === 1 ? "needs" : "need"} you {view.scope ?? ""}</p>
    {view.layout === "board" ? <TaskBoard view={view} match={match} /> : empty ?? <TaskList view={view} rows={rows} />}
    {view.layout === "list" && view.archived && !view.archived.active && <p className="k-foot"><a href={view.archived.href}>Archived tasks · {view.archived.count}</a></p>}
    {view.layout === "list" && (view.pages.first || view.pages.next) && <p className="k-foot">
      {view.pages.first && <a href={view.pages.first}>First page</a>}{view.pages.first && view.pages.next && " · "}{view.pages.next && <a href={view.pages.next} rel="next">Next page</a>}
    </p>}
    {usage && <p className="k-foot" data-usage-summary>Usage: <a href="/spend">{usage}</a></p>}
  </div>;
}
