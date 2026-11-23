# Quick Lead panel: design research

Date: 2026-11-23. Machine runs Darwin 27.3 (macOS 27.3). Toolroll mac target: SPM package, `platforms: .macOS(.v14)`, ad hoc or identity signed by `build-app.sh`, not sandboxed.

Screenshots are saved next to this file and named after the Mobbin page they show (Mobbin is the only source that was screenshotted):
`mobbin-screens-command-palette.png`, `mobbin-screens-ai-chat-ui.png`, `mobbin-screens-chat-bot.png`, `mobbin-screens-command-center-design.png`, `mobbin-screens-confirmation.png`, `mobbin-screens-action-option.png`, `mobbin-screens-notifications.png`, `mobbin-screens-conversational-ui-examples.png`, `mobbin-ui-elements-{drawer,popover,toast,keyboard-key}.png`, `mobbin-glossary-command-palette.png`, `mobbin-search-gated.png` (the gated search redirect).

---

## 1. Mobbin

**Access.** Search, filters and screen detail pages are behind a login. Opening a search URL (for example `/search/apps/web?...filter=uiElements.Command Palette`) redirects to the home page with `?redirect_to=`. No credentials were entered. Mobbin also has an MCP server, but only on the Pro and Team plans.

**Platforms.** Mobbin covers Mobile (iOS/Android), Web and Sites. **There is no macOS or desktop category**, so none of its screens show a native floating panel, a menu bar app or the notch.

**What is public** is the `/explore/web/...` category pages (each with a first screen of thumbnails and app names) and the glossary:

| Public page | Count | Apps shown (first screen) | Relevance |
|---|---|---|---|
| Screens / Command Palette | 261 | Databricks, Better Stack, v0, Pitch, Figma, Jira, OpenPhone, Vercel, Superhuman, Linear, Notion, Raycast-style palettes in Retool, Supabase, GitHub, Grok | v0's palette lists **New Chat, All Recent Chats, Projects, Recent Chats**, so chat and navigation share one palette. Databricks puts "converse with your data" (its AI assistant) inside the palette. Pitch and Figma show shortcut keycaps on the right of each row. |
| Screens / AI Chat UI | n/a | Mistral, Airtable, Gemini, ChatGPT, Claude, Perplexity, Superhuman, Lovable, ClickUp, Databricks, n8n, Amie | **Airtable's AI side panel** reports what it changed as an inline action receipt ("…has been added", with Undo and Hide). Mistral and Gemini use a centred composer with a model picker in the composer row. |
| Screens / Chat Bot | 795 | Strut, Gemini, VEED, Sana, Claude, ClickUp, Monarch, Notion, Linear-like apps | **ClickUp Brain** is a floating panel docked at the bottom right of the main app. Its empty state says "Ask anything or write with AI", lists suggested prompts grouped by intent, and has chips above the composer. **VEED** uses a floating help popover with a system-status row ("All systems operational"). **Strut** shows action chips under an assistant reply. |
| Screens / Command Center Design | 261 | Dropbox Dash, Microsoft Copilot, Calendly, Mintlify, Telegram, HubSpot, Zendesk | Copilot and Dropbox Dash merge an AI prompt with command search in one palette. |
| Screens / Confirmation, Action Option | 3339 / 1596 | Notion, v0, Vercel, Linear-like dev tools, OpenAI Platform | Confirmation sheets with a primary button and a quiet cancel button. Useful reference for the visual weight of approval cards. |
| UI Elements / Keyboard Key | 2052 | Slack, Stripe, Grok, Okta | Keycap chips placed inline next to actions. |
| Glossary / Command Palette | n/a | n/a | Mobbin's guidance: summon with a keyboard shortcut (⌘K or ⌘P) that both opens and hides the palette. Its variants are rows with keycaps, tabs and chips. It warns: "Avoid if there are only a few commands." |

**What Mobbin says about Quick Lead:** web products are converging on one summonable surface that handles chat, navigation and actions together (v0, Databricks, Copilot, Dropbox Dash), with AI changes shown as inline receipts that can be undone (Airtable). Native macOS patterns (summon gesture, window level, notch) had to come from public sources.

---

## 2. Public references, app by app

Short quotes are from the cited source.

### ChatGPT for macOS (Classic, then the unified ChatGPT/Codex app)
- **Summon:** Option+Space opens the "Chat Bar", or click the menu bar icon. The shortcut can be changed in Settings > Keyboard Shortcut ([OpenAI help](https://help.openai.com/en/articles/10119604-work-with-apps-on-macos)).
- **Size/position:** a Spotlight-like bar. Since Aug 2024, sending opens a small **companion window** that appears next to the current app instead of switching to the full window. OpenAI: the companion window "stays in front so you can use it more easily" ([9to5Mac](https://9to5mac.com/2024/08/06/multitasking-with-chatgpt-on-the-mac-just-got-a-lot-better)).
- **Persistence:** the companion window floats and does not hide when you switch apps. It can be expanded to the full window.
- **Context:** a banner above the bar names the app ChatGPT is "working with" and what content it will include. This requires Accessibility permission.
- **Inline actions:** for IDEs it produces a **diff to review and apply**, with an option to auto-apply, and edits can be reverted.
- **Hand-off:** expand the mini window to the full app.
- **Lesson from the 2026 regression:** after the ChatGPT/Codex unification, Option+Space opened a heavier Work/Codex task instead of a light chat. Users opened a long issue ([openai/codex#31925](https://github.com/openai/codex/issues/31925)), calling the lightweight window "a low-friction way" to ask quickly, and asked for an explicit target-mode setting. **Keep the quick surface's semantics stable and lightweight.**

### Claude desktop: quick entry
- **Summon:** **double-tap Option** (default), Option+Space, a custom shortcut, or the menu bar icon. Caps Lock dictation is opt-in ([Claude Help](https://support.claude.com/en/articles/12626668-use-quick-entry-with-claude-desktop-on-mac)).
- **Size/position:** a single text box over the current app. MacStories describes it as an overlay "at the bottom of your screen". Per Claude Academy it "stays in front as you switch apps".
- **History:** the "New chat" control shows your **five most recent conversations**.
- **Context:** drag to screenshot, or click a window to attach it.
- **Permissions:** requires **Accessibility** for quick entry and Screen Recording for captures. The double-tap Option gesture is the reason Accessibility is needed (see section 4).
- **Requirement:** the app must be running, though it can be in the background.

### Raycast: Quick AI, AI Chat
- **Summon:** press Tab from the root search to send your text to Quick AI. AI Chat has its own window and an optional global hotkey ([Quick AI](https://manual.raycast.com/ai/quick-ai), [AI Chat](https://manual.raycast.com/ai/ai-chat)).
- **Quick AI** answers in the launcher window. Follow-ups continue the conversation. ⌘[ and ⌘] step through recent Quick AI chats. ⌘N starts a fresh chat. ↵ on an answer pastes it into the previous app.
- **Hand-off:** **⌘J** "Continue in AI Chat" carries the full history, the model and the attachments. This is the cleanest hand-off pattern found.
- **Auto-new chat:** Quick AI starts fresh after a configurable idle time (5 min to never), so new questions don't get tacked onto an old thread.
- **Persistence:** AI Chat has an **Always on Top** toggle in the Action Panel. **Background notifications** fire when a chat finishes while the window is blurred; the notification says why it finished ("done, needs confirmation, failed") and clicking it returns you to that chat.
- **Inline decisions:** "Ask User Question" pauses the run to show a short multiple-choice question in the conversation. Tool calls "approve routine tool calls on its own and asks you about the rest". Pending confirmations pause the run.
- **Keyboard:** ↵ sends, ⇧↵ adds a newline, ↑ in an empty composer edits the last message, ⌘K opens the Action Panel, ⌘F finds in chat, Esc cancels editing, ⌘↵ queues or steers a follow-up.
- **Long messages** collapse past about 10 lines and show "Show more".

### Apple Spotlight (macOS 26 Tahoe / 27)
- **Summon:** ⌘Space. ⌘3 narrows results to actions. Actions with parameters are filled in inline; Tab moves between fields and Return runs the action ([Apple Support](https://support.apple.com/guide/mac-help/take-actions-and-shortcuts-in-spotlight-mchl4953dfeb/mac)).
- **Quick keys:** typed abbreviations such as "ft Ashley" run an action. Suggested quick keys are assigned automatically after you run an action once.
- **Esc** after choosing an action goes back to search rather than closing. This is layered Esc behaviour.
- With Siri AI on, you can type a request and pick "Ask Siri" from the results, so chat and actions sit in one field.
- Third-party apps add their actions through **App Intents**. Toolroll could expose "Ask the Lead", "File task" and "Approve pending card" here at no UI cost.

### Arc: Little Arc / Command Bar
- **Summon:** ⌘⌥N from any app opens a standalone Command Bar, and results open in a small Little Arc window ([allthings.how](https://allthings.how/whats-little-arc-in-the-arc-browser-and-how-to-configure-it)).
- **Scope:** a minimal single-purpose window with one tab and no forward button.
- **Hand-off:** an "Open in [Space]" button, **⌘O** to promote into the main window, ⌥⌘O to choose a destination. This is the clearest example of promoting a quick panel into the full app.

### Linear command menu
- ⌘K runs any action or jumps anywhere. In 2019 it was made **contextual**: it shows actions for the current view or selection and **anchors near the element that invoked it** instead of always appearing centred ([changelog](https://linear.app/changelog/2019-10-07-contextual-command-menu)).

### Superhuman Command
- ⌘K is "your master control to find and take any action" and teaches the shortcut as you use it ([help](https://help.superhuman.com/hc/en-us/articles/46005701270541-Keyboard-Shortcuts-in-Superhuman-Mail)).
- Design rules from Superhuman's palette essay ([blog](https://blog.superhuman.com/how-to-build-a-remarkable-command-palette)): use **one shortcut to open and close it**, and return focus to the element that had it before; match commands fuzzily and by synonyms; boost commands that are relevant in the current context; give each row an icon and a keycap.

### Notion: Command Search
- A customizable global shortcut or the menu bar opens search and Notion AI "without switching between windows" or bringing the app forward ([Notion help](https://notion.so/help/notion-for-desktop)). Turning it on also sets Notion to open at login, which is the cost of an always-ready panel.

### Perplexity for Mac
- A **floating task bar** summoned by pressing **both Command keys** together. Perplexity says to use the main app "when you need the full task, file, or history view" ([help](https://perplexity.ai/help-center/en/articles/19800006-work-with-browsers-and-apps)). Holding Fn starts voice. An explicit split: quick capture in the bar, history in the app.

### Things 3: Quick Entry
- ⌃Space opens Quick Entry and ⌃⌥Space opens Quick Entry with Autofill, which adds a link to the current Safari page, Mail message or Finder file. All of the main app's shortcuts (tags, dates, lists) work inside it ([Cultured Code](https://culturedcode.com/things/support/articles/2249437)).
- **Keyboard:** **Esc discards** what you typed; **⌘Return saves and closes**. Things' own article warns about this asymmetry with the main app.
- Notes that macOS 15.2 blocks shortcuts whose only modifier is Shift.

### Notch apps: NotchNook, Alcove, AgentPeek, NotchStar
- **NotchNook Pro** advertises "Approve Claude Code and Codex from the notch, without switching windows" and works "with or without a notch, including on external displays" ([lo.cafe](https://lo.cafe/notchnook/)). On screens without a notch it falls back to a pill.
- **AgentPeek** ([permissions](https://agentpeek.app/permissions/)) is the closest analogue to Toolroll's approval cards:
  - The notch expands automatically when a prompt arrives and shows the command, file path or diff inline.
  - Keys: ⌘A allow, ⌘N deny, ⌥A always allow, ⌥T jump to the session's terminal, arrows move between stacked prompts.
  - It offers "deny with feedback"; plans get Approve and Reject buttons.
  - It "sends a response only when you choose an action".
  - Every decision is logged in the session timeline.
  - Optional global hotkeys answer the frontmost prompt without opening the panel.
- **NotchStar** ([engineering write-up](https://notchstar.com/blog/nspanel-above-the-menu-bar)) documents a working NSPanel recipe:
  - Level `mainMenu + 3` (27 on macOS 27.0.1).
  - `[.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]`.
  - `canBecomeKey` is gated by a flag that is on only while a text tool is open.
  - Notch width = screen width minus both auxiliary areas; height = `safeAreaInsets.top`.
  - On screens without a notch it uses a 190×24 pt pill.
  - Lessons: an invisible window that is fading out still catches clicks (use `orderOut`); a window above the menu bar that is wider than the notch swallows clicks on menu bar items.
- **Official path (new):** macOS 27.3 brings **Live Activities to every Apple silicon Mac's menu bar**, and to the Dynamic Island on the new OLED MacBook Pros. Third-party apps adopt them through **ActivityKit and a widget extension**, with interactive buttons driven by App Intents ([Apple tech talk "Bring Live Activities to Mac"](https://developer.apple.com/videos/play/tech-talks/111467), [ActivityKit docs](https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities)). This makes a hand-rolled notch window unnecessary on 27.3+ for the "live activity pill" idea.

---

## 3. The strongest patterns (ranked for Toolroll)

1. **One shortcut toggles the panel, which floats without activating the app.** Seen in Claude quick entry, the ChatGPT companion window, the Perplexity task bar, Things Quick Entry and Superhuman's open/close rule. The panel appears over the current app; you type and stay where you were.
2. **Promote the conversation to the full app with one key, history included.** Raycast ⌘J "Continue in AI Chat" and Arc ⌘O "Open in Space". Quick and full views are two windows onto one conversation, not two products.
3. **Inline decision cards with keyboard verbs and a jump-to-source.** AgentPeek (⌘A allow, ⌘N deny, ⌥T jump, arrows across a stack, deny with feedback), Raycast "Ask User Question" and paused tool confirmations, and ChatGPT's review-and-apply diffs.
4. **Receipts with Undo after an action runs.** Airtable's AI panel on Mobbin, and ChatGPT's revertible diffs. Approving a card should leave a compact receipt with Undo, not just make the card disappear.
5. **Finish work in the background and notify.** Raycast background notifications (done, needs confirmation, failed), which return you to the exact chat. Pairs with a badge on the menu bar or notch pill.
6. **Recent context, capped.** Claude's five recent chats, Raycast's ⌘[ and ⌘] through recent Quick AI chats with auto-new after idle, and Perplexity's "open the main app for history". The quick panel shows a short tail and defers deep history to the main window.
7. **An empty state of suggested intents plus status.** ClickUp Brain's grouped prompt suggestions, VEED's status row, and Spotlight's ⌘3 action list. For Toolroll: pending approvals first, then suggested asks.
8. **Context chip and capture (optional).** ChatGPT's "working with" banner, Things Autofill and Claude's window capture. A cheap Toolroll version is a project-scope chip.
9. **Ambient pill for in-flight work** (later): the notch apps, and the official macOS 27.3 menu bar Live Activities.

---

## 4. macOS implementation facts (SwiftUI + AppKit)

### Window type
- Use an **`NSPanel` subclass hosting SwiftUI** through `NSHostingView`. Neither `WindowGroup` nor `MenuBarExtra` exposes the level, collection behaviour or frame control you need.
- **`.nonactivatingPanel`:** "does not activate the owning app" ([Apple](https://developer.apple.com/documentation/appkit/nswindow/stylemask-swift.struct/nonactivatingpanel)). The panel can become key and take typing while the user's frontmost app keeps its menu bar, and Toolroll's main window does **not** jump forward.
  - A regular window, or calling `NSApp.activate`, brings every Toolroll window forward and can switch Spaces. That is wrong for a quick panel.
- **Key window:** a borderless window cannot become key by default. `canBecomeKey` is true only with the `titled` mask, so override it to return true ([Apple](https://developer.apple.com/documentation/appkit/nswindow/canbecomekey)). Override `canBecomeMain` to return false.
- **`becomesKeyOnlyIfNeeded`:** in a non-activating panel, the panel becomes key only if the clicked view returns true from `needsPanelToBecomeKey` ([Apple](https://developer.apple.com/documentation/appkit/nspanel/becomeskeyonlyifneeded)). Use it for the future notch pill (clicks without stealing focus). The chat panel always needs typing, so call `makeKeyAndOrderFront` on show.
- **`isFloatingPanel = true` with level `.floating`** ("Useful for floating palettes"). Apple's guidance is that floating suits small panels that become key only when needed ([Apple](https://developer.apple.com/documentation/appkit/nspanel/isfloatingpanel)). The quick chat is the accepted Spotlight-style exception. Reserve levels above `.mainMenu` for a notch-sized pill only.
- **`hidesOnDeactivate` defaults to true for `NSPanel`** ([Apple](https://developer.apple.com/documentation/appkit/nswindow/hidesondeactivate)). Set it to false and manage hiding yourself, otherwise the panel vanishes unpredictably when Toolroll itself deactivates.
- **`collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient or .ignoresCycle]`.**
  - `.canJoinAllSpaces`: "The menu bar behaves this way."
  - `.fullScreenAuxiliary`: displays "on the same space as the full screen window", so the panel can appear over a full-screen editor ([Apple](https://developer.apple.com/documentation/appkit/nswindow/collectionbehavior-swift.struct/fullscreenauxiliary)).
  - `.ignoresCycle` keeps it out of ⌘`.
- **Other settings:** `isMovableByWindowBackground = true`, `animationBehavior = .utilityWindow`, and a style mask of `[.nonactivatingPanel, .titled, .fullSizeContentView, .resizable]` with a transparent, hidden title bar (or `.borderless` with a custom corner shape). Use the system material for the background, which gets Liquid Glass on 26+.

### Global hotkey and permissions
- **Carbon `RegisterEventHotKey`:** needs **no Accessibility or Input Monitoring permission**. It receives only the registered combination and **consumes** it. Works sandboxed or not.
  - Practical wrapper: `sindresorhus/KeyboardShortcuts`, an SPM package with a SwiftUI recorder view, which suits Toolroll's SPM layout.
  - Caveat: macOS 15.0–15.1 rejected registrations whose only modifiers are Option and/or Shift (error -9868). Apple reversed this in 15.2 ([Eternal Storms](https://blog.eternalstorms.at/2024/09/23/keyboard-shortcuts-using-option-and-or-shift-modifiers-only-no-longer-allowed-on-macos-sequoia)). Make sure the default includes ⌘ or ⌃ anyway.
- **`NSEvent.addGlobalMonitorForEvents`:** **observe only**. Apple: you can only observe the event, not prevent its delivery to the target app, and **key events need Accessibility trust** (`AXIsProcessTrusted`) ([Apple](https://developer.apple.com/documentation/appkit/nsevent/addglobalmonitorforevents(matching:handler:))).
  - So "double-tap ⌥" or "both ⌘ keys" gestures (Claude, Perplexity) need a `flagsChanged` global monitor and therefore Accessibility. That is why Claude's quick entry asks for it.
  - **Global mouse monitors need no Accessibility.** NotchStar relies on this for click-outside-to-dismiss.
- **Toolroll-specific:** `build-app.sh` falls back to **ad hoc signing** (`codesign --sign -`). TCC keys Accessibility grants to the code signature, so ad hoc rebuilds can silently lose the grant. Another reason to make the default hotkey Carbon-based and keep any modifier-tap gesture opt-in.
- **Menu bar fallback:** a status item (`MenuBarExtra` or `NSStatusItem`) gives a permission-free click target and a place for a pending-approvals badge.

### Focus and first responder pitfalls
- SwiftUI `@FocusState` in a freshly ordered-front panel often fails on the first show. Set focus after `makeKeyAndOrderFront`, on the next runloop turn, or call `panel.makeFirstResponder` on the underlying text view.
- **Esc:** override `cancelOperation(_:)` on the panel, or use `.onExitCommand`, so Esc reaches you even when the text view has focus.
- **Click outside:** observe `NSWindow.didResignKeyNotification` and add a global mouse-down monitor (no permission needed). Hide with `orderOut`, never a fade that keeps hit-testing.
- **Edit shortcuts:** ⌘C, ⌘V, ⌘A and ⌘Z are menu key equivalents. **Verify** they work in the panel while Toolroll is *not* the active app, since the active app's menu bar belongs to someone else. If they fail, override `performKeyEquivalent` in the panel to forward cut, copy, paste, select all and undo through `NSApp.sendAction`. NotchStar hit this with its agent app and fixed it with a hidden Edit menu.
- Keep **one store**. The panel's SwiftUI view should observe the same `WorkbenchStore` and Lead chat state as the drawer, so drafts, streaming and cards stay in sync and you don't run two polling clients.

### Multi-display and notch geometry
- **Which screen:** use the screen under the mouse, `NSScreen.screens.first { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) }`, as Spotlight does. Position it in that screen's `visibleFrame` at about 20–25% from the top, horizontally centred. Remember a dragged position per screen if the user moves it.
- **Notch detection:**
  - `NSScreen.safeAreaInsets` (macOS 12+): "On some Macs, the insets reflect the portion of the screen covered by the camera housing" ([Apple](https://developer.apple.com/documentation/appkit/nsscreen/safeareainsets)).
  - `auxiliaryTopLeftArea` and `auxiliaryTopRightArea` are the unobscured top corners, or nil when the top isn't obscured ([Apple](https://developer.apple.com/documentation/appkit/nsscreen/auxiliarytopleftarea-uglc)).
  - Notch width = `frame.width - left.width - right.width`; height = `safeAreaInsets.top`.
  - Don't assume there is only one notched screen. Use a pill fallback on external or non-notch displays.
- **Live Activity route (27.3+):**
  - Use ActivityKit `ActivityConfiguration` with compact, expanded and minimal views, plus a menu bar expanded view, and App Intent buttons (for example Approve) ([tech talk](https://developer.apple.com/videos/play/tech-talks/111467)).
  - It requires a **widget extension inside the app bundle**. Toolroll is a pure SPM executable assembled by a script, so this needs an Xcode or XcodeGen target, or manual `.appex` packaging. Gate it with `if #available(macOS 27.3, *)`, since the package targets macOS 14.
  - Respect `ActivityAuthorizationInfo().areActivitiesEnabled`.

---

## 5. Recommended interaction model for Quick Lead

**Summon**
- Global hotkey through Carbon, with no permission needed. Default **⌃⌥L** ("L" for Lead), recordable in Settings.
- Avoid these defaults:
  - ⌘Space: Spotlight.
  - ⌃Space: input sources, and Things.
  - ⌥Space: ChatGPT and Claude.
  - ⌃⌥Space: Things Autofill.
  - ⌥⌘Space: Finder search.
- The same hotkey toggles the panel closed.
- Other ways in: a menu bar icon (click to toggle, shows a badge count of pending cards), a Spotlight App Intent "Ask the Lead", and opt-in "double-tap ⌘", which explains its Accessibility prompt when enabled.
- Toolroll must be running. Offer "Open at login" when the user enables Quick Lead, as Notion does.

**Size and position**
- **Collapsed:** a 640 pt wide composer bar, about 56 pt tall, on the mouse's screen, horizontally centred, about 22% down the visible frame.
- **Expanded:** grows downward to show the transcript and cards, up to about 560 pt (or 70% of the screen height), then scrolls. Resizable, with the size remembered.
- Material background, 16–20 pt corner radius, system shadow. Do not go above the menu bar.

**Behaviour on blur**
- **Unpinned (default):** clicking elsewhere or switching apps hides the panel (`orderOut`). **The draft is never lost**; it is restored on the next summon and also mirrored into the drawer's composer.
- **Streaming or a pending decision survives a hide.** The Lead keeps working. When it finishes or needs a decision while the panel is hidden, send a `DesktopNotifier` notification ("Lead replied", "Lead needs approval: …") that reopens the panel scrolled to that item, following Raycast's background notifications. The menu bar badge updates.
- **Pinned:** a pin button or **⌘P** keeps it floating over every Space and full-screen app, like the ChatGPT companion window and Raycast's Always on Top. Pinned panels are draggable.

**History**
- The Lead is one room (`LeadChatResponse.room == "chat"`), so Quick Lead is **a second window onto the same thread**, not a separate chat type.
- On open, show the **last 3 exchanges**, collapsed to one line each, above an "Earlier in Lead" divider with "Show earlier" (⌘↑ or a click). Long messages collapse past about 8 lines, as Raycast does.
- No auto-new-chat. Instead, when more than about 30 minutes have passed, put a time divider ("2 h ago") above the composer so old context is obviously old.

**Inline approval cards** (reuse the `AgentRequestsBannerView` and `LeadMessageRow` visuals)
- **Pending cards are pinned above the composer** as a stack, newest first, with a count ("2 waiting"). They are not buried in the transcript.
- **Each card shows:** what will happen (title), the target (project, task or branch), a compact preview of the command, diff or file list (expandable), and who is asking.
- **Keyboard:** with the composer empty, ↑ and ↓ move focus across cards.
  - **⌘↵** runs the primary action (Approve).
  - **⌘⌫** rejects.
  - **⌥⌘↵** rejects with feedback, which focuses the composer prefilled "Reject: …", following AgentPeek's deny with feedback.
  - **⌘O** opens the card's target in the main window.
- Plain ↵ **never** approves; it only sends the composer text. Destructive or irreversible actions (push, delete, deploy, spend) need a click or a second ⌘↵ confirm. "Always allow" stays out of the quick panel.
- **After a decision:** the card shrinks to a one-line receipt ("Approved · Filed task T-123 · Undo"). Undo stays live for about 10 s where the backend can reverse the action. Every decision also lands in the drawer's transcript.
- **Clarifying questions** from the Lead render as option chips (1–4 number keys select), following Raycast's Ask User Question.

**Hand-off to the main window**
- **⌘J "Open in Toolroll"** (Raycast's key) activates the app, opens the main window with the Lead drawer tab selected at the same message, moves the draft across, and hides the panel. When the panel is pinned it stays open instead.
- Task and project links in Lead messages open the main window on that object (⌘-click keeps the panel).
- The header shows "Open in Toolroll ⌘J" as a visible affordance, as Arc's "Open in Space" button does.

**Empty state** (first open, or no recent activity)
1. Pending approvals, if any, always come first.
2. A **scope chip**: "Lead · All projects", or the project last focused in Toolroll. Click or type `@` to change it.
3. 3–4 suggested asks, chosen by recency and state: "What's running right now?", "Summarise today's agent work", "File a task in {project}…", "Why did {last failed task} fail?". Each has a keycap hint, 1–4.
4. A one-line status row in VEED's style: "3 agents running · 1 failed".

**Keyboard model (summary)**

| Key | Action |
|---|---|
| hotkey | toggle panel |
| ↵ / ⇧↵ | send / newline |
| Esc | layered: collapse an expanded card or preview → clear focus from cards → hide the panel, keeping the draft. Unlike Things, Esc never discards text |
| ⌘W | hide |
| ↑ (empty composer) | move into the card stack, then the transcript |
| ⌘↑ | show earlier |
| ⌘↵ / ⌘⌫ / ⌥⌘↵ | approve / reject / reject with feedback (focused card) |
| ⌘O | open the focused item in Toolroll |
| ⌘J | continue in Toolroll |
| ⌘P | pin / unpin |
| ⌘. | stop generating |
| ⌘K | action menu (copy reply, switch scope, settings) |
| 1–4 | pick a suggestion or question option |

Show keycaps beside actions, as Mobbin's command-palette examples and Superhuman do.

**Later: the notch or menu bar pill**
- On macOS 27.3+, use an **ActivityKit Live Activity** for "Lead working…", "Needs approval (2)" and "Task done". Approve and Reject App Intent buttons go in the expanded view, and a click opens Quick Lead.
- On older macOS, optionally use a hand-rolled notch-sized `NSPanel` (NotchStar recipe) with `becomesKeyOnlyIfNeeded`, falling back to a pill on screens without a notch. It must never be wider than the notch.

---

## 6. Pitfalls to avoid

1. **Activating the app on summon.** It brings the main window and its Space forward. Use `.nonactivatingPanel` and `makeKeyAndOrderFront`, never `NSApp.activate`, until ⌘J.
2. **NSPanel's default `hidesOnDeactivate = true`** makes the panel vanish when Toolroll deactivates. Set it to false and own the hide rules.
3. **Using `NSEvent` global key monitors for the hotkey.** They need Accessibility, can't swallow the keystroke (it still types into the frontmost app), and the grant resets on ad hoc rebuilds. Use Carbon.
4. **Option- or Shift-only default shortcuts** (rejected on macOS 15.0–15.1), and collisions with ⌥Space, ⌃Space and ⌘Space.
5. **Plain ↵ approving a card**, or approval focus stealing the composer. Separate send (↵) from decide (⌘↵), and make destructive actions require a click.
6. **Discarding the draft on Esc or blur** (Things' Quick Entry behaviour). Persist drafts across the panel and the drawer.
7. **A second data path.** The panel must share the drawer's store; duplicated polling or optimistic state will drift.
8. **Changing the panel's semantics later** (ChatGPT's 2026 regression routed the quick window into a heavier mode). Keep Quick Lead lightweight, and make any "start a task" action explicit.
9. **Invisible or fading windows that still hit-test**, and pill windows above the menu bar that are wider than the notch. Use `orderOut` and size the pill exactly.
10. **Wrong screen.** Use the mouse's screen, not `NSScreen.main` (the key window's screen). Don't assume one notched display. Include `.fullScreenAuxiliary` so the panel can appear over full-screen IDEs.
11. **SwiftUI focus timing** in the panel (the first summon doesn't focus the field) and **⌘C or ⌘V not reaching the text view** while the app is inactive. Test both explicitly.
12. **Silent background completion.** If the panel is hidden while the Lead works, notify and badge, or the user never learns a card is waiting.
13. **Overbuilding the notch first.** On macOS 27.3 the official menu bar Live Activities cover the pill. It needs a widget extension target that the SPM and script build doesn't have yet, so plan the packaging work before promising it.

---

## Sources
- Mobbin public pages: mobbin.com/explore/web/screens/{command-palette, ai-chat-ui, chat-bot, command-center-design, confirmation, action-option, notifications, conversational-ui-examples}, /explore/web/ui-elements/{drawer, popover, toast, keyboard-key}, /glossary/command-palette
- OpenAI Help "Work with Apps on macOS"; 9to5Mac 2024-08-06; github.com/openai/codex/issues/31925
- Claude Help "Use quick entry with Claude Desktop on Mac"; Claude Academy "Navigating the Claude desktop app"; MacStories 2025-10-21
- Raycast Manual: Quick AI, AI Chat
- Apple Support "Take actions and shortcuts in Spotlight on Mac" (macOS 27)
- allthings.how "Little Arc"; Linear changelog 2019-10-07; Superhuman help and blog "How to build a remarkable command palette"
- Notion help "Notion for desktop"; Perplexity help "Work with Browsers and Apps"; Cultured Code "Quick Entry"
- lo.cafe NotchNook and its AI agents guide; agentpeek.app/permissions; notchstar.com/blog/nspanel-above-the-menu-bar; tryalcove.com
- Apple docs: NSWindow.StyleMask.nonactivatingPanel, NSPanel.isFloatingPanel / becomesKeyOnlyIfNeeded, NSWindow.canBecomeKey / hidesOnDeactivate / CollectionBehavior (.canJoinAllSpaces, .fullScreenAuxiliary) / Level.floating, NSEvent.addGlobalMonitorForEvents, NSScreen.safeAreaInsets / auxiliaryTopLeftArea, HIG Panels, ActivityKit "Displaying live data with Live Activities", Tech Talk 111467 "Bring Live Activities to Mac"
- Eternal Storms blog (Sequoia hotkey modifier restriction, reversed in 15.2); MacRumors, AppleInsider and iThinkDiff on macOS 27.3 Live Activities
