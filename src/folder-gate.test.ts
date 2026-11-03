/**
 * The folder gate (folder-gate.ts), and the rule it serves: nothing in Toolroll walks the filesystem from "/" or into
 * /Volumes synchronously. A drive that hangs answers neither, and a synchronous read of either on the console's thread
 * freezes every page (src/server/console-folder-hang.test.ts proves the console's pages and background pass at runtime).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "vitest";
import { folderAnswers, installFolderGate } from "./folder-gate.js";

test("no gate: every read goes ahead; with gates: a read goes ahead when any of them lets it, and stops once removed", () => {
  expect(folderAnswers("/anywhere")).toBe(true);
  const removeA = installFolderGate(path => path.startsWith("/data/"));
  const removeB = installFolderGate(path => path === "/projects/one");
  try {
    expect([folderAnswers("/data/x"), folderAnswers("/projects/one"), folderAnswers("/projects/two"), folderAnswers("/Volumes/Drive")]).toEqual([true, true, false, false]);
  } finally { removeA(); removeB(); }
  expect(folderAnswers("/projects/two")).toBe(true);
});

/** A directory read, a mount's statistics, or a folder opened, whose argument is "/" or names /Volumes (a literal, or
 * the root/Volumes spelled through a path helper). */
const ROOT_WALK = /\b(readdirSync|opendirSync|statfsSync|readdir|opendir|statfs|scandir)\s*\(\s*(?:["'`]\/(?:Volumes\b[^"'`]*)?["'`]|(?:join|resolve)\(\s*["'`]\/["'`]\s*[,)]|["'`]\/Volumes)/;

test("no source file walks \"/\" or /Volumes", () => {
  const root = join(import.meta.dirname);
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!/\.(ts|mts|js|mjs)$/.test(entry.name) || /\.test\.ts$/.test(entry.name)) continue;
      readFileSync(path, "utf8").split("\n").forEach((line, index) => {
        if (ROOT_WALK.test(line)) offenders.push(`${relative(root, path)}:${index + 1}: ${line.trim()}`);
      });
    }
  };
  walk(root);
  expect(offenders).toEqual([]);
  // The rule itself catches what it is for.
  for (const bad of ['readdirSync("/")', "readdirSync('/Volumes')", "opendirSync(`/Volumes/${drive}`)", 'statfsSync("/Volumes/DataDrive")', 'readdirSync(join("/", name))', "await readdir('/')"]) expect(ROOT_WALK.test(bad), bad).toBe(true);
  for (const fine of ['readdirSync(folder)', 'readdirSync("/proc")', 'const fenced = ["/Volumes", "/Network"]']) expect(ROOT_WALK.test(fine), fine).toBe(false);
});
