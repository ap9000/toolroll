# Task folder cleanup

Every task works in its own folder (a git worktree under `worktrees/` beside the database). Toolroll removes these by
itself; the code is `src/checkout-cleanup.ts`, the daily sweep `src/storage-sweep.ts`.

| What | When it goes | Setting |
| --- | --- | --- |
| A finished task's clean folder | When the task is complete or cancelled, 2 days or a week after, or never | `toolroll storage cleanup <finished\|2d\|7d\|never>` |
| An idle task's clean folder | After 7, 14 (default) or 30 days idle, or never | `toolroll storage cleanup idle <7\|14\|30\|never>` |
| A folder with uncommitted changes | Never by itself. Settings → Storage and `toolroll storage` list it; a person discards it or keeps it | `toolroll storage discard <path> --yes` |

Both choices are in Settings → Storage, take an instance operator, and land in the ledger. Automatic cleanup set to
`never` turns idle cleanup off too.

## Idle cleanup

Idle means nothing touched the task or any version of it for that long: no run, no open lease, and no act (a note, a
comment, an answer, a hold, a steer, an approval, any ledger entry other than Toolroll's own bookkeeping). It removes a
folder even with the result waiting for review or the task unfinished, in the storage sweep's child process only, at
most 20 per pass; a sweep that reached that cap comes back an hour later. A clean-up by hand doesn't take idle folders.

Right before each removal, inside the folder's reservation, Toolroll reads again and requires all of this:

- the task's standing, its family's activity, and no open run, unreleased lease or claim;
- no live work in the folder (`liveWork`) and no process working there, by the operating system's own list;
- nothing uncommitted (files Toolroll wrote itself aside); git's own clean check refuses anything newer;
- HEAD on the task's recorded branch, that branch in the project's repository, and every commit the task's runs recorded
  on a branch. A commit held only by the folder's own reflog or a worktree-only ref keeps the folder;
- the folder really inside the pool (real paths, no links), and its `.git` bound to the project by Toolroll's records.

Never idle: a release gate's folder (a deploy installs from it), a task only an external tracker knows, and a folder no
task names (only a clean-up by hand takes that one). `.gitignore`d files don't count as work, the same as in every
other cleanup.

## What happens afterwards

Only the working copy goes. The branch, the evidence and the task's history all stay.

| Act | Needs the folder? | After removal |
| --- | --- | --- |
| Open a result, its diff, its checks and screenshots | No: saved evidence | Works as before |
| Accept | No: evidence and the ledger | Works as before |
| Run checks, batch checks | No: a fresh folder at the result's commit | Works as before |
| Send back (a revision) | No: starts from the result's commit | A new folder on its own branch |
| Pull request, merge | No: the commit, from the project's repository | Works as before |
| Retry, requeue, rerun the check | The next attempt leases the branch | The lease makes the folder again, at the same path; the project's setup runs again |
| Resume a parked, stopped or held task | The next attempt leases the branch | The same. A warm session resume still applies: the path and branch are the same |
| Open in editor | Yes | The link is hidden until a run makes the folder again |
