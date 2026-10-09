/**
 * Settings → Monitoring (v104): an instance operator points Toolroll at
 * the company's tools. One form, the status of each destination beside it,
 * and how Prometheus reads `/metrics`. The signing secret is shown once.
 */
import { html, postForm, type Html } from "./html.js";
import type { MonitoringStatus } from "./store.js";
import type { MonitoringSettings } from "./monitoring-settings.js";
import { targetOf } from "./monitoring.js";
import { whenUtc } from "./when-html.js";

const when = (at: string) => whenUtc(at);

export const MONITORING_CSS = `.monitoring{max-width:720px;min-width:0}.monitoring fieldset{border:0;padding:0;margin:20px 0 0;min-width:0}` +
  `.monitoring legend{font-weight:600;font-size:.9375rem;margin-bottom:6px}.monitoring label{display:grid;gap:4px;margin:10px 0 0;font-size:.875rem}` +
  `.monitoring input[type=text],.monitoring input[type=url],.monitoring input[type=password]{width:100%;box-sizing:border-box}.monitoring .choice{display:flex;gap:8px;align-items:center}` +
  `.monitoring .status{margin:4px 0 0;font-size:.8125rem}.monitoring .status.problem{color:var(--danger)}.monitoring .step-up{margin-top:18px}.monitoring button[type=submit]{margin-top:14px}` +
  `.monitoring pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:.75rem}.monitoring details{margin-top:6px}`;

export type MonitoringView = { settings: MonitoringSettings; status: MonitoringStatus[]; head: number; origin: string | null };

/** How a destination is doing, in one line. */
function statusLine(view: MonitoringView, sink: string, address: string | null): Html | "" {
  // An empty field already says it's off.
  if (address === null) return "";
  // A status for another address (it just changed) says nothing about this one yet.
  const one = view.status.find(row => row.sink === sink && row.target === targetOf(address));
  if (one === undefined || (one.lastOkAt === null && one.lastError === null)) return html`<p class="status meta" data-monitoring="${sink}" data-state="starting">Starting: the first delivery goes out within a few seconds.</p>`;
  if (one.failures > 0 && one.lastError !== null) {
    return html`<p class="status problem" role="alert" data-monitoring="${sink}" data-state="failing">Failing: ${one.lastError}${one.nextTryAt === null ? "" : html` · trying again ${when(one.nextTryAt)}`}</p>`;
  }
  const behind = Math.max(0, view.head - one.through);
  return html`<p class="status meta" data-monitoring="${sink}" data-state="ok">${sink === "traces" ? "Sending" : `Sent through entry #${one.through}`}${one.lastOkAt === null ? "" : html` · last ${when(one.lastOkAt)}`}${behind > 0 && sink !== "traces" ? ` · ${behind} to go` : ""}</p>`;
}

export function monitoringHtml(view: MonitoringView, notice: { said?: string | null; problem?: string | null }): Html {
  const s = view.settings;
  const note = notice.problem ? html`<p class="problem" role="alert">${notice.problem}</p>` : notice.said ? html`<p role="status">${notice.said}</p>` : "";
  const metrics = view.origin === null ? "/metrics" : `${view.origin}/metrics`;
  return html`<section class="monitoring">${note}${postForm("/settings/monitoring", html`<fieldset><legend>Audit stream</legend><p class="meta">Every ledger entry with its seal, as it happens, to your log system.</p><label>Webhook<input type="url" name="webhook" value="${s.webhook?.url ?? ""}" placeholder="https://logs.example.com/standing-orders" spellcheck="false"></label>${
    statusLine(view, "webhook", s.webhook?.url ?? null)}${
    s.webhook === null ? "" : html`<label class="choice"><input type="checkbox" name="rotate" value="1"> Make a new signing secret</label>`}<label>Folder (JSON Lines, a file per day)<input type="text" name="folder" value="${s.folder?.path ?? ""}" placeholder="/var/log/standing-orders" spellcheck="false"></label>${
    statusLine(view, "folder", s.folder?.path ?? null)}</fieldset><fieldset><legend>Traces</legend><p class="meta">Each run as an OpenTelemetry span: timings, model, tokens and cost. Never a prompt or code.</p><label>Collector (OTLP over HTTP)<input type="url" name="traces" value="${s.traces?.endpoint ?? ""}" placeholder="https://otel.example.com:4318" spellcheck="false"></label>${
    statusLine(view, "traces", s.traces?.endpoint ?? null)}<label>Header name (optional)<input type="text" name="header-name" value="${s.traces?.header?.name ?? ""}" placeholder="x-honeycomb-team" spellcheck="false"></label><label>Header value<input type="password" name="header-value" autocomplete="off" placeholder="${s.traces?.header ? "Saved; leave blank to keep" : "API key"}"></label></fieldset><div class="step-up"><label>Your Toolroll password<input type="password" name="password" autocomplete="current-password"></label></div><button type="submit">Save</button>`)}<fieldset><legend>Metrics</legend><p class="meta">Prometheus reads <code>${metrics}</code> with an instance operator's API token (<a href="/settings/sessions">Sessions &amp; tokens</a>).</p><details><summary>Example</summary><pre>curl -H "Authorization: Bearer so_…" ${metrics}</pre></details></fieldset></section>`;
}

/** The webhook's signing secret, once: a focused page with no script. */
export function signingSecretHtml(url: string, secret: string): Html {
  return html`<h1>Signing secret</h1><div class="card"><p>Give this to the receiver at <span class="mono">${url}</span>. It's shown once.</p><p class="mono secret-value">${secret}</p><p class="meta">Each request carries <code>x-standing-orders-signature: t=&lt;time&gt;,v1=&lt;HMAC-SHA256 of "time.body"&gt;</code>. Check it, and that the time is recent.</p></div><p class="meta"><a href="/settings/monitoring">Back to Monitoring</a></p>`;
}
