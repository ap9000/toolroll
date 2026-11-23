import AppKit
import SwiftUI
import ToolrollCore

/// Automations, natively: what runs on its own, what starts it, when it runs next, how it last went — with Pause/Resume
/// and Run now. New automations are described to the Lead, which proposes one for the person to approve.
struct AutomationsView: View {
    @Bindable var store: WorkbenchStore

    private static let groups: [(key: String, title: String)] = [("needs", "Waiting on you"), ("running", "Running"), ("on", "On"), ("paused", "Paused")]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                header
                if let response = store.automations {
                    if response.automations.isEmpty {
                        emptyState
                    } else {
                        ForEach(Self.groups, id: \.key) { group in
                            let rows = response.automations.filter { $0.group == group.key }
                            if !rows.isEmpty { section(group.title, rows: rows, canAct: response.canAct) }
                        }
                    }
                } else {
                    unavailable
                }
            }
            .padding(.horizontal, 44)
            .padding(.vertical, 32)
            .frame(maxWidth: 1040, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .center)
        }
        .background(ToolrollPalette.ground)
        .task { await store.refreshAll() }
        .confirmationDialog(
            "Resume \u{201C}\(store.automationToResume?.name ?? "")\u{201D}?",
            isPresented: Binding(get: { store.automationToResume != nil }, set: { if !$0 { store.automationToResume = nil } }),
            titleVisibility: .visible,
            presenting: store.automationToResume
        ) { automation in
            Button("Resume") { Task { await store.toggleAutomation(automation) } }
            Button("Keep Paused", role: .cancel) { store.automationToResume = nil }
        } message: { _ in
            Text("It fell due while paused, so it may run once right away, under the terms you signed for it.")
        }
    }

    private var header: some View {
        ScreenHeader(title: "Automations", detail: countLine) {
            Button { store.startAutomationWithLead() } label: {
                Label("New automation", systemImage: "plus").font(.system(size: 12.5, weight: .medium))
            }
            .buttonStyle(KitButtonStyle(.ghost, compact: true))
            .help("Describe it to the Lead; it proposes the automation and you approve it")
        }
    }

    private var countLine: String? {
        guard let count = store.automations?.automations.count, count > 0 else { return nil }
        return count == 1 ? "1 automation" : "\(count) automations"
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Nothing runs on its own yet")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(ToolrollPalette.ink)
            Text("Describe what should happen and when, like “every weekday at 9, check oddcircle's failing checks”.")
                .font(.system(size: 13))
                .foregroundStyle(ToolrollPalette.muted)
            Button("New automation") { store.startAutomationWithLead() }
                .buttonStyle(KitButtonStyle(.ghost, compact: true))
        }
        .padding(.top, 12)
    }

    private var unavailable: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Automations aren't available from this Toolroll yet")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(ToolrollPalette.ink)
            Text("Update Toolroll on this computer to see and run them here.")
                .font(.system(size: 13))
                .foregroundStyle(ToolrollPalette.muted)
        }
        .padding(.top, 12)
    }

    private func section(_ title: String, rows: [Automation], canAct: Bool) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 8) {
                Text(title).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(ToolrollPalette.ink)
                Text("\(rows.count)").font(.system(size: 12.5)).foregroundStyle(ToolrollPalette.muted)
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 6)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            ForEach(rows) { AutomationRow(store: store, automation: $0, canAct: canAct) }
        }
    }
}

/// One automation: what starts it, when it next runs, how it last went; Pause/Resume and Run now on the right.
struct AutomationRow: View {
    let store: WorkbenchStore
    let automation: Automation
    let canAct: Bool

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: Self.icon(for: automation.triggers.first?.kind))
                .font(.system(size: 14))
                .foregroundStyle(automation.isPaused ? ToolrollPalette.muted : ToolrollPalette.ink)
                .frame(width: 30, height: 30)
                .background(Color.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            VStack(alignment: .leading, spacing: 3) {
                Text(automation.name)
                    .font(.system(size: 14))
                    .foregroundStyle(automation.isPaused ? ToolrollPalette.muted : ToolrollPalette.ink)
                    .lineLimit(1)
                Text(subtitle)
                    .font(.system(size: 12))
                    .foregroundStyle(automation.trouble == nil ? ToolrollPalette.muted : ToolrollPalette.danger)
                    .lineLimit(1)
            }
            Spacer(minLength: 12)
            if canAct {
                if automation.runNowTrigger != nil && !automation.isPaused {
                    Button("Run now") { Task { await store.runAutomationNow(automation) } }
                        .buttonStyle(KitButtonStyle(.ghost, compact: true))
                }
                if !automation.triggers.isEmpty {
                    Button(automation.isPaused ? "Resume" : "Pause") { toggle() }
                        .buttonStyle(KitButtonStyle(.ghost, compact: true))
                }
            }
        }
        .disabled(store.busyLabel != nil)
        .padding(.horizontal, 16)
        .frame(minHeight: 58)
        .contentShape(Rectangle())
        .toolrollHoverSurface(cornerRadius: 10, isSelected: false)
        .contextMenu {
            if canAct, automation.runNowTrigger != nil, !automation.isPaused {
                Button("Run Now") { Task { await store.runAutomationNow(automation) } }
            }
            if canAct, !automation.triggers.isEmpty {
                Button(automation.isPaused ? "Resume" : "Pause") { toggle() }
            }
            Divider()
            Button("Copy Name") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(automation.name, forType: .string)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(automation.name), \(subtitle)")
    }

    /// Resume asks first when it may run once right away; pause and other resumes act at once.
    private func toggle() {
        if automation.isPaused && automation.resumeRunsNow {
            store.automationToResume = automation
        } else {
            Task { await store.toggleAutomation(automation) }
        }
    }

    /// "Every weekday at 09:00 · oddcircle · next in 3 h" — or the trouble, when there is one.
    private var subtitle: String {
        if let trouble = automation.trouble { return trouble }
        var parts = [automation.starts]
        if let project = automation.project, !project.isEmpty { parts.append(project) }
        if automation.waiting > 0 { parts.append(automation.waiting == 1 ? "1 waits on you" : "\(automation.waiting) wait on you") }
        else if automation.inProgress > 0 { parts.append("\(automation.inProgress) in progress") }
        else if automation.isPaused { parts.append("paused") }
        else if let next = automation.nextAt.flatMap(Self.relative) { parts.append("next \(next)") }
        return parts.joined(separator: " · ")
    }

    static func icon(for kind: String?) -> String {
        switch kind {
        case "schedule": return "clock"
        case "github": return "chevron.left.forwardslash.chevron.right"
        case "linear": return "line.3.horizontal.decrease"
        case "webhook": return "antenna.radiowaves.left.and.right"
        case "email": return "envelope"
        case "chat": return "bubble.left"
        case "flow": return "arrow.triangle.branch"
        case "button": return "hand.tap"
        case "plane-review": return "checkmark.seal"
        default: return "clock.arrow.2.circlepath"
        }
    }

    /// "in 12 min", "in 5 h", "in 3 days".
    static func relative(_ iso: String) -> String? {
        let parse = ISO8601DateFormatter()
        parse.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = parse.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return nil }
        let minutes = Int(date.timeIntervalSinceNow / 60)
        if minutes < 1 { return "now" }
        if minutes < 60 { return "in \(minutes) min" }
        let hours = Int((Double(minutes) / 60).rounded())
        if hours < 24 { return "in \(hours) h" }
        let days = Int((Double(hours) / 24).rounded())
        return "in \(days) day\(days == 1 ? "" : "s")"
    }
}
