/** The browser consumes this contract with a type-only import. All HTML is
 * produced by the existing trusted server renderers, never by a model-supplied
 * fragment. These projections do not authenticate, mutate or grant authority. */
import type { TeamSnapshot } from './team-contract.js';
import type { BrandIconId } from './brand-icons.js';
import type { AssignmentSnapshot } from './assignment.js';
import { browserCrewFromIndex } from './browser-crew.js';
export { browserCrewFromIndex, browserWorkActionHref } from './browser-crew.js';
import type { Store } from './store.js';
import type { WorkSummaryAccess } from './work-summary.js';
import { workIndexPage, type WorkIndexItem, type WorkIndexPage } from './work-index.js';
import type { StatusTone } from './workspace-ui.js';
import type { Ask, AskChip } from './needs-you.js';
import type { WorkIndexGroup } from './work-index.js';
import type { AssignmentCard } from './assignment-ui.js';
import type { TaskStatus } from './task-status.js';
import type { AcceptLabel, ResultActFacts, ResultActs } from './result-acts.js';
import type { FirstRunStep, FirstTaskSuggestion, JourneyStep } from './first-run.js';

export type BrowserProject = { name: string; path: string; href: string; knowledgeHref: string };
/** count: tasks waiting on a person, shown beside Tasks when above zero. */
export type BrowserNavigationItem = { label: string; href: string; active: boolean; count?: number };
export type BrowserChatLink = { kind: 'project' | 'task'; title: string; href: string; at: string | null; active: boolean };
export type BrowserCrewItem = {
  id: string; title: string; project: string | null;
  state: AssignmentSnapshot['state']; label: string; tone: StatusTone;
  href: string; resultHref: string | null; action: { label: string; href: string } | null;
  /** When the task family last changed (the index's own sort time), shown as the row's age. */
  updatedAt: string;
  /** "<name> is on it.": the person's own lead took it on, by the name they gave it. */
  lead?: string;
};
export type BrowserMessage = {
  id: number; role: 'operator' | 'assistant'; text: string; html: string;
  activity: string | null; createdAt: string; cardsHtml: string;
  /** The same cards as data, confirmed in place (chat cards). */
  cards?: BrowserActionCard[];
};
/** A card the lead proposed: what it would do (the server's own body) and
 * the one act it offers. Confirming posts to the card's own door. */
export type BrowserActionCard = {
  id: number; kind: string; label: string;
  state: 'drafting' | 'pending' | 'confirming' | 'confirmed' | 'refused' | 'dismissed' | 'expired';
  body: string;
  said: string | null;
  links: BrowserLink[];
  primary: { kind: 'confirm'; label: string; irreversible: boolean; native: boolean } | { kind: 'link'; label: string; href: string } | null;
  dismissable: boolean;
  note: string | null;
};
export type BrowserConversation = {
  sessionId: number; user: string; version: string; messages: BrowserMessage[];
  pendingTurnId: number | null; requestId: string; maxChars: number;
  taskId: string | null; resultRunId: number | null;
  /** A project's own thread (v77); absent or null for the lead conversation or a task. */
  project?: string | null;
};
/** A page rebuilt as React components (shadcn/ui). The server still renders
 * its HTML as the no-JavaScript fallback; forms post to the same routes. */
export type BrowserLink = { label: string; href: string };
export type BrowserTasksView = {
  kind: 'tasks';
  tabs: (BrowserLink & { count: number; active: boolean })[];
  /** Tasks waiting on a person in this view's scope ("3 need you" beside the title). */
  needsYou: number;
  /** All and Needs you list their rows in these groups, in this order (empty ones left out); null: one plain list. */
  groups: { key: BrowserTaskGroup; label: string; count: number }[] | null;
  rows: {
    id: string; title: string; href: string; project: string | null; age: string;
    status: { label: string; tone: StatusTone; token: string };
    /** What a Needs you row asks: its group. */
    ask: Ask | null;
    /** The row's chip under its group: the specific ask (Plan, Result, Mismatch, Plan changed, Failed, Builder offline), or none. */
    chip: AskChip | null;
    group: BrowserTaskGroup;
    action: BrowserLink | null; detail: string | null; problem: string | null; notes: string[];
  }[];
  empty: { text: string; action: BrowserLink | null } | null;
  pages: { first: string | null; next: string | null };
  tools: BrowserLink[];
  newTask: BrowserLink;
  /** v105: subscription windows and monthly budgets, one tile each (an instance operator's; null when there are none). */
  limits: BrowserLimits | null;
};
/** One limit: a plan's usage window ("Claude · 5-hour, 48%") or a monthly budget ("shop · Budget, $4.20 of $10"). */
export type BrowserTaskGroup = WorkIndexGroup;
export type BrowserLimitTile = {
  key: string; name: string; window: string; value: string; unit: string; percent: number;
  detail: string; tone: 'neutral' | 'warning' | 'danger'; marks: number[]; title: string | null; href: string | null;
};
export type BrowserLimits = { tiles: BrowserLimitTile[] };
export type BrowserSettingsView = {
  kind: 'settings';
  said: string | null;
  /** The settings destinations under short headings; a chat app's tile says whether it is connected and gets alerts. */
  groups: BrowserSettingsGroup[];
  theme: 'system' | 'light' | 'dark';
  /** The signal colour chosen for this browser (Settings → Appearance), "#rrggbb"; chart magenta by default. */
  accent: string;
  accentPresets: { id: string; name: string; year: number | null; hex: string }[];
  permission: { mode: string; canManage: boolean; changed: string | null } | null;
  quality: { mode: string; canManage: boolean; changed: string | null } | null;
  providers: {
    provider: string; name: string; tone: 'ok' | 'warn' | 'off' | 'neutral'; words: string;
    connection: { words: string; facts: string; checkHref: string } | null;
    usage: string; envName: string; subscriptionCapable: boolean; mode: 'subscription' | 'api-key'; set: boolean;
  }[] | null;
  services: { configured: string[]; channel: string | null; implicit: boolean } | null;
  push: { available: boolean; devices: { id: number; words: string; state: string; removable: boolean }[] } | null;
  /** Quiet chat: how chats reach this person, and their evening digest time (null: off). */
  chat?: { mode: 'quiet' | 'all'; digestAt: string | null;
    /** Whether a result's saved screenshots follow its chat message: off, the first one, or up to 4. */
    screenshots?: 'off' | 'first' | 'all';
    /** Each project this person can see; a muted one sends no pings but stays in Tasks and the digest. */
    projects?: { repo: string; name: string; muted: boolean }[] } | null;
  digest: { every: string; held: string | null } | null;
  telegram: { state: string; current: string;
    /** v98: how the bot's messages reach Toolroll (pushed, or asked for), in words. */
    delivery?: string | null };
  /** Each worker: how many tasks it runs at once, and what it is running now. */
  workers?: { name: string; tone: 'ok' | 'warn' | 'off'; state: string; capacity: number; busy: number;
    running: { taskId: string; title: string; href: string; project: string | null }[] }[] | null;
  /** v87: the mail server Send email steps use (approvers only); the password is never shown back. */
  email?: { set: boolean; host: string; port: number; secure: boolean; user: string; from: string;
    /** v89: where Email inbox triggers read (IMAP), and a Google account connected instead of a mail server (`redirect`: the address to register with Google, when this page's address can take one). */
    imapHost: string; imapPort: number; google: { connected: string | null; clientId: string; redirect: string | null } } | null;
  /** The installation's first Ready result, in words ("first result in 7 min"); null before it arrives. */
  firstResult?: string | null;
  /** Settings → Updates: this version, the latest known one and its notes, how to update, the daily-check switch, and each worker's version. */
  updates?: BrowserUpdates | null;
};
/** A tile's `brand` is a chat app's logo (brand-mark.ts), drawn in place of its icon. */
export type BrowserSettingsGroup = { title: string; tiles: { href: string; label: string; brand?: BrandIconId; status?: { tone: 'ok' | 'warn' | 'off'; words: string } }[] };
export type BrowserUpdates = {
  current: string;
  /** The latest release the last check found; null before any check has worked. */
  latest: { version: string; newer: boolean; security: boolean; notes: string; url: string } | null;
  updateCommand: string;
  /** The daily check: off by TOOLROLL_NO_UPDATE_CHECK (byEnv) or by this switch; only an operator may flip it. */
  check: { on: boolean; byEnv: boolean; canManage: boolean };
  workers: { name: string; version: string | null; older: boolean }[];
};
/** A fold on the task page. Its HTML is the server's own section body, so
 * forms, ids and page scripts are unchanged. */
export type BrowserTaskSection = { id: string; title: string; html: string; open: boolean; count: number | null };
/** `at`: a moment, shown in the reader's own time ("16:39", "Yesterday 16:39", "Sep 28"). */
export type BrowserTaskFact = { label: string; parts: (string | BrowserLink | { seal: string } | { at: string })[] };
/** One entry in a task's thread, in time order beside the task's own
 * conversation: the plan, the agent's progress notes and results, its
 * questions, and the person's replies. `html` is the server's own card (same
 * forms and ids) when the entry carries one. */
export type BrowserTaskThreadItem = {
  key: string; at: string; kind: 'filed' | 'plan' | 'progress' | 'result' | 'question' | 'reply';
  who: 'agent' | 'person'; author: string; title: string; text: string | null;
  link: BrowserLink | null; html: string; more: { summary: string; html: string } | null;
};
/** The task's metadata, grouped for the Details panel (desk) or sheet (phone). */
export type BrowserTaskDetailGroup = { title: 'Work' | 'Links' | 'Review' | 'About'; facts: BrowserTaskFact[] };
export type BrowserTaskView = {
  kind: 'task';
  id: string; title: string; project: string | null; scout: boolean;
  tabs: (BrowserLink & { active: boolean })[];
  version: { label: string; current: BrowserLink } | null;
  /** The status card; `statusHtml` stands in when no assignment projection exists. */
  status: AssignmentCard | null;
  statusHtml: string;
  /** The approval ceremony or its updated terms, exactly as signed. */
  approval: string;
  /** Confirm it stopped, behind the password, when the status asks for it. */
  confirmStopped?: { action: string; run: number; checked?: boolean } | null;
  /** Build again, in place, when the status asks for it (a result built to an earlier plan). */
  rebuild?: { action: string } | null;
  /** What a failed task missed, in one line (the requirement it missed, the failing check's error line, or the stop
   * reason), the evidence line behind it, one suggestion of what to change, and where to see it (its build's result
   * page, or that exact check-log line); and Retry itself, its note starting with the suggestion. */
  failure?: BrowserFailure | null;
  retry?: { action: string; note?: string } | null;
  /** Run checks in place, on a status row that offers it: posts and comes back to this page. */
  runChecks?: BrowserRunChecks | null;
  /** A live build: the step it is on (or stuck on, with the act that helps), and the earlier attempts that stopped
   * before it, folded into one quiet line. */
  progress?: { line: string; stuck: { step: number; why: string | null; line: string; action: BrowserLink | null } | null } | null;
  /** Stop, on the Building card: the exact live build's stop form (posts its run id). */
  stop?: { action: string; run: number } | null;
  /** The Building card's link to the live build's own record ("Build #N record", /r/<id>). */
  record?: BrowserLink | null;
  earlier?: { summary: string; attempts: { label: string; href: string; text: string | null }[] } | null;
  /** Server cards that may need a person now (stop/resume, scope prompt, plan, live attempt). */
  lead: { key: string; html: string }[];
  questions: string;
  facts: BrowserTaskFact[];
  sections: BrowserTaskSection[];
  manage: BrowserTaskSection[];
  /** The armed cancel form; null once the task cannot be cancelled. */
  cancel: { html: string; open: boolean } | null;
  /** "Do this every time…": Settings → Flows with the matching starter flow marked. */
  everyTime?: { href: string; starter: string } | null;
  /** Until the first Ready result: Plan → You approve → Build → Checks → Ready, filled in as it moves. */
  journey?: JourneyStep[] | null;
  /** The thread's server-side entries; the conversation's messages join them in time order. */
  thread?: BrowserTaskThreadItem[];
  details?: BrowserTaskDetailGroup[];
  /** Where to message the agent when this page carries no conversation (null: messaging isn't available here). */
  chatHref?: string | null;
};
/** One project on the Projects page; opening it is a POST to /projects/open. */
export type BrowserProjectRow = {
  name: string; path: string; shortPath: string; open: boolean;
  /** When it was last opened here; null for a project only seen in the queue. */
  openedAt: string | null;
  knowledgeHref: string;
  /** Settings → Projects → Pull requests for this project, and whether they are on. */
  pullRequests?: { href: string; on: boolean };
  /** Settings → Projects → Checks for this project, and its level in words. */
  checks?: { href: string; level: string };
  /** What waits, runs, queues or finished today; null when not scanned. */
  peek: { label: string; href: string; tone: 'attention' | 'info' | 'neutral' | 'success' }[] | null;
};
export type BrowserProjectsView = {
  kind: 'projects';
  /** Arrived from New task: choosing where the task belongs. */
  choosing: boolean;
  problem: string | null;
  returnTo: string;
  recent: BrowserProjectRow[];
  available: BrowserProjectRow[];
  /** The add roads; `html` carries the server's GitHub-link and exact-path forms. */
  add: { browse: string | null; github: string | null; html: string };
};
export type BrowserResultTab = 'summary' | 'changes' | 'checks';
/** The shared result panel in parts. Each tab's content, the feedback
 * section and the learning card are the server's own HTML; the page script
 * binds to the same data attributes and ids (tabs, drafts, line notes). */
export type BrowserResultPanel = {
  attributes: Record<string, string>;
  heading: string;
  outcome: string;
  /** The shared task status (task-status.ts): headline, sentence and detail rows. */
  status: TaskStatus | null;
  reviewHistory: string | null;
  attention: string[];
  /** Requirements only a person can confirm, in plain words, and the one
   * Accept that records the decision (null when it is not offered here). */
  youCheck: { lines: string[]; items: BrowserCheckItem[]; accept: { action: string; run: number; returnTo: string } | null } | null;
  /** The Requirements row's counts, so it updates as the person answers their checks (null when it doesn't count them). */
  requirements?: { met: number; total: number; yours: number } | null;
  /** Storage limits on saved output (shortened logs or diffs): shown on request. */
  limits: string[];
  tabs: { key: BrowserResultTab; label: string; count: string; href: string; active: boolean }[];
  views: { key: BrowserResultTab; html: string }[];
  history: string;
  learning: string;
  request: string | null;
  /** A browser session may attach feedback to this result's sealed diff. */
  canRequest: boolean;
  /** Needs you: the one action that resolves it, first and filled; `confirm` posts behind the password. */
  need: BrowserNeedAction | null;
  /** The feedback section holds only the closed form (no notes, revisions or history). */
  requestQuiet: boolean;
};
/** One "You check this one" item and the evidence to judge it by: the
 * changed lines it cites (or, citing none, the change's own first lines),
 * its screenshots, and the agent's note. Wrapped text, never sideways. */
export type BrowserCheckItem = {
  id: string; statement: string; words: string; note: string | null;
  excerpts: { path: string; cited: boolean; lines: { kind: "addition" | "deletion" | "context"; line: number | null; text: string }[]; more: number }[];
  shots: { src: string; href: string; caption: string }[];
};
/** The result's one decision: what Accept is called, why it isn't plain
 * Accept and finish, and what pressing it does. `base`: the same words before
 * the person's own checks, which the page adds as they answer them. */
export type BrowserResultDecision = { label: AcceptLabel; ready: boolean; why: string | null; effect: string; sentence: string;
  base?: { label: AcceptLabel; ready: boolean; why: string | null } };
/** A Needs you action: a link, (Confirm it stopped) a form behind the password, (Build again) one
 * button, or (on the result itself) Accept, which records the person's acceptance; `note` asks why
 * when the evidence disagrees. */
export type BrowserNeedAction = { label: string; href: string | null; confirm: { action: string; run: number; returnTo: string; checked?: boolean } | null;
  accept?: { action: string; run: number; returnTo: string; note: string | null } | null;
  /** Build again (a result built to an earlier plan): one button, the task page's requeue. */
  rebuild?: { action: string } | null };
export type BrowserResultView = {
  kind: 'result';
  results: { title: string; href: string; at: string; status: { label: string; tone: StatusTone } | null; notes: string[]; current: boolean; needsYou: boolean }[];
  /** How many results need a person; the list's cap when it is full. */
  attention: number;
  capped: number | null;
  missing: string | null;
  beyond: boolean;
  selected: {
    taskId: string; title: string; project: string | null; build: number | null;
    taskHref: string; chatHref: string;
    status: { label: string; tone: StatusTone; token: string };
    problem: string | null;
    next: { kind: string; title: string; detail: string; control: string } | null;
    /** Accept and finish: the exact receipt read; `accept` when the one request also records the person's acceptance
     * (`note`: the words over the reason field it asks for, or null for none). */
    complete: { action: string; receipt: string; run: number; accept?: { note: string | null } | null } | null;
    /** Words for the result's Accept: Accept and finish when offered, else the Needs you acceptance. */
    decision: BrowserResultDecision | null;
    checks: { detail: string; problem: boolean; logHref: string | null } | null;
    /** A refuted result's recorded disagreements: the headline when the report doesn't match the changes (null when a
     * failed check is the blocker, so the status keeps its own), each disagreement in plain words with the changed lines
     * it concerns (`absent`: a file the changes don't have), and the recorded words they already say, so no caveat
     * repeats them. Null otherwise. */
    mismatch: { headline: string | null; rows: { text: string; path: string | null; lines: string | null; href: string | null; absent: boolean; noteLabel: string | null }[]; said: string[] } | null;
    /** The one ink act that resolves the result, the one outline act beside it, and why it can't be accepted yet (result-acts.ts). */
    acts: ResultActs;
    /** The facts the acts were chosen from, so the page chooses again as the person answers their checks. */
    actFacts?: ResultActFacts;
    /** Run checks on this result's commit: the project's check, when it didn't run. */
    runChecks: BrowserRunChecks | null;
    /** A failed build's result: what it missed and the suggestion Retry's note starts with; Retry itself when the task
     * can be retried from here. Null for every other result. */
    failure?: (BrowserFailure & { retry: { action: string; note: string } | null;
      /** A failed task's delivered result, accepted only in outline with a reason (the task's accept-proof). */
      acceptAnyway?: { action: string; run: number; returnTo: string } | null }) | null;
    /** The raw run record, under Details: its facts and the full record. */
    record: { build: number; href: string; facts: { label: string; value: string }[] } | null;
    /** The signed scope; null when none was filed. */
    intent: { approval: string; approvedAt: string | null; html: string } | null;
    noRun: string | null;
    panel: BrowserResultPanel | null;
    contest: string;
    notes: { author: string; at: string; note: string }[];
  } | null;
};
export type BrowserFailure = { line: string; evidence: string | null; suggestion: string; link: { label: string; href: string } | null };
export type BrowserRunChecks = { action: string; level: "quick" | "full"; returnTo: string };
/** One zone on a flow's canvas: its step, where it leads, and where it sits. */
export type BrowserFlowStage = {
  id: string; title: string; kind: "inbox" | "task" | "report" | "approval" | "check" | "pull-request" | "update" | "notify" | "sort" | "draft" | "request" | "email" | "tool" | "wait" | "teammate" | "send" | "choose" | "done";
  zone: { x: number; y: number; w: number; h: number; color: string };
  instructions: string | null; planning: "auto" | "required" | "skip" | null; approver: string | null; message: string | null;
  /** An approval zone the flow's owner decides. */
  toOwner?: boolean;
  /** v87: a web request, an email, a project tool call. */
  request?: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; url: string; headers: Record<string, string>; body: string | null };
  email?: { to: string; subject: string; body: string };
  tool?: { server: string; name: string; args: string };
  close: boolean | null; script: string | null;
  /** v90: a script zone runs in an empty folder or a copy of the card's work; the answers its "goto:" line picks; the saved secrets it gets. */
  runIn?: "folder" | "copy"; routes?: { answer: string; to: string }[]; secrets?: string[];
  /** A sort zone: Jev's question, its answers and where each goes, how sure it must be to act alone, and what else it notes. */
  sort: { question: string; answers: { answer: string; means: string; to: string }[]; sureAt: number; notes: { id: string; kind: "score" | "yes-no"; question: string; levels: string[] | null }[] } | null;
  /** v91: a Wait zone waits for a reply to the card's email (onFail: no reply in time) or a set time; any other zone may have a time limit. */
  wait?: { for: "reply" | "time" | "hours"; minutes: number; from?: string; to?: string; timeZone?: string };
  /** A Pull request zone merges once checks pass (after a person approved), this way. */
  merge?: "squash" | "merge" | "rebase" | undefined;
  limit?: { minutes: number; to: string | null } | undefined;
  /** v92: the AI teammate who decides (an approval zone) or handles (a teammate zone) it. */
  teammate?: string | undefined;
  /** v96: a teammate zone sends what the teammate writes back to whoever asked. */
  reply?: boolean | undefined;
  /** A "Person chooses" zone's buttons: each one's words and the zone it leads to ("end" ignores the card). */
  options?: { label: string; to: string }[] | undefined;
  /** A Build zone in another project: its path. */
  repo?: string | undefined;
  next: string | null; onFail: string | null;
};

/** One card: a piece of work, where it is, what it waits on, what zones said. */
/** After research, one of the report's items as the message numbered it, with its screenshot when it has one. */
export type BrowserFlowSentItem = { number: number; title: string; lines: string[]; source: string; url: string; image: { src: string; caption: string } | null };

export type BrowserFlowCard = {
  id: number; title: string; description: string | null; stage: string; state: "active" | "done" | "cancelled";
  waiting: string | null; task: { id: string; href: string } | null; createdBy: string; updatedAt: string;
  canDecide: boolean; outputs: { stage: string; title: string; text: string }[]; history: { text: string; at: string }[];
  /** Where a trigger found it: a GitHub or Linear issue, another flow's card, a button, a schedule. */
  source: { kind: string; label: string; url: string | null } | null;
  /** Who is responsible for it, who follows it, and whether the viewer does. */
  owner: string | null; watchers: string[]; watching: boolean;
  /** Owned by the viewer, followed by them, or waiting on their decision. */
  mine: boolean;
  /** What people said on it, oldest first; ownership changes read as history instead. */
  comments: { id: number; author: string; body: string; mentions: string[]; at: string }[];
  /** The latest sort: its short chip ("Bug · 94% · Now") and whether Jev was sure enough to act alone. */
  sorted: { chip: string; confident: boolean } | null;
  /** Waiting at a decision after a draft: the draft, which the person can edit before approving. */
  draft: { zone: string; title: string; text: string } | null;
  /** v91: when its Wait zone gives up or moves on, or its zone's time limit comes (shown in the viewer's own time). */
  deadline?: { at: string; label: string } | null;
  /** v92: a teammate's open question about this visit, and whether the viewer is the one asked. */
  question?: { id: number; from: string; question: string; options: { id: string; label: string }[]; askedOf: string; mine: boolean;
    /** v94: a tool call waiting for approval — why the teammate wants it, and why it needs approval. */
    call?: { why: string; rule: string } | null } | null;
  /** v92: what the teammate said when it handed this decision to a person. */
  handoff?: { from: string; note: string } | null;
  /** Waiting at a "Person chooses" zone: what was sent, its options and whether the viewer is the one who chooses. */
  choose?: { entry: number; title: string; summary: string; links: { label: string; href: string }[]; items?: BrowserFlowSentItem[]; person: string; mine: boolean; options: { choice: number; label: string }[]; reply: boolean } | null;
  /** What a "Send to me" (or an earlier choice) last sent the card's person. */
  sent?: { title: string; summary: string; links: { label: string; href: string }[]; items?: BrowserFlowSentItem[]; person: string; at: string } | null;
  /** v94: every tool call teammates made or asked to make on this card, oldest first: the receipts. */
  calls?: { id: number; who: string; words: string; state: string; outcome: string; why: string; result: string | null; at: string;
    /** v97: the teammate's id and the action that undoes this call, when a person can press Undo. */
    teammate?: number; undo?: string | null }[];
};

/** What starts cards in a flow on its own. */
export type BrowserFlowTrigger = {
  id: number; kind: string; words: string; name: string; detail: string; zone: string; zoneId: string; state: "active" | "paused" | "removed";
  status: string | null; statusAt: string | null; failing: boolean;
  /** Where the status points a person (a plane review's long waits: Needs you). */
  statusLink: BrowserLink | null;
  button: { label: string; questions: string[] } | null;
  /** A webhook trigger: whether it can prove deliveries yet (Linear needs its signing secret pasted). */
  hook: { ready: boolean; needsSecret: boolean } | null;
  checkable: boolean;
  /** A button shared as a public form (its link works). */
  shared: boolean;
};

/** A flow's canvas: zones, cards, and what this person may change. */
export type BrowserFlowView = {
  kind: "flow";
  /** v100: signed in with the identity provider, a step-up is that sign-in (confirmed, or a link to confirm), not a password. */
  stepUp?: { label: string; fresh: boolean; confirmHref: string };
  flow: { id: number; name: string; project: string; revision: number; href: string; owner: string };
  /** Opens the lead's chat with a message about this flow started for the person to finish. */
  chatHref: string;
  triggers: BrowserFlowTrigger[];
  /** What adding a trigger needs to know: this project's GitHub repository, whether a Linear key is saved, the public webhook address, other flows to follow. */
  triggerSetup: {
    kinds: { kind: string; label: string }[]; githubRepo: string | null; linearKey: boolean; hooksBase: string | null; hooksPath: string;
    /** v89: whether Email inbox triggers can read mail (Settings → Email), and whose mailbox it is. */
    mailbox: string | null;
    otherFlows: { id: number; name: string; zones: { id: string; title: string }[] }[];
  };
  /** A button trigger to open straight away (?start=). */
  startTrigger: number | null;
  /** Who is looking: their name, for "mine", owning and @mentions. */
  me: string;
  /** Whether sort zones can run: an OpenRouter key is saved in Settings → AI providers. */
  sortReady: boolean;
  /** v92: the project's AI teammates, to staff zones with. */
  teammates?: { handle: string; label: string; name: string; working: boolean; href: string }[];
  /** v87: whether email is set up (Settings → Email), the names of this project's request secrets, and its tools with what each can do. */
  emailReady: boolean;
  requestSecrets: string[];
  tools: { name: string; about: string; functions: string[]; ready: boolean }[];
  /** The project's scripts: reusable steps a "Run a script" zone runs with no AI. */
  /** v90: each script's language, and the project file it runs instead of a body. */
  scripts: { name: string; about: string; body: string; timeoutMinutes: number; version: number; savedBy: string; savedAt: string; usedHere: string[]; language: "shell" | "python" | "node"; file: string | null;
    /** It came with an imported flow and waits for a person's approval before it runs. */
    held: boolean }[];
  start: string;
  stages: BrowserFlowStage[];
  cards: BrowserFlowCard[];
  selectedCard: number | null;
  /** Where the flow stands (v88): the live stream's nudge names it, and a page that already shows it doesn't read again. */
  live: string | null;
  canEdit: boolean;
  approvers: string[];
  /** The projects a Build zone may work in: the flow's own first, then others the viewer can reach. */
  projects?: { path: string; name: string }[];
  kinds: { kind: BrowserFlowStage["kind"]; label: string; about: string }[];
  colors: string[];
};

export type BrowserView = BrowserTasksView | BrowserSettingsView | BrowserTaskView | BrowserProjectsView | BrowserResultView | BrowserFlowView;

export type BrowserWorkspace = {
  version: 1; path: string; title: string; user: string; csrf: string; sensitive: boolean;
  /** What this person named their lead (Settings → Lead): the chat header and every lead message say it. */
  leadName?: string;
  refreshUrl: string; receipt: { request: string; received: boolean } | null;
  projects: BrowserProject[]; crew: BrowserCrewItem[]; crewTruncated: boolean;
  conversation: BrowserConversation | null;
  team?: TeamSnapshot;
  focus: { id: string; title: string; html: string } | null;
  result: { runId: number; html: string } | null;
  catchUpHtml: string; controlsHtml: string; notices: string[]; pageHtml: string | null;
  navigation: BrowserNavigationItem[];
  /** This person's recent project and task conversations (v77), newest first. */
  chats?: BrowserChatLink[];
  view?: BrowserView | null;
  /** A live page (Inbox, System…) reads itself again this often; forms being edited are kept. */
  refreshSeconds?: number;
  /** Providers whose sign-in stopped working: their work waits (one per provider). */
  signIn?: BrowserSignIn[];
  /** A demo database: the notice that says so, scrolling with the page (`short`: its one line on a phone). */
  demo?: { text: string; short: string };
  /** A newer Toolroll exists: a quiet notice for an operator, until they dismiss this version. */
  update?: BrowserUpdateNotice;
  /** Chat's first run, until the first Ready result: the three steps and first tasks to try. */
  firstRun?: BrowserFirstRun;
  /** Chat, after the first Ready result until put away: use it from the phone. */
  phone?: BrowserPhoneCard;
  /** The Chat landing's live view: who is working now, four counts, and Catch up in tabs. */
  home?: BrowserHome | null;
};

/** One agent at work now: its task and the machine's own phase, in words. */
export type BrowserHomeAgent = { runId: number; taskId: string; title: string; href: string; agent: string; phase: string; project: string | null; since: string };
export type BrowserHomeCount = { key: 'working' | 'waiting' | 'ready' | 'done'; label: string; value: number; href: string };
export type BrowserCatchUpTab = 'needs-you' | 'ready' | 'running' | 'all';
export type BrowserCatchUpItem = {
  id: string; title: string; href: string; project: string | null; tab: Exclude<BrowserCatchUpTab, 'all'> | 'finished';
  label: string; tone: StatusTone; detail: string; at: string;
  /** Needs you: the one action that resolves it. */
  action?: { label: string; href: string } | null;
};
/** Plan-window use stands in for spend: subscriptions don't bill per run. */
export type BrowserHome = {
  agents: BrowserHomeAgent[]; counts: BrowserHomeCount[];
  planUse: { name: string; window: string; percent: number; detail: string; tone: 'neutral' | 'warning' | 'danger' }[];
  catchUp: BrowserCatchUpItem[]; allHref: string;
  /** What this person's lead is doing now and when it last acted (lead-voice.ts); its task when it named one. */
  lead?: { name?: string; doing: string; at: string; href: string | null } | null;
};

/** `sandbox`: the demo command, offered beside the sign-in command while no agent is signed in. `intro`: how it works,
 * once, above the composer with the suggestions. `lead`: the one line saying what runs the lead, and where to change it.
 * `recheck`: while no agent is signed in, where the page asks again on its own. */
export type BrowserFirstRun = { steps: FirstRunStep[]; suggestions: FirstTaskSuggestion[]; sandbox: string | null;
  intro?: string; lead?: { words: string; href: string } | null; recheck?: string | null };

/** After the first Ready result: the phone, through a chat app or the console over Tailscale. `tailnet.restart`: the
 * command that makes the console listen beyond this computer, when it doesn't yet. */
export type BrowserPhoneCard = { chatApps: { label: string; href: string }[]; tailnet: { address: string; restart: string | null } | null; dismissHref: string };

/** The console's update notice: neutral, never the accent — an update does not need a person. */
export type BrowserUpdateNotice = { version: string; security: boolean; href: string; dismissHref: string };

/** A provider's sign-in pause, as the console shows it: the plain reason,
 * what to run, and the one action that resumes its work. */
export type BrowserSignIn = { provider: string; title: string; command: string; detail: string; resumeLabel: string; resumeHref: string };

/** Safe inside a script[type=application/json] element. JSON escaping alone
 * does not stop the HTML parser from closing that element at </script>. */
export function serializeBrowserWorkspace(workspace: BrowserWorkspace): string {
  return JSON.stringify(workspace).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export const BROWSER_CREW_LIMIT = 40;
export type BrowserCrewOptions = { evidenceRoot?: string; limit?: number; project?: string | null };

/** A bounded recent family list. The caller supplies its already admitted
 * access; an optional project can only narrow it. Admission and family grouping
 * happen before the SQL limit and before reading questions or saved evidence. */
export function browserCrewOf(store: Store, now: Date, access: WorkSummaryAccess, options: BrowserCrewOptions = {}): {
  crew: BrowserCrewItem[]; crewTruncated: boolean;
} {
  const project = options.project ?? null;
  if (project !== null && access.repos !== null && !access.repos.includes(project)) return { crew: [], crewTruncated: false };
  const limit = Number.isFinite(options.limit)
    ? Math.max(1, Math.min(BROWSER_CREW_LIMIT, Math.floor(options.limit!))) : BROWSER_CREW_LIMIT;
  const page = workIndexPage(store, now, access, { limit, project });
  return browserCrewFromIndex(page);
}

/** Navigation input must already be admitted by the caller. No extra project
 * discovery belongs in a browser projection. Keep exact paths in every link. */
export function browserProjectsOf(projects: readonly { name: string; path: string }[]): BrowserProject[] {
  const seen = new Set<string>();
  return projects.flatMap(project => {
    if (seen.has(project.path)) return [];
    seen.add(project.path);
    return [{ name: project.name, path: project.path, href: `/work?project=${encodeURIComponent(project.path)}`,
      knowledgeHref: `/settings/knowledge?repo=${encodeURIComponent(project.path)}` }];
  });
}

export function browserNavigationOf(path: string, project: string | null = null, needsYou = 0): BrowserNavigationItem[] {
  const pathname = path.split('?')[0]!.split('#')[0]!;
  const knowledge = pathname === '/settings/knowledge' || pathname.startsWith('/settings/knowledge/');
  return [
    { label: 'Chat', href: '/chat', active: pathname === '/chat' },
    { label: 'Tasks', href: `/work${project === null ? '' : `?project=${encodeURIComponent(project)}`}`,
      active: pathname === '/work' || pathname === '/tasks' || pathname.startsWith('/t/') || pathname.startsWith('/r/'),
      ...(needsYou > 0 ? { count: needsYou } : {}) },
    { label: 'Flows', href: '/flows', active: pathname === '/flows' || pathname.startsWith('/flows/') },
    { label: 'Projects', href: '/projects', active: pathname === '/projects' },
    { label: 'Knowledge', href: `/settings/knowledge${project === null ? '' : `?repo=${encodeURIComponent(project)}`}`, active: knowledge },
    { label: 'Settings', href: '/settings', active: !knowledge && (pathname === '/settings' || pathname.startsWith('/settings/')) },
  ];
}
