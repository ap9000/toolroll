/** The person's own Telegram pairing, from the console: one private chat per
 * teammate with the installation's bot (v72). The bot token itself stays on
 * Chat apps and alerts; this page only mints or revokes the signed-in person's
 * pairing, never anyone else's. Laid out as three steps: token, pair, check. */
import { settingsSubPage } from "./settings-groups-ui.js";
import type { Store } from "./store.js";
import { html, joinHtml, postForm, type Html } from "./html.js";
import { acts, btn, codeLine, note, notice, settingsRecord, settingsSection } from "./server/kit.js";
import { kitSectionForm } from "./settings-kit.js";

/** How long a written reply may wait to be sent before it shows here with a Retry. */
export const UNSENT_REPLY_MS = 2 * 60_000;

export function telegramSettingsHtml(
  store: Store,
  botId: string | null,
  who: string,
  options: { code?: string; problem?: string; now?: Date } = {},
): Html {
  const problem = options.problem === undefined ? "" : notice(options.problem);
  const group = note(html`Each teammate pairs their own private chat. To connect a group, a conversation manager sends <code class="k-mono">/team</code> there and chooses a conversation. Everyone in the group can read its replies.`);
  if (botId === null) {
    return settingsSubPage("alerts", "Telegram", joinHtml([
      problem,
      settingsSection({ id: "telegram-bot", title: "1. Bot token", state: " · Not saved",
        lead: "No Telegram bot is connected yet. An approver saves the bot token first.",
        body: acts(btn("Open Chat apps and alerts", { sm: true, href: "/settings/alerts#telegram-token" })) }),
      settingsSection({ id: "telegram-pair", title: "2. Pair your phone", body: note("Once the bot token is saved, pair your phone here.") }),
      group,
    ]));
  }
  const bindings = store.liveTelegramBindings(botId);
  const mine = bindings.filter(binding => binding.approver === who);
  const others = bindings.length - mine.length;
  const paired = mine.length > 0;
  const teammates = others === 0 ? "No teammates are paired yet." : `${others} teammate${others === 1 ? " is" : "s are"} paired.`;
  const bot = settingsSection({ id: "telegram-bot", title: "1. Bot token", state: " · Saved",
    body: note(html`Saved on <a class="k-link" href="/settings/alerts#telegram-token">Chat apps and alerts</a>.`) });

  let pair: Html;
  let check: Html;
  if (options.code !== undefined) {
    // The code shows once, on this page only: selectable text, never in a link or an address.
    pair = settingsSection({ id: "telegram-pair", title: "2. Pair your phone", state: " · Code ready",
      lead: "Send this to the bot in a private Telegram chat within 10 minutes:",
      body: joinHtml([codeLine(`/pair ${options.code}`), note("The code works once. That chat then answers as you, so treat it like your sign-in.")]) });
    check = settingsSection({ id: "telegram-check", title: "3. Check it works",
      lead: "Once you've sent it, this page says your phone is paired.",
      body: acts(btn("Check connection", { sm: true, href: "/settings/telegram" })) });
  } else {
    pair = settingsSection({ id: "telegram-pair", title: "2. Pair your phone", state: paired ? " · Paired" : " · Not paired",
      lead: `${paired ? "Your phone is paired." : "Your phone is not paired."} ${teammates}`,
      body: paired
        ? kitSectionForm({ proof: "telegram-unpair", action: "/settings/telegram/unpair", id: "telegram-unpair-form", save: { label: "Unpair my phone", variant: "danger" },
            confirm: "Unpair your phone from Telegram", body: note("This phone will lose access. Its existing Telegram buttons will stop working.") })
        : kitSectionForm({ proof: "telegram-pair", action: "/settings/telegram/pair", id: "telegram-pair-form", native: true, save: { label: "Pair my phone" },
            confirm: "Pair your phone with Telegram", body: note("You get a one-time code to send to the bot.") }) });
    // A reply the assistant wrote that has not reached this person's phone for two minutes.
    const unsent = store.unsentTelegramReplies(botId, who, new Date((options.now ?? new Date()).getTime() - UNSENT_REPLY_MS));
    const oldest = unsent[0];
    check = settingsSection({ id: "telegram-check", title: "3. Check it works",
      lead: paired ? html`In your private chat with the bot, send <code class="k-mono">/status</code>. It answers without an AI model.` : "Pair your phone first.",
      body: oldest === undefined ? "" : settingsRecord({
        title: unsent.length === 1 ? html`A reply hasn't reached your phone` : html`${unsent.length} replies haven't reached your phone`,
        sub: `Trying since ${oldest.since.slice(11, 16)} UTC${oldest.error === null ? "" : `: ${oldest.error}`}`,
        action: postForm("/settings/telegram/retry", btn("Retry", { sm: true, type: "submit" })),
        attrs: { role: "status", "data-unsent-replies": true },
      }) });
  }
  return settingsSubPage("alerts", "Telegram", joinHtml([problem, bot, pair, check, group]));
}
