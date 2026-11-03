/** Settings pages: the settings home, lead, capabilities and their cards. */
import { isSubscriptionChatProvider,PRICED_MODELS } from "../converse.js";
import { describeCapability,type Gap } from "../gaps.js";
import { ABOUT_YOU_LINE_MAX,ABOUT_YOU_MAX_LINES } from "../lead-about.js";
import { LEAD_NAME_MAX,LEAD_PERSONA_MAX,type LeadIdentity } from "../lead-identity.js";
import { projectName } from "../project.js";
import { latestVersionNow } from "../releases.js";
import { isAlive as runnerAlive } from "../runner.js";
import { type Capability,type Store } from "../store.js";
import { type TokenSource } from "../telegram.js";
import { chatMoney,type Chrome,screen,type Screen,when } from "./chrome.js";
import { taskHref } from "./http.js";
import { html,joinHtml,postForm,type Html,reauth } from "../html.js";
import { settingsSubPage,type WorkerFacts } from "../settings-groups-ui.js";

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
  promises?: { id: number; what: string; when: string; until: string }[];
  /** D5: the lead's subagents in the projects this person can use: name and role, project, and whether it's paused. */
  subagents?: { id: number; label: string; project: string; paused: boolean }[] }): Html {
  const { config, facts } = data;
  const returnTo = "/settings/lead";
  const summary = config === null
    ? data.signedIn !== null
      ? html`<p>The lead is off.</p>${postForm("/settings/lead/on", html`<button type="submit">Use your ${data.signedIn} sign-in</button>`, { returnTo })}`
      : html`<p>The lead is off. Sign in an agent on this computer to turn it on:</p><p><code>${data.command}</code></p>${postForm("/lead/check", html`<button type="submit" class="secondary">Check again</button>`, { returnTo })}`
    : data.words !== null
      ? html`<p>The lead uses ${data.words}.</p><p class="meta">${config.model === "default" ? "Its default model" : `Model ${config.model}`} · up to ${config.dailyTurns} turns a day · no dollar spend. Every action it proposes waits for you to confirm it.</p>`
      : html`<p>The lead uses the ${config.provider === "anthropic-api" ? "Anthropic" : "OpenRouter"} API with ${config.model}.</p><p class="meta">Up to ${chatMoney(config.weeklyCeilingMicrousd)} a week · up to ${config.dailyTurns} turns a day.</p>`;
  const forget = facts.keyFacts.filter(one => one.state === "stored").map(one =>
    postForm("/chat/config", html`${reauth(html`<input type="password" name="token" placeholder="your password" autocomplete="current-password" aria-label="Your password">`)}<button type="submit" class="secondary">Forget the stored ${one.provider} key</button>`,
      { attrs: { class: "inline" }, returnTo, hidden: { "forget-key": one.provider } }));
  return settingsSubPage("agents", "Lead", joinHtml([
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
    // D5: the lead's subagents, one line each; everything else about one is on its own page.
    data.subagents === undefined ? "" : html`<section class="card lead-subagents" id="subagents" data-lead-subagents><h2>Subagents</h2>${
      data.subagents.length === 0 ? html`<p class="meta">None yet. Your lead can ask one for help once it's here.</p>`
        : html`<ul class="lead-subagent-list">${data.subagents.map(one => html`<li data-subagent="${one.id}"><a href="/settings/lead/subagents/${one.id}">${one.label}</a><span class="meta">${one.project}${one.paused ? " · Paused" : ""}</span></li>`)}</ul>`
    }<p><a class="button-link" href="/settings/lead/subagents?add=1#add" data-add-subagent>Add subagent</a></p></section>`,
    html`<details class="lead-advanced" data-lead-advanced><summary>Advanced</summary>`,
    leadConfigForm(config, facts),
    config === null ? "" : postForm("/chat/config", html`${reauth(html`<input type="password" name="token" placeholder="your password" autocomplete="current-password" aria-label="Your password">`)}<button type="submit" class="secondary">Turn the lead off</button>`,
      { attrs: { class: "inline" }, returnTo, hidden: { off: "1" } }),
    forget,
    html`</details>`,
  ], "\n"));
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
${reauth(html`<input type="password" name="token" autocomplete="current-password">`)}</label>`,
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
    return screen("requirements", settingsSubPage("approval", "Requirements", html`<p class="meta">Open a project to see its requirements: <a href="/projects">Projects</a>.</p>`), { chrome });
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
  return screen("requirements", settingsSubPage("approval", "Requirements", joinHtml([
    list,
    html`<h2>Missing, ranked by what filling them frees</h2>`,
    blocked,
    html`<p class="meta">Read-only here: checks are shell commands you wrote, and a web button that runs shell would need its own security review.</p>`,
  ], "\n"), { lead: "Tools and credentials builds need. Each is checked on the builder before any build spends money; values never leave your computer." }), { chrome });
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

/** Every worker that is not retired: its capacity, and the tasks it holds now. */
export function settingsWorkers(store: Store, now: Date): WorkerFacts[] {
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
