import SwiftUI
import ToolrollCore

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

    private var isYours: Bool { message.role == "operator" || message.role == "user" }

    var body: some View {
        if isYours {
            HStack(alignment: .top, spacing: wide ? 10 : 9) {
                UserMonogramBadge(account: account, size: wide ? 22 : 20)
                Text(message.text)
                    .font(.system(size: wide ? 13.5 : 13))
                    .lineSpacing(wide ? 3 : 2.5)
                    .foregroundStyle(ToolrollPalette.ink)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, wide ? 13 : 11)
            .padding(.vertical, wide ? 10 : 8)
            .background(ToolrollPalette.raised, in: RoundedRectangle(cornerRadius: wide ? 11 : 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: wide ? 11 : 10, style: .continuous).strokeBorder(ToolrollPalette.line, lineWidth: 1))
            .accessibilityElement(children: .combine)
            .accessibilityLabel("You: \(message.text)")
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
