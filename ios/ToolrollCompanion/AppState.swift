import CryptoKit
import Foundation
import Observation
import ToolrollCompanionCore
import UIKit

@MainActor
@Observable
final class CompanionAppState {
    var connection: CompanionConnectionState = .unpaired
    var pairedRecord: PairedWorkspaceRecord?
    var workRows: [CompanionWorkRow] = []
    var isStaleCache: Bool = false
    var lastSeen: Date?
    var errorBanner: String?

    private let client = CompanionRelayClient()
    private static let recordStorageKey = "paired.workspace.record.v1"

    init() {
        if ProcessInfo.processInfo.arguments.contains("--demo") {
            enterDemoMode()
        } else {
            restoreSavedWorkspace()
        }
    }

    var isDemoMode: Bool {
        connection == .demo
    }

    func enterDemoMode() {
        errorBanner = nil
        connection = .demo
        isStaleCache = false
        lastSeen = Date()
        workRows = CompanionDemoFixtures.workRows
    }

    func exitDemoMode() {
        workRows = []
        connection = .unpaired
        restoreSavedWorkspace()
    }

    func startPairing(qrJson: String) async {
        errorBanner = nil
        guard let data = qrJson.data(using: .utf8),
              let qr = try? JSONDecoder().decode(PairingQRPayload.self, from: data),
              qr.v == 1
        else {
            errorBanner = "That QR code isn't a valid Toolroll pairing code."
            return
        }

        connection = .connecting
        let deviceName = UIDevice.current.name
        do {
            let result = try await client.beginPairing(qr: qr, deviceName: deviceName) { code in
                await MainActor.run {
                    self.connection = .awaitingMacConfirm(code: code, workspaceId: qr.workspaceId)
                }
            }
            // Persist keys strictly in Keychain `ThisDeviceOnly` (never synced to iCloud).
            try CompanionKeychain.save(result.devicePsk, account: "device.psk")
            try CompanionKeychain.save(result.phoneNoisePriv, account: "phone.noise.priv")
            try CompanionKeychain.save(result.deviceRelayPriv, account: "device.relay.priv")
            let encoded = try JSONEncoder().encode(result.record)
            UserDefaults.standard.set(encoded, forKey: Self.recordStorageKey)

            pairedRecord = result.record
            await reconnectIfPaired()
        } catch {
            connection = .unpaired
            errorBanner = "Pairing did not complete. Generate a fresh QR code on your Mac and try again."
        }
    }

    func reconnectIfPaired() async {
        guard !isDemoMode else { return }
        guard let record = pairedRecord,
              let devicePsk = CompanionKeychain.load(account: "device.psk"),
              let phoneNoisePriv = CompanionKeychain.load(account: "phone.noise.priv"),
              let deviceRelayPriv = CompanionKeychain.load(account: "device.relay.priv")
        else {
            connection = .unpaired
            return
        }

        connection = .connecting
        isStaleCache = !workRows.isEmpty
        do {
            let helloData = try await client.connect(
                record: record,
                devicePsk: devicePsk,
                phoneNoisePriv: phoneNoisePriv,
                deviceRelayPriv: deviceRelayPriv
            )
            let hello = (try? JSONSerialization.jsonObject(with: helloData) as? [String: Any]) ?? [:]
            let label = (hello["workspaceLabel"] as? String) ?? record.workspaceLabel
            lastSeen = Date()
            isStaleCache = false
            connection = .connected(workspaceLabel: label, connectedAt: Date())
            await refreshWork()
        } catch {
            // ADR 0004: Truthful unavailable status (NEVER claim "Mac is asleep").
            isStaleCache = !workRows.isEmpty
            connection = .unavailable(lastSeen: lastSeen, reason: "Could not reach workspace")
        }
    }

    func handleBackground() async {
        guard !isDemoMode else { return }
        await client.disconnect()
        if pairedRecord != nil {
            isStaleCache = !workRows.isEmpty
            connection = .unavailable(lastSeen: lastSeen, reason: "Disconnected in background")
        }
    }

    func refreshWork() async {
        if isDemoMode {
            workRows = CompanionDemoFixtures.workRows
            lastSeen = Date()
            return
        }
        do {
            _ = try await client.callUnary(method: "work.rows")
            lastSeen = Date()
            isStaleCache = false
        } catch {
            isStaleCache = !workRows.isEmpty
            connection = .unavailable(lastSeen: lastSeen, reason: "Refresh failed")
        }
    }

    func steps(for taskId: String) -> [CompanionStepCard] {
        CompanionDemoFixtures.steps(for: taskId)
    }

    func approvalTerms(for taskId: String) -> CompanionApprovalTerms? {
        CompanionDemoFixtures.approvalTerms(for: taskId)
    }

    func diffFiles(for taskId: String) -> [CompanionDiffFile] {
        CompanionDemoFixtures.diffFiles(for: taskId)
    }

    func liveRecords(for taskId: String) -> [CompanionLiveRecord] {
        CompanionDemoFixtures.liveRecords
    }

    func unpairThisPhone() async {
        if !isDemoMode {
            _ = try? await client.callUnary(method: "device.self.revoke")
            await client.disconnect()
        }
        CompanionKeychain.delete(account: "device.psk")
        CompanionKeychain.delete(account: "phone.noise.priv")
        CompanionKeychain.delete(account: "device.relay.priv")
        CompanionKeychain.delete(account: "push.p256.priv", sharedAppGroup: true)
        CompanionKeychain.delete(account: "push.auth.secret", sharedAppGroup: true)
        UserDefaults.standard.removeObject(forKey: Self.recordStorageKey)
        pairedRecord = nil
        workRows = []
        lastSeen = nil
        isStaleCache = false
        connection = .unpaired
    }

    /// Generates and stores the dedicated P-256 push keypair + 16-byte authSecret in the shared App Group Keychain.
    func ensurePushCryptoKeys() -> (p256dh: String, authSecret: String)? {
        let privKey: P256.KeyAgreement.PrivateKey
        if let existing = CompanionKeychain.load(account: "push.p256.priv", sharedAppGroup: true),
           let loaded = try? P256.KeyAgreement.PrivateKey(rawRepresentation: existing) {
            privKey = loaded
        } else {
            privKey = P256.KeyAgreement.PrivateKey()
            try? CompanionKeychain.save(privKey.rawRepresentation, account: "push.p256.priv", sharedAppGroup: true)
        }
        let auth: Data
        if let existingAuth = CompanionKeychain.load(account: "push.auth.secret", sharedAppGroup: true), existingAuth.count == 16 {
            auth = existingAuth
        } else {
            var bytes = [UInt8](repeating: 0, count: 16)
            _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
            auth = Data(bytes)
            try? CompanionKeychain.save(auth, account: "push.auth.secret", sharedAppGroup: true)
        }
        return (
            p256dh: CompanionRelayAuth.base64UrlEncode(privKey.publicKey.x963Representation),
            authSecret: CompanionRelayAuth.base64UrlEncode(auth)
        )
    }

    private func restoreSavedWorkspace() {
        guard let data = UserDefaults.standard.data(forKey: Self.recordStorageKey),
              let record = try? JSONDecoder().decode(PairedWorkspaceRecord.self, from: data)
        else {
            connection = .unpaired
            return
        }
        pairedRecord = record
        connection = .unavailable(lastSeen: record.pairedAt, reason: "Tap to reconnect")
    }
}
