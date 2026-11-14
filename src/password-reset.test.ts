/**
 * A forgotten password. The sign-in page's footer says, by install kind, how to get in: a password install shows where
 * the first password is saved (home folder as `~`, never an absolute home folder or the user's name, and only when the
 * file is there) and `toolroll password reset`; a password-free install says password-free sign-in works only on its
 * own computer (`toolroll open --web`), and offers the reset only once a password exists; an identity-provider install
 * keeps its own footer. `toolroll password reset` runs only for a person at this computer's own terminal — never under
 * --json, piped, under a coding agent, through a remote token or a lead token — for an account that has a password of
 * its own; it moves the account's generation in one transaction (every session ends, proved against a real console),
 * writes "password reset at this computer" to the ledger and removes the saved first password it made stale.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { EXIT, runOperate, runOperateAs, type OperateOptions, type Principal } from "./operate.js";
import { runAsLocalOwner } from "./local-owner.js";
import { addApprover, verifyCredential } from "./scope.js";
import { enrollOwnerPassword, initLocalMode, localModeOf, openStore, type Store } from "./store.js";
import { mintApiToken } from "./api-tokens.js";
import { createDecisionServer } from "./serve.js";
import { loginPage } from "./server/render-people.js";
import { htmlString } from "./html.js";
import { loginHelpOf, shownPath } from "./server/login-help.js";
import { hashPassword } from "./scope.js";

const NOW = new Date("2026-11-13T09:00:00Z");
const OLD = "old password one";
const NEW = "new password two";
const typing = (...answers: string[]) => async () => answers.shift() ?? "";

let root: string, configDir: string, file: string, savedFile: string;
const savedHome = process.env["HOME"];
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "so-pw-reset-")));
  configDir = join(root, "config"); mkdirSync(configDir);
  file = join(configDir, "orders.db");
  savedFile = join(configDir, ".toolroll-secrets", "up-login.txt");
});
afterEach(() => {
  if (savedHome === undefined) delete process.env["HOME"]; else process.env["HOME"] = savedHome;
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

/** A password install: alex with a password, and the first password saved beside the database as `up` saves it. */
function passwordInstall(saved = true): void {
  const store = openStore(file);
  try {
    if (!addApprover(store, "alex", NOW, undefined, undefined, {}, OLD).ok) throw Error("bootstrap");
    store.saveWebSession({ idHash: "h1", account: "alex", csrf: "c", role: "approver", generation: store.accountOf("alex")!.generation, createdAt: NOW.getTime(), lastSeen: NOW.getTime(),
      project: null, projectRevision: 0, ssoAt: null, agent: null, address: null, authority: "full", localGeneration: null, keyEpoch: null, keyHash: null });
  } finally { store.close(); }
  if (saved) {
    mkdirSync(join(configDir, ".toolroll-secrets"), { mode: 0o700 });
    writeFileSync(savedFile, `alex ${OLD}\n`, { mode: 0o600 });
  }
}
const withStore = <T>(fn: (store: Store) => T): T => { const store = openStore(file); try { return fn(store); } finally { store.close(); } };
const facts = () => withStore(store => ({
  ...store.accountOf("alex")!,
  sessions: Number(store.handle.prepare("SELECT COUNT(*) AS n FROM web_session WHERE account = 'alex'").get()!["n"]),
  resets: Number(store.handle.prepare("SELECT COUNT(*) AS n FROM action_ledger WHERE action = 'password reset at this computer' AND actor = 'alex'").get()!["n"]),
}));
async function reset(args: string[] = [], seams: NonNullable<OperateOptions["easySeams"]> = { terminal: true, askHidden: typing(NEW, NEW) }): Promise<{ code: number; out: string }> {
  let out = "";
  const code = await runOperate("password", ["reset", ...args, "--db", file], text => { out += `${text}\n`; }, { now: NOW, easySeams: seams });
  return { code, out };
}

describe("the sign-in page footer, by install kind", () => {
  test("a password install: the saved path with the home folder as ~, only when the file is there; never an absolute home folder", () => {
    passwordInstall();
    withStore(store => {
      const help = loginHelpOf(store, { home: root, user: "someone" });
      expect(help).toEqual({ kind: "password", savedAt: "~/config/.toolroll-secrets/up-login.txt" });
      const page = htmlString(loginPage(null, "/", null, help));
      expect(page).toContain("Forgot your password? On the computer running Toolroll, your first password is saved in");
      expect(page).toContain("(until you change it). Changed it and forgot? Run <code class=\"k-nowrap\">toolroll password reset</code> there.");
      expect(page.replace(/<wbr>/g, "")).toContain("~/config/.toolroll-secrets/up-login.txt");
      expect(page).not.toContain(root);
      expect(page).toContain("No account? Ask whoever runs this Toolroll for an invite link.");
      // The real home folder never shows either (the database here is not under it).
      expect(htmlString(loginPage(null, "/", null, loginHelpOf(store)))).not.toContain(homedir());
    });
    // No file: no path sentence, the reset line alone.
    rmSync(savedFile);
    withStore(store => {
      const help = loginHelpOf(store, { home: root, user: "someone" });
      expect(help).toEqual({ kind: "password", savedAt: null });
      const page = htmlString(loginPage(null, "/", null, help));
      expect(page).toContain("Forgot your password? Run <code class=\"k-nowrap\">toolroll password reset</code> on the computer running Toolroll.");
      expect(page).not.toContain("up-login.txt");
    });
    // An older version's file directly beside the database counts too.
    writeFileSync(join(configDir, "up-login.txt"), `alex ${OLD}\n`, { mode: 0o600 });
    withStore(store => expect(loginHelpOf(store, { home: root, user: "someone" })).toEqual({ kind: "password", savedAt: "~/config/up-login.txt" }));
  });

  test("a path outside the home folder shows as it is, unless it names the user; never the old relative words", () => {
    expect(shownPath("/srv/toolroll/.toolroll-secrets/up-login.txt", "/home/sam", "sam")).toBe("/srv/toolroll/.toolroll-secrets/up-login.txt");
    expect(shownPath("/Users/sam/elsewhere/up-login.txt", "/var/empty", "sam")).toBeNull();
    expect(shownPath("/home/sam/.config/toolroll/x", "/home/sam", "sam")).toBe("~/.config/toolroll/x");
    expect(shownPath("/home/samuel/x", "/home/sam", null)).toBe("/home/samuel/x");
    expect(htmlString(loginPage(null))).not.toContain("Your first login was shown");
  });

  test("a password-free install: why it asks, the command on its own computer, and the reset only once a password exists", () => {
    withStore(store => {
      if (!initLocalMode(store, { owner: "alex", fenceAvailable: true, now: NOW }).ok) throw Error("local mode");
      const help = loginHelpOf(store, { home: root, user: "someone" });
      expect(help).toEqual({ kind: "local", passwordSet: false });
      const page = htmlString(loginPage(null, "/", null, help));
      expect(page).toContain("Signing in without a password works only on the computer running Toolroll. There, run <code class=\"k-nowrap\">toolroll open --web</code>.");
      expect(page).not.toContain("password reset");
      expect(page).toContain("No account? Ask whoever runs this Toolroll for an invite link.");
      expect(enrollOwnerPassword(store, "alex", hashPassword(NEW), localModeOf(store)!.generation, NOW).ok).toBe(true);
      const after = htmlString(loginPage(null, "/", null, loginHelpOf(store, { home: root, user: "someone" })));
      expect(after).toContain("Forgot your password? Run <code class=\"k-nowrap\">toolroll password reset</code> there.");
    });
  });

  test("an identity-provider install keeps its footer: the invite line only", () => {
    const page = htmlString(loginPage(null, "/", { label: "Okta", operatorsOnly: false }, { kind: "password", savedAt: "~/x/up-login.txt" }));
    expect(page).toContain("No account? Ask whoever runs this Toolroll for an invite link.");
    expect(page).not.toContain("Forgot");
    expect(page).not.toContain("up-login.txt");
  });
});

describe("toolroll password reset", () => {
  test("never without a person at this computer's terminal, never from a flag; a mismatch or a short one changes nothing", async () => {
    passwordInstall();
    const before = facts();
    const refusals: [string[], NonNullable<OperateOptions["easySeams"]>, string][] = [
      [["--json"], { terminal: true, askHidden: typing(NEW, NEW) }, "Reset the password yourself at a terminal"],
      [[], { terminal: false, askHidden: typing(NEW, NEW) }, "Reset the password yourself at a terminal"],
      [["--yes"], { terminal: true, askHidden: typing(NEW, NEW) }, "--yes is not a password reset option"],
      [["--password", NEW], { terminal: true }, "--password is not a password reset option"],
      [["extra"], { terminal: true }, "Use `toolroll password reset`"],
      [[], { terminal: true, askHidden: typing(NEW, `${NEW}!`) }, "The two passwords didn't match. Nothing changed."],
      [[], { terminal: true, askHidden: typing("short", "short") }, "at least 8 characters"],
    ];
    for (const [args, seams, words] of refusals) {
      const { code, out } = await reset(args, seams);
      expect(code, args.join(" ")).not.toBe(0);
      expect(out, args.join(" ")).toContain(words);
    }
    expect(facts()).toMatchObject({ generation: before.generation, sessions: 1, resets: 0 });
    expect(existsSync(savedFile)).toBe(true);
  });

  test("under a coding agent, even at a real terminal: refused", async () => {
    passwordInstall();
    const stdin = Object.getOwnPropertyDescriptor(process.stdin, "isTTY"), stdout = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    vi.stubEnv("CLAUDECODE", "1");
    try {
      const { code, out } = await reset([], { askHidden: typing(NEW, NEW) });
      expect(code).toBe(EXIT.refused);
      expect(out).toContain("Reset the password yourself at a terminal");
    } finally {
      if (stdin === undefined) delete (process.stdin as { isTTY?: boolean }).isTTY; else Object.defineProperty(process.stdin, "isTTY", stdin);
      if (stdout === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY; else Object.defineProperty(process.stdout, "isTTY", stdout);
    }
    expect(facts()).toMatchObject({ resets: 0, sessions: 1 });
  });

  test("a remote API token, a lead token and the terminal UI's local owner: refused, nothing changes", async () => {
    passwordInstall();
    const before = facts();
    // A person's own API token, through the remote seam: the contract says the command runs nowhere remotely.
    await withStore(async store => {
      const minted = mintApiToken();
      store.createApiToken({ id: minted.id, account: "alex", name: "laptop", secretHash: minted.hash, access: "act", expiresAt: "2027-01-01T00:00:00.000Z", by: "alex" }, NOW);
      const alex: Principal = { kind: "person", account: "alex", generation: store.accountOf("alex")!.generation, scope: "act", tokenId: minted.id, projects: null };
      const out: string[] = [];
      expect(await runOperateAs(["password", "reset", "--json"], { principal: alex, store, write: line => out.push(line), options: { now: NOW } })).not.toBe(EXIT.ok);
      expect(out.join("\n")).not.toContain("Password reset for");
    });
    // The lead's token: it signs in as its person, and never resets their password.
    let minted = "";
    expect(await runOperate("lead", ["token", "--as", "alex", "--token", OLD, "--json", "--db", file], text => { minted += text; }, { now: NOW })).toBe(EXIT.ok);
    vi.stubEnv("TOOLROLL_LEAD_TOKEN", (JSON.parse(minted) as { token: string }).token);
    const lead = await reset();
    expect(lead.code).toBe(EXIT.refused);
    expect(lead.out).toContain("not with a remote or lead token");
    vi.unstubAllEnvs();
    // The terminal UI's local owner: refused before the command runs.
    let owned = "";
    await runAsLocalOwner(() => runOperate("password", ["reset", "--db", file], text => { owned += text; }, { now: NOW, easySeams: { terminal: true, askHidden: typing(NEW, NEW) } }));
    expect(owned).not.toContain("Password reset for");
    expect(facts()).toMatchObject({ generation: before.generation, resets: 0 });
    withStore(store => expect(verifyCredential(store.accountOf("alex")!.credentialHash, OLD)).toBe(true));
  });

  test("whose: the one approver, else --as; identity-provider, removed and password-free accounts are refused", async () => {
    passwordInstall();
    withStore(store => {
      expect(addApprover(store, "bob", NOW, { name: "alex", token: OLD }, undefined, {}, "bob password 1").ok).toBe(true);
      expect(addApprover(store, "cara", NOW, { name: "alex", token: OLD }, undefined, {}, "cara password 1").ok).toBe(true);
      expect(store.revokeAccount("cara", "alex", NOW).ok).toBe(true);
      expect(store.signInWithSso({ issuer: "https://idp.example", subject: "s-1", email: null, label: "Okta" }, { role: "viewer", projects: null }, () => "dana", NOW).ok).toBe(true);
    });
    expect((await reset()).out).toContain("Several people sign in here (alex, bob). Say whose: `toolroll password reset --as <name>`.");
    expect((await reset(["--as", "cara"])).out).toContain("cara was removed and can't sign in. Nothing changed.");
    expect((await reset(["--as", "dana"])).out).toContain("dana signs in with your identity provider and has no password to reset. Nothing changed.");
    expect((await reset(["--as", "nobody"])).out).toContain("No account named `nobody`. Nothing changed.");
    const bob = await reset(["--as", "bob"]);
    expect(bob.code, bob.out).toBe(EXIT.ok);
    expect(bob.out).toContain("Password reset for bob.");
    // alex's saved first password is alex's, and still works: it stays.
    expect(existsSync(savedFile)).toBe(true);
    expect(facts()).toMatchObject({ resets: 0, sessions: 1 });
  });

  test("a password-free owner who never set one is pointed at password set", async () => {
    withStore(store => { if (!initLocalMode(store, { owner: "alex", fenceAvailable: true, now: NOW }).ok) throw Error("local mode"); });
    const { code, out } = await reset();
    expect(code).toBe(EXIT.refused);
    expect(out).toContain("alex has no password yet. Set one with `toolroll password set`.");
  });

  test("success: told what ends first, the generation moves, every session ends, the ledger says so, the stale saved file goes", async () => {
    passwordInstall();
    const before = facts();
    const asked: string[] = [];
    const { code, out } = await reset([], { terminal: true, askHidden: async question => { asked.push(question); return NEW; } });
    expect(code, out).toBe(EXIT.ok);
    expect(asked).toEqual(["New password: ", "Type it again: "]);
    expect(out.indexOf("Every place alex is signed in ends")).toBeGreaterThanOrEqual(0);
    expect(out).toContain("Password reset for alex. Every session of alex has ended; sign in with the new password.");
    expect(out).toContain(`Removed ${savedFile}: it held the old password.`);
    expect(out).not.toContain(NEW);
    const after = facts();
    expect(after.generation).toBe(before.generation + 1);
    expect(after).toMatchObject({ sessions: 0, resets: 1 });
    expect(verifyCredential(after.credentialHash, NEW)).toBe(true);
    expect(verifyCredential(after.credentialHash, OLD)).toBe(false);
    expect(existsSync(savedFile)).toBe(false);
  });
});

describe("over a real console", () => {
  let server: Server | null = null;
  afterEach(async () => { if (server !== null) await new Promise<void>(resolve => server!.close(() => resolve())); server = null; });

  test("the footer names the saved file as ~/…, a reset ends the signed-in session, the new password signs in and the footer drops the file", async () => {
    passwordInstall();
    process.env["HOME"] = root;
    const store = openStore(file);
    try {
      server = createDecisionServer({ store, evidenceRoot: join(root, "evidence"), clock: () => new Date(), configDir });
      await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const signIn = (password: string) => fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: password }), redirect: "manual" });
      const footer = await (await fetch(`${base}/login`)).text();
      expect(footer.replace(/<wbr>/g, "")).toContain("~/config/.toolroll-secrets/up-login.txt");
      expect(footer).not.toContain(root);
      const signed = await signIn(OLD);
      expect(signed.status).toBe(303);
      const cookie = (signed.headers.get("set-cookie") ?? "").split(";")[0]!;
      expect((await fetch(`${base}/people`, { headers: { cookie }, redirect: "manual" })).status).toBe(200);
      // The password typed at sign-in is remembered on this session (it stands in for standard approvals): Forget shows.
      const general = await (await fetch(`${base}/settings/general`, { headers: { cookie }, redirect: "manual" })).text();
      expect(general).toContain("Forget now");

      const done = await reset();
      expect(done.code, done.out).toBe(EXIT.ok);

      const ended = await fetch(`${base}/people`, { headers: { cookie }, redirect: "manual" });
      expect(ended.status).not.toBe(200);
      expect(ended.headers.get("location") ?? "").toContain("/login");
      // The remembered password went with the session: the same cookie reaches no settings page and no act.
      expect((await fetch(`${base}/settings/general`, { headers: { cookie }, redirect: "manual" })).status).not.toBe(200);
      expect((await fetch(`${base}/session/forget-password`, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: "", redirect: "manual" })).headers.get("location") ?? "").not.toContain("/settings");
      expect((await signIn(OLD)).status).toBe(403);
      expect((await signIn(NEW)).status).toBe(303);
      const now = await (await fetch(`${base}/login`)).text();
      expect(now).not.toContain("up-login.txt");
      expect(now).toContain("Forgot your password? Run <code class=\"k-nowrap\">toolroll password reset</code> on the computer running Toolroll.");
    } finally { store.close(); }
  });
});
