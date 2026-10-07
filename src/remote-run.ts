/**
 * The remote run this code is inside (runOperateAs in operate.ts), if any. A leaf module so the credential
 * checks every command reaches (scope.ts) can honour it without importing the command table.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** A principal re-proved against the store for one remote run. */
export type RemoteRun = {
  readonly account: string;
  readonly scope: "read" | "act";
  readonly tokenName: string;
  readonly source: "api" | "mcp";
  /** What credential lookups hand back for this person in place of a password: unguessable, this run only. */
  readonly secret: string;
  /** Whether the person may use `repo` now (their token's projects and their account's current access). */
  readonly allows: (repo: string | null) => boolean;
  /** Files the caller sent, keyed by the argument that names them. Nothing else is read for input. */
  readonly files: Readonly<Record<string, string>>;
};

const running = new AsyncLocalStorage<RemoteRun>();

/** The remote run this code is inside, or null for every local command. */
export function activeRemote(): RemoteRun | null {
  return running.getStore() ?? null;
}

export function withRemote<T>(run: RemoteRun, fn: () => T): T {
  return running.run(run, fn);
}
