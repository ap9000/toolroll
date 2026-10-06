/** The lead's cards, confirmed in place: what the card would do (the
 * server's own body), one act, and the result — without leaving the
 * conversation. Every act posts to the card's own door with this session's
 * token; the refreshed conversation carries the card's new state. */
import { Check, X } from "lucide-react";
import { useId, useState } from "react";
import type { BrowserActionCard } from "../browser-workspace.js";
import { GuardedHtml } from "./guarded-html.js";
import { Button, cn, toast } from "./components/ui/index.js";

const sentence = (words: string): string => words.charAt(0).toUpperCase() + words.slice(1);

async function act(card: BrowserActionCard, verb: "confirm" | "dismiss", csrf: string, confirmed: boolean): Promise<{ ok: boolean; said: string }> {
  const body = new URLSearchParams({ csrf });
  if (verb === "confirm" && confirmed) body.set("confirm", "yes");
  try {
    const response = await fetch(`/chat/proposal/${card.id}/${verb}`, { method: "POST", body, credentials: "same-origin", headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (!response.headers.get("content-type")?.includes("application/json")) return { ok: false, said: "That didn't go through. Reload the conversation and try again." };
    const data: unknown = await response.json();
    const record = typeof data === "object" && data !== null ? data as Record<string, unknown> : {};
    return { ok: record["ok"] === true, said: typeof record["said"] === "string" ? sentence(record["said"]) : "Done." };
  } catch {
    return { ok: false, said: "That didn't go through. Check your connection and try again." };
  }
}

function ActionCard({ card, csrf, onChanged }: { card: BrowserActionCard; csrf: string; onChanged: () => void }) {
  const [busy, setBusy] = useState<"confirm" | "dismiss" | null>(null);
  const [armed, setArmed] = useState(false);
  const armId = useId();
  const run = async (verb: "confirm" | "dismiss") => {
    setBusy(verb);
    const outcome = await act(card, verb, csrf, armed);
    if (verb === "confirm") (outcome.ok ? toast.success : toast.error)(outcome.said);
    else if (!outcome.ok) toast.error(outcome.said);
    setBusy(null);
    onChanged();
  };
  const primary = card.primary;
  const confirmBlocked = primary?.kind === "confirm" && primary.irreversible && !armed;
  const finished = card.state === "confirmed" || card.state === "refused" || card.state === "dismissed" || card.state === "expired";
  return <section data-view="chat-card" data-action-card={card.id} data-card-kind={card.kind} data-card-state={card.state}
    className={cn("mt-3 overflow-hidden rounded-lg border border-border bg-card text-card-foreground", card.state === "pending" && "border-primary/40", finished && "opacity-90")}>
    <header className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-[13px] font-semibold text-muted-foreground">
      <span className="min-w-0 flex-1 truncate">{card.label}</span>
      {card.state === "confirmed" && <span className="inline-flex items-center gap-1 text-success"><Check className="size-3.5" aria-hidden="true" />Done</span>}
      {card.state === "refused" && <span className="inline-flex items-center gap-1 text-destructive"><X className="size-3.5" aria-hidden="true" />Not done</span>}
    </header>
    {card.body !== "" && <div className="px-4 py-3"><GuardedHtml html={card.body} immutable className="so-card-body" /></div>}
    <footer className="flex flex-col gap-2 px-4 pb-3.5 pt-1">
      {card.said !== null && <p className={cn("text-[13px]", card.state === "refused" ? "text-destructive" : "text-success")}>{sentence(card.said)}</p>}
      {card.links.length > 0 && <div className="flex flex-wrap gap-2">{card.links.map(link => <Button key={link.href} asChild variant="outline" size="sm"><a href={link.href}>{link.label}</a></Button>)}</div>}
      {card.note !== null && <p className="text-[13px] text-muted-foreground">{card.note}</p>}
      {primary?.kind === "confirm" && primary.irreversible && <label htmlFor={armId} className="flex items-center gap-2 text-[13px]">
        <input id={armId} type="checkbox" checked={armed} onChange={event => setArmed(event.target.checked)} className="size-4 accent-[var(--so-accent)]" />
        I understand this cannot be undone
      </label>}
      {(primary !== null || card.dismissable) && <div className="flex flex-wrap items-center gap-2">
        {primary?.kind === "link" && <Button asChild size="sm"><a href={primary.href}>{primary.label}</a></Button>}
        {primary?.kind === "confirm" && primary.native && <form method="post" action={`/chat/proposal/${card.id}/confirm`}>
          <input type="hidden" name="csrf" value={csrf} />
          <input type="hidden" name="return" value={window.location.pathname + window.location.search} />
          {primary.irreversible && armed && <input type="hidden" name="confirm" value="yes" />}
          <Button type="submit" size="sm" disabled={confirmBlocked}>{primary.label}</Button>
        </form>}
        {primary?.kind === "confirm" && !primary.native && <Button size="sm" disabled={busy !== null || confirmBlocked} onClick={() => { void run("confirm"); }} data-card-confirm>
          {busy === "confirm" ? "Working…" : primary.label}
        </Button>}
        {card.dismissable && <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => { void run("dismiss"); }} data-card-dismiss>
          {busy === "dismiss" ? "Dismissing…" : "Dismiss"}
        </Button>}
      </div>}
    </footer>
  </section>;
}

export function ActionCards({ cards, csrf, onChanged, readOnly = false }: { cards: BrowserActionCard[]; csrf: string; onChanged: () => void; readOnly?: boolean }) {
  return <div className="so-action-cards">{cards.map(card => <ActionCard key={`${card.id}:${card.state}`} card={readOnly ? { ...card, primary: null, dismissable: false } : card} csrf={csrf} onChanged={onChanged} />)}</div>;
}

/** Quick starts for the composer: type "/" to pick one. A trailing space
 * or colon means the words begin a message for the person to finish. */
export const CHAT_COMMANDS: Record<string, { command: string; hint: string; text: string }[]> = {
  lead: [
    { command: "new", hint: "File a new task", text: "File a task: " },
    { command: "flow", hint: "Make a flow for how work moves", text: "Make a flow for " },
    { command: "status", hint: "What needs you right now", text: "What needs my attention right now?" },
    { command: "next", hint: "What to work on next", text: "What should we work on next?" },
  ],
  task: [
    { command: "status", hint: "Where this task stands", text: "Where does this task stand?" },
    { command: "next", hint: "Take the next step", text: "Move this forward" },
    { command: "revise", hint: "Request changes", text: "Request changes: " },
    { command: "diff", hint: "Walk through the changes", text: "Walk me through the changes file by file." },
    { command: "log", hint: "What the checks said", text: "What does the check log say?" },
    { command: "steer", hint: "Guide the next attempt", text: "For the next attempt: " },
    { command: "stop", hint: "Stop the running attempt", text: "Stop this task." },
    { command: "resume", hint: "Resume a stopped attempt", text: "Resume this task." },
    { command: "complete", hint: "Mark the result complete", text: "Mark this result complete." },
  ],
  result: [
    { command: "summary", hint: "What changed", text: "Summarize what changed." },
    { command: "diff", hint: "Walk through the changes", text: "Walk me through the changes file by file." },
    { command: "log", hint: "What the checks said", text: "What does the check log say?" },
    { command: "risks", hint: "Anything to worry about", text: "Are there any risks in this change?" },
    { command: "revise", hint: "Request changes", text: "Request changes: " },
    { command: "complete", hint: "Mark the result complete", text: "Mark this result complete." },
  ],
  tasks: [
    { command: "new", hint: "File a new task here", text: "File a task: " },
    { command: "flow", hint: "Make a flow for this project", text: "Make a flow for " },
    { command: "status", hint: "What needs you here", text: "What needs my attention here?" },
    { command: "next", hint: "What to build next", text: "What should we build next?" },
  ],
};
