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

The reviewed disabled foundation and subsequent guards are on draft branch `central-workspace`. The preserved CI run on `bfa40b9f` finished CI with 35 successful checks, four intentional Node 22 skips and four failures. A historical migration fixture requested forbidden current-schema repair; that fixture is corrected in `460ab086`. The read timeouts were traced to the new global action index displacing existing scoped query plans. The reviewed hold-only partial-index fix is committed at `0ad65795`; unchanged fast-read and general wire targets now pass locally. Fresh exact-candidate CI is still required. The two platform aggregate failures derive from the failed or unreadable shard report. Earlier `f1904013` green results do not establish a pass for this head. This is branch CI, not an approved machine release or deployment. Original migration-oracle, hygiene and GNU filesystem failures remain in ignored evidence alongside their reviewed fixes.

| Reviewed implementation | Exact commit | Evidence and limits |
| --- | --- | --- |
| Disabled TS/Rust identity and connection contracts | `c9c6cb36` | All 18 committed objects independently bound. No remote reads, commands, approvals or execution advertised |
| Native tagged-bootstrap refusal and private cold-copy stage | `5f0b3424` | Nine objects independently bound; focused stage and native startup checks passed. Central input exits before redemption/network/UI |
| Pure enrollment parser and classifier | `246c1b37` | 26 focused tests and typecheck passed. No IO, permission or readiness |
| Publication, release-ledger, intake and snapshot sign-in leaves | `3c1a1e0b`, `75e0e4d8`, `11d3cab5`, `3581d142` | Nine narrow leaves supported; ten broader classes unsupported. Cached post-backup epoch collisions remain unprotected |
| Read-only native registry library and GNU same-FD flag fix | `0e50be08`, `ce46d6bc` | macOS focused proof and actual Linux CI passed. No production constructor, account lookup, helper or admission |
| Initial native publication prototype | `9788ff6d` | Entirely test-private. macOS race/interruption proof does not establish power-loss, Linux enrollment, NSS or shared exclusion safety |
| Strict check-hold reader and direct, batch and automatic check guards | `8a095370`, `7148b4b3`, `9032393f`, `f1904013` | Focused security tests/typecheck and exact-object reviews passed. Actual observed output survives; no fabricated finish, receipt or stop proof |
| Full-check merge barrier and followed-PR reservation | `bb74748b` | Originally pushed in failed `bfa40b9f`; current candidate needs fresh CI. Hard barrier precedes shortcuts and merge-anyway; final transaction reproof; held view cannot merge |
| Schema 178 indexed hold discovery and exact stage revalidation | `1e814cba` | Originally pushed in failed `bfa40b9f`; current candidate needs fresh CI. Identity precedes migration writes; current index validated before replay; exact 178/709 catalog only. No cache or permission shortcut |
| Bound Ship admission and uncertain merge custody | `43548a24` | Originally pushed in failed `bfa40b9f`; current candidate needs fresh CI. Final transaction checks and callback rollback; unknown issued merges keep custody. Initial unbound imports remain unclosed |
| Native stage namespace and binary-copy prerequisite | `50655401` | Reviewed and included in this draft candidate. Seven focused macOS/APFS cases plus check, Clippy and format passed. Entirely test-private; production body unchanged |
| Independent archive, replacement and deletion custody | `7587f01b` | Reviewed and included in this draft candidate. Existing-task missing references refuse; caught nested CLI replacement rolls back through a savepoint. Precise deletion notice; no prior-outcome rewrite |
| Historical finding compatibility fixture correction | `460ab086` | Reviewed and included in this draft candidate. Three focused tests and typecheck passed. Historical first-v155 finding shape upgrades from a valid v177 predecessor; production v178 refusal unchanged |
| Hold-only partial index and strict catalog validation | `0ad65795` | Separately reviewed and object-bound. 87 focused checks/typecheck, one frozen build, both fast-read cases and the unchanged 10,000-base-task general wire test pass locally. Existing ceilings retained; new CI required |

Every integrated security slice has a separate source review and exact committed-object/path/mode binding. Focused counts overlap; they are not a combined test total. Local focused checks cover their composed working sources; no exact-head CI pass is claimed for the newer local commits. The custody findings were fixed with six selected regressions; earlier sixteen custody cases and legacy/reader controls overlap. Original failed attempts remain preserved. Synthetic desktop and 390-pixel phone refusal screenshots were inspected; live Settings, exact font loading and physical-device behavior are unverified. The configured YouI inventory has zero errors and 58 existing warnings; its diff scan excludes the changed server-rendered TypeScript, so it does not prove that source linted. The performance verifier used Node 24.21.0/SQLite 3.53.4 on macOS; 127 gated wire measurements stayed within their existing ceilings. All 2,967 frozen source entries and 845 built entries remained unchanged, independently checked by the integration lead and reviewer. This does not establish the exact Linux CI artifact or a machine release pass. The ignored handoff records report hashes, original failures and precise test attribution.

The stage remains unreachable and incomplete, limited to controlled standalone cold copies under its experimental 128 MiB ceiling. JavaScript ownership/mode and post-open inode checks do not establish ACL privacy or safe SQLite path opening and cleanup against hostile writers. A protected native namespace, descriptor/ACL checks, retained writer exclusion and safe database-handle lifetime are prerequisites before any operator or live caller. There is no check-hold writer or supported check-retirement claim.

Next are fresh branch CI, remaining final-action guards, and honest API/UI/TUI projections. The reviewed durable merge-intent design must guard admission and the Store settlement sink together, retaining unknown issued custody unless fresh exact-scope observation wins. Publication push/open, release and unbound Ship import remain separate gaps. Then a private check-hold stage writer can be considered. A hold, lost lease or disconnect never proves prior execution stopped and never permits automatic retry or failover.

Production enrollment still requires protected non-database expectations, OS-account discovery and installed-helper trust, durable native IO, service binding, shared startup/ingress/writer exclusion, complete retirement and rollback. The current Node launcher cannot emit central input, and its personal leave path may stop an owned worker. No usable remote TUI, end-to-end no-worker-stop, laptop execution or physical-device proof is claimed. Personal restore, canonical main and the live 0.9.116 installation remain unchanged. No merge, deployment or live configuration changes are authorized.
