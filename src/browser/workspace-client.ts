import type { BrowserWorkspace } from "../browser-workspace.js";

export const DRAFT_TTL = 86_400_000;
const DRAFT_PREFIX = "standing-orders:workspace-draft:";
const CARRY_PREFIX = "standing-orders:workspace-carry:";
const REQUEST = /^[a-f0-9]{32}$/;

export type DraftScope = { user: string; session: number; task: string | null };
export type PendingMessage = { request: string; text: string };
export type ChatDraft = {
  text: string;
  request: string;
  submitted: boolean;
  pending: PendingMessage | null;
  at: number;
};
export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function freshRequest(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, "0")).join("");
}

function storageKey(prefix: string, scope: DraftScope): string {
  return `${prefix}${encodeURIComponent(scope.user)}:${prefix === DRAFT_PREFIX ? `${scope.session}:` : ""}${encodeURIComponent(scope.task ?? "")}`;
}

export function emptyDraft(request: string, now = Date.now()): ChatDraft {
  return { text: "", request, submitted: false, pending: null, at: now };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validPending(value: unknown, maxChars: number): value is PendingMessage {
  return record(value) && typeof value.request === "string" && REQUEST.test(value.request)
    && typeof value.text === "string" && value.text.length <= maxChars;
}

export function restoreDraft(storage: DraftStorage, scope: DraftScope, request: string, maxChars: number, now = Date.now()): ChatDraft {
  const fallback = emptyDraft(request, now);
  try {
    const key = storageKey(DRAFT_PREFIX, scope);
    const saved: unknown = JSON.parse(storage.getItem(key) ?? "null");
    if (record(saved) && saved.user === scope.user && saved.session === scope.session && saved.task === scope.task
      && typeof saved.at === "number" && saved.at > now - DRAFT_TTL && saved.at <= now
      && typeof saved.text === "string" && saved.text.length <= maxChars
      && typeof saved.request === "string" && REQUEST.test(saved.request)
      && typeof saved.submitted === "boolean" && (saved.pending === null || validPending(saved.pending, maxChars))) {
      return { text: saved.text, request: saved.request, submitted: saved.submitted, pending: saved.pending, at: saved.at };
    }
    storage.removeItem(key);
    // Only an explicit reconnect creates this account- and task-bound carry.
    const carryKey = storageKey(CARRY_PREFIX, scope);
    const carry: unknown = JSON.parse(storage.getItem(carryKey) ?? "null");
    storage.removeItem(carryKey);
    if (record(carry) && carry.user === scope.user && carry.task === scope.task
      && typeof carry.at === "number" && carry.at > now - DRAFT_TTL && carry.at <= now
      && typeof carry.text === "string" && carry.text.length <= maxChars) {
      return { ...fallback, text: carry.text };
    }
  } catch { /* An unavailable browser store must not prevent drafting. */ }
  return fallback;
}

export function saveDraft(storage: DraftStorage, scope: DraftScope, draft: ChatDraft): boolean {
  try {
    const key = storageKey(DRAFT_PREFIX, scope);
    if (draft.text || draft.pending) storage.setItem(key, JSON.stringify({ ...scope, ...draft }));
    else storage.removeItem(key);
    return true;
  } catch { return false; }
}

export function carryDraft(storage: DraftStorage, scope: DraftScope, text: string, now = Date.now()): boolean {
  try {
    if (scope.user && text.trim()) storage.setItem(storageKey(CARRY_PREFIX, scope), JSON.stringify({ user: scope.user, task: scope.task, text, at: now }));
    return true;
  } catch { return false; }
}

export function editDraft(draft: ChatDraft, text: string, request: () => string = freshRequest, now = Date.now()): ChatDraft {
  return { ...draft, text, request: draft.submitted ? request() : draft.request, submitted: false, at: now };
}

export function submitDraft(draft: ChatDraft, now = Date.now()): ChatDraft {
  if (draft.pending || !draft.text.trim()) return draft;
  return { ...draft, submitted: true, pending: { request: draft.request, text: draft.text }, at: now };
}

export function receiveDraft(draft: ChatDraft, asked: string | null, receipt: BrowserWorkspace["receipt"], request: () => string = freshRequest, now = Date.now()): ChatDraft {
  if (!asked || !receipt?.received || receipt.request !== asked || draft.pending?.request !== asked) return draft;
  if (draft.submitted && draft.request === asked && draft.text === draft.pending.text) return emptyDraft(request(), now);
  return { ...draft, pending: null, at: now };
}

export function rejectDraft(draft: ChatDraft, asked: string): ChatDraft {
  return draft.pending?.request === asked ? { ...draft, pending: null, submitted: false } : draft;
}

export function sameConversation(before: BrowserWorkspace, after: BrowserWorkspace): boolean {
  return before.user === after.user && before.conversation?.sessionId === after.conversation?.sessionId
    && before.conversation?.taskId === after.conversation?.taskId
    && before.conversation?.resultRunId === after.conversation?.resultRunId
    && (before.conversation?.project ?? null) === (after.conversation?.project ?? null);
}

export function localUrl(href: string): string {
  if (!href.startsWith("/") || href.startsWith("//")) throw new Error("Unexpected workspace address");
  return href;
}

/** Reject incomplete reads before accepting their session identity or receipt. */
/** Chat's first run: steps with a link that stays on this console or an exact command, and drafts as plain words. */
function isFirstRun(value: unknown): boolean {
  return record(value) && (value.sandbox === null || typeof value.sandbox === "string")
    && Array.isArray(value.steps) && value.steps.every(step => record(step) && typeof step.key === "string" && typeof step.title === "string" && typeof step.done === "boolean"
      && (step.action === null || (record(step.action) && (step.action.kind === "command" ? typeof step.action.command === "string"
        : step.action.kind === "link" && typeof step.action.label === "string" && typeof step.action.href === "string" && step.action.href.startsWith("/")))))
    && Array.isArray(value.suggestions) && value.suggestions.every(one => record(one) && typeof one.label === "string" && typeof one.draft === "string" && typeof one.source === "string");
}

export function isWorkspace(value: unknown): value is BrowserWorkspace {
  if (!record(value) || value.version !== 1 || typeof value.path !== "string" || typeof value.title !== "string"
    || typeof value.user !== "string" || typeof value.csrf !== "string" || typeof value.refreshUrl !== "string"
    || typeof value.sensitive !== "boolean" || typeof value.crewTruncated !== "boolean"
    || typeof value.catchUpHtml !== "string" || typeof value.controlsHtml !== "string"
    || !Array.isArray(value.notices) || !value.notices.every(item => typeof item === "string")
    || !(value.pageHtml === null || typeof value.pageHtml === "string")) return false;
  if (!Array.isArray(value.navigation) || !value.navigation.every(item => record(item) && typeof item.label === "string" && typeof item.href === "string" && typeof item.active === "boolean" && (item.count === undefined || typeof item.count === "number"))) return false;
  // A rebuilt page's view model: its kind selects the component; the server
  // shapes the rest, and an unknown kind falls back to the page HTML.
  if (value.view !== undefined && value.view !== null && !(record(value.view) && typeof value.view.kind === "string")) return false;
  if (value.signIn !== undefined && !(Array.isArray(value.signIn) && value.signIn.every(item => record(item)
    && [item.provider, item.title, item.command, item.detail, item.resumeLabel, item.resumeHref].every(part => typeof part === "string") && String(item.resumeHref).startsWith("/")))) return false;
  if (value.firstRun !== undefined && !isFirstRun(value.firstRun)) return false;
  if (value.refreshSeconds !== undefined && !(typeof value.refreshSeconds === "number" && Number.isFinite(value.refreshSeconds) && value.refreshSeconds >= 5)) return false;
  if (value.chats !== undefined && !(Array.isArray(value.chats) && value.chats.every(item => record(item) && (item.kind === "project" || item.kind === "task")
    && typeof item.title === "string" && typeof item.href === "string" && item.href.startsWith("/") && typeof item.active === "boolean" && (item.at === null || typeof item.at === "string")))) return false;
  if (!Array.isArray(value.projects) || !value.projects.every(item => record(item) && [item.name, item.path, item.href, item.knowledgeHref].every(part => typeof part === "string"))) return false;
  if (!Array.isArray(value.crew) || !value.crew.every(item => record(item) && [item.id, item.title, item.state, item.label, item.tone, item.href].every(part => typeof part === "string")
    && (item.project === null || typeof item.project === "string") && (item.resultHref === null || typeof item.resultHref === "string")
    && (item.action === null || (record(item.action) && typeof item.action.label === "string" && typeof item.action.href === "string")))) return false;
  if (!(value.focus === null || (record(value.focus) && typeof value.focus.id === "string" && typeof value.focus.title === "string" && typeof value.focus.html === "string"))) return false;
  if (!(value.result === null || (record(value.result) && typeof value.result.runId === "number" && typeof value.result.html === "string"))) return false;
  if (!(value.receipt === null || (record(value.receipt) && typeof value.receipt.request === "string" && typeof value.receipt.received === "boolean"))) return false;
  const chat = value.conversation;
  return chat === null || (record(chat) && typeof chat.sessionId === "number" && typeof chat.user === "string"
    && typeof chat.version === "string" && typeof chat.requestId === "string" && REQUEST.test(chat.requestId)
    && typeof chat.maxChars === "number" && chat.maxChars > 0
    && (chat.taskId === null || typeof chat.taskId === "string") && (chat.resultRunId === null || typeof chat.resultRunId === "number")
    && (chat.project === undefined || chat.project === null || typeof chat.project === "string")
    && (chat.pendingTurnId === null || typeof chat.pendingTurnId === "number")
    && Array.isArray(chat.messages) && chat.messages.every(isMessage)
    && (chat.previous === undefined || chat.previous === null || (record(chat.previous) && Array.isArray(chat.previous.messages) && chat.previous.messages.every(isMessage))));
}

function isMessage(item: unknown): boolean {
  return record(item) && typeof item.id === "number"
    && (item.role === "operator" || item.role === "assistant") && typeof item.text === "string" && typeof item.html === "string"
    && typeof item.cardsHtml === "string" && typeof item.createdAt === "string" && (item.activity === null || typeof item.activity === "string")
    && (item.cards === undefined || (Array.isArray(item.cards) && item.cards.every(card => record(card) && typeof card.id === "number" && typeof card.kind === "string"
      && typeof card.label === "string" && typeof card.state === "string" && typeof card.body === "string" && Array.isArray(card.links) && typeof card.dismissable === "boolean")));
}

export class WorkspaceAuthError extends Error {}

export type WorkspaceRead = { kind: "changed"; workspace: BrowserWorkspace; etag: string | null }
  | { kind: "unchanged"; etag: string };

export function workspacePollDelay(previous: number, unchanged: boolean, busy: boolean): number {
  return unchanged && !busy ? Math.min(30_000, previous * 2) : 5_000;
}

export async function readWorkspace(workspace: BrowserWorkspace, request: string | null, fetcher: typeof fetch = fetch,
  options: { etag?: string | null; force?: boolean } = {}): Promise<WorkspaceRead> {
  const url = new URL(localUrl(workspace.refreshUrl), window.location.origin);
  url.searchParams.set("format", "workspace");
  if (request) url.searchParams.set("request", request);
  else url.searchParams.delete("request");
  const etag = request || options.force ? null : options.etag;
  const response = await fetcher(url.pathname + url.search, { credentials: "same-origin", cache: "no-store", headers: { accept: "application/json", ...(etag ? { "if-none-match": etag } : {}) }, signal: AbortSignal.timeout(12_000) });
  if (response.status === 401 || response.status === 403 || response.redirected) throw new WorkspaceAuthError("Sign in again to reconnect. Your draft stays in this tab.");
  if (response.status === 304) {
    if (!etag) throw new Error("The update was incomplete. Your current view is preserved.");
    return { kind: "unchanged", etag: response.headers.get("etag") ?? etag };
  }
  if (!response.ok) throw new Error("Updates are unavailable. Your work is still saved.");
  const data: unknown = await response.json();
  if (!isWorkspace(data)) throw new Error("The update was incomplete. Your current view is preserved.");
  return { kind: "changed", workspace: data, etag: response.headers.get("etag") };
}

/** Exactly one POST. A lost response is resolved only through readWorkspace. */
export async function sendMessage(workspace: BrowserWorkspace, message: PendingMessage, fetcher: typeof fetch = fetch,
  /** The task composer's mode ("build", "plan" or "answer"); the server refuses it anywhere else. */
  mode: string | null = null): Promise<{ refused: boolean; message: string | null }> {
  const chat = workspace.conversation;
  if (!chat) throw new WorkspaceAuthError("Reconnect to the conversation before sending.");
  const body = new URLSearchParams({ csrf: workspace.csrf, message: message.text, request: message.request, "request-session": String(chat.sessionId) });
  if (mode !== null && chat.taskId) body.set("mode", mode);
  if (chat.taskId) body.set("task", chat.taskId);
  else if (chat.project) body.set("project", chat.project);
  if (chat.resultRunId !== null) body.set("result", String(chat.resultRunId));
  const response = await fetcher("/chat", { method: "POST", credentials: "same-origin", body, headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (response.status === 401 || response.status === 403) throw new WorkspaceAuthError("Sign in again to reconnect. Your draft stays in this tab.");
  if (response.headers.get("content-type")?.includes("application/json")) {
    const data: unknown = await response.json();
    if (record(data) && data.ok === false) return { refused: true, message: typeof data.said === "string" ? data.said : "Message not sent. Your draft is saved." };
  }
  // A native 303 may have followed through to HTML. It is not a receipt.
  return { refused: false, message: null };
}
