import type { Store } from "./store.js";
import { html, type Html } from "./html.js";
import { loadDiscordCredentials } from "./discord-api.js";
import { chatSecretRow, chatSettingsHtml, type ChatSettingsOptions } from "./chat-settings-page.js";

export function discordSettingsHtml(store: Store, dir: string, options: ChatSettingsOptions = {}): Html {
  return chatSettingsHtml(store, dir, options, {
    provider: "discord",
    label: "Discord",
    credentials: loadDiscordCredentials(dir),
    intro: "Manage projects and review results in a private Discord conversation.",
    steps: html`<ol class="k-note"><li><a class="k-link" href="https://discord.com/developers/applications" target="_blank" rel="noopener noreferrer">Create an application</a>, then copy its token from the Bot page.</li><li>Keep the Interactions Endpoint URL empty and privileged intents off.</li><li>Under Installation, enable Guild Install with the bot scope and no server permissions. Use its install link to add it to your server, then open a direct message to the bot.</li></ol>`,
    fields: chatSecretRow({ id: "discord-bot-token", name: "bot-token", label: "Bot token" }),
    fieldsNote: "The token stays on this installation. Next, pair your own Discord account.",
    pairWhere: "in a direct message to your Toolroll Discord app",
    tryLine: html`Try “What needs my attention?” or “Show the evidence for the latest result.”`,
    access: html`<p class="k-note">Private messages and replies use your Toolroll permissions. Shared channels are not supported. Secure review links use this installation’s configured HTTPS console address.</p><p class="k-note">Toolroll connects out to Discord. It does not need a public webhook or a Tailscale account.</p>`,
  });
}
