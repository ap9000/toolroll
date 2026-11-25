import AppKit
import CoreImage
import CoreImage.CIFilterBuiltins
import Darwin
import SwiftUI
import ToolrollCore

struct PhonePairSheet: View {
    @Bindable var store: WorkbenchStore
    @Environment(\.dismiss) private var dismiss

    @State private var selectedChannel: PhoneChannel = .telegram
    @State private var channelStatuses: [PhoneChannel: PhoneChannelStatus] = [:]
    @State private var isLoadingStatus: Bool = false
    @State private var isSubmitting: Bool = false
    @State private var feedbackMessage: String? = nil
    @State private var feedbackIsError: Bool = false

    @State private var telegramBotToken: String = ""
    @State private var slackAppToken: String = ""
    @State private var slackBotToken: String = ""
    @State private var discordBotToken: String = ""
    @State private var teamsAppId: String = ""
    @State private var teamsTenant: String = ""
    @State private var teamsSecret: String = ""
    @State private var passwordInput: String = ""

    @State private var copiedCode: Bool = false
    @State private var copiedURL: Bool = false
    @State private var pairPollTask: Task<Void, Never>? = nil

    private var currentStatus: PhoneChannelStatus {
        channelStatuses[selectedChannel] ?? PhoneChannelStatus(
            channel: selectedChannel,
            botConnected: false,
            isPaired: false
        )
    }

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

    private var pairedChannelsCount: Int {
        channelStatuses.values.filter(\.isPaired).count
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Control Toolroll from Your Phone")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(ToolrollPalette.ink)
                    Text("No separate phone app needed — approve plans, answer questions, and talk to Lead in 30 seconds.")
                        .font(.system(size: 11.5))
                        .foregroundStyle(ToolrollPalette.muted)
                }
                Spacer()
                if pairedChannelsCount > 0 {
                    HStack(spacing: 4) {
                        Circle()
                            .fill(ToolrollPalette.success)
                            .frame(width: 6, height: 6)
                        Text("\(pairedChannelsCount) paired")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(ToolrollPalette.success)
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(ToolrollPalette.success.opacity(0.10), in: Capsule())
                }
                Button("Done") {
                    pairPollTask?.cancel()
                    dismiss()
                }
                .buttonStyle(KitButtonStyle(.ghost, compact: true))
            }

            HStack(spacing: 6) {
                ForEach(PhoneChannel.allCases) { channel in
                    channelTab(channel)
                }
            }

            HairlineDivider()

            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let feedbackMessage {
                        HStack(spacing: 8) {
                            Image(systemName: feedbackIsError ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                                .font(.system(size: 12))
                                .foregroundStyle(feedbackIsError ? ToolrollPalette.danger : ToolrollPalette.success)
                            Text(feedbackMessage)
                                .font(.system(size: 11.5))
                                .foregroundStyle(feedbackIsError ? ToolrollPalette.danger : ToolrollPalette.ink)
                                .fixedSize(horizontal: false, vertical: true)
                            Spacer()
                        }
                        .padding(10)
                        .background(
                            (feedbackIsError ? ToolrollPalette.danger : ToolrollPalette.success).opacity(0.08),
                            in: RoundedRectangle(cornerRadius: 7)
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: 7)
                                .strokeBorder((feedbackIsError ? ToolrollPalette.danger : ToolrollPalette.success).opacity(0.28), lineWidth: 1)
                        )
                    }

                    if selectedChannel == .mobileWeb {
                        mobileWebContent
                    } else if store.activeProfile.isDemo {
                        demoGuidanceCard
                    } else {
                        messagingChannelWizard
                    }
                }
            }
            .frame(maxHeight: 430)
        }
        .padding(20)
        .frame(width: 610)
        .background(ToolrollPalette.paper)
        .task {
            await refreshAllChannels()
        }
        .onDisappear {
            pairPollTask?.cancel()
            pairPollTask = nil
        }
    }

    private func channelTab(_ channel: PhoneChannel) -> some View {
        let selected = selectedChannel == channel
        let paired = channelStatuses[channel]?.isPaired == true
        return Button {
            selectedChannel = channel
            feedbackMessage = nil
            Task { await refreshChannel(channel) }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: channel.symbolName)
                    .font(.system(size: 10.5))
                Text(channel.title)
                    .font(.system(size: 11.5, weight: selected ? .semibold : .medium))
                if paired {
                    Circle()
                        .fill(ToolrollPalette.success)
                        .frame(width: 5.5, height: 5.5)
                }
            }
            .foregroundStyle(selected ? ToolrollPalette.ink : ToolrollPalette.muted)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(selected ? ToolrollPalette.raised : Color.clear, in: RoundedRectangle(cornerRadius: 7))
            .overlay(
                RoundedRectangle(cornerRadius: 7)
                    .strokeBorder(selected ? ToolrollPalette.inputLine : ToolrollPalette.line, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    private var messagingChannelWizard: some View {
        let status = currentStatus
        return VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 8) {
                Text(selectedChannel.badge)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(ToolrollPalette.muted)
                Spacer()
                if isLoadingStatus {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Button("Refresh") {
                        Task { await refreshChannel(selectedChannel) }
                    }
                    .buttonStyle(.plain)
                    .font(.system(size: 11))
                    .foregroundStyle(ToolrollPalette.muted)
                }
            }

            if store.passwordSet == false {
                HStack(spacing: 10) {
                    Image(systemName: "lock.shield")
                        .font(.system(size: 13))
                        .foregroundStyle(ToolrollPalette.warning)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Set a Toolroll password first")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(ToolrollPalette.ink)
                        Text("Phone pairing requires your Toolroll password so no one else can bind your account.")
                            .font(.system(size: 11))
                            .foregroundStyle(ToolrollPalette.muted)
                    }
                    Spacer()
                    Button("Set Password") {
                        store.openSetPassword()
                    }
                    .buttonStyle(KitButtonStyle(.primary, compact: true))
                }
                .padding(12)
                .background(ToolrollPalette.warning.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(ToolrollPalette.warning.opacity(0.35), lineWidth: 1))
            }

            stepCard(
                number: "1",
                title: "Connect \(selectedChannel.title) bot",
                done: status.botConnected,
                doneSummary: status.workspaceLabel ?? "\(selectedChannel.title) connected on this Mac"
            ) {
                connectBotBody
            }

            stepCard(
                number: "2",
                title: "Pair your phone",
                done: status.isPaired,
                doneSummary: "Your phone is paired — taps approve as \(store.activeProfile.account)"
            ) {
                if !status.botConnected {
                    Text("Connect your \(selectedChannel.title) bot in Step 1 first.")
                        .font(.system(size: 11.5))
                        .foregroundStyle(ToolrollPalette.muted)
                } else if let code = status.pairingCode {
                    mintedCodeView(code: code)
                } else {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Generate a one-time pairing code valid for 10 minutes.")
                            .font(.system(size: 11.5))
                            .foregroundStyle(ToolrollPalette.muted)
                        passwordEntryRow(buttonTitle: "Generate Pairing Code") {
                            Task { await mintCode() }
                        }
                    }
                }
            }

            if status.isPaired {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 8) {
                        Image(systemName: "checkmark.seal.fill")
                            .font(.system(size: 14))
                            .foregroundStyle(ToolrollPalette.success)
                        Text("Ready to use on your phone")
                            .font(.system(size: 12.5, weight: .semibold))
                            .foregroundStyle(ToolrollPalette.ink)
                        Spacer()
                    }
                    Text(selectedChannel.testPromptHint)
                        .font(.system(size: 11.5))
                        .foregroundStyle(ToolrollPalette.muted)

                    HairlineDivider()

                    DisclosureGroup("Unpair this phone") {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Unpairing revokes existing approval buttons from this chat immediately.")
                                .font(.system(size: 11))
                                .foregroundStyle(ToolrollPalette.muted)
                            passwordEntryRow(buttonTitle: "Unpair \(selectedChannel.title)") {
                                Task { await unpairCurrentChannel() }
                            }
                        }
                        .padding(.top, 6)
                    }
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(ToolrollPalette.muted)
                }
                .padding(12)
                .background(ToolrollPalette.success.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(ToolrollPalette.success.opacity(0.28), lineWidth: 1))
            }
        }
    }

    @ViewBuilder
    private var connectBotBody: some View {
        switch selectedChannel {
        case .telegram:
            VStack(alignment: .leading, spacing: 9) {
                HStack(spacing: 8) {
                    Text("Message @BotFather with /newbot, copy the bot token, and paste it below.")
                        .font(.system(size: 11.5))
                        .foregroundStyle(ToolrollPalette.muted)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer()
                    Button("Open @BotFather ↗") {
                        if let url = URL(string: "https://t.me/BotFather") {
                            NSWorkspace.shared.open(url)
                        }
                    }
                    .buttonStyle(KitButtonStyle(.ghost, compact: true))
                }
                SecureField("Bot token (e.g. 123456:ABC-DEF…)", text: $telegramBotToken)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 12, design: .monospaced))
                passwordEntryRow(buttonTitle: "Connect Telegram Bot") {
                    Task { await connectTelegram() }
                }
            }
        case .slack:
            VStack(alignment: .leading, spacing: 9) {
                HStack(spacing: 8) {
                    Text("Create a Slack app from Toolroll's manifest (Socket Mode — no public URL needed).")
                        .font(.system(size: 11.5))
                        .foregroundStyle(ToolrollPalette.muted)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer()
                    Button("Slack Apps ↗") {
                        if let url = URL(string: "https://api.slack.com/apps") {
                            NSWorkspace.shared.open(url)
                        }
                    }
                    .buttonStyle(KitButtonStyle(.ghost, compact: true))
                }
                SecureField("App token (xapp-…)", text: $slackAppToken)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 12, design: .monospaced))
                SecureField("Bot token (xoxb-…)", text: $slackBotToken)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 12, design: .monospaced))
                passwordEntryRow(buttonTitle: "Connect Slack") {
                    Task { await connectSlack() }
                }
            }
        case .discord:
            VStack(alignment: .leading, spacing: 9) {
                HStack(spacing: 8) {
                    Text("Create a Discord bot application and paste its bot token (outbound connection — no tunnel required).")
                        .font(.system(size: 11.5))
                        .foregroundStyle(ToolrollPalette.muted)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer()
                    Button("Discord Portal ↗") {
                        if let url = URL(string: "https://discord.com/developers/applications") {
                            NSWorkspace.shared.open(url)
                        }
                    }
                    .buttonStyle(KitButtonStyle(.ghost, compact: true))
                }
                SecureField("Discord bot token", text: $discordBotToken)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 12, design: .monospaced))
                passwordEntryRow(buttonTitle: "Connect Discord") {
                    Task { await connectDiscord() }
                }
            }
        case .teams:
            VStack(alignment: .leading, spacing: 9) {
                HStack(spacing: 8) {
                    Text("Create a single-tenant Azure Bot with Teams enabled and paste its app credentials.")
                        .font(.system(size: 11.5))
                        .foregroundStyle(ToolrollPalette.muted)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer()
                    Button("Azure Portal ↗") {
                        if let url = URL(string: "https://portal.azure.com") {
                            NSWorkspace.shared.open(url)
                        }
                    }
                    .buttonStyle(KitButtonStyle(.ghost, compact: true))
                }
                TextField("App (client) ID", text: $teamsAppId)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 12, design: .monospaced))
                TextField("Directory (tenant) ID", text: $teamsTenant)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 12, design: .monospaced))
                SecureField("Client secret", text: $teamsSecret)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 12, design: .monospaced))
                passwordEntryRow(buttonTitle: "Connect Teams") {
                    Task { await connectTeams() }
                }
            }
        case .mobileWeb:
            EmptyView()
        }
    }

    private func mintedCodeView(code: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Send this exact message to your \(selectedChannel.title) bot within 10 minutes:")
                .font(.system(size: 11.5))
                .foregroundStyle(ToolrollPalette.muted)

            HStack(spacing: 10) {
                Text(code)
                    .font(.system(size: 15, weight: .bold, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.ink)
                    .textSelection(.enabled)
                Spacer()
                Button(copiedCode ? "Copied" : "Copy Code") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(code, forType: .string)
                    copiedCode = true
                    Task {
                        try? await Task.sleep(for: .seconds(1.5))
                        copiedCode = false
                    }
                }
                .buttonStyle(KitButtonStyle(.primary, compact: true))
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(ToolrollPalette.codeBg, in: RoundedRectangle(cornerRadius: 7))
            .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(ToolrollPalette.live.opacity(0.4), lineWidth: 1))

            HStack(spacing: 8) {
                ProgressView()
                    .controlSize(.small)
                Text("Waiting for your message on \(selectedChannel.title)… checking automatically every 3s.")
                    .font(.system(size: 11))
                    .foregroundStyle(ToolrollPalette.muted)
                Spacer()
                Button("Check Now") {
                    Task { await refreshChannel(selectedChannel) }
                }
                .buttonStyle(KitButtonStyle(.ghost, compact: true))
            }
        }
    }

    private func passwordEntryRow(buttonTitle: String, action: @escaping () -> Void) -> some View {
        HStack(spacing: 8) {
            SecureField("Toolroll password", text: $passwordInput)
                .textFieldStyle(.roundedBorder)
                .font(.system(size: 12))
                .onSubmit(action)
            if store.isTouchIDEnabled {
                Button {
                    Task {
                        if let unlocked = await store.unlockPasswordWithTouchID(reason: "Authorize phone pairing in Toolroll") {
                            passwordInput = unlocked
                            action()
                        }
                    }
                } label: {
                    Image(systemName: store.touchIDSystemImage)
                        .font(.system(size: 13))
                }
                .buttonStyle(KitButtonStyle(.ghost, compact: true))
                .help("Fill password with \(store.touchIDLabel)")
            }
            Button(isSubmitting ? "Working…" : buttonTitle, action: action)
                .buttonStyle(KitButtonStyle(.primary, compact: true))
                .disabled(isSubmitting || resolvedPassword().isEmpty)
        }
    }

    private func stepCard<Content: View>(
        number: String,
        title: String,
        done: Bool,
        doneSummary: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                if done {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 15))
                        .foregroundStyle(ToolrollPalette.success)
                } else {
                    Text(number)
                        .font(.system(size: 10.5, weight: .bold, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.inverseInk)
                        .frame(width: 18, height: 18)
                        .background(ToolrollPalette.ink, in: Circle())
                }
                Text(title)
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.ink)
                if done {
                    Text("· \(doneSummary)")
                        .font(.system(size: 11))
                        .foregroundStyle(ToolrollPalette.muted)
                        .lineLimit(1)
                }
                Spacer()
            }
            if !done {
                content()
                    .padding(.leading, 26)
            }
        }
        .padding(12)
        .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(ToolrollPalette.line, lineWidth: 1))
    }

    private var demoGuidanceCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Connect to your local Toolroll engine to pair \(selectedChannel.title).")
                .font(.system(size: 12.5, weight: .semibold))
                .foregroundStyle(ToolrollPalette.ink)
            Text("Once connected, Toolroll connects outbound to \(selectedChannel.title) so approvals, questions, and Lead chat work on your phone with zero port forwarding.")
                .font(.system(size: 11.5))
                .foregroundStyle(ToolrollPalette.muted)
            Button("Start Local Engine") {
                Task {
                    await store.startLocalEngine()
                    await refreshAllChannels()
                }
            }
            .buttonStyle(KitButtonStyle(.primary, compact: true))
        }
        .padding(14)
        .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(ToolrollPalette.line, lineWidth: 1))
    }

    private var mobileWebContent: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 20) {
                VStack(spacing: 8) {
                    if let qrImage = Self.makeQRCode(from: pairURLString) {
                        Image(nsImage: qrImage)
                            .interpolation(.none)
                            .resizable()
                            .scaledToFit()
                            .frame(width: 164, height: 164)
                            .padding(10)
                            .background(Color.white, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))
                    }
                    Text("Scan with iPhone / Android Camera")
                        .font(.system(size: 10.5))
                        .foregroundStyle(ToolrollPalette.muted)
                }

                VStack(alignment: .leading, spacing: 12) {
                    stepItem(number: "1", title: "Reach your console over HTTPS or Tailscale", detail: "For local-only Macs without a tunnel, use Telegram, Slack, or Discord tabs — they work behind any firewall with zero network setup.")
                    stepItem(number: "2", title: "Add to Home Screen", detail: "Tap Share → Add to Home Screen in Safari to install Toolroll's Mobile PWA.")
                    stepItem(number: "3", title: "Enable Push Alerts", detail: "In Settings → Notifications, tap \"Get alerts on this device\" for encrypted VAPID push pings.")

                    if isLoopbackOnly {
                        Text("Your local engine is bound to loopback (127.0.0.1). Use Telegram/Slack/Discord above, or expose it via Tailscale Serve / HTTPS team workspace.")
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
                Button(copiedURL ? "Copied" : "Copy URL") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(pairURLString, forType: .string)
                    copiedURL = true
                    Task {
                        try? await Task.sleep(for: .seconds(1.5))
                        copiedURL = false
                    }
                }
                .buttonStyle(KitButtonStyle(.ghost, compact: true))
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(ToolrollPalette.codeBg, in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(ToolrollPalette.line, lineWidth: 1))
        }
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

    private func resolvedPassword() -> String {
        store.effectivePassword(passwordInput)
    }

    private func refreshAllChannels() async {
        guard !store.activeProfile.isDemo, let client = store.client else { return }
        isLoadingStatus = true
        defer { isLoadingStatus = false }
        for ch in [PhoneChannel.telegram, .slack, .discord, .teams] {
            if let status = try? await client.fetchPhoneChannelStatus(channel: ch) {
                channelStatuses[ch] = status
            }
        }
    }

    private func refreshChannel(_ channel: PhoneChannel) async {
        guard !store.activeProfile.isDemo, channel != .mobileWeb, let client = store.client else { return }
        isLoadingStatus = true
        defer { isLoadingStatus = false }
        if let status = try? await client.fetchPhoneChannelStatus(channel: channel) {
            let previousCode = channelStatuses[channel]?.pairingCode
            if !status.isPaired && status.pairingCode == nil, let previousCode {
                channelStatuses[channel] = PhoneChannelStatus(
                    channel: status.channel,
                    botConnected: status.botConnected,
                    isPaired: status.isPaired,
                    isLive: status.isLive,
                    workspaceLabel: status.workspaceLabel,
                    pairingCode: previousCode,
                    problem: status.problem
                )
            } else {
                channelStatuses[channel] = status
            }
            if status.isPaired {
                pairPollTask?.cancel()
                pairPollTask = nil
                feedbackIsError = false
                feedbackMessage = "\(channel.title) paired! \(channel.testPromptHint)"
            }
        }
    }

    private func startPairingPoll(for channel: PhoneChannel) {
        pairPollTask?.cancel()
        pairPollTask = Task {
            for _ in 0..<200 {
                try? await Task.sleep(for: .seconds(3))
                if Task.isCancelled { return }
                await refreshChannel(channel)
                if channelStatuses[channel]?.isPaired == true {
                    return
                }
            }
        }
    }

    private func connectTelegram() async {
        guard let client = store.client else { return }
        let token = telegramBotToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else {
            feedbackIsError = true
            feedbackMessage = "Paste your @BotFather token first."
            return
        }
        isSubmitting = true
        feedbackMessage = nil
        defer { isSubmitting = false }
        do {
            let status = try await client.saveTelegramBotToken(token: token, password: resolvedPassword())
            channelStatuses[.telegram] = status
            telegramBotToken = ""
            feedbackIsError = false
            feedbackMessage = "Telegram bot saved. Now generate your pairing code in Step 2."
        } catch {
            feedbackIsError = true
            feedbackMessage = error.localizedDescription
        }
    }

    private func connectSlack() async {
        guard let client = store.client else { return }
        isSubmitting = true
        feedbackMessage = nil
        defer { isSubmitting = false }
        do {
            let status = try await client.connectSlackApp(
                appToken: slackAppToken.trimmingCharacters(in: .whitespacesAndNewlines),
                botToken: slackBotToken.trimmingCharacters(in: .whitespacesAndNewlines),
                password: resolvedPassword()
            )
            channelStatuses[.slack] = status
            slackAppToken = ""
            slackBotToken = ""
            feedbackIsError = false
            feedbackMessage = "Slack connected. Now generate your pairing code in Step 2."
        } catch {
            feedbackIsError = true
            feedbackMessage = error.localizedDescription
        }
    }

    private func connectDiscord() async {
        guard let client = store.client else { return }
        isSubmitting = true
        feedbackMessage = nil
        defer { isSubmitting = false }
        do {
            let status = try await client.connectDiscordBot(
                botToken: discordBotToken.trimmingCharacters(in: .whitespacesAndNewlines),
                password: resolvedPassword()
            )
            channelStatuses[.discord] = status
            discordBotToken = ""
            feedbackIsError = false
            feedbackMessage = "Discord connected. Now generate your pairing code in Step 2."
        } catch {
            feedbackIsError = true
            feedbackMessage = error.localizedDescription
        }
    }

    private func connectTeams() async {
        guard let client = store.client else { return }
        isSubmitting = true
        feedbackMessage = nil
        defer { isSubmitting = false }
        do {
            let status = try await client.connectTeamsApp(
                appId: teamsAppId.trimmingCharacters(in: .whitespacesAndNewlines),
                tenant: teamsTenant.trimmingCharacters(in: .whitespacesAndNewlines),
                secret: teamsSecret.trimmingCharacters(in: .whitespacesAndNewlines),
                password: resolvedPassword()
            )
            channelStatuses[.teams] = status
            teamsSecret = ""
            feedbackIsError = false
            feedbackMessage = "Teams connected. Now generate your pairing code in Step 2."
        } catch {
            feedbackIsError = true
            feedbackMessage = error.localizedDescription
        }
    }

    private func mintCode() async {
        guard let client = store.client else { return }
        isSubmitting = true
        feedbackMessage = nil
        defer { isSubmitting = false }
        do {
            let status = try await client.mintPhonePairingCode(channel: selectedChannel, password: resolvedPassword())
            channelStatuses[selectedChannel] = status
            if status.pairingCode != nil {
                startPairingPoll(for: selectedChannel)
            }
        } catch {
            feedbackIsError = true
            feedbackMessage = error.localizedDescription
        }
    }

    private func unpairCurrentChannel() async {
        guard let client = store.client else { return }
        isSubmitting = true
        feedbackMessage = nil
        defer { isSubmitting = false }
        do {
            let status = try await client.unpairPhoneChannel(channel: selectedChannel, password: resolvedPassword())
            channelStatuses[selectedChannel] = status
            pairPollTask?.cancel()
            feedbackIsError = false
            feedbackMessage = "Unpaired \(selectedChannel.title)."
        } catch {
            feedbackIsError = true
            feedbackMessage = error.localizedDescription
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
