# Subagents

Your lead can have subagents: named helpers, each with its own personality,
instructions and rules. Ask your lead to hand one something ("ask Maya where
order 2201 is"), or put one on a flow step, where it works cards the way an
employee would: it reads each card, decides, writes replies and moves cards
on, and comes to you when its rules say to ask first. Add one in
**Settings → Lead → Subagents**, or start from a
[starter kit](getting-started.md#start-from-a-kit), which adds a subagent
together with the flow it works.

Subagents used to be called AI teammates. Each one carried over with
its name, soul file, memory, tools, desk and history; old links to its page
still open it.

## Who a subagent is: its soul file

Each subagent is a soul file: a short Markdown document it reads every turn.

```markdown
---
name: Maya
role: Support
---

## Who you are
You look after this team's customers. You're warm, calm and quick.

## How you write
- Short, friendly, plain words. Sign off as "The team".

## What you know
- Refunds go back to the original payment method within 5 business days.

## Decide on your own
- Refunds and replacements up to $50.

## Ask first
- Refunds over $50, anything legal, or a threat to leave.

## Never
- Promise dates or discounts that aren't written here.
```

Start from a template (Support rep, Sales rep, Ops coordinator, Triage lead)
or a blank file, and make it yours on the subagent's page. Every save is a new
version, and **Download** gives you the file. Keep secrets out: a soul file
that looks like it holds a key is refused.

## Putting a subagent to work

- **On a decision:** in a flow, open a "Person decides" zone and choose the
  subagent under **Who decides**. It approves (sending the draft as written,
  or as it rewrote it), sends the card back with a note, or hands it to the
  flow's owner with what it would do and why. Your decision then arrives in
  your chat app as always, with the subagent's note.
- **On its own zone:** add a **Subagent handles it** zone. Say what to do there
  and list the answers it can pick, each leading to a zone. It picks one and
  writes what the next zones send (the email body is then
  `{{stage.<zone id>}}`). When its rules say to ask, it asks you a question
  and the card waits. Answer with a tap in your chat app (one button per
  option, plus **Answer in words**: reply to the prompt on Telegram, or send
  your next message in Slack, Discord or Teams), on the card, or through the
  lead. It carries on with your answer.

Every decision is written down with its reason: in the card's history ("Approved
by Maya (AI): within my $50 limit") and on the subagent's page.

## Letting a subagent use tools

A subagent can use your project's tools (the MCP servers on the **Tools** page:
a shop, a CRM, a mailbox, an issue tracker) under a rule you set for each
action. On its page, under **Tools**, pick a tool and **Add tool**. Each of its
actions then has one rule:

- **Do it:** it uses the action on its own.
- **Do it, up to a limit:** on its own up to a number in the call (like
  `amount` 50); above that it asks first. The limit is enforced by Standing
  Orders, not only written in its soul file.
- **Ask first:** each call waits for you. You see exactly the call (“Use shop →
  refund_order · order 2202 · amount 400?”) with its reason, on the card and in
  your chat app. **Approve** makes exactly that call; **Deny** doesn't; or
  answer in words to tell it what to do instead.
- **Never:** it isn't offered the action at all.

Actions that only read start as **Do it**; everything else starts as **Ask
first**. The subagent never calls a tool itself: it asks for a call on its
turn, Toolroll checks the rule and makes it (or asks you), and the
subagent reads the answer before it decides. Every call, made or not, is a
receipt: under **Tool calls** on the card, and in **What it did** on its page.
A visit to a card allows up to 12 calls; after that it decides with what it
has.

## What a subagent remembers

Each subagent has a memory, on its page under **Memory**:

- **What you tell it.** "Tell Maya something" keeps a line ("this week, offer
  free shipping instead of a refund"). Every turn reads the latest ten things
  its people told it.
- **What it keeps.** On any turn it may keep one short fact for later cards
  ("Sam Rivera prefers email to phone calls"). A later card about the same
  thing reads it back; it checks it against the card, and the card wins.

Search it, edit a line, or **Forget** it; the lead can do the same from plain
words. Secrets are refused. It keeps up to 300 facts of its own, forgetting
its oldest; what you told it stays until you forget it.

## It learns from your approvals

When you approve the same ask-first tool action five times in a row without
turning one down, the subagent suggests the rule that would have let it act
alone: "You approved my last 5 refund_order calls on shop (amount 58 to 72).
May I make them on my own up to amount 75, and ask you above that?" It reaches
its manager in their chat app and on its page. **Yes, change it** changes only
that rule (and only if it's still what it was); **Not now** leaves it, and any
words you add are kept in its memory. It asks again only after five more
approvals.

## Its desk: ask it through your lead, give it routines

Each subagent has a desk: its own flow, made the first time it's needed.

- **Ask it through your lead**, in the console, the terminal or your chat app:
  "ask Maya where order 2201 is", or "@maya where's order 2201?". The lead
  shows a card with exactly what goes to Maya. Once you confirm, it lands on
  Maya's desk as a card; Maya works it within its rules and tools, and its
  answer comes back to you. Confirming twice asks once.
- **Routines**, on its page under **Desk and routines**: "weekdays 09:00 —
  Look up yesterday's refunds and tell me the total". Each time, a card lands
  on its desk, and the answer goes to its manager. **Run now** tries one at
  once. Schedules read like "weekdays 09:00", "daily 17:00 Europe/London",
  "monday 09:00" or "every 2 hours".
- **Code changes.** When what you ask for is a change to the project's code,
  it sends the card to its desk's **Build it** zone. That files an ordinary
  task, which is planned and waits for your approval as always.
- The desk is an ordinary flow you can redraw. For example, add a GitHub
  trigger so labelled issues land on Maya's desk, and an Update zone so its
  answer is posted on the issue.

Any "Subagent handles it" zone can also **Answer whoever asked**: what the
subagent writes goes back to the person who added the card.

## Its week, and undo

**This week**, on its page, and each Monday from 9:00 in its manager's chat app:

- **What it did:** decided, handled, handed to people, and asked.
- **Its tool calls:** made, approved first, turned down, and undone.
- **Its turns:** how long it spent thinking, and what the turns cost, as the
  Claude CLI reports them at API prices. A Claude plan covers turns on its
  sign-in.
- **What you overrode:** calls you turned down, and cards someone moved by
  hand right after it moved them. Each links to its card.

**Undo.** Under Tools, open **Undo** and name an action's opposite, like
remove_label for add_label. From then on, its receipts show **Undo with
remove_label**, on the card and in This week. Undo calls the opposite with the
same input, as you, and both calls keep their receipts. If the tool says the
undo failed, the original call stands. From chat, the lead can ask to undo a
call; it's made on the worker's next pass.

## Talking to your subagents

- Its questions and hand-offs reach you in your chat app, under its name
  ("Maya · Support: …").
- **Tell Maya something** on its page adds to its memory for the next turns
  ("this week, offer free shipping instead of a refund"). Lasting rules belong
  in the soul file.
- Your lead can add subagents, change one section of a soul file ("Maya can
  approve refunds up to $100 now"), let one use a tool or stop, change an
  action's rule ("Maya can refund up to $100 in the shop without asking"),
  pause or resume one, pass on a note, fix or forget something it remembers,
  or answer its question for you. Each is a card you confirm.
- Each subagent sends its manager a summary after 5 pm: what it decided,
  handled and handed over, and the tool calls it made. **Send today's
  summary** sends one now.

## Limits

- Subagents do flow work only: they never approve a code task, a merge or
  spending. Those stay with people, or a signed hands-off mode.
- **Pause** stops a subagent: decisions it would make go to people, and zones
  it handles wait until you resume it.
- Each subagent has a daily limit of turns (200 by default, in **Settings** on
  its page); past it, its decisions go to people until tomorrow.
- A subagent reads each card through Claude on this computer's sign-in, with
  no tools of its own, no files and no internet: it only decides, and Standing
  Orders does what it decided within the zone's choices, and makes the tool
  calls its rules allow. The card and what tools answer are data to it, never
  instructions, and a card that tries to change its rules is handed to a person.
- Each tool call counts as a turn toward its daily limit.
