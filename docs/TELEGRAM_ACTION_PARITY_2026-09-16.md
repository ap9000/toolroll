# Telegram action parity

One row per mate tool in `MATE_TOOL_SCHEMAS`, sourced from
`CHAT_ACTION_PARITY` in [chat-channel.ts](../src/chat-channel.ts), re-exported
as `TELEGRAM_ACTION_PARITY` in [telegram-mate.ts](../src/telegram-mate.ts).
Telegram and Slack invoke the same tools through the shared assistant engine.
`src/telegram-mate.test.ts` refuses a tool this table does not name and
checks every row below against that constant column for column — support,
how, and remaining gap — so the code and this document cannot drift apart
silently. A `direct` row whose action still ends with a step on the
computer names that step in its remaining gap.

Meaning of the support column:

- **direct** — the same engine tool runs during a phone turn, or the same
  `confirmMateProposal` door runs from a card's Confirm button, recorded
  with `via: telegram` on the proposal outcome (and on the decision or stop
  it wrote). Web and CLI show the same rows afterwards.
- **handoff** — an incomplete phone action: the phone names the existing
  authenticated control and the task, and — when a trusted HTTPS console
  address is configured — carries ONE url button that opens that exact
  control in the signed-in console. The button is navigation only: it
  does nothing itself, grants nothing, and the control still runs in the
  console. Its remaining-gap column says so.
- **missing** — no phone path. None today; a new tool without a row fails
  the suite.

The Test column distinguishes shared implementation tests from scripted
transport journeys; catalogue coverage alone does not prove a channel journey.
This is not a live Telegram trial; that waits for the operator's bot
configuration and pairing. Slack transport tests also use scripted responses.

| Tool | Support | How the phone reaches it | Test | Remaining gap |
| --- | --- | --- | --- | --- |
| `get_brief` | direct | Reads current tasks, decisions, results and project knowledge from the local database through the shared engine, within the enrolled projects. | Shared scoped DB brief regression (`lead-follow.test.ts`); catalogue parity checks | Dedicated Telegram and Slack journeys for this tool and live channel rendering remain unverified. |
| `get_project_context` | direct | Reads bounded source excerpts or advisory import impact in an accessible enrolled project through the shared engine, with source-search fallback when its index is unavailable. | Source retrieval and fallback (`repository-context.test.ts`), MCP scope checks (`mcp.test.ts`); catalogue parity checks | Index refresh uses the local CLI. Dedicated Telegram and Slack journeys for this tool and live channel rendering remain unverified. |
| `get_action_status` | direct | Reads the exact saved shared action and its outcome, including completion through secure review. | Shared action lifecycle and secure-review regressions (`chat-actions.test.ts`) | none |
| `get_actions` | direct | Lists the shared action catalogue and required inputs. | Shared action lifecycle and secure-review regressions (`chat-actions.test.ts`) | none |
| `propose_action` | direct | Prepares exact shared skill, knowledge, approval, acceptance, cancel and resume actions (the separate review request was removed on 2026-09-21). Short ordinary changes confirm here; protected or long changes use one secure review and record the result on the same proposal. | Shared action lifecycle and secure-review regressions (`chat-actions.test.ts`) | Secure review requires a working HTTPS console connection. Real transport verification is required. |
| `recap` | direct | Read by the model during a phone turn over the enrolled ceiling. | journey turn (`telegram-lead.test.ts`, first test) reads through the engine | none |
| `list_repos` | direct | Read during a turn; projects are r1..rN in enrollment order, as on the console. | ceiling digest equality with the console/CLI (first test) | none |
| `get_skills` | direct | Reads the same project skill library, saved selections and enabled versions as the console. Use propose_action for changes and tests. | Project skills chat index, version read and project handoff regression (`project-skills.test.ts`) | Skill import and long content require secure review. Folder and GitHub import still use the project Skills screen. |
| `get_project_knowledge` | direct | Read during a turn. | engine read tools (`lead.test.ts`), same turn path | none |
| `get_models` | direct | Read during a turn: default agents with the exact model each runs, CLI versions and new models. Changes use the labelled Settings → Models page. | model catalog (`model-catalog.test.ts`), same turn path | none |
| `get_diff` | direct | Read during a turn: the exact result's changed files, then one file's diff, so a requested change names the right file and line. | result reading (`mate-results.test.ts`), same turn path | none |
| `get_check_log` | direct | Read during a turn: the end of the exact result's check log, a page of it, or the lines matching a search. | result reading (`mate-results.test.ts`), same turn path | none |
| `get_project_tools` | direct | Read during a turn: a project's tools, the common tools list and servers found on the computer. Adding one is a secure-review card; secrets are set only on the console's Tools page. | project tools (`project-tools.test.ts`), same turn path | none |
| `get_task_conversation` | direct | Read during a turn: what the person and the lead said in one task's own chat, including what was confirmed there. | task chat (`lead-doors.test.ts`), same turn path | none |
| `get_flows` | direct | Read during a turn: a person's flows, each one's steps in order and its cards — where each card is, what it waits on, whether it needs them, its owner and its discussion. | flows in chat (`flows-chat.test.ts`), same turn path | none |
| `get_subagents` | direct | Read during a turn: the project's subagents, their soul files, the zones they work, what they did today and the questions they're waiting on. | subagents (`subagents.test.ts`), same turn path | none |
| `propose_subagent` | direct | Asks a subagent to do something for you (the lead delegates; its answer comes back here), adds one from a template or a soul file, changes one section of its soul file (or the whole short file), pauses, resumes or removes it, passes it a note, or answers its question for the person asked, through the shared confirm door. | subagent actions through the shared door (`subagents.test.ts`); the app e2e adds one from chat | Soul files longer than one message are edited on the console's subagent page; the phone changes one section at a time. |
| `get_flow_insights` | direct | Read during a turn: where each flow's cards pass, fail or are sent back, how long they wait, how its scripts did, and a run's log. | flow insights (`flow-steps.test.ts`), same turn path | none |
| `propose_flow` | direct | Creates or changes a flow, adds, moves, approves, sends back or cancels its cards, comments on them (@name pings that person), sets their owner, follows them, saves the project's scripts, and adds, pauses or removes its triggers, through the shared confirm door; a long drawing opens the secure review. Work a card files is an ordinary task under the usual approvals. | flows in chat (`flows-chat.test.ts`): create, edit, card moves and decisions through the shared door, stale refusals; triggers from chat (`flow-triggers.test.ts`) | The flow canvas itself is on the console; the phone confirms cards but draws nothing. Webhook addresses and the Linear key are set on the console's Triggers panel. |
| `commit_to` | direct | Records what the lead promised to follow up on (a task, attempt, check or time; 7 days at most). The follow pass says one line when it is met, in the shared conversation and on the chat the promise was made on. | lead promises (`lead-commitments.test.ts`) | none |
| `release_commitment` | direct | Stops following up on one of the person's open promises, with the reason. | lead promises (`lead-commitments.test.ts`) | none |
| `remember` | direct | Proposes a correction or lasting preference as a decision, project instruction or about-you card, through the shared confirm door; an about-you card shows the line it replaces. | remember cards (`lead-commitments.test.ts`, `lead-people.test.ts`) | none |
| `get_person` | direct | Read during a turn: one person, subagent or team chat in full, with their open tasks. | get_person (`lead-people.test.ts`) | none |
| `get_integrations` | direct | Read during a turn: which chat apps, email, GitHub, project tools and monitoring are Connected, Not set up or Broken, as Settings → Integrations shows them. | integration status (`lead-checks.test.ts`), same turn path | none |
| `get_capabilities` | direct | Read during a turn: which agents are signed in, which workers are online, which tools and skills work, which integrations are connected and what checks the project runs, each with its next step and settings link. | capabilities and the check-first gate (`lead-capabilities.test.ts`), same turn path | none |
| `ask_owner` | direct | One question with 2-4 options and Something else, drawn as buttons under the reply; the tapped option is sent as the person's next message. | tap is the next message (`telegram-lead.test.ts`, `slack.test.ts`, `discord.test.ts`, `teams.test.ts`) | none |
| `search_project_memory` | direct | Read during a turn: one search over decisions, references, lessons and the conversations the person may read. | project memory search (`project-memory.test.ts`), same turn path | none |
| `list_tasks` | direct | Read during a turn. | engine read tools (`lead.test.ts`), same turn path | none |
| `get_task` | direct | Read during a turn; a reply to a result message pins the exact execution. | reply-to-result test | none |
| `get_agents` | direct | Read during a turn. | agents card test reads it before `propose_agents` | none |
| `list_decisions` | direct | Read during a turn. | engine read tools (`lead.test.ts`), same turn path | none |
| `get_decision` | direct | Read during a turn. | engine read tools (`lead.test.ts`), same turn path | none |
| `queue` | direct | Read during a turn. | engine read tools (`lead.test.ts`), same turn path | none |
| `get_acceptance_evidence` | direct | Shared read-only acceptance packet: exact result, criterion states, gate, reviewer findings, caveats and recorded human acceptance. Screenshot files use get_result_images; marking complete is a propose_action result_accept confirmed behind the phone's own yes/cancel challenge or on the signed-in console. | Acceptance packet transport regression | A physical-phone completion has not been exercised. |
| `get_result` | direct | Read during a turn; the phone card shows the verification verdict, never a local link. | reply-to-result test (`get_result` then `propose_review`) | Secure remote evidence links are not delivered to the phone; a result's screenshots travel through get_result_images. |
| `get_result_images` | direct | Read during a turn; every verified original PNG/JPEG the turn selected (at most 8 per reply, the rest by offset or image id) is sent as a document with a short safe caption after the reply, re-verified before each upload, and a reply to an image binds that exact task and run. | result-images tests (`telegram-lead.test.ts`): multipart documents with original bytes, restart resumes without a model call, tampered/revoked/refused images named not sent, reply to an image revises the exact run; adapter test in `telegram.test.ts` | An image whose record or bytes fail verification, or one Telegram refuses, is named in the chat rather than sent, through the same durable retried part; the operator opens the exact result in the console. Fixture proof only, no physical-phone rendering. |
| `get_controls` | direct | Read during a turn. | engine read tools (`lead.test.ts`), same turn path | none |
| `offer_approval` | direct | Pushes the plan's or flow card's own decision card to the owner's paired chat: Approve arms Yes and Cancel, and only the owner's Yes decides, through sealScopeApproval (as a chat-origin approval) or decideFlowCard. Outside the owner's chat-approval setting or a decision's rules it answers why, and the lead opens the console control. | chat-decide tests: the lead's offer pushes the plan card and its two taps approve it; telegram-cards flow approval two taps | A flow card's Send back, Edit and a Person chooses step act from the pushed card; a plan's Send back stays in the console. Fixture proof only, no physical-phone rendering. |
| `show_control` | handoff | The card names the control and the task, with one url button to that exact console control when a trusted https console-url is configured; the button opens the signed-in console and acts on nothing. | control card tests: url button to the exact control under a trusted origin, none without one, a forged tap changes nothing; production wiring (pass, follower, watch with `--public-url`) | Incomplete phone action: the control itself runs in the console, after sign-in. |
| `propose_task` | direct | Card with Confirm/Dismiss through confirmLeadProposal (filed as a lead proposal, via telegram). The confirmed card links Review & start for the filed task while its scope waits; under a signed automatic mode it says the scope is approved and links the task. | first test (unconfigured: one next action in words, no localhost); filed-task link test (Review & start, duplicate tap, `/task` before and after approval); automatic-approval journey (no second approval instruction) | Under manual approval the password step happens in the console, reached from the card's button. |
| `propose_scope` | direct | Confirm rewrites the scope through the shared door; the confirmed card links Review & start for the exact task. | scope card test (Review & start button, no second instruction) | Approving the rewritten scope needs the password, in the console. |
| `propose_next` | direct | Confirm through the shared door with the queue revision it saw. | queue card test | none |
| `propose_reserve` | direct | Confirm through the shared door. | queue card test | none |
| `propose_agents` | direct | Confirm through the shared route-edit door; when the change stales the approval, the confirmed card links Review & start for the exact task. | agents card test (route override written; staled approval said once, unlinked without an origin) | Renewed approval after the route change happens in the console. |
| `propose_hold` | direct | Confirm through the shared door. | hold/unhold card test | none |
| `propose_unhold` | direct | Confirm through the shared door. | hold/unhold card test | none |
| `propose_steer` | direct | Confirm through the shared door; the guidance is shown verbatim on the card. | steer card test | none |
| `propose_dependency_repair` | direct | Confirm retry/unlink/replace through the shared door with both projects re-checked. | repair card test (retry); unlink/replace share the door path proven in `lead-doors.test.ts` | none |
| `propose_task_action` | direct | stop, retry, plan, wait_for and stop_waiting confirm through the shared door (a stop is audited via telegram); resume confirms only the request, says nothing has resumed, and links the task where the password step lives. | task-action card test: retry, plan, wait_for, stop_waiting, stale refusal, stop (`run_stop.requested_via = telegram`); resume confirm says nothing resumed and links the task | resume completes in the console (incomplete phone action). |
| `propose_answer` | direct | Confirm answers through the shared door, audited via telegram; an irreversible option arms a second tap first. | answer card test: reversible, irreversible arm/cancel/yes, `answered_via = telegram` | none |
| `propose_review` | direct | note saves feedback; revise creates the same-family revision through the shared result service, honouring automatic approval settings; the confirmed card links Review & start for the revision while it waits, or the task once approved. | reply-to-result test (revise, manual approval: Review & start for the exact revision), automatic-approval journey test (revise under a signed mode: Open task), review note card test | Under manual approval the revision is approved in the console, reached from the card's button; under a signed automatic-approval mode it runs unattended. |
| `/team` (model-free) | direct | Lists the conversations the paired person can talk in; `/team <n>` selects one for a private chat or makes a group follow it (managers); `/team off` leaves. Messages then enter the shared team queue through the same `send` operation the browser uses, with the person's own membership and consent, and replies come back through a per-chat cursor. | group binding, private selection, consent refusal and reply delivery (`telegram-team.test.ts`) | Cards in a group ride the answered person's binding; any paired member may tap and the door proves their own rights. |
| `propose_cancel` | handoff | The door refuses cancel from any card; the card links the exact task's Cancel control when a trusted https console-url is configured, and the cancel is armed there. | cancel card test (Cancel task button under a trusted origin, none without one, a forged tap changes nothing) | Incomplete phone action: no phone path to cancel by design; the button only opens the task. |

## Shared actions (2026-09-17)

`propose_action` adds a shared proposal for skills, project knowledge, scope
approval, human acceptance, cancellation and resume. There is no review-request
action: a finished result is Ready, a person or the lead inspects it and marks it
complete or requests changes (2026-09-21). Short
ordinary changes confirm in the conversation. Protected, long or redacted changes link
to a complete, signed-in review of that exact proposal. Completion updates the
same saved proposal; `get_action_status` reads its actual outcome. Opening a
link is not confirmation. Existing legacy `propose_cancel` and `show_control`
remain navigation-only; the shared action is the complete new route.

Secure review still requires a working HTTPS console. A completed web action
does not automatically edit its old Telegram message; reopen its link or ask
for action status. Folder/GitHub skill sourcing, skill-test revisions and
committed-file knowledge sourcing still use their project screens. Publication,
deployment, installation settings and a new generic MCP manager are not added
by this change. Fixture checks do not prove live Slack, Discord or Teams support.

## Original phone handoff design (2026-09-16; historical)


- **In-chat action** — a `direct` row's Confirm button. The shared door
  acts inside the update's transaction, recorded `via: telegram`. The
  card's confirmed text follows the recorded state, not the door's
  wording: a scope approved under a signed automatic mode is said to be
  approved and is not asked for again; a scope still waiting has one
  next action; a confirmed resume says nothing has resumed yet.
- **Secure phone handoff** — a url button to the exact existing control or
  result (`chatControlHref`, `chatResultHref`: the recorded task, the
  recorded run, never the latest run by guess). Minted immediately before
  each send or edit from the console-url setting, held to an https origin
  with no credentials, path, query, fragment or loopback (IPv4, IPv6 and
  IPv4-mapped spellings), and — inside `up`, where this process co-hosts
  the console — equal to that console's `--public-url`, or no button. A
  url is never persisted, never a callback token, and never sent for a
  task outside the phone's current project ceiling. Opening it lands on
  the ordinary sign-in, which returns to that same-site path and nothing
  else; the GET acts on nothing. `/task` carries the same one button.
- **Remaining gaps** — an unconfigured or unmatched console address gives
  one honest line and no link (no localhost, no promise of parity).
  Passwords are never typed in chat; approval, resume, cancel,
  publication and settings still complete in the console. Screenshots and
  secure remote evidence links are not delivered to the phone. The actual
  bot stays unpaired and no physical phone, OS or reboot trial has run:
  every row here is fixture-proved against a scripted Bot API.

## Boundaries every row shares

- Pairing is proved before any model call: private chat, immutable sender,
  bot, binding row and generation, approver role, and the enrolled ceiling.
  The engine re-proves the channel before every provider dispatch, after
  every provider wait and before every tool runs, re-reading account,
  session, thread and turn state after each awaited lookup; the bridge
  re-proves it before every outgoing part.
- Ordinary text is persisted before the poll cursor moves. The session a
  turn will run in is bound to the row before the first dispatch, and the
  engine's request receipt is derived from bot, binding and update, so a
  replay or a restart — even after that session was ended and replaced
  from the console — recovers the original turn instead of dispatching
  again.
- The reply and every card are persisted as parts before any send
  (schema v63). A part is sent only when Telegram confirmed a message id;
  a lost, aborted or malformed acknowledgement from the real HTTP adapter
  is counted uncertain and retried; Telegram's retry_after
  pauses every send bot-wide, the outbox included; a restart resumes from
  the first unsent part with no model call. A row is done only when every
  part is sent or moot.
- A Telegram-minted session only exists when the approver has none; an
  incompatible console or CLI session is refused, never ended from the phone.
- Passwords are never asked for. Approval of a scope, resume, cancellation,
  publication and every settings control complete in the console; a url
  button only opens the signed-in control that owns them.
- A direct-API chat configuration is never spent from the phone.
