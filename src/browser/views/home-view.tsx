/**
 * Home ("/", docs/plans/live-pages-and-home.md B1): the heading said once ("19 tasks need you"), one quiet line for
 * what runs and waits, one project filter, and what needs you grouped by what is asked (Approve a plan, Answer a
 * question, Something went wrong, Review results, Needs you), each group with its exact count. The selected row opens
 * beside the list (an agent's question answered in place, one click); the lead's last message sits above the message
 * box. With nothing waiting: what runs, what finished today and the message box, in the middle of the page. On a phone
 * the next one is a card with its one action, then the list; the message box and New task sit at the bottom.
 */
import { useContext, useEffect, useRef, useState } from "react";
import type { BrowserHomeRow, BrowserHomeView } from "../../browser-workspace.js";
import { KButton, KChip, KComposer, KDock, KIcon, KLinkButton, KNotice, KRadios, KSelect } from "../kit/index.js";
import { isPhone } from "../kit/behavior.js";
import { FormToken } from "../ui/index.js";
import { WORKSPACE_NUDGE } from "../live-task.js";
import "./home.css";
import { keyed } from "../mutation-key.js";
import { askDraft, keepAskDraft } from "../workspace-client.js";

const nudge = () => window.dispatchEvent(new CustomEvent(WORKSPACE_NUDGE));
const rowsOf = (view: BrowserHomeView): BrowserHomeRow[] => view.groups.flatMap(group => group.rows);

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

/** The selected item, open beside the list: what it is, the one act that resolves it, and its task one link away. */
function OpenPane({ row, asked }: { row: BrowserHomeRow | null; asked: string }) {
  if (row === null) return null;
  const kicker = <div className="so-open-k"><span>{[row.project, row.age].filter(Boolean).join(" · ")}</span><span className="k-grow" /><a className="k-link" href={row.href}>Open task</a></div>;
  if (row.question) return <>{kicker}<p className="so-open-of">{row.title}</p><Question key={row.question.id} row={row} /></>;
  return <>{kicker}
    <h2 className="so-open-t">{row.title}</h2>
    <p className="so-open-chip"><KChip word="Needs you" tone="needs" /><span>{asked}</span></p>
    {row.line && <p className="so-open-x">{row.line}</p>}
    <div className="k-acts"><KLinkButton variant="primary" label={row.action?.label ?? "Open task"} href={row.action?.href ?? row.href} /></div>
  </>;
}

/** The lead's last message as one line that opens the chat. */
function LeadLine({ lead }: { lead: NonNullable<BrowserHomeView["lastLead"]> }) {
  return <a className="so-lead" href={lead.href} data-home-lead>
    <span className="so-lead-who">Lead</span><span className="so-lead-text">{lead.text}</span>
    <span className="so-lead-age k-num">{lead.age}</span><span className="so-lead-open">Open chat</span>
  </a>;
}

/** The lead's message box: the words go to the lead as the first message of a chat (one POST to /chat). */
function AskLead({ ask, line }: { ask: NonNullable<BrowserHomeView["ask"]>; line: boolean }) {
  const csrf = useContext(FormToken);
  const form = useRef<HTMLFormElement>(null);
  // Kept in this tab across pages (live-pages-and-home.md A1.3); gone once sent.
  const [text, setText] = useState(() => askDraft(csrf, ask.project));
  const [sending, setSending] = useState(false);
  const request = useRef(Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join(""));
  const send = () => {
    if (sending || text.trim() === "") return;
    setSending(true);
    // The message box's own words go in the hidden field the native form posts.
    const field = form.current?.querySelector<HTMLInputElement>('input[name="message"]');
    if (field) field.value = text;
    form.current?.requestSubmit();
  };
  return <form ref={form} method="post" action="/chat" className="so-home-ask" aria-label="Message the lead" onSubmit={() => { setSending(true); keepAskDraft(csrf, ask.project, ""); }}>
    <input type="hidden" name="csrf" value={csrf} />
    <input type="hidden" name="request" value={request.current} />
    {ask.project !== null && <input type="hidden" name="project" value={ask.project} />}
    <input type="hidden" name="message" value={text} />
    <KComposer id="home-ask" label="Message the lead" placeholder={ask.placeholder} value={text} onChange={value => { setText(value); keepAskDraft(csrf, ask.project, value); }} onSend={send} line={line} rows={line ? 1 : 2} sendLabel="Send to the lead" disabled={sending} />
  </form>;
}

/** The one project filter: a select whose choices are addresses. */
function ProjectFilter({ scopes }: { scopes: NonNullable<BrowserHomeView["scopes"]> }) {
  const current = scopes.find(one => one.active)?.href ?? scopes[0]!.href;
  return <KSelect className="so-home-scope" aria-label="Project" value={current} items={scopes.map(one => [one.href, one.label] as const)}
    onChange={event => { if (event.target.value !== current) window.location.assign(event.target.value); }} />;
}

/** "1 running now · 1 queued": what runs and waits, said quietly once. */
function Activity({ view, all }: { view: BrowserHomeView; all: boolean }) {
  const figure = (key: "running" | "queued") => view.counts.find(one => one.key === key)?.value ?? 0;
  const running = figure("running"), queued = figure("queued");
  const tasks = view.project === null ? "/tasks?scope=all" : `/tasks?project=${encodeURIComponent(view.project)}`;
  const parts = [
    ...(running > 0 ? [<span key="r" className="so-act-run"><span className="so-mark live" aria-hidden="true" />{running} running now</span>] : []),
    ...(queued > 0 ? [<span key="q">{queued} queued</span>] : []),
    ...(all ? [<a key="a" className="k-link" href={tasks}>See all tasks</a>] : []),
  ];
  if (parts.length === 0) return null;
  return <p className="so-act" data-home-activity>{parts.flatMap((part, at) => at === 0 ? [part] : [<span key={`s${at}`} className="so-act-sep" aria-hidden="true">·</span>, part])}</p>;
}

/** A running, queued or finished row in the clear layout: its mark, title, what it is doing and its project, and age. */
function WorkRow({ row }: { row: BrowserHomeRow }) {
  return <a className="so-wrow" href={row.href} data-row={row.id}>
    {row.state === "done" ? <span className="so-wrow-check" aria-hidden="true"><KIcon name="check" small /></span> : <span className={`so-mark ${row.state === "running" ? "live" : "queued"}`} aria-hidden="true" />}
    <span className="so-wrow-b"><span className="so-wrow-t">{row.title}</span>
      {(row.line || row.project) && <span className="so-wrow-m">{[row.line?.replace(/[.\s]+$/, ""), row.project].filter(Boolean).join(" · ")}</span>}</span>
    <span className="so-wrow-age k-num">{row.age}</span>
  </a>;
}

export function HomeView({ view }: { view: BrowserHomeView }) {
  const rows = view.groups.flatMap(group => group.rows);
  const first = rows[0] ?? null;
  const [selected, setSelected] = useState<string | null>(first?.id ?? null);
  const list = useRef<HTMLDivElement>(null);
  // A re-read that removed the selected row selects the first.
  useEffect(() => { if (selected === null || !rows.some(one => one.id === selected)) setSelected(first?.id ?? null); }, [view]);
  const open = rows.find(one => one.id === selected) ?? null;
  const askedOf = (row: BrowserHomeRow | null) => view.groups.find(group => row !== null && group.rows.includes(row))?.label ?? "";
  const needsHref = view.counts.find(one => one.key === "needs")?.href ?? "/tasks?view=needs-you";
  const move = (step: number) => {
    const at = rows.findIndex(one => one.id === selected);
    const next = rows[Math.max(0, Math.min(rows.length - 1, at + step))];
    if (!next) return;
    setSelected(next.id);
    list.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(next.id)}"]`)?.focus();
  };
  const header = <header className="so-home-h">
    <div className="so-home-hl"><h1 className="so-say" data-home-say>{view.say}</h1><Activity view={view} all={rows.length > 0} /></div>
    <div className="so-home-tools">{view.scopes && <ProjectFilter scopes={view.scopes} />}<KLinkButton sm lead="plus" label="New task" href={view.newTask} className="k-desk-only" /></div>
  </header>;
  const setup = view.setup ? <p className="so-hello-x" data-home-setup><a className="k-link" href={view.setup}>Finish setup</a></p> : null;
  const newTaskDock = <KDock><KLinkButton variant="primary" lead="plus" label="New task" href={view.newTask} /></KDock>;

  if (view.empty) return <div className="so-home so-home-clear" data-kit-page data-home>
    <div className="so-clear">
      <header className="so-home-h"><div className="so-home-hl"><h1 className="so-say" data-home-say>{view.empty.title}</h1><p className="so-hello-x">{view.empty.text}</p></div></header>
      {setup}
      <div><KLinkButton variant="primary" label="New task" lead="plus" href={view.newTask} className="k-desk-only" /></div>
      {view.ask && <div className="so-clear-ask"><AskLead ask={view.ask} line={false} /></div>}
    </div>
    {newTaskDock}
  </div>;

  // Nothing waits on you: what runs, what finished today, and the message box in the middle of the page.
  if (rows.length === 0 && view.groups.length === 0) return <div className="so-home so-home-clear" data-kit-page data-home>
    <div className="so-clear">
      {header}
      {setup}
      {view.ask && <div className="so-clear-ask">{view.lastLead && <LeadLine lead={view.lastLead} />}<AskLead ask={view.ask} line={false} /></div>}
      {view.working.length > 0 && <section className="so-sec" aria-label="Running">
        <h2 className="so-sec-h">Running</h2>
        {view.working.map(row => <WorkRow key={row.id} row={row} />)}
      </section>}
      {view.finishedToday.count > 0 && <section className="so-sec" aria-label="Done today">
        <div className="so-sec-hr"><h2 className="so-sec-h">Done today <span className="k-num">{view.finishedToday.count}</span></h2><a className="k-link" href={view.finishedToday.href}>See all tasks</a></div>
        {view.finishedToday.rows.map(row => <WorkRow key={row.id} row={row} />)}
      </section>}
    </div>
    {newTaskDock}
  </div>;

  // Something waits on you: the list grouped by what is asked, the selected one beside it, the message box below.
  return <div className="so-home" data-kit-page data-home>
    {header}
    {setup}
    {first && <section className="so-next" aria-label="Next" data-home-next>
      <p className="so-next-k"><KChip word="Needs you" tone="needs" /><span>{[askedOf(first), first.project, first.age].filter(Boolean).join(" · ")}</span></p>
      <p className="so-next-t">{first.title}</p>
      {first.line && <p className="so-next-x">{first.line}</p>}
      <KLinkButton variant="primary" label={first.action?.label ?? "Open task"} href={first.action?.href ?? first.href} className="so-next-act" />
    </section>}
    <div className="so-triage">
      <div className="so-tri-list" ref={list} role="listbox" aria-label="Needs you" onKeyDown={event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); move(event.key === "ArrowDown" ? 1 : -1); }
      }}>
        {view.groups.map(group => <div key={group.key} className="so-tri-grp" role="group" aria-label={`${group.label}, ${group.count}`} data-group={group.key}>
          <p className="so-tri-g" aria-hidden="true"><span>{group.label}</span><span className="so-tri-n k-num" data-group-count>{group.count}</span></p>
          {group.rows.map(row => <a key={row.id} className={`so-ti${row === first ? " so-ti-next" : ""}`} href={row.href} role="option" aria-selected={row.id === selected} data-row={row.id}
            tabIndex={row.id === selected ? 0 : -1}
            onClick={event => { if (!isPhone() && !event.metaKey && !event.ctrlKey && !event.shiftKey) { event.preventDefault(); setSelected(row.id); } }}
            onFocus={() => { if (!isPhone()) setSelected(row.id); }}>
            <span className="so-ti-t">{row.title}</span>
            <span className="so-ti-m">{row.reason && <span className="so-ti-why">{row.reason}</span>}{[row.project, row.age].filter(Boolean).join(" · ")}</span>
          </a>)}
          {group.count > group.rows.length && <a className="so-tri-more k-link" href={needsHref}>{group.count - group.rows.length} more in Tasks</a>}
        </div>)}
      </div>
      <section className="so-tri-open k-desk-only" aria-label="Selected task" aria-live="polite"><OpenPane row={open} asked={askedOf(open)} /></section>
    </div>
    {view.ask ? <div className="so-home-bar" data-home-bar>
      {view.lastLead && <LeadLine lead={view.lastLead} />}
      <div className="so-home-bar-row"><AskLead ask={view.ask} line />
        <a className="k-btn k-btn-outline k-btn-icon so-home-plus" href={view.newTask} aria-label="New task" title="New task"><KIcon name="plus" /></a></div>
    </div> : newTaskDock}
  </div>;
}
