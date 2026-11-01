# Security

## You approve what runs

A task's scope (goal, boundaries, checks, the agent and model) is shown in
full and approved before anything is built, and the approval is bound to
exactly those terms. Results wait for a person to accept them. Releases pass
the project's own check command before they can be deployed.

## Agents can't read Toolroll's secrets

Agents run as your own user, so without a fence they could read your saved
login, keys or the database and approve their own work. The fence closes that
at the operating system.

Every fenced launch (a build's agent, its setup and check commands, a saved
result's checks, a flow's setup and script, a project tool's server) runs inside
[Anthropic's sandbox-runtime](https://github.com/anthropics/sandbox-runtime)
(`@anthropic-ai/sandbox-runtime`, pinned in `package.json`): the same sandbox
Claude Code uses. Its own code writes the macOS Seatbelt profile and the Linux
bubblewrap and seccomp command for each launch; Toolroll only hands it a short
config. `toolroll doctor` and **Settings → Project → Home folder** name the
engine and its version. Codex builds use Codex's own sandbox, given the same
rules.

Each run records how it was fenced. Where the runtime can't run (Windows; Linux
without bubblewrap, socat or ripgrep, or with unprivileged user namespaces off),
a build doesn't start, unless an instance operator runs
`toolroll config unconfined-agents allow`; install the missing tools instead
([Linux](linux.md)).

## Builds reach only their approved hosts

Each approved scope seals what its build may reach: the agent's provider, the
package registries the project uses, and hosts an approver adds:

    toolroll project network --repo ~/code/shop --allow api.stripe.com

Every connection goes through the run's own proxy, which admits only those
hosts; the sandbox refuses everything else, name lookups included. On a Mac a
build reaches no local service but its own proxy and tools; if a project's tests
start a local server, `--local any` lets its builds reach every local service on
that Mac. `--open` lifts the rule for a project. New scopes use the setting;
approved ones keep the network they were approved with. A result's **Network**
row shows what the build connected to and what was refused.

## Builds write only their workspace

Each approved scope also seals where its build may write. By default a build
writes only its checkout and commit data, the project's package caches, its temp
folder and its agent's session files; your shell profile, login items, agent
settings and the repository's Git config and hooks stay read-only to it. Its
setup and check commands run in the same fence. A project whose tools must write
elsewhere in your home folder can choose otherwise:

    toolroll project writes --repo ~/code/shop anywhere

or **Settings → Project → Where builds write**. New scopes use the setting;
approved ones keep what they were approved with.

### What an agent can reach

What Toolroll adds to the runtime's config, and nothing else:

- **Toolroll's own folders** are denied to read and write: the state folder
  beside the database (your remembered login `up-login.txt`, runner and
  coordinator tokens, chat bot tokens, the database and its backups, other runs'
  evidence) except the checkout pool, and `~/.toolroll` (stored provider keys and
  project tool secrets); other launches' private folders are unread.
- **The build's own checkout** is writable; **other tasks' checkouts** are read,
  never written (those there when it starts).
- **Your home folder** is readable, as in the runtime. A project hides more with
  **Settings → Project → Home folder**, or
  `toolroll project sandbox --repo <p> --read-deny "~/.ssh,~/.aws"`; each
  approved scope seals that list.
- **The network**: open, or only through the run's own proxy (above).

The runtime's limits are accepted as they are: rules are fixed when a launch
starts; on Linux a deny for a path that isn't there yet is the runtime's to
handle; concurrent builds share the system temp folder; another process's
arguments and environment can be read on macOS; and a folder or checkout made
after a build starts is writable to it unless something above denies it.

| | Auto | Full access |
|---|---|---|
| **Claude, Gemini, ACP agents** | Anthropic's sandbox-runtime (Seatbelt on macOS; bubblewrap and its seccomp filter on Linux, which also needs socat and ripgrep): reads your home folder except the folders the project lists, never Toolroll's folders; other tasks' work read, never written; writes only the checkout, its Git data, the project's caches, the run's temp folder and the agent's own session files (anywhere outside the fence, under a project set to write anywhere), never the runtime's protected names in the checkout (Git hooks and config, shell profiles, `.mcp.json`, editor settings); no Apple Events. Neither (Windows, or a Linux missing one of those): the build doesn't start, unless an instance operator allows unconfined agents | same |
| **Codex / OpenRouter** (any OS) | Codex's own sandbox, given the same fence: reads your home folder except the folders the project lists, never Toolroll's folders; other tasks' work read, never written; writes only the checkout, its Git data and the project's caches (anywhere outside the fence, under a project set to write anywhere); no network | the same reads and writes, with the fence; its commands reach the network only when the project's network is open |

Toolroll's own Git on a build's checkout runs hardened (no hooks, fsmonitor,
submodules or signing), reads none of your global Git config but its plain
values (identity, line endings, a standard git-lfs install), and refuses a
checkout whose config includes a file or names a command; a project's tool
servers can't read the checkout and never run a file the build wrote.

Two limits to know: in **API-key mode** an agent's own provider key is in its
environment, so its shell can read it (subscription mode, the default, puts
no key there); and a project's own tool secrets reach that project's tools.
They stay in a per-run broker outside the fence: the agent gets only its
address and a token that stops working when the run ends. A tool server's own
environment (its secrets among it) is readable to a build on macOS through the
process list, a limit of the sandbox runtime's baseline. Reviews and the lead
chat run with no tools and are confined to their own files. See
[SECURITY.md](../../SECURITY.md).

### How build sessions are protected

A build runs as your own user, so Toolroll keeps the secrets it holds (tool
keys and sign-ins, the Linear key, a Google mail connection, flow webhook
secrets) away from it in layers:

- **The fence.** The operating system denies the build Toolroll's own
  folders, your home configuration and other projects (the table above).
- **The broker.** A run's tools are served by a broker in Toolroll's own
  process, outside the fence. The agent gets only the broker's local address
  and a key for that run, which stops working when the run ends. Another
  run's key opens nothing.
- **The keychain.** At rest, secrets are in the macOS Keychain (through
  `security`, with the value on its input) or the Linux Secret Service (the
  system's `secret-tool`, value on its input). A fenced build can still ask
  the keychain for an item, so each is sealed with a key in `tool-secrets`
  beside Toolroll's database. Toolroll makes that folder when it starts,
  before any build, and records which key it made; a folder, key or link put
  there by anything else is refused. What a build reads is ciphertext.
  Secrets are read only when a run starts. Files from before move into the
  keychain the first time they are used, and the plaintext copy is removed.
  Where there is no keychain, or the keyring doesn't answer, secrets stay in
  owner-only files, and Settings and `toolroll integrations` say so.
- **Short-lived tokens.** A service connected by signing in gives each run
  a fresh access token of its own, made outside the fence when the run starts
  and limited to read access for research steps where the service allows.
  The refresh token never leaves Toolroll, and one renewal runs at a time
  across Toolroll's processes. If a renewed sign-in can't be saved, the run
  doesn't start and every token made for it is revoked. The run's token is
  revoked when the run ends, or runs out on its own where the service has no
  way to revoke it. Keys you paste in stay in the broker. Settings → Tools
  shows which each tool uses.

What remains: any program of yours running outside the fence (not started by
a build) can read what you can, including Toolroll's folder and the keychain.
Toolroll protects your secrets from its builds, not from other software you
run.

## Unattended permissions

**Settings → unattended permissions** chooses the starting policy for new
tasks. **Auto** lets routine repository commands and edits proceed while the
provider may stop on a risky permission request. **Full access** runs Claude
with `--dangerously-skip-permissions`, Codex (and its OpenRouter transport) in
its own sandbox widened to write anywhere with network on, and Gemini with
`--approval-mode yolo`, so permission prompts cannot pause work while you are
away. A Full access agent can change files anywhere on your computer outside
the fence. Use Full access only for repositories and setup commands you trust.

Every new-task and task-scope form has the same two-choice control. A task's
choice is durable through planning rewrites and is sealed into the approved
execution profile; changing the installation default never broadens an
existing scope or approval.

## Sign in with your identity provider

**Settings → Sign-in** (instance operators) connects Toolroll to
your organisation's identity provider: Okta, Microsoft Entra, Google,
Auth0, Keycloak or anything else that speaks OpenID Connect.

1. In the provider, create a web app (OpenID Connect, authorization code)
   and register the redirect address the Sign-in page shows
   (`https://your-address/login/sso/callback`). Have it put the person's
   groups in the ID token (the `groups` claim, or name another).
2. On the Sign-in page, enter the provider's address (its issuer), the
   client ID and secret, and which groups may sign in: each group is an
   Operator or a Viewer, in all projects or chosen ones. A person's first
   matching group decides, and it decides again at every sign-in, so
   moving someone between groups in the provider changes their access here.
   No matching group, no entry. `*` matches everyone.
3. Choose who may still use a password: everyone, or only instance
   operators (a way in if the provider is down).

The client secret is kept in `sign-in.json` beside the database (`0600`),
never in the database. People who sign in with the provider have no
password here: an approval or any other step-up is confirmed with a
**Confirm with …** link that asks the provider to check them again. That
re-check counts for one step-up, within five minutes, and is used up by it even
when that step-up is refused — except approving a plan or sending a chat
message, which give it back when nothing happened. Signing in with the
provider never counts as one. An existing account can be
linked to the provider from the Sign-in page. Every sign-in, account made,
access change and settings change is in the action ledger.

## Your password, remembered for a while

On this computer (a direct connection to `localhost`, never through a proxy or
another address, with no forwarding headers of any kind), a password you
typed — to sign in, or for any step-up — is remembered for **15 minutes** for
two everyday acts only: approving a plan whose terms are standard permissions
with one approver (from the task page or a chat proposal), and sending a chat
message. Leave the password box empty and it's used. (Replying to an agent's
question, steering, pausing and stopping never ask for a password.) The window starts only from a password you typed (or the identity
provider checking you again), is never extended by using it, and ends at sign
out, when the session or your credentials change, or when you press
**Forget** beside "Password remembered" in the sidebar.

Everything else still asks for your password typed now: raised permissions,
protected (two-person) work, plans an agent wrote, merging, publishing,
signing a mode, credentials and secrets, people and access, project
admission, deleting, and resuming or overriding a stopped build. An approval
records how you were checked — "approved by alex (password remembered from
10:42)" — in the task and the action ledger.

The trade-off, plainly: if someone takes over your signed-in session on this
computer within those 15 minutes, they can approve standard-permission work.
Press **Forget** before you step away, or sign out.

## Sessions and API tokens

**Settings → Sessions & tokens** shows where you're signed in (the browser,
the address, when it was last active) and signs out any one of them, or
everywhere else at once. Sessions survive a restart of Toolroll;
only a hash of each session's cookie is kept. Instance operators can see and
end everyone's.

Scripts and CI use an **API token** instead of a password:
`Authorization: Bearer so_…`. A token reads, or acts as its person (files
and manages work), and never approves anything; it expires in 30, 90 or 365
days; it is shown once and only its hash is kept. Each request a token makes
is named in the action ledger. A token outlives a password change and ends
when its person is removed or their access changes.

An MCP client can **sign in** to `/mcp` instead of being given a token. It
opens Toolroll's own sign-in in your browser, then asks you to allow it: read
or act, and which of your projects, confirmed with your password. What it
gets works only at `/mcp`, lasts an hour and renews itself for 30 days at
most; after that it asks again. It is listed under **Sessions & tokens** as
"MCP: <client name>": revoke it there or with `toolroll tokens`, and its next
call is refused. A change to your projects or role ends it too. Sign-in needs
Toolroll's https address (`--public-url`), or this computer's own. Reconnect
the MCP client to renew its connection manually: `toolroll tokens rotate`
refuses these managed tokens. Their access is the intersection of your
current projects, the API token's limit, and the projects you consented to.

Before you allow or decline, sign-in errors stay on Toolroll; registering a
client doesn't make its return address trusted. Pending sign-ins are capped
at 20 per source address and 200 overall. Unused client registrations are
capped at 20 per source and 500 overall, and expire after a day. Limits refuse
new requests instead of evicting someone else's sign-in. Source addresses
come from the direct peer or the last hop appended by the local TLS proxy.

Each refresh rotates both secrets. Toolroll retains every issued refresh
hash for that connection: reuse of any older secret revokes the whole
connection, including tokens just issued by a concurrent refresh. Unknown
guesses cannot revoke it. These hashes are never included in data exports.

Coordinator credentials (`coordinator mint --days`, 90 days unless said)
and runner tokens (a year from registering; every start registers again)
expire too.

## Guessing a password gets nowhere

Five wrong passwords in a row lock that name for 15 minutes, doubling with
each further lock up to a day; the right password waits too. Every place a
password is typed counts: signing in, a request that carries one, and each
password step-up inside the console. One address trying many names runs out
of tries on its own. Locks are kept in memory, so restarting Toolroll
clears them.

## Everything is on the record

**Workflows → Action ledger** keeps who did what, and when: work (runs,
decisions, approvals), console requests, account and access changes,
sign-ins (and refusals, locks and sign-outs), and policy changes with what
changed, like "Auto → Full access" for the permission default, a subagent's
tool rules, an agent choice or an operating mode. Filter it, open it as JSON,
or export it as CSV. It is append-only in the database; it doesn't copy
passwords, prompts or request bodies. A name typed at sign-in that isn't an
account is kept as "unknown account", in case it was a password in the wrong
box.

## Running it as a service

`/healthz` answers `{"status":"ok"}` (or 503) for a load balancer or
orchestrator, from any address, and says nothing else. Errors are always
logged; set `TOOLROLL_LOG_FORMAT=json` for one JSON object per line.
Key-shaped text is blanked from log lines.

## Secrets never travel

Keys and passwords are entered only on the console's secure screens, never
in chat. They live in private files (`0600`) on this computer, never in the
database, a log, a card or a message. Key-shaped text is blanked from logs,
drafts and anything a step keeps.

A service you connect with one click is signed in on its own page. Standing
Orders registers itself with that service, and the code that comes back only
works with a one-time proof it kept (PKCE). The token it gets is kept like
any key.

## Outside steps are pinned

A web request's host is fixed in the zone, and card text is encoded in its
address, so a card can't redirect it. Email goes only to checked addresses,
and a password is sent to the mail server only over TLS.

## Public addresses

Webhooks and shared forms can be public (through Tailscale Funnel or a
reverse proxy) while the console itself stays private. Each webhook has its
own secret address, and GitHub and Linear deliveries are checked with their
signatures.
