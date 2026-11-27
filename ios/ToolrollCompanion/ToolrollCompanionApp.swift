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
                .onChange(of: scenePhase) { _, phase in
                    switch phase {
                    case .active:
                        Task { await appState.reconnectIfPaired() }
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
        switch appState.connection {
        case .unpaired, .awaitingMacConfirm, .restoredRequiresRePair:
            WelcomePairingView(appState: appState)
        case .connecting where appState.pairedRecord == nil:
            WelcomePairingView(appState: appState)
        default:
            WorkInboxView(appState: appState)
        }
    }
}
