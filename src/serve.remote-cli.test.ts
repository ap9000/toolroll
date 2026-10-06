/**
 * The remote CLI end to end (Phase 1): two people, one central server, each with their own API token, running the
 * ordinary `toolroll` commands from their own profile. The server is real; the shared command boundary is operate.ts's
 * `runOperateAs` when it is exported, otherwise the thin stand-in in test/remote-seam.ts.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { mintApiToken } from "./api-tokens.js";
import { main } from "./cli.js";
import { contractRow, STEP_UP_MESSAGE, type RemoteMode } from "./remote-exec.js";
import { COMMAND_GUIDE } from "./surface.js";
import type { Principal, RunOperateAs } from "./cli-http.js";
import { stubRunOperateAs } from "../test/remote-seam.js";

let dir: string, store: Store, databaseFile: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "toolroll-remote-cli-")));
  databaseFile = join(dir, "orders.db");
  store = openStore(databaseFile);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

/** The contract's own remote marks once they are declared; until then, the marks this journey relies on. */
const declared = COMMAND_GUIDE.some(row => "remote" in row);
const FALLBACK: Record<string, RemoteMode> = { status: "yes", "task add": "yes", "task list": "yes", "task show": "yes", "task approve": "step-up" };
const modeOf = (argv: readonly string[]) => {
  const row = contractRow(argv);
  return row === null || declared ? row : { ...row, mode: FALLBACK[row.invocation] ?? "no" };
};
const stamps = (text: string) => text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<time>");

test("two people: attribution, project limits, refused approvals, revocation, and local/remote --json parity", async () => {
  const now = new Date();
  const repoA = join(dir, "repo-a"), repoB = join(dir, "repo-b");
  mkdirSync(repoA); mkdirSync(repoB);
  const alice = addApprover(store, "alice", now);
  if (!alice.ok) throw new Error("alice");
  const bob = addApprover(store, "bob", now, { name: "alice", token: alice.token });
  if (!bob.ok) throw new Error("bob");
  expect(store.setAccountProjects("bob", [repoA], "alice", now)).toEqual({ ok: true });
  const mint = (account: string, name: string, access: "read" | "act") => {
    const token = mintApiToken();
    store.createApiToken({ id: token.id, account, name, secretHash: token.hash, access, expiresAt: new Date(now.getTime() + 86_400_000).toISOString(), by: "alice" }, now);
    return token;
  };
  const bobToken = mint("bob", "bob-laptop", "act"), aliceToken = mint("alice", "alice-laptop", "act");

  const real = (await import("./operate.js") as { runOperateAs?: RunOperateAs }).runOperateAs;
  const seen: { argv: string[]; principal: Principal; source: string | undefined }[] = [];
  const seam = real ?? stubRunOperateAs(databaseFile);
  const cliRunner: RunOperateAs = async (argv, opts) => { seen.push({ argv, principal: opts.principal, source: opts.source }); return seam(argv, opts); };
  const server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), configDir: dir, cliRunner });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("listen");
  const base = `http://127.0.0.1:${address.port}`;

  /** One person's terminal: their own private profile, their own output. */
  const terminal = (who: string) => {
    const profileFile = join(dir, `home-${who}`, "remote", "profiles.json");
    return async (argv: string[], stdin = "") => {
      let stdout = "", stderr = "";
      const lines: string[] = [];
      const code = await main(argv, line => lines.push(line), {
        team: { profileFile, readStdin: async () => stdin, stderr: line => { stderr += `${line}\n`; } },
        remote: { profileFile, modeOf, stdout: chunk => { stdout += chunk; }, stderr: chunk => { stderr += chunk; } },
        operate: { databaseFile },
      });
      return { code, stdout: stdout + lines.map(line => `${line}\n`).join(""), stderr };
    };
  };
  const asBob = terminal("bob"), asAlice = terminal("alice");
  try {
    // Alice files work in both projects from the server's own computer.
    expect((await asAlice(["task", "add", "Alice's task in A", "--id", "alice-a", "--repo", repoA, "--local"])).code).toBe(0);
    expect((await asAlice(["task", "add", "Alice's task in B", "--id", "alice-b", "--repo", repoB, "--local"])).code).toBe(0);

    // 1–2. Bob connects with his act token and files a task remotely.
    const connected = await asBob(["connect", base, "--as", "bob", "--token-stdin"], bobToken.token);
    expect(connected.code, connected.stdout + connected.stderr).toBe(0);
    expect(connected.stdout).not.toContain(bobToken.secret);
    const filed = await asBob(["task", "add", "Bob's fix in A", "--id", "bob-a", "--repo", repoA, "--json"]);
    expect(filed.code, filed.stdout + filed.stderr).toBe(0);
    expect(JSON.parse(filed.stdout)).toMatchObject({ ok: true, command: "task add" });
    expect(store.getTask("bob-a")).not.toBeNull();
    expect(seen.at(-1)).toMatchObject({ source: "api", principal: { kind: "person", account: "bob", scope: "act", tokenId: bobToken.id, projects: [repoA], generation: store.accountOf("bob")!.generation } });
    if (real !== undefined) {
      // Alice's ledger names Bob, the API and his token.
      const entry = store.actionLedger({ repos: null, instance: true, limit: 50 }).find(one => one.taskId === "bob-a" && one.actor === "bob");
      expect(entry).toMatchObject({ actor: "bob", source: "api" });
      expect(JSON.stringify(entry)).toContain("bob-laptop");
    }

    // 3. Bob sees only repo A; his approval is refused with the console/chat message, without reaching the server.
    if (real !== undefined) {
      // Status has no project filter of its own: the real seam scopes it to Bob's projects.
      const status = await asBob(["status", "--json"]);
      expect(status.code, status.stdout + status.stderr).toBe(0);
      expect(status.stdout).not.toContain(repoB);
      expect(status.stdout).not.toContain("alice-b");
    }
    const listed = await asBob(["task", "list", "--json"]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain("bob-a");
    expect(listed.stdout).not.toContain(repoB);
    expect(listed.stdout).not.toContain("alice-b");
    expect((await asBob(["task", "add", "Sneaky", "--repo", repoB])).code).toBe(3);
    expect(store.getTask("sneaky")).toBeNull();
    const asked = seen.length;
    const approve = await asBob(["task", "approve", "bob-a"]);
    expect(approve).toMatchObject({ code: 3, stderr: `${STEP_UP_MESSAGE}\n` });
    expect(seen).toHaveLength(asked);

    // Local and remote --json envelopes match byte for byte apart from timestamps (Alice sees everything).
    expect((await asAlice(["connect", base, "--as", "alice", "--token-stdin"], aliceToken.token)).code).toBe(0);
    for (const argv of [["status", "--json"], ["task", "show", "bob-a", "--json"], ["task", "list", "--json"]]) {
      const local = await asAlice([...argv, "--local"]);
      const remote = await asAlice(argv);
      expect(remote.code, argv.join(" ")).toBe(local.code);
      expect(stamps(remote.stdout), argv.join(" ")).toBe(stamps(local.stdout));
      expect(seen.at(-1)?.principal.account).toBe("alice");
    }

    // 4. Alice revokes Bob's token: his next call is a 401, and nothing runs.
    expect(store.revokeApiToken(bobToken.id, "alice", new Date())).toBe(true);
    const before = seen.length;
    const refused = await asBob(["status"]);
    expect(refused.code).toBe(3);
    expect(refused.stderr).toContain("not valid");
    expect(seen).toHaveLength(before);
    const raw = await fetch(`${base}/api/cli`, { method: "POST", headers: { authorization: `Bearer ${bobToken.token}`, "content-type": "application/json" }, body: JSON.stringify({ argv: ["status"] }) });
    expect(raw.status).toBe(401);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
