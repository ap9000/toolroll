/**
 * The top-level usage text, on its own so `toolroll --help` can print it
 * without loading every command family (see cli-fast.ts).
 */

import { DEFAULT_MAX_DEPTH } from "./scan.js";

export const HELP = `toolroll — hand coding work to agents, walk away, come back to pull requests

Usage
  toolroll                  at your terminal: start Toolroll here (or attach) and open it in the terminal
                                   (--web: the browser; --project-root <dir>: where projects live)
                                   in a repository without a terminal, under an agent or with --json: only says what it would do
  toolroll open [--web]     open this computer's Toolroll again, signed in
  toolroll welcome          the three steps to a first result (--json: the model)
  toolroll password set     add a password (typed twice, at your terminal)
  toolroll scan [path...]   report what is in flight (also bare \`toolroll\` outside a repository)
  toolroll [path...]        the same report for the paths given
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
  toolroll release <branch> release Toolroll itself: checks, your approval, deploy, merge, tag, publish
                                   (rerun the same command to continue; --help)
  toolroll skills install --claude-code [--dir <path>]
                                   install this binary's guides for Claude Code (preview first)
  toolroll skills install   teach a repo's agents this queue exists (preview first)
  toolroll demo             a seeded throwaway sandbox — see it working in 90 seconds
  toolroll up               app + builder for every saved project — the normal start
  toolroll onboard          make your agent Toolroll's lead: add this repo, install its skill (--yes), offer starter flows (--starter)
  toolroll status           running, queued, ready results, release check and plan windows
  toolroll integrations     which integrations work, and what to do about the ones that don't (--json)
  toolroll lead token       mint your lead agent's sign-in: its own work pings nobody
  toolroll lead say "<text>"  (the lead) one short message in its person's chat

Tasks — \`toolroll task\` prints the whole list,
and any task command + --help prints it too
  toolroll approver add <name>
                               add a person who can approve work
  toolroll task add <title> queue work
  toolroll task show <id>   one task: its plan, builds and what it waits for
  toolroll task approve <id>
                               the yes — nothing builds without one
  toolroll task accept <id> --finish
                               accept the result you read (--despite "<why>": accept it with a reason, without finishing)
  toolroll chat --as <you> --token <t>
                               talk to your lead: one conversation across every
                               project; it proposes, you confirm (--say "…" for one turn)
  toolroll flows list | show <id> | create | edit | trigger | script | card | archive
                               set up and inspect flows (writes preview until --yes)

Machine and agent commands (the builder, agent tools, recovery):
  toolroll internals        lists them; each keeps working as before

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


/** The commands people rarely type: the builder's own loop, the machine contract and recovery. They all keep working;
 * `toolroll internals` (or `toolroll internals --help`) lists them so top-level help stays about the work. */
export const INTERNALS_HELP = `toolroll internals — machine and agent commands

  toolroll contract         the machine contract: envelope version + capabilities
                                   (--commands dumps the declared command guide)
  toolroll skills list      the guides this exact binary serves
  toolroll skills get <name>  print one guide (version-matched, never stale)
  toolroll health           recent server latency, write waits and live streams
  toolroll ready            what could be started right now
  toolroll check-progress <run>  current or final approved check progress
  toolroll task wait <id> [--timeout <seconds>]
                               wait for this attempt to finish or need a person
  toolroll task scope <id> --goal <text>
                               write a task's plan from the command line
  toolroll claim <id> --runner <name>
  toolroll heartbeat <lease> / worker release <lease> / reap
  toolroll tick --runner <name> --token <t> --repo <path>
                               one unattended pass over the ready set
  toolroll serve --repo <path>  run only the console
                               (--editor vscode with --runner: file links
                               open in VS Code on the device you browse from)
  toolroll watch / daemon install   run only the builder
  toolroll doctor           check that Toolroll's service holds no key a build could read
  toolroll reconcile        recover what the last stretch left behind
  toolroll release <branch> --recover-deploy | --release-gate
                               the release tool's recovery steps (toolroll release <branch> runs them for you)`;
