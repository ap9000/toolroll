/**
 * The saved login's reserved folder (login-secrets.ts): where it is read from and written to, and how an older
 * install's file beside the database moves in — never through a link, never as the old file's inode, never loosened.
 */
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ensureSecretsDir, legacyLoginFileOf, loginFileOf, migrateLegacyLogin, savedLoginFile, secretsDirOf, UntrustedSecretsFolder, writableLoginFile } from "./login-secrets.js";

let state: string;
beforeEach(() => { state = mkdtempSync(join(tmpdir(), "so-login-secrets-")); });
afterEach(() => { rmSync(state, { recursive: true, force: true }); });

const LOGIN = "alex synthetic-login-secret\n";

describe("where the saved login is read from and written to", () => {
  test("the reserved folder first, then the old place, else the reserved folder", () => {
    expect(savedLoginFile(state)).toBe(loginFileOf(state));
    writeFileSync(legacyLoginFileOf(state), LOGIN, { mode: 0o600 });
    expect(savedLoginFile(state)).toBe(legacyLoginFileOf(state));
    writeFileSync(writableLoginFile(state), LOGIN, { mode: 0o600 });
    expect(savedLoginFile(state)).toBe(loginFileOf(state));
    expect(loginFileOf(state)).toBe(join(state, ".toolroll-secrets", "up-login.txt"));
  });

  test("the folder is made owner-only, and anything else holding its name is refused, never written into", () => {
    ensureSecretsDir(state);
    expect(statSync(secretsDirOf(state)).mode & 0o777).toBe(0o700);
    ensureSecretsDir(state); // idempotent
    rmSync(secretsDirOf(state), { recursive: true });
    // A link to a folder the attacker can read, a loosened folder, a file.
    const elsewhere = join(state, "elsewhere");
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, secretsDirOf(state));
    expect(() => writableLoginFile(state)).toThrow(UntrustedSecretsFolder);
    rmSync(secretsDirOf(state));
    mkdirSync(secretsDirOf(state), { mode: 0o700 });
    chmodSync(secretsDirOf(state), 0o755);
    expect(() => writableLoginFile(state)).toThrow(UntrustedSecretsFolder);
    rmSync(secretsDirOf(state), { recursive: true });
    writeFileSync(secretsDirOf(state), "");
    expect(() => writableLoginFile(state)).toThrow(UntrustedSecretsFolder);
    expect(existsSync(join(elsewhere, "up-login.txt"))).toBe(false);
  });
});

describe("moving an older install's login into the reserved folder", () => {
  test("nothing beside the database: nothing to do", () => {
    expect(migrateLegacyLogin(state)).toEqual({ kind: "none" });
    expect(existsSync(secretsDirOf(state))).toBe(false);
  });

  test("moved whole, owner-only, as a fresh file: a hard link to the old one never reaches the new one", () => {
    const legacy = legacyLoginFileOf(state);
    writeFileSync(legacy, LOGIN, { mode: 0o600 });
    const other = join(state, "other-name");
    linkSync(legacy, other);
    expect(migrateLegacyLogin(state)).toMatchObject({ kind: "moved" });
    const moved = loginFileOf(state);
    expect(readFileSync(moved, "utf8")).toBe(LOGIN);
    expect(lstatSync(moved).mode & 0o777).toBe(0o600);
    expect(lstatSync(moved).ino).not.toBe(lstatSync(other).ino);
    expect(existsSync(legacy)).toBe(false);
    // No temporary file is left behind in the folder.
    expect(readdirNames(secretsDirOf(state))).toEqual(["up-login.txt"]);
    // A later rewrite through the other name changes nothing in the reserved folder.
    writeFileSync(other, "mallory planted\n");
    expect(readFileSync(moved, "utf8")).toBe(LOGIN);
  });

  test("a looser old file is moved in at 0600", () => {
    writeFileSync(legacyLoginFileOf(state), LOGIN, { mode: 0o644 });
    expect(migrateLegacyLogin(state)).toMatchObject({ kind: "moved" });
    expect(lstatSync(loginFileOf(state)).mode & 0o777).toBe(0o600);
  });

  test("a link at the old name is never followed or moved", () => {
    const target = join(state, "target.txt");
    writeFileSync(target, LOGIN, { mode: 0o600 });
    symlinkSync(target, legacyLoginFileOf(state));
    expect(migrateLegacyLogin(state)).toMatchObject({ kind: "refused" });
    expect(lstatSync(legacyLoginFileOf(state)).isSymbolicLink()).toBe(true);
    expect(existsSync(loginFileOf(state))).toBe(false);
  });

  test("a folder at the old name is left alone", () => {
    mkdirSync(legacyLoginFileOf(state));
    expect(migrateLegacyLogin(state)).toMatchObject({ kind: "refused" });
    expect(existsSync(loginFileOf(state))).toBe(false);
  });

  test("both there: the same login is deduplicated; a different one is left for the person and the reserved one wins", () => {
    writeFileSync(writableLoginFile(state), LOGIN, { mode: 0o600 });
    writeFileSync(legacyLoginFileOf(state), LOGIN, { mode: 0o600 });
    expect(migrateLegacyLogin(state)).toMatchObject({ kind: "deduplicated" });
    expect(existsSync(legacyLoginFileOf(state))).toBe(false);
    writeFileSync(legacyLoginFileOf(state), "bob other-login\n", { mode: 0o600 });
    expect(migrateLegacyLogin(state)).toMatchObject({ kind: "both" });
    expect(readFileSync(loginFileOf(state), "utf8")).toBe(LOGIN);
    expect(readFileSync(legacyLoginFileOf(state), "utf8")).toBe("bob other-login\n");
    expect(savedLoginFile(state)).toBe(loginFileOf(state));
  });

  test("an untrusted reserved folder stops the move: the old file stays where it is", () => {
    writeFileSync(legacyLoginFileOf(state), LOGIN, { mode: 0o600 });
    const elsewhere = join(state, "elsewhere");
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, secretsDirOf(state));
    expect(migrateLegacyLogin(state)).toMatchObject({ kind: "failed" });
    expect(readFileSync(legacyLoginFileOf(state), "utf8")).toBe(LOGIN);
    expect(existsSync(join(elsewhere, "up-login.txt"))).toBe(false);
  });
});

const readdirNames = (folder: string): string[] => readdirSync(folder).sort();
