# Agent Baseline hardening — plan

Status: **v2** (2026-10-21). v1 Codex review: NO-GO, 21 findings (12 High) — loopback and IPC escapes around the
network fence, plane-side Git running repository-controlled code unfenced, writable provider homes as persistence,
alternate lead approval routes, settled-spend caps, and an OSV gate that wasn't really fail-closed. v2 takes every one.
Five arcs, built and shipped in order, each its own PR, release check and deploy, each closed by one Codex
implementation review (no more plan rounds, by Alex's standing rule), with native adversarial tests as listed.

## Why

Agent Baseline's reference architecture (agentbaseline.org, v1 2026-10-13) puts four boundaries outside the agent —
sandbox, network, supply chain, identity and access — on "the agent proposes, policy authorizes, infrastructure
enforces". Toolroll holds the authorization half (password-sealed scopes and profiles, dispatch proof, approval rules,
merge on green at the exact head, the lead's tools as proposals, a hash-chained ledger). The gaps, in this plan's order:

1. A build agent can reach any host; a launch with no OS fence runs anyway.
2. The fence denies listed paths and allows every other write; plane-launched commands on build material (setup,
   checks, follow-ups, Toolroll's own git) run unfenced.
3. A lead token approves as its owner, on more than one road.
4. The ledger doesn't chain how a run was fenced or profiled.
5. Nothing checks what packages a change adds.

Controls named are Agent Baseline's (CON-03, AUT-05, …).

## Arc 1 — Network: the agent reaches only its approved hosts (CON-03, CON-04)

**Scope, said exactly.** This arc confines the *agent process tree* (Claude, Gemini, ACP agents; Codex's commands).
Plane-launched commands on build material are arc 2. Release notes and the run say which phases were confined.

**Prerequisite: an exec contract with no silent fallback.** Every spawn that runs agent or build-controlled code
declares `confinement: "required"`; `exec.ts` refuses it (never runs it unwrapped) when no backend applies, on both the
process-group and the plain branch (today the plain branch ignores fence options and the wrap silently skips). With
no OS fence (Windows; Linux without a working bubblewrap) a launch refuses — "This machine can't confine an agent:
install bubblewrap" — unless the instance operator sets `unfenced agents: allowed` (password, ledgered; every such run
says "Not confined"). Codex keeps its own sandbox for its commands.

**Policy, bound at approval.** A run's network is part of its sealed execution profile: `network: { version: 1,
mode: "allowlist" | "off" | "open", hosts: [...], loopback: "proxy-only" | "ports" | "any", ports: [...] }`. The
*effective* host list is resolved and snapshotted **when the scope is approved** — provider hosts from a versioned
catalog, registries from the manifests/lockfiles at the scope's base commit (read with hardened git, never the
checkout), plus the project's hosts — and that snapshot is what's digested and enforced. A launch never re-derives it
from current settings or agent-modified files. A legacy approval (no network field) is a deliberate narrowing: it runs
under `allowlist` with the provider + base-commit registries only, `loopback: proxy-only`, never widened by project
settings; the run says "Network: default (approved before network rules)". Admission refuses a worker that can't
enforce the profile's network version (runner capability, like attest). The strict profile parser keeps refusing
unknown fields. `open`, extra hosts and loopback ports are a project setting an approver changes with a password, shown
on the approval card; a mode never widens network.

**The proxy** — one per launch, in Toolroll's process, outside the fence, built from `scout-net.ts` with its defects
fixed: per-run authentication (a random secret in the proxy URL; another run's agent can't use it), CONNECT to ports
443/80 only, absolute-form HTTP requests whose `Host` must equal the URL's host, IP literals refused, structural IPv6
canonicalization (the expanded-NAT64 form is caught), no demo-URL exception for builds, public addresses only. Hosts are
exact or `*.suffix`, matched before resolving. It never decrypts TLS, so it restricts destinations, not methods or
uploads to an allowed service — said in SECURITY.md. Counters are *proxy connections* and *proxy refusals* per host,
capped at 50 hosts + "others", phase-labelled.

**Environment.** After env filtering: `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY` and their lowercase forms, `NO_PROXY`/
`no_proxy` = `localhost,127.0.0.1,::1` only when loopback is allowed, and `NODE_USE_ENV_PROXY=1`. A program that
ignores them is refused by the OS.

**macOS (Seatbelt).** `(deny network*)` for outbound IP, then `(allow network-outbound (remote ip "localhost:<proxy>"))`
and the run's broker port — **remote** filters only (a `local ip` filter admits arbitrary outbound; IPv4-mapped
loopback handled). Loopback beyond that only as the profile says (`ports` list, or `any` with the approval card saying
"local services reachable"). Unix-socket connects denied except the run's broker socket. **Delegation closed:**
`mach-lookup` denied for the services that act outside the sandbox — Launch Services (`open https://…`), Apple Events
(`osascript`), `nsurlsessiond` (background URL sessions), the DNS service (`com.apple.dnssd.service`: name lookups are
a data channel; the proxy resolves), pasteboard — from an audited list checked natively on the release machine.
Inbound bind on loopback stays allowed (dev servers).

**Linux (bubblewrap).** `--unshare-net --unshare-pid --proc /proc` (own loopback, own process view), host runtime and
socket folders masked (`/run/user/<uid>` with D-Bus, `/var/run/docker.sock`, `/run/docker.sock`, `/tmp/.X11-unix`, the
podman/containerd sockets), and two bridges Toolroll starts as the wrapper from a path the agent can't write: the
egress proxy and the tool broker, each a unix socket bound read-only into the namespace and forwarded to the
namespace's 127.0.0.1 — never a general host relay. The availability probe runs the complete configuration.

**Codex.** Auto stays offline. Full access turns its command network on only for a sealed `open`; otherwise Codex's
commands are offline and the run says why. Codex's harness talks to OpenAI outside its command sandbox, as today.

**Seen on the result.** "Network: 41 proxy connections to 3 hosts; refused: example.com. Add hosts in Project →
Network. (Connections the OS blocked outright aren't counted.)"

**Native adversarial tests** (macOS on the release machine, Linux in CI): direct TCP/UDP to a public IP fails; DNS
lookup of an arbitrary name fails; `open https://example.com` and `osascript` delegation fail; an allowed host through
the proxy works, a refused one gets 403; two simultaneous runs with different grants can't use each other's proxy;
loopback to a server outside the sandbox fails under `proxy-only`; Docker/D-Bus sockets unreachable on Linux; a
`Host`-header mismatch is refused; a legacy approval runs narrowed. Real-provider compatibility: the release check's
real-model journeys run under the proxy (Claude, and Codex where present), so a provider that ignores the proxy fails
the release, not a user's build.

## Arc 2 — Writes and plane-launched code (CON-03)

- **Plane Git on build material runs fenced or hardened.** Every git call on a build checkout goes through one helper:
  repository identity re-proved from trusted records right before use (`trustedWorktreeBinding`), `HARDENED_GIT_ARGS`
  plus `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, no hooks, fsmonitor, external diff or credential
  helpers, no submodule recursion. Operations that can execute repository-controlled code (`add`/`status` run clean
  and smudge filters from `.gitattributes` and repository config) run **inside the build's fence**. The agent loses
  write access to the repository's shared `config`, `info/attributes` and `hooks`.
- **Writes become an allowlist** in every mode, Full access included (Codex/OpenRouter's `"/" = write` goes too): the
  worktree and its git metadata grants, this run's temp and child-database folders, `/dev/null` and friends, run-owned
  cache homes (`npm_config_cache`, `PIP_CACHE_DIR`, `GOMODCACHE`/`GOCACHE`, `CARGO_HOME`, `XDG_CACHE_HOME`, pnpm store),
  kept per project (one trust domain) and never used by trusted plane tools, and a **per-run provider home**
  (`CLAUDE_CONFIG_DIR`, Codex's run home as today, Gemini's equivalent) seeded from the operator's, with sign-in state
  passed the way the provider supports and settings, hooks, plugins and MCP configuration read-only. The operator's own
  `~/.claude`, `~/.claude.json`, shell profiles and LaunchAgents become read-only to builds. Proven natively first:
  clean start, resume, sign-in refresh, git operations, a representative npm/pip/cargo install; if a provider can't
  run from a per-run home, the grant is narrowed to the exact files it rewrites (literal paths and their atomic-rename
  temp names), never its whole home.
- **Setup, check, follow-up and batch commands run in the build's fence** (filesystem, and arc 1's network) through
  the exec contract. Batch checks group only results whose sealed policies match, and get a trusted binding for their
  temporary checkout.
- **Tool servers stop executing workspace bytes.** The broker starts a tool server with a trusted working directory
  (the tool's own folder), refuses a command that resolves inside the workspace or a build-writable cache, and the
  server gets its own declared network policy instead of sharing the agent's.
- **Docs** (README, SECURITY.md, docs/guide/security.md) generated from one table in code (`fenceSummary()`), with a
  test that they match.

**Measured before building (2026-10-22, Claude Code 2.1.290, macOS):**
- A per-run `CLAUDE_CONFIG_DIR` loses the subscription sign-in: Claude keys its keychain item by the config folder
  ("Claude Code-credentials-<hash>"), and copying the credential would let a build's refresh rotate the operator's
  token. So Claude keeps its home, narrowed: a full build (edits, Bash, git) runs with **only** the worktree, the run's
  own temp folder (`TMPDIR` and `CLAUDE_CODE_TMPDIR`, which moves Claude's own working folder out of the shared
  `/tmp/claude-<uid>`), and its own transcript folder `~/.claude/projects/<worktree as a slug>` writable;
  `~/.claude.json`, settings, hooks, plugins, `shell-snapshots` (sourced by interactive sessions), other sessions'
  transcripts, `backups` and `cache` read-only; and `~/.claude/sessions` (live sessions' peer keys) unreadable.
- Gemini writes `~/.gemini/{projects.json and its temp names, history/, tmp/}`; its `settings.json` (MCP servers)
  stays read-only.

**Native tests**: Full access can't write `~/.zshrc`, `~/Library/LaunchAgents`, `~/.claude/settings.json` or the repo's
`.git/config`; a `.gitattributes` clean filter planted by the agent runs fenced (can't read the state folder) when the
plane commits; a check command can't read the fenced state folder; a tool server configured as `node ./server.js` is
refused; the provider journeys above pass from a per-run home.

## Arc 3 — The lead approves only within a grant its owner set (AUT-03, AUT-05, AUT-08)

- `toolroll lead token` (password, as today; a lead token can't mint one) gains the grant: `--may propose` (default:
  the lead files, plans and asks; approvals wait for you) or `--may approve --projects a,b --per-task-usd 5 --daily-usd
  20 [--days 7]`. Stored with the credential, sealed (digest), shown in Settings → Lead, expiring (≤ 7 days).
- **One authorization primitive.** The lead travels as a typed principal (credential id + grant digest), not as its
  owner, into every sealing road: `task approve`, `task scope`'s mode seal, chat approvals, sweeps, planning, repair
  and the protected-work vote (a lead never votes). Each re-authenticates after any await and inside the sealing
  transaction, as `approve()` already does.
- **Caps are reservations.** A lead approval reserves the scope's budget × its attempt allowance (retries and repairs
  of the task count against the same reservation) against the owner's lead-day ledger, atomically, pending plus
  settled; unknown-cost runs reserve the cap. Re-minting never resets it; the day is the owner's local day. Grant
  liveness (expiry, revocation) is re-checked at dispatch, like a mode's, so a queued lead approval doesn't outlive its
  grant.
- Out of grant → not refused: a **Needs you** approval for the owner (their password), with the lead's reason. The
  seal records kind `lead` with the grant digest: "Approved by your lead (within its grant)".
- Upgrade: existing lead tokens become `propose` until re-minted with a grant (one command; said in the release note
  and on Settings → Lead).

**Tests**: each road refuses an out-of-grant lead (direct approve, `task scope` under a hands-off mode, chat, sweep);
twenty concurrent $5 approvals against $20/day seal four; expiry between approval and dispatch stops dispatch; a lead
never satisfies a protected path's second person.

## Arc 4 — The record: launches chained, checkpoints anchored off the machine (OBS-01/02/06)

- **`run_launch`**, a new append-only table: a versioned JSON payload (provider, model, scope and profile digests, the
  effective network snapshot, fence method and the digest of its paths and grants, tool **spec digests**, checkout
  head, phases confined). Written in the transaction that stamps the provider start; the ledger entry `run-launched`
  carries the payload's digest (fits the 300-character detail), so the chain covers it. A spawn that then fails records
  `run-launch-failed`; `run-ended` (in `finishRun`'s transaction) records outcome, the frozen proxy counters (phase-
  labelled, "incomplete" after a crash) and the diff hash. The evidence pack shows them.
- **Anchors.** Monitoring already exports sealed events and hourly checkpoints after delivery: extend it with a
  checkpoint at every release deploy and on idle, and report the last *delivered* anchor in status. A folder stream is
  labelled local unless marked as independent storage. `toolroll ledger verify --anchor <file>` recomputes the chain
  and compares the external anchor.

**Tests**: payload digest in the chain; editing `run_tool.tools_json.fence` or `run_launch` breaks verify; a spawn
failure and a crash are recorded honestly; an anchor verifies and a rewritten history fails it.

## Arc 5 — Packages: a publication gate on what a change adds (VAL-03, RES-05)

Honestly named: this gates **landing**, not installation (an install script runs before any scan; arcs 1–2 confine
it).

- **Inputs** read by the plane at exact commits with hardened `git cat-file`, never the checkout's parsers or hooks:
  manifests and lockfiles across the whole task (task base → candidate head): package-lock/npm-shrinkwrap, pnpm-lock,
  yarn.lock, Pipfile.lock/poetry.lock/uv.lock/requirements pins, Cargo.lock, go.mod + go.sum, Gemfile.lock. Added and
  changed packages, plus changed `resolved` sources and integrity hashes for an unchanged name/version. A manifest
  change with no lockfile change, a deleted lockfile, an inconsistent pair or an unsupported ecosystem → **unverified**.
- **OSV**: `querybatch` for IDs (every page consumed, result count checked), then each advisory fetched for severity
  (CVSS vector or the ecosystem's severity; unevaluable → unverified). `MAL-` advisories and critical severity block;
  high/medium and versions published in the last 72 hours are findings. Any failure — network, rate limit, schema,
  truncation — is **unverified**, never an empty list.
- **Binding**: the result is keyed by repository, task base, candidate head, a digest of the dependency inputs, and the
  policy version; a revision, replacement candidate or batch gets its own. The gate holds in completion/readiness and
  in every publication road (merge sweep, automerge). Blocked or unverified needs a verified person's exception with a
  reason, bound to the exact findings — a lead token never satisfies it. Package severity is its own readiness
  category, separate from review `HIGH` findings.
- **Recorded**: inputs, policy version, advisory IDs and their modified times.

**Tests**: a `MAL-` package blocks; a critical CVE blocks; manifest-only change, deleted lockfile, integrity change and
unsupported ecosystem are unverified; OSV down, paginated and malformed responses are unverified; an exception binds
to its candidate and doesn't carry to a revision; a lead can't accept.

## Out of scope (said so in SECURITY.md)

Per-action authorization inside a build; sender-constrained credentials (AUT-09); anomaly detection across runs
(OBS-03/04); a component blocklist across agents (RES-02); TLS-inspecting egress (method/upload control); scanning
before install scripts run; a signing key for the ledger (off-machine anchors are the proof).

## Arc 1 as built (2026-10-21)

Where the build departs from the text above, and why:

- **Loopback on macOS is all or none.** Seatbelt admits a local port an allow names whatever a later or narrower deny
  says (checked natively: deny-after-allow, `require-not` and `remote tcp` all fail), so "any local service but
  Toolroll's own and the proxy/debugger ports" can't be enforced. The setting is `proxy-only` (the default: the run's
  proxy and broker only) or `any` (every local service, an approver's explicit choice, said on the approval card).
  Linux builds have a loopback of their own either way.
- **Ecosystems are read from the project's own folder** (a bounded walk, no process started), not with git: filing a
  scope must start no process (the demo promises none), and the registered checkout is outside every build's reach.
- **Modes are `allowlist` and `open`.** A launch nothing sealed (a planner, a check) gets its provider's hosts only;
  a scout keeps its public-web proxy and browser as its only reachable ports (`via`).
- **Tool servers** keep their own reach for now (arc 2 gives them a trusted working directory and a policy of their
  own); the agent's network rules never apply to them.
- **Linux builds get a private /tmp** (tmpfs, their checkout, launch folder and Git data bound back): every socket in
  /tmp and every other run's folder is out of sight, with no check-then-mount race.
- **Codex review: four rounds** (7 findings → 4 → 4 → GO). Deferred to arc 2 with Codex's agreement: a symlinked or
  absent `~/.docker` (and the other per-user engine folders) — arc 2 must handle existing link targets as well as
  planted links and folders made later, once builds can't write the home folder; Goose needs its model host named
  (fails closed). Known: a long-running Linux build can see a later run's launch folder outside /tmp (arc 2).
- Natively proved: macOS (Seatbelt) and Linux (Ubuntu 26.04, bubblewrap 0.11) attack tests, and a real Claude build
  whose eight connections all went to api.anthropic.com through its proxy (its Datadog telemetry refused).

## Arc 2 as built (2026-10-22)

- **A setting, not a mandate.** Where builds write is per project and sealed per approval like the network:
  `workspace` (the default for new scopes) or `anywhere` (outside the fence, as before). Approvals sealed before
  write allowlists keep `anywhere`, as they were approved. Settings → Project → Where builds write, `project writes`.
- **Claude keeps its home, narrowed** (measured): writable are its checkout, the run's temp (`TMPDIR`,
  `CLAUDE_CODE_TMPDIR`) and its transcript folder for this checkout (by exact name; a shortened name only with
  Claude's `-<hash>` suffix); `~/.claude/sessions` is unreadable. Gemini: history, tmp, and projects.json with its
  atomic-rename names. ACP agents: only known data folders (OpenCode's and Goose's ~/.local/share|state roots,
  Qwen's history and temp); their configuration stays read-only whole, and Cursor and Cline write nothing of their
  own until measured (a project using them chooses `anywhere`). Proved with a real Claude
  build: edit, commit, and a refused `~/.zshrc` append.
- **Git data: only what a commit writes.** objects, refs, logs and packed refs of the shared repository plus the
  worktree's own folder; never config, hooks, info, `objects/info` (alternates), other worktrees' data or modules.
  The worktree's `config.worktree` is made empty and held read-only (so a Linux bind exists).
- **Codex:** a workspace build's profile extends `:read-only` with the allowlist written back (its `:workspace` also
  writes the shared temp folders, which an explicit read entry doesn't override).
- **Linux:** a read-only root, a /dev and /tmp of its own, the allowlist bound back. Proved in Ubuntu 26.04
  (bubblewrap 0.11). A file granted by prefix is bound only when it exists, so Gemini's projects.json is written in
  place, not renamed over (residual).
- **Plane-launched code, by a different route than the plan said.** Rather than running the plane's `git add`/`status`
  inside the fence, the plane's Git on a build's checkout runs teardown's hardening (no hooks, fsmonitor, ext,
  credential helpers, maintenance; submodules ignored) and refuses a checkout whose local or worktree config names
  a command. Under `workspace` a build can't write that config at all; under `anywhere` the refusal holds. The
  operator's own global config (identity, git-lfs) still applies.
- **Setup, check and observation commands** run in the build's fence (filesystem and writes) with a temp folder of
  their own (`so-cmd-*`) and the project's caches; their network is unchanged (follow-up: route them through a run
  proxy too). Batch checks are not yet covered.
- **Tool servers** start in the operator's home folder, not the checkout, and are refused (as the tool's answer)
  when their command, a path argument, a flag's value or any text in an argument names the checkout or caches, or
  is a relative path. Their own network policy is a follow-up.
- **Docs:** README's fence table is `FENCE_SUMMARY` in code (a test holds them equal).
- Review: three background security reviews during the build (whole common Git dir writable; prefix grant too wide;
  submodules entered; tool-path parser differential and case folding) — all fixed with tests.

## Order and shipping

Arc 1 → 5. Each: build → full unit + slow + scripted journeys + the native adversarial tests above → one Codex review →
PR → CI → merge → release check → deploy to :4180. Arcs 1 and 2 change what builds can do: the release note and the
run itself say what a project may need (hosts, loopback ports, `unfenced agents` on machines without a fence).
