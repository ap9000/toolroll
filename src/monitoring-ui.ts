/**
 * Settings → Monitoring (v104): an instance operator points Toolroll at
 * the company's tools. One form, the status of each destination beside it,
 * and how Prometheus reads `/metrics`. The signing secret is shown once.
 * Built from the revamp kit; the Settings frame adds the title.
 */
import { html, joinHtml, type Html } from "./html.js";
import type { MonitoringStatus } from "./store.js";
import type { MonitoringSettings } from "./monitoring-settings.js";
import { targetOf } from "./monitoring.js";
import { whenUtc } from "./when-html.js";
import { codeLine, disclose, doc, docHeader, formRow, icon, infoLine, input, note, notice, settingsSection, switchInput } from "./server/kit.js";
import { kitSectionForm, SECRET_OPT_OUTS } from "./settings-kit.js";

const when = (at: string) => whenUtc(at);

/** The page is kit pieces now; nothing of the old look is left. Kept as an export for the shared stylesheet. */
export const MONITORING_CSS = "";

export type MonitoringView = { settings: MonitoringSettings; status: MonitoringStatus[]; head: number; origin: string | null };

/** How a destination is doing, in one line. */
function statusLine(view: MonitoringView, sink: string, address: string | null): Html | "" {
  // An empty field already says it's off.
  if (address === null) return "";
  // A status for another address (it just changed) says nothing about this one yet.
  const one = view.status.find(row => row.sink === sink && row.target === targetOf(address));
  if (one === undefined || (one.lastOkAt === null && one.lastError === null)) return html`<p class="k-note" data-monitoring="${sink}" data-state="starting">Starting: the first delivery goes out within a few seconds.</p>`;
  if (one.failures > 0 && one.lastError !== null) {
    return html`<p class="k-notice" role="alert" data-monitoring="${sink}" data-state="failing">${icon("alert", true)}<span>Failing: ${one.lastError}${one.nextTryAt === null ? "" : html` · trying again ${when(one.nextTryAt)}`}</span></p>`;
  }
  const behind = Math.max(0, view.head - one.through);
  return html`<p class="k-note" data-monitoring="${sink}" data-state="ok">${sink === "traces" ? "Sending" : `Sent through entry #${one.through}`}${one.lastOkAt === null ? "" : html` · last ${when(one.lastOkAt)}`}${behind > 0 && sink !== "traces" ? ` · ${behind} to go` : ""}</p>`;
}

export function monitoringHtml(view: MonitoringView, said: { said?: string | null; problem?: string | null }): Html {
  const s = view.settings;
  const metrics = view.origin === null ? "/metrics" : `${view.origin}/metrics`;
  const audit = settingsSection({ id: "audit-stream", title: "Audit stream", lead: "Every ledger entry with its seal, as it happens, to your log system.",
    body: joinHtml([
      formRow("Webhook", "Blank: off.", input({ id: "monitoring-webhook", name: "webhook", type: "url", value: s.webhook?.url ?? "",
        attrs: { placeholder: "https://logs.example.com/toolroll", spellcheck: "false", "aria-label": "Webhook" } })),
      statusLine(view, "webhook", s.webhook?.url ?? null),
      s.webhook === null ? "" : formRow("Signing secret", "Make a new one. It is shown once, after Save.",
        switchInput({ id: "monitoring-rotate", name: "rotate", label: "Make a new signing secret", on: false, attrs: { value: "1" } }), "inline"),
      formRow("Folder", "JSON Lines, a file per day. Blank: off.", input({ id: "monitoring-folder", name: "folder", value: s.folder?.path ?? "",
        attrs: { placeholder: "/var/log/toolroll", spellcheck: "false", "aria-label": "Folder" } })),
      statusLine(view, "folder", s.folder?.path ?? null),
    ]) });
  const traces = settingsSection({ id: "traces", title: "Traces", lead: "Each run as an OpenTelemetry span: timings, model, tokens and cost. Never a prompt or code.",
    body: joinHtml([
      formRow("Collector", "OTLP over HTTP. Blank: off.", input({ id: "monitoring-traces", name: "traces", type: "url", value: s.traces?.endpoint ?? "",
        attrs: { placeholder: "https://otel.example.com:4318", spellcheck: "false", "aria-label": "Collector" } })),
      statusLine(view, "traces", s.traces?.endpoint ?? null),
      formRow("Header name", "Optional.", input({ id: "monitoring-header-name", name: "header-name", value: s.traces?.header?.name ?? "",
        attrs: { placeholder: "x-honeycomb-team", spellcheck: "false", "aria-label": "Header name" } })),
      formRow("Header value", s.traces?.header ? "Saved. Leave blank to keep it." : null, input({ id: "monitoring-header-value", name: "header-value", type: "password",
        attrs: { autocomplete: "off", spellcheck: "false", autocapitalize: "none", "data-so-secret": true, ...SECRET_OPT_OUTS, placeholder: s.traces?.header ? "Saved; leave blank to keep" : "API key", "aria-label": "Header value" } })),
    ]) });
  const metricsSection = settingsSection({ id: "metrics", title: "Metrics",
    lead: html`Prometheus reads <code class="k-mono">${metrics}</code> with an instance operator's API token (<a class="k-link" href="/settings/sessions">Sessions and tokens</a>).`,
    body: disclose("Example", codeLine(`curl -H "Authorization: Bearer so_…" ${metrics}`)) });
  return joinHtml([
    said.problem ? notice(said.problem) : said.said ? infoLine(said.said) : "",
    // A new signing secret answers with a page of its own (shown once): post as a navigation.
    kitSectionForm({ proof: "monitoring", action: "/settings/monitoring", id: "monitoring-form", gate: true, native: true, body: joinHtml([audit, traces]) }),
    metricsSection,
  ]);
}

/** The webhook's signing secret, once: a focused page with no script. */
export function signingSecretHtml(url: string, secret: string): Html {
  return doc(
    docHeader({ title: "Signing secret", back: ["/settings/monitoring", "Monitoring"] }),
    settingsSection({ id: "signing-secret", title: "Shown once", lead: html`Give this to the receiver at <span class="k-mono">${url}</span>. It isn't shown again.`,
      body: joinHtml([
        html`<p class="k-secret-val">${secret}</p>`,
        note(html`Each request carries <code class="k-mono">x-standing-orders-signature: t=&lt;time&gt;,v1=&lt;HMAC-SHA256 of "time.body"&gt;</code>. Check it, and that the time is recent.`),
      ]) }),
  );
}
