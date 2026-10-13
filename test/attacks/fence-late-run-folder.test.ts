/**
 * Attack: read another run's private launch folder (`so-tools-*`: its tool config and broker token; `so-codex-*`: a
 * Codex build's own home) that was made after this build's fence was fixed, so no launch-time listing could name it.
 * Guard: Seatbelt denies the whole namespace by pattern, giving back only this launch's own folder; Codex denies the
 * prefixes by glob (`so-tools-*`, `so-tools-*` + `/**`).
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { agentFence, codexFenceArgv, fenceGrants, macosFenced, runFolders, RUN_FOLDER_PREFIXES } from "../../src/agent-fence.js";
import { spawnSync } from "node:child_process";
import { codexSandbox, expectNoMarker, lines, marker, needs, q, seatbelt, underCodex, useScratch, write } from "./harness.js";

describe("attack: reading another run's so-tools-*/so-codex-* folder created after launch", () => {
  const scratch = useScratch("runfolder");
  const setup = () => {
    const dir = scratch();
    const worktree = join(dir, "app");
    const root = join(dir, "T");
    const own = join(root, "so-tools-mine");
    mkdirSync(worktree, { recursive: true });
    write(join(own, "mcp.json"), "own-tools");
    const folders = runFolders(own, root);
    const fence = agentFence({ databaseFile: null, worktree, home: join(dir, "home"), runFolders: folders });
    const grants = { ...fenceGrants({ databaseFile: null, worktree }), runFolders: folders };
    return { dir, worktree, root, own, folders, fence, grants };
  };
  /** Another run's folders, made after the policy was built. */
  const later = (root: string, secret: string) => RUN_FOLDER_PREFIXES.map(prefix => write(join(root, `${prefix}later`, "secret.json"), JSON.stringify({ token: secret })));

  test("policy: Codex denies each prefix and everything below it by name, so a later folder needs no listing", () => {
    const { root, fence, grants } = setup();
    const before = codexFenceArgv(fence, false, grants);
    later(root, marker("policy"));
    expect(codexFenceArgv(fence, false, grants)).toEqual(before);
    const table = before.find(arg => arg.startsWith("permissions.standing-orders.filesystem="))!;
    for (const prefix of RUN_FOLDER_PREFIXES) {
      expect(table).toContain(`${q(join(root, `${prefix}*`))}="deny"`);
      expect(table).toContain(`${q(join(root, `${prefix}*`, "**"))}="deny"`);
    }
  });

  test("native Seatbelt: a later folder of either prefix is unreadable; this launch's own folder and the temp folder still work", ctx => {
    needs(ctx, seatbelt());
    const { worktree, root, own, fence, grants } = setup();
    const secret = marker("late-seatbelt");
    // The spawn is fixed first (as a launch fixes it), the other run's folders made after.
    const { file, args } = macosFenced("/bin/sh", ["-c", [
      ...RUN_FOLDER_PREFIXES.map(prefix => `cat ${q(join(root, `${prefix}later`, "secret.json"))} 2>/dev/null || echo ${prefix}denied`),
      `ls ${q(root)} >/dev/null && echo temp-listed`,
      `cat ${q(join(own, "mcp.json"))} && echo x > ${q(join(own, "scratch"))} && echo own-written`,
      `mkdir ${q(join(root, "plain"))} && echo temp-written`,
    ].join("\n")], fence, grants);
    later(root, secret);
    const result = spawnSync(file, args, { cwd: worktree, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: undefined } });
    expectNoMarker(result, secret);
    expect(lines(result), result.stderr).toEqual(["so-tools-denied", "so-codex-denied", "temp-listed", "own-tools", "own-written", "temp-written"]);
    expect(readFileSync(join(own, "scratch"), "utf8")).toBe("x\n");
  });

  test("native Codex: a later folder of either prefix is unreadable; the workspace still works", ctx => {
    needs(ctx, codexSandbox());
    const { dir, worktree, root, fence, grants } = setup();
    const secret = marker("late-codex");
    later(root, secret);
    for (const fullAccess of [false, true]) {
      const result = underCodex([
        ...RUN_FOLDER_PREFIXES.map(prefix => `cat ${q(join(root, `${prefix}later`, "secret.json"))} 2>/dev/null || echo ${prefix}denied`),
        "echo mine > mine.txt && cat mine.txt",
      ].join("\n"), fence, fullAccess, grants, { cwd: worktree, codexHome: join(dir, "codex-home") });
      expectNoMarker(result, secret);
      expect(lines(result), result.stderr).toEqual(["so-tools-denied", "so-codex-denied", "mine"]);
    }
  });
});
