/**
 * Attack: rewrite the plane's frozen view of a repository (Codex review of e48e9d8d). The plane's git on an
 * agent-written checkout runs against a private copy of the repository's config and info (teardown-git.ts gitView);
 * made in the system temp folder, a build that writes anywhere and outlived its turn could find it and plant a filter
 * in it between the inspection and the run. Guard: views are made under `~/.toolroll/git-views` (git-views.ts), which
 * every fence denies by name, made before any build launches; a view made after the fence was fixed is denied too.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { agentFence, codexFenceArgv, NO_GRANTS } from "../../src/agent-fence.js";
import { runnerProcessFile } from "../../src/runner-process.js";
import { gitViewsRoot } from "../../src/git-views.js";
import { codexSandbox, lines, needs, osFence, q, underCodex, underSandbox, useScratch } from "./harness.js";

describe("attack: writing the plane's frozen git views from a build that writes anywhere", () => {
  const scratch = useScratch("gitviews");
  const setup = () => {
    const dir = scratch();
    const home = join(dir, "home");
    const worktree = join(dir, "app");
    mkdirSync(home, { recursive: true });
    mkdirSync(worktree, { recursive: true });
    const databaseFile = join(dir, "orders.db");
    const fence = agentFence({ databaseFile, worktree, home });
    // New private state appears after the build fence was fixed, in a shared database folder.
    const records = [runnerProcessFile(databaseFile, "worker"), join(dir, "backups", "copy.db")];
    for (const file of records) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, "plane-owned"); }
    // A view made after the fence was fixed, as the plane makes one while a build's process may still run.
    const view = join(gitViewsRoot(home), "write-later");
    mkdirSync(view, { recursive: true });
    writeFileSync(join(view, "config"), "[core]\n\tbare = false\n");
    return { dir, home, worktree, fence, view, records };
  };
  const script = (view: string, records: string[]) => [
    ...records.map((file, i) => `cat ${q(file)} > record-${i}.txt 2>/dev/null; echo forged > ${q(file)} 2>/dev/null; rm -rf ${q(dirname(file))} 2>/dev/null`),
    `printf '[filter "x"]\\n\\tclean = touch /tmp/ran\\n' >> ${q(join(view, "config"))} 2>/dev/null && echo config-written || echo config-denied`,
    `mkdir -p ${q(join(view, "info"))} 2>/dev/null; echo '* filter=x' > ${q(join(view, "info", "attributes"))} 2>/dev/null && echo attributes-written || echo attributes-denied`,
    `mkdir ${q(join(view, "..", "planted"))} 2>/dev/null && echo planted || echo plant-denied`,
    "echo mine > mine.txt && cat mine.txt",
  ].join("\n");

  test("policy: the views folder is made before any launch and fenced by name", () => {
    const { home, fence, records } = setup();
    for (const file of records) expect(fence).toContain(dirname(file));
    expect(fence).toContain(gitViewsRoot(home));
    expect(existsSync(gitViewsRoot(home))).toBe(true);
    const table = codexFenceArgv(fence, false, NO_GRANTS).find(arg => arg.startsWith("permissions.standing-orders.filesystem="))!;
    expect(table).toContain(q(gitViewsRoot(home)));
    for (const file of records) expect(table).toContain(q(dirname(file)));
  });

  test("native OS fence (writes anywhere): a view's config and info can't be written, nor a view planted", ctx => {
    needs(ctx, osFence());
    const { home, worktree, fence, view, records } = setup();
    const result = underSandbox(script(view, records), fence, NO_GRANTS, { cwd: worktree });
    // Seatbelt denies each write. Bubblewrap hides the denied folder behind an empty scratch one of the launch's own
    // (the view isn't even there to write); what the build writes into that scratch never reaches the plane's folder.
    const expected = process.platform === "linux" ? ["config-denied", "attributes-written", "planted", "mine"] : ["config-denied", "attributes-denied", "plant-denied", "mine"];
    expect(lines(result), result.stderr).toEqual(expected);
    for (const [i, file] of records.entries()) {
      expect(readFileSync(file, "utf8")).toBe("plane-owned");
      expect(readFileSync(join(worktree, `record-${i}.txt`), "utf8")).toBe("");
    }
    expect(readFileSync(join(view, "config"), "utf8")).not.toContain("filter");
    expect(existsSync(join(view, "info"))).toBe(false);
    expect(readdirSync(gitViewsRoot(home)).sort()).toEqual(["write-later"]);
  });

  test("native Codex (full access and not): the same", ctx => {
    needs(ctx, codexSandbox());
    const { dir, worktree, fence, view, records } = setup();
    for (const fullAccess of [false, true]) {
      const result = underCodex(script(view, records), fence, fullAccess, NO_GRANTS, { cwd: worktree, codexHome: join(dir, "codex-home") });
      expect(lines(result), result.stderr).toEqual(["config-denied", "attributes-denied", "plant-denied", "mine"]);
    }
    for (const [i, file] of records.entries()) {
      expect(readFileSync(file, "utf8")).toBe("plane-owned");
      expect(readFileSync(join(worktree, `record-${i}.txt`), "utf8")).toBe("");
    }
    expect(readFileSync(join(view, "config"), "utf8")).not.toContain("filter");
  });
});
