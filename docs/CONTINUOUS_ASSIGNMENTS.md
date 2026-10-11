# One assignment through completion

Claim the root once; its existing revisions and repairs remain internal attempts.
Earlier active attempts and unanswered questions remain visible; historical links
retain their exact task and run.

## Lead workflow

Use an operator-minted, project-scoped coordinator credential. Keep the token in
an environment variable, never a prompt or command argument:

```sh
toolroll assignment claim task-id --token-env SO_COORDINATOR --json
toolroll assignment inbox --consumer my-lead --token-env SO_COORDINATOR --json
toolroll assignment show task-id --token-env SO_COORDINATOR --json
toolroll assignment check task-id --digest RECEIPT_DIGEST --token-env SO_COORDINATOR --json
```

Handle a batch, then acknowledge its exact batch ID; until then the same batch
is returned again (see AGENT_UPDATES.md). This inbox is the one way updates
reach a lead — the built-in lead reads the same kind of inbox for the
conversations that turned on crew updates. `assignment updates` (MCP
list_assignment_updates) is only the history of handoffs sent to people; it
delivers and acknowledges nothing. An update may be stale: inspect the current
assignment before acting. MCP offers claim_assignment, get_assignment_inbox,
acknowledge_assignment_delivery, get_assignment and acknowledge_assignment.
Reads execute nothing and clear no pending decision. There is no automatic
Codex-thread wakeup.

The active admitted lead checks the exact ready receipt; the signed-in user can
mark the same result complete without taking lead ownership. The receipt binds
task, run, base, candidate, scope, recorded judgments and artifact hashes. Every
read checks saved bytes. Changed scope, result, evidence or revision invalidates
completion. Revoked credentials cannot acknowledge work.

Full reads include the saved goal, plan and bounded changes/check excerpts with
artifact identities and explicit shortening. Finished builds reach Ready without
a separate reviewer, including strict work and failed checks. Check outcomes,
unmet criteria, historical reviews and accepted exceptions remain visible and
unchanged. Research exposes its saved report and any unavailable content. Failed attempts without
a candidate, unresolved questions, stops, holds, unknown processes still block handoff. Missing or changed saved bytes are
visible limitations; they do not require resubmission to mark work handled. Complete records handling, not success; it
never grants execution, acceptance, publication or deployment authority.

## Watching and revisions

For reliable delivery, use `assignment inbox --consumer NAME` and acknowledge
its exact batch with `assignment ack --consumer NAME --batch ID`. Both require
the lead's credential. The database retains the pending batch and acknowledged
position across restarts. `assignment brief` supplies current catch-up context
from the database. The existing `updates --after` API remains available for
clients that intentionally manage their own cursor. See [Agent updates](AGENT_UPDATES.md).

The worker does not execute a separate model review or automatically retry it.
Existing signed review and repair settings stay recorded as history, not as an
instruction to resubmit finished work. Request a revision with concrete feedback
when changes are needed; its existing scope and execution approvals still apply.
Missing proof packaging alone does not trigger another agent turn.

The ordinary worker scans at most 50 owned roots per pass. Schema 70
`service_cursor` keeps the scan position across restart. It grants no authority
and adds no scheduler or automatic Codex-thread wakeup. A watcher reads updates,
opens the saved result, then acknowledges it or asks explicitly for a revision.
Publication is separate; merge never implies deployment.

## Deployment

Deploy the exact candidate only after its approved machine check passes and the
lead or user marks the saved result complete. The running UI, worker and CLI must
use that same build. Missing result packaging is a visible limitation, not a
reason to start another agent; unavailable or failed machine checks cannot
establish deployment readiness. Historical release records remain in Git and
in the database.
