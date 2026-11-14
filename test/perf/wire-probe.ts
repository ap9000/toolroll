/**
 * Counters for the wire budgets (wire.wire.test.ts), test-only: no product code knows they exist.
 *
 * - SQL statements: every execution of a node:sqlite statement (run, get, all, iterate) and every exec, counted on the
 *   prototypes, so every connection the server opens is seen.
 * - Projection calls: calls across module boundaries to the work index, assignment and crew projections (the module
 *   mocks in the test wrap them); a call inside one of those modules to its own function is not seen.
 * Both are charged to the tally of the request (or the write) whose async context ran them, never to background work
 * that started elsewhere: each server request runs inside its own tally (tallyRequests).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

export type Tally = { statements: number; projections: Record<string, number> };
export const newTally = (): Tally => ({ statements: 0, projections: {} });
export const projectionTotal = (tally: Tally): number => Object.values(tally.projections).reduce((sum, n) => sum + n, 0);

const context = new AsyncLocalStorage<Tally>();
/** The server's own periodic work and post-answer bookkeeping run here, never in a measured tally. */
export const background = newTally();
export const withTally = <T>(tally: Tally, run: () => T): T => context.run(tally, run);

let installed = false;
/** Count every statement execution from here on (idempotent). */
export function installSqlCounter(): void {
  if (installed) return;
  installed = true;
  const sqlite = createRequire(import.meta.url)("node:sqlite") as { StatementSync: { prototype: Record<string, unknown> }; DatabaseSync: { prototype: Record<string, unknown> } };
  const wrap = (proto: Record<string, unknown>, name: string) => {
    const original = proto[name] as (...args: unknown[]) => unknown;
    proto[name] = function (this: unknown, ...args: unknown[]) {
      const tally = context.getStore();
      if (tally !== undefined) tally.statements++;
      return original.apply(this, args);
    };
  };
  for (const name of ["run", "get", "all", "iterate"]) wrap(sqlite.StatementSync.prototype, name);
  wrap(sqlite.DatabaseSync.prototype, "exec");
}

/** A module's real exports with `names` counted under `prefix.name`. */
export function counted<T extends Record<string, unknown>>(real: T, prefix: string, names: readonly string[]): T {
  const out: Record<string, unknown> = { ...real };
  for (const name of names) {
    const original = real[name];
    if (typeof original !== "function") throw Error(`wire probe: ${prefix}.${name} is not a function`);
    out[name] = function (this: unknown, ...args: unknown[]) {
      const tally = context.getStore(), key = `${prefix}.${name}`;
      if (tally !== undefined) tally.projections[key] = (tally.projections[key] ?? 0) + 1;
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };
  }
  return out as T;
}

/**
 * Run each request the server receives inside the tally `next()` hands out at that moment (requests are sent one at a
 * time, so the tally set before a request is that request's). Returns the setter.
 */
export function tallyRequests(server: Server): { expect: (tally: Tally | null) => void } {
  const listeners = server.listeners("request") as ((request: IncomingMessage, response: ServerResponse) => void)[];
  server.removeAllListeners("request");
  let pending: Tally | null = null;
  server.on("request", (request: IncomingMessage, response: ServerResponse) => {
    const tally = pending ?? newTally();
    pending = null;
    // What runs once the answer is sent (a slow request's latency record, when the answer took over a second) is
    // bookkeeping that depends on time, not the request's cost: it runs in the background tally, never this one.
    const once = response.once.bind(response);
    response.once = ((event: string, fn: (...args: unknown[]) => void) => event === "finish"
      ? once(event, (...args: unknown[]) => context.run(background, () => fn(...args))) : once(event, fn)) as typeof response.once;
    context.run(tally, () => { for (const listener of listeners) listener.call(server, request, response); });
  });
  return { expect: tally => { pending = tally; } };
}
