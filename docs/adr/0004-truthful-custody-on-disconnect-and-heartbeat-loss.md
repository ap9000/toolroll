# Truthful Custody on Disconnects and Lost Heartbeats

Disconnections never fabricate certainty or stop authoritative work silently:
1. Quitting or disconnecting a remote TUI or browser only disconnects that client; central Runs and Live Terminals continue uninterrupted.
2. Dropping a Live Terminal connection while holding the Controller lease releases the write lease immediately so teammates are never deadlocked, while the Live Terminal process stays alive.
3. Losing heartbeats from an active Runner transitions the Run's Custody to `unknown` — never assumed `stopped` and never automatically failed over to a second Runner.

## Considered Options

- **Auto-failover Runs on heartbeat timeout**: Recovers faster from genuinely dead workers, but risks split-brain execution where a partitioned Runner still finishes and pushes duplicate or conflicting side effects alongside the replacement Runner.
- **Stop central Runs when the initiating remote TUI quits**: Matches local CLI intuition (`Ctrl-C` kills the subprocess), but destroys multiplayer continuity when laptops sleep, switch networks, or hand off Tasks across a team.

## Consequences

- Operators and Approvers see an explicit `unknown` Custody state when a Runner disappears and must verify or explicitly terminate/retry rather than relying on silent auto-recovery.
- Remote mode also fails closed on disconnect, revocation, or Recovery Generation mismatch and never silently falls back to opening a local solo Workspace.
