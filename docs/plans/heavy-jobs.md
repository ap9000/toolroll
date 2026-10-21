# Heavy jobs off the busy machine — plan

Status: v1 draft (2026-10-20), for Codex review. Fourth in Alex's order.

## What and why

Laminar runs on "cattle, not pets": disposable workers, so the number of conversations and the number of computers
doing work are separate capacity decisions. Toolroll is local-first on purpose and stays so — but 2026-10-20 showed
the cost of one busy machine doing everything: the release check for b0c7a860 failed twice on **load flakes**, not
code (#3199: two `page.goto` 30 s timeouts on ordinary pages; #3200: `ECONNRESET` on an idempotent GET), on a Mac at
load ~21/24 cores with OrbStack, Docker, Spotlight and a second test run competing. The same journeys passed three
times locally on a quieter machine.

## Three layers, smallest first

### 1. The release check survives load (scripts only)

- `scripts/release-check.mjs` starts **six parts at once** (units, flows, app, flows-real, app-real, upgrade with 4
  workers). Run them in two waves instead: wave 1 units + scripted journeys + upgrade; wave 2 real-model journeys
  (they are slow, capped by provider turns, and need the least CPU). Fail-fast stays.
- **Load gate**: before each wave, read `os.loadavg()[0] / cpus`; above 0.85 wait (up to 5 min, said in the log)
  and lower `--at-once` lanes by one per 0.25 over. The log names the load it ran under.
- **Transient-network retry in the e2e kit**: the `json`/`request.get` helper retries once on `ECONNRESET`/
  `EPIPE`/`socket hang up` for **GET only** (idempotent); `page.goto` retries once on a navigation timeout when the
  server answers `/healthz` within 2 s (the server is alive, the machine was slow). Every retry is printed, and two
  retries in one journey fail it (a real problem is never hidden).
- **Server keep-alive**: set `server.keepAliveTimeout = 65_000` and `headersTimeout = 66_000` in `serve.ts` (Node's
  5 s default races clients that reuse sockets — the #3200 failure). Applies to production too; the standard value
  behind proxies.

### 2. Heavy work never stacks on one runner

- A task or check can be marked **heavy** (release checks are; a scope's `checks: full` is). The claim path
  (`claim.ts`) admits at most **one heavy job per runner** at a time, and a heavy job waits rather than start beside
  another heavy job — the dispatch line says *Waiting: another heavy job is running on this computer*.
- The runner reports its own load with its heartbeat; above the gate, heavy jobs wait (ordinary builds proceed).

### 3. A runner elsewhere takes heavy jobs (opt-in)

- Runners already register with capacity and repos (`register`, `toolroll up --runner`). Add a runner tag
  **`heavy-ok`**; when any online runner for the repo has it, heavy jobs prefer it over the operator's own machine.
- Documented setup: a spare Mac or a Linux box (or a CI-hosted runner) runs `toolroll up --runner <name> --tag heavy-ok`
  against the same console over the tailnet. No new trust: it is an ordinary runner with the same fences.

## Order

Layer 1 first (it would have saved today, and is scripts + one server setting). Layer 2 next. Layer 3 when a second
machine exists to try it on.

## Tests

Release-check wave ordering and load-gate arithmetic (unit, with a fake loadavg); e2e-kit retry: one transient reset
passes with a printed retry, two fail, POST never retries; keep-alive values asserted on the server; claim refuses a
second heavy job on a runner and admits it on another; dispatch words.

## Out of scope

Cloud sandboxes; moving the lead or conversations off the operator's machine.
