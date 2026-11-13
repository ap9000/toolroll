/**
 * Easy start (plan A, D): bare `toolroll` at a person's terminal, decided step by step against scripted seams — which
 * Toolroll it starts (the background service, else `up --laptop` as its own child), what it opens (the terminal UI as
 * the local owner, the browser through the console's link verb, or, with local mode off, today's browser flow), the
 * ask-once about the background, and what quitting does to the `up` it owns. And the gate in cli.ts: without a
 * terminal, with --json or under a coding agent, nothing here runs and bare `toolroll` behaves exactly as before.
 */
import { describe, expect, test, vi } from "vitest";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./cli.js";
import { easyStartApplies, easyStartArgs, runEasyStart, spawnOwnedUp, type EasyStartSeams, type OwnedUp } from "./easy-start.js";
import type { AttachProof } from "./console-instance.js";
import type { TuiExit, TuiSession } from "./tui-contract.js";
import { fakePid } from "../test/fake-pid.js";

const LIVE: AttachProof = { ok: true, url: "http://127.0.0.1:4999", port: 4999, pid: fakePid(1), build: "x" };
const NONE: AttachProof = { ok: false, state: "none", message: "no console is running" };

/** A child `up` this process "owns": running until stopped (or until `dies()` says it ended on its own). */
function fakeChild(pid = fakePid(2)) {
  let running = true, resolveExit: (code: number | null) => void = () => {};
  const exited = new Promise<number | null>(resolve => { resolveExit = resolve; });
  const child: OwnedUp & { stopped: number; dies: (lines?: string[]) => void } = {
    pid, exited, stopped: 0, running: () => running, tail: () => tailLines,
    stop: () => { child.stopped += 1; running = false; resolveExit(0); },
    dies: lines => { tailLines = lines ?? []; running = false; resolveExit(1); },
  };
  let tailLines: string[] = [];
  return child;
}

type Script = {
  proofs?: AttachProof[];
  local?: ("on" | "off" | "absent" | "candidate")[];
  /** What the initialisation at the terminal answers (eight W2); default: it turns local mode on. */
  init?: boolean;
  service?: boolean;
  tui?: (session: TuiSession) => Promise<TuiExit>;
  asked?: boolean;
  backgroundOk?: boolean;
  repo?: string | null;
  enrolled?: boolean;
};
function scripted(script: Script = {}) {
  const calls: string[] = [];
  const lines: string[] = [];
  /** Each initialisation asked for at the terminal (eight W2). */
  const inits: string[] = [];
  const children: ReturnType<typeof fakeChild>[] = [];
  const proofs = [...(script.proofs ?? [LIVE])];
  const local = [...(script.local ?? ["on"])];
  let asked = script.asked ?? false;
  const seams: EasyStartSeams = {
    databaseFile: "/tmp/none.db", cwd: "/work/shop", write: line => lines.push(line),
    prove: async () => (proofs.length > 1 ? proofs.shift()! : proofs[0]!),
    localMode: () => (local.length > 1 ? local.shift()! : local[0]!),
    initLocal: async () => { inits.push("init"); return script.init ?? true; },
    serviceInstalled: () => script.service ?? false,
    startService: async () => { calls.push("service"); return LIVE; },
    spawnUp: args => { calls.push(`spawn ${args.join(" ")}`); const child = fakeChild(fakePid(2 + children.length)); children.push(child); return child; },
    runUpForeground: async args => { calls.push(`foreground ${args.join(" ")}`.trim()); return 0; },
    openBrowser: url => { calls.push(`browser ${url}`); },
    requestLink: async () => { calls.push("link"); return { ok: true, url: `${LIVE.ok ? LIVE.url : ""}/login/once/abc` }; },
    openTui: async session => { calls.push("tui"); return script.tui === undefined ? "stop" : script.tui(session); },
    backgroundOn: async foreground => { calls.push(`background ${foreground?.controllerPid ?? "-"}`); return script.backgroundOk === false ? { ok: false, message: "no" } : { ok: true, message: "Toolroll now runs in the background." }; },
    backgroundAsked: () => asked,
    recordBackgroundAnswer: yes => { asked = true; calls.push(`answer ${yes ? "yes" : "no"}`); },
    findRepo: async () => script.repo ?? null,
    enrolled: async () => script.enrolled ?? true,
    admit: async repo => { calls.push(`admit ${repo}`); return 0; },
    sleep: async () => {},
    startTimeoutMs: 5_000,
  };
  return { seams, calls, lines, children, inits };
}
const bare = { web: false, projectRoot: null };

describe("which invocations are an easy start", () => {
  test("only bare, --web and --project-root <dir>, at a person's terminal, never under an agent", () => {
    expect(easyStartArgs([])).toEqual({ web: false, projectRoot: null });
    expect(easyStartArgs(["--web", "--project-root", "/p"])).toEqual({ web: true, projectRoot: "/p" });
    for (const argv of [["--json"], ["--web", "--json"], ["--project-root"], ["--project-root", "--web"], ["scan"], ["/some/path"], ["--web", "--web"], ["--local"]]) expect(easyStartArgs(argv), argv.join(" ")).toBeNull();
    const person = { stdin: true, stdout: true, agent: false };
    expect(easyStartApplies([], person)).toBe(true);
    expect(easyStartApplies([], { ...person, stdin: false })).toBe(false);
    expect(easyStartApplies([], { ...person, stdout: false })).toBe(false);
    expect(easyStartApplies([], { ...person, agent: true })).toBe(false);
    expect(easyStartApplies(["--json"], person)).toBe(false);
  });

  test("cli.ts: without a terminal or under an agent, bare `toolroll` in a repository says what it would do, exactly as before", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "so-easy-gate-")));
    const quickStart = { findRepo: async () => "/work/shop", enrolled: async () => false, underAgent: true };
    const opened = vi.fn(async () => "leave" as const);
    for (const easyStart of [{ terminal: false, seams: { openTui: opened } }, { terminal: true, underAgent: true, seams: { openTui: opened } }]) {
      const out: string[] = [];
      const code = await main([], line => out.push(line), { operate: { databaseFile: join(dir, "none.db") }, quickStart, easyStart });
      expect(code).toBe(0);
      expect(out).toEqual(["Would start Toolroll for /work/shop (toolroll up)."]);
    }
    const json: string[] = [];
    await main(["--json"], line => json.push(line), { operate: { databaseFile: join(dir, "none.db") }, quickStart, easyStart: { terminal: true, underAgent: false, seams: { openTui: opened } } });
    expect(JSON.parse(json.join("\n"))).toMatchObject({ command: "toolroll", would: "start", dryRun: true });
    expect(opened).not.toHaveBeenCalled();
  });

  test("cli.ts: at a person's terminal, bare `toolroll` is the easy start", async () => {
    const { seams, calls } = scripted({ proofs: [LIVE], tui: async () => "leave" });
    const code = await main([], () => {}, { easyStart: { terminal: true, underAgent: false, seams } });
    expect(code).toBe(0);
    expect(calls).toEqual(["tui"]);
  });
});

describe("bare toolroll at a terminal", () => {
  test("nothing running, no service: `up --laptop` starts as its own child, the terminal UI opens, and quitting with Stop drains it", async () => {
    const { seams, calls, children } = scripted({ proofs: [NONE, NONE, LIVE], local: ["absent", "on"] });
    expect(await runEasyStart("start", { web: false, projectRoot: "/p" }, seams)).toBe(0);
    expect(calls).toEqual(["spawn --laptop --no-open --project-root /p", "tui"]);
    expect(children[0]!.stopped).toBe(1);
  });

  test("the background service installed but stopped: started through its supervisor, never a second `up`; quitting leaves it running", async () => {
    let owned: boolean | null = null;
    const { seams, calls } = scripted({ proofs: [NONE], service: true, tui: async session => { owned = session.owned(); return "leave"; } });
    expect(await runEasyStart("start", bare, seams)).toBe(0);
    expect(calls).toEqual(["service", "tui"]);
    expect(owned).toBe(false);
  });

  test("already running: attaches (adding this folder's repository the ordinary way) and opens the terminal UI", async () => {
    const { seams, calls } = scripted({ proofs: [LIVE], repo: "/tmp", enrolled: false, tui: async () => "leave" });
    expect(await runEasyStart("start", bare, seams)).toBe(0);
    expect(calls).toEqual([`admit ${realpathSync("/tmp")}`, "tui"]);
  });

  test("a console that can't prove itself is refused; a child that dies while starting says why", async () => {
    const refused = scripted({ proofs: [{ ok: false, state: "refused", message: "the console's socket can't be trusted" }] });
    expect(await runEasyStart("start", bare, refused.seams)).toBe(3);
    expect(refused.lines).toEqual(["Toolroll can't open: the console's socket can't be trusted."]);
    const dying = scripted({ proofs: [NONE], local: ["absent"] });
    const spawn = dying.seams.spawnUp;
    dying.seams.spawnUp = args => { const child = spawn(args); (child as ReturnType<typeof fakeChild>).dies(["port 4180 is taken"]); return child; };
    expect(await runEasyStart("start", bare, dying.seams)).toBe(1);
    expect(dying.lines.at(-1)).toBe("Toolroll didn't start: port 4180 is taken.");
    expect(dying.calls).not.toContain("tui");
  });

  test("local mode off (an install with passwords): today's browser flow, nothing in the terminal writes", async () => {
    const live = scripted({ proofs: [LIVE], local: ["off"] });
    expect(await runEasyStart("start", bare, live.seams)).toBe(0);
    expect(live.calls).toEqual(["browser http://127.0.0.1:4999"]);
    const stopped = scripted({ proofs: [NONE], local: ["off"] });
    expect(await runEasyStart("start", { web: false, projectRoot: "/p" }, stopped.seams)).toBe(0);
    expect(stopped.calls).toEqual(["foreground --project-root /p"]);
  });

  test("--web: nothing running runs `up --laptop` in the foreground (it opens the browser); running, the link verb signs the browser in", async () => {
    const cold = scripted({ proofs: [NONE], local: ["absent"] });
    expect(await runEasyStart("start", { web: true, projectRoot: null }, cold.seams)).toBe(0);
    expect(cold.calls).toEqual(["foreground --laptop"]);
    const warm = scripted({ proofs: [LIVE] });
    expect(await runEasyStart("open", { web: true, projectRoot: null }, warm.seams)).toBe(0);
    expect(warm.calls).toEqual(["link", "browser http://127.0.0.1:4999/login/once/abc"]);
    expect(warm.lines.join("\n")).not.toContain("/login/once/");
  });
});

describe("a database made before the first start (eight W2: welcome, status or repos add ran first)", () => {
  test("no account and no local mode, nothing running: made password-free at this terminal, then the laptop road", async () => {
    const { seams, calls, inits } = scripted({ proofs: [NONE, LIVE], local: ["candidate", "on"] });
    expect(await runEasyStart("start", bare, seams)).toBe(0);
    expect(inits).toEqual(["init"]);
    expect(calls).toEqual(["spawn --laptop --no-open", "tui"]);
  });

  test("when it couldn't be made password-free (no fence, an account appeared meanwhile): today's password road, never --laptop", async () => {
    const { seams, calls, inits } = scripted({ proofs: [NONE], local: ["candidate"], init: false });
    expect(await runEasyStart("start", { web: false, projectRoot: "/p" }, seams)).toBe(0);
    expect(inits).toEqual(["init"]);
    expect(calls).toEqual(["foreground --project-root /p"]);
  });

  test("a console of this database already running: nothing is initialised under it; today's browser flow", async () => {
    const { seams, calls, inits } = scripted({ proofs: [LIVE], local: ["candidate"] });
    expect(await runEasyStart("start", bare, seams)).toBe(0);
    expect(inits).toEqual([]);
    expect(calls).toEqual(["browser http://127.0.0.1:4999"]);
  });

  test("an install with passwords, or one already password-free, is never initialised", async () => {
    for (const local of ["off", "on"] as const) {
      const { seams, inits } = scripted({ proofs: [NONE, LIVE], local: [local] });
      await runEasyStart("start", bare, seams);
      expect(inits, local).toEqual([]);
    }
  });

  test("cli.ts: without a terminal, under an agent or with --json, the initialisation is never reached", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "so-easy-init-")));
    const initLocal = vi.fn(async () => true);
    const quickStart = { findRepo: async () => "/work/shop", enrolled: async () => false, underAgent: true };
    for (const easyStart of [{ terminal: false }, { terminal: true, underAgent: true }]) {
      await main([], () => {}, { operate: { databaseFile: join(dir, "none.db") }, quickStart, easyStart: { ...easyStart, seams: { initLocal } } });
    }
    await main(["--json"], () => {}, { operate: { databaseFile: join(dir, "none.db") }, quickStart, easyStart: { terminal: true, underAgent: false, seams: { initLocal } } });
    expect(initLocal).not.toHaveBeenCalled();
  });
});

describe("ask once, and quitting", () => {
  test("asked only while this terminal owns the `up` and it was never asked; yes hands over from that `up` to the service", async () => {
    let before: boolean | null = null, after: boolean | null = null, said = "";
    const { seams, calls, children } = scripted({
      proofs: [NONE, LIVE], local: ["absent", "on"],
      tui: async session => { before = session.shouldAskBackground(); said = await session.answerBackground(true); after = session.shouldAskBackground(); return session.owned() ? "stop" : "leave"; },
    });
    expect(await runEasyStart("start", bare, seams)).toBe(0);
    expect(before).toBe(true);
    expect(after).toBe(false);
    expect(said).toBe("Toolroll now runs in the background.");
    expect(calls).toEqual(["spawn --laptop --no-open", "tui", "answer yes", `background ${fakePid(2)}`]);
    // The service took over: quitting doesn't stop anything.
    expect(children[0]!.stopped).toBe(0);
  });

  test("no: recorded, never asked again; already asked, or a service runs it: never asked", async () => {
    const asks: boolean[] = [];
    const no = scripted({ proofs: [NONE, LIVE], local: ["absent", "on"], tui: async session => { await session.answerBackground(false); asks.push(session.shouldAskBackground()); return "stop"; } });
    await runEasyStart("start", bare, no.seams);
    expect(no.calls).toEqual(["spawn --laptop --no-open", "tui", "answer no"]);
    expect(asks).toEqual([false]);
    const before = scripted({ proofs: [NONE, LIVE], local: ["absent", "on"], asked: true, tui: async session => { asks.push(session.shouldAskBackground()); return "stop"; } });
    await runEasyStart("start", bare, before.seams);
    const service = scripted({ proofs: [NONE], service: true, tui: async session => { asks.push(session.shouldAskBackground()); return "leave"; } });
    await runEasyStart("start", bare, service.seams);
    expect(asks).toEqual([false, false, false]);
  });

  test("q → Keep running in the background: handed over; when the handover fails, the `up` it owns is stopped", async () => {
    const kept = scripted({ proofs: [NONE, LIVE], local: ["absent", "on"], tui: async () => "keep" });
    await runEasyStart("start", bare, kept.seams);
    expect(kept.calls).toEqual(["spawn --laptop --no-open", "tui", `background ${fakePid(2)}`]);
    expect(kept.children[0]!.stopped).toBe(0);
    const failed = scripted({ proofs: [NONE, LIVE], local: ["absent", "on"], backgroundOk: false, tui: async () => "keep" });
    await runEasyStart("start", bare, failed.seams);
    expect(failed.children[0]!.stopped).toBe(1);
    expect(failed.lines).toContain("Toolroll stopped.");
  });
});

describe("the `up` it owns", () => {
  test("an ordinary child with an IPC channel (so `up` drains when this process goes), its output kept off the screen; Stop ends it", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "so-easy-child-")));
    const entry = join(dir, "fake-up.mjs");
    // Stands in for the CLI: says how it was started and whether it has a parent channel, then waits for SIGTERM.
    writeFileSync(entry, `console.log(JSON.stringify({ args: process.argv.slice(2), channel: typeof process.send === "function" }));
process.on("SIGTERM", () => { console.log("draining"); process.exit(0); });
setInterval(() => {}, 1000);
`);
    const child = spawnOwnedUp(["--laptop", "--no-open"], { cwd: dir, databaseFile: join(dir, "state.db"), entry });
    await vi.waitFor(() => expect(child.tail().length).toBeGreaterThan(0));
    expect(JSON.parse(child.tail()[0]!)).toEqual({ args: ["up", "--laptop", "--no-open", "--db", join(dir, "state.db")], channel: true });
    expect(child.running()).toBe(true);
    child.stop();
    expect(await child.exited).toBe(0);
    expect(child.running()).toBe(false);
    expect(child.tail()).toContain("draining");
  });
});
