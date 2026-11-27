/**
 * This computer's own names on its tailnet, when Tailscale is up: the console
 * answers to them on its port without an --allow-host, and the phone card
 * names the address to type. Read with `tailscale status --json`, which
 * spends nothing and changes nothing; any failure means no tailnet.
 */
import { existsSync } from "node:fs";
import { run } from "./exec.js";

type Runner = (file: string, args: readonly string[], options: { timeoutMs: number }) => Promise<{ code: number | null; stdout: string; notFound?: boolean }>;

/** The Mac app ships its command line inside the app bundle. */
const MAC_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

const NAME = /^[a-z0-9]([a-z0-9-]{0,62})(\.[a-z0-9]([a-z0-9-]{0,62}))*$/;

/** The full MagicDNS name first (machine.tailnet.ts.net), then its short form (machine). Empty when Tailscale isn't running. */
export function tailnetNamesOf(statusJson: string): string[] {
  let status: unknown;
  try { status = JSON.parse(statusJson); } catch { return []; }
  if (typeof status !== "object" || status === null) return [];
  const body = status as { BackendState?: unknown; Self?: { DNSName?: unknown; Online?: unknown } };
  if (body.BackendState !== "Running" || typeof body.Self?.DNSName !== "string") return [];
  const full = body.Self.DNSName.replace(/\.$/, "").toLowerCase();
  if (!NAME.test(full) || full.length > 253) return [];
  const short = full.split(".")[0]!;
  return short === full ? [full] : [full, short];
}

export async function readTailnetNames(runner: Runner = run, platform: NodeJS.Platform = process.platform): Promise<string[]> {
  const candidates = ["tailscale", ...(platform === "darwin" && existsSync(MAC_APP_CLI) ? [MAC_APP_CLI] : [])];
  for (const file of candidates) {
    try {
      const answer = await runner(file, ["status", "--json"], { timeoutMs: 3_000 });
      if (answer.notFound === true) continue;
      if (answer.code === 0) return tailnetNamesOf(answer.stdout);
    } catch {
      // No Tailscale here: no tailnet names.
    }
  }
  return [];
}

/** This computer's Tailscale IPv4 address (100.64/10) from `tailscale status --json`, or null. */
export function tailnetIpv4Of(statusJson: string): string | null {
  let status: unknown;
  try { status = JSON.parse(statusJson); } catch { return null; }
  if (typeof status !== "object" || status === null) return null;
  const body = status as { BackendState?: unknown; Self?: { TailscaleIPs?: unknown } };
  if (body.BackendState !== "Running" || !Array.isArray(body.Self?.TailscaleIPs)) return null;
  for (const ip of body.Self.TailscaleIPs) {
    if (typeof ip !== "string") continue;
    const m = /^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
    if (m !== null && Number(m[1]) >= 64 && Number(m[1]) <= 127 && Number(m[2]) <= 255 && Number(m[3]) <= 255) return ip;
  }
  return null;
}

export async function readTailnetIpv4(runner: Runner = run, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  return (await readTailnetStatus(runner, platform)).ipv4;
}

/** Whether Tailscale is installed here (its command line answered at all, running or not) and, when it is up, this
 * computer's Tailscale IPv4 address. Phone access says "Tailscale not found" when it isn't installed. */
export async function readTailnetStatus(runner: Runner = run, platform: NodeJS.Platform = process.platform): Promise<{ found: boolean; ipv4: string | null }> {
  const candidates = ["tailscale", ...(platform === "darwin" && existsSync(MAC_APP_CLI) ? [MAC_APP_CLI] : [])];
  let found = false;
  for (const file of candidates) {
    try {
      const answer = await runner(file, ["status", "--json"], { timeoutMs: 3_000 });
      if (answer.notFound === true) continue;
      found = true;
      if (answer.code === 0) return { found, ipv4: tailnetIpv4Of(answer.stdout) };
    } catch {
      // No Tailscale here.
    }
  }
  return { found, ipv4: null };
}
