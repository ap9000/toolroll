/**
 * Teardown's config scan: which settings in the repository's own config (local or worktree scope, includes off) make
 * teardown refuse to run git there, and that system or global settings never do.
 */
import { describe, expect, test } from "vitest";
import { commandSetting, refusal, REFUSED_CODE } from "./teardown-git.js";

const listing = (...entries: [scope: string, key: string, value: string][]) => entries.map(([scope, key, value]) => `${scope}\0${key}\n${value}\0`).join("");

describe("command-running settings refuse teardown", () => {
  test.each([
    ["core.fsmonitor", "/tmp/planted"], ["core.sshCommand", "touch /tmp/x"], ["core.gitProxy", "proxy"], ["core.askPass", "ask"],
    ["credential.helper", "store"], ["credential.https://example.com.helper", "x"], ["filter.lfs.smudge", "git-lfs smudge %f"],
    ["filter.x.process", "x"], ["diff.external", "x"], ["diff.x.textconv", "x"], ["merge.x.driver", "x"], ["core.pager", "less"],
    ["include.path", "/tmp/more"], ["includeIf.gitdir:/x/.path", "/tmp/more"], ["remote.origin.uploadpack", "x"], ["uploadpack.packObjectsHook", "x"],
  ])("%s in local config", (key, value) => {
    expect(commandSetting(listing(["local", "core.bare", "false"], ["local", key, value]))).toBe(key.toLowerCase());
    expect(commandSetting(listing(["worktree", key, value]))).toBe(key.toLowerCase());
  });

  test("ordinary settings, a boolean fsmonitor, a hooks path (overridden on every command) and other scopes don't", () => {
    expect(commandSetting(listing(["local", "core.bare", "false"], ["local", "core.hooksPath", ".husky"], ["local", "remote.origin.url", "git@x:y"],
      ["local", "core.fsmonitor", "true"], ["worktree", "core.fsmonitor", "false"], ["local", "filter.lfs.required", "true"],
      ["system", "credential.helper", "osxkeychain"], ["global", "core.pager", "less"], ["unknown", "credential.helper", "osxkeychain"], ["command", "core.fsmonitor", "/x"]))).toBeNull();
    expect(commandSetting("")).toBeNull();
  });

  test("a refusal reads as one, and an ordinary git failure doesn't", () => {
    expect(refusal({ code: REFUSED_CODE, stdout: "", stderr: "Toolroll won't run git here: it sets x\n", timedOut: false, notFound: false })).toBe("it sets x");
    expect(refusal({ code: REFUSED_CODE, stdout: "", stderr: "fatal: not a git repository\n", timedOut: false, notFound: false })).toBeNull();
  });
});
