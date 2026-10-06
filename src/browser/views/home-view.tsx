/** The Chat landing (console v2): a "Now" strip with one live card per
 * working agent (its task and phase), one row of four numbers, plan-window
 * use instead of spend, then Catch up in tabs. Reads only; every row opens
 * the task, where its actions keep their own rules. */
import { useEffect, useMemo, useState } from "react";
import type { BrowserCatchUpItem, BrowserCatchUpTab, BrowserHome } from "../../browser-workspace.js";
import { cn } from "../components/ui/index.js";
import { HeadlineBadge } from "./status-summary.js";
import { threadWhen } from "./task-view.js";

const TABS: { id: BrowserCatchUpTab; label: string; empty: string }[] = [
  { id: "needs-you", label: "Needs you", empty: "Nothing needs you right now." },
  { id: "ready", label: "Ready", empty: "No results are waiting for review." },
  { id: "running", label: "Running", empty: "Nothing is running." },
  { id: "all", label: "All", empty: "No tasks this week." },
];

/** "4 min", "1 h 12 min": how long an agent has been at it. */
function since(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h${minutes % 60 === 0 ? "" : ` ${minutes % 60} min`}`;
}

/** "just now", "3 min ago", "2 h ago": when the lead last acted. */
function ago(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (!Number.isFinite(minutes) || minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h ago` : Math.floor(hours / 24) === 1 ? "yesterday" : `${Math.floor(hours / 24)} days ago`;
}

const SEEN_KEY = "so-catch-up-seen";
const stamp = (item: BrowserCatchUpItem) => `${item.id}@${item.at}`;
const stored = (): boolean => { try { return window.localStorage.getItem(SEEN_KEY) !== null; } catch { return true; } };
/** What this browser has shown; on a first visit, everything here now counts as seen (no dots until something changes). */
function readSeen(current: readonly BrowserCatchUpItem[]): Set<string> {
  try {
    const stored = window.localStorage.getItem(SEEN_KEY);
    if (stored === null) return new Set(current.map(stamp));
    const parsed: unknown = JSON.parse(stored);
    return new Set(Array.isArray(parsed) ? parsed.filter((one): one is string => typeof one === "string") : []);
  } catch { return new Set(current.map(stamp)); }
}

function inTab(item: BrowserCatchUpItem, tab: BrowserCatchUpTab): boolean {
  return tab === "all" || item.tab === tab;
}

/** `compact`: the narrow Work panel beside the chat, where the Catch up tabs take the full width. */
export function Home({ home, compact = false }: { home: BrowserHome; compact?: boolean }) {
  const counts = useMemo(() => Object.fromEntries(TABS.map(tab => [tab.id, home.catchUp.filter(item => inTab(item, tab.id)).length])) as Record<BrowserCatchUpTab, number>, [home.catchUp]);
  const [tab, setTab] = useState<BrowserCatchUpTab>(() => counts["needs-you"] > 0 ? "needs-you" : counts.ready > 0 ? "ready" : counts.running > 0 ? "running" : "all");
  // Unread (phones): a tab holding a change this browser hasn't shown yet.
  const [seen, setSeen] = useState<Set<string>>(() => readSeen(home.catchUp));
  useEffect(() => {
    const shown = home.catchUp.filter(item => inTab(item, tab)).map(stamp);
    if (shown.every(one => seen.has(one)) && stored()) return;
    const next = new Set([...seen, ...shown]);
    setSeen(next);
    try { window.localStorage.setItem(SEEN_KEY, JSON.stringify([...next].slice(-400))); } catch { /* storage off: dots stay */ }
  }, [tab, home.catchUp]);
  const items = home.catchUp.filter(item => inTab(item, tab));
  return <div className="so-home flex flex-col gap-6 phone:gap-4" data-home>
    <section aria-labelledby="home-now" data-home-now>
      <h2 id="home-now" className="mb-2.5 text-[14px] font-semibold tracking-[-0.01em]">Now</h2>
      {home.lead != null && <p data-home-lead className="mb-2.5 flex min-w-0 items-baseline gap-1.5 text-[13px] leading-snug">
        <span className="shrink-0 font-medium">{home.lead.name ?? "Lead"}:</span>
        {home.lead.href === null ? <span className="min-w-0 truncate">{home.lead.doing}</span>
          : <a href={home.lead.href} className="min-w-0 truncate hover:underline hover:underline-offset-4">{home.lead.doing}</a>}
        <span className="shrink-0 text-muted-foreground">· <time dateTime={home.lead.at} className="tabular-nums">{ago(home.lead.at)}</time></span>
      </p>}
      {home.agents.length === 0
        ? <p className="text-[13px] text-muted-foreground">No agent is working right now.</p>
        : <ul className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2 phone:-mx-4 phone:flex phone:snap-x phone:snap-mandatory phone:scroll-px-4 phone:overflow-x-auto phone:px-4 phone:pb-1 phone:[scrollbar-width:none]">
          {home.agents.map(agent => <li key={agent.runId} data-home-agent={agent.taskId} className="min-w-0 phone:w-[236px] phone:shrink-0 phone:snap-start">
            <a href={agent.href} className="flex h-full min-w-0 flex-col gap-1.5 rounded-[10px] border border-border bg-card px-3.5 py-3 transition-colors hover:border-input hover:bg-[var(--so-raised)] phone:px-3 phone:py-2.5">
              <span className="flex items-center gap-1.5 text-[12px] font-medium text-info"><span aria-hidden="true" className="so-home-live size-1.5 shrink-0 rounded-full bg-info" />{agent.phase}</span>
              <span className="line-clamp-2 text-[13.5px] font-medium leading-snug text-foreground">{agent.title}</span>
              <span className="mt-auto truncate text-[12px] text-muted-foreground">{agent.agent} · <span className="tabular-nums">{since(agent.since)}</span></span>
            </a>
          </li>)}
        </ul>}
    </section>

    <section aria-label="At a glance" data-home-counts>
      <ul className="grid grid-cols-4 divide-x divide-border border-y border-border">
        {home.counts.map(count => <li key={count.key} className="min-w-0" data-home-count={count.key}>
          <a href={count.href} className="flex h-full flex-col gap-1 px-3 py-3 transition-colors hover:bg-[var(--so-raised)] first:pl-0 phone:px-2 phone:py-2.5">
            <span className={cn("font-mono text-[22px] font-semibold leading-none tabular-nums tracking-[-0.02em] phone:text-[20px]", count.key === "waiting" && count.value > 0 && "text-attention")}>{count.value}</span>
            <span className="text-[12px] leading-tight text-muted-foreground">{count.label}</span>
          </a>
        </li>)}
      </ul>
      {home.planUse.length > 0 && <p className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-muted-foreground" data-home-plan aria-label="Plan use">
        {home.planUse.map(one => <span key={`${one.name}-${one.window}`} className="inline-flex items-center gap-1.5" title={one.detail}>
          <span>{one.name} · {one.window}</span>
          <span aria-hidden="true" className="relative inline-block h-1 w-12 overflow-hidden rounded-full bg-muted">
            <span className={cn("absolute inset-y-0 left-0 rounded-full", one.tone === "neutral" ? "bg-foreground" : one.tone === "warning" ? "bg-warning" : "bg-destructive")} style={{ width: `${Math.min(100, Math.max(0, one.percent))}%` }} />
          </span>
          <span className={cn("tabular-nums", one.tone === "warning" && "text-warning", one.tone === "danger" && "text-destructive")}>{Math.round(one.percent)}%</span>
        </span>)}
      </p>}
    </section>

    <section aria-labelledby="home-catch-up" data-home-catch-up>
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 id="home-catch-up" className="text-[14px] font-semibold tracking-[-0.01em]">Catch up</h2>
        <div role="tablist" aria-label="Catch up" className={cn("ml-auto inline-flex h-8 items-center gap-0.5 rounded-xl bg-muted p-0.5 phone:ml-0 phone:h-11 phone:w-full", compact && "ml-0 w-full")}>
          {TABS.map(one => {
            const unread = home.catchUp.some(item => inTab(item, one.id) && !seen.has(stamp(item)));
            return <button key={one.id} type="button" role="tab" aria-selected={tab === one.id} data-catch-up-tab={one.id} onClick={() => setTab(one.id)}
              className={cn("relative inline-flex h-full items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground phone:flex-1 phone:justify-center phone:px-1.5",
                compact && "flex-1 justify-center px-1.5", tab === one.id && "bg-card text-foreground shadow-[var(--so-pill-shadow)]")}>
              {one.label}
              <span className={cn("min-w-[18px] rounded-full px-1.5 text-center font-mono text-[11px] leading-[18px] tabular-nums",
                one.id === "needs-you" && counts["needs-you"] > 0 ? "bg-attention text-on-attention" : "text-muted-foreground",
                // The narrow panel has room for a count only where there is one; the tiles above carry the rest.
                compact && counts[one.id] === 0 && "hidden")}>{counts[one.id]}</span>
              {unread && tab !== one.id && <span data-unread aria-label="New" className="absolute right-1 top-1 size-1.5 rounded-full bg-attention desk:hidden" />}
            </button>;
          })}
        </div>
      </div>
      {items.length === 0 ? <p className="border-t border-border py-4 text-[13px] text-muted-foreground" role="status">{TABS.find(one => one.id === tab)!.empty}</p>
        : <ul role="tabpanel" aria-label={TABS.find(one => one.id === tab)!.label} className="divide-y divide-border border-y border-border">
          {items.slice(0, 12).map(item => <li key={item.id} data-catch-up-item={item.id} className="flex flex-col gap-1 py-2.5 phone:py-2">
            <div className="flex min-w-0 items-start justify-between gap-3">
              <a href={item.href} className="min-w-0 text-[13.5px] font-medium leading-snug hover:underline hover:underline-offset-4 phone:flex phone:min-h-11 phone:items-center">{item.title}</a>
              <HeadlineBadge label={item.label} tone={item.tone} className="mt-px" />
            </div>
            {item.detail !== "" && <p className="text-[12.5px] leading-snug text-muted-foreground [overflow-wrap:anywhere]">{item.detail}</p>}
            {item.action != null && <a href={item.action.href} data-catch-up-action className="mt-0.5 inline-flex h-8 w-fit items-center rounded-md bg-attention px-3 text-[12.5px] font-semibold text-on-attention hover:bg-[var(--so-signal-hover)] phone:h-11 phone:w-full phone:justify-center">{item.action.label}</a>}
            <p className="text-[12px] text-muted-foreground">{item.project !== null && <>{item.project} · </>}<time dateTime={item.at} className="tabular-nums">{threadWhen(item.at)}</time></p>
          </li>)}
        </ul>}
      <a href={home.allHref} className="mt-2 inline-flex text-[12.5px] text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground phone:min-h-11 phone:items-center">All tasks</a>
    </section>
  </div>;
}
