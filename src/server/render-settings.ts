/** Settings pages: the settings home, lead, capabilities and their cards. */
import { ACCENT_PRESETS,DEFAULT_ACCENT } from "../accent-colors.js";
import { type BrandIconId } from "../brand-icons.js";
import { brandIconHtml } from "../brand-mark.js";
import { type BrowserPhoneCard,type BrowserSettingsGroup,type BrowserSettingsView,type BrowserUpdates } from "../browser-workspace.js";
import { connectionWords } from "../control-ui.js";
import { isSubscriptionChatProvider,PRICED_MODELS } from "../converse.js";
import { digestTimes } from "../digest-times.js";
import { describeCapability,type Gap } from "../gaps.js";
import { ABOUT_YOU_LINE_MAX,ABOUT_YOU_MAX_LINES } from "../lead-about.js";
import { LEAD_NAME_MAX,LEAD_PERSONA_MAX,type LeadIdentity } from "../lead-identity.js";
import { projectName } from "../project.js";
import { type ProviderConnection } from "../provider-connection.js";
import { type ProviderId } from "../provider.js";
import { type QualityMode,qualityModeTitle } from "../quality.js";
import { latestVersionNow } from "../releases.js";
import { RESULT_SHOT_CHOICES } from "../result-shots.js";
import { isAlive as runnerAlive } from "../runner.js";
import { type UnattendedPermissionMode } from "../scope.js";
import { ASSISTANTS } from "../setup-guide.js";
import { type Capability,type ChatConfig,type PushSubscription,type ResultScreenshots,type Store } from "../store.js";
import { redactToken,TOKEN_ENV,type TokenSource } from "../telegram.js";
import { requestContext } from "./request-context.js";
import { chatMoney,type Chrome,screen,type Screen,strokeIcon,when,whenTime } from "./chrome.js";
import { taskHref } from "./http.js";
import { html,joinHtml,postForm,type Html } from "../html.js";
import { permissionModeChoices,qualityModeChoices } from "./render-tasks.js";

/** What the lead's settings form shows beside the saved configuration: where keys come from (never the keys), the
 * live model lists, and where saving goes back to. */
export type LeadFormFacts = {
  keyFacts: { provider: string; state: "environment" | "stored" | "none"; tail: string | null }[];
  openrouterModels: string[] | null;
  liveModels?: { value: string; label: string }[];
  /** Unused: postForm writes the request's CSRF field (kept for callers). */
  csrf: string;
  returnTo: string;
};

/** Settings → Lead: one line for what runs the lead and one action; the full form, turning it off and stored keys under Advanced. */
export function leadSettingsHtml(data: { config: import("../store.js").ChatConfig | null; facts: LeadFormFacts; words: string | null; signedIn: string | null; command: string; said: string | null;
  saved?: boolean; identity?: LeadIdentity;
  about?: string[]; aboutSaved?: boolean;
  promises?: { id: number; what: string; when: string; until: string }[] }): Html {
  const { config, facts } = data;
  const returnTo = "/settings/lead";
  const summary = config === null
    ? data.signedIn !== null
      ? html`<p>The lead is off.</p>${postForm("/settings/lead/on", html`<button type="submit">Use your ${data.signedIn} sign-in</button>`, { returnTo })}`
      : html`<p>The lead is off. Sign in an agent on this computer to turn it on:</p><p><code>${data.command}</code></p>`
    : data.words !== null
      ? html`<p>The lead uses ${data.words}.</p><p class="meta">${config.model === "default" ? "Its default model" : `Model ${config.model}`} · up to ${config.dailyTurns} turns a day · no dollar spend. Every action it proposes waits for you to confirm it.</p>`
      : html`<p>The lead uses the ${config.provider === "anthropic-api" ? "Anthropic" : "OpenRouter"} API with ${config.model}.</p><p class="meta">Up to ${chatMoney(config.weeklyCeilingMicrousd)} a week · up to ${config.dailyTurns} turns a day.</p>`;
  const forget = facts.keyFacts.filter(one => one.state === "stored").map(one =>
    postForm("/chat/config", html`<input type="password" name="token" placeholder="your password" autocomplete="current-password" aria-label="Your password"><button type="submit" class="secondary">Forget the stored ${one.provider} key</button>`,
      { attrs: { class: "inline" }, returnTo, hidden: { "forget-key": one.provider } }));
  return joinHtml([
    html`<p><a href="/settings">Settings</a></p><h1>Lead</h1>`,
    data.said === null ? "" : html`<p class="problem" role="status">${data.said}</p>`,
    html`<section class="card lead-settings" data-lead-settings>${summary}</section>`,
    data.identity === undefined ? "" : postForm("/settings/lead/identity", html`\
<label>Name your lead<input name="name" value="${data.identity.name}" maxlength="${LEAD_NAME_MAX}" autocomplete="off" required></label>\
<label>Persona<textarea name="persona" rows="4" maxlength="${LEAD_PERSONA_MAX}">${data.identity.persona}</textarea></label>\
<button type="submit">Save</button>${data.saved === true ? html` <span class="meta" role="status">Saved.</span>` : ""}`, { attrs: { class: "card lead-identity", "data-lead-identity": true } }),
    // What the lead knows about this person: lines they confirmed in chat or wrote here. Every project, every chat.
    data.about === undefined ? "" : postForm("/settings/lead/about", html`\
<label>What your lead knows about you<textarea name="about" rows="${Math.min(10, Math.max(4, data.about.length + 1))}" maxlength="${ABOUT_YOU_MAX_LINES * (ABOUT_YOU_LINE_MAX + 1)}" placeholder="Keep copy terse.&#10;I test changes myself.">${data.about.join("\n")}</textarea></label>\
<p class="meta">One per line, up to ${ABOUT_YOU_MAX_LINES}.</p>\
<button type="submit">Save</button>${data.aboutSaved === true ? html` <span class="meta" role="status">Saved.</span>` : ""}`, { attrs: { class: "card lead-about", "data-lead-about": true } }),
    // What the lead promised to follow up on; it reports each once, here in chat, and drops it after 7 days.
    (data.promises ?? []).length === 0 ? "" : html`<section class="card lead-promises" data-lead-promises><h2>Promises</h2><ul class="lead-promise-list">${data.promises!.map(one =>
      html`<li data-promise="${one.id}"><p>${one.what}</p><p class="meta">${one.when.charAt(0).toUpperCase() + one.when.slice(1)} · <span class="nowrap">until ${new Date(one.until).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}</span></p>\
${postForm("/settings/lead/promise/cancel", html`<button type="submit" class="secondary">Cancel</button>`, { attrs: { class: "inline" }, returnTo, hidden: { promise: one.id } })}</li>`)}</ul></section>`,
    html`<details class="lead-advanced" data-lead-advanced><summary>Advanced</summary>`,
    leadConfigForm(config, facts),
    config === null ? "" : postForm("/chat/config", html`<input type="password" name="token" placeholder="your password" autocomplete="current-password" aria-label="Your password"><button type="submit" class="secondary">Turn the lead off</button>`,
      { attrs: { class: "inline" }, returnTo, hidden: { off: "1" } }),
    forget,
    html`</details>`,
  ], "\n");
}

/** The lead's full settings (Settings → Lead → Advanced): provider, model, limits and a direct API key. */
export function leadConfigForm(current: import("../store.js").ChatConfig | null, data: LeadFormFacts): Html {
  const anthropicModels = PRICED_MODELS.filter(one => !one.includes("/"));
  const openrouterModels = data.openrouterModels ?? PRICED_MODELS.filter(one => one.includes("/"));
  const currentSubscription = current !== null && isSubscriptionChatProvider(current.provider);
  const labels = new Map((data.liveModels ?? []).map(one => [one.value, one.label]));
  const models = [...new Set(["default", ...labels.keys(), ...anthropicModels, ...openrouterModels, ...(current === null ? [] : [current.model])])];
  return joinHtml([
    postForm("/chat/config", joinHtml([
      "",
      html`<label>Provider<select name="provider">`,
      html`<option value="codex-subscription"${current?.provider === "codex-subscription" ? " selected" : ""}>Codex membership (logged-in CLI)</option>`,
      html`<option value="claude-subscription"${current?.provider === "claude-subscription" ? " selected" : ""}>Anthropic membership (logged-in CLI)</option>`,
      html`<option value="anthropic-api"${current?.provider === "anthropic-api" ? " selected" : ""}>anthropic-api (direct API)</option>`,
      html`<option value="openrouter-api"${current?.provider === "openrouter-api" ? " selected" : ""}>openrouter-api (direct API)</option>`,
      html`</select></label>`,
      html`<label>Model <span class="meta">(use default for your membership's current model; direct API models need a pinned price)</span>\
<input name="model" list="chat-models" value="${current?.model ?? "default"}"><datalist id="chat-models">\
${models.map(model => html`<option value="${model}">${labels.get(model) ?? ""}</option>`)}</datalist></label>`,
      data.openrouterModels === null
        ? html`<p class="meta">With OPENROUTER_API_KEY in the serve environment, this list becomes OpenRouter's full live catalog — each model priced by the party that bills it</p>`
        : html`<p class="meta">${data.openrouterModels.length} models live from OpenRouter's catalog; saving pins today's price — re-save to re-pin</p>`,
      currentSubscription
        ? html`<p class="meta"><strong>No dollar maximum.</strong> Membership chat uses the plan attached to the logged-in CLI; the conversation stays live until you end it, and the daily turn limit still applies.</p>`
        : html`<label>Weekly ceiling <span class="meta">(direct API only; leave blank when choosing a membership)</span>\
<input type="text" name="weekly-usd" inputmode="decimal" style="width:8rem" value="${current === null ? "" : (current.weeklyCeilingMicrousd / 1_000_000).toFixed(2)}"></label>`,
      html`<label>Daily turns <span class="meta">(default 50)</span>\
<input type="text" name="daily-turns" inputmode="numeric" style="width:8rem" value="${current === null ? "" : String(current.dailyTurns)}"></label>`,
      currentSubscription
        ? html`<p class="meta">Authenticate on this machine first with ${current?.provider === "codex-subscription" ? html`<span class="mono">codex login</span>` : html`the <span class="mono">claude</span> CLI`}. Toolroll reuses that cached login and never stores it.</p>`
        : html`<label>API key <span class="meta">(${data.keyFacts
          .map(one =>
            one.state === "none"
              ? `${one.provider}: none yet`
              : one.state === "environment"
                ? `${one.provider}: from the environment`
                : `${one.provider}: stored ${one.tail ?? ""}`,
          )
          .join(" · ")})</span>\
<input type="password" name="key" placeholder="direct API only — leave empty to keep" autocomplete="off"></label>`,
      html`<label>Your password <span class="meta">(typed again to change the provider)</span>\
<input type="password" name="token" autocomplete="current-password"></label>`,
      html`<button type="submit">${current === null ? "turn chat on" : "save"}</button>`,
      "",
    ], "\n"), { attrs: { class: "card" }, returnTo: data.returnTo }),
    currentSubscription
      ? html`<p class="meta">The membership provider runs without repository tools in a temporary directory; Toolroll remains the only layer that can turn a proposed action into a confirmation card.</p>`
      : html`<p class="meta">A pasted key is written once to a mode-0600 file beside the database — never INTO the database, never shown again beyond its last characters; an environment variable (\
<span class="mono">ANTHROPIC_API_KEY</span> / <span class="mono">OPENROUTER_API_KEY</span>) always wins when set</p>`,
  ], "\n");
}

export function capsPage(chrome: Chrome, caps: Capability[] | null, gaps: Gap[], repo: string, now?: Date): Screen {
  if (caps === null) {
    return screen("requirements", joinHtml([
      html`<h1>Requirements</h1>`,
      html`<p class="meta">Open a project to see its requirements — <a href="/projects">projects</a></p>`,
    ], "\n"), { chrome });
  }
  const list =
    caps.length === 0
      ? html`<p>Nothing recorded.</p>`
      : joinHtml(caps
          .map(
            capability =>
              html`<p class="row">${capability.kind}:${capability.name} — \
${describeCapability(capability, now ?? new Date())}</p>`,
          ), "\n");
  const blocked =
    gaps.length === 0
      ? html`<p class="meta">No gaps — everything recorded is verified</p>`
      : joinHtml(gaps
          .map(
            gap =>
              html`<div class="card"><p>${gap.key} — ${gap.state}</p>\
<p class="meta">${
                gap.unblocks.length > 0
                  ? `fills → ${gap.unblocks.length} task(s) start: ${gap.unblocks.join(", ")}`
                  : gap.alsoBlocks.length > 0
                    ? `part of what holds: ${gap.alsoBlocks.join(", ")}`
                    : "nothing queued needs it yet"
              }</p>\
<p class="meta">Verify: ${gap.verify}</p>\
<p class="meta">${gap.instructions}</p></div>`,
          ), "\n");
  return screen("requirements", joinHtml([
    html`<h1>Requirements</h1>`,
    html`<p class="hint">tools and credentials builds need — each is probed on the worker before any build spends money; values never leave your machine</p>`,
    list,
    html`<h2>Missing, ranked by what filling them frees</h2>`,
    blocked,
    html`<p class="meta">Read-only here: checks are shell commands you wrote, and a web button that runs shell would need its own security review</p>`,
  ], "\n"), { chrome });
}

/** Whether the bot's saved delivery state reports a problem (no new check runs). */
export function telegramTrouble(store: Store, bot: TokenSource | null): boolean {
  return bot !== null && (store.telegramPush(bot.botId)?.problem ?? null) !== null;
}

/** v98: how the bot's messages reach Toolroll, in words: pushed to the public address, or asked for. */
export function telegramDeliveryWords(store: Store, bot: TokenSource | null): string | null {
  if (bot === null) return null;
  const state = store.telegramPush(bot.botId);
  if (state?.url) return `Telegram pushes new messages to ${state.url}${state.problem === null ? "." : `, but ${state.problem.charAt(0).toLowerCase()}${state.problem.slice(1)}.`}`;
  return `Toolroll asks Telegram for new messages every few seconds${state?.problem ? ` (${state.problem})` : ""}.`;
}

/** The projects this person can see, by name, and whether they muted each one's pings. */
export function notificationProjects(store: Store, account: string): { repo: string; name: string; muted: boolean }[] {
  const muted = new Set(store.mutedProjects(account));
  return store.listProjects().filter(one => store.accountCanAccess(account, one.path))
    .map(one => ({ repo: one.path, name: one.name, muted: muted.has(one.path) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function settingsPage(
  chrome: Chrome,
  existing: TokenSource | null,
  hasEnv: boolean,
  csrf: string,
  problem: string | null,
  messaging: { channel: string | null; implicit: boolean; configured: string[]; legacyWarning?: string } | null = null,
  push: { available: boolean; devices: PushSubscription[] } | null = null,
  providerKeys: { provider: string; envName: string; set: boolean; updatedAt: string | null; ambient: boolean; mode: "subscription" | "api-key"; subscriptionCapable: boolean; connection?: ProviderConnection }[] | null = null,
  digest: { everyMs: number | null; lastSentAt: string | null; held: number } | null = null,
  permissionDefault: { mode: UnattendedPermissionMode; updatedAt: string | null; updatedBy: string | null; canManage: boolean } | null = null,
  qualityDefault: { mode: QualityMode; updatedAt: string | null; updatedBy: string | null; canManage: boolean } | null = null,
  email: NonNullable<BrowserSettingsView["email"]> | null = null,
  telegramDelivery: string | null = null,
  workers: NonNullable<BrowserSettingsView["workers"]> | null = null,
  updates: BrowserUpdates | null = null,
  firstResult: string | null = null,
  chatNotices: { mode: "quiet" | "all"; digestAt: string | null; screenshots?: ResultScreenshots; projects?: { repo: string; name: string; muted: boolean }[] } | null = null,
  telegramFailing = false,
  phone: BrowserPhoneCard | null = null,
): Screen {
  const permissionCard =
    permissionDefault === null
      ? ""
      : joinHtml([
          html`<h2>Unattended permissions</h2>`,
          permissionDefault.canManage && csrf !== ""
            ? postForm("/settings/permission-default", html`${permissionModeChoices("permission-mode", permissionDefault.mode)}<button type="submit">Save default</button>`,
              { attrs: { class: "card permission-policy", "data-autosave": true } })
            : html`<div class="card"><p><strong>${permissionDefault.mode === "bypassPermissions" ? "Full access" : "Auto"}</strong></p><p class="meta">An approver can change this default</p></div>`,
          permissionDefault.updatedAt === null
            ? ""
            : html`<p class="meta settings-changed">Changed ${whenTime(permissionDefault.updatedAt)}${permissionDefault.updatedBy === null ? "" : ` by ${permissionDefault.updatedBy}`}</p>`,
        ], "\n");
  const qualityCard =
    qualityDefault === null
      ? ""
      : joinHtml([
          html`<h2>Quality mode</h2>`,
          qualityDefault.canManage && csrf !== ""
            ? postForm("/settings/quality-default", html`${qualityModeChoices("quality-mode", qualityDefault.mode)}<button type="submit">Save default</button>`,
              { attrs: { class: "card permission-policy", "data-autosave": true } })
            : html`<div class="card"><p><strong>${qualityModeTitle(qualityDefault.mode)}</strong></p><p class="meta">An approver can change this default</p></div>`,
          qualityDefault.updatedAt === null
            ? ""
            : html`<p class="meta settings-changed">Changed ${whenTime(qualityDefault.updatedAt)}${qualityDefault.updatedBy === null ? "" : ` by ${qualityDefault.updatedBy}`}</p>`,
        ], "\n");
  // Quiet chat: this person's own choice. The installation's Telegram cadence only bundles Every step updates.
  const chatCard =
    chatNotices === null || csrf === ""
      ? ""
      : joinHtml([
          html`<h3>Chat messages</h3>`,
          postForm("/settings/notifications", joinHtml([
            "",
            html`<label><input type="radio" name="mode" value="quiet"${chatNotices.mode === "quiet" ? " checked" : ""}> Only when I'm needed <span class="meta">· one message per task, updated as it moves</span></label>`,
            html`<label><input type="radio" name="mode" value="all"${chatNotices.mode === "all" ? " checked" : ""}> Every step <span class="meta">· a new message for each update</span></label>`,
            html`<label>Evening digest<select name="digest">\
${digestTimes(chatNotices.digestAt).map(([value, label]) => html`<option value="${value}"${value === (chatNotices.digestAt ?? "off") ? " selected" : ""}>${label}</option>`)}\
</select></label>`,
            html`<p class="meta">One message: what finished, what waits, what failed.</p>`,
            html`<label>Screenshots with results<select name="screenshots">\
${RESULT_SHOT_CHOICES.map(([value, label]) => html`<option value="${value}"${value === (chatNotices.screenshots ?? "off") ? " selected" : ""}>${label}</option>`)}\
</select></label>`,
            html`<button type="submit">Save</button>`,
            "",
          ], "\n"), { attrs: { class: "card", "data-autosave": true } }),
          ...((chatNotices.projects ?? []).length === 0 ? [] : [
            html`<h3>Projects</h3>`,
            html`<ul class="card">${chatNotices.projects!.map(one => html`<li>${postForm("/settings/notifications/mute",
              html`${one.name} <span class="meta">· ${one.muted ? "muted" : "pings on"}</span> <button type="submit">${one.muted ? "Unmute" : "Mute"}</button>`,
              { hidden: { repo: one.repo, pings: one.muted ? null : "on" } })}</li>`)}</ul>`,
            html`<p class="meta">Muted projects still show in Tasks and the evening digest.</p>`,
          ]),
        ], "\n");
  const digestCard =
    digest === null || csrf === "" || chatNotices?.mode === "quiet"
      ? ""
      : joinHtml([
          html`<h3>Telegram digest</h3>`,
          html`<p class="meta">Bundle routine updates. Anything that needs you still arrives at once.</p>`,
          postForm("/settings/telegram-digest", joinHtml([
            "",
            html`<label>Send a digest<select name="every">\
${[
              ["off", "Off: send each update"],
              ["30", "every 30 minutes"],
              ["60", "every hour"],
              ["240", "every 4 hours"],
              ["720", "every 12 hours"],
              ["1440", "once a day"],
            ]
              .map(([value, label]) => {
                const selected = value === "off" ? digest.everyMs === null : digest.everyMs === Number(value) * 60_000;
                return html`<option value="${value}"${selected ? " selected" : ""}>${label}</option>`;
              })}\
</select></label>`,
            html`<p class="meta">${
              digest.everyMs === null
                ? ""
                : `${digest.held} routine fact(s) held · next digest ${digest.lastSentAt === null ? "at the next bridge pass" : `no earlier than ${new Date(new Date(digest.lastSentAt).getTime() + digest.everyMs).toISOString()}`}`
            }</p>`,
            html`<button type="submit">Save digest</button>`,
            "",
          ], "\n"), { attrs: { class: "card", "data-autosave": true } }),
        ], "\n");
  const keysCard =
    providerKeys === null || csrf === ""
      ? ""
      : joinHtml([
          html`<h2 id="providers">AI providers</h2><p><a href="/control">Set up this project</a></p>`,
          html`<p class="meta">Keys stay on this computer and are never shown again.</p>`,
          html`<details class="settings-more"><summary>How keys are used</summary><p class="meta">A key is used only when that provider’s sign-in is set to API key. With a subscription sign-in the key is kept out of the agent, so your membership never turns into API billing. Keys are private files beside the database, never stored in it.</p></details>`,
          ...providerKeys.map(one => {
            // One status row per provider; the controls wait behind Manage.
            const name = ASSISTANTS[one.provider as ProviderId]?.name ?? one.provider;
            const status = one.connection !== undefined && one.connection.state === "connected"
              ? { tone: "ok", words: [connectionWords(one.connection), one.connection.plan].filter(Boolean).join(" · ") }
              : one.mode === "subscription"
                ? { tone: one.connection === undefined ? "neutral" : "warn", words: one.connection === undefined ? "Uses its own sign-in" : connectionWords(one.connection) }
                : one.connection?.state === "key-works" ? { tone: "ok", words: "API key works" } : one.connection?.state === "key-refused" ? { tone: "warn", words: "API key refused" }
                : one.set ? { tone: "ok", words: "API key saved" } : one.ambient ? { tone: "ok", words: "Key from this computer’s environment" } : { tone: "off", words: "Not set up" };
            return joinHtml([
              html`<div class="provider-row" data-provider="${one.provider}">`,
              html`<p class="provider-head"><strong>${name}</strong> <span class="provider-status provider-status--${status.tone}"><i aria-hidden="true"></i>${status.words}</span></p>`,
              html`<details class="provider-manage"><summary>Manage</summary>`,
              postForm("/settings/provider-key", joinHtml([
                "",
                one.connection === undefined ? "" : html`<p class="provider-connection"><strong>${connectionWords(one.connection)}</strong> ${[one.connection.email, one.connection.plan, one.connection.method].filter(Boolean).join(" · ")} · <a href="/settings?check-connection=${encodeURIComponent(one.provider)}#providers">Check again</a></p>`,
                html`<p class="meta">${one.mode === "subscription" ? "Uses its own sign-in, so no API-key spend" : "Uses the API key"} · <span class="mono">${one.envName}</span> · ${
                  one.set ? `key stored${one.updatedAt === null ? "" : ` ${one.updatedAt.slice(0, 10)}`}` : one.ambient ? "key in this server's environment" : "no key stored"}</p>`,
                one.subscriptionCapable
                  ? html`<label>Sign-in<select name="auth-mode">\
<option value="subscription"${one.mode === "subscription" ? " selected" : ""}>${name} subscription</option>\
<option value="api-key"${one.mode === "api-key" ? " selected" : ""}>API key</option>\
</select></label>`
                  : "",
                html`<label>API key<input type="password" name="value" autocomplete="off" placeholder="${one.set ? "Paste to replace the stored key" : "Paste a key"}"></label>`,
                html`<button type="submit">Save ${name}</button>`,
                one.set
                  ? html` <details class="confirm-remove"><summary>Remove the stored key</summary><p class="meta">Runs that use this API key stop until you add one again.</p><button type="submit" formaction="/settings/provider-key-clear" class="danger">Remove key</button></details>`
                  : "",
                "",
              ], "\n"), { attrs: { class: "card" }, hidden: { provider: one.provider } }),
              html`</details></div>`,
            ], "\n");
          }),
        ], "\n");
  const pushCard =
    push === null || csrf === ""
      ? ""
      : joinHtml([
          html`<h3>This device</h3>`,
          push.available
            ? joinHtml([
                html`<p class="meta">A notification when something needs you. On iPhone, add this app to your Home Screen first.</p>`,
                postForm("/push/subscribe", joinHtml([
                  "",
                  html`<input type="hidden" name="endpoint" value=""><input type="hidden" name="p256dh" value=""><input type="hidden" name="auth" value="">`,
                  html`<label>Your password <input type="password" name="token" autocomplete="current-password"></label>`,
                  html`<button type="submit" id="push-enable">Get alerts on this device</button>`,
                  html`<p class="meta" id="push-state"></p>`,
                  "",
                ], "\n"), { attrs: { id: "push-form", class: "card" } }),
              ], "\n")
            : html`<p class="meta">Alerts need a secure (https) address for this app.</p>`,
          ...push.devices
            .filter(one => one.retiredAt === null || one.retiredReason === "gone")
            .map(
              one =>
                html`<p class="row">${one.uaWords} · since ${whenTime(one.createdAt)}\
${one.retiredAt !== null ? html` · <span class="meta">expired</span>` : one.consecutiveFailures >= 20 ? html` · <span class="meta">failing</span>` : ""}\
${one.retiredAt === null
                  ? html` ${postForm("/push/remove", html`<button type="submit">Remove</button>`, { attrs: { class: "inline" }, hidden: { id: one.id } })}`
                  : ""}\
</p>`,
            ),
        ], "\n");
  // The enrollment behavior rides the ONE composed script (arc 4, finding
  // 18) — it fills the subscription fields the form posts; it never reads
  // the password field beside them (the named functional exception).
  const pushScript =
    push === null || !push.available || csrf === ""
      ? null
      : `(function(){` +
        `if(!("serviceWorker" in navigator)||!("PushManager" in window))return;` +
        `var link=document.createElement("link");link.rel="manifest";link.href="/manifest.webmanifest";document.head.appendChild(link);` +
        `navigator.serviceWorker.register("/sw.js",{scope:"/"}).catch(function(){});` +
        `var form=document.getElementById("push-form");if(!form)return;` +
        `form.addEventListener("submit",function(event){` +
        `if(form.dataset.ready==="1")return;` +
        `event.preventDefault();var state=document.getElementById("push-state");` +
        `Notification.requestPermission().then(function(granted){` +
        `if(granted!=="granted"){if(state)state.textContent="notifications are blocked for this site in the browser settings";return;}` +
        `return fetch("/push/key").then(function(r){return r.json();}).then(function(d){` +
        `return navigator.serviceWorker.ready.then(function(reg){` +
        `return reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:Uint8Array.from(atob(d.key.replace(/-/g,"+").replace(/_/g,"/")),function(c){return c.charCodeAt(0);})});});` +
        `}).then(function(sub){var raw=sub.toJSON();` +
        `form.querySelector("[name=endpoint]").value=sub.endpoint;` +
        `form.querySelector("[name=p256dh]").value=(raw.keys.p256dh||"").replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");` +
        `form.querySelector("[name=auth]").value=(raw.keys.auth||"").replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");` +
        `form.dataset.ready="1";form.submit();});` +
        `}).catch(function(){if(state)state.textContent="could not subscribe — the browser said no";});});` +
        `})();`;
  const messagingCard =
    messaging === null || messaging.configured.length === 0
      ? ""
      : messaging.configured.length === 1 && !messaging.implicit
        ? html`<h3>Alert service</h3><p class="provider-head"><strong>${messaging.configured[0]!}</strong> <span class="provider-status provider-status--ok"><i aria-hidden="true"></i>Receiving alerts</span></p>`
      : joinHtml([
          html`<h3>Alert service</h3>`,
          html`<p class="meta">Alerts go through one service, so you are never notified twice${
            messaging.implicit ? html` · <strong>Several are connected and none was chosen. Pick one.</strong>` : ""
          }</p>`,
          postForm("/settings/messaging", joinHtml([
            "",
            ...messaging.configured.map(
              channel =>
                html`<label style="display:flex;gap:.5rem;align-items:center"><input type="radio" name="primary" value="${channel}"${
                  channel === messaging.channel ? " checked" : ""
                }> ${channel}${channel === messaging.channel ? html` <span class="meta">— receiving alerts now${messaging.implicit ? " (by default, not by choice)" : ""}</span>` : ""}${
                  channel === "telegram" ? html` <span class="meta">· can carry answer buttons and reply-notes</span>` : html` <span class="meta">· messages with console links; acting stays here</span>`
                }</label>`,
            ),
            html`<button type="submit">Use this service</button>`,
            "",
          ], "\n"), { attrs: { class: "card" } }),
          html`<p class="meta">Telegram still accepts taps and replies when another service sends alerts.</p>`,
        ], "\n");
  const current =
    hasEnv
      ? `set in the environment (${TOKEN_ENV}) — that takes precedence over anything saved here`
      : existing === null
        ? "not set"
        : `saved: ${redactToken(existing.token)} (bot ${existing.botId})`;
  const theme = requestContext.getStore()?.theme ?? "system";
  const view: BrowserSettingsView = {
    kind: "settings",
    said: problem,
    groups: settingsGroups(messaging, telegramFailing),
    ...(messaging?.legacyWarning ? { legacyWebhookWarning: messaging.legacyWarning } : {}),
    theme,
    accent: requestContext.getStore()?.accent ?? DEFAULT_ACCENT,
    accentPresets: ACCENT_PRESETS,
    permission: permissionDefault === null ? null : { mode: permissionDefault.mode, canManage: permissionDefault.canManage && csrf !== "", changed: permissionDefault.updatedAt === null ? null : `Changed ${when(permissionDefault.updatedAt)}${permissionDefault.updatedBy === null ? "" : ` by ${permissionDefault.updatedBy}`}` },
    quality: qualityDefault === null ? null : { mode: qualityDefault.mode, canManage: qualityDefault.canManage && csrf !== "", changed: qualityDefault.updatedAt === null ? null : `Changed ${when(qualityDefault.updatedAt)}${qualityDefault.updatedBy === null ? "" : ` by ${qualityDefault.updatedBy}`}` },
    providers: providerKeys === null || csrf === "" ? null : providerKeys.map(one => {
      const name = ASSISTANTS[one.provider as ProviderId]?.name ?? one.provider;
      const status = one.connection !== undefined && one.connection.state === "connected"
        ? { tone: "ok" as const, words: [connectionWords(one.connection), one.connection.plan].filter(Boolean).join(" · ") }
        : one.mode === "subscription"
          ? { tone: one.connection === undefined ? "neutral" as const : "warn" as const, words: one.connection === undefined ? "Uses its own sign-in" : connectionWords(one.connection) }
          : one.connection?.state === "key-works" ? { tone: "ok" as const, words: "API key works" } : one.connection?.state === "key-refused" ? { tone: "warn" as const, words: "API key refused" }
          : one.set ? { tone: "ok" as const, words: "API key saved" } : one.ambient ? { tone: "ok" as const, words: "Key from this computer’s environment" } : { tone: "off" as const, words: "Not set up" };
      return {
        provider: one.provider, name, tone: status.tone, words: status.words,
        connection: one.connection === undefined ? null : { words: connectionWords(one.connection), facts: [one.connection.email, one.connection.plan, one.connection.method].filter(Boolean).join(" · "), checkHref: `/settings?check-connection=${encodeURIComponent(one.provider)}#providers` },
        usage: `${one.mode === "subscription" ? "Uses its own sign-in, so no API-key spend" : "Uses the API key"} · ${one.set ? `key stored${one.updatedAt === null ? "" : ` ${one.updatedAt.slice(0, 10)}`}` : one.ambient ? "key in this server's environment" : "no key stored"}`,
        envName: one.envName, subscriptionCapable: one.subscriptionCapable, mode: one.mode, set: one.set,
      };
    }),
    services: messaging === null || messaging.configured.length === 0 ? null : { configured: messaging.configured, channel: messaging.channel, implicit: messaging.implicit },
    push: push === null || csrf === "" ? null : { available: push.available, devices: push.devices.filter(one => one.retiredAt === null || one.retiredReason === "gone").map(one => ({ id: one.id, words: `${one.uaWords} · since ${when(one.createdAt)}`, state: one.retiredAt !== null ? "expired" : one.consecutiveFailures >= 20 ? "failing" : "ok", removable: one.retiredAt === null })) },
    chat: chatNotices === null || csrf === "" ? null : chatNotices,
    digest: digest === null || csrf === "" || chatNotices?.mode === "quiet" ? null : { every: digest.everyMs === null ? "off" : String(Math.round(digest.everyMs / 60_000)), held: digest.everyMs === null ? null : `${digest.held} routine fact(s) held` },
    telegram: { state: hasEnv ? "from the environment" : existing === null ? "not set" : "saved", current, delivery: telegramDelivery },
    email,
    workers,
    updates,
    firstResult,
    ...(phone === null ? {} : { phone }),
  };
  return screen("Settings", joinHtml([
    html`<h1>Settings</h1>`,
    messaging?.legacyWarning ? html`<p data-legacy-webhooks>Legacy webhooks are deprecated. Connect <a href="/settings/slack" style="display:inline-flex;min-height:44px;align-items:center">Slack</a> or <a href="/settings/discord" style="display:inline-flex;min-height:44px;align-items:center">Discord</a> in Chat settings.</p>` : "",
    settingsTiles(view.groups),
    phone === null ? "" : phoneSetupHtml(phone),
    appearanceCard(csrf),
    permissionCard,
    qualityCard,
    keysCard,
    workersCard(workers),
    updatesCard(updates),
    firstResult === null ? "" : html`<p class="meta" data-first-result>${firstResult}</p>`,
    pushCard === "" && messagingCard === "" && digestCard === "" && chatCard === "" ? "" : html`<h2>Notifications</h2>`,
    chatCard,
    messagingCard,
    pushCard,
    digestCard,
    problem === null ? "" : html`<p class="problem" role="alert">${problem}</p>`,
    html`<details class="settings-more" id="telegram-token"><summary>Telegram bot token <span class="meta">${hasEnv ? "from the environment" : existing === null ? "not set" : "saved"}</span></summary>`,
    html`<p class="meta">Current: ${current}</p>`,
    telegramDelivery === null ? "" : html`<p class="meta" data-telegram-delivery>${telegramDelivery}</p>`,
    postForm("/settings/telegram-token", joinHtml([
      "",
      html`<label>Token from @BotFather<input type="password" name="token" autocomplete="off"></label>`,
      html`<button type="submit">Save token</button>`,
      "",
    ], "\n")),
    html`<p class="meta">Stored privately on this computer. Then pair your phone under <a href="/settings/telegram">Telegram</a>. In Telegram, send <code>/status</code>, <code>/task &lt;id&gt;</code> or <code>/help</code>; these use no AI model.</p>`,
    html`</details>`,
  ], "\n"), { chrome, workspace: { view }, functional: { script: SETTINGS_AUTOSAVE_SCRIPT + (pushScript ?? ""), ...(pushScript === null ? {} : { fetches: true }) } });
}

/** The phone setup for the server-rendered Settings page: the same choices as the React card. */
export function phoneSetupHtml(phone: BrowserPhoneCard): Html {
  const [first, ...others] = phone.chatApps;
  return html`<section class="card" id="phone" aria-labelledby="phone-card-title" data-phone-card><h2 id="phone-card-title">Use it from your phone</h2>\
<p>${first === undefined ? "" : html`<a href="${first.href}">Pair ${first.label}</a>`}${others.length === 0 ? "" : html` · or ${joinHtml(others.map(one => html`<a href="${one.href}">${one.label}</a>`), ", ")}`}</p>\
<p class="meta" data-phone-tailnet>${phone.tailnet === null ? html`Or install <a href="https://tailscale.com/download">Tailscale</a> on this computer and your phone, then reload this page for the address.`
      : phone.tailnet.restart === null ? html`Or on your phone open <code>${phone.tailnet.address}</code> and sign in.`
      : html`Or start Toolroll with <code>${phone.tailnet.restart}</code>, then on your phone open <code>${phone.tailnet.address}</code> and sign in.`}</p></section>`;
}

/** Every worker that is not retired: its capacity, and the tasks it holds now. */
export function settingsWorkers(store: Store, now: Date): NonNullable<BrowserSettingsView["workers"]> {
  const claims = store.liveClaims(null, now);
  return store.listRunners().filter(one => one.retiredAt === null).map(one => {
    const age = now.getTime() - new Date(one.heartbeatAt).getTime();
    const alive = runnerAlive(one, now);
    return {
      name: one.name,
      tone: alive ? "ok" as const : age < 60 * 60_000 ? "warn" as const : "off" as const,
      state: alive ? "Connected" : age < 60 * 60_000 ? `Quiet for ${Math.max(1, Math.round(age / 60_000))} min` : "Not connected",
      capacity: one.capacity,
      busy: store.liveClaimCount(one.name, now),
      running: claims.filter(claim => claim.runner === one.name).map(claim => ({
        taskId: claim.taskId,
        title: store.getTask(claim.taskId)?.title ?? claim.taskId,
        href: taskHref(claim.taskId),
        project: claim.repo === null ? null : projectName(claim.repo),
      })),
    };
  });
}

/** The page's workers section, for browsers without the app script. */
export function workersCard(workers: NonNullable<BrowserSettingsView["workers"]> | null): Html {
  if (workers === null) return html``;
  return html`<section id="workers" aria-labelledby="workers-title"><h2 id="workers-title">Workers</h2>\
${workers.length === 0
      ? html`<p class="meta">No worker is connected. Run <code>toolroll up</code> on the computer with your projects.</p>`
      : html`${workers.map(one =>
          html`<div class="card" data-worker="${one.name}"><p class="row"><strong>${one.name}</strong> <span class="meta">${one.state}</span>\
<span class="right">${one.busy} of ${one.capacity} running</span></p>\
${one.running.length === 0
            ? html`<p class="meta">Nothing running.</p>`
            : html`<ul>${one.running.map(task => html`<li><a href="${task.href}">${task.title}</a>${task.project === null ? "" : html` <span class="meta">${task.project}</span>`}</li>`)}</ul>`}\
</div>`)}\
<p class="meta">To change how many a worker runs at once: <code>toolroll runner capacity &lt;name&gt; &lt;n&gt;</code></p>`}\
</section>`;
}

/** Settings → Updates, for browsers without the app script. */
export function updatesCard(updates: BrowserUpdates | null): Html {
  if (updates === null) return html``;
  const latest = updates.latest;
  return html`<section id="updates" aria-labelledby="updates-title"><h2 id="updates-title">Updates</h2>\
<p class="row">This version <span class="mono">${updates.current}</span> · ${
      !updates.check.on ? "Update checks are off" : latest === null ? "Not checked yet" : latest.newer ? html`Latest <span class="mono">${latest.version}</span>` : "Up to date"}</p>\
${latest !== null && latest.newer
      ? html`<p>Update with <code>${updates.updateCommand}</code> · <a href="${latest.url}">Release notes</a></p>\
${latest.notes === "" ? "" : html`<details class="settings-more"><summary>What's new in ${latest.version}</summary><pre class="update-notes">${latest.notes}</pre></details>`}`
      : ""}\
${updates.check.canManage && !updates.check.byEnv
      ? postForm("/settings/updates/checks", html`<button type="submit">${updates.check.on ? "Turn off daily check" : "Turn on daily check"}</button>`, { attrs: { class: "inline" }, hidden: { check: updates.check.on ? "off" : "on" } })
      : updates.check.byEnv ? html`<p class="meta">Off by TOOLROLL_NO_UPDATE_CHECK.</p>` : ""}\
${updates.workers.length === 0 ? "" : html`<ul>${updates.workers.map(one => html`<li data-worker-version="${one.name}">${one.name} <span class="mono">${one.version ?? "unknown"}</span>${one.older ? " · older" : ""}</li>`)}</ul>`}\
</section>`;
}

/** Choices save the moment they change; without the script the Save
 * button stays and the form works the same. */
export const SETTINGS_AUTOSAVE_SCRIPT = `(function(){document.querySelectorAll('form[data-autosave]').forEach(function(form){form.classList.add('js-autosave');form.addEventListener('change',function(ev){var t=ev.target;if(t&&(t.type==='radio'||t.tagName==='SELECT')){if(form.requestSubmit)form.requestSubmit();else form.submit();}});});})();`;

/** The newest release, remembered for a while so the page stays quick. */
export let latestSeen: { at: number; value: { version: string } | { problem: string } } | null = null;
export async function latestReleaseFor(latest: (() => Promise<{ version: string }>) | undefined): Promise<{ version: string } | { problem: string }> {
  if (latest === undefined && latestSeen !== null && Date.now() - latestSeen.at < ("problem" in latestSeen.value ? 60_000 : 900_000)) return latestSeen.value;
  let value: { version: string } | { problem: string };
  try { value = { version: (await (latest ?? latestVersionNow)()).version }; } catch (error) { value = { problem: (error as Error).message }; }
  if (latest === undefined) latestSeen = { at: Date.now(), value };
  return value;
}

/** Settings destinations under short headings: an icon and a name each, and a chat app's logo and state. */
export function settingsTiles(groups: BrowserSettingsGroup[]): Html {
  return html`<nav class="settings-tiles" aria-label="Settings sections">${groups.map(group =>
    html`<section aria-label="${group.title}"><h2>${group.title}</h2><div>${group.tiles.map(tile =>
      html`<a href="${tile.href}">${tile.brand === undefined ? strokeIcon(SETTINGS_TILE_ICONS.get(tile.href) ?? html``) : brandIconHtml(tile.brand)}<span>${tile.label}${tile.status === undefined ? "" :
        html`<span class="provider-status provider-status--${tile.status.tone}"><i aria-hidden="true"></i>${tile.status.words}</span>`}</span></a>`)}</div></section>`)}</nav>`;
}

/** Each destination once, in order: a group's heading, then its [href, label, icon] tiles. */
export const SETTINGS_GROUPS: [string, [string, string, Html][]][] = [
  ["Agents", [
    ["/settings/lead", "Lead", html`<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 9h8M8 13h5"/>`],
    ["/settings/models", "Models", html`<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/>`],
    ["/settings/skills", "Skills", html`<path d="m12 3 1.9 5.8L20 10l-5 3.6L16.8 20 12 16.4 7.2 20 9 13.6 4 10l6.1-1.2z"/>`],
    ["/settings/tools", "Tools", html`<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>`],
    ["/settings/knowledge", "Knowledge", html`<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>`],
    ["/settings/learning", "Learning", html`<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 5-6"/>`],
  ]],
  ["Automation", [
    ["/settings/flows", "Flows", html`<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><path d="M10 6.5h4a3 3 0 0 1 3 3V14"/>`],
    ["/settings/integrations", "Integrations", html`<path d="M9 2v6M15 2v6"/><path d="M6 8h12v4a6 6 0 0 1-12 0z"/><path d="M12 18v4"/>`],
  ]],
  ["Chat apps", [
    ["/settings/telegram", "Telegram", html``],
    ["/settings/slack", "Slack", html``],
    ["/settings/discord", "Discord", html``],
    ["/settings/teams", "Teams", html``],
  ]],
  ["Access and rules", [
    ["/settings/sign-in", "Sign-in", html`<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>`],
    ["/settings/sessions", "Sessions & tokens", html`<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>`],
    ["/settings/project", "Project", html`<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>`],
    ["/settings/policy", "Policy", html`<path d="M9 12l2 2 4-4"/><rect x="4" y="3" width="16" height="18" rx="2"/>`],
    ["/settings/approval", "Approval rules", html`<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>`],
  ]],
  ["System", [
    ["/settings/monitoring", "Monitoring", html`<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>`],
    ["/settings/retention", "Retention", html`<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`],
    ["/settings/storage", "Storage", html`<path d="M22 12H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><path d="M6 16h.01M10 16h.01"/>`],
    ["/settings/updates", "Updates", html`<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>`],
    ["/settings/backups", "Backups", html`<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/>`],
    ["/settings/data", "Data", html`<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>`],
  ]],
];
export const SETTINGS_TILE_ICONS = new Map(SETTINGS_GROUPS.flatMap(([, tiles]) => tiles.map(([href, , icon]) => [href, icon] as const)));
export const CHAT_APP_TILES: Record<string, BrandIconId> = { "/settings/telegram": "telegram", "/settings/slack": "slack", "/settings/discord": "discord", "/settings/teams": "teams" };

/**
 * The settings groups, with each chat app's state from what the server already holds: not set up,
 * connected, or getting alerts (only when that service was chosen, or is the only one).
 * A Telegram bot whose saved delivery state reports a problem says so instead. With no config folder
 * the state is unknown, so the tiles carry none.
 */
export function settingsGroups(messaging: { channel: string | null; implicit: boolean; configured: string[] } | null, telegramFailing = false): BrowserSettingsGroup[] {
  return SETTINGS_GROUPS.map(([title, tiles]) => ({
    title,
    tiles: tiles.map(([href, label]) => {
      const app = CHAT_APP_TILES[href];
      if (app === undefined) return { href, label };
      if (messaging === null) return { href, label, brand: app };
      if (!messaging.configured.includes(app)) return { href, label, brand: app, status: { tone: "off" as const, words: "Not set up" } };
      if (app === "telegram" && telegramFailing) return { href, label, brand: app, status: { tone: "warn" as const, words: "Has a problem" } };
      return { href, label, brand: app, status: { tone: "ok" as const, words: messaging.channel === app && !messaging.implicit ? "Gets alerts" : "Connected" } };
    }),
  }));
}

/** Light, dark or the device's choice, one tap each. Per browser (a cookie). */
export function appearanceCard(csrf: string): Html {
  if (csrf === "") return html``;
  const pinned = requestContext.getStore()?.theme ?? null;
  const current = pinned ?? "system";
  const option = (value: string, label: string) =>
    html`<button type="submit" name="theme" value="${value}" class="theme-choice" aria-pressed="${String(current === value)}">${label}</button>`;
  return html`<section class="appearance" aria-labelledby="appearance-title"><h2 id="appearance-title">Appearance</h2>\
${postForm("/settings/appearance", html`${option("system", "Match device")}${option("light", "Light")}${option("dark", "Dark")}`, { attrs: { class: "theme-switch" } })}\
<p class="meta">Saved in this browser.</p></section>`;
}
