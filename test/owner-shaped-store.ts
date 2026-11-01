/**
 * A synthetic database shaped like a busy owner's (the console responsiveness budgets, src/console-chrome.test.ts):
 * ~760 tasks in ~600 families (revisions chained to their roots) across four projects, ~1,300 finished runs with
 * their checks and settled process custody, ~700 approved scopes, and ~10,000 ledger rows in the owner's mix (run and task lifecycle, checks,
 * requests, sign-ins, each project's release-approval setting). Raw rows in one transaction: no provider, no files.
 */
import { createHash } from "node:crypto";
import type { Store } from "../src/store.js";

export const OWNER_SHAPE = { tasks: 760, families: 600, runs: 1300, ledger: 10_000, repos: ["/owner/app", "/owner/release", "/owner/site", "/owner/tools"] } as const;

export function seedOwnerShapedStore(store: Store, now: Date): { taskIds: string[]; repos: readonly string[] } {
  const db = store.handle;
  const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  const taskIds: string[] = [];
  store.transact(() => {
    const project = db.prepare("INSERT INTO project(path,name,added_at,last_opened_at) VALUES(?,?,?,?)");
    for (const repo of OWNER_SHAPE.repos) project.run(repo, repo.split("/").pop()!, at(100_000), at(10));
    const task = db.prepare("INSERT INTO task(id,title,state,created_at,updated_at) VALUES(?,?,?,?,?)");
    const ref = db.prepare("INSERT INTO task_ref(backend,external_id,repo,revision_of,filed_via) VALUES('built-in',?,?,?,'console')");
    const scope = db.prepare(`INSERT INTO task_scope(task_id,goal,proposed_at,digest,approved_at,approved_by,approved_digest)
      VALUES(?,?,?,?,?,?,?)`);
    const run = db.prepare(`INSERT INTO run(task_ref,lease_id,runner,role,provider,base_revision,branch,worktree,model,outcome,reason,started_at,finished_at,provider_started_at,head_revision)
      VALUES(?,?,'worker','builder','claude',?,?,'/owner/checkouts/removed','sonnet',?,?,?,?,?,?)`);
    const check = db.prepare("INSERT INTO run_check(run,status) VALUES(?,?)");
    // Each finished attempt's processes were seen gone (custody settled), as the owner's are.
    const settled = db.prepare(`INSERT INTO run_process_summary(run,witnesses,process_groups,first_observed_at,last_observed_at,last_exited_at,settled_at)
      VALUES(?,3,1,?,?,?,?)`);
    const ledger = db.prepare("INSERT INTO action_ledger(at,actor,repo,task_id,run_id,action,outcome,source) VALUES(?,?,?,?,?,?,?,?)");
    let rows = 0;
    const record = (when: string, actor: string, repo: string | null, taskId: string | null, runId: number | null, action: string, outcome: string, source = "work") => {
      ledger.run(when, actor, repo, taskId, runId, action, outcome, source); rows++;
    };
    // Each project's release-approval setting, as the owner's projects carry it.
    for (const repo of OWNER_SHAPE.repos) record(at(50_000), "alex", repo, null, null, "release approval changed", "ask");
    const roots: { id: string; repo: string }[] = [];
    // The roots a later task revises (below): their families' results are the revisions'.
    const revised = new Set(Array.from({ length: OWNER_SHAPE.tasks - OWNER_SHAPE.families }, (_, k) => ((OWNER_SHAPE.families + k) * 7) % OWNER_SHAPE.families));
    let runs = 0;
    for (let i = 0; i < OWNER_SHAPE.tasks; i++) {
      const id = `owner-${String(i).padStart(4, "0")}`;
      const minutes = (OWNER_SHAPE.tasks - i) * 90;
      // The first 600 are family roots; the rest revise an earlier root in the same project.
      const root = i < OWNER_SHAPE.families ? null : roots[(i * 7) % roots.length]!;
      const repo = root?.repo ?? OWNER_SHAPE.repos[i % OWNER_SHAPE.repos.length]!;
      const state = i % 17 === 0 ? "cancelled" : i >= OWNER_SHAPE.tasks - 44 ? "queued" : i % 97 === 0 ? "failed" : "done";
      task.run(id, `Owner-shaped task ${i}: keep the saved result and its checks`, state, at(minutes), at(minutes - 30));
      const refId = Number(ref.run(id, repo, root?.id ?? null).lastInsertRowid);
      if (root === null) roots.push({ id, repo });
      taskIds.push(id);
      record(at(minutes), "alex", repo, id, null, "task placed", "ok");
      record(at(minutes), "alex", repo, id, null, "task registered", "ok");
      record(at(minutes), "alex", repo, id, null, "task filed", "ok");
      if (i % 12 !== 0) {
        const terms = digest(`scope ${id}`);
        scope.run(id, "Keep the saved result and its checks.", at(minutes - 1), terms, at(minutes - 2), "alex", terms);
        record(at(minutes - 2), "alex", repo, id, null, "scope approved", "approved");
      }
      // ~1,300 finished attempts: most tasks one, every third a second.
      const attempts = state === "queued" ? 0 : i % 3 === 0 ? 2 : 1;
      let built: number | null = null;
      for (let a = 0; a < attempts && runs < OWNER_SHAPE.runs; a++) {
        const started = at(minutes - 5 - a * 20), finished = at(minutes - 15 - a * 20);
        const outcome = a === attempts - 1 && state === "done" ? "built" : "failed";
        const runId = Number(run.run(refId, `${id}-${a}`, digest(`base ${i}`).slice(0, 40), `toolroll/${id}`, outcome, outcome === "built" ? null : "check failed",
          started, finished, started, digest(`head ${i} ${a}`).slice(0, 40)).lastInsertRowid);
        runs++;
        if (outcome === "built") built = runId;
        check.run(runId, outcome === "built" ? "passed" : "failed");
        settled.run(runId, started, finished, finished, finished);
        record(started, "worker", repo, id, runId, "run started", "ok");
        record(finished, "worker", repo, id, runId, "run finished", outcome);
        record(finished, "worker", repo, id, runId, "checks used", i % 5 === 0 ? "full" : "quick");
        if (i % 4 === 0) {
          record(finished, "alex", repo, id, runId, "checks requested", `${runId}:full`);
          record(finished, "worker", repo, id, runId, "checks finished", `${runId}:passed`);
        }
        record(finished, "worker", repo, id, runId, "checkout removed", "ok");
      }
      if (state === "done") record(at(minutes - 40), "alex", repo, id, null, "task completed", "ok");
      // Most finished families were checked and completed by a person (the owner's ~420): the Tasks list reads them
      // complete, not waiting on anyone.
      if (state === "done" && root === null && built !== null && !revised.has(i))
        record(at(minutes - 45), "operator:alex", repo, id, built, "assignment handoff checked", digest(`receipt ${id}`));
    }
    // The rest of the owner's mix: requests, sign-ins and lead notes, up to the ledger's size.
    for (let n = 0; rows < OWNER_SHAPE.ledger; n++) {
      const id = taskIds[n % taskIds.length]!, repo = OWNER_SHAPE.repos[n % OWNER_SHAPE.repos.length]!;
      if (n % 5 === 0) record(at(n), "alex", null, null, null, "signed in", "ok", "sign-in");
      else if (n % 5 === 1) record(at(n), "alex", repo, id, null, "console request", "accepted", "request");
      else record(at(n), "alex", repo, id, null, n % 2 === 0 ? "assignment status observed" : "lead revise", "ok");
    }
  });
  return { taskIds, repos: OWNER_SHAPE.repos };
}
