/**
 * The Linux launch helper (sandbox-runtime.ts): `node sandbox-launch.js`, handed one launch in its environment
 * (TOOLROLL_SANDBOX_LAUNCH). It changes into the launch's folder (Anthropic's sandbox-runtime anchors its mandatory
 * write denies there), starts the runtime's network relays to this run's proxy when the network is confined, asks the
 * runtime for the bubblewrap + seccomp command, runs it (setting it up again, from a fresh look, if the sandbox failed
 * before the launch itself started), passes on the signals it gets, and when the command ends removes the mount points
 * the runtime made and stops the relays. It exits with the command's status. Nothing runs if
 * the runtime refuses: the helper exits 126 with the reason.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { checkLinuxDependencies, cleanupBwrapMountPoints, getLinuxDependencyStatus, initializeLinuxNetworkBridge, wrapCommandWithSandboxLinux, type LinuxNetworkBridgeContext } from "@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js";
import { SANDBOX_LAUNCH_SPEC, shellQuote, withRuntimeTemp, type SandboxLaunchSpec } from "./sandbox-runtime.js";

const REFUSED = 126;
/** The status a launch stopped before it ran ends with (128 + SIGTERM). */
const STOPPED = 143;

/** Why the runtime can't sandbox here now (bubblewrap, socat or its seccomp helper gone), or null: asked again before
 * each attempt, never remembered from an earlier look. */
function missing(): string | null {
  const checked = checkLinuxDependencies();
  if (checked.errors.length > 0) return checked.errors.join("; ");
  return getLinuxDependencyStatus().hasSeccompApply ? null : "the sandbox runtime's seccomp helper isn't available";
}

async function main(): Promise<number> {
  const raw = process.env[SANDBOX_LAUNCH_SPEC];
  delete process.env[SANDBOX_LAUNCH_SPEC];
  if (raw === undefined) { process.stderr.write("toolroll sandbox: no launch was given\n"); return REFUSED; }
  const spec = JSON.parse(raw) as SandboxLaunchSpec;
  process.chdir(spec.cwd);
  // A stop at any point: what is running is passed it, and nothing starts after it.
  let stopping = false;
  let child: ChildProcess | null = null;
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => { stopping = true; try { child?.kill(signal); } catch { /* gone */ } });
  const network = spec.terms.network;
  let bridge: LinuxNetworkBridgeContext | null = null;
  // The relays share the launch's process group: they are waited for (SIGKILL after a moment), so when the helper exits
  // nothing of the launch is left in it to read as the agent's leftover.
  const stopBridge = async () => {
    await Promise.all([bridge?.httpBridgeProcess, bridge?.socksBridgeProcess].map(one => new Promise<void>(done => {
      if (one === undefined || one.exitCode !== null || one.signalCode !== null) { done(); return; }
      const force = setTimeout(() => { try { one.kill("SIGKILL"); } catch { /* gone */ } }, 1_000);
      one.once("exit", () => { clearTimeout(force); done(); });
      try { one.kill("SIGTERM"); } catch { clearTimeout(force); done(); }
    })));
  };
  try {
    if (network.kind === "proxy") bridge = await initializeLinuxNetworkBridge(network.httpPort, network.socksPort ?? network.httpPort);
    // The runtime reads the temp folder it gives the command when it builds it (withRuntimeTemp, sandbox-runtime.ts).
    if (spec.temp !== undefined) process.env["CLAUDE_CODE_TMPDIR"] = spec.temp;
    else withRuntimeTemp(undefined, () => undefined);
    // The command first says it started, on a descriptor of its own (3), before anything of the launch runs. A sandbox
    // whose setup failed (bubblewrap couldn't mount over a path another launch removed after the runtime looked)
    // never ran the launch, so it is set up again from a fresh look, a few times; one that started is never re-run.
    const started = `printf 1 >&3 || exit 125; exec 3>&-; exec ${shellQuote([spec.file, ...spec.args])}`;
    for (let attempt = 1; ; attempt++) {
      // Stopped during setup or between attempts: nothing starts.
      if (stopping) return STOPPED;
      const gone = missing();
      if (gone !== null) throw new Error(`the sandbox can't be made here: ${gone}`);
      const command = await wrapCommandWithSandboxLinux({
        command: started,
        needsNetworkRestriction: network.kind === "proxy",
        ...(bridge === null || network.kind !== "proxy" ? {} : {
          httpSocketPath: bridge.httpSocketPath, socksSocketPath: bridge.socksSocketPath, httpProxyPort: network.httpPort,
          ...(network.socksPort === undefined ? {} : { socksProxyPort: network.socksPort }),
          ...(network.token === undefined ? {} : { proxyAuthToken: network.token }),
        }),
        readConfig: spec.terms.readConfig,
        writeConfig: spec.terms.writeConfig,
      });
      // bubblewrap, and the runtime's seccomp filter inside it: anything less is not this sandbox.
      if (!/\bbwrap\b/.test(command) || !command.includes("apply-seccomp")) throw new Error("the sandbox runtime returned a command without its sandbox or its seccomp filter");
      if (stopping) return STOPPED;
      const run = spawn("/bin/sh", ["-c", command], { stdio: ["inherit", "inherit", "pipe", "pipe"] });
      child = run;
      let ran = false;
      const held: Buffer[] = [];
      run.stdio[3]!.on("data", () => { if (!ran) { ran = true; for (const one of held.splice(0)) process.stderr.write(one); } });
      run.stdio[3]!.on("error", () => undefined);
      run.stderr!.on("data", (chunk: Buffer) => { if (ran) process.stderr.write(chunk); else held.push(chunk); });
      const status = await new Promise<number>(done => {
        run.on("error", () => done(REFUSED));
        run.on("close", (code, signal) => done(code ?? (signal === null ? 1 : 128 + (({ SIGKILL: 9, SIGTERM: 15, SIGINT: 2, SIGHUP: 1 } as Record<string, number>)[signal] ?? 1))));
      });
      if (!ran && stopping) return STOPPED;
      if (ran || attempt >= 3) {
        if (!ran) for (const one of held) process.stderr.write(one);
        return status;
      }
      try { cleanupBwrapMountPoints(); } catch { /* the next look is fresh either way */ }
      await new Promise(done => setTimeout(done, 50 * attempt));
    }
  } catch (error) {
    if (child === null) { process.stderr.write(`toolroll sandbox: nothing was started: ${error instanceof Error ? error.message : String(error)}\n`); return REFUSED; }
    return 1;
  } finally {
    try { cleanupBwrapMountPoints(); } catch { /* best effort: the runtime's own exit handler retries */ }
    await stopBridge();
  }
}

void main().then(code => process.exit(code));
