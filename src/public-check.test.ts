/**
 * `toolroll serve check-public`: the console on this computer is real; the public address is a stand-in, since a test
 * has no domain, certificate or proxy. Live DNS, certificates and proxies are exercised only by running it for real.
 */
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { createDecisionServer } from "./serve.js";
import { runOperate } from "./operate.js";
import { envelopeProblems } from "./contracts/cli.js";
import { checkPublic, networkProbe, type Probe, type ProbeAnswer } from "./public-check.js";
import { HSTS_VALUE, USE_HTTPS } from "./public-access.js";

const URL_ = "https://toolroll.example.test";
const opened: { dir: string; store: Store; server: Server }[] = [];
afterEach(async () => {
  for (const one of opened.splice(0)) {
    await new Promise<void>(resolve => one.server.close(() => resolve()));
    one.store.close();
    rmSync(one.dir, { recursive: true, force: true });
  }
});

async function console_(publicUrl?: string): Promise<number> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "toolroll-check-public-")));
  const store = openStore(join(dir, "orders.db"));
  const server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), ...(publicUrl === undefined ? {} : { publicUrl }) });
  opened.push({ dir, store, server });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

/** The public side as a healthy same-host proxy would answer, with overrides per path. */
const outside = (paths: Record<string, ProbeAnswer> = {}): Probe => async request => {
  if (request.url.startsWith("http://127.0.0.1:")) return networkProbe(request);
  expect(request.headers, "no credentials leave").toEqual({});
  const path = new URL(request.url).pathname;
  return paths[path] ?? (path === "/login" ? { status: 200, headers: { "strict-transport-security": HSTS_VALUE }, body: "" } : { status: 401, headers: {}, body: "Sign in." });
};
const messages = async (options: { publicUrl?: string; port: number; allowHosts?: string[] }, probe: Probe) =>
  (await checkPublic({ publicUrl: options.publicUrl, port: options.port, allowHosts: options.allowHosts ?? [] }, probe)).map(one => `${one.check}: ${one.message}`);

test("a server on its public URL behind a same-host proxy is ready", async () => {
  const port = await console_(URL_);
  expect(await messages({ publicUrl: URL_, port, allowHosts: ["192.168.1.20:4180", "laptop.tail1234.ts.net:4180"] }, outside())).toEqual([]);
});

test("names a missing or malformed --public-url and a public --allow-host", async () => {
  const port = await console_(URL_);
  expect(await messages({ port }, outside())).toEqual([expect.stringMatching(/^public-url: --public-url is missing/)]);
  expect(await messages({ publicUrl: "http://toolroll.example.test", port }, outside())).toEqual(["public-url: --public-url must start with https:// (got http://)."]);
  expect(await messages({ publicUrl: `${URL_}/console`, port }, outside())).toEqual([expect.stringMatching(/no path, query or credentials/)]);
  expect(await messages({ publicUrl: URL_, port, allowHosts: ["toolroll.example.org", "bad host"] }, outside())).toEqual([
    expect.stringMatching(/^allow-host: --allow-host toolroll\.example\.org is a public name served over plain HTTP/),
    "allow-host: --allow-host bad host is not a host name or host:port.",
  ]);
});

test("names a console that is not running, or not started with this --public-url", async () => {
  const closed = await console_(URL_);
  await new Promise<void>(resolve => opened.pop()!.server.close(() => resolve()));
  expect(await messages({ publicUrl: URL_, port: closed }, outside())).toEqual([`local: Nothing answers on 127.0.0.1:${closed}. Start Toolroll there, or pass the --port it uses.`]);
  const plain = await console_();
  expect(await messages({ publicUrl: URL_, port: plain }, outside())).toEqual([`host: The server on port ${plain} does not answer as toolroll.example.test. Restart it with --public-url ${URL_}.`]);
});

test("names certificate, proxy and HSTS problems at the public address", async () => {
  const port = await console_(URL_);
  const failing = (error: string): Probe => async request => request.url.startsWith("http://127.0.0.1:") ? networkProbe(request) : { error };
  expect(await messages({ publicUrl: URL_, port }, failing("CERT_HAS_EXPIRED"))).toEqual(["certificate: The certificate for toolroll.example.test has expired. Renew it."]);
  expect(await messages({ publicUrl: URL_, port }, failing("DEPTH_ZERO_SELF_SIGNED_CERT"))).toEqual([expect.stringMatching(/^certificate: The certificate for toolroll\.example\.test is not trusted/)]);
  expect(await messages({ publicUrl: URL_, port }, failing("ERR_TLS_CERT_ALTNAME_INVALID"))).toEqual(["certificate: The certificate does not name toolroll.example.test. Issue one for this exact host."]);
  expect(await messages({ publicUrl: URL_, port }, failing("ENOTFOUND"))).toEqual([expect.stringMatching(/^certificate: toolroll\.example\.test does not resolve/)]);
  expect(await messages({ publicUrl: URL_, port }, outside({ "/login": { status: 421, headers: {}, body: "" } }))).toEqual([expect.stringMatching(/^proxy: The proxy changes the Host header/)]);
  // A proxy on another computer, or one that drops X-Forwarded-Proto: no HSTS, and tokens refused as plain HTTP.
  expect(await messages({ publicUrl: URL_, port }, outside({ "/login": { status: 200, headers: {}, body: "" }, "/api/cli": { status: 403, headers: {}, body: USE_HTTPS } }))).toEqual([
    expect.stringMatching(/^hsts: https:\/\/toolroll\.example\.test sends no Strict-Transport-Security/),
    expect.stringMatching(/^proxy: Requests through https:\/\/toolroll\.example\.test reach Toolroll as plain HTTP/),
  ]);
  expect(await messages({ publicUrl: URL_, port }, outside({ "/login": { status: 200, headers: { "strict-transport-security": "max-age=300" }, body: "" } }))).toEqual([
    "hsts: https://toolroll.example.test sets Strict-Transport-Security max-age=300; use at least 31536000 (one year).",
  ]);
});

test("answers as one checked envelope, and refuses a bad --port", async () => {
  const port = await console_();
  const lines: string[] = [];
  const code = await runOperate("serve", ["check-public", "--public-url", URL_, "--port", String(port), "--json"], line => lines.push(line), { publicProbe: outside(), databaseFile: join(tmpdir(), "so-never-opened.db") });
  expect(code).toBe(1);
  const envelope = JSON.parse(lines.join("")) as Record<string, unknown>;
  expect(envelopeProblems(envelope)).toEqual([]);
  expect(envelope).toMatchObject({ ok: false, command: "serve check-public", reason: "not-ready", port, findings: [{ check: "host" }] });
  const human: string[] = [];
  expect(await runOperate("serve", ["check-public", "--public-url", URL_, "--port", String(port)], line => human.push(line), { publicProbe: outside() })).toBe(1);
  expect(human).toEqual([`1 problem serving ${URL_}:`, `- The server on port ${port} does not answer as toolroll.example.test. Restart it with --public-url ${URL_}.`]);
  expect(await runOperate("serve", ["check-public", "--port", "0"], () => {}, { publicProbe: outside() })).toBe(2);
});

test("docs/team-server.md keeps its runnable parts", () => {
  const doc = readFileSync(new URL("../docs/team-server.md", import.meta.url), "utf8");
  for (const part of ["reverse_proxy 127.0.0.1:4180", "service: http://127.0.0.1:4180", "systemctl --user enable --now toolroll", "toolroll backup now",
    "repos add-from-github", "--runner server", "serve check-public", "--token-file", "claude mcp add --transport http"]) expect(doc, part).toContain(part);
  expect(doc).not.toMatch(/so_[A-Za-z0-9]/);
});
