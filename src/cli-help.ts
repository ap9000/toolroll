/**
 * The top-level usage text, on its own so `toolroll --help` can print it
 * without loading every command family (see cli-fast.ts).
 */

import { DEFAULT_MAX_DEPTH } from "./scan.js";

export const HELP = `toolroll — hand coding work to agents, approve each plan, accept what comes back Ready

  toolroll                      start Toolroll here and open it in this terminal (--web: in the browser)
                                In it: n new task · a approve its plan · c accept a Ready result
                                       b send it back · Enter open a task · ? every key
  toolroll repos add <folder>   add a project (in a repository, \`toolroll\` adds that one)
  toolroll demo                 try it first: sample tasks, no model calls, no cost
  toolroll update               update to the latest release (shows what changes first)

  toolroll task add "<what should change>"   add a task from a shell; approve its plan in Toolroll
  toolroll task show <id>                    where a task is, and its result once it's Ready

More: toolroll task --help (every task command) · toolroll internals (everything else)`;

/** The scan's own usage: \`toolroll scan --help\`. Bare \`toolroll\` outside a repository, and \`toolroll <path...>\`, scan too. */
export const SCAN_HELP = `toolroll scan [path...] — report what is in flight below a folder

  toolroll scan [path...]   report what is in flight (also bare \`toolroll\` outside a repository)
  toolroll [path...]        the same report for the paths given

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
where listing branches takes milliseconds.`;

/** The commands people rarely type: the builder's own loop, the machine contract and recovery. They all keep working;
 * `toolroll internals` (or `toolroll internals --help`) lists them so top-level help stays about the work. */
export const INTERNALS_HELP = `toolroll internals — every other command (each keeps working as before)

Starting and running
  toolroll up               app + builder for every saved project, for a server or a phone (--laptop: what bare \`toolroll\` runs)
  toolroll open [--web]     open this computer's Toolroll again, signed in (bare \`toolroll\` does the same)
  toolroll welcome          the three steps to a first result (--json: the model)
  toolroll onboard          make your agent Toolroll's lead: add this repo, install its skill (--yes), offer starter flows (--starter)
  toolroll background on|off|show
                               keep this computer's Toolroll running when you log in
  toolroll stop             stop this computer's Toolroll once its running work is saved
  toolroll password set     add a password (typed twice, at your terminal)
  toolroll link             put \`toolroll\` on your PATH
  toolroll unlink           take it off again
                               (link shows what it would do and changes nothing; add --yes to apply it,
                               or --to <dir> to choose where. It never uses sudo, never leaves your
                               home directory, and never touches a file it did not create.)

Reports
  toolroll scan [path...]   report what is in flight (\`toolroll scan --help\`: its options)
  toolroll status           running, queued, ready results, release check and plan windows
  toolroll pulls            report what is waiting on a person
  toolroll graph            report which work graph is already here
  toolroll integrations     which integrations work, and what to do about the ones that don't (--json)

Projects
  toolroll repos            list connected repositories, and how to adjust
  toolroll repos remove <path>
                               take it out of the console; its tasks and results stay
  toolroll repos add-from-github <owner/name> --root <dir>
                               preview, then clone and connect (--yes)

Chat and the lead
  toolroll chat --as <you> --token <t>
                               talk to your lead: one conversation across every
                               project; it proposes, you confirm (--say "…" for one turn)
  toolroll lead token       mint your lead agent's sign-in: its own work pings nobody
  toolroll lead say "<text>"  (the lead) one short message in its person's chat
  toolroll card <source>    the data chat shows as a card: tasks, results, flows, spend,
                               projects, builders, mode, integrations, providers, findings, handover
  toolroll flows list | show <id> | create | edit | trigger | script | card | archive
                               set up and inspect flows (writes preview until --yes)

People
  toolroll approver add <name>
                               add a person who can approve work

Tasks (\`toolroll task --help\` lists every task command)
  toolroll task approve <id>
                               the yes — nothing builds without one
  toolroll task accept <id> --finish
                               accept the result you read (--despite "<why>": accept it with a reason, without finishing)
  toolroll task send-back <id> --feedback "<what to change>"
                               send the result back for changes
  toolroll task retry <id>  build it again
  toolroll task ready <id>  can I merge it? each check, and what clears a blocker
  toolroll task wait <id> [--timeout <seconds>]
                               wait for this attempt to finish or need a person
  toolroll task scope <id> --goal <text>
                               write a task's plan from the command line

Agent guides
  toolroll skills install --claude-code [--dir <path>]
                               install this binary's guides for Claude Code (preview first)
  toolroll skills install   teach a repo's agents this queue exists (preview first)
  toolroll skills list      the guides this exact binary serves
  toolroll skills get <name>  print one guide (version-matched, never stale)
  toolroll contract         the machine contract: envelope version + capabilities
                               (--commands dumps the declared command guide)

Releasing Toolroll
  toolroll release <branch> release Toolroll itself: checks, your approval, deploy, merge, tag, publish
                               (rerun the same command to continue; --help)
  toolroll release approve  a person's approval for a release
  toolroll release --recover-deploy [--stage <dir>] [--yes]
  toolroll release --release-gate <id> [--yes]
                               the release tool's recovery steps (toolroll release <branch> runs them for you)

Machine
  toolroll health           recent server latency, write waits and live streams
  toolroll ready            what could be started right now
  toolroll check-progress <run>  current or final approved check progress
  toolroll claim <id> --runner <name>
  toolroll heartbeat <lease> / worker release <lease> / reap
  toolroll tick --runner <name> --token <t> --repo <path>
                               one unattended pass over the ready set
  toolroll serve --repo <path>  run only the console
                               (--editor vscode with --runner: file links
                               open in VS Code on the device you browse from)
  toolroll watch / daemon install   run only the builder
  toolroll doctor           check that Toolroll's service holds no key a build could read
  toolroll reconcile        recover what the last stretch left behind`;

