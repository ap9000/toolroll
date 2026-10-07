import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { BrowserCrewItem, BrowserMessage, BrowserWorkspace } from "../browser-workspace.js";
import {
  Alert, Artifact, ArtifactContent, Badge, Button, Conversation, ConversationContent,
  ConversationEmptyState, ConversationScrollButton, Dialog, DialogClose, DialogContent,
  DialogDescription, DialogTitle, DialogTrigger, Disclosure, Input, Label, Message, MessageContent, Textarea,
} from "./ui/index.js";
import {
  carryDraft, editDraft, emptyDraft, isWorkspace, readWorkspace, receiveDraft, rejectDraft,
  restoreDraft, sameConversation, saveDraft, sendMessage, submitDraft, workspacePollDelay, WorkspaceAuthError,
} from "./workspace-client.js";
import type { ChatDraft, DraftScope, DraftStorage } from "./workspace-client.js";
import { TeamChat } from "./team-chat.js";
import { LiveReplyBubble, useLiveReply } from "./live-reply.js";
import { browserCrewFromIndex } from "../browser-crew.js";
import type { TeamSnapshot } from "../team-contract.js";
import { GuardedHtml, notifyWorkspaceRendered, regionIsEditing } from "./guarded-html.js";
import { ActionCards, CHAT_COMMANDS } from "./chat-cards.js";
import { FirstRequest, FirstRun, withSuggestion } from "./first-run.js";
import { TaskDetails, ViewHost, type ThreadChat } from "./views/index.js";
import { threadWhen, whenTitle } from "./views/task-view.js";
import { Home } from "./views/home-view.js";
import { HeadlineBadge } from "./views/status-summary.js";
import { Toaster, Button as ViewButton, cn } from "./components/ui/index.js";
import { updateNoticeWords } from "../update-notice.js";
import { shortAge } from "../when-html.js";
import { ActivityLine, WORKSPACE_NUDGE } from "./live-task.js";
import "./workspace.css";

export { GuardedHtml, regionIsEditing };

function Icon({ name }: { name: "menu" | "chat" | "tasks" | "flows" | "projects" | "knowledge" | "settings" | "arrow" | "close" | "send" | "tools" | "plus" }) {
  const paths: Record<typeof name, ReactNode> = {
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
    chat: <path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 3V6a2 2 0 0 1 2-2Z" />,
    tasks: <><path d="m3 6 2 2 4-4m-6 9 2 2 4-4m-6 9 2 2 4-4M13 6h8M13 13h8M13 20h8" /></>,
    flows: <><rect width="8" height="8" x="3" y="3" rx="2" /><path d="M7 11v4a2 2 0 0 0 2 2h4" /><rect width="8" height="8" x="13" y="13" rx="2" /></>,
    projects: <path d="M3 7V5a2 2 0 0 1 2-2h5l3 4h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />,
    knowledge: <path d="M12 5c-3-2-7-2-10-1v15c3-1 7-1 10 1 3-2 7-2 10-1V4c-3-1-7-1-10 1Zm0 0v15" />,
    settings: <><path d="M4 6h16M4 12h16M4 18h16" /><path d="M8 3v6M16 9v6M10 15v6" /></>,
    arrow: <path d="m10 6-6 6 6 6M4 12h16" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    send: <path d="m12 19 0-14m-6 6 6-6 6 6" />,
    tools: <><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function browserStorage(): DraftStorage {
  try { return window.sessionStorage; } catch {
    return { getItem: () => null, removeItem: () => undefined, setItem: () => { throw new Error("Storage unavailable"); } };
  }
}

function scopeOf(workspace: BrowserWorkspace): DraftScope | null {
  const chat = workspace.conversation;
  return chat ? { user: workspace.user, session: chat.sessionId, task: chat.taskId ?? (chat.project ? `project:${chat.project}` : null) } : null;
}

function canRefreshWorkspace(): boolean { return !document.hidden && navigator.onLine !== false; }

const FULL_WIDTH_PAGES = new Set(["/work", "/board", "/queue", "/workbench", "/code"]);

export function useWorkspace(initial: BrowserWorkspace) {
  const [workspace, setWorkspace] = useState(initial);
  const scope = scopeOf(initial);
  const [draft, setDraft] = useState<ChatDraft>(() => {
    const restored = initial.conversation && scope
      ? restoreDraft(browserStorage(), scope, initial.conversation.requestId, initial.conversation.maxChars)
      : emptyDraft("");
    // A link may start a message for the person to finish (?draft=…); a draft they already have wins.
    const started = initial.conversation ? new URLSearchParams(window.location.search).get("draft") : null;
    return started && restored.text === "" && restored.pending === null ? { ...restored, text: started.slice(0, initial.conversation!.maxChars) } : restored;
  });
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("draft")) return;
    url.searchParams.delete("draft");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  }, []);
  const [notice, setNotice] = useState("");
  const [storageAvailable, setStorageAvailable] = useState(true);
  const [sending, setSending] = useState(false);
  const [stale, setStale] = useState(false);
  const [offline, setOffline] = useState(() => navigator.onLine === false);
  const state = useRef({ workspace, draft, stale, sending, notice });
  state.current = { workspace, draft, stale, sending, notice };
  const polling = useRef(false);
  const refreshQueued = useRef(false);
  const refreshTimer = useRef<number | undefined>(undefined);
  const refreshTag = useRef<string | null>(null);
  const pollDelay = useRef(5_000);
  const mounted = useRef(true);
  const sendLatch = useRef(false);

  const updateDraft = useCallback((next: ChatDraft) => {
    state.current.draft = next;
    setDraft(next);
    const owner = scopeOf(initial);
    if (owner) setStorageAvailable(saveDraft(browserStorage(), owner, next));
  }, [initial]);

  // A task page that follows its own stream (/t/<id>/live) reads itself when nudged.
  const liveTask = initial.view?.kind === "task" && initial.view.live != null && !initial.sensitive;
  const check = useCallback(async (force = true): Promise<void> => {
    if (!mounted.current || state.current.stale || !(initial.conversation || initial.refreshSeconds || liveTask) || !canRefreshWorkspace()) return;
    // A send or explicit refresh during a read must run immediately afterward,
    // rather than lose its receipt check or start an overlapping request.
    if (polling.current) { if (force) refreshQueued.current = true; return; }
    refreshQueued.current = false;
    clearTimeout(refreshTimer.current);
    if (force) pollDelay.current = 5_000;
    polling.current = true;
    const asked = state.current.draft.pending?.request ?? null;
    let unchanged = false;
    try {
      const read = await readWorkspace(state.current.workspace, asked, fetch, { etag: refreshTag.current, force });
      if (!mounted.current) return;
      // A receipt query is a different representation from the ordinary view.
      refreshTag.current = asked ? null : read.etag;
      if (read.kind === "unchanged") {
        unchanged = true;
        if (!state.current.draft.pending && state.current.notice) setNotice("");
        return;
      }
      const next = read.workspace;
      if (!sameConversation(initial, next)) {
        state.current.stale = true;
        setStale(true);
        setNotice("This conversation changed or ended. Reconnect to continue with your draft.");
        return;
      }
      const received = receiveDraft(state.current.draft, asked, next.receipt);
      if (received !== state.current.draft) updateDraft(received);
      state.current.workspace = next;
      setWorkspace(next);
      setNotice(received.pending ? "Delivery is not confirmed. Check again before sending another message." : "");
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof WorkspaceAuthError) { state.current.stale = true; setStale(true); }
      setNotice(error instanceof Error ? error.message : "Updates are unavailable. Your work is still saved.");
    } finally {
      polling.current = false;
      // A page that only follows its task's stream has no beat of its own: the next nudge reads it again.
      if (mounted.current && !state.current.stale && canRefreshWorkspace() && (initial.conversation || (state.current.workspace.refreshSeconds ?? initial.refreshSeconds))) {
        if (refreshQueued.current) {
          refreshQueued.current = false;
          void check(true);
        } else {
          const busy = state.current.draft.pending !== null || state.current.workspace.conversation?.pendingTurnId != null || sendLatch.current;
          // A live page (no conversation) reads itself on the beat its latest read asked for.
          pollDelay.current = initial.conversation ? workspacePollDelay(pollDelay.current, unchanged, busy) : (state.current.workspace.refreshSeconds ?? initial.refreshSeconds!) * 1000;
          refreshTimer.current = window.setTimeout(() => { void check(false); }, pollDelay.current);
        }
      }
    }
  }, [initial, liveTask, updateDraft]);

  // The task's stream says it changed: read now (live-task.tsx).
  useEffect(() => {
    if (!liveTask) return;
    const nudge = () => { void check(true); };
    window.addEventListener(WORKSPACE_NUDGE, nudge);
    return () => window.removeEventListener(WORKSPACE_NUDGE, nudge);
  }, [check, liveTask]);

  useEffect(() => {
    mounted.current = true;
    if (!initial.conversation && !initial.refreshSeconds) return;
    if (initial.conversation) void check();
    else refreshTimer.current = window.setTimeout(() => { void check(false); }, initial.refreshSeconds! * 1000);
    const visible = () => { if (!document.hidden) void check(true); else clearTimeout(refreshTimer.current); };
    const online = () => { setOffline(false); void check(); };
    const offlineNow = () => { setOffline(true); clearTimeout(refreshTimer.current); };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("online", online);
    window.addEventListener("offline", offlineNow);
    return () => {
      mounted.current = false;
      clearTimeout(refreshTimer.current);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offlineNow);
    };
  }, [check, initial.conversation, initial.refreshSeconds]);

  const send = async (event: FormEvent, mode: string | null = null) => {
    event.preventDefault();
    const current = state.current;
    if (sendLatch.current || current.stale || navigator.onLine === false || current.draft.pending
      || current.workspace.conversation?.pendingTurnId !== null || !current.draft.text.trim()) return;
    const next = submitDraft(current.draft);
    if (!next.pending) return;
    sendLatch.current = true;
    setSending(true);
    updateDraft(next);
    setNotice("");
    try {
      const result = await sendMessage(current.workspace, next.pending, fetch, mode);
      if (!mounted.current) return;
      if (result.refused) {
        updateDraft(rejectDraft(state.current.draft, next.pending.request));
        setNotice(result.message ?? "Message not sent. Your draft is saved.");
      } else {
        setNotice("Checking delivery…");
        void check();
      }
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof WorkspaceAuthError) { state.current.stale = true; setStale(true); }
      setNotice(error instanceof WorkspaceAuthError ? error.message : "Delivery is not confirmed. Check again before sending another message.");
      void check();
    } finally {
      sendLatch.current = false;
      if (mounted.current) setSending(false);
    }
  };

  const reconnect = () => {
    const owner = scopeOf(initial);
    if (owner) carryDraft(browserStorage(), owner, state.current.draft.text);
    window.location.reload();
  };

  // Server-owned prompt buttons retain normal native submission. Bind their
  // receipt to this conversation without attaching the old composer script.
  useEffect(() => {
    const onSubmit = (event: SubmitEvent) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement) || form.dataset.workspaceComposer !== undefined || form.getAttribute("action") !== "/chat") return;
      const current = state.current;
      if (!current.workspace.conversation) return;
      if (current.stale || sendLatch.current || current.draft.pending || navigator.onLine === false || current.workspace.conversation.pendingTurnId !== null) {
        event.preventDefault();
        setNotice("Wait for the current message before sending another.");
        return;
      }
      if (form.getAttribute("aria-busy") === "true") { event.preventDefault(); return; }
      const bind = (name: string, value: string) => {
        if (form.querySelector(`[name="${name}"]`)) return;
        const input = document.createElement("input"); input.type = "hidden"; input.name = name; input.value = value; form.append(input);
      };
      bind("request", current.workspace.conversation.requestId);
      bind("request-session", String(current.workspace.conversation.sessionId));
      if (current.workspace.conversation.taskId) bind("task", current.workspace.conversation.taskId);
      if (current.workspace.conversation.resultRunId !== null) bind("result", String(current.workspace.conversation.resultRunId));
      if (event.defaultPrevented) return;
      sendLatch.current = true;
      form.setAttribute("aria-busy", "true");
    };
    const restored = () => {
      sendLatch.current = false;
      document.querySelectorAll('form[action="/chat"][aria-busy="true"]:not([data-workspace-composer])').forEach(form => form.removeAttribute("aria-busy"));
      void check();
    };
    document.addEventListener("submit", onSubmit);
    window.addEventListener("pageshow", restored);
    return () => { document.removeEventListener("submit", onSubmit); window.removeEventListener("pageshow", restored); };
  }, [check]);

  return { workspace, draft, notice, storageAvailable, sending, stale, offline, send, check, reconnect,
    edit: (text: string) => updateDraft(editDraft(state.current.draft, text)) };
}

/** "4m", "2h", "3d" since the task last changed; the exact minute is in the title. Recounted on each refresh. */
function CrewAge({ at }: { at: string }) {
  const words = shortAge(at);
  return words === "" ? null : <time className="so-work-age" dateTime={at} title={whenTitle(at)}>{words}</time>;
}

export function CrewRows({ workspace, items }: { workspace: BrowserWorkspace; items: BrowserWorkspace["crew"] }) {
  return <ul className="so-work-list">{items.map(item => <li key={item.id} data-workspace-task={item.id} data-work-status={item.state}>
    <div className="so-work-row">
      <a className="so-work-link" href={item.resultHref ?? item.href} aria-current={workspace.focus?.id === item.id ? "page" : undefined}>
      <div className="so-work-heading"><span className="so-work-title">{item.title}</span><HeadlineBadge label={item.label} tone={item.tone} className="so-work-badge" /><CrewAge at={item.updatedAt} /></div>
      {item.activity !== undefined && <ActivityLine activity={item.activity} className="so-work-activity text-[12px]" />}
      </a>
      {item.detail && <details className="so-work-reason" key={item.detail}>
        <summary title={item.detail}><span>{item.detail}</span><svg aria-hidden="true" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m4 6 4 4 4-4" /></svg></summary>
      </details>}
      {item.lead && !item.detail?.includes(item.lead) && <span className="so-work-project" data-crew-lead>{item.lead}</span>}
      {item.project && <span className="so-work-project">{workspace.projects.find(project => project.path === item.project)?.name ?? item.project.split(/[\\/]/).filter(Boolean).pop()}</span>}
    </div>
    {item.action && item.action.href !== (item.resultHref ?? item.href) && <a className="so-work-action" href={item.action.href}>{item.action.label}</a>}
  </li>)}</ul>;
}

/** The Chat landing's Work panel (the phone's Work sheet): Home first, the Crew one tab away. */
function WorkPanel({ workspace, home }: { workspace: BrowserWorkspace; home: NonNullable<BrowserWorkspace["home"]> }) {
  const [tab, setTab] = useState<"home" | "crew">("home");
  const tabs = useId();
  return <>
    <div className="so-work-tabs"><div role="tablist" aria-label="Work" className="so-ask-tabs">
      <button type="button" role="tab" id={`${tabs}-home`} aria-controls={`${tabs}-home-panel`} aria-selected={tab === "home"} onClick={() => setTab("home")}>Home</button>
      <button type="button" role="tab" id={`${tabs}-crew`} aria-controls={`${tabs}-crew-panel`} aria-selected={tab === "crew"} onClick={() => setTab("crew")}>Crew</button>
    </div></div>
    <div role="tabpanel" id={`${tabs}-home-panel`} aria-labelledby={`${tabs}-home`} className="so-work-home" data-view="home" hidden={tab !== "home"}><Home home={home} compact /></div>
    <div role="tabpanel" id={`${tabs}-crew-panel`} aria-labelledby={`${tabs}-crew`} hidden={tab !== "crew"}><Crew workspace={workspace} /></div>
  </>;
}

/** Active work leads; finished work waits behind one disclosure. */
function Crew({ workspace }: { workspace: BrowserWorkspace }) {
  const isFinished = (item: BrowserWorkspace["crew"][number]) => item.tone === "done" || item.state === "cancelled";
  const active = workspace.crew.filter(item => !isFinished(item));
  const finished = workspace.crew.filter(isFinished);
  return <section className="so-crew" aria-labelledby="crew-title" data-workspace-crew>
    <div className="so-section-heading"><h2 id="crew-title">Crew</h2><a href="/work">All tasks</a></div>
    {workspace.crew.length === 0 ? <div className="so-crew-empty"><p>No tasks yet.</p><p>Work you start with the lead appears here.</p></div> : <>
      {active.length > 0 ? <CrewRows workspace={workspace} items={active} /> : <p className="so-crew-quiet">Nothing is running or waiting on you.</p>}
      {finished.length > 0 && <Disclosure summary={`Finished (${finished.length}${workspace.crewTruncated ? "+" : ""})`} className="so-crew-finished"><CrewRows workspace={workspace} items={finished.slice(0, 8)} /></Disclosure>}
    </>}
    {workspace.crewTruncated && <a className="so-all-work" href="/work">View more tasks</a>}
  </section>;
}

function Navigation({ workspace }: { workspace: BrowserWorkspace }) {
  const projectId = useId();
  const currentProject = workspace.projects.find(project => new URL(workspace.path, window.location.origin).searchParams.get("project") === project.path
    || new URL(workspace.path, window.location.origin).searchParams.get("repo") === project.path
    || workspace.crew.find(task => task.id === workspace.focus?.id)?.project === project.path);
  return <div className="so-navigation-content">
    <a href="/chat" className="so-wordmark"><span className="so-brand-mark" aria-hidden="true"><i /><i /><i /></span>Toolroll</a>
    <a href="/tasks/new" className="so-new-task"><Icon name="plus" />New task</a>
    {workspace.projects.length > 0 && <div className="so-project-switch">
      <Label htmlFor={projectId}>Project</Label>
      <select id={projectId} value={currentProject?.href ?? "/work"} onChange={event => { window.location.assign(event.target.value); }}>
        <option value="/work">All projects</option>
        {workspace.projects.map(project => <option key={project.path} value={project.href}>{project.name}</option>)}
      </select>
    </div>}
    <nav aria-label="Workspace" className="so-primary-navigation">{workspace.navigation.filter(item => item.href !== "/menu").map(item => {
      const name = item.label.toLowerCase() as "chat" | "tasks" | "flows" | "projects" | "knowledge" | "settings";
      return <a key={item.href} href={item.href} aria-current={item.active ? "page" : undefined}><Icon name={["chat", "tasks", "flows", "projects", "knowledge", "settings"].includes(name) ? name : "tools"} /><span>{item.label}</span>
        {item.count !== undefined && item.count > 0 && <span className="so-nav-count" aria-label={item.countLabel ?? `${item.count} ${item.count === 1 ? "needs" : "need"} you`} title={item.countLabel}>{item.count}</span>}</a>;
    })}</nav>
    {currentProject && <div className="so-project-links">
      <a className="so-project-knowledge" href={`/chat?project=${encodeURIComponent(currentProject.path)}`}>Project chat</a>
      <a className="so-project-knowledge" href={currentProject.knowledgeHref}>Project knowledge</a>
    </div>}
    {(workspace.chats?.length ?? 0) > 0 && <nav aria-label="Recent chats" className="so-recent-chats">
      <p className="so-recent-chats-label">Recent chats</p>
      {workspace.chats!.map(chat => <a key={chat.href} href={chat.href} aria-current={chat.active ? "page" : undefined} title={chat.title}>
        <span className="so-recent-chat-kind" aria-hidden="true">{chat.kind === "task" ? "Task" : "Project"}</span><span className="so-recent-chat-title">{chat.title}</span>
      </a>)}
    </nav>}
    <div className="so-navigation-bottom"><a href="/menu" aria-current={workspace.navigation.find(item => item.href === "/menu")?.active ? "page" : undefined}><Icon name="tools" />Workspace tools</a>
      <div className="so-account"><span title={workspace.user}>{workspace.user}</span><form method="post" action="/logout"><input type="hidden" name="csrf" value={workspace.csrf} /><Button variant="ghost" size="sm" type="submit">Sign out</Button></form></div>
    </div>
  </div>;
}

export function workspaceCommands(workspace: BrowserWorkspace, query = "") {
  const entries = [
    ...workspace.navigation.map(item => ({ label: item.label, detail: "Page", href: item.href })),
    ...workspace.projects.map(item => ({ label: item.name, detail: "Project", href: item.href })),
    ...workspace.crew.map(item => ({ label: item.title, detail: item.label, href: item.resultHref ?? item.href })),
  ];
  // The same place under two names (a single project's page is also where Tasks leads) stays findable by both.
  const seen = new Set<string>();
  return entries.filter(item => {
    const key = `${item.label}\n${item.href}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return `${item.label} ${item.detail}`.toLowerCase().includes(query.trim().toLowerCase());
  });
}

export function CommandMenu({ workspace }: { workspace: BrowserWorkspace }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchId = useId();
  const searchInput = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLUListElement>(null);
  const changeOpen = (next: boolean) => { setOpen(next); setQuery(""); };
  useEffect(() => {
    if (workspace.sensitive) return;
    const shortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== "k"
        || event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]')) return;
      event.preventDefault(); setOpen(value => !value); setQuery("");
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [workspace.sensitive]);
  if (workspace.sensitive) return null;
  const entries = workspaceCommands(workspace, query);
  return <Dialog open={open} onOpenChange={changeOpen}>
    <DialogTrigger asChild><Button variant="ghost" size="sm" className="so-command-trigger">Search<span className="so-command-hint" aria-hidden="true">{"⌘\u00a0/\u00a0Ctrl\u00a0K"}</span></Button></DialogTrigger>
    <DialogContent className="so-command-dialog" data-workspace-command onOpenAutoFocus={event => { event.preventDefault(); searchInput.current?.focus(); }}>
      <div className="so-command-heading"><DialogTitle>Go to</DialogTitle><DialogClose asChild><Button variant="ghost" size="icon" aria-label="Close search"><Icon name="close" /></Button></DialogClose></div>
      <DialogDescription className="so-sr-only">Search pages, projects, and tasks. Use Tab or the arrow keys to choose a link.</DialogDescription>
      <Label htmlFor={searchId} className="so-sr-only">Search workspace</Label>
      <Input ref={searchInput} id={searchId} type="search" placeholder="Search workspace…" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
        if (event.key === "ArrowDown") { event.preventDefault(); results.current?.querySelector("a")?.focus(); }
      }} />
      <ul ref={results} className="so-command-results" onKeyDown={event => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        const links = Array.from(results.current?.querySelectorAll("a") ?? []);
        const index = links.indexOf(document.activeElement as HTMLAnchorElement);
        if (index < 0) return;
        event.preventDefault(); links[(index + (event.key === "ArrowDown" ? 1 : -1) + links.length) % links.length]?.focus();
      }}>{entries.map(item => <li key={item.href}><a href={item.href}><span>{item.label}</span><small>{item.detail}</small></a></li>)}</ul>
      {entries.length === 0 && <p className="so-command-empty" role="status">No matches.</p>}
    </DialogContent>
  </Dialog>;
}

function PhoneNavigation({ workspace }: { workspace: BrowserWorkspace }) {
  return <Dialog><DialogTrigger asChild><Button variant="ghost" size="icon" className="so-mobile-menu" aria-label="Open navigation"><Icon name="menu" /></Button></DialogTrigger>
    <DialogContent className="so-navigation-dialog"><DialogTitle className="so-sr-only">Workspace navigation</DialogTitle><DialogDescription className="so-sr-only">Choose a project or a workspace page.</DialogDescription>
      <DialogClose asChild><Button variant="ghost" size="icon" className="so-navigation-close" aria-label="Close navigation"><Icon name="close" /></Button></DialogClose><Navigation workspace={workspace} />
    </DialogContent></Dialog>;
}

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

function ThreadMessage({ message, workspace, onChanged }: { message: BrowserMessage; workspace: BrowserWorkspace; onChanged: () => void }) {
  return <Message from={message.role === "operator" ? "user" : "assistant"} data-message-id={message.id}>
    <div className="so-message-label">{message.role === "operator" ? "You" : workspace.leadName ?? "Lead"}</div>
    <MessageContent><GuardedHtml html={message.html} />{message.activity && <Disclosure summary="Activity"><p className="so-activity-copy">{message.activity}</p></Disclosure>}
      {message.cards !== undefined && message.cards.length > 0
        ? <ActionCards cards={message.cards} csrf={workspace.csrf} onChanged={onChanged} />
        : message.cardsHtml && <GuardedHtml html={message.cardsHtml} className="so-message-cards" />}
    </MessageContent>
  </Message>;
}

function LeadChat({ controller, docked = null }: { controller: ReturnType<typeof useWorkspace>; docked?: string | null }) {
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
  const disabled = sending || stale || offline || busy || draft.pending !== null || !draft.text.trim();
  // A phone starts the box at one line (Send sits beside it); a desk keeps its two.
  useLayoutEffect(() => { const el = box.current; if (el) { const phone = matchMedia("(max-width: 760px)").matches; el.style.height = phone ? "0px" : "auto"; el.style.height = `${Math.min(180, Math.max(phone ? 44 : 48, el.scrollHeight))}px`; } }, [draft.text]);
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
            <div className="so-suggestions">{dock.suggestions.map(one => <button key={one} type="button" className="so-suggestion" onClick={() => { controller.edit(one); box.current?.focus(); }}>{one.trim().replace(/:$/, "…")}</button>)}</div></div>
        : <><ConversationEmptyState title="What would you like to work on?" />
            {/* v99: or a working setup in one click — a teammate and the flow it works. */}
            <nav className="so-kit-links" aria-label="Starter kits" data-kit-links><span>Or start from a kit:</span>{KIT_LINKS.map(([id, label]) => <a key={id} className="so-suggestion" href={`/kits/${id}`}>{label}</a>)}</nav></>)}
      <div id="chat-thread" data-chat-region="thread">{chat.messages.map(message => <ThreadMessage key={message.id} message={message} workspace={workspace} onChanged={() => { void controller.check(); }} />)}</div>
      {(busy || live !== null) && <LiveReplyBubble live={live} leadName={workspace.leadName ?? "Lead"} />}
    </ConversationContent><ConversationScrollButton /></Conversation>
    <div className="so-composer-area">
      {!dock && workspace.firstRun && chat.messages.length === 0 && !busy && <FirstRequest firstRun={workspace.firstRun} onDraft={text => { controller.edit(withSuggestion(draft.text, text)); box.current?.focus(); }} />}
      {delivery && <div className="so-connection" role={stale ? "alert" : "status"}><span>{delivery}</span>
        {stale ? <Button variant="secondary" size="sm" onClick={controller.reconnect}>Reconnect</Button> : !sending && !offline && <Button variant="ghost" size="sm" onClick={() => { void controller.check(); }}>Check again</Button>}
      </div>}
      <form onSubmit={controller.send} action="/chat" method="post" data-workspace-composer aria-busy={sending}>
        <Label htmlFor="lead-message" className="so-sr-only">Message your lead</Label>
        {commandMatches.length > 0 && <ul id={commandList} role="listbox" aria-label="Commands" className="so-slash-menu">
          {commandMatches.map((one, index) => <li key={one.command} role="option" aria-selected={index === Math.min(commandIndex, commandMatches.length - 1)}
            onMouseDown={event => { event.preventDefault(); applyCommand(one); }}>
            <span className="so-slash-name">/{one.command}</span><span className="so-slash-hint">{one.hint}</span>
          </li>)}
        </ul>}
        <Textarea ref={box} id="lead-message" name="message" rows={2} maxLength={chat.maxChars} placeholder={dock?.placeholder ?? "Message your lead…"} value={draft.text}
          role={commandMatches.length > 0 ? "combobox" : undefined} aria-expanded={commandMatches.length > 0 ? true : undefined} aria-controls={commandMatches.length > 0 ? commandList : undefined}
          onChange={event => { setCommandsClosed(false); controller.edit(event.target.value); }} onKeyDown={event => {
            if (commandMatches.length > 0) {
              const current = Math.min(commandIndex, commandMatches.length - 1);
              if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setCommandIndex((current + (event.key === "ArrowDown" ? 1 : commandMatches.length - 1)) % commandMatches.length); return; }
              if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") { event.preventDefault(); applyCommand(commandMatches[current]!); return; }
              if (event.key === "Escape") { event.preventDefault(); setCommandsClosed(true); return; }
            }
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!disabled) event.currentTarget.form?.requestSubmit(); }
          }} aria-describedby="composer-hint" />
        <div className="so-composer-actions"><span id="composer-hint">{!storageAvailable ? "Draft stays on this page only." : draft.text.length > chat.maxChars - 200 ? `${draft.text.length} / ${chat.maxChars}` : "/ for commands · Shift + Enter for a new line"}</span>
          <Button type="submit" disabled={disabled} aria-label="Send message"><Icon name="send" /><span>Send</span></Button>
        </div>
      </form>
      {!dock && workspace.controlsHtml && <Disclosure summary="Conversation settings" className="so-conversation-settings"><GuardedHtml html={workspace.controlsHtml} immutable /></Disclosure>}
    </div>
  </div>;
}

/** The task composer's modes: what the lead may come back with. Every action
 * still arrives as a card the person confirms; the mode grants nothing. */
const TASK_MODES = [
  { id: "build", label: "Build", hint: "Changes come back for you to confirm" },
  { id: "plan", label: "Plan only", hint: "A plan only; nothing is filed" },
  { id: "answer", label: "Just answer", hint: "An answer only" },
] as const;
type TaskMode = (typeof TASK_MODES)[number]["id"];

/** The task's conversation as thread entries, and the composer that ends the
 * thread. Sending is the same one POST to /chat as every chat composer. */
function useTaskThreadChat(controller: ReturnType<typeof useWorkspace>): ThreadChat | null {
  const { workspace, draft, notice, storageAvailable, sending, stale, offline } = controller;
  const chat = workspace.conversation;
  const box = useRef<HTMLTextAreaElement>(null);
  const modeName = useId();
  const [mode, setMode] = useState<TaskMode>("build");
  // Only a task page's thread watches here; every other conversation has its own LeadChat.
  const active = chat !== null && !!chat.taskId && !workspace.team && workspace.view?.kind === "task";
  const busy = chat !== null && chat.pendingTurnId !== null;
  const live = useLiveReply(chat, active && (busy || (draft.pending !== null && !sending)), () => { void controller.check(); });
  useLayoutEffect(() => { const el = box.current; if (el) { const phone = matchMedia("(max-width: 760px)").matches; el.style.height = phone ? "0px" : "auto"; el.style.height = `${Math.min(180, Math.max(phone ? 44 : 48, el.scrollHeight))}px`; } }, [draft.text]);
  if (!active || chat === null) return null;
  const disabled = sending || stale || offline || busy || draft.pending !== null || !draft.text.trim();
  const delivery = offline ? "Offline. Your draft stays in this tab." : sending ? "Sending…" : notice;
  const hint = TASK_MODES.find(one => one.id === mode)!.hint;
  return {
    entries: chat.messages.map(message => ({ key: `message-${message.id}`, at: message.createdAt, node:
      <li key={`message-${message.id}`} data-message-id={message.id} data-thread-kind="message" className="so-thread-entry relative flex gap-3">
        <span aria-hidden="true" className="relative z-[1] flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-card text-[10.5px] font-semibold text-muted-foreground">{message.role === "operator" ? "Y" : (workspace.leadName ?? "Lead").slice(0, 1).toUpperCase()}</span>
        <div className="min-w-0 flex-1 pb-5 phone:pb-4">
          <p className="flex min-h-6 flex-wrap items-baseline gap-x-2 text-[13px] leading-6">
            <span className="font-medium">{message.role === "operator" ? "You" : workspace.leadName ?? "Lead"}</span>
            <time dateTime={message.createdAt} className="ml-auto text-xs tabular-nums text-muted-foreground">{threadWhen(message.createdAt)}</time>
          </p>
          <MessageContent className={message.role === "operator" ? "so-thread-mine" : "so-thread-theirs"}><GuardedHtml html={message.html} />
            {message.activity && <Disclosure summary="Activity"><p className="so-activity-copy">{message.activity}</p></Disclosure>}
            {message.cards !== undefined && message.cards.length > 0
              ? <ActionCards cards={message.cards} csrf={workspace.csrf} onChanged={() => { void controller.check(); }} />
              : message.cardsHtml && <GuardedHtml html={message.cardsHtml} className="so-message-cards" />}
          </MessageContent>
        </div>
      </li> })),
    footer: <div className="so-task-composer flex flex-col gap-2">
      {(busy || live !== null) && <LiveReplyBubble live={live} leadName={workspace.leadName ?? "Lead"} />}
      {delivery && <div className="so-connection" role={stale ? "alert" : "status"}><span>{delivery}</span>
        {stale ? <ViewButton variant="outline" size="sm" onClick={controller.reconnect}>Reconnect</ViewButton> : !sending && !offline && <ViewButton variant="ghost" size="sm" onClick={() => { void controller.check(); }}>Check again</ViewButton>}
      </div>}
      <form onSubmit={event => { void controller.send(event, mode); }} action="/chat" method="post" data-workspace-composer data-task-composer aria-busy={sending}
        className="rounded-xl border border-input bg-card px-3 pb-2 pt-2.5 shadow-[0_1px_2px_rgb(0_0_0/.04)] transition-[border-color,box-shadow] duration-100 focus-within:border-attention focus-within:shadow-[0_0_0_3px_var(--so-signal-soft)] phone:px-2.5">
        <label htmlFor="task-message" className="sr-only">Message the agent</label>
        <textarea ref={box} id="task-message" name="message" rows={2} maxLength={chat.maxChars} placeholder="Message the agent: ask, or ask for a change" value={draft.text}
          className="block max-h-[180px] min-h-12 w-full resize-none px-0.5 pb-2 text-sm leading-relaxed outline-none placeholder:text-muted-foreground phone:min-h-11 phone:text-base"
          onChange={event => controller.edit(event.target.value)} onKeyDown={event => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!disabled) event.currentTarget.form?.requestSubmit(); }
          }} aria-describedby="task-composer-hint" />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div role="radiogroup" aria-label="Mode" className="so-mode-switch">
            {TASK_MODES.map(one => <label key={one.id} className="so-mode" data-mode={one.id}>
              <input type="radio" name={modeName} value={one.id} checked={mode === one.id} onChange={() => setMode(one.id)} />
              <span>{one.label}</span>
            </label>)}
          </div>
          <span id="task-composer-hint" className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{!storageAvailable ? "Draft stays on this page only." : draft.text.length > chat.maxChars - 200 ? `${draft.text.length} / ${chat.maxChars}` : hint}</span>
          <ViewButton type="submit" size="sm" disabled={disabled} aria-label="Send message" className={cn("ml-auto")}><Icon name="send" /><span>Send</span></ViewButton>
        </div>
      </form>
    </div>,
  };
}

/** The workspace scrolls inside its panes; the window never should. A #section
 * link can still scroll the window (the browser jumps to the section before the
 * panes exist), which left the page above the screen and blank on a phone. Put
 * the window back, and bring the section into view inside its pane instead. */
/** A demo database says so once: the whole sentence on a desk, one line on a phone. */
function DemoNotice({ demo }: { demo: BrowserWorkspace["demo"] }) {
  if (demo === undefined) return null;
  return <Alert className="so-demo-notice" data-demo-notice title={demo.text}>
    <span className="so-demo-notice-full">{demo.text}</span><span className="so-demo-notice-short">{demo.short}</span>
  </Alert>;
}

function useWindowStaysPut() {
  useEffect(() => {
    const settle = () => { if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0); };
    const reveal = () => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      const target = id === "" || id === "workspace-main" ? null : document.getElementById(id);
      // A link to exact lines inside a folded file (a result's mismatch, a check log) opens its folds first.
      for (let node = target?.parentElement ?? null; node !== null; node = node.parentElement) if (node instanceof HTMLDetailsElement) node.open = true;
      target?.scrollIntoView({ block: "start" });
      settle();
    };
    const frame = requestAnimationFrame(reveal);
    window.addEventListener("scroll", settle, { passive: true });
    window.addEventListener("hashchange", reveal);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("scroll", settle); window.removeEventListener("hashchange", reveal); };
  }, []);
}

export function WorkspaceApp({ initial }: { initial: BrowserWorkspace }) {
  const controller = useWorkspace(initial);
  const [teamSnapshot, setTeamSnapshot] = useState<TeamSnapshot | undefined>(initial.team);
  const workspace = teamSnapshot?.tasks ? { ...controller.workspace, ...browserCrewFromIndex(teamSnapshot.tasks, teamSnapshot.selected?.id) } : controller.workspace;
  const [phoneView, setPhoneView] = useState<"chat" | "work">(workspace.result || workspace.focus ? "work" : "chat");
  const hasWork = workspace.focus !== null || workspace.result !== null;
  const selectedTask = workspace.crew.find(item => item.id === workspace.focus?.id);
  const isChat = workspace.navigation.some(item => item.label === "Chat" && item.active);
  const section = workspace.navigation.find(item => item.active)?.label ?? (workspace.title.charAt(0).toUpperCase() + workspace.title.slice(1));
  // The Ask panel (v77): a page with its own view and its own conversation
  // keeps the page in the middle and the conversation beside it.
  // A task page (console v2): the conversation is the page's own thread, and
  // the right sheet is its Details (a Details sheet on a phone).
  const taskView = !workspace.team && workspace.view?.kind === "task" ? workspace.view : null;
  const docked = !workspace.team && workspace.conversation !== null && workspace.view != null && taskView === null;
  const [panelTab, setPanelTab] = useState<"chat" | "crew">("chat");
  const pageOnly = !workspace.team && (!workspace.conversation || docked || taskView !== null);
  const taskChat = useTaskThreadChat(controller);
  useEffect(() => {
    if (taskView === null) return;
    const show = () => setPhoneView("work");
    window.addEventListener("so:show-details", show);
    // A link that arrives at a fold in Details (#scope, #holds…) opens the sheet on a phone.
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (id !== "" && document.getElementById(id)?.closest("[data-task-details]")) show();
    return () => window.removeEventListener("so:show-details", show);
  }, [taskView === null]);
  // The Tasks page already lists every task; the Crew panel would repeat it.
  // A flow's canvas needs the whole width.
  // Pages that are themselves a list of work, or need the width (the board's columns, a coding session), go without the side panel.
  const pathname = new URL(workspace.path, window.location.origin).pathname;
  const hidePanel = pageOnly && !docked && !hasWork && (FULL_WIDTH_PAGES.has(pathname) || pathname.startsWith("/code/") || workspace.view?.kind === "flow");
  const [dismissedUpdate, setDismissedUpdate] = useState<string | null>(null);
  const update = workspace.update !== undefined && workspace.update.version !== dismissedUpdate ? workspace.update : null;
  // The demo notice scrolls away with a page; a chat keeps it above.
  const demo = workspace.demo;
  const pageScrolls = !workspace.team && !(workspace.conversation && !docked && taskView === null);
  // The Chat landing keeps Home beside the conversation, not inside it.
  const home = isChat && !hasWork && !docked && taskView === null && !workspace.team ? workspace.home ?? null : null;
  // After the first Ready result: one line pointing to the phone setup in Settings, until put away.
  const [phoneDismissed, setPhoneDismissed] = useState(false);
  const phone = isChat && workspace.conversation !== null && !docked && taskView === null && !phoneDismissed ? workspace.phone ?? null : null;
  useEffect(notifyWorkspaceRendered, []);
  useWindowStaysPut();
  return <><Toaster /><div className={`so-workspace${hidePanel ? " so-workspace--single" : ""}${docked || taskView !== null ? " so-workspace--docked" : ""}${taskView !== null ? " so-workspace--details" : ""}`} data-workspace-shell data-workspace-phone-view={phoneView} data-workspace-has-result={workspace.result !== null}>
    <a href="#workspace-main" className="so-skip-link">Skip to content</a>
    <aside className="so-sidebar"><Navigation workspace={workspace} /></aside>
    <div className={`so-main-column${isChat ? " so-main-column--chat" : ""}`}>
      <header className="so-workspace-header"><PhoneNavigation workspace={workspace} />{pageOnly
        ? <p className="so-header-title">{section}</p>
        : <h1>{isChat ? workspace.leadName ?? "Lead" : section}</h1>}
        {workspace.focus && isChat && <span className="so-focus-label" title={workspace.focus.title}>{workspace.focus.title}</span>}
        <CommandMenu workspace={workspace} />
        {isChat && <Button variant="secondary" size="sm" className="so-phone-work-button" onClick={() => setPhoneView("work")}>{hasWork ? "Open work" : home !== null ? "Work" : "Crew"}</Button>}
        {docked && <Button variant="secondary" size="sm" className="so-phone-work-button" onClick={() => { setPanelTab("chat"); setPhoneView("work"); }}><Icon name="chat" />Ask</Button>}
        {taskView !== null && <Button variant="secondary" size="sm" className="so-phone-work-button" data-open-details onClick={() => setPhoneView("work")}>Task details</Button>}
      </header>
      {(workspace.notices.length > 0 || (workspace.signIn?.length ?? 0) > 0 || update !== null || phone !== null || (demo !== undefined && !pageScrolls)) && <div className="so-workspace-notices">
        {!pageScrolls && <DemoNotice demo={demo} />}
        {workspace.signIn?.map(item => <Alert key={item.provider} className="so-sign-in" data-sign-in={item.provider}>
          <p className="so-sign-in-title">{item.title}</p>
          <p className="so-sign-in-detail">Run <code>{item.command}</code> on this computer, then resume.{item.detail === "" ? "" : ` ${item.detail}`}</p>
          <form method="post" action={item.resumeHref}><input type="hidden" name="csrf" value={workspace.csrf} /><Button size="sm" type="submit">{item.resumeLabel}</Button></form>
        </Alert>)}
        {workspace.notices.map((notice, index) => <Alert key={index}>{notice}</Alert>)}
        {update !== null && <Alert className="so-update" data-update={update.version}>
          <p><span>{updateNoticeWords(update)}</span> · <a href={update.href}>What's new</a></p>
          <form method="post" action={update.dismissHref} onSubmit={event => {
            // Dismissed at once; the cookie that keeps it dismissed is saved in the background.
            event.preventDefault();
            setDismissedUpdate(update.version);
            void fetch(update.dismissHref, { method: "POST", body: new URLSearchParams({ csrf: workspace.csrf, version: update.version, quiet: "1" }) }).catch(() => {});
          }}>
            <input type="hidden" name="csrf" value={workspace.csrf} /><input type="hidden" name="version" value={update.version} />
            <Button variant="ghost" size="icon" type="submit" aria-label={`Dismiss the notice about ${update.version}`}><Icon name="close" /></Button>
          </form>
        </Alert>}
        {phone !== null && <Alert className="so-update so-phone-notice" data-phone-notice>
          <p><span>Use it from your phone too</span> · <a href="/settings#settings-chat-apps">Set up</a></p>
          <form method="post" action={phone.dismissHref} onSubmit={event => {
            // The same installation-wide put-away as before; the setup stays in Settings → Chat apps.
            event.preventDefault();
            setPhoneDismissed(true);
            void fetch(phone.dismissHref, { method: "POST", body: new URLSearchParams({ csrf: workspace.csrf, quiet: "1" }) }).catch(() => {});
          }}>
            <input type="hidden" name="csrf" value={workspace.csrf} />
            <Button variant="ghost" size="icon" type="submit" aria-label="Dismiss the phone notice"><Icon name="close" /></Button>
          </form>
        </Alert>}
      </div>}
      <main id="workspace-main" className="so-main-content" tabIndex={-1}>
        {workspace.team ? <TeamChat initial={workspace.team} user={workspace.user} csrf={workspace.csrf} onSnapshot={setTeamSnapshot} /> : workspace.conversation && !docked && taskView === null ? <LeadChat controller={controller} /> : <div className="so-page-content" data-workspace-page><DemoNotice demo={demo} />{isChat && workspace.firstRun && <FirstRun firstRun={workspace.firstRun} />}{workspace.view ? <ViewHost view={workspace.view} csrf={workspace.csrf} taskChat={taskChat} taskDetails={false} /> : <GuardedHtml html={initial.pageHtml ?? ""} immutable />}</div>}
      </main>
    </div>
    {docked && <aside className="so-supporting-panel so-ask-panel" data-workspace-detail aria-label="Ask">
      <div className="so-ask-header">
        <Button variant="ghost" size="sm" className="so-phone-back" onClick={() => setPhoneView("chat")}><Icon name="arrow" />Back</Button>
        <div role="tablist" aria-label="Panel" className="so-ask-tabs">
          <button type="button" role="tab" aria-selected={panelTab === "chat"} onClick={() => setPanelTab("chat")}>Chat</button>
          <button type="button" role="tab" aria-selected={panelTab === "crew"} onClick={() => setPanelTab("crew")}>Crew</button>
        </div>
      </div>
      <div className="so-ask-body" hidden={panelTab !== "chat"}><LeadChat controller={controller} docked={workspace.view?.kind ?? "task"} /></div>
      {panelTab === "crew" && <Crew workspace={workspace} />}
    </aside>}
    {taskView !== null && <aside className="so-supporting-panel so-details-panel" data-workspace-detail aria-label="Task details">
      <div className="so-details-header">
        <Button variant="ghost" size="sm" className="so-phone-back" onClick={() => setPhoneView("chat")}><Icon name="arrow" />Back</Button>
        <h2>Task details</h2>
      </div>
      <div data-view="task-details" className="w-full"><TaskDetails view={taskView} /></div>
    </aside>}
    {!hidePanel && !docked && taskView === null && <aside className={`so-supporting-panel${hasWork ? " so-supporting-panel--detail" : ""}`} data-workspace-detail>
      <div className="so-work-panel-header"><Button variant="ghost" size="sm" className="so-phone-back" onClick={() => setPhoneView("chat")}><Icon name="arrow" />{isChat ? "Back to chat" : "Back"}</Button>
        {hasWork && <><h2>{workspace.result ? "Result" : "Task"}</h2>{workspace.result && selectedTask && <HeadlineBadge label={selectedTask.label} tone={selectedTask.tone} className="so-current-task-state" data-workspace-current-task-state="" />}<a href={teamSnapshot?.selected ? "/chat?conversation=" + encodeURIComponent(teamSnapshot.selected.id) : "/chat"} className="so-close-work" aria-label="Close work and return to the main chat"><Icon name="close" /></a></>}
      </div>
      {hasWork ? <div className="so-work-detail-content">
        {workspace.focus && (workspace.result
          ? <Disclosure summary="Task details" className="so-result-task-details"><GuardedHtml key={workspace.focus.id} html={workspace.focus.html} className="so-task-context" /></Disclosure>
          : <GuardedHtml key={workspace.focus.id} html={workspace.focus.html} className="so-task-context" />)}
        {workspace.result && <Artifact data-workspace-result={workspace.result.runId}><ArtifactContent><GuardedHtml key={workspace.result.runId} html={workspace.result.html} immutable /></ArtifactContent></Artifact>}
      </div> : home !== null ? <WorkPanel workspace={workspace} home={home} /> : <Crew workspace={workspace} />}
    </aside>}
  </div></>;
}

// The cross-fade between pages is a nicety: when the browser skips it (the next
// page opts out, or the tab is hidden) its promises reject, and nothing waits on
// them. Settle them so a skipped fade never reads as a page error.
type Fade = { finished?: Promise<unknown>; ready?: Promise<unknown>; updateCallbackDone?: Promise<unknown> };
const settleFade = (event: Event) => {
  const fade = (event as Event & { viewTransition?: Fade | null }).viewTransition;
  for (const one of [fade?.finished, fade?.ready, fade?.updateCallbackDone]) one?.catch(() => undefined);
};
window.addEventListener("pageswap", settleFade);
window.addEventListener("pagereveal", settleFade);

const mount = document.getElementById("standing-orders-workspace");
const data = document.getElementById("standing-orders-workspace-data");
if (mount && data) {
  try {
    const initial: unknown = JSON.parse(data.textContent ?? "null");
    if (!isWorkspace(initial)) throw new Error("Workspace data is incomplete");
    createRoot(mount).render(<WorkspaceApp initial={initial} />);
  } catch {
    // The server-rendered fallback remains usable if mounting cannot start.
    mount.setAttribute("data-workspace-unavailable", "true");
  }
}
