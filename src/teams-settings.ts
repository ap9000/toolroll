/** Settings → Teams: connect the Entra app once (operator), then each
 * teammate pairs their own Teams account. The messaging endpoint the bot
 * registration must point at is shown here; it has to be reachable from the
 * internet, which a tailnet-only address is not. One page with Slack and
 * Discord (chat-settings-page.ts). */
import type { Store } from "./store.js";
import { html, joinHtml, type Html } from "./html.js";
import { loadTeamsCredentials } from "./teams-api.js";
import { TEAMS_MESSAGES_PATH } from "./teams.js";
import { formRow, input } from "./server/kit.js";
import { chatSecretRow, chatSettingsHtml } from "./chat-settings-page.js";

export function teamsSettingsHtml(store: Store, dir: string, options: { code?: string; problem?: string; now?: Date; who?: string; publicUrl?: string | null } = {}): Html {
  const endpoint = options.publicUrl ? `${options.publicUrl.replace(/\/$/, "")}${TEAMS_MESSAGES_PATH}` : null;
  const text = (id: string, name: string, label: string) =>
    formRow(label, null, input({ id, name, attrs: { autocomplete: "off", spellcheck: "false", required: true, "aria-label": label } }));
  const { code, problem, now, who } = options;
  return chatSettingsHtml(store, dir, { ...(code === undefined ? {} : { code }), ...(problem === undefined ? {} : { problem }), ...(now === undefined ? {} : { now }), ...(who === undefined ? {} : { who }) }, {
    provider: "teams",
    label: "Teams",
    credentials: loadTeamsCredentials(dir),
    intro: "Manage projects and review results in a Teams chat, and let a channel follow a team conversation.",
    steps: html`<ol class="k-note"><li>In <a class="k-link" href="https://portal.azure.com" target="_blank" rel="noopener noreferrer">Azure</a>, create an <em>Azure Bot</em> with a new single-tenant app registration; note the app (client) id and the directory (tenant) id, and create a client secret.</li>\
<li>Set its messaging endpoint to <code class="k-mono">${endpoint === null ? "https://your-public-address" + TEAMS_MESSAGES_PATH : endpoint}</code>. Microsoft must reach it from the internet: a tailnet-only address needs Tailscale Funnel (or another public tunnel) on that path.</li>\
<li>Enable the Microsoft Teams channel on the bot, then add the app to Teams (personal scope; team scope for channels).</li></ol>`,
    fields: joinHtml([
      text("teams-app-id", "app-id", "App (client) id"),
      text("teams-tenant", "tenant", "Directory (tenant) id"),
      chatSecretRow({ id: "teams-secret", name: "secret", label: "Client secret" }),
    ]),
    fieldsNote: "The secret stays on this installation. Next, pair your own Teams account.",
    pairWhere: "to the Toolroll bot in a personal Teams chat",
    tryLine: html`Try “What needs my attention?” or send <code class="k-mono">status</code>. In a channel, mention the bot with <code class="k-mono">team</code> to follow a conversation.`,
    liveWords: ["Signed in", "Waiting for sign-in"],
    ...(endpoint === null ? {} : { connection: html`<p class="k-note">Messaging endpoint, reachable from the internet: <code class="k-mono">${endpoint}</code></p>` }),
  });
}
