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
import { TEXT_LIMITS } from "./text-limits.js";
import { createHash } from "node:crypto";
import { parseContract, readVersioned, type ContractIssue, type ContractResult } from "./contracts/contract.js";
import { stageReferenceProblems } from "./contracts/stage-output.js";
import {
  CHOICES_MAX, CHOICES_MIN, FLOW_ALIASES, FLOW_COLORS, FLOW_DEFINITION_VERSION, FLOW_END, FLOW_MERGE_METHODS, FLOW_STAGE_KINDS, flowDefinitionSchema, flowStepsSchema,
  HEADERS_MAX, LONGEST_WAIT_MINUTES, savedFlowDefinitionSchema, SCRIPT_LANGUAGES, SCRIPT_NAME, sortKeyOf, SURE_AT_MAX, SURE_AT_MIN, ZONE_ID,
  type FlowChoice, type FlowColor, type FlowDefinition, type FlowLimit, type FlowSort, type FlowStage, type FlowStageKind, type FlowStepFields, type FlowWait, type FlowZone, type ScriptLanguage, type TriggerInput,
} from "./contracts/flow.js";

export { CHOICES_MAX, CHOICES_MIN, FLOW_COLORS, FLOW_END, FLOW_MERGE_METHODS, FLOW_STAGE_KINDS, LONGEST_WAIT_MINUTES, SCRIPT_LANGUAGES, SCRIPT_NAME, sortKeyOf };
export type {
  FlowChoice, FlowColor, FlowDefinition, FlowEmail, FlowLimit, FlowMergeMethod, FlowRequest, FlowSort, FlowSortAnswer, FlowSortNote, FlowStage, FlowStageKind,
  FlowStepInput, FlowTool, FlowWait, FlowZone, ScriptLanguage,
} from "./contracts/flow.js";

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

export const LANGUAGE_WORDS: Record<ScriptLanguage, string> = { shell: "Shell", python: "Python", node: "Node" };

/** The default for "sure enough to act alone". */
export const SORT_SURE_AT = 0.8;

const HEADER = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

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

/** "22:00", "9:30" as "HH:MM"; null when it isn't a time of day. */
export function clockTime(value: unknown): string | null {
  const match = typeof value === "string" ? /^\s*([01]?[0-9]|2[0-3]):([0-5][0-9])\s*$/.exec(value) : null;
  return match === null ? null : `${match[1]!.padStart(2, "0")}:${match[2]}`;
}
export function knownTimeZone(zone: string): boolean {
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

/** Who decides at an approval zone: its named person, the flow's owner, or null for anyone who approves on the project. */
export function deciderOf(stage: Pick<FlowStage, "approver" | "toOwner">, flow: { owner: string }): string | null {
  return stage.toOwner === true ? flow.owner : stage.approver;
}

/** A flow refused by its contract: every problem, each naming its path (`stages[2].instructions: required`). */
export class FlowContractError extends Error {
  constructor(readonly lines: readonly string[]) {
    super(lines.join("\n"));
  }
}

// ------------------------------------------------------------------ reading a drawing

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** Text as every release has kept it: trimmed, and blank as none. Anything else is left for the schema to name. */
const said = (value: unknown): unknown => value === undefined || value === null ? null : typeof value === "string" ? value.trim() === "" ? null : value.trim() : value;
const coordinate = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.round(Math.min(max, Math.max(min, value))) : fallback;
const given = (value: unknown) => value !== undefined && value !== null;

/** A sort zone's settings as every release has kept them: an answer's meaning defaults to its name, sureAt to 0.8 (within
 * 0.5–0.99), and each extra note gets a free id. */
function canonicalSort(input: unknown): unknown {
  const raw = isRecord(input) ? input : {};
  const answers = Array.isArray(raw["answers"]) ? raw["answers"] : given(raw["answers"]) ? raw["answers"] : [];
  const sureAt = typeof raw["sureAt"] === "number" && Number.isFinite(raw["sureAt"]) ? Math.round(Math.min(SURE_AT_MAX, Math.max(SURE_AT_MIN, raw["sureAt"])) * 100) / 100 : SORT_SURE_AT;
  const noteIds = new Set<string>(["route"]);
  const notes = Array.isArray(raw["notes"]) ? raw["notes"].map(one => {
    const note = isRecord(one) ? one : {};
    const question = said(note["question"]);
    const kind = note["kind"] === "score" ? "score" : "yes-no";
    const words = typeof question === "string" ? question : "";
    let id = typeof note["id"] === "string" && ZONE_ID.test(note["id"]) ? note["id"] : sortKeyOf(words).slice(0, 24);
    for (let n = 2; noteIds.has(id); n++) id = `${sortKeyOf(words).slice(0, 20)}-${n}`;
    noteIds.add(id);
    const levels = kind === "score" ? (Array.isArray(note["levels"]) ? note["levels"] : []).map(said).filter(level => level !== null) : null;
    return { id, kind, question, levels };
  }) : given(raw["notes"]) ? raw["notes"] : [];
  return {
    question: said(raw["question"]),
    answers: Array.isArray(answers) ? answers.map(one => {
      const answer = isRecord(one) ? one : {};
      const name = said(answer["answer"]);
      return { answer: name, means: said(answer["means"]) ?? name, to: said(answer["to"]) };
    }) : answers,
    sureAt, notes,
  };
}

/** A script's or teammate's answers as every release has kept them: trimmed, none left out. */
function canonicalRoutes(input: unknown): unknown {
  if (!given(input)) return undefined;
  if (!Array.isArray(input)) return input;
  if (input.length === 0) return undefined;
  return input.map(one => {
    const row = isRecord(one) ? one : {};
    return { answer: typeof row["answer"] === "string" ? row["answer"].trim() : row["answer"] ?? "", to: typeof row["to"] === "string" ? row["to"].trim() : row["to"] ?? "" };
  });
}

/** A Wait zone's settings: "hours" between two times of day, or a reply or a set time for so long. */
function canonicalWait(input: unknown): unknown {
  const raw = isRecord(input) ? input : {};
  if (raw["for"] === "hours") {
    const zone = typeof raw["timeZone"] === "string" && raw["timeZone"].trim() !== "" ? raw["timeZone"].trim() : null;
    return { for: "hours", minutes: 0, from: clockTime(raw["from"]) ?? raw["from"], to: clockTime(raw["to"]) ?? raw["to"], ...(zone === null ? {} : { timeZone: zone }) };
  }
  return { for: raw["for"] === "time" ? "time" : "reply", minutes: durationMinutes(raw["minutes"]) };
}

/**
 * One zone of a version 1 drawing, as every release from 0.9.0 has read it: a zone saved before a field existed gets
 * that field's default, text is trimmed (blank is none), the canvas place is clamped, a field another kind uses is
 * set aside, and a value no release accepted is left as it is for the schema to name.
 */
function canonicalStage(input: unknown, index: number): unknown {
  if (!isRecord(input)) return input;
  const stage = input;
  const kind = stage["kind"];
  const zone = isRecord(stage["zone"]) ? stage["zone"] : {};
  const planning = stage["planning"] === "required" || stage["planning"] === "skip" || stage["planning"] === "auto" ? stage["planning"] : null;
  const runIn = stage["runIn"] === undefined || stage["runIn"] === null ? undefined : stage["runIn"];
  const routes = canonicalRoutes(stage["routes"]);
  const secrets = !given(stage["secrets"]) ? undefined : Array.isArray(stage["secrets"]) ? stage["secrets"].length === 0 ? undefined : stage["secrets"].every(one => typeof one === "string") ? [...new Set(stage["secrets"] as string[])] : stage["secrets"] : stage["secrets"];
  const limit = !given(stage["limit"]) ? undefined : isRecord(stage["limit"]) ? { minutes: durationMinutes(stage["limit"]["minutes"]), to: said(stage["limit"]["to"]) } : stage["limit"];
  const request = isRecord(stage["request"]) ? stage["request"] : {};
  const method = (["GET", "POST", "PUT", "PATCH", "DELETE"] as const).includes(request["method"] as "GET") ? request["method"] as string : "POST";
  const email = isRecord(stage["email"]) ? stage["email"] : {};
  const tool = isRecord(stage["tool"]) ? stage["tool"] : {};
  return {
    id: stage["id"], title: said(stage["title"]), kind,
    zone: { x: coordinate(zone["x"], -20000, 20000, index * 320), y: coordinate(zone["y"], -20000, 20000, 0), w: coordinate(zone["w"], 220, 1200, 280), h: coordinate(zone["h"], 160, 1600, 360), color: FLOW_COLORS.includes(zone["color"] as FlowColor) ? zone["color"] : "slate" },
    instructions: said(stage["instructions"]),
    planning: kind === "task" ? planning ?? "auto" : null,
    approver: kind === "approval" && stage["toOwner"] !== true ? said(stage["approver"]) : null,
    ...(kind === "approval" && stage["toOwner"] === true ? { toOwner: true } : {}),
    message: said(stage["message"]),
    close: kind === "update" ? stage["close"] !== false : null,
    script: kind === "check" ? said(stage["script"]) : null,
    // Left out, a script runs where every script ran before v90: in a copy of the card's work.
    ...(kind === "check" ? { ...(runIn === undefined ? {} : { runIn }), ...(routes === undefined ? {} : { routes }), ...(secrets === undefined ? {} : { secrets }) } : {}),
    sort: kind === "sort" ? canonicalSort(stage["sort"]) : null,
    ...(kind === "request" ? { request: { method, url: said(request["url"]), headers: Object.fromEntries(Object.entries(isRecord(request["headers"]) ? request["headers"] : {}).flatMap(([name, value]) => { const one = said(value); return one === null ? [] : [[name, one]]; })), body: method === "GET" || method === "DELETE" ? null : said(request["body"]) } } : {}),
    ...(kind === "email" ? { email: { to: said(email["to"]), subject: said(email["subject"]), body: said(email["body"]) } } : {}),
    ...(kind === "tool" ? { tool: { server: said(tool["server"]), name: said(tool["name"]), args: said(tool["args"]) ?? "{}" } } : {}),
    ...(kind === "wait" ? { wait: canonicalWait(stage["wait"]) } : {}),
    // true is a squash, the default; false or none is no merge.
    ...(kind === "pull-request" && given(stage["merge"]) && stage["merge"] !== false ? { merge: stage["merge"] === true ? "squash" : stage["merge"] } : {}),
    ...((kind === "approval" || kind === "teammate") && given(stage["teammate"]) && stage["teammate"] !== "" ? { teammate: stage["teammate"] } : {}),
    ...(kind === "teammate" && routes !== undefined ? { routes } : {}),
    ...(kind === "teammate" && stage["reply"] === true ? { reply: true } : {}),
    ...(kind === "choose" ? { options: Array.isArray(stage["options"]) ? stage["options"].map(one => { const row = isRecord(one) ? one : {}; return { label: said(row["label"]), to: said(row["to"]) }; }) : given(stage["options"]) ? stage["options"] : [] } : {}),
    ...(kind === "task" && given(stage["repo"]) && stage["repo"] !== "" ? { repo: said(stage["repo"]) } : {}),
    ...(limit === undefined ? {} : { limit }),
    next: kind === "sort" || kind === "choose" ? null : said(stage["next"]),
    onFail: said(stage["onFail"]),
  };
}

/** A version 1 drawing as every release has read it (canonicalStage); its start is the first zone unless it names one. */
function canonicalDefinition(input: Record<string, unknown>): Record<string, unknown> {
  const stages = Array.isArray(input["stages"]) ? input["stages"].map(canonicalStage) : input["stages"];
  const ids = Array.isArray(stages) ? stages.map(one => (isRecord(one) ? one["id"] : undefined)) : [];
  const start = typeof input["start"] === "string" && ids.includes(input["start"]) ? input["start"] : ids[0];
  return { version: Object.prototype.hasOwnProperty.call(input, "version") ? input["version"] : FLOW_DEFINITION_VERSION, start, stages };
}

const issue = (path: string, what: string, kind: ContractIssue["kind"] = "invalid"): ContractIssue => ({ path, kind, line: `${path}: ${what}` });

/** What JSON Schema can't say about a drawing, each named by its path: paths lead to zones that exist and never back into
 * their own zone, answers and options have names of their own, a web address's host is written out, tool arguments are a
 * JSON object, an hours wait's times differ in a real time zone, and a merge comes after a person's decision. */
export function drawingProblems(definition: FlowDefinition): ContractIssue[] {
  const problems: ContractIssue[] = [];
  const ids = new Set<string>();
  definition.stages.forEach((stage, index) => {
    if (ids.has(stage.id)) problems.push(issue(`stages[${index}].id`, `two zones are called ${stage.id}`));
    ids.add(stage.id);
  });
  definition.stages.forEach((stage, index) => {
    const at = `stages[${index}]`;
    const target = (path: string, to: string | null) => {
      if (to !== null && !ids.has(to)) problems.push(issue(`${at}.${path}`, `there's no zone called ${to}`));
      else if (to === stage.id && path !== "next" && path !== "onFail") problems.push(issue(`${at}.${path}`, "can't lead back into the same zone"));
    };
    target("next", stage.next);
    target("onFail", stage.onFail);
    if (stage.limit !== undefined) target("limit.to", stage.limit.to);
    stage.sort?.answers.forEach((one, n) => target(`sort.answers[${n}].to`, one.to));
    stage.routes?.forEach((one, n) => target(`routes[${n}].to`, one.to));
    stage.options?.forEach((one, n) => {
      if (one.to !== FLOW_END) target(`options[${n}].to`, one.to);
      else if (ids.has(FLOW_END)) problems.push(issue(`${at}.options[${n}].to`, `an option that ends the card can't be told apart from the zone called ${FLOW_END}; rename that zone`));
    });
    const twice = (path: string, names: readonly string[], key: (name: string) => string) => {
      const seen = new Set<string>();
      names.forEach((name, n) => {
        if (seen.has(key(name))) problems.push(issue(`${at}.${path}[${n}]`, `two are called ${name}`));
        seen.add(key(name));
      });
    };
    if (stage.sort !== null) twice("sort.answers", stage.sort.answers.map(one => one.answer), sortKeyOf);
    if (stage.routes !== undefined) twice("routes", stage.routes.map(one => one.answer), name => name.toLowerCase());
    if (stage.options !== undefined) twice("options", stage.options.map(one => one.label), name => name.toLowerCase());
    if (stage.request !== undefined) {
      const origin = /^(https?):\/\/([^/?#]*)/i.exec(stage.request.url);
      if (origin === null) problems.push(issue(`${at}.request.url`, "must start with https:// or http://"));
      else if (origin[2]!.includes("{{") || origin[2]!.includes("@") || origin[2] === "") problems.push(issue(`${at}.request.url`, "write the address's host out in full; fill-ins go after it"));
      const names = Object.keys(stage.request.headers);
      for (const name of names) if (!HEADER.test(name)) problems.push(issue(`${at}.request.headers`, `“${name}” isn't a header name`));
      if (names.length > HEADERS_MAX) problems.push(issue(`${at}.request.headers`, `at most ${HEADERS_MAX} headers`, "too-many"));
    }
    if (stage.tool !== undefined) {
      let args: unknown;
      try { args = JSON.parse(stage.tool.args); } catch { args = undefined; }
      if (!isRecord(args)) problems.push(issue(`${at}.tool.args`, `must be a JSON object, like {"text": "{{stage.draft}}"}`));
    }
    if (stage.wait !== undefined && (stage.wait.for === "hours") !== (stage.wait.minutes === 0)) problems.push(issue(`${at}.wait.minutes`, stage.wait.for === "hours" ? "must be 0: an hours wait waits for the clock" : "say how long it waits, from 1 minute to 30 days"));
    if (stage.wait !== undefined && (stage.wait.for === "hours") !== (stage.wait.from !== undefined && stage.wait.to !== undefined)) problems.push(issue(`${at}.wait`, stage.wait.for === "hours" ? "say the hours it waits for, like 22:00 to 06:00" : "only an hours wait has from and to"));
    if (stage.wait?.for === "hours") {
      if (stage.wait.from === stage.wait.to) problems.push(issue(`${at}.wait.to`, "must differ from from, like 22:00 to 06:00"));
      if (stage.wait.timeZone !== undefined && !knownTimeZone(stage.wait.timeZone)) problems.push(issue(`${at}.wait.timeZone`, `${stage.wait.timeZone} isn't a time zone, like Europe/London`));
    }
  });
  if (problems.length > 0) return problems;
  // A zone that merges comes after a person's decision on every path to it: never merged without one.
  const unapproved = reachableWithout(definition.stages, definition.start, one => one.kind === "approval");
  definition.stages.forEach((stage, index) => {
    if (stage.merge !== undefined && unapproved.has(stage.id)) problems.push(issue(`stages[${index}].merge`, "a “Person decides” zone must come before it on every path"));
  });
  return problems;
}

/**
 * Read a flow's drawing: the canvas's, a step list's once built, or one saved earlier (`stored`, which keeps working under
 * rules added since: its instructions keep the length they were saved with). A version 1 drawing is read as every release
 * has read it (canonicalStage), then the schema checks it, then drawingProblems; a newer version is refused plainly.
 */
export function readFlowDefinition(input: unknown, options: { stored?: boolean } = {}): ContractResult<FlowDefinition> {
  const body = isRecord(input) ? canonicalDefinition(input) : input;
  const read = readVersioned(options.stored === true ? savedFlowDefinitionSchema : flowDefinitionSchema, body, {}, FLOW_ALIASES) as ContractResult<FlowDefinition>;
  // The start is the first zone unless a zone it names exists: a problem with it is a problem with the zones, said there.
  if (!read.ok) return { ok: false, issues: read.issues.some(one => one.path.startsWith("stages")) ? read.issues.filter(one => one.path !== "start") : read.issues };
  const problems = drawingProblems(read.value);
  return problems.length === 0 ? read : { ok: false, issues: problems };
}

/** The saved drawing's fields in the words steps and flow files use for them. */
const STEP_WORDS: readonly [RegExp, string][] = [
  [/^tool\.args/, "args"], [/^tool\.server/, "server"], [/^tool\.name/, "tool"], [/^request\.(url|headers|body|method)/, "$1"], [/^email\.(to|subject|body)/, "$1"],
  [/^sort\.answers\[(\d+)\]\.to/, "answers[$1].goesTo"], [/^sort\.answers/, "answers"], [/^sort\.question/, "question"], [/^sort\.sureAt/, "sureAt"], [/^sort\.notes/, "alsoNote"],
  [/^(routes|options)\[(\d+)\]\.to/, "$1[$2].goesTo"], [/^limit\.to/, "thenMoveTo"], [/^limit(\.minutes)?/, "remindAfter"], [/^wait\.to/, "until"], [/^wait\.(from|timeZone)/, "$1"], [/^wait(\.minutes)?/, "wait"],
  [/^approver/, "decider"], [/^toOwner/, "decider"],
];

/** A refusal of the drawing a step list or flow file became, in its words: `stages[2].sort.answers[0].to` is
 * `steps[2].answers[0].goesTo` (each zone is the step at its index), and a zone's failure path is the step's own name for it. */
export function inStepWords(line: string, list: "steps" | "zones", kinds: readonly (string | undefined)[]): string {
  const match = /^stages\[(\d+)\](?:\.([^:]*))?:(.*)$/s.exec(line);
  if (match === null) return line;
  const index = Number(match[1]), kind = kinds[index];
  let field = match[2] ?? "";
  if (field === "onFail") field = kind === "sort" ? "ifNotSure" : kind === "wait" ? "ifNoReply" : kind === "choose" ? "ifReplied" : "ifFails";
  else for (const [from, to] of STEP_WORDS) if (from.test(field)) { field = field.replace(from, to); break; }
  return `${list}[${index}]${field === "" ? "" : `.${field}`}:${match[3]}`;
}

/** A flow as drawn on the canvas, checked whole (readFlowDefinition). Throws FlowContractError, naming every path. */
export function validateFlowDefinition(input: unknown, options: { stored?: boolean } = {}): FlowDefinition {
  const read = readFlowDefinition(input, options);
  if (!read.ok) throw new FlowContractError(read.issues.map(one => one.line));
  return read.value;
}

/** A drawing's refusal as the canvas shows it: each line as it is, after the name of the zone it is about, so a person
 * finds it on the canvas (`Build · stages[1].instructions: required`). */
export function withZoneNames(lines: readonly string[], input: unknown): string {
  const stages = isRecord(input) && Array.isArray(input["stages"]) ? input["stages"] : [];
  return lines.map(line => {
    const index = /^stages\[(\d+)\]/.exec(line)?.[1];
    const stage = index === undefined ? undefined : stages[Number(index)];
    const title = isRecord(stage) && typeof stage["title"] === "string" && stage["title"].trim() !== "" ? stage["title"].trim() : null;
    return title === null ? line : `${title} · ${line}`;
  }).join("\n");
}

/** The instructions 0.9.26 and earlier read from a saved zone: they re-check this length on every read, and a flow with a
 * longer one won't load. A saved zone keeps its first part under it, and the rest in `instructionsMore`, which they ignore. */
export const FLOW_INSTRUCTIONS_STORED = 4000;

/** A flow's definition as the store saves it: any zone's instructions over FLOW_INSTRUCTIONS_STORED are split, so a
 * person who goes back a version still opens the flow (with its instructions' first part). Unchanged otherwise. */
export function flowDefinitionForStore(json: string): string {
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return json; }
  const stages = (raw as { stages?: unknown } | null)?.stages;
  if (!Array.isArray(stages)) return json;
  let split = false;
  const kept = stages.map(one => {
    const stage = one as Record<string, unknown> | null;
    const words = stage?.["instructions"];
    if (stage === null || typeof stage !== "object" || typeof words !== "string" || words.length <= FLOW_INSTRUCTIONS_STORED) return one;
    let at = FLOW_INSTRUCTIONS_STORED;
    if (/[\uD800-\uDBFF]/.test(words[at - 1]!)) at--;
    split = true;
    return { ...stage, instructions: words.slice(0, at), instructionsMore: words.slice(at) };
  });
  return split ? JSON.stringify({ ...(raw as object), stages: kept }) : json;
}

/** A saved flow's definition with every zone's instructions whole again (flowDefinitionForStore). */
export function flowDefinitionFromStore(json: string): string {
  if (!json.includes("\"instructionsMore\"")) return json;
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return json; }
  const stages = (raw as { stages?: unknown } | null)?.stages;
  if (!Array.isArray(stages)) return json;
  const whole = stages.map(one => {
    const stage = one as Record<string, unknown> | null;
    if (stage === null || typeof stage !== "object" || typeof stage["instructionsMore"] !== "string") return one;
    const { instructionsMore, ...rest } = stage;
    return { ...rest, instructions: `${typeof stage["instructions"] === "string" ? stage["instructions"] : ""}${instructionsMore as string}` };
  });
  return JSON.stringify({ ...(raw as object), stages: whole });
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

/** What a card's work is held to: the zones' steps and paths, never where they sit on the canvas. */
export function flowDigest(definition: FlowDefinition): string {
  const terms = definition.stages.map(({ zone: _zone, ...rest }) => rest);
  return createHash("sha256").update(JSON.stringify({ start: definition.start, terms })).digest("hex").slice(0, 32);
}

/** {{stage.<id>}} is an earlier zone's output; a report zone also fills {{stage.<id>.items}} and {{stage.<id>.report}}. */
const FILLED = /\{\{\s*(card\.title|card\.description|card\.email|note|stage\.([a-z0-9-]+(?:\.(?:items|report))?))\s*\}\}/g;
type FlowFillCard = { title: string; description: string | null; note: string | null; outputs: Record<string, string> };

/** Fill a zone's text from the card: title, description, the latest note and earlier zones' reports. */
export function fillFlowText(template: string, card: FlowFillCard, encode: (value: string) => string = value => value): string {
  return template.replace(FILLED, (_match, key: string, stage: string | undefined) => encode(fillOne(key, stage, card))).trim();
}

/** The task door's goal limit (task-text.ts). A work zone's goal is kept within it. */
export const FLOW_GOAL_LIMIT = TEXT_LIMITS.goal;
/** What stands in a goal for a filled-in value too long to hold whole: the agent is given it whole, attached (flowGoalCuts). */
export const flowAttachedMark = (label: string) => `[${label}: attached in full below]`;

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

/** Script output can carry carriage returns, colour codes and hidden marks a task goal refuses; the goal drops them. */
const goalSafe = (value: string) => value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "");

/** How a filled-in value is named where it is attached: the same words flowGoalCuts labels it with. */
export function flowValueLabel(key: string, stageTitle: (id: string) => string = id => id): string {
  if (key === "card.title") return "The card's title";
  if (key === "card.description") return "The card's description";
  if (key === "card.email") return "The card's email address";
  if (key === "note") return "The note it was sent back with";
  const match = /^stage\.([a-z0-9-]+)(?:\.(items|report))?$/.exec(key);
  if (match === null) return key;
  return `What ${stageTitle(match[1]!)} ${match[2] === "items" ? "listed" : match[2] === "report" ? "reported in full" : "found"}`;
}

/** A work zone's goal, filled from the card and kept within `limit`: the zone's own words stay whole, and every filled-in
 * value goes in whole. When they don't all fit, the longest values are attached instead (each named in the goal by
 * flowAttachedMark, and given to the agent whole by flowGoalCuts) until the rest fits: nothing is cut. Words that fill
 * the limit to the last character leave attached values a shorter mark, then none (they are still attached). Null only
 * when the template's own words are over the limit: the caller then files the zone's words alone (flowGoal). */
export function fitFlowText(template: string, card: FlowFillCard, limit = FLOW_GOAL_LIMIT, stageTitle?: (id: string) => string): string | null {
  const matches = [...template.matchAll(FILLED)];
  const values = matches.map(match => goalSafe(fillOne(match[1]!, match[2], card)));
  const marks = matches.map(match => flowAttachedMark(flowValueLabel(match[1]!, stageTitle)));
  const attached = new Set<number>();
  const build = () => { let at = 0; return template.replace(FILLED, () => { const i = at++; return attached.has(i) ? marks[i]! : values[i]!; }).trim(); };
  let goal = build();
  // The longest first, so the fewest values leave the goal.
  const order = values.map((value, i) => i).filter(i => values[i]!.length > marks[i]!.length).sort((a, b) => values[b]!.length - values[a]!.length);
  for (const i of order) {
    if (goal.length <= limit) break;
    attached.add(i);
    goal = build();
  }
  for (const shorter of ["[attached]", ""]) {
    if (goal.length <= limit) break;
    for (const i of attached) marks[i] = shorter;
    goal = build();
  }
  return goal.length <= limit ? goal : null;
}

/** A work zone's goal for a card: its words, the card and any note, fitted (fitFlowText); when the zone's words leave no
 * room for the card's own lines, its words alone, with the card attached. Null only for words over the limit. */
export function flowGoal(instructions: string, card: FlowFillCard, stageTitle?: (id: string) => string): string | null {
  return fitFlowText(flowWorkTemplate(instructions, card), card, FLOW_GOAL_LIMIT, stageTitle) ?? fitFlowText(instructions, card, FLOW_GOAL_LIMIT, stageTitle);
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

const KIND_COLORS: Record<FlowStageKind, FlowColor> = { inbox: "slate", task: "blue", report: "violet", approval: "amber", check: "blue", "pull-request": "blue", update: "green", notify: "green", sort: "violet", draft: "violet", request: "blue", email: "green", tool: "blue", wait: "slate", teammate: "violet", send: "green", choose: "amber", done: "green" };
/** A step id as the lead may write it (sort_by_hand, Sort-By-Hand) in the one form zones use. */
const idOf = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
const slugOf = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28) || "zone";
const overlaps = (a: FlowZone, b: FlowZone) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** A wait step's settings: what it waits for and how long (3 days when neither the step nor the zone it keeps says). */
function waitFromStep(step: FlowStepFields, old: FlowWait | null, at: string): FlowWait {
  if ((step.waitFor ?? old?.for) === "hours") {
    const from = clockTime(step.from ?? old?.from ?? "22:00"), to = clockTime(step.until ?? old?.to ?? "06:00");
    if (from === null || to === null) throw new FlowContractError([`${at}.from: say the hours it waits for, like from 22:00 until 06:00`]);
    const timeZone = step.timeZone ?? old?.timeZone;
    return { for: "hours", minutes: 0, from, to, ...(timeZone === undefined ? {} : { timeZone }) };
  }
  const minutes = step.wait === undefined ? old?.minutes ?? 3 * 24 * 60 : durationMinutes(step.wait);
  if (minutes === null) throw new FlowContractError([`${at}.wait: say how long it waits, like "3 days" or "4 hours" (up to 30 days)`]);
  return { for: step.waitFor ?? old?.for ?? "reply", minutes };
}

/** A step's time limit: the one it gives, the one its zone had, or none ("none" removes one). */
function limitFromStep(step: FlowStepFields, old: FlowLimit | null, at: string, find: (ref: string, path: string) => string): FlowLimit | null {
  if (step.remindAfter === undefined) return old === null ? null : { ...old, ...(step.thenMoveTo === undefined ? {} : { to: step.thenMoveTo.trim() === "" ? null : find(step.thenMoveTo, "thenMoveTo") }) };
  if (typeof step.remindAfter === "string" && /^\s*(none|never|no|off)?\s*$/i.test(step.remindAfter)) return null;
  const minutes = durationMinutes(step.remindAfter);
  if (minutes === null) throw new FlowContractError([`${at}.remindAfter: say when to remind, like "2 days" (up to 30 days)`]);
  return { minutes, to: typeof step.thenMoveTo === "string" && step.thenMoveTo.trim() !== "" ? find(step.thenMoveTo, "thenMoveTo") : step.thenMoveTo === undefined ? old?.to ?? null : null };
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
  return Array.isArray(steps) ? steps.map(step => isRecord(step) && typeof step["decider"] === "string" && /^(me|myself|i|you|the operator)$/i.test(step["decider"].trim()) ? { ...step, decider: name } : step) : steps;
}

/** An edit's steps with what a kept step leaves out of its kind and name filled from the zone it keeps (by id), so each
 * reads as the one schema its kind has. Anything else it leaves out carries over when the flow is drawn (flowFromSteps). */
export function withKeptSteps(steps: unknown, previous: FlowDefinition | null): unknown {
  if (previous === null || !Array.isArray(steps)) return steps;
  const kept = new Map(previous.stages.map(one => [one.id, one]));
  const asked = new Set<string>();
  return steps.map(step => {
    if (!isRecord(step) || typeof step["id"] !== "string") return step;
    const id = idOf(step["id"]);
    const old = asked.has(id) ? undefined : kept.get(id);
    asked.add(id);
    if (old === undefined) return step;
    return {
      ...step,
      ...(step["kind"] === undefined ? { kind: old.kind } : {}),
      ...(step["title"] === undefined || (typeof step["title"] === "string" && step["title"].trim() === "") ? { title: old.title } : {}),
    };
  });
}

/** A flow's steps, read by their one schema: `steps[0].routes[0]: unknown key 'to' (did you mean goesTo?)`. */
export function readFlowSteps(input: unknown, previous: FlowDefinition | null = null): ContractResult<FlowStepFields[]> {
  const read = parseContract(flowStepsSchema, { steps: withKeptSteps(input, previous) }, FLOW_ALIASES);
  return read.ok ? { ok: true, value: read.value.steps as FlowStepFields[] } : read;
}

/**
 * A flow from an ordered list of steps: ids from names, each step leading
 * to the next, a Done zone at the end when none is listed, and a decision
 * sending work back to the nearest earlier step that does work. New zones
 * are laid out in rows; zones kept from `previous` keep their place. Throws
 * FlowContractError, each line naming the step's path (`steps[2].next: ...`).
 */
export function flowFromSteps(input: unknown, previous: FlowDefinition | null = null): FlowDefinition {
  const read = readFlowSteps(input, previous);
  if (!read.ok) throw new FlowContractError(read.issues.map(one => one.line));
  const kept = new Map((previous?.stages ?? []).map(one => [one.id, one]));
  const used = new Set<string>();
  const drafts = read.value.map((step, index) => {
    const asked = typeof step.id === "string" ? idOf(step.id) : "";
    const old = asked !== "" && !used.has(asked) ? kept.get(asked) ?? null : null;
    const title = step.title.trim() !== "" ? step.title.trim() : old?.title ?? "";
    if (title === "") throw new FlowContractError([`steps[${index}].title: must not be empty`]);
    const kind = step.kind;
    // A new step keeps an id it is given (so the other steps can point at it by that id); otherwise its name makes one.
    const given = ZONE_ID.test(asked) && !used.has(asked) ? asked : null;
    let id = old?.id ?? given ?? slugOf(title);
    for (let n = 2; old === null && used.has(id); n++) id = `${slugOf(title).slice(0, 25)}-${n}`;
    used.add(id);
    const same = old !== null && old.kind === kind;
    return { step, old: same ? old : null, id, title, kind, at: `steps[${index}]` };
  });
  if (!drafts.some(one => one.kind === "done")) {
    let id = "done";
    for (let n = 2; used.has(id); n++) id = `done-${n}`;
    drafts.push({ step: { title: "Done", kind: "done" }, old: kept.get(id)?.kind === "done" ? kept.get(id)! : null, id, title: "Done", kind: "done", at: `steps[${drafts.length}]` });
  }
  const findFrom = (at: string) => (ref: string, path: string): string => {
    const wanted = ref.trim().toLowerCase();
    const hit = drafts.find(one => one.id === ref.trim() || one.id === idOf(ref) || one.title.toLowerCase() === wanted);
    if (hit === undefined) throw new FlowContractError([`${at}.${path}: there's no step called ${ref}`]);
    return hit.id;
  };
  const stages: FlowStage[] = [];
  drafts.forEach(({ step, old, id, title, kind, at }, index) => {
    const find = findFrom(at);
    const earlier = stages.slice();
    const following = drafts.slice(index + 1).find(() => true) ?? null;
    const next = kind === "done" || kind === "sort" || kind === "choose" ? null
      : typeof step.next === "string" && step.next.trim() !== "" ? find(step.next, "next")
      : following?.id ?? drafts.find(one => one.kind === "done")!.id;
    const keptFail = old?.onFail !== null && old?.onFail !== undefined && drafts.some(one => one.id === old.onFail) ? old.onFail : null;
    const worker = [...earlier].reverse().find(one => one.kind === "task" || one.kind === "report");
    const [failKey, notSure] = kind === "sort" ? ["ifNotSure", step.ifNotSure] as const
      : kind === "wait" ? ["ifNoReply", step.ifNoReply] as const
      : kind === "choose" ? ["ifReplied", step.ifReplied] as const : ["ifFails", step.ifFails] as const;
    const onFail = kind === "done" ? null
      : typeof notSure === "string" && notSure.trim() !== "" ? find(notSure, failKey)
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
    const routesOf = (routes: NonNullable<FlowStepFields["routes"]>) => routes.length === 0 ? {} : { routes: routes.map((one, n) => ({ answer: one.answer.trim(), to: find(one.goesTo, `routes[${n}].goesTo`) })) };
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
      ...(toOwner ? { toOwner: true as const } : {}),
      message: kind === "notify" ? step.message?.trim() || old?.message || (drafts.find(one => one.id === next)?.kind === "done" ? "Finished: {{card.title}}" : "Update on {{card.title}}")
        : kind === "update" ? step.message?.trim() || old?.message || "Done: {{card.title}}" : null,
      close: kind === "update" ? step.close ?? old?.close ?? true : null,
      script: kind === "check" ? step.script?.trim() || old?.script || null : null,
      // Left out, a code step runs in a copy of the project (the card's work, or the main branch), as scripts always have.
      ...(kind === "check" ? {
        ...(step.runIn !== undefined ? { runIn: step.runIn } : old?.runIn === undefined ? {} : { runIn: old.runIn }),
        ...(step.routes !== undefined ? routesOf(step.routes) : old?.routes === undefined ? {} : { routes: old.routes }),
        ...(step.secrets !== undefined ? step.secrets.length === 0 ? {} : { secrets: step.secrets } : old?.secrets === undefined ? {} : { secrets: old.secrets }),
      } : {}),
      sort: kind === "sort" ? sortFromStep(step, old?.sort ?? null, find) : null,
      ...(kind === "request" ? { request: { method: step.method ?? old?.request?.method ?? "POST", url: step.url ?? old?.request?.url ?? "", headers: step.headers ?? old?.request?.headers ?? {}, body: step.body ?? old?.request?.body ?? null } } : {}),
      ...(kind === "email" ? { email: { to: step.to ?? old?.email?.to ?? "{{card.email}}", subject: step.subject ?? old?.email?.subject ?? "Re: {{card.title}}", body: step.body ?? old?.email?.body ?? "" } } : {}),
      ...(kind === "tool" ? { tool: { server: step.server ?? old?.tool?.server ?? "", name: step.tool ?? old?.tool?.name ?? "", args: typeof step.args === "string" ? step.args : step.args !== undefined ? JSON.stringify(step.args) : old?.tool?.args ?? "{}" } } : {}),
      ...(kind === "wait" ? { wait: waitFromStep(step, old?.wait ?? null, at) } : {}),
      ...(kind === "pull-request" && (step.merge === undefined ? old?.merge !== undefined : step.merge !== false) ? { merge: step.merge === undefined || step.merge === true || step.merge === false ? old?.merge ?? "squash" : step.merge } : {}),
      // v92: "nobody" (or "none") takes a teammate off an approval step.
      ...((kind === "approval" || kind === "teammate") && (step.teammate === undefined ? old?.teammate !== undefined : !/^(nobody|none|no one)$/i.test(step.teammate.trim())) ? { teammate: idOf(step.teammate ?? old!.teammate!) } : {}),
      ...(kind === "teammate" ? step.routes !== undefined ? routesOf(step.routes) : old?.routes === undefined ? {} : { routes: old.routes } : {}),
      ...(kind === "teammate" && (step.reply ?? old?.reply) === true ? { reply: true as const } : {}),
      ...(kind === "choose" ? { options: choicesFromStep(step, old?.options ?? null, at, find) } : {}),
      ...(kind === "task" && (step.repo ?? old?.repo) !== undefined && (step.repo ?? old?.repo)!.trim() !== "" ? { repo: (step.repo ?? old?.repo)!.trim() } : {}),
      ...(() => {
        // "If no reply" on a choice is where it moves once the reminder comes.
        const asked = kind === "choose" && step.thenMoveTo === undefined && typeof step.ifNoReply === "string" ? { ...step, thenMoveTo: step.ifNoReply } : step;
        if (kind === "choose" && asked.thenMoveTo !== undefined && asked.remindAfter === undefined && old?.limit === undefined) throw new FlowContractError([`${at}.remindAfter: say how long to wait for a choice first (like "2 days")`]);
        const limit = kind === "wait" || kind === "done" ? null : limitFromStep(asked, old?.limit ?? null, at, find); return limit === null ? {} : { limit };
      })(),
      next, onFail,
    });
  });
  // {{stage.<ref>}} in a step's words names a step as the lead wrote it (draftReply, Draft reply):
  // it is rewritten to that step's id, the same way the steps themselves are named.
  const refs = (text: string) => text.replace(/\{\{\s*stage\.([A-Za-z0-9_ -]{1,60}?)(\.items|\.report)?\s*\}\}/g, (whole, ref: string, part: string | undefined) => {
    const hit = drafts.find(one => one.id === ref) ?? drafts.find(one => one.id === idOf(ref) || one.id.replace(/-/g, "") === idOf(ref).replace(/-/g, "") || one.title.toLowerCase() === ref.trim().toLowerCase());
    return hit === undefined ? whole : `{{stage.${hit.id}${part ?? ""}}}`;
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
  // The drawing is checked as the canvas's is; its zones are the steps, in order, so a zone's problem names its step.
  const drawn = readFlowDefinition({ version: FLOW_DEFINITION_VERSION, start: stages[0]!.id, stages });
  const refuse = (issues: readonly ContractIssue[]) => new FlowContractError(issues.map(one => inStepWords(one.line, "steps", stages.map(stage => stage.kind))));
  if (!drawn.ok) throw refuse(drawn.issues);
  // A {{stage.…}} these steps add must be one its zone hands on (src/contracts/stage-output.ts); ones the flow had stay.
  const references = stageReferenceProblems(drawn.value, previous);
  if (references.length > 0) throw refuse(references);
  return drawn.value;
}

/** A choose step's options: each with its words and the step it goes to ("end", or no step, ignores the card); kept ones carry over. */
function choicesFromStep(step: FlowStepFields, old: FlowChoice[] | null, at: string, find: (ref: string, path: string) => string): FlowChoice[] {
  if (step.options === undefined) {
    if (old !== null) return old;
    throw new FlowContractError([`${at}.options: give it ${CHOICES_MIN} to ${CHOICES_MAX} options, each with a label and the step it goes to (or "end")`]);
  }
  return step.options.map((one, n) => {
    const label = one.label.trim();
    const goes = (one.goesTo ?? "").trim();
    return { label, to: goes === "" || /^(end|ignore|ignored|stop|close)$/i.test(goes) ? FLOW_END : find(goes, `options[${n}].goesTo`) };
  });
}

/** A sort step as the lead describes it: answers name the steps they go to; what it leaves out carries over from the zone it keeps. */
function sortFromStep(step: FlowStepFields, old: FlowSort | null, find: (ref: string, path: string) => string): FlowSort {
  const answers = step.answers !== undefined
    ? step.answers.map((one, n) => ({ answer: one.answer.trim(), means: (one.means ?? "").trim() || one.answer.trim(), to: one.goesTo.trim() !== "" ? find(one.goesTo, `answers[${n}].goesTo`) : "" }))
    : old?.answers ?? [];
  // A percentage (80) or a fraction (0.8).
  const sure = step.sureAt !== undefined ? (step.sureAt > 1 ? step.sureAt / 100 : step.sureAt) : old?.sureAt ?? SORT_SURE_AT;
  const notes = step.alsoNote !== undefined ? step.alsoNote.map(one => one.kind === "score"
    ? { id: one.id ?? "", kind: "score" as const, question: one.question.trim(), levels: one.levels ?? [] }
    : { id: one.id ?? "", kind: "yes-no" as const, question: one.question.trim(), levels: null })
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
export const FLOW_TEMPLATES: readonly { id: string; label: string; about: string; definition: FlowDefinition; trigger?: TriggerInput }[] = [
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

