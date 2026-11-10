/** One task (src/design/KIT.md, docs/plans/task-page-steps.md): a reading page in one centred column. The title and
 * its meta, Full record, Activity and Details; then the steps are the page — Plan, Approval, Build, Checks, Ready (four
 * for a report) as step rows: a finished step is one line that opens on press, the step happening now is open and
 * holds the one action, a step not reached is one grey line. Under the rows, "More about this task". Forms, ceremonies
 * and ledgers stay the server's own HTML (same ids, same page scripts); this page only frames them. A task with no
 * road (cancelled) keeps its status block. */
import { useContext, useEffect, useRef, useState, type MouseEvent, type ReactNode, type SyntheticEvent } from "react";
import { freshDraft, loadDraft, saveDraft, SteerNote, UnsentNote, type SteerDraft } from "./steer-composer.js";
import { HEADLINE_TONE, HEADLINES, type Headline } from "../../task-status.js";
import { FormToken, Passwordless, PostForm } from "../ui/post-form.js";
import type { AssignmentCard } from "../../assignment-ui.js";
import type { BrowserTaskDetailGroup, BrowserTaskFact, BrowserTaskMore, BrowserTaskSection, BrowserTaskTab, BrowserTaskThreadItem, BrowserTaskView } from "../../browser-workspace.js";
import { termsOf, type StepItem } from "../../design/kit.js";
import type { JourneyStep } from "../../first-run.js";
import type { StepRow } from "../../workspace-ui.js";
import { GuardedHtml } from "../guarded-html.js";
import {
  KApprove, KButton, KChip, KCount, KDisclose, KDocHeader, KDock, KEmpty, KFacts, KHeadlineChip, KInfoLine, KLinkButton, KNote, KOverlay, KRow, KSelect,
  KNotice, KSlots, KStepRows, KTextarea, KTiming, KWork, KWorkRecords, useConversation, useKMenu, usePasswordAsked, type KStepRowItem,
} from "../kit/index.js";
import { RETRY_NOTE_LIMIT } from "../../needs-you.js";
import { TEXT_LIMITS } from "../../text-limits.js";
import { pausedWords } from "../../steer-status.js";
import { fullWhen, shortWhen, viewerZone } from "../../when-html.js";
import { ActivityLine, AlsoViewing, useLiveTask } from "../live-task.js";
import { cn } from "../kit/utils.js";
import { HEADLINE_GLYPH, statusWhyLines } from "./status-summary.js";
import type { GlyphKind } from "../components/ui/status-glyph.js";

/** Bring an element of this page into view: open the step row or the Activity panel that holds it (bodies stay
 * mounted, so it is always found), open the Details drawer when it is there, open every fold around it, then scroll
 * and focus its first field when asked. The one road for hash links (#scope, #holds, #cancel-task…) and ⋯ go-to items
 * alike. */
function revealTarget(id: string, show: (place: Place) => void, focus = false): boolean {
  // #steering (where a sent note comes back to) is the work panel's message box first, then More about this task's notes.
  const target = id === "" ? null : (id === "steering" ? document.querySelector<HTMLElement>('[data-task-panel="activity"] #steering') : null) ?? document.getElementById(id);
  if (target === null) return false;
  const row = target.closest<HTMLElement>("[data-step-row]");
  if (row !== null) show({ row: row.dataset["stepRow"]! });
  if (target.closest("[data-task-panel=\"activity\"]") !== null) show({ activity: true });
  if (target.closest("[data-task-details]") !== null) window.dispatchEvent(new CustomEvent("so:show-details"));
  // After the tab is shown: open the folds, then scroll (a hidden panel has no layout to scroll to).
  requestAnimationFrame(() => {
    for (let node: HTMLElement | null = target; node !== null; node = node.parentElement) {
      if (node instanceof HTMLDetailsElement) node.open = true;
    }
    if (target instanceof HTMLDetailsElement) target.open = true;
    target.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    if (focus) target.querySelector<HTMLElement>("input:not([type=hidden]), textarea, select, button")?.focus({ preventScroll: true });
  });
  return true;
}

/** A link to a fold (#scope, #holds, #cancel-task) opens what holds it, on arrival and on in-page links alike. */
function useRevealHashTarget(show: (place: Place) => void) {
  useEffect(() => {
    const reveal = () => { revealTarget(decodeURIComponent(window.location.hash.slice(1)), show); };
    reveal();
    window.addEventListener("hashchange", reveal);
    return () => window.removeEventListener("hashchange", reveal);
  }, []);
}

/** Trusted server HTML through GuardedHtml; the result view uses this one too. */
export function Html({ html, className }: { html: string; className?: string }) {
  return <GuardedHtml html={html} immutable {...(className === undefined ? {} : { className })} />;
}

/** Retry itself, on the failed box: the task page's requeue (branch and workspace kept), its note for the next
 * attempt starting with the one suggestion of what to change, ready to edit. */
export function RetryForm({ action, note }: { action: string; csrf?: string; note?: string | undefined; variant?: "default" | "attention" }) {
  return <PostForm action={action} data-retry className="k-field">
    <label htmlFor="retry-note" className="k-label">What to change next time</label>
    <KTextarea id="retry-note" name="note" maxLength={RETRY_NOTE_LIMIT} rows={2} defaultValue={note ?? ""} placeholder="Note for the next attempt (optional)" data-retry-note="" />
    <div className="k-acts"><KButton type="submit" variant="primary" label="Retry" data-primary-action="" title="Keeps the branch and workspace" /></div>
  </PostForm>;
}

/** What a failed attempt missed: the evidence line behind it, and where to see the build (or that exact log line). */
function FailureEvidence({ failure }: { failure: NonNullable<BrowserTaskView["failure"]> }) {
  if (failure.evidence === null && failure.link === null) return null;
  return <span className="so-task-evidence" data-failure-evidence>
    {failure.evidence !== null && <span>{failure.evidence}</span>}
    {failure.link !== null && <>{failure.evidence !== null && " "}<a className="k-link" href={failure.link.href} data-failure-log>{failure.link.label}</a></>}
  </span>;
}

/** Stop, on the Building box: the same exact-run stop form the control card posts. */
function StopForm({ stop }: { stop: NonNullable<BrowserTaskView["stop"]> }) {
  return <PostForm action={stop.action} className="task-stop-form" data-task-control="stop" data-control-run={stop.run}>
    <input type="hidden" name="run" value={stop.run} />
    <input type="hidden" name="return" value="task" />
    <KButton type="submit" variant="danger" label="Stop" data-stop-build="" />
  </PostForm>;
}

type LivePause = NonNullable<BrowserTaskView["pause"]>;

/** Pause, beside Stop: stops the current turn of the same live Claude build and keeps it. Hidden once a pause is asked. */
function PauseForm({ pause }: { pause: LivePause }) {
  return <PostForm action={pause.action} data-task-control="pause" data-control-run={pause.run}>
    <input type="hidden" name="run" value={pause.run} />
    <input type="hidden" name="request" value={pause.requests[0]} />
    <input type="hidden" name="return" value="task" />
    <KButton type="submit" label="Pause" data-pause-build="" />
  </PostForm>;
}

/** Resume, on a paused build: it goes on where it stopped, with no note. */
function ResumeForm({ pause }: { pause: LivePause }) {
  return <PostForm action={pause.action} data-task-control="resume" data-control-run={pause.run}>
    <input type="hidden" name="run" value={pause.run} />
    <input type="hidden" name="request" value={pause.requests[2]} />
    <input type="hidden" name="mode" value="resume" />
    <input type="hidden" name="return" value="task" />
    <KButton type="submit" variant="primary" label="Resume" data-resume-build="" />
  </PostForm>;
}

/** Pause and steer's note, under the box: the turn stops first, then the agent gets the note. A paused build only
 * needs the note, so the same form reads Continue there. */
function PauseSteerForm({ pause, onCancel }: { pause: LivePause; onCancel: () => void }) {
  const paused = pause.state === "paused";
  // The note is this attempt's draft (the note box's too): kept through a refusal, cleared only by its own send.
  const [draft, setDraft] = useState<SteerDraft>(() => loadDraft(pause.run));
  const setText = (value: string) => setDraft(previous => {
    const next = previous.submitted ? { ...freshDraft(), text: value } : { ...previous, text: value };
    saveDraft(pause.run, next);
    return next;
  });
  return <PostForm action={pause.action} className="k-field" data-task-control="pause-and-steer" data-control-run={pause.run}
    onSubmit={() => setDraft(previous => { const sent = { ...previous, submitted: true }; saveDraft(pause.run, sent); return sent; })}>
    <input type="hidden" name="run" value={pause.run} />
    {/* The draft's own request: an edited draft is a new request, never a repeat of the last. */}
    <input type="hidden" name="request" value={`steer-${draft.key}`} />
    <input type="hidden" name="key" value={draft.key} />
    <input type="hidden" name="return" value="task" />
    <label htmlFor="pause-steer-note" className="k-label">{paused ? "Note to continue with" : "Note for the agent"}</label>
    <KTextarea id="pause-steer-note" name="note" required autoFocus maxLength={TEXT_LIMITS.note} rows={2} placeholder="What should it do instead?" data-pause-steer-note=""
      value={draft.text} onChange={event => setText(event.target.value)} />
    <div className="k-acts"><KButton type="submit" variant="primary" label={paused ? "Continue" : "Pause and send"} data-pause-steer-send="" />
      <KButton variant="ghost" label="Cancel" onClick={onCancel} /></div>
  </PostForm>;
}

/** Submit a native approval form with the password the kit control collected (or none): the page goes on to the
 * route's answer, and the control keeps its busy face until it does. The server proves the person again. */
function submitNative(form: HTMLFormElement | null, password: string | null): Promise<string | null> {
  if (form === null) return Promise.resolve("This form is no longer on the page. Nothing changed.");
  if (!form.checkValidity()) { form.reportValidity(); return Promise.resolve("Fill in what the form asks for first. Nothing changed."); }
  const token = form.querySelector<HTMLInputElement>('input[name="token"]');
  if (token !== null) token.value = password ?? "";
  form.requestSubmit();
  return new Promise(() => {});
}

/** Check again: Toolroll looks at this computer's processes for the build once more (stop-proof.ts). Nobody vouches
 * that a build stopped, so there is no password and nothing to tick: it only asks Toolroll to look now. */
function RecheckStopped({ form, label }: { form: NonNullable<BrowserTaskView["recheckStopped"]>; label: string }) {
  return <PostForm action={form.action} id="recheck-stopped" data-recheck-stopped={form.run} className="k-acts">
    <input type="hidden" name="run" value={String(form.run)} />
    <KButton type="submit" variant="primary" label={label} data-primary-action="" />
  </PostForm>;
}

/** The plan's approval (src/design/KIT.md "Approval"): four fixed slots, waiting. The act asks for a password only
 * when the rules say so: a password popover when one is needed, one click with Passwordless on or a password
 * remembered on this computer, and nothing to press when a rule approves automatically. The approval covers exactly
 * what was shown: the box keeps the terms it first showed, and says so when newer ones arrive. */
/** Whether the plan's in-place editor (#plan-editor, in the Plan tab) is open: while it is, what the page shows is not
 * what an approval would sign, so nothing approves until Save or Cancel. */
const editorOpen = (): boolean => document.getElementById("plan-editor") instanceof HTMLDetailsElement && (document.getElementById("plan-editor") as HTMLDetailsElement).open;
function usePlanEditing(): boolean {
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    const read = () => setEditing(editorOpen());
    read();
    // A details element's toggle doesn't bubble: listen in the capture phase for the editor anywhere on the page.
    const onToggle = (event: Event) => { if ((event.target as Element | null)?.id === "plan-editor") read(); };
    document.addEventListener("toggle", onToggle, true);
    return () => document.removeEventListener("toggle", onToggle, true);
  }, []);
  return editing;
}

function ApprovalBox({ approve, latest, onEdit, reject = false, inRow = false }: { approve: NonNullable<BrowserTaskView["approve"]>; latest: BrowserTaskView["approve"]; onEdit: (() => void) | null; reject?: boolean;
  /** In the Approval row, which carries the Needs-you chip and the one outline itself. */
  inRow?: boolean }) {
  const ref = useRef<HTMLFormElement>(null);
  const editing = usePlanEditing();
  const changed = latest == null || latest.fields["digest"] !== approve.fields["digest"];
  const until = approve.rememberedUntil === null ? null : new Date(approve.rememberedUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const facts = { ...approve.facts, rememberedUntil: until };
  const terms = approve.termsWords ?? termsOf(approve.kind, facts);
  // Belt and braces: a press that lands while the editor opened is refused in place, never sent.
  const approveNow = (password: string | null) => editorOpen()
    ? Promise.resolve("Save or cancel your edit first: approving now would approve the plan as it was. Nothing changed.")
    : submitNative(ref.current, password);
  const live = !changed && !editing;
  return <PostForm ref={ref} action={approve.action} className="k-approve" data-approval-kind={approve.kind} data-task-approval data-editing={editing ? "" : undefined}>
    {Object.entries(approve.fields).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
    <input type="hidden" name="token" value="" />
    <KSlots wait status={<>{!inRow && <KChip word="Needs you" tone="needs" />}<h2>{approve.heading}</h2></>} text={approve.text}
      acts={changed ? <KButton variant="primary" label="Reload" onClick={() => window.location.reload()} />
        : editing ? <KButton label="Back to the edit" onClick={() => onEdit?.()} />
        : <><KApprove kind={approve.kind} facts={facts} label={approve.label} docked terms={terms} text={approve.text} onApprove={approveNow} />
          {onEdit !== null && <KButton label="Request changes" onClick={onEdit} />}
          {reject && <KLinkButton variant="ghost" label="Reject" href="#cancel-task" data-approval-reject="" />}</>}
      terms={changed ? "The plan changed since this page loaded. Reload to see the version you would approve."
        : editing ? "You’re editing the plan. Save it (it then asks for approval again) or cancel the edit to approve this version." : terms} />
    {/* On a phone the one primary lives in the dock: the same act, the same form. */}
    {live && <KDock><KApprove kind={approve.kind} facts={facts} label={approve.label} terms={terms} text={approve.text} onApprove={approveNow} /></KDock>}
  </PostForm>;
}

/** Ship: the pull request's checks on one elapsed-time axis (`toolroll task ship` is its twin). Merge stays the pull
 * request card's own act. Nothing animates while a check runs: a ring says running. */
function ShipBox({ ship }: { ship: NonNullable<BrowserTaskView["ship"]> }) {
  const chip = ship.state === "failed" ? <KChip word="Check failed" tone="failed" /> : ship.state === "running" ? <KChip word="Checks running" tone="live" />
    : ship.state === "passed" ? <KChip word="Checks passed" tone="done" /> : <KChip word="No current checks" />;
  return <section className="k-sec" aria-label="Ship" data-ship={ship.state}>
    <KTiming label={`Pull request #${ship.pr} · checks`} head="Check" chip={chip} rows={ship.rows}
      foot={<>{ship.summary} on <span className="k-mono">{ship.head}</span> · read <time dateTime={ship.observedAt} title={whenTitle(ship.observedAt)}>{threadWhen(ship.observedAt)}</time></>} />
  </section>;
}

/** A release's own steps, in order on one time axis, where it stands in one line, and why it stopped
 * (`toolroll release status` is its twin). */
function ReleaseBox({ release }: { release: NonNullable<BrowserTaskView["release"]> }) {
  const chip = release.state === "failed" ? <KChip word="Failed" tone="failed" /> : release.state === "done" ? <KChip word="Done" tone="done" />
    : release.state === "waiting" ? <KChip word="Needs you" tone="needs" /> : <KChip word="Running" tone="live" />;
  return <section className="k-sec" aria-label="Release" data-release={release.state}>
    <h3>{release.headline}</h3>
    {release.stopped !== null && <KNotice>{release.stopped.step}: {release.stopped.message} Run the same release command again to continue from there.</KNotice>}
    <KTiming label={`Release ${release.version}`} chip={chip} rows={release.rows}
      foot={<>Tag <span className="k-mono">{release.tag}</span>{release.pr !== null && <> · pull request #{release.pr}</>} · started <time dateTime={release.startedAt} title={whenTitle(release.startedAt)}>{threadWhen(release.startedAt)}</time></>} />
  </section>;
}

/** "Can I merge?" (docs/plans/plain-toolroll.md P1.6; `toolroll task ready` is its twin): one row per fact from
 * Toolroll's records, and each blocker's existing act. Ask the agent to fix is Send back with the blocker as its note,
 * editable before it is sent; Run checks and Retry post exactly as their own boxes do. Nothing here acts on its own. */
function MergeReadyBox({ ready, retry }: { ready: NonNullable<BrowserTaskView["mergeReady"]>; retry: BrowserTaskView["retry"] }) {
  const MARK: Readonly<Record<string, string>> = { yes: "✓", no: "✗", waiting: "…", unknown: "?" };
  const chip = ready.answer === "yes" || ready.answer === "merged" ? <KChip word={ready.answer === "merged" ? "Merged" : "Ready"} tone="done" />
    // "Not yet" is an answer, not a request: a plain chip (the ink one is only for what waits on the viewer).
    : <KChip word="Not yet" />;
  return <section className="k-sec so-merge-ready" aria-label="Can I merge?" data-merge-ready={ready.answer}>
    <div className="so-merge-head">{chip}<h3>Can I merge?</h3></div>
    <p className="so-merge-say">{ready.sentence}</p>
    <ul className="so-merge-rows">
      {ready.rows.map(row => <li key={row.key} data-merge-row={row.key} data-mark={row.mark}>
        <span className="so-merge-mark" aria-hidden="true">{MARK[row.mark] ?? ""}</span>
        <span><strong>{row.label}</strong> <span className="meta">{row.say}</span></span>
        {row.act?.kind === "run-checks" && <PostForm action={row.act.action} className="inline" data-merge-act="run-checks">
          <input type="hidden" name="level" value={row.act.level} />
          <input type="hidden" name="return" value={row.act.returnTo} />
          <KButton type="submit" sm label="Run checks" />
        </PostForm>}
        {row.act?.kind === "retry" && retry != null && <PostForm action={retry.action} className="inline" data-merge-act="retry">
          <KButton type="submit" sm label="Retry" />
        </PostForm>}
        {row.act?.kind === "fix" && <KDisclose summary="Ask the agent to fix">
          <PostForm action={row.act.action} className="k-field" data-merge-act="fix">
            <input type="hidden" name="intent" value="revise" />
            <input type="hidden" name="batch" value={row.act.batch} />
            <input type="hidden" name="source" value={row.act.source} />
            <input type="hidden" name="request" value={row.act.request} />
            <input type="hidden" name="return" value={row.act.returnTo} />
            <KTextarea name="note" rows={3} maxLength={TEXT_LIMITS.note} defaultValue={row.act.note} aria-label="What the agent should fix" />
            <div className="k-acts"><KButton type="submit" label="Ask the agent to fix" title="Sends it back with this note, as Send back does" /></div>
          </PostForm>
        </KDisclose>}
      </li>)}
    </ul>
  </section>;
}

/** The status box's heading: the specific thing it is about, the chip already saying its status. */
function headingOf(card: AssignmentCard): string {
  const need = card.status.need?.key ?? null;
  switch (card.status.headline) {
    case "Needs you":
      return need === "approval" ? "Plan ready" : need === "answer" || need === "questions" ? "A question for you" : need === "hold" ? "On hold"
        : need === "stop-unproven" || need === "vanished" ? "The build stopped" : need === "sign-in" ? "Sign in again"
        : need === "start-builder" || need === "connect-builder" ? "No builder is running" : need === "rebuild" || need === "replan" ? "The plan changed"
        : need === "review-result" ? "Ready for your review" : "Waiting on you";
    case "Ready for review": return "Ready for your review";
    case "Failed": return "A requirement was missed";
    case "Complete": return "Finished";
    // The chip already says Queued: the heading says why it waits, never Queued again. A task that has run already
    // waits to try again; one that hasn't, to start.
    case "Queued": return card.attempts.some(one => one.runId !== null) ? "Retry scheduled" : "Waiting to start";
    default: return card.status.headline;
  }
}

/** How the plan was approved, in one line: by whom, when and how, or the rule that approved it automatically. */
function approvedWords(approved: NonNullable<BrowserTaskView["approved"]>): string {
  const at = shortWhen(approved.at, new Date(), viewerZone());
  return approved.automatic ? `Approved automatically by ${approved.rule ?? "a rule"} · ${at}`
    : `Approved by ${approved.by} · ${at}${approved.how === "" ? "" : ` · ${approved.how}`}`;
}

/** The status box: chip and heading, one sentence, the one act, and a terms line (src/design/KIT.md "Approval"
 * slots). A live build says the step it is on, or the step it is stuck on with the act that helps; Pause, Resume and
 * Stop sit beside it. A failed task says what it missed and offers Retry with its note. The recorded reasons sit
 * under More. */
function StatusBox({ view, card, csrf, approved, watch = null, checksElsewhere = false, resultHere = false, unsent = true }: { view: BrowserTaskView; card: AssignmentCard; csrf: string; approved: BrowserTaskView["approved"];
  /** An unsent note shows here (the work panel, when open, shows it instead: one place at a time). */
  unsent?: boolean;
  /** "Watch the work": opens the Activity panel beside the live build's acts. */
  watch?: (() => void) | null;
  /** The Checks row shows the project checks fact itself. */
  checksElsewhere?: boolean;
  /** The result is right under this box (the Ready row): its link to the result is not offered again. */
  resultHere?: boolean }) {
  const failed = card.status.headline === "Failed";
  const confirm = view.recheckStopped ?? null, rebuild = view.rebuild ?? null, retry = view.retry ?? null, failure = view.failure ?? null;
  const stuck = view.progress?.stuck ?? null;
  const retrying = failed && retry != null && csrf !== "";
  const pause = view.stop != null && csrf !== "" ? view.pause ?? null : null;
  const [steering, setSteering] = useState(false);
  const pausedLine = pause?.state == null || stuck !== null ? null : pause.state === "pausing" ? "Pausing…"
    : pausedWords({ until: pause.until ?? null, limitMs: pause.limitMs ?? null }, iso => shortWhen(iso, new Date(), viewerZone(), true));
  const waits = card.status.headline === "Needs you" || card.status.headline === "Ready for review";
  const acts: ReactNode = confirm != null && csrf !== "" ? <RecheckStopped form={confirm} label={card.action?.label ?? "Check again"} />
    : rebuild != null && csrf !== "" ? <PostForm action={rebuild.action} data-rebuild><KButton type="submit" variant="primary" label={card.action?.label ?? "Retry"} data-primary-action="" /></PostForm>
    : retrying ? <RetryForm action={retry.action} note={retry.note ?? failure?.suggestion} />
    : <>
      {stuck?.action != null ? <KLinkButton label={stuck.action.label} href={stuck.action.href} data-stuck-action="" />
        : card.action !== null && !(resultHere && (card.action.openResult || /[?&]tab=result\b/.test(card.action.href))) && <KLinkButton variant={waits ? "primary" : "outline"} className={waits ? "k-docked" : undefined} label={card.action.label} href={card.action.href} data-primary-action=""
          {...(card.action.openResult ? { "data-open-result": "" } : {})} />}
      {pause !== null && pause.state === null && <PauseForm pause={pause} />}
      {pause !== null && pause.state === "paused" && <ResumeForm pause={pause} />}
      {pause !== null && !steering && <KButton label={pause.state === "paused" ? "Continue with a note" : "Pause and steer"} onClick={() => setSteering(true)} data-pause-steer="" />}
      {view.stop != null && csrf !== "" && <StopForm stop={view.stop} />}
      {watch !== null && <KButton label="Watch the work" onClick={watch} data-watch-work="" />}
    </>;
  const terms: ReactNode = failed && failure != null && !retrying ? <span data-failure-suggestion>What to change: {failure.suggestion}</span>
    : view.record != null ? <a className="k-link" href={view.record.href} data-build-record>{view.record.label}</a>
    : approved != null ? approvedWords(approved) : "";
  const why = statusWhyLines(card.status, [...card.reasons, ...card.diagnostics.map(one => `${one.label} · ${one.detail}`), ...(card.notices?.lines ?? [])]);
  return <div className="k-sec" data-task-status data-work-status={card.token} data-headline={card.status.headline} aria-label="Task status">
    <KSlots wait={waits} status={<>{headingOf(card) !== card.status.headline && <KHeadlineChip headline={card.status.headline} />}<h2>{headingOf(card)}</h2></>}
      text={<>
        <span {...(failed ? { "data-failure-reason": "" } : {})} {...(view.progress != null ? { "data-build-progress": "" } : {})} {...(stuck !== null ? { "data-build-stuck": stuck.step } : {})}>
          {pausedLine !== null ? <span role="status" data-live-pause={pause!.state}>{pausedLine}</span> : card.status.sentence}
        </span>
        {view.activity != null && <ActivityLine activity={view.activity} />}
        {failed && failure != null && <FailureEvidence failure={failure} />}
      </>}
      acts={acts} terms={terms} />
    {pause !== null && steering && <PauseSteerForm key={pause.run} pause={pause} onCancel={() => setSteering(false)} />}
    {/* A note written for an attempt that ended before it went: shown, with a way to send it to the next one. The note
        box itself is the work panel's (Watch the work). */}
    {unsent && <Unsent view={view} csrf={csrf} />}
    <StatusFacts card={card} runChecks={view.runChecks ?? null} only={checksElsewhere ? key => key !== "checks" : null} />
    {why.length > 0 && <KDisclose summary="More">{why.map(one => <KNote key={one}>{one}</KNote>)}</KDisclose>}
  </div>;
}

/** The status's detail rows (Project checks, Requirements, Pull request…) as facts; Run checks runs in place. */
function StatusFacts({ card, runChecks, only = null }: { card: AssignmentCard; runChecks: BrowserTaskView["runChecks"]; only?: ((key: string) => boolean) | null }) {
  const details = only === null ? card.status.details : card.status.details.filter(one => only(one.key));
  if (details.length === 0) return null;
  return <KFacts rows={details.map(detail => {
    const inPlace = runChecks != null && detail.action?.href === runChecks.action;
    const text = detail.href === null ? detail.text : <a className="k-link" href={detail.href}>{detail.text}</a>;
    const act = detail.action === null ? null : inPlace
      ? <PostForm action={runChecks!.action} data-run-checks className="so-inline-form"><input type="hidden" name="level" value={runChecks!.level} /><input type="hidden" name="return" value={runChecks!.returnTo} />
          <KButton type="submit" variant="ghost" sm label={detail.action.label} data-detail-action="" /></PostForm>
      : detail.action.href === null ? <span>{detail.action.label}</span>
      : <a className="k-link" href={detail.action.href} data-detail-action>{detail.action.label}</a>;
    return [detail.label, <span key={detail.key} data-status-detail={detail.key} data-mark={detail.mark}>{text}{act !== null && <> · {act}</>}</span>] as const;
  })} />;
}

/** A quiet in-page disclosure (native details: content stays in the page). `flatten`: opening it opens every fold in
 * it, so one tap shows it all (never a fold inside a fold). */
function Fold({ summary, flatten, children }: { summary: string; flatten?: boolean; children: ReactNode }) {
  return <details className="k-disclose" {...(flatten ? { onToggle: (event: SyntheticEvent<HTMLDetailsElement>) => {
    if (event.currentTarget.open) event.currentTarget.querySelectorAll("details").forEach(one => { one.open = true; });
  } } : {})}><summary>{summary}</summary>{children}</details>;
}

function FactValue({ fact }: { fact: BrowserTaskFact }) {
  return <>{fact.parts.map((part, index) => typeof part === "string"
    ? <span key={index}>{part}</span>
    : "at" in part
      ? <time key={index} dateTime={part.at} title={whenTitle(part.at)} className="k-num">{threadWhen(part.at)}</time>
    : "seal" in part
      ? <code key={index} className="k-mono">{part.seal}</code>
      : <a key={index} href={part.href}>{part.label}</a>)}</>;
}

/** "16:39" today, "Yesterday 16:39", else "Sep 28", in the viewer's zone: the one formatter every time on every
 * surface goes through (when-html.ts); the exact minute in the title (`whenTitle`). */
export function threadWhen(iso: string, now = new Date()): string {
  return Number.isNaN(new Date(iso).getTime()) ? "" : shortWhen(iso, now, viewerZone());
}
export const whenTitle = (iso: string): string => fullWhen(iso, viewerZone());

/** One server-side thread entry: when, who and what, then its words, link and card. */
function ThreadEntry({ item }: { item: BrowserTaskThreadItem }) {
  return <li data-thread-entry={item.key} data-thread-kind={item.kind} className="so-thread-entry">
    <p className="so-thread-line"><time className="k-num" dateTime={item.at} title={whenTitle(item.at)}>{threadWhen(item.at)}</time>
      <span><b>{item.title}</b>{item.author !== "" && <> <span className="k-muted">{item.author}</span></>}</span></p>
    {/* An entry with no words shows none: never an empty bubble. */}
    {item.text !== null && item.text.trim() !== "" && <p className={item.who === "person" ? "so-thread-text so-thread-quote" : "so-thread-text"}>{item.text}</p>}
    {item.link !== null && <p className="so-thread-text"><a className="k-link" href={item.link.href}>{item.link.label}</a></p>}
    {item.html !== "" && <div className="so-thread-text"><Html html={item.html} className="so-thread-card" /></div>}
    {item.more !== null && <div className="so-thread-text"><Fold summary={item.more.summary} flatten><Html html={item.more.html} className="so-thread-card" /></Fold></div>}
  </li>;
}

/** The conversation's part of the thread: each message keyed by its time, rendered by the shell (it owns the cards). */
export type ThreadChat = { entries: { key: string; at: string; node: ReactNode }[]; footer: ReactNode };

/** The thread: server entries and conversation messages in one time order, then the composer. */
function Thread({ items, chat, chatHref, footer = true }: { items: BrowserTaskThreadItem[]; chat: ThreadChat | null; chatHref: string | null; footer?: boolean }) {
  const entries = [
    ...items.map(item => ({ key: `item-${item.key}`, at: item.at, node: <ThreadEntry key={`item-${item.key}`} item={item} /> })),
    ...(chat?.entries ?? []),
  ].sort((a, b) => a.at === b.at ? 0 : a.at < b.at ? -1 : 1);
  return <section aria-label="Activity" data-task-thread {...(chat === null ? {} : { "data-workspace-chat": "" })} className="k-sec">
    {entries.length === 0 && <KEmpty title="Nothing has happened yet." />}
    <ol className="so-thread">{entries.map(one => one.node)}</ol>
    {footer && (chat !== null ? chat.footer
      : chatHref !== null && <KNote><a className="k-link" href={chatHref}>Message the agent</a> from Chat.</KNote>)}
  </section>;
}

/** An attempt's glyph: its label ends with the task's headline ("Correction 1 · Needs you"), and a headline's glyph
 * is the one every list wears for it, so the timeline and every list agree. */
export function attemptGlyph(label: string): GlyphKind {
  const word = label.split(" · ").at(-1) ?? "";
  const headline = HEADLINES.find(one => one === word);
  return headline === undefined ? "idle" : HEADLINE_GLYPH[HEADLINE_TONE[headline]];
}

/** The Details drawer: the task's properties grouped Work, Links, Review and About. Read-only facts: every form lives
 * in a tab (docs/plans/one-page-task-and-agent.md). */
export function TaskDetails({ view }: { view: BrowserTaskView }) {
  const groups: BrowserTaskDetailGroup[] = (view.details ?? []).filter(group => group.facts.length > 0);
  return <div className="k-sec" data-task-details>
    {groups.map(group => <section key={group.title} className="k-sec" aria-label={group.title} data-detail-group={group.title}>
      <h3>{group.title}</h3>
      <KFacts rows={group.facts.map(fact => [fact.label, <span key={fact.label} data-detail-fact={fact.label}><FactValue fact={fact} /></span>] as const)} />
    </section>)}
  </div>;
}

/** "More about this task": what the work is and what it waits on first, then its options, then the records. */
const PLAN_ORDER = ["scope", "waits-for", "holds", "steering", "task-diagnostics"];
const planRank = (id: string): number => { const at = PLAN_ORDER.indexOf(id); return at === -1 ? PLAN_ORDER.length : at; };

/** One section under the rows, flat: its heading and its content, open, never a fold. */
function PlanSection({ section }: { section: BrowserTaskSection }) {
  return <section id={section.id} aria-labelledby={`plan-${section.id}`} className="k-sec so-plan-sec" data-task-section={section.id}>
    <h3 id={`plan-${section.id}`}>{section.title}{section.count !== null && section.count > 0 && <> <KCount n={section.count} /></>}</h3>
    <Html html={section.html} className="so-task-fold" />
  </section>;
}

/** More about this task, under the rows: the scope and agents, dependencies and holds, the records, the task's options,
 * and Cancel — armed behind one deliberate tap, last. (The plan the approval signs is the Plan / Approval row's.) */
function MoreAboutTask({ view, approval }: { view: BrowserTaskView; approval: boolean }) {
  const sections = [...view.sections, ...view.manage].map((one, index) => ({ one, index })).sort((a, b) => planRank(a.one.id) - planRank(b.one.id) || a.index - b.index).map(({ one }) => one);
  if (sections.length === 0 && view.cancel === null && !approval) return null;
  return <section className="k-sec so-task-more" aria-labelledby="task-more" data-task-more-about="">
    <h2 id="task-more" className="so-task-more-h">More about this task</h2>
    {approval && <Html key={approvalIdentity(view.approval)} html={view.approval} className="so-task-approval" />}
    {sections.map(one => <PlanSection key={one.id} section={one} />)}
    {view.cancel !== null && <details id="cancel-task" open={view.cancel.open} className="k-disclose so-cancel" data-task-section="cancel">
      <summary>Cancel task</summary>
      <Html html={view.cancel.html} className="so-task-cancel" />
    </details>}
  </section>;
}

/** The Result tab: the chosen attempt's result as its result page shows it — evidence, your checks, the decision —
 * with the attempts to pick from. Nothing yet: one line saying so. */
function ResultPanel({ view, loaded, csrf, result }: { view: BrowserTaskView; loaded: BrowserTaskView["result"]; csrf: string; result: ResultSlot | undefined }) {
  // The result this page loaded stays as it was: its evidence, its checks and its decision always agree, and the
  // result's own script stays bound to the forms it found. A newer one (another run, the same run's checks finishing,
  // a first result) is announced with Reload; never swapped in under the person's hands.
  const shown = loaded ?? null;
  const now = view.result ?? null;
  const newer = now !== null && (shown === null || now.selected.build !== shown.selected.build || now.revision !== shown.revision);
  const notice = newer && <div role="status" className="k-acts" data-result-newer>
    <KInfoLine>{shown === null ? "A result is ready." : now.selected.build !== shown.selected.build ? "A newer result is ready." : "This result was updated."}</KInfoLine>
    <KButton sm label="Reload" onClick={() => window.location.reload()} />
  </div>;
  if (shown === null || result === undefined) return <div className="k-sec" data-task-result="none">{notice || <KEmpty title="No result yet." text="It shows here once a build finishes." />}</div>;
  const picked = shown.attempts.find(one => one.current) ?? null;
  return <div className="k-sec" data-task-result={shown.selected.build ?? "none"}>
    {notice}
    {shown.attempts.length > 1 && <div className="k-acts" data-result-attempts={shown.attempts.length}>
      <span className="k-muted">{shown.current ? "Latest result" : "An earlier attempt"}</span>
      <KSelect sm aria-label="Result of attempt" value={picked?.href ?? ""} onChange={event => { if (event.target.value !== "") window.location.assign(event.target.value); }}
        items={[...(picked === null ? [["", "Pick an attempt"] as const] : []), ...shown.attempts.map(one => [one.href, one.label] as const)]} data-result-attempt-picker="" />
    </div>}
    {result(shown.selected, csrf, shown.current)}
  </div>;
}

/** The Result tab's body, given by the page that hosts it (the result view's own component, kept out of this module). */
export type ResultSlot = (selected: NonNullable<BrowserTaskView["result"]>["selected"], csrf: string, current: boolean) => ReactNode;

/** The Attempts tab: every version of the task and the builds that stopped before this one. */
function AttemptsPanel({ view }: { view: BrowserTaskView }) {
  const card = view.status;
  const versions = card?.attempts ?? [];
  const earlier = view.earlier?.attempts ?? [];
  if (versions.length <= 1 && earlier.length === 0) return <KEmpty title="One attempt so far." text="Each new build or revision of this task shows here." />;
  return <div className="k-sec" data-attempts>
    {versions.length > 1 && <section aria-label="Versions" data-attempt-timeline>
      {versions.map(attempt => {
        const parts = attempt.label.split(" · ");
        const word = parts.at(-1) ?? "";
        const headline = HEADLINES.find(one => one === word) as Headline | undefined;
        return <KRow key={attempt.taskId} href={attempt.href} chip={headline === undefined ? <KChip word={word} /> : <KHeadlineChip headline={headline} />}
          title={parts.length > 1 ? parts.slice(0, -1).join(" · ") : attempt.label} desc={attempt.detail ?? ""}
          meta={attempt.runId === null ? undefined : <span className="k-num">Build #{attempt.runId}</span>} />;
      })}
    </section>}
    {earlier.length > 0 && <section aria-label="Earlier builds" data-earlier-attempts={earlier.length}>
      {earlier.map(one => <KRow key={one.href} href={one.href} chip={<KChip word="Stopped" />} title={one.label} desc={one.text ?? ""} />)}
    </section>}
    {card?.lead != null && <KNote>Lead: {card.lead.label}{card.lead.active ? "" : " · access ended"}</KNote>}
  </div>;
}

/** ⋯ More actions: the task's secondary acts in one menu, the same order everywhere — Work, Share & reuse, Danger
 * last. A one-click POST submits its own small form (outside the menu, so closing the menu never drops it); a go-to
 * opens what holds the item's one form (a row, the Activity panel), opens it and focuses it. */
function MoreMenu({ items, show }: { items: BrowserTaskMore[]; show: (place: Place) => void }) {
  const forms = useRef(new Map<number, HTMLFormElement | null>());
  const menu = useKMenu();
  if (items.length === 0) return null;
  const order = { work: 0, share: 1, danger: 2 } as const;
  const sorted = items.map((item, index) => ({ item, index })).sort((a, b) => order[a.item.group] - order[b.item.group] || a.index - b.index);
  const select = (item: BrowserTaskMore, index: number) => {
    if (item.kind === "post") forms.current.get(index)?.requestSubmit();
    else if (item.kind === "goto") { if (item.tab === "activity") show({ activity: true }); revealTarget(item.target, show, true); }
    else if (item.kind === "link") window.location.assign(item.href);
    else void navigator.clipboard?.writeText(window.location.href).catch(() => {});
  };
  return <>
    <KButton variant="ghost" sm iconOnly="more" label="More actions" aria-haspopup="dialog" data-task-more=""
      onClick={event => menu(event.currentTarget, "More actions", sorted.map(({ item, index }) => ({ label: item.label, act: () => select(item, index) })))} />
    {items.map((item, index) => item.kind !== "post" ? null : <PostForm key={index} action={item.action} hidden ref={form => { forms.current.set(index, form); }} data-more-form={item.label}>
      {Object.entries(item.fields).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
    </PostForm>)}
  </>;
}

/** The approval region's identity: whether it leads open or sits folded, and the digest it signs. The nonce (new on
 * every render) is deliberately not part of it. */
export function approvalIdentity(approval: string): string {
  // Read from the region's own wrapper and its hidden field, never from text inside it: the server escapes every quote
  // in the plan's words, so an attribute with its quotes can only be markup.
  const folded = /^\s*<details class="task-secondary-approval"/.test(approval);
  const digest = /<input type="hidden" name="digest" value="([^"]*)"/.exec(approval)?.[1] ?? "";
  return `${folded ? "folded" : "open"}:${digest}`;
}

/** The task's road (first-run.ts taskRoad) as the kit's compact progress line: Plan · Approval · Build · Checks ·
 * Ready, the step that waits on you ink, a running one blue, one that stopped red, and why under its name. */
export function stepsOf(road: readonly JourneyStep[]): StepItem[] {
  return road.map(step => {
    const state: StepItem["state"] = step.state === "done" || step.state === "skipped" ? "done"
      : step.state === "current" ? (step.needsYou ? "now" : "live") : step.state === "stuck" ? (step.needsYou ? "now" : "failed") : "todo";
    const sub = step.needsYou && (step.state === "current" || step.state === "stuck") ? (step.key === "ready" ? "your review" : "needs you")
      : step.say ?? (step.state === "skipped" ? "skipped" : "");
    return { label: step.label, state, ...(sub === "" ? {} : { sub }) };
  });
}

/** Where a link or a go-to lands: a step row (opened), or the Activity panel. */
type Place = { row: string } | { activity: true };
/** The address's tab (`tab=`) as the row it opens: Result is Ready, Attempts is Build, Plan is the step happening now;
 * Activity is the panel. */
const rowOfTab = (tab: string | null | undefined): string | null => tab === "result" ? "ready" : tab === "attempts" ? "build" : null;

/** The plan's steps in the live Build row: each one's state as the latest checkpoint reported it. */
function BuildSteps({ steps }: { steps: NonNullable<NonNullable<BrowserTaskView["progress"]>["steps"]> }) {
  if (steps.length === 0) return null;
  const WORD = { pending: "not started", current: "in progress", completed: "done", blocked: "stuck" } as const;
  return <ol className="so-build-steps" aria-label="Plan steps" data-build-steps="">
    {steps.map((step, index) => <li key={index} data-state={step.state} aria-current={step.state === "current" ? "step" : undefined}>
      <span className="so-build-step-mark" aria-hidden="true">{step.state === "completed" ? "" : index + 1}</span>
      <span>{step.title}<span className="k-sr">, {WORD[step.state]}</span></span>
    </li>)}
  </ol>;
}

/** A note this tab wrote for an attempt that has ended: offered to the next attempt (UnsentNote). Never the running one's. */
function Unsent({ view, csrf }: { view: BrowserTaskView; csrf: string }) {
  if (csrf === "" || (view.steerRecent?.length ?? 0) === 0) return null;
  const running = new Set([view.steering?.steer?.run, view.pause?.run, view.work?.live ? view.work.run : undefined]);
  return <UnsentNote key={view.steerRecent!.join(",")} runs={view.steerRecent!.filter(run => !running.has(run))} action={`/t/${encodeURIComponent(view.id)}/steer`} back="task" />;
}

/** A password field in server HTML: such a card never renders inside the work panel. */
const ASKS_PASSWORD = /<input\b[^>]*[\s"']type\s*=\s*["']?password/i;

/** Where the work panel stays open or closed, for this viewer (a convenience: the page works without it). */
const WORK_SETTING = "toolroll.task.work";
/** Left open last time, and there is room for it beside the rows: a sheet or a phone's full screen opens only when asked,
 * so a remembered panel never covers what the page asks of the viewer (an approval, a result). */
function savedWorkOpen(): boolean {
  try { return window.localStorage.getItem(WORK_SETTING) === "open" && window.matchMedia("(min-width: 1100px)").matches; } catch { return false; }
}
function keepWorkOpen(open: boolean): void {
  try { window.localStorage.setItem(WORK_SETTING, open ? "open" : "closed"); } catch { /* this browser keeps no settings */ }
}

/**
 * The work panel (docs/plans/task-page-steps.md "Watch the work"): the live or latest build's records as a chat — what
 * the agent said, each action as one quiet line, the notes people sent with their read state — then the task's thread,
 * and the message box at the foot. The box follows what the attempt takes (steer-capabilities.ts): a note now, a note
 * for its mailbox, or the capability's own sentence when it takes none; with no live attempt it is the task's
 * conversation with the lead. A draft written for an attempt stays that attempt's (an unsent note when it ends), never
 * the lead's. Nothing here approves anything, and no ceremony renders in it. Hidden, never unmounted.
 */
function WorkPanel({ view, chat, csrf, open, onClose, onClick }: { view: BrowserTaskView; chat: ThreadChat | null; csrf: string; open: boolean; onClose: () => void;
  /** The page's in-page link handling (a link to this page's own result or step opens it in place). */
  onClick: (event: MouseEvent<HTMLElement>) => void }) {
  const work = view.work ?? null;
  // A password on the page (a ceremony, or the approval popover while it is open): the reader asks for nothing until it
  // is gone. A closed panel reads nothing either.
  const asked = usePasswordAsked();
  const conversation = useConversation(work?.transcript ?? null, work?.live === true, asked || !open);
  const steering = csrf !== "" && work?.live === true ? view.steering ?? null : null;
  const agent = work?.agent ?? "the agent";
  // Notes this run's records already show are not repeated in the thread under them.
  const shownNotes = new Set(conversation.notes.map(note => `steer-${note.id}`));
  const thread = (view.thread ?? []).filter(item => !shownNotes.has(item.key))
    .map(item => ASKS_PASSWORD.test(item.html) || ASKS_PASSWORD.test(item.more?.html ?? "") ? { ...item, html: "", more: null, link: item.link ?? { label: "Open it on the task page", href: `/t/${encodeURIComponent(view.id)}` } } : item);
  const off = work !== null && (work.transcript === null || conversation.state === "off" || (conversation.final && conversation.items.length === 0));
  const pause = steering?.controls.pause != null && steering.controls.pause.state === null ? steering.controls.pause : null;
  const box = steering !== null
    ? <div id="steering" className="so-work-box" data-task-steering="">
      {steering.steer === null || steering.controls.send === null
        // It takes no notes now: the capability's own sentence instead of a box.
        ? <p className="k-note" data-work-no-notes="">{steering.controls.words}</p>
        : <SteerNote key={steering.steer.run} steer={steering.steer} controls={{ ...steering.controls, pause }} back="task" label={`Message ${agent}`} note={steering.controls.words} />}
    </div>
    : <div className="so-work-box" data-work-lead="">
      {chat !== null ? chat.footer : view.chatHref != null && <KNote><a className="k-link" href={view.chatHref}>Message the lead</a> from Chat.</KNote>}
    </div>;
  const who = work === null ? "No build yet" : `${work.agent} · ${work.live ? "working" : "finished"}`;
  return <KWork id="task-activity" title="Activity" who={who} live={work?.live === true} onClose={onClose} closeLabel="Close activity" closeData={{ "data-close-activity": "" }} onClick={onClick}
    hidden={!open} data-task-panel="activity" data-work-state={work === null ? "none" : asked ? "paused" : off ? "off" : steering === null ? (work.live ? "watching" : "ended") : steering.controls.send ?? "no-notes"}
    foot={<>{open && <Unsent view={view} csrf={csrf} />}{box}</>}>
    {work !== null && <section aria-label="The agent's work" className="so-work-records" data-work-run={work.run}>
      <KWorkRecords conversation={conversation} live={work.live} paused={asked} older={count => `${count} earlier ${count === 1 ? "note is" : "notes are"} in the task's history below.`} />
      {off && !asked && view.activity != null && <ActivityLine activity={view.activity} />}
    </section>}
    <Thread items={thread} chat={chat} chatHref={null} footer={false} />
  </KWork>;
}

/** The page (docs/plans/task-page-steps.md): one header, then the steps are the page — each row's body holds its own
 * part (the plan, the approval and the plan it signs, the build and its attempts, the checks, the result); then More
 * about this task, and the Activity panel. Details opens as a drawer. */
export function TaskView({ view, chat = null, csrf = "", result }: { view: BrowserTaskView; chat?: ThreadChat | null; details?: boolean; csrf?: string; result?: ResultSlot }) {
  // The result the page loaded with (a later one is announced in its row, never swapped in).
  const loadedResult = useRef(view.result ?? null);
  const hasResult = loadedResult.current !== null;
  const rows = view.steps ?? null;
  // The approval keeps the terms it first showed (src/design/KIT.md): a refresh never swaps them under a person's hands.
  const shownApproval = useRef(view.approve ?? null);
  if (shownApproval.current === null && view.approve != null) shownApproval.current = view.approve;
  const approve = view.approve != null ? shownApproval.current : null;
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => {
    const keys = new Set<string>((rows ?? []).filter(row => row.open).map(row => row.key));
    const asked = rowOfTab(view.tab);
    if (asked !== null && rows?.some(row => row.key === asked && row.opens)) keys.add(asked);
    if (approve !== null) keys.add("approve");
    return keys;
  });
  // The work panel: ?tab=activity opens it; otherwise as this viewer last left it.
  const [activity, setActivityState] = useState(() => view.tab === "activity" || savedWorkOpen());
  const setActivity = (open: boolean) => { setActivityState(open); keepWorkOpen(open); };
  const [details, setDetails] = useState<HTMLElement | null>(null);
  const detailsButton = useRef<HTMLButtonElement>(null);
  // The step happening now opens as it moves (a live update), whatever the person opened or closed before.
  const currentKey = rows?.find(row => row.state === "current" || row.state === "stuck")?.key ?? null;
  useEffect(() => { if (currentKey !== null) setOpened(previous => previous.has(currentKey) ? previous : new Set([...previous, currentKey])); }, [currentKey]);
  const setTab = (tab: string | null) => {
    try {
      const url = new URL(window.location.href);
      if (tab === null) url.searchParams.delete("tab"); else url.searchParams.set("tab", tab);
      if (tab !== null) url.searchParams.delete("section");
      history.replaceState(history.state, "", url.pathname + url.search + url.hash);
    } catch { /* the address is a convenience; the place is shown either way */ }
  };
  const show = (place: Place) => {
    if ("activity" in place) { setActivity(true); setTab("activity"); return; }
    setOpened(previous => previous.has(place.row) ? previous : new Set([...previous, place.row]));
  };
  const toggle = (key: string) => setOpened(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const activityButton = useRef<HTMLButtonElement>(null);
  const closeActivity = () => { setActivity(false); setTab(null); if (document.activeElement?.closest("[data-task-panel]")) activityButton.current?.focus({ preventScroll: true }); };
  /** Open the panel. Beside the page it is simply there; as a sheet or full screen it takes the focus. */
  const openActivity = () => {
    show({ activity: true });
    requestAnimationFrame(() => {
      if (window.matchMedia("(max-width: 1099px)").matches) document.querySelector<HTMLElement>("[data-task-panel] [data-close-activity]")?.focus({ preventScroll: true });
    });
  };
  useRevealHashTarget(show);
  useEffect(() => {
    const open = () => setDetails(detailsButton.current ?? document.body);
    window.addEventListener("so:show-details", open);
    return () => window.removeEventListener("so:show-details", open);
  }, []);
  const people = useLiveTask(view.live);
  const approvalHere = view.approval !== "" && (view.approvalPlacement ?? "lead") === "lead" && approve === null;
  const scrollTo = (selector: string) => requestAnimationFrame(() => document.querySelector(selector)?.scrollIntoView({ block: "start",
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" }));
  // A link to this very page's other part (the status's Review result, a build in the thread) opens it in place.
  const inPage = (event: MouseEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = (event.target as HTMLElement).closest?.("a[href]");
    if (!(anchor instanceof HTMLAnchorElement)) return;
    const to = new URL(anchor.href, window.location.href), here = new URL(window.location.href);
    const wanted = to.searchParams.get("tab");
    if (to.origin !== here.origin || to.pathname !== here.pathname || (wanted !== "result" && wanted !== "plan" && wanted !== "activity" && wanted !== "attempts")) return;
    if ((to.searchParams.get("version") ?? "") !== (here.searchParams.get("version") ?? "")) return;
    const run = to.searchParams.get("run");
    if (wanted === "result" && run !== null && String(view.result?.selected.build ?? "") !== run) return;
    if (to.searchParams.get("section") !== null && to.searchParams.get("section") !== here.searchParams.get("section")) return;
    const row = wanted === "plan" ? currentKey : rowOfTab(wanted);
    if (wanted !== "activity" && rows !== null && (row === null || !rows.some(one => one.key === row && one.opens))) return;
    event.preventDefault();
    if (wanted === "activity") openActivity();
    else if (row !== null) { show({ row }); setTab(wanted === "plan" ? null : wanted); scrollTo(`[data-step-row="${row}"]`); }
    if (to.hash !== "") revealTarget(decodeURIComponent(to.hash.slice(1)), show);
  };
  const editPlan = approve === null ? null : () => { show({ row: "approve" }); revealTarget("plan-editor", show, true); };
  const meta = <>{view.project !== null && <>{view.project} · </>}<span className="k-mono">{view.id}</span>{view.scout && <> · research only</>}
    {people.length > 0 && <> · <AlsoViewing people={people} /></>}</>;
  const record = view.audit ?? null;
  const needs = view.status?.status.headline === "Needs you" || view.status?.status.headline === "Ready for review";
  const primary = approve === null && needs && view.status?.action != null && view.recheckStopped == null && view.rebuild == null && view.retry == null
    && !(rows !== null && hasResult && (view.status.action.openResult || /[?&]tab=result\b/.test(view.status.action.href)))
    ? <KLinkButton variant="primary" label={view.status.action.label} href={view.status.action.href} /> : null;
  // Lead cards attach to their row: a problem to the step that stopped, a pull request to Ready, a missing plan to
  // Approval, the build's control and its live attempt (files changing) to Build; the rest stay under the rows.
  const stuckKey = rows?.find(row => row.state === "stuck")?.key ?? currentKey;
  // A refusal while the approval form is on the page sits with that form, wherever the road stands.
  const ATTACHED: Readonly<Record<string, string | null>> = { problem: approve !== null ? "approve" : stuckKey, "pull-request": "ready", "needs-scope": "approve", control: "build", attempt: "build" };
  const leadOf = (key: string) => rows === null ? [] : view.lead.filter(block => ATTACHED[block.key] === key && rows.some(row => row.key === key && row.opens));
  const unattached = view.lead.filter(block => rows === null || !rows.some(row => row.key === ATTACHED[block.key] && row.opens));
  const leadCards = (blocks: readonly { key: string; html: string }[]) => blocks.map(block => <Html key={block.key} html={block.html} className={`so-task-lead so-task-lead--${block.key}`} />);
  // Where the status box goes: the step happening now, else the last one reached.
  const statusKey = currentKey ?? rows?.find(row => row.open)?.key ?? null;
  const readyOpens = rows?.some(row => row.key === "ready" && row.opens) ?? false;
  const checksOpens = rows?.some(row => row.key === "checks" && row.opens) ?? false;
  const resultBody = (hasResult || view.result != null) ? <ResultPanel view={view} loaded={loadedResult.current} csrf={csrf} result={result} /> : null;
  // "Can I merge?" belongs to a result: it shows with one (in the Ready row), never loose under the rows, and never
  // on a research task (a report has nothing to merge).
  const readyExtras = (withResult: boolean) => <>
    {view.release != null && <ReleaseBox release={view.release} />}
    {withResult && view.mergeReady != null && !view.scout && <MergeReadyBox ready={view.mergeReady} retry={view.retry ?? null} />}
    {view.ship != null && <ShipBox ship={view.ship} />}
  </>;
  const statusBox = (key: string | null) => approve !== null ? null : view.status !== null
    // In a row, the Approval row says who approved: the status box doesn't repeat it.
    ? <StatusBox view={view} card={view.status} csrf={csrf} approved={key === null ? view.approved ?? null : null} watch={key === "build" && view.stop != null ? openActivity : null} unsent={!activity}
      checksElsewhere={checksOpens && key !== "checks"} resultHere={key === "ready" && resultBody !== null} />
    : <Html html={view.statusHtml} />;
  const bodyOf = (row: StepRow): ReactNode => {
    const here = row.key === statusKey;
    const status = here ? statusBox(row.key) : null;
    switch (row.key) {
      case "plan":
        // Installed once, and again when what it holds changes: the plan sheet joins it once the plan is approved
        // (here or in another window), and a new plan version is a new sheet.
        return <>{status}{leadCards(leadOf("plan"))}{view.plan != null && view.plan.html !== "" && <Html key={view.plan.key} html={view.plan.html} className="so-task-plan" />}</>;
      case "approve":
        if (approve !== null) return <div className="so-approval-step" key={`approve:${approve.fields["digest"] ?? ""}`} data-approval-step="">
          {/* Why the last yes wasn't taken reads first, above the form it answers. */}
          {leadCards(leadOf("approve").filter(block => block.key === "problem"))}
          <ApprovalBox approve={approve} latest={view.approve ?? null} onEdit={editPlan} reject={view.cancel !== null} inRow />
          <div className="so-approval-sheet"><Html html={approve.planHtml} className="so-task-plan" /></div>
          {leadCards(leadOf("approve").filter(block => block.key !== "problem"))}
        </div>;
        return <>{status}
          {row.state === "done" && view.approved != null && <KInfoLine>{approvedWords(view.approved)}</KInfoLine>}
          {/* The approval region the server drew (a blocked or closed approval, a fold of updated terms): installed once,
              and a new region when what it is changes (folded or open, and the exact plan it signs). */}
          {view.approval !== "" && <Html key={approvalIdentity(view.approval)} html={view.approval} className="so-task-approval" />}
          {leadCards(leadOf("approve"))}</>;
      case "build":
        return <>{status}
          {row.state === "current" && view.progress?.steps != null && <BuildSteps steps={view.progress.steps} />}
          {leadCards(leadOf("build"))}
          {/* The task's history stays in Build whatever the build is doing: while a revision is planned, built or stopped. */}
          {(row.state === "done" || (view.status?.attempts.length ?? 0) > 1 || (view.earlier?.attempts.length ?? 0) > 0) && <AttemptsPanel view={view} />}</>;
      case "checks":
        return <>{status}{!here && view.status !== null && <StatusFacts card={view.status} runChecks={view.runChecks ?? null} only={key => key === "checks"} />}{leadCards(leadOf("checks"))}</>;
      case "ready":
        return <>{status}{resultBody}{readyExtras(resultBody !== null)}{leadCards(leadOf("ready"))}</>;
    }
  };
  const items: KStepRowItem[] = (rows ?? []).map(row => {
    const here = row.state === "current" || row.state === "stuck";
    return { key: row.key, label: row.label, mark: row.mark, sentence: row.sentence, needsYou: row.needsYou, current: here,
      at: row.at, when: row.at === null ? "" : threadWhen(row.at), body: row.opens || here ? bodyOf(row) : undefined,
      toggle: row.opens && !here && !(row.key === "approve" && approve !== null), open: here || opened.has(row.key) || (row.key === "approve" && approve !== null) };
  });
  return <div data-kit-page data-task-page={view.id} className={cn("so-task-page", activity && "so-task-page--work")}
    onKeyDown={event => { if (event.key === "Escape" && activity && (event.target as HTMLElement).closest?.("[data-task-panel]") && window.matchMedia("(max-width: 1099px)").matches) closeActivity(); }}>
    <div className="k-doc" onClick={inPage}>
      <KDocHeader back={["/tasks", "Tasks"]} title={view.title} meta={meta}
        right={<nav className="k-acts so-task-tools" aria-label="Task tools">
          {record !== null && <KLinkButton variant="ghost" sm className="k-desk-only" label={record.label} href={record.href} />}
          <KButton ref={activityButton} variant="ghost" sm label="Activity" aria-expanded={activity} aria-controls="task-activity" onClick={() => activity ? closeActivity() : openActivity()} data-open-activity="" />
          <KButton ref={detailsButton} variant="ghost" sm lead="panel" label="Details" className="k-desk-only" aria-haspopup="dialog" onClick={event => setDetails(event.currentTarget)} data-open-details="" />
          <KButton variant="ghost" sm iconOnly="panel" label="Details" className="k-phone-only" aria-haspopup="dialog" onClick={event => setDetails(event.currentTarget)} />
          <MoreMenu items={[...(view.more ?? []), ...(view.everyTime ? [{ group: "share" as const, label: "Do this every time…", kind: "link" as const, href: view.everyTime.href }] : [])]} show={show} />
        </nav>} />
      {view.version !== null && <KInfoLine>{view.version.label} · <a className="k-link" href={view.version.current.href}>{view.version.current.label}</a></KInfoLine>}
      {view.archived != null && <KSlots status={<><KChip word="Archived" /><h2>Put away</h2></>}
        text={<>{view.archived.words} · <time dateTime={view.archived.at} title={fullWhen(view.archived.at, viewerZone())}>{shortWhen(view.archived.at, new Date(), viewerZone())}</time></>}
        acts={view.archived.restore !== null ? <PostForm action={view.archived.restore.action}>
          <input type="hidden" name="return" value={view.archived.restore.returnTo} />
          <KButton type="submit" variant="primary" label="Restore" data-restore="" />
        </PostForm> : null}
        terms={view.archived.restore !== null ? "Restoring puts it back in Tasks. Its history and results were kept." : "An approver can restore it."} />}
      {rows !== null ? <KStepRows label="Steps" rows={items} onToggle={toggle} /> : <>
        {/* No road (cancelled, or no status): the status block as it was, then what the task holds. */}
        {approve !== null && <ApprovalBox approve={approve} latest={view.approve ?? null} onEdit={editPlan} reject={view.cancel !== null} />}
        {approve !== null && <Html html={approve.planHtml} className="so-task-plan" />}
        {approve !== null ? null : view.status !== null ? <StatusBox view={view} card={view.status} csrf={csrf} approved={view.approved ?? null} unsent={!activity} /> : <Html html={view.statusHtml} />}
        {approvalHere && <Html key={approvalIdentity(view.approval)} html={view.approval} className="so-task-approval" />}
        {readyExtras(resultBody !== null)}
        {resultBody}
        {view.plan != null && view.plan.html !== "" && <Html key={view.plan.key} html={view.plan.html} className="so-task-plan" />}
      </>}
      {rows !== null && statusKey === null && statusBox(null)}
      {rows !== null && !readyOpens && readyExtras(false)}
      {leadCards(unattached)}
      {view.questions !== "" && <Html html={view.questions} className="so-task-questions" />}
      {rows === null && (view.status?.attempts.length ?? 0) + (view.earlier?.attempts.length ?? 0) > 1 && <AttemptsPanel view={view} />}
      <MoreAboutTask view={view} approval={view.approval !== "" && !approvalHere && approve === null && !(rows?.some(row => row.key === "approve" && (row.opens || row.state === "current" || row.state === "stuck")) ?? false)} />
    </div>
    <WorkPanel view={view} chat={chat} csrf={csrf} open={activity} onClose={closeActivity} onClick={inPage} />
    {details !== null && <KOverlay kind="drawer" title="Details" trigger={details} onClose={() => setDetails(null)}><TaskDetails view={view} /></KOverlay>}
    {primary !== null && <KDock>{primary}</KDock>}
  </div>;
}

/** The form token React builds into its own forms (PostForm adds it); exported for the result view's native forms. */
export const useFormToken = (): string => useContext(FormToken);
