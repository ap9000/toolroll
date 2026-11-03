/**
 * Settings → Backups (sprint 8): how the last backup went and one button to
 * back up now, then the schedule, past backups and how to restore. Built from
 * the revamp kit (src/design/KIT.md); the Settings frame adds the title.
 */
import { html, joinHtml, postForm, type Html } from "./html.js";
import type { BackupRun, BackupSettings, LiveBackupState } from "./store.js";
import { bytesWords } from "./storage.js";
import { whenUtc } from "./when-html.js";
import { btn, chip, codeLine, formRow, infoLine, input, note, notice, select, settingsRecord, settingsSection } from "./server/kit.js";
import { kitSectionForm } from "./settings-kit.js";

/** The schedules on offer and the most copies kept. Here rather than in backup.ts so the page never loads `node:sqlite`. */
export const BACKUP_EVERY_HOURS = [1, 6, 12, 24] as const;
/** The continuous copy's choices, in minutes (live-backup.ts LIVE_EVERY_MINUTES; here so the page never loads it). */
export const LIVE_EVERY = [1, 5, 15, 30] as const;
export const MAX_KEEP = 100;

const when = (at: string) => whenUtc(at);
const whenWords = (at: string) => `${at.slice(0, 16).replace("T", " ")} UTC`;
const everyWords = (hours: number) => hours === 1 ? "Every hour" : hours === 24 ? "Every day" : `Every ${hours} hours`;
const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** The page is kit pieces now; nothing of the old look is left. Kept as an export for the shared stylesheet. */
export const BACKUP_CSS = "";

export type BackupView = { settings: BackupSettings; folder: string; defaultFolder: string; runs: BackupRun[]; csrf: string; now: Date;
  /** The continuous copy (live-backup.ts): its settings, latest verified copy and folder. */
  live?: { state: LiveBackupState; folder: string; defaultFolder: string } };

/** The continuous copy in one line: its latest verified copy, or why there is none. */
function liveLine(view: BackupView): Html | string {
  const live = view.live;
  if (live === undefined) return "";
  if (!live.state.settings.enabled) return note("Continuous copy is off.");
  if (live.state.problem !== null) return notice(`The continuous copy failed: ${live.state.problem}`);
  if (live.state.latest === null) return note("The first continuous copy is made within a few minutes of Toolroll starting.");
  return html`<p class="k-note" data-live-copy>Continuous copy checked ${when(live.state.latest.madeAt)}, every ${live.state.settings.everyMinutes === 1 ? "minute" : `${live.state.settings.everyMinutes} minutes`}.</p>`;
}

/** The last backup as one record: what happened, the next one, and Back up now. */
function state(view: BackupView): Html {
  const last = view.runs[0];
  const good = view.runs.find(one => one.ok === true);
  const next = !view.settings.enabled ? "Scheduled backups are off."
    : good === undefined ? "The first scheduled backup runs within a minute or two of the console starting."
    : `Next one about ${whenWords(new Date(Date.parse(good.startedAt) + view.settings.everyHours * 3_600_000).toISOString())}.`;
  const now = postForm("/settings/backups/now", btn("Back up now", { sm: true, type: "submit" }));
  if (last === undefined) return settingsRecord({ title: "No backups yet", sub: next, action: now });
  if (last.ok === null) return settingsRecord({ title: html`Backing up ${chip("Running", "live")}`, sub: html`Started ${when(last.startedAt)}.`, action: now });
  if (last.ok === false) {
    return settingsRecord({ title: html`Last backup failed ${chip("Failed", "failed")}`, attrs: { "data-backup-state": "failed" }, action: now,
      sub: html`${good === undefined ? "No backup has succeeded yet." : html`Last good backup ${when(good.startedAt)}.`} ${next}`,
      more: notice(html`${when(last.startedAt)}: ${last.error ?? "no reason was recorded"}`) });
  }
  return settingsRecord({ title: html`Backed up ${when(last.startedAt)}`, attrs: { "data-backup-state": "ok" }, action: now,
    sub: `${last.bytes === null ? "" : `${bytesWords(last.bytes)} · `}${next}` });
}

/** One past backup: when, how it went, its file, and whether it was by hand. */
function runRow(run: BackupRun): Html {
  const how = run.trigger === "manual" ? "By hand" : "Scheduled";
  const attrs = { "data-backup-run": run.id };
  if (run.ok === true) {
    return settingsRecord({ title: when(run.startedAt), attrs, when: chip("Finished", "done"),
      sub: html`${how}${run.bytes === null ? "" : ` · ${bytesWords(run.bytes)}`}${run.file === null ? "" : html` · <span class="k-mono">${fileName(run.file)}</span>`}` });
  }
  if (run.ok === false) return settingsRecord({ title: when(run.startedAt), attrs, when: chip("Failed", "failed"), sub: `${how} · ${run.error ?? "no reason recorded"}` });
  return settingsRecord({ title: when(run.startedAt), attrs, when: chip("Running", "live"), sub: how });
}

export function backupHtml(view: BackupView, said: { said?: string | null; problem?: string | null }): Html {
  const s = view.settings;
  const answer = said.problem ? notice(said.problem) : said.said ? infoLine(said.said) : "";
  const now = settingsSection({ id: "backup-now", title: "Last backup", body: joinHtml([answer, state(view), liveLine(view)]) });
  const every = select({ id: "backup-every", name: "every", label: "Back up", current: s.enabled ? String(s.everyHours) : "off",
    items: [["off", "Off"], ...BACKUP_EVERY_HOURS.map(hours => [String(hours), everyWords(hours)] as const)] });
  const schedule = settingsSection({ id: "backup-schedule", title: "Schedule", lead: "Only the database is copied: provider keys and sign-in files stay out.",
    body: kitSectionForm({ proof: "backups", action: "/settings/backups", id: "backup-form", gate: true,
      body: joinHtml([
        formRow("Back up", null, every, "inline"),
        formRow("Keep the newest", "How many backups to keep. Older ones are removed.", input({ id: "backup-keep", name: "keep", type: "number", value: String(s.keep),
          attrs: { min: 1, max: MAX_KEEP, step: 1, required: true, "aria-label": "Keep the newest" } }), "inline"),
        formRow("Folder", "Blank: the default folder.", input({ id: "backup-folder", name: "folder", value: s.folder ?? "",
          attrs: { placeholder: view.defaultFolder, spellcheck: "false", "aria-label": "Folder" } })),
        liveFields(view),
      ]) }) });
  const runs = view.runs.map(runRow);
  const history = settingsSection({ id: "backup-history", title: "Past backups", state: view.runs.length === 0 ? "" : ` · ${view.runs.length}`,
    lead: html`In <span class="k-mono">${view.folder}</span>.`,
    body: runs.length === 0 ? note("None yet.") : joinHtml(runs) });
  const restore = settingsSection({ id: "backup-restore", title: "Restore a backup", lead: "Stop Toolroll, then run:",
    body: joinHtml([
      codeLine("toolroll restore <file> --dry-run"),
      note(html`The dry run checks the backup (its version and ledger chain) and changes nothing. Run it again without <code class="k-mono">--dry-run</code> to restore; the current database is kept as a copy first.`),
      view.live === undefined ? "" : note(html`Continuous copies are in <span class="k-mono">${view.live.folder}</span>; restore one the same way.`),
    ]) });
  return joinHtml([now, schedule, history, restore]);
}

/** The continuous copy's two choices, beside the schedule's: how often, and where (blank: beside the database). */
function liveFields(view: BackupView): Html | string {
  const live = view.live;
  if (live === undefined) return "";
  const on = live.state.settings;
  const every = select({ id: "backup-live-every", name: "live_every", label: "Copy continuously", current: on.enabled ? String(on.everyMinutes) : "off",
    items: [["off", "Off"], ...LIVE_EVERY.map(minutes => [String(minutes), minutes === 1 ? "Every minute" : `Every ${minutes} minutes`] as const)] });
  return joinHtml([
    formRow("Copy continuously", "A checked copy of the database every few minutes, between backups.", every, "inline"),
    formRow("Copy folder", "Blank: beside the database.", input({ id: "backup-live-folder", name: "live_folder", value: on.folder ?? "",
      attrs: { placeholder: live.defaultFolder, spellcheck: "false", "aria-label": "Copy folder" } })),
  ]);
}
