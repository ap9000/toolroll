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
import { html,joinHtml,postForm,type Html } from "../html.js";
import { acts,btn,chip,codeLine,disclose,facts,formRow,input,note,notice,select,settingsLink,settingsRecord,settingsSection,switchInput,textarea } from "./kit.js";
import { kitSectionForm,SECRET_OPT_OUTS } from "../settings-kit.js";
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
export function leadSettingsHtml(data: { config: import("../store.js").ChatConfig | null; facts: LeadFormFacts; words: string | null; signedIn: string | null; command: string; said: string | null; problem?: string | null;
  saved?: boolean; identity?: LeadIdentity;
  about?: string[]; aboutSaved?: boolean;
  promises?: { id: number; what: string; when: string; until: string }[];
  /** Quick answers (responsive-chat.md §8): whether they're on, the faster model's name, whether this person may change
   * them (an instance operator), and whether the last save was this one. Absent: not shown. */
  quick?: { on: boolean; model: string; canChange: boolean; saved: boolean };
  /** D5: the lead's subagents in the projects this person can use: name and role, project, and whether it's paused. */
  subagents?: { id: number; label: string; project: string; paused: boolean }[] }): Html {
  const { config, facts } = data;
  const returnTo = "/settings/lead";
  const runs = config === null
    ? data.signedIn !== null
      ? settingsSection({ id: "lead-runs", title: "What runs the lead", lead: "The lead is off.",
          body: postForm("/settings/lead/on", acts(btn(`Use your ${data.signedIn} sign-in`, { variant: "primary", type: "submit" })), { returnTo }) })
      : settingsSection({ id: "lead-runs", title: "What runs the lead", lead: "The lead is off. Sign in an agent on this computer to turn it on:",
          body: joinHtml([codeLine(data.command), postForm("/lead/check", acts(btn("Check again", { sm: true, type: "submit" })), { returnTo })]) })
    : data.words !== null
      ? settingsSection({ id: "lead-runs", title: "What runs the lead", lead: `The lead uses ${data.words}.`,
          body: note(`${config.model === "default" ? "Its default model" : `Model ${config.model}`} · up to ${config.dailyTurns} turns a day · no dollar spend. Every action it proposes waits for you to confirm it.`) })
      : settingsSection({ id: "lead-runs", title: "What runs the lead", lead: `The lead uses the ${config.provider === "anthropic-api" ? "Anthropic" : "OpenRouter"} API with ${config.model}.`,
          body: note(`Up to ${chatMoney(config.weeklyCeilingMicrousd)} a week · up to ${config.dailyTurns} turns a day.`) });
  const savedLine = (shown: boolean): Html => shown ? html`<span class="k-ssave-said" role="status">Saved.</span>` : html``;
  const identity = data.identity === undefined ? "" : settingsSection({ id: "lead-identity", title: "Name and persona",
    body: postForm("/settings/lead/identity", joinHtml([
      formRow("Name your lead", null, input({ id: "lead-name", name: "name", value: data.identity.name, attrs: { maxlength: LEAD_NAME_MAX, autocomplete: "off", required: true, "aria-label": "Name your lead" } })),
      formRow("Persona", "How it talks to you.", textarea({ id: "lead-persona", name: "persona", rows: 4, value: data.identity.persona, attrs: { maxlength: LEAD_PERSONA_MAX, "aria-label": "Persona" } }), "top"),
      html`<div class="k-ssave">${savedLine(data.saved === true)}${btn("Save", { sm: true, type: "submit" })}</div>`,
    ]), { attrs: { "data-lead-identity": true } }) });
  // What the lead knows about this person: lines they confirmed in chat or wrote here. Every project, every chat.
  const about = data.about === undefined ? "" : settingsSection({ id: "lead-about", title: "What your lead knows about you",
    body: postForm("/settings/lead/about", joinHtml([
      formRow("About you", `One per line, up to ${ABOUT_YOU_MAX_LINES}. Used in every project and every chat.`, textarea({ id: "lead-about-text", name: "about", rows: Math.min(10, Math.max(4, data.about.length + 1)), value: data.about.join("\n"),
        attrs: { maxlength: ABOUT_YOU_MAX_LINES * (ABOUT_YOU_LINE_MAX + 1), placeholder: "Keep copy terse.\nI test changes myself.", "aria-label": "What your lead knows about you" } }), "top"),
      html`<div class="k-ssave">${savedLine(data.aboutSaved === true)}${btn("Save", { sm: true, type: "submit" })}</div>`,
    ]), { attrs: { "data-lead-about": true } }) });
  // Quick answers: plain status questions go to a faster model; anything that asks for a change stays on the main one.
  const quick = data.quick === undefined || config === null ? "" : settingsSection({ id: "lead-quick", title: "Quick answers",
    lead: config.provider === "claude-subscription"
      ? `Short questions about what's going on, like "what's running?", are answered by ${data.quick.model}, a faster model. Anything that asks for a change still goes to the lead's main model.`
      : "Short questions about what's going on can go to a faster model. This works only when the lead uses the Anthropic membership.",
    body: data.quick.canChange
      ? postForm("/settings/lead/quick", joinHtml([
          switchInput({ id: "lead-quick", name: "enabled", label: "Quick answers use a faster model", on: data.quick.on }),
          html`<div class="k-ssave">${savedLine(data.quick.saved)}${btn("Save", { sm: true, type: "submit" })}</div>`,
        ]), { attrs: { "data-lead-quick": true } })
      : note(data.quick.on ? "On." : "Off.") });
  // What the lead promised to follow up on; it reports each once, here in chat, and drops it after 7 days.
  const promises = (data.promises ?? []).length === 0 ? "" : settingsSection({ id: "lead-promises", title: "Promises", lead: "What the lead said it would follow up on. Each is reported once, then dropped after 7 days.",
    body: joinHtml(data.promises!.map(one => settingsRecord({
      title: one.what, sub: `${one.when.charAt(0).toUpperCase() + one.when.slice(1)} · until ${new Date(one.until).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`,
      action: postForm("/settings/lead/promise/cancel", btn("Cancel", { sm: true, type: "submit" }), { returnTo, hidden: { promise: one.id } }),
      attrs: { "data-promise": one.id },
    }))) });
  // D5: the lead's subagents, one line each; everything else about one is on its own page.
  const subagents = data.subagents === undefined ? "" : settingsSection({ id: "subagents", title: "Subagents",
    right: btn("Add subagent", { sm: true, href: "/settings/lead/subagents?add=1#add", attrs: { "data-add-subagent": true } }),
    body: data.subagents.length === 0 ? note("None yet. Your lead can ask one for help once it's here.")
      : html`<div class="k-slinks">${data.subagents.map(one => settingsLink({ href: `/settings/lead/subagents/${one.id}`, title: one.label, status: `${one.project}${one.paused ? " · Paused" : ""}` }))}</div>` });
  // The lead's own key: where each provider's key comes from (never the key), and Forget for a stored one.
  const keys = settingsSection({ id: "lead-key", title: "The lead's own key",
    lead: "A direct API key the lead uses instead of a membership. A pasted key is kept in a file only this account can read, never in the database, and never shown again. ANTHROPIC_API_KEY or OPENROUTER_API_KEY in the environment always wins.",
    body: joinHtml(facts.keyFacts.map(one => settingsRecord({
      title: one.provider,
      sub: one.state === "none" ? "No key yet" : one.state === "environment" ? "From the environment" : `stored ${one.tail ?? ""}`.trim(),
      action: one.state !== "stored" ? "" : kitSectionForm({ proof: "lead-config", action: "/chat/config", id: `lead-forget-${one.provider}`, hidden: { return: returnTo, "forget-key": one.provider },
        save: { label: "Forget", variant: "danger" }, confirm: `Forget the lead's own ${one.provider} key`, body: html`` }),
    }))) });
  const off = config === null ? "" : settingsSection({ id: "lead-off", title: "Turn the lead off",
    body: kitSectionForm({ proof: "lead-config", action: "/chat/config", id: "lead-off-form", hidden: { return: returnTo, off: "1" },
      save: { label: "Turn the lead off", variant: "danger" }, confirm: "Turn the lead off", body: note("The lead stops answering until you turn it on again.") }) });
  return settingsSubPage("agents", "Lead", joinHtml([
    data.problem ? notice(data.problem.charAt(0).toUpperCase() + data.problem.slice(1)) : data.said === null ? "" : html`<p class="k-notice info" role="status">${data.said}</p>`,
    runs, identity, about, quick, promises, subagents,
    disclose("Advanced", joinHtml([leadConfigForm(config, facts), keys, off])),
  ], "\n"));
}

/** The lead's full settings (Settings → Lead → Advanced): provider, model, limits and the lead's own key. */
export function leadConfigForm(current: import("../store.js").ChatConfig | null, data: LeadFormFacts): Html {
  const anthropicModels = PRICED_MODELS.filter(one => !one.includes("/"));
  const openrouterModels = data.openrouterModels ?? PRICED_MODELS.filter(one => one.includes("/"));
  const currentSubscription = current !== null && isSubscriptionChatProvider(current.provider);
  const labels = new Map((data.liveModels ?? []).map(one => [one.value, one.label]));
  const models = [...new Set(["default", ...labels.keys(), ...anthropicModels, ...openrouterModels, ...(current === null ? [] : [current.model])])];
  const keyWords = data.keyFacts.map(one => one.state === "none" ? `${one.provider}: none yet` : one.state === "environment" ? `${one.provider}: from the environment` : `${one.provider}: stored ${one.tail ?? ""}`.trim()).join(" · ");
  const body = joinHtml([
    formRow("Provider", null, select({ id: "lead-provider", name: "provider", label: "Provider", ...(current === null ? {} : { current: current.provider }), items: [
      ["codex-subscription", "Codex membership (signed-in CLI)"],
      ["claude-subscription", "Anthropic membership (signed-in CLI)"],
      ["anthropic-api", "Anthropic API (direct)"],
      ["openrouter-api", "OpenRouter API (direct)"],
    ] })),
    formRow("Model", "Use default for your membership's current model. A direct API model needs a pinned price.",
      html`${input({ id: "lead-model", name: "model", value: current?.model ?? "default", attrs: { list: "chat-models", "aria-label": "Model" } })}<datalist id="chat-models">\
${models.map(model => html`<option value="${model}">${labels.get(model) ?? ""}</option>`)}</datalist>`),
    note(data.openrouterModels === null
      ? "With OPENROUTER_API_KEY in the serve environment, this list becomes OpenRouter's full live catalog, each model priced by the party that bills it."
      : `${data.openrouterModels.length} models live from OpenRouter's catalog. Saving pins today's price; save again to pin it again.`),
    currentSubscription
      ? note("No dollar maximum. Membership chat uses the plan of the signed-in CLI; the conversation stays live until you end it, and the daily turn limit still applies.")
      : formRow("Weekly ceiling", "Direct API only, in dollars. Leave blank when choosing a membership.", input({ id: "lead-weekly", name: "weekly-usd", value: current === null ? "" : (current.weeklyCeilingMicrousd / 1_000_000).toFixed(2), attrs: { inputmode: "decimal", "aria-label": "Weekly ceiling" } })),
    formRow("Daily turns", "50 when left blank.", input({ id: "lead-turns", name: "daily-turns", value: current === null ? "" : String(current.dailyTurns), attrs: { inputmode: "numeric", "aria-label": "Daily turns" } })),
    currentSubscription
      ? note(html`Sign in on this computer first with ${current?.provider === "codex-subscription" ? html`<span class="k-mono">codex login</span>` : html`the <span class="k-mono">claude</span> CLI`}. Toolroll reuses that sign-in and never stores it.`)
      : formRow("The lead's own key", `Direct API only. Leave empty to keep the one you have. ${keyWords}.`,
        html`<input class="k-input" id="lead-own-key" type="password" name="key" autocomplete="off" spellcheck="false" autocapitalize="none" data-so-secret data-1p-ignore data-lpignore="${SECRET_OPT_OUTS["data-lpignore"]}" data-bwignore data-form-type="other" aria-label="The lead's own key" placeholder="Paste a key">`),
  ]);
  return settingsSection({ id: "lead-config", title: "Model and limits",
    lead: currentSubscription
      ? "The membership provider runs without repository tools, in a temporary directory. Only Toolroll can turn an action it proposes into a confirmation card."
      : "Changing these always asks for your password, typed.",
    body: kitSectionForm({ proof: "lead-config", action: "/chat/config", id: "lead-config-form", ...(current === null ? {} : { gate: true }), hidden: { return: data.returnTo },
      save: { label: current === null ? "Turn the lead on" : "Save" }, confirm: current === null ? "Turn the lead on" : "Change the lead's model and limits", body }) });
}

export function capsPage(chrome: Chrome, caps: Capability[] | null, gaps: Gap[], repo: string, now?: Date): Screen {
  if (caps === null) {
    return screen("requirements", settingsSubPage("approval", "Requirements", note(html`Open a project to see its requirements: <a class="k-link" href="/projects">Projects</a>.`)), { chrome });
  }
  const recorded = settingsSection({ id: "recorded", title: "Recorded",
    body: caps.length === 0 ? note("Nothing recorded.") : joinHtml(caps.map(capability => settingsRecord({
      title: html`<span class="k-mono">${capability.kind}:${capability.name}</span>`, sub: describeCapability(capability, now ?? new Date()),
    }))) });
  const missing = settingsSection({ id: "missing", title: "Missing", lead: "Ranked by what filling them frees.",
    body: gaps.length === 0 ? note("Nothing missing. Everything recorded is verified.") : joinHtml(gaps.map(gap => settingsRecord({
      title: html`<span class="k-mono">${gap.key}</span>${chip(gap.state)}`,
      sub: gap.unblocks.length > 0
        ? `Filling it starts ${gap.unblocks.length} task${gap.unblocks.length === 1 ? "" : "s"}: ${gap.unblocks.join(", ")}`
        : gap.alsoBlocks.length > 0 ? `Part of what holds ${gap.alsoBlocks.join(", ")}` : "Nothing queued needs it yet",
      more: facts([["Check", codeLine(gap.verify)], ["How to fill it", gap.instructions]]),
    }))) });
  return screen("requirements", settingsSubPage("approval", "Requirements", joinHtml([
    recorded, missing,
    note("Read-only here: the checks are shell commands you wrote, and a web button that runs them would need its own security review."),
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
