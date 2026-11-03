import { settingsSubPage } from "./settings-groups-ui.js";
import { loadPrimary } from "./webhooks.js";
import type { Store } from "./store.js";
import { html, joinHtml, type Html } from "./html.js";
import { ChatState, type ChatIdentity } from "./chat-delivery-state.js";
import { acts, btn, chip, codeLine, disclose, formRow, infoLine, input, note, notice, settingsSection } from "./server/kit.js";
import { kitSectionForm, SECRET_OPT_OUTS } from "./settings-kit.js";

export type ChatSettingsOptions = { code?: string; problem?: string; now?: Date; who?: string };

/** What differs between the Slack, Discord and Teams settings pages; everything else is one page. */
export type ChatSettingsPage = {
  provider: "slack" | "discord" | "teams";
  label: string;
  credentials: ChatIdentity | null;
  /** One sentence on what connecting gives, shown before it is connected. */
  intro: string;
  /** How to create the app, as list items, shown before it is connected. */
  steps: Html;
  /** The connect form's own fields (the password is the kit's). */
  fields: Html;
  /** One line under the connect fields. */
  fieldsNote: string;
  /** Where the pairing message is sent ("in a direct message to your Toolroll Slack app"). */
  pairWhere: string;
  /** What to try once paired. */
  tryLine: Html;
  /** Lines shown with the connection (the Teams messaging endpoint). */
  connection?: Html;
  /** The status words while connected and while waiting. */
  liveWords?: readonly [on: string, off: string];
  /** The "Access and setup" paragraphs, if any. */
  access?: Html;
};

/** A secret the connect form posts (an app or bot token, a client secret): masked, never given a value, kept out of
 * password managers. */
export function chatSecretRow(options: { id: string; name: string; label: string; placeholder?: string }): Html {
  return formRow(options.label, null, input({ id: options.id, name: options.name, type: "password",
    attrs: { autocomplete: "off", spellcheck: "false", "data-so-secret": true, ...SECRET_OPT_OUTS, required: true, placeholder: options.placeholder, "aria-label": options.label } }));
}

/** Settings → Slack, Discord or Teams: connect the app once, then each teammate pairs their own account. */
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
      runtime !== null &&
      runtime.leaseUntil !== null &&
      runtime.leaseUntil > now.toISOString() &&
      runtime.connected;
  const route = (action: string) => `/settings/${provider}/${action}`;
  const problem = options.problem ? notice(options.problem) : "";
  const access = page.access === undefined ? "" : disclose("Access and setup", page.access);
  const sections: Html[] = [];
  if (!credentials) {
    sections.push(
      settingsSection({ id: "setup", title: `1. Create the ${label} app`, body: page.steps }),
      settingsSection({ id: "connect", title: `2. Connect ${label}`,
        body: kitSectionForm({ proof: `${provider}-open`, action: route("connect"), id: "connect-form", save: { label: `Connect ${label}` },
          confirm: `Connect ${label}`, body: joinHtml([page.fields, note(page.fieldsNote)]) }) }),
      settingsSection({ id: "pair", title: "3. Pair your account", body: note(`Once ${label} is connected, pair your own account here.`) }),
    );
    return settingsSubPage("alerts", label, joinHtml([problem, ...sections, access]), { lead: page.intro });
  }
  const [onWords, offWords] = page.liveWords ?? ["Connected", "Waiting for connection"];
  sections.push(settingsSection({ id: "connection", title: credentials.workspace, state: html` ${chip(live ? onWords : offWords, live ? "done" : "")}`,
    body: joinHtml([
      page.connection ?? "",
      runtime?.problem ? notice(String(runtime.problem)) : "",
      !live && !runtime?.problem ? note(`Keep Toolroll's builder running to receive ${label} messages.`) : "",
      disclose("Connection settings", kitSectionForm({ proof: `${provider}-close`, action: route("disconnect"), id: "disconnect-form",
        save: { label: `Disconnect ${label}`, variant: "danger" }, confirm: `Disconnect ${label}`, body: html`` })),
    ]) }));
  const teammates = others ? `${others} teammate${others === 1 ? " is" : "s are"}` : "";
  if (options.code) {
    // The code shows once, on this page only: selectable text, never in a link or an address.
    sections.push(settingsSection({ id: "pair", title: "Pair your account", state: " · Code ready",
      lead: `Send this ${page.pairWhere}. It expires in 10 minutes.`,
      body: joinHtml([codeLine(`pair ${options.code}`), note("Once you've sent it, this page says your account is paired."),
        acts(btn("Check connection", { sm: true, href: `/settings/${provider}` }))]) }));
  } else if (binding && state.live(binding)) {
    const { pending, dropped: failed } = state.partCounts(binding.id);
    sections.push(settingsSection({ id: "pair", title: "Your account", state: " · Paired",
      lead: `Your ${label} account is paired.${teammates ? ` ${teammates} paired too.` : ""}`,
      body: joinHtml([
        pending ? infoLine(`${pending} ${pending === 1 ? "reply is" : "replies are"} waiting to send.`) : "",
        failed ? notice(`${failed} ${failed === 1 ? "reply" : "replies"} could not be delivered. Open the saved chat to recover them.`) : "",
        note(page.tryLine),
        acts(btn("Open saved chat", { sm: true, href: "/chat" })),
        loadPrimary(process.env, dir) === provider
          ? formRow("Task updates", null, html`<span>Sent here</span>`, "inline")
          : kitSectionForm({ proof: `${provider}-alerts`, action: route("alerts"), id: "alerts-form", save: { label: "Send task updates here", variant: "outline" },
              body: note(`Task updates aren't sent to ${label} now.`) }),
        kitSectionForm({ proof: `${provider}-close`, action: route("unpair"), id: "unpair-form", save: { label: "Unpair my account", variant: "danger" },
          confirm: `Unpair your ${label} account`, body: note("Unpairing ends every open button in your chat. Teammates are unaffected.") }),
      ]) }));
  } else {
    sections.push(settingsSection({ id: "pair", title: "Pair your account", state: " · Not paired",
      lead: `Your paired ${label} account can read your connected projects and confirm proposed changes. Password approvals still open in Toolroll.${teammates ? ` ${teammates} already paired.` : ""}`,
      body: kitSectionForm({ proof: `${provider}-open`, action: route("pair"), id: "pair-form", native: true, save: { label: "Create pairing code" },
        confirm: `Pair your ${label} account`, body: note("You get a one-time message to send to the app.") }) }));
  }
  return settingsSubPage("alerts", label, joinHtml([problem, ...sections, access]));
}
