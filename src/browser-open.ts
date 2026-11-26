/**
 * Opening an address that carries no credential in this computer's browser (the console's own address, a pairing
 * page): detached, never load-bearing, never a crash. The caller has already printed the address.
 *
 * - Nothing is started where no browser can show it: on Linux (and other Unix) with neither DISPLAY nor WAYLAND_DISPLAY,
 *   and on any computer reached over SSH (SSH_CONNECTION or SSH_TTY) unless a display is forwarded. An explicit choice
 *   wins: TOOLROLL_BROWSER_COMMAND (or BROWSER, which xdg-open itself honours) always starts.
 * - A program that isn't there (no xdg-open) is reported by the child's 'error' event after spawn returns: a listener
 *   is always attached, so it is never an uncaught error.
 *
 * Sign-in links never come here: sign-in-page.ts opens those with the platform's own opener and its own checks.
 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

type Env = Readonly<Record<string, string | undefined>>;
export type Spawner = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

const set = (env: Env, name: string): boolean => (env[name] ?? "") !== "";

/** Why no browser can be shown here (null when one may): no display on Linux, or a session over SSH. */
export function noBrowserReason(env: Env = process.env, platform: NodeJS.Platform = process.platform): string | null {
  if (set(env, "TOOLROLL_BROWSER_COMMAND") || set(env, "STANDING_ORDERS_BROWSER_COMMAND") || set(env, "BROWSER")) return null;
  const display = set(env, "DISPLAY") || set(env, "WAYLAND_DISPLAY");
  if ((set(env, "SSH_CONNECTION") || set(env, "SSH_TTY")) && !display) return "this is an SSH session";
  if (platform !== "darwin" && platform !== "win32" && !display) return "there is no display here";
  return null;
}

/**
 * Start `command args` detached to open an address, unless no browser can be shown here. True when it was started
 * (whether the browser then opens is the opener's business), false when nothing was started or it couldn't be.
 */
export function startOpener(command: string, args: readonly string[], options: { env?: Env; platform?: NodeJS.Platform; spawn?: Spawner } = {}): boolean {
  if (noBrowserReason(options.env, options.platform) !== null) return false;
  try {
    const child = (options.spawn ?? spawn)(command, [...args], { detached: true, stdio: "ignore" });
    // ENOENT (no xdg-open) and other start failures arrive here, after spawn returned.
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
