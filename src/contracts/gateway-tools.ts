/**
 * The MCP gateway's tools (docs/plans/zod-revamp.md, item 5; docs/mcp-gateway-spec.md): one input schema per tool and
 * one output schema for what each returns. The input schema is the `inputSchema` tools/list advertises and the check
 * a call is read with before its handler runs (mcp.ts): a call it refuses is a JSON-RPC InvalidParams error naming each
 * path, never a tool refusal. The assignment tools' schemas are also what `toolroll assignment` reads its flags with
 * (assignment-adapters.ts), so the CLI and the gateway take exactly the same arguments.
 *
 * A coordinator names a project by its path and a task by `ref`; the lead's tools (lead-tools.ts) say r1 and `task`.
 * Output schemas describe a result's top level: checked in tests, logged when a result disagrees, never a refusal.
 */

import { z } from "zod";
import { TEXT_LIMITS, type TextLimitKey } from "../text-limits.js";
import { envelopeSchema } from "./cli.js";
import { catchUpOutput, decisionOutput, decisionsOutput, LISTED_TASK_STATES, queueColumnsOutput, recapOutput, repositoryContextOutput, scopeText, touches } from "./lead-tools.js";

const text = (key: TextLimitKey) => z.string().max(TEXT_LIMITS[key]);
const ref = z.string().min(1).max(TEXT_LIMITS.taskRef);
const projectPath = text("projectPath").min(1);
const gatewayRepo = text("gatewayRepo").min(1);
const consumer = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]{0,63}$/, { error: "must be a stable consumer name: lowercase letters, digits and hyphens" });
const limit = (most: number) => z.int().min(1).max(most);

/** The assignment tools, by the operation `toolroll assignment` names them. */
export const ASSIGNMENT_INPUTS = {
  show: z.strictObject({ ref }),
  updates: z.strictObject({ after: z.int().min(0).optional(), limit: limit(100).optional() }),
  claim: z.strictObject({ ref }),
  check: z.strictObject({ ref, digest: z.string().min(64).max(64).regex(/^[a-f0-9]{64}$/, { error: "must be the exact 64-character receipt digest from assignment show" }) }),
  brief: z.strictObject({ repo: projectPath.optional(), limit: limit(25).optional() }),
  inbox: z.strictObject({ consumer, limit: limit(100).optional() }),
  ack: z.strictObject({ consumer, batchId: z.string().min(32).max(32).regex(/^[a-f0-9]{32}$/, { error: "must be the exact batchId from assignment inbox" }) }),
} as const;
export type AssignmentOperation = keyof typeof ASSIGNMENT_INPUTS;
export type AssignmentInput<O extends AssignmentOperation> = z.infer<(typeof ASSIGNMENT_INPUTS)[O]>;

export const GATEWAY_TOOL_INPUTS = {
  get_project_context: z.strictObject({ repo: projectPath, query: text("contextQuery").min(1), mode: z.enum(["search", "impact"]).optional() }),
  get_assignment: ASSIGNMENT_INPUTS.show,
  list_assignment_updates: ASSIGNMENT_INPUTS.updates,
  claim_assignment: ASSIGNMENT_INPUTS.claim,
  acknowledge_assignment: ASSIGNMENT_INPUTS.check,
  get_assignment_brief: ASSIGNMENT_INPUTS.brief,
  get_assignment_inbox: ASSIGNMENT_INPUTS.inbox,
  acknowledge_assignment_delivery: ASSIGNMENT_INPUTS.ack,
  status: z.strictObject({}),
  list_tasks: z.strictObject({ state: z.enum(LISTED_TASK_STATES).optional(), repo: text("gatewayRepo").optional(), cursor: z.int().min(0).optional(), limit: limit(50).optional() }),
  get_task: z.strictObject({ ref }),
  list_repos: z.strictObject({}),
  recap: z.strictObject({ since: text("recapSince").optional() }),
  list_decisions: z.strictObject({}),
  queue: z.strictObject({ repo: gatewayRepo }),
  get_decision: z.strictObject({ decision: z.int().min(1) }),
  propose_next: z.strictObject({ ref }),
  propose_reserve: z.strictObject({ ref, worker: text("workerName").nullable() }),
  propose_hold: z.strictObject({ ref, reason: text("proposalReason") }),
  propose_unhold: z.strictObject({ ref }),
  propose_scope: z.strictObject({ ref, goal: scopeText, not: scopeText.optional(), touches: touches.optional() }),
  propose_cancel: z.strictObject({ ref, reason: text("proposalReason") }),
  propose_answer: z.strictObject({ decision: z.int().min(1), option: text("answerOption").min(1), rationale: text("answerRationale") }),
  get_contract: z.strictObject({}),
  file_proposal: z.strictObject({
    repo: gatewayRepo, title: text("taskTitle").min(1), intent: scopeText.optional(), idempotency_key: text("idempotencyKey").min(8),
    deliverable: z.enum(["branch", "report"]).optional(),
  }),
} as const;

export type GatewayToolName = keyof typeof GATEWAY_TOOL_INPUTS;
export type GatewayToolInput<N extends GatewayToolName> = z.infer<(typeof GATEWAY_TOOL_INPUTS)[N]>;

// ------------------------------------------------------------- outputs

const str = z.string();
const int = z.number().int();
const list = z.array(z.unknown());
const rows = <S extends z.ZodRawShape>(shape: S) => z.array(z.looseObject(shape));
const proposed = z.looseObject({ proposal: int, kind: z.enum(["next", "reserve", "hold", "unhold", "scope", "cancel", "answer"]), awaiting: str });

/** One assignment (assignment.ts `AssignmentSnapshot`). */
const assignmentOutput = z.looseObject({ version: z.literal(1), rootId: str, activeTaskId: str, title: str, state: str, detail: str, attention: z.array(str) });

export const GATEWAY_TOOL_OUTPUTS = {
  get_project_context: repositoryContextOutput,
  get_assignment: assignmentOutput,
  list_assignment_updates: z.looseObject({ events: list, nextCursor: int, hasMore: z.boolean() }),
  claim_assignment: assignmentOutput,
  acknowledge_assignment: assignmentOutput,
  get_assignment_brief: catchUpOutput,
  get_assignment_inbox: z.looseObject({ batch: z.looseObject({ id: str.nullable(), consumer: str, events: list, hasMore: z.boolean() }) }),
  acknowledge_assignment_delivery: z.looseObject({ alreadyAcknowledged: z.boolean() }),
  status: z.looseObject({ waitsOnYou: int, waits: z.looseObject({ approvals: int, questions: int, incidents: int, picks: int }) }),
  list_tasks: z.looseObject({ tasks: list }),
  get_task: z.looseObject({ ref: str }),
  list_repos: z.looseObject({ repos: rows({ repo: str, mode: str }) }),
  recap: recapOutput,
  list_decisions: decisionsOutput,
  queue: z.looseObject({ repo: str, ...queueColumnsOutput }),
  get_decision: decisionOutput,
  propose_next: proposed,
  propose_reserve: proposed,
  propose_hold: proposed,
  propose_unhold: proposed,
  propose_scope: proposed,
  propose_cancel: proposed,
  propose_answer: proposed,
  get_contract: z.looseObject({ contract: str }),
  file_proposal: z.looseObject({ ref: str, replayed: z.boolean(), admission: str }),
} as const satisfies Record<GatewayToolName, z.ZodType>;

export type GatewayToolOutput<N extends GatewayToolName> = z.infer<(typeof GATEWAY_TOOL_OUTPUTS)[N]>;

// ------------------------------------------------------------- a person's tools

/**
 * The tools a PERSON's API token sees over the HTTP gateway (mcp-person.ts). Each call becomes the exact `toolroll`
 * command line the same person could type, run on the server under their own principal (operate.ts `runOperateAs`):
 * the command's own authorization, project grants and attribution apply, and its `--json` envelope is the answer.
 * Two reads keep the coordinator's names and arguments; the rest are new. Every value that lands in a command line
 * may not begin with "-", so an argument can never be read as a flag.
 */
const notFlag = <T extends z.ZodString>(schema: T) => schema.regex(/^[^-]/, { error: "must not begin with -" });
const taskRef = notFlag(ref);
const runId = z.int().min(1);

export const PERSON_TOOL_INPUTS = {
  status: GATEWAY_TOOL_INPUTS.status,
  list_tasks: GATEWAY_TOOL_INPUTS.list_tasks,
  task_show: z.strictObject({ ref: taskRef }),
  task_review: z.strictObject({ ref: taskRef, run: runId.optional(), all: z.boolean().optional() }),
  review_findings: z.strictObject({ run: runId }),
  file_task: z.strictObject({
    repo: notFlag(gatewayRepo), title: notFlag(text("taskTitle").min(1)), idempotency_key: notFlag(text("idempotencyKey").min(8)),
    deliverable: z.enum(["branch", "report"]).optional(),
  }),
} as const;

export type PersonToolName = keyof typeof PERSON_TOOL_INPUTS;
export type PersonToolInput<N extends PersonToolName> = z.infer<(typeof PERSON_TOOL_INPUTS)[N]>;

/** The command's `--json` envelope (contracts/cli.ts); a refusal is `ok: false` with its stable reason. */
const envelope = envelopeSchema;
export const PERSON_TOOL_OUTPUTS = {
  status: envelope,
  list_tasks: envelope,
  task_show: envelope,
  task_review: envelope,
  review_findings: envelope,
  file_task: envelope.extend({ id: str.optional() }),
} as const satisfies Record<PersonToolName, z.ZodType>;
