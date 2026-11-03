/**
 * The app shell (UI revamp wave B; prototype app.js `rail`, `phoneHeader`, `dock`): the slim rail at a desk, the
 * phone header (menu · title · search) and the phone dock with the Needs-you button beside the screen's one primary.
 * Every Needs-you figure here reads the one count the server sends (`workspace.needsYou`, the Tasks list's own count
 * for its scope), so the rail, the header, the dock and Home never disagree.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import type { BrowserProjectState, BrowserTasksView, BrowserWorkspace } from "../browser-workspace.js";
import { KButton, KChip, KCount, KDockNeeds, KIcon, KNote } from "./kit/index.js";
import { openMenu, openOverlay } from "./kit/behavior.js";
import type { KitIcon } from "../design/kit.js";
import { PostForm } from "./ui/index.js";
import { chimeOn, setChime } from "./chime.js";
import { ASK_LABEL } from "../needs-you.js";
import "./shell.css";

/** The one Needs-you count, its words and the list it opens. */
export type Needs = { count: number; saturated: boolean; label: string; href: string; scope: string | null };
export function needsOf(workspace: BrowserWorkspace): Needs {
  if (workspace.needsYou) return { ...workspace.needsYou };
  // A server without the field: the count the Home row carries (the same Tasks count).
  const home = workspace.navigation.find(item => item.label === "Home" || item.label === "Tasks");
  const count = home?.count ?? 0;
  return { count, saturated: false, scope: null, label: home?.countLabel ?? `${count} ${count === 1 ? "needs" : "need"} you`, href: "/work?view=needs-you" };
}

const NAV_ICONS: Record<string, KitIcon> = { Home: "home", Tasks: "tasks", Flows: "flows", Agents: "agents", Projects: "projects", Settings: "settings" };
export const OPEN_SEARCH_EVENT = "so:open-search";
export const openSearch = (trigger?: HTMLElement | null): void => { window.dispatchEvent(new CustomEvent(OPEN_SEARCH_EVENT, { detail: trigger ?? null })); };

function Brand() {
  return <a className="so-rail-brand" href="/"><span className="so-brand-mark" aria-hidden="true"><i /><i /><i /></span>Toolroll</a>;
}

/** The destinations, each with its icon; Home wears the ink Needs-you count. */
function Destinations({ workspace, needs }: { workspace: BrowserWorkspace; needs: Needs }) {
  return <>{workspace.navigation.map(item => {
    const counted = item.label === "Home" && needs.count > 0;
    return <a key={item.href} className="so-nav" href={item.href} aria-current={item.active ? "page" : undefined}>
      <KIcon name={NAV_ICONS[item.label] ?? "more"} /><span className="so-nav-l">{item.label}</span>
      {counted && <><span className="k-count ink" title={needs.label} data-needs-count>{needs.count}{needs.saturated ? "+" : ""}</span><span className="k-sr">{`, ${needs.label}`}</span></>}
    </a>;
  })}</>;
}

/** The projects in view, each with what needs this person there (the live project summary, when the page has it). */
function RailProjects({ workspace, states, current }: { workspace: BrowserWorkspace; states: BrowserProjectState[] | null; current: string | null }) {
  const rows = states !== null && states.length > 0
    ? states.filter(one => one.path !== null && !one.others).map(one => ({ key: one.path!, name: one.name, href: one.href, needs: 0 }))
    : workspace.projects.map(one => ({ key: one.path, name: one.name, href: one.href, needs: 0 }));
  if (rows.length === 0) return null;
  // Each project's figure is only ever the one Needs-you count for that project (never the summary's own sum).
  for (const row of rows) row.needs = workspace.needsYouByProject?.find(one => one.path === row.key)?.count ?? 0;
  return <nav aria-label="Projects" className="so-rail-projects" data-live data-sidebar-slot="projects">
    <p className="so-rail-h">Projects</p>
    {rows.map(row => <a key={row.key} className="so-nav so-nav-sub" href={row.href} aria-current={row.key === current ? "true" : undefined} title={row.name}>
      <span className="so-pdot" aria-hidden="true" /><span className="so-nav-l">{row.name}</span>
      {row.needs > 0 && !workspace.sensitive && <span className="so-nav-n k-num" aria-label={`${row.needs} ${row.needs === 1 ? "needs" : "need"} you`}>{row.needs}</span>}
    </a>)}
  </nav>;
}

/** Who is signed in, and what stands in for a password on this computer right now. */
function Account({ workspace }: { workspace: BrowserWorkspace }) {
  const signOut = useRef<HTMLFormElement>(null);
  const [chime, setChimeState] = useState(chimeOn);
  const menu = (trigger: HTMLElement) => {
    const items = [
      ...(workspace.usage && !workspace.sensitive ? [{ label: `Plan use · ${workspace.usage.text}`, act: () => { window.location.assign(workspace.usage!.href); } }] : []),
      ...(!workspace.sensitive && workspace.projectStates !== undefined ? [{ label: chime ? "Turn the chime off" : "Chime when something needs me", act: () => { setChime(!chime); setChimeState(!chime); } }] : []),
      { label: "Sign out", act: () => { signOut.current?.requestSubmit(); } },
    ];
    openMenu(trigger, workspace.user || "Account", items);
  };
  return <div className="so-acct">
    <div className="so-acct-row"><span className="so-av" aria-hidden="true">{(workspace.user || "?").slice(0, 1).toUpperCase()}</span>
      <span className="so-acct-name" title={workspace.user}>{workspace.user}</span>
      <KButton variant="ghost" sm iconOnly="more" label="Account" onClick={event => menu(event.currentTarget)} />
    </div>
    <div data-live data-sidebar-slot="chips">{workspace.fresh && !workspace.sensitive ? <PostForm action={workspace.fresh.forget} className="so-acct-note" data-fresh-chip>
      <input type="hidden" name="return" value={workspace.path} />
      <span>Password remembered</span><span>{workspace.fresh.minutes} min left</span><KButton variant="ghost" sm type="submit" label="Forget" className="so-acct-forget" />
    </PostForm> : workspace.passwordless ? <p className="so-acct-note">Passwordless is on</p> : null}</div>
    <PostForm action="/logout" ref={signOut} hidden />
  </div>;
}

/** The desk rail: brand and New task, Search (⌘K), the six destinations, the projects, and the account. */
export function Rail({ workspace, states, current }: { workspace: BrowserWorkspace; states: BrowserProjectState[] | null; current: string | null }) {
  const needs = needsOf(workspace);
  return <nav className="so-rail" aria-label="Main">
    <div className="so-rail-top"><Brand /><span className="k-grow" />
      <a className="k-btn k-btn-ghost k-btn-sm k-btn-icon" href="/tasks/new" aria-label="New task" title="New task"><KIcon name="pen" /></a></div>
    {/* The search page is the fallback; the panel opens in place (never on a sensitive page, which has no palette). */}
    <a className="so-nav" href="/search" data-rail-search onClick={event => { if (workspace.sensitive || event.metaKey || event.ctrlKey) return; event.preventDefault(); openSearch(event.currentTarget); }}>
      <KIcon name="search" /><span className="so-nav-l">Search</span><kbd className="so-kbd" aria-hidden="true">⌘K</kbd></a>
    <Destinations workspace={workspace} needs={needs} />
    <RailProjects workspace={workspace} states={workspace.sensitive ? null : states} current={current} />
    <span className="k-grow" />
    <Account workspace={workspace} />
  </nav>;
}

/** A panel the kit's overlay rules govern (role=dialog, inert behind, Escape, scrim, focus back to its trigger). */
export function ShellOverlay({ className, label, trigger, dim = true, onClose, children }: { className: string; label: string; trigger: HTMLElement | null; dim?: boolean; onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  const closed = useRef(onClose);
  closed.current = onClose;
  useLayoutEffect(() => {
    const node = panel.current;
    if (!node) return;
    let settled = false;
    const close = openOverlay(node, trigger, { dim, onClose: () => { settled = true; closed.current(); } });
    return () => { if (!settled) close(); };
  }, [trigger, dim]);
  return createPortal(<div ref={panel} className={className} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>{children}</div>, document.body);
}

/** The phone's navigation: the same destinations as the rail, in a sheet. */
function NavSheet({ workspace, trigger, onClose, states, current }: { workspace: BrowserWorkspace; trigger: HTMLElement | null; onClose: () => void; states: BrowserProjectState[] | null; current: string | null }) {
  const needs = needsOf(workspace);
  return <ShellOverlay className="k-sheet so-nav-sheet" label="Navigation" trigger={trigger} onClose={onClose}>
    <div className="k-sheet-h"><div className="k-sheet-ht"><h2><span className="so-brand-mark" aria-hidden="true"><i /><i /><i /></span>Toolroll</h2></div>
      <KButton variant="ghost" iconOnly="x" label="Close" data-k-close="" /></div>
    <div className="k-sheet-b so-nav-sheet-b">
      <a className="so-nav" href="/tasks/new"><KIcon name="plus" /><span className="so-nav-l">New task</span></a>
      <Destinations workspace={workspace} needs={needs} />
      <RailProjects workspace={workspace} states={workspace.sensitive ? null : states} current={current} />
      <Account workspace={workspace} />
    </div>
  </ShellOverlay>;
}

/** The phone header: the menu (or Back), the screen's title, and Search. Hidden at a desk. */
export function PhoneHeader({ workspace, title, back, states, current, trailing }: { workspace: BrowserWorkspace; title: string; back?: string | null; states: BrowserProjectState[] | null; current: string | null; trailing?: ReactNode }) {
  const [sheet, setSheet] = useState<HTMLElement | null>(null);
  return <header className="so-ph">
    {back ? <a className="k-btn k-btn-ghost k-btn-icon" href={back} aria-label="Back" title="Back"><KIcon name="back" /></a>
      : <KButton variant="ghost" iconOnly="menu" label="Open navigation" aria-haspopup="dialog" onClick={event => setSheet(event.currentTarget)} />}
    <p className="so-ph-t">{title}</p>
    {trailing}
    {!workspace.sensitive && <KButton variant="ghost" iconOnly="search" label="Search" onClick={event => openSearch(event.currentTarget)} />}
    {sheet && <NavSheet workspace={workspace} trigger={sheet} onClose={() => setSheet(null)} states={states} current={current} />}
  </header>;
}

type SheetRow = { id: string; title: string; href: string; project: string | null; age: string; word: string; group: string };
type SheetRead = { state: "loading" } | { state: "failed" } | { state: "ready"; rows: SheetRow[]; more: boolean };

const ASK_WORD: Record<string, string> = { decide: "Decision", review: "Result", unblock: "Blocked" };
/** What the Needs-you list holds, read from the Tasks list it opens (the same rows, in the same groups). */
async function readNeeds(href: string): Promise<{ rows: SheetRow[]; more: boolean }> {
  const url = new URL(href, window.location.origin);
  url.searchParams.set("format", "workspace");
  const response = await fetch(url.pathname + url.search, { credentials: "same-origin", cache: "no-store", headers: { accept: "application/json" }, signal: AbortSignal.timeout(12_000) });
  if (!response.ok || response.redirected) throw new Error("unavailable");
  const data = await response.json() as { view?: BrowserTasksView | null };
  const view = data.view;
  if (!view || view.kind !== "tasks") throw new Error("unavailable");
  const label = (group: string): string => group in ASK_LABEL ? ASK_LABEL[group as keyof typeof ASK_LABEL] : "Waiting on you";
  return {
    rows: view.rows.map(row => ({ id: row.id, title: row.title, href: row.href, project: row.project, age: row.age, group: label(row.group),
      // The specific ask, never the list's own name again (the same words Home uses).
      word: row.chip ?? (row.status.label === "Needs you" ? ASK_WORD[row.group] ?? row.status.label : row.status.label) })),
    more: view.pages.next !== null,
  };
}

/** The phone's Needs-you list: one tap from anywhere, grouped by what each asks. */
function NeedsSheet({ needs, trigger, onClose }: { needs: Needs; trigger: HTMLElement | null; onClose: () => void }) {
  const [read, setRead] = useState<SheetRead>({ state: "loading" });
  useEffect(() => {
    let live = true;
    readNeeds(needs.href).then(found => { if (live) setRead({ state: "ready", ...found }); }, () => { if (live) setRead({ state: "failed" }); });
    return () => { live = false; };
  }, [needs.href]);
  const groups: { label: string; rows: SheetRow[] }[] = [];
  if (read.state === "ready") for (const row of read.rows) {
    const group = groups.find(one => one.label === row.group);
    if (group) group.rows.push(row); else groups.push({ label: row.group, rows: [row] });
  }
  return <ShellOverlay className="k-sheet so-needs-sheet" label="Needs you" trigger={trigger} onClose={onClose}>
    <div className="k-sheet-h"><div className="k-sheet-ht"><h2>Needs you <KCount n={needs.count} ink /></h2><KNote>{needs.label}</KNote></div>
      <KButton variant="ghost" iconOnly="x" label="Close" data-k-close="" /></div>
    <div className="k-sheet-b">
      {read.state === "loading" && <p className="so-sheet-line" role="status">Loading…</p>}
      {read.state === "failed" && <p className="so-sheet-line" role="alert">Couldn’t load the list. <a className="k-link" href={needs.href}>Open it in Tasks</a></p>}
      {read.state === "ready" && read.rows.length === 0 && <p className="so-sheet-line">Nothing needs you.</p>}
      {groups.map(group => <div key={group.label}>
        <p className="so-tri-g">{group.label}</p>
        {group.rows.map(row => <a key={row.id} className="so-ti" href={row.href}>
          <span className="so-ti-t">{row.title}</span>
          <span className="so-ti-m"><KChip word={row.word} tone="ask" />{row.project && <span>{row.project}</span>}<span className="k-num">{row.age}</span></span>
        </a>)}
      </div>)}
      {read.state === "ready" && read.more && <p className="so-sheet-line"><a className="k-link" href={needs.href}>See them all in Tasks</a></p>}
    </div>
  </ShellOverlay>;
}

/** The phone dock: the Needs-you button (always one tap away) beside the screen's one primary, which the page's own
 * `KDock` / `dock()` draws into the same bar. */
export function NeedsDock({ workspace }: { workspace: BrowserWorkspace }) {
  const needs = needsOf(workspace);
  const [sheet, setSheet] = useState<HTMLElement | null>(null);
  const close = useCallback(() => setSheet(null), []);
  // Shown on a sensitive page too: the count and its list are reads, like the rail's own count (no form, no room).
  if (needs.count === 0) return null;
  return <div className="so-dock" data-needs-dock>
    <KDockNeeds count={needs.count} label={needs.label} scope={needs.scope === null ? "All projects" : needs.label} onOpen={event => setSheet(event.currentTarget)} />
    {sheet && <NeedsSheet needs={needs} trigger={sheet} onClose={close} />}
  </div>;
}
