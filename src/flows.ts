/**
 * Flows (v81): a canvas of zones that work moves through. Each zone is one
 * stage of a team's process; each card is one piece of work. When a card
 * is routed or dropped into a zone, the zone's step runs:
 *
 * - inbox     — a holding zone: cards wait for someone to move them.
 * - task      — build it: files the card's work as an ordinary task, so the
 *               existing plan → approve → build → verify pipeline (with its
 *               approvals and agent fence) does the work; the card moves on
 *               when the result is ready, or down its failure path.
 * - report    — research it: files a report task (no code changes) and
 *               keeps the report on the card for later zones.
 * - approval  — a person decides: approve moves on; send back (with a
 *               note) takes the failure path, and a send back to a build
 *               zone becomes a revision of the card's work.
 * - notify    — posts a message to the project's chat and moves on.
 * - draft     — (v86) Claude writes something from the card (a reply, a
 *               summary, a note) in seconds, with no repository and no
 *               tools. Nothing is sent: a later zone shows it to a person
 *               and a later step posts it ({{stage.<id>}}).
 * - sort      — (v85) Jev, a decision model reached through OpenRouter,
 *               reads the card and picks one of the zone's answers; the
 *               card goes where that answer leads, or down the not-sure
 *               path when Jev is less sure than the zone asks. It can also
 *               note a few scores or yes/no answers on the card.
 * - request   — (v87) calls an address on the web (an API) with the card's
 *               details, and keeps what it answers; a refusal takes the
 *               failure path. Secrets ride headers only ({{secret.NAME}}).
 * - email     — (v87) sends an email from the address in Settings → Email;
 *               {{card.email}} is the first address the card mentions.
 * - tool      — (v87) calls one tool of one of the project's MCP servers
 *               (Settings → Tools), with arguments filled from the card.
 * - pull-request — opens a pull request for the card's built result under
 *               the project's pull request setup (flow-pull-request.ts),
 *               waits for CI, and moves on when it passes or down the
 *               failure path, naming the failing check, when it fails. It
 *               can merge once checks pass, only after a person approved.
 * - send      — "Send to me": sends the card's person (its owner, else the
 *               flow's) what the step before produced — its summary, links
 *               and images — in each chat app they paired and on the card,
 *               then moves on.
 * - choose    — "Person chooses": the same content, with 2 to 4 buttons the
 *               flow names (each leads to a zone, or ends the card as
 *               Ignored). A reply instead is the {{note}} for where replies go.
 * - done      — the end.
 *
 * The engine is deterministic and model-free: it runs in the worker's pass
 * beside routines, and no card ever skips an approval the task itself needs.
 */
import { createHash } from "node:crypto";

export const FLOW_STAGE_KINDS = ["inbox", "task", "report", "approval", "check", "pull-request", "update", "notify", "sort", "draft", "request", "email", "tool", "wait", "teammate", "send", "choose", "done"] as const;
export type FlowStageKind = (typeof FLOW_STAGE_KINDS)[number];
export const FLOW_COLORS = ["slate", "blue", "violet", "amber", "green", "rose"] as const;
export type FlowColor = (typeof FLOW_COLORS)[number];

export type FlowZone = { x: number; y: number; w: number; h: number; color: FlowColor };

/** One answer a sort zone can pick: its name, what it means (what Jev reads), and the zone it sends the card to. */
export type FlowSortAnswer = { answer: string; means: string; to: string };
/** Something else a sort zone notes on the card: a score on a scale of levels, or a yes/no. */
export type FlowSortNote = { id: string; kind: "score" | "yes-no"; question: string; levels: string[] | null };
/** sort: the question, its answers, how sure Jev must be to act alone (0.5–0.99), and what else it notes. */
export type FlowSort = { question: string; answers: FlowSortAnswer[]; sureAt: number; notes: FlowSortNote[] };
/** request: what is called. The address's scheme and host are fixed; fill-ins go in its path and query (encoded), headers and body. */
export type FlowRequest = { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; url: string; headers: Record<string, string>; body: string | null };
/** email: who it goes to, the subject and the text — all with fill-ins. */
export type FlowEmail = { to: string; subject: string; body: string };
/** tool: which of the project's tools (MCP servers), which of its functions, and the arguments as JSON with fill-ins. */
export type FlowTool = { server: string; name: string; args: string };
/** wait (v91): for a reply to the card's email (next: replied, onFail: no reply in time), or for a set time (then next).
 * "hours": until the clock is between `from` and `to` (like 22:00–06:00), in the computer's time zone unless one is named. */
export type FlowWait = { for: "reply" | "time" | "hours"; minutes: number; from?: string; to?: string; timeZone?: string };
/** How a Pull request zone merges once checks pass. */
export const FLOW_MERGE_METHODS = ["squash", "merge", "rebase"] as const;
export type FlowMergeMethod = (typeof FLOW_MERGE_METHODS)[number];
/** A choose zone's option: its button's words, and the zone it leads to (FLOW_END closes the card as Ignored). */
export type FlowChoice = { label: string; to: string };
/** Where a choose option that ends the card leads. */
export const FLOW_END = "end";
/** How many options a choose zone offers. */
export const CHOICES_MIN = 2, CHOICES_MAX = 4;
/** A time limit on a zone (v91): after this long, the person it waits on is reminded, and a Holding or
 * "Person decides" zone can move the card on (`to`). */
export type FlowLimit = { minutes: number; to: string | null };

export type FlowStage = {
  id: string;
  title: string;
  kind: FlowStageKind;
  zone: FlowZone;
  /** task/report: what the agent is asked to do. `{{card.title}}`,
   * `{{card.description}}`, `{{note}}` (the latest send-back note) and
   * `{{stage.<id>}}` (an earlier zone's report) are filled in. */
  instructions: string | null;
  /** task: plan first (required), let Toolroll decide (auto), or build directly (skip). */
  planning: "auto" | "required" | "skip" | null;
  /** approval: the one person who decides, or null for any approver on the project. */
  approver: string | null;
  /** approval: the flow's owner decides (v86), whoever that is when the card arrives; `approver` is then unused. */
  toOwner?: boolean;
  /** notify: the message; update: the comment left on the issue. Same fill-ins. */
  message: string | null;
  /** update: also close the issue (Linear: move it to the team's done state). */
  close: boolean | null;
  /** check: the project script (by name) run with no AI. */
  script: string | null;
  /** check (v90): where it runs — a clean folder, or a copy of the card's work (the default for zones made before v90);
   * the answers a script's "goto:" line may pick, each with the zone it leads to; and the flow secrets it gets as variables. */
  runIn?: "folder" | "copy";
  routes?: { answer: string; to: string }[];
  secrets?: string[];
  /** sort: what Jev is asked and where each answer leads. Its onFail is where a card goes when Jev isn't sure. */
  sort: FlowSort | null;
  /** request, email, tool (v87): what the step sends, and to where. */
  request?: FlowRequest;
  email?: FlowEmail;
  tool?: FlowTool;
  /** wait (v91): what it waits for, and how long. */
  wait?: FlowWait;
  /** Any zone but Wait and Done (v91): how long a card may sit here before someone is reminded. */
  limit?: FlowLimit;
  /** v92: the AI teammate (by handle) who decides a "Person decides" zone (handing hard ones to its person), or handles a "Teammate handles it" zone. */
  teammate?: string;
  /** v96: a "Teammate handles it" zone sends what the teammate writes back to whoever asked (the person who added the card, its chat thread, or the teammate's manager). */
  reply?: boolean;
  /** choose: the buttons the person picks from, in order. Its onFail is where a reply goes, with the reply as {{note}}. */
  options?: FlowChoice[];
  /** task: the project it builds in, when not the flow's own (one the flow's owner may file in). */
  repo?: string;
  /** pull-request: merge once checks pass, this way. Only allowed after a "Person decides" zone, and a card merges only when a person approved it after it was built. */
  merge?: FlowMergeMethod;
  /** Where a card goes when this zone's step succeeds, and when it fails or is sent back (sort: when it isn't sure). */
  next: string | null;
  onFail: string | null;
};

export type FlowDefinition = { version: 1; start: string; stages: FlowStage[] };

/** What each kind is called and does, in the words the canvas uses. */
export const FLOW_KIND_WORDS: Record<FlowStageKind, { label: string; about: string }> = {
  inbox: { label: "Holding", about: "Cards wait here until someone moves them." },
  task: { label: "Build", about: "An agent does the work as a task, with the usual approvals and checks." },
  report: { label: "Research", about: "An agent investigates and writes a report. No code changes." },
  approval: { label: "Person decides", about: "Someone approves, or sends it back with a note." },
  check: { label: "Run a script", about: "Runs one of the project's scripts (shell, Python or Node) with no AI. It gets the card; what it prints is passed on, and it can pick where the card goes next. If it fails, the card takes its failure path." },
  "pull-request": { label: "Pull request", about: "Opens a pull request for the card's built result and waits for CI. Green moves it on; red takes the failure path with the failing check named. It can merge once checks pass, only after a person approved." },
  update: { label: "Update where it came from", about: "Comments on the GitHub or Linear issue the card came from (and can close it), or answers in the chat thread it came from. Other cards pass straight through." },
  notify: { label: "Message", about: "Posts a message to the project's chat, then moves on." },
  request: { label: "Web request", about: "Calls an address on the web, like an API, with the card's details, and keeps what it answers. If it fails, the card takes its failure path." },
  email: { label: "Send email", about: "Sends an email from your address in Settings → Email. {{card.email}} is the first email address the card mentions." },
  tool: { label: "Use a tool", about: "Calls one of the project's tools (its connected MCP servers), like posting to Slack or adding a page to Notion." },
  draft: { label: "Draft", about: "Claude writes a reply, summary or note from the card in seconds. Nothing is sent until a later step sends it." },
  sort: { label: "Sort", about: "Jev reads the card in under a second and sends it where its answer leads. Cards it isn't sure about take the not-sure path." },
  wait: { label: "Wait", about: "Waits for a reply to the card's email, or for a set time. A reply moves the card on; if none comes in time, it takes the no-reply path." },
  teammate: { label: "Teammate handles it", about: "An AI teammate reads the card, decides where it goes within its rules, and writes what the next zones send. When its rules say to ask, it asks you first." },
  send: { label: "Send to me", about: "Sends the card's owner what the step before produced: its summary, links and any screenshots, in each chat app they use and on the card. Then moves on." },
  choose: { label: "Person chooses", about: "Sends the card's owner what was done with 2 to 4 buttons you name, in their chat apps and here. Each leads to a zone or ignores the card; a reply instead goes where replies go, as the note." },
  done: { label: "Done", about: "The end of the flow." },
};

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** A project script's name: short, lowercase, dashes — how zones and chat refer to it. */
export const SCRIPT_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** The languages a project script is written in (v90). */
export const SCRIPT_LANGUAGES = ["shell", "python", "node"] as const;
export type ScriptLanguage = (typeof SCRIPT_LANGUAGES)[number];
export const LANGUAGE_WORDS: Record<ScriptLanguage, string> = { shell: "Shell", python: "Python", node: "Node" };
const text = (value: unknown, cap: number): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error("Zone text must be plain text.");
  const trimmed = value.trim();
  if (trimmed.length > cap) throw new Error(`Zone text is up to ${cap} characters.`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed)) throw new Error("Zone text cannot contain control characters.");
  return trimmed === "" ? null : trimmed;
};
const coordinate = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.round(Math.min(max, Math.max(min, value))) : fallback;

/** How an answer is named to Jev: its words as a short key. */
export const sortKeyOf = (answer: string) => answer.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "answer";
/** The default for "sure enough to act alone". */
export const SORT_SURE_AT = 0.8;

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const HEADER = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

/** A web request's settings, checked: an http(s) address whose scheme and host are written out, not filled in. */
function validateRequest(input: unknown, title: string): FlowRequest {
  const raw = (input ?? {}) as Record<string, unknown>;
  const method = METHODS.includes(raw["method"] as typeof METHODS[number]) ? raw["method"] as FlowRequest["method"] : "POST";
  const url = text(raw["url"], 2000);
  if (url === null) throw new Error(`Zone ${title}: give the address it calls.`);
  const origin = /^(https?):\/\/([^/?#]*)/i.exec(url);
  if (origin === null) throw new Error(`Zone ${title}: the address must start with https:// or http://.`);
  if (origin[2]!.includes("{{") || origin[2]!.includes("@") || origin[2] === "") throw new Error(`Zone ${title}: write the address's host out in full; fill-ins go after it.`);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries((raw["headers"] ?? {}) as Record<string, unknown>)) {
    if (!HEADER.test(name)) throw new Error(`Zone ${title}: “${name}” isn't a header name.`);
    const said = text(value, 500);
    if (said !== null) headers[name] = said;
  }
  if (Object.keys(headers).length > 10) throw new Error(`Zone ${title}: up to 10 headers.`);
  return { method, url, headers, body: method === "GET" || method === "DELETE" ? null : text(raw["body"], 8000) };
}

/** An email's settings, checked. */
function validateEmail(input: unknown, title: string): FlowEmail {
  const raw = (input ?? {}) as Record<string, unknown>;
  const to = text(raw["to"], 500), subject = text(raw["subject"], 200), body = text(raw["body"], 8000);
  if (to === null) throw new Error(`Zone ${title}: say who it goes to, for example {{card.email}}.`);
  if (subject === null) throw new Error(`Zone ${title}: give the email a subject.`);
  if (body === null) throw new Error(`Zone ${title}: write what the email says.`);
  return { to, subject, body };
}

/** A tool call's settings, checked: the arguments are a JSON object. */
function validateTool(input: unknown, title: string): FlowTool {
  const raw = (input ?? {}) as Record<string, unknown>;
  const server = text(raw["server"], 64), name = text(raw["name"], 100);
  if (server === null || name === null) throw new Error(`Zone ${title}: choose the tool it uses.`);
  const args = text(raw["args"], 4000) ?? "{}";
  let parsed: unknown;
  try { parsed = JSON.parse(args); } catch { throw new Error(`Zone ${title}: the arguments aren't valid JSON.`); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Zone ${title}: the arguments are a JSON object, like {"text": "{{stage.draft}}"}.`);
  return { server, name, args };
}

/** A sort zone's settings, checked. Answers name zones by id; `ids` says which exist. */
function validateSort(input: unknown, title: string): FlowSort {
  const raw = (input ?? {}) as Record<string, unknown>;
  const question = text(raw["question"], 300);
  if (question === null) throw new Error(`Zone ${title}: write the question it sorts by.`);
  const answers = Array.isArray(raw["answers"]) ? raw["answers"] : [];
  if (answers.length < 2 || answers.length > 12) throw new Error(`Zone ${title}: give it 2 to 12 answers.`);
  const keys = new Set<string>();
  const checked = answers.map(one => {
    const answer = one as Record<string, unknown>;
    const name = text(answer["answer"], 40);
    if (name === null) throw new Error(`Zone ${title}: every answer needs a name.`);
    const means = text(answer["means"], 200) ?? name;
    const to = text(answer["to"], 32);
    if (to === null) throw new Error(`Zone ${title}: say where “${name}” goes.`);
    const key = sortKeyOf(name);
    if (keys.has(key)) throw new Error(`Zone ${title}: two answers are called ${name}.`);
    keys.add(key);
    return { answer: name, means, to };
  });
  const sureAt = typeof raw["sureAt"] === "number" && Number.isFinite(raw["sureAt"]) ? Math.round(Math.min(0.99, Math.max(0.5, raw["sureAt"])) * 100) / 100 : SORT_SURE_AT;
  const notes = Array.isArray(raw["notes"]) ? raw["notes"] : [];
  if (notes.length > 3) throw new Error(`Zone ${title}: it can note up to 3 other things.`);
  const noteIds = new Set<string>(["route"]);
  const checkedNotes = notes.map(one => {
    const note = one as Record<string, unknown>;
    const noteQuestion = text(note["question"], 300);
    if (noteQuestion === null) throw new Error(`Zone ${title}: every extra note needs a question.`);
    const kind = note["kind"] === "score" ? "score" : "yes-no";
    let id = typeof note["id"] === "string" && ID.test(note["id"]) ? note["id"] : sortKeyOf(noteQuestion).slice(0, 24);
    for (let n = 2; noteIds.has(id); n++) id = `${sortKeyOf(noteQuestion).slice(0, 20)}-${n}`;
    noteIds.add(id);
    const levels = kind === "score" ? (Array.isArray(note["levels"]) ? note["levels"] : []).map(level => text(level, 120)).filter((level): level is string => level !== null) : null;
    if (levels !== null && (levels.length < 2 || levels.length > 10)) throw new Error(`Zone ${title}: a score needs 2 to 10 levels, lowest first.`);
    return { id, kind, question: noteQuestion, levels } as FlowSortNote;
  });
  return { question, answers: checked, sureAt, notes: checkedNotes };
}

/** The longest a zone waits or a limit runs: 30 days. */
export const LONGEST_WAIT_MINUTES = 30 * 24 * 60;
const UNITS: readonly [RegExp, number][] = [[/^(m|min|mins|minute|minutes)$/, 1], [/^(h|hr|hrs|hour|hours)$/, 60], [/^(d|day|days)$/, 24 * 60], [/^(w|wk|wks|week|weeks)$/, 7 * 24 * 60]];
/** "3 days", "4 hours", "90 minutes", "1 week" (or a number of minutes) as minutes; null when it isn't one. */
export function durationMinutes(value: unknown): number | null {
  if (typeof value === "number") return Number.isInteger(value) && value >= 1 && value <= LONGEST_WAIT_MINUTES ? value : null;
  if (typeof value !== "string") return null;
  const match = /^\s*([0-9]{1,5}(?:\.[0-9]+)?)\s*([a-z]+)\s*$/i.exec(value);
  const unit = match === null ? undefined : UNITS.find(([words]) => words.test(match[2]!.toLowerCase()));
  if (match === null || unit === undefined) return null;
  const minutes = Math.round(Number(match[1]) * unit[1]);
  return minutes >= 1 && minutes <= LONGEST_WAIT_MINUTES ? minutes : null;
}
/** Minutes in the words people use: "3 days", "1 day 4 hours", "45 minutes". */
export function durationWords(minutes: number): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (minutes % (7 * 24 * 60) === 0) return plural(minutes / (7 * 24 * 60), "week");
  const days = Math.floor(minutes / (24 * 60)), hours = Math.floor((minutes % (24 * 60)) / 60), rest = minutes % 60;
  return [days > 0 ? plural(days, "day") : "", hours > 0 ? plural(hours, "hour") : "", rest > 0 ? plural(rest, "minute") : ""].filter(one => one !== "").join(" ");
}

/** A Wait zone's settings, checked. */
function validateWait(input: unknown, title: string): FlowWait {
  const raw = (input ?? {}) as Record<string, unknown>;
  if (raw["for"] === "hours") {
    const from = clockTime(raw["from"]), to = clockTime(raw["to"]);
    if (from === null || to === null || from === to) throw new Error(`Zone ${title}: say the hours it waits for, like 22:00 to 06:00.`);
    const zone = typeof raw["timeZone"] === "string" && raw["timeZone"].trim() !== "" ? raw["timeZone"].trim() : null;
    if (zone !== null && !knownTimeZone(zone)) throw new Error(`Zone ${title}: ${zone} isn't a time zone, like Europe/London.`);
    return { for: "hours", minutes: 0, from, to, ...(zone === null ? {} : { timeZone: zone }) };
  }
  const minutes = durationMinutes(raw["minutes"]);
  if (minutes === null) throw new Error(`Zone ${title}: say how long it waits, from 1 minute to 30 days.`);
  return { for: raw["for"] === "time" ? "time" : "reply", minutes };
}

/** "22:00", "9:30" as "HH:MM"; null when it isn't a time of day. */
export function clockTime(value: unknown): string | null {
  const match = typeof value === "string" ? /^\s*([01]?[0-9]|2[0-3]):([0-5][0-9])\s*$/.exec(value) : null;
  return match === null ? null : `${match[1]!.padStart(2, "0")}:${match[2]}`;
}
function knownTimeZone(zone: string): boolean {
  try { new Intl.DateTimeFormat("en-GB", { timeZone: zone }); return true; } catch { return false; }
}
/** Whether a time falls inside an "hours" wait (22:00–06:00 runs past midnight), in its time zone or this computer's. */
export function withinHours(wait: Pick<FlowWait, "from" | "to" | "timeZone">, now: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...(wait.timeZone === undefined ? {} : { timeZone: wait.timeZone }) }).formatToParts(now);
  const at = Number(parts.find(one => one.type === "hour")?.value ?? 0) * 60 + Number(parts.find(one => one.type === "minute")?.value ?? 0);
  const minutesOf = (time: string | undefined) => { const [h = "0", m = "0"] = (time ?? "00:00").split(":"); return Number(h) * 60 + Number(m); };
  const from = minutesOf(wait.from), to = minutesOf(wait.to);
  return from < to ? at >= from && at < to : at >= from || at < to;
}

/** A zone's time limit, checked; null when it has none. Only Holding and "Person decides" zones move a card on. */
function validateLimit(input: unknown, kind: FlowStageKind, title: string): FlowLimit | null {
  if (input === undefined || input === null) return null;
  const raw = input as Record<string, unknown>;
  if (kind === "wait" || kind === "done") throw new Error(`Zone ${title}: ${kind === "wait" ? "a Wait zone has its own time" : "the end has no time limit"}.`);
  const minutes = durationMinutes(raw["minutes"]);
  if (minutes === null) throw new Error(`Zone ${title}: say how long a card may wait, from 1 minute to 30 days.`);
  const to = text(raw["to"], 32);
  if (to !== null && kind !== "inbox" && kind !== "approval" && kind !== "choose") throw new Error(`Zone ${title}: only Holding, "Person decides" and "Person chooses" zones move a card on when it waits too long; other zones remind.`);
  return { minutes, to };
}

/** Who decides at an approval zone: its named person, the flow's owner, or null for anyone who approves on the project. */
export function deciderOf(stage: Pick<FlowStage, "approver" | "toOwner">, flow: { owner: string }): string | null {
  return stage.toOwner === true ? flow.owner : stage.approver;
}

/** A flow as drawn on the canvas, checked whole. Throws in plain words. */
/** `stored`: reading a flow saved earlier, which keeps working under rules added since (its cards say what's wrong). */
export function validateFlowDefinition(input: unknown, options: { stored?: boolean } = {}): FlowDefinition {
  const raw = input as { version?: unknown; start?: unknown; stages?: unknown } | null;
  if (raw === null || typeof raw !== "object" || !Array.isArray(raw.stages)) throw new Error("A flow is a list of zones.");
  if (raw.stages.length === 0 || raw.stages.length > 24) throw new Error("A flow has 1 to 24 zones.");
  const stages: FlowStage[] = raw.stages.map((one, index) => {
    const stage = one as Record<string, unknown>;
    const id = typeof stage["id"] === "string" ? stage["id"] : "";
    if (!ID.test(id)) throw new Error("Each zone needs a short id: lowercase letters, numbers and dashes.");
    const kind = stage["kind"];
    if (!FLOW_STAGE_KINDS.includes(kind as FlowStageKind)) throw new Error(`Zone ${id}: choose what it does.`);
    const title = text(stage["title"], 60);
    if (title === null) throw new Error(`Zone ${id} needs a name.`);
    const zone = (stage["zone"] ?? {}) as Record<string, unknown>;
    const color = FLOW_COLORS.includes(zone["color"] as FlowColor) ? zone["color"] as FlowColor : "slate";
    const planning = stage["planning"] === "required" || stage["planning"] === "skip" || stage["planning"] === "auto" ? stage["planning"] : null;
    return {
      id, title, kind: kind as FlowStageKind,
      zone: { x: coordinate(zone["x"], -20000, 20000, index * 320), y: coordinate(zone["y"], -20000, 20000, 0), w: coordinate(zone["w"], 220, 1200, 280), h: coordinate(zone["h"], 160, 1600, 360), color },
      instructions: text(stage["instructions"], 4000),
      planning: kind === "task" ? planning ?? "auto" : null,
      approver: kind === "approval" && stage["toOwner"] !== true ? text(stage["approver"], 64) : null,
      ...(kind === "approval" && stage["toOwner"] === true ? { toOwner: true } : {}),
      message: text(stage["message"], 1000),
      close: kind === "update" ? stage["close"] !== false : null,
      script: kind === "check" ? text(stage["script"], 40) : null,
      ...(kind === "check" ? validateCode(stage, title) : {}),
      sort: kind === "sort" ? validateSort(stage["sort"], title) : null,
      ...(kind === "request" ? { request: validateRequest(stage["request"], title) } : {}),
      ...(kind === "email" ? { email: validateEmail(stage["email"], title) } : {}),
      ...(kind === "tool" ? { tool: validateTool(stage["tool"], title) } : {}),
      ...(kind === "wait" ? { wait: validateWait(stage["wait"], title) } : {}),
      ...(kind === "pull-request" && stage["merge"] !== undefined && stage["merge"] !== null && stage["merge"] !== false ? { merge: validateMerge(stage["merge"], title) } : {}),
      ...((kind === "approval" || kind === "teammate") && stage["teammate"] !== undefined && stage["teammate"] !== null && stage["teammate"] !== "" ? { teammate: validateTeammate(stage["teammate"], title) } : {}),
      ...(kind === "teammate" ? validateRoutes(stage, title) : {}),
      ...(kind === "teammate" && stage["reply"] === true ? { reply: true } : {}),
      ...(kind === "choose" ? { options: validateChoices(stage["options"], title) } : {}),
      ...(kind === "task" && stage["repo"] !== undefined && stage["repo"] !== null && stage["repo"] !== "" ? { repo: validateRepo(stage["repo"], title) } : {}),
      ...(() => { const limit = validateLimit(stage["limit"], kind as FlowStageKind, title); return limit === null ? {} : { limit }; })(),
      next: kind === "sort" || kind === "choose" ? null : text(stage["next"], 32),
      onFail: text(stage["onFail"], 32),
    };
  });
  const ids = new Set<string>();
  for (const stage of stages) {
    if (ids.has(stage.id)) throw new Error(`Two zones are called ${stage.id}.`);
    ids.add(stage.id);
  }
  for (const stage of stages) {
    for (const target of [stage.next, stage.onFail, stage.limit?.to ?? null, ...(stage.sort?.answers.map(one => one.to) ?? []), ...(stage.routes?.map(one => one.to) ?? []), ...choiceTargets(stage)]) if (target !== null && !ids.has(target)) throw new Error(`Zone ${stage.title} points at a zone that no longer exists.`);
    if (stage.options !== undefined && ids.has(FLOW_END) && stage.options.some(one => one.to === FLOW_END)) throw new Error(`Zone ${stage.title}: an option that ends the card can't be told apart from the zone called ${FLOW_END}. Rename that zone.`);
    if (stage.options?.some(one => one.to === stage.id)) throw new Error(`Zone ${stage.title}: an option can't send cards back into the same zone.`);
    if (stage.limit?.to === stage.id) throw new Error(`Zone ${stage.title}: a card that waits too long can't move back into the same zone.`);
    if (stage.routes?.some(one => one.to === stage.id)) throw new Error(`Zone ${stage.title}: an answer can't send cards back into the same zone.`);
    if (stage.sort !== null && stage.sort.answers.some(one => one.to === stage.id)) throw new Error(`Zone ${stage.title}: an answer can't send cards back into the same zone.`);
    if ((stage.kind === "task" || stage.kind === "report") && stage.instructions === null) throw new Error(`Zone ${stage.title}: say what the agent should do.`);
    // A work zone's goal must fit a task: its own words whole, with room left for the card's details. Refused here, when the flow
    // is saved, never when a card arrives. A flow saved before this rule is still read, and its card says why it can't file.
    const over = !options.stored && (stage.kind === "task" || stage.kind === "report") && stage.instructions !== null ? flowGoalOverflow(stage.instructions) : 0;
    if (over > 0) throw new Error(`Zone ${stage.title}: its instructions leave no room for the card's details. Shorten them by ${over} characters.`);
    if (stage.kind === "draft" && stage.instructions === null) throw new Error(`Zone ${stage.title}: say what Claude should write.`);
    if (stage.kind === "notify" && stage.message === null) throw new Error(`Zone ${stage.title}: write the message to post.`);
    if (stage.kind === "check" && (stage.script === null || !SCRIPT_NAME.test(stage.script))) throw new Error(`Zone ${stage.title}: choose which script it runs.`);
    if (stage.kind === "done" && (stage.next !== null || stage.onFail !== null)) throw new Error(`Zone ${stage.title} is the end; it can't lead anywhere.`);
    if (stage.kind === "teammate" && stage.teammate === undefined) throw new Error(`Zone ${stage.title}: choose which teammate handles it.`);
  }
  const start = typeof raw.start === "string" && ids.has(raw.start) ? raw.start : stages[0]!.id;
  // A zone that merges comes after a person's decision on every path to it: never merged without one.
  const unapproved = reachableWithout(stages, start, one => one.kind === "approval");
  for (const stage of stages) {
    if (stage.merge !== undefined && unapproved.has(stage.id)) throw new Error(`Zone ${stage.title} merges, so a “Person decides” zone must come before it on every path.`);
  }
  return { version: 1, start, stages };
}

/** A Pull request zone's merge: true is squash, the default. */
function validateMerge(value: unknown, title: string): FlowMergeMethod {
  if (value === true) return "squash";
  if (typeof value === "string" && (FLOW_MERGE_METHODS as readonly string[]).includes(value)) return value as FlowMergeMethod;
  throw new Error(`Zone ${title}: merge by squash, merge or rebase.`);
}

/** The zones a card can reach from `start` without passing through a zone `stop` picks (those zones aren't included). */
export function reachableWithout(stages: readonly FlowStage[], start: string, stop: (stage: FlowStage) => boolean): Set<string> {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const id = queue.shift();
    const stage = stages.find(one => one.id === id);
    if (stage === undefined || seen.has(stage.id) || stop(stage)) continue;
    seen.add(stage.id);
    queue.push(...[stage.next, stage.onFail, stage.limit?.to ?? null, ...(stage.sort?.answers.map(one => one.to) ?? []), ...(stage.routes?.map(one => one.to) ?? []), ...choiceTargets(stage)].filter((one): one is string => one !== null));
  }
  return seen;
}

/** The zones a choose zone's options lead to (an option that ends the card leads to none). */
export function choiceTargets(stage: Pick<FlowStage, "options">): string[] {
  return (stage.options ?? []).map(one => one.to).filter(to => to !== FLOW_END);
}

/** Where a reply to a choice goes, as its {{note}}: the zone's reply path, else its first option that leads somewhere; null when none does. */
export function replyTarget(stage: Pick<FlowStage, "options" | "onFail">): string | null {
  return stage.onFail ?? choiceTargets(stage)[0] ?? null;
}

/** A choose zone's options, checked: 2 to 4, each with short words of its own and where it leads. */
function validateChoices(input: unknown, title: string): FlowChoice[] {
  const raw = Array.isArray(input) ? input : [];
  if (raw.length < CHOICES_MIN || raw.length > CHOICES_MAX) throw new Error(`Zone ${title}: give it ${CHOICES_MIN} to ${CHOICES_MAX} options.`);
  const seen = new Set<string>();
  return raw.map(one => {
    const row = (one ?? {}) as Record<string, unknown>;
    const label = text(row["label"], 40);
    const to = text(row["to"], 32);
    if (label === null || to === null) throw new Error(`Zone ${title}: each option needs a few words and where it leads.`);
    if (seen.has(label.toLowerCase())) throw new Error(`Zone ${title}: two options are called ${label}.`);
    seen.add(label.toLowerCase());
    return { label, to };
  });
}

/** A build zone's project, when it isn't the flow's: its path. Whether the flow's owner may file there is checked when work is filed. */
function validateRepo(value: unknown, title: string): string {
  const repo = text(value, 1000);
  if (repo === null) throw new Error(`Zone ${title}: choose the project it builds in.`);
  return repo;
}

/** A teammate's handle on a zone (v92): which teammate works it. Whether it exists is the project's to say, when a card arrives. */
function validateTeammate(value: unknown, title: string): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(value)) throw new Error(`Zone ${title}: choose a teammate by its short name, like maya.`);
  return value;
}

/** The answers a zone may pick, each with the zone it leads to (a script's "goto:" line, or a teammate's choice). */
function validateRoutes(stage: Record<string, unknown>, title: string): Pick<FlowStage, "routes"> {
  const rawRoutes = stage["routes"] === undefined || stage["routes"] === null ? [] : stage["routes"];
  if (!Array.isArray(rawRoutes) || rawRoutes.length > 12) throw new Error(`Zone ${title}: pick from up to 12 answers.`);
  const seen = new Set<string>();
  const routes = rawRoutes.map(one => {
    const row = (one ?? {}) as Record<string, unknown>;
    const answer = typeof row["answer"] === "string" ? row["answer"].trim() : "";
    const to = typeof row["to"] === "string" ? row["to"].trim() : "";
    if (!/^[^\n]{1,40}$/.test(answer) || to === "") throw new Error(`Zone ${title}: each answer needs a short name and the zone it leads to.`);
    if (seen.has(answer.toLowerCase())) throw new Error(`Zone ${title}: two answers are called ${answer}.`);
    seen.add(answer.toLowerCase());
    return { answer, to };
  });
  return routes.length === 0 ? {} : { routes };
}

/** A code zone's settings (v90): where it runs, its answers, and its secrets. Throws in plain words. */
function validateCode(stage: Record<string, unknown>, title: string): Pick<FlowStage, "runIn" | "routes" | "secrets"> {
  // Left out, it runs where every script ran before v90: in a copy of the card's work (and the zone's digest stays the same).
  const runIn = stage["runIn"] === "folder" || stage["runIn"] === "copy" ? stage["runIn"] : stage["runIn"] === undefined || stage["runIn"] === null ? undefined : null;
  if (runIn === null) throw new Error(`Zone ${title}: choose where the script runs: a clean folder or a copy of the card's work.`);
  const rawRoutes = stage["routes"] === undefined || stage["routes"] === null ? [] : stage["routes"];
  if (!Array.isArray(rawRoutes) || rawRoutes.length > 12) throw new Error(`Zone ${title}: a script picks from up to 12 answers.`);
  const seen = new Set<string>();
  const routes = rawRoutes.map(one => {
    const row = (one ?? {}) as Record<string, unknown>;
    const answer = typeof row["answer"] === "string" ? row["answer"].trim() : "";
    const to = typeof row["to"] === "string" ? row["to"].trim() : "";
    if (!/^[^\n]{1,40}$/.test(answer) || to === "") throw new Error(`Zone ${title}: each answer needs a short name and the zone it leads to.`);
    if (seen.has(answer.toLowerCase())) throw new Error(`Zone ${title}: two answers are called ${answer}.`);
    seen.add(answer.toLowerCase());
    return { answer, to };
  });
  const rawSecrets = stage["secrets"] === undefined || stage["secrets"] === null ? [] : stage["secrets"];
  if (!Array.isArray(rawSecrets) || rawSecrets.length > 10 || rawSecrets.some(one => typeof one !== "string" || !/^[A-Z][A-Z0-9_]{0,39}$/.test(one))) throw new Error(`Zone ${title}: name up to 10 saved secrets in capitals, like API_TOKEN.`);
  return { ...(runIn === undefined ? {} : { runIn }), ...(routes.length === 0 ? {} : { routes }), ...(rawSecrets.length === 0 ? {} : { secrets: [...new Set(rawSecrets as string[])] }) };
}

/** What a card's work is held to: the zones' steps and paths, never where they sit on the canvas. */
export function flowDigest(definition: FlowDefinition): string {
  const terms = definition.stages.map(({ zone: _zone, ...rest }) => rest);
  return createHash("sha256").update(JSON.stringify({ start: definition.start, terms })).digest("hex").slice(0, 32);
}

const FILLED = /\{\{\s*(card\.title|card\.description|card\.email|note|stage\.([a-z0-9-]+))\s*\}\}/g;
type FlowFillCard = { title: string; description: string | null; note: string | null; outputs: Record<string, string> };

/** Fill a zone's text from the card: title, description, the latest note and earlier zones' reports. */
export function fillFlowText(template: string, card: FlowFillCard, encode: (value: string) => string = value => value): string {
  return template.replace(FILLED, (_match, key: string, stage: string | undefined) => encode(fillOne(key, stage, card))).trim();
}

/** The task door's goal limit (task-text.ts). A work zone's goal is kept under it. */
export const FLOW_GOAL_LIMIT = 2000;
/** What stands in for the middle of a filled-in value the goal had no room for. */
export const FLOW_CUT = "… (cut; the full text is on the card)";
/** The least room each filled-in value keeps: the cut mark and 20 characters from each end. */
const VALUE_ROOM = FLOW_CUT.length + 40;

/** A work zone's words, plus the card and any send-back note when the words leave them out. "Fix the bug on the card"
 * says nothing on its own (found in the real e2e: the builder saw only the branch name). */
export function flowWorkTemplate(instructions: string, card: { description: string | null; note: string | null }): string {
  const names = (key: string) => new RegExp(`\\{\\{\\s*${key.replace(".", "\\.")}\\s*\\}\\}`).test(instructions);
  const extra = [
    ...(names("card.title") || names("card.description") ? [] : [`The card: {{card.title}}${card.description ? "\n\n{{card.description}}" : ""}`]),
    ...(names("card.title") && !names("card.description") && card.description ? ["Details on the card:\n{{card.description}}"] : []),
    ...(names("note") || !card.note ? [] : ["Changes asked for: {{note}}"]),
  ];
  return [instructions, ...extra].join("\n\n");
}

/** Characters a work zone's instructions leave no room for, with every filled-in value kept to its least room. 0 when they fit. */
function flowGoalOverflow(instructions: string): number {
  const widest = flowWorkTemplate(instructions, { description: "x", note: "x" });
  const values = [...widest.matchAll(FILLED)].length;
  return Math.max(0, widest.replace(FILLED, "").length + values * VALUE_ROOM - (FLOW_GOAL_LIMIT - 1));
}

/** Script output can carry carriage returns, colour codes and hidden marks a task goal refuses; the goal drops them. */
const goalSafe = (value: string) => value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "");

/** A value kept to `room` characters: its start and end, with the cut mark between. */
function cutToRoom(value: string, room: number): string {
  if (value.length <= room) return value;
  const keep = room - FLOW_CUT.length;
  let head = Math.ceil(keep / 2), from = value.length - (keep - head);
  if (/[\uD800-\uDBFF]/.test(value[head - 1] ?? "")) head--;
  if (/[\uDC00-\uDFFF]/.test(value[from] ?? "")) from++;
  return value.slice(0, head) + FLOW_CUT + value.slice(from);
}

/** A work zone's goal, filled from the card and kept under FLOW_GOAL_LIMIT: the zone's own words stay whole, and only the
 * filled-in values are shortened (the longest first), each keeping its start and end. Null when the words alone leave no
 * room, which a saved flow can't have (validateFlowDefinition). */
export function fitFlowText(template: string, card: FlowFillCard, limit = FLOW_GOAL_LIMIT): string | null {
  const values = [...template.matchAll(FILLED)].map(match => goalSafe(fillOne(match[1]!, match[2], card)));
  const room = limit - 1 - template.replace(FILLED, "").length;
  let each = Math.max(0, ...values.map(one => one.length));
  const used = (cap: number) => values.reduce((sum, one) => sum + Math.min(one.length, cap), 0);
  if (used(each) > room) {
    // The widest cap every value can share: the shortest values stay whole, the longest are cut to it.
    let low = 0, high = each;
    while (low < high) { const mid = Math.ceil((low + high) / 2); if (used(mid) <= room) low = mid; else high = mid - 1; }
    each = low;
    if (each < FLOW_CUT.length + 2) return null;
  }
  let at = 0;
  return template.replace(FILLED, () => cutToRoom(values[at++]!, each)).trim();
}

/** The first email address a card mentions, or "" — what {{card.email}} holds. */
export function cardEmailOf(card: { title: string; description: string | null }): string {
  return /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/.exec(`${card.title}\n${card.description ?? ""}`)?.[0] ?? "";
}

function fillOne(key: string, stage: string | undefined, card: { title: string; description: string | null; note: string | null; outputs: Record<string, string> }): string {
  {
    if (key === "card.title") return card.title;
    if (key === "card.description") return card.description ?? "";
    if (key === "card.email") return cardEmailOf(card);
    if (key === "note") return card.note ?? "";
    return stage === undefined ? "" : card.outputs[stage] ?? "";
  }
}

/** A step as the lead describes it, in list order. A step that keeps an
 * existing zone (by `id`) carries over whatever it leaves out. */
export type FlowStepInput = {
  id?: string; title?: string; kind?: FlowStageKind;
  instructions?: string; planning?: "auto" | "required" | "skip"; decider?: string | null; message?: string;
  script?: string; close?: boolean;
  /** check (v90): "folder" (a clean folder) or "copy" (a copy of the card's work); the answers a "goto:" line picks, each with the step it goes to; saved secrets it gets. */
  runIn?: "folder" | "copy"; routes?: { answer?: string; goesTo?: string }[]; secrets?: string[];
  /** sort: the question, each answer with what it means and the step it goes to, how sure Jev must be (a percentage), and up to 3 other things to note. */
  question?: string; answers?: { answer?: string; means?: string; goesTo?: string }[]; sureAt?: number;
  alsoNote?: { question?: string; kind?: "score" | "yes-no"; levels?: string[] }[];
  /** request: method, address, headers and body; email: to, subject, body; tool: the tool (server), its function (tool) and arguments. */
  method?: FlowRequest["method"]; url?: string; headers?: Record<string, string>; body?: string;
  to?: string; subject?: string;
  server?: string; tool?: string; args?: Record<string, unknown> | string;
  /** wait (v91): for a reply (the default) or a set time, and how long ("3 days"); where a card goes when no reply comes.
   * "hours": until the clock is between `from` and `until` ("22:00", "06:00"). */
  waitFor?: "reply" | "time" | "hours"; wait?: string | number; ifNoReply?: string; from?: string; until?: string;
  /** pull-request: merge once checks pass (true is squash). Needs a decision before it. */
  merge?: boolean | FlowMergeMethod;
  /** Any step but wait and done (v91): remind after this long ("2 days"; "none" removes it), and on holding and approval steps, move the card to this step then. */
  remindAfter?: string | number; thenMoveTo?: string;
  /** v92: the AI teammate (by name) who decides an approval step (handing hard ones to its decider) or handles a teammate step. */
  teammate?: string;
  /** v96: a teammate step sends what it writes back to whoever asked. */
  reply?: boolean;
  /** choose: 2 to 4 buttons, each with its words and the step it goes to ("end" ignores the card); where a reply goes instead
   * (the reply is its {{note}}; the nearest earlier build or research step when left out). ifNoReply (with remindAfter) moves it on. */
  options?: { label?: string; goesTo?: string }[]; ifReplied?: string;
  /** task: the project it builds in (path), when not the flow's own. */
  repo?: string;
  next?: string; ifFails?: string; ifNotSure?: string;
};

const KIND_COLORS: Record<FlowStageKind, FlowColor> = { inbox: "slate", task: "blue", report: "violet", approval: "amber", check: "blue", "pull-request": "blue", update: "green", notify: "green", sort: "violet", draft: "violet", request: "blue", email: "green", tool: "blue", wait: "slate", teammate: "violet", send: "green", choose: "amber", done: "green" };
/** A step id as the lead may write it (sort_by_hand, Sort-By-Hand) in the one form zones use. */
const idOf = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
const slugOf = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28) || "zone";
const overlaps = (a: FlowZone, b: FlowZone) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** A wait step's settings: what it waits for and how long (3 days when neither the step nor the zone it keeps says). */
function waitFromStep(step: FlowStepInput, old: FlowWait | null, title: string): FlowWait {
  if ((step.waitFor ?? old?.for) === "hours") {
    const from = clockTime(step.from ?? old?.from ?? "22:00"), to = clockTime(step.until ?? old?.to ?? "06:00");
    if (from === null || to === null) throw new Error(`Step ${title}: say the hours it waits for, like from 22:00 until 06:00.`);
    return { for: "hours", minutes: 0, from, to, ...(old?.timeZone === undefined ? {} : { timeZone: old.timeZone }) };
  }
  const minutes = step.wait === undefined ? old?.minutes ?? 3 * 24 * 60 : durationMinutes(step.wait);
  if (minutes === null) throw new Error(`Step ${title}: say how long it waits, like "3 days" or "4 hours" (up to 30 days).`);
  return { for: step.waitFor ?? old?.for ?? "reply", minutes };
}

/** A step's time limit: the one it gives, the one its zone had, or none ("none" removes one). */
function limitFromStep(step: FlowStepInput, old: FlowLimit | null, title: string, find: (ref: string) => string): FlowLimit | null {
  if (step.remindAfter === undefined) return old === null ? null : { ...old, ...(step.thenMoveTo === undefined ? {} : { to: step.thenMoveTo.trim() === "" ? null : find(step.thenMoveTo) }) };
  if (typeof step.remindAfter === "string" && /^\s*(none|never|no|off)?\s*$/i.test(step.remindAfter)) return null;
  const minutes = durationMinutes(step.remindAfter);
  if (minutes === null) throw new Error(`Step ${title}: say when to remind, like "2 days" (up to 30 days).`);
  return { minutes, to: typeof step.thenMoveTo === "string" && step.thenMoveTo.trim() !== "" ? find(step.thenMoveTo) : step.thenMoveTo === undefined ? old?.to ?? null : null };
}

/** What a draft zone asks for when the steps leave it out. */
export const DRAFT_DEFAULT = "Write a short, friendly reply to the person who sent this card, in plain words.";

/** What an agent is asked when the steps leave it out: the card, any send-back note, and every earlier research step's report. */
function defaultInstructions(kind: "task" | "report", earlier: readonly FlowStage[]): string {
  const notes = earlier.filter(one => one.kind === "report").map(one => `\n\nNotes from ${one.title}:\n{{stage.${one.id}}}`).join("");
  return kind === "task"
    ? `{{card.title}}\n\n{{card.description}}${notes}\n\nChanges asked for (if any): {{note}}`
    : `Investigate this and write a short, clear report with a summary first: {{card.title}}\n\n{{card.description}}${notes}\n\nFeedback to address (if any): {{note}}`;
}

/** Steps as the lead's flow tool and `toolroll flows` take them: "me" as a decider is the person asking, stored by name. */
export function stepsFor(steps: unknown, name: string): unknown {
  return Array.isArray(steps) ? steps.map(step => step !== null && typeof step === "object" && typeof (step as FlowStepInput).decider === "string" && /^(me|myself|i|you|the operator)$/i.test((step as FlowStepInput).decider!.trim()) ? { ...step, decider: name } : step) : steps;
}

/**
 * A flow from an ordered list of steps: ids from names, each step leading
 * to the next, a Done zone at the end when none is listed, and a decision
 * sending work back to the nearest earlier step that does work. New zones
 * are laid out in rows; zones kept from `previous` keep their place.
 */
export function flowFromSteps(input: unknown, previous: FlowDefinition | null = null): FlowDefinition {
  if (!Array.isArray(input) || input.length === 0) throw new Error("List the flow's steps in order.");
  if (input.length > 24) throw new Error("A flow has 1 to 24 steps.");
  const kept = new Map((previous?.stages ?? []).map(one => [one.id, one]));
  const used = new Set<string>();
  const drafts = input.map((raw, index) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Step ${index + 1} isn't a step.`);
    const step = raw as FlowStepInput;
    const asked = typeof step.id === "string" ? idOf(step.id) : "";
    const old = asked !== "" && !used.has(asked) ? kept.get(asked) ?? null : null;
    const title = typeof step.title === "string" && step.title.trim() !== "" ? step.title.trim() : old?.title ?? "";
    if (title === "") throw new Error(`Step ${index + 1} needs a name.`);
    const kind = step.kind ?? old?.kind;
    if (!FLOW_STAGE_KINDS.includes(kind as FlowStageKind)) throw new Error(`Step ${title}: choose what it does.`);
    // A new step keeps an id it is given (so the other steps can point at it by that id); otherwise its name makes one.
    const given = ID.test(asked) && !used.has(asked) ? asked : null;
    let id = old?.id ?? given ?? slugOf(title);
    for (let n = 2; old === null && used.has(id); n++) id = `${slugOf(title).slice(0, 25)}-${n}`;
    used.add(id);
    const same = old !== null && old.kind === kind;
    return { step, old: same ? old : null, id, title, kind: kind as FlowStageKind };
  });
  if (!drafts.some(one => one.kind === "done")) {
    let id = "done";
    for (let n = 2; used.has(id); n++) id = `done-${n}`;
    drafts.push({ step: {}, old: kept.get(id)?.kind === "done" ? kept.get(id)! : null, id, title: "Done", kind: "done" });
  }
  const find = (ref: string, from: string): string => {
    const wanted = ref.trim().toLowerCase();
    const hit = drafts.find(one => one.id === ref.trim() || one.id === idOf(ref) || one.title.toLowerCase() === wanted);
    if (hit === undefined) throw new Error(`Step ${from}: there's no step called ${ref}.`);
    return hit.id;
  };
  const stages: FlowStage[] = [];
  drafts.forEach(({ step, old, id, title, kind }, index) => {
    const earlier = stages.slice();
    const following = drafts.slice(index + 1).find(() => true) ?? null;
    const next = kind === "done" || kind === "sort" || kind === "choose" ? null
      : typeof step.next === "string" && step.next.trim() !== "" ? find(step.next, title)
      : following?.id ?? drafts.find(one => one.kind === "done")!.id;
    const keptFail = old?.onFail !== null && old?.onFail !== undefined && drafts.some(one => one.id === old.onFail) ? old.onFail : null;
    const worker = [...earlier].reverse().find(one => one.kind === "task" || one.kind === "report");
    const notSure = kind === "sort" && typeof step.ifNotSure === "string" && step.ifNotSure.trim() !== "" ? step.ifNotSure
      : kind === "wait" && typeof step.ifNoReply === "string" && step.ifNoReply.trim() !== "" ? step.ifNoReply
      : kind === "choose" ? step.ifReplied : step.ifFails;
    const onFail = kind === "done" ? null
      : typeof notSure === "string" && notSure.trim() !== "" ? find(notSure, title)
      : keptFail ?? (kind === "approval" ? worker?.id ?? (drafts[0]!.id === id ? null : drafts[0]!.id)
        // A reply to a choice says what to change: it goes back to the work before it, as its note.
        : kind === "choose" ? worker?.id ?? null
        // Red CI goes back to the build before it, carrying the failing check.
        : kind === "pull-request" ? [...earlier].reverse().find(one => one.kind === "task")?.id ?? null : null);
    // "owner": whoever owns the flow when the card arrives.
    const toOwner = kind === "approval" && (step.decider === undefined ? old?.toOwner === true : typeof step.decider === "string" && /^(owner|the owner|flow owner|the flow owner|the flow's owner)$/i.test(step.decider.trim()));
    const approver = kind !== "approval" || toOwner ? null
      : step.decider === undefined ? old?.approver ?? null
      : step.decider === null || /^(anyone|any approver|anybody)$/i.test(step.decider.trim()) ? null : step.decider.trim();
    stages.push({
      id, title, kind,
      zone: old?.zone ?? { x: 0, y: 0, w: 260, h: kind === "done" || kind === "notify" || kind === "send" ? 220 : 300, color: KIND_COLORS[kind] },
      // A kept step on our default instructions gets the default again, so it reads any research step added before it.
      instructions: kind === "teammate" ? step.instructions?.trim() || old?.instructions || "Read the card and decide what happens next."
        : kind === "draft" ? step.instructions?.trim() || old?.instructions || DRAFT_DEFAULT
        : kind === "task" || kind === "report"
        ? step.instructions?.trim() || (old?.instructions && old.instructions !== defaultInstructions(kind, previous!.stages.slice(0, previous!.stages.indexOf(old))) ? old.instructions : defaultInstructions(kind, earlier))
        : null,
      planning: kind === "task" ? step.planning ?? old?.planning ?? "auto" : null,
      approver,
      ...(toOwner ? { toOwner: true } : {}),
      message: kind === "notify" ? step.message?.trim() || old?.message || (drafts.find(one => one.id === next)?.kind === "done" ? "Finished: {{card.title}}" : "Update on {{card.title}}")
        : kind === "update" ? step.message?.trim() || old?.message || "Done: {{card.title}}" : null,
      close: kind === "update" ? step.close ?? old?.close ?? true : null,
      script: kind === "check" ? step.script?.trim() || old?.script || null : null,
      // Left out, a code step runs in a copy of the project (the card's work, or the main branch), as scripts always have.
      ...(kind === "check" ? {
        ...(step.runIn !== undefined ? { runIn: step.runIn } : old?.runIn === undefined ? {} : { runIn: old.runIn }),
        ...(step.routes !== undefined ? step.routes.length === 0 ? {} : { routes: step.routes.map(one => ({ answer: String(one.answer ?? "").trim(), to: find(String(one.goesTo ?? ""), title) })) } : old?.routes === undefined ? {} : { routes: old.routes }),
        ...(step.secrets !== undefined ? step.secrets.length === 0 ? {} : { secrets: step.secrets } : old?.secrets === undefined ? {} : { secrets: old.secrets }),
      } : {}),
      sort: kind === "sort" ? sortFromStep(step, old?.sort ?? null, ref => find(ref, title)) : null,
      ...(kind === "request" ? { request: { method: step.method ?? old?.request?.method ?? "POST", url: step.url ?? old?.request?.url ?? "", headers: step.headers ?? old?.request?.headers ?? {}, body: step.body ?? old?.request?.body ?? null } } : {}),
      ...(kind === "email" ? { email: { to: step.to ?? old?.email?.to ?? "{{card.email}}", subject: step.subject ?? old?.email?.subject ?? "Re: {{card.title}}", body: step.body ?? old?.email?.body ?? "" } } : {}),
      ...(kind === "tool" ? { tool: { server: step.server ?? old?.tool?.server ?? "", name: step.tool ?? old?.tool?.name ?? "", args: typeof step.args === "string" ? step.args : step.args !== undefined ? JSON.stringify(step.args) : old?.tool?.args ?? "{}" } } : {}),
      ...(kind === "wait" ? { wait: waitFromStep(step, old?.wait ?? null, title) } : {}),
      ...(kind === "pull-request" && (step.merge === undefined ? old?.merge !== undefined : step.merge !== false) ? { merge: step.merge === undefined || step.merge === true || step.merge === false ? old?.merge ?? "squash" : step.merge } : {}),
      // v92: "nobody" (or "none") takes a teammate off an approval step.
      ...((kind === "approval" || kind === "teammate") && (step.teammate === undefined ? old?.teammate !== undefined : !/^(nobody|none|no one)$/i.test(step.teammate.trim())) ? { teammate: idOf(step.teammate ?? old!.teammate!) } : {}),
      ...(kind === "teammate" ? step.routes !== undefined ? step.routes.length === 0 ? {} : { routes: step.routes.map(one => ({ answer: String(one.answer ?? "").trim(), to: find(String(one.goesTo ?? ""), title) })) } : old?.routes === undefined ? {} : { routes: old.routes } : {}),
      ...(kind === "teammate" && (step.reply ?? old?.reply) === true ? { reply: true } : {}),
      ...(kind === "choose" ? { options: choicesFromStep(step, old?.options ?? null, title, ref => find(ref, title)) } : {}),
      ...(kind === "task" && (step.repo ?? old?.repo) !== undefined && (step.repo ?? old?.repo)!.trim() !== "" ? { repo: (step.repo ?? old?.repo)!.trim() } : {}),
      ...(() => {
        // "If no reply" on a choice is where it moves once the reminder comes.
        const asked = kind === "choose" && step.thenMoveTo === undefined && typeof step.ifNoReply === "string" ? { ...step, thenMoveTo: step.ifNoReply } : step;
        if (kind === "choose" && asked.thenMoveTo !== undefined && asked.remindAfter === undefined && old?.limit === undefined) throw new Error(`Step ${title}: say how long to wait for a choice first, with remindAfter (like "2 days").`);
        const limit = kind === "wait" || kind === "done" ? null : limitFromStep(asked, old?.limit ?? null, title, ref => find(ref, title)); return limit === null ? {} : { limit };
      })(),
      next, onFail,
    });
  });
  // {{stage.<ref>}} in a step's words names a step as the lead wrote it (draftReply, Draft reply):
  // it is rewritten to that step's id, the same way the steps themselves are named.
  const refs = (text: string) => text.replace(/\{\{\s*stage\.([A-Za-z0-9_ -]{1,60}?)\s*\}\}/g, (whole, ref: string) => {
    const hit = drafts.find(one => one.id === ref) ?? drafts.find(one => one.id === idOf(ref) || one.id.replace(/-/g, "") === idOf(ref).replace(/-/g, "") || one.title.toLowerCase() === ref.trim().toLowerCase());
    return hit === undefined ? whole : `{{stage.${hit.id}}}`;
  });
  for (const stage of stages) {
    if (stage.instructions !== null) stage.instructions = refs(stage.instructions);
    if (stage.message !== null) stage.message = refs(stage.message);
    if (stage.email !== undefined) stage.email = { to: refs(stage.email.to), subject: refs(stage.email.subject), body: refs(stage.email.body) };
    if (stage.request !== undefined) stage.request = { ...stage.request, url: refs(stage.request.url), headers: Object.fromEntries(Object.entries(stage.request.headers).map(([key, value]) => [key, refs(value)])), body: stage.request.body === null ? null : refs(stage.request.body) };
    if (stage.tool !== undefined) stage.tool = { ...stage.tool, args: refs(stage.tool.args) };
  }
  // Lay out the new zones: in rows of four on a new flow, beside the step before them on an edited one.
  // A new flow that branches (a sort, or a script's answers) is laid out in columns by step instead,
  // each branch below the one before, so no arrow crosses a zone.
  const placed = stages.filter(one => kept.get(one.id)?.zone === one.zone).map(one => one.zone);
  const branches = previous === null && stages.some(one => (one.sort?.answers.length ?? 0) > 0 || (one.routes?.length ?? 0) > 0 || choiceTargets(one).length > 0);
  const columns = new Map<string, number>();
  if (branches) {
    const queue = [stages[0]!.id];
    columns.set(stages[0]!.id, 0);
    while (queue.length > 0) {
      const id = queue.shift()!, stage = stages.find(one => one.id === id)!;
      for (const to of [...(stage.sort?.answers.map(one => one.to) ?? []), ...(stage.routes?.map(one => one.to) ?? []), ...choiceTargets(stage), stage.next, stage.onFail]) {
        if (to === null || to === "" || columns.has(to)) continue;
        columns.set(to, columns.get(id)! + 1);
        queue.push(to);
      }
    }
    for (const stage of stages) if (!columns.has(stage.id)) columns.set(stage.id, Math.max(0, ...columns.values()) + 1);
  }
  const rows = new Map<number, number>();
  stages.forEach((stage, index) => {
    if (placed.includes(stage.zone)) return;
    let at: FlowZone;
    if (branches) {
      const column = columns.get(stage.id)!, row = rows.get(column) ?? 0;
      rows.set(column, row + 1);
      at = { ...stage.zone, x: column * 360, y: row * 380 };
    } else if (previous === null) {
      const row = Math.floor(index / 4), column = index % 4;
      at = { ...stage.zone, x: (row % 2 === 0 ? column : 3 - column) * 300, y: row * 380 };
    } else {
      const before = index > 0 ? stages[index - 1]!.zone : null;
      at = { ...stage.zone, x: before === null ? 0 : before.x + 300, y: before === null ? Math.max(0, ...placed.map(one => one.y + one.h + 80)) : before.y };
      for (let tries = 0; tries < 40 && placed.some(one => overlaps(one, at)); tries++) at = { ...at, y: at.y + 380 };
    }
    stage.zone = at;
    placed.push(at);
  });
  return validateFlowDefinition({ version: 1, start: stages[0]!.id, stages });
}

/** A choose step's options: each with its words and the step it goes to ("end", or no step, ignores the card); kept ones carry over. */
function choicesFromStep(step: FlowStepInput, old: FlowChoice[] | null, title: string, find: (ref: string) => string): FlowChoice[] {
  if (!Array.isArray(step.options) || step.options.length === 0) {
    if (old !== null) return old;
    throw new Error(`Step ${title}: give it ${CHOICES_MIN} to ${CHOICES_MAX} options, each with a label and the step it goes to (or "end").`);
  }
  return step.options.map(one => {
    const label = String(one?.label ?? "").trim();
    const goes = typeof one?.goesTo === "string" ? one.goesTo.trim() : "";
    return { label, to: goes === "" || /^(end|ignore|ignored|stop|close)$/i.test(goes) ? FLOW_END : find(goes) };
  });
}

/** A sort step as the lead describes it: answers name the steps they go to; what it leaves out carries over from the zone it keeps. */
function sortFromStep(step: FlowStepInput, old: FlowSort | null, find: (ref: string) => string): FlowSort {
  const answers = Array.isArray(step.answers) && step.answers.length > 0
    ? step.answers.map(one => ({ answer: String(one?.answer ?? "").trim(), means: String(one?.means ?? "").trim() || String(one?.answer ?? "").trim(), to: typeof one?.goesTo === "string" && one.goesTo.trim() !== "" ? find(one.goesTo) : "" }))
    : old?.answers ?? [];
  // A percentage (80) or a fraction (0.8).
  const sure = typeof step.sureAt === "number" && Number.isFinite(step.sureAt) ? (step.sureAt > 1 ? step.sureAt / 100 : step.sureAt) : old?.sureAt ?? SORT_SURE_AT;
  const notes = Array.isArray(step.alsoNote) ? step.alsoNote.map(one => ({ id: "", kind: one?.kind === "score" ? "score" as const : "yes-no" as const, question: String(one?.question ?? "").trim(), levels: one?.kind === "score" ? (one.levels ?? []).map(String) : null }))
    : old?.notes ?? [];
  return { question: step.question?.trim() || old?.question || "", answers, sureAt: sure, notes };
}

/** What confirming a new or changed flow means, in the canvas's words: each step's job and path, what changed, and that the usual approvals still apply. */
export function flowTerms(definition: FlowDefinition, previous: FlowDefinition | null): string[] {
  const titleOf = (id: string | null) => definition.stages.find(one => one.id === id)?.title ?? "nowhere";
  // "Then → Go ahead?" ends a sentence already.
  const to = (id: string | null) => { const title = titleOf(id); return /[.?!]$/.test(title) ? title : `${title}.`; };
  // Fill-ins read as what they will hold.
  const plain = (text: string) => text.replace(/\{\{\s*(card\.title|card\.description|card\.email|note|stage\.([a-z0-9-]+))\s*\}\}/g, (_match, key: string, stage: string | undefined) =>
    key === "card.title" ? "[card title]" : key === "card.description" ? "[card details]" : key === "card.email" ? "[the card's email address]" : key === "note" ? "[send-back note]" : `[${titleOf(stage ?? null)} report]`);
  const same = (a: FlowStage, b: FlowStage) => JSON.stringify({ ...a, zone: null }) === JSON.stringify({ ...b, zone: null });
  const describe = (stage: FlowStage, index: number, mark: string): string => {
    const lines = [`${index + 1}. ${stage.title} — ${FLOW_KIND_WORDS[stage.kind].label}${mark}`];
    if (stage.kind === "task" || stage.kind === "report") {
      // Instructions the steps left to us are said in words; the operator's own are shown as written.
      const earlier = definition.stages.slice(0, index);
      const reports = earlier.filter(one => one.kind === "report").map(one => one.title);
      const notes = reports.length === 0 ? "" : `, using the notes from ${reports.join(" and ")}`;
      lines.push(stage.instructions !== defaultInstructions(stage.kind, earlier) ? `The agent is asked: ${plain(stage.instructions ?? "")}`
        : stage.kind === "task" ? `The agent builds what the card asks${notes}, plus any note it was sent back with.`
        : `The agent looks into the card and writes a short report${notes}, plus any note it was sent back with.`);
    }
    if (stage.kind === "task" && stage.planning !== "auto") lines.push(stage.planning === "required" ? "Plans first." : "Builds without a plan.");
    if (stage.kind === "task" && stage.repo !== undefined) lines.push(`Builds in another project: ${stage.repo}`);
    if (stage.kind === "draft") lines.push(`Claude writes: ${plain(stage.instructions ?? "")}`, `Then → ${to(stage.next)}`);
    else if (stage.kind === "request" && stage.request !== undefined) {
      const headers = Object.keys(stage.request.headers);
      lines.push(`Calls ${stage.request.method} ${plain(stage.request.url)}${headers.length === 0 ? "" : ` with the ${headers.join(", ")} header${headers.length === 1 ? "" : "s"}`}${stage.request.body === null ? "" : `, sending: ${plain(stage.request.body).slice(0, 300)}`}`,
        `Then → ${to(stage.next)}${stage.onFail === null ? " If it fails → waits there." : ` If it fails → ${to(stage.onFail)}`}`);
    }
    else if (stage.kind === "email" && stage.email !== undefined) lines.push(`Emails ${plain(stage.email.to)}: “${plain(stage.email.subject)}”`, plain(stage.email.body).slice(0, 400),
      `Then → ${to(stage.next)}${stage.onFail === null ? " If it can't be sent → waits there." : ` If it can't be sent → ${to(stage.onFail)}`}`);
    else if (stage.kind === "tool" && stage.tool !== undefined) lines.push(`Uses ${stage.tool.server} → ${stage.tool.name} with ${plain(stage.tool.args).slice(0, 400)}`,
      `Then → ${to(stage.next)}${stage.onFail === null ? " If it fails → waits there." : ` If it fails → ${to(stage.onFail)}`}`);
    else if (stage.kind === "approval") lines.push(`Decides: ${stage.teammate !== undefined ? `the AI teammate ${stage.teammate}, within its rules, handing hard ones to ${stage.toOwner === true ? "the flow's owner" : stage.approver ?? "anyone who approves"}` : stage.toOwner === true ? "the flow's owner, in their chat app" : stage.approver ?? "anyone who approves on this project"}. Approve → ${to(stage.next)} Send back → ${stage.onFail === null ? "not possible." : to(stage.onFail)}`);
    else if (stage.kind === "teammate") lines.push(`The AI teammate ${stage.teammate ?? "(none)"} handles it${stage.instructions === null ? "" : `: ${plain(stage.instructions)}`}`,
      ...(stage.routes === undefined || stage.routes.length === 0 ? [`Then → ${to(stage.next)}`] : stage.routes.map(one => `${one.answer} → ${to(one.to)}`)),
      `It asks the flow's owner when its rules say to.${stage.reply === true ? " It sends what it writes back to whoever asked." : ""}${stage.onFail === null ? "" : ` If it can't → ${to(stage.onFail)}`}`);
    else if (stage.kind === "notify") lines.push(`Posts: ${plain(stage.message ?? "")}`, `Then → ${to(stage.next)}`);
    else if (stage.kind === "send") lines.push("Sends the card's owner (or the flow's) what the step before produced: its summary, links and any screenshots, in each chat app they use.", `Then → ${to(stage.next)}`);
    else if (stage.kind === "choose") lines.push("Sends the card's owner (or the flow's) what the step before produced, and asks them to choose:",
      ...(stage.options ?? []).map(one => `${one.label} → ${one.to === FLOW_END ? "ignores the card." : to(one.to)}`),
      `Or a reply with what they'd change → ${replyTarget(stage) === null ? "not possible." : to(replyTarget(stage))}`);
    else if (stage.kind === "update") lines.push(`Comments on the issue the card came from: ${plain(stage.message ?? "")}${stage.close === true ? " Then closes it (Linear: moves it to done)." : ""}`, `Then → ${to(stage.next)}${stage.onFail === null ? "" : ` If it can't → ${to(stage.onFail)}`}`);
    else if (stage.kind === "sort" && stage.sort !== null) {
      const percent = Math.round(stage.sort.sureAt * 100);
      lines.push(`Jev asks: ${stage.sort.question}`, ...stage.sort.answers.map(one => `${one.answer} → ${to(one.to)}`),
        `Less than ${percent}% sure → ${stage.onFail === null ? "waits here for a person." : to(stage.onFail)}`);
      if (stage.sort.notes.length > 0) lines.push(`Also notes: ${stage.sort.notes.map(one => one.kind === "score" ? `${one.question} (${one.levels?.join(" / ")})` : `${one.question} (yes or no)`).join("; ")}`);
    }
    else if (stage.kind === "pull-request") {
      const approval = [...definition.stages.slice(0, index)].reverse().find(one => one.kind === "approval");
      lines.push("Opens a pull request for the card's built result, then waits for CI.",
        `Checks pass → ${stage.merge === undefined ? to(stage.next) : `merges it (${stage.merge}) and deletes its branch, only when a person approved it${approval === undefined ? "" : ` at ${approval.title}`} since it was built. Then → ${to(stage.next)}`}`,
        `Checks fail → ${stage.onFail === null ? "waits there, naming the failing check." : `${to(stage.onFail)} The failing check is named on the card.`}`);
    }
    else if (stage.kind === "check") lines.push(`Runs the project's script “${stage.script}” with no AI.`, `Passes → ${to(stage.next)}${stage.onFail === null ? " Fails → waits there." : ` Fails → ${to(stage.onFail)}`}`);
    else if (stage.kind === "wait" && stage.wait !== undefined) lines.push(stage.wait.for === "hours" ? `Waits until it's between ${stage.wait.from} and ${stage.wait.to}${stage.wait.timeZone === undefined ? "" : ` (${stage.wait.timeZone})`}; cards that arrive then go straight on. Then → ${to(stage.next)}`
      : stage.wait.for === "time" ? `Waits ${durationWords(stage.wait.minutes)}. Then → ${to(stage.next)}`
      : `Waits up to ${durationWords(stage.wait.minutes)} for a reply to the card's email, from someone it was sent to. Reply → ${to(stage.next)} No reply → ${stage.onFail === null ? "stays there for a person." : to(stage.onFail)}`);
    else if (stage.next !== null) lines.push(`Then → ${to(stage.next)}${stage.onFail === null ? "" : ` If it fails → ${to(stage.onFail)}`}`);
    if (stage.limit !== undefined) lines.push(`After ${durationWords(stage.limit.minutes)} there: reminds ${stage.kind === "approval" ? "whoever decides" : "the card's owner"}${stage.limit.to === null ? "." : `, and moves it to ${to(stage.limit.to)}`}`);
    return lines.join("\n");
  };
  const terms: string[] = [];
  if (previous === null) terms.push(...definition.stages.map((stage, index) => describe(stage, index, "")));
  else {
    terms.push(`Steps: ${definition.stages.map(one => one.title).join(" → ")}`);
    definition.stages.forEach((stage, index) => {
      const old = previous.stages.find(one => one.id === stage.id);
      if (old === undefined || !same(old, stage)) terms.push(describe(stage, index, old === undefined ? " (new)" : " (changed)"));
    });
    const removed = previous.stages.filter(one => !definition.stages.some(stage => stage.id === one.id));
    if (removed.length > 0) terms.push(`Removes ${removed.map(one => one.title).join(", ")}. Any cards there go back to ${titleOf(definition.start)}.`);
  }
  // New cards that start in a holding zone aren't sorted until someone moves them to the sort: say so before it's confirmed.
  const first = definition.stages.find(one => one.id === definition.start);
  const sorter = definition.stages.find(one => one.kind === "sort");
  if (first?.kind === "inbox" && sorter !== undefined) terms.push(`New cards wait in ${first.title}, so ${sorter.title} only sorts the cards someone moves there.`);
  terms.push("Build and research steps become ordinary tasks, so your usual approvals and checks apply.");
  if (definition.stages.some(one => one.kind === "sort")) terms.push("Sort steps send each card's title, details and earlier notes to Jev through your OpenRouter account.");
  if (definition.stages.some(one => one.kind === "request" || one.kind === "email" || one.kind === "tool")) terms.push("Web request, email and tool steps send what they're given outside this computer, with no one checking unless a decision comes before them.");
  if (definition.stages.some(one => one.kind === "pull-request")) terms.push(`Pull request steps push the card's branch to GitHub and open a pull request under this project's pull request setup.${definition.stages.some(one => one.merge !== undefined) ? " A merge happens only after a person approves the card; nothing merges without one." : " Nothing merges on its own."}`);
  if (definition.stages.some(one => one.kind === "draft")) terms.push("Draft steps send each card's text to Claude through the lead chat's sign-in. Nothing a draft writes is sent until a later step sends it.");
  if (definition.stages.some(one => one.kind === "task" && one.repo !== undefined)) terms.push("A build step in another project files its task there, only when the flow's owner may file work in that project.");
  if (definition.stages.some(one => one.teammate !== undefined)) terms.push("AI teammates decide and act within their soul files' rules, reading each card through Claude on this computer's sign-in; they never approve code tasks or merges.");
  return terms;
}

const zone = (x: number, y: number, color: FlowColor, h = 300): FlowZone => ({ x, y, w: 260, h, color });
const stage = (id: string, title: string, kind: FlowStageKind, at: FlowZone, rest: Partial<FlowStage> = {}): FlowStage =>
  ({ id, title, kind, zone: at, instructions: null, planning: kind === "task" ? "auto" : null, approver: null, message: null, close: kind === "update" ? true : null, script: null, sort: null, next: null, onFail: null, ...rest });

/** The label an issue gets to become work: what the Issues to PRs template and the issue starter flow watch for. */
export const ISSUE_LABEL = "toolroll";

/** Ready-made flows: the coding flow is the whole business process around a change. A template's `trigger`
 * (a trigger's settings, as flow-triggers.ts reads them) is added with it. */
export const FLOW_TEMPLATES: readonly { id: string; label: string; about: string; definition: FlowDefinition; trigger?: Record<string, unknown> }[] = [
  {
    id: "coding",
    label: "Coding flow",
    about: "Triage, plan, build, review by a person, then tell the team.",
    definition: {
      version: 1,
      start: "inbox",
      stages: [
        stage("inbox", "Inbox", "inbox", zone(0, 0, "slate"), { next: "triage" }),
        stage("triage", "Triage", "report", zone(300, 0, "violet"), {
          instructions: "Investigate this request in the repository and write a short triage: what is being asked, where in the code it lands, the risks, and a rough size.\n\nRequest: {{card.title}}\n{{card.description}}",
          next: "go-ahead",
        }),
        stage("go-ahead", "Go ahead?", "approval", zone(600, 0, "amber"), { toOwner: true, next: "build", onFail: "inbox" }),
        stage("build", "Build", "task", zone(900, 0, "blue"), {
          instructions: "{{card.title}}\n\n{{card.description}}\n\nTriage notes:\n{{stage.triage}}\n\nRequested changes (if any): {{note}}",
          next: "review",
        }),
        stage("review", "Review", "approval", zone(900, 380, "amber"), { toOwner: true, next: "announce", onFail: "build" }),
        stage("announce", "Tell the team", "notify", zone(600, 380, "green", 220), { message: "Shipped: {{card.title}}", next: "done" }),
        stage("done", "Done", "done", zone(300, 380, "green", 220)),
      ],
    },
  },
  {
    id: "issues-to-prs",
    label: "Issues to PRs",
    about: `GitHub issues labelled “${ISSUE_LABEL}” are built, a person approves, a pull request opens and waits for CI, then the issue gets a comment and is closed. Nothing merges on its own.`,
    trigger: { kind: "github", watch: "issues", label: ISSUE_LABEL },
    definition: {
      version: 1,
      start: "build",
      stages: [
        stage("build", "Build", "task", zone(0, 0, "blue"), { instructions: "{{card.title}}\n\n{{card.description}}\n\nChanges asked for (if any): {{note}}", next: "approve" }),
        stage("approve", "Approve", "approval", zone(300, 0, "amber"), { toOwner: true, next: "pull-request", onFail: "build" }),
        stage("pull-request", "Pull request", "pull-request", zone(600, 0, "blue"), { next: "update-issue", onFail: "build" }),
        stage("update-issue", "Update the issue", "update", zone(900, 0, "green", 220), { message: "Done: {{card.title}}. {{stage.pull-request}}", next: "done" }),
        stage("done", "Done", "done", zone(900, 280, "green", 220)),
      ],
    },
  },
  {
    id: "research",
    label: "Research flow",
    about: "Research a question, have a person check it, then share it.",
    definition: {
      version: 1,
      start: "inbox",
      stages: [
        stage("inbox", "Questions", "inbox", zone(0, 0, "slate"), { next: "research" }),
        stage("research", "Research", "report", zone(300, 0, "violet"), {
          instructions: "Research this and write a clear, sourced answer with a short summary first.\n\nQuestion: {{card.title}}\n{{card.description}}\n\nFeedback to address (if any): {{note}}",
          next: "check",
        }),
        stage("check", "Check", "approval", zone(600, 0, "amber"), { toOwner: true, next: "share", onFail: "research" }),
        stage("share", "Share", "notify", zone(900, 0, "green", 220), { message: "Answered: {{card.title}}", next: "done" }),
        stage("done", "Done", "done", zone(900, 250, "green", 220)),
      ],
    },
  },
  {
    id: "triage",
    label: "Issue triage",
    about: "Jev sorts new issues into bugs, feature ideas and questions, and says how urgent each is. Bugs get fixed; questions get researched and a reply drafted. The flow's owner approves both in their chat app.",
    definition: {
      version: 1,
      start: "sort",
      stages: [
        stage("sort", "Sort new issues", "sort", zone(0, 0, "violet"), {
          sort: {
            question: "What kind of request is this?",
            answers: [
              { answer: "Bug", means: "Something is broken, crashes or behaves wrongly", to: "fix" },
              { answer: "Feature", means: "A request for something new, or to change how something works", to: "ideas" },
              { answer: "Question", means: "Someone asking how to do something, or asking for help", to: "answer" },
              { answer: "Something else", means: "Anything that isn't a bug, a feature request or a question", to: "by-hand" },
            ],
            sureAt: 0.8,
            notes: [{ id: "urgency", kind: "score", question: "How urgent is this?", levels: ["Routine: no deadline and nothing is blocked", "Soon: it hurts, but there's a workaround", "Now: something is blocked, broken for many people, or there's a deadline"] }],
          },
          onFail: "by-hand",
        }),
        stage("fix", "Fix it", "task", zone(420, 0, "blue"), { instructions: "{{card.title}}\n\n{{card.description}}\n\nChanges asked for (if any): {{note}}", next: "review" }),
        stage("review", "Review the fix", "approval", zone(840, 0, "amber"), { toOwner: true, next: "close", onFail: "fix" }),
        stage("close", "Close the issue", "update", zone(1260, 0, "green", 220), { message: "Fixed: {{card.title}}. Thanks for the report!", next: "done" }),
        stage("by-hand", "Sort by hand", "inbox", zone(0, 400, "slate")),
        stage("answer", "Answer it", "report", zone(420, 340, "violet"), {
          instructions: "Answer this question for the person who asked: clearly, briefly and in plain words, using what is in the repository.\n\nQuestion: {{card.title}}\n{{card.description}}\n\nFeedback to address (if any): {{note}}",
          next: "write-reply",
        }),
        stage("write-reply", "Write the reply", "draft", zone(840, 340, "violet"), {
          instructions: "Write a short, friendly reply to the person who asked, answering their question from the research notes. Plain words; say what to do next if anything.",
          next: "check-answer",
        }),
        stage("check-answer", "Check the reply", "approval", zone(1260, 340, "amber"), { toOwner: true, next: "reply", onFail: "write-reply" }),
        stage("reply", "Reply on the issue", "update", zone(1680, 340, "green", 220), { message: "{{stage.write-reply}}", next: "done" }),
        stage("ideas", "Feature ideas", "inbox", zone(420, 680, "slate")),
        stage("done", "Done", "done", zone(2100, 170, "green", 220)),
      ],
    },
  },
  {
    id: "spam-filter",
    label: "Spam filter",
    about: "Jev screens what a public form or webhook brings in. Genuine requests wait in Requests (another flow can start from there); spam and abuse are filtered out.",
    definition: {
      version: 1,
      start: "screen",
      stages: [
        stage("screen", "Screen", "sort", zone(0, 0, "violet"), {
          sort: {
            question: "Is this a genuine request from a person?",
            answers: [
              { answer: "Genuine", means: "A real question, report or request from a person, even if it is short or badly written", to: "requests" },
              { answer: "Spam", means: "Advertising, SEO or crypto offers, lists of links, gibberish, or anything automated", to: "filtered" },
              { answer: "Abusive", means: "Harassment, threats, slurs or hateful content", to: "filtered" },
            ],
            sureAt: 0.9,
            notes: [],
          },
          onFail: "by-hand",
        }),
        stage("requests", "Requests", "inbox", zone(420, 0, "slate")),
        stage("by-hand", "Check by hand", "inbox", zone(0, 400, "amber")),
        stage("filtered", "Filtered out", "done", zone(420, 340, "rose", 220)),
      ],
    },
  },
  {
    id: "lead-routing",
    label: "Lead routing",
    about: "Jev sorts new enquiries by what they want and notes how ready they are to buy. New projects ping the team straight away.",
    definition: {
      version: 1,
      start: "sort",
      stages: [
        stage("sort", "Sort", "sort", zone(0, 0, "violet"), {
          sort: {
            question: "What is this enquiry mainly about?",
            answers: [
              { answer: "New project", means: "They want something new built, designed or set up", to: "tell-team" },
              { answer: "Existing work", means: "A client asking about work that is already underway or delivered", to: "clients" },
              { answer: "Partnership", means: "A proposed partnership, referral or reselling arrangement", to: "partners" },
              { answer: "Not a fit", means: "Job seekers, vendors selling to us, students, or anyone who isn't a potential client", to: "not-a-fit" },
            ],
            sureAt: 0.8,
            notes: [
              { id: "ready", kind: "score", question: "How ready are they to buy?", levels: ["Just looking: no clear need yet", "Planning: a clear need, but no timeline or budget", "Ready: they name a budget, a date or a decision"] },
              { id: "when", kind: "yes-no", question: "Do they say when they need it?", levels: null },
            ],
          },
          onFail: "by-hand",
        }),
        stage("tell-team", "Tell the team", "notify", zone(420, 0, "green", 220), { message: "New project enquiry: {{card.title}}. {{stage.sort}}", next: "projects" }),
        stage("projects", "New projects", "inbox", zone(840, 0, "slate")),
        stage("by-hand", "Sort by hand", "inbox", zone(0, 400, "amber")),
        stage("clients", "Existing clients", "inbox", zone(420, 340, "slate")),
        stage("partners", "Partnerships", "inbox", zone(420, 680, "slate")),
        stage("not-a-fit", "Not a fit", "done", zone(420, 1020, "rose", 220)),
      ],
    },
  },
  {
    id: "effort-routing",
    label: "Effort routing",
    about: "Jev sends small, clear changes straight to a build, and big or unclear ones through a plan and a person first. When it isn't sure, it takes the careful path.",
    definition: {
      version: 1,
      start: "size",
      stages: [
        stage("size", "Size it", "sort", zone(0, 0, "violet"), {
          sort: {
            question: "How much work is this change?",
            answers: [
              { answer: "Small", means: "A small, clear change in one or two places: a typo, a label, a setting or an obvious fix", to: "quick" },
              { answer: "Big", means: "Touches many places, needs design choices, changes stored data, or is unclear", to: "plan" },
            ],
            sureAt: 0.85,
            notes: [],
          },
          onFail: "plan",
        }),
        stage("quick", "Build it", "task", zone(420, 0, "blue"), { planning: "skip", instructions: "{{card.title}}\n\n{{card.description}}\n\nChanges asked for (if any): {{note}}", next: "check-quick" }),
        stage("check-quick", "Review", "approval", zone(840, 0, "amber"), { toOwner: true, next: "done", onFail: "quick" }),
        stage("plan", "Plan it", "report", zone(420, 340, "violet"), {
          instructions: "Investigate this change and write a short plan: what is asked, which files it touches, the risks, the open questions and a rough size.\n\nRequest: {{card.title}}\n{{card.description}}\n\nFeedback to address (if any): {{note}}",
          next: "go-ahead",
        }),
        stage("go-ahead", "Go ahead?", "approval", zone(840, 340, "amber"), { toOwner: true, next: "build", onFail: "plan" }),
        stage("build", "Build it carefully", "task", zone(1260, 340, "blue"), { planning: "required", instructions: "{{card.title}}\n\n{{card.description}}\n\nThe agreed plan:\n{{stage.plan}}\n\nChanges asked for (if any): {{note}}", next: "review" }),
        stage("review", "Review", "approval", zone(1680, 340, "amber"), { toOwner: true, next: "done", onFail: "build" }),
        stage("done", "Done", "done", zone(1680, 0, "green", 220)),
      ],
    },
  },
  {
    id: "exception-routing",
    label: "Exception routing",
    about: "Jev sorts customer problems (order changes, invoice problems, deliveries) to the team that owns each, and notes how urgent each is and whether they want money back.",
    definition: {
      version: 1,
      start: "sort",
      stages: [
        stage("sort", "Sort", "sort", zone(0, 0, "violet"), {
          sort: {
            question: "What kind of problem is this?",
            answers: [
              { answer: "Order change", means: "The customer wants to change, cancel or add to an order", to: "orders" },
              { answer: "Invoice problem", means: "A wrong amount, a duplicate charge, missing details or a disputed invoice", to: "billing" },
              { answer: "Delivery problem", means: "An order that is late, lost, damaged or wrong", to: "delivery" },
              { answer: "Something else", means: "Anything that isn't about an order, an invoice or a delivery", to: "by-hand" },
            ],
            sureAt: 0.8,
            notes: [
              { id: "urgency", kind: "score", question: "How urgent is it?", levels: ["Routine: no deadline", "Soon: the customer is waiting on it", "Now: money is at stake or a deadline is named"] },
              { id: "refund", kind: "yes-no", question: "Is the customer asking for money back?", levels: null },
            ],
          },
          onFail: "by-hand",
        }),
        stage("orders", "Orders team", "inbox", zone(420, 0, "blue"), { next: "done" }),
        stage("billing", "Billing team", "inbox", zone(420, 340, "amber"), { next: "done" }),
        stage("delivery", "Delivery team", "inbox", zone(420, 680, "green"), { next: "done" }),
        stage("by-hand", "Sort by hand", "inbox", zone(0, 400, "slate")),
        stage("done", "Done", "done", zone(840, 340, "green", 220)),
      ],
    },
  },
  {
    id: "email-replies",
    label: "Email replies",
    about: "Claude drafts a reply to each question, the flow's owner approves or edits it in their chat app, and it's emailed to whoever asked. Share its button as a form that asks for an email address.",
    definition: {
      version: 1,
      start: "write",
      stages: [
        stage("write", "Write the reply", "draft", zone(0, 0, "violet"), {
          instructions: "Write a short, friendly reply to the person who asked, answering their question in plain words. Sign off as the team.",
          next: "check",
        }),
        stage("check", "Check the reply", "approval", zone(420, 0, "amber"), { toOwner: true, next: "send", onFail: "write" }),
        stage("send", "Email it", "email", zone(840, 0, "green"), { email: { to: "{{card.email}}", subject: "Re: {{card.title}}", body: "{{stage.write}}" }, next: "done", onFail: "no-address" }),
        stage("no-address", "No email address", "inbox", zone(840, 380, "amber")),
        stage("done", "Done", "done", zone(1260, 0, "green", 220)),
      ],
    },
  },
  {
    id: "follow-up",
    label: "Reply and follow up",
    about: "Claude drafts a reply, the owner approves it, and it's emailed. If they don't answer in 3 days, a short nudge goes out in the same thread; replies land in “They replied”. Needs the inbox in Settings → Email.",
    definition: {
      version: 1,
      start: "write",
      stages: [
        stage("write", "Write the reply", "draft", zone(0, 0, "violet"), {
          instructions: "Write a short, friendly reply to the person who wrote in, answering in plain words. Sign off as the team.",
          next: "check",
        }),
        stage("check", "Check the reply", "approval", zone(420, 0, "amber"), { toOwner: true, next: "send", onFail: "write" }),
        stage("send", "Email it", "email", zone(840, 0, "green"), { email: { to: "{{card.email}}", subject: "Re: {{card.title}}", body: "{{stage.write}}" }, next: "wait", onFail: "not-sent" }),
        stage("not-sent", "Couldn't email", "inbox", zone(840, 420, "amber")),
        stage("wait", "Wait for an answer", "wait", zone(1260, 0, "slate"), { wait: { for: "reply", minutes: 3 * 24 * 60 }, next: "replied", onFail: "nudge" }),
        stage("replied", "They replied", "inbox", zone(1680, 0, "slate"), { limit: { minutes: 24 * 60, to: null } }),
        stage("nudge", "Nudge", "email", zone(1260, 420, "green"), {
          email: { to: "{{card.email}}", subject: "Re: {{card.title}}", body: "Hi, just checking you saw our reply about “{{card.title}}”. Happy to help if anything's unclear." },
          next: "wait-again", onFail: "not-sent",
        }),
        stage("wait-again", "Wait again", "wait", zone(1680, 420, "slate"), { wait: { for: "reply", minutes: 4 * 24 * 60 }, next: "replied", onFail: "no-answer" }),
        stage("no-answer", "No answer", "done", zone(2100, 420, "green", 220)),
      ],
    },
  },
  {
    id: "stalled-decisions",
    label: "Decisions that don't stall",
    about: "The owner decides each request. If they haven't in a day they're reminded and it goes to anyone who can approve; that decision gets a reminder after 2 days.",
    definition: {
      version: 1,
      start: "requests",
      stages: [
        stage("requests", "Requests", "inbox", zone(0, 0, "slate"), { next: "decide" }),
        stage("decide", "Owner decides", "approval", zone(420, 0, "amber"), { toOwner: true, next: "approved", onFail: "declined", limit: { minutes: 24 * 60, to: "anyone" } }),
        stage("anyone", "Anyone decides", "approval", zone(420, 420, "amber"), { next: "approved", onFail: "declined", limit: { minutes: 2 * 24 * 60, to: null } }),
        stage("approved", "Tell the team", "notify", zone(840, 0, "green", 220), { message: "Approved: {{card.title}}", next: "done" }),
        stage("done", "Done", "done", zone(1260, 0, "green", 220)),
        stage("declined", "Declined", "done", zone(840, 420, "green", 220)),
      ],
    },
  },
  {
    id: "blank",
    label: "Blank flow",
    about: "An inbox and a done zone to build from.",
    definition: { version: 1, start: "inbox", stages: [stage("inbox", "Inbox", "inbox", zone(0, 0, "slate"), { next: "done" }), stage("done", "Done", "done", zone(300, 0, "green"))] },
  },
];

