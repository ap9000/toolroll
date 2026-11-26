/**
 * Opening the console's address (browser-open.ts): a missing opener (no xdg-open) is never an uncaught error, and
 * nothing is started where no browser can show it — no display on Linux, or SSH without a forwarded display — unless
 * the person chose a browser command.
 */
import { expect, test } from "vitest";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { noBrowserReason, startOpener, type Spawner } from "./browser-open.js";

test("an opener that isn't there (ENOENT) is reported to a listener, never thrown", async () => {
  const started: ChildProcess[] = [];
  const real: Spawner = (command, args, options) => { const child = spawn(command, args, options); started.push(child); return child; };
  expect(startOpener("/nonexistent/xdg-open", ["http://127.0.0.1:4180"], { env: { DISPLAY: ":0" }, platform: "linux", spawn: real })).toBe(true);
  // The listener is attached before startOpener returns: the asynchronous ENOENT can't become an uncaught error.
  expect(started[0]!.listenerCount("error")).toBeGreaterThan(0);
  const [error] = await once(started[0]!, "error") as [NodeJS.ErrnoException];
  expect(error.code).toBe("ENOENT");
});

test.each([
  ["Linux desktop", "linux", { DISPLAY: ":0" }, true],
  ["Linux Wayland", "linux", { WAYLAND_DISPLAY: "wayland-0" }, true],
  ["Linux, no display (a server, a container)", "linux", {}, false],
  ["Linux over SSH", "linux", { SSH_CONNECTION: "10.0.0.2 5000 10.0.0.1 22" }, false],
  ["Linux over SSH, display forwarded", "linux", { SSH_TTY: "/dev/pts/0", DISPLAY: "localhost:10.0" }, true],
  ["a Mac over SSH", "darwin", { SSH_CONNECTION: "10.0.0.2 5000 10.0.0.1 22" }, false],
  ["a Mac at its own screen", "darwin", {}, true],
  ["no display, but a browser command chosen", "linux", { TOOLROLL_BROWSER_COMMAND: "/usr/bin/w3m" }, true],
  ["no display, BROWSER set", "linux", { BROWSER: "lynx" }, true],
] as const)("%s: opener started → %s", (_, platform, env, starts) => {
  const calls: string[] = [];
  const fake: Spawner = command => { calls.push(command); return { on: () => undefined, unref: () => undefined } as unknown as ChildProcess; };
  expect(startOpener("xdg-open", ["http://127.0.0.1:4180"], { env, platform, spawn: fake })).toBe(starts);
  expect(calls.length).toBe(starts ? 1 : 0);
  expect(noBrowserReason(env, platform) === null).toBe(starts);
});
