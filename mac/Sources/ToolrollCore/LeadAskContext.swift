import Foundation

public enum LeadAskContext {
    static let excerptLimit = 160

    public static func message(
        question: String,
        project: String?,
        route: String,
        file: String?,
        line: Int?,
        element: SelectedElementContext?
    ) -> String {
        var facts: [String] = []
        let place = [project, route].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: " ")
        if !place.isEmpty { facts.append("Screen: \(place)") }
        if let file, !file.isEmpty { facts.append("Source: \(file)\(line.map { ":\($0)" } ?? "")") }
        if let element {
            let path = element.ancestors.sorted { $0.depthFromSelected > $1.depthFromSelected }.map(\.label)
            if !path.isEmpty { facts.append("Component: \(path.joined(separator: " › "))") }
            let text = element.textExcerpt.trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { facts.append("Element text: “\(text.count > excerptLimit ? String(text.prefix(excerptLimit)) + "…" : text)”") }
            facts.append("Element: <\(element.tag)> \(element.metrics.width)×\(element.metrics.height)")
        }
        let asked = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !facts.isEmpty else { return asked }
        return asked + "\n\n(About this, on Canvas)\n" + facts.map { "- \($0)" }.joined(separator: "\n")
    }
}
