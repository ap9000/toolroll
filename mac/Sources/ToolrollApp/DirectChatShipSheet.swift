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
    @State private var showDetails: Bool = false

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

    private var primaryButtonLabel: String {
        selectedMode == "ship" ? "Ship" : "Save Branch"
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
                            Text("Preparing changes…")
                                .font(.system(size: 12.5))
                                .foregroundStyle(ToolrollPalette.muted)
                        }
                        .padding(.vertical, 28)
                        .frame(maxWidth: .infinity, alignment: .center)
                    } else if let preview {
                        titleField
                        changedFilesSection(preview)
                        statusSummary(preview)
                        if selectedMode == "ship" && store.passwordSet == true {
                            passwordField
                        }
                        detailsDisclosure(preview)
                    }

                    if let err = store.chatShipError, !err.isEmpty {
                        errorBanner(err)
                    }
                }
                .padding(18)
            }

            HairlineDivider()
            footer
        }
        .frame(width: 510, height: showDetails ? 560 : 420)
        .background(ToolrollPalette.ground)
        .animation(.easeInOut(duration: 0.16), value: showDetails)
        .onDisappear { passwordDraft = "" }
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
                Text("Ship Changes")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.ink)
                Text("Commit changes from this chat and open a PR or save a local branch.")
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

    private var titleField: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text("Title")
                .font(.system(size: 11.5, weight: .semibold))
                .foregroundStyle(ToolrollPalette.muted)
            TextField("Short summary of this change", text: $titleDraft)
                .textFieldStyle(.plain)
                .font(.system(size: 13))
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))
        }
    }

    private func changedFilesSection(_ preview: DirectChatShipPreview) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Changed files (\(preview.changedFiles.count))")
                    .font(.system(size: 11.5, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.muted)
                Spacer()
                Text(preview.branch)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(ToolrollPalette.muted)
            }
            VStack(alignment: .leading, spacing: 3) {
                ForEach(preview.changedFiles.prefix(12), id: \.self) { file in
                    Text(file)
                        .font(.system(size: 11.5, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.ink.opacity(0.9))
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                if preview.changedFiles.count > 12 {
                    Text("+ \(preview.changedFiles.count - 12) more files")
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

    private func statusSummary(_ preview: DirectChatShipPreview) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if let repo = preview.githubRepo, let base = preview.githubBase, selectedMode == "ship" {
                HStack(spacing: 6) {
                    Image(systemName: "arrow.triangle.pull")
                        .font(.system(size: 11.5))
                        .foregroundStyle(ToolrollPalette.live)
                    Text("Opens PR into \(repo) (\(base))")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(ToolrollPalette.ink)
                }
            } else {
                Text(preview.mergeSummary)
                    .font(.system(size: 12))
                    .foregroundStyle(ToolrollPalette.ink.opacity(0.88))
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let check = preview.checkCommand, selectedMode == "ship" {
                HStack(spacing: 6) {
                    Image(systemName: "checkmark.shield")
                        .font(.system(size: 11.5))
                        .foregroundStyle(ToolrollPalette.success)
                    Text("Runs check before merging:")
                        .font(.system(size: 11.5))
                        .foregroundStyle(ToolrollPalette.muted)
                    Text(check)
                        .font(.system(size: 11.5, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.ink)
                        .lineLimit(1)
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ToolrollPalette.codeBg, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))
    }

    private var passwordField: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Confirm with password")
                .font(.system(size: 11.5, weight: .semibold))
                .foregroundStyle(ToolrollPalette.muted)
            SecureField("Account password", text: $passwordDraft)
                .textFieldStyle(.plain)
                .font(.system(size: 12.5))
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))
        }
    }

    private func detailsDisclosure(_ preview: DirectChatShipPreview) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Button {
                showDetails.toggle()
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: showDetails ? "chevron.down" : "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                    Text("Details")
                        .font(.system(size: 12, weight: .medium))
                    Spacer()
                    Text(selectedMode == "ship" ? "Verify & Merge PR" : "Save Branch Locally")
                        .font(.system(size: 11))
                        .foregroundStyle(ToolrollPalette.muted)
                }
                .foregroundStyle(ToolrollPalette.muted)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if showDetails {
                VStack(alignment: .leading, spacing: 12) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text("Destination")
                            .font(.system(size: 11.5, weight: .semibold))
                            .foregroundStyle(ToolrollPalette.muted)
                        Picker("Destination", selection: $selectedMode) {
                            if preview.canAutoMerge {
                                Text("Verify & Merge PR").tag("ship")
                            }
                            Text("Save Branch Locally").tag("keep-branch")
                        }
                        .pickerStyle(.segmented)
                        .labelsHidden()
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

                    VStack(alignment: .leading, spacing: 4) {
                        Text("Description")
                            .font(.system(size: 11.5, weight: .semibold))
                            .foregroundStyle(ToolrollPalette.muted)
                        TextField("Optional notes for the commit or PR", text: $goalDraft, axis: .vertical)
                            .textFieldStyle(.plain)
                            .font(.system(size: 12.5))
                            .lineLimit(2...4)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 7)
                            .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))
                    }

                    HStack(spacing: 8) {
                        Text("Base \(preview.baseSha.prefix(8)) · Ref \(preview.termsDigest.prefix(10))")
                            .font(.system(size: 10.5, design: .monospaced))
                            .foregroundStyle(ToolrollPalette.muted)
                        Spacer()
                        Button("Refresh") {
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
                    }
                }
                .padding(12)
                .background(ToolrollPalette.paper, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))
            }
        }
    }

    private func errorBanner(_ err: String) -> some View {
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
                    Button("Repair Git Workspace") {
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

    private var footer: some View {
        HStack(spacing: 10) {
            Spacer()

            Button("Cancel") {
                store.isChatShipSheetOpen = false
                dismiss()
            }
            .buttonStyle(KitButtonStyle(.ghost, compact: true))
            .disabled(store.isExecutingChatShip)

            Button {
                submitShip()
            } label: {
                HStack(spacing: 6) {
                    if store.isExecutingChatShip {
                        ProgressView().controlSize(.mini)
                    }
                    Text(primaryButtonLabel)
                    Text("⌘⏎")
                        .font(.system(size: 10.5, weight: .medium))
                        .opacity(0.75)
                }
            }
            .buttonStyle(KitButtonStyle(.primary, compact: true))
            .keyboardShortcut(.return, modifiers: [.command])
            .disabled(preview == nil || store.isLoadingChatShipPreview || store.isExecutingChatShip)
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
        .background(ToolrollPalette.raised)
    }

    private func submitShip() {
        let password = passwordDraft
        passwordDraft = ""
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
                password: password
            )
            if ok {
                dismiss()
            }
        }
    }
}
