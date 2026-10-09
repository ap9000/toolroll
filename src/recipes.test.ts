import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover, hashPassword } from "./scope.js";
import { presetTerms, modeDigestOf, modeTermsJson } from "./modes.js";
import { runScheduleNow, setFlowTriggerOn, triggerConfigOf } from "./flow-triggers.js";
import { createWorkflowPreview, exportRecipe, findRecipe, importRecipe, launchWorkflow, parseRecipe, recipeScheduleWords, saveWorkflowRecipe, savedRecipes, starterRecipes, workflowPreview, type RecipeDocument } from "./recipes.js";

describe("portable recipe parsing", () => {
  test("all starters round-trip portable work without project identity or authority", () => {
    const document = starterRecipes().find(one => one.id === "lint-sweep")!.document;
    expect(starterRecipes()).toHaveLength(6);
    for (const recipe of starterRecipes()) {
      expect(importRecipe(exportRecipe(recipe.document))).toEqual(recipe.document);
      expect(Object.keys(JSON.parse(exportRecipe(recipe.document)))).not.toContain("repo");
    }
    for (const extra of ["approvedAt", "permissionMode", "provider", "model", "token", "repo", "publicationGrant", "autoApprove"]) {
      expect(() => parseRecipe({ ...document, [extra]: true })).toThrow("Recipe fields");
    }
    expect(() => parseRecipe({ ...document, version: 3 })).toThrow("not supported");
    expect(() => importRecipe("not-json")).toThrow("not valid");
    expect(() => parseRecipe({ ...document, name: "hidden\u202Ename" })).toThrow();
    expect(() => parseRecipe({ ...document, acceptance: [] })).toThrow("success check");
    expect(() => parseRecipe({ ...document, acceptance: [{ ...document.acceptance[0], approved: true }] })).toThrow("unsupported fields");
    expect(() => parseRecipe({ ...document, acceptance: [{ ...document.acceptance[0], evidence: ["trust-me"] }] })).toThrow();
  });
});

const now = new Date("2026-09-12T22:00:00Z");
describe("reusable recipes on the existing work engine", () => {
  let root: string, repo: string, other: string, file: string, token: string, store: Store;
  let document: RecipeDocument;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "so-recipes-")));
    repo = join(root, "project"); other = join(root, "other"); mkdirSync(repo); mkdirSync(other);
    file = join(root, "state.db"); store = openStore(file);
    // Only the complete fixture is observed; avoid one disk commit per row.
    store.transact(() => {
      const added = addApprover(store, "owner", now); if (!added.ok) throw Error("no owner"); token = added.token;
      for (const phase of ["plan", "build", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "owner", now);
      const invite = store.mintInvite("approver", "owner", now, undefined, [repo]);
      store.consumeInviteAndCreateAccount({ tokenValue: invite.token, name: "member", credentialHash: hashPassword("member-password") }, now);
    });
    document = starterRecipes().find(one => one.id === "lint-sweep")!.document;
  });
  afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const preview = (actor = "owner", d = document) => createWorkflowPreview(store, actor, repo, d, "lint-sweep", now);



  test("preview and save create no work; saved scope is an immutable copy", () => {
    const p = preview(); document.goal = "An edit after preview must not change the saved copy";
    const saved = saveWorkflowRecipe(store, "owner", repo, p.token, now);
    expect(saved.document.goal).toBe(p.document.goal);
    expect(store.listTasks()).toHaveLength(0); expect(store.listFlows([repo])).toHaveLength(0);
    expect(saveWorkflowRecipe(store, "owner", repo, p.token, now)).toEqual(saved);
    expect(savedRecipes(store, "member", repo)).toEqual([saved]);
    expect(findRecipe(store, "owner", other, saved.id)).toBeNull();
    expect(() => savedRecipes(store, "member", other)).toThrow("access");
    expect(() => store.handle.prepare("UPDATE workflow_recipe SET document='{}' WHERE id=?").run(saved.id)).toThrow("immutable");
  });

  test("project path aliases share one recipe library and launch receipt", () => {
    const alias = `${repo}/../project`;
    const p = createWorkflowPreview(store, "member", alias, document, "lint-sweep", now);
    expect(p.repo).toBe(repo);
    const saved = saveWorkflowRecipe(store, "member", alias, p.token, now);
    expect(savedRecipes(store, "member", repo)).toEqual([saved]);
    expect(savedRecipes(store, "member", alias)).toEqual([saved]);
    expect(findRecipe(store, "member", alias, saved.id)).toEqual(saved);
    expect(workflowPreview(store, "member", repo, p.token)?.token).toBe(p.token);
    const result = launchWorkflow(store, "member", alias, p.token, now, false);
    expect(store.lookupRef(result.taskId!)?.repo).toBe(repo);
    expect(launchWorkflow(store, "member", repo, p.token, now, false)).toEqual(result);
  });

  test("a lost response and process restart return the same task, not another dispatch", () => {
    const p = preview();
    const first = launchWorkflow(store, "owner", repo, p.token, now, true);
    expect(store.getScope(first.taskId!)?.approvedAt).toBeNull();
    expect(store.filedViaOf(first.taskId!)).toBe("recipe:lint-sweep");
    store.close(); store = openStore(file);
    expect(launchWorkflow(store, "owner", repo, p.token, new Date(now.getTime() + 3600_000), true)).toEqual(first);
    expect(store.listTasks()).toHaveLength(1); expect(store.listFlows([repo])).toHaveLength(0);
    expect(store.getScope(first.taskId!)?.goal).toBe(p.document.goal);
    expect(store.actionLedger({ repos: [repo] }).filter(one => one.action === "workflow created")).toHaveLength(1);
  });

  test("filing, optional authority, receipt and ledger roll back together", () => {
    const p = preview();
    store.handle.exec("CREATE TRIGGER interrupt_recipe BEFORE UPDATE OF task_id ON workflow_preview BEGIN SELECT RAISE(ABORT, 'fault at receipt'); END;");
    expect(() => launchWorkflow(store, "owner", repo, p.token, now, true)).toThrow("fault at receipt");
    expect(store.listTasks()).toHaveLength(0);
    expect(workflowPreview(store, "owner", repo, p.token)?.taskId).toBeNull();
    expect(store.actionLedger({ repos: [repo] }).filter(one => one.action === "workflow created")).toHaveLength(0);
    store.handle.exec("DROP TRIGGER interrupt_recipe");
    expect(launchWorkflow(store, "owner", repo, p.token, now, true).taskId).not.toBeNull();
    expect(store.listTasks()).toHaveLength(1);
  });

  test("repetition makes a scheduled flow whose schedule starts paused; turned on, it files one task at a time", () => {
    const p = preview("owner", { ...document, schedule: "every:60", costCeilingUsd: null });
    const result = launchWorkflow(store, "owner", repo, p.token, now, true);
    expect(result.taskId).toBeNull();
    const flow = store.getFlow(result.flowId!)!;
    expect(flow).toMatchObject({ repo, name: document.name });
    expect(store.handle.prepare("SELECT task_id, routine_id, flow_id FROM workflow_preview WHERE token = ?").get(p.token)).toEqual({ task_id: null, routine_id: null, flow_id: flow.id });
    const [trigger] = store.flowTriggers(flow.id);
    expect(trigger).toMatchObject({ state: "paused", nextAt: null });
    expect(triggerConfigOf(trigger!)).toMatchObject({ schedule: "every:60", order: { approval: null, singleFlight: true, filedBy: "owner" } });
    expect(store.listTasks()).toHaveLength(0);
    // The receipt returns the same flow, whatever happens to it later.
    expect(launchWorkflow(store, "owner", repo, p.token, now, true)).toEqual(result);
    setFlowTriggerOn(store, trigger!, true, now);
    const due = new Date(now.getTime() + 3600_000);
    expect(runScheduleNow(store, store.getFlowTrigger(trigger!.id)!, "owner", due)).toMatchObject({ ok: true });
    expect(store.listTasks()).toHaveLength(1);
    expect(store.getScope(store.listTasks()[0]!.id)?.approvedAt ?? null).toBeNull();
    // One at a time: the next slot waits while that task is unfinished.
    expect(runScheduleNow(store, store.getFlowTrigger(trigger!.id)!, "owner", new Date(due.getTime() + 3600_000))).toMatchObject({ ok: false });
    expect(store.listTasks()).toHaveLength(1);
  });

  test("only the signed-in signer's new task can use its project filing policy", () => {
    const terms = { ...presetTerms("standard", new Date(now.getTime() + 3600_000).toISOString()), autoApproveFiling: true };
    store.signMode({ repo, name: terms.name, signedBy: "owner", digest: modeDigestOf(terms), termsJson: modeTermsJson(terms), publication: terms.publication, absoluteExpiry: terms.absoluteExpiry }, now);
    const owner = launchWorkflow(store, "owner", repo, preview().token, now, true);
    expect(store.getScope(owner.taskId!)?.approvedBy).toBe("owner");
    const member = launchWorkflow(store, "member", repo, preview("member").token, now, true);
    expect(store.getScope(member.taskId!)?.approvedAt).toBeNull();
    const api = launchWorkflow(store, "owner", repo, preview().token, now, false);
    expect(store.getScope(api.taskId!)?.approvedAt).toBeNull();
    const repeating = launchWorkflow(store, "owner", repo, preview("owner", { ...document, schedule: "every:60" }).token, now, true);
    expect(store.flowTriggers(repeating.flowId!)).toMatchObject([{ state: "paused" }]);
  });

  test("preview is private to its actor and project; expiry and revoked access refuse", () => {
    const p = preview("member");
    expect(workflowPreview(store, "owner", repo, p.token)).toBeNull();
    expect(() => launchWorkflow(store, "member", other, p.token, now, true)).toThrow("access");
    expect(() => launchWorkflow(store, "member", repo, p.token, new Date(now.getTime() + 1800_000), true)).toThrow("expired");
    store.setAccountProjects("member", [], "owner", now);
    expect(() => launchWorkflow(store, "member", repo, p.token, now, true)).toThrow("access");
    expect(() => saveWorkflowRecipe(store, "member", repo, p.token, now)).toThrow("access");
    expect(store.listTasks()).toHaveLength(0);
  });

  test("tampered previews and unsupported combinations never create partial work", () => {
    const p = preview();
    store.handle.prepare("UPDATE workflow_preview SET document=? WHERE token=?").run(JSON.stringify({ ...p.document, goal: "tampered" }), p.token);
    expect(() => launchWorkflow(store, "owner", repo, p.token, now, true)).toThrow("changed");
    expect(() => parseRecipe({ ...document, schedule: "every:1" })).toThrow("schedule");
    expect(() => parseRecipe({ ...document, deliverable: "report", schedule: "every:60" })).toThrow("Report recipes run once");
    expect(() => parseRecipe({ ...document, planning: "required", schedule: "every:60" })).toThrow("Plan-first");
    expect(() => parseRecipe({ ...document, schedule: "every:60", costCeilingUsd: -1 })).toThrow("positive");
    expect(recipeScheduleWords({ ...document, schedule: "weekly:1:09:00@America/Los_Angeles" }, now)).toContain("2026-09-14T16:00:00.000Z");
    expect(store.listTasks()).toHaveLength(0);
  });
});
