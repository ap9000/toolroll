import SwiftUI
import ToolrollCore

public struct NotificationBellPopover: View {
    @Bindable var store: WorkbenchStore

    public init(store: WorkbenchStore) {
        self.store = store
    }

    private var waitingTasks: [WorkRow] {
        store.needsRows
    }

    private var hasAnything: Bool {
        !waitingTasks.isEmpty || !store.pendingAgentRequests.isEmpty || !store.directChatAlerts.isEmpty
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text("Notifications")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.ink)
                if store.notificationBellBadgeCount > 0 {
                    Text("\(store.notificationBellBadgeCount)")
                        .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.paper)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(ToolrollPalette.ink, in: Capsule())
                }
                Spacer()
                if store.directChatAlerts.contains(where: { !$0.isRead }) {
                    Button("Mark all read") {
                        store.markAllDirectChatAlertsRead()
                    }
                    .buttonStyle(.plain)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(ToolrollPalette.muted)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 11)

            HairlineDivider()

            if !hasAnything {
                VStack(spacing: 6) {
                    Image(systemName: "bell.slash")
                        .font(.system(size: 18))
                        .foregroundStyle(ToolrollPalette.muted.opacity(0.6))
                    Text("All caught up")
                        .font(.system(size: 12.5, weight: .semibold))
                        .foregroundStyle(ToolrollPalette.ink)
                    Text("Tasks waiting on you and finished Direct Chats show up here.")
                        .font(.system(size: 11.5))
                        .foregroundStyle(ToolrollPalette.muted)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 20)
                .padding(.vertical, 28)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        if !waitingTasks.isEmpty {
                            sectionHeader("NEEDS YOUR ATTENTION")
                            ForEach(waitingTasks) { row in
                                taskAlertRow(row)
                                HairlineDivider()
                            }
                        }

                        if !store.pendingAgentRequests.isEmpty {
                            sectionHeader("AGENT REQUESTS")
                            ForEach(store.pendingAgentRequests) { req in
                                agentRequestRow(req)
                                HairlineDivider()
                            }
                        }

                        if !store.directChatAlerts.isEmpty {
                            sectionHeader("DIRECT CHATS")
                            ForEach(store.directChatAlerts) { alert in
                                directChatAlertRow(alert)
                                HairlineDivider()
                            }
                        }
                    }
                }
                .frame(maxHeight: 380)
            }
        }
        .frame(width: 360)
        .background(ToolrollPalette.paper)
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 10, weight: .semibold, design: .monospaced))
            .tracking(0.7)
            .foregroundStyle(ToolrollPalette.muted)
            .padding(.horizontal, 14)
            .padding(.top, 10)
            .padding(.bottom, 6)
    }

    private func taskAlertRow(_ row: WorkRow) -> some View {
        Button {
            store.isNotificationBellOpen = false
            Task { await store.selectTask(row.id) }
        } label: {
            HStack(alignment: .top, spacing: 9) {
                Circle()
                    .fill(ToolrollPalette.warning)
                    .frame(width: 7, height: 7)
                    .padding(.top, 5)
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.title)
                        .font(.system(size: 12.5, weight: .semibold))
                        .foregroundStyle(ToolrollPalette.ink)
                        .lineLimit(1)
                    HStack(spacing: 6) {
                        if let proj = row.project, !proj.isEmpty {
                            Text(proj)
                                .font(.system(size: 10.5, design: .monospaced))
                                .foregroundStyle(ToolrollPalette.muted)
                        }
                        Text(row.ask ?? row.need?.ask ?? row.word)
                            .font(.system(size: 11))
                            .foregroundStyle(ToolrollPalette.muted)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 6)
                Image(systemName: "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.muted.opacity(0.6))
                    .padding(.top, 4)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func agentRequestRow(_ req: AgentRequest) -> some View {
        HStack(alignment: .top, spacing: 9) {
            Circle()
                .fill(ToolrollPalette.live)
                .frame(width: 7, height: 7)
                .padding(.top, 5)
            VStack(alignment: .leading, spacing: 2) {
                Text(req.summary)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.ink)
                    .lineLimit(2)
                Text("\(req.requester) · \(req.projectName)")
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.muted)
            }
            Spacer(minLength: 6)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
    }

    private func directChatAlertRow(_ alert: DirectChatAlert) -> some View {
        let isFailure = alert.status == "failed" || alert.status == "interrupted"
        return HStack(alignment: .top, spacing: 9) {
            ZStack(alignment: .topTrailing) {
                ProviderBrandGlyph(provider: alert.provider.rawValue, size: 14, tinted: true, inTile: true)
                if !alert.isRead {
                    Circle()
                        .fill(isFailure ? ToolrollPalette.danger : ToolrollPalette.live)
                        .frame(width: 6, height: 6)
                        .offset(x: 2, y: -2)
                }
            }
            .padding(.top, 2)

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(alert.title)
                        .font(.system(size: 12.5, weight: alert.isRead ? .medium : .semibold))
                        .foregroundStyle(ToolrollPalette.ink)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Text(alert.relativeAge)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.muted)
                }

                Text(alert.subtitle)
                    .font(.system(size: 11))
                    .foregroundStyle(isFailure ? ToolrollPalette.danger : ToolrollPalette.muted)
                    .lineLimit(2)

                HStack(spacing: 8) {
                    Button("Open") {
                        store.markDirectChatAlertRead(alert.id)
                        store.isNotificationBellOpen = false
                        store.selectChatThread(alert.threadId)
                    }
                    .buttonStyle(KitButtonStyle(.ghost, compact: true))

                    if !isFailure && alert.changedFilesCount > 0 {
                        Button("Ship") {
                            store.markDirectChatAlertRead(alert.id)
                            store.isNotificationBellOpen = false
                            store.selectChatThread(alert.threadId)
                            Task { await store.openChatShipSheet(threadId: alert.threadId) }
                        }
                        .buttonStyle(KitButtonStyle(.primary, compact: true))
                    }
                }
                .padding(.top, 3)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .background(alert.isRead ? Color.clear : ToolrollPalette.raised.opacity(0.55))
    }
}
