/**
 * The named data a card can show (docs/plans/toolroll-cards.md): Toolroll fills these from its own records, with the same
 * reach as the page or lead tool each one mirrors, so a model chooses what to show and never what it says.
 *
 * Every value goes through publicChatText here, once, before it can reach any platform.
 */
import { basename } from "node:path";
import type { CardSourceName } from "./card-catalog.js";
import { publicChatText } from "./chat-display.js";
import { CARD_LIMITS } from "./contracts/chat-card.js";
import { familyInReach, findingLine, findingsInReach, findingSourceWords, findingStandingWords } from "./findings.js";
import { flowInsights } from "./flow-insights.js";
import { handoverLines, handoverNoteOf } from "./handover-note.js";
import type { Integration } from "./integrations.js";
import { projectOutcomes } from "./project-outcomes.js";
import { monthOf } from "./spend.js";
import { spendReport, spendRows, type SpendLine } from "./spend-report.js";
import { refArchived, type Store } from "./store.js";

export type CardReader = {
  store: Store; now: Date;
  who: { name: string; repos: readonly string[] };
  /** Where saved evidence lives; absent, the handover note can't be read here. */
  evidenceRoot?: string;
  /** Reads a chat turn already has; absent, the source says it can't be read here. */
  integrations?: () => readonly Integration[];
  providers?: (repos: readonly string[]) => readonly { project: string; provider: string; model: string; roles: readonly string[]; state: string }[];
  workers?: (repos: readonly string[]) => readonly { name: string; state: string; capacity: number; running: number }[];
};
export type CardQuery = { repo: string | null; task?: string; state?: string; limit?: number; flow?: number; days?: number };
export type CardColumn = { id: string; label: string; numeric?: true };
export type CardFact = { id: string; label: string; value: string };
export type CardPoint = { label: string; value: number; shown: string };
export type CardData = { heading: string; /** `report`: saved model or repository words, shown as such. */ origin?: "records" | "report"; notes?: readonly string[]; repos: readonly string[]; columns: readonly CardColumn[]; rows: readonly Record<string, string>[]; more: number; facts: readonly CardFact[]; points: readonly CardPoint[] };
type Read = CardData | { problem: string };

const clean = (value: string | number, cap: number = CARD_LIMITS.cell): string => publicChatText(String(value), cap);
const dollars = (micro: number): string => `$${(micro / 1_000_000).toFixed(2)}`;
const ago = (from: string, now: Date): string => {
  const hours = Math.max(0, Math.round((now.getTime() - Date.parse(from)) / 3_600_000));
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
};
const projectName = (repo: string | null): string => repo === null ? "Toolroll" : clean(basename(repo), 40);
/** An account limited to some projects sees the instance-wide pages' data no more than the console shows it. */
const instanceWide = (reader: CardReader): boolean => reader.store.accountOf(reader.who.name)?.projects === null;
const INSTANCE_ONLY = { problem: "That needs an account with access to every project, as the page does." };
const count = (points: readonly [string, number][]): CardPoint[] => points.filter(([, value]) => value > 0).slice(0, CARD_LIMITS.points).map(([label, value]) => ({ label: clean(label, CARD_LIMITS.label), value, shown: String(value) }));
const reposOf = (reader: CardReader, query: CardQuery): readonly string[] => query.repo === null ? reader.who.repos : [query.repo];

function tasks(reader: CardReader, query: CardQuery): Read {
  const { store } = reader, repos = reposOf(reader, query), limit = query.limit ?? 10;
  const states = query.state === undefined ? {} : { states: [query.state as import("./store.js").TaskState] };
  const all = store.taskFamiliesAdmitted(repos, false, { limit: 500, order: "created", ...states }).filter(one => !refArchived(store, one.current.refId));
  const counts = new Map<string, number>();
  for (const one of all) counts.set(one.current.state, (counts.get(one.current.state) ?? 0) + 1);
  const shownCount = all.length >= 500 ? "Latest 500 tasks" : "Tasks";
  return {
    heading: query.state === undefined ? shownCount : `${query.state.charAt(0).toUpperCase()}${query.state.slice(1)} tasks`, repos,
    columns: [{ id: "title", label: "Task" }, { id: "state", label: "State" }, { id: "project", label: "Project" }, { id: "age", label: "Updated" }, { id: "strikes", label: "Failed attempts", numeric: true }],
    rows: all.slice(0, limit).map(one => ({ title: clean(one.root.title), state: clean(one.current.state), project: projectName(one.current.repo), age: `${ago(one.current.updatedAt, reader.now)} ago`, strikes: String(store.lookupRef(one.current.id)?.strikes ?? 0) })),
    more: Math.max(0, all.length - limit),
    facts: [{ id: "total", label: "Total", value: String(all.length) }, ...[...counts].map(([state, value]) => ({ id: state, label: `${state.charAt(0).toUpperCase()}${state.slice(1)}`, value: String(value) }))],
    points: count([...counts].sort((a, b) => b[1] - a[1])),
  };
}

function results(reader: CardReader, query: CardQuery): Read {
  const repos = reposOf(reader, query).slice(0, 8), limit = query.limit ?? 10;
  const access = { principal: "operator" as const, repos: [...reader.who.repos] };
  const reports = repos.map(repo => ({ repo, report: projectOutcomes(reader.store, repo, reader.now, access) }));
  const rows = reports.flatMap(({ repo, report }) => report.families.map(one => ({ one, repo }))).sort((a, b) => (b.one.finishedAt ?? "").localeCompare(a.one.finishedAt ?? ""));
  const sum = (read: (report: (typeof reports)[number]["report"]) => number): number => reports.reduce((total, one) => total + read(one.report), 0);
  const recorded = reports.flatMap(one => one.report.cost.recordedUsd === null ? [] : [one.report.cost.recordedUsd]);
  const ready = sum(report => report.ready.count), done = sum(report => report.completed.count), revisions = sum(report => report.revisions.count);
  return {
    heading: "Results, last 60 days", repos,
    columns: [{ id: "title", label: "Task" }, { id: "state", label: "State" }, { id: "checks", label: "Checks" }, { id: "project", label: "Project" }, { id: "cost", label: "Cost", numeric: true }],
    rows: rows.slice(0, limit).map(({ one, repo }) => ({ title: clean(one.title), state: clean(one.state), checks: clean(one.checks), project: projectName(repo), cost: one.totalUsd === null ? "not recorded" : `$${one.totalUsd.toFixed(2)}` })),
    more: Math.max(0, rows.length - limit),
    facts: [{ id: "ready", label: "Ready", value: String(ready) }, { id: "completed", label: "Completed", value: String(done) }, { id: "revisions", label: "Revisions", value: String(revisions) },
      ...(recorded.length === 0 ? [] : [{ id: "cost", label: "Recorded cost", value: `$${recorded.reduce((a, b) => a + b, 0).toFixed(2)}` }])],
    points: count([["Ready", ready], ["Completed", done]]),
  };
}

function flows(reader: CardReader, query: CardQuery): Read {
  const { store } = reader, repos = reposOf(reader, query), limit = query.limit ?? 10;
  const list = store.listFlows(repos).filter(one => one.state === "active" && reader.who.repos.includes(one.repo) && store.accountCanAccess(reader.who.name, one.repo));
  const seen = list.map(flow => { const cards = store.flowCards(flow.id, true); return { flow, active: cards.filter(one => one.state === "active").length, finished: cards.filter(one => one.state !== "active").length }; });
  return {
    heading: "Flows", repos,
    columns: [{ id: "name", label: "Flow" }, { id: "project", label: "Project" }, { id: "active", label: "Active cards", numeric: true }, { id: "finished", label: "Finished cards", numeric: true }],
    rows: seen.slice(0, limit).map(one => ({ name: clean(one.flow.name), project: projectName(one.flow.repo), active: String(one.active), finished: String(one.finished) })),
    more: Math.max(0, seen.length - limit),
    facts: [{ id: "flows", label: "Flows", value: String(seen.length) }, { id: "active", label: "Active cards", value: String(seen.reduce((sum, one) => sum + one.active, 0)) }],
    points: count(seen.map(one => [one.flow.name, one.active] as [string, number])),
  };
}

function flowZones(reader: CardReader, query: CardQuery): Read {
  const { store } = reader, days = query.days ?? 30;
  if (query.flow === undefined) return { problem: "Name the flow: flow_zones needs flow, its number from get_flows." };
  const flow = store.getFlow(query.flow);
  if (flow === null || flow.state !== "active" || !reader.who.repos.includes(flow.repo) || !store.accountCanAccess(reader.who.name, flow.repo)) return { problem: "No such flow in your projects." };
  const seen = flowInsights(store, flow, reader.now, days), limit = query.limit ?? CARD_LIMITS.rows;
  return {
    heading: clean(`${flow.name}, last ${days} days`, CARD_LIMITS.heading), repos: [flow.repo],
    columns: [{ id: "step", label: "Step" }, { id: "entered", label: "Arrived", numeric: true }, { id: "failed", label: "Failed", numeric: true }, { id: "sentBack", label: "Sent back", numeric: true }, { id: "here", label: "Here now", numeric: true }, { id: "typical", label: "Typical stay", numeric: true }],
    rows: seen.zones.slice(0, limit).map(one => ({ step: clean(one.title), entered: String(one.entered), failed: String(one.failed), sentBack: String(one.sentBack), here: String(one.here), typical: one.typicalMinutes === null ? "none yet" : `${Math.round(one.typicalMinutes)} min` })),
    more: Math.max(0, seen.zones.length - limit),
    facts: [{ id: "started", label: "Started", value: String(seen.cards.started) }, { id: "finished", label: "Finished", value: String(seen.cards.finished) }, { id: "active", label: "Active", value: String(seen.cards.active) }],
    points: count(seen.zones.map(one => [one.title, one.entered] as [string, number])),
  };
}

function spend(reader: CardReader, query: CardQuery): Read {
  const { store, now } = reader;
  // As /spend: an instance operator's page.
  if (!store.isInstanceOperator(reader.who.name)) return { problem: "Only an instance operator sees spend." };
  const month = monthOf(now), report = spendReport(spendRows(store.handle, month.from, month.to)), limit = query.limit ?? 10;
  const cost = (line: SpendLine): number => line.apiMicrousd + line.estimatedMicrousd;
  const lines = [...report.byProject].filter(one => query.repo === null || one.key === query.repo).sort((a, b) => cost(b) - cost(a));
  return {
    heading: clean(`Spend, ${month.name}`, CARD_LIMITS.heading), repos: reader.who.repos,
    columns: [{ id: "project", label: "Project" }, { id: "api", label: "API dollars", numeric: true }, { id: "estimated", label: "Estimated", numeric: true }, { id: "work", label: "Pieces of work", numeric: true }],
    rows: lines.slice(0, limit).map(one => ({ project: projectName(one.key), api: dollars(one.apiMicrousd), estimated: dollars(one.estimatedMicrousd), work: String(one.count) })),
    more: Math.max(0, lines.length - limit),
    facts: [{ id: "api", label: "API dollars", value: dollars(report.totals.apiMicrousd) }, { id: "estimated", label: "Estimated", value: dollars(report.totals.estimatedMicrousd) }, { id: "work", label: "Pieces of work", value: String(report.totals.count) }],
    points: lines.filter(one => cost(one) > 0).slice(0, CARD_LIMITS.points).map(one => ({ label: projectName(one.key), value: cost(one) / 1_000_000, shown: dollars(cost(one)) })),
  };
}

function projects(reader: CardReader, query: CardQuery): Read {
  const { store, now } = reader, repos = reposOf(reader, query), limit = query.limit ?? 10;
  const seen = repos.map(repo => {
    const families = store.taskFamiliesAdmitted([repo], false, { limit: 500, order: "created" }).filter(one => !refArchived(store, one.current.refId));
    const of = (state: string) => families.filter(one => one.current.state === state).length;
    return { repo, running: of("running"), queued: of("queued"), failed: of("failed"), mode: store.activeMode(repo, now)?.name ?? "none" };
  });
  return {
    heading: "Projects", repos,
    columns: [{ id: "project", label: "Project" }, { id: "running", label: "Running", numeric: true }, { id: "queued", label: "Queued", numeric: true }, { id: "failed", label: "Failed", numeric: true }, { id: "mode", label: "Automatic approvals" }],
    rows: seen.slice(0, limit).map(one => ({ project: projectName(one.repo), running: String(one.running), queued: String(one.queued), failed: String(one.failed), mode: clean(one.mode) })),
    more: Math.max(0, seen.length - limit),
    facts: [{ id: "projects", label: "Projects", value: String(seen.length) }, { id: "running", label: "Running", value: String(seen.reduce((sum, one) => sum + one.running, 0)) }, { id: "failed", label: "Failed", value: String(seen.reduce((sum, one) => sum + one.failed, 0)) }],
    points: count(seen.map(one => [projectName(one.repo), one.running + one.queued] as [string, number])),
  };
}

function workers(reader: CardReader, query: CardQuery): Read {
  if (!instanceWide(reader)) return INSTANCE_ONLY;
  if (reader.workers === undefined) return { problem: "Workers can't be read here." };
  const repos = reposOf(reader, query), limit = query.limit ?? 10, list = reader.workers(repos);
  return {
    heading: "Workers", repos,
    columns: [{ id: "name", label: "Worker" }, { id: "state", label: "State" }, { id: "capacity", label: "Capacity", numeric: true }, { id: "running", label: "Running", numeric: true }],
    rows: list.slice(0, limit).map(one => ({ name: clean(one.name), state: clean(one.state), capacity: String(one.capacity), running: String(one.running) })),
    more: Math.max(0, list.length - limit),
    facts: [{ id: "workers", label: "Workers", value: String(list.length) }, { id: "capacity", label: "Capacity", value: String(list.reduce((sum, one) => sum + one.capacity, 0)) }],
    points: count(list.map(one => [one.name, one.running] as [string, number])),
  };
}

function mode(reader: CardReader, query: CardQuery): Read {
  if (!instanceWide(reader)) return INSTANCE_ONLY;
  const { store, now } = reader, repos = reposOf(reader, query), limit = query.limit ?? 10;
  const seen = repos.map(repo => ({ repo, mode: store.activeMode(repo, now) }));
  return {
    heading: "Automatic approvals", repos,
    columns: [{ id: "project", label: "Project" }, { id: "mode", label: "Mode" }, { id: "by", label: "Signed by" }, { id: "until", label: "Ends" }],
    rows: seen.slice(0, limit).map(one => ({ project: projectName(one.repo), mode: clean(one.mode?.name ?? "none"), by: clean(one.mode?.signedBy ?? ""), until: one.mode === null ? "" : clean(one.mode.absoluteExpiry.slice(0, 10)) })),
    more: Math.max(0, seen.length - limit),
    facts: [{ id: "on", label: "Projects with a mode", value: String(seen.filter(one => one.mode !== null).length) }, { id: "off", label: "Without", value: String(seen.filter(one => one.mode === null).length) }],
    points: [],
  };
}

function integrations(reader: CardReader, query: CardQuery): Read {
  if (!instanceWide(reader)) return INSTANCE_ONLY;
  if (reader.integrations === undefined) return { problem: "Integrations can't be read here." };
  const list = reader.integrations(), limit = query.limit ?? CARD_LIMITS.rows;
  const counts = new Map<string, number>();
  for (const one of list) counts.set(one.state, (counts.get(one.state) ?? 0) + 1);
  return {
    heading: "Integrations", repos: reader.who.repos,
    columns: [{ id: "name", label: "Integration" }, { id: "kind", label: "Kind" }, { id: "state", label: "State" }, { id: "account", label: "Account" }],
    rows: list.slice(0, limit).map(one => ({ name: clean(one.name), kind: clean(one.group), state: clean(one.state), account: clean(one.account ?? "") })),
    more: Math.max(0, list.length - limit),
    facts: [...counts].slice(0, CARD_LIMITS.facts).map(([state, value]) => ({ id: state, label: clean(state, CARD_LIMITS.label), value: String(value) })),
    points: count([...counts]),
  };
}

function providers(reader: CardReader, query: CardQuery): Read {
  if (reader.providers === undefined) return { problem: "Providers can't be read here." };
  const repos = reposOf(reader, query).slice(0, 8), limit = query.limit ?? 10, list = reader.providers(repos);
  return {
    heading: "Agents and sign-ins", repos,
    columns: [{ id: "provider", label: "Provider" }, { id: "model", label: "Model" }, { id: "roles", label: "Roles" }, { id: "state", label: "State" }, { id: "project", label: "Project" }],
    rows: list.slice(0, limit).map(one => ({ provider: clean(one.provider), model: clean(one.model), roles: clean(one.roles.join(", ")), state: clean(one.state), project: projectName(one.project) })),
    more: Math.max(0, list.length - limit),
    facts: [{ id: "agents", label: "Agents", value: String(list.length) }],
    points: [],
  };
}

function findings(reader: CardReader, query: CardQuery): Read {
  const limit = query.limit ?? 10;
  const list = findingsInReach(reader.store, reader.who, { ...(query.task === undefined ? {} : { task: query.task }), repos: reposOf(reader, query) });
  if (list === null) return { problem: "No such task in your projects." };
  const counts = new Map<string, number>();
  for (const one of list) counts.set(one.state, (counts.get(one.state) ?? 0) + 1);
  return {
    heading: query.task === undefined ? "Findings waiting" : "Findings", origin: "report", repos: [...new Set(list.map(one => one.repo!))],
    columns: [{ id: "id", label: "Finding", numeric: true }, { id: "where", label: "Where" }, { id: "state", label: "State" }, { id: "from", label: "From" }, { id: "task", label: "Task" }],
    rows: list.slice(0, limit).map(one => ({ id: String(one.id), where: clean(one.file === null ? "" : `${one.file}${one.line === null ? "" : `:${one.line}`}`), state: clean(one.state), from: clean(findingSourceWords(one.source)), task: clean(one.taskId) })),
    more: Math.max(0, list.length - limit),
    notes: list.map(one => clean(`${findingLine(one)} (${findingStandingWords(one)})`, CARD_LIMITS.note)),
    facts: [{ id: "total", label: "Findings", value: String(list.length) }, ...[...counts].map(([state, value]) => ({ id: state, label: clean(state, CARD_LIMITS.label), value: String(value) }))],
    points: count([...counts]),
  };
}

function handover(reader: CardReader, query: CardQuery): Read {
  if (query.task === undefined) return { problem: "Name the task: handover needs task." };
  const repos = familyInReach(reader.store, reader.who, query.task);
  if (repos === null) return { problem: "No such task in your projects." };
  if (reader.evidenceRoot === undefined) return { problem: "The handover note can't be read here. Use toolroll task handover." };
  const note = handoverNoteOf(reader.store, reader.evidenceRoot, query.task, reader.now);
  if (note === null) return { problem: "No such task in your projects." };
  return {
    heading: clean(`Handover: ${query.task}`, CARD_LIMITS.heading), origin: "report", repos,
    columns: [{ id: "what", label: "Part" }, { id: "count", label: "Count", numeric: true }],
    rows: [["Accepted decisions", note.acceptedDecisions.length], ["Rejected approaches", note.rejectedApproaches.length], ["Open findings", note.openFindings.length], ["Checks", note.verification.length]].map(([what, value]) => ({ what: String(what), count: String(value) })),
    more: 0,
    notes: handoverLines(note).map(one => clean(one, CARD_LIMITS.note)).filter(one => one !== ""),
    facts: [{ id: "revision", label: "Revision", value: note.revision === null ? "none yet" : clean(note.revision.head.slice(0, 12)) }, { id: "next", label: "Next", value: clean(note.nextAction) }],
    points: [],
  };
}

const READERS: Record<CardSourceName, (reader: CardReader, query: CardQuery) => Read> = { tasks, results, flows, flow_zones: flowZones, spend, projects, workers, mode, integrations, providers, findings, handover };

/** One source, read now as this person. */
export function readCardSource(reader: CardReader, name: CardSourceName, query: CardQuery): Read {
  if (query.repo !== null && !reader.who.repos.includes(query.repo)) return { problem: "That project is outside your access." };
  return READERS[name](reader, query);
}
