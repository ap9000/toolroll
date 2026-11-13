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
import { pathToFileURL } from "node:url";
import { requestLocalLink, type AttachProof } from "./console-instance.js";
import { backgroundInstalled, backgroundOn, startInstalledService } from "./laptop-background.js";
import { proveConsoleReadOnly } from "./quick-start.js";
import { backgroundAsked, localModeCandidate, localModeOf, openStore, openStoreReadOnly, recordBackgroundAsked } from "./store.js";
import { underAgent } from "./prompt.js";
import type { TuiExit, TuiSession } from "./tui-contract.js";

export { easyStartApplies, easyStartArgs, type EasyStartArgs } from "./easy-start-args.js";
import type { EasyStartArgs } from "./easy-start-args.js";

/** The `up` this process started and owns. */
export type OwnedUp = { pid: number; exited: Promise<number | null>; running(): boolean; stop(): void; tail(): readonly string[] };

export type EasyStartSeams = {
  databaseFile: string;
  cwd: string;
  write: (line: string) => void;
  /** Prove this database's console live (read only). */
  prove: () => Promise<AttachProof>;
  /** Local mode as saved now: on, off, no database yet (a new install), or a database with no account and no local-mode
   * state that this person's start may still make password-free (eight W2: `welcome`, `status` or `repos add` ran first). */
  localMode: () => "on" | "off" | "absent" | "candidate";
  /** Eight W2: turn local mode on here, at the person's terminal, before anything starts (operate.ts
   * easyStartInitLocalMode re-proves the person and the database itself). True when it is on afterwards. */
  initLocal: () => Promise<boolean>;
  serviceInstalled: () => boolean;
  /** Start the installed background service through its supervisor and prove its console. */
  startService: () => Promise<AttachProof>;
  /** `up` (with these arguments) as an ordinary child of this process. */
  spawnUp: (args: readonly string[]) => OwnedUp;
  /** `up` (with these arguments) in this terminal, until it stops: today's foreground start. */
  runUpForeground: (args: readonly string[]) => Promise<number>;
  openBrowser: (url: string) => void | Promise<void>;
  /** A local owner's one-time sign-in address from the live console (the socket `link` verb). */
  requestLink: () => Promise<{ ok: true; url: string } | { ok: false; message: string }>;
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

const EXIT = { ok: 0, failed: 1, refused: 3 } as const;

/**
 * Bare `toolroll` ("start") or `toolroll open` ("open") at a person's terminal. Resolves with the exit code once the
 * screen (or the foreground `up`, or the browser hand-off) is done.
 */
export async function runEasyStart(mode: "start" | "open", args: EasyStartArgs, seams: EasyStartSeams): Promise<number> {
  const { write } = seams;
  const rootArgs = args.projectRoot === null ? [] : ["--project-root", args.projectRoot];
  const sleep = seams.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const first = await seams.prove();
  if (!first.ok && first.state === "refused") {
    write(`Toolroll can't open: ${first.message}.`);
    return EXIT.refused;
  }

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
  if ((local === "candidate" || local === "absent") && !first.ok && first.state === "none" && await seams.initLocal()) local = "on";
  // A database that could not be made password-free (no fence, an account that appeared meanwhile, a console running):
  // today's password road, never the laptop road.
  if (local === "candidate") local = "off";

  // An install with passwords: today's flow, in the browser, where the person signs in. Nothing here writes.
  if (local === "off") {
    if (!first.ok) return seams.runUpForeground(rootArgs);
    const joined = await joinRepo();
    if (joined !== EXIT.ok) return joined;
    write(`Toolroll is on ${first.url}`);
    await seams.openBrowser(first.url);
    return EXIT.ok;
  }

  // --web with nothing running and no service: `up --laptop` in this terminal opens the browser itself, signed in.
  if (args.web && !first.ok && !seams.serviceInstalled()) return seams.runUpForeground(["--laptop", ...rootArgs]);

  let owned: OwnedUp | null = null;
  const upArgs = ["--laptop", "--no-open", ...rootArgs];
  /** Start our own `up` and wait until its console proves live (or it ends, or the wait runs out). */
  const startOwned = async (): Promise<AttachProof> => {
    const child = seams.spawnUp(upArgs);
    owned = child;
    const deadline = Date.now() + (seams.startTimeoutMs ?? 90_000);
    for (;;) {
      const proof = await seams.prove();
      if (proof.ok) return proof;
      if (!child.running()) {
        const last = child.tail().filter(line => line.trim() !== "").slice(-3).join(" — ");
        return { ok: false, state: "refused", message: last === "" ? "it stopped while starting" : last };
      }
      if (Date.now() >= deadline) {
        child.stop();
        return { ok: false, state: "refused", message: "it didn't answer in time" };
      }
      await sleep(250);
    }
  };

  let proof: AttachProof = first;
  if (!proof.ok) {
    write("Starting Toolroll…");
    proof = seams.serviceInstalled() ? await seams.startService() : await startOwned();
    if (!proof.ok) {
      write(`Toolroll didn't start: ${proof.message}.`);
      return EXIT.failed;
    }
  } else {
    const joined = await joinRepo();
    if (joined !== EXIT.ok) return joined;
  }
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

  // No local mode here (a new install on a computer with no sandbox): the browser, with the password `up` saved.
  if (seams.localMode() !== "on") {
    write(`Toolroll is on ${url}. Sign in with your password.`);
    await seams.openBrowser(url);
    return waitOwned();
  }

  if (args.web) {
    const link = await seams.requestLink();
    if (!link.ok) {
      write(`Toolroll is on ${url}, but it couldn't sign you in: ${link.message}.`);
      ownedNow()?.stop();
      return EXIT.refused;
    }
    write(`Toolroll is on ${url}`);
    await seams.openBrowser(link.url);
    return waitOwned();
  }

  /** Move to the background service, handing over from our own `up` (background on stops it and proves it gone). */
  const handoff = async (): Promise<string> => {
    const child = ownedNow();
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
    openBrowser: async () => {
      const link = await seams.requestLink();
      if (!link.ok) return `The browser couldn't be opened: ${link.message}.`;
      await seams.openBrowser(link.url);
      return "Opened in your browser.";
    },
    shouldAskBackground: () => ownedNow() !== null && !seams.serviceInstalled() && !seams.backgroundAsked(),
    answerBackground: async yes => {
      seams.recordBackgroundAnswer(yes);
      return yes ? handoff() : "Okay. To change your mind later, run `toolroll background on`.";
    },
  };
  const exit = await seams.openTui(session);
  const child = ownedNow();
  if (child !== null) {
    if (exit === "keep") {
      const said = await handoff();
      write(said);
      if (ownedNow() === null) return EXIT.ok;
    }
    write("Stopping Toolroll… (running work is saved)");
    child.stop();
    await child.exited;
    write("Toolroll stopped.");
  }
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
}): EasyStartSeams {
  const file = options.databaseFile;
  const cwd = options.cwd ?? process.cwd();
  return {
    databaseFile: file,
    cwd,
    write: options.write,
    prove: () => proveConsoleReadOnly(file, options.build),
    localMode: () => localModeRead(file),
    initLocal: async () => (await import("./operate.js")).easyStartInitLocalMode(file, {
      stdin: process.stdin.isTTY === true, stdout: process.stdout.isTTY === true, agent: underAgent(process.env), json: false,
      remote: (await import("./local-owner.js")).localOwnerRequested(),
    }),
    serviceInstalled: () => backgroundInstalled(),
    startService: async () => {
      const store = openStore(file);
      try { return await startInstalledService(store, file); } finally { store.close(); }
    },
    spawnUp: args => spawnOwnedUp(args, { cwd, databaseFile: file }),
    runUpForeground: async args => (await import("./operate.js")).runOperate("up", [...args, "--db", file], options.write, options.operate ?? {}),
    openBrowser: async url => { (await import("./operate.js")).openBrowser(url); },
    requestLink: async () => {
      const store = openStoreReadOnly(file);
      if (store === null) return { ok: false, message: "Toolroll's database can't be read" };
      try { return await requestLocalLink(file, store, options.build); } finally { store.close(); }
    },
    openTui: async session => {
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
