/**
 * Attack: rename a folder above a fenced path (or the temp folder) and read the secret under its new name. Seatbelt
 * rules follow names, so `mv ~/.config ~/.c` would bring `~/.config/standing-orders/up-login.txt` back under a name no
 * rule mentions. Guard: Anthropic's sandbox-runtime denies moving or removing every folder above a denied path (its
 * move-blocking rules), while their contents stay writable.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { agentFence, fenceGrants, runFolders } from "../../src/agent-fence.js";
import { expectNoMarker, lines, marker, needs, osFence, q, underSandbox, useScratch, write } from "./harness.js";

describe("attack: renaming a parent of a fenced path or of the temp folder", () => {
  const scratch = useScratch("rename");
  const setup = () => {
    const dir = scratch();
    const secret = marker("rename");
    const home = join(dir, "home");
    const state = join(home, ".config", "standing-orders");
    const worktree = join(dir, "projects", "app");
    // A stand-in system temp folder: this launch's own tool folder and another run's, holding a broker token.
    const root = join(dir, "T");
    const own = join(root, "so-tools-mine");
    for (const path of [worktree, own]) mkdirSync(path, { recursive: true });
    write(join(state, "up-login.txt"), secret);
    write(join(state, "orders.db"), "db");
    write(join(root, "so-tools-other", "mcp.json"), JSON.stringify({ token: secret }));
    const folders = runFolders(own, root);
    const databaseFile = join(state, "orders.db");
    const fence = agentFence({ databaseFile, worktree, home, runFolders: folders });
    const grants = { ...fenceGrants({ databaseFile, worktree }), runFolders: folders };
    return { dir, secret, home, state, worktree, root, own, fence, grants };
  };

  test("native: mv of a parent or of the temp folder is refused and nothing leaks; writing inside them still works", ctx => {
    needs(ctx, osFence());
    const { secret, home, state, worktree, root, own, fence, grants } = setup();
    const attack = underSandbox([
      `mv ${q(root)} ${q(root + ".x")} && echo moved-temp; cat ${q(root + ".x/so-tools-other/mcp.json")} ${q(root + "/so-tools-other/mcp.json")} 2>/dev/null`,
      `mv ${q(home + "/.config")} ${q(home + "/.c")} && echo moved-config; cat ${q(home + "/.c/standing-orders/up-login.txt")} ${q(state + "/up-login.txt")} 2>/dev/null`,
      `rm -rf ${q(home + "/.config")} 2>/dev/null; true`,
    ].join("\n"), fence, grants, { cwd: worktree });
    expectNoMarker(attack, secret);
    expect(attack.stdout).not.toContain("moved-");
    expect(existsSync(join(root, "so-tools-other", "mcp.json")) && existsSync(join(state, "up-login.txt"))).toBe(true);
    const works = underSandbox([
      `echo a > ${q(own + "/config.json")} && mv ${q(own + "/config.json")} ${q(own + "/mcp.json")} && echo own-ok`,
      `mkdir ${q(root + "/scratch")} && echo b > ${q(root + "/scratch/f")} && rm -r ${q(root + "/scratch")} && echo temp-ok`,
      `echo c > ${q(home + "/.toolrc.tmp")} && mv ${q(home + "/.toolrc.tmp")} ${q(home + "/.toolrc")} && rm ${q(home + "/.toolrc")} && echo home-ok`,
    ].join("\n"), fence, grants, { cwd: worktree });
    expect(lines(works), works.stderr).toEqual(["own-ok", "temp-ok", "home-ok"]);
  });
});
