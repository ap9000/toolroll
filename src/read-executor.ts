import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import type { Store } from './store.js';
import { WorkIndexCursorError, type WorkIndexOptions, type WorkIndexPage } from './work-index.js';
import type { WorkSummaryAccess } from './work-summary.js';

/**
 * Heavy, read-only database work for the server, run on worker threads (docs/server-performance.md).
 * Each worker owns one read-only, query-only connection to the server's own database file, so the
 * measured hot read (the work index behind `task list`) never holds the HTTP event loop. Callers
 * authorize first and send only the already-admitted access; a worker never widens it, writes, or
 * retries. Without a file-backed database (tests, the demo) nothing is attached and callers keep
 * running the same builder in-process.
 */
export type ReadJob = { kind: 'work-index-page'; now: string; access: WorkSummaryAccess; options: WorkIndexOptions };
export type ReadReply = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: { name: string; message: string } };

/** More queued reads than this fail at once instead of growing without bound. */
export const READ_QUEUE_MAX = 1_000;

type Pending = { id: number; job: ReadJob; resolve: (value: unknown) => void; reject: (error: Error) => void };
type Slot = { worker: Worker; busy: Pending | null };

export class ReadExecutorError extends Error {
  constructor(message: string) { super(message); this.name = 'ReadExecutorError'; }
}

export class ReadExecutor {
  readonly #file: string;
  readonly #size: number;
  readonly #slots: Slot[] = [];
  readonly #queue: Pending[] = [];
  #next = 1;
  #closed = false;

  constructor(file: string, size = defaultReadWorkers()) {
    this.#file = file;
    this.#size = Math.max(1, Math.floor(size));
  }

  get size(): number { return this.#size; }

  /** workIndexPage(store, now, access, options) on a worker's read-only connection: same rows, same errors. */
  async workIndexPage(now: Date, access: WorkSummaryAccess, options: WorkIndexOptions): Promise<WorkIndexPage> {
    try {
      return await this.#run({ kind: 'work-index-page', now: now.toISOString(), access, options }) as WorkIndexPage;
    } catch (error) {
      if (error instanceof Error && error.name === 'WorkIndexCursorError') throw new WorkIndexCursorError();
      throw error;
    }
  }

  #run(job: ReadJob): Promise<unknown> {
    if (this.#closed) return Promise.reject(new ReadExecutorError('The server is closing.'));
    if (this.#queue.length >= READ_QUEUE_MAX) return Promise.reject(new ReadExecutorError('The server is too busy to read this now; try again shortly.'));
    return new Promise((resolve, reject) => {
      this.#queue.push({ id: this.#next++, job, resolve, reject });
      this.#pump();
    });
  }

  #pump(): void {
    while (this.#queue.length > 0) {
      let slot = this.#slots.find(one => one.busy === null);
      if (slot === undefined && this.#slots.length < this.#size) slot = this.#spawn();
      if (slot === undefined) return;
      const pending = this.#queue.shift()!;
      slot.busy = pending;
      slot.worker.postMessage({ id: pending.id, job: pending.job });
    }
  }

  #spawn(): Slot {
    // The installed server runs the built sibling; tests run the TypeScript source through tsx.
    const worker = import.meta.url.endsWith('.ts')
      ? new Worker(`import('tsx/esm/api').then(tsx => { tsx.register(); return import(${JSON.stringify(new URL('./read-executor-worker.ts', import.meta.url).href)}); });`, { eval: true, workerData: { file: this.#file } })
      : new Worker(new URL('./read-executor-worker.js', import.meta.url), { workerData: { file: this.#file } });
    const slot: Slot = { worker, busy: null };
    this.#slots.push(slot);
    worker.on('message', (reply: ReadReply) => {
      const pending = slot.busy;
      if (pending === null || pending.id !== reply.id) return;
      slot.busy = null;
      if (reply.ok) pending.resolve(reply.value);
      else pending.reject(Object.assign(new Error(reply.error.message), { name: reply.error.name }));
      this.#pump();
    });
    // A crashed worker fails only the read it held; the next read starts a fresh one.
    const lost = (error: Error) => {
      const at = this.#slots.indexOf(slot);
      if (at < 0) return;
      this.#slots.splice(at, 1);
      const pending = slot.busy;
      slot.busy = null;
      pending?.reject(error);
      if (!this.#closed) this.#pump();
    };
    worker.on('error', error => lost(error instanceof Error ? error : new ReadExecutorError(String(error))));
    worker.on('exit', code => lost(new ReadExecutorError(`The read worker stopped (exit ${code}).`)));
    worker.unref();
    return slot;
  }

  /** Fails every queued and running read once, then stops the workers. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const stopped = new ReadExecutorError('The server is closing.');
    for (const pending of this.#queue.splice(0)) pending.reject(stopped);
    const slots = this.#slots.splice(0);
    for (const slot of slots) { slot.busy?.reject(stopped); slot.busy = null; }
    await Promise.all(slots.map(slot => slot.worker.terminate().catch(() => 0)));
  }
}

/** Half the cores, at most eight: the measured 20-engineer load needs over four (docs/server-performance.md),
 * and the rest stay with the event loop and local agents. Workers start only when reads arrive. */
export function defaultReadWorkers(): number {
  return Math.max(1, Math.min(8, Math.floor(availableParallelism() / 2)));
}

const attached = new WeakMap<Store, ReadExecutor>();
/** The server attaches its executor to its own Store; a command run on that Store reads through it. */
export function attachReadExecutor(store: Store, executor: ReadExecutor): () => void {
  attached.set(store, executor);
  return () => { if (attached.get(store) === executor) attached.delete(store); };
}
export function readExecutorOf(store: Store): ReadExecutor | null {
  return attached.get(store) ?? null;
}
