/**
 * The top-level usage text, on its own so `toolroll --help` can print it
 * without loading every command family (see cli-fast.ts).
 */

import { DEFAULT_MAX_DEPTH } from "./scan.js";

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
  toolroll release <branch> release Toolroll itself: gate, your approval, deploy, merge, tag, publish
                                   (resumable: rerun to continue; --help)
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
  toolroll lead token       mint your lead agent's credential: its own work pings nobody
  toolroll lead say "<text>"  (the lead) one short message in its person's chat

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
  toolroll heartbeat <lease> / worker release <lease> / reap
  toolroll tick --runner <name> --token <t> --repo <path>
                               one unattended pass over the ready set
  toolroll flows list | show <id> | create | edit | trigger | script | card | archive
                               set up and inspect flows (writes preview until --yes)
  toolroll chat --as <you> --token <t>
                               talk to your lead: one conversation across every
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
