/**
 * Home ("/", UI revamp wave B; prototype app.js `homeView`): one sentence that answers "what needs me?", four counts
 * that agree with the Tasks filters they open, what waits on this person grouped by what it asks and what is running,
 * the selected item open beside the list (an agent's question answered in place, one click), and the lead's box.
 * On a phone the list is the page; a row opens its task, and the dock holds Needs you and New task.
 */
import { useContext, useEffect, useRef, useState } from "react";
import type { BrowserHomeRow, BrowserHomeView } from "../../browser-workspace.js";
import { KButton, KChip, KComposer, KDock, KLinkButton, KNotice, KPageHeader, KRadios } from "../kit/index.js";
import { isPhone } from "../kit/behavior.js";
import { FormToken } from "../ui/index.js";
import { WORKSPACE_NUDGE } from "../live-task.js";
import "./home.css";
import { keyed } from "../mutation-key.js";

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

/** The selected item, open beside the list. */
function OpenPane({ row, waits }: { row: BrowserHomeRow | null; waits: boolean }) {
  if (row === null) return <div className="k-empty"><p className="k-empty-t">Nothing needs you.</p><KLinkButton sm label="Open Tasks" href="/tasks" /></div>;
  const kicker = <div className="so-open-k"><span>{[row.project, row.age].filter(Boolean).join(" · ")}</span><span className="k-grow" /><KLinkButton variant="ghost" sm label="Open task" href={row.href} /></div>;
  if (row.question) return <>{kicker}<p className="so-open-of">{row.title}</p><Question key={row.question.id} row={row} /></>;
  return <>{kicker}
    <h2 className="so-open-t">{row.title}</h2>
    <p className="so-open-chip"><KChip word={waits ? "Needs you" : row.chip.word} tone={waits ? "needs" : row.chip.tone} />{waits && <span>{row.chip.word}</span>}</p>
    {row.line && <p className="so-open-x">{row.line}</p>}
    <div className="k-acts">{row.action ? <KLinkButton label={row.action.label} href={row.action.href} /> : <KLinkButton label="Open task" href={row.href} />}</div>
  </>;
}

/** The lead's message box: the words go to the lead as the first message of a chat (one POST to /chat). */
function AskLead({ ask }: { ask: NonNullable<BrowserHomeView["ask"]> }) {
  const csrf = useContext(FormToken);
  const form = useRef<HTMLFormElement>(null);
  const [text, setText] = useState("");
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
  return <form ref={form} method="post" action="/chat" className="so-home-ask" aria-label="Ask the lead" onSubmit={() => setSending(true)}>
    <input type="hidden" name="csrf" value={csrf} />
    <input type="hidden" name="request" value={request.current} />
    {ask.project !== null && <input type="hidden" name="project" value={ask.project} />}
    <input type="hidden" name="message" value={text} />
    <KComposer id="home-ask" label="Ask the lead" placeholder={ask.placeholder} value={text} onChange={setText} onSend={send} line sendLabel="Ask the lead" disabled={sending} />
  </form>;
}

export function HomeView({ view }: { view: BrowserHomeView }) {
  const rows = rowsOf(view);
  const firstWait = view.groups.find(group => group.key !== "running" && group.key !== "waiting")?.rows[0] ?? rows[0] ?? null;
  const [selected, setSelected] = useState<string | null>(firstWait?.id ?? null);
  const list = useRef<HTMLDivElement>(null);
  // A re-read that removed the selected row selects the first that waits.
  useEffect(() => { if (selected === null || !rows.some(one => one.id === selected)) setSelected(firstWait?.id ?? null); }, [view]);
  const open = rows.find(one => one.id === selected) ?? null;
  const openWaits = open !== null && view.groups.some(group => group.key !== "running" && group.key !== "waiting" && group.rows.includes(open));
  const move = (step: number) => {
    const at = rows.findIndex(one => one.id === selected);
    const next = rows[Math.max(0, Math.min(rows.length - 1, at + step))];
    if (!next) return;
    setSelected(next.id);
    list.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(next.id)}"]`)?.focus();
  };
  const scopes = view.scopes && <nav className="k-seg" aria-label="Project">{view.scopes.map(one =>
    <a key={one.key || "all"} href={one.href} aria-current={one.active ? "page" : undefined}>{one.label}</a>)}</nav>;
  return <div className="so-home" data-kit-page data-home>
    <KPageHeader title="Home" right={<>{scopes}<KLinkButton sm lead="plus" label="New task" href={view.newTask} /></>} />
    {view.empty ? <section className="so-hello so-hello-empty">
      <p className="so-say" data-home-say>{view.empty.title}</p><p className="so-hello-x">{view.empty.text}</p>
      {view.setup && <p className="so-hello-x" data-home-setup><a className="k-link" href={view.setup}>Finish setup</a></p>}
      <KLinkButton variant="primary" label="New task" lead="plus" href={view.newTask} className="k-desk-only" />
    </section> : <>
      <section className="so-hello" aria-label="At a glance">
        <p className="so-say" data-home-say>{view.say}</p>
        {view.setup && <p className="so-hello-x" data-home-setup><a className="k-link" href={view.setup}>Finish setup</a></p>}
        <div className="so-counts">{view.counts.map(count =>
          <a key={count.key} className="so-count" href={count.href} data-home-count={count.key}>
            <span className="so-count-k">{count.key === "needs" && <span className="k-dot needs" aria-hidden="true" />}{count.label}</span>
            <span className={`so-count-v k-num${count.value === 0 ? " zero" : ""}`}>{count.value}</span>
          </a>)}</div>
      </section>
      <div className="so-triage">
        <div className="so-tri-list" ref={list} role="listbox" aria-label="Needs you, running and waiting" onKeyDown={event => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); move(event.key === "ArrowDown" ? 1 : -1); }
        }}>
          {view.groups.length === 0 && <p className="so-tri-none">Nothing needs you, runs or waits.</p>}
          {view.groups.map(group => <div key={group.key} role="group" aria-label={group.label}>
            <p className="so-tri-g" aria-hidden="true">{group.label}</p>
            {group.rows.map(row => <a key={row.id} className="so-ti" href={row.href} role="option" aria-selected={row.id === selected} data-row={row.id}
              tabIndex={row.id === selected ? 0 : -1}
              onClick={event => { if (!isPhone() && !event.metaKey && !event.ctrlKey && !event.shiftKey) { event.preventDefault(); setSelected(row.id); } }}
              onFocus={() => { if (!isPhone()) setSelected(row.id); }}>
              <span className="so-ti-t">{row.title}</span>
              <span className="so-ti-m"><KChip word={row.chip.word} tone={row.chip.tone} />{row.project && <span>{row.project}</span>}<span className="k-num">{row.age}</span></span>
              {(group.key === "running" || group.key === "waiting") && row.line && <span className="so-ti-d">{row.line}</span>}
            </a>)}
          </div>)}
          {view.more && <p className="so-tri-more"><a className="k-link" href={view.more.href}>{view.more.count} more in Tasks</a></p>}
        </div>
        <section className="so-tri-open k-desk-only" aria-label="Selected" aria-live="polite"><OpenPane row={open} waits={openWaits} /></section>
      </div>
    </>}
    {view.ask && <div className="so-home-ask-dock k-desk-only"><AskLead ask={view.ask} /></div>}
    <KDock><KLinkButton variant="primary" lead="plus" label="New task" href={view.newTask} /></KDock>
  </div>;
}
