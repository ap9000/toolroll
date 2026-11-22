import Foundation
import Observation

public enum TerminalControlRole: String, Sendable, Equatable {
    case observer
    case controller
}

public enum TerminalConnectionState: Sendable, Equatable {
    case idle
    case connecting
    case connected
    case exited(code: Int?, signal: Int?)
    case disconnected(String)
}

/// Manages a live remote Toolroll PTY session over WebSocket (`/term/<id>/socket`, subprotocol `toolroll`)
/// with lease-aware Observer/Controller state and 1-step inline takeover confirmation.
@MainActor
@Observable
public final class LiveTerminalSession {
    public private(set) var terminalId: String?
    public private(set) var taskId: String?
    public private(set) var program: String = "shell"
    public private(set) var branch: String = ""
    public private(set) var connectionState: TerminalConnectionState = .idle
    public private(set) var role: TerminalControlRole = .observer
    public private(set) var controller: String?
    public private(set) var viewers: [String] = []
    public private(set) var epoch: Int = 0
    public private(set) var takeoverArmed: Bool = false
    public private(set) var inputFullWarning: Bool = false
    public private(set) var statusNote: String?
    public private(set) var renderLines: [TerminalRenderLine] = []
    public private(set) var cursorRow: Int = 0
    public private(set) var cursorCol: Int = 0
    public private(set) var cols: Int = 100
    public private(set) var rows: Int = 28

    private var surface: any TerminalSurfaceProtocol
    private var webSocketTask: URLSessionWebSocketTask?
    private var receiveLoop: Task<Void, Never>?
    private var isDemoMode: Bool = false
    private var demoSelfAccount: String = "alex"
    private let session: URLSession

    public init(
        surface: any TerminalSurfaceProtocol = VT100Emulator(cols: 100, rows: 28),
        session: URLSession = .shared
    ) {
        self.surface = surface
        self.cols = surface.cols
        self.rows = surface.rows
        self.session = session
    }

    public var isControlling: Bool {
        role == .controller
    }

    public var otherViewersCount: Int {
        max(0, viewers.count - (controller == nil ? 0 : 1))
    }

    /// True when another human currently holds the Controller lease (requiring 1-step confirmation).
    public var requiresTakeoverConfirm: Bool {
        role == .observer && controller != nil && !(controller?.isEmpty ?? true)
    }

    public func attach(
        client: ToolrollClient,
        terminalId: String,
        taskId: String?,
        program: String,
        branch: String
    ) async {
        disconnect(clearOutput: true)
        self.isDemoMode = false
        self.terminalId = terminalId
        self.taskId = taskId
        self.program = program
        self.branch = branch
        self.connectionState = .connecting
        self.role = .observer
        self.controller = nil
        self.viewers = []
        self.takeoverArmed = false
        self.inputFullWarning = false
        self.statusNote = nil

        do {
            let request = try await client.webSocketRequest(terminalId: terminalId)
            let ws = session.webSocketTask(with: request)
            self.webSocketTask = ws
            ws.resume()
            self.connectionState = .connected
            sendJSON(["t": "resize", "cols": cols, "rows": rows])
            receiveLoop = Task { [weak self] in
                await self?.runReceiveLoop(ws)
            }
        } catch {
            self.connectionState = .disconnected(error.localizedDescription)
        }
    }

    /// Attaches an interactive local Demo terminal session so offline preview feels alive immediately.
    public func attachDemo(taskId: String, program: String, branch: String, controller: String? = "sam", me: String = "alex") {
        disconnect(clearOutput: true)
        self.isDemoMode = true
        self.demoSelfAccount = me
        self.terminalId = "demo-term-\(taskId)"
        self.taskId = taskId
        self.program = program
        self.branch = branch
        self.connectionState = .connected
        self.role = (controller == me) ? .controller : .observer
        self.controller = controller
        self.viewers = controller == nil ? [me] : Array(Set([me, controller!])).sorted()
        self.epoch = 1
        self.takeoverArmed = false
        self.statusNote = nil

        let banner = """
        \u{1B}[2mtoolroll central live terminal · \(program) on \(branch)\u{1B}[0m\r\n\
        \u{1B}[32m✓\u{1B}[0m npm run typecheck  \u{1B}[2m(1.8s)\u{1B}[0m\r\n\
        \u{1B}[32m✓\u{1B}[0m vitest src/multiplayer-handoff.test.ts  \u{1B}[2m(4/4 passed)\u{1B}[0m\r\n\
        \u{1B}[34m●\u{1B}[0m watching candidate checks · lease owned by \(controller ?? "idle")\r\n\
        \u{1B}[1m$\u{1B}[0m 
        """
        feedBytes(Data(banner.utf8))
    }

    public func disconnect(clearOutput: Bool = false) {
        receiveLoop?.cancel()
        receiveLoop = nil
        webSocketTask?.cancel(with: .normalClosure, reason: nil)
        webSocketTask = nil
        takeoverArmed = false
        inputFullWarning = false
        if clearOutput {
            surface.clear()
            syncSurface()
            terminalId = nil
            taskId = nil
            connectionState = .idle
            role = .observer
            controller = nil
            viewers = []
            statusNote = nil
        } else if connectionState == .connected || connectionState == .connecting {
            connectionState = .disconnected("Detached")
        }
    }

    /// Requests control. If another teammate is actively controlling, first call arms 1-step confirmation
    /// (`takeoverArmed = true`) instead of preempting abruptly; second call confirms and sends `take-control`.
    /// When the terminal is idle (`controller == nil`), takes control immediately.
    @discardableResult
    public func requestTakeControl() -> Bool {
        guard connectionState == .connected else { return false }
        guard role == .observer else { return true }

        if requiresTakeoverConfirm && !takeoverArmed {
            takeoverArmed = true
            statusNote = "\(controller ?? "Teammate") is controlling — click Confirm Takeover to take control."
            return false
        }

        takeoverArmed = false
        statusNote = nil
        if isDemoMode {
            role = .controller
            controller = demoSelfAccount
            epoch += 1
            feedBytes(Data("\r\n\u{1B}[2m[lease] \(demoSelfAccount) took control\u{1B}[0m\r\n\u{1B}[1m$\u{1B}[0m ".utf8))
            return true
        }
        sendJSON(["t": "take-control"])
        return true
    }

    public func cancelTakeoverArm() {
        takeoverArmed = false
        statusNote = nil
    }

    public func releaseControl() {
        guard connectionState == .connected, role == .controller else { return }
        takeoverArmed = false
        if isDemoMode {
            role = .observer
            controller = nil
            epoch += 1
            feedBytes(Data("\r\n\u{1B}[2m[lease] control released (idle)\u{1B}[0m\r\n".utf8))
            return
        }
        sendJSON(["t": "release-control"])
    }

    public func sendInput(_ text: String) {
        guard connectionState == .connected, !text.isEmpty else { return }
        if role != .controller {
            if !requiresTakeoverConfirm {
                _ = requestTakeControl()
            } else {
                takeoverArmed = true
                statusNote = "Observing \(controller ?? "teammate") — confirm takeover before typing."
                return
            }
        }
        if isDemoMode {
            handleDemoInput(text)
            return
        }
        // Protocol key is `d` (`{"t":"in","d":"..."}`) per src/live-terminal.ts
        sendJSON(["t": "in", "d": text])
    }

    public func resize(cols newCols: Int, rows newRows: Int) {
        let clampedCols = max(20, newCols)
        let clampedRows = max(6, newRows)
        guard clampedCols != cols || clampedRows != rows else { return }
        cols = clampedCols
        rows = clampedRows
        surface.resize(cols: clampedCols, rows: clampedRows)
        syncSurface()
        if connectionState == .connected && !isDemoMode {
            sendJSON(["t": "resize", "cols": clampedCols, "rows": clampedRows])
        }
    }

    // MARK: - Protocol Handling (Public for Deterministic Unit Tests)

    public func applyControlFrame(text: String) {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = obj["t"] as? String
        else { return }

        switch type {
        case "hello":
            if let c = obj["cols"] as? Int, let r = obj["rows"] as? Int {
                surface.resize(cols: c, rows: r)
                cols = surface.cols
                rows = surface.rows
                syncSurface()
            }
            if (obj["ended"] as? Bool) == true {
                connectionState = .exited(code: nil, signal: nil)
            }

        case "control":
            let nextRole = TerminalControlRole(rawValue: obj["role"] as? String ?? "observer") ?? .observer
            let prevRole = role
            role = nextRole
            controller = obj["controller"] as? String
            viewers = obj["viewers"] as? [String] ?? []
            epoch = obj["epoch"] as? Int ?? epoch
            takeoverArmed = false
            if prevRole == .controller && nextRole == .observer, let nextCtrl = controller {
                statusNote = "\(nextCtrl) took control — you are now observing."
            } else if nextRole == .controller {
                statusNote = nil
            }

        case "exit":
            let code = obj["code"] as? Int
            let sig = obj["signal"] as? Int
            connectionState = .exited(code: code, signal: sig)
            role = .observer
            takeoverArmed = false

        case "input-full":
            inputFullWarning = true
            statusNote = "Terminal input buffer is full — wait a moment."

        default:
            break
        }
    }

    public func feedBytes(_ data: Data) {
        surface.feed(data)
        syncSurface()
    }

    // MARK: - Private

    private func syncSurface() {
        renderLines = surface.snapshotLines(includeScrollback: true)
        cursorRow = surface.cursorRow
        cursorCol = surface.cursorCol
    }

    private func sendJSON(_ payload: [String: Any]) {
        guard let ws = webSocketTask,
              let data = try? JSONSerialization.data(withJSONObject: payload),
              let text = String(data: data, encoding: .utf8)
        else { return }
        ws.send(.string(text)) { [weak self] err in
            if let err {
                Task { @MainActor [weak self] in
                    self?.statusNote = "Send failed: \(err.localizedDescription)"
                }
            }
        }
    }

    private func runReceiveLoop(_ ws: URLSessionWebSocketTask) async {
        while !Task.isCancelled {
            do {
                let message = try await ws.receive()
                switch message {
                case .data(let bytes):
                    feedBytes(bytes)
                case .string(let text):
                    applyControlFrame(text: text)
                @unknown default:
                    break
                }
            } catch {
                if !Task.isCancelled {
                    if case .exited = connectionState {
                        // Already cleanly exited.
                    } else {
                        connectionState = .disconnected(error.localizedDescription)
                        statusNote = "Terminal disconnected: \(error.localizedDescription)"
                    }
                }
                break
            }
        }
    }

    private func handleDemoInput(_ text: String) {
        if text == "\r" || text == "\n" {
            feedBytes(Data("\r\n\u{1B}[2m(demo terminal — connect a workspace to run real remote commands)\u{1B}[0m\r\n\u{1B}[1m$\u{1B}[0m ".utf8))
        } else if text == "\u{7F}" {
            feedBytes(Data("\u{08} \u{08}".utf8))
        } else {
            feedBytes(Data(text.utf8))
        }
    }
}
