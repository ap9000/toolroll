# Central workspace delivery

Owner authorized feature-branch implementation through Codex subagents on 20 November 2026. Branch: `central-workspace`; baseline: released 0.9.116 at `94542be44d44b7a8bcef29862367ee61fe45aff5`. The controlling plan is [central-workspace.md](central-workspace.md).

Integration lead owns this tracker. Builders own separate named files/slices; no concurrent edits to shared authority code. Security-sensitive implementation requires a separate Codex reviewer on the final exact diff and relevant evidence. No merge, deployment, live grants, interactive attach enablement or removal of worktrees is authorized by this tracker.

## Work sequence

| Work | Scope and output | Current state | Depends on |
| --- | --- | --- | --- |
| CW0-S | Server route/principal/action inventory and concrete remote-person protocol | Assigned to `central_server_contract` | Committed controlling plan |
| CW0-T | TUI bootstrap/profile/actions, state flow and compatibility contract | Assigned to `central_tui_contract` | Committed controlling plan; coordinate CW0-S |
| CW0-X | Project binding, candidate transport, device and custody contract | Assigned to `central_execution_contract` | Committed controlling plan |
| CW0-R | Integrate contracts, resolve disagreements and independently review authority design | Waiting for contracts | CW0-S/T/X |
| CW1 | Remote-person admission, connection/capability negotiation, authorized TUI reads | Blocked on reviewed contracts | CW0-R |
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

Sprint 0 is running with three separate contract owners. Product behavior is unchanged. Implementation slices will be assigned after the relevant contract and authority decisions are integrated and reviewed.
