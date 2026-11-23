import SwiftUI
import ToolrollCore

/// One message in a Lead conversation: yours as a bubble on the right, the Lead's as plain text on the left.
/// The server calls the person "operator" (older builds: "user").
struct LeadMessageRow: View {
    static let thinkingId = -1
    let message: LeadMessage

    private var isYours: Bool { message.role == "operator" || message.role == "user" }

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            if isYours { Spacer(minLength: 48) }
            Text(message.text)
                .font(.system(size: 13))
                .lineSpacing(2)
                .foregroundStyle(ToolrollPalette.ink)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, isYours ? 12 : 0)
                .padding(.vertical, isYours ? 8 : 0)
                .background {
                    if isYours {
                        RoundedRectangle(cornerRadius: 14, style: .continuous).fill(ToolrollPalette.raised)
                    }
                }
            if !isYours { Spacer(minLength: 0) }
        }
        .frame(maxWidth: .infinity, alignment: isYours ? .trailing : .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(isYours ? "You: \(message.text)" : "Lead: \(message.text)")
    }
}
