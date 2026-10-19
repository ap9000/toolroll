# ACP agents: one protocol adapter for every coding agent that speaks it

Status: spec v9 (2026-10-19) — v6–v9 revise only Layer E (v9: § "Layer E, v9") (v8: § "Layer E, v8") (v7 answers the v6 review: § "Layer E, v7 amendments") (§ "Layer E, revised (v6)" at the end), after layers A–D shipped and were reviewed. Earlier: v1 → Codex REVISE (8 findings), v2 → REVISE (7), v3 → REVISE (4), v4 → REVISE (2); every finding answered below (§ "Review ledger"). Owner decision: Alex, 2026-10-19 ("first move to acp adapter so we can get all the agents running").

## Why

Agent Client Protocol (ACP) is JSON-RPC 2.0 over a child process's stdio. OpenCode (`opencode acp`), Cursor (`cursor-agent acp`), Cline (`cline --acp`), Qwen Code, Goose, Grok and Gemini CLI (`gemini --acp`) speak it. One transport adapter, with each agent binary admitted by evidence, gets Toolroll all of them without a hand-written adapter per vendor.

## The strategy change this makes (DESIGN.md §9b/§9d)

DESIGN funds exactly one tier-2 adapter (gemini) and says a second needs "retiring this one or a new strategy decision". This is that decision:

- The funded tier-2 unit becomes **the ACP transport**. Agents are data rows under it, each admitted per binary by attestation.
- The gemini stream-json adapter is untouched by this arc. Its retirement — moving the `gemini` provider onto the ACP transport under the same id — is a follow-up commit gated on gemini passing ACP conformance (today gemini 0.60.0 is outside the stream-json range `[0.57.0, 0.58.0)` and its free-tier quota is exhausted, so it can't be proven yet).
- DESIGN §9d is rewritten in the same commit as layer E.

## Evidence captured (2026-10-19, this machine)

Real transcripts in the session scratchpad (`acp-fixtures/oc.jsonl`, `gm.jsonl`), sanitised (absolute paths → `<work>`, session ids kept) into `src/fixtures/acp/`:

1. **OpenCode 1.18.18**: `initialize` → `agentInfo {name:"OpenCode", version:"1.18.18"}`, `loadSession`, `sessionCapabilities {close, fork, list, resume}`, `authMethods [opencode-login]`. `session/new` → agent-minted `"ses_…"` id and `configOptions[{id:"model", type:"select", currentValue, options}]`. In the prompt it ran `ls -la` **with no `session/request_permission`**. Its first `tool_call` carried no command (`title:"bash"`, `rawInput:{cwd}`); the command arrived in a later `tool_call_update` (`status:"in_progress"`, `title:"ls -la"`, `rawInput.command`), then `completed` with text `content` and `rawOutput`. Then 240 s of silence with no prompt response.
2. **Gemini 0.60.0**: `session/new` → UUID id, `modes {default|autoEdit|yolo|plan}`, `models {availableModels}`. `session/prompt` → JSON-RPC error `{code:429, message:"You exceeded your current quota …"}`. Kept as a **negative protocol fixture** (prompt error → failed terminal) only. Fallback chains were removed in v115; nothing here restores them.

Neither transcript proves a successful terminal, cancellation, or confinement. Those are proven by the conformance probe (layer E) and by a fake ACP agent in the test suite (layer C).

## Identity: one provider id per agent, one shared transport

v1 proposed a single `acp` id with an `agent` field. Review showed that identity would be lost everywhere keyed by provider alone (`AgentSpec`, gateway equality check, phase config, readiness, auth pause/unpause, runtime checks). So:

- Each ACP agent is **its own `ProviderId`**: `opencode`, `cursor`, `cline`, `qwen`, `goose` (v1 list; `grok` is left out until its CLI's ACP entry point is confirmed). Every existing per-provider mechanism — readiness, auth pause, routing, phase config, spend rollups, the gateway's provider check — then works per agent with no new keying.
- `src/acp-agents.ts` holds one row per agent: display name, binary, ACP argv, sign-in words, model selection mechanism (`config-option` | `set-model`), env keys it reads, config-surface words. The exhaustive `Record<ProviderId, …>` maps in provider.ts/keys.ts/provider-auth.ts get their ACP entries from these rows through one helper, so a row is the only place to add an agent; restated unions (policy.ts, model-catalog.ts, doctor.ts, models-cli.ts, project-tools.ts, planner.ts, scout.ts, agent-fence.ts `PROVIDER_HOME`, spend.ts, render-tasks.ts, server/tasks.ts error text, builder.ts `providerVersionOf`) are converted to read `PROVIDER_IDS` / the rows where they are lists, and get explicit ACP branches where they are behaviour.
- **Nothing executes an ACP binary outside the gateway.** Provider listing, readiness (`runner.ts`), the providers screen (`operate.ts`) and `builder.ts` `providerVersionOf` use a **non-executing inspection** for ACP providers: PATH lookup, realpath, `lstat`, and — for a script launcher — a bounded (64 KiB, O_NOFOLLOW) read of the nearest `package.json` for `name@version`. The version they show and stamp is the attested one (from `acp_attestation`) plus "changed since check" when the stat tuple moved. `--version` runs only inside the conformance probe, which goes through the gateway. An architecture test lists every `execFile`/`spawn`/runner call site that can receive an ACP provider and fails if one exists outside invoke.ts.
- **Auth mode**: a third `AuthMode`, `agent-login` (the agent's own cached sign-in), is the only mode ACP providers have. Migration v124 widens the auth-mode CHECKs (`provider_auth`/quota/auth-pause families, store-baseline.ts:1551 and siblings, all grep-listed) and `keys.ts` readers parse it. Key controls (`toolroll keys`, Settings → keys, `PROVIDER_KEY_ENV`/`OWN_KEY_ENV`) **refuse** ACP providers: there is no key to set. Auth pause/unpause works per provider id as today; an auth failure is recognised from a JSON-RPC `auth_required` error (code -32000 with `authMethods` hint) on `session/new` or `session/prompt`.
- The integration inventory explicitly includes `contracts/route.ts` `ROUTE_PROVIDERS` (independent union, pinned by test) and the setup/onboarding registry (`provider-auth.ts` `NAMES`/`SIGN_IN`, `agent-onboard.ts`).
- **Migration v124** widens every provider CHECK to the new ids: `phase_config`, `phase_tier_config`, `phase_tier_alternate`, `provider_readiness`, plus `model_seen.source`, `runtime_check.tool`, the auth-mode CHECKs above, and the new tables `acp_attestation`, `acp_billing`, `acp_probe_ticket`, `acp_probe_step` (the `run` table gets exactly one **additive** nullable column, `agent_reported_usage_json` via `ALTER TABLE ADD COLUMN`; `task_ref NOT NULL`, the role CHECK and every existing column are unchanged) — table rebuilds, same pattern as earlier widenings, with a migration test that round-trips existing rows. A full grep of `store.ts`/`store-baseline.ts` for `IN ('claude'` is part of the layer and listed in the commit.

## Profile

```
AcpProfile = { provider: AcpProviderId, model: string, permission: "full",
               timeoutSeconds, idleTimeoutSeconds, repairModel: string,
               repairTimeoutSeconds, repairIdleTimeoutSeconds }
```

- **Model is required and exact** — the existing exact-model approval rule holds unchanged. It must be one the agent offered in its attestation probe (and is re-checked live at `session/new`, below). No "agent default".
- **`permission` is `"full"` only** — "full access inside the fence", the same guarantee Claude and Gemini full-access builds have today. v1 proposed read-only/edit postures; review showed nothing enforces them (the fence is a deny-list: `(allow default)` on macOS, `/` bound on Linux, and OpenCode runs commands without asking). A posture the plane can't make true is not offered. Read-only ACP runs (planning, review) are refused in v1; ACP agents build and repair only.
- **No `maxTurns`** — ACP has no turn limit. Runs are bounded by **both** clocks at once: the overall `timeoutSeconds` and the silence `idleTimeoutSeconds` (seconds, matching what builder.ts reads for the other profiles; converted ×1000 once, in builder, into `invokeAgent`'s `timeoutMs` and `idleTimeoutMs`). Builder today passes one watchdog per provider; for ACP it passes both, and `runAcpSession` enforces both itself (idle = no line from the agent), so neither depends on a shared watchdog choice. Repair passes `repairTimeoutSeconds`/`repairIdleTimeoutSeconds` the same way; stated in the profile prose as "no turn limit; stops after N min, or M min silent".
- Repair uses `repairModel`/`repairTimeoutMs` like the codex-shaped profile; a repair is a fresh session (no resume in v1).
- `profileDigestOf` covers every field. New union member → existing canonical bytes unchanged, `PROFILE_DIGEST_VERSION` unchanged.

## Admission: attestation with explicit denial

- `attestProvider` today returns `null` for "no range → tier 1, allow". For ACP providers absence is **denial**: the lookup returns `{tier:"acp", evidence: shipped | local | none}`, and `none` (or a revoked local attestation) refuses at the gateway and at the pre-claim skip with words ("OpenCode isn't checked on this machine — run `toolroll agents check opencode`").
- **Denial ships before execution.** Layer B (registry) already makes `attestProvider` return deny for every ACP provider (there is no attestation table yet, so nothing passes), and layer C's runner is reachable only through that gateway. Layer C's slow tests admit the fake agent by inserting an attestation row through the store test seam that layer E then uses for real — never by a code path that skips the check. So no intermediate commit can spawn an unchecked ACP binary.
- **Shipped evidence** (release act): a reviewed commit with a version range plus recorded conformance fixtures. v1 ships **none** — the OpenCode transcript doesn't prove a success terminal — so every agent starts at local evidence. A shipped range for OpenCode is added once the conformance fixtures from a passing local check are recorded and reviewed.
- **Local evidence** — an explicit operator exception to "re-attestation is a release act", recorded as such in DESIGN: `toolroll agents check <agent>` (and the providers-screen button) runs the **conformance probe**. It's credentialed (password); the result row in a new `acp_attestation` table binds:
  - runner id, `CONFORMANCE_VERSION` (the probe's own version; bumping it invalidates every local attestation),
  - the PATH-resolved realpath, its `dev/ino/ctime/size` and sha256, and — when the realpath is a script (shebang) — the interpreter's realpath, sha256 and `--version`, plus the nearest `package.json` `name@version` and the sha256 of its resolved `main`/`bin` entry,
  - `--version` output and the handshake's `agentInfo.name`/`version`,
  - the model list offered, the billing declaration (below), who, when.
  Revoking is one step and needs no password.
- **Re-check at spawn**, in the gateway, after all asynchronous setup and immediately before `spawn` (the existing attest position moves after fence/broker setup for ACP): every bound file — launcher realpath, interpreter realpath, package entry, `package.json` — must match its recorded stat tuple; on any mismatch that file is re-hashed, and the spawn refuses unless every hash still matches. The spawned argv uses the attested realpath, not a fresh PATH lookup. **A script launcher is executed through its pinned interpreter**: the gateway parses the launcher's shebang itself (`#!/abs/interp [one arg]` or `#!/usr/bin/env [-S] name [args]`; anything else refuses `unsupported-launcher`), and spawns `[interpreterRealpath, ...shebangArgs, launcherRealpath, ...acpArgv]` — the kernel's shebang and the child's `PATH` never choose the interpreter. The interpreter realpath is the attested one (bound and re-checked like every other file). A native launcher (Mach-O/ELF magic) is executed directly. Regression tests: a PATH-switch (a different `node` earlier on the child's `PATH` is never the one run), a changed shebang (re-hash mismatch refuses), a launcher swapped for a symlink to another script (realpath mismatch refuses). The handshake then re-proves `agentInfo.name`/`version` equal the attested ones before any prompt is sent; mismatch → kill, `provider-protocol`.
- **The probe runs through `invokeAgent`**, so it gets the same fence, env shedding, containment, custody and stop fence as a build — but it is **not a `run`**. `run.task_ref` is NOT NULL and every run reader and spend join assumes a task; probes keep their own durable ledger instead, and ordinary runs are untouched.
  - `invokeAgent` takes a custody target that is either the existing run (unchanged) or a **probe step**. Every durable write the gateway makes — provider start stamp, version stamp, early session id, terminal class, usage/cost, exit — goes through a small `GatewayLedger` interface with two implementations: the existing run writes (moved behind the interface verbatim) and `acp_probe_step` writes. An architecture test pins that the run implementation is the old code path, byte-for-byte in behaviour (the existing invoke tests run unchanged).
  - The credentialed check writes an `acp_probe_ticket`: ticket id, runner id **and incarnation**, provider, launcher realpath + sha256 (and interpreter/package bindings), model, `CONFORMANCE_VERSION` (prompts and steps are constants in code, not inputs), workspace, per-step limits, `expires_at` (+15 min), status.
  - The ticket admits exactly **three bounded steps, in order**, each a separate spawn through the gateway, each consumed atomically (`INSERT INTO acp_probe_step … SELECT … WHERE ticket open AND not expired AND runner/incarnation match AND step = next expected AND bindings equal`; zero rows → refuse):
    1. `version` — the attested launcher with `--version` (plain fenced spawn, no ACP runner; 15 s);
    2. `session-ok` — ACP session: handshake, model selection, the success prompt, then **graceful** shutdown (`session/close` / stdin EOF, must exit on its own within the bound) (300 s / idle 60 s);
    3. `session-stop` — ACP session: the long prompt, `session/cancel` → `cancelled`, then the stop fence **forces** group termination and custody observes no survivor (120 s).
    The attestation row is written only after all three steps pass, in the same transaction that closes the ticket. Any failure closes the ticket as failed with the failing check named.
  - The workspace: a plane-owned parent repository `<state>/acp-probe/parent` (created once, one empty commit) and, per ticket, a **linked worktree** added with `git worktree add <state>/acp-probe/wt/<ticket>`, so `trustedWorktreeBinding` validates it exactly as a build checkout (registry entry and reciprocal pointers); the probe pool root is passed as the pool root. Removed with `git worktree remove` when the ticket closes.
  - A ticket never satisfies a run's custody proof and a run never satisfies a probe step's; the only creator of tickets is the credentialed check (architecture test).
  - **Probe spend**: each step records usage/cost on its `acp_probe_step` row under the same billing rule as builds (stamped at step admission, below). `spend.ts` rollups and monthly budget gates add probe spend as its own line ("Agent checks") via a `UNION ALL` over `acp_probe_step` — not through the run/task join — so a probe is never invisible to budgets.
- **What the probe must prove** (each a named check, all required; any failure records nothing):
  1. handshake: protocolVersion 1, `agentInfo` equal to `--version`, no auth error;
  2. model selection: the chosen model set via the row's mechanism and echoed back as current;
  3. success terminal: one prompt ("create done.txt containing ok, then stop") → a `tool_call`, the file with that content, prompt response `stopReason:"end_turn"`;
  4. unadvertised client methods: the agent finishes without `fs/*` or `terminal/*` (if it calls them it gets -32601 and must still finish or fail cleanly);
  5. cancellation: a second prompt ("run `sleep 120`") then `session/cancel` → `stopReason:"cancelled"` within 15 s;
  6. forced stop and descendants: after cancel, the stop fence kills the group; no process from the group survives (the existing custody observation proves it);
  7. isolation: a canary env var set in the plane's env is absent from the agent's (the prompt asks it to `printenv` the name — the output must not contain the value), and a canary file inside a fenced path is unreadable (`cat` must fail);
  8. clean shutdown: `session/close` (when advertised) and stdin EOF end the process within the bounds below.
  Malformed and failed terminals are proven in the suite against the fake agent, not live.
- Tokens: the probe uses the selected model; the CLI states this before the password.

## Billing (separate from authentication)

- Auth mode for ACP providers: `agent-login` only (the agent's own cached sign-in). The spawn sheds `AGENT_ENV_DENYLIST` plus every key env Toolroll knows (`PROVIDER_KEY_ENV`, `OWN_KEY_ENV`) — an agent never sees another provider's key. Per-agent API-key auth is a later item.
- Billing is a **separate, explicit declaration** made at check time (and changeable, credentialed): `metered` (default) or `plan` ("billed by the agent's own plan or free tier").
  - `metered`: cost unknown → charged at the run's cap as today's unknown-cost rule does; ACP providers have `nativeDollarCapFlag:null`, so the existing scheduler rule refuses capped work (`budget-unenforceable`, operate.ts:3561). That rule is **also enforced in the gateway** for ACP (defence in depth), since it lives only in scheduler dispatch today.
  - **Scoped to the exact model, bound per invocation.** `acp_billing` rows are keyed `(provider, runner, model)` and versioned (`kind, revision, set_at, set_by`); changing one writes a new revision. A model with no row is `metered`. Every invocation — build, **repair (its own `repairModel`, never inherited from the parent; builder.ts's repair admission is changed to stamp its own)**, and probe step — stamps `(billing_kind, billing_revision, billing_model)` immutably in the **same transaction that admits it for budget**, before spawn; the gateway refuses if the stamped model differs from the model it is about to select. Settlement prices from the stamp, never from the live declaration, so a later change never reclassifies past or running work.
- `plan`: recorded as $0 with the words "billed by OpenCode's own plan", counted in coverage as "not measured". Monthly budgets don't gate it — exactly like a subscription today — and the declaration screen says so.
- ACP's optional `usage_update` (cumulative cost) goes to a separate `run.agent_reported_usage_json` column (shown as "reported by the agent, not attested"), **never** into the authoritative token/cost columns that settlement prices. Tokens from the prompt response's `usage` are likewise kept there in v1.
- `MONEY_CAPABILITIES[acp] = { incrementalUsage:false, nativeDollarCapFlag:null, usageSemantics:"per-invocation" }`; `reportsCost:false`.

## Gateway, runner, custody

- `Adapter` gains `transport:"acp"`; `invokeAgent` stays the only spawner. New runner `runAcpSession` in exec.ts, built on the same pieces `runGeminiStreamJsonl` uses: `spawnStream` (process group, containment), ownership registration, descendant observation, container settlement, the stop watch and `onSessionId`. **The runner returns only after the process has settled** (so `witnessedRunner` records the real exit).
- Sequence: spawn → `initialize` (clientCapabilities `fs:{readTextFile:false, writeTextFile:false}, terminal:false`; 30 s bound) → verify `agentInfo` vs attestation → `session/new {cwd: worktree, mcpServers}` (30 s) → select model via the row's mechanism and verify the agent reports it as current (else `model-unavailable`, kill) → `session/prompt` (the brief, one text block) → read `session/update` until the response to *that* prompt id → shutdown.
- Shutdown (bounded, stops win at every step — the stop watch can SIGKILL the group at any point): `session/close` if advertised (2 s) → stdin EOF → wait 5 s → SIGTERM group → 5 s → SIGKILL → await settlement.
- **Terminal contract** (`terminalContract:"required"`): success iff the response to our `session/prompt` id is a result with `stopReason:"end_turn"` **and** the process then settled by exit 0 or by our own post-terminal signal. Everything else fails closed: a JSON-RPC error on the prompt (carried as `{code, message}`), any other `stopReason`, a missing response (exit, idle or overall timeout first), a second/conflicting response, a malformed response, an unknown stop reason. `promptConsumed` is set **only** by that success response — not by any `session/update` — so `available_commands_update` + exit 0 can never pass.
- Agent→client requests: `session/request_permission` → under `full`, choose the `allow_once` option (never `allow_always`); no `allow_once` → `reject_once`; malformed → error. Every answer is a live step. All other methods → -32601. Notifications for another session id → protocol error.
- Framing limits: 1 MiB per line (over → protocol error, kill), unknown response ids → protocol error, at most 1000 outstanding agent requests. Updates are reduced as they arrive; nothing unbounded is retained.
- `mcpServers`: the project's named tools via the existing broker, only as `http` entries and only when `mcpCapabilities.http`; otherwise `[]`, and the audit row says so.
- Session identity: `sessionIdentity:"announced"` (existing value) — the id from `session/new` is stamped early via `onSessionId`; the parser's id, the callback's and the durable stamp must agree as they do for claude/codex. `resume:"none"` in v1.
- Audit row: `transport:"acp-jsonrpc"`, `initSignal:"session/new"`, `isolation` per agent (opencode: `--pure` "run without external plugins" — verified by the probe, else none), `configSurface` from the row.

## Fence

ACP providers require `macos-sandbox` or `linux-bubblewrap`; no fence available → refuse `fence-unavailable` (there is no rules fallback). The task boundary (`taskBoundary`) treats each ACP agent's home config dir from its row as boundary-denied except its sign-in files, added to `PROVIDER_HOME` per agent. This is the same guarantee as Gemini today, stated in the same words.

## Live view

New `acp` dialect in `createLiveRecorder`. The runner passes `{acp: update}` so dispatch never collides with another dialect.

- `agent_message_chunk` → say (chunks joined per message id).
- Kind mapping onto the **existing** kinds (no reader widening): read→read, edit/delete/move→edit, search→search, execute→command, fetch→lookup, think→plan, other/unknown→tool.
- **No record-format change.** The recorder **buffers** an ACP tool call (bounded: 64 pending calls, 8 KiB each) and emits its `step` record once — at the first of: an update that supplies a target (`rawInput.command` for execute, under the command opt-in and redaction; else `locations[0].path` via `livePath`), status `in_progress`, or a terminal status (then `step` and `done` together). Fields from `tool_call` and later updates are merged in the buffer before that single emission; after emission, later target changes are not shown (the step keeps its first target). OpenCode's `ls -la` arrives with the first `in_progress` update, so it is shown. A call still buffered when the session ends is emitted as a `once` step. `completed`/`failed` → `done`, output from text `content` (only when the project shows commands, redacted as today). Records, `parseLiveRecord`, `applyWindow` and `projectLiveText` are unchanged; the step's time is its emission time.
- `agent_thought_chunk`, `available_commands_update`, `plan`, `current_mode_update`, `usage_update` → not shown.

## Steering

The provider-neutral mailbox, unchanged — builds are full access, so the agent can move acknowledged notes. Live interrupt-and-redirect (cancel + follow-up prompt) is a later item.

## Surfaces

- Providers screen / `toolroll providers`: a row per ACP agent — installed (realpath, version), check status (checked at … / changed since check / never), billing declaration, sign-in hint from `authMethods`, "Check this agent" (password) and "Revoke".
- Model pickers list only checked agents and their recorded models. CLI `--provider opencode --model …`.
- Profile prose: "OpenCode (via ACP) · opencode/big-pickle · full access inside the fence · no turn limit; stops after 60 min".
- `reviewEligible` and plan routing refuse ACP providers in v1.

## Layers (each a commit, each Codex-reviewed)

- **A. Protocol core**: `src/acp-client.ts` (framing, correlation, limits, method allowlist), `acpParse`, permission answers, terminal contract — pure. Tests from the sanitised real fixtures + synthetic faults (malformed line, oversized line, unknown response id, conflicting second response, error response, update-then-exit-0, stall).
- **B. Registry + profile + migration v124 + denial**: `acp-agents.ts`, provider ids, `agent-login`, every exhaustive and restated site, non-executing inspection + the no-exec architecture test, `AcpProfile` + `profileFromJson`, CHECK widenings incl. `phase_tier_alternate` and auth modes, the additive `run.agent_reported_usage_json` column, empty `acp_attestation`/`acp_billing`/`acp_probe_ticket`/`acp_probe_step` tables, `attestProvider` deny for ACP, CLI/route validation, key controls refusing ACP.
- **C. Gateway + runner + fence + billing**: `runAcpSession` (both clocks), custody/shutdown, `invokeAgent` branch, fence-required, env shedding, per-run billing stamp, gateway budget refusal, separate reported-usage column. Slow test: an in-repo fake ACP agent (node) driven through `invokeAgent` for success, every failure terminal, stall, stop mid-turn, descendant cleanup.
- **D. Live dialect** (buffered emission; no format change).
- **E. Attestation**: `GatewayLedger` split (run implementation unchanged), probe tickets + three ticketed steps + probe parent repo/linked worktrees, attestation writes + spawn re-check, probe spend in rollups, `toolroll agents check|revoke`, billing declaration, pre-claim skip, providers screen; DESIGN §9d rewrite; MODELS.md.
- Then: a live `agents check opencode` on this machine, end-to-end build of a toy task with OpenCode, Playwright proof of the providers screen.
- Later (not this arc): gemini onto ACP + retire stream-json; resume via `session/load`; live steer; per-agent API keys; review/plan routing; trusting `usage_update`; shipped ranges.

## Review ledger

Round 1 (v1):

1. Success without terminal → `promptConsumed` only from the end_turn response; full fail-closed list (§ Terminal contract).
2. Postures exceed the boundary → only `full` inside the fence; read-only runs refused (§ Profile, § Fence).
3. Identity lost / migration incomplete → per-agent provider ids; `phase_tier_alternate` added; grep-listed (§ Identity).
4. Attestation weak → absence denies; probe ticketed through the gateway; binding to runner, probe version, interpreter and package; recheck after async setup; 8 required checks (§ Admission).
5. Custody → runner returns after settlement; bounded shutdown; exit mapping (§ Gateway).
6. Billing conflated → separate declaration; gateway cap refusal; `usage_update` recorded, not trusted (§ Billing).
7. Profile terms → repair fields, no maxTurns, exact model, mailbox writable (§ Profile).
8. Live mapping → merged updates with retargeting (§ Live view).
Q5 → 429 is a negative fixture; fallback not restored.

Round 2 (v2):
1. Enumeration executes binaries → non-executing inspection everywhere outside the gateway + architecture test (§ Identity).
2. Ticket admission undefined → `acp_probe_ticket` bound to runner incarnation, executable, model, fixed recipe, workspace, limits, expiry; atomic consume in custody; probe pool root — superseded in round 3 by probe steps outside `run` (§ Admission).
3. Intermediate fail-open → denial ships in layer B; C's tests use the store seam; spawn re-check covers interpreter and package entry; argv uses attested realpath (§ Admission).
4. Billing attribution → versioned declaration, stamped on the run at budget admission, settlement reads the stamp; reported usage in a separate column (§ Billing).
5. Auth contract → `agent-login` AuthMode with CHECK widening; key controls refuse ACP; route union and setup registry in the inventory (§ Identity).
6. Clocks → seconds fields matching builder, both clocks passed and enforced by the runner, repair too (§ Profile).
7. Repeated steps → no format change: buffered single emission; kinds mapped onto existing ones (§ Live view).

Round 3 (v3):
1. Taskless probe vs `run.task_ref NOT NULL` → probes are not runs: `GatewayLedger` with run and probe-step implementations; probe spend joins budgets via its own rollup line (§ Admission).
2. Billing without model → declarations keyed by exact model; repair stamps its own model; gateway checks stamped model = selected model (§ Billing).
3. Standalone probe repo fails worktree validation → plane-owned parent repo + linked worktree per ticket (§ Admission).
4. One spawn can't prove both graceful and forced shutdown, nor `--version` → three ordered, separately consumed, bounded steps; attestation only after all pass (§ Admission).

Round 4 (v4):
1. Script launchers could escape the interpreter binding via `env` + child PATH → the gateway parses the shebang and spawns the attested interpreter explicitly; native launchers direct; PATH-switch, shebang-change and symlink-swap regressions (§ Admission).
2. Storage contradiction → one additive nullable `run.agent_reported_usage_json` column; no role widening anywhere (§ Identity migration list).


## Layer E, revised (v6)

Implementing A–D showed that the v4/v5 probe design — check spawns that are *not* runs, behind a `GatewayLedger`
interface splitting every durable write the gateway makes — would rewrite most of `invokeAgent` (session, version and
start stamps, fence and tools records, usage, terminal class, spend settlement, custody, stop watch, process
witnesses). v6 keeps every guarantee that design bought with a much smaller change: **a check is a real run of a real
internal task**, so all of those writes, the fence, the stop watch, the spend rollups and the live view apply
unchanged; the gateway gains exactly one admission exception, a single-use check request standing in for the
attestation the check is about to create.

### Where a check runs

- **The Agent checks project.** A plane-owned git repository `<state>/agent-checks` (made on first use: `git init`, one
  empty commit), registered as an ordinary project named "Agent checks". Each check files one built-in task in it,
  "Check OpenCode (opencode/big-pickle)", through `fileTaskProposal` with `filedVia: "agent-check"` — unapproved like
  every filing, so the queue never dispatches it. The check job drives it directly, as below. The task is visible
  like any other (its runs on the Agents board, live); it ends `done` or `failed`.
- **Who runs it: the runner.** `toolroll agents check <agent> [--model m] [--runner r]` and the providers screen's
  "Check this agent" are credentialed (password; approver) and only *request* a check: an `acp_check_request` row
  (id, provider, runner, model, `CONFORMANCE_VERSION`, requested_by, requested_at, expires_at = +30 min, state
  `pending|running|passed|failed|expired`, task_ref, result_json). The named runner's watch loop picks up its own pending
  requests at the start of a tick, before dispatch, so the check happens under that runner's custody and on that
  runner's binary — the attestation is per runner, and only the runner can prove the binary it will run.
- **The job, per request** (one at a time per runner):
  1. Claim the request: `UPDATE … SET state='running', claimed_incarnation=? WHERE id=? AND state='pending' AND
     expires_at > now AND runner=?` — zero rows, nothing happens.
  2. Inspect the PATH binary (acp-inspect.ts) and compute its launch (`launchOf`): the bound files are written onto the
     request (`launch_json`) in the same transaction as step 1's follow-up; a launch that can't be computed fails the
     request with its words.
  3. File (or reuse) the check task, place it in the Agent checks project, acquire its claim with the runner's own
     credentials (`acquire`, the ordinary claim), and lease a worktree from the ordinary worktree manager — the same
     pool, binding and fence as any build.
  4. Run the two check steps below, each an ordinary `startRun` (role `builder`, route `legacy` for the agent and model)
     and an ordinary `invokeAgent`, which admits it on the request instead of an attestation (next section).
  5. Release the claim and worktree; settle the task (`done` on pass, `failed` otherwise); write the request's result;
     on pass, record the attestation (`recordAcpAttestation`) **in the same transaction** that marks the request
     `passed`, binding the launch from step 2, the identity the handshake gave, the models it offered, and the checks.

### The gateway's one exception

`invokeAgent(…, { acpCheck: requestId })` — for an ACP provider with no live attestation only — admits the spawn when,
in one read immediately before the existing re-check position: the request is `running`, unexpired, for this
provider, runner, claimed incarnation and model; `run.taskRef` is the request's task; and the request's recorded launch
re-verifies (`verifyLaunch`). The spawn uses that launch and passes `expect: null` to the handshake (the check is what
learns the identity). Each step consumes a step slot: `UPDATE acp_check_request SET steps_used = steps_used + 1 WHERE
id=? AND steps_used = ? AND state='running'` with the expected index — so a request admits exactly its two steps, in
order, and nothing else. A check request never satisfies an ordinary build, and an attestation never satisfies a
check step (an architecture test: `acpCheck` is set only by the check job).

### The two steps and what they prove

1. **session-ok** — prompt: create `done.txt` containing `ok`, then run `printenv ANTHROPIC_API_KEY > env.txt` and
   `cat <canary> > fenced.txt` (`<canary>` a file the job wrote inside the fenced state folder), then stop. Launched
   with `ANTHROPIC_API_KEY=<random canary>` in the *launching* environment. Passes only if: the prompt answered
   `end_turn`; the agent then exited **on stdin EOF / session close without a signal** (the runner records how the
   process ended, below); `done.txt` contains `ok`; `env.txt` exists and does not contain the key canary; `fenced.txt`
   exists and does not contain the file canary. A missing `env.txt` or `fenced.txt` fails the check — absence of
   evidence is not isolation.
2. **session-stop** — prompt: run `sleep 120`. The job cancels after the agent's first tool update (or 10 s);
   passes only if the prompt answers `cancelled` within 15 s and the runner then reaped the group with nothing of it
   left (the runner records the reap and whether any member remained, below).

The models the agent offered (`session/new`'s list, on the success step) and the identity it gave (`initialize`'s
`agentInfo`) are what the attestation records; a later check of the same binary must report the same identity.
The `--version` step of v5 is dropped: the bound files' hashes are the identity; `agentInfo` is the agent's own claim,
recorded and required to match at every build's handshake.

### What the runner adds for this

`runAcpSession` appends two lines to the retained record: `acp.offered` (the model list, bounded) and `acp.exit`
(`how: "eof" | "term" | "kill" | "error"`, `leftovers: n` — members of the group still alive at the reap). The
parser surfaces both on the envelope (`agentOffered`, `agentExit`); `invokeAgent` returns the envelope's ACP facts on
the `ran` outcome for the check job only. Nothing else reads them.

### Billing (v6 keeps v5's model-scoped design, built here)

`acp_billing (provider, runner, model, kind 'metered'|'plan', revision, set_at, set_by)`, declared at check time
(default metered) and changeable (credentialed). The run stamp `(billing_kind, billing_revision, billing_model)` goes on
the run in `startRun`'s transaction for ACP runs — the moment it is admitted for budget — and settlement prices from
the stamp: `plan` → $0, "billed by <agent>'s own plan", counted as unmeasured coverage; `metered` → today's unknown-cost
rule. A check run is billed the same way as any run of its model.

### Surfaces

The providers screen and `toolroll providers` show each ACP agent's inspection, its live check (when, by whom, the
identity, the models) or none, a "Check this agent" form (model pick from the agent's own `--version`-free inspection is
impossible, so the form takes a model id; the first check may use the agent's default by naming it), the billing
declaration per checked model, and "Revoke". `toolroll agents check|revoke|billing`. DESIGN §9d rewritten.

### Review questions for v6

1. Is a real internal task/run for each check sound — anything in disposal, the queue, attention or spend that would
   treat it wrongly?
2. Is the request-as-admission exception tight enough (single use per step, runner incarnation, launch re-verified)?
3. Are the two steps' pass conditions free of false passes (model non-compliance reading as isolation)?
4. Is dropping the `--version` step acceptable given the bound hashes?


## Layer E, v7 amendments (answering the v6 review)

1. **Git hooks (P1, and older than ACP).** A lease's own git — branch creation and `worktree add`, run by Toolroll's
   process outside every fence — now runs hardened (`checkoutGit`, teardown-git.ts): hooks off, fsmonitor off, and a
   repository config that names a command refuses the lease with words, as teardown already does. The user's global
   git setup still applies. This closes it for every build, not only checks (commit "Leases: a checkout's git runs
   nothing the repository holds", with a test that a planted post-checkout and a config filter never run).
2. **No false passes (P1).** Isolation is proven by the plane, never by the agent's words or files:
   - For a check step, the gateway runs two **plane probes inside the exact fence and environment it is about to give
     the agent**, after the fence and child environment are built and before spawn: `cat <canary>` (a file the job
     wrote in the fenced state folder) must fail, and `printenv ANTHROPIC_API_KEY` with the launching environment
     carrying a random canary key must print nothing. Both results ride the outcome (`acp.isolation`); either failing
     fails the check. No agent involvement, so no compliance to fake.
   - **session-ok** passes only on: a `tool_call` of kind `edit` (or `execute`) the runner saw complete; the prompt's
     `end_turn`; the process ending on stdin EOF with nothing of its group left; and `done.txt` containing `ok`.
   - **session-stop** cancels only after the runner has seen an `execute` tool call reach `in_progress` (the job waits
     up to 60 s for it; none, and the step fails — never a pass by absence); it then requires the `cancelled` answer
     within 15 s and the group reaped. Whether a descendant was alive at the reap is recorded, not required (an
     agent's tool may run in its own group, which the custody observer covers as for every run).
3. **Budget (P1).** Each step passes the same gates dispatch applies before it spends: the monthly budget for the
   Agent checks project and installation (`budgetGate` in operate.ts, extracted and shared), runner capacity, and the
   per-run cap rule — a model billed `metered` with any cap in force refuses (`budget-unenforceable`), one declared
   `plan` doesn't. The billing stamp on each step's run is the same one settlement reads.
4. **Cancellation evidence (P1).** A refused outcome after a spawn carries the same ACP facts as `ran`
   (`acp` on the refused variant), so the check grades a `cancelled` step without relaxing what ordinary builds accept.
5. **Revocation during setup (P1).** Closed in c556ea56: the live attestation is re-read at the spawn boundary.
6. **Request fencing (P1).**
   - Claim is runner-wide exclusive: one statement — `UPDATE acp_check_request SET state='running', incarnation=?
     WHERE id=? AND state='pending' AND runner=? AND expires_at>? AND NOT EXISTS (SELECT 1 FROM acp_check_request
     WHERE runner=? AND state='running')`.
   - Recovery: at the start of every tick, a `running` request whose incarnation is not the runner's current one, or
     past `expires_at`, is marked `failed` ("interrupted") — its task failed, its claim and worktree released and
     discarded; nothing is attested.
   - Steps bind runs: `step1_run`, `step2_run` columns, each set by the same CAS that consumes the step slot
     (`… SET steps_used=1, step1_run=? WHERE id=? AND steps_used=0 AND state='running' AND incarnation=?`).
   - Completion is one transaction: `UPDATE … SET state='passed' WHERE id=? AND state='running' AND incarnation=? AND
     steps_used=2 AND step1_run=? AND step2_run=?` (exactly one row, else nothing) **and** `recordAcpAttestation`.
7. **Lifecycle (P2).**
   - The Agent checks repository is the runner's own: the job registers it in the runner's repo bindings
     (`runner.repos`, the ordinary binding `acquire` proves) when it first makes it.
   - The task is a bare built-in task (`createTask`, no scope, no plan), placed in that repository; admission is the
     `legacy` route for the agent and model, as for any scope-less task.
   - Run outcomes: a passed step finishes `failed` is wrong and `built` stamps first-success — so a step finishes with
     outcome `refused` and reason `agent-check` (no strike, no success, no disposal road); the task ends `done` (pass)
     or `failed` with the reason words. Nothing reads a check run as a build.
   - The check worktree is discarded after settlement: released and removed through teardown's hardened remove
     (`--force`), never kept dirty for a "next attempt".
8. **Re-checking (P2).** `acpCheck` admission applies whenever the option is present — an existing attestation for the
   same agent neither blocks nor satisfies a check; the new one replaces it only on a pass.


## Layer E, v8 (answering the v7 review)

1. **Lease git (P1).** `freshen()` now runs hardened too (f48ce902). The check-then-run race is closed at its root: no
   build can write the shared repository's `.git/config` or `.git/hooks`, nor its checkout's `.git` pointer, its
   metadata's `commondir`/`gitdir`, or a `config.worktree` git reads — read-only grants in every task boundary on every
   platform (7b5c4477, b10a8907, 0c1c3bbd), with any pre-existing second hard link to one refusing the launch
   (a3681934). The config check that remains guards only what was planted before.
2. **Cancellation is graded on plane evidence (P1).** The session-stop step passes only on facts the agent can't
   write: the runner's process-tree observation (`onDescendant`, as for every run's custody) records at least one
   descendant of the agent's process **before** the cancel is sent; after settlement every descendant the run
   witnessed is proven gone (`onDescendantExit`, or absent from a fresh process listing); and the prompt answered
   `cancelled`. The agent's `execute/in_progress` update only times the cancel; it proves nothing. No witnessed
   descendant within 60 s, and the step fails.
3. **Ownership and recovery (P1).** A request is owned by one watch: the claim records the claiming watch's lease
   (`watch_lease`, the same lease that admits its tick) beside the runner. Recovery treats a `running` request as
   abandoned only when that lease is no longer live (expired or released) or the request is past `expires_at`; it then
   proves the request's runs are finished and their processes gone (the run rows settled, the custody witnesses all
   exited) before it releases and discards the worktree — any doubt leaves the worktree for a person and fails the
   request. Ownership is proven again (lease still live and the claimer's) before each step's consume CAS.
4. **Publication (P1).** The final transaction requires, in one statement: `state='running'`, `expires_at > now`, the
   owning watch lease still live and the claimer's, `steps_used=2`, both bound runs finished with outcome `refused`
   reason `agent-check` **and** each step's verdict recorded as passed on the request (`step1_passed`, `step2_passed`,
   each written by its own CAS after grading). Exactly one row, or nothing — and `recordAcpAttestation` runs inside that
   same transaction, so an expired, stale or unproven request can never publish.


## Split out (2026-10-19, owner decision)

The git-fence class v7/v8 item 1 described — Toolroll's own git honouring hooks, config and gitdir pointers a build can
write, outside every fence — predates ACP and affects every agent. It moved to its own branch and PR
(`git-fence-hardening`, docs/plans/git-fence-hardening.md there), to be finished for all agents. ACP agents ship with
the same exposure every agent has today, no more; Layer E's design no longer depends on it.


## Layer E, v9 (answering the v8 review; the git items moved out, above)

1. **Cancellation is graded on a live witness (v8 #3).** The runner's control gains `liveDescendants()`: a fresh,
   plane-side reading, at the moment it is called, of the agent's live descendants — from a process listing of the
   agent's process tree when there is no native container, or from the container's own member list (the cgroup's
   `cgroup.procs`) when there is. Windows job objects give no member list: checks refuse on Windows ("agent checks
   need macOS or Linux"). The session-stop step polls `liveDescendants()` after the agent's `execute` update (which only
   times it) for up to 60 s; it cancels only once at least one live descendant is seen, recording exactly those pids.
   After settlement it passes only if the prompt answered `cancelled`, the run's process ending was the reap, and every
   recorded pid is gone (`kill(pid, 0)` → ESRCH) — or, under a container, the settlement proved it empty
   (`containment.empty === true`). An exited helper from earlier never counts: only what was alive at the cancel does.
2. **Native containment (v8 #4)** is covered by the same `liveDescendants()` reading (above); the observer is not needed
   for the check.
3. Items 3 (ownership and recovery) and 4 (publication) of v8 stand as written; the v8 review found them sound.
