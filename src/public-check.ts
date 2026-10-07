/**
 * `toolroll serve check-public` (remote team, phase 3): is this server ready to be reached on its real domain?
 * Read-only: it sends no credentials, follows no redirects and changes nothing. It checks the --public-url and
 * --allow-host values, asks the console on this computer what it does with relayed requests, then fetches the public
 * address with the platform's own certificate checks and reads what comes back. Each problem is one line saying
 * what to change.
 */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { HSTS_VALUE, isLoopbackAddress, isTailnetAddress, USE_HTTPS } from "./public-access.js";

export type ProbeRequest = { url: string; headers: Record<string, string> };
export type ProbeAnswer = { status: number; headers: Record<string, string | string[] | undefined>; body: string } | { error: string };
/** One bounded GET: no credentials, no redirects. */
export type Probe = (request: ProbeRequest) => Promise<ProbeAnswer>;

export type Finding = { check: "public-url" | "allow-host" | "local" | "host" | "forwarding" | "certificate" | "proxy" | "hsts"; message: string };

const TIMEOUT_MS = 10_000;
/** A documentation address (RFC 5737): the remote caller the local probe pretends to relay for. */
const SAMPLE_CALLER = "203.0.113.10";
const HOST_GRAMMAR = /^[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?$|^\[[0-9A-Fa-f:.]{2,45}\](:[0-9]{1,5})?$/;

/** The default probe: node's http/https with the platform trust store, a timeout and a 4 KB body cap. */
export const networkProbe: Probe = ({ url, headers }) => new Promise(resolve => {
  const target = new URL(url);
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  const outgoing = send(target, { method: "GET", headers, timeout: TIMEOUT_MS }, incoming => {
    let body = "";
    incoming.setEncoding("utf8");
    incoming.on("data", (chunk: string) => { if (body.length < 4096) body += chunk; });
    incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body }));
    incoming.on("error", error => resolve({ error: codeOf(error) }));
  });
  outgoing.on("timeout", () => { outgoing.destroy(); resolve({ error: "ETIMEDOUT" }); });
  outgoing.on("error", error => resolve({ error: codeOf(error) }));
  outgoing.end();
});

const codeOf = (error: unknown): string =>
  typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "EUNKNOWN";

/** The exact https origin --public-url must be, as serve.ts requires it; else what is wrong with it. */
export function publicOriginOf(value: string | undefined): URL | string {
  if (value === undefined) return "--public-url is missing. Pass the address engineers will use, like --public-url https://toolroll.example.com.";
  let parsed: URL;
  try { parsed = new URL(value); } catch { return `--public-url ${value} is not a URL. Use https://<your domain>.`; }
  if (parsed.protocol !== "https:") return `--public-url must start with https:// (got ${parsed.protocol}//).`;
  if (parsed.username !== "" || parsed.password !== "" || parsed.hash !== "" || parsed.search !== "" || (parsed.pathname !== "/" && parsed.pathname !== "")) {
    return "--public-url must be just https://<host>, with no path, query or credentials.";
  }
  return parsed;
}

/** Names a plain-HTTP browser can reasonably use: this computer, the tailnet, a LAN or a single-label name. */
function privateName(host: string): boolean {
  const name = host.replace(/:[0-9]{1,5}$/, "").replace(/^\[(.*)\]$/, "$1").toLowerCase();
  if (name === "localhost" || name.endsWith(".ts.net") || name.endsWith(".local") || !name.includes(".") && !name.includes(":")) return true;
  if (isLoopbackAddress(name) || isTailnetAddress(name)) return true;
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(name);
  if (v4 !== null) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return /^f[cd][0-9a-f]{2}:|^fe80:/.test(name);
}

const header = (answer: { headers: Record<string, string | string[] | undefined> }, name: string): string | undefined => {
  const value = answer.headers[name];
  return Array.isArray(value) ? value.join(", ") : value;
};
/** The HSTS max-age a response sets, or null when it sets none. */
const hstsAge = (value: string | undefined): number | null => {
  const match = value === undefined ? null : /(?:^|;)\s*max-age\s*=\s*"?(\d+)"?/i.exec(value);
  return match === null ? null : Number(match[1]);
};
const refusedForHttp = (answer: ProbeAnswer): boolean => !("error" in answer) && answer.status === 403 && answer.body.trim() === USE_HTTPS;

function certificateProblem(host: string, code: string): string {
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `${host} does not resolve. Point its DNS at this server or your tunnel.`;
  if (code === "ECONNREFUSED") return `Nothing answers HTTPS at ${host}. Start Caddy or the tunnel.`;
  if (code === "ETIMEDOUT" || code === "ECONNRESET") return `${host} did not answer over HTTPS within ${TIMEOUT_MS / 1000} seconds. Check the firewall, Caddy or the tunnel.`;
  if (code === "CERT_HAS_EXPIRED") return `The certificate for ${host} has expired. Renew it.`;
  if (code === "ERR_TLS_CERT_ALTNAME_INVALID") return `The certificate does not name ${host}. Issue one for this exact host.`;
  if (/SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|CERT_UNTRUSTED/.test(code)) return `The certificate for ${host} is not trusted (${code}). Use a publicly trusted certificate, such as Caddy's automatic one.`;
  return `Could not reach https://${host} (${code}).`;
}

/** Every problem with serving on --public-url, in a fixed order; an empty list means ready. */
export async function checkPublic(options: { publicUrl: string | undefined; port: number; allowHosts: readonly string[] }, probe: Probe = networkProbe): Promise<Finding[]> {
  const origin = publicOriginOf(options.publicUrl);
  if (typeof origin === "string") return [{ check: "public-url", message: origin }];
  const host = origin.host;
  const findings: Finding[] = [];
  for (const allowed of options.allowHosts) {
    if (!HOST_GRAMMAR.test(allowed)) findings.push({ check: "allow-host", message: `--allow-host ${allowed} is not a host name or host:port.` });
    else if (allowed !== host && !privateName(allowed)) {
      findings.push({ check: "allow-host", message: `--allow-host ${allowed} is a public name served over plain HTTP, so passwords would cross the internet unencrypted. Remove it: --public-url already admits ${host}.` });
    }
  }

  // The console on this computer, asked as the same-host proxy would ask it.
  const local = `http://127.0.0.1:${options.port}`;
  const relayed = { host, "x-forwarded-for": SAMPLE_CALLER };
  const page = await probe({ url: `${local}/login`, headers: { ...relayed, "x-forwarded-proto": "https" } });
  if ("error" in page) {
    findings.push({ check: "local", message: `Nothing answers on 127.0.0.1:${options.port}. Start Toolroll there, or pass the --port it uses.` });
  } else if (page.status === 421) {
    findings.push({ check: "host", message: `The server on port ${options.port} does not answer as ${host}. Restart it with --public-url ${origin.origin}.` });
  } else {
    if (header(page, "strict-transport-security") !== HSTS_VALUE) {
      findings.push({ check: "hsts", message: `The server sends no Strict-Transport-Security for ${host} over HTTPS. Update Toolroll and restart it with --public-url ${origin.origin}.` });
    }
    const plain = await probe({ url: `${local}/api/cli`, headers: { ...relayed, "x-forwarded-proto": "http" } });
    if (!refusedForHttp(plain)) {
      findings.push({ check: "forwarding", message: "The server does not refuse API tokens relayed over plain HTTP from another computer. Update Toolroll." });
    }
  }

  // The public address, with the platform's certificate checks.
  const outside = await probe({ url: `${origin.origin}/login`, headers: {} });
  if ("error" in outside) {
    findings.push({ check: "certificate", message: certificateProblem(host, outside.error) });
    return findings;
  }
  if (outside.status === 421) {
    findings.push({ check: "proxy", message: `The proxy changes the Host header, so Toolroll refuses ${host}. Pass the original Host through.` });
    return findings;
  }
  const age = hstsAge(header(outside, "strict-transport-security"));
  if (age === null) {
    findings.push({ check: "hsts", message: `https://${host} sends no Strict-Transport-Security. Run the proxy on this computer and have it send X-Forwarded-Proto: https.` });
  } else if (age < 31_536_000) {
    findings.push({ check: "hsts", message: `https://${host} sets Strict-Transport-Security max-age=${age}; use at least 31536000 (one year).` });
  }
  const api = await probe({ url: `${origin.origin}/api/cli`, headers: {} });
  if (refusedForHttp(api)) {
    findings.push({ check: "proxy", message: `Requests through https://${host} reach Toolroll as plain HTTP from another computer. Run the proxy on this computer, pointed at 127.0.0.1:${options.port}, sending X-Forwarded-For and X-Forwarded-Proto.` });
  }
  return findings;
}

/** The command: findings as lines (or one envelope), exit 0 when ready, 1 when not, 2 for a malformed --port. */
export async function checkPublicCommand(
  flags: Map<string, string | true>,
  context: { write: (line: string) => void; json: boolean; envelope: (payload: { ok: boolean; command: string } & Record<string, unknown>) => string; probe?: Probe },
): Promise<number> {
  const command = "serve check-public";
  const value = (name: string) => { const one = flags.get(name); return typeof one === "string" ? one : undefined; };
  const portGiven = value("port");
  const port = Number(portGiven ?? 4180);
  if (!Number.isInteger(port) || port < 1 || port >= 65536) {
    const message = "--port is a whole number under 65536";
    context.write(context.json ? context.envelope({ ok: false, command, reason: "usage", message }) : message);
    return 2;
  }
  const publicUrl = value("public-url");
  const allowHosts = (value("allow-host") ?? "").split(",").map(one => one.trim()).filter(one => one !== "");
  const findings = await checkPublic({ publicUrl, port, allowHosts }, context.probe);
  const ready = findings.length === 0;
  const message = ready ? `${publicUrl} is ready: valid certificate, HSTS, and API tokens only over HTTPS.` : `${findings.length === 1 ? "1 problem" : `${findings.length} problems`} serving ${publicUrl ?? "on a public address"}:`;
  if (context.json) {
    context.write(context.envelope({ ok: ready, command, ...(ready ? {} : { reason: "not-ready", message }), publicUrl: publicUrl ?? null, port, findings }));
  } else {
    context.write(message);
    for (const finding of findings) context.write(`- ${finding.message}`);
  }
  return ready ? 0 : 1;
}
