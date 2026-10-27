/** Projects, rebuilt with shadcn/ui: one compact row per project — name and
 * what needs attention on the first line, where it lives and when it was
 * last opened on the second, Open on the right. Opening stays the server's
 * POST (the session's project changes there), so every road is a form. */
import { PostForm } from "../ui/index.js";
import { BookOpen, Copy, FolderOpen, GitBranch, GitPullRequest, ListChecks, Plus } from "lucide-react";
import { threadWhen } from "./task-view.js";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { BrowserProjectRow, BrowserProjectsView } from "../../browser-workspace.js";
import { GuardedHtml } from "../guarded-html.js";
import { Badge, Button, Frame, FrameHeader, FramePanel, cn } from "../components/ui/index.js";

function OpenForm({ csrf, path, destination, children, className }: { csrf: string; path: string; destination: string; children: ReactNode; className?: string }) {
  return <PostForm action="/projects/open" className={cn("inline-flex", className)}>
    <input type="hidden" name="path" value={path} />
    <input type="hidden" name="return" value={destination} />
    {children}
  </PostForm>;
}

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

function CopyPath({ path, name }: { path: string; name: string }) {
  const [said, setSaid] = useState<"" | "Copied" | "Couldn't copy">("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useRef(true);
  const sequence = useRef(0);
  useEffect(() => () => { live.current = false; if (timer.current !== null) clearTimeout(timer.current); }, []);
  const show = (words: "Copied" | "Couldn't copy") => {
    if (!live.current) return;
    if (timer.current !== null) clearTimeout(timer.current);
    setSaid(""); // cleared in its own task first, so a repeat is a new announcement
    timer.current = setTimeout(() => {
      if (!live.current) return;
      setSaid(words);
      timer.current = setTimeout(() => { if (live.current) setSaid(""); }, 2000);
    }, 60);
  };
  const copy = () => {
    const mine = ++sequence.current; // only the latest copy may speak
    if (navigator.clipboard === undefined) { show("Couldn't copy"); return; }
    navigator.clipboard.writeText(path).then(() => { if (mine === sequence.current) show("Copied"); }, () => { if (mine === sequence.current) show("Couldn't copy"); });
  };
  return <>
    <button type="button" onClick={copy} aria-label={`Copy ${name}'s path`} title="Copy path"
      className="pointer-events-auto inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground phone:size-11 [&_svg]:size-3.5">
      <Copy aria-hidden="true" />
    </button>
    <span role="status" aria-atomic="true" className="shrink-0 text-caption text-muted-foreground">{said}</span>
  </>;
}

function Row({ row, csrf, returnTo, choosing }: { row: BrowserProjectRow; csrf: string; returnTo: string; choosing: boolean }) {
  // A phone: the name and its actions on the first line, the chips across the full width, then the path.
  return <li className={cn("flex items-center gap-x-4 px-2 py-3 phone:grid phone:grid-cols-[minmax(0,1fr)_auto] phone:gap-x-2 phone:py-1.5", row.open && "bg-accent/40")} data-project={row.path}>
    <FolderOpen className="size-4 shrink-0 text-muted-foreground phone:hidden" aria-hidden="true" />
    <div className="min-w-0 flex-1 phone:contents">
      {/* On a phone each chip and the name are 44px tall to a finger: transparent padding, taken back by a negative
          margin, so the lines stay close; chip lines are spaced so the targets meet without overlapping. On a desk the
          chips' wrapper dissolves (contents), so they share the name's line as before. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 phone:contents">
        {row.open
          ? <a href={returnTo} className="font-semibold hover:underline hover:underline-offset-4 phone:col-start-1 phone:row-start-1 phone:-my-3 phone:justify-self-start phone:py-3 phone:leading-5">{row.name}</a>
          : <OpenForm csrf={csrf} path={row.path} destination={returnTo} className="phone:col-start-1 phone:row-start-1 phone:justify-self-start">
              <button type="submit" className="text-left font-semibold hover:underline hover:underline-offset-4 phone:-my-3 phone:py-3 phone:leading-5">{row.name}</button>
            </OpenForm>}
        <span className="contents phone:col-span-full phone:row-start-2 phone:flex phone:flex-wrap phone:items-center phone:gap-x-2 phone:pointer-events-none phone:gap-y-[26px] phone:pt-3.5 phone:empty:hidden">
          {row.peek?.map(chip => row.open
            ? <a key={chip.label} href={chip.href} className="inline-flex phone:pointer-events-auto phone:-my-3 phone:py-3"><Badge size="chip" dot tone={chip.tone}>{chip.label}</Badge></a>
            : <OpenForm key={chip.label} csrf={csrf} path={row.path} destination={chip.href}>
                <button type="submit" className="inline-flex phone:pointer-events-auto phone:-my-3 phone:py-3"><Badge size="chip" dot tone={chip.tone}>{chip.label}</Badge></button>
              </OpenForm>)}
        </span>
      </div>
      <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1 text-body text-muted-foreground phone:pointer-events-none phone:col-span-full phone:row-start-3 phone:mt-3 phone:leading-[1.35]">
        <span className="flex min-w-0 font-mono text-xs" title={row.path}><span className="truncate">{middlePath(row.shortPath).head}</span><span className="shrink-0">{middlePath(row.shortPath).tail}</span></span><CopyPath path={row.path} name={row.name} />
        {(row.openedAt !== null || row.peek === null) && <span className="shrink-0 whitespace-nowrap">
          {row.openedAt !== null && <>· {openedWords(row.openedAt)}</>}
          {row.peek === null && <>{row.openedAt !== null ? " " : ""}· Not scanned</>}
        </span>}
      </p>
    </div>
    <div className="flex shrink-0 items-center gap-1.5 phone:col-start-2 phone:row-start-1">
      <Button asChild variant="ghost" size="sm" className="phone:w-11 phone:px-0"><a href={row.knowledgeHref} aria-label={`${row.name} knowledge`}><BookOpen /><span className="phone:sr-only">Knowledge</span></a></Button>
      {row.checks && <Button asChild variant="ghost" size="sm" className="phone:w-11 phone:px-0"><a href={row.checks.href} aria-label={`${row.name} checks: ${row.checks.level}`}><ListChecks /><span className="phone:sr-only">Checks · {row.checks.level}</span></a></Button>}
      {row.pullRequests && <Button asChild variant="ghost" size="sm" className="phone:w-11 phone:px-0"><a href={row.pullRequests.href} aria-label={`${row.name} pull requests: ${row.pullRequests.on ? "on" : "off"}`}><GitPullRequest /><span className="phone:sr-only">Pull requests{row.pullRequests.on ? "" : " · Off"}</span></a></Button>}
      {row.open
        ? <Badge tone="success">Open now</Badge>
        : <OpenForm csrf={csrf} path={row.path} destination={returnTo}>
            <Button type="submit" variant="outline" size="sm">{choosing ? "Choose" : "Open"}</Button>
          </OpenForm>}
    </div>
  </li>;
}

function Group({ label, rows, ...rest }: { label: string; rows: BrowserProjectRow[]; csrf: string; returnTo: string; choosing: boolean }) {
  // One Frame per group (after ReUI's Frame): its name on the well, the projects as rows of one paper panel.
  return rows.length === 0 ? null : <section aria-label={label}>
    <Frame>
      <FrameHeader><h2 className="text-sm font-semibold">{label}</h2></FrameHeader>
      <FramePanel className="px-2 py-0"><ul className="divide-y divide-border">{rows.map(row => <Row key={row.path} row={row} {...rest} />)}</ul></FramePanel>
    </Frame>
  </section>;
}

export function ProjectsView({ view, csrf }: { view: BrowserProjectsView; csrf: string }) {
  const shared = { csrf, returnTo: view.returnTo, choosing: view.choosing };
  const empty = view.recent.length === 0 && view.available.length === 0;
  return <div className="flex w-full flex-col gap-5 phone:gap-3">
    <header className="flex flex-wrap items-center gap-3">
      <div className="min-w-0 flex-1">
        <h1 className="text-display tracking-tight phone:text-[22px]">{view.choosing ? "New task" : "Projects"}</h1>
        {view.choosing && <p className="mt-1 text-sm text-muted-foreground">Choose the project it belongs to.</p>}
      </div>
      {!empty && <Button asChild variant="outline" size="sm"><a href="#add-project"><Plus />Add project</a></Button>}
    </header>

    {view.problem !== null && <p role="alert" className="rounded-md bg-destructive-soft px-3 py-2 text-sm text-destructive">{view.problem}</p>}

    <Group label="Recent" rows={view.recent} {...shared} />
    <Group label="Available" rows={view.available} {...shared} />

    <section id="add-project" className="flex scroll-mt-4 flex-col gap-3 border-t border-border pt-5 phone:gap-2 phone:pt-3">
      <h2 className="text-base font-semibold">{empty ? "Add your first project" : "Add a project"}</h2>
      {(view.add.browse !== null || view.add.github !== null) && <div className="flex flex-wrap gap-2">
        {view.add.browse !== null && <Button asChild variant="outline"><a href={view.add.browse}><FolderOpen />Choose a folder</a></Button>}
        {view.add.github !== null && <Button asChild variant="outline"><a href={view.add.github}><GitBranch />Add from GitHub</a></Button>}
      </div>}
      <GuardedHtml html={view.add.html} immutable className="so-project-add" />
    </section>
  </div>;
}
