import CryptoKit
import Darwin
import Foundation
import SQLite3

public struct LocalSessionCredentials: Sendable, Equatable {
    public let origin: String
    public let account: String
    public let cookieHeader: String
    public let csrf: String
    public let key: String
    public let epoch: String
    public let databasePath: String
    public let passwordSet: Bool?

    public init(
        origin: String,
        account: String,
        cookieHeader: String,
        csrf: String,
        key: String,
        epoch: String,
        databasePath: String,
        passwordSet: Bool? = nil
    ) {
        self.origin = origin
        self.account = account
        self.cookieHeader = cookieHeader
        self.csrf = csrf
        self.key = key
        self.epoch = epoch
        self.databasePath = databasePath
        self.passwordSet = passwordSet
    }
}

public enum LocalConsoleConnector {
    private struct InstanceRow {
        let secret: String
        let pid: Int
        let port: Int
        let socket: String
        let databasePath: String
    }

    private struct RedeemPayload: Decodable {
        struct CookieObj: Decodable {
            let name: String
            let value: String
        }
        let version: Int
        let account: String
        let cookie: CookieObj
        let csrf: String
        let key: String
        let epoch: String
        let passwordSet: Bool?
    }

    public static func discoverAndConnect(session: URLSession = .shared) async -> LocalSessionCredentials? {
        for dbPath in candidateDatabasePaths() {
            guard FileManager.default.fileExists(atPath: dbPath),
                  let row = readConsoleInstance(databasePath: dbPath)
            else { continue }

            let dir = (dbPath as NSString).deletingLastPathComponent
            let socketPath = ((dir as NSString).appendingPathComponent(".toolroll-run") as NSString)
                .appendingPathComponent(row.socket)
            guard FileManager.default.fileExists(atPath: socketPath),
                  let linkPath = requestOneTimeLink(socketPath: socketPath, secret: row.secret)
            else { continue }

            let prefix = "/login/once/"
            guard linkPath.hasPrefix(prefix) else { continue }
            let code = String(linkPath.dropFirst(prefix.count))
            let origin = "http://127.0.0.1:\(row.port)"
            if let creds = try? await redeemOneTimeCode(
                origin: origin,
                code: code,
                databasePath: dbPath,
                session: session
            ) {
                return creds
            }
        }
        return nil
    }

    public static func candidateDatabasePaths() -> [String] {
        var paths: [String] = []
        if let envDb = ProcessInfo.processInfo.environment["TOOLROLL_DB"], !envDb.isEmpty {
            paths.append(envDb)
        }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let xdg = ProcessInfo.processInfo.environment["XDG_CONFIG_HOME"]
        let configRoot = (xdg != nil && !(xdg ?? "").isEmpty) ? xdg! : "\(home)/.config"
        paths.append("\(configRoot)/nightorders/orders.db")
        paths.append("\(configRoot)/toolroll/orders.db")
        paths.append("\(configRoot)/standing-orders/orders.db")
        return paths
    }

    private static func readConsoleInstance(databasePath: String) -> InstanceRow? {
        var db: OpaquePointer?
        guard sqlite3_open_v2(databasePath, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK, let db else {
            if let db { sqlite3_close(db) }
            return nil
        }
        defer { sqlite3_close(db) }

        var stmt: OpaquePointer?
        let sql = "SELECT secret, pid, port, socket FROM console_instance WHERE id = 1"
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
            return nil
        }
        defer { sqlite3_finalize(stmt) }

        guard sqlite3_step(stmt) == SQLITE_ROW else { return nil }
        guard let cSecret = sqlite3_column_text(stmt, 0),
              let cSocket = sqlite3_column_text(stmt, 3)
        else { return nil }

        let secret = String(cString: cSecret)
        let pid = Int(sqlite3_column_int64(stmt, 1))
        let port = Int(sqlite3_column_int64(stmt, 2))
        let socket = String(cString: cSocket)
        guard port > 0 && port <= 65535 && !secret.isEmpty && !socket.isEmpty else { return nil }
        return InstanceRow(secret: secret, pid: pid, port: port, socket: socket, databasePath: databasePath)
    }

    private static func requestOneTimeLink(socketPath: String, secret: String) -> String? {
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        defer { Darwin.close(fd) }

        var timeout = timeval(tv_sec: 3, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(socketPath.utf8)
        let maxLen = MemoryLayout.size(ofValue: addr.sun_path) - 1
        guard pathBytes.count <= maxLen else { return nil }
        withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
            ptr.withMemoryRebound(to: UInt8.self, capacity: maxLen + 1) { dst in
                for i in 0..<pathBytes.count { dst[i] = pathBytes[i] }
                dst[pathBytes.count] = 0
            }
        }

        let connectResult = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                Darwin.connect(fd, sa, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connectResult == 0 else { return nil }

        guard writeLine(fd: fd, line: #"{"verb":"link"}"#),
              let firstLine = readLine(fd: fd),
              let firstData = firstLine.data(using: .utf8),
              let firstObj = try? JSONSerialization.jsonObject(with: firstData) as? [String: Any],
              let challenge = firstObj["challenge"] as? String
        else { return nil }

        let key = SymmetricKey(data: Data(secret.utf8))
        let mac = HMAC<SHA256>.authenticationCode(for: Data("link:\(challenge)".utf8), using: key)
        let proofHex = mac.map { String(format: "%02x", $0) }.joined()

        guard writeLine(fd: fd, line: #"{"verb":"link-proof","proof":"\#(proofHex)"}"#),
              let secondLine = readLine(fd: fd),
              let secondData = secondLine.data(using: .utf8),
              let secondObj = try? JSONSerialization.jsonObject(with: secondData) as? [String: Any],
              let link = secondObj["link"] as? String
        else { return nil }

        return link
    }

    private static func writeLine(fd: Int32, line: String) -> Bool {
        let bytes = Array((line + "\n").utf8)
        var offset = 0
        while offset < bytes.count {
            let written = bytes.withUnsafeBytes { raw in
                Darwin.write(fd, raw.baseAddress!.advanced(by: offset), bytes.count - offset)
            }
            if written <= 0 { return false }
            offset += written
        }
        return true
    }

    private static func readLine(fd: Int32) -> String? {
        var buffer = Data()
        var byte: UInt8 = 0
        while buffer.count < 4096 {
            let n = Darwin.read(fd, &byte, 1)
            if n <= 0 { break }
            if byte == 0x0A { break }
            buffer.append(byte)
        }
        guard !buffer.isEmpty else { return nil }
        return String(data: buffer, encoding: .utf8)
    }

    private static func redeemOneTimeCode(
        origin: String,
        code: String,
        databasePath: String,
        session: URLSession
    ) async throws -> LocalSessionCredentials {
        guard let url = URL(string: "\(origin)/login/once") else {
            throw ToolrollClientError.invalidOrigin(origin)
        }
        var req = URLRequest(url: url, timeoutInterval: 10)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("terminal", forHTTPHeaderField: "x-toolroll-client")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["code": code])

        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            throw ToolrollClientError.unauthenticated
        }
        let redeemed = try JSONDecoder().decode(RedeemPayload.self, from: data)
        return LocalSessionCredentials(
            origin: origin,
            account: redeemed.account,
            cookieHeader: "\(redeemed.cookie.name)=\(redeemed.cookie.value)",
            csrf: redeemed.csrf,
            key: redeemed.key,
            epoch: redeemed.epoch,
            databasePath: databasePath,
            passwordSet: redeemed.passwordSet
        )
    }
}
