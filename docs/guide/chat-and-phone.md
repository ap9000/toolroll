# Chat and your phone

## The lead

**Chat** is a conversation with the lead: an assistant that reads your
projects, drafts tasks and flows, and proposes actions as cards you confirm.
It never changes anything without your confirmation, and never asks for a
password or key: those go on secure screens.

## Telegram

Settings → Telegram: paste a bot token from @BotFather, then send the bot the
`/pair` code shown. After that:

- Things that need you arrive as messages, and decisions have buttons.
- A flow decision shows the draft with **Approve**, **Edit** and **Send
  back**. Edit asks for your version as a reply; it replaces the draft and
  comes back to approve. Send back asks what should change.
- You can talk to the lead from the chat, and reply to a task's messages
  to talk about that task.

**How your messages reach Toolroll.** With a public hooks address set
(the one webhook triggers use, like a Tailscale Funnel on `/hooks`), Telegram
pushes each message and tap to `…/hooks/telegram` the moment you send it.
Telegram signs every push with a secret only Toolroll knows.
Otherwise, Toolroll asks Telegram for new messages every few seconds.
Settings → Telegram bot token says which one is happening.

While Telegram pushes, no other program can ask for your bot's messages, so
none can go astray. If pushes stop arriving for five minutes, Toolroll
asks for messages itself for a while, then tries pushes again. Nothing is
lost meanwhile: Telegram keeps undelivered messages for a day.

## Slack, Discord and Teams

Each can be connected under Settings and used to talk to the lead and
confirm its cards. Only one app sends alerts: the one you choose as primary
(Settings → Notifications).

Pairing and approvals work as on Telegram. Each person pairs their own
chat with a code from Settings. A ready result, a failed task, a plan or
a pull request comes with its own buttons (**Accept and finish**,
**Retry**, **Approve & start**, **Merge**), and each asks once more before
it acts. A mode signed before Slack, Discord and Teams could approve covers
Telegram only; sign the mode again to approve plans and merges from them.

A flow decision arrives there with the draft and **Approve**, **Edit** and
**Send back**, as on Telegram. Edit and Send back ask for your next message
in that chat: it becomes the new draft (which comes back to approve) or the
note the card goes back with. Send "cancel" to leave it; the question
lapses after 30 minutes.

## The phone itself

The console works on a phone browser. Add it to your Home Screen (iPhone) to
get notifications from Settings → Notifications → This device. To reach it
away from home, put it on your tailnet: `toolroll up --host 0.0.0.0
--allow-host <your-machine>.ts.net:4180`.
