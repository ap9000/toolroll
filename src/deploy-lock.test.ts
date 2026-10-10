import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { acquireDeploymentLock } from "./deploy-lock.js";
import { deploymentChild } from "../test/deploy-process.js";
import { spawnSync } from "node:child_process";

const lockModule = new URL("../dist/deploy-lock.js", import.meta.url).href;

test("a journal lock has explicit ownership, excludes contenders, and does not lock another journal", () => {
  const root = mkdtempSync(join(tmpdir(), "deploy-lock-")), journal = join(root, "deployment.json");
  const lock = acquireDeploymentLock(journal);
  try {
    lock.assertHeld(journal);
    expect(() => lock.assertHeld(join(root, "another.json"))).toThrow("not held");
    expect(() => acquireDeploymentLock(journal, 0)).toThrow("busy");
    const other = acquireDeploymentLock(join(root, "another.json"), 0);
    other.release();
    lock.release(); lock.release();
    expect(() => lock.assertHeld(journal)).toThrow("not held");
    acquireDeploymentLock(journal, 0).release();
  } finally { lock.release(); rmSync(root, { recursive: true, force: true }); }
});

test("a rejected contender in the same process cannot drop the owner's kernel lock", () => {
  const root = mkdtempSync(join(tmpdir(), "deploy-lock-local-")), journal = join(root, "deployment.json");
  const owner = acquireDeploymentLock(journal);
  try {
    expect(() => acquireDeploymentLock(journal, 0)).toThrow("busy");
    const outsider = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { acquireDeploymentLock } from ${JSON.stringify(lockModule)};
      try { const lock = acquireDeploymentLock(${JSON.stringify(journal)}, 0); console.log('held'); lock.release(); }
      catch { console.log('busy'); }
    `], { encoding: 'utf8' });
    expect(outsider.status).toBe(0);
    expect(outsider.stdout.trim()).toBe('busy');
  } finally { owner.release(); rmSync(root, { recursive: true, force: true }); }
});

test("SIGKILL releases exclusion without stale-file takeover and two contenders cannot both own it", async () => {
  const root = mkdtempSync(join(tmpdir(), "deploy-lock-kill-")), journal = join(root, "deployment.json");
  const contender = () => deploymentChild(`
    import { acquireDeploymentLock } from ${JSON.stringify(lockModule)};
    process.send('ready');
    process.on('message', message => {
      if (message === 'acquire') {
        try { globalThis.lock = acquireDeploymentLock(${JSON.stringify(journal)}, 0); process.send('held'); }
        catch { process.send('busy'); }
      }
    });`);
  const owner = contender(), a = contender(), b = contender();
  try {
    await Promise.all([owner.message(), a.message(), b.message()]);
    owner.child.send("acquire"); expect(await owner.message()).toBe("held");
    a.child.send("acquire"); b.child.send("acquire");
    expect(await Promise.all([a.message(), b.message()])).toEqual(["busy", "busy"]);
    await owner.stop();
    a.child.send("acquire"); b.child.send("acquire");
    const results = await Promise.all([a.message(), b.message()]);
    expect(results.sort()).toEqual(["busy", "held"]);
  } finally {
    await Promise.all([owner.stop(), a.stop(), b.stop()]);
    acquireDeploymentLock(journal, 0).release();
    rmSync(root, { recursive: true, force: true });
  }
});
