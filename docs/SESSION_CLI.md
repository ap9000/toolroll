# Native sessions from the CLI

> **Deprecated.** `toolroll session …` and the `/code` page still work this release, print a warning, and are removed in the next minor release. Queue work as a task (`toolroll task add`) instead.

`session` runs on the Toolroll server you connected to, through the same
`POST /api/cli` endpoint as every other remote command. It does not open a second
catalog or start a background server. `chat` remains the lead conversation that
reads work and proposes actions.

Inspect this client's exact schemas without credentials:

```sh
toolroll session capabilities --json
toolroll session send --help
```

Session reads and controls need an instance operator's API token without a project
limit; changing a session needs an act token. Lead and coordinator credentials have
no session access. Make a token with `toolroll tokens create` (or in **Settings →
Sessions & tokens**) and save it once with `toolroll connect <origin> --as <account>
--token-stdin`. Each command uses that saved connection, or `--profile <name>`. The
server checks the token again for every request, and the request is recorded in the
action ledger like any remote command. Redirects are never followed. The old
`--url`, `--as`, `--token-file` and `--token-env` flags, and the `/api/sessions`
addresses, are gone; both say what to use instead.

```sh
toolroll session list --json

toolroll session start --project /path/to/project \
  --title 'Improve session continuity' --file /path/to/request.txt \
  --key request_0123456789 --json
```

Use a different key for each new action. `--stdin` reads a piped prompt; `--file`
reads UTF-8 text on your computer and sends it with the request. Both preserve the
complete text, up to 64 KB. Choose one source.

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
  --key followup_0123456789 --json
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
A rejection is `delivery: not-sent`: a refusal before the command ran (a token
that is not valid, a read token, a request limit) is never a delivery. A command
that stopped on the server cannot establish non-delivery and reads as unknown.
