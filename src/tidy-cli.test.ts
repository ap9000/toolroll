/**
 * The CLI twins of Put away old tasks (docs/plans/task-tidy.md): `task tidy --preview` (read-only, no credential)
 * prints the groups and the exact next command; `task tidy --apply --digest` puts away exactly that list; `task
 * archive` / `task restore` take several ids; `task list --view archived` shows who and why. A lead's token and a
 * stale digest are refused. Isolated temp databases only.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, archiveOf } from "./store.js";
import { addApprover } from "./scope.js";
import { runOperate } from "./operate.js";
import { fire, seedFlow } from "../test/tidy-fixture.js";

const NOW = new Date("2026-11-01T18:00:00.000Z");
const day = (d: number) => new Date(Date.UTC(2026, 9, d, 16));

let dir: string, db: string, token: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "toolroll-tidy-cli-"));
  db = join(dir, "orders.db");
  const store = openStore(db);
  const added = addApprover(store, "alex", day(1));
  if (!added.ok) throw new Error("bootstrap failed");
  token = added.token;
  const flow = seedFlow(store, "Site check", { kind: "schedule", schedule: "daily:09:00@UTC", title: "Is the site current?", description: null, zone: null }, day(1));
  for (const d of [28, 29, 30, 31]) fire(store, flow, { key: `slot:2026-10-${d}T16:00:00.000Z`, task: `site-oct-${d}`, title: `Is the site current? — Oct ${d}`, at: day(d) });
  store.close();
});
afterEach(() => { delete process.env["TOOLROLL_LEAD_TOKEN"]; rmSync(dir, { recursive: true, force: true }); });

async function run(argv: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const code = await runOperate("task", argv, line => lines.push(line), { databaseFile: db, now: NOW } as Parameters<typeof runOperate>[3]);
  return { code, out: lines.join("\n") };
}
const json = (out: string) => JSON.parse(out) as Record<string, unknown>;
const archivedIds = () => { const store = openStore(db); try { return ["site-oct-28", "site-oct-29", "site-oct-30", "site-oct-31"].filter(id => archiveOf(store, id) !== null); } finally { store.close(); } };
const as = ["--as", "alex", "--token"];

describe("task tidy", () => {
  test("--preview is read-only and prints the groups and the exact command to run next", async () => {
    const text = await run(["tidy", "--preview"]);
    expect(text.code).toBe(0);
    expect(text.out).toContain("Old routine runs (3)");
    expect(text.out).toContain("site-oct-28  A newer run, “Is the site current? — Oct 31”, replaces it.");
    const preview = json((await run(["tidy", "--preview", "--json"])).out);
    expect(preview).toMatchObject({ ok: true, preview: true, days: 14, count: 3 });
    expect(text.out).toContain(`To put these away, run: toolroll task tidy --apply --digest ${String(preview["digest"])}`);
    expect(archivedIds()).toEqual([]);
  });

  test("--apply puts away exactly the previewed list, leaving out --except; a stale digest is refused with the fresh one", async () => {
    const digest = String(json((await run(["tidy", "--preview", "--json"])).out)["digest"]);
    const stale = json((await run(["tidy", "--apply", "--digest", "0".repeat(32), "--json", ...as, token])).out);
    expect(stale).toMatchObject({ ok: false, reason: "changed", digest, next: `toolroll task tidy --apply --digest ${digest} --as alex` });
    expect((await run(["tidy", "--apply", "--digest", digest, "--except", "site-oct-31", "--json", ...as, token])).out).toContain('"reason": "outside"');
    const done = await run(["tidy", "--apply", "--digest", digest, "--except", "site-oct-29", "--json", ...as, token]);
    expect(done.code).toBe(0);
    expect(json(done.out)).toMatchObject({ ok: true, archived: [{ id: "site-oct-28", rule: "routine" }, { id: "site-oct-30", rule: "routine" }] });
    expect(archivedIds()).toEqual(["site-oct-28", "site-oct-30"]);
  });

  test("usage: one of --preview or --apply, and --apply needs a digest and a person", async () => {
    expect((await run(["tidy"])).code).toBe(2);
    expect((await run(["tidy", "--preview", "--apply"])).code).toBe(2);
    expect((await run(["tidy", "--apply"])).code).toBe(2);
    expect((await run(["tidy", "--preview", "--days", "0"])).code).toBe(2);
    expect((await run(["tidy", "--apply", "--digest", "x", "--json"])).code).toBe(2);
  });
});

describe("one scope for the preview and the apply", () => {
  test("--preview --as <you> reads your projects, and its digest is the one your apply checks", async () => {
    const store = openStore(db);
    const other = seedFlow(store, "Other check", { kind: "schedule", schedule: "daily:09:00@UTC", title: "Other", description: null, zone: null }, day(1), "/repo/other");
    for (const d of [29, 30]) fire(store, other, { key: `slot:2026-10-${d}T16:00:00.000Z`, task: `other-oct-${d}`, at: day(d), repo: "/repo/other" });
    const sam = addApprover(store, "sam", day(1), { name: "alex", token });
    if (!sam.ok) throw new Error("sam");
    expect(store.setAccountProjects("sam", ["/repo/shop"], "alex", day(1))).toMatchObject({ ok: true });
    store.close();
    const everyone = json((await run(["tidy", "--preview", "--json"])).out);
    const mine = json((await run(["tidy", "--preview", "--as", "sam", "--json"])).out);
    expect(everyone["count"]).toBe(4);
    expect(mine).toMatchObject({ count: 3, next: `toolroll task tidy --apply --digest ${String(mine["digest"])} --as sam` });
    expect(json((await run(["tidy", "--apply", "--digest", String(everyone["digest"]), "--json", "--as", "sam", "--token", sam.token])).out)).toMatchObject({ ok: false, reason: "changed" });
    expect(json((await run(["tidy", "--apply", "--digest", String(mine["digest"]), "--json", "--as", "sam", "--token", sam.token])).out)).toMatchObject({ ok: true });
    expect(archivedIds()).toEqual(["site-oct-28", "site-oct-29", "site-oct-30"]);
  });
});

describe("task archive and task restore", () => {
  test("take several ids, record the reason, and show up under --view archived", async () => {
    const done = await run(["archive", "site-oct-28", "site-oct-29", "--reason", "Old checks", ...as, token]);
    expect(done.code).toBe(0);
    expect(done.out).toContain("Put away site-oct-28.");
    expect(done.out).toContain("Restore with `toolroll task restore site-oct-28 site-oct-29`.");
    const listed = await run(["list", "--view", "archived"]);
    expect(listed.out).toContain("Archived");
    expect(listed.out).toContain("by alex: Old checks");
    const page = json((await run(["list", "--view", "archived", "--json"])).out) as { tasks: { id: string }[]; totals: Record<string, number> };
    expect(page.tasks.map(one => one.id).sort()).toEqual(["site-oct-28", "site-oct-29"]);
    expect(page.totals).toMatchObject({ archived: 2 });
    const back = await run(["restore", "site-oct-28", "site-oct-29", "--json", ...as, token]);
    expect(json(back.out)).toMatchObject({ ok: true, restored: ["site-oct-28", "site-oct-29"] });
    expect(archivedIds()).toEqual([]);
  });

  test("answer per id: an unknown task is refused while the rest go", async () => {
    const done = await run(["archive", "site-oct-28", "no-such-task", "--json", ...as, token]);
    expect(done.code).toBe(3);
    expect(json(done.out)).toMatchObject({ ok: false, reason: "unknown-task", archived: [{ id: "site-oct-28" }] });
  });

  test("a lead's token puts nothing away and restores nothing, by flag or by environment", async () => {
    const store = openStore(db);
    const lead = store.mintLeadCredential("alex", "alex", NOW).token;
    store.close();
    for (const argv of [["archive", "site-oct-28"], ["restore", "site-oct-28"], ["tidy", "--apply", "--digest", "x".repeat(32)]]) {
      expect(json((await run([...argv, "--json", "--token", lead])).out)).toMatchObject({ ok: false, reason: "person-only" });
      process.env["TOOLROLL_LEAD_TOKEN"] = lead;
      expect(json((await run([...argv, "--json", ...as, token])).out)).toMatchObject({ ok: false, reason: "person-only" });
      delete process.env["TOOLROLL_LEAD_TOKEN"];
    }
    expect((await run(["tidy", "--preview"])).code).toBe(0);
    expect(archivedIds()).toEqual([]);
  });

  test("a wrong password puts nothing away", async () => {
    const done = await run(["archive", "site-oct-28", "--json", ...as, "not-it"]);
    expect(done.code).toBe(3);
    expect(archivedIds()).toEqual([]);
  });
});
