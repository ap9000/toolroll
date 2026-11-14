/**
 * Work ("/", the one-workspace plan S2a): the list and the selected task on one screen. The list leads with what needs
 * you, grouped Decide / Review / Unblock (every ask Home admitted: tasks, held publications, flow cards, setup steps),
 * then Running, Queued and Done; segments narrow it (Needs you · All · Running · Queued · Done), all real addresses. At a
 * desk a row opens beside the list, in place (`?task=`); from 901 to 1149px wide it opens as a drawer over the list; on
 * a phone (900px and narrower) a row is a link to the task's own page.
 *
 * The panel reads the selected task through the task's own page (`/t/:id` as data, a prefetch read: never minted), so
 * that page's own admission decides what this person may see, never Work's list. It leads with the state, the outcome,
 * the caveat and the one act. Acts in the panel keep the approval rules (plan criteria 1-6): the terms on screen are
 * pinned, read again before the press and compared (anything moved posts nothing and says so), the post carries exactly
 * those terms with no password field, a press whose selection moved on reports against its own task, and an act that
 * asks for a password or SSO is a link that loads the task page as its own document.
 */
import { useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { BrowserHomeAsk, BrowserHomeRow, BrowserTaskRow, BrowserTaskView, BrowserWorkspace, BrowserWorkView, WorkNeedsGroup } from "../../browser-workspace.js";
import { KButton, KChip, KComposer, KCount, KDock, KEmpty, KGroup, KLinkButton, KLinkSeg, KNotice, KRadios, KRow, pressedByPerson } from "../kit/index.js";
import { FormToken } from "../ui/index.js";
import { WORKSPACE_NUDGE } from "../live-task.js";
import { keyed } from "../mutation-key.js";
import { ACT_TIMEOUT_MS, REDRAW_HOLD_MS, selectionRead, sentence, taskViewOf } from "../act.js";
import { HomeApproval, SELECTION_SETTLE_MS } from "./home-approval.js";
import { ShellOverlay } from "../shell.js";
import { RestoreAct, TaskBoard, ToolsMenu } from "./tasks-view.js";
import "./home.css";
import "./work.css";

const nudge = () => window.dispatchEvent(new CustomEvent(WORKSPACE_NUDGE));
const matches = (query: string): boolean => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
/** One column: a row is a link to the task's own page. */
export const WORK_ONE_COLUMN = "(max-width: 900px)";
/** The panel opens as a drawer over the list. */
export const WORK_DRAWER = "(max-width: 1149px)";

function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => matches(query));
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(query);
    const sync = () => setOn(list.matches);
    sync();
    list.addEventListener?.("change", sync);
    return () => list.removeEventListener?.("change", sync);
  }, [query]);
  return on;
}

/** The words a refusal page said, read from its HTML (the console's refusals are pages, not JSON). */
async function refusalWords(response: Response): Promise<string> {
  try {
    const text = await response.text();
    const doc = new DOMParser().parseFromString(text, "text/html");
    const said = doc.querySelector(".problem")?.textContent?.trim();
    return said ? `Couldn’t answer: ${said}. Nothing changed.` : "Couldn’t answer. Nothing changed.";
  } catch { return "Couldn’t answer. Nothing changed."; }
}

/** An agent's question, answered in place: the options as radio cards, Answer is one click (the same act as its page). */
function Question({ row }: { row: BrowserHomeRow }) {
  const question = row.question!;
  const csrf = useContext(FormToken);
  const [choice, setChoice] = useState(question.options.find(one => one.recommended)?.id ?? question.options[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answer = async () => {
    if (busy || done || choice === "") return;
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/d/${question.id}/answer`, { method: "POST", credentials: "same-origin", headers: keyed({}), body: new URLSearchParams({ csrf, choice }), signal: AbortSignal.timeout(15_000) });
      if (!response.ok) { setError(await refusalWords(response)); return; }
      setDone(true);
      // The row leaves once the page reads itself again.
      window.setTimeout(nudge, 500);
    } catch {
      setError("Couldn’t reach Toolroll. Nothing changed; try again.");
    } finally { setBusy(false); }
  };
  return <>
    <h2 className="so-open-t">{question.text}</h2>
    {question.recap && <p className="so-open-x">{question.recap}</p>}
    <KRadios name={`answer-${question.id}`} legend="Choose one" current={choice} onChange={setChoice}
      items={question.options.map(one => ({ value: one.id, label: one.label, text: one.consequence, ...(one.recommended ? { tag: <KChip word="Recommended" dot={false} /> } : {}) }))} />
    <div className="k-acts">
      <KButton variant="primary" label={done ? "Answered" : "Answer"} busy={busy ? "Sending…" : false} onClick={() => { void answer(); }} aria-disabled={done ? true : undefined} />
      <KLinkButton variant="ghost" label="Open the question" href={`/d/${question.id}`} />
    </div>
    {error && <KNotice>{error}</KNotice>}
  </>;
}

/** A release, a flow card or a setup step is never acted on in Work: its line and the one link to its own page. */
const OWN_PAGE: ReadonlySet<BrowserHomeAsk> = new Set(["release", "flow", "setup"]);
/** Each ask's chip under Needs you, and the word its row's act says. */
const ASK_CHIP: Readonly<Record<BrowserHomeAsk, string>> = { release: "Release", approve: "Plan", answer: "Question", flow: "Flow", wrong: "Failed", review: "Result", setup: "Setup", other: "Needs you" };
const ASK_ACT: Readonly<Record<BrowserHomeAsk, string>> = { release: "Review", approve: "Approve", answer: "Answer", flow: "Open", wrong: "Open", review: "Review", setup: "Open", other: "Open" };

/** One row of the list: a waiting ask (Home's row) or a task (the Tasks list's row). */
type Item = { id: string; title: string; href: string; meta: string; reason: string | null; chip: { word: string; tone: "" | "needs" | "ask" | "live" | "done" | "failed" }; act: string;
  home: BrowserHomeRow | null; task: BrowserTaskRow | null };
type Section = { key: string; label: string; count: number; items: Item[] };

const metaOf = (project: string | null, age: string): string => [project, age].filter(Boolean).join(" · ");
const homeItem = (row: BrowserHomeRow): Item => ({ id: row.id, title: row.title, href: row.href, meta: metaOf(row.project, row.age), reason: row.reason,
  chip: { word: ASK_CHIP[row.ask ?? "other"], tone: "needs" }, act: ASK_ACT[row.ask ?? "other"], home: row, task: null });
const taskItem = (row: BrowserTaskRow, act: string): Item => ({ id: row.id, title: row.title, href: row.href, meta: metaOf(row.project, row.age), reason: null,
  chip: row.word, act, home: null, task: row });

/** Below the Needs-you groups: running, queued, done or stopped (by the row's status rank, as the Tasks list placed them). */
const REST: readonly { key: string; label: string; ranks: readonly number[]; act: string }[] = [
  { key: "running", label: "Running", ranks: [0, 1], act: "Watch" }, { key: "queued", label: "Queued", ranks: [2], act: "Open" },
  { key: "done", label: "Done", ranks: [3], act: "Open" }, { key: "stopped", label: "Stopped", ranks: [4], act: "Open" },
];

/** The sections this view shows: All leads with Needs you, then the rest; Needs you is its groups; any other view is
 * the list's own rows. */
export function sectionsOf(view: BrowserWorkView, gone: ReadonlySet<string>): Section[] {
  const current = view.list.tabs.find(tab => tab.active)?.key ?? "all";
  const needs: Section[] = view.needs.map(group => {
    const items = group.rows.filter(row => !gone.has(row.id)).map(homeItem);
    return { key: group.key, label: group.label, count: Math.max(0, group.count - (group.rows.length - items.length)), items };
  }).filter(section => section.items.length > 0 || section.count > 0);
  if (current === "needs-you") return needs;
  if (current !== "all") {
    const rows = view.list.rows.filter(row => !gone.has(row.id));
    return rows.length === 0 ? [] : [{ key: current, label: view.list.tabs.find(tab => tab.active)?.label ?? "", count: rows.length,
      items: rows.map(row => taskItem(row, row.ask === "decide" ? "Approve" : row.ask === "review" ? "Review" : REST.find(one => one.ranks.includes(row.rank))?.act ?? "Open")) }];
  }
  // A row that waits on you is listed once, under its Needs-you group (past the rows listed there, its "more" link).
  const waiting = new Set(view.needs.flatMap(group => group.rows.map(row => row.id)));
  const rows = view.list.rows.filter(row => !gone.has(row.id) && !waiting.has(row.id) && row.ask === null);
  return [...needs, ...REST.map(one => {
    const items = rows.filter(row => one.ranks.includes(row.rank)).map(row => taskItem(row, one.act));
    return { key: one.key, label: one.label, count: items.length, items };
  }).filter(section => section.items.length > 0)];
}

/** The task a link names (`?task=`), when it isn't a row on screen: read through its own page like any other. */
const namedItem = (id: string): Item => ({ id, title: id, href: `/t/${encodeURIComponent(id)}`, meta: "", reason: null, chip: { word: "", tone: "" }, act: "Open", home: null, task: null });
const selectedFromUrl = (): string | null => typeof window === "undefined" ? null : new URL(window.location.href).searchParams.get("task");
/** The address with the selection in it (replaced, never pushed: Back leaves Work, as it always did). */
function keepSelection(id: string | null): void {
  const url = new URL(window.location.href);
  if (id === null) url.searchParams.delete("task"); else url.searchParams.set("task", id);
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
}

/** What happened to an act whose selection had moved on: said once above the list, against its own task. */
type Said = { title: string; words: string } | null;

export function WorkView({ view }: { view: BrowserWorkView }) {
  const oneColumn = useMedia(WORK_ONE_COLUMN);
  const drawer = useMedia(WORK_DRAWER) && !oneColumn;
  // Rows acted on here leave at once; Work's own re-read then agrees (or puts one back if it still waits).
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const [leaving, setLeaving] = useState<string | null>(null);
  const [said, setSaid] = useState<Said>(null);
  useEffect(() => { setGone(new Set()); }, [view]);
  const sections = sectionsOf(view, gone);
  const items = sections.flatMap(section => section.items);
  const [selected, setSelected] = useState<string | null>(() => selectedFromUrl() ?? null);
  // The drawer opens only for a row the person chose (or one a link named); a wide desk always shows the panel.
  const [open, setOpen] = useState<boolean>(() => selectedFromUrl() !== null);
  const list = useRef<HTMLDivElement>(null);
  const choose = (id: string, opened = true) => { setSelected(id); setSaid(null); if (opened) { setOpen(true); keepSelection(id); } };
  // A wide desk shows the first row when nothing is chosen, and the first again when a re-read took the chosen one away.
  const shownId = selected !== null && (items.some(one => one.id === selected) || selected === selectedFromUrl()) ? selected : drawer || oneColumn ? null : items[0]?.id ?? null;
  const shown = shownId === null ? null : items.find(one => one.id === shownId) ?? namedItem(shownId);
  const done = (id: string, words: string) => {
    const at = items.findIndex(one => one.id === id);
    const next = items.filter(one => one.id !== id)[Math.max(0, at)] ?? null;
    setSaid({ title: items[at]?.title ?? id, words });
    setLeaving(id);
    setSelected(next?.id ?? null);
    keepSelection(next?.id ?? null);
    if (drawer) setOpen(false);
    // Work re-reads only once the row has gone: a read that landed first would clear `gone` and the row would then stay
    // hidden even where the task still waits on the person for something else.
    window.setTimeout(() => { setGone(previous => new Set([...previous, id])); setLeaving(current => current === id ? null : current); nudge(); }, reducedMotion() ? 0 : LEAVE_MS);
  };
  const settled = (title: string, words: string) => { setSaid({ title, words }); };
  const move = (step: number) => {
    const at = items.findIndex(one => one.id === shownId);
    const next = items[Math.max(0, Math.min(items.length - 1, at + step))];
    if (!next) return;
    choose(next.id);
    list.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(next.id)}"] .k-row-t`)?.focus();
  };
  const current = view.list.tabs.find(tab => tab.active)?.key ?? "all";
  // Needs you · All · Running · Queued · Done (Ready stays an address: Needs you's Review group holds it).
  const segments = SEGMENTS.flatMap(([key, label]) => {
    const tab = view.list.tabs.find(one => one.key === key);
    return tab === undefined ? [] : [{ key, label, href: tab.href, count: <KCount n={key === "needs-you" ? view.needsCount : tab.count} ink={key === "needs-you"} /> }];
  });
  const panel = shown === null ? null
    : <WorkPanel key={shown.id} item={shown} onDone={done} onSettled={settled} onClose={drawer ? () => setOpen(false) : null} />;
  const board = view.list.layout === "board";
  return <div className="so-home so-work" data-kit-page data-work data-work-view={current}>
    <header className="so-work-h">
      <div className="so-work-hl"><h1 className="so-work-t">Work</h1><span className="so-work-p">{view.projectName}</span></div>
      <div className="so-work-tools"><KLinkSeg label="Show" current={board ? "" : current} items={segments} />
        <ToolsMenu view={view.list} more={[board ? { label: "List", href: view.list.layouts.list } : { label: "Board", href: view.list.layouts.board }]} /></div>
    </header>
    {view.setup && <p className="so-work-setup" data-work-setup><a className="k-link" href={view.setup}>Finish setup</a></p>}
    <div className={`so-triage so-work-split${shown !== null && !drawer && !oneColumn ? " has-panel" : ""}`}>
      <div className="so-tri-list so-work-list" ref={list} aria-label="Tasks" onKeyDown={event => {
        if (oneColumn || board) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); move(event.key === "ArrowDown" ? 1 : -1); }
      }}>
        {said && <p className="so-home-approved" role="status" data-work-said><span className="so-work-said-t">{said.title}</span> {said.words}</p>}
        {view.empty ? <KEmpty title={view.empty.title} text={view.empty.text} action={<KLinkButton sm variant="primary" lead="plus" label="New task" href={view.list.newTask.href} />} />
          : board ? <TaskBoard view={view.list} match={() => true} />
          : sections.length === 0 ? <KEmpty title={current === "needs-you" ? "Nothing needs you." : view.list.empty?.text ?? "Nothing here."}
            {...(view.list.empty?.action && current !== "needs-you" ? { action: <KLinkButton sm label={view.list.empty.action.label} href={view.list.empty.action.href} /> } : {})} />
          : sections.map(section => <section key={section.key} className="so-work-grp" aria-label={`${section.label}, ${section.count}`} data-group={section.key}>
            <KGroup label={section.label} count={<KCount n={section.count} ink={isNeeds(section.key)} />} />
            {section.items.map(item => <div key={item.id} data-row={item.id} data-selected={item.id === shownId && !oneColumn ? "" : undefined}
              className={`so-work-row${item.id === leaving ? " so-ti-leave" : ""}`}
              onClick={event => {
                const target = event.target as HTMLElement;
                if (oneColumn || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0 || target.closest("form, button")) return;
                // The row is one choice: its title and its act both select it, in place.
                if (target.closest("a")) event.preventDefault();
                choose(item.id);
              }}>
              <KRow href={item.href} chip={<KChip word={item.chip.word} tone={item.chip.tone} />} title={item.title} wait={item.home !== null}
                desc={item.reason ?? item.home?.line ?? item.task?.detail ?? ""} meta={item.meta}
                action={item.task?.tidy?.label === "Restore" ? <RestoreAct tidy={item.task.tidy} /> : <KLinkButton sm label={item.act} href={item.href} tabIndex={-1} />} />
            </div>)}
            {section.count > section.items.length && current !== "all" && view.list.pages.next === null && <p className="so-work-more">{section.count - section.items.length} more</p>}
            {isNeeds(section.key) && section.count > section.items.length && current === "all" && <a className="so-tri-more k-link" href={view.list.tabs.find(tab => tab.key === "needs-you")?.href ?? "/?view=needs-you"}>{section.count - section.items.length} more</a>}
          </section>)}
        {!board && current === "completed" && view.list.archived && !view.list.archived.active && <p className="k-foot so-work-pages"><a href={view.list.archived.href}>Archived tasks · {view.list.archived.count}</a></p>}
        {!board && (view.list.pages.first || view.list.pages.next) && <p className="k-foot so-work-pages">
          {view.list.pages.first && <a href={view.list.pages.first}>First page</a>}{view.list.pages.first && view.list.pages.next && " · "}{view.list.pages.next && <a href={view.list.pages.next} rel="next">Next page</a>}
        </p>}
      </div>
      {!oneColumn && !drawer && <section className="so-tri-open so-work-panel" aria-label="Selected task" aria-live="polite" data-work-panel>{panel ?? <p className="so-open-x so-work-none">Choose a task to see it here.</p>}</section>}
    </div>
    {drawer && open && panel !== null && <WorkDrawer onClose={() => setOpen(false)}>{panel}</WorkDrawer>}
    <KDock><KLinkButton variant="primary" lead="plus" label="New task" href={view.list.newTask.href} /></KDock>
  </div>;
}

/** The segments, in Work's order and words. */
const SEGMENTS: readonly (readonly [key: string, label: string])[] = [["needs-you", "Needs you"], ["all", "All"], ["running", "Running"], ["queued", "Queued"], ["completed", "Done"]];
const isNeeds = (key: string): key is WorkNeedsGroup => key === "decide" || key === "review" || key === "unblock";
/** How long an acted-on row takes to leave the list (none with reduced motion). */
const LEAVE_MS = 200;
const reducedMotion = (): boolean => matches("(prefers-reduced-motion: reduce)");

/** 901-1149px: the panel over the list (Escape, the close button or Back closes it; the list stays where it was). */
function WorkDrawer({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const [trigger] = useState<HTMLElement | null>(() => document.activeElement instanceof HTMLElement ? document.activeElement : null);
  return <ShellOverlay className="so-work-drawer" label="Selected task" trigger={trigger} onClose={onClose}>
    <div data-view="work" className="so-work-drawer-v"><div className="so-home so-work so-work-drawer-b" data-work-panel>{children}</div></div>
  </ShellOverlay>;
}

/** The selected item: what it is, and the one act that resolves it. A plan waiting for approval is read and approved here
 * (home-approval.tsx); a question is answered here; a release, a flow card or a setup step opens its own page; anything
 * else is the task as its own page reads it. */
function WorkPanel({ item, onDone, onSettled, onClose }: { item: Item; onDone: (id: string, words: string) => void; onSettled: (title: string, words: string) => void; onClose: (() => void) | null }) {
  const row = item.home;
  const close = onClose === null ? null : <KButton variant="ghost" sm iconOnly="x" label="Close" onClick={onClose} />;
  const kicker = (full: boolean) => <div className="so-open-k"><span>{item.meta}</span><span className="k-grow" />{full && <a className="k-link" href={item.href} data-work-open>Open full page</a>}{close}</div>;
  if (row !== null && OWN_PAGE.has(row.ask ?? "other")) return <>
    {kicker(false)}
    <h2 className="so-open-t">{row.title}</h2>
    <p className="so-open-chip"><KChip word="Needs you" tone="needs" /><span>{ASK_CHIP[row.ask ?? "other"]}</span></p>
    {row.line && <p className="so-open-x">{row.line}</p>}
    {row.action && <div className="k-acts"><KLinkButton variant="primary" label={row.action.label} href={row.action.href} /></div>}
  </>;
  if (row?.question) return <>{kicker(true)}<p className="so-open-of">{row.title}</p><Question key={row.question.id} row={row} /></>;
  if (row?.ask === "approve") return <>{kicker(true)}<h2 className="so-open-t">{row.title}</h2>
    <HomeApproval row={row} onApproved={id => onDone(id, "Approved.")} onChanged={nudge} onSettled={(one, words) => onSettled(one.title, words)} /></>;
  return <TaskPanel item={item} kicker={kicker(true)} onDone={onDone} onSettled={onSettled} />;
}

type Read = { phase: "reading" } | { phase: "shown"; workspace: BrowserWorkspace } | { phase: "unread" };

/** The selected task, read through its own page once the selection settles (a prefetch read: never minted). */
function useTaskRead(href: string): [Read, () => Promise<BrowserWorkspace | null | undefined>] {
  const [read, setRead] = useState<Read>({ phase: "reading" });
  const generation = useRef(0);
  useEffect(() => {
    const mine = ++generation.current;
    setRead({ phase: "reading" });
    const timer = window.setTimeout(() => {
      void selectionRead(href).then(workspace => { if (mine === generation.current) setRead(workspace === null || taskViewOf(workspace) === null ? { phase: "unread" } : { phase: "shown", workspace }); });
    }, SELECTION_SETTLE_MS);
    return () => { window.clearTimeout(timer); generation.current++; };
  }, [href]);
  const again = async () => {
    const mine = ++generation.current;
    const workspace = await selectionRead(href);
    if (mine !== generation.current) return undefined;
    setRead(workspace === null || taskViewOf(workspace) === null ? { phase: "unread" } : { phase: "shown", workspace });
    return workspace;
  };
  return [read, again];
}

/** The task's status in words: its headline and one sentence. */
function stateOf(view: BrowserTaskView): { headline: string; sentence: string } | null {
  const card = view.status;
  if (card == null) return null;
  return { headline: card.status.headline || card.label, sentence: card.status.sentence };
}

/** A task the person selected: the state, the outcome, the caveat and the one act, then the plan in one line. */
function TaskPanel({ item, kicker, onDone, onSettled }: { item: Item; kicker: ReactNode; onDone: (id: string, words: string) => void; onSettled: (title: string, words: string) => void }) {
  const [read, again] = useTaskRead(item.href);
  if (read.phase === "reading") return <>{kicker}<h2 className="so-open-t">{item.title}</h2><p className="so-open-x so-home-reading">Reading the task…</p></>;
  if (read.phase === "unread") return <>{kicker}<h2 className="so-open-t">{item.title}</h2>
    <p className="so-open-x" data-work-unread>This task can’t be shown here. It may have moved out of your projects.</p>
    <div className="k-acts"><KLinkButton variant="primary" label="Open the task" href={item.href} data-full-load="" /></div></>;
  const view = taskViewOf(read.workspace)!;
  const state = stateOf(view);
  const result = view.result?.current === true && view.historical == null ? view.result.selected : null;
  const outcome = result?.panel?.outcome ?? null;
  // Every machine-reported failure and caveat is on screen before the act (plan criterion 5).
  const caveats = [result?.problem ?? null, result?.mismatch?.headline ?? null, ...(result?.panel?.attention ?? []).slice(0, 2), view.failure?.line ?? null]
    .filter((one, at, all): one is string => one !== null && one !== "" && all.indexOf(one) === at);
  const checks = result?.checks ?? null;
  const live = view.work?.live === true;
  const act = result !== null
    ? <ResultDecision item={item} workspace={read.workspace} again={again} onDone={onDone} onSettled={onSettled} />
    : live ? <div className="k-acts"><KLinkButton variant="primary" label="Watch the work" href={`${item.href}?tab=activity`} data-work-watch="" /></div>
    : view.status?.action ? <div className="k-acts"><KLinkButton variant="primary" label={view.status.action.label} href={view.status.action.href} {...(read.workspace.sensitive ? { "data-full-load": "" } : {})} /></div>
    : null;
  return <div className="so-work-task" data-work-task={view.id}>
    {kicker}
    <h2 className="so-open-t">{view.title}</h2>
    {state && <p className="so-open-chip" data-work-state><KChip word={state.headline} tone={toneOf(view)} /><span>{state.sentence}</span></p>}
    {outcome && <p className="so-open-x" data-work-outcome>{outcome}</p>}
    {view.progress?.line && view.progress.line !== state?.sentence && <p className="so-open-x" data-work-progress>{view.progress.line}</p>}
    {caveats.map(one => <p key={one} className="so-work-caveat" data-work-caveat>{one}</p>)}
    {checks && <p className={`so-work-checks${checks.problem ? " is-problem" : ""}`} data-work-checks>{checks.detail}</p>}
    {act}
    {view.plan?.lead && <section className="so-work-sec" aria-label="Plan"><h3 className="so-work-sec-h">Plan</h3><p className="so-open-x">{view.plan.lead}</p></section>}
    {view.progress?.steps && view.progress.steps.length > 0 && <ol className="so-work-steps" aria-label="Steps">{view.progress.steps.map((step, at) =>
      <li key={at} data-step-state={step.state}>{step.title}</li>)}</ol>}
  </div>;
}

/** The chip's tone for a task's state: blue only running, green only finished, red only failed, ink for a wait. */
function toneOf(view: BrowserTaskView): "" | "needs" | "live" | "done" | "failed" {
  const tone = view.status?.tone;
  return tone === "live" ? "live" : tone === "done" ? "done" : tone === "problem" ? "failed" : tone === "attention" || tone === "ready" ? "needs" : "";
}

/** The result's acts as the panel pins them: everything a press needs and everything the person read, from one read. */
export type ResultSnapshot = {
  taskId: string; run: number; revision: string;
  /** Accept (and finish): the task's complete route, the exact receipt read, and whether it also records the acceptance. */
  accept: { action: string; receipt: string; withAcceptance: boolean; label: string } | null;
  /** Send back: the run's comment route with the saved notes it seals, the diff it is about and this read's request token. */
  sendBack: { action: string; batch: string; source: string; request: string } | null;
};

const RECEIPT = /^[0-9a-f]{16,128}$/;
const REQUEST = /^[0-9a-f]{32}$/;
/**
 * The result acts a read holds, or null. Accept is offered only where the result page itself would complete it in one
 * press: the current result, accepting is its one act and it is ready, no reason is asked, no check of the person's own
 * is open, and the page asks no password. The routes must be exactly this task's and this run's: a read never chooses
 * where a press posts.
 */
export function resultSnapshotOf(workspace: BrowserWorkspace | null): ResultSnapshot | null {
  const view = taskViewOf(workspace);
  const loaded = view?.result ?? null;
  if (view === null || loaded === null || !loaded.current || view.historical != null || workspace!.sensitive) return null;
  const selected = loaded.selected;
  const run = selected.build;
  if (run === null) return null;
  const complete = selected.complete;
  const openChecks = (selected.panel?.youCheck?.items.length ?? 0) > 0;
  const acceptOk = complete !== null && complete.action === `/t/${encodeURIComponent(view.id)}/complete` && complete.run === run && RECEIPT.test(complete.receipt)
    && selected.acts.primary === "accept" && selected.decision?.ready === true && (complete.accept?.note ?? null) === null && !openChecks;
  const back = selected.panel?.sendBack ?? null;
  const sendOk = back != null && back.action === `/r/${run}/comment` && REQUEST.test(back.request) && (selected.acts.primary === "request-changes" || selected.acts.secondary === "request-changes");
  if (!acceptOk && !sendOk) return null;
  return {
    taskId: view.id, run, revision: loaded.revision,
    accept: acceptOk ? { action: complete!.action, receipt: complete!.receipt, withAcceptance: complete!.accept != null, label: selected.decision?.label ?? "Accept" } : null,
    sendBack: sendOk ? { action: back!.action, batch: back!.batch, source: back!.source, request: back!.request } : null,
  };
}

/** Whether two snapshots are the same terms: the same task, run, result and routes (the request token may be fresh). */
export function sameTerms(a: ResultSnapshot, b: ResultSnapshot | null): boolean {
  return b !== null && a.taskId === b.taskId && a.run === b.run && a.revision === b.revision
    && a.accept?.action === b.accept?.action && a.accept?.receipt === b.accept?.receipt && a.accept?.withAcceptance === b.accept?.withAcceptance
    && a.sendBack?.action === b.sendBack?.action && a.sendBack?.batch === b.sendBack?.batch && a.sendBack?.source === b.sendBack?.source;
}

type ActAnswer = { kind: "answer"; outcome: "done" | "refused"; words: string } | { kind: "elsewhere" } | { kind: "lost" };
/** One post asking for its answer in place (`x-toolroll-act: in-place`). Anything that is not exactly that answer is
 * "elsewhere" (the task page loads as a document); no answer at all is "lost". */
async function postAct(action: string, body: URLSearchParams): Promise<ActAnswer> {
  let response: Response;
  try {
    response = await fetch(action, { method: "POST", credentials: "same-origin", redirect: "manual", body,
      headers: keyed({ "x-toolroll-act": "in-place", accept: "application/json" }), signal: AbortSignal.timeout(ACT_TIMEOUT_MS) });
  } catch { return { kind: "lost" }; }
  if (response.type === "opaqueredirect" || response.redirected || !(response.headers.get("content-type") ?? "").includes("application/json")) return { kind: "elsewhere" };
  let data: unknown;
  try { data = await response.json(); } catch { return { kind: "lost" }; }
  const { outcome, words } = (data ?? {}) as { outcome?: unknown; words?: unknown };
  if ((outcome !== "done" && outcome !== "refused") || typeof words !== "string") return { kind: "elsewhere" };
  if (outcome === "done" && response.status !== 200) return { kind: "elsewhere" };
  return { kind: "answer", outcome, words };
}

/**
 * Accept and Send back for the selected task's current result, in place. The snapshot on screen is pinned; a press reads
 * the task again and compares task, run, result and routes (anything moved posts nothing and draws the new terms, held
 * for a moment); the post carries exactly the pinned terms (the receipt read, or the saved notes and diff it seals with
 * the fresh read's request token) and never a password. A press whose selection moved on says its outcome above the
 * list, against its own task.
 */
function ResultDecision({ item, workspace, again, onDone, onSettled }: { item: Item; workspace: BrowserWorkspace; again: () => Promise<BrowserWorkspace | null | undefined>;
  onDone: (id: string, words: string) => void; onSettled: (title: string, words: string) => void }) {
  const csrf = useContext(FormToken);
  const [snapshot, setSnapshot] = useState<ResultSnapshot | null>(() => resultSnapshotOf(workspace));
  const pinned = useRef(snapshot);
  const [armed, setArmed] = useState(false);
  const armedRef = useRef(false);
  const [busy, setBusy] = useState<null | "accepting" | "sending" | "checking">(null);
  const [said, setSaid] = useState<{ tone: "refused" | "words"; text: string } | null>(null);
  const [changed, setChanged] = useState(false);
  const [note, setNote] = useState("");
  const pressing = useRef(false);
  const alive = useRef(true);
  const holdTimer = useRef<number | undefined>(undefined);
  const pane = useRef<HTMLDivElement>(null);
  const redraw = (next: ResultSnapshot | null) => {
    pinned.current = next; setSnapshot(next);
    armedRef.current = false; setArmed(false);
    window.clearTimeout(holdTimer.current);
    holdTimer.current = window.setTimeout(() => { armedRef.current = true; setArmed(true); }, REDRAW_HOLD_MS);
  };
  useEffect(() => { redraw(resultSnapshotOf(workspace)); }, [workspace]);
  useEffect(() => () => { alive.current = false; window.clearTimeout(holdTimer.current); }, []);
  // Work never shows a password field: one found takes the acts off.
  useLayoutEffect(() => { if (pane.current?.querySelector('input[type="password"]') && pinned.current !== null) { pinned.current = null; setSnapshot(null); } });

  const press = async (kind: "accept" | "send") => {
    const shown = pinned.current;
    if (pressing.current || !armedRef.current || shown === null || (kind === "accept" ? shown.accept === null : shown.sendBack === null || note.trim() === "")) return;
    pressing.current = true;
    setBusy(kind === "accept" ? "accepting" : "sending"); setSaid(null);
    const finish = () => { pressing.current = false; if (alive.current) setBusy(null); };
    // 1. Read the task again (never minted) and compare the terms on screen with what it says now.
    const latestRead = await again();
    if (!alive.current) { pressing.current = false; return; }
    const latest = latestRead == null ? null : resultSnapshotOf(latestRead);
    if (latestRead === null) { finish(); setSaid({ tone: "refused", text: "Couldn’t read the result just now. Nothing changed." }); return; }
    if (latestRead === undefined) { pressing.current = false; return; }
    if (!sameTerms(shown, latest) || (kind === "accept" ? latest!.accept === null : latest!.sendBack === null)) {
      // A changed result is never decided by the press that found it: nothing is posted, the new terms are drawn.
      finish(); setChanged(true); redraw(latest); return;
    }
    // 2. Post exactly the pinned terms, asking for the answer in place; never a password.
    const body = new URLSearchParams({ csrf });
    if (kind === "accept") {
      body.set("receipt", shown.accept!.receipt); body.set("run", String(shown.run));
      if (shown.accept!.withAcceptance) body.set("accept", "1");
    } else {
      body.set("intent", "revise"); body.set("batch", shown.sendBack!.batch); body.set("source", shown.sendBack!.source);
      body.set("request", latest!.sendBack!.request); body.set("note", note.trim());
    }
    const answer = await postAct(kind === "accept" ? shown.accept!.action : shown.sendBack!.action, body);
    // The selection moved while the answer was on its way: this panel is gone. Say what became of it, for its own task.
    if (!alive.current) {
      onSettled(item.title, answer.kind === "answer" ? answer.outcome === "refused" ? `${sentence(answer.words)} Nothing changed.` : sentence(answer.words)
        : "No answer came back. Open the task to see where it stands.");
      nudge(); return;
    }
    if (answer.kind === "elsewhere") { window.location.assign(item.href); return; }
    if (answer.kind === "answer" && answer.outcome === "done") { onDone(item.id, sentence(answer.words)); return; }
    if (answer.kind === "answer") {
      setSaid({ tone: "refused", text: `${sentence(answer.words)} Nothing changed.` });
      setBusy("checking");
      if (await again() !== undefined) finish();
      return;
    }
    // No answer: it may have been kept before the answer was lost. Read the task and say what it says.
    setBusy("checking");
    const after = await again();
    if (after === undefined || !alive.current) { pressing.current = false; return; }
    const still = resultSnapshotOf(after);
    if (still !== null && sameTerms(shown, still)) { setSaid({ tone: "words", text: "No answer came back, and the result still waits. Try again." }); finish(); return; }
    onDone(item.id, "Done. The task moved on.");
  };

  if (snapshot === null) return <div className="k-acts" ref={pane}><KLinkButton variant="primary" label="Review the result" href={item.href} data-full-load="" data-work-review="" /></div>;
  return <div className="so-work-decide" ref={pane} data-work-decide={snapshot.accept !== null ? "accept" : "send-back"}>
    {changed && <p className="so-home-changed" role="status" data-work-changed>The result changed. Read it again.</p>}
    {snapshot.accept !== null && <div className="k-acts">
      <KButton variant="primary" label={snapshot.accept.label} busy={busy === "accepting" ? "Accepting…" : busy === "checking" ? "Checking…" : false}
        aria-disabled={!armed || busy !== null ? true : undefined} data-work-accept="" onClick={event => { if (pressedByPerson(event)) void press("accept"); }} />
    </div>}
    {snapshot.sendBack !== null && <form className="so-work-send" onSubmit={event => { event.preventDefault(); void press("send"); }} data-work-send-back="">
      <KComposer id={`send-back-${snapshot.taskId}`} label="What should change?" placeholder="What should change?" value={note} onChange={setNote}
        onSend={() => { void press("send"); }} line rows={1} sendLabel="Send back" disabled={busy !== null} sendDisabled={!armed} />
    </form>}
    {said && <p className={`so-home-said${said.tone === "refused" ? " is-refused" : ""}`} role="status" data-work-said-act={said.tone}>{said.text}</p>}
  </div>;
}
