# Project access and action ledger v1

This release adds project-scoped team access and one action history without replacing the existing account, task, routine, dispatch, or review systems. It does not add a second workflow engine.

## Using it

Open **People** as an instance operator. Invite someone as a **Viewer** (read work) or **Operator** (create, manage, and approve work), choose **Selected projects**, and check the projects they need. New browser invitations default to selected projects. The existing single-use link expires after 72 hours; both role and projects are fixed before redemption. Fields submitted by the person joining cannot change those powers.

An operator with **All projects** can administer the instance. Existing accounts and invitations keep their previous all-project access during migration. Legacy CLI/browser clients that omit the scope field retain the existing all-project invitation behavior. Giving all-project access to a viewer does not make them an operator.

Each account card shows its project access. **Edit project access** can replace the selection, grant all projects, or select none. Changes end existing sign-ins and derived attended authorizations, modes, invitations, Telegram, and push authority. The account must sign in again. Removing or restricting the last instance operator is refused.

As with existing account revocation, an explicitly approved scope, publication grant, or other completed approval remains an instance promise. Changing someone's access does not silently cancel that already-approved work. Use the existing stop/revoke controls when that is intended.

Open **Workflows → Action ledger**. Filter by project, person/worker, event category, outcome, or task. Actor names are shortcuts to their history; task and run links open the existing work and evidence. Pages contain at most 50 entries, with a stable cursor for older events. `/ledger?format=json` returns the same authorized page and a `nextBefore` cursor. The compact layout shows one short row per event on desktop and a condensed layout on mobile. **Export CSV** downloads every matching event across all pages, using the current filters and project permissions. The export ignores the page cursor, uses UTC timestamps and RFC-style quoted fields, and neutralizes spreadsheet formulas. It streams bounded batches and stops if access is revoked during download.

CLI examples (use the existing credential input mechanism):

```sh
toolroll people invite --role viewer --repo /path/to/project --as owner
toolroll people projects casey --repo /path/to/project --as owner
toolroll people projects casey --no-projects --as owner
toolroll people projects casey --all-projects --as owner
toolroll people list
```

The People screen supports multiple projects at once. The CLI's `--repo` is one project; changing access replaces the selection rather than adding an implicit grant.

## Authority and v1 boundaries

A project grant is an exact canonical repository identity, intersected with the server's configured ceiling. Selecting a project never grants it. An empty list grants nothing, including on a legacy server with no configured ceiling. Unplaced work and instance events are unavailable to project-scoped accounts. Malformed stored grants fail closed; symlink changes cannot retarget an existing grant.

The console rechecks the authenticated actor for collection reads, direct task/run/decision/evidence URLs, and mutations. Project headers and submitted repository fields cannot widen access. Rendered caches are separated by identity and credential generation. Core scope approval also checks the account against the actual repository inside their existing transactions.

Project accounts can use the project inbox, board, tasks, runs/evidence, review, decisions, and flows. Instance administration, provider configuration, global chat, fleet management, project onboarding, and currently unreviewed routes remain instance-only. New routes must be explicitly admitted to the project surface. This v1 does not add groups, custom roles, SSO, per-user provider credentials, or a workflow graph editor.

This is application authorization for a trusted team. It does not isolate agents' host filesystem, network, or credentials, and it does not limit a person who already has direct operating-system/database access. Existing coordinator MCP credentials retain their separate repository scopes.

## Ledger guarantees and coverage

The ledger is append-only at the application/database-trigger level. It starts recording at the upgrade; historical task/run evidence remains available through existing screens, and no synthetic history is backfilled.

Run starts/finishes, task registration/placement/state changes, decision opening/answers, scope approvals, and steering records are captured by database triggers in the same transaction as the underlying work. Rollback also rolls back its events. These records cover CLI and unattended workers as well as the console. Account joins and access changes are recorded transactionally.

Authenticated, parsed console action requests receive requested and accepted/refused/error entries. An accepted request is not a claim that the work completed. If the server dies after recording a request, its work events remain the authoritative evidence of what committed. This is an operations ledger, not a complete per-tool execution trace; transcripts and review evidence stay on their existing run pages.

Schema v99 adds two kinds of event and a short detail on each row. **Sign-ins**: signed in, refused (wrong password, locked, too many tries from one address), account locked, signed out. A name that isn't an account is recorded as "unknown account". **Policy changes**, with before → after: the permission and quality defaults, spend limits, the agent for each phase, tools added to or removed from a project, a teammate's tool rules, and operating modes signed or revoked. A person's coordinators are revoked with their standing (revocation or an access change, not a password change), each as an access event. Events that belong to no project are shown to instance operators.

The ledger stores actors, resource identities, action names, outcomes, and timestamps. It does not copy passwords, invitation tokens, request bodies, prompts, decision text, or transcripts. Repository visibility is applied before paging. A privileged database owner can still alter database files; this is not a cryptographic tamper-proof archive.

Schema v54 adds nullable project-access columns to accounts/invitations, an action table, indexes, and triggers. Existing rows keep their meaning. Current-version databases missing project authority metadata refuse to open rather than recreating unrestricted grants. Older binaries must not open an upgraded database.

## Validation and release scope

The implementation is covered by real HTTP tests for invitation redemption, project collections, guessed resource URLs, forged repository fields, viewer mutation denial, instance-route denial, empty grants, stale sessions, request attribution, ledger filtering/paging, HTML escaping, and rollback. Migration tests preserve existing account credentials, invitation hashes, IDs, and task rows and verify a byte-identical second open and refusal of damaged authority metadata.

A browser fixture validates the People and ledger surfaces independently of the running desktop controller. This source release does not install, restart, or migrate the user's live desktop app. The existing macOS permission/recovery handoff remains outstanding.

See [Automatic approvals](AUTO_APPROVAL.md) for project operating modes and the optional unchanged-plan approval policy added in schema v55.
