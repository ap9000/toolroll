# Contributing

Toolroll is small on purpose: Node ≥ 22.13, a short list of pinned runtime
dependencies, one SQLite file, and a design document that says no more often
than yes.
Contributions that fit that shape are very welcome.

## Getting set up

```sh
git clone https://github.com/ap9000/toolroll && cd standing-orders
npm install
npm test              # the fast unit tier (npm run test:all adds the slow one)
npm run typecheck
npm run dev -- --help # run the CLI from source
```

There is nothing else — no services to start, no env file to copy. Tests
create their own temporary databases and repositories and clean up after
themselves.

## What makes a change land

**Every promise is a test.** Security rules, migrations, data integrity and
contracts each have one (docs/testing.md says which kinds are kept); a fix that
breaks one of them adds a case to that rule's table, and wording or layout gets
none. Fakes are preferred over mocks — most
of the suite drives real SQLite databases and real git repositories in temp
directories, and the unattended stretch is one end-to-end test
(`src/unattended.slow.test.ts`) that queues twelve tasks and walks away.

**Fail closed.** Where a fact is not established, the code refuses and says
why, rather than guessing. A new adapter that cannot verify an endpoint
should refuse the operation, visibly — see how the GitHub adapter treats
`addEdge`.

**No new runtime dependencies** without a conversation first. Node's standard
library (including `node:sqlite`, global `fetch`, and `WebSocket`) has been
enough so far.

**Security-sensitive paths need care.** Approval nonces are minted only on
screens that restate the digest-bound terms; credentials never appear in
URLs, the database, or logs; anything an agent's environment can see is
scrubbed of tokens. If your change touches approval, pairing, grants, or
spawning, expect review to be slow and specific.

## End-to-end flows check

`npm run e2e:flows` checks flows end to end with nothing stubbed: a throwaway
instance (the real CLI, console and worker) on a scratch repository, driven
through a real browser, with real Claude turns for the lead and one real
build. It needs `claude` and `gh` logged in and Playwright's Chromium, takes
about seven minutes, and writes `report.md`, screenshots and both logs to
`output/e2e/`.

## Writing a provider adapter

The most useful contribution surface. `src/provider.ts` is the only module
that names an agent binary: an adapter supplies argv builders for build,
plan, and repair invocations, an envelope parser for the tool's output
stream, timeout clamps, and an identity probe. `src/provider.test.ts` shows
the argv snapshots expected of each; `src/invoke.slow.test.ts` holds the
architecture rule that keeps spawning confined to `src/invoke.ts`. Copy the
`codex` adapter as a starting point — it is the smallest complete one.

## Reporting bugs

`toolroll --json` output, the command you ran, and what you expected
are usually enough. For daemon issues, `toolroll daemon logs` names
the file to attach. Never include an approver token, bot token, or webhook
URL in an issue — rotate anything you pasted by accident.

## Conduct

Be kind, assume competence, argue about the design rather than the person.
