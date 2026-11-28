import SwiftUI
import ToolrollCompanionCore

@main
struct ToolrollCompanionApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @State private var appState = CompanionAppState()
    @State private var appearance = ToolrollAppearance.shared

    var body: some Scene {
        WindowGroup {
            RootView(appState: appState)
                .environment(\.toolrollAppearance, appearance)
                .preferredColorScheme(appearance.scheme.colorScheme)
                .tint(appearance.signalText)
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
            } else if appState.lockState != .open {
                // Nothing of the work is drawn until the unlock finishes.
                UnlockCover(appState: appState)
            } else {
                WorkInboxView(appState: appState)
            }
        }
        .animation(.snappy(duration: 0.25), value: appState.pairing)
        .sensoryFeedback(.success, trigger: appState.pairedCount)
    }
}

/// "Unlock approvals when I open Toolroll": the app stays covered until one passkey (or, for viewing only, Face ID).
private struct UnlockCover: View {
    let appState: CompanionAppState

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            VStack(spacing: 14) {
                BrandMark(size: 56)
                Text("Toolroll")
                    .font(.system(size: 26, weight: .semibold))
                    .tracking(-0.5)
                    .foregroundStyle(ToolrollTheme.ink)
                // Viewing only is a possible outcome (offline, Always ask, the Mac asks every time): promise nothing about
                // approvals here. What approvals do shows after the unlock, where they are.
                Text("Unlock to see your work.")
                    .font(.subheadline)
                    .foregroundStyle(ToolrollTheme.muted)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                if let problem = appState.unlockProblem {
                    Text(problem)
                        .font(.footnote)
                        .foregroundStyle(ToolrollTheme.danger)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.horizontal, 32)
            Spacer()
            VStack(spacing: 8) {
                Button {
                    Task { await appState.unlock() }
                } label: {
                    if appState.lockState == .unlocking {
                        ProgressView().tint(ToolrollTheme.onInk)
                    } else {
                        Label("Unlock", systemImage: "faceid")
                    }
                }
                .buttonStyle(SignalButtonStyle())
                .disabled(appState.lockState == .unlocking)
                Text(appState.workspaceLabel)
                    .font(.system(size: 12.5))
                    .foregroundStyle(ToolrollTheme.muted)
                    .multilineTextAlignment(.center)
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 12)
        }
        .background(ToolrollTheme.paper.ignoresSafeArea())
        .overlay(alignment: .top) { SigningBanner(wording: appState.signingWording) }
        .task(id: appState.lockGeneration) {
            if appState.unlocksAutomatically { await appState.unlock() }
        }
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
