/**
 * Flow triggers (v82): what starts cards in a flow without someone adding
 * them by hand.
 *
 * - button   — a named button with questions; pressing it makes a card from the answers.
 * - schedule — a card on a schedule (the routines' schedule rules: every N minutes, daily, weekly);
 *              v90: or a project script run on the schedule, each item it prints a card.
 * - github   — new issues (optionally with a label), new pull requests, or failed checks on a branch.
 * - linear   — Linear issues in a team, moving into a state, and/or with a label.
 * - flow     — another flow's cards reaching one of its zones.
 * - webhook  — anything that can post JSON to the trigger's secret address.
 * - email    — mail arriving in a folder of the account set up in Settings → Email (v89),
 *              read-only over IMAP; optionally only from some senders or with words in the subject.
 * - chat     — messages in a Slack, Discord or Teams channel (v89), connected from the
 *              channel itself (chat-inbox.ts), never from here.
 * - plane-review — every day at a set time (07:30 in the computer's time zone unless it says),
 *              the plane's last 24 hours read straight from the store (plane-review.ts): one card
 *              per distinct problem worth fixing, and the same problem on a later day joins its
 *              card while that card is still open. A clean day makes nothing. Waits only a person
 *              can end make no card; ones over three days are mentioned once in its summary line,
 *              linked to Needs you. Its row is kept as a
 *              'schedule' (the table's kinds are fixed); its settings say what it is.
 *
 * GitHub and Linear are checked by the worker's pass — `gh` and one HTTPS
 * request, never a model — or pushed to a secret webhook address when the
 * console has a public one. Either way one outside thing makes at most one
 * card; outside text is checked for keys before it becomes a card; GitHub
 * text from outside the team is left out unless the trigger says anyone;
 * and a card's work is an ordinary task under the usual approvals.
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Runner } from "./backend.js";
import { scanForSecrets } from "./evidence.js";
import { flowCardText, flowDefinitionOf, type FlowAct } from "./flow-engine.js";
import { FlowContractError, type FlowDefinition } from "./flows.js";
import { parseContract, type ContractResult } from "./contracts/contract.js";
import { FLOW_ALIASES, FLOW_TRIGGER_KINDS, SECRETS_MAX, triggerConfigSchema, triggerInputSchema, type ChatApp, type FlowTriggerKind, type TriggerConfig, type TriggerInput } from "./contracts/flow.js";
import { describeSchedule, firstFireAt, nextFireAt, parseSchedule, WEEKDAYS } from "./routine.js";
import { takeReply } from "./flow-replies.js";
import { mailboxAccess, mailCursorOf, mailCursorText, readThroughImap, type MailReader } from "./mailbox.js";
import type { CodeResult } from "./flow-code.js";
import { readFlowSecrets } from "./flow-secrets.js";
import { tmpdir } from "node:os";
import type { FlowCardSource, FlowRow, FlowTriggerRow, Store } from "./store.js";
import { envValue } from "./names.js";
import { linearLabelNames, readFormSubmission, readGithubEvent, readGithubIssue, readGithubIssueEventList, readGithubIssueList, readGithubRun, readGithubRunList, readInboundMail, readLinearAnswer, readLinearEvent, readLinearIssue, readWebhookPayload } from "./contracts/trigger-payloads.js";

export { FLOW_TRIGGER_KINDS };
export type { ChatApp, FlowTriggerKind, TriggerConfig, TriggerInput };
export const CHAT_APP_NAMES: Record<ChatApp, string> = { slack: "Slack", discord: "Discord", teams: "Teams", telegram: "Telegram" };

/** What each kind is called on the canvas. */
export const FLOW_TRIGGER_WORDS: Record<FlowTriggerKind, string> = {
  button: "Button", schedule: "Schedule", github: "GitHub", linear: "Linear", flow: "Another flow", webhook: "Webhook", email: "Email inbox", chat: "Chat channel", "plane-review": "Plane review",
};

/** How often the worker checks GitHub and Linear, and how it backs off when they don't answer. */
export const POLL_EVERY_MS = 2 * 60_000;
const BACKOFF_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000];
/** At most this many cards from one check or one delivery; the rest wait for the next. */
export const CARDS_PER_CHECK = 10;
const HOOK_BYTES = 1_000_000;
/** Authors GitHub says have write access to the repository. */
const TEAM = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

// ------------------------------------------------------------ the terms

const HIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A trigger's settings read by their one schema (`label: required`, `unknown key 'flows'`). A setting given as null is
 * left out, and a button's blank question lines are dropped, as every release has read them. Then what the schema can't
 * say, named by its path: no hidden characters and nothing that looks like a key, anywhere in the settings.
 */
export function readTriggerSettings(raw: unknown): ContractResult<TriggerInput> {
  const body = isRecord(raw) ? Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== null).map(([key, value]) =>
    [key, key === "questions" && Array.isArray(value) ? value.filter(one => typeof one !== "string" || one.trim() !== "") : value])) : raw;
  const read = parseContract(triggerInputSchema, body, FLOW_ALIASES);
  if (!read.ok) return read;
  for (const [key, value] of Object.entries(read.value)) {
    for (const [n, one] of (Array.isArray(value) ? value : [value]).entries()) {
      if (typeof one !== "string") continue;
      const path = Array.isArray(value) ? `${key}[${n}]` : key;
      if (HIDDEN.test(one)) return { ok: false, issues: [{ path, kind: "bad-value", line: `${path}: can't contain hidden characters` }] };
      if (scanForSecrets(one).length > 0) return { ok: false, issues: [{ path, kind: "bad-value", line: `${path}: looks like a key or password; keys never go in a trigger's settings` }] };
    }
  }
  return read;
}

/** A schedule said in words ("every 2 hours", "daily 09:00 Europe/London", "monday 09:00") or in the routines' own form. */
export function scheduleFromWords(text: string): string | null {
  const raw = text.trim().replace(/\s+/g, " ");
  if (parseSchedule(raw) !== null) return raw;
  const zone = (value: string | undefined) => value === undefined || /^utc$/i.test(value) ? "" : `@${value}`;
  const pad = (hour: string) => hour.padStart(2, "0");
  let match = /^every (\d{1,5}) ?(minutes?|mins?|m|hours?|hrs?|h|days?|d)$/i.exec(raw);
  if (match !== null) {
    const n = Number(match[1]), unit = match[2]!.toLowerCase()[0];
    const text = `every:${unit === "m" ? n : unit === "h" ? n * 60 : n * 1440}`;
    return parseSchedule(text) === null ? null : text;
  }
  match = /^(?:every day|daily)(?: at)? (\d{1,2}):(\d{2})(?: (\S+))?$/i.exec(raw);
  if (match !== null) {
    const text = `daily:${pad(match[1]!)}:${match[2]}${zone(match[3])}`;
    return parseSchedule(text) === null ? null : text;
  }
  match = /^(?:every )?(?:weekdays?|weekday mornings?)(?: at)? (\d{1,2}):(\d{2})(?: (\S+))?$/i.exec(raw);
  if (match !== null) {
    const text = `weekdays:${pad(match[1]!)}:${match[2]}${zone(match[3])}`;
    return parseSchedule(text) === null ? null : text;
  }
  match = /^(?:every |weekly on |weekly |on )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?(?: at)? (\d{1,2}):(\d{2})(?: (\S+))?$/i.exec(raw);
  if (match !== null) {
    const day = WEEKDAYS.findIndex(one => one.toLowerCase() === match![1]!.toLowerCase());
    const text = `weekly:${day}:${pad(match[2]!)}:${match[3]}${zone(match[4])}`;
    return parseSchedule(text) === null ? null : text;
  }
  return null;
}

/** A GitHub repository as owner/name, read from a project's origin remote when it is on GitHub. */
export function githubRepoOf(path: string): string | null {
  try {
    const dot = join(path, ".git");
    const config = statSync(dot).isDirectory() ? readFileSync(join(dot, "config"), "utf8") : null;
    const url = config === null ? null : /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(config)?.[1] ?? null;
    const match = url === null ? null : /github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url);
    return match === null ? null : `${match[1]}/${match[2]}`;
  } catch { return null; }
}

/** A trigger's settings, checked whole against the flow it starts cards in (readTriggerSettings, then the flow, its zones,
 * the project's scripts and the schedule). Throws FlowContractError, each line naming its setting. */
export function validateTriggerConfig(raw: unknown, context: { store: Store; flow: FlowRow; definition: FlowDefinition; actor: string }): TriggerConfig {
  // Connecting a channel proves it's one the person is in: it happens in the channel, not here.
  if (isRecord(raw) && raw["kind"] === "chat") throw new FlowContractError([`kind: connect a chat channel from the channel itself: where Toolroll is in Slack, Discord, Teams or a Telegram group, send “flow ${context.flow.id}”`]);
  const read = readTriggerSettings(raw);
  if (!read.ok) throw new FlowContractError(read.issues.map(one => one.line));
  const input = read.value;
  const refuse = (path: string, what: string): never => { throw new FlowContractError([`${path}: ${what}`]); };
  /** A setting's words, trimmed; blank is left out. */
  const said = (value: string | undefined): string | null => value === undefined || value.trim() === "" ? null : value.trim();
  const named = said(input.zone);
  const zoneStage = named === null ? null : context.definition.stages.find(one => one.id === named || one.title.toLowerCase() === named.toLowerCase());
  if (named !== null && zoneStage === undefined) refuse("zone", `this flow has no zone called ${named}`);
  const zone = zoneStage?.id ?? null;
  switch (input.kind) {
    case "button": {
      const label = said(input.label) ?? refuse("label", "required");
      const questions = (Array.isArray(input.questions) ? input.questions : typeof input.questions === "string" ? input.questions.split("\n") : []).map(one => one.trim()).filter(one => one !== "");
      if (questions.length > 6) refuse("questions", "at most 6 items");
      questions.forEach((question, n) => { if (question.length > 80) refuse(`questions[${n}]`, "at most 80 characters"); });
      return { kind: "button", label, questions: questions.length === 0 ? ["What needs doing?", "Details"] : questions, zone };
    }
    case "schedule": {
      const said_ = said(input.schedule) ?? refuse("schedule", "required");
      const schedule = scheduleFromWords(said_) ?? refuse("schedule", "say it like “every 2 hours”, “daily 09:00 Europe/London”, “weekdays 09:00” or “monday 09:00”");
      // A script on a schedule (v90): each item it prints becomes a card.
      const script = said(input.script);
      if (script !== null) {
        if (context.store.flowScript(context.flow.repo, script) === null) refuse("script", `there's no script called ${script} in this project; make it on the flow's Scripts panel first`);
        const secrets = input.secrets === undefined ? [] : Array.isArray(input.secrets) ? input.secrets : input.secrets.split(/[\s,]+/).filter(one => one !== "");
        if (secrets.length > SECRETS_MAX || secrets.some(one => !/^[A-Z][A-Z0-9_]{0,39}$/.test(one))) refuse("secrets", "name up to 10 saved secrets in capitals, like API_TOKEN");
        return { kind: "schedule", schedule, title: `Items from ${script}`, description: null, zone, script, ...(secrets.length === 0 ? {} : { secrets: [...new Set(secrets)] }) };
      }
      return { kind: "schedule", schedule, title: said(input.title) ?? refuse("title", "required"), description: said(input.description), zone };
    }
    case "github": {
      const repo = said(input.repo) ?? githubRepoOf(context.flow.repo);
      if (repo === null || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) refuse("repo", "name the GitHub repository as owner/name");
      const watch = input.watch ?? "issues";
      const label = watch === "checks" ? null : said(input.label);
      const branch = watch === "checks" ? said(input.branch) ?? "main" : null;
      if (branch !== null && !/^[A-Za-z0-9._/-]+$/.test(branch)) refuse("branch", "that branch name isn't valid");
      return { kind: "github", repo: repo!, watch, label, branch, from: input.from ?? "team", delivery: input.delivery ?? "poll", zone };
    }
    case "linear": {
      const team = said(input.team), state = said(input.state), label = said(input.label);
      if (team !== null && !/^[A-Za-z0-9]+$/.test(team)) refuse("team", "a Linear team is its short key, like ENG");
      if (team === null && label === null) refuse("team", "name a Linear team or a label, so the trigger doesn't take every issue in the workspace");
      return { kind: "linear", team: team?.toUpperCase() ?? null, state, label, delivery: input.delivery ?? "poll", zone };
    }
    case "flow": {
      const flow = context.store.getFlow(input.flow);
      const sourceDefinition = flow === null ? null : flowDefinitionOf(flow);
      if (flow === null || flow.state !== "active" || sourceDefinition === null || !context.store.accountCanAccess(context.actor, flow.repo)) return refuse("flow", "choose another flow in your projects");
      if (flow.id === context.flow.id) refuse("flow", "a flow can't start cards in itself; move them with a zone's next step instead");
      const when = said(input.when);
      const stage = when === null ? sourceDefinition.stages.find(one => one.kind === "done") : sourceDefinition.stages.find(one => one.id === when || one.title.toLowerCase() === when.toLowerCase());
      if (stage === undefined) return refuse("when", `${flow.name} has no zone called ${when ?? "Done"}`);
      return { kind: "flow", flow: flow.id, when: stage.id, zone };
    }
    case "webhook":
      return { kind: "webhook", title: said(input.title) ?? "Webhook", titleField: said(input.titleField), bodyField: said(input.bodyField), zone };
    case "plane-review": {
      const at = said(input.at) ?? "07:30";
      const clock = /^(\d{1,2}):(\d{2})$/.exec(at);
      const zoneName = said(input.timeZone) ?? localTimeZone();
      const schedule = clock === null ? null : scheduleFromWords(`daily ${clock[1]}:${clock[2]} ${zoneName}`);
      if (schedule === null) return refuse("at", "say the time it reviews the day as HH:MM, like 07:30, and a time zone like Europe/London");
      return { kind: "plane-review", schedule, zone };
    }
    case "email": {
      const folder = said(input.folder) ?? "INBOX";
      const sender = said(input.sender);
      if (sender !== null && sendersOf(sender).length === 0) refuse("sender", "say whom mail comes from as addresses or domains, like priya@example.com or example.com");
      return { kind: "email", folder: /^inbox$/i.test(folder) ? "INBOX" : folder, sender: sender === null ? null : sendersOf(sender).join(", "), subject: said(input.subject), zone };
    }
  }
}

/** The computer's time zone, as the routines name one. */
function localTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

/** Addresses and domains from "priya@example.com, @shop.com, example.org". */
function sendersOf(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map(one => one.trim().toLowerCase().replace(/^@/, "")).filter(one => /^([a-z0-9._%+-]+@)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(one)))].slice(0, 20);
}

/** Whether an email is one this trigger takes: from a named sender (or domain), with the words in its subject. */
export function mailMatches(config: Extract<TriggerConfig, { kind: "email" }>, mail: { from: string; subject: string }): boolean {
  const from = mail.from.toLowerCase();
  const senders = config.sender === null ? [] : sendersOf(config.sender);
  if (senders.length > 0 && !senders.some(one => one.includes("@") ? from === one : from.endsWith(`@${one}`) || from.endsWith(`.${one}`))) return false;
  return config.subject === null || mail.subject.toLowerCase().includes(config.subject.toLowerCase());
}

/** The trigger in the words the canvas and its cards use. */
export function describeTrigger(config: TriggerConfig, store: Store): string {
  const from = (value: "team" | "anyone") => value === "team" ? ", from people with write access" : ", from anyone";
  const way = (delivery: "poll" | "webhook") => delivery === "poll" ? " (checked every 2 minutes)" : " (sent to its webhook address)";
  switch (config.kind) {
    case "button": return `The “${config.label}” button asks: ${config.questions.join(" · ")}`;
    case "schedule": {
      const schedule = parseSchedule(config.schedule);
      const when = schedule === null ? config.schedule : describeSchedule(schedule);
      return config.script !== undefined ? `${when.charAt(0).toUpperCase()}${when.slice(1)}: runs the ${config.script} script, and each item it prints becomes a card` : `${when.charAt(0).toUpperCase()}${when.slice(1)}: “${config.title}”`;
    }
    case "github":
      return config.watch === "checks" ? `Failed checks on ${config.branch} in ${config.repo}${way(config.delivery)}`
        : `${config.watch === "issues" ? "GitHub issues" : "Pull requests"} in ${config.repo}${config.label === null ? "" : ` labeled ${config.label}`}${from(config.from)}${way(config.delivery)}`;
    case "linear":
      return `Linear issues${config.team === null ? "" : ` in ${config.team}`}${config.state === null ? "" : ` that move to ${config.state}`}${config.label === null ? "" : ` labeled ${config.label}`}${way(config.delivery)}`;
    case "flow": {
      const flow = store.getFlow(config.flow);
      const zone = flow === null ? null : flowDefinitionOf(flow)?.stages.find(one => one.id === config.when)?.title ?? null;
      return `Cards reaching ${zone ?? "the end"} in ${flow?.name ?? "another flow"}`;
    }
    case "webhook": return "Anything posted to its webhook address";
    case "chat": return `Every new message in a ${CHAT_APP_NAMES[config.app]} channel; replies in a card's thread join its discussion`;
    case "plane-review": {
      const schedule = parseSchedule(config.schedule);
      return `Every day at ${schedule !== null && schedule.kind !== "every" ? schedule.hhmm : config.schedule}: reviews the last 24 hours of runs, tasks, sign-ins, chat, integrations and checks, and makes a card for each problem worth fixing`;
    }
    case "email": return `Email arriving in ${config.folder === "INBOX" ? "the inbox" : config.folder}${config.sender === null ? "" : ` from ${config.sender}`}${config.subject === null ? "" : ` with “${config.subject}” in the subject`} (checked every 2 minutes)`;
  }
}

/** The trigger in two short lines for the canvas: what it is, and the one detail that tells it apart. */
export function triggerHeadline(config: TriggerConfig, store: Store): { name: string; detail: string } {
  switch (config.kind) {
    case "button": return { name: config.label, detail: `Asks ${config.questions.length} question${config.questions.length === 1 ? "" : "s"}` };
    case "schedule": {
      const schedule = parseSchedule(config.schedule);
      const when = schedule === null ? config.schedule : schedule.kind === "every" ? describeSchedule(schedule) : `${schedule.kind === "daily" ? "daily" : schedule.kind === "weekdays" ? "weekdays" : `${WEEKDAYS[schedule.day]}s`} at ${schedule.hhmm}`;
      return { name: `${when.charAt(0).toUpperCase()}${when.slice(1)}`, detail: config.script !== undefined ? `Runs ${config.script}` : `“${config.title}”` };
    }
    case "github": return { name: config.watch === "checks" ? `Failed checks on ${config.branch}` : config.watch === "pulls" ? `New pull requests${config.label === null ? "" : ` labeled ${config.label}`}` : config.label === null ? "New issues" : `Issues labeled ${config.label}`, detail: `GitHub · ${config.repo}` };
    case "linear": return { name: `Linear${config.team === null ? "" : ` ${config.team}`}${config.state === null ? "" : ` → ${config.state}`}`, detail: config.label === null ? "Linear issues" : `Labeled ${config.label}` };
    case "flow": {
      const flow = store.getFlow(config.flow);
      return { name: `From ${flow?.name ?? "another flow"}`, detail: `When a card reaches ${flow === null ? "the end" : flowDefinitionOf(flow)?.stages.find(one => one.id === config.when)?.title ?? "the end"}` };
    }
    case "webhook": return { name: "Webhook", detail: "Anything posted to its address" };
    case "chat": return { name: `${CHAT_APP_NAMES[config.app]} channel`, detail: "Each message is a card" };
    case "plane-review": {
      const schedule = parseSchedule(config.schedule);
      return { name: `Plane review at ${schedule !== null && schedule.kind !== "every" ? schedule.hhmm : "a set time"}`, detail: "Problems from the last 24 hours" };
    }
    case "email": return { name: config.folder === "INBOX" ? "New email" : `New email in ${config.folder}`, detail: config.sender !== null ? `From ${config.sender}` : config.subject !== null ? `Subject has “${config.subject}”` : "Email inbox" };
  }
}

export function triggerConfigOf(trigger: FlowTriggerRow): TriggerConfig | null {
  let raw: unknown;
  try { raw = JSON.parse(trigger.configJson); } catch { return null; }
  const read = readTriggerConfig(raw);
  return read.ok ? read.value : null;
}

/** What a saved trigger leaves out, it had as these (every release has saved them whole; a hand-made row may not). */
const SAVED_DEFAULTS: Partial<Record<FlowTriggerKind, Record<string, unknown>>> = {
  button: { questions: ["What needs doing?", "Details"] }, schedule: { description: null }, github: { label: null, branch: null, from: "team", delivery: "poll" },
  linear: { team: null, state: null, label: null, delivery: "poll" }, webhook: { title: "Webhook", titleField: null, bodyField: null }, email: { folder: "INBOX", sender: null, subject: null },
};

/** A saved trigger's config (`configJson`, which carries no version) read by its one schema, what it leaves out filled. */
export function readTriggerConfig(raw: unknown): ContractResult<TriggerConfig> {
  const kind = isRecord(raw) ? raw["kind"] : undefined;
  const body = isRecord(raw) ? { zone: null, ...SAVED_DEFAULTS[kind as FlowTriggerKind], ...raw } : raw;
  return parseContract(triggerConfigSchema, body);
}

/** Whether this trigger takes deliveries at a secret address rather than being checked. */
export function takesDeliveries(config: TriggerConfig): boolean {
  return config.kind === "webhook" || ((config.kind === "github" || config.kind === "linear") && config.delivery === "webhook");
}

// ------------------------------------------------------ secrets on disk

const hookHash = (token: string) => createHash("sha256").update(token).digest("hex");
const secretFile = (dir: string, trigger: number) => join(dir, "flow-hooks", `${trigger}.json`);

/** A webhook's signing secret (GitHub: made here; Linear: pasted from Linear). 0600, beside the database, never a column. */
export function saveHookSecret(dir: string, trigger: number, secret: string): void {
  mkdirSync(join(dir, "flow-hooks"), { recursive: true, mode: 0o700 });
  writeFileSync(secretFile(dir, trigger), `${JSON.stringify({ secret })}\n`, { mode: 0o600 });
  chmodSync(secretFile(dir, trigger), 0o600);
}
export function readHookSecret(dir: string, trigger: number): string | null {
  try { const parsed = JSON.parse(readFileSync(secretFile(dir, trigger), "utf8")) as { secret?: unknown }; return typeof parsed.secret === "string" && parsed.secret !== "" ? parsed.secret : null; } catch { return null; }
}
function dropHookSecret(dir: string, trigger: number): void { rmSync(secretFile(dir, trigger), { force: true }); }

const LINEAR_FILE = "linear-key";
export const LINEAR_ENV = "TOOLROLL_LINEAR_KEY";
/** The Linear API key the worker checks Linear with: the environment, or a 0600 file beside the database. */
export function readLinearKey(dir: string | null): string | null {
  const env = envValue(process.env, "LINEAR_KEY")?.trim();
  if (env) return env;
  if (dir === null) return null;
  try { const key = readFileSync(join(dir, LINEAR_FILE), "utf8").trim(); return key === "" ? null : key; } catch { return null; }
}
export function saveLinearKey(dir: string, key: string): { ok: true } | { ok: false; message: string } {
  const clean = key.trim();
  if (!/^lin_(api|oauth)_[A-Za-z0-9]{20,}$/.test(clean)) return { ok: false, message: "That doesn't look like a Linear API key. Copy it from Linear → Settings → Security & access → Personal API keys." };
  writeFileSync(join(dir, LINEAR_FILE), `${clean}\n`, { mode: 0o600 });
  chmodSync(join(dir, LINEAR_FILE), 0o600);
  return { ok: true };
}
export function removeLinearKey(dir: string): void { rmSync(join(dir, LINEAR_FILE), { force: true }); }

const HOOKS_FILE = "hooks-url";
/** The public address webhooks reach this console at (a reverse proxy such as Caddy, exposing /hooks/ only). */
export function readHooksBase(dir: string | null): string | null {
  if (dir === null) return null;
  try { const base = readFileSync(join(dir, HOOKS_FILE), "utf8").trim(); return base === "" ? null : base; } catch { return null; }
}
export function saveHooksBase(dir: string, value: string): { ok: true; base: string | null } | { ok: false; message: string } {
  const clean = value.trim().replace(/\/+$/, "");
  if (clean === "") { rmSync(join(dir, HOOKS_FILE), { force: true }); return { ok: true, base: null }; }
  let url: URL;
  try { url = new URL(clean); } catch { return { ok: false, message: "Give the address as https://your-domain." }; }
  if (url.protocol !== "https:" || url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") return { ok: false, message: "Give the address as https://your-domain, without a path's query or a password." };
  writeFileSync(join(dir, HOOKS_FILE), `${url.origin}${url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "")}\n`, { mode: 0o600 });
  return { ok: true, base: readHooksBase(dir) };
}
export const HOOK_PATH = "/hooks/flow/";

// ------------------------------------------------------------- setting up

export type TriggerReveal = { path: string; address: string | null; secret: string | null };
export type TriggerMade = { ok: true; id: number; said: string; reveal: TriggerReveal | null } | { ok: false; message: string };

/** Add a trigger to a flow. A webhook trigger's address (and GitHub's signing secret) is returned once and never stored readable. */
export function addFlowTriggerTo(store: Store, flow: FlowRow, raw: unknown, actor: string, now: Date, dir: string | null): TriggerMade {
  const definition = flowDefinitionOf(flow);
  if (definition === null || flow.state !== "active") return { ok: false, message: "This flow can't take triggers right now." };
  let config: TriggerConfig;
  try { config = validateTriggerConfig(raw, { store, flow, definition, actor }); } catch (error) { return { ok: false, message: error instanceof Error ? error.message : "That trigger isn't valid." }; }
  if (takesDeliveries(config) && dir === null) return { ok: false, message: "Webhook addresses are set up on the console." };
  const token = takesDeliveries(config) ? randomBytes(24).toString("base64url") : null;
  const schedule = config.kind === "schedule" || config.kind === "plane-review" ? parseSchedule(config.schedule) : null;
  const id = store.addFlowTrigger({
    // The table's kinds were fixed before plane reviews: one is kept as the daily schedule it is.
    flow: flow.id, kind: config.kind === "plane-review" ? "schedule" : config.kind, configJson: JSON.stringify(config), hookHash: token === null ? null : hookHash(token),
    // Only what happens from now on: never the backlog of issues, runs or finished cards.
    cursor: config.kind === "flow" ? String(store.latestFlowEvent()) : config.kind === "github" || config.kind === "linear" ? now.toISOString() : null,
    // Email: the first check notes where the mailbox stands (no cursor yet), so only mail after this becomes cards.
    nextAt: schedule !== null ? firstFireAt(schedule, now) : polled(config) ? now.toISOString() : null,
    by: actor,
  }, now);
  let secret: string | null = null;
  if (config.kind === "github" && config.delivery === "webhook") { secret = randomBytes(24).toString("hex"); saveHookSecret(dir!, id, secret); }
  const reveal = token === null ? null : { path: `${HOOK_PATH}${token}`, address: dir === null || readHooksBase(dir) === null ? null : `${readHooksBase(dir)}${HOOK_PATH}${token}`, secret };
  return { ok: true, id, said: token === null ? "Trigger added." : "Trigger added. Copy its address now; it isn't shown again.", reveal };
}

/** A new secret address for a webhook trigger (the old one stops working at once). */
export function renewFlowHook(store: Store, trigger: FlowTriggerRow, now: Date, dir: string): TriggerMade {
  const config = triggerConfigOf(trigger);
  if (config === null || !takesDeliveries(config) || trigger.state === "removed") return { ok: false, message: "That trigger has no webhook address." };
  const token = randomBytes(24).toString("base64url");
  store.updateFlowTrigger(trigger.id, { hookHash: hookHash(token) }, now);
  let secret: string | null = null;
  if (config.kind === "github") { secret = randomBytes(24).toString("hex"); saveHookSecret(dir, trigger.id, secret); }
  const base = readHooksBase(dir);
  return { ok: true, id: trigger.id, said: "New address made; the old one no longer works. Copy it now; it isn't shown again.", reveal: { path: `${HOOK_PATH}${token}`, address: base === null ? null : `${base}${HOOK_PATH}${token}`, secret } };
}

export function removeFlowTrigger(store: Store, trigger: FlowTriggerRow, now: Date, dir: string | null): void {
  store.updateFlowTrigger(trigger.id, { state: "removed", hookHash: null }, now);
  if (dir !== null) dropHookSecret(dir, trigger.id);
}

/** Checked by the worker's pass (rather than pushed, fired on a schedule or followed). */
function polled(config: TriggerConfig): config is Extract<TriggerConfig, { kind: "github" | "linear" | "email" }> {
  return config.kind === "email" || ((config.kind === "github" || config.kind === "linear") && config.delivery === "poll");
}

// ---------------------------------------------------------- making cards

export type Incoming = { key: string; title: string; description: string | null; source: FlowCardSource };
type Made = "added" | "seen" | "skipped";

function startZone(config: TriggerConfig, definition: FlowDefinition): string {
  return config.zone !== null && definition.stages.some(one => one.id === config.zone) ? config.zone : definition.start;
}

/** The active flow that already made a card for this failing commit in a project, if any. */
function checksCardOf(store: Store, repo: string, key: string): string | null {
  const row = store.handle.prepare(`SELECT f.name FROM flow_trigger_event e JOIN flow_trigger t ON t.id = e.trigger JOIN flow f ON f.id = t.flow
    WHERE f.repo = ? AND f.state = 'active' AND e.key = ? AND e.card IS NOT NULL LIMIT 1`).get(repo, key);
  return row === undefined ? null : `“${String(row["name"])}”`;
}

/** One outside thing into one card, at most once per trigger (a failing run, once per project). Keys and control characters never reach a card. */
function makeCard(store: Store, trigger: FlowTriggerRow, config: TriggerConfig, item: Incoming, by: string, now: Date): { made: Made; note: string | null; card: number | null } {
  const flow = store.getFlow(trigger.flow);
  const definition = flow === null ? null : flowDefinitionOf(flow);
  if (flow === null || definition === null || flow.state !== "active") return { made: "skipped", note: "the flow isn't active", card: null };
  if (store.flowTriggerSaw(trigger.id, item.key)) return { made: "seen", note: null, card: null };
  const text = flowCardText(item.title, item.description);
  if ("problem" in text) {
    const note = text.problem.startsWith("That looks like a key") ? "it looked like it held a key or password" : text.problem;
    store.recordFlowTriggerEvent(trigger.id, item.key, null, note, now);
    return { made: "skipped", note: `${item.source.label}: ${note}`, card: null };
  }
  // Claimed inside the write lock: a worker and a console (or an old and a new worker) checking at once make one card.
  return store.transact(() => {
    if (store.flowTriggerSaw(trigger.id, item.key)) return { made: "seen" as const, note: null, card: null };
    // One failing run is one fix: a second trigger watching the same checks in this project leaves it to the first.
    const filed = item.key.startsWith("checks:") ? checksCardOf(store, flow.repo, item.key) : null;
    if (filed !== null) {
      const note = `already a card in ${filed}`;
      store.recordFlowTriggerEvent(trigger.id, item.key, null, note, now);
      return { made: "skipped" as const, note: `${item.source.label}: ${note}`, card: null };
    }
    const card = store.addFlowCard({ flow: flow.id, title: text.title, description: text.description, stage: startZone(config, definition), by, source: item.source }, now);
    store.recordFlowTriggerEvent(trigger.id, item.key, card, null, now);
    return { made: "added" as const, note: null, card };
  });
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
function outcomeWords(results: { made: Made; note: string | null }[], more: boolean): string {
  const added = results.filter(one => one.made === "added").length;
  const skipped = results.filter(one => one.made === "skipped");
  const parts = [added > 0 ? `Added ${plural(added, "card")}.` : skipped.length > 0 ? "No new cards." : "Nothing new."];
  if (skipped.length > 0) parts.push(`Left out ${plural(skipped.length, "item")}: ${skipped[0]!.note}${skipped.length > 1 ? ", and others" : ""}.`);
  if (more) parts.push("More on the next check.");
  return parts.join(" ");
}

/** One outside thing into one card through a trigger (a chat channel's message, v89): at most once per key. */
export function addTriggerCard(store: Store, trigger: FlowTriggerRow, item: Incoming, by: string, now: Date): { made: Made; note: string | null; card: number | null } {
  const config = triggerConfigOf(trigger);
  if (config === null || trigger.state !== "active") return { made: "skipped", note: "the trigger isn't active", card: null };
  return makeCard(store, trigger, config, item, by, now);
}

/** Press a button trigger: the first answer is the card's title, the rest its details. */
export function pressFlowButton(store: Store, trigger: FlowTriggerRow, answers: readonly unknown[], actor: string, now: Date): FlowAct {
  const config = triggerConfigOf(trigger);
  if (config?.kind !== "button" || trigger.state !== "active") return { ok: false, message: "That button isn't available." };
  const said = config.questions.map((_question, index) => typeof answers[index] === "string" ? (answers[index] as string).trim() : "");
  if (said[0] === "") return { ok: false, message: `Answer “${config.questions[0]}”.` };
  const details = config.questions.slice(1).map((question, index) => said[index + 1] === "" ? null : `${question}\n${said[index + 1]}`).filter(one => one !== null).join("\n\n");
  const result = makeCard(store, trigger, config, { key: `press:${now.toISOString()}:${randomUUID().slice(0, 8)}`, title: said[0]!, description: details === "" ? null : details, source: { kind: "button", label: config.label, url: null } }, actor, now);
  if (result.made !== "added") return { ok: false, message: result.note ?? "That didn't make a card." };
  store.setFlowCardWatcher(result.card!, actor, true, now);
  store.updateFlowTrigger(trigger.id, { lastAt: now.toISOString(), lastOutcome: `Pressed by ${actor}.` }, now);
  return { ok: true, said: "Card added.", card: result.card! };
}

// -------------------------------------------------- the worker's pass

export type TriggerIo = { gh: Runner; fetch: typeof fetch; dir: string | null;
  /** How mail is read (default: IMAP; tests pass a scripted mailbox). */
  mail?: MailReader;
  /** v90: how a schedule's script runs (default: the same runner as gh) and where (default: beside the database). */
  shell?: Runner; scratch?: string };
export type TriggerPass = { added: number; checked: number; problems: string[] };

/** Every trigger in one project that is due: schedules and other flows here, GitHub, Linear and email by asking them. */
export async function runFlowTriggers(store: Store, repo: string, now: Date, io: TriggerIo): Promise<TriggerPass> {
  const pass: TriggerPass = { added: 0, checked: 0, problems: [] };
  for (const trigger of store.activeFlowTriggers(repo)) {
    const config = triggerConfigOf(trigger);
    if (config === null) continue;
    try {
      if (config.kind === "schedule" && config.script !== undefined && trigger.nextAt !== null && Date.parse(trigger.nextAt) <= now.getTime()) {
        const fired = await fireScript(store, trigger, config, now, io, true);
        pass.added += fired.added;
        if (!fired.ok) pass.problems.push(`trigger ${trigger.id}: ${fired.said}`);
      }
      else if (config.kind === "schedule" && trigger.nextAt !== null && Date.parse(trigger.nextAt) <= now.getTime()) pass.added += fireSchedule(store, trigger, config, now);
      else if (config.kind === "plane-review" && trigger.nextAt !== null && Date.parse(trigger.nextAt) <= now.getTime()) pass.added += (await firePlaneReview(store, trigger, config, now, true)).added;
      else if (config.kind === "flow") pass.added += followFlow(store, trigger, config, now);
      else if (polled(config) && (trigger.nextAt === null || Date.parse(trigger.nextAt) <= now.getTime())) {
        pass.checked++;
        const checked = await checkTrigger(store, trigger, config, now, io);
        pass.added += checked.added;
        if (!checked.ok) pass.problems.push(`trigger ${trigger.id}: ${checked.said}`);
      }
    } catch (error) {
      pass.problems.push(`trigger ${trigger.id}: ${error instanceof Error ? error.message : "could not run"}`);
    }
  }
  return pass;
}

/** "Check now" on the canvas: one trigger, right away, in words. */
export async function checkFlowTriggerNow(store: Store, trigger: FlowTriggerRow, now: Date, io: TriggerIo): Promise<{ ok: boolean; said: string }> {
  const config = triggerConfigOf(trigger);
  // A schedule's script runs now, once; its schedule stays as it is.
  if (config?.kind === "schedule" && config.script !== undefined) { const fired = await fireScript(store, trigger, config, now, io, false); return { ok: fired.ok, said: fired.said }; }
  if (config?.kind === "plane-review") { const fired = await firePlaneReview(store, trigger, config, now, false); return { ok: true, said: fired.said }; }
  if (config === null || !polled(config)) return { ok: false, said: "Only GitHub, Linear and email triggers that are checked, schedules that run a script, and plane reviews can be run now." };
  const checked = await checkTrigger(store, trigger, config, now, io);
  return { ok: checked.ok, said: checked.said };
}

function fireSchedule(store: Store, trigger: FlowTriggerRow, config: Extract<TriggerConfig, { kind: "schedule" }>, now: Date): number {
  const schedule = parseSchedule(config.schedule);
  if (schedule === null || trigger.nextAt === null) return 0;
  const slot = trigger.nextAt;
  const next = nextFireAt(schedule, slot, now);
  // One card at a time: while the last one still waits where it started, the slot is skipped, not piled up.
  const last = store.lastFlowTriggerCard(trigger.id);
  const card = last === null ? null : store.getFlowCard(last);
  const flow = store.getFlow(trigger.flow);
  const definition = flow === null ? null : flowDefinitionOf(flow);
  if (card !== null && definition !== null && card.state === "active" && card.stage === startZone(config, definition) && card.entry === 1) {
    store.recordFlowTriggerEvent(trigger.id, `slot:${slot}`, null, "the last one hadn't been picked up", now);
    store.updateFlowTrigger(trigger.id, { nextAt: next, lastAt: now.toISOString(), lastOutcome: "Skipped: the last card hasn't been picked up yet." }, now);
    return 0;
  }
  const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: schedule.kind === "every" ? "UTC" : schedule.timezone ?? "UTC" }).format(new Date(slot));
  const fill = (text: string) => text.replace(/\{\{\s*date\s*\}\}/g, day);
  const title = /\{\{\s*date\s*\}\}/.test(config.title) ? fill(config.title) : `${config.title} — ${day}`;
  const made = makeCard(store, trigger, config, { key: `slot:${slot}`, title, description: config.description === null ? null : fill(config.description), source: { kind: "schedule", label: "Schedule", url: null } }, "Schedule", now);
  store.updateFlowTrigger(trigger.id, { nextAt: next, lastAt: now.toISOString(), lastOutcome: made.made === "added" ? "Added a card." : made.note ?? "Nothing new." }, now);
  return made.made === "added" ? 1 : 0;
}

/** The problem a plane review's event key names, and the day: `plane:<problem>:<YYYY-MM-DD>`. */
const planeKey = (problem: string, day: string) => `plane:${problem}:${day}`;

/** The card a plane review last made or joined for one problem, if any. */
function planeCardOf(store: Store, trigger: number, problem: string): number | null {
  const prefix = `plane:${problem}:`;
  const row = store.handle.prepare("SELECT card FROM flow_trigger_event WHERE trigger = ? AND substr(key, 1, ?) = ? AND card IS NOT NULL ORDER BY rowid DESC LIMIT 1").get(trigger, prefix.length, prefix);
  return row === undefined ? null : Number(row["card"]);
}

/**
 * A plane review: the last 24 hours, one card per problem worth fixing. Each problem is noted once a day; a problem
 * whose card is still open joins it (a note with the day's counts and evidence) instead of making another, and one
 * whose card is finished starts a new card, since it came back. A clean day adds nothing and tells nobody.
 * `scheduled` moves the trigger to its next morning; "Run now" leaves its times alone.
 */
export async function firePlaneReview(store: Store, trigger: FlowTriggerRow, config: Extract<TriggerConfig, { kind: "plane-review" }>, now: Date, scheduled: boolean): Promise<{ added: number; joined: number; said: string }> {
  const schedule = parseSchedule(config.schedule);
  const next = scheduled && schedule !== null && trigger.nextAt !== null ? nextFireAt(schedule, trigger.nextAt, now) : trigger.nextAt;
  const flow = store.getFlow(trigger.flow);
  const done = (said: string, added = 0, joined = 0) => {
    store.updateFlowTrigger(trigger.id, { nextAt: next, lastAt: now.toISOString(), lastOutcome: said }, now);
    return { added, joined, said };
  };
  if (flow === null || flow.state !== "active") return done("The flow isn't active.");
  // Loaded when a review first runs: the reader reaches the integrations and task status, which reach back to these triggers.
  const { longPersonWaits, longWaitWords, problemCard, problemText, reviewPlane } = await import("./plane-review.js");
  // Only the projects the flow's owner may see: a flow's cards are read by everyone on its project.
  const owner = store.accountOf(flow.owner);
  const canSee = (repo: string | null) => owner === null || (repo !== null && store.accountCanAccess(flow.owner, repo)) || (repo === null && owner.projects === null);
  const problems = reviewPlane(store, now, canSee);
  // Long waits on a person are said here once, linked to Needs you (planeStatusLink), and file nothing.
  const waited = longWaitWords(longPersonWaits(store, now, canSee));
  const said = (words: string) => waited === null ? words : `${words} ${waited}`;
  const timeZone = schedule !== null && schedule.kind !== "every" ? schedule.timezone ?? "UTC" : "UTC";
  const day = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(now);
  const dayWords = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone }).format(now);
  let added = 0, joined = 0;
  const skipped: string[] = [];
  for (const problem of problems) {
    const key = planeKey(problem.key, day);
    if (store.flowTriggerSaw(trigger.id, key)) continue;
    const had = planeCardOf(store, trigger.id, problem.key);
    const card = had === null ? null : store.getFlowCard(had);
    if (card !== null && card.state === "active") {
      store.transact(() => {
        store.addFlowComment({ card: card.id, author: "Plane review", body: `Again — ${problemText(problem, dayWords)}`.slice(0, 4000), mentions: [] }, now);
        store.recordFlowTriggerEvent(trigger.id, key, card.id, problem.summary, now);
      });
      joined++;
      continue;
    }
    const text = problemCard(problem, dayWords);
    const made = makeCard(store, trigger, config, { key, title: text.title, description: text.description, source: { kind: "plane-review", label: "Plane review", url: null } }, "Plane review", now);
    if (made.made === "added") added++;
    else if (made.note !== null) skipped.push(made.note);
  }
  if (problems.length === 0) return done(said("A clean day: nothing to fix."));
  const parts = [added > 0 ? `Added ${plural(added, "card")}.` : null, joined > 0 ? `${plural(joined, "problem")} came back and joined ${joined === 1 ? "its card" : "their cards"}.` : null,
    skipped.length > 0 ? `Left out ${plural(skipped.length, "problem")}: ${skipped[0]}.` : null].filter(one => one !== null);
  return done(said(parts.length === 0 ? "Nothing new since this morning's review." : parts.join(" ")), added, joined);
}

/** Where a person sees everything that waits on them. */
export const NEEDS_YOU_HREF = "/work?view=needs-you";

/** A plane review whose summary mentions long waits on a person links to Needs you. */
export function planeStatusLink(config: TriggerConfig | null, status: string | null): { label: string; href: string } | null {
  return config?.kind === "plane-review" && status !== null && /waited over \d+ days for you\.$/.test(status) ? { label: "Needs you", href: NEEDS_YOU_HREF } : null;
}

/** v96: a schedule (a teammate's routine) makes its card now, once per press, and keeps its own times. */
export function runScheduleNow(store: Store, trigger: FlowTriggerRow, actor: string, now: Date): { ok: true; card: number } | { ok: false; said: string } {
  const config = triggerConfigOf(trigger);
  if (config?.kind !== "schedule" || config.script !== undefined) return { ok: false, said: "Only a schedule without a script runs this way." };
  if (trigger.state !== "active") return { ok: false, said: "It's paused." };
  const made = makeCard(store, trigger, config, { key: `now:${now.toISOString()}`, title: config.title.replace(/\{\{\s*date\s*\}\}/g, "today"), description: config.description, source: { kind: "schedule", label: `Run now by ${actor}`, url: null } }, "Schedule", now);
  if (made.made !== "added" || made.card === null) return { ok: false, said: made.note ?? "Nothing was added." };
  store.updateFlowTrigger(trigger.id, { lastAt: now.toISOString(), lastOutcome: "Added a card (run now)." }, now);
  return { ok: true, card: made.card };
}

/** A schedule's script (v90): it runs in a clean folder inside the agents' fence; each item it prints is a card, once. */
async function fireScript(store: Store, trigger: FlowTriggerRow, config: Extract<TriggerConfig, { kind: "schedule" }>, now: Date, io: TriggerIo, scheduled: boolean): Promise<{ ok: boolean; said: string; added: number }> {
  const schedule = parseSchedule(config.schedule);
  const next = scheduled && schedule !== null && trigger.nextAt !== null ? nextFireAt(schedule, trigger.nextAt, now) : trigger.nextAt;
  const flow = store.getFlow(trigger.flow);
  const done = (ok: boolean, said: string, added = 0) => {
    store.updateFlowTrigger(trigger.id, { nextAt: next, lastAt: now.toISOString(), lastOutcome: said, failures: ok ? 0 : trigger.failures + 1 }, now);
    return { ok, said, added };
  };
  const script = flow === null ? null : store.flowScript(flow.repo, config.script!);
  if (flow === null || script === null) return done(false, `There's no script called ${config.script} in this project any more.`);
  if (script.held !== null) return done(false, `The ${script.name} script came with an imported flow. Approve it on the Scripts panel to run it.`);
  const saved = readFlowSecrets(io.dir, flow.repo);
  const missing = (config.secrets ?? []).filter(name => saved[name] === undefined);
  if (missing.length > 0) return done(false, `${script.name} needs the secret${missing.length === 1 ? "" : "s"} ${missing.join(", ")}. Save ${missing.length === 1 ? "it" : "them"} on the flow first.`);
  // Loaded when a script first runs: the runner reaches the builder's modules, which reach back to these triggers.
  const { cardsFromOutput, cleanFolder, runCode } = await import("./flow-code.js");
  const { agentFence } = await import("./agent-fence.js");
  const scratch = io.scratch ?? join(io.dir ?? tmpdir(), "flow-scratch");
  const folder = cleanFolder(scratch, `flow-trigger-${trigger.id}`);
  let ran: CodeResult;
  try {
    ran = await runCode({ script, cwd: folder, root: flow.repo, scratch, shell: io.shell ?? io.gh,
      input: { flow: { id: flow.id, name: flow.name }, trigger: trigger.id, lastRun: trigger.lastAt }, secrets: Object.fromEntries((config.secrets ?? []).map(name => [name, saved[name]!])),
      env: { FLOW_NAME: flow.name, FLOW_TRIGGER_ID: String(trigger.id), FLOW_PROJECT: flow.repo, FLOW_LAST_RUN: trigger.lastAt ?? "" },
      fence: agentFence({ databaseFile: store.databaseFile(), worktree: folder }) });
  } finally { rmSync(folder, { recursive: true, force: true }); }
  if (ran.state === "failed") return done(false, ran.said.split("\n")[0]!);
  const items = cardsFromOutput(ran.printed);
  const results = items.slice(0, CARDS_PER_CHECK).map(item => makeCard(store, trigger, config, {
    key: `script:${item.key}`, title: item.title, description: item.description, source: { kind: "script", label: `The ${script.name} script`, url: null },
  }, `The ${script.name} script`, now));
  return done(true, items.length === 0 ? `${script.name} ran and printed nothing to add.` : outcomeWords(results, items.length > CARDS_PER_CHECK), results.filter(one => one.made === "added").length);
}

function followFlow(store: Store, trigger: FlowTriggerRow, config: Extract<TriggerConfig, { kind: "flow" }>, now: Date): number {
  const source = store.getFlow(config.flow);
  const after = Number(trigger.cursor ?? 0);
  const arrivals = source === null ? [] : store.flowArrivals(source.id, config.when, after, CARDS_PER_CHECK);
  if (arrivals.length === 0) return 0;
  const results = arrivals.map(({ card }) => makeCard(store, trigger, config, {
    key: `card:${card.id}`, title: card.title, description: card.description,
    source: { kind: "flow", label: `${source!.name}: ${card.title}`.slice(0, 120), url: `/flows/${source!.id}?card=${card.id}` },
  }, `the ${source!.name} flow`, now));
  store.updateFlowTrigger(trigger.id, { cursor: String(arrivals.at(-1)!.event), lastAt: now.toISOString(), lastOutcome: outcomeWords(results, arrivals.length === CARDS_PER_CHECK) }, now);
  return results.filter(one => one.made === "added").length;
}

type Checked = { ok: boolean; said: string; added: number };

async function checkTrigger(store: Store, trigger: FlowTriggerRow, config: Extract<TriggerConfig, { kind: "github" | "linear" | "email" }>, now: Date, io: TriggerIo): Promise<Checked> {
  const fetched = config.kind === "github" ? await fetchGitHub(config, trigger, io.gh) : config.kind === "linear" ? await fetchLinear(config, trigger, io) : await fetchMail(store, config, trigger, io, now);
  if (!fetched.ok) {
    const failures = trigger.failures + 1;
    store.updateFlowTrigger(trigger.id, { failures, lastAt: now.toISOString(), lastOutcome: fetched.problem, nextAt: new Date(now.getTime() + BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1]!).toISOString() }, now);
    return { ok: false, said: fetched.problem, added: 0 };
  }
  const by = config.kind === "github" ? "GitHub" : config.kind === "linear" ? "Linear" : "Email";
  const due = fetched.items.slice(0, CARDS_PER_CHECK);
  const results = due.map(item => "skip" in item
    ? (store.recordFlowTriggerEvent(trigger.id, item.key, null, item.skip, now) ? { made: "skipped" as Made, note: `${item.label}: ${item.skip}`, card: null } : { made: "seen" as Made, note: null, card: null })
    : makeCard(store, trigger, config, item, by, now));
  // A mailbox says itself whether more is waiting; its cursor is already just past what it read.
  const more = fetched.more ?? fetched.items.length > CARDS_PER_CHECK;
  // The cursor moves past what was handled, never past what is still waiting.
  const cursor = fetched.more !== undefined ? fetched.cursor ?? trigger.cursor : more ? due.at(-1)?.at ?? trigger.cursor : fetched.cursor ?? trigger.cursor;
  const said = results.length === 0 && fetched.said !== undefined ? fetched.said : outcomeWords(results, more);
  store.updateFlowTrigger(trigger.id, { failures: 0, cursor, lastAt: now.toISOString(), lastOutcome: said, nextAt: new Date(now.getTime() + POLL_EVERY_MS).toISOString() }, now);
  return { ok: true, said, added: results.filter(one => one.made === "added").length };
}

type Found = (Incoming & { at: string | null }) | { key: string; skip: string; label: string; at: string | null };
type Fetched = { ok: true; items: Found[]; cursor: string | null; more?: boolean; said?: string } | { ok: false; problem: string };

/** New mail in the folder since the last check, each message a card (or why it was left out). */
async function fetchMail(store: Store, config: Extract<TriggerConfig, { kind: "email" }>, trigger: FlowTriggerRow, io: TriggerIo, now: Date): Promise<Fetched> {
  const signed = await mailboxAccess(io.dir, io.fetch);
  if (!signed.ok) return { ok: false, problem: signed.said };
  const after = mailCursorOf(trigger.cursor);
  const read = await (io.mail ?? readThroughImap)(signed.access, config.folder, after, CARDS_PER_CHECK);
  if (!read.ok) return { ok: false, problem: read.said };
  const own = signed.address.toLowerCase();
  const items: Found[] = read.mails.map(readInboundMail).filter(mail => mailMatches(config, mail)).map(mail => {
    const key = `mail:${read.at.validity}:${mail.uid}`, at = mailCursorText({ validity: read.at.validity, uid: mail.uid });
    const label = `Email from ${mail.from || "an unknown sender"}`.slice(0, 120);
    // Machines and this account itself never start cards: a flow that answers mail mustn't answer them.
    if (mail.automatic) return { key, skip: "an automatic reply", label, at };
    if (mail.from === own) return { key, skip: "sent from this account", label, at };
    if (mail.from === "") return { key, skip: "it had no sender", label, at };
    // A reply to a card's email (v91) joins that card instead of starting another.
    const reply = takeReply(store, mail, own, now);
    if (reply !== null) return { key, skip: `a reply to “${reply.card.title}”`, label, at };
    const who = mail.fromName === null ? mail.from : `${mail.fromName} <${mail.from}>`;
    return { key, at, title: mail.subject || `Email from ${mail.fromName ?? mail.from}`, description: `From: ${who}${mail.text === "" ? "" : `\n\n${mail.text}`}`,
      source: { kind: "email", label, url: null, mail: { id: mail.messageId, references: mail.references, subject: mail.subject, from: mail.from } } };
  });
  const said = after === null ? `Watching ${config.folder === "INBOX" ? "the inbox" : config.folder} of ${signed.address}: new email from now on becomes cards.`
    : read.renumbered ? "The mail server renumbered this folder; watching it from now." : undefined;
  return { ok: true, items, cursor: mailCursorText(read.at), more: read.more, ...(said === undefined ? {} : { said }) };
}

/** A GitHub issue or pull request as a card, or why it is left out; null when it doesn't match. */
export function githubItem(config: Extract<TriggerConfig, { kind: "github" }>, raw: unknown, what: "issue" | "pull"): Found | null {
  const item = readGithubIssue(raw);
  const number = Number(item.number);
  if (!Number.isSafeInteger(number)) return null;
  if (what === "issue" && item.pull_request !== undefined) return null;
  if (what === "pull" && item.draft === true) return null;
  const labels = (item.labels ?? []).map(one => (one.name ?? "").toLowerCase());
  if (config.label !== null && !labels.includes(config.label.toLowerCase())) return null;
  const label = what === "issue" ? `GitHub issue #${number}` : `Pull request #${number}`;
  const key = `${what}:${number}`, at = item.updated_at || null;
  if (config.from === "team" && !TEAM.has(item.author_association ?? "")) return { key, skip: "opened by someone without write access", label, at };
  const login = item.user?.login || "someone";
  const branches = what === "pull" ? ` (${item.head?.ref ?? ""} → ${item.base?.ref ?? ""})` : "";
  return { key, at, title: item.title || label,
    description: `From ${what === "issue" ? "GitHub issue" : "pull request"} #${number} by @${login}${branches}:\n\n${item.body ?? ""}`.trim().slice(0, 4000),
    source: { kind: "github", label, url: item.html_url || null } };
}

/** A failed workflow run as a card: one card per failing commit on the watched branch. */
export function githubRunItem(config: Extract<TriggerConfig, { kind: "github" }>, raw: unknown): Found | null {
  const run = readGithubRun(raw);
  if (run.conclusion !== "failure" || (config.branch !== null && (run.head_branch ?? "") !== config.branch)) return null;
  const sha = run.head_sha ?? "";
  if (sha === "") return null;
  const name = run.name || "Checks";
  const commit = run.display_title ?? "";
  return { key: `checks:${sha}`, at: run.created_at || null, title: `Checks failed on ${config.branch}: ${name}`,
    description: `From GitHub: “${name}” failed on ${config.branch} at ${sha.slice(0, 7)}${commit === "" ? "" : ` (${commit})`}.\nRun: ${run.html_url ?? ""}`,
    source: { kind: "github", label: `Failed check on ${config.branch}`, url: run.html_url || null } };
}

async function fetchGitHub(config: Extract<TriggerConfig, { kind: "github" }>, trigger: FlowTriggerRow, gh: Runner): Promise<Fetched> {
  const since = trigger.cursor ?? trigger.createdAt;
  // A label trigger follows the moment the label is added (issue events), so an old labeled issue that merely gets a comment makes no card.
  const labelEvents = config.watch === "issues" && config.label !== null;
  const path = labelEvents ? `repos/${config.repo}/issues/events?per_page=50`
    : config.watch === "issues" ? `repos/${config.repo}/issues?state=open&sort=created&direction=desc&per_page=30`
    : config.watch === "pulls" ? `repos/${config.repo}/pulls?state=open&sort=created&direction=desc&per_page=30`
    : `repos/${config.repo}/actions/runs?branch=${encodeURIComponent(config.branch ?? "main")}&status=failure&per_page=20`;
  let result;
  try { result = await gh("gh", ["api", "-H", "Accept: application/vnd.github+json", path], { timeoutMs: 20_000 }); }
  catch { return { ok: false, problem: "Couldn't run gh, GitHub's command-line tool. Install it and sign in with gh auth login." }; }
  if (result.code !== 0) {
    const line = `${result.stderr}\n${result.stdout}`.split("\n").map(one => one.trim()).find(one => one !== "") ?? "";
    return { ok: false, problem: /404|not found/i.test(line) ? `GitHub can't find ${config.repo}, or your GitHub login can't see it.`
      : /401|auth|login/i.test(line) ? "GitHub needs you to sign in again: run gh auth login." : `GitHub didn't answer: ${line.replace(/[^\x20-\x7e]/g, "").slice(0, 160)}` };
  }
  let body: unknown;
  try { body = JSON.parse(result.stdout); } catch { return { ok: false, problem: "GitHub's answer couldn't be read." }; }
  const created = Date.parse(trigger.createdAt);
  if (config.watch === "checks") {
    const runs = (readGithubRunList(body).workflow_runs ?? []).filter(one => Date.parse(one.created_at ?? "") > created);
    const items = runs.reverse().map(one => githubRunItem(config, one)).filter((one): one is Found => one !== null);
    return { ok: true, items: unique(items), cursor: trigger.cursor };
  }
  if (labelEvents) {
    const labeled = readGithubIssueEventList(body).filter(one => one.event === "labeled" && (one.label?.name ?? "").toLowerCase() === config.label!.toLowerCase()
      && Date.parse(one.created_at ?? "") > Date.parse(since)).reverse();
    const items = labeled.map(one => { const item = githubItem(config, one.issue, "issue"); return item === null ? null : { ...item, at: one.created_at || null }; }).filter((one): one is Found => one !== null);
    return { ok: true, items: unique(items), cursor: labeled.map(one => one.created_at ?? "").at(-1) ?? trigger.cursor };
  }
  // New issues and pull requests: opened after the trigger was added, oldest first; the key keeps each to one card.
  const what = config.watch === "pulls" ? "pull" : "issue";
  const items = readGithubIssueList(body).filter(one => Date.parse(one.created_at ?? "") > created).reverse().map(one => githubItem(config, one, what)).filter((one): one is Found => one !== null);
  return { ok: true, items, cursor: trigger.cursor };
}

const unique = (items: Found[]) => items.filter((item, index) => items.findIndex(one => one.key === item.key) === index);

export const LINEAR_URL = "https://api.linear.app/graphql";
export const LINEAR_QUERY = "query FlowTrigger($filter: IssueFilter) { issues(filter: $filter, first: 50, orderBy: updatedAt) { nodes { identifier title description url updatedAt state { name } team { key } labels { nodes { name } } } } }";

/** A Linear issue as a card; null when it doesn't match the trigger. */
export function linearItem(config: Extract<TriggerConfig, { kind: "linear" }>, raw: unknown): Found | null {
  const issue = readLinearIssue(raw);
  const identifier = issue.identifier ?? "";
  if (identifier === "") return null;
  const labels = linearLabelNames(issue).map(one => one.toLowerCase());
  if (config.team !== null && (issue.team?.key ?? "").toUpperCase() !== config.team) return null;
  if (config.state !== null && (issue.state?.name ?? "").toLowerCase() !== config.state.toLowerCase()) return null;
  if (config.label !== null && !labels.includes(config.label.toLowerCase())) return null;
  return { key: `linear:${identifier}`, at: issue.updatedAt || null, title: issue.title || identifier,
    description: `From Linear ${identifier}:\n\n${issue.description ?? ""}`.trim().slice(0, 4000),
    source: { kind: "linear", label: `Linear ${identifier}`, url: issue.url || null } };
}

async function fetchLinear(config: Extract<TriggerConfig, { kind: "linear" }>, trigger: FlowTriggerRow, io: TriggerIo): Promise<Fetched> {
  const key = readLinearKey(io.dir);
  if (key === null) return { ok: false, problem: "Needs a Linear API key. Add it on this flow's Triggers panel." };
  const since = trigger.cursor ?? trigger.createdAt;
  const filter: Record<string, unknown> = { updatedAt: { gt: since } };
  if (config.team !== null) filter["team"] = { key: { eqIgnoreCase: config.team } };
  if (config.state !== null) filter["state"] = { name: { eqIgnoreCase: config.state } };
  if (config.label !== null) filter["labels"] = { some: { name: { eqIgnoreCase: config.label } } };
  let response: Response;
  try {
    response = await io.fetch(LINEAR_URL, { method: "POST", headers: { "content-type": "application/json", authorization: key }, body: JSON.stringify({ query: LINEAR_QUERY, variables: { filter } }), signal: AbortSignal.timeout(20_000) });
  } catch { return { ok: false, problem: "Couldn't reach Linear." }; }
  let raw: unknown;
  try { raw = await response.json(); } catch { return { ok: false, problem: `Linear answered ${response.status} and it couldn't be read.` }; }
  const body = readLinearAnswer(raw);
  const errors = (body.errors ?? []).map(one => one.message ?? "");
  if (response.status === 401 || errors.some(one => /authenticat|api key/i.test(one))) return { ok: false, problem: "Linear didn't accept the key. Add a new one on this flow's Triggers panel." };
  if (!response.ok || errors.length > 0) return { ok: false, problem: `Linear said: ${(errors[0] ?? `status ${response.status}`).slice(0, 160)}` };
  const issues = (body.data?.issues?.nodes ?? []).sort((a, b) => (a.updatedAt ?? "").localeCompare(b.updatedAt ?? ""));
  const items = issues.map(one => linearItem(config, one)).filter((one): one is Found => one !== null);
  return { ok: true, items, cursor: issues.map(one => one.updatedAt ?? "").filter(one => one !== "").at(-1) ?? trigger.cursor };
}

// ------------------------------------------------------------ deliveries

export type HookDelivery = { headers: Record<string, string | string[] | undefined>; body: Buffer };
export type HookAnswer = { status: number; said: string };

const header = (delivery: HookDelivery, name: string) => { const value = delivery.headers[name]; return Array.isArray(value) ? value[0] ?? "" : value ?? ""; };
function sameHex(expected: string, given: string): boolean {
  const a = Buffer.from(expected, "utf8"), b = Buffer.from(given, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A webhook delivery at a trigger's secret address: prove it, read it, make at most the cards it names. Nothing runs here. */
export function receiveFlowHook(store: Store, token: string, delivery: HookDelivery, dir: string, now: Date): HookAnswer {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return { status: 404, said: "No such address." };
  const trigger = store.flowTriggerByHook(hookHash(token));
  const config = trigger === null ? null : triggerConfigOf(trigger);
  if (trigger === null || config === null || !takesDeliveries(config)) return { status: 404, said: "No such address." };
  if (delivery.body.length > HOOK_BYTES) return { status: 413, said: "Too large." };
  const note = (said: string) => { store.updateFlowTrigger(trigger.id, { lastAt: now.toISOString(), lastOutcome: said }, now); };
  let payload: unknown;
  try { payload = JSON.parse(delivery.body.toString("utf8")); } catch { return { status: 400, said: "Send JSON." }; }
  let items: Found[] = [];
  if (config.kind === "github") {
    const secret = readHookSecret(dir, trigger.id);
    const signature = header(delivery, "x-hub-signature-256");
    if (secret === null || !sameHex(`sha256=${createHmac("sha256", secret).update(delivery.body).digest("hex")}`, signature)) return { status: 401, said: "Signature doesn't match." };
    const event = header(delivery, "x-github-event"), body = readGithubEvent(payload), action = body.action ?? "";
    const repository = body.repository?.full_name ?? "";
    if (event === "ping") { note("GitHub connected."); return { status: 200, said: "Connected." }; }
    if (repository.toLowerCase() !== config.repo.toLowerCase()) return { status: 202, said: "Not this repository." };
    // A label trigger takes the moment its label is added (or an issue opened with it); a plain one takes new issues.
    const labeledNow = action === "labeled" && config.label !== null && (body.label?.name ?? "").toLowerCase() === config.label.toLowerCase();
    const found = config.watch === "issues" && event === "issues" && (action === "opened" || labeledNow) ? githubItem(config, body.issue, "issue")
      : config.watch === "pulls" && event === "pull_request" && ["opened", "ready_for_review", "labeled", "reopened"].includes(action) ? githubItem(config, body.pull_request, "pull")
      : config.watch === "checks" && event === "workflow_run" && action === "completed" ? githubRunItem(config, body.workflow_run) : null;
    items = found === null ? [] : [found];
  } else if (config.kind === "linear") {
    const secret = readHookSecret(dir, trigger.id);
    if (secret === null) return { status: 401, said: "Paste Linear's signing secret on the flow's Triggers panel first." };
    if (!sameHex(createHmac("sha256", secret).update(delivery.body).digest("hex"), header(delivery, "linear-signature"))) return { status: 401, said: "Signature doesn't match." };
    const body = readLinearEvent(payload), sent = Number(body.webhookTimestamp);
    if (!Number.isFinite(sent) || Math.abs(now.getTime() - sent) > 5 * 60_000) return { status: 401, said: "Too old." };
    if (body.type !== "Issue" || !["create", "update"].includes(body.action ?? "")) return { status: 202, said: "Ignored." };
    // A state trigger fires when the issue arrives in that state, not on every later edit there.
    const moved = body.action === "create" || body.updatedFrom?.stateId !== undefined || config.state === null;
    const found = moved ? linearItem(config, body.data) : null;
    items = found === null ? [] : [found];
  } else if (config.kind === "webhook") {
    // Any JSON, kept as sent: the trigger's own paths are picked from it, and it is shown whole when they find no text.
    const body = readWebhookPayload(payload);
    const record = (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const pick = (path: string | null) => path === null ? null : path.split(".").reduce<unknown>((node, part) => record(node)[part], body);
    const title = pick(config.titleField ?? "title") ?? pick("summary") ?? pick("message");
    const bodyText = pick(config.bodyField ?? "description") ?? pick("body") ?? pick("text");
    const id = header(delivery, "x-request-id") || header(delivery, "x-delivery-id") || header(delivery, "idempotency-key") || createHash("sha256").update(delivery.body).digest("hex");
    items = [{ key: `hook:${id.slice(0, 120)}`, at: null, title: typeof title === "string" && title.trim() !== "" ? title : config.title,
      description: `From a webhook:\n\n${typeof bodyText === "string" ? bodyText : JSON.stringify(body, null, 2)}`.slice(0, 4000),
      source: { kind: "webhook", label: "Webhook", url: null } }];
  }
  if (items.length === 0) return { status: 202, said: "Nothing for this flow." };
  const by = config.kind === "github" ? "GitHub" : config.kind === "linear" ? "Linear" : "Webhook";
  const results = items.slice(0, CARDS_PER_CHECK).map(item => "skip" in item
    ? (store.recordFlowTriggerEvent(trigger.id, item.key, null, item.skip, now) ? { made: "skipped" as Made, note: `${item.label}: ${item.skip}` } : { made: "seen" as Made, note: null })
    : makeCard(store, trigger, config, item, by, now));
  const said = outcomeWords(results, false);
  note(said);
  return { status: 202, said };
}

/** Save Linear's signing secret for a Linear webhook trigger (pasted on the secure panel, never in chat). */
export function saveLinearSigningSecret(trigger: FlowTriggerRow, secret: string, dir: string): { ok: true } | { ok: false; message: string } {
  const config = triggerConfigOf(trigger);
  if (config?.kind !== "linear" || config.delivery !== "webhook") return { ok: false, message: "That trigger doesn't take Linear webhooks." };
  const clean = secret.trim();
  if (!/^[A-Za-z0-9_-]{16,200}$/.test(clean)) return { ok: false, message: "Paste the signing secret exactly as Linear shows it." };
  saveHookSecret(dir, trigger.id, clean);
  return { ok: true };
}

/** Whether a webhook trigger can prove its deliveries: GitHub always (its secret is made here), Linear once its secret is pasted. */
export function hookReady(trigger: FlowTriggerRow, dir: string | null): boolean {
  const config = triggerConfigOf(trigger);
  if (config === null || !takesDeliveries(config)) return false;
  if (config.kind === "webhook") return true;
  return dir !== null && existsSync(secretFile(dir, trigger.id));
}

// ------------------------------------------------------ public forms (v84)

export const FORM_PATH = "/hooks/form/";
/** At most this many cards an hour from one shared form. */
const FORM_CARDS_PER_HOUR = 30;

/** Share a button as a secret link anyone can fill in, without signing in. The link is shown once; only its hash is kept. */
export function shareFlowButton(store: Store, trigger: FlowTriggerRow, now: Date, dir: string | null): TriggerMade {
  if (triggerConfigOf(trigger)?.kind !== "button" || trigger.state === "removed") return { ok: false, message: "Only a button can be shared as a form." };
  const token = randomBytes(24).toString("base64url");
  store.updateFlowTrigger(trigger.id, { hookHash: hookHash(token) }, now);
  const base = readHooksBase(dir);
  return { ok: true, id: trigger.id, said: "Form link made. Copy it now; it isn't shown again.", reveal: { path: `${FORM_PATH}${token}`, address: base === null ? null : `${base}${FORM_PATH}${token}`, secret: null } };
}

export function stopSharingFlowButton(store: Store, trigger: FlowTriggerRow, now: Date): void {
  store.updateFlowTrigger(trigger.id, { hookHash: null }, now);
}

const esc = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The public page: the button's name and its questions, nothing about the flow, the project or anyone in it. */
function formHtml(label: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(label)}</title><style>
:root{color-scheme:light dark;--bg:#f7f7f5;--card:#fff;--text:#1c1d1b;--muted:#666a63;--line:#dcded8;--accent:#2d5a45}
@media (prefers-color-scheme:dark){:root{--bg:#141614;--card:#1d201d;--text:#ecefe9;--muted:#9ea39a;--line:#343934;--accent:#8fd0ae}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:560px;margin:0 auto;padding:40px 16px}h1{font-size:1.5rem;margin:0 0 20px}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px}
label{display:grid;gap:6px;margin:0 0 16px;font-weight:600}input,textarea{font:inherit;color:inherit;background:transparent;border:1px solid var(--line);border-radius:10px;padding:10px 12px;width:100%}
textarea{min-height:96px;resize:vertical}button{font:inherit;font-weight:600;border:0;border-radius:10px;padding:12px 18px;min-height:44px;background:var(--accent);color:var(--bg);cursor:pointer}
p{color:var(--muted)}.trap{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}a{color:var(--accent)}
</style></head><body><main><h1>${esc(label)}</h1><div class="card">${body}</div></main></body></html>`;
}

export type FormAnswer = { status: number; html: string };

/** GET a shared form: its questions. */
export function flowFormPage(store: Store, token: string, now: Date): FormAnswer {
  const trigger = /^[A-Za-z0-9_-]{20,64}$/.test(token) ? store.flowTriggerByHook(hookHash(token)) : null;
  const config = trigger === null ? null : triggerConfigOf(trigger);
  if (trigger === null || config?.kind !== "button") return { status: 404, html: formHtml("Not found", "<p>This form isn't available. Ask whoever shared it for a new link.</p>") };
  const fields = config.questions.map((question, index) => `<label>${esc(question)}${index === 0 ? `<input name="a${index}" required maxlength="200" autocomplete="off">` : `<textarea name="a${index}" maxlength="3000"></textarea>`}</label>`).join("");
  return { status: 200, html: formHtml(config.label, `<form method="post">${fields}<div class="trap" aria-hidden="true"><label>Leave this empty<input name="website" tabindex="-1" autocomplete="off"></label></div><input type="hidden" name="t" value="${now.getTime()}"><button>Send</button></form>`) };
}

/** POST a shared form: at most one card per submission, keys refused, a limit per hour, and quiet about what a bot did wrong. */
export function receiveFlowForm(store: Store, token: string, fields: URLSearchParams, now: Date): FormAnswer {
  const trigger = /^[A-Za-z0-9_-]{20,64}$/.test(token) ? store.flowTriggerByHook(hookHash(token)) : null;
  const config = trigger === null ? null : triggerConfigOf(trigger);
  if (trigger === null || config?.kind !== "button") return flowFormPage(store, token, now);
  const again = `<p><a href="${esc(FORM_PATH + token)}">Send another</a></p>`;
  const thanks = formHtml(config.label, `<p>Thanks — it's been sent.</p>${again}`);
  // A filled trap, or a page posted faster than a person could, gets thanks and makes nothing.
  const form = readFormSubmission(fields, config.questions.length);
  const shown = Number(form.t);
  if ((form.website ?? "") !== "" || !Number.isFinite(shown) || now.getTime() - shown < 2000 || now.getTime() - shown > 86_400_000) return { status: 200, html: thanks };
  const recent = store.handle.prepare("SELECT COUNT(*) AS n FROM flow_trigger_event WHERE trigger = ? AND key LIKE 'form:%' AND at > ?").get(trigger.id, new Date(now.getTime() - 3_600_000).toISOString());
  if (Number(recent?.["n"] ?? 0) >= FORM_CARDS_PER_HOUR) return { status: 429, html: formHtml(config.label, `<p>Too many sent in the last hour. Try again later.</p>`) };
  const answers = form.answers.map((answer, index) => (answer ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, index === 0 ? 200 : 3000));
  if (answers[0] === "") return { status: 400, html: formHtml(config.label, `<p>Answer “${esc(config.questions[0]!)}” first.</p>${again}`) };
  const details = config.questions.slice(1).map((question, index) => answers[index + 1] === "" ? null : `${question}\n${answers[index + 1]}`).filter(one => one !== null).join("\n\n");
  const made = makeCard(store, trigger, config, { key: `form:${now.toISOString()}:${randomUUID().slice(0, 8)}`, title: answers[0]!, description: `From the “${config.label}” form:\n\n${details}`.trim(), source: { kind: "form", label: `Form: ${config.label}`, url: null } }, "Form", now);
  if (made.made !== "added") return { status: 400, html: formHtml(config.label, `<p>${made.note?.includes("key or password") ? "That looks like it holds a key or password. Take it out and send again." : "That couldn't be sent."}</p>${again}`) };
  store.updateFlowTrigger(trigger.id, { lastAt: now.toISOString(), lastOutcome: "Someone sent the form." }, now);
  return { status: 200, html: thanks };
}
