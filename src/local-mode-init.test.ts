/**
 * Eight W2: local (password-free) mode for a database with no account, however it was made (`welcome`, `status` or
 * `repos add` before the first start). Security rule: only a person at this computer's own terminal (both TTYs, no
 * coding agent, no --json, no remote principal) turns it on; never a database with any account row (viewer-only and
 * revoked ones count) or any local-mode state ever recorded; the transaction that writes reads both again; creation
 * provenance is never rewritten.
 */
import { afterEach, describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { easyStartInitLocalMode, initLocalModeForPerson, personMayInitLocalMode, type LocalInitCaller } from "./operate.js";
import { localModeRead } from "./easy-start.js";
import { initLocalMode, installationCreatedBy, localModeCandidate, localModeOf, openStore, setLocalModeOff, type Store } from "./store.js";

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
  ])("%s: never initialised, and not a candidate", (_label, insert) => {
    const { store, file } = madeFirstByAnotherCommand();
    const stamp = NOW.toISOString();
    store.handle.prepare(insert).run(...(insert.includes("revoked_at") ? [stamp, stamp] : [stamp]));
    expect(localModeCandidate(store)).toBe(false);
    expect(localModeRead(file)).toBe("off");
    expect(initLocalMode(store, { owner: "sam", fenceAvailable: true, now: NOW })).toEqual({ ok: false, reason: "has-accounts" });
    expect(initLocalModeForPerson(store, PERSON, { owner: "sam", fence: () => true, now: NOW })).toEqual({ ok: false, reason: "already" });
    expect(localRows(store)).toBe(0);
    expect(accounts(store)).toBe(1);
  });

  test("local mode turned off before is never turned on again", () => {
    const { store, file } = madeFirstByAnotherCommand();
    expect(initLocalMode(store, { owner: "sam", fenceAvailable: true, now: NOW }).ok).toBe(true);
    expect(setLocalModeOff(store, { name: "sam", authority: "full" }, NOW).ok).toBe(true);
    expect(localModeCandidate(store)).toBe(false);
    expect(localModeRead(file)).toBe("off");
    expect(initLocalMode(store, { owner: "sam", fenceAvailable: true, now: NOW })).toEqual({ ok: false, reason: "already" });
    expect(easyStartInitLocalMode(file, PERSON, { fence: () => true, owner: "sam", now: NOW })).toBe(false);
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

describe("only a person at this computer's own terminal turns it on", () => {
  const notPeople: [string, Partial<LocalInitCaller>][] = [
    ["stdin not a terminal (piped)", { stdin: false }],
    ["stdout not a terminal", { stdout: false }],
    ["under a coding agent", { agent: true }],
    ["--json", { json: true }],
    ["a remote principal or a named credential", { remote: true }],
  ];
  test.each(notPeople)("%s: refused before anything is read or written", (_label, change) => {
    const caller = { ...PERSON, ...change };
    expect(personMayInitLocalMode(caller)).toBe(false);
    const { store, file } = madeFirstByAnotherCommand();
    let probed = false;
    expect(initLocalModeForPerson(store, caller, { owner: "sam", fence: () => { probed = true; return true; }, now: NOW })).toEqual({ ok: false, reason: "not-a-person" });
    expect(easyStartInitLocalMode(file, caller, { fence: () => { probed = true; return true; }, owner: "sam", now: NOW })).toBe(false);
    expect(probed).toBe(false);
    expect(localRows(store)).toBe(0);
    expect(accounts(store)).toBe(0);
  });

  test("a person: on, once; a second start changes nothing", () => {
    const { store, file } = madeFirstByAnotherCommand();
    expect(personMayInitLocalMode(PERSON)).toBe(true);
    expect(easyStartInitLocalMode(file, PERSON, { fence: () => true, owner: "sam", now: NOW })).toBe(true);
    expect(localModeOf(store)).toMatchObject({ owner: "sam", enabled: true, generation: 1 });
    expect(installationCreatedBy(store)).toBeNull();
    expect(easyStartInitLocalMode(file, PERSON, { fence: () => true, owner: "robin", now: NOW })).toBe(true);
    expect(store.listApprovers().map(one => one.name)).toEqual(["sam"]);
  });

  test("no database yet: made as `up --laptop` makes it (created-by laptop) only when there is a fence; without one nothing is made", () => {
    dir = mkdtempSync(join(tmpdir(), "so-w2-init-"));
    const none = join(dir, "none.db");
    expect(easyStartInitLocalMode(none, PERSON, { fence: () => false, owner: "sam", now: NOW })).toBe(false);
    expect(existsSync(none)).toBe(false);
    const fresh = join(dir, "fresh.db");
    expect(easyStartInitLocalMode(fresh, PERSON, { fence: () => true, owner: "sam", now: NOW })).toBe(true);
    const store = openStore(fresh);
    open.push(store);
    expect(installationCreatedBy(store)).toBe("laptop");
    expect(localModeOf(store)?.owner).toBe("sam");
  });

  test("no fence on this machine: an existing accountless database is left exactly as it was", () => {
    const { store, file } = madeFirstByAnotherCommand();
    expect(easyStartInitLocalMode(file, PERSON, { fence: () => false, owner: "sam", now: NOW })).toBe(false);
    expect(initLocalModeForPerson(store, PERSON, { owner: "sam", fence: () => false, now: NOW })).toEqual({ ok: false, reason: "no-fence" });
    expect(localRows(store)).toBe(0);
    expect(accounts(store)).toBe(0);
  });
});
