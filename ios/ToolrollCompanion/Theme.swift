import SwiftUI

enum ToolrollTheme {
    static let paper = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.067, green: 0.071, blue: 0.078, alpha: 1) // #111214
            : UIColor(red: 0.980, green: 0.976, blue: 0.965, alpha: 1) // #FAF9F6
    })

    static let surface = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.106, green: 0.114, blue: 0.125, alpha: 1) // #1B1D20
            : UIColor.white
    })

    static let subtleFill = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.149, green: 0.157, blue: 0.173, alpha: 1)
            : UIColor(red: 0.949, green: 0.941, blue: 0.922, alpha: 1) // #F2F0EB
    })

    static let hairline = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(white: 1, alpha: 0.10)
            : UIColor(white: 0, alpha: 0.08)
    })

    static let ink = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.953, green: 0.949, blue: 0.937, alpha: 1)
            : UIColor(red: 0.102, green: 0.106, blue: 0.118, alpha: 1) // #1A1B1E
    })

    static let muted = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.620, green: 0.635, blue: 0.663, alpha: 1)
            : UIColor(red: 0.412, green: 0.420, blue: 0.443, alpha: 1)
    })

    static let vermilion = Color(red: 0.831, green: 0.267, blue: 0.180) // #D4442E
    static let forest = Color(red: 0.180, green: 0.490, blue: 0.310)    // #2E7D4F
    static let cobalt = Color(red: 0.145, green: 0.388, blue: 0.922)    // #2563EB
    static let amber = Color(red: 0.788, green: 0.486, blue: 0.075)
}

struct StatusPill: View {
    let label: String
    let tint: Color

    var body: some View {
        Text(label)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(tint)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(tint.opacity(0.13), in: Capsule())
    }
}
