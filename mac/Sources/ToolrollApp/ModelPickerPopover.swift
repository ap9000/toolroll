import SwiftUI
import ToolrollCore

/// Sleek 3-zone searchable Model & Role Picker popover triggered directly from the Composer.
/// Left: Provider rail | Center: Instant searchable model list | Right: Toolroll Role scope (All / Planner / Builder / Reviewer).
public struct ModelPickerPopover: View {
    @Bindable var store: WorkbenchStore
    let initialRoleKey: String
    let onDismiss: () -> Void

    @State private var selectedProvider: String? = nil // nil = All
    @State private var targetRoleKey: String = "all"   // "all" | "plan" | "build" | "review"
    @State private var query: String = ""
    @State private var showAllModels: Bool = false
    @State private var passwordInput: String = ""
    @State private var highlightedIndex: Int = 0
    @FocusState private var searchFocused: Bool

    public init(store: WorkbenchStore, initialRoleKey: String = "all", onDismiss: @escaping () -> Void) {
        self.store = store
        self.initialRoleKey = initialRoleKey
        self.onDismiss = onDismiss
    }

    private struct FlatModelEntry: Identifiable, Equatable {
        var id: String { option.value }
        let provider: String
        let providerLabel: String
        let option: ModelOption
    }

    private var activeRole: ModelRoleSummary? {
        if targetRoleKey == "all" {
            return store.modelsRead.roles.first(where: { $0.key == "build" }) ?? store.modelsRead.roles.first
        }
        return store.modelsRead.roles.first(where: { $0.key == targetRoleKey }) ?? store.modelsRead.roles.first
    }

    private var providers: [ModelChoice] {
        activeRole?.choices ?? []
    }

    private var allEntries: [FlatModelEntry] {
        var list: [FlatModelEntry] = []
        for choice in providers {
            if let filter = selectedProvider, choice.provider != filter { continue }
            for opt in choice.models {
                list.append(FlatModelEntry(provider: choice.provider, providerLabel: choice.label, option: opt))
            }
        }
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if q.isEmpty { return list }
        return list.filter {
            $0.option.label.lowercased().contains(q)
                || $0.option.value.lowercased().contains(q)
                || $0.providerLabel.lowercased().contains(q)
        }
    }

    private var displayedEntries: [FlatModelEntry] {
        if showAllModels || !query.isEmpty { return allEntries }
        return Array(allEntries.prefix(7))
    }

    private var currentValueForScope: String {
        activeRole?.current ?? ""
    }

    public var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                // LEFT RAIL: Provider icons
                VStack(spacing: 6) {
                    providerButton(id: nil, label: "All", symbol: "star.fill")
                    HairlineDivider().padding(.horizontal, 8)
                    ForEach(providers) { choice in
                        providerButton(id: choice.provider, label: choice.label, symbol: providerSymbol(choice.provider))
                    }
                    Spacer()
                }
                .padding(.vertical, 10)
                .frame(width: 44)
                .background(ToolrollPalette.ground)

                HairlineDivider(vertical: true)

                // CENTER: Search + Model list
                VStack(spacing: 0) {
                    HStack(spacing: 7) {
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 11.5))
                            .foregroundStyle(ToolrollPalette.muted)
                        TextField("Search models…", text: $query)
                            .textFieldStyle(.plain)
                            .font(.system(size: 12.5))
                            .foregroundStyle(ToolrollPalette.ink)
                            .focused($searchFocused)
                            .onSubmit {
                                selectHighlightedModel()
                            }
                        if !query.isEmpty {
                            Button {
                                query = ""
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .font(.system(size: 11))
                                    .foregroundStyle(ToolrollPalette.muted)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)

                    HairlineDivider()

                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 2) {
                            if displayedEntries.isEmpty {
                                Text(providers.isEmpty ? "No models detected yet." : "No models match \"\(query)\".")
                                    .font(.system(size: 12))
                                    .foregroundStyle(ToolrollPalette.muted)
                                    .padding(14)
                            } else {
                                ForEach(Array(displayedEntries.enumerated()), id: \.element.id) { idx, entry in
                                    modelRow(entry, isHighlighted: idx == highlightedIndex, shortcutNumber: idx < 6 ? idx + 1 : nil)
                                }
                                if !showAllModels && query.isEmpty && allEntries.count > displayedEntries.count {
                                    Button {
                                        showAllModels = true
                                    } label: {
                                        Text("Show \(allEntries.count - displayedEntries.count) more")
                                            .font(.system(size: 11.5, weight: .medium))
                                            .foregroundStyle(ToolrollPalette.muted)
                                            .padding(.horizontal, 10)
                                            .padding(.vertical, 7)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                        .padding(6)
                    }
                    .frame(maxHeight: 270)
                }
                .frame(width: 265)

                HairlineDivider(vertical: true)

                // RIGHT COLUMN: Toolroll Role Scope (All / Planner / Builder / Reviewer)
                VStack(alignment: .leading, spacing: 0) {
                    HStack {
                        Text("Apply to")
                            .font(.system(size: 11.5, weight: .semibold))
                            .foregroundStyle(ToolrollPalette.muted)
                        Spacer()
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)

                    HairlineDivider()

                    VStack(alignment: .leading, spacing: 2) {
                        roleOption(key: "all", title: "All roles", subtitle: "Planner, Builder & Reviewer")
                        ForEach(store.modelsRead.roles) { role in
                            roleOption(key: role.key, title: role.label, subtitle: role.words)
                        }
                    }
                    .padding(6)

                    Spacer()

                    if !store.modelsRead.presets.isEmpty {
                        HairlineDivider()
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Quick Presets")
                                .font(.system(size: 10, weight: .semibold))
                                .textCase(.uppercase)
                                .tracking(0.5)
                                .foregroundStyle(ToolrollPalette.muted)
                                .padding(.horizontal, 6)
                            ForEach(store.modelsRead.presets) { preset in
                                Button {
                                    Task {
                                        await store.applyModelPreset(preset)
                                        if store.modelPasswordPrompt == nil { onDismiss() }
                                    }
                                } label: {
                                    HStack {
                                        Text(preset.name)
                                            .font(.system(size: 11.5, weight: .medium))
                                            .foregroundStyle(ToolrollPalette.ink)
                                        Spacer()
                                        Text(preset.words)
                                            .font(.system(size: 10, design: .monospaced))
                                            .foregroundStyle(ToolrollPalette.muted)
                                            .lineLimit(1)
                                    }
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 5)
                                    .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 4))
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(8)
                    }
                }
                .frame(width: 205)
                .background(ToolrollPalette.paper)
            }

            // Optional inline password confirmation if the Engine requires step-up
            if let prompt = store.modelPasswordPrompt {
                HairlineDivider()
                HStack(spacing: 8) {
                    SecureField(prompt, text: $passwordInput)
                        .textFieldStyle(.plain)
                        .font(.system(size: 12))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 5)
                        .background(ToolrollPalette.codeBg, in: RoundedRectangle(cornerRadius: 4))
                        .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(ToolrollPalette.inputLine, lineWidth: 1))
                    Button("Confirm") {
                        let pw = passwordInput
                        passwordInput = ""
                        Task {
                            await store.retryPendingModelChange(password: pw)
                            if store.modelPasswordPrompt == nil { onDismiss() }
                        }
                    }
                    .buttonStyle(KitButtonStyle(.primary, compact: true))
                    .disabled(passwordInput.isEmpty)
                }
                .padding(10)
                .background(ToolrollPalette.raised)
            }
        }
        .frame(width: 516)
        .background(ToolrollPalette.paper)
        .onAppear {
            targetRoleKey = initialRoleKey
            highlightedIndex = 0
            searchFocused = true
        }
        .onChange(of: query) { _, _ in
            highlightedIndex = 0
        }
        .onKeyPress(.downArrow) {
            guard !displayedEntries.isEmpty else { return .ignored }
            highlightedIndex = min(displayedEntries.count - 1, highlightedIndex + 1)
            return .handled
        }
        .onKeyPress(.upArrow) {
            guard !displayedEntries.isEmpty else { return .ignored }
            highlightedIndex = max(0, highlightedIndex - 1)
            return .handled
        }
        .onKeyPress(.return) {
            selectHighlightedModel()
            return .handled
        }
    }

    private func selectHighlightedModel() {
        guard highlightedIndex >= 0 && highlightedIndex < displayedEntries.count else { return }
        let entry = displayedEntries[highlightedIndex]
        Task {
            await store.selectModel(value: entry.option.value, label: entry.option.label, forRoleKey: targetRoleKey)
            if store.modelPasswordPrompt == nil { onDismiss() }
        }
    }

    private func providerButton(id: String?, label: String, symbol: String) -> some View {
        let active = selectedProvider == id
        return Button {
            selectedProvider = id
        } label: {
            Image(systemName: symbol)
                .font(.system(size: 12.5, weight: active ? .semibold : .regular))
                .foregroundStyle(active ? ToolrollPalette.ink : ToolrollPalette.muted)
                .frame(width: 30, height: 28)
                .background(active ? ToolrollPalette.paper : Color.clear, in: RoundedRectangle(cornerRadius: 5))
                .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(active ? ToolrollPalette.line : Color.clear, lineWidth: 1))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(label)
    }

    private func modelRow(_ entry: FlatModelEntry, isHighlighted: Bool, shortcutNumber: Int?) -> some View {
        let isCurrent = entry.option.value == currentValueForScope
        return Button {
            Task {
                await store.selectModel(value: entry.option.value, label: entry.option.label, forRoleKey: targetRoleKey)
                if store.modelPasswordPrompt == nil { onDismiss() }
            }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: providerSymbol(entry.provider))
                    .font(.system(size: 11))
                    .foregroundStyle(ToolrollPalette.muted)
                    .frame(width: 16)

                VStack(alignment: .leading, spacing: 1) {
                    Text(entry.option.label)
                        .font(.system(size: 12.5, weight: isCurrent ? .semibold : .regular))
                        .foregroundStyle(ToolrollPalette.ink)
                        .lineLimit(1)
                    if selectedProvider == nil {
                        Text(entry.providerLabel)
                            .font(.system(size: 10))
                            .foregroundStyle(ToolrollPalette.muted)
                    }
                }

                Spacer(minLength: 4)

                if isCurrent {
                    Image(systemName: "checkmark")
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundStyle(ToolrollPalette.ink)
                } else if let n = shortcutNumber {
                    Text("⌘\(n)")
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.muted.opacity(0.75))
                        .padding(.horizontal, 4)
                        .padding(.vertical, 1.5)
                        .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 3))
                }
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 6.5)
            .background(isHighlighted ? ToolrollPalette.selection : (isCurrent ? ToolrollPalette.raised : Color.clear), in: RoundedRectangle(cornerRadius: 5))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func roleOption(key: String, title: String, subtitle: String) -> some View {
        let active = targetRoleKey == key
        return Button {
            targetRoleKey = key
        } label: {
            HStack(alignment: .top, spacing: 6) {
                VStack(alignment: .leading, spacing: 1.5) {
                    Text(title)
                        .font(.system(size: 12, weight: active ? .semibold : .regular))
                        .foregroundStyle(ToolrollPalette.ink)
                    Text(subtitle)
                        .font(.system(size: 10.5))
                        .foregroundStyle(ToolrollPalette.muted)
                        .lineLimit(1)
                }
                Spacer()
                if active {
                    Image(systemName: "checkmark")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(ToolrollPalette.ink)
                        .padding(.top, 2)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(active ? ToolrollPalette.raised : Color.clear, in: RoundedRectangle(cornerRadius: 5))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func providerSymbol(_ provider: String) -> String {
        switch provider.lowercased() {
        case "claude", "anthropic": return "sparkles"
        case "codex", "openai": return "cpu"
        case "gemini", "google": return "diamond"
        case "antigravity": return "arrow.up.forward.circle"
        default: return "bolt"
        }
    }
}
