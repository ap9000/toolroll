/** Releases up to 0.9.105 can't start on a Node whose SQLite is 3.54 or newer: their Tasks list is one statement 3.54
 * refuses. `toolroll update` refuses going back to one there (a rollback or --allow-downgrade), and says why. */
import { expect, test } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { oldReleaseProblem, runUpdateCommand, UPDATE_HELP } from "./toolroll-update-cli.js";

test("only a release up to 0.9.105, and only on SQLite 3.54 or newer", () => {
  for (const sqlite of ["3.54.0", "3.54.1", "3.60.2", "4.0.0"]) {
    expect(oldReleaseProblem("0.9.105", sqlite), sqlite).toContain("Toolroll 0.9.105 can't start on this Node");
    expect(oldReleaseProblem("0.9.102", sqlite), sqlite).toContain(`its SQLite (${sqlite}) refuses that release's Tasks list`);
    expect(oldReleaseProblem("0.9.106", sqlite), sqlite).toBeNull();
    expect(oldReleaseProblem("1.0.0", sqlite), sqlite).toBeNull();
  }
  for (const sqlite of ["3.50.4", "3.53.9", undefined]) expect(oldReleaseProblem("0.9.100", sqlite), String(sqlite)).toBeNull();
  expect(UPDATE_HELP).toContain("Releases 0.9.105 and earlier don't start on a Node whose SQLite is 3.54 or newer");
});

test("--allow-downgrade to such a release is refused before anything runs; on an older SQLite it goes on to its preview", async () => {
  const deps = { current: { version: "0.9.106", dist: "/nowhere/dist" }, method: { kind: "managed" as const, updateCommand: "toolroll update" }, databaseFile: join(tmpdir(), "so-update-old-release", "orders.db") };
  const refused: string[] = [];
  expect(await runUpdateCommand(["--version", "0.9.104", "--allow-downgrade", "--yes"], line => refused.push(line), { ...deps, sqlite: "3.54.1" })).toBe(1);
  expect(refused).toEqual([oldReleaseProblem("0.9.104", "3.54.1")]);
  const preview: string[] = [];
  expect(await runUpdateCommand(["--version", "0.9.104", "--allow-downgrade"], line => preview.push(line), { ...deps, sqlite: "3.50.4" })).toBe(0);
  expect(preview[0]).toBe("Update Toolroll 0.9.106 → 0.9.104.");
});
