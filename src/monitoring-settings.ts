/**
 * Settings → Monitoring (v104): where Toolroll sends what it does, for
 * the tools a company already watches. Kept in `monitoring.json` beside the
 * database (0600, the agent fence keeps agents out), never in the database:
 * the webhook's signing secret and a collector's header value are secrets.
 *
 * - The audit stream: every sealed ledger entry, in order, to a webhook
 *   (each request signed) and/or a folder of JSON Lines files.
 * - Traces: each finished run as an OpenTelemetry span, to a collector.
 */
import { randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const FILE = "monitoring.json";

/** Where an address points, without its path or query (a webhook may carry a key in either). */
export const origin = (address: string) => { try { return new URL(address).origin; } catch { return "?"; } };

export type MonitoringSettings = {
  webhook: { url: string; secret: string } | null;
  folder: { path: string } | null;
  traces: { endpoint: string; header: { name: string; value: string } | null } | null;
};
export const NO_MONITORING: MonitoringSettings = { webhook: null, folder: null, traces: null };

/** An address Toolroll may send to: https anywhere, http only to this machine (a collector beside it). */
export function sendableAddress(value: string): string | null {
  let url: URL;
  try { url = new URL(value.trim()); } catch { return null; }
  if (url.username !== "" || url.password !== "" || url.hash !== "") return null;
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  return url.toString().replace(/\/+$/, "");
}

/** A header name a collector asks for (x-honeycomb-team, DD-API-KEY, Authorization); never one HTTP itself owns. */
const HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const RESERVED_HEADERS = new Set(["host", "content-length", "content-type", "transfer-encoding", "connection", "cookie", "user-agent"]);

export function readMonitoring(dir: string | null | undefined): MonitoringSettings {
  if (!dir) return NO_MONITORING;
  const file = join(dir, FILE);
  if (!existsSync(file)) return NO_MONITORING;
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<MonitoringSettings>;
    const webhook = value.webhook != null && typeof value.webhook.url === "string" && typeof value.webhook.secret === "string" && sendableAddress(value.webhook.url) !== null && value.webhook.secret.length >= 32
      ? { url: sendableAddress(value.webhook.url)!, secret: value.webhook.secret } : null;
    const folder = value.folder != null && typeof value.folder.path === "string" && isAbsolute(value.folder.path) ? { path: value.folder.path } : null;
    const header = value.traces?.header != null && typeof value.traces.header.name === "string" && typeof value.traces.header.value === "string" && HEADER_NAME.test(value.traces.header.name)
      ? { name: value.traces.header.name, value: value.traces.header.value } : null;
    const traces = value.traces != null && typeof value.traces.endpoint === "string" && sendableAddress(value.traces.endpoint) !== null
      ? { endpoint: sendableAddress(value.traces.endpoint)!, header } : null;
    return { webhook, folder, traces };
  } catch {
    return NO_MONITORING;
  }
}

function write(dir: string, settings: MonitoringSettings): void {
  const file = join(dir, FILE);
  // A fresh name, made here (never a file or link already there), readable by its owner only, then swapped in.
  const next = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = openSync(next, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { writeSync(handle, `${JSON.stringify(settings, null, 2)}\n`); fsyncSync(handle); } finally { closeSync(handle); }
    renameSync(next, file);
  } catch (error) { rmSync(next, { force: true }); throw error; }
}

/** A fresh signing secret for the webhook (shown once; the receiver keeps it to check each request). */
export function newSigningSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

export type MonitoringForm = { webhook: string; folder: string; tracesEndpoint: string; headerName: string; headerValue: string; rotate: boolean };

/**
 * Save what the form sent. A blank field turns that destination off; a header value left blank keeps the one
 * saved. A new webhook address, or `rotate`, makes a new signing secret, handed back once as `secret`.
 */
/** A path as it really is: its nearest existing folder resolved (so /tmp and /private/tmp are one), in one case
 * (macOS folders ignore it). */
function realish(path: string): string {
  let at = resolve(path), rest = "";
  while (!existsSync(at) && dirname(at) !== at) { rest = join(at.slice(dirname(at).length + 1), rest); at = dirname(at); }
  try { return join(realpathSync.native(at), rest).toLowerCase(); } catch { return resolve(path).toLowerCase(); }
}
const within = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

export function saveMonitoring(dir: string, form: MonitoringForm, previous: MonitoringSettings, forbidden: readonly string[] = []):
  { ok: true; settings: MonitoringSettings; secret: string | null } | { ok: false; said: string } {
  let webhook: MonitoringSettings["webhook"] = null, secret: string | null = null;
  if (form.webhook.trim() !== "") {
    const url = sendableAddress(form.webhook);
    if (url === null) return { ok: false, said: "The webhook is an https address (http only for this machine), with no user name or password in it." };
    const keep = previous.webhook !== null && previous.webhook.url === url && !form.rotate;
    if (!keep) secret = newSigningSecret();
    webhook = { url, secret: keep ? previous.webhook!.secret : secret! };
  }
  let folder: MonitoringSettings["folder"] = null;
  if (form.folder.trim() !== "") {
    const path = form.folder.trim();
    if (!isAbsolute(path) || path.length > 500 || /[\u0000-\u001f]/.test(path)) return { ok: false, said: "The folder is a full path, like /var/log/toolroll." };
    // Never where an agent works or Toolroll keeps its own state: an agent could read the whole stream there.
    const real = realish(path);
    if ([dir, ...forbidden].some(one => within(real, realish(one)) || within(realish(one), real))) return { ok: false, said: "Choose a folder outside Toolroll's own folder and your projects, like /var/log/toolroll." };
    folder = { path };
  }
  let traces: MonitoringSettings["traces"] = null;
  if (form.tracesEndpoint.trim() !== "") {
    const endpoint = sendableAddress(form.tracesEndpoint);
    if (endpoint === null) return { ok: false, said: "The collector is an https address (http only for this machine), like https://otel.example.com:4318." };
    const name = form.headerName.trim();
    let header: { name: string; value: string } | null = null;
    if (name !== "") {
      if (!HEADER_NAME.test(name) || RESERVED_HEADERS.has(name.toLowerCase())) return { ok: false, said: "The header name is letters, digits and dashes, like x-honeycomb-team." };
      // A saved key stays only with the same collector (origin) and header: it never follows the address elsewhere.
      const sameCollector = previous.traces !== null && origin(previous.traces.endpoint) === origin(endpoint) && previous.traces.header?.name === name;
      const value = form.headerValue.trim() !== "" ? form.headerValue.trim() : sameCollector ? previous.traces!.header!.value : "";
      if (value === "" || value.length > 2000 || /[\u0000-\u001f]/.test(value)) return { ok: false, said: "Enter the header's value (the collector's API key)." };
      header = { name, value };
    }
    traces = { endpoint, header };
  }
  const settings = { webhook, folder, traces };
  write(dir, settings);
  return { ok: true, settings, secret };
}


/** The change in words for the ledger: where things go and header names, never a secret or a full address. */
export function monitoringWords(settings: MonitoringSettings): string {
  const parts = [
    settings.webhook === null ? null : `webhook ${origin(settings.webhook.url)}`,
    settings.folder === null ? null : `folder ${settings.folder.path}`,
    settings.traces === null ? null : `traces ${origin(settings.traces.endpoint)}${settings.traces.header === null ? "" : ` (${settings.traces.header.name})`}`,
  ].filter((one): one is string => one !== null);
  return parts.length === 0 ? "off" : parts.join("; ");
}

/** A change for the ledger: before → after, and what changed that the words alone don't show (never the values). */
export function monitoringChange(before: MonitoringSettings, after: MonitoringSettings, newSecret: boolean): string | null {
  const notes = [
    before.webhook !== null && after.webhook !== null && before.webhook.url !== after.webhook.url && origin(before.webhook.url) === origin(after.webhook.url) ? "webhook address changed" : null,
    newSecret && before.webhook !== null && after.webhook !== null && before.webhook.url === after.webhook.url ? "new signing secret" : null,
    before.traces !== null && after.traces !== null && before.traces.endpoint !== after.traces.endpoint && origin(before.traces.endpoint) === origin(after.traces.endpoint) ? "collector address changed" : null,
    before.traces?.header != null && after.traces?.header != null && before.traces.header.name === after.traces.header.name && before.traces.header.value !== after.traces.header.value ? "new header value" : null,
  ].filter((one): one is string => one !== null);
  const words = { before: monitoringWords(before), after: monitoringWords(after) };
  if (words.before === words.after && notes.length === 0) return null;
  return `${words.before} → ${words.after}${notes.length === 0 ? "" : ` (${notes.join(", ")})`}`;
}
