/**
 * Opening the console's address (browser-open.ts): a missing opener (no xdg-open) is never an uncaught error, and
 * nothing is started where no browser can show it — no display on Linux, or SSH without a forwarded display — unless
 * the person chose a browser command.
 */
import { expect, test } from "vitest";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { browserCommand, noBrowserReason, openAddress, startOpener, type Spawner } from "./browser-open.js";

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

const URL = "http://127.0.0.1:4180";
test.each([
  ["a chosen command wins everywhere", "linux", { TOOLROLL_BROWSER_COMMAND: "/usr/local/bin/open-in-firefox" }, ["/usr/local/bin/open-in-firefox", URL]],
  ["its name before the rename", "darwin", { STANDING_ORDERS_BROWSER_COMMAND: "/opt/b" }, ["/opt/b", URL]],
  ["Linux, BROWSER names a program", "linux", { BROWSER: "w3m:lynx" }, ["w3m", URL]],
  ["Linux, BROWSER with arguments is left to xdg-open", "linux", { BROWSER: "firefox %s", DISPLAY: ":0" }, ["xdg-open", URL]],
  ["Linux", "linux", {}, ["xdg-open", URL]],
  ["a Mac (BROWSER is Unix's, not its)", "darwin", { BROWSER: "w3m" }, ["open", URL]],
  ["Windows", "win32", {}, ["cmd", "/c", "start", "", URL]],
] as const)("what opens an address: %s", (_, platform, env, command) => {
  expect(browserCommand(URL, env, platform)).toEqual(command);
});

test("headless with a chosen browser and no xdg-open: the chosen program is what runs, with the address alone (operate and connect share this)", () => {
  const calls: { command: string; args: readonly string[] }[] = [];
  const fake: Spawner = (command, args) => { calls.push({ command, args }); return { on: () => undefined, unref: () => undefined } as unknown as ChildProcess; };
  expect(openAddress(URL, { env: { TOOLROLL_BROWSER_COMMAND: "/home/dev/bin/open-url" }, platform: "linux", spawn: fake })).toBe(true);
  expect(openAddress(URL, { env: { BROWSER: "w3m", SSH_TTY: "/dev/pts/1" }, platform: "linux", spawn: fake })).toBe(true);
  expect(openAddress(URL, { env: {}, platform: "linux", spawn: fake })).toBe(false);
  expect(calls).toEqual([{ command: "/home/dev/bin/open-url", args: [URL] }, { command: "w3m", args: [URL] }]);
});
