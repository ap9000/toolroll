import { randomUUID } from "node:crypto";
import { notificationClaimHeld, claimNotifications, finalizeNotification, notificationDestination } from "./notification-delivery.js";
import type { Notification, Store } from "./store.js";
import {loadDiscordCredentials} from "./discord-api.js";
import { loadTeamsCredentials } from "./teams-api.js";
import { loadSlackCredentials } from "./slack-api.js";
/**
 * Messaging settings beside the database: which connected chat service
 * receives alerts (the primary), and the console URL that links in chats
 * and phone pushes open. The chat services themselves — Telegram and the
 * interactive Slack, Discord and Teams adapters — keep their own
 * credentials; this file only reads whether they are configured.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { envValue } from "./names.js";

export type WebhookKind = "slack" | "discord";
export type WebhookTarget = { kind: WebhookKind; url: string };
const FILE_OF = { slack: "slack-webhook", discord: "discord-webhook" };
const POST_TIMEOUT_MS = 10_000;
export const LEGACY_WEBHOOK_WARNING = "Legacy webhooks are deprecated. Connect Slack or Discord in Chat settings.";

export const CONSOLE_URL_ENV = "TOOLROLL_CONSOLE_URL";
export const PRIMARY_ENV = "TOOLROLL_MESSAGING_PRIMARY";

const CONSOLE_FILE = "console-url";
const PRIMARY_FILE = "messaging-primary";

export type MessagingChannel = "telegram" | "slack" | "discord" | "teams";
export const MESSAGING_CHANNELS: readonly MessagingChannel[] = ["telegram", "slack", "discord", "teams"];

export function isMessagingChannel(value: string): value is MessagingChannel {
  return (MESSAGING_CHANNELS as readonly string[]).includes(value);
}

export function saveConsoleUrl(dir: string, url: string): { ok: true } | { ok: false; message: string } {
  // Parsed, not pattern-matched (attended review, finding 11): the stored
  // value becomes every deep link's base, so userinfo, queries, and
  // fragments are refused rather than smuggled into each link.
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return { ok: false, message: "the console URL is the address the links open — http(s)://host[:port]" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, message: "the console URL must be http or https" };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, message: "the console URL must not carry credentials — they would ride every link" };
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    return { ok: false, message: "the console URL is a base address — no query or fragment" };
  }
  const normalized = `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  const file = join(dir, CONSOLE_FILE);
  writeFileSync(file, `${normalized}\n`, { mode: 0o600 });
  return { ok: true };
}

function readTrimmed(path: string): string | null {
  try {
    const raw = readFileSync(path, "utf8").trim();
    return raw === "" ? null : raw;
  } catch {
    return null;
  }
}

/** Every configured mirror. Environment wins over files, like the bot token. */
export function loadWebhookTargets(env: Record<string, string | undefined>, dir: string): WebhookTarget[] {
  const targets: WebhookTarget[] = [];
  const slack = envValue(env, "SLACK_WEBHOOK") ?? readTrimmed(join(dir, FILE_OF.slack));
  const discord = envValue(env, "DISCORD_WEBHOOK") ?? readTrimmed(join(dir, FILE_OF.discord));
  if (slack !== null && slack !== undefined && slack !== "") targets.push({ kind: "slack", url: slack });
  if (discord !== null && discord !== undefined && discord !== "") targets.push({ kind: "discord", url: discord });
  return targets;
}

/** The operator's explicit choice of which service carries the pages. */
export function savePrimary(dir: string, channel: MessagingChannel): void {
  writeFileSync(join(dir, PRIMARY_FILE), `${channel}\n`, { mode: 0o600 });
}

export function loadPrimary(env: Record<string, string | undefined>, dir: string): MessagingChannel | null {
  const configured = envValue(env, "MESSAGING_PRIMARY") ?? readTrimmed(join(dir, PRIMARY_FILE));
  return configured !== undefined && configured !== null && isMessagingChannel(configured) ? configured : null;
}

/**
 * Which service actually carries the pages, and whether that was chosen or
 * merely fell out of what happens to be configured. Explicit choice wins
 * WHEN its channel is actually configured (a primary pointing at nothing
 * falls through rather than silencing every page); otherwise Telegram if
 * present (it can hold buttons), else the first other connected service. `implicit` is the flag
 * every status surface uses to say "you have several — pick one".
 */
export function effectivePrimary(
  env: Record<string, string | undefined>,
  dir: string,
  telegramConfigured: boolean,
): { channel: MessagingChannel | null; implicit: boolean; configured: MessagingChannel[]; legacyWarning?: string } {
  const targets = loadWebhookTargets(env, dir);
  const warning = targets.length ? { legacyWarning: LEGACY_WEBHOOK_WARNING } : {};
  const configured: MessagingChannel[] = [
    ...(telegramConfigured ? (["telegram"] as const) : []),
    ...(loadSlackCredentials(dir) !== null ? (["slack"] as const) : []),
    ...(loadDiscordCredentials(dir) !== null ? (["discord"] as const) : []),
    ...(loadTeamsCredentials(dir) !== null ? (["teams"] as const) : []),
    ...targets.map(one => one.kind).filter(kind => kind === "slack" ? loadSlackCredentials(dir) === null : loadDiscordCredentials(dir) === null),
  ];
  const chosen = loadPrimary(env, dir);
  if (chosen !== null && configured.includes(chosen)) {
    return { channel: chosen, implicit: false, configured, ...warning };
  }
  if (telegramConfigured) return { channel: "telegram", implicit: configured.length > 1, configured, ...warning };
  const fallback = configured[0] ?? null;
  return { channel: fallback, implicit: configured.length > 1, configured, ...warning };
}

export function loadConsoleUrl(env: Record<string, string | undefined>, dir: string): string | null {
  const configured = envValue(env, "CONSOLE_URL") ?? readTrimmed(join(dir, CONSOLE_FILE));
  return configured === undefined || configured === null || configured === "" ? null : configured.replace(/\/+$/, "");
}

/** A dotted IPv4 that names this machine or no machine: loopback, unspecified. */
function isLocalIpv4(address: string): boolean {
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address) || address === "0.0.0.0";
}

/**
 * Names a browser cannot leave this machine with: never a phone destination.
 * The URL parser hands back a canonical hostname, so an IPv6 literal arrives
 * compressed — `::1`, `::`, and an embedded IPv4 as two hex groups
 * (`::ffff:7f00:1` is 127.0.0.1 mapped; `::7f00:1` the deprecated
 * compatible form) — and those groups are decoded and judged as the IPv4
 * they carry.
 */
function isLoopbackHost(hostname: string): boolean {
  // A DNS root dot changes the spelling, not the destination (localhost.).
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "::" || isLocalIpv4(host)) return true;
  const embedded = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (embedded === null) return false;
  const high = parseInt(embedded[1]!, 16), low = parseInt(embedded[2]!, 16);
  return isLocalIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
}

/**
 * The origin a phone link may open, or null. The SAME console-url setting
 * chat links use — read again on every call, never cached, so a changed or
 * removed setting stops the next link — held to a stricter shape than a
 * desktop link: exactly an https origin (no credentials, path, query,
 * fragment), not loopback, and, when the console this process co-hosts
 * states its own `--public-url`, exactly that origin. A model, a Host
 * header or a proposal field never supplies it, and nothing here probes
 * the address: a valid shape is a place to send a person, not a promise
 * that it answers.
 */
export function phoneOrigin(env: Record<string, string | undefined>, dir: string, options: { serverOrigin?: string | null } = {}): string | null {
  const configured = loadConsoleUrl(env, dir);
  if (configured === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") return null;
  if (parsed.pathname !== "/" && parsed.pathname !== "") return null;
  if (parsed.hostname === "" || isLoopbackHost(parsed.hostname)) return null;
  if (options.serverOrigin !== undefined && options.serverOrigin !== null) {
    let server: URL;
    try {
      server = new URL(options.serverOrigin);
    } catch {
      return null;
    }
    if (server.origin !== parsed.origin) return null;
  }
  return parsed.origin;
}

/** Where in the console this notification wants a person. */
export function linkFor(consoleUrl: string | null, notification: Notification): string | null {
  if (consoleUrl === null) return null;
  const decision = /^decision:(\d+)$/.exec(notification.dedupeKey);
  if (decision !== null) return `${consoleUrl}/d/${decision[1]}`;
  // Everything else that wants a person is triaged where acting lives.
  return `${consoleUrl}/next`;
}

/**
 * One notification, one platform. The payloads are the simplest thing each
 * platform documents; the console link is the call to action, because the
 * message is a mirror and the UI is the instrument.
 */
export async function postWebhook(
  target: WebhookTarget,
  notification: Notification,
  link: string | null,
  fetcher: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const body =
    target.kind === "slack"
      ? {
          text: [
            `*${notification.subject}*`,
            notification.body,
            ...(link === null ? [] : [`<${link}|open in Toolroll>`]),
          ].join("\n"),
        }
      : {
          content: [
            `**${notification.subject}**`,
            notification.body,
            ...(link === null ? [] : [link]),
          ].join("\n").slice(0, 1900),
        };
  try {
    const response = await fetcher(target.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    if (!response.ok) {
      // Status only — the URL is a credential and never rides an error.
      return { ok: false, error: `${target.kind} answered ${response.status}` };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: `${target.kind} delivery failed` };
  }
}

export type WebhookReport = { sent: number; problems: string[] };

/** Only the chosen service sends; an interactive adapter suppresses its old mirror. */
export function activeWebhookTargets(env: Record<string, string | undefined>, dir: string, channel: MessagingChannel | null): WebhookTarget[] {
  return loadWebhookTargets(env, dir).filter(one => one.kind === channel && (one.kind === "slack" ? loadSlackCredentials(dir) === null : loadDiscordCredentials(dir) === null));
}

/** Each destination owns its claim and receipt; a successful one never hides another's retry. */
export async function webhookPass(store: Store, options: { targets: WebhookTarget[]; consoleUrl: string | null; owner?: string; clock?: () => Date; fetcher?: typeof fetch }): Promise<WebhookReport> {
  const clock = options.clock ?? (() => new Date()), owner = options.owner ?? `webhooks-${randomUUID()}`;
  const report: WebhookReport = { sent: 0, problems: [] };
  for (const target of options.targets) {
    const destination = notificationDestination(`webhook:${target.kind}`, target.url);
    for (const row of claimNotifications(store, destination, owner, clock())) {
      if (!notificationClaimHeld(store, row, owner, clock())) { report.problems.push(`notification ${row.id}: claim expired or notification resolved`); continue; }
      const outcome = store.leadQuiet(row) ? { ok: true as const, receipt: "skipped:quiet" }
        : await postWebhook(target, row, linkFor(options.consoleUrl, row), options.fetcher);
      const finalized = finalizeNotification(store, row, owner, outcome.ok ? { ok: true, receipt: "receipt" in outcome ? outcome.receipt : target.kind } : outcome, clock());
      if (outcome.ok && finalized && !("receipt" in outcome)) report.sent++;
      if (outcome.ok && !finalized) report.problems.push(`notification ${row.id}: delivery receipt claim expired`);
      if (!outcome.ok) report.problems.push(`notification ${row.id}: ${outcome.error}`);
    }
  }
  return report;
}
