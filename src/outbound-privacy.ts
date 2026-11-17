/**
 * What Toolroll never sends out of this computer: a key, or a folder on this computer (a home folder, a drive). One
 * rule for every outbound message — approval cards (chat-decide.ts), notifications, "needs you", failures, digests,
 * the lead's replies, push and email — and one guard per transport, at the transport's own client, so a new message
 * type can't skip it. A message that names one goes as its safe version instead: the project's name (never its path)
 * and a link to Toolroll. The private words are never sent, in any field.
 */
import { scanForSecrets } from "./evidence.js";
import type { TelegramTransport, TelegramUpload } from "./telegram.js";
import type { Store } from "./store.js";

// ---- the rule ----------------------------------------------------------------------------------------------------

/** A home or root folder written as a path ("/Users/…", "/home/…", "/root/…", "~/…") where a path can start. */
const HOME_FOLDER = /(?:^|[\s"'`(<[=:,])(?:\/Users\/|\/home\/|\/root\/|~\/)/;
/** A drive ("C:\", "d:/") where a path can start — never a URL's scheme ("https://"), whose letter follows another —
 * a network share ("\\server"), or a file URL. */
const DRIVE_OR_SHARE = /(?<![A-Za-z0-9+.-])[A-Za-z]:[\\/]|\\\\|\bfile:\/\//i;

/** A home written another way: JSON-escaped ("\/Users\/"), by its variable ("$HOME/", "${HOME}/", "%USERPROFILE%\",
 * "%HOMEPATH%", "$env:USERPROFILE"), never expanded, or as any scheme's local address ("vscode:///Users/me", an empty
 * host). */
const HOME_OTHERWISE = /(?:^|[\s"'`(<[=:,])\\\/(?:Users|home|root)\\\/|\$HOME[\\/]|\$\{HOME\}[\\/]|%USERPROFILE%|%HOMEPATH%|\$env:USERPROFILE\b|:\/\/\/(?:Users|home|root|[A-Za-z]:)[\\/]/i;
/** Every percent escape decoded once, in one pass over the whole text (no prefix cap, never decoded again: "%252F"
 * stays "%2F"). */
const decodedOnce = (text: string): string => text.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));

/** Whether these words name a folder on this computer, read as written. */
const folderWords = (text: string): boolean => HOME_FOLDER.test(text) || DRIVE_OR_SHARE.test(text) || HOME_OTHERWISE.test(text);

/** Words no outbound message carries: a key, a bot token, or an absolute folder on this computer, as written or
 * percent-encoded once ("%2FUsers%2Fme"). A project's own relative paths, a page's route and a web address are fine. */
export function privateWords(text: string): boolean {
  if (scanForSecrets(text).length > 0 || /\b\d{5,}:[A-Za-z0-9_-]{20,}\b/.test(text) || folderWords(text)) return true;
  return /%[0-9A-Fa-f]{2}/.test(text) && folderWords(` ${decodedOnce(text)}`);
}

/** Whether any of these fields would carry private words. */
export const outboundPrivate = (fields: readonly string[]): boolean => fields.some(privateWords);

/** Every string anywhere in a message body: its text, its buttons, its file names and captions, its links. */
export function textsOf(value: unknown, depth = 0): string[] {
  if (typeof value === "string") return [value];
  if (depth > 12 || value === null || typeof value !== "object") return [];
  return (Array.isArray(value) ? value : Object.values(value)).flatMap(one => textsOf(one, depth + 1));
}

/** A chat app's escapes taken off (Discord's and Markdown's "\~", "\_"): what the person will read. */
const unescaped = (text: string): string => text.replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, "$1");

/** Whether a message body carries private words in any field, as sent or as the chat app will show it. */
export const privateValue = (value: unknown): boolean => textsOf(value).some(text => privateWords(text) || privateWords(unescaped(text)));

// ---- the safe version --------------------------------------------------------------------------------------------

/** What a message is about, when its sender knows: the project it belongs to (a path; only its name is ever said), and
 * whether what it is about names a key or a folder itself — then every message about it goes as the safe version,
 * even one whose words hid the folder (as "[path]") or cut it short. */
export type OutboundSubject = { project: string | null; withheld?: boolean };

/** A project's name, never its path: the last folder name, and none at all when even that would be private. */
export function projectName(repo: string | null | undefined): string | null {
  if (repo === null || repo === undefined) return null;
  const name = (repo.split(/[\\/]/).filter(Boolean).pop() ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, "").trim().slice(0, 48);
  return name === "" || privateWords(name) || privateWords(` ${name}`) ? null : name;
}

/** The subject of a message about one task: that task's project, withheld whole when the task's own title is private. */
export function taskSubject(store: Pick<Store, "lookupRef" | "getTask">, task: string | null | undefined): OutboundSubject {
  if (task === null || task === undefined || task === "") return { project: null };
  return { project: store.lookupRef(task)?.repo ?? null, withheld: privateWords(store.getTask(task)?.title ?? "") };
}

/** The safe version's words: the project's name and where to look. */
export function safeWords(subject?: OutboundSubject | null): string {
  const name = projectName(subject?.project);
  return name === null ? "An update is ready. Open it in Toolroll." : `An update is ready in ${name}. Open it in Toolroll.`;
}

/** One message cut into chunks (parts, sections, activities), checked whole before it is cut: a key or a folder a
 * chunk boundary would cut in two ("/Use" | "rs/me/…") is still seen. Then the whole message goes as one chunk, its
 * safe version; otherwise the chunks go as cut. Each chunk is checked again by its transport's guard on the way out. */
export function checkedChunks(whole: string, chunks: readonly string[], subject?: OutboundSubject | null): string[] {
  return privateValue(whole) ? [safeWords(subject)] : [...chunks];
}

/** The safe version's button. */
export const OPEN_IN_TOOLROLL = "Open in Toolroll";

/** Why a call that can't be made safe is not made. */
export const WITHHELD = "Its words name a key or a folder on this computer, so it stays in Toolroll.";

/** A web address a safe version may carry as its link: http(s), no sign-in, and nothing private in it once decoded. */
export function safeLink(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2_000) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== "") return null;
  let decoded: string;
  try { decoded = decodeURIComponent(`${url.pathname}${url.search}${url.hash}`); } catch { return null; }
  if (privateWords(value) || privateWords(` ${decoded}`)) return null;
  return /[|<>\s]/.test(url.href) ? null : url.href;
}

/** The first link the message itself carried (its own Open or Review button), when it is safe to keep. */
export function firstLink(value: unknown, depth = 0): string | null {
  if (depth > 12 || value === null || typeof value !== "object") return null;
  for (const [key, one] of Object.entries(value)) {
    if (key === "url" && safeLink(one) !== null) return safeLink(one);
    const found = firstLink(one, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

const pick = (from: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(keys.filter(key => from[key] !== undefined).map(key => [key, from[key]]));

/** Whether a message call goes as its safe version: its words are private, or what it is about is withheld whole. Calls
 * that send no message (a member check, a reaction, typing) go as written unless their own words are private. */
const goesSafe = (subject: OutboundSubject | null | undefined, message: boolean, ...values: unknown[]): boolean =>
  (message && subject?.withheld === true) || values.some(privateValue);

/** The last check on a safe version: it must itself be safe, or nothing is sent. */
const checked = <T>(made: T | null): T | null => made === null || privateValue(made) ? null : made;

// ---- Telegram ----------------------------------------------------------------------------------------------------

/** Telegram's Bot API calls, guarded: a call that names a key or a folder goes as its safe version, or not at all. */
export function guardTelegram(transport: TelegramTransport, subject?: OutboundSubject | null): TelegramTransport {
  return async (method, params, signal, upload, more) => {
    const files = [upload, ...(more ?? [])].filter((one): one is TelegramUpload => one !== undefined);
    const privateFile = files.some(one => one.contentType === "text/plain" && privateWords(one.bytes.toString("utf8")));
    if (!privateFile && !goesSafe(subject, TELEGRAM_MESSAGES.has(method), params)) return transport(method, params, signal, upload, more);
    const safe = privateFile ? null : checked(safeTelegramCall(method, params, safeWords(subject)));
    if (safe === null) return { ok: false, description: WITHHELD };
    return transport(method, safe, signal, upload, more);
  };
}

/** The Bot API calls that put words in a chat (a callback's short answer is not one of them). */
const TELEGRAM_MESSAGES: ReadonlySet<string> = new Set(["sendMessage", "editMessageText", "sendMessageDraft", "sendPhoto", "sendDocument", "editMessageCaption", "sendMediaGroup"]);

function safeTelegramCall(method: string, params: Record<string, unknown>, words: string): Record<string, unknown> | null {
  const link = firstLink(params["reply_markup"]);
  const keyboard = link === null ? {} : { reply_markup: { inline_keyboard: [[{ text: OPEN_IN_TOOLROLL, url: link }]] } };
  const where = pick(params, ["chat_id", "message_id", "inline_message_id", "message_thread_id", "reply_parameters", "draft_id", "disable_notification"]);
  switch (method) {
    case "sendMessage":
    case "editMessageText":
    case "sendMessageDraft":
      // An edit without a keyboard takes the old one off: no button acts on words the message no longer shows.
      return { ...where, text: words, link_preview_options: { is_disabled: true }, ...(method === "sendMessageDraft" ? {} : keyboard) };
    case "sendPhoto":
    case "sendDocument":
    case "editMessageCaption":
      return { ...pick(params, ["photo", "document"]), ...where, caption: words, ...keyboard };
    case "sendMediaGroup": {
      const media = Array.isArray(params["media"]) ? params["media"] : [];
      return { ...where, media: media.map((one, index) => {
        const item = one !== null && typeof one === "object" ? one as Record<string, unknown> : {};
        return { ...pick(item, ["type", "media"]), ...(index === 0 ? { caption: words } : {}) };
      }) };
    }
    case "answerCallbackQuery":
      return { ...pick(params, ["callback_query_id"]), text: "Open it in Toolroll." };
    default:
      return null;
  }
}

// ---- Slack -------------------------------------------------------------------------------------------------------

type SlackCall = (method: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** Why a chat call that can't be made safe is not made: an error its delivery treats as never to be sent (chat apps pass
 * chat-delivery-state.ts withheldPart). Kept out of this module so the rule imports nothing of the chat layer. */
export type Refuse = () => Error;

/** Slack Web API calls, guarded the same way; a call that can't be made safe is a delivery that will never go. */
export function guardSlack<T extends SlackCall>(api: T, refuse: Refuse, subject?: OutboundSubject | null): T {
  return (async (method: string, args?: Record<string, unknown>) => {
    if (args === undefined || !goesSafe(subject, SLACK_MESSAGES.has(method), args)) return api(method, args);
    const safe = checked(safeSlackCall(method, args, safeWords(subject)));
    if (safe === null) throw refuse();
    return api(method, safe);
  }) as T;
}

/** The Web API calls that put words in a chat. */
const SLACK_MESSAGES: ReadonlySet<string> = new Set(["chat.postMessage", "chat.update", "chat.postEphemeral", "files.completeUploadExternal"]);

function safeSlackCall(method: string, args: Record<string, unknown>, words: string): Record<string, unknown> | null {
  const escaped = words.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  switch (method) {
    case "chat.postMessage":
    case "chat.update":
    case "chat.postEphemeral": {
      const link = firstLink(args["blocks"]) ?? firstLink(args["attachments"]);
      const text = link === null ? escaped : `${escaped} <${link}|${OPEN_IN_TOOLROLL}>`;
      return { ...pick(args, ["channel", "ts", "thread_ts", "user"]), text, blocks: [{ type: "section", text: { type: "mrkdwn", text, verbatim: true } }],
        mrkdwn: true, parse: "none", link_names: false, unfurl_links: false, unfurl_media: false };
    }
    case "files.completeUploadExternal": {
      const files = Array.isArray(args["files"]) ? args["files"] : [];
      return { ...pick(args, ["channel_id", "thread_ts"]), initial_comment: words,
        files: files.map(one => ({ id: one !== null && typeof one === "object" ? (one as Record<string, unknown>)["id"] : undefined, title: words })) };
    }
    default:
      return null;
  }
}

// ---- Discord -----------------------------------------------------------------------------------------------------

type DiscordCall = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: Record<string, unknown>, file?: { bytes: Uint8Array; name: string }) => Promise<Record<string, unknown>>;

/** Discord REST calls, guarded the same way. */
export function guardDiscord<T extends DiscordCall>(api: T, refuse: Refuse, subject?: OutboundSubject | null): T {
  return (async (method: Parameters<DiscordCall>[0], path: string, body?: Record<string, unknown>, file?: { bytes: Uint8Array; name: string }) => {
    if (!goesSafe(subject, body !== undefined && discordMessagePath(method, path) !== null, body, file?.name ?? "")) return api(method, path, body, file);
    const safe = file !== undefined && privateWords(file.name) ? null : checked(safeDiscordCall(method, path, body ?? {}, safeWords(subject)));
    if (safe === null) throw refuse();
    return api(method, path, safe, file);
  }) as T;
}

function discordMessage(body: Record<string, unknown>, words: string): Record<string, unknown> {
  const link = firstLink(body["components"]) ?? firstLink(body["embeds"]);
  const attachments = Array.isArray(body["attachments"]) ? body["attachments"].map(one => one !== null && typeof one === "object" ? pick(one as Record<string, unknown>, ["id", "filename"]) : {}) : undefined;
  return { content: words.replace(/[\\*_~`|>#[\]()-]/g, "\\$&"), embeds: [],
    components: link === null ? [] : [{ type: 1, components: [{ type: 2, style: 5, label: OPEN_IN_TOOLROLL, url: link }] }],
    allowed_mentions: { parse: [], replied_user: false }, ...pick(body, ["message_reference", "flags"]), ...(attachments === undefined ? {} : { attachments }) };
}

/** Which kind of call puts words in a chat: a message (new or edited), or the answer to a tap; null for any other. */
function discordMessagePath(method: string, path: string): "message" | "interaction" | null {
  if ((method === "POST" || method === "PATCH") && /^\/channels\/[0-9]+\/messages(?:\/[0-9]+)?$/.test(path)) return "message";
  if (method === "POST" && /^\/interactions\/[0-9]+\/[A-Za-z0-9._-]+\/callback$/.test(path)) return "interaction";
  return null;
}

function safeDiscordCall(method: string, path: string, body: Record<string, unknown>, words: string): Record<string, unknown> | null {
  const kind = discordMessagePath(method, path);
  if (kind === "message") return discordMessage(body, words);
  if (kind === "interaction") {
    const data = body["data"] !== null && typeof body["data"] === "object" ? body["data"] as Record<string, unknown> : {};
    return { type: body["type"], data: discordMessage(data, words) };
  }
  return null;
}

// ---- Microsoft Teams ---------------------------------------------------------------------------------------------

type TeamsCall = (method: "GET" | "POST" | "PUT", serviceUrl: string, path: string, body?: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** Bot Framework calls to Teams, guarded the same way. */
export function guardTeams<T extends TeamsCall>(api: T, refuse: Refuse, subject?: OutboundSubject | null): T {
  return (async (method: "GET" | "POST" | "PUT", serviceUrl: string, path: string, body?: Record<string, unknown>) => {
    if (!goesSafe(subject, teamsMessage(method, path, body), body)) return api(method, serviceUrl, path, body);
    const safe = checked(teamsMessage(method, path, body) ? safeTeamsActivity(body!, safeWords(subject)) : null);
    if (safe === null) throw refuse();
    return api(method, serviceUrl, path, safe);
  }) as T;
}

/** Whether a call puts words in a chat: a message activity, new or replacing one. */
const teamsMessage = (method: string, path: string, body: Record<string, unknown> | undefined): boolean =>
  method !== "GET" && /\/activities(?:\/[^/]+)?$/.test(path) && body?.["type"] === "message";

function safeTeamsActivity(body: Record<string, unknown>, words: string): Record<string, unknown> {
  const link = firstLink(body["attachments"]);
  const where = pick(body, ["replyToId"]);
  if (link === null) return { type: "message", ...where, text: words, textFormat: "plain" };
  return { type: "message", ...where, attachments: [{ contentType: "application/vnd.microsoft.card.adaptive",
    content: { type: "AdaptiveCard", version: "1.4", $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      body: [{ type: "TextBlock", text: words, wrap: true }], actions: [{ type: "Action.OpenUrl", title: OPEN_IN_TOOLROLL, url: link }] } }] };
}

// ---- email -------------------------------------------------------------------------------------------------------

type Mail = { subject: string; text: string };

/** An email's safe version: its subject and body say only the project and where to look; who it goes to, its sender
 * and its thread stay as they were. */
export function safeMail<T extends Mail>(mail: T, subject?: OutboundSubject | null): T {
  if (!outboundPrivate([mail.subject, mail.text])) return mail;
  const name = projectName(subject?.project);
  return { ...mail, subject: name === null ? "An update from Toolroll" : `An update from Toolroll in ${name}`, text: safeWords(subject) };
}
