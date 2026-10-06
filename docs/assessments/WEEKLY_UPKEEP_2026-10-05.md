# Weekly upkeep — October 5, 2026

Dependency updates prepared for review on base `1c1ec2c00cf325b93c66b23a9c759b417416a384`
(0.9.36), the supplied task checkout. The advisory plan named the older `6cfacfb` base;
that attempt did not move HEAD. Review comment 844 on build #2538 is addressed
by this revision from `7421af2ef2aa8984eaab0026848ee05f335c8c35`: retain the Vitest
security patch and defer the major upgrade. No installed runtime or agent CLI
was changed.

| Package | Before | After |
| --- | --- | --- |
| @slack/socket-mode | 3.0.1 | 3.1.0 |
| @types/mailparser | 3.4.6 | 3.9.0 |
| @types/node | 26.2.0 | 26.6.4 |
| @xyflow/react | 12.11.6 | 12.12.0 |
| happy-dom | 20.12.0 | 20.14.5 |
| imapflow | 2.0.6 | 2.2.5 |
| lucide-react | 1.47.0 | 1.52.0 |
| mailparser | 3.9.28 | 3.9.36 |
| nodemailer | 10.0.10 | 10.0.15 |
| tsx | 4.23.12 | 4.23.15 |
| vitest | 4.1.10 | 4.1.11 |
| @parcel/watcher (transitive) | 2.5.1 | 2.6.0 |
| source-map-js (transitive) | 1.2.1 | 1.2.2 |

Tailwind CLI and Tailwind remain at 4.3.3. The CLI pins watcher 2.5.1 exactly,
so refreshing permitted resolutions alone could not remove micromatch/braces.
A version-scoped npm override selects watcher 2.6.0 for that CLI; its picomatch
dependency removes the vulnerable chain. Remove the override when a future CLI
release includes a fixed watcher. The additional source-map-js advisory was fixed
within its existing range. Final `npm audit` reports zero vulnerabilities.

Vitest is pinned to 4.1.11, whose [release notes](https://github.com/vitest-dev/vitest/releases/tag/v4.1.11)
include the redirect-mock filesystem allowlist fix. Its matching `@vitest/*`
packages resolve to 4.1.11; Vite remains at 8.3.2. This keeps the audit fix within
the existing Vitest major version. Test settings, assertions and the approved
verification command are unchanged.

**Deferred: Vitest 5.0.3.** The saved result's 148 focused tests did not establish
compatibility across the full suite. The [upstream migration guide](https://vitest.dev/guide/migration/)
describes changed mock-history defaults, top-level hoisted mocks, awaited async
assertions and Vite dependency handling. A later migration should inspect those
uses and runner integrations, run the affected journeys, then pass the existing
full machine gate on that exact candidate before adoption.

The `typescript-parser` alias stays at TypeScript 6.0.3. `src/repository-context.ts`
uses `createSourceFile` and `resolveModuleName`; TypeScript 7.0.2's root export
provides neither. Its separate unstable APIs require an indexing migration.
The normal build compiler remains TypeScript 7.0.2. The filed CLI inventory
(Claude 2.1.289, Codex 0.156.1, Gemini 0.60.0) contained no version-change line;
no CLI upgrade or live provider certification was performed.

Revision verification on Node 22.22.0, using the revised package files over
`7421af2ef2aa8984eaab0026848ee05f335c8c35`:

- `npm run typecheck` passed. The focused runner's normal setup also ran
  `npm run build` successfully, including the browser bundle and Tailwind.
- `npx vitest run src/suite-lifecycle.test.ts src/release-check.test.ts
  src/browser/overlay-motion.test.ts src/browser/team-chat.test.ts
  src/browser/workspace-client.test.ts` passed: 5 files, 78 tests. These cover
  runner cleanup on pass/failure/interruption/timeout, release-check selection,
  and browser test integration, including happy-dom, mocks and async assertions.
- `npm audit --json` reports zero vulnerabilities; `npm ls --all --json`
  passed. The manifest and lockfile agree on Vitest and its packages at 4.1.11.
- Logs and package fingerprints are under this run's ignored `evidence/`;
  they are excluded from the commit. The runner logged denied `sysctl` reads
  for machine diagnostics; none of the checks failed.
- The unchanged approved full command still belongs to the final machine gate.
  It was not run in this revision, so full-suite success is not claimed. No
  desktop/phone, live-provider or native-watch verification was added here.

Prior build #2538 reported the following checks on its Vitest 5.0.3 candidate.
These are historical context, not fresh verification of this revision:

- `npm run typecheck` and `npm run build` passed, including Tailwind, XYFlow,
  Lucide and bundled license checks.
- Eleven focused suites passed: 148 tests covering Slack socket envelopes,
  mail parsing, real loopback SMTP success/refusal, mail replies, the three
  happy-dom browser suites, weekly upkeep, release-check selection and process
  cleanup. Vitest lifecycle journeys covered pass, failure, interruption and
  timeout behavior without weakening assertions or cleanup.
- A synthetic local TLS IMAP journey used the production reader: authentication,
  read-only EXAMINE, initial cursor, next-message fetch/parsing and logout passed.
  A TSX smoke check parsed TypeScript and resolved a module through the retained alias.
- Native Tailwind watch failed with `Error starting FSEvents stream`. A comparison
  probe reproduced the same error on the original watcher 2.5.1 and candidate 2.6.0.
  Default native watch remains unverified in this runner; ordinary builds passed.
- The existing release-check planner selects every unit test and all scripted
  flow/app journey groups for these package changes. That unchanged full machine
  gate is pending; it was not run here. Desktop/phone and live service behavior
  are not claimed by these focused checks.

The prior run's logs, local smoke fixtures and JSON results were saved under its
ignored `evidence/`. Its outdated query also listed eleven Radix packages beyond
the filed list; those remain unchanged for subsequent upkeep. The intentionally
retained parser alias and deferred Vitest major will continue to appear in
weekly upkeep output.
