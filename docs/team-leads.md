# Shared leads for a team

> **Deprecated.** Shared central leads, team conversations and team chat still work this release, hidden from help and the console, and are removed in the next minor release. Your lead in Chat does the same work; give it [subagents](guide/subagents.md) for helpers with their own rules.

One installation owns the database and runs the agents. Teammates connect through the browser or CLI using their own accounts. A lead has a stable name, project scope and working instructions; each conversation has its own audience and history.

## Start in the browser

Open Chat, choose **Team chat**, and create a lead for the projects it should handle. Create a Team conversation and use **People** to add existing installation accounts. The add-person form shows the lead's project scope before granting access. An installation operator manages account invitations and project access in People.

Each participant enables chat for themselves after reviewing the configured provider and spending limits. Membership does not grant a spending allowance or approval authority. Send saves a message immediately. Teammates see the author and either **Queued** or **Working**. An author can edit or withdraw a queued message; **Stop** affects the named running turn.

Open a proposed action to inspect its existing terms and confirm it with your own authority. Tasks filed from a shared conversation belong to its lead. Open the saved result, inspect its actual checks, and mark it complete or explicitly request changes. There is no additional model reviewer or automatic repair loop.

Enable automatic updates only in conversations where the lead should summarize new results and decisions. People watching the same conversation share one delivery; each person keeps their own read position. Idle checks make no model calls. A failed response remains visible, and delivery does not rerun its task.

Previous private chat stays private and remains available from Conversations. Creating or joining a team conversation does not copy that history. Lead settings, new conversations and additional leads live under Conversations.

## Connect the CLI

On the installation host, reuse the existing local sign-in without putting its password in shell history:

```sh
toolroll connect https://your-server --local-login
toolroll lead list --json
toolroll conversation list --lead LEAD_ID --json
toolroll brief --conversation CONVERSATION_ID --json
toolroll chat --conversation CONVERSATION_ID --follow
```

On another machine, use `connect ... --as ACCOUNT --token-stdin` or a private `--token-file`. Profiles are saved privately. The connection is HTTPS; credentials never travel in URLs. A saved profile makes `chat` and `brief` use the central service. Existing administrative commands remain local; `--local` explicitly selects the previous local chat or brief.

`brief` returns scoped messages, task summaries, proposals and chat terms from the server database. It starts no agent work. `chat --follow` reads changes and is distinct from `conversation follow --enabled true`, which authorizes automatic summaries within the person's existing chat allowance.

To enable sending noninteractively, inspect the terms in the brief, then use `chat --conversation CONVERSATION_ID --authorize --terms-digest DIGEST`. Use `--say TEXT` to send a message and `--request-id` to retain a caller-chosen identity. If delivery is unconfirmed, use `brief --conversation CONVERSATION_ID --request-id REQUEST_ID`; do not invent another request ID and repeat the work. The brief explicitly reports when an older receipt is outside its bounded history page.

`lead create/update/member/transfer` and `conversation create/member/edit/withdraw/read/follow/stop` expose the same central operations. Membership edits and transfers require the current revision. Transfer keeps the task, approved scope, attempts and completed result; it changes the responsible lead.

## Project memory

Every lead reads the project's memory — instructions, references, lessons and decisions — and records settled choices as decisions with their reason. See [Project memory](PROJECT_MEMORY.md).

## Slack, Discord and Teams

The same rules apply in Slack and Discord: each teammate pairs their own account under Settings, `status`, `task <id>` and `help` answer from the database, a channel follows one team conversation with `team` and `team <number>` from a conversation manager, and Mark complete confirms with a second tap on the card. See [Slack](slack.md) and [Teams](teams.md); Teams needs an internet-reachable messaging endpoint.

## Telegram on your phone

Each teammate pairs their own private chat with the installation's bot: open Settings → Telegram, enter your password, and send the one-time `/pair` code to the bot within 10 minutes. The chat then answers as you, under your own project access and spending consent, and **Unpair my phone** ends it without touching anyone else's pairing. The installation operator still saves the bot token once on the settings page, or with `toolroll bridge telegram token`.

Send `/team` in your private chat to list the conversations you are in and `/team <number>` to talk in one; the chat then saves your messages to that conversation as you, and the lead's replies and teammates' messages come back to you. `/team off` returns to your private assistant. Your private history is never copied into a team conversation.

For a shared room, add the bot to a Telegram group and have a conversation manager send `/team` there, then `/team <number>` to make the group follow one team conversation. Paired members' messages are saved to it under their own names and consent; everyone in the group reads the lead's replies, so bind a group only where its whole audience may see that conversation. Unpaired members are told how to pair when they try a command; their other chatter is ignored. One group follows one conversation, and `/team off` stops it. Enable chat for the conversation once in Standing Orders before your first message; the group tells you if that is still needed.

A Ready result reaches your chat as a card with **Open result**. Ask the assistant to mark it complete and confirm the card; the phone asks once more before recording that you handled that exact result. Request changes the same way; the revision keeps the task's identity. Password approvals, cancelling and publishing still open the console.

## Boundaries of this release

Shared coordination uses existing task execution and approval controls. Direct native coding sessions remain private to the installation operator; team membership does not make the host filesystem or native provider login shareable. External agent wake adapters and automatic cross-lead delegation are not enabled. The paused external Codex watcher stays paused.

Conversation project scopes are fixed. Create a fresh conversation when the audience needs a different scope. Legacy coordinator ownership remains readable and can be explicitly transferred; legacy private history is not automatically turned into shared lead history.

The queue admits up to four conversations per runtime and two per lead. One conversation has one writer. Human messages take priority over recent automatic summaries; waiting summaries gain priority without interrupting active work. Budget exhaustion preserves queued messages. Changed provider terms need fresh consent. Unknown delivery blocks another writer until the recorded activity is inspected; a timeout never counts as permission to repeat work.

Shared updates consume existing assignment-status records with a durable cursor. Some older task producers still use bounded reconciliation, so this is delivery of recorded observations, not a guarantee that every intermediate task transition is captured. Browser streams carry cheap refresh hints. CLI follow uses bounded read polling. Neither is a scheduled model conversation.

See [the load measurements](team-leads-load.md) for the synthetic 10,000-task fixture and its network and browser limitations.
