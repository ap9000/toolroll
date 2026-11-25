import AppKit
import SwiftUI
import ToolrollCore
import UniformTypeIdentifiers

@MainActor
public enum ComposerClipboardHelper {
    public static func extractAttachmentsFromPasteboard(
        _ pasteboard: NSPasteboard = .general,
        forceImageCheck: Bool = false
    ) -> [ComposerAttachment] {
        let urlOptions: [NSPasteboard.ReadingOptionKey: Any] = [
            .urlReadingFileURLsOnly: true,
        ]
        if let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: urlOptions) as? [URL], !urls.isEmpty {
            let attachments = urls.compactMap { makeAttachmentWithImageMetrics(for: $0) }
            if !attachments.isEmpty {
                return attachments
            }
        }

        let types = Set(pasteboard.types ?? [])
        let hasRawImage = types.contains(.png)
            || types.contains(.tiff)
            || types.contains(NSPasteboard.PasteboardType("public.jpeg"))
            || types.contains(NSPasteboard.PasteboardType("public.heic"))

        guard hasRawImage else { return [] }

        if !forceImageCheck {
            let plainText = pasteboard.string(forType: .string)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let hasRichText = types.contains(.rtf) || types.contains(.html)
            if !plainText.isEmpty && hasRichText {
                return []
            }
        }

        if let pngAttachment = savePasteboardImage(pasteboard) {
            return [pngAttachment]
        }
        return []
    }

    public static func hasClipboardImage(_ pasteboard: NSPasteboard = .general) -> Bool {
        let types = Set(pasteboard.types ?? [])
        if types.contains(.png) || types.contains(.tiff) { return true }
        let urlOptions: [NSPasteboard.ReadingOptionKey: Any] = [.urlReadingFileURLsOnly: true]
        if let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: urlOptions) as? [URL] {
            return urls.contains { ComposerAttachmentStore.imageExtensions.contains($0.pathExtension.lowercased()) }
        }
        return false
    }

    public static func makeAttachmentWithImageMetrics(for url: URL) -> ComposerAttachment? {
        var pixelSize: String?
        if ComposerAttachmentStore.imageExtensions.contains(url.pathExtension.lowercased()),
           let img = NSImage(contentsOf: url) {
            pixelSize = imagePixelSizeString(img)
        }
        return ComposerAttachmentStore.makeAttachment(for: url, pixelSize: pixelSize)
    }

    private static func savePasteboardImage(_ pasteboard: NSPasteboard) -> ComposerAttachment? {
        if let rawPng = pasteboard.data(forType: .png), !rawPng.isEmpty {
            let px = NSImage(data: rawPng).flatMap { imagePixelSizeString($0) }
            return try? ComposerAttachmentStore.saveImageData(rawPng, pixelSize: px)
        }

        guard let image = NSImage(pasteboard: pasteboard),
              let pngData = pngData(from: image) else {
            return nil
        }
        let px = imagePixelSizeString(image)
        return try? ComposerAttachmentStore.saveImageData(pngData, pixelSize: px)
    }

    public static func pngData(from image: NSImage) -> Data? {
        if let tiff = image.tiffRepresentation,
           let rep = NSBitmapImageRep(data: tiff),
           let png = rep.representation(using: .png, properties: [:]) {
            return png
        }
        var rect = CGRect(origin: .zero, size: image.size)
        guard let cgImage = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else {
            return nil
        }
        let rep = NSBitmapImageRep(cgImage: cgImage)
        return rep.representation(using: .png, properties: [:])
    }

    public static func imagePixelSizeString(_ image: NSImage) -> String? {
        if let rep = image.representations.compactMap({ $0 as? NSBitmapImageRep }).first,
           rep.pixelsWide > 0, rep.pixelsHigh > 0 {
            return "\(rep.pixelsWide)×\(rep.pixelsHigh)"
        }
        let w = Int(image.size.width.rounded())
        let h = Int(image.size.height.rounded())
        guard w > 0, h > 0 else { return nil }
        return "\(w)×\(h)"
    }
}

@MainActor
public enum ComposerPanelPicker {
    public static func pickFolders() -> [ComposerAttachment] {
        let panel = NSOpenPanel()
        panel.title = "Add Folder as Context"
        panel.prompt = "Add Context"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = true
        panel.canCreateDirectories = false
        guard panel.runModal() == .OK else { return [] }
        return panel.urls.compactMap { ComposerAttachmentStore.makeAttachment(for: $0) }
    }

    public static func pickImagesOrFiles() -> [ComposerAttachment] {
        let panel = NSOpenPanel()
        panel.title = "Attach Image or File"
        panel.prompt = "Attach"
        panel.canChooseDirectories = true
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = true
        panel.canCreateDirectories = false
        guard panel.runModal() == .OK else { return [] }
        return panel.urls.compactMap { ComposerClipboardHelper.makeAttachmentWithImageMetrics(for: $0) }
    }
}

public enum ComposerDropHelper {
    public static let acceptedTypes: [UTType] = [.fileURL, .png, .tiff, .image]

    @MainActor
    public static func handleDrop(
        providers: [NSItemProvider],
        onAttachments: @escaping @MainActor ([ComposerAttachment]) -> Void
    ) -> Bool {
        var accepted = false
        for provider in providers {
            if provider.canLoadObject(ofClass: URL.self) {
                accepted = true
                _ = provider.loadObject(ofClass: URL.self) { url, _ in
                    guard let url else { return }
                    Task { @MainActor in
                        if let att = ComposerClipboardHelper.makeAttachmentWithImageMetrics(for: url) {
                            onAttachments([att])
                        }
                    }
                }
            } else if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                accepted = true
                provider.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, _ in
                    guard let data, !data.isEmpty else { return }
                    Task { @MainActor in
                        guard let image = NSImage(data: data),
                              let png = ComposerClipboardHelper.pngData(from: image) else { return }
                        let px = ComposerClipboardHelper.imagePixelSizeString(image)
                        if let att = try? ComposerAttachmentStore.saveImageData(png, pixelSize: px) {
                            onAttachments([att])
                        }
                    }
                }
            }
        }
        return accepted
    }
}

private final class ComposerPasteMonitorBox: @unchecked Sendable {
    var monitor: Any?
    var isActive: Bool = false
    var onAttachments: (@MainActor ([ComposerAttachment]) -> Void)?

    func installIfNeeded() {
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, self.isActive else { return event }
            let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            guard flags == .command,
                  event.charactersIgnoringModifiers?.lowercased() == "v" else {
                return event
            }
            let attachments = MainActor.assumeIsolated {
                ComposerClipboardHelper.extractAttachmentsFromPasteboard()
            }
            guard !attachments.isEmpty else { return event }
            let callback = self.onAttachments
            Task { @MainActor in
                callback?(attachments)
            }
            return nil
        }
    }

    func remove() {
        if let monitor {
            NSEvent.removeMonitor(monitor)
            self.monitor = nil
        }
    }

    deinit {
        remove()
    }
}

private struct ComposerPasteModifier: ViewModifier {
    let isActive: Bool
    let onAttachments: @MainActor ([ComposerAttachment]) -> Void
    @State private var box = ComposerPasteMonitorBox()

    func body(content: Content) -> some View {
        content
            .onAppear {
                box.isActive = isActive
                box.onAttachments = onAttachments
                box.installIfNeeded()
            }
            .onChange(of: isActive) { _, active in
                box.isActive = active
            }
            .onDisappear {
                box.remove()
            }
    }
}

extension View {
    public func onComposerPaste(
        isActive: Bool,
        perform onAttachments: @escaping @MainActor ([ComposerAttachment]) -> Void
    ) -> some View {
        modifier(ComposerPasteModifier(isActive: isActive, onAttachments: onAttachments))
    }
}

public struct ComposerAttachmentStrip: View {
    let attachments: [ComposerAttachment]
    let onRemove: (UUID) -> Void

    @State private var previewedImageId: UUID? = nil

    public init(attachments: [ComposerAttachment], onRemove: @escaping (UUID) -> Void) {
        self.attachments = attachments
        self.onRemove = onRemove
    }

    public var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(attachments) { item in
                    switch item.kind {
                    case .image:
                        imageThumbnailCard(item)
                    case .folder:
                        folderContextChip(item)
                    case .file:
                        fileContextChip(item)
                    }
                }
            }
            .padding(.horizontal, 2)
            .padding(.top, 2)
            .padding(.bottom, 2)
        }
    }

    private func imageThumbnailCard(_ item: ComposerAttachment) -> some View {
        let isPreviewOpen = Binding<Bool>(
            get: { previewedImageId == item.id },
            set: { open in
                if !open && previewedImageId == item.id {
                    previewedImageId = nil
                }
            }
        )

        return ZStack(alignment: .topTrailing) {
            Button {
                previewedImageId = item.id
            } label: {
                Group {
                    if let nsImage = NSImage(contentsOfFile: item.path) {
                        Image(nsImage: nsImage)
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                    } else {
                        ZStack {
                            ToolrollPalette.raised
                            Image(systemName: "photo")
                                .font(.system(size: 16))
                                .foregroundStyle(ToolrollPalette.muted)
                        }
                    }
                }
                .frame(width: 58, height: 58)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .strokeBorder(ToolrollPalette.inputLine, lineWidth: 1)
                )
            }
            .buttonStyle(.plain)
            .help(item.pixelSize.map { "\(item.displayName) · \($0) — click to preview" } ?? "\(item.displayName) — click to preview")
            .popover(isPresented: isPreviewOpen, arrowEdge: .top) {
                imagePreviewPopover(item)
            }

            Button {
                onRemove(item.id)
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 8.5, weight: .bold))
                    .foregroundStyle(ToolrollPalette.ink)
                    .frame(width: 17, height: 17)
                    .background(ToolrollPalette.paper.opacity(0.92), in: Circle())
                    .overlay(Circle().strokeBorder(ToolrollPalette.inputLine, lineWidth: 1))
            }
            .buttonStyle(.plain)
            .offset(x: 4, y: -4)
            .help("Remove image")
        }
        .padding(.top, 4)
        .padding(.trailing, 4)
    }

    private func imagePreviewPopover(_ item: ComposerAttachment) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if let nsImage = NSImage(contentsOfFile: item.path) {
                Image(nsImage: nsImage)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(maxWidth: 420, maxHeight: 320)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .strokeBorder(ToolrollPalette.line, lineWidth: 1)
                    )
            }
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.displayName)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(ToolrollPalette.ink)
                        .lineLimit(1)
                    Text(ComposerAttachmentStore.abbreviateHomePath(item.path))
                        .font(.system(size: 10.5, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.muted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 8)
                Button("Reveal") {
                    NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: item.path)])
                }
                .buttonStyle(KitButtonStyle(.ghost, compact: true))
            }
        }
        .padding(12)
        .frame(minWidth: 260, maxWidth: 448)
        .background(ToolrollPalette.paper)
    }

    private func folderContextChip(_ item: ComposerAttachment) -> some View {
        HStack(spacing: 7) {
            Image(systemName: "folder.fill")
                .font(.system(size: 12))
                .foregroundStyle(ToolrollPalette.ink.opacity(0.8))

            VStack(alignment: .leading, spacing: 1) {
                Text(item.displayName)
                    .font(.system(size: 11.5, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.ink)
                    .lineLimit(1)
                if let sub = item.subtitle, !sub.isEmpty {
                    Text(sub)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(ToolrollPalette.muted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .frame(maxWidth: 160, alignment: .leading)
                }
            }

            Button {
                onRemove(item.id)
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.muted)
                    .frame(width: 18, height: 18)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .help("Remove folder context")
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 6)
        .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(ToolrollPalette.inputLine, lineWidth: 1)
        )
        .help("Folder context: \(item.path)")
    }

    private func fileContextChip(_ item: ComposerAttachment) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "doc.text")
                .font(.system(size: 11.5))
                .foregroundStyle(ToolrollPalette.muted)

            Text(item.displayName)
                .font(.system(size: 11.5, weight: .medium))
                .foregroundStyle(ToolrollPalette.ink)
                .lineLimit(1)
                .frame(maxWidth: 150, alignment: .leading)

            Button {
                onRemove(item.id)
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(ToolrollPalette.muted)
                    .frame(width: 16, height: 16)
            }
            .buttonStyle(.plain)
            .help("Remove attachment")
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 7)
        .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(ToolrollPalette.inputLine, lineWidth: 1)
        )
        .help(item.path)
    }
}

public struct ComposerAttachMenuButton: View {
    let compact: Bool
    let onAddAttachments: ([ComposerAttachment]) -> Void
    let onNoClipboardImage: (() -> Void)?

    public init(
        compact: Bool = false,
        onAddAttachments: @escaping ([ComposerAttachment]) -> Void,
        onNoClipboardImage: (() -> Void)? = nil
    ) {
        self.compact = compact
        self.onAddAttachments = onAddAttachments
        self.onNoClipboardImage = onNoClipboardImage
    }

    public var body: some View {
        Menu {
            Button {
                let picked = ComposerPanelPicker.pickFolders()
                if !picked.isEmpty { onAddAttachments(picked) }
            } label: {
                Label("Add Folder as Context…", systemImage: "folder.badge.plus")
            }

            Button {
                let picked = ComposerPanelPicker.pickImagesOrFiles()
                if !picked.isEmpty { onAddAttachments(picked) }
            } label: {
                Label("Attach Image or File…", systemImage: "photo.badge.plus")
            }

            Divider()

            Button {
                let pasted = ComposerClipboardHelper.extractAttachmentsFromPasteboard(forceImageCheck: true)
                if !pasted.isEmpty {
                    onAddAttachments(pasted)
                } else {
                    onNoClipboardImage?()
                }
            } label: {
                Label("Paste Image from Clipboard (⌘V)", systemImage: "doc.on.clipboard")
            }
        } label: {
            Image(systemName: "plus")
                .font(.system(size: compact ? 11.5 : 12, weight: .semibold))
                .foregroundStyle(ToolrollPalette.muted)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .frame(width: compact ? 24 : 26, height: compact ? 24 : 26)
        .background(Color.white.opacity(0.07), in: Circle())
        .overlay(Circle().strokeBorder(Color.white.opacity(0.10), lineWidth: 1))
        .contentShape(Circle())
        .fixedSize()
        .help("Add folder as context, attach image, or paste screenshot (⌘V)")
    }
}

public func appendUniqueAttachments(
    _ incoming: [ComposerAttachment],
    to existing: inout [ComposerAttachment]
) {
    var seen = Set(existing.map(\.path))
    for item in incoming where !seen.contains(item.path) {
        existing.append(item)
        seen.insert(item.path)
    }
}
