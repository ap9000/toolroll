/** Agents (UI revamp wave B, on the kit): who is working, in one list — Needs you, Working, Finished in a window you
 * pick — then, for a person with access to the whole installation, the computers that build (register, details,
 * retire, reserved work) and which model runs each phase. A row opens that agent's own reading page (/agents?run=N):
 * where it stands with Pause and Stop, its conversation and changes, and one composer — Reply while it asks,
 * otherwise a note that steers it. The page follows the workspace and the opened agent's own room, so it updates in
 * place; forms keep what is being typed. Every act posts to the handler it always had; the server proves it again. */
import { useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AgentLaneWindow, BrowserAgentDetail, BrowserAgentRow, BrowserAgentsView, BrowserComputer, BrowserComputers } from "../../browser-workspace.js";
import { RESOURCE, termsOf, type ChipTone } from "../../design/kit.js";
import { GuardedHtml } from "../guarded-html.js";
import {
  KActs, KApprove, KButton, KChip, KComposer, KCount, KDisclose, KDoc, KDocHeader, KEmpty, KFacts, KField, KGroup, KInfoLine, KInput,
  KLinkButton, KNote, KNotice, KOverlay, KPageHeader, KPhoneHeader, KRow, KSeg, KSelect, KSlots, KTabs, KWorkConversation, usePasswordAsked,
} from "../kit/index.js";
import { useLiveRoom } from "../live.js";
import { useNow, WORKSPACE_NUDGE } from "../live-task.js";
import { FormToken, Passwordless, PostForm } from "../ui/index.js";
import { LiveGrid } from "./agents-live-view.js";
import { freshDraft, loadDraft, saveDraft, type SteerDraft } from "./steer-composer.js";
import "./agents.css";
import { keyed, markAgentSeen, watchAgent } from "../mutation-key.js";

/** "38 s", "4 min", "1 h 12 min". */
export function elapsedWords(fromIso: string, to: number): string {
  const seconds = Math.max(0, Math.floor((to - Date.parse(fromIso)) / 1000));
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
}

/** "Running 4 min", or "Ran 25 min · finished 45 min ago": how long it ran, and when it ended, each labelled. */
export function timeWords(row: Pick<BrowserAgentRow, "startedAt" | "endedAt">, now: number): string {
  if (row.endedAt === null) return `Running ${elapsedWords(row.startedAt, now)}`;
  const since = now - Date.parse(row.endedAt);
  return `Ran ${elapsedWords(row.startedAt, Date.parse(row.endedAt))} · finished ${since < 60_000 ? "just now" : `${elapsedWords(row.endedAt, now)} ago`}`;
}

const clock = (iso: string): string => {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? "" : new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};
/** A time today as its clock, an older one with its day. */
const when = (iso: string, now: number): string => {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  return new Date(at).toDateString() === new Date(now).toDateString() ? clock(iso) : new Date(at).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
};
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A row's chip: its own word in the kit's tone. Inside Needs you it names the ask; a running build is Building. */
function chipOf(row: Pick<BrowserAgentRow, "group" | "label">): { word: string; tone: ChipTone } {
  if (row.group === "needs-you") return { word: row.label, tone: "ask" };
  if (row.group === "stuck") return { word: "Stuck", tone: "" };
  if (row.group === "working") return { word: "Building", tone: "live" };
  if (row.label === "Done") return { word: "Finished", tone: "done" };
  if (row.label === "No changes") return { word: "No changes", tone: "done" };
  if (row.label === "Failed") return { word: "Failed", tone: "failed" };
  return { word: row.label, tone: "" };
}
function StateChip({ row }: { row: Pick<BrowserAgentRow, "group" | "label"> }) {
  const { word, tone } = chipOf(row);
  return <span className="agents-chip" data-agent-state={row.label}><KChip word={word} tone={tone} /></span>;
}

function Elapsed({ row }: { row: Pick<BrowserAgentRow, "startedAt" | "endedAt"> }) {
  const now = useNow();
  return <time dateTime={row.endedAt ?? row.startedAt} className="k-num" data-agent-time>{timeWords(row, now)}</time>;
}

/** A command to run, selected whole with one click, and Copy beside it. A refused clipboard says so. */
function CopyLine({ text }: { text: string }) {
  const [copied, setCopied] = useState<"no" | "yes" | "failed">("no");
  const copy = () => {
    if (navigator.clipboard?.writeText === undefined) { setCopied("failed"); return; }
    void navigator.clipboard.writeText(text).then(() => setCopied("yes"), () => setCopied("failed"));
  };
  return <span className="agents-copy"><code className="k-code">{text}</code><KButton sm label={copied === "yes" ? "Copied" : "Copy"} onClick={copy} />
    {copied === "failed" && <span className="k-note" role="status">Couldn't copy. Select it and copy it yourself.</span>}</span>;
}

// ---- the list ------------------------------------------------------------------------------------------------------

const WINDOW_MS: Record<AgentLaneWindow, number> = { "30m": 30 * 60_000, "2h": 2 * 60 * 60_000, "24h": 24 * 60 * 60_000 };
const WINDOW_WORDS: Record<AgentLaneWindow, string> = { "30m": "the last 30 minutes", "2h": "the last 2 hours", "24h": "the last 24 hours" };

function AgentListRow({ row }: { row: BrowserAgentRow }) {
  const finished = row.endedAt !== null && row.group !== "needs-you";
  const action = row.group === "needs-you"
    ? row.label === "Question" ? <KLinkButton sm href={row.href} label="Answer" /> : <KLinkButton sm href={`/t/${encodeURIComponent(row.taskId)}`} label="Open task" />
    : finished ? <KLinkButton sm href={`/r/${row.runId}`} label="Open record" /> : <KLinkButton sm href={row.href} label="Watch" />;
  const line = [row.line ?? (finished ? row.diff : null), row.agent].filter(Boolean).join(" · ");
  return <div data-agent-row={row.runId} data-agent-group={row.group}>
    <KRow href={row.href} wait={row.group === "needs-you"} chip={<StateChip row={row} />} title={row.title}
      desc={<span data-agent-line title={row.line ?? undefined}>{line}</span>}
      meta={<>{row.project && <span>{row.project}</span>}<Elapsed row={row} />{row.diff !== null && !finished && <span className="k-num" data-agent-diff>{row.diff}</span>}</>}
      action={action} />
  </div>;
}

function Group({ id, label, rows, ink, right }: { id: string; label: ReactNode; rows: readonly BrowserAgentRow[]; ink?: boolean; right?: ReactNode }) {
  return <section data-agent-group-section={id} aria-labelledby={`agents-${id}`}>
    <KGroup id={`agents-${id}`} label={label} count={<KCount n={rows.length} ink={ink === true} />} right={right} />
    {rows.map(row => <AgentListRow key={row.runId} row={row} />)}
  </section>;
}

/** Why a computer is in the state it is, in one line. */
function computerLine(one: BrowserComputer, now: number): string {
  const heard = `heard ${elapsedWords(one.heardAt, now)} ago`;
  const reserved = one.reserved.length > 0 ? ` · ${one.reserved.length} reserved` : "";
  if (one.retired) return `Retired${reserved}`;
  if (one.state === "offline") return `Stopped answering at ${when(one.heardAt, now)} · ${elapsedWords(one.heardAt, now)} ago${reserved}`;
  const busy = one.building.length + one.hidden;
  if (one.state === "building") return `${busy} of ${one.capacity} building · ${heard}${reserved}`;
  return `Free · ${plural(one.capacity, "slot", "slots")} · ${heard}${reserved}`;
}
const computerChip = (one: BrowserComputer) => one.retired ? <KChip word="Retired" /> : <KChip word={RESOURCE[one.state].word} tone={RESOURCE[one.state].tone} />;

/** A computer stopped answering: what that means and the one command that brings it back. */
function OfflineBox({ one, others }: { one: BrowserComputer; others: boolean }) {
  const now = useNow(30_000);
  return <div data-computer-offline={one.name}><KSlots status={<>{computerChip(one)}<h2>{one.name} is offline</h2></>}
    text={`It stopped answering at ${when(one.heardAt, now)}. Nothing is lost: work it would take waits in the queue${others ? ", and the other computers keep building" : ""}. To bring it back, open a terminal on ${one.host}, go to the project's folder and run:`}
    acts={<CopyLine text="toolroll up" />}
    terms={`Keep it running; it picks up queued work on its own. If ${one.name} is gone for good, retire it below.`} /></div>;
}

/** No computer builds yet: approved tasks wait until one is connected. */
function StartBox() {
  return <div data-computer-none><KSlots status={<h2>No computer is building yet</h2>}
    text="Approved tasks wait until one is connected. On the computer where the project lives, open the project's folder in a terminal and run:"
    acts={<CopyLine text="toolroll up" />} terms="Keep it running. The console alone (toolroll serve) doesn't build." /></div>;
}

/** A computer's details, in a drawer: its facts, reserved work (move it), its note, and Retire (step-up). */
function ComputerDrawer({ one, computers, trigger, onClose }: { one: BrowserComputer; computers: BrowserComputers; trigger: HTMLElement; onClose: () => void }) {
  const now = useNow(30_000);
  const passwordless = useContext(Passwordless);
  const csrf = useContext(FormToken);
  const facts = { passwordless, remembered: false };
  const status = one.retired ? "Retired" : one.state === "offline" ? `Offline since ${when(one.heardAt, now)}` : one.state === "building" ? "Online, building" : "Online";
  // The same handler /fleet posted to; the server proves the password (or Passwordless) again.
  const retire = async (password: string | null): Promise<string | null> => {
    try {
      const answer = await fetch("/fleet/runner/retire", { method: "POST", credentials: "same-origin", redirect: "manual", headers: keyed({}),
        body: new URLSearchParams({ csrf, name: one.name, token: password ?? "" }) });
      if (answer.type === "opaqueredirect" || (answer.status >= 300 && answer.status < 400)) { location.assign(`/agents?retired=${encodeURIComponent(one.name)}#computers`); return null; }
      if (answer.status === 404) return "There's no computer by that name any more. Nothing changed.";
      return password === null ? "Retiring needs your password now. Nothing changed." : "That password didn't match. Nothing changed.";
    } catch { return "The console didn't answer. Nothing changed; try again."; }
  };
  return <KOverlay kind="drawer" title={one.name} trigger={trigger} onClose={onClose}>
    <div className="agents-cpanel" data-computer-panel={one.name}>
      <KFacts rows={[
        ["Status", status], ["Computer", one.host],
        ["Takes work from", one.projects.length > 0 ? one.projects.join(", ") : "No projects yet"],
        ["Building now", one.building.length === 0 && one.hidden === 0 ? "Nothing"
          : <>{one.building.map(build => <span key={build.taskId} className="agents-fact-line"><a href={build.href}>{build.title}</a></span>)}
            {one.hidden > 0 && <span className="agents-fact-line">{plural(one.hidden, "task", "tasks")} in projects you can't see</span>}</>],
        ["At a time", plural(one.capacity, "task", "tasks")],
        ["Last heard", `${when(one.heardAt, now)} (${elapsedWords(one.heardAt, now)} ago)`],
        ["Registered", when(one.registeredAt, now)],
      ]} />
      <section className="k-sec" aria-label="Reserved for it">
        <h3>Reserved for it</h3>
        {one.reserved.length === 0 ? <KNote>Nothing. It takes from the shared queue, top first.</KNote>
          : <ul className="agents-list">{one.reserved.map(task => <li key={task.id} data-reserved={task.id}>
            <span className="agents-list-t"><a href={task.href}>{task.title}</a>{task.project && <span className="k-muted"> · {task.project}</span>}</span>
            {computers.manage && !task.taken && <PostForm action="/queue/move" className="agents-move">
              <input type="hidden" name="queueRevision" value={String(computers.queueRevision)} />
              <input type="hidden" name="task" value={task.id} /><input type="hidden" name="before" value="" />
              <KSelect sm name="column" aria-label={`Move ${task.title} to`} defaultValue="anyone"
                items={[["anyone", "Shared queue"], ...computers.list.filter(other => other.name !== one.name && !other.retired).map(other => [other.name, other.name] as const)]} />
              <KButton sm type="submit" label="Move" />
            </PostForm>}
            {task.taken && <span className="k-note">Being taken</span>}
          </li>)}</ul>}
      </section>
      {computers.manage && !one.retired && <PostForm action="/queue/note" className="k-sec">
        <input type="hidden" name="runner" value={one.name} /><input type="hidden" name="from" value="fleet" />
        <KField label="Note on its queue" hint="What it is working through, for whoever looks next.">
          {ids => <KInput id={ids.id} name="note" maxLength={200} defaultValue={one.note ?? ""} aria-describedby={ids.describedBy} />}
        </KField>
        <KActs><KButton sm type="submit" label="Save note" /></KActs>
      </PostForm>}
      {!computers.manage && one.note && <KFacts rows={[["Note", one.note]]} />}
      {computers.manage && !one.retired && <div className="k-sec" data-computer-retire={one.name}>
        <KActs><KApprove kind="step-up" facts={facts} label="Retire computer" primary={false} terms={`Retire ${one.name}: it takes no more work.`} onApprove={retire} /></KActs>
        <KNote>{`Retiring stops it taking work. Tasks reserved for it wait until you move them. ${termsOf("step-up", facts)}`}</KNote>
      </div>}
    </div>
  </KOverlay>;
}

/** A name a computer can have: one short line, no control or format characters (as the handler checks). */
const nameProblem = (name: string): string | null =>
  name === "" ? "Name the computer first." : name.length > 60 || /[\p{Cc}\p{Cf}]/u.test(name) ? "Use one short line: up to 60 characters, no control characters." : null;

/** Register a computer: its name and how many tasks at a time; always the password typed now (it makes a token). */
function RegisterForm({ onCancel }: { onCancel: () => void }) {
  const csrf = useContext(FormToken);
  const passwordless = useContext(Passwordless);
  const [name, setName] = useState("");
  const [capacity, setCapacity] = useState("1");
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const trimmed = name.trim();
  const facts = { passwordless, remembered: false };
  // The token page is the handler's own (shown once, no script on it): the form goes there natively.
  const register = async (password: string | null): Promise<string | null> => {
    const form = document.createElement("form");
    form.setAttribute("method", "post"); form.setAttribute("action", "/fleet/runner/register"); form.hidden = true;
    for (const [key, value] of Object.entries({ csrf, name: trimmed, capacity, token: password ?? "" })) {
      const input = document.createElement("input");
      input.type = "hidden"; input.name = key; input.value = value;
      form.append(input);
    }
    document.body.append(form);
    form.submit();
    return null;
  };
  // Invalid values are refused next to their field before any password is asked for.
  const refuse = () => { setError(nameProblem(trimmed)); field.current?.focus(); };
  return <div className="k-sec agents-reg" id="agents-register" data-computer-register>
    <h3>Add a computer</h3>
    <KField label="Computer name" error={error}>
      {ids => <KInput ref={field} id={ids.id} value={name} autoComplete="off" spellCheck={false} maxLength={60} aria-describedby={ids.describedBy} aria-invalid={ids.invalid || undefined}
        onChange={event => { setName(event.target.value); setError(null); }} />}
    </KField>
    <KField label="Tasks at a time">
      {ids => <KSelect id={ids.id} wide value={capacity} onChange={event => setCapacity(event.target.value)} items={["1", "2", "3", "4", "6", "8"]} />}
    </KField>
    <p className="agents-terms">{trimmed || "New computer"} · up to {capacity} at a time · takes from the shared queue</p>
    <KActs>
      {nameProblem(trimmed) === null
        ? <KApprove kind="way-in" facts={facts} label="Register computer" terms={`Register ${trimmed}: up to ${capacity} at a time.`} onApprove={register} />
        : <KButton variant="primary" label="Register computer" onClick={refuse} />}
      <KButton variant="ghost" label="Cancel" onClick={onCancel} />
    </KActs>
    <KNote>{`${termsOf("way-in", facts)} Registering makes a token that lets the computer take work; it is shown once.`}</KNote>
  </div>;
}

function Computers({ computers, terminals }: { computers: BrowserComputers; terminals: boolean }) {
  const now = useNow(30_000);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<{ name: string; trigger: HTMLElement } | null>(null);
  const shown = open === null ? null : computers.list.find(one => one.name === open.name) ?? null;
  const add = computers.manage && !adding ? <KButton variant="ghost" sm lead="plus" label="Add a computer" onClick={() => setAdding(true)} /> : undefined;
  return <section id="computers" className="agents-sec" aria-labelledby="agents-computers" data-computers>
    <KGroup id="agents-computers" label="Computers that build" count={<KCount n={computers.list.length} />} right={add} />
    {computers.list.length === 0 && <div className="agents-pad"><StartBox /></div>}
    {computers.list.map(one => <div key={one.name} data-computer={one.name}>
      <KRow chip={computerChip(one)} title={one.name} desc={`${one.host} · ${computerLine(one, now)}`}
        meta={<span>{one.projects.length > 0 ? one.projects.join(", ") : "No projects yet"}</span>}
        action={<KButton sm label="Details" aria-haspopup="dialog" onClick={event => setOpen({ name: one.name, trigger: event.currentTarget })} />} />
    </div>)}
    {computers.shared > 0 && <p className="agents-line">{plural(computers.shared, "task waits", "tasks wait")} in the shared queue for any free computer. <a className="k-link" href="/tasks?view=order">Reserve one for a computer</a></p>}
    {adding && <RegisterForm onCancel={() => setAdding(false)} />}
    {terminals && <p className="agents-line k-phone-only"><a className="k-link" href="/agents/terminals">Terminals on these computers</a></p>}
    {open !== null && shown !== null && <ComputerDrawer one={shown} computers={computers} trigger={open.trigger} onClose={() => setOpen(null)} />}
  </section>;
}

const PHASE_WORDS: Record<string, readonly [string, string]> = {
  plan: ["Plan", "Writes the plan you approve"], build: ["Build", "Does the work inside the approved plan"],
  repair: ["Repair", "Fixes a malformed handoff in the same session"], review: ["Review", "Reads the result against the requirements"],
};

function Models({ view }: { view: BrowserAgentsView }) {
  const [open] = useState(() => typeof location !== "undefined" && location.hash === "#models");
  const system = view.system ?? null;
  const more = system !== null && (system.workspaces.length > 0 || system.service !== null || system.outbox > 0 || system.external.length > 0);
  return <section id="models" className="agents-sec agents-models" data-agent-phases>
    <KDisclose summary="Model per phase" open={open}>
      <div className="agents-phases">
        {(view.phases ?? []).map(one => <div key={one.phase} className="agents-phase" data-phase={one.phase}>
          <b>{PHASE_WORDS[one.phase]?.[0] ?? one.phase}</b><span className="k-muted">{PHASE_WORDS[one.phase]?.[1] ?? ""}</span>
          {one.model === null ? <span>{one.problem}</span> : <span>{one.model}{one.noDollars && <span className="k-muted"> · reports tokens, not dollars</span>}</span>}
          <span className="k-muted">{one.source}</span>
        </div>)}
        <KNote>Repair always stays on the provider that built; only its model can differ. <a className="k-link" href="/settings/agents">Change in Settings → Agents and models</a></KNote>
      </div>
    </KDisclose>
    {more && system !== null && <KDisclose summary="Workspaces and sync">
      <div className="agents-phases">
        {system.service !== null && <p>{system.service.running ? `The background service is running, since ${clock(system.service.at)}.` : `The background service last ran: ${system.service.built} built, ${system.service.broke} broke · ended ${clock(system.service.at)}.`}</p>}
        {system.workspaces.length > 0 && <ul className="agents-list">{system.workspaces.map(one => <li key={one.name}><span className="k-mono">{one.name}</span><span className="k-muted">{one.branch} · {one.state}</span></li>)}</ul>}
        {system.outbox > 0 && <p>{plural(system.outbox, "notification waits", "notifications wait")} to be delivered.</p>}
        {system.external.map(one => <p key={one.repo}><span className="k-mono">{one.repo}</span> · {one.state}</p>)}
      </div>
    </KDisclose>}
  </section>;
}

function AgentsList({ view }: { view: BrowserAgentsView }) {
  const now = useNow(30_000);
  const [range, setRange] = useState<AgentLaneWindow>(view.window ?? "24h");
  const choose = (next: string) => {
    const key: AgentLaneWindow = next === "30m" || next === "2h" ? next : "24h";
    setRange(key);
    try { const url = new URL(location.href); if (key === "24h") url.searchParams.delete("window"); else url.searchParams.set("window", key); history.replaceState(history.state, "", url); } catch { /* the address is a convenience */ }
  };
  const rows = view.groups.flatMap(group => group.rows);
  const needs = rows.filter(row => row.group === "needs-you");
  const working = rows.filter(row => row.endedAt === null && row.group !== "needs-you");
  const finished = rows.filter(row => row.endedAt !== null && row.group !== "needs-you" && now - Date.parse(row.endedAt) <= WINDOW_MS[range]);
  const offline = (view.computers?.list ?? []).filter(one => one.state === "offline" && !one.retired);
  const alive = (view.computers?.list ?? []).some(one => one.state !== "offline");
  const seg = <KSeg label="Finished in" current={range} onChange={choose} items={[{ key: "30m", label: "30 min" }, { key: "2h", label: "2 h" }, { key: "24h", label: "24 h" }]} />;
  const right = <>{seg}<KLinkButton sm variant="ghost" href="/agents?view=live" label="Live view" />{view.terminals === true && <KLinkButton sm href="/agents/terminals" label="Terminals" />}</>;
  return <div className="agents-page" id="agents-view" data-agents-board>
    <KPageHeader title="Agents" ctx={`All projects · ${plural(working.length, "agent", "agents")} building`} right={right} />
    {view.computerSaid && <div className="agents-pad" data-computer-said>{view.computerSaid.tone === "error" ? <KNotice>{view.computerSaid.text}</KNotice> : <KInfoLine>{view.computerSaid.text}</KInfoLine>}</div>}
    {offline.map(one => <div key={one.name} className="agents-pad"><OfflineBox one={one} others={alive} /></div>)}
    {needs.length === 0 && working.length === 0 && <div data-agents-empty><KEmpty title="No agents are working." text="An agent starts when you approve a plan. What finished in the window you pick shows below."
      action={<KLinkButton sm href="/tasks" label="Open Tasks" />} /></div>}
    {needs.length > 0 && <Group id="needs-you" label="Needs you" rows={needs} ink />}
    {working.length > 0 && <Group id="working" label="Working" rows={working} />}
    <Group id="finished" label={<><span className="k-desk-only">Finished in {WINDOW_WORDS[range]}</span><span className="k-phone-only">Finished</span></>} rows={finished}
      right={<span className="k-phone-only"><KSelect sm aria-label="Finished in" value={range} onChange={event => choose(event.target.value)} items={[["30m", "Last 30 min"], ["2h", "Last 2 h"], ["24h", "Last 24 h"]]} /></span>} />
    {finished.length === 0 && <p className="agents-none">Nothing finished in {WINDOW_WORDS[range]}.</p>}
    {view.computers != null && <Computers computers={view.computers} terminals={view.terminals === true} />}
    {view.phases != null && <Models view={view} />}
    {view.computers == null && view.terminals === true && <p className="agents-line k-phone-only"><a className="k-link" href="/agents/terminals">Terminals</a></p>}
  </div>;
}

// ---- one agent -----------------------------------------------------------------------------------------------------

/** The changes so far while it runs: the run page's live look at its checkout, every 10 s while open. */
function useLiveChanges(url: string | null, open: boolean): string | null {
  const [fragment, setFragment] = useState<string | null>(null);
  useEffect(() => {
    if (url === null || !open) return;
    let stopped = false, timer = 0;
    const once = async () => {
      try {
        const answer = await fetch(url, { cache: "no-store", credentials: "same-origin", redirect: "manual" });
        if (answer.ok && !stopped) setFragment(await answer.text());
      } catch { /* the next look */ }
      if (!stopped) timer = window.setTimeout(() => void once(), 10_000);
    };
    void once();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [url, open]);
  return fragment;
}

function ChangesPane({ detail, open }: { detail: BrowserAgentDetail; open: boolean }) {
  // Its own tab: the live look at the checkout is read only while the tab is in front.
  const fragment = useLiveChanges(detail.peek, open);
  return <div data-agent-changes className="agents-changes">
    {detail.live
      ? detail.peek === null ? <KNote>Output from other computers isn't shown yet.</KNote>
        : fragment === null ? <KNote>Looking at the checkout…</KNote>
        : <><GuardedHtml html={fragment} className="so-native-region" /><KNote>A live look at its working copy, refreshed every 10 seconds. Not yet a result: the record is sealed when the build ends.</KNote></>
      : detail.files.length === 0 ? <KNote>No saved changes.</KNote>
      : <ul className="agents-files">
        {detail.files.map(file => <li key={file.path}><span className="k-mono" title={file.path}>{file.path}</span>
          <span className="k-num agents-add">{file.added === null ? "" : `+${file.added}`}</span>
          <span className="k-num agents-del">{file.removed === null ? "" : `−${file.removed}`}</span></li>)}
        {detail.filesMore > 0 && <li className="k-muted">{detail.filesMore} more in the result</li>}
      </ul>}
  </div>;
}

/** This running attempt's files, on this computer (cockpit E): the words first, then the path, "Copy the command"
 * (a cd to paste into your own terminal) and Show in Finder. Toolroll launches nothing in them. A phone shows the path. */
export function CheckoutActions({ checkout }: { checkout: NonNullable<BrowserAgentDetail["checkout"]> }) {
  const [copied, setCopied] = useState<"no" | "yes" | "failed">("no");
  // A clipboard that isn't there or refuses says so: the command is shown to select by hand instead.
  const copy = () => {
    if (navigator.clipboard?.writeText === undefined) { setCopied("failed"); return; }
    void navigator.clipboard.writeText(checkout.cd).then(() => setCopied("yes"), () => setCopied("failed"));
  };
  return <section aria-label="Its files" className="k-sec agents-checkout" data-agent-checkout>
    <h3>Its files</h3>
    <KNote>These files were written by an agent. Your shell's startup scripts and prompt tools (git status in the prompt, direnv, .envrc) can run code from them when you open a terminal there.</KNote>
    <code className="k-code" data-agent-checkout-path>{checkout.path}</code>
    <div className="k-acts k-desk-only">
      <KButton sm onClick={copy} data-agent-copy-cd label={copied === "yes" ? "Copied" : "Copy the command"} />
      {checkout.reveal !== null && <PostForm action={checkout.reveal} data-agent-reveal><input type="hidden" name="return" value="agents" /><KButton sm type="submit" label="Show in Finder" /></PostForm>}
    </div>
    {copied === "failed" && <div role="status" className="agents-checkout" data-agent-copy-failed>
      <KNote>Couldn't copy. Select the command and copy it yourself:</KNote>
      <code className="k-code">{checkout.cd}</code>
    </div>}
  </section>;
}

/** Pause or Resume, and Stop behind its confirm, for the exact run each names. None asks for a password. */
function Controls({ controls }: { controls: NonNullable<BrowserAgentDetail["controls"]> }) {
  const pause = controls.pause;
  const stop = controls.stop;
  const [stopping, setStopping] = useState<HTMLElement | null>(null);
  return <>
    {pause !== null && (pause.state === "paused"
      ? <PostForm action={pause.action} data-agent-resume>
          <input type="hidden" name="run" value={String(pause.run)} /><input type="hidden" name="request" value={pause.requests[2]} />
          <input type="hidden" name="mode" value="resume" /><input type="hidden" name="return" value="agents" />
          <KButton type="submit" label="Resume" />
        </PostForm>
      : <PostForm action={pause.action} data-agent-pause>
          <input type="hidden" name="run" value={String(pause.run)} /><input type="hidden" name="request" value={pause.requests[0]} />
          <input type="hidden" name="return" value="agents" />
          <KButton type="submit" label="Pause" busy={pause.state === "pausing" ? "Pausing…" : false} disabled={pause.state === "pausing"} />
        </PostForm>)}
    {stop !== null && <>
      <KButton variant="ghost" label={stop.label} aria-haspopup="dialog" data-agent-stop-open={stop.run} onClick={event => setStopping(event.currentTarget)} />
      {stopping !== null && <KOverlay kind="popover" title={`${stop.label}?`} trigger={stopping} onClose={() => setStopping(null)}>
        <p className="k-pop-terms">It ends now and keeps the work so far. The task waits for you: retry it, or change the plan.</p>
        <PostForm action={stop.action} data-agent-stop={stop.run}>
          <input type="hidden" name="run" value={String(stop.run)} /><input type="hidden" name="return" value="agents" />
          <KActs><KButton type="submit" variant="danger" label={stop.label} /><KButton variant="ghost" label="Cancel" data-k-close="" /></KActs>
        </PostForm>
      </KOverlay>}
    </>}
  </>;
}

/** Where the agent stands: the slots box, the same four slots in every state. */
function StatusBox({ detail }: { detail: BrowserAgentDetail }) {
  const now = useNow();
  const controls = detail.canAct && detail.controls != null ? detail.controls : null;
  const acts = controls !== null ? <div className="k-acts" data-agent-controls={controls.send ?? "none"}><Controls controls={controls} /></div> : null;
  if (detail.question !== null) {
    return <KSlots wait status={<><KChip word="Question" tone="ask" /><h2>{detail.agent} asks</h2></>}
      text={<span data-agent-question={detail.question.key}>{detail.question.text}</span>} acts={acts}
      terms={detail.canAct ? "Answer below. It reads your reply at its next check." : "An approver answers it."} />;
  }
  if (detail.live) {
    const paused = controls?.pause?.state === "paused";
    const { word, tone } = paused ? { word: "Paused", tone: "" as const } : chipOf(detail);
    return <KSlots status={<><KChip word={word} tone={tone} /><h2>{timeWords(detail, now)}</h2></>}
      text={<span data-agent-line>{detail.line ?? "Working."}</span>} acts={acts}
      terms={controls === null ? "" : <span data-agent-capability>{controls.words}</span>} />;
  }
  const { word, tone } = chipOf(detail);
  return <KSlots status={<><KChip word={word} tone={tone} /><h2>{timeWords(detail, now)}</h2></>}
    text={<span data-agent-line>{detail.line ?? detail.diff ?? "It has finished."}</span>}
    acts={<KLinkButton href={detail.open?.href ?? detail.taskHref} label={detail.open ? `Open ${detail.open.label.toLowerCase()}` : "Open task"} />}
    terms={detail.diff ?? ""} />;
}

/** Whether the composer box shows for this agent (so a refusal is said under it, not twice). */
const composes = (detail: BrowserAgentDetail): boolean => detail.canAct
  && (detail.question !== null || (detail.steer !== null && !(detail.live && detail.controls != null && detail.controls.send === null)));

/** The one composer: Reply while the agent asks, otherwise a note that steers it. Neither asks for a password. */
function Composer({ detail }: { detail: BrowserAgentDetail }) {
  const question = detail.question;
  const form = useRef<HTMLFormElement>(null);
  // A steering note's draft survives a refused send (live-conversation.md §6): kept for this run in this tab with its
  // own key, so a double submit files it once. Only that draft's own successful send clears it; editing after a send
  // makes it a new draft with a new key.
  const [draft, setDraft] = useState<SteerDraft>(() => question !== null ? freshDraft() : loadDraft(detail.runId));
  const text = draft.text;
  const setText = (value: string) => setDraft(previous => {
    const next = previous.submitted ? { ...freshDraft(), text: value } : { ...previous, text: value };
    saveDraft(detail.runId, next);
    return next;
  });
  if (!detail.canAct) {
    if (!detail.live) return null;
    return <section className="k-sec agents-steer" aria-label="Send a note"><h3>Send a note</h3>
      <KNote>Your sign-in can watch this agent. Sending it a note takes an approver; ask an operator to change your role in Settings → People and sign-in.</KNote></section>;
  }
  // A running attempt that takes no notes: the box above says why, and nothing here pretends otherwise.
  if (question === null && detail.live && detail.controls != null && detail.controls.send === null) return null;
  // The attempt ended with a note still unsent: it is shown, and can go to the task's next attempt instead.
  if (question === null && detail.steer === null) {
    if (text.trim() === "") return null;
    const discard = () => { saveDraft(detail.runId, { ...freshDraft(), text: "" }); setDraft(freshDraft()); };
    // Kept until the page comes back saying this very draft was sent (loadDraft): a refusal loses nothing.
    return <PostForm action={`${detail.taskHref}/steer`} data-agent-unsent className="k-sec agents-steer">
      <h3>Your note wasn't sent: this attempt ended first</h3>
      <p className="agents-unsent" data-agent-unsent-text>{text}</p>
      <input type="hidden" name="note" value={text} /><input type="hidden" name="after" value={String(detail.runId)} /><input type="hidden" name="key" value={draft.key} />
      <KActs><KButton type="submit" variant="primary" label="Send to the next attempt" /><KButton variant="ghost" label="Discard" onClick={discard} /></KActs>
      <KNote>The task's next attempt reads it before starting. No password needed.</KNote>
    </PostForm>;
  }
  const reply = question !== null;
  // A live agent that is not paused: the note can also stop its turn first and go at once (one request, atomic).
  const pauseAndSend = detail.controls?.pause != null && detail.controls.pause.state === null ? detail.controls.pause : null;
  const words = reply ? "It reads your reply at its next check." : "Notes reach the agent; it answers in the conversation above.";
  return <PostForm ref={form} action={reply ? question.action : detail.steer!.action} data-agent-composer={reply ? "reply" : "steer"} className="k-sec agents-steer"
    onSubmit={event => { if (text.trim() === "") { event.preventDefault(); return; } if (!reply) setDraft(previous => { const sent = { ...previous, submitted: true }; saveDraft(detail.runId, sent); return sent; }); }}>
    <h3>{reply ? `Reply to ${detail.agent}` : `Send a note to ${detail.agent}`}</h3>
    {reply ? <input type="hidden" name="question" value={String(question.id)} />
      : <><input type="hidden" name="return" value="agents" /><input type="hidden" name="run" value={String(detail.steer!.run)} /><input type="hidden" name="key" value={draft.key} />
        {pauseAndSend !== null && <input type="hidden" name="request" value={`steer-${draft.key}`} />}</>}
    <KComposer id={`agent-composer-${detail.runId}`} label={reply ? `Reply to: ${question.text}` : `Send a note to ${detail.agent}`} name={reply ? "answer" : "note"} maxLength={reply ? 1500 : 4000} rows={3}
      value={text} onChange={value => { if (reply) setDraft(previous => ({ ...previous, text: value })); else setText(value); }}
      placeholder={reply ? "Your answer" : "For example: keep the flag off in staging until Wednesday."}
      sendLabel={reply ? "Reply" : "Send note"} onSend={() => form.current?.requestSubmit()} error={detail.said?.tone === "error" ? detail.said.text : null}
      before={!reply && pauseAndSend !== null ? <KButton sm type="submit" formAction={pauseAndSend.action} label="Pause and send" disabled={text.trim() === ""} data-agent-pause-send /> : undefined}
      note={`${words} No password needed.`} />
  </PostForm>;
}

/** The agent's own tabs: its conversation (with the terminal view inside it) and its changes, both kept mounted. */
function AgentTabs({ detail }: { detail: BrowserAgentDetail }) {
  const [tab, setTab] = useState<"conversation" | "changes">("conversation");
  // A password asked on this page (a ceremony, or its popover open) pauses the reader: no request until it is gone.
  const paused = usePasswordAsked();
  return <div className="agents-tabs" data-agent-tabs>
    <KTabs label="Agent" current={tab} onChange={key => setTab(key === "changes" ? "changes" : "conversation")}
      items={[{ key: "conversation", label: "Conversation" }, { key: "changes", label: detail.diff === null ? "Changes" : `Changes · ${detail.diff}` }]} />
    <div role="tabpanel" aria-label="Conversation" hidden={tab !== "conversation"}><KWorkConversation url={detail.transcript} live={detail.live} paused={paused} /></div>
    <div role="tabpanel" aria-label="Changes" hidden={tab !== "changes"}>
      <div className="agents-changes-wrap">
        <ChangesPane detail={detail} open={tab === "changes"} />
        {detail.checkout != null && detail.canAct && <CheckoutActions checkout={detail.checkout} />}
      </div>
    </div>
  </div>;
}

function AgentPage({ detail }: { detail: BrowserAgentDetail }) {
  // The opened agent's own room: a change reads the page again in place; while open, this person is watching it.
  useLiveRoom(detail.room, event => { if (event === "change" || event === "reload") window.dispatchEvent(new Event(WORKSPACE_NUDGE)); });
  // Easy-start C2: viewing is a keyed act, never a page read's side effect: a finished agent opened here is seen; a
  // running one is watched (chat pings hold off) while this page stays open.
  const csrf = useContext(FormToken);
  useEffect(() => detail.live ? watchAgent(detail.runId, csrf) : (markAgentSeen(detail.runId, csrf), undefined), [detail.runId, detail.live, csrf]);
  const meta = [detail.project, `run ${detail.runId}`, detail.agent].filter(Boolean).join(" · ");
  const task = detail.task ?? null;
  return <div className="agents-agent" id="agents-view" data-agent-detail={detail.runId}>
    <KPhoneHeader title={detail.project ?? "Agent"} back="/agents" />
    <KDoc>
      <KDocHeader back={["/agents", "Agents"]} title={detail.title} meta={meta}
        right={<KLinkButton variant="ghost" sm href={detail.taskHref} label="Open task" data-agent-open="Task" />} />
      {detail.said && detail.said.tone === "info" && <div data-agent-said><KInfoLine>{detail.said.text}</KInfoLine></div>}
      {/* A refused send says so under the box that kept the words; anything else, here. */}
      {detail.said && detail.said.tone === "error" && !composes(detail) && <div data-agent-said><KNotice>{detail.said.text}</KNotice></div>}
      <div id="agents-box"><StatusBox detail={detail} /></div>
      {task !== null && <p className="agents-task" data-agent-task={task.headline}>The task: <b>{task.headline}</b>. {task.sentence} <a className="k-link" href={task.action.href} data-agent-task-action>{task.action.label}</a></p>}
      <AgentTabs detail={detail} />
      <Composer key={`${detail.runId}:${detail.question?.id ?? "steer"}`} detail={detail} />
    </KDoc>
  </div>;
}

// ---- the Live grid -------------------------------------------------------------------------------------------------

function LivePage() {
  return <div className="agents-page" id="agents-view" data-agents-board>
    <KPageHeader title="Live" back="/agents" ctx="Every running agent's output, watching only" right={<KLinkButton sm variant="ghost" href="/agents" label="Back to Agents" />} />
    <div className="agents-live"><LiveGrid /></div>
  </div>;
}

export function AgentsView({ view }: { view: BrowserAgentsView }) {
  if (view.live === true) return <LivePage />;
  if (view.selected !== null) return <AgentPage key={view.selected.runId} detail={view.selected} />;
  return <AgentsList view={view} />;
}
