# Plan v2: fence at parity with Anthropic's sandbox-runtime (srt)

Sources: Toolroll `~/Developer/so-access` @ af114bca (0.9.69 candidate); srt @ c66fb77 (v0.0.81).
Citations: `af:` src/agent-fence.ts, `inv:` src/invoke.ts, `mac:` / `lin:` / `mgr:` / `su:` srt's src/sandbox/{macos-sandbox-utils, linux-sandbox-utils, sandbox-manager, sandbox-utils}.ts, `seccomp.c` srt's vendor/seccomp-src/seccomp-unix-block.c.
Inputs: v1 of this plan, the Codex review of v1 (findings 1–12, all folded in below and tagged [C#]), and the owner's binding decision.

## 0. What changed from v1

- **The target is now parity with srt, in both directions.** Where srt is stronger, we adopt it. Where we're stricter than srt in ways that block features, we relax to srt.
- **Toolroll keeps only the isolation srt has no concept of, and only where it protects Toolroll's own integrity:**
  - its state;
  - other runs and other tasks;
  - the approval-sealed per-run network;
  - its own install.
- **Phase 1 (0.9.70) hardens the current engine to the srt baseline.** That hardened engine becomes the comparison baseline [C, recommendation].
- **The srt backend becomes a gated prototype** with:
  - one exact revision and an extraction manifest [C11];
  - an async prepared-launch boundary [C9];
  - typed permissions instead of free-form SBPL/argv hooks [C4];
  - engine, policy and helper pinned per attempt [C8].
- **v1's "six small patches" estimate is withdrawn.**
- **The openat sign-in helper is dropped.** Sign-ins become direct read grants evaluated by the sandbox itself, so nothing privileged reads or copies a sign-in file (§1.3).

## 1. Target policy

### 1.1 Adopt from srt (stronger)

| Item | srt reference | Toolroll today |
|---|---|---|
| Deny-default macOS baseline: process, mach, sysctl, iokit allowlists | mac:1083–1250 | `(allow default)` af:825 |
| Apple Events and Launch Services (`appleevent-send`, `lsopen`) denied in every mode | mac:1122–1133 | Denied only under an allowlist network (af:889–890) |
| Linux `--new-session`, `--unshare-pid`, `--proc` always | lin:3611, 3810, 3833 | Only under a confined network (af:986) |
| Linux seccomp: AF_VSOCK, io_uring_setup/enter/register, and the namespaces filter | seccomp.c:196–250 | None |
| Mandatory in-checkout write denies | su:21–50, mac:103–135: `.gitconfig .gitmodules .bashrc .bash_profile .zshrc .zprofile .profile .ripgreprc .mcp.json`, `.vscode .idea .claude/commands .claude/agents`, `.git/hooks`, `.git/config` | Only the shared repo's config, hooks and info (af:435) |
| Fail closed when confinement is unavailable | — | Partly. Flows don't [C5]. |
| Violation recording | mac:1627; linux-violation-monitor.ts | None |

### 1.2 Relax to srt (stricter today, and it blocks features)

- **Home reads open by default.**
  - Drop the default by-name read denies: `HOME_CONFIGURATION` (af:220), `homeNames` (af:250), and Claude's file-tool home rules.
  - Projects get an opt-in, approval-sealed `readDeny` list. This is srt's `denyRead`.
- **Reads of sibling repositories and of the project's primary working tree open.** Today `taskBoundary` denies both (af:265–292).
- **Same-sandbox process interactions as srt does them.**
  - Allowed within the same sandbox: `process-info*`, `signal`, `mach-priv-task-port` (mac:1091–1093).
  - Toolroll denies the task port entirely today (af:867). Relax.
  - `kern.procargs` stays unreadable. It isn't on srt's sysctl allowlist either.
- **Directory metadata:** accept srt's `(allow file-read-metadata (vnode-type DIRECTORY))` (mac:929). Q7 is decided, which overrides Codex's "patch it".
- **Sign-ins level returns, srt-style (§1.3).**

### 1.3 How sign-ins work, and why there's no helper

- The check reads its exact sign-in files itself, through the sandbox:
  - `~/.claude.json`, `~/.claude/settings.json`, and on Linux `~/.claude/.credentials.json`;
  - `~/.config/gh/{hosts,config}.yml`;
  - `~/.codex/{config.toml,auth.json}`.
- The kernel resolves those paths *inside* the sandbox's view. A link planted at a sign-in name and pointing into Toolroll's state resolves to a denied path:
  - Seatbelt checks the resolved vnode's path;
  - bwrap resolves it within its mount namespace, where the state is masked.
- **So the read is safe by construction.** No privileged read happens and no copies are made. `readGrantedFile` (af:1145), the Codex home copy (inv:1256–1261), `sign-in-copies` and `signInCopiesRoot` (af:1184) are all removed.
- **The openat helper is unnecessary, because nothing copies any more.** The privileged-copy race behind Codex's [C6] protocol concerns no longer exists. Builds keep their own provider-home linking (provider-home.ts:76), which is unchanged and is not a sign-in read.
- With home reads open, a plain **sandboxed** check can already read these files unless the project's `readDeny` covers them. The check-access words must say so plainly.
- **What "sign-ins" adds:**
  - It pierces `readDeny` for exactly those files: Seatbelt `literal` allows after the deny on macOS; on Linux, masking the siblings one by one rather than binding by path, so nothing is bound from a path that might be swapped.
  - It grants writes to Claude's transcript `.jsonl` files on macOS, as before (af:855–858).
  - It grants writes to measured Codex `sessions`/`log` folders, never `config.toml`.
  - `CODEX_HOME`, `GH_CONFIG_DIR` and `XDG_CONFIG_HOME` point at the real folders.
- **Residual on Linux:** a sibling created after launch inside a `readDeny` folder that was pierced stays readable until the next launch. That's the same residual `flattened` has today (af:728–740).

### 1.4 Kept, because each protects Toolroll's own integrity

| Kept | Integrity reason | Limits features? |
|---|---|---|
| State folder, database and journals, `~/.toolroll` (and older names), `up-login.txt`, tokens, evidence, backups, monitoring stream, console run folder, `bridge-secrets` (af:131–215): read and write denied | A run that reads the approver login, coordinator or runner tokens, or the database can approve or alter its own work | No |
| Other runs' launch folders by prefix pattern (`so-tools-` and the rest, af:327, 846) | They hold other runs' broker tokens and tool configs | No |
| Checkout pools: denied, own checkout given back; other tasks' Git metadata read-only (af:548–585, 296–315) | One task must not tamper with or pre-read another task's result before review | **Slightly:** a build can't read a sibling task's in-progress checkout |
| Write deny on every registered project's primary working tree (reads now open) | Landing and merging happen there; a planted file would ride into a later commit | No for reads; anywhere-writes outside it are unaffected |
| Per-run egress proxy, the sealed network, and the delegation mach denies under an allowlist network (`nsurlsessiond`, `dnssd`, `lsd.*`, af:536) | The approval binds the network. A delegated fetch or lookup bypasses the proxy. srt's per-call `allowedDomains` can't narrow a global allow (mgr:767) [C, table] | No beyond what was approved |
| Tool servers never read build-written bytes (`serverUntrusted`, inv:493–502) | Servers hold the project's tool secrets | No |
| Host-service unix sockets (docker, container engines, `/run/user`, editor sockets): Linux masks (af:1012–1075); macOS only own sockets and DNS (af:874–878) | A container engine reads and writes Toolroll's state as root-equivalent, which defeats every deny above. srt itself blocks all AF_UNIX on Linux and allows only listed sockets under a restricted network on macOS. | **Yes:** docker in checks. Opt-in per-project socket allow, sealed (srt `allowUnixSockets`). |
| Toolroll install, `helpers/`, the hash manifest and their parent folders: write denied in every mode, `anywhere` included [C2, Q4] | Replacing the fence's own helper disables the fence | No |
| Secret-bearing tools only under the macOS OS fence (project-tools.ts:788) | Tool sign-ins live in the server process | Unchanged |

### 1.5 Policy versions and approvals

- **The fence policy version becomes part of the sealed execution profile.**
  - Opening home reads is a widening, so it applies only to scopes sealed at **v2**.
  - Approvals sealed before 0.9.70 keep v1's home denies ("approvals mean exactly this").
  - Narrowings apply to every version: deny-default, Apple Events, seccomp, mandatory write denies, persistence denies.
- **Pinned per attempt [C8]:**
  - policy version and digest;
  - engine;
  - method;
  - helper sha256;
  - effective grants.
- The fence probe, the isolation probe, the workload, lazily started tool servers (inv:407, tool-broker.ts:148) and cleanup all use that pinned context.

## 2. Phase 1: 0.9.70 on the current engine

Each commit carries its tests. **"Native" means it runs under real `sandbox-exec`, real bwrap+seccomp or real `codex sandbox`, with a positive control:**
- the same action succeeds unsandboxed and is refused sandboxed;
- a native test that skips (harness.ts:104) doesn't count as release evidence [C10, recommendation].

The release lane runs on a macOS runner and a Linux runner that have the prerequisites.

**C1. `fenceFor` and required confinement.**
- Add one `fenceFor(kind, ctx)` to agent-fence.ts. It returns denies, grants and `confinement:"required"`. `TaskBoundary` and the trusted binding are required in the types.
- `confined()` (exec.ts:218) refuses any launch that has a fence but no `required` flag.
- Route through it:
  - flow setup and scripts (flow-steps.ts:374, flow-code.ts:92);
  - flow triggers (flow-triggers.ts:801).
- A trigger with no checkout gets a full boundary around its scratch folder, its script and input grants, and a sealed network [C5].
- *As built (0.9.70):* flows have no approval-sealed network, so their network is an explicit `open` in `fenceFor("flow")` (what flow scripts always had; their secrets are for outside services) — decided, not left unsaid; owner may narrow it to the project's network later. A flow's policy version is what it sealed, defaulting to v1 (home-configuration denies) when nothing sealed v2: never widened implicitly. Writes follow the project's writes setting. The input file and an inline script live in the launch's own `so-cmd-` folder, the only place beside the working folder its fence gives back.
- *Tests (attacks/flow-boundary):*
  - canaries in the state folder, another run's launch folder and another pool checkout are unreadable from setup, script and trigger;
  - with the backend unavailable (injected), nothing runs and the card says so;
  - legitimate path: the script reads its input and writes its scratch folder.

**C2. Tool servers outside `invoke`.**
- These direct spawns go through the server fence (fence + `serverUntrusted`, required):
  - `exchangeStdio` in project-tools.ts:539, used by discovery and tests;
  - flow MCP calls (flow-actions.ts:190);
  - subagent tools (subagent-tools.ts:227).
- `tool-launcher.ts:18` `runLocal` currently starts a local program from Codex's unconfined harness. It is refused unless the launch goes through the broker; brokered servers are fenced already.
- *Tests:* a discovery-spawned server can't read a state canary; a flow MCP call is refused when there's no backend; a Codex launch file naming a local program is refused.

**C3. Interactive Codex coding sessions.**
- `coding-provider.ts:253` starts the app-server, and coding-workspace.ts:386 requests `workspace-write`.
- Change: pass the same Toolroll permission profile builds get (`codexFenceArgv`, af:654) at app-server spawn, plus the session's sealed network.
- *Tests (native, `codex sandbox`):* a session command can't read a state canary or a pool sibling; it can write its worktree.

**C4. Scout browser launch contract.**
- Chrome's sandbox can't nest under Seatbelt (scout-browser.ts:1–10).
- Make it an explicit exception class, recorded on the run:
  - the pinned Playwright executable comes from a path no build can write;
  - env allowlist;
  - cwd is the run's image folder;
  - Chrome's sandbox stays on;
  - the scout proxy stays on.
- Refuse to start if any of those don't hold.
- *Tests:* a build-writable executable path is refused; the run stamp says "browser: Chrome's sandbox".
- **Flag:** this can't be "fenced by Toolroll" without switching Chrome's sandbox off. Owner Q-A.

**C5. macOS deny-default baseline.**
- Replace `(allow default)` (af:825) with srt's prologue (mac:1083–1250):
  - process, signal and task-port allowed within the same sandbox;
  - srt's mach, sysctl and iokit allowlists;
  - `lsopen` and `appleevent-send` denied.
- Then emit the policy as typed sections in a fixed order:
  1. reads: `(allow file-read*)`, integrity denies, exact-file and metadata grants, re-emitted nested denies;
  2. writes: workspace allowlist or `(allow file-write*)` for anywhere, then denies, then mandatory denies **last**;
  3. network: open, or allowlist with proxy and broker ports, plus the socket rule and delegation denies.
- Add a sealed per-project `machLookup` opt-in. This is srt `allowMachLookup`, for Playwright, Go TLS and the like.
- *Tests:*
  - **Native compatibility matrix:** `claude -p` plus `--resume`, `gemini`, one ACP agent, `git commit/gc/worktree prune`, `npm ci`, a local test server under loopback `any`, Toolroll's own Playwright check.
  - **Positive-control Apple Events test,** run under both an open and an allowlist network. The design follows srt's macos-apple-events.test.ts:67: a test-owned receiver first accepts an event unsandboxed (baseline), then refuses it sandboxed, with an `lsopen` probe the same way. Static finding: the hole is real. Not proven: the full escape, including TCC behavior [C10].
  - The existing attack suite, natively.

**C6. Linux namespace baseline.**
- `linuxFenced` (af:964) always adds `--new-session --unshare-pid --proc /proc`, whatever the network.
- *Tests (native):* host pids aren't visible; `/proc/1` belongs to the sandbox; `TIOCSTI` on the controlling tty fails.

**C7. Seccomp helper (corrected P6) [C3, C2].**
- Vendor `vendor/seccomp-src/{seccomp-unix-block.c,apply-seccomp.c}` and build script `vendor/seccomp/build.ts` from c66fb77 (Apache-2.0). Build static x64 and arm64 binaries in release CI.
- **Filter = all upstream rules except `socket(AF_UNIX)`:** AF_VSOCK, the three io_uring calls, and the stacked namespaces/mount filter.
- Toolroll's private `/tmp`, keep paths and `linuxHostSockets` masks stay (af:983–1004). That's what keeps host sockets out of reach, by masking known socket locations; it is not a general path allowlist.
- **Ordering:** `bwrap … node forwarder <bridge> -- apply-seccomp <cmd>`. The forwarder opens unix sockets per connection (egress-bridge.ts:29), so it sits outside the filter; only the workload is filtered.
- **Helper trust:**
  - copied at install into `<state>/helpers/` (mode 0700, inside the fenced state);
  - sha256 checked against the manifest right before every launch;
  - exec'd by that exact path;
  - no search fallback (generate-seccomp-filter.ts:239 is not used).
- A missing helper or a mismatched hash means no Linux fence, so the existing refusals apply.
- *Tests (native, positive control):* `io_uring_setup`, `socket(AF_VSOCK)` and `unshare(CLONE_NEWUSER)` succeed unsandboxed and fail with EPERM sandboxed; a replaced helper means refusal; the bridge still carries proxy traffic.

**C8. Mandatory write denies plus persistence (Q3, Q4).**
- srt's DANGEROUS_FILES and directories, `.git/hooks` and `.git/config` are applied:
  - in every mode, anchored at the checkout;
  - under `writes: anywhere`, also anchored at home, where shell rc files and `.gitconfig` are the persistence points srt's list names;
  - to Codex's profile as deny entries too.
- A linked worktree's shared Git directory stays under the trusted-binding rules (af:435) [C4].
- **Unlock (Q3):** an exact relative file list sealed in the execution profile and bound by its digest; siblings stay denied. Mandatory denies are emitted after grants except for unlocked exact files.
- **Linux, absent names:**
  - existing names are bound read-only;
  - for names that don't exist yet, **no placeholder mounts in Phase 1**, because of the shared-lifecycle hazard [C1]. Instead the handoff refuses a result that created a denied name it wasn't unlocked for.
  - Residual: that file exists in the checkout during the run.
- *Tests:*
  - writes to `.mcp.json`, `.vscode/tasks.json`, `.git/hooks/x` and, under anywhere, `~/.zshrc` are refused natively;
  - an unlocked exact file is writable and its sibling isn't;
  - the Linux handoff refuses.
- **Flag:** srt's list doesn't include `~/Library/LaunchAgents`, systemd user units, `.claude/settings*.json` or `.envrc`. Matching srt means those stay writable under anywhere. Owner Q-B.

**C9. Home reads at parity, plus `readDeny`.**
- `taskBoundary` stops adding `HOME_CONFIGURATION`, sibling repos and primary-tree entries to the read fence for v2 policies.
- Write denies are kept: integrity items and primary working trees.
- Add a project `readDeny` setting (CLI and settings page, approver password), sealed into new scopes.
- *Tests:*
  - a `~/.ssh` canary is readable under v2, denied when listed, and denied under a v1 profile;
  - Toolroll state is denied under both;
  - the approval digest changes when the list changes.

**C10. Sign-ins srt-style (§1.3).**
- Rewrite `signInsLaunch` (inv:1248) and delete the copy machinery.
- `SIGN_INS_READY=true`, and the Linux exclusion goes (check-access.ts:76–77).
- *Tests:*
  - **attack:** a link at `~/.config/gh/hosts.yml` to the database is refused sandboxed, with a positive control showing the unsandboxed read follows it, on both platforms;
  - real `gh auth status` and `codex login status` work inside a sign-ins check;
  - a `readDeny` sibling stays hidden.

**C11. Pin per attempt and stamp the run.**
- Record policy version and digest, helper sha256 and method on the attempt. Late tool servers use the pinned context.
- *Test:* an instance setting changed mid-run doesn't alter a late-started server's policy.

**C12. Words.**
- Update `FENCE_SUMMARY` (af:1079), the check-access levels and the scope card for the v2 meaning:
  - "Sandboxed: your home folder is readable, as in Anthropic's sandbox runtime, except folders you list."
  - Persistence denies.

**Phase 1b (0.9.71): live terminals (Q5).**
- `live-terminal.ts:327` spawns under `fenceFor("terminal")` with pty rules (srt `allowPty`, mac:1385–1396).
- An explicit operator choice, "Unsandboxed terminal", is recorded on the session.
- Codex terminals keep Codex's own sandbox; no nesting.
- *Tests:* native pty works (`vim`, resize); a state canary is unreadable; the unsandboxed choice is recorded.

**Estimate:** Phase 1 is about 9–11 focused days plus one Codex round. 1b is about 2 days.

## 3. Launch inventory, by caller [C5]

| Caller | Trust class | Policy after Phase 1 |
|---|---|---|
| Claude, Gemini, ACP builds (inv:455–600 → exec.ts:218) | build | fenceFor build; ACP only under the OS fence (inv:476) |
| Codex and OpenRouter builds (provider.ts:714, af:654; probe inv:660) | build via Codex's profile | Codex profile carries the v2 policy and mandatory denies |
| Setup and check commands (inv:1072, builder.ts:507) | build-commands | fenceFor command |
| Follow-ups and batch checks (inv:1344 → 1124; result-follow-ups.ts:221/232; batch-checks.ts:166/173) | check | fenceFor check, check-access level |
| Fence and isolation probes (inv:655–680) | probe | Must use the attempt's pinned context |
| Broker tool servers (inv:493–502, lazy via tool-broker.ts:148) | tool-server | server fence, pinned |
| Project-tools direct spawns: discovery, testing, flow MCP, subagent tools (project-tools.ts:539, flow-actions.ts:190, subagent-tools.ts:227) | tool-server | C2 |
| Codex launch-file local programs (tool-launcher.ts:18) | — | Refused outside the broker (C2) |
| Flow setup, scripts, triggers (flow-steps.ts:374, flow-code.ts:92, flow-triggers.ts:801) | flow | C1 |
| Interactive Codex coding sessions (coding-provider.ts:253, coding-workspace.ts:386) | build via Codex's profile | C3 |
| Scout Playwright browser (scout-browser.ts:84) | exception: Chrome's sandbox | C4 |
| Live terminals (live-terminal.ts:327) | terminal | 1b |
| Tool-less model calls (subagents.ts:257, task-sizing.ts:107, flow-draft.ts:77, subscription-chat.ts:~245) | tool-less | Unfenced. `CLAUDE_NO_TOOLS_ARGS`, scratch folder. Listed so it's decided, not forgotten. |
| Review phase (inv:455) | review | Unchanged (sealed files) |

## 4. Phase 2: srt backend prototype (gated)

- **One exact revision: c66fb77.** Any bump is a new review. The extraction manifest is checked in as `vendor/sandbox-runtime/MANIFEST.md`:
  - *kept:* mac and lin utils, sandbox-utils, path-entries, glob-pattern, read-deny-glob, generate-seccomp-filter, utils/*;
  - *moved out of the manager:* read-glob and allow-read preprocessing (mgr:2596; path-entries.ts:396);
  - *removed:* the manager, proxies, MITM, credential masking, Windows, the Java agent, and the commander/zod/forge/socks dependencies;
  - *adapted tests:* the upstream sandbox tests that apply, run **against the fork** [C11].
- **Prepared launch [C9]:**
  - `prepareLaunch(pinnedCtx): Promise<{file, argv, env, fds, identity, dispose()}>`;
  - `confined()` and the broker wrap become async;
  - `FenceMethod` is split into capability (`os-fence`) and engine, and the exact-string checks are updated (ACP admission, bridge creation, project-tools.ts:788);
  - srt's env rewriting (su:785: `TMPDIR`, proxy URLs, `NO_PROXY`) is removed.
- **Typed permissions [C4]:** DeniedBoth, ExactFileRead, MetadataLookup, WriteException, VnodePin, SocketAllow, MachAllow, LoopbackPorts. Each engine compiles them, and mandatory denies are always generated last. No raw trailing SBPL or argv.
- **Fail closed [C2]:**
  - an incomplete or timed-out ripgrep scan (lin:573) refuses the launch;
  - the `node_modules` exclusion and depth bound are documented as limited coverage, separate from enforced policy;
  - no helper fallback;
  - builders throw where they currently return the bare command (mac:1484, lin:3591).
- **Placeholder lifecycle [C1]:**
  - a cross-process ownership ledger in the state folder, because the console and the worker overlap;
  - a placeholder is unlinked only after every dependent process tree in every process has exited;
  - `emptyMountSourceDir`, active-wrap accounting and open `--args` descriptors (lin:882) are owned by the ledger;
  - tests cover overlap, failed starts, crash, cancel and cleanup while another launch stays active (upstream stale-mount-point.test.ts:136 is ported).
- **Violations (optional, display only):**
  - macOS: a `log stream` keyed by a per-run tag;
  - Linux: the monitor observes **write-intent syscalls** and classifies them against policy — racy, untrusted hints, not kernel denials [C12].
- **Gate to leave the prototype:** concurrent-lifecycle safety and policy parity both demonstrated. Re-estimate after the prepared-launch prototype. The current guess is 3–4 weeks.

### Corrected mapping (for the prototype's typed compiler) [C4]

| Rule | srt reality | Needs |
|---|---|---|
| Deny both reading and writing | `denyRead` alone leaves writes open; with no write config macOS allows all writes (mac:979) | DeniedBoth emits both |
| Absent Linux names | Placeholders are write-deny only; an absent `denyRead` mounts nothing (lin:2255) | Paired denies; account for parent masks |
| Exact-file read | Non-glob entries become `subpath`, never `literal` (mac:164) | ExactFileRead |
| Ancestor holds | srt denies unlink and create; Toolroll denies all `file-write*` on the vnode (mac:822) | VnodePin |
| Pool denied, own checkout writable | Composes only with careful write config; under anywhere it needs explicit exceptions | WriteException |
| Git config | Mandatory deny needs a write config and is conditional; the shared Git directory is outside the anchor | Toolroll trusted binding stays |
| Task port | Same-sandbox allow | **Accepted** (owner: match srt) |
| Delegation services | srt allows `launchservicesd` and `lsd.mapdb` | MachDeny under an allowlist network (integrity) |
| Directory metadata | Allowed (mac:929) | **Accepted** (Q7) |

## 5. Phase 3: parity gate. Phase 4: flip.

**Phase 3 (parity gate):**
- The baseline is the **hardened Phase-1 legacy engine**.
- The probe matrix covers:
  - filesystem: read, write, stat, list, rename, create, exec;
  - **syscall and IPC probes:** sockets, mach lookups, Apple Events, procargs, io_uring, userns, ptrace;
  - concurrent runs;
  - hostile path spellings: `[`, `*`, case folding, trailing slash;
  - helper replacement, incomplete scans, late-created paths.
- Both engines run the attack and slow suites natively, with positive controls; skips fail the gate.
- Any difference must be srt-stronger or on the owner-accepted list (task port, directory metadata).

**Phase 4 (flip):**
- macOS first, then Linux, when each platform's gate passes.
- The engine is pinned per attempt. Switching affects new attempts only, after draining.
- An engine refuses a policy version it can't enforce. Because Phase 1 puts every narrowing into legacy too, rollback never re-widens.
- Legacy is deleted on evidence (compatibility plus a rollback window with no incidents), not on a release count [C, migration].

**Deferred:**
- Q6, Codex as a whole process under srt [C7]. It needs a design that keeps harness credentials and network separate from command execution.

## 6. Supply chain

- Pin c66fb77 exactly, for both the C sources (Phase 1) and the TypeScript (Phase 2).
- Build from source in our CI:
  - TypeScript compiled by us;
  - seccomp binaries built with a pinned libseccomp and the architecture-specific generated headers (vendor/seccomp/build.ts:22).
- Ship a sha256 manifest and verify it at every launch. Don't ship srt-proxy or the jar.
- **Per-bump review:**
  - diff the vendored files;
  - re-read the profile prologue, rule order, seccomp and mount lifecycle;
  - fork tests plus the parity gate;
  - one Codex round;
  - a MANIFEST entry.
- **License:** Apache-2.0. Keep LICENSE, add NOTICE, mark modified files.

## 7. Risks and owner items

**Risks:**
- Deny-default on macOS breaks some toolchains. Mitigation: C5's native matrix plus the sealed `machLookup` opt-in.
- Opening home reads exposes every credential in `$HOME` to project code under v2. The owner accepted this ("onus on the user"), mitigated by `readDeny` and plain wording.
- Seccomp on older kernels or under AppArmor userns limits leaves no Linux fence, so those machines are refused. Unconfined running stays only as the explicit, recorded operator choice (Q8).
- The Linux absent-name residual in Phase 1 (C8).
- srt churn: it's 0.0.x.
- Double maintenance until legacy is deleted.
- Apple's deprecation of `sandbox-exec`, which both engines share.

**Needs the owner's eye (each is flagged above):**
- **Q-A:** the scout browser can't be fenced by Toolroll without switching Chrome's sandbox off. The proposal keeps it as a recorded exception.
- **Q-B:** srt's persistence list leaves `~/Library/LaunchAgents`, systemd user units, `.claude/settings*.json` and `.envrc` writable under anywhere. Match srt exactly, or add these four?
- **Q-C:** kept integrity items that limit features slightly:
  - no reading a sibling *task's* in-progress checkout;
  - no host container sockets unless opted in.

**Decided:** Q1 prototype, Q2 corrected P6, Q3 exact-file unlock, Q4 srt list, Q5 terminals fenced by default, Q6 deferred, Q7 accept, Q8 fail-closed.
