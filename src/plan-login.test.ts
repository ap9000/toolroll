/** Claude's live sign-in, read strictly: only a first-party claude.ai login with a named plan is a plan. A fake `claude`
 * prints each shape; the real CLI is never run. */
import { afterEach, expect, test } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeLoginBilling, codexLoginBilling, PLAN_LOGIN_PROVABLE } from "./plan-login.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const fake = (stdout: string, code = 0, name = "claude", argv = "auth status --json"): string => {
  const dir = mkdtempSync(join(tmpdir(), "toolroll-plan-login-"));
  dirs.push(dir);
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\n[ "$*" = "${argv}" ] || exit 9\ncat <<'JSON'\n${stdout}\nJSON\nexit ${code}\n`);
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

test.each([
  ["a ChatGPT plan, the line Codex prints", "Logged in using ChatGPT", "subscription"],
  ["an API key", "Logged in using an API key - sk-not-real", "api-key"],
  ["both words on one line", "Logged in using ChatGPT (API key fallback)", "api-key"],
  ["the plan line beside a key line", "Logged in using ChatGPT\nLogged in using an API key - sk-not-real", "api-key"],
  ["the words inside another line", "note: Logged in using ChatGPT", null],
  ["more after the plan words", "Logged in using ChatGPT, but the token expired", null],
  ["signed out", "Not logged in", null],
] as const)("Codex: %s", async (_name, stdout, expected) => {
  expect(await codexLoginBilling(fake(stdout, 0, "codex", "login status"), [])).toBe(expected);
});
