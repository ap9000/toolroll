# Quick Lead — the Lead from anywhere on the Mac

Owner (2026-11-23): the Lead only lives in a drawer tab; wants "a floating chat thread/flow for anything related to
working in Toolroll", notch/status-bar style. Research: docs/plans/mac-quick-lead-research.md (ChatGPT ⌥Space, Claude
double-⌥, Raycast ⌘J hand-off, AgentPeek/NotchNook inline approvals, Things Quick Entry, Mobbin web patterns).

Scope: Mac app only. No server or contract change — the panel reads the same `GET /engine/chat` and posts the same
Lead send/approval acts the drawer already uses, through the one `WorkbenchStore` (no second data path). Separate PR
after #488 merges. Notch pill / Live Activity is a later follow-up (needs a widget extension the SPM build can't make).

## Behaviour
1. **Summon**: a global shortcut, default ⌃⌥L (free on this Mac; ⌥Space/⌃Space/⌘Space are taken), changeable in
   Settings; the same shortcut hides it. Also: menu bar icon → "Ask the Lead" (the icon already shows a needs count),
   and Work menu ▸ Quick Lead. No Accessibility permission (Carbon hot key via sindresorhus/KeyboardShortcuts, or a
   ~60-line RegisterEventHotKey wrapper if we'd rather not add a dependency).
2. **Window**: a non-activating floating panel on the screen under the mouse, ~22% down, 640 pt wide. Collapsed: the
   composer (≈56 pt) plus a one-line status ("2 need you · 1 running"). Grows to show the conversation and cards, max
   ≈560 pt, then scrolls. Joins all Spaces and full-screen apps. Your current app stays active underneath.
3. **Content, top to bottom**:
   - Waiting on you: the Lead's pending proposal cards and task approvals (newest first), each with what will happen,
     the target, an expandable preview, and Approve / Reject / Open.
   - The last 3 exchanges of the one Lead thread ("Show earlier" loads more) — the same thread as the drawer, a second
     window onto it, with a time divider when you come back.
   - Composer: draft is always kept (blur, Esc, hide, reopen); attachments like the drawer.
   - Empty state: 3 suggested asks ("What needs me?", "Queue a task in <project>…", "Set up an automation…").
4. **On blur**: hides by default; the Lead keeps working. A reply or a new approval while hidden → a notification that
   reopens the panel at that item, and the menu bar count updates. A pin (⌘P) keeps it on top.
5. **Keyboard**: ↵ sends; ⇧↵ newline; ↑/↓ move between cards when the composer is empty; ⌘↵ approves the focused card
   (plain ↵ never approves); ⌘⌫ rejects; ⌘O opens the item in the main window; ⌘J "Open in Toolroll" — main window
   forward on the Lead drawer at the same message, draft carried over; ⌘. stops a reply; Esc steps back one layer, then
   hides (never discards the draft).
6. **After an act**: the card collapses to one line ("Approved · Queue fix in oddcircle") with Undo only where the
   server already offers an undo; otherwise just the line.

## Safety
- No new authority: every approve/reject/send is the existing act with the existing checks (a password step-up where
  the act needs one opens the existing password prompt over the panel). Destructive or money acts need a click, never a
  keyboard approve.
- The panel shows only what the active workspace's session can already see; switching workspace clears it.
- Global shortcut registration fails → say so in Settings and keep the menu bar entry; never silently dead.

## Build
- `QuickLeadPanel` (NSPanel subclass: .nonactivatingPanel, canBecomeKey true / canBecomeMain false, isFloatingPanel,
  level .floating, hidesOnDeactivate false, collectionBehavior [.canJoinAllSpaces, .fullScreenAuxiliary,
  .ignoresCycle]); `QuickLeadController` (show on the mouse's screen, hide via orderOut, click-outside via a global mouse
  monitor — no permission needed); `QuickLeadView` (SwiftUI, reuses LeadMessageRow, the drawer's composer pieces and the
  approval card views); hot key registration + Settings row; store additions: `quickLeadDraft`, `isQuickLeadPinned`,
  `openLeadInMain(messageId:)`.
- Tests: ToolrollCore unit tests for the "what's waiting" ordering and the hand-off target; a store test that the panel
  and drawer share one draft/thread; manual QA list (first-open focus, ⌘C/⌘V while another app is active, full-screen
  app, two displays, ad-hoc rebuild keeps the shortcut).

## Out of scope
Notch pill / Live Activity (follow-up), voice input, multiple Lead threads, any new server read.

---
## Revised after critic review (2026-11-23) — supersedes the above where they differ
- Freeze: Quick Lead is "another way into the same Lead thread", not new capability — owner to confirm.
- Phase 1 (no server change): fixed ⌃⌥L via a ~40-line Carbon RegisterEventHotKey wrapper (no package — KeyboardShortcuts
  needs resource bundles our build doesn't copy); non-activating NSPanel on the mouse's screen; hide on blur/Esc/hotkey
  via orderOut, draft survives; shared message list + composer extracted from LeadThreadView (one renderer), bound to the
  same store and selected project; one "Open in Toolroll" (⌘J); menu bar "Ask Lead ⌃⌥L" + command palette entry. One-line
  states: can't reach Toolroll (Retry), signed out (Open Toolroll), remote (send only), demo, Lead off/problem, busy,
  loading. No pin, no notifications, no suggested prompts, no Undo (none exists), no cards yet.
- Phase 2: decode cards/ask/queued/pendingProposals (Mac drops them today; sendLeadMessage's local update also drops
  them); render cards read-only in drawer AND panel with "Review in Toolroll".
- Phase 3: confirm/dismiss in place only for kinds a local owner may confirm without a password (task, answer, steer,
  cancel, hold, unhold; scope_approve only when no password field; result_accept, task_start/resume/cancel …). Exact
  card text, explicit click (⌘↵ only when the card has focus, never from the composer; irreversible = click + checkbox),
  in-flight disable, server words on stale/refused, plain receipt. Any password answer → "Review in Toolroll"; the panel
  never collects a password. Decide the nonce door (JSON review endpoint vs HTML) before Phase 3.
- Manual acceptance on the built .app: first-open focus, ⌘C/⌘V/⌘A/⌘Z while another app is active (fallback:
  performKeyEquivalent forwarding), Esc, full-screen Space, two displays.
