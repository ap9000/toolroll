#!/usr/bin/env node
/**
 * The command.
 *
 * `toolroll` with no arguments reads the repositories below the working
 * directory and prints what is in flight. It writes nothing, starts nothing,
 * and asks nothing. Everything it knows comes from git and from the operator's
 * own filesystem.
 *
 * `--json` exists because half the intended audience is an agent, and an agent
 * should not have to parse a column layout.
 */

import { existsSync, lstatSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { configPath, loadRepos } from "./repos.js";
import { addedWords, admitProject, commandLineActor, consoleRunning, proveProjectRoot, registryBeside, releaseProject, type AdmissionActor } from "./project-admission.js";
import { envValue } from "./names.js";
import { CAPABILITIES, ENVELOPE_VERSION, capturedEnvelope, onEnvelopeCaptured, resetCapturedEnvelope } from "./envelope.js";
// Every envelope is checked against its command's schema (logged, never refused), then serialized unchanged.
import { checkedEnvelopeJson as envelopeJson } from "./contracts/cli.js";
import {
  applyClaudeCodeInstall,
  applyInstall,
  contextBlock,
  defaultClaudeCodeSkillDir,
  planClaudeCodeInstall,
  planInstall,
} from "./skills.js";
import { GUIDES, guideNamed } from "./guides.js";
import { parseGithubRepo, previewGithubRepo, cloneGithubRepo, isLargeRepo } from "./onboard.js";
import { run as execRun } from "./exec.js";
import { COMMAND_GUIDE, SURFACE_NOTES, SURFACE_SCHEMA_VERSION } from "./surface.js";
import { runSessionCommand, SESSION_CLI_ACTIONS, type SessionCliOptions } from "./session-cli.js";
import { maybeRunTeamCommand, TEAM_CLI_ACTIONS, type TeamCliOptions } from "./team-cli.js";
import { maybeRunRemoteCommand, type RemoteExecOptions } from "./remote-exec.js";
import { runHealthCommand } from "./health-cli.js";
import { discover, inspectAll, type RepoSnapshot } from "./discover.js";
import { readPulls } from "./pulls.js";
import {
  detectGraphs,
  chooseBackend,
  setupOptions,
  LABELS as GRAPH_LABELS,
  type BackendKind,
} from "./graph.js";
import { openStore, openStoreReadOnly, databasePath, type Store } from "./store.js";
import { PACKAGE_VERSION } from "./version.js";
import { runUpdateCommand, type UpdateCliDeps } from "./toolroll-update-cli.js";
import type { BackendGrant } from "./grant.js";
import { runOperate, OPERATE_HELP, type OperateOptions } from "./operate.js";
import { renderReport, renderPulls, renderGraph, type PullGroup, type RemoteMap } from "./render.js";
import { readRemote } from "./remote.js";
import { DEFAULT_MAX_DEPTH } from "./scan.js";
import {
  BIN_NAME,
  chooseTarget,
  planLink,
  applyLink,
  planUnlink,
  applyUnlink,
} from "./link.js";

export type CliOptions = {
  roots: string[];
  /** The positional tokens exactly as typed, index-aligned with `roots` —
   * kept because a resolved absolute path can no longer say whether the
   * operator typed a bare word that might have been a command. */
  rawRoots: string[];
  /** Whether roots came from the command line, as opposed to the default. */
  rootsGiven: boolean;
  maxDepth: number;
  json: boolean;
  includeHidden: boolean;
  /** Report everything discoverable, ignoring the enrolled list. */
  all: boolean;
  dirty: boolean;
  /** Skip the network entirely: branches only, no pull requests or issues. */
  local: boolean;
  help: boolean;
};

export type ParseResult = { options: CliOptions } | { error: string };

type Write = (line: string) => void;

const USAGE_EXIT = 2;

export const HELP = `toolroll — a control plane for unattended coding agents

Usage
  toolroll [path...]        report what is in flight
  toolroll pulls            report what is waiting on a person
  toolroll graph            report which work graph is already here
  toolroll repos            list connected repositories, and how to adjust
  toolroll repos add <path> add a project; it is in the console at once (no path: the repo you are in)
  toolroll repos remove <path>
                                   take it out of the console; its tasks and results stay
  toolroll repos add-from-github <owner/name> --root <dir>
                                   preview, then clone and connect (--yes)
  toolroll link             put \`toolroll\` on your PATH
  toolroll unlink           take it off again
  toolroll update           update to the latest release: verified, drained, undoable
                                   (preview first; --yes, --now, --at HH:MM, --rollback)
  toolroll contract         the machine contract: envelope version + capabilities
                                   (--commands dumps the declared command guide)
  toolroll skills install --claude-code [--dir <path>]
                                   install this binary's guides for Claude Code (preview first)
  toolroll skills install   teach a repo's agents this queue exists (preview first)
  toolroll skills list      the guides this exact binary serves
  toolroll skills get <name>  print one guide (version-matched, never stale)
  toolroll demo             a seeded throwaway sandbox — see it working in 90 seconds
  toolroll up               app + builder for every saved project — the normal start
  toolroll onboard          make your agent Toolroll's lead: add this repo, install its skill (--yes), offer starter flows (--starter)
  toolroll status           running, queued, ready results, release check and plan windows
  toolroll health           recent server latency, write waits and live streams
  toolroll integrations     which integrations work, and what to do about the ones that don't (--json)
  toolroll session          native coding sessions through the running service
  toolroll connect          save a private connection to your central service
  toolroll lead             named leads on the connected service
  toolroll lead token       mint your lead agent's credential: its own work pings nobody
  toolroll lead say "<text>"  (the lead) one short message in its person's chat
  toolroll conversation     shared and private conversations on that service
  toolroll chat --lead <id> --conversation <id>  central chat (use --local for local chat)

Operating the queue — \`toolroll task\` prints the whole surface,
and any queue command + --help prints it too
  toolroll approver add <name>
                               mint the credential that lets a person say yes
  toolroll ready            what could be dispatched right now
  toolroll check-progress <run>  current or final approved check progress
  toolroll task wait <id> [--timeout <seconds>]
                               wait for this attempt to finish or need a person
  toolroll task add <title> queue work
  toolroll task scope <id> --goal <text>
                               state what success is; approval binds to it
  toolroll task approve <id>
                               the yes — nothing builds without one
  toolroll claim <id> --runner <name>
  toolroll heartbeat <lease> / release <lease> / reap
  toolroll tick --runner <name> --token <t> --repo <path>
                               one unattended pass over the ready set
  toolroll flows list | show <id> | create | edit | trigger | script | card | archive
                               set up and inspect flows (writes preview until --yes)
  toolroll chat --as <you> --token <t>
                               talk to the mate: one conversation across every
                               project; it proposes, you confirm (--say "…" for one turn)
  toolroll serve --repo <path>  advanced: run only the console
                               (--editor vscode with --runner: file links
                               open in VS Code on the device you browse from)
  toolroll watch / daemon install   advanced: run only the builder
  toolroll reconcile        recover what the last stretch left behind

With nothing connected it reports everything it can find below the working
directory. Once you connect repositories it reports those instead.

Options
  --all         report everything discoverable, ignoring connected repos
  --depth <n>   directory levels to descend (default: ${DEFAULT_MAX_DEPTH})
  --hidden      include dot-directories, which are skipped by default
  --dirty       also read each working tree for uncommitted files
  --local       branches only: no network, no pull requests, no issues
  --json        emit a machine-readable envelope instead of a report
  -o <file>     also write that envelope to a file (requires --json)
  -h, --help    show this

Nothing is written, installed, or configured. Every repository is read
through git with --no-optional-locks, so a scan never contends for the
index lock with an editor you have open.

--dirty is off by default because reading a working tree is unbounded
work: on a large or cloud-synced repo \`git status\` can take minutes,
where listing branches takes milliseconds.

link shows what it would do and changes nothing; add --yes to apply it,
or --to <dir> to choose where. It never uses sudo, never leaves your
home directory, and never touches a file it did not create.`;

export function parseArgs(argv: readonly string[]): ParseResult {
  const roots: string[] = [];
  const rawRoots: string[] = [];
  const options: CliOptions = {
    roots: [],
    rawRoots: [],
    rootsGiven: false,
    maxDepth: DEFAULT_MAX_DEPTH,
    json: false,
    includeHidden: false,
    all: false,
    dirty: false,
    local: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] as string;

    if (argument === "--json") {
      options.json = true;
    } else if (argument === "--hidden") {
      options.includeHidden = true;
    } else if (argument === "--all") {
      options.all = true;
    } else if (argument === "--dirty") {
      options.dirty = true;
    } else if (argument === "--local") {
      options.local = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument === "--depth") {
      const depth = Number(argv[++index]);
      if (!Number.isInteger(depth) || depth < 0) {
        return { error: "--depth needs a whole number, for example `--depth 8`" };
      }
      options.maxDepth = depth;
    } else if (argument.startsWith("-")) {
      return { error: `unknown option ${argument} — try \`toolroll --help\`` };
    } else {
      roots.push(resolve(argument));
      rawRoots.push(argument);
    }
  }

  return {
    options: {
      ...options,
      roots: roots.length > 0 ? roots : [process.cwd()],
      rawRoots,
      rootsGiven: roots.length > 0,
    },
  };
}

/** The commands that operate the queue rather than report on the world. */
/** Every verb the CLI routes OUTSIDE runOperate. Exported (with
 * OPERATE_COMMANDS) so the declared command guide's drift tests compare
 * exact sets instead of regex-reading source. "" is the no-verb report,
 * which answers as `scan`. */
export const TOP_LEVEL_COMMANDS: readonly string[] = [
  "", "pulls", "graph", "repos", "repos add", "repos remove", "repos add-from-github",
  "link", "unlink", "update", "contract", "skills list", "skills get", "skills install", "demo",
  ...SESSION_CLI_ACTIONS.map(action => `session ${action}`),
  ...TEAM_CLI_ACTIONS,
];

export const OPERATE_COMMANDS = new Set([
  "up",
  // Only `lead token` reaches here; the central service's lead verbs answer first.
  "lead",
  "onboard",
  "status",
  "ready",
  "task",
  "project",
  "ledger",
  "audit",
  "storage",
  "monitoring",
  "integrations",
  "check-progress",
  "spend",
  "budget",
  "retention",
  "notifications",
  "backup",
  "restore",
  "export",
  "policy",
  "review",
  "assignment",
  "knowledge",
  "memory",
  "models",
  "claim",
  "heartbeat",
  "release",
  "reap",
  "enroll",
  "grants",
  "revoke",
  "runner",
  "approver",
  "coordinator",
  "mcp",
  "build",
  "tick",
  "cap",
  "gaps",
  "outbox",
  "peek",
  "brief",
  "decide",
  "incident",
  "serve",
  "watch",
  "daemon",
  "bridge",
  "publish",
  "reconcile",
  "run",
  "routine",
  "flows",
  "config", "chat", "proposals", "mode", "chat-approval", "people", "tokens", "keys",
  "setup",
  "verify",
  "intake",
  "providers",
  "template",
  "contest",
  "webhook",
  "sync",
]);

/** binSource exists so tests can exercise linking without depending on a build. */
export type MainOptions = {
  binSource?: string;
  operate?: OperateOptions;
  session?: SessionCliOptions;
  team?: TeamCliOptions;
  /** Injected by tests: the remote CLI's profile, fetch and output streams (defaults to `team`'s profile seams). */
  remote?: RemoteExecOptions;
  /** Injected by tests: the gh-facing halves of `repos add-from-github` —
   * the verb's parsing, gating, and enrollment are what CLI tests prove;
   * gh itself is proved by onboard.test.ts. */
  onboard?: { preview?: typeof previewGithubRepo; clone?: typeof cloneGithubRepo };
  update?: UpdateCliDeps;
};

/**
 * Strip `-o <file>` / `--output <file>` before dispatch. The flag belongs to
 * the entry point, not to any one command: after the command runs, whatever
 * envelope it serialized is copied to the file, so an agent reads its answer
 * from a path instead of scraping a terminal. Requires `--json`, because the
 * file receives the machine envelope and nothing else does.
 */
export function extractOutputFlag(
  argv: readonly string[],
): { args: string[]; outputFile?: string } | { error: string } {
  const args: string[] = [];
  let outputFile: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-o" || arg === "--output") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        return { error: `${arg} takes a file path` };
      }
      outputFile = value;
      i += 1;
      continue;
    }
    args.push(arg as string);
  }
  return { args, ...(outputFile === undefined ? {} : { outputFile }) };
}

export async function main(
  argv: readonly string[],
  write: Write = line => console.log(line),
  mainOptions: MainOptions = {},
): Promise<number> {
  if (argv[0] === "--version" || argv[0] === "-v") {
    write(PACKAGE_VERSION);
    return 0;
  }
  const extracted = extractOutputFlag(argv);
  if ("error" in extracted) {
    write(extracted.error);
    return USAGE_EXIT;
  }
  const { args, outputFile } = extracted;
  if (outputFile !== undefined && !args.includes("--json")) {
    write("-o requires --json — the output file receives the machine envelope");
    return USAGE_EXIT;
  }

  // A new API token is shown once, on screen: never saved to a file by the entry point.
  if (outputFile !== undefined && args.find(one => !one.startsWith("-")) === "tokens") {
    write("-o isn't used with tokens: a new token is shown once, never saved to a file");
    return USAGE_EXIT;
  }

  resetCapturedEnvelope();

  // Long-running commands (serve, up) emit their ONE envelope at startup,
  // when its URL is useful — so -o is preflighted BEFORE dispatch (an
  // unwritable target refuses up front) and written the moment the
  // envelope is captured, through a hook that never throws into the
  // command (arc 2 findings 23/30).
  const firstWord = args.find(one => !one.startsWith("-"));
  const earlyFlush = outputFile !== undefined && (firstWord === "serve" || firstWord === "up");
  let earlyFlushProblem: string | null = null;
  if (earlyFlush && outputFile !== undefined) {
    try {
      const existing = lstatSync(outputFile, { throwIfNoEntry: false });
      if (existing !== undefined) {
        if (!existing.isFile()) {
          write(`-o refuses ${outputFile}: not a regular file`);
          return USAGE_EXIT;
        }
        unlinkSync(outputFile);
      }
      writeFileSync(outputFile, "", { mode: 0o600, flag: "wx" });
    } catch (error) {
      write(`-o could not prepare ${outputFile}: ${String((error as Error).message ?? error)}`);
      return USAGE_EXIT;
    }
    onEnvelopeCaptured(body => {
      try {
        writeFileSync(outputFile, `${body}\n`, { mode: 0o600 });
      } catch (error) {
        earlyFlushProblem = String((error as Error).message ?? error);
      }
    });
  }

  let code: number;
  try {
    code = await dispatch(args, write, mainOptions);
  } finally {
    if (earlyFlush) onEnvelopeCaptured(null);
  }
  if (earlyFlushProblem !== null) {
    process.stderr.write(`-o could not write ${outputFile}: ${earlyFlushProblem}\n`);
    return code === 0 ? 1 : code;
  }

  if (outputFile !== undefined && !earlyFlush) {
    const captured = capturedEnvelope();
    if (captured !== null) {
      // Envelopes can carry one-time credentials (runner register, approver
      // add), so the file is written 0600 and never through a symlink or
      // onto a non-regular target (Codex M5-M8 audit, IV-8).
      try {
        const existing = lstatSync(outputFile, { throwIfNoEntry: false });
        if (existing !== undefined) {
          if (!existing.isFile()) {
            write(`-o refuses ${outputFile}: not a regular file`);
            return USAGE_EXIT;
          }
          unlinkSync(outputFile);
        }
        writeFileSync(outputFile, `${captured}\n`, { mode: 0o600, flag: "wx" });
      } catch (error) {
        write(`-o could not write ${outputFile}: ${String((error as Error).message ?? error)}`);
        return 1;
      }
    }
  }
  return code;
}

async function dispatch(
  argv: readonly string[],
  write: Write,
  mainOptions: MainOptions,
): Promise<number> {
  // A saved API token sends commands marked remote to the central server, before anything local opens.
  if (argv[0] === 'health') return runHealthCommand(argv.slice(1), write, mainOptions.team ?? mainOptions.remote);
  const central = await maybeRunRemoteCommand(argv, mainOptions.remote ?? mainOptions.team);
  if (typeof central === "number") return central;
  if (central !== null) argv = central.local;
  const team = await maybeRunTeamCommand(argv, write, mainOptions.team);
  if (team !== null) return team;
  if ((argv[0] === "chat" || argv[0] === "brief") && argv.includes("--local")) argv = argv.filter(arg => arg !== "--local");
  const [first, ...rest] = argv;
  if (first === "help") {
    // The bare word, because somebody will type it — never scanned as a
    // path named "help".
    write(HELP);
    return 0;
  }
  if (first === "link" || first === "unlink") {
    return runLinkCommand(first, rest, write, mainOptions.binSource);
  }
  if (first === "update") return runUpdateCommand(rest, write, mainOptions.update);
  if (first === "contract") return runContractCommand(rest, write);
  if (first === "session") return runSessionCommand(rest, write, mainOptions.session);
  if (first === "demo") return runDemoCommand(rest, write);
  if (first === "skills") return runSkillsCommand(rest, write);
  if (first === "repos") return runReposCommand(rest, write, mainOptions.onboard);
  if (first === "pulls") return runPullsCommand(rest, write);
  if (first === "graph") return runGraphCommand(rest, write);
  if (first !== undefined && OPERATE_COMMANDS.has(first)) {
    return runOperate(first, rest, write, mainOptions.operate ?? {});
  }

  const parsed = parseArgs(argv);

  if ("error" in parsed) {
    write(parsed.error);
    return USAGE_EXIT;
  }

  const { options } = parsed;
  if (options.help) {
    write(HELP);
    return 0;
  }

  const now = new Date();

  // An enrolled list is a decision the operator already made; honour it unless
  // they asked otherwise by naming paths or passing --all.
  const enrolled = await loadRepos(configFile());
  if ("error" in enrolled) {
    write(enrolled.error);
    return 1;
  }
  if (!options.all && !options.rootsGiven && enrolled.repos.length > 0) {
    return reportEnrolled(enrolled.repos, options, now, write);
  }

  const { present, missing } = partitionRoots(options.roots, existsSync);

  // A path that does not exist is a typo, not an empty search, and saying
  // "no repositories found" about it would be answering a question we never
  // asked. Warnings go inside the envelope in JSON mode so it stays
  // parseable — and when NOTHING was scannable the envelope says ok:false
  // (aligned with `pulls`), because an all-missing scan that reported
  // ok:true let a typo'd command read as success.
  if (present.length === 0) {
    write(
      options.json
        ? renderMissingJson(options.roots, missing, now)
        : describeMissing(missing, options.rawRoots, options.roots),
    );
    return USAGE_EXIT;
  }
  if (missing.length > 0 && !options.json) {
    write(describeMissing(missing, options.rawRoots, options.roots));
    write("");
  }

  const repos = await discover(present, {
    scan: { maxDepth: options.maxDepth, includeHidden: options.includeHidden },
    dirty: options.dirty,
  });
  const remote = await maybeReadRemote(repos, options);

  const output = options.json
    ? renderJson(repos, present, missing, now, remote)
    : renderReport(repos, { now, roots: present, ...(remote === undefined ? {} : { remote }) });

  write(output);
  return 0;
}

/**
 * Pull requests and issues, unless the operator asked to stay local.
 *
 * Reading them is the difference between "every branch in flight" and "every
 * branch, pull request and issue in flight", which is what the milestone asks
 * for — but it is also the only part of this report that touches the network,
 * so it is bounded and `--local` turns it off entirely.
 */
async function maybeReadRemote(
  repos: readonly RepoSnapshot[],
  options: CliOptions,
): Promise<RemoteMap | undefined> {
  if (options.local) return undefined;
  return readRemote(repos.map(repo => ({ path: repo.path, remoteUrl: repo.remoteUrl })));
}

function configFile(): string {
  return configPath(process.env, homedir());
}

/**
 * Report the enrolled repositories directly. A path that has since been moved
 * or deleted is named rather than silently dropped — a list that quietly
 * shrinks is worse than one that tells you it is stale.
 */
async function reportEnrolled(
  repos: readonly string[],
  options: CliOptions,
  now: Date,
  write: Write,
): Promise<number> {
  const { present, missing } = partitionRoots(repos, existsSync);
  const snapshots = await inspectAll(present, { dirty: options.dirty });
  const remote = await maybeReadRemote(snapshots, options);

  if (options.json) {
    write(renderJson(snapshots, present, missing, now, remote));
    return 0;
  }

  if (missing.length > 0) {
    for (const repo of missing) write(`${repo} is enrolled but is no longer there.`);
    write(`Drop it with \`toolroll repos remove ${missing[0]}\`.`);
    write("");
  }
  write(
    renderReport(snapshots, {
      now,
      roots: present,
      ...(remote === undefined ? {} : { remote }),
    }),
  );
  return 0;
}

export function partitionRoots(
  roots: readonly string[],
  exists: (path: string) => boolean,
): { present: string[]; missing: string[] } {
  return {
    present: roots.filter(exists),
    missing: roots.filter(root => !exists(root)),
  };
}

/**
 * A missing root that was typed as a bare word — no separator, no leading
 * dot, no home shorthand — is as likely a mistyped COMMAND as a missing
 * folder, and after `resolve()` the two are indistinguishable. The message
 * names both readings instead of guessing (Codex round-4 finding 18);
 * path-shaped roots keep the plain missing-path sentence.
 */
function describeMissing(missing: readonly string[], rawRoots: readonly string[] = [], roots: readonly string[] = []): string {
  const rawOf = new Map<string, string>();
  roots.forEach((resolved, index) => {
    const raw = rawRoots[index];
    if (raw !== undefined) rawOf.set(resolved, raw);
  });
  const bareWord = (raw: string | undefined): boolean =>
    raw !== undefined && !/[/\\~]/.test(raw) && !raw.startsWith(".");
  return missing
    .map(root =>
      bareWord(rawOf.get(root))
        ? `${root} does not exist — if you meant a command, \`toolroll --help\` lists them; to scan a folder, give a path that exists.`
        : `${root} does not exist — check the path.`,
    )
    .join("\n");
}

/** The all-missing scan envelope: honest ok:false with the scan fields kept. */
function renderMissingJson(roots: readonly string[], missingRoots: readonly string[], now: Date): string {
  return envelopeJson({
    ok: false,
    command: "scan",
    reason: "no-repositories",
    message: "none of the given paths exist — nothing was scanned",
    scannedAt: now.toISOString(),
    roots,
    missingRoots,
    remoteRead: false,
    repos: [],
  });
}

/**
 * `repos` with no arguments lists what is connected and shows how to change
 * it, so the way to adjust the list is visible at the moment you are looking
 * at it — rather than being something you have to remember a flag for.
 */
async function runReposCommand(argv: readonly string[], write: Write, onboard?: MainOptions["onboard"]): Promise<number> {
  // `repos` honors the machine contract like everything else (audit TG-3):
  // --json answers with one envelope, whatever the outcome.
  const json = argv.includes("--json");
  // The lead adds with its token (--token or TOOLROLL_LEAD_TOKEN); the owner needs none.
  const tokenAt = argv.indexOf("--token");
  const tokenFlag = tokenAt === -1 ? undefined : argv[tokenAt + 1];
  const bare = argv.filter((argument, index) => argument !== "--json" && (tokenAt === -1 || (index !== tokenAt && index !== tokenAt + 1)));
  const [action, ...paths] = bare;
  const databaseFile = databasePath(process.env, homedir());
  const file = registryBeside(databaseFile);
  if (tokenAt !== -1 && (tokenFlag === undefined || tokenFlag.startsWith("-"))) {
    const message = "--token needs the lead token";
    write(json ? envelopeJson({ ok: false, command: `repos ${action ?? ""}`.trim(), reason: "usage", message }) : message);
    return USAGE_EXIT;
  }
  const envLead = envValue(process.env, "LEAD_TOKEN");
  const leadToken = tokenFlag ?? (envLead === undefined || envLead === "" ? undefined : envLead);
  // Dispatched BEFORE the registry load (verification finding 3): a
  // malformed registry must not mask this command's own parsing, its
  // read-only preview, or its taxonomy — enrollment reads the registry
  // through the locked primitive at the moment it writes.
  if (action === "add-from-github") {
    return addFromGithubCommand(bare.slice(1), json, write, { databaseFile, registryFile: file, ...(leadToken === undefined ? {} : { leadToken }) }, onboard);
  }
  const loaded = await loadRepos(file);
  if ("error" in loaded) {
    write(json ? envelopeJson({ ok: false, command: "repos", reason: "unreadable", message: loaded.error }) : loaded.error);
    return 1;
  }

  if (action === undefined) {
    if (json) {
      write(envelopeJson({ ok: true, command: "repos", count: loaded.repos.length, repos: loaded.repos, file }));
      return 0;
    }
    return listRepos(loaded.repos, file, write);
  }
  if (action !== "add" && action !== "remove") {
    const message = `unknown command \`repos ${action}\` — try \`repos\`, \`repos add\`, \`repos remove\`, or \`repos add-from-github <owner/name>\``;
    write(json ? envelopeJson({ ok: false, command: "repos", reason: "usage", message }) : message);
    return USAGE_EXIT;
  }

  // `repos add` with no path means the repository you are standing in.
  const targets = (paths.length > 0 ? paths : [process.cwd()]).map(path => resolve(path));
  const lines: string[] = [];
  const said: { reason?: string; projects?: unknown[] } = {};
  const say = json ? (line: string) => lines.push(line) : write;
  const code = await withAdmission({ databaseFile, registryFile: file, ...(leadToken === undefined ? {} : { leadToken }) }, say, said, admission =>
    action === "add" ? addToRepos(admission, targets, say, said) : removeFromRepos(admission, targets, say, said));
  if (json) {
    write(
      envelopeJson({
        ok: code === 0,
        command: `repos ${action}`,
        ...(code === 0 ? {} : { reason: said.reason ?? "usage" }),
        message: lines.join(" "),
        targets,
        ...(said.projects === undefined ? {} : { projects: said.projects }),
      }),
    );
  }
  return code;
}

type Admission = { store: Store; registryFile: string; actor: AdmissionActor };

/** Open this installation's database as the owner (or its lead) for one addition or removal. */
async function withAdmission(
  where: { databaseFile: string; registryFile: string; leadToken?: string },
  write: Write,
  said: { reason?: string },
  body: (admission: Admission) => Promise<number>,
): Promise<number> {
  let store: Store;
  try {
    store = openStore(where.databaseFile);
  } catch (error) {
    said.reason = "database";
    write(`Toolroll's database couldn't be opened (${String((error as Error).message ?? error)}). Nothing changed.`);
    return 1;
  }
  try {
    const actor = commandLineActor(store, { databaseFile: where.databaseFile, ...(where.leadToken === undefined ? {} : { leadToken: where.leadToken }) });
    if ("ok" in actor) {
      said.reason = "refused";
      write(actor.message);
      return 3;
    }
    return await body({ store, registryFile: where.registryFile, actor });
  } finally {
    store.close();
  }
}

function listRepos(repos: readonly string[], file: string, write: Write): number {
  if (repos.length === 0) {
    write("No repositories connected. Toolroll reports on everything it can find.");
    write("");
    write("Connect the ones you actually work in:");
    write("  toolroll repos add ~/code/thing");
    write("  toolroll repos add            # the repo you are standing in");
    return 0;
  }

  write(`${repos.length === 1 ? "1 repository" : `${repos.length} repositories`} connected:`);
  for (const repo of repos) write(`  ${repo}${existsSync(repo) ? "" : "   (missing)"}`);
  write("");
  write("  toolroll repos add <path>      add another; it is in the console at once");
  write("  toolroll repos remove <path>   take one out of the console; its tasks stay");
  write("  toolroll repos add-from-github <owner/name> --root <dir>   clone from GitHub and connect");
  write("  toolroll --all                 report everything, ignoring this list");
  write(`  ${file}`);
  return 0;
}

/** The exit code an admission failure answers with: a folder problem is the caller's to fix (usage). */
function admissionExit(reason: string): number {
  return reason === "not-git" || reason === "unavailable" ? USAGE_EXIT : 1;
}

async function addToRepos(admission: Admission, targets: readonly string[], write: Write, said: { reason?: string; projects?: unknown[] }): Promise<number> {
  // Every folder is proved before anything is written: one that is not a
  // repository fails here, not later and further away.
  let refused = false;
  for (const path of targets) {
    const proved = await proveProjectRoot(path);
    if (!proved.ok) {
      write(proved.message);
      said.reason ??= proved.reason;
      refused = true;
    }
  }
  if (refused) return USAGE_EXIT;
  const now = new Date();
  const running = consoleRunning(admission.store, now);
  const projects: { repo: string; name: string; added: boolean }[] = [];
  for (const path of targets) {
    const admitted = await admitProject(admission.store, { registryFile: admission.registryFile, path, actor: admission.actor, now });
    if (!admitted.ok) {
      // The updater's own taxonomy survives (verification finding 4): a held
      // lock or a malformed registry is an operational fact, never "usage".
      said.reason = admitted.reason;
      said.projects = projects;
      write(admitted.message);
      return admissionExit(admitted.reason);
    }
    projects.push({ repo: admitted.repo, name: admitted.name, added: admitted.added });
    write(addedWords(admitted.name, admitted.added, running));
  }
  said.projects = projects;
  return 0;
}

async function removeFromRepos(admission: Admission, targets: readonly string[], write: Write, said: { reason?: string; projects?: unknown[] }): Promise<number> {
  const now = new Date();
  const projects: { repo: string; name: string; removed: boolean }[] = [];
  for (const path of targets) {
    const released = await releaseProject(admission.store, { registryFile: admission.registryFile, path, actor: admission.actor, now });
    if (!released.ok) {
      said.reason = released.reason;
      said.projects = projects;
      write(released.message);
      return admissionExit(released.reason);
    }
    projects.push({ repo: released.repo, name: released.name, removed: released.removed });
    write(released.removed
      ? `Removed ${released.name}; it is no longer in the console. Its tasks and results stay saved.`
      : `${released.name} isn't added, so nothing changed.`);
  }
  said.projects = projects;
  return 0;
}

/**
 * `repos add-from-github <owner/name>` — the console onboarding ceremony's
 * CLI twin (onboarding rounds 1-4; named in the ledger as the companion):
 * strict parse, gh preview BEFORE any write, the same large-repo gate, the
 * claim-first clone, and enrollment through the ONE locked registry
 * primitive. Preview by default; --yes clones. Windows refuses like the
 * console does — tree death cannot be proven there.
 */
async function addFromGithubCommand(
  argv: readonly string[], json: boolean, write: Write,
  where: { databaseFile: string; registryFile: string; leadToken?: string }, onboard?: MainOptions["onboard"],
): Promise<number> {
  const command = "repos add-from-github";
  const answer = (reason: string, message: string, code: number, extra: Record<string, unknown> = {}): number => {
    write(json ? envelopeJson({ ok: false, command, reason, message, ...extra }) : message);
    return code;
  };
  const usage = "`toolroll repos add-from-github <owner/name | github.com link> --root <dir> [--large-ok] [--yes] [--json]`";
  let spec: string | undefined;
  let rootGiven: string | undefined;
  let yes = false;
  let largeOk = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] as string;
    if (!argument.startsWith("-")) {
      if (spec !== undefined) return answer("usage", "one repository at a time", USAGE_EXIT);
      spec = argument;
      continue;
    }
    if (argument === "--yes") { yes = true; continue; }
    if (argument === "--large-ok") { largeOk = true; continue; }
    if (argument === "--root") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) return answer("usage", "--root needs a directory", USAGE_EXIT);
      rootGiven = value;
      index += 1;
      continue;
    }
    if (argument === "-h" || argument === "--help") return answer("usage", usage, USAGE_EXIT);
    return answer("usage", `unknown option ${argument} for \`repos add-from-github\``, USAGE_EXIT);
  }
  if (spec === undefined) return answer("usage", usage, USAGE_EXIT);
  const shape = parseGithubRepo(spec);
  if (!shape.ok) return answer("usage", shape.problem, USAGE_EXIT);
  if (rootGiven === undefined) return answer("usage", "--root <dir> names where the clone lands (an existing directory)", USAGE_EXIT);
  let root: string;
  try {
    root = realpathSync(resolve(rootGiven));
  } catch {
    return answer("usage", `--root ${rootGiven} does not exist`, USAGE_EXIT);
  }
  if (!lstatSync(root).isDirectory()) return answer("usage", `--root ${rootGiven} is not a directory`, USAGE_EXIT);
  // The platform refusal comes AFTER the invocation is proved well-formed
  // (verification finding 3): a Windows user still learns their typo first.
  if (process.platform === "win32") {
    return answer("platform", "adding from GitHub is not supported on Windows yet — the clone's process tree cannot be proven dead there", 1);
  }

  const previewed = await (onboard?.preview ?? previewGithubRepo)(shape.owner, shape.name);
  if (!previewed.ok) return answer(previewed.reason, previewed.message, 1);
  const reparsed = parseGithubRepo(previewed.preview.nameWithOwner);
  if (!reparsed.ok) return answer("malformed", "GitHub named a repository shape this command refuses — nothing was written", 1);
  const target = join(root, reparsed.name);
  if (dirname(target) !== root) return answer("usage", "the target escaped its root — refused; nothing was written", USAGE_EXIT);
  const diskUsageKib =
    typeof previewed.preview.diskUsageKib === "number" && Number.isFinite(previewed.preview.diskUsageKib) && previewed.preview.diskUsageKib >= 0
      ? previewed.preview.diskUsageKib
      : null;
  const large = isLargeRepo({ ...previewed.preview, diskUsageKib });
  const size = diskUsageKib === null ? "size unknown" : `${Math.max(1, Math.round(diskUsageKib / 1024))} MiB`;

  if (!yes) {
    if (json) {
      write(envelopeJson({
        ok: false, command, reason: "unconfirmed",
        preview: { nameWithOwner: previewed.preview.nameWithOwner, visibility: previewed.preview.visibility, diskUsageKib, large, target },
      }));
      return 3;
    }
    write("Would clone, exactly:");
    write(`  ${previewed.preview.nameWithOwner}  (${previewed.preview.visibility} · ${size}${large ? " — LARGE or unknown; --large-ok will be required" : ""})`);
    write(`  into ${target}, then connect it`);
    write("");
    write("Nothing was written. Re-run with --yes to apply.");
    return 3;
  }
  if (large && !largeOk) {
    return answer("large", `${previewed.preview.nameWithOwner} is large or of unknown size (${size}) — add --large-ok to clone it anyway; nothing was written`, 3);
  }

  // Who may add is settled before anything is cloned.
  const said: { reason?: string } = {};
  const problems: string[] = [];
  const allowed = await withAdmission(where, line => problems.push(line), said, async () => 0);
  if (allowed !== 0) return answer(said.reason ?? "refused", problems.join(" "), allowed);
  const cloned = await (onboard?.clone ?? cloneGithubRepo)(previewed.preview.nameWithOwner, root, async (cwd: string) => {
    const proof = await execRun("git", ["rev-parse", "--show-toplevel"], { cwd, timeoutMs: 15_000 });
    return { code: proof.code, stdout: proof.stdout };
  });
  if (!cloned.ok) return answer(cloned.reason, cloned.message, 1);
  if (cloned.target !== target) {
    return answer("malformed", "the clone answered with a different path than the preview promised — refused; nothing was connected", 1);
  }
  // The clone joins through the same admission as `repos add` and the console.
  let words = "";
  const code = await withAdmission(where, line => problems.push(line), said, async admission => {
    const now = new Date();
    const admitted = await admitProject(admission.store, { registryFile: admission.registryFile, path: cloned.target, actor: admission.actor, now });
    if (!admitted.ok) {
      said.reason = admitted.reason;
      problems.push(`${cloned.target} is cloned but not added — ${admitted.message} Add it with \`repos add ${cloned.target}\`.`);
      return 1;
    }
    words = addedWords(admitted.name, admitted.added, consoleRunning(admission.store, now));
    return 0;
  });
  if (code !== 0) return answer(said.reason ?? "failed", problems.join(" "), code);
  if (json) {
    write(envelopeJson({ ok: true, command, target: cloned.target, nameWithOwner: previewed.preview.nameWithOwner }));
    return 0;
  }
  write(`Cloned ${previewed.preview.nameWithOwner} into ${cloned.target}.`);
  write(words);
  write("Large-file objects were not downloaded — run `git lfs pull` in the repository when you need them.");
  return 0;
}

/**
 * `pulls` reads the same repositories the default report does, because the
 * question "what is waiting on me" is asked about the same set of work. It is
 * a separate command rather than part of the report because it costs a network
 * round trip per repository, and the default report is meant to stay local.
 */
async function runPullsCommand(argv: readonly string[], write: Write): Promise<number> {
  const json = argv.includes("--json");
  const unknown = argv.find(argument => argument.startsWith("-") && argument !== "--json");
  if (unknown !== undefined) {
    write(`unknown option ${unknown} — \`pulls\` takes paths and --json`);
    return USAGE_EXIT;
  }

  const named = argv.filter(argument => !argument.startsWith("-")).map(path => resolve(path));
  const targets = named.length > 0 ? named : await defaultPullTargets(write);
  if (targets === null) return 1;

  const { present, missing } = partitionRoots(targets, existsSync);
  if (present.length === 0) {
    write(json ? envelopeJson({ ok: false, command: "pulls", reason: "no-repositories", message: describeMissing(missing), groups: [] }) : describeMissing(missing));
    return USAGE_EXIT;
  }

  const groups: PullGroup[] = await Promise.all(
    present.map(async path => {
      const read = await readPulls(path);
      return { repo: basename(path), pulls: read.pulls, problems: read.problems };
    }),
  );

  write(
    json
      ? envelopeJson({ ok: true, command: "pulls", count: groups.length, groups })
      : renderPulls(groups, { now: new Date() }),
  );
  return 0;
}

/**
 * `graph` answers "what work graph is already here", which is the question
 * standing between discovery and anything autonomous. It reads the same
 * repositories the report does, and like everything else in M0 it writes
 * nothing: detection is not authorization.
 */
async function runGraphCommand(argv: readonly string[], write: Write): Promise<number> {
  const json = argv.includes("--json");
  const unknown = argv.find(argument => argument.startsWith("-") && argument !== "--json");
  if (unknown !== undefined) {
    write(`unknown option ${unknown} — \`graph\` takes paths and --json`);
    return USAGE_EXIT;
  }

  const named = argv.filter(argument => !argument.startsWith("-")).map(path => resolve(path));
  const targets = named.length > 0 ? named : await defaultPullTargets(write);
  if (targets === null) return 1;

  const { present, missing } = partitionRoots(targets, existsSync);
  if (present.length === 0) {
    write(json ? envelopeJson({ ok: false, command: "graph", reason: "no-repositories", message: describeMissing(missing), detections: [] }) : describeMissing(missing));
    return USAGE_EXIT;
  }

  const detections = await detectGraphs(present);

  // An enrolled backend outranks anything detection would have picked — the
  // ladder's first rung, and now reachable because grants are persisted. An
  // operator who already said which one must not be re-asked because a second
  // tracker turned up somewhere else on the machine.
  const enrolled = enrolledBackend(present);

  // The envelope carries the choice and the setup commands, not just the raw
  // detections: an agent reading this has the same question a person does —
  // what is here, what would you use, and what would I have to run.
  const envelope = {
    detections,
    choice: chooseBackend(detections, enrolled === undefined ? {} : { enrolled }),
    setup: setupOptions(),
  };

  write(
    json
      ? envelopeJson({ ok: true, command: "graph", ...envelope })
      : renderGraph(detections, enrolled === undefined ? {} : { enrolled }),
  );
  return 0;
}

/**
 * The backend enrolled for any of these repositories, if one is.
 *
 * Read-only and failure-tolerant on purpose: `graph` is a reporting command,
 * and a queue that cannot be opened must degrade to plain detection rather
 * than take the report down with it.
 */
function enrolledBackend(repos: readonly string[]): BackendKind | undefined {
  const store = openStoreReadOnly(databasePath(process.env, homedir()));
  if (store === null) return undefined;
  try {
    const wanted = new Set(repos);
    const grant = store.listGrants().find((one: BackendGrant) => wanted.has(one.repo));
    // A grant may name the built-in store, which detection never reports, so
    // only a backend the graph report knows about is passed through.
    return grant !== undefined && isBackendKind(grant.backend) ? grant.backend : undefined;
  } catch {
    // An older or incomplete layout degrades to detection, never a migration.
    return undefined;
  } finally {
    store.close();
  }
}

function isBackendKind(name: string): name is BackendKind {
  return Object.prototype.hasOwnProperty.call(GRAPH_LABELS, name);
}

/** null means the configuration could not be read, and was already reported. */
async function defaultPullTargets(write: Write): Promise<string[] | null> {
  const enrolled = await loadRepos(configFile());
  if ("error" in enrolled) {
    write(enrolled.error);
    return null;
  }
  return enrolled.repos.length > 0 ? enrolled.repos : [process.cwd()];
}

export type LinkArgs = { to?: string; yes: boolean };

export function parseLinkArgs(argv: readonly string[]): { args: LinkArgs } | { error: string } {
  const args: LinkArgs = { yes: false };

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] as string;
    if (argument === "--yes" || argument === "-y") {
      args.yes = true;
    } else if (argument === "--to") {
      const dir = argv[++index];
      if (dir === undefined) return { error: "--to needs a directory" };
      args.to = dir;
    } else {
      return { error: `unknown option ${argument} — try \`toolroll --help\`` };
    }
  }

  return { args };
}

/**
 * Both halves show their work before doing it. Nothing changes without --yes,
 * which is the same courtesy this tool extends to `bd init`.
 */
async function runLinkCommand(
  command: "link" | "unlink",
  argv: readonly string[],
  write: Write,
  binSource: string | undefined,
): Promise<number> {
  const parsed = parseLinkArgs(argv);
  if ("error" in parsed) {
    write(parsed.error);
    return USAGE_EXIT;
  }

  const { to, yes } = parsed.args;

  const choice = chooseTarget({
    pathEntries: (process.env["PATH"] ?? "").split(delimiter).filter(Boolean),
    home: homedir(),
    ...(to === undefined ? {} : { override: to }),
  });

  // Only `link` needs something to point at. Demanding a build before you are
  // allowed to uninstall would strand anyone whose dist/ has been cleaned.
  if (command === "unlink") return runUnlink(choice.dir, yes, write);

  const resolved = binSource === undefined ? resolveBinSource() : { source: binSource };
  if ("error" in resolved) {
    write(resolved.error);
    return USAGE_EXIT;
  }

  return runLink(resolved.source, choice, yes, write);
}

/**
 * A link must point at the built command. Running through tsx puts us in
 * src/, so resolve across to dist/ rather than linking a file node cannot run.
 */
function resolveBinSource(): { source: string } | { error: string } {
  const here = fileURLToPath(import.meta.url);
  const source = here.endsWith(".ts") ? resolve(dirname(here), "..", "dist", "cli.js") : here;

  if (!existsSync(source)) {
    return { error: "Run `npm run build` first — there is no built command to link to yet." };
  }
  return { source };
}

async function runLink(
  source: string,
  choice: { dir: string; onPath: boolean },
  yes: boolean,
  write: Write,
): Promise<number> {
  const plan = await planLink(source, choice.dir);

  if (plan.action === "conflict") {
    write(`${plan.target}: ${plan.reason}.`);
    write("Remove it yourself if you want it gone, or use --to <dir> to link elsewhere.");
    return 1;
  }
  if (plan.action === "already") {
    write(`Already linked: ${plan.target} → ${plan.source}`);
    return 0;
  }

  write(plan.action === "replace" ? `Will replace ${plan.target}` : `Will create ${plan.target}`);
  write(`             → ${plan.source}`);
  if (plan.action === "replace") write(`   (it currently points at ${plan.current})`);

  if (!yes) {
    write("");
    write("Nothing has been written. Re-run with --yes to do it.");
    return 0;
  }

  try {
    await applyLink(plan);
  } catch (error) {
    write(error instanceof Error ? error.message : String(error));
    return 1;
  }

  write("");
  write(`Linked. \`${BIN_NAME}\` is now a command.`);
  if (!choice.onPath) {
    write("");
    write(`${choice.dir} is not on your PATH. ${describePathFix(choice.dir)}`);
  }
  return 0;
}

/**
 * The instruction has to be one the operator can paste into the shell they are
 * actually in. `export` is meaningless in PowerShell, and the separator between
 * PATH entries is not `:` everywhere.
 */
function describePathFix(dir: string): string {
  if (process.platform === "win32") {
    return [
      "Add it for this session:",
      `  $env:PATH = "${dir}${delimiter}$env:PATH"`,
      "or permanently, for your user only:",
      `  setx PATH "${dir}${delimiter}%PATH%"`,
    ].join("\n");
  }
  return ["Add this to your shell profile:", `  export PATH="${dir}${delimiter}$PATH"`].join("\n");
}

async function runUnlink(dir: string, yes: boolean, write: Write): Promise<number> {
  const plan = await planUnlink(dir);

  if (plan.action === "absent") {
    write(`Nothing to remove: ${plan.target} does not exist.`);
    return 0;
  }
  if (plan.action === "foreign") {
    write(`${plan.target}: ${plan.reason}. Leaving it alone.`);
    return 1;
  }

  write(`Will remove ${plan.target} → ${plan.current}`);
  if (!yes) {
    write("");
    write("Nothing has been removed. Re-run with --yes to do it.");
    return 0;
  }

  await applyUnlink(plan);
  write("");
  write("Removed.");
  return 0;
}

/**
 * `skills install`: with --claude-code, install this binary's lead guides
 * in the user's Claude Code skills directory. Without it, retain the older
 * repository-local Agent Skills entry and optional managed AGENTS.md block.
 * Both paths preview by default, write only with --yes, and refuse files
 * they do not own.
 */
/** The skills subcommands and their EXACT flag vocabularies — consulted
 * by the parser above and compared verbatim by the command guide's tests
 * (arc-5 review, finding 5). */
export const SKILLS_ACTIONS = ["install", "list", "get"] as const;
export const SKILLS_FLAGS = {
  install: { json: "flag", yes: "flag", "claude-code": "flag", dir: "value", "write-context": "flag", repo: "value" },
  list: { json: "flag" },
  get: { json: "flag" },
} as const;

function runSkillsCommand(argv: readonly string[], write: Write): number {
  const json = argv.includes("--json");
  const action = argv.find(argument => !argument.startsWith("-"));
  const usage = (message: string): number => {
    write(json ? envelopeJson({ ok: false, command: action === undefined ? "skills" : `skills ${action}`, reason: "usage", message }) : message);
    return USAGE_EXIT;
  };
  if (action === undefined || !(SKILLS_ACTIONS as readonly string[]).includes(action)) {
    return usage("`toolroll skills install --claude-code [--dir <path>] [--yes]` · `skills install [--repo <path>] [--write-context] [--yes]` · `skills list` · `skills get <name>` — all take --json");
  }

  // Exact per-action vocabularies (arc-5 review, finding 5): an unknown
  // flag, a flagless --repo, or a stray positional is a usage refusal
  // here, never a silent ignore.
  const allowed = SKILLS_FLAGS[action as keyof typeof SKILLS_FLAGS];
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] as string;
    if (!argument.startsWith("-")) {
      positionals.push(argument);
      continue;
    }
    const name = argument.replace(/^--?/, "");
    if (name === "h" || name === "help") return usage(`\`toolroll skills ${action}\` — flags: ${Object.keys(allowed).map(one => `--${one}`).join(" ")}`);
    const arity = allowed[name as keyof typeof allowed] as "value" | "flag" | undefined;
    if (arity === undefined) return usage(`unknown option --${name} for \`skills ${action}\``);
    if (arity === "value") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) return usage(`--${name} needs a value`);
      index += 1;
    }
  }

  if (action === "list") {
    if (positionals.length > 1) return usage("`skills list` takes no arguments");
    if (json) {
      write(envelopeJson({ ok: true, command: "skills list", guides: GUIDES.map(one => ({ name: one.name, title: one.title, oneLiner: one.oneLiner })) }));
      return 0;
    }
    write("Guides this exact binary serves — `toolroll skills get <name>`:");
    for (const guide of GUIDES) write(`  ${guide.name.padEnd(14)} ${guide.oneLiner}`);
    return 0;
  }

  if (action === "get") {
    const name = positionals[1];
    if (name === undefined || positionals.length > 2) return usage("`toolroll skills get <name>` — one guide name from `skills list`");
    const guide = guideNamed(name);
    if (guide === null) {
      // The command was valid and the named guide is absent: exit 3, the
      // answer is no — same shape as an unknown task or template.
      write(json
        ? envelopeJson({ ok: false, command: "skills get", reason: "unknown-skill", message: `no guide named ${name} — the guides are: ${GUIDES.map(one => one.name).join(", ")}` })
        : `no guide named ${name} — the guides are: ${GUIDES.map(one => one.name).join(", ")}`);
      return 3;
    }
    if (json) {
      write(envelopeJson({ ok: true, command: "skills get", name: guide.name, title: guide.title, content: guide.content }));
      return 0;
    }
    // Raw markdown alone — an agent pipes or reads it; no banner.
    write(guide.content);
    return 0;
  }

  // install
  const claudeCode = argv.includes("--claude-code");
  const confirmed = argv.includes("--yes");
  if (positionals.length > 1) return usage("`skills install` takes no arguments beyond its flags");

  if (claudeCode) {
    if (argv.includes("--repo") || argv.includes("--write-context")) {
      return usage("--claude-code uses --dir, not --repo or --write-context");
    }
    const dirAt = argv.indexOf("--dir");
    const directory = dirAt === -1
      ? defaultClaudeCodeSkillDir()
      : resolve(argv[dirAt + 1] as string);
    const plan = planClaudeCodeInstall(directory);
    if (!confirmed) {
      const blocked = plan.files.some(file => file.action === "refuse-foreign");
      const message = blocked
        ? "Nothing was written. Move the existing file you want to keep, or choose another --dir."
        : "Nothing was written. Re-run with --yes to install the Claude Code skill.";
      if (json) {
        write(envelopeJson({
          ok: false,
          command: "skills install",
          reason: "unconfirmed",
          message,
          plan,
        }));
        return 3;
      }
      write(`Would install the Claude Code skill in ${plan.directory}:`);
      for (const file of plan.files) {
        const action = file.action === "refuse-foreign"
          ? "REFUSED — this file was not written by the installer"
          : file.action;
        write(`  ${file.path}  (${action})`);
      }
      for (const path of plan.legacyFiles) write(`  ${path}  (remove — replaced by the new copy)`);
      write("");
      write(message);
      return 3;
    }

    const result = applyClaudeCodeInstall(directory);
    if (!result.ok) {
      write(json
        ? envelopeJson({ ok: false, command: "skills install", reason: result.reason, message: result.message, plan: result.plan })
        : result.message);
      return 1;
    }
    if (json) {
      write(envelopeJson({ ok: true, command: "skills install", target: "claude-code", wrote: result.wrote, plan: result.plan }));
      return 0;
    }
    for (const file of result.wrote) write(`wrote ${file}`);
    for (const path of result.plan.legacyFiles) write(`removed ${path}`);
    write("Claude Code will use the refreshed Toolroll guides in its next session.");
    return 0;
  }

  if (argv.includes("--dir")) return usage("--dir belongs with --claude-code");
  const repoAt = argv.indexOf("--repo");
  const repo = repoAt !== -1 ? resolve(argv[repoAt + 1] as string) : process.cwd();
  const writeContext = argv.includes("--write-context");

  if (!existsSync(join(repo, ".git"))) {
    write(json ? envelopeJson({ ok: false, command: "skills install", reason: "not-a-repo", message: `${repo} has no .git — name the repository with --repo` }) : `${repo} has no .git — name the repository with --repo`);
    return USAGE_EXIT;
  }

  const plan = planInstall(repo, writeContext);
  if (!confirmed) {
    if (json) {
      write(envelopeJson({ ok: false, command: "skills install", reason: "unconfirmed", plan }));
      return 3;
    }
    write(`Would write, exactly:`);
    write(`  ${plan.skillPath}  (${plan.skillAction === "refuse-foreign" ? "REFUSED — a skill this installer did not write is already there" : plan.skillAction})`);
    if (plan.legacySkillPath !== null) write(`  ${plan.legacySkillPath}  (remove — replaced by the new copy)`);
    if (plan.contextPath !== null) {
      write(`  ${plan.contextPath}  (${plan.contextAction} — only the marked block is ever touched)`);
    } else {
      write(`  AGENTS.md untouched — add --write-context to install the managed block, or paste it yourself:`);
      write("");
      for (const line of contextBlock().split("\n")) write(`  ${line}`);
    }
    write("");
    write("Nothing was written. Re-run with --yes to apply.");
    return 3;
  }

  const result = applyInstall(repo, writeContext);
  if (!result.ok) {
    write(json ? envelopeJson({ ok: false, command: "skills install", reason: result.reason, message: result.message }) : result.message);
    return 1;
  }
  if (json) {
    write(envelopeJson({ ok: true, command: "skills install", wrote: result.wrote, plan: result.plan }));
    return 0;
  }
  for (const file of result.wrote) write(`wrote ${file}`);
  if (result.plan.legacySkillPath !== null) write(`removed ${result.plan.legacySkillPath}`);
  write("Agents that read Agent Skills (claude, codex, gemini, opencode) will discover the queue on their next session here.");
  return 0;
}

/**
 * `toolroll demo` (adoption track, step 4): a seeded throwaway
 * sandbox served on localhost — ninety seconds from npx to seeing the
 * product mid-flight. Everything under one temp directory; the database
 * is stamped `demo` before any row exists, so every spending or
 * external-effect command fails closed on it forever, kept or not. The
 * throwaway password prints to the terminal and to a 0600 file in the
 * sandbox — never into the --json envelope.
 */
async function runDemoCommand(argv: readonly string[], write: Write): Promise<number> {
  const json = argv.includes("--json");
  const keep = argv.includes("--keep");
  const portIndex = argv.indexOf("--port");
  const portGiven = portIndex === -1 ? "0" : (argv[portIndex + 1] ?? "");
  const port = Number(portGiven);
  const DEMO_USAGE = "`toolroll demo [--port <n>] [--host <addr>] [--allow-host name:port,…] [--keep]` — the port is a number under 65536; absent, a free one is picked";
  // Asking how it works never starts a sandbox.
  if (argv.includes("--help") || argv.includes("-h")) {
    write(json ? envelopeJson({ ok: true, command: "demo", usage: DEMO_USAGE }) : `${DEMO_USAGE}\n\nA throwaway sandbox: a scripted lead in Chat, sample projects and flows mid-flight. It never calls a model, spends or reaches outside; Ctrl-C removes it unless --keep.`);
    return 0;
  }
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    write(json ? envelopeJson({ ok: false, command: "demo", reason: "usage", message: DEMO_USAGE }) : DEMO_USAGE);
    return 2;
  }
  // Reachability, same flags as `serve`: --host binds beyond localhost
  // (a tailnet, a LAN), and --allow-host names the Host headers the
  // console will answer to there — a bind on 0.0.0.0 alone still refuses
  // any name it was not told. Nothing here loosens the demo fence: the
  // database stays stamped, spend stays refused.
  const hostIndex = argv.indexOf("--host");
  const host = hostIndex === -1 ? "127.0.0.1" : (argv[hostIndex + 1] ?? "");
  const allowIndex = argv.indexOf("--allow-host");
  const allowedHosts =
    allowIndex === -1 ? [] : (argv[allowIndex + 1] ?? "").split(",").map(one => one.trim()).filter(one => one !== "");
  if (host === "" || host.startsWith("--") || (allowIndex !== -1 && allowedHosts.length === 0)) {
    write(json ? envelopeJson({ ok: false, command: "demo", reason: "usage", message: DEMO_USAGE }) : DEMO_USAGE);
    return 2;
  }

  const { createDemoSandbox } = await import("./demo.js");
  const { createDecisionServer } = await import("./serve.js");
  const now = new Date();
  const { sandbox, store, seed, evidenceRoot, passwordFile, lead } = createDemoSandbox(now);
  const server = createDecisionServer({
    store, evidenceRoot, clock: () => new Date(), repos: seed.repos, demoLead: lead,
    ...(allowedHosts.length === 0 ? {} : { allowedHosts }),
  });
  await new Promise<void>((ready, failed) => {
    server.once("error", failed);
    server.listen(port, host, ready);
  });
  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;
  // The greeting names a road that will actually answer: the first allowed
  // name when one was given, else the loopback.
  const url = allowedHosts.length > 0 ? `http://${allowedHosts[0]}` : `http://127.0.0.1:${boundPort}`;

  if (json) {
    // The password is deliberately NOT here (adoption review, finding 9):
    // envelopes land in logs. It lives in the 0600 file and on the TTY.
    write(envelopeJson({ ok: true, command: "demo", url, sandbox, login: { name: seed.login.name, passwordFile }, keep }));
  } else {
    write("Demo sandbox is up. A scripted lead answers Chat: no model, no key, no spend, nothing leaves this machine.");
    write("");
    write(`  open      ${url}`);
    write(`  login     ${seed.login.name} / ${seed.login.password}`);
    write(`  sandbox   ${sandbox}`);
    write("");
    write("Open Chat and ask for a change, like \"fix the flaky refund test\".");
    write("For your own project, run `npx toolroll up` in its folder.");
    write("");
    write(
      keep
        ? "Ctrl-C stops the server; the sandbox is KEPT. It stays a demo forever — every spending command refuses it."
        : "Ctrl-C stops the server and deletes the sandbox. --keep preserves it (still fenced from spending).",
    );
  }

  await new Promise<void>(done => {
    const stop = (): void => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      done();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  lead.stop();
  await new Promise<void>(closed => server.close(() => closed()));
  store.close();
  if (!keep) {
    const { rmSync } = await import("node:fs");
    rmSync(sandbox, { recursive: true, force: true });
    if (!json) write("Sandbox deleted.");
  } else if (!json) {
    write(`Sandbox kept at ${sandbox} — reopen it any time: toolroll serve --db ${join(sandbox, "orders.db")}`);
    write("Ready for your own repository? `toolroll up --repo <path>` starts the real thing.");
  }
  return 0;
}

/**
 * `contract` is the machine contract, stated by the machine: the envelope
 * version and the capability tokens an agent consumer can feature-detect on.
 * Behaviors, not versions — consumers ignore tokens they do not recognize.
 */
/** contract's EXACT flags — consulted below and compared by the command
 * guide's tests (arc-5 review, finding 5). */
export const CONTRACT_FLAGS = ["json", "commands"] as const;

function runContractCommand(argv: readonly string[], write: Write): number {
  const json = argv.includes("--json");
  // Exact parsing (arc-5 review, finding 5): unknown flags and stray
  // positionals refuse instead of being silently ignored.
  for (const argument of argv) {
    const bad = (message: string): number => {
      write(json ? envelopeJson({ ok: false, command: "contract", reason: "usage", message }) : message);
      return USAGE_EXIT;
    };
    if (!argument.startsWith("-")) return bad(`\`toolroll contract\` takes no arguments — flags: ${CONTRACT_FLAGS.map(one => `--${one}`).join(" ")}`);
    const name = argument.replace(/^--?/, "");
    if (name === "h" || name === "help") return bad(`\`toolroll contract [--commands] [--json]\``);
    if (!(CONTRACT_FLAGS as readonly string[]).includes(name)) return bad(`unknown option ${argument} for \`contract\``);
  }
  const commands = argv.includes("--commands");

  if (commands) {
    if (json) {
      write(envelopeJson({
        ok: true,
        command: "contract",
        schemaVersion: SURFACE_SCHEMA_VERSION,
        notes: SURFACE_NOTES,
        commands: COMMAND_GUIDE,
      }));
      return 0;
    }
    write(`toolroll declared command guide — schema v${SURFACE_SCHEMA_VERSION}`);
    write("");
    write(`authority: ${SURFACE_NOTES.authority}`);
    write(`flags: ${SURFACE_NOTES.flags}`);
    write(`reasons: ${SURFACE_NOTES.reasons}`);
    write("");
    const agentRows = COMMAND_GUIDE.filter(row => row.agentMayInvoke);
    const operatorRows = COMMAND_GUIDE.filter(row => !row.agentMayInvoke);
    write("Agent surface:");
    for (const row of agentRows) {
      const name = row.invocation === "" ? "(no verb)" : row.invocation;
      write(`  ${name.padEnd(18)} ${row.synopsis}  [${row.mutation}]`);
      for (const flag of row.flags ?? []) {
        write(`      --${flag.name}${flag.takesValue ? " <value>" : ""}  ${flag.meaning}`);
      }
      if (row.notableReasons !== undefined && row.notableReasons.length > 0) {
        write(`      reasons: ${row.notableReasons.join(", ")}`);
      }
    }
    write("");
    write("Operator ceremonies and infrastructure — an agent must not invoke");
    write("these, even when credentials are within reach; the credential IS the");
    write("person:");
    for (const row of operatorRows) write(`  ${row.invocation.padEnd(18)} ${row.synopsis}`);
    return 0;
  }

  if (json) {
    write(envelopeJson({ ok: true, command: "contract", capabilities: [...CAPABILITIES] }));
    return 0;
  }
  write(`toolroll machine contract — envelope v${ENVELOPE_VERSION}`);
  write("");
  write("Every --json answer is one envelope on stdout: { envelopeVersion, ok,");
  write("command, ... } — failures add a stable `reason` token and a human");
  write("`message`. Consumers must ignore keys and capabilities they do not");
  write("recognize.");
  write("");
  write("Capabilities:");
  for (const capability of CAPABILITIES) write(`  ${capability}`);
  write("");
  write("`contract --commands` dumps the declared command guide.");
  return 0;
}

/**
 * The machine-readable envelope. Remote state is folded into each repository
 * rather than sitting in a parallel map, so a consumer never has to join two
 * collections to answer "what is happening in this repo" — and `remoteRead`
 * says whether the absence of pull requests means none or means we did not ask.
 */
function renderJson(
  repos: readonly RepoSnapshot[],
  roots: readonly string[],
  missingRoots: readonly string[],
  now: Date,
  remote?: RemoteMap,
): string {
  const withRemote = repos.map(repo => {
    const state = remote?.get(repo.path);
    return {
      ...repo,
      pulls: state?.pulls ?? [],
      issues: state?.issues ?? [],
      // Per repository, not only at the top level. An empty `pulls` means
      // three different things — none open, not asked, or asked and failed —
      // and a consumer should not have to join two parts of the envelope to
      // find out which.
      pullsRead: state?.pullsRead ?? false,
      issuesRead: state?.issuesRead ?? false,
      remoteSkipped: state?.skipped ?? false,
      remoteProblems: state?.problems ?? [],
    };
  });

  return envelopeJson({
    ok: true,
    command: "scan",
    scannedAt: now.toISOString(),
    roots,
    missingRoots,
    remoteRead: remote !== undefined,
    repos: withRemote,
  });
}

/**
 * Whether this module is the program being run, rather than an import.
 *
 * Node resolves a module to its real path while argv[1] keeps whatever name it
 * was invoked by, so a symlinked `toolroll` on PATH compares unequal to
 * itself unless both sides are resolved. Getting this wrong is silent: the
 * command runs, prints nothing, and exits 0.
 */
export function isDirectInvocation(
  moduleUrl: string,
  entry: string | undefined,
  toRealPath: (path: string) => string = realpathSync,
): boolean {
  if (entry === undefined) return false;
  try {
    return moduleUrl === pathToFileURL(toRealPath(entry)).href;
  } catch {
    return false;
  }
}

/**
 * Node prints `ExperimentalWarning: SQLite is an experimental feature` to
 * stderr the first time the store is opened. One line is fair warning; one
 * line per invocation, in a dispatch loop that runs the command thousands of
 * times overnight, is a log nobody can read.
 *
 * It is filtered here and nowhere else. This runs only when the CLI is the
 * program — a process it legitimately owns — so importing any of these modules
 * as a library still leaves the host's warnings exactly as they were. The
 * mechanism matters too: wrapping `process.emitWarning`, which is what Node's
 * own experimental notice goes through, leaves every `warning` listener anyone
 * else registered working normally. An earlier attempt swapped the listeners
 * themselves and quietly made everybody's `once` permanent.
 */
function hushExperimentalSqlite(): void {
  const original = process.emitWarning.bind(process);
  process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
    const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string })?.type;
    const text = warning instanceof Error ? warning.message : String(warning);
    if (type === "ExperimentalWarning" && text.includes("SQLite")) return;
    (original as (...args: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}

/** The process entry the bin calls: the SQLite notice hushed, the exit code set. */
export async function runCliProcess(argv: readonly string[]): Promise<void> {
  hushExperimentalSqlite();
  process.exitCode = await main(argv);
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  hushExperimentalSqlite();
  main(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  });
}
