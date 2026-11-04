/** The lead chat (/chat and the Ask panel beside a page): the thread, the live reply and the composer, in the revamp's
 * chat look (src/design/KIT.md "Composer"; prototype pages/setup.js chatView). Yours: a soft bubble on the right, its
 * time and Edit below it. The lead's: plain text under its mark and name, code blocks with Copy, what it proposed as
 * slim rows, then Copy and Retry. Sending, the receipt and the queue are useWorkspace's (app.tsx), unchanged. */
import "./lead-chat.css";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, MouseEvent, ReactNode, RefObject } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import type { BrowserMessage, BrowserWorkspace } from "../browser-workspace.js";
import { Conversation, ConversationContent, PostForm } from "./ui/index.js";
import { GuardedHtml } from "./guarded-html.js";
import { ActionCards, CHAT_COMMANDS } from "./chat-cards.js";
import { FirstRequest, FirstRun, withSuggestion } from "./first-run.js";
import { ChatMark, LiveReplyBubble, useLiveReply } from "./live-reply.js";
import { KButton, KComposer, KLinkButton, KOverlay, KPageHeader } from "./kit/index.js";
import { fullWhen, shortWhen, viewerZone } from "../when-html.js";
import type { useWorkspace } from "./app.js";
import { keyed } from "./mutation-key.js";

type Controller = ReturnType<typeof useWorkspace>;

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

/** The empty lead chat's pills: the "/" quick starts that ask something, each only drafting words in the composer. */
const EMPTY_SUGGESTIONS: Record<string, string[]> = {
  lead: ["What needs my attention right now?", "What should we work on next?", "File a task: ", "Make a flow for "],
  tasks: ["What needs my attention here?", "What should we build next?", "File a task: ", "Make a flow for "],
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

/** The question a lead message answers: the nearest of the person's own messages before it. */
export function questionBefore(messages: readonly BrowserMessage[], index: number): string | null {
  for (let at = index - 1; at >= 0; at--) if (messages[at]!.role === "operator") return messages[at]!.text.trim() || null;
  return null;
}

/** A suggestion's words as a pill: words the person finishes (a trailing colon or "for") read with "…". */
export const pillWords = (text: string): string => text.trim().replace(/:$/, "…").replace(/ (for|to)$/, " $1…");

function When({ at }: { at: string }) {
  const zone = viewerZone();
  return <time className="lc-time" dateTime={at} title={fullWhen(at, zone)}>{shortWhen(at, new Date(), zone)}</time>;
}

async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

/** A message act whose outcome shows on its own face for a moment ("Copied", "Couldn't copy"): never a toast. */
function FaceButton({ label, act, ariaLabel }: { label: string; act: () => Promise<string | null>; ariaLabel: string }) {
  const [face, setFace] = useState<string | null>(null);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return <KButton variant="ghost" sm className="lc-act" aria-label={face ?? ariaLabel} label={face ?? label} onClick={() => {
    void act().then(said => {
      if (said === null) return;
      setFace(said);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setFace(null), 1600);
    });
  }} />;
}

/** Each code block the server rendered gets a Copy button beside it, placed once the guarded HTML is in. */
function useCodeCopy(region: RefObject<HTMLDivElement | null>, html: string) {
  useLayoutEffect(() => {
    region.current?.querySelectorAll("pre").forEach(pre => {
      if (pre.parentElement?.classList.contains("lc-code")) return;
      const wrap = document.createElement("div");
      wrap.className = "lc-code";
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "lc-codecopy";
      copy.dataset["codeCopy"] = "";
      copy.setAttribute("aria-label", "Copy code");
      copy.textContent = "Copy";
      pre.replaceWith(wrap);
      wrap.append(copy, pre);
    });
  }, [region, html]);
}
const onCodeCopy = (event: MouseEvent) => {
  const button = (event.target as Element).closest<HTMLButtonElement>("[data-code-copy]");
  const code = button?.nextElementSibling?.textContent;
  if (!button || code == null) return;
  void copyText(code).then(ok => {
    button.textContent = ok ? "Copied" : "Couldn't copy";
    window.setTimeout(() => { button.textContent = "Copy"; }, 1600);
  });
};

function YourMessage({ message, onEdit, arrived = false }: { message: BrowserMessage; onEdit: (() => void) | null; arrived?: boolean }) {
  return <article className={arrived ? "lc-msg lc-you lc-new" : "lc-msg lc-you"} data-message-id={message.id} aria-label="You">
    <div className="lc-bubble"><GuardedHtml html={message.html} /></div>
    <div className="lc-meta"><When at={message.createdAt} />
      {onEdit && <KButton variant="ghost" sm className="lc-act" label="Edit" aria-label="Edit: put these words back in the message box" onClick={onEdit} />}
    </div>
  </article>;
}

function LeadMessage({ message, workspace, onChanged, took, retry, arrived = false }: { message: BrowserMessage; workspace: BrowserWorkspace; onChanged: () => void; took: string | null; retry: (() => Promise<string | null>) | null; arrived?: boolean }) {
  const body = useRef<HTMLDivElement>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  useCodeCopy(body, message.html);
  const name = workspace.leadName ?? "Lead";
  const readOnly = retry === null;
  return <article className={arrived ? "lc-msg lc-lead lc-new" : "lc-msg lc-lead"} data-message-id={message.id} aria-label={name}>
    <header className="lc-who"><ChatMark /><b>{name}</b><When at={message.createdAt} /></header>
    {message.activity && <p className="lc-activity" data-activity>{took === null ? "Worked" : `Worked ${took}`} · {message.activity}</p>}
    <div className="lc-body" ref={body} onClick={onCodeCopy}><GuardedHtml html={message.html} /></div>
    {message.cards !== undefined && message.cards.length > 0
      ? <ActionCards look="row" cards={message.cards} csrf={workspace.csrf} onChanged={onChanged} readOnly={readOnly} />
      : message.cardsHtml && <GuardedHtml html={message.cardsHtml} className="so-message-cards lc-cards-html" />}
    {!readOnly && <div className="lc-meta">
      <FaceButton label="Copy" ariaLabel={`Copy ${name}'s answer`} act={async () => (await copyText(message.text)) ? "Copied" : "Couldn't copy"} />
      <FaceButton label="Retry" ariaLabel="Retry: ask the same question again" act={async () => { const said = await retry(); setRetryError(said); return said === null ? "Sent" : null; }} />
    </div>}
    {retryError !== null && <p className="lc-said k-err" role="alert">{retryError}</p>}
  </article>;
}

/** ↓ "Jump to the latest message": shown while the reader is above it; at the bottom the thread follows new words. */
function JumpToLatest() {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  return <KButton variant="outline" iconOnly="chevron" label="Jump to the latest message" className={isAtBottom ? "lc-jump" : "lc-jump show"}
    tabIndex={isAtBottom ? -1 : 0} aria-hidden={isAtBottom ? true : undefined} onClick={() => { void scrollToBottom({ animation: "instant" }); }} />;
}

function ChatEmpty({ title, text, children }: { title: string; text: ReactNode; children?: ReactNode }) {
  return <div className="lc-empty" data-chat-empty><ChatMark /><h2>{title}</h2>{text !== "" && <p>{text}</p>}{children}</div>;
}

export function LeadChat({ controller, docked = null }: { controller: Controller; docked?: string | null }) {
  const { workspace, draft, notice, storageAvailable, sending, stale, offline } = controller;
  const chat = workspace.conversation!;
  const dock = docked === null ? null : DOCKED_SUGGESTIONS[docked] ?? DOCKED_SUGGESTIONS.task!;
  const box = useRef<HTMLTextAreaElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const busy = chat.pendingTurnId !== null;
  const leadName = workspace.leadName ?? "Lead";
  const context = docked ?? (chat.taskId ? "task" : chat.project ? "tasks" : "lead");
  // "/" opens quick starts for this conversation's context.
  const commands = CHAT_COMMANDS[context] ?? CHAT_COMMANDS.lead!;
  const commandQuery = /^\/(\w*)$/.exec(draft.text)?.[1]?.toLowerCase();
  const [commandIndex, setCommandIndex] = useState(0);
  const [commandsClosed, setCommandsClosed] = useState(false);
  const commandMatches = commandQuery === undefined || commandsClosed ? [] : commands.filter(one => one.command.startsWith(commandQuery));
  const commandList = useId();
  // A refused send keeps the words in the box with the reason under it (KIT.md "Composer").
  const [refused, setRefused] = useState(false);
  // Stop: idle, on its way, or why it didn't go through.
  const [stopping, setStopping] = useState<string>("idle");
  const focusBox = () => requestAnimationFrame(() => { const node = box.current; if (node) { node.focus(); node.setSelectionRange(node.value.length, node.value.length); } });
  const edit = (text: string) => { setRefused(false); controller.edit(text); };
  const applyCommand = (one: { text: string }) => { edit(one.text); setCommandIndex(0); focusBox(); };
  // Watch once the send has returned (the server has begun the turn), or
  // while a turn is known to be running.
  const live = useLiveReply(chat, busy || (draft.pending !== null && !sending), () => { void controller.check(); });
  // A reply in progress doesn't block sending: the next message waits in the lead queue.
  const sendBlocked = sending || stale || offline || draft.pending !== null;
  const delivery = offline ? "Offline. Your draft stays in this tab." : sending ? "Sending…" : refused ? "" : notice;
  // A desk opens ready to type; a phone waits for a tap (no keyboard over the thread), and nothing steals focus later.
  useEffect(() => {
    if (dock || window.location.hash !== "" || !matchMedia("(pointer: fine) and (min-width: 761px)").matches) return;
    if (document.activeElement !== null && document.activeElement !== document.body) return;
    box.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => { if (!busy) setStopping("idle"); }, [busy]);
  const [settingsFrom, setSettingsFrom] = useState<HTMLElement | null>(null);
  const submit = async (event: FormEvent) => {
    setRefused(false);
    if ((await controller.send(event)) === "refused") setRefused(true);
  };
  // Stop the lead's running turn through the conversation's own door (/chat/mate/stop, the one the page without script
  // posts): the conversation stays open and what was written so far is kept.
  const stop = async () => {
    if (chat.pendingTurnId === null || stopping === "busy") return;
    setStopping("busy");
    try {
      const response = await fetch("/chat/mate/stop", { method: "POST", credentials: "same-origin", redirect: "manual", headers: keyed({}),
        body: new URLSearchParams({ csrf: workspace.csrf, turn: String(chat.pendingTurnId), return: window.location.pathname + window.location.search }) });
      setStopping(response.type === "opaqueredirect" || response.ok ? "idle" : "The lead didn't stop. Try again.");
    } catch {
      setStopping("The lead didn't stop. Check your connection and try again.");
    }
    void controller.check();
  };
  const previous = !dock ? chat.previous?.messages ?? [] : [];
  // The messages the page opened with: only ones arriving later fade in.
  const opened = useRef<ReadonlySet<number>>(new Set(chat.messages.map(message => message.id)));
  const empty = chat.messages.length === 0 && previous.length === 0;
  const projectName = chat.project ? workspace.projects.find(one => one.path === chat.project)?.name ?? chat.project.split("/").filter(Boolean).at(-1) ?? chat.project : null;
  // New chat ends this conversation and forgets its thread (/chat/mate/end): the main conversation only.
  const newChat = !dock && !chat.project && !chat.taskId && chat.sessionId !== 0 && chat.messages.length > 0;
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (commandMatches.length === 0) return;
    const current = Math.min(commandIndex, commandMatches.length - 1);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setCommandIndex((current + (event.key === "ArrowDown" ? 1 : commandMatches.length - 1)) % commandMatches.length); return; }
    if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") { event.preventDefault(); applyCommand(commandMatches[current]!); return; }
    if (event.key === "Escape") { event.preventDefault(); setCommandsClosed(true); }
  };
  const warning = !storageAvailable ? "Draft stays on this page only." : draft.text.length > chat.maxChars - 200 ? `${draft.text.length} / ${chat.maxChars}` : null;
  const pills = (words: readonly string[]) => <div className="lc-sugs" role="list">{words.map(one =>
    <KButton key={one} role="listitem" variant="outline" sm className="lc-sug" label={pillWords(one)} onClick={() => { edit(one); focusBox(); }} />)}</div>;
  return <div className={dock ? "so-lead-chat lc lc-docked" : "so-lead-chat lc"} data-workspace-chat>
    {!dock && <KPageHeader title="Chat" ctx={[leadName, projectName].filter(Boolean).join(" · ")} right={<>
      {newChat && <PostForm action="/chat/mate/end" className="lc-tb-form"><input type="hidden" name="return" value="/chat" />
        <KButton type="submit" variant="ghost" sm lead="plus" label="New chat" title="End this conversation and start a new one" /></PostForm>}
      <KLinkButton variant="ghost" sm href="/settings/lead" label="Lead settings" />
    </>} />}
    <Conversation className="so-conversation lc-scroll"><ConversationContent className="lc-thread">
      {!dock && workspace.firstRun && <FirstRun firstRun={workspace.firstRun} />}
      {/* The landing's Home lives in the Work panel; other conversations keep their brief here. */}
      {!dock && !workspace.home && workspace.catchUpHtml && <GuardedHtml html={workspace.catchUpHtml} className="so-catch-up lc-brief" />}
      {previous.length > 0 && <>
        <section className="lc-previous" aria-label="Earlier conversation" data-previous-thread>
          {previous.map(message => message.role === "operator"
            ? <YourMessage key={message.id} message={message} onEdit={null} />
            : <LeadMessage key={message.id} message={message} workspace={workspace} took={null} retry={null} onChanged={() => { void controller.check(); }} />)}
        </section>
        <p className="lc-divider" role="separator" data-thread-divider><span>{REPLACED_THREAD_DIVIDER}</span></p>
      </>}
      {empty && (dock
        ? <ChatEmpty title={dock.title} text={dock.hint}>{pills(dock.suggestions)}</ChatEmpty>
        : workspace.firstRun
          // The first run: how it works in one sentence and first tasks to try, until the first request.
          ? !busy && <ChatEmpty title="What should we work on?" text={workspace.firstRun.intro ?? ""}>
              <FirstRequest firstRun={{ ...workspace.firstRun, intro: "" }} onDraft={text => { edit(withSuggestion(draft.text, text)); focusBox(); }} /></ChatEmpty>
          : <ChatEmpty title="What should we work on?" text={`${leadName} reads ${projectName ?? "your projects"}, files tasks and opens what needs you. Nothing is built until you approve its plan.`}>
              {pills(EMPTY_SUGGESTIONS[context] ?? EMPTY_SUGGESTIONS.lead!)}
              {/* v99: or a working setup in one click — a subagent and the flow it works. */}
              {!projectName && <nav className="lc-kits" aria-label="Starter kits" data-kit-links><span>Or start from a kit:</span>{KIT_LINKS.map(([id, label]) => <a key={id} href={`/kits/${id}`}>{label}</a>)}</nav>}
            </ChatEmpty>)}
      <div id="chat-thread" className="lc-messages" data-chat-region="thread">{chat.messages.map((message, index) => {
        if (message.role === "operator") return <YourMessage key={message.id} message={message} arrived={!opened.current.has(message.id)} onEdit={() => { edit(message.text); focusBox(); }} />;
        const asked = questionBefore(chat.messages, index);
        return <LeadMessage key={message.id} message={message} workspace={workspace} arrived={!opened.current.has(message.id)} took={replyTook(message, chat.messages[index - 1])} onChanged={() => { void controller.check(); }}
          retry={asked === null ? null : () => controller.steer(asked)} />;
      })}
        {(busy || live !== null) && <LiveReplyBubble look="lead" live={live} leadName={leadName} />}
      </div>
    </ConversationContent><JumpToLatest /></Conversation>
    <div className="so-composer-area lc-dock">
      {delivery && <div className="lc-connection" role={stale ? "alert" : "status"}><span>{delivery}</span>
        {stale ? <KButton variant="outline" sm onClick={controller.reconnect} label="Reconnect" /> : !sending && !offline && <KButton variant="ghost" sm onClick={() => { void controller.check(); }} label="Check again" />}
      </div>}
      {stopping !== "idle" && stopping !== "busy" && <p className="lc-said k-err" role="alert">{stopping}</p>}
      <PostForm ref={form} onSubmit={event => { void submit(event); }} action="/chat" data-workspace-composer aria-busy={sending} className="lc-form">
        {commandMatches.length > 0 && <ul id={commandList} role="listbox" aria-label="Commands" className="lc-slash">
          {commandMatches.map((one, index) => <li key={one.command} role="option" aria-selected={index === Math.min(commandIndex, commandMatches.length - 1)}
            onMouseDown={event => { event.preventDefault(); applyCommand(one); }}>
            <span className="lc-slash-name">/{one.command}</span><span className="lc-slash-hint">{one.hint}</span>
          </li>)}
        </ul>}
        <KComposer id="lead-chat" textareaId="lead-message" name="message" maxLength={chat.maxChars} label="Message your lead" textareaRef={box}
          placeholder={dock?.placeholder ?? (projectName ? `Ask about ${projectName}…` : "Message your lead…")} value={draft.text}
          onChange={value => { setCommandsClosed(false); edit(value); }} onSend={() => form.current?.requestSubmit()} submit
          sendDisabled={sendBlocked} sendLabel={busy ? "Queue message" : "Send message"}
          working={busy && draft.text.trim() === ""} onStop={() => { void stop(); }} stopLabel={stopping === "busy" ? "Stopping…" : "Stop the lead"}
          {...(!dock && !chat.taskId ? { project: { current: projectName ?? ALL_PROJECTS, sub: leadName, items: [ALL_PROJECTS, ...workspace.projects.map(one => one.name)] }, onProject: (name: string) => {
            if (name === ALL_PROJECTS) { if (chat.project) window.location.assign("/chat"); return; }
            const chosen = workspace.projects.find(one => one.name === name);
            if (chosen && chosen.path !== chat.project) window.location.assign(`/chat?project=${encodeURIComponent(chosen.path)}`);
          } } : {})}
          {...(!dock && workspace.controlsHtml ? { menu: [{ label: "Conversation settings", act: () => setSettingsFrom(document.querySelector<HTMLElement>('[data-k-composer="lead-chat"] .k-composer-plus')) }] } : {})}
          combobox={commandMatches.length > 0 ? { expanded: true, controls: commandList } : null}
          onKeyDown={onKeyDown} enterSends={event => returnSends() || event.metaKey || event.ctrlKey}
          note={warning} error={refused && notice ? notice : null} />
      </PostForm>
      {/* The conversation's settings (crew updates, details, End the conversation) open from the composer's + menu,
          so the box stays one object; the page without script still draws them under its form. */}
      {!dock && workspace.controlsHtml && settingsFrom && <KOverlay kind="popover" title="Conversation settings" trigger={settingsFrom} onClose={() => setSettingsFrom(null)}>
        <GuardedHtml html={workspace.controlsHtml} immutable className="lc-settings" /></KOverlay>}
    </div>
  </div>;
}

/** A phone's on-screen keyboard has no Shift + Enter, so on a phone (a touch screen of the phone layout's width, or
 * whenever mobile-viewport.ts sees its keyboard up) Return writes a new line and Send sends; Cmd/Ctrl + Enter sends
 * anywhere. A desk or a wide tablet, whose keyboards have Shift, sends on Enter. */
/** The composer chip's choice for the conversation across every project (/chat). */
const ALL_PROJECTS = "All projects";
const PHONE_TYPING = "(hover: none) and (pointer: coarse) and (max-width: 900px)";
export function returnSends(): boolean {
  return !document.documentElement.hasAttribute("data-mobile-keyboard") && !matchMedia(PHONE_TYPING).matches;
}
