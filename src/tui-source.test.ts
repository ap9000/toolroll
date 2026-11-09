/**
 * The terminal UI on the real plane (easy-start plan C3, E): the screen (ink-testing-library) on tui-source.ts over a
 * temporary laptop database, every write through the real runOperate as the local owner. Filing and approving (the
 * full plan first, then exactly its digest) succeed and are recorded as the local owner's from the terminal; local mode
 * turned off refuses the screen's writes with words that lead to a password; and the commands the screen must never
 * reach as the local owner (the background service, stop, settings, credentials) are refused before they run.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, render } from "ink-testing-library";
import { createElement } from "react";
import { App } from "./tui/app.js";
import { createTuiSource } from "./tui-source.js";
import { runAsLocalOwner } from "./local-owner.js";
import { runOperate } from "./operate.js";
import { saveRepos } from "./repos.js";
import { propose } from "./scope.js";
import { initLocalMode, openStore, setLocalModeOff } from "./store.js";
import type { TuiSession } from "./tui-contract.js";

const now = new Date("2026-11-04T09:00:00Z");
let root: string, file: string, repo: string;
const session: TuiSession = { owned: () => false, openBrowser: async () => "", shouldAskBackground: () => false, answerBackground: async () => "" };
const check = async () => ({ state: "connected" as const, mode: "subscription" as const, checkedAt: now.toISOString() });

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "so-tui-real-")));
  file = join(root, "state.db");
  repo = join(root, "shop");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  await saveRepos(join(root, "repos.json"), [repo]);
  const store = openStore(file, { createdBy: "laptop" });
  try {
    if (!initLocalMode(store, { owner: "alex", fenceAvailable: true, now }).ok) throw Error("local mode");
    for (const phase of ["plan", "build", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "fixture", now);
    const made = store.createConsoleTask({ id: "one", title: "Fix the footer link", repo, goal: "Make the footer link work.", acceptance: [{ id: "c1", statement: "The footer link opens the page.", evidence: ["manual-review"] }], filedVia: "cli" }, now);
    if (!made.ok) throw Error(made.reason);
    propose(store, { now, taskId: "one", goal: "Make the footer link work." });
  } finally { store.close(); }
});
afterEach(() => { cleanup(); rmSync(root, { recursive: true, force: true }); });

function screen() {
  const source = createTuiSource({ databaseFile: file, operate: { now }, check });
  const app = render(createElement(App, { source, session, pollMs: 50 }));
  const shows = (text: string) => vi.waitFor(() => expect(app.lastFrame()).toContain(text), { timeout: 15_000 });
  return { app, shows, close: () => source.close() };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

describe("the terminal UI on a laptop database", () => {
  test("a: the whole plan, then y approves exactly it, as the local owner from the terminal", async () => {
    const { app, shows, close } = screen();
    try {
      await shows("> Fix the footer link");
      await settle();
      app.stdin.write("a");
      await shows("Approve this plan?");
      await shows("Make the footer link work.");
      app.stdin.write("y");
      await shows("Approved. An agent starts on it.");
    } finally { close(); }
    const store = openStore(file);
    try {
      const proof = store.handle.prepare("SELECT outcome, detail FROM action_ledger WHERE task_id = 'one' AND action = 'approval proved'").get()!;
      expect(proof["outcome"]).toBe("local-owner");
      expect(String(proof["detail"])).toContain(" · local 1 terminal · ");
    } finally { store.close(); }
  });

  test("n files a task in the project from the composer", async () => {
    const { app, shows, close } = screen();
    try {
      await shows("> Fix the footer link");
      await settle();
      app.stdin.write("n");
      await shows("New task");
      app.stdin.write("Add a dark mode toggle");
      await shows("Add a dark mode toggle");
      app.stdin.write("\r");
      await shows("Filed.");
      await shows("Add a dark mode toggle");
    } finally { close(); }
    const store = openStore(file);
    try {
      const row = store.handle.prepare("SELECT title, repo FROM task_ref r JOIN task t ON t.id = r.external_id WHERE t.title = 'Add a dark mode toggle'").get();
      expect(row?.["repo"]).toBe(repo);
    } finally { store.close(); }
  });

  test("local mode turned off: the screen's write is refused, and it leads to a password", async () => {
    const { app, shows, close } = screen();
    try {
      await shows("> Fix the footer link");
      const store = openStore(file);
      try { expect(setLocalModeOff(store, { name: "alex", authority: "full" }, now)).toMatchObject({ ok: true }); } finally { store.close(); }
      await settle();
      app.stdin.write("n");
      await shows("New task");
      app.stdin.write("Anything");
      await shows("Anything");
      app.stdin.write("\r");
      await shows("This needs your password");
      await shows("Local mode is off. Sign in with your password in the browser.");
    } finally { close(); }
  });

  test("what the screen must never do as the local owner is refused before it runs; its own acts are allowed", async () => {
    const asOwner = async (argv: string[]) => {
      let out = "";
      const code = await runAsLocalOwner(() => runOperate(argv[0]!, [...argv.slice(1), "--json", "--db", file], text => { out += text; }, { now, laptopSeams: { home: root } }));
      return { code, envelope: JSON.parse(out) as Record<string, unknown> };
    };
    const refused = [
      ["background", "on"], ["background", "off"], ["background", "show"], ["stop"], ["open"], ["password", "set"],
      ["config", "set", "build", "--provider", "codex"], ["mode", "set", "--repo", repo], ["tokens", "create"], ["approver", "add", "eve"],
      ["project", "network", "--repo", repo, "--open"], ["up"], ["keys", "set", "anthropic"], ["people", "invite", "eve"],
    ];
    const wrong: string[] = [];
    for (const argv of refused) {
      const { code, envelope } = await asOwner(argv);
      if (code === 0 || envelope["reason"] !== "refused") wrong.push(`${argv.join(" ")}: ${code} ${JSON.stringify(envelope).slice(0, 120)}`);
    }
    expect(wrong).toEqual([]);
    for (const argv of [["task", "list"], ["task", "show", "one"], ["welcome"], ["status"]]) expect((await asOwner(argv)).code, argv.join(" ")).toBe(0);
  }, 60_000);
});

test("the screen closing while setup waits on the sign-in checks answers nothing, and opens nothing again", async () => {
  let go = (): void => {};
  const gate = new Promise<void>(resolve => { go = resolve; });
  const source = createTuiSource({ databaseFile: file, operate: { now }, check: async () => { await gate; return check(); } });
  const asked = source.setup();
  source.close();
  go();
  await expect(asked).resolves.toBeNull();
  await expect(source.setup()).resolves.toBeNull();
});

describe("text someone else wrote reaches the screen clean", () => {
  test("a title and a plan line carrying escapes and overwrite tricks come out of the source as plain text, the whole plan kept", async () => {
    const hostile = "Make the footer link work.\x1b[2J\x1b]8;;https://evil.example\x07 see docs\x1b]8;;\x07\x1b[1A\x9b2K done\rhidden";
    const store = openStore(file);
    try {
      store.handle.prepare("UPDATE task SET title = ? WHERE id = 'one'").run("Fix the footer link\x1b[31m\x1b]0;owned\x07");
      store.handle.prepare("UPDATE task_scope SET goal = ? WHERE task_id = 'one'").run(hostile);
    } finally { store.close(); }
    const source = createTuiSource({ databaseFile: file, operate: { now }, check });
    try {
      const control = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/;
      const listed = await source.snapshot();
      const row = listed.rows.find(one => one.id === "one")!;
      expect(row.title).toBe("Fix the footer link");
      // Home's group, by the same rule over the same work index item: a plan waiting for approval waits on you.
      expect(row.group).toBe("you");
      const task = (await source.task("one"))!;
      expect(task.title).toBe("Fix the footer link");
      const lines = task.plan!.lines;
      expect(lines.some(line => line.includes("Make the footer link work. see docs donehidden"))).toBe(true);
      for (const text of [row.title, row.status, row.detail, task.title, task.status, task.detail, ...lines]) expect(text, text).not.toMatch(control);
    } finally { source.close(); }
  });
});
