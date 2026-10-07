/** OAuth integration with remote-tokens' command handler; all accounts and projects are synthetic. */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { mintApiToken, MCP_ROTATION_REFUSAL } from "./api-tokens.js";
import { runTokensCommand } from "./tokens-cli.js";

const now = new Date("2026-10-07T00:00:00.000Z");
let dir: string, store: Store, password: string, output: string[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oauth-token-cli-"));
  store = openStore(join(dir, "state.db"));
  const account = addApprover(store, "sam", now);
  if (!account.ok) throw new Error("fixture account");
  password = account.token;
  output = [];
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

async function command(action: string, id: string) {
  return runTokensCommand([action, id], new Map([["password-stdin", true]]), {
    store, write: line => output.push(line), json: true, clock: () => now, caller: "local", rememberedName: "sam",
    interactive: () => false, ask: async () => { throw new Error("unexpected prompt"); }, askHidden: async () => { throw new Error("unexpected prompt"); }, readStdin: async () => password,
  });
}

test("tokens rotate refuses MCP-managed rows, gives reconnect guidance, and revoke still works", async () => {
  const client = store.registerOAuthClient({ id: "example-client", name: "Example Agent", redirectUris: ["https://agent.example/cb"], source: "example-source-hash" }, now, 20, 10)!;
  const minted = mintApiToken();
  store.createOAuthGrant("code-hash", { id: minted.id, account: "sam", name: "MCP: Example Agent", access: "read", secretHash: minted.hash, expiresAt: "2026-11-06T00:00:00.000Z" },
    { client: client.id, account: "sam", generation: store.accountOf("sam")!.generation, projects: ["/repo/shop"], resource: "https://toolroll.example/mcp", accessExpiresAt: "2026-10-07T01:00:00.000Z", refreshHash: "synthetic-refresh-hash" }, now);
  const before = store.apiTokenSecret(minted.id);
  expect(before?.row).toMatchObject({ purpose: "mcp", projects: ["/repo/shop"] });
  expect(await command("rotate", minted.id)).toBe(3);
  expect(JSON.parse(output.at(-1)!)).toMatchObject({ ok: false, reason: "mcp-managed", message: MCP_ROTATION_REFUSAL });
  const replacement = mintApiToken();
  expect(store.rotateApiToken(minted.id, { id: replacement.id, secretHash: replacement.hash }, "sam", now, 0)).toEqual({ ok: false, reason: "mcp-managed" });
  expect(store.apiTokenSecret(minted.id)).toEqual(before);
  expect(store.apiTokens("sam")).toHaveLength(1);
  expect(await command("revoke", minted.id)).toBe(0);
  expect(store.apiTokenSecret(minted.id)?.row.revokedAt).toBe(now.toISOString());
  const visible = JSON.stringify([output, store.apiTokens("sam"), store.actionLedger({ repos: null, limit: 100 })]);
  for (const secret of [minted.token, minted.secret, minted.hash, replacement.token, "synthetic-refresh-hash", password]) expect(visible).not.toContain(secret);
});

test("tokens rotate still replaces ordinary tokens on the same terms", async () => {
  const minted = mintApiToken();
  store.createApiToken({ id: minted.id, account: "sam", name: "Terminal", access: "act", secretHash: minted.hash, expiresAt: "2026-11-06T00:00:00.000Z", projects: ["/repo/shop"], by: "sam" }, now);
  expect(await command("rotate", minted.id)).toBe(0);
  const result = JSON.parse(output.at(-1)!);
  expect(result).toMatchObject({ ok: true, projects: ["/repo/shop"], expiresAt: "2026-11-06T00:00:00.000Z", access: "act" });
  expect(store.apiTokenSecret(result.id)?.row.purpose).toBe("api");
  expect(store.apiTokenSecret(minted.id)?.row.replacedBy).toBe(result.id);
});
