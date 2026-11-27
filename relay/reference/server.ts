/**
 * The self-hosted reference relay's entry point (relay/reference/Dockerfile bundles this file). The relay itself is
 * src/companion/relay-server.ts; this reads its settings from the environment and logs one JSON line per refusal
 * and close (never tokens, keys or full ids).
 *
 *   RELAY_PUBLIC_HOST  required: the host phones and Macs use (e.g. relay.example.com) — token audience and the
 *                      registration signature's host. Behind a TLS proxy this is the proxy's public host.
 *   HOST, PORT         listen address (default 0.0.0.0:8787)
 *   TRUST_PROXY=1      take the client address from X-Forwarded-For (only behind a proxy you run)
 *   CHALLENGE_SECRET, CHALLENGE_SECRET_PREVIOUS   optional stable challenge keys (random per process otherwise)
 *   MAX_ROOMS          machines held at once (default 1000)
 *   BUILD_ID           shown by /v1/health
 */
import { startReferenceRelay } from "../../src/companion/relay-server.js";

const env = process.env;
const publicHost = (env["RELAY_PUBLIC_HOST"] ?? "").trim();
if (publicHost.length === 0) {
  console.error("RELAY_PUBLIC_HOST is required: the public host phones and Macs reach this relay on (e.g. relay.example.com).");
  process.exit(1);
}
const optional = (name: string): string | undefined => (env[name] ?? "").length > 0 ? env[name] : undefined;
const maxRooms = Number(env["MAX_ROOMS"] ?? "");

const relay = await startReferenceRelay({
  host: env["HOST"] || "0.0.0.0",
  port: Number(env["PORT"] || 8787),
  publicHost,
  trustProxy: env["TRUST_PROXY"] === "1",
  build: env["BUILD_ID"] || "self-hosted",
  ...(optional("CHALLENGE_SECRET") !== undefined ? { challengeSecret: optional("CHALLENGE_SECRET")! } : {}),
  ...(optional("CHALLENGE_SECRET_PREVIOUS") !== undefined ? { previousChallengeSecret: optional("CHALLENGE_SECRET_PREVIOUS")! } : {}),
  ...(Number.isSafeInteger(maxRooms) && maxRooms > 0 ? { maxRooms } : {}),
  log: entry => console.log(JSON.stringify(entry)),
});
console.log(JSON.stringify({ event: "listening", url: relay.url, publicHost: relay.publicHost }));

const stop = (): void => { void relay.close().then(() => process.exit(0)); };
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
