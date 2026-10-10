# Security

## Reporting a vulnerability

Please report security problems privately, not in a public issue: use
**Report a vulnerability** on the repository's Security tab (GitHub private
vulnerability reporting). Include what you found, how to reproduce it, and
the version or commit. You'll get an acknowledgement within a few days.

Only the latest release is supported with security fixes.

## Security model in brief

Standing Orders runs AI coding agents on your own computer, as your own
user. What it promises:

- **No agent approves its own work.** Approvals need your password on a
  screen that restates the exact terms, and the agent fence keeps your
  remembered login, runner tokens and the database out of agents' reach.
- **Tokens, not passwords, on requests.** Scripts, the remote CLI and MCP sign
  in with an API token (`toolroll tokens create`): it reads or acts, can be
  limited to projects, expires, and only its hash is kept. A password sent on a
  request (`Bearer name:password`) still works this release, with a deprecation
  warning on every answer, and is refused from 0.9.59.
- **The agent fence.** Standing Orders' own secrets (the state folder beside
  the database, except the build's worktree, and `~/.toolroll`) are
  denied to agents by the operating system: Codex through its own sandbox on
  every platform; Claude and Gemini through a sandbox on macOS. On Linux and
  Windows, Claude's file tools are fenced but its shell is not yet, and Gemini
  is not fenced. The README's "What an agent can reach" has the full table.
- **Separation of duties, per project** (Settings → Approval rules, or
  `project rules`). Every task records who filed it. A project can refuse
  the requester's own approval, and can mark the whole project or chosen
  paths as protected: protected work needs two different people to approve
  the same exact scope, and an operating mode, a routine or an AI teammate
  can never decide it. The requester is whoever filed the task (or the
  task it revises), made the standing order, or wrote the scope being
  approved. A task's declared paths are checked at approval, and its actual
  diff again at completion: a result that changed protected files on a
  one-person approval completes only by someone else. Only an instance
  operator changes the rules, with a step-up, and the action ledger keeps
  every change and every approval.
- **An audit trail you can check.** Every action ledger entry is sealed
  with a hash of the entry before it, and `toolroll ledger verify`
  (or the ledger page) walks the chain and names the first entry that was
  changed, removed or added. What that proves: history before a
  checkpoint you copied off the machine wasn't touched (an instance
  operator makes one with `ledger checkpoint` or **Make a checkpoint**;
  `ledger verify --checkpoint <it>` checks it), and, while the console
  runs, that a change to history it already checked is noticed within ten
  minutes (at once by `ledger verify`). Each task has an
  evidence pack (the task page's **Evidence pack**, or `task evidence`):
  who filed it, the approved terms and approvers, the rules in force, the
  agents and their cost, the changed files, the checks, completion and
  publication, and its ledger entries with their seals.
- **Monitoring sends only what it says** (Settings → Monitoring). The audit
  stream carries ledger entries (who, what, when, the project and task, a
  short detail line; never a secret, prompt or body) to the webhook or folder
  an instance operator sets, each webhook request signed. Traces carry run
  timings, model, tokens and cost, never a prompt, diff or file. The signing
  secret and a collector's header value live in `monitoring.json` (0600,
  fenced from agents), never in the database or the ledger; `/metrics` needs
  an instance operator. Addresses are https (http only to this machine).
- **Secrets stay out of the database, URLs and logs,** in 0600 files.
- **Reviews** run with no tools, confined to their sealed files.

Known limits:

- The chain has no secret key. Someone who can edit the database file can
  rewrite history after the last checkpoint kept off the machine, and the
  next pass reseals it for them; checkpoints kept in the same database
  don't stop that. Copy checkpoints off the machine (streaming them out is
  the next release). Times are as written: an entry added later with an
  earlier time isn't caught.
- Approval rules bind the people the console knows about. Tasks filed from
  the command line or before schema 102 name no filer, and turning a rule on
  doesn't withdraw approvals already given.

- In API-key mode, an agent's own provider key is in its environment.
  Subscription mode (the default) puts no key there.
- **Full access** lets an agent change files anywhere on your computer
  outside the fence. Use it only for repositories you trust.
- The console serves plain HTTP. Keep it on localhost or a private network
  such as Tailscale; don't expose it to the internet.
