/**
 * Handing the terminal workbench its sign-in (solo-workbench plan A0; the launcher calls this). The Node launcher asks the
 * console's socket for the local owner's one-time link (console-instance.ts requestLocalLink), then starts the binary
 * and gives it the link over an inherited pipe — file descriptor 3, one line, then closed — never in its arguments or
 * its environment: build agents run as the same user, and a process's arguments and environment stay readable to that
 * user (ps, /proc) for as long as it runs, while the pipe holds the link only until the binary reads it. The binary
 * redeems it at once (POST /login/once, where it is spent on first use) and keeps the session in memory only.
 */
import { spawn, type ChildProcess } from "node:child_process";

type Stdio = "inherit" | "ignore" | "pipe";

/** The descriptor the binary reads its link from: one line, then end of file. */
export const LINK_FD = 3;
/** A local owner's one-time link at this computer's own console address (what requestLocalLink returns). */
const LINK = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):[0-9]{1,5}\/login\/once\/[A-Za-z0-9_-]{43}$/;

export type HandoffOptions = {
  cwd?: string;
  /** The binary's environment: as given (the launcher's own), never with the link in it. */
  env?: NodeJS.ProcessEnv;
  /** Its standard input, output and error (default: the launcher's own, for a terminal program). */
  stdio?: readonly [Stdio, Stdio, Stdio];
  /** Also a pipe on descriptor 4 for the binary's asks to the launcher (tui-launch.ts): it carries no credential. */
  control?: boolean;
};

/**
 * Start `command` with `link` on its descriptor 3. Refuses (throws) a link that isn't a local one-time link, and one that
 * appears in the arguments or the environment it would be given (it must travel only over the pipe).
 */
export function spawnWithLink(command: string, args: readonly string[], link: string, options: HandoffOptions = {}): ChildProcess {
  if (!LINK.test(link)) throw new Error("not a local one-time sign-in link");
  const code = link.slice(link.lastIndexOf("/") + 1);
  const env = options.env ?? process.env;
  if (args.some(one => one.includes(code)) || Object.entries(env).some(([name, value]) => name.includes(code) || (value ?? "").includes(code))) {
    throw new Error("the sign-in link goes only over the pipe, never in arguments or the environment");
  }
  const [stdin, stdout, stderr] = options.stdio ?? ["inherit", "inherit", "inherit"];
  const child = spawn(command, [...args], { cwd: options.cwd, env, stdio: options.control === true ? [stdin, stdout, stderr, "pipe", "pipe"] : [stdin, stdout, stderr, "pipe"] });
  const pipe = child.stdio[LINK_FD];
  if (pipe === null || pipe === undefined || !("write" in pipe)) { child.kill(); throw new Error("no pipe for the sign-in link"); }
  // A binary that exits before reading it: the write fails quietly (the link is single-use and expires anyway).
  pipe.on("error", () => {});
  (pipe as NodeJS.WritableStream).end(`${link}\n`);
  return child;
}
