/**
 * Attack: rewrite the checkout's `.git` pointer (`gitdir: ~/.ssh/x`, `gitdir: <state>/orders.db`) so the fence, which
 * gives a checkout its own Git data back, gives back the secret folder instead. Guard: trustedWorktreeBinding takes
 * the binding from the plane's recorded repository and Git's own registry, never the pointer, and refuses the launch
 * when the pointer disagrees; agentFence never drops a secret, state, database or home-configuration deny.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { agentFence, CheckoutBindingError, taskBoundary, trustedWorktreeBinding } from "../../src/agent-fence.js";
import { expectNoMarker, lines, marker, needs, ordinaryWork, plane, q, seatbelt, underSeatbelt, useScratch, write } from "./harness.js";

describe("attack: a rewritten .git pointer weakening the fence", () => {
  const scratch = useScratch("pointer");
  const setup = () => {
    const secret = marker("pointer");
    return { secret, at: plane(scratch(), secret) };
  };
  const hostile = (at: ReturnType<typeof plane>) => ({
    ssh: join(at.home, ".ssh", "x"),
    database: at.databaseFile,
    state: join(at.state, ".git", "worktrees", "x"),
    toolroll: join(at.home, ".toolroll", ".git", "worktrees", "x"),
  });

  test.each(["ssh", "database", "state", "toolroll"] as const)("policy: a %s pointer refuses the launch and drops no protected deny", target => {
    const { at } = setup();
    // Legitimate: the genuine pointer binds to the recorded repository and this checkout's own registry entry.
    const genuine = trustedWorktreeBinding(at.main, at.active, [at.pool]);
    expect(genuine).toEqual({ main: at.main, gitdir: join(at.main, ".git", "worktrees", "task-0123abcd") });
    write(join(at.active, ".git"), `gitdir: ${hostile(at)[target]}\n`);
    expect(() => trustedWorktreeBinding(at.main, at.active, [at.pool])).toThrow(CheckoutBindingError);
    // Even a binding that named the secret (a pointer trusted by mistake) can't lift a protected deny.
    for (const binding of [genuine, { main: at.main, gitdir: hostile(at)[target] }]) {
      const boundary = taskBoundary({ worktree: at.active, provider: "claude", home: at.home, binding });
      const fence = agentFence({ databaseFile: at.databaseFile, worktree: at.active, home: at.home, boundary, binding });
      expect(fence).toEqual(expect.arrayContaining([join(at.home, ".ssh"), join(at.home, ".toolroll"), at.databaseFile, join(at.state, "up-login.txt")]));
    }
  });

  test("policy: a relative pointer into the build's own folder, or an entry swapped to name back, is refused too", () => {
    const { at } = setup();
    // A copied registry entry inside the checkout that names the checkout back still isn't Git's registry.
    const fake = join(at.active, ".fake-gitdir");
    write(join(fake, "gitdir"), `${join(at.active, ".git")}\n`);
    write(join(fake, "commondir"), `${join(at.main, ".git")}\n`);
    write(join(at.active, ".git"), "gitdir: .fake-gitdir\n");
    expect(() => trustedWorktreeBinding(at.main, at.active, [at.pool])).toThrow(CheckoutBindingError);
  });

  test("native Seatbelt: with the pointer rewritten after launch, the secrets stay unreadable and the build's own Git still answers", ctx => {
    needs(ctx, seatbelt());
    const { secret, at } = setup();
    const { fence, grants } = at.launch("claude");
    const work = ordinaryWork(at);
    const before = underSeatbelt(work.script, fence, grants, { cwd: at.active });
    expect(lines(before), before.stderr).toEqual(work.expected);
    const attack = underSeatbelt([
      `printf 'gitdir: %s\\n' ${q(join(at.home, ".ssh", "x"))} > .git 2>/dev/null; echo rewritten`,
      `cat ${q(join(at.home, ".ssh", "id"))} 2>/dev/null || echo ssh-denied`,
      `cat ${q(at.databaseFile)} 2>/dev/null || echo database-denied`,
      `cat ${q(join(at.state, "up-login.txt"))} 2>/dev/null || echo login-denied`,
    ].join("\n"), fence, grants, { cwd: at.active });
    expectNoMarker(attack, secret);
    expect(lines(attack), attack.stderr).toEqual(["rewritten", "ssh-denied", "database-denied", "login-denied"]);
    // The pointer is read-only to every build, so the rewrite failed: the next launch binds the genuine checkout.
    expect(readFileSync(join(at.active, ".git"), "utf8")).not.toContain(".ssh");
    expect(trustedWorktreeBinding(at.main, at.active, [at.pool]).gitdir).not.toContain(".ssh");
  });
});
