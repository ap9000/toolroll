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
  warning on every answer, and is refused from 0.10.0.
- **The agent fence.** Standing Orders' own secrets (the state folder beside
  the database, except the build's worktree, and `~/.toolroll`) are
  denied to agents by the operating system: Codex through its own sandbox on
  every platform; Claude, Gemini and ACP agents, and every command and check,
  through Anthropic's sandbox-runtime (`@anthropic-ai/sandbox-runtime` 0.0.79:
  Seatbelt on macOS, bubblewrap with its seccomp filter on Linux). Where it can't
  run (Windows, or Linux without bubblewrap, socat or ripgrep) a build doesn't
  start, unless an instance operator
  allows unconfined agents (`config unconfined-agents allow`; each such run
  says "Not confined"). The README's "What an agent can reach" has the table.
- **A build writes only its workspace.** Each scope seals where its build may
  write (`project writes`, default `workspace`): its checkout and commit data,
  the project's package caches, its temp folder and its agent's session files.
  The operator's shell profile, login items, agent settings and the
  repository's Git config, hooks and info are read-only to it, enforced by the
  same sandbox (the sandbox-runtime, Codex's profile); `anywhere` is an
  approver's explicit choice. Setup and check commands run in the build's
  fence. Toolroll's own Git on a build's checkout skips hooks, fsmonitor and
  submodules and refuses config that names a command; tool servers never run
  from what a build wrote.
- **The network a build reaches is approved with it.** Each scope seals its
  network: the agent's provider, the package registries the project uses, and
  hosts an approver added (`project network --allow`), or `open`. The
  operating system enforces it: on macOS the sandbox refuses every outbound
  connection but the run's own proxy (direct connections, UDP, name lookups,
  and asking another service to fetch, like `open https://…`); on Linux the
  build gets a network of its own, reaching the proxy by a bridge, with the
  machine's D-Bus, container and display sockets out of reach. The proxy
  admits only the approved hosts, on ports 443 and 80, to public addresses,
  and only for that run. A result shows what its proxy connected to and
  refused.
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
- **Secrets stay out of the database, URLs and logs,** in 0600 files. Project
  tool secrets, the Linear key, Google mail tokens and flow webhook secrets
  rest in the OS keychain, sealed with a key the fence denies,
  and a service connected by signing in gives each run only a short-lived
  access token, never its refresh token. See the README's "How build
  sessions are protected".
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

- Programs you run yourself, outside the fence, can read what you can:
  Toolroll's folder and your keychain included.
- In API-key mode, an agent's own provider key is in its environment.
  Subscription mode (the default) puts no key there.
- **Full access** lets an agent change files anywhere on your computer
  outside the fence. Use it only for repositories you trust.
- The console serves plain HTTP. Keep it on localhost or a private network
  such as Tailscale; don't expose it to the internet.
- The network rule restricts where a build connects, not what it sends
  there: the proxy never decrypts TLS, so an approved host (a registry, the
  provider) receives whatever the build sends it.
- On a Mac a build reaches no local service but its own proxy and tools. A
  project that needs local test servers sets `project network --local any`,
  which admits every local service on that Mac (the macOS sandbox can't admit
  some local ports and refuse others). Linux builds always have a loopback of
  their own.
- On a Mac, a build's agent can reach the keychain's services (securityd):
  Claude Code signs in from the keychain. The sandbox runtime allows that to
  every sandboxed process (anthropics/sandbox-runtime#755), so a build's
  agent can read any keychain item, the login keychain's included, whose
  access list lets any program read it; items that ask, or that name their
  programs, stay closed. Toolroll denies those services to everything else
  it sandboxes: a build's setup and check commands, a project's checks,
  flows and tool servers. A check a project gave **sign-ins** keeps them
  (Claude Code's sign-in is there), and so reaches those keychain items too,
  not only the sign-ins; the sign-ins warning says so. Only while that level
  stands as an instance operator set it, with their password typed then.
- Every sandboxed launch on a Mac can open terminals of its own and no
  other, can't type into a terminal (TIOCSTI), and starts in a session of
  its own, so it has no terminal of whoever started Toolroll. A program
  started on a terminal made for it (a live terminal, a coding session)
  keeps that one. A project that denies `/dev` or its terminal devices by
  name in its read-deny list gets no terminal of its own either.
- Codex's command sandbox can't use a proxy: its commands are offline unless
  the project's network is `open` and the build has Full access.
- A project's tool servers keep their own network reach (they hold the
  tool's secrets, not the agent's code).
- Approvals sealed before network rules run with the narrow default: the
  provider and the project's registries, no local services.
