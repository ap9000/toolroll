/**
 * Flow files: a flow exported as readable JSON (*.toolroll-flow.json) and
 * imported on another installation (docs/design/flow-gallery.md, "Export
 * and import"; the schema is docs/flow-file.schema.json).
 *
 * The file speaks the lead's step vocabulary — titles, kinds, next/ifFails,
 * instructions — so a person can read and edit it. It never carries what
 * belongs to this installation: secrets and their values, webhook
 * addresses and hashes, tokens, people's names, chat bindings or cards.
 * Repository-specific values (the GitHub repository, labels, a branch,
 * a Linear team, who decides) become parameters the import asks for.
 *
 * An import is previewed in plain words first, always. Its triggers arrive
 * switched off until a person turns them on, its scripts arrive held until
 * a person approves them, and its instructions are shown as the untrusted
 * text they are.
 */
import { createHash } from "node:crypto";
import { scanForSecrets } from "./evidence.js";
import { flowDefinitionOf } from "./flow-engine.js";
import { readFlowSecrets } from "./flow-secrets.js";
import { scriptDigest, validateScript, type ScriptDraft } from "./flow-scripts.js";
import { addFlowTriggerTo, describeTrigger, HOOK_PATH, readHooksBase, triggerConfigOf, validateTriggerConfig, type TriggerConfig } from "./flow-triggers.js";
import { durationMinutes, durationWords, FlowContractError, flowTerms, inStepWords, LANGUAGE_WORDS, validateFlowDefinition, type FlowDefinition, type FlowStage } from "./flows.js";
import { readVersioned } from "./contracts/contract.js";
import { FLOW_ALIASES, FLOW_FILE_FORMAT, FLOW_FILE_VERSION, flowFileSchema, PARAMETER_ID, type FlowFile, type FlowFileParameter, type FlowFileScript } from "./contracts/flow.js";
import { parseSchedule } from "./routine.js";
import type { FlowRow, Store } from "./store.js";

export { FLOW_FILE_FORMAT, FLOW_FILE_VERSION };
export type { FlowFile, FlowFileParameter, FlowFileScript };
/** The largest flow file Toolroll reads or fetches. */
export const FLOW_FILE_MAX_BYTES = 256 * 1024;
export const FLOW_FILE_SUFFIX = ".toolroll-flow.json";

const PARAM = /\{\{\s*param\.([a-z0-9][a-z0-9-]{0,39})\s*\}\}/g;
const REMOVED = "[removed]";

// ------------------------------------------------------------------ export

/** A zone in the lead's words: only what it says, in the order a person reads it. */
function stepOf(stage: FlowStage, ask: (parameter: FlowFileParameter) => string): Record<string, unknown> {
  const step: Record<string, unknown> = { id: stage.id, title: stage.title, kind: stage.kind };
  const words = (minutes: number) => durationMinutes(durationWords(minutes)) === minutes ? durationWords(minutes) : minutes;
  // Only what the step's kind says: words a zone kept from a kind it was before stay behind.
  if (stage.instructions !== null && (stage.kind === "task" || stage.kind === "report" || stage.kind === "draft" || stage.kind === "teammate")) step["instructions"] = stage.instructions;
  if (stage.kind === "task") step["planning"] = stage.planning;
  if (stage.kind === "approval") step["decider"] = stage.toOwner === true ? "owner" : stage.approver === null ? "anyone"
    : ask({ id: `decider-${stage.id}`.slice(0, 40), about: `Who decides at ${stage.title}: a person's sign-in name, owner (the flow's owner) or anyone`, default: "owner" });
  if (stage.message !== null && (stage.kind === "notify" || stage.kind === "update")) step["message"] = stage.message;
  if (stage.kind === "update") step["close"] = stage.close;
  if (stage.kind === "check") {
    step["script"] = stage.script;
    if (stage.runIn !== undefined) step["runIn"] = stage.runIn;
    if (stage.secrets !== undefined) step["secrets"] = stage.secrets;
  }
  if (stage.routes !== undefined) step["routes"] = stage.routes.map(one => ({ answer: one.answer, goesTo: one.to }));
  if (stage.sort !== null) {
    step["question"] = stage.sort.question;
    step["answers"] = stage.sort.answers.map(one => ({ answer: one.answer, means: one.means, goesTo: one.to }));
    step["sureAt"] = Math.round(stage.sort.sureAt * 100);
    if (stage.sort.notes.length > 0) step["alsoNote"] = stage.sort.notes.map(one => ({ id: one.id, question: one.question, kind: one.kind, ...(one.levels === null ? {} : { levels: one.levels }) }));
  }
  if (stage.request !== undefined) Object.assign(step, { method: stage.request.method, url: stage.request.url, headers: stage.request.headers, ...(stage.request.body === null ? {} : { body: stage.request.body }) });
  if (stage.email !== undefined) {
    // A written-out address is someone's: the import asks for it. Fill-ins ({{card.email}}) stay.
    const to = /[^\s@{}]+@[^\s@{}]+/.test(stage.email.to) ? ask({ id: `email-to-${stage.id}`.slice(0, 40), about: `Who ${stage.title} emails` }) : stage.email.to;
    Object.assign(step, { to, subject: stage.email.subject, body: stage.email.body });
  }
  if (stage.tool !== undefined) Object.assign(step, { server: stage.tool.server, tool: stage.tool.name, args: stage.tool.args });
  if (stage.wait !== undefined) Object.assign(step, { waitFor: stage.wait.for,
    ...(stage.wait.for === "hours" ? { from: stage.wait.from, until: stage.wait.to, ...(stage.wait.timeZone === undefined ? {} : { timeZone: stage.wait.timeZone }) } : { wait: words(stage.wait.minutes) }) });
  if (stage.merge !== undefined) step["merge"] = stage.merge;
  if (stage.teammate !== undefined) step["teammate"] = stage.teammate;
  if (stage.reply === true) step["reply"] = true;
  // A choice's buttons; "end" ignores the card. A build in another project names a path on this computer, so it stays here.
  if (stage.options !== undefined) step["options"] = stage.options.map(one => ({ label: one.label, goesTo: one.to }));
  if (stage.limit !== undefined) Object.assign(step, { remindAfter: words(stage.limit.minutes), ...(stage.limit.to === null ? {} : { thenMoveTo: stage.limit.to }) });
  if (stage.next !== null) step["next"] = stage.next;
  if (stage.onFail !== null) step[stage.kind === "sort" ? "ifNotSure" : stage.kind === "wait" ? "ifNoReply" : stage.kind === "choose" ? "ifReplied" : "ifFails"] = stage.onFail;
  step["at"] = { x: stage.zone.x, y: stage.zone.y, w: stage.zone.w, h: stage.zone.h, color: stage.zone.color };
  return step;
}

/** A trigger's settings for the file, or why it stays behind. */
function triggerOf(config: TriggerConfig, ask: (parameter: FlowFileParameter) => string): Record<string, unknown> | string {
  const zone = config.zone === null ? {} : { zone: config.zone };
  switch (config.kind) {
    case "button": return { kind: "button", label: config.label, questions: config.questions, ...zone };
    case "schedule": return { kind: "schedule", schedule: config.schedule, ...(config.script !== undefined ? { script: config.script, ...(config.secrets === undefined ? {} : { secrets: config.secrets }) } : { title: config.title, ...(config.description === null ? {} : { description: config.description }) }), ...zone };
    case "github": return { kind: "github", watch: config.watch,
      repo: ask({ id: "github-repo", about: "The GitHub repository, as owner/name (left empty: the project's own)", optional: true }),
      ...(config.label === null ? {} : { label: ask({ id: "github-label", about: `The label ${config.watch === "pulls" ? "pull requests" : "issues"} need`, default: config.label }) }),
      ...(config.branch === null ? {} : { branch: ask({ id: "github-branch", about: "The branch whose failed checks start cards", default: config.branch }) }),
      from: config.from, delivery: config.delivery, ...zone };
    case "linear": return { kind: "linear",
      ...(config.team === null ? {} : { team: ask({ id: "linear-team", about: "The Linear team's short key, like ENG", default: config.team }) }),
      ...(config.state === null ? {} : { state: config.state }),
      ...(config.label === null ? {} : { label: ask({ id: "linear-label", about: "The Linear label issues need", default: config.label }) }),
      delivery: config.delivery, ...zone };
    case "webhook": return { kind: "webhook", title: config.title, ...(config.titleField === null ? {} : { titleField: config.titleField }), ...(config.bodyField === null ? {} : { bodyField: config.bodyField }), ...zone };
    case "email": return { kind: "email", folder: config.folder,
      ...(config.sender === null ? {} : { sender: ask({ id: "email-sender", about: "Whose mail starts cards: addresses or domains, comma-separated (left empty: anyone's)", optional: true }) }),
      ...(config.subject === null ? {} : { subject: config.subject }), ...zone };
    case "plane-review": {
      const schedule = parseSchedule(config.schedule);
      return { kind: "plane-review", at: schedule !== null && schedule.kind !== "every" ? schedule.hhmm : "07:30", timeZone: schedule !== null && schedule.kind !== "every" ? schedule.timezone ?? "UTC" : "UTC", ...zone };
    }
    case "chat": return `the ${config.app} channel trigger (connect a channel from the channel itself)`;
    case "flow": return "the trigger from another flow (it names a flow on this installation)";
  }
}

/** What a flow needs to run, as short keys the import puts in words. */
function needsOf(definition: FlowDefinition, triggers: readonly Record<string, unknown>[], scripts: readonly string[]): string[] {
  const needs = new Set<string>();
  for (const stage of definition.stages) {
    if (stage.kind === "pull-request" || stage.kind === "update") needs.add("github");
    if (stage.kind === "sort") needs.add("openrouter");
    if (stage.kind === "email" || (stage.kind === "wait" && stage.wait?.for === "reply")) needs.add("email");
    if (stage.tool !== undefined) needs.add(`tool:${stage.tool.server}`);
    if (stage.teammate !== undefined) needs.add(`teammate:${stage.teammate}`);
    for (const name of stage.secrets ?? []) needs.add(`secret:${name}`);
    for (const value of Object.values(stage.request?.headers ?? {})) for (const match of value.matchAll(/\{\{\s*secret\.([A-Z][A-Z0-9_]{0,39})\s*\}\}/g)) needs.add(`secret:${match[1]}`);
  }
  for (const trigger of triggers) {
    if (trigger["kind"] === "github") needs.add("github");
    if (trigger["kind"] === "linear") needs.add("linear");
    if (trigger["kind"] === "email") needs.add("email");
    for (const name of Array.isArray(trigger["secrets"]) ? trigger["secrets"] as string[] : []) needs.add(`secret:${name}`);
  }
  for (const name of scripts) needs.add(`script:${name}`);
  return [...needs].sort();
}

/** Everything that would name this installation or someone on it, to take out of the file's text. */
function privateValues(store: Store, flow: FlowRow, definition: FlowDefinition, dir: string | null): { values: string[]; names: string[] } {
  const values = Object.values(readFlowSecrets(dir, flow.repo)).filter(value => value.length >= 6);
  const base = readHooksBase(dir);
  if (base !== null) values.push(base);
  const names = new Set<string>([flow.owner, flow.createdBy, flow.updatedBy, ...store.accountFacts().map(one => one.name)]);
  for (const stage of definition.stages) if (stage.approver !== null) names.add(stage.approver);
  for (const trigger of store.flowTriggers(flow.id)) names.add(trigger.createdBy);
  for (const script of store.flowScripts(flow.repo)) names.add(script.savedBy);
  return { values, names: [...names].filter(name => name.trim().length >= 3) };
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Text with secrets, hook addresses and people's names taken out. A line that looks like a key goes whole. */
function scrubber(values: readonly string[], names: readonly string[]): (text: string) => string {
  const people = names.length === 0 ? null : new RegExp(`(?<![A-Za-z0-9_.@-])(?:${names.map(escapeRegExp).join("|")})(?![A-Za-z0-9_@-])`, "gi");
  return text => {
    let out = values.reduce((acc, value) => acc.split(value).join(REMOVED), text);
    out = out.replace(new RegExp(`${escapeRegExp(HOOK_PATH)}[A-Za-z0-9_-]+`, "g"), REMOVED);
    if (people !== null) out = out.replace(people, "[a person]");
    return out.split("\n").map(line => scanForSecrets(line).length > 0 ? REMOVED : line).join("\n");
  };
}

/** Structural fields: ids and references, never prose. Scrubbing them would break the flow's paths. */
const STRUCTURAL = new Set(["format", "id", "kind", "goesTo", "next", "ifFails", "ifNotSure", "ifNoReply", "ifReplied", "thenMoveTo", "zone", "script", "language", "planning", "runIn", "waitFor", "method", "watch", "from", "delivery", "color", "merge"]);

function scrubDeep(value: unknown, scrub: (text: string) => string, key: string | null, inScripts: boolean): unknown {
  if (typeof value === "string") return key !== null && (STRUCTURAL.has(key) || (inScripts && key === "name")) ? value : scrub(value);
  if (Array.isArray(value)) return value.map(one => scrubDeep(one, scrub, key, inScripts));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubDeep(v, scrub, k, inScripts || k === "scripts")]));
  return value;
}

export type FlowExported = { file: FlowFile; json: string; fileName: string; left: string[] };

/** A flow as a file: its zones and paths, its triggers' settings and the scripts it runs, nothing of this installation's. */
export function exportFlow(store: Store, flow: FlowRow, dir: string | null): FlowExported {
  const definition = flowDefinitionOf(flow);
  if (definition === null) throw new Error("This flow's drawing can't be read. Save it again from the editor.");
  const parameters: FlowFileParameter[] = [];
  const ask = (parameter: FlowFileParameter) => {
    let id = parameter.id;
    for (let n = 2; parameters.some(one => one.id === id); n++) id = `${parameter.id.slice(0, 36)}-${n}`;
    parameters.push({ ...parameter, id });
    return `{{param.${id}}}`;
  };
  // The start goes first, so the file reads in order and the import starts where this flow does.
  const ordered = [...definition.stages.filter(one => one.id === definition.start), ...definition.stages.filter(one => one.id !== definition.start)];
  const zones = ordered.map(stage => stepOf(stage, ask));
  const left: string[] = [];
  const triggers: Record<string, unknown>[] = [];
  for (const row of store.flowTriggers(flow.id).filter(one => one.state !== "removed")) {
    const config = triggerConfigOf(row);
    if (config === null) { left.push("a trigger that can't be read"); continue; }
    const made = triggerOf(config, ask);
    if (typeof made === "string") left.push(made); else triggers.push(made);
  }
  const wanted = [...new Set([...definition.stages.flatMap(one => one.kind === "check" && one.script !== null ? [one.script] : []), ...triggers.flatMap(one => typeof one["script"] === "string" ? [one["script"]] : [])])].sort();
  const scripts: FlowFileScript[] = [];
  for (const name of wanted) {
    const script = store.flowScript(flow.repo, name);
    if (script === null) { left.push(`the ${name} script (this project doesn't have it)`); continue; }
    scripts.push({ name: script.name, about: script.about, language: script.language, timeoutMinutes: script.timeoutMinutes, ...(script.file === null ? { body: script.body } : { file: script.file }) });
  }
  const { values, names } = privateValues(store, flow, definition, dir);
  const raw: FlowFile = {
    format: FLOW_FILE_FORMAT, version: FLOW_FILE_VERSION, name: flow.name,
    about: ordered.map(one => one.title).join(" → "),
    needs: needsOf(definition, triggers, scripts.map(one => one.name)),
    // Zones and triggers in the file's words (stepOf, triggerOf): what flowFileSchema reads back (flow-share.test.ts).
    parameters, zones: zones as FlowFile["zones"], triggers: triggers as FlowFile["triggers"], scripts,
  };
  const file = scrubDeep(raw, scrubber(values, names), null, false) as FlowFile;
  const slug = flow.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "flow";
  return { file, json: `${JSON.stringify(file, null, 2)}\n`, fileName: `${slug}${FLOW_FILE_SUFFIX}`, left };
}

// ------------------------------------------------------------------ reading

/** A flow file refused: why, in plain words, each problem naming its path in the file (`zones[0].routes[0]: ...`). */
export class FlowFileError extends Error {}
const refuse = (message: string): never => { throw new FlowFileError(message); };

/** A zone from the file as the canvas stores it: references by id (or by title), the rest checked by validateFlowDefinition. */
function stageInputOf(step: Record<string, unknown>, index: number, find: (ref: unknown, path: string) => string | null): Record<string, unknown> {
  const at = `zones[${index}]`;
  const kind = step["kind"];
  const object = (key: string): Record<string, unknown> | undefined => {
    const value = step[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "object" || Array.isArray(value)) refuse(`${at}.${key}: must be an object`);
    return value as Record<string, unknown>;
  };
  const list = (key: string): Record<string, unknown>[] | undefined => {
    const value = step[key];
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value) || value.some(one => one === null || typeof one !== "object" || Array.isArray(one))) refuse(`${at}.${key}: must be a list of objects`);
    return value as Record<string, unknown>[];
  };
  const decider = step["decider"];
  if (decider !== undefined && decider !== null && typeof decider !== "string") refuse(`${at}.decider: must be a string`);
  const toOwner = kind === "approval" && typeof decider === "string" && decider.trim().toLowerCase() === "owner";
  const anyone = decider === undefined || decider === null || (typeof decider === "string" && /^(anyone|any approver|)$/i.test(decider.trim()));
  const place = object("at") ?? {};
  const [failKey, fail] = (["ifNotSure", "ifNoReply", "ifReplied", "ifFails"] as const).map(key => [key, step[key]] as const).find(([, value]) => value !== undefined && value !== null) ?? ["ifFails", undefined];
  const minutes = (value: unknown, key: string) => value === undefined ? undefined : durationMinutes(value) ?? refuse(`${at}.${key}: say a time like "3 days" (up to 30 days)`);
  const sureAt = step["sureAt"];
  return {
    id: step["id"], title: step["title"], kind,
    zone: { x: place["x"], y: place["y"] ?? 0, w: place["w"], h: place["h"], color: place["color"] },
    instructions: step["instructions"], planning: step["planning"],
    ...(toOwner ? { toOwner: true } : { approver: anyone ? null : decider }),
    message: step["message"], close: step["close"], script: step["script"], runIn: step["runIn"],
    routes: list("routes")?.map((one, n) => ({ answer: one["answer"], to: find(one["goesTo"], `${at}.routes[${n}].goesTo`) })),
    secrets: step["secrets"],
    ...(kind === "sort" ? { sort: { question: step["question"], answers: (list("answers") ?? []).map((one, n) => ({ answer: one["answer"], means: one["means"], to: find(one["goesTo"], `${at}.answers[${n}].goesTo`) })),
      sureAt: typeof sureAt === "number" && sureAt > 1 ? sureAt / 100 : sureAt, notes: list("alsoNote") ?? [] } } : {}),
    ...(kind === "request" ? { request: { method: step["method"], url: step["url"], headers: object("headers") ?? {}, body: step["body"] } } : {}),
    ...(kind === "email" ? { email: { to: step["to"], subject: step["subject"], body: step["body"] } } : {}),
    ...(kind === "tool" ? { tool: { server: step["server"], name: step["tool"], args: typeof step["args"] === "object" && step["args"] !== null ? JSON.stringify(step["args"]) : step["args"] } } : {}),
    ...(kind === "wait" ? { wait: step["waitFor"] === "hours" ? { for: "hours", from: step["from"], to: step["until"], timeZone: step["timeZone"] } : { for: step["waitFor"] ?? "reply", minutes: minutes(step["wait"] ?? "3 days", "wait") } } : {}),
    merge: step["merge"], teammate: step["teammate"], reply: step["reply"],
    ...(kind === "choose" ? { options: (list("options") ?? []).map((one, n) => ({ label: one["label"], to: one["goesTo"] === "end" ? "end" : find(one["goesTo"], `${at}.options[${n}].goesTo`) })) } : {}),
    ...(step["remindAfter"] === undefined ? {} : { limit: { minutes: minutes(step["remindAfter"], "remindAfter"), to: find(step["thenMoveTo"], `${at}.thenMoveTo`) } }),
    next: find(step["next"], `${at}.next`), onFail: find(fail, `${at}.${failKey}`),
  };
}

/** The zones as a flow, checked whole. Throws in plain words. */
function definitionOf(zones: readonly Record<string, unknown>[]): FlowDefinition {
  const ids = zones.map(one => one["id"]);
  const find = (ref: unknown, path: string): string | null => {
    if (ref === undefined || ref === null || ref === "") return null;
    if (typeof ref !== "string") return refuse(`${path}: names a zone by its id`);
    const hit = zones.find(one => one["id"] === ref.trim()) ?? zones.find(one => typeof one["title"] === "string" && one["title"].trim().toLowerCase() === ref.trim().toLowerCase());
    if (hit === undefined) return refuse(`${path}: there's no zone called ${ref}`);
    return typeof hit["id"] === "string" ? hit["id"] : refuse(`zones[${zones.indexOf(hit)}].id: required`);
  };
  ids.forEach((one, index) => { if (typeof one !== "string") refuse(`zones[${index}].id: required`); });
  const stages = zones.map((step, index) => stageInputOf(step, index, find));
  // Its zones are the file's, in order: a zone's problem names the file's zone.
  try { return validateFlowDefinition({ version: 1, start: stages[0]?.["id"], stages }); }
  catch (error) { return refuse(error instanceof FlowContractError ? error.lines.map(line => inStepWords(line, "zones", zones.map(one => typeof one["kind"] === "string" ? one["kind"] : undefined))).join("\n") : error instanceof Error ? error.message : "Those zones aren't a flow."); }
}

const plainText = (value: unknown, cap: number, what: string, required: boolean): string => {
  if (value === undefined || value === null || value === "") return required ? refuse(`The file has no ${what}.`) : "";
  if (typeof value !== "string") return refuse(`The file's ${what} must be plain text.`);
  if (value.length > cap) return refuse(`The file's ${what} is longer than ${cap} characters.`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value)) return refuse(`The file's ${what} has hidden characters in it.`);
  return value.trim();
};

/**
 * Read a flow file: its size, its JSON and format, then its one schema (flowFileSchema: every zone, trigger, script
 * and parameter, strict about unknown keys — `zones[0].routes[0]: unknown key 'to' (did you mean goesTo?)`), and a
 * newer version refused plainly. Then what the schema can't say: no keys in a trigger, ids and names used once, each
 * {{param.x}} declared, every script valid and the zones a flow. Throws FlowFileError in plain words.
 */
export function parseFlowFile(text: string): FlowFile {
  if (Buffer.byteLength(text, "utf8") > FLOW_FILE_MAX_BYTES) refuse(`That file is too big: a flow file is at most ${FLOW_FILE_MAX_BYTES / 1024} KB.`);
  let raw: unknown;
  try { raw = JSON.parse(text.replace(/^\uFEFF/, "")); } catch { return refuse("That isn't a flow file: it isn't valid JSON."); }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) refuse("That isn't a flow file: it should be one JSON object.");
  const input = raw as Record<string, unknown>;
  if (input["format"] !== FLOW_FILE_FORMAT) refuse("That isn't a Toolroll flow file: its format isn't \"toolroll-flow\".");
  // Triggers that name something on the installation they were made on stay there; say so, not that the kind is unknown.
  (Array.isArray(input["triggers"]) ? input["triggers"] as unknown[] : []).forEach((one, index) => {
    const kind = one !== null && typeof one === "object" ? (one as Record<string, unknown>)["kind"] : undefined;
    if (kind === "chat") refuse(`triggers[${index}].kind: a chat channel trigger can't come from a file; connect the channel from the channel itself`);
    if (kind === "flow") refuse(`triggers[${index}].kind: a trigger from another flow can't come from a file; it names a flow on the installation it was made on`);
  });
  const read = readVersioned(flowFileSchema, input, {}, FLOW_ALIASES);
  if (!read.ok) return refuse(read.issues.map(one => one.line).join("\n"));
  const file = read.value;
  const name = file.name.trim(), about = (file.about ?? "").trim();
  if (name === "") refuse("name: must not be empty");
  const parameters = (file.parameters ?? []).map(one => ({ ...one, about: one.about.trim(), ...(one.default === undefined ? {} : { default: one.default.trim() }) }));
  if (new Set(parameters.map(one => one.id)).size !== parameters.length) refuse("parameters: two have the same id");
  const triggers = file.triggers ?? [];
  triggers.forEach((one, index) => {
    for (const [key, value] of Object.entries(one)) if (typeof value === "string" && scanForSecrets(value).length > 0) refuse(`triggers[${index}].${key}: looks like a key or password; keys never go in a flow file`);
  });
  const scripts = (file.scripts ?? []).map((row, index): FlowFileScript => {
    let draft: ScriptDraft;
    try { draft = validateScript(row); } catch (error) { return refuse(`scripts[${index}]: ${error instanceof Error ? error.message : "it isn't valid."}`); }
    return { name: draft.name, about: draft.about, language: draft.language, timeoutMinutes: draft.timeoutMinutes, ...(draft.file === null ? { body: draft.body } : { file: draft.file }) };
  });
  if (new Set(scripts.map(one => one.name)).size !== scripts.length) refuse("scripts: two have the same name");
  // Every {{param.x}} names a parameter the file declares.
  for (const match of JSON.stringify([file.zones, triggers]).matchAll(PARAM)) if (!parameters.some(one => one.id === match[1])) refuse(`The file uses {{param.${match[1]}}} but doesn't say what it asks for.`);
  definitionOf(file.zones as unknown as Record<string, unknown>[]);
  return { format: FLOW_FILE_FORMAT, version: FLOW_FILE_VERSION, name, about, needs: (file.needs ?? []).map(one => one.trim()), parameters, zones: file.zones, triggers, scripts };
}

/** --param k=v lines (or a form's fields) as values; refuses parameters the file doesn't ask for. */
export function parameterValues(file: FlowFile, given: Record<string, string>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [id, value] of Object.entries(given)) {
    if (!file.parameters.some(one => one.id === id)) refuse(`This flow doesn't ask for ${id}. It asks for: ${file.parameters.map(one => one.id).join(", ") || "nothing"}.`);
    values[id] = plainText(value, 200, id, false);
  }
  for (const parameter of file.parameters) {
    if (values[parameter.id] !== undefined && (values[parameter.id] !== "" || parameter.optional === true)) continue;
    if (parameter.default !== undefined) values[parameter.id] = parameter.default;
    else if (parameter.optional === true) values[parameter.id] = "";
    else refuse(`This flow asks for ${parameter.id}: ${parameter.about}. Give it with --param ${parameter.id}=<value>.`);
  }
  // In the file's order, so the same answers always read (and fingerprint) the same.
  return Object.fromEntries(file.parameters.map(one => [one.id, values[one.id]!]));
}

function fill(value: unknown, values: Record<string, string>): unknown {
  if (typeof value === "string") {
    const filled = value.replace(PARAM, (_whole, id: string) => values[id] ?? "");
    return filled.trim() === "" && value.trim() !== "" ? null : filled;
  }
  if (Array.isArray(value)) return value.map(one => fill(one, values));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, one]) => [key, fill(one, values)]));
  return value;
}

const NEED_WORDS: Record<string, string> = {
  github: "GitHub, through the gh command signed in on this computer", linear: "A Linear key", openrouter: "An OpenRouter key, for its Sort zones", email: "Email, set up in Settings → Email",
};
export function needWords(need: string): string {
  const [kind, name] = need.includes(":") ? [need.slice(0, need.indexOf(":")), need.slice(need.indexOf(":") + 1)] : [need, ""];
  return NEED_WORDS[need] ?? (kind === "secret" ? `A saved secret called ${name}` : kind === "tool" ? `The ${name} tool (Settings → Tools)` : kind === "teammate" ? `An AI teammate called ${name}` : kind === "script" ? `The ${name} script` : need);
}

export type FlowImportPlan = {
  name: string; repo: string; definition: FlowDefinition; triggers: Record<string, unknown>[];
  /** Scripts to add (held until approved), and those the project already has exactly. */
  scripts: { add: FlowFileScript[]; kept: string[] };
  values: Record<string, string>; title: string;
  /** The whole preview, line by line (the CLI's); `parts` is the same, grouped for the console's page. */
  terms: string[];
  parts: { about: string | null; steps: string[]; notes: string[]; triggers: string[]; scripts: string[]; kept: string[]; filled: string | null; needs: string | null };
};

/** The import in plain words, checked against the project it lands in. Throws FlowFileError. */
export function planFlowImport(store: Store, repo: string, file: FlowFile, given: Record<string, string>, actor: string): FlowImportPlan {
  const values = parameterValues(file, given);
  const zones = fill(file.zones, values) as Record<string, unknown>[];
  const definition = definitionOf(zones);
  const people = new Set(store.accountFacts().filter(one => one.revokedAt === null).map(one => one.name));
  for (const stage of definition.stages) if (stage.approver !== null && !people.has(stage.approver)) refuse(`${stage.title} is decided by ${stage.approver}, who isn't anyone here. Give a sign-in name, owner or anyone.`);
  const add: FlowFileScript[] = [], kept: string[] = [];
  for (const script of file.scripts) {
    const current = store.flowScript(repo, script.name);
    if (current === null) { add.push(script); continue; }
    const draft = { body: script.body ?? "", timeoutMinutes: script.timeoutMinutes, language: script.language, file: script.file ?? null };
    if (current.digest !== scriptDigest(draft)) refuse(`This project already has a different script called ${script.name}. Rename it in the file (and in the zones that run it), then import.`);
    kept.push(script.name);
  }
  const named = new Set([...file.scripts.map(one => one.name)]);
  for (const stage of definition.stages) if (stage.kind === "check" && stage.script !== null && !named.has(stage.script) && store.flowScript(repo, stage.script) === null) refuse(`${stage.title} runs a script called ${stage.script}, which isn't in the file or this project.`);
  const draft: FlowRow = { id: 0, repo, name: file.name, definitionJson: JSON.stringify(definition), revision: 1, state: "active", createdBy: actor, createdAt: "", updatedBy: actor, updatedAt: "", owner: actor };
  const triggers = (fill(file.triggers, values) as Record<string, unknown>[]).map(one => Object.fromEntries(Object.entries(one).filter(([, value]) => value !== null)));
  const triggerWords = triggers.map(trigger => {
    const script = typeof trigger["script"] === "string" ? trigger["script"] : null;
    if (script !== null && !named.has(script) && store.flowScript(repo, script) === null) refuse(`A schedule runs a script called ${script}, which isn't in the file or this project.`);
    // A script the import brings isn't saved yet: its schedule is checked without it, then said with it.
    let config: TriggerConfig;
    try { config = validateTriggerConfig(script !== null && store.flowScript(repo, script) === null ? { ...trigger, script: undefined, title: `Items from ${script}` } : trigger, { store, flow: draft, definition, actor }); }
    catch (error) { return refuse(`A ${String(trigger["kind"])} trigger: ${error instanceof Error ? error.message : "it isn't valid."}`); }
    if (script !== null && config.kind === "schedule") config = { ...config, script, title: `Items from ${script}` };
    const zone = definition.stages.find(one => one.id === (config.zone ?? definition.start))?.title ?? "the first zone";
    return `${describeTrigger(config, store)} → ${zone}. Arrives switched off until you turn it on.${config.kind === "webhook" || ("delivery" in config && config.delivery === "webhook") ? " It gets a new address when you make one on its Triggers panel." : ""}`;
  });
  const project = repo.split(/[\\/]/).filter(Boolean).pop() ?? repo;
  const all = flowTerms(definition, null);
  // An about line that only lists the zones says nothing the steps don't.
  const about = file.about === "" || file.about === definition.stages.map(one => one.title).join(" → ") ? null : `About, from the file: ${file.about}`;
  // Scripts have their own lines; the rest of what it needs is said once.
  const needs = file.needs.filter(one => !one.startsWith("script:"));
  const parts = {
    about,
    steps: all.slice(0, definition.stages.length), notes: all.slice(definition.stages.length),
    triggers: triggerWords,
    scripts: add.map(one => `Adds the ${one.name} script (${LANGUAGE_WORDS[one.language]}${one.file === undefined ? "" : `, runs ${one.file}`}): ${one.about}\nIt can't run until you approve it on the Scripts panel.`),
    kept: kept.map(one => `Uses this project's ${one} script, which is the same.`),
    filled: Object.keys(values).length === 0 ? null : `Filled in: ${file.parameters.map(one => `${one.id} = ${values[one.id] === "" ? "(left empty)" : values[one.id]}`).join("; ")}`,
    needs: needs.length === 0 ? null : `Needs: ${needs.map(needWords).join("; ")}.`,
  };
  const terms = [
    ...(about === null ? [] : [about]),
    "Its instructions come from the file, not from you: read what each step is asked before you import.",
    ...all,
    ...(triggerWords.length === 0 ? [] : [`Triggers:\n${triggerWords.map(one => `• ${one}`).join("\n")}`]),
    ...add.map((one, index) => `${parts.scripts[index]}${one.body === undefined ? "" : `\n${one.body}`}`),
    ...parts.kept,
    ...(parts.filled === null ? [] : [parts.filled]),
    ...(parts.needs === null ? [] : [parts.needs]),
  ];
  return { name: file.name, repo, definition, triggers, scripts: { add, kept }, values, title: `Import the ${file.name} flow into ${project}`, terms, parts };
}

/** Make the planned flow: scripts held, the flow, and its triggers switched off. One transaction. */
export function importFlow(store: Store, plan: FlowImportPlan, actor: string, now: Date, dir: string | null): { id: number; said: string } {
  return store.transact(() => {
    for (const script of plan.scripts.add) {
      const draft = validateScript(script);
      store.saveFlowScript({ repo: plan.repo, ...draft, digest: scriptDigest(draft), by: actor, held: "imported" }, now);
    }
    const id = store.createFlow({ repo: plan.repo, name: plan.name, definitionJson: JSON.stringify(plan.definition), by: actor }, now);
    for (const trigger of plan.triggers) {
      const made = addFlowTriggerTo(store, store.getFlow(id)!, trigger, actor, now, dir);
      if (!made.ok) throw new FlowFileError(`A ${String(trigger["kind"])} trigger: ${made.message}`);
      store.updateFlowTrigger(made.id, { state: "paused" }, now);
    }
    const held = plan.scripts.add.length, off = plan.triggers.length;
    return { id, said: `Imported ${plan.name}.${off === 0 ? "" : ` Its ${off === 1 ? "trigger is" : `${off} triggers are`} off until you turn ${off === 1 ? "it" : "them"} on.`}${held === 0 ? "" : ` Approve its ${held === 1 ? "script" : `${held} scripts`} on the Scripts panel before ${held === 1 ? "it runs" : "they run"}.`}` };
  });
}

/** What a flow's zones and paths are, without where they sit on the canvas: what a round trip keeps. */
export function flowShape(definition: FlowDefinition): string {
  return createHash("sha256").update(JSON.stringify({ start: definition.start, stages: definition.stages.map(one => ({ ...one, zone: null })) })).digest("hex");
}

// ------------------------------------------------------------------ fetching

const FETCH_HOSTS = new Set(["github.com", "gist.github.com", "raw.githubusercontent.com", "gist.githubusercontent.com"]);

/** A gist or GitHub file page as the address of its raw text; null when it isn't one Toolroll fetches. */
export function rawFlowUrl(address: string): string | null {
  let url: URL;
  try { url = new URL(address.trim()); } catch { return null; }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || !FETCH_HOSTS.has(url.hostname)) return null;
  if (url.hostname === "github.com") {
    const blob = /^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/.exec(url.pathname);
    return blob === null ? null : `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}`;
  }
  if (url.hostname === "gist.github.com") return `https://gist.github.com${url.pathname.replace(/\/+$/, "")}${/\/raw(\/|$)/.test(url.pathname) ? "" : "/raw"}`;
  return url.toString();
}

export type FetchLike = (url: string, init: { redirect: "follow"; signal: AbortSignal; headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; url?: string; headers: { get(name: string): string | null }; body: ReadableStream<Uint8Array> | null }>;

/** A flow file from a gist or GitHub, over HTTPS only, refused past the size cap. Throws FlowFileError in plain words. */
export async function fetchFlowFile(address: string, fetcher: FetchLike = fetch as unknown as FetchLike): Promise<string> {
  if (!/^https:\/\//i.test(address.trim())) refuse("Flow files are fetched over HTTPS only. Use an https:// address, or download the file and import it.");
  const raw = rawFlowUrl(address);
  if (raw === null) refuse("Toolroll fetches flow files from a gist or a file on GitHub. Download it and import the file instead.");
  let response: Awaited<ReturnType<FetchLike>>;
  try { response = await fetcher(raw!, { redirect: "follow", signal: AbortSignal.timeout(15_000), headers: { accept: "application/json, text/plain" } }); }
  catch { return refuse("That address didn't answer. Check it, or download the file and import it."); }
  const landed = response.url === undefined || response.url === "" ? null : (() => { try { return new URL(response.url!); } catch { return null; } })();
  if (landed !== null && (landed.protocol !== "https:" || !FETCH_HOSTS.has(landed.hostname))) refuse("That address sent Toolroll somewhere other than GitHub. Download the file and import it instead.");
  if (!response.ok) refuse(`That address answered ${response.status}. Check it's public, or download the file and import it.`);
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > FLOW_FILE_MAX_BYTES) refuse(`That file is too big: a flow file is at most ${FLOW_FILE_MAX_BYTES / 1024} KB.`);
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > FLOW_FILE_MAX_BYTES) { await reader.cancel().catch(() => undefined); refuse(`That file is too big: a flow file is at most ${FLOW_FILE_MAX_BYTES / 1024} KB.`); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

