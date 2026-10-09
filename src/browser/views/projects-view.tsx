/** Projects, rebuilt with shadcn/ui: one compact row per project — name and
 * what needs attention on the first line, where it lives and when it was
 * last opened on the second, Open on the right. Opening stays the server's
 * POST (the session's project changes there), so every road is a form. */
import { PostForm } from "../ui/index.js";
import { BookOpen, FolderOpen, GitBranch, GitPullRequest, ListChecks, Plus } from "lucide-react";
import { threadWhen } from "./task-view.js";
import type { ReactNode } from "react";
import type { BrowserProjectRow, BrowserProjectsView } from "../../browser-workspace.js";
import { GuardedHtml } from "../guarded-html.js";
import { Badge, Button, badgeVariants, cn } from "../components/ui/index.js";

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
            ? <a key={chip.label} href={chip.href} className="inline-flex phone:pointer-events-auto phone:-my-3 phone:py-3"><span className={badgeVariants({ tone: chip.tone })}>{chip.label}</span></a>
            : <OpenForm key={chip.label} csrf={csrf} path={row.path} destination={chip.href}>
                <button type="submit" className="inline-flex phone:pointer-events-auto phone:-my-3 phone:py-3"><span className={badgeVariants({ tone: chip.tone })}>{chip.label}</span></button>
              </OpenForm>)}
        </span>
      </div>
      <p className="mt-0.5 truncate text-[13px] text-muted-foreground phone:pointer-events-none phone:col-span-full phone:row-start-3 phone:mt-1.5 phone:leading-[1.35]" title={row.path}>
        <span className="font-mono text-xs">{row.shortPath}</span>
        {row.openedAt !== null && <> · {openedWords(row.openedAt)}</>}
        {row.peek === null && <> · Not scanned</>}
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
  return rows.length === 0 ? null : <section aria-label={label} className="flex flex-col gap-2">
    <h2 className="text-sm font-semibold text-muted-foreground">{label}</h2>
    <div className="border-y border-border">
      <ul className="divide-y divide-border">{rows.map(row => <Row key={row.path} row={row} {...rest} />)}</ul>
    </div>
  </section>;
}

export function ProjectsView({ view, csrf }: { view: BrowserProjectsView; csrf: string }) {
  const shared = { csrf, returnTo: view.returnTo, choosing: view.choosing };
  const empty = view.recent.length === 0 && view.available.length === 0;
  return <div className="flex w-full flex-col gap-5 phone:gap-3">
    <header className="flex flex-wrap items-center gap-3">
      <div className="min-w-0 flex-1">
        <h1 className="text-[26px] font-semibold leading-tight tracking-tight phone:text-[22px]">{view.choosing ? "New task" : "Projects"}</h1>
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
