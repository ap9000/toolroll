/**
 * The discovery socket carries no authority (docs/plans/agents-cockpit.md B1, r3-N19): a build running inside the
 * native sandbox (the agent fence), contacting the console's socket directly — bypassing the CLI's "under an agent"
 * check — gets at most the `hello` facts. It cannot read the database or the instance secret, every other verb is
 * refused, and nothing in the database changes. With the database in a custom directory too.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { agentFence, macosFenceAvailable, macosFenced } from "./agent-fence.js";
import { claimInstance, instanceRunDir, openInstanceSocket, readInstance } from "./console-instance.js";
import { openStore, type Store } from "./store.js";

const BUILD = "9.9.9-test";
/** What a fenced build tries: read the database, then ask the socket for hello, a secret, and a sign-in. */
const PROBE = `
const fs = require("node:fs"), net = require("node:net");
const [db, socket] = process.argv.slice(1);
const run = require("node:path").dirname(socket);
const out = { db: "denied", answers: [], run: [] };
try { fs.readFileSync(db); out.db = "read"; } catch {}
// The run folder's namespace: no new entry, no rename, no removal of the listening console's socket.
for (const [label, act] of [["create", () => fs.writeFileSync(run + "/planted.sock", "")], ["rename", () => fs.renameSync(socket, socket + ".moved")], ["remove", () => fs.unlinkSync(socket)]]) {
  try { act(); out.run.push(label + ":done"); } catch { out.run.push(label + ":denied"); }
}
const ask = request => new Promise(resolve => {
  const c = net.createConnection(socket);
  let buffer = "";
  c.setEncoding("utf8");
  c.on("error", error => resolve({ error: error.code ?? "error" }));
  c.on("connect", () => c.write(JSON.stringify(request) + "\\n"));
  c.on("data", chunk => { buffer += chunk; });
  c.on("close", () => { try { resolve(JSON.parse(buffer)); } catch { resolve({ raw: buffer }); } });
});
(async () => {
  for (const request of [{ verb: "hello", challenge: "5".repeat(64) }, { verb: "secret" }, { verb: "sign-in", challenge: "5".repeat(64) }, { verb: "admit", repo: "/x" }]) out.answers.push(await ask(request));
  process.stdout.write(JSON.stringify(out));
})();
`;

describe.skipIf(!macosFenceAvailable())("a fenced build and the console's socket", () => {
  let dir: string, store: Store | null = null, close: (() => void) | null = null;
  beforeEach(() => { dir = realpathSync(mkdtempSync(join("/tmp", "so-cif-"))); });
  afterEach(() => { close?.(); close = null; store?.close(); store = null; rmSync(dir, { recursive: true, force: true }); });

  test.each([["Toolroll's own state folder", "toolroll/orders.db"], ["a folder shared with other things", "s/orders.db"], ["a custom database directory", "custom/db/state.sqlite"]])("in %s: only hello's public facts, no secret, nothing changed", async (_label, relative) => {
    const databaseFile = join(dir, relative);
    const state = join(databaseFile, "..");
    mkdirSync(state, { recursive: true, mode: 0o700 });
    store = openStore(databaseFile);
    let secret = "";
    const opened = await openInstanceSocket(databaseFile, { pid: process.pid, build: BUILD, database: databaseFile, port: 4180 }, () => secret);
    if (!opened.ok) throw new Error(opened.problem);
    const socketPath = join(instanceRunDir(databaseFile), opened.name);
    secret = (await claimInstance(store, databaseFile, { pid: process.pid, port: 4180, build: BUILD, socket: opened.name }, new Date()))!;
    close = opened.close;
    const before = readInstance(store);
    const worktree = join(dir, "wt"), home = join(dir, "home");
    mkdirSync(worktree); mkdirSync(home);
    const fence = agentFence({ databaseFile, worktree, home });
    const { file, args } = macosFenced(process.execPath, ["-e", PROBE, databaseFile, socketPath], fence);
    // The socket answers on this process's event loop, so the fenced child runs asynchronously beside it.
    const result = await new Promise<{ stdout: string; status: number | null }>(resolve => {
      const child = spawn(file, args, { cwd: worktree, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      child.stdout.on("data", chunk => { stdout += String(chunk); });
      child.on("close", status => resolve({ stdout, status }));
    });
    const seen = JSON.parse(result.stdout) as { db: string; answers: Record<string, unknown>[]; run: string[] };
    expect(seen.run).toEqual(["create:denied", "rename:denied", "remove:denied"]);
    expect(lstatSync(socketPath).isSocket()).toBe(true);
    // The database (and so the instance secret) is out of its reach.
    expect(seen.db).toBe("denied");
    expect(result.stdout).not.toContain(secret);
    const [hello, ...others] = seen.answers;
    // It reaches the socket, and hello gives it only the public facts; every other verb is refused.
    expect(Object.keys(hello ?? {}).sort()).toEqual(["build", "database", "pid", "port", "proof"]);
    expect(others).toEqual([{ error: "refused" }, { error: "refused" }, { error: "refused" }]);
    // Nothing in the database changed.
    expect(readInstance(store)).toEqual(before);
  });
});
