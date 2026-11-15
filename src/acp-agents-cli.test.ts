/**
 * `toolroll agents check|revoke|billing` change what a runner admits and how it bills, for every project it serves:
 * only an installation operator may, and a project's own approver is refused in words, changing nothing.
 */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
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

test("`toolroll agents` says what is on this computer and who the first task goes to, never what a status command printed", async () => {
  store.close();
  // Stand-in agent CLIs on a PATH folder this test owns, ahead of the approved tools (no real agent CLI is on a test
  // worker's PATH): Claude Code (its own status prints a token; nothing of it may reach the output) and OpenCode, signed
  // in by its login file. Claude Code's status is read through the command's own check seam, so a loaded runner's slow
  // process start can't make it "unknown" (agent-detect.test.ts runs the real status commands, deadline and all).
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const token = "sk-ant-oat01-NEVER-PRINT-THIS-TOKEN";
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho '{"loggedIn":true,"authMethod":"claude.ai","accessToken":"${token}"}'\n`);
  writeFileSync(join(bin, "opencode"), "#!/bin/sh\nexit 0\n");
  for (const name of ["claude", "opencode"]) chmodSync(join(bin, name), 0o755);
  const { createConnectionChecker } = await import("./provider-connection.js");
  const { run: exec } = await import("./exec.js");
  const real = createConnectionChecker({ probe: (file, args, options) => exec(join(bin, file), args, { ...options, timeoutMs: 30_000 }) });
  const check = async (provider: Parameters<typeof real>[0]) => provider === "claude" ? real(provider) : { state: "not-installed" as const, mode: "subscription" as const, checkedAt: NOW.toISOString() };
  mkdirSync(join(process.env["HOME"]!, ".local", "share", "opencode"), { recursive: true });
  writeFileSync(join(process.env["HOME"]!, ".local", "share", "opencode", "auth.json"), "{}");
  const path = process.env["PATH"];
  process.env["PATH"] = `${bin}${delimiter}${path ?? ""}`;
  try {
    const run = async (argv: string[]) => { const lines: string[] = []; const code = await runOperate("agents", argv, line => { lines.push(line); }, { databaseFile: file, easySeams: { check } }); return { code, out: lines.join("\n") }; };
    const shown = await run([]);
    expect(shown.code, shown.out).toBe(0);
    expect(shown.out).toContain("Agents on this computer");
    expect(shown.out).toMatch(/Claude Code\s+signed in \(Claude account\)/);
    expect(shown.out).toMatch(/Codex\s+not installed/);
    expect(shown.out).toMatch(/OpenCode\s+signed in \(login file\)/);
    // Not a laptop install, nothing chosen: builds go to the built-in default, Claude Code, which is signed in here.
    expect(shown.out).toContain("Your first task goes to Claude Code.");
    const json = await run(["--json"]);
    expect(JSON.parse(json.out)).toMatchObject({ ok: true, command: "agents", detected: { firstTask: { id: "claude", name: "Claude Code" }, lines: ["Your first task goes to Claude Code."] } });
    for (const out of [shown.out, json.out]) expect(out).not.toContain(token);
  } finally {
    process.env["PATH"] = path;
  }
});
