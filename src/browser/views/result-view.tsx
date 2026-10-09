/** The one result page, rebuilt with shadcn/ui and titled with the task: its
 * status (one sentence, the facts, a line per caveat), then the evidence
 * (Summary / Changes / Checks), each item a person checks with its own
 * evidence, then the decision (exactly one ink act that resolves the result,
 * never navigation; Accept and finish completes the task in one request), the
 * feedback form, then Details with the raw run record. The list of results
 * sits one tap away in the header. Tab contents, the diff and the feedback
 * form stay the server's own HTML; the page script binds to the same data
 * attributes and ids it always has. */
import { PostForm } from "../ui/index.js";
import { AlertTriangle, Check, ChevronDown, ChevronRight } from "lucide-react";
import { useState, type MouseEvent, type ReactNode } from "react";
import type { BrowserCheckItem, BrowserResultPanel, BrowserResultView } from "../../browser-workspace.js";
import { GuardedHtml } from "../guarded-html.js";
import {
  Badge, Button, Card, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, Input, cn,
} from "../components/ui/index.js";
import { ACCEPT_NEEDS_REASON, acceptWithChecksOf, requirementsWordsOf, resultActsOf, type ResultActKind, type ResultActs } from "../../result-acts.js";
import { toneOf } from "./tone.js";
import { ConfirmStoppedForm, HEADLINE_DOT, RebuildForm, StatusDetails, StatusHeadline, statusWhyLines } from "./status-summary.js";
import { RetryForm, threadWhen, whenTitle } from "./task-view.js";

type Selected = NonNullable<BrowserResultView["selected"]>;

const DOT: Record<string, string> = {
  attention: "bg-attention", danger: "bg-destructive", info: "bg-info", success: "bg-success", neutral: "bg-muted-foreground", warning: "bg-warning",
};

function Html({ html, className }: { html: string; className?: string }) {
  return <GuardedHtml html={html} immutable {...(className === undefined ? {} : { className })} />;
}

/** The one formatter (when-html.ts), in the viewer's zone. */
const shortWhen = (iso: string): string => threadWhen(iso);

function ResultsMenu({ view }: { view: BrowserResultView }) {
  if (view.results.length === 0) return null;
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button variant="outline" size="sm">
        Results <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">{view.results.length}</span>
        {view.attention > 0 && <span className="rounded-full bg-attention px-1.5 text-xs tabular-nums text-on-attention" title={`${view.attention} need your attention`}>{view.attention}</span>}
        <ChevronDown />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="max-h-[70vh] w-80 overflow-y-auto">
      {view.attention > 0 && <DropdownMenuLabel className="text-xs text-attention">{view.attention} need{view.attention === 1 ? "s" : ""} your attention</DropdownMenuLabel>}
      {view.results.map(row => <DropdownMenuItem key={row.href} asChild>
        <a href={row.href} aria-current={row.current ? "page" : undefined} className={cn("flex items-start gap-2.5", row.current && "bg-accent")}>
          <span aria-hidden="true" className={cn("mt-1.5 size-2 shrink-0 rounded-full", row.status === null ? "bg-muted-foreground" : DOT[toneOf(row.status.tone)])} />
          <span className="min-w-0 flex-1">
            <span className={cn("block truncate", row.needsYou ? "font-semibold" : "font-medium")}>{row.title}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {[row.status?.label, ...row.notes, shortWhen(row.at)].filter(Boolean).join(" · ")}
            </span>
          </span>
        </a>
      </DropdownMenuItem>)}
      {view.capped !== null && <><DropdownMenuSeparator /><DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Showing the newest {view.capped}; older results open from their task.</DropdownMenuLabel></>}
    </DropdownMenuContent>
  </DropdownMenu>;
}

/** A report that doesn't match its changes is a warning, never a quiet success: its dot is amber whatever the status tone. */
export function MismatchHeadline({ headline }: { headline: string }) {
  return <h2 className="flex items-center gap-2.5 text-lg font-semibold leading-snug" data-mismatch-headline>
    <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full bg-warning" />{headline}
  </h2>;
}

/** The status card: the headline, one sentence, the facts rows, then any caveat as one line of its own.
 * No acts here: the result's acts sit together in the decision row. */
function StatusCard({ selected, acts, answers }: { selected: Selected; acts: ResultActs; answers: Answers }) {
  const { panel, checks } = selected;
  // A fact row's action that only reopens this same page is dropped; links to its Checks tab or a section stay.
  const same = (href: string | null): boolean => {
    if (href === null) return false;
    const to = new URL(href, window.location.origin);
    return to.pathname === "/review" && to.searchParams.get("result") === selected.taskId && !to.searchParams.has("tab") && to.hash === "";
  };
  // Requirements count each Looks right as met the moment it is pressed.
  const counted = panel?.requirements == null || panel.youCheck == null ? null
    : requirementsWordsOf(panel.requirements, [...answers.values()].filter(one => one === "right").length, [...answers.values()].filter(one => one === "not-right").length);
  const status = panel?.status == null ? null
    : { ...panel.status, details: panel.status.details.map(one => {
        const row = counted !== null && one.key === "requirements" && one.text !== "Unverified"
          ? { ...one, text: counted.text, mark: counted.done ? "ok" as const : counted.short ? one.mark === "ok" ? "note" as const : one.mark : "none" as const } : one;
        return row.action !== null && same(row.action.href) ? { ...row, action: null } : row;
      }) };
  const tone = toneOf(selected.status.tone);
  // A form that resolves a Needs you (Build again, Confirm it stopped) keeps the need's own sentence; otherwise what happened.
  const needForm = acts.primary === "rebuild" || acts.primary === "confirm-stopped";
  const sentence = selected.noRun ?? (panel !== null && !needForm ? panel.outcome : status?.sentence ?? panel?.outcome ?? "");
  const mismatch = selected.mismatch;
  // A disagreement the mismatch rows already name is said once, there.
  const caveats = [...new Set([
    ...(status === null && checks?.problem === true ? [checks.detail] : []),
    ...(selected.problem === null ? [] : [selected.problem]),
    ...(panel?.attention ?? []),
  ])].filter(one => mismatch === null || !mismatch.said.includes(one));
  const failed = status?.headline === "Failed";
  return <Card data-result-status={selected.status.token} data-headline={status?.headline ?? selected.status.label} aria-label="Result status">
    <div className="min-w-0">
      {/* The blocking fact is the headline: the report doesn't match the changes. */}
      {mismatch?.headline != null ? <MismatchHeadline headline={mismatch.headline} />
        : status !== null ? <StatusHeadline status={status} />
        : <h2 className="flex items-center gap-2.5 text-lg font-semibold leading-snug">
            <span aria-hidden="true" className={cn("size-2.5 shrink-0 rounded-full", DOT[tone])} />{selected.status.label}
          </h2>}
      {sentence !== "" && <p className={cn("mt-1.5 max-w-[75ch] text-sm", selected.failure != null ? "text-foreground" : "text-muted-foreground")} data-result-sentence
        {...(selected.failure != null ? { "data-failure-reason": "" } : {})}>{sentence}</p>}
      {/* A failed build: the evidence behind what it missed, and that exact log line when a check failed. */}
      {selected.failure != null && (selected.failure.evidence !== null || selected.failure.link !== null) && <p className="mt-1 max-w-[75ch] text-[13px] text-muted-foreground" data-failure-evidence>
        {selected.failure.evidence !== null && <span className="[overflow-wrap:anywhere]">{selected.failure.evidence}</span>}
        {selected.failure.link !== null && <>{selected.failure.evidence !== null && " "}<a href={selected.failure.link.href} data-failure-log className={META_LINK}>{selected.failure.link.label}</a></>}
      </p>}
    </div>
    {mismatch !== null && mismatch.rows.length > 0 && <ul aria-label="What doesn't match" className="flex flex-col gap-1.5 border-t border-border pt-3 text-[13px] phone:pt-2" data-mismatches={mismatch.rows.length}>
      {mismatch.rows.map((one, index) => <li key={index} data-mismatch className="flex gap-2">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden="true" />
        <span className="min-w-0 [overflow-wrap:anywhere]">
          {one.text}{one.path !== null && one.absent && <> <code className="font-mono text-xs">{one.path}</code> <span className="text-muted-foreground" data-mismatch-absent>— not in the saved changes</span></>}
          {one.href !== null && (one.path !== null || one.noteLabel !== null) && <> · <a href={one.href} data-mismatch-lines className={cn("font-medium text-foreground/80 underline decoration-border underline-offset-4 hover:decoration-muted-foreground phone:-my-3 phone:inline-block phone:py-3", one.path !== null && "font-mono text-xs")}>{one.path !== null ? `${one.path}${one.lines === null ? "" : `, ${one.lines}`}` : one.noteLabel}</a></>}
        </span>
      </li>)}
    </ul>}
    {status !== null && <StatusDetails status={status} />}
    {caveats.length > 0 && <ul className="flex flex-col gap-1 text-[13px]" aria-label="Caveats" data-result-attention={caveats.length}>
      {caveats.map(one => <li key={one} data-caveat className="flex gap-2">
        <AlertTriangle className={cn("mt-0.5 size-3.5 shrink-0", failed ? "text-destructive" : "text-warning")} aria-hidden="true" />
        <span className="min-w-0 [overflow-wrap:anywhere]">{one}</span>
      </li>)}
    </ul>}
  </Card>;
}

/** Not right: the request form opens with the item quoted, ready for the why. */
function requestChange(statement: string) {
  const form = document.getElementById("comment-form");
  const box = form?.querySelector<HTMLTextAreaElement>("textarea[name=note]") ?? null;
  const shell = form?.closest("details") ?? null;
  if (shell !== null && !shell.open) shell.open = true;
  if (box === null) { window.location.hash = "request-changes"; return; }
  const quote = `Not right: “${statement}” — `;
  if (!box.value.includes(quote)) box.value = box.value.trim() === "" ? quote : `${box.value.trimEnd()}\n\n${quote}`;
  box.dispatchEvent(new Event("input", { bubbles: true }));
  box.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);
}

/** The changed lines an item cites, wrapped: a phone never scrolls sideways to read them. */
function Excerpt({ excerpt, changesHref }: { excerpt: BrowserCheckItem["excerpts"][number]; changesHref: string | null }) {
  return <figure className="overflow-hidden rounded-md border border-border" data-check-excerpt={excerpt.path}>
    <figcaption className="flex flex-wrap items-baseline gap-x-2 border-b border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground">
      <span className="font-mono text-foreground [overflow-wrap:anywhere]">{excerpt.path}</span>
      {!excerpt.cited && <span>first changed file</span>}
    </figcaption>
    <ol className="font-mono text-xs leading-relaxed">
      {excerpt.lines.map((line, index) => <li key={index} data-kind={line.kind}
        className={cn("grid grid-cols-[2.5rem_1rem_minmax(0,1fr)] px-1 py-0.5", line.kind === "addition" ? "bg-success-soft" : line.kind === "deletion" ? "bg-destructive-soft" : "")}>
        <span className="select-none pr-2 text-right text-muted-foreground tabular-nums">{line.line ?? ""}</span>
        <span aria-hidden="true" className="select-none text-muted-foreground">{line.kind === "addition" ? "+" : line.kind === "deletion" ? "−" : " "}</span>
        <code className="whitespace-pre-wrap rounded-none bg-transparent p-0 font-mono text-xs text-foreground [overflow-wrap:anywhere]"><span className="sr-only">{line.kind === "addition" ? "Added: " : line.kind === "deletion" ? "Removed: " : ""}</span>{line.text}</code>
      </li>)}
    </ol>
    {excerpt.more > 0 && <p className="border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
      {excerpt.more} more changed line{excerpt.more === 1 ? "" : "s"}{changesHref === null ? "" : <> in <a href={changesHref} data-result-goto="changes" className="underline underline-offset-4">Changes</a></>}
    </p>}
  </figure>;
}

type Answer = "right" | "not-right";
type Answers = ReadonlyMap<string, Answer>;

/** The items a person checks, each with a stable id and its words. */
function checkItemsOf(panel: BrowserResultPanel | null) {
  const youCheck = panel?.youCheck ?? null;
  if (youCheck == null) return [];
  return youCheck.items.length > 0 ? youCheck.items : youCheck.lines.map((words, index) => ({ id: `line-${index}`, statement: "", words, note: null, excerpts: [], shots: [] }));
}
const wordsOf = (item: { statement: string; words: string }): string => item.statement === "" ? item.words : item.statement;

/** Bring an unanswered check into view, its Looks right ready to press. */
function goToCheck(id: string) {
  const item = document.querySelector<HTMLElement>(`[data-check-item="${CSS.escape(id)}"]`);
  if (item === null) return;
  item.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  item.querySelector<HTMLButtonElement>("[data-looks-right]")?.focus({ preventScroll: true });
}

/** "You check this one": each item with its evidence inline, then Looks right or Not right. An answer
 * counts at once (the Requirements row and the decision follow it); Accept and finish records them. */
function CheckItems({ panel, chatHref, answers, answer }: { panel: BrowserResultPanel; chatHref: string; answers: Answers; answer: (id: string, to: Answer | null) => void }) {
  const items = checkItemsOf(panel);
  const changesHref = panel.tabs.find(tab => tab.key === "changes")?.href ?? null;
  return <Card aria-labelledby="you-check-title" data-result-you-check={items.length} className="gap-0 p-0 phone:gap-0 phone:p-0">
    <h2 id="you-check-title" className="px-5 pb-1 pt-4 text-[15px] font-semibold phone:px-4">{items.length === 1 ? "You check this one" : `You check these ${items.length}`}</h2>
    <ul className="divide-y divide-border">
      {items.map(item => {
        const said = answers.get(item.id) ?? null;
        return <li key={item.id} data-check-item={item.id} data-looks-right={said === "right" ? "1" : undefined} data-not-right={said === "not-right" ? "1" : undefined} className="flex scroll-mt-4 flex-col gap-3 px-5 py-4 phone:px-4">
          <p className="max-w-[75ch] text-sm font-medium">{wordsOf(item)}</p>
          {item.note !== null && <p className="max-w-[75ch] text-[13px] text-muted-foreground">The agent says: {item.note}</p>}
          {item.excerpts.map(one => <Excerpt key={one.path} excerpt={one} changesHref={changesHref} />)}
          {item.shots.length > 0 && <ul className="flex flex-wrap gap-2" aria-label="Screenshots">
            {item.shots.map(shot => <li key={shot.src}><a href={shot.href} className="block overflow-hidden rounded-md border border-border hover:border-muted-foreground" title={shot.caption}>
              <img src={shot.src} alt={shot.caption} loading="lazy" className="h-24 w-auto max-w-[12rem] object-cover phone:h-20" />
            </a></li>)}
          </ul>}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" aria-pressed={said === "right"} className="min-h-11 aria-pressed:bg-success-soft aria-pressed:text-success phone:flex-1" data-looks-right
              onClick={() => answer(item.id, said === "right" ? null : "right")}><Check />Looks right</Button>
            {panel.canRequest
              ? <Button variant="ghost" aria-pressed={said === "not-right"} className="min-h-11 aria-pressed:bg-warning-soft aria-pressed:text-foreground phone:flex-1" data-not-right
                  onClick={() => { const undo = said === "not-right"; answer(item.id, undo ? null : "not-right"); if (!undo) requestChange(wordsOf(item)); }}>Not right</Button>
              : <Button asChild variant="ghost" className="min-h-11 phone:flex-1"><a href={chatHref} data-not-right>Not right</a></Button>}
          </div>
        </li>;
      })}
    </ul>
  </Card>;
}

/** The decision, after the evidence: exactly one ink act, the one that resolves the result (result-acts.ts),
 * never a link elsewhere, and at most one outline act beside it, in one row with an 8px gap. A result that
 * can't be accepted says why in one line first. Under them, what accepting does. Accept and finish is one
 * request: the acceptance a person owes (their own checks, or a reason) and the completion together. On a
 * phone it docks at the bottom, compact: the ink act and More, which opens the rest. */
function Decision({ selected, csrf, acts, decision, firstUnanswered }: { selected: Selected; csrf: string; acts: ResultActs; decision: Selected["decision"]; firstUnanswered: string | null }) {
  const { next } = selected;
  const [more, setMore] = useState(false);
  const complete = selected.complete;
  const need = selected.panel?.need ?? null;
  const youCheck = selected.panel?.youCheck ?? null;
  // Nothing here can finish it: the acceptance alone, as the Needs you act (or the person's own checks) has it.
  const accept = complete === null ? need?.accept ?? (youCheck?.accept == null ? null : { ...youCheck.accept, note: null }) : null;
  const shown = [acts.primary, acts.secondary].filter((one): one is ResultActKind => one !== null);
  const why = shown.includes("accept") ? decision?.why ?? null : null;
  // The words over the reason field an acceptance asks for, when it does.
  const reason = !shown.includes("accept") ? null : complete !== null ? complete.accept?.note ?? null : accept?.note ?? null;
  // "Accepting needs a reason" labels the reason field when that field is here; it isn't said twice.
  const reasonHere = reason !== null || shown.includes("accept-anyway");
  const line = acts.line === ACCEPT_NEEDS_REASON && reasonHere ? null : acts.line ?? why;
  const act = (kind: ResultActKind, ink: boolean): ReactNode => {
    const variant = ink ? "attention" as const : "outline" as const;
    const mark = { "data-act": kind, ...(ink ? { "data-ink-act": kind, "data-primary-action": "" } : {}) };
    const wide = "min-h-11 phone:w-full";
    switch (kind) {
      case "retry":
        return selected.failure?.retry == null ? null : <RetryForm key={kind} action={selected.failure.retry.action} csrf={csrf} note={selected.failure.retry.note} variant={variant === "attention" ? "attention" : "default"} />;
      case "accept": {
        if (decision === null) return null;
        const form = complete ?? accept;
        if (form === null) return null;
        // An acceptance that takes a reason: its field sits directly above the act, under its own words.
        return <PostForm key={kind} action={form.action} className={cn(reason === null ? "flex flex-wrap items-center gap-2 phone:w-full" : "flex w-full max-w-sm flex-col items-start gap-2 phone:max-w-none")} {...(reason === null ? {} : { "data-accept-with-reason": "" })}>
          <input type="hidden" name="run" value={String(form.run)} />
          {complete !== null ? <>
            <input type="hidden" name="receipt" value={complete.receipt} />
            {complete.accept != null && <input type="hidden" name="accept" value="1" />}
          </> : accept !== null && <input type="hidden" name="return" value={accept.returnTo} />}
          {reason !== null && <>
            <label htmlFor="accept-reason" className="text-[13px] font-medium" data-accept-needs-reason>{ACCEPT_NEEDS_REASON}</label>
            <Input id="accept-reason" type="text" name="note" maxLength={500} required placeholder={reason} className="h-11 w-full" />
          </>}
          <Button type="submit" variant={variant} className={wide} {...mark} data-accept-result><Check className="phone:hidden" />{decision.label}</Button>
        </PostForm>;
      }
      case "accept-anyway": {
        // A failed task's result: accepted only on purpose, so the reason field is required and sits right above it.
        const anyway = selected.failure?.acceptAnyway ?? null;
        if (anyway == null) return null;
        return <PostForm key={kind} action={anyway.action} className="flex w-full max-w-sm flex-col items-start gap-2 phone:max-w-none" data-accept-with-reason data-accept-anyway>
          <input type="hidden" name="run" value={String(anyway.run)} />
          <input type="hidden" name="return" value={anyway.returnTo} />
          <label htmlFor="accept-reason" className="text-[13px] font-medium" data-accept-needs-reason>{ACCEPT_NEEDS_REASON}</label>
          <Input id="accept-reason" type="text" name="note" maxLength={500} required placeholder="Why is this safe to accept?" className="h-11 w-full" />
          <Button type="submit" variant="outline" className={wide} {...mark} data-accept-result><Check className="phone:hidden" />Accept anyway</Button>
        </PostForm>;
      }
      case "next-check":
        return firstUnanswered === null ? null
          : <Button key={kind} type="button" variant={variant} className={wide} {...mark} onClick={() => goToCheck(firstUnanswered)}>Go to your check</Button>;
      case "checks-running":
        return <Button key={kind} type="button" variant={variant} disabled aria-disabled="true" className={wide} {...mark}>Checks running</Button>;
      case "run-checks":
        if (selected.runChecks === null) return null;
        return <PostForm key={kind} action={selected.runChecks.action} className="phone:w-full">
          <input type="hidden" name="level" value={selected.runChecks.level} />
          <input type="hidden" name="return" value={selected.runChecks.returnTo} />
          <Button type="submit" variant={variant} className={wide} {...mark}>Run checks</Button>
        </PostForm>;
      case "request-changes":
        return <Button key={kind} asChild variant={variant} className={wide}><a href="#request-changes" {...mark}>Request changes</a></Button>;
      case "rebuild":
        return need?.rebuild == null ? null : <RebuildForm key={kind} action={need.rebuild.action} csrf={csrf} label={need.label} className="min-h-11" />;
      case "confirm-stopped":
        return need?.confirm == null ? null : <ConfirmStoppedForm key={kind} form={need.confirm} csrf={csrf} label={need.label} />;
      case "revise":
      case "draft-repair":
        return next === null ? null : <Html key={kind} html={next.control} className="so-result-next phone:w-full" />;
    }
  };
  if (shown.length === 0 && next === null && selected.failure == null) return null;
  const effect = decision !== null && shown.includes("accept") ? decision.effect : null;
  // On a phone the dock shows one row, the ink act and More; More opens the line, the outline act and what accepting does.
  const tucked = acts.primary !== null ? acts.secondary : null;
  const hasMore = tucked !== null || line !== null || next !== null || effect !== null;
  const rest = more ? "" : "phone:hidden";
  return <Card data-result-decision={acts.primary ?? "none"} aria-label="Decision" data-dock={more ? "open" : "compact"}
    className={cn("gap-2 phone:gap-2", shown.length > 0 && "phone:sticky phone:bottom-[-20px] phone:z-10 phone:-mx-4 phone:rounded-none phone:border-x-0 phone:px-4 phone:py-3 phone:pb-[max(12px,env(safe-area-inset-bottom))] phone:shadow-[0_-4px_16px_rgb(0_0_0/.08)]")}>
    {line !== null && <p className={cn("flex max-w-[75ch] gap-2 text-[13px]", rest)} data-decision-why {...(acts.line === null ? {} : { "data-cant-accept": "" })}>
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden="true" />{line}</p>}
    {selected.failure != null && selected.failure.retry === null && <p className="max-w-[75ch] text-[13px]" data-failure-suggestion>
      <span className="font-semibold">What to change.</span> <span className="text-muted-foreground">{selected.failure.suggestion}</span></p>}
    {/* What comes next (notes ready, CI failing, no build): one line, whatever the acts. */}
    {next !== null && <p className={cn("max-w-[75ch] text-[13px]", rest)} data-next-action={next.kind}>
      <span className="font-semibold">{next.title}.</span> <span className="text-muted-foreground">{next.detail}</span></p>}
    {shown.length > 0 && <div className={cn("flex flex-wrap items-center gap-2 phone:flex-nowrap phone:items-stretch", reason !== null && "flex-col items-start gap-3 phone:flex-row phone:items-stretch phone:gap-2", more && "phone:flex-wrap")} data-result-acts>
      <div className="contents phone:flex phone:min-w-0 phone:flex-1 phone:flex-col">{acts.primary !== null ? act(acts.primary, true) : acts.secondary !== null && act(acts.secondary, false)}</div>
      {tucked !== null && <div className={cn("contents phone:order-last phone:basis-full phone:flex-col", more ? "phone:flex" : "phone:hidden")}>{act(tucked, false)}</div>}
      {hasMore && <Button type="button" variant="outline" className="hidden min-h-11 shrink-0 phone:inline-flex" aria-expanded={more} aria-label={more ? "Fewer options" : "More options"}
        data-dock-more onClick={() => setMore(open => !open)}>{more ? "Less" : "More"}<ChevronDown className={cn("transition-transform motion-reduce:transition-none", more && "rotate-180")} /></Button>}
    </div>}
    {effect !== null && <p className={cn("max-w-[75ch] text-[13px] text-muted-foreground", rest)} data-decision-effect>{effect}</p>}
  </Card>;
}

/** Summary / Changes / Checks. The tab links keep the page script's
 * attributes, so it switches views in place and remembers the choice. */
function Panel({ panel, children }: { panel: BrowserResultPanel; children?: ReactNode }) {
  return <div id="result" {...panel.attributes} className="flex scroll-mt-4 flex-col gap-4">
    {panel.history !== "" && <Html html={panel.history} />}
    <Card className="gap-0 overflow-hidden p-0 phone:p-0">
      <nav role="tablist" aria-label="Result views" className="flex gap-1 overflow-x-auto border-b border-border px-3 phone:px-2">
        {panel.tabs.map(tab => <a key={tab.key} role="tab" href={tab.href} data-result-tab={tab.key} aria-selected={tab.active ? "true" : "false"} {...(tab.active ? {} : { tabIndex: -1 })}
          className="-mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3 py-3 text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground aria-selected:border-primary aria-selected:text-foreground phone:min-h-11">
          {tab.label}{tab.count !== "" && <span className="rounded-full bg-muted px-1.5 text-xs font-medium tabular-nums">{tab.count}</span>}
        </a>)}
      </nav>
      {panel.views.map(one => <div key={one.key} role="tabpanel" data-result-view={one.key} hidden={!panel.tabs.some(tab => tab.key === one.key && tab.active)} className="px-5 py-4 phone:px-4">
        <Html html={one.html} className="so-result-view" />
      </div>)}
    </Card>
    {children}
    {/* With nothing saved yet, the form waits hidden until Request changes
        (or a line note) opens it; the page script opens it in place. */}
    {panel.request !== null && <Card id="request-changes" className={cn("result-request scroll-mt-4 gap-3", panel.requestQuiet && "hidden has-[details[open]]:flex")}>
      <Html html={panel.request} className="so-result-request" />
    </Card>}
  </div>;
}

/** Secondary detail, one tap away: the scope, the notes, the recorded reasons, what was shortened,
 * review history, and the raw run record (what /r/<id> used to open on its own). */
function Details({ selected }: { selected: Selected }) {
  const learning = selected.panel?.learning ?? "";
  const panel = selected.panel;
  const why = panel?.status == null ? [] : statusWhyLines(panel.status);
  const record = selected.record;
  const rows: { id: string; title: string; hint: ReactNode; count?: number; body: ReactNode }[] = [
    { id: "intent", title: "Approved scope", hint: selected.intent === null ? null
      : <>{selected.intent.approval}{selected.intent.approvedAt != null && <> · <time dateTime={selected.intent.approvedAt} title={whenTitle(selected.intent.approvedAt)}>{threadWhen(selected.intent.approvedAt)}</time></>}</>,
      body: selected.intent === null ? <p className="text-sm text-muted-foreground">No scope was filed for this task, so there is no approved goal or boundary to review.</p> : <Html html={selected.intent.html} className="so-result-intent" /> },
    ...(selected.notes.length === 0 ? [] : [{ id: "notes", title: "Notes", hint: null, count: selected.notes.length,
      body: <ul className="flex flex-col gap-2 text-sm">{selected.notes.map((one, index) => <li key={index}><span className="text-muted-foreground">{one.author} · {shortWhen(one.at)}</span> {one.note}</li>)}</ul> }]),
    ...(why.length === 0 ? [] : [{ id: "why", title: "Recorded reasons", hint: null, count: why.length,
      body: <div className="flex flex-col gap-1 text-[13px] text-muted-foreground" data-status-why>{why.map(one => <p key={one} className="[overflow-wrap:anywhere]">{one}</p>)}</div> }]),
    ...(panel === null || panel.limits.length === 0 ? [] : [{ id: "limits", title: "What was shortened", hint: null, count: panel.limits.length,
      body: <ul className="flex flex-col gap-1 text-[13px] text-muted-foreground">{panel.limits.map(one => <li key={one}>{one}</li>)}</ul> }]),
    ...(panel?.reviewHistory == null ? [] : [{ id: "review-history", title: "Review history", hint: null,
      body: <p className="text-[13px] text-muted-foreground">{panel.reviewHistory}</p> }]),
    ...(record === null ? [] : [{ id: "run-record", title: "Run record", hint: `Build #${record.build}`,
      body: <div className="flex flex-col gap-3 text-[13px]">
        <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5">
          {record.facts.map(one => <div key={one.label} className="contents"><dt className="text-muted-foreground">{one.label}</dt><dd className="min-w-0 [overflow-wrap:anywhere]">{one.value}</dd></div>)}
        </dl>
        <p className="flex flex-wrap gap-x-4 gap-y-1">
          {selected.checks?.logHref != null && <a href={selected.checks.logHref} className={META_LINK}>Check output</a>}
          <a href={record.href} className={META_LINK}>Full run record</a>
        </p>
      </div> }]),
  ];
  return <Card aria-label="Result record" className="gap-0 divide-y divide-border overflow-hidden p-0 phone:p-0">
    {learning !== "" && <div data-cockpit-section="learning"><Html html={learning} className="so-result-learning" /></div>}
    {rows.map(row => <details key={row.id} id={row.id} className="group scroll-mt-4" data-cockpit-section={row.id}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-3.5 hover:bg-accent/50 phone:min-h-12 phone:px-4 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden="true" />
        <h2 className="text-[15px] font-semibold">{row.title}</h2>
        {row.count !== undefined && <Badge>{row.count}</Badge>}
        {row.hint != null && <span className="min-w-0 truncate text-[13px] text-muted-foreground">{row.hint}</span>}
      </summary>
      <div className="px-5 pb-5 pt-1 phone:px-4">{row.body}</div>
    </details>)}
  </Card>;
}

/** A meta link: underlined quietly, and a 44px target on a phone without growing the line. */
const META_LINK = "font-medium text-foreground/80 underline decoration-border underline-offset-4 hover:decoration-muted-foreground phone:inline-flex phone:min-h-11 phone:items-center";

/** Build #: open the run record under Details and bring it into view. */
function openRecord(event: MouseEvent<HTMLAnchorElement>) {
  const record = document.getElementById("run-record");
  if (!(record instanceof HTMLDetailsElement)) return;
  event.preventDefault();
  record.open = true;
  record.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  history.replaceState(history.state, "", "#run-record");
}

/** One result: the status, the evidence, the person's own checks, then the decision. The answers to
 * "You check this one" live here, so the Requirements row and the decision follow each one at once. */
function SelectedResult({ selected, csrf }: { selected: Selected; csrf: string }) {
  const [answers, setAnswers] = useState<Answers>(new Map());
  const answer = (id: string, to: Answer | null) => setAnswers(previous => { const next = new Map(previous); if (to === null) next.delete(id); else next.set(id, to); return next; });
  const items = checkItemsOf(selected.panel);
  const unanswered = items.filter(item => !answers.has(item.id));
  const notRight = items.filter(item => answers.get(item.id) === "not-right");
  const words = { unanswered: unanswered.map(wordsOf), notRight: notRight.map(wordsOf) };
  const decision = selected.decision === null ? null : { ...selected.decision, ...acceptWithChecksOf(selected.decision.base ?? selected.decision, words) };
  const acts = selected.actFacts === undefined ? selected.acts
    : resultActsOf({ ...selected.actFacts, ...(selected.actFacts.accept === null ? {} : { accept: { ready: decision?.ready ?? false } }), unanswered: unanswered.length, notRight: notRight.length });
  const checks = selected.panel?.youCheck != null ? <CheckItems panel={selected.panel} chatHref={selected.chatHref} answers={answers} answer={answer} /> : null;
  const decide = <Decision selected={selected} csrf={csrf} acts={acts} decision={decision} firstUnanswered={unanswered[0]?.id ?? null} />;
  return <>
    <StatusCard selected={selected} acts={acts} answers={answers} />
    {/* The decision comes after the evidence. The phone's dock sticks only within the person's checks and the
        decision itself, so it can never rise over the status or the Summary facts above them. */}
    {selected.panel !== null ? <Panel panel={selected.panel}><div className="flex flex-col gap-4">{checks}{decide}</div></Panel> : <div className="flex flex-col gap-4">{checks}{decide}</div>}
    <Details selected={selected} />
  </>;
}

export function ResultView({ view, csrf }: { view: BrowserResultView; csrf: string }) {
  const selected = view.selected;
  return <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
    <header className="flex flex-col gap-3 pb-1">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-72">
          <h1 className="text-[26px] font-semibold leading-tight tracking-tight phone:text-[22px]">{selected?.title ?? "Results"}</h1>
          {selected !== null && <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted-foreground phone:gap-y-0" data-result-meta>
            {selected.project !== null && <><span className="font-medium text-foreground/80">{selected.project}</span><span aria-hidden="true">·</span></>}
            {selected.record !== null && <><a href="#run-record" onClick={openRecord} className={META_LINK}>Build #{selected.record.build}</a><span aria-hidden="true">·</span></>}
            <a href={selected.taskHref} className={META_LINK}>Open task</a>
            <span aria-hidden="true">·</span>
            <a href={selected.chatHref} className={META_LINK}>Discuss</a>
          </p>}
        </div>
        {selected !== null && <ResultsMenu view={view} />}
      </div>
      {view.missing !== null && <p role="status" className="rounded-md bg-muted px-3 py-2 text-[13px] text-foreground">{view.missing}{selected !== null ? " Showing the newest result instead." : ""}</p>}
      {view.beyond && <p className="text-[13px] text-muted-foreground">This result is older than the list in Results.</p>}
    </header>

    {selected === null
      ? view.results.length === 0
        ? <Card className="items-start py-10"><p className="text-base text-muted-foreground">Nothing to review yet.</p><Button asChild variant="outline"><a href="/work">Open tasks</a></Button></Card>
        : <Card aria-label="Results" className="gap-0 overflow-hidden p-0 phone:p-0">
            <ul className="divide-y divide-border">{view.results.map(row => <li key={row.href} className="flex items-start gap-3 px-5 py-3 phone:px-4">
              <span aria-hidden="true" className={cn("mt-2 size-2 shrink-0 rounded-full", row.status === null ? "bg-muted-foreground" : DOT[toneOf(row.status.tone)])} />
              <div className="min-w-0 flex-1">
                <a href={row.href} className={cn("block truncate hover:underline hover:underline-offset-4", row.needsYou ? "font-semibold" : "font-medium")}>{row.title}</a>
                <p className="truncate text-[13px] text-muted-foreground">{[row.status?.label, ...row.notes, shortWhen(row.at)].filter(Boolean).join(" · ")}</p>
              </div>
            </li>)}</ul>
          </Card>
      : <SelectedResult key={`${selected.taskId}:${selected.build ?? ""}`} selected={selected} csrf={csrf} />}
  </div>;
}
