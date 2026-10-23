import { loadPrimary } from "./webhooks.js";
import type { Store } from "./store.js";
import { html, postForm, type Html } from "./html.js";
import { ChatState, type ChatIdentity } from "./chat-delivery-state.js";

export type ChatSettingsOptions = { code?: string; problem?: string; now?: Date; who?: string };

/** What differs between the Slack and Discord settings pages; everything else is one page. */
export type ChatSettingsPage = {
  provider: "slack" | "discord";
  label: string;
  credentials: ChatIdentity | null;
  /** How to create the app, shown before it is connected. */
  setup: Html;
  /** The connect form's fields around the password. */
  connect: (password: Html) => Html;
  /** The "Access and setup" paragraphs. */
  access: Html;
};

/** Settings → Slack or Discord: connect the app once, then each teammate pairs their own account. */
export function chatSettingsHtml(
  store: Store,
  dir: string,
  options: ChatSettingsOptions,
  page: ChatSettingsPage,
): Html {
  const { provider, label, credentials } = page,
    state = new ChatState(store, provider),
    bindings = credentials ? state.bindings(credentials.installation).filter(one => state.live(one)) : [],
    binding = options.who === undefined ? null : bindings.find(one => one.approver === options.who) ?? null,
    others = bindings.length - (binding === null ? 0 : 1);
  const runtime = credentials ? state.runtime(credentials.installation) : null;
  const now = options.now ?? new Date(),
    live =
      runtime &&
      runtime.leaseUntil !== null &&
      runtime.leaseUntil > now.toISOString() &&
      runtime.connected;
  const password =
    html`<label>Your Toolroll password<input style="min-height:44px" type="password" name="password" autocomplete="current-password" required></label>`;
  const post = (action: string, content: Html) => postForm(`/settings/${provider}/${action}`, content, { attrs: { class: "card" } });
  const parts: Html[] = [];
  if (!credentials) {
    parts.push(
      html`<p>Manage projects and review results in a private ${label} conversation.</p>`,
      page.setup,
      post("connect", page.connect(password)),
    );
  } else {
    parts.push(html`<p><strong>${credentials.workspace}</strong> · ${live ? "Connected" : "Waiting for connection"}</p>`);
    if (runtime?.problem)
      parts.push(html`<p role="status">${String(runtime.problem)}</p>`);
    if (!live && !runtime?.problem)
      parts.push(html`<p>Keep the Toolroll worker running to receive ${label} messages.</p>`);
    if (options.code) {
      parts.push(
        html`<h2>Pair your account</h2><p>Send this in a direct message to your Toolroll ${label} app. It expires in 10 minutes.</p>`,
        html`<label>Pairing message<input type="text" readonly value="pair ${options.code}" autocomplete="off" style="width:100%;max-width:100%;font-size:14px;min-height:44px"></label>`,
        html`<a class="button-link" style="min-height:44px;white-space:nowrap" href="/settings/${provider}">Check connection</a>`,
      );
    } else if (binding && state.live(binding)) {
      const { pending, dropped: failed } = state.partCounts(binding.id);
      parts.push(
        html`<p>Your ${label} account is paired.${others ? ` ${others} teammate${others === 1 ? " is" : "s are"} paired too.` : ""}${pending ? ` ${pending} replies waiting to send.` : ""}${failed ? ` ${failed} replies could not be delivered. Open the saved chat to recover them.` : ""}</p>`,
        html`<p>Try “What needs my attention?” or “Show the evidence for the latest result.”</p>`,
        html`<p><a href="/chat">Open saved chat</a></p>`,
        loadPrimary(process.env, dir) === provider
          ? html`<p>Task updates are sent here.</p>`
          : post("alerts", html`<button type="submit">Send task updates here</button>`),
      );
    } else {
      parts.push(post(
        "pair",
        html`<h2>Pair your account</h2><p>Your paired ${label} account can read your connected projects and confirm proposed changes. Password approvals still open in Toolroll.${
          others ? ` ${others} teammate${others === 1 ? " is" : "s are"} already paired.` : ""}</p>${password}<button type="submit">Create pairing code</button>`,
      ));
    }
    if (binding && state.live(binding) && !options.code)
      parts.push(post(
        "unpair",
        html`${password}<p class="meta">Unpairing ends every open button in your chat. Teammates are unaffected.</p><button type="submit">Unpair my account</button>`,
      ));
    parts.push(html`<details><summary>Connection settings</summary>${post("disconnect", html`${password}<button type="submit">Disconnect ${label}</button>`)}</details>`);
  }
  return html`<section style="max-width:42rem;overflow-wrap:anywhere"><p><a href="/settings">Settings</a></p><h1>${label}</h1>${options.problem ? html`<p class="problem" role="alert">${options.problem}</p>` : ""}${parts}<details><summary>Access and setup</summary>${page.access}</details></section>`;
}
