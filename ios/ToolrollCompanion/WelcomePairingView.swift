import AVFoundation
import SwiftUI
import ToolrollCompanionCore

struct WelcomePairingView: View {
    @Bindable var appState: CompanionAppState
    @State private var showScanner = false
    @State private var showManualPaste = false
    @State private var pastedQr = ""

    var body: some View {
        NavigationStack {
            ZStack {
                ToolrollTheme.paper.ignoresSafeArea()

                if case let .awaitingMacConfirm(code, _) = appState.connection {
                    confirmCodeView(code: code)
                } else {
                    onboardingView
                }
            }
            .sheet(isPresented: $showScanner) {
                QRScannerSheet { payload in
                    showScanner = false
                    Task { await appState.startPairing(qrJson: payload) }
                }
            }
            .sheet(isPresented: $showManualPaste) {
                NavigationStack {
                    Form {
                        Section {
                            TextEditor(text: $pastedQr)
                                .font(.system(.caption, design: .monospaced))
                                .frame(minHeight: 160)
                        } header: {
                            Text("Pairing QR Payload (JSON)")
                        } footer: {
                            Text("Run `toolroll phone pair` on your Mac and paste the JSON payload here when testing on iOS Simulator.")
                        }
                    }
                    .navigationTitle("Paste Pairing Code")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Cancel") { showManualPaste = false }
                        }
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Pair") {
                                let payload = pastedQr
                                showManualPaste = false
                                Task { await appState.startPairing(qrJson: payload) }
                            }
                            .disabled(pastedQr.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        }
                    }
                }
            }
        }
    }

    private var onboardingView: some View {
        VStack(spacing: 0) {
            Spacer()

            VStack(spacing: 18) {
                ZStack {
                    RoundedRectangle(cornerRadius: 20, style: .continuous)
                        .fill(ToolrollTheme.ink)
                        .frame(width: 68, height: 68)
                    Image(systemName: "checklist.checked")
                        .font(.system(size: 30, weight: .semibold))
                        .foregroundStyle(ToolrollTheme.paper)
                }

                VStack(spacing: 8) {
                    Text("Toolroll")
                        .font(.system(size: 32, weight: .bold, design: .default))
                        .foregroundStyle(ToolrollTheme.ink)
                    Text("Your agents build. You decide.")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(ToolrollTheme.muted)
                }

                VStack(alignment: .leading, spacing: 12) {
                    featureRow(icon: "lock.shield", title: "End-to-end encrypted", detail: "Noise IKpsk2 directly to your Mac. The relay cannot read content or authorize anything.")
                    featureRow(icon: "doc.text.magnifyingglass", title: "Review diffs in your pocket", detail: "Inspect plans, passing checks, and sealed diffs from anywhere.")
                    featureRow(icon: "bell.badge", title: "Private notifications", detail: "Decrypted locally on your iPhone; task titles stay on your Mac by default.")
                }
                .padding(18)
                .background(ToolrollTheme.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .stroke(ToolrollTheme.hairline, lineWidth: 1)
                )
                .padding(.top, 12)

                if let error = appState.errorBanner {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(ToolrollTheme.vermilion)
                        .multilineTextAlignment(.center)
                }
            }
            .padding(.horizontal, 24)

            Spacer()

            VStack(spacing: 12) {
                Button {
                    showScanner = true
                } label: {
                    Label("Pair with your Mac", systemImage: "qrcode.viewfinder")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 15)
                        .background(ToolrollTheme.ink, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .foregroundStyle(ToolrollTheme.paper)
                }

                HStack(spacing: 16) {
                    Button {
                        showManualPaste = true
                    } label: {
                        Text("Paste code")
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(ToolrollTheme.muted)
                    }

                    Text("·")
                        .foregroundStyle(ToolrollTheme.muted)

                    Button {
                        appState.enterDemoMode()
                    } label: {
                        Text("Try Demo Workspace")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(ToolrollTheme.ink)
                    }
                }
                .padding(.top, 4)
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 28)
        }
    }

    private func confirmCodeView(code: String) -> some View {
        VStack(spacing: 24) {
            Spacer()
            StatusPill(label: "Confirm on your Mac", tint: ToolrollTheme.cobalt)
            Text(code)
                .font(.system(size: 44, weight: .bold, design: .monospaced))
                .tracking(3)
                .foregroundStyle(ToolrollTheme.ink)
                .padding(.horizontal, 28)
                .padding(.vertical, 18)
                .background(ToolrollTheme.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .stroke(ToolrollTheme.hairline, lineWidth: 1)
                )

            Text("Click **Confirm match** on your Mac only if your Mac is displaying this exact 6-character code.")
                .font(.subheadline)
                .foregroundStyle(ToolrollTheme.muted)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)

            ProgressView()
                .padding(.top, 8)
            Spacer()
            Button("Cancel pairing", role: .destructive) {
                Task { await appState.unpairThisPhone() }
            }
            .padding(.bottom, 24)
        }
    }

    private func featureRow(icon: String, title: String, detail: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.body.weight(.semibold))
                .foregroundStyle(ToolrollTheme.ink)
                .frame(width: 24)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(ToolrollTheme.ink)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(ToolrollTheme.muted)
            }
        }
    }
}

private struct QRScannerSheet: View {
    let onScanned: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                #if targetEnvironment(simulator)
                VStack(spacing: 14) {
                    Image(systemName: "camera.viewfinder")
                        .font(.system(size: 44))
                        .foregroundStyle(ToolrollTheme.muted)
                    Text("Camera unavailable in Simulator")
                        .font(.headline)
                    Text("Use \"Paste code\" on the welcome screen, or run on a physical iPhone to scan your Mac's QR code.")
                        .font(.subheadline)
                        .foregroundStyle(ToolrollTheme.muted)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 28)
                }
                #else
                CameraQRPreview(onScanned: onScanned)
                    .ignoresSafeArea(edges: .bottom)
                #endif
            }
            .navigationTitle("Scan Mac QR Code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
    }
}

#if !targetEnvironment(simulator)
private struct CameraQRPreview: UIViewControllerRepresentable {
    let onScanned: (String) -> Void

    func makeUIViewController(context: Context) -> QRScannerViewController {
        QRScannerViewController(onScanned: onScanned)
    }

    func updateUIViewController(_ uiViewController: QRScannerViewController, context: Context) {}
}

private final class QRScannerViewController: UIViewController, @preconcurrency AVCaptureMetadataOutputObjectsDelegate {
    private let onScanned: (String) -> Void
    private let session = AVCaptureSession()
    private var didDeliver = false

    init(onScanned: @escaping (String) -> Void) {
        self.onScanned = onScanned
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input)
        else { return }
        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.frame = view.bounds
        preview.videoGravity = .resizeAspectFill
        view.layer.addSublayer(preview)
        nonisolated(unsafe) let captureSession = self.session
        DispatchQueue.global(qos: .userInitiated).async {
            captureSession.startRunning()
        }
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard !didDeliver,
              let obj = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              let text = obj.stringValue
        else { return }
        didDeliver = true
        session.stopRunning()
        onScanned(text)
    }
}
#endif
