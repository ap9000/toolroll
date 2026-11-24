import SwiftUI

struct ScreenHeader<Actions: View>: View {
    let title: String
    let detail: String?
    @ViewBuilder let actions: () -> Actions

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: 14) {
                titleText
                if let detail { detailText(detail).lineLimit(1).fixedSize() }
                Spacer(minLength: 16)
                HStack(spacing: 8) { actions() }.fixedSize()
            }
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    titleText
                    Spacer(minLength: 12)
                    HStack(spacing: 8) { actions() }.fixedSize()
                }
                if let detail { detailText(detail).fixedSize(horizontal: false, vertical: true) }
            }
        }
    }

    private var titleText: some View {
        Text(title)
            .font(.system(size: 24, weight: .semibold))
            .foregroundStyle(ToolrollPalette.ink)
            .lineLimit(1)
            .fixedSize()
    }

    private func detailText(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 13))
            .foregroundStyle(ToolrollPalette.muted)
    }
}
