# Codex and OpenRouter builds in the macOS sandbox (network parity)

Status: built 2026-11-22 (branch fix/codex-os-fence); live run of the failed task pending deployment. Owner decision (Alex): "match the experience for codex, openrouter and any others so we
fix the network issue." Supersedes sandbox-parity.md's "Codex terminals keep Codex's own sandbox" for pipeline
launches on macOS.

Update (2026-11-25, security review C2): the exact sign-in and sessions grants below are gone. A Codex or OpenRouter
build's own CODEX_HOME now holds a copy of the operator's `auth.json` (a refresh stays in the copy; nothing is written
back) and only its task's sessions, kept between that task's launches in `<state>/codex-sessions/` (denied to every
launch) and copied out after the run as plain files proven to be inside the launch's folder (`provider-home.ts`).
Nothing in the operator's `~/.codex` is granted to a build. If Codex asks the operator to sign in again after a build
refreshed its token, `codex login` fixes it. A task's folder is named for its database's workspace id and the task's
row id (never reused), and each Codex launch first removes the kept sessions of closed tasks and of any earlier
database there. Test: `test/attacks/codex-home-sessions.test.ts`.

## Problem

A project's **Network & Local Services** settings (local services on, allowlisted hosts through the run proxy) reach
Claude, Gemini and ACP builds, which run inside Anthropic's sandbox runtime (`macos-sandbox`). Codex and OpenRouter
builds run in Codex's own permission profile (`codex-profile`, `codexFenceArgv`), which:

- ignores `grants.network.loopback` (local services) and `grants.browser`;
- turns networking on only for Full access with an open network, so every other Codex command is offline;
- can't say "local listeners yes, internet only through the proxy": verified on codex-cli 0.170 (`codex sandbox`):
  `network.allow_local_binding` alone still EPERMs; adding `network.enabled=true` lets the listen through but also
  opens example.com, with or without `proxy_url` / `mode="limited"`.

Symptom: Vite prerender `listen EPERM ::1:3000` and Chrome aborting on Codex builds, while the settings sheet says
local services are allowed.

## Spike (done, macOS, codex-cli 0.170, ChatGPT sign-in)

Real `codex exec --dangerously-bypass-approvals-and-sandbox` spawned through `sandboxedSpawn` (Toolroll's fence, the
run's egress proxy for `PROVIDER_HOSTS.codex`, `loopback: "any"`, isolated CODEX_HOME via `isolatedCodexHome`):

| Extra grant | Result |
|---|---|
| none | harness TLS fails ("workspace routing discovery failed"); proxy counted 60 CONNECTs to chatgpt.com |
| `machLookup: ["com.apple.trustd.agent"]` | turn completes; `::1` listen **OK**; `fetch(example.com)` **blocked** at the proxy |

Codex verifies TLS with the platform verifier (trustd); `signInGrants` already grants trustd for the same reason.
Non-fatal refusals seen: `*.oaiusercontent.com`, `ab.chatgpt.com` (left out of the allowlist on purpose).

## Design

One fence for every agent on a Mac: Codex and OpenRouter run **inside the macOS sandbox with Codex's own sandbox
off**, as Claude runs with its bypass mode inside it. The OS fence then enforces the same paths, proxy,
local-services and write allowlist for every provider. `codex-profile` stays as the fallback where no OS fence works
(Linux, in this change) and for interactive Codex app-server sessions.

### Changes

1. **Fence method** (`invoke.ts fenceMethod`): codex/openrouter → `macos-sandbox` when `macosFenceAvailable()`,
   else `codex-profile` (unchanged off macOS). `containment.fence` follows automatically.
2. **Codex argv** (`provider.ts codexArgv`): new `Invocation.fenceMethod`. Under `macos-sandbox` the inner sandbox is
   off (`--dangerously-bypass-approvals-and-sandbox`) instead of `codexFenceArgv`. Fail closed: the bypass is
   emitted only when `fenceMethod === "macos-sandbox"` *and* the invocation carries a non-empty fence; the spawn
   path must also carry the same fence as `wrap` (`confinement: "required"`, which already refuses an unwrapped
   spawn). Review phase unchanged.
3. **invoke.ts `codexHarness` branches** become "Codex in its own profile" (`fenced.method === "codex-profile"`):
   - `runFence(... ownTools)`: pass the launch folder like Claude (tool-launcher files are read inside the sandbox;
     they hold only the broker address and token, as Claude's `mcp.json` does).
   - the fence extension adding `ownTools` + `codexHome.dir` as *denies*: only for `codex-profile`.
   - the offline `grants.network` override: only for `codex-profile`.
   - the proxy/broker/runTemp block (`!codexHarness && confinedOs`): every `confinedOs` launch, so Codex gets the run
     proxy, `brokerPorts`, socket roots, `TMPDIR` and `proxyEnv` (`loopback` from the sealed policy).
   - the pre-launch Git probe: `codex sandbox` only for `codex-profile`; otherwise the same OS-fence probe as Claude.
   - `fenceMethod` must be decided before `adapter.argv(buildInvocation)` so the argv matches the wrap.
4. **Codex's own state inside the fence** (`agent-fence.ts`):
   - `PROVIDER_HOME.codex/openrouter` stay `[]`: `~/.codex` stays denied under policy v1 (its `config.toml`,
     rules and plugins would be persistent injection). Grant **exact** paths instead, from Toolroll's own resolution
     of the operator's Codex home (`codexHomeDir`, never the build's env): the run's isolated CODEX_HOME folder
     (write), the `auth.json` it links to (read + write: token refresh writes through the link), and the real
     `sessions` folder (write). Under policy v2 home is readable anyway; the same writes apply.
   - `writeAllowlist` gets a codex/openrouter branch with those writes for workspace-only builds.
   - `homeWriteDenies`: `OWN_SIGN_INS.codex = OWN_SIGN_INS.openrouter = [".codex/auth.json"]`-equivalent so only
     that file is given back, mirroring Claude's own credentials file. `config.toml` stays write-denied.
   - macOS mach: `com.apple.trustd.agent` for codex/openrouter build grants.
5. **Project tools** (`project-tools.ts secretToolRefusal`): refuse codex/openrouter only under `codex-profile`;
   under `macos-sandbox` they get Claude's rule. Verify the stdio tool-launcher reaches the broker port through the
   fence (Codex gives MCP servers a minimal env; confirm no proxy variable routes `127.0.0.1` via the proxy).
6. **Docs and copy**: `fenceSummaryMarkdown` / `docs/guide/security.md` "What an agent can reach" (a test holds them
   equal); `PROVIDER_HOSTS` and `PROVIDER_HOME` comments; `agent-fence.ts` header; settings copy that says Codex
   commands are offline; sandbox-parity.md pointer; `CHANGELOG.md`.

### Residual (accepted, same as Claude)

Codex's commands share its process sandbox, so a command can read the Codex sign-in (`auth.json`), as a Claude
build's commands can reach Claude's keychain item. It stays inside the run's network allowlist (it can only be sent
to OpenAI hosts, through the proxy). Today the harness itself runs unsandboxed; the new posture fences it too.

### Out of scope

- Linux: Codex under bubblewrap needs the proxy relay ports and was not spiked; it keeps `codex-profile`.
- Interactive Codex app-server sessions (`coding-provider.ts codexFenceConfig`): never had a network; unchanged.
- Chrome in **build** steps: builds never get `grants.browser` on any provider (only checks and approved flows).

## Tests (TDD; real sandbox where it applies)

Unit (`npx vitest run` on the touched files):
- `fenceMethod`: codex/openrouter → `macos-sandbox` when available, `codex-profile` otherwise.
- `codexArgv`: bypass only with `fenceMethod: "macos-sandbox"` and a fence; `codexFenceArgv` otherwise; review same.
- grants: codex writes exact (no `~/.codex` folder, no `config.toml`), trustd present; `homeWriteDenies` keeps
  `config.toml` denied and gives back `auth.json` only to codex/openrouter.
- `secretToolRefusal` table: codex under each containment.

Native (real `sandbox-exec`, positive controls):
- A codex build's terms: `::1` listen OK with `loopback:"any"`, EPERM with `"proxy-only"`; direct `example.com`
  refused; `~/.codex/config.toml` unwritable; `auth.json` readable; Toolroll's state canary denied.

Live: after deploying, rerun the failed task's Build on Codex; `pnpm build` (prerender listen) passes and the run's
fence stamp says `macos-sandbox`.

## Rollout

Typecheck, the touched test files, `npm run test:attacks`, build, then the normal verified update of the running app
and worker (drain, backup, health). Commit with the safety self-review in the message.

## Critic review (folded in, 2026-11-22)

- **Codex's isolated home is a run folder** (`so-codex-*` is in `RUN_FOLDER_PREFIXES`), so the OS fence read- and
  write-denies it. `RunFolders` gains `codexHome` (its real path), allowed to read and write like `own`; a resumed
  attempt gets its new folder the same way. Native test: `codex` reads and writes its home under `srtTermsOf`.
- **Exact sign-in paths, inside the `.codex` denies**, the way `signInGrants` does it: the real path of the
  `auth.json` link target (read + write) and the real `sessions` folder (write). `.codex` stays read-denied (v1) and
  write-denied (v1 and v2); no `OWN_SIGN_INS` name exception (that would give back `config.toml`). Tested on both
  policies. Token refresh writes through the same link as today (the harness ran unsandboxed with this same
  isolated home); the only new requirement is that the sandbox permits that write.
- **Ordering**: one `fenceMethod` result decides `containment`, the argv and the wrap; `fenceLaunch` moves above
  `adapter.argv`. Test: probe unavailable → `codex-profile` argv, never the bypass.
- **Launch-folder token**: the broker enforces research steps' read-only actions server-side (`tool-broker.ts
  limitList`), so a command that reads the launch file gets exactly the tools Codex itself has: Claude parity, listed
  under Residual.
- **Stale copy and tests to update**: `egress.ts codexCommandsOffline`/`networkWords`, the `agent-fence.ts` header,
  `FENCE_SUMMARY` with `docs/guide/security.md`, `tool-broker.test.ts:356`, `agent-fence.slow.test.ts:520`,
  `mcp-connect.test.ts:575`.
- **`secretToolRefusal`** relaxes only with a native test that a fenced build can't read a tool server's
  environment (as for Claude).
- **Extra residuals**: the build writes the real `~/.codex/sessions` (other threads' rollouts too; Claude's is one
  project folder) and may overwrite `auth.json` (sign-out or a planted token), all inside the run's allowlist.
- **Live checks**: a resume, an OpenRouter launch, and the full failed task, not only one turn.
