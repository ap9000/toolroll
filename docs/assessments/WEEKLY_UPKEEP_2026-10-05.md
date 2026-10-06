# Weekly upkeep — October 5, 2026

Dependency updates prepared for review on base `1c1ec2c00cf325b93c66b23a9c759b417416a384`
(0.9.36), the supplied task checkout. The advisory plan named the older `6cfacfb` base;
this attempt did not move HEAD. No installed runtime or agent CLI was changed.

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
| vitest | 4.1.10 | 5.0.3 |
| @parcel/watcher (transitive) | 2.5.1 | 2.6.0 |
| source-map-js (transitive) | 1.2.1 | 1.2.2 |

Tailwind CLI and Tailwind remain at 4.3.3. The CLI pins watcher 2.5.1 exactly,
so refreshing permitted resolutions alone could not remove micromatch/braces.
A version-scoped npm override selects watcher 2.6.0 for that CLI; its picomatch
dependency removes the vulnerable chain. Remove the override when a future CLI
release includes a fixed watcher. The additional source-map-js advisory was fixed
within its existing range. Final `npm audit` reports zero vulnerabilities.

Vitest was first patched to 4.1.11 for the audit fix, then migrated separately to
5.0.3. npm resolved its Vite peer to 8.3.2. Both support the project's Node 22.13
minimum; checks ran on Node 22.22.0. Vitest 5 clears mock histories before tests,
requires top-level hoisted mocks and awaited asynchronous assertions, and makes
Vite a peer dependency. The focused tests required no compatibility settings or
assertion changes. See the [upstream migration guide](https://vitest.dev/guide/migration/).

The `typescript-parser` alias stays at TypeScript 6.0.3. `src/repository-context.ts`
uses `createSourceFile` and `resolveModuleName`; TypeScript 7.0.2's root export
provides neither. Its separate unstable APIs require an indexing migration.
The normal build compiler remains TypeScript 7.0.2. The filed CLI inventory
(Claude 2.1.289, Codex 0.156.1, Gemini 0.60.0) contained no version-change line;
no CLI upgrade or live provider certification was performed.

Validation on the resulting package files:

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

Logs, local smoke fixtures and JSON results are under ignored `evidence/`, outside
the commit. A fresh outdated query also lists eleven Radix packages beyond the
filed list; those remain unchanged for subsequent upkeep. The intentionally
retained parser alias will continue to appear in weekly upkeep output.
