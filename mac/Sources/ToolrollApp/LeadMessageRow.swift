import SwiftUI
import ToolrollCore

struct LeadMessageRow: View {
    static let thinkingId = -1
    let message: LeadMessage
    var account: String = ""
    var leadName: String = "Lead"

    private var isYours: Bool { message.role == "operator" || message.role == "user" }

    var body: some View {
        if isYours {
            HStack(alignment: .top, spacing: 9) {
                UserMonogramBadge(account: account, size: 20)
                Text(message.text)
                    .font(.system(size: 13))
                    .lineSpacing(2.5)
                    .foregroundStyle(ToolrollPalette.ink)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 11)
            .padding(.vertical, 8)
            .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))
            .accessibilityElement(children: .combine)
            .accessibilityLabel("You: \(message.text)")
        } else {
            HStack(alignment: .top, spacing: 9) {
                ProviderBrandGlyph(provider: "lead", size: 20, tinted: false, inTile: true)
                    .padding(.top, 1)
                VStack(alignment: .leading, spacing: 4) {
                    Text(leadName)
                        .font(.system(size: 11.5, weight: .semibold))
                        .tracking(-0.1)
                        .foregroundStyle(ToolrollPalette.ink)
                    Text(message.text)
                        .font(.system(size: 13))
                        .lineSpacing(2.5)
                        .foregroundStyle(ToolrollPalette.ink.opacity(0.92))
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 2)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(leadName): \(message.text)")
        }
    }
}
