/**
 * Eight k1: every credential-bearing open (the demo, `up`'s greeting, the terminal UI's `w`, `toolroll open --web`) goes
 * through sign-in-page.ts — the link in a 0600 page in a fresh 0700 folder, only the platform's own opener started, with
 * the page's path as its one argument (what `ps` would show), never TOOLROLL_BROWSER_COMMAND, and the page gone once the
 * link is spent, when it expires, or on stop. The opener's channel is seen through its injected spawn; no browser opens.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openLocalSignIn } from "./easy-start.js";
import { instanceRunDir } from "./console-instance.js";
import { ledgerSpent, openSignInLink, openSignInPage, writeSignInPage, type SignInOpener } from "./sign-in-page.js";
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
/** The opener's channel: exactly what each start was handed. */
function recording(): { opener: SignInOpener; started: { command: string; args: string[] }[] } {
  const started: { command: string; args: string[] }[] = [];
  return { started, opener: (command, args) => { started.push({ command, args: [...args] }); return { unref: () => {} }; } };
}
const until = async (done: () => boolean, ms = 3_000): Promise<void> => {
  for (const deadline = Date.now() + ms; !done() && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 20));
};
const signedIn = (store: Store, outcome: string, actor = "owner"): void => {
  store.recordAction({ at: new Date().toISOString(), actor, repo: null, taskId: null, runId: null, action: "signed in", outcome, source: "sign-in", detail: null });
};
const platformCommand = process.platform === "darwin" ? "open" : "xdg-open";

describe("the opener", () => {
  test("only the platform's own, handed only the page's path; TOOLROLL_BROWSER_COMMAND is never honoured for a credential", () => {
    vi.stubEnv("TOOLROLL_BROWSER_COMMAND", "/tmp/logs-every-argument");
    for (const [platform, command] of [["darwin", "open"], ["linux", "xdg-open"]] as const) {
      const { opener, started } = recording();
      expect(openSignInPage("/state/.toolroll-run/sign-in-x/open.html", opener, platform)).toBe(true);
      expect(started).toEqual([{ command, args: ["/state/.toolroll-run/sign-in-x/open.html"] }]);
    }
    const { opener, started } = recording();
    expect(openSignInPage("/state/sign-in-x/open.html", opener, "win32")).toBe(false);
    expect(started).toEqual([]);
  });
});

describe("the page", () => {
  test("0600 in a fresh 0700 folder, no referrer, and gone when the link expires unspent", async () => {
    const parent = scratch();
    const { opener, started } = recording();
    const page = openSignInLink(LINK, { parent, spent: () => false, opener, expiresMs: 150, everyMs: 20 });
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

  test("gone once spent, or at once on stop; an opener that can't start leaves nothing; no opener writes nothing", async () => {
    const parent = scratch();
    let spent = false;
    const one = recording();
    openSignInLink(LINK, { parent, spent: () => spent, opener: one.opener, everyMs: 20 });
    const spentFile = one.started[0]!.args[0]!;
    expect(existsSync(spentFile)).toBe(true);
    spent = true;
    await until(() => !existsSync(spentFile));
    expect(existsSync(spentFile)).toBe(false);

    const two = recording();
    let ended = 0;
    const page = openSignInLink(LINK, { parent, spent: () => false, opener: two.opener, onEnd: () => { ended += 1; } });
    page.stop();
    page.stop();
    expect(existsSync(two.started[0]!.args[0]!)).toBe(false);
    expect(ended).toBe(1);

    // A failing check deletes the page too.
    const three = recording();
    openSignInLink(LINK, { parent, spent: () => { throw Error("unreadable"); }, opener: three.opener, everyMs: 20 });
    await until(() => !existsSync(three.started[0]!.args[0]!));
    expect(existsSync(three.started[0]!.args[0]!)).toBe(false);

    const broken = openSignInLink(LINK, { parent, spent: () => false, opener: () => { throw Error("no such program"); } });
    expect(broken.opened).toBe(false);
    const elsewhere = openSignInLink(LINK, { parent, spent: () => false, opener: recording().opener, platform: "win32" });
    expect(elsewhere.opened).toBe(false);
    expect(readdirSync(parent)).toEqual([]);
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
  /** A database of this user's own, its run folder, and the link its console would mint. */
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
    expect(said).toEqual({ ok: true });
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

  test("an unspent page goes when the link expires", async () => {
    const { file } = database();
    const { opener, started } = recording();
    expect(await openLocalSignIn(file, "x", { request: async () => ({ ok: true, url: LINK }), opener, expiresMs: 150, everyMs: 20 })).toEqual({ ok: true });
    const page = started[0]!.args[0]!;
    expect(existsSync(page)).toBe(true);
    await until(() => !existsSync(page));
    expect(existsSync(page)).toBe(false);
  });

  test("no opener here: nothing is asked for, written or opened; a console that gives no link: nothing is written", async () => {
    const { file } = database();
    let asked = 0;
    const { opener, started } = recording();
    const none = await openLocalSignIn(file, "x", { request: async () => { asked += 1; return { ok: true, url: LINK }; }, opener, platform: "win32" });
    expect(none.ok).toBe(false);
    expect(asked).toBe(0);
    const refused = await openLocalSignIn(file, "x", { request: async () => ({ ok: false, message: "local mode is off" }), opener });
    expect(refused).toEqual({ ok: false, message: "local mode is off" });
    expect(started).toEqual([]);
    expect(existsSync(instanceRunDir(file)) ? readdirSync(instanceRunDir(file)) : []).toEqual([]);
  });
});
