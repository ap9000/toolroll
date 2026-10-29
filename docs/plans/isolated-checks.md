# Isolated release checks and a separate worker

Status: plan, 2026-10-29. Claude and Codex (Astra) wrote recommendations independently; this merges them. Follows
eval-harness.md, pipeline-speed.md and the research summary below.

## Why

- The release check, the step that decides deploys, runs **unsandboxed** with full access to the owner's Mac
  (src/invoke.ts:1090 bypasses the fence), inside the same `toolroll up` process as the console and the watch loop
  (src/operate.ts:7668, :7782). A heavy check stalls the console, and anything that escapes a check sits beside the
  approval authority.
- Because the release projects' check access is unsandboxed and unsandboxed carry is off, release terms are never
  attached (src/release-carry.ts:161): auto-approve, carrying and targeted rechecks have never worked in production.
- Settings can't fix it: policy v2 lets checks read home and sibling projects, sandboxed checks get no restricted
  network, `sign-ins` injects real credentials (src/agent-fence.ts:281, src/builder.ts:559, src/invoke.ts:1258), and
  Toolroll's own tests create sandboxes, which macOS refuses inside a sandbox (test/inside-fence.ts:8).
- Industry practice (2026): untrusted code and checks in throwaway VMs, egress default-deny and enforced outside the
  guest, secrets kept out and injected by a host-side proxy, egress monitored, and the allowed services themselves
  tested as escape routes (OpenAI's October 2026 containment report).

## Where Claude and Codex agreed
- Split execution out of the console process first.
- A VM boundary, not more Seatbelt settings. Throwaway per run, no host mounts, no owner home or keychain.
- Credentials stay in a host-side broker; the guest gets a short-lived, run-scoped capability, never a token.
- Egress default-deny, enforced outside the guest, monitored; canaries prove the boundary before the plane trusts it.
- The plane still seals obligations and verifies the nonce'd report; unsandboxed carry stays off.

## Where they differed, and the decision
| Question | Claude | Codex | Decision |
|---|---|---|---|
| Where the check runs | Linux VM (OrbStack) for most parts + macOS VM for macOS-only parts and real-model journeys | **One** disposable macOS VM (Tart) for the whole check; GitHub keeps Linux CI | **Codex.** One environment keeps today's full macOS coverage and halves the work |
| OrbStack | Linux VM for candidate code | Not a microVM boundary (shared kernel across OrbStack workloads); only for the plane-provisioned GreenMail fixture | **Codex** |
| How "isolated" is recorded | A new check-access level | Keep `checkAccess: "sandboxed"`, add a separately sealed **execution profile** (backend, image digest, versions, network policy, broker capabilities, mounts) | **Codex** |
| Console responsiveness | Process split | Process split plus coalescing progress writes and moving heavy HTTP reads off the loop | **Both.** Today's stall was also a 0.9.76 query regression (fixed separately in `console-perf`) |

## Stages

0. **Ship the console fix (0.9.78):** `console-perf` (approval-setting read through the existing index; checkout sizing
   off the event loop) with the pipeline-speed work. Pages 2.0–2.3 s → 0.33–0.42 s on the owner's DB copy.
1. **Separate worker process** (2–4 days). `toolroll up` supervises a console process and a worker process
   (reuse src/controller-supervisor.ts); builds, checks, batch checks and follow-ups move to the worker with existing
   custody, leases and recovery. Coalesce `saveCheckProgress` display writes; heavy HTTP reads through ReadExecutor.
2. **Credential broker spike** (2–3 days, feasibility gate). Host broker keeps provider credentials and refresh;
   guest gets a run-scoped capability (provider, models, concurrency, spend). Prove real Claude/Codex CLIs work through
   it (streaming, tools, resume, cancel) with today's subscription sign-ins; fallback is dedicated API keys held only
   by the broker (owner decision).
3. **Isolated release runner** (6–10 days). Tart VM cloned from a pinned image per run, destroyed after. Candidate
   and needed history copied from verified objects; no mounts, no Docker socket, no shared `.git`. GreenMail provided
   by the plane in OrbStack, per-run endpoint, required (no silent skip). One heavy reservation per Mac; same
   isolation for carry-proof builds (release-carry.ts fencedBuildRunner).
4. **Seal and enable** (3–5 days). Execution profile sealed into the scope and verified at admission; evidence names
   what actually ran; `releaseTermsFor`, `checkLaunchOf`, `liveReleaseOf`, release-auto.ts accept it. Egress gateway
   outside the guest (broker, artifact transport, fixture ports, npm read-only for approved package/version paths;
   no DNS, LAN, Tailscale, metadata, GitHub sign-in). Attack and canary suite: native fence tests with no skips,
   synthetic secrets for ~/.ssh, plane DB/WAL, keychain, other projects; cross-run isolation; DNS/redirect/CONNECT/
   IPv6/allowed-endpoint attacks; broker revocation; forged reports; worker crash and orphan cleanup; console latency
   during a full check. Then auto-approve, carrying and targeted rechecks work for new scopes.

Total: about 3–5 focused weeks. The release that ships stages 3–4 needs a person (harness and policy changes are
excluded from automatic approval by design).

## Decisions for the owner
| Decision | Recommendation |
|---|---|
| Install Tart and keep a pinned macOS 26 VM image (~30–50 GB; 108 GB free today) | Yes |
| Real-model journeys through the broker: keep subscription sign-ins if the spike proves them | Yes; API keys held only by the broker are the fallback (billing decision) |
| Never enable unsandboxed carry as a shortcut meanwhile | Yes |

## Not doing
No cluster, no unsandboxed carry, no Docker socket in checks, no credentials copied into VMs, no dropping macOS
coverage, no weakening checks to get green.
