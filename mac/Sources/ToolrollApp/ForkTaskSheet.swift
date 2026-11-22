import SwiftUI
import ToolrollCore

/// Parallel Session Forking Sheet (⌘⇧F):
/// Clones the selected task into an isolated sibling worktree so you can race two approaches
/// or two agents (e.g. Claude vs Codex) side-by-side and compare both Code & Canvas Visual Diffs.
struct ForkTaskSheet: View {
    @Bindable var store: WorkbenchStore
    @Environment(\.dismiss) private var dismiss

    @State private var title: String = ""
    @State private var twist: String = ""
    @State private var planFirst: Bool = true
    @State private var selectedPresetName: String = ""

    private var parentRow: WorkRow? { store.selectedRow }

    private var selectedPreset: AgentPreset? {
        store.modelsRead.presets.first(where: { $0.name == selectedPresetName })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Fork Approach into Parallel Worktree")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(ToolrollPalette.ink)
                    if let parent = parentRow {
                        Text("Parent: \(parent.id)\(parent.project.map { " · \($0)" } ?? "")")
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(ToolrollPalette.muted)
                    }
                }
                Spacer()
                Button("Close") { dismiss() }
                    .buttonStyle(KitButtonStyle(.ghost, compact: true))
            }

            HairlineDivider()

            VStack(alignment: .leading, spacing: 6) {
                Text("FORK TITLE")
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .tracking(0.7)
                    .foregroundStyle(ToolrollPalette.muted)
                TextField("Alternative approach title…", text: $title)
                    .textFieldStyle(.plain)
                    .font(.system(size: 13))
                    .padding(9)
                    .background(ToolrollPalette.codeBg, in: RoundedRectangle(cornerRadius: 6))
                    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(ToolrollPalette.inputLine, lineWidth: 1))
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("APPROACH TWIST / INSTRUCTIONS")
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .tracking(0.7)
                    .foregroundStyle(ToolrollPalette.muted)
                TextField(
                    "What should this parallel worktree try differently? (e.g. simpler state model, alternate UI layout, or pit another agent against it)…",
                    text: $twist,
                    axis: .vertical
                )
                .textFieldStyle(.plain)
                .font(.system(size: 12.5))
                .lineLimit(3...6)
                .padding(9)
                .background(ToolrollPalette.codeBg, in: RoundedRectangle(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(ToolrollPalette.inputLine, lineWidth: 1))
            }

            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 5) {
                    Text("CADENCE")
                        .font(.system(size: 10, weight: .semibold, design: .monospaced))
                        .tracking(0.7)
                        .foregroundStyle(ToolrollPalette.muted)
                    Picker("", selection: $planFirst) {
                        Text("Plan first").tag(true)
                        Text("Just code").tag(false)
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .frame(width: 200)
                }

                if !store.modelsRead.presets.isEmpty {
                    VStack(alignment: .leading, spacing: 5) {
                        Text("AGENT PRESET (OPTIONAL)")
                            .font(.system(size: 10, weight: .semibold, design: .monospaced))
                            .tracking(0.7)
                            .foregroundStyle(ToolrollPalette.muted)
                        Picker("", selection: $selectedPresetName) {
                            Text("Keep current").tag("")
                            ForEach(store.modelsRead.presets) { preset in
                                Text(preset.name).tag(preset.name)
                            }
                        }
                        .labelsHidden()
                    }
                }

                Spacer()
            }

            HairlineDivider()

            HStack {
                Text("Runs in its own isolated Git worktree alongside the original task.")
                    .font(.system(size: 11))
                    .foregroundStyle(ToolrollPalette.muted)
                Spacer()
                Button("Launch Parallel Fork (⌘↵)") {
                    launchFork()
                }
                .buttonStyle(KitButtonStyle(.primary))
                .keyboardShortcut(.return, modifiers: [.command])
                .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(20)
        .frame(width: 520)
        .background(ToolrollPalette.paper)
        .onAppear {
            if let parent = parentRow {
                let cleanTitle = parent.title.hasPrefix("[Fork] ") ? parent.title : "[Fork] \(parent.title)"
                title = String(cleanTitle.prefix(116))
            }
        }
    }

    private func launchFork() {
        let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanTitle.isEmpty else { return }
        let note = twist.trimmingCharacters(in: .whitespacesAndNewlines)
        let preset = selectedPreset
        let plan = planFirst
        dismiss()
        Task {
            await store.forkSelectedTask(title: cleanTitle, twist: note, planFirst: plan, preset: preset)
        }
    }
}
