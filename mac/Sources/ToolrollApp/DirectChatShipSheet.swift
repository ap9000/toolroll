import SwiftUI
import ToolrollCore

public struct DirectChatShipSheet: View {
    @Bindable var store: WorkbenchStore
    @Environment(\.dismiss) private var dismiss

    @State private var selectedMode: String = "ship"
    @State private var titleDraft: String = ""
    @State private var goalDraft: String = ""
    @State private var passwordDraft: String = ""
    @State private var didSeedDrafts: Bool = false

    public init(store: WorkbenchStore) {
        self.store = store
    }

    private var preview: DirectChatShipPreview? {
        store.chatShipPreview
    }

    private var needsRepreview: Bool {
        guard let preview else { return false }
        return preview.mode != selectedMode
            || preview.title != titleDraft.trimmingCharacters(in: .whitespacesAndNewlines)
            || preview.goal != goalDraft.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            HairlineDivider()

            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if store.isLoadingChatShipPreview && preview == nil {
                        HStack(spacing: 10) {
                            ProgressView().controlSize(.small)
                            Text("Inspecting isolated clone changes…")
                                .font(.system(size: 12.5))
                                .foregroundStyle(ToolrollPalette.muted)
                        }
                        .padding(.vertical, 24)
                        .frame(maxWidth: .infinity, alignment: .center)
                    } else if let preview {
                        modePicker(preview)
                        termsFields
                        changedFilesSection(preview)
                        verificationSection(preview)
                        summaryBox(preview)
                        if selectedMode == "ship" && store.passwordSet == true && store.effectivePassword("").isEmpty {
                            passwordField
                        }
                    }

                    if let err = store.chatShipError, !err.isEmpty {
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .font(.system(size: 12))
                                .foregroundStyle(ToolrollPalette.danger)
                            VStack(alignment: .leading, spacing: 6) {
                                Text(err)
                                    .font(.system(size: 12))
                                    .foregroundStyle(ToolrollPalette.danger)
                                    .fixedSize(horizontal: false, vertical: true)
                                if let tid = store.chatShipThreadId, store.chatGitBindingErrors[tid] != nil {
                                    Button("Repair Workspace Git Binding") {
                                        Task {
                                            await store.repairChatGitBinding(threadId: tid)
                                            await store.reloadChatShipPreview(mode: nil, title: nil, goal: nil)
                                        }
                                    }
                                    .buttonStyle(KitButtonStyle(.ghost, compact: true))
                                }
                            }
                        }
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(ToolrollPalette.danger.opacity(0.09), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    }
                }
                .padding(18)
            }

            HairlineDivider()
            footer
        }
        .frame(width: 540, height: 560)
        .background(ToolrollPalette.ground)
        .onChange(of: store.chatShipPreview) { _, newPreview in
            guard let newPreview else { return }
            if !didSeedDrafts {
                selectedMode = newPreview.mode
                titleDraft = newPreview.title
                goalDraft = newPreview.goal
                didSeedDrafts = true
            } else {
                selectedMode = newPreview.mode
            }
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "arrow.up.right.square.fill")
                .font(.system(size: 15))
                .foregroundStyle(ToolrollPalette.ink)
            VStack(alignment: .leading, spacing: 2) {
                Text("Ship Chat Snapshot")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.ink)
                Text("Freezes a snapshot commit from this chat's isolated clone without interrupting your chat.")
                    .font(.system(size: 11.5))
                    .foregroundStyle(ToolrollPalette.muted)
            }
            Spacer()
            Button("Close") {
                store.isChatShipSheetOpen = false
                dismiss()
            }
            .buttonStyle(.plain)
            .font(.system(size: 12))
            .foregroundStyle(ToolrollPalette.muted)
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 14)
        .background(ToolrollPalette.raised)
    }

    @ViewBuilder
    private func modePicker(_ preview: DirectChatShipPreview) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Destination")
                .font(.system(size: 11.5, weight: .semibold))
                .foregroundStyle(ToolrollPalette.muted)
            Picker("Mode", selection: $selectedMode) {
                if preview.canAutoMerge {
                    Text("Verify & Auto-Merge PR").tag("ship")
                }
                Text("Keep Local Branch").tag("keep-branch")
            }
            .pickerStyle(.segmented)
            .onChange(of: selectedMode) { _, newMode in
                Task {
                    await store.reloadChatShipPreview(
                        mode: newMode,
                        title: titleDraft.isEmpty ? nil : titleDraft,
                        goal: goalDraft.isEmpty ? nil : goalDraft
                    )
                }
            }

            if !preview.canAutoMerge, let reason = preview.autoMergeReason {
                Text(reason)
                    .font(.system(size: 11.5))
                    .foregroundStyle(ToolrollPalette.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var termsFields: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Title")
                    .font(.system(size: 11.5, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.muted)
                TextField("Short summary of this change", text: $titleDraft)
                    .textFieldStyle(.plain)
                    .font(.system(size: 13))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)
                    .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))
            }

            VStack(alignment: .leading, spacing: 4) {
                Text("Goal / Description")
                    .font(.system(size: 11.5, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.muted)
                TextField("What this snapshot ships", text: $goalDraft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .font(.system(size: 12.5))
                    .lineLimit(2...4)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)
                    .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))
            }
        }
    }

    private func changedFilesSection(_ preview: DirectChatShipPreview) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Changed files (\(preview.changedFiles.count))")
                    .font(.system(size: 11.5, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.muted)
                Spacer()
                Text("Branch: \(preview.branch)")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.muted)
            }
            VStack(alignment: .leading, spacing: 3) {
                ForEach(preview.changedFiles.prefix(16), id: \.self) { file in
                    Text(file)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.ink.opacity(0.9))
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                if preview.changedFiles.count > 16 {
                    Text("+ \(preview.changedFiles.count - 16) more files")
                        .font(.system(size: 11))
                        .foregroundStyle(ToolrollPalette.muted)
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))
        }
    }

    private func verificationSection(_ preview: DirectChatShipPreview) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            if let check = preview.checkCommand, selectedMode == "ship" {
                HStack(spacing: 6) {
                    Image(systemName: "checkmark.shield")
                        .font(.system(size: 11.5))
                        .foregroundStyle(ToolrollPalette.success)
                    Text("Check command:")
                        .font(.system(size: 11.5, weight: .medium))
                        .foregroundStyle(ToolrollPalette.muted)
                    Text(check)
                        .font(.system(size: 11.5, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.ink)
                        .lineLimit(1)
                }
            }
            if let repo = preview.githubRepo, let base = preview.githubBase, selectedMode == "ship" {
                HStack(spacing: 6) {
                    Image(systemName: "arrow.triangle.pull")
                        .font(.system(size: 11.5))
                        .foregroundStyle(ToolrollPalette.live)
                    Text("Pull request:")
                        .font(.system(size: 11.5, weight: .medium))
                        .foregroundStyle(ToolrollPalette.muted)
                    Text("\(repo) → \(base)")
                        .font(.system(size: 11.5, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.ink)
                }
            }
            HStack(spacing: 6) {
                Image(systemName: "lock.shield")
                    .font(.system(size: 11))
                    .foregroundStyle(ToolrollPalette.muted)
                Text("Terms digest \(preview.termsDigest.prefix(12)) · base \(preview.baseSha.prefix(8))")
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.muted)
            }
        }
    }

    private func summaryBox(_ preview: DirectChatShipPreview) -> some View {
        Text(preview.mergeSummary)
            .font(.system(size: 12))
            .foregroundStyle(ToolrollPalette.ink.opacity(0.9))
            .fixedSize(horizontal: false, vertical: true)
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(ToolrollPalette.codeBg, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))
    }

    private var passwordField: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Password (if required for step-up)")
                .font(.system(size: 11.5, weight: .semibold))
                .foregroundStyle(ToolrollPalette.muted)
            SecureField("Optional on solo laptop", text: $passwordDraft)
                .textFieldStyle(.plain)
                .font(.system(size: 12.5))
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))
        }
    }

    private var footer: some View {
        HStack(spacing: 10) {
            Button("Refresh Terms") {
                Task {
                    await store.reloadChatShipPreview(
                        mode: selectedMode,
                        title: titleDraft.isEmpty ? nil : titleDraft,
                        goal: goalDraft.isEmpty ? nil : goalDraft
                    )
                }
            }
            .buttonStyle(KitButtonStyle(.ghost, compact: true))
            .disabled(store.isLoadingChatShipPreview || store.isExecutingChatShip)

            Spacer()

            Button("Cancel") {
                store.isChatShipSheetOpen = false
                dismiss()
            }
            .buttonStyle(KitButtonStyle(.ghost, compact: true))
            .disabled(store.isExecutingChatShip)

            Button {
                Task {
                    if needsRepreview {
                        await store.reloadChatShipPreview(
                            mode: selectedMode,
                            title: titleDraft,
                            goal: goalDraft
                        )
                    }
                    let ok = await store.executeChatShip(
                        mode: selectedMode,
                        title: titleDraft,
                        goal: goalDraft,
                        password: passwordDraft
                    )
                    if ok {
                        dismiss()
                    }
                }
            } label: {
                HStack(spacing: 6) {
                    if store.isExecutingChatShip {
                        ProgressView().controlSize(.mini)
                    }
                    Text(selectedMode == "ship" ? "Ship & Auto-Merge" : "Save Local Branch")
                }
            }
            .buttonStyle(KitButtonStyle(.primary, compact: true))
            .disabled(preview == nil || store.isLoadingChatShipPreview || store.isExecutingChatShip)
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
        .background(ToolrollPalette.raised)
    }
}
