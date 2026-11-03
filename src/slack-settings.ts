import type { Store } from "./store.js";
import { html, joinHtml, type Html } from "./html.js";
import { loadSlackCredentials } from "./slack-api.js";
import { chatSecretRow, chatSettingsHtml, type ChatSettingsOptions } from "./chat-settings-page.js";

export function slackSettingsHtml(store: Store, dir: string, options: ChatSettingsOptions = {}): Html {
  return chatSettingsHtml(store, dir, options, {
    provider: "slack",
    label: "Slack",
    credentials: loadSlackCredentials(dir),
    intro: "Manage projects and review results in a private Slack conversation.",
    steps: html`<ol class="k-note"><li>Download the <a class="k-link" href="/settings/slack/manifest">app manifest</a>, then <a class="k-link" href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer">create an app</a> in your workspace using that manifest.</li><li>Under Basic Information, create an app-level token with <code class="k-mono">connections:write</code>.</li><li>Under OAuth &amp; Permissions, install the app and copy its bot token.</li></ol>`,
    fields: joinHtml([
      chatSecretRow({ id: "slack-app-token", name: "app-token", label: "App token", placeholder: "xapp-…" }),
      chatSecretRow({ id: "slack-bot-token", name: "bot-token", label: "Bot token", placeholder: "xoxb-…" }),
    ]),
    fieldsNote: "Tokens stay on this installation. Next, pair your own Slack account.",
    pairWhere: "in a direct message to your Toolroll Slack app",
    tryLine: html`Try “What needs my attention?” or “Show the evidence for the latest result.”`,
    access: html`<p class="k-note">Private messages and threads use your Toolroll permissions. Shared channels are not supported. Secure review links use this installation’s configured HTTPS console address.</p><p class="k-note">Socket Mode connects out to Slack. It does not need a public webhook or a Tailscale account.</p>`,
  });
}
