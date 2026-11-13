/**
 * Eight W2: local (password-free) mode for a database with no account, however it was made (`welcome`, `status` or
 * `repos add` before the first start). Security rule: only a person at this computer's own terminal (both TTYs, no
 * coding agent, no --json, no remote principal) turns it on; never a database with any account row (viewer-only and
 * revoked ones count) or any local-mode state ever recorded; the transaction that writes reads both again; creation
 * provenance is never rewritten.
 */
import { afterEach, describe, expect, test } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { easyStartInitLocalMode, initLocalModeForPerson, personMayInitLocalMode, startOverWords, type LocalInitCaller } from "./operate.js";
import { hashToken } from "./scope.js";
import { localModeRead } from "./easy-start.js";
import { initLocalMode, installationCreatedBy, localModeCandidate, localModeOf, openStore, reportLifecycle, setLocalModeOff, type Store } from "./store.js";

const NOW = new Date("2026-11-13T12:00:00.000Z");
const PERSON: LocalInitCaller = { stdin: true, stdout: true, agent: false, json: false, remote: false };
let dir: string | undefined;
const open: Store[] = [];
afterEach(() => {
  for (const one of open.splice(0)) { try { one.close(); } catch { /* closed */ } }
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});
/** A database as `welcome`, `status` or `repos add` make it before any start: no creator fact, no account. */
function madeFirstByAnotherCommand(name = "orders.db"): { file: string; store: Store } {
  dir ??= mkdtempSync(join(tmpdir(), "so-w2-init-"));
  const file = join(dir, name);
  const store = openStore(file);
  open.push(store);
  return { file, store };
}
const localRows = (store: Store) => Number(store.handle.prepare("SELECT count(*) AS n FROM local_mode").get()!["n"]);
const accounts = (store: Store) => Number(store.handle.prepare("SELECT count(*) AS n FROM approver").get()!["n"]);

describe("which databases may still become password-free", () => {
  test("a database made by another command with no account: initialised, and its provenance stays exactly as it was", () => {
    const { store, file } = madeFirstByAnotherCommand();
    expect(installationCreatedBy(store)).toBeNull();
    expect(localModeCandidate(store)).toBe(true);
    expect(localModeRead(file)).toBe("candidate");
    expect(initLocalMode(store, { owner: "sam", fenceAvailable: true, now: NOW })).toEqual({ ok: true, owner: "sam", generation: 1 });
    expect(localModeOf(store)?.enabled).toBe(true);
    // Provenance is its own fact: never written to make local mode's detection work.
    expect(installationCreatedBy(store)).toBeNull();
    expect(localModeCandidate(store)).toBe(false);
    expect(localModeRead(file)).toBe("on");
  });

  test.each([
    ["a viewer-only account", "INSERT INTO approver (name, credential_hash, added_at, role, generation) VALUES ('robin', 'x', ?, 'viewer', 1)"],
    ["a revoked account", "INSERT INTO approver (name, credential_hash, added_at, revoked_at, revoked_by, generation) VALUES ('carol', 'x', ?, ?, 'carol', 1)"],
    ["an SSO-only account", "INSERT INTO approver (name, credential_hash, added_at, generation) VALUES ('dana', 'sso-only$x', ?, 1)"],
  ])("%s: never initialised, and not a candidate", async (_label, insert) => {
    const { store, file } = madeFirstByAnotherCommand();
    const stamp = NOW.toISOString();
    store.handle.prepare(insert).run(...(insert.includes("revoked_at") ? [stamp, stamp] : [stamp]));
    expect(localModeCandidate(store)).toBe(false);
    expect(localModeRead(file)).toBe("off");
    expect(initLocalMode(store, { owner: "sam", fenceAvailable: true, now: NOW })).toEqual({ ok: false, reason: "has-accounts" });
    expect(await initLocalModeForPerson(store, PERSON, { owner: "sam", fence: () => true, now: NOW })).toEqual({ ok: false, reason: "already" });
    expect(localRows(store)).toBe(0);
    expect(accounts(store)).toBe(1);
  });

  test("local mode turned off before is never turned on again", async () => {
    const { store, file } = madeFirstByAnotherCommand();
    expect(initLocalMode(store, { owner: "sam", fenceAvailable: true, now: NOW }).ok).toBe(true);
    expect(setLocalModeOff(store, { name: "sam", authority: "full" }, NOW).ok).toBe(true);
    expect(localModeCandidate(store)).toBe(false);
    expect(localModeRead(file)).toBe("off");
    expect(initLocalMode(store, { owner: "sam", fenceAvailable: true, now: NOW })).toEqual({ ok: false, reason: "already" });
    expect(await easyStartInitLocalMode(file, PERSON, { fence: () => true, owner: "sam", now: NOW })).toBe(false);
    expect(localModeOf(store)?.enabled).toBe(false);
  });

  test("race: an account made by another connection between the check and the write — the write finds it and adds nothing", () => {
    const { store, file } = madeFirstByAnotherCommand();
    expect(localModeCandidate(store)).toBe(true);
    // Another process (a racing `up` minting a login, an invite redeemed) adds an account through its own connection.
    const other = openStore(file);
    open.push(other);
    other.handle.prepare("INSERT INTO approver (name, credential_hash, added_at, generation) VALUES ('robin', 'x', ?, 1)").run(NOW.toISOString());
    expect(initLocalMode(store, { owner: "sam", fenceAvailable: true, now: NOW })).toEqual({ ok: false, reason: "has-accounts" });
    expect(localRows(store)).toBe(0);
    expect(store.listApprovers().map(one => one.name)).toEqual(["robin"]);
    expect(Number(store.handle.prepare("SELECT count(*) AS n FROM action_ledger WHERE action = 'local mode on'").get()!["n"])).toBe(0);
  });
});

describe("never under a console serving the database (Codex #377 finding 2, round 2 finding A)", () => {
  /** A real listener on a free loopback port (a console that is paused, say: it answers, it beats nothing). */
  async function listening(): Promise<{ port: number; close: () => Promise<void> }> {
    const server = createServer();
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
    return { port: (server.address() as AddressInfo).port, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
  }
  /** A port nothing listens on: one that was free a moment ago. */
  async function nothingOn(): Promise<number> { const one = await listening(); await one.close(); return one.port; }
  const row = (store: Store, component: string, state: "started" | "draining" | "stopped", ageMs: number): void => {
    const at = new Date(NOW.getTime() - ageMs);
    reportLifecycle(store, component, "started", "serve:1:abc", at, { pid: 1 });
    if (state !== "started") reportLifecycle(store, component, state, "serve:1:abc", at);
  };

  test.each([["started"], ["draining"]] as const)("a console row %s and beaten just now: never initialised, even with nothing listening", async state => {
    const { store, file } = madeFirstByAnotherCommand();
    row(store, `console:127.0.0.1:${await nothingOn()}`, state, 0);
    expect(await initLocalModeForPerson(store, PERSON, { owner: "sam", fence: () => true, now: NOW })).toEqual({ ok: false, reason: "console-running" });
    expect(await easyStartInitLocalMode(file, PERSON, { fence: () => true, owner: "sam", now: NOW })).toBe(false);
    expect(localRows(store)).toBe(0);
  });

  test("a paused console: no heartbeat for minutes, but its address still listens — never initialised", async () => {
    const paused = await listening();
    try {
      for (const component of [`console:127.0.0.1:${paused.port}`, `console:${paused.port}`]) {
        const { store, file } = madeFirstByAnotherCommand(`paused-${component.length}.db`);
        row(store, component, "started", 10 * 60_000);
        expect(await initLocalModeForPerson(store, PERSON, { owner: "sam", fence: () => true, now: NOW }), component).toEqual({ ok: false, reason: "console-running" });
        expect(await easyStartInitLocalMode(file, PERSON, { fence: () => true, owner: "sam", now: NOW })).toBe(false);
        expect(localRows(store)).toBe(0);
      }
    } finally { await paused.close(); }
  });

  test("a stale row whose address nothing listens on (a console that crashed), or a stopped one: initialised", async () => {
    const gone = await nothingOn();
    for (const [name, component, state] of [["crashed", `console:127.0.0.1:${gone}`, "started"], ["stopped", `console:127.0.0.1:${gone}`, "stopped"]] as const) {
      const { store } = madeFirstByAnotherCommand(`${name}.db`);
      row(store, component, state, 10 * 60_000);
      expect((await initLocalModeForPerson(store, PERSON, { owner: "sam", fence: () => true, now: NOW })).ok, name).toBe(true);
    }
  });

  test("the write itself refuses a stale row nobody proved down (initLocalMode with no proof)", () => {
    const { store } = madeFirstByAnotherCommand();
    row(store, "console:127.0.0.1:4351", "started", 10 * 60_000);
    expect(initLocalMode(store, { owner: "sam", fenceAvailable: true, now: NOW })).toEqual({ ok: false, reason: "console-running" });
    expect(localRows(store)).toBe(0);
  });
});

describe("only a person at this computer's own terminal turns it on", () => {
  const notPeople: [string, Partial<LocalInitCaller>][] = [
    ["stdin not a terminal (piped)", { stdin: false }],
    ["stdout not a terminal", { stdout: false }],
    ["under a coding agent", { agent: true }],
    ["--json", { json: true }],
    ["a remote principal or a named credential", { remote: true }],
  ];
  test.each(notPeople)("%s: refused before anything is read or written", async (_label, change) => {
    const caller = { ...PERSON, ...change };
    expect(personMayInitLocalMode(caller)).toBe(false);
    const { store, file } = madeFirstByAnotherCommand();
    let probed = false;
    expect(await initLocalModeForPerson(store, caller, { owner: "sam", fence: () => { probed = true; return true; }, now: NOW })).toEqual({ ok: false, reason: "not-a-person" });
    expect(await easyStartInitLocalMode(file, caller, { fence: () => { probed = true; return true; }, owner: "sam", now: NOW })).toBe(false);
    expect(probed).toBe(false);
    expect(localRows(store)).toBe(0);
    expect(accounts(store)).toBe(0);
  });

  test("a person: on, once; a second start changes nothing", async () => {
    const { store, file } = madeFirstByAnotherCommand();
    expect(personMayInitLocalMode(PERSON)).toBe(true);
    expect(await easyStartInitLocalMode(file, PERSON, { fence: () => true, owner: "sam", now: NOW })).toBe(true);
    expect(localModeOf(store)).toMatchObject({ owner: "sam", enabled: true, generation: 1 });
    expect(installationCreatedBy(store)).toBeNull();
    expect(await easyStartInitLocalMode(file, PERSON, { fence: () => true, owner: "robin", now: NOW })).toBe(true);
    expect(store.listApprovers().map(one => one.name)).toEqual(["sam"]);
  });

  test("no database yet: made as `up --laptop` makes it (created-by laptop) only when there is a fence; without one nothing is made", async () => {
    dir = mkdtempSync(join(tmpdir(), "so-w2-init-"));
    const none = join(dir, "none.db");
    expect(await easyStartInitLocalMode(none, PERSON, { fence: () => false, owner: "sam", now: NOW })).toBe(false);
    expect(existsSync(none)).toBe(false);
    const fresh = join(dir, "fresh.db");
    expect(await easyStartInitLocalMode(fresh, PERSON, { fence: () => true, owner: "sam", now: NOW })).toBe(true);
    const store = openStore(fresh);
    open.push(store);
    expect(installationCreatedBy(store)).toBe("laptop");
    expect(localModeOf(store)?.owner).toBe("sam");
  });

  test("no fence on this machine: an existing accountless database is left exactly as it was", async () => {
    const { store, file } = madeFirstByAnotherCommand();
    expect(await easyStartInitLocalMode(file, PERSON, { fence: () => false, owner: "sam", now: NOW })).toBe(false);
    expect(await initLocalModeForPerson(store, PERSON, { owner: "sam", fence: () => false, now: NOW })).toEqual({ ok: false, reason: "no-fence" });
    expect(localRows(store)).toBe(0);
    expect(accounts(store)).toBe(0);
  });
});

/**
 * l1 (stranger test, Linux): before the first start stopped on a computer missing the sandbox's programs, that start
 * made an account with a minted password, and every start after took the password road. startOverWords tells only
 * that install how to start over; every other install (a password the person set or changed, anything filed, a second
 * account, local mode ever, another creator, a folder that isn't Toolroll's own) gets nothing.
 */
describe("l1: an install that got a password only because its first start couldn't go password-free", () => {
  const SANDBOX_OK = { missing: [] as string[], problem: null };
  /** As that start left it: made by a laptop start, one account whose minted password is in the saved login file. */
  function passwordRoadInstall(folder = "toolroll"): { file: string; store: Store; state: string } {
    dir ??= mkdtempSync(join(tmpdir(), "so-l1-"));
    const state = join(dir, folder);
    mkdirSync(state, { recursive: true });
    const file = join(state, "orders.db");
    const store = openStore(file, { createdBy: "laptop" });
    open.push(store);
    expect(store.bootstrapApproverIfNone("dev", hashToken("minted-secret"), NOW)).toEqual({ ok: true });
    mkdirSync(join(state, ".toolroll-secrets"), { mode: 0o700 });
    writeFileSync(join(state, ".toolroll-secrets", "up-login.txt"), "dev minted-secret\n", { mode: 0o600 });
    chmodSync(join(state, ".toolroll-secrets"), 0o700);
    return { file, store, state };
  }

  test("told how to start over (with the install line while programs are missing); nothing is changed by asking", () => {
    const { file, store, state } = passwordRoadInstall();
    expect(startOverWords(file, SANDBOX_OK)).toEqual([
      "This Toolroll was set up with a password because it couldn't start without one then.",
      "Nothing has been filed yet, so you can start over without a password: press Ctrl-C, then run",
      `  mv -- '${state}' '${state}.old' && toolroll`,
    ]);
    expect(startOverWords(file, { missing: ["socat", "ripgrep"], problem: null })).toContain("  sudo apt install socat ripgrep (Fedora: sudo dnf install socat ripgrep)");
    expect(accounts(store)).toBe(1);
    expect(localRows(store)).toBe(0);
    expect(existsSync(join(state, ".toolroll-secrets", "up-login.txt"))).toBe(true);
    // Never auto-converted: the database is still not a candidate, and the terminal's initialisation refuses it.
    expect(localModeCandidate(store)).toBe(false);
  });

  test("moved aside, the folder's place starts over: the next first start is password-free", async () => {
    const { file, store, state } = passwordRoadInstall();
    store.close();
    open.splice(open.indexOf(store), 1);
    const { renameSync } = await import("node:fs");
    renameSync(state, `${state}.old`);
    mkdirSync(state);
    expect(await easyStartInitLocalMode(file, PERSON, { fence: () => true, owner: "dev", now: NOW, probe: async () => "refused" })).toBe(true);
    expect(localModeRead(file)).toBe("on");
  });

  test.each([
    ["the person set or changed the password (the saved login no longer opens it)", (one: ReturnType<typeof passwordRoadInstall>) => { one.store.handle.prepare("UPDATE approver SET credential_hash = ?, generation = 2").run(hashToken("their-own")); }],
    ["no saved login", (one: ReturnType<typeof passwordRoadInstall>) => { rmSync(join(one.state, ".toolroll-secrets", "up-login.txt")); }],
    ["something filed", (one: ReturnType<typeof passwordRoadInstall>) => { one.store.handle.prepare("INSERT INTO task_ref (backend, external_id) VALUES ('built-in', 't1')").run(); }],
    ["a second account (a viewer)", (one: ReturnType<typeof passwordRoadInstall>) => { one.store.handle.prepare("INSERT INTO approver (name, credential_hash, added_at, role, generation) VALUES ('robin', 'x', ?, 'viewer', 1)").run(NOW.toISOString()); }],
    ["its one account revoked", (one: ReturnType<typeof passwordRoadInstall>) => { one.store.handle.prepare("UPDATE approver SET revoked_at = ?, revoked_by = 'dev'").run(NOW.toISOString()); }],
    ["local mode recorded (on or off)", (one: ReturnType<typeof passwordRoadInstall>) => { one.store.handle.prepare("INSERT INTO local_mode (id, owner, generation, enabled, initialized_at, changed_at) VALUES (1, 'dev', 2, 0, ?, ?)").run(NOW.toISOString(), NOW.toISOString()); }],
  ])("never told for an install where %s", (_label, change) => {
    const one = passwordRoadInstall();
    change(one);
    expect(startOverWords(one.file, SANDBOX_OK)).toBeNull();
  });

  test("never for a database another command made, a folder that isn't Toolroll's own, or a computer that still can't sandbox", () => {
    dir ??= mkdtempSync(join(tmpdir(), "so-l1-"));
    const state = join(dir, "toolroll");
    mkdirSync(state, { recursive: true });
    const plain = openStore(join(state, "orders.db"));
    open.push(plain);
    plain.bootstrapApproverIfNone("dev", hashToken("minted-secret"), NOW);
    mkdirSync(join(state, ".toolroll-secrets"), { mode: 0o700 });
    writeFileSync(join(state, ".toolroll-secrets", "up-login.txt"), "dev minted-secret\n", { mode: 0o600 });
    expect(startOverWords(join(state, "orders.db"), SANDBOX_OK)).toBeNull();
    const elsewhere = passwordRoadInstall("Documents");
    expect(startOverWords(elsewhere.file, SANDBOX_OK)).toBeNull();
    const stuck = passwordRoadInstall("standing-orders");
    expect(startOverWords(stuck.file, SANDBOX_OK)).not.toBeNull();
    expect(startOverWords(stuck.file, { missing: [], problem: "bubblewrap can't start a sandbox here" })).toBeNull();
  });
});
