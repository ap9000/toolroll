/** One task (console v2): the status and its one action first, then one
 * thread in time order (the plan, the agent's notes and results, its
 * questions, the person's replies) ending in the composer, and the metadata
 * in a Details panel beside it (a Details sheet on a phone). Forms,
 * ceremonies and ledgers stay the server's own HTML (same ids, same page
 * scripts); this page only frames them. */
import { freshDraft, loadDraft, saveDraft, SteerNote, UnsentNote, type SteerDraft } from "./steer-composer.js";
import { HEADLINES, HEADLINE_TONE } from "../../task-status.js";
import { StatusGlyph, type GlyphKind } from "../components/ui/status-glyph.js";
import { PostForm } from "../ui/index.js";
import { AlertTriangle, ArrowRight, Check, ChevronRight, CircleDot, FilePlus2, ListChecks, MessageCircleQuestion, Repeat, X } from "lucide-react";
import { useEffect, useState, type ReactNode, type SyntheticEvent } from "react";
import type { AssignmentCard } from "../../assignment-ui.js";
import type { BrowserTaskDetailGroup, BrowserTaskFact, BrowserTaskSection, BrowserTaskThreadItem, BrowserTaskView } from "../../browser-workspace.js";
import { GuardedHtml } from "../guarded-html.js";
import { Journey } from "../first-run.js";
import { Badge, Button, Card, Textarea, cn } from "../components/ui/index.js";
import { ConfirmStoppedForm, HEADLINE_GLYPH, RebuildForm, StatusDetails, StatusHeadline, StatusWhy } from "./status-summary.js";
import { RETRY_NOTE_LIMIT } from "../../needs-you.js";
import { TEXT_LIMITS } from "../../text-limits.js";
import { pausedWords } from "../../steer-status.js";
import { fullWhen, shortWhen, viewerZone } from "../../when-html.js";
import { ActivityLine, AlsoViewing, useLiveTask } from "../live-task.js";

/** A link to a fold (#scope, #holds, #task-actions) opens it and every fold
 * around it, on arrival and on in-page links alike. */
function useRevealHashTarget() {
  useEffect(() => {
    const reveal = () => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      const target = id === "" ? null : document.getElementById(id);
      if (target === null) return;
      // A fold in the Details sheet: show the sheet first (phones).
      if (target.closest("[data-task-details]") !== null) window.dispatchEvent(new CustomEvent("so:show-details"));
      for (let node: HTMLElement | null = target; node !== null; node = node.parentElement) {
        if (node instanceof HTMLDetailsElement) node.open = true;
      }
      target.scrollIntoView({ block: "start" });
    };
    reveal();
    window.addEventListener("hashchange", reveal);
    return () => window.removeEventListener("hashchange", reveal);
  }, []);
}

/** Trusted server HTML through GuardedHtml; the result view uses this one too. */
export function Html({ html, className }: { html: string; className?: string }) {
  return <GuardedHtml html={html} immutable {...(className === undefined ? {} : { className })} />;
}

/** Retry itself, on the failed card: the task page's requeue (branch and workspace kept), its note for the next
 * attempt starting with the one suggestion of what to change, ready to edit. */
export function RetryForm({ action, csrf, note, variant = "default" }: { action: string; csrf: string; note?: string | undefined; variant?: "default" | "attention" }) {
  return <PostForm action={action} data-retry className="flex w-full flex-col gap-1.5">
    <label htmlFor="retry-note" className="text-body font-medium">What to change next time</label>
    {/* The whole suggestion shows, and grows with what the person adds (a single-line field cut it off on a phone). */}
    <div className="flex flex-wrap items-end gap-2 phone:flex-col phone:items-stretch">
      <Textarea id="retry-note" name="note" maxLength={RETRY_NOTE_LIMIT} rows={1} defaultValue={note ?? ""} placeholder="Note for the next attempt (optional)" data-retry-note
        className="min-h-9 min-w-0 flex-1 basis-72 resize-none [field-sizing:content] max-h-40 phone:min-h-11 phone:basis-auto" />
      <Button type="submit" variant={variant} className="phone:w-full" data-primary-action title="Keeps the branch and workspace">Retry</Button>
    </div>
  </PostForm>;
}

/** What a failed attempt missed: the evidence line behind it, and where to see the build (or that exact log line). */
function FailureEvidence({ failure }: { failure: NonNullable<BrowserTaskView["failure"]> }) {
  if (failure.evidence === null && failure.link === null) return null;
  return <p className="mt-1 text-body text-muted-foreground phone:leading-[1.35]" data-failure-evidence>
    {failure.evidence !== null && <span className="[overflow-wrap:anywhere]">{failure.evidence}</span>}
    {failure.link !== null && <>{failure.evidence !== null && " "}<a href={failure.link.href} data-failure-log className="whitespace-nowrap font-medium text-foreground/80 underline decoration-border underline-offset-4 hover:decoration-muted-foreground phone:-my-3 phone:inline-block phone:py-3">{failure.link.label}</a></>}
  </p>;
}

/** Stop, on the Building card: the same exact-run stop form the control card posts. */
function StopForm({ stop, csrf }: { stop: NonNullable<BrowserTaskView["stop"]>; csrf: string }) {
  return <PostForm action={stop.action} className="task-stop-form phone:w-full" data-task-control="stop" data-control-run={stop.run}>
    <input type="hidden" name="run" value={stop.run} />
    <input type="hidden" name="return" value="task" />
    <Button type="submit" variant="destructive" className="phone:w-full" data-stop-build>Stop</Button>
  </PostForm>;
}

type LivePause = NonNullable<BrowserTaskView["pause"]>;

/** Pause, beside Stop: stops the current turn of the same live Claude build and keeps it. Hidden once a pause is asked. */
function PauseForm({ pause }: { pause: LivePause }) {
  return <PostForm action={pause.action} className="phone:w-full" data-task-control="pause" data-control-run={pause.run}>
    <input type="hidden" name="run" value={pause.run} />
    <input type="hidden" name="request" value={pause.requests[0]} />
    <input type="hidden" name="return" value="task" />
    <Button type="submit" variant="outline" className="phone:w-full" data-pause-build>Pause</Button>
  </PostForm>;
}

/** Resume, on a paused build: it goes on where it stopped, with no note. */
function ResumeForm({ pause }: { pause: LivePause }) {
  return <PostForm action={pause.action} className="phone:w-full" data-task-control="resume" data-control-run={pause.run}>
    <input type="hidden" name="run" value={pause.run} />
    <input type="hidden" name="request" value={pause.requests[2]} />
    <input type="hidden" name="mode" value="resume" />
    <input type="hidden" name="return" value="task" />
    <Button type="submit" className="phone:w-full" data-resume-build>Resume</Button>
  </PostForm>;
}

/** Pause and steer's note, under the card's row: the turn stops first, then the agent gets the note. A paused build
 * only needs the note, so the same form reads Continue there. */
function PauseSteerForm({ pause, onCancel }: { pause: LivePause; onCancel: () => void }) {
  const paused = pause.state === "paused";
  // The note is this attempt's draft (the note box's too): kept through a refusal, cleared only by its own send.
  const [draft, setDraft] = useState<SteerDraft>(() => loadDraft(pause.run));
  const setText = (value: string) => setDraft(previous => {
    const next = previous.submitted ? { ...freshDraft(), text: value } : { ...previous, text: value };
    saveDraft(pause.run, next);
    return next;
  });
  return <PostForm action={pause.action} className="flex w-full flex-col gap-1.5" data-task-control="pause-and-steer" data-control-run={pause.run}
    onSubmit={() => setDraft(previous => { const sent = { ...previous, submitted: true }; saveDraft(pause.run, sent); return sent; })}>
    <input type="hidden" name="run" value={pause.run} />
    {/* The draft's own request: an edited draft is a new request, never a repeat of the last. */}
    <input type="hidden" name="request" value={`steer-${draft.key}`} />
    <input type="hidden" name="key" value={draft.key} />
    <input type="hidden" name="return" value="task" />
    <label htmlFor="pause-steer-note" className="text-body font-medium">{paused ? "Note to continue with" : "Note for the agent"}</label>
    <div className="flex flex-wrap items-end gap-2 phone:flex-col phone:items-stretch">
      <Textarea id="pause-steer-note" name="note" required autoFocus maxLength={TEXT_LIMITS.note} rows={1} placeholder="What should it do instead?" data-pause-steer-note
        value={draft.text} onChange={event => setText(event.target.value)}
        className="min-h-9 min-w-0 flex-1 basis-72 resize-none [field-sizing:content] max-h-40 phone:min-h-11 phone:basis-auto" />
      <Button type="submit" className="phone:w-full" data-pause-steer-send>{paused ? "Continue" : "Pause and send"}</Button>
      <Button type="button" variant="ghost" className="phone:w-full" onClick={onCancel}>Cancel</Button>
    </div>
  </PostForm>;
}

/** One headline, one sentence and one action; the details sit quietly
 * underneath (task-status.ts). Only Failed wears vermilion: its dot and, at
 * half strength, its border; its sentence is what it missed, the evidence
 * one line under it, and Retry's note starts with what to change. A live
 * build says the step it is on; a stuck step takes that line's place, with
 * its act beside it, its record is one quiet link under it, and Stop sits
 * in the same card; the attempts that
 * stopped before it are one quiet line at the bottom. */
function StatusCard({ view, card, csrf }: { view: BrowserTaskView; card: AssignmentCard; csrf: string }) {
  const failed = card.status.headline === "Failed";
  const confirm = view.confirmStopped ?? null, rebuild = view.rebuild ?? null, retry = view.retry ?? null, failure = view.failure ?? null;
  const stuck = view.progress?.stuck ?? null;
  const retrying = failed && retry != null && csrf !== "";
  const pause = view.stop != null && csrf !== "" ? view.pause ?? null : null;
  const [steering, setSteering] = useState(false);
  const pausedLine = pause?.state == null || stuck !== null ? null : pause.state === "pausing" ? "Pausing…"
    : pausedWords({ until: pause.until ?? null, limitMs: pause.limitMs ?? null }, iso => shortWhen(iso, new Date(), viewerZone(), true));
  return <Card data-task-status data-work-status={card.token} data-headline={card.status.headline} aria-label="Task status" className={cn(failed && "border-destructive/50")}>
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 phone:gap-y-2.5">
      <div className="min-w-0 flex-1 basis-64">
        <StatusHeadline status={card.status} />
        {/* A stuck step is the one thing a person may help with: it replaces the step line, said plainly, its act beside it. */}
        <p className={cn("mt-1.5 text-sm phone:mt-1 phone:leading-[1.35]", failed || stuck !== null ? "text-foreground" : "text-muted-foreground", stuck !== null && "flex gap-2")}
          {...(failed ? { "data-failure-reason": "" } : {})} {...(view.progress != null ? { "data-build-progress": "" } : {})} {...(stuck !== null ? { "data-build-stuck": stuck.step } : {})}>
          {stuck !== null && <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden="true" />}
          {/* A pause replaces the step line: the build is waiting, not working. */}
          {pausedLine !== null ? <span className="font-medium text-foreground" role="status" data-live-pause={pause!.state}>{pausedLine}</span>
            : <span className="[overflow-wrap:anywhere]">{card.status.sentence}</span>}
        </p>
        {view.activity != null && <ActivityLine activity={view.activity} className="mt-1" />}
        {view.record != null && <p className="mt-1 text-body">
          <a href={view.record.href} data-build-record className="text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground hover:decoration-muted-foreground phone:inline-flex phone:min-h-11 phone:items-center">{view.record.label}</a>
        </p>}
        {failed && failure != null && <FailureEvidence failure={failure} />}
        {failed && failure != null && !retrying && <p className="mt-1 text-body text-muted-foreground" data-failure-suggestion>What to change: {failure.suggestion}</p>}
      </div>
      {/* Confirm it stopped asks for the password right here, in place of a link. */}
      {confirm != null && csrf !== "" ? <ConfirmStoppedForm form={confirm} csrf={csrf} label={card.action?.label ?? "Confirm it stopped"} />
        : rebuild != null && csrf !== "" ? <RebuildForm action={rebuild.action} csrf={csrf} label={card.action?.label ?? "Build again"} />
        : retrying ? null
        : stuck?.action != null || view.stop != null ? <div className="flex flex-wrap items-center gap-2 phone:w-full phone:flex-col phone:items-stretch">
            {stuck?.action != null ? <Button asChild variant="outline" className="phone:w-full"><a href={stuck.action.href} data-stuck-action>{stuck.action.label}</a></Button>
              : card.action !== null && <Button asChild variant="outline" className="phone:w-full"><a href={card.action.href} data-primary-action>{card.action.label}<ArrowRight /></a></Button>}
            {pause !== null && pause.state === null && <PauseForm pause={pause} />}
            {pause !== null && pause.state === "paused" && <ResumeForm pause={pause} />}
            {pause !== null && !steering && <Button type="button" variant="outline" className="phone:w-full"
              onClick={() => setSteering(true)} data-pause-steer>{pause.state === "paused" ? "Continue with a note" : "Pause and steer"}</Button>}
            {view.stop != null && csrf !== "" && <StopForm stop={view.stop} csrf={csrf} />}
          </div>
        : card.action !== null && <Button asChild variant={card.status.headline === "Needs you" ? "attention" : "default"} className="phone:w-full">
        <a href={card.action.href} data-primary-action {...(card.action.openResult ? { "data-open-result": "" } : {})}>{card.action.label}<ArrowRight /></a>
      </Button>}
    </div>
    {retrying && <RetryForm action={retry.action} csrf={csrf} note={retry.note ?? failure?.suggestion} />}
    {pause !== null && steering && <PauseSteerForm key={pause.run} pause={pause} onCancel={() => setSteering(false)} />}
    {/* The running attempt: what it takes, said plainly, and a note box when it takes notes (Pause and steer sits above). */}
    {/* A note written for an attempt that ended before it went: shown, with a way to send it to the next one. */}
    {csrf !== "" && (view.steerRecent?.length ?? 0) > 0 && <UnsentNote key={view.steerRecent!.join(",")} runs={view.steerRecent!.filter(run => run !== view.steering?.steer?.run && run !== pause?.run)} action={`/t/${encodeURIComponent(view.id)}/steer`} back="task" />}
    {view.steering != null && csrf !== "" && <div id="steering" className="flex flex-col gap-1 border-t border-border pt-3" data-task-steering>
      <p className="text-caption text-muted-foreground" data-agent-capability>{view.steering.controls.words}</p>
      {view.steering.steer !== null && <SteerNote key={view.steering.steer.run} steer={view.steering.steer} controls={{ ...view.steering.controls, pause: null }} back="task" />}
    </div>}
    <StatusDetails status={card.status} runChecks={view.runChecks ?? null} csrf={csrf} />
    {(card.notices !== null || card.reasons.length > 0 || card.diagnostics.length > 0 || card.status.why.length > 0 || card.status.details.some(one => one.why !== null)) &&
      <div className="flex flex-col gap-1 border-t border-border pt-3 text-body phone:pt-2 phone:leading-[1.35]">
      {/* One fold, never a stack of them: the notices' lines join the recorded reasons under More (their row above
          already says what they are about). */}
      <StatusWhy status={card.status} extra={[...card.reasons, ...card.diagnostics.map(one => `${one.label} · ${one.detail}`), ...(card.notices?.lines ?? [])]} />
    </div>}
    {view.earlier != null && <div className="border-t border-border pt-1 text-body" data-earlier-attempts={view.earlier.attempts.length}>
      <Fold summary={view.earlier.summary} quiet>
        <ul className="flex flex-col gap-1.5">{view.earlier.attempts.map(one => <li key={one.href} className="text-muted-foreground">
          <a href={one.href} className="font-medium text-foreground/80 underline decoration-border underline-offset-4 hover:decoration-muted-foreground phone:inline-flex phone:min-h-11 phone:items-center">{one.label}</a>
          {one.text !== null && <> · {one.text}</>}
        </li>)}</ul>
      </Fold>
    </div>}
  </Card>;
}

/** A quiet in-card disclosure (native details: content stays in the page). */
function Fold({ summary, quiet, flatten, children }: { summary: ReactNode; quiet?: boolean; flatten?: boolean; children: ReactNode }) {
  // `flatten`: never a fold inside a fold; opening this one opens every fold in it, so one tap shows it all.
  return <details className="group" {...(flatten ? { onToggle: (event: SyntheticEvent<HTMLDetailsElement>) => {
    if (event.currentTarget.open) event.currentTarget.querySelectorAll("details").forEach(one => { one.open = true; });
  } } : {})}>
    <summary className={cn("flex cursor-pointer list-none items-center gap-1.5 py-1.5 font-medium phone:min-h-11 [&::-webkit-details-marker]:hidden", quiet && "text-muted-foreground hover:text-foreground")}>
      <ChevronRight className="size-4 transition-transform group-open:rotate-90" aria-hidden="true" />{summary}
    </summary>
    <div className="pb-2 pl-5.5 pt-1">{children}</div>
  </details>;
}

function FactValue({ fact }: { fact: BrowserTaskFact }) {
  return <>{fact.parts.map((part, index) => typeof part === "string"
    ? <span key={index}>{part}</span>
    : "at" in part
      ? <time key={index} dateTime={part.at} title={whenTitle(part.at)} className="tabular-nums">{threadWhen(part.at)}</time>
    : "seal" in part
      ? <code key={index} className="mr-1 rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{part.seal}</code>
      : <a key={index} href={part.href} className="font-medium underline decoration-border underline-offset-4 hover:decoration-muted-foreground phone:relative phone:z-[1] phone:-my-3 phone:inline-flex phone:min-h-11 phone:items-center">{part.label}</a>)}</>;
}

/** One fold of a grouped card (the accordion pattern, on native details). */
function Section({ section }: { section: BrowserTaskSection }) {
  return <details id={section.id} open={section.open} className="group scroll-mt-4" data-task-section={section.id}>
    <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-3.5 hover:bg-accent/50 phone:min-h-11 phone:px-3.5 phone:py-2 [&::-webkit-details-marker]:hidden">
      <ChevronRight className="size-4 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden="true" />
      <h2 className="text-title">{section.title}</h2>
      {section.count !== null && section.count > 0 && <Badge>{section.count}</Badge>}
    </summary>
    <div className="px-5 pb-5 pt-1 phone:px-3.5 phone:pb-3.5 phone:pt-0"><Html html={section.html} className="so-task-fold" /></div>
  </details>;
}

function Sections({ sections, label }: { sections: BrowserTaskSection[]; label: string }) {
  return sections.length === 0 ? null
    : <Card aria-label={label} className="gap-0 divide-y divide-border overflow-hidden p-0 phone:p-0">{sections.map(one => <Section key={one.id} section={one} />)}</Card>;
}

/** "16:39" today, "Yesterday 16:39", else "Sep 28", in the viewer's zone: the one formatter every time on every
 * surface goes through (when-html.ts); the exact minute in the title (`whenTitle`). */
export function threadWhen(iso: string, now = new Date()): string {
  return Number.isNaN(new Date(iso).getTime()) ? "" : shortWhen(iso, now, viewerZone());
}
export const whenTitle = (iso: string): string => fullWhen(iso, viewerZone());

/** A thread entry's mark: neutral, except the status hues on a live step (blue), a result (green) and a failure (red). */
function ThreadMark({ item }: { item: BrowserTaskThreadItem }) {
  const failed = item.kind === "result" && /failed|refused|never finished/i.test(item.title);
  const icon = item.kind === "filed" ? <FilePlus2 className="size-3.5 text-muted-foreground" />
    : item.kind === "plan" ? <ListChecks className="size-3.5 text-muted-foreground" />
    : item.kind === "progress" ? <CircleDot className="size-3.5 text-info" />
    : item.kind === "question" ? <MessageCircleQuestion className="size-3.5 text-muted-foreground" />
    : item.kind === "result" ? (failed ? <X className="size-3.5 text-destructive" /> : <Check className="size-3.5 text-success" />)
    : <span className="size-1.5 rounded-full bg-muted-foreground" />;
  return <span aria-hidden="true" className="relative z-[1] flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-card">{icon}</span>;
}

/** One server-side thread entry: who, what, when, then its words, link and card. */
function ThreadEntry({ item }: { item: BrowserTaskThreadItem }) {
  return <li data-thread-entry={item.key} data-thread-kind={item.kind} className="so-thread-entry relative flex gap-3">
    <ThreadMark item={item} />
    <div className="min-w-0 flex-1 pb-5 phone:pb-4">
      <p className="flex min-h-6 flex-wrap items-baseline gap-x-2 text-body leading-6">
        <span className="font-medium text-foreground">{item.title}</span>
        {item.author !== "" && <span className="text-muted-foreground">{item.author}</span>}
        <time dateTime={item.at} title={whenTitle(item.at)} className="ml-auto text-xs tabular-nums text-muted-foreground">{threadWhen(item.at)}</time>
      </p>
      {/* An entry with no words shows none: never an empty bubble. */}
      {item.text !== null && item.text.trim() !== "" && <p className={cn("mt-1 whitespace-pre-line text-sm leading-relaxed [overflow-wrap:anywhere]",
        item.who === "person" && "w-fit max-w-full rounded-xl bg-user-bubble px-3 py-2")}>{item.text}</p>}
      {item.link !== null && <a href={item.link.href} className="mt-1 inline-flex text-body underline decoration-border underline-offset-4 hover:decoration-muted-foreground phone:min-h-11 phone:items-center font-medium">{item.link.label}</a>}
      {item.html !== "" && <div className="mt-2"><Html html={item.html} className="so-thread-card" /></div>}
      {item.more !== null && <div className="mt-1 text-body"><Fold summary={item.more.summary} quiet flatten><Html html={item.more.html} className="so-thread-card" /></Fold></div>}
    </div>
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
  return <section aria-label="Thread" data-task-thread {...(chat === null ? {} : { "data-workspace-chat": "" })} className="flex flex-col">
    <ol className="so-thread relative flex flex-col">{entries.map(one => one.node)}</ol>
    {chat !== null ? chat.footer
      : chatHref !== null && <p className="border-t border-border pt-3 text-body text-muted-foreground">
        <a href={chatHref} className="font-medium text-foreground underline decoration-border underline-offset-4 phone:inline-flex phone:min-h-11 phone:items-center">Message the agent</a> from Chat.
      </p>}
  </section>;
}

function FactRows({ facts }: { facts: BrowserTaskFact[] }) {
  return <dl className="grid grid-cols-[8.25rem_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-body phone:gap-y-2">
    {facts.map(fact => <div key={fact.label} className="contents" data-detail-fact={fact.label}>
      <dt className="text-muted-foreground">{fact.label}</dt>
      <dd className="min-w-0 leading-snug [overflow-wrap:anywhere]"><FactValue fact={fact} /></dd>
    </div>)}
  </dl>;
}

/** An attempt's glyph: its label ends with the task's headline ("Correction 1 · Needs you"), and a headline's glyph
 * is the one HeadlineBadge wears for it (the headline's tone), so the timeline and every list agree. */
export function attemptGlyph(label: string): GlyphKind {
  const word = label.split(" · ").at(-1) ?? "";
  const headline = HEADLINES.find(one => one === word);
  return headline === undefined ? "idle" : HEADLINE_GLYPH[HEADLINE_TONE[headline]];
}

/** The Details panel (desk) and sheet (phone): the task's metadata grouped
 * Work, Links, Review and About; its attempts; then the folds that carry the
 * scope, the ledgers and the task's own controls, unchanged. */
export function TaskDetails({ view }: { view: BrowserTaskView }) {
  const groups: BrowserTaskDetailGroup[] = (view.details ?? []).filter(group => group.facts.length > 0);
  const card = view.status;
  const attempts = card !== null && (card.attempts.length > 1 || card.lead !== null) ? card : null;
  return <div className="flex flex-col gap-5 px-5 py-4 phone:gap-4 phone:px-4" data-task-details>
    {groups.map(group => <section key={group.title} aria-labelledby={`details-${group.title}`} className="flex flex-col gap-2.5" data-detail-group={group.title}>
      <h2 id={`details-${group.title}`} className="text-caption text-muted-foreground">{group.title}</h2>
      <FactRows facts={group.facts} />
    </section>)}
    {attempts !== null && <section aria-labelledby="details-attempts" className="flex flex-col gap-2 border-t border-border pt-4 text-body">
      <h2 id="details-attempts" className="flex items-center gap-1.5 text-caption text-muted-foreground">Attempts <Badge>{attempts.attempts.length}</Badge></h2>
      {/* A timeline (after Linear's activity log): one status glyph per attempt on a hairline, oldest first. */}
      <ol className="flex flex-col" data-attempt-timeline>
        {attempts.attempts.map((attempt, index) => <li key={attempt.taskId} data-attempt-task={attempt.taskId}
          className="relative grid grid-cols-[14px_minmax(0,1fr)] gap-x-2.5 pb-3 last:pb-0">
          {index < attempts.attempts.length - 1 && <span aria-hidden="true" className="absolute bottom-0 left-[6.5px] top-[19px] w-px bg-border" />}
          <StatusGlyph kind={attemptGlyph(attempt.label)} className="mt-[3px]" />
          <div className="min-w-0">
            <a href={attempt.href} className="font-medium hover:underline hover:underline-offset-4 phone:inline-flex phone:min-h-11 phone:items-center">{attempt.label}</a>
            {attempt.runId !== null && <> · <a href={`/r/${attempt.runId}`} className="text-muted-foreground hover:underline">Run #{attempt.runId}</a></>}
            {attempt.detail !== null && <p className="text-muted-foreground">{attempt.detail}</p>}
          </div>
        </li>)}
      </ol>
      {attempts.lead !== null && <p className="text-muted-foreground">Lead: {attempts.lead.label}{attempts.lead.active ? "" : " · access ended"}</p>}
    </section>}
    <Sections sections={view.sections} label="Task details" />
    {(view.manage.length > 0 || view.cancel !== null || view.everyTime) && <section aria-labelledby="task-manage" className="flex flex-col gap-3 phone:gap-2">
      <h2 id="task-manage" className="text-caption text-muted-foreground">Manage</h2>
      <Sections sections={view.manage} label="Manage" />
      {view.everyTime && <a href={view.everyTime.href} data-every-time className="flex min-h-12 items-center gap-2 rounded-lg border border-border bg-card px-4 text-title-sm transition-colors hover:bg-accent">
        <Repeat className="size-4 text-muted-foreground" aria-hidden="true" />Do this every time…
        <span className="ml-auto truncate pl-3 text-caption text-muted-foreground font-normal">{view.everyTime.starter}</span>
      </a>}
      {/* Cancel stays armed behind one deliberate tap, far from the primary action. */}
      {view.cancel !== null && <details open={view.cancel.open} className="group rounded-lg border border-destructive/30 bg-card" data-task-section="cancel">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-title-sm text-destructive phone:min-h-11 phone:px-3.5 phone:py-2 [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-4 transition-transform group-open:rotate-90" aria-hidden="true" />Cancel task
        </summary>
        <div className="px-4 pb-4 pt-1 phone:px-3.5 phone:pb-3.5 phone:pt-0"><Html html={view.cancel.html} className="so-task-cancel" /></div>
      </details>}
    </section>}
  </div>;
}

/** Where the one thing that waits on a person lives: the status card's action, or the approval under it. */
const PRIMARY_ACTION = "[data-task-status] [data-primary-action], .so-task-approval [data-primary-action]";

/** The one action, never out of reach: while something waits on the person and its button has scrolled out of
 * view, a bar pinned to the foot of the page names it. A tap brings the button back into view and puts the cursor
 * where it starts (its password, when it asks for one); it never acts by itself. */
function PinnedAction({ waiting, version }: { waiting: boolean; version: string }) {
  const [action, setAction] = useState<{ element: HTMLElement; label: string } | null>(null);
  const [hidden, setHidden] = useState(true);
  useEffect(() => {
    if (!waiting) { setAction(null); return; }
    const element = document.querySelector<HTMLElement>(PRIMARY_ACTION);
    const label = element?.textContent?.trim() ?? "";
    if (element === null || label === "") { setAction(null); return; }
    setAction({ element, label });
    const observer = new IntersectionObserver(entries => setHidden(entries.some(one => one.isIntersecting)));
    observer.observe(element);
    return () => observer.disconnect();
    // Found again whenever what the page shows changes (a live update can replace the button).
  }, [waiting, version]);
  if (action === null || hidden) return null;
  const reach = () => {
    action.element.scrollIntoView({ block: "center", behavior: "smooth" });
    const field = action.element.closest("form")?.querySelector<HTMLInputElement>("input[type=password], textarea, input[type=text]:not([tabindex='-1'])");
    (field ?? action.element).focus({ preventScroll: true });
  };
  return <div data-pinned-action className="sticky bottom-0 z-20 -mx-1 mt-2 flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 shadow-lg phone:-mx-4 phone:rounded-none phone:border-x-0 phone:border-b-0 phone:pb-[max(12px,env(safe-area-inset-bottom))]">
    <span className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium">
      <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-attention" />Needs you
    </span>
    <Button type="button" variant="attention" onClick={reach} className="shrink-0">{action.label}<ArrowRight /></Button>
  </div>;
}

/** The page: title, status card, what needs a person, then the thread. With
 * `details` (no Details panel beside it, e.g. a page without the shell's
 * panel), the Details content follows the thread. */
export function TaskView({ view, chat = null, details = true, csrf = "" }: { view: BrowserTaskView; chat?: ThreadChat | null; details?: boolean; csrf?: string }) {
  useRevealHashTarget();
  const people = useLiveTask(view.live);
  return <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 phone:gap-3">
    <header className="flex flex-col gap-3 pb-1 phone:gap-2 phone:pb-0">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3 phone:gap-y-2">
        <div className="min-w-0 flex-1 basis-72">
          <h1 className="text-display tracking-tight phone:text-[22px]">{view.title}</h1>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-body text-muted-foreground phone:mt-0.5">
            {view.project !== null && <><span className="font-medium text-foreground/80">{view.project}</span><span aria-hidden="true">·</span></>}
            <span className="min-w-0 truncate font-mono text-xs">{view.id}</span>
            {view.scout && <Badge tone="info">Scout</Badge>}
            {people.length > 0 && <><span aria-hidden="true">·</span><AlsoViewing people={people} /></>}
          </p>
        </div>
        {view.tabs.length > 0 && <nav aria-label="Task view">
          <ul className="inline-flex h-10 items-center gap-1 rounded-lg bg-muted p-1 phone:h-[52px]">
            {view.tabs.map(tab => <li key={tab.href} className="h-full">
              <a href={tab.href} aria-current={tab.active ? "page" : undefined}
                className={cn("inline-flex h-full items-center rounded-md px-3.5 text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground",
                  tab.active && "bg-card text-foreground shadow-sm")}>{tab.label}</a>
            </li>)}
          </ul>
        </nav>}
      </div>
      {view.version !== null && <p className="rounded-md bg-info-soft px-3 py-2 text-body text-info">
        {view.version.label} · <a href={view.version.current.href} className="font-semibold underline underline-offset-4">{view.version.current.label}</a>
      </p>}
    </header>

    {view.journey != null && <Journey steps={view.journey} />}

    {view.status !== null
      ? <StatusCard view={view} card={view.status} csrf={csrf} />
      : <Html html={view.statusHtml} />}

    {/* The approval is its own section under the status, never a card inside it. */}
    {view.approval !== "" && <Html html={view.approval} className="so-task-approval" />}

    {view.lead.map(block => <Html key={block.key} html={block.html} className={`so-task-lead so-task-lead--${block.key}`} />)}

    {view.questions !== "" && <Card><Html html={view.questions} className="so-task-questions" /></Card>}

    <div className="mt-2 phone:mt-1"><Thread items={view.thread ?? []} chat={chat} chatHref={view.tabs.length > 0 ? null : view.chatHref ?? null} /></div>

    {details && <div className="border-t border-border pt-2"><TaskDetails view={view} /></div>}

    <PinnedAction waiting={view.status?.status.headline === "Needs you" || view.status?.status.headline === "Failed"}
      version={`${view.status?.status.headline ?? ""}|${view.status?.action?.label ?? ""}|${view.approval.length}|${view.rebuild?.action ?? ""}`} />
  </div>;
}
