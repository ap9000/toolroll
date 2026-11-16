/**
 * Launching the terminal workbench (solo-workbench plan T1): the Rust binary bare `toolroll` opens in solo/local mode,
 * with the classic (Ink) screen as the fallback.
 *
 * - Which binary. The trust anchor is WHERE the binary lives, never what it prints and never what the environment says:
 *   - `TOOLROLL_SCREEN=classic` or `--screen-reader` choose the classic screen;
 *   - a developer's own build only by an explicit trust decision on the command line: `--tui-binary <absolute path>`,
 *     said in one line when used. `TOOLROLL_TUI_BINARY` is not read (a variable set in an environment is no decision);
 *   - else the binary this package ships for this machine, `dist/tui/<platform>-<arch>/toolroll-tui` under this
 *     package's own root (publish.yml builds and bundles all four). That root comes only from where this module itself
 *     runs (import.meta.url, real path): never from the environment, the working folder or PATH;
 *   - else this machine's platform package (`@toolroll/tui-<platform>-<arch>`, an optional dependency), looked for only
 *     in Toolroll's own install tree (this package's own node_modules, or the node_modules folder this package itself
 *     sits in): never through Node's upward module search, never through PATH;
 *   - else a source checkout's own build (`tui/target/release/toolroll-tui`), only when Toolroll itself runs from that
 *     same checkout (this package's root has `.git` and `tui/Cargo.toml`).
 *   The first of these that is there is the one checked; a later one never stands in for a refused one.
 *   Whichever it is, its real path (symlinks resolved) must be a regular file owned by this user or root and not
 *   writable by group or others, in folders that are all owned by this user or root and not writable by group or others
 *   (an ancestor may be a sticky shared folder such as /tmp: nobody else can rename what is in it), and on macOS none of
 *   them may carry an ACL entry that allows anyone a change right (write, append, add_file, add_subdirectory, delete,
 *   delete_child, writeattr, writeextattr, writesecurity, chown; deny entries are fine, and an ACL that can't be read
 *   refuses). On Linux a POSIX ACL granting write shows up in the group mode bits (its mask), so the mode check covers
 *   it. Then nobody but this
 *   user (or root) can replace it between the check and the start. Anyone able to write Toolroll's own install tree
 *   already controls Toolroll's JavaScript, so that tree is as trusted as this file. So an install owned by this user
 *   (Homebrew's Cellar, `npm i -g` under nvm or a person's own /opt/homebrew) and one owned by root (`sudo npm i -g`
 *   into /usr/local) both pass, and one others can write (a group- or world-writable npm prefix) is refused.
 * - Self-check, a compatibility test only: `<binary> --version` must answer `toolroll-tui <v> contract <digest>` with
 *   this build's engine contract digest (contracts/engine-api.ts); a binary from another build, one that doesn't start
 *   (ENOEXEC, a crash), can't turn crash dumps off (exit 43) or doesn't answer in time is never handed a sign-in.
 * - Then the console's socket mints the local owner's one-time link (console-instance.ts requestLocalLink), and the
 *   exact path that was checked is started with descriptor 3 open but empty. The binary turns crash dumps off and says
 *   `{"ready":"protected"}` on descriptor 4; only then is the link written on descriptor 3 (engine-handoff.ts
 *   spawnHoldingLink): never its arguments or environment, and never to a binary that didn't say it was protected.
 * - Descriptor 4 is also the binary's one way to ask this process for something only it can do: one JSON line per ask,
 *   read capped; the only ask is `{"want":"browser"}` (open this computer's browser signed in, TuiSession.openBrowser),
 *   answered on the same descriptor with one line `{"said":"<words>"}`. It never carries a credential.
 * - How it ended is its exit code: 0 leave, 40 stop the agents this terminal started, 41 keep them running in the
 *   background, 42 "open the classic screen instead" (it said why on its own error output, after restoring the terminal),
 *   43 it couldn't turn crash dumps off (said why; nothing was sent).
 *
 * Every failure before the screen opens falls back to the classic screen with one line saying why.
 */
import { spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnHoldingLink } from "./engine-handoff.js";
import { trustedBinary } from "./trusted-path.js";
export { aclVerdictOf, trustedBinary, type AclVerdict } from "./trusted-path.js";
import type { TuiExit, TuiSession } from "./tui-contract.js";

/** The exit codes the binary ends with (tui/crates/toolroll-tui/src/app.rs EXIT_*). */
export const TUI_EXIT = { leave: 0, stop: 40, keep: 41, classic: 42, unprotected: 43 } as const;
/** Platforms with a terminal workbench build (scripts/tui-build.mjs PLATFORMS): its optional package's name. The same
 * keys name the bundled binary's folder, dist/tui/<key>/toolroll-tui. */
export const TUI_PACKAGES: Readonly<Record<string, string>> = Object.freeze({
  "darwin-arm64": "@toolroll/tui-darwin-arm64", "darwin-x64": "@toolroll/tui-darwin-x64",
  "linux-x64": "@toolroll/tui-linux-x64", "linux-arm64": "@toolroll/tui-linux-arm64",
});
/** The longest ask line read from descriptor 4; anything longer is dropped whole. */
const ASK_CAP = 1024;
const SELF_CHECK_MS = 3_000;
/** How long the binary has to say it is protected; past it the hand-off is expired for good (the link is never sent). */
const READY_MS = 5_000;
/** How long a binary stopped with SIGTERM (at the ready deadline) has before SIGKILL. */
const KILL_AFTER_MS = 1_000;
/** The line the binary says on descriptor 4 once crash dumps are off (tui/crates/toolroll-tui/src/guard.rs READY_LINE). */
const READY = "protected";

export type TuiChoice = { ok: true; binary: string; notice?: string } | { ok: false; why: string; notice?: string };

export type TuiChoiceInput = {
  env: NodeJS.ProcessEnv;
  screenReader: boolean;
  platform: string;
  arch: string;
  /** The engine contract this build speaks (engineContractDigest). */
  contract: string;
  /** `--tui-binary <path>`: a developer's own build, chosen on the command line (it must be absolute). */
  devBinary?: string | null;
  /** This package's own root, where Toolroll's JavaScript runs from (tests pass their own). */
  packageRoot?: string;
  /** The user files must be owned by, besides root (default: this process's). */
  uid?: number;
  /** Run `<binary> --version` (tests pass their own). */
  selfCheck?: (binary: string) => { status: number | null; stdout: string; error?: string };
};

/** A package's root from one of its modules' URLs: the folder above the module's (dist/), by its real path. This
 * launcher passes its own import.meta.url: only where it runs decides the root. */
export const packageRootOf = (moduleUrl: string): string => {
  const root = join(dirname(fileURLToPath(moduleUrl)), "..");
  try { return realpathSync(root); } catch { return root; }
};
const defaultRoot = (): string => packageRootOf(import.meta.url);
/** The binary this package ships for `key` (a TUI_PACKAGES key, never a caller's string). */
export const bundledBinary = (root: string, key: string): string => join(root, "dist", "tui", key, "toolroll-tui");
const defaultSelfCheck = (binary: string) => {
  const ran = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: SELF_CHECK_MS, stdio: ["ignore", "pipe", "ignore"] });
  return { status: ran.status, stdout: ran.stdout ?? "", ...(ran.error === undefined ? {} : { error: (ran.error as NodeJS.ErrnoException).code ?? ran.error.message }) };
};

/** Where the platform package may be: only inside Toolroll's own install tree (see the header), never an upward search. */
function packageCandidates(root: string, name: string): string[] {
  const parts = name.split("/");
  const places = [join(root, "node_modules", ...parts)];
  // Hoisted beside Toolroll itself, in the node_modules folder Toolroll is installed in.
  if (basename(dirname(root)) === "node_modules") places.push(join(dirname(root), ...parts));
  return places;
}

/** The installed platform package's binary path, or null (a folder whose package.json names another package is none). */
function installedPackageBinary(root: string, name: string): string | null {
  for (const place of packageCandidates(root, name)) {
    try {
      const manifest = JSON.parse(readFileSync(join(place, "package.json"), "utf8")) as { name?: unknown };
      if (manifest.name === name) return join(place, "bin", "toolroll-tui");
    } catch { /* not here */ }
  }
  return null;
}

/** Which screen to open, and when it's the classic one, why (one line). Reads nothing secret and mints nothing. */
export function chooseTuiBinary(input: TuiChoiceInput): TuiChoice {
  const ignored = (input.env["TOOLROLL_TUI_BINARY"] ?? "") === "" ? undefined
    : "TOOLROLL_TUI_BINARY is ignored: pass --tui-binary <absolute path> to use your own build";
  const note = (choice: TuiChoice, more?: string): TuiChoice => {
    const notice = [more, ignored].filter(one => one !== undefined).join(". ");
    return notice === "" ? choice : { ...choice, notice };
  };
  if (input.env["TOOLROLL_SCREEN"] === "classic") return note({ ok: false, why: "TOOLROLL_SCREEN=classic asks for it" });
  if (input.screenReader) return note({ ok: false, why: "it works with screen readers" });
  const root = input.packageRoot ?? defaultRoot();
  const uid = input.uid ?? process.getuid?.();
  const key = `${input.platform}-${input.arch}`;
  const name = Object.hasOwn(TUI_PACKAGES, key) ? TUI_PACKAGES[key] : undefined;
  let binary: string;
  let notice: string | undefined;
  if (input.devBinary !== undefined && input.devBinary !== null) {
    if (!isAbsolute(input.devBinary)) return note({ ok: false, why: "--tui-binary needs an absolute path" });
    const trusted = trustedBinary(input.devBinary, uid);
    if (!trusted.ok) return note({ ok: false, why: `--tui-binary ${input.devBinary} can't be trusted: ${trusted.why}` });
    binary = trusted.real;
    notice = `Using your own terminal workbench build at ${binary} (--tui-binary)`;
  } else {
    // In order: the binary this package ships, the optional platform package, this checkout's own build. The first
    // that is there is the one checked (a refused one never falls through to the next).
    const bundled = name === undefined ? null : bundledBinary(root, key);
    const checkout = existsSync(join(root, ".git")) && existsSync(join(root, "tui", "Cargo.toml"));
    const built = join(root, "tui", "target", "release", "toolroll-tui");
    const found = (bundled !== null && existsSync(bundled) ? bundled : null)
      ?? (name === undefined ? null : installedPackageBinary(root, name))
      ?? (checkout && existsSync(built) ? built : null);
    if (found === null) {
      if (name === undefined) return note({ ok: false, why: `the terminal workbench isn't built for ${input.platform}-${input.arch} yet` });
      return note({ ok: false, why: "the terminal workbench isn't installed on this computer" });
    }
    const trusted = trustedBinary(found, uid);
    if (!trusted.ok) return note({ ok: false, why: `the terminal workbench at ${found} can't be trusted: ${trusted.why}` });
    binary = trusted.real;
  }
  // From here on only `binary` (the real path just checked) is run: the self-check, then the screen itself.
  const check = (input.selfCheck ?? defaultSelfCheck)(binary);
  if (check.status === TUI_EXIT.unprotected) return note({ ok: false, why: "the terminal workbench couldn't turn off crash dumps on this computer" }, notice);
  if (check.status !== 0) return note({ ok: false, why: `the terminal workbench didn't start (${check.error ?? (check.status === null ? "no answer" : `exit ${check.status}`)})` }, notice);
  const said = /^toolroll-tui \S+ contract ([0-9a-f]{64})$/.exec(check.stdout.trim());
  if (said === null || said[1] !== input.contract) return note({ ok: false, why: "the terminal workbench is from another Toolroll version" }, notice);
  return note({ ok: true, binary }, notice);
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
  /** Tests: how long the binary has to say it is protected (default 5 s). */
  readyMs?: number;
  /** Tests: how long after SIGTERM before SIGKILL (default 1 s). */
  killAfterMs?: number;
};

/** How the binary ended: a screen exit, or "classic" (open the classic screen; it said why). */
export type TuiRunEnd = TuiExit | "classic";

/** Run the binary until it ends, signals forwarded, its asks answered. */
export async function runTuiBinary(input: TuiRunInput): Promise<TuiRunEnd> {
  const args = ["--control-fd", "4", ...(input.session.owned() ? ["--owned"] : []), ...(input.project === null ? [] : ["--project", input.project])];
  // The exact path chooseTuiBinary checked (absolute): never a name looked up on PATH.
  if (!isAbsolute(input.binary)) throw new Error("the terminal workbench is started only by its checked, absolute path");
  const { child, send } = spawnHoldingLink(input.binary, args, input.link, {
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }), ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.stdio === undefined ? {} : { stdio: input.stdio }), control: true,
  });
  input.started?.(child);
  // The link is written only once the binary says crash dumps are off. Past the deadline the hand-off is expired for
  // good: a ready line arriving later sends nothing, and this exact child is stopped (SIGTERM, then SIGKILL).
  let sentLink = false;
  let expired = false;
  let killTimer: NodeJS.Timeout | undefined;
  const running = () => child.exitCode === null && child.signalCode === null;
  const readyTimer = setTimeout(() => {
    if (sentLink) return;
    expired = true;
    if (!running()) return;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => { if (running()) child.kill("SIGKILL"); }, input.killAfterMs ?? KILL_AFTER_MS);
  }, input.readyMs ?? READY_MS);
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
        if (ask !== null && typeof ask === "object" && (ask as Record<string, unknown>)["ready"] === READY) {
          if (!sentLink && !expired) { sentLink = send(); clearTimeout(readyTimer); }
          continue;
        }
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
  clearTimeout(readyTimer);
  clearTimeout(killTimer);
  // It never said it was protected (so it never had the link): the screen never opened.
  if (!sentLink) return "classic";
  if (code === TUI_EXIT.stop) return "stop";
  if (code === TUI_EXIT.keep) return "keep";
  if (code === TUI_EXIT.classic || code === TUI_EXIT.unprotected || code === -1) return "classic";
  return "leave";
}
