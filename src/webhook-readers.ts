/**
 * What a proven webhook delivery says, read by its sender's reader (docs/plans/webhook-tasks.md §2). A signature proves
 * who sent a delivery, not that it belongs in this flow: Sentry's and Vercel's readers check its shape, its action and
 * the configured scope first, and only then give it an identity. Anything else is ignored, with why, and claims no
 * identity. The generic senders pick their fields by dot-paths. Every outside value is screened for secrets before it
 * is used anywhere (a key, a held item, a card, a task), and every link is made safe before it is kept.
 */
import { scanForSecrets } from "./evidence.js";
import type { WebhookSender } from "./webhook-signing.js";

/** A webhook trigger's reading settings (its saved config, defaults filled). */
export type ReaderSettings = { sender: WebhookSender; title: string; titleField: string | null; bodyField: string | null; idField: string | null; urlField: string | null; project: string | null; team: string | null };

/** What one delivery is, once read: an item (with the outside thing's identity and link, when it has them), a delivery
 * whose configured identity couldn't be used (made into nothing, with why), or one that isn't for this flow. */
export type ReadDelivery =
  | { kind: "item"; identity: string | null; url: string | null; title: string; description: string; label: string }
  | { kind: "skip"; why: string }
  | { kind: "ignored"; why: string };

const HIDDEN = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const pick = (body: unknown, path: string): unknown => path.split(".").reduce<unknown>((node, part) => record(node)[part], body);
const text = (value: unknown): string | null => typeof value === "string" && value.trim() !== "" ? value.trim() : null;
/** A string or a safe integer, as an identity's words exactly as sent; anything else isn't one. */
const idWords = (value: unknown): string | null => typeof value === "string" ? value : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : null;
/** Whether outside words could hold a key or password (the same check cards' words get). */
export const looksSecret = (value: string): boolean => scanForSecrets(value).length > 0;

/** Where a sender's links may point: its own host, and (for Sentry) the organisation subdomains under it. */
export type LinkHosts = readonly { host: string; subdomains: boolean }[];
export const SENTRY_HOSTS: LinkHosts = [{ host: "sentry.io", subdomains: true }];
export const VERCEL_HOSTS: LinkHosts = [{ host: "vercel.com", subdomains: false }];

/**
 * A link kept from a delivery: absolute https, at most 2,000 characters, no user information, and with its query and
 * fragment dropped (where tokens travel). `hosts` narrows it to a sender's own site (and its subdomains). Null when it
 * isn't one, or when what is left could still hold a secret.
 */
export function safeLink(value: unknown, hosts: LinkHosts | null): string | null {
  if (typeof value !== "string" || value.length > 2000 || HIDDEN.test(value)) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
  const host = url.hostname.toLowerCase();
  if (hosts !== null && !hosts.some(one => host === one.host || (one.subdomains && host.endsWith(`.${one.host}`)))) return null;
  const kept = `${url.origin}${url.pathname}`;
  // Judged as it will be kept: an address that only normalises past 2,000 characters (escaped non-ASCII) isn't kept.
  if (kept.length > 2000) return null;
  // Screened as kept and as read: a token spelled with percent-escapes is the same token. A path that won't decode isn't kept.
  let decoded: string;
  try { decoded = decodeURIComponent(url.pathname); } catch { return null; }
  return looksSecret(kept) || looksSecret(decoded) || HIDDEN.test(decoded) ? null : kept;
}

/** The identity words a key may carry: at most 120 characters, nothing hidden, and nothing that looks like a secret. */
export function identityOf(value: unknown): { ok: true; id: string } | { ok: false; why: string } {
  const sent = idWords(value);
  if (sent === null || sent.trim() === "") return { ok: false, why: "its identity is missing" };
  // Judged as sent, before anything is trimmed: padding, hidden characters or length make it unusable, never another id.
  if (sent.length > 120 || HIDDEN.test(sent) || sent !== sent.trim()) return { ok: false, why: "its identity isn't usable" };
  if (looksSecret(sent)) return { ok: false, why: "it looked like it held a key or password" };
  return { ok: true, id: sent };
}

/** Sentry's API address for an event names its project's slug (…/api/0/projects/<org>/<project>/events/<id>/): read
 * only from that exact shape on Sentry's own host. */
function sentrySlugOf(value: unknown): string | null {
  const link = typeof value === "string" ? value : "";
  const match = /^https:\/\/(?:[a-z0-9-]+\.)?sentry\.io\/api\/0\/projects\/[a-z0-9_-]+\/([a-z0-9_-]+)\/events\/[A-Za-z0-9-]+\/?$/.exec(link);
  return match?.[1] ?? null;
}

/** Sentry: an issue alert (action "triggered", with the event) or a new issue (action "created", with the issue). */
function readSentry(body: unknown, settings: ReaderSettings): ReadDelivery {
  const action = text(record(body)["action"]);
  const data = record(record(body)["data"]);
  const alert = action === "triggered" && Object.keys(record(data["event"])).length > 0;
  const created = action === "created" && Object.keys(record(data["issue"])).length > 0;
  // A fixed reason: nothing the sender wrote is kept for an event Toolroll doesn't take.
  if (!alert && !created) return { kind: "ignored", why: "not an issue alert or a new issue" };
  const thing = record(alert ? data["event"] : data["issue"]);
  // Scope from the body alone (the resource header isn't signed): the project's id or slug, as Sentry sends it.
  if (settings.project !== null) {
    const project = record(thing["project"]);
    // An alert's event names its project by number, and by slug only in its API address; a new issue names both.
    const names = [idWords(thing["project"]), idWords(project["id"]), text(project["slug"]), sentrySlugOf(thing["url"])].filter((one): one is string => one !== null);
    if (!names.some(one => one.toLowerCase() === settings.project!.toLowerCase())) return { kind: "ignored", why: "from another Sentry project" };
  }
  const identity = identityOf(alert ? thing["issue_id"] : thing["id"]);
  if (!identity.ok) return { kind: "skip", why: identity.why };
  const title = text(thing["title"]) ?? settings.title;
  const culprit = text(thing["culprit"]);
  return { kind: "item", identity: identity.id, url: safeLink(thing["web_url"], SENTRY_HOSTS), title, description: culprit === null ? "From a Sentry issue." : `From a Sentry issue, in ${culprit}.`, label: "Sentry issue" };
}

/** Vercel: a failed deployment only, from the configured project and team. */
function readVercel(body: unknown, settings: ReaderSettings): ReadDelivery {
  const type = text(record(body)["type"]);
  if (type !== "deployment.error") return { kind: "ignored", why: "not a failed deployment" };
  const payload = record(record(body)["payload"]);
  if (settings.project !== null && idWords(record(payload["project"])["id"]) !== settings.project) return { kind: "ignored", why: "from another Vercel project" };
  if (settings.team !== null && idWords(record(payload["team"])["id"]) !== settings.team) return { kind: "ignored", why: "from another Vercel team" };
  const deployment = record(payload["deployment"]);
  const identity = identityOf(deployment["id"]);
  if (!identity.ok) return { kind: "skip", why: identity.why };
  const name = text(deployment["name"]);
  return { kind: "item", identity: identity.id, url: safeLink(record(payload["links"])["deployment"], VERCEL_HOSTS), title: name === null ? settings.title : `${name} failed to deploy`,
    description: "From a failed Vercel deployment.", label: "Vercel deployment" };
}

/** Any JSON: the trigger's own paths, then the usual names; shown whole when they find no text. */
function readGeneric(body: unknown, settings: ReaderSettings): ReadDelivery {
  const at = (path: string | null) => path === null ? undefined : pick(body, path);
  let identity: string | null = null;
  if (settings.idField !== null) {
    const read = identityOf(at(settings.idField));
    // A configured identity that can't be used makes nothing: it never falls back to some other identity.
    if (!read.ok) return { kind: "skip", why: read.why };
    identity = read.id;
  }
  const title = at(settings.titleField ?? "title") ?? at("summary") ?? at("message");
  const details = at(settings.bodyField ?? "description") ?? at("body") ?? at("text");
  return { kind: "item", identity, url: settings.urlField === null ? null : safeLink(at(settings.urlField), null),
    title: typeof title === "string" && title.trim() !== "" ? title : settings.title,
    description: `From a webhook:\n\n${typeof details === "string" ? details : JSON.stringify(body, null, 2)}`.slice(0, 4000), label: "Webhook" };
}

/** Whether each provider's reader has read a real, captured delivery (test/fixtures/webhooks/*.captured.json), or only
 * its sender's documented examples so far: the panel says which until a captured one is in the suite. */
export const READER_CAPTURED: Record<"sentry" | "vercel", boolean> = { sentry: false, vercel: false };

/** What a proven delivery says, by its sender's reader. */
export function readDelivery(body: unknown, settings: ReaderSettings): ReadDelivery {
  return settings.sender === "sentry" ? readSentry(body, settings) : settings.sender === "vercel" ? readVercel(body, settings) : readGeneric(body, settings);
}
