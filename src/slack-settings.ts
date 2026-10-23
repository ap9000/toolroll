import type { Store } from "./store.js";
import { html, type Html } from "./html.js";
import { loadSlackCredentials } from "./slack-api.js";
import { chatSettingsHtml, type ChatSettingsOptions } from "./chat-settings-page.js";

export function slackSettingsHtml(store: Store, dir: string, options: ChatSettingsOptions = {}): Html {
  return chatSettingsHtml(store, dir, options, {
    provider: "slack",
    label: "Slack",
    credentials: loadSlackCredentials(dir),
    setup: html`<details open><summary>Create your Slack app</summary><ol><li>Download the <a href="/settings/slack/manifest">app manifest</a>, then <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer">create an app</a> in your workspace using that manifest.</li><li>Under Basic Information, create an app-level token with <code>connections:write</code>.</li><li>Under OAuth &amp; Permissions, install the app and copy its bot token.</li></ol></details>`,
    connect: password => html`<label>App token<input style="min-height:44px" type="password" name="app-token" autocomplete="off" placeholder="xapp-…" required></label><label>Bot token<input style="min-height:44px" type="password" name="bot-token" autocomplete="off" placeholder="xoxb-…" required></label>${password}<p class="meta">Tokens stay on this installation. Next, pair your own Slack account.</p><button type="submit">Connect Slack</button>`,
    access: html`<p>Private messages and threads use your Toolroll permissions. Shared channels are not supported. Secure review links use this installation’s configured HTTPS console address.</p><p>Socket Mode connects out to Slack. It does not need a public webhook or a Tailscale account.</p>`,
  });
}
