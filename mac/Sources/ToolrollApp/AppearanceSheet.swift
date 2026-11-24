import AppKit
import SwiftUI
import ToolrollCore

struct AppearanceSheet: View {
    @Bindable var store: WorkbenchStore
    @Environment(\.dismiss) private var dismiss
    @State private var leadStylePrompt: String = ""

    private var themeEngine: WorkspaceThemeEngine { WorkspaceThemeEngine.shared }
    private var cfg: WorkspaceAppearanceConfig { themeEngine.config }

    private struct BuiltInTheme: Identifiable {
        let id: String
        let label: String
        let swatches: [Color]
    }

    private var builtInThemes: [BuiltInTheme] {
        [
            BuiltInTheme(id: "signal", label: "Signal (System)", swatches: [
                Color(red: 0.09, green: 0.09, blue: 0.09),
                Color(red: 0.93, green: 0.93, blue: 0.93),
                Color(red: 0.44, green: 0.72, blue: 1.0),
            ]),
            BuiltInTheme(id: "dark", label: "Signal Dark", swatches: [
                Color(red: 0.04, green: 0.04, blue: 0.04),
                Color(red: 0.11, green: 0.11, blue: 0.11),
                Color(red: 0.93, green: 0.93, blue: 0.93),
            ]),
            BuiltInTheme(id: "light", label: "Signal Light", swatches: [
                Color.white,
                Color(red: 0.94, green: 0.94, blue: 0.94),
                Color(red: 0.09, green: 0.09, blue: 0.09),
            ]),
            BuiltInTheme(id: "high-contrast", label: "High Contrast", swatches: [
                Color.black,
                Color(red: 0.25, green: 0.25, blue: 0.25),
                Color.white,
            ]),
        ]
    }

    private var savedCustomThemes: [CustomThemePalette] {
        cfg.savedThemes.values.sorted { $0.name < $1.name }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Workspace Appearance & Lead Themes")
                        .font(.system(size: 15.5, weight: .semibold))
                        .foregroundStyle(ToolrollPalette.ink)
                    Text("Live-synced with ~/.config/toolroll/tui.toml — ask Lead to restyle anytime and watch it update instantly.")
                        .font(.system(size: 11.5))
                        .foregroundStyle(ToolrollPalette.muted)
                }
                Spacer()
                Button("Done") { dismiss() }
                    .buttonStyle(KitButtonStyle(.ghost, compact: true))
            }

            HairlineDivider()

            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    VStack(alignment: .leading, spacing: 8) {
                        sectionHeader("BUILT-IN THEMES")
                        LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], spacing: 8) {
                            ForEach(builtInThemes) { item in
                                let active = cfg.activeTheme.lowercased() == item.id
                                themeTile(
                                    name: item.label,
                                    swatches: item.swatches,
                                    active: active
                                ) {
                                    themeEngine.apply(theme: item.id)
                                }
                            }
                        }
                    }

                    if !savedCustomThemes.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            sectionHeader("LEAD & CUSTOM SAVED THEMES (\(savedCustomThemes.count))")
                            LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], spacing: 8) {
                                ForEach(savedCustomThemes) { pal in
                                    let active = cfg.activeTheme == pal.name
                                    themeTile(
                                        name: pal.name,
                                        swatches: swatches(for: pal),
                                        active: active
                                    ) {
                                        themeEngine.apply(theme: pal.name)
                                    }
                                }
                            }
                        }
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        sectionHeader("CUSTOMIZE WITH LEAD AGENT")
                        HStack(spacing: 8) {
                            TextField("e.g. Warm Kyoto paper theme with amber accents, or dark slate with mint highlights…", text: $leadStylePrompt)
                                .textFieldStyle(.plain)
                                .font(.system(size: 12.5))
                                .padding(9)
                                .background(ToolrollPalette.codeBg, in: RoundedRectangle(cornerRadius: 6))
                                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(ToolrollPalette.inputLine, lineWidth: 1))
                                .onSubmit { sendCustomizationToLead() }

                            Button("Ask Lead") {
                                sendCustomizationToLead()
                            }
                            .buttonStyle(KitButtonStyle(.primary))
                        }
                        Text("Lead calls toolroll_view_set to save & apply your custom theme live — zero restarts.")
                            .font(.system(size: 10.5))
                            .foregroundStyle(ToolrollPalette.muted)
                    }

                    HairlineDivider()

                    VStack(alignment: .leading, spacing: 12) {
                        sectionHeader("LAYOUT & NATIVE CHROME")

                        HStack {
                            Text("Density")
                                .font(.system(size: 12.5))
                                .foregroundStyle(ToolrollPalette.ink)
                            Spacer()
                            Picker("", selection: Binding(
                                get: { cfg.density },
                                set: { themeEngine.apply(density: $0) }
                            )) {
                                Text("Comfortable").tag("comfortable")
                                Text("Compact").tag("compact")
                            }
                            .pickerStyle(.segmented)
                            .labelsHidden()
                            .frame(width: 210)
                        }

                        HStack {
                            Text("Task List Side")
                                .font(.system(size: 12.5))
                                .foregroundStyle(ToolrollPalette.ink)
                            Spacer()
                            Picker("", selection: Binding(
                                get: { cfg.listSide },
                                set: { themeEngine.apply(listSide: $0) }
                            )) {
                                Text("Left").tag("left")
                                Text("Right").tag("right")
                            }
                            .pickerStyle(.segmented)
                            .labelsHidden()
                            .frame(width: 210)
                        }

                        Toggle("Liquid Glass Floating Controls", isOn: Binding(
                            get: { cfg.glassChrome },
                            set: { themeEngine.apply(glassChrome: $0) }
                        ))
                        .font(.system(size: 12.5))

                        Toggle("Translucent macOS Sidebar Vibrancy", isOn: Binding(
                            get: { cfg.sidebarVibrancy },
                            set: { themeEngine.apply(sidebarVibrancy: $0) }
                        ))
                        .font(.system(size: 12.5))

                        Toggle("Show Daily Spend in Sidebar Footer", isOn: Binding(
                            get: { cfg.showCosts },
                            set: { themeEngine.apply(showCosts: $0) }
                        ))
                        .font(.system(size: 12.5))
                    }
                }
            }

            HairlineDivider()

            HStack {
                Button("Reset to Signal Default") {
                    themeEngine.resetToSignal()
                }
                .buttonStyle(KitButtonStyle(.ghost, compact: true))

                Button("Open tui.toml") {
                    let url = WorkspaceThemeStore.configURL
                    if !FileManager.default.fileExists(atPath: url.path) {
                        themeEngine.apply(theme: cfg.activeTheme)
                    }
                    NSWorkspace.shared.open(url)
                }
                .buttonStyle(KitButtonStyle(.ghost, compact: true))

                Spacer()

                Text("Active: \(cfg.activeTheme)")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.muted)
            }
        }
        .padding(20)
        .frame(width: 560, height: 540)
        .background(ToolrollPalette.paper)
    }

    private func sectionHeader(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 10, weight: .semibold, design: .monospaced))
            .tracking(0.7)
            .foregroundStyle(ToolrollPalette.muted)
    }

    private func themeTile(name: String, swatches: [Color], active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                HStack(spacing: -3) {
                    ForEach(Array(swatches.enumerated()), id: \.offset) { _, color in
                        Circle()
                            .fill(color)
                            .frame(width: 14, height: 14)
                            .overlay(Circle().strokeBorder(ToolrollPalette.paper, lineWidth: 1.5))
                    }
                }
                Text(name)
                    .font(.system(size: 12, weight: active ? .semibold : .medium))
                    .foregroundStyle(ToolrollPalette.ink)
                    .lineLimit(1)
                Spacer()
                if active {
                    Image(systemName: "checkmark")
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundStyle(ToolrollPalette.live)
                }
            }
            .padding(.horizontal, 11)
            .padding(.vertical, 9)
            .background(active ? ToolrollPalette.raised : ToolrollPalette.codeBg, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .strokeBorder(active ? ToolrollPalette.ink.opacity(0.6) : ToolrollPalette.line, lineWidth: 1)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func swatches(for pal: CustomThemePalette) -> [Color] {
        let hexes = [pal.ground, pal.paper, pal.ink, pal.selection ?? pal.live].compactMap { $0 }
        let colors = hexes.compactMap { raw -> Color? in
            guard let rgb = WorkspaceThemeStore.parseHex(raw) else { return nil }
            return Color(red: rgb.r, green: rgb.g, blue: rgb.b)
        }
        return colors.isEmpty ? [ToolrollPalette.paper, ToolrollPalette.ink] : colors
    }

    private func sendCustomizationToLead() {
        let userAsk = leadStylePrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let prompt = userAsk.isEmpty
            ? "Let's customize my Toolroll workspace theme using toolroll_view_set. I'm currently using \"\(cfg.activeTheme)\". Propose a refined custom color palette and save + apply it so I can see it live."
            : "Update my Toolroll workspace appearance using toolroll_view_set (save a custom theme and apply it live): \(userAsk)"
        leadStylePrompt = ""
        dismiss()
        store.isInspectorVisible = true
        store.inspectorTab = .lead
        Task {
            await store.sendLeadMessage(prompt)
        }
    }
}
