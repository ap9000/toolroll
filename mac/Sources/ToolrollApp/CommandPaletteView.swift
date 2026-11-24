import SwiftUI
import ToolrollCore

public struct CommandPaletteView: View {
    @Bindable var store: WorkbenchStore
    @State private var query: String = ""
    @State private var selectedIndex: Int = 0
    @FocusState private var searchFocused: Bool

    public init(store: WorkbenchStore) {
        self.store = store
    }

    private var results: [PaletteItem] {
        CommandPaletteEngine.filter(items: store.paletteItems(), query: query)
    }

    public var body: some View {
        ZStack {
            Color.black.opacity(0.22)
                .ignoresSafeArea()
                .onTapGesture {
                    store.isCommandPaletteOpen = false
                }

            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 13))
                        .foregroundStyle(ToolrollPalette.muted)

                    TextField("Jump to task, promote Candidate, hand off, or attach terminal…", text: $query)
                        .textFieldStyle(.plain)
                        .font(.system(size: 14))
                        .foregroundStyle(ToolrollPalette.ink)
                        .focused($searchFocused)
                        .onSubmit { executeSelected() }

                    Text("ESC")
                        .font(.system(size: 10, weight: .semibold, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.muted)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 2)
                        .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 3))
                        .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(ToolrollPalette.line, lineWidth: 1))
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)

                HairlineDivider()

                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 2) {
                            if results.isEmpty {
                                Text("No matching commands or tasks.")
                                    .font(.system(size: 12.5))
                                    .foregroundStyle(ToolrollPalette.muted)
                                    .padding(20)
                            } else {
                                ForEach(Array(results.enumerated()), id: \.element.id) { idx, item in
                                    paletteRow(item, isSelected: idx == selectedIndex)
                                        .id(idx)
                                        .onTapGesture {
                                            Task { await store.executePaletteAction(item.action) }
                                        }
                                }
                            }
                        }
                        .padding(6)
                    }
                    .frame(maxHeight: 340)
                    .onChange(of: selectedIndex) { _, next in
                        proxy.scrollTo(next, anchor: .center)
                    }
                }
            }
            .frame(width: 560)
            .toolrollGlassPanel(cornerRadius: 12)
            .padding(.top, 70)
            .frame(maxHeight: .infinity, alignment: .top)
        }
        .onAppear {
            selectedIndex = 0
            searchFocused = true
        }
        .onChange(of: query) { _, _ in
            selectedIndex = 0
        }
        .onKeyPress(.upArrow) {
            guard !results.isEmpty else { return .ignored }
            selectedIndex = (selectedIndex - 1 + results.count) % results.count
            return .handled
        }
        .onKeyPress(.downArrow) {
            guard !results.isEmpty else { return .ignored }
            selectedIndex = (selectedIndex + 1) % results.count
            return .handled
        }
        .onKeyPress(.escape) {
            store.isCommandPaletteOpen = false
            return .handled
        }
    }

    private func paletteRow(_ item: PaletteItem, isSelected: Bool) -> some View {
        HStack(spacing: 10) {
            Text(item.category)
                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                .foregroundStyle(ToolrollPalette.muted)
                .frame(width: 82, alignment: .leading)

            VStack(alignment: .leading, spacing: 2) {
                Text(item.title)
                    .font(.system(size: 13, weight: isSelected ? .semibold : .medium))
                    .foregroundStyle(ToolrollPalette.ink)
                    .lineLimit(1)
                Text(item.subtitle)
                    .font(.system(size: 11))
                    .foregroundStyle(ToolrollPalette.muted)
                    .lineLimit(1)
            }

            Spacer()

            if let hint = item.shortcutHint {
                Text(hint)
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.muted)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 3))
                    .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(ToolrollPalette.line, lineWidth: 1))
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(
            isSelected ? ToolrollPalette.selection : Color.clear,
            in: RoundedRectangle(cornerRadius: 5, style: .continuous)
        )
        .contentShape(Rectangle())
    }

    private func executeSelected() {
        guard results.indices.contains(selectedIndex) else { return }
        let action = results[selectedIndex].action
        Task { await store.executePaletteAction(action) }
    }
}
