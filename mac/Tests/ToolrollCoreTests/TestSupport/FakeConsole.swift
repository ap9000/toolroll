import CryptoKit
import Darwin
import Foundation
import SQLite3

/// A stand-in for the local Toolroll console that `LocalConsoleConnector.discoverAndConnect()` finds: its database row and
/// its Unix-socket `link` handshake, in a temp folder of this test process's own. Creating it points `TOOLROLL_DB` and
/// `XDG_CONFIG_HOME` at that folder (process-wide, once, never unset), so no test that reconnects can reach the person's
/// real console under `~/.config`. The one-time code it hands out is redeemed over `URLSession.shared` at `port`, which
/// `FakeConsoleRedeemProtocol` answers from `StubRegistry`.
final class FakeConsole: @unchecked Sendable {
    /// The origin port the redeemed session names. Nothing listens on it: the stub protocols answer it.
    static let port = 47_099
    static let secret = "fake-console-secret"

    static let shared = FakeConsole()

    let dir: String
    private let lock = NSLock()
    private var handshakes = 0
    private var refusing = false

    private init() {
        var template = Array("/tmp/trq.XXXXXX".utf8CString)
        guard let made = mkdtemp(&template) else { fatalError("mkdtemp failed") }
        dir = String(cString: made)
        let dbPath = "\(dir)/orders.db"
        Self.writeInstanceRow(dbPath: dbPath)
        let runDir = "\(dir)/.toolroll-run"
        mkdir(runDir, 0o700)
        let listener = Self.listen(at: "\(runDir)/c.sock")
        setenv("TOOLROLL_DB", dbPath, 1)
        setenv("XDG_CONFIG_HOME", "\(dir)/config", 1)
        URLProtocol.registerClass(FakeConsoleRedeemProtocol.self)
        // The temp folder goes when the test process ends (atexit takes no context, so it reads the one shared path).
        atexit { try? FileManager.default.removeItem(atPath: FakeConsole.shared.dir) }
        let thread = Thread { [unowned self] in self.serve(listener) }
        thread.start()
    }

    /// How many `link` handshakes completed since the last reset.
    var handshakeCount: Int {
        lock.lock(); defer { lock.unlock() }
        return handshakes
    }

    /// `refuse`: the console answers the handshake without a link (as if it went away), so reconnecting fails.
    func reset(refuse: Bool) {
        lock.lock(); defer { lock.unlock() }
        handshakes = 0
        refusing = refuse
    }

    private static func writeInstanceRow(dbPath: String) {
        var db: OpaquePointer?
        guard sqlite3_open(dbPath, &db) == SQLITE_OK, let db else { fatalError("sqlite open failed") }
        defer { sqlite3_close(db) }
        let sql = """
        CREATE TABLE console_instance (id INTEGER PRIMARY KEY, secret TEXT, pid INTEGER, port INTEGER, socket TEXT);
        INSERT INTO console_instance VALUES (1, '\(secret)', \(getpid()), \(port), 'c.sock');
        """
        guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else { fatalError("sqlite write failed") }
    }

    private static func listen(at path: String) -> Int32 {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        precondition(fd >= 0, "socket failed")
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        precondition(bytes.count < MemoryLayout.size(ofValue: addr.sun_path), "socket path too long")
        withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
            ptr.withMemoryRebound(to: UInt8.self, capacity: bytes.count + 1) { dst in
                for i in 0..<bytes.count { dst[i] = bytes[i] }
                dst[bytes.count] = 0
            }
        }
        let bound = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        precondition(bound == 0 && Darwin.listen(fd, 8) == 0, "bind/listen failed")
        return fd
    }

    private func serve(_ listener: Int32) {
        while true {
            let conn = accept(listener, nil, nil)
            if conn < 0 { continue }
            handle(conn)
            close(conn)
        }
    }

    private func handle(_ conn: Int32) {
        guard Self.readLine(conn)?.contains("\"link\"") == true else { return }
        let challenge = UUID().uuidString
        Self.writeLine(conn, #"{"challenge":"\#(challenge)"}"#)
        guard let proofLine = Self.readLine(conn),
              let obj = try? JSONSerialization.jsonObject(with: Data(proofLine.utf8)) as? [String: Any],
              let proof = obj["proof"] as? String
        else { return }
        let mac = HMAC<SHA256>.authenticationCode(for: Data("link:\(challenge)".utf8), using: SymmetricKey(data: Data(Self.secret.utf8)))
        let expected = mac.map { String(format: "%02x", $0) }.joined()
        lock.lock()
        let refuse = refusing
        if !refuse && proof == expected { handshakes += 1 }
        let n = handshakes
        lock.unlock()
        if refuse || proof != expected {
            Self.writeLine(conn, #"{"error":"no link"}"#)
        } else {
            Self.writeLine(conn, #"{"link":"/login/once/code-\#(n)"}"#)
        }
    }

    private static func writeLine(_ fd: Int32, _ line: String) {
        let bytes = Array((line + "\n").utf8)
        _ = bytes.withUnsafeBytes { write(fd, $0.baseAddress!, bytes.count) }
    }

    private static func readLine(_ fd: Int32) -> String? {
        var buffer = Data()
        var byte: UInt8 = 0
        while buffer.count < 4096, read(fd, &byte, 1) == 1, byte != 0x0A { buffer.append(byte) }
        return buffer.isEmpty ? nil : String(data: buffer, encoding: .utf8)
    }
}
