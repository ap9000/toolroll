/**
 * `toolroll doctor`: whether Toolroll's own service holds a credential a build could read.
 *
 * A build runs as the operator's own user. Where no OS fence stops it (any build on Linux, where hidepid hides nothing
 * from the same user; a Codex build anywhere, whose profile can't deny KERN_PROCARGS2; a Claude build without the
 * macOS sandbox) it can read another process's launch arguments and environment: KERN_PROCARGS2 on macOS,
 * /proc/<pid>/environ on Linux. Toolroll's own service is such a process, so its environment must hold no key:
 * provider keys belong in Toolroll's key file (`toolroll keys set`), a tool's secrets on its Tools page, the runner
 * token in its 0600 file.
 *
 * The doctor only reads: each installed service definition (a launchd plist; a systemd unit, its drop-ins and
 * environment files), what `daemon install` would write, the environment a service inherits from its manager
 * (`launchctl getenv`, `systemctl --user show-environment`), and the environment of each running service process.
 * It reports names and where they are, never a value, with the exact steps for the owner. It never edits a unit,
 * moves a key into a file or restarts anything. A key exported in the terminal that starts `toolroll up` keeps
 * working (the ambient fallback); the doctor names it so the owner can choose.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { daemonStatus, installedServiceDefinition, planDaemon, type ServiceDefinition, type SupervisorRunner } from "./daemon.js";
import { scanForSecrets } from "./evidence.js";
import { envelopeJson } from "./envelope.js";
import { run as runCommand } from "./exec.js";
import { OWN_KEY_ENV } from "./keys.js";
import { ALL_CREDENTIAL_ENV } from "./provider.js";

/** Something that holds a credential a build could read, by name only, and what the owner does about it. */
export type DoctorFinding = { where: string; names: string[]; steps: string[] };
/** Something the doctor could not read: never taken for clean. */
export type DoctorUnreadable = { where: string; problem: string; steps: string[] };
export type DoctorReport = { ok: boolean; checked: string[]; findings: DoctorFinding[]; unreadable: DoctorUnreadable[]; notes: string[] };

export type DoctorDeps = {
  platform?: NodeJS.Platform;
  home?: string;
  uid?: number;
  /** Runs the read-only supervisor and process queries (launchctl, systemctl, ps). */
  run?: SupervisorRunner;
  /** Where Linux keeps its process files (a test's stand-in). */
  procRoot?: string;
  /** The doctor's own environment: the terminal a `toolroll up` would start from. */
  env?: NodeJS.ProcessEnv;
};

/** Names that say they hold a credential. */
const CREDENTIAL_NAME = /(?:^|_)(?:API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|SECRET|SECRET_?KEY|TOKEN|AUTH_?TOKEN|PASSWORD|PASSWD|CREDENTIALS?|PAT)(?:_|$)/i;
/** Names that only point at one: a path, a socket, an address. */
const POINTER_NAME = /(?:_FILE|_PATH|_DIR|_SOCK|_URL|_HOST)$/i;
/** Launch flags whose next argument (or `=value`) is a credential. */
const CREDENTIAL_FLAG = /^--?(?:token|api-?key|key|secret|password|auth-token)$/i;
/** Toolroll's own launchd labels, current and from before the rename. */
const LABEL = /^(?:com\.toolroll|com\.standing-orders)\.[A-Za-z0-9._-]+$/;

/** The names among `pairs` that hold a credential: a provider key, a credential-looking name, or a key-shaped value.
 * Values are only tested here and never leave. */
export function credentialNames(pairs: Iterable<readonly [string, string]>): string[] {
  const found = new Set<string>();
  for (const [name, value] of pairs) {
    if (value === "") continue;
    if (ALL_CREDENTIAL_ENV.includes(name) || (CREDENTIAL_NAME.test(name) && !POINTER_NAME.test(name)) || scanForSecrets(value).length > 0) found.add(name);
  }
  return [...found].sort();
}

/** The flags of a launch command that carry a credential inline (`--token <value>`), and arguments that look like a key. */
function commandCredentials(args: readonly string[]): string[] {
  const found = new Set<string>();
  args.forEach((arg, index) => {
    const flag = /^(--?[A-Za-z-]+)=/.exec(arg)?.[1] ?? arg;
    if (CREDENTIAL_FLAG.test(flag) && (arg.includes("=") || index + 1 < args.length)) found.add(`${flag} (command line)`);
    else if (scanForSecrets(arg).length > 0) found.add(`argument ${index + 1} (command line)`);
  });
  return [...found].sort();
}

const unxml = (text: string) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** A plist's EnvironmentVariables and ProgramArguments. */
function plistParts(content: string): { env: [string, string][]; args: string[] } {
  const dict = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(content)?.[1] ?? "";
  const env = [...dict.matchAll(/<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g)].map(match => [unxml(match[1] ?? ""), unxml(match[2] ?? "")] as [string, string]);
  const args = [...(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(content)?.[1] ?? "").matchAll(/<string>([^<]*)<\/string>/g)].map(match => unxml(match[1] ?? ""));
  return { env, args };
}

/** A systemd line's words, its "quotes" undone. */
function systemdWords(line: string): string[] {
  return (line.match(/"(?:[^"\\]|\\.)*"|'[^']*'|\S+/g) ?? []).map(word => word.startsWith('"') ? word.slice(1, -1).replace(/\\(.)/g, "$1") : word.startsWith("'") ? word.slice(1, -1) : word);
}

const assignment = (word: string): [string, string] | null => {
  const at = word.indexOf("=");
  return at <= 0 ? null : [word.slice(0, at), word.slice(at + 1)];
};

/** `NAME=value` lines (an EnvironmentFile, `show-environment`), comments and blanks skipped. */
function envLines(text: string): [string, string][] {
  return text.split("\n").map(line => line.trim()).filter(line => line !== "" && !line.startsWith("#") && !line.startsWith(";"))
    .flatMap(line => { const pair = assignment(line.replace(/^export\s+/, "")); return pair === null ? [] : [[pair[0], pair[1].replace(/^(["'])(.*)\1$/, "$2")] as [string, string]]; });
}

/** A systemd unit's (or drop-in's) Environment= assignments, ExecStart words and EnvironmentFile= paths. */
function systemdParts(content: string): { env: [string, string][]; args: string[]; files: { path: string; optional: boolean }[] } {
  const env: [string, string][] = [];
  const files: { path: string; optional: boolean }[] = [];
  let args: string[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    const value = (key: string) => line.startsWith(`${key}=`) ? line.slice(key.length + 1) : null;
    const environment = value("Environment");
    if (environment !== null) for (const word of systemdWords(environment)) { const pair = assignment(word); if (pair !== null) env.push(pair); }
    const file = value("EnvironmentFile");
    if (file !== null && file.trim() !== "") files.push({ path: file.trim().replace(/^-/, ""), optional: file.trim().startsWith("-") });
    const exec = value("ExecStart");
    if (exec !== null) args = systemdWords(exec.replace(/^[-@:+!]+/, ""));
  }
  return { env, args, files };
}

/** Only understood options may enter remediation. Free-form values are never reflected, even when they
 * look like paths or runner names: any one could actually contain a credential. */
function reinstallCommand(args: readonly string[]): string | null {
  const at = args.indexOf("watch");
  if (at < 0) return null;
  const freeform = new Set(["--runner", "--repo", "--token-file", "--pool", "--model", "--repair-model", "--plan-model"]);
  const numeric = new Set(["--max", "--turns", "--tick-every", "--bridge-every", "--reconcile-every", "--max-open-decisions"]);
  const enums: Record<string, readonly string[]> = {
    "--provider": ["claude", "codex", "gemini", "openrouter", "opencode", "cursor", "cline", "qwen", "goose"],
    "--plan-provider": ["claude", "codex", "gemini", "openrouter"],
    "--containment": ["observed", "preferred", "required"],
  };
  const kept: string[] = [];
  let rejected = false;
  for (let index = at + 1; index < args.length; index += 1) {
    const arg = args[index]!;
    const equal = arg.indexOf("=");
    const flag = equal < 0 ? arg : arg.slice(0, equal);
    const value = equal < 0 ? args[index + 1] : arg.slice(equal + 1);
    const known = freeform.has(flag) || numeric.has(flag) || Object.hasOwn(enums, flag);
    if (equal < 0 && (known || CREDENTIAL_FLAG.test(flag)) && value !== undefined && !value.startsWith("-")) index += 1;
    if (flag === "--token") { kept.push("--token-file", "<set-again>"); continue; }
    if (!known) { rejected = true; continue; }
    const safe = value !== undefined && scanForSecrets(value).length === 0;
    const literal = safe && numeric.has(flag) && /^[0-9]{1,8}$/.test(value) ? String(Number(value))
      : safe ? enums[flag]?.find(candidate => candidate === value) : undefined;
    kept.push(flag, literal ?? "<set-again>");
  }
  if (rejected) kept.push("<set-again>");
  return ["toolroll", "daemon", "install", ...kept].join(" ");
}

function reinstallSteps(command: string): string[] {
  return [
    `Prepare this reinstall command: ${command}`,
    "Replace each <set-again> beside a flag with its non-secret setting. For --token-file, use the path to the runner token file (mode 0600). Unknown or credential arguments were omitted; remove the final standalone placeholder and re-enter only supported non-secret options from `toolroll daemon install --help`. Never put a key or token value in the command.",
    "Save provider keys with `toolroll keys set` and project tool secrets on the project's Tools page before reinstalling. Review the completed command, then run it yourself; nothing has been changed.",
  ];
}

/** One shell word, quoted when it needs to be. */
const quote = (part: string) => /^[A-Za-z0-9@%+=:,./_-]+$/.test(part) ? part : `'${part.replace(/'/g, "'\\''")}'`;

/** Where a provider key goes instead, per provider, or the general home for any other secret. */
function keySteps(names: readonly string[]): string[] {
  const providers = [...new Set(names.flatMap(name => (Object.entries(OWN_KEY_ENV) as [string, readonly string[]][]).filter(([, env]) => env.includes(name)).map(([provider]) => provider)))].sort();
  return [
    ...providers.map(provider => `Keep the ${provider} key in Toolroll instead: \`toolroll keys set ${provider} < <file holding the key>\` (then delete that file).`),
    ...(names.some(name => !(Object.values(OWN_KEY_ENV) as readonly (readonly string[])[]).some(env => env.includes(name)))
      ? ["Set a project tool's secret on that project's Tools page; anything else the service doesn't need can simply go."] : []),
  ];
}

/** Toolroll's installed service definitions on this computer, current and older names alike. */
function installedServices(platform: NodeJS.Platform, home: string): ServiceDefinition[] {
  const dir = platform === "darwin" ? join(home, "Library", "LaunchAgents") : join(home, ".config", "systemd", "user");
  const suffix = platform === "darwin" ? ".plist" : ".service";
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return []; }
  return names.filter(name => name.endsWith(suffix) && LABEL.test(name.slice(0, -suffix.length))).sort()
    .flatMap(name => { const one = installedServiceDefinition({ label: name.slice(0, -suffix.length), platform, home }); return one === null ? [] : [one]; });
}

/** A running process's environment names (never values) that hold a credential: macOS through `ps -E`, which reads
 * KERN_PROCARGS2; Linux from /proc/<pid>/environ. */
export async function processCredentialNames(pid: number, deps: { platform: NodeJS.Platform; run: SupervisorRunner; procRoot?: string }): Promise<{ ok: true; names: string[] } | { ok: false; problem: string }> {
  if (deps.platform === "linux") {
    try {
      const raw = readFileSync(join(deps.procRoot ?? "/proc", String(pid), "environ"), "utf8");
      return { ok: true, names: credentialNames(raw.split("\0").flatMap(entry => { const pair = assignment(entry); return pair === null ? [] : [pair]; })) };
    } catch (error) {
      return { ok: false, problem: `its environment (/proc/${pid}/environ) couldn't be read (${(error as NodeJS.ErrnoException).code ?? "error"})` };
    }
  }
  if (deps.platform === "darwin") {
    const [plain, full] = await Promise.all([
      deps.run("/bin/ps", ["-ww", "-o", "command=", "-p", String(pid)]),
      deps.run("/bin/ps", ["-wwE", "-o", "command=", "-p", String(pid)]),
    ]);
    if (plain.code !== 0 || full.code !== 0 || full.stdout.trim() === "") return { ok: false, problem: `its environment couldn't be read with ps (exit ${full.code})` };
    const command = plain.stdout.replace(/\n$/, ""), whole = full.stdout.replace(/\n$/, "");
    if (command === "" || !whole.startsWith(command) || (whole.length > command.length && whole[command.length] !== " ")) {
      return { ok: false, problem: "the process command changed or its environment boundary is unclear" };
    }
    const tail = whole.slice(command.length).trimStart();
    if (tail === "") return { ok: true, names: [] };
    // ps separates entries with spaces and doesn't quote, so a value with spaces can look like more entries. Read it
    // names-only: every NAME= at the start or after a space is a candidate (a few may be text inside a value, which
    // only ever adds a name to report), each candidate's value runs to the next one, and the whole tail is also scanned
    // for key-shaped text so a secret inside a value is never missed. Fail closed only when nothing parses.
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(tail)) {
      return { ok: false, problem: "ps returned an environment Toolroll couldn't parse" };
    }
    const starts = [...tail.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=/g)].map(m => ({ name: m[1]!, at: m.index! + m[0].length }));
    const pairs = starts.map((one, i) => [one.name, tail.slice(one.at, i + 1 < starts.length ? starts[i + 1]!.at - starts[i + 1]!.name.length - 1 : tail.length).trim()] as const);
    const names = new Set(credentialNames(pairs));
    if (scanForSecrets(tail).length > 0 && names.size === 0) names.add("(a key-shaped value; its variable couldn't be told apart)");
    return { ok: true, names: [...names].sort() };
  }
  return { ok: false, problem: `Toolroll can't read a process's environment on ${deps.platform}` };
}

/** Audit what Toolroll's service holds. Reads only; the report names variables, never their values. */
export async function auditServiceEnvironment(deps: DoctorDeps = {}): Promise<DoctorReport> {
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? homedir();
  const uid = deps.uid ?? (typeof process.getuid === "function" ? process.getuid() : 501);
  const run = deps.run ?? runCommand;
  const report: DoctorReport = { ok: true, checked: [], findings: [], unreadable: [], notes: [] };
  const find = (where: string, names: string[], steps: string[]) => { if (names.length > 0) report.findings.push({ where, names, steps }); };

  // The ambient fallback: a key in this terminal keeps working for a Toolroll started here, and the owner should know
  // that Toolroll would then hold it.
  const ambient = credentialNames(Object.entries(deps.env ?? process.env).filter((pair): pair is [string, string] => ALL_CREDENTIAL_ENV.includes(pair[0]) && typeof pair[1] === "string"));
  if (ambient.length > 0) {
    report.notes.push(`This terminal exports ${ambient.join(", ")}. A Toolroll started from here still uses it when no key is saved, and holds it where a build without the macOS sandbox could read it. ${keySteps(ambient).join(" ")} Then remove the export from your shell profile.`);
  }

  if (platform !== "darwin" && platform !== "linux") {
    report.unreadable.push({ where: `services on ${platform}`, problem: `Toolroll can't check its services on ${platform}`,
      steps: ["Open the service that runs `toolroll watch` and make sure its environment sets no API key, token or password.", ...keySteps([...ALL_CREDENTIAL_ENV])] });
    report.ok = false;
    return report;
  }

  // What `daemon install` writes: planned exactly as install plans it, from this process's own environment.
  const planned = planDaemon({ platform, bin: process.execPath, binArgs: [], runner: "runner", repo: home, configDir: join(home, ".toolroll"), watchFlags: [], home });
  if (!("error" in planned)) {
    const parts = platform === "darwin" ? plistParts(planned.unitContent) : systemdParts(planned.unitContent);
    report.checked.push(`\`toolroll daemon install\` writes ${parts.env.map(([name]) => name).join(", ")} into the service; its runner token stays in a 0600 file.`);
    find("what `toolroll daemon install` writes", [...credentialNames(parts.env), ...commandCredentials(parts.args)],
      ["This is a Toolroll bug: don't reinstall the service until it is fixed, and report it."]);
  }

  const services = installedServices(platform, home);
  report.checked.push(services.length === 0 ? "No Toolroll service is installed." : `Installed services: ${services.map(one => one.label).join(", ")}.`);

  // The environment every service of this login inherits from its manager.
  if (platform === "darwin") {
    const inherited: string[] = [];
    let failed: number | null = null;
    for (const name of ALL_CREDENTIAL_ENV) {
      // An unset name answers exit 0 and nothing; any other exit is a read that didn't happen.
      const answer = await run("launchctl", ["getenv", name]);
      if (answer.code !== 0) failed ??= answer.code;
      else if (answer.stdout.trim() !== "") inherited.push(name);
    }
    if (failed === null) report.checked.push("launchd's environment for your login (launchctl getenv).");
    else if (services.length > 0) {
      report.unreadable.push({ where: "launchd's environment for your login", problem: `launchctl getenv failed (exit ${failed})`,
        steps: [`Run \`launchctl getenv <name>\` yourself for ${ALL_CREDENTIAL_ENV.join(", ")} and check each prints nothing.`] });
    } else report.notes.push("launchd couldn't be asked for your login's environment; a service installed later inherits it.");
    find("launchd's environment for your login, which every service started by launchd inherits", inherited, [
      ...inherited.map(name => `launchctl unsetenv ${name}`),
      `Remove any \`launchctl setenv\` of ${inherited.join(", ")} from your shell profile and login items, so it doesn't come back.`,
      ...keySteps(inherited),
      ...services.map(one => `launchctl kickstart -k gui/${uid}/${one.label}`),
    ]);
  } else {
    const answer = await run("systemctl", ["--user", "show-environment"]);
    if (answer.code === 0) {
      report.checked.push("The systemd user manager's environment (systemctl --user show-environment).");
      const inherited = credentialNames(envLines(answer.stdout));
      find("the systemd user manager's environment, which every user service inherits", inherited, [
        ...inherited.map(name => `systemctl --user unset-environment ${name}`),
        `Remove ${inherited.join(", ")} from ~/.config/environment.d/ and any \`systemctl --user import-environment\` or \`dbus-update-activation-environment\` in your shell profile, so it doesn't come back.`,
        ...keySteps(inherited),
        ...services.map(one => `systemctl --user restart ${one.label}`),
      ]);
    } else if (services.length > 0) {
      report.unreadable.push({ where: "the systemd user manager's environment", problem: `systemctl --user show-environment failed (exit ${answer.code})`,
        steps: ["Run `systemctl --user show-environment` yourself and check it lists no API key, token or password."] });
    } else {
      report.notes.push("The systemd user manager couldn't be asked for its environment; a service installed later inherits it.");
    }
  }

  for (const service of services) {
    const unreadablePlist = platform === "darwin" && (!/<plist\b/.test(service.unitContent) || !/<\/plist>/.test(service.unitContent) || service.unitContent.startsWith("bplist"));
    if (unreadablePlist) {
      report.unreadable.push({ where: `${service.label}'s definition (${service.unitPath})`,
        problem: "this launchd definition is binary or unreadable XML",
        steps: [`Inspect it locally with /usr/bin/plutil -p ${quote(service.unitPath)} and remove credential values before reinstalling; do not share that output.`] });
    }
    if (!unreadablePlist) report.checked.push(`${service.label}: its definition (${service.unitPath}).`);
    const reinstall = reinstallCommand(platform === "darwin" ? plistParts(service.unitContent).args : systemdParts(service.unitContent).args);
    if (platform === "darwin" && !unreadablePlist) {
      const parts = plistParts(service.unitContent);
      const names = credentialNames(parts.env);
      const inline = commandCredentials(parts.args);
      find(`${service.label}'s definition (${service.unitPath})`, [...names, ...inline], [
        ...(reinstall !== null ? reinstallSteps(reinstall)
          : [...names.map(name => `/usr/libexec/PlistBuddy -c ${quote(`Delete :EnvironmentVariables:${name}`)} ${quote(service.unitPath)}`),
            ...(inline.length > 0 ? [`Remove ${inline.join(", ")} from ProgramArguments in ${service.unitPath}.`] : []),
            `launchctl bootout gui/${uid}/${service.label}`, `launchctl bootstrap gui/${uid} ${quote(service.unitPath)}`]),
        ...keySteps(names),
      ]);
    } else if (platform === "linux") {
      const parts = systemdParts(service.unitContent);
      const dropins = `${service.unitPath}.d`;
      let dropinFiles: string[] = [];
      try { dropinFiles = readdirSync(dropins).filter(name => name.endsWith(".conf")).sort().map(name => join(dropins, name)); } catch { dropinFiles = []; }
      const sources: { where: string; env: [string, string][]; args: string[] }[] = [{ where: service.unitPath, env: parts.env, args: parts.args }];
      const envFiles = [...parts.files];
      for (const file of dropinFiles) {
        try { const one = systemdParts(readFileSync(file, "utf8")); sources.push({ where: file, env: one.env, args: one.args }); envFiles.push(...one.files); }
        catch { report.unreadable.push({ where: file, problem: "this drop-in couldn't be read", steps: [`Check ${file} sets no API key, token or password.`] }); }
      }
      for (const file of envFiles) {
        if (file.optional && !existsSync(file.path)) continue;
        try { sources.push({ where: `${file.path} (its EnvironmentFile)`, env: envLines(readFileSync(file.path, "utf8")), args: [] }); }
        catch { report.unreadable.push({ where: file.path, problem: "this environment file couldn't be read", steps: [`Check ${file.path} sets no API key, token or password, or remove its EnvironmentFile= line.`] }); }
      }
      for (const source of sources) {
        const names = credentialNames(source.env);
        const inline = commandCredentials(source.args);
        find(`${service.label}: ${source.where}`, [...names, ...inline], [
          ...(source.where === service.unitPath && reinstall !== null ? reinstallSteps(reinstall)
            : [`Remove ${[...names, ...inline].join(", ")} from ${source.where}.`]),
          ...keySteps(names),
          "systemctl --user daemon-reload", `systemctl --user restart ${service.label}`,
        ]);
      }
    }

    const status = await daemonStatus(service, run);
    if (status.state !== "running") { report.notes.push(`${service.label} isn't running (${status.state}); see its definition check above.`); continue; }
    if (status.pid === null) {
      report.unreadable.push({ where: `${service.label}'s running process`, problem: "its process id is unknown", steps: [platform === "darwin" ? `launchctl print gui/${uid}/${service.label}` : `systemctl --user status ${service.label}`] });
      continue;
    }
    const live = await processCredentialNames(status.pid, { platform, run, ...(deps.procRoot === undefined ? {} : { procRoot: deps.procRoot }) });
    if (!live.ok) {
      report.unreadable.push({ where: `${service.label}'s running process (pid ${status.pid})`, problem: live.problem,
        steps: [platform === "darwin" ? `Run \`ps -wwE -o command= -p ${status.pid}\` yourself and check it shows no API key, token or password.` : `Run \`tr '\\0' '\\n' < /proc/${status.pid}/environ | cut -d= -f1\` yourself and check no name is a key, token or password.`] });
      continue;
    }
    report.checked.push(`${service.label}: its running process (pid ${status.pid}).`);
    find(`${service.label}'s running process (pid ${status.pid})`, live.names, [
      `Find where it got ${live.names.join(", ")}: its definition and its manager's environment are listed above when they hold it; otherwise it was started from a terminal that exports it.`,
      ...keySteps(live.names),
      platform === "darwin" ? `launchctl kickstart -k gui/${uid}/${service.label}` : `systemctl --user restart ${service.label}`,
    ]);
  }

  report.ok = report.findings.length === 0 && report.unreadable.length === 0;
  return report;
}

/** The report as the owner reads it: one state, then each finding with its steps; detail after. */
export function doctorLines(report: DoctorReport): string[] {
  const lines: string[] = [];
  if (report.ok) lines.push("No secrets found in Toolroll's service. A build can't read a key from it.");
  else if (report.findings.length > 0) lines.push(`Toolroll's service holds ${report.findings.length === 1 ? "a secret" : "secrets"} a build could read. Nothing was changed; follow these steps.`);
  else lines.push("Toolroll couldn't check everything, so it can't say the service is clean. Nothing was changed.");
  for (const finding of report.findings) {
    lines.push("", `${finding.where}: ${finding.names.join(", ")}`);
    finding.steps.forEach((step, index) => lines.push(`  ${index + 1}. ${step}`));
  }
  for (const gap of report.unreadable) {
    lines.push("", `Not checked: ${gap.where}: ${gap.problem}.`);
    gap.steps.forEach((step, index) => lines.push(`  ${index + 1}. ${step}`));
  }
  for (const note of report.notes) lines.push("", `Note: ${note}`);
  if (report.checked.length > 0) lines.push("", "Checked:", ...report.checked.map(one => `  ${one}`));
  return lines;
}

export const DOCTOR_HELP = "toolroll doctor [--json]\nChecks that Toolroll's service holds no API key, token or password a build could read: its service definitions, what `daemon install` writes, the environment its manager hands it, and its running process. Reads only: it names what it finds and the steps to fix it, and never changes a file or restarts anything.";

export async function runDoctorCommand(argv: readonly string[], write: (line: string) => void, deps: DoctorDeps = {}): Promise<number> {
  const json = argv.includes("--json");
  if (argv.includes("--help") || argv.includes("-h")) { write(DOCTOR_HELP); return 0; }
  if (argv.some(arg => arg !== "--json")) {
    const message = "Use toolroll doctor [--json].";
    write(json ? envelopeJson({ command: "doctor", ok: false, reason: "usage", message }) : message);
    return 2;
  }
  const report = await auditServiceEnvironment(deps);
  if (json) write(envelopeJson({ command: "doctor", ...report }));
  else for (const line of doctorLines(report)) write(line);
  return report.ok ? 0 : 1;
}
