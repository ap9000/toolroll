/** `project flexible enable` at a person's terminal (everyday-8 #8, traced before changing it): after the terms and the
 * y, the command says what it turned on. Stranger test 12 saw nothing printed; the y road is replayed here with the
 * terminal's prompt standing in. Traced: it did print "<repo> is Flexible." — between two copies of the whole terms block,
 * so it read as nothing new. Now one line follows the terms. */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { runOperate, EXIT } from "./operate.js";
import { flexibleStanding } from "./flexible.js";

vi.mock("./flexible-available.js", async original => ({ ...await original<typeof import("./flexible-available.js")>(), flexibleAvailable: () => true }));
vi.mock("./prompt.js", async original => ({ ...await original<typeof import("./prompt.js")>(), interactive: () => true, confirm: async () => true }));

const NOW = new Date();
let dir = "", repo = "", db = "", store: Store, token = "";

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-project-flexible-cli-")));
  repo = join(dir, "shop");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  db = join(dir, "orders.db");
  store = openStore(db);
  const alex = addApprover(store, "alex", NOW);
  if (!alex.ok) throw new Error("alex");
  token = alex.token;
  const made = store.createConsoleTask({ title: "known", repo, filedVia: "console", filedBy: { name: "alex", kind: "person" } }, NOW);
  if (!made.ok) throw new Error(made.reason);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe("project flexible enable, answered y at the terminal", () => {
  test("prints the terms, then says it is on", async () => {
    const lines: string[] = [];
    const code = await runOperate("project", ["flexible", "enable", "--repo", repo, "--as", "alex", "--token", token], line => lines.push(line), { databaseFile: db });
    expect(code, lines.join("\n")).toBe(EXIT.ok);
    expect(flexibleStanding(store, repo)).toMatchObject({ state: "on" });
    const said = lines.join("\n");
    expect(said).toMatch(/Terms [0-9a-f]{32}/);
    // Said once, after the terms: what is on and where, with the terms it agreed to; the terms aren't printed twice.
    expect(lines.at(-1)).toMatch(new RegExp(`^Interactive agent threads are on in ${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(terms [0-9a-f]{32}\\)`));
    expect(said.split("Full access removes").length - 1).toBe(1);
  });
});
