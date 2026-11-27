/**
 * Bonjour advertisement of the direct listener (protocol §6 C3): `_toolroll._tcp` on the direct port with TXT
 * `m=<machineId>`, so a phone whose stored direct addresses stopped answering (a new Wi-Fi address) can find this Mac on
 * the local network. The phone accepts a found address only when its TXT `m` is the machine id it paired with, still
 * probes `/v1/health`, and uses it for that dial only.
 *
 * The system's own advertiser does the work, as a child process for as long as the listener runs: `dns-sd -R` on
 * macOS, `avahi-publish-service` on Linux when it is installed, nothing elsewhere. Spawned with an explicit argv and no
 * shell (the machine id is checked against its grammar first). Bonjour being unavailable never fails the listener.
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export const BONJOUR_SERVICE = "_toolroll._tcp";
const MACHINE_ID = /^[a-z2-7]{26}$/;

export type Spawner = (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface BonjourAdvert {
  /** The command and arguments that were started, or null when nothing advertises on this platform. */
  readonly argv: readonly string[] | null;
  stop(): void;
}

/** What to run to advertise, for a platform (null: no advertiser there). */
export function bonjourCommand(platform: NodeJS.Platform, port: number, machineId: string): readonly string[] | null {
  if (!MACHINE_ID.test(machineId) || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  const name = `Toolroll ${machineId.slice(0, 6)}`;
  const txt = `m=${machineId}`;
  if (platform === "darwin") return ["dns-sd", "-R", name, BONJOUR_SERVICE, "local", String(port), txt];
  if (platform === "linux") return ["avahi-publish-service", name, BONJOUR_SERVICE, String(port), txt];
  return null;
}

export function startBonjour(opts: { port: number; machineId: string; log?: (line: string) => void; platform?: NodeJS.Platform; spawn?: Spawner }): BonjourAdvert {
  const log = opts.log ?? (() => {});
  const argv = bonjourCommand(opts.platform ?? process.platform, opts.port, opts.machineId);
  if (argv === null) return { argv: null, stop: () => {} };
  let child: ChildProcess | null = null;
  try {
    child = (opts.spawn ?? nodeSpawn)(argv[0]!, argv.slice(1), { shell: false, stdio: "ignore", detached: false });
  } catch (error) {
    log(`phone access: not advertising on the local network (${error instanceof Error ? error.message : String(error)})`);
    return { argv, stop: () => {} };
  }
  let stopped = false;
  // Not installed (avahi on most Linux desktops without it), or it exits: the listener carries on without Bonjour.
  child.on("error", error => {
    if (!stopped) log(`phone access: not advertising on the local network (${(error as NodeJS.ErrnoException).code ?? error.message})`);
    child = null;
  });
  child.on("exit", () => { child = null; });
  child.unref?.();
  return {
    argv,
    stop: () => {
      stopped = true;
      if (child !== null && child.exitCode === null) child.kill("SIGTERM");
      child = null;
    },
  };
}
