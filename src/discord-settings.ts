import type { Store } from "./store.js";
import { html, type Html } from "./html.js";
import { loadDiscordCredentials } from "./discord-api.js";
import { chatSettingsHtml, type ChatSettingsOptions } from "./chat-settings-page.js";

export function discordSettingsHtml(store: Store, dir: string, options: ChatSettingsOptions = {}): Html {
  return chatSettingsHtml(store, dir, options, {
    provider: "discord",
    label: "Discord",
    credentials: loadDiscordCredentials(dir),
    setup: html`<details open><summary>Create your Discord app</summary><ol><li><a href="https://discord.com/developers/applications" target="_blank" rel="noopener noreferrer">Create an application</a>, then copy its token from the Bot page.</li><li>Keep the Interactions Endpoint URL empty and privileged intents off.</li><li>Under Installation, enable Guild Install with the bot scope and no server permissions. Use its install link to add it to your server, then open a direct message to the bot.</li></ol></details>`,
    connect: password => html`<label>Bot token<input style="min-height:44px" type="password" name="bot-token" autocomplete="off" required></label>${password}<p class="meta">The token stays on this installation. Next, pair your own Discord account.</p><button type="submit">Connect Discord</button>`,
    access: html`<p>Private messages and replies use your Toolroll permissions. Shared channels are not supported. Secure review links use this installation’s configured HTTPS console address.</p><p>The worker connects out to Discord. It does not need a public webhook or a Tailscale account.</p>`,
  });
}
