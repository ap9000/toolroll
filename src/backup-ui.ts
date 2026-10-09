/**
 * Settings → Backups (sprint 8): how the last backup went and one button to
 * back up now, then the schedule. Past backups and how to restore sit in
 * disclosures.
 */
import { html, postForm, type Html } from "./html.js";
import type { BackupRun, BackupSettings } from "./store.js";
import { bytesWords } from "./storage.js";
import { whenUtc } from "./when-html.js";

/** The schedules on offer and the most copies kept. Here rather than in backup.ts so the page never loads `node:sqlite`. */
export const BACKUP_EVERY_HOURS = [1, 6, 12, 24] as const;
export const MAX_KEEP = 100;

const when = (at: string) => whenUtc(at);
const whenWords = (at: string) => `${at.slice(0, 16).replace("T", " ")} UTC`;
const everyWords = (hours: number) => hours === 1 ? "Every hour" : hours === 24 ? "Every day" : `Every ${hours} hours`;
const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export const BACKUP_CSS = `.backups{max-width:720px;min-width:0;overflow-wrap:anywhere}.backups .backup-state{display:flex;gap:16px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap}` +
  `.backups .backup-state>div{flex:1 1 320px;min-width:0}.backups .backup-state h2{margin:0;font-size:1.0625rem}.backups .backup-state p{margin:4px 0 0}.backups .backup-state .problem{color:var(--danger)}` +
  `.backups .backup-state form{margin:0}.backups .backup-state button{white-space:nowrap}` +
  `.backups fieldset{border:0;padding:0;margin:0;min-width:0}.backups label{display:grid;gap:4px;margin:12px 0 0;font-size:.875rem}` +
  `.backups input[type=text],.backups input[type=number],.backups input[type=password],.backups select{width:100%;box-sizing:border-box;max-width:100%}` +
  `.backups .pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}.backups button[type=submit]{margin-top:14px}` +
  `.backups details{margin-top:16px}.backups summary{cursor:pointer}.backups ol{list-style:none;padding:0;margin:8px 0 0}` +
  `.backups li{display:flex;gap:8px 12px;flex-wrap:wrap;padding:8px 0;border-top:1px solid var(--line, rgba(0,0,0,.08));font-size:.875rem}` +
  `.backups li .failed{color:var(--danger)}.backups code{white-space:nowrap}.backups pre{overflow-x:auto;margin:8px 0}` +
  `@media (max-width:900px){.backups .backup-state form,.backups .backup-state button{width:100%}.backups .pair{grid-template-columns:1fr}}`;

export type BackupView = { settings: BackupSettings; folder: string; defaultFolder: string; runs: BackupRun[]; csrf: string; now: Date };

/** The state in one line, and the next backup (if any), for the top of the page. */
function state(view: BackupView): Html {
  const last = view.runs[0];
  const good = view.runs.find(one => one.ok === true);
  const next = !view.settings.enabled ? "Scheduled backups are off."
    : good === undefined ? "The first scheduled backup runs within a minute or two of the console starting."
    : `Next one about ${whenWords(new Date(Date.parse(good.startedAt) + view.settings.everyHours * 3_600_000).toISOString())}.`;
  if (last === undefined) return html`<h2>No backups yet</h2><p class="meta">${next}</p>`;
  if (last.ok === null) return html`<h2>Backing up</h2><p class="meta">Started ${when(last.startedAt)}.</p>`;
  if (last.ok === false) {
    return html`<h2 data-backup-state="failed">Last backup failed</h2><p class="problem" role="alert">${when(last.startedAt)}: ${last.error ?? "no reason was recorded"}</p><p class="meta">${good === undefined ? "No backup has succeeded yet." : html`Last good backup ${when(good.startedAt)}.`} ${next}</p>`;
  }
  return html`<h2 data-backup-state="ok">Backed up ${when(last.startedAt)}</h2><p class="meta">${last.bytes === null ? "" : `${bytesWords(last.bytes)} · `}${next}</p>`;
}

export function backupHtml(view: BackupView, notice: { said?: string | null; problem?: string | null }): Html {
  const s = view.settings;
  const note = notice.problem ? html`<p class="problem" role="alert">${notice.problem}</p>` : notice.said ? html`<p role="status">${notice.said}</p>` : "";
  const choices = [html`<option value="off"${s.enabled ? "" : html` selected`}>Off</option>`,
    ...BACKUP_EVERY_HOURS.map(hours => html`<option value="${hours}"${s.enabled && s.everyHours === hours ? html` selected` : ""}>${everyWords(hours)}</option>`)];
  const runs = view.runs.map(run => html`<li data-backup-run="${run.id}"><span>${when(run.startedAt)}</span>${
    run.ok === true ? html`<span>Succeeded${run.bytes === null ? "" : ` · ${bytesWords(run.bytes)}`}</span>${run.file === null ? "" : html`<span class="mono meta">${fileName(run.file)}</span>`}`
      : run.ok === false ? html`<span class="failed">Failed: ${run.error ?? "no reason recorded"}</span>` : html`<span>Running</span>`}<span class="meta">${run.trigger === "manual" ? "by hand" : "scheduled"}</span></li>`);
  return html`<section class="backups">${note}<div class="card backup-state"><div>${state(view)}</div>${postForm("/settings/backups/now", html`<button type="submit">Back up now</button>`)}</div><h2>Schedule</h2>${
    postForm("/settings/backups", html`<fieldset><div class="pair"><label>Back up<select name="every">${choices}</select></label><label>Keep the newest<input type="number" name="keep" min="1" max="${MAX_KEEP}" step="1" value="${s.keep}" required></label></div><label>Folder<input type="text" name="folder" value="${s.folder ?? ""}" placeholder="${view.defaultFolder}" spellcheck="false"></label><label>Your Toolroll password<input type="password" name="password" autocomplete="current-password"></label></fieldset><button type="submit">Save</button>`)}<details><summary>Recent backups${view.runs.length === 0 ? "" : ` (${view.runs.length})`}</summary>${runs.length === 0 ? html`<p class="meta">None yet.</p>` : html`<ol>${runs}</ol>`}<p class="meta">In <span class="mono">${view.folder}</span>. Only the database is copied: provider keys and sign-in files stay out.</p></details><details><summary>Restore a backup</summary><p>Stop Toolroll, then run:</p><pre><code>toolroll restore &lt;file&gt; --dry-run</code></pre><p class="meta">The dry run checks the backup (its version and ledger chain) and changes nothing. Run it again without <code>--dry-run</code> to restore; the current database is kept as a copy first.</p></details></section>`;
}
