/**
 * Settings → Integrations: which integrations work. One record each: its name
 * and state, the account it's connected as, when it last worked and last
 * failed, what uses it, and one action. The list comes from saved checks; a
 * render never waits on one (see integrations.ts). Built from the revamp kit;
 * the Settings frame adds the title.
 */
import { html, joinHtml, postForm, type Html } from "./html.js";
import { STATE_WORDS, secretsNote, type Integration, type IntegrationGroup, type SecretsKept } from "./integrations.js";
import { whenUtc } from "./when-html.js";
import { brandMarkHtml } from "./brand-mark.js";
import { btn, chip, disclose, infoLine, note, notice, settingsRecord, settingsSection } from "./server/kit.js";

const when = (at: string) => whenUtc(at);

/** The page is kit pieces now; nothing of the old look is left. Kept as an export for the shared stylesheet. */
export const INTEGRATIONS_CSS = "";

const GROUPS: [IntegrationGroup, string][] = [
  ["chat", "Chat"], ["code", "Code and issues"], ["mail", "Email"], ["tools", "MCP tools"], ["monitoring", "Monitoring"], ["agents", "Agents"],
];

function action(one: Integration, csrf: string): Html | "" {
  const a = one.action;
  // One harmless read-only check of this integration, now (the handler sends nothing).
  if (a.kind === "test") {
    return csrf === "" ? "" : postForm("/settings/integrations/test", btn("Check connection", { sm: true, type: "submit" }), { hidden: { key: one.key } });
  }
  // A project's youiyoux requests: one switch for that project.
  if (a.kind === "switch") {
    return csrf === "" ? "" : postForm("/settings/integrations/youiyoux", btn(a.label, { sm: true, type: "submit" }),
      { hidden: { repo: a.repo, on: a.on ? "1" : "0" } });
  }
  // A command is run where Toolroll runs; a page is linked. Fix and Set up both say which.
  // Fix is the louder of the two; Set up stays quiet so a list of unused services doesn't shout.
  if (a.href !== null) return btn(a.label, { sm: true, href: a.href, variant: a.kind === "setup" ? "ghost" : "outline" });
  return "";
}

/** Which mark a row shows: email is Gmail's only when the account is a Gmail address; a custom tool is a letter. */
function markFor(one: Integration): string | null {
  if (one.custom) return null;
  return one.key === "email" && /@(gmail|googlemail)\.com$/i.test(one.account ?? "") ? "gmail" : one.key;
}

/** Its state as one of the kit's status chips: working, broken, not set up, or still being checked. */
function stateChip(one: Integration): Html {
  if (!one.checked && one.state === "connected") return chip("Checking", "live");
  return chip(STATE_WORDS[one.state], one.state === "connected" ? "done" : one.state === "broken" ? "failed" : "");
}

function row(one: Integration, csrf: string): Html {
  const facts = [one.account, one.detail, one.credentials].filter(Boolean).join(" · ");
  const command = one.action.kind === "setup" || one.action.kind === "fix" ? one.action.command : null;
  const words = one.action.kind === "fix" || one.action.kind === "switch" ? one.action.words : null;
  const fix = words !== null ? notice(words) : "";
  const run = command === null || (one.action.kind === "fix" && one.action.words.includes(command)) ? "" : note(html`Run <code class="k-mono">${command}</code> on the computer running Toolroll.`);
  const seen = [one.lastSuccessAt === null ? null : html`Last success ${when(one.lastSuccessAt)}`, one.usedBy.length === 0 ? null : html`Used by ${one.usedBy.join(", ")}`].filter(Boolean);
  const history = one.state === "not-set-up" || seen.length === 0 ? "" : note(joinHtml(seen, " · "));
  const lastError = one.lastError === null || one.state === "not-set-up" ? "" : one.state === "broken" && words === one.lastError
    ? note(html`Failed ${when(one.lastErrorAt ?? "")}`)
    : disclose(`Last error${one.lastErrorAt === null ? "" : ` ${one.lastErrorAt.slice(0, 16).replace("T", " ")} UTC`}`, note(one.lastError));
  const more = joinHtml([fix, run, history, lastError]);
  return settingsRecord({ title: html`${brandMarkHtml(markFor(one), one.name, one.state === "connected")}<span>${one.name}</span> ${stateChip(one)}`,
    sub: facts, action: action(one, csrf), attrs: { "data-integration": one.key, "data-state": one.state }, more });
}

export function integrationsHtml(list: readonly Integration[], csrf: string, said: { said?: string | null; problem?: string | null; checking?: boolean; secrets?: SecretsKept }): Html {
  const answer = said.problem ? notice(said.problem) : said.said ? infoLine(said.said) : "";
  const broken = list.filter(one => one.state === "broken").length;
  const summary = broken > 0 ? html`<p class="k-note"><b>${broken} need${broken === 1 ? "s" : ""} fixing.</b></p>`
    : said.checking || list.some(one => !one.checked) ? html`<p class="k-note" role="status">Checking in the background. Refresh in a few seconds.</p>` : "";
  // No keychain here, or Toolroll's folder for secrets can't be used: said once, plainly.
  const kept = secretsNote(list, said.secrets);
  const secrets = kept === null ? "" : kept.problem ? notice(kept.words) : html`<p class="k-note" role="note">${kept.words}</p>`;
  const sections = GROUPS.map(([group, title]) => {
    const rows = list.filter(one => one.group === group);
    return rows.length === 0 ? "" : settingsSection({ id: `integrations-${group}`, title, body: joinHtml(rows.map(one => row(one, csrf))) });
  });
  return joinHtml([answer, summary, secrets, ...sections]);
}
