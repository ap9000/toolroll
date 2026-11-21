# Toolroll

Toolroll is a central, multiplayer engineering workspace where humans and AI coding agents plan, execute, inspect, and ship changes across shared Git repositories under explicit approval and verification boundaries.

## Language

### Workspace & Connection

**Workspace**:
One authoritative Toolroll installation, its state, and its permanent identity.
_Avoid_: Server, instance, console, repo

**Recovery Generation**:
An opaque epoch for a Workspace that advances only when state is restored from a backup, invalidating all prior credentials and client pins without changing the Workspace identity.
_Avoid_: Server restart, session epoch, revision

**Project**:
One enrolled Git repository managed inside a Workspace.
_Avoid_: Repo, workspace, directory

**Connection Profile**:
A local machine's saved pointer to a remote Workspace, binding its origin, pinned Workspace identity, Recovery Generation, and personal Access Token.
_Avoid_: Profile (bare), remote, session, login

### People & Authority

**Account**:
A human identity within a Workspace holding a role and a set of permitted Projects.
_Avoid_: User, member, principal

**Approver**:
An Account role authorized to steer Tasks, promote Candidates, control Live Terminals, and approve high-trust actions within its permitted Projects.
_Avoid_: Admin, writer, editor

**Viewer**:
An Account role authorized to read Tasks, Runs, and Live Terminals within its permitted Projects without mutating state.
_Avoid_: Reader, guest, observer

**Operator**:
An installation-wide authority held by an Approver with access across the entire Workspace, derived from scope rather than a separate role.
_Avoid_: Superadmin, owner

**Sign-In Session**:
An authenticated browser login for an Account, required for high-trust approval ceremonies.
_Avoid_: Session (bare), login, cookie

**Access Token**:
A revocable personal credential for non-browser clients whose effective permissions are always the live intersection of the token's own scope and the Account's current grants.
_Avoid_: API key, password, bearer, session

### Work & Execution

**Task**:
A unit of work within a Project tracking intent, approved scope, human responsibility, Runs, Candidates, and release state.
_Avoid_: Ticket, job, issue

**Run**:
One bounded execution of a Task inside an isolated central working copy that produces changes and verification evidence.
_Avoid_: Attempt, build, execution

**Lead Thread**:
A shared conversation with the Workspace's Lead agent containing turns and actionable proposals.
_Avoid_: Mate session, chat session

**Interactive Agent**:
A live, attachable coding-agent process running inside a Task.
_Avoid_: Flexible session, agent session, thread turn

**Runner**:
An execution worker that runs a Task's Run inside an isolated working copy and reports progress and verification evidence to the Workspace.
_Avoid_: Worker, agent host, daemon

**Custody**:
The truthful ownership and liveness state of an active Run on a Runner, transitioning to `unknown` rather than assumed stopped when heartbeats are lost.
_Avoid_: Lock, lease, status

### Collaboration & Code Changes

**Presence**:
Live, strictly Project-scoped visibility into which authorized teammates are currently viewing a Task or attached to a Live Terminal; informational only and never grants authority.
_Avoid_: Online status, global presence, membership

**Task Handoff**:
Passing human responsibility for a Task's next action to another teammate.
_Avoid_: Reassignment, delegation, handoff (bare)

**Local Checkout**:
Pulling a Task's snapshot onto a developer's laptop into an isolated working copy for local inspection or editing, returning changes only as a Candidate.
_Avoid_: Local handoff, local clone, sync

**Candidate**:
An untrusted proposed change submitted from outside central execution that cannot ship or inherit passing checks until promoted and verified centrally.
_Avoid_: Patch, submission, PR, verified result

**Promotion**:
Accepting a verified Candidate so the Workspace materializes it into a central Run and passes central verification checks before the Task can merge or ship.
_Avoid_: Direct merge, fast-track apply, approval bypass

### Live Terminals

**Live Terminal**:
A hosted interactive terminal attached to a Task or Project, shared by at most one Controller and zero or more Observers.
_Avoid_: Terminal session, PTY, shell session

**Controller**:
The single human currently holding the write lease on a Live Terminal.
_Avoid_: Owner, writer, active viewer

**Observer**:
A human attached read-only to a Live Terminal who can watch live output and take over as Controller if authorized.
_Avoid_: Viewer, watcher, lurker
