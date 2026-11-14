/**
 * The settings script inventory (settings plan v2 §2.4): every page script a Settings page carries today, listed apart
 * from proofs (settings-proofs.ts). A merged area page carries none (`functional` empty); each script moves, with the
 * act that needs it, to that act's change document, so the page it rides is always its own document and never changes
 * in place. Data only: settings-scripts.test.ts pins each row to the handler that sends the script today.
 */

export type ScriptRow = {
  /** Stable id. */
  readonly id: string;
  /** What the script does, in words. */
  readonly does: string;
  /** The exported name the page's handler sends (the module it comes from, relative to src/). */
  readonly symbol: string;
  readonly module: string;
  /** The route row whose page sends it today (at 271c93e1). */
  readonly today: string;
  /** The section whose change document will carry it (settings-section-table.ts), and the slice that moves it. */
  readonly section: string;
  readonly slice: string;
  /** It fetches from the page (the CSP's connect-src opens for it). */
  readonly fetches: boolean;
  /** Anything else the move must keep, in words. */
  readonly keep?: string;
};

export const SCRIPT_INVENTORY: readonly ScriptRow[] = Object.freeze([
  { id: "skills", does: "Filters skills, and packages a chosen folder's files into the import form", symbol: "skillsScript", module: "skills-ui.ts", today: "settings.skills", section: "skills", slice: "F5", fetches: false,
    keep: "folder import works only with the script (verified with JavaScript on); paste and GitHub import work without it" },
  { id: "updates", does: "Polls an update in progress and shows its steps", symbol: "updatesScript", module: "toolroll-update-ui.ts", today: "settings.updates", section: "updates", slice: "S1", fetches: true,
    keep: "an admitted /settings/updates?fragment=steps endpoint (or a retargeted poller) stays when the page retires (round 2, change 3)" },
  { id: "spend", does: "The monthly limit form's live amount and stop choice", symbol: "spendScript", module: "spend-ui.ts", today: "spend", section: "spend-limit", slice: "S2", fetches: false,
    keep: "/spend joins in-place only once the form and this script are on the spend-limit change document" },
  { id: "openrouter-picker", does: "Searches OpenRouter's model catalog in project setup", symbol: "openRouterPickerScript", module: "openrouter-models.ts", today: "control", section: "builder", slice: "P5", fetches: false },
  { id: "models", does: "The models page's choices and preview", symbol: "modelsScript", module: "models-ui.ts", today: "settings.models", section: "models", slice: "F4", fetches: false },
  { id: "tools", does: "Saves a tool's settings as they change, and switches project", symbol: "TOOLS_PROJECT_SCRIPT", module: "tools-ui.ts", today: "settings.tools", section: "tools", slice: "P4", fetches: false,
    keep: "kit and connect links lead to the tools change document, which owns the script (round 2, change 4)" },
  { id: "push", does: "Enrolls this device for alerts (a service worker and a push subscription)", symbol: "pushScriptOf", module: "settings-groups-ui.ts", today: "settings.group-alerts", section: "this-device", slice: "C1", fetches: true },
  { id: "hub-anchors", does: "Forwards the overview's old #anchors to their group pages", symbol: "HUB_ANCHOR_SCRIPT", module: "settings-groups-ui.ts", today: "settings.page", section: "home", slice: "D", fetches: false,
    keep: "replaced by the retired-address resolvers once every anchor's page is an area" },
] satisfies ScriptRow[]);
