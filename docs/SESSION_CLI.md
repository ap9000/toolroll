# Native sessions from the CLI

> **Deprecated.** `toolroll session …` and the `/code` page still work this release, print a warning, and are removed in the next minor release. Queue work as a task (`toolroll task add`) instead.

`session` connects to the running Standing Orders service that owns native coding
sessions. It does not open a second catalog or start a background server. `chat`
remains the coordinator conversation that reads work and proposes actions.

Inspect this client's exact schemas without credentials:

```sh
toolroll session capabilities --json
toolroll session send --help
```

Client capabilities do not establish that the installed service supports them.
The matching authenticated session service must be running. Session reads and
controls require an operator account; external coordinator credentials have no
session access. A schema is not permission to use an operator's credential.

Each request names the service and operator explicitly. Use HTTPS for a remote
service, or HTTP on loopback. Credentials come from an explicitly named
environment variable or token file; the CLI never discovers installation secrets.
There is no inline token argument. The service authenticates the account again
for every request. Redirects are never followed.

With your credential already in a private token file:

```sh
toolroll session list \
  --url http://127.0.0.1:7788 --as alice --token-file /private/operator-token \
  --json

toolroll session start --project /path/to/project \
  --title 'Improve session continuity' --file /path/to/request.txt \
  --key request_0123456789 \
  --url http://127.0.0.1:7788 --as alice --token-file /private/operator-token \
  --json
```

Use a different key for each new action. `--stdin` reads a piped prompt; `--file`
reads UTF-8 text. Both preserve the complete text, up to 64 KB. Choose one source.
`--token-env VARIABLE_NAME` can replace `--token-file` when that environment
variable already contains the account credential.

`session show <id>` returns a concise saved-context brief, revision, native thread
ID and turn ID. The brief labels the agent's latest report and identifies the
saved revision and source items; it does not claim to verify that report. It
uses no additional model call. Add `--view activity` for recent conversation
items and pending requests. `session changes <id>` returns the current commit and working diff. Listing
accepts `--project` and `--limit` (1–100). A shortened response says so explicitly.
Lists inspect at most 100 saved sessions per project filter; older sessions can
still be opened by their saved ID. Activity is bounded to the latest 100 items
and 50 pending requests; complete native history remains with the owner.

For `send`, `stop`, `resume` and `recover`, copy the identity from the latest
`show` response:

```sh
toolroll session send <session-id> --file /path/to/follow-up.txt \
  --revision 4 --thread <native-thread-id> --turn none \
  --key followup_0123456789 \
  --url http://127.0.0.1:7788 --as alice --token-file /private/operator-token \
  --json
```

Use `none` only when the saved thread or turn is null. The owner rejects stale
revision, thread and turn identities. `stop` targets that exact turn; `resume`
reconnects the saved conversation; `recover` checks process exit and reconciles
delivery receipts. Recovery does not resend a message or acknowledge uncertain
delivery on your behalf. Review and approval actions remain in their existing
controls. Events, shipping review, and reviewed continuation are not exposed by
this CLI yet.

Every JSON response uses the existing `envelopeVersion: 1` wrapper and session
protocol `version: 1`. It includes `status`, `delivery`, `retry`, `nextActions`,
the exact saved identity, and the receipt key when available. Exit codes remain
0 for success/pending, 1 for a failed connection or uncertain mutation delivery,
2 for invalid input, and 3 for an explicit service rejection. Plain errors go to
stderr. `--json -o /path/to/answer.json` also saves the same envelope.

If a mutation response is lost, malformed, truncated, redirected, or names a
different session or receipt, the CLI reports `delivery: unknown` and never
retries. Keep the original key and inspect the saved session before continuing.
A rejection is `delivery: not-sent`. A bare gateway failure cannot establish
non-delivery; the owner must return the typed rejection or the explicit
`x-standing-orders-session-delivery: not-sent` response marker.
