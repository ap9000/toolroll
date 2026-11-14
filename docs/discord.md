# Discord

Open **Settings → Discord**. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications), copy its bot token, and enter it in the setup form with your Toolroll password. The token stays in a private file on this installation and is never shown back.

Keep the app’s **Interactions Endpoint URL** empty so buttons arrive over the Gateway connection. Leave privileged intents off. Enable **Guild Install**, with the **bot** scope and no server permissions, and install it in a server you manage. Open a direct message to the bot from its member profile. If Discord refuses the conversation, allow direct messages for that server.

Choose **Create pairing code** and send the displayed message to the bot. It expires in ten minutes and works once. Your paired Discord account can read your connected projects and confirm proposed changes using your current Toolroll permissions. Disconnecting or changing account access invalidates the pairing.

Ask about tasks, projects, skills, knowledge, MCP servers, results or evidence. Discord uses the same saved assistant, project access, proposals and history as the console, Slack and Telegram. It uses your configured membership login and does not grant API spending authority.

- Ordinary proposals show **Confirm** and **Dismiss**. Irreversible answers need a second confirmation.
- Protected actions and long approval terms open their existing signed-in review screen. No password or bot token belongs in the conversation.
- Reply directly to a result message to keep feedback tied to that exact result. A reply containing several results asks you to choose one.
- Screenshots are checked against their saved evidence hash immediately before upload. Changed or oversized files give a clear explanation and a result link.
- **Send task updates here** makes Discord the primary notification channel. Routine progress updates edit one message per result. Urgent decisions get a separate message. Other connected services can still accept conversations.

The ordinary worker maintains one leased outbound Gateway connection with Toolroll's own small Gateway client (it resumes after a dropped connection and stops retrying when Discord rejects the bot token or the Message Content intent; Settings says which). It requests the Direct Messages, Guild Messages and Message Content intents, validates the app and bot on READY, and saves normalized incoming events before doing model work. Button interactions are saved before their immediate acknowledgement; the interaction credential is never stored. No public webhook or Tailscale account is required. Review links use this installation’s configured HTTPS console address.

Messages, proposals and pending sends have durable receipts. Duplicate inbound events do not repeat model requests or changes. Rate limits delay saved replies. Uncertain sends reconcile recent Discord nonce receipts and update the recovered message; Discord also deduplicates new sends by nonce for a limited time. A lost receipt outside that window or the latest 100-message history can still duplicate a message. Its confirmed action still applies once. Unsent replies expire after a day and remain visible as delivery failures in Settings; the saved assistant conversation remains available in the console.

The first Discord transport supports **one paired person in a private bot DM per installation**. Server channels, group DMs, incoming attachments, slash commands and public app distribution are outside this release. Messages missed while the worker is offline may need to be sent again; this does not claim an offline Gateway archive. Each installation connects its own app.

Automated Discord responses and model replies are scripted. Browser evidence covers the actual console at desktop and phone-sized Chrome viewports, including empty setup, failure, long names, acceptance and feedback creating an unapproved revision. It does not establish native Discord rendering or physical-phone acceptance. A live trial follows connection of a real app.

Protocol references: [Gateway and intents](https://docs.discord.com/developers/events/gateway), [interaction acknowledgement](https://docs.discord.com/developers/interactions/receiving-and-responding), and [message nonces and attachments](https://docs.discord.com/developers/resources/message).

## Teammates and channels (2026-09-21)

Every teammate pairs their own Discord account from **Settings → Discord**; unpairing yourself leaves everyone else connected. Send `status`, `task <id>` or `help` for a database-backed answer without a model turn.

A server channel can follow one team conversation: add the app to the server with the **Message Content** intent enabled, then a conversation manager sends `team` in the channel and `team <number>` to pick the conversation; `team off` stops it. Paired members' messages there are saved to the conversation under their own names and consent, and replies and cards come back to the channel. Marking a result complete confirms with a second tap on the card.

