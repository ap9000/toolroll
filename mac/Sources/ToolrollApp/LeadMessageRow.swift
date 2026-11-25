import AppKit
import SwiftUI
import ToolrollCore

private struct LocalImageGallerySelection: Identifiable {
    let id = UUID()
    let images: [ParsedMessageAttachment]
    let initialIndex: Int
}

struct MessageAttachmentStrip: View {
    let attachments: [ParsedMessageAttachment]
    var inkColor: Color = ToolrollPalette.chatBubbleInk
    var onPreviewImage: (([ParsedMessageAttachment], Int) -> Void)? = nil

    private var images: [ParsedMessageAttachment] {
        attachments.filter { $0.kind == .image }
    }

    private var nonImages: [ParsedMessageAttachment] {
        attachments.filter { $0.kind != .image }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !images.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(Array(images.enumerated()), id: \.element.id) { idx, item in
                            Button {
                                onPreviewImage?(images, idx)
                            } label: {
                                LocalAttachmentThumbnail(item: item, inkColor: inkColor)
                            }
                            .buttonStyle(.plain)
                            .help(item.displayName)
                        }
                    }
                }
            }
            if !nonImages.isEmpty {
                HStack(spacing: 6) {
                    ForEach(nonImages) { item in
                        HStack(spacing: 5) {
                            Image(systemName: item.kind == .folder ? "folder.fill" : "doc.text.fill")
                                .font(.system(size: 10.5))
                            Text(item.displayName)
                                .font(.system(size: 11.5, weight: .medium))
                                .lineLimit(1)
                        }
                        .foregroundStyle(inkColor.opacity(0.9))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(inkColor.opacity(0.10), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                    }
                }
            }
        }
    }
}

private struct LocalAttachmentThumbnail: View {
    let item: ParsedMessageAttachment
    let inkColor: Color
    @State private var nsImage: NSImage? = nil

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            if let nsImage {
                Image(nsImage: nsImage)
                    .resizable()
                    .scaledToFill()
                    .frame(width: 148, height: 92)
                    .clipped()
            } else {
                VStack(spacing: 4) {
                    Image(systemName: "photo")
                        .font(.system(size: 18))
                        .foregroundStyle(inkColor.opacity(0.65))
                    Text(item.displayName)
                        .font(.system(size: 10.5))
                        .foregroundStyle(inkColor.opacity(0.75))
                        .lineLimit(1)
                        .padding(.horizontal, 6)
                }
                .frame(width: 148, height: 92)
                .background(inkColor.opacity(0.08))
            }

            if let px = item.pixelSize, !px.isEmpty, nsImage != nil {
                Text(px)
                    .font(.system(size: 9.5, weight: .medium, design: .monospaced))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(Color.black.opacity(0.62), in: Capsule())
                    .padding(6)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(inkColor.opacity(0.22), lineWidth: 1)
        )
        .onAppear {
            if nsImage == nil, FileManager.default.fileExists(atPath: item.path) {
                nsImage = NSImage(contentsOfFile: item.path)
            }
        }
    }
}

struct LocalAttachmentLightbox: View {
    let images: [ParsedMessageAttachment]
    @State private var currentIndex: Int
    @Environment(\.dismiss) private var dismiss

    init(images: [ParsedMessageAttachment], initialIndex: Int) {
        self.images = images
        let clamped = images.isEmpty ? 0 : min(max(0, initialIndex), images.count - 1)
        self._currentIndex = State(initialValue: clamped)
    }

    private var active: ParsedMessageAttachment? {
        guard currentIndex >= 0, currentIndex < images.count else { return nil }
        return images[currentIndex]
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Text(active?.displayName ?? "Image")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.ink)
                    .lineLimit(1)
                if let px = active?.pixelSize, !px.isEmpty {
                    Text(px)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.muted)
                }
                if images.count > 1 {
                    Text("\(currentIndex + 1) / \(images.count)")
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.muted)
                }
                Spacer()
                if images.count > 1 {
                    Button { step(-1) } label: {
                        Image(systemName: "chevron.left")
                            .frame(width: 24, height: 22)
                    }
                    .buttonStyle(KitButtonStyle(.ghost, compact: true))
                    .disabled(currentIndex == 0)

                    Button { step(1) } label: {
                        Image(systemName: "chevron.right")
                            .frame(width: 24, height: 22)
                    }
                    .buttonStyle(KitButtonStyle(.ghost, compact: true))
                    .disabled(currentIndex >= images.count - 1)
                }
                Button("Close") { dismiss() }
                    .buttonStyle(KitButtonStyle(.ghost, compact: true))
                    .keyboardShortcut(.escape, modifiers: [])
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(ToolrollPalette.paper)
            .overlay(alignment: .bottom) { HairlineDivider() }

            ZStack {
                ToolrollPalette.ground
                if let active, let nsImage = NSImage(contentsOfFile: active.path) {
                    Image(nsImage: nsImage)
                        .resizable()
                        .scaledToFit()
                        .padding(20)
                } else {
                    Text("Image file is no longer available on disk.")
                        .font(.system(size: 13))
                        .foregroundStyle(ToolrollPalette.muted)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(minWidth: 640, idealWidth: 820, minHeight: 460, idealHeight: 580)
        .background(ToolrollPalette.ground)
        .focusable()
        .onKeyPress(.leftArrow) {
            step(-1)
            return .handled
        }
        .onKeyPress(.rightArrow) {
            step(1)
            return .handled
        }
    }

    private func step(_ delta: Int) {
        guard !images.isEmpty else { return }
        let next = currentIndex + delta
        if next >= 0 && next < images.count {
            currentIndex = next
        }
    }
}

struct LeadMessageRow: View {
    static let thinkingId = -1
    let message: LeadMessage
    var account: String = ""
    var leadName: String = "Lead"
    var wide: Bool = false
    var onSelectAskOption: ((String) -> Void)? = nil
    var onConfirmProposal: ((LeadChatCard) -> Void)? = nil
    var onDismissProposal: ((LeadChatCard) -> Void)? = nil
    var onOpenLink: ((LeadChatLink) -> Void)? = nil

    @State private var previewGallery: LocalImageGallerySelection? = nil

    private var isYours: Bool { message.role == "operator" || message.role == "user" }

    var body: some View {
        if isYours {
            let parsed = ComposerAttachmentStore.parseAttachedContext(from: message.text)
            HStack(alignment: .top, spacing: wide ? 10 : 9) {
                UserMonogramBadge(account: account, size: wide ? 22 : 20)
                VStack(alignment: .leading, spacing: 8) {
                    if !parsed.body.isEmpty {
                        Text(parsed.body)
                            .font(.system(size: wide ? 13.5 : 13))
                            .lineSpacing(wide ? 3 : 2.5)
                            .foregroundStyle(ToolrollPalette.chatBubbleInk)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if !parsed.attachments.isEmpty {
                        MessageAttachmentStrip(
                            attachments: parsed.attachments,
                            inkColor: ToolrollPalette.chatBubbleInk
                        ) { imgs, idx in
                            previewGallery = LocalImageGallerySelection(images: imgs, initialIndex: idx)
                        }
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, wide ? 13 : 11)
            .padding(.vertical, wide ? 10 : 8)
            .background(ToolrollPalette.chatBubble, in: RoundedRectangle(cornerRadius: wide ? 11 : 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: wide ? 11 : 10, style: .continuous).strokeBorder(ToolrollPalette.chatBubbleBorder, lineWidth: 1))
            .accessibilityElement(children: .combine)
            .accessibilityLabel("You: \(parsed.body.isEmpty ? message.text : parsed.body)")
            .sheet(item: $previewGallery) { gallery in
                LocalAttachmentLightbox(images: gallery.images, initialIndex: gallery.initialIndex)
                    .dismissSheetOnOutsideClick()
            }
        } else {
            HStack(alignment: .top, spacing: wide ? 10 : 9) {
                ProviderBrandGlyph(provider: "lead", size: wide ? 22 : 20, tinted: false, inTile: true)
                    .padding(.top, 1)

                VStack(alignment: .leading, spacing: wide ? 8 : 6) {
                    HStack(spacing: 6) {
                        Text(leadName)
                            .font(.system(size: wide ? 12 : 11.5, weight: .semibold))
                            .tracking(-0.1)
                            .foregroundStyle(ToolrollPalette.ink)
                        if let activity = message.activity, !activity.isEmpty {
                            Text("· \(activity)")
                                .font(.system(size: 11))
                                .foregroundStyle(ToolrollPalette.muted)
                                .lineLimit(1)
                        }
                    }

                    if !message.text.isEmpty {
                        NativeMarkdownView(markdown: message.text, compact: true, bodyFontSize: wide ? 13.5 : 13)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    ForEach(message.cards) { card in
                        leadCardView(card)
                    }

                    if let ask = message.ask {
                        leadAskView(ask)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 2)
        }
    }

    private func leadCardView(_ card: LeadChatCard) -> some View {
        let isPending = card.state == "pending"
        let isConfirmed = card.state == "confirmed"
        let isRefused = card.state == "refused"

        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 7) {
                Circle()
                    .fill(cardDotColor(state: card.state, isData: card.data))
                    .frame(width: 6, height: 6)
                Text(card.label.isEmpty ? card.kind.capitalized : card.label)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.ink)
                Spacer(minLength: 6)
                if !card.data {
                    Text(cardStateLabel(card.state))
                        .font(.system(size: 10.5, weight: .medium))
                        .foregroundStyle(isConfirmed ? ToolrollPalette.success : (isRefused ? ToolrollPalette.danger : ToolrollPalette.muted))
                }
            }

            if !card.lines.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(card.lines.enumerated()), id: \.offset) { idx, line in
                        Text(line)
                            .font(.system(size: idx == 0 ? 13 : 12, weight: idx == 0 ? .medium : .regular))
                            .foregroundStyle(idx == 0 ? ToolrollPalette.ink : ToolrollPalette.muted)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }

            if let said = card.said, !said.isEmpty {
                Text(said)
                    .font(.system(size: 12))
                    .foregroundStyle(isRefused ? ToolrollPalette.danger : ToolrollPalette.muted)
                    .fixedSize(horizontal: false, vertical: true)
            } else if let note = card.note, !note.isEmpty {
                Text(note)
                    .font(.system(size: 11.5))
                    .foregroundStyle(ToolrollPalette.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if (isPending && card.primary != nil) || card.dismissable || !card.links.isEmpty {
                HStack(spacing: 8) {
                    if let primary = card.primary, isPending {
                        Button {
                            if primary.kind == "confirm" {
                                onConfirmProposal?(card)
                            } else if let href = primary.href {
                                onOpenLink?(LeadChatLink(label: primary.label, href: href, task: primary.task, tab: primary.tab))
                            }
                        } label: {
                            Text(primary.label)
                                .font(.system(size: 11.5, weight: .semibold))
                                .padding(.horizontal, 11)
                                .frame(height: 26)
                                .contentShape(Capsule())
                        }
                        .buttonStyle(KitButtonStyle(.primary, compact: true))
                    }

                    if card.dismissable && isPending {
                        Button {
                            onDismissProposal?(card)
                        } label: {
                            Text("Dismiss")
                                .font(.system(size: 11.5, weight: .medium))
                                .foregroundStyle(ToolrollPalette.muted)
                                .padding(.horizontal, 9)
                                .frame(height: 26)
                                .contentShape(Capsule())
                        }
                        .buttonStyle(.plain)
                        .toolrollHoverSurface(cornerRadius: 6, isSelected: false)
                    }

                    ForEach(card.links) { link in
                        Button {
                            onOpenLink?(link)
                        } label: {
                            HStack(spacing: 4) {
                                Text(link.label)
                                Image(systemName: "arrow.up.right")
                                    .font(.system(size: 9, weight: .semibold))
                            }
                            .font(.system(size: 11.5, weight: .medium))
                            .foregroundStyle(ToolrollPalette.ink)
                            .padding(.horizontal, 9)
                            .frame(height: 26)
                            .background(ToolrollPalette.ground, in: Capsule())
                            .overlay(Capsule().strokeBorder(ToolrollPalette.line, lineWidth: 1))
                            .contentShape(Capsule())
                        }
                        .buttonStyle(.plain)
                    }

                    Spacer(minLength: 0)
                }
                .padding(.top, 2)
            }
        }
        .padding(12)
        .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .strokeBorder(isPending && !card.data ? ToolrollPalette.inputLine : ToolrollPalette.line, lineWidth: 1)
        )
    }

    private func leadAskView(_ ask: LeadChatAsk) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if !ask.question.isEmpty {
                Text(ask.question)
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundStyle(ToolrollPalette.ink)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if !ask.options.isEmpty {
                VStack(alignment: .leading, spacing: 5) {
                    ForEach(ask.options, id: \.self) { option in
                        Button {
                            onSelectAskOption?(option)
                        } label: {
                            HStack(spacing: 8) {
                                Text(option)
                                    .font(.system(size: 12, weight: .medium))
                                    .foregroundStyle(ask.open ? ToolrollPalette.ink : ToolrollPalette.muted)
                                    .multilineTextAlignment(.leading)
                                Spacer(minLength: 6)
                                if ask.open {
                                    Image(systemName: "arrow.right")
                                        .font(.system(size: 9.5, weight: .semibold))
                                        .foregroundStyle(ToolrollPalette.muted)
                                }
                            }
                            .padding(.horizontal, 11)
                            .padding(.vertical, 7)
                            .background(ToolrollPalette.ground, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))
                            .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                        }
                        .buttonStyle(.plain)
                        .disabled(!ask.open)
                    }
                }
            }
        }
        .padding(12)
        .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 11, style: .continuous).strokeBorder(ask.open ? ToolrollPalette.inputLine : ToolrollPalette.line, lineWidth: 1))
    }

    private func cardDotColor(state: String, isData: Bool) -> Color {
        if isData { return ToolrollPalette.muted }
        switch state {
        case "pending": return ToolrollPalette.live
        case "confirmed": return ToolrollPalette.success
        case "refused": return ToolrollPalette.danger
        default: return ToolrollPalette.muted
        }
    }

    private func cardStateLabel(_ state: String) -> String {
        switch state {
        case "pending": return "Needs approval"
        case "confirmed": return "Confirmed"
        case "refused": return "Refused"
        case "dismissed": return "Dismissed"
        case "expired": return "Expired"
        default: return state.capitalized
        }
    }
}
