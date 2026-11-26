/**
 * The deploy check's rehearsal (scripts/deploy-check.mjs, docs/plans/release-from-main.md part C): its rules, and on a
 * Mac the real thing — the Seatbelt fence refusing the network and writes outside the throwaway folder, and the built
 * candidate upgrading and serving a copy of a database where a backup is due, webhooks, a Telegram bot and a phone
 * notification wait, then every process stopped and the copy gone.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { buildInFence, fenced, fenceProfile, freePort, migrationProblem, rehearse, SECRET_FOLDERS, stopGroup } from "../scripts/deploy-check.mjs";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { PassThrough } from "node:stream";
import { INSIDE_FENCE } from "../test/inside-fence.js";
import { openStore } from "./store.js";

const REAL_MAC = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec") && !INSIDE_FENCE;
const table = (name: string, count: number, hash: string) => ({ name, columns: ["id"], count, hash });

describe("deploy check rules", () => {
  test("the upgraded copy keeps history: same schema keeps every row, a new one changes history only by the update rules", () => {
    const ok = { from: 184, to: 185, wanted: 185, changed: [], integrity: "ok", foreign: 0 };
    expect(migrationProblem(ok, { before: [table("task", 2, "a")], after: [table("task", 2, "b")] })).toBeNull();
    for (const [result, why] of [
      [null, /didn't report/],
      [{ ...ok, to: 184 }, /schema 184, not the candidate's 185/],
      [{ ...ok, integrity: "corrupt" }, /integrity/],
      [{ ...ok, foreign: 1 }, /foreign-key/],
      [{ ...ok, changed: ["task"] }, /history changed: task/],
    ] as const) expect(migrationProblem(result, { before: [], after: [] })).toMatch(why);
    const same = { ...ok, from: 185 };
    expect(migrationProblem(same, { before: [table("task", 2, "a")], after: [table("task", 2, "a")] })).toBeNull();
    expect(migrationProblem(same, { before: [table("task", 2, "a")], after: [table("task", 1, "c")] })).toMatch(/changed rows of task/);
  });

  test("the fence: reads denied by default, writes only in the throwaway folder, the rehearsal's own port alone; macOS only", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "so-fence-")));
    const profile = fenceProfile({ root, home: "/Users/sam", port: 41234 });
    expect(profile).toContain("(deny file-read-data)");
    expect(profile).toContain(`(allow file-read-data (subpath "${root}")`);
    expect(profile).not.toMatch(/subpath "\/Users\/sam"\)/);
    expect(profile).toContain("(deny network*)");
    expect(profile).toContain(`(allow network-outbound (remote ip "localhost:41234"))`);
    expect(profile).not.toContain(`localhost:*`);
    expect(profile).toContain("(deny file-write*)");
    expect(profile).toContain(`(allow file-write* (subpath "${root}")`);
    for (const folder of [".toolroll", ".ssh", "Library/Keychains"]) expect(SECRET_FOLDERS).toContain(folder);
    expect(profile).toContain(`(subpath "/Users/sam/.toolroll")`);
    // No port: no network at all; a build may write into its checkout, never its .git.
    const quiet = fenceProfile({ root, home: "/Users/sam", checkout: root, build: true });
    expect(quiet).not.toContain("localhost");
    expect(quiet).toContain(`(deny file-write* (subpath "${join(root, ".git")}"))`);
    expect(fenced("darwin", "/f.sb", ["node", "x"])).toEqual(["/usr/bin/sandbox-exec", "-f", "/f.sb", "node", "x"]);
    expect(fenced("linux", "/f.sb", ["node"])).toBeNull();
  });

  test("stopping a process group: TERM, then KILL, proven gone; a group that won't go is said", async () => {
    const signals: (string | number)[] = [];
    let alive = true;
    const kill = (_pid: number, signal: string | number) => { signals.push(signal); if (signal === "SIGKILL") alive = false; if (signal === 0 && !alive) throw Object.assign(new Error("gone"), { code: "ESRCH" }); return true; };
    expect(await stopGroup(42, { kill, waitMs: 300, sleep: async () => {} })).toBeNull();
    expect(signals).toContain("SIGTERM");
    expect(signals).toContain("SIGKILL");
    const stubborn = (_pid: number, _signal: string | number) => true;
    expect(await stopGroup(42, { kill: stubborn, waitMs: 100, sleep: async () => {} })).toMatch(/still running after SIGKILL/);
  });
});

describe("the rehearsal fails closed", () => {
  /** A copy and stand-ins for every candidate process (the platform says macOS, so the fence is written, never run). */
  function standIns(options: { stuck?: boolean; health?: number } = {}) {
    const copyDir = realpathSync(mkdtempSync(join(tmpdir(), "toolroll-deploy-check-unit-")));
    const copy = join(copyDir, "orders.db");
    openStore(copy).close();
    const signals: (string | number)[] = [];
    let port = 0;
    const io = {
      platform: "darwin" as const, home: copyDir, say: () => {},
      spawnSync: (_cmd: string, args: readonly string[]) => args.includes("task")
        ? { status: 0, stdout: JSON.stringify({ ok: true, tasks: [] }), stderr: "" }
        : { status: 0, stdout: `${JSON.stringify({ from: 184, to: 184, wanted: 184, changed: [], integrity: "ok", foreign: 0 })}\n`, stderr: "" },
      spawn: (_cmd: string, args: readonly string[]) => {
        port = Number(args[args.indexOf("--port") + 1]);
        const child = Object.assign(new EventEmitter(), { pid: 999_999_9, stdout: new PassThrough(), stderr: new PassThrough() });
        queueMicrotask(() => child.stdout.write(`${JSON.stringify({ ok: true, command: "serve", port }, null, 2)}\n`));
        return child;
      },
      fetch: async (_url: string, init: { redirect?: string }) => { expect(init.redirect).toBe("manual"); return { status: options.health ?? 200 }; },
      kill: (_pid: number, signal: string | number) => { signals.push(signal); if (!options.stuck && signal !== 0) throw Object.assign(new Error("gone"), { code: "ESRCH" }); if (!options.stuck && signals.includes("SIGTERM")) throw Object.assign(new Error("gone"), { code: "ESRCH" }); return true; },
      sleep: async () => {},
    };
    return { copy, copyDir, io, signals };
  }

  test("a rehearsal whose console won't stop fails, saying so, even when everything else passed", async () => {
    const { copy, io } = standIns({ stuck: true });
    const outcome = await rehearse({ checkout: resolve(import.meta.dirname, ".."), copy }, io as never);
    expect(outcome).toMatchObject({ ok: false, step: "cleanup", why: expect.stringMatching(/still running after SIGKILL/) });
    expect(existsSync(copy)).toBe(false);
  });

  test("a redirect is no answer; a clean run leaves nothing behind", async () => {
    const redirected = standIns({ health: 302 });
    expect(await rehearse({ checkout: resolve(import.meta.dirname, ".."), copy: redirected.copy }, redirected.io as never)).toMatchObject({ ok: false, step: "health" });
    const clean = standIns();
    expect(await rehearse({ checkout: resolve(import.meta.dirname, ".."), copy: clean.copy }, clean.io as never)).toMatchObject({ ok: true });
    expect(readdirSync(clean.copyDir).filter(name => /^(world|.*\.sb|orders\.db.*)$/.test(name))).toEqual([]);
  });
});

describe.skipIf(!REAL_MAC)("deploy check on this Mac (sandbox-exec)", () => {
  test("the fence refuses the network, other loopback ports, reads and writes outside; its own port and folder work", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "so-fence-real-")));
    const inside = join(root, "box");
    mkdirSync(inside);
    writeFileSync(join(root, "secret.txt"), "not yours");
    // A live console of the computer's own, on another loopback port.
    const other = createServer(socket => socket.end("live")).listen(0, "127.0.0.1");
    await new Promise<void>(done => other.once("listening", () => done()));
    const otherPort = (other.address() as { port: number }).port;
    const port = await freePort();
    writeFileSync(join(inside, "fence.sb"), fenceProfile({ root: inside, port }));
    const probe = `
      const fs = require("node:fs"), net = require("node:net");
      const out = {};
      try { fs.writeFileSync(${JSON.stringify(join(root, "outside.txt"))}, "x"); out.outside = "written"; } catch (e) { out.outside = e.code; }
      try { fs.readFileSync(${JSON.stringify(join(root, "secret.txt"))}); out.read = "read"; } catch (e) { out.read = e.code; }
      try { fs.writeFileSync(${JSON.stringify(join(inside, "inside.txt"))}, "x"); out.inside = "written"; } catch (e) { out.inside = e.code; }
      const tryConnect = (p, host) => new Promise(done => { const s = net.connect(p, host); s.on("connect", () => { s.destroy(); done("connected"); }); s.on("error", e => done(e.code)); });
      const server = net.createServer(s => { s.on("error", () => {}); s.end("hi"); }).listen(${port}, "127.0.0.1", async () => {
        out.own = await tryConnect(${port}, "127.0.0.1");
        out.otherPort = await tryConnect(${otherPort}, "127.0.0.1");
        out.network = await tryConnect(443, "1.1.1.1");
        server.close(); console.log(JSON.stringify(out));
      });
      server.on("error", e => { out.own = e.code; console.log(JSON.stringify(out)); });`;
    try {
      const ran = execFileSync("/usr/bin/sandbox-exec", ["-f", join(inside, "fence.sb"), process.execPath, "-e", probe], { encoding: "utf8", timeout: 30_000 });
      const out = JSON.parse(ran.trim().split("\n").at(-1)!);
      expect(out).toMatchObject({ outside: "EPERM", read: "EPERM", inside: "written", own: "connected" });
      expect(out.otherPort).not.toBe("connected");
      expect(out.network).not.toBe("connected");
    } finally { other.close(); }
  });

  test("from a folder inside ~/.config (a plane's check), the fenced candidate reads its own folder but not the database beside it", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "so-fence-home-real-")));
    const plane = join(home, ".config", "standing-orders");
    const box = join(plane, "worktrees", "rc");
    mkdirSync(box, { recursive: true });
    writeFileSync(join(plane, "orders.db"), "the live database");
    writeFileSync(join(box, "own.txt"), "mine");
    writeFileSync(join(box, "fence.sb"), fenceProfile({ root: box, home, checkout: box }));
    const probe = `
      const fs = require("node:fs"); const out = {};
      try { out.own = fs.readFileSync(${JSON.stringify(join(box, "own.txt"))}, "utf8"); } catch (e) { out.own = e.code; }
      try { fs.readFileSync(${JSON.stringify(join(plane, "orders.db"))}); out.db = "read"; } catch (e) { out.db = e.code; }
      try { fs.readdirSync(${JSON.stringify(plane)}); out.list = "listed"; } catch (e) { out.list = e.code; }
      console.log(JSON.stringify(out));`;
    const ran = execFileSync("/usr/bin/sandbox-exec", ["-f", join(box, "fence.sb"), process.execPath, "-e", probe], { encoding: "utf8", timeout: 30_000 });
    expect(JSON.parse(ran.trim().split("\n").at(-1)!)).toEqual({ own: "mine", db: "EPERM", list: "EPERM" });
  });

  test("the build runs inside the fence: it writes its output, and a build that writes outside its checkout fails", () => {
    const make = (script: string) => {
      const box = realpathSync(mkdtempSync(join(tmpdir(), "so-build-fence-")));
      const checkout = join(box, "checkout"), copyDir = join(box, "copy");
      mkdirSync(checkout); mkdirSync(copyDir, { mode: 0o700 });
      writeFileSync(join(checkout, "package.json"), JSON.stringify({ name: "x", version: "1.0.0", scripts: { build: script } }));
      writeFileSync(join(copyDir, "orders.db"), "");
      return { box, checkout, copy: join(copyDir, "orders.db") };
    };
    const good = make(`node -e "require('fs').mkdirSync('dist',{recursive:true}); require('fs').writeFileSync('dist/out.txt','built')"`);
    expect(buildInFence({ checkout: good.checkout, copy: good.copy })).toEqual({ ok: true });
    expect(existsSync(join(good.checkout, "dist", "out.txt"))).toBe(true);
    const bad = make(`node -e "require('fs').writeFileSync('../escaped.txt','x')"`);
    expect(buildInFence({ checkout: bad.checkout, copy: bad.copy })).toMatchObject({ ok: false });
    expect(existsSync(join(bad.box, "escaped.txt"))).toBe(false);
  });

  test("the built candidate upgrades and serves a copy with everything due or waiting, then nothing of it is left", async () => {
    const checkout = resolve(import.meta.dirname, "..");
    expect(existsSync(join(checkout, "dist", "bin.js"))).toBe(true);
    const copyDir = realpathSync(mkdtempSync(join(tmpdir(), "toolroll-deploy-check-test-")));
    const copy = join(copyDir, "orders.db");
    const store = openStore(copy);
    const now = new Date("2026-11-25T09:00:00.000Z");
    store.setBackupSettings({ enabled: true, everyHours: 1, keep: 3, folder: null }, "alex", now);
    store.enqueueNotification({ dedupeKey: "release:0.9.119", kind: "attempts-exhausted", pushClass: "attention", subject: "A release waits for you", body: "Release 0.9.119" }, now);
    store.close();
    writeFileSync(join(copyDir, "slack-webhook"), "https://hooks.slack.com/services/T000/B000/xxxx\n", { mode: 0o600 });
    writeFileSync(join(copyDir, "telegram-token"), "123456:ABCDEF\n", { mode: 0o600 });
    const said: string[] = [];
    const outcome = await rehearse({ checkout, copy }, { say: line => said.push(line) });
    // The release check's log keeps only the assertion line, so the reason goes into it (release check 3366 failed
    // here at step "upgrade" with the reason cut off).
    expect(outcome.ok ? "" : `${outcome.step}: ${outcome.why}`).toBe("");
    expect(outcome, said.join("\n")).toMatchObject({ ok: true });
    expect(said.some(line => /still running/.test(line))).toBe(false);
    // The copy and the throwaway computer are gone; no console of it is left running.
    expect(existsSync(copy)).toBe(false);
    expect(readdirSync(copyDir)).not.toContain("world");
    const left = spawnSync("/bin/ps", ["-axww", "-o", "command="], { encoding: "utf8" }).stdout.split("\n").filter(line => line.includes(copyDir));
    expect(left).toEqual([]);
  }, 120_000);
});
