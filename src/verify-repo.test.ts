/** `verify --repo` names the project, not the text typed (everyday-8 #3): `.`, a relative path from another folder and a
 * symlinked spelling all mean the registered project's recorded path; an older literal-named command applies to no
 * project and is only said and cleared; a password without --as names the solo install's one operator. Real CLI over
 * a throwaway database. */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { declareNewInstallSolo } from "./install-mode.js";
import { EXIT, runOperate } from "./operate.js";

const NOW = new Date("2026-11-25T12:00:00.000Z");
let dir = "", db = "", project = "", store: Store, password = "";

const cli = async (...argv: string[]) => {
  const lines: string[] = [];
  const [command = "", ...rest] = argv;
  const code = await runOperate(command, [...rest, "--json"], line => lines.push(line), { databaseFile: db, now: NOW });
  return { code, envelope: JSON.parse(lines.join("\n")) as Record<string, unknown> };
};
const at = (folder: string) => vi.spyOn(process, "cwd").mockReturnValue(folder);

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-verify-repo-")));
  db = join(dir, "orders.db");
  project = join(dir, "proj");
  mkdirSync(project);
  store = openStore(db);
  const sam = addApprover(store, "sam", NOW);
  if (!sam.ok) throw new Error("sam");
  password = sam.token;
  store.upsertProject(project, "proj", NOW);
});
afterEach(() => {
  vi.restoreAllMocks();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("verify --repo resolves to the registered project", () => {
  test("`.`, a relative path from elsewhere and a symlink all read and write the project's own path", async () => {
    symlinkSync(project, join(dir, "link"));
    at(project);
    expect(await cli("verify", "set", "--repo", ".", "--command", "npm test", "--as", "sam", "--token", password, "--yes")).toMatchObject({ code: EXIT.ok, envelope: { repo: project } });
    expect(store.liveVerifyCommand(project)?.command).toBe("npm test");
    expect(store.liveVerifyCommand(".")).toBeNull();
    expect(await cli("verify", "show", "--repo", join(dir, "link"))).toMatchObject({ envelope: { repo: project, verify: { command: "npm test" } } });
    at(dir);
    expect(await cli("verify", "show", "--repo", "proj")).toMatchObject({ envelope: { repo: project, verify: { command: "npm test" } } });
  });

  test("an unregistered folder keeps its absolute path; nothing is stored under relative text", async () => {
    mkdirSync(join(dir, "other"));
    at(dir);
    expect(await cli("verify", "set", "--repo", "other", "--command", "make check", "--as", "sam", "--token", password, "--yes")).toMatchObject({ code: EXIT.ok, envelope: { repo: join(dir, "other") } });
    expect(store.liveVerifyCommand("other")).toBeNull();
  });

  test("an older command saved under `.` never moves to today's folder; clearing the project clears it too", async () => {
    store.setVerifyCommand({ repo: ".", command: "npm test", timeoutMs: 60_000, approvedBy: "sam" }, NOW);
    at(project);
    expect(await cli("verify", "show", "--repo", ".")).toMatchObject({ envelope: { repo: project, verify: null } });
    expect(await cli("verify", "clear", "--repo", ".", "--as", "sam", "--token", password)).toMatchObject({ code: EXIT.ok, envelope: { cleared: true } });
    expect(store.liveVerifyCommand(".")).toBeNull();
  });

  test("a password without --as names the solo install's one operator, and still has to be theirs", async () => {
    declareNewInstallSolo(store, "sam", NOW);
    expect((await cli("verify", "set", "--repo", project, "--command", "npm test", "--token", password, "--yes")).code).toBe(EXIT.ok);
    expect((await cli("verify", "set", "--repo", project, "--command", "npm run x", "--token", "wrong-password", "--yes")).code).toBe(EXIT.refused);
    expect(store.liveVerifyCommand(project)?.command).toBe("npm test");
  });
});
