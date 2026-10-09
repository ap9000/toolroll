/** Disposable fixture for the completed first-review desktop/phone journey.
 * No live database or provider is used. All fixture files stay under output/. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openStore } from '../../dist/store.js';
import { addApprover, approve, propose } from '../../dist/scope.js';
import { register } from '../../dist/runner.js';
import { storeEvidence, budgetedStatJson, parseNumstat } from '../../dist/evidence.js';
import { createDecisionServer } from '../../dist/serve.js';

export async function startFirstReviewFixture() {
  const output = resolve('output/playwright/first-review'); mkdirSync(output, { recursive: true });
  const dir = mkdtempSync(join(output, 'fixture-')), repo = join(dir, 'repo'), root = join(dir, 'evidence'); mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Synthetic fixture'); git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(repo, 'guard.js'), 'export const limit = 9;\n'); git('add', '.'); git('commit', '-qm', 'fixture base'); const base = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'guard.js'), 'export const limit = 3;\n'); git('add', '.'); git('commit', '-qm', 'fixture candidate'); const head = git('rev-parse', 'HEAD');
  const store = openStore(':memory:'), now = new Date(), name = 'fixture';
  const added = addApprover(store, name, now); assert(added.ok); const password = added.token;
  register(store, { name: 'fixture-worker', host: 'fixture', capacity: 4, repos: [repo], now, newToken: () => 'fixture-worker-token' });
  for (const phase of ['build','review','repair','plan']) store.setPhaseConfig('installation', phase, 'claude', 'sonnet', name, now);
  store.setVerifyCommand({ repo, command: 'npm test', timeoutMs: 60000, approvedBy: name }, now);
  const rubric = [{ id: 'guard', statement: 'The retry guard limits attempts to three.', evidence: ['check','changed-path'], how: null }];
  const task = 'first-review-fixture'; store.createTask({ id: task, title: 'Keep retry limits clear when a task has a very long result description and inherited evidence' }, now);
  const ref = store.refFor('built-in', task).id; store.placeTask(ref, repo);
  const scope = propose(store, { taskId: task, goal: 'Limit retries to three and keep the result readable.', acceptance: rubric, now });
  assert(approve(store, task, name, now, scope.digest, password).ok);
  const authority = store.routeAuthorityFor(ref, 'builder'); assert(authority.ok);
  const run = store.startRun({ taskRef: ref, leaseId: 'fixture-build', runner: 'fixture-worker', branch: 'fixture-candidate', worktree: repo, now, route: authority.stamp, provider: 'claude', model: 'sonnet' });
  store.stampRun(run, { scopeDigest: scope.digest, baseRevision: base }); store.recordOutcomeFacts(run, { headRevision: head, handoff: 'Limited retries to three.' });
  const evidence = (kind, file, bytes, capture) => storeEvidence(store, root, run, kind, file, Buffer.from(bytes), capture, now, { captureStatus: 'ok' });
  const diff = evidence('terminal-diff', 'diff.patch', git('diff', base, head)+'\n', 'machine diff');
  evidence('diff-stat', 'stat.json', budgetedStatJson(parseNumstat(execFileSync('git', ['diff','--numstat','-z',base,head], {cwd:repo,encoding:'utf8'}), base, head)), 'machine diff stat');
  const proof = evidence('proof', 'proof.json', JSON.stringify({ version:1, criteria:[{id:'guard',statement:rubric[0].statement,verdict:'met',how:'Fixture check passed.',evidence:[{kind:'check',ref:'npm test'},{kind:'changed-path',ref:'guard.js'}]}], checks:[{command:'npm test',exitCode:0,summary:'Synthetic passing gate'}],changed:['guard.js'],caveats:[],screenshots:[] }), 'validated proof fixture');
  const check = evidence('check-log', 'check.txt', '=== Attempt summary ===\n- Project check · attempt 1: (exit 0)\n\n=== Project check · attempt 1 ===\n$ npm test\n(exit 0)\n\n--- stdout ---\nSynthetic passing gate\n\n--- stderr ---\n', 'sh -c npm test (attempt recorded)');
  store.saveProofVerdict(run, 'verified', ['the repository\'s approved verification command passed'], now, [{id:'guard',statement:rubric[0].statement,requiredEvidence:rubric[0].evidence,state:'pass',detail:[],answered:[],review:null}]);
  store.finishRun(run, {outcome:'built',committed:true,now}); store.setTaskState(task, 'done', now);
  const ask = store.requestReview(run, name, now); assert(ask.ok);
  const admitted = store.admitReview(ask.id,{runner:'fixture-worker',token:'fixture-worker-token',provider:'claude',model:'sonnet'},now); assert(admitted.ok); store.stampProviderStart(admitted.reviewerRunId,now);
  const bind = id => ({artifactId:id,sha256:store.getArtifact(id).sha256});
  store.ingestReview({reviewerRunId:admitted.reviewerRunId,runId:run,artifactId:diff,author:'reviewer:claude',comments:[],judgements:[{id:'guard',judgement:'cannot-tell',note:'The sealed fixture does not provide an independent runtime check of this requirement.'}],bindings:{diffSha:store.getArtifact(diff).sha256,scopeDigest:scope.digest,headSha:head,proof:bind(proof),checkLog:bind(check),screenshots:[]}},now);
  const server = createDecisionServer({store,evidenceRoot:root,repo}); await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return {store,root,repo,run,task,name,password,url:'http://127.0.0.1:'+server.address().port,
    close:async()=>{await new Promise(r=>server.close(r));store.close();rmSync(dir,{recursive:true,force:true});}
  };
}
