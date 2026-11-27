import Foundation

/// Agent- and server-written text, prepared for display.
///
/// Step sentences are written by coding agents and can carry attacker-influenced markdown. Inline styling
/// (`code`, **bold**, *italic*) is kept; links and image URLs are removed from every run so nothing in that
/// text is ever tappable next to approval terms.
public enum CompanionText {
    public static func inlineMarkdown(_ string: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            allowsExtendedAttributes: false,
            interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible
        )
        var attributed = (try? AttributedString(markdown: string, options: options)) ?? AttributedString(string)
        for run in attributed.runs {
            attributed[run.range].link = nil
            attributed[run.range].imageURL = nil
        }
        return attributed
    }
}
