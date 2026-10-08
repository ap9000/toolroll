/**
 * The lead's tools (docs/plans/zod-revamp.md, item 5): one input schema per tool, and one output schema for what each
 * returns when it succeeds. The input schema supplies the JSON Schema the lead is given (`toModelSchema`) and the
 * compatible reader used before any handler runs (mate-tools.ts), so a refusal names the paths it reads next step.
 * What JSON Schema can't say — a repo the operator may reach, plain text without secrets, an ISO time, a decision read
 * in an earlier step — is still checked in plain code after parsing, with its own words.
 *
 * Output schemas describe a result's top level. They are checked in tests and logged when a result disagrees; a call
 * that succeeds is never refused because of one (an output schema is a record of the contract, not a gate).
 */

import { z } from "zod";
import { CHAT_ACTIONS } from "../chat-actions.js";
import { RESULT_IMAGES_PER_TURN_CAP } from "../chat-evidence.js";
import { CHAT_CONTROLS } from "../chat-controls.js";
import { CHAT_TASK_ACTIONS } from "../chat-task-actions.js";
import { LIMITS } from "../decision.js";
import { CHECK_RESULTS, RUN_OUTCOMES, TASK_STATES } from "../lead-commitments.js";
import { PERSON_ID } from "../lead-people.js";
import { TASK_SIZES } from "../phase-routing.js";
import { ACCEPTANCE_LIMITS } from "../scope.js";
import { TEAMMATE_TEMPLATES } from "../teammates.js";
import { TEXT_LIMITS, type TextLimitKey } from "../text-limits.js";
import { parseContract, type ContractOptions } from "./contract.js";
import { FLOW_ALIASES } from "./flow.js";
import { proposeFlowInputSchema } from "./flow-propose.js";
import { acceptanceCriterionSchema } from "./plan.js";

const enumOf = (values: readonly string[]) => z.enum(values as [string, ...string[]]);
const text = (key: TextLimitKey) => z.string().max(TEXT_LIMITS[key]);
const id = z.int().min(1);
const offset = z.int().min(0);

/** Text a model is told is "refused with its length, not cut": the refusal says how long it was. */
function overBy(limit: number, input: unknown): string {
  const count = (n: number) => n.toLocaleString("en-US");
  return `over ${count(limit)} characters (it is ${typeof input === "string" ? count(input.length) : "longer"}): shorten it and call again`;
}

/** A task as a tool names it: its id. */
export const taskRef = z.string().min(1).max(TEXT_LIMITS.taskRef);
/** A project as list_repos names it (r1, r2). */
export const repoId = z.string().regex(/^r[0-9]{1,3}$/);
/** A task's goal or what it leaves out: the length a model is told before it writes, and refused (not cut) beyond. */
export const scopeText = z.string().max(TEXT_LIMITS.goal, { error: issue => overBy(TEXT_LIMITS.goal, issue.input) })
  .describe(`At most ${TEXT_LIMITS.goal.toLocaleString("en-US")} characters (UTF-16 code units) and ${TEXT_LIMITS.goalBytes.toLocaleString("en-US")} UTF-8 bytes; no control or disguised text. Longer text is refused with its length, not cut: shorten it and call again.`);
/** The paths a task expects to touch. */
export const touches = z.array(text("taskTouch")).max(50);
/** The rubric a task is accepted against: the plan's own criterion schema; duplicate ids and byte limits are checked after. */
export const acceptance = z.array(acceptanceCriterionSchema).min(1).max(ACCEPTANCE_LIMITS.criteria);
/** A note the operator's own words fill (revise feedback, steering, a flow card's note). */
const note = z.string().max(LIMITS.note, { error: issue => overBy(LIMITS.note, issue.input) }).describe(`At most ${LIMITS.note} characters; longer is refused with its length, not cut.`);
/** Task states a list filters by. */
export const LISTED_TASK_STATES = ["queued", "running", "done", "failed", "cancelled"] as const;

/** The shared actions the lead proposes with propose_action; flows and teammates have their own tools. */
const ACTION_OPERATIONS = Object.keys(CHAT_ACTIONS).filter(one => !one.startsWith("flow_") && !one.startsWith("teammate_"));

export const LEAD_TOOL_INPUTS = {
  get_brief: z.strictObject({ repo: repoId.optional() }),
  get_project_context: z.strictObject({ repo: repoId, query: text("contextQuery").min(1), mode: z.enum(["search", "impact"]).optional() }),
  get_action_status: z.strictObject({ proposal: id }),
  get_actions: z.strictObject({}),
  propose_action: z.strictObject({
    operation: enumOf(ACTION_OPERATIONS), repo: z.string().optional(), task: taskRef.optional(), version: z.string().optional(), restore: id.optional(),
    sample: text("actionSample").optional(), content: text("actionContent").optional(), instructions: text("flowInstructions").optional(),
    title: text("actionTitle").optional(), id: z.string().optional(), run: id.optional(), note: note.optional(), catalog: text("actionName").optional(),
    name: text("actionName").optional(), command: text("actionCommand").optional(), args: z.array(text("actionCommand")).max(40).optional(),
    url: text("actionUrl").optional(), secrets: z.array(text("actionSecret")).max(12).optional(), about: text("actionAbout").optional(),
  }),
  propose_task_action: z.strictObject({ task: taskRef, operation: enumOf(Object.keys(CHAT_TASK_ACTIONS)), dependency: taskRef.optional(), run: id.optional() }),
  get_controls: z.strictObject({}),
  show_control: z.strictObject({ control: enumOf(Object.keys(CHAT_CONTROLS)), task: taskRef.optional(), repo: repoId.optional(), run: id.optional() }),
  offer_approval: z.strictObject({ task: taskRef.optional(), card: id.optional() }),
  get_result: z.strictObject({ task: taskRef, run: id.optional(), feedback_offset: offset.optional() }),
  get_diff: z.strictObject({ task: taskRef, run: id.optional(), file: text("diffPath").min(1).optional(), offset: offset.optional() }),
  get_check_log: z.strictObject({ task: taskRef, run: id.optional(), search: text("logSearch").min(2).optional(), offset: offset.optional() }),
  get_acceptance_evidence: z.strictObject({ task: taskRef, run: id.optional(), offset: offset.optional() }),
  get_result_images: z.strictObject({ task: taskRef, run: id.optional(), offset: offset.optional(), images: z.array(id).min(1).max(RESULT_IMAGES_PER_TURN_CAP).optional() }),
  propose_review: z.strictObject({
    run: id, operation: z.enum(["note", "revise"]),
    // A note, path or line left as null reads as left out, as it always has.
    note: z.string().max(LIMITS.note).nullable().optional(), path: text("diffPath").nullable().optional(),
    line: z.int().min(1).max(1_000_000).nullable().optional(),
    saved_notes: z.array(id).max(100).optional(),
  }),
  recap: z.strictObject({ since: text("recapSince").optional() }),
  list_repos: z.strictObject({}),
  get_project_tools: z.strictObject({ repo: repoId }),
  get_flows: z.strictObject({ repo: repoId.optional(), flow: id.optional(), card: id.optional() }),
  // The flow contract's own schema (src/contracts/flow-propose.ts), never a second one here.
  propose_flow: proposeFlowInputSchema,
  get_teammates: z.strictObject({ repo: repoId.optional(), teammate: id.optional() }),
  propose_teammate: z.strictObject({
    operation: z.enum(["create", "edit_section", "edit_soul", "pause", "resume", "remove", "note", "answer", "use_tool", "stop_tool", "tool_rule", "forget", "edit_memory", "add_routine", "stop_routine", "undo"]),
    section: text("teammateSection").optional(), schedule: text("teammateSchedule").optional(), routine: id.optional(), memory: id.optional(),
    tool: text("teammateTool").optional(), action: text("teammateAction").optional(), undoWith: text("teammateAction").optional(), call: id.optional(),
    use: z.enum(["free", "ask", "never"]).optional(), limitField: text("teammateAction").optional(), limitOver: z.number().min(0).optional(),
    repo: repoId.optional(), teammate: id.optional(), template: enumOf(TEAMMATE_TEMPLATES.map(one => one.id)).optional(),
    name: text("teammateName").optional(), soul: text("teammateSoul").optional(), note: text("teammateNote").optional(),
    question: id.optional(), choice: text("teammateChoice").optional(), text: text("teammateText").optional(),
  }),
  get_flow_insights: z.strictObject({ repo: repoId.optional(), flow: id.optional(), days: z.int().min(1).max(90).optional(), card: id.optional(), entry: id.optional() }),
  get_skills: z.strictObject({ repo: repoId, version: z.string().regex(/^[a-f0-9]{20}$/).optional(), offset: offset.optional() }),
  get_project_knowledge: z.strictObject({ repo: repoId, reference: text("knowledgeReference").optional(), decision: id.optional() }),
  get_task_conversation: z.strictObject({ task: taskRef, limit: z.int().min(1).max(30).optional() }),
  commit_to: z.strictObject({
    what: text("promise").min(3), when: z.enum(["task", "run", "check", "time"]), task: taskRef.optional(), run: id.optional(),
    states: z.array(enumOf(TASK_STATES)).min(1).max(6).optional(), outcome: z.enum(RUN_OUTCOMES).optional(),
    result: z.enum(CHECK_RESULTS).optional(), at: z.string().optional(), checkAfter: z.string().optional(),
  }),
  release_commitment: z.strictObject({ commitment: id, reason: text("promise").min(3) }),
  remember: z.strictObject({
    repo: repoId.optional(), kind: z.enum(["decision", "instruction", "about-you"]), text: text("rememberText").min(3), why: text("rememberWhy").optional(),
    source: text("rememberSource").optional(), revision: offset.optional(), replaces: z.int().min(1).max(20).optional(),
  }),
  get_person: z.strictObject({ id: z.string().regex(PERSON_ID).optional(), name: text("personName").min(1).optional() }),
  get_integrations: z.strictObject({}),
  get_capabilities: z.strictObject({ repo: repoId.optional() }),
  ask_owner: z.strictObject({ question: text("ownerQuestion").min(3), options: z.array(text("ownerOption").min(1)).min(2).max(4) }),
  search_project_memory: z.strictObject({ query: text("memorySearch").min(2), repo: repoId.optional() }),
  get_models: z.strictObject({}),
  list_tasks: z.strictObject({ repo: repoId.optional(), state: z.enum(LISTED_TASK_STATES).optional(), limit: z.int().min(1).max(50).optional(), search: text("taskSearch").optional() }),
  get_task: z.strictObject({ task: taskRef }),
  get_agents: z.strictObject({ task: taskRef }),
  list_decisions: z.strictObject({}),
  get_decision: z.strictObject({ decision: id }),
  queue: z.strictObject({ repo: repoId }),
  propose_task: z.strictObject({
    repo: repoId, title: text("taskTitle"), goal: scopeText,
    // Exclusions left as null read as none, as they always have.
    not: scopeText.nullable().optional(), touches: touches.optional(), acceptance,
    planning: z.enum(["auto", "required", "skip"]).optional(), report: z.boolean().optional(), checks: text("checksWords").optional(),
  }),
  propose_next: z.strictObject({ task: taskRef }),
  propose_reserve: z.strictObject({ task: taskRef, worker: text("workerName").nullable() }),
  propose_hold: z.strictObject({ task: taskRef, reason: text("proposalReason") }),
  propose_unhold: z.strictObject({ task: taskRef }),
  propose_steer: z.strictObject({ task: taskRef, note }),
  propose_dependency_repair: z.strictObject({ task: taskRef, blocker: taskRef, operation: z.enum(["retry", "unlink", "replace"]), replacement: taskRef.optional() }),
  propose_scope: z.strictObject({ task: taskRef, goal: scopeText, not: scopeText.nullable().optional(), touches: touches.optional(), acceptance }),
  propose_agents: z.strictObject({
    task: taskRef,
    size: z.enum(TASK_SIZES as readonly string[] as ["small", "medium", "large"]).optional(), risky: z.boolean().optional(),
    role: z.enum(["planner", "builder", "repair"]).optional(),
    agent: z.strictObject({ provider: text("agentProvider"), model: text("agentModel") }).optional(),
    clear: z.boolean().optional(), why: text("agentWhy").optional(),
  }),
  propose_answer: z.strictObject({ decision: id, option: text("answerOption").min(1), rationale: text("answerRationale") }),
  propose_cancel: z.strictObject({ task: taskRef, reason: text("proposalReason") }),
} as const;

export type LeadToolName = keyof typeof LEAD_TOOL_INPUTS;

/**
 * Read the same calls the 0.9.36 handlers accepted. Derive readers from the advertised contracts, leaving these
 * optional values to their existing clamp/fallback code. Unknown top-level keys are stripped by the tool registry,
 * except for flow proposals, whose strict contract predates item 5. The gateway also keeps its strict schemas.
 */
export const LEAD_TOOL_READ_INPUTS = {
  ...LEAD_TOOL_INPUTS,
  list_tasks: LEAD_TOOL_INPUTS.list_tasks.extend({ limit: z.unknown().optional() }),
  get_task_conversation: LEAD_TOOL_INPUTS.get_task_conversation.extend({ limit: z.unknown().optional() }),
  // 0.9.36 read a null repo as every project.
  get_flow_insights: LEAD_TOOL_INPUTS.get_flow_insights.extend({ repo: repoId.nullable().optional(), days: z.unknown().optional() }),
  get_person: LEAD_TOOL_INPUTS.get_person.extend({ id: z.unknown().optional(), name: z.unknown().optional() }),
  propose_agents: LEAD_TOOL_INPUTS.propose_agents.extend({ agent: LEAD_TOOL_INPUTS.propose_agents.shape.agent.unwrap().strip().optional() }),
} as const;

export type LeadToolInput<N extends LeadToolName> = z.infer<(typeof LEAD_TOOL_READ_INPUTS)[N]>;

/** How a tool's call names a key it doesn't know: propose_flow suggests the flow vocabulary's own words. */
export const LEAD_TOOL_OPTIONS: Partial<Record<LeadToolName, ContractOptions>> = { propose_flow: FLOW_ALIASES };

// ------------------------------------------------------------- outputs

const str = z.string();
const int = z.number().int();
const list = z.array(z.unknown());
const nullable = <T extends z.ZodType>(schema: T) => schema.nullable();
const rows = <S extends z.ZodRawShape>(shape: S) => z.array(z.looseObject(shape));

/** A proposal drafted as a card the operator confirms (propose_action, propose_flow, propose_teammate). */
const cardDrafted = z.looseObject({ proposal: int, label: str, awaiting: str, executed: z.literal(false) });
/** A proposal row drafted by one of the queue, hold, scope and answer tools. */
const proposed = <K extends string>(kind: K, shape: z.ZodRawShape = {}) => z.looseObject({ proposal: int, kind: z.literal(kind), awaiting: str, ...shape });

/** A repository-context read (repository-context.ts `RepositoryContext`). */
export const repositoryContextOutput = z.looseObject({ version: z.literal(1), readOnly: z.boolean(), query: str, mode: z.enum(["search", "impact"]), asOf: str, excerpts: list });
/** The local catch-up (assignment-brief.ts `AssignmentCatchUp`). */
export const catchUpOutput = z.looseObject({ version: z.literal(1), asOf: str, readOnly: z.literal(true), assignments: list, projects: list, omissions: z.looseObject({}) });
/** How things stand per repository (mate-tools.ts `recapOver`), its repos labelled. */
export const recapOutput = z.looseObject({ since: nullable(str), repos: list, waitsOnYou: z.looseObject({ decisions: list, incidents: int, scopesAwaitingApproval: list }), running: list, truncated: z.boolean() });
/** Open decisions (`decisionsOver`). */
export const decisionsOutput = z.looseObject({ decisions: rows({ decision: int, task: str, question: str, options: list, ageHours: z.number() }), truncated: z.boolean() });
/** One decision in full (`decisionOver`), without the builder's recommendation. */
export const decisionOutput = z.looseObject({ repo: str, decision: int, task: str, state: str, question: str, options: rows({ id: str, label: str, reversible: z.boolean(), consequence: str }), ageHours: z.number() });
/** One repository's queue by column (`queueOver`). */
export const queueColumnsOutput = { columns: rows({ column: str, tasks: list }) };

export const LEAD_TOOL_OUTPUTS = {
  get_brief: catchUpOutput,
  get_project_context: repositoryContextOutput,
  get_action_status: z.looseObject({ proposal: int, operation: str, state: str, outcome: z.unknown(), finishedAt: nullable(str) }),
  get_actions: z.looseObject({ actions: rows({ operation: str, label: str, secureReview: z.boolean(), inputs: z.array(str) }), notice: str }),
  propose_action: cardDrafted,
  propose_task_action: z.looseObject({ proposal: int, action: str, awaiting: str }),
  get_controls: z.looseObject({ confirmedInChat: z.array(str), existingControls: rows({ id: str, label: str, needsTask: z.boolean(), needsProject: z.boolean() }), rule: str }),
  show_control: z.looseObject({ card: int, label: str, action: str }),
  offer_approval: z.looseObject({ offered: z.boolean() }),
  get_result: z.looseObject({
    task: str, root: str, currentExecution: str, run: int, title: str, feedback: list, feedbackTotal: int, nextFeedbackOffset: nullable(int),
    changes: str, changesShortened: z.boolean(), verification: str, accepted: z.boolean(), evidenceTool: str, canRevise: z.boolean(),
  }),
  get_diff: z.looseObject({ task: str, run: int, files: rows({ path: str, added: int, removed: int }).optional(), file: str.optional(), diff: str.optional(), nextOffset: nullable(int).optional(), notice: nullable(str) }),
  get_check_log: z.looseObject({ task: str, run: int, log: str, notice: nullable(str) }),
  get_acceptance_evidence: z.looseObject({ task: str, run: int }),
  get_result_images: z.looseObject({
    task: str, run: int, imageCount: int, images: rows({ id: int, position: int, selected: z.boolean() }), selected: z.array(int), selectedCount: int,
    sendCount: int, nextImageOffset: nullable(int), nextImageIds: z.array(int), unavailable: list, delivery: str,
  }),
  propose_review: proposed("review", { operation: z.enum(["note", "revise"]) }),
  recap: recapOutput,
  list_repos: z.looseObject({ repos: rows({ repo: str }) }),
  get_project_tools: z.looseObject({ rule: str, tools: rows({ name: str }), connectBySigningIn: list, commonTools: list, foundOnThisComputer: list, notice: str }),
  get_flows: z.union([
    z.looseObject({ flow: int, name: str, steps: rows({ id: str, title: str, kind: str }), cards: rows({ card: int, title: str }), scripts: list, triggers: list, rule: str }),
    z.looseObject({ flows: rows({ flow: int, name: str, cards: int, needYou: int, triggers: int }), templates: list, scripts: list, rule: str }),
  ]),
  propose_flow: cardDrafted,
  get_teammates: z.looseObject({ teammates: rows({ teammate: int, name: str, working: z.boolean(), soul: str }), templates: list, rule: str }),
  propose_teammate: cardDrafted,
  get_flow_insights: z.union([
    z.looseObject({ days: int, flows: rows({ flow: int, name: str }) }),
    z.looseObject({ card: int, entry: int, state: str, log: str }),
    z.looseObject({ runs: list, rule: str }),
  ]),
  get_skills: z.union([
    z.looseObject({ version: str, instructions: str, nextOffset: nullable(int), notice: str }),
    z.looseObject({ skills: list, nextOffset: nullable(int) }),
  ]),
  get_project_knowledge: z.looseObject({ revision: int }),
  get_task_conversation: z.looseObject({ task: str, messages: rows({ from: z.enum(["operator", "lead"]), text: str, at: str }), notice: nullable(str) }),
  commit_to: z.looseObject({ commitment: int, condition: str, expires: str, report: str }),
  release_commitment: z.looseObject({ commitment: int, state: z.literal("cancelled") }),
  remember: z.looseObject({ proposal: int, label: str, awaiting: str, executed: z.literal(false), next: str }),
  get_person: z.union([z.looseObject({ person: z.looseObject({}) }), z.looseObject({ several: list, next: str })]),
  get_integrations: z.looseObject({ integrations: rows({ name: str, kind: str, state: str }), settings: str }),
  get_capabilities: z.looseObject({ projects: rows({ repo: str }), workers: z.unknown(), integrations: z.unknown(), rule: str }),
  ask_owner: z.looseObject({ asked: str, options: z.array(str), shown: str }),
  search_project_memory: z.looseObject({ hits: list, notice: str }),
  get_models: z.looseObject({ roles: rows({ role: str }), tools: list, newModels: list, change: str }),
  list_tasks: z.looseObject({ tasks: rows({ repo: str, task: str, execution: str, title: str, state: str, ageHours: z.number(), strikes: int }), truncated: z.boolean() }),
  get_task: z.looseObject({
    repo: str, task: str, root: str, currentExecution: str, title: str, state: str, deliverable: str, scope: str,
    queue: nullable(z.looseObject({ position: int, of: int, column: str })), holds: list, attempts: int, decisionsOpen: int, dependencies: list,
  }),
  get_agents: z.looseObject({ repo: str, task: str, standing: str, agents: list, choices: z.looseObject({}), approval: str, organisationPolicy: z.looseObject({}) }),
  list_decisions: decisionsOutput,
  get_decision: decisionOutput,
  queue: z.looseObject({ repo: str, queueRevision: int, ...queueColumnsOutput }),
  propose_task: proposed("task", { repo: str, deliverable: z.enum(["branch", "report"]), planning: str }),
  propose_next: proposed("next", { task: str }),
  propose_reserve: proposed("reserve", { task: str, worker: nullable(str) }),
  propose_hold: proposed("hold", { task: str }),
  propose_unhold: proposed("unhold", { task: str }),
  propose_steer: proposed("steer", { task: str }),
  propose_dependency_repair: proposed("repair", { task: str, blocker: str, operation: z.enum(["retry", "unlink", "replace"]) }),
  propose_scope: proposed("scope", { task: str }),
  propose_agents: proposed("agents", { task: str }),
  propose_answer: proposed("answer", { decision: int, option: str }),
  propose_cancel: proposed("cancel", { task: str }),
} as const satisfies Record<LeadToolName, z.ZodType>;

export type LeadToolOutput<N extends LeadToolName> = z.infer<(typeof LEAD_TOOL_OUTPUTS)[N]>;

/**
 * Report a result that disagrees with its output schema without hiding the actual result, including under Vitest.
 * Contract tests assert output shapes directly; executing a tool always writes the diagnostic and returns its result.
 */
export function reportToolOutput(surface: "lead" | "gateway", tool: string, schema: z.ZodType, body: unknown): void {
  const read = parseContract(schema, body);
  if (read.ok) return;
  const line = `${surface} tool ${tool}: its result disagrees with its output schema — ${read.issues.map(one => one.line).join("; ")}`;
  process.stderr.write(`${line}\n`);
}
