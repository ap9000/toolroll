/**
 * People → a person: their API tokens, each with its standing and last use, and their recent remote actions
 * (remote-audit.ts). A token's name filters the actions to it (`token-name`: a `token` query is always refused). Read-only: making, revoking and rotating tokens stay
 * in Settings → Sessions & tokens. Never a token's secret or a ledger line's raw detail.
 */
import { settingsSubPage } from "./settings-groups-ui.js";
import { basename } from "node:path";
import { tokenStatus, type AuditAction } from "./remote-audit.js";
import type { ApiTokenRow } from "./store.js";
import { html, joinHtml, type Html } from "./html.js";
import { acts, btn, chip, note, settingsRecord, settingsSection } from "./server/kit.js";

const stamp = (value: string) => `${value.slice(0, 16).replace("T", " ")} UTC`;

/** The old look; the page is built from the kit now. Kept for chrome.ts, which still concatenates it. */
export const PEOPLE_AUDIT_CSS = "";

export type PersonAuditView = {
  name: string;
  tokens: readonly ApiTokenRow[];
  actions: readonly AuditAction[];
  /** The token name the actions are filtered to, if any. */
  token: string | null;
  nextCursor: string | null;
  now: Date;
};

export const personHref = (name: string, more: Record<string, string> = {}) => `/people?${new URLSearchParams({ person: name, ...more }).toString()}`;

export function personAuditHtml(view: PersonAuditView): Html {
  const tokens = settingsSection({ id: "person-tokens", title: "API tokens", lead: "Make, revoke and rotate tokens in Sessions and tokens.",
    body: view.tokens.length === 0 ? note("No API tokens.") : joinHtml(view.tokens.map(one => {
      const status = tokenStatus(one, view.now);
      return settingsRecord({
        title: html`<a class="k-link" href="${personHref(view.name, { "token-name": one.name })}">${one.name}</a>`,
        sub: `${status === "active" ? "Active" : status === "expired" ? "Expired" : "Revoked"} · ${one.access === "act" ? "Can act" : "Read only"} · last used ${one.lastUsedAt === null ? "never" : stamp(one.lastUsedAt)}`,
        attrs: { "data-token-name": one.name },
      });
    })) });
  const filtered = view.token === null ? undefined : btn("All tokens", { sm: true, variant: "ghost", href: personHref(view.name) });
  const older = view.nextCursor === null ? "" : acts(btn("Older actions", { sm: true, href: personHref(view.name, { ...(view.token === null ? {} : { "token-name": view.token }), before: view.nextCursor }) }));
  const activity = settingsSection({ id: "person-activity", title: "Remote activity", ...(view.token === null ? {} : { state: ` · with ${view.token}` }), ...(filtered ? { right: filtered } : {}),
    lead: "What this person did through the toolroll command and agents (MCP), newest first.",
    body: joinHtml([view.actions.length === 0 ? note(`No remote actions${view.token === null ? "" : " with this token"}.`) : joinHtml(view.actions.map(actionHtml)), older]) });
  return settingsSubPage("access", view.name, joinHtml([note(html`<a class="k-link" href="/people">All people</a>`), tokens, activity]));
}

function actionHtml(action: AuditAction): Html {
  const outcome = action.outcome === "ok" ? chip("OK", "done") : action.outcome === "refused" ? chip("Refused", "") : chip("Error", "failed");
  const detail = [stamp(action.at), action.token ?? "unknown token", action.source === "mcp" ? "Agent (MCP)" : "CLI",
    ...(action.repo === null ? [] : [basename(action.repo)]), ...(action.reason === null ? [] : [action.reason])];
  return settingsRecord({
    title: html`${outcome} ${action.name}${action.taskId === null ? "" : html` · <a class="k-link" href="/t/${encodeURIComponent(action.taskId)}">${action.taskId}</a>`}`,
    sub: detail.join(" · "), attrs: { "data-action": action.id },
  });
}
