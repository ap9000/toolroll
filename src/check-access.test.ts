/** Check access per project (v132, check-access.ts): stored narrow by default, widened only by an instance operator. */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { runOperate, EXIT } from "./operate.js";
import { checkAccessOf, narrowestAccess, widerThan } from "./check-access.js";

const REPO = "/repo/main";
let dir: string, db: string, store: Store, lines: string[];
const tokens: Record<string, string> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "so-check-access-"));
  db = join(dir, "orders.db");
  store = openStore(db);
  const now = new Date();
  const alex = addApprover(store, "alex", now);
  if (!alex.ok) throw new Error("alex");
  tokens["alex"] = alex.token;
  const sam = addApprover(store, "sam", now, { name: "alex", token: alex.token });
  if (!sam.ok) throw new Error("sam");
  tokens["sam"] = sam.token;
  // sam approves on the project but isn't an instance operator.
  expect(store.setAccountProjects("sam", [REPO], "alex", now)).toEqual({ ok: true });
  const made = store.createConsoleTask({ title: "known", repo: REPO, filedVia: "console", filedBy: { name: "alex", kind: "person" } }, now);
  if (!made.ok) throw new Error(made.reason);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const run = (argv: string[]) => { lines = []; return runOperate("project", ["check-access", ...argv], line => lines.push(line), { databaseFile: db }); };
const payload = () => JSON.parse(lines.join("\n"));
const as = (name: string) => ["--as", name, "--token", tokens[name]!];

test("levels: unknown or damaged values read as sandboxed; the narrowest of several wins", () => {
  expect(checkAccessOf("unsandboxed")).toBe("unsandboxed");
  expect(checkAccessOf("anything")).toBe("sandboxed");
  expect(checkAccessOf(null)).toBe("sandboxed");
  expect(narrowestAccess(["unsandboxed", "sign-ins"])).toBe("sign-ins");
  expect(narrowestAccess(["unsandboxed", "sandboxed", "sign-ins"])).toBe("sandboxed");
  expect(narrowestAccess([])).toBe("sandboxed");
  expect(widerThan("sign-ins", "sandboxed")).toBe(true);
  expect(widerThan("sandboxed", "unsandboxed")).toBe(false);
});

test("a project is sandboxed until changed; a damaged row never reads wider; the ledger keeps before → after", () => {
  expect(store.projectCheckAccess(REPO)).toBe("sandboxed");
  expect(store.projectCheckAccessChange(REPO)).toBeNull();
  expect(store.setProjectCheckAccess(REPO, "unsandboxed", "alex", new Date(), { may: "widen" })).toEqual({ before: "sandboxed", after: "unsandboxed" });
  expect(store.projectCheckAccessChange(REPO)?.by).toBe("alex");
  const ledger = store.handle.prepare("SELECT actor, detail FROM action_ledger WHERE action = 'check access'").all();
  expect(ledger.map(row => `${String(row["actor"])}: ${String(row["detail"])}`)).toEqual(["alex: sandboxed → unsandboxed"]);
  // The table's check refuses a wider word; a row that reads oddly anyway is the narrowest level.
  expect(() => store.handle.prepare("UPDATE project_check_access SET level = 'everything' WHERE repo = ?").run(REPO)).toThrow();
  store.handle.exec("PRAGMA ignore_check_constraints = ON");
  store.handle.prepare("UPDATE project_check_access SET level = 'everything' WHERE repo = ?").run(REPO);
  expect(store.projectCheckAccess(REPO)).toBe("sandboxed");
});

test("the CLI: shows the level; only an instance operator with a password widens; an approver narrows; others are refused", async () => {
  expect(await run(["--repo", REPO, "--json"])).toBe(EXIT.ok);
  expect(payload()).toMatchObject({ ok: true, checkAccess: "sandboxed" });

  // sam approves on the project but isn't an instance operator: may not widen.
  expect(await run(["sign-ins", "--repo", REPO, ...as("sam"), "--json"])).toBe(EXIT.refused);
  expect(payload()).toMatchObject({ ok: false, reason: "refused" });
  // A wrong password widens nothing.
  expect(await run(["unsandboxed", "--repo", REPO, "--as", "alex", "--token", "wrong", "--json"])).toBe(EXIT.refused);
  expect(store.projectCheckAccess(REPO)).toBe("sandboxed");

  expect(await run(["unsandboxed", "--repo", REPO, ...as("alex"), "--json"])).toBe(EXIT.ok);
  expect(payload()).toMatchObject({ ok: true, before: "sandboxed", checkAccess: "unsandboxed" });
  expect(store.projectCheckAccess(REPO)).toBe("unsandboxed");

  // Narrowing is any project approver's: sam may.
  expect(await run(["sandboxed", "--repo", REPO, ...as("sam"), "--json"])).toBe(EXIT.ok);
  expect(store.projectCheckAccess(REPO)).toBe("sandboxed");

  // Not a level, or not a project: usage and not-found.
  expect(await run(["everything", "--repo", REPO, ...as("alex"), "--json"])).toBe(EXIT.usage);
  expect(await run(["sandboxed", "--repo", "/nowhere", ...as("alex"), "--json"])).toBe(EXIT.refused);
  expect(payload()).toMatchObject({ reason: "not-found" });
});

test("the CLI says what a wider level means before anyone relies on it", async () => {
  store.setProjectCheckAccess(REPO, "sign-ins", "alex", new Date(), { may: "widen" });
  expect(await run(["--repo", REPO])).toBe(EXIT.ok);
  expect(lines.join("\n")).toMatch(/model and GitHub sign-ins[\s\S]*can read your Claude, Codex and GitHub sign-ins/);
});

test("the write compares again: a narrowing authority never widens, whatever changed while it was proved", () => {
  // An operator widened to unsandboxed; an approver's pending narrowing to sign-ins still narrows.
  expect(store.setProjectCheckAccess(REPO, "unsandboxed", "alex", new Date(), { may: "widen" })).toEqual({ before: "sandboxed", after: "unsandboxed" });
  expect(store.setProjectCheckAccess(REPO, "sign-ins", "sam", new Date(), { may: "narrow" })).toEqual({ before: "unsandboxed", after: "sign-ins" });
  // Meanwhile someone narrowed to sandboxed: the same narrowing authority asking for sign-ins would now widen. Refused.
  expect(store.setProjectCheckAccess(REPO, "sandboxed", "alex", new Date(), { may: "narrow" })).toEqual({ before: "sign-ins", after: "sandboxed" });
  expect(store.setProjectCheckAccess(REPO, "sign-ins", "sam", new Date(), { may: "narrow" })).toBeNull();
  expect(store.projectCheckAccess(REPO)).toBe("sandboxed");
  // The same level again is no widening.
  expect(store.setProjectCheckAccess(REPO, "sandboxed", "sam", new Date(), { may: "narrow" })).toEqual({ before: "sandboxed", after: "sandboxed" });
});

