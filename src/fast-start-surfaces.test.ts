/**
 * The fast path's surfaces (plain-toolroll.md P2.4), over real HTTP and the real CLI: a small task's New task form shows
 * its exact terms and Build is the yes; a bigger one files as it always has; only a person's browser session reaches
 * Build; `task new` refuses a script, --json and a token.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { join } from "node:path";
import { installFilingSizer } from "./task-sizing.js";
import { openLocalWorld, type LocalWorld } from "../test/local-owner-world.js";
import { runOperate, EXIT } from "./operate.js";
import { fastStarted } from "./fast-start.js";
import { approvalOf } from "./scope.js";

let world: LocalWorld;
let drop: () => void;
beforeEach(async () => { world = await openLocalWorld(); drop = installFilingSizer(async () => ({ size: "small", risky: false, reason: "one word" })); });
afterEach(async () => { drop(); await world.close(); });

const fieldOf = (html: string, name: string): string => new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? "";

describe("New task", () => {
  test("a small task shows the terms; Build files and approves it, as the local owner", async () => {
    const session = await world.localSession();
    const shown = await world.post("/tasks/add", session.cookie, { csrf: session.csrf, title: "Fix the typo in the footer", repo: world.repo, "planning-policy": "choice", "plan-first": "1" });
    expect(shown.status).toBe(200);
    const page = shown.body;
    expect(page).toContain("Build approves exactly these terms.");
    expect(page).toContain("Fix the typo in the footer");
    expect(world.store.handle.prepare("SELECT COUNT(*) AS n FROM task WHERE id LIKE 'task-%'").get()?.["n"]).toBe(0);
    const built = await world.post("/tasks/fast", session.cookie, { csrf: session.csrf, preview: fieldOf(page, "preview"), digest: fieldOf(page, "digest") });
    expect(built.status).toBe(303);
    const id = decodeURIComponent(/\/t\/([^/?#]+)/.exec(String(built.headers["location"] ?? ""))?.[1] ?? "");
    expect(fastStarted(world.store, id)).toBe(true);
    expect(approvalOf(world.store.getScope(id)).approved).toBe(true);
  });

  test("Plan it first files the same words on the ordinary road", async () => {
    const session = await world.localSession();
    const filed = await world.post("/tasks/add", session.cookie, { csrf: session.csrf, plain: "1", title: "Fix the typo in the footer", repo: world.repo, "planning-policy": "choice", "plan-first": "1" });
    expect(filed.status).toBe(303);
    expect(world.store.handle.prepare("SELECT COUNT(*) AS n FROM task_ref WHERE fast_start_at IS NOT NULL").get()?.["n"]).toBe(0);
  });

  test("a bigger task files as it always has", async () => {
    const session = await world.localSession();
    const filed = await world.post("/tasks/add", session.cookie, { csrf: session.csrf, title: "Refactor the checkout", repo: world.repo, "planning-policy": "choice", "plan-first": "1" });
    expect(filed.status).toBe(303);
  });

  test("Build refuses a form it didn't render, with nothing filed", async () => {
    const session = await world.localSession();
    const before = world.store.handle.prepare("SELECT COUNT(*) AS n FROM task").get()?.["n"];
    const pressed = await world.post("/tasks/fast", session.cookie, { csrf: session.csrf, preview: "0".repeat(32), digest: "0".repeat(64) });
    expect(pressed.status).toBe(403);
    expect(world.store.handle.prepare("SELECT COUNT(*) AS n FROM task").get()?.["n"]).toBe(before);
  });
});

describe("task new", () => {
  const run = async (argv: string[]) => {
    const lines: string[] = [];
    const code = await runOperate("task", ["new", ...argv, "--db", join(world.configDir, "state.db")], line => { lines.push(line); }, {});
    return { code, out: lines.join("\n") };
  };
  test("a script, --json or a token is refused, and nothing is filed", async () => {
    const before = world.store.handle.prepare("SELECT COUNT(*) AS n FROM task").get()?.["n"];
    for (const argv of [["Fix it", "--repo", world.repo], ["Fix it", "--repo", world.repo, "--json"], ["Fix it", "--repo", world.repo, "--as", "alex", "--token", "x"]]) {
      expect((await run(argv)).code).toBe(EXIT.refused);
    }
    expect(world.store.handle.prepare("SELECT COUNT(*) AS n FROM task").get()?.["n"]).toBe(before);
  });
});
