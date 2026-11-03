import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { StatusGlyph, type GlyphKind } from "./components/ui/status-glyph.js";
import type { FormEvent } from "react";
import { createRoot } from "react-dom/client";
import type { BrowserCrewItem, BrowserProjectState, BrowserRailTask, BrowserWorkspace } from "../browser-workspace.js";
import { DISPLAY_STATES, STATE_WORDS, type DisplayState } from "../agent-state-words.js";
import {
  Alert, Artifact, ArtifactContent, Disclosure, MessageContent, FormToken, Passwordless, PostForm } from "./ui/index.js";
import {
  awaitReceipt, carryDraft, editDraft, emptyDraft, isWorkspace, queuedDraft, readWorkspace, receiveDraft, rejectDraft,
  restoreDraft, sameConversation, saveDraft, sendMessage, submitDraft, WorkspaceAuthError,
} from "./workspace-client.js";
import type { ChatDraft, DraftScope, DraftStorage } from "./workspace-client.js";
import { TeamChat } from "./team-chat.js";
import { LiveReplyBubble, useLiveReply } from "./live-reply.js";
import { browserCrewFromIndex } from "../browser-crew.js";
import type { TeamSnapshot } from "../team-contract.js";
import { GuardedHtml, notifyWorkspaceRendered, regionIsEditing } from "./guarded-html.js";
import { ActionCards } from "./chat-cards.js";
import { LineSteer } from "./line-steer.js";
import { FirstRun } from "./first-run.js";
import { TaskDetails, ViewHost, type ThreadChat } from "./views/index.js";
import { threadWhen, whenTitle } from "./views/task-view.js";
import { HeadlineBadge, headlineGlyph } from "./views/status-summary.js";
import { Toaster, Button as ViewButton, cn } from "./components/ui/index.js";
import { updateNoticeWords } from "../update-notice.js";
import { shortAge } from "../when-html.js";
import { useLiveRoom } from "./live.js";
import { createChime } from "./chime.js";
import { ActivityLine, WORKSPACE_NUDGE } from "./live-task.js";
import { isSettingsFrame } from "../settings-kit-script.js";
import { installKitBehavior } from "./kit/behavior.js";
import { Icon } from "./icons.js";
import { LeadChat, returnSends } from "./lead-chat.js";
import { NeedsDock, PhoneHeader, Rail, needsOf } from "./shell.js";
import { SearchMenu } from "./search.js";
import "./workspace.css";

export { GuardedHtml, regionIsEditing };
export { REPLACED_THREAD_DIVIDER, replyTook } from "./lead-chat.js";

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

const FULL_WIDTH_PAGES = new Set(["/work", "/work/put-away", "/agents", "/board", "/queue", "/workbench", "/code"]);

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
  const refreshTag = useRef<string | null>(null);
  const refreshRetry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearRefreshRetry = useCallback(() => {
    if (refreshRetry.current !== null) clearTimeout(refreshRetry.current);
    refreshRetry.current = null;
  }, []);
  const mounted = useRef(true);
  const sendLatch = useRef(false);

  /** The conversation this page's own send started, by its acknowledgement (quiet page visits). */
  const startedBySend = useRef<number | null>(null);
  const updateDraft = useCallback((next: ChatDraft) => {
    state.current.draft = next;
    setDraft(next);
    // The draft lives with the conversation shown now: once a first send started it, a reload restores it from there.
    const owner = scopeOf(state.current.workspace);
    if (owner) setStorageAvailable(saveDraft(browserStorage(), owner, next));
  }, []);

  // A task page follows its task's room (live-task.tsx); a conversation or a live page follows the workspace's.
  const liveTask = initial.view?.kind === "task" && initial.view.live != null && !initial.sensitive;
  // The Agents board follows the workspace too, and its opened agent's own room nudges it (agents-view.tsx).
  // Home follows the workspace the same way: its counts and rows move as work does, and an answer given in place re-reads it.
  const agentsBoard = (initial.view?.kind === "agents" || initial.view?.kind === "home") && !initial.sensitive;
  const followsWorkspace = Boolean(initial.conversation || initial.refreshSeconds || agentsBoard);
  const check = useCallback(async (force = true, retry = false): Promise<void> => {
    clearRefreshRetry();
    if (!mounted.current || state.current.stale || !(followsWorkspace || liveTask) || !canRefreshWorkspace()) return;
    // A send, a nudge or an explicit refresh during a read runs immediately afterward,
    // rather than lose its receipt check or start an overlapping request.
    if (polling.current) { refreshQueued.current = true; return; }
    refreshQueued.current = false;
    polling.current = true;
    const asked = state.current.draft.pending?.request ?? null;
    try {
      const read = await readWorkspace(state.current.workspace, asked, fetch, { etag: refreshTag.current, force });
      if (!mounted.current) return;
      // A receipt query is a different representation from the ordinary view.
      refreshTag.current = asked ? null : read.etag;
      if (read.kind === "unchanged") {
        if (!state.current.draft.pending && state.current.notice) setNotice("");
        return;
      }
      const next = read.workspace;
      // A page that showed no conversation accepts the one its own send started: acknowledged, or holding its receipt.
      const started = startedBySend.current ?? (asked !== null && next.receipt?.request === asked && next.receipt.received ? next.conversation?.sessionId ?? null : null);
      if (!sameConversation(state.current.workspace, next, started)) {
        // A read that lands while this page's first send is still on its way decides nothing: the send's own
        // acknowledgement, or the read it asks for afterwards, says whether the started conversation is this one.
        if (state.current.workspace.conversation?.sessionId === 0 && sendLatch.current) return;
        state.current.stale = true;
        setStale(true);
        setNotice("This conversation changed or ended. Reconnect to continue with your draft.");
        return;
      }
      const received = receiveDraft(state.current.draft, asked, next.receipt);
      const before = scopeOf(state.current.workspace);
      const moved = state.current.workspace.conversation?.sessionId !== next.conversation?.sessionId;
      state.current.workspace = next;
      if (received !== state.current.draft || moved) updateDraft(received);
      // The draft moved with the conversation its first send started: the record kept under session 0 goes.
      if (moved && before) saveDraft(browserStorage(), before, emptyDraft(""));
      setWorkspace(next);
      setNotice(received.pending ? "Delivery is not confirmed. Check again before sending another message." : "");
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof WorkspaceAuthError) { state.current.stale = true; setStale(true); }
      setNotice(error instanceof Error ? error.message : "Updates are unavailable. Your work is still saved.");
      // One failure-only retry: a server fingerprint may stay unchanged after this missed read.
      // A second failure waits for a new event or an explicit refresh; healthy pages never poll.
      if (!retry && !state.current.stale && canRefreshWorkspace()) {
        refreshRetry.current = setTimeout(() => { refreshRetry.current = null; void check(true, true); }, 2_000);
      }
    } finally {
      polling.current = false;
      if (refreshQueued.current && mounted.current && !state.current.stale && canRefreshWorkspace()) {
        refreshQueued.current = false;
        void check(true);
      }
    }
  }, [initial, followsWorkspace, liveTask, updateDraft, clearRefreshRetry]);

  // The workspace's room says something changed: read again (an unchanged read is a 304). A stream the browser
  // gave up on reads once, so a lost sign-in or connection says so.
  useLiveRoom(followsWorkspace && !stale ? "workspace" : null, event => {
    if (event === "change" || event === "reload") void check(false);
    else if (event === "lost") void check(true);
  });

  // The task's room says it changed: read now (live-task.tsx).
  useEffect(() => {
    if (!liveTask && !agentsBoard) return;
    const nudge = () => { void check(true); };
    window.addEventListener(WORKSPACE_NUDGE, nudge);
    return () => { window.removeEventListener(WORKSPACE_NUDGE, nudge); };
  }, [check, liveTask, agentsBoard]);

  useEffect(() => {
    mounted.current = true;
    if (!followsWorkspace && !liveTask) return () => { mounted.current = false; };
    const visible = () => { if (!document.hidden) void check(true); else clearRefreshRetry(); };
    const online = () => { setOffline(false); void check(); };
    const offlineNow = () => { clearRefreshRetry(); setOffline(true); };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("online", online);
    window.addEventListener("offline", offlineNow);
    return () => {
      mounted.current = false;
      clearRefreshRetry();
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offlineNow);
    };
  }, [check, followsWorkspace, liveTask, clearRefreshRetry]);

  useEffect(() => { if (stale) clearRefreshRetry(); }, [stale, clearRefreshRetry]);

  /** What became of a send: the server took it (or queued it), refused it, it is unconfirmed (no answer to read), or
   * nothing was sent at all. */
  type SendOutcome = "accepted" | "queued" | "refused" | "unconfirmed" | "skipped";
  const send = async (event: FormEvent, mode: string | null = null): Promise<SendOutcome> => {
    event.preventDefault();
    const current = state.current;
    // A reply in progress no longer blocks a send: the server queues it (docs/plans/lead-message-queue.md).
    if (sendLatch.current || current.stale || navigator.onLine === false || current.draft.pending || !current.draft.text.trim()) return "skipped";
    const next = submitDraft(current.draft);
    if (!next.pending) return "skipped";
    sendLatch.current = true;
    setSending(true);
    updateDraft(next);
    setNotice("");
    try {
      const result = await sendMessage(current.workspace, next.pending, fetch, mode);
      if (current.workspace.conversation?.sessionId === 0 && result.session !== undefined) startedBySend.current = result.session;
      if (!mounted.current) return result.refused ? "refused" : result.queued === true ? "queued" : "accepted";
      if (result.refused) {
        updateDraft(rejectDraft(state.current.draft, next.pending.request));
        setNotice(result.message ?? "Message not sent. Your draft is saved.");
        return "refused";
      } else if (result.queued === true) {
        updateDraft(queuedDraft(state.current.draft, next.pending.request));
        setNotice("Queued: it goes to the lead when it finishes.");
        void check();
        return "queued";
      } else {
        setNotice("Checking delivery…");
        void check();
        return "accepted";
      }
    } catch (error) {
      if (!mounted.current) return "unconfirmed";
      if (error instanceof WorkspaceAuthError) { state.current.stale = true; setStale(true); }
      setNotice(error instanceof WorkspaceAuthError ? error.message : "Delivery is not confirmed. Check again before sending another message.");
      void check();
      return "unconfirmed";
    } finally {
      sendLatch.current = false;
      if (mounted.current) setSending(false);
    }
  };

  const reconnect = () => {
    const owner = scopeOf(state.current.workspace);
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
      if (current.stale || sendLatch.current || current.draft.pending || navigator.onLine === false) {
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

  /** A message written somewhere other than the composer (a comment on a diff line): the composer's one send path,
   * so it takes the same queue and receipt. Never over words the person is still writing. Null when it went. */
  const steer = async (text: string): Promise<string | null> => {
    const current = state.current;
    if (current.draft.text.trim() !== "" || current.draft.pending) return "Send or clear the message you're writing first.";
    if (sendLatch.current || current.stale || navigator.onLine === false) return "The conversation isn't connected. Try again in a moment.";
    updateDraft(editDraft(current.draft, text));
    const request = state.current.draft.request;
    const outcome = await send({ preventDefault() {} } as FormEvent);
    // Queued is a durable acknowledgement; anything else the server didn't refuse counts only once its receipt is read.
    if (outcome === "queued") return null;
    if (outcome === "accepted") {
      return await awaitReceipt(() => state.current.draft.pending?.request ?? null, request, () => check())
        ? null : "Delivery isn't confirmed. Check the chat for it before sending it again.";
    }
    // Refused or never sent: the words came back to the composer. Take them out again; the form keeps them.
    const after = state.current.draft;
    if (after.pending === null && after.text === text) updateDraft(editDraft(after, ""));
    // Unconfirmed: it may have arrived. The composer's note says to check before sending again; so does this.
    return outcome === "unconfirmed"
      ? "Delivery isn't confirmed. Check the chat for it before sending it again."
      : "The lead didn't take it. The note above the message box says why.";
  };

  return { workspace, draft, notice, storageAvailable, sending, stale, offline, send, check, reconnect, steer,
    edit: (text: string) => updateDraft(editDraft(state.current.draft, text)) };
}

/** "4m", "2h", "3d" since the task last changed; the exact minute is in the title. Recounted on each refresh. */
function CrewAge({ at }: { at: string }) {
  const words = shortAge(at);
  return words === "" ? null : <time className="so-work-age" dateTime={at} title={whenTitle(at)}>{words}</time>;
}

export function CrewRows({ workspace, items }: { workspace: BrowserWorkspace; items: BrowserWorkspace["crew"] }) {
  // Two lines a task: its glyph, title and age; then the state word, who is on it and the project. A reason is one
  // more quiet line that opens in place; the one act that resolves it sits on that line.
  return <ul className="so-work-list">{items.map(item => <li key={item.id} data-workspace-task={item.id} data-work-status={item.state}>
    <div className="so-work-row">
      <a className="so-work-link" href={item.resultHref ?? item.href} aria-current={workspace.focus?.id === item.id ? "page" : undefined}>
        <div className="so-work-heading"><StatusGlyph kind={headlineGlyph(item.tone)} className="so-work-glyph" /><span className="so-work-title" title={item.title}>{item.title}</span><CrewAge at={item.updatedAt} /></div>
        <p className="so-work-meta"><span className="so-work-state" data-headline={item.label}>{item.label}</span>
          {item.lead && !item.detail?.includes(item.lead) && <span className="so-work-project" data-crew-lead>{item.lead}</span>}
          {item.project && <span className="so-work-project">{workspace.projects.find(project => project.path === item.project)?.name ?? item.project.split(/[\\/]/).filter(Boolean).pop()}</span>}
        </p>
        {item.activity !== undefined && <ActivityLine activity={item.activity} className="so-work-activity text-caption" />}
      </a>
      {item.detail && <details className="so-work-reason" key={item.detail}>
        <summary title={item.detail}><span>{item.detail}</span><svg aria-hidden="true" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m4 6 4 4 4-4" /></svg></summary>
      </details>}
      {item.action && item.action.href !== (item.resultHref ?? item.href) && <a className="so-work-action" href={item.action.href}>{item.action.label}</a>}
    </div>
  </li>)}</ul>;
}

/** Active work leads; finished work waits behind one disclosure. */
/** Which Crew group a task sits in: a person is needed (Needs you, Failed, Ready for review), an agent is on it, or it waits. */
type CrewGroup = "needs" | "running" | "waiting";
export function crewGroupOf(item: BrowserCrewItem): CrewGroup {
  const glyph = headlineGlyph(item.tone);
  return glyph === "decide" || glyph === "failed" || glyph === "review" ? "needs" : glyph === "building" ? "running" : "waiting";
}
/** Running rows shown before the fold: twenty builds read as five and a count, not twenty cards. */
export const CREW_RUNNING_SHOWN = 5;
const CREW_GROUPS: { key: CrewGroup; label: string; glyph: GlyphKind }[] = [
  { key: "needs", label: "Needs you", glyph: "decide" }, { key: "running", label: "Running", glyph: "building" }, { key: "waiting", label: "Waiting", glyph: "idle" }];

function Crew({ workspace }: { workspace: BrowserWorkspace }) {
  const isFinished = (item: BrowserWorkspace["crew"][number]) => item.tone === "done" || item.state === "cancelled";
  const active = workspace.crew.filter(item => !isFinished(item));
  const finished = workspace.crew.filter(isFinished);
  return <section className="so-crew" aria-labelledby="crew-title" data-workspace-crew>
    <div className="so-section-heading"><h2 id="crew-title">Crew</h2><a href="/work">All tasks</a></div>
    {workspace.crew.length === 0 ? <div className="so-crew-empty"><p>No tasks yet.</p><p>Work you start with the lead appears here.</p></div> : <>
      {active.length === 0 && <p className="so-crew-quiet">Nothing is running or waiting on you.</p>}
      {CREW_GROUPS.map(group => {
        const rows = active.filter(item => crewGroupOf(item) === group.key);
        if (rows.length === 0) return null;
        const shown = group.key === "running" ? rows.slice(0, CREW_RUNNING_SHOWN) : rows;
        const folded = rows.slice(shown.length);
        return <div key={group.key} className="so-crew-group" data-crew-group={group.key}>
          <h3 className="so-crew-group-title"><StatusGlyph kind={group.glyph} />{group.label}<span>{rows.length}</span></h3>
          <CrewRows workspace={workspace} items={shown} />
          {folded.length > 0 && <Disclosure summary={`${folded.length} more running`} className="so-crew-more"><CrewRows workspace={workspace} items={folded} /></Disclosure>}
        </div>;
      })}
      {finished.length > 0 && <Disclosure summary={`Finished (${finished.length}${workspace.crewTruncated ? "+" : ""})`} className="so-crew-finished"><CrewRows workspace={workspace} items={finished} /></Disclosure>}
    </>}
    {workspace.crewTruncated && <a className="so-all-work" href="/work">View more tasks</a>}
  </section>;
}

/** Each state's glyph in the console's one palette. */
const STATE_GLYPH: Record<DisplayState, GlyphKind> = {
  "needs-you": "decide", failed: "failed", stuck: "unblock", paused: "idle", working: "building", waiting: "idle", done: "done", idle: "idle" };

/** A summary snapshot as the summary room sends it (its `at`), read strictly: anything malformed is no snapshot. */
export function readProjectStates(raw: unknown): BrowserProjectState[] | null {
  if (typeof raw !== "string") return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(parsed)) return null;
  const text = (value: unknown, max: number) => typeof value === "string" && value.length <= max;
  const states: BrowserProjectState[] = [];
  for (const one of parsed) {
    if (one === null || typeof one !== "object") return null;
    const { path, name, href, state, counts, tasks, more, others, asks } = one as Record<string, unknown>;
    if (!Array.isArray(asks)) return null;
    const asked: BrowserProjectState["asks"] = [];
    for (const ask of asks) {
      if (ask === null || typeof ask !== "object") return null;
      const a = ask as Record<string, unknown>;
      if (typeof a["key"] !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(a["key"]) || !(a["task"] === null || text(a["task"], 400))
        || !(a["run"] === null || (typeof a["run"] === "number" && Number.isInteger(a["run"]) && a["run"] > 0)) || !text(a["at"], 64)) return null;
      asked.push({ key: a["key"], task: a["task"] as string | null, run: a["run"] as number | null, at: a["at"] as string });
    }
    if (others !== undefined && others !== true) return null;
    if (!(path === null || text(path, 4096)) || !text(name, 400) || !text(href, 8192) || !(href as string).startsWith("/")
      || !DISPLAY_STATES.includes(state as DisplayState) || counts === null || typeof counts !== "object"
      || !Array.isArray(tasks) || typeof more !== "number" || !Number.isInteger(more) || more < 0) return null;
    const read = Object.fromEntries(DISPLAY_STATES.map(key => [key, (counts as Record<string, unknown>)[key]]));
    if (Object.values(read).some(value => typeof value !== "number" || !Number.isInteger(value) || value < 0)) return null;
    const rail: BrowserRailTask[] = [];
    for (const task of tasks) {
      if (task === null || typeof task !== "object") return null;
      const t = task as Record<string, unknown>;
      if (!text(t["id"], 400) || !text(t["title"], 2000) || !text(t["href"], 8192) || !(t["href"] as string).startsWith("/")
        || !DISPLAY_STATES.includes(t["state"] as DisplayState) || !text(t["line"], 2000)) return null;
      rail.push({ id: t["id"] as string, title: t["title"] as string, href: t["href"] as string, state: t["state"] as DisplayState, line: t["line"] as string });
    }
    states.push({ path: path as string | null, name: name as string, href: href as string, state: state as DisplayState, counts: read as BrowserProjectState["counts"], tasks: rail, more, asks: asked,
      ...(others === true ? { others: true as const } : {}) });
  }
  return states;
}

/** How long a part waits after the summary room's `gone` before it joins again. */
export const SUMMARY_REJOIN_MS = 2_000;
/** The page's one summary snapshot, shared by every part that shows it (the rail, the phone chip, the sheet): the
 * page's own read until the summary room says more; `gone` or a lost stream clears it until the next read. */
const summary = { states: null as BrowserProjectState[] | null, from: null as BrowserWorkspace["projectStates"] | null, listeners: new Set<() => void>() };
function setSummary(states: BrowserProjectState[] | null): void {
  summary.states = states;
  for (const listener of [...summary.listeners]) listener();
}

/** The page's project states, kept current by the summary room; none on a sensitive page. Reading it never watches
 * or sees anything. */
export function useProjectStates(workspace: BrowserWorkspace): BrowserProjectState[] | null {
  const off = workspace.sensitive || workspace.projectStates === undefined;
  // A new page read is the newest word: it replaces whatever the room said before it.
  if (!off && summary.from !== workspace.projectStates) { summary.from = workspace.projectStates; summary.states = workspace.projectStates ?? null; }
  const [, render] = useState(0);
  // After `gone` (the reader's scope moved, or the server said so), this part leaves the room and asks again shortly:
  // the new join is admitted for the scope as it is now, and its first word is the snapshot for it.
  const [away, setAway] = useState(false);
  useEffect(() => {
    const listener = () => render(n => n + 1);
    summary.listeners.add(listener);
    return () => { summary.listeners.delete(listener); };
  }, []);
  useEffect(() => {
    if (!away) return;
    const back = window.setTimeout(() => setAway(false), SUMMARY_REJOIN_MS);
    return () => window.clearTimeout(back);
  }, [away]);
  useLiveRoom(off || away ? null : "summary", (event, data) => {
    if (event === "gone") { setSummary(null); setAway(true); return; }
    if (event === "lost") { setSummary(null); return; }
    if (event !== "change") return;
    const next = readProjectStates(data["at"]);
    if (next !== null) setSummary(next);
  }, true);
  return off ? null : summary.states;
}

/** What waits on this person across every project in the snapshot. */
export function needsYouTotal(states: readonly BrowserProjectState[] | null): number {
  return states?.reduce((sum, one) => sum + one.counts["needs-you"], 0) ?? 0;
}
/** The tab's own marks (cockpit §3): "(2) " before its title and a dot on its icon while something needs this person.
 * Driven by the summary, which a hidden tab keeps; the page's own title is never otherwise changed. */
export function titleWithCount(title: string, count: number): string {
  const bare = title.replace(/^\(\d+\+?\) /, "");
  return count > 0 ? `(${count > 99 ? "99+" : count}) ${bare}` : bare;
}
function AttentionMarks({ workspace }: { workspace: BrowserWorkspace }) {
  const states = useProjectStates(workspace);
  // The tab's "(N)" is the one Needs-you count the rail and the dock show (workspace.needsYou), never a second sum.
  const count = needsOf(workspace).count;
  // The chime hears every snapshot this page sees (it plays only when this browser turned it on).
  const chime = useRef<ReturnType<typeof createChime> | null>(null);
  useEffect(() => {
    // What this tab shows: a task's page, or one agent opened on the Agents board.
    chime.current = createChime(undefined, () => {
      const at = new URL(window.location.href);
      const task = at.pathname.startsWith("/t/") ? decodeURIComponent(at.pathname.slice(3).split("/")[0] ?? "") || null : null;
      const run = at.pathname === "/agents" && /^[1-9][0-9]{0,9}$/.test(at.searchParams.get("run") ?? "") ? Number(at.searchParams.get("run")) : null;
      return { visible: document.visibilityState === "visible", task, run };
    });
    return () => { chime.current?.close(); chime.current = null; };
  }, []);
  useEffect(() => { if (states !== null) chime.current?.see(states); }, [states]);
  useEffect(() => {
    document.title = titleWithCount(document.title, count);
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"][type="image/svg+xml"]');
    if (icon !== null) icon.href = count > 0 ? "/icon-attention.svg" : "/icon.svg";
  }, [count, workspace.title]);
  return null;
}

/** A project's counts in words, strongest first, leaving out what is zero (idle is never counted). */
export function projectCountWords(state: BrowserProjectState): string {
  return DISPLAY_STATES.filter(key => key !== "idle" && state.counts[key] > 0)
    .map(key => `${state.counts[key]} ${key === "needs-you" ? (state.counts[key] === 1 ? "needs you" : "need you") : STATE_WORDS[key].toLowerCase()}`).join(" · ");
}

/** The sidebar's projects, each with its state and counts; under the open one, its tasks with something live, asking,
 * failed or unread, and how many more. Everything here is the summary snapshot, so it moves with it. */
export function ProjectStates({ states, current }: { states: BrowserProjectState[]; current: string | null }) {
  return <nav aria-label="Projects now" className="so-project-states" data-project-states>
    {states.map(state => {
      const words = projectCountWords(state);
      const open = state.path !== null && state.path === current;
      return <div key={state.others ? "(others)" : state.path ?? "(none)"} className="so-project-state" data-project-state={state.state} data-project-others={state.others ? "" : undefined}>
        <a href={state.href} aria-current={open ? "true" : undefined} title={words === "" ? STATE_WORDS.idle : words}>
          <StatusGlyph kind={STATE_GLYPH[state.state]} /><span className="so-project-state-name">{state.name}</span>
          {words !== "" && <span className="so-project-state-counts">{words}</span>}
          <span className="so-sr-only">{STATE_WORDS[state.state]}</span>
        </a>
        {(open || (state.path === null && !state.others)) && state.tasks.length > 0 && <ul className="so-project-tasks">
          {state.tasks.map(task => <li key={task.id} data-rail-task={task.state}>
            <a href={task.href} title={task.title}><StatusGlyph kind={STATE_GLYPH[task.state]} /><span className="so-project-task-title">{task.title}</span>
              <span className="so-project-task-line">{task.line}</span></a>
          </li>)}
          {state.more > 0 && <li><a className="so-project-tasks-more" href={state.href}>{state.more} more</a></li>}
        </ul>}
      </div>;
    })}
  </nav>;
}

/** The project a page is about: the one its address names (?project, ?repo), its focused task's, else the session's
 * open project — so the picker always names what is open. */
export function currentProjectOf(workspace: BrowserWorkspace): BrowserWorkspace["projects"][number] | undefined {
  const query = new URL(workspace.path, window.location.origin).searchParams;
  const named = query.get("project") ?? query.get("repo") ?? workspace.crew.find(task => task.id === workspace.focus?.id)?.project ?? workspace.openProject ?? null;
  return named === null ? undefined : workspace.projects.find(project => project.path === named);
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
  // A reply in progress doesn't disable sending: the next message waits in the lead queue.
  const disabled = sending || stale || offline || draft.pending !== null || !draft.text.trim();
  const delivery = offline ? "Offline. Your draft stays in this tab." : sending ? "Sending…" : notice;
  const hint = TASK_MODES.find(one => one.id === mode)!.hint;
  return {
    entries: chat.messages.map(message => ({ key: `message-${message.id}`, at: message.createdAt, node:
      <li key={`message-${message.id}`} data-message-id={message.id} data-thread-kind="message" className="so-thread-entry relative flex gap-3">
        <span aria-hidden="true" className="relative z-[1] flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-card text-[10.5px] font-semibold text-muted-foreground">{message.role === "operator" ? "Y" : (workspace.leadName ?? "Lead").slice(0, 1).toUpperCase()}</span>
        <div className="min-w-0 flex-1 pb-5 phone:pb-4">
          <p className="flex min-h-6 flex-wrap items-baseline gap-x-2 text-body leading-6">
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
      <PostForm onSubmit={event => { void controller.send(event, mode); }} action="/chat" data-workspace-composer data-task-composer aria-busy={sending}
        className="rounded-xl border border-input bg-card px-3 pb-2 pt-2.5 shadow-[0_1px_2px_rgb(0_0_0/.04)] transition-[border-color,box-shadow] duration-100 focus-within:border-attention focus-within:shadow-[0_0_0_3px_var(--so-signal-soft)] phone:px-2.5">
        <label htmlFor="task-message" className="sr-only">Message the agent</label>
        <textarea ref={box} id="task-message" name="message" rows={2} maxLength={chat.maxChars} placeholder="Message the agent: ask, or ask for a change" value={draft.text}
          className="block max-h-[180px] min-h-12 w-full resize-none px-0.5 pb-2 text-sm leading-relaxed outline-none placeholder:text-muted-foreground phone:min-h-11 phone:text-base"
          onChange={event => controller.edit(event.target.value)} onKeyDown={event => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && (returnSends() || event.metaKey || event.ctrlKey)) { event.preventDefault(); if (!disabled) event.currentTarget.form?.requestSubmit(); }
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
      </PostForm>
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

/** The views built from the revamp kit; a server page says so with `data-kit-page` on its root. */
const KIT_VIEWS = new Set(["tasks", "task", "agents", "home", "search"]);
export function isKitPage(workspace: BrowserWorkspace): boolean {
  if (workspace.team) return false;
  if (workspace.view != null) return KIT_VIEWS.has(workspace.view.kind);
  // The lead chat draws its own top bar (lead-chat.tsx); a result or task opened beside it keeps the older frame.
  if (workspace.conversation && new URL(workspace.path, window.location.origin).pathname === "/chat" && !workspace.focus && !workspace.result) return true;
  return !workspace.conversation && (workspace.pageHtml ?? "").includes("data-kit-page");
}

export function WorkspaceApp({ initial }: { initial: BrowserWorkspace }) {
  const controller = useWorkspace(initial);
  const resultHost = useRef<HTMLDivElement>(null);
  const [teamSnapshot, setTeamSnapshot] = useState<TeamSnapshot | undefined>(initial.team);
  const workspace = teamSnapshot?.tasks ? { ...controller.workspace, ...browserCrewFromIndex(teamSnapshot.tasks, teamSnapshot.selected?.id) } : controller.workspace;
  const [phoneView, setPhoneView] = useState<"chat" | "work">(workspace.result || workspace.focus ? "work" : "chat");
  const hasWork = workspace.focus !== null || workspace.result !== null;
  const selectedTask = workspace.crew.find(item => item.id === workspace.focus?.id);
  const isChat = new URL(workspace.path, window.location.origin).pathname === "/chat";
  const section = isChat ? "Chat" : workspace.navigation.find(item => item.active)?.label ?? (workspace.title.charAt(0).toUpperCase() + workspace.title.slice(1));
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
  // The settings frame (docs/plans/settings-revamp.md §4): one column, no Crew sheet, the breadcrumb in the header.
  const settingsFrame = !workspace.team && !workspace.conversation && isSettingsFrame(pathname);
  // A page built from the revamp kit (src/design/KIT.md) brings its own top bar and spacing: no page padding, no side
  // panel, and no desk header (search lives in the rail); on a phone the shell's header is the phone header.
  const kitPage = isKitPage(workspace);
  // The side sheet is only ever a page's own: the Ask panel beside a page, a task's Details, or a result opened from the
  // chat. Nothing else repeats the task list beside a page (the rail and Home hold it).
  const hidePanel = settingsFrame || kitPage || !hasWork || pageOnly && !docked && FULL_WIDTH_PAGES.has(pathname);
  const crumbs = settingsFrame ? (workspace.crumbs ?? []).filter(one => one.href === null || (one.href.startsWith("/") && !one.href.startsWith("//"))) : [];
  const [dismissedUpdate, setDismissedUpdate] = useState<string | null>(null);
  const update = workspace.update !== undefined && workspace.update.version !== dismissedUpdate ? workspace.update : null;
  // The demo notice scrolls away with a page; a chat keeps it above.
  const demo = workspace.demo;
  const pageScrolls = !workspace.team && !(workspace.conversation && !docked && taskView === null);
  // After the first Ready result: one line pointing to the phone setup in Settings, until put away.
  const [phoneDismissed, setPhoneDismissed] = useState(false);
  const phone = isChat && workspace.conversation !== null && !docked && taskView === null && !phoneDismissed ? workspace.phone ?? null : null;
  const states = useProjectStates(workspace);
  const current = currentProjectOf(workspace)?.path ?? null;
  useEffect(notifyWorkspaceRendered, []);
  useWindowStaysPut();
  // On a phone the result opens as a sheet over the chat (workspace.css): the chat stays in view, dimmed, and out of
  // reach — no tab stop or tap lands under the sheet until it is put away.
  const mainColumn = useRef<HTMLDivElement>(null);
  const sheet = phoneView === "work" && hasWork && !docked && taskView === null && !hidePanel;
  useEffect(() => {
    const column = mainColumn.current;
    if (!column) return;
    const phone = matchMedia("(max-width: 760px)");
    const sync = () => column.toggleAttribute("inert", sheet && phone.matches);
    sync();
    phone.addEventListener("change", sync);
    return () => { phone.removeEventListener("change", sync); column.removeAttribute("inert"); };
  }, [sheet]);
  return <FormToken.Provider value={workspace.csrf}><Passwordless.Provider value={workspace.passwordless === true}><Toaster /><AttentionMarks workspace={workspace} /><div className={`so-workspace${hidePanel ? " so-workspace--single" : ""}${kitPage ? " so-workspace--kit" : ""}${settingsFrame ? " so-workspace--settings" : ""}${docked || (taskView !== null && !kitPage) ? " so-workspace--docked" : ""}${taskView !== null && !kitPage ? " so-workspace--details" : ""}`} data-workspace-shell data-workspace-phone-view={phoneView} data-workspace-has-result={workspace.result !== null}>
    <a href="#workspace-main" className="so-skip-link">Skip to content</a>
    <aside className="so-sidebar"><Rail workspace={workspace} states={states} current={current} /></aside>
    <div ref={mainColumn} className={`so-main-column${isChat ? " so-main-column--chat" : ""}`}>
      <PhoneHeader workspace={workspace} title={crumbs.length > 0 ? crumbs[crumbs.length - 1]!.label : section} states={states} current={current} trailing={<>
        {isChat && hasWork && <ViewButton variant="outline" size="sm" className="so-phone-work-button h-11 min-h-11" onClick={() => setPhoneView("work")}>Open work</ViewButton>}
        {docked && <ViewButton variant="outline" size="sm" className="so-phone-work-button h-11 min-h-11" onClick={() => { setPanelTab("chat"); setPhoneView("work"); }}><Icon name="chat" />Ask</ViewButton>}
        {taskView !== null && !kitPage && <ViewButton variant="outline" size="sm" className="so-phone-work-button h-11 min-h-11" data-open-details onClick={() => setPhoneView("work")}>Task details</ViewButton>}
      </>} />
      {!kitPage && <header className="so-workspace-header">{crumbs.length > 0
        ? <nav className="kit-crumbs so-header-title" aria-label="Breadcrumb"><ol>{crumbs.map((one, at) => one.href === null
          ? <li key={at} aria-current="page">{one.label}</li> : <li key={at}><a href={one.href}>{one.label}</a></li>)}</ol></nav>
        : pageOnly || settingsFrame
        ? <p className="so-header-title">{section}</p>
        : <h1>{isChat ? workspace.leadName ?? "Lead" : section}</h1>}
        {workspace.focus && isChat && <span className="so-focus-label" title={workspace.focus.title}>{workspace.focus.title}</span>}
      </header>}
      {(workspace.notices.length > 0 || (workspace.signIn?.length ?? 0) > 0 || update !== null || phone !== null || (demo !== undefined && !pageScrolls)) && <div className="so-workspace-notices">
        {!pageScrolls && <DemoNotice demo={demo} />}
        {workspace.signIn?.map(item => <Alert key={item.provider} className="so-sign-in" data-sign-in={item.provider}>
          <p className="so-sign-in-title">{item.title}</p>
          <p className="so-sign-in-detail">Run <code>{item.command}</code> on this computer, then resume.{item.detail === "" ? "" : ` ${item.detail}`}</p>
          <PostForm action={item.resumeHref}><ViewButton className="max-[761px]:h-11 max-[761px]:min-h-11" size="sm" type="submit">{item.resumeLabel}</ViewButton></PostForm>
        </Alert>)}
        {workspace.notices.map((notice, index) => <Alert key={index}>{notice}</Alert>)}
        {update !== null && <Alert className="so-update" data-update={update.version}>
          <p><span>{updateNoticeWords(update)}</span> · <a href={update.href}>What's new</a></p>
          <PostForm action={update.dismissHref} onSubmit={event => {
            // Dismissed at once; the cookie that keeps it dismissed is saved in the background.
            event.preventDefault();
            setDismissedUpdate(update.version);
            void fetch(update.dismissHref, { method: "POST", body: new URLSearchParams({ csrf: workspace.csrf, version: update.version, quiet: "1" }) }).catch(() => {});
          }}>
            <input type="hidden" name="version" value={update.version} />
            <ViewButton className="max-[761px]:size-11 max-[761px]:min-h-11" variant="ghost" size="icon" type="submit" aria-label={`Dismiss the notice about ${update.version}`}><Icon name="close" /></ViewButton>
          </PostForm>
        </Alert>}
        {phone !== null && <Alert className="so-update so-phone-notice" data-phone-notice>
          <p><span>Use it from your phone too</span> · <a href="/settings#settings-chat-apps">Set up</a></p>
          <PostForm action={phone.dismissHref} onSubmit={event => {
            // The same installation-wide put-away as before; the setup stays in Settings → Chat apps.
            event.preventDefault();
            setPhoneDismissed(true);
            void fetch(phone.dismissHref, { method: "POST", body: new URLSearchParams({ csrf: workspace.csrf, quiet: "1" }) }).catch(() => {});
          }}>
            <ViewButton className="max-[761px]:size-11 max-[761px]:min-h-11" variant="ghost" size="icon" type="submit" aria-label="Dismiss the phone notice"><Icon name="close" /></ViewButton>
          </PostForm>
        </Alert>}
      </div>}
      <main id="workspace-main" className="so-main-content" tabIndex={-1}>
        {workspace.team ? <TeamChat initial={workspace.team} user={workspace.user} csrf={workspace.csrf} onSnapshot={setTeamSnapshot} /> : workspace.conversation && !docked && taskView === null ? <LeadChat controller={controller} /> : <div className="so-page-content" data-workspace-page><DemoNotice demo={demo} />{isChat && workspace.firstRun && <FirstRun firstRun={workspace.firstRun} />}{workspace.view ? <ViewHost view={workspace.view} csrf={workspace.csrf} taskChat={taskChat} taskDetails={false} workspace={workspace} /> : <GuardedHtml html={initial.pageHtml ?? ""} immutable />}</div>}
      </main>
    </div>
    {docked && <aside className="so-supporting-panel so-ask-panel" data-workspace-detail aria-label="Ask">
      <div className="so-ask-header">
        <ViewButton variant="ghost" size="sm" className="so-phone-back min-[761px]:hidden max-[761px]:h-11 max-[761px]:min-h-11" onClick={() => setPhoneView("chat")}><Icon name="arrow" />Back</ViewButton>
        <div role="tablist" aria-label="Panel" className="so-ask-tabs">
          <button type="button" role="tab" aria-selected={panelTab === "chat"} onClick={() => setPanelTab("chat")}>Chat</button>
          <button type="button" role="tab" aria-selected={panelTab === "crew"} onClick={() => setPanelTab("crew")}>Crew</button>
        </div>
      </div>
      <div className="so-ask-body" hidden={panelTab !== "chat"}><LeadChat controller={controller} docked={workspace.view?.kind ?? "task"} /></div>
      {panelTab === "crew" && <Crew workspace={workspace} />}
    </aside>}
    {taskView !== null && !kitPage && <aside className="so-supporting-panel so-details-panel" data-workspace-detail aria-label="Task details">
      <div className="so-details-header">
        <ViewButton variant="ghost" size="sm" className="so-phone-back min-[761px]:hidden max-[761px]:h-11 max-[761px]:min-h-11" onClick={() => setPhoneView("chat")}><Icon name="arrow" />Back</ViewButton>
        <h2>Task details</h2>
      </div>
      <div data-view="task-details" className="w-full"><TaskDetails view={taskView} /></div>
    </aside>}
    {!hidePanel && !docked && taskView === null && <aside className={`so-supporting-panel${hasWork ? " so-supporting-panel--detail" : ""}`} data-workspace-detail>
      <div className="so-work-panel-header"><ViewButton variant="ghost" size="sm" className="so-phone-back min-[761px]:hidden max-[761px]:h-11 max-[761px]:min-h-11" onClick={() => setPhoneView("chat")}><Icon name="arrow" />{isChat ? "Back to chat" : "Back"}</ViewButton>
        {hasWork && <><h2>{workspace.result ? "Result" : "Task"}</h2>{workspace.result && selectedTask && <HeadlineBadge label={selectedTask.label} tone={selectedTask.tone} className="so-current-task-state" data-workspace-current-task-state="" />}{workspace.result && <span className="so-work-run">run #{workspace.result.runId}</span>}<a href={teamSnapshot?.selected ? "/chat?conversation=" + encodeURIComponent(teamSnapshot.selected.id) : "/chat"} className="so-close-work" aria-label="Close work and return to the main chat"><Icon name="close" /></a></>}
      </div>
      {hasWork ? <div className="so-work-detail-content">
        {workspace.focus && (workspace.result
          ? <Disclosure summary="Task details" className="so-result-task-details"><GuardedHtml key={workspace.focus.id} html={workspace.focus.html} className="so-task-context" /></Disclosure>
          : <GuardedHtml key={workspace.focus.id} html={workspace.focus.html} className="so-task-context" />)}
        {workspace.result && <div ref={resultHost} className="so-result-host"><Artifact data-workspace-result={workspace.result.runId}><ArtifactContent><GuardedHtml key={workspace.result.runId} html={workspace.result.html} immutable /></ArtifactContent></Artifact>
          {/* A comment on a line of this result's change goes to the lead as the conversation's next message. */}
          {workspace.conversation && <LineSteer key={workspace.result.runId} host={resultHost} run={workspace.result.runId} maxChars={workspace.conversation.maxChars} steer={controller.steer} />}</div>}
      </div> : null}
    </aside>}
    <NeedsDock workspace={workspace} />
    <SearchMenu workspace={workspace} />
  </div></Passwordless.Provider></FormToken.Provider>;
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

// The revamp kit's behaviour (composer, keyboard, overlays, switches) for kit markup from React views and from
// the server pages the workspace places (src/design/KIT.md).
installKitBehavior();

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
