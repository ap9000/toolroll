/**
 * Launching the terminal workbench (solo-workbench plan T1): the Rust binary bare `toolroll` opens in solo/local mode,
 * with the classic (Ink) screen as the fallback.
 *
 * - Which binary. The trust anchor is WHERE the binary lives, never what it prints and never what the environment says:
 *   - `TOOLROLL_SCREEN=classic` or `--screen-reader` choose the classic screen;
 *   - else this machine's platform package (`@toolroll/tui-<platform>-<arch>`, an optional dependency), looked for only
 *     in Toolroll's own install tree (this package's own node_modules, or the node_modules folder this package itself
 *     sits in): never through Node's upward module search, never through PATH;
 *   - else a source checkout's own build (`tui/target/release/toolroll-tui`), only when Toolroll itself runs from that
 *     same checkout (this package's root has `.git` and `tui/Cargo.toml`);
 *   - a developer's own build only by an explicit trust decision on the command line: `--tui-binary <absolute path>`,
 *     said in one line when used. `TOOLROLL_TUI_BINARY` is not read (a variable set in an environment is no decision).
 *   Whichever it is, its real path (symlinks resolved) must be a regular file owned by this user or root and not
 *   writable by group or others, in folders that are all owned by this user or root and not writable by group or others
 *   (an ancestor may be a sticky shared folder such as /tmp: nobody else can rename what is in it), and on macOS none of
 *   them may carry an ACL entry that allows anyone a change right (write, append, add_file, add_subdirectory, delete,
 *   delete_child, writeattr, writeextattr, writesecurity, chown; deny entries are fine, and an ACL that can't be read
 *   refuses). On Linux a POSIX ACL granting write shows up in the group mode bits (its mask), so the mode check covers
 *   it. Then nobody but this
 *   user (or root) can replace it between the check and the start. Anyone able to write Toolroll's own install tree
 *   already controls Toolroll's JavaScript, so that tree is as trusted as this file.
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
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnHoldingLink } from "./engine-handoff.js";
import type { TuiExit, TuiSession } from "./tui-contract.js";

/** The exit codes the binary ends with (tui/crates/toolroll-tui/src/app.rs EXIT_*). */
export const TUI_EXIT = { leave: 0, stop: 40, keep: 41, classic: 42, unprotected: 43 } as const;
/** Platforms with a terminal workbench package (scripts/tui-build.mjs PLATFORMS). */
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
/** macOS ACL rights that let someone change a file or folder (an `allow` entry with any of these refuses). */
const ACL_CHANGE: ReadonlySet<string> = new Set(["write", "append", "add_file", "add_subdirectory", "delete", "delete_child", "writeattr", "writeextattr", "writesecurity", "chown"]);
/** Every right `ls -le` may print; an unknown word refuses (the parser is strict). */
const ACL_RIGHTS: ReadonlySet<string> = new Set([...ACL_CHANGE, "read", "execute", "readattr", "readextattr", "readsecurity", "list", "search", "file_inherit", "directory_inherit", "limit_inherit", "only_inherit"]);
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

const defaultRoot = (): string => join(dirname(fileURLToPath(import.meta.url)), "..");
const defaultSelfCheck = (binary: string) => {
  const ran = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: SELF_CHECK_MS, stdio: ["ignore", "pipe", "ignore"] });
  return { status: ran.status, stdout: ran.stdout ?? "", ...(ran.error === undefined ? {} : { error: (ran.error as NodeJS.ErrnoException).code ?? ran.error.message }) };
};

/**
 * Whether `path` may be started: its real path is a regular file owned by `uid` or root and not group- or
 * world-writable, and so is every folder above it (an ancestor may instead be a sticky folder). The real path, or why not.
 */
export function trustedBinary(path: string, uid: number | undefined, acl: ((path: string) => AclVerdict) | null = process.platform === "darwin" ? macAcl : null): { ok: true; real: string } | { ok: false; why: string } {
  if (!isAbsolute(path)) return { ok: false, why: "it isn't an absolute path" };
  if (uid === undefined) return { ok: false, why: "who owns it can't be checked on this system" };
  let real: string;
  try { real = realpathSync(path); } catch (error) { return { ok: false, why: `it isn't there (${(error as NodeJS.ErrnoException).code ?? "unreadable"})` }; }
  const owned = (owner: number) => owner === uid || owner === 0;
  try {
    const file = lstatSync(real);
    if (!file.isFile()) return { ok: false, why: "it isn't a file" };
    if (!owned(file.uid)) return { ok: false, why: "it is owned by another user" };
    if ((file.mode & 0o022) !== 0) return { ok: false, why: "others can change it (group- or world-writable)" };
    const fileAcl = acl?.(real);
    if (fileAcl !== undefined && !fileAcl.ok) return { ok: false, why: `its ACL ${fileAcl.why}` };
    let folder = dirname(real);
    for (let first = true; ; first = false) {
      const dir = lstatSync(folder);
      if (!dir.isDirectory()) return { ok: false, why: `${folder} isn't a folder` };
      if (!owned(dir.uid)) return { ok: false, why: `${folder} is owned by another user` };
      const sticky = (dir.mode & 0o1000) !== 0;
      if ((dir.mode & 0o022) !== 0 && (first || !sticky)) return { ok: false, why: `others can change ${folder} (group- or world-writable)` };
      const dirAcl = acl?.(folder);
      if (dirAcl !== undefined && !dirAcl.ok) return { ok: false, why: `the ACL of ${folder} ${dirAcl.why}` };
      const up = dirname(folder);
      if (up === folder) break;
      folder = up;
    }
  } catch (error) {
    return { ok: false, why: `it can't be checked (${(error as NodeJS.ErrnoException).code ?? "unreadable"})` };
  }
  return { ok: true, real };
}

export type AclVerdict = { ok: true } | { ok: false; why: string };

/**
 * A macOS ACL, from `/bin/ls -lde <path>`'s output (strict): the first line is the mode line, every other line one entry
 * ` N: <who> [inherited ]allow|deny <right>[,<right>...]`. Refused: an `allow` entry with any change right, any line that
 * isn't that shape, a right this parser doesn't know, and no output at all. Deny entries pass (every macOS home folder
 * has `group:everyone deny delete`).
 */
export function aclVerdictOf(output: string): AclVerdict {
  const lines = output.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0 || !/^[-dlbcpsw][-rwxsStT]{9}[@+]? /.test(lines[0]!)) return { ok: false, why: "can't be read" };
  for (const line of lines.slice(1)) {
    const entry = /^ \d+: (\S.*?) (?:inherited )?(allow|deny) ([a-z_]+(?:,[a-z_]+)*)$/.exec(line);
    if (entry === null) return { ok: false, why: "can't be read" };
    const rights = entry[3]!.split(",");
    if (rights.some(right => !ACL_RIGHTS.has(right))) return { ok: false, why: "can't be read (an unknown right)" };
    const granted = rights.filter(right => ACL_CHANGE.has(right));
    if (entry[2] === "allow" && granted.length > 0) return { ok: false, why: `allows ${entry[1]} to change it (${granted.join(",")})` };
  }
  return { ok: true };
}

/** The ACL of `path` on macOS: `/bin/ls -lde` by its absolute path (no PATH lookup), C locale; unreadable refuses. Also
 * flexible-answers.ts's check of the catalog's folder. */
export function macAcl(path: string): AclVerdict {
  // A name with a control character could forge an entry line: refused before asking.
  if (/[\u0000-\u001f\u007f]/.test(path)) return { ok: false, why: "can't be read (a control character in the path)" };
  const ran = spawnSync("/bin/ls", ["-lde", "--", path], { encoding: "utf8", timeout: SELF_CHECK_MS, env: { LC_ALL: "C", PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "ignore"] });
  if (ran.status !== 0 || typeof ran.stdout !== "string") return { ok: false, why: "can't be read" };
  return aclVerdictOf(ran.stdout);
}

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
  const name = TUI_PACKAGES[`${input.platform}-${input.arch}`];
  let binary: string;
  let notice: string | undefined;
  if (input.devBinary !== undefined && input.devBinary !== null) {
    if (!isAbsolute(input.devBinary)) return note({ ok: false, why: "--tui-binary needs an absolute path" });
    const trusted = trustedBinary(input.devBinary, uid);
    if (!trusted.ok) return note({ ok: false, why: `--tui-binary ${input.devBinary} can't be trusted: ${trusted.why}` });
    binary = trusted.real;
    notice = `Using your own terminal workbench build at ${binary} (--tui-binary)`;
  } else {
    const fromPackage = name === undefined ? null : installedPackageBinary(root, name);
    const checkout = existsSync(join(root, ".git")) && existsSync(join(root, "tui", "Cargo.toml"));
    const built = join(root, "tui", "target", "release", "toolroll-tui");
    const found = fromPackage ?? (checkout && existsSync(built) ? built : null);
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
