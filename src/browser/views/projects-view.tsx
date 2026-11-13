/** Projects on the kit (src/design/KIT.md): the desk top bar with Add project, then one quiet row per project — the
 * chip only when something waits on you or runs, the row links to the project's page, one action. Add project opens
 * a drawer (a bottom sheet on a phone) with the server's add forms; a clone review a preview minted sits above the
 * list. Opening a project stays the server's POST (the session's project changes there). */
import { useEffect, useRef, useState } from "react";
import type { BrowserProjectRow, BrowserProjectsView } from "../../browser-workspace.js";
import { GuardedHtml } from "../guarded-html.js";
import { PostForm } from "../ui/index.js";
import { KButton, KChip, KCount, KDock, KEmpty, KGroup, KInfoLine, KLinkButton, KNotice, KOverlay, KPageHeader, KRow, KStatus } from "../kit/index.js";
import { threadWhen } from "./task-view.js";

/** In words people use: today, yesterday, or the date, by the one formatter in the viewer's zone. */
function openedWords(iso: string): string {
  const words = threadWhen(iso);
  if (words === "") return "";
  if (/^\d/.test(words)) return "Opened today";
  if (words.startsWith("Yesterday")) return "Opened yesterday";
  return `Opened ${words}`;
}

/** A long path kept readable on one line: its start and its end, the middle elided, split so the end never clips.
 * Cuts by code point (never half a character); a tiny limit keeps the whole path. */
export function middlePath(path: string, max = 44): { head: string; tail: string } {
  const points = Array.from(path);
  if (max < 8) return { head: path, tail: "" };
  // A path that fits still splits, so when the line is narrower only its start gives way and its end stays.
  if (points.length <= max) { const keep = Math.min(points.length, Math.ceil(max * 0.6)); return { head: points.slice(0, points.length - keep).join(""), tail: points.slice(points.length - keep).join("") }; }
  const tailLength = Math.ceil((max - 1) * 0.6);
  return { head: `${points.slice(0, max - 1 - tailLength).join("")}…`, tail: points.slice(points.length - tailLength).join("") };
}

function OpenForm({ path, destination, label }: { path: string; destination: string; label: string }) {
  return <PostForm action="/projects/open">
    <input type="hidden" name="path" value={path} />
    <input type="hidden" name="return" value={destination} />
    <KButton type="submit" sm label={label} />
  </PostForm>;
}

function Row({ row, returnTo, choosing }: { row: BrowserProjectRow; returnTo: string; choosing: boolean }) {
  const path = middlePath(row.shortPath, 36);
  const when = row.open ? "Open now" : row.openedAt === null ? "" : openedWords(row.openedAt);
  // What waits on you: "2 waiting on you" in the soft ask tone (DESIGN.md "Peek chips"), never a solid chip on every row.
  const chip = row.status === null ? null : row.status === "needs" ? <KChip word={`${row.waiting} waiting on you`} tone="ask" /> : <KStatus status={row.status} />;
  return <KRow href={row.href} chip={chip} title={row.name} wait={row.status === "needs"}
    desc={<span className="k-mono" title={row.path}>{path.head}{path.tail}</span>}
    meta={<>{row.summary !== "" && <span>{row.summary ?? "Not scanned"}</span>}{when !== "" && <span>{when}</span>}</>}
    action={choosing || !row.open
      ? <OpenForm path={row.path} destination={returnTo} label={choosing ? "Choose" : "Open"} />
      : <KLinkButton sm href="/tasks/new" label="New task" />} />;
}

export function ProjectsView({ view }: { view: BrowserProjectsView; csrf: string }) {
  const [trigger, setTrigger] = useState<HTMLElement | null>(null);
  const [adding, setAdding] = useState(false);
  const header = useRef<HTMLSpanElement>(null);
  const empty = view.recent.length === 0 && view.available.length === 0;
  // A clone review waiting is the screen's one primary; Add project steps back to outline (and, on a phone, to the
  // header's trailing button, since the dock is the review's).
  const primary = view.add.review === null;
  const open = (event: { currentTarget: HTMLElement }) => { setTrigger(event.currentTarget); setAdding(true); };
  // A refused GitHub link comes back with the drawer open and the reason next to its field.
  useEffect(() => {
    if (!view.add.openOnLoad) return;
    setTrigger(header.current?.querySelector("button") ?? null);
    setAdding(true);
  }, [view.add.openOnLoad]);
  return <div className="w-full" data-kit-page>
    <KPageHeader title={view.choosing ? "New task" : "Projects"} {...(view.choosing ? { ctx: "Choose the project it belongs to" } : {})}
      right={<span ref={header}><KButton variant={primary ? "primary" : "outline"} sm lead="plus" label="Add project" docked={primary} aria-haspopup="dialog" onClick={open} /></span>}
      {...(primary ? {} : { trailing: <KButton variant="ghost" iconOnly="plus" label="Add project" aria-haspopup="dialog" onClick={open} /> })} />
    {(view.problem !== null || view.said !== null) && <div className="px-6 pt-4 phone:px-4">
      {view.problem !== null && <KNotice>{view.problem}</KNotice>}
      {view.said !== null && <KInfoLine>{view.said}</KInfoLine>}
    </div>}
    {view.add.review !== null && <div className="k-doc"><GuardedHtml html={view.add.review} immutable /></div>}
    {view.recent.length > 0 && <section aria-label="Projects" data-project-list="">
      <KGroup label="Projects" count={<KCount n={view.recent.length} />} />
      {view.recent.map(row => <Row key={row.path} row={row} returnTo={view.returnTo} choosing={view.choosing} />)}
    </section>}
    {view.available.length > 0 && <section aria-label="Available" data-project-list="">
      <KGroup label="Available" count={<KCount n={view.available.length} />} />
      {view.available.map(row => <Row key={row.path} row={row} returnTo={view.returnTo} choosing={view.choosing} />)}
    </section>}
    {empty && <KEmpty title="No projects yet." text="A project is a git repository your agents work in. Add one from GitHub or from a folder on this computer."
      action={<KButton sm label="Add project" lead="plus" aria-haspopup="dialog" onClick={open} />} />}
    {adding && <KOverlay kind="drawer" title="Add project" trigger={trigger} onClose={() => setAdding(false)}>
      <GuardedHtml html={view.add.html} immutable />
    </KOverlay>}
    {primary && <KDock><KButton variant="primary" lead="plus" label="Add project" aria-haspopup="dialog" onClick={open} /></KDock>}
  </div>;
}
