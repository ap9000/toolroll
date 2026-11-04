/**
 * Whether the console may read a folder synchronously right now.
 *
 * The console answers every page on one thread, so one synchronous read of a folder that has stopped answering (a
 * drive that hangs, a folder macOS holds in iCloud) freezes the console with it: it listens and answers nothing, not
 * even /healthz (the 0.9.82 and 0.9.87 deploys). So the console's own work (its request handling and its background
 * pass, serve.ts) runs inside a folder scope: there, a synchronous read of a person's folder goes ahead only when that
 * folder answered an off-thread look lately (project-identity.ts `answering`), or it lies in the console's own data.
 * Otherwise the read isn't made and its caller refuses, says the folder is unavailable, or throws FolderUnavailable.
 *
 * Availability never decides authorization: a held-back canonicalization throws FolderUnavailable (project.ts), never
 * answers null, so no caller falls back to a path's spelling because a folder didn't answer.
 *
 * Work outside a console scope (the worker, even in the same process as the console; `up`; the CLI) reads as it
 * always did.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { resolve, sep } from "node:path";

/** One console's answer for a resolved path. `pointer`: the path came from a file a build can write (a checkout's
 * `.git` or `commondir`), so the console's own folders (build checkouts among them) don't vouch for it by spelling. */
export type FolderGate = (path: string, pointer: boolean) => boolean;

const scope = new AsyncLocalStorage<FolderGate>();

/** What a caller says, and throws, when the gate holds a read back. */
export const FOLDER_DIDNT_ANSWER = "the folder didn't answer";

/** A synchronous read the console's folder gate held back: the folder is unavailable now, which is never a "no". */
export class FolderUnavailable extends Error {
  constructor(readonly path: string) { super(FOLDER_DIDNT_ANSWER); this.name = "FolderUnavailable"; }
}

/** Runs `work` (and everything it starts) inside the console's folder scope. */
export function inFolderScope<T>(gate: FolderGate, work: () => T): T {
  return scope.run(gate, work);
}

/** Whether a synchronous read of `path` may happen now. Outside a console's folder scope: always. */
export function folderAnswers(path: string, pointer = false): boolean {
  const gate = scope.getStore();
  return gate === undefined || gate(resolve(path), pointer);
}

/** `path` is `folder` or inside it (both resolved). */
export function insideFolder(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep);
}
