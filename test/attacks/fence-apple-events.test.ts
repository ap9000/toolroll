/**
 * Attack: a fenced build asking another application to act for it outside the sandbox (docs/plans/sandbox-parity.md
 * C5). Under the old `(allow default)` profile, Apple Events and Launch Services were refused only under a confined
 * network (the delegation mach denies), so a build with an open network could `open` an application and have it run
 * whatever the document said, outside every fence. The deny-default baseline never allows `appleevent-send` or
 * `lsopen`, under any network.
 *
 * Positive control (as Anthropic's sandbox runtime's own test, macos-apple-events.test.ts): a receiver this test owns —
 * an AppleScript applet whose `open` handler records the document it was sent — is first sent the event unsandboxed,
 * and must record it; only then are the sandboxed refusals evidence. Where that baseline can't run (no GUI session),
 * the native part is skipped and says so. Static finding: the hole was real. Not proven here: a full escape through it,
 * TCC prompts included.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { macosFenceProfile, NO_GRANTS, SANDBOX_EXEC, type NetworkFence } from "../../src/agent-fence.js";
import { marker, needs, seatbelt, underSeatbelt, useScratch, write } from "./harness.js";

const scratch = useScratch("apple-events");
const NETWORKS: Record<string, NetworkFence> = {
  open: { mode: "open" },
  allowlist: { mode: "allowlist", proxyPort: 1, brokerPorts: [], loopback: "proxy-only", socketRoots: [] },
};

/** Wait for `path` to hold `text`, up to `ms` (an applet answers in its own time). */
function waitFor(path: string, text: string, ms: number): boolean {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (existsSync(path) && readFileSync(path, "utf8").includes(text)) return true;
    spawnSync("/bin/sleep", ["0.2"]);
  }
  return false;
}

describe("attack: Apple Events and Launch Services from inside the fence", () => {
  test("policy: every profile denies them, under an open network and a confined one, after everything else", () => {
    for (const network of Object.values(NETWORKS)) {
      const lines = macosFenceProfile([], { ...NO_GRANTS, network }).split("\n");
      expect(lines[1]).toBe("(deny default)");
      expect(lines.slice(-2)).toEqual(["(deny appleevent-send)", "(deny lsopen)"]);
      expect(lines.some(line => /\(allow (appleevent-send|lsopen)/.test(line) || line.includes('"com.apple.coreservices.appleevents"') && line.startsWith("(allow"))).toBe(false);
    }
  });

  test("native: an applet this test owns receives `open` unsandboxed, and never from inside the fence, whatever the network", ctx => {
    needs(ctx, seatbelt());
    const dir = scratch();
    const record = join(dir, "received.txt");
    const applet = join(dir, "Receiver.app");
    const compiled = spawnSync("/usr/bin/osacompile", ["-o", applet, "-e",
      `on open theFiles\n  repeat with one in theFiles\n    do shell script "echo " & quoted form of (POSIX path of one) & " >> " & quoted form of ${JSON.stringify(record)}\n  end repeat\nend open`], { encoding: "utf8", timeout: 60_000 });
    ctx.skip(compiled.status !== 0, `Apple Events probe skipped: osacompile failed (${compiled.stderr.trim()})`);
    // Baseline: unsandboxed, Launch Services opens the applet and sends it the document (an Apple Event).
    const baseline = write(join(dir, `${marker("baseline")}.txt`), "x");
    const sent = spawnSync("/usr/bin/open", ["-g", "-a", applet, baseline], { encoding: "utf8", timeout: 30_000 });
    const received = sent.status === 0 && waitFor(record, baseline, 30_000);
    ctx.skip(!received, `Apple Events probe skipped: this session can't send Apple Events even unsandboxed (open exit ${sent.status}: ${sent.stderr.trim()})`);
    // The hole as it was: inside a sandbox that allows by default (the old profile's opening), the event still arrives.
    const old = write(join(dir, `${marker("allow-default")}.txt`), "x");
    const before = spawnSync(SANDBOX_EXEC, ["-p", "(version 1)(allow default)", "/usr/bin/open", "-g", "-a", applet, old], { encoding: "utf8", timeout: 30_000 });
    expect(before.status === 0 && waitFor(record, old, 30_000), before.stderr).toBe(true);
    for (const [name, network] of Object.entries(NETWORKS)) {
      const doc = write(join(dir, `${marker(name)}.txt`), "x");
      const fenced = underSeatbelt(`/usr/bin/open -g -a ${JSON.stringify(applet)} ${JSON.stringify(doc)}`, [], { ...NO_GRANTS, network }, { cwd: dir });
      expect(fenced.status, `${name}: ${fenced.stderr}`).not.toBe(0);
      expect(waitFor(record, doc, 5_000), `${name}: the applet received the sandboxed event`).toBe(false);
    }
    rmSync(applet, { recursive: true, force: true });
  }, 120_000);
});
