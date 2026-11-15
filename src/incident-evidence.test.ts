/**
 * A failed CI run keeps its git incident records (test/incident-evidence.ts): copied out of the throwaway homes before
 * they go, never through a link, at most the last 256 KiB of each, and only on CI or where a folder is named.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { incidentEvidenceFolder, keepIncidentRecord, keepIncidentRecordsUnder } from "../test/incident-evidence.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "so-incidents-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const record = (home: string, text: string): string => {
  mkdirSync(join(home, ".toolroll"), { recursive: true });
  writeFileSync(join(home, ".toolroll", "git-incidents.jsonl"), text);
  return join(home, ".toolroll", "git-incidents.jsonl");
};

describe("git incident records for a failed CI run", () => {
  test("kept only on CI or where a folder is named", () => {
    expect(incidentEvidenceFolder({}, "/t")).toBeNull();
    expect(incidentEvidenceFolder({ CI: "false" }, "/t")).toBeNull();
    expect(incidentEvidenceFolder({ CI: "true" }, "/t")).toBe("/t/toolroll-git-incidents");
    expect(incidentEvidenceFolder({ TOOLROLL_TEST_INCIDENTS: "/runner/temp/git-incidents" }, "/t")).toBe("/runner/temp/git-incidents");
    expect(incidentEvidenceFolder({ TOOLROLL_TEST_INCIDENTS: "relative" }, "/t")).toBeNull();
  });

  test("every home's record under a folder is copied; a link is never followed; each is capped", () => {
    const line = `${JSON.stringify({ at: "2026-11-15T00:00:00.000Z", checkout: "/c", repository: "/r", swapped: [] })}\n`;
    record(join(dir, "root", "worker", "home"), line);
    record(join(dir, "root", "a-test", "home"), "x".repeat(300 * 1024) + line);
    const secret = join(dir, "secret.txt");
    writeFileSync(secret, "not a record\n");
    mkdirSync(join(dir, "root", "linked", "home", ".toolroll"), { recursive: true });
    symlinkSync(secret, join(dir, "root", "linked", "home", ".toolroll", "git-incidents.jsonl"));
    const out = join(dir, "out");
    expect(keepIncidentRecordsUnder(join(dir, "root"), out, "temp-root")).toBe(2);
    const kept = readdirSync(out).map(name => readFileSync(join(out, name), "utf8"));
    expect(kept).toHaveLength(2);
    expect(kept.every(text => text.endsWith(line))).toBe(true);
    expect(Math.max(...kept.map(text => text.length))).toBe(256 * 1024);
    expect(kept.some(text => text.includes("not a record"))).toBe(false);
    // An empty or missing record is nothing to keep.
    expect(keepIncidentRecord(join(dir, "missing.jsonl"), out, "x")).toBe(false);
  });
});
