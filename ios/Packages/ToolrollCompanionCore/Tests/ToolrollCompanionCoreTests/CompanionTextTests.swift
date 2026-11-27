import Foundation
import Testing
@testable import ToolrollCompanionCore

@Test("Markdown links in agent text are never kept")
func linksAreStripped() {
    let text = CompanionText.inlineMarkdown("[click](https://evil.example)")
    #expect(String(text.characters) == "click")
    #expect(text.runs.allSatisfy { $0.link == nil })

    let mixed = CompanionText.inlineMarkdown("Run `npm test`, then [approve here](https://evil.example/approve) **now**")
    #expect(mixed.runs.allSatisfy { $0.link == nil && $0.imageURL == nil })
    #expect(String(mixed.characters).contains("approve here"))
}

@Test("Inline code and emphasis survive")
func inlineStylingKept() {
    let text = CompanionText.inlineMarkdown("Set `SameSite=Strict` and **keep** *it*")
    #expect(String(text.characters) == "Set SameSite=Strict and keep it")
    let intents = text.runs.compactMap(\.inlinePresentationIntent)
    #expect(intents.contains(.code))
    #expect(intents.contains(.stronglyEmphasized))
    #expect(intents.contains(.emphasized))
}

@Test("Autolinks and images carry no URL either")
func autolinksAndImagesStripped() {
    let text = CompanionText.inlineMarkdown("See <https://evil.example> and ![x](https://evil.example/x.png)")
    #expect(text.runs.allSatisfy { $0.link == nil && $0.imageURL == nil })
}
