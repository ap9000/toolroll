import AppKit
import CoreImage
import CoreImage.CIFilterBuiltins
import Darwin
import SwiftUI
import ToolrollCore

struct PhonePairSheet: View {
    @Bindable var store: WorkbenchStore
    @Environment(\.dismiss) private var dismiss
    @State private var copied = false

    private var pairURLString: String {
        let raw = store.activeProfile.origin.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: raw) else { return raw }
        let host = (url.host ?? "").lowercased()
        if host == "127.0.0.1" || host == "localhost" {
            if let lanIP = Self.localLANIPv4() {
                var comps = URLComponents(url: url, resolvingAgainstBaseURL: false)
                comps?.host = lanIP
                return comps?.string ?? raw
            }
        }
        return raw
    }

    private var isLoopbackOnly: Bool {
        pairURLString.contains("127.0.0.1") || pairURLString.contains("localhost")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Pair Phone for Push Approvals")
                        .font(.system(size: 15.5, weight: .semibold))
                        .foregroundStyle(ToolrollPalette.ink)
                    Text("Approve plans, answer agent questions, and inspect reviews from your phone.")
                        .font(.system(size: 11.5))
                        .foregroundStyle(ToolrollPalette.muted)
                }
                Spacer()
                Button("Done") { dismiss() }
                    .buttonStyle(KitButtonStyle(.ghost, compact: true))
            }

            HairlineDivider()

            HStack(alignment: .top, spacing: 20) {
                VStack(spacing: 8) {
                    if let qrImage = Self.makeQRCode(from: pairURLString) {
                        Image(nsImage: qrImage)
                            .interpolation(.none)
                            .resizable()
                            .scaledToFit()
                            .frame(width: 172, height: 172)
                            .padding(10)
                            .background(Color.white, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))
                    }
                    Text("Scan with iPhone / Android Camera")
                        .font(.system(size: 10.5))
                        .foregroundStyle(ToolrollPalette.muted)
                }

                VStack(alignment: .leading, spacing: 12) {
                    stepItem(number: "1", title: "Open Toolroll on your phone", detail: "Scan the QR code on the left (same Wi-Fi or your HTTPS team workspace).")
                    stepItem(number: "2", title: "Add to Home Screen", detail: "Tap Share → Add to Home Screen in Safari to install Toolroll's Mobile PWA.")
                    stepItem(number: "3", title: "Enable Push Alerts", detail: "In Settings → Notifications, tap \"Get alerts on this device\" for instant encrypted VAPID push pings.")

                    if isLoopbackOnly {
                        Text("Tip: Your local engine is bound to loopback. Connect a remote HTTPS workspace or bind to LAN/Tailscale to reach it off-Mac.")
                            .font(.system(size: 10.5))
                            .foregroundStyle(ToolrollPalette.warning)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }

            HStack(spacing: 8) {
                Text(pairURLString)
                    .font(.system(size: 11.5, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.ink)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
                Spacer()
                Button(copied ? "Copied" : "Copy URL") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(pairURLString, forType: .string)
                    copied = true
                    Task {
                        try? await Task.sleep(for: .seconds(1.5))
                        copied = false
                    }
                }
                .buttonStyle(KitButtonStyle(.ghost, compact: true))
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(ToolrollPalette.codeBg, in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(ToolrollPalette.line, lineWidth: 1))
        }
        .padding(20)
        .frame(width: 540)
        .background(ToolrollPalette.paper)
    }

    private func stepItem(number: String, title: String, detail: String) -> some View {
        HStack(alignment: .top, spacing: 9) {
            Text(number)
                .font(.system(size: 10.5, weight: .bold, design: .monospaced))
                .foregroundStyle(ToolrollPalette.inverseInk)
                .frame(width: 18, height: 18)
                .background(ToolrollPalette.ink, in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.ink)
                Text(detail)
                    .font(.system(size: 11))
                    .foregroundStyle(ToolrollPalette.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private static func makeQRCode(from string: String) -> NSImage? {
        let context = CIContext()
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(string.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: 8, y: 8))
        guard let cg = context.createCGImage(scaled, from: scaled.extent) else { return nil }
        return NSImage(cgImage: cg, size: NSSize(width: cg.width, height: cg.height))
    }

    private static func localLANIPv4() -> String? {
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0, let first = ifaddr else { return nil }
        defer { freeifaddrs(ifaddr) }

        var fallback: String? = nil
        var ptr: UnsafeMutablePointer<ifaddrs>? = first
        while let current = ptr {
            let addr = current.pointee
            let flags = Int32(addr.ifa_flags)
            let isUp = (flags & (IFF_UP | IFF_RUNNING)) == (IFF_UP | IFF_RUNNING)
            let isLoopback = (flags & IFF_LOOPBACK) != 0
            if isUp && !isLoopback, let sa = addr.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET) {
                var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                if getnameinfo(sa, socklen_t(sa.pointee.sa_len), &hostname, socklen_t(hostname.count), nil, 0, NI_NUMERICHOST) == 0 {
                    let ip = String(decoding: hostname.prefix(while: { $0 != 0 }).map { UInt8(bitPattern: $0) }, as: UTF8.self)
                    let name = String(cString: addr.ifa_name)
                    if name == "en0" { return ip }
                    if fallback == nil && !ip.hasPrefix("169.254.") { fallback = ip }
                }
            }
            ptr = addr.ifa_next
        }
        return fallback
    }
}
