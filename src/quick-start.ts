/**
 * BARE `toolroll` IN A REPOSITORY (docs/plans/agents-cockpit.md B1): the two-action start.
 *
 * Inside a git repository, `toolroll` with nothing else (or only --json) either starts the console for it (`up`), or —
 * when this installation's console is already running and PROVES it is (console-instance.ts: a fresh challenge on the
 * discovery socket and on its HTTP listener, answered with the secret in the database this CLI opened itself) —
 * adds the repository through the ordinary project admission and opens that proved console. Under an agent, or with
 * --json, it starts nothing and changes nothing: it says what it would do. Outside a repository, it scans as before
 * (the scan is also `toolroll scan`).
 */
import { existsSync, realpathSync } from "node:fs";
import { proveLiveConsole, type AttachProof, type AttachSeams } from "./console-instance.js";
import { underAgent } from "./prompt.js";
import { openStore } from "./store.js";

export type QuickStartSeams = {
  databaseFile: string;
  cwd: string;
  env: Record<string, string | undefined>;
  build: string;
  /** The repository's top folder for a directory, or null outside one. */
  findRepo: (cwd: string) => Promise<string | null>;
  /** Whether this installation already admitted the repository. */
  enrolled: (repo: string) => Promise<boolean>;
  /** The ordinary admission (`repos add`): its registry lock and ceilings, from this CLI's own database. */
  admit: (repo: string) => Promise<number>;
  /** `up`, for this repository. */
  startUp: () => Promise<number>;
  openBrowser: (url: string) => void | Promise<void>;
  terminal: boolean;
  attach?: AttachSeams;
  /** Tests: the agent check (default: the environment and the process's ancestors). */
  underAgent?: boolean;
};

const EXIT = { ok: 0, refused: 3 } as const;

/** Whether argv is a bare `toolroll` (nothing, or only --json). */
export const isBareInvocation = (argv: readonly string[]): boolean => argv.every(one => one === "--json");

async function prove(seams: QuickStartSeams): Promise<AttachProof> {
  // No database yet: nothing has ever run here (and a dry run creates nothing).
  if (!existsSync(seams.databaseFile)) return { ok: false, state: "none", message: "no console is running" };
  const store = openStore(seams.databaseFile);
  try { return await proveLiveConsole(seams.databaseFile, store, seams.build, seams.attach ?? {}); }
  finally { store.close(); }
}

/** null: not this command (outside a repository) — the caller scans as before. */
export async function runQuickStart(argv: readonly string[], write: (line: string) => void, seams: QuickStartSeams): Promise<number | null> {
  const found = await seams.findRepo(seams.cwd);
  if (found === null) return null;
  let repo = found;
  try { repo = realpathSync(found); } catch { /* as found */ }
  const json = argv.includes("--json");
  const dry = json || (seams.underAgent ?? underAgent(seams.env));
  const proof = await prove(seams);
  const enrolled = await seams.enrolled(repo);
  const would = proof.ok ? (enrolled ? "open" : "add-and-open") : proof.state === "none" ? "start" : "refuse";

  if (dry) {
    // Nothing starts, nothing is added, nothing opens: what a person would get, in words or one envelope.
    const words = would === "start" ? `Would start Toolroll for ${repo} (toolroll up).`
      : would === "refuse" ? `Would refuse: ${(proof as { message: string }).message}.`
      : `Would ${would === "add-and-open" ? `add ${repo} and ` : ""}open the running console at ${(proof as { url: string }).url}.`;
    if (json) write(JSON.stringify({ ok: would !== "refuse", command: "toolroll", repo, would, ...(proof.ok ? { url: proof.url } : { console: proof.state, message: proof.message }), dryRun: true }));
    else write(words);
    return would === "refuse" ? EXIT.refused : EXIT.ok;
  }

  if (!proof.ok && proof.state === "refused") {
    write(`Toolroll can't attach: ${proof.message}.`);
    return EXIT.refused;
  }
  if (!proof.ok) return seams.startUp();

  if (!enrolled) {
    const admitted = await seams.admit(repo);
    if (admitted !== 0) return admitted;
  }
  write(`Toolroll is on ${proof.url}`);
  if (seams.terminal) await seams.openBrowser(proof.url);
  return EXIT.ok;
}
