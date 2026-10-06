# Zod revamp: one schema per contract

Status: planned (decided 2026-10-05). Owner: the lead. Each wave ships as its own release.

## Why

Every structured thing that crosses a boundary in Toolroll — a model's answer, a tool's input, a flow step, a
saved row — is described two to four times: a TypeScript type, a JSON Schema for `--json-schema`, a hand-written
parser, and often a length limit somewhere else. They drift. In one day (Oct 4–5, 2026) that cost us:

- 0.9.30: task goals allowed 8,000 characters but the plan parser kept 2,000, so every plan for a long task was refused.
- A flow file with `to`/`onFail` instead of `goesTo`/`ifFails` failed as "there's no step called ." instead of naming the field.
- A planner changed one character of a goal and the contract check caught it only after the fact.
- Several planner runs needed a repair turn for malformed structured output.

## The decision

Zod 4 (4.6+) is the one way to describe a contract. From one schema we derive the TypeScript type
(`z.infer`), the runtime check (`.parse` / `.validate`), the JSON Schema a model gets (`z.toJSONSchema`), and the
limits (from `src/text-limits.ts`, never restated). Chosen over TypeBox for ecosystem fit (Claude Agent SDK
`tool()`, MCP TypeScript SDK v2), Standard Schema support, and how reliably agents write it; see the research
notes in the 0.9.33 session.

## Ground rules (every wave)

1. **One schema, everything derived.** No hand-written type, parser or JSON Schema beside it.
2. **Model-facing schemas are JSON-Schema-exact.** No `.refine`, `.transform`, `.superRefine` or `.preprocess` in
   anything a model or an outside caller sees; those checks go in plain code after parsing, with a named error.
3. **Strict objects.** `z.strictObject` for inputs: an unknown key (`to` for `goesTo`) is an error that names it.
   Item 5's lead readers preserve the older handlers' tolerance: strip extra tool arguments while advertising strict
   schemas, and leave the documented clamp/fallback values to the handlers. Flow proposals keep their existing strict contract.
4. **Versioned envelopes.** Every persisted or handed-off payload carries `version`; readers accept known versions
   and refuse newer ones plainly ("made by a newer Toolroll").
5. **Errors name the path.** Refusals read like `steps[0].routes[0].goesTo: required`, and the one repair turn
   sends exactly that back to the model.
6. **Limits come from `TEXT_LIMITS`.** A schema that bounds text imports the limit; nothing hard-codes a number.
7. **Contract test per schema.** `toJSONSchema` → `fromJSONSchema` round trip loses nothing; sample valid and
   invalid payloads (including old saved ones) parse the same before and after the migration.
8. **No behavior change by accident.** A migration keeps what was accepted accepted, unless the plan names the
   tightening (and then it says so in the changelog).

## Prioritized list

Order is by risk: where a model or person hands Toolroll something and drift has bitten, first.

### Wave 1 — model ↔ Toolroll handoffs (P0)

| # | Contract | Where today | Why first |
|---|---|---|---|
| 1 ✅ | **Foundation**: add `zod`, `src/contracts/` home, shared helpers (`limited()`, `versioned()`, path-named errors, `toModelSchema()`), the contract-test harness | — | everything else builds on it |
| 2 ✅ | **Plan payload** (goal, outOfScope, touches, acceptance, plan document sections, amendment) and the planner's `--json-schema` | `plan.ts` (`parsePlan`, `PLAN_LIMITS`), `planner.ts` | 0.9.30 outage; repair turns |
| 3 ✅ | **Flow definitions and step inputs** (every zone kind, routes/answers/options, triggers) for `flows create/edit`, gallery templates, the lead's `propose_flow` | `flows.ts` (13 parsers), `flow-triggers.ts`, `flow-gallery.ts` | wrong-field-name failures; flows are authored by people, the lead and templates |
| 4 ✅ | **Scout report** (summary, items, follow-ups, questions) | `scout-report.ts`, `SCOUT_OUTPUT_JSON_SCHEMA` in `scout.ts` | structured output contract with a model |
| 5 ✅ | **Lead tool inputs and outputs** (51 mate tools) and the **MCP gateway** tools (25) | `mate-tools.ts`, `mcp.ts` | the lead's every action; one schema per tool feeds both the model and the check |
| 6 ✅ | **Builder handoff and proof** (`handoff.json`, proof criteria, verification receipt) | `builder.ts`, `proof.ts`, `verification-evidence.ts` | decides whether a result is verified |
| 7 ✅ | **Small structured answers**: task sizing, reviewer findings, decision questions and options, teammate decisions, classifier/sort answers | `task-sizing.ts`, `reviewer.ts`, `decision.ts`, `teammates.ts`, `flow-engine.ts` sort | many small model contracts, each a drift risk |

### Wave 2 — shared context passed between steps (P1)

| # | Contract | Where today |
|---|---|---|
| 8 ✅ | **Flow stage outputs and card state** (`{{stage.x}}`, choose/send payloads, attached long output) | `flow-engine.ts`, `flow-send.ts`, `flow-steps.ts` |
| 9 ✅ | **Lead context bundle** and **project knowledge / memory / skills** payloads, with size budgets in the schema | `lead-context.ts`, `project-knowledge.ts`, `project-memory.ts`, `project-skills.ts`, `memory-pass.ts` |
| 10 ✅ | **Scope, acceptance criteria and sealed routes** | `scope.ts`, `phase-routing.ts`, `policy.ts` |
| 11 ✅ | **Chat actions and channel callbacks** (Telegram/Slack/Discord/Teams button data, decide-in-chat) | `chat-actions.ts`, `telegram*.ts`, `chat-delivery*.ts` |
| 12 ✅ | **Coding handoff and context** (desktop coding sessions) | `coding-handoff.ts`, `coding-context.ts`, `coding-workspace.ts` |

### Wave 3 — inputs from outside (P2)

| # | Contract | Where today |
|---|---|---|
| 13 ✅ | **Console form bodies and JSON API** — every POST and `?json` route | `serve.ts` |
| 14 ✅ | **CLI JSON input/output** and the machine contract (`contract --commands --json`, `--json` envelopes) | `operate.ts`, `cli.ts`, `surface.ts` |
| 15 ✅ | **Trigger payloads**: webhooks, GitHub, Linear, email, forms | `flow-triggers.ts`, `observations.ts` |
| 16 | **Integration metadata**: OAuth discovery/registration responses, project tool specs | `mcp-connect.ts`, `project-tools.ts` |
| 17 | **Settings and config**: recipes, retention, storage sweep, model catalog, provider auth | `recipes.ts`, `retention.ts`, `storage.ts`, `model-catalog.ts`, `provider.ts` |

### Wave 4 — what we read back from disk and the database (P3)

| # | Contract | Where today |
|---|---|---|
| 18 | **JSON columns in the store** (46 `JSON.parse` sites) — parse on read with versioned schemas | `store.ts` |
| 19 | **Journals and recovery state** (desktop update, process recovery, staged releases, coding workspace) | `desktop-update.ts`, `toolroll-update.ts`, `process-recovery-*.ts`, `coding-workspace.ts` |
| 20 | **Evidence files** (receipts, handoffs, check logs metadata) | `evidence.ts`, `verification-evidence.ts` |

## How each item ships

One task per item (items 1–2 may share one). The brief names the contract, the files, the ground rules above, and
the old payloads to keep accepting. Done means: the hand-written type/parser/JSON Schema are gone, the contract
test passes, every caller uses the schema, and the full suite is green. Mark the item done here in the same PR.

## Done

- **1. Foundation** (2026-10-05). `zod` ^4.6; `src/contracts/contract.ts` holds `limited()`, `versioned()` with
  `readVersioned()`, `contractError()` and `toModelSchema()`; `src/contracts/contract-test.ts` is the contract-test
  harness. Plan text limits moved into `TEXT_LIMITS`.
- **2. Plan payload** (2026-10-05). `src/contracts/plan.ts` is the one plan schema: `parsePlan` reads it, and a Claude
  planner gets it as `--json-schema` (other harnesses read it in the brief). `PLAN_LIMITS` is gone. The plan file stays
  the handoff; structured output counts only when no file was written. Saved unversioned plans read as before
  (replayed from `test/fixtures/plans/`). Tightened, on purpose: a plan with a newer `version` is refused, and a
  `version: 1` plan is strict about unknown keys.
- **3. Flow definitions and step inputs** (2026-10-05). `src/contracts/flow.ts` holds one schema per zone kind (all 18,
  a discriminated union on `kind`) in each vocabulary a flow is written in: the saved drawing, steps (the lead, `toolroll
  flows create/edit`, starters, kits, the gallery) and the flow file's zones; plus routes, answers, options, triggers as
  given and as saved, and the flow file. `flowFromSteps`, `validateFlowDefinition`, `validateTriggerConfig`,
  `triggerConfigOf` and `parseFlowFile` read through them, and what JSON Schema can't say (paths to zones that exist,
  no way back into the same zone, a merge only after a decision, hosts, tool arguments, time zones, schedules, people,
  scripts, secrets) runs after parsing with a path-named error. `FlowStage`, `FlowDefinition`, `FlowStepInput`,
  `TriggerConfig` and `FlowFile` are `z.infer`; the 13 hand-written parsers and the hand-written flow-file JSON Schema
  are gone (`docs/flow-file.schema.json` is generated: `npx tsx scripts/flow-file-schema.ts`). The lead's `propose_flow`
  schema is `toModelSchema(proposeFlowInputSchema)` (`src/contracts/flow-propose.ts`, for item 5 to import) and its call
  is read with it, so a refusal is the lines it reads next turn. `contract.ts` now suggests the key an unknown one meant
  (aliases such as `onFail` → `ifFails`, or a near spelling) and names a union's choices, for every contract. Kept:
  a version 1 drawing reads as every release has (defaults, trimming, clamped places, long saved instructions), and
  every recorded drawing, step list, export and trigger in `test/fixtures/flows/` reads byte for byte as 0.9.34 made it
  — the same JSON, digests, stored and rollback forms, and exported files. Tightened, on purpose: a key a step, file
  zone, trigger setting or `propose_flow` argument's kind doesn't take is refused by name (a sort's `ifFails`, a wait's
  `remindAfter`); a drawing or file with a newer `version` is refused plainly; flow and trigger refusals are path-named
  lines.
- **4. Scout report** (2026-10-05). `src/contracts/scout-report.ts` is the one report schema: `parseReport` reads it
  (and, as `storedReportSchema`, every report kept as evidence, without the length limits), and a Claude scout gets it
  as the report branch of `SCOUT_OUTPUT_JSON_SCHEMA` (`toModelSchema(scoutHandbackSchema)`); `REPORT_SHAPE`,
  `DECISION_SHAPE` and the hand-written parser and types are gone (`ParsedReport`, `ReportItem` and `ReportImage` are
  derived), and `REPORT_LIMITS` reads its byte limits from `TEXT_LIMITS` (`reportSummary` and the new `report*Bytes`).
  Blank text, byte limits, controls, one-line fields, a one-paragraph summary, safe links, a screenshot named twice and
  an item naming one the report lacks run after parsing; every refusal, and the one shorten turn, names its path
  (`items[0].url: must be an http or https address`). The question branch mirrors the fields `parseDecision` reads,
  which stays its validator until item 7. Kept: unversioned reports (every one through 0.9.36, written or stored),
  `version: null` and `version: 1` read alike: unknown keys in the report and its follow-ups, items and images are
  ignored, and null lists read as none before the strict schema check. This preserves the old parser's acceptance
  and reason codes. Reports are now stored as `version: 1`, which older releases read too. Replayed from
  `test/fixtures/scout-reports/`, reconstructed per release from git history (the saved evidence was not readable
  from the build). Tightened, on purpose: a newer `version` is refused.
- **5. Lead tools and the MCP gateway** (2026-10-05). `src/contracts/lead-tools.ts` holds one input and one output
  schema for each of the lead's 51 tools (`propose_flow`'s input is the flow contract's own, from
  `src/contracts/flow-propose.ts`), and `src/contracts/gateway-tools.ts` one each for the gateway's 25 (the seven
  assignment tools' inputs are also what `toolroll assignment` reads its flags with). What the model and `tools/list`
  are shown is `toModelSchema` of the input schema; every call is read with its derived reader before any precondition or handler, and
  the handler gets the typed value. A bad lead call returns every path-named line as the tool result the lead reads next
  step (`reason: required`, `run: must be an integer (got a number)`); a bad gateway call is JSON-RPC
  `-32602` with the same lines, and semantic refusals stay `isError` results. What JSON Schema can't say (a repo the
  operator may reach, plain text without secrets, ISO times, control characters in an assignment ref) is still checked
  after parsing. Output schemas describe each result's top level: a result that disagrees is logged, including in tests,
  never refused; the gateway still returns text only, without `outputSchema`. Gone: the hand-written schema builders
  (`schema()`, `TASK_ARG`, `REPO_ARG`, `ACCEPTANCE_ARG_SCHEMA`, `TASK_SCOPE_TEXT_SCHEMA`), the gateway's `invalidArgs`,
  `assignmentArgumentProblem`, and the handlers' structural re-checks; their text limits moved into `TEXT_LIMITS`. Tool
  names and descriptions are unchanged, and every call recorded in `test/fixtures/tools/calls.json` is read the same by
  the 0.9.36 hand-written schemas (`schemas-0.9.36.json`) and the derived ones (`src/contracts/tools.test.ts`). The
  gateway's pinned `tools/list` bytes changed only in spelling: a nullable is `anyOf`, an empty `required` is left out,
  and integers carry the safe-integer bound. Kept: lead readers strip unknown tool arguments (and extra agent keys),
  while flow proposals keep their existing strict contract and `propose_action` passes unknown keys to the action's own
  per-operation check, which refuses them as in 0.9.36; `list_tasks` floors and
  clamps numeric limits to 1–50 (otherwise 20); `get_task_conversation` clamps safe-integer limits to 1–30 (otherwise
  12); `get_flow_insights` uses 30 days for non-safe-integer input; `get_person` ignores unusable id/name selectors.
  The model still sees strict schemas, and gateway input validation is unchanged. These loose calls are replayed from
  `test/fixtures/tools/loose-lead-calls-0.9.36.json`. Acceptance criteria use the plan's non-empty id and statement;
  ordinary integer fields retain the safe-integer bound, without blocking the lead's legacy clamp/fallback inputs.
  `not: null` on `propose_task`/`propose_scope` and a null `note`, `path` or `line` on `propose_review`, which the handlers
  always read as left out, are now in the advertised schema too. Known and kept: the
  gateway's `propose_scope` takes no `acceptance`, so the coordinator door refuses every one of its calls, as in 0.9.36.
- **6. Builder handoff and proof** (2026-10-05). `src/contracts/handoff.ts`, `src/contracts/proof.ts` and
  `src/contracts/verification-receipt.ts` are the one schema each for `handoff.json`, the builder's proof and the
  verification receipt; `HandoffArtifact`, `ParsedProof` and `VerifyCommandFacts` are derived from them, and
  `PROOF_LIMITS` reads its byte limits from `TEXT_LIMITS`. Handoffs saved as `schema: 1` read as `version: 1`; a proof
  a builder writes (`version: 1`) is read as before and stored as strict `version: 2`; receipts keep their version 1
  (direct) and 2 (reused) bytes, so saved digests still match. Replayed from 15 real runs in `test/fixtures/evidence/`:
  every read and every recorded adjudication is unchanged. Tightened, on purpose: a newer version of any of the three
  is refused, version 1 handoffs and version 2 proofs are strict about unknown keys, and a sealed receipt with a field
  its version does not define is refused by `verificationEvidence` (before, only process recovery refused it).
- **7. Small structured answers** (2026-10-05; compatibility revision 2026-10-06). One schema each in
  `src/contracts/`: `task-sizing.ts`, `review-findings.ts`, `decision.ts`, `teammate-turn.ts` and `sort-answer.ts`.
  Types and model-facing JSON Schemas derive from them; callers use their readers and errors name the field path.
  Claude sizing, teammate turns and the review channel's findings use the generated schemas. Jev's Decisions API
  takes questions rather than JSON Schema. `DECISION_MODEL_SCHEMA` is exported for the separate scout migration;
  `scout-report.ts` and `scout.test.ts` remain unchanged from before item 7.
  Compatibility follows review comment 843: unknown keys are ignored, decisions keep their unversioned format
  (including ignoring a supplied `version`), and partial teammate turns default absent or non-text fields to ""
  and filter non-string options. Sizing reasons default to "" and are clipped after whitespace collapses; findings
  are limited after controls and whitespace collapse. Jev keeps its old defaults for non-numeric confidence/chance,
  skips non-numeric notes, defaults non-string model and non-numeric cost, and ignores unrelated answer values.
  Required choices, decision approval terms and zone action checks remain enforced. Teammate limits still use their
  one shorten turn; sizing and findings schemas do not promise one. These are compatibility exceptions to the strict
  object and new envelope ground rules, as requested in comment 843, not new acceptance restrictions.
  The contract harness replays `test/fixtures/answers/`, including older partial turns. These are synthetic samples
  from the writers and tests, not database exports: the installed database was denied to both builds. Read-only
  replay of actual saved findings and decisions remains an evidence gap.
- **8. Flow stage outputs and card state** (2026-10-06). One schema each in `src/contracts/`: `stage-output.ts` (what a
  finished zone hands on — `{{stage.<id>}}` and a research zone's `.items` and `.report`, per zone kind in
  `STAGE_HANDOFFS` — and the card's versioned `outputs_json`, with an output too long to pass on kept whole beside it),
  `flow-send.ts` (the Send to me and Person chooses payloads kept in `flow_send.content_json`, and a person's choice)
  and `flow-card.ts` (the card and what an update may change). `FlowCardRow`, `FlowSendContent`, `FlowSendLink` and
  `FlowSendItem` are derived from them; `readFlowSend`, `readFlowItems` and the store's card reader read through them;
  the engine, steps and sends write handoffs with `withStageHandoff`. A task filed after a zone whose output was over
  TEXT_LIMITS.stageOutput is given that output whole (flowGoalCuts), not only the link to the discussion. A
  `{{stage.…}}` reference a save adds — on the canvas, in `toolroll flows create/edit`, from the lead, a template or an
  imported file — must be one its zone hands on, refused by path (`stages[2].instructions: stage.research.unknown is
  not available (Research hands on {{stage.research}}, {{stage.research.items}} and {{stage.research.report}})`); one
  the saved flow already had is never refused, and nothing is checked when a flow is read or run. Every gallery
  template, starter, kit and built-in template, and every recorded saved flow and flow file, passes as it is (168
  flows). Kept: saved outputs and sends read exactly as 0.9.36 read them (replayed from `test/fixtures/stages/`,
  recorded by running the 0.9.36 readers; synthetic, writer-shaped samples, because the installed database was denied
  to this build too — read-only replay of real rows remains an evidence gap); sort decisions (`decision_json`) are
  untouched and keep item 7's schema. Tightened, on purpose: the reference check above; a card's outputs and a kept
  send now carry `version: 1`, and one made by a newer Toolroll is refused (the card reads it as empty and never writes
  over it); a version 1 one is strict. A card a newer Toolroll wrote outputs for reads as empty in 0.9.36 and earlier.
- **9. Lead context and project knowledge, memory and skills** (2026-10-05). One schema each in `src/contracts/`:
  `lead-context.ts` (the lead's per-turn bundle, checked as built, before it is scrubbed), `project-knowledge.ts`
  (saved knowledge and the selection a run is given), `project-memory.ts` (a decision, its history entry, a draft and a
  brief's line), `project-skills.ts` (a package, a selection, a run's snapshot) and `memory-pass.ts` (the analyser's
  verdict, a kept verdict, a proposal and its evidence). The verdict schema is the analyser's `--json-schema` (Codex's
  output schema; the prompt for other providers), with a derived tolerant parse-side schema for older answers;
  `subscription-chat.ts` takes it as one
  optional `outputSchema`. Every size budget is in `TEXT_LIMITS` (`LEAD_CONTEXT_MAX_BYTES`, `SKILL_LIMITS`,
  `MEMORY_TRACE_BYTES` and `INSTRUCTION_BUDGET_BYTES` read from it); counts are named constants. A digest is checked
  against the stored bytes before they are parsed, and a row is upgraded only in memory. New knowledge, kept verdicts
  and decision history entries carry `version: 1`; unversioned ones read as before (knowledge keeps the fields its
  readers knew; a gap without `matchesGap` reads as null). A skill package (content-addressed: its digest is its
  version), a selection (skill names as keys; `version` is a valid name) and a proposal's evidence (a list older
  runtimes read as one) keep their exact bytes, with no envelope. Saved rows are read without length bounds
  (`text-limits.ts`: reading never re-validates length; a kept verdict through 0.9.36 holds a clipped field one past
  its limit). Replayed from `test/fixtures/context/`: every saved row reads as 0.9.36 read it, and frozen selections,
  snapshots, packages and selections byte for byte. No form a release wrote is tightened. Tightened, on purpose: a
  payload with a newer `version`, or one that does not match its shape, reads as unverifiable (the same refusal a
  wrong digest gets), where before it was passed on as it was. The analyser is given the strict schema; reading keeps
  the old clipping, coercion and defaults (including a missing `matchesGap` as null), ignores unknown keys and drops
  single bad claims. Claims without a quote in the trace or about an unknown instruction are still dropped. A lead
  catch-up mismatch logs the field path and still sends the scrubbed, size-bounded bundle. Default decision authors
  keep accepting account names longer than the explicit author's 80-byte budget.
- **10. Scope, acceptance criteria and sealed routes** (2026-10-05). `src/contracts/scope.ts` holds the scope's terms
  (goal, outOfScope, touches, acceptance) and the acceptance criterion, built from the plan contract's own fields and
  criterion (`plan.ts` unchanged; a scope names up to `TEXT_LIMITS.scopeTouches` = 50 paths, a plan 32);
  `src/contracts/route.ts` is one sealed-route schema for version 1 and 2 routes, with overrides and task size.
  `AcceptanceCriterion`, `PhaseRoute`, `RouteLeg`, `RouteOverride` and `TaskSizing` are derived; `parseAcceptanceCriteria`,
  `exactAcceptance`, `proposeGuarded`, `routeFromJson`, `parseOverrides` and `parseSizing` read through them, and what
  JSON Schema can't say (UTF-8 bytes, control characters, duplicate ids and evidence kinds, leg order, posture, one
  override per phase) runs after parsing with a path-named error. Item 5 should use `toModelSchema(rubricInputSchema)`
  for the lead's rubric arguments; `mate-tools.ts` remains unchanged. The evidence kinds and rubric limits moved to
  `src/contracts/acceptance-terms.ts` (re-exported by `scope.ts`) so
  `plan.ts` and `scope.ts` load in either order. Kept: every recorded scope, standing order and sealed route in
  `test/fixtures/scopes/` (from the authentic v47 fixture, this release's store and earlier releases' legacy shapes)
  re-derives its digest, approved digest, rubric and route bytes exactly as before (`npx tsx scripts/scope-replay.ts
  [db]` replays a real database read-only). No tightening: criteria still ignore unknown keys and read an empty `how`
  as none; refusals name their fields (scope.ts keeps the prose plan.ts's unchanged `acceptanceLine` expects), and a
  route from a newer Toolroll says so. The replay recognizes both historical routine `digest_version: 1` encodings:
  fields-only approvals with migration-pinned profiles and restated digests that bind the saved profile without a
  version bump. Working and approved digests are checked independently; genuine mismatches remain visible.
- **11. Chat actions and channel callbacks** (2026-10-06). `src/contracts/chat-actions.ts` holds one strict schema per
  chat action's data (all 45 in `CHAT_ACTIONS`) and the saved proposal's action, `version: 1`; `CHAT_ACTION_FIELDS`,
  `SharedAction` and the request check in `prepareSharedAction` are derived from them, and `sharedActionPayload` reads
  through `readSharedAction`. A drawing, trigger or script inside a request is still read by its own contract (item 3).
  `src/contracts/chat-content.ts` is what Slack, Discord and Teams keep between steps: each event kind's body and a
  planned message part (`ChatContent`), both saved with `version`. `chat-callback-rows.ts` reads a proposal card's and a
  decide button's saved row; `telegram-callback.ts` is the Telegram update (Telegram's, unknown fields ignored) and the
  data a Toolroll button carries, within the new `TEXT_LIMITS.telegramCallbackDataBytes` (64): every keyboard is built
  with `telegramButton`, which refuses data Telegram would. `slack-callback.ts`, `discord-callback.ts` and
  `teams-callback.ts` read each app's tap (the app's envelope loosely, Toolroll's button data strictly; Teams reads
  `value.so` and ignores extra submit keys as before). The propose_action
  JSON Schema in `mate-tools.ts` is left to item 5, which imports these. Kept: every saved proposal, part, event body,
  inbox update, button row and app tap in `test/fixtures/chat/` reads as 0.9.36 read it — the same fields and the same
  request bytes, so a saved proposal's stamp still matches — and unversioned rows are never rewritten; authentication,
  pairing, exact chat and message binding, one-use tokens and stale replies are unchanged. Action requests retain
  ignored values, null optionals and branch-specific defaults, including `watching !== false`; an unversioned
  proposal's request is kept byte for byte and checked again only when preparing confirmation, as before.
  Tightened, on purpose: a newer `version` of any of these is refused plainly; a button tap from the paired person whose data Toolroll didn't
  make (or can't read) is answered with the path-named reason and does nothing, where Slack, Discord and Teams dropped
  it silently and Telegram called it stale; a Telegram update that doesn't match the schema is passed over with a
  named problem instead of being half-read. Schema-invalid pushed JSON updates are logged and acknowledged with
  HTTP 200, so Telegram does not resend them. Unreadable saved message parts keep their field-path problem and
  payload, with delivery stopped instead of scheduled for another retry.
- **12. Coding handoff and context** (2026-10-05). `src/contracts/coding-handoff.ts`, `src/contracts/coding-context.ts`
  and `src/contracts/coding-workspace.ts` are the one schema each for the coding handoff receipt, the managed context
  capture and the workspace record (`coding_session.document`); `CodingHandoffReceipt`, `CodingHandoffPreview`,
  `CodingContext`, `CodingContextMetadata`, `CodingSession` and `CodingStatus` are derived from them, and the receipt
  reuses the plan's acceptance criterion schema. The receipt's saved hash is checked before parsing; its identity,
  branch and scope seal, the context's digest, project identity and skill files, and session ownership run after, as
  before. Receipt and context metadata keys keep their written order, so parsed values hash, seal and digest to the
  saved bytes. Unversioned sessions retain the old cast's fields exactly, including partial rows, nulls and unknown
  nested keys. A normal save writes version 1 only when the entire record fits without losing fields; other legacy
  records stay unversioned. Reads alone do not rewrite saved bytes. Replayed from `test/fixtures/coding/` through
  restart, context verification and the receipt and seal checks, with the original partial deployment and desktop
  update fixtures retained. Tightened, on purpose: a newer version of any of the three is refused plainly, and version
  1 records and captures are strict about unknown keys. An unreadable versioned session remains visible with its
  path-named error without disabling other sessions; its saved document is left intact. Coding contract errors report
  null as a wrong value, not as a missing field.
- **13. Console form bodies and JSON API** (2026-10-06). `src/contracts/console-api.ts` holds one schema for every
  URL-encoded body the console reads (`CONSOLE_FORMS`: sign-up, sign-in, invite, the shared guard, every `handlePost`
  route and each task, attend and routine verb; families with one dispatch, such as `/code/*`, `/flows/*` and the
  teammate pages, share one) and lists the POSTs that read no field (`BODILESS_POSTS`). Each handler reads its body
  through `readForm`, whose view is typed by the schema's field list, so reading an undeclared field fails the
  typecheck. Kept: a body reads exactly as `URLSearchParams` did — first value, every value in order, presence,
  unknown and computed names (`question:<id>`, `param.<id>`) — with every default, trimming, clipping, conversion and
  refusal still in the handler; the CSRF, nonce, digest, password and duplicate-field checks are unchanged and in the
  same order. A body that disagrees is logged and still read. The three `?format=json` responses (ledger page, evidence
  pack, flow view) are checked as sent by loose, unversioned schemas; their bytes are unchanged (no version key, so
  sealed ledger entries and pack digests still match), and a mismatch is logged, never refused. Telegram's pushed
  updates (item 11) and flow webhooks and public forms (item 15) stay with their items. No tightening. Replay of
  real rows remains an evidence gap: the installed database was denied to this build, and form bodies are never stored.
- **14. CLI JSON input and output** (2026-10-06). `src/contracts/cli.ts` holds the one `--json` envelope schema
  (`envelopeVersion` 1, `ok`, `command`, and a refusal's `reason` and `message`), one answer schema for each of the
  215 commands the guide declares, and the guide row's schema (`CommandRow` and `CommandFlag` are derived from it).
  `surface.ts` pairs every row, in order, with its answer's schema (`COMMAND_ENTRIES`), and `COMMAND_GUIDE`, which
  `contract --commands --json` dumps, is projected from those entries. 25 answers name their top-level fields:
  `contract`, the no-verb `scan`, `status`, `integrations`, `ready`, `task add/list/show/hold/unhold/wait`, `flows
  list/show`, `skills list`, `grants`, `gaps`, `reap`, `cap list`, `outbox deliver`, and the runner, routine,
  incident, outbox, approver and coordinator lists; the other 190 (sessions, knowledge, memory, models, the other flows, task and assignment
  verbs, and the operator ceremonies) are held to the envelope under their own `command` name, with their fields
  left for later. Every envelope `cli.ts` and `operate.ts` write is checked before the unchanged `envelopeJson`; a
  disagreement is logged on stderr and the answer is written as it was, never refused. Answers are loose objects, so
  a key a newer Toolroll adds is ignored. Kept: flag parsing, exit codes, `-o` and every answer's bytes;
  `test/fixtures/cli/envelopes.txt`, recorded before the change, replays 22 answers (contract, scan, task, status,
  ready, integrations, flows and lists, refusals and usage slips included) byte for byte. Not covered: the envelopes
  the flows, knowledge, memory, models, session, team, project, task-outcome, assignment-adapter and onboarding
  modules write go straight to `envelopeJson` and are not checked at runtime (outside this item's files). Input flags
  are parsed as before; no CLI input moved to a schema here (session and assignment inputs already have theirs). The
  installed database was denied to this build, so read-only replay of real saved state remains an evidence gap. No
  tightening.
- **15. Trigger payloads** (2026-10-06). `src/contracts/trigger-payloads.ts` holds one non-strict schema each for
  GitHub's issues and pull requests, issue events, workflow runs and signed webhook events, Linear's GraphQL answer,
  issue and signed webhook event, a plain webhook's JSON (any JSON, kept as sent for its title and body paths), a
  mailbox's normalized message (typed against `InboundMail`) and a shared form's fields (each field's first value).
  Only the fields Toolroll reads are typed; unknown keys are ignored and a field of the wrong type reads as missing,
  as the hand readers' `text()` and `record()` did, so no reader refuses. `Number()` coercion (`number`,
  `webhookTimestamp`, the form's `t`), presence checks (`pull_request`, `updatedFrom.stateId`), fallbacks, clipping
  and dynamic webhook paths run after parsing, as before. `flow-triggers.ts` reads every poll, delivery, message and
  form through them; JSON, signature and age checks keep their order, so every delivery gets the same 200, 202,
  400, 401, 404, 413 or 429 and plain reason as in 0.9.41, and a poll's unreadable answer still backs off. The
  focused observation request is `src/contracts/observation-request.ts` (`versioned(1)`, strict, as it always
  refused unknown keys); `parseObservationCases` reads through it, keeps its 16 KB guard and its three plain
  refusals, and still treats the same case written in another key order as distinct. Compared with the 0.9.41
  readers over generated odd payloads (deliveries, polls, forms, items, observation requests): no differences.
  Read-only replay of real saved data remains an evidence gap: the runner was denied the installed database and
  evidence folder, and raw deliveries are not kept. Loosened, at the operator's request: an observation request
  without `version` is read as version 1, where it was refused. Nothing is tightened.
