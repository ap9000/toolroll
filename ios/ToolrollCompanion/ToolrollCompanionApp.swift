import SwiftUI
import ToolrollCompanionCore

@main
struct ToolrollCompanionApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @State private var appState = CompanionAppState()

    var body: some Scene {
        WindowGroup {
            RootView(appState: appState)
                .tint(ToolrollTheme.ink)
                .overlay {
                    // Cover the app as soon as it stops being active (C7), so the app switcher never keeps a snapshot
                    // of a diff, a pairing code or a pasted payload: SwiftUI may not draw the cover in time if it waits
                    // for .background. Not while a pairing, the scanner or a system prompt (camera, Local Network) is
                    // up: those make the app inactive too, and the cover would hide what they're about.
                    if scenePhase == .background || (scenePhase == .inactive && !appState.suppressesPrivacyCover) {
                        PrivacyCover()
                    }
                }
                .onChange(of: scenePhase) { _, phase in
                    switch phase {
                    case .active:
                        Task { await appState.handleForeground() }
                    case .background:
                        Task { await appState.handleBackground() }
                    default:
                        break
                    }
                }
        }
    }
}

private struct RootView: View {
    @Bindable var appState: CompanionAppState

    var body: some View {
        Group {
            if appState.pairing != .idle {
                PairingProgressView(appState: appState)
            } else if appState.connection == .unpaired {
                WelcomePairingView(appState: appState)
            } else {
                WorkInboxView(appState: appState)
            }
        }
        .animation(.snappy(duration: 0.25), value: appState.pairing)
        .sensoryFeedback(.success, trigger: appState.pairedCount)
    }
}

private struct PrivacyCover: View {
    var body: some View {
        ZStack {
            ToolrollTheme.paper.ignoresSafeArea()
            BrandMark(size: 56)
        }
        .accessibilityHidden(true)
    }
}
