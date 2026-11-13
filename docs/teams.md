# Microsoft Teams

Connect Teams under **Settings → Teams**. Teams has no client-initiated connection: Microsoft delivers activities to an HTTPS endpoint, so the installation's public address must be reachable from the internet. A tailnet-only address is not; enable Tailscale Funnel (or another public tunnel) for `/teams/messages` before Microsoft can reach it.

1. In Azure, create an **Azure Bot** with a new single-tenant app registration. Note the app (client) id and directory (tenant) id, and create a client secret.
2. Set the bot's messaging endpoint to `https://your-public-address/teams/messages` and enable the **Microsoft Teams** channel.
3. In Toolroll, enter the app id, tenant id and secret with your password. The secret stays on this installation as an owner-only file.
4. Add the app to Teams. Each teammate then chooses **Create pairing code** and sends the displayed message to the bot in a personal chat. The code expires after ten minutes and works once; the chat answers as that person, under their own project access.

Every inbound activity is proved against the Bot Framework's signed token for this app id before it is saved: issuer, audience, expiry, published signing key and the service URL Microsoft named. The bearer token itself is never stored; only the conversation's service URL is remembered so replies can be sent.

In a personal chat, ask for tasks, status, results or a proposed change as in the console. `status`, `task <id>` and `help` answer from the database without a model. Proposed changes arrive as Adaptive Cards with **Confirm** and **Dismiss**; marking a result complete asks once more before it is recorded. Password approvals, cancellation and publishing still open the console.

A channel can follow one team conversation. Add the app to the team, then a conversation manager mentions the bot with `team` and `team <number>`; `team off` stops it. Teams delivers channel messages to the bot only when it is mentioned, so members write `@Toolroll …` to send into the conversation. Paired members' messages are saved under their own names and consent; the lead's replies and each reply's cards come back to the channel, where everyone can read them.

Incoming files are not supported yet. Saved result screenshots open from their links rather than being uploaded.
