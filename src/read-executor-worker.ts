import { parentPort, workerData } from 'node:worker_threads';
import { openStoreReadOnly, type Store } from './store.js';
import { workCountsByProject, workIndexPage } from './work-index.js';
import { projectSummaryOf } from './console-chrome.js';
import type { ReadJob, ReadReply } from './read-executor.js';

/** One read-only, query-only connection per worker (read-executor.ts). Jobs arrive one at a time. */
let store: Store | null = null;
function connection(): Store {
  if (store !== null) return store;
  const opened = openStoreReadOnly(String((workerData as { file: string }).file));
  if (opened === null) throw new Error('The read worker could not open the database read-only at the current schema.');
  opened.handle.exec('PRAGMA query_only=1');
  return store = opened;
}

parentPort!.on('message', ({ id, job }: { id: number; job: ReadJob }) => {
  let reply: ReadReply;
  try {
    const now = new Date(job.now);
    const value = job.kind === 'work-index-page' ? workIndexPage(connection(), now, job.access, job.options)
      : job.kind === 'work-counts' ? workCountsByProject(connection(), now, job.access)
      : job.kind === 'project-summary' ? projectSummaryOf(connection(), now, job.access, job.actor, job.projects, job.evidenceRoot ?? undefined)
      : (() => { throw new Error('Unknown read.'); })();
    reply = { id, ok: true, value };
  } catch (error) {
    reply = { id, ok: false, error: { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) } };
  }
  parentPort!.postMessage(reply);
});
