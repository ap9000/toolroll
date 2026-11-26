/**
 * Opening an address that carries no credential in this computer's browser (the console's own address, a pairing
 * page): detached, never load-bearing, never a crash. The caller has already printed the address.
 *
 * - Nothing is started where no browser can show it: on Linux (and other Unix) with neither DISPLAY nor WAYLAND_DISPLAY,
 *   and on any computer reached over SSH (SSH_CONNECTION or SSH_TTY) unless a display is forwarded. An explicit choice
 *   wins and is what runs: TOOLROLL_BROWSER_COMMAND, or on Linux BROWSER's program (browserCommand).
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
  if (chosenCommand(env) !== null || (platform !== "darwin" && platform !== "win32" && browserEntry(env) !== null)) return null;
  const display = set(env, "DISPLAY") || set(env, "WAYLAND_DISPLAY");
  if ((set(env, "SSH_CONNECTION") || set(env, "SSH_TTY")) && !display) return "this is an SSH session";
  if (platform !== "darwin" && platform !== "win32" && !display) return "there is no display here";
  return null;
}

/** The browser command a person chose for Toolroll: TOOLROLL_BROWSER_COMMAND (or its name before the rename). */
function chosenCommand(env: Env): string | null {
  for (const name of ["TOOLROLL_BROWSER_COMMAND", "STANDING_ORDERS_BROWSER_COMMAND"]) if (set(env, name)) return env[name]!;
  return null;
}

/** BROWSER's first entry when it is a plain program name or path (no arguments, no %s); null otherwise. */
function browserEntry(env: Env): string | null {
  const first = (env["BROWSER"] ?? "").split(":")[0]!.trim();
  return first !== "" && /^[A-Za-z0-9._/+-]+$/.test(first) ? first : null;
}

/**
 * What opens `url` here, as the program and its arguments, the one choice every opener of an address shares
 * (operate.ts openBrowser, `toolroll connect`): the command chosen for Toolroll, else the platform's opener (on Linux
 * and other Unix, BROWSER's program when it names one, else xdg-open). The address is always its last argument alone.
 */
export function browserCommand(url: string, env: Env = process.env, platform: NodeJS.Platform = process.platform): [string, ...string[]] {
  const chosen = chosenCommand(env);
  if (chosen !== null) return [chosen, url];
  if (platform === "darwin") return ["open", url];
  if (platform === "win32") return ["cmd", "/c", "start", "", url];
  return [browserEntry(env) ?? "xdg-open", url];
}

/** Open an address with browserCommand's choice (startOpener: never without a display or over SSH unless chosen). */
export function openAddress(url: string, options: { env?: Env; platform?: NodeJS.Platform; spawn?: Spawner } = {}): boolean {
  const [command, ...args] = browserCommand(url, options.env ?? process.env, options.platform ?? process.platform);
  return startOpener(command, args, options);
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
