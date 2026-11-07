# Toolroll cards, chat parity and approving from chat

One arc, on branch `toolroll-cards`. Chat should be able to show and do what the console can.

## Decisions

- **One card format.** A lead writes a [json-render](https://json-render.dev) spec limited to our catalog: Card, Text, Fields, Table, Chart, Divider, Actions, Button. `@json-render/core` (0.22.0, pinned) defines the catalog and checks the spec's structure. `@json-render/chat`, `chat` and `ai` are not used; Toolroll's own Slack, Discord and Telegram code stays.
- **Real numbers only.** The spec has no field a figure can be typed into. Fields, Table and Chart name a source (`tasks`, `results`, `flows`, `flow_zones`, `spend`, `projects`, `builders`, `mode`, `integrations`, `providers`); Toolroll fills every value from its records when the card is made and saves that snapshot with its time. There is no model title: headings are the source's own. The only free text is `Text`, shown as a plain paragraph, and a card must hold at least one data part.
- **Safe buttons.** A Button is a `CHAT_CONTROLS` destination (same checks as `show_control`) or a pointer to a proposal drafted earlier in the same turn. Labels are Toolroll's. No field accepts a URL. The proposal keeps its own message or row, with the existing Confirm door, directly under the card.
- **No migration.** A card is a `control` proposal with `control: "card"` (`lead_proposal.kind` has a CHECK, and `control` is already "shows something, confirms nothing"). A chat part carries it as an optional `rich` field beside `text`, which is always the plain version.
- **Never lose the message.** The reply is separate from the card. A card the store can't read, a part a platform can't show, or a platform that refuses the blocks falls back to the part's plain text.
- **Privacy.** Every value goes through `publicChatText` when the card is made and is escaped per platform when it is shown. Cell text is never a link, a mention or formatting.

## Approving from chat (owner's decision, 2026-11-07)

Anything that needs approval is approvable from chat by a chat user who has the authority for it. Chat logins are secure by design, so a password prompt is not required in chat. This reverses the earlier rule that password actions only complete on the secure screen, and that approving from chat is off until turned on.

What keeps it safe:

- Same authority check as the console: the person's own identity and role on that project, re-proved when the act runs. A room gives no authority; a chat user counts only through their own paired binding.
- A model never approves. The approval is a person's own tap, recorded as that person with proof `chat`; the lead, a lead token or message text can't trigger it. The approval policy rules (Only people / People and the lead) still apply.
- The card shows the exact terms, written by Toolroll. An approval card keeps the digest of its own words when it is made (`state.shown`); `approve()` and the seal check those words against that digest and against the live scope: they must hold the scope's whole terms text (`scopeTermsText`), and any check access or extra services. A tap on a card that showed less opens none of the walls for machine-written or outside text. Changed terms refuse. Tokens are one use.
- A person's own chat setting holds on every approval, in web chat too: their off, and their limits on access and spend.
- Terms too long for one message, or holding a path or a credential-shaped string, open the review page in the signed-in console, with no password. A plan card keeps its link when it can't show every word in one message.
- Project-limited people get what they get in the console.

Approving from chat is now on unless the person turned it off: their explicit off (and their own limits, if they set any) still holds. Still not chat acts: typing or showing secrets, passwords, keys and tokens, and changing who can approve (people's roles, approval policy, raising automatic approvals).

### The owner's decisions on what stays as it is (2026-11-07)

- No recent sign-in is required to approve from chat.
- No default limits: with no saved setting, a person's chat approves up to what they may approve anywhere.
- Long terms link to the review page in the signed-in console, with no password.
- Automatic repair stays opt-in, through a signed mode only.

## Every console act

From the route table's 273 console POST rows. **Chat**: already in chat. **Add**: added in this arc. **Secure**: stays on the secure screen, chat offers a card or link. **Browser**: belongs to one browser session, so it has no meaning in chat (kept on the screen).

| Area | Acts (route ids) | Mark | Why |
|---|---|---|---|
| Tasks | tasks.add, tasks.fast, task.act.scope, plan, plan-edit, next, hold, unhold, requeue, cancel, stop, pause, steer, reply, block, unblock, repair-dependency, follow-up, route, accept-proof, complete, merge; run.act.note, comment, revise, draft-repair, checks, add-tests; queue.move; decision.answer; sweep.cancel-rest | Chat | propose_task, propose_scope, propose_hold, propose_task_action, propose_review, chat-decide cards and shared actions |
| Approvals | task.act.approve, task.act.resume, flow.browser, sweep start, task.release.go-on's release card | Add (no password in chat) | Owner's decision |
| Approvals | task.act.reopen, accept-revision, reject-revision, flow.unattended | Add (no password in chat) | `task_reopen`, `revision_accept`, `revision_reject`, `flow_unattended`. Its ledger line names the grant, the road and the chat binding. flow.unattended signs over the script snapshots the worker keeps: its file pass is asynchronous and the door is not, and a snapshot older than the files fails closed at the firing |
| Task tidy | task.act.archive, task.act.restore | Add | `task_archive`, `task_restore`, through archiveTaskFamily / restoreTaskFamily |
| Task tidy, many | work.put-away.apply | Secure | Bound to a preview's digest of many tasks |
| Task repair | task.act.keep-grown, retry-review, recheck-stopped, stop-carrying, resume-arm | Secure for now | Rare repair acts, not one of the priorities; listed |
| Automatic approvals | mode.revoke | Add | `mode_revoke`: lowers authority; one click on the console |
| Automatic approvals | mode.confirm, mode.sign | Secure | Raises authority |
| Providers | provider.resume | Add | `provider_resume`, through liftAuthPause; instance access only, as the console |
| Providers | settings.provider-key-send, provider-key-clear-send | Secure | API keys |
| Providers | settings.connection-check | Secure for now | Asynchronous; the shared door is synchronous |
| Workers | queue.note | Add | `worker_note`, through setRunnerQueueNote |
| Workers | fleet.register, fleet.retire | Secure | Password acts that add or remove a computer |
| Projects | projects.open, select, github-list, onboard-preview, onboard-confirm, remove, settings.project-delete, map-refresh | Secure (map-refresh: Chat, refresh_code_map) | Adding reaches a new folder; removing destroys. project.select is per browser |
| Project settings | settings.project-concurrency | Secure | Raises how much runs and spends at once; console refuses non-browser callers. Unsure side, listed |
| Project settings | settings.project-live-view, network, writes, check-access, sandbox | Secure | Password acts that widen a fence |
| Flows | flows.create, gallery-create, example, import, flow.save, cards, card.*, scripts, triggers, trigger.pause, resume, remove, settings.flows-on, kit.* | Chat | flow_* actions, kit_setup, flow_starter |
| Flows | flow.archive | Add | `flow_archive`, through the console's own write |
| Flows | flow.unattended-off | Add | `flow_unattended_off`: lowers authority, as flow_browser_off |
| Flows | flow.browser-off | Chat | flow_browser_off |
| Flows | flow.trigger.check | Secure for now | Asynchronous; the shared door is synchronous |
| Flows | flow.trigger.press, dropped, share, unshare | Secure for now | Rare, not one of the priorities; listed |
| Flows, credentials | flow.linear-key, hooks-address, secrets, trigger.renew, secret, setup, scope, sender | Secure | Credentials and who may send |
| Knowledge | settings.knowledge-change, skills-*, code-map, code-map-holdout, knowledge-decision | Chat | skill_*, knowledge_*, decision_*, code_map_* |
| Knowledge | settings.knowledge-proposal, knowledge-note | Add | `knowledge_decide`, through decideProposal |
| Knowledge | settings.knowledge-refresh, knowledge-tidy | Secure for now | Asynchronous analysis; the shared door is synchronous |
| Learning | settings.learning-change | Secure | Some of its choices widen what agents load; unsure side, listed |
| Lead | settings.lead-about, lead-promise-cancel | Chat | lead_about_you, release_commitment |
| Lead | settings.lead-identity | Add | `lead_identity`, through checkLeadIdentity and setLeadConfig |
| Lead | settings.lead-on, chat.config, chat.mate-*, chat.send, file, ack-send, queued-remove, proposal.*, coordinator.proposal.* | Browser | The chat itself |
| Subagents | subagent.* | Chat | subagent_* |
| Tools | settings.tools-connect-send, tools-change-send, control.setup-*, instructions-* | Secure | Sign-ins, and what runs on this computer. tool_add stays a password act: unsure side, listed |
| Models | settings.models-not-now, models-stop | Chat | suggestion_not_now, trial_stop |
| Models | settings.models-agent, apply, accept, keep, suggest-on, try, suggest-off, turn-off, check, watch, update, act, control.models-refresh | Secure | Operator acts that choose what runs; the refreshes are asynchronous |
| Spend | spend.budget | Secure | Password act. Reads come back as the `spend` card, for instance operators only |
| People | people.* | Secure | Changes who can approve |
| Policy | settings.policy-send, approval-send, request-limits-send, release-approval-send, sign-in-send, passwordless-send, local-mode-off, sessions-send | Secure | Changes who can approve or how people sign in |
| Chat apps | settings.slack-*, teams-*, discord-*, telegram-*, chat-approval-*, messaging-send | Secure | Tokens and pairing. chat-approval-off stays here; it lowers, so it could move to chat later |
| Credentials | settings.telegram-token-send, email-send, google-send, google-disconnect-send, monitoring-send | Secure | Credentials |
| Integrations | settings.integrations-test-send, email-test-send, email-read-test-send, integrations-youiyoux | Secure | Tests are asynchronous; youiyoux turns outside text into tasks: unsure side, listed |
| Upkeep | settings.updates-*, retention, storage-*, backups-*, data, checks, pull-requests-*, ledger.checkpoint, updates-checks | Secure | Operator upkeep, mostly password acts |
| Defaults | settings.permission-default-send, quality-default-send, notifications-send, notifications-mute-send, telegram-digest-send, appearance-send | Secure for now | Permission defaults widen; the rest are preferences, not one of the priorities; listed |
| Browser only | session.*, push.*, agents.seen, agents.watch, projects.select, onboarding.phone-dismiss, lead.check, welcome.sample, chat.demo.*, settings.updates-dismiss, run.act.reveal, recipes.*, code.*, term.* | Browser | One browser's state, terminals and coding sessions, or the demo |
| Incidents | incident.resolve | Add | `incident_resolve`, through store.resolveIncident |

Reads the console shows and chat only linked to now come back as cards: `projects`, `builders`, `mode`, `integrations`, `providers`, `spend`.

## Follow-through in chat (docs/plans/fleet-follow-through.md)

- Reads: the `findings` and `handover` card sources (a new Notes part shows their words whole, marked as the agent's report), and `get_findings` for the lead.
- Sending: `finding_send` (a person's words, a review finding, or a failed check) and `finding_resend`, each through the shared door, every value on the card. Not approvals. Every project the task's family reaches must be in reach.
- Labelled link, not a chat act: closing a finding and starting a repair stay on the task (`show_control findings`), as do rerunning evidence, failing test first and marking captures. Automatic repair stays a signed mode only.

## Build order

1. Card format, catalog and sources; the `show_card` lead tool.
2. Web chat, Slack, Discord, Telegram; Teams gets the plain version with its link buttons.
3. Flow results as cards.
4. Approving from chat.
5. New actions.
6. `toolroll card <source>` in the CLI, and cards in the lead CLI.
