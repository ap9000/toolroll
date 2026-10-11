/**
 * Reading mail for Inbox triggers (v89).
 *
 * The mailbox is the same account emails are sent from (Settings → Email):
 * a mail server's IMAP address with the same sign-in, or a connected Google
 * account (IMAP with XOAUTH2). It is only ever read — opened read-only, and
 * nothing is marked, moved or deleted — and only mail that arrives after a
 * trigger is added becomes cards: the first check notes where the mailbox
 * stands, and each later one reads what came after (by IMAP UID, restarting
 * from "now" if the server renumbers the folder).
 *
 * Each message becomes plain words: the sender, the subject, and the body
 * without the quoted history of earlier messages. Automatic replies (out of
 * office, bounces) are left out, so a flow that answers mail can't end up
 * answering machines. The card keeps the message's ID so a Send email step
 * replying to the sender stays in the same thread.
 */
import { googleAccessToken, googleConnected } from "./google-mail.js";
import { readEmailSettings } from "./email-settings.js";

export type MailboxAccess = { host: string; port: number; secure: boolean; user: string; password?: string; accessToken?: string };
export type InboundMail = { uid: number; messageId: string | null; inReplyTo: string | null; references: string[]; from: string; fromName: string | null; subject: string; text: string; automatic: boolean };
/** Where a folder stands: its UIDVALIDITY and the last UID seen. */
export type MailCursor = { validity: string; uid: number };
/** `at` is where the next read starts; `more` says mail is still waiting past it. */
export type MailRead = { ok: true; at: MailCursor; mails: InboundMail[]; renumbered: boolean; more: boolean } | { ok: false; said: string; permanent: boolean };
export type MailReader = (access: MailboxAccess, folder: string, after: MailCursor | null, limit: number) => Promise<MailRead>;

const BODY_CHARS = 4000;
const SOURCE_BYTES = 2 * 1024 * 1024;

export function mailCursorOf(text: string | null): MailCursor | null {
  const match = text === null ? null : /^([0-9]{1,20}):([0-9]{1,12})$/.exec(text);
  return match === null ? null : { validity: match[1]!, uid: Number(match[2]) };
}
export const mailCursorText = (at: MailCursor) => `${at.validity}:${at.uid}`;

// ------------------------------------------------------------- the account

/** Whether Inbox triggers can read mail: a connected Google account, or a mail server with its IMAP address. */
export function mailboxReady(dir: string | null): boolean {
  return googleConnected(dir) !== null || (readEmailSettings(dir)?.imap ?? null) !== null;
}

/** The mailbox to read, signed in: Google when connected, else the mail server's IMAP. */
export async function mailboxAccess(dir: string | null, fetcher: typeof fetch): Promise<{ ok: true; access: MailboxAccess; address: string } | { ok: false; said: string; permanent: boolean }> {
  if (googleConnected(dir) !== null) {
    const token = await googleAccessToken(dir, fetcher);
    if (!token.ok) return token;
    return { ok: true, access: { host: "imap.gmail.com", port: 993, secure: true, user: token.address, accessToken: token.token }, address: token.address };
  }
  const server = readEmailSettings(dir);
  if (server?.imap == null) return { ok: false, said: "Reading mail isn't set up yet. Add the IMAP address in Settings → Email.", permanent: false };
  return { ok: true, access: { host: server.imap.host, port: server.imap.port, secure: server.imap.secure, user: server.user || server.from, password: server.password }, address: server.from };
}

// ------------------------------------------------------------ the words

/** The new part of a message: no quoted earlier messages, no signature, tidy lines. */
export function freshText(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").split("\n");
  const kept: string[] = [];
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    // Where the history starts: "On <date>, <name> wrote:", an Outlook header block, or a forwarded-message marker.
    if (/^On .{4,200} wrote:$/.test(trimmed) || /^-{2,}\s*(Original Message|Forwarded message)\s*-{2,}$/i.test(trimmed)) break;
    if (/^From: .+$/.test(trimmed) && (lines[index + 1] ?? "").trim().match(/^(Sent|Date): /) !== null) break;
    // A signature: the "-- " line and everything after it.
    if (line === "-- ") break;
    if (trimmed.startsWith(">")) continue;
    kept.push(line.trimEnd());
  }
  const joined = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return joined.length > BODY_CHARS ? `${joined.slice(0, BODY_CHARS).trimEnd()}…` : joined;
}

const header = (headers: Map<string, unknown>, name: string): string => {
  const value = headers.get(name);
  return typeof value === "string" ? value : value !== undefined && value !== null && typeof value === "object" && "value" in value ? String((value as { value: unknown }).value) : "";
};

/** One raw message as plain words, and whether a machine sent it. */
export async function readMail(uid: number, source: Buffer | string): Promise<InboundMail> {
  // The mail SDKs load when mail is read, not with every command that imports this module.
  const { simpleParser } = await import("mailparser");
  const parsed = await simpleParser(source, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true });
  const sender = parsed.from?.value[0];
  const from = (sender?.address ?? "").toLowerCase();
  const headers = parsed.headers as Map<string, unknown>;
  const auto = header(headers, "auto-submitted").toLowerCase();
  const precedence = header(headers, "precedence").toLowerCase();
  const automatic = (auto !== "" && auto !== "no") || headers.has("x-autoreply") || headers.has("x-autorespond") || precedence === "auto_reply"
    || /^(mailer-daemon|postmaster)@/.test(from) || /multipart\/report/i.test(header(headers, "content-type"));
  const references = (Array.isArray(parsed.references) ? parsed.references : typeof parsed.references === "string" ? parsed.references.split(/\s+/) : []).filter(one => /^<[^<>\s]{3,250}>$/.test(one)).slice(-20);
  const replyTo = typeof parsed.inReplyTo === "string" ? /<[^<>\s]{3,250}>/.exec(parsed.inReplyTo)?.[0] ?? null : null;
  return {
    uid, messageId: typeof parsed.messageId === "string" && /^<[^<>\s]{3,250}>$/.test(parsed.messageId) ? parsed.messageId : null, inReplyTo: replyTo, references, from,
    fromName: sender?.name && sender.name !== sender.address ? sender.name.slice(0, 120) : null,
    subject: (parsed.subject ?? "").replace(/\s+/g, " ").trim().slice(0, 200), text: freshText(parsed.text ?? ""), automatic,
  };
}

// ------------------------------------------------------------ the reader

function problemOf(error: unknown): { said: string; permanent: boolean } {
  const code = String((error as { code?: unknown })?.code ?? ""), text = String((error as { responseText?: unknown })?.responseText ?? (error as Error)?.message ?? "");
  if ((error as { authenticationFailed?: unknown })?.authenticationFailed === true || /AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed|authentication failed/i.test(text))
    return { said: "The mail server didn't accept the sign-in. Check the username and password in Settings → Email (Gmail needs an app password).", permanent: false };
  if (/NONEXISTENT|doesn't exist|Unknown Mailbox|no such mailbox/i.test(text)) return { said: "That folder doesn't exist in the mailbox.", permanent: false };
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return { said: "Couldn't find the mail server. Check its IMAP address in Settings → Email.", permanent: false };
  if (code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "ECONNRESET" || /timeout/i.test(text)) return { said: "Couldn't reach the mail server just now.", permanent: false };
  return { said: `The mail server said: ${text.split("\n")[0]?.slice(0, 160) || "something went wrong"}.`, permanent: false };
}

/** The production reader: one read-only IMAP visit. */
export const readThroughImap: MailReader = async (access, folder, after, limit) => {
  const { ImapFlow } = await import("imapflow");
  const client = new ImapFlow({
    host: access.host, port: access.port, secure: access.secure, logger: false, disableAutoIdle: true,
    auth: access.accessToken !== undefined ? { user: access.user, accessToken: access.accessToken } : { user: access.user, pass: access.password ?? "" },
    connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 60_000,
    // A password never travels unencrypted: without TLS from the start, STARTTLS is required.
    ...(access.secure ? {} : { doSTARTTLS: true }),
  });
  client.on("error", () => { /* surfaced by the awaited call that failed */ });
  try {
    await client.connect();
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      const box = client.mailbox;
      if (box === false) return { ok: false, said: "That folder couldn't be opened.", permanent: false };
      const validity = String(box.uidValidity), last = Math.max(0, Number(box.uidNext) - 1);
      // The first look, or a renumbered folder: note where it stands, and start from there.
      if (after === null || after.validity !== validity) return { ok: true, at: { validity, uid: last }, mails: [], renumbered: after !== null, more: false };
      if (last <= after.uid) return { ok: true, at: after, mails: [], renumbered: false, more: false };
      const found = await client.search({ uid: `${after.uid + 1}:*` }, { uid: true });
      const waiting = (Array.isArray(found) ? found : []).filter(uid => uid > after.uid).sort((a, b) => a - b);
      const uids = waiting.slice(0, limit);
      const mails: InboundMail[] = [];
      if (uids.length > 0) {
        for await (const message of client.fetch(uids.join(","), { uid: true, source: { start: 0, maxLength: SOURCE_BYTES } }, { uid: true })) {
          if (message.source !== undefined) mails.push(await readMail(message.uid, message.source));
        }
      }
      mails.sort((a, b) => a.uid - b.uid);
      return { ok: true, at: { validity, uid: uids.at(-1) ?? after.uid }, mails, renumbered: false, more: waiting.length > uids.length };
    } finally {
      lock.release();
    }
  } catch (error) {
    return { ok: false, ...problemOf(error) };
  } finally {
    await client.logout().catch(() => client.close());
  }
};
