/**
 * Attack: rewrite the checkout's `node_modules/.toolroll-shared` note (build-writable) to name another project's
 * shared install, and link `node_modules/pkg` into it, so the fence grants that project's dependencies. Guard:
 * fenceGrants treats the note as a hint only: a copy is granted only when it is a ready, unretired copy the plane made
 * for this run's recorded project under the setup it stamped on this checkout.
 */
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { codexFenceArgv, fenceGrants } from "../../src/agent-fence.js";
import { expectNoMarker, lines, LINKED_KEY, marker, needs, OTHER_KEY, plane, q, seatbelt, underSandbox, useScratch, write } from "./harness.js";

describe("attack: a node_modules/.toolroll-shared note choosing another project's deps", () => {
  const scratch = useScratch("depsnote");
  const setup = () => {
    const secret = marker("depsnote");
    return { secret, at: plane(scratch(), secret) };
  };
  const repoint = (at: ReturnType<typeof plane>, key: string) => {
    write(join(at.active, "node_modules", ".toolroll-shared"), `${at.shared(key)}\n`);
    rmSync(join(at.active, "node_modules", "pkg"));
    symlinkSync(join(at.shared(key), "pkg"), join(at.active, "node_modules", "pkg"), "dir");
  };

  test("policy: only the plane's copy for this project and setup is granted; a foreign, unknown or mis-stamped copy is not", () => {
    const { at } = setup();
    const readable = (linked: { repo: string; setupDigest: string | null } | null) =>
      fenceGrants({ databaseFile: at.databaseFile, worktree: at.active, linked }).readable;
    // Legitimate: this project's own shared install, as linked.
    expect(readable(at.linked)).toEqual([at.shared(LINKED_KEY)]);
    expect(readable(null)).toEqual([]);
    expect(readable({ ...at.linked, setupDigest: "setup-2" })).toEqual([]);
    repoint(at, OTHER_KEY);
    expect(readable(at.linked)).toEqual([]);
    // Claiming the other project's repository doesn't help: the plane's record for this run names its own.
    expect(at.launch("codex").grants.readable).toEqual([]);
    mkdirSync(join(at.state, "deps", "not-a-key", "node_modules"), { recursive: true });
    write(join(at.active, "node_modules", ".toolroll-shared"), `${join(at.state, "deps", "not-a-key", "node_modules")}\n`);
    expect(readable(at.linked)).toEqual([]);
    write(join(at.active, "node_modules", ".toolroll-shared"), `${join(at.state, "deps", OTHER_KEY, "..", LINKED_KEY, "node_modules", "..", "..", OTHER_KEY, "node_modules")}\n`);
    expect(readable(at.linked)).toEqual([]);
    const { fence, grants } = at.launch("codex");
    const table = codexFenceArgv(fence, false, grants).find(arg => arg.startsWith("permissions.standing-orders.filesystem="))!;
    expect(table).not.toContain(`${q(at.shared(OTHER_KEY))}="read"`);
  });

  test("native Seatbelt: the other project's install can't be loaded; this project's linked install can", ctx => {
    needs(ctx, seatbelt());
    const { secret, at } = setup();
    const load = `${q(process.execPath)} -e 'console.log("pkg-" + require("pkg").value)' 2>/dev/null || echo pkg-refused`;
    const { fence, grants } = at.launch("claude");
    const own = underSandbox(load, fence, grants, { cwd: at.active });
    expect(lines(own), own.stderr).toEqual(["pkg-linked"]);
    repoint(at, OTHER_KEY);
    const attacked = at.launch("claude");
    const foreign = underSandbox(`${load}\ncat ${q(join(at.shared(OTHER_KEY), "pkg", "index.js"))} 2>/dev/null || echo source-denied`, attacked.fence, attacked.grants, { cwd: at.active });
    expectNoMarker(foreign, secret);
    expect(lines(foreign), foreign.stderr).toEqual(["pkg-refused", "source-denied"]);
  });
});
