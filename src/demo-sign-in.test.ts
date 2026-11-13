/**
 * Eight W2: `toolroll demo` opens signed in through a one-time link — security rules. Only a person at the demo's own
 * terminal gets one; only for the sandbox's fixed demo account; only on a loopback origin built from the address the
 * server actually bound (never --allow-host or any input); single use; useless against any other server; the code
 * never reaches the ledger. Real demo sandboxes and real servers on ephemeral loopback ports; no browser opens.
 */
import { afterEach, describe, expect, test } from "vitest";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { AddressInfo } from "node:net";
import { main } from "./cli.js";
import { createDemoSandbox } from "./demo.js";
import { demoLoopbackOrigin, demoSignInLink, openSignInPage, removeSignInPageWhenSpent, writeSignInPage, type DemoCaller } from "./demo-sign-in.js";
import { createDecisionServer } from "./serve.js";

const PERSON: DemoCaller = { stdin: true, stdout: true, agent: false, json: false };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const one of cleanups.splice(0).reverse()) await one(); });

/** A real demo sandbox served on `host` (port picked by the system), as `toolroll demo` serves it. */
async function demo(host: string, allowedHosts: string[] = []) {
  const made = createDemoSandbox(new Date());
  const server = createDecisionServer({ store: made.store, evidenceRoot: made.evidenceRoot, clock: () => new Date(), repos: made.seed.repos, demoLead: made.lead, ...(allowedHosts.length === 0 ? {} : { allowedHosts }) });
  cleanups.push(async () => {
    made.lead.stop();
    await new Promise<void>(closed => server.close(() => closed()));
    made.store.close();
    rmSync(made.sandbox, { recursive: true, force: true });
  });
  await new Promise<void>((ready, failed) => { server.once("error", failed); server.listen(0, host, ready); });
  return { ...made, server, port: (server.address() as AddressInfo).port };
}
const visit = (url: string) => fetch(url, { redirect: "manual" });

describe("where a demo sign-in link may point", () => {
  test("only the bound loopback address: 127.0.0.1 or ::1, never a wildcard, a LAN address or a name", () => {
    expect(demoLoopbackOrigin({ address: "127.0.0.1", family: "IPv4", port: 4351 })).toBe("http://127.0.0.1:4351");
    expect(demoLoopbackOrigin({ address: "::1", family: "IPv6", port: 4351 })).toBe("http://[::1]:4351");
    for (const address of ["0.0.0.0", "::", "192.168.1.20", "100.64.0.7", "::ffff:127.0.0.1", "localhost", "demo.example"]) {
      expect(demoLoopbackOrigin({ address, family: "IPv4", port: 4351 }), address).toBeNull();
    }
    expect(demoLoopbackOrigin("/tmp/socket")).toBeNull();
    expect(demoLoopbackOrigin(null)).toBeNull();
    expect(demoLoopbackOrigin({ address: "127.0.0.1", family: "IPv4", port: 0 })).toBeNull();
  });

  test.each([
    ["stdin not a terminal (piped)", { stdin: false }],
    ["stdout not a terminal", { stdout: false }],
    ["under a coding agent", { agent: true }],
    ["--json", { json: true }],
  ] as [string, Partial<DemoCaller>][])("%s: nothing is minted", (_label, change) => {
    let minted = 0;
    const server = { mintSignInLink: () => { minted += 1; return "/login/once/x"; }, address: () => ({ address: "127.0.0.1", family: "IPv4", port: 4351 }) };
    expect(demoSignInLink(server, "demo", { ...PERSON, ...change })).toBeNull();
    expect(minted).toBe(0);
  });

  test("a wildcard bind: nothing is minted", () => {
    let minted = 0;
    const server = { mintSignInLink: () => { minted += 1; return "/login/once/x"; }, address: () => ({ address: "0.0.0.0", family: "IPv4", port: 4351 }) };
    expect(demoSignInLink(server, "demo", PERSON)).toBeNull();
    expect(minted).toBe(0);
  });
});

describe("the demo's link, against real servers", () => {
  test("signs this computer's browser in once, as the demo account; a replay is refused; the code never reaches the ledger", async () => {
    const one = await demo("127.0.0.1");
    const link = demoSignInLink(one.server, one.seed.login.name, PERSON)!;
    expect(link).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${one.port}/login/once/[A-Za-z0-9_-]{43}$`));
    const first = await visit(link);
    expect(first.headers.get("set-cookie") ?? "").toMatch(/HttpOnly/);
    expect([303, 200]).toContain(first.status);
    const replay = await visit(link);
    expect(replay.status).toBe(410);
    expect(replay.headers.get("set-cookie")).toBeNull();
    const code = link.slice(link.lastIndexOf("/") + 1);
    const ledger = one.store.handle.prepare("SELECT action, outcome, detail FROM action_ledger WHERE source = 'sign-in'").all().map(row => ({ ...row }));
    expect(ledger).toContainEqual({ action: "signed in", outcome: "one-time link", detail: null });
    expect(JSON.stringify(one.store.handle.prepare("SELECT * FROM action_ledger").all())).not.toContain(code);
  });

  test("a code minted by one demo is refused by another server", async () => {
    const one = await demo("127.0.0.1");
    const other = await demo("127.0.0.1");
    const link = demoSignInLink(one.server, one.seed.login.name, PERSON)!;
    const elsewhere = await visit(link.replace(`:${one.port}/`, `:${other.port}/`));
    expect(elsewhere.status).toBe(410);
    expect(elsewhere.headers.get("set-cookie")).toBeNull();
    // Still unspent where it was minted: the other server's refusal took nothing from it.
    expect((await visit(link)).headers.get("set-cookie") ?? "").toMatch(/HttpOnly/);
  });

  test("with --allow-host, the link is still on the loopback origin it was bound to, never the allowed name", async () => {
    const one = await demo("127.0.0.1", ["demo.example:8443"]);
    const link = demoSignInLink(one.server, one.seed.login.name, PERSON)!;
    expect(link.startsWith(`http://127.0.0.1:${one.port}/login/once/`)).toBe(true);
    expect(link).not.toContain("demo.example");
    expect((await visit(link)).headers.get("set-cookie") ?? "").toMatch(/HttpOnly/);
  });

  test("IPv6 loopback: the link is on [::1], and works there", async () => {
    let one: Awaited<ReturnType<typeof demo>>;
    try { one = await demo("::1"); } catch (error) {
      // Only a machine with no IPv6 loopback skips this; any other failure is a failure.
      if (["EADDRNOTAVAIL", "EAFNOSUPPORT"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      throw error;
    }
    const link = demoSignInLink(one.server, one.seed.login.name, PERSON)!;
    expect(link.startsWith(`http://[::1]:${one.port}/login/once/`)).toBe(true);
    expect((await visit(link)).headers.get("set-cookie") ?? "").toMatch(/HttpOnly/);
  });

  test("a wildcard bind (0.0.0.0): no link is minted", async () => {
    const one = await demo("0.0.0.0");
    let minted = 0;
    const counting = { mintSignInLink: (account: string) => { minted += 1; return one.server.mintSignInLink(account); }, address: () => one.server.address() };
    expect(demoSignInLink(counting, one.seed.login.name, PERSON)).toBeNull();
    expect(minted).toBe(0);
  });
});

describe("toolroll demo", () => {
  /** `toolroll demo` until its greeting is out, then stopped (its stop seam), with what it opened. */
  /** `toolroll demo` until its greeting is out (or, with `whileUp`, until that is done too), then stopped (its stop
   * seam), with the page paths it handed the opener. */
  async function runDemo(argv: string[], caller: { terminal: boolean; underAgent: boolean }, whileUp: (opened: string[]) => Promise<void> = async () => {}): Promise<{ out: string[]; opened: string[] }> {
    const out: string[] = [], opened: string[] = [];
    let stop: () => void = () => {};
    const stopped = new Promise<void>(resolve => { stop = resolve; });
    const code = await main(["demo", "--port", "0", ...argv], line => { out.push(line); if (/Ctrl-C|"command":\s*"demo"/.test(line)) void whileUp(opened).finally(stop); }, {
      demo: { ...caller, openPage: file => { opened.push(file); }, stop: stopped },
    });
    expect(code).toBe(0);
    return { out, opened };
  }

  test("a person at its terminal: the opener gets only a 0600 page's path, never the link; the page signs in and goes once spent", async () => {
    const seen: { mode: number; dirMode: number; link: string; signedIn: string; goneAfter: boolean }[] = [];
    const { out, opened } = await runDemo([], { terminal: true, underAgent: false }, async files => {
      // The greeting comes first; the page is handed over right after it.
      for (const deadline = Date.now() + 5_000; files.length === 0 && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 20));
      const file = files[0]!;
      const link = /location\.replace\("([^"]+)"\)/.exec(readFileSync(file, "utf8"))![1]!;
      const mode = statSync(file).mode & 0o777, dirMode = statSync(dirname(file)).mode & 0o777;
      const signedIn = (await fetch(link, { redirect: "manual" })).headers.get("set-cookie") ?? "";
      for (const deadline = Date.now() + 5_000; existsSync(file) && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 100));
      seen.push({ mode, dirMode, link, signedIn, goneAfter: !existsSync(file) });
    });
    expect(opened).toHaveLength(1);
    // What the opener was handed: a path, with no code in it.
    expect(opened[0]).toMatch(/\/sign-in-[^/]+\/open\.html$/);
    expect(opened[0]).not.toMatch(/login|once|[A-Za-z0-9_-]{43}/);
    expect(seen[0]).toMatchObject({ mode: 0o600, dirMode: 0o700, goneAfter: true });
    expect(seen[0]!.link).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/login\/once\/[A-Za-z0-9_-]{43}$/);
    expect(seen[0]!.signedIn).toMatch(/HttpOnly/);
    expect(out.join("\n")).not.toContain("/login/once/");
    expect(out).toContain("For your own project, run `toolroll` in its folder.");
  });

  test("an unspent page is deleted when the demo stops", async () => {
    const { opened } = await runDemo([], { terminal: true, underAgent: false });
    expect(opened).toHaveLength(1);
    expect(existsSync(opened[0]!)).toBe(false);
  });

  test("under a coding agent, without a terminal, or with --json: no link is minted, printed or opened", async () => {
    for (const [argv, caller] of [[[], { terminal: true, underAgent: true }], [[], { terminal: false, underAgent: false }], [["--json"], { terminal: true, underAgent: false }]] as [string[], { terminal: boolean; underAgent: boolean }][]) {
      const { out, opened } = await runDemo(argv, caller);
      expect(opened, JSON.stringify(caller)).toEqual([]);
      expect(out.join("\n")).not.toContain("/login/once/");
    }
  });

  test("bound beyond loopback (--host 0.0.0.0): no link; today's greeting", async () => {
    const { out, opened } = await runDemo(["--host", "0.0.0.0"], { terminal: true, underAgent: false });
    expect(opened).toEqual([]);
    expect(out.join("\n")).not.toContain("/login/once/");
  });
});

describe("how the link reaches the browser", () => {
  test("only the platform's own opener, handed the page's path: TOOLROLL_BROWSER_COMMAND is not honoured for a credential", () => {
    const was = process.env["TOOLROLL_BROWSER_COMMAND"];
    process.env["TOOLROLL_BROWSER_COMMAND"] = "/tmp/logs-every-argument";
    try {
      for (const [platform, command] of [["darwin", "open"], ["linux", "xdg-open"]] as const) {
        const calls: { command: string; args: string[] }[] = [];
        expect(openSignInPage("/sandbox/sign-in-x/open.html", (one, args) => { calls.push({ command: one, args }); return { unref: () => {} }; }, platform)).toBe(true);
        expect(calls).toEqual([{ command, args: ["/sandbox/sign-in-x/open.html"] }]);
      }
      const none: string[] = [];
      expect(openSignInPage("/sandbox/sign-in-x/open.html", one => { none.push(one); return { unref: () => {} }; }, "win32")).toBe(false);
      expect(none).toEqual([]);
    } finally {
      if (was === undefined) delete process.env["TOOLROLL_BROWSER_COMMAND"];
      else process.env["TOOLROLL_BROWSER_COMMAND"] = was;
    }
  });

  test("the page: 0600 in a fresh 0700 folder; an unspent one goes when the link expires", async () => {
    const one = await demo("127.0.0.1");
    const link = demoSignInLink(one.server, one.seed.login.name, PERSON)!;
    const file = writeSignInPage(one.sandbox, link);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
    expect(readFileSync(file, "utf8")).toContain(`location.replace(${JSON.stringify(link)})`);
    removeSignInPageWhenSpent(one.store, file, one.seed.login.name, { everyMs: 20, expiresMs: 150 });
    expect(existsSync(file)).toBe(true);
    for (const deadline = Date.now() + 3_000; existsSync(file) && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 20));
    expect(existsSync(file)).toBe(false);
  });
});
