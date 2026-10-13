/**
 * `toolroll doctor`: Toolroll's service must hold no credential a build could read. Each case plants synthetic
 * markers where a key could hide (a definition, a drop-in, an environment file, the manager's environment, the live
 * process) and holds the doctor to naming every one, never a value, with the owner's steps, and changing nothing.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditServiceEnvironment, credentialNames, doctorLines, processCredentialNames, runDoctorCommand } from "./doctor.js";
import { planDaemon, planDesktopService, type SupervisorRunner } from "./daemon.js";
import { run as runCommand } from "./exec.js";

const marker = (what: string) => ["doctor", what, "5f".repeat(12)].join("-");
const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };

let home: string;
beforeEach(() => { home = realpathSync(mkdtempSync(join(tmpdir(), "so-doctor-"))); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** Every file under `dir` with its bytes and mtime: what "changed nothing" is checked against. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[path] = `${statSync(path).mtimeMs}:${readFileSync(path, "utf8")}`;
    }
  };
  walk(dir);
  return out;
}

/** A supervisor that answers from a table and records every call; anything unexpected fails the read. */
function supervisor(answers: (file: string, args: readonly string[]) => { code: number; stdout: string } | undefined): { run: SupervisorRunner; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    run: async (file, args) => {
      calls.push([file, ...args].join(" "));
      const answer = answers(file, args);
      return answer === undefined ? { ...OK, code: 1 } : { ...OK, ...answer };
    },
  };
}

/** What a read may run: launchd, systemd and ps queries, nothing that loads, starts, sets or edits. */
const READ_ONLY = /^(?:launchctl (?:getenv|print|print-disabled)|systemctl --user (?:show-environment|is-active|is-enabled|show)|\/bin\/ps)(?: |$)/;

describe("what Toolroll writes into a service", () => {
  test("daemon install and the desktop service capture no credential from the installer's environment", () => {
    const secrets = { ANTHROPIC_API_KEY: marker("install-anthropic"), NOTES_TOKEN: marker("install-notes"), OPENAI_API_KEY: marker("install-openai") };
    const saved = { ...process.env };
    Object.assign(process.env, secrets);
    try {
      const units = [
        ...(["darwin", "linux"] as const).map(platform => planDaemon({ platform, bin: process.execPath, binArgs: [], runner: "r", repo: home, configDir: join(home, ".toolroll"), watchFlags: ["--pool", "2"], home })),
        planDesktopService({ node: process.execPath, helper: join(home, "host.js"), stateDir: home, label: "com.standing-orders.desktop", home }),
      ];
      for (const unit of units) {
        if ("error" in unit) throw new Error(unit.error);
        for (const value of Object.values(secrets)) expect(unit.unitContent).not.toContain(value);
      }
    } finally {
      for (const name of Object.keys(secrets)) delete process.env[name];
      Object.assign(process.env, saved);
    }
  });

  test("names, not values: a provider key, a credential-looking name and a key-shaped value count; paths and plumbing don't", () => {
    expect(credentialNames([
      ["ANTHROPIC_API_KEY", marker("a")], ["NOTES_TOKEN", "x"], ["DB_PASSWORD", "x"], ["HARMLESS", `ghp_${"A".repeat(36)}`],
      ["PATH", "/bin"], ["GOOGLE_APPLICATION_CREDENTIALS_FILE", "/k.json"], ["SSH_AUTH_SOCK", "/tmp/s"], ["TOOLROLL_SERVICE_DIGEST", "ab"], ["EMPTY_TOKEN", ""],
    ])).toEqual(["ANTHROPIC_API_KEY", "DB_PASSWORD", "HARMLESS", "NOTES_TOKEN"]);
  });
});

describe("toolroll doctor on macOS", () => {
  const label = "com.toolroll.watch.shop";
  const plist = (env: Record<string, string>, args: string[]) => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>${args.map(arg => `<string>${arg}</string>`).join("")}</array>
  <key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${k}</key><string>${v}</string>`).join("")}</dict>
  <key>StandardOutPath</key><string>/tmp/x.log</string>
</dict></plist>`;

  test("names every secret the service could hand a build, with the owner's exact steps, and changes nothing", async () => {
    const values = { unit: marker("unit-anthropic"), tool: marker("unit-notes"), inline: marker("inline-token"), inherited: marker("launchd-openai"), live: marker("live-gemini") };
    const agents = join(home, "Library", "LaunchAgents");
    mkdirSync(agents, { recursive: true });
    const unitPath = join(agents, `${label}.plist`);
    writeFileSync(unitPath, plist({ PATH: "/usr/bin:/bin", ANTHROPIC_API_KEY: values.unit, NOTES_TOKEN: values.tool },
      ["/usr/local/bin/node", "/app/controller-service.js", "/usr/local/bin/node", "/app/cli.js", "watch", "--runner", "shop", "--token", values.inline, "--repo", "/work/shop"]));
    writeFileSync(join(agents, "com.example.other.plist"), plist({ OTHER_TOKEN: marker("not-ours") }, ["/bin/true"]));
    const before = snapshot(home);
    const { run, calls } = supervisor((file, args) => {
      if (file === "launchctl" && args[0] === "getenv") return args[1] === "OPENAI_API_KEY" ? { code: 0, stdout: `${values.inherited}\n` } : { code: 0, stdout: "\n" };
      if (file === "launchctl" && args[0] === "print") return { code: 0, stdout: "state = running\n\tpid = 4242\n" };
      if (file === "/bin/ps" && args[0] === "-ww") return { code: 0, stdout: "/usr/local/bin/node /app/controller-service.js watch\n" };
      if (file === "/bin/ps") return { code: 0, stdout: `/usr/local/bin/node /app/controller-service.js watch GEMINI_API_KEY=${values.live} with spaces\n` };
      return undefined;
    });
    const lines: string[] = [];
    const code = await runDoctorCommand([], line => lines.push(line), { platform: "darwin", home, uid: 501, run, env: {} });
    const json: string[] = [];
    await runDoctorCommand(["--json"], line => json.push(line), { platform: "darwin", home, uid: 501, run, env: {} });
    expect(code).toBe(1);
    const text = lines.join("\n");
    for (const output of [text, json.join("\n")]) for (const value of Object.values(values)) expect(output).not.toContain(value);
    expect(lines[0]).toBe("Toolroll's service holds secrets a build could read. Nothing was changed; follow these steps.");
    const report = JSON.parse(json[0]!) as { ok: boolean; findings: { where: string; names: string[]; steps: string[] }[] };
    expect(report.ok).toBe(false);
    expect(report.findings.map(one => [one.where, one.names])).toEqual([
      ["launchd's environment for your login, which every service started by launchd inherits", ["OPENAI_API_KEY"]],
      [`${label}'s definition (${unitPath})`, ["ANTHROPIC_API_KEY", "NOTES_TOKEN", "--token (command line)"]],
      [`${label}'s running process (pid 4242)`, ["GEMINI_API_KEY"]],
    ]);
    const [inherited, definition, live] = report.findings;
    expect(inherited!.steps).toEqual(expect.arrayContaining(["launchctl unsetenv OPENAI_API_KEY", `launchctl kickstart -k gui/501/${label}`,
      "Keep the codex key in Toolroll instead: `toolroll keys set codex < <file holding the key>` (then delete that file)."]));
    // A watch is rewritten by its own installer, from the flags its definition carries; the inline token becomes its file.
    expect(definition!.steps[0]).toBe("Prepare this reinstall command: toolroll daemon install --runner <set-again> --token-file <set-again> --repo <set-again>");
    expect(definition!.steps).toEqual(expect.arrayContaining(["Keep the claude key in Toolroll instead: `toolroll keys set claude < <file holding the key>` (then delete that file).",
      "Set a project tool's secret on that project's Tools page; anything else the service doesn't need can simply go."]));
    expect(live!.steps.at(-1)).toBe(`launchctl kickstart -k gui/501/${label}`);
    // Read only: no other label was looked at, nothing was loaded, set or written.
    expect(text).not.toContain("com.example.other");
    expect(calls.filter(call => !READ_ONLY.test(call))).toEqual([]);
    expect(snapshot(home)).toEqual(before);
  });

  test("a clean installation reads clean, and a terminal's own key is noted, not refused: the ambient fallback keeps working", async () => {
    const planned = planDaemon({ platform: "darwin", bin: process.execPath, binArgs: [], runner: "shop", repo: home, configDir: join(home, ".toolroll"), watchFlags: [], home });
    if ("error" in planned) throw new Error(planned.error);
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(planned.unitPath, planned.unitContent);
    const { run } = supervisor((file, args) => {
      if (file === "launchctl" && args[0] === "getenv") return { code: 0, stdout: "\n" };
      if (file === "launchctl" && args[0] === "print") return { code: 0, stdout: "pid = 77\n" };
      if (file === "/bin/ps") return { code: 0, stdout: `node watch${args[0] === "-wwE" ? " PATH=/usr/bin" : ""}\n` };
      return undefined;
    });
    const ambient = marker("ambient-anthropic");
    const report = await auditServiceEnvironment({ platform: "darwin", home, uid: 501, run, env: { ANTHROPIC_API_KEY: ambient, PATH: "/bin" } });
    expect(report).toMatchObject({ ok: true, findings: [], unreadable: [] });
    expect(report.checked).toEqual(expect.arrayContaining([expect.stringMatching(/^`toolroll daemon install` writes PATH, TOOLROLL_SERVICE_DIGEST, STANDING_ORDERS_SERVICE_DIGEST into the service/), `${planned.label}: its running process (pid 77).`]));
    expect(report.notes).toEqual([expect.stringContaining("This terminal exports ANTHROPIC_API_KEY. A Toolroll started from here still uses it when no key is saved")]);
    const lines = doctorLines(report);
    expect(lines[0]).toBe("No secrets found in Toolroll's service. A build can't read a key from it.");
    expect(lines.join("\n")).not.toContain(ambient);
  });

  test("a manager or process that can't be read is never taken for clean", async () => {
    const planned = planDaemon({ platform: "darwin", bin: process.execPath, binArgs: [], runner: "shop", repo: home, configDir: join(home, ".toolroll"), watchFlags: [], home });
    if ("error" in planned) throw new Error(planned.error);
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(planned.unitPath, planned.unitContent);
    const { run } = supervisor((file, args) => file === "launchctl" && args[0] === "print" ? { code: 0, stdout: "pid = 78\n" } : undefined);
    const lines: string[] = [];
    expect(await runDoctorCommand([], line => lines.push(line), { platform: "darwin", home, uid: 501, run, env: {} })).toBe(1);
    expect(lines[0]).toBe("Toolroll couldn't check everything, so it can't say the service is clean. Nothing was changed.");
    // Neither launchd's environment (getenv failed) nor the process (ps failed) is taken for clean.
    expect(lines).toContain("Not checked: launchd's environment for your login: launchctl getenv failed (exit 1).");
    expect(lines).toContain("  1. Run `ps -wwE -o command= -p 78` yourself and check it shows no API key, token or password.");
  });

  // The real read: ps -E reads KERN_PROCARGS2. It is setuid, so inside a sandbox it can't run and this proves nothing.
  test.skipIf(process.platform !== "darwin" || spawnSync("/bin/ps", ["-p", String(process.pid)]).status !== 0)("reads a real process's environment through KERN_PROCARGS2, by name only", async () => {
    const value = marker("procargs");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { env: { SYNTHETIC_DOCTOR_TOKEN: value }, stdio: "ignore" });
    try {
      await new Promise(resolve => setTimeout(resolve, 200));
      const read = await processCredentialNames(child.pid!, { platform: "darwin", run: runCommand });
      expect(read).toEqual({ ok: true, names: ["SYNTHETIC_DOCTOR_TOKEN"] });
    } finally { child.kill(); }
  });
});

describe("toolroll doctor on Linux", () => {
  const label = "com.toolroll.watch.shop";

  test("reads the unit, its drop-ins and environment files, the user manager and /proc/<pid>/environ, and names every secret", async () => {
    const values = { unit: marker("unit-github"), dropin: marker("dropin-sentry"), file: marker("envfile-db"), manager: marker("manager-anthropic"), live: marker("live-openrouter") };
    const units = join(home, ".config", "systemd", "user");
    mkdirSync(join(units, `${label}.service.d`), { recursive: true });
    const unitPath = join(units, `${label}.service`);
    const envFile = join(home, "shop.env");
    writeFileSync(envFile, `# synthetic\nexport DB_PASSWORD="${values.file}"\nLOG_LEVEL=info\n`);
    writeFileSync(unitPath, `[Service]\nEnvironment="PATH=/usr/bin" "GITHUB_TOKEN=${values.unit}"\nEnvironmentFile=-${join(home, "missing.env")}\nEnvironmentFile=${envFile}\nExecStart=/usr/bin/node /app/cli.js watch --runner shop --token-file /h/.toolroll/runner-token --repo /work/shop\n`);
    const dropin = join(units, `${label}.service.d`, "override.conf");
    writeFileSync(dropin, `[Service]\nEnvironment=SENTRY_ACCESS_TOKEN=${values.dropin}\n`);
    const proc = join(home, "proc");
    mkdirSync(join(proc, "777"), { recursive: true });
    writeFileSync(join(proc, "777", "environ"), `HOME=/home/o\0PATH=/usr/bin\0OPENROUTER_API_KEY=${values.live}\0`);
    const before = snapshot(home);
    const { run, calls } = supervisor((file, args) => {
      if (file !== "systemctl") return undefined;
      if (args[1] === "show-environment") return { code: 0, stdout: `LANG=C\nANTHROPIC_API_KEY=${values.manager}\n` };
      if (args[1] === "is-active") return { code: 0, stdout: "active\n" };
      if (args[1] === "show") return { code: 0, stdout: "MainPID=777\n" };
      return undefined;
    });
    const json: string[] = [];
    expect(await runDoctorCommand(["--json"], line => json.push(line), { platform: "linux", home, uid: 1000, run, procRoot: proc, env: {} })).toBe(1);
    const lines: string[] = [];
    await runDoctorCommand([], line => lines.push(line), { platform: "linux", home, uid: 1000, run, procRoot: proc, env: {} });
    for (const output of [json.join("\n"), lines.join("\n")]) for (const value of Object.values(values)) expect(output).not.toContain(value);
    const report = JSON.parse(json[0]!) as { findings: { where: string; names: string[]; steps: string[] }[] };
    expect(report.findings.map(one => [one.where, one.names])).toEqual([
      ["the systemd user manager's environment, which every user service inherits", ["ANTHROPIC_API_KEY"]],
      [`${label}: ${unitPath}`, ["GITHUB_TOKEN"]],
      [`${label}: ${dropin}`, ["SENTRY_ACCESS_TOKEN"]],
      [`${label}: ${envFile} (its EnvironmentFile)`, ["DB_PASSWORD"]],
      [`${label}'s running process (pid 777)`, ["OPENROUTER_API_KEY"]],
    ]);
    expect(report.findings[0]!.steps).toEqual(expect.arrayContaining(["systemctl --user unset-environment ANTHROPIC_API_KEY", `systemctl --user restart ${label}`]));
    expect(report.findings[1]!.steps[0]).toBe("Prepare this reinstall command: toolroll daemon install --runner <set-again> --token-file <set-again> --repo <set-again>");
    expect(report.findings[2]!.steps).toEqual([`Remove SENTRY_ACCESS_TOKEN from ${dropin}.`, "Set a project tool's secret on that project's Tools page; anything else the service doesn't need can simply go.",
      "systemctl --user daemon-reload", `systemctl --user restart ${label}`]);
    expect(report.findings[4]!.steps).toEqual(expect.arrayContaining(["Keep the openrouter key in Toolroll instead: `toolroll keys set openrouter < <file holding the key>` (then delete that file)."]));
    expect(calls.filter(call => !READ_ONLY.test(call))).toEqual([]);
    expect(snapshot(home)).toEqual(before);
  });

  test("a process whose environment can't be read fails closed, with the owner's own check", async () => {
    const planned = planDaemon({ platform: "linux", bin: process.execPath, binArgs: [], runner: "shop", repo: home, configDir: join(home, ".toolroll"), watchFlags: [], home });
    if ("error" in planned) throw new Error(planned.error);
    mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
    writeFileSync(planned.unitPath, planned.unitContent);
    const { run } = supervisor((file, args) => args[1] === "show-environment" ? { code: 0, stdout: "LANG=C\n" } : args[1] === "is-active" ? { code: 0, stdout: "active\n" } : args[1] === "show" ? { code: 0, stdout: "MainPID=31337\n" } : undefined);
    const report = await auditServiceEnvironment({ platform: "linux", home, uid: 1000, run, procRoot: join(home, "no-proc"), env: {} });
    expect(report).toMatchObject({ ok: false, findings: [], unreadable: [{ where: `${planned.label}'s running process (pid 31337)`, problem: "its environment (/proc/31337/environ) couldn't be read (ENOENT)",
      steps: ["Run `tr '\\0' '\\n' < /proc/31337/environ | cut -d= -f1` yourself and check no name is a key, token or password."] }] });
  });

  test.runIf(process.platform === "linux")("reads a real process's /proc/<pid>/environ, by name only", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { env: { PATH: "/usr/bin:/bin", SYNTHETIC_DOCTOR_TOKEN: marker("proc") }, stdio: "ignore" });
    try {
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(await processCredentialNames(child.pid!, { platform: "linux", run: runCommand })).toEqual({ ok: true, names: ["SYNTHETIC_DOCTOR_TOKEN"] });
    } finally { child.kill(); }
  });
});

test("a platform the doctor can't check is never reported clean", async () => {
  const { run, calls } = supervisor(() => undefined);
  const report = await auditServiceEnvironment({ platform: "win32", home, run, env: {} });
  expect(report.ok).toBe(false);
  expect(report.unreadable[0]).toMatchObject({ where: "services on win32", problem: "Toolroll can't check its services on win32" });
  expect(calls).toEqual([]);
});

describe("doctor remediation never reflects service argument values", () => {
  test.each(["darwin", "linux"] as const)("redacts separate, equals, unknown and key-shaped arguments in text and JSON on %s", async platform => {
    const values = {
      token: marker("equals-token"), api: marker("api-key"), unknown: marker("unknown"),
      key: `ghp_${"R".repeat(36)}`, runner: marker("runner"), path: marker("path"), numeric: marker("numeric"),
      flag: marker("unknown-flag"),
    };
    const args = ["/usr/bin/node", "/app/cli.js", "watch", `--token=${values.token}`, "--api-key", values.api,
      "--note", values.key, `--unknown=${values.unknown}`, `--${values.flag}`, "--runner", values.runner,
      `--repo=${values.path}`, `--pool=${values.key}`, `--max=${values.numeric}`, "--turns=12", "--tick-every", "60000",
      "--provider=claude", "--containment", "required"];
    const planned = planDaemon({ platform, bin: process.execPath, binArgs: [], runner: "shop", repo: home, configDir: join(home, ".toolroll"), watchFlags: [], home });
    if ("error" in planned) throw new Error(planned.error);
    const dir = platform === "darwin" ? join(home, "Library", "LaunchAgents") : join(home, ".config", "systemd", "user");
    mkdirSync(dir, { recursive: true });
    writeFileSync(planned.unitPath, platform === "darwin"
      ? `<plist><dict><key>ProgramArguments</key><array>${args.map(arg => `<string>${arg}</string>`).join("")}</array></dict></plist>`
      : `[Service]\nExecStart=${args.join(" ")}\n`);
    const before = snapshot(home);
    const { run, calls } = supervisor((file, args) => args[0] === "getenv" || args[1] === "show-environment" ? { code: 0, stdout: "" } : undefined);
    for (const mode of [[], ["--json"]]) {
      const output: string[] = [];
      expect(await runDoctorCommand(mode, line => output.push(line), { platform, home, run, env: {} })).toBe(1);
      const text = output.join("\n");
      for (const value of Object.values(values)) expect(text).not.toContain(value);
      expect(text).toContain("--runner <set-again> --repo <set-again> --pool <set-again> --max <set-again> --turns 12 --tick-every 60000 --provider claude --containment required <set-again>");
      expect(text).toContain("Unknown or credential arguments were omitted");
      expect(text).toContain("Never put a key or token value in the command");
      expect(text).not.toContain("writes a definition without them");
    }
    expect(snapshot(home)).toEqual(before);
    expect(calls.filter(call => !READ_ONLY.test(call))).toEqual([]);
  });

  test("a binary launchd definition is unchecked in both modes, never clean or printed", async () => {
    const dir = join(home, "Library", "LaunchAgents");
    mkdirSync(dir, { recursive: true });
    // Valid binary plist containing EnvironmentVariables.SYNTHETIC_TOKEN (generated with plistlib).
    const secret = marker("binary-token");
    writeFileSync(join(dir, "com.toolroll.watch.shop.plist"), Buffer.from("YnBsaXN0MDDRAQJfEBRFbnZpcm9ubWVudFZhcmlhYmxlc9EDBF8QD1NZTlRIRVRJQ19UT0tFTl8QLGRvY3Rvci1iaW5hcnktdG9rZW4tNWY1ZjVmNWY1ZjVmNWY1ZjVmNWY1ZjVmCAsiJTcAAAAAAAABAQAAAAAAAAAFAAAAAAAAAAAAAAAAAAAAZg==", "base64"));
    const before = snapshot(home);
    const { run } = supervisor((file, args) => args[0] === "getenv" ? { code: 0, stdout: "" } : undefined);
    for (const mode of [[], ["--json"]]) {
      const output: string[] = [];
      expect(await runDoctorCommand(mode, line => output.push(line), { platform: "darwin", home, run, env: {} })).toBe(1);
      expect(output.join("\n")).toContain("binary or unreadable XML");
      expect(output.join("\n")).not.toContain(secret);
      expect(output.join("\n")).not.toContain("No secrets found");
    }
    expect(snapshot(home)).toEqual(before);
  });
});

describe("macOS process environment boundaries", () => {
  test.each([
    { plain: "node watch", full: `node watch NOTE=words before ghp_${"S".repeat(36)} after words`, expected: { ok: true, names: ["NOTE"] } },
    { plain: "node watch", full: `node watch NOTE=ordinary words SYNTHETIC_TOKEN=${marker("embedded-assignment")}`, expected: { ok: false } },
    { plain: "node watch", full: `node changed TOKEN=${marker("changed-command")}`, expected: { ok: false } },
    { plain: "", full: `TOKEN=${marker("empty-command")}`, expected: { ok: false } },
    { plain: "node watch", full: `node watcher TOKEN=${marker("partial-command")}`, expected: { ok: false } },
  ])("preserves values or refuses ambiguous output: $expected.ok ($plain)", async ({ plain, full, expected }) => {
    const { run } = supervisor((file, args) => ({ code: 0, stdout: `${args[0] === "-ww" ? plain : full}\n` }));
    const result = await processCredentialNames(42, { platform: "darwin", run });
    expect(result).toMatchObject(expected);
    expect(JSON.stringify(result)).not.toContain("ghp_");
    expect(JSON.stringify(result)).not.toContain(marker("embedded-assignment"));
  });
});
