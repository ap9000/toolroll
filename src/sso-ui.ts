/**
 * Settings → Sign-in (v100): the identity provider, the groups that may sign
 * in and what each may do, and who may still use a password. An instance
 * operator's page; changes take their password.
 */
import type { OidcSettings } from "./oidc.js";
import { html, joinHtml, postForm, type Html } from "./html.js";
import { acts, btn, codeLine, disclose, formRow, infoLine, input, note, notice, radios, select, settingsSection } from "./server/kit.js";
import { kitSectionForm, SECRET_OPT_OUTS } from "./settings-kit.js";

/** The old card look; the page is built from the kit now. Kept for chrome.ts, which still concatenates it. */
export const SSO_CSS = "";

export type SsoSettingsView = {
  settings: OidcSettings | null;
  /** The address to register with the provider as this app's sign-in redirect. */
  redirect: string | null;
  projects: { path: string; name: string }[];
  /** Whether the person looking is linked to the provider already. */
  linked: boolean;
};

/** Whether an address only this computer can open (localhost, 127.x, ::1): a provider can't send people back to it. */
export function loopbackAddress(address: string): boolean {
  let host: string;
  try { host = new URL(address).hostname.toLowerCase(); } catch { return false; }
  return host === "localhost" || host.endsWith(".localhost") || /^127(\.\d{1,3}){3}$/.test(host) || host === "[::1]" || host === "::1" || host === "0.0.0.0";
}

function ruleRow(index: number, rule: OidcSettings["rules"][number] | null, projects: SsoSettingsView["projects"]): Html {
  const chosen = rule === null ? [] : rule.projects === "all" ? ["all"] : rule.projects;
  const id = `sso-rule-${index}`;
  const box = (value: string, label: string, at: number) =>
    html`<label for="${id}-p${at}"><input type="checkbox" id="${id}-p${at}" name="projects-${index}" value="${value}"${chosen.includes(value) ? html` checked` : ""}> ${label}</label>`;
  return formRow(`Rule ${index + 1}`, index === 0 ? "The first rule that matches a person decides." : null, joinHtml([
    input({ id: `${id}-group`, name: `group-${index}`, value: rule?.group ?? "", attrs: { placeholder: index === 0 ? "Group, for example: engineering" : "Group", autocomplete: "off", "aria-label": `Rule ${index + 1} group` } }),
    select({ id: `${id}-role`, name: `role-${index}`, label: `Rule ${index + 1} role`, current: rule?.role ?? "operator", items: [["operator", "Can manage and approve"], ["viewer", "Can view"]] }),
    html`<div class="k-checks" role="group" aria-label="Rule ${index + 1} projects">${box("all", "All projects", 0)}${projects.map((one, at) => box(one.path, one.name, at + 1))}</div>`,
  ]), "wide");
}

export function ssoSettingsHtml(view: SsoSettingsView, outcome: { said?: string | null; problem?: string | null }): Html {
  const s = view.settings;
  const answer = outcome.problem ? notice(outcome.problem) : outcome.said ? infoLine(outcome.said) : "";
  const rows = [...(s?.rules ?? []), null, null].slice(0, Math.max(3, (s?.rules.length ?? 0) + 1)).map((rule, index) => ruleRow(index, rule, view.projects));
  const redirect = view.redirect === null
    ? note("Open this page from the address people use (your https address) to see the redirect address to register.")
    : joinHtml([
      formRow("Redirect address", "Register this with the provider as the sign-in redirect.", codeLine(view.redirect), "wide"),
      loopbackAddress(view.redirect)
        ? infoLine("This page is open on a local address, which only this computer can reach, so a provider can’t send people back to it. Open this page from the address people use (your https address) and register that one instead.")
        : "",
    ]);
  const check = s === null ? "" : postForm("/settings/sign-in", acts(btn("Check the provider", { sm: true, type: "submit" })), { hidden: { action: "test" } });
  const provider = settingsSection({ id: "provider", title: "Provider", state: s === null ? " · off" : ` · ${s.label}`,
    lead: "People sign in with your organisation’s identity provider (Okta, Microsoft Entra, Google, anything that speaks OpenID Connect), and its groups decide what they may do.",
    body: joinHtml([redirect,
      kitSectionForm({ proof: "sign-in", action: "/settings/sign-in", id: "sign-in-form", gate: s !== null, hidden: { action: "save" },
        save: { label: s === null ? "Turn on sign-in with the provider" : "Save" }, confirm: s === null ? "Turn on sign-in with the provider" : "Change sign-in with the provider",
        body: joinHtml([
          formRow("Provider address (issuer)", null, input({ id: "sso-issuer", name: "issuer", type: "url", value: s?.issuer ?? "", attrs: { placeholder: "https://acme.okta.com/oauth2/default", required: true, inputmode: "url", autocomplete: "off" } })),
          formRow("Client ID", null, input({ id: "sso-client-id", name: "client-id", value: s?.clientId ?? "", attrs: { required: true, autocomplete: "off" } })),
          formRow("Client secret", s?.clientSecret ? "Saved. Leave blank to keep it." : "Leave blank for a public client.",
            input({ id: "sso-client-secret", name: "client-secret", type: "password", attrs: { autocomplete: "off", ...SECRET_OPT_OUTS, "aria-label": "Client secret" } })),
          disclose("More", joinHtml([
            formRow("Button says “Sign in with …”", null, input({ id: "sso-label", name: "label", value: s?.label ?? "", attrs: { placeholder: "Okta" } })),
            formRow("Scopes", null, input({ id: "sso-scopes", name: "scopes", value: s?.scopes ?? "openid email profile" })),
            formRow("Groups claim", null, input({ id: "sso-groups-claim", name: "groups-claim", value: s?.groupsClaim ?? "groups" })),
          ])),
          formRow("Who may sign in", "A person’s first matching group sets their role and projects, again at every sign-in. No match, no entry. Use * for everyone.", html``, "wide"),
          ...rows,
          formRow("Passwords", null, radios({ name: "passwords", legend: "Passwords", current: s?.passwords === "operators" ? "operators" : "everyone", items: [
            { value: "everyone", label: "Everyone may still use a password" },
            { value: "operators", label: "Only instance operators", text: "A way in if the provider is down." }] }), "wide"),
        ]) }),
      check,
    ]) });
  const account = s === null ? "" : settingsSection({ id: "your-account", title: "Your account",
    body: view.linked ? note(`You sign in with ${s.label}.`)
      : joinHtml([note(`Sign in with ${s.label} as this account from now on.`), acts(btn(`Link to ${s.label}`, { sm: true, href: "/login/sso?link=1" }))]) });
  const off = s === null ? "" : settingsSection({ id: "turn-off", title: "Turn off",
    body: kitSectionForm({ proof: "sign-in", action: "/settings/sign-in", id: "sign-in-off", hidden: { action: "remove" }, save: { label: `Turn off sign-in with ${s.label}`, variant: "danger" },
      confirm: `Turn off sign-in with ${s.label}`, body: note(`People who signed in with ${s.label} can’t sign in until it’s on again, unless they have a password.`) }) });
  return joinHtml([answer, provider, account, off]);
}
