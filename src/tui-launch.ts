/**
 * Launching the terminal workbench (solo-workbench plan T1): the Rust binary bare `toolroll` opens in solo/local mode,
 * with the classic (Ink) screen as the fallback.
 *
 * - Which binary: `TOOLROLL_SCREEN=classic` or `--screen-reader` choose the classic screen; otherwise this machine's
 *   platform package (`@toolroll/tui-<platform>-<arch>`, an optional dependency), else a source checkout's own build
 *   (`tui/target/release/toolroll-tui`). `TOOLROLL_TUI_BINARY` names another build (a developer's own; anyone who can
 *   set this person's environment can already run programs as them).
 * - Self-check before anything is minted: `<binary> --version` must answer `toolroll-tui <v> contract <digest>` with
 *   this build's engine contract digest (contracts/engine-api.ts); a binary from another build, one that doesn't start
 *   (ENOEXEC, a crash) or doesn't answer in time is never handed a sign-in.
 * - Then the console's socket mints the local owner's one-time link (console-instance.ts requestLocalLink) and the
 *   binary gets it on file descriptor 3 only (engine-handoff.ts spawnWithLink): never its arguments or environment.
 * - Descriptor 4 is the binary's one way to ask this process for something only it can do: one JSON line per ask, read
 *   capped; the only ask is `{"want":"browser"}` (open this computer's browser signed in, TuiSession.openBrowser),
 *   answered on the same descriptor with one line `{"said":"<words>"}`. It never carries a credential.
 * - How it ended is its exit code: 0 leave, 40 stop the agents this terminal started, 41 keep them running in the
 *   background, 42 "open the classic screen instead" (it said why on its own error output, after restoring the terminal).
 *
 * Every failure before the screen opens falls back to the classic screen with one line saying why.
 */
import { spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnWithLink } from "./engine-handoff.js";
import type { TuiExit, TuiSession } from "./tui-contract.js";

/** The exit codes the binary ends with (tui/crates/toolroll-tui/src/lib.rs EXIT_*). */
export const TUI_EXIT = { leave: 0, stop: 40, keep: 41, classic: 42 } as const;
/** Platforms with a terminal workbench package (scripts/tui-build.mjs PLATFORMS). */
export const TUI_PACKAGES: Readonly<Record<string, string>> = Object.freeze({
  "darwin-arm64": "@toolroll/tui-darwin-arm64", "darwin-x64": "@toolroll/tui-darwin-x64",
  "linux-x64": "@toolroll/tui-linux-x64", "linux-arm64": "@toolroll/tui-linux-arm64",
});
/** The longest ask line read from descriptor 4; anything longer is dropped whole. */
const ASK_CAP = 1024;
const SELF_CHECK_MS = 3_000;

export type TuiChoice = { ok: true; binary: string } | { ok: false; why: string };

export type TuiChoiceInput = {
  env: NodeJS.ProcessEnv;
  screenReader: boolean;
  platform: string;
  arch: string;
  /** The engine contract this build speaks (engineContractDigest). */
  contract: string;
  /** A package's manifest path, or null when it isn't installed (tests pass their own). */
  resolvePackage?: (name: string) => string | null;
  /** This package's own root (a source checkout has tui/ in it). */
  packageRoot?: string;
  /** Run `<binary> --version` (tests pass their own). */
  selfCheck?: (binary: string) => { status: number | null; stdout: string; error?: string };
};

const own = createRequire(import.meta.url);
const defaultResolve = (name: string): string | null => { try { return own.resolve(`${name}/package.json`); } catch { return null; } };
const defaultRoot = (): string => join(dirname(fileURLToPath(import.meta.url)), "..");
const defaultSelfCheck = (binary: string) => {
  const ran = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: SELF_CHECK_MS, stdio: ["ignore", "pipe", "ignore"] });
  return { status: ran.status, stdout: ran.stdout ?? "", ...(ran.error === undefined ? {} : { error: (ran.error as NodeJS.ErrnoException).code ?? ran.error.message }) };
};

/** Which screen to open, and when it's the classic one, why (one line). Reads nothing secret and mints nothing. */
export function chooseTuiBinary(input: TuiChoiceInput): TuiChoice {
  if (input.env["TOOLROLL_SCREEN"] === "classic") return { ok: false, why: "TOOLROLL_SCREEN=classic asks for it" };
  if (input.screenReader) return { ok: false, why: "it works with screen readers" };
  let binary: string | null = null;
  const named = input.env["TOOLROLL_TUI_BINARY"];
  if (named !== undefined && named !== "") binary = named;
  else {
    const name = TUI_PACKAGES[`${input.platform}-${input.arch}`];
    const manifest = name === undefined ? null : (input.resolvePackage ?? defaultResolve)(name);
    if (manifest !== null) binary = join(dirname(manifest), "bin", "toolroll-tui");
    else {
      const built = join(input.packageRoot ?? defaultRoot(), "tui", "target", "release", "toolroll-tui");
      if (existsSync(built)) binary = built;
      else if (name === undefined) return { ok: false, why: `the terminal workbench isn't built for ${input.platform}-${input.arch} yet` };
      else return { ok: false, why: "the terminal workbench isn't installed on this computer" };
    }
  }
  const check = (input.selfCheck ?? defaultSelfCheck)(binary);
  if (check.status !== 0) return { ok: false, why: `the terminal workbench didn't start (${check.error ?? (check.status === null ? "no answer" : `exit ${check.status}`)})` };
  const said = /^toolroll-tui \S+ contract ([0-9a-f]{64})$/.exec(check.stdout.trim());
  if (said === null || said[1] !== input.contract) return { ok: false, why: "the terminal workbench is from another Toolroll version" };
  return { ok: true, binary };
}

export type TuiRunInput = {
  binary: string;
  /** The one-time link (requestLocalLink); it travels only over descriptor 3. */
  link: string;
  session: TuiSession;
  /** The repository this terminal is in, the project a new task goes to. */
  project: string | null;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Tests: the binary's standard streams (default: this terminal's). */
  stdio?: readonly ["inherit" | "ignore" | "pipe", "inherit" | "ignore" | "pipe", "inherit" | "ignore" | "pipe"];
  /** Tests: told when the child starts. */
  started?: (child: ChildProcess) => void;
};

/** How the binary ended: a screen exit, or "classic" (open the classic screen; it said why). */
export type TuiRunEnd = TuiExit | "classic";

/** Run the binary until it ends, signals forwarded, its asks answered. */
export async function runTuiBinary(input: TuiRunInput): Promise<TuiRunEnd> {
  const args = ["--control-fd", "4", ...(input.session.owned() ? ["--owned"] : []), ...(input.project === null ? [] : ["--project", input.project])];
  const child = spawnWithLink(input.binary, args, input.link, {
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }), ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.stdio === undefined ? {} : { stdio: input.stdio }), control: true,
  });
  input.started?.(child);
  const asks = child.stdio[4];
  if (asks !== null && asks !== undefined && "on" in asks) {
    let pending = "";
    asks.on("error", () => {});
    asks.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      // An ask longer than the cap is dropped whole (its rest too, up to the next newline).
      if (pending.length > ASK_CAP && !pending.includes("\n")) { pending = "\u0000"; return; }
      let at: number;
      while ((at = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, at);
        pending = pending.slice(at + 1);
        if (line.startsWith("\u0000") || line.length > ASK_CAP) continue;
        let ask: unknown = null;
        try { ask = JSON.parse(line); } catch { ask = null; }
        // The answer goes back on the same descriptor, one line: what to say ({"said": "..."}).
        if (ask !== null && typeof ask === "object" && (ask as Record<string, unknown>)["want"] === "browser") {
          void input.session.openBrowser().catch(() => "The browser couldn't be opened.").then(said => {
            if ("write" in asks && !child.killed && child.exitCode === null) (asks as NodeJS.WritableStream).write(`${JSON.stringify({ said })}\n`);
          });
        }
      }
    });
  }
  // A terminal's Ctrl-C reaches the whole foreground group (the binary reads it raw anyway); these are forwarded.
  const forward = (signal: NodeJS.Signals) => () => { if (child.exitCode === null) child.kill(signal); };
  const handlers = (["SIGTERM", "SIGHUP"] as const).map(signal => [signal, forward(signal)] as const);
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const code = await new Promise<number | null>(resolve => {
    // It couldn't be started at all (gone since its self-check): the classic screen.
    child.once("error", () => resolve(-1));
    child.once("exit", (exit, signal) => resolve(signal === null ? exit : null));
  });
  for (const [signal, handler] of handlers) process.off(signal, handler);
  if (code === TUI_EXIT.stop) return "stop";
  if (code === TUI_EXIT.keep) return "keep";
  if (code === TUI_EXIT.classic || code === -1) return "classic";
  return "leave";
}
