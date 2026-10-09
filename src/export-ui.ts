/**
 * Settings → Data (v105): an instance operator downloads everything Standing
 * Orders knows as one .zip. One form: the password, typed again, and a button.
 */
const e = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const EXPORT_CSS = `.data-export{max-width:720px;min-width:0}.data-export label{display:grid;gap:4px;margin:14px 0 0;font-size:.875rem}` +
  `.data-export input[type=password]{width:100%;max-width:360px;box-sizing:border-box}.data-export button[type=submit]{margin-top:14px;min-height:44px;white-space:nowrap}`;

export function dataExportHtml(csrf: string, notice: { problem?: string | null }): string {
  const note = notice.problem ? `<p class="problem" role="alert">${e(notice.problem)}</p>` : "";
  return `<section class="data-export">${note}` +
    `<p>Everything Toolroll knows, as one .zip: projects, tasks, runs and cost, the action ledger, evidence packs, chats, flows, subagents and settings. ` +
    `Passwords, keys and tokens are never included.</p>` +
    `<form method="post" action="/settings/data"><input type="hidden" name="csrf" value="${e(csrf)}">` +
    `<label>Your Toolroll password<input type="password" name="password" autocomplete="current-password" required></label>` +
    `<button type="submit">Download export</button></form>` +
    `<p class="meta">The same export from the command line: <code>toolroll export --out &lt;path&gt; [--zip]</code></p></section>`;
}
