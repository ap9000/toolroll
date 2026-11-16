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
 *   GET  /agents/live/thread/<id>    a Flexible thread's LiveSession window with its facts (liveSessionWindow + thread):
 *                                    its owner's only, refused while Flexible isn't available
 *   GET  /agents/live/threads        the person's own Flexible threads, as the work list shows them (liveThreads): refused
 *                                    while Flexible isn't available
 *   GET  /work/rows                  the Work list's rows and Needs-you groups (workRows)
 *   GET  /t/<task>/steps             a task's step cards (stepCards)
 *   GET  /t/<task>/diff              a result's changed files, or one file's hunks with ?run=&file= (resultDiff, resultDiffFile),
 *                                    or lines of that file around its hunks with ?run=&file=&from=&count= (resultDiffContext)
 *   POST /login/once                 a local-owner one-time link redeemed for a terminal client (linkRedemption)
 *   GET  /engine/hello               the handshake: this build and the contract's digest (hello)
 *   GET  /engine/agents              the coding agents on this computer and who the first task goes to (agents)
 *   GET  /engine/models              the installation's planner, builder and reviewer and what each may be (models)
 *   GET  /term/state                 this session's live terminals (termState): the browser's Live page reads it too
 *   POST /term/start                 start one (termStarted); a take-over names its task and build (solo-workbench T4)
 *                                    and attaches through the console's one WebSocket, GET /term/<id>/socket
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

const hex32 = z.string().regex(/^[0-9a-f]{32}$/);
const flexibleLevelSchema = z.enum(["supervised", "auto", "full"]);
/** Where an answer to a thread agent's request stands (flexible-answers.ts): waiting for the person, on its way, sent,
 * confirmed, not sent, couldn't be confirmed, or withdrawn (its turn or agent ended first). */
const answerStateSchema = z.enum(["pending", "decided", "sending", "sent", "delivered", "not-sent", "uncertain", "withdrawn"]);
/** One request of a thread's agent, as its owner is shown it: the card exactly as recorded (its digest is what an answer
 * names), where its answer stands, and whether it can be answered from this console now. Agent text is already
 * cleaned; a client cleans again before drawing. */
const threadQuestionSchema = z.object({
  request: hex32,
  kind: z.enum(["permission", "question"]),
  title: z.string(),
  /** Every line of what an allow would allow (a command's every line, a file change's whole change, anything else's
   * full input), or a preview and the reason it can't all be shown. */
  detail: z.string().nullable(),
  /** The agent's tool, as the card is bound to it (with the digest of its whole input, inside `digest`). */
  tool: z.string().nullable(),
  /** Whether the card shows the whole request. False: it can't be allowed from a card, only denied. */
  complete: z.boolean(),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  state: answerStateSchema,
  answerable: z.boolean(),
  /** A question's parts (empty for a permission): each part's id, its words, and the options offered. */
  parts: z.array(z.object({ id: z.string(), question: z.string(), options: z.array(z.string()) })),
});
/** A Flexible thread's facts beside its window: its level, its agent, its current turn and that turn's cost so far (null
 * until a call is charged; `costBasis` says how sure), and that turn's questions. */
export const threadFactsSchema = z.object({
  /** A digest of these facts: sent back as `known=`, an unchanged thread's window comes without them. */
  version: z.string().regex(/^[0-9a-f]{16}$/),
  title: z.string(),
  project: z.string().nullable(),
  level: flexibleLevelSchema.nullable(),
  agent: z.object({ provider: z.string(), model: z.string() }).nullable(),
  turn: z.object({ seq: z.number().int(), status: z.string(), costUsd: z.number().nullable(), costBasis: z.enum(["measured", "estimated", "unknown"]).nullable() }).nullable(),
  questions: z.array(threadQuestionSchema),
});

/** `GET /agents/live/<kind>/<id>?file=main|sub&cursor=`: one window of the session's records. `room` is the live room
 * (GET /live?room=) that says when to read again; `cursor` is opaque state, never permission. A thread's window also
 * carries its facts (`thread`), unless the read named their current `version` as `known=` (then they're unchanged and
 * left out); a run's never does. A thread's read holding both `cursor=` and `known=` may add `wait=1`: when nothing
 * moved, the console answers at the thread's next change (or after about 20 s) instead of at once. */
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
  thread: threadFactsSchema.optional(),
});

/** `GET /agents/live/threads`: the person's own Flexible threads (newest first), each one more live session in the work
 * list: its title, project, level, whether its agent is running, how many questions wait on them, its turn's cost. */
export const liveThreadsSchema = z.object({
  version,
  threads: z.array(z.object({ id: hex32, title: z.string(), project: z.string().nullable(), level: flexibleLevelSchema.nullable(), live: z.boolean(), waiting: z.number().int(),
    costUsd: z.number().nullable() })),
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
/** A queued task waiting to start again after a failed build (engine-reads.ts waitingOf): when the next try is due
 * (the backoff hold's own end; null: as soon as a builder is free) and the last build's failure in one short line
 * (needs-you.ts failedAttemptSentence; null when the last build didn't fail). Read facts only. */
export const waitingSchema = z.object({ retryAt: iso.nullable(), lastFailure: z.string().nullable() });
/** A Work row's group (work-index.ts WorkIndexGroup): a Needs-you ask, building, or everything else. */
export const WORK_ROW_GROUPS = ["decide", "review", "unblock", "building", "rest"] as const;
/** A Work row's status tone (workspace-ui.ts StatusTone). */
export const WORK_STATUS_TONES = ["attention", "problem", "live", "ready", "done", "muted", "neutral"] as const;
/** A Work row's chip tone (browser-workspace.ts BrowserTaskRow word). */
export const WORK_WORD_TONES = ["", "needs", "ask", "live", "done", "failed"] as const;
/** A task row of the Work list (browser-workspace.ts BrowserTaskRow), the facts a terminal needs. A client lists every
 * row it is sent, whatever its group, tone or token (the token is open: dozens of status words each have their own),
 * by these closed enums and the rank. */
const workRowSchema = z.object({
  id: z.string(), title: z.string(), href: z.string(), project: z.string().nullable(), age: z.string(),
  status: z.object({ label: z.string(), tone: z.enum(WORK_STATUS_TONES), token: z.string() }),
  word: z.object({ word: z.string(), tone: z.enum(WORK_WORD_TONES) }),
  ask: z.string().nullable(),
  chip: z.string().nullable(),
  group: z.enum(WORK_ROW_GROUPS),
  /** 0 waits on a person, 1 runs, 2 queued or waiting (a retry included), 3 finished, 4 stopped or put away. */
  rank: z.number().int(),
  detail: z.string().nullable(),
  problem: z.string().nullable(),
  /** What this waiting row asks; absent when it waits on nobody. */
  need: needRowSchema.nullable(),
  /** A queued task waiting to try again (waitingSchema); null for every other row. */
  waiting: waitingSchema.nullable(),
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
  /** The terminal's cost line ("$1.84 today · plan 62%"): today's spend (the UTC day, from the Spend page's own items,
   * unpriced work counted as nothing) and the fullest current subscription window the providers last reported, rounded
   * (null: none reported). The Limits view's audience only (an instance operator); null for everyone else. */
  spend: z.object({ todayUsd: z.number(), planPercent: z.number().int().nullable() }).nullable(),
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
  /** When the step's newest run started (startedAt is its first run's): what "this build has run for" counts from. */
  latestStartedAt: iso.nullable(),
  finishedAt: iso.nullable(),
  /** The step's runs' recorded cost together; null when none is recorded. */
  costUsd: z.number().nullable(),
  runs: z.array(z.number().int()),
  /** The Approval step's terms while an approval waits (approval-summary.ts, the same summary every surface shows):
   * decisions and differences as rows, risks never folded, the usual project settings by name, and `key`, which a yes
   * pins (`task approve --terms <key>`) so a change to what was shown refuses. Absent on every other card. */
  terms: z.object({
    key: z.string(),
    revision: z.string().nullable(),
    rows: z.array(z.object({ label: z.string(), words: z.string(), lines: z.array(z.string()) })),
    warnings: z.array(z.string()),
    usualLabel: z.string(),
    usual: z.array(z.object({ label: z.string(), words: z.string() })),
  }).optional(),
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
  review: z.object({ run: z.number().int(), receipt: z.string().regex(/^[0-9a-f]{64}$/), source: z.string(),
    /** What accepting this result means for the person reading it, said before they press Accept (T2's owed facts), in
     * the words the completion itself would use. `owed`: an acceptance Accept records besides completing (the person's
     * own check, or an exception that needs a reason); `blockers`: why completing is refused now (a failed required
     * check, an open requirement); `needs`: who else has to complete it, or why this person can't (protected work on a
     * one-person approval, a fast start that grew). Display only: the completion decides again. */
    accept: z.object({ owed: z.enum(["person-check", "exception"]).nullable(), blockers: z.array(z.string()), needs: z.string().nullable() }),
  }).nullable(),
  /** Why a failed task stopped, as the task page and `task show` say it: the latest finished attempt's reason in one
   * plain line (needs-you.ts failedAttemptSentence), the build attempts that failed in a row, and one suggestion. Null
   * unless the task failed. */
  failure: z.object({ line: z.string(), failedInARow: z.number().int(), suggestion: z.string().nullable(),
    /** The last lines the agent wrote before it stopped, cleaned (agent-said.ts agentSaidOf: at most AGENT_SAID_LINES
     * lines of plain text, each at most AGENT_SAID_WIDTH characters); null when none was kept. */
    agentSaid: z.array(z.string()).max(8).nullable() }).nullable(),
  /** A queued task waiting to start again (waitingSchema); null otherwise. */
  waiting: waitingSchema.nullable(),
  /** What Retry binds to (local-owner-acts.ts retryPinsOf): the latest build and the approved scope's digest, posted
   * to POST /t/<task>/requeue as `run` and `digest`, the same act the task page's Retry is (re-proved there). Null
   * unless the task failed and its approval stands as it is. */
  retry: z.object({ run: z.number().int(), digest: z.string() }).nullable(),
  /** Who approved this task's scope: a person (`you` when it is the reader), or a rule (`automatic`). Null while no
   * approval stands. A "Just code" task's yes came with the task, so a client says who gave it. */
  approval: z.object({ by: z.string(), you: z.boolean(), automatic: z.boolean() }).nullable(),
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

/** Lines one expand asks for at most (`count`): a terminal never reads a whole file through this road. */
export const DIFF_CONTEXT_MAX = 100;
/** `GET /t/<task>/diff?run=<id>&file=<n>&from=<line>&count=<n>`: lines `from`..`from+count-1` of that file as the result
 * left it (its head commit, read by Toolroll from its own record of the project and the run, never from the checkout),
 * to show context a hunk hides. `lineCount` is the file's length there; `lines` stop at its end. `problem` says why there
 * are none (the file was removed, isn't text, or the result's commit can't be read); lines that look like a key are
 * replaced with a marker, as the saved diff does. */
export const resultDiffContextSchema = z.object({
  version,
  task: z.string(),
  run: z.number().int(),
  file: z.number().int(),
  from: z.number().int(),
  lines: z.array(z.object({ newLine: z.number().int(), text: z.string() })),
  lineCount: z.number().int().nullable(),
  problem: z.string().nullable(),
});

// ---- Agents on this computer ---------------------------------------------------------------------------------------

/** `GET /engine/agents`: every supported coding agent on the console's computer as its last detection saw it
 * (agent-detect.ts; the console looks in the background, a read never does), who the first task goes to, and the first
 * run's lines every screen shows. `checkedAt` null: not looked for yet since the console started (the lines say so).
 * Facts only, never a credential: a sign-in is "signed in" and how, in fixed words. */
export const agentsReadSchema = z.object({
  version,
  checkedAt: iso.nullable(),
  agents: z.array(z.object({
    id: z.string(),
    name: z.string(),
    state: z.enum(["signed-in", "signed-out", "unknown", "not-installed"]),
    how: z.string().nullable(),
    /** The command that signs it in, for an installed agent that isn't; null otherwise. */
    signIn: z.string().nullable(),
    /** It can take a task now. */
    ready: z.boolean(),
    /** What it still needs before it takes tasks; null when nothing. */
    next: z.string().nullable(),
    /** How to add it (agent-detect.ts AGENT_SETUP, Toolroll's own constants): the exact commands, whether the console
     * runs its install or sign-in in a pane for the person (POST /term/agent/install, /term/agent/sign-in), what key it
     * needs and where, an ACP agent's one-time check, and a note. Empty in the summary view. */
    setup: z.object({
      install: z.string().nullable(),
      canInstall: z.boolean(),
      signIn: z.string().nullable(),
      canSignIn: z.boolean(),
      key: z.string().nullable(),
      check: z.string().nullable(),
      note: z.string().nullable(),
      /** For an npm install: the registry the person's own ~/.npmrc sends this package to when it isn't the public one
       * (agent-detect.ts npmRegistryOf; scheme, host and path only), and whether that file may set another one this
       * can't follow. */
      registry: z.string().nullable(),
      registryUnsure: z.boolean(),
    }),
  })),
  firstTask: z.object({ id: z.string(), name: z.string() }).nullable(),
  lines: z.array(z.string()),
});

/** `GET /engine/models`: the installation's model choices as Settings → Models shows them (server/settings.ts): the
 * planner, the builder and the reviewer, each with what it is now and what it may be set to, the state digest a change
 * posts back (POST /settings/models/agent), and each default agent's preset (every role, as one change). `canChange`:
 * this session may change them (an instance operator; a local owner on a solo install). */
export const modelsReadSchema = z.object({
  version,
  canChange: z.boolean(),
  digest: z.string(),
  problem: z.string().nullable(),
  roles: z.array(z.object({
    key: z.enum(["plan", "build", "review"]),
    label: z.string(),
    /** "provider|model" as the form posts it; "" when not set. */
    current: z.string(),
    words: z.string(),
    choices: z.array(z.object({ provider: z.string(), label: z.string(), models: z.array(z.object({ value: z.string(), label: z.string() })) })),
  })),
  defaultAgent: z.string().nullable(),
  presets: z.array(z.object({ agent: z.string(), name: z.string(), words: z.string(),
    /** Every role the editor owns, as the form posts it ("provider|model", or "clear"). */
    fields: z.record(z.string(), z.string()) })),
});

// ---- Live terminals (take over) -------------------------------------------------------------------------------------

/** `GET /term/state`: this session's live terminals (server/terminals.ts; a local owner's session only on a solo install).
 * `task` and `run`: the build a take-over opened on (Toolroll's record), null for a terminal started on a project. */
export const termStateSchema = z.object({
  available: z.boolean(),
  problem: z.string().nullable(),
  programs: z.array(z.enum(["claude", "codex", "shell"])),
  projects: z.array(z.object({ path: z.string(), name: z.string() })),
  sessions: z.array(z.object({
    id: z.string().regex(/^[0-9a-f]{32}$/), repo: z.string(), project: z.string(), program: z.enum(["claude", "codex", "shell"]), branch: z.string(),
    startedAt: iso, endedAt: iso.nullable(), exit: z.object({ code: z.number().int().nullable(), signal: z.number().int().nullable() }).nullable(),
    cleanup: z.enum(["clean", "uncertain"]).nullable(), task: z.string().nullable(), run: z.number().int().nullable(),
  })),
});
/** `POST /term/start`: the terminal started (attach at `/term/<id>/socket`), or why not, in words. */
export const termStartedSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), id: z.string().regex(/^[0-9a-f]{32}$/) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

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
 * (engineContractDigest); a client built from another contract says so instead of misreading. `mode` is the install's
 * solo or team mode as the server derives it now (install-mode.ts; a solo screen shows no team concepts), and
 * `defaultChain` the steps a new task starts with there. Display only: every act derives the mode again. */
export const helloSchema = z.object({ version, toolroll: z.string(), contract: z.string().regex(/^[0-9a-f]{64}$/), responses: z.array(z.string()),
  mode: z.enum(["solo", "team"]), defaultChain: z.enum(["just-code", "plan-first"]) });

export const ENGINE_RESPONSES = {
  liveSessionWindow: { route: "GET /agents/live/<kind>/<id>", schema: liveSessionWindowSchema },
  liveThreads: { route: "GET /agents/live/threads", schema: liveThreadsSchema },
  workRows: { route: "GET /work/rows", schema: workRowsSchema },
  stepCards: { route: "GET /t/<task>/steps", schema: stepCardsSchema },
  resultDiff: { route: "GET /t/<task>/diff", schema: resultDiffSchema },
  resultDiffFile: { route: "GET /t/<task>/diff?run=&file=", schema: resultDiffFileSchema },
  resultDiffContext: { route: "GET /t/<task>/diff?run=&file=&from=&count=", schema: resultDiffContextSchema },
  linkRedemption: { route: "POST /login/once", schema: linkRedemptionSchema },
  refusal: { route: "every engine route's refusal", schema: engineRefusalSchema },
  hello: { route: "GET /engine/hello", schema: helloSchema },
  agents: { route: "GET /engine/agents", schema: agentsReadSchema },
  models: { route: "GET /engine/models", schema: modelsReadSchema },
  termState: { route: "GET /term/state", schema: termStateSchema },
  termStarted: { route: "POST /term/start, /term/agent/sign-in, /term/agent/install", schema: termStartedSchema },
} as const;
export type EngineResponseName = keyof typeof ENGINE_RESPONSES;
export type LiveSessionWindow = z.infer<typeof liveSessionWindowSchema>;
export type ThreadFacts = z.infer<typeof threadFactsSchema>;
export type LiveThreads = z.infer<typeof liveThreadsSchema>;
export type WorkRows = z.infer<typeof workRowsSchema>;
export type StepCards = z.infer<typeof stepCardsSchema>;
export type StepCard = z.infer<typeof stepCardSchema>;
export type ResultDiff = z.infer<typeof resultDiffSchema>;
export type ResultDiffFile = z.infer<typeof resultDiffFileSchema>;
export type ResultDiffContext = z.infer<typeof resultDiffContextSchema>;
export type LinkRedemption = z.infer<typeof linkRedemptionSchema>;
export type AgentsRead = z.infer<typeof agentsReadSchema>;
export type ModelsRead = z.infer<typeof modelsReadSchema>;
export type TermState = z.infer<typeof termStateSchema>;

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
