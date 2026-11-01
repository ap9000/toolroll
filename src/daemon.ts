/**
 * The daemon manager: the loop as a service, with no crontab in sight.
 *
 * `toolroll daemon install` writes the platform's own supervision unit —
 * a launchd LaunchAgent on macOS, a systemd user unit on Linux, a Task
 * Scheduler task on Windows, chosen by process.platform — pointed at
 * `toolroll watch`, and loads it. The OS keeps it alive across crashes
 * and reboots; watch's incarnation recovery is what makes those restarts
 * safe, so the two halves were built for each other.
 *
 * The runner token never enters the unit file. It is written 0600 to a
 * credential file beside the database (the same discipline as the Telegram
 * bot token), and the unit runs `watch --token-file <path>`. A unit file is
 * the kind of thing that ends up in a dotfiles repo; a credential file
 * beside the database is the kind of thing backup tooling already treats
 * as sensitive.
 *
 * The lifecycle (OS containment and login recovery plan) is ONE contract
 * for the CLI daemon and the desktop service, which share the launchd road
 * below:
 *   - an installed always-on controller restarts after an unexpected
 *     clean exit as well as a crash (launchd KeepAlive=true, systemd
 *     Restart=always, a cmd restart loop under Task Scheduler);
 *   - start is idempotent — a healthy running service is never killed
 *     because the installer or the app window ran again;
 *   - a CHANGED definition (runtime, entry, flags) really reloads: the old
 *     job is booted out, its disappearance is awaited (the pending-bootout
 *     race), and the new unit is bootstrapped;
 *   - explicit stop unloads AND disables, so nothing relaunches it until a
 *     person installs again — which re-enables;
 *   - status tells a loaded definition from a fresh working controller,
 *     and names a missing runtime, a missing entry, or a disabled service.
 *
 * Everything here is generation plus one supervisor invocation, both
 * injectable — the tests read the generated unit and script `launchctl`,
 * and never touch the machine's real supervision.
 */

import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ExecResult, RunOptions } from "./exec.js";
import { isAlive } from "./runner.js";
import type { Store } from "./store.js";
import { envTwins } from "./names.js";
import { sleep as defaultSleep } from "./sleep.js";

export type SupervisorRunner = (
  file: string,
  args: readonly string[],
  options?: RunOptions,
) => Promise<ExecResult>;

/** What every installed service — CLI watch or desktop controller — is made of. */
export type ServiceDefinition = {
  platform: "darwin" | "linux" | "win32";
  label: string;
  unitPath: string;
  unitContent: string;
  logPath: string;
  /** The executable the unit runs (the pinned Node binary, or an explicit wrapper). */
  bin: string;
  /** The JavaScript entry the runtime is given, when there is one. */
  entry: string | null;
};

export type DaemonPlan = ServiceDefinition & {
  tokenFile: string;
};

/** A stable fingerprint of a unit's text: the changed-definition test. */
export function definitionDigest(unitContent: string): string {
  return createHash("sha256").update(unitContent).digest("hex").slice(0, 16);
}

/**
 * `launchctl bootout` can return before the old label has disappeared from
 * the user domain. Bootstrapping the replacement during that short window
 * appears to succeed, then the pending bootout removes the new job too. Wait
 * for the observable supervisor boundary before loading the replacement.
 */
async function waitForLaunchdBootout(
  run: SupervisorRunner,
  service: string,
  attempts = 50,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const status = await run("launchctl", ["print", service]);
    if (status.code !== 0) return true;
    await sleep(100);
  }
  return false;
}

/**
 * Pin a service to the Node runtime that is executing Toolroll.
 *
 * launchd does not inherit an interactive shell's PATH, so invoking a JS
 * package bin through `#!/usr/bin/env node` can install successfully and then
 * fail before the CLI starts. The service instead runs the absolute Node
 * binary with the package entry as its first argument. An explicitly supplied
 * non-JavaScript executable remains an escape hatch for wrappers and packaged
 * binaries.
 */
export function daemonLaunchCommand(args: {
  execPath: string;
  entry?: string;
  explicitBin?: string;
}): { bin: string; binArgs: string[] } | null {
  if (args.explicitBin !== undefined) {
    return /\.(?:c|m)?js$/i.test(args.explicitBin)
      ? { bin: args.execPath, binArgs: [args.explicitBin] }
      : { bin: args.explicitBin, binArgs: [] };
  }
  if (args.entry === undefined || /\.(?:c|m)?tsx?$/i.test(args.entry)) return null;
  return { bin: args.execPath, binArgs: [args.entry] };
}

/** One service per repo, named so two repos' watches never collide. */
export function labelFor(repo: string): string {
  return `com.toolroll.watch.${watchSlug(repo)}`;
}

/** The label a watch installed before the rename to Toolroll runs under: still found, stopped and uninstalled. */
export function legacyLabelFor(repo: string): string {
  return `com.standing-orders.watch.${watchSlug(repo)}`;
}

function watchSlug(repo: string): string {
  const slug = repo
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(-40);
  return slug === "" ? "root" : slug;
}

/** The uid launchd's gui domain is keyed by. */
function launchdUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : 501;
}

/**
 * The launchd unit shared by the CLI daemon and the desktop service.
 * KeepAlive requests relaunch after either clean exit or crash. macOS may
 * defer nondemand launches; the desktop's live controller supervisor covers
 * controller exits independently. Login/OS-service recovery requires the
 * physical certification, not just a valid plist.
 */
export function launchdPlist(args: { label: string; command: readonly string[]; workingDirectory: string; pathEnv: string; logPath: string; environment?: Record<string, string>; associatedBundleId?: string; keepAlive?: boolean; startInterval?: number; runAtLoad?: boolean }): string {
  if (args.startInterval !== undefined && (!Number.isSafeInteger(args.startInterval) || args.startInterval < 1)) throw Error("Invalid launchd start interval.");
  if (args.associatedBundleId !== undefined && !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(args.associatedBundleId)) throw new Error("Invalid associated app bundle identifier.");
  const escaped = args.command.map(part => `    <string>${xml(part)}</string>`).join("\n");
  const digest = createHash("sha256").update(JSON.stringify(args));
  // Include executable and package code identity so an update at the same
  // path reloads the service. Files are only read; credentials are excluded.
  for (const file of args.command.slice(0, 2)) {
    try { if (file && existsSync(file)) digest.update(readFileSync(file)); } catch { digest.update("unreadable-runtime"); }
  }
  const entry = args.command[1];
  if (entry?.endsWith(".js")) {
    try { for (const file of readdirSync(dirname(entry)).filter(name => /\.(js|ps1)$/.test(name)).sort()) digest.update(file).update(readFileSync(join(dirname(entry), file))); } catch { digest.update("unreadable-package"); }
  }
  const environment = Object.entries({ PATH: args.pathEnv, ...(args.environment ?? {}), ...envTwins("SERVICE_DIGEST", digest.digest("hex")) })
    .map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(args.label)}</string>
${args.associatedBundleId ? `  <key>AssociatedBundleIdentifiers</key>\n  <array><string>${xml(args.associatedBundleId)}</string></array>` : ""}
  <key>ProgramArguments</key>
  <array>
${escaped}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(args.workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${environment}
  </dict>
  <key>RunAtLoad</key>
  <${args.runAtLoad === false ? "false" : "true"}/>
  <key>KeepAlive</key>
  <${args.keepAlive === false ? "false" : "true"}/>${args.startInterval === undefined ? "" : `\n  <key>StartInterval</key>\n  <integer>${args.startInterval}</integer>`}
  <key>ThrottleInterval</key>
  <integer>15</integer>
  <key>ExitTimeOut</key>
  <integer>60</integer>
  <key>StandardOutPath</key>
  <string>${xml(args.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(args.logPath)}</string>
</dict>
</plist>
`;
}

/**
 * Everything `install` would do, computed without doing it — the unit text,
 * where it goes, where logs land. `--dry-run` prints exactly this.
 */
export function planDaemon(args: {
  platform: NodeJS.Platform;
  bin: string;
  binArgs: readonly string[];
  runner: string;
  repo: string;
  configDir: string;
  watchFlags: readonly string[];
  home?: string;
  /** The interactive installer's executable search path, pinned into the
   * service so logged-in provider CLIs remain discoverable after reboot. */
  pathEnv?: string;
  /** Defaults to labelFor(repo). */
  label?: string;
}): DaemonPlan | { error: string } {
  const { platform, bin, binArgs, runner, repo, configDir, watchFlags } = args;
  const home = args.home ?? homedir();
  const pathEnv = args.pathEnv ?? process.env["PATH"] ?? "";
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") {
    return {
      error: `no supervisor template for ${platform} — run \`toolroll watch\` under your own service manager`,
    };
  }

  const label = args.label ?? labelFor(repo);
  const logDir = join(configDir, "logs");
  const logPath = join(logDir, `${label}.log`);
  const tokenFile = join(configDir, "runner-token");
  const entry = binArgs[0] !== undefined && /\.(?:c|m)?js$/i.test(binArgs[0]) ? binArgs[0] : null;

  const command = [
    bin,
    ...binArgs,
    "watch",
    "--runner",
    runner,
    "--token-file",
    tokenFile,
    "--repo",
    repo,
    ...watchFlags,
  ];

  if (platform === "darwin") {
    return {
      platform,
      label,
      unitPath: join(home, "Library", "LaunchAgents", `${label}.plist`),
      unitContent: launchdPlist({ label, command: [process.execPath, fileURLToPath(new URL("./controller-service.js", import.meta.url)), ...command], workingDirectory: repo, pathEnv, logPath }),
      logPath,
      tokenFile,
      bin,
      entry,
    };
  }

  if (platform === "win32") {
    // Task Scheduler is Windows' launchd: a logon-triggered task, restarted
    // on failure, created from an XML definition — no admin, no Service
    // wrapper. schtasks does not redirect output, so the action runs
    // through cmd with an append redirection into the same log file the
    // other platforms use. RestartOnFailure covers a crash only; a clean
    // exit would end the task, so the action itself is a bounded restart
    // loop (15 s between runs, like ThrottleInterval) — `schtasks /End`
    // (explicit stop) ends the loop's whole tree.
    const inner = [quoteWin(bin), ...binArgs.map(quoteWin), "watch",
      "--runner", quoteWin(runner), "--token-file", quoteWin(tokenFile),
      "--repo", quoteWin(repo), ...watchFlags.map(quoteWin)].join(" ");
    const pathPrefix = pathEnv === "" ? "" : `set "PATH=${pathEnv};%PATH%" && `;
    const cmdArguments = `/d /s /c "${pathPrefix}for /L %i in (1,0,2) do (${inner} >> ${quoteWin(logPath)} 2>&1 & timeout /t 15 /nobreak >nul)"`;
    const unitContent = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>toolroll watch — ${xml(repo)}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Settings>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>cmd.exe</Command>
      <Arguments>${xml(cmdArguments)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
    return {
      platform,
      label,
      unitPath: join(configDir, "daemon", `${label}.xml`),
      unitContent,
      logPath,
      tokenFile,
      bin,
      entry,
    };
  }

  // Restart=always: a clean exit the operator did not ask for comes back
  // too; `systemctl --user stop` / `disable --now` (explicit stop) does
  // not trigger a restart. Whether the user manager itself survives logout
  // is linger (`loginctl enable-linger`) — documented, not assumed.
  const unitContent = `[Unit]
Description=toolroll watch — ${repo}

[Service]
Environment=${systemdEscape(`PATH=${pathEnv}`)}
ExecStart=${command.map(systemdEscape).join(" ")}
WorkingDirectory=${systemdEscape(repo)}
Restart=always
RestartSec=15

StandardOutput=append:${logPath}
StandardError=append:${logPath}

[Install]
WantedBy=default.target
`;
  return {
    platform,
    label,
    unitPath: join(home, ".config", "systemd", "user", `${label}.service`),
    unitContent,
    logPath,
    tokenFile,
    bin,
    entry,
  };
}

/** The desktop shell's always-on controller: the same launchd contract, pointed at the desktop host. */
export function planDesktopService(args: {
  node: string;
  helper: string;
  stateDir: string;
  label: string;
  home?: string;
  pathEnv?: string;
  environment?: Record<string, string>;
  associatedBundleId?: string;
}): ServiceDefinition {
  const home = args.home ?? homedir();
  const logPath = join(args.stateDir, "service.log");
  return {
    platform: "darwin",
    label: args.label,
    unitPath: join(home, "Library", "LaunchAgents", `${args.label}.plist`),
    unitContent: launchdPlist({
      label: args.label,
      command: [args.node, args.helper, "serve", "--state", args.stateDir],
      workingDirectory: args.stateDir,
      pathEnv: args.pathEnv ?? process.env["PATH"] ?? "",
      logPath,
      associatedBundleId: args.associatedBundleId ?? "com.standing-orders.desktop",
      ...(args.environment === undefined ? {} : { environment: args.environment }),
    }),
    logPath,
    bin: args.node,
    entry: args.helper,
  };
}

export type ServiceStart = { ok: true; changed: boolean; action: "bootstrapped" | "reloaded" | "started" | "running" } | { ok: false; message: string };

/** The file on disk does not identify the definition launchd has loaded. */
function loadedLaunchdMatches(unit: string, status: string): boolean {
  // Either name: a unit written before the rename carries only the older one.
  const wanted = /<key>(?:TOOLROLL|STANDING_ORDERS)_SERVICE_DIGEST<\/key>\s*<string>([a-f0-9]{64})<\/string>/.exec(unit)?.[1];
  const actual = /(?:TOOLROLL|STANDING_ORDERS)_SERVICE_DIGEST\s*=>\s*([a-f0-9]{64})/.exec(status)?.[1];
  return wanted !== undefined && actual === wanted;
}

/**
 * The shared launchd road. Idempotent start: a loaded job whose definition
 * is unchanged is kickstarted WITHOUT -k (a running one is left alone; a
 * stopped one starts); a loaded job whose definition changed is booted out,
 * awaited, and bootstrapped afresh; an unloaded label is enabled (an
 * explicit stop had disabled it) and bootstrapped. Nothing here kills a
 * healthy service to prove it can.
 */
export async function installLaunchdService(definition: ServiceDefinition, run: SupervisorRunner): Promise<ServiceStart> {
  const uid = launchdUid();
  const service = `gui/${uid}/${definition.label}`;
  const before = existsSync(definition.unitPath) ? readFileSync(definition.unitPath, "utf8") : null;
  let changed = before !== definition.unitContent;
  mkdirSync(join(definition.logPath, ".."), { recursive: true });
  mkdirSync(join(definition.unitPath, ".."), { recursive: true });
  writeFileDurably(definition.unitPath, definition.unitContent, 0o644);

  const status = await run("launchctl", ["print", service]);
  const loaded = status.code === 0;
  if (loaded) changed ||= !loadedLaunchdMatches(definition.unitContent, status.stdout);
  if (loaded && !changed) {
    const started = await run("launchctl", ["kickstart", service]);
    if (started.code !== 0) return { ok: false, message: `loaded, but launchctl could not start the worker: ${firstLine(started.stderr) || `exit ${started.code}`}` };
    return { ok: true, changed: false, action: "started" };
  }
  if (loaded) {
    const replaced = await run("launchctl", ["bootout", service]);
    if (replaced.code !== 0) return { ok: false, message: `launchctl could not boot out the previous definition: ${firstLine(replaced.stderr) || `exit ${replaced.code}`}` };
    if (!(await waitForLaunchdBootout(run, service))) {
      return { ok: false, message: "launchd did not finish stopping the previous worker; try the install again" };
    }
  }
  // An explicit stop disables the label; installing again is the only road back.
  const enabled = await run("launchctl", ["enable", service]);
  if (enabled.code !== 0) return { ok: false, message: `launchctl could not enable the service: ${firstLine(enabled.stderr) || enabled.code}` };
  const modern = await run("launchctl", ["bootstrap", `gui/${uid}`, definition.unitPath]);
  if (modern.code === 0) {
    // RunAtLoad starts the job; the kickstart (no -k: never a restart) gives
    // the installer a synchronous boundary instead of "the plist parsed".
    const started = await run("launchctl", ["kickstart", service]);
    if (started.code === 0) return { ok: true, changed, action: loaded ? "reloaded" : "bootstrapped" };
    return { ok: false, message: `loaded, but launchctl could not start the worker: ${firstLine(started.stderr) || `exit ${started.code}`}` };
  }
  // Modern first, legacy fallback: `bootstrap` replaced `load` but older
  // macOS answers only to the old verb.
  const legacy = await run("launchctl", ["load", "-w", definition.unitPath]);
  if (legacy.code === 0) return { ok: true, changed, action: loaded ? "reloaded" : "bootstrapped" };
  return { ok: false, message: `launchctl refused the unit: ${firstLine(modern.stderr) || firstLine(legacy.stderr) || `exit ${legacy.code}`}` };
}

/** Replace a file whole: a flushed temporary beside it, renamed over it, and the directory flushed, so a crash
 * leaves the old text or the new, never a torn one. */
export function writeFileDurably(file: string, content: string | Uint8Array, mode = 0o600): void {
  const temp = join(dirname(file), `.${file.slice(dirname(file).length + 1)}.${randomUUID().slice(0, 8)}.tmp`);
  const fd = openSync(temp, "wx", mode);
  try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
  chmodSync(temp, mode);
  renameSync(temp, file);
  if (process.platform !== "win32") { const directory = openSync(dirname(file), "r"); try { fsyncSync(directory); } finally { closeSync(directory); } }
}

/** Explicit stop: unload AND disable, so nothing relaunches it until a person installs again. `waitMs` is how long
 * the job may take to leave launchd (5 s by default; a watch's `toolroll up` can take 45 s to exit). */
export async function stopLaunchdService(definition: ServiceDefinition, run: SupervisorRunner, wait: { waitMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<{ ok: true; wasLoaded: boolean } | { ok: false; message: string }> {
  const service = `gui/${launchdUid()}/${definition.label}`;
  const disabled = await run("launchctl", ["disable", service]);
  if (disabled.code !== 0) return { ok: false, message: `launchctl could not disable ${definition.label}: ${firstLine(disabled.stderr) || disabled.code}` };
  const modern = await run("launchctl", ["bootout", service]);
  if (modern.code !== 0) await run("launchctl", ["unload", definition.unitPath]);
  if (!(await waitForLaunchdBootout(run, service, Math.ceil((wait.waitMs ?? 5000) / 100), wait.sleep))) return { ok: false, message: `launchctl did not stop ${definition.label}; the service is still loaded` };
  return { ok: true, wasLoaded: modern.code === 0 };
}

/**
 * The same repo's watch as installed under the label it had before the
 * rename to Toolroll, when its unit is still on disk; null otherwise.
 * Installing the new one stops and removes it, so two watches never run.
 */
export function installedLegacyDaemon(args: Parameters<typeof planDaemon>[0]): DaemonPlan | null {
  const legacy = planDaemon({ ...args, label: legacyLabelFor(args.repo) });
  return "error" in legacy || !existsSync(legacy.unitPath) ? null : legacy;
}

/**
 * Install the watch, then retire its copy from before the rename. The new
 * job goes in first: when its install fails the legacy watch is left
 * running, so the repo is never left without one. Only once the new job is
 * installed is the legacy one stopped and removed; the new one is then
 * started again, since it may have stepped aside while the legacy watch
 * still held the repo's lease.
 */
export async function installReplacingLegacy(
  plan: DaemonPlan,
  token: string,
  legacy: DaemonPlan | null,
  run: SupervisorRunner,
): Promise<ServiceStart> {
  const installed = await installDaemon(plan, token, run);
  if (!installed.ok || legacy === null) return installed;
  try {
    await uninstallDaemon(legacy, run);
  } catch (error) {
    return { ok: false, message: `installed ${plan.label}, but could not stop ${legacy.label}, the same watch under its older name: ${(error as Error).message}` };
  }
  const restarted = await installDaemon(plan, token, run);
  return restarted.ok ? installed : restarted;
}

/** Write the token 0600 and the unit, then hand the unit to the supervisor. */
export async function installDaemon(
  plan: DaemonPlan,
  token: string,
  run: SupervisorRunner,
): Promise<ServiceStart> {
  writeFileSync(plan.tokenFile, `${token}\n`, { mode: 0o600 });
  chmodSync(plan.tokenFile, 0o600);

  if (plan.platform === "darwin") return installLaunchdService(plan, run);

  const before = existsSync(plan.unitPath) ? readFileSync(plan.unitPath, "utf8") : null;
  const changed = before !== plan.unitContent;
  mkdirSync(join(plan.logPath, ".."), { recursive: true });
  mkdirSync(join(plan.unitPath, ".."), { recursive: true });
  writeFileSync(plan.unitPath, plan.unitContent, { mode: 0o644 });

  if (plan.platform === "win32") {
    // /F replaces an existing definition, so re-install is idempotent. A
    // task already running under an UNCHANGED definition is left alone; a
    // changed one is ended and run again so the new action takes effect.
    const created = await run("schtasks", ["/Create", "/TN", plan.label, "/XML", plan.unitPath, "/F"]);
    if (created.code !== 0) {
      return { ok: false, message: `schtasks /Create failed: ${firstLine(created.stderr) || `exit ${created.code}`}` };
    }
    const query = await run("schtasks", ["/Query", "/TN", plan.label, "/FO", "LIST", "/V"]);
    const running = query.code === 0 && /Status:\s*Running/i.test(query.stdout);
    if (running && !changed) return { ok: true, changed: false, action: "running" };
    if (running) await run("schtasks", ["/End", "/TN", plan.label]);
    const started = await run("schtasks", ["/Run", "/TN", plan.label]);
    if (started.code !== 0) {
      return { ok: false, message: `created, but schtasks /Run failed: ${firstLine(started.stderr)}` };
    }
    return { ok: true, changed, action: running ? "reloaded" : "started" };
  }

  const reload = await run("systemctl", ["--user", "daemon-reload"]);
  if (reload.code !== 0) {
    return { ok: false, message: `systemctl daemon-reload failed: ${firstLine(reload.stderr)}` };
  }
  const active = (await run("systemctl", ["--user", "is-active", plan.label])).stdout.trim() === "active";
  if (active && changed) {
    // `enable --now` leaves a running service on its OLD definition; only a
    // restart loads the new one.
    const restarted = await run("systemctl", ["--user", "restart", plan.label]);
    if (restarted.code !== 0) return { ok: false, message: `systemctl restart failed: ${firstLine(restarted.stderr)}` };
  }
  const enable = await run("systemctl", ["--user", "enable", "--now", plan.label]);
  if (enable.code !== 0) {
    return { ok: false, message: `systemctl enable failed: ${firstLine(enable.stderr)}` };
  }
  return { ok: true, changed, action: active ? (changed ? "reloaded" : "running") : "started" };
}

export async function uninstallDaemon(
  plan: DaemonPlan,
  run: SupervisorRunner,
): Promise<{ ok: true; existed: boolean }> {
  if (plan.platform === "darwin") {
    const stopped = await stopLaunchdService(plan, run);
    if (!stopped.ok) throw new Error(stopped.message);
  } else if (plan.platform === "win32") {
    await run("schtasks", ["/End", "/TN", plan.label]);
    await run("schtasks", ["/Delete", "/TN", plan.label, "/F"]);
  } else {
    await run("systemctl", ["--user", "disable", "--now", plan.label]);
  }
  let existed = true;
  try {
    rmSync(plan.unitPath);
  } catch {
    existed = false;
  }
  return { ok: true, existed };
}

/**
 * The definition a label is INSTALLED under, read back from the unit file
 * (the certificate's view: whatever is on disk is the baseline, so `stale`
 * is false by construction and the runtime/entry are the installed ones).
 * Null when no unit file exists for the label.
 */
export function installedServiceDefinition(args: { label: string; platform?: NodeJS.Platform; home?: string; configDir?: string; logPath?: string }): ServiceDefinition | null {
  const platform = args.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") return null;
  const home = args.home ?? homedir();
  const unitPath =
    platform === "darwin" ? join(home, "Library", "LaunchAgents", `${args.label}.plist`)
      : platform === "linux" ? join(home, ".config", "systemd", "user", `${args.label}.service`)
        : join(args.configDir ?? home, "daemon", `${args.label}.xml`);
  if (!existsSync(unitPath)) return null;
  const unitContent = readFileSync(unitPath, "utf8");
  let bin = "";
  let entry: string | null = null;
  if (platform === "darwin") {
    const strings = [...(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(unitContent)?.[1] ?? "").matchAll(/<string>([^<]*)<\/string>/g)].map(match => unxml(match[1] ?? ""));
    bin = strings[0] ?? "";
    entry = strings[1] !== undefined && /\.(?:c|m)?js$/i.test(strings[1]) ? strings[1] : null;
  } else if (platform === "linux") {
    const exec = /^ExecStart=(.*)$/m.exec(unitContent)?.[1] ?? "";
    const parts = exec.match(/"(?:[^"\\]|\\.)*"|\S+/g)?.map(part => part.startsWith('"') ? part.slice(1, -1).replace(/\\(["\\])/g, "$1") : part) ?? [];
    bin = parts[0] ?? "";
    entry = parts[1] !== undefined && /\.(?:c|m)?js$/i.test(parts[1]) ? parts[1] : null;
  }
  const logPath = args.logPath ?? (/<key>StandardOutPath<\/key>\s*<string>([^<]*)<\/string>/.exec(unitContent)?.[1] ?? /^StandardOutput=append:(.*)$/m.exec(unitContent)?.[1] ?? "");
  return { platform, label: args.label, unitPath, unitContent, logPath: unxml(logPath), bin, entry };
}

function unxml(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

export type ServiceStatus = {
  /** `loaded` = the supervisor knows the definition but no process runs;
   * `disabled` = an explicit stop turned it off. Neither is "working". */
  state: "running" | "loaded" | "disabled" | "not-installed";
  pid: number | null;
  detail: string;
  /** Diagnostics a person can act on: a missing runtime, a missing entry. */
  problems: string[];
  /** The installed unit's fingerprint, or null when no unit file exists. */
  installedDigest: string | null;
  /** Whether the installed unit still matches what this build would write. */
  stale: boolean;
};

/** Runtime facts that make a loaded definition unable to become a working controller. */
export function runtimeProblems(definition: ServiceDefinition): string[] {
  const problems: string[] = [];
  if (!existsSync(definition.bin)) problems.push(`the service's runtime ${definition.bin} does not exist — reinstall to pin the current Node binary`);
  if (definition.entry !== null && !existsSync(definition.entry)) problems.push(`the service's entry ${definition.entry} does not exist — reinstall from the current package`);
  return problems;
}

export async function daemonStatus(
  plan: ServiceDefinition,
  run: SupervisorRunner,
): Promise<ServiceStatus> {
  const problems = runtimeProblems(plan);
  const installed = existsSync(plan.unitPath) ? readFileSync(plan.unitPath, "utf8") : null;
  const facts = { problems, installedDigest: installed === null ? null : definitionDigest(installed), stale: installed !== null && installed !== plan.unitContent };
  if (plan.platform === "darwin") {
    const service = `gui/${launchdUid()}/${plan.label}`;
    const answer = await run("launchctl", ["print", service]);
    if (answer.code !== 0) {
      const disabled = await run("launchctl", ["print-disabled", `gui/${launchdUid()}`]);
      const pattern = new RegExp(`"${plan.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*=>\\s*(disabled|true)`);
      if (disabled.code === 0 && pattern.test(disabled.stdout)) {
        return { state: "disabled", pid: null, detail: "disabled by an explicit stop; install again to re-enable", ...facts };
      }
      return { state: "not-installed", pid: null, detail: "launchd does not know the label", ...facts };
    }
    facts.stale ||= !loadedLaunchdMatches(plan.unitContent, answer.stdout);
    const pid = /pid = (\d+)/.exec(answer.stdout)?.[1];
    return pid === undefined
      ? { state: "loaded", pid: null, detail: "loaded, not currently running", ...facts }
      : { state: "running", pid: Number(pid), detail: `running as pid ${pid}`, ...facts };
  }
  if (plan.platform === "win32") {
    const answer = await run("schtasks", ["/Query", "/TN", plan.label, "/FO", "LIST", "/V"]);
    if (answer.code !== 0) {
      return { state: "not-installed", pid: null, detail: "the scheduler does not know the task", ...facts };
    }
    if (/Status:\s*Running/i.test(answer.stdout)) return { state: "running", pid: null, detail: "running (Task Scheduler does not expose the pid)", ...facts };
    if (/Status:\s*Disabled/i.test(answer.stdout) || /Scheduled Task State:\s*Disabled/i.test(answer.stdout)) {
      return { state: "disabled", pid: null, detail: "the task is disabled", ...facts };
    }
    return { state: "loaded", pid: null, detail: "installed, not currently running", ...facts };
  }

  const answer = await run("systemctl", ["--user", "is-active", plan.label]);
  const active = answer.stdout.trim() === "active";
  if (answer.code !== 0 && !active) {
    const enabled = await run("systemctl", ["--user", "is-enabled", plan.label]);
    const word = enabled.stdout.trim();
    if (word === "disabled") return { state: "disabled", pid: null, detail: "disabled by an explicit stop; install again to re-enable", ...facts };
    if (word === "enabled" || word === "linked") return { state: "loaded", pid: null, detail: answer.stdout.trim() || "inactive", ...facts };
    return { state: "not-installed", pid: null, detail: answer.stdout.trim() || "inactive", ...facts };
  }
  const pidAnswer = await run("systemctl", ["--user", "show", "--property=MainPID", plan.label]);
  const pid = Number(/MainPID=(\d+)/.exec(pidAnswer.stdout)?.[1] ?? 0);
  return active
    ? { state: "running", pid: pid > 0 ? pid : null, detail: "active", ...facts }
    : { state: "loaded", pid: null, detail: "installed, inactive", ...facts };
}

/**
 * A supervisor PID is necessary but not sufficient: macOS can leave a
 * process stuck behind a protected-folder access check before it ever
 * opens the queue. The credentialed runner heartbeat is the end-to-end
 * readiness receipt that proves a service reached the work loop — and a
 * FRESH one, newer than what stood before the start, so a stale row from
 * the previous incarnation cannot pass for the new controller.
 */
export async function awaitFreshHeartbeat(
  store: Store,
  runnerName: string,
  heartbeatBefore: string | null,
  deadlineMs = 5_000,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<{ ok: true; heartbeatAt: string } | { ok: false }> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const live = store.getRunner(runnerName)?.runner ?? null;
    if (live !== null && live.heartbeatAt !== heartbeatBefore && isAlive(live, new Date())) return { ok: true, heartbeatAt: live.heartbeatAt };
    if (Date.now() >= deadline) return { ok: false };
    await sleep(100);
  }
}

function xml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** cmd.exe quoting: wrap anything with spaces; embedded quotes are not survivable in cmd — refuse them upstream by construction (paths and flags here never carry them). */
function quoteWin(part: string): string {
  return /[\s&|<>^]/.test(part) ? `"${part}"` : part;
}

function systemdEscape(part: string): string {
  return /[\s"'\\]/.test(part) ? `"${part.replace(/(["\\])/g, "\\$1")}"` : part;
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}
