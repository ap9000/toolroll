/**
 * The engine API (solo-workbench plan v2, A0): the JSON a non-browser client (the Rust terminal workbench) and the web
 * read from the console, one schema per response. Every route here is a row of its own in server/route-table.ts,
 * admitted exactly as the page it mirrors; these schemas say only what is sent.
 *
 * Like the console's other JSON (console-api.ts), each response is checked as it is sent and a disagreement is reported,
 * never refused. Objects are strict at the top (a field the client doesn't know is a contract change, made here on
 * purpose) and the fixtures in test/fixtures/engine-api/ are parsed by these schemas in engine-api.test.ts, so the Rust
 * side can hold the same files.
 *
 *   GET  /agents/live/run/<id>       a run's LiveSession window (liveSessionWindow)
 *   GET  /agents/live/thread/<id>    a Flexible thread's LiveSession window: refused while Flexible isn't available
 *   GET  /work/rows                  the Work list's rows and Needs-you groups (workRows)
 *   GET  /t/<task>/steps             a task's step cards (stepCards)
 *   GET  /t/<task>/diff              a result's changed files, or one file's hunks with ?run=&file= (resultDiff, resultDiffFile)
 *   POST /login/once                 a local-owner one-time link redeemed for a terminal client (linkRedemption)
 *   GET  /engine/hello               the handshake: this build and the contract's digest (hello)
 *
 * test/fixtures/engine-api/schemas.json is every schema here as JSON Schema with their digest (engineJsonSchemas), the
 * file a client generates its models from; engine-api.test.ts keeps it current.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { parseContract, type ContractIssue } from "./contract.js";

/** Bumped on a change a client must know about; the client sends nothing, it checks this. */
export const ENGINE_API_VERSION = 1 as const;
const version = z.literal(ENGINE_API_VERSION);
const iso = z.string();

// ---- LiveSession --------------------------------------------------------------------------------------------------

/**
 * What a live window shows (live-records.ts LiveRecord, live-children-read.ts ChildView): the run's own records, or its
 * subagents' with their stream number `s`. Sanitised and re-redacted on the server; display, never evidence.
 */
const liveRecordSchema = z.union([
  z.object({ k: z.literal("open"), at: iso, detail: z.enum(["base", "commands"]), s: z.number().int().optional() }),
  z.object({ k: z.literal("start"), at: iso, s: z.number().int().optional() }),
  z.object({ k: z.literal("say"), at: iso, t: z.array(z.string()), s: z.number().int().optional() }),
  z.object({ k: z.literal("step"), at: iso, id: z.string(), kind: z.string(), target: z.string().optional(), once: z.literal(true).optional(), s: z.number().int().optional() }),
  z.object({ k: z.literal("done"), at: iso, id: z.string(), ok: z.boolean().nullable(), out: z.array(z.string()).optional(), s: z.number().int().optional() }),
  z.object({ k: z.literal("cut"), at: iso, s: z.number().int().optional() }),
  z.object({ k: z.literal("cap"), at: iso.optional(), s: z.number().int().optional() }),
  z.object({ k: z.literal("child"), s: z.number().int(), at: iso.optional(), parent: z.string().nullable(), via: z.number().int().optional(), desc: z.string().optional() }),
  z.object({ k: z.literal("end"), s: z.number().int(), at: iso.optional(), ok: z.boolean().nullable() }),
  z.object({ k: z.literal("over") }),
]);

/** One live session: a run today, a Flexible thread later (same window, cursor and room). */
export const liveSessionRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run"), id: z.number().int().positive(), task: z.string().nullable() }),
  z.object({ kind: z.literal("thread"), id: z.string().regex(/^[0-9a-f]{32}$/), task: z.null() }),
]);

/** `GET /agents/live/<kind>/<id>?file=main|sub&cursor=`: one window of the session's records. `room` is the live room
 * (GET /live?room=) that says when to read again; `cursor` is opaque state, never permission. */
export const liveSessionWindowSchema = z.object({
  version,
  session: liveSessionRefSchema,
  room: z.string(),
  live: z.boolean(),
  file: z.enum(["main", "sub"]),
  window: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), records: z.array(liveRecordSchema), cursor: z.string(), restarted: z.boolean(), earlier: z.boolean(),
      quarantined: z.number().int(), skipped: z.number().int(), more: z.boolean() }),
    /** `off`: the run isn't this computer's (its records live where it runs); `missing`/`unavailable`: no readable file. */
    z.object({ ok: z.literal(false), reason: z.enum(["missing", "unavailable", "off"]) }),
  ]),
});

// ---- Work rows ----------------------------------------------------------------------------------------------------

const workAskSchema = z.enum(["release", "approve", "answer", "flow", "wrong", "review", "setup", "other"]);
/** A Needs-you row as Work says it (browser-workspace.ts BrowserHomeRow). */
const needRowSchema = z.object({
  id: z.string(), title: z.string(), href: z.string(), project: z.string().nullable(), age: z.string(),
  state: z.enum(["needs", "running", "queued", "done"]),
  ask: workAskSchema.nullable(),
  group: z.enum(["decide", "review", "unblock"]).optional(),
  reason: z.string().nullable(), line: z.string().nullable(),
  action: z.object({ label: z.string(), href: z.string() }).nullable(),
  question: z.object({ id: z.number().int(), text: z.string(), recap: z.string(),
    options: z.array(z.object({ id: z.string(), label: z.string(), consequence: z.string(), recommended: z.boolean() })) }).nullable(),
});
/** A task row of the Work list (browser-workspace.ts BrowserTaskRow), the facts a terminal needs. */
const workRowSchema = z.object({
  id: z.string(), title: z.string(), href: z.string(), project: z.string().nullable(), age: z.string(),
  status: z.object({ label: z.string(), tone: z.string(), token: z.string() }),
  word: z.object({ word: z.string(), tone: z.string() }),
  ask: z.string().nullable(),
  chip: z.string().nullable(),
  group: z.string(),
  rank: z.number().int(),
  detail: z.string().nullable(),
  problem: z.string().nullable(),
  /** What this waiting row asks; absent when it waits on nobody. */
  need: needRowSchema.nullable(),
});

/** `GET /work/rows`: Work's list (`/`) as data, same grouping and Needs-you facts, under the same query keys. */
export const workRowsSchema = z.object({
  version,
  project: z.string().nullable(),
  projectName: z.string(),
  needsCount: z.number().int(),
  /** The list's own groups in order (null: one plain list). */
  groups: z.array(z.object({ key: z.string(), label: z.string(), count: z.number().int() })).nullable(),
  rows: z.array(workRowSchema),
  /** Waiting asks that are no task row (a held release, a flow card, a setup step), by Work's three groups. */
  needs: z.array(z.object({ key: z.enum(["decide", "review", "unblock"]), label: z.string(), count: z.number().int(), rows: z.array(needRowSchema) })),
  next: z.string().nullable(),
  room: z.literal("workspace"),
});

// ---- Step cards ---------------------------------------------------------------------------------------------------

export const stepCardSchema = z.object({
  key: z.enum(["plan", "approve", "build", "checks", "review", "ready"]),
  label: z.string(),
  state: z.enum(["done", "current", "stuck", "skipped", "todo"]),
  mark: z.enum(["done", "needs", "live", "wait", "stuck", "skipped", "todo"]),
  sentence: z.string(),
  at: iso.nullable(),
  needsYou: z.boolean(),
  /** Whether this task's chain has this step at all: a "Just code" task (no plan, no separate approval) has no Plan or
   * Approval step, and a client leaves those cards out. */
  inChain: z.boolean(),
  /** The agent behind the step's latest run, when one ran. */
  agent: z.object({ provider: z.string(), model: z.string().nullable() }).nullable(),
  startedAt: iso.nullable(),
  finishedAt: iso.nullable(),
  /** The step's runs' recorded cost together; null when none is recorded. */
  costUsd: z.number().nullable(),
  runs: z.array(z.number().int()),
});

/** `GET /t/<task>/steps`: the task page's stepper rows (workspace-ui.ts stepRowsOf over the same road) with who ran
 * each step, when, and what it cost; `cards` is null when the task has no road (cancelled, or no status yet). */
export const stepCardsSchema = z.object({
  version,
  task: z.object({ id: z.string(), root: z.string(), title: z.string(), state: z.string(), project: z.string().nullable() }),
  chain: z.enum(["plan-first", "just-code"]),
  headline: z.string().nullable(),
  liveRun: z.number().int().nullable(),
  cards: z.array(stepCardSchema).nullable(),
  /** The result waiting for this person's Accept or Send back, as the task page's own forms carry it: `run` and the
   * `receipt` digest it was read at (POST /t/<task>/complete), and the `source` its revision is bound to
   * (POST /r/<run>/comment intent=revise). Null when no result waits to be checked. Read facts only, never permission:
   * every act re-proves them. */
  review: z.object({ run: z.number().int(), receipt: z.string().regex(/^[0-9a-f]{64}$/), source: z.string() }).nullable(),
  room: z.string(),
});

// ---- Result diff --------------------------------------------------------------------------------------------------

const diffProblemSchema = z.string().nullable();
/** `GET /t/<task>/diff[?run=]`: the result's changed files with their counts, from its sealed patch (never the result
 * document). `file` is each file's index for the hunks read. */
export const resultDiffSchema = z.object({
  version,
  task: z.string(),
  run: z.number().int().nullable(),
  totals: z.object({ files: z.number().int(), additions: z.number().int(), deletions: z.number().int(), binary: z.number().int(), filesTruncated: z.boolean() }).nullable(),
  files: z.array(z.object({ file: z.number().int(), path: z.string(), oldPath: z.string().nullable(), additions: z.number().int(), deletions: z.number().int(), binary: z.boolean(),
    hunks: z.number().int() })),
  patchTruncated: z.boolean(),
  /** Why there is no file list (no result yet, a capture that failed, bytes that didn't verify); null when there is one. */
  problem: diffProblemSchema,
});

const diffLineSchema = z.object({ kind: z.enum(["context", "addition", "deletion", "meta"]), text: z.string(), oldLine: z.number().int().nullable(), newLine: z.number().int().nullable() });
/** `GET /t/<task>/diff?run=<id>&file=<n>`: one file's hunks, from the same sealed patch. */
export const resultDiffFileSchema = z.object({
  version,
  task: z.string(),
  run: z.number().int(),
  file: z.object({ file: z.number().int(), path: z.string(), oldPath: z.string().nullable(), meta: z.array(z.string()),
    hunks: z.array(z.object({ header: z.string(), lines: z.array(diffLineSchema) })) }),
  linesTruncated: z.boolean(),
});

// ---- Local-owner link redemption ------------------------------------------------------------------------------------

/** `POST /login/once` (application/json `{ "code": "<the link's code>" }`): the local owner's session for a terminal
 * client. The cookie, CSRF token and mutation key are for that client's memory only; the response is no-store. */
export const linkRedemptionSchema = z.object({
  version,
  account: z.string(),
  cookie: z.object({ name: z.string(), value: z.string().regex(/^[0-9a-f]{64}$/) }),
  csrf: z.string().regex(/^[0-9a-f]{64}$/),
  /** The mutation key (header x-toolroll-key), bound to this console start (`epoch`). */
  key: z.string().regex(/^[0-9a-f]{64}$/),
  epoch: z.string(),
});
/** What a terminal client posts to `POST /login/once`: the link's code, nothing else. */
export const linkRedemptionRequestSchema = z.strictObject({ code: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
/** The engine API's request bodies (JSON, a terminal client's; never a browser form). */
export const ENGINE_REQUESTS = {
  linkRedemption: { route: "POST /login/once", schema: linkRedemptionRequestSchema },
} as const;
/** Every refusal on these routes: one word a client can branch on. */
export const engineRefusalSchema = z.object({ error: z.string() });
/** `GET /engine/hello`: the handshake a client makes first. `contract` is the digest of every schema here
 * (engineContractDigest); a client built from another contract says so instead of misreading. */
export const helloSchema = z.object({ version, toolroll: z.string(), contract: z.string().regex(/^[0-9a-f]{64}$/), responses: z.array(z.string()) });

export const ENGINE_RESPONSES = {
  liveSessionWindow: { route: "GET /agents/live/<kind>/<id>", schema: liveSessionWindowSchema },
  workRows: { route: "GET /work/rows", schema: workRowsSchema },
  stepCards: { route: "GET /t/<task>/steps", schema: stepCardsSchema },
  resultDiff: { route: "GET /t/<task>/diff", schema: resultDiffSchema },
  resultDiffFile: { route: "GET /t/<task>/diff?run=&file=", schema: resultDiffFileSchema },
  linkRedemption: { route: "POST /login/once", schema: linkRedemptionSchema },
  refusal: { route: "every engine route's refusal", schema: engineRefusalSchema },
  hello: { route: "GET /engine/hello", schema: helloSchema },
} as const;
export type EngineResponseName = keyof typeof ENGINE_RESPONSES;
export type LiveSessionWindow = z.infer<typeof liveSessionWindowSchema>;
export type WorkRows = z.infer<typeof workRowsSchema>;
export type StepCards = z.infer<typeof stepCardsSchema>;
export type StepCard = z.infer<typeof stepCardSchema>;
export type ResultDiff = z.infer<typeof resultDiffSchema>;
export type ResultDiffFile = z.infer<typeof resultDiffFileSchema>;
export type LinkRedemption = z.infer<typeof linkRedemptionSchema>;

type EngineReport = (route: string, issues: ContractIssue[]) => void;
const toStderr: EngineReport = (route, issues) => process.stderr.write(`engine api: ${route} disagrees with its contract: ${issues.slice(0, 5).map(one => `${one.path} ${one.kind}`).join("; ")}\n`);
/** Check a response just before it is sent: a disagreement is reported (never its values), the payload sent unchanged. */
export function checkEngineResponse<T>(name: EngineResponseName, payload: T, report: EngineReport = toStderr): T {
  const { route, schema } = ENGINE_RESPONSES[name];
  const parsed = parseContract(schema as z.ZodType, payload);
  if (!parsed.ok) report(route, parsed.issues);
  return payload;
}

/** Every schema here as JSON Schema (draft 2020-12), by name: what a client generates its models from. */
export function engineJsonSchemas(): { responses: Record<string, unknown>; requests: Record<string, unknown> } {
  const json = (schema: z.ZodType) => { const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "throw" }) as Record<string, unknown>; return rest; };
  return {
    responses: Object.fromEntries(Object.entries(ENGINE_RESPONSES).map(([name, one]) => [name, json(one.schema)])),
    requests: Object.fromEntries(Object.entries(ENGINE_REQUESTS).map(([name, one]) => [name, json(one.schema)])),
  };
}
/** The contract's digest: sha256 of its JSON Schemas with the API version, the same on both sides of the handshake. */
export function engineContractDigest(): string {
  return createHash("sha256").update(JSON.stringify({ version: ENGINE_API_VERSION, ...engineJsonSchemas() })).digest("hex");
}
