# Check work from your phone

## Start with the mobile chatbot

The console's **Chat** tab is the primary phone-control experience. Open your
existing securely reachable console URL on your phone, sign in, and start the
conversation once. No Telegram bot is required. The computer hosting Standing
Orders must remain online; these changes do not expose it to the internet or
create a remote-access tunnel.

Ask naturally: “What needs me?”, “Make the mobile navigation clearer”, or
“Pause this task while I review the result.” Open a task's **Ask** tab to keep
the next message focused on it. The existing conversation reads the task,
proposes changes as cards, and applies them only through the existing
confirmation/approval flow. Task progress and recorded results remain in the
same view. No new chatbot, model selection, or permission bypass is introduced.

On mobile, projects open in a dismissible drawer and the portfolio overview
starts collapsed. The empty composer comes before suggested prompts. A sent
message brings the current reply/action into view rather than jumping past it
to the composer. Desktop keeps its expanded project/overview layout.

The local continuity update keeps the composer editable while a reply is in
progress. A follow-up is a draft, not an automatically queued instruction.
Submitted messages have durable receipts so retrying the same send does not
call the model or create proposals twice—even after a server restart. A failed
turn stays failed; a new attempt is an explicit new message. Drafts are scoped
to this conversation and task in this browser tab's session storage, expire
after 24 hours, and are cleared when their send is acknowledged. Do not type
secrets into chat. If browser storage is unavailable, drafts stay on the page
only. Closing the tab/device continuity of an unsent draft is not promised.

Connection failures are visible and retried without resubmitting work. New
replies load server-rendered cards; active draft and approval fields are not
interrupted by a reload. This update is implemented locally, not deployed to
the installed app yet.

## Optional Telegram shortcuts

After [pairing Telegram](guide/chat-and-phone.md#telegram-from-the-terminal), send these as new messages in
the paired private chat:

| Message | Answer |
| --- | --- |
| `/status` | Recent work grouped by needs attention, working, waiting/next up, finished, and cancelled. |
| `/task mobile-nav` | One task's current diagnosis, recorded evidence, delivery status, and next action. Replace `mobile-nav` with an ID from `/status`. |
| `/help` or `/start` | The short command guide. |

These commands do not call a model, create work, grant approvals, retry a task,
or publish anything. They use the same dispatch diagnosis and proof records as
the console. Existing decision buttons and reply notes still work: a reply to
a decision remains a note, even if its text starts with `/status`.

The installed computer and Telegram bridge must be awake and online. If the
worker is disconnected but the bridge is available, status can explain the
stored state; the bridge cannot repair operating-system access or wake an
offline computer. Full conversation, task creation, revisions, screenshots,
and result annotations over Telegram are later work over the existing mate
engine, not features of these three commands.

## Reading the answer

- A task marked done with missing/conflicting evidence still needs attention.
- A requested review stays waiting; it is not finished and does not need a
  duplicate review request. Admission still checks the current authority.
- Recorded acceptance does not upgrade weak evidence to verified evidence.
- Recorded provider checks, a saved local result, a pushed branch, an opened
  pull request, and an observed merge are distinct facts. Files are not
  re-verified or transmitted by this read-only view.
- A recorded retry time is the earliest known wake, not a promise. A worker,
  valid approvals, credentials, and the other readiness gates are still needed.
- `/status` is the newest 60 tasks across enrolled projects, not a complete
  queue audit. It shows at most two items per group, reports omitted items,
  and warns when older tasks may still need attention. `/task <id>` reads an
  older task directly. Use the console for the full queue.

## Access and delivery

The bridge reloads `repos.json` beside its database for each read command.
Only explicitly enrolled repositories are included; opened-project history,
unplaced tasks, and unrelated database rows do not grant visibility. Missing
enrollment means no task data. An unreadable registry refuses with a generic
explanation rather than falling back to all projects. This is the installation's
existing enrollment boundary, not per-user project sharing.

The private chat, sender ID, live pairing, current approver role, and credential
generation must match. Forwarded messages, bot-mediated messages, groups,
revoked/rotated pairings, and strangers get no reply. Pairing is re-proved after
the asynchronous registry read and immediately before sending. Known secret
patterns, local path-shaped text, digests, and display control characters are
removed from these new display copies; this is not a guarantee that arbitrary
user-authored text can never contain sensitive information. Do not put secrets
in task titles or descriptions.

Replies fit one plain-text message with link previews disabled. Read replies
are best-effort, like existing decision acknowledgements: a consumed update
is not resent after a crash or failed send. Failures are reported in the bridge
output; send a new command to retry. No exactly-once external delivery promise
or extra notification outbox is introduced. Existing automatic decision/result
notification and digest delivery remain unchanged.

## Validation

`src/telegram-status.test.ts` tests the real SQLite store, shared dispatch
projection, bridge pass, follower, and public CLI entry point with a scripted
Telegram transport. It covers admission, replay across database reopen,
revocation during a read, failure reporting, weak proof, pending review,
publication, bounded history, and no task/model mutations. This is deterministic
integration evidence, not a live Telegram or production-worker certificate.
