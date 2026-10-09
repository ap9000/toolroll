/** Settings → Teams: connect the Entra app once (operator), then each
 * teammate pairs their own Teams account. The messaging endpoint the bot
 * registration must point at is shown here; it has to be reachable from the
 * internet, which a tailnet-only address is not. */
import type { Store } from "./store.js";
import { html, joinHtml, postForm, type Html } from "./html.js";
import { ChatState } from "./chat-delivery-state.js";
import { loadTeamsCredentials } from "./teams-api.js";
import { loadPrimary } from "./webhooks.js";
import { TEAMS_MESSAGES_PATH } from "./teams.js";

export function teamsSettingsHtml(store: Store, dir: string, options: { code?: string; problem?: string; now?: Date; who?: string; publicUrl?: string | null } = {}): Html {
  const credentials = loadTeamsCredentials(dir), state = new ChatState(store, "teams");
  const bindings = credentials ? state.bindings(credentials.installation).filter(one => state.live(one)) : [];
  const binding = options.who === undefined ? null : bindings.find(one => one.approver === options.who) ?? null;
  const others = bindings.length - (binding === null ? 0 : 1);
  const runtime = credentials ? state.db.prepare("SELECT connected,problem,lease_until FROM teams_runtime WHERE installation=?").get(credentials.installation) : null;
  const now = options.now ?? new Date();
  const live = runtime && typeof runtime.lease_until === "string" && runtime.lease_until > now.toISOString() && runtime.connected;
  const password = html`<label>Your Toolroll password<input style="min-height:44px" type="password" name="password" autocomplete="current-password" required></label>`;
  const post = (action: string, content: Html) => postForm(`/settings/teams/${action}`, content, { attrs: { class: "card" } });
  const endpoint = options.publicUrl ? `${options.publicUrl.replace(/\/$/, "")}${TEAMS_MESSAGES_PATH}` : null;
  const parts: Html[] = [];
  if (!credentials) {
    parts.push(
      html`<p>Manage projects and review results in a Teams chat, and let a channel follow a team conversation.</p>`,
      html`<details open><summary>Register the bot</summary><ol><li>In <a href="https://portal.azure.com" target="_blank" rel="noopener noreferrer">Azure</a>, create an <em>Azure Bot</em> with a new single-tenant app registration; note the app (client) id and the directory (tenant) id, and create a client secret.</li>`,
      html`<li>Set its messaging endpoint to <code>${endpoint === null ? "https://your-public-address" + TEAMS_MESSAGES_PATH : endpoint}</code>. Microsoft must reach it from the internet: a tailnet-only address needs Tailscale Funnel (or another public tunnel) on that path.</li>`,
      html`<li>Enable the Microsoft Teams channel on the bot, then add the app to Teams (personal scope; team scope for channels).</li></ol></details>`,
      post("connect", joinHtml([
        html`<label>App (client) id<input style="min-height:44px" type="text" name="app-id" autocomplete="off" required></label>`,
        html`<label>Directory (tenant) id<input style="min-height:44px" type="text" name="tenant" autocomplete="off" required></label>`,
        html`<label>Client secret<input style="min-height:44px" type="password" name="secret" autocomplete="off" required></label>`,
        html`${password}<p class="meta">The secret stays on this installation. Next, pair your own Teams account.</p><button type="submit">Connect Teams</button>`])));
  } else {
    parts.push(html`<p><strong>Microsoft Teams</strong> · ${live ? "Signed in" : "Waiting for sign-in"}</p>`);
    if (endpoint !== null) parts.push(html`<p class="meta">Messaging endpoint: <code>${endpoint}</code> — must be reachable from the internet.</p>`);
    if (runtime?.problem) parts.push(html`<p role="status">${String(runtime.problem)}</p>`);
    if (!live && !runtime?.problem) parts.push(html`<p>Keep the Toolroll worker running to answer Teams messages.</p>`);
    if (options.code) {
      parts.push(html`<h2>Pair your account</h2><p>Send this to the Toolroll bot in a personal Teams chat. It expires in 10 minutes.</p>`,
        html`<label>Pairing message<input type="text" readonly value="pair ${options.code}" autocomplete="off" style="width:100%;max-width:100%;font-size:14px;min-height:44px"></label>`,
        html`<a class="button-link" style="min-height:44px;white-space:nowrap" href="/settings/teams">Check connection</a>`);
    } else if (binding && state.live(binding)) {
      parts.push(html`<p>Your Teams account is paired.${others ? ` ${others} teammate${others === 1 ? " is" : "s are"} paired too.` : ""}</p>`,
        html`<p>Try “What needs my attention?” or send <code>status</code>. In a channel, mention the bot with <code>team</code> to follow a conversation.</p>`,
        html`<p><a href="/chat">Open saved chat</a></p>`,
        loadPrimary(process.env, dir) === "teams" ? html`<p>Task updates are sent here.</p>` : post("alerts", html`<button type="submit">Send task updates here</button>`),
        post("unpair", html`${password}<p class="meta">Unpairing ends every open button in your chat. Teammates are unaffected.</p><button type="submit">Unpair my account</button>`));
    } else {
      parts.push(post("pair", html`<h2>Pair your account</h2><p>Your paired Teams account can read your connected projects and confirm proposed changes. Password approvals still open in Toolroll.${
        others ? ` ${others} teammate${others === 1 ? " is" : "s are"} already paired.` : ""}</p>${password}<button type="submit">Create pairing code</button>`));
    }
    parts.push(html`<details><summary>Connection settings</summary>${post("disconnect", html`${password}<button type="submit">Disconnect Teams</button>`)}</details>`);
  }
  return html`<section style="max-width:42rem;overflow-wrap:anywhere"><p><a href="/settings">Settings</a></p><h1>Teams</h1>${options.problem ? html`<p class="problem" role="alert">${options.problem}</p>` : ""}${parts}</section>`;
}
