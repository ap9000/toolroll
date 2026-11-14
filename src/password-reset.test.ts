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
import { existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { EXIT, runOperate, runOperateAs, type OperateOptions, type Principal } from "./operate.js";
import { runAsLocalOwner } from "./local-owner.js";
import { addApprover, verifyCredential } from "./scope.js";
import { enrollOwnerPassword, initLocalMode, localModeOf, openStore, type Store } from "./store.js";
import { mintApiToken } from "./api-tokens.js";
import { createDecisionServer, type DecisionServer } from "./serve.js";
import { removeStaleSavedLogin } from "./login-secrets.js";
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
      const help = loginHelpOf(store, { here: true, home: root, user: "someone" });
      expect(help).toEqual({ kind: "password", savedAt: "~/config/.toolroll-secrets/up-login.txt" });
      const page = htmlString(loginPage(null, "/", null, help));
      expect(page).toContain("Forgot your password? On the computer running Toolroll, your first password is saved in");
      expect(page).toContain("(until you change it). Changed it and forgot? Run <code class=\"k-nowrap\">toolroll password reset</code> there.");
      expect(page.replace(/<wbr>/g, "")).toContain("~/config/.toolroll-secrets/up-login.txt");
      expect(page).not.toContain(root);
      expect(page).toContain("No account? Ask whoever runs this Toolroll for an invite link.");
      // The real home folder never shows either (the database here is not under it).
      expect(htmlString(loginPage(null, "/", null, loginHelpOf(store, { here: true })))).not.toContain(homedir());
    });
    // No file: no path sentence, the reset line alone.
    rmSync(savedFile);
    withStore(store => {
      const help = loginHelpOf(store, { here: true, home: root, user: "someone" });
      expect(help).toEqual({ kind: "password", savedAt: null });
      const page = htmlString(loginPage(null, "/", null, help));
      expect(page).toContain("Forgot your password? Run <code class=\"k-nowrap\">toolroll password reset</code> on the computer running Toolroll.");
      expect(page).not.toContain("up-login.txt");
    });
    // An older version's file directly beside the database counts too.
    writeFileSync(join(configDir, "up-login.txt"), `alex ${OLD}\n`, { mode: 0o600 });
    withStore(store => expect(loginHelpOf(store, { here: true, home: root, user: "someone" })).toEqual({ kind: "password", savedAt: "~/config/up-login.txt" }));
  });

  test("only a path under the home folder shows, as ~/…, and never one naming the user; never an absolute path", () => {
    expect(shownPath("/srv/toolroll/.toolroll-secrets/up-login.txt", "/home/sam", "sam")).toBeNull();
    expect(shownPath("/Users/sam/elsewhere/up-login.txt", "/var/empty", "sam")).toBeNull();
    expect(shownPath("/home/sam/.config/toolroll/x", "/home/sam", "sam")).toBe("~/.config/toolroll/x");
    expect(shownPath("/home/sam/shared/sam/x", "/home/sam", "sam")).toBeNull();
    expect(shownPath("/home/samuel/x", "/home/sam", null)).toBeNull();
    expect(htmlString(loginPage(null))).not.toContain("Your first login was shown");
  });

  test("a visitor from another device gets the generic recovery words: no path, and nothing about whether a password exists", () => {
    passwordInstall();
    withStore(store => {
      const help = loginHelpOf(store, { here: false, home: root, user: "someone" });
      expect(help).toEqual({ kind: "password", savedAt: null });
      const page = htmlString(loginPage(null, "/", null, help));
      expect(page).toContain("Forgot your password? Run <code class=\"k-nowrap\">toolroll password reset</code> on the computer running Toolroll.");
      expect(page).not.toContain("up-login.txt");
    });
    rmSync(file); rmSync(join(configDir, ".toolroll-secrets"), { recursive: true });
    withStore(store => {
      if (!initLocalMode(store, { owner: "alex", fenceAvailable: true, now: NOW }).ok) throw Error("local mode");
      // No password exists, yet the remote footer reads the same as when one does.
      const remote = htmlString(loginPage(null, "/", null, loginHelpOf(store, { here: false })));
      expect(remote).toContain("Forgot your password? Run <code class=\"k-nowrap\">toolroll password reset</code> there.");
      expect(htmlString(loginPage(null, "/", null, loginHelpOf(store, { here: true })))).not.toContain("password reset");
    });
  });

  test("a password-free install: why it asks, the command on its own computer, and the reset only once a password exists", () => {
    withStore(store => {
      if (!initLocalMode(store, { owner: "alex", fenceAvailable: true, now: NOW }).ok) throw Error("local mode");
      const help = loginHelpOf(store, { here: true, home: root, user: "someone" });
      expect(help).toEqual({ kind: "local", passwordSet: false });
      const page = htmlString(loginPage(null, "/", null, help));
      expect(page).toContain("Signing in without a password works only on the computer running Toolroll. There, run <code class=\"k-nowrap\">toolroll open --web</code>.");
      expect(page).not.toContain("password reset");
      expect(page).toContain("No account? Ask whoever runs this Toolroll for an invite link.");
      expect(enrollOwnerPassword(store, "alex", hashPassword(NEW), localModeOf(store)!.generation, NOW).ok).toBe(true);
      const after = htmlString(loginPage(null, "/", null, loginHelpOf(store, { here: true, home: root, user: "someone" })));
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
    expect((await reset()).out).toContain("Several people sign in here (alex, bob, dana). Say whose: `toolroll password reset --as <name>`.");
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

  test("one approver and one viewer: a name is required, never the approver by default", async () => {
    passwordInstall();
    withStore(store => {
      const invite = store.mintInvite("viewer", "alex", NOW);
      expect(store.consumeInviteAndCreateAccount({ tokenValue: invite.token, name: "vic", credentialHash: hashPassword("vic password 1") }, NOW).ok).toBe(true);
    });
    const { code, out } = await reset();
    expect(code).toBe(EXIT.usage);
    expect(out).toContain("Several people sign in here (alex, vic). Say whose: `toolroll password reset --as <name>`.");
    expect(facts()).toMatchObject({ resets: 0 });
    expect((await reset(["--as", "vic"])).out).toContain("Password reset for vic.");
  });

  test("an identity provider that allows passwords only for instance operators: a viewer's is refused", async () => {
    passwordInstall();
    withStore(store => {
      const invite = store.mintInvite("viewer", "alex", NOW);
      expect(store.consumeInviteAndCreateAccount({ tokenValue: invite.token, name: "vic", credentialHash: hashPassword("vic password 1") }, NOW).ok).toBe(true);
    });
    writeFileSync(join(configDir, "sign-in.json"), JSON.stringify({ issuer: "https://idp.example", clientId: "c", label: "Okta", rules: [], passwords: "operators" }));
    const { code, out } = await reset(["--as", "vic"]);
    expect(code).toBe(EXIT.refused);
    expect(out).toContain("vic signs in with Okta: passwords are only for instance operators here. Nothing changed.");
  });

  test("a password-free owner who never set one is pointed at password set", async () => {
    withStore(store => { if (!initLocalMode(store, { owner: "alex", fenceAvailable: true, now: NOW }).ok) throw Error("local mode"); });
    const { code, out } = await reset();
    expect(code).toBe(EXIT.refused);
    expect(out).toContain("alex has no password yet. Set one with `toolroll password set`.");
  });

  test("success: told what ends first, the generation moves, every session ends, the ledger says so, the stale saved file goes", async () => {
    passwordInstall();
    let minted = "";
    expect(await runOperate("lead", ["token", "--as", "alex", "--token", OLD, "--json", "--db", file], text => { minted += text; }, { now: NOW })).toBe(EXIT.ok);
    const leadToken = (JSON.parse(minted) as { token: string }).token;
    withStore(store => expect(store.leadFor(leadToken)).not.toBeNull());
    const before = facts();
    const asked: string[] = [];
    const { code, out } = await reset([], { terminal: true, askHidden: async question => { asked.push(question); return NEW; } });
    expect(code, out).toBe(EXIT.ok);
    expect(asked).toEqual(["New password: ", "Type it again: "]);
    // What ends and what stays, said before the first prompt.
    expect(out).toContain("This ends alex's browser sessions and remembered passwords, the terminal UI's sign-in, paired chats, phone notifications, lead sessions and lead tokens");
    expect(out).toContain("It keeps API and MCP tokens (revoke them in Settings → Sessions & tokens) and coordinator credentials (`toolroll coordinator revoke`).");
    expect(out).toContain("alex's lead token ended: mint a new one with `toolroll lead token`.");
    withStore(store => expect(store.leadFor(leadToken)).toBeNull());
    expect(out).toContain("Password reset for alex. Every session of alex has ended; sign in with the new password.");
    expect(out).toContain(`Removed ${shownPath(savedFile, homedir(), null) ?? savedFile}: it held the old password.`);
    expect(out).not.toContain(NEW);
    const after = facts();
    expect(after.generation).toBe(before.generation + 1);
    expect(after).toMatchObject({ sessions: 0, resets: 1 });
    expect(verifyCredential(after.credentialHash, NEW)).toBe(true);
    expect(verifyCredential(after.credentialHash, OLD)).toBe(false);
    expect(existsSync(savedFile)).toBe(false);
  });
});

describe("removing the stale saved first password", () => {
  test("a link anywhere in its path: left alone, and the person is told", async () => {
    passwordInstall(false);
    const outside = join(root, "outside"); mkdirSync(outside, { mode: 0o700 });
    writeFileSync(join(outside, "up-login.txt"), `alex ${OLD}\n`, { mode: 0o600 });
    symlinkSync(outside, join(configDir, ".toolroll-secrets"));
    const { code, out } = await reset();
    expect(code, out).toBe(EXIT.ok);
    expect(existsSync(join(outside, "up-login.txt"))).toBe(true);
    expect(out).toContain("isn't a plain file in Toolroll's folder, so it was left alone. If it holds alex's old password, delete it yourself.");
  });

  test("replaced or rewritten in place between the check and the removal: left, and said to be stale", () => {
    passwordInstall();
    // Replaced: another file now holds the name.
    const replaced = removeStaleSavedLogin(configDir, "alex", NEW, path => { writeFileSync(`${path}.new`, `alex ${OLD}\n`, { mode: 0o600 }); renameSync(`${path}.new`, path); });
    expect(replaced).toEqual({ removed: [], stale: [savedFile], unchecked: [] });
    expect(existsSync(savedFile)).toBe(true);
    // Rewritten in place: the same file (same inode), other contents.
    const rewritten = removeStaleSavedLogin(configDir, "alex", NEW, path => { writeFileSync(path, `alex ${OLD} changed\n`); });
    expect(rewritten).toEqual({ removed: [], stale: [savedFile], unchecked: [] });
    expect(existsSync(savedFile)).toBe(true);
    // A second name for the file (a hard link): not proved to be only Toolroll's, left unchecked.
    linkSync(savedFile, join(root, "other-name"));
    expect(removeStaleSavedLogin(configDir, "alex", NEW)).toEqual({ removed: [], stale: [], unchecked: [savedFile] });
    rmSync(join(root, "other-name"));
    // Untouched otherwise: another account's, or the new password's; then the stale one goes.
    expect(removeStaleSavedLogin(configDir, "bob", NEW)).toEqual({ removed: [], stale: [], unchecked: [] });
    writeFileSync(savedFile, `alex ${NEW}\n`);
    expect(removeStaleSavedLogin(configDir, "alex", NEW)).toEqual({ removed: [], stale: [], unchecked: [] });
    writeFileSync(savedFile, `alex ${OLD}\n`);
    expect(removeStaleSavedLogin(configDir, "alex", NEW)).toEqual({ removed: [savedFile], stale: [], unchecked: [] });
  });
});

describe("over a real console", () => {
  let server: Server | DecisionServer | null = null;
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
      // Through a proxy (another device): the generic words, no path.
      const proxied = await (await fetch(`${base}/login`, { headers: { "x-forwarded-for": "100.64.0.7" } })).text();
      expect(proxied).not.toContain("up-login.txt");
      expect(proxied).toContain("Forgot your password? Run <code class=\"k-nowrap\">toolroll password reset</code> on the computer running Toolroll.");
      // A one-time sign-in link minted before the reset, not yet used.
      const unused = (server as DecisionServer).mintSignInLink("alex")!;
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
      // The link minted under the old password signs no one in; one minted now does.
      const stale = await fetch(`${base}${unused}`, { redirect: "manual" });
      expect(stale.status).toBe(410);
      expect(stale.headers.get("set-cookie") ?? "").not.toContain("session=");
      expect((await fetch(`${base}${(server as DecisionServer).mintSignInLink("alex")!}`, { redirect: "manual" })).status).toBe(303);
      // An ordinary password change (the existing rotation writer) ends an unused link the same way.
      const before = (server as DecisionServer).mintSignInLink("alex")!;
      store.saveApprover("alex", hashPassword("third password 3"), new Date());
      expect((await fetch(`${base}${before}`, { redirect: "manual" })).status).toBe(410);
      const now = await (await fetch(`${base}/login`)).text();
      expect(now).not.toContain("up-login.txt");
      expect(now).toContain("Forgot your password? Run <code class=\"k-nowrap\">toolroll password reset</code> on the computer running Toolroll.");
    } finally { store.close(); }
  });
});
