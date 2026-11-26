/**
 * EASY START (easy-start plan A, D, E): bare `toolroll` at a terminal, and `toolroll open`.
 *
 * At a person's terminal (stdin and stdout a TTY, no --json, not under a coding agent), bare `toolroll` makes sure this
 * computer's Toolroll is running and opens the terminal UI on it:
 *
 * - The console is proved live first (console-instance.ts, both channels). When it isn't running: the background
 *   service, if installed, is started through its supervisor; otherwise `up --laptop` starts as an ORDINARY child of
 *   this process, so quitting the screen ends it through `up`'s own parent-death drain (today's foreground semantics).
 * - With local mode on, the terminal UI opens in this process as the local owner (runAsLocalOwner): reads in-process,
 *   writes through `runOperate`, refused wherever the local owner is. `--web` opens the browser instead, signed in
 *   through the console's socket `link` verb (or, with nothing running, runs `up --laptop` in the foreground, which
 *   opens it).
 * - With local mode off (an install with passwords), nothing in the terminal writes: today's flow opens the browser,
 *   where the person signs in with their password.
 *
 * Every outside effect is a seam; `defaultEasyStartSeams` gives the real ones. Under an agent, without a terminal or
 * with --json, cli.ts never comes here: those keep exactly the behaviour they had (quick-start.ts and the scan).
 */
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { instanceSocketTooLong, requestLocalLink, type AttachProof } from "./console-instance.js";
import { backgroundInstalled, backgroundOn, startInstalledService } from "./laptop-background.js";
import { proveConsoleReadOnly } from "./quick-start.js";
import { backgroundAsked, installationCreatedBy, localModeCandidate, localModeOf, openStore, openStoreReadOnly, recordBackgroundAsked } from "./store.js";
import { underAgent } from "./prompt.js";
import { savedLoginFile } from "./login-secrets.js";
import type { TuiExit, TuiSession } from "./tui-contract.js";

/** How often a starting console is looked for (easy start): a proof costs a few milliseconds. */
const PROVE_EVERY_MS = 50;

export { easyStartApplies, easyStartArgs, type EasyStartArgs } from "./easy-start-args.js";
import type { EasyStartArgs } from "./easy-start-args.js";

/** What opening the browser signed in did: opened (with `wait`, which keeps this process until the browser has used
 * the link, at most the time given, then deletes the page), or why not. */
export type SignedInOpen = { ok: true; wait: (ms: number) => Promise<void> } | { ok: false; message: string };

/** How long `toolroll open --web`, with nothing else to wait for, stays so the browser can read the page (eight k1). */
export const SIGN_IN_HANDOFF_MS = 60_000;

/** The `up` this process started and owns. */
export type OwnedUp = { pid: number; exited: Promise<number | null>; running(): boolean; stop(): void; tail(): readonly string[] };

export type EasyStartSeams = {
  databaseFile: string;
  cwd: string;
  write: (line: string) => void;
  /** Prove this database's console live (read only). */
  prove: () => Promise<AttachProof>;
  /** Why no console started on this database could ever be found (its folder is too deep for the socket,
   * console-instance.ts instanceSocketTooLong), with the fix; null when its socket fits. */
  socketProblem: () => string | null;
  /** Local mode as saved now: on, off, no database yet (a new install), or a database with no account and no local-mode
   * state that this person's start may still make password-free (eight W2: `welcome`, `status` or `repos add` ran first). */
  localMode: () => "on" | "off" | "absent" | "candidate";
  /** Eight W2: turn local mode on here, at the person's terminal, before anything starts (operate.ts
   * easyStartInitLocalMode re-proves the person and the database itself). True when it is on afterwards. */
  initLocal: () => Promise<boolean>;
  /** l1: this computer's sandbox, read now — the Linux programs it lacks (sandbox-runtime.ts LINUX_SANDBOX_TOOLS, by
   * package; none elsewhere), and why it can't sandbox here (null when it can). */
  sandbox: () => Promise<{ missing: string[]; problem: string | null; repair?: string[] }>;
  /** The first start's other prerequisites (preflight.ts): git, telling processes apart, each with its fix; and
   * advice (no browser). None given: none. */
  prerequisites?: () => Promise<import("./preflight.js").Prerequisites>;
  /** l1: whether this database was made by a laptop start (created-by laptop) yet never had local mode (on or off):
   * a start that couldn't go password-free made it. Read only, from the database alone; false when unreadable. */
  passwordByLaptopStart: () => boolean;
  /** The saved login file `up` wrote for this database, when there is one (its path, never what it holds). */
  savedLogin: () => string | null;
  serviceInstalled: () => boolean;
  /** Start the installed background service through its supervisor and prove its console. */
  startService: () => Promise<AttachProof>;
  /** `up` (with these arguments) as an ordinary child of this process. */
  spawnUp: (args: readonly string[]) => OwnedUp;
  /** `up` (with these arguments) in this terminal, until it stops: today's foreground start. */
  runUpForeground: (args: readonly string[]) => Promise<number>;
  /** Open an address that carries no credential (the console's own address) in the browser. False when nothing could
   * be opened here (no display, over SSH, no opener): the caller says the address instead. */
  openBrowser: (url: string) => void | boolean | Promise<void | boolean>;
  /** Open this computer's browser signed in as the local owner: a one-time link from the live console (the socket `link`
   * verb), handed to the browser only through a 0600 page and the platform's own opener (openLocalSignIn). The link
   * never comes back here. */
  openSignedIn: (page?: import("./tui-contract.js").TuiPage) => Promise<SignedInOpen>;
  /** The terminal UI, in this process, as the local owner, until the person quits. */
  openTui: (session: TuiSession) => Promise<TuiExit>;
  /** `background on`, handing over from the `up` this process owns (when it owns one). */
  backgroundOn: (foreground: { controllerPid: number; restart: () => Promise<void> } | null) => Promise<{ ok: boolean; message: string }>;
  backgroundAsked: () => boolean;
  recordBackgroundAnswer: (yes: boolean) => void;
  /** This folder's repository, whether it is added, and adding it (only when attaching to a running console). */
  findRepo: (cwd: string) => Promise<string | null>;
  enrolled: (repo: string) => Promise<boolean>;
  admit: (repo: string) => Promise<number>;
  sleep?: (ms: number) => Promise<void>;
  startTimeoutMs?: number;
};

const EXIT = { ok: 0, failed: 1, usage: 2, refused: 3 } as const;

/** What the terminal UI says when the `up` it started stopped on its own (a crash): no reason from its output, which can
 * carry anything; `toolroll --verbose` prints that output to this person's own terminal. */
export const UP_STOPPED_LINE = "Toolroll's background worker stopped. Run `toolroll --verbose` to see why.";

/** l1: where a person whose first start made a password install reads how to start over without one. */
export const START_OVER_POINTER = "This Toolroll was set up with a password. To start over without one: https://github.com/ap9000/toolroll/blob/main/docs/guide/linux.md#start-over-without-a-password";

/**
 * Bare `toolroll` ("start") or `toolroll open` ("open") at a person's terminal. Resolves with the exit code once the
 * screen (or the foreground `up`, or the browser hand-off) is done.
 */
export async function runEasyStart(mode: "start" | "open", args: EasyStartArgs, seams: EasyStartSeams): Promise<number> {
  const { write } = seams;
  // Eight W2: --port goes to every `up` this starts (laptop, password, --web). Without it, a laptop start tries the next
  // free port itself (operate.ts upLaptopPortCandidates) once this database's console is proved not running.
  const port = args.port === undefined || args.port === null ? null : Number(args.port);
  if (port !== null && (!/^[0-9]{1,5}$/.test(args.port!) || port < 1 || port > 65_535)) {
    write("--port is a whole number from 1 to 65535.");
    return EXIT.usage;
  }
  const rootArgs = [...(args.projectRoot === null ? [] : ["--project-root", args.projectRoot]), ...(port === null ? [] : ["--port", String(port)]),
    ...(args.verbose === true ? ["--verbose"] : [])];
  /** A console of this database already running (or the background service) keeps its own port: say so, once. */
  const elsewhere = (proof: AttachProof): void => {
    if (port !== null && proof.ok && proof.port !== port) write(`Toolroll is already set up on port ${proof.port}, so it opens there.`);
  };
  const sleep = seams.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const first = await seams.prove();
  if (!first.ok && first.state === "refused") {
    write(`Toolroll can't open: ${first.message}.`);
    return EXIT.refused;
  }
  // A database too deep for the console's socket: a console started on it could never be found, so the screen would
  // wait for one until it gave up. Said at once, with the fix, before anything is made or started. Only the browser
  // roads that need no socket go on: a password install, and --web's own foreground `up` (it opens the browser itself).
  const refusedTooDeep = (): boolean => {
    if (first.ok || (args.web && !seams.serviceInstalled())) return false;
    const deep = seams.socketProblem();
    if (deep === null) return false;
    write(`Toolroll can't start: ${deep}.`);
    return true;
  };

  // Attaching to a console already running: this folder's repository joins it, as bare `toolroll` always did.
  const joinRepo = async (): Promise<number> => {
    if (mode !== "start") return EXIT.ok;
    const found = await seams.findRepo(seams.cwd);
    if (found === null) return EXIT.ok;
    let repo = found;
    try { repo = realpathSync(found); } catch { /* as found */ }
    return (await seams.enrolled(repo)) ? EXIT.ok : seams.admit(repo);
  };

  // Eight W2: a database with no account and no local-mode state (or none yet) becomes password-free here, at the
  // person's own terminal, before anything starts — only while nothing of this database's is running. The `up` started
  // below has no terminal of its own, so it never initialises anything itself.
  let local = seams.localMode();
  if ((local === "candidate" || local === "absent") && !first.ok && first.state === "none") {
    // Too deep for the socket: said before anything else runs, the sandbox probe included.
    if (refusedTooDeep()) return EXIT.refused;
    // l1 + preflight: a new install stops here, before anything is made, on everything that would stop it — the
    // sandbox's programs, a sandbox that can't start (with its repair), git, telling processes apart — listed together,
    // each with its fix. No account, no database written (a candidate stays one), so once they are fixed the next start
    // is password-free. A sandbox that can't start for a reason the person can't fix leaves an explicit `toolroll up`.
    const sandbox = await seams.sandbox();
    const others = await (seams.prerequisites?.() ?? Promise.resolve({ blockers: [], advisories: [] }));
    const blockers: string[][] = [];
    let passwordInstead = false;
    if (sandbox.missing.length > 0) {
      const { missingSandboxToolsWords } = await import("./sandbox-runtime.js");
      blockers.push(missingSandboxToolsWords(sandbox.missing));
    } else if (sandbox.problem !== null) {
      blockers.push([`Agents can't run in a sandbox here: ${sandbox.problem}.`, ...sandbox.repair ?? []]);
      passwordInstead = others.blockers.length === 0;
    }
    blockers.push(...others.blockers);
    if (blockers.length > 0) {
      if (blockers.length === 1) {
        for (const line of blockers[0]!) write(line);
        if (sandbox.missing.length === 0 && sandbox.problem !== null) write("Then run toolroll again.");
      }
      else {
        write("Toolroll can't start on this computer yet. Fix these, then run toolroll again:");
        blockers.forEach((lines, index) => lines.forEach((line, at) => write(at === 0 ? `${index + 1}. ${line}` : `   ${line}`)));
      }
      if (passwordInstead) write("To start now with a password instead (agents can't run until the sandbox works): run `toolroll up`.");
      for (const line of others.advisories) write(line);
      return EXIT.refused;
    }
    if (await seams.initLocal()) local = "on";
  }
  // A database that could not be made password-free (no fence, an account that appeared meanwhile, a console running):
  // today's password road, never the laptop road.
  if (local === "candidate") local = "off";
  if (local !== "off" && refusedTooDeep()) return EXIT.refused;

  // An install with passwords: today's flow, in the browser, where the person signs in. Nothing here writes.
  if (local === "off") {
    // l1: an install a laptop start made with a password (it couldn't go password-free then): one line pointing at the
    // guide's manual steps to start over. Nothing is read beyond the database's own two facts, and nothing changes.
    if (seams.passwordByLaptopStart()) write(START_OVER_POINTER);
    if (!first.ok) return seams.runUpForeground(rootArgs);
    const joined = await joinRepo();
    if (joined !== EXIT.ok) return joined;
    elsewhere(first);
    write(`Toolroll is on ${first.url}`);
    await seams.openBrowser(first.url);
    return EXIT.ok;
  }

  // --web with nothing running and no service: `up --laptop` in this terminal opens the browser itself, signed in.
  if (args.web && !first.ok && !seams.serviceInstalled()) return seams.runUpForeground(["--laptop", ...rootArgs]);

  let owned: OwnedUp | null = null;
  // The `up`s this process stopped itself (Stop on quit, a start that didn't answer, a handover): never "on its own".
  const stoppedHere = new Set<OwnedUp>();
  /** Each ended `up`'s exit code; null when a signal ended it (a stop someone or something asked for). */
  const exitCodes = new Map<OwnedUp, number | null>();
  const stopOwned = (child: OwnedUp): void => { stoppedHere.add(child); child.stop(); };
  /** The `up` this terminal started, ended by itself with a failure (a non-zero exit): the line to show, else null. A
   * clean exit, a signal, or a stop made here is never one. */
  const stoppedOnItsOwn = (): string | null => {
    const child = owned as OwnedUp | null;
    if (child === null || child.running() || stoppedHere.has(child)) return null;
    const code = exitCodes.get(child);
    return typeof code === "number" && code !== 0 ? UP_STOPPED_LINE : null;
  };
  const upArgs = ["--laptop", "--no-open", ...rootArgs];
  /** Start our own `up` and wait until its console proves live (or it ends, or the wait runs out). */
  const startOwned = async (): Promise<AttachProof> => {
    const child = seams.spawnUp(upArgs);
    owned = child;
    void child.exited.then(code => { exitCodes.set(child, code); });
    const deadline = Date.now() + (seams.startTimeoutMs ?? 90_000);
    for (;;) {
      const proof = await seams.prove();
      if (proof.ok) return proof;
      if (!child.running()) {
        const last = child.tail().filter(line => line.trim() !== "").slice(-3).join(" — ");
        return { ok: false, state: "refused", message: last === "" ? "it stopped while starting" : last };
      }
      if (Date.now() >= deadline) {
        stopOwned(child);
        return { ok: false, state: "refused", message: "it didn't answer in time" };
      }
      // A proof is a read-only look (a few milliseconds): asked often, so the screen opens as soon as the console can.
      await sleep(PROVE_EVERY_MS);
    }
  };

  let proof: AttachProof = first;
  if (!proof.ok) {
    // (Bare `toolroll` said it already, from its first line: bin.ts.)
    if ((globalThis as Record<symbol, unknown>)[Symbol.for("toolroll.starting-said")] !== true) write("Starting Toolroll…");
    proof = seams.serviceInstalled() ? await seams.startService() : await startOwned();
    if (!proof.ok) {
      write(`Toolroll didn't start: ${proof.message}.`);
      return EXIT.failed;
    }
  } else {
    const joined = await joinRepo();
    if (joined !== EXIT.ok) return joined;
  }
  elsewhere(proof);
  const url = proof.url;
  /** The `up` this process owns, while it runs. */
  const ownedNow = (): OwnedUp | null => (owned !== null && owned.running() ? owned : null);
  const waitOwned = async (): Promise<number> => {
    const child = ownedNow();
    if (child === null) return EXIT.ok;
    write("Ctrl-C stops it.");
    await child.exited;
    return EXIT.ok;
  };

  // No local mode here (a new install on a computer that can't sandbox): the browser, with the password `up` saved —
  // pointed at, never "your password" to someone who never set one (l1).
  if (seams.localMode() !== "on") {
    const { problem, repair } = await seams.sandbox();
    if (problem !== null) write(`Toolroll can't start without a password here: ${problem}.`);
    if (problem !== null) for (const line of repair ?? []) write(line);
    const saved = seams.savedLogin();
    write(saved === null ? `Toolroll is on ${url}. Sign in with your password.` : `Toolroll is on ${url}. Your password: run \`cat -- '${saved.replaceAll("'", "'\\''")}'\``);
    await seams.openBrowser(url);
    return waitOwned();
  }

  if (args.web) {
    const opened = await seams.openSignedIn();
    if (!opened.ok) {
      write(`Toolroll is on ${url}, but it couldn't sign you in: ${opened.message}.`);
      const child = ownedNow();
      if (child !== null) stopOwned(child);
      return EXIT.refused;
    }
    write(`Toolroll is on ${url}`);
    // Nothing else keeps this process (the console was already running): it stays until the browser has used the link,
    // at most a minute, so the page isn't deleted before the browser reads it. Then the page goes either way.
    if (ownedNow() === null) {
      write("Opening Toolroll in your browser…");
      await opened.wait(SIGN_IN_HANDOFF_MS);
      return EXIT.ok;
    }
    return waitOwned();
  }

  /** Move to the background service, handing over from our own `up` (background on stops it and proves it gone). */
  const handoff = async (): Promise<string> => {
    const child = ownedNow();
    // Background on stops this `up` itself as it hands over: never a stop on its own.
    if (child !== null) stoppedHere.add(child);
    const result = await seams.backgroundOn(child === null ? null : {
      controllerPid: child.pid,
      // The service didn't take over: our own `up` starts again, as before.
      restart: async () => { const again = await startOwned(); if (!again.ok) throw Error(again.message); },
    });
    if (result.ok) owned = null;
    return result.message;
  };
  const session: TuiSession = {
    owned: () => ownedNow() !== null,
    stopped: stoppedOnItsOwn,
    openBuilderPassword: async (task, setup) => {
      // Reuse a full browser session when available. A local session sees its sign-in action on this card.
      const page = `/t/${encodeURIComponent(task)}`;
      const target = new URL(setup ? "/password/set" : `${page}#agents`, url);
      if (setup) target.searchParams.set("next", page);
      const opened = await seams.openBrowser(target.href);
      return opened === false ? `Open ${target.href} in a browser, then Agents → Change agents and save the new builder.` : "In the browser, open Agents → Change agents and save the new builder.";
    },
    openBrowser: async page => {
      // An already-running console may predate this terminal's named sign-in landing.
      // Open the existing settings form on the proven console with the browser's normal sign-in.
      if (page === "projects" || page === "lead-providers") {
        const href = new URL(page === "projects" ? "/projects" : "/settings/lead#lead-config", url).href;
        const opened = await seams.openBrowser(href);
        return opened === false ? `Open ${href} in a browser.` : `Opened ${page === "projects" ? "Projects" : "Lead settings"} in your browser.`;
      }
      const opened = await seams.openSignedIn(page);
      return opened.ok ? "Opened in your browser." : `The browser couldn't be opened: ${opened.message}.`;
    },
    shouldAskBackground: () => ownedNow() !== null && !seams.serviceInstalled() && !seams.backgroundAsked(),
    answerBackground: async yes => {
      seams.recordBackgroundAnswer(yes);
      return yes ? handoff() : "Okay. To change your mind later, run `toolroll background on`.";
    },
  };
  const exit = await seams.openTui(session);
  // The `up` this terminal started stopped on its own while the screen was open: said again here, its last output first
  // under --verbose (this person's own terminal, for a report), and the exit is a failure.
  const ended = owned as OwnedUp | null;
  if (ended !== null && !ended.running()) await ended.exited;
  const died = stoppedOnItsOwn();
  if (died !== null) {
    if (args.verbose === true) for (const line of ended?.tail() ?? []) write(line);
    write(died);
    return EXIT.failed;
  }
  if (ownedNow() !== null) {
    if (exit === "keep") {
      const said = await handoff();
      write(said);
      if (ownedNow() === null) {
        write("Reopen with: toolroll");
        return EXIT.ok;
      }
    }
    // Read again after a hand-off that didn't take: it started a new `up` in this terminal, and that one is what stops
    // here (everyday-8 #9: stopping the old, already-stopped one said "stopped" while the new one kept running).
    const child = ownedNow();
    if (child !== null) {
      write("Stopping Toolroll… (running work is saved)");
      stopOwned(child);
      await child.exited;
      write("Toolroll stopped.");
    }
  }
  write("Reopen with: toolroll");
  return EXIT.ok;
}

/** `up` as an ordinary child of this process: its output kept (last lines, for a failed start), never on the screen. */
export function spawnOwnedUp(args: readonly string[], options: { cwd: string; databaseFile: string; entry?: string }): OwnedUp {
  const entry = options.entry ?? process.argv[1];
  if (entry === undefined) throw Error("can't find Toolroll's own command to start it");
  const child = spawn(process.execPath, [...process.execArgv, entry, "up", ...args, "--db", options.databaseFile], {
    cwd: options.cwd,
    // An IPC channel: if this process ends without stopping it, `up` sees its parent go and drains (operate.ts).
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const lines: string[] = [];
  const keep = (chunk: Buffer | string): void => {
    for (const line of String(chunk).split("\n")) if (line !== "") lines.push(line);
    if (lines.length > 40) lines.splice(0, lines.length - 40);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  let running = child.pid !== undefined;
  const exited = new Promise<number | null>(resolve => {
    child.once("exit", code => { running = false; resolve(code); });
    child.once("error", error => { running = false; lines.push(error.message); resolve(null); });
  });
  return { pid: child.pid ?? -1, exited, running: () => running, stop: () => { if (running) child.kill("SIGTERM"); }, tail: () => [...lines] };
}

/** The real seams, for this installation's database. */
export function defaultEasyStartSeams(options: {
  databaseFile: string;
  write: (line: string) => void;
  build: string;
  cwd?: string;
  operate?: import("./operate.js").OperateOptions;
  admit: (repo: string) => Promise<number>;
  /** --screen-reader: the classic screen. */
  screenReader?: boolean;
  /** --tui-binary <absolute path>: a developer's own terminal workbench build (tui-launch.ts checks it like any other). */
  tuiBinary?: string;
}): EasyStartSeams {
  const file = options.databaseFile;
  const cwd = options.cwd ?? process.cwd();
  return {
    databaseFile: file,
    cwd,
    write: options.write,
    prove: () => proveConsoleReadOnly(file, options.build),
    socketProblem: () => instanceSocketTooLong(file),
    localMode: () => localModeRead(file),
    initLocal: async () => (await import("./operate.js")).easyStartInitLocalMode(file, {
      stdin: process.stdin.isTTY === true, stdout: process.stdout.isTTY === true, agent: underAgent(process.env), json: false,
      remote: (await import("./local-owner.js")).localOwnerRequested(),
    }),
    sandbox: async () => {
      const { missingLinuxSandboxTools, sandboxRuntimeProblem, sandboxRuntimeRepair } = await import("./sandbox-runtime.js");
      if (process.platform !== "linux") return { missing: [], problem: sandboxRuntimeProblem() };
      const missing = missingLinuxSandboxTools();
      const problem = missing.length > 0 ? null : sandboxRuntimeProblem();
      return { missing, problem, repair: problem === null ? [] : sandboxRuntimeRepair() };
    },
    prerequisites: async () => (await import("./preflight.js")).startPrerequisites(),
    passwordByLaptopStart: () => {
      const store = openStoreReadOnly(file);
      if (store === null) return false;
      try { return installationCreatedBy(store) === "laptop" && localModeOf(store) === null; } catch { return false; } finally { store.close(); }
    },
    savedLogin: () => {
      const saved = resolve(savedLoginFile(dirname(file)));
      return existsSync(saved) ? saved : null;
    },
    serviceInstalled: () => backgroundInstalled(),
    startService: async () => {
      const store = openStore(file);
      try { return await startInstalledService(store, file); } finally { store.close(); }
    },
    spawnUp: args => spawnOwnedUp(args, { cwd, databaseFile: file }),
    runUpForeground: async args => (await import("./operate.js")).runOperate("up", [...args, "--db", file], options.write, options.operate ?? {}),
    openBrowser: async url => (await import("./operate.js")).openBrowser(url),
    openSignedIn: page => openLocalSignIn(file, options.build, page === undefined ? {} : { then: page }),
    openTui: async session => {
      // The terminal workbench (tui-launch.ts), signed in over descriptor 3; else the classic screen, with one line why.
      const { chooseTuiBinary, runTuiBinary } = await import("./tui-launch.js");
      const { engineContractDigest } = await import("./contracts/engine-api.js");
      const choice = chooseTuiBinary({ env: process.env, screenReader: options.screenReader === true, platform: process.platform, arch: process.arch, contract: engineContractDigest(), devBinary: options.tuiBinary ?? null });
      if (choice.notice !== undefined) options.write(`${choice.notice}.`);
      let why: string | null = choice.ok ? null : choice.why;
      // A screen signed out under the person (a password set, a sign-out elsewhere) opens again only on their own Enter
      // at this terminal, by the same start as `toolroll` (a fresh link the console proves); a few times at most.
      for (let opened = 0; choice.ok && opened < 5; opened++) {
        const reader = openStoreReadOnly(file);
        const link = reader === null ? { ok: false as const, message: "Toolroll's database can't be read" }
          : await requestLocalLink(file, reader, options.build).finally(() => reader.close());
        if (!link.ok) {
          // Reopening after a sign-out with no local sign-in to give (local mode off, the owner revoked): stop, said.
          if (opened > 0) { options.write("Toolroll can't sign this screen in again here. Sign in with your password in the browser."); return "leave"; }
          why = `the terminal workbench couldn't sign in (${link.message})`;
          break;
        }
        const { checkoutTop } = await import("./teardown-git.js");
        const end = await runTuiBinary({ binary: choice.binary, identity: choice.identity, link: link.url, session, project: checkoutTop(cwd), cwd });
        if (end === "ended") {
          const { askLineOrEof, reopenAfterSignOut } = await import("./tui-launch.js");
          const terminal = process.stdin.isTTY === true && process.stdout.isTTY === true;
          if (opened < 4 && await reopenAfterSignOut({ terminal, agent: underAgent(process.env), ask: askLineOrEof })) continue;
          return "leave";
        }
        if (end === "central-unavailable") return "leave";
        if (end === "changed") why = "the terminal workbench changed after it was checked";
        else if (end !== "classic") return end;
        // The workbench said why on its own way out.
        else why = null;
        break;
      }
      if (why !== null) options.write(`Opening the classic screen: ${why}.`);
      const { createTuiSource } = await import("./tui-source.js");
      const { runAsLocalOwner } = await import("./local-owner.js");
      const source = createTuiSource({ databaseFile: file, ...(options.operate === undefined ? {} : { operate: options.operate }) });
      try {
        const tui = await loadTui();
        return await runAsLocalOwner(() => tui.startTui(source, session));
      } finally { source.close(); }
    },
    backgroundOn: async foreground => {
      const store = openStore(file);
      try {
        // At this terminal, but the screen owns its input: another service on this database is refused, not asked.
        const on = await backgroundOn(store, file, null, { terminal: false, ...(foreground === null ? {} : { foreground }) });
        if (on.ok) return { ok: true, message: `Toolroll now runs in the background at ${on.url}. It starts when you log in.` };
        return { ok: false, message: `Toolroll couldn't move to the background: ${on.message}.${(on.rolledBack ?? []).map(line => ` ${line}.`).join("")}` };
      } finally { store.close(); }
    },
    backgroundAsked: () => {
      const store = openStoreReadOnly(file);
      // Unreadable: never ask on the strength of a database this build can't read.
      if (store === null) return true;
      try { return backgroundAsked(store) !== null; } finally { store.close(); }
    },
    recordBackgroundAnswer: yes => {
      const store = openStore(file);
      try { recordBackgroundAsked(store, yes ? "yes" : "no", new Date()); } finally { store.close(); }
    },
    findRepo: async dir => {
      const { checkoutTop } = await import("./teardown-git.js");
      return checkoutTop(dir);
    },
    enrolled: async repo => {
      const { loadRepos } = await import("./repos.js");
      const { registryBeside } = await import("./project-admission.js");
      const loaded = await loadRepos(registryBeside(file));
      return !("error" in loaded) && loaded.repos.includes(repo);
    },
    admit: options.admit,
  };
}

/** The terminal UI bundle (dist/tui.js, built from src/tui/entry.tsx), loaded only when the screen opens. */
async function loadTui(): Promise<{ startTui: (source: import("./tui-contract.js").TuiSource, session: TuiSession) => Promise<TuiExit> }> {
  const bundled = new URL("./tui.js", import.meta.url);
  if (existsSync(bundled)) return await import(bundled.href) as never;
  // From source (`npm run dev`): the entry itself.
  return await import(pathToFileURL(new URL("./tui/entry.tsx", import.meta.url).pathname).href) as never;
}

/** Local mode as saved, read only: "absent" with no database yet; "candidate" for one with no account of any kind and no
 * local-mode state (store.ts localModeCandidate); an older or unreadable database has none ("off"): never widened. */
export function localModeRead(file: string): "on" | "off" | "absent" | "candidate" {
  if (file !== ":memory:" && !existsSync(file)) return "absent";
  const store = openStoreReadOnly(file);
  if (store === null) return "off";
  try {
    if (localModeOf(store)?.enabled === true) return "on";
    return localModeCandidate(store) ? "candidate" : "off";
  } catch { return "off"; } finally { store.close(); }
}

/**
 * The terminal UI's `w` and `toolroll open --web`: this computer's browser, signed in as the local owner. The live
 * console mints the one-time link (the socket `link` verb); it is handed to the browser only through a 0600 page in a
 * fresh 0700 folder inside the database's private run folder, opened by the platform's own opener with the page's path
 * as its one argument (sign-in-page.ts) — never in any program's arguments, never through TOOLROLL_BROWSER_COMMAND, never
 * printed. The page goes once the console's ledger records the sign-in, when the link expires, or when this process
 * ends. With no opener here, nothing is minted.
 */
export async function openLocalSignIn(databaseFile: string, build: string, seams: {
  request?: (store: import("./store.js").Store) => Promise<{ ok: true; url: string } | { ok: false; message: string }>;
  opener?: import("./sign-in-page.js").SignInOpener;
  platform?: NodeJS.Platform;
  everyMs?: number;
  expiresMs?: number;
  /** The page to land on once signed in (one of tui-contract.ts TUI_PAGES; the console maps it to its own address). */
  then?: import("./tui-contract.js").TuiPage;
} = {}): Promise<SignedInOpen> {
  const { ledgerSpent, NO_SAFE_OPENER, openSignInLink, platformOpener } = await import("./sign-in-page.js");
  if (platformOpener(seams.platform) === null) return { ok: false, message: NO_SAFE_OPENER };
  const { instanceRunDir, prepareRunDir } = await import("./console-instance.js");
  const parent = instanceRunDir(databaseFile);
  const problem = prepareRunDir(parent);
  if (problem !== null) return { ok: false, message: problem };
  const store = openStoreReadOnly(databaseFile);
  if (store === null) return { ok: false, message: "Toolroll's database can't be read" };
  let handed = false;
  try {
    // Rows from before the link was asked for never count as its sign-in, and the page goes no later than the link's
    // own deadline, counted from before it was minted.
    const spent = ledgerSpent(store, "local link", null);
    const expiresAt = Date.now() + (seams.expiresMs ?? (await import("./server/session.js")).SIGN_IN_LINK_MS);
    const asked = await (seams.request ?? (one => requestLocalLink(databaseFile, one, build)))(store);
    if (!asked.ok) return asked;
    const { isTuiPage } = await import("./tui-contract.js");
    const link = seams.then !== undefined && isTuiPage(seams.then) ? { ...asked, url: `${asked.url}?then=${seams.then}` } : asked;
    // The page's watcher reads the ledger until the page goes; it closes this store then.
    handed = true;
    const opened = await openSignInLink(link.url, {
      parent, spent, expiresAt, onEnd: () => store.close(),
      ...(seams.opener === undefined ? {} : { opener: seams.opener }),
      ...(seams.platform === undefined ? {} : { platform: seams.platform }),
      ...(seams.everyMs === undefined ? {} : { everyMs: seams.everyMs }),
    });
    return opened.opened ? { ok: true, wait: opened.wait } : { ok: false, message: "the browser opener didn't start or failed" };
  } finally {
    if (!handed) store.close();
  }
}
