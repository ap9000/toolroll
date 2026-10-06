# A team on one Toolroll server

A team uses one central Toolroll server as the single source of truth. Each engineer works from their own
laptop with their own API token (`so_<id>_<secret>`: read or act, expiring, revocable). Their CLI and their own
coding agents run the same commands the server runs locally; nothing gets a second, per-resource API.

## Rules that hold in every phase

- One seam: `runOperateAs(argv, { principal, store, write, files?, source? })` in `src/operate.ts`. The transport
  and the MCP gateway prove the token; everything after that is the same for both.
- The machine contract is the allowlist. Every command row states `remote: yes | no | step-up`
  (`src/surface.ts`, checked by `src/contracts/cli.test.ts`). Commands without a row never run remotely.
- `no`: the server's own machine: services, workers, keys, providers, storage, backups, publishing, setup,
  and commands that only make sense beside a checkout.
- `step-up`: approvals, people and policy. These stay in the console and chat: "approve in the console or chat".
- Only `so_` tokens are accepted, and only without a browser Origin. A read token runs only commands whose
  mutation is `none`.
- The principal is re-proved on every call: account standing, credential generation, token state and scope.
- The project a command touches must be one the person can use now. Where a local run would use the
  working directory, a remote caller must name `--repo` with the server path of a known project.
- No fallback: a remote run never reads the owner's saved login, never prompts, never uses a lead token, and
  never runs as the owner. Credential and path flags (`--as`, `--token`, `--db`, `--out`, ...) are refused.
- Input files travel with the request, keyed by the argument that names them. The server reads no
  caller-named paths.
- Every call is in the action history: the person as actor, source `api` (CLI) or `mcp` (agent), and the
  token's name.

## Phase 1: remote CLI

- `remote-principal`: the `remote` column, `runOperateAs`, the `api`/`mcp` ledger sources (schema v110).
- `remote-transport`: `POST /api/cli` runs one command for a bearer token and streams its output; the CLI
  forwards a command to the saved server profile.
- Done when an engineer can file, read and steer tasks in their projects from a laptop, and every refusal
  says what to do instead.

## Phase 2: remote MCP

- `remote-mcp`: `/mcp` over HTTP for a person's own agent, with the same token. Gateway tools map onto the
  same command rows, so `remote` decides there too.
- The ledger tells an agent's calls (`mcp`) from the person's CLI (`api`).

## Phase 3: hardening

- Token management from the CLI: create, list, revoke and rotate (overlap window, then the old token ends).
- Per-token and per-person rate limits on `/api/cli` and `/mcp`; refusals counted like failed sign-ins.
- History by token: filter the action history and exports by token name; show last use per token.
- TLS on a real domain (no tailnet-only assumption); HSTS; the CLI refuses plain HTTP to a non-local host.
- OAuth for MCP clients that expect it, mapped onto the same per-person tokens.
- Repositories and runners on the server: add a project from GitHub on the server, and register server-side
  runners, so remote callers never need a checkout of their own.
- Scope project-wide lists for people with access to some projects (`task list`, `status`, `ready`) instead of
  refusing them.

## Deferred

- Runners on laptops (a person's machine building for the team).
- Uploading a local repository or working tree to the server.
- Remote approvals with a step-up (a fresh second factor for one approval) instead of the console or chat.
- More than one tenant on one server.
