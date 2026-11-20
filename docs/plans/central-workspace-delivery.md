# Central workspace delivery

Owner authorized feature-branch implementation through Codex subagents on 20 November 2026. Branch: `central-workspace`; baseline: released 0.9.116 at `94542be44d44b7a8bcef29862367ee61fe45aff5`. The controlling plan is [central-workspace.md](central-workspace.md).

Integration lead owns this tracker. Builders own separate named files/slices; no concurrent edits to shared authority code. Security-sensitive implementation requires a separate Codex reviewer on the final exact diff and relevant evidence. No merge, deployment, live grants, interactive attach enablement or removal of worktrees is authorized by this tracker.

## Work sequence

| Work | Scope and output | Current state | Depends on |
| --- | --- | --- | --- |
| CW0-S | Server route/principal/action inventory and concrete remote-person protocol | Complete: server contract | Committed controlling plan |
| CW0-T | TUI bootstrap/profile/actions, state flow and compatibility contract | Complete: TUI contract; stale-response refinement integrated | Committed controlling plan; coordinate CW0-S |
| CW0-X | Project binding, candidate transport, device and custody contract | Complete: execution contract | Committed controlling plan |
| CW0-R | Integrate contracts, resolve disagreements and independently review authority design | Complete at `f0e071c7`; three exact document hashes independently pinned | CW0-S/T/X |
| CW1-A | Disabled server connection metadata and additive workspace identity | Complete and independently reviewed at `c9c6cb36`; schema 177 | CW0-R |
| CW1-B | Unreachable Rust connection contract and strict validation guards | Complete and independently reviewed at `c9c6cb36`; no transport/UI enablement | CW0-R; exact schema coordinated with CW1-A |
| CW1-C | Central-only recovery enrollment and retirement safeguards | Copied-stage helper complete at `5f0b3424`, independently reviewed; always incomplete. Pure unreachable enrollment parser/classifier complete at `246c1b37`; source review passed. Registry/exclusion/full retirement still block enablement | CW0-X; bounded policy and authority review |
| CW1-D | Tagged TUI bootstrap and no-local-fallback guard | Native guard complete at `5f0b3424`, independently reviewed; central input exits before redemption/network/UI. No central launcher or end-to-end no-worker-stop proof | CW1-A/B |
| CW1 | Remote-person admission, connection/capability negotiation, authorized TUI reads | Disabled foundation complete; enablement blocked on recovery, scoped read admission, launcher and native proof | CW1-A/B/C/D; new exact implementation reviews |
| CW2 | Shared permitted task actions, idempotency, browser step-up return and reconnect | Blocked | CW1 |
| CW3 | Exact local worktree and protected local revision candidate transfer | Blocked | CW2; reviewed identity/transfer design |
| CW4 | Device enrollment/readiness/revocation without dispatch | Blocked | CW0-X and integrated authority review; independent of local worktree UI where practical |
| CW5 | Optional laptop attempts, custody, bounded artifacts and trusted central verification | Blocked | CW3/CW4; independent security and native proof gates |
| CW6 | Outside-user pilot, compatibility, restore, guides and normal release | Blocked | Relevant milestone; remote TUI pilot starts after CW2 |

The first remote TUI milestone is CW1/CW2 against existing central execution. It does not wait for laptop execution. Blocked means the dependency has not been satisfied; it is not a failed task or a claim that implementation is running.

## Integration rules

- Keep personal/local-owner behavior intact; no remote credential is converted to owner authority.
- API-token approvals keep their browser step-up requirement. The UI identifies remaining capability gaps honestly.
- No automatic local fallback, task copying, process migration or third-party PTY adoption.
- Use existing project/path, action-owner, authorization, sandbox and Git helpers; audit their assumptions before off-host reuse.
- Run focused contracts/data-integrity/security tests for changed behavior. No manual whole or import-selected suites, raised timeouts, new skips or invented agent limits.
- Keep tests isolated from real HOME, credentials, installation and port 4180. No native/provider calls unless an explicitly scoped verification step requires and authorizes them.
- Review after builders finish a slice, then fix findings on that slice. Scaffolding or contract review alone never enables execution.
- Record exact commits, checks, original failed/incomplete evidence and remaining gaps in ignored `evidence/central-workspace/`.

## Current milestone

The disabled server/Rust foundation is committed and pushed as `c9c6cb36`. Independent review matched all 18 committed file hashes. Focused TS contract/migration, native localhost authorization, route/engine and tripwire checks plus final typecheck passed; Rust's 10 focused tests, check and Clippy passed. Counts overlap; no combined test total is claimed. Source guards found no findings. Original failed/environmental attempts and the repaired current-schema compatibility replay finding remain in ignored evidence.

The metadata endpoint advertises no remote read, command, approval, execution or interactive capability. Existing engine digest/local redemption and restore behavior are unchanged. Actual TLS enrollment, remote TUI reads and native user journeys are not proved by this milestone.

The native bootstrap and private copied-stage guard are committed at `5f0b3424`. Independent review matched all nine committed objects. Ten stage tests and typecheck passed; twelve isolated native bootstrap/startup tests, Clippy and formatting passed. Source guards found no findings. Review found and builders fixed oversized-file memory use, a FIFO replacement race and escaped-token decoding; original evidence remains. The stage supports only standalone cold copies up to its 128 MiB experimental ceiling and retires five authority classes; ten remain unsupported. Recovery readiness remains false.

The native guard exits before central redemption, network or UI. The current Node launcher cannot emit central input; its personal-worker shutdown path remains a separate integration blocker. No end-to-end no-worker-stop, remote access, phone or Linux-native proof is claimed.

The independently reviewed [enrollment boundary](central-workspace-enrollment-contract.md) now has a pure unreachable parser/classifier at `246c1b37`. Twenty-six focused isolated tests and typecheck passed; source guards found no findings. Every assessment denies admission and readiness and states that native proof has not been performed. No production caller or filesystem operation was added.

The private stage now also retires publication-grant verifiers (`3c1a1e0b`), prospectively holds restored release-publication ledger permission (`75e0e4d8`), and refuses fresh intake commands (`11d3cab5`). Each exact two-file commit is independently reviewed and bound. At the intake milestone, focused tests, typecheck and source guards passed. Existing histories and actual outcomes remain intact. Cached operations and prior execution are not claimed cancelled or stopped.

The read-only native registry library is committed at `0e50be08`, independently reviewed and object-bound. Eleven focused macOS/APFS tests, check, Clippy and formatting passed; source guards found no findings. A review finding added complete held-file policy checks after reading, including ACL rechecks. There is no production constructor, account lookup, helper binary, write, package activation or admission. Linux remains unexecuted; its ext-family filesystem observation cannot establish ext4 or durability.

CI on the previous pushed head found migration-test assumptions and a documentation phrase matching the public-hygiene rule. Focused triage covers all fifty-five distinct migration cases and typecheck; one failed local case needed a shorter isolated temporary path for its tsx socket, with original evidence retained. No production migration, gate threshold or source skip changed. Fresh remote CI is required; these checks are not a full-suite pass.

The private snapshot sign-in leaf is committed at `3581d142`, with twenty-two focused tests and typecheck passed. Independent review and object binding cover exact files. Nine narrow leaves are implemented; the ten broader categories remain unsupported. Snapshot-known epoch fences do not cover post-backup counter collisions; tools, secrets and native custody remain unresolved.

The strict check-hold reader (`8a095370`) and composed direct-road guards (`7148b4b3`) are independently reviewed and object-bound. Direct requests, start claims, command launches and settlement reprove holds; the CLI refuses clearly. Actual observed output survives holds without a fabricated finish or receipt. Twelve focused direct tests and typecheck passed, with earlier reader and access checks attributed separately; source guards found no findings. The reader now accepts the actual sixteen-character command digest from the Store; the request-binding hash remains SHA-256. No event writer or supported check-retirement claim exists.

Ubuntu CI on `a234026f` exposed a GNU `statfs` field assumption. Reviewed fix `ce46d6bc` uses same-descriptor `statvfs` flags, with focused native check/error, Clippy and formatting proof. The failed CI and earlier incomplete scalar-type refinement remain preserved. Actual Linux CI is still required; no host-only check is presented as Linux proof.

Next are batch and check-only guard integration and an unreachable native initial-publication prototype. Custody, final-action and honest presentation guards must follow before any stage check-retirement claim. A proposed not-run shortcut was rejected because restored history cannot prove post-backup execution never occurred. Production OS-home discovery, filesystem integration, service binding, all-writer exclusion and complete retirement remain unimplemented gates. Scoped person read admission, actual central launcher and remote TUI proof follow those reviewed dependencies. Actions, local handoff and device execution remain gated. No merge, deployment or live configuration changes are authorized.
