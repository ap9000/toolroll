/**
 * Whether this process may read a folder synchronously right now.
 *
 * The console answers every page on one thread, so one synchronous read of a folder that has stopped answering (a
 * drive that hangs, a folder macOS holds in iCloud) freezes the console with it: it listens and answers nothing, not
 * even /healthz (the 0.9.82 and 0.9.87 deploys). The console therefore installs a gate as it starts (serve.ts): a
 * synchronous read of a person's folder goes ahead only when that folder answered an off-thread look lately
 * (project-identity.ts `answering`), or it lies in the console's own data. Otherwise the read is not made and its caller
 * says the folder didn't answer, as it would for a folder that is gone.
 *
 * The reads that consult it are the ones that reach a project's folder from a page or the background pass:
 * project.ts canonicalProject (every project identity resolved inline), teardown-git.ts viewedGitSync (the git views a
 * page reads), egress.ts repositoryEcosystems, and the small file reads of flows and setup. A process with no gate
 * (the worker, `up` itself, the CLI) reads as it always did.
 */

import { resolve, sep } from "node:path";

/** One gate's answer for a resolved path: true lets the read go ahead. */
export type FolderGate = (path: string) => boolean;

const gates = new Set<FolderGate>();

/** What a caller says, and throws, when the gate holds a read back. */
export const FOLDER_DIDNT_ANSWER = "the folder didn't answer";

/** Installs a gate for this process (a console as it starts); the returned function removes it (as it closes). With
 * more than one installed (several consoles in one test process), a read goes ahead when any of them lets it. */
export function installFolderGate(gate: FolderGate): () => void {
  gates.add(gate);
  return () => { gates.delete(gate); };
}

/** Whether a synchronous read of `path` may happen now. No gate installed: always. */
export function folderAnswers(path: string): boolean {
  if (gates.size === 0) return true;
  const at = resolve(path);
  for (const gate of gates) if (gate(at)) return true;
  return false;
}

/** `path` is `folder` or inside it (both resolved). */
export function insideFolder(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep);
}
