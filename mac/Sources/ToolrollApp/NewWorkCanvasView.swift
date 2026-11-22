import SwiftUI
import ToolrollCore

/// Serene, centered builder canvas when creating new work (⌘N or compose icon).
/// Puts the prompt front-and-center with inline mode & project switching — zero modal clutter.
public struct NewWorkCanvasView: View {
    @Bindable var store: WorkbenchStore

    enum ComposeMode: String, CaseIterable, Identifiable {
        case planFirst = "Plan first"
        case justCode = "Just code"
        case askLead = "Ask Lead"
        var id: String { rawValue }
    }

    @State private var promptText: String = ""
    @State private var mode: ComposeMode = .planFirst
    @State private var targetProject: String? = nil
    @State private var isModelPickerOpen: Bool = false
    @FocusState private var promptFocused: Bool

    public init(store: WorkbenchStore) {
        self.store = store
    }

    private var activeProjectLabel: String {
        targetProject ?? store.selectedProject ?? store.allProjects.first ?? "workspace"
    }

    private var activeModelBadge: String {
        if mode == .askLead { return "Central Lead" }
        let key = (mode == .planFirst) ? "plan" : "build"
        if let role = store.modelsRead.roles.first(where: { $0.key == key }), !role.words.isEmpty {
            return role.words
        }
        return store.agentsRead.firstTask?.name ?? "Default agent"
    }

    public var body: some View {
        VStack(spacing: 0) {
            if let notice = store.notice {
                HStack(spacing: 8) {
                    Circle()
                        .fill(notice.kind == .refusal ? ToolrollPalette.danger : ToolrollPalette.live)
                        .frame(width: 6, height: 6)
                    Text(notice.message)
                        .font(.system(size: 12))
                        .foregroundStyle(notice.kind == .refusal ? ToolrollPalette.danger : ToolrollPalette.ink)
                    Spacer()
                    Button {
                        store.notice = nil
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(ToolrollPalette.muted)
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 8)
                .background(ToolrollPalette.raised)
                HairlineDivider()
            }

            Spacer(minLength: 40)

            VStack(spacing: 18) {
                // Clean centered prompt headline with inline project menu
                VStack(spacing: 6) {
                    HStack(spacing: 6) {
                        Text("What should we build in")
                            .font(.system(size: 24, weight: .medium))
                            .foregroundStyle(ToolrollPalette.ink.opacity(0.88))

                        Menu {
                            Button("Workspace default") { targetProject = "" }
                            if !store.allProjects.isEmpty {
                                Divider()
                                ForEach(store.allProjects, id: \.self) { proj in
                                    Button(proj) { targetProject = proj }
                                }
                            }
                            Divider()
                            Button("Add local folder…") {
                                store.pickAndAddLocalFolder()
                            }
                        } label: {
                            Text(activeProjectLabel)
                                .font(.system(size: 24, weight: .semibold))
                                .foregroundStyle(ToolrollPalette.ink)
                                .underline(color: ToolrollPalette.inputLine)
                        }
                        .menuStyle(.borderlessButton)
                        .fixedSize()

                        Text("?")
                            .font(.system(size: 24, weight: .medium))
                            .foregroundStyle(ToolrollPalette.ink.opacity(0.88))
                    }

                    Button {
                        targetProject = ""
                    } label: {
                        Text(targetProject == "" ? "Building across workspace" : "or start without a project")
                            .font(.system(size: 12))
                            .foregroundStyle(ToolrollPalette.muted)
                    }
                    .buttonStyle(.plain)
                }

                // Elevated composer card
                VStack(spacing: 10) {
                    TextField(
                        mode == .askLead
                            ? "Ask Lead anything about your projects or active tasks…"
                            : "Describe what to build, fix, or refactor…",
                        text: $promptText,
                        axis: .vertical
                    )
                    .textFieldStyle(.plain)
                    .font(.system(size: 14))
                    .foregroundStyle(ToolrollPalette.ink)
                    .lineLimit(3...8)
                    .focused($promptFocused)
                    .onSubmit {
                        submit()
                    }
                    .padding(.horizontal, 4)
                    .padding(.top, 4)

                    HStack(spacing: 8) {
                        // Native macOS segmented mode switcher (Plan first | Just code | Ask Lead)
                        Picker("", selection: $mode) {
                            ForEach(ComposeMode.allCases) { m in
                                Text(m.rawValue).tag(m)
                            }
                        }
                        .pickerStyle(.segmented)
                        .labelsHidden()
                        .controlSize(.small)
                        .frame(width: 248)

                        Spacer()

                        Button {
                            isModelPickerOpen.toggle()
                        } label: {
                            HStack(spacing: 5) {
                                Image(systemName: "cpu")
                                    .font(.system(size: 10.5))
                                Text(activeModelBadge)
                                    .font(.system(size: 11.5, weight: .medium))
                                Image(systemName: "chevron.down")
                                    .font(.system(size: 8, weight: .semibold))
                            }
                            .foregroundStyle(ToolrollPalette.ink)
                            .padding(.horizontal, 9)
                            .padding(.vertical, 5)
                            .background(ToolrollPalette.paper, in: RoundedRectangle(cornerRadius: 5))
                            .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(ToolrollPalette.line, lineWidth: 1))
                        }
                        .buttonStyle(.plain)
                        .popover(isPresented: $isModelPickerOpen, arrowEdge: .top) {
                            ModelPickerPopover(
                                store: store,
                                initialRoleKey: mode == .planFirst ? "plan" : "build",
                                onDismiss: { isModelPickerOpen = false }
                            )
                        }

                        Button {
                            submit()
                        } label: {
                            Image(systemName: "arrow.up")
                                .font(.system(size: 12, weight: .bold))
                                .foregroundStyle(ToolrollPalette.inverseInk)
                                .frame(width: 26, height: 26)
                                .background(
                                    promptText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                        ? ToolrollPalette.muted.opacity(0.35)
                                        : ToolrollPalette.ink,
                                    in: Circle()
                                )
                        }
                        .buttonStyle(.plain)
                        .disabled(promptText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
                .padding(14)
                .background(ToolrollPalette.composer, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(ToolrollPalette.inputLine, lineWidth: 1)
                )

                // Whisper-quiet footer context line under composer
                HStack(spacing: 12) {
                    Label(targetProject == "" ? "Workspace" : activeProjectLabel, systemImage: "folder")
                        .font(.system(size: 11.5))
                        .foregroundStyle(ToolrollPalette.muted)

                    Spacer()

                    Text(modeHint)
                        .font(.system(size: 11.5))
                        .foregroundStyle(ToolrollPalette.muted)
                }
                .padding(.horizontal, 4)
            }
            .frame(maxWidth: 620)
            .padding(.horizontal, 32)

            Spacer(minLength: 80)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(ToolrollPalette.paper)
        .onAppear {
            targetProject = store.selectedProject
            promptFocused = true
        }
    }

    private var modeHint: String {
        switch mode {
        case .planFirst: return "Review & approve plan in-app before building"
        case .justCode: return "Files straight into a build run"
        case .askLead: return "Opens in Lead Thread"
        }
    }

    private func submit() {
        let trimmed = promptText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        promptText = ""
        let proj = (targetProject ?? store.selectedProject)
        let cleanProj = (proj?.isEmpty ?? true) ? nil : proj

        if mode == .askLead {
            store.isInspectorVisible = true
            store.inspectorTab = .lead
            Task { await store.sendLeadMessage(trimmed) }
            return
        }

        Task {
            await store.createTask(
                title: trimmed,
                project: cleanProj,
                body: "",
                planFirst: mode == .planFirst
            )
        }
    }
}
