/**
 * Settings → Sessions & tokens (v101): where you're signed in (sign any of
 * them out), and your API tokens (make one, revoke one). An instance operator
 * can see and end everyone's.
 */
import type { ApiTokenRow, WebSessionRow } from "./store.js";
import { daysLeft, expiryNoticeDue, TOKEN_DAYS, tokenLive } from "./api-tokens.js";
import { projectName } from "./project.js";
import { html, joinHtml, postForm, type Html } from "./html.js";
import { acts, btn, chip, disclose, formRow, infoLine, input, note, notice, select, settingsRecord, settingsSection } from "./server/kit.js";
import { kitSectionForm } from "./settings-kit.js";
import { settingsSubPage } from "./settings-groups-ui.js";


/** The old card look; the page is built from the kit now (src/server/kit.ts), so nothing is left to style. Kept for
 * chrome.ts, which still concatenates it. */
export const CREDENTIALS_CSS = "";

/** "Chrome on macOS", from a user agent, for a person to recognise a session. */
export function deviceWords(agent: string | null): string {
  if (agent === null || agent === "") return "Unknown device";
  const browser = /Edg\//.test(agent) ? "Edge" : /Firefox\//.test(agent) ? "Firefox" : /Chrome\//.test(agent) ? "Chrome" : /Safari\//.test(agent) ? "Safari" : /curl|node|undici|python|Go-http/i.test(agent) ? "A script" : "A browser";
  const system = /iPhone|iPad/.test(agent) ? "iPhone or iPad" : /Android/.test(agent) ? "Android" : /Mac OS X|Macintosh/.test(agent) ? "macOS" : /Windows/.test(agent) ? "Windows" : /Linux/.test(agent) ? "Linux" : null;
  return system === null ? browser : `${browser} on ${system}`;
}

const when = (value: string | number | null, now: number) => {
  if (value === null) return "never";
  const at = typeof value === "number" ? value : Date.parse(value);
  const minutes = Math.round((now - at) / 60_000);
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : minutes < 60 * 24 ? `${Math.round(minutes / 60)} h ago` : new Date(at).toISOString().slice(0, 10);
};

export type CredentialsView = {
  who: string; everyone: boolean; canSeeEveryone: boolean;
  sessions: (WebSessionRow & { here: boolean })[];
  tokens: ApiTokenRow[];
  now: number;
  /** Request limits (request-budget-ui.ts): words for each token's line, and the operator's disclosure. */
  limits?: { note: (token: ApiTokenRow) => string; section: Html };
};

export function credentialsHtml(view: CredentialsView, outcome: { said?: string | null; problem?: string | null }): Html {
  // An act on this page (sign out, revoke): one button, nothing to prove (the proof row covers only making a token).
  const act = (fields: Record<string, string>, label: string, variant: "outline" | "danger" = "outline") =>
    postForm("/settings/sessions", btn(label, { sm: true, type: "submit", variant }), { hidden: { ...fields, ...(view.everyone ? { everyone: "1" } : {}) } });
  const answer = outcome.problem ? notice(outcome.problem) : outcome.said ? infoLine(outcome.said) : "";
  const toggle = view.canSeeEveryone ? btn(view.everyone ? "Show only mine" : "Show everyone’s", { sm: true, variant: "ghost", href: `/settings/sessions${view.everyone ? "" : "?everyone=1"}` }) : undefined;
  const others = view.sessions.filter(one => !one.here && one.account === view.who).length;
  const endOthers = others > 0 && !view.everyone ? acts(act({ action: "end-others" }, `Sign out everywhere else (${others})`)) : "";
  const sessions = settingsSection({ id: "signed-in", title: "Signed in", ...(toggle ? { right: toggle } : {}),
    body: joinHtml([
      view.sessions.length === 0 ? note("No one else is signed in.") : joinHtml(view.sessions.map(one => settingsRecord({
        title: html`${view.everyone ? html`<b>${one.account}</b> · ` : ""}${deviceWords(one.agent)}${one.here ? html` ${chip("This browser", "")}` : ""}`,
        sub: `${one.ssoAt === null ? "Password" : "Identity provider"} · ${one.address ?? "unknown address"} · signed in ${when(one.createdAt, view.now)}`,
        when: `Active ${when(one.lastSeen, view.now)}`,
        action: one.here ? "" : act({ action: "end-session", session: one.idHash }, "Sign out"),
        attrs: { "data-session": one.idHash.slice(0, 12) },
      }))),
      endOthers,
    ]) });
  const live = view.tokens.filter(one => tokenLive(one, view.now));
  // v111: its projects, and one state: when it stops (soon, said once) or, once replaced, when it ends.
  const ends = (one: ApiTokenRow): string => {
    if (one.replacedBy !== null && one.overlapUntil !== null) return `Replaced · stops ${one.overlapUntil.slice(11, 16)} UTC`;
    if (expiryNoticeDue(one, view.now) === null) return `Expires ${one.expiresAt.slice(0, 10)}`;
    const days = daysLeft(one.expiresAt, view.now);
    return `Expires ${days <= 1 ? "within a day" : `in ${days} days`}`;
  };
  const scope = (one: ApiTokenRow) => one.projects === null ? "All projects" : one.projects.length === 0 ? "No projects" : one.projects.map(repo => projectName(repo)).join(", ");
  const create = disclose("New API token", kitSectionForm({ proof: "sessions-token", action: "/settings/sessions", id: "token-form", native: true, hidden: { action: "create-token" },
    save: { label: "Make the token" }, confirm: "Make an API token",
    body: joinHtml([
      formRow("Name", "So you can tell it apart later.", input({ id: "token-name", name: "name", attrs: { maxlength: 60, required: true, placeholder: "for example: CI", autocomplete: "off" } })),
      formRow("It can", null, select({ id: "token-access", name: "access", label: "It can", current: "read",
        items: [["read", "Read (tasks, results, the ledger)"], ["act", "Act as you (file and manage work; never approve)"]] })),
      formRow("Expires in", null, select({ id: "token-days", name: "days", label: "Expires in", current: "90", items: TOKEN_DAYS.map(days => [String(days), `${days} days`] as const) })),
      note("Making a token is a new way in, so it always asks for your password. The token is shown once, on the next page."),
    ]) }), live.length === 0);
  const tokens = settingsSection({ id: "api-tokens", title: "API tokens",
    lead: html`For scripts and CI: send <code class="k-mono">Authorization: Bearer &lt;token&gt;</code>. A token can’t approve anything.`,
    body: joinHtml([
      live.length === 0 ? note("No API tokens.") : joinHtml(live.map(one => settingsRecord({
        title: html`${view.everyone ? html`<b>${one.account}</b> · ` : ""}${one.name}`,
        sub: `${one.access === "act" ? "Can act" : "Read only"} · ${scope(one)} · ${ends(one)}${view.limits === undefined ? "" : ` · ${view.limits.note(one)}`}`,
        when: `Last used ${when(one.lastUsedAt, view.now)}`,
        action: act({ action: "revoke-token", token: one.id }, "Revoke", "danger"),
        attrs: { "data-token": one.id },
      }))),
      view.everyone ? "" : create,
    ]) });
  return joinHtml([answer, sessions, tokens, view.limits?.section ?? ""]);
}

/** The token, once, on a page with no script: selectable text, what it may do, and where to revoke it. */
export function tokenShownHtml(name: string, token: string, access: "read" | "act", expiresAt: string): Html {
  return settingsSubPage("access", "API token", settingsSection({ id: "token-shown", title: `${name} · shown once, so copy it now`,
    lead: "Only a hash is kept, so this page is the only time you’ll see it.",
    body: joinHtml([
      html`<p class="k-secret-val">${token}</p>`,
      note(`${access === "act" ? "It acts as you and never approves" : "It reads"} until ${expiresAt.slice(0, 10)}. Revoke it any time on Sessions and tokens.`),
      acts(btn("Back to Sessions and tokens", { sm: true, href: "/settings/sessions" })),
    ]) }));
}
