# Toolroll for macOS (Native SwiftUI + AppKit)

A native macOS desktop workbench for Toolroll's central multiplayer Engine — built in pure **Swift 6 + SwiftUI + AppKit** (no Electron, no Tauri, zero external SPM dependencies).

## Architecture

- **`ToolrollCore`** (`Sources/ToolrollCore/`):
  - `Models.swift` — strict `Codable`/`Sendable` models matching Toolroll's central HTTP/SSE/WebSocket contracts (`/work/rows`, `/t/:id/steps`, `/t/:id/diff`, `/api/presence`, `/api/handoff/...`, `/engine/chat`).
  - `ProfileStore.swift` — reads and writes `~/.config/toolroll/remote/profiles.json` (`chmod 0600`) shared with the `toolroll` CLI and Rust TUI.
  - `ToolrollClient.swift` — pinned async HTTP + SSE (`GET /live?room=...`) + WebSocket (`Sec-WebSocket-Protocol: toolroll`) client carrying `x-toolroll-client: terminal-remote`, `x-toolroll-workspace`, and `x-toolroll-recovery`.
  - `VT100Emulator.swift` — defines `TerminalSurfaceProtocol` (a clean v2 swap seam for `libghostty` / GhosttyKit) plus a fast v1 ANSI/VT100 emulator with SGR colors and scrollback.
  - `LiveTerminalSession.swift` — real-time WebSocket PTY session with Observer/Controller lease tracking and **1-step inline takeover confirmation** before preempting an active human Controller.
  - `CommandPaletteEngine.swift` — fuzzy matcher and contextual ranking for `⌘K`.
- **`ToolrollApp`** (`Sources/ToolrollApp/`):
  - **Toolroll Kit Signal 1.0.0** adaptive light/dark tokens (`Theme.swift`) — monochrome 1px hairlines, zero resting shadows, zero toasts, static blue dot on Running states, solid ink reserved for `Needs you`.
  - **3-Pane Workbench** (`MainWorkbenchView.swift`): Attention-first vertical inbox (`InboxSidebarView.swift`), Task Cockpit (`TaskCockpitView.swift` with digest-bound Browser Approval handoff, Candidates Promote / Stale Rebase / Open PR strip, Steps timeline, Steer composer), and collapsible `Terminal | Diff | Lead` Inspector (`InspectorView.swift`).
  - **Menu Bar Extra**: live `Needs you` counter with instant activation.
  - **Native Browser-Assisted Pairing** (`PairWorkspaceSheet.swift`): pairs via `/api/connect/pair/start` + `/api/connect/pair/poll` or manual Bearer token.

## Build, Test & Launch

```bash
cd mac

# Run unit tests
swift test

# Build & package Toolroll.app
chmod +x build-app.sh
./build-app.sh

# Launch the native app
open build/Toolroll.app
```

If no remote profile exists in `~/.config/toolroll/remote/profiles.json` yet, `Toolroll.app` opens in an interactive **Demo Workspace** so you can inspect the full 3-pane workbench immediately and click **Connect Workspace…** (`⌘⇧P`) whenever you are ready to pair.

## Keyboard Shortcuts

- `⌘K` — Command Palette (jump to task, promote Candidate, open PR, hand off, attach Live Terminal)
- `⌘J` — Toggle Inspector pane
- `⌘1` / `⌘2` / `⌘L` — Focus Live Terminal / Diff / Lead Thread
- `⌘O` — Open selected task in Browser (for digest-bound approvals)
- `⌘R` — Refresh workspace
- `⌘⇧P` — Connect / Pair Remote Workspace
