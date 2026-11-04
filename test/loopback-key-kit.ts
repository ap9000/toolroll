/**
 * The browser mutation key's attack fixtures (test/attacks/loopback-key-*.test.ts): a real console on a protected
 * loopback install (bound to 127.0.0.1, key on), a browser that signs in through the key's one delivery, and an
 * "attacker" that holds the same cookie, as any server on another port of this computer does (RFC 6265 §8.5).
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addApprover } from "../src/scope.js";
import { createDecisionServer, type DecisionServer } from "../src/serve.js";
import { openStore, type Store } from "../src/store.js";
import { SESSION_COOKIE } from "../src/server/session.js";

export type Console = { server: DecisionServer; port: number; base: string };
export type Answer = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

export function world(file = ":memory:"): { dir: string; store: Store; password: string; close(): void } {
  const dir = mkdtempSync(join(tmpdir(), "toolroll-key-"));
  mkdirSync(join(dir, "evidence"));
  const store = openStore(file === ":memory:" ? file : join(dir, file));
  const added = addApprover(store, "alex", new Date());
  if (!added.ok) throw new Error("no approver");
  return { dir, store, password: added.token, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

export async function startConsole(store: Store, dir: string, extra: Partial<Parameters<typeof createDecisionServer>[0]> = {}, port = 0): Promise<Console> {
  const server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), configDir: dir, chatEnv: {}, platform: "darwin", browserKey: true, terminalHost: null, ...extra });
  await new Promise<void>((done, failed) => { server.once("error", failed); server.listen(port, "127.0.0.1", done); });
  const address = server.address();
  const bound = typeof address === "object" && address !== null ? address.port : 0;
  return { server, port: bound, base: `http://127.0.0.1:${bound}` };
}

export const stop = (one: Console): Promise<void> => new Promise(done => one.server.close(() => done()));

/** A raw request: the Host, Origin and cookie are exactly what's given (fetch would correct a spoofed Host). */
export function raw(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method, agent: false, headers: { Host: `127.0.0.1:${port}`, ...(body === undefined ? {} : { "content-length": String(Buffer.byteLength(body)) }), ...headers } }, response => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

export const cookieOf = (answer: Answer): string => [answer.headers["set-cookie"] ?? []].flat().map(one => String(one).split(";")[0]!).find(one => one.startsWith(`${SESSION_COOKIE}=`) && one !== `${SESSION_COOKIE}=`) ?? "";
/** What the delivery page's one script writes to localStorage: `{ epoch, key }`. */
export function deliveredKey(answer: Answer): { epoch: string; key: string } | null {
  const data = /var d=(\{.*?\});try/.exec(answer.body)?.[1];
  if (data === undefined) return null;
  const { value } = JSON.parse(data) as { value: string };
  return JSON.parse(value) as { epoch: string; key: string };
}

/** Sign in with the password, as a browser on this computer: the cookie and the key the delivery page stores. */
export async function signIn(port: number, password: string): Promise<{ cookie: string; key: string; delivery: Answer }> {
  const delivery = await raw(port, "POST", "/login", { "content-type": "application/x-www-form-urlencoded", origin: `http://127.0.0.1:${port}` }, new URLSearchParams({ name: "alex", token: password }).toString());
  const key = deliveredKey(delivery)?.key;
  if (key === undefined) throw new Error(`no key delivered: ${delivery.status}`);
  return { cookie: cookieOf(delivery), key, delivery };
}

/** The CSRF token any cookie holder reads from a page (it is rendered, as before). */
export async function csrfOf(port: number, cookie: string): Promise<string> {
  const page = await raw(port, "GET", "/chat?format=workspace", { cookie });
  const csrf = (JSON.parse(page.body) as { csrf?: string }).csrf ?? "";
  if (!/^[0-9a-f]{64}$/.test(csrf)) throw new Error(`no csrf readable (${page.status})`);
  return csrf;
}

/** A form post from the console's own origin (valid Host, Origin and CSRF), with or without the key. */
export function post(port: number, path: string, cookie: string, fields: Record<string, string>, key?: string): Promise<Answer> {
  return raw(port, "POST", path, { cookie, origin: `http://127.0.0.1:${port}`, "content-type": "application/x-www-form-urlencoded", ...(key === undefined ? {} : { "x-toolroll-key": key }) },
    new URLSearchParams(fields).toString());
}

/** A terminal socket's upgrade: the HTTP status it is answered with (101 when it opens). */
export function upgrade(port: number, cookie: string, protocols: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: `/term/${"a".repeat(32)}/socket`, headers: {
      Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: cookie, Connection: "Upgrade", Upgrade: "websocket",
      "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": randomBytes(16).toString("base64"), ...(protocols.length === 0 ? {} : { "Sec-WebSocket-Protocol": protocols.join(", ") }) } });
    req.on("response", response => { response.resume(); resolve(response.statusCode ?? 0); });
    req.on("upgrade", (_response, socket) => { socket.destroy(); resolve(101); });
    req.on("error", reject);
    req.end();
  });
}

export const KEY_REFUSED = /isn(?:'|&#39;|\u2019|’)t connected to Toolroll/;
export const RESTARTED_REFUSED = /Toolroll restarted/;
