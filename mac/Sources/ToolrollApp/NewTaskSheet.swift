import SwiftUI
import ToolrollCore

/// Native `⌘N` New Task sheet — file tasks with Just Code or Plan First straight into Toolroll.
public struct NewTaskSheet: View {
    @Bindable var store: WorkbenchStore
    @Environment(\.dismiss) private var dismiss

    @State private var title: String = ""
    @State private var details: String = ""
    @State private var project: String = ""
    @State private var planFirst: Bool = true
    @FocusState private var titleFocused: Bool

    public init(store: WorkbenchStore) {
        self.store = store
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("New Task")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.ink)
                Spacer()
                Button("Close") {
                    store.isNewTaskSheetOpen = false
                    dismiss()
                }
                .buttonStyle(KitButtonStyle(.ghost, compact: true))
            }

            VStack(alignment: .leading, spacing: 4) {
                Text("What should Toolroll work on?")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(ToolrollPalette.muted)
                TextField("e.g. Add keyboard navigation to diff hunks", text: $title)
                    .textFieldStyle(.plain)
                    .font(.system(size: 13))
                    .foregroundStyle(ToolrollPalette.ink)
                    .focused($titleFocused)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 8)
                    .background(ToolrollPalette.codeBg, in: RoundedRectangle(cornerRadius: 5))
                    .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(ToolrollPalette.inputLine, lineWidth: 1))
                    .onSubmit { submit() }
            }

            if !store.allProjects.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Project")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(ToolrollPalette.muted)
                    Picker("", selection: $project) {
                        Text("Default project").tag("")
                        ForEach(store.allProjects, id: \.self) { proj in
                            Text(proj).tag(proj)
                        }
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                }
            }

            VStack(alignment: .leading, spacing: 4) {
                Text("Notes / Context (optional)")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(ToolrollPalette.muted)
                TextEditor(text: $details)
                    .font(.system(size: 12.5))
                    .scrollContentBackground(.hidden)
                    .padding(6)
                    .frame(height: 90)
                    .background(ToolrollPalette.codeBg, in: RoundedRectangle(cornerRadius: 5))
                    .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(ToolrollPalette.inputLine, lineWidth: 1))
            }

            HStack(spacing: 8) {
                Toggle("Plan first (review & approve plan in-app before building)", isOn: $planFirst)
                    .toggleStyle(.checkbox)
                    .font(.system(size: 12))
                    .foregroundStyle(ToolrollPalette.ink)
                Spacer()
            }

            HStack {
                Spacer()
                Button("Cancel") {
                    store.isNewTaskSheetOpen = false
                    dismiss()
                }
                .buttonStyle(KitButtonStyle(.ghost))

                Button(planFirst ? "File & Plan" : "File & Build") {
                    submit()
                }
                .buttonStyle(KitButtonStyle(.primary))
                .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(20)
        .frame(width: 480)
        .background(ToolrollPalette.paper)
        .onAppear {
            project = store.selectedProject ?? ""
            titleFocused = true
        }
    }

    private func submit() {
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        let proj = project.isEmpty ? nil : project
        let b = details.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            await store.createTask(title: t, project: proj, body: b, planFirst: planFirst)
            dismiss()
        }
    }
}
