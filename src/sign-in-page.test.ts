/**
 * Eight k1: every credential-bearing open (the demo, `up`'s greeting, the terminal UI's `w`, `toolroll open --web`) goes
 * through sign-in-page.ts — the link in a 0600 page in a fresh 0700 folder, only the platform's own opener started, with
 * the page's path as its one argument (what `ps` would show), never TOOLROLL_BROWSER_COMMAND, and the page gone once the
 * link is spent, at the mint's deadline, or on stop. The opener's channel is seen through its injected spawn, which
 * starts real programs (node, or one that isn't there); no browser opens.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { spawn, type SpawnOptions } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openLocalSignIn } from "./easy-start.js";
import { instanceRunDir } from "./console-instance.js";
import { ledgerSpent, NO_SAFE_OPENER, openSignInLink, openSignInPage, removeSignInPage, removeSignInPageWhenSpent, writeSignInPage, type SignInOpener } from "./sign-in-page.js";
import { openStore, type Store } from "./store.js";

const CODE = "Abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE";
const LINK = `http://127.0.0.1:4471/login/once/${CODE}`;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const one of cleanups.splice(0).reverse()) one(); vi.unstubAllEnvs(); });

function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "so-k1-")));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
/** The opener's channel: exactly what each start was handed. It then runs a real program (node) that exits `code`. */
function recording(code = 0): { opener: SignInOpener; started: { command: string; args: string[] }[] } {
  const started: { command: string; args: string[] }[] = [];
  return { started, opener: (command, args, options: SpawnOptions) => { started.push({ command, args: [...args] }); return spawn(process.execPath, ["-e", `process.exit(${code})`], options); } };
}
const until = async (done: () => boolean, ms = 3_000): Promise<void> => {
  for (const deadline = Date.now() + ms; !done() && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 20));
};
const signedIn = (store: Store, outcome: string, actor = "owner"): void => {
  store.recordAction({ at: new Date().toISOString(), actor, repo: null, taskId: null, runId: null, action: "signed in", outcome, source: "sign-in", detail: null });
};
const platformCommand = process.platform === "darwin" ? "open" : "xdg-open";
const later = () => Date.now() + 600_000;

describe("the opener", () => {
  test("only the platform's own, handed only the page's path; TOOLROLL_BROWSER_COMMAND is never honoured for a credential", async () => {
    vi.stubEnv("TOOLROLL_BROWSER_COMMAND", "/tmp/logs-every-argument");
    for (const [platform, command] of [["darwin", "open"], ["linux", "xdg-open"]] as const) {
      const { opener, started } = recording();
      expect(await openSignInPage("/state/.toolroll-run/sign-in-x/open.html", opener, platform)).toBe(true);
      expect(started).toEqual([{ command, args: ["/state/.toolroll-run/sign-in-x/open.html"] }]);
    }
    const { opener, started } = recording();
    expect(await openSignInPage("/state/sign-in-x/open.html", opener, "win32")).toBe(false);
    expect(started).toEqual([]);
  });

  test("an opener that isn't there (reported after spawn returns) or exits with a failure is not opened, and nothing is thrown", async () => {
    const uncaught: unknown[] = [];
    const seen = (error: unknown): void => { uncaught.push(error); };
    process.on("uncaughtException", seen);
    cleanups.push(() => process.off("uncaughtException", seen));
    // The real default spawn, with a PATH that has no `open`/`xdg-open`: ENOENT arrives as the child's error event.
    vi.stubEnv("PATH", scratch());
    expect(await openSignInPage("/state/sign-in-x/open.html")).toBe(false);
    vi.unstubAllEnvs();
    // An injected start of a program that isn't there.
    expect(await openSignInPage("/state/sign-in-x/open.html", (_command, args, options) => spawn(join(scratch(), "no-such-opener"), args, options))).toBe(false);
    // An opener that runs and fails.
    expect(await openSignInPage("/state/sign-in-x/open.html", recording(3).opener)).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(uncaught).toEqual([]);
  });

  test("a failed opener leaves no page behind", async () => {
    const parent = scratch();
    for (const opener of [recording(1).opener, ((_command: string, args: string[], options: SpawnOptions) => spawn(join(parent, "missing"), args, options)) as SignInOpener]) {
      const page = await openSignInLink(LINK, { parent, spent: () => false, expiresAt: later(), opener });
      expect(page.opened).toBe(false);
    }
    expect(readdirSync(parent).filter(name => name.startsWith("sign-in-"))).toEqual([]);
  });
});

describe("the page", () => {
  test("0600 in a fresh 0700 folder, no referrer, and gone at the link's deadline unspent", async () => {
    const parent = scratch();
    const { opener, started } = recording();
    const page = await openSignInLink(LINK, { parent, spent: () => false, opener, expiresAt: Date.now() + 1_000, everyMs: 20 });
    expect(page.opened).toBe(true);
    const file = started[0]!.args[0]!;
    expect(started).toEqual([{ command: platformCommand, args: [file] }]);
    expect(file).not.toContain(CODE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
    expect(readFileSync(file, "utf8")).toContain('<meta name="referrer" content="no-referrer">');
    expect(readFileSync(file, "utf8")).toContain(`location.replace(${JSON.stringify(LINK)})`);
    await until(() => !existsSync(file));
    expect(existsSync(dirname(file))).toBe(false);
  });

  test("the deadline is the mint's, not the page's: a link already past it leaves no page", async () => {
    const parent = scratch();
    const { opener } = recording();
    await openSignInLink(LINK, { parent, spent: () => false, opener, expiresAt: Date.now() - 1 });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(readdirSync(parent)).toEqual([]);
  });

  test("gone once spent, or at once on stop; a failing check deletes it too; no opener writes nothing", async () => {
    const parent = scratch();
    let spent = false;
    const one = recording();
    await openSignInLink(LINK, { parent, spent: () => spent, opener: one.opener, expiresAt: later(), everyMs: 20 });
    const spentFile = one.started[0]!.args[0]!;
    expect(existsSync(spentFile)).toBe(true);
    spent = true;
    await until(() => !existsSync(spentFile));
    expect(existsSync(spentFile)).toBe(false);

    const two = recording();
    let ended = 0;
    const page = await openSignInLink(LINK, { parent, spent: () => false, opener: two.opener, expiresAt: later(), onEnd: () => { ended += 1; } });
    page.stop();
    page.stop();
    expect(existsSync(two.started[0]!.args[0]!)).toBe(false);
    expect(ended).toBe(1);

    const three = recording();
    await openSignInLink(LINK, { parent, spent: () => { throw Error("unreadable"); }, opener: three.opener, expiresAt: later(), everyMs: 20 });
    await until(() => !existsSync(three.started[0]!.args[0]!));
    expect(existsSync(three.started[0]!.args[0]!)).toBe(false);

    const elsewhere = await openSignInLink(LINK, { parent, spent: () => false, opener: recording().opener, expiresAt: later(), platform: "win32" });
    expect(elsewhere.opened).toBe(false);
    expect(readdirSync(parent)).toEqual([]);
  });

  test("wait: holds the caller until the link is spent, or at most the time given, then the page goes", async () => {
    const parent = scratch();
    const one = recording();
    const bounded = await openSignInLink(LINK, { parent, spent: () => false, opener: one.opener, expiresAt: later(), everyMs: 20 });
    const started = Date.now();
    await bounded.wait(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
    expect(existsSync(one.started[0]!.args[0]!)).toBe(false);
    let spent = false;
    const two = recording();
    const used = await openSignInLink(LINK, { parent, spent: () => spent, opener: two.opener, expiresAt: later(), everyMs: 20 });
    setTimeout(() => { spent = true; }, 100);
    const before = Date.now();
    await used.wait(10_000);
    expect(Date.now() - before).toBeLessThan(2_000);
    expect(existsSync(two.started[0]!.args[0]!)).toBe(false);
  });

  test("a deletion that fails still ends the watch (what it reads is closed) and is tried again, a bounded number of times", async () => {
    const parent = scratch();
    const file = writeSignInPage(parent, LINK);
    let tries = 0, ended = 0;
    const watch = removeSignInPageWhenSpent(file, () => false, { expiresAt: later(), onEnd: () => { ended += 1; },
      remove: path => { tries += 1; if (tries < 3) throw Object.assign(Error("permission denied"), { code: "EACCES" }); removeSignInPage(path); } });
    watch.stop();
    expect(ended).toBe(1);
    await watch.gone;
    await until(() => !existsSync(file));
    expect(tries).toBe(3);
    expect(existsSync(file)).toBe(false);
    let always = 0;
    const stuck = removeSignInPageWhenSpent(writeSignInPage(parent, LINK), () => false, { expiresAt: later(), remove: () => { always += 1; throw Error("EACCES"); } });
    stuck.stop();
    await new Promise(resolve => setTimeout(resolve, 1_500));
    expect(always).toBe(4);
  });

  test("removal touches only a page file inside a page folder: never anything else, never through a link", () => {
    const parent = scratch();
    const precious = join(parent, "precious");
    mkdirSync(precious);
    writeFileSync(join(precious, "open.html"), "keep");
    expect(() => removeSignInPage(join(precious, "open.html"))).toThrow(/isn't a sign-in page/);
    expect(() => removeSignInPage(join(parent, "sign-in-abcdef", "other.txt"))).toThrow(/isn't a sign-in page/);
    symlinkSync(precious, join(parent, "sign-in-linked"));
    expect(() => removeSignInPage(join(parent, "sign-in-linked", "open.html"))).toThrow(/isn't a sign-in page's folder/);
    expect(readFileSync(join(precious, "open.html"), "utf8")).toBe("keep");
    // One that is already gone is fine.
    expect(() => removeSignInPage(join(parent, "sign-in-zzzzzz", "open.html"))).not.toThrow();
  });

  test("a page a killed process left behind goes with the next one, once older than a link lives", () => {
    const parent = scratch();
    const old = writeSignInPage(parent, LINK);
    const recent = writeSignInPage(parent, LINK);
    const longAgo = new Date(Date.now() - 11 * 60_000);
    utimesSync(dirname(old), longAgo, longAgo);
    mkdirSync(join(parent, "sign-in-notours-x"));
    writeSignInPage(parent, LINK);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(join(parent, "sign-in-notours-x"))).toBe(true);
  });

  test("the ledger: only a sign-in after the page was made counts, and only for its account", () => {
    const dir = scratch();
    const store = openStore(join(dir, "orders.db"));
    cleanups.push(() => store.close());
    signedIn(store, "one-time link", "demo");
    const forDemo = ledgerSpent(store, "one-time link", "demo");
    const anyLocal = ledgerSpent(store, "local link", null);
    expect(forDemo()).toBe(false);
    signedIn(store, "one-time link", "someone-else");
    signedIn(store, "local link", "owner");
    expect(forDemo()).toBe(false);
    expect(anyLocal()).toBe(true);
    signedIn(store, "one-time link", "demo");
    expect(forDemo()).toBe(true);
  });
});

describe("the terminal UI's w and `toolroll open --web` (openLocalSignIn)", () => {
  function database(): { file: string; store: Store } {
    const dir = scratch();
    const file = join(dir, "orders.db");
    const store = openStore(file);
    cleanups.push(() => store.close());
    return { file, store };
  }

  test("the opener gets the page's path in the database's run folder, never the link; TOOLROLL_BROWSER_COMMAND is ignored; the page goes once the console records the sign-in", async () => {
    vi.stubEnv("TOOLROLL_BROWSER_COMMAND", "/tmp/logs-every-argument");
    const { file, store } = database();
    const { opener, started } = recording();
    const said = await openLocalSignIn(file, "x", { request: async () => ({ ok: true, url: LINK }), opener, everyMs: 20 });
    expect(said.ok).toBe(true);
    expect(started).toHaveLength(1);
    expect(started[0]!.command).toBe(platformCommand);
    const page = started[0]!.args[0]!;
    expect(started[0]!.args).toEqual([page]);
    expect(dirname(dirname(page))).toBe(instanceRunDir(file));
    expect(started[0]!.args.join(" ")).not.toMatch(/login|once|Abcdefghij/);
    expect(statSync(page).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(page)).mode & 0o777).toBe(0o700);
    expect(statSync(instanceRunDir(file)).mode & 0o777).toBe(0o700);
    // An account's link (not this road's) is not this page's sign-in.
    signedIn(store, "one-time link");
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(existsSync(page)).toBe(true);
    signedIn(store, "local link");
    await until(() => !existsSync(page));
    expect(existsSync(page)).toBe(false);
  });

  test("the link's deadline counts from before it was minted: a slow mint leaves the page no extra life", async () => {
    const { file } = database();
    const { opener } = recording();
    const said = await openLocalSignIn(file, "x", { request: async () => { await new Promise(resolve => setTimeout(resolve, 300)); return { ok: true, url: LINK }; }, opener, expiresMs: 250, everyMs: 20 });
    expect(said.ok).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(readdirSync(instanceRunDir(file))).toEqual([]);
  });

  test("an unspent page goes when the link expires", async () => {
    const { file } = database();
    const { opener, started } = recording();
    expect((await openLocalSignIn(file, "x", { request: async () => ({ ok: true, url: LINK }), opener, expiresMs: 1_000, everyMs: 20 })).ok).toBe(true);
    const page = started[0]!.args[0]!;
    expect(existsSync(page)).toBe(true);
    await until(() => !existsSync(page));
    expect(existsSync(page)).toBe(false);
  });

  test("no opener here (Windows): nothing is asked for, written or opened, and it says plainly what to do instead — a password, never a link", async () => {
    const { file } = database();
    let asked = 0;
    const { opener, started } = recording();
    const none = await openLocalSignIn(file, "x", { request: async () => { asked += 1; return { ok: true, url: LINK }; }, opener, platform: "win32" });
    expect(none).toEqual({ ok: false, message: NO_SAFE_OPENER });
    expect(NO_SAFE_OPENER).toContain("run `toolroll password set` and sign in with that password");
    expect(NO_SAFE_OPENER).not.toMatch(/login\/once|http/);
    expect(asked).toBe(0);
    const refused = await openLocalSignIn(file, "x", { request: async () => ({ ok: false, message: "local mode is off" }), opener });
    expect(refused).toEqual({ ok: false, message: "local mode is off" });
    expect(started).toEqual([]);
    const failing = await openLocalSignIn(file, "x", { request: async () => ({ ok: true, url: LINK }), opener: recording(1).opener });
    expect(failing.ok).toBe(false);
    expect(existsSync(instanceRunDir(file)) ? readdirSync(instanceRunDir(file)) : []).toEqual([]);
  });

  test("`toolroll open --web` against a console already running: the process stays until the browser has used the link, so the page is still there to read", async () => {
    const { file, store } = database();
    const dir = dirname(file);
    const log = join(dir, "opened.txt");
    const easyStart = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "easy-start.js");
    const script = join(dir, "open-web.mjs");
    writeFileSync(script, `
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { openLocalSignIn, runEasyStart } from ${JSON.stringify(easyStart)};
const [db, log] = process.argv.slice(2);
const live = { ok: true, url: "http://127.0.0.1:4479", port: 4479, pid: 1, build: "x" };
const seams = {
  databaseFile: db, cwd: "/", write: line => console.log(line), prove: async () => live, localMode: () => "on",
  serviceInstalled: () => false, passwordByLaptopStart: () => false, openBrowser: () => { throw Error("never for a link"); },
  openSignedIn: () => openLocalSignIn(db, "x", { request: async () => ({ ok: true, url: ${JSON.stringify(LINK)} }), everyMs: 20,
    opener: (command, args, options) => { appendFileSync(log, args[0] + "\\n"); return spawn(process.execPath, ["-e", ""], options); } }),
};
const code = await runEasyStart("open", { web: true, projectRoot: null }, seams);
console.log("exit " + code);
`);
    const child = spawn(process.execPath, [script, file, log], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", chunk => { out += String(chunk); });
    child.stderr.on("data", chunk => { out += String(chunk); });
    let exited = false;
    const done = new Promise<void>(resolve => child.once("exit", () => { exited = true; resolve(); }));
    cleanups.push(() => { if (!exited) child.kill(); });
    await until(() => existsSync(log) && readFileSync(log, "utf8").trim() !== "", 10_000);
    const page = readFileSync(log, "utf8").trim();
    // Well after the opener was handed the page, the process is still there and so is the page.
    await new Promise(resolve => setTimeout(resolve, 700));
    expect(exited, out).toBe(false);
    expect(existsSync(page)).toBe(true);
    expect(out).toContain("Opening Toolroll in your browser…");
    // The browser uses the link (the console records it): the page goes and the process ends.
    signedIn(store, "local link");
    await Promise.race([done, new Promise(resolve => setTimeout(resolve, 5_000))]);
    expect(exited, out).toBe(true);
    expect(existsSync(page)).toBe(false);
    expect(out).toContain("exit 0");
    expect(out).not.toContain(CODE);
  });
});
