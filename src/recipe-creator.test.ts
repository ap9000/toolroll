import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, openStoreNoMigrate, SCHEMA_VERSION, type Store } from "./store.js";
import { addApprover, hashPassword } from "./scope.js";
import { createWorkflowPreview, exportRecipe, findRecipe, importRecipe, launchWorkflow, parseRecipe, prepareRecipeRun, recipeDigest, resolveRecipe, savedRecipes, saveWorkflowRecipe, starterRecipes, type RecipeDocument } from "./recipes.js";
import { writeStoreSeed } from "../test/store-seed.js";
import { htmlString } from "./html.js";
import { recipeEditorHtml } from "./recipe-ui.js";
import { withFormToken } from "./server/request-context.js";

const now = new Date("2026-09-12T23:00:00Z");
const definition = (): RecipeDocument & { version: 2 } => ({
  ...starterRecipes().find(one => one.id === "lint-sweep")!.document,
  version: 2, name: "Test {{module}}", description: "A regression check for {{module}}.",
  goal: "Add regression tests for {{module}} covering {{scenario}}. Explain every change.",
  outOfScope: "No unrelated refactoring, dependency changes, or production changes to {{module}}.",
  touches: ["src/", "tests/"], planning: "skip",
  acceptance: [{ id: "c1", statement: "Tests cover {{scenario}} for {{module}} and pass.", how: "npm test", evidence: ["check", "changed-path"] }],
  inputs: [{ key: "module", label: "Which module?", defaultValue: null }, { key: "scenario", label: "Which scenario?", defaultValue: "invalid inputs" }],
});

test("the recipe editor explains that repeating work files the same scope each time", () => {
  const editor = withFormToken("recipe-editor-test", () => recipeEditorHtml(starterRecipes()[0]!, "/projects/sample", 1));
  expect(htmlString(editor)).toContain("Report work investigates directly. Repeating work files the same scope each time; plan-first workflows run once.");
});

test("question recipes round-trip strictly; inputs never become grants, paths, or commands", () => {
  const d = definition(); expect(importRecipe(exportRecipe(d))).toEqual(d);
  for (const changes of [
    { inputs: [] }, { inputs: [...d.inputs, d.inputs[0]] },
    { inputs: [{ key: "__proto__", label: "Broken", defaultValue: null }] },
    { inputs: [{ ...d.inputs[0], credential: "secret" }] },
    { inputs: [{ ...d.inputs[0], defaultValue: "hidden\u202Etext" }, d.inputs[1]] },
    { goal: "Unknown {{another}}" }, { goal: "Broken {{module" },
    { inputs: [...d.inputs, { key: "unused", label: "Not used", defaultValue: null }] },
    { touches: ["src/{{module}}/"] },
    { acceptance: [{ ...d.acceptance[0], how: "npm test -- {{scenario}}" }] },
    { autoApprove: true },
  ]) expect(() => parseRecipe({ ...d, ...changes })).toThrow();
  expect(() => parseRecipe({ ...d, version: 1 })).toThrow("Recipe fields");
});

test("answers expand once as literal text, with defaults and final scope limits enforced", () => {
  const d = definition();
  const work = resolveRecipe(d, new Map([["module", "parser $& <input>"]]));
  expect(work.version).toBe(1); expect(work).not.toHaveProperty("inputs");
  expect(work.name).toBe("Test parser $& <input>");
  expect(work.goal).toContain("invalid inputs"); expect(work.acceptance[0]?.statement).toContain("parser $& <input>");
  expect(work.touches).toEqual(d.touches); expect(work.acceptance[0]?.how).toBe("npm test");
  for (const answers of [new Map(), new Map([["module", ""]]), new Map([["module", "parser"], ["scenario", ""]]), new Map([["module", "{{scenario}}"]]), new Map([["module", "x".repeat(501)]]), new Map([["module", "parser"], ["agent", "anything"]])]) {
    expect(() => resolveRecipe(d, answers)).toThrow();
  }
  expect(() => resolveRecipe(d, new Map([["module", "x".repeat(201)]]))).toThrow();
  const v1 = starterRecipes()[0]!.document;
  expect(resolveRecipe(v1, new Map())).toEqual(v1);
  expect(() => resolveRecipe(v1, new Map([["module", "unused"]]))).toThrow();
});

describe("saved recipe creation and repeated use", () => {
  let root: string, repo: string, other: string, file: string, store: Store;
  let templateRoot: string | undefined;
  let templateFile: string;
  beforeAll(async () => {
    templateRoot = mkdtempSync(join(tmpdir(), "so-creator-template-"));
    templateFile = join(templateRoot, "orders.db");
    await writeStoreSeed(templateFile);
  });
  afterAll(() => { if (templateRoot !== undefined) rmSync(templateRoot, { recursive: true, force: true }); });
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "so-creator-"))); repo = join(root, "project"); other = join(root, "other"); mkdirSync(repo); mkdirSync(other); file = join(root, "state.db");
    copyFileSync(templateFile, file);
    store = openStore(file);
    // Only the complete fixture is observed; avoid one disk commit per row.
    store.transact(() => {
      addApprover(store, "owner", now);
      for (const [name, role] of [["member", "approver"], ["viewer", "viewer"]] as const) {
        const invite = store.mintInvite(role, "owner", now, undefined, [repo]);
        store.consumeInviteAndCreateAccount({ tokenValue: invite.token, name, credentialHash: hashPassword("fixture-password") }, now);
      }
    });
  });
  afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  function save(d = definition() as RecipeDocument, actor = "owner", project = repo) {
    const preview = createWorkflowPreview(store, actor, project, d, "custom", now);
    return { preview, recipe: saveWorkflowRecipe(store, actor, project, preview.token, now) };
  }

  test("saving starts no work; unanswered definitions refuse launch and concrete uses remain independent across restarts", () => {
    const { preview, recipe } = save();
    expect(saveWorkflowRecipe(store, "owner", repo, preview.token, now)).toEqual(recipe);
    expect(() => launchWorkflow(store, "owner", repo, preview.token, now, true)).toThrow("Answer the recipe questions");
    expect(store.listTasks()).toHaveLength(0);
    const p = prepareRecipeRun(store, "member", repo, recipe.id, 1, new Map([["module", "parser"]]), now);
    const first = launchWorkflow(store, "member", repo, p.token, now, false);
    store.close(); store = openStore(file);
    expect(launchWorkflow(store, "member", repo, p.token, new Date(now.getTime() + 3600_000), false)).toEqual(first);
    const second = prepareRecipeRun(store, "member", repo, recipe.id, 1, new Map([["module", "scheduler"], ["scenario", "clock drift"]]), now);
    const next = launchWorkflow(store, "member", repo, second.token, now, false);
    expect(next.taskId).not.toBe(first.taskId);
    expect(store.getScope(first.taskId!)?.goal).toContain("parser covering invalid inputs");
    expect(store.getScope(next.taskId!)?.goal).toContain("scheduler covering clock drift");
    expect(store.filedViaOf(next.taskId!)).toBe(`recipe:${recipe.id}`);
    expect(findRecipe(store, "member", repo, recipe.id)?.document).toEqual(recipe.document);
    expect(store.getScope(next.taskId!)?.approvedAt).toBeNull();
    expect(store.listTasks()).toHaveLength(2);
  });

  test("current project and role apply to use, including aliases, foreign IDs and revoked access", () => {
    const { recipe } = save();
    const answers = new Map([["module", "parser"]]);
    expect(() => prepareRecipeRun(store, "viewer", repo, recipe.id, 1, answers, now)).toThrow("access");
    expect(() => prepareRecipeRun(store, "member", other, recipe.id, 1, answers, now)).toThrow("access");
    expect(() => prepareRecipeRun(store, "member", repo, recipe.id, 2, answers, now)).toThrow("not available");
    expect(prepareRecipeRun(store, "member", `${repo}/../project`, recipe.id, 1, answers, now).repo).toBe(repo);
    store.setAccountProjects("member", [], "owner", now);
    expect(() => prepareRecipeRun(store, "member", repo, recipe.id, 1, answers, now)).toThrow("access");
    expect(store.listTasks()).toHaveLength(0);
  });

  test("recently used recipes rise above newer unused copies and fixed recipes keep the short launch path", () => {
    const first = save(starterRecipes()[0]!.document).recipe;
    const later = new Date(now.getTime() + 60_000);
    const preview = createWorkflowPreview(store, "owner", repo, definition(), "custom", later);
    const newer = saveWorkflowRecipe(store, "owner", repo, preview.token, later);
    expect(savedRecipes(store, "owner", repo).map(one => one.id)).toEqual([newer.id, first.id]);
    const run = prepareRecipeRun(store, "owner", repo, first.id, 1, new Map(), later);
    launchWorkflow(store, "owner", repo, run.token, later, false);
    expect(savedRecipes(store, "owner", repo).map(one => one.id)).toEqual([first.id, newer.id]);
  });

  test("v56 upgrade preserves the old definition digest and receipt, and fences old recipe readers", () => {
    const d = starterRecipes()[0]!.document;
    const canonical = JSON.stringify(d), digest = createHash("sha256").update(canonical).digest("hex");
    const { recipe } = save(d);
    const p = prepareRecipeRun(store, "owner", repo, recipe.id, 1, new Map(), now);
    const made = launchWorkflow(store, "owner", repo, p.token, now, false);
    const rows = ["workflow_recipe", "workflow_preview"].map(table => store.handle.prepare(`SELECT * FROM ${table}`).all());
    store.close(); const old = new DatabaseSync(file); old.exec("DROP TABLE service_cursor; DROP INDEX workflow_preview_source; UPDATE schema_version SET version=56"); old.close();
    expect(openStoreNoMigrate(file)).toMatchObject({ ok: false, reason: "version" });
    store = openStore(file);
    expect(SCHEMA_VERSION).toBe(117);
    expect(["workflow_recipe", "workflow_preview"].map(table => store.handle.prepare(`SELECT * FROM ${table}`).all())).toEqual(rows);
    expect(recipeDigest(findRecipe(store, "owner", repo, recipe.id)!.document)).toBe(digest);
    expect(exportRecipe(findRecipe(store, "owner", repo, recipe.id)!.document)).toBe(exportRecipe(d));
    expect(launchWorkflow(store, "owner", repo, p.token, now, false)).toEqual(made);
    expect(store.handle.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
    expect(store.handle.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
