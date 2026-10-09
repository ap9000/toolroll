import { loadPrimary } from "./webhooks.js";
import type { Store } from "./store.js";
import { loadDiscordCredentials } from "./discord-api.js";
import { ChatState } from "./chat-delivery-state.js";
const escape = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export function discordSettingsHtml(
  store: Store,
  dir: string,
  csrf: string,
  options: { code?: string; problem?: string; now?: Date; who?: string } = {},
): string {
  const credentials = loadDiscordCredentials(dir),
    state = new ChatState(store, "discord"),
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
  const hidden = `<input type="hidden" name="csrf" value="${escape(csrf)}">`;
  const password =
    '<label>Your Toolroll password<input style="min-height:44px" type="password" name="password" autocomplete="current-password" required></label>';
  const post = (action: string, content: string) =>
    `<form method="post" action="/settings/discord/${action}" class="card">${hidden}${content}</form>`;
  let content = "";
  if (!credentials) {
    content =
      "<p>Manage projects and review results in a private Discord conversation.</p>" +
      '<details open><summary>Create your Discord app</summary><ol><li><a href="https://discord.com/developers/applications" target="_blank" rel="noopener noreferrer">Create an application</a>, then copy its token from the Bot page.</li><li>Keep the Interactions Endpoint URL empty and privileged intents off.</li><li>Under Installation, enable Guild Install with the bot scope and no server permissions. Use its install link to add it to your server, then open a direct message to the bot.</li></ol></details>' +
      post(
        "connect",
        '<label>Bot token<input style="min-height:44px" type="password" name="bot-token" autocomplete="off" required></label>' +
          password +
          '<p class="meta">The token stays on this installation. Next, pair your own Discord account.</p><button type="submit">Connect Discord</button>',
      );
  } else {
    content = `<p><strong>${escape(credentials.workspace)}</strong> · ${live ? "Connected" : "Waiting for connection"}</p>`;
    if (runtime?.problem)
      content += `<p role="status">${escape(String(runtime.problem))}</p>`;
    if (!live && !runtime?.problem)
      content +=
        "<p>Keep the Toolroll worker running to receive Discord messages.</p>";
    if (options.code) {
      content +=
        "<h2>Pair your account</h2><p>Send this in a direct message to your Toolroll Discord app. It expires in 10 minutes.</p>" +
        `<label>Pairing message<input type="text" readonly value="pair ${escape(options.code)}" autocomplete="off" style="width:100%;max-width:100%;font-size:14px;min-height:44px"></label>` +
        '<a class="button-link" style="min-height:44px;white-space:nowrap" href="/settings/discord">Check connection</a>';
    } else if (binding && state.live(binding)) {
      const { pending, dropped: failed } = state.partCounts(binding.id);
      content +=
        `<p>Your Discord account is paired.${others ? ` ${others} teammate${others === 1 ? " is" : "s are"} paired too.` : ""}${pending ? ` ${pending} replies waiting to send.` : ""}${failed ? ` ${failed} replies could not be delivered. Open the saved chat to recover them.` : ""}</p>` +
        "<p>Try “What needs my attention?” or “Show the evidence for the latest result.”</p>" +
        '<p><a href="/chat">Open saved chat</a></p>' +
        (loadPrimary(process.env, dir) === "discord"
          ? "<p>Task updates are sent here.</p>"
          : post(
              "alerts",
              '<button type="submit">Send task updates here</button>',
            ));
    } else {
      content += post(
        "pair",
        "<h2>Pair your account</h2><p>Your paired Discord account can read your connected projects and confirm proposed changes. Password approvals still open in Toolroll." +
          (others ? ` ${others} teammate${others === 1 ? " is" : "s are"} already paired.` : "") + "</p>" +
          password +
          '<button type="submit">Create pairing code</button>',
      );
    }
    if (binding && state.live(binding) && !options.code)
      content += post(
        "unpair",
        password + '<p class="meta">Unpairing ends every open button in your chat. Teammates are unaffected.</p><button type="submit">Unpair my account</button>',
      );
    content +=
      "<details><summary>Connection settings</summary>" +
      post(
        "disconnect",
        password + '<button type="submit">Disconnect Discord</button>',
      ) +
      "</details>";
  }
  return `<section style="max-width:42rem;overflow-wrap:anywhere"><p><a href="/settings">Settings</a></p><h1>Discord</h1>${options.problem ? `<p class="problem" role="alert">${escape(options.problem)}</p>` : ""}${content}<details><summary>Access and setup</summary><p>Private messages and replies use your Toolroll permissions. Shared channels are not supported. Secure review links use this installation’s configured HTTPS console address.</p><p>The worker connects out to Discord. It does not need a public webhook or a Tailscale account.</p></details></section>`;
}
