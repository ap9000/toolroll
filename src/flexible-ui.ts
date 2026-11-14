/**
 * Settings → Project → How work starts (flexible.ts, the Flexible plan v2 slice F1). Drawn only when the page has a
 * Flexible view, which flexibleSettingsView gives only while this build offers Flexible (FLEXIBLE_AVAILABLE); the
 * handler refuses every post otherwise. Turning it on shows the terms in full before the password, and signs exactly
 * those (the hidden digest). Lowering and turning off are one click.
 */
import { FLEXIBLE_LAPSE_WORDS, FLEXIBLE_LEVEL_WORDS, FLEXIBLE_LEVELS, flexibleTermsWords, type FlexibleSettingsView, type FlexibleTerms } from "./flexible.js";
import { html, joinHtml, postForm, type Html } from "./html.js";
import { acts, btn, disclose, formRow, note, notice, select, settingsSection } from "./server/kit.js";
import { kitSectionForm } from "./settings-kit.js";

const ACTION = "/settings/project/flexible";
const termsList = (terms: FlexibleTerms): Html => html`<ul class="k-note">${flexibleTermsWords(terms).map(line => html`<li>${line}</li>`)}</ul>`;

/** The ceremony: the terms in full, then the password. */
function enableForm(view: FlexibleSettingsView, label: string): Html {
  if ("problem" in view.proposal) return note(view.proposal.problem);
  return kitSectionForm({ proof: "project-flexible", action: ACTION, id: "flexible-on", native: true, hidden: { repo: view.repo, action: "enable", digest: view.proposal.digest },
    save: { label }, confirm: "Turn on Flexible",
    body: joinHtml([termsList(view.proposal.terms), note("Turning this on asks for your password, every time.")]) });
}

function lowerAndOff(view: FlexibleSettingsView, terms: FlexibleTerms | null): Html {
  const below = terms === null ? [] : FLEXIBLE_LEVELS.slice(0, FLEXIBLE_LEVELS.indexOf(terms.max));
  return joinHtml([
    below.length === 0 ? "" : postForm(ACTION, joinHtml([
      formRow("Highest level", null, select({ id: "flexible-max", name: "max", items: below.map(level => [level, FLEXIBLE_LEVEL_WORDS[level]] as const), current: below.at(-1)!, sm: true }), "inline"),
      acts(btn("Lower", { sm: true, type: "submit" })),
    ]), { hidden: { repo: view.repo, action: "lower" } }),
    postForm(ACTION, acts(btn("Turn off Flexible", { sm: true, type: "submit" })), { hidden: { repo: view.repo, action: "off" } }),
  ]);
}

export function flexibleSettingsHtml(view: FlexibleSettingsView | undefined): Html | "" {
  if (view === undefined) return "";
  const standing = view.standing;
  const changer = view.canChange ? null : note("An approver for this project can change this.");
  if (standing.state === "secure") {
    return settingsSection({ id: "flexible", title: "How work starts", state: " · Secure", lead: "Work is planned and approved before it starts.",
      body: changer ?? disclose("Turn on Flexible", enableForm(view, "Turn on Flexible")) });
  }
  if (standing.state === "unreadable") {
    return settingsSection({ id: "flexible", title: "How work starts", state: " · Unavailable", lead: notice("This project's Flexible terms can't be read, so they allow nothing."),
      body: changer ?? lowerAndOff(view, null) });
  }
  if (standing.state === "lapsed") {
    return settingsSection({ id: "flexible", title: "How work starts", state: " · Flexible terms ended", lead: notice(`${FLEXIBLE_LAPSE_WORDS[standing.reason]} No new Flexible threads start.`),
      body: changer ?? joinHtml([disclose("Turn on again", enableForm(view, "Turn on again")), lowerAndOff(view, null)]) });
  }
  return settingsSection({ id: "flexible", title: "How work starts", state: ` · Flexible, up to ${FLEXIBLE_LEVEL_WORDS[standing.terms.max]}`,
    lead: `Agent threads start at once, at ${FLEXIBLE_LEVEL_WORDS[standing.terms.default]}. Turned on by ${standing.signedBy}.`,
    body: joinHtml([disclose("Terms", termsList(standing.terms)), changer ?? lowerAndOff(view, standing.terms)]) });
}
