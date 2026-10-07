/**
 * The CLI's machine contract (docs/plans/zod-revamp.md, item 14): one schema for the `--json` envelope, one for each
 * declared command's answer, and one for a row of the declared command guide that `contract --commands` dumps.
 *
 * Answers are what Toolroll writes and consumers are told to ignore keys they don't recognize, so every object here is
 * loose. A command answers with its own success shape or a refusal (`ok: false` with a stable `reason`). The commands
 * named in COMMAND_OUTPUTS describe their top-level fields; every other declared command is held to the envelope with
 * its own `command` name. An answer that disagrees is logged on stderr and written exactly as it was: the check never
 * changes, reorders or refuses the bytes a command writes.
 */

import { z } from "zod";
import { ENVELOPE_VERSION, envelopeJson, type EnvelopePayload } from "../envelope.js";
import type { SessionDescriptor } from "../session-contract.js";
import { parseContract } from "./contract.js";
import { LISTED_TASK_STATES } from "./lead-tools.js";

const str = z.string();
const int = z.number().int();
const list = z.array(z.unknown());
const nullable = <T extends z.ZodType>(schema: T) => schema.nullable();
const rows = <S extends z.ZodRawShape>(shape: S) => z.array(z.looseObject(shape));

/** Every `--json` answer: `envelopeVersion` first, then `ok` and `command`; a refusal adds `reason` and `message`. */
export const envelopeSchema = z.looseObject({
  envelopeVersion: z.literal(ENVELOPE_VERSION),
  ok: z.boolean(),
  command: str,
  reason: str.optional(),
  message: str.optional(),
});
export type Envelope = z.infer<typeof envelopeSchema>;

/** A command's refusal: its stable reason, usually with a message, and whatever the command adds. */
function refusal<C extends string>(command: C) {
  return z.looseObject({ envelopeVersion: z.literal(ENVELOPE_VERSION), ok: z.literal(false), command: z.literal(command), reason: str, message: str.optional() });
}

/** A command's answer: its success shape (each `shape` field as written) or its refusal. */
function answers<C extends string, S extends z.ZodRawShape>(command: C, shape: S) {
  return z.discriminatedUnion("ok", [z.looseObject({ envelopeVersion: z.literal(ENVELOPE_VERSION), ok: z.literal(true), command: z.literal(command), ...shape }), refusal(command)]);
}

// ---- the declared command guide, as `contract --commands` dumps it ----

export const commandFlagSchema = z.looseObject({ name: str, takesValue: z.boolean(), meaning: str }).readonly();
export type CommandFlag = z.infer<typeof commandFlagSchema>;

/** The remote policy every command row states; see `remote` below. */
export const REMOTE_POLICIES = ["yes", "no", "step-up"] as const;
export type RemotePolicy = typeof REMOTE_POLICIES[number];

/** A session operation's executable input schema, as session-contract.ts states it. */
const sessionInputSchema = z.custom<SessionDescriptor["inputSchema"]>(value => typeof value === "object" && value !== null && !Array.isArray(value));

export const commandRowSchema = z.looseObject({
  /** What you type after `toolroll` (subcommands included). */
  invocation: str,
  /** The `command` field the envelope answers with, where it differs from the invocation (the no-verb report answers
   * as "scan"). */
  envelopeCommand: str.optional(),
  synopsis: str,
  /** Who this act belongs to. "operator" rows are ceremonies or infrastructure: an agent must not invoke them even
   * when credentials are within reach — the credential IS the person. The operator() helper omits flag detail on
   * purpose; an explicit row may document flags when its command contract requires them. A schema is never
   * permission. */
  audience: z.enum(["agent", "operator"]),
  agentMayInvoke: z.boolean(),
  /** Truthful retry semantics, not a boolean:
   *  keyed — takes --key; same key returns the first answer.
   *  identity-idempotent — repeating it converges (same lease, same path, same managed file); no key needed.
   *  unkeyed — a mutation without replay protection: do not blind-retry.
   *  none — a read. */
  mutation: z.enum(["keyed", "identity-idempotent", "unkeyed", "none"]),
  positionals: z.array(z.looseObject({ name: str, required: z.boolean(), meaning: str }).readonly()).readonly().optional(),
  flags: z.array(commandFlagSchema).readonly().optional(),
  notableReasons: z.array(str).readonly().optional(),
  /** Session schemas are executable input contracts, not a grant of authority. */
  inputSchema: sessionInputSchema.optional(),
  /** Whether a person signed in to a central server with their own API token may run it there (`runOperateAs`):
   *  yes — runs as that person, within their token's scope and project access.
   *  no — this machine's own infrastructure, credentials or files; never run for a remote caller.
   *  step-up — approvals, people and policy: a person's act in the console or chat, never a token's. */
  remote: z.enum(REMOTE_POLICIES),
}).readonly();
export type CommandRow = z.infer<typeof commandRowSchema>;

// ---- the commands that describe their fields ----

const taskSchema = z.looseObject({ id: str, title: str, state: z.enum(LISTED_TASK_STATES), createdAt: str, updatedAt: str, priority: z.number() });
const checkSummary = z.looseObject({ status: str, exitCode: nullable(int), suites: z.unknown() });

const contractOutput = z.union([
  z.looseObject({ envelopeVersion: z.literal(ENVELOPE_VERSION), ok: z.literal(true), command: z.literal("contract"), capabilities: z.array(str) }),
  z.looseObject({ envelopeVersion: z.literal(ENVELOPE_VERSION), ok: z.literal(true), command: z.literal("contract"), schemaVersion: int, notes: z.record(str, str), commands: z.array(commandRowSchema) }),
  refusal("contract"),
]);

/** The installation report (`lead-status.ts` InstallationStatus) and what `status` adds to it. */
const statusOutput = answers("status", {
  generatedAt: str,
  running: z.looseObject({ count: int, phases: rows({ phase: str, count: int }), tasks: rows({ task: str, run: int, phase: str }) }),
  queued: z.looseObject({ count: int, reasons: rows({ reason: str, count: int }), tasks: rows({ task: str, reason: str }) }),
  waitingForReview: z.looseObject({ count: int, results: rows({ task: str, run: nullable(int), check: checkSummary }) }),
  releaseCheck: nullable(z.looseObject({ task: str, run: int, finishedAt: nullable(str), check: checkSummary })),
  planWindows: rows({ provider: str, plan: nullable(str), observedAt: str }),
  signIn: rows({ provider: str, reason: str, command: str, since: str }),
  tasks: rows({ task: str, title: str, headline: str, sentence: str }),
  lead: nullable(z.looseObject({ owner: str, doing: str, at: str, task: nullable(str), line: str })),
  projects: rows({ repo: str, name: str, running: int, limit: int }),
  update: z.looseObject({ current: str, latest: str, security: z.boolean(), updateCommand: str, url: str }).optional(),
  integrations: z.looseObject({ broken: rows({ key: str, name: str, fix: nullable(str) }) }).optional(),
  updateWaiting: z.looseObject({}).optional(),
  unsentReplies: rows({ since: str, error: nullable(str), retry: str }).optional(),
});

/** One integration (`integrations.ts` Integration): never a secret. */
const integrationRow = z.looseObject({
  key: str,
  group: z.enum(["chat", "code", "mail", "tools", "monitoring", "agents"]),
  name: str,
  state: z.enum(["connected", "not-set-up", "broken"]),
  account: nullable(str),
  detail: nullable(str),
  checked: z.boolean(),
  checkedAt: nullable(str),
  lastSuccessAt: nullable(str),
  lastError: nullable(str),
  lastErrorAt: nullable(str),
  usedBy: z.array(str),
  action: z.looseObject({ kind: z.enum(["setup", "test", "fix"]), label: str }),
  custom: z.literal(true).optional(),
});
const integrationsOutput = answers("integrations", {
  integrations: z.array(integrationRow),
  counts: z.looseObject({ connected: int, "not-set-up": int, broken: int }),
});

const scanOutput = answers("scan", {
  scannedAt: str,
  roots: z.array(str),
  missingRoots: z.array(str),
  remoteRead: z.boolean(),
  repos: rows({ path: str, name: str }),
});

const taskListOutput = answers("task list", {
  count: int,
  tasks: rows({ id: str, rootId: str, activeTaskId: str, title: str, repo: nullable(str), state: str, status: z.looseObject({ token: str, label: str }) }),
  totals: z.record(str, int),
  nextCursor: nullable(str),
  limit: int,
  view: str,
});

const taskShowOutput = answers("task show", {
  task: taskSchema,
  work: z.looseObject({ taskId: str, state: str }),
  assignment: z.unknown(),
  ref: int,
  blockedBy: list,
  position: z.unknown(),
  reservedFor: nullable(str),
  approval: z.looseObject({ approved: z.boolean() }),
  risk: str,
  route: z.unknown(),
  runs: list,
  deliverable: str,
  proofReasons: list,
  proofMatrix: list,
  proofAccepted: z.boolean(),
  stops: list,
});

/** `audit` (remote-audit.ts): one page of remote actions, newest first, and the filters it applied. */
const auditOutput = answers("audit", {
  filters: z.looseObject({ person: nullable(str), token: nullable(str), source: nullable(z.enum(["api", "mcp"])), since: nullable(str) }),
  actions: rows({
    id: int, at: str, person: str, token: nullable(str), source: z.enum(["api", "mcp"]), kind: z.enum(["command", "tool"]), name: str, command: str,
    tool: nullable(str), repo: nullable(str), taskId: nullable(str), outcome: z.enum(["ok", "refused", "error"]), reason: nullable(str),
  }),
  limit: int,
  nextCursor: nullable(str),
});

const flowListed = z.looseObject({ id: int, name: str, repo: str, project: str, zones: z.array(str), triggers: int, cardsWaiting: int, needDecision: int });

/**
 * The commands whose answers name their fields: the most-used ones (contract, the no-verb scan, status,
 * integrations, task, flows, ready) and the plain lists. Keyed by the envelope's `command`.
 */
export const COMMAND_OUTPUTS = {
  contract: contractOutput,
  scan: scanOutput,
  status: statusOutput,
  integrations: integrationsOutput,
  ready: z.union([
    answers("ready", { count: int, tasks: rows({ id: str, title: str, state: str }) }),
    z.looseObject({ envelopeVersion: z.literal(ENVELOPE_VERSION), ok: z.literal(false), command: z.literal("ready"), reason: z.literal("empty"), message: str, count: int, tasks: list }),
  ]),
  "task add": z.union([
    answers("task add", { task: taskSchema, repo: nullable(str) }),
    // Filed in an external backend: its id there, and the local mirror when one was made.
    answers("task add", { id: str, backend: str, mirror: str.optional() }),
  ]),
  "task list": taskListOutput,
  "task show": taskShowOutput,
  "task hold": answers("task hold", { id: str, reason: str, until: nullable(str) }),
  "task unhold": answers("task unhold", { id: str }),
  "task wait": answers("task wait", { task: str, outcome: str }),
  "flows list": answers("flows list", { flows: z.array(flowListed) }),
  "flows show": answers("flows show", { flow: z.looseObject({ id: int, name: str, repo: str, project: str, readable: z.boolean(), zones: list, triggers: list }) }),
  grants: answers("grants", { count: int, grants: list }),
  "runner list": answers("runner list", { count: int, runners: list }),
  "routine list": answers("routine list", { routines: list }),
  "incident list": answers("incident list", { incidents: list }),
  "outbox list": answers("outbox list", { notifications: rows({ id: int, kind: str, subject: str, createdAt: str }) }),
  // A pass with failed deliveries answers ok: false with its counts and no reason.
  "outbox deliver": z.union([
    z.looseObject({ envelopeVersion: z.literal(ENVELOPE_VERSION), ok: z.boolean(), command: z.literal("outbox deliver"), delivered: int, failed: int }),
    refusal("outbox deliver"),
  ]),
  "approver list": answers("approver list", { approvers: list }),
  "coordinator list": answers("coordinator list", { coordinators: list }),
  "cap list": answers("cap list", { repo: str, capabilities: list }),
  gaps: answers("gaps", { repo: str, gaps: list }),
  reap: answers("reap", { count: int, released: list }),
  audit: auditOutput,
  "skills list": answers("skills list", { guides: rows({ name: str, title: str, oneLiner: str }) }),
} as const satisfies Record<string, z.ZodType>;

const declared = new Map<string, z.ZodType>(Object.entries(COMMAND_OUTPUTS));

/** The schema for `command`'s answer: its own when it names its fields, else the envelope under its own name. */
export function commandOutputSchema(command: string): z.ZodType {
  let schema = declared.get(command);
  if (schema === undefined) {
    schema = answers(command, {});
    declared.set(command, schema);
  }
  return schema;
}

/** One declared command: its guide row exactly as `contract --commands` dumps it, and its answer's schema. */
export type CommandEntry = { readonly guide: CommandRow; readonly output: z.ZodType };

/** Pair each guide row, in order, with the schema of the answer it names (the envelope command, else the invocation). */
export function commandEntries(guide: readonly CommandRow[]): readonly CommandEntry[] {
  return guide.map(row => ({ guide: row, output: commandOutputSchema(row.envelopeCommand ?? row.invocation) }));
}

/** Path-named lines for each way `envelope` (as written, version first) disagrees with its command's schema; empty when it agrees. */
export function envelopeProblems(envelope: unknown): string[] {
  const top = parseContract(envelopeSchema, envelope);
  if (!top.ok) return top.issues.map(one => one.line);
  const read = parseContract(commandOutputSchema(top.value.command), envelope);
  return read.ok ? [] : read.issues.map(one => one.line);
}

/**
 * Serialize one envelope with the unchanged `envelopeJson`, after checking the value it writes. A disagreement is
 * logged on stderr and the envelope is written as it was; nothing here throws into a command's path.
 */
export function checkedEnvelopeJson(payload: EnvelopePayload): string {
  try {
    const problems = envelopeProblems({ envelopeVersion: ENVELOPE_VERSION, ...payload });
    if (problems.length > 0) process.stderr.write(`toolroll ${String(payload.command)} --json: its answer disagrees with its schema — ${problems.join("; ")}\n`);
  } catch {
    // A check that breaks never reaches the command's envelope path.
  }
  return envelopeJson(payload);
}
