/** The lead, chat and memory with the code map (docs/plans/code-map.md §4-5). */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { seedMap } from "../test/code-map-seed.js";
import { readRefresh } from "./code-map-store.js";
import { LEAD_TOOLS } from "./lead-tools.js";
import { searchMemory } from "./project-memory.js";
import { verifyApproverByPassword } from "./principal.js";
import { addApprover } from "./scope.js";
import { openStore, type Store } from "./store.js";

const NOW = new Date("2026-11-06T12:00:00.000Z");
let root: string, repo: string, store: Store, who: Extract<ReturnType<typeof verifyApproverByPassword>, { ok: true }>["who"];
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "so-map-lead-")));
  repo = join(root, "repo"); mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  store = openStore(join(root, "orders.db"));
  const alex = addApprover(store, "alex", NOW); if (!alex.ok) throw new Error("fixture");
  store.upsertProject(repo, "repo", NOW, { remoteUrl: "https://git.example/repo.git" });
  const proved = verifyApproverByPassword(store, "alex", alex.token, [repo]); if (!proved.ok) throw new Error(proved.reason);
  who = proved.who;
  seedMap(store, repo, { "src/a/quokkaHandler.ts": { names: ["quokkaHandler"] } }, NOW);
});
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

const tool = (name: string, args: Record<string, unknown>) => LEAD_TOOLS.find(one => one.name === name)!.handle({ store, now: NOW, who, draft: () => null, step: 0, readDecisions: new Map() }, args as never);

describe("get_code_map", () => {
  test("a labelled answer, and paging by version", () => {
    const answer = tool("get_code_map", { repo: "r1", view: "overview" });
    expect(answer).toMatchObject({ ok: true, body: { v: 1, ok: true, view: "overview", label: expect.stringContaining("untrusted data") } });
  });
  test("the off state is enforced: no map at all", () => {
    store.handle.prepare("UPDATE project SET code_map = 0").run();
    expect(tool("get_code_map", { repo: "r1", view: "overview" })).toEqual({ ok: true, body: { v: 1, ok: false, state: "off", message: "the code map is off for this project" } });
  });
  test("a project outside the lead's access is refused", () => {
    expect(tool("get_code_map", { repo: "r2", view: "overview" }).ok).toBe(false);
  });
});

test("refresh is a lead action: queued, and once per 10 minutes", () => {
  expect(tool("refresh_code_map", { repo: "r1" })).toMatchObject({ ok: true, body: { request: "queued" } });
  expect(readRefresh(store, repo)!.requestedBy).toBe("alex");
  expect(tool("refresh_code_map", { repo: "r1" })).toMatchObject({ ok: true, body: { request: "already-queued" } });
});

test("memory search never indexes the map", () => {
  expect(searchMemory(store, { actor: "alex", repos: [repo], query: "quokkaHandler" })).toEqual([]);
});
