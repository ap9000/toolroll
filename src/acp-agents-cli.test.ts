/**
 * `toolroll agents check|revoke|billing` change what a runner admits and how it bills, for every project it serves:
 * only an installation operator may, and a project's own approver is refused in words, changing nothing.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { runOperate } from "./operate.js";
import { register } from "./runner.js";
import { addApprover } from "./scope.js";
import { openStore, type Store } from "./store.js";

const NOW = new Date("2026-10-19T12:00:00.000Z");
let dir: string, file: string, store: Store;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-agents-cli-")));
  file = join(dir, "orders.db");
  store = openStore(file);
  register(store, { name: "mac", host: "test", capacity: 2, repos: ["/repo/a"], now: NOW, newToken: () => "tok" });
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test("only an installation operator checks, revokes or sets billing for a runner's agents", async () => {
  const alex = addApprover(store, "alex", NOW);
  if (!alex.ok) throw new Error("alex");
  const sam = addApprover(store, "sam", NOW, { name: "alex", token: alex.token });
  if (!sam.ok) throw new Error("sam");
  // Sam approves one project's work, not the installation's.
  expect(store.setAccountProjects("sam", ["/repo/a"], "alex", NOW)).toEqual({ ok: true });
  expect(store.isInstanceOperator("alex")).toBe(true);
  expect(store.isInstanceOperator("sam")).toBe(false);
  store.close();
  const run = async (argv: string[]) => { const lines: string[] = []; const code = await runOperate("agents", argv, line => { lines.push(line); }, { databaseFile: file }); return { code, out: lines.join("\n") }; };
  for (const argv of [["billing", "opencode", "opencode/big-pickle", "plan"], ["check", "opencode", "--model", "opencode/big-pickle"], ["revoke", "opencode"]]) {
    const refused = await run([...argv, "--runner", "mac", "--as", "sam", "--token", sam.token, "--json"]);
    expect(refused.code, refused.out).toBe(3);
    expect(JSON.parse(refused.out)).toMatchObject({ ok: false, reason: "forbidden" });
  }
  store = openStore(file);
  expect(store.acpBillingFor("opencode", "mac", "opencode/big-pickle")).toMatchObject({ kind: "metered", revision: 0 });
  expect(store.acpChecksFor("opencode")).toEqual([]);
  store.close();
  const allowed = await run(["billing", "opencode", "opencode/big-pickle", "plan", "--runner", "mac", "--as", "alex", "--token", alex.token, "--json"]);
  expect(allowed.code, allowed.out).toBe(0);
  store = openStore(file);
  expect(store.acpBillingFor("opencode", "mac", "opencode/big-pickle")).toMatchObject({ kind: "plan" });
  store.close();
});
