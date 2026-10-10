/**
 * D7: one credential table, but each kind keeps its own doors. A person's API token signs in on the console, the
 * remote CLI, team and MCP; a lead token is only the lead's (the local CLI), never a bearer anywhere; a coordinator's
 * secret opens only the MCP gateway. One table never lends one kind another's authority.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { mintApiToken } from "./api-tokens.js";
import { mintCoordinator } from "./coordinator.js";
import type { RunOperateAs } from "./cli-http.js";

let dir: string, repo: string, store: Store, server: Server, base: string;
const runner: RunOperateAs = async (_argv, opts) => { opts.write("{}"); return 0; };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "so-credential-kinds-"));
  repo = realpathSync(mkdtempSync(join(tmpdir(), "so-credential-kinds-repo-")));
  store = openStore(join(dir, "orders.db"));
  if (!addApprover(store, "alex", new Date()).ok) throw new Error("bootstrap");
  server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repos: [repo], configDir: dir, cliRunner: runner });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("listen");
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  for (const one of [dir, repo]) rmSync(one, { recursive: true, force: true });
});

test("each kind of credential opens only its own doors", async () => {
  const minted = mintApiToken();
  store.createApiToken({ id: minted.id, account: "alex", name: "laptop", secretHash: minted.hash, access: "act", expiresAt: new Date(Date.now() + 86_400_000).toISOString(), by: "alex" }, new Date());
  const lead = store.mintLeadCredential("alex", "alex", new Date()).token;
  const coordinator = mintCoordinator(store, { name: "planner-bot", repos: [repo], by: "alex", now: new Date() });
  if (!coordinator.ok) throw new Error("coordinator");
  const doors = async (secret: string) => {
    const authorization = `Bearer ${secret}`;
    const page = await fetch(`${base}/work`, { headers: { authorization }, redirect: "manual" });
    const cli = await fetch(`${base}/api/cli`, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify({ argv: ["status"] }) });
    const team = await fetch(`${base}/api/team`, { headers: { authorization } });
    const mcp = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    for (const one of [page, cli, team, mcp]) await one.arrayBuffer();
    return { console: page.status, cli: cli.status, team: team.status, mcp: mcp.status };
  };
  expect(await doors(minted.token)).toEqual({ console: 200, cli: 200, team: 200, mcp: 202 });
  // A lead token and a coordinator's secret never sign in as a person: the console sends them to sign in.
  expect(await doors(lead)).toEqual({ console: 303, cli: 401, team: 401, mcp: 401 });
  expect(await doors(coordinator.token)).toEqual({ console: 303, cli: 401, team: 401, mcp: 202 });
  // The lead's own door: the token still names its owner.
  expect(store.leadFor(lead)?.owner).toBe("alex");
  expect(store.presentedCredential(coordinator.token)).toEqual({ kind: "coordinator", id: coordinator.cid });
});
