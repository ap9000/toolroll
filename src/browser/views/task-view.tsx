/** One task (src/design/KIT.md): a reading page in one centred column. The title and its meta, Full record and
 * Details; the progress line (Plan · Approval · Build · Checks · Ready); the status box with its one act (the
 * approval asks for a password only when the real rules say so); then the tabs: Plan (Result once there is one),
 * Activity (one thread in time order, ending in the composer) and Attempts. Details opens as a drawer. Forms,
 * ceremonies and ledgers stay the server's own HTML (same ids, same page scripts); this page only frames them. */
import { useContext, useEffect, useRef, useState, type MouseEvent, type ReactNode, type SyntheticEvent } from "react";
import { freshDraft, loadDraft, saveDraft, SteerNote, UnsentNote, type SteerDraft } from "./steer-composer.js";
import { HEADLINE_TONE, HEADLINES, type Headline } from "../../task-status.js";
import { FormToken, Passwordless, PostForm } from "../ui/post-form.js";
import type { AssignmentCard } from "../../assignment-ui.js";
import type { BrowserTaskDetailGroup, BrowserTaskFact, BrowserTaskMore, BrowserTaskSection, BrowserTaskTab, BrowserTaskThreadItem, BrowserTaskView } from "../../browser-workspace.js";
import { termsOf, type StepItem } from "../../design/kit.js";
import type { JourneyStep } from "../../first-run.js";
import { GuardedHtml } from "../guarded-html.js";
import {
  KApprove, KButton, KChip, KCount, KDisclose, KDocHeader, KDock, KEmpty, KFacts, KHeadlineChip, KInfoLine, KLinkButton, KNote, KOverlay, KRow, KSelect,
  KNotice, KSlots, KSteps, KTabs, KTextarea, KTiming, useKMenu,
} from "../kit/index.js";
import { RETRY_NOTE_LIMIT } from "../../needs-you.js";
import { TEXT_LIMITS } from "../../text-limits.js";
import { pausedWords } from "../../steer-status.js";
import { fullWhen, shortWhen, viewerZone } from "../../when-html.js";
import { ActivityLine, AlsoViewing, useLiveTask } from "../live-task.js";
import { HEADLINE_GLYPH, statusWhyLines } from "./status-summary.js";
import type { GlyphKind } from "../components/ui/status-glyph.js";

/** Bring an element of this page into view: switch to the tab that holds it (panels stay mounted, so it is always
 * found), open the Details drawer when it is there, open every fold around it, then scroll and focus its first field
 * when asked. The one road for hash links (#scope, #holds, #cancel-task…) and ⋯ go-to items alike. */
function revealTarget(id: string, showTab: (tab: PageTab) => void, focus = false): boolean {
  const target = id === "" ? null : document.getElementById(id);
  if (target === null) return false;
  const panel = target.closest<HTMLElement>("[data-task-panel]");
  if (panel !== null) showTab(panel.dataset["taskPanel"] as PageTab);
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

/** A link to a fold (#scope, #holds, #cancel-task) shows its tab and opens it, on arrival and on in-page links alike. */
function useRevealHashTarget(showTab: (tab: PageTab) => void) {
  useEffect(() => {
    const reveal = () => { revealTarget(decodeURIComponent(window.location.hash.slice(1)), showTab); };
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

function ApprovalBox({ approve, latest, onEdit, reject = false }: { approve: NonNullable<BrowserTaskView["approve"]>; latest: BrowserTaskView["approve"]; onEdit: (() => void) | null; reject?: boolean }) {
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
    <KSlots wait status={<><KChip word="Needs you" tone="needs" /><h2>{approve.heading}</h2></>} text={approve.text}
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
  const chip = release.state === "failed" ? <KChip word="Failed" tone="failed" /> : release.state === "done" ? <KChip word="Released" tone="done" />
    : release.state === "waiting" ? <KChip word="Needs you" tone="needs" /> : <KChip word="Releasing" tone="live" />;
  return <section className="k-sec" aria-label="Release" data-release={release.state}>
    <h3>{release.headline}</h3>
    {release.stopped !== null && <KNotice>{release.stopped.step}: {release.stopped.message} Run the same release command again to continue from there.</KNotice>}
    <KTiming label={`Release ${release.version}`} chip={chip} rows={release.rows}
      foot={<>Tag <span className="k-mono">{release.tag}</span>{release.pr !== null && <> · pull request #{release.pr}</>} · started <time dateTime={release.startedAt} title={whenTitle(release.startedAt)}>{threadWhen(release.startedAt)}</time></>} />
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
function StatusBox({ view, card, csrf, approved }: { view: BrowserTaskView; card: AssignmentCard; csrf: string; approved: BrowserTaskView["approved"] }) {
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
        : card.action !== null && <KLinkButton variant={waits ? "primary" : "outline"} className={waits ? "k-docked" : undefined} label={card.action.label} href={card.action.href} data-primary-action=""
          {...(card.action.openResult ? { "data-open-result": "" } : {})} />}
      {pause !== null && pause.state === null && <PauseForm pause={pause} />}
      {pause !== null && pause.state === "paused" && <ResumeForm pause={pause} />}
      {pause !== null && !steering && <KButton label={pause.state === "paused" ? "Continue with a note" : "Pause and steer"} onClick={() => setSteering(true)} data-pause-steer="" />}
      {view.stop != null && csrf !== "" && <StopForm stop={view.stop} />}
    </>;
  const terms: ReactNode = failed && failure != null && !retrying ? <span data-failure-suggestion>What to change: {failure.suggestion}</span>
    : view.record != null ? <a className="k-link" href={view.record.href} data-build-record>{view.record.label}</a>
    : approved != null ? approvedWords(approved) : "";
  const why = statusWhyLines(card.status, [...card.reasons, ...card.diagnostics.map(one => `${one.label} · ${one.detail}`), ...(card.notices?.lines ?? [])]);
  return <div className="k-sec" data-task-status data-work-status={card.token} data-headline={card.status.headline} aria-label="Task status">
    <KSlots wait={waits} status={<><KHeadlineChip headline={card.status.headline} /><h2>{headingOf(card)}</h2></>}
      text={<>
        <span {...(failed ? { "data-failure-reason": "" } : {})} {...(view.progress != null ? { "data-build-progress": "" } : {})} {...(stuck !== null ? { "data-build-stuck": stuck.step } : {})}>
          {pausedLine !== null ? <span role="status" data-live-pause={pause!.state}>{pausedLine}</span> : card.status.sentence}
        </span>
        {view.activity != null && <ActivityLine activity={view.activity} />}
        {failed && failure != null && <FailureEvidence failure={failure} />}
      </>}
      acts={acts} terms={terms} />
    {pause !== null && steering && <PauseSteerForm key={pause.run} pause={pause} onCancel={() => setSteering(false)} />}
    {/* A note written for an attempt that ended before it went: shown, with a way to send it to the next one. */}
    {csrf !== "" && (view.steerRecent?.length ?? 0) > 0 && <UnsentNote key={view.steerRecent!.join(",")} runs={view.steerRecent!.filter(run => run !== view.steering?.steer?.run && run !== pause?.run)} action={`/t/${encodeURIComponent(view.id)}/steer`} back="task" />}
    {view.steering != null && csrf !== "" && <div id="steering" className="k-sec" data-task-steering>
      <KNote>{view.steering.controls.words}</KNote>
      {view.steering.steer !== null && <SteerNote key={view.steering.steer.run} steer={view.steering.steer} controls={{ ...view.steering.controls, pause: null }} back="task" />}
    </div>}
    <StatusFacts card={card} runChecks={view.runChecks ?? null} />
    {why.length > 0 && <KDisclose summary="More">{why.map(one => <KNote key={one}>{one}</KNote>)}</KDisclose>}
  </div>;
}

/** The status's detail rows (Project checks, Requirements, Pull request…) as facts; Run checks runs in place. */
function StatusFacts({ card, runChecks }: { card: AssignmentCard; runChecks: BrowserTaskView["runChecks"] }) {
  if (card.status.details.length === 0) return null;
  return <KFacts rows={card.status.details.map(detail => {
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
function Thread({ items, chat, chatHref }: { items: BrowserTaskThreadItem[]; chat: ThreadChat | null; chatHref: string | null }) {
  const entries = [
    ...items.map(item => ({ key: `item-${item.key}`, at: item.at, node: <ThreadEntry key={`item-${item.key}`} item={item} /> })),
    ...(chat?.entries ?? []),
  ].sort((a, b) => a.at === b.at ? 0 : a.at < b.at ? -1 : 1);
  return <section aria-label="Activity" data-task-thread {...(chat === null ? {} : { "data-workspace-chat": "" })} className="k-sec">
    {entries.length === 0 && <KEmpty title="Nothing has happened yet." />}
    <ol className="so-thread">{entries.map(one => one.node)}</ol>
    {chat !== null ? chat.footer
      : chatHref !== null && <KNote><a className="k-link" href={chatHref}>Message the agent</a> from Chat.</KNote>}
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

/** The Plan tab's order: what the work is and what it waits on first, then its options, then the records. */
const PLAN_ORDER = ["scope", "waits-for", "holds", "steering", "task-diagnostics"];
const planRank = (id: string): number => { const at = PLAN_ORDER.indexOf(id); return at === -1 ? PLAN_ORDER.length : at; };

/** One section of the Plan tab, flat: its heading and its content, open, never a fold (page → tab → section). */
function PlanSection({ section }: { section: BrowserTaskSection }) {
  return <section id={section.id} aria-labelledby={`plan-${section.id}`} className="k-sec so-plan-sec" data-task-section={section.id}>
    <h3 id={`plan-${section.id}`}>{section.title}{section.count !== null && section.count > 0 && <> <KCount n={section.count} /></>}</h3>
    <Html html={section.html} className="so-task-fold" />
  </section>;
}

/** The Plan tab: what the approval signs (its rows), then the scope and agents, dependencies and holds, the records,
 * the task's options, and Cancel — armed behind one deliberate tap, last. */
function PlanPanel({ view, planHtml, approval }: { view: BrowserTaskView; planHtml: string | null; approval: boolean }) {
  const sections = [...view.sections, ...view.manage].map((one, index) => ({ one, index })).sort((a, b) => planRank(a.one.id) - planRank(b.one.id) || a.index - b.index).map(({ one }) => one);
  return <div className="k-sec">
    {planHtml !== null && <Html html={planHtml} className="so-task-approval so-task-plan" />}
    {approval && <Html key={approvalIdentity(view.approval)} html={view.approval} className="so-task-approval" />}
    {sections.map(one => <PlanSection key={one.id} section={one} />)}
    {view.cancel !== null && <details id="cancel-task" open={view.cancel.open} className="k-disclose so-cancel" data-task-section="cancel">
      <summary>Cancel task</summary>
      <Html html={view.cancel.html} className="so-task-cancel" />
    </details>}
  </div>;
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
 * shows the tab that holds the item's one form, opens it and focuses it. */
function MoreMenu({ items, showTab }: { items: BrowserTaskMore[]; showTab: (tab: PageTab) => void }) {
  const forms = useRef(new Map<number, HTMLFormElement | null>());
  const menu = useKMenu();
  if (items.length === 0) return null;
  const order = { work: 0, share: 1, danger: 2 } as const;
  const sorted = items.map((item, index) => ({ item, index })).sort((a, b) => order[a.item.group] - order[b.item.group] || a.index - b.index);
  const select = (item: BrowserTaskMore, index: number) => {
    if (item.kind === "post") forms.current.get(index)?.requestSubmit();
    else if (item.kind === "goto") { showTab(pageTabOf(item.tab)); revealTarget(item.target, showTab, true); }
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

/** The task's road (first-run.ts taskRoad) as the kit's progress line: Plan · Approval · Build · Checks · Ready, the
 * step that waits on you amber, a running one blue, one that stopped red, and why under its name. */
export function stepsOf(road: readonly JourneyStep[]): StepItem[] {
  const LABEL: Record<JourneyStep["key"], string> = { plan: "Plan", approve: "Approval", build: "Build", checks: "Checks", ready: "Ready" };
  return road.map(step => {
    const variant = step.label !== LABEL[step.key] && step.label.startsWith(LABEL[step.key]) ? step.label.slice(LABEL[step.key].length).trim() : "";
    const state: StepItem["state"] = step.state === "done" || step.state === "skipped" ? "done"
      : step.state === "current" ? (step.needsYou ? "now" : "live") : step.state === "stuck" ? (step.needsYou ? "now" : "failed") : "todo";
    const sub = step.state === "skipped" ? (variant === "" ? "skipped" : variant)
      : step.needsYou && (step.state === "current" || step.state === "stuck") ? (step.key === "ready" ? "your review" : "needs you")
      : variant;
    return { label: LABEL[step.key], state, ...(sub === "" ? {} : { sub }) };
  });
}

type PageTab = "plan" | "activity" | "attempts";
/** The address's tab (`tab=`) as this page's three: Plan and Result are the first tab, then Activity and Attempts. */
const pageTabOf = (tab: string | undefined | null): PageTab => tab === "activity" ? "activity" : tab === "attempts" ? "attempts" : "plan";

/** The page (docs/plans/one-page-task-and-agent.md): one header, the progress line, the status and its one act, then
 * Plan (Result once there is one), Activity and Attempts, all on this page; Details opens as a drawer. */
export function TaskView({ view, chat = null, csrf = "", result }: { view: BrowserTaskView; chat?: ThreadChat | null; details?: boolean; csrf?: string; result?: ResultSlot }) {
  // The result the page loaded with (a later one is announced in its panel, never swapped in).
  const loadedResult = useRef(view.result ?? null);
  const hasResult = loadedResult.current !== null;
  const [tab, setTab] = useState<PageTab>(pageTabOf(view.tab));
  const [details, setDetails] = useState<HTMLElement | null>(null);
  const detailsButton = useRef<HTMLButtonElement>(null);
  // The approval keeps the terms it first showed (src/design/KIT.md): a refresh never swaps them under a person's hands.
  const shownApproval = useRef(view.approve ?? null);
  if (shownApproval.current === null && view.approve != null) shownApproval.current = view.approve;
  const approve = view.approve != null ? shownApproval.current : null;
  const showTab = (next: PageTab) => {
    setTab(next);
    try {
      const url = new URL(window.location.href);
      if (next === "plan") url.searchParams.delete("tab"); else url.searchParams.set("tab", next);
      if (next !== "plan") url.searchParams.delete("section");
      history.replaceState(history.state, "", url.pathname + url.search + url.hash);
    } catch { /* the address is a convenience; the tab is shown either way */ }
  };
  useRevealHashTarget(showTab);
  useEffect(() => {
    const open = () => setDetails(detailsButton.current ?? document.body);
    window.addEventListener("so:show-details", open);
    return () => window.removeEventListener("so:show-details", open);
  }, []);
  const people = useLiveTask(view.live);
  const approvalHere = view.approval !== "" && (view.approvalPlacement ?? "lead") === "lead" && approve === null;
  // A link to this very page's other tab (the status's Review result, a build in the thread) switches in place.
  const inPage = (event: MouseEvent<HTMLDivElement>) => {
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
    event.preventDefault();
    showTab(pageTabOf(wanted));
    if (to.hash !== "") revealTarget(decodeURIComponent(to.hash.slice(1)), showTab);
  };
  const editPlan = approve === null ? null : () => { showTab("plan"); revealTarget("plan-editor", showTab, true); };
  const attempts = Math.max(view.status?.attempts.length ?? 0, 1) + (view.earlier?.attempts.length ?? 0);
  const first = hasResult ? "Result" : view.scout ? "Investigation" : "Plan";
  const meta = <>{view.project !== null && <>{view.project} · </>}<span className="k-mono">{view.id}</span>{view.scout && <> · research only</>}
    {people.length > 0 && <> · <AlsoViewing people={people} /></>}</>;
  const record = view.audit ?? null;
  const needs = view.status?.status.headline === "Needs you" || view.status?.status.headline === "Ready for review";
  const primary = approve === null && needs && view.status?.action != null && view.recheckStopped == null && view.rebuild == null && view.retry == null
    ? <KLinkButton variant="primary" label={view.status.action.label} href={view.status.action.href} /> : null;
  return <div data-kit-page data-task-page={view.id}>
    <div className="k-doc" onClick={inPage}>
      <KDocHeader back={["/tasks", "Tasks"]} title={view.title} meta={meta}
        right={<nav className="k-acts so-task-tools" aria-label="Task tools">
          {record !== null && <KLinkButton variant="ghost" sm className="k-desk-only" label={record.label} href={record.href} />}
          <KButton ref={detailsButton} variant="ghost" sm lead="panel" label="Details" className="k-desk-only" aria-haspopup="dialog" onClick={event => setDetails(event.currentTarget)} data-open-details="" />
          <KButton variant="ghost" sm iconOnly="panel" label="Details" className="k-phone-only" aria-haspopup="dialog" onClick={event => setDetails(event.currentTarget)} />
          <MoreMenu items={[...(view.more ?? []), ...(view.everyTime ? [{ group: "share" as const, label: "Do this every time…", kind: "link" as const, href: view.everyTime.href }] : [])]} showTab={showTab} />
        </nav>} />
      {view.version !== null && <KInfoLine>{view.version.label} · <a className="k-link" href={view.version.current.href}>{view.version.current.label}</a></KInfoLine>}
      {view.archived != null && <KSlots status={<><KChip word="Archived" /><h2>Put away</h2></>}
        text={<>{view.archived.words} · <time dateTime={view.archived.at} title={fullWhen(view.archived.at, viewerZone())}>{shortWhen(view.archived.at, new Date(), viewerZone())}</time></>}
        acts={view.archived.restore !== null ? <PostForm action={view.archived.restore.action}>
          <input type="hidden" name="return" value={view.archived.restore.returnTo} />
          <KButton type="submit" variant="primary" label="Restore" data-restore="" />
        </PostForm> : null}
        terms={view.archived.restore !== null ? "Restoring puts it back in Tasks. Its history and results were kept." : "An approver can restore it."} />}
      {view.journey != null && <KSteps steps={stepsOf(view.journey)} />}
      {approve !== null && <ApprovalBox approve={approve} latest={view.approve ?? null} onEdit={editPlan} reject={view.cancel !== null} />}
      {/* The approval box is the status while the plan waits on this person: never a second box saying the same. */}
      {approve !== null ? null : view.status !== null ? <StatusBox view={view} card={view.status} csrf={csrf} approved={view.approved ?? null} /> : <Html html={view.statusHtml} />}
      {/* The older approval region (a blocked or closed approval, a fold of updated terms): installed once, and a new
          region when what it is changes (folded or open, and the exact plan it signs). */}
      {approvalHere && <Html key={approvalIdentity(view.approval)} html={view.approval} className="so-task-approval" />}
      {view.release != null && <ReleaseBox release={view.release} />}
      {view.ship != null && <ShipBox ship={view.ship} />}
      {view.lead.map(block => <Html key={block.key} html={block.html} className={`so-task-lead so-task-lead--${block.key}`} />)}
      {view.questions !== "" && <Html html={view.questions} className="so-task-questions" />}
      <KTabs label="Task" current={tab} onChange={key => showTab(key as PageTab)}
        items={[{ key: "plan", label: first }, { key: "activity", label: "Activity" }, { key: "attempts", label: "Attempts", count: <KCount n={attempts} /> }]} />
      <div role="tabpanel" aria-label={first} hidden={tab !== "plan"} data-task-panel="plan" className="k-sec">
        {(hasResult || view.result != null) && <ResultPanel view={view} loaded={loadedResult.current} csrf={csrf} result={result} />}
        {hasResult ? <KDisclose summary="Plan and settings"><PlanPanel view={view} planHtml={approve?.planHtml ?? null} approval={view.approval !== "" && !approvalHere && approve === null} /></KDisclose>
          : <PlanPanel view={view} planHtml={approve?.planHtml ?? null} approval={view.approval !== "" && !approvalHere && approve === null} />}
      </div>
      <div role="tabpanel" aria-label="Activity" hidden={tab !== "activity"} data-task-panel="activity">
        <Thread items={view.thread ?? []} chat={chat} chatHref={chat === null ? view.chatHref ?? null : null} />
      </div>
      <div role="tabpanel" aria-label="Attempts" hidden={tab !== "attempts"} data-task-panel="attempts">
        <AttemptsPanel view={view} />
      </div>
    </div>
    {details !== null && <KOverlay kind="drawer" title="Details" trigger={details} onClose={() => setDetails(null)}><TaskDetails view={view} /></KOverlay>}
    {primary !== null && <KDock>{primary}</KDock>}
  </div>;
}

/** The form token React builds into its own forms (PostForm adds it); exported for the result view's native forms. */
export const useFormToken = (): string => useContext(FormToken);
