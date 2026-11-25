import SwiftUI
import ToolrollCore

public struct ModelPickerPopover: View {
    @Bindable var store: WorkbenchStore
    let initialRoleKey: String
    let onDismiss: () -> Void
    let taskId: String?

    @State private var selectedProvider: String? = nil
    @State private var targetRoleKey: String = "all"
    @State private var query: String = ""
    @State private var showAllModels: Bool = true
    @State private var passwordInput: String = ""
    @State private var highlightedIndex: Int? = nil
    @FocusState private var searchFocused: Bool

    public init(store: WorkbenchStore, initialRoleKey: String = "all", taskId: String? = nil, onDismiss: @escaping () -> Void) {
        self.store = store
        self.taskId = taskId
        self.initialRoleKey = initialRoleKey
        self.onDismiss = onDismiss
    }

    private struct FlatModelEntry: Identifiable, Equatable {
        var formValue: String {
            option.value.contains("|") ? option.value : "\(provider)|\(option.value)"
        }
        var id: String { formValue }
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

    private var taskChoices: TaskAgentChoices? {
        taskId.flatMap { store.taskStepsForPicker($0)?.agentChoices }
    }

    private var providers: [ModelChoice] {
        if let taskChoices {
            let allowed = taskChoices.forRole(targetRoleKey)
            if !allowed.isEmpty {
                return Dictionary(grouping: allowed, by: \.provider).keys.sorted().map { provider in
                    ModelChoice(
                        provider: provider,
                        label: Self.providerDisplayName(provider),
                        models: allowed.filter { $0.provider == provider }.map { ModelOption(value: $0.model, label: $0.model) }
                    )
                }
            }
        }
        var list = activeRole?.choices ?? []
        let installedIds = Set(store.agentsRead.agents.filter(\.ready).map { $0.id.lowercased() })

        if !list.contains(where: { $0.provider == "claude" }) {
            let claudeInstalled = installedIds.contains("claude")
                || Self.hasExecutable("claude")
                || store.modelsRead.roles.contains(where: { $0.current.hasPrefix("claude|") })
            if claudeInstalled || store.isLocalSession {
                list.insert(ModelChoice(
                    provider: "claude",
                    label: "Claude Code",
                    models: [
                        ModelOption(value: "claude-opus-5-5", label: "Claude Opus 5.5"),
                        ModelOption(value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6"),
                        ModelOption(value: "claude-haiku-4-5", label: "Claude Haiku 4.5"),
                    ]
                ), at: 0)
            }
        }

        if !list.contains(where: { $0.provider == "codex" }) {
            let liveCodex = Self.loadLocalCodexModels()
            let codexInstalled = installedIds.contains("codex")
                || !liveCodex.isEmpty
                || Self.hasExecutable("codex")
                || store.modelsRead.roles.contains(where: { $0.current.hasPrefix("codex|") })
            if codexInstalled || store.isLocalSession {
                let insertIdx = min(1, list.count)
                list.insert(ModelChoice(
                    provider: "codex",
                    label: "Codex",
                    models: liveCodex.isEmpty ? [
                        ModelOption(value: "gpt-6-astra", label: "GPT-6 Astra"),
                        ModelOption(value: "gpt-6-sol", label: "GPT-6 Sol"),
                        ModelOption(value: "gpt-6-luna", label: "GPT-6 Luna"),
                    ] : liveCodex
                ), at: insertIdx)
            }
        }

        if targetRoleKey != "review", !list.contains(where: { $0.provider == "antigravity" }) {
            if installedIds.contains("antigravity") || Self.hasExecutable("agy") {
                list.append(ModelChoice(
                    provider: "antigravity",
                    label: "Gemini (Antigravity)",
                    models: [
                        ModelOption(value: "gemini-4-neon", label: "Gemini 4 Neon"),
                        ModelOption(value: "gemini-4-carbon", label: "Gemini 4 Carbon"),
                        ModelOption(value: "gemini-3.8-flash", label: "Gemini 3.8 Flash"),
                    ]
                ))
            }
        }

        if targetRoleKey != "review", !list.contains(where: { $0.provider == "gemini" }) {
            let geminiInstalled = installedIds.contains("gemini") || Self.hasExecutable("gemini")
            if geminiInstalled {
                list.append(ModelChoice(
                    provider: "gemini",
                    label: "Google Gemini",
                    models: [
                        ModelOption(value: "gemini-4-argon", label: "Gemini 4 Argon"),
                        ModelOption(value: "gemini-3.8-flash", label: "Gemini 3.8 Flash"),
                        ModelOption(value: "gemini-3.6-flash", label: "Gemini 3.6 Flash"),
                        ModelOption(value: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite"),
                        ModelOption(value: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro"),
                    ]
                ))
            }
        }

        return list
    }

    private static func providerDisplayName(_ provider: String) -> String {
        switch provider.lowercased() {
        case "claude": return "Claude Code"
        case "codex": return "Codex"
        case "antigravity": return "Gemini (Antigravity)"
        case "gemini": return "Google Gemini"
        default: return provider.prefix(1).uppercased() + provider.dropFirst()
        }
    }

    private static func hasExecutable(_ binary: String) -> Bool {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let candidates = [
            "\(home)/.local/bin/\(binary)",
            "\(home)/.gemini/bin/\(binary)",
            "/opt/homebrew/bin/\(binary)",
            "/usr/local/bin/\(binary)",
        ]
        return candidates.contains { FileManager.default.isExecutableFile(atPath: $0) }
    }

    private static func loadLocalCodexModels() -> [ModelOption] {
        let path = (NSHomeDirectory() as NSString).appendingPathComponent(".codex/models_cache.json")
        guard let data = FileManager.default.contents(atPath: path),
              let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let models = raw["models"] as? [[String: Any]]
        else { return [] }
        return models.compactMap { item -> ModelOption? in
            guard let slug = (item["slug"] as? String) ?? (item["id"] as? String), !slug.isEmpty else { return nil }
            let name = (item["display_name"] as? String) ?? (item["name"] as? String) ?? slug
            return ModelOption(value: slug, label: name)
        }
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
        let cur = currentValueForScope
        if selectedProvider == nil && query.isEmpty && !cur.isEmpty {
            let currentProvider = cur.split(separator: "|").first.map(String.init) ?? ""
            let prioritized = allEntries.filter { $0.provider == currentProvider }
            let others = allEntries.filter { $0.provider != currentProvider }
            return prioritized + others
        }
        return allEntries
    }

    private var currentValueForScope: String {
        activeRole?.current ?? ""
    }

    public var body: some View {
        VStack(spacing: 0) {
            if taskId != nil {
                Text("Models for this task only")
                    .font(.system(size: 11.5, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.ink)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                HairlineDivider()
            }
            HStack(spacing: 0) {
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

                        Button {
                            Task { await store.refreshModelCatalog() }
                        } label: {
                            if store.isCheckingModelCatalog {
                                ProgressView()
                                    .controlSize(.mini)
                                    .frame(width: 16, height: 16)
                            } else {
                                Image(systemName: "arrow.clockwise")
                                    .font(.system(size: 10.5))
                                    .foregroundStyle(ToolrollPalette.muted)
                                    .frame(width: 20, height: 20)
                                    .toolrollHoverSurface(cornerRadius: 4)
                            }
                        }
                        .buttonStyle(.plain)
                        .disabled(store.isCheckingModelCatalog)
                        .help("Detect installed agents (Claude, Codex, Gemini) & refresh model catalog")
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)

                    HairlineDivider()

                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 2) {
                            if displayedEntries.isEmpty {
                                VStack(alignment: .leading, spacing: 8) {
                                    Text(providers.isEmpty ? "No models detected yet." : "No catalog match for \"\(query)\".")
                                        .font(.system(size: 12))
                                        .foregroundStyle(ToolrollPalette.muted)
                                    let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
                                    if !trimmedQuery.isEmpty && taskId == nil {
                                        Text("Use custom model ID directly:")
                                            .font(.system(size: 10.5, weight: .semibold))
                                            .foregroundStyle(ToolrollPalette.muted)
                                        HStack(spacing: 6) {
                                            customModelChip(provider: "gemini", label: "Gemini", modelId: trimmedQuery)
                                            customModelChip(provider: "claude", label: "Claude", modelId: trimmedQuery)
                                            customModelChip(provider: "codex", label: "Codex", modelId: trimmedQuery)
                                        }
                                    } else if !store.isCheckingModelCatalog {
                                        Button("Refresh installed agents & models") {
                                            Task { await store.refreshModelCatalog() }
                                        }
                                        .buttonStyle(KitButtonStyle(.ghost, compact: true))
                                    }
                                }
                                .padding(12)
                            } else {
                                ForEach(Array(displayedEntries.enumerated()), id: \.element.id) { idx, entry in
                                    modelRow(entry, isHighlighted: highlightedIndex == idx, shortcutNumber: idx < 6 ? idx + 1 : nil)
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
                        roleOption(key: "all", title: "All roles", subtitle: taskId == nil ? "Planner, Builder & Reviewer" : "Planner & Builder")
                        ForEach(store.modelsRead.roles.filter { taskId == nil || $0.key == "plan" || $0.key == "build" }) { role in
                            roleOption(key: role.key, title: role.label, subtitle: role.words)
                        }
                    }
                    .padding(6)

                    Spacer()

                    if taskId == nil, !store.modelsRead.presets.isEmpty {
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
                                        if store.modelPasswordPrompt == nil && store.modelChangeError == nil { onDismiss() }
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
                                    .toolrollHoverSurface(cornerRadius: 4)
                                    .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(ToolrollPalette.line, lineWidth: 1))
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

            if let err = store.modelChangeError {
                HairlineDivider()
                HStack(spacing: 8) {
                    Circle().fill(ToolrollPalette.danger).frame(width: 6, height: 6)
                    Text(err)
                        .font(.system(size: 11.5))
                        .foregroundStyle(ToolrollPalette.danger)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer()
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(ToolrollPalette.danger.opacity(0.08))
            }

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
                    ForgotPasswordLink()
                        .onSubmit {
                            submitPasswordConfirmation()
                        }
                    Button("Confirm") {
                        submitPasswordConfirmation()
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
        .task {
            if store.modelsRead.roles.isEmpty {
                await store.refreshModelCatalog()
            }
            if let taskId {
                await store.loadPickerChoices(taskId: taskId)
            }
        }
        .onAppear {
            targetRoleKey = taskId != nil && initialRoleKey == "review" ? "build" : initialRoleKey
            highlightedIndex = nil
            store.modelChangeError = nil
            searchFocused = true
        }
        .onChange(of: query) { _, next in
            highlightedIndex = next.isEmpty ? nil : 0
        }
        .onKeyPress(.downArrow) {
            guard !displayedEntries.isEmpty else { return .ignored }
            if let cur = highlightedIndex {
                highlightedIndex = min(displayedEntries.count - 1, cur + 1)
            } else {
                highlightedIndex = 0
            }
            return .handled
        }
        .onKeyPress(.upArrow) {
            guard !displayedEntries.isEmpty else { return .ignored }
            if let cur = highlightedIndex {
                highlightedIndex = max(0, cur - 1)
            } else {
                highlightedIndex = displayedEntries.count - 1
            }
            return .handled
        }
        .onKeyPress(.return) {
            selectHighlightedModel()
            return .handled
        }
        .onKeyPress(characters: CharacterSet(charactersIn: "123456")) { press in
            guard press.modifiers.contains(.command),
                  let num = Int(press.characters),
                  num >= 1 && num <= displayedEntries.count
            else { return .ignored }
            let entry = displayedEntries[num - 1]
            applyModelEntry(entry)
            return .handled
        }
    }

    private func submitPasswordConfirmation() {
        guard !passwordInput.isEmpty else { return }
        let pw = passwordInput
        passwordInput = ""
        Task {
            await store.retryPendingModelChange(password: pw)
            if store.modelPasswordPrompt == nil && store.modelChangeError == nil {
                onDismiss()
            }
        }
    }

    private func apply(value: String, label: String) async {
        if let taskId {
            await store.setTaskModel(taskId: taskId, roleKey: targetRoleKey, value: value, label: label)
        } else {
            await store.selectModel(value: value, label: label, forRoleKey: targetRoleKey)
        }
    }

    private func applyModelEntry(_ entry: FlatModelEntry) {
        Task {
            await apply(value: entry.formValue, label: entry.option.label)
            if store.modelPasswordPrompt == nil && store.modelChangeError == nil {
                onDismiss()
            }
        }
    }

    private func selectHighlightedModel() {
        let idx = highlightedIndex ?? 0
        guard idx >= 0 && idx < displayedEntries.count else { return }
        applyModelEntry(displayedEntries[idx])
    }

    private func providerButton(id: String?, label: String, symbol: String) -> some View {
        let active = selectedProvider == id
        return Button {
            selectedProvider = id
        } label: {
            Group {
                if let id {
                    ProviderBrandGlyph(provider: id, size: 13.5, tinted: active, inTile: false)
                        .opacity(active ? 1.0 : 0.72)
                } else {
                    Image(systemName: symbol)
                        .font(.system(size: 12.5, weight: active ? .semibold : .regular))
                        .foregroundStyle(active ? ToolrollPalette.ink : ToolrollPalette.muted)
                }
            }
            .frame(width: 30, height: 28)
            .background(active ? ToolrollPalette.paper : Color.clear, in: RoundedRectangle(cornerRadius: 5))
            .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(active ? ToolrollPalette.line : Color.clear, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(label)
    }

    private func modelRow(_ entry: FlatModelEntry, isHighlighted: Bool, shortcutNumber: Int?) -> some View {
        let isCurrent = entry.formValue == currentValueForScope
        return Button {
            applyModelEntry(entry)
        } label: {
            HStack(spacing: 8) {
                ProviderBrandGlyph(provider: entry.provider, size: 13, tinted: true, inTile: false)
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
            .toolrollHoverSurface(cornerRadius: 5, isSelected: isHighlighted || isCurrent)
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
            .toolrollHoverSurface(cornerRadius: 5, isSelected: active)
        }
        .buttonStyle(.plain)
    }

    private func customModelChip(provider: String, label: String, modelId: String) -> some View {
        Button {
            Task {
                await apply(value: "\(provider)|\(modelId)", label: "\(label) · \(modelId)")
                if store.modelPasswordPrompt == nil && store.modelChangeError == nil {
                    onDismiss()
                }
            }
        } label: {
            Text(label)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(ToolrollPalette.ink)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .toolrollHoverSurface(cornerRadius: 5)
                .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(ToolrollPalette.line, lineWidth: 1))
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
