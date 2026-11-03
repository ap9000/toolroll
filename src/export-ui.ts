/**
 * Settings → Data (v105): an instance operator downloads everything Toolroll
 * knows as one .zip: the password (when the rules ask for it) and a button.
 * Built from the revamp kit; the Settings frame adds the title.
 */
import { html, joinHtml, type Html } from "./html.js";
import { codeLine, note, notice, settingsSection } from "./server/kit.js";
import { kitSectionForm } from "./settings-kit.js";

/** The page is kit pieces now; nothing of the old look is left. Kept as an export for the shared stylesheet. */
export const EXPORT_CSS = "";

export function dataExportHtml(said: { problem?: string | null }): Html {
  return settingsSection({ id: "data-export", title: "Download everything",
    lead: "Everything Toolroll knows, as one .zip: projects, tasks, runs and cost, the action ledger, evidence packs, chats, flows, subagents and settings. Passwords, keys and tokens are never included.",
    body: joinHtml([
      said.problem ? notice(said.problem) : "",
      // The answer is a download, not a page: post as a navigation.
      kitSectionForm({ proof: "data", action: "/settings/data", id: "data-form", download: true, save: { label: "Download export" }, body: html`` }),
      note("The same export from the command line:"),
      codeLine("toolroll export --out <path> [--zip]"),
    ]) });
}
