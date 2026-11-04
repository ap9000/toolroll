/**
 * The laptop-mode login item, generated and compared — never installed.
 *
 * Laptop mode keeps one `toolroll up --laptop` console running for the
 * person who is logged in: a launchd LaunchAgent on macOS
 * (~/Library/LaunchAgents/com.toolroll.up.plist), a systemd user unit on
 * Linux (~/.config/systemd/user/toolroll-up.service). This module only
 * computes what that definition would be, whether an installed one matches,
 * and which existing services would conflict with it. Nothing here writes a
 * unit, loads one, or calls launchctl or systemctl; the handoff that does
 * (`toolroll background on`) is a later wave.
 *
 * The command is pinned with absolute paths, as daemon.ts pins its services:
 * launchd and systemd do not inherit an interactive shell's PATH, so the unit
 * runs the absolute Node binary with the package entry, and the database is
 * the canonical path (realpath of its folder) so a symlinked folder and its
 * target are one database. Values with control characters are refused: a
 * newline would end a systemd line and a NUL cannot appear in either format.
 *
 * Conflicts are reported, never touched: the desktop/browser service
 * (com.toolroll.browser, and com.standing-orders.browser from before the
 * rename) and any `daemon install` watch whose unit points at the same
 * database. Whatever cannot be read counts as a conflict, so the caller asks
 * instead of assuming.
 */

import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
// POSIX paths throughout: a LaunchAgent and a systemd unit only ever name POSIX paths.
import { posix } from "node:path";
import { definitionDigest, launchdPlist } from "./daemon.js";

const { basename, dirname, isAbsolute, join } = posix;

export const LAPTOP_LABEL_DARWIN = "com.toolroll.up";
export const LAPTOP_LABEL_LINUX = "toolroll-up";

/** The services laptop mode never runs beside on macOS: the desktop app's browser controller, either name. */
export const BROWSER_SERVICE_LABELS = ["com.toolroll.browser", "com.standing-orders.browser"] as const;

/** The watch labels daemon.ts writes (labelFor / legacyLabelFor). */
const WATCH_PREFIXES = ["com.toolroll.watch.", "com.standing-orders.watch."] as const;

export type LaptopServiceDefinition = {
  platform: "darwin" | "linux";
  label: string;
  /** Where the unit file goes. */
  path: string;
  /** The unit file's exact text. */
  text: string;
  /** definitionDigest(text): equal digests mean installing again is a no-op. */
  digest: string;
  /** The pinned command, argument by argument. */
  command: string[];
  /** The canonical database path baked into the command. */
  db: string;
  logPath: string;
};

/** Seam over the few filesystem reads this module makes; tests pass a temp HOME instead of the real one. */
export type LaptopServiceFs = {
  exists: (path: string) => boolean;
  readFile: (path: string) => string;
  readdir: (path: string) => string[];
  realpath: (path: string) => string;
};

export const nodeFs: LaptopServiceFs = {
  exists: existsSync,
  readFile: path => readFileSync(path, "utf8"),
  readdir: path => readdirSync(path),
  realpath: path => realpathSync(path),
};

// Every C0 control character and DEL: newline and NUL are the dangerous ones,
// the rest are never part of a real path and are not valid XML 1.0 either.
const CONTROL = /[\u0000-\u001f\u007f]/;

function checkPath(name: string, value: string): string | null {
  if (value === "") return `${name} is empty`;
  if (CONTROL.test(value)) return `${name} contains a newline, NUL or other control character`;
  if (!isAbsolute(value)) return `${name} must be an absolute path (got ${value})`;
  return null;
}

/**
 * The database path the unit names: its folder resolved through realpath,
 * its file name kept (the file may not exist yet). A relative, empty or
 * control-character path, or a folder that cannot be resolved, refuses.
 */
export function canonicalDatabasePath(db: string, fs: Pick<LaptopServiceFs, "realpath"> = nodeFs): string | { error: string } {
  const problem = checkPath("the database path", db);
  if (problem !== null) return { error: problem };
  const name = basename(db);
  if (db.endsWith("/") || name === "" || name === "." || name === "..") return { error: `the database path ${db} does not name a file` };
  let folder: string;
  try { folder = fs.realpath(dirname(db)); } catch { return { error: `the database folder ${dirname(db)} cannot be resolved` }; }
  const canonical = join(folder, name);
  const after = checkPath("the database path", canonical);
  return after === null ? canonical : { error: after };
}

function unitPathFor(platform: "darwin" | "linux", home: string): { label: string; path: string } {
  return platform === "darwin"
    ? { label: LAPTOP_LABEL_DARWIN, path: join(home, "Library", "LaunchAgents", `${LAPTOP_LABEL_DARWIN}.plist`) }
    : { label: LAPTOP_LABEL_LINUX, path: join(home, ".config", "systemd", "user", `${LAPTOP_LABEL_LINUX}.service`) };
}

/**
 * The login item for laptop mode, computed without writing anything. On
 * macOS the text comes from daemon.ts's launchdPlist, so it carries the same
 * KeepAlive/ExitTimeOut contract and the same service digest (which binds the
 * runtime's and package's code, read only). On Linux it is a systemd user
 * unit in daemon.ts's shape, with systemd's `%` and `$` expansion escaped.
 */
export function laptopServiceDefinition(args: {
  platform: NodeJS.Platform;
  home: string;
  /** The absolute Node binary the unit runs. */
  node: string;
  /** The absolute package `dist` folder; the unit runs `<dist>/bin.js`. */
  dist: string;
  db: string;
  port: number;
  /** The executable search path pinned into the unit (daemon.ts's approach); defaults to this process's PATH. */
  pathEnv?: string;
  fs?: Pick<LaptopServiceFs, "realpath">;
}): LaptopServiceDefinition | { error: string } {
  const { platform } = args;
  if (platform !== "darwin" && platform !== "linux") return { error: `laptop mode has no login item for ${platform}; keep \`toolroll up\` running yourself` };
  for (const [name, value] of [["the home folder", args.home], ["the Node binary", args.node], ["the package folder", args.dist]] as const) {
    const problem = checkPath(name, value);
    if (problem !== null) return { error: problem };
  }
  if (!Number.isSafeInteger(args.port) || args.port < 1 || args.port > 65535) return { error: `the port must be a whole number from 1 to 65535 (got ${args.port})` };
  const pathEnv = args.pathEnv ?? process.env["PATH"] ?? "";
  if (CONTROL.test(pathEnv)) return { error: "the PATH contains a newline, NUL or other control character" };
  const db = canonicalDatabasePath(args.db, args.fs ?? nodeFs);
  if (typeof db !== "string") return db;

  const entry = join(args.dist, "bin.js");
  const command = [args.node, entry, "up", "--laptop", "--no-open", "--db", db, "--port", String(args.port)];
  const stateDir = dirname(db);
  const { label, path } = unitPathFor(platform, args.home);
  const logPath = join(stateDir, "logs", `${label}.log`);

  const text = platform === "darwin"
    ? launchdPlist({ label, command, workingDirectory: stateDir, pathEnv, logPath })
    : systemdUnit({ command, workingDirectory: stateDir, pathEnv, logPath });
  return { platform, label, path, text, digest: definitionDigest(text), command, db, logPath };
}

/**
 * The systemd user unit: daemon.ts's watch unit shape (Restart=always,
 * default.target) plus TimeoutStopSec=60, launchd's ExitTimeOut, so a stop
 * gets the same drain window on both platforms.
 */
function systemdUnit(args: { command: readonly string[]; workingDirectory: string; pathEnv: string; logPath: string }): string {
  return `[Unit]
Description=toolroll laptop console

[Service]
Environment=${systemdQuote(`PATH=${args.pathEnv}`, false)}
ExecStart=${args.command.map(part => systemdQuote(part, true)).join(" ")}
WorkingDirectory=${systemdSpecifiers(args.workingDirectory)}
Restart=always
RestartSec=15
TimeoutStopSec=60

StandardOutput=append:${systemdSpecifiers(args.logPath)}
StandardError=append:${systemdSpecifiers(args.logPath)}

[Install]
WantedBy=default.target
`;
}

/** `%` starts a specifier in every systemd setting. */
function systemdSpecifiers(text: string): string {
  return text.replace(/%/g, "%%");
}

/**
 * daemon.ts's quoting (double quotes around anything with whitespace,
 * quotes or backslashes; `"` and `\` escaped), plus `%%` everywhere and, in
 * a command line, `$$`, since ExecStart expands `$NAME`.
 */
function systemdQuote(part: string, command: boolean): string {
  let text = systemdSpecifiers(part);
  if (command) text = text.replace(/\$/g, "$$$$");
  return /[\s"'\\]/.test(text) || text === "" ? `"${text.replace(/(["\\])/g, "\\$1")}"` : text;
}

/** Whether an installed unit's text is exactly this definition. Null (or undefined) text means no unit is installed. */
export function compareInstalled(existingText: string | null | undefined, definition: Pick<LaptopServiceDefinition, "text" | "digest">): "same" | "different" | "absent" {
  if (existingText === null || existingText === undefined) return "absent";
  return existingText === definition.text && definitionDigest(existingText) === definition.digest ? "same" : "different";
}

export type LaptopConflict = {
  kind: "browser" | "watch";
  label: string;
  path: string;
  /** Plain words for the person who will be asked. */
  reason: string;
};

/**
 * Existing services laptop mode must not run beside: the browser service on
 * macOS (whatever database it uses — it is a console of its own), and any
 * daemon.ts watch whose unit points at this database, by `--db` or by its
 * `--token-file` sitting in the database's folder (daemon install keeps the
 * runner token beside the database it was installed from). A unit that
 * cannot be read is listed too. Laptop mode's own unit is never a conflict.
 */
export function detectOtherServices(args: {
  platform: NodeJS.Platform;
  home: string;
  db: string;
  fs?: LaptopServiceFs;
}): LaptopConflict[] | { error: string } {
  const fs = args.fs ?? nodeFs;
  if (args.platform !== "darwin" && args.platform !== "linux") return [];
  const homeProblem = checkPath("the home folder", args.home);
  if (homeProblem !== null) return { error: homeProblem };
  const db = canonicalDatabasePath(args.db, fs);
  if (typeof db !== "string") return db;

  const conflicts: LaptopConflict[] = [];
  const darwin = args.platform === "darwin";
  const folder = darwin ? join(args.home, "Library", "LaunchAgents") : join(args.home, ".config", "systemd", "user");
  const suffix = darwin ? ".plist" : ".service";

  if (darwin) {
    for (const label of BROWSER_SERVICE_LABELS) {
      const path = join(folder, `${label}${suffix}`);
      if (fs.exists(path)) conflicts.push({ kind: "browser", label, path, reason: `the Toolroll app's service ${label} is installed` });
    }
  }

  let names: string[] = [];
  try { if (fs.exists(folder)) names = fs.readdir(folder); } catch { return { error: `${folder} cannot be listed` }; }
  for (const name of [...names].sort()) {
    if (!name.endsWith(suffix) || !WATCH_PREFIXES.some(prefix => name.startsWith(prefix))) continue;
    const label = name.slice(0, -suffix.length);
    const path = join(folder, name);
    let text: string;
    try { text = fs.readFile(path); } catch {
      conflicts.push({ kind: "watch", label, path, reason: `the watch ${label} could not be read, so it may use this database` });
      continue;
    }
    const argv = darwin ? plistProgramArguments(text) : systemdExecStart(text);
    const target = watchDatabase(argv, fs);
    if (target === "unknown") {
      conflicts.push({ kind: "watch", label, path, reason: `the watch ${label} does not say which database it uses` });
    } else if (target.db !== undefined ? target.db === db : target.folder === dirname(db)) {
      conflicts.push({ kind: "watch", label, path, reason: `the watch ${label} runs on this database` });
    }
  }
  return conflicts;
}

/** Which database a watch's command line names: its `--db`, else the folder of its `--token-file`. */
function watchDatabase(argv: readonly string[], fs: Pick<LaptopServiceFs, "realpath">): { db?: string; folder?: string } | "unknown" {
  const value = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    if (at >= 0) return argv[at + 1];
    return argv.find(part => part.startsWith(`${flag}=`))?.slice(flag.length + 1);
  };
  const dbFlag = value("--db");
  if (dbFlag !== undefined) {
    const db = canonicalDatabasePath(dbFlag, fs);
    return typeof db === "string" ? { db } : "unknown";
  }
  const tokenFile = value("--token-file");
  if (tokenFile === undefined || !isAbsolute(tokenFile)) return "unknown";
  try { return { folder: fs.realpath(dirname(tokenFile)) }; } catch { return { folder: dirname(tokenFile) }; }
}

/** ProgramArguments from a plist daemon.ts wrote. */
function plistProgramArguments(text: string): string[] {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? "";
  return [...array.matchAll(/<string>([^<]*)<\/string>/g)].map(match => unxml(match[1] ?? ""));
}

/** ExecStart from a systemd unit, split as systemd would for the quoting daemon.ts and this module write. */
function systemdExecStart(text: string): string[] {
  const line = /^ExecStart=(.*)$/m.exec(text)?.[1] ?? "";
  return (line.match(/"(?:[^"\\]|\\.)*"|\S+/g) ?? []).map(part =>
    (part.startsWith('"') ? part.slice(1, -1).replace(/\\(["\\])/g, "$1") : part).replace(/%%/g, "%").replace(/\$\$/g, "$"));
}

function unxml(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
