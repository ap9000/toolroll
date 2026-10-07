/** Private benchmark child. The parent-created nonce and scratch-root check guard every database open. */
import { readFileSync, realpathSync, mkdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { openStore } from '../../dist/store.js';
import { createDecisionServer } from '../../dist/serve.js';
import { mintApiToken } from '../../dist/api-tokens.js';
import { TeamLeads } from '../../dist/team-leads.js';

const [directory, nonce, engineersText, agentsText, tasksText] = process.argv.slice(2);
const scratch = realpathSync(directory), evidence = realpathSync(fileURLToPath(new URL('../../evidence', import.meta.url)));
if (!process.send || dirname(scratch) !== evidence || !basename(scratch).startsWith('.bench-team-') || JSON.parse(readFileSync(join(scratch, 'bench-owner.json'), 'utf8')).nonce !== nonce) throw Error('Only a benchmark-owned scratch directory is allowed.');
const engineers = Number(engineersText), agents = Number(agentsText), tasks = Math.max(agents, Number(tasksText));
let store = openStore(join(scratch, 'orders.db'));
const now = new Date(), stamp = now.toISOString(), project = join(scratch, 'project'); mkdirSync(project);
const tokens = [];
for (let i = 0; i < engineers; i++) {
  const account = `synthetic-engineer-${i}`;
  store.saveApprover(account, 'synthetic-unusable-password', now);
  const token = mintApiToken();
  store.createApiToken({ id: token.id, account, name: 'synthetic-load-client', secretHash: token.hash, access: 'read', expiresAt: new Date(Date.now() + 3600_000).toISOString(), by: account }, now);
  tokens.push(token.token);
}
const runs = [];
store.transact(() => {
  store.handle.prepare('INSERT INTO project(path,name,added_at,last_opened_at) VALUES(?,?,?,?)').run(project, 'Synthetic team project', stamp, stamp);
  const task = store.handle.prepare('INSERT INTO task(id,title,state,created_at,updated_at) VALUES(?,?,?,?,?)');
  const ref = store.handle.prepare("INSERT INTO task_ref(backend,external_id,repo) VALUES('built-in',?,?)");
  const run = store.handle.prepare("INSERT INTO run(task_ref,lease_id,runner,started_at,phase,branch,worktree) VALUES(?,?,'synthetic-agent',?,'build','synthetic',?)");
  for (let i = 0; i < tasks; i++) {
    const id = `synthetic-task-${i}`;
    task.run(id, 'Synthetic benchmark: preserve saved results and report progress', i < agents ? 'running' : 'queued', stamp, stamp);
    const taskRef = ref.run(id, project).lastInsertRowid;
    if (i < agents) runs.push(Number(run.run(taskRef, `synthetic-lease-${i}`, stamp, project).lastInsertRowid));
  }
});
const team = new TeamLeads(store, () => [project]), actor = { name: 'synthetic-engineer-0', generation: 1 };
const command = (operation, args) => {
  const result = team.execute(actor, { operation, args }, now);
  if (!result.ok) throw Error(`Synthetic team setup failed: ${result.message}`);
  return result.result;
};
const lead = command('create-lead', { name: 'Synthetic team lead', projects: [project] }).leadId;
const conversation = command('create-conversation', { leadId: lead, title: 'Synthetic shared work', visibility: 'team', projects: [project] }).conversationId;
for (let i = 1; i < engineers; i++) command('member', { conversationId: conversation, account: `synthetic-engineer-${i}`, role: 'contributor', active: true, expectedRevision: i, joinLead: true, expectedLeadRevision: i });
store.transact(() => {
  const owner = store.handle.prepare('INSERT INTO team_task_owner(task_ref,lead,conversation,changed_by,changed_at) VALUES(?,?,?,?,?)');
  for (const ref of store.handle.prepare('SELECT id FROM task_ref').all()) owner.run(ref.id, lead, conversation, actor.name, stamp);
});
// Reopen to keep seed timings out of the running server's measurements.
store.close(); store = openStore(join(scratch, 'orders.db'));
const server = createDecisionServer({ store, evidenceRoot: scratch, configDir: scratch, registryPath: join(scratch, 'repos.json'), repo: project, toolHome: scratch, connectionHome: scratch, chatEnv: {}, leadByDefault: false });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const workers = new Set(); let closing = false;
const stop = async () => {
  if (closing) return; closing = true;
  await Promise.all([...workers].map(worker => worker.terminate()));
  await new Promise(resolve => server.close(resolve)); store.close(); if (process.connected) process.disconnect();
};
process.on('disconnect', () => { if (!closing) void stop(); });
process.on('SIGTERM', () => { void stop(); });
process.on('message', message => {
  if (message.kind === 'stop') { void stop(); return; }
  if (message.kind !== 'load' || workers.size) return;
  const count = Math.min(4, agents), ready = [], finished = [];
  for (let index = 0; index < count; index++) {
    const worker = new Worker(new URL('./bench-team-writer.mjs', import.meta.url), { workerData: { scratch, nonce, runs: runs.filter((_, i) => i % count === index), rate: message.rate, seconds: message.seconds } });
    workers.add(worker);
    ready.push(new Promise((resolve, reject) => { worker.once('error', reject); worker.once('message', resolve); }));
    finished.push(new Promise((resolve, reject) => { worker.on('message', data => { if (data.kind === 'done') resolve(data); }); worker.once('error', reject); worker.once('exit', code => { if (code !== 0) reject(Error(`writer exited ${code}`)); workers.delete(worker); }); }));
  }
  void (async () => {
    await Promise.all(ready); process.send({ kind: 'writers-ready' });
    for (const worker of workers) worker.postMessage('start');
    const results = await Promise.all(finished);
    const distribution = values => { values.sort((a, b) => a - b); const at = q => values.length ? values[Math.max(0, Math.ceil(q * values.length) - 1)] : null; return { count: values.length, p50Ms: at(.5), p99Ms: at(.99), maxMs: at(1) }; };
    process.send({ kind: 'writers-done', connections: count, written: results.reduce((n, r) => n + r.written, 0), failed: results.reduce((n, r) => n + r.failed, 0), missed: results.reduce((n, r) => n + r.missed, 0), wait: distribution(results.flatMap(r => r.wait)), hold: distribution(results.flatMap(r => r.hold)) });
  })().catch(error => { console.error(error); void stop(); });
});
process.send({ kind: 'ready', url: `http://127.0.0.1:${server.address().port}`, tokens, conversation });
