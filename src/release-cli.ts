/**
 * `toolroll release <branch>` (release.ts): the command line around the release coordinator.
 *
 * `release <lease>` used to return a runner's lease; that is `toolroll worker release <lease>` now. The old form still
 * works for a value shaped like a lease id (a UUID), with a one-line warning, until the next minor version. A
 * UUID-shaped value given with release options is refused rather than guessed at.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
// Loaded on first use, like the store: a static import prints Node's SQLite warning before the CLI can quiet it.
const sqlite = (): typeof import("node:sqlite") => createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
import { checkedEnvelopeJson } from "./contracts/cli.js";
import { RELEASE_LIMITS, runRelease, type ReleaseAdapters, type ReleaseOutcome } from "./release.js";
import { processes, releaseAdapters } from "./release-adapters.js";
import { releaseGate, type GateReleaseWorld } from "./release-gate.js";
import { databasePath, openStore, revokeRelease, type Database } from "./store.js";
import { carryRefusalWords, proveCarry, setAskEveryReleaseCommit } from "./release-carry.js";

export const RELEASE_HELP = `toolroll release <branch> — release Toolroll itself, from a pushed branch with an open pull request

  Requires an active approver's scope approval (the only human step) and a passing Full check on the exact commit.
  Completes that result, drains, backs up, deploys and relinks both CLI names to that commit. After PR checks pass,
  squash-merges, deletes the matching remote branch, verifies the merged tree and tags. Both macOS legs gate npm
  publication; Homebrew waits for its checks to register and all pass before merging.

  Run the same command to resume after a stop. Interrupted deployments recover their saved stage before retrying.

toolroll release --release-gate <id> [--yes] — lift the update pause a deployment left before its swap

  Shows why it is safe first: the pause is that deployment's, its journal stopped before the swap, and the
  database, service definition and running service are all still the previous build's. --yes lifts that one pause.
  Any missing or contradicting evidence refuses and leaves the pause in place.

toolroll release carry <release> --to <commit> [--request <id>] — carry a person's release approval to a later commit

  Only tests, docs and the changelog may change after the approval, within the limits, with an identical production
  build. Anything else is refused, naming the commit, path and rule, and that commit needs a person's approval.

toolroll release revoke <release> — stop carrying later commits (before the merge starts)

toolroll release ask-every-commit on|off --repo <path> — this project's releases ask for every later commit (on), or
  carry test-only commits (off; a person's own command, never the lead's)

Options
  --no-carry             every later commit of this release asks for approval again
  --to <commit>          with carry: the later commit
  --request <id>         with carry: the request's own id, so a retry is the same request
  --repo <path>          the gate checkout the release check runs in (default: this checkout)
  --new                  release a new commit on the branch, setting the earlier unfinished release aside
  --limit <step>=<min>   change one step's time limit (${Object.entries(RELEASE_LIMITS).map(([step, minutes]) => `${step} ${minutes}`).join(", ")})
  --tap <owner/name>     the Homebrew tap (default ap9000/homebrew-toolroll)
  --release-gate <id>    check (and with --yes, lift) one update pause left before a deployment's swap
  --yes                  with --release-gate: lift the pause once it is proved safe
  --json                 answer with one machine envelope

A runner's lease is returned with \`toolroll worker release <lease>\`.`;

/** A runner lease id (claim.ts mints randomUUID()). */
export const LEASE_SHAPED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const LEASE_DEPRECATION = "`toolroll release <lease>` is now `toolroll worker release <lease>`; the old form goes in the next minor version.";

export type ReleaseCliDeps = {
  adapters?: ReleaseAdapters;
  stateDir?: string;
  cwd?: string;
  /** The deprecated lease form, handed to the worker command. */
  releaseLease?: (args: readonly string[]) => Promise<number>;
  warn?: (line: string) => void;
  /** What --release-gate reads and changes (release-gate.ts); the installation's own by default. */
  gateWorld?: GateReleaseWorld;
  /** The plane's database for the authority commands (default: this installation's). */
  database?: string;
  now?: () => Date;
};

const VALUE_FLAGS = new Set(["--repo", "--limit", "--tap", "--release-gate", "--to", "--request"]);
const BARE_FLAGS = new Set(["--new", "--json", "--help", "--yes", "--no-carry"]);

export async function runReleaseCommand(args: readonly string[], write: (line: string) => void, deps: ReleaseCliDeps = {}): Promise<number> {
  const json = args.includes("--json");
  const refuse = (reason: string, message: string, code: number) => {
    write(json ? checkedEnvelopeJson({ ok: false, command: "release", reason, message }) : message);
    return code;
  };
  const positional: string[] = [];
  const limits: Record<string, number> = {};
  let repo: string | undefined, tap: string | undefined, gate: string | undefined, to: string | undefined, request: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (BARE_FLAGS.has(arg)) continue;
    if (VALUE_FLAGS.has(arg)) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) return refuse("usage", `${arg} takes a value.`, 2);
      i += 1;
      if (arg === "--repo") repo = value;
      else if (arg === "--to") to = value;
      else if (arg === "--request") request = value;
      else if (arg === "--tap") tap = value;
      else if (arg === "--release-gate") gate = value;
      else {
        const match = /^([a-z]+)=([0-9]+)$/.exec(value);
        if (match === null || !(match[1]! in RELEASE_LIMITS) || Number(match[2]) < 1) return refuse("usage", `--limit takes <step>=<minutes> for one of: ${Object.keys(RELEASE_LIMITS).join(", ")}.`, 2);
        limits[match[1]!] = Number(match[2]);
      }
      continue;
    }
    if (arg.startsWith("--")) return refuse("usage", `Unknown option ${arg}.\n${RELEASE_HELP}`, 2);
    positional.push(arg);
  }
  if (args.includes("--help")) { write(RELEASE_HELP); return 0; }
  if (gate !== undefined) {
    if (positional.length > 0 || args.some(arg => ["--repo", "--limit", "--tap", "--new"].includes(arg))) return refuse("usage", "--release-gate <id> takes no branch or release options.", 2);
    return runGateRelease(gate, args.includes("--yes"), write, json, deps.gateWorld ?? installedGateWorld());
  }
  if (args.includes("--yes")) return refuse("usage", "--yes goes with --release-gate <id>; a release needs no confirmation beyond the owner's approval.", 2);
  if (["carry", "revoke", "ask-every-commit"].includes(positional[0] ?? "") && positional.length === 2) {
    return runAuthorityCommand(positional[0] as "carry" | "revoke" | "ask-every-commit", positional[1]!, { to, request, repo: repo === undefined ? undefined : resolve(deps.cwd ?? process.cwd(), repo) }, write, json, deps);
  }
  if (positional.length !== 1) return refuse("usage", `Which branch? \`toolroll release <branch>\`.\n${RELEASE_HELP}`, 2);
  const branch = positional[0]!;

  if (LEASE_SHAPED.test(branch)) {
    const releaseOptions = args.filter(arg => VALUE_FLAGS.has(arg) || arg === "--new");
    if (releaseOptions.length > 0) return refuse("ambiguous", `${branch} looks like a lease id, but ${releaseOptions[0]} is a release option. Return a lease with \`toolroll worker release <lease>\`; a branch shaped like a lease id can't be released.`, 2);
    (deps.warn ?? (line => process.stderr.write(`${line}\n`)))(LEASE_DEPRECATION);
    if (deps.releaseLease === undefined) return refuse("usage", "This build can't return leases from here: use `toolroll worker release <lease>`.", 2);
    return deps.releaseLease(args);
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith("-") || branch.includes("..")) return refuse("usage", `${branch} is not a branch name this command takes.`, 2);

  const checkout = resolve(deps.cwd ?? process.cwd(), repo ?? ".");
  const stateDir = deps.stateDir ?? dirname(databasePath(process.env, homedir()));
  const lines: string[] = [];
  const say = (line: string) => { if (json) lines.push(line); else write(line); };
  const adapters = deps.adapters === undefined
    ? releaseAdapters({ checkout, say, ...(tap === undefined ? {} : { tap }), ...(limits["deploy"] === undefined ? {} : { deployMinutes: limits["deploy"] }) })
    : { ...deps.adapters, say };
  const outcome = await runRelease({ branch, checkout, stateDir, limits, fresh: args.includes("--new"), noCarry: args.includes("--no-carry") }, adapters);
  return report(outcome, write, json, lines);
}

function report(outcome: ReleaseOutcome, write: (line: string) => void, json: boolean, lines: readonly string[]): number {
  const release = outcome.journal === null ? null : {
    branch: outcome.journal.branch, candidate: outcome.journal.candidate.sha, tree: outcome.journal.candidate.tree, version: outcome.journal.packageVersion,
    tag: outcome.journal.tag, pullRequest: outcome.journal.pr, task: outcome.journal.task.id, step: outcome.journal.step,
    merge: outcome.journal.merge?.sha ?? null, runtime: outcome.journal.deploy?.runtime ?? null,
  };
  if (outcome.ok) {
    if (json) write(checkedEnvelopeJson({ ok: true, command: "release", release, journal: outcome.file, said: lines }));
    return 0;
  }
  if (json) {
    write(checkedEnvelopeJson({ ok: false, command: "release", reason: outcome.reason, message: outcome.message, step: outcome.step, release, journal: outcome.file, resume: outcome.resume, said: lines }));
  } else {
    write(`✗ Stopped at ${outcome.step}: ${outcome.message}`);
    write(`  Continue from there: ${outcome.resume}`);
  }
  // A usage slip or refusal before anything began is 2; a stop along the way is 3 ("no", not "broken"), as elsewhere.
  return outcome.reason === "usage" ? 2 : 3;
}

/** The installation's live database, LaunchAgents and processes, for --release-gate. */
function installedGateWorld(): GateReleaseWorld {
  const database = databasePath(process.env, homedir());
  const agents = join(homedir(), "Library", "LaunchAgents");
  return {
    database, stateDir: dirname(database), now: () => new Date(), processes,
    open: () => {
      const db = new (sqlite().DatabaseSync)(database) as unknown as Database;
      db.exec("PRAGMA busy_timeout=5000");
      return db;
    },
    servicePlists: () => ["com.toolroll.browser", "com.standing-orders.browser"].map(label => join(agents, `${label}.plist`))
      .filter(path => existsSync(path)).map(path => ({ path, text: readFileSync(path, "utf8") })),
  };
}

function runGateRelease(id: string, yes: boolean, write: (line: string) => void, json: boolean, world: GateReleaseWorld): number {
  let outcome: ReturnType<typeof releaseGate>;
  try { outcome = releaseGate(id, world, yes); } catch (error) { outcome = { ok: false, reason: "error", message: `${(error as Error).message} The update pause was left as it is.` }; }
  if (!outcome.ok) {
    write(json ? checkedEnvelopeJson({ ok: false, command: "release", reason: outcome.reason, message: outcome.message }) : `✗ ${outcome.message}`);
    return outcome.reason === "usage" ? 2 : 3;
  }
  if (json) {
    write(checkedEnvelopeJson({ ok: true, command: "release", gate: { id: outcome.id, released: outcome.released, stage: outcome.stage, proof: outcome.proof } }));
    return 0;
  }
  write(outcome.released ? `✓ Lifted update pause ${outcome.id}: new work can start again.` : `Update pause ${outcome.id} was left before its deployment's swap:`);
  for (const line of outcome.proof) write(`  • ${line}`);
  if (!outcome.released) write(`Lift it: toolroll release --release-gate ${outcome.id} --yes`);
  return 0;
}

/**
 * The release's authority from the command line (release-once.md): ask for a carry (anyone may ask, the lead
 * included; only the rules decide), stop carrying (only ever stricter), or change the project's carry setting
 * (turning carrying back on is a person's own command, never the lead's or a remote token's).
 */
async function runAuthorityCommand(command: "carry" | "revoke" | "ask-every-commit", target: string, flags: { to: string | undefined; request: string | undefined; repo: string | undefined },
  write: (line: string) => void, json: boolean, deps: ReleaseCliDeps): Promise<number> {
  const name = `release ${command}`;
  const answer = (ok: boolean, fields: Record<string, unknown>, words: string, code: number) => {
    write(json ? checkedEnvelopeJson({ ok, command: name, ...fields } as never) : words);
    return code;
  };
  const database = deps.database ?? databasePath(process.env, homedir());
  if (!existsSync(database)) return answer(false, { reason: "no-plane", message: "This machine has no Toolroll database." }, "This machine has no Toolroll database.", 1);
  const store = openStore(database);
  const now = (deps.now ?? (() => new Date()))();
  try {
    if (command === "ask-every-commit") {
      if (target !== "on" && target !== "off") return answer(false, { reason: "usage", message: "ask-every-commit takes on or off." }, "ask-every-commit takes on or off.", 2);
      if (flags.repo === undefined) return answer(false, { reason: "usage", message: "Name the project with --repo <path>." }, "Name the project with --repo <path>.", 2);
      if (target === "off" && (process.env["TOOLROLL_LEAD_TOKEN"] !== undefined || process.env["TOOLROLL_REMOTE_TOKEN"] !== undefined)) {
        return answer(false, { reason: "person-only", message: "Only a person turns carrying back on." }, "Only a person turns carrying back on.", 1);
      }
      setAskEveryReleaseCommit(store, flags.repo, target === "on", "cli", now);
      const words = target === "on" ? "Every later release commit in this project asks for approval." : "Later test-only release commits ship under the release approval.";
      return answer(true, { repo: flags.repo, ask: target === "on" }, words, 0);
    }
    const id = Number(target);
    if (!Number.isSafeInteger(id) || id < 1) return answer(false, { reason: "usage", message: `${target} isn't a release id.` }, `${target} isn't a release id.`, 2);
    if (command === "revoke") {
      const done = revokeRelease(store, id, "cli", now);
      return done.ok ? answer(true, { release: id }, `Release ${id} no longer carries later commits.`, 0) : answer(false, { reason: "refused", message: done.why }, done.why, 1);
    }
    if (flags.to === undefined || !/^[0-9a-f]{40}$/.test(flags.to)) return answer(false, { reason: "usage", message: "carry takes --to <full commit id>." }, "carry takes --to <full commit id>.", 2);
    const result = await proveCarry(store, { authority: id, to: flags.to, ...(flags.request === undefined ? {} : { requestId: flags.request }), now });
    if (result.ok) return answer(true, { release: id, task: result.taskId, retried: result.retried, carry: { files: result.carry.files, lines: result.carry.changedLines } },
      `Carried release ${id} to ${flags.to.slice(0, 7)}: task ${result.taskId} (${result.carry.files} files, ${result.carry.changedLines} lines).`, 0);
    return answer(false, { reason: result.reason, message: result.message, ...(result.path === undefined ? {} : { path: result.path }) }, carryRefusalWords(result, flags.to), 1);
  } finally { store.close(); }
}
