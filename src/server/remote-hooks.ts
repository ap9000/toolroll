import { adapterPolicy } from "./route-policy.js";
/**
 * The remote domain's public roads (moved from serve.ts unchanged): the liveness probe and the webhooks a public
 * relay may expose. Each is declared in the route table's edge stage and answers before the console's sign-in.
 */
import type { IncomingMessage,ServerResponse } from "node:http";
import { flowFormPage,FORM_PATH,HOOK_PATH,receiveFlowForm,receiveFlowHook } from "../flow-triggers.js";
import type { Store } from "../store.js";
import { keepPushedUpdate,loadBotToken,pushedByTelegram,telegramHookSecret } from "../telegram.js";

/** What the hooks read from the server: its store, clock and the two configuration paths. */
export interface RemoteHookContext {
  readonly store: Store;
  readonly clock: () => Date;
  readonly options: { readonly configDir?: string | undefined; readonly telegramTokenFile?: string | undefined };
}

/** Flow webhooks (v82): the one road a public relay may expose. The secret
 * address proves nothing about the sender on its own for GitHub and Linear:
 * their signatures are checked too. Nothing runs here; cards wait for a pass. */
/**
 * v98: Telegram pushes this bot's updates here. Only a request carrying our
 * secret header is Telegram's; each update is kept for the bridge (which
 * applies it through the same door as a polled one), and answered at once so
 * Telegram doesn't send it again. An update already kept or applied is fine.
 */
export async function telegramHook(ctx: RemoteHookContext, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const { store, options, clock } = ctx;
  const reply = (status: number) => { response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }); response.end(status === 200 ? "ok" : "no"); request.resume(); };
  const source = options.configDir === undefined || options.telegramTokenFile === undefined ? null : loadBotToken(process.env, options.telegramTokenFile);
  if (source === null || options.configDir === undefined) return reply(404);
  if (request.method !== "POST") return reply(405);
  if (!pushedByTelegram(request.headers["x-telegram-bot-api-secret-token"], telegramHookSecret(options.configDir))) return reply(401);
  if (!adapterPolicy({ caller: "service", capability: "none" }).ok) return reply(403);
  if (Number(request.headers["content-length"] ?? 0) > 1_000_000) return reply(413);
  const chunks: Buffer[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      let size = 0;
      request.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 1_000_000) reject(new Error("too-large")); else chunks.push(chunk); });
      request.on("end", resolve);
      request.on("error", reject);
    });
  } catch { return reply(413); }
  try {
    return reply(keepPushedUpdate(store, source.botId, Buffer.concat(chunks), clock()).ok ? 200 : 400);
  } catch { return reply(500); }
}

export async function flowHook(ctx: RemoteHookContext, request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  const { store, options, clock } = ctx;
  const reply = (status: number, said: string) => { response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); response.end(JSON.stringify({ said })); request.resume(); };
  if (url.pathname.startsWith(FORM_PATH)) return flowForm(ctx, request, response, url);
  if (options.configDir === undefined || !url.pathname.startsWith(HOOK_PATH)) return reply(404, "No such address.");
  if (request.method !== "POST") return reply(405, "Send a POST.");
  if (Number(request.headers["content-length"] ?? 0) > 1_000_000) return reply(413, "Too large.");
  const chunks: Buffer[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      let size = 0;
      request.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 1_000_000) reject(new Error("too-large")); else chunks.push(chunk); });
      request.on("end", resolve);
      request.on("error", reject);
    });
  } catch (error) { return reply(error instanceof Error && error.message === "too-large" ? 413 : 400, "Couldn't read that."); }
  try {
    const answer = receiveFlowHook(store, url.pathname.slice(HOOK_PATH.length), { headers: request.headers, body: Buffer.concat(chunks) }, options.configDir, clock());
    return reply(answer.status, answer.said);
  } catch { return reply(500, "Not saved."); }
}

/** A shared button as a public form (v84): its questions, and one card per submission. No sign-in, no session, nothing about the flow shown. */
export async function flowForm(ctx: RemoteHookContext, request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  const { store, clock } = ctx;
  const page = (answer: { status: number; html: string }) => {
    response.writeHead(answer.status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
      "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" });
    response.end(request.method === "HEAD" ? undefined : answer.html);
    request.resume();
  };
  const token = url.pathname.slice(FORM_PATH.length);
  if (request.method === "GET" || request.method === "HEAD") return page(flowFormPage(store, token, clock()));
  if (request.method !== "POST") return page({ status: 405, html: "" });
  if (Number(request.headers["content-length"] ?? 0) > 65_536) return page({ status: 413, html: "" });
  let raw = "";
  try {
    await new Promise<void>((resolve, reject) => {
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { raw += chunk; if (raw.length > 65_536) reject(new Error("too-large")); });
      request.on("end", resolve);
      request.on("error", reject);
    });
  } catch { return page({ status: 413, html: "" }); }
  try { return page(receiveFlowForm(store, token, new URLSearchParams(raw), clock())); }
  catch { return page({ status: 500, html: "" }); }
}

export function healthz(store: Store, response: ServerResponse, head: boolean): void {
  let healthy = true;
  try { store.handle.prepare("SELECT 1 FROM schema_version").get(); } catch { healthy = false; }
  const body = JSON.stringify({ status: healthy ? "ok" : "unavailable" });
  response.writeHead(healthy ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(head ? undefined : body);
}
