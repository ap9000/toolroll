/**
 * Attack: a fenced build asking another application to act for it outside the sandbox (docs/plans/sandbox-parity.md
 * C5). Under the old `(allow default)` profile, Apple Events and Launch Services were refused only under a confined
 * network (the delegation mach denies), so a build with an open network could `open` an application and have it run
 * whatever the document said, outside every fence. Anthropic's sandbox-runtime's deny-default profile never allows
 * `appleevent-send` or `lsopen` (its `allowAppleEvents` stays off), under any network.
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
import { NO_GRANTS, srtTermsOf, type NetworkFence } from "../../src/agent-fence.js";
import { srtMacosCommand } from "../../src/sandbox-runtime.js";
import { marker, needs, seatbelt, underSandbox, useScratch, write } from "./harness.js";

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

/** Wait up to `ms` for every instance of `applet` to quit: one still quitting can swallow the next `open` sent to it
 * (an applet with no stay-open handler quits after its `open` handler). Whether any is left. */
function appletGone(applet: string, ms: number): boolean {
  const until = Date.now() + ms;
  for (;;) {
    if (spawnSync("/usr/bin/pgrep", ["-f", join(applet, "Contents", "MacOS")], { encoding: "utf8" }).status === 1) return true;
    if (Date.now() >= until) return false;
    spawnSync("/bin/sleep", ["0.2"]);
  }
}

describe("attack: Apple Events and Launch Services from inside the fence", () => {
  test("policy: every profile denies them, under an open network and a confined one, after everything else", () => {
    for (const network of Object.values(NETWORKS)) {
      const lines = srtMacosCommand("/usr/bin/true", [], srtTermsOf([], { ...NO_GRANTS, network }), "/").split("\n");
      expect(lines.some(line => line.startsWith("(deny default"))).toBe(true);
      expect(lines.some(line => /\(allow (appleevent-send|lsopen)/.test(line) || line.includes('"com.apple.coreservices.appleevents"') && line.includes("(allow"))).toBe(false);
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
    // Every send starts a new instance (-n) once the last one has quit, so a lingering one can't swallow the event.
    const sent = spawnSync("/usr/bin/open", ["-g", "-n", "-a", applet, baseline], { encoding: "utf8", timeout: 30_000 });
    const received = sent.status === 0 && waitFor(record, baseline, 30_000);
    ctx.skip(!received, `Apple Events probe skipped: this session can't send Apple Events even unsandboxed (open exit ${sent.status}: ${sent.stderr.trim()})`);
    // The hole as it was, a second positive control: inside a sandbox that allows by default (the old profile's opening),
    // the event still arrives. It only shows the old hole, so where it doesn't reproduce (a CI runner's session) the
    // native part skips and says so, as the baseline does; it is not the property this test guards.
    expect(appletGone(applet, 15_000), "the baseline's applet never quit").toBe(true);
    const old = write(join(dir, `${marker("allow-default")}.txt`), "x");
    const before = spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/open", "-g", "-n", "-a", applet, old], { encoding: "utf8", timeout: 30_000 });
    ctx.skip(!(before.status === 0 && waitFor(record, old, 30_000)), `Apple Events probe skipped: the old (allow default) hole didn't reproduce here (open exit ${before.status}: ${before.stderr.trim()})`);
    // The property: from inside the fence the event never arrives, whatever the network. These stay hard failures.
    for (const [name, network] of Object.entries(NETWORKS)) {
      expect(appletGone(applet, 15_000), `${name}: an earlier applet never quit`).toBe(true);
      const doc = write(join(dir, `${marker(name)}.txt`), "x");
      const fenced = underSandbox(`/usr/bin/open -g -n -a ${JSON.stringify(applet)} ${JSON.stringify(doc)}`, [], { ...NO_GRANTS, network }, { cwd: dir });
      expect(fenced.status, `${name}: ${fenced.stderr}`).not.toBe(0);
      expect(waitFor(record, doc, 5_000), `${name}: the applet received the sandboxed event`).toBe(false);
    }
    rmSync(applet, { recursive: true, force: true });
  }, 120_000);
});
