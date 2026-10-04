/**
 * Steps that reach outside (v87): a web request, an email, and a call to one
 * of the project's tools (its MCP servers). Each runs in the worker's step
 * pass (flow-steps.ts), once per visit of a card.
 *
 * - Web request: the address's scheme and host are written out in the
 *   zone (flows.ts refuses fill-ins there); fill-ins in its path and query
 *   are encoded, so a card can never change where a request goes. Secrets
 *   ({{secret.NAME}}) are filled into headers only, from a 0600 file per
 *   project beside the database, and never reach a log, a card or a chat.
 * - Email: through the operator's own mail server (Settings → Email), with
 *   the password in a 0600 file beside the database. Recipients are checked
 *   addresses; the subject can't carry a line break.
 * - Tool: the project's own MCP server, started like its Test button starts
 *   it, with the project's tool secrets and nothing else of ours.
 *
 * A refusal (a 4xx, a rejected recipient, a tool that says it failed) is an
 * answer: the card takes its failure path. Trouble reaching a service is
 * tried again, like every step.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import nodemailer from "nodemailer";
import { redactSecretAssignments } from "./builder.js";
import { redactSecretLines, scanForSecrets } from "./evidence.js";
import { fillFlowText, type FlowStage } from "./flows.js";
import { googleAccessToken, googleConnected } from "./google-mail.js";
import { ADDRESS, readEmailSettings, type EmailSettings } from "./email-settings.js";
import { readFlowSecrets, scrubSecrets } from "./flow-secrets.js";

export { readEmailSettings, saveEmailSettings, type EmailSettings } from "./email-settings.js";
import { callProjectTool, projectToolsOf, readToolSecrets, type ToolCall, type ToolSpec } from "./project-tools.js";
import { ALL_CREDENTIAL_ENV } from "./provider.js";
import type { FlowCardRow, Store } from "./store.js";

/** `output` is the answer whole: the step passes it on whole up to TEXT_LIMITS.stageOutput, and attaches longer to the card, linked (flow-steps settle). */
export type ActionOutcome = { state: "passed" | "failed" | "retry"; said: string; log?: string; output?: string;
  /** email (v91): the Message-ID it went out with, and to whom, so a reply finds the card. */
  mail?: { id: string; to: string[] } };
const clip = (text: string, cap: number) => text.length <= cap ? text : `${text.slice(0, cap - 1)}…`;
const blank = (text: string) => redactSecretAssignments(redactSecretLines(text, scanForSecrets(text)));

const scrub = scrubSecrets;

/** Fill every string inside a JSON value, leaving its shape alone: a card's text can never break out of a string. */
function fillJson(value: unknown, fill: (text: string) => string): unknown {
  if (typeof value === "string") return fill(value);
  if (Array.isArray(value)) return value.map(one => fillJson(one, fill));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, one]) => [key, fillJson(one, fill)]));
  return value;
}

// ---- secrets for web requests and scripts: flow-secrets.ts (a leaf module) ----------
export { flowSecretNames, readFlowSecrets, scrubSecrets, SECRET_NAME, setFlowSecret } from "./flow-secrets.js";


// ---- web requests ---------------------------------------------------------------

export type Fetcher = typeof fetch;

export async function runRequest(stage: FlowStage, card: FlowCardRow, repo: string, io: { fetch: Fetcher; dir: string | null }): Promise<ActionOutcome> {
  const request = stage.request!;
  const secrets = readFlowSecrets(io.dir, repo);
  const text = { title: card.title, description: card.description, note: card.note, outputs: card.outputs };
  const url = fillFlowText(request.url, text, encodeURIComponent);
  const missing: string[] = [];
  const headers: Record<string, string> = {};
  for (const [name, template] of Object.entries(request.headers)) {
    const withSecrets = template.replace(/\{\{\s*secret\.([A-Z][A-Z0-9_]*)\s*\}\}/g, (_match, secret: string) => {
      if (secrets[secret] === undefined) missing.push(secret);
      return secrets[secret] ?? "";
    });
    headers[name] = fillFlowText(withSecrets, text).replace(/[\r\n]+/g, " ");
  }
  if (missing.length > 0) return { state: "failed", said: `Set the secret${missing.length === 1 ? "" : "s"} ${[...new Set(missing)].join(", ")} on the step first.` };
  let body: string | undefined;
  if (request.body !== null && request.method !== "GET" && request.method !== "DELETE") {
    let parsed: unknown = undefined;
    try { parsed = JSON.parse(request.body); } catch { parsed = undefined; }
    if (parsed !== undefined && typeof parsed === "object" && parsed !== null) {
      body = JSON.stringify(fillJson(parsed, one => fillFlowText(one, text)));
      if (!Object.keys(headers).some(one => one.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
    } else {
      body = fillFlowText(request.body, text);
      if (!Object.keys(headers).some(one => one.toLowerCase() === "content-type")) headers["content-type"] = "text/plain; charset=utf-8";
    }
  }
  const where = (() => { try { const parsed = new URL(url); return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`; } catch { return "the address"; } })();
  const shown = (() => { try { const parsed = new URL(url); return `${parsed.origin}${parsed.pathname}${parsed.search === "" ? "" : "?…"}`; } catch { return url; } })();
  let response: Response;
  try {
    response = await io.fetch(url, { method: request.method, headers, ...(body === undefined ? {} : { body }), signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    return { state: "retry", said: `Couldn't reach ${where}${error instanceof Error && error.name === "TimeoutError" ? " within 30 seconds" : ""}.` };
  }
  const answered = blank(scrub(clip(await response.text().catch(() => ""), 64_000), secrets));
  const log = `${request.method} ${shown}\n→ ${response.status} ${response.statusText}\n\n${clip(answered, 64_000)}`;
  const first = answered.trim().split("\n")[0]?.slice(0, 160) ?? "";
  if (response.ok) return { state: "passed", said: `${where} answered ${response.status}.`, log, output: answered };
  if (response.status === 429 || response.status >= 500) return { state: "retry", said: `${where} answered ${response.status}${first === "" ? "" : `: ${first}`}.`, log };
  return { state: "failed", said: `${where} refused it (${response.status})${first === "" ? "" : `: ${first}`}.`, log, output: answered };
}

// ---- email ----------------------------------------------------------------------

/** The operator's mail server: everything but the password is shown back. */
/** Whether Send email steps can send: a connected Google account or a mail server. */
export function sendingReady(dir: string | null): boolean {
  return googleConnected(dir) !== null || readEmailSettings(dir) !== null;
}

/** The account Send email steps send from, signed in: Google when connected, else the mail server. */
export async function sendingAccount(dir: string | null, fetcher: typeof fetch): Promise<{ ok: true; settings: EmailSettings & { password: string; accessToken?: string } } | { ok: false; said: string; permanent: boolean }> {
  if (googleConnected(dir) !== null) {
    const token = await googleAccessToken(dir, fetcher);
    if (!token.ok) return token;
    return { ok: true, settings: { host: "smtp.gmail.com", port: 465, secure: true, user: token.address, from: token.address, password: "", accessToken: token.token, imap: null } };
  }
  const server = readEmailSettings(dir);
  return server === null ? { ok: false, said: "Email isn't set up yet. Add your mail server in Settings → Email.", permanent: false } : { ok: true, settings: server };
}

/** `inReplyTo` and `references` keep a reply in the thread of the email a card came from. */
export type Mail = { from: string; to: string[]; subject: string; text: string; inReplyTo?: string; references?: string[] };
export type MailSender = (settings: EmailSettings & { password: string; accessToken?: string }, mail: Mail) => Promise<{ ok: true; id: string } | { ok: false; said: string; permanent: boolean }>;

/** The production sender: the operator's mail server through nodemailer. */
export const sendThroughServer: MailSender = async (settings, mail) => {
  const transport = nodemailer.createTransport({
    // A password never travels unencrypted: with a sign-in, the connection must be (or become) TLS.
    host: settings.host, port: settings.port, secure: settings.secure, requireTLS: !settings.secure && settings.user !== "",
    ...(settings.accessToken !== undefined ? { auth: { type: "OAuth2" as const, user: settings.user, accessToken: settings.accessToken } } : settings.user === "" ? {} : { auth: { user: settings.user, pass: settings.password } }),
    connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
  });
  try {
    const sent = await transport.sendMail({ from: mail.from, to: mail.to, subject: mail.subject, text: mail.text,
      ...(mail.inReplyTo === undefined ? {} : { inReplyTo: mail.inReplyTo, references: mail.references ?? [mail.inReplyTo] }) });
    return { ok: true, id: String(sent.messageId ?? "") };
  } catch (error) {
    const code = (error as { responseCode?: unknown }).responseCode;
    const said = typeof code === "number" && code === 535 ? "The mail server refused the sign-in. Check it in Settings → Email."
      : typeof code === "number" && code >= 500 ? `The mail server refused it (${code}).`
      : "Couldn't reach the mail server.";
    return { ok: false, said, permanent: typeof code === "number" && code >= 500 && code !== 535 };
  } finally {
    transport.close();
  }
};

/** The thread a card's conversation is in (v91): the latest message, the chain, and everyone in it. */
export type MailThread = { inReplyTo: string; references: string[]; people: Set<string> };

export async function sendEmail(stage: FlowStage, card: FlowCardRow, io: { dir: string | null; mail?: MailSender; fetch?: typeof fetch }, thread: MailThread | null = null): Promise<ActionOutcome> {
  const account = await sendingAccount(io.dir, io.fetch ?? fetch);
  if (!account.ok) return { state: account.permanent ? "failed" : "retry", said: account.said };
  const settings = account.settings;
  const text = { title: card.title, description: card.description, note: card.note, outputs: card.outputs };
  const email = stage.email!;
  const to = [...new Set(fillFlowText(email.to, text).split(/[\s,;]+/).map(one => one.trim()).filter(one => ADDRESS.test(one)))].slice(0, 10);
  if (to.length === 0) return { state: "failed", said: "There's no one to send it to: the card has no email address." };
  const subject = clip(fillFlowText(email.subject, text).replace(/[\r\n]+/g, " "), 200);
  const body = clip(fillFlowText(email.body, text), 20_000);
  if (body.trim() === "") return { state: "failed", said: "The email would be empty." };
  // To someone the card is already writing with (or who emailed it): the email stays in that thread.
  const source = card.source?.mail;
  const known = thread ?? (source?.id ? { inReplyTo: source.id, references: [...source.references, source.id].slice(-20), people: new Set([source.from]) } : null);
  const threaded = known !== null && to.some(one => known.people.has(one.toLowerCase())) ? { inReplyTo: known.inReplyTo, references: known.references } : {};
  const sent = await (io.mail ?? sendThroughServer)(settings, { from: settings.from, to, subject, text: body, ...threaded });
  const log = `From ${settings.from} to ${to.join(", ")}\nSubject: ${subject}\n\n${blank(body)}`;
  if (!sent.ok) return { state: sent.permanent ? "failed" : "retry", said: sent.said, log };
  return { state: "passed", said: `Emailed ${to.join(", ")}.`, log, output: `Sent to ${to.join(", ")}: “${subject}”`, mail: { id: sent.id, to } };
}

// ---- tools ----------------------------------------------------------------------

export type ToolCaller = (spec: ToolSpec, values: Record<string, string>, name: string, args: Record<string, unknown>) => Promise<ToolCall>;

/** Whether the zone's tool is one of the project's, or what to say while it waits. */
export function toolWaiting(store: Store, stage: FlowStage, repo: string): string | null {
  const wanted = stage.tool?.server ?? "";
  return projectToolsOf(store, repo).some(one => one.name === wanted) ? null : `There's no tool called ${wanted || "(none)"} in this project. Add it on the Tools page.`;
}

export async function useTool(store: Store, stage: FlowStage, card: FlowCardRow, repo: string, io: { callTool?: ToolCaller; toolHome?: string }): Promise<ActionOutcome> {
  const call = stage.tool!;
  const tool = projectToolsOf(store, repo).find(one => one.name === call.server);
  if (tool === undefined) return { state: "retry", said: `There's no tool called ${call.server} in this project.` };
  const text = { title: card.title, description: card.description, note: card.note, outputs: card.outputs };
  const args = fillJson(JSON.parse(call.args), one => fillFlowText(one, text)) as Record<string, unknown>;
  const values = readToolSecrets(repo, tool.name, io.toolHome);
  const answer = await (io.callTool ?? ((spec, secrets, name, given) => callProjectTool(spec, secrets, name, given, { timeoutMs: 120_000, omitEnv: ALL_CREDENTIAL_ENV })))(tool.spec, values, call.name, args);
  if (!answer.ok) return { state: "retry", said: `${call.server}: ${answer.problem}` };
  const said = blank(scrub(clip(answer.text, 64_000), values));
  const log = `${call.server} → ${call.name}\n${blank(JSON.stringify(args, null, 2)).slice(0, 4000)}\n\n${clip(said, 64_000)}`;
  if (answer.isError) return { state: "failed", said: `${call.server} → ${call.name} said it failed${said.trim() === "" ? "" : `: ${said.trim().split("\n")[0]!.slice(0, 160)}`}.`, log, output: said };
  return { state: "passed", said: `${call.server} → ${call.name} done.`, log, output: said };
}
