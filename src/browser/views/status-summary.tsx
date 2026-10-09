/** The shared task status (task-status.ts) as React: one headline with its
 * dot, one plain sentence, then quiet detail rows — neutral words, a small
 * icon, colour only on the icon. A problem that doesn't undo the outcome is an
 * amber icon and one action on its own row; red belongs to Failed alone. The
 * exact technical reasons sit behind More. */
import { PostForm } from "../ui/index.js";
import { AlertTriangle, Check, ChevronRight, Circle, CircleDot, X } from "lucide-react";
import type { ReactNode } from "react";
import { STATUS_MORE, type DetailMark, type HeadlineTone, type StatusDetail, type TaskStatus } from "../../task-status.js";
import { Button, Input, cn } from "../components/ui/index.js";

export const HEADLINE_DOT: Record<HeadlineTone, string> = {
  neutral: "bg-muted-foreground", live: "bg-info", attention: "bg-attention",
  ready: "bg-transparent ring-2 ring-inset ring-success", success: "bg-success", danger: "bg-destructive",
};

const MARK_ICON: Record<DetailMark, ReactNode> = {
  ok: <Check className="size-3.5 text-success" aria-hidden="true" />,
  running: <CircleDot className="size-3.5 text-info" aria-hidden="true" />,
  none: <Circle className="size-3 text-muted-foreground" aria-hidden="true" />,
  note: <AlertTriangle className="size-3.5 text-warning" aria-hidden="true" />,
  failed: <X className="size-3.5 text-destructive" aria-hidden="true" />,
};

export function StatusHeadline({ status, as = "h2" }: { status: TaskStatus; as?: "h2" | "h3" }) {
  const Tag = as;
  return <Tag className="flex items-center gap-2.5 text-lg font-semibold leading-snug" data-headline={status.headline}>
    <span aria-hidden="true" className={cn("size-2.5 shrink-0 rounded-full", HEADLINE_DOT[status.tone])} />{status.headline}
  </Tag>;
}

/** Taps: on a phone a row's link grows to 44px tall without growing the row. */
const TAP = "phone:-my-3 phone:inline-block phone:py-3";

/** Run checks, in place: a row whose action is the checks request posts it and comes back to this page. */
export type InPlaceChecks = { action: string; level: "quick" | "full"; returnTo: string };

function DetailRow({ detail, runChecks, csrf }: { detail: StatusDetail; runChecks: InPlaceChecks | null; csrf: string }) {
  const inPlace = runChecks !== null && csrf !== "" && detail.action?.href === runChecks.action;
  const text = detail.href === null ? detail.text
    : <a href={detail.href} className={cn("underline decoration-border underline-offset-4 hover:decoration-muted-foreground", TAP)}>{detail.text}</a>;
  return <li data-status-detail={detail.key} data-mark={detail.mark}
    className="grid grid-cols-[14px_7.5rem_minmax(0,1fr)] items-center gap-x-2.5 py-1.5 text-[13px] phone:min-h-11 phone:grid-cols-[14px_6.25rem_minmax(0,1fr)] phone:py-1">
    <span className="flex items-center justify-center">{MARK_ICON[detail.mark]}</span>
    <span className="text-muted-foreground">{detail.label}</span>
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2.5">
      <span className="min-w-0 [overflow-wrap:anywhere]">{text}</span>
      {detail.action !== null && (inPlace
        ? <PostForm action={runChecks.action} data-run-checks className="inline">
            <input type="hidden" name="level" value={runChecks.level} />
            <input type="hidden" name="return" value={runChecks.returnTo} />
            <button type="submit" data-detail-action className={cn("cursor-pointer whitespace-nowrap font-medium underline-offset-4 hover:underline", TAP)}>{detail.action.label}</button>
          </PostForm>
        : detail.action.href === null
        ? <span className="font-medium">{detail.action.label}</span>
        : <a href={detail.action.href} data-detail-action className={cn("whitespace-nowrap font-medium underline-offset-4 hover:underline", TAP,
            detail.mark === "note" && "text-warning")}>{detail.action.label}</a>)}
    </span>
  </li>;
}

export function StatusDetails({ status, runChecks = null, csrf = "" }: { status: TaskStatus; runChecks?: InPlaceChecks | null; csrf?: string }) {
  if (status.details.length === 0) return null;
  return <ul aria-label="Status" className="flex flex-col border-t border-border pt-2 phone:pt-1.5">
    {status.details.map(one => <DetailRow key={one.key} detail={one} runChecks={runChecks} csrf={csrf} />)}
  </ul>;
}

/** The exact recorded reasons behind a status, each once. */
export function statusWhyLines(status: TaskStatus, extra: readonly string[] = []): string[] {
  return [...new Set([...status.details.flatMap(one => one.why === null ? [] : [`${one.label}: ${one.why}`]), ...status.why, ...extra])];
}

/** The exact recorded reasons, one tap away. */
export function StatusWhy({ status, extra = [] }: { status: TaskStatus; extra?: readonly string[] }) {
  const lines = statusWhyLines(status, extra);
  if (lines.length === 0) return null;
  return <details className="group text-[13px]" data-status-why>
    <summary className="flex cursor-pointer list-none items-center gap-1.5 py-1 font-medium text-muted-foreground hover:text-foreground phone:min-h-11 [&::-webkit-details-marker]:hidden">
      <ChevronRight className="size-4 transition-transform group-open:rotate-90" aria-hidden="true" />{STATUS_MORE}
    </summary>
    <div className="flex flex-col gap-1 pb-1 pl-5.5 pt-1 text-muted-foreground">{lines.map(one => <p key={one} className="[overflow-wrap:anywhere]">{one}</p>)}</div>
  </details>;
}

/** The legacy work tones, read as the headline tone they now always come from. */
export function headlineToneOf(tone: string): HeadlineTone {
  return tone === "attention" ? "attention" : tone === "problem" ? "danger" : tone === "live" ? "live" : tone === "ready" ? "ready" : tone === "done" ? "success" : "neutral";
}

/** A headline in a list (Tasks, Crew): neutral words with a coloured dot, the
 * ink accent only for Needs you, red only for Failed (on the dot). */
export function HeadlineBadge({ label, tone, className, ...rest }: { label: string; tone: string; className?: string } & Record<`data-${string}`, string>) {
  const headline = headlineToneOf(tone);
  return <span {...rest} data-headline={label} className={cn("inline-flex w-fit shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[5px] px-1.5 py-px text-[11.5px] font-medium leading-[18px]",
    headline === "attention" ? "bg-attention-soft text-attention" : "bg-neutral-soft text-neutral-ink", className)}>
    <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", headline === "ready" ? "bg-transparent ring-[1.5px] ring-inset ring-success" : HEADLINE_DOT[headline])} />{label}
  </span>;
}

/** Confirm it stopped, behind the password: the one form for the task and
 * result pages (an approver's act, the same record as `toolroll run settle`).
 * `checked`: Toolroll can't check the build, so the approver says they did. */
export function ConfirmStoppedForm({ form, csrf, label = "Confirm it stopped" }: { form: { action: string; run: number; returnTo?: string; checked?: boolean }; csrf: string; label?: string }) {
  return <PostForm action={form.action} id="confirm-stopped" data-confirm-stopped={form.run} className="flex flex-wrap items-center gap-2 phone:w-full">
    <input type="hidden" name="run" value={String(form.run)} />
    {form.returnTo !== undefined && <input type="hidden" name="return" value={form.returnTo} />}
    {form.checked === true && <label className="flex min-h-11 items-center gap-2 text-sm phone:w-full">
      <input type="checkbox" name="checked" value="yes" required className="size-4" />Nothing from build #{form.run} is running
    </label>}
    <Input type="password" name="token" autoComplete="current-password" required aria-label="Your password" placeholder="Your password" className="h-9 w-44 phone:h-11 phone:w-full" />
    <Button type="submit" variant="attention" className="phone:w-full">{label}</Button>
  </PostForm>;
}

/** Build again, for a result built to an earlier plan: one filled button, the
 * task page's requeue (it runs again on the same filing, under the current plan). */
export function RebuildForm({ action, csrf, label = "Build again", className }: { action: string; csrf: string; label?: string; className?: string }) {
  return <PostForm action={action} data-rebuild className="phone:w-full">
    <Button type="submit" variant="attention" className={cn("phone:w-full", className)} data-primary-action>{label}</Button>
  </PostForm>;
}
