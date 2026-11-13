# Slack

Connect a workspace under **Settings → Slack**. Use the supplied app manifest to create and install a custom Slack app, create an app-level token with `connections:write`, and enter that token and the bot token in the local setup form. Tokens are stored in a private file beside the database and never shown back.

Choose **Create pairing code**, then send the displayed message to the app in a direct message. The code expires after ten minutes and works once. The pairing identifies your workspace, Slack member, private conversation, and current Toolroll account. Disconnecting or changing account access invalidates it.

Ask for tasks, project skills, knowledge, MCP configuration, status, result evidence, or a proposed change. Slack uses the same saved assistant session and action records as the console. It uses the configured membership login; it does not grant API spending authority. An incompatible existing session must be ended in the console before Slack can start one.

The shared assistant can read a current brief from the local database and search bounded source excerpts or advisory import impact in your enrolled projects. These reads use the same tools as Telegram and the console; source search works without a refreshed index. Index refresh remains a local CLI action. The [shared tool matrix](TELEGRAM_ACTION_PARITY_2026-09-16.md) records coverage and gaps, including the new reads' unverified dedicated channel journeys.

- Ordinary changes have **Confirm** and **Dismiss** buttons. Irreversible decisions require a second confirmation.
- Password approvals, cancellation, acceptance, and other protected or long actions open the existing signed-in review screen. Their full terms remain available before confirmation.
- Result screenshots use their original verified bytes. Files are checked again before upload and sharing. A changed artifact is reported instead of sent.
- Reply in a result’s thread to keep feedback tied to that result. A thread containing multiple results asks you to choose one.
- Choose **Send task updates here** to make Slack the primary notification channel. It edits one progress message per result, showing completed steps, outstanding work, blockers, and publication status. Urgent decisions retain their own message. Telegram can still accept conversations while Slack receives updates.

Keep the normal Toolroll worker running. Socket Mode makes an outbound connection and reconnects after interruptions; it needs no public event endpoint. Review links use the installation’s configured HTTPS console address. Configure and verify that address for your own setup; no operator-specific Tailscale address is included.

The first Slack transport supports one paired person in private messages and threads per installation. It does not read shared channels, accept incoming file attachments, or distribute through the public Slack Marketplace. Each installation creates its own custom app. [Slack documents Socket Mode’s distribution limits](https://docs.slack.dev/apis/events-api/using-socket-mode/).

Incoming messages are saved before acknowledgement. Engine request receipts and action tokens prevent replaying a model request or applying a confirmed change twice. Replies retry with Slack’s rate-limit delay. A lost message acknowledgement can produce a duplicate message; its actions still apply once. Unsent replies expire after a day and remain visible as delivery failures in Settings; the assistant’s saved conversation remains available in the console.

Automated transport tests use scripted Slack responses. The browser proof labels its synthetic setup and checks actual desktop and phone-sized console viewports. These do not establish native Slack rendering or live workspace acceptance; finish that trial after connecting a workspace.

## Teammates and channels (2026-09-21)

Every teammate pairs their own Slack account from **Settings → Slack**; one person, one Slack identity, and unpairing yourself leaves everyone else connected. Send `status`, `task <id>` or `help` (with or without the slash) for a database-backed answer without a model turn.

A channel can follow one team conversation. Invite the app to the channel, then a conversation manager sends `team` there and `team <number>` to pick the conversation; `team off` stops it. Paired members' messages in that channel are saved to the conversation under their own names and spending consent, and the lead's replies, teammates' messages from other surfaces and each reply's cards are posted back to the channel. Everyone in the channel reads those replies, so follow a conversation only where its whole audience may see it. The reinstalled app manifest adds `channels:history`, `groups:history` and the matching read scopes. In a direct message, `team <number>` makes your DM talk in a conversation instead of your private assistant.

Marking a result complete confirms with a second tap on the card, as on Telegram; password approvals still open the console.

