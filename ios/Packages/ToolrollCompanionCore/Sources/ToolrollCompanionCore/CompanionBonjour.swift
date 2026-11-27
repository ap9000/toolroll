import Foundation
import Network

/// Finds this Mac on the local network when none of its stored direct addresses answer (C3: a new DHCP lease, another
/// Wi-Fi). The Mac advertises `_toolroll._tcp` on its direct port with TXT `m=<machineId>`. Discovery adds no trust:
/// a found address is still health-probed for the machineId and Noise still authenticates the Mac. A found address is
/// used for that one dial; stored paths change only through a hello.
public typealias CompanionDirectDiscovery = @Sendable (_ machineId: String) async -> [CompanionPath]

public enum CompanionBonjour {
    /// The TXT record names this Mac.
    public static func matches(txt: [String: String], machineId: String) -> Bool {
        !machineId.isEmpty && txt[CompanionWire.bonjourMachineIdKey] == machineId
    }

    /// `ws://<ipv4>:<port>/v1/direct` when it passes the path rules (a private or Tailscale IPv4), else nil.
    public static func directPath(host: String, port: UInt16) -> CompanionPath? {
        let bare = host.split(separator: "%").first.map(String.init) ?? host
        let path = CompanionPath(kind: .direct, url: "ws://\(bare):\(port)/v1/direct")
        return (try? CompanionPathRules.validate(path)) != nil ? path : nil
    }

    /// Browses for up to `timeout` and returns the addresses of services whose TXT names `machineId` (the first one
    /// found ends the browse early).
    public static func discover(machineId: String, timeout: Duration = .milliseconds(1500)) async -> [CompanionPath] {
        let search = BonjourSearch(machineId: machineId)
        return await search.run(timeout: timeout)
    }
}

/// One browse: NWBrowser for the service, then a TCP connection per matching result to learn its IPv4 address.
private final class BonjourSearch: @unchecked Sendable {
    private let machineId: String
    private let queue = DispatchQueue(label: "dev.toolroll.companion.bonjour")
    private let lock = NSLock()
    private var continuation: CheckedContinuation<[CompanionPath], Never>?
    private var found: [CompanionPath] = []
    private var browser: NWBrowser?
    private var resolving: [NWConnection] = []
    private var done = false

    init(machineId: String) {
        self.machineId = machineId
    }

    func run(timeout: Duration) async -> [CompanionPath] {
        await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<[CompanionPath], Never>) in
                let cancelledAlready = lock.withLock { () -> Bool in
                    if done { return true }
                    self.continuation = continuation
                    return false
                }
                if cancelledAlready {
                    continuation.resume(returning: [])
                    return
                }
                start()
                let seconds = Double(timeout.components.seconds) + Double(timeout.components.attoseconds) / 1e18
                queue.asyncAfter(deadline: .now() + seconds) { [weak self] in self?.finish() }
            }
        } onCancel: {
            self.finish()
        }
    }

    private func start() {
        let browser = NWBrowser(for: .bonjourWithTXTRecord(type: CompanionWire.bonjourService, domain: nil), using: .tcp)
        browser.browseResultsChangedHandler = { [weak self] results, _ in
            guard let self else { return }
            for result in results {
                guard case .bonjour(let record) = result.metadata,
                      CompanionBonjour.matches(txt: record.dictionary, machineId: self.machineId)
                else { continue }
                self.resolve(result.endpoint)
            }
        }
        browser.stateUpdateHandler = { [weak self] state in
            if case .failed = state { self?.finish() }
        }
        lock.withLock { self.browser = browser }
        browser.start(queue: queue)
    }

    private func resolve(_ endpoint: NWEndpoint) {
        let parameters = NWParameters.tcp
        if let ip = parameters.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options {
            ip.version = .v4
        }
        let connection = NWConnection(to: endpoint, using: parameters)
        let admitted = lock.withLock { () -> Bool in
            guard !done else { return false }
            resolving.append(connection)
            return true
        }
        guard admitted else { return }
        connection.stateUpdateHandler = { [weak self, weak connection] state in
            guard let self, let connection else { return }
            switch state {
            case .ready:
                if case .hostPort(let host, let port) = connection.currentPath?.remoteEndpoint,
                   case .ipv4(let address) = host,
                   let path = CompanionBonjour.directPath(host: "\(address)", port: port.rawValue) {
                    self.add(path)
                }
                connection.cancel()
            case .failed, .waiting:
                connection.cancel()
            default:
                break
            }
        }
        connection.start(queue: queue)
    }

    private func add(_ path: CompanionPath) {
        lock.withLock { if !found.contains(path) { found.append(path) } }
        finish()
    }

    private func finish() {
        let (pending, result, browser, connections): (CheckedContinuation<[CompanionPath], Never>?, [CompanionPath], NWBrowser?, [NWConnection]) =
            lock.withLock {
                guard !done else { return (nil, [], nil, []) }
                done = true
                defer {
                    continuation = nil
                    self.browser = nil
                    resolving = []
                }
                return (continuation, found, self.browser, resolving)
            }
        browser?.cancel()
        connections.forEach { $0.cancel() }
        pending?.resume(returning: result)
    }
}
