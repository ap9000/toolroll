/**
 * The recorded remote's main (remote-main.ts): which URLs Toolroll fetches from, and that every fetch runs in a fresh
 * private Git directory with nothing inherited from the system, the user or the shared repository.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { run, type RunOptions } from "./exec.js";
import { RemoteMains, parseRemoteUrl, remoteUrlProblem } from "./remote-main.js";

let dir: string, store: Store;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-remote-main-")));
  store = openStore(join(dir, "orders.db"));
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

test("only credential-free https and ssh remotes are trusted; local and file URLs never are", () => {
  for (const url of ["https://github.com/sam/shop.git", "ssh://git@github.com/sam/shop.git", "git@github.com:sam/shop.git"]) {
    expect(parseRemoteUrl(url)).toMatchObject({ kind: "network" });
    expect(remoteUrlProblem(url)).toBeNull();
  }
  for (const url of ["C:/shop.git", "file:/srv/git/shop.git", "/srv/git/shop.git", "file:///srv/git/shop.git", "ext::sh -c id", "fd::3", "http://example.com/x.git", "git://example.com/x.git", "https://me:pw@example.com/x.git",
    "https://token@example.com/x.git", "https://example.com/x?token=secret", "../shop.git", "shop.git", "-uhelp", "https://example.com/x\n.git", "",
    // Loopback: this machine, where builds run.
    "https://localhost/shop.git", "https://LocalHost./shop.git", "ssh://git@localhost/shop.git", "git@localhost:shop.git", "git@LOCALHOST:shop.git", "https://git.localhost/x.git",
    "https://127.0.0.1/x.git", "https://127.255.255.254:8443/x.git", "ssh://git@127.0.0.1/x.git", "ssh://127.1/x.git", "git@127.0.0.1:x.git", "git@127.9.9.9:x.git",
    "https://0x7f.1/x.git", "ssh://2130706433/x.git", "git@0177.0.0.1:x.git", "https://0.0.0.0/x.git",
    "https://[::1]/x.git", "ssh://git@[::1]/x.git", "ssh://[0:0:0:0:0:0:0:1]:22/x.git", "https://[::ffff:127.0.0.1]/x.git"]) {
    expect(parseRemoteUrl(url)).toHaveProperty("why");
    expect(remoteUrlProblem(url)).not.toBeNull();
  }
});

test("addresses beside loopback stay trusted", () => {
  for (const url of ["https://126.255.255.255/x.git", "https://128.0.0.1/x.git", "ssh://git@[2001:db8::1]/x.git", "git@10.0.0.127:x.git", "https://localhost.example.com/x.git", "git@my-localhost:x.git"])
    expect(remoteUrlProblem(url), url).toBeNull();
});

test("production refuses file transport for the recorded remote; only a test fixture opts in, and only the local result fetch allows it", async () => {
  const sh = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
  const origin = join(dir, "origin.git"), repo = join(dir, "shop"), scratch = join(dir, "evidence");
  sh(dir, ["init", "-q", "--bare", "-b", "main", origin]);
  mkdirSync(repo);
  sh(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "a"), "a\n");
  sh(repo, ["add", "."]);
  sh(repo, ["commit", "-qm", "a"]);
  sh(repo, ["push", "-q", origin, "main"]);
  store.upsertProject(repo, "shop", new Date(), { remoteUrl: "https://trusted.example/shop.git" });
  const calls: (readonly string[])[] = [];
  const fileAllowed = (args: readonly string[]) => args.filter(arg => arg.startsWith("protocol.file.allow="));
  // The URL alone maps to the local fixture: git sees a local path and production's settings refuse it.
  const mapped = new RemoteMains(store, (file, args, options) => { calls.push(args); return run(file, args.map(arg => arg === "https://trusted.example/shop.git" ? origin : arg), options); }, scratch, "");
  expect(await mapped.read(repo)).toEqual({ ok: false, why: "Toolroll couldn't read the project's remote main" });
  expect(fileAllowed(calls[1]!)).toEqual(["protocol.file.allow=never"]);
  mapped.close();
  // The fixture opts its one remote fetch in; the result's commit comes from the registered project path, never a relative one.
  calls.length = 0;
  const fixture = new RemoteMains(store, (file, args, options) => {
    calls.push(args);
    return run(file, args.includes("https://trusted.example/shop.git") ? args.map(arg => arg === "https://trusted.example/shop.git" ? origin : arg === "protocol.file.allow=never" ? "protocol.file.allow=always" : arg) : args, options);
  }, scratch, "");
  const read = await fixture.read(repo);
  if (!read.ok) throw new Error(read.why);
  sh(repo, ["commit", "-q", "--allow-empty", "-m", "b"]);
  const head = sh(repo, ["rev-parse", "HEAD"]);
  expect(await read.remote.bring("shop", head)).toBe(false);
  expect(await read.remote.bring(repo, head)).toBe(true);
  expect(calls.filter(args => args.includes("fetch")).map(args => [args[args.indexOf("--") + 1], fileAllowed(args)])).toEqual([
    ["https://trusted.example/shop.git", ["protocol.file.allow=never"]], [repo, ["protocol.file.allow=always"]]]);
  fixture.close();
});

test("a fetch runs in a fresh private directory with system, global and replace config off, and leaves nothing behind", async () => {
  const sh = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
  const origin = join(dir, "origin.git"), repo = join(dir, "shop"), scratch = join(dir, "evidence");
  sh(dir, ["init", "-q", "--bare", "-b", "main", origin]);
  mkdirSync(repo);
  sh(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "a"), "a\n");
  sh(repo, ["add", "."]);
  sh(repo, ["commit", "-qm", "a"]);
  sh(repo, ["push", "-q", origin, "main"]);
  store.upsertProject(repo, "shop", new Date(), { remoteUrl: "https://trusted.example/shop.git" });
  const calls: { args: readonly string[]; options: RunOptions | undefined }[] = [];
  const remotes = new RemoteMains(store, (file, args, options) => {
    calls.push({ args, options });
    return run(file, args.map(arg => arg === "https://trusted.example/shop.git" ? origin : arg === "protocol.file.allow=never" ? "protocol.file.allow=always" : arg), options);
  }, scratch, "");
  const read = await remotes.read(repo);
  expect(read.ok && read.remote.main).toBe(sh(repo, ["rev-parse", "main"]));
  for (const { options } of calls) {
    expect(options?.env).toMatchObject({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0" });
    expect(options?.envAllowlist).not.toContain("GIT_DIR");
  }
  expect(calls[0]!.args).toEqual(expect.arrayContaining(["init", "--bare", "--template="]));
  expect(calls[1]!.args).toEqual(expect.arrayContaining(["protocol.ext.allow=never", "protocol.file.allow=never", "core.hooksPath=/dev/null", "credential.helper=", "--", "https://trusted.example/shop.git", "+refs/heads/main:refs/toolroll/remote-main"]));
  expect(calls[1]!.args.filter(arg => arg.startsWith("credential.helper="))).toEqual(["credential.helper="]);
  remotes.close();
  expect(existsSync(scratch) ? readdirSync(scratch) : []).toEqual([]);
});
