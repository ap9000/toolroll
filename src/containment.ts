/**
 * OS process containment (docs/PROCESS_CONTAINMENT_PLAN.md).
 *
 * The stop contract before this module was OBSERVATIONAL: a provider's
 * tree is scanned every 500 ms, and a double fork can reparent between
 * scans. This module adds an OS boundary where the OS has one, and says
 * exactly what it has where it has none:
 *
 *   linux   a delegated cgroup v2 directory per spawn. The target is
 *           placed in it BEFORE it executes (the `sh` prelude below writes
 *           its own pid, then execs the target with argv verbatim), so a
 *           setsid/double-fork helper is born inside and dies with
 *           `cgroup.kill`. Emptiness is the kernel's own `cgroup.events`
 *           populated flag — never a transport exit. A detached janitor
 *           kills the cgroup when this worker dies.
 *   win32   a Job Object with kill-on-close and no breakaway, owned by a
 *           PowerShell helper OUTSIDE the job that creates the target
 *           suspended, assigns it, then resumes it. The helper's death —
 *           including this worker's death, which closes its stdin — closes
 *           the handle and the job kills everything in it.
 *   darwin  nothing. There is no supported cgroup/Job Object equivalent;
 *           NOTE_TRACK/NOTE_CHILD have been unsupported since 10.5 and
 *           launchd's AbandonProcessGroup only covers a process group. The
 *           observational mode stays, is reported as exactly that, and a
 *           REQUIRED policy refuses before any target executes.
 *
 * Three policies: `observed` (the behaviour every existing installation
 * has), `preferred` (native when this machine can, observed — and said
 * so — when it cannot), `required` (native or a refusal; never a silent
 * downgrade). The policy is decided ONCE per controller process from the
 * operator's flag or environment and pinned; nothing a child supplies and
 * no corrupt value can weaken a pinned requirement.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { captureCgroupIdentity, cgroupEmptiness, containerEmptiness } from "./container-state.js";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { envValue } from "./names.js";

export const CONTAINMENT_POLICIES = ["observed", "preferred", "required"] as const;
export type ContainmentPolicy = (typeof CONTAINMENT_POLICIES)[number];
export type ContainmentBackendId = "cgroup2" | "job-object";
/** The environment name the controller reads when no flag names a policy. */
export const CONTAINMENT_ENV = "TOOLROLL_CONTAINMENT";

export type PolicyParse =
  | { ok: true; policy: ContainmentPolicy; source: "default" | "explicit" }
  | { ok: false; problem: string };

/**
 * Parse an operator's policy word. Absent means `observed` — every
 * existing installation keeps its behaviour. Anything present must be
 * one of the three words exactly: a corrupt value is a refusal, never a
 * quiet fall back to observed (which would turn a requirement off).
 */
export function parseContainmentPolicy(raw: string | undefined | null): PolicyParse {
  if (raw === undefined || raw === null) return { ok: true, policy: "observed", source: "default" };
  const word = raw.trim().toLowerCase();
  if ((CONTAINMENT_POLICIES as readonly string[]).includes(word)) {
    return { ok: true, policy: word as ContainmentPolicy, source: "explicit" };
  }
  return {
    ok: false,
    problem: `containment policy ${JSON.stringify(raw)} is not one of ${CONTAINMENT_POLICIES.join(", ")} — nothing is assumed from an unreadable value`,
  };
}

export type ContainmentCapability = {
  platform: NodeJS.Platform;
  backend: ContainmentBackendId | null;
  available: boolean;
  /** Why, in words an operator can act on. */
  detail: string;
  /** cgroup2: the delegated cgroup directory this process may create children in. */
  cgroupRoot?: string;
  /** cgroup2: whether the kernel offers the required atomic cgroup.kill (5.14+). */
  cgroupKill?: boolean;
  /** job-object: the helper and the shell that runs it. */
  helper?: string;
  powershell?: string;
};

export type CapabilityProbeOptions = {
  platform?: NodeJS.Platform;
  /** Tests: the mounted cgroup2 root (default /sys/fs/cgroup). */
  cgroupMount?: string;
  /** Tests: this process's /proc/self/cgroup text. */
  selfCgroup?: string;
  /** Tests: where the Windows helper would be. */
  helperPath?: string;
  /** Tests: the PowerShell executable. */
  powershellPath?: string;
};

const DARWIN_DETAIL =
  "macOS has no supported cgroup or Job Object equivalent (kqueue NOTE_TRACK/NOTE_CHILD have been unsupported since 10.5; launchd AbandonProcessGroup covers only a process group) — containment stays observational here; for native containment run this runner on a Linux VM or Linux runner with a delegated cgroup v2 (or on Windows)";

/** The cgroup path of this process from /proc/self/cgroup (`0::/path`). */
export function ownCgroupPath(selfCgroup: string): string | null {
  for (const line of selfCgroup.split("\n")) {
    const match = /^0::(\/.*)$/.exec(line.trim());
    if (match !== null) return match[1] ?? null;
  }
  return null;
}

/**
 * What this machine can do, established by DOING it: on Linux, a child
 * cgroup is created and removed inside this process's own cgroup; a
 * mount that is not v2, a cgroup that is not delegated to this user, or
 * an unreadable /proc all answer unavailable with the reason. Nothing
 * here can be overridden by an environment variable into a claim the OS
 * did not make.
 */
export function probeContainmentCapability(options: CapabilityProbeOptions = {}): ContainmentCapability {
  const platform = options.platform ?? process.platform;
  if (platform === "linux") return probeCgroup2(options);
  if (platform === "win32") return probeJobObject(options);
  if (platform === "darwin") return { platform, backend: null, available: false, detail: DARWIN_DETAIL };
  return { platform, backend: null, available: false, detail: `${platform} has no native containment backend in this build — containment stays observational` };
}

function probeCgroup2(options: CapabilityProbeOptions): ContainmentCapability {
  const mount = options.cgroupMount ?? "/sys/fs/cgroup";
  const platform: NodeJS.Platform = "linux";
  if (!existsSync(join(mount, "cgroup.controllers"))) {
    return { platform, backend: "cgroup2", available: false, detail: `${mount} is not a cgroup v2 (unified) hierarchy — native containment needs cgroup2; the legacy v1 layout is not supported` };
  }
  let selfCgroup: string;
  try {
    selfCgroup = options.selfCgroup ?? readFileSync("/proc/self/cgroup", "utf8");
  } catch (error) {
    return { platform, backend: "cgroup2", available: false, detail: `/proc/self/cgroup could not be read (${(error as Error).message}) — this process's cgroup is unknown` };
  }
  const own = ownCgroupPath(selfCgroup);
  if (own === null) {
    return { platform, backend: "cgroup2", available: false, detail: "/proc/self/cgroup names no unified (0::) cgroup for this process" };
  }
  const root = join(mount, own);
  const probe = join(root, `so-probe-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    mkdirSync(probe);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "error";
    return {
      platform,
      backend: "cgroup2",
      available: false,
      cgroupRoot: root,
      detail: `cgroup ${own} is not delegated to this user (${code} creating a child cgroup) — delegate it (systemd: a user session with Delegate=yes, or chown a leaf cgroup to this uid and start the controller inside it) or run under observed containment`,
    };
  }
  const hasKill = existsSync(join(probe, "cgroup.kill"));
  try {
    rmdirSync(probe);
  } catch {
    // A probe cgroup that cannot be removed is empty and harmless; the
    // capability is still real. It is named so a person can remove it.
  }
  return {
    platform,
    backend: "cgroup2",
    available: hasKill,
    cgroupRoot: root,
    cgroupKill: hasKill,
    detail: hasKill ? `delegated cgroup v2 at ${own} with cgroup.kill` : `cgroup v2 at ${own} lacks atomic cgroup.kill — Linux 5.14+ with writable cgroup.kill is required`,
  };
}

export function jobObjectHelperPath(): string {
  return fileURLToPath(new URL("./job-object-helper.ps1", import.meta.url));
}

function probeJobObject(options: CapabilityProbeOptions): ContainmentCapability {
  const platform: NodeJS.Platform = "win32";
  const helper = options.helperPath ?? jobObjectHelperPath();
  if (!existsSync(helper)) {
    return { platform, backend: "job-object", available: false, detail: `the Job Object helper is missing at ${helper} — reinstall the package` };
  }
  const powershell = options.powershellPath ?? findPowershell();
  if (powershell === null) {
    return { platform, backend: "job-object", available: false, detail: "powershell.exe was not found on PATH or in System32 — the Job Object helper needs Windows PowerShell 5.1 or later" };
  }
  return { platform, backend: "job-object", available: true, helper, powershell, detail: `Job Object (kill-on-close, no breakaway) through ${helper}` };
}

function findPowershell(): string | null {
  const root = process.env["SystemRoot"] ?? process.env["WINDIR"] ?? "C:\\Windows";
  const candidates = [join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")];
  for (const dir of (process.env["PATH"] ?? "").split(";")) {
    if (dir !== "") candidates.push(join(dir, "powershell.exe"), join(dir, "pwsh.exe"));
  }
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return null;
}

export type EffectiveContainment = {
  policy: ContainmentPolicy;
  capability: ContainmentCapability;
  /** What spawns actually get. */
  mode: "observed" | "native";
  /** `preferred` on a machine that cannot: observed, and reported. */
  downgraded: boolean;
  /** `required` on a machine that cannot: every containable spawn refuses with these words, before any target executes. */
  refusal: string | null;
};

/** The truthful composition of what was asked and what the OS offers. */
export function effectiveContainment(policy: ContainmentPolicy, capability: ContainmentCapability): EffectiveContainment {
  if (policy === "observed") return { policy, capability, mode: "observed", downgraded: false, refusal: null };
  if (capability.available) return { policy, capability, mode: "native", downgraded: false, refusal: null };
  if (policy === "preferred") return { policy, capability, mode: "observed", downgraded: true, refusal: null };
  return {
    policy,
    capability,
    mode: "observed",
    downgraded: false,
    refusal: `native process containment is required but unavailable on this ${capability.platform} runner: ${capability.detail}. No provider, setup or check process runs until containment is available or the policy is set to observed/preferred explicitly`,
  };
}

/** One-line status words for `daemon status`, `up`, and the certificate. */
export function describeContainment(effective: EffectiveContainment): string {
  const backend = effective.capability.backend ?? "none";
  if (effective.refusal !== null) return `containment: REQUIRED but unavailable (${backend}) — refusing spawns: ${effective.capability.detail}`;
  if (effective.mode === "native") return `containment: native ${backend} (${effective.policy}) — ${effective.capability.detail}`;
  if (effective.downgraded) return `containment: observed (preferred native, ${backend} unavailable) — ${effective.capability.detail}`;
  return `containment: observed (${effective.policy}) — ${effective.capability.detail}`;
}

/** The one sentence a person reads at start when agents on Linux run
 * without native containment that the machine could offer once set up;
 * null when there is nothing a person needs to read. The exact
 * `describeContainment` line stays in --verbose and in a service log. */
export function containmentNotice(effective: EffectiveContainment): string | null {
  if (effective.refusal !== null || effective.mode !== "observed" || effective.capability.platform !== "linux" || effective.capability.available) return null;
  return "Agents run without Linux process containment on this machine (it needs a delegated cgroup). That's fine for trying Toolroll; see docs/guide/linux.md to turn it on.";
}

/** The status envelope's shape: no paths a person did not already know, no secrets. */
export function containmentStatus(effective: EffectiveContainment): Record<string, unknown> {
  return {
    policy: effective.policy,
    mode: effective.mode,
    backend: effective.capability.backend,
    available: effective.capability.available,
    downgraded: effective.downgraded,
    refusal: effective.refusal,
    detail: effective.capability.detail,
  };
}

// ---- the pinned policy --------------------------------------------------------

let pinned: EffectiveContainment | null = null;

/**
 * Pin this process's containment ONCE, from the operator's own word. A
 * second pin may only tighten: once `required` stands nothing pins it
 * weaker — the only way down is a new process started with a new word.
 */
export function pinContainment(effective: EffectiveContainment): EffectiveContainment {
  if (pinned !== null && rank(effective.policy) < rank(pinned.policy)) {
    throw new Error(`containment is pinned at ${pinned.policy} for this process; ${effective.policy} would weaken it`);
  }
  pinned = effective;
  return effective;
}

function rank(policy: ContainmentPolicy): number {
  return policy === "required" ? 2 : policy === "preferred" ? 1 : 0;
}

/**
 * Resolve the policy from a flag word, then the environment, then the
 * default, and pin it. A corrupt word is a refusal to start, never a
 * default: the caller reports `problem` and exits.
 */
export function resolveContainment(flagWord: string | undefined, env: NodeJS.ProcessEnv = process.env): { ok: true; effective: EffectiveContainment } | { ok: false; problem: string } {
  const parsed = parseContainmentPolicy(flagWord ?? envValue(env, "CONTAINMENT"));
  if (!parsed.ok) return parsed;
  return { ok: true, effective: pinContainment(effectiveContainment(parsed.policy, probeContainmentCapability())) };
}

/** What every containable spawn consults. Unpinned = observed, exactly as before this module. */
export function currentContainment(): EffectiveContainment {
  if (pinned === null) pinned = effectiveContainment("observed", probeContainmentCapability());
  return pinned;
}

/** Tests only. */
export function resetContainmentForTests(): void {
  pinned = null;
}

// ---- the per-spawn OS object ---------------------------------------------------

export type AttachOutcome = { ok: true } | { ok: false; detail: string };

/** How to spawn so the target is inside the OS object before it executes. */
export type ContainedLaunch = {
  file: string;
  args: string[];
  /** Extra stdio slots after stdin/stdout/stderr (the cgroup2 prelude confirms on fd 3). */
  extraStdio: ("pipe" | "ignore")[];
  /** Settles once the prelude has joined (before the target exec) or has failed (the target never ran). */
  attach(child: ChildProcess): Promise<AttachOutcome>;
};

export type Container = {
  backend: ContainmentBackendId;
  /** The exact-run custody handle: cgroup directory or job name. */
  id: string;
  /** Kernel namespace/mount provenance for read-only recovery. */
  identity?: string;
  launch(file: string, args: readonly string[]): ContainedLaunch;
  /** SIGKILL every member and wait for the OS to report the object empty. */
  kill(timeoutMs?: number): Promise<boolean>;
  /** true = members remain; false = proven empty; null = cannot be established right now. */
  populated(): boolean | null;
  waitEmpty(timeoutMs: number): Promise<boolean>;
  /** Remove the OS object (only an empty one can go) and dismiss the janitor. */
  release(): void;
};

export type ContainerFactory = (effective: EffectiveContainment, label: string) => Container;

let factoryOverride: ContainerFactory | null = null;

/** Tests: substitute the OS object (a scripted or file-backed stand-in). */
export function overrideContainerFactoryForTests(factory: ContainerFactory | null): void {
  factoryOverride = factory;
}

/**
 * Make the OS object for one spawn, or say why not. `null` when the
 * effective mode is observed; a `refused` when native containment was
 * demanded and this spawn cannot have it — the caller must not spawn.
 */
export function createContainer(effective: EffectiveContainment, label: string): { container: Container } | { container: null } | { refused: string } {
  if (effective.refusal !== null) return { refused: effective.refusal };
  if (effective.mode !== "native") return { container: null };
  try {
    if (factoryOverride !== null) return { container: factoryOverride(effective, label) };
    if (effective.capability.backend === "cgroup2") return { container: cgroup2Container(effective.capability, label) };
    if (effective.capability.backend === "job-object") return { container: jobObjectContainer(effective.capability, label) };
    return { refused: `no native backend for ${effective.capability.platform}` };
  } catch (error) {
    return { refused: `native containment could not be established for this spawn (${error instanceof Error ? error.message : String(error)}) — nothing ran` };
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The cgroup2 prelude: join, confirm on fd 3, close it, exec the target
 * with argv exactly as given (positional parameters, never re-parsed).
 * A join that fails exits 126 before the target can run.
 */
export const CGROUP2_PRELUDE = 'echo "$$" > "$1/cgroup.procs" || exit 126\nprintf "attached\\n" >&3 || exit 126\nIFS= read -r permit <&3 || exit 126\n[ "$permit" = go ] || exit 126\nexec 3>&-\nshift\nexec "$@"';

/** The janitor: waits for this worker's pipe to close, then kills and removes the cgroup. */
export const CGROUP2_JANITOR = [
  'd="$1"',
  'printf "ready\\n"',
  "cat >/dev/null 2>&1",
  'echo 1 > "$d/cgroup.kill" 2>/dev/null',
  "i=0",
  'while [ "$i" -lt 100 ] && [ -d "$d" ]; do',
  '  if /usr/bin/grep -qx "populated 0" "$d/cgroup.events" 2>/dev/null; then rmdir "$d" 2>/dev/null && break; fi',
  "  i=$((i+1)); sleep 0.1",
  "done",
  "exit 0",
].join("\n");

export function safeContainerLabel(label: string): string {
  return label.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "run";
}

/** A cgroup v2 leaf under the delegated root. Exported for the native test's direct use. */
export function cgroup2Container(capability: ContainmentCapability, label: string, mountOverride?: string): Container {
  const root = mountOverride ?? capability.cgroupRoot;
  if (root === undefined) throw new Error("the cgroup2 capability names no delegated root");
  const dir = join(root, `so-${safeContainerLabel(label)}-${randomBytes(6).toString("hex")}`);
  mkdirSync(dir);
  let identity: string;
  try {
    identity = captureCgroupIdentity(dir);
    // Exercise the exact kernel operation while the object is still empty.
    writeFileSync(join(dir, "cgroup.kill"), "1");
  } catch (error) { try { rmdirSync(dir); } catch {} throw error; }
  const populated = (): boolean | null => {
    const state = cgroupEmptiness(dir, identity);
    return state === "empty" ? false : state === "populated" ? true : null;
  };
  const killNow = (): void => { try { writeFileSync(join(dir, "cgroup.kill"), "1"); } catch {} };
  const janitor = spawn("/bin/sh", ["-c", CGROUP2_JANITOR, "so-janitor", dir], { detached: true, stdio: ["pipe", "pipe", "ignore"] });
  const ready = new Promise<boolean>(resolve => {
    const timer = setTimeout(() => resolve(false), 5_000);
    const done = (ok: boolean): void => { clearTimeout(timer); resolve(ok); };
    janitor.stdout?.once("data", chunk => done(String(chunk) === "ready\n"));
    janitor.once("error", () => done(false));
    janitor.once("exit", () => { done(false); killNow(); });
  });
  janitor.stdin?.on("error", () => {});
  janitor.unref();
  const waitEmpty = async (timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (populated() === false) return true;
      if (Date.now() >= deadline) return false;
      await sleep(20);
    }
  };
  return {
    backend: "cgroup2",
    id: dir,
    identity,
    launch(file, args) {
      return {
        file: "/bin/sh",
        args: ["-c", CGROUP2_PRELUDE, "so-contain", dir, file, ...args],
        extraStdio: ["pipe"],
        attach(child) {
          return new Promise<AttachOutcome>(resolve => {
            const channel = child.stdio[3] as import("node:net").Socket | null;
            let settled = false;
            const timer = setTimeout(() => settle({ ok: false, detail: "containment admission timed out" }), 6_000);
            const settle = (outcome: AttachOutcome): void => {
              if (settled) return;
              settled = true; clearTimeout(timer);
              if (!outcome.ok) { channel?.destroy(); killNow(); }
              resolve(outcome);
            };
            if (!channel) { settle({ ok: false, detail: "containment admission channel missing" }); return; }
            let seen = "";
            channel.on("data", (chunk: Buffer | string) => {
              seen += String(chunk);
              if (seen.length > 64) { settle({ ok: false, detail: "invalid containment admission" }); return; }
              if (seen === "attached\n") void ready.then(ok => {
                if (settled) return;
                if (!ok || janitor.exitCode !== null || janitor.signalCode !== null) {
                  settle({ ok: false, detail: "containment cleanup guardian unavailable" }); return;
                }
                // onSpawn already durably recorded custody. EOF before this
                // authorization leaves the target unexecuted inside the cgroup.
                channel.write("go\n", error => settle(error ? { ok: false, detail: String(error) } : { ok: true }));
              });
            });
            channel.on("end", () => settle({ ok: false, detail: "containment admission closed before authorization" }));
            channel.on("error", error => settle({ ok: false, detail: String(error) }));
            child.on("error", error => settle({ ok: false, detail: String(error) }));
          });
        },
      };
    },
    async kill(timeoutMs = 5_000) {
      killNow();
      return waitEmpty(timeoutMs);
    },
    populated,
    waitEmpty,
    release() {
      try { rmdirSync(dir); } catch { /* still populated: the janitor or recovery finishes it */ }
      try { janitor?.stdin?.end(); } catch { /* already gone */ }
    },
  };
}

/**
 * A Windows Job Object owned by a PowerShell helper outside the job. The
 * helper connects to a named pipe this process listens on and reports
 * `attached` only after CreateProcess(CREATE_SUSPENDED) + AssignProcess
 * ToJobObject + ResumeThread; `failed <detail>` means the target never
 * ran. `kill` asks for TerminateJobObject over the same pipe and waits
 * for the helper's `empty` reply. Physical Windows is where this runs;
 * the CI windows job exercises it.
 */
export function jobObjectContainer(capability: ContainmentCapability, label: string): Container {
  if (capability.helper === undefined || capability.powershell === undefined) throw new Error("the Job Object capability names no helper");
  const name = `so-${safeContainerLabel(label)}-${randomBytes(32).toString("hex")}`;
  const pipe = `\\\\.\\pipe\\${name}`;
  const id = `Global\\${name}`;
  const identity = "job-object-v1";
  let connection: import("node:net").Socket | null = null;
  let state: "pending" | "ready" | "attached" | "empty" | "lost" = "pending";
  let failure: string | null = null;
  let authorized = false;
  let cancelled = false;
  let helperChild: ChildProcess | null = null;
  const fail = (detail: string): void => { failure ??= detail; if (state !== "empty") state = "lost"; connection?.destroy(); };
  const authorize = (): void => {
    if (authorized && state === "ready") connection?.write(cancelled ? "kill\n" : "go\n");
  };
  const server: Server = createServer(socket => {
    if (connection !== null || failure !== null) { socket.destroy(); return; }
    connection = socket;
    socket.setEncoding("utf8");
    let buffered = "";
    socket.on("data", chunk => {
      buffered += String(chunk);
      if (buffered.length > 4096) { fail("oversized containment control frame"); return; }
      let cut: number;
      while ((cut = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, cut); buffered = buffered.slice(cut + 1);
        if (line === "ready" && state === "pending") { state = "ready"; authorize(); }
        else if (line === "attached" && state === "ready" && authorized) state = "attached";
        else if (line === "empty") {
          state = "empty";
          // The helper may have a pending control read. Close now, on its
          // kernel empty proof, so .NET disposal never waits for an EOF that
          // transport `close` would otherwise delay until after helper exit.
          socket.destroy();
        }
        else if (line.startsWith("failed ")) fail(line.slice(7));
        else { fail("invalid containment control sequence"); return; }
      }
    });
    socket.on("error", error => fail(String(error)));
    socket.on("close", () => { if (state !== "empty") fail("containment helper lost its control channel"); });
  });
  server.on("error", error => fail(String(error)));
  server.listen(pipe);
  const populated = (): boolean | null => {
    if (state === "empty") return false;
    if (state === "attached") return true;
    if (state !== "lost") return null;
    const evidence = containerEmptiness("job-object", id, process.platform, identity);
    return evidence === "empty" ? false : evidence === "populated" ? true : null;
  };
  const waitEmpty = async (timeoutMs: number): Promise<boolean> => {
    const deadline = performance.now() + timeoutMs;
    do { if (populated() === false) return true; await sleep(25); } while (performance.now() < deadline);
    return false;
  };
  return {
    backend: "job-object", id, identity,
    launch(file, args) {
      return {
        file: capability.powershell!,
        args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", capability.helper!, "-Pipe", pipe, "-Encoded", Buffer.from(JSON.stringify([file, ...args]), "utf8").toString("base64"), "-JobName", id],
        extraStdio: [],
        async attach(child) {
          // Called only after the durable onSpawn callback succeeded.
          helperChild = child;
          authorized = true; authorize();
          child.once("error", error => fail(String(error)));
          const deadline = performance.now() + 15_000;
          while (state !== "attached" && state !== "empty" && failure === null && child.exitCode === null && child.signalCode === null && performance.now() < deadline) await sleep(20);
          if ((state === "attached" || state === "empty") && failure === null) return { ok: true };
          fail(failure ?? "containment helper admission timed out or exited");
          return { ok: false, detail: failure! };
        },
      };
    },
    async kill(timeoutMs = 5_000) {
      cancelled = true;
      try { connection?.write("kill\n"); } catch { fail("containment control channel unavailable"); }
      if (await waitEmpty(timeoutMs)) return true;
      // A nonresponsive helper is still our own ChildProcess. Closing its
      // actual handle triggers KILL_ON_JOB_CLOSE; saved IDs remain query-only.
      if (helperChild && helperChild.exitCode === null && helperChild.signalCode === null) helperChild.kill("SIGKILL");
      state = "lost";
      return waitEmpty(timeoutMs);
    },
    populated, waitEmpty,
    release() {
      connection?.end();
      server.close();
    },
  };
}
