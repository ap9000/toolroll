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
import { fenced, fenceProfile, migrationProblem, rehearse, SECRET_FOLDERS, stopGroup } from "../scripts/deploy-check.mjs";
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

  test("the fence: loopback only, writes only in the throwaway folder, the person's secret folders unreadable; macOS only", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "so-fence-")));
    const profile = fenceProfile({ root, home: "/Users/sam" });
    expect(profile).toContain("(deny network*)");
    expect(profile).toContain(`(allow network-outbound (remote ip "localhost:*"))`);
    expect(profile).toContain("(deny file-write*)");
    expect(profile).toContain(`(allow file-write* (subpath "${root}")`);
    for (const folder of [".toolroll", ".ssh", "Library/Keychains"]) expect(SECRET_FOLDERS).toContain(folder);
    expect(profile).toContain(`(subpath "/Users/sam/.toolroll")`);
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

describe.skipIf(!REAL_MAC)("deploy check on this Mac (sandbox-exec)", () => {
  test("the fence refuses the network and writes outside the folder; loopback and the folder work", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "so-fence-real-")));
    const inside = join(root, "box");
    mkdirSync(inside);
    writeFileSync(join(inside, "fence.sb"), fenceProfile({ root: inside }));
    const probe = `
      const fs = require("node:fs"), net = require("node:net");
      const out = {};
      try { fs.writeFileSync(${JSON.stringify(join(root, "outside.txt"))}, "x"); out.outside = "written"; } catch (e) { out.outside = e.code; }
      try { fs.writeFileSync(${JSON.stringify(join(inside, "inside.txt"))}, "x"); out.inside = "written"; } catch (e) { out.inside = e.code; }
      const server = net.createServer(s => s.end("hi")).listen(0, "127.0.0.1", () => {
        const loop = net.connect(server.address().port, "127.0.0.1");
        loop.on("data", () => { out.loopback = "ok"; loop.destroy();
          const away = net.connect(443, "1.1.1.1");
          away.on("connect", () => { out.network = "connected"; finish(); });
          away.on("error", e => { out.network = e.code; finish(); });
        });
        loop.on("error", e => { out.loopback = e.code; finish(); });
      });
      function finish() { server.close(); console.log(JSON.stringify(out)); }`;
    const ran = execFileSync("/usr/bin/sandbox-exec", ["-f", join(inside, "fence.sb"), process.execPath, "-e", probe], { encoding: "utf8", timeout: 30_000 });
    const out = JSON.parse(ran.trim().split("\n").at(-1)!);
    expect(out).toMatchObject({ outside: "EPERM", inside: "written", loopback: "ok" });
    expect(out.network).not.toBe("connected");
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
    expect(outcome, said.join("\n")).toMatchObject({ ok: true });
    expect(said.some(line => /still running/.test(line))).toBe(false);
    // The copy and the throwaway computer are gone; no console of it is left running.
    expect(existsSync(copy)).toBe(false);
    expect(readdirSync(copyDir)).not.toContain("world");
    const left = spawnSync("/bin/ps", ["-axww", "-o", "command="], { encoding: "utf8" }).stdout.split("\n").filter(line => line.includes(copyDir));
    expect(left).toEqual([]);
  }, 120_000);
});
