import AVFoundation
import SwiftUI
import ToolrollCompanionCore

struct WelcomePairingView: View {
    @Bindable var appState: CompanionAppState
    @State private var scanner: ScannerMode?

    enum ScannerMode: String, Identifiable {
        case scan
        case paste
        var id: String { rawValue }
    }

    var body: some View {
        ZStack {
            ToolrollTheme.paper.ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    VStack(alignment: .leading, spacing: 14) {
                        BrandMark(size: 56)
                        Text("Toolroll")
                            .font(.largeTitle.weight(.bold))
                            .foregroundStyle(ToolrollTheme.ink)
                        Text("See what your agents need from you, wherever you are.")
                            .font(.title3)
                            .foregroundStyle(ToolrollTheme.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        Text("To pair")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(ToolrollTheme.muted)
                        Text("On your Mac, open Toolroll → Settings → Phone → **Pair an iPhone**, then scan the code it shows.")
                            .font(.body)
                            .foregroundStyle(ToolrollTheme.ink)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .card()

                    if let message = appState.pairingError ?? appState.notice {
                        Text(message)
                            .font(.callout)
                            .foregroundStyle(appState.pairingError != nil ? ToolrollTheme.danger : ToolrollTheme.ink)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.horizontal, 24)
                .padding(.top, 72)
                .padding(.bottom, 24)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 12) {
                Button {
                    appState.notice = nil
                    scanner = .scan
                } label: {
                    Label("Pair with your Mac", systemImage: "qrcode.viewfinder")
                }
                .buttonStyle(InkButtonStyle())

                Button("Try the demo") {
                    appState.enterDemoMode()
                }
                .buttonStyle(OutlineButtonStyle())
            }
            .padding(.horizontal, 24)
            .padding(.top, 12)
            .padding(.bottom, 12)
            .background(ToolrollTheme.paper)
        }
        .sheet(item: $scanner) { mode in
            PairingScannerSheet(startOnPaste: mode == .paste) { payload in
                scanner = nil
                appState.startPairing(payload: payload)
            }
        }
        .onAppear {
            #if DEBUG
            if let screen = appState.debugScreen, let mode = ScannerMode(rawValue: screen) {
                scanner = mode
                appState.debugScreen = nil
            }
            #endif
        }
    }
}

/// Scan the Mac's QR code; "Can't scan?" pastes the pairing code instead (the simulator has no camera).
struct PairingScannerSheet: View {
    let onPayload: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var showPaste = false
    private let startOnPaste: Bool

    init(startOnPaste: Bool = false, onPayload: @escaping (String) -> Void) {
        self.onPayload = onPayload
        self.startOnPaste = startOnPaste
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                scanner
                    .frame(maxWidth: .infinity, maxHeight: .infinity)

                VStack(spacing: 10) {
                    #if !targetEnvironment(simulator)
                    Text("Point your camera at the code on your Mac.")
                        .font(.callout)
                        .foregroundStyle(ToolrollTheme.ink)
                        .multilineTextAlignment(.center)
                    #endif
                    Button("Can't scan? Paste pairing code") { showPaste = true }
                        .font(.callout.weight(.semibold))
                        .foregroundStyle(ToolrollTheme.ink)
                        .underline()
                        .frame(minHeight: 44)
                }
                .padding(.horizontal, 24)
                .padding(.vertical, 16)
                .frame(maxWidth: .infinity)
                .background(ToolrollTheme.paper)
            }
            .background(ToolrollTheme.paper.ignoresSafeArea())
            .navigationTitle("Scan your Mac's code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .navigationDestination(isPresented: $showPaste) {
                PastePairingCodeView(onSubmit: onPayload)
            }
            .task {
                if startOnPaste {
                    try? await Task.sleep(for: .milliseconds(300))
                    showPaste = true
                }
            }
        }
    }

    @ViewBuilder
    private var scanner: some View {
        #if targetEnvironment(simulator)
        VStack(spacing: 12) {
            Image(systemName: "camera")
                .font(.system(size: 36))
                .foregroundStyle(ToolrollTheme.muted)
            Text("No camera here")
                .font(.headline)
                .foregroundStyle(ToolrollTheme.ink)
            Text("Paste the pairing code instead.")
                .font(.subheadline)
                .foregroundStyle(ToolrollTheme.muted)
        }
        #else
        CameraScanner(onScanned: onPayload)
            .ignoresSafeArea(edges: .horizontal)
        #endif
    }
}

private struct PastePairingCodeView: View {
    let onSubmit: (String) -> Void
    @State private var text = ""

    var body: some View {
        Form {
            Section {
                TextEditor(text: $text)
                    .font(.footnote.monospaced())
                    .frame(minHeight: 140)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .accessibilityLabel("Pairing code")
            } footer: {
                Text("Paste the pairing code your Mac shows next to its QR code. It works once and expires in a few minutes.")
            }
        }
        .scrollContentBackground(.hidden)
        .background(ToolrollTheme.paper.ignoresSafeArea())
        .navigationTitle("Paste pairing code")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Pair") {
                    let payload = text
                    text = ""
                    onSubmit(payload)
                }
                .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .onDisappear { text = "" }
    }
}

/// Shown while a pairing runs: contacting the Mac, then the code to compare.
struct PairingProgressView: View {
    let appState: CompanionAppState

    var body: some View {
        ZStack {
            ToolrollTheme.paper.ignoresSafeArea()
            VStack(spacing: 24) {
                Spacer()
                switch appState.pairing {
                case .awaitingMacConfirm(let code):
                    Text("Check the code on your Mac")
                        .font(.title2.weight(.bold))
                        .foregroundStyle(ToolrollTheme.ink)
                        .multilineTextAlignment(.center)
                    Text(code)
                        .font(.system(.largeTitle, design: .monospaced).weight(.bold))
                        .tracking(4)
                        .foregroundStyle(ToolrollTheme.ink)
                        .padding(.horizontal, 28)
                        .padding(.vertical, 18)
                        .card()
                        .accessibilityLabel("Code \(code.map(String.init).joined(separator: " "))")
                    Text("If your Mac shows the same code, choose **Codes match — pair** there. If not, cancel.")
                        .font(.body)
                        .foregroundStyle(ToolrollTheme.muted)
                        .multilineTextAlignment(.center)
                    ProgressView()
                default:
                    ProgressView()
                    Text("Contacting your Mac…")
                        .font(.headline)
                        .foregroundStyle(ToolrollTheme.ink)
                }
                Spacer()
                Button("Cancel pairing") { appState.cancelPairing() }
                    .buttonStyle(OutlineButtonStyle())
            }
            .padding(24)
        }
    }
}

#if !targetEnvironment(simulator)
private struct CameraScanner: UIViewControllerRepresentable {
    let onScanned: (String) -> Void

    func makeUIViewController(context: Context) -> QRScannerViewController {
        QRScannerViewController(onScanned: onScanned)
    }

    func updateUIViewController(_ uiViewController: QRScannerViewController, context: Context) {}

    static func dismantleUIViewController(_ controller: QRScannerViewController, coordinator: ()) {
        controller.stop()
    }
}

private final class QRScannerViewController: UIViewController, @preconcurrency AVCaptureMetadataOutputObjectsDelegate {
    private let onScanned: (String) -> Void
    private let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "dev.toolroll.companion.camera")
    private var didDeliver = false
    private var preview: AVCaptureVideoPreviewLayer?

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
        else {
            showUnavailable()
            return
        }
        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else {
            showUnavailable()
            return
        }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        view.layer.addSublayer(layer)
        preview = layer
        nonisolated(unsafe) let captureSession = session
        sessionQueue.async { captureSession.startRunning() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    func stop() {
        nonisolated(unsafe) let captureSession = session
        sessionQueue.async { captureSession.stopRunning() }
    }

    private func showUnavailable() {
        let label = UILabel()
        label.text = "The camera isn't available. Paste the pairing code instead."
        label.textColor = .white
        label.numberOfLines = 0
        label.textAlignment = .center
        label.font = .preferredFont(forTextStyle: .body)
        label.adjustsFontForContentSizeCategory = true
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            label.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            label.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
        ])
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
        stop()
        onScanned(text)
    }
}
#endif
