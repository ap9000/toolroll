/** Claude's live sign-in, read strictly: only a first-party claude.ai login with a named plan is a plan. A fake `claude`
 * prints each shape; the real CLI is never run. */
import { afterEach, expect, test } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeLoginBilling, PLAN_LOGIN_PROVABLE } from "./plan-login.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const fake = (stdout: string, code = 0): string => {
  const dir = mkdtempSync(join(tmpdir(), "toolroll-plan-login-"));
  dirs.push(dir);
  const file = join(dir, "claude");
  writeFileSync(file, `#!/bin/sh\n[ "$1 $2 $3" = "auth status --json" ] || exit 9\ncat <<'JSON'\n${stdout}\nJSON\nexit ${code}\n`);
  chmodSync(file, 0o755);
  return file;
};
const plan = { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" };

test.each([
  ["a claude.ai plan", JSON.stringify(plan), 0, "subscription"],
  ["a Console login", JSON.stringify({ ...plan, authMethod: "console", subscriptionType: null }), 0, "api-key"],
  ["a cloud provider", JSON.stringify({ ...plan, apiProvider: "bedrock" }), 0, "api-key"],
  ["no named plan", JSON.stringify({ ...plan, subscriptionType: null }), 0, "api-key"],
  ["a plan name that isn't one", JSON.stringify({ ...plan, subscriptionType: "max\nfree" }), 0, "api-key"],
  ["signed out", JSON.stringify({ ...plan, loggedIn: false }), 0, null],
  ["not JSON", "Logged in with claude.ai", 0, null],
  ["a list", "[]", 0, null],
  ["a failed command", JSON.stringify(plan), 1, null],
] as const)("%s", async (_name, stdout, code, expected) => {
  expect(await claudeLoginBilling(fake(stdout, code), [], { PATH: process.env["PATH"] })).toBe(expected);
});

test("only Claude and Codex have a live proof", () => {
  expect([...PLAN_LOGIN_PROVABLE].sort()).toEqual(["claude", "codex"]);
});
