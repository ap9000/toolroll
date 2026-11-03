/** The lead chat (/chat and the Ask panel beside a page): the thread, the live reply and the composer. */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { BrowserMessage, BrowserWorkspace } from "../browser-workspace.js";
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton, Disclosure, Message, MessageContent, PostForm } from "./ui/index.js";
import { GuardedHtml } from "./guarded-html.js";
import { ActionCards, CHAT_COMMANDS } from "./chat-cards.js";
import { FirstRequest, FirstRun, withSuggestion } from "./first-run.js";
import { LiveReplyBubble, useLiveReply } from "./live-reply.js";
import { Button as ViewButton, Label, Textarea } from "./components/ui/index.js";
import { Icon } from "./icons.js";
import type { useWorkspace } from "./app.js";
/** v99: the starter kits, offered where a first conversation starts. */
const KIT_LINKS: readonly [string, string][] = [["support-desk", "Support desk"], ["bug-triage", "Bug triage"], ["sales-follow-up", "Sales follow-up"], ["ops-requests", "Ops requests"]];

/** What to ask first, by the page the Ask panel sits beside. A trailing
 * space means the words start a message for the person to finish. */
const DOCKED_SUGGESTIONS: Record<string, { title: string; hint: string; placeholder: string; suggestions: string[] }> = {
  task: { title: "Ask about this task", hint: "Questions, changes and next steps. Actions come back as cards you confirm.", placeholder: "Ask about this task…",
    suggestions: ["Where does this task stand?", "Move this forward", "Request changes: "] },
  result: { title: "Ask about this result", hint: "Ask what changed or why, or request a revision. Actions come back as cards you confirm.", placeholder: "Ask about this result…",
    suggestions: ["Summarize what changed", "What does the check log say?", "Request changes: "] },
  tasks: { title: "Ask about this project", hint: "Plan work, file tasks and check progress. Actions come back as cards you confirm.", placeholder: "Ask about this project…",
    suggestions: ["What needs my attention here?", "What should we build next?", "File a task: "] },
};

/** The words a thread replaced by a change in reachable projects (mate arc ruling 9) sit above this line. */
export const REPLACED_THREAD_DIVIDER = "New conversation — the projects I can reach changed";

/** How long a reply took after the message it answers ("40 s", "2 min"), or null when it doesn't answer the message
 * just before it, or took an hour or more (it waited, so the time says nothing about the work). */
export function replyTook(message: BrowserMessage, before: BrowserMessage | undefined): string | null {
  if (message.role !== "assistant" || before?.role !== "operator") return null;
  const ms = Date.parse(message.createdAt) - Date.parse(before.createdAt);
  if (!Number.isFinite(ms) || ms < 0 || ms >= 60 * 60_000) return null;
  return ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`;
}

function ThreadMessage({ message, workspace, onChanged, took = null }: { message: BrowserMessage; workspace: BrowserWorkspace; onChanged: () => void; took?: string | null }) {
  const operator = message.role === "operator";
  return <Message from={operator ? "user" : "assistant"} data-message-id={message.id}>
    {/* The bubble says who wrote it; a screen reader still hears the name. */}
    <div className={operator ? "so-message-label so-sr-only" : "so-message-label"}>{operator ? "You" : workspace.leadName ?? "Lead"}</div>
    <MessageContent>{message.activity && <p className="so-activity-line" data-activity>{took === null ? "Worked" : `Worked ${took}`} · {message.activity}</p>}
      <GuardedHtml html={message.html} />
      {message.cards !== undefined && message.cards.length > 0
        ? <ActionCards cards={message.cards} csrf={workspace.csrf} onChanged={onChanged} />
        : message.cardsHtml && <GuardedHtml html={message.cardsHtml} className="so-message-cards" />}
    </MessageContent>
  </Message>;
}

export function LeadChat({ controller, docked = null }: { controller: ReturnType<typeof useWorkspace>; docked?: string | null }) {
  const { workspace, draft, notice, storageAvailable, sending, stale, offline } = controller;
  const chat = workspace.conversation!;
  const dock = docked === null ? null : DOCKED_SUGGESTIONS[docked] ?? DOCKED_SUGGESTIONS.task!;
  const box = useRef<HTMLTextAreaElement>(null);
  const busy = chat.pendingTurnId !== null;
  // "/" opens quick starts for this conversation's context.
  const commands = CHAT_COMMANDS[docked ?? (chat.taskId ? "task" : chat.project ? "tasks" : "lead")] ?? CHAT_COMMANDS.lead!;
  const commandQuery = /^\/(\w*)$/.exec(draft.text)?.[1]?.toLowerCase();
  const [commandIndex, setCommandIndex] = useState(0);
  const [commandsClosed, setCommandsClosed] = useState(false);
  const commandMatches = commandQuery === undefined || commandsClosed ? [] : commands.filter(one => one.command.startsWith(commandQuery));
  const commandList = useId();
  const applyCommand = (one: { text: string }) => {
    controller.edit(one.text);
    setCommandIndex(0);
    requestAnimationFrame(() => { const node = box.current; if (node) { node.focus(); node.setSelectionRange(node.value.length, node.value.length); } });
  };
  // Watch once the send has returned (the server has begun the turn), or
  // while a turn is known to be running.
  const live = useLiveReply(chat, busy || (draft.pending !== null && !sending), () => { void controller.check(); });
  // A reply in progress doesn't disable sending: the next message waits in the lead queue.
  const disabled = sending || stale || offline || draft.pending !== null || !draft.text.trim();
  // The box is one line (Send sits beside it) and grows with the words.
  useLayoutEffect(() => { const el = box.current; if (el) { const phone = matchMedia("(max-width: 760px)").matches; el.style.height = "0px"; el.style.height = `${Math.min(180, Math.max(phone ? 44 : 24, el.scrollHeight))}px`; } }, [draft.text]);
  const delivery = offline ? "Offline. Your draft stays in this tab." : sending ? "Sending…" : notice;
  // A desk opens ready to type; a phone waits for a tap (no keyboard over the thread), and nothing steals focus later.
  useEffect(() => {
    if (dock || window.location.hash !== "" || !matchMedia("(pointer: fine) and (min-width: 761px)").matches) return;
    if (document.activeElement !== null && document.activeElement !== document.body) return;
    box.current?.focus({ preventScroll: true });
  }, []);
  const previous = !dock ? chat.previous?.messages ?? [] : [];
  return <div className="so-lead-chat" data-workspace-chat>
    <Conversation className="so-conversation"><ConversationContent className="so-conversation-content">
      {!dock && workspace.firstRun && <FirstRun firstRun={workspace.firstRun} />}
      {/* The landing's Home lives in the Work panel; other conversations keep their brief here. */}
      {!dock && !workspace.home && workspace.catchUpHtml && <GuardedHtml html={workspace.catchUpHtml} className="so-catch-up" />}
      {previous.length > 0 && <>
        <section className="so-previous-thread" aria-label="Earlier conversation" data-previous-thread>
          {previous.map(message => <ThreadMessage key={message.id} message={message} workspace={workspace} onChanged={() => { void controller.check(); }} />)}
        </section>
        <p className="so-thread-divider" role="separator" data-thread-divider><span>{REPLACED_THREAD_DIVIDER}</span></p>
      </>}
      {chat.messages.length === 0 && previous.length === 0 && (!dock && workspace.firstRun ? null : dock
        ? <div className="so-docked-empty"><p className="so-docked-empty-title">{dock.title}</p><p className="so-docked-empty-hint">{dock.hint}</p>
            <div className="so-suggestions">{dock.suggestions.map(one => <ViewButton key={one} variant="outline" size="sm" className="so-suggestion h-auto min-h-[30px] whitespace-normal py-1.5 text-left max-[901px]:min-h-11 phone:h-auto" onClick={() => { controller.edit(one); box.current?.focus(); }}>{one.trim().replace(/:$/, "…")}</ViewButton>)}</div></div>
        : <><ConversationEmptyState title="What would you like to work on?" />
            {/* v99: or a working setup in one click — a subagent and the flow it works. */}
            <nav className="so-kit-links" aria-label="Starter kits" data-kit-links><span>Or start from a kit:</span>{KIT_LINKS.map(([id, label]) => <ViewButton key={id} variant="outline" size="sm" className="so-suggestion h-auto min-h-[30px] whitespace-normal py-1.5 text-left max-[901px]:min-h-11 phone:h-auto" asChild><a href={`/kits/${id}`}>{label}</a></ViewButton>)}</nav></>)}
      <div id="chat-thread" data-chat-region="thread">{chat.messages.map((message, index) => <ThreadMessage key={message.id} message={message} workspace={workspace} took={replyTook(message, chat.messages[index - 1])} onChanged={() => { void controller.check(); }} />)}</div>
      {(busy || live !== null) && <LiveReplyBubble live={live} leadName={workspace.leadName ?? "Lead"} />}
    </ConversationContent><ConversationScrollButton /></Conversation>
    <div className="so-composer-area">
      {!dock && workspace.firstRun && chat.messages.length === 0 && !busy && <FirstRequest firstRun={workspace.firstRun} onDraft={text => { controller.edit(withSuggestion(draft.text, text)); box.current?.focus(); }} />}
      {delivery && <div className="so-connection" role={stale ? "alert" : "status"}><span>{delivery}</span>
        {stale ? <ViewButton className="max-[901px]:h-11 max-[901px]:min-h-11" variant="outline" size="sm" onClick={controller.reconnect}>Reconnect</ViewButton> : !sending && !offline && <ViewButton className="max-[901px]:h-11 max-[901px]:min-h-11" variant="ghost" size="sm" onClick={() => { void controller.check(); }}>Check again</ViewButton>}
      </div>}
      <PostForm onSubmit={controller.send} action="/chat" data-workspace-composer aria-busy={sending}>
        <Label htmlFor="lead-message" className="so-sr-only">Message your lead</Label>
        {commandMatches.length > 0 && <ul id={commandList} role="listbox" aria-label="Commands" className="so-slash-menu">
          {commandMatches.map((one, index) => <li key={one.command} role="option" aria-selected={index === Math.min(commandIndex, commandMatches.length - 1)}
            onMouseDown={event => { event.preventDefault(); applyCommand(one); }}>
            <span className="so-slash-name">/{one.command}</span><span className="so-slash-hint">{one.hint}</span>
          </li>)}
        </ul>}
        {/* One row: where it goes (a quiet chip), the words, and the send arrow. */}
        <div className="so-composer-row">
          {!dock && (chat.project || (chat.taskId && workspace.focus)) && <span className="so-composer-chip" data-composer-scope title={chat.project ? chat.project : workspace.focus!.title}>{chat.project ? chat.project : workspace.focus!.title}</span>}
          <Textarea className="flex-1 min-w-0 min-h-6 max-h-[180px] resize-none rounded-none border-0 px-0 py-1.25 text-sm leading-[1.6] shadow-none focus-visible:ring-0 max-[900px]:text-base phone:min-h-11 phone:py-2.5" ref={box} id="lead-message" name="message" rows={1} maxLength={chat.maxChars} placeholder={dock?.placeholder ?? "Message your lead…"} value={draft.text}
            role={commandMatches.length > 0 ? "combobox" : undefined} aria-expanded={commandMatches.length > 0 ? true : undefined} aria-controls={commandMatches.length > 0 ? commandList : undefined}
            onChange={event => { setCommandsClosed(false); controller.edit(event.target.value); }} onKeyDown={event => {
              if (commandMatches.length > 0) {
                const current = Math.min(commandIndex, commandMatches.length - 1);
                if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setCommandIndex((current + (event.key === "ArrowDown" ? 1 : commandMatches.length - 1)) % commandMatches.length); return; }
                if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") { event.preventDefault(); applyCommand(commandMatches[current]!); return; }
                if (event.key === "Escape") { event.preventDefault(); setCommandsClosed(true); return; }
              }
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && (returnSends() || event.metaKey || event.ctrlKey)) { event.preventDefault(); if (!disabled) event.currentTarget.form?.requestSubmit(); }
            }} aria-describedby="composer-hint" />
          {/* While the lead is answering, a message waits its turn in the queue: the button's name says so. */}
          <ViewButton type="submit" size="icon" className="so-composer-send" disabled={disabled} aria-label={busy ? "Queue message" : "Send message"} title={busy ? "Queue" : "Send"}><Icon name="send" /></ViewButton>
        </div>
      </PostForm>
      {/* The hint waits under the box while it is empty and in use; a warning (storage, length) always shows. */}
      <p id="composer-hint" className="so-composer-hint" data-warning={!storageAvailable || draft.text.length > chat.maxChars - 200 ? "" : undefined}>{!storageAvailable ? "Draft stays on this page only." : draft.text.length > chat.maxChars - 200 ? `${draft.text.length} / ${chat.maxChars}` : <>/ for commands<span className="so-enter-hint"> · Shift + Enter for a new line</span></>}</p>
      {!dock && workspace.controlsHtml && <Disclosure summary="Conversation settings" className="so-conversation-settings"><GuardedHtml html={workspace.controlsHtml} immutable /></Disclosure>}
    </div>
  </div>;
}

/** A phone's on-screen keyboard has no Shift + Enter, so on a phone (a touch screen of the phone layout's width, or
 * whenever mobile-viewport.ts sees its keyboard up) Return writes a new line and Send sends; Cmd/Ctrl + Enter sends
 * anywhere. A desk or a wide tablet, whose keyboards have Shift, sends on Enter. */
const PHONE_TYPING = "(hover: none) and (pointer: coarse) and (max-width: 900px)";
export function returnSends(): boolean {
  return !document.documentElement.hasAttribute("data-mobile-keyboard") && !matchMedia(PHONE_TYPING).matches;
}
