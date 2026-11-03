/**
 * Search ("/search", UI revamp wave B; prototype pages/agents.js `searchView`): the ⌘K panel's "See all results".
 * The tasks the server matched (recent and archived, by title and id), then every place and setting by name, and the
 * old names with where each lives now. Typing narrows the places at once; Enter asks the server for tasks again.
 */
import { useMemo, useState } from "react";
import type { BrowserSearchView, BrowserWorkspace } from "../../browser-workspace.js";
import { KChip, KCount, KEmpty, KIcon, KInput, KPageHeader, KRow } from "../kit/index.js";
import { GROUP_NAMES, searchIndex, type SearchEntry } from "../search.js";

export function SearchView({ view, workspace }: { view: BrowserSearchView; workspace: BrowserWorkspace | null }) {
  const [text, setText] = useState(view.q);
  const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const places = useMemo(() => workspace === null || words.length === 0 ? [] : searchIndex(workspace)
    .filter(one => one.kind !== "task" && words.every(word => `${one.title} ${one.sub} ${one.also ?? ""}`.toLowerCase().includes(word))), [workspace, text]);
  const tasks = view.q.trim().toLowerCase() === text.trim().toLowerCase() ? view.tasks
    : view.tasks.filter(one => words.every(word => `${one.title} ${one.id}`.toLowerCase().includes(word)));
  const kinds: SearchEntry["kind"][] = ["project", "chat", "setting", "page"];
  const box = <form action="/search" method="get" role="search" className="so-search-box" onSubmit={event => { if (text.trim() === "") event.preventDefault(); }}>
    <KIcon name="search" small /><label className="k-sr" htmlFor="search-page-q">Search</label>
    <KInput id="search-page-q" className="so-search-in" type="search" name="q" value={text} onChange={event => setText(event.target.value)}
      placeholder="Search tasks, projects, chats and settings" autoComplete="off" spellCheck={false} autoFocus />
  </form>;
  return <div className="so-search" data-kit-page data-search>
    <KPageHeader title="Search" right={null} />
    <div className="so-search-bar">{box}</div>
    {words.length === 0 ? <KEmpty title="Search everything in this Toolroll." text="Tasks, including finished and archived ones, projects, chats, every page and setting, and the old names of things." />
      : tasks.length === 0 && places.length === 0 ? <KEmpty title={`Nothing matches “${text.trim()}”.`} text="Search looks in task titles and ids, projects, chats, pages and settings." />
      : <div className="so-search-results" aria-live="polite">
        {tasks.length > 0 && <><h2 className="k-grp">Tasks<KCount n={tasks.length} /></h2>
          {tasks.map(one => <KRow key={one.id} href={one.href} chip={<KChip word={one.chip.word} tone={one.chip.tone} />} title={one.title}
            desc={one.archived ? "Archived" : ""} meta={<>{one.project && <span>{one.project}</span>}<span className="k-num">{one.age}</span></>} />)}
          {view.truncated && <p className="so-search-note">Search reads your most recent tasks. <a className="k-link" href="/work">Every task is in Tasks</a>.</p>}</>}
        {kinds.map(kind => {
          const hits = places.filter(one => one.kind === kind);
          return hits.length === 0 ? null : <div key={kind}><h2 className="k-grp">{GROUP_NAMES[kind]}<KCount n={hits.length} /></h2>
            {hits.map(one => <KRow key={`${one.href}:${one.title}`} href={one.href} chip={null} title={one.title} desc={one.sub} />)}</div>;
        })}
      </div>}
  </div>;
}
