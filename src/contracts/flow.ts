/**
 * Flows' one contract (docs/plans/zod-revamp.md, item 3): one schema per zone kind, as a discriminated union on `kind`,
 * in each of the three vocabularies a flow is written in —
 *
 * - the saved drawing (`flowDefinitionSchema`): zones as the canvas and the store hold them, references by id;
 * - steps (`flowStepSchema`): the lead's, `toolroll flows create/edit`'s, starters', kits' and the gallery's words,
 *   references by id or name (`goesTo`, `ifFails`), what a kept step leaves out carried over;
 * - the flow file (`flowFileSchema`, docs/flow-file.schema.json): steps with an id and a place on the canvas;
 *
 * plus triggers as they are given (`triggerInputSchema`) and as they are saved (`triggerConfigSchema`). Types are
 * `z.infer`, limits come from TEXT_LIMITS, and every object is strict, so an unknown key is refused by name. What JSON
 * Schema cannot say — paths to zones that exist, no path back into its own zone, a merge only after a decision, a web
 * address's host, tool arguments as JSON, time zones, schedules, secrets, people and scripts — is checked in plain code
 * after parsing (flows.ts, flow-triggers.ts, flow-share.ts), each with a path-named error.
 */

import { z } from "zod";
import { TEXT_LIMITS } from "../text-limits.js";
import { limited, toModelSchema, versioned, type ContractOptions } from "./contract.js";

export const FLOW_STAGE_KINDS = ["inbox", "task", "report", "approval", "check", "pull-request", "update", "notify", "sort", "draft", "request", "email", "tool", "wait", "subagent", "send", "choose", "done"] as const;
export type FlowStageKind = (typeof FLOW_STAGE_KINDS)[number];
export const FLOW_COLORS = ["slate", "blue", "violet", "amber", "green", "rose"] as const;
export type FlowColor = (typeof FLOW_COLORS)[number];
/** How a Pull request zone merges once checks pass. */
export const FLOW_MERGE_METHODS = ["squash", "merge", "rebase"] as const;
export type FlowMergeMethod = (typeof FLOW_MERGE_METHODS)[number];
export const FLOW_TRIGGER_KINDS = ["button", "schedule", "github", "linear", "flow", "webhook", "email", "chat", "plane-review"] as const;
export type FlowTriggerKind = (typeof FLOW_TRIGGER_KINDS)[number];
export const FLOW_PLANNING = ["auto", "required", "skip"] as const;
export const FLOW_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export const FLOW_WAIT_FOR = ["reply", "time", "hours"] as const;
export const FLOW_RUN_IN = ["folder", "copy"] as const;
export const SCRIPT_LANGUAGES = ["shell", "python", "node"] as const;
export type ScriptLanguage = (typeof SCRIPT_LANGUAGES)[number];

/** Where a choose option that ends the card leads. */
export const FLOW_END = "end";
/** How many zones a flow has, options a choose zone offers, answers a sort or script picks from, and so on. */
export const FLOW_ZONES_MAX = 24;
export const CHOICES_MIN = 2, CHOICES_MAX = 4;
export const SORT_ANSWERS_MIN = 2, SORT_ANSWERS_MAX = 12, SORT_NOTES_MAX = 3, SORT_LEVELS_MIN = 2, SORT_LEVELS_MAX = 10;
export const ROUTES_MAX = 12, SECRETS_MAX = 10, HEADERS_MAX = 10;
/** The longest a zone waits or a limit runs: 30 days. */
export const LONGEST_WAIT_MINUTES = 30 * 24 * 60;
/** "Sure enough to act alone", as a fraction (0.5–0.99) or a percentage (50–99). */
export const SURE_AT_MIN = 0.5, SURE_AT_MAX = 0.99, SURE_AT_PERCENT_MAX = 99;

/** A zone's id: short, lowercase, dashes. */
export const ZONE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** A project script's name: short, lowercase, dashes — how zones and chat refer to it. */
export const SCRIPT_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** A saved secret's name, in capitals. */
export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,39}$/;
/** A flow file parameter's id. */
export const PARAMETER_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** A time of day as zones save it, and as people write it. */
export const CLOCK = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
export const CLOCK_WRITTEN = /^\s*([01]?[0-9]|2[0-3]):([0-5][0-9])\s*$/;
/** No control characters (tabs and line breaks are fine). */
const PLAIN = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/;
/** No control characters and no hidden direction marks: text a flow file or trigger brings in from outside. */
const VISIBLE = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩]*$/;

/** Words, within a TEXT_LIMITS bound, with no control characters. */
const words = (field: string, key: Parameters<typeof limited>[1]) => limited(field, key).regex(PLAIN, { error: "can't contain control characters" });
const visible = (field: string, key: Parameters<typeof limited>[1]) => limited(field, key).regex(VISIBLE, { error: "can't contain hidden characters" });
const zoneId = z.string().regex(ZONE_ID, { error: "must be a short id: lowercase letters, numbers and dashes" });
const scriptName = z.string().regex(SCRIPT_NAME, { error: "must be a script's name: lowercase letters, numbers and dashes" });
const secretName = z.string().regex(SECRET_NAME, { error: "must be a saved secret's name in capitals, like API_TOKEN" });
const minutes = z.int().min(1).max(LONGEST_WAIT_MINUTES);

// ------------------------------------------------------------------ the saved drawing

/** Where a zone sits on the canvas. */
export const flowZoneSchema = z.strictObject({
  x: z.int().min(-20000).max(20000), y: z.int().min(-20000).max(20000), w: z.int().min(220).max(1200), h: z.int().min(160).max(1600), color: z.enum(FLOW_COLORS),
});
const stageRef = zoneId;
/** One answer a sort zone can pick: its name, what it means (what Jev reads), and the zone it sends the card to. */
export const flowSortAnswerSchema = z.strictObject({ answer: words("answer", "flowAnswer").min(1), means: words("means", "flowSortMeans").min(1), to: stageRef });
/** Something else a sort zone notes on the card: a score on a scale of levels, or a yes/no. */
export const flowSortNoteSchema = z.discriminatedUnion("kind", [
  z.strictObject({ id: zoneId, kind: z.literal("score"), question: words("question", "flowSortQuestion").min(1), levels: z.array(words("level", "flowSortLevel").min(1)).min(SORT_LEVELS_MIN).max(SORT_LEVELS_MAX) }),
  z.strictObject({ id: zoneId, kind: z.literal("yes-no"), question: words("question", "flowSortQuestion").min(1), levels: z.null() }),
]);
/** How a sort answer is named to Jev: its words as a short key (the request's criteria, and the choice Jev returns). */
export const sortKeyOf = (answer: string) => answer.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "answer";
/** The key of a sort zone's question in its Jev request (a choice over its answers), and of each thing it also notes. */
export const SORT_ROUTE_KEY = "route";
export const sortNoteKeyOf = (noteId: string) => `note_${noteId.replace(/-/g, "_")}`;
/** sort: the question, its answers, how sure Jev must be to act alone (0.5–0.99), and what else it notes. */
export const flowSortSchema = z.strictObject({
  question: words("question", "flowSortQuestion").min(1),
  answers: z.array(flowSortAnswerSchema).min(SORT_ANSWERS_MIN).max(SORT_ANSWERS_MAX),
  sureAt: z.number().min(SURE_AT_MIN).max(SURE_AT_MAX),
  notes: z.array(flowSortNoteSchema).max(SORT_NOTES_MAX),
});
/** request: what is called. The address's scheme and host are fixed; fill-ins go in its path and query (encoded), headers and body. */
export const flowRequestSchema = z.strictObject({
  method: z.enum(FLOW_METHODS), url: words("url", "flowUrl").min(1),
  headers: z.object({}).catchall(words("header", "flowHeader").min(1)), body: words("body", "flowBody").min(1).nullable(),
});
/** email: who it goes to, the subject and the text — all with fill-ins. */
export const flowEmailSchema = z.strictObject({ to: words("to", "flowEmailTo").min(1), subject: words("subject", "flowEmailSubject").min(1), body: words("body", "flowBody").min(1) });
/** tool: which of the project's tools (MCP servers), which of its functions, and the arguments as JSON with fill-ins. */
export const flowToolSchema = z.strictObject({ server: words("server", "flowToolServer").min(1), name: words("name", "flowToolName").min(1), args: words("args", "flowToolArgs").min(1) });
/** wait: for a reply to the card's email (next: replied, onFail: no reply in time), for a set time (then next), or until
 * the clock is between `from` and `to` (like 22:00–06:00), in the computer's time zone unless one is named. */
export const flowWaitSchema = z.strictObject({
  for: z.enum(FLOW_WAIT_FOR),
  /** reply, time: how long (a minute to 30 days); hours: 0. */
  minutes: z.int().min(0).max(LONGEST_WAIT_MINUTES),
  from: z.string().regex(CLOCK, { error: "must be a time like 22:00" }).optional(),
  to: z.string().regex(CLOCK, { error: "must be a time like 06:00" }).optional(),
  timeZone: z.string().min(1).max(TEXT_LIMITS.flowTimeZone).optional(),
});
/** A choose zone's option: its button's words, and the zone it leads to (FLOW_END closes the card as Ignored). */
export const flowChoiceSchema = z.strictObject({ label: words("label", "flowChoice").min(1), to: z.union([stageRef, z.literal(FLOW_END)]) });
/** A script's or subagent's answer and the zone it leads to. */
export const flowRouteSchema = z.strictObject({ answer: z.string().min(1).max(TEXT_LIMITS.flowAnswer).regex(/^[^\n]*$/, { error: "must be one line" }), to: stageRef });
/** A time limit on a zone: after this long, the person it waits on is reminded; a Holding, "Person decides" or "Person
 * chooses" zone can also move the card on (`to`). */
const limitRemind = z.strictObject({ minutes, to: z.null() });
const limitMove = z.strictObject({ minutes, to: stageRef.nullable() });

/**
 * The 18 zones, given how long instructions may be (written now: TEXT_LIMITS.flowInstructions; saved earlier: any
 * length). Every zone carries the same first fields (null where a kind has no use for them) and its own after them, in
 * the order the store has always saved them: a zone's digest is its JSON, so the order is part of the contract.
 */
function zoneSchemas(instructions: z.ZodString) {
  const text = instructions.min(1).regex(PLAIN, { error: "can't contain control characters" });
  const said = text.nullable(), nil = z.null();
  const id = zoneId, title = words("title", "flowTitle").min(1), zone = flowZoneSchema, message = words("message", "flowMessage").min(1);
  const next = stageRef.nullable(), onFail = stageRef.nullable();
  const routes = z.array(flowRouteSchema).min(1).max(ROUTES_MAX).optional();
  const remind = limitRemind.optional(), move = limitMove.optional();
  return [
    z.strictObject({ id, title, kind: z.literal("inbox"), zone, instructions: said, planning: nil, approver: nil, message: message.nullable(), close: nil, script: nil, sort: nil, limit: move, next, onFail }),
    z.strictObject({ id, title, kind: z.literal("task"), zone, instructions: text, planning: z.enum(FLOW_PLANNING), approver: nil, message: message.nullable(), close: nil, script: nil, sort: nil, repo: words("repo", "flowRepo").min(1).optional(), limit: remind, next, onFail }),
    z.strictObject({ id, title, kind: z.literal("report"), zone, instructions: text, planning: nil, approver: nil, message: message.nullable(), close: nil, script: nil, sort: nil, limit: remind, next, onFail }),
    z.strictObject({ id, title, kind: z.literal("approval"), zone, instructions: said, planning: nil, approver: words("approver", "flowDecider").min(1).nullable(), toOwner: z.literal(true).optional(), message: message.nullable(), close: nil, script: nil, sort: nil, subagent: zoneId.optional(), limit: move, next, onFail }),
    z.strictObject({ id, title, kind: z.literal("check"), zone, instructions: said, planning: nil, approver: nil, message: message.nullable(), close: nil, script: scriptName, runIn: z.enum(FLOW_RUN_IN).optional(), routes, secrets: z.array(secretName).min(1).max(SECRETS_MAX).optional(), sort: nil, limit: remind, next, onFail }),
    z.strictObject({ id, title, kind: z.literal("pull-request"), zone, instructions: said, planning: nil, approver: nil, message: message.nullable(), close: nil, script: nil, sort: nil, merge: z.enum(FLOW_MERGE_METHODS).optional(), limit: remind, next, onFail }),
    z.strictObject({ id, title, kind: z.literal("update"), zone, instructions: said, planning: nil, approver: nil, message: message.nullable(), close: z.boolean(), script: nil, sort: nil, limit: remind, next, onFail }),
    z.strictObject({ id, title, kind: z.literal("notify"), zone, instructions: said, planning: nil, approver: nil, message, close: nil, script: nil, sort: nil, limit: remind, next, onFail }),
    z.strictObject({ id, title, kind: z.literal("sort"), zone, instructions: said, planning: nil, approver: nil, message: message.nullable(), close: nil, script: nil, sort: flowSortSchema, limit: remind, next: nil, onFail }),
    z.strictObject({ id, title, kind: z.literal("draft"), zone, instructions: text, planning: nil, approver: nil, message: message.nullable(), close: nil, script: nil, sort: nil, limit: remind, next, onFail }),
    z.strictObject({ id, title, kind: z.literal("request"), zone, instructions: said, planning: nil, approver: nil, message: message.nullable(), close: nil, script: nil, sort: nil, request: flowRequestSchema, limit: remind, next, onFail }),
    z.strictObject({ id, title, kind: z.literal("email"), zone, instructions: said, planning: nil, approver: nil, message: message.nullable(), close: nil, script: nil, sort: nil, email: flowEmailSchema, limit: remind, next, onFail }),
    z.strictObject({ id, title, kind: z.literal("tool"), zone, instructions: said, planning: nil, approver: nil, message: message.nullable(), close: nil, script: nil, sort: nil, tool: flowToolSchema, limit: remind, next, onFail }),
    z.strictObject({ id, title, kind: z.literal("wait"), zone, instructions: said, planning: nil, approver: nil, message: message.nullable(), close: nil, script: nil, sort: nil, wait: flowWaitSchema, next, onFail }),
    z.strictObject({ id, title, kind: z.literal("subagent"), zone, instructions: said, planning: nil, approver: nil, message: message.nullable(), close: nil, script: nil, sort: nil, subagent: zoneId, routes, reply: z.literal(true).optional(), limit: remind, next, onFail }),
    z.strictObject({ id, title, kind: z.literal("send"), zone, instructions: said, planning: nil, approver: nil, message: message.nullable(), close: nil, script: nil, sort: nil, limit: remind, next, onFail }),
    z.strictObject({ id, title, kind: z.literal("choose"), zone, instructions: said, planning: nil, approver: nil, message: message.nullable(), close: nil, script: nil, sort: nil, options: z.array(flowChoiceSchema).min(CHOICES_MIN).max(CHOICES_MAX), limit: move, next: nil, onFail }),
    z.strictObject({ id, title, kind: z.literal("done"), zone, instructions: said, planning: nil, approver: nil, message: message.nullable(), close: nil, script: nil, sort: nil, next: nil, onFail: nil }),
  ] as const;
}

export const FLOW_DEFINITION_VERSION = 1;
const definitionOf = (instructions: z.ZodString) => versioned(FLOW_DEFINITION_VERSION, {
  start: stageRef,
  stages: z.array(z.discriminatedUnion("kind", zoneSchemas(instructions))).min(1).max(FLOW_ZONES_MAX),
});
/** A flow's drawing as it is written now: what the canvas saves and steps become. */
export const flowDefinitionSchema = definitionOf(limited("instructions", "flowInstructions"));
/** A drawing saved earlier: the same, except instructions keep the length they were saved with (a limit is for writing). */
export const savedFlowDefinitionSchema = definitionOf(z.string());
export const flowStageSchema = flowDefinitionSchema.shape.stages.element;

type AnyKey<U> = U extends unknown ? keyof U : never;
type ValueAt<U, K extends PropertyKey> = U extends unknown ? (K extends keyof U ? U[K] : never) : never;
type RequiredKeys<T> = { [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? never : K }[keyof T];
type Everywhere<U, K extends PropertyKey> = U extends unknown ? (K extends RequiredKeys<U> ? true : false) : never;
/** A union's members as one object type: a key every member requires stays required, any other is optional. What code
 * that reads any zone (`stage.limit?.to`) works with; the schema itself stays a union. */
export type Widened<U> = { [K in AnyKey<U> as [Everywhere<U, K>] extends [true] ? K : never]: ValueAt<U, K> }
  & { [K in AnyKey<U> as [Everywhere<U, K>] extends [true] ? never : K]?: Exclude<ValueAt<U, K>, undefined> };
type Flat<T> = { [K in keyof T]: T[K] };

export type FlowZone = z.infer<typeof flowZoneSchema>;
export type FlowSortAnswer = z.infer<typeof flowSortAnswerSchema>;
export type FlowSortNote = z.infer<typeof flowSortNoteSchema>;
export type FlowSort = z.infer<typeof flowSortSchema>;
export type FlowRequest = z.infer<typeof flowRequestSchema>;
export type FlowEmail = z.infer<typeof flowEmailSchema>;
export type FlowTool = z.infer<typeof flowToolSchema>;
export type FlowWait = z.infer<typeof flowWaitSchema>;
export type FlowChoice = z.infer<typeof flowChoiceSchema>;
export type FlowLimit = z.infer<typeof limitMove>;
/** One zone of any kind (the union, widened: see Widened). */
export type FlowStage = Flat<Widened<z.infer<typeof flowStageSchema>>>;
export type FlowDefinition = { version: typeof FLOW_DEFINITION_VERSION; start: string; stages: FlowStage[] };

// ------------------------------------------------------------------ steps (and the flow file's zones)

/** A short field: bounded by its TEXT_LIMITS entry. Control and hidden characters in what a step or trigger says are
 * refused after parsing (the saved drawing's schema and the trigger reader name them), not restated per field here. */
const short = (key: keyof typeof TEXT_LIMITS) => z.string().max(TEXT_LIMITS[key]);
const ref = short("flowRef");
const duration = z.union([z.string().max(TEXT_LIMITS.flowDuration), minutes]);
const clockWritten = z.string().regex(CLOCK_WRITTEN, { error: "must be a time like 22:00" });

/** A step's route: an answer and the step it goes to. */
export const flowStepRouteSchema = z.strictObject({ answer: z.string().min(1).max(TEXT_LIMITS.flowAnswer), goesTo: ref });
/** A sort step's answer: its name, what it means (a few words Jev reads) and the step it goes to. */
export const flowStepAnswerSchema = z.strictObject({ answer: short("flowAnswer").min(1), means: short("flowSortMeans").optional(), goesTo: ref });
/** Something else a sort step notes: a score (levels lowest first) or a yes/no. */
export const flowStepNoteSchema = z.strictObject({
  id: zoneId.optional(), question: short("flowSortQuestion").min(1), kind: z.enum(["score", "yes-no"]).optional(),
  levels: z.array(short("flowSortLevel")).min(SORT_LEVELS_MIN).max(SORT_LEVELS_MAX).optional(),
});
/** A choose step's button: its words, and the step it goes to ("end", or none, ignores the card). */
export const flowStepOptionSchema = z.strictObject({ label: short("flowChoice").min(1), goesTo: ref.optional() });

/** Every field a step may give, each once; the kinds below say which are theirs. */
const STEP_FIELDS = {
  instructions: limited("instructions", "flowInstructions"),
  planning: z.enum(FLOW_PLANNING),
  /** approval: a sign-in name, "me", "owner" (the flow's owner), or "anyone" (or null). */
  decider: short("flowDecider").nullable(),
  message: limited("message", "flowMessage"),
  close: z.boolean(),
  script: scriptName,
  runIn: z.enum(FLOW_RUN_IN),
  routes: z.array(flowStepRouteSchema).max(ROUTES_MAX),
  secrets: z.array(secretName).max(SECRETS_MAX),
  question: short("flowSortQuestion"),
  answers: z.array(flowStepAnswerSchema).min(SORT_ANSWERS_MIN).max(SORT_ANSWERS_MAX),
  /** A percentage (80) or a fraction (0.8). */
  sureAt: z.number().min(SURE_AT_MIN).max(SURE_AT_PERCENT_MAX),
  alsoNote: z.array(flowStepNoteSchema).max(SORT_NOTES_MAX),
  method: z.enum(FLOW_METHODS),
  url: short("flowUrl"),
  headers: z.object({}).catchall(short("flowHeader")),
  body: limited("body", "flowBody"),
  to: short("flowEmailTo"),
  subject: short("flowEmailSubject"),
  server: short("flowToolServer"),
  tool: short("flowToolName"),
  /** An object, or the same as JSON text. */
  args: z.union([z.object({}).catchall(z.unknown()), short("flowToolArgs")]),
  waitFor: z.enum(FLOW_WAIT_FOR),
  /** Like "3 days" or "4 hours" (up to 30 days), or minutes. */
  wait: duration,
  from: clockWritten,
  until: clockWritten,
  timeZone: z.string().min(1).max(TEXT_LIMITS.flowTimeZone),
  /** squash, merge or rebase; true is squash. */
  merge: z.union([z.boolean(), z.enum(FLOW_MERGE_METHODS)]),
  /** Like "2 days" ("none" removes it), or minutes. */
  remindAfter: duration,
  thenMoveTo: ref,
  /** A subagent's short name; "nobody" takes one off. */
  subagent: z.string().min(1).max(TEXT_LIMITS.flowSubagent),
  reply: z.boolean(),
  options: z.array(flowStepOptionSchema).min(CHOICES_MIN).max(CHOICES_MAX),
  ifReplied: ref,
  repo: short("flowRepo"),
  next: ref,
  ifFails: ref,
  ifNotSure: ref,
  ifNoReply: ref,
} as const;
type StepField = keyof typeof STEP_FIELDS;

function optional<const Keys extends readonly StepField[]>(keys: Keys): { [P in Keys[number]]: z.ZodOptional<(typeof STEP_FIELDS)[P]> } {
  return Object.fromEntries(keys.map(key => [key, STEP_FIELDS[key].optional()])) as { [P in Keys[number]]: z.ZodOptional<(typeof STEP_FIELDS)[P]> };
}

/** What each kind of step takes, besides its id, title and kind. */
const STEP_KINDS = {
  inbox: ["next", "ifFails", "remindAfter", "thenMoveTo"],
  task: ["instructions", "planning", "repo", "next", "ifFails", "remindAfter"],
  report: ["instructions", "next", "ifFails", "remindAfter"],
  approval: ["decider", "subagent", "next", "ifFails", "remindAfter", "thenMoveTo"],
  check: ["script", "runIn", "routes", "secrets", "next", "ifFails", "remindAfter"],
  "pull-request": ["merge", "next", "ifFails", "remindAfter"],
  update: ["message", "close", "next", "ifFails", "remindAfter"],
  notify: ["message", "next", "ifFails", "remindAfter"],
  sort: ["question", "answers", "sureAt", "alsoNote", "ifNotSure", "remindAfter"],
  draft: ["instructions", "next", "ifFails", "remindAfter"],
  request: ["method", "url", "headers", "body", "next", "ifFails", "remindAfter"],
  email: ["to", "subject", "body", "next", "ifFails", "remindAfter"],
  tool: ["server", "tool", "args", "next", "ifFails", "remindAfter"],
  wait: ["waitFor", "wait", "from", "until", "timeZone", "next", "ifNoReply"],
  subagent: ["subagent", "instructions", "routes", "reply", "next", "ifFails", "remindAfter"],
  send: ["next", "ifFails", "remindAfter"],
  choose: ["options", "ifReplied", "remindAfter", "ifNoReply", "thenMoveTo"],
  done: [],
} as const satisfies Record<FlowStageKind, readonly StepField[]>;

const stepOf = <K extends FlowStageKind>(kind: K) => z.strictObject({
  /** Keeps an existing zone by its id, or names a new one so other steps can point at it. */
  id: z.string().min(1).max(TEXT_LIMITS.flowStepId).optional(),
  title: short("flowTitle").min(1),
  kind: z.literal(kind),
  ...optional(STEP_KINDS[kind]),
});
const STEPS = {
  inbox: stepOf("inbox"), task: stepOf("task"), report: stepOf("report"), approval: stepOf("approval"), check: stepOf("check"), "pull-request": stepOf("pull-request"),
  update: stepOf("update"), notify: stepOf("notify"), sort: stepOf("sort"), draft: stepOf("draft"), request: stepOf("request"), email: stepOf("email"),
  tool: stepOf("tool"), wait: stepOf("wait"), subagent: stepOf("subagent"), send: stepOf("send"), choose: stepOf("choose"), done: stepOf("done"),
};
const stepList = [STEPS.inbox, STEPS.task, STEPS.report, STEPS.approval, STEPS.check, STEPS["pull-request"], STEPS.update, STEPS.notify, STEPS.sort, STEPS.draft, STEPS.request, STEPS.email, STEPS.tool, STEPS.wait, STEPS.subagent, STEPS.send, STEPS.choose, STEPS.done] as const;

/** A step as the lead, `toolroll flows create/edit`, starters, kits and the gallery describe it, one schema per kind. */
export const flowStepSchema = z.discriminatedUnion("kind", stepList);
export type FlowStepInput = z.infer<typeof flowStepSchema>;
/** Any step's fields, for code that reads them whatever the kind. */
export type FlowStepFields = Flat<Widened<FlowStepInput>>;
/** A flow's steps, in order: what `flowFromSteps` reads. */
export const flowStepsSchema = z.strictObject({ steps: z.array(flowStepSchema).min(1).max(FLOW_ZONES_MAX) });

/** Where a flow file's zone sits on the canvas. */
const fileAt = z.strictObject({ x: z.number().optional(), y: z.number().optional(), w: z.number().optional(), h: z.number().optional(), color: z.enum(FLOW_COLORS).optional() }).describe("Where the zone sits on the canvas.");
const fileZone = <S extends (typeof stepList)[number]>(step: S) => step.extend({ id: zoneId, at: fileAt.optional() });
/** A flow file's zone: a step with its id and its place on the canvas. */
export const flowFileZoneSchema = z.discriminatedUnion("kind", [
  fileZone(STEPS.inbox), fileZone(STEPS.task), fileZone(STEPS.report), fileZone(STEPS.approval), fileZone(STEPS.check), fileZone(STEPS["pull-request"]),
  fileZone(STEPS.update), fileZone(STEPS.notify), fileZone(STEPS.sort), fileZone(STEPS.draft), fileZone(STEPS.request), fileZone(STEPS.email),
  fileZone(STEPS.tool), fileZone(STEPS.wait), fileZone(STEPS.subagent), fileZone(STEPS.send), fileZone(STEPS.choose), fileZone(STEPS.done),
]);
export type FlowFileZone = z.infer<typeof flowFileZoneSchema>;

/**
 * D5 (schema v117): a subagent step was a "teammate" step, naming its "teammate", and a flow file's needs said
 * "teammate:<handle>". Saved drawings, step lists and flow files from before still read: the old words mean the new ones.
 */
export function legacySubagentStep(step: unknown): unknown {
  if (step === null || typeof step !== "object" || Array.isArray(step)) return step;
  const row = step as Record<string, unknown>;
  if (row["kind"] !== "teammate" && !Object.hasOwn(row, "teammate")) return step;
  const { teammate, ...rest } = row;
  return { ...rest, ...(rest["kind"] === "teammate" ? { kind: "subagent" } : {}), ...(teammate !== undefined && rest["subagent"] === undefined ? { subagent: teammate } : {}) };
}
/** A flow file's need as it was written before D5 ("teammate:maya"), in today's words. */
export const legacyFlowNeed = (need: unknown): unknown => typeof need === "string" && need.startsWith("teammate:") ? `subagent:${need.slice(9)}` : need;

/** The keys people and models write for the ones a step means: refusals suggest them (contract.ts). */
export const FLOW_ALIASES: ContractOptions = {
  aliases: {
    onFail: ["ifFails", "ifNotSure", "ifNoReply", "ifReplied"], ifFails: ["ifNotSure", "ifNoReply", "ifReplied"], to: ["goesTo", "thenMoveTo"], goto: ["goesTo"], target: ["goesTo"],
    approver: ["decider"], toOwner: ["decider"], prompt: ["instructions"], description: ["instructions"], text: ["message", "instructions", "body"], name: ["title"],
    sort: ["question"], notes: ["alsoNote"], choices: ["options"], buttons: ["options"], limit: ["remindAfter"], minutes: ["wait"], until: ["thenMoveTo"],
    stages: ["steps", "zones"], zone: ["at"], label: ["title"],
  },
};

// ------------------------------------------------------------------ triggers

const zoneRef = { zone: z.string().max(TEXT_LIMITS.flowRef).optional() };
const delivery = z.enum(["poll", "webhook"]);
/** A trigger's settings as they are given: the console, `toolroll flows trigger add`, a flow file, a template, the lead. */
const TRIGGER_INPUTS = {
  button: z.strictObject({ kind: z.literal("button"), label: short("triggerButton").min(1), questions: z.union([z.array(short("triggerQuestion")).max(6), limited("questions", "triggerDescription")]).optional(), ...zoneRef }),
  schedule: z.strictObject({
    kind: z.literal("schedule"), schedule: short("triggerSchedule").min(1), title: short("triggerTitle").optional(), description: limited("description", "triggerDescription").optional(),
    script: scriptName.optional(), secrets: z.union([z.array(secretName).max(SECRETS_MAX), z.string().max(TEXT_LIMITS.triggerSecrets)]).optional(), ...zoneRef,
  }),
  github: z.strictObject({
    kind: z.literal("github"), repo: short("triggerGithubRepo").optional(), watch: z.enum(["issues", "pulls", "checks"]).optional(), label: short("triggerLabel").optional(),
    branch: short("triggerBranch").optional(), from: z.enum(["team", "anyone"]).optional(), delivery: delivery.optional(), ...zoneRef,
  }),
  linear: z.strictObject({ kind: z.literal("linear"), team: short("triggerTeam").optional(), state: short("triggerState").optional(), label: short("triggerLabel").optional(), delivery: delivery.optional(), ...zoneRef }),
  flow: z.strictObject({ kind: z.literal("flow"), flow: z.int().min(1), when: z.string().max(TEXT_LIMITS.flowRef).optional(), ...zoneRef }),
  webhook: z.strictObject({ kind: z.literal("webhook"), title: short("triggerWebhookTitle").optional(), titleField: short("triggerWebhookField").optional(), bodyField: short("triggerWebhookField").optional(), ...zoneRef }),
  email: z.strictObject({ kind: z.literal("email"), folder: short("triggerFolder").optional(), sender: short("triggerSender").optional(), subject: short("triggerSubject").optional(), ...zoneRef }),
  "plane-review": z.strictObject({ kind: z.literal("plane-review"), at: z.string().regex(/^\d{1,2}:\d{2}$/, { error: "must be a time like 07:30" }).optional(), timeZone: z.string().max(TEXT_LIMITS.flowTimeZone).optional(), ...zoneRef }),
};
export const triggerInputSchema = z.discriminatedUnion("kind", [TRIGGER_INPUTS.button, TRIGGER_INPUTS.schedule, TRIGGER_INPUTS.github, TRIGGER_INPUTS.linear, TRIGGER_INPUTS.flow, TRIGGER_INPUTS.webhook, TRIGGER_INPUTS.email, TRIGGER_INPUTS["plane-review"]]);
export type TriggerInput = z.infer<typeof triggerInputSchema>;
/** A flow file's trigger: one that names nothing on the installation it was made on (no chat channel, no other flow). */
export const flowFileTriggerSchema = z.discriminatedUnion("kind", [TRIGGER_INPUTS.button, TRIGGER_INPUTS.schedule, TRIGGER_INPUTS.github, TRIGGER_INPUTS.linear, TRIGGER_INPUTS.webhook, TRIGGER_INPUTS.email, TRIGGER_INPUTS["plane-review"]]);
/** The lead's trigger settings: no webhook (its address is made on the console), and no delivery setting; another flow is `follow`. */
export const leadTriggerSchema = z.discriminatedUnion("kind", [
  TRIGGER_INPUTS.button, TRIGGER_INPUTS.schedule, TRIGGER_INPUTS.github.omit({ delivery: true }), TRIGGER_INPUTS.linear.omit({ delivery: true }),
  TRIGGER_INPUTS.flow.omit({ flow: true }).extend({ follow: z.int().min(1).describe("The other flow's id (get_flows).") }), TRIGGER_INPUTS.email, TRIGGER_INPUTS["plane-review"],
]);

const ZONE_OR_NULL = { zone: zoneId.nullable() };
/**
 * v115: the exact task a schedule files each time — what a routine was before routines became scheduled flows. Its
 * terms are copied into each firing's scope unchanged; `costCeilingUsd` caps what its tasks spend in a rolling 7 days
 * and a firing waits while the last task is unfinished. `approval` is a routine's approval carried over whole (the
 * digest the approver signed over these terms, this schedule and project, and the agents it froze): while it still
 * verifies, each firing is approved as the routine's were; otherwise each firing is an ordinary proposal under the
 * project's approval rules. Only the v115 migration carries an approval; a template or a recipe makes one with none
 * (createScheduledFlow), and no trigger settings a person or a flow file gives can carry one.
 */
export const standingOrderSchema = z.strictObject({
  stem: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/),
  // The terms exactly as they were approved: each firing's filing checks them again, as every filing is checked.
  goal: z.string().max(8_000),
  outOfScope: z.string().max(8_000).nullable(),
  touches: z.array(z.string().max(800)).max(200),
  requirements: z.array(z.string().max(400)).max(100),
  acceptance: z.array(z.unknown()),
  budgetPerRunMicrousd: z.int().nullable(),
  costCeilingUsd: z.number().nullable(),
  singleFlight: z.literal(true),
  filedBy: z.string().min(1).nullable(),
  /** The routine it came from: that routine's earlier tasks still count toward one-at-a-time and the ceiling. */
  routine: z.int().nullable(),
  approval: z.strictObject({ digest: z.string().min(1), by: z.string().nullable(), at: z.string().min(1), profileJson: z.string().min(1), routeJson: z.string().min(1) }).nullable(),
});
export type StandingOrder = z.infer<typeof standingOrderSchema>;
/** A trigger as it is saved (`configJson`), one schema per kind. */
export const triggerConfigSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("button"), label: z.string().min(1).max(TEXT_LIMITS.triggerButton), questions: z.array(z.string().min(1).max(TEXT_LIMITS.triggerQuestion)).min(1).max(6), ...ZONE_OR_NULL }),
  /** `script`: run this project script on the schedule and make a card of each item it prints, instead of one card titled `title`. */
  z.strictObject({ kind: z.literal("schedule"), schedule: z.string().min(1), title: z.string().min(1).max(TEXT_LIMITS.triggerTitle), description: z.string().max(TEXT_LIMITS.triggerDescription).nullable(), ...ZONE_OR_NULL, script: scriptName.optional(), secrets: z.array(secretName).min(1).max(SECRETS_MAX).optional(), order: standingOrderSchema.optional() }),
  z.strictObject({ kind: z.literal("github"), repo: z.string().min(1).max(TEXT_LIMITS.triggerGithubRepo), watch: z.enum(["issues", "pulls", "checks"]), label: z.string().max(TEXT_LIMITS.triggerLabel).nullable(), branch: z.string().max(TEXT_LIMITS.triggerBranch).nullable(), from: z.enum(["team", "anyone"]), delivery, ...ZONE_OR_NULL }),
  z.strictObject({ kind: z.literal("linear"), team: z.string().max(TEXT_LIMITS.triggerTeam).nullable(), state: z.string().max(TEXT_LIMITS.triggerState).nullable(), label: z.string().max(TEXT_LIMITS.triggerLabel).nullable(), delivery, ...ZONE_OR_NULL }),
  z.strictObject({ kind: z.literal("flow"), flow: z.int().min(1), when: zoneId, ...ZONE_OR_NULL }),
  z.strictObject({ kind: z.literal("webhook"), title: z.string().min(1).max(TEXT_LIMITS.triggerWebhookTitle), titleField: z.string().max(TEXT_LIMITS.triggerWebhookField).nullable(), bodyField: z.string().max(TEXT_LIMITS.triggerWebhookField).nullable(), ...ZONE_OR_NULL }),
  /** `sender`: addresses or domains, comma-separated; `subject`: words the subject must contain. */
  z.strictObject({ kind: z.literal("email"), folder: z.string().min(1).max(TEXT_LIMITS.triggerFolder), sender: z.string().max(TEXT_LIMITS.triggerSender).nullable(), subject: z.string().max(TEXT_LIMITS.triggerSubject).nullable(), ...ZONE_OR_NULL }),
  /** A channel in a chat app; `binding` is the pairing of the person who connected it (whose chat answers there). */
  z.strictObject({ kind: z.literal("chat"), app: z.enum(["slack", "discord", "teams", "telegram"]), installation: z.string().min(1), chat: z.string().min(1), binding: z.int(), ...ZONE_OR_NULL }),
  /** `schedule`: always daily, in the routines' form ("daily:07:30@Europe/London"). */
  z.strictObject({ kind: z.literal("plane-review"), schedule: z.string().min(1), ...ZONE_OR_NULL }),
]);
export type TriggerConfig = z.infer<typeof triggerConfigSchema>;
export type ChatApp = Extract<TriggerConfig, { kind: "chat" }>["app"];

// ------------------------------------------------------------------ the flow file

export const FLOW_FILE_FORMAT = "toolroll-flow";
export const FLOW_FILE_VERSION = 1;
/** Something the import asks for: `{{param.<id>}}` in a zone or trigger is replaced by its value. */
export const flowFileParameterSchema = z.strictObject({
  id: z.string().regex(PARAMETER_ID, { error: "must be a short id: lowercase letters, numbers and dashes" }),
  about: visible("about", "flowParameter").min(1).describe("The question the import asks."),
  default: visible("default", "flowParameter").optional(),
  optional: z.boolean().optional().describe("May be left empty (the field is then left out)."),
});
/** A project script a zone or schedule runs. Imported held until a person approves it. */
export const flowFileScriptSchema = z.strictObject({
  name: scriptName, about: limited("about", "flowScriptAbout"), language: z.enum(SCRIPT_LANGUAGES).optional().describe("Shell when left out."), timeoutMinutes: z.int().min(1).max(60).optional().describe("15 when left out."),
  body: limited("body", "flowScriptBody").optional(), file: limited("file", "flowScriptFile").optional().describe("A path inside the project, run instead of a body."),
});
/** A flow exported as readable JSON (*.toolroll-flow.json): docs/flow-file.schema.json is this schema. */
export const flowFileSchema = versioned(FLOW_FILE_VERSION, {
  format: z.literal(FLOW_FILE_FORMAT),
  name: visible("name", "flowName").min(1),
  about: visible("about", "flowFileAbout").optional().describe("One line on what the flow does. Untrusted: shown in the import preview."),
  needs: z.array(visible("need", "flowFileNeed").min(1)).max(40).optional().describe("What the flow needs to run: github, linear, openrouter, email, tool:<server>, secret:<NAME>, subagent:<handle>, script:<name>."),
  parameters: z.array(flowFileParameterSchema).max(20).optional(),
  zones: z.array(flowFileZoneSchema).min(1).max(FLOW_ZONES_MAX).describe("The zones in order; the first is where cards start."),
  triggers: z.array(flowFileTriggerSchema).max(10).optional(),
  scripts: z.array(flowFileScriptSchema).max(20).optional(),
});
export type FlowFileParameter = z.infer<typeof flowFileParameterSchema>;
/** A flow file's script as it is read: its language and time limit said (shell and 15 minutes when the file leaves them out). */
export type FlowFileScript = z.infer<typeof flowFileScriptSchema> & { language: ScriptLanguage; timeoutMinutes: number };
export type FlowFileTrigger = z.infer<typeof flowFileTriggerSchema>;
/** A flow file as it is read: every list present (left out reads as empty), its about line said ("" when it says none). */
export type FlowFile = { format: typeof FLOW_FILE_FORMAT; version: typeof FLOW_FILE_VERSION; name: string; about: string; needs: string[]; parameters: FlowFileParameter[]; zones: FlowFileZone[]; triggers: FlowFileTrigger[]; scripts: FlowFileScript[] };

/** docs/flow-file.schema.json: the flow file's schema as published for people and other tools, generated from
 * flowFileSchema (`npx tsx scripts/flow-file-schema.ts`); flow.test.ts checks the file is exactly this. */
export function flowFileJsonSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://github.com/ap9000/toolroll/docs/flow-file.schema.json",
    title: "Toolroll flow file",
    description: "A flow exported from Toolroll (*.toolroll-flow.json): its zones in the lead's step vocabulary, one shape per kind, its triggers' settings and the scripts it runs. Never secrets, webhook addresses or hashes, tokens, people's names, chat bindings or cards. {{param.<id>}} in a zone or trigger is replaced by the value the import asks for. Unknown keys are refused by name. Toolroll reads files up to 256 KB and checks every zone, trigger and script again on import (src/flow-share.ts). Generated from src/contracts/flow.ts.",
    ...toModelSchema(flowFileSchema),
  };
}
