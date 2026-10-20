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
import { lstatSync, realpathSync } from "node:fs";
import { proveLiveConsole, type AttachProof, type AttachSeams } from "./console-instance.js";
import { underAgent } from "./prompt.js";
import { envelopeJson } from "./envelope.js";
import { createRequire } from "node:module";
import { openStoreReadOnly, readSchemaVersion, SCHEMA_VERSION } from "./store.js";

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

/** The database's schema version by the store's own strict reader, read without changing anything. */
function schemaOf(file: string): { ok: true; version: number | null } | { ok: false } {
  try {
    // Loaded only here, as the store loads it: the CLI's other commands never pay for (or warn about) it.
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(file, { readOnly: true });
    try { const read = readSchemaVersion(db as unknown as Parameters<typeof readSchemaVersion>[0]); return read.ok ? read : { ok: false }; }
    finally { db.close(); }
  } catch { return { ok: false }; }
}
/** Whether the database file is there: "absent" only when the system says so (ENOENT), never for a path it won't show. */
function databasePresence(file: string): "present" | "absent" | "unknown" {
  try { lstatSync(file); return "present"; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unknown"; }
}

async function prove(seams: QuickStartSeams): Promise<AttachProof> {
  // Read only, never created or migrated, never cleaned up: proving changes nothing. "None" only when nothing of this
  // build can be running on it (no database yet, or one older than this build, which `up` brings up to date); a
  // database that can't be read, is mid-upgrade or is newer than this build can't be checked, so it is refused.
  const none = { ok: false, state: "none", message: "no console is running" } as const;
  const unverifiable = (why: string) => ({ ok: false, state: "refused", message: `${why}, so a running console can't be checked — run \`toolroll up\` to see what's wrong` } as const);
  const presence = databasePresence(seams.databaseFile);
  if (presence === "absent") return none;
  if (presence === "unknown") return unverifiable("Toolroll's database can't be reached");
  const schema = schemaOf(seams.databaseFile);
  if (!schema.ok) return unverifiable("Toolroll's database can't be read");
  if (schema.version === null || (schema.version > 0 && schema.version < SCHEMA_VERSION)) return none;
  if (schema.version !== SCHEMA_VERSION) return unverifiable("Toolroll's database is being upgraded");
  const store = openStoreReadOnly(seams.databaseFile);
  if (store === null) return unverifiable("Toolroll's database can't be read");
  try { return await proveLiveConsole(seams.databaseFile, store, seams.build, seams.attach ?? {}); }
  catch { return unverifiable("the running console couldn't be checked"); }
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
    if (json) write(envelopeJson({ ok: would !== "refuse", command: "toolroll", repo, would, ...(proof.ok ? { url: proof.url } : { console: proof.state, message: proof.message }), dryRun: true }));
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
