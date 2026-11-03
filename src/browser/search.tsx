/**
 * Search (UI revamp wave B; prototype pages/agents.js overlay + /search): ⌘K or the rail's Search opens one panel that
 * finds tasks, projects, chats, every page and setting by name, and the old names people still type ("Recipes",
 * "Builders"), each saying where it lives now. Enter opens the selected result; "See all results" opens /search, which
 * also looks through older and archived tasks. Reads only.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { BrowserWorkspace } from "../browser-workspace.js";
import { KButton, KChip, KIcon, KInput } from "./kit/index.js";
import { isPhone } from "./kit/behavior.js";
import type { ChipTone } from "../design/kit.js";
import { OPEN_SEARCH_EVENT, ShellOverlay } from "./shell.js";
import "./search.css";

export type SearchEntry = { kind: "task" | "project" | "chat" | "setting" | "page" | "action"; title: string; sub: string; href: string; chip?: { word: string; tone: ChipTone } | null; also?: string; legacy?: boolean; needs?: boolean };

/** Every place a person might look for, by the name they'd type; `also` holds the other words that should find it. */
export const DESTINATIONS: readonly (readonly [title: string, href: string, where: string, also?: string])[] = [
  ["Models", "/settings/models", "Settings → Agents and models", "planner builder reviewer opus sonnet haiku codex model per phase"],
  ["Lead and subagents", "/settings/lead", "Settings → Agents and models", "lead chat subagent"],
  ["Tools", "/settings/tools", "Settings → Agents and models", "mcp"],
  ["Knowledge", "/settings/knowledge", "Settings → Agents and models", "instructions project knowledge"],
  ["Skills", "/settings/skills", "Settings → Agents and models", "skill tests"],
  ["Learning", "/settings/learning", "Settings → Agents and models", "lessons"],
  ["Chat apps", "/settings/alerts#chat-apps", "Settings → Chat apps and alerts", "telegram slack discord teams phone"],
  ["Operating mode", "/mode", "Settings → Approvals and safety", "hands-off mode"],
  ["Approval rules", "/settings/approval", "Settings → Approvals and safety", "automatic approval auto-approve"],
  ["Policy", "/settings/policy", "Settings → Approvals and safety", "protected paths"],
  ["Checks", "/settings/checks", "Settings → Approvals and safety", "tests release check"],
  ["Pull requests", "/settings/pull-requests", "Settings → Projects", "github publish merge"],
  ["People", "/people", "Settings → People and sign-in", "invite roles members"],
  ["Sessions and tokens", "/settings/sessions", "Settings → People and sign-in", "api token"],
  ["Sign-in with a provider", "/settings/sign-in", "Settings → People and sign-in", "sso oauth github google"],
  ["Passwordless", "/settings/passwordless", "Settings → People and sign-in", "password"],
  ["Audit log", "/ledger", "Settings → People and sign-in", "history ledger action ledger"],
  ["Updates", "/settings/updates", "Settings → System", "version upgrade"],
  ["Backups", "/settings/backups", "Settings → System", "backup restore"],
  ["Storage", "/settings/storage", "Settings → System", "disk checkouts"],
  ["Retention", "/settings/retention", "Settings → System"],
  ["Monitoring", "/settings/monitoring", "Settings → System", "traces otel audit stream"],
  ["Data export", "/settings/data", "Settings → System", "export zip"],
  ["Integrations", "/settings/integrations", "Settings → System", "webhooks"],
  ["Spend", "/spend", "Settings → Spend", "monthly limits budget cap cost usage"],
  ["Terminals", "/term", "Agents", "shell console"],
];
/** Old names people still type, and where each thing lives now. */
export const LEGACY: readonly (readonly [title: string, href: string, now: string, also?: string])[] = [
  ["Recipes", "/flows/new", "Flows → New flow", "recipe one-time work"],
  ["Kits", "/kits", "Flows → New flow", "kit starter"],
  ["Limits", "/spend", "Spend → Monthly limits", "budget"],
  ["Live", "/agents", "Agents", "live view peek"],
  ["Builders", "/agents#computers", "Agents → Computers that build", "builder computers runner fleet"],
  ["System", "/agents", "Agents", "agents per phase"],
  ["Board", "/board", "Tasks → Board", "kanban"],
  ["Inbox", "/work?view=needs-you", "Tasks → Needs you", "waiting"],
  ["Queue", "/board?view=order", "Tasks → Board", "order"],
  ["Done", "/work?view=completed", "Tasks → Finished", "finished complete"],
  ["Runs", "/agents", "Agents → Finished", "builds attempts history"],
  ["Activity", "/", "Home", "morning summary"],
  ["Workspace tools", "/menu", "Settings", "menu"],
  ["All settings", "/settings", "Settings"],
];

const TONE: Record<string, ChipTone> = { attention: "needs", ready: "needs", live: "live", done: "done", problem: "failed", muted: "", neutral: "" };

/** Everything this page knows that Search can find. */
export function searchIndex(workspace: BrowserWorkspace): SearchEntry[] {
  const project = (path: string | null) => path === null ? "" : workspace.projects.find(one => one.path === path)?.name ?? path.split(/[\\/]/).filter(Boolean).pop() ?? "";
  return [
    ...workspace.crew.map((item): SearchEntry => {
      const needs = TONE[item.tone] === "needs";
      return { kind: "task", title: item.title, sub: [project(item.project), item.label].filter(Boolean).join(" · "), href: item.resultHref ?? item.href,
        chip: { word: item.label, tone: needs ? "ask" : TONE[item.tone] ?? "" }, also: item.id, needs };
    }),
    ...workspace.projects.map((one): SearchEntry => ({ kind: "project", title: one.name, sub: "Project", href: one.href })),
    ...(workspace.chats ?? []).map((one): SearchEntry => ({ kind: "chat", title: one.title, sub: one.kind === "task" ? "Task chat" : "Project chat", href: one.href })),
    ...workspace.navigation.map((one): SearchEntry => ({ kind: "page", title: one.label, sub: "", href: one.href })),
    { kind: "page", title: "Chat with the lead", sub: "Home", href: "/chat", also: "lead ask" },
    ...DESTINATIONS.map(([title, href, where, also]): SearchEntry => ({ kind: "setting", title, sub: where, href, ...(also ? { also } : {}) })),
    ...LEGACY.map(([title, href, now, also]): SearchEntry => ({ kind: "page", title, sub: `Now ${now}`, href, legacy: true, ...(also ? { also } : {}) })),
  ];
}

const matches = (entry: SearchEntry, words: readonly string[]): boolean => {
  const text = `${entry.title} ${entry.sub} ${entry.also ?? ""}`.toLowerCase();
  return words.every(word => text.includes(word));
};
/** A destination whose own name starts with the words beats one that merely mentions them. */
const rank = (entry: SearchEntry, query: string): number => { const title = entry.title.toLowerCase(); return title.startsWith(query) ? 0 : title.includes(query) ? 1 : 2; };
export const GROUP_NAMES: Record<SearchEntry["kind"], string> = { task: "Tasks", project: "Projects", chat: "Chats", setting: "Settings", page: "Go to", action: "Actions" };

/** The panel's results, in its groups: with no words, what needs you and the main pages; with words, the best of each. */
export function searchResults(workspace: BrowserWorkspace, raw: string): SearchEntry[] {
  const query = raw.trim().toLowerCase();
  const all = searchIndex(workspace);
  const actions: SearchEntry[] = [
    { kind: "action", title: "New task", sub: query ? "Describe the change on the next page" : "Describe a change in a sentence", href: "/tasks/new" },
    { kind: "action", title: "Ask the lead", sub: query ? `“${raw.trim()}”` : "A question about your projects", href: query ? `/chat?draft=${encodeURIComponent(raw.trim())}` : "/chat" },
  ];
  if (query === "") return [...all.filter(one => one.kind === "task" && one.needs).slice(0, 4), ...actions, ...all.filter(one => one.kind === "page" && !one.legacy)];
  const words = query.split(/\s+/);
  const hits = all.filter(one => matches(one, words));
  const places = hits.filter(one => one.kind === "setting" || one.kind === "page").map((one, at) => [one, at] as const)
    .sort((a, b) => rank(a[0], query) - rank(b[0], query) || a[1] - b[1]).map(([one]) => one).slice(0, 5);
  return [...hits.filter(one => one.kind === "task").slice(0, 5), ...hits.filter(one => one.kind === "project").slice(0, 3),
    ...hits.filter(one => one.kind === "chat").slice(0, 3), ...places, ...actions];
}

/** The ⌘K panel. Opens on ⌘K / Ctrl+K and on the rail's or the phone header's Search. */
export function SearchMenu({ workspace }: { workspace: BrowserWorkspace }) {
  const [trigger, setTrigger] = useState<HTMLElement | null | false>(false);
  useEffect(() => {
    if (workspace.sensitive) return;
    const keys = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== "k") return;
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]') && !event.target.closest(".so-cmdk")) return;
      event.preventDefault();
      setTrigger(open => open === false ? (document.activeElement instanceof HTMLElement ? document.activeElement : null) : false);
    };
    const opened = (event: Event) => {
      // The search page is already open: its own box takes the words.
      if (window.location.pathname === "/search") { document.getElementById("search-page-q")?.focus(); return; }
      setTrigger((event as CustomEvent<HTMLElement | null>).detail ?? null);
    };
    window.addEventListener("keydown", keys);
    window.addEventListener(OPEN_SEARCH_EVENT, opened);
    return () => { window.removeEventListener("keydown", keys); window.removeEventListener(OPEN_SEARCH_EVENT, opened); };
  }, [workspace.sensitive]);
  if (workspace.sensitive || trigger === false) return null;
  return <SearchPanel workspace={workspace} trigger={trigger} onClose={() => setTrigger(false)} />;
}

function SearchPanel({ workspace, trigger, onClose }: { workspace: BrowserWorkspace; trigger: HTMLElement | null; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const listId = useId();
  const list = useRef<HTMLDivElement>(null);
  const results = useMemo(() => searchResults(workspace, query), [workspace, query]);
  const shown = results.filter(one => one.kind !== "action").length;
  const total = query.trim() === "" ? 0 : searchIndex(workspace).filter(one => matches(one, query.trim().toLowerCase().split(/\s+/))).length;
  useEffect(() => { setSelected(0); }, [query]);
  useEffect(() => { list.current?.querySelector<HTMLElement>(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" }); }, [selected]);
  const go = (entry: SearchEntry | undefined) => { if (entry) window.location.assign(entry.href); };
  const all = `/search${query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ""}`;
  let last: string | null = null;
  return <ShellOverlay className="so-cmdk" label="Search" trigger={trigger} onClose={onClose}>
    <div className="so-cmdk-h"><KIcon name="search" />
      <label className="k-sr" htmlFor={`${listId}-q`}>Search tasks, projects, chats and settings</label>
      <KInput id={`${listId}-q`} className="so-cmdk-in" type="search" autoFocus autoComplete="off" spellCheck={false} placeholder="Search or type a command"
        role="combobox" aria-expanded="true" aria-controls={listId} aria-activedescendant={results.length > 0 ? `${listId}-${selected}` : undefined}
        value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); if (results.length) setSelected(at => (at + (event.key === "ArrowDown" ? 1 : results.length - 1)) % results.length); }
          if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); go(results[selected]); }
        }} />
      <KButton variant="ghost" sm={!isPhone()} iconOnly="x" label="Close" className="so-cmdk-x" data-k-close="" />
    </div>
    <div className="so-cmdk-list" id={listId} role="listbox" aria-label="Results" ref={list}>
      {query.trim() !== "" && shown === 0 && <p className="so-cmdk-none">Nothing here matches “{query.trim()}”. See all results to look through older tasks too.</p>}
      {results.map((entry, at) => {
        const group = query.trim() === "" && entry.kind === "task" ? "Needs you" : GROUP_NAMES[entry.kind];
        const head = group !== last ? <p className="so-cmdk-g" role="presentation">{group}</p> : null;
        last = group;
        return <div key={`${entry.kind}:${entry.href}:${entry.title}`}>{head}
          <a id={`${listId}-${at}`} className="so-cmdk-i" role="option" aria-selected={at === selected} data-index={at} href={entry.href}
            onMouseMove={() => { if (at !== selected) setSelected(at); }}>
            <span className="so-cmdk-t">{entry.kind === "action" && <KIcon name={entry.title === "New task" ? "plus" : "arrow"} small />}<span>{entry.title}</span></span>
            {entry.chip && <KChip word={entry.chip.word} tone={entry.chip.tone} />}
            {entry.sub && <span className="so-cmdk-s">{entry.sub}</span>}
          </a></div>;
      })}
    </div>
    <div className="so-cmdk-f"><span className="k-desk-only"><kbd className="so-kbd">↑</kbd><kbd className="so-kbd">↓</kbd> move</span><span className="k-desk-only"><kbd className="so-kbd">↵</kbd> open</span>
      <span className="k-grow" /><a className="k-link" href={all}>{total > shown ? `See all ${total} results` : "See all results"}</a></div>
  </ShellOverlay>;
}
