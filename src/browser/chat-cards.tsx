/** The lead's cards, confirmed in place: what the card would do (the
 * server's own body), one act, and the result — without leaving the
 * conversation. Every act posts to the card's own door with this session's
 * token; the refreshed conversation carries the card's new state. */
import { PostForm } from "./ui/index.js";
import { Check, X } from "lucide-react";
import { useId, useState } from "react";
import type { BrowserActionCard } from "../browser-workspace.js";
import { GuardedHtml } from "./guarded-html.js";
import { Button, cn, toast } from "./components/ui/index.js";
import { KButton, KChip, KIcon, KLinkButton } from "./kit/index.js";
import type { ChipTone, KitIcon } from "../design/kit.js";
import { keyed } from "./mutation-key.js";

const sentence = (words: string): string => words.charAt(0).toUpperCase() + words.slice(1);

async function act(card: BrowserActionCard, verb: "confirm" | "dismiss", csrf: string, confirmed: boolean): Promise<{ ok: boolean; said: string }> {
  const body = new URLSearchParams({ csrf });
  if (verb === "confirm" && confirmed) body.set("confirm", "yes");
  try {
    const response = await fetch(`/chat/proposal/${card.id}/${verb}`, { method: "POST", body, credentials: "same-origin", headers: keyed({ accept: "application/json" }), signal: AbortSignal.timeout(20_000) });
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
    className={cn("so-chat-card mt-3 overflow-hidden bg-card text-card-foreground", finished && "opacity-90")}>
    <header className="flex items-center gap-2 px-4 pt-3 pb-1 font-semibold">
      {/* A decision still waiting on the person says so first: the one black chip in the thread. */}
      {card.state === "pending" && primary !== null && <span className="so-needs-you">Needs you</span>}
      <span className="so-chat-card-title min-w-0 flex-1 truncate">{card.label}</span>
      {card.state === "confirmed" && <span className="inline-flex items-center gap-1 text-success"><Check className="size-3.5" aria-hidden="true" />Done</span>}
      {card.state === "refused" && <span className="inline-flex items-center gap-1 text-destructive"><X className="size-3.5" aria-hidden="true" />Not done</span>}
    </header>
    {card.body !== "" && <div className="px-4 py-2"><GuardedHtml html={card.body} immutable className="so-card-body" /></div>}
    <footer className="flex flex-col gap-2 px-4 pb-3.5 pt-1">
      {card.said !== null && <p className={cn("text-body", card.state === "refused" ? "text-destructive" : "text-success")}>{sentence(card.said)}</p>}
      {card.links.length > 0 && <div className="flex flex-wrap gap-2">{card.links.map(link => <Button key={link.href} asChild variant="outline" size="sm"><a href={link.href}>{link.label}</a></Button>)}</div>}
      {card.note !== null && <p className="text-body text-muted-foreground">{card.note}</p>}
      {primary?.kind === "confirm" && primary.irreversible && <label htmlFor={armId} className="flex items-center gap-2 text-body">
        <input id={armId} type="checkbox" checked={armed} onChange={event => setArmed(event.target.checked)} className="size-4 accent-primary" />
        I understand this cannot be undone
      </label>}
      {(primary !== null || card.dismissable) && <div className="flex flex-wrap items-center gap-2">
        {primary?.kind === "link" && <Button asChild size="sm"><a href={primary.href}>{primary.label}</a></Button>}
        {primary?.kind === "confirm" && primary.native && <PostForm action={`/chat/proposal/${card.id}/confirm`}>
          <input type="hidden" name="return" value={window.location.pathname + window.location.search} />
          {primary.irreversible && armed && <input type="hidden" name="confirm" value="yes" />}
          <Button type="submit" size="sm" disabled={confirmBlocked}>{primary.label}</Button>
        </PostForm>}
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

/** What sort of act a card is, in one plain word, and its icon (the lead chat's slim rows). */
const CARD_KIND: Record<string, [string, KitIcon]> = {
  task: ["Task", "plus"], cancel: ["Task", "x"], task_action: ["Task", "file"], repair: ["Task", "file"], scope: ["Scope", "file"],
  review: ["Review", "file"], steer: ["Guidance", "file"], next: ["Queue", "send"], reserve: ["Worker", "file"], hold: ["Hold", "stop"],
  unhold: ["Hold", "send"], answer: ["Decision", "check"], agents: ["Agents", "file"], control: ["Control", "file"], action: ["Action", "file"],
};
/** A card's state as one chip: a proposal that waits on this person's confirmation is the amber Needs you. */
export function cardChip(card: Pick<BrowserActionCard, "state" | "primary" | "dismissable">): { word: string; tone: ChipTone } {
  switch (card.state) {
    case "pending": return card.primary !== null || card.dismissable ? { word: "Needs you", tone: "needs" } : { word: "Waiting", tone: "" };
    case "drafting": return { word: "Drafting", tone: "" };
    case "confirming": return { word: "Confirming", tone: "live" };
    case "confirmed": return { word: "Done", tone: "done" };
    case "refused": return { word: "Not done", tone: "failed" };
    case "dismissed": return { word: "Dismissed", tone: "" };
    default: return { word: "Expired", tone: "" };
  }
}

/** The lead chat's look (the revamp prototype): one slim row per card — icon · kind · title · status chip — the row a
 * link when it only points somewhere; a proposal that waits on the person opens under its row with what it would do and
 * its acts. The same doors, checks and fields as the card look; outcomes show in place, never as a toast. */
function ActionRow({ card, csrf, onChanged }: { card: BrowserActionCard; csrf: string; onChanged: () => void }) {
  const [busy, setBusy] = useState<"confirm" | "dismiss" | null>(null);
  const [armed, setArmed] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; words: string } | null>(null);
  const armId = useId();
  const run = async (verb: "confirm" | "dismiss") => {
    setBusy(verb);
    setSaid(null);
    const outcome = await act(card, verb, csrf, armed);
    setSaid({ ok: outcome.ok, words: outcome.said });
    setBusy(null);
    onChanged();
  };
  const primary = card.primary;
  const confirmBlocked = primary?.kind === "confirm" && primary.irreversible && !armed;
  const waits = card.state === "pending" && (primary !== null || card.dismissable);
  const [kind, icon] = CARD_KIND[card.kind] ?? ["Action", "file"];
  const chip = cardChip(card);
  const [first, ...more] = card.links;
  const head = <><span className="lc-card-ic" aria-hidden="true"><KIcon name={icon} small /></span>
    <span className="lc-card-t"><span className="lc-card-v">{kind}</span><span className="lc-card-n">{card.label}</span></span>
    <KChip word={chip.word} tone={chip.tone} /></>;
  return <li data-view="chat-card" data-action-card={card.id} data-card-kind={card.kind} data-card-state={card.state} className={cn("lc-card", waits && "open")}>
    {!waits && first !== undefined ? <a className="lc-card-row" href={first.href} title={first.label}>{head}</a> : <div className="lc-card-row">{head}</div>}
    {(waits || card.said !== null || said !== null || card.note !== null || more.length > 0) && <div className="lc-card-more">
      {waits && card.body !== "" && <GuardedHtml html={card.body} immutable className="lc-card-body" />}
      {card.said !== null && <p className={cn("lc-card-said", card.state === "refused" && "bad")}>{sentence(card.said)}</p>}
      {said !== null && <p className={cn("lc-card-said", !said.ok && "bad")} role={said.ok ? "status" : "alert"}>{said.ok ? said.words : `${said.words} Nothing changed.`}</p>}
      {card.note !== null && <p className="lc-card-note">{card.note}</p>}
      {primary?.kind === "confirm" && primary.irreversible && waits && <label htmlFor={armId} className="lc-card-arm">
        <input id={armId} type="checkbox" checked={armed} onChange={event => setArmed(event.target.checked)} />
        I understand this cannot be undone
      </label>}
      {(waits || more.length > 0) && <div className="lc-card-acts">
        {waits && primary?.kind === "link" && <KLinkButton variant="primary" sm href={primary.href} label={primary.label} />}
        {waits && primary?.kind === "confirm" && primary.native && <PostForm action={`/chat/proposal/${card.id}/confirm`}>
          <input type="hidden" name="return" value={window.location.pathname + window.location.search} />
          {primary.irreversible && armed && <input type="hidden" name="confirm" value="yes" />}
          <KButton type="submit" variant="primary" sm disabled={confirmBlocked} label={primary.label} />
        </PostForm>}
        {waits && primary?.kind === "confirm" && !primary.native && <KButton variant="primary" sm disabled={busy !== null || confirmBlocked} busy={busy === "confirm" ? "Working…" : false}
          onClick={() => { void run("confirm"); }} data-card-confirm label={primary.label} />}
        {waits && card.dismissable && <KButton variant="ghost" sm disabled={busy !== null} busy={busy === "dismiss" ? "Dismissing…" : false} onClick={() => { void run("dismiss"); }} data-card-dismiss label="Dismiss" />}
        {(waits ? card.links : more).map(link => <KLinkButton key={link.href} variant="ghost" sm href={link.href} label={link.label} />)}
      </div>}
    </div>}
  </li>;
}

export function ActionCards({ cards, csrf, onChanged, readOnly = false, look = "card" }: { cards: BrowserActionCard[]; csrf: string; onChanged: () => void; readOnly?: boolean; look?: "card" | "row" }) {
  const shown = (card: BrowserActionCard) => readOnly ? { ...card, primary: null, dismissable: false } : card;
  if (look === "row") return <ul className="lc-cards so-action-cards" aria-label="What the lead proposed">{cards.map(card => <ActionRow key={`${card.id}:${card.state}`} card={shown(card)} csrf={csrf} onChanged={onChanged} />)}</ul>;
  return <div className="so-action-cards">{cards.map(card => <ActionCard key={`${card.id}:${card.state}`} card={shown(card)} csrf={csrf} onChanged={onChanged} />)}</div>;
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
    { command: "steer", hint: "Send the agent a note", text: "Note for the agent: " },
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
