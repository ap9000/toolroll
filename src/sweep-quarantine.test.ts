import { afterEach, beforeEach, expect, test } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimQuarantine, deleteQuarantine, quarantineEntries, restoreQuarantine } from "./sweep-quarantine.js";

let root: string;
const children: ChildProcess[] = [];
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "so-quarantine-"))); });
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  }
  rmSync(root, { recursive: true, force: true });
});

test("a crashed sweep's intact quarantine can be claimed once and restored; a live owner's cannot", async () => {
  const original = join(root, "browser-old");
  mkdirSync(original); writeFileSync(join(original, "payload"), "keep this runtime");
  const script = `
    import { quarantine } from ${JSON.stringify(new URL("../dist/sweep-quarantine.js", import.meta.url).href)};
    quarantine(process.argv[1], {fixture: 'intact'});
    process.send('quarantined'); process.on('message', () => {});
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, original], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  children.push(child);
  await once(child, "message");
  const [entry] = quarantineEntries<{ fixture: string }>(root);
  expect(entry!.journal.data).toEqual({ fixture: "intact" });
  expect(claimQuarantine(entry!)).toBeNull();
  expect(existsSync(original)).toBe(false);
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  const claimed = claimQuarantine(entry!)!;
  expect(claimed).not.toBeNull();
  expect(claimQuarantine(entry!)).toBeNull();
  expect(restoreQuarantine(claimed)).toBe(true);
  expect(readFileSync(join(original, "payload"), "utf8")).toBe("keep this runtime");
  expect(quarantineEntries(root)).toEqual([]);
});

test("a process killed during deletion leaves hidden trash that the next sweep can finish but cannot restore", async () => {
  const original = join(root, "browser-old");
  mkdirSync(original); writeFileSync(join(original, "first"), "first"); writeFileSync(join(original, "second"), "second");
  const script = `
    import { rmSync } from 'node:fs';
    import { quarantine, deleteQuarantine } from ${JSON.stringify(new URL("../dist/sweep-quarantine.js", import.meta.url).href)};
    const entry = quarantine(process.argv[1], {fixture: 'partly deleted'});
    await deleteQuarantine(entry, async path => { rmSync(path, {recursive:true, force:true}); process.send('partly deleted'); await new Promise(() => {}); });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, original], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  children.push(child);
  await once(child, "message");
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  const claimed = claimQuarantine(quarantineEntries(root)[0]!)!;
  expect(claimed.journal.deleting).toBe(true);
  expect(restoreQuarantine(claimed)).toBe(false);
  await deleteQuarantine(claimed, path => rmSync(path, { recursive: true, force: true }));
  expect(existsSync(original)).toBe(false);
  expect(quarantineEntries(root)).toEqual([]);
});
