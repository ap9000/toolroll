/**
 * The checkout lock (git-views.ts lockCheckout): one holder at a time, across connections in this process and across
 * processes; a holder that dies lets go at once (the OS drops its lock: nothing stale to recover, no pid to be reused);
 * a release lets go of its own lock only, once.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { gitViewsRoot, lockCheckout } from "./git-views.js";

let home: string;
const children: ChildProcess[] = [];
beforeEach(() => { home = realpathSync(mkdtempSync(join(tmpdir(), "so-lock-"))); });
afterEach(() => { for (const child of children.splice(0)) child.kill("SIGKILL"); rmSync(home, { recursive: true, force: true }); });

const blocked = async (checkout: string): Promise<boolean> => {
  try { (await lockCheckout(home, checkout, 150))(); return false; } catch (error) { expect(String(error)).toMatch(/still running/); return true; }
};

test("one holder at a time in this process; the next takes it once released", async () => {
  const release = await lockCheckout(home, "/work/a");
  expect(await blocked("/work/a")).toBe(true);
  expect(await blocked("/work/b")).toBe(false);
  const waiting = lockCheckout(home, "/work/a", 5_000);
  release();
  (await waiting)();
});

test("a release lets go of its own lock only, and only once", async () => {
  const first = await lockCheckout(home, "/work/a");
  first();
  const second = await lockCheckout(home, "/work/a");
  first(); // a stale release: second still holds it
  expect(await blocked("/work/a")).toBe(true);
  second();
  expect(await blocked("/work/a")).toBe(false);
});

test("a holder in another process blocks it; killed, it lets go at once (nothing stale left to recover)", async () => {
  const built = join(process.cwd(), "dist", "git-views.js");
  if (!existsSync(built)) throw new Error("the suite's setup builds dist");
  const child = spawn(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(pathToFileURL(built).href)}); await m.lockCheckout(${JSON.stringify(home)}, "/work/a"); console.log("held"); setInterval(() => {}, 1000);`],
    { stdio: ["ignore", "pipe", "inherit"] });
  children.push(child);
  await new Promise<void>((done, failed) => { child.once("error", failed); child.stdout!.once("data", () => done()); });
  expect(await blocked("/work/a")).toBe(true);
  child.kill("SIGKILL");
  await new Promise(done => child.once("close", done));
  (await lockCheckout(home, "/work/a", 2_000))();
});

test("an empty lock file (a crash before anything was written) holds nothing; one that isn't a lock refuses plainly", async () => {
  const at = (checkout: string) => join(gitViewsRoot(home), "locks", `${createHash("sha256").update(checkout).digest("hex")}.lockdb`);
  (await lockCheckout(home, "/work/seed"))();
  writeFileSync(at("/work/empty"), "");
  (await lockCheckout(home, "/work/empty", 1_000))();
  writeFileSync(at("/work/garbage"), "x".repeat(4096));
  await expect(lockCheckout(home, "/work/garbage", 1_000)).rejects.toThrow(/not a database|file is not/i);
});
