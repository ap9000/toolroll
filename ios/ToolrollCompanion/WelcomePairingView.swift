import AVFoundation
import SwiftUI
import ToolrollCompanionCore

struct WelcomePairingView: View {
    @Bindable var appState: CompanionAppState
    @State private var scanner: ScannerMode?
    @State private var showSecurity = false
    @Environment(\.toolrollAppearance) private var appearance

    enum ScannerMode: String, Identifiable {
        case scan
        case paste
        /// DEBUG screenshots only: the camera-off state on the Simulator.
        case cameraOff = "camera-off"
        var id: String { rawValue }
    }

    var body: some View {
        ZStack {
            ToolrollTheme.paper.ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 12) {
                        BrandMark(size: 52)
                        Text("Toolroll")
                            .font(.largeTitle.weight(.bold))
                            .foregroundStyle(ToolrollTheme.ink)
                        Text("Review plans, inspect diffs, and approve work from your iPhone")
                            .font(.title3)
                            .foregroundStyle(ToolrollTheme.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    VStack(spacing: 0) {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("Pair in two steps")
                                .font(.footnote.weight(.medium))
                                .foregroundStyle(ToolrollTheme.muted)

                            pairingStep(number: "1", text: "On your Mac, open **Settings → Phone** and choose **Pair an iPhone**")
                            pairingStep(number: "2", text: "Scan the QR code and confirm the six-character match on both screens")
                        }
                        .padding(16)
                        .frame(maxWidth: .infinity, alignment: .leading)

                        Divider().overlay(ToolrollTheme.hairline).padding(.leading, 16)

                        Button {
                            showSecurity = true
                        } label: {
                            HStack {
                                Label("End-to-end encrypted · How it's secured", systemImage: "lock.shield")
                                    .font(.footnote.weight(.medium))
                                    .foregroundStyle(ToolrollTheme.ink)
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(ToolrollTheme.subtle)
                            }
                            .padding(.horizontal, 16)
                            .padding(.vertical, 12)
                            .frame(minHeight: 44)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                    .card()

                    if let error = appState.pairingError {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(appState.pairingErrorTitle)
                                .font(.headline)
                                .foregroundStyle(ToolrollTheme.danger)
                            Text(error)
                                .font(.callout)
                                .foregroundStyle(ToolrollTheme.ink)
                                .fixedSize(horizontal: false, vertical: true)
                            if error == CompanionAppState.localNetworkMessage {
                                Button("Open Settings") {
                                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                                }
                                .font(.callout.weight(.semibold))
                                .foregroundStyle(ToolrollTheme.ink)
                                .frame(minHeight: 44)
                            }
                        }
                        .accessibilityElement(children: .contain)
                    } else if let message = appState.notice {
                        Text(message)
                            .font(.callout)
                            .foregroundStyle(ToolrollTheme.ink)
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
                    // Ask for Local Network now, before the camera: a prompt mid-pairing would stall the direct path.
                    LocalNetworkAccess.requestPrompt()
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
        .sheet(isPresented: $showSecurity) {
            NavigationStack {
                ScrollView {
                    HowItsSecured()
                        .padding(24)
                }
                .background(ToolrollTheme.paper.ignoresSafeArea())
                .navigationTitle("How it's secured")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { showSecurity = false }
                            .foregroundStyle(ToolrollTheme.ink)
                    }
                }
            }
            .presentationDetents([.medium, .large])
        }
        .sheet(item: $scanner) { mode in
            PairingScannerSheet(deviceName: $appState.deviceName, startOnPaste: mode == .paste, debugCameraOff: mode == .cameraOff) { payload in
                scanner = nil
                appState.startPairing(payload: payload)
            }
        }
        .onChange(of: scanner) { _, mode in appState.presentingSystemUI = mode != nil }
        .onAppear {
            #if DEBUG
            if let screen = appState.debugScreen, let mode = ScannerMode(rawValue: screen) {
                scanner = mode
                appState.debugScreen = nil
            }
            #endif
        }
    }

    private func pairingStep(number: String, text: LocalizedStringKey) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text(number)
                .font(.caption.monospaced().weight(.bold))
                .foregroundStyle(appearance.onSignal)
                .frame(width: 20, height: 20)
                .background(appearance.signal, in: Circle())
            Text(text)
                .font(.subheadline)
                .foregroundStyle(ToolrollTheme.ink)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// Scan the Mac's QR code; "Can't scan?" pastes the pairing code instead (the simulator has no camera). The name the
/// Mac will show for this iPhone is set here, before anything is sent.
struct PairingScannerSheet: View {
    @Binding var deviceName: String
    let onPayload: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var showPaste = false
    @State private var camera: CameraAccess = .checking
    private let startOnPaste: Bool
    private let debugCameraOff: Bool

    enum CameraAccess {
        case checking
        case allowed
        case off
    }

    init(deviceName: Binding<String>, startOnPaste: Bool = false, debugCameraOff: Bool = false, onPayload: @escaping (String) -> Void) {
        _deviceName = deviceName
        self.onPayload = onPayload
        self.startOnPaste = startOnPaste
        self.debugCameraOff = debugCameraOff
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                scanner
                    .frame(maxWidth: .infinity, maxHeight: .infinity)

                VStack(spacing: 12) {
                    DeviceNameField(name: $deviceName)
                    if camera == .allowed {
                        Text("Point your camera at the code on your Mac.")
                            .font(.callout)
                            .foregroundStyle(ToolrollTheme.ink)
                            .multilineTextAlignment(.center)
                    }
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
                PastePairingCodeView(deviceName: $deviceName, onSubmit: onPayload)
            }
            .task {
                camera = await Self.cameraAccess(debugOff: debugCameraOff)
                if startOnPaste {
                    try? await Task.sleep(for: .milliseconds(300))
                    showPaste = true
                }
            }
        }
    }

    /// Asks once; a camera turned off for Toolroll (or restricted) is named, with the way to turn it on (U5).
    private static func cameraAccess(debugOff: Bool) async -> CameraAccess {
        #if DEBUG
        if debugOff { return .off }
        #endif
        #if targetEnvironment(simulator)
        return .off
        #else
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return .allowed
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: .video) ? .allowed : .off
        default: return .off
        }
        #endif
    }

    @ViewBuilder
    private var scanner: some View {
        switch camera {
        case .checking:
            ProgressView()
                .accessibilityLabel("Opening the camera")
        case .off:
            #if targetEnvironment(simulator)
            if debugCameraOff {
                CameraOffView()
            } else {
                VStack(spacing: 12) {
                    Image(systemName: "camera")
                        .font(.system(size: 36))
                        .foregroundStyle(ToolrollTheme.muted)
                        .accessibilityHidden(true)
                    Text("No camera here")
                        .font(.headline)
                        .foregroundStyle(ToolrollTheme.ink)
                    Text("Paste the pairing code instead.")
                        .font(.subheadline)
                        .foregroundStyle(ToolrollTheme.muted)
                }
            }
            #else
            CameraOffView()
            #endif
        case .allowed:
            #if targetEnvironment(simulator)
            EmptyView()
            #else
            CameraScanner(onScanned: onPayload)
                .ignoresSafeArea(edges: .horizontal)
            #endif
        }
    }
}

/// The camera is turned off for Toolroll: say so and open the app's Settings page.
private struct CameraOffView: View {
    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "camera.badge.ellipsis")
                .font(.system(size: 36))
                .foregroundStyle(ToolrollTheme.muted)
                .accessibilityHidden(true)
            Text("Camera access is off for Toolroll")
                .font(.headline)
                .foregroundStyle(ToolrollTheme.ink)
                .multilineTextAlignment(.center)
            Text("Turn on Camera for Toolroll in Settings to scan the code, or paste the pairing code instead.")
                .font(.subheadline)
                .foregroundStyle(ToolrollTheme.muted)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            Button("Open Settings") {
                if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
            }
            .buttonStyle(OutlineButtonStyle())
            .frame(maxWidth: 280)
        }
        .padding(24)
    }
}

/// "Name this iPhone": what the Mac's phone list will call it (prefilled with the model, e.g. "iPhone 16 Pro").
struct DeviceNameField: View {
    @Binding var name: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Name this iPhone")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(ToolrollTheme.ink)
            TextField("iPhone", text: $name)
                .font(.system(size: 15))
                .textInputAutocapitalization(.words)
                .autocorrectionDisabled()
                .submitLabel(.done)
                .padding(.horizontal, 14)
                .frame(minHeight: 48)
                .background(ToolrollTheme.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(ToolrollTheme.controlLine, lineWidth: 1))
                .accessibilityLabel("Name this iPhone")
                .accessibilityHint("Your Mac shows this name in its list of phones.")
                .onChange(of: name) { _, value in
                    if value.count > CompanionWire.maxDeviceNameLength { name = String(value.prefix(CompanionWire.maxDeviceNameLength)) }
                }
            Text("Shown on your Mac under Settings → Phone.")
                .font(.system(size: 12.5))
                .foregroundStyle(ToolrollTheme.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Pair by pasting the code from the Mac (no camera, or the Simulator).
private struct PastePairingCodeView: View {
    @Binding var deviceName: String
    let onSubmit: (String) -> Void
    @State private var text = ""

    private var hasCode: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("On your Mac, open Toolroll → Settings → Phone → Pair an iPhone. Under the QR code, open **Can't scan?** and copy the code. Paste it here.")
                    .font(.subheadline)
                    .foregroundStyle(ToolrollTheme.body)
                    .fixedSize(horizontal: false, vertical: true)

                VStack(alignment: .leading, spacing: 8) {
                    Text("Pairing code")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(ToolrollTheme.ink)
                    ZStack(alignment: .topLeading) {
                        TextEditor(text: $text)
                            .font(.footnote.monospaced())
                            .scrollContentBackground(.hidden)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                            .frame(minHeight: 84)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .accessibilityLabel("Pairing code")
                        if text.isEmpty {
                            Text("Paste the code from your Mac")
                                .font(.footnote.monospaced())
                                .foregroundStyle(ToolrollTheme.subtle)
                                .padding(.horizontal, 15)
                                .padding(.vertical, 14)
                                .allowsHitTesting(false)
                                .accessibilityHidden(true)
                        }
                    }
                    .background(ToolrollTheme.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(ToolrollTheme.controlLine, lineWidth: 1))
                    PasteButton(payloadType: String.self) { strings in
                        if let first = strings.first { text = first }
                    }
                    .buttonBorderShape(.capsule)
                    .tint(ToolrollTheme.ink)
                    .labelStyle(.titleAndIcon)
                    .accessibilityHint("Pastes the pairing code you copied on your Mac.")
                }

                DeviceNameField(name: $deviceName)
            }
            .padding(.horizontal, 20)
            .padding(.top, 8)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(ToolrollTheme.paper.ignoresSafeArea())
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 8) {
                Button("Pair") {
                    let payload = text
                    text = ""
                    onSubmit(payload)
                }
                .buttonStyle(SignalButtonStyle())
                .disabled(!hasCode)
                Text(hasCode ? "The code works once, for 5 minutes." : "Paste the code from your Mac to continue.")
                    .font(.system(size: 12.5))
                    .foregroundStyle(ToolrollTheme.muted)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            .background(ToolrollTheme.paper)
        }
        .navigationTitle("Pair with a code")
        .navigationBarTitleDisplayMode(.inline)
        .onDisappear { text = "" }
    }
}

/// Shown while a pairing runs: contacting the Mac, the code to compare, then finishing.
struct PairingProgressView: View {
    let appState: CompanionAppState
    /// Contacting has taken over five seconds.
    @State private var slow = false

    var body: some View {
        GeometryReader { geometry in
        ScrollView {
            VStack(spacing: 24) {
                switch appState.pairing {
                case .awaitingMacConfirm(let code):
                    Text("Check the code on your Mac")
                        .font(.title2.weight(.bold))
                        .foregroundStyle(ToolrollTheme.ink)
                        .multilineTextAlignment(.center)
                        .accessibilityAddTraits(.isHeader)
                    Text("Your Mac will show this code in a moment.")
                        .font(.body)
                        .foregroundStyle(ToolrollTheme.muted)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(code)
                        .font(.system(.largeTitle, design: .monospaced).weight(.bold))
                        .tracking(4)
                        .foregroundStyle(ToolrollTheme.ink)
                        .padding(.horizontal, 28)
                        .padding(.vertical, 18)
                        .card()
                        .accessibilityLabel("Code: \(Self.spoken(code))")
                    Text("If your Mac shows the same code, click **Codes match — pair** there. If the codes are different, tap Cancel.")
                        .font(.body)
                        .foregroundStyle(ToolrollTheme.ink)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                    waiting("Waiting for your Mac to confirm")
                case .finishing:
                    waiting("Finishing on your Mac…")
                        .font(.headline)
                default:
                    waiting("Contacting your Mac…")
                        .font(.headline)
                    if slow {
                        Text("Still trying — make sure Toolroll is open on your Mac.")
                            .font(.body)
                            .foregroundStyle(ToolrollTheme.muted)
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                            .transition(.opacity)
                    }
                }
            }
            .padding(24)
            // Centred when it fits; scrolls at the largest text sizes.
            .frame(maxWidth: .infinity, minHeight: geometry.size.height)
            .animation(.easeOut(duration: 0.2), value: slow)
        }
        .scrollBounceBehavior(.basedOnSize)
        }
        .background(ToolrollTheme.paper.ignoresSafeArea())
        .safeAreaInset(edge: .bottom) {
            Button("Cancel pairing") { appState.cancelPairing() }
                .buttonStyle(OutlineButtonStyle())
                .padding(.horizontal, 24)
                .padding(.vertical, 12)
                .background(ToolrollTheme.paper)
        }
        .task {
            try? await Task.sleep(for: .seconds(5))
            if !Task.isCancelled { slow = true }
        }
    }

    /// A spinner with its words visible and read as one element (U17).
    private func waiting(_ words: String) -> some View {
        HStack(spacing: 10) {
            ProgressView()
            Text(words)
                .foregroundStyle(ToolrollTheme.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(words)
    }

    /// "HFX-2B0" read character by character, halves separated by a pause: "H F X, 2 B 0" (no "hyphen").
    static func spoken(_ code: String) -> String {
        code.split(separator: "-").map { $0.map(String.init).joined(separator: " ") }.joined(separator: ", ")
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
        label.text = "The camera couldn't start. Paste the pairing code instead."
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
